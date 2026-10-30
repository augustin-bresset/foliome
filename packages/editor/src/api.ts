import { type Asset, type Doc, extOf, type FileKind, kindOf, mimeOf, type Op, pickerAccept, type Schema } from '@foliome/core'

import { t } from './i18n.ts'

const BASE = '/_foliome'

export class ApiError extends Error {
  status: number
  code: string
  constructor(status: number, code: string) {
    super(code)
    this.status = status
    this.code = code
  }
}

async function call<T>(method: string, path: string, body?: unknown): Promise<T> {
  let res: Response
  try {
    res = await fetch(BASE + path, {
      method,
      credentials: 'same-origin',
      headers: body === undefined ? undefined : { 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    })
  } catch {
    throw new ApiError(0, 'network')
  }
  const data = (await res.json().catch(() => ({}))) as { error?: string }
  if (!res.ok) throw new ApiError(res.status, data.error ?? 'error')
  return data as T
}

export interface SiteConfig {
  name: string
  schema: Schema
  /** Whether the site can be put online from the editor. */
  publish: boolean
  /** What the server converts on arrival, so the editor does not refuse it. */
  converts: { heic: boolean; tiff: boolean }
}

export const api = {
  session: () => call<{ editor: boolean }>('GET', '/session'),
  login: (code: string) => call<{ ok: true }>('POST', '/login', { code }),
  logout: () => call<{ ok: true }>('POST', '/logout', {}),
  config: () => call<SiteConfig>('GET', '/config'),
  content: () => call<{ content: Doc; canUndo: boolean }>('GET', '/content'),
  ops: (ops: Op[]) => call<{ ok: true }>('POST', '/ops', { ops }),
  undo: () => call<{ ok: boolean }>('POST', '/undo', {}),
  publish: () => call<{ ok: boolean; log: string }>('POST', '/publish', {}),
}

/** What to tell the artist when a request fails. */
export function explain(err: unknown): string {
  const code = err instanceof ApiError ? err.code : ''
  if (code === 'network') return t.disconnected
  if (code === 'unauthorized') return t.expired
  if (code === 'too_large') return t.tooLarge
  return t.saveFailed
}

type Measures = { width?: string; height?: string; duration?: string }

const settle = <T,>(work: Promise<T>, fallback: T, ms = 4000): Promise<T> =>
  Promise.race([work.catch(() => fallback), new Promise<T>((done) => setTimeout(() => done(fallback), ms))])

/** Reads pixel size and duration in the browser, so the site can reserve the right space before a file loads. */
function measure(file: File): Promise<Measures> {
  if (file.type.startsWith('image/')) {
    return settle(
      new Promise<Measures>((done, fail) => {
        const img = new Image()
        const src = URL.createObjectURL(file)
        img.onload = () => {
          URL.revokeObjectURL(src)
          done(img.naturalWidth ? { width: String(img.naturalWidth), height: String(img.naturalHeight) } : {})
        }
        img.onerror = () => {
          URL.revokeObjectURL(src)
          fail(new Error('unreadable image'))
        }
        img.src = src
      }),
      {},
    )
  }
  if (file.type.startsWith('video/') || file.type.startsWith('audio/')) {
    return settle(
      new Promise<Measures>((done, fail) => {
        const media = document.createElement(file.type.startsWith('video/') ? 'video' : 'audio')
        const src = URL.createObjectURL(file)
        media.preload = 'metadata'
        media.onloadedmetadata = () => {
          const m: Measures = {}
          if (Number.isFinite(media.duration)) m.duration = String(media.duration)
          if (media instanceof HTMLVideoElement && media.videoWidth) {
            m.width = String(media.videoWidth)
            m.height = String(media.videoHeight)
          }
          URL.revokeObjectURL(src)
          done(m)
        }
        media.onerror = () => {
          URL.revokeObjectURL(src)
          fail(new Error('unreadable media'))
        }
        media.src = src
      }),
      {},
    )
  }
  return Promise.resolve({})
}

export async function upload(file: File, onProgress: (ratio: number) => void): Promise<Asset> {
  const query = new URLSearchParams({ name: file.name, ...(await measure(file)) })
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest()
    xhr.open('PUT', `${BASE}/assets?${query}`)
    xhr.setRequestHeader('content-type', file.type || 'application/octet-stream')
    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable) onProgress(e.loaded / e.total)
    }
    xhr.onload = () => {
      let data: { asset?: Asset; error?: string } = {}
      try {
        data = JSON.parse(xhr.responseText)
      } catch {
        // Not JSON: treated as a failure below.
      }
      if (xhr.status === 200 && data.asset) resolve(data.asset)
      else reject(new ApiError(xhr.status, data.error ?? 'error'))
    }
    xhr.onerror = () => reject(new ApiError(0, 'network'))
    xhr.send(file)
  })
}

/**
 * Whether a field takes this file. Judged by what browsers can display, not
 * by the type the browser reports: a HEIC photo or a DWG plan calls itself an
 * image, yet no site can show it.
 */
export function fits(file: File, kinds: FileKind[] | undefined): boolean {
  if (!kinds || kinds.length === 0 || kinds.includes('file')) return true
  if (kinds.includes('image') && convertible.has(extOf(file.name))) return true
  return kinds.includes(kindOf(mimeOf(file.name, file.type), file.name))
}

/** Photo formats the server turns into something displayable; filled in from the site's configuration. */
const convertible = new Set<string>()

export function setConversions(converts: SiteConfig['converts'] | undefined): void {
  convertible.clear()
  if (converts?.heic) for (const ext of ['heic', 'heif']) convertible.add(ext)
  if (converts?.tiff) for (const ext of ['tif', 'tiff']) convertible.add(ext)
}

/** `accept` for the file picker: what the field takes, plus what the server can convert into it. */
export function pickerFor(kinds: FileKind[] | undefined): string | undefined {
  const accept = pickerAccept(kinds)
  if (!accept || !kinds?.includes('image') || convertible.size === 0) return accept
  return `${accept},${[...convertible].map((ext) => `.${ext}`).join(',')}`
}
