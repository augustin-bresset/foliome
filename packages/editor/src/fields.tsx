import {
  type Asset,
  describeKinds,
  emptyItem,
  emptyValue,
  extOf,
  type FieldDef,
  type Fields,
  type FileKind,
  formatSize,
  isSafeHref,
  isTranslated,
  type Item,
  type ItemType,
  itemTitle,
  itemType,
  type ListDef,
  plainText,
  renderRichText,
  type RichSpan,
  type RichText,
} from '@foliome/core'
import { useEffect, useRef, useState } from 'preact/hooks'
import { explain, fits, pickerFor, upload } from './api.ts'

/** Shared by every field of a panel. */
export interface FieldContext {
  /** Languages of the site, default first; empty for a single-language site. */
  locales: string[]
  locale: string
  setLocale: (locale: string) => void
  /** +1 when an upload starts, -1 when it ends, so the form can wait for files before saving. */
  onUploading: (delta: number) => void
  /** Steps into an item of a list; `path` is relative to the panel's own content. */
  onStep: (path: string) => void
}

/** The language of the page being looked at, when the site has it; otherwise the default one. */
export function pageLocale(locales: string[] | undefined): string {
  const lang = document.documentElement.lang.toLowerCase()
  return locales?.find((l) => lang === l || lang.startsWith(`${l}-`)) ?? locales?.[0] ?? ''
}

interface FieldListProps {
  fields: Fields
  value: Record<string, unknown>
  /** Where these fields sit inside the panel's content; '' at its top. */
  path: string
  /** A field alone in a panel is already named by the panel's title. */
  hideLabels?: boolean
  context: FieldContext
  onChange: (name: string, value: unknown) => void
}

export function FieldList({ fields, value, path, hideLabels, context, onChange }: FieldListProps) {
  const firstTextual = Object.entries(fields).find(([, def]) => def.type === 'text' || def.type === 'longtext')?.[0]
  return (
    <>
      {Object.entries(fields).map(([name, def]) => {
        const id = `f-${path ? `${path}.` : ''}${name}`.replace(/\./g, '-')
        const fieldPath = path ? `${path}.${name}` : name
        const input = (
          <Field
            id={id}
            def={def}
            value={value[name]}
            path={fieldPath}
            context={context}
            autoFocus={name === firstTextual && !path}
            onChange={(next) => onChange(name, next)}
          />
        )
        if (def.type === 'group') {
          return (
            <fieldset class="group">
              <legend class="label">{def.label}</legend>
              {input}
            </fieldset>
          )
        }
        return (
          <div class="field">
            <label class={hideLabels ? 'sr-only' : 'label'} for={id}>
              {def.label}
            </label>
            {input}
            {def.help && <p class="help">{def.help}</p>}
          </div>
        )
      })}
    </>
  )
}

interface FieldProps {
  id: string
  def: FieldDef
  value: unknown
  path: string
  context: FieldContext
  autoFocus?: boolean
  onChange: (value: unknown) => void
}

function Field(props: FieldProps) {
  const { def, context } = props
  if ('translate' in def && def.translate && context.locales.length > 1) return <Translated {...props} />
  return <Input {...props} />
}

/** One value per language, edited one language at a time. */
function Translated(props: FieldProps) {
  const { def, value, context, onChange } = props
  const { locales, locale } = context
  // A value typed before the field was translated belongs to the default language.
  const blank = value === undefined || value === null || value === '' || (Array.isArray(value) && value.length === 0)
  const byLocale: Record<string, unknown> = isTranslated(value) ? value.$t : blank ? {} : { [locales[0]!]: value }
  return (
    <div class="translated">
      <div class="tabs" role="tablist" aria-label="Langue">
        {locales.map((l) => (
          <button
            type="button"
            role="tab"
            class={plainText(byLocale[l]).trim() ? 'tab' : 'tab is-empty'}
            aria-selected={l === locale}
            title={plainText(byLocale[l]).trim() ? undefined : 'Pas encore traduit'}
            onClick={() => context.setLocale(l)}
          >
            {l}
          </button>
        ))}
      </div>
      <Input {...props} key={locale} value={byLocale[locale] ?? emptyValue(def)} onChange={(next) => onChange({ $t: { ...byLocale, [locale]: next } })} />
    </div>
  )
}

function Input(props: FieldProps) {
  const { id, def, value, path, context, onChange, autoFocus } = props
  switch (def.type) {
    case 'text':
      return (
        <input
          id={id}
          class="input"
          type="text"
          value={plainText(value)}
          placeholder={def.placeholder}
          autoFocus={autoFocus}
          onInput={(e) => onChange(e.currentTarget.value)}
        />
      )
    case 'longtext':
      return <LongText id={id} value={plainText(value)} placeholder={def.placeholder} autoFocus={autoFocus} onChange={onChange} />
    case 'richtext':
      return <Rich id={id} value={value} onChange={onChange} />
    case 'select':
      return (
        <select id={id} class="input" value={String(value ?? '')} onChange={(e) => onChange(e.currentTarget.value)}>
          {def.options.map((option) => (
            <option value={option}>{option}</option>
          ))}
        </select>
      )
    case 'file':
      return <OneFile id={id} value={value} kinds={def.kinds} context={context} onChange={onChange} />
    case 'files':
      return <ManyFiles id={id} value={value} kinds={def.kinds} context={context} onChange={onChange} />
    case 'group': {
      const group = typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : {}
      return <FieldList fields={def.fields} value={group} path={path} context={context} onChange={(name, next) => onChange({ ...group, [name]: next })} />
    }
    case 'list':
      return <ItemList def={def} value={value} path={path} context={context} onChange={onChange} />
  }
}

function LongText(props: { id: string; value: string; placeholder?: string; autoFocus?: boolean; onChange: (v: string) => void }) {
  const ref = useRef<HTMLTextAreaElement>(null)
  const fit = () => {
    const el = ref.current
    if (!el) return
    el.style.height = 'auto'
    el.style.height = `${Math.min(el.scrollHeight + 2, 320)}px`
  }
  useEffect(fit, [props.value])
  return (
    <textarea
      ref={ref}
      id={props.id}
      class="input textarea"
      rows={4}
      value={props.value}
      placeholder={props.placeholder}
      autoFocus={props.autoFocus}
      onInput={(e) => props.onChange(e.currentTarget.value)}
    />
  )
}

/* Formatted text */

type Marks = Omit<RichSpan, 'text'>

/** Reads what the artist typed back into data. Only bold, italic, links and line breaks survive. */
function readRich(root: HTMLElement): RichText {
  const paragraphs: RichSpan[][] = []
  let current: RichSpan[] = []
  const flush = () => {
    // Browsers keep a trailing line break in a paragraph to give it height.
    while (current.at(-1)?.text === '\n') current.pop()
    if (current.some((span) => span.text.trim())) {
      const merged: RichSpan[] = []
      for (const span of current) {
        const last = merged.at(-1)
        if (last && last.bold === span.bold && last.italic === span.italic && last.href === span.href) last.text += span.text
        else merged.push({ ...span })
      }
      paragraphs.push(merged)
    }
    current = []
  }
  const walk = (node: Node, marks: Marks) => {
    if (node.nodeType === Node.TEXT_NODE) {
      if (node.textContent) current.push({ text: node.textContent, ...marks })
      return
    }
    if (!(node instanceof HTMLElement)) return
    const tag = node.tagName
    if (tag === 'BR') {
      current.push({ text: '\n', ...marks })
      return
    }
    const block = tag === 'P' || tag === 'DIV' || tag === 'LI' || tag === 'BLOCKQUOTE' || /^H[1-6]$/.test(tag)
    if (block) flush()
    const next: Marks = { ...marks }
    if (tag === 'B' || tag === 'STRONG') next.bold = true
    if (tag === 'I' || tag === 'EM') next.italic = true
    if (tag === 'A') {
      const href = node.getAttribute('href') ?? ''
      if (isSafeHref(href)) next.href = href
    }
    for (const child of node.childNodes) walk(child, next)
    if (block) flush()
  }
  for (const child of root.childNodes) walk(child, {})
  flush()
  return paragraphs
}

function Rich({ id, value, onChange }: { id: string; value: unknown; onChange: (value: RichText) => void }) {
  const area = useRef<HTMLDivElement>(null)
  const [link, setLink] = useState<{ range: Range; href: string } | null>(null)
  const [hint, setHint] = useState<string | null>(null)

  // Set once: from here on the browser owns the text, and every edit is read back from it.
  useEffect(() => {
    if (area.current) area.current.innerHTML = renderRichText(value) || '<p><br></p>'
  }, [])

  const selection = () => {
    const root = area.current?.getRootNode() as (ShadowRoot & { getSelection?: () => Selection | null }) | undefined
    return root?.getSelection?.() ?? document.getSelection()
  }
  const read = () => area.current && onChange(readRich(area.current))
  const command = (name: string, argument?: string) => {
    area.current?.focus()
    document.execCommand(name, false, argument)
    read()
  }

  const startLink = () => {
    const sel = selection()
    const range = sel && sel.rangeCount > 0 ? sel.getRangeAt(0) : null
    if (!range || range.collapsed || !area.current?.contains(range.commonAncestorContainer)) {
      setHint('Sélectionnez d’abord le texte à transformer en lien.')
      return
    }
    setHint(null)
    const start = range.startContainer instanceof Element ? range.startContainer : range.startContainer.parentElement
    setLink({ range: range.cloneRange(), href: start?.closest('a')?.getAttribute('href') ?? '' })
  }

  const applyLink = () => {
    if (!link) return
    const sel = selection()
    sel?.removeAllRanges()
    sel?.addRange(link.range)
    let href = link.href.trim()
    // "exemple.fr" is what people type; it only works as a link with its scheme.
    if (href && !isSafeHref(href)) href = /^[\w.-]+@[\w.-]+$/.test(href) ? `mailto:${href}` : `https://${href}`
    if (href && isSafeHref(href)) command('createLink', href)
    else command('unlink')
    setLink(null)
  }

  // Keeps the selection in the text while a toolbar button is pressed.
  const keep = (e: MouseEvent) => e.preventDefault()

  return (
    <div class="rich">
      <div class="rich-tools" role="toolbar" aria-label="Mise en forme">
        <button type="button" class="tool" aria-label="Gras" onMouseDown={keep} onClick={() => command('bold')}>
          <b>G</b>
        </button>
        <button type="button" class="tool" aria-label="Italique" onMouseDown={keep} onClick={() => command('italic')}>
          <i>I</i>
        </button>
        <button type="button" class="tool is-wide" onMouseDown={keep} onClick={startLink}>
          Lien
        </button>
      </div>
      <div
        ref={area}
        id={id}
        class="input rich-area"
        role="textbox"
        aria-multiline="true"
        contentEditable
        onFocus={() => {
          document.execCommand('defaultParagraphSeparator', false, 'p')
          document.execCommand('styleWithCSS', false, 'false')
        }}
        onInput={read}
        onPaste={(e) => {
          // Text copied from elsewhere arrives with its styles; only the words are wanted.
          e.preventDefault()
          document.execCommand('insertText', false, e.clipboardData?.getData('text/plain') ?? '')
        }}
      />
      {link && (
        <div class="rich-link">
          <input
            class="input"
            type="text"
            inputMode="url"
            aria-label="Adresse du lien"
            placeholder="https://… (vide pour retirer le lien)"
            value={link.href}
            autoFocus
            onInput={(e) => setLink({ ...link, href: e.currentTarget.value })}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault()
                applyLink()
              }
            }}
          />
          <button type="button" class="btn" onClick={applyLink}>
            Appliquer
          </button>
        </div>
      )}
      {hint && <p class="help">{hint}</p>}
    </div>
  )
}

/* Lists of items */

/** A few words telling one item from the next: its title, or the start of its first text. */
function summarize(type: ItemType, item: Item): string {
  const title = itemTitle(type, item)
  if (title !== type.label) return title
  for (const [name, def] of Object.entries(type.fields)) {
    const fieldValue = item[name]
    if (def.type === 'text' || def.type === 'longtext' || def.type === 'richtext') {
      const text = plainText(fieldValue).replace(/\s+/g, ' ').trim()
      if (text) return text.length > 48 ? `${text.slice(0, 48)}…` : text
    }
    if (def.type === 'files' && Array.isArray(fieldValue) && fieldValue.length > 0) {
      return fieldValue.length === 1 ? '1 fichier' : `${fieldValue.length} fichiers`
    }
  }
  return ''
}

function Arrow({ up }: { up?: boolean }) {
  return (
    <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true">
      <path d={up ? 'M8 13V3M3.5 7.5 8 3l4.5 4.5' : 'M8 3v10M3.5 8.5 8 13l4.5-4.5'} fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" />
    </svg>
  )
}

function ItemList({ def, value, path, context, onChange }: { def: ListDef; value: unknown; path: string; context: FieldContext; onChange: (value: Item[]) => void }) {
  const items = Array.isArray(value) ? (value as Item[]) : []

  const move = (from: number, to: number) => {
    const next = [...items]
    const [item] = next.splice(from, 1)
    next.splice(to, 0, item!)
    onChange(next)
  }
  const add = (typeKey?: string) => {
    const item = emptyItem(def, typeKey)
    if (!item) return
    onChange([...items, item])
    context.onStep(`${path}.${item.id}`)
  }

  return (
    <div class="list">
      {items.length > 0 && (
        <ul class="items">
          {items.map((item, index) => {
            const type = itemType(def, item)
            const summary = type ? summarize(type, item) : ''
            return (
              <li class="item">
                <button type="button" class="item-open" disabled={!type} onClick={() => context.onStep(`${path}.${item.id}`)}>
                  {(def.types || !summary) && <span class="item-type">{type?.label ?? 'Type inconnu'}</span>}
                  {summary && <span class="item-summary">{summary}</span>}
                </button>
                <button type="button" class="icon" aria-label="Monter" disabled={index === 0} onClick={() => move(index, index - 1)}>
                  <Arrow up />
                </button>
                <button type="button" class="icon" aria-label="Descendre" disabled={index === items.length - 1} onClick={() => move(index, index + 1)}>
                  <Arrow />
                </button>
                <button type="button" class="icon is-danger" aria-label="Retirer" onClick={() => onChange(items.filter((other) => other !== item))}>
                  <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true">
                    <path d="m4 4 8 8M12 4l-8 8" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" />
                  </svg>
                </button>
              </li>
            )
          })}
        </ul>
      )}
      {def.types ? (
        <div class="add">
          <span class="add-label">Ajouter</span>
          {Object.entries(def.types).map(([key, type]) => (
            <button type="button" class="btn is-small" onClick={() => add(key)}>
              {type.label}
            </button>
          ))}
        </div>
      ) : (
        <div class="add">
          <button type="button" class="btn is-small" onClick={() => add()}>
            {def.addLabel ?? 'Ajouter'}
          </button>
        </div>
      )}
    </div>
  )
}

/* Files */

function Thumb({ asset }: { asset: Asset }) {
  if (asset.kind === 'image') return <img class="thumb-media" src={asset.variants?.[0]?.path ?? asset.path} alt="" loading="lazy" />
  if (asset.kind === 'video') {
    return asset.poster ? (
      <img class="thumb-media" src={asset.poster.path} alt="" loading="lazy" />
    ) : (
      <video class="thumb-media" src={`${asset.path}#t=0.1`} muted playsInline preload="metadata" />
    )
  }
  return (
    <span class="thumb-file">
      <span class="thumb-ext">{extOf(asset.name) || 'fichier'}</span>
    </span>
  )
}

interface Pending {
  key: number
  name: string
  /** 0 to 1 while sending; 1 while the server prepares the file. */
  progress: number
  error?: string
}

let pendingKey = 0

/** Sends files one after another, reporting each result as it arrives. */
function useUploads(kinds: FileKind[] | undefined, onUploading: (delta: number) => void, onDone: (asset: Asset) => void) {
  const [pending, setPending] = useState<Pending[]>([])
  const done = useRef(onDone)
  done.current = onDone

  const patch = (key: number, change: Partial<Pending>) =>
    setPending((list) => list.map((p) => (p.key === key ? { ...p, ...change } : p)))

  const add = async (files: File[]) => {
    const jobs = files.map((file) => ({ file, key: ++pendingKey }))
    setPending((list) => [
      ...list.filter((p) => !p.error),
      ...jobs.map(({ file, key }) => ({
        key,
        name: file.name,
        progress: 0,
        error: fits(file, kinds) ? undefined : `Ce champ attend ${describeKinds(kinds ?? [])}.`,
      })),
    ])
    for (const { file, key } of jobs) {
      if (!fits(file, kinds)) continue
      onUploading(1)
      try {
        const asset = await upload(file, (progress) => patch(key, { progress }))
        if (fitsAsset(asset, kinds)) {
          done.current(asset)
          setPending((list) => list.filter((p) => p.key !== key))
        } else {
          patch(key, { error: `Ce champ attend ${describeKinds(kinds ?? [])}.` })
        }
      } catch (err) {
        patch(key, { error: explain(err) })
      } finally {
        onUploading(-1)
      }
    }
  }

  return { pending, add, dismiss: (key: number) => setPending((list) => list.filter((p) => p.key !== key)) }
}

/** The server has the last word on what a file is, once it has opened it. */
const fitsAsset = (asset: Asset, kinds: FileKind[] | undefined) => !kinds || kinds.length === 0 || kinds.includes('file') || kinds.includes(asset.kind)

function PendingList({ pending, dismiss }: { pending: Pending[]; dismiss: (key: number) => void }) {
  if (pending.length === 0) return null
  return (
    <ul class="pending">
      {pending.map((p) => (
        <li class={p.error ? 'pending-item is-error' : 'pending-item'}>
          <span class="pending-name">{p.name}</span>
          {p.error ? (
            <>
              <span class="pending-error">{p.error}</span>
              <button type="button" class="link" onClick={() => dismiss(p.key)}>
                Masquer
              </button>
            </>
          ) : p.progress >= 1 ? (
            <span class="pending-step">Préparation du fichier…</span>
          ) : (
            <progress class="progress" max={1} value={p.progress} aria-label={`Envoi de ${p.name}`} />
          )}
        </li>
      ))}
    </ul>
  )
}

function Picker(props: { id: string; accept?: string; multiple?: boolean; label: string; onFiles: (files: File[]) => void }) {
  const input = useRef<HTMLInputElement>(null)
  const [over, setOver] = useState(false)
  return (
    <div
      class={over ? 'drop is-over' : 'drop'}
      onDragOver={(e) => {
        if (e.dataTransfer?.types.includes('Files')) {
          e.preventDefault()
          setOver(true)
        }
      }}
      onDragLeave={() => setOver(false)}
      onDrop={(e) => {
        e.preventDefault()
        setOver(false)
        props.onFiles(Array.from(e.dataTransfer?.files ?? []))
      }}
    >
      <input
        ref={input}
        id={props.id}
        class="sr-only"
        type="file"
        accept={props.accept}
        multiple={props.multiple}
        onChange={(e) => {
          props.onFiles(Array.from(e.currentTarget.files ?? []))
          e.currentTarget.value = ''
        }}
      />
      <button type="button" class="btn" onClick={() => input.current?.click()}>
        {props.label}
      </button>
      <span class="drop-hint">ou déposez {props.multiple ? 'des fichiers' : 'un fichier'} ici</span>
    </div>
  )
}

interface FileProps {
  id: string
  value: unknown
  kinds?: FileKind[]
  context: FieldContext
  onChange: (value: unknown) => void
}

function OneFile({ id, value, kinds, context, onChange }: FileProps) {
  const asset = (value as Asset | null) ?? null
  const uploads = useUploads(kinds, context.onUploading, onChange)
  return (
    <div class="file">
      {asset && (
        <div class="file-current">
          <span class="thumb">
            <Thumb asset={asset} />
          </span>
          <span class="file-meta">
            <span class="file-name">{asset.name}</span>
            <span class="file-size">{formatSize(asset.size)}</span>
          </span>
          <button type="button" class="link is-danger" onClick={() => onChange(null)}>
            Retirer
          </button>
        </div>
      )}
      <Picker id={id} accept={pickerFor(kinds)} label={asset ? 'Remplacer le fichier' : 'Choisir un fichier'} onFiles={(files) => uploads.add(files.slice(0, 1))} />
      <PendingList pending={uploads.pending} dismiss={uploads.dismiss} />
    </div>
  )
}

function ManyFiles({ id, value, kinds, context, onChange }: FileProps) {
  const list = Array.isArray(value) ? (value as Asset[]) : []
  // Uploads finish long after the render that started them: always append to the latest list.
  const latest = useRef(list)
  latest.current = list

  const uploads = useUploads(kinds, context.onUploading, (asset) => onChange([...latest.current, asset]))
  const [selected, setSelected] = useState<string | null>(null)
  const [dragged, setDragged] = useState<string | null>(null)
  const current = list.find((a) => a.id === selected) ?? null

  const move = (assetId: string, to: number) => {
    const from = list.findIndex((a) => a.id === assetId)
    if (from === -1 || to < 0 || to >= list.length || from === to) return
    const next = [...list]
    const [item] = next.splice(from, 1)
    next.splice(to, 0, item!)
    onChange(next)
  }

  return (
    <div class="file">
      {list.length > 0 && (
        <ul class="grid">
          {list.map((asset, index) => (
            <li
              class={asset.id === dragged ? 'grid-item is-dragged' : 'grid-item'}
              draggable
              onDragStart={(e) => {
                setDragged(asset.id)
                e.dataTransfer?.setData('text/plain', asset.id)
              }}
              onDragEnd={() => setDragged(null)}
              onDragOver={(e) => {
                if (dragged) e.preventDefault()
              }}
              onDrop={(e) => {
                if (!dragged) return
                e.preventDefault()
                e.stopPropagation()
                move(dragged, index)
                setDragged(null)
              }}
            >
              <button
                type="button"
                class="thumb"
                aria-pressed={asset.id === selected}
                aria-label={`${asset.name}, position ${index + 1} sur ${list.length}`}
                onClick={() => setSelected(asset.id === selected ? null : asset.id)}
              >
                <Thumb asset={asset} />
              </button>
            </li>
          ))}
        </ul>
      )}

      {current && (
        <div class="detail">
          <div class="file-meta">
            <span class="file-name">{current.name}</span>
            <span class="file-size">{formatSize(current.size)}</span>
          </div>
          <label class="label" for={`${id}-caption`}>
            Légende
          </label>
          <input
            id={`${id}-caption`}
            class="input"
            type="text"
            value={current.caption ?? ''}
            onInput={(e) => {
              const caption = e.currentTarget.value
              onChange(list.map((a) => (a.id === current.id ? { ...a, caption } : a)))
            }}
          />
          <div class="detail-actions">
            <button type="button" class="link" disabled={list[0] === current} onClick={() => move(current.id, list.indexOf(current) - 1)}>
              Déplacer avant
            </button>
            <button type="button" class="link" disabled={list.at(-1) === current} onClick={() => move(current.id, list.indexOf(current) + 1)}>
              Déplacer après
            </button>
            <button
              type="button"
              class="link is-danger"
              onClick={() => {
                onChange(list.filter((a) => a.id !== current.id))
                setSelected(null)
              }}
            >
              Retirer
            </button>
          </div>
        </div>
      )}

      <Picker id={id} accept={pickerFor(kinds)} multiple label="Ajouter des fichiers" onFiles={uploads.add} />
      <PendingList pending={uploads.pending} dismiss={uploads.dismiss} />
    </div>
  )
}
