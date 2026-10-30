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
  const root = await mkdtemp(path.join(os.tmpdir(), 'foliome-local-'))
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
    new Promise<{ status: number; text: string; cookie: string }>((done, fail) => {
      const req = http.request({ port, host: '127.0.0.1', path: url, method, headers: { host, accept: 'text/html', ...headers } }, (res) => {
        let text = ''
        res.on('data', (chunk) => (text += chunk))
        res.on('end', () => done({ status: res.statusCode ?? 0, text, cookie: String(res.headers['set-cookie'] ?? '') }))
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
  assert.deepEqual(JSON.parse((await ask('/_foliome/session', { host: lan })).text), { editor: false })
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
  assert.equal((await signIn(code, address.origin, 'atelier.example.org', from('198.51.100.4'))).status, 429)
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
