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
import { type Context, Hono, type MiddlewareHandler } from 'hono'
import { deleteCookie, getCookie, setCookie } from 'hono/cookie'

/**
 * Local editing: the site's dev server doubles as the editing service.
 * Content is written to `content/content.json`, files to `public/media/`.
 * The developer's own browser is trusted; anyone else on the network needs
 * the access code.
 */

export interface LocalOptions {
  root: string
  name: string
  schema: Schema
  allowedHosts: string[]
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

// No I, L, O, 0 or 1: the code is read aloud and typed by hand.
const ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'
const newCode = () => Array.from({ length: 8 }, () => ALPHABET[randomInt(ALPHABET.length)]).join('')
export const formatCode = (code: string) => `${code.slice(0, 4)}-${code.slice(4)}`
const normalizeCode = (input: unknown) => String(input ?? '').toUpperCase().replace(/[^A-Z0-9]/g, '')

const sha256 = (text: string) => createHash('sha256').update(text).digest('hex')
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
      options.allowedHosts.includes(name)
    )
  }

  /** The developer's own browser: a direct connection from this machine to a loopback address. */
  const isThisMachine = (c: Context<Env>) =>
    LOOPBACK_ADDRESSES.has(c.env.incoming.socket.remoteAddress ?? '') &&
    LOOPBACK_HOSTS.has(hostName(c.req.header('host'))) &&
    !c.req.header('x-forwarded-for') &&
    !c.req.header('forwarded')

  const isEditor = (c: Context<Env>) => {
    const token = getCookie(c, COOKIE)
    if (token && (state.sessions[sha256(token)] ?? 0) > Date.now()) return true
    return isThisMachine(c)
  }

  const guard: MiddlewareHandler<Env> = async (c, next) => {
    if (!isEditor(c)) return c.json({ error: 'unauthorized' }, 401)
    await next()
  }

  const failures = new Map<string, { count: number; resetAt: number }>()

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
        sameOrigin = new URL(c.req.header('origin') ?? '').host === host
      } catch {
        // Missing or malformed Origin.
      }
      if (!sameOrigin) return c.json({ error: 'forbidden_origin' }, 403)
    }
    await next()
  })

  app.get('/session', (c) => c.json({ editor: isEditor(c) }))

  app.post('/login', async (c) => {
    const ip = c.env.incoming.socket.remoteAddress ?? 'unknown'
    const now = Date.now()
    const record = failures.get(ip)
    if (record && record.resetAt > now && record.count >= 8) return c.json({ error: 'too_many' }, 429)

    const body = (await c.req.json().catch(() => null)) as { code?: unknown } | null
    const given = Buffer.from(normalizeCode(body?.code))
    const expected = Buffer.from(state.code)
    if (given.length !== expected.length || !timingSafeEqual(given, expected)) {
      failures.set(ip, record && record.resetAt > now ? { ...record, count: record.count + 1 } : { count: 1, resetAt: now + 5 * 60_000 })
      return c.json({ error: 'bad_code' }, 401)
    }

    failures.delete(ip)
    const token = randomBytes(32).toString('base64url')
    state.sessions[sha256(token)] = now + SESSION_DAYS * 86_400_000
    await save()
    setCookie(c, COOKIE, token, { path: '/', httpOnly: true, sameSite: 'Lax', maxAge: SESSION_DAYS * 86_400 })
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
    middleware(req: IncomingMessage, res: ServerResponse, next: (err?: unknown) => void) {
      const url = req.url ?? ''
      if (url === API || url.startsWith(`${API}/`)) return void api(req, res)
      media(req, res, next).catch(next)
    },
  }
}
