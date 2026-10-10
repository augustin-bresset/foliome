import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { type Asset, type Doc, localize, renderRichText } from '@foliome/core'

export type { Asset, FileKind, RichText } from '@foliome/core'
export { extOf, formatSize, plainText } from '@foliome/core'

// Set by the integration: FOLIOME_EDITABLE only while the dev server runs.
const editable = () => process.env.FOLIOME_EDITABLE === '1'
const base = () => (process.env.FOLIOME_BASE ?? '/').replace(/\/$/, '')

async function read(): Promise<Doc> {
  const file = path.join(process.env.FOLIOME_ROOT ?? process.cwd(), 'content', 'content.json')
  try {
    return JSON.parse(await readFile(file, 'utf8')) as Doc
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return {}
    throw err
  }
}

let built: Promise<Doc> | undefined

/**
 * The site's content. Read fresh on every request while editing, once for a build.
 *
 * On a site with several languages, pass the page's `locale`: translated
 * fields then come back as plain values in that language, falling back to the
 * default language where a translation is missing.
 */
export async function getContent<T = Doc>(options: { locale?: string } = {}): Promise<T> {
  const doc = await (editable() ? read() : (built ??= read()))
  const locales = (process.env.FOLIOME_LOCALES ?? '').split(',').filter(Boolean)
  const fallback = locales[0]
  if (!fallback) return doc as T
  return localize(doc, options.locale && locales.includes(options.locale) ? options.locale : fallback, fallback) as T
}

/** True while the site is served for editing. Lets a page show an empty zone the artist can fill. */
export const isEditing = editable

/**
 * Marks an element as an editable zone: `<h1 {...edit(`projects.${p.id}.title`)}>`.
 * Adds nothing to the built site.
 */
export function edit(contentPath: string): Record<string, string> {
  return editable() ? { 'data-foliome': contentPath } : {}
}

/** Public URL of an uploaded file. */
export function url(asset: Pick<Asset, 'path'>): string {
  return base() + asset.path
}

/** `srcset` listing an image's smaller versions, so each screen downloads only the size it needs. */
export function srcset(asset: Asset): string | undefined {
  if (!asset.variants?.length || !asset.width) return undefined
  return [...asset.variants.map((v) => `${base()}${v.path} ${v.width}w`), `${url(asset)} ${asset.width}w`].join(', ')
}

/** HTML of a formatted text field, for `<div set:html={richText(value)} />`. */
export const richText = renderRichText
