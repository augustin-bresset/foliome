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

test('anyone else gets the door, and nothing of the site or its source', async () => {
  const { ask, port } = await serve()
  const lan = `192.168.1.20:${port}`
  const page = await ask('/projets/halle', { host: lan })
  assert.equal(page.status, 401)
  assert.match(page.text, /data-foliome-door/)
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
  // What the door needs is open to all.
  assert.equal((await ask('/_foliome/editor.js', { host: lan })).text, '/* editor */')
  assert.deepEqual(JSON.parse((await ask('/_foliome/session', { host: lan })).text), { editor: false, code: true })
})

test('the code opens the door for thirty days', async () => {
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

const KEY = 'the-door-key'
const PUBLIC = 'atelier.example.org'
const fromDoor = { origin: `https://${PUBLIC}`, 'content-type': 'application/json', 'x-foliome-door': KEY }
const json = (text: string) => JSON.parse(text) as Record<string, unknown>

/** A server behind a door, reached under its public name. */
async function behindDoor(options: Partial<LocalOptions> = {}) {
  const site = await serve({ address: new URL(`https://${PUBLIC}`), doorKey: KEY, ...options })
  const grant = async (ms: number, home = 'https://foliome.example/#demo') =>
    json((await site.ask('/_foliome/door', { method: 'POST', host: PUBLIC, headers: fromDoor, body: JSON.stringify({ grant: { ms, home } }) })).text).ticket as string
  const presence = async () => json((await site.ask('/_foliome/door', { host: PUBLIC, headers: fromDoor })).text)
  const call = (url: string, cookie: string, body?: unknown) =>
    site.ask(url, {
      method: body === undefined ? 'GET' : 'POST',
      host: PUBLIC,
      headers: { origin: `https://${PUBLIC}`, 'content-type': 'application/json', ...session(cookie) },
      body: body === undefined ? '' : JSON.stringify(body),
    })
  return { ...site, grant, presence, call }
}

test('a ticket from the door opens one session, once, for the time granted, and closes every other', async () => {
  const site = await behindDoor()
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
  assert.match(stranger.text, /data-foliome-door="ticket"/)
  assert.equal((await site.ask('/?ticket=forged', { host: PUBLIC })).status, 401)
})

test('without the door’s key nobody grants anything', async () => {
  const site = await behindDoor()
  const reply = await site.ask('/_foliome/door', { method: 'POST', host: PUBLIC, headers: { ...fromDoor, 'x-foliome-door': 'guess' }, body: JSON.stringify({ grant: { ms: 1000 } }) })
  assert.equal(reply.status, 404)
})

test('a restricted site opens only by ticket, publishes nothing and stays out of search engines', async () => {
  const site = await behindDoor({ restricted: { mediaBudget: 1000 }, maxFileSize: 600, publish: 'echo published' })
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

  const door = await site.ask('/', { host: PUBLIC })
  assert.equal(door.status, 401)
  assert.match((await new Promise<string>((done) => http.get({ port: site.port, host: '127.0.0.1', path: '/', headers: { host: PUBLIC } }, (res) => done(String(res.headers['x-robots-tag']))))), /noindex/)
})

test('a file over the site’s limit is refused', async () => {
  const { ask, port } = await serve({ maxFileSize: 10 })
  const reply = await ask('/_foliome/assets?name=a.txt', { method: 'PUT', headers: { origin: `http://localhost:${port}`, 'content-type': 'text/plain' }, body: 'x'.repeat(11) })
  assert.equal(reply.status, 413)
  assert.deepEqual(json(reply.text), { error: 'too_large', maxBytes: 10 })
})

test('what a panel holds unsaved is kept as a draft until it is saved or let go', async () => {
  const site = await behindDoor()
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
