import { spawn } from 'node:child_process'
import { createHash, randomBytes, randomInt, timingSafeEqual } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { mkdir, readFile, rename, stat, writeFile } from 'node:fs/promises'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { isIP } from 'node:net'
import path from 'node:path'
import { mimeOf, type Schema } from '@foliome/core'
import { createApp, type Storage, TooLargeError } from '@foliome/server'
import { fsStorage } from '@foliome/server/fs'
import { detectTools } from '@foliome/server/media'
import { getRequestListener, type HttpBindings } from '@hono/node-server'
import { Hono, type MiddlewareHandler } from 'hono'
import { deleteCookie, getCookie, setCookie } from 'hono/cookie'
import { parse, serialize } from 'hono/utils/cookie'

/**
 * Local editing: the site's dev server doubles as the editing service.
 * Content is written to `content/content.json`, files to `public/media/`.
 * The developer's own browser is trusted; anyone else needs the access code,
 * and is given nothing of the site or of its source without it.
 */

export interface LocalOptions {
  root: string
  name: string
  schema: Schema
  allowedHosts: string[]
  /**
   * Where this server is reached from outside, when a tunnel leads to it. Nobody is then trusted for being on this
   * machine: what comes through a tunnel arrives from this machine too.
   */
  address?: URL
  editorFile: string
  /** Shell command that builds and deploys the site, run from `root`. */
  publish?: string
  /** Called before the publish command runs. */
  beforePublish?: () => Promise<unknown>
  /** Called after every stored change. */
  onChange: () => void
  /**
   * Shared with the door that wakes and closes the editing servers of a machine: it asks with this key how this one is
   * used, and leaves notices for the artist. Unset, nobody can ask.
   */
  doorKey?: string
  /** Largest file the artist may send, in bytes. Unset: 2 GB. */
  maxFileSize?: number
  /**
   * For a site lent to strangers, a public demo for instance. Nobody enters with the access code, only through a
   * one-time ticket the door hands out, for a session as long as the door decided. Nothing is published, pages are
   * kept out of search engines, and `mediaBudget` bytes of files may be sent in a session, in all.
   */
  restricted?: { mediaBudget?: number }
}

/** How this editing server is being used, as the door sees it. */
export interface Presence {
  /** Milliseconds since the artist last did anything. */
  idle: number
  /** An open panel holds changes the artist has not saved. */
  dirty: boolean
  /** Editors open on this server, judged by their recent signs of life. */
  editors: number
  /** A request is under way, an upload or a publish: closing now would cut it. */
  busy: boolean
  /** Every unsaved change an open editor holds has reached this server as a draft: closing would lose nothing. */
  drafted: boolean
}

/**
 * What the door has to say to the artist, through the editor. `reason` says why: nothing done for a while (`idle`, the
 * default), room needed for someone else (`room`), or the time granted is over (`time`).
 */
export type Notice =
  /** The session closes at `at`. */
  | { kind: 'closing'; at: number; unsaved: boolean; reason?: 'idle' | 'time' }
  | { kind: 'closed'; home?: string; reason?: 'idle' | 'room' | 'time'; after?: number }
  /** Nothing to show yet: the session may close at any moment now, after `after` ms left alone, with no other warning. */
  | { kind: 'standby'; reason: 'room'; after: number; home?: string }

/** The last thing an editor had not saved in a field, kept until it is saved or let go. */
export interface Draft {
  value: unknown
  at: number
}

interface State {
  code: string
  /** sha256(session token) → expiry timestamp */
  sessions: Record<string, number>
  /** Wrong codes, by visitor and for everybody. Kept here so that a restart does not wipe the count. */
  failures: Record<string, { count: number; resetAt: number }>
  /** Visitors who have signed in before: a flood of wrong codes from elsewhere does not shut them out. */
  known: string[]
  /** Where the door that grants sessions sends people back to, given with its last grant. */
  home?: string
}

type Env = { Bindings: HttpBindings }

const API = '/_foliome'
const MEDIA = '/media'
const COOKIE = 'foliome_session'
const SESSION_DAYS = 30
const LOOPBACK_ADDRESSES = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1'])
const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '::1'])
/** Wrong codes allowed in five minutes: from one visitor, and from everybody together. */
const TRIES = 8
const TRIES_IN_ALL = 200
const EVERYBODY = '*'
const KNOWN_VISITORS = 50
/** An editor gives a sign of life every thirty seconds: one missed is allowed. */
const ALIVE = 75_000
/** A ticket from the door is for someone being sent here right away. */
const TICKET_LIFE = 2 * 60_000
const LONGEST_SESSION = SESSION_DAYS * 86_400_000
const DRAFT_PATH = /^[\w-]+(\.[\w-]+)*$/
/** What one sign of life may bring as drafts, in all: far more than any text typed by hand. */
const DRAFTS_SIZE = 512 * 1024
const MAX_FILE = 2 * 1024 ** 3

// No I, L, O, 0 or 1: the code is read aloud and typed by hand.
const ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'
const newCode = () => Array.from({ length: 8 }, () => ALPHABET[randomInt(ALPHABET.length)]).join('')
export const formatCode = (code: string) => `${code.slice(0, 4)}-${code.slice(4)}`
const normalizeCode = (input: unknown) => String(input ?? '').toUpperCase().replace(/[^A-Z0-9]/g, '')

const sha256 = (text: string) => createHash('sha256').update(text).digest('hex')
const isApi = (url: string) => {
  const pathname = url.split('?')[0]
  return pathname === API || !!pathname?.startsWith(`${API}/`)
}
const escapeHtml = (text: string) => text.replace(/[&<>"]/g, (char) => `&#${char.charCodeAt(0)};`)
const hostName = (host: string | undefined) => (host ?? '').replace(/:\d+$/, '').replace(/^\[|\]$/g, '').toLowerCase()

/** Whole or not at all: an unreadable file would mean a new code, and the artist's link dead. */
async function storeState(file: string, state: State) {
  const tmp = `${file}.tmp`
  await writeFile(tmp, JSON.stringify(state, null, 2))
  await rename(tmp, file)
}

async function loadState(file: string): Promise<State> {
  let state: State = { code: newCode(), sessions: {}, failures: {}, known: [] }
  try {
    const saved = JSON.parse(await readFile(file, 'utf8')) as Partial<State>
    if (typeof saved.code === 'string' && saved.code.length === 8) {
      state = { code: saved.code, sessions: saved.sessions ?? {}, failures: saved.failures ?? {}, known: saved.known ?? [], home: saved.home }
    }
  } catch {
    // First run, or an unreadable file: start fresh.
  }
  const now = Date.now()
  for (const [hash, expires] of Object.entries(state.sessions)) if (expires < now) delete state.sessions[hash]
  for (const [who, record] of Object.entries(state.failures)) if (record.resetAt <= now) delete state.failures[who]
  await mkdir(path.dirname(file), { recursive: true })
  await storeState(file, state)
  return state
}

async function loadDrafts(file: string): Promise<Record<string, Draft>> {
  try {
    const saved = JSON.parse(await readFile(file, 'utf8')) as unknown
    return typeof saved === 'object' && saved !== null && !Array.isArray(saved) ? (saved as Record<string, Draft>) : {}
  } catch {
    return {}
  }
}

/** Whether a change at `changed` replaces what was drafted at `drafted`: the same field, one inside it, or around it. */
const overlaps = (changed: string, drafted: string) => changed === drafted || drafted.startsWith(`${changed}.`) || changed.startsWith(`${drafted}.`)

export async function createLocal(options: LocalOptions) {
  const dir = path.join(options.root, '.foliome')
  const stateFile = path.join(dir, 'local.json')
  const draftsFile = path.join(dir, 'drafts.json')
  const mediaDir = path.join(options.root, 'public', 'media')
  const state = await loadState(stateFile)
  let saving: Promise<unknown> = Promise.resolve()
  const save = () => {
    saving = saving.catch(() => {}).then(() => storeState(stateFile, state))
    return saving
  }
  const restricted = options.restricted
  const publishCommand = restricted ? undefined : options.publish
  const maxFileSize = options.maxFileSize ?? MAX_FILE

  // Drafts: what open panels hold unsaved, sent with each sign of life, so that closing the server for want of room
  // loses none of it. Written to disk shortly after each change, and when the server stops.
  let drafts = await loadDrafts(draftsFile)
  let draftsTimer: ReturnType<typeof setTimeout> | null = null
  let draftsWriting: Promise<unknown> = Promise.resolve()
  const writeDrafts = () => {
    if (draftsTimer) clearTimeout(draftsTimer)
    draftsTimer = null
    const text = JSON.stringify(drafts)
    draftsWriting = draftsWriting
      .catch(() => {})
      .then(async () => {
        const tmp = `${draftsFile}.tmp`
        await writeFile(tmp, text)
        await rename(tmp, draftsFile)
      })
      .catch((err: unknown) => console.warn('foliome: drafts could not be written', err))
    return draftsWriting
  }
  const draftsChanged = () => {
    // Not a reason for the process to stay: stopping writes them down anyway.
    draftsTimer ??= setTimeout(writeDrafts, 1000).unref()
  }
  const dropDrafts = (which: (draft: string) => boolean) => {
    const before = Object.keys(drafts).length
    drafts = Object.fromEntries(Object.entries(drafts).filter(([draft]) => !which(draft)))
    if (Object.keys(drafts).length !== before) draftsChanged()
  }
  /** Keeps what an editor sent; says whether all of it was kept. */
  const keepDrafts = (given: unknown) => {
    if (!Array.isArray(given) || given.length === 0 || given.length > 100) return false
    const entries = given.filter(
      (entry): entry is { path: string; value: unknown } =>
        typeof entry === 'object' && entry !== null && typeof entry.path === 'string' && entry.path.length <= 300 && DRAFT_PATH.test(entry.path) && 'value' in entry,
    )
    if (entries.length !== given.length || JSON.stringify(entries).length > DRAFTS_SIZE) return false
    const at = Date.now()
    for (const { path: field, value } of entries) {
      if (JSON.stringify(drafts[field]?.value) === JSON.stringify(value)) continue
      drafts[field] = { value, at }
      draftsChanged()
    }
    return true
  }

  // In a restricted session, what is sent counts against its budget, from the moment the door grants it.
  let mediaSpent = 0

  const tools = await detectTools()
  const files = fsStorage({
    contentFile: path.join(options.root, 'content', 'content.json'),
    mediaDir,
    mediaPath: MEDIA,
    historyDir: path.join(dir, 'history'),
    media: tools,
  })
  const storage: Storage = {
    ...files,
    async putFile(id, name, body, maxBytes) {
      const budget = restricted?.mediaBudget
      if (!budget) return files.putFile(id, name, body, maxBytes)
      const left = budget - mediaSpent
      if (left <= 0) throw new TooLargeError(budget)
      try {
        const stored = await files.putFile(id, name, body, Math.min(maxBytes, left))
        mediaSpent += stored.size
        return stored
      } catch (err) {
        if (err instanceof TooLargeError && left < maxBytes) throw new TooLargeError(budget)
        throw err
      }
    },
    async update(change) {
      const doc = await files.update(change)
      options.onChange()
      return doc
    },
    async undo() {
      const undone = await files.undo()
      if (undone) options.onChange()
      return undone
    },
  }

  const hostAllowed = (host: string | undefined) => {
    const name = hostName(host)
    return (
      LOOPBACK_HOSTS.has(name) ||
      isIP(name) !== 0 ||
      name.endsWith('.local') ||
      name.endsWith('.localhost') ||
      name === options.address?.hostname ||
      options.allowedHosts.includes(name)
    )
  }

  /**
   * The developer's own browser: a direct connection from this machine to a loopback address. Behind a tunnel there
   * is no telling it apart: the tunnel's requests come from this machine as well, under whatever name their sender
   * chose.
   */
  const isThisMachine = (req: IncomingMessage) =>
    !options.address &&
    LOOPBACK_ADDRESSES.has(req.socket.remoteAddress ?? '') &&
    LOOPBACK_HOSTS.has(hostName(req.headers.host)) &&
    !req.headers['x-forwarded-for'] &&
    !req.headers.forwarded

  const isEditor = (req: IncomingMessage) => {
    const token = parse(req.headers.cookie ?? '', COOKIE)[COOKIE]
    if (token && (state.sessions[sha256(token)] ?? 0) > Date.now()) return true
    return isThisMachine(req)
  }

  // How the server is used, for the door. Kept in memory: a restart is a fresh start.
  let lastActivity = Date.now()
  let inFlight = 0
  let notice: Notice | null = null
  /** Each open editor's last sign of life, by session, whether it held unsaved changes, and whether they came as drafts. */
  const editors = new Map<string, { at: number; dirty: boolean; drafted: boolean }>()
  /** One-time tickets the door handed out, by hash: until when each may be used, and when its session will end. */
  const tickets = new Map<string, { expires: number; until: number }>()
  /** The artist did something: whatever the door was about to say about their absence no longer holds. Time granted still runs out. */
  const touch = () => {
    lastActivity = Date.now()
    if ((notice?.kind === 'closing' && notice.reason !== 'time') || notice?.kind === 'standby') notice = null
  }
  const presence = (): Presence => {
    const now = Date.now()
    for (const [key, beat] of editors) if (now - beat.at > ALIVE) editors.delete(key)
    return {
      idle: now - lastActivity,
      dirty: [...editors.values()].some((beat) => beat.dirty),
      editors: editors.size,
      busy: inFlight > 0 || publishing,
      drafted: [...editors.values()].every((beat) => beat.drafted),
    }
  }
  const fromDoor = (req: IncomingMessage) => {
    if (!options.doorKey) return false
    const given = Buffer.from(String(req.headers['x-foliome-door'] ?? ''))
    const expected = Buffer.from(options.doorKey)
    return given.length === expected.length && timingSafeEqual(given, expected)
  }

  const guard: MiddlewareHandler<Env> = async (c, next) => {
    if (!isEditor(c.env.incoming)) return c.json({ error: 'unauthorized' }, 401)
    await next()
  }

  // Wrong codes are counted per visitor, so that one who guesses does not shut the door on the artist, and for
  // everybody together, since a visitor behind a tunnel is only who the tunnel says they are.
  const spent = (who: string, most: number) => {
    const record = state.failures[who]
    return !!record && record.resetAt > Date.now() && record.count >= most
  }
  const fail = (who: string) => {
    const now = Date.now()
    for (const [key, record] of Object.entries(state.failures)) if (record.resetAt <= now) delete state.failures[key]
    const record = state.failures[who]
    state.failures[who] = record ? { ...record, count: record.count + 1 } : { count: 1, resetAt: now + 5 * 60_000 }
  }
  /** Hashed: no visitor's address is kept on disk. */
  const visitor = (req: IncomingMessage) => {
    const through = options.address && String(req.headers['x-forwarded-for'] ?? '').split(',')[0]?.trim()
    return sha256(through || (req.socket.remoteAddress ?? 'unknown'))
  }

  // The folder that holds the access code. Vite hands any file of the project to whoever asks for it by name.
  const isPrivate = (url: string) => {
    let plain = url
    try {
      plain = decodeURIComponent(url)
    } catch {
      // Malformed: judged as written.
    }
    return /[\\/]\.foliome([\\/?#]|$)/i.test(plain)
  }

  // Whoever has not signed in is given one page, which asks for the code: the editor shows its prompt on it. Turned
  // away with a ticket that no longer opens anything, they are told so.
  const doorPage = (why = '') =>
    `<!doctype html><html lang="fr" data-foliome-door="${why}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex"><link rel="icon" href="data:,"><title>${escapeHtml(options.name)}</title><style>html{background:#f2f2f5}</style></head><body><script src="${API}/editor.js"></script></body></html>`
  const door = (req: IncomingMessage, res: ServerResponse, why = '') => {
    const page = req.method === 'GET' && (req.headers.accept ?? '').includes('text/html')
    res.writeHead(401, {
      'content-type': `${page ? 'text/html' : 'text/plain'}; charset=utf-8`,
      'cache-control': 'no-store',
      'x-robots-tag': 'noindex',
    })
    res.end(page ? doorPage(why) : 'unauthorized')
  }

  /** Over the public address the cookie only ever travels encrypted. */
  const secureFor = (host: string | undefined) => options.address?.protocol === 'https:' && hostName(host) === options.address.hostname

  /**
   * A ticket from the door, exchanged once for the session it was handed out for. The address is then cleaned of it,
   * so that it is neither kept in the history nor shown, and asks for the editor.
   */
  async function exchange(req: IncomingMessage, res: ServerResponse, url: URL, ticket: string) {
    url.searchParams.delete('ticket')
    url.searchParams.delete('edit')
    const rest = url.searchParams.toString()
    const clean = `${url.pathname}?${rest ? `${rest}&` : ''}edit`
    const hash = sha256(ticket)
    const granted = tickets.get(hash)
    const now = Date.now()
    if (granted && granted.expires > now && granted.until > now) {
      tickets.delete(hash)
      const token = randomBytes(32).toString('base64url')
      // The one session: whoever had one before is out.
      state.sessions = { [sha256(token)]: granted.until }
      await save()
      const cookie = serialize(COOKIE, token, { path: '/', httpOnly: true, sameSite: 'Lax', secure: secureFor(req.headers.host), maxAge: Math.floor((granted.until - now) / 1000) })
      res.writeHead(303, { location: clean, 'set-cookie': cookie, 'cache-control': 'no-store' })
      return res.end()
    }
    // Followed again by the one it was given to, already in: nothing to exchange.
    if (isEditor(req)) {
      res.writeHead(303, { location: clean, 'cache-control': 'no-store' })
      return res.end()
    }
    door(req, res, 'ticket')
  }

  const app = new Hono<Env>().basePath(API)

  // The API only answers to this machine's own addresses, and only changes
  // anything for requests made by the site's own pages. This keeps other web
  // pages open in the same browser from reaching it.
  app.use(async (c, next) => {
    const host = c.req.header('host')
    if (!hostAllowed(host)) return c.json({ error: 'forbidden_host' }, 403)
    if (c.req.method !== 'GET' && c.req.method !== 'HEAD') {
      let sameOrigin = false
      try {
        const origin = new URL(c.req.header('origin') ?? '')
        sameOrigin = origin.host === host || origin.origin === options.address?.origin
      } catch {
        // Missing or malformed Origin.
      }
      if (!sameOrigin) return c.json({ error: 'forbidden_origin' }, 403)
    }
    await next()
  })

  // Whether the code opens this site at all, and where the door that hands out sessions is, for whoever has none.
  app.get('/session', (c) => c.json({ editor: isEditor(c.env.incoming), code: !restricted, ...(restricted && state.home ? { home: state.home } : {}) }))

  app.post('/login', async (c) => {
    if (restricted) return c.json({ error: 'no_code' }, 403)
    // The code is read first. From the count to the verdict nothing waits: requests held open and released together
    // are judged one at a time, each seeing the count the last one left.
    const body = (await c.req.json().catch(() => null)) as { code?: unknown } | null
    const who = visitor(c.env.incoming)
    if (spent(who, TRIES) || (spent(EVERYBODY, TRIES_IN_ALL) && !state.known.includes(who))) return c.json({ error: 'too_many' }, 429)

    const given = Buffer.from(normalizeCode(body?.code))
    const expected = Buffer.from(state.code)
    if (given.length !== expected.length || !timingSafeEqual(given, expected)) {
      fail(who)
      fail(EVERYBODY)
      await save()
      return c.json({ error: 'bad_code' }, 401)
    }

    delete state.failures[who]
    state.known = [...state.known.filter((visitor) => visitor !== who), who].slice(-KNOWN_VISITORS)
    const token = randomBytes(32).toString('base64url')
    state.sessions[sha256(token)] = Date.now() + SESSION_DAYS * 86_400_000
    await save()
    setCookie(c, COOKIE, token, { path: '/', httpOnly: true, sameSite: 'Lax', secure: secureFor(c.req.header('host')), maxAge: SESSION_DAYS * 86_400 })
    return c.json({ ok: true })
  })

  app.post('/logout', async (c) => {
    const token = getCookie(c, COOKIE)
    if (token) {
      delete state.sessions[sha256(token)]
      await save()
    }
    deleteCookie(c, COOKIE, { path: '/' })
    return c.json({ ok: true })
  })

  // Each open editor's sign of life, which tells whether the artist did anything since the last one. The answer
  // carries what the door has to say: the time left is counted here, the artist's clock may be wrong.
  // With unsaved changes it also carries them, as drafts: see `drafted` in the presence.
  app.post('/presence', guard, async (c) => {
    const body = (await c.req.json().catch(() => null)) as { dirty?: unknown; active?: unknown; drafts?: unknown } | null
    const token = getCookie(c, COOKIE)
    const dirty = body?.dirty === true
    const drafted = keepDrafts(body?.drafts)
    editors.set(token ? sha256(token) : 'this machine', { at: Date.now(), dirty, drafted: !dirty || drafted })
    if (body?.active === true) touch()
    if (notice?.kind === 'closing') {
      const { at, ...rest } = notice
      return c.json({ notice: { ...rest, in: Math.max(0, at - Date.now()) } })
    }
    return c.json({ notice })
  })

  // Drafts kept from earlier, offered back when the artist opens the same fields again; and let go of.
  app.get('/drafts', guard, (c) => c.json({ drafts }))
  app.post('/drafts', guard, async (c) => {
    const body = (await c.req.json().catch(() => null)) as { drop?: unknown } | null
    const drop = Array.isArray(body?.drop) ? body.drop.filter((field): field is string => typeof field === 'string') : []
    dropDrafts((draft) => drop.includes(draft))
    return c.json({ ok: true })
  })
  // A saved change replaces the draft of the same fields. Read before the change is made: the request is read once.
  app.use('/ops', async (c, next) => {
    const body = (await c.req.json().catch(() => null)) as { ops?: unknown } | null
    await next()
    if (!c.res.ok || !Array.isArray(body?.ops)) return
    for (const op of body.ops as { op?: unknown; path?: unknown }[]) {
      if ((op?.op === 'set' || op?.op === 'remove') && typeof op.path === 'string') dropDrafts((draft) => overlaps(op.path as string, draft))
    }
  })

  // The door alone, with its key. To anyone else these do not exist.
  app.get('/door', (c) => (fromDoor(c.env.incoming) ? c.json(presence()) : c.json({ error: 'not_found' }, 404)))
  app.post('/door', async (c) => {
    if (!fromDoor(c.env.incoming)) return c.json({ error: 'not_found' }, 404)
    const body = (await c.req.json().catch(() => null)) as { notice?: Notice | null; grant?: { ms?: unknown; home?: unknown } } | null
    if (body?.grant) {
      // A session for whoever the door sends here next, for `ms`, entered through the ticket returned. Every other
      // session ends: the site is theirs alone.
      const ms = Number(body.grant.ms)
      if (!Number.isFinite(ms) || ms <= 0 || ms > LONGEST_SESSION) return c.json({ error: 'invalid' }, 400)
      const now = Date.now()
      state.sessions = {}
      tickets.clear()
      editors.clear()
      notice = null
      mediaSpent = 0
      const home = body.grant.home
      if (typeof home === 'string' && /^https?:\/\//.test(home)) state.home = home
      // A site lent to one stranger after another: nobody finds what the last one left unsaved.
      if (restricted) dropDrafts(() => true)
      await save()
      const ticket = randomBytes(32).toString('base64url')
      tickets.set(sha256(ticket), { expires: Math.min(now + TICKET_LIFE, now + ms), until: now + ms })
      return c.json({ ticket })
    }
    notice = body?.notice ?? null
    return c.json({ ok: true })
  })

  app.get('/editor.js', async (c) => {
    const headers = { 'content-type': 'text/javascript; charset=utf-8', 'cache-control': 'no-cache' }
    try {
      return c.body(await readFile(options.editorFile), 200, headers)
    } catch {
      return c.body('console.error("foliome: the editor is not built. Run: npm run build -w @foliome/editor")', 200, headers)
    }
  })

  app.get('/config', guard, (c) =>
    c.json({
      name: options.name,
      schema: options.schema,
      publish: !!publishCommand,
      converts: { heic: !!(tools.sharp && tools.heic), tiff: !!tools.sharp },
      maxFileSize,
      restricted: !!restricted,
    }),
  )

  // Putting the site online is the developer's own command (build, then deploy),
  // started by the artist. One run at a time; the artist waits for the outcome.
  let publishing = false
  app.post('/publish', guard, async (c) => {
    if (!publishCommand) return c.json({ error: 'not_configured' }, 404)
    if (publishing) return c.json({ error: 'busy' }, 409)
    publishing = true
    try {
      await options.beforePublish?.()
      // The command must build the public site, not an editable one: it must
      // not inherit what marks this process as an editing session.
      const env = { ...process.env }
      for (const name of ['FOLIOME_EDITABLE', 'NODE_ENV']) delete env[name]
      const result = await new Promise<{ ok: boolean; log: string }>((done) => {
        let log = ''
        const keep = (chunk: Buffer) => {
          log = (log + chunk.toString()).slice(-6000)
        }
        const child = spawn(publishCommand, { cwd: options.root, env, shell: true })
        child.stdout.on('data', keep)
        child.stderr.on('data', keep)
        child.on('error', (err) => done({ ok: false, log: `${log}\n${err.message}` }))
        child.on('close', (code) => done({ ok: code === 0, log: log.replace(/\x1b\[[0-9;]*m/g, '').trim() }))
      })
      return c.json(result)
    } finally {
      publishing = false
    }
  })
  app.route('/', createApp({ storage, guard: guard as MiddlewareHandler, maxUploadBytes: maxFileSize }))

  const api = getRequestListener(app.fetch)

  /** Serves uploaded files straight from disk, so a file is available the instant its upload ends. */
  async function media(req: IncomingMessage, res: ServerResponse, next: (err?: unknown) => void) {
    const pathname = (req.url ?? '').split('?')[0] ?? ''
    if ((req.method !== 'GET' && req.method !== 'HEAD') || !pathname.startsWith(`${MEDIA}/`)) return next()

    let relative: string
    try {
      relative = decodeURIComponent(pathname.slice(MEDIA.length + 1))
    } catch {
      return next()
    }
    const file = path.resolve(mediaDir, relative)
    if (!file.startsWith(mediaDir + path.sep)) return next()
    const info = await stat(file).catch(() => null)
    if (!info?.isFile()) return next()

    const headers: Record<string, string> = {
      'content-type': mimeOf(file),
      'accept-ranges': 'bytes',
      'cache-control': 'no-cache',
      'x-content-type-options': 'nosniff',
    }
    let start = 0
    let end = info.size - 1
    let status = 200
    // Video and audio players seek by asking for byte ranges.
    const range = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range ?? '')
    if (range && (range[1] || range[2])) {
      if (range[1]) {
        start = Number(range[1])
        if (range[2]) end = Math.min(end, Number(range[2]))
      } else {
        start = Math.max(0, info.size - Number(range[2]))
      }
      if (start > end) {
        res.writeHead(416, { 'content-range': `bytes */${info.size}` })
        return res.end()
      }
      status = 206
      headers['content-range'] = `bytes ${start}-${end}/${info.size}`
    }
    headers['content-length'] = String(Math.max(0, end - start + 1))
    res.writeHead(status, headers)
    if (req.method === 'HEAD' || info.size === 0) return res.end()
    createReadStream(file, { start, end })
      .on('error', () => res.destroy())
      .pipe(res)
  }

  return {
    code: state.code,
    tools,
    /** Whether a request comes from someone who may see the site. */
    allows: isEditor,
    /** Writes down the drafts not yet on disk: called when the server stops. */
    close: () => (draftsTimer ? writeDrafts() : draftsWriting),
    /** The first thing a request meets, ahead of anything the dev server would answer by itself. */
    gate(req: IncomingMessage, res: ServerResponse, next: (err?: unknown) => void) {
      const url = req.url ?? ''
      // Lent to strangers: nothing of it belongs in a search engine.
      if (restricted) res.setHeader('x-robots-tag', 'noindex, nofollow')
      // The API answers for itself: signing in is open to all, the rest is guarded route by route.
      if (isApi(url)) return next()
      // Only the door hands out tickets: without its key there are none, and the parameter is the site's own business.
      if (options.doorKey && req.method === 'GET' && url.includes('ticket=')) {
        const parsed = new URL(url, 'http://site')
        const ticket = parsed.searchParams.get('ticket')
        if (ticket) return void exchange(req, res, parsed, ticket).catch(next)
      }
      if (!isEditor(req)) return door(req, res)
      if (isPrivate(url)) return void res.writeHead(404).end()
      next()
    },
    middleware(req: IncomingMessage, res: ServerResponse, next: (err?: unknown) => void) {
      const url = req.url ?? ''
      // Whatever the artist asks for is activity, the door's questions and the editor's signs of life excepted. A
      // request is under way until its answer has gone: a long upload ends with activity too.
      const counts = isEditor(req) && !/^\/_foliome\/(presence|door)([?/]|$)/.test(url)
      if (counts) touch()
      if (!isApi(url)) return void media(req, res, next).catch(next)
      if (counts) {
        inFlight++
        res.once('close', () => {
          inFlight--
          touch()
        })
      }
      api(req, res)
    },
  }
}
