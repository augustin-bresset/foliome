import {
  applyOps,
  type Crumb,
  type Doc,
  emptyItem,
  emptyValue,
  type Fields,
  type Item,
  itemTitle,
  itemType,
  itemUrl,
  type ListDef,
  resolveIn,
  resolvePath,
  type Schema,
  withSlugs,
} from '@foliome/core'
import { useEffect, useRef, useState } from 'preact/hooks'
import { api, explain } from './api.ts'
import { FieldList, type FieldContext, pageLocale } from './fields.tsx'
import { useFollow } from './zones.ts'

export type Open =
  /** Something that exists: a field, a group, a list or one of its items. With no anchor the panel sits in the middle of the screen. */
  | { kind: 'path'; path: string; anchor: HTMLElement | null }
  /** A new item for a top-level list. */
  | { kind: 'create'; list: string }

interface Props {
  schema: Schema
  content: Doc
  open: Open
  /** Bumped when the artist tries to leave the panel with unsaved changes. */
  nudge: number
  onDirty: (dirty: boolean) => void
  onClose: () => void
  onOpen: (open: Open) => void
  /** Called once a change is stored. `goto` is the page to show next, when it is not the current one. */
  onSaved: (message: string, goto?: string) => void
}

/** What a panel edits: a set of fields hanging from one place in the content. */
interface Form {
  title: string
  /** What the fields belong to: the project's name, or the group's. */
  context?: string
  fields: Fields
  /** Content path the field names hang from; '' at the top level. */
  prefix: string
  value: Record<string, unknown>
  /** Set when a single field is shown: the path of everything it belongs to. */
  whole?: string
  item?: { list: ListDef; listPath: string; item: Item; index: number; count: number }
  /** Page of the item being edited, or of the one this field belongs to. */
  page?: string | null
  /** True when the item being edited is that page: removing it removes the page. */
  isPage?: boolean
}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)
const same = (a: unknown, b: unknown) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null)
const clamp = (n: number, min: number, max: number) => Math.max(min, Math.min(max, n))
const onPage = (page: string) => location.pathname.replace(/\/$/, '') === page.replace(/\/$/, '')
const parentOf = (path: string) => path.split('.').slice(0, -1).join('.')

/** Page addresses are declared for the default language; other languages live under their own prefix (/en/…). */
function inLocale(schema: Schema, url: string | null): string | null {
  const first = location.pathname.split('/').find(Boolean)
  return url && first && schema.locales?.slice(1).includes(first) ? `/${first}${url === '/' ? '' : url}` : url
}

function pageOf(schema: Schema, content: Doc, crumbs: Crumb[]): string | null {
  for (const crumb of crumbs.toReversed()) {
    if (crumb.kind !== 'item') continue
    const target = resolvePath(schema, content, crumb.path)
    if (target?.kind === 'item' && target.list.path) return itemUrl(target.list, target.item)
  }
  return null
}

function resolve(schema: Schema, content: Doc, open: Open, createType: string | undefined): Form | null {
  if (open.kind === 'create') {
    const list = schema.content[open.list]
    if (list?.type !== 'list') return null
    const item = emptyItem(list, createType)
    const type = item && itemType(list, item)
    return type ? { title: list.addLabel ?? type.label, fields: type.fields, prefix: '', value: item } : null
  }

  const target = resolvePath(schema, content, open.path)
  if (!target) return null
  const owner = target.trail.findLast((crumb) => crumb.kind !== 'list')

  if (target.kind === 'item') {
    const title = itemTitle(target.type, target.item)
    return {
      title: target.type.label,
      context: title === target.type.label ? owner?.label : title,
      fields: target.type.fields,
      prefix: target.path,
      value: target.item,
      item: { list: target.list, listPath: target.listPath, item: target.item, index: target.index, count: target.count },
      page: inLocale(schema, itemUrl(target.list, target.item) ?? pageOf(schema, content, target.trail)),
      isPage: !!itemUrl(target.list, target.item),
    }
  }

  const page = inLocale(schema, pageOf(schema, content, target.trail))
  if (target.def.type === 'group') {
    return { title: target.def.label, context: owner?.label, fields: target.def.fields, prefix: target.path, value: isObj(target.value) ? target.value : {}, page }
  }
  return {
    title: target.def.label,
    context: owner?.label,
    fields: { [target.name]: target.def },
    prefix: parentOf(target.path),
    value: { [target.name]: target.value },
    whole: owner?.path,
    page,
  }
}

type Side = 'right' | 'left' | 'below' | 'above' | 'dock'

export function Panel({ schema, content, open, nudge, onDirty, onClose, onOpen, onSaved }: Props) {
  const createList = open.kind === 'create' ? schema.content[open.list] : undefined
  const createTypes = createList?.type === 'list' && createList.types ? Object.entries(createList.types) : []
  const [createType, setCreateType] = useState(createTypes[0]?.[0])

  const [form, setForm] = useState(() => resolve(schema, content, open, createType))
  const startOf = (f: Form | null) =>
    Object.fromEntries(Object.entries(f?.fields ?? {}).map(([name, def]) => [name, f?.value[name] ?? emptyValue(def)]))
  const [initial, setInitial] = useState<Record<string, unknown>>(() => startOf(form))
  const [draft, setDraft] = useState(initial)

  // Lists are edited by stepping into their items; each step is a path inside the draft.
  const [steps, setSteps] = useState<string[]>([])
  const [locale, setLocale] = useState(() => pageLocale(schema.locales))
  const [uploading, setUploading] = useState(0)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [confirming, setConfirming] = useState(false)
  const [nudged, setNudged] = useState(false)

  const changed = Object.keys(form?.fields ?? {}).filter((name) => !same(draft[name], initial[name]))
  const dirty = changed.length > 0 || uploading > 0

  useEffect(() => {
    onDirty(dirty)
    return () => onDirty(false)
  }, [dirty])

  // The panel sits beside its zone and follows it while the page moves. It
  // picks a side once, so it does not jump around during a scroll.
  const ref = useRef<HTMLDivElement>(null)
  const side = useRef<Side | null>(null)
  const anchor = open.kind === 'path' ? open.anchor : null
  useFollow(anchor, (r) => {
    const el = ref.current
    if (!el) return
    const vw = window.innerWidth
    const vh = window.innerHeight
    if (vw <= 640) {
      el.style.transform = ''
      return
    }
    const pw = el.offsetWidth
    const ph = el.offsetHeight
    const gap = 14
    const margin = 12
    side.current ??=
      r.right + gap + pw + margin <= vw
        ? 'right'
        : r.left - gap - pw - margin >= 0
          ? 'left'
          : r.bottom + gap + ph + margin <= vh
            ? 'below'
            : r.top - gap - ph - margin >= 0
              ? 'above'
              : 'dock'
    const [x, y] = {
      right: [r.right + gap, r.top],
      left: [r.left - gap - pw, r.top],
      below: [r.left, r.bottom + gap],
      above: [r.left, r.top - gap - ph],
      dock: [vw - pw - margin, vh - ph - 84],
    }[side.current] as [number, number]
    el.style.transform = `translate(${Math.round(clamp(x, margin, vw - pw - margin))}px, ${Math.round(clamp(y, margin, Math.max(margin, vh - ph - margin)))}px)`
  })
  useEffect(() => {
    const reset = () => {
      side.current = null
    }
    window.addEventListener('resize', reset)
    return () => window.removeEventListener('resize', reset)
  }, [])

  useEffect(() => {
    if (!nudge) return
    setNudged(true)
    const el = ref.current
    el?.classList.remove('is-nudged')
    void el?.offsetWidth
    el?.classList.add('is-nudged')
  }, [nudge])

  if (!form) {
    return (
      <div ref={ref} class={anchor ? 'panel' : 'panel is-centered'} role="dialog" aria-label="Zone inconnue">
        <header class="panel-head">
          <h2 class="panel-title">Zone inconnue</h2>
          <button type="button" class="close" aria-label="Fermer" onClick={onClose} />
        </header>
        <p class="note">
          Cette zone n’est pas décrite dans la configuration du site{open.kind === 'path' ? ` (${open.path})` : ''}. Prévenez votre développeur.
        </p>
      </div>
    )
  }

  const creating = open.kind === 'create'

  // Where the artist currently is: the form itself, or an item reached by stepping into a list.
  const step = steps.at(-1)
  const inside = step ? resolveIn(form.fields, draft, step.split('.')) : null
  const here = inside?.kind === 'item' ? inside : null
  const fields = here ? here.type.fields : form.fields
  const value = here ? here.item : draft
  const hereTitle = here ? itemTitle(here.type, here.item) : ''

  const change = (name: string, next: unknown) =>
    setDraft((current) => {
      if (!step) return { ...current, [name]: next }
      const copy = structuredClone(current)
      applyOps(copy, [{ op: 'set', path: `${step}.${name}`, value: next }])
      return copy
    })

  const context: FieldContext = {
    locales: schema.locales ?? [],
    locale,
    setLocale,
    onUploading: (delta) => setUploading((n) => n + delta),
    onStep: (path) => setSteps((all) => [...all, path]),
  }

  const titleField = creating && createList?.type === 'list' ? itemType(createList, { type: createType })?.titleField : undefined
  const missingTitle = !!titleField && !itemTitleText(draft[titleField])
  const canSave = !saving && uploading === 0 && changed.length > 0 && !missingTitle

  const run = async (work: () => Promise<void>) => {
    if (saving) return
    setSaving(true)
    setError(null)
    try {
      await work()
    } catch (err) {
      setError(explain(err))
      setSaving(false)
    }
  }

  const save = () =>
    run(async () => {
      if (open.kind === 'create') {
        const list = schema.content[open.list] as ListDef
        const existing = (content[open.list] as Item[] | undefined) ?? []
        const item = withSlugs(list, [...existing, { ...form.value, ...draft } as Item]).at(-1)!
        await api.ops([{ op: 'insert', path: open.list, value: item, index: 0 }])
        onSaved('Créé', inLocale(schema, itemUrl(list, item)) ?? undefined)
        return
      }
      await api.ops(
        changed.map((name) => {
          const def = form.fields[name]!
          const next = def.type === 'list' && Array.isArray(draft[name]) ? withSlugs(def, draft[name] as Item[]) : draft[name]
          return { op: 'set', path: form.prefix ? `${form.prefix}.${name}` : name, value: next }
        }),
      )
      onSaved('Enregistré')
    })

  const remove = () =>
    run(async () => {
      await api.ops([{ op: 'remove', path: form.prefix }])
      onSaved('Supprimé', form.isPage && form.page && onPage(form.page) ? (inLocale(schema, '/') ?? '/') : undefined)
    })

  const move = (by: number) =>
    run(async () => {
      await api.ops([{ op: 'move', path: form.prefix, index: form.item!.index + by }])
      onSaved('Ordre modifié')
    })

  const single = Object.keys(form.fields).length === 1 && !!form.whole && !step
  const pageLink = !creating && !step && form.page && !onPage(form.page) ? form.page : null

  return (
    <>
      {!anchor && <div class="scrim" onClick={() => !dirty && onClose()} />}
      <div ref={ref} class={anchor ? 'panel' : 'panel is-centered'} role="dialog" aria-label={form.title}>
        <header class="panel-head">
          <div>
            <h2 class="panel-title">{here ? here.type.label : form.title}</h2>
            {/* The line under the title says what this belongs to; not worth showing when it only repeats the title. */}
            {(here ? hereTitle !== here.type.label && hereTitle : form.context !== form.title && form.context) && (
              <p class="panel-context">{here ? hereTitle : form.context}</p>
            )}
          </div>
          <button type="button" class="close" aria-label="Fermer" onClick={onClose} />
        </header>

        <form
          class="panel-form"
          onSubmit={(e) => {
            e.preventDefault()
            if (canSave) save()
          }}
        >
          <div class="panel-body">
            {step && (
              <button type="button" class="back" disabled={uploading > 0} onClick={() => setSteps((all) => all.slice(0, -1))}>
                <svg viewBox="0 0 16 16" width="12" height="12" aria-hidden="true">
                  <path d="M10 3 5 8l5 5" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" />
                </svg>
                Retour
              </button>
            )}

            {creating && createTypes.length > 1 && (
              <div class="field">
                <span class="label">Type</span>
                <div class="choices">
                  {createTypes.map(([key, type]) => (
                    <button
                      type="button"
                      class="choice"
                      aria-pressed={key === createType}
                      onClick={() => {
                        const next = resolve(schema, content, open, key)
                        setCreateType(key)
                        setForm(next)
                        setInitial(startOf(next))
                        setDraft(startOf(next))
                      }}
                    >
                      {type.label}
                    </button>
                  ))}
                </div>
              </div>
            )}

            <FieldList key={step ?? ''} fields={fields} value={value} path={step ?? ''} hideLabels={single} context={context} onChange={change} />

            {(pageLink || ((form.whole || form.item) && anchor && !step)) && (
              <p class="more">
                {/* From one item, the way to its siblings: adding, reordering. */}
                {form.item && anchor && !step && (
                  <button type="button" class="link" disabled={dirty} onClick={() => onOpen({ kind: 'path', path: form.item!.listPath, anchor })}>
                    Toute la liste
                  </button>
                )}
                {form.whole && anchor && !step && (
                  <button type="button" class="link" disabled={dirty} onClick={() => onOpen({ kind: 'path', path: form.whole!, anchor })}>
                    Voir tous les champs
                  </button>
                )}
                {pageLink && (
                  <a class="link" href={pageLink}>
                    Ouvrir la page
                  </a>
                )}
              </p>
            )}

            {form.item && !step && (
              <div class="item-actions">
                <span class="item-position">
                  Position {form.item.index + 1} sur {form.item.count}
                </span>
                <button type="button" class="link" disabled={saving || dirty || form.item.index === 0} onClick={() => move(-1)}>
                  Monter
                </button>
                <button type="button" class="link" disabled={saving || dirty || form.item.index === form.item.count - 1} onClick={() => move(1)}>
                  Descendre
                </button>
                <button type="button" class="link is-danger" disabled={saving} onClick={() => setConfirming(true)}>
                  Supprimer
                </button>
              </div>
            )}
          </div>

          {error && (
            <p class="error" role="alert">
              {error}
            </p>
          )}

          {confirming ? (
            <footer class="panel-foot is-confirm">
              <p class="confirm-text">Supprimer « {form.context || form.title} » du site ? Le bouton Annuler de la barre permet de revenir en arrière.</p>
              <button type="button" class="btn" onClick={() => setConfirming(false)}>
                Garder
              </button>
              <button type="button" class="btn is-danger" disabled={saving} onClick={remove}>
                Supprimer
              </button>
            </footer>
          ) : (
            <footer class="panel-foot">
              {nudged && dirty && <p class="nudge">Enregistrez ou annulez d’abord.</p>}
              <button type="button" class="btn" onClick={onClose}>
                Annuler
              </button>
              <button type="submit" class="btn is-primary" disabled={!canSave}>
                {uploading > 0 ? 'Envoi des fichiers…' : creating ? 'Créer' : 'Enregistrer'}
              </button>
            </footer>
          )}
        </form>
      </div>
    </>
  )
}

/** A title counts once it has visible text, in any language. */
function itemTitleText(value: unknown): boolean {
  if (typeof value === 'string') return value.trim() !== ''
  if (isObj(value) && isObj(value.$t)) return Object.values(value.$t).some(itemTitleText)
  return false
}
