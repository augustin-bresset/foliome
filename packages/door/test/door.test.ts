import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { after, test } from 'node:test'
import { createLocal } from '../../astro/src/local.ts'
import { type Control, decide, door, LIMITS, type Limits } from '../src/door.ts'

const HOME = 'https://foliome.example'
const KEY = 'the-key-the-door-shares-with-the-sites'
const closing: (() => Promise<unknown>)[] = []
after(() => Promise.all(closing.map((close) => close())))

const listen = async (server: http.Server, port = 0) => {
  await new Promise<void>((done) => server.listen(port, '127.0.0.1', done))
  return (server.address() as AddressInfo).port
}
const shut = async (server: http.Server) => {
  server.closeAllConnections()
  await new Promise((done) => server.close(done))
}

/** A site's real editing server, reached under its public name, which the test can start and stop like systemd. */
async function site(name: string) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'foliome-door-'))
  await writeFile(path.join(root, 'editor.js'), '')
  let server: http.Server | null = null
  let port = 0
  let code = ''
  const start = async () => {
    const local = await createLocal({
      root,
      name,
      schema: { content: {} },
      allowedHosts: [],
      address: new URL(`https://${name}`),
      editorFile: path.join(root, 'editor.js'),
      onChange: () => {},
      doorKey: KEY,
    })
    code = local.code
    server = http.createServer((req, res) => local.gate(req, res, () => local.middleware(req, res, () => res.end('site'))))
    port = await listen(server, port)
  }
  const stop = async () => {
    if (server) await shut(server)
    server = null
  }
  // Run once, as on the server: that is when the site's code is made.
  await start()
  await stop()
  closing.push(async () => {
    await stop()
    await rm(root, { recursive: true, force: true })
  })

  /** A request from the artist's browser, through the site's public name. */
  const ask = (url: string, { method = 'GET', cookie = '', body }: { method?: string; cookie?: string; body?: unknown } = {}) =>
    fetch(`http://127.0.0.1:${port}${url}`, {
      method,
      headers: { host: name, origin: `https://${name}`, 'content-type': 'application/json', cookie, 'x-forwarded-for': '203.0.113.9' },
      body: body === undefined ? undefined : JSON.stringify(body),
    })
  /** An artist with the editor open: signed in, and giving signs of life. */
  const artist = async () => {
    const cookie = (await ask('/_foliome/login', { method: 'POST', body: { code } })).headers.get('set-cookie')?.split(';')[0] ?? ''
    return {
      beat: async (state: { dirty?: boolean; active?: boolean } = {}) =>
        ((await (await ask('/_foliome/presence', { method: 'POST', cookie, body: { dirty: false, active: false, ...state } })).json()) as { notice: unknown }).notice,
    }
  }
  return {
    site: { name, port, root, unit: `foliome-site@${name}.service` },
    code,
    start,
    stop,
    awake: () => !!server,
    artist,
    ask,
  }
}

type TestSite = Awaited<ReturnType<typeof site>>

/** systemd, as the door sees it, and what it was asked to do. */
function systemd(sites: TestSite[], { wakes = true } = {}) {
  const asked: string[] = []
  const of = (unit: string) => sites.find((one) => one.site.unit === unit)!
  const control: Control = {
    awake: async (unit) => of(unit).awake(),
    async start(unit) {
      asked.push(`start ${of(unit).site.name}`)
      if (wakes) await of(unit).start()
    },
    async stop(unit) {
      asked.push(`stop ${of(unit).site.name}`)
      await of(unit).stop()
    },
  }
  return { asked, control }
}

async function entrance(sites: TestSite[], limits: Partial<Limits> = {}, options: { wakes?: boolean } = {}) {
  const { asked, control } = systemd(sites, options)
  const { handle, watch } = door({ home: HOME, sites: sites.map((one) => one.site), key: KEY, control, limits })
  const server = http.createServer(handle)
  const port = await listen(server)
  closing.push(() => shut(server))
  const enter = (body: unknown, { visitor = '203.0.113.7', origin = HOME, method = 'POST', url = '/entrer' } = {}) =>
    fetch(`http://127.0.0.1:${port}${url}`, {
      method,
      headers: { origin, 'content-type': 'application/json', 'x-forwarded-for': visitor },
      body: method === 'POST' ? (typeof body === 'string' ? body : JSON.stringify(body)) : undefined,
    })
  return { enter, watch, asked }
}

test('a code wakes the site it opens, and that one only', async () => {
  const [tom, ulysse] = await Promise.all([site('tom.example'), site('ulysse.example')])
  const { enter, asked } = await entrance([tom, ulysse])

  const reply = await enter({ code: tom.code.toLowerCase().replace(/^(....)/, '$1-') })
  assert.equal(reply.status, 200)
  assert.deepEqual(await reply.json(), { url: `https://tom.example/?edit=${tom.code}` })
  assert.deepEqual(asked, ['start tom.example'])
  assert.equal(tom.awake(), true)
  assert.equal(ulysse.awake(), false)

  // Already awake: nothing more to start.
  assert.equal((await enter({ code: tom.code })).status, 200)
  assert.deepEqual(asked, ['start tom.example'])
})

test('a wrong code wakes nothing, and tries run out', async () => {
  const [tom, ulysse] = await Promise.all([site('tom.example'), site('ulysse.example')])
  const { enter, asked } = await entrance([tom, ulysse])
  for (let i = 0; i < 8; i++) assert.equal((await enter({ code: 'AAAABBBB' })).status, 401)
  assert.deepEqual(asked, [])
  assert.equal((await enter({ code: 'AAAABBBB' })).status, 429)
  assert.equal((await enter({ code: tom.code })).status, 429)
  // The artist, elsewhere, is not shut out by it.
  assert.equal((await enter({ code: tom.code }, { visitor: '198.51.100.4' })).status, 200)
})

test('at the limit, a site nobody uses goes to sleep to make room; one in use never does', async () => {
  const [tom, ulysse] = await Promise.all([site('tom.example'), site('ulysse.example')])
  const { enter, asked } = await entrance([tom, ulysse], { awake: 1 })

  await tom.start()
  assert.equal((await enter({ code: ulysse.code })).status, 200)
  assert.deepEqual(asked, ['stop tom.example', 'start ulysse.example'])

  // Ulysse is editing: Tom has to wait, rather than the machine run out of memory.
  await (await ulysse.artist()).beat()
  const busy = await enter({ code: tom.code })
  assert.equal(busy.status, 503)
  assert.deepEqual(await busy.json(), { error: 'busy' })
  assert.equal(ulysse.awake(), true)
  assert.equal(tom.awake(), false)
})

test('a site that does not wake in time is said to be unreachable', async () => {
  const tom = await site('tom.example')
  const { enter } = await entrance([tom], { waking: 300 }, { wakes: false })
  const reply = await enter({ code: tom.code })
  assert.equal(reply.status, 503)
  assert.deepEqual(await reply.json(), { error: 'unreachable' })
})

test('the artist is warned before the session closes, and doing anything puts it off', async () => {
  const tom = await site('tom.example')
  await tom.start()
  const artist = await tom.artist()
  await artist.beat()

  await (await entrance([tom], { warn: 0, close: 3_600_000 })).watch()
  const warned = (await artist.beat()) as { kind: string; in: number; unsaved: boolean }
  assert.equal(warned.kind, 'closing')
  assert.equal(warned.unsaved, false)
  assert.ok(warned.in > 3_500_000 && warned.in <= 3_600_000)

  // "Keep editing"
  assert.equal(await artist.beat({ active: true }), null)

  await (await entrance([tom], { warn: 0, close: 0 })).watch()
  assert.equal(tom.awake(), false)
})

test('unsaved changes keep the session open longer, and the warning says so', async () => {
  const tom = await site('tom.example')
  await tom.start()
  const artist = await tom.artist()
  await artist.beat({ dirty: true })

  await (await entrance([tom], { warn: 0, close: 0, closeUnsaved: 3_600_000 })).watch()
  assert.equal(tom.awake(), true)
  assert.equal(((await artist.beat({ dirty: true })) as { unsaved: boolean }).unsaved, true)

  await (await entrance([tom], { warn: 0, close: 0, closeUnsaved: 0 })).watch()
  assert.equal(tom.awake(), false)
})

test('with no editor open, nobody is there to warn: the session closes sooner', async () => {
  const tom = await site('tom.example')
  await tom.start()
  await (await entrance([tom], { alone: 0 })).watch()
  assert.equal(tom.awake(), false)
})

test('a site just woken is given time to see its artist arrive', async () => {
  const tom = await site('tom.example')
  const { enter, watch } = await entrance([tom], { alone: 60_000 })
  assert.equal((await enter({ code: tom.code })).status, 200)
  await watch()
  assert.equal(tom.awake(), true)
})

test('what the door asks the sites is for the door alone', async () => {
  const tom = await site('tom.example')
  await tom.start()
  assert.equal((await tom.ask('/_foliome/door')).status, 404)
  const artist = await tom.artist()
  await artist.beat()
  const notice = await tom.ask('/_foliome/door', { method: 'POST', body: { notice: { kind: 'closed' } } })
  assert.equal(notice.status, 404)
  assert.equal(await artist.beat(), null)
})

test('only the home page may ask, and only for this', async () => {
  const tom = await site('tom.example')
  const { enter } = await entrance([tom])
  assert.equal((await enter({ code: tom.code }, { origin: 'https://elsewhere.example' })).status, 403)
  assert.equal((await enter({ code: tom.code }, { url: '/autre' })).status, 404)
  assert.equal((await enter(null, { method: 'GET' })).status, 404)
  assert.equal((await enter('not json')).status, 400)
  assert.equal((await enter({ code: 12 })).status, 400)
  assert.equal((await enter({ code: 'A'.repeat(4096) })).status, 413)
})

test('what becomes of a session, by how it is used', () => {
  const at = (idle: number, more: Partial<Parameters<typeof decide>[0]> = {}) => decide({ idle, dirty: false, editors: 1, busy: false, ...more }, LIMITS)
  const minutes = (n: number) => n * 60_000
  assert.deepEqual(at(minutes(5)), { act: 'keep' })
  assert.deepEqual(at(minutes(26)), { act: 'warn', in: minutes(4), unsaved: false })
  assert.deepEqual(at(minutes(30)), { act: 'close' })
  assert.deepEqual(at(minutes(30), { dirty: true }), { act: 'warn', in: minutes(30), unsaved: true })
  assert.deepEqual(at(minutes(60), { dirty: true }), { act: 'close' })
  assert.deepEqual(at(minutes(11), { editors: 0 }), { act: 'close' })
  assert.deepEqual(at(minutes(11), { editors: 0, dirty: true }), { act: 'keep' })
  // An upload or a publish under way is never cut.
  assert.deepEqual(at(minutes(90), { busy: true }), { act: 'keep' })
})
