import { timingSafeEqual } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { request, type IncomingMessage, type ServerResponse } from 'node:http'
import path from 'node:path'

/**
 * The one address artists remember, and the only part of Foliome that is always running on the server. An artist
 * gives their code on the home page: the door finds whose it is, wakes that site's editing server alone, and sends
 * them there. It then keeps an eye on every server it woke: it warns the artist before closing one nobody uses, waits
 * longer when changes are not saved yet, and closes it. A site's editing server takes a lot of memory: never more than
 * a few run at once.
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
}

/** Starts and stops the editing servers. On the server, systemd. */
export interface Control {
  awake(unit: string): Promise<boolean>
  start(unit: string): Promise<void>
  stop(unit: string): Promise<void>
}

/** All in milliseconds, but `awake`. */
export interface Limits {
  /** Editing servers running at once. */
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
}

export const LIMITS: Limits = {
  awake: 3,
  warn: 25 * 60_000,
  close: 30 * 60_000,
  closeUnsaved: 60 * 60_000,
  alone: 10 * 60_000,
  waking: 90_000,
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

const ROUTE = '/entrer'
const API = '/_foliome'
const LONGEST_BODY = 1024
/** Wrong codes allowed in five minutes: from one visitor, and from everybody together. */
const TRIES = 8
const TRIES_IN_ALL = 200
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

export function door({ home, sites, key, control, limits: given = {} }: DoorOptions) {
  const limits = { ...LIMITS, ...given }
  const failures = new Map<string, { count: number; resetAt: number }>()
  let known: string[] = []
  // A site is woken once at a time, however many ask together.
  const waking = new Map<string, Promise<Woken>>()
  // So that a sign of life does not close the server while it is still waking.
  const wokenAt = new Map<string, number>()

  const spent = (who: string, most: number) => {
    const record = failures.get(who)
    return !!record && record.resetAt > Date.now() && record.count >= most
  }
  const fail = (who: string) => {
    const now = Date.now()
    for (const [visitor, record] of failures) if (record.resetAt <= now) failures.delete(visitor)
    const record = failures.get(who)
    failures.set(who, record ? { ...record, count: record.count + 1 } : { count: 1, resetAt: now + WINDOW })
  }

  const presenceOf = (site: Site) => call<Presence>(site, key, 'GET')
  const tell = (site: Site, notice: unknown) => call<{ ok: true }>(site, key, 'POST', { notice }).catch(() => {})

  /** Waits for a woken server to answer. */
  async function ready(site: Site) {
    const until = Date.now() + limits.waking
    while (Date.now() < until) {
      if (await presenceOf(site).then(() => true, () => false)) return true
      await pause(500)
    }
    return false
  }

  /** Makes room for one more server, by closing one that nobody is using. */
  async function room(wanted: Site) {
    const running: { site: Site; presence: Presence | null }[] = []
    for (const site of sites) {
      if (site === wanted || !(await control.awake(site.unit))) continue
      running.push({ site, presence: await presenceOf(site).catch(() => null) })
    }
    if (running.length < limits.awake) return true
    const idle = running
      .filter(({ presence }) => presence && presence.editors === 0 && !presence.dirty && !presence.busy)
      .sort((a, b) => b.presence!.idle - a.presence!.idle)[0]
    if (!idle) return false
    await control.stop(idle.site.unit)
    return true
  }

  async function wake(site: Site): Promise<Woken> {
    if (await control.awake(site.unit)) return 'awake'
    if (!(await room(site))) return 'full'
    await control.start(site.unit)
    wokenAt.set(site.name, Date.now())
    return (await ready(site)) ? 'awake' : 'unreachable'
  }

  const handle = async (req: IncomingMessage, res: ServerResponse) => {
    const answer = (status: number, content: object) => {
      res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' })
      res.end(JSON.stringify(content))
    }
    if (req.url !== ROUTE || req.method !== 'POST') return answer(404, { error: 'not_found' })
    if (req.headers.origin !== home) return answer(403, { error: 'forbidden_origin' })

    const text = await readBody(req)
    if (text === null) return answer(413, { error: 'too_large' })
    let code: unknown
    try {
      code = (JSON.parse(text) as { code?: unknown }).code
    } catch {
      // Judged below.
    }
    if (typeof code !== 'string') return answer(400, { error: 'invalid' })

    // The reverse proxy in front of the door writes this header itself.
    const who = String(req.headers['x-forwarded-for'] ?? '').split(',')[0]?.trim() || (req.socket.remoteAddress ?? 'unknown')
    if (spent(who, TRIES) || (spent('*', TRIES_IN_ALL) && !known.includes(who))) return answer(429, { error: 'too_many' })

    // Every code is compared, whichever matches: the time taken says nothing of which site it opens.
    const given = normalizeCode(code)
    let site: Site | undefined
    for (const candidate of sites) {
      const expected = await codeOf(candidate)
      if (expected && same(given, expected) && !site) site = candidate
    }
    if (!site) {
      fail(who)
      fail('*')
      return answer(401, { error: 'bad_code' })
    }
    failures.delete(who)
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
    for (const site of sites) {
      if (waking.has(site.name) || !(await control.awake(site.unit))) continue
      const presence = await presenceOf(site).catch(() => null)
      // Still starting, or already stopping: looked at again next time.
      if (!presence) continue
      // A server just woken has had no time to see its artist arrive.
      const woken = wokenAt.get(site.name) ?? 0
      if (Date.now() - woken < limits.alone) presence.idle = Math.min(presence.idle, Date.now() - woken)
      const decision = decide(presence, limits)
      if (decision.act === 'keep') await tell(site, null)
      else if (decision.act === 'warn') await tell(site, { kind: 'closing', at: Date.now() + decision.in, unsaved: decision.unsaved })
      else {
        await tell(site, { kind: 'closed', home: `${home}/#entrer` })
        wokenAt.delete(site.name)
        // Stopping commits what the artist saved and sends it away.
        await control.stop(site.unit)
      }
    }
  }

  return { handle, watch }
}
