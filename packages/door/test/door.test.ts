import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { after, test } from 'node:test'
import { createLocal } from '../../astro/src/local.ts'
import { type Control, createLine, decide, door, evict, LIMITS, type Limits, type Presence, type Site } from '../src/door.ts'

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
async function site(name: string, { demo = false } = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'foliome-door-'))
  await writeFile(path.join(root, 'editor.js'), '')
  let server: http.Server | null = null
  let close: () => Promise<unknown> = async () => {}
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
      restricted: demo ? {} : undefined,
    })
    code = local.code
    close = local.close
    server = http.createServer((req, res) => local.gate(req, res, () => local.middleware(req, res, () => res.end('site'))))
    port = await listen(server, port)
  }
  // As when systemd stops it: what has to be written down is.
  const stop = async () => {
    if (server) await Promise.all([shut(server), close()])
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
  const artist = async (signed?: string) => {
    const cookie = signed ?? (await ask('/_foliome/login', { method: 'POST', body: { code } })).headers.get('set-cookie')?.split(';')[0] ?? ''
    return {
      cookie,
      beat: async (state: { dirty?: boolean; active?: boolean; drafts?: { path: string; value: unknown }[] } = {}) => {
        const reply = await ask('/_foliome/presence', { method: 'POST', cookie, body: { dirty: false, active: false, ...state } })
        return reply.ok ? ((await reply.json()) as { notice: unknown }).notice : reply.status
      },
    }
  }
  /** A visitor sent by the door: the ticket in the address is exchanged for a session. */
  const arrive = async (url: string) => {
    const reply = await fetch(`http://127.0.0.1:${port}${new URL(url).pathname}${new URL(url).search}`, { headers: { host: name, accept: 'text/html' }, redirect: 'manual' })
    return { status: reply.status, cookie: reply.headers.get('set-cookie')?.split(';')[0] ?? '', text: await reply.text() }
  }
  return {
    site: { name, port, root, unit: `foliome-site@${name}.service`, demo } as Site,
    arrive,
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
  const { handle, watch, turns } = door({ home: HOME, sites: sites.map((one) => one.site), key: KEY, control, limits })
  const server = http.createServer(handle)
  const port = await listen(server)
  closing.push(() => shut(server))
  const enter = (body: unknown, { visitor = '203.0.113.7', origin = HOME, method = 'POST', url = '/entrer' } = {}) =>
    fetch(`http://127.0.0.1:${port}${url}`, {
      method,
      headers: { origin, 'content-type': 'application/json', 'x-forwarded-for': visitor },
      body: method === 'POST' ? (typeof body === 'string' ? body : JSON.stringify(body)) : undefined,
    })
  /** A visitor's page in the demo's line. */
  const line = async (body: object = {}, visitor = '203.0.113.7') => {
    const reply = await enter(body, { visitor, url: '/entrer/demo' })
    return { status: reply.status, ...((await reply.json()) as { ticket?: string; place?: number; wait?: number; url?: string; error?: string }) }
  }
  return { enter, watch, turns, line, asked }
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

const minutes = (n: number) => n * 60_000
const used = (idle: number, more: Partial<Presence> = {}): Presence => ({ idle, dirty: false, editors: 1, busy: false, drafted: true, ...more })
const named = (name: string) => ({ name, port: 0, root: '', unit: name })

test('to make room: first a site nobody has open, then an editor left alone, the longest idle first', () => {
  const [a, b, c, d] = ['a', 'b', 'c', 'd'].map(named) as [Site, Site, Site, Site]
  const pick = (running: [Site, Presence | null][]) => evict(running.map(([site, presence]) => ({ site, presence })), LIMITS)
  assert.deepEqual(pick([[a, used(minutes(40))], [b, used(minutes(2), { editors: 0 })]]), { site: b, afk: false })
  assert.deepEqual(pick([[a, used(minutes(12))], [b, used(minutes(30))], [c, used(minutes(5))]]), { site: b, afk: true })
  assert.equal(pick([[a, used(minutes(9))], [b, null]]), null)
  // Busy is never closed, however long it has been; unsaved work only once the server holds it as drafts.
  assert.equal(pick([[a, used(minutes(50), { busy: true })], [b, used(minutes(50), { busy: true, editors: 0 })]]), null)
  assert.equal(pick([[a, used(minutes(50), { dirty: true, drafted: false })]]), null)
  assert.deepEqual(pick([[a, used(minutes(50), { dirty: true, drafted: false })], [d, used(minutes(11), { dirty: true })]]), { site: d, afk: true })
})

test('the line keeps the order people came in, and lets go of pages that stopped asking', () => {
  let now = 0
  const line = createLine({ linger: 30_000, line: 4, places: 2 }, () => now)
  const first = line.join('203.0.113.1') as { ticket: string }
  const second = line.join('203.0.113.2') as { ticket: string }
  assert.equal(line.join('203.0.113.2') !== 'too_many', true)
  assert.equal(line.join('203.0.113.2'), 'too_many')
  assert.notEqual(line.join('203.0.113.3'), 'full')
  assert.equal(line.join('203.0.113.4'), 'full')
  assert.equal(line.keep(second.ticket), 2)

  // Only the second keeps asking.
  now = 20_000
  line.keep(second.ticket)
  now = 40_000
  assert.equal(line.keep(first.ticket), 0)
  assert.equal(line.keep(second.ticket), 1)
  assert.equal(line.next()?.ticket, second.ticket)
  line.leave('anything')
})

test('the demo: one visitor at a time, the others wait their turn, and nobody needs a code', async () => {
  const morane = await site('demo.example', { demo: true })
  const { line, turns, enter, asked } = await entrance([morane], { demo: 1500, demoWarn: 1000, arrive: 60_000 })

  const first = await line()
  assert.equal(first.status, 200)
  assert.equal(first.place, 0)
  const second = await line({}, '198.51.100.4')
  assert.equal(second.place, 1)
  assert.ok(second.wait! > 0 && second.wait! <= 10 * 60_000)

  // Its turn has come: the demo was started for it.
  await turns()
  const go = await line({ ticket: first.ticket })
  assert.match(go.url!, /^https:\/\/demo\.example\/\?ticket=/)
  assert.deepEqual(asked, ['start demo.example'])
  assert.equal((await line({ ticket: second.ticket })).place, 1)

  // The ticket opens the site once, for the turn alone.
  const entered = await morane.arrive(go.url!)
  assert.equal(entered.status, 303)
  const visitor = await morane.artist(entered.cookie)
  assert.equal(await visitor.beat(), null)
  assert.match((await morane.arrive(go.url!)).text, /data-foliome-door="ticket"/)
  // The demo's own code opens nothing, here or at the door.
  assert.equal((await morane.ask('/_foliome/login', { method: 'POST', body: { code: morane.code } })).status, 403)
  assert.equal((await enter({ code: morane.code })).status, 401)

  // Near the end the visitor is told how long is left; at the end the session closes, and the next one goes.
  await new Promise((done) => setTimeout(done, 600))
  await turns()
  const told = (await visitor.beat()) as { kind: string; reason: string; in: number }
  assert.equal(told.kind, 'closing')
  assert.equal(told.reason, 'time')
  assert.ok(told.in <= 1000)
  await new Promise((done) => setTimeout(done, 1000))
  await line({ ticket: second.ticket })
  await turns()
  assert.deepEqual(asked, ['start demo.example', 'stop demo.example', 'start demo.example'])
  assert.equal(await visitor.beat(), 401)
  assert.match((await line({ ticket: second.ticket })).url!, /ticket=/)
  assert.deepEqual(await line({ ticket: first.ticket }), { status: 404, error: 'gone' })
})

test('a demo visitor who never arrives, or leaves, lets the next one in early', async () => {
  const morane = await site('demo.example', { demo: true })
  const { line, turns, asked } = await entrance([morane], { arrive: 200 })
  const first = await line()
  const second = await line({}, '198.51.100.4')
  await turns()
  assert.ok((await line({ ticket: first.ticket })).url)
  // Never opened: the turn goes to the next.
  await new Promise((done) => setTimeout(done, 300))
  await line({ ticket: second.ticket })
  await turns()
  await turns()
  assert.ok((await line({ ticket: second.ticket })).url)
  assert.deepEqual(asked, ['start demo.example', 'stop demo.example', 'start demo.example'])
})

test('a page that stops asking loses its place, and the line has its bounds', async () => {
  const morane = await site('demo.example', { demo: true })
  const { line } = await entrance([morane], { linger: 200, line: 3, places: 1 }, { wakes: false })
  // The first is having its turn opened (the demo never wakes here); the others wait.
  await line({}, '192.0.2.1')
  const waiting = await line({}, '192.0.2.2')
  assert.equal((await line({}, '192.0.2.2')).status, 429)
  await line({}, '192.0.2.3')
  await line({}, '192.0.2.4')
  assert.deepEqual(await line({}, '192.0.2.5'), { status: 503, error: 'full' })
  await new Promise((done) => setTimeout(done, 300))
  assert.deepEqual(await line({ ticket: waiting.ticket }), { status: 404, error: 'gone' })
  assert.equal((await line({ ticket: 12 } as object)).status, 400)
})

test('the demo has a slot of its own: it neither takes the artists’ place nor gives up its own', async () => {
  const [tom, ulysse, morane] = await Promise.all([site('tom.example'), site('ulysse.example'), site('demo.example', { demo: true })])
  const { enter, line, turns, watch, asked } = await entrance([tom, ulysse, morane], { awake: 1, alone: 0 })
  await turns()
  const visitor = await line()
  await turns()
  assert.ok((await line({ ticket: visitor.ticket })).url)

  // One artist's site and the demo, together.
  assert.equal((await enter({ code: tom.code })).status, 200)
  await (await tom.artist()).beat()
  assert.equal(morane.awake(), true)
  // The second artist waits for the first, not for the demo, which nobody closes for them, nor for being idle.
  assert.equal((await enter({ code: ulysse.code })).status, 503)
  await watch()
  assert.equal(morane.awake(), true)
  assert.deepEqual(asked, ['start demo.example', 'start tom.example'])
})

test('an editor left alone gives way to an artist who arrives, and is told why', async () => {
  const [tom, ulysse] = await Promise.all([site('tom.example'), site('ulysse.example')])
  await tom.start()
  const artist = await tom.artist()
  await artist.beat({ active: true })

  // Not idle long enough: the newcomer waits.
  assert.equal((await (await entrance([tom, ulysse], { awake: 1 })).enter({ code: ulysse.code })).status, 503)

  // Unsaved changes the server does not hold keep the site open.
  await artist.beat({ dirty: true })
  const { enter, watch, asked } = await entrance([tom, ulysse], { awake: 1, afk: 0 })
  assert.equal((await enter({ code: ulysse.code })).status, 503)

  // Once they reach it as drafts, the site can go: the editor knows beforehand why it might.
  await artist.beat({ dirty: true, drafts: [{ path: 'site.name', value: 'Atelier T.' }] })
  await watch()
  assert.deepEqual(await artist.beat({ dirty: true, drafts: [{ path: 'site.name', value: 'Atelier T.' }] }), {
    kind: 'standby',
    reason: 'room',
    after: 0,
    home: `${HOME}/#entrer`,
  })
  assert.equal((await enter({ code: ulysse.code })).status, 200)
  assert.deepEqual(asked, ['stop tom.example', 'start ulysse.example'])

  // The draft is still there when the artist comes back.
  await tom.start()
  const back = await tom.artist()
  const drafts = (await (await tom.ask('/_foliome/drafts', { cookie: back.cookie })).json()) as { drafts: Record<string, { value: unknown }> }
  assert.equal(drafts.drafts['site.name']?.value, 'Atelier T.')
})
