import { request, type IncomingMessage, type ServerResponse } from 'node:http'

/**
 * The one address artists remember: they give their code on the home page, and are sent to their own site. The door
 * holds no code and counts nothing: each site's own sign-in judges the code, with its own limits. A try costs one on
 * every site, so that having many sites gives a stranger no more guesses than one.
 */

export interface DoorOptions {
  /** Where the home page is served from: nothing else may ask. */
  home: string
  /** Each site's public name, and the local port its editing server listens on. */
  sites: Record<string, number>
}

const ROUTE = '/entrer'
const API = '/_foliome'
const LONGEST_BODY = 1024

interface Reply {
  status: number
  cookie?: string
}

/** Calls a site's editing server as the visitor would, through its public name. */
const call = (name: string, port: number, path: string, headers: Record<string, string>, body: string) =>
  new Promise<Reply>((done, fail) => {
    const req = request(
      {
        host: '127.0.0.1',
        port,
        path: `${API}${path}`,
        method: 'POST',
        headers: { host: name, origin: `https://${name}`, 'content-type': 'application/json', 'content-length': Buffer.byteLength(body), ...headers },
      },
      (res) => {
        res.resume()
        res.on('end', () => done({ status: res.statusCode ?? 0, cookie: res.headers['set-cookie']?.[0]?.split(';')[0] }))
      },
    )
    req.on('error', fail)
    req.end(body)
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

export function door({ home, sites }: DoorOptions) {
  return async (req: IncomingMessage, res: ServerResponse) => {
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
    const visitor = String(req.headers['x-forwarded-for'] ?? '').split(',')[0]?.trim() || (req.socket.remoteAddress ?? 'unknown')
    const headers = { 'x-forwarded-for': visitor }
    let exhausted = false
    let unreachable = false
    for (const [name, port] of Object.entries(sites)) {
      const reply = await call(name, port, '/login', headers, JSON.stringify({ code })).catch(() => null)
      if (!reply) unreachable = true
      else if (reply.status === 429) exhausted = true
      else if (reply.status === 200) {
        // This session was only the question: the visitor's own browser opens its own with the link.
        await call(name, port, '/logout', { ...headers, cookie: reply.cookie ?? '' }, '{}').catch(() => {})
        return answer(200, { url: `https://${name}/?edit=${encodeURIComponent(code)}` })
      }
    }
    if (exhausted) return answer(429, { error: 'too_many' })
    return unreachable ? answer(503, { error: 'unreachable' }) : answer(401, { error: 'bad_code' })
  }
}
