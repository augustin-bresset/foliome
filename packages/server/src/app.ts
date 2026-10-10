import { applyOps, type Asset, extOf, kindOf, mimeOf, newId, type Op, OpError, safeFileName } from '@foliome/core'
import { Hono, type MiddlewareHandler } from 'hono'
import { type Storage, TooLargeError } from './storage.ts'

export interface AppOptions {
  storage: Storage
  /** Rejects any request that does not come from an editor. */
  guard: MiddlewareHandler
  maxUploadBytes?: number
}

const dimension = (value: string | undefined, max: number): number | undefined => {
  const n = Number(value)
  return Number.isFinite(n) && n > 0 && n <= max ? Math.round(n * 1000) / 1000 : undefined
}

/** The editing API: read the content, change it, undo, upload files. Storage and access control are provided by the host. */
export function createApp({ storage, guard, maxUploadBytes = 2 * 1024 ** 3 }: AppOptions): Hono {
  const app = new Hono()

  app.get('/content', guard, async (c) => c.json({ content: await storage.read(), canUndo: await storage.canUndo() }))

  app.post('/ops', guard, async (c) => {
    const body = (await c.req.json().catch(() => null)) as { ops?: unknown } | null
    const ops = body?.ops
    if (!Array.isArray(ops) || ops.length === 0 || ops.length > 200) return c.json({ error: 'invalid_ops' }, 400)
    try {
      await storage.update((doc) => applyOps(doc, ops as Op[]))
    } catch (err) {
      if (err instanceof OpError) return c.json({ error: 'invalid_ops', message: err.message }, 400)
      throw err
    }
    return c.json({ ok: true })
  })

  app.post('/undo', guard, async (c) => c.json({ ok: await storage.undo() }))

  app.put('/assets', guard, async (c) => {
    const name = (c.req.query('name') ?? '').slice(0, 200) || 'fichier'
    const body = c.req.raw.body
    if (!body) return c.json({ error: 'empty' }, 400)

    const id = newId('a')
    const safeName = safeFileName(name)
    let stored
    try {
      stored = await storage.putFile(id, safeName, body, maxUploadBytes)
    } catch (err) {
      if (err instanceof TooLargeError) return c.json({ error: 'too_large', maxBytes: maxUploadBytes }, 413)
      throw err
    }

    const mime = mimeOf(name, c.req.header('content-type'))
    const asset: Asset = { id, path: stored.path, name, mime, size: stored.size, kind: kindOf(mime, name) }
    // Measured by the browser; replaced below when the file is prepared on the server.
    const width = dimension(c.req.query('width'), 100_000)
    const height = dimension(c.req.query('height'), 100_000)
    const duration = dimension(c.req.query('duration'), 1_000_000)
    if (width && height) Object.assign(asset, { width, height })
    if (duration) asset.duration = duration

    if (storage.prepare) {
      try {
        const { name: preparedName, ...prepared } = await storage.prepare(id, safeName)
        Object.assign(asset, prepared)
        // The artist's own file name stays; only its extension follows a change of format (HEIC to JPEG, MOV to MP4).
        const ext = extOf(name)
        if (preparedName && extOf(preparedName) !== ext) asset.name = `${ext ? name.slice(0, -(ext.length + 1)) : name}.${extOf(preparedName)}`
        asset.kind = kindOf(asset.mime, asset.name)
      } catch (err) {
        console.warn(`foliome: ${name} could not be prepared and is kept as uploaded.`, err)
      }
    }
    return c.json({ asset })
  })

  return app
}
