import type { RichSpan, RichText, Translated } from './types.ts'

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)

/* Languages */

export function isTranslated(value: unknown): value is Translated {
  return isObj(value) && isObj(value.$t) && Object.keys(value).length === 1
}

/** The value for one language. A value saved before the field was translated counts as the default language's. */
export function pick(value: unknown, locale: string, fallback: string): unknown {
  if (!isTranslated(value)) return value
  const own = value.$t[locale]
  return isBlank(own) ? value.$t[fallback] : own
}

/**
 * Returns the content with every translated value replaced by its version in
 * `locale`, falling back to `fallback` where a translation is missing. Pages
 * can then read `project.title` without knowing the site has languages.
 */
export function localize<T>(doc: T, locale: string, fallback: string): T {
  if (isTranslated(doc)) return pick(doc, locale, fallback) as T
  if (Array.isArray(doc)) return doc.map((entry) => localize(entry, locale, fallback)) as T
  if (isObj(doc)) return Object.fromEntries(Object.entries(doc).map(([key, entry]) => [key, localize(entry, locale, fallback)])) as T
  return doc
}

/* Formatted text */

const SAFE_HREF = /^(https?:\/\/|mailto:|tel:|\/(?!\/)|#)/i

/** Links may only go to web pages, e-mail, phone numbers or the site itself: never to a script. */
export const isSafeHref = (href: string) => SAFE_HREF.test(href.trim())

const isRichText = (value: unknown): value is RichText => Array.isArray(value) && value.every((p) => Array.isArray(p))

function isBlank(value: unknown): boolean {
  if (value === undefined || value === null || value === '') return true
  if (isRichText(value)) return value.every((paragraph) => paragraph.every((span) => !span.text.trim()))
  return false
}

const escapeHtml = (text: string) =>
  text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;')

function spanHtml(span: RichSpan): string {
  let html = escapeHtml(span.text).replace(/\n/g, '<br>')
  if (span.italic) html = `<em>${html}</em>`
  if (span.bold) html = `<strong>${html}</strong>`
  if (span.href && isSafeHref(span.href)) {
    const external = /^https?:/i.test(span.href)
    html = `<a href="${escapeHtml(span.href.trim())}"${external ? ' target="_blank" rel="noopener"' : ''}>${html}</a>`
  }
  return html
}

/**
 * HTML for a formatted text: `<p>` elements with `<strong>`, `<em>`, `<a>` and
 * `<br>` only. Also accepts plain text (paragraphs separated by a blank line),
 * so a field can become formatted without rewriting what was already typed.
 */
export function renderRichText(value: unknown): string {
  const paragraphs: RichText = isRichText(value)
    ? value
    : String(value ?? '')
        .split(/\n\s*\n/)
        .map((text) => [{ text: text.trim() }])
  return paragraphs
    .filter((paragraph) => paragraph.some((span) => span.text.trim()))
    .map((paragraph) => `<p>${paragraph.map(spanHtml).join('')}</p>`)
    .join('')
}

/** The words of any text value, without formatting. Used for titles, slugs and descriptions. */
export function plainText(value: unknown): string {
  if (isTranslated(value)) return plainText(Object.values(value.$t).find((v) => !isBlank(v)))
  if (isRichText(value)) return value.map((paragraph) => paragraph.map((span) => span.text).join('')).join('\n\n')
  return typeof value === 'string' ? value : value == null ? '' : String(value)
}
