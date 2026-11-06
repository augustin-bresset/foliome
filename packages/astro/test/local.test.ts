import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { after, test } from 'node:test'
import { createLocal, type LocalOptions } from '../src/local.ts'

const SITE = 'the site itself'
const closing: (() => Promise<unknown>)[] = []
after(() => Promise.all(closing.map((close) => close())))

/** The editing server in front of a stand-in for the site, the way it sits in front of Astro's dev server. */
async function serve(options: Partial<LocalOptions> = {}) {
  const root = options.root ?? (await mkdtemp(path.join(os.tmpdir(), 'foliome-local-')))
  await writeFile(path.join(root, 'editor.js'), '/* editor */')
  const local = await createLocal({
    root,
    name: 'Atelier <Morane>',
    schema: { content: {} },
    allowedHosts: [],
    editorFile: path.join(root, 'editor.js'),
    onChange: () => {},
    ...options,
  })
  const server = http.createServer((req, res) => local.gate(req, res, () => local.middleware(req, res, () => res.end(SITE))))
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done))
  const { port } = server.address() as AddressInfo
  closing.push(async () => {
    server.closeAllConnections()
    await new Promise((done) => server.close(done))
    await rm(root, { recursive: true, force: true })
  })

  /** A request as it reaches the server: under the name and with the headers its sender chose. */
  const ask = (url: string, { method = 'GET', host = `localhost:${port}`, headers = {} as Record<string, string>, body = '' } = {}) =>
    new Promise<{ status: number; text: string; cookie: string; location: string }>((done, fail) => {
      const req = http.request({ port, host: '127.0.0.1', path: url, method, headers: { host, accept: 'text/html', ...headers } }, (res) => {
        let text = ''
        res.on('data', (chunk) => (text += chunk))
        res.on('end', () => done({ status: res.statusCode ?? 0, text, cookie: String(res.headers['set-cookie'] ?? ''), location: res.headers.location ?? '' }))
      })
      req.on('error', fail)
      req.end(body)
    })
  const signIn = (code: string, origin: string, host: string, headers = {}) =>
    ask('/_foliome/login', { method: 'POST', host, headers: { origin, 'content-type': 'application/json', ...headers }, body: JSON.stringify({ code }) })
  return { root, port, code: local.code, allows: local.allows, ask, signIn }
}

const session = (cookie: string) => ({ cookie: cookie.split(';')[0] ?? '' })

test('the developer’s own browser needs no code', async () => {
  const { ask } = await serve()
  assert.equal((await ask('/')).text, SITE)
  assert.equal((await ask('/_foliome/content')).status, 200)
})

test('anyone else gets the sign-in page, and nothing of the site or its source', async () => {
  const { ask, port } = await serve()
  const lan = `192.168.1.20:${port}`
  const page = await ask('/projets/halle', { host: lan })
  assert.equal(page.status, 401)
  assert.match(page.text, /data-foliome-signin/)
  assert.match(page.text, /<script src="\/_foliome\/editor\.js">/)
  assert.match(page.text, /<title>Atelier &#60;Morane&#62;<\/title>/)
  assert.doesNotMatch(page.text, new RegExp(SITE))

  for (const url of ['/src/pages/index.astro', '/@vite/client', '/@fs/etc/passwd', '/media/a/photo.jpg', '/astro.config.mjs?raw']) {
    const file = await ask(url, { host: lan, headers: { accept: '*/*' } })
    assert.equal(file.status, 401, url)
    assert.equal(file.text, 'unauthorized', url)
  }
  assert.equal((await ask('/_foliome/content', { host: lan })).status, 401)
  assert.equal((await ask('/_foliome/config', { host: lan })).status, 401)
  // What the sign-in page needs is open to all.
  assert.equal((await ask('/_foliome/editor.js', { host: lan })).text, '/* editor */')
  assert.deepEqual(JSON.parse((await ask('/_foliome/session', { host: lan })).text), { editor: false, code: true })
})

test('the code opens the site for thirty days', async () => {
  const { ask, signIn, code, port } = await serve()
  const lan = `192.168.1.20:${port}`
  assert.equal((await signIn('AAAABBBB', `http://${lan}`, lan)).status, 401)
  const signed = await signIn(`${code.slice(0, 4).toLowerCase()}-${code.slice(4)}`, `http://${lan}`, lan)
  assert.equal(signed.status, 200)
  assert.match(signed.cookie, /HttpOnly/)
  assert.match(signed.cookie, /Max-Age=2592000/)
  assert.doesNotMatch(signed.cookie, /Secure/)
  assert.equal((await ask('/projets/halle', { host: lan, headers: session(signed.cookie) })).text, SITE)
  assert.equal((await ask('/_foliome/content', { host: lan, headers: session(signed.cookie) })).status, 200)

  await ask('/_foliome/logout', { method: 'POST', host: lan, headers: { origin: `http://${lan}`, ...session(signed.cookie) }, body: '{}' })
  assert.equal((await ask('/', { host: lan, headers: session(signed.cookie) })).status, 401)
})

test('the folder that holds the code is served to nobody', async () => {
  const { ask, root, code } = await serve()
  assert.match(await readFile(path.join(root, '.foliome', 'local.json'), 'utf8'), new RegExp(code))
  const ways = [
    '/.foliome/local.json',
    '/.foliome/local.json?raw',
    '/.foliome/local.json?import',
    '/.Foliome/local.json',
    '/%2efoliome/local.json',
    '/.foliome%2flocal.json',
    `/@fs${root}/.foliome/local.json?import`,
    `/@id/${root}/.foliome/history/1.json`,
    '/.foliome',
  ]
  for (const url of ways) assert.equal((await ask(url)).status, 404, url)
  // A name that merely looks like it is the site's own business.
  assert.equal((await ask('/projets/.foliomes')).text, SITE)
})

test('with a tunnel nobody is trusted for being on this machine', async () => {
  const address = new URL('https://atelier.example.org')
  const { ask, signIn, code, port } = await serve({ address })
  // What comes through a tunnel arrives from this machine, and can call itself localhost.
  assert.equal((await ask('/')).status, 401)
  assert.equal((await ask('/_foliome/content')).status, 401)
  assert.equal((await ask('/', { host: 'atelier.example.org', headers: { 'x-forwarded-for': '203.0.113.7' } })).status, 401)

  const signed = await signIn(code, address.origin, 'atelier.example.org')
  assert.equal(signed.status, 200)
  assert.match(signed.cookie, /Secure/)
  assert.equal((await ask('/', { host: 'atelier.example.org', headers: session(signed.cookie) })).text, SITE)

  // A tunnel that renames the host to localhost still lets the artist sign in, and the developer too, over plain HTTP.
  assert.equal((await signIn(code, address.origin, `localhost:${port}`)).status, 200)
  const here = await signIn(code, `http://localhost:${port}`, `localhost:${port}`)
  assert.equal(here.status, 200)
  assert.doesNotMatch(here.cookie, /Secure/)
})

test('other sites cannot sign in or change anything from the visitor’s browser', async () => {
  const { ask, signIn, code, port } = await serve()
  assert.equal((await signIn(code, 'https://elsewhere.example', `localhost:${port}`)).status, 403)
  assert.equal((await ask('/_foliome/session', { host: 'elsewhere.example' })).status, 403)
})

test('wrong codes run out: for one visitor first, then for everybody', async () => {
  const address = new URL('https://atelier.example.org')
  const { signIn, code } = await serve({ address })
  const from = (ip: string) => ({ 'x-forwarded-for': ip })
  const guess = (ip: string) => signIn('AAAABBBB', address.origin, 'atelier.example.org', from(ip))

  for (let i = 0; i < 8; i++) assert.equal((await guess('203.0.113.7')).status, 401)
  assert.equal((await guess('203.0.113.7')).status, 429)
  // The artist, elsewhere, is not shut out by it.
  assert.equal((await signIn(code, address.origin, 'atelier.example.org', from('198.51.100.4'))).status, 200)

  // A visitor who changes name with every try is stopped by the count kept for all.
  let status = 0
  for (let i = 0; i < 192; i++) status = (await guess(`10.0.${i >> 8}.${i & 255}`)).status
  assert.equal(status, 401)
  assert.equal((await guess('10.9.9.9')).status, 429)
  // A newcomer waits, even with the right code. Someone who has signed in before does not.
  assert.equal((await signIn(code, address.origin, 'atelier.example.org', from('10.9.9.8'))).status, 429)
  assert.equal((await signIn(code, address.origin, 'atelier.example.org', from('198.51.100.4'))).status, 200)
})

test('tries held open and released together are counted one by one', async () => {
  const { port } = await serve()
  const lan = `192.168.1.20:${port}`
  const body = JSON.stringify({ code: 'AAAABBBB' })
  const held: http.ClientRequest[] = []
  const agent = new http.Agent({ keepAlive: false })
  const answers = Array.from(
    { length: 40 },
    () =>
      new Promise<number>((done, fail) => {
        const req = http.request(
          { port, host: '127.0.0.1', agent, path: '/_foliome/login', method: 'POST', headers: { host: lan, origin: `http://${lan}`, 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) } },
          (res) => {
            res.resume()
            res.on('end', () => done(res.statusCode ?? 0))
          },
        )
        req.on('error', fail)
        req.flushHeaders()
        held.push(req)
      }),
  )
  await new Promise((done) => setTimeout(done, 200))
  for (const req of held) req.end(body)
  const statuses = await Promise.all(answers)
  assert.equal(statuses.filter((status) => status === 401).length, 8)
  assert.equal(statuses.filter((status) => status === 429).length, 32)
})

test('a restart wipes neither the count of wrong codes nor the code', async () => {
  const first = await serve()
  const lan = `192.168.1.20:${first.port}`
  for (let i = 0; i < 8; i++) assert.equal((await first.signIn('AAAABBBB', `http://${lan}`, lan)).status, 401)

  const second = await serve({ root: first.root })
  const again = `192.168.1.20:${second.port}`
  assert.equal(second.code, first.code)
  assert.equal((await second.signIn(second.code, `http://${again}`, again)).status, 429)
  assert.doesNotMatch(await readFile(path.join(first.root, '.foliome', 'local.json'), 'utf8'), /127\.0\.0\.1/)
})

test('what comes before publishing is done before the command runs', async () => {
  let root = ''
  const { signIn, ask, code } = await (async () => {
    const site = await serve({
      publish: 'cat before.txt',
      beforePublish: () => writeFile(path.join(root, 'before.txt'), 'committed'),
    })
    root = site.root
    return site
  })()
  const origin = 'http://192.168.1.20:4321'
  const host = '192.168.1.20:4321'
  const { cookie } = await signIn(code, origin, host)
  const { text } = await ask('/_foliome/publish', { method: 'POST', host, headers: { origin, ...session(cookie) } })
  assert.deepEqual(JSON.parse(text), { ok: true, log: 'committed' })
})

const KEY = 'the-host-key'
const PUBLIC = 'atelier.example.org'
const fromHost = { origin: `https://${PUBLIC}`, 'content-type': 'application/json', 'x-foliome-host': KEY }
const json = (text: string) => JSON.parse(text) as Record<string, unknown>

/** A server run by a host, reached under its public name. */
async function hosted(options: Partial<LocalOptions> = {}) {
  const site = await serve({ address: new URL(`https://${PUBLIC}`), hostKey: KEY, ...options })
  const host = (what: string, body?: unknown, headers = fromHost) =>
    site.ask(`/_foliome/host${what}`, { method: body === undefined ? 'GET' : 'POST', host: PUBLIC, headers, body: body === undefined ? '' : JSON.stringify(body) })
  const grant = async (ms: number, home = 'https://foliome.example/#demo') => json((await host('/grant', { ms, home })).text).ticket as string
  const presence = async () => json((await host('')).text)
  const call = (url: string, cookie: string, body?: unknown) =>
    site.ask(url, {
      method: body === undefined ? 'GET' : 'POST',
      host: PUBLIC,
      headers: { origin: `https://${PUBLIC}`, 'content-type': 'application/json', ...session(cookie) },
      body: body === undefined ? '' : JSON.stringify(body),
    })
  return { ...site, host, grant, presence, call }
}

test('a ticket from the host opens one session, once, for the time granted, and closes every other', async () => {
  const site = await hosted()
  const before = await site.signIn(site.code, `https://${PUBLIC}`, PUBLIC)
  assert.equal(before.status, 200)

  const ticket = await site.grant(10 * 60_000)
  assert.equal((await site.call('/_foliome/content', before.cookie)).status, 401)

  const entered = await site.ask(`/projets/halle?lang=fr&ticket=${ticket}`, { host: PUBLIC })
  assert.equal(entered.status, 303)
  assert.equal(entered.location, '/projets/halle?lang=fr&edit')
  assert.match(entered.cookie, /HttpOnly/)
  assert.match(entered.cookie, /Secure/)
  const age = Number(/Max-Age=(\d+)/.exec(entered.cookie)?.[1])
  assert.ok(age > 590 && age <= 600, String(age))
  assert.equal((await site.call('/_foliome/content', entered.cookie)).status, 200)

  // Once only. Whoever already holds the session is let through; anyone else is told the ticket is spent.
  const again = await site.ask(`/?ticket=${ticket}`, { host: PUBLIC, headers: session(entered.cookie) })
  assert.equal(again.status, 303)
  const stranger = await site.ask(`/?ticket=${ticket}`, { host: PUBLIC })
  assert.equal(stranger.status, 401)
  assert.match(stranger.text, /data-foliome-signin="ticket"/)
  assert.equal((await site.ask('/?ticket=forged', { host: PUBLIC })).status, 401)
})

test('without the host’s key nobody asks, grants or says anything', async () => {
  const site = await hosted()
  const guess = { ...fromHost, 'x-foliome-host': 'guess' }
  assert.equal((await site.host('', undefined, guess)).status, 404)
  assert.equal((await site.host('/grant', { ms: 1000 }, guess)).status, 404)
  assert.equal((await site.host('/notice', { notice: { text: 'Hello' } }, guess)).status, 404)
  assert.equal((await site.host('/close', {}, guess)).status, 404)
  // Nor with the key from another page.
  assert.equal((await site.host('/notice', { notice: { text: 'Hello' } }, { ...fromHost, origin: 'https://elsewhere.example' })).status, 403)
  // A server with no key answers nobody.
  const alone = await serve({ address: new URL(`https://${PUBLIC}`) })
  assert.equal((await alone.ask('/_foliome/host', { host: PUBLIC, headers: fromHost })).status, 404)
})

test('a restricted site opens only by ticket, publishes nothing and stays out of search engines', async () => {
  const site = await hosted({ restricted: { mediaBudget: 1000 }, maxFileSize: 600, publish: 'echo published' })
  assert.equal((await site.signIn(site.code, `https://${PUBLIC}`, PUBLIC)).status, 403)
  const ticket = await site.grant(60_000)
  const page = await site.ask(`/?ticket=${ticket}`, { host: PUBLIC })
  const { cookie } = page
  assert.deepEqual(json((await site.call('/_foliome/session', cookie)).text), { editor: true, code: false, home: 'https://foliome.example/#demo' })
  assert.equal((await site.call('/_foliome/publish', cookie, {})).status, 404)
  const config = json((await site.call('/_foliome/config', cookie)).text)
  assert.equal(config.publish, false)
  assert.equal(config.restricted, true)
  assert.equal(config.maxFileSize, 600)

  // Uploads: each file has a limit, and the session a budget.
  const put = (size: number) =>
    site.ask('/_foliome/assets?name=plan.bin', { method: 'PUT', host: PUBLIC, headers: { origin: `https://${PUBLIC}`, 'content-type': 'application/octet-stream', ...session(cookie) }, body: 'x'.repeat(size) })
  const big = await put(700)
  assert.equal(big.status, 413)
  assert.equal(json(big.text).error, 'too_large')
  assert.equal((await put(500)).status, 200)
  assert.equal((await put(400)).status, 200)
  const over = await put(300)
  assert.equal(over.status, 413)
  assert.deepEqual(json(over.text), { error: 'budget', maxBytes: 1000 })
  // The next visitor starts with the whole budget.
  const next = await site.ask(`/?ticket=${await site.grant(60_000)}`, { host: PUBLIC })
  assert.equal(
    (await site.ask('/_foliome/assets?name=plan.bin', { method: 'PUT', host: PUBLIC, headers: { origin: `https://${PUBLIC}`, ...session(next.cookie) }, body: 'x'.repeat(500) })).status,
    200,
  )

  const signIn = await site.ask('/', { host: PUBLIC })
  assert.equal(signIn.status, 401)
  assert.match((await new Promise<string>((done) => http.get({ port: site.port, host: '127.0.0.1', path: '/', headers: { host: PUBLIC } }, (res) => done(String(res.headers['x-robots-tag']))))), /noindex/)
})

test('a file over the site’s limit is refused', async () => {
  const { ask, port } = await serve({ maxFileSize: 10 })
  const reply = await ask('/_foliome/assets?name=a.txt', { method: 'PUT', headers: { origin: `http://localhost:${port}`, 'content-type': 'text/plain' }, body: 'x'.repeat(11) })
  assert.equal(reply.status, 413)
  assert.deepEqual(json(reply.text), { error: 'too_large', maxBytes: 10 })
})

test('what a panel holds unsaved is kept as a draft until it is saved or let go', async () => {
  const site = await hosted()
  const { cookie } = await site.signIn(site.code, `https://${PUBLIC}`, PUBLIC)
  const beat = (body: unknown) => site.call('/_foliome/presence', cookie, body)
  const drafts = async () => json((await site.call('/_foliome/drafts', cookie)).text).drafts as Record<string, { value: unknown; at: number }>

  await beat({ dirty: true, active: true })
  assert.equal((await site.presence()).drafted, false)

  await beat({ dirty: true, active: false, drafts: [{ path: 'site.name', value: 'Atelier M.' }, { path: 'site.baseline', value: { $t: { fr: 'Bonjour' } } }] })
  assert.equal((await site.presence()).drafted, true)
  assert.deepEqual(Object.keys(await drafts()), ['site.name', 'site.baseline'])
  // Nothing that is not a field's path is kept.
  await beat({ dirty: true, drafts: [{ path: '../../etc', value: 1 }] })
  assert.equal((await site.presence()).drafted, false)
  assert.equal(Object.keys(await drafts()).length, 2)

  // Saving the field lets its draft go; so does giving it up.
  const saved = await site.call('/_foliome/ops', cookie, { ops: [{ op: 'set', path: 'site', value: { name: 'Atelier M.' } }] })
  assert.equal(saved.status, 200)
  assert.deepEqual(await drafts(), {})

  await beat({ dirty: true, drafts: [{ path: 'site.name', value: 'Autre' }] })
  await site.call('/_foliome/drafts', cookie, { drop: ['site.name'] })
  assert.deepEqual(await drafts(), {})

  // Written to disk, for the next time the server starts.
  await beat({ dirty: true, drafts: [{ path: 'site.name', value: 'Gardé' }] })
  await new Promise((done) => setTimeout(done, 1300))
  const disk = JSON.parse(await readFile(path.join(site.root, '.foliome', 'drafts.json'), 'utf8')) as Record<string, { value: unknown }>
  assert.equal(disk['site.name']?.value, 'Gardé')
})

test('the host sees who is editing, and what is under way', async () => {
  const site = await hosted()
  const tom = await site.signIn(site.code, `https://${PUBLIC}`, PUBLIC)
  const zoe = await site.signIn(site.code, `https://${PUBLIC}`, PUBLIC)
  assert.deepEqual((await site.presence()).sessions, [])
  await site.call('/_foliome/presence', tom.cookie, { dirty: true, active: true, drafts: [{ path: 'site.name', value: 'T.' }] })
  await site.call('/_foliome/presence', zoe.cookie, { dirty: false, active: false })
  const seen = await site.presence()
  assert.equal(seen.editors, 2)
  assert.equal(seen.dirty, true)
  assert.equal(seen.drafted, true)
  assert.equal(seen.uploads, 0)
  assert.equal(seen.publishing, false)
  const sessions = seen.sessions as { id: string; dirty: boolean; drafted: boolean; idle: number; seen: number }[]
  assert.equal(sessions.length, 2)
  assert.deepEqual(
    sessions.map(({ dirty, drafted }) => ({ dirty, drafted })),
    [
      { dirty: true, drafted: true },
      { dirty: false, drafted: true },
    ],
  )
  assert.match(sessions[0]!.id, /^[0-9a-f]{16}$/)
  assert.notEqual(sessions[0]!.id, sessions[1]!.id)

  // An upload under way.
  let release = () => {}
  const slow = new Promise<void>((done) => (release = done))
  const upload = new Promise<number>((done) => {
    const req = http.request(
      { port: site.port, host: '127.0.0.1', path: '/_foliome/assets?name=a.bin', method: 'PUT', headers: { host: PUBLIC, origin: `https://${PUBLIC}`, ...session(tom.cookie) } },
      (res) => {
        res.resume()
        res.on('end', () => done(res.statusCode ?? 0))
      },
    )
    req.write('x'.repeat(10))
    void slow.then(() => req.end())
  })
  await new Promise((done) => setTimeout(done, 100))
  const during = await site.presence()
  assert.equal(during.uploads, 1)
  assert.equal(during.busy, true)
  release()
  assert.equal(await upload, 200)
  await new Promise((done) => setTimeout(done, 50))
  assert.equal((await site.presence()).uploads, 0)
})

test('the host speaks to every editor, or to one, in its words, with a countdown and buttons', async () => {
  const site = await hosted()
  const tom = await site.signIn(site.code, `https://${PUBLIC}`, PUBLIC)
  const zoe = await site.signIn(site.code, `https://${PUBLIC}`, PUBLIC)
  const beat = async (cookie: string, active = false) => json((await site.call('/_foliome/presence', cookie, { dirty: false, active })).text)
  assert.deepEqual(await beat(tom.cookie), { notice: null, farewell: null })
  await beat(zoe.cookie)

  const notice = {
    text: { fr: 'Maintenance dans {countdown}.', en: 'Maintenance in {countdown}.' },
    level: 'warning',
    in: 600_000,
    actions: [{ label: 'OK', do: 'dismiss' }, { label: { fr: 'En savoir plus' }, href: 'https://status.example/' }],
  }
  assert.deepEqual(json((await site.host('/notice', { notice })).text), { ok: true })
  const told = (await beat(tom.cookie)).notice as { in: number; text: unknown; level: string; actions: unknown[] }
  assert.deepEqual(told.text, notice.text)
  assert.equal(told.level, 'warning')
  assert.ok(told.in > 590_000 && told.in <= 600_000)
  assert.deepEqual(told.actions, notice.actions)

  // To one session alone: the other still hears what was said to all.
  const tomId = ((await site.presence()).sessions as { id: string }[])[0]!.id
  await site.host('/notice', { to: tomId, notice: { text: 'Rien que pour vous' }, farewell: { text: 'Au revoir', final: true } })
  assert.deepEqual(await beat(tom.cookie), { notice: { text: 'Rien que pour vous' }, farewell: { text: 'Au revoir', final: true } })
  assert.deepEqual(((await beat(zoe.cookie)).notice as { text: unknown }).text, notice.text)
  // Words for all replace what one was told alone.
  await site.host('/notice', { notice: null })
  assert.deepEqual(await beat(tom.cookie), { notice: null, farewell: { text: 'Au revoir', final: true } })
  assert.equal((await site.host('/notice', { to: 'nobody', notice: null })).status, 404)

  // Gone as soon as the artist does anything, if the host says so.
  await site.host('/notice', { notice: { text: 'Toujours là ?', untilActive: true } })
  assert.deepEqual((await beat(zoe.cookie)).notice, { text: 'Toujours là ?', untilActive: true })
  assert.equal((await beat(zoe.cookie, true)).notice, null)

  // What is not a notice is refused, and nothing changes.
  for (const wrong of [{ text: 12 }, { text: 'x', level: 'loud' }, { text: 'x', in: -1 }, { text: 'x', actions: [{ label: 'x', href: 'javascript:alert(1)' }] }, 'hello']) {
    assert.equal((await site.host('/notice', { notice: wrong })).status, 400, JSON.stringify(wrong))
  }
})

test('the host closes a session: its editor hands over what it held unsaved, and is told why', async () => {
  const site = await hosted()
  const tom = await site.signIn(site.code, `https://${PUBLIC}`, PUBLIC)
  const zoe = await site.signIn(site.code, `https://${PUBLIC}`, PUBLIC)
  await site.call('/_foliome/presence', tom.cookie, { dirty: true, active: true })
  await site.call('/_foliome/presence', zoe.cookie, { dirty: false })
  const [tomId] = ((await site.presence()).sessions as { id: string }[]).map(({ id }) => id)

  const closed = json((await site.host('/close', { to: tomId, notice: { text: 'Session fermée', actions: [{ label: 'Rouvrir', do: 'reload' }] } })).text)
  // Its unsaved changes had not come as drafts yet: the host knows.
  assert.deepEqual(closed, { ok: true, closed: 1, drafted: false })
  assert.equal((await site.call('/_foliome/content', tom.cookie)).status, 401)
  assert.equal((await site.call('/_foliome/content', zoe.cookie)).status, 200)

  // Its editor calls in: what it holds is kept as drafts, and it hears that the session is over, once.
  const last = await site.call('/_foliome/presence', tom.cookie, { dirty: true, drafts: [{ path: 'site.name', value: 'Sauvé' }] })
  assert.deepEqual(json(last.text), { notice: { text: 'Session fermée', actions: [{ label: 'Rouvrir', do: 'reload' }], final: true }, farewell: null })
  assert.equal((await site.call('/_foliome/presence', tom.cookie, { dirty: true })).status, 401)
  const drafts = json((await site.call('/_foliome/drafts', zoe.cookie)).text).drafts as Record<string, { value: unknown }>
  assert.equal(drafts['site.name']?.value, 'Sauvé')

  // Every session at once.
  assert.deepEqual(json((await site.host('/close', {})).text), { ok: true, closed: 1, drafted: true })
  assert.equal((await site.call('/_foliome/content', zoe.cookie)).status, 401)
})

test('a ticket granted alongside opens one more session and closes none', async () => {
  const site = await hosted()
  const artist = await site.signIn(site.code, `https://${PUBLIC}`, PUBLIC)
  await site.call('/_foliome/presence', artist.cookie, { dirty: true, active: true })
  assert.equal((await site.host('/grant', { ms: 60_000, alongside: 'yes' })).status, 400)
  const ticket = json((await site.host('/grant', { ms: 60_000, alongside: true })).text).ticket as string
  const entered = await site.ask(`/?ticket=${ticket}`, { host: PUBLIC })
  assert.equal(entered.status, 303)
  assert.equal((await site.call('/_foliome/content', entered.cookie)).status, 200)
  assert.equal((await site.call('/_foliome/content', artist.cookie)).status, 200, 'the artist is still in')
  assert.equal((await site.presence()).editors, 1, 'and their editor still counted')
  // A plain grant still leaves the site to one alone.
  await site.grant(60_000)
  assert.equal((await site.call('/_foliome/content', artist.cookie)).status, 401)
  assert.equal((await site.call('/_foliome/content', entered.cookie)).status, 401)
})

test('the host gives the site a new code: the old one opens nothing, every session ends, the editors are told', async () => {
  const site = await hosted()
  const before = site.code
  const waiting = await site.grant(60_000)
  const tom = await site.signIn(before, `https://${PUBLIC}`, PUBLIC)
  await site.call('/_foliome/presence', tom.cookie, { dirty: false, active: true })
  const zoe = await site.signIn(before, `https://${PUBLIC}`, PUBLIC)

  // The key is needed, as for everything the host asks.
  assert.equal((await site.host('/code', {}, { ...fromHost, 'x-foliome-host': 'guess' })).status, 404)
  assert.equal((await site.host('/code', {}, { ...fromHost, origin: 'https://elsewhere.example' })).status, 403)
  assert.equal((await site.host('/code', { notice: { text: 12 } })).status, 400)
  assert.equal(JSON.parse(await readFile(path.join(site.root, '.foliome', 'local.json'), 'utf8')).code, before, 'nothing changed yet')

  const answer = json((await site.host('/code', {})).text)
  const code = answer.code as string
  assert.equal(answer.ok, true)
  assert.match(code, /^[ABCDEFGHJKMNPQRSTUVWXYZ23456789]{8}$/, 'the format of the first code')
  assert.notEqual(code, before)
  assert.equal(answer.closed, 2)
  // Written down where the code is kept, so that a restart keeps it.
  assert.equal(JSON.parse(await readFile(path.join(site.root, '.foliome', 'local.json'), 'utf8')).code, code)
  assert.deepEqual(JSON.parse(await readFile(path.join(site.root, '.foliome', 'local.json'), 'utf8')).sessions, {})

  // Every session is over, and a ticket handed out before opens nothing.
  assert.equal((await site.call('/_foliome/content', tom.cookie)).status, 401)
  assert.equal((await site.call('/_foliome/content', zoe.cookie)).status, 401)
  assert.equal((await site.ask(`/?ticket=${waiting}`, { host: PUBLIC })).status, 401)
  // The open editor hears why, once.
  const told = json((await site.call('/_foliome/presence', tom.cookie, { dirty: false })).text)
  assert.match(String((told.notice as { text: { fr: string } }).text.fr), /code d’accès de ce site vient de changer/)
  assert.equal((told.notice as { final?: boolean }).final, true)

  // The old code opens nothing; the new one does.
  assert.equal((await site.signIn(before, `https://${PUBLIC}`, PUBLIC)).status, 401)
  assert.equal((await site.signIn(code, `https://${PUBLIC}`, PUBLIC)).status, 200)
})

test('a new code is refused on a site lent to strangers, and while something is under way', async () => {
  const lent = await hosted({ restricted: {} })
  assert.equal((await lent.host('/code', {})).status, 409)
  const site = await hosted({ publish: 'sleep 1' })
  const { cookie } = await site.signIn(site.code, `https://${PUBLIC}`, PUBLIC)
  const publishing = site.call('/_foliome/publish', cookie, {})
  await new Promise((done) => setTimeout(done, 200))
  const refused = await site.host('/code', {})
  assert.equal(refused.status, 409)
  assert.equal(json(refused.text).error, 'publishing')
  await publishing
  assert.equal((await site.host('/code', {})).status, 200)
})
