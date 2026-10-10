export type FileKind = 'image' | 'video' | 'audio' | 'pdf' | 'model' | 'file'

/** A file uploaded by the artist. Stored inline in the content wherever it is used. */
export interface Asset {
  id: string
  /** URL path of the file, relative to the media origin (the site itself in local mode). */
  path: string
  /** Original file name, for display and downloads. */
  name: string
  mime: string
  size: number
  kind: FileKind
  width?: number
  height?: number
  duration?: number
  caption?: string
  /** Smaller versions of an image, narrowest first. */
  variants?: { path: string; width: number }[]
  /** Still frame shown before a video plays. */
  poster?: { path: string; width: number; height: number }
}

/** Formatted text: paragraphs made of runs. Safe to render because it is data, never markup. */
export type RichText = RichSpan[][]

export interface RichSpan {
  text: string
  bold?: true
  italic?: true
  href?: string
}

/** A value that exists once per language of the site. */
export interface Translated<T = unknown> {
  $t: Record<string, T>
}

interface FieldBase {
  label: string
  help?: string
}

interface Translatable {
  /** Keep one value per language. Needs `locales` in the site's configuration. */
  translate?: boolean
}

export type TextDef = FieldBase & Translatable & { type: 'text'; placeholder?: string }
export type LongTextDef = FieldBase & Translatable & { type: 'longtext'; placeholder?: string }
/** Text with bold, italic and links. */
export type RichTextDef = FieldBase & Translatable & { type: 'richtext' }
export type SelectDef = FieldBase & { type: 'select'; options: string[] }
/** `kinds` restricts what can be added, e.g. `['image']` for a cover. Without it, any file is accepted. */
export type FileDef = FieldBase & { type: 'file'; kinds?: FileKind[] }
export type FilesDef = FieldBase & { type: 'files'; kinds?: FileKind[] }

/** A fixed set of fields that exists once, e.g. the studio's presentation. */
export type GroupDef = FieldBase & { type: 'group'; fields: Fields }

/** What one item of a list is made of. */
export interface ItemType {
  /** Name of one item, e.g. "Projet" or "Citation". */
  label: string
  /** Field shown as the item's name in the editor. */
  titleField?: string
  fields: Fields
}

/**
 * Items the artist can add, reorder and remove: projects, credits, the
 * sections of a page. Give `fields` when every item has the same shape, or
 * `types` to offer several kinds of item (each item then records its `type`).
 * Lists nest: an item's fields can contain other lists.
 */
export type ListDef = FieldBase & {
  type: 'list'
  /** Name of one item when the list has a single shape. Defaults to `label`. */
  itemLabel?: string
  /** Button label for adding an item, e.g. "Nouveau projet". A top-level list with one gets a button in the toolbar. */
  addLabel?: string
  titleField?: string
  /** Page of an item, e.g. "/projets/{slug}". Items then get a `slug`, set once from their title. */
  path?: string
  fields?: Fields
  types?: Record<string, ItemType>
}

export type FieldDef = TextDef | LongTextDef | RichTextDef | SelectDef | FileDef | FilesDef | GroupDef | ListDef
export type Fields = Record<string, FieldDef>

export interface Schema {
  /** Everything the artist can edit: the top level of the content file. */
  content: Fields
  /** Languages of the site, default first. Omit for a single-language site. */
  locales?: string[]
}

export type Doc = Record<string, unknown>

export interface Item {
  id: string
  /** Which of the list's `types` this item is. */
  type?: string
  slug?: string
  [field: string]: unknown
}

export type Op =
  | { op: 'set'; path: string; value: unknown }
  | { op: 'insert'; path: string; value: { id: string } & Record<string, unknown>; index?: number }
  | { op: 'remove'; path: string }
  | { op: 'move'; path: string; index: number }
