import { createWriteStream } from 'node:fs'
import { mkdir, readdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { Readable, Transform } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import type { Doc } from '@foliome/core'
import { type MediaTools, prepareFile } from './media.ts'
import { type Storage, TooLargeError } from './storage.ts'

export interface FsStorageOptions {
  /** JSON file holding the site's content. */
  contentFile: string
  /** Folder uploaded files are written to. */
  mediaDir: string
  /** URL path `mediaDir` is served from, e.g. "/media". */
  mediaPath: string
  /** Folder for undo snapshots. Not meant to be committed. */
  historyDir: string
  maxHistory?: number
  /** Tools for preparing files for the web; see `detectTools`. Omit to keep files as uploaded. */
  media?: MediaTools
}

export function fsStorage(options: FsStorageOptions): Storage {
  const { contentFile, mediaDir, mediaPath, historyDir, maxHistory = 100, media } = options

  // Serialises every read-modify-write so two editors cannot overwrite each other's change.
  let queue: Promise<unknown> = Promise.resolve()
  const exclusive = <T>(task: () => Promise<T>): Promise<T> => {
    const run = queue.then(task, task)
    queue = run.catch(() => {})
    return run
  }

  let counter = 0

  async function readRaw(): Promise<string | null> {
    try {
      return await readFile(contentFile, 'utf8')
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null
      throw err
    }
  }

  async function writeRaw(json: string): Promise<void> {
    await mkdir(path.dirname(contentFile), { recursive: true })
    const tmp = `${contentFile}.tmp`
    await writeFile(tmp, json)
    await rename(tmp, contentFile)
  }

  async function snapshots(): Promise<string[]> {
    try {
      return (await readdir(historyDir)).filter((f) => f.endsWith('.json')).sort()
    } catch {
      return []
    }
  }

  return {
    async read() {
      const raw = await readRaw()
      return raw ? (JSON.parse(raw) as Doc) : {}
    },

    update(change) {
      return exclusive(async () => {
        const before = await readRaw()
        const doc = before ? (JSON.parse(before) as Doc) : {}
        change(doc)
        const after = `${JSON.stringify(doc, null, 2)}\n`
        if (after === before) return doc

        await mkdir(historyDir, { recursive: true })
        const name = `${String(Date.now()).padStart(15, '0')}-${String(counter++).padStart(4, '0')}.json`
        await writeFile(path.join(historyDir, name), before ?? '{}\n')
        await writeRaw(after)

        const all = await snapshots()
        await Promise.all(all.slice(0, Math.max(0, all.length - maxHistory)).map((f) => rm(path.join(historyDir, f))))
        return doc
      })
    },

    async canUndo() {
      return (await snapshots()).length > 0
    },

    undo() {
      return exclusive(async () => {
        const last = (await snapshots()).at(-1)
        if (!last) return false
        const file = path.join(historyDir, last)
        await writeRaw(await readFile(file, 'utf8'))
        await rm(file)
        return true
      })
    },

    async putFile(id, name, body, maxBytes) {
      const dir = path.join(mediaDir, id)
      const file = path.join(dir, name)
      // Both come from the server, but a stray separator must never escape the media folder.
      if (path.dirname(file) !== dir || path.dirname(dir) !== path.resolve(mediaDir)) {
        throw new Error(`Unsafe file location: ${id}/${name}`)
      }
      await mkdir(dir, { recursive: true })

      let size = 0
      const meter = new Transform({
        transform(chunk: Buffer, _encoding, done) {
          size += chunk.length
          done(size > maxBytes ? new TooLargeError() : null, chunk)
        },
      })
      const part = `${file}.part`
      try {
        await pipeline(Readable.fromWeb(body as Parameters<typeof Readable.fromWeb>[0]), meter, createWriteStream(part))
        await rename(part, file)
      } catch (err) {
        await rm(dir, { recursive: true, force: true })
        throw err
      }
      return { path: `${mediaPath}/${id}/${encodeURIComponent(name)}`, size }
    },

    ...(media
      ? {
          prepare: (id: string, name: string) => prepareFile({ dir: path.join(mediaDir, id), file: name, url: `${mediaPath}/${id}` }, media),
        }
      : {}),
  }
}
