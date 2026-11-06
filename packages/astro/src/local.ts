import { spawn } from 'node:child_process'
import { createHash, randomBytes, randomInt, timingSafeEqual } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { isIP } from 'node:net'
import path from 'node:path'
import { mimeOf, misfits, type Schema } from '@foliome/core'
import { createApp, type Storage, TooLargeError } from '@foliome/server'
import { fsStorage } from '@foliome/server/fs'
import { detectTools } from '@foliome/server/media'
import { getRequestListener, type HttpBindings } from '@hono/node-server'
import { Hono, type MiddlewareHandler } from 'hono'
import { deleteCookie, getCookie, setCookie } from 'hono/cookie'
import { parse, serialize } from 'hono/utils/cookie'
import type { Restored, Unfit } from './git.ts'

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
   * Shared with the host that runs this editing server, when there is one: it asks with this key how the server is
   * used, hands out sessions and speaks to the artists through `/_foliome/host` (see `HostStatus` and `HostNotice`).
   * Unset, nobody can ask.
   */
  hostKey?: string
  /** Largest file the artist may send, in bytes. Unset: 2 GB. */
  maxFileSize?: number
  /**
   * For a site lent to strangers, a public demo for instance. Nobody enters with the access code, only through a
   * one-time ticket the host hands out, for a session as long as the host decided. Nothing is published, pages are
   * kept out of search engines, and `mediaBudget` bytes of files may be sent in a session, in all.
   */
  restricted?: { mediaBudget?: number }
  /**
   * Brings the content back as it was at an earlier commit, judged first by `check` (see `contentHistory`). Given when
   * the content is kept in git: the host can then ask for it, at `POST /_foliome/host/restore`.
   */
  restore?: (commit: string, check: () => Promise<Unfit | null>) => Promise<Restored>
}

/** One editor open on this server, as the host sees it. */
export interface HostSession {
  /** Stands for the session in what the host says to it. `local` is the developer's own browser. */
  id: string
  /** Milliseconds since its editor last gave a sign of life. */
  seen: number
  /** Milliseconds since the artist last did anything in it. */
  idle: number
  /** Its panel holds changes not saved yet. */
  dirty: boolean
  /** Whatever it holds unsaved has reached this server as rescue drafts. */
  drafted: boolean
}

/** How this editing server is being used, for the host: `GET /_foliome/host`. */
export interface HostStatus {
  /** Milliseconds since the artist last did anything, in any session. */
  idle: number
  /** An open panel holds changes the artist has not saved. */
  dirty: boolean
  /** Editors open on this server, judged by their recent signs of life. */
  editors: number
  /** A request is under way, an upload or a publish: closing now would cut it. */
  busy: boolean
  /** Every unsaved change an open editor holds has reached this server as a draft: closing would lose nothing. */
  drafted: boolean
  /** Files being sent right now. */
  uploads: number
  /** The site is being put online. */
  publishing: boolean
  /** The content is being brought back to an earlier version. */
  restoring: boolean
  sessions: HostSession[]
}

/** Words for the artist: one text, or one per language (`fr`, `en`…), of which the editor shows the artist's own. */
export type HostText = string | Record<string, string>

/** A button under a notice. Without `href` or `do`, it puts the notice away. */
export interface HostAction {
  label: HostText
  /** `dismiss` puts the notice away and tells the server the artist is there; `reload` loads the page again. */
  do?: 'dismiss' | 'reload'
  /** Goes there instead. */
  href?: string
}

/**
 * Anything the host has to tell the artists, shown by the editor as it is given: Foliome gives it no meaning of its
 * own. Sent to every editor or to one session, at `POST /_foliome/host/notice`.
 */
export interface HostNotice {
  text: HostText
  /** How it looks. `info` unless said. */
  level?: 'info' | 'warning' | 'error'
  /** A countdown, in milliseconds from now: `{countdown}` in the text shows the time left, kept up to date. */
  in?: number
  actions?: HostAction[]
  /** The session is over: the editor stops asking the server anything, and shows only this. */
  final?: boolean
  /** Goes away as soon as the artist does anything: a word about their absence, say. */
  untilActive?: boolean
}

/** A notice as kept here: its countdown on this server's clock. */
type Kept = Omit<HostNotice, 'in'> & { until?: number }
/** What the host said to all, or to one session: shown now, and shown should the session end without another word. */
type Said = { notice?: Kept | null; farewell?: Kept | null }

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
  /** Where the host that grants sessions sends people back to, given with its last grant. */
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
/** The developer's own browser, as a session. */
const LOCAL = 'local'
/** An editor gives a sign of life every thirty seconds: one missed is allowed. */
const ALIVE = 75_000
/** A ticket from the host is for someone being sent here right away. */
const TICKET_LIFE = 2 * 60_000
const LONGEST_SESSION = SESSION_DAYS * 86_400_000
/** A closed session is told so if its editor calls in within a day. */
const ENDED_LIFE = 86_400_000
const DRAFT_PATH = /^[\w-]+(\.[\w-]+)*$/
/** What one sign of life may bring as drafts, in all: far more than any text typed by hand. */
const DRAFTS_SIZE = 512 * 1024
const MAX_FILE = 2 * 1024 ** 3
/** What open editors are told after a restore, unless the host gives its own words. */
const RESTORED: HostNotice = {
  text: {
    fr: 'Le contenu du site vient de revenir à une version précédente. Rechargez la page pour la voir et la modifier.',
    en: 'The site’s content has just gone back to an earlier version. Reload the page to see and edit it.',
  },
  actions: [{ label: { fr: 'Recharger', en: 'Reload' }, do: 'reload' }],
}
/** What open editors are told when the host gives the site a new code, unless it gives its own words. */
const RECODED: HostNotice = {
  text: {
    fr: 'Le code d’accès de ce site vient de changer. Entrez le nouveau code pour continuer.',
    en: 'This site’s access code has just changed. Enter the new code to go on.',
  },
  actions: [{ label: { fr: 'Recharger', en: 'Reload' }, do: 'reload' }],
}

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

const LEVELS = new Set(['info', 'warning', 'error'])
const DOES = new Set(['dismiss', 'reload'])
const LONGEST_TEXT = 2000
const isText = (text: unknown): text is HostText =>
  typeof text === 'string'
    ? text.length <= LONGEST_TEXT
    : typeof text === 'object' && text !== null && !Array.isArray(text) && Object.keys(text).length > 0 && Object.values(text).every((one) => typeof one === 'string' && one.length <= LONGEST_TEXT)
const isAction = (action: unknown): action is HostAction => {
  if (typeof action !== 'object' || action === null) return false
  const { label, do: does, href } = action as Record<string, unknown>
  return isText(label) && (does === undefined || DOES.has(String(does))) && (href === undefined || (typeof href === 'string' && /^https?:\/\//.test(href)))
}

/** A notice from the host as it is kept, `null` to say nothing, or `undefined` for one that is not a notice. */
function keep(given: unknown): Kept | null | undefined {
  if (given === null) return null
  if (typeof given !== 'object' || Array.isArray(given)) return undefined
  const { text, level, in: left, actions, final, untilActive } = given as Record<string, unknown>
  if (!isText(text)) return undefined
  if (level !== undefined && !LEVELS.has(String(level))) return undefined
  if (left !== undefined && (typeof left !== 'number' || !Number.isFinite(left) || left < 0)) return undefined
  if (actions !== undefined && (!Array.isArray(actions) || actions.length > 4 || !actions.every(isAction))) return undefined
  if ((final !== undefined && typeof final !== 'boolean') || (untilActive !== undefined && typeof untilActive !== 'boolean')) return undefined
  return {
    text,
    ...(level ? { level: level as HostNotice['level'] } : {}),
    ...(left !== undefined ? { until: Date.now() + left } : {}),
    ...(actions ? { actions: (actions as HostAction[]).map(({ label, do: does, href }) => ({ label, ...(does ? { do: does } : {}), ...(href ? { href } : {}) })) } : {}),
    ...(final ? { final } : {}),
    ...(untilActive ? { untilActive } : {}),
  }
}

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

  // In a restricted session, what is sent counts against its budget, from the moment the host grants it.
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

  /** Stands for a session in what the host sees and says: a part of its hash, which leads nowhere by itself. */
  const idOf = (hash: string) => hash.slice(0, 16)
  /** The session a request comes from: its cookie's, valid or not, or the developer's own browser. */
  const sessionOf = (req: IncomingMessage) => {
    const token = parse(req.headers.cookie ?? '', COOKIE)[COOKIE]
    if (token) return idOf(sha256(token))
    return isThisMachine(req) ? LOCAL : null
  }

  // How the server is used, for the host. Kept in memory: a restart is a fresh start.
  let lastActivity = Date.now()
  let inFlight = 0
  let uploads = 0
  /** Each open editor's last sign of life, by session, whether it held unsaved changes, and whether they came as drafts. */
  const editors = new Map<string, { at: number; dirty: boolean; drafted: boolean }>()
  /** When the artist last did anything, by session. */
  const activeAt = new Map<string, number>()
  /** What the host said to every editor, and to some sessions alone, which then hear that instead. */
  let toAll: Required<Said> = { notice: null, farewell: null }
  const toOne = new Map<string, Said>()
  /** Sessions the host closed, and what they are told when their editor next calls in. */
  const ended = new Map<string, { notice: Kept | null; at: number }>()
  /**
   * One-time tickets the host handed out, by hash: until when each may be used, when its session will end, and whether
   * it opens a session alongside the others instead of in their place.
   */
  const tickets = new Map<string, { expires: number; until: number; alongside: boolean }>()
  /** When each session last read the content: one that read it before a restore shows what is no longer there. */
  const readAt = new Map<string, number>()
  /** The last restore, and what the editors that have not read the content since are told. */
  let restored: { at: number; notice: Kept } | null = null
  let restoring = false

  /** The artist did something: whatever the host said until then about their absence no longer holds. */
  const touch = (session: string | null) => {
    const now = Date.now()
    lastActivity = now
    if (session) activeAt.set(session, now)
    const awake = (said: Said) => {
      if (said.notice?.untilActive) said.notice = null
      if (said.farewell?.untilActive) said.farewell = null
    }
    awake(toAll)
    const own = session && toOne.get(session)
    if (own) awake(own)
  }
  const status = (): HostStatus => {
    const now = Date.now()
    for (const [key, beat] of editors) if (now - beat.at > ALIVE) editors.delete(key)
    const open = [...editors.entries()]
    return {
      idle: now - lastActivity,
      dirty: open.some(([, beat]) => beat.dirty),
      editors: editors.size,
      busy: inFlight > 0 || publishing || restoring,
      drafted: open.every(([, beat]) => beat.drafted),
      uploads,
      publishing,
      restoring,
      sessions: open.map(([id, beat]) => ({ id, seen: now - beat.at, idle: now - (activeAt.get(id) ?? lastActivity), dirty: beat.dirty, drafted: beat.drafted })),
    }
  }
  /** What a session is to be told: its own words if the host had any for it, else those for all. */
  const heard = (session: string) => {
    const own = toOne.get(session)
    return {
      notice: own && own.notice !== undefined ? own.notice : toAll.notice,
      farewell: own && own.farewell !== undefined ? own.farewell : toAll.farewell,
    }
  }
  /** The time left is counted here: the artist's clock may be wrong. */
  const shown = (kept: Kept | null): HostNotice | null => {
    if (!kept) return null
    const { until, ...rest } = kept
    return until === undefined ? rest : { ...rest, in: Math.max(0, until - Date.now()) }
  }
  const fromHost = (req: IncomingMessage) => {
    if (!options.hostKey) return false
    const given = Buffer.from(String(req.headers['x-foliome-host'] ?? ''))
    const expected = Buffer.from(options.hostKey)
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
  const signInPage = (why = '') =>
    `<!doctype html><html lang="fr" data-foliome-signin="${why}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex"><link rel="icon" href="data:,"><title>${escapeHtml(options.name)}</title><style>html{background:#f2f2f5}</style></head><body><script src="${API}/editor.js"></script></body></html>`
  const signIn = (req: IncomingMessage, res: ServerResponse, why = '') => {
    const page = req.method === 'GET' && (req.headers.accept ?? '').includes('text/html')
    res.writeHead(401, {
      'content-type': `${page ? 'text/html' : 'text/plain'}; charset=utf-8`,
      'cache-control': 'no-store',
      'x-robots-tag': 'noindex',
    })
    res.end(page ? signInPage(why) : 'unauthorized')
  }

  /** Over the public address the cookie only ever travels encrypted. */
  const secureFor = (host: string | undefined) => options.address?.protocol === 'https:' && hostName(host) === options.address.hostname

  /**
   * A ticket from the host, exchanged once for the session it was handed out for. The address is then cleaned of it,
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
      // The one session, whoever had one before is out; or, when the host asked, one more next to theirs.
      if (granted.alongside) state.sessions[sha256(token)] = granted.until
      else state.sessions = { [sha256(token)]: granted.until }
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
    signIn(req, res, 'ticket')
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

  // Whether the code opens this site at all, and where the host that hands out sessions is, for whoever has none.
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
  // carries what the host has to say to it: now, and should the session end without another word.
  // With unsaved changes it also carries them, as drafts: see `drafted` in the host's status.
  app.post('/presence', async (c, next) => {
    // A session the host closed hears it once, and hands over what it held unsaved: nothing of it is lost.
    const session = sessionOf(c.env.incoming)
    const end = session && ended.get(session)
    if (!end) return guard(c, next)
    const body = (await c.req.json().catch(() => null)) as { drafts?: unknown } | null
    keepDrafts(body?.drafts)
    ended.delete(session)
    return c.json({ notice: shown(end.notice), farewell: null })
  })
  app.post('/presence', async (c) => {
    const body = (await c.req.json().catch(() => null)) as { dirty?: unknown; active?: unknown; drafts?: unknown } | null
    const session = sessionOf(c.env.incoming) ?? LOCAL
    const dirty = body?.dirty === true
    const drafted = keepDrafts(body?.drafts)
    editors.set(session, { at: Date.now(), dirty, drafted: !dirty || drafted })
    if (body?.active === true) touch(session)
    const { notice, farewell } = heard(session)
    // Still showing the content as it was before a restore: nothing else matters until the page is loaded again.
    const stale = restored && (readAt.get(session) ?? 0) < restored.at ? restored.notice : null
    return c.json({ notice: shown(stale ?? notice), farewell: shown(farewell) })
  })

  // Drafts kept from earlier, offered back when the artist opens the same fields again; and let go of.
  app.get('/drafts', guard, (c) => c.json({ drafts }))
  app.post('/drafts', guard, async (c) => {
    const body = (await c.req.json().catch(() => null)) as { drop?: unknown } | null
    const drop = Array.isArray(body?.drop) ? body.drop.filter((field): field is string => typeof field === 'string') : []
    dropDrafts((draft) => drop.includes(draft))
    return c.json({ ok: true })
  })
  // While the content is being brought back, nothing else may change it.
  app.use(async (c, next) => {
    if (restoring && c.req.method !== 'GET' && c.req.method !== 'HEAD' && /^\/_foliome\/(ops|undo|assets|publish)\/?$/.test(c.req.path)) {
      return c.json({ error: 'restoring' }, 409)
    }
    await next()
  })
  app.get('/content', async (c, next) => {
    const session = sessionOf(c.env.incoming)
    if (session && isEditor(c.env.incoming)) readAt.set(session, Date.now())
    await next()
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

  // The host alone, with its key. To anyone else these do not exist.
  const host = new Hono<Env>()
  host.use(async (c, next) => {
    if (!fromHost(c.env.incoming)) return c.json({ error: 'not_found' }, 404)
    await next()
  })
  host.get('/', (c) => c.json(status()))

  host.post('/grant', async (c) => {
    // A session for whoever the host sends here next, for `ms`, entered through the ticket returned. Every other
    // session ends: the site is theirs alone. With `alongside`, the others stay open: the host lets someone of its
    // own in next to the artist. A site lent to strangers is always one visitor's alone.
    const body = (await c.req.json().catch(() => null)) as { ms?: unknown; home?: unknown; alongside?: unknown } | null
    const ms = Number(body?.ms)
    if (!Number.isFinite(ms) || ms <= 0 || ms > LONGEST_SESSION) return c.json({ error: 'invalid' }, 400)
    if (body?.alongside !== undefined && typeof body.alongside !== 'boolean') return c.json({ error: 'invalid' }, 400)
    const alongside = body?.alongside === true && !restricted
    const now = Date.now()
    if (!alongside) {
      state.sessions = {}
      tickets.clear()
      editors.clear()
      activeAt.clear()
      toAll = { notice: null, farewell: null }
      toOne.clear()
      ended.clear()
      mediaSpent = 0
    }
    const home = body?.home
    if (typeof home === 'string' && /^https?:\/\//.test(home)) state.home = home
    // A site lent to one stranger after another: nobody finds what the last one left unsaved.
    if (restricted) dropDrafts(() => true)
    await save()
    const ticket = randomBytes(32).toString('base64url')
    tickets.set(sha256(ticket), { expires: Math.min(now + TICKET_LIFE, now + ms), until: now + ms, alongside })
    return c.json({ ticket })
  })

  /** Whether a session the host names is one this server knows: signed in, or with an editor open. */
  const known = (session: string) => editors.has(session) || Object.keys(state.sessions).some((hash) => idOf(hash) === session)

  host.post('/notice', async (c) => {
    const body = (await c.req.json().catch(() => null)) as { notice?: unknown; farewell?: unknown; to?: unknown } | null
    const said: Said = {}
    for (const field of ['notice', 'farewell'] as const) {
      if (body?.[field] === undefined) continue
      const kept = keep(body[field])
      if (kept === undefined) return c.json({ error: 'invalid', field }, 400)
      said[field] = kept
    }
    const to = body?.to
    if (to !== undefined) {
      if (typeof to !== 'string' || !known(to)) return c.json({ error: 'no_session' }, 404)
      toOne.set(to, { ...toOne.get(to), ...said })
      return c.json({ ok: true })
    }
    // Words for all replace whatever each session was told alone.
    toAll = { ...toAll, ...said }
    for (const own of toOne.values()) for (const field of Object.keys(said) as (keyof Said)[]) delete own[field]
    return c.json({ ok: true })
  })

  /**
   * Ends the session `to`, or every one but the developer's own browser. Each editor, when it next calls in, hands over
   * what it holds unsaved as rescue drafts, and is told `notice`; until then, what it last sent is kept already.
   */
  async function closeSessions(to: string | undefined, notice: Kept | null) {
    const now = Date.now()
    const closing = new Set([...Object.keys(state.sessions).map(idOf), ...editors.keys()].filter((session) => session !== LOCAL && (to === undefined || session === to)))
    let drafted = true
    for (const session of closing) {
      for (const hash of Object.keys(state.sessions)) if (idOf(hash) === session) delete state.sessions[hash]
      const beat = editors.get(session)
      if (beat && !beat.drafted) drafted = false
      editors.delete(session)
      activeAt.delete(session)
      toOne.delete(session)
      ended.set(session, { notice: notice && { ...notice, final: true }, at: now })
    }
    for (const [session, end] of ended) if (now - end.at > ENDED_LIFE) ended.delete(session)
    await save()
    return { closed: closing.size, drafted }
  }

  host.post('/close', async (c) => {
    // The session ends here and now (see `closeSessions`).
    const body = (await c.req.json().catch(() => null)) as { to?: unknown; notice?: unknown } | null
    const to = body?.to
    if (to !== undefined && (typeof to !== 'string' || !known(to))) return c.json({ error: 'no_session' }, 404)
    const notice = body?.notice === undefined ? null : keep(body.notice)
    if (notice === undefined) return c.json({ error: 'invalid', field: 'notice' }, 400)
    return c.json({ ok: true, ...(await closeSessions(to as string | undefined, notice)) })
  })

  // A new access code, made here like the first one: the old one opens nothing any more, and every session it opened
  // ends, tickets not used yet with them. The host is given the new code, to hand to the artist.
  host.post('/code', async (c) => {
    const body = (await c.req.json().catch(() => null)) as { notice?: unknown } | null
    if (restricted) return c.json({ error: 'restricted' }, 409)
    const notice = body?.notice === undefined ? keep(RECODED) : keep(body.notice)
    if (!notice) return c.json({ error: 'invalid', field: 'notice' }, 400)
    if (restoring) return c.json({ error: 'restoring' }, 409)
    if (publishing) return c.json({ error: 'publishing' }, 409)
    if (status().uploads > 0) return c.json({ error: 'uploading' }, 409)
    let code = newCode()
    while (code === state.code) code = newCode()
    state.code = code
    tickets.clear()
    const { closed, drafted } = await closeSessions(undefined, notice)
    return c.json({ ok: true, code, closed, drafted })
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
  /** Runs the publish command, once at a time: the caller has checked that nothing else is being published. */
  async function publish(before?: () => Promise<unknown>) {
    publishing = true
    try {
      await before?.()
      // The command must build the public site, not an editable one: it must
      // not inherit what marks this process as an editing session.
      const env = { ...process.env }
      for (const name of ['FOLIOME_EDITABLE', 'NODE_ENV']) delete env[name]
      return await new Promise<{ ok: boolean; log: string }>((done) => {
        let log = ''
        const keep = (chunk: Buffer) => {
          log = (log + chunk.toString()).slice(-6000)
        }
        const child = spawn(publishCommand!, { cwd: options.root, env, shell: true })
        child.stdout.on('data', keep)
        child.stderr.on('data', keep)
        child.on('error', (err) => done({ ok: false, log: `${log}\n${err.message}` }))
        child.on('close', (code) => done({ ok: code === 0, log: log.replace(/\x1b\[[0-9;]*m/g, '').trim() }))
      })
    } finally {
      publishing = false
    }
  }
  app.post('/publish', guard, async (c) => {
    if (!publishCommand) return c.json({ error: 'not_configured' }, 404)
    if (publishing) return c.json({ error: 'busy' }, 409)
    return c.json(await publish(options.beforePublish))
  })

  // The host brings the content back to an earlier commit, and puts the site online as it was then. Refused while
  // the artist holds unsaved changes or something is under way; nothing changes when the old content does not fit.
  host.post('/restore', async (c) => {
    const body = (await c.req.json().catch(() => null)) as { commit?: unknown; notice?: unknown } | null
    if (!options.restore) return c.json({ error: 'not_configured' }, 404)
    const commit = body?.commit
    if (typeof commit !== 'string') return c.json({ error: 'bad_commit' }, 400)
    const notice = body?.notice === undefined ? keep(RESTORED) : keep(body.notice)
    if (!notice) return c.json({ error: 'invalid', field: 'notice' }, 400)
    if (restoring) return c.json({ error: 'restoring' }, 409)
    if (publishing) return c.json({ error: 'publishing' }, 409)
    const now = status()
    if (now.uploads > 0) return c.json({ error: 'uploading' }, 409)
    if (now.dirty) return c.json({ error: 'editing' }, 409)
    restoring = true
    try {
      const outcome = await options.restore(commit, async () => {
        let doc: unknown = {}
        try {
          doc = JSON.parse(await readFile(path.join(options.root, 'content', 'content.json'), 'utf8'))
        } catch (err) {
          if ((err as NodeJS.ErrnoException).code !== 'ENOENT') return { error: 'misfit', detail: 'content/content.json' }
        }
        const wrong = misfits(options.schema.content, doc)
        if (wrong.length) return { error: 'misfit', detail: wrong.slice(0, 20).join(', ') }
        // The build says whether the site can still be made from it, and the site goes online as it was.
        if (!publishCommand) return null
        const built = await publish()
        return built.ok ? null : { error: 'build', detail: built.log }
      })
      if (!outcome.ok) {
        const status = outcome.error === 'bad_commit' || outcome.error === 'unknown_commit' ? 400 : outcome.error === 'unchanged' ? 409 : 422
        return c.json(outcome, status)
      }
      // Undoing would bring back a content file whose files are gone: the earlier versions are in git now.
      await rm(path.join(dir, 'history'), { recursive: true, force: true })
      restored = { at: Date.now(), notice }
      return c.json(outcome)
    } catch (err) {
      return c.json({ ok: false, error: 'failed', detail: err instanceof Error ? err.message.trim() : String(err) }, 500)
    } finally {
      restoring = false
      // The pages are rendered again from what is on disk now, whatever it is.
      options.onChange()
    }
  })
  app.route('/host', host)
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
    /** The access code as it is now: the host may give the site a new one (`POST /_foliome/host/code`). */
    get code() {
      return state.code
    },
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
      // Only the host hands out tickets: without its key there are none, and the parameter is the site's own business.
      if (options.hostKey && req.method === 'GET' && url.includes('ticket=')) {
        const parsed = new URL(url, 'http://site')
        const ticket = parsed.searchParams.get('ticket')
        if (ticket) return void exchange(req, res, parsed, ticket).catch(next)
      }
      if (!isEditor(req)) return signIn(req, res)
      if (isPrivate(url)) return void res.writeHead(404).end()
      next()
    },
    middleware(req: IncomingMessage, res: ServerResponse, next: (err?: unknown) => void) {
      const url = req.url ?? ''
      // Whatever the artist asks for is activity, the host's questions and the editor's signs of life excepted. A
      // request is under way until its answer has gone: a long upload ends with activity too.
      const counts = isEditor(req) && !/^\/_foliome\/(presence|host)([?/]|$)/.test(url)
      const session = counts ? sessionOf(req) : null
      if (counts) touch(session)
      if (!isApi(url)) return void media(req, res, next).catch(next)
      if (counts) {
        const upload = req.method === 'PUT' && /^\/_foliome\/assets([?/]|$)/.test(url)
        inFlight++
        if (upload) uploads++
        res.once('close', () => {
          inFlight--
          if (upload) uploads--
          touch(session)
        })
      }
      api(req, res)
    },
  }
}
