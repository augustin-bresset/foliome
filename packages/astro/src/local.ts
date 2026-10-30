import { spawn } from 'node:child_process'
import { createHash, randomBytes, randomInt, timingSafeEqual } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { isIP } from 'node:net'
import path from 'node:path'
import { mimeOf, type Schema } from '@foliome/core'
import { createApp, type Storage } from '@foliome/server'
import { fsStorage } from '@foliome/server/fs'
import { detectTools } from '@foliome/server/media'
import { getRequestListener, type HttpBindings } from '@hono/node-server'
import { Hono, type MiddlewareHandler } from 'hono'
import { deleteCookie, getCookie, setCookie } from 'hono/cookie'
import { parse } from 'hono/utils/cookie'

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
  /** Called after every stored change. */
  onChange: () => void
}

interface State {
  code: string
  /** sha256(session token) → expiry timestamp */
  sessions: Record<string, number>
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

async function loadState(file: string): Promise<State> {
  let state: State = { code: newCode(), sessions: {} }
  try {
    const saved = JSON.parse(await readFile(file, 'utf8')) as Partial<State>
    if (typeof saved.code === 'string' && saved.code.length === 8) {
      state = { code: saved.code, sessions: saved.sessions ?? {} }
    }
  } catch {
    // First run, or an unreadable file: start fresh.
  }
  const now = Date.now()
  for (const [hash, expires] of Object.entries(state.sessions)) if (expires < now) delete state.sessions[hash]
  await mkdir(path.dirname(file), { recursive: true })
  await writeFile(file, JSON.stringify(state, null, 2))
  return state
}

export async function createLocal(options: LocalOptions) {
  const dir = path.join(options.root, '.foliome')
  const stateFile = path.join(dir, 'local.json')
  const mediaDir = path.join(options.root, 'public', 'media')
  const state = await loadState(stateFile)
  const save = () => writeFile(stateFile, JSON.stringify(state, null, 2))

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

  const guard: MiddlewareHandler<Env> = async (c, next) => {
    if (!isEditor(c.env.incoming)) return c.json({ error: 'unauthorized' }, 401)
    await next()
  }

  // Wrong codes are counted per visitor, so that one who guesses does not shut the door on the artist, and for
  // everybody together, since a visitor behind a tunnel is only who the tunnel says they are.
  const failures = new Map<string, { count: number; resetAt: number }>()
  const spent = (who: string, most: number) => {
    const record = failures.get(who)
    return !!record && record.resetAt > Date.now() && record.count >= most
  }
  const fail = (who: string) => {
    const now = Date.now()
    for (const [key, record] of failures) if (record.resetAt <= now) failures.delete(key)
    const record = failures.get(who)
    failures.set(who, record ? { ...record, count: record.count + 1 } : { count: 1, resetAt: now + 5 * 60_000 })
  }
  const visitor = (req: IncomingMessage) => {
    const through = options.address && String(req.headers['x-forwarded-for'] ?? '').split(',')[0]?.trim()
    return through || (req.socket.remoteAddress ?? 'unknown')
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

  // Whoever has not signed in is given one page, which asks for the code: the editor shows its prompt on it.
  const doorPage = `<!doctype html><html lang="fr" data-foliome-door><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex"><link rel="icon" href="data:,"><title>${escapeHtml(options.name)}</title><style>html{background:#f2f2f5}</style></head><body><script src="${API}/editor.js"></script></body></html>`
  const door = (req: IncomingMessage, res: ServerResponse) => {
    const page = req.method === 'GET' && (req.headers.accept ?? '').includes('text/html')
    res.writeHead(401, {
      'content-type': `${page ? 'text/html' : 'text/plain'}; charset=utf-8`,
      'cache-control': 'no-store',
      'x-robots-tag': 'noindex',
    })
    res.end(page ? doorPage : 'unauthorized')
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

  app.get('/session', (c) => c.json({ editor: isEditor(c.env.incoming) }))

  app.post('/login', async (c) => {
    const who = visitor(c.env.incoming)
    if (spent(who, TRIES) || spent(EVERYBODY, TRIES_IN_ALL)) return c.json({ error: 'too_many' }, 429)

    const body = (await c.req.json().catch(() => null)) as { code?: unknown } | null
    const given = Buffer.from(normalizeCode(body?.code))
    const expected = Buffer.from(state.code)
    if (given.length !== expected.length || !timingSafeEqual(given, expected)) {
      fail(who)
      fail(EVERYBODY)
      return c.json({ error: 'bad_code' }, 401)
    }

    failures.delete(who)
    const token = randomBytes(32).toString('base64url')
    state.sessions[sha256(token)] = Date.now() + SESSION_DAYS * 86_400_000
    await save()
    // Over the public address the cookie only ever travels encrypted.
    const secure = options.address?.protocol === 'https:' && hostName(c.req.header('host')) === options.address.hostname
    setCookie(c, COOKIE, token, { path: '/', httpOnly: true, sameSite: 'Lax', secure, maxAge: SESSION_DAYS * 86_400 })
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
      publish: !!options.publish,
      converts: { heic: !!(tools.sharp && tools.heic), tiff: !!tools.sharp },
    }),
  )

  // Putting the site online is the developer's own command (build, then deploy),
  // started by the artist. One run at a time; the artist waits for the outcome.
  let publishing = false
  app.post('/publish', guard, async (c) => {
    if (!options.publish) return c.json({ error: 'not_configured' }, 404)
    if (publishing) return c.json({ error: 'busy' }, 409)
    publishing = true
    try {
      // The command must build the public site, not an editable one: it must
      // not inherit what marks this process as an editing session.
      const env = { ...process.env }
      for (const name of ['FOLIOME_EDITABLE', 'NODE_ENV']) delete env[name]
      const result = await new Promise<{ ok: boolean; log: string }>((done) => {
        let log = ''
        const keep = (chunk: Buffer) => {
          log = (log + chunk.toString()).slice(-6000)
        }
        const child = spawn(options.publish!, { cwd: options.root, env, shell: true })
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
  app.route('/', createApp({ storage, guard: guard as MiddlewareHandler }))

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
    /** The first thing a request meets, ahead of anything the dev server would answer by itself. */
    gate(req: IncomingMessage, res: ServerResponse, next: (err?: unknown) => void) {
      const url = req.url ?? ''
      // The API answers for itself: signing in is open to all, the rest is guarded route by route.
      if (isApi(url)) return next()
      if (!isEditor(req)) return door(req, res)
      if (isPrivate(url)) return void res.writeHead(404).end()
      next()
    },
    middleware(req: IncomingMessage, res: ServerResponse, next: (err?: unknown) => void) {
      if (isApi(req.url ?? '')) return void api(req, res)
      media(req, res, next).catch(next)
    },
  }
}
