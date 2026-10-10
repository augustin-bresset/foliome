import { execFile } from 'node:child_process'
import { readFile, rename, rm, stat, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { promisify } from 'node:util'
import { type Asset, extOf, mimeOf } from '@foliome/core'

/**
 * Prepares uploaded files for the web, on the machine that hosts the editing
 * session. Photos arrive at 20 MB from a camera and videos in whatever the
 * phone recorded; neither should reach a visitor as is.
 *
 * - Images are straightened, stripped of their metadata (a photo's GPS
 *   position must not end up online), capped in size, and given smaller
 *   versions for small screens. HEIC and TIFF become JPEG.
 * - Videos are re-encoded to H.264/AAC MP4, at most 1080p, and get a poster.
 *
 * Each step needs a tool that may be missing (sharp, heic-convert, ffmpeg):
 * without it the file is simply kept as uploaded.
 */

const run = promisify(execFile)

const MAX_IMAGE = 3200
const VARIANT_WIDTHS = [640, 1280, 1920]
// Formats sharp re-encodes in place. GIF (animation) and SVG (vector) are left alone.
const REENCODE: Record<string, 'jpeg' | 'png' | 'webp' | 'avif'> = { jpg: 'jpeg', jpeg: 'jpeg', png: 'png', webp: 'webp', avif: 'avif' }

const loadSharp = async () => (await import('sharp')).default
type Sharp = Awaited<ReturnType<typeof loadSharp>>
type HeicConvert = (options: { buffer: Buffer; format: 'JPEG'; quality: number }) => Promise<ArrayBuffer>

export interface MediaTools {
  sharp: Sharp | null
  heic: HeicConvert | null
  ffmpeg: boolean
}

export async function detectTools(): Promise<MediaTools> {
  const optional = async <T>(load: () => Promise<T>): Promise<T | null> => load().catch(() => null)
  const sharp = await optional(loadSharp)
  // No types are published for heic-convert; its one function is described by HeicConvert above.
  const heic = await optional(async () => ((await import('heic-convert' as string)) as { default: HeicConvert }).default)
  const ffmpeg = await Promise.all([run('ffmpeg', ['-version']), run('ffprobe', ['-version'])]).then(
    () => true,
    () => false,
  )
  return { sharp, heic, ffmpeg }
}

export interface PrepareInput {
  /** Folder holding the uploaded file; everything derived from it is written alongside. */
  dir: string
  /** Name of the uploaded file inside `dir`. */
  file: string
  /** URL path `dir` is served from. */
  url: string
}

const stemOf = (file: string) => (extOf(file) ? file.slice(0, -(extOf(file).length + 1)) : file)

async function prepareImage({ dir, file, url }: PrepareInput, tools: MediaTools): Promise<Partial<Asset>> {
  const sharp = tools.sharp
  if (!sharp) return {}
  const stem = stemOf(file)
  let source = path.join(dir, file)
  let ext = extOf(file)

  if ((ext === 'heic' || ext === 'heif') && tools.heic) {
    const jpeg = Buffer.from(await tools.heic({ buffer: await readFile(source), format: 'JPEG', quality: 0.95 }))
    await rm(source)
    source = path.join(dir, `${stem}.source.jpg`)
    await writeFile(source, jpeg)
    ext = 'jpg'
  }

  const format = REENCODE[ext] ?? (ext === 'tif' || ext === 'tiff' ? 'jpeg' : null)
  if (!format) return {}

  const outExt = format === 'jpeg' ? 'jpg' : format
  const mainName = `${stem}.${outExt}`
  const mainTmp = path.join(dir, `${stem}.main.tmp`)

  // `rotate()` applies the camera's orientation; re-encoding drops all metadata.
  const base = () => sharp(source, { failOn: 'none' }).rotate()
  const resized = base().resize({ width: MAX_IMAGE, height: MAX_IMAGE, fit: 'inside', withoutEnlargement: true })
  const main =
    format === 'jpeg'
      ? resized.jpeg({ quality: 90, mozjpeg: true })
      : format === 'png'
        ? resized.png({ compressionLevel: 9 })
        : format === 'webp'
          ? resized.webp({ quality: 90 })
          : resized.avif({ quality: 70 })
  const info = await main.toFile(mainTmp)

  const variants: NonNullable<Asset['variants']> = []
  for (const width of VARIANT_WIDTHS) {
    if (width >= info.width) continue
    const name = `${stem}-${width}.webp`
    await base().resize({ width }).webp({ quality: 82 }).toFile(path.join(dir, name))
    variants.push({ path: `${url}/${name}`, width })
  }

  await rm(source)
  await rename(mainTmp, path.join(dir, mainName))
  return {
    path: `${url}/${mainName}`,
    name: mainName,
    mime: mimeOf(mainName),
    size: info.size,
    width: info.width,
    height: info.height,
    ...(variants.length > 0 ? { variants } : {}),
  }
}

async function probe(file: string): Promise<{ width: number; height: number; duration: number } | null> {
  try {
    const { stdout } = await run('ffprobe', [
      '-v', 'error', '-select_streams', 'v:0',
      '-show_entries', 'stream=width,height:stream_side_data=rotation:format=duration',
      '-of', 'json', file,
    ])
    const data = JSON.parse(stdout) as {
      streams?: { width?: number; height?: number; side_data_list?: { rotation?: number }[] }[]
      format?: { duration?: string }
    }
    const stream = data.streams?.[0]
    if (!stream?.width || !stream.height) return null
    // A phone held upright records a landscape frame plus a rotation.
    const sideways = Math.abs(stream.side_data_list?.find((d) => d.rotation !== undefined)?.rotation ?? 0) % 180 === 90
    return {
      width: sideways ? stream.height : stream.width,
      height: sideways ? stream.width : stream.height,
      duration: Number(data.format?.duration) || 0,
    }
  } catch {
    return null
  }
}

async function prepareVideo({ dir, file, url }: PrepareInput, tools: MediaTools): Promise<Partial<Asset>> {
  if (!tools.ffmpeg) return {}
  const stem = stemOf(file)
  const source = path.join(dir, file)
  const outTmp = path.join(dir, `${stem}.web.tmp.mp4`)
  const outName = `${stem}.mp4`
  const posterName = `${stem}-poster.jpg`

  try {
    await run(
      'ffmpeg',
      [
        '-y', '-i', source,
        '-map', '0:v:0', '-map', '0:a:0?',
        // At most 1080p, never enlarged, and even dimensions as H.264 requires.
        '-vf', "scale='min(1920,iw)':'min(1080,ih)':force_original_aspect_ratio=decrease:force_divisible_by=2",
        '-c:v', 'libx264', '-preset', 'medium', '-crf', '22', '-pix_fmt', 'yuv420p',
        '-c:a', 'aac', '-b:a', '160k',
        // Lets playback start before the whole file has arrived.
        '-movflags', '+faststart',
        outTmp,
      ],
      { maxBuffer: 64 * 1024 * 1024 },
    )
  } catch (err) {
    await rm(outTmp, { force: true })
    console.warn(`foliome: ${file} could not be re-encoded and is kept as uploaded.`, (err as Error).message.split('\n')[0])
    return {}
  }

  await rm(source)
  const out = path.join(dir, outName)
  await rename(outTmp, out)
  const info = await probe(out)
  const result: Partial<Asset> = { path: `${url}/${outName}`, name: outName, mime: 'video/mp4', size: (await stat(out)).size }
  if (!info) return result
  Object.assign(result, { width: info.width, height: info.height, duration: info.duration })

  try {
    const at = Math.min(1, info.duration / 2)
    await run('ffmpeg', ['-y', '-ss', String(at), '-i', out, '-frames:v', '1', '-q:v', '3', path.join(dir, posterName)])
    result.poster = { path: `${url}/${posterName}`, width: info.width, height: info.height }
  } catch {
    // A video without a poster still plays.
  }
  return result
}

/** Returns what changed about the file: its new path, type, size, and what was derived from it. */
export async function prepareFile(input: PrepareInput, tools: MediaTools): Promise<Partial<Asset>> {
  const mime = mimeOf(input.file)
  const ext = extOf(input.file)
  if (mime.startsWith('video/')) return prepareVideo(input, tools)
  if (mime.startsWith('image/') || ext === 'heic' || ext === 'heif') return prepareImage(input, tools)
  return {}
}
