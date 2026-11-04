import { randomBytes, timingSafeEqual } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { request, type IncomingMessage, type ServerResponse } from 'node:http'
import path from 'node:path'

/**
 * The one address artists remember, and the only part of Foliome that is always running on the server. An artist
 * gives their code on the home page: the door finds whose it is, wakes that site's editing server alone, and sends
 * them there. It then keeps an eye on every server it woke: it warns the artist before closing one nobody uses, waits
 * longer when changes are not saved yet, and closes it. A site's editing server takes a lot of memory: never more than
 * a few run at once.
 *
 * The door also lends a demo site to anyone who asks, one visitor at a time, the others waiting in line. The demo has
 * a slot of its own: the artists' sites never wait for it, and it never waits for them.
 *
 * All of this is the server's business, not the sites'. Of a site the door only knows what its editing server answers
 * at `/_foliome/door`, with the key they share: how it is used, notices to pass on to the artist, and sessions granted
 * for a while, entered through a one-time ticket.
 */

export interface Site {
  /** The public name the site is edited under. */
  name: string
  /** The local port its editing server listens on. */
  port: number
  /** The site's folder on the server, where its code is kept. */
  root: string
  /** The service that runs its editing server. */
  unit: string
  /**
   * Lent to any visitor, one at a time, without a code. Its service puts the original content back before it starts,
   * so that each visitor finds the site as new.
   */
  demo?: boolean
}

/** Starts and stops the editing servers. On the server, systemd. */
export interface Control {
  awake(unit: string): Promise<boolean>
  start(unit: string): Promise<void>
  stop(unit: string): Promise<void>
}

/** In milliseconds, but the counts: `awake`, `line` and `places`. */
export interface Limits {
  /** Editing servers running at once, the demo aside. */
  awake: number
  /** Without activity for this long, the artist is warned. */
  warn: number
  /** Then closed. */
  close: number
  /** Unless changes are still unsaved: the artist is given this long in all. */
  closeUnsaved: number
  /** With no editor open at all, nobody is there to warn. */
  alone: number
  /** How long a waking server is given to answer. */
  waking: number
  /** An editor left alone this long gives way to an artist who arrives when every server is in use. */
  afk: number
  /** One visitor's turn at the demo. */
  demo: number
  /** How long before the end of a turn the visitor is told. */
  demoWarn: number
  /** A visitor sent to the demo with no editor open this long after has let their turn go. */
  arrive: number
  /** A page in the line that has not asked for its place this long has been closed. */
  linger: number
  /** Visitors waiting for the demo at once. */
  line: number
  /** Places in that line one visitor may hold. */
  places: number
}

export const LIMITS: Limits = {
  awake: 3,
  warn: 25 * 60_000,
  close: 30 * 60_000,
  closeUnsaved: 60 * 60_000,
  alone: 10 * 60_000,
  waking: 90_000,
  afk: 10 * 60_000,
  demo: 10 * 60_000,
  demoWarn: 2 * 60_000,
  arrive: 90_000,
  linger: 30_000,
  line: 40,
  places: 2,
}

export interface DoorOptions {
  /** Where the home page is served from: nothing else may ask. */
  home: string
  sites: Site[]
  /** Shared with the sites: what the door asks them is not for anyone else. */
  key: string
  control: Control
  limits?: Partial<Limits>
}

/** How a site's editing server is being used, as it says itself. */
export interface Presence {
  idle: number
  dirty: boolean
  editors: number
  busy: boolean
  /** What is unsaved has reached the server as drafts: closing it now loses nothing. */
  drafted?: boolean
}

type Woken = 'awake' | 'full' | 'unreachable'

type Decision = { act: 'keep' } | { act: 'warn'; in: number; unsaved: boolean } | { act: 'close' }

/** What to do with an editing server, given how it is being used. */
export function decide(presence: Presence, limits: Limits): Decision {
  const { idle, dirty, editors, busy } = presence
  // An upload or a publish under way is the artist's work too.
  if (busy) return { act: 'keep' }
  if (editors === 0 && !dirty && idle >= limits.alone) return { act: 'close' }
  const deadline = dirty ? limits.closeUnsaved : limits.close
  if (idle >= deadline) return { act: 'close' }
  if (idle >= limits.warn) return { act: 'warn', in: deadline - idle, unsaved: dirty }
  return { act: 'keep' }
}

/** An editor open but left alone for a while, which can give way without anything being lost. */
const yields = (presence: Presence, limits: Limits) =>
  !presence.busy && presence.editors > 0 && presence.idle >= limits.afk && (!presence.dirty || presence.drafted === true)

/**
 * Which running server to put to sleep for an artist who arrives when all are in use: one nobody has open, or else one
 * whose editor has been left alone long enough, the longest idle first. Never one busy with an upload or a publish,
 * nor one holding changes that exist nowhere else.
 */
export function evict(running: { site: Site; presence: Presence | null }[], limits: Limits): { site: Site; afk: boolean } | null {
  const longest = (list: typeof running) => list.sort((a, b) => b.presence!.idle - a.presence!.idle)[0]?.site
  const alone = longest(running.filter(({ presence }) => presence && presence.editors === 0 && !presence.dirty && !presence.busy))
  if (alone) return { site: alone, afk: false }
  const away = longest(running.filter(({ presence }) => presence && yields(presence, limits)))
  return away ? { site: away, afk: true } : null
}

/** Visitors waiting for the demo, in the order they came. Each page holds a ticket, which it shows to keep its place. */
export function createLine(limits: Pick<Limits, 'linger' | 'line' | 'places'>, now = Date.now) {
  let places: { ticket: string; who: string; seen: number }[] = []
  /** A page that stopped asking has been closed: its place goes. */
  const prune = () => {
    const at = now()
    places = places.filter((place) => at - place.seen <= limits.linger)
  }
  return {
    join(who: string): { ticket: string } | 'full' | 'too_many' {
      prune()
      if (places.length >= limits.line) return 'full'
      if (places.filter((place) => place.who === who).length >= limits.places) return 'too_many'
      const ticket = randomBytes(18).toString('base64url')
      places.push({ ticket, who, seen: now() })
      return { ticket }
    },
    /** The page asks again and keeps its place: 1 for the next in line, 0 when it has none any more. */
    keep(ticket: string) {
      prune()
      const at = places.findIndex((place) => place.ticket === ticket)
      if (at === -1) return 0
      places[at]!.seen = now()
      return at + 1
    },
    leave(ticket: string) {
      places = places.filter((place) => place.ticket !== ticket)
    },
    /** The next in line, taken out of it. */
    next() {
      prune()
      return places.shift()
    },
  }
}

const ROUTE = '/entrer'
const DEMO_ROUTE = '/entrer/demo'
const API = '/_foliome'
const LONGEST_BODY = 1024
/** Wrong codes allowed in five minutes: from one visitor, and from everybody together. */
const TRIES = 8
const TRIES_IN_ALL = 200
/** Places in the demo's line one visitor may take in five minutes. */
const JOINS = 10
const WINDOW = 5 * 60_000
const KNOWN_VISITORS = 50

const normalizeCode = (input: string) => input.toUpperCase().replace(/[^A-Z0-9]/g, '')
const same = (a: string, b: string) => {
  const [x, y] = [Buffer.from(a), Buffer.from(b)]
  return x.length === y.length && timingSafeEqual(x, y)
}
const pause = (ms: number) => new Promise((done) => setTimeout(done, ms))

/** Calls a site's editing server as its own pages would, through its public name, with the door's key. */
const call = <T>(site: Site, key: string, method: 'GET' | 'POST', body?: unknown) =>
  new Promise<T>((done, fail) => {
    const text = body === undefined ? '' : JSON.stringify(body)
    const req = request(
      {
        host: '127.0.0.1',
        port: site.port,
        path: `${API}/door`,
        method,
        timeout: 5000,
        headers: { host: site.name, origin: `https://${site.name}`, 'x-foliome-door': key, 'content-type': 'application/json', 'content-length': Buffer.byteLength(text) },
      },
      (res) => {
        let answer = ''
        res.on('data', (chunk: Buffer) => (answer += chunk))
        res.on('end', () => {
          if (res.statusCode !== 200) return fail(new Error(`${site.name}: ${res.statusCode}`))
          try {
            done(JSON.parse(answer) as T)
          } catch (err) {
            fail(err)
          }
        })
      },
    )
    req.on('timeout', () => req.destroy(new Error(`${site.name}: no answer`)))
    req.on('error', fail)
    req.end(text)
  })

function readBody(req: IncomingMessage) {
  return new Promise<string | null>((done, fail) => {
    let body = ''
    let size = 0
    req.on('data', (chunk: Buffer) => {
      size += chunk.length
      if (size > LONGEST_BODY) done(null)
      else body += chunk.toString()
    })
    req.on('end', () => done(body))
    req.on('error', fail)
  })
}

/** The site's own code, read where its editing server keeps it, whether that server runs or not. */
async function codeOf(site: Site): Promise<string | null> {
  try {
    const { code } = JSON.parse(await readFile(path.join(site.root, '.foliome', 'local.json'), 'utf8')) as { code?: unknown }
    return typeof code === 'string' && code.length === 8 ? code : null
  } catch {
    return null
  }
}

/** Counts what each visitor, or everybody together, did in the last five minutes. */
function counter() {
  const records = new Map<string, { count: number; resetAt: number }>()
  return {
    spent(who: string, most: number) {
      const record = records.get(who)
      return !!record && record.resetAt > Date.now() && record.count >= most
    },
    add(who: string) {
      const now = Date.now()
      for (const [visitor, record] of records) if (record.resetAt <= now) records.delete(visitor)
      const record = records.get(who)
      records.set(who, record ? { ...record, count: record.count + 1 } : { count: 1, resetAt: now + WINDOW })
    },
    forget(who: string) {
      records.delete(who)
    },
  }
}

/** A demo visitor's turn: being opened for them, then theirs until `until`. */
type Turn = { ticket: string; seen: number } & ({ state: 'opening' } | { state: 'open'; url: string; from: number; until: number })

export function door({ home, sites, key, control, limits: given = {} }: DoorOptions) {
  const limits = { ...LIMITS, ...given }
  const clients = sites.filter((site) => !site.demo)
  const demo = sites.find((site) => site.demo)
  const failures = counter()
  const joins = counter()
  let known: string[] = []
  // A site is woken once at a time, however many ask together.
  const waking = new Map<string, Promise<Woken>>()
  // So that a sign of life does not close the server while it is still waking.
  const wokenAt = new Map<string, number>()

  const presenceOf = (site: Site) => call<Presence>(site, key, 'GET')
  const tell = (site: Site, notice: unknown) => call<{ ok: true }>(site, key, 'POST', { notice }).catch(() => {})
  const signIn = `${home}/#entrer`

  /** Waits for a woken server to answer. */
  async function ready(site: Site) {
    const until = Date.now() + limits.waking
    while (Date.now() < until) {
      if (await presenceOf(site).then(() => true, () => false)) return true
      await pause(500)
    }
    return false
  }

  /** Makes room for one more server, by closing one that nobody is using, or whose artist has left it alone. */
  async function room(wanted: Site) {
    const running: { site: Site; presence: Presence | null }[] = []
    for (const site of clients) {
      if (site === wanted || !(await control.awake(site.unit))) continue
      running.push({ site, presence: await presenceOf(site).catch(() => null) })
    }
    if (running.length < limits.awake) return true
    const chosen = evict(running, limits)
    if (!chosen) return false
    // In case the editor is listening right now. It has been told already, in case it is not (see `watch`).
    if (chosen.afk) await tell(chosen.site, { kind: 'closed', reason: 'room', after: limits.afk, home: signIn })
    wokenAt.delete(chosen.site.name)
    await control.stop(chosen.site.unit)
    return true
  }

  async function wake(site: Site): Promise<Woken> {
    if (await control.awake(site.unit)) return 'awake'
    if (!(await room(site))) return 'full'
    await control.start(site.unit)
    wokenAt.set(site.name, Date.now())
    return (await ready(site)) ? 'awake' : 'unreachable'
  }

  // The demo: one visitor at a time, the others in line.
  const line = createLine(limits)
  let turn: Turn | null = null
  /** Started with its content as new, and lent to nobody yet: the next visitor can have it as it is. */
  let fresh = false
  /** Visitors whose turn could not be opened: told once, when they next ask. */
  const failed = new Set<string>()
  let moving: Promise<void> | null = null

  /** How long the visitor at this place in the line is likely to wait. */
  const wait = (place: number) => {
    const current = !turn ? 0 : turn.state === 'open' ? Math.max(0, turn.until - Date.now()) : limits.demo
    return current + (place - 1) * limits.demo
  }

  /** Opens the demo for the next visitor: as new, with a session that lasts their turn and a ticket that leads to it. */
  async function open(site: Site, next: { ticket: string; seen: number }) {
    const opening: Turn = { ticket: next.ticket, seen: next.seen, state: 'opening' }
    turn = opening
    try {
      const awake = await control.awake(site.unit)
      if (!awake || !fresh) {
        // The service puts the original content back before it starts.
        if (awake) await control.stop(site.unit)
        fresh = false
        await control.start(site.unit)
        if (!(await ready(site))) throw new Error(`${site.name}: no answer`)
        fresh = true
      }
      // Gone while it was opening: the demo stays as it is, for whoever is next.
      if (Date.now() - opening.seen > limits.linger) {
        turn = null
        return
      }
      const { ticket } = await call<{ ticket: string }>(site, key, 'POST', { grant: { ms: limits.demo, home: `${home}/#demo` } })
      fresh = false
      const from = Date.now()
      turn = { ...opening, state: 'open', url: `https://${site.name}/?ticket=${encodeURIComponent(ticket)}`, from, until: from + limits.demo }
    } catch (err) {
      console.error(err)
      failed.add(next.ticket)
      turn = null
      fresh = false
    }
  }

  async function step(site: Site) {
    if (turn?.state === 'opening') return
    if (turn?.state === 'open') {
      const now = Date.now()
      const presence = await presenceOf(site).catch(() => null)
      const over = now >= turn.until
      // Never arrived, or left: no editor has been open for a while.
      const gone = now - turn.from >= limits.arrive && !presence?.busy && (presence?.editors ?? 0) === 0
      if (over || gone) {
        turn = null
        if (over) await tell(site, { kind: 'closed', reason: 'time', home: `${home}/#demo` })
        // Whoever is next finds it as new: the service starts again from the original content.
        await control.stop(site.unit)
      } else if (turn.until - now <= limits.demoWarn) {
        await tell(site, { kind: 'closing', reason: 'time', at: turn.until, unsaved: presence?.dirty ?? false })
      }
    }
    if (turn) return
    const next = line.next()
    if (next) return open(site, next)
    // Nobody waiting: the demo sleeps.
    fresh = false
    if (await control.awake(site.unit)) await control.stop(site.unit)
  }

  /** Moves the demo's line along: ends a turn that is over and opens the next. Run every few seconds, and when asked. */
  function turns() {
    if (!demo) return Promise.resolve()
    moving ??= step(demo)
      .catch((err: unknown) => console.error(err))
      .finally(() => {
        moving = null
      })
    return moving
  }

  /** What a page in the demo's line is told: its place and the likely wait, or where to go now that its turn has come. */
  function standing(ticket: string): [number, object] {
    if (failed.delete(ticket)) return [503, { error: 'unreachable' }]
    if (turn?.ticket === ticket) {
      turn.seen = Date.now()
      return [200, turn.state === 'open' ? { ticket, url: turn.url, left: turn.until - Date.now() } : { ticket, place: 0, turn: limits.demo }]
    }
    const place = line.keep(ticket)
    if (!place) return [404, { error: 'gone' }]
    return [200, { ticket, place, wait: wait(place), turn: limits.demo }]
  }

  const handle = async (req: IncomingMessage, res: ServerResponse) => {
    const answer = (status: number, content: object) => {
      res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' })
      res.end(JSON.stringify(content))
    }
    const route = req.url === ROUTE ? 'code' : req.url === DEMO_ROUTE && demo ? 'demo' : null
    if (!route || req.method !== 'POST') return answer(404, { error: 'not_found' })
    if (req.headers.origin !== home) return answer(403, { error: 'forbidden_origin' })

    const text = await readBody(req)
    if (text === null) return answer(413, { error: 'too_large' })
    let body: { code?: unknown; ticket?: unknown; leave?: unknown } | null = null
    try {
      body = JSON.parse(text) as typeof body
    } catch {
      // Judged below.
    }
    if (typeof body !== 'object' || body === null) return answer(400, { error: 'invalid' })

    // The reverse proxy in front of the door writes this header itself.
    const who = String(req.headers['x-forwarded-for'] ?? '').split(',')[0]?.trim() || (req.socket.remoteAddress ?? 'unknown')

    if (route === 'demo') {
      const { ticket, leave } = body
      if (ticket !== undefined && typeof ticket !== 'string') return answer(400, { error: 'invalid' })
      if (ticket && leave === true) {
        line.leave(ticket)
        // Left while the demo was being opened for them: it goes to the next one.
        if (turn?.ticket === ticket && turn.state === 'opening') turn.seen = 0
        return answer(200, { ok: true })
      }
      if (ticket) {
        const [status, content] = standing(ticket)
        void turns()
        return answer(status, content)
      }
      if (joins.spent(who, JOINS)) return answer(429, { error: 'too_many' })
      const joined = line.join(who)
      if (joined === 'full') return answer(503, { error: 'full' })
      if (joined === 'too_many') return answer(429, { error: 'too_many' })
      joins.add(who)
      // With nobody ahead the demo starts opening at once, and the answer already says so.
      void turns()
      const [status, content] = standing(joined.ticket)
      return answer(status, content)
    }

    const { code } = body
    if (typeof code !== 'string') return answer(400, { error: 'invalid' })
    if (failures.spent(who, TRIES) || (failures.spent('*', TRIES_IN_ALL) && !known.includes(who))) return answer(429, { error: 'too_many' })

    // Every code is compared, whichever matches: the time taken says nothing of which site it opens. The demo is
    // entered by turn, never by code.
    const given = normalizeCode(code)
    let site: Site | undefined
    for (const candidate of clients) {
      const expected = await codeOf(candidate)
      if (expected && same(given, expected) && !site) site = candidate
    }
    if (!site) {
      failures.add(who)
      failures.add('*')
      return answer(401, { error: 'bad_code' })
    }
    failures.forget(who)
    known = [...known.filter((visitor) => visitor !== who), who].slice(-KNOWN_VISITORS)

    let woken = waking.get(site.name)
    if (!woken) {
      woken = wake(site).finally(() => waking.delete(site.name))
      waking.set(site.name, woken)
    }
    const outcome = await woken.catch((): Woken => 'unreachable')
    // Every server running is in use: the machine would not hold one more.
    if (outcome === 'full') return answer(503, { error: 'busy' })
    if (outcome === 'unreachable') return answer(503, { error: 'unreachable' })
    return answer(200, { url: `https://${site.name}/?edit=${encodeURIComponent(given)}` })
  }

  /** Looks at every running editing server: warns, closes, or leaves it be. Run every half minute. */
  async function watch() {
    for (const site of clients) {
      if (waking.has(site.name) || !(await control.awake(site.unit))) continue
      const presence = await presenceOf(site).catch(() => null)
      // Still starting, or already stopping: looked at again next time.
      if (!presence) continue
      // A server just woken has had no time to see its artist arrive.
      const woken = wokenAt.get(site.name) ?? 0
      if (Date.now() - woken < limits.alone) presence.idle = Math.min(presence.idle, Date.now() - woken)
      const decision = decide(presence, limits)
      if (decision.act === 'warn') await tell(site, { kind: 'closing', at: Date.now() + decision.in, unsaved: decision.unsaved })
      // Left alone long enough to give way to another artist, which may come at any moment and leave no time to say
      // so: an editor in a tab the browser has put to sleep would not hear it. It is told now, while it can be.
      else if (decision.act === 'keep') await tell(site, yields(presence, limits) ? { kind: 'standby', reason: 'room', after: limits.afk, home: signIn } : null)
      else {
        await tell(site, { kind: 'closed', home: signIn })
        wokenAt.delete(site.name)
        // Stopping commits what the artist saved and sends it away.
        await control.stop(site.unit)
      }
    }
  }

  return { handle, watch, turns }
}
