import type { FileKind } from './types.ts'

const MIME_BY_EXT: Record<string, string> = {
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  png: 'image/png',
  gif: 'image/gif',
  webp: 'image/webp',
  avif: 'image/avif',
  svg: 'image/svg+xml',
  tif: 'image/tiff',
  tiff: 'image/tiff',
  heic: 'image/heic',
  psd: 'image/vnd.adobe.photoshop',
  mp4: 'video/mp4',
  m4v: 'video/mp4',
  webm: 'video/webm',
  mov: 'video/quicktime',
  mp3: 'audio/mpeg',
  wav: 'audio/wav',
  ogg: 'audio/ogg',
  flac: 'audio/flac',
  m4a: 'audio/mp4',
  aac: 'audio/aac',
  pdf: 'application/pdf',
  glb: 'model/gltf-binary',
  gltf: 'model/gltf+json',
  obj: 'model/obj',
  stl: 'model/stl',
  usdz: 'model/vnd.usdz+zip',
  dwg: 'image/vnd.dwg',
  dxf: 'image/vnd.dxf',
  zip: 'application/zip',
  json: 'application/json',
  txt: 'text/plain',
  csv: 'text/csv',
  md: 'text/markdown',
}

/** Image types every current browser can show in an <img>. Anything else (TIFF, PSD, DWG…) is a plain file. */
const DISPLAYABLE_IMAGES = new Set([
  'image/jpeg',
  'image/png',
  'image/gif',
  'image/webp',
  'image/avif',
  'image/svg+xml',
])

const MODEL_EXT = new Set(['glb', 'gltf', 'obj', 'stl', 'usdz', 'fbx', 'ply', '3mf', '3dm', 'skp', 'ifc', 'step', 'stp'])

export function extOf(name: string): string {
  const base = name.slice(Math.max(name.lastIndexOf('/'), name.lastIndexOf('\\')) + 1)
  const i = base.lastIndexOf('.')
  const ext = i > 0 ? base.slice(i + 1).toLowerCase() : ''
  return /^[a-z0-9]{1,10}$/.test(ext) ? ext : ''
}

/** Browsers report an empty type for many formats (3D models, CAD); fall back to the extension. */
export function mimeOf(name: string, reported?: string | null): string {
  const type = (reported ?? '').split(';')[0]!.trim().toLowerCase()
  if (type && type !== 'application/octet-stream') return type
  return MIME_BY_EXT[extOf(name)] ?? 'application/octet-stream'
}

export function kindOf(mime: string, name: string): FileKind {
  if (MODEL_EXT.has(extOf(name)) || mime.startsWith('model/')) return 'model'
  if (DISPLAYABLE_IMAGES.has(mime)) return 'image'
  if (mime.startsWith('video/')) return 'video'
  if (mime.startsWith('audio/')) return 'audio'
  if (mime === 'application/pdf') return 'pdf'
  return 'file'
}

const PICKER: Record<FileKind, string> = {
  image: 'image/jpeg,image/png,image/gif,image/webp,image/avif,image/svg+xml',
  video: 'video/*',
  audio: 'audio/*',
  pdf: 'application/pdf,.pdf',
  model: [...MODEL_EXT].map((ext) => `.${ext}`).join(','),
  file: '',
}

const KIND_NAMES: Record<FileKind, string> = {
  image: 'une image (JPEG, PNG, WebP, AVIF, GIF ou SVG)',
  video: 'une vidéo',
  audio: 'un son',
  pdf: 'un PDF',
  model: 'un modèle 3D',
  file: 'un fichier',
}

/** Value for a file input's `accept`, so the picker only offers what the field can take. */
export function pickerAccept(kinds: FileKind[] | undefined): string | undefined {
  if (!kinds || kinds.length === 0 || kinds.includes('file')) return undefined
  return kinds.map((kind) => PICKER[kind]).join(',')
}

/** "une image (…) ou une vidéo", for telling the artist what a field expects. */
export function describeKinds(kinds: FileKind[]): string {
  const names = kinds.map((kind) => KIND_NAMES[kind])
  return names.length > 1 ? `${names.slice(0, -1).join(', ')} ou ${names.at(-1)}` : (names[0] ?? '')
}

/** Keeps a file name readable while making it safe as a URL segment and on any file system. */
export function safeFileName(name: string): string {
  const ext = extOf(name)
  const stem = (ext ? name.slice(0, -(ext.length + 1)) : name)
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .replace(/[^a-zA-Z0-9_-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80)
  return (stem || 'fichier') + (ext ? `.${ext}` : '')
}

export function formatSize(bytes: number): string {
  if (bytes < 1000) return `${bytes} o`
  if (bytes < 1e6) return `${Math.round(bytes / 1e3)} Ko`
  if (bytes < 1e9) return `${(bytes / 1e6).toFixed(bytes < 1e7 ? 1 : 0).replace('.', ',')} Mo`
  return `${(bytes / 1e9).toFixed(1).replace('.', ',')} Go`
}
