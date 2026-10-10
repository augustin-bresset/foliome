import { plainText } from './text.ts'
import type { FieldDef, Fields, Item, ItemType, ListDef, Schema } from './types.ts'

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)

/** One step on the way down to a target: a group, a list, or an item of a list. */
export interface Crumb {
  kind: 'group' | 'list' | 'item'
  path: string
  label: string
}

/** What a content path points at: a field (of any type, containers included) or one item of a list. */
export type Target =
  | { kind: 'field'; path: string; name: string; def: FieldDef; value: unknown; trail: Crumb[] }
  | {
      kind: 'item'
      path: string
      listPath: string
      list: ListDef
      type: ItemType
      item: Item
      index: number
      count: number
      trail: Crumb[]
    }

/** The shape of an item: its declared type, or the list's single shape. */
export function itemType(list: ListDef, item: Pick<Item, 'type'>): ItemType | null {
  if (list.types) return list.types[String(item.type)] ?? null
  return { label: list.itemLabel ?? list.label, titleField: list.titleField, fields: list.fields ?? {} }
}

/** How an item is named in the editor: its title, or failing that the name of its type. */
export function itemTitle(type: ItemType, item: Item): string {
  const title = type.titleField ? plainText(item[type.titleField]).trim() : ''
  return title || type.label
}

/**
 * Walks `fields` along `segments`, reading `value` alongside to know which
 * item of a list each id refers to (and, for lists with several types, which
 * shape that item has).
 */
export function resolveIn(fields: Fields, value: unknown, segments: string[], basePath = '', baseTrail: Crumb[] = []): Target | null {
  let defs = fields
  let node = value
  let path = basePath
  let trail = baseTrail

  for (let i = 0; i < segments.length; i++) {
    const name = segments[i]!
    const def = defs[name]
    if (!def) return null
    path = path ? `${path}.${name}` : name
    const fieldValue = isObj(node) ? node[name] : undefined

    if (i === segments.length - 1) return { kind: 'field', path, name, def, value: fieldValue, trail }

    if (def.type === 'group') {
      trail = [...trail, { kind: 'group', path, label: def.label }]
      defs = def.fields
      node = fieldValue
      continue
    }

    if (def.type === 'list') {
      const items = Array.isArray(fieldValue) ? (fieldValue as Item[]) : []
      const id = segments[++i]
      const index = items.findIndex((x) => isObj(x) && x.id === id)
      const item = items[index]
      const type = item && itemType(def, item)
      if (!item || !type) return null

      const listPath = path
      path = `${path}.${id}`
      const inList: Crumb[] = [...trail, { kind: 'list', path: listPath, label: def.label }]
      if (i === segments.length - 1) {
        return { kind: 'item', path, listPath, list: def, type, item, index, count: items.length, trail: inList }
      }
      trail = [...inList, { kind: 'item', path, label: itemTitle(type, item) }]
      defs = type.fields
      node = item
      continue
    }

    return null
  }
  return null
}

/** Resolves what a `data-foliome` path points at, or null when the schema does not know it. */
export function resolvePath(schema: Schema, doc: unknown, path: string): Target | null {
  return resolveIn(schema.content, doc, path.split('.'))
}

export function emptyValue(def: FieldDef): unknown {
  switch (def.type) {
    case 'file':
      return null
    case 'files':
    case 'list':
    case 'richtext':
      return []
    case 'select':
      return def.options[0] ?? ''
    case 'group':
      return Object.fromEntries(Object.entries(def.fields).map(([name, field]) => [name, emptyValue(field)]))
    default:
      return ''
  }
}

/** A new, empty item for a list. `typeKey` picks one of the list's `types`. */
export function emptyItem(list: ListDef, typeKey?: string): Item | null {
  const type = itemType(list, { type: typeKey })
  if (!type) return null
  return {
    id: newId('i'),
    ...(list.types ? { type: typeKey } : {}),
    ...Object.fromEntries(Object.entries(type.fields).map(([name, field]) => [name, emptyValue(field)])),
  }
}

export function slugify(text: string): string {
  return text
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60)
}

export function uniqueSlug(text: string, taken: Iterable<string | undefined>): string {
  const used = new Set(taken)
  const base = slugify(text) || 'sans-titre'
  let slug = base
  for (let n = 2; used.has(slug); n++) slug = `${base}-${n}`
  return slug
}

/**
 * Gives a slug to the items of a page list that have none yet. A slug is set
 * once and never follows the title afterwards: the page's address must not
 * change under visitors and search engines.
 */
export function withSlugs(list: ListDef, items: Item[]): Item[] {
  if (!list.path) return items
  const taken = new Set(items.map((item) => item.slug).filter(Boolean))
  return items.map((item) => {
    if (item.slug) return item
    const type = itemType(list, item)
    const slug = uniqueSlug(type ? itemTitle(type, item) : '', taken)
    taken.add(slug)
    return { ...item, slug }
  })
}

export function itemUrl(list: ListDef, item: Pick<Item, 'slug'>): string | null {
  return list.path && item.slug ? list.path.replace('{slug}', item.slug) : null
}

/** Short random id, e.g. `i_k3f9x2ab71`. Works in browsers, Node and Workers. */
export function newId(prefix: string): string {
  const bytes = crypto.getRandomValues(new Uint8Array(10))
  return `${prefix}_${Array.from(bytes, (b) => (b % 36).toString(36)).join('')}`
}
