// Fills the demo site with placeholder content: generated architectural
// drawings, a short film, a PDF and a 3D model, so every kind of file is
// represented. Images and video go through the same preparation as a real
// upload. Overwrites apps/demo/content/content.json and apps/demo/public/media/.
//
//   npm run seed

import { execFile } from 'node:child_process'
import { mkdir, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { detectTools, prepareFile } from '@foliome/server/media'

const demo = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'apps', 'demo')
const mediaDir = path.join(demo, 'public', 'media')

const INK = '#2a36a8'
const WASH = '#dbe1ee'

function prng(seed) {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

const n = (v) => Math.round(v * 10) / 10

function sheet(w, h, body) {
  const m = Math.round(Math.min(w, h) * 0.04)
  // Sheet border and an empty title block, as on a drawing ready to be filled in.
  const block = `<path d="M${w - m - 300} ${h - m - 90}H${w - m}M${w - m - 300} ${h - m - 90}V${h - m}M${w - m - 300} ${h - m - 45}H${w - m}M${w - m - 110} ${h - m - 90}V${h - m}" stroke-width="2"/>`
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${w} ${h}" width="${w}" height="${h}"><rect width="${w}" height="${h}" fill="${WASH}"/><g fill="none" stroke="${INK}" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><rect x="${m}" y="${m}" width="${w - 2 * m}" height="${h - 2 * m}" stroke-width="2"/>${block}${body}</g></svg>`
}

function tree(x, ground, size, r) {
  const cy = ground - size * 1.5
  let out = `<path d="M${n(x)} ${n(ground)}V${n(cy)}" stroke-width="2"/><circle cx="${n(x)}" cy="${n(cy)}" r="${n(size)}" stroke-width="2"/>`
  for (let i = 0; i < 5; i++) {
    const a = r() * Math.PI * 2
    out += `<path d="M${n(x)} ${n(cy)}L${n(x + Math.cos(a) * size * 0.8)} ${n(cy + Math.sin(a) * size * 0.8)}" stroke-width="1.5"/>`
  }
  return out
}

function elevation(seed, w = 1600, h = 1100) {
  const r = prng(seed)
  const ground = h * 0.74
  const bw = w * (0.4 + r() * 0.2)
  const bh = h * (0.22 + r() * 0.18)
  const bx = (w - bw) / 2 + (r() - 0.5) * w * 0.08
  const by = ground - bh
  const gable = r() > 0.4
  let out = `<path d="M${w * 0.07} ${ground}H${w * 0.93}" stroke-width="5"/>`
  for (let x = w * 0.08; x < w * 0.92; x += 26) out += `<path d="M${n(x)} ${n(ground + 10)}l-12 16" stroke-width="1.5"/>`

  out += `<rect x="${n(bx)}" y="${n(by)}" width="${n(bw)}" height="${n(bh)}"/>`
  if (gable) {
    const peak = by - bh * (0.35 + r() * 0.3)
    const ridge = bx + bw * (0.35 + r() * 0.3)
    out += `<path d="M${n(bx - 24)} ${n(by)}L${n(ridge)} ${n(peak)}L${n(bx + bw + 24)} ${n(by)}"/>`
    for (let i = 1; i < 9; i++) {
      const t = i / 9
      out += `<path d="M${n(bx + (ridge - bx) * t)} ${n(by + (peak - by) * t)}H${n(bx + bw + (ridge - bx - bw) * t)}" stroke-width="1"/>`
    }
  } else {
    out += `<path d="M${n(bx - 18)} ${n(by - 14)}H${n(bx + bw + 18)}"/>`
  }

  const cols = 3 + Math.floor(r() * 5)
  const rows = 1 + Math.floor(r() * 3)
  const bay = bw / cols
  const floor = bh / rows
  const door = Math.floor(r() * cols)
  for (let c = 0; c < cols; c++) {
    for (let row = 0; row < rows; row++) {
      const x = bx + c * bay + bay * 0.2
      const y = by + row * floor + floor * 0.2
      const ww = bay * 0.6
      if (row === rows - 1 && c === door) {
        out += `<rect x="${n(x)}" y="${n(y)}" width="${n(ww)}" height="${n(floor * 0.8)}" stroke-width="2.5"/>`
        continue
      }
      const wh = floor * 0.55
      out += `<rect x="${n(x)}" y="${n(y)}" width="${n(ww)}" height="${n(wh)}" stroke-width="2"/><path d="M${n(x + ww / 2)} ${n(y)}v${n(wh)}" stroke-width="1.5"/>`
    }
  }

  out += tree(bx - 90 - r() * 80, ground, 46 + r() * 30, r)
  out += tree(bx + bw + 100 + r() * 90, ground, 38 + r() * 40, r)

  const dim = ground + 90
  out += `<path d="M${n(bx)} ${dim}H${n(bx + bw)}" stroke-width="1.5"/>`
  for (let c = 0; c <= cols; c++) out += `<path d="M${n(bx + c * bay - 7)} ${dim + 7}l14 -14M${n(bx + c * bay)} ${dim - 16}v32" stroke-width="1.5"/>`
  return sheet(w, h, out)
}

function plan(seed, w = 1200, h = 1500) {
  const r = prng(seed)
  const x0 = w * 0.16
  const y0 = h * 0.14
  const pw = w * 0.68
  const ph = h * 0.62
  const wall = 16
  let out = `<rect x="${n(x0)}" y="${n(y0)}" width="${n(pw)}" height="${n(ph)}" stroke-width="4"/><rect x="${n(x0 + wall)}" y="${n(y0 + wall)}" width="${n(pw - 2 * wall)}" height="${n(ph - 2 * wall)}" stroke-width="2"/>`

  const split = (x, y, ww, hh, depth) => {
    if (depth === 0 || ww < 200 || hh < 200) {
      if (r() > 0.72) {
        const steps = 9
        const sw = Math.min(ww * 0.4, 150)
        for (let i = 0; i <= steps; i++) out += `<path d="M${n(x + 26)} ${n(y + 26 + i * 15)}h${n(sw)}" stroke-width="1.5"/>`
      }
      return
    }
    const t = 0.38 + r() * 0.24
    const gap = 62
    if (ww > hh) {
      const cx = x + ww * t
      const dy = y + hh * (0.2 + r() * 0.45)
      out += `<path d="M${n(cx)} ${n(y)}V${n(dy)}M${n(cx)} ${n(dy + gap)}V${n(y + hh)}"/><path d="M${n(cx)} ${n(dy)}h${gap}a${gap} ${gap} 0 0 1 -${gap} ${gap}" stroke-width="1.5"/>`
      split(x, y, ww * t, hh, depth - 1)
      split(cx, y, ww * (1 - t), hh, depth - 1)
    } else {
      const cy = y + hh * t
      const dx = x + ww * (0.2 + r() * 0.45)
      out += `<path d="M${n(x)} ${n(cy)}H${n(dx)}M${n(dx + gap)} ${n(cy)}H${n(x + ww)}"/><path d="M${n(dx)} ${n(cy)}v${gap}a${gap} ${gap} 0 0 0 ${gap} -${gap}" stroke-width="1.5"/>`
      split(x, y, ww, hh * t, depth - 1)
      split(x, cy, ww, hh * (1 - t), depth - 1)
    }
  }
  split(x0 + wall, y0 + wall, pw - 2 * wall, ph - 2 * wall, 3)

  const axes = 4
  for (let i = 0; i <= axes; i++) {
    const x = x0 + (pw * i) / axes
    out += `<path d="M${n(x)} ${n(y0 - 70)}V${n(y0 + ph + 40)}" stroke-width="1" stroke-dasharray="18 8 3 8"/><circle cx="${n(x)}" cy="${n(y0 - 92)}" r="20" stroke-width="1.5"/>`
  }
  const nx = w * 0.2
  const ny = h * 0.88
  out += `<circle cx="${n(nx)}" cy="${n(ny)}" r="44" stroke-width="1.5"/><path d="M${n(nx)} ${n(ny - 62)}l16 78l-16 -14l-16 14z" fill="${INK}" stroke-width="1.5"/>`
  return sheet(w, h, out)
}

function contours(seed, w = 1600, h = 1100) {
  const r = prng(seed)
  const cx = w * (0.4 + r() * 0.2)
  const cy = h * (0.4 + r() * 0.2)
  const waves = Array.from({ length: 4 }, (_, i) => ({ freq: i + 2, amp: 0.05 + r() * 0.07, phase: r() * Math.PI * 2 }))
  let out = ''
  for (let k = 1; k <= 13; k++) {
    const base = k * 48
    let d = ''
    for (let i = 0; i <= 96; i++) {
      const a = (i / 96) * Math.PI * 2
      const wobble = waves.reduce((sum, wave) => sum + Math.sin(a * wave.freq + wave.phase + k * 0.13) * wave.amp, 0)
      const radius = base * (1 + wobble)
      d += `${i === 0 ? 'M' : 'L'}${n(cx + Math.cos(a) * radius * 1.35)} ${n(cy + Math.sin(a) * radius)}`
    }
    out += `<path d="${d}Z" stroke-width="${k % 5 === 0 ? 2.5 : 1.2}"/>`
  }
  const angle = Math.round(r() * 50 - 25)
  out += `<g transform="rotate(${angle} ${n(cx)} ${n(cy)})"><rect x="${n(cx - 86)}" y="${n(cy - 44)}" width="172" height="88" fill="${INK}"/><rect x="${n(cx + 86)}" y="${n(cy - 20)}" width="74" height="40" fill="${WASH}"/><path d="M${n(cx - 86)} ${n(cy + 70)}H${n(cx - 520)}" stroke-width="2" stroke-dasharray="14 10"/></g>`
  return sheet(w, h, out)
}

// A minimal single-page PDF. Text is kept to ASCII so no font encoding is needed.
function pdf(lines) {
  const text = lines.map((line, i) => `BT /F1 ${i === 0 ? 26 : 12} Tf 72 ${760 - i * 26 - (i > 0 ? 20 : 0)} Td (${line.replace(/[()\\]/g, '\\$&')}) Tj ET`).join('\n')
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>',
    `<< /Length ${text.length} >>\nstream\n${text}\nendstream`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
  ]
  let out = '%PDF-1.4\n'
  const offsets = objects.map((body, i) => {
    const at = out.length
    out += `${i + 1} 0 obj\n${body}\nendobj\n`
    return at
  })
  const xref = out.length
  out += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.map((at) => `${String(at).padStart(10, '0')} 00000 n \n`).join('')}`
  out += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`
  return Buffer.from(out, 'latin1')
}

// A massing model as binary glTF: a volume with a gable roof, on a base plate.
function glb() {
  const tris = []
  const quad = (a, b, c, d) => tris.push([a, b, c], [a, c, d])
  const box = (x0, y0, z0, x1, y1, z1) => {
    quad([x0, y0, z1], [x1, y0, z1], [x1, y1, z1], [x0, y1, z1])
    quad([x1, y0, z0], [x0, y0, z0], [x0, y1, z0], [x1, y1, z0])
    quad([x0, y0, z0], [x0, y0, z1], [x0, y1, z1], [x0, y1, z0])
    quad([x1, y0, z1], [x1, y0, z0], [x1, y1, z0], [x1, y1, z1])
    quad([x0, y1, z1], [x1, y1, z1], [x1, y1, z0], [x0, y1, z0])
    quad([x0, y0, z0], [x1, y0, z0], [x1, y0, z1], [x0, y0, z1])
  }
  box(-4, -0.15, -3, 4, 0, 3)
  box(-2.4, 0, -1.3, 2.4, 1.7, 1.3)
  const ridge = 2.9
  quad([-2.6, 1.7, 1.5], [2.6, 1.7, 1.5], [2.6, ridge, 0], [-2.6, ridge, 0])
  quad([2.6, 1.7, -1.5], [-2.6, 1.7, -1.5], [-2.6, ridge, 0], [2.6, ridge, 0])
  tris.push([[-2.4, 1.7, 1.3], [-2.4, ridge, 0], [-2.4, 1.7, -1.3]], [[2.4, 1.7, -1.3], [2.4, ridge, 0], [2.4, 1.7, 1.3]])

  const positions = new Float32Array(tris.length * 9)
  const normals = new Float32Array(tris.length * 9)
  const min = [Infinity, Infinity, Infinity]
  const max = [-Infinity, -Infinity, -Infinity]
  tris.forEach(([a, b, c], t) => {
    const u = b.map((v, i) => v - a[i])
    const v = c.map((value, i) => value - a[i])
    const normal = [u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]]
    const length = Math.hypot(...normal) || 1
    ;[a, b, c].forEach((p, k) => {
      for (let i = 0; i < 3; i++) {
        positions[t * 9 + k * 3 + i] = p[i]
        normals[t * 9 + k * 3 + i] = normal[i] / length
        min[i] = Math.min(min[i], p[i])
        max[i] = Math.max(max[i], p[i])
      }
    })
  })

  const bin = Buffer.concat([Buffer.from(positions.buffer), Buffer.from(normals.buffer)])
  const json = {
    asset: { version: '2.0', generator: 'foliome seed' },
    scene: 0,
    scenes: [{ nodes: [0] }],
    nodes: [{ mesh: 0 }],
    meshes: [{ primitives: [{ attributes: { POSITION: 0, NORMAL: 1 }, material: 0 }] }],
    materials: [{ pbrMetallicRoughness: { baseColorFactor: [0.86, 0.88, 0.93, 1], metallicFactor: 0, roughnessFactor: 0.9 } }],
    buffers: [{ byteLength: bin.length }],
    bufferViews: [
      { buffer: 0, byteOffset: 0, byteLength: positions.byteLength, target: 34962 },
      { buffer: 0, byteOffset: positions.byteLength, byteLength: normals.byteLength, target: 34962 },
    ],
    accessors: [
      { bufferView: 0, componentType: 5126, count: tris.length * 3, type: 'VEC3', min, max },
      { bufferView: 1, componentType: 5126, count: tris.length * 3, type: 'VEC3' },
    ],
  }
  let text = JSON.stringify(json)
  while (text.length % 4) text += ' '
  const head = Buffer.alloc(12)
  head.writeUInt32LE(0x46546c67, 0)
  head.writeUInt32LE(2, 4)
  head.writeUInt32LE(12 + 8 + text.length + 8 + bin.length, 8)
  const chunk = (type, data) => {
    const h = Buffer.alloc(8)
    h.writeUInt32LE(data.length, 0)
    h.writeUInt32LE(type, 4)
    return Buffer.concat([h, data])
  }
  return Buffer.concat([head, chunk(0x4e4f534a, Buffer.from(text)), chunk(0x004e4942, bin)])
}

const tools = await detectTools()
await rm(mediaDir, { recursive: true, force: true })

let counter = 0
async function slot() {
  const id = `a_seed${String(++counter).padStart(3, '0')}`
  const dir = path.join(mediaDir, id)
  await mkdir(dir, { recursive: true })
  return { id, dir, url: `/media/${id}` }
}

/** A file kept exactly as written: documents, 3D models. */
async function file(name, data, mime, kind, extra = {}) {
  const { id, dir, url } = await slot()
  await writeFile(path.join(dir, name), data)
  return { id, path: `${url}/${name}`, name, mime, size: Buffer.byteLength(data), kind, ...extra }
}

/** A drawing, delivered the way an artist's photo would be: a large JPEG that the upload preparation then resizes. */
async function drawing(name, kind, seed, landscape = true, caption) {
  const [w, h] = landscape ? [1600, 1100] : [1200, 1500]
  const svg = { elevation, plan, contours }[kind](seed, w, h)
  const extra = caption ? { caption } : {}
  if (!tools.sharp) return file(`${name}.svg`, svg, 'image/svg+xml', 'image', { width: w, height: h, ...extra })

  const { id, dir, url } = await slot()
  const jpg = `${name}.jpg`
  await tools.sharp(Buffer.from(svg), { density: 144 }).resize({ width: landscape ? 2400 : 1800 }).jpeg({ quality: 92 }).toFile(path.join(dir, jpg))
  return { id, path: `${url}/${jpg}`, name: jpg, mime: 'image/jpeg', size: 0, kind: 'image', ...(await prepareFile({ dir, file: jpg, url }, tools)), ...extra }
}

/** A slow move across a drawing, encoded then prepared like an uploaded video. Needs ffmpeg. */
async function film(name, seed, caption) {
  if (!tools.ffmpeg || !tools.sharp) return null
  const { id, dir, url } = await slot()
  const still = path.join(dir, 'still.jpg')
  await tools.sharp(Buffer.from(contours(seed, 1600, 900)), { density: 144 }).resize({ width: 2560 }).jpeg({ quality: 92 }).toFile(still)
  const raw = `${name}.mov`
  await promisify(execFile)('ffmpeg', [
    '-y', '-loop', '1', '-i', still,
    '-vf', "zoompan=z='min(zoom+0.0007,1.2)':d=175:x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':s=1920x1080:fps=25",
    '-t', '7', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', path.join(dir, raw),
  ])
  await rm(still)
  return { id, path: `${url}/${raw}`, name: raw, mime: 'video/quicktime', size: 0, kind: 'video', ...(await prepareFile({ dir, file: raw, url }, tools)), caption }
}

// Content helpers: a value per language, formatted paragraphs, list items.
const t = (fr, en) => ({ $t: { fr, en } })
const rich = (...paragraphs) => paragraphs.map((p) => (typeof p === 'string' ? [{ text: p }] : p))
let serial = 0
const item = (fields) => ({ id: `i_seed${String(++serial).padStart(3, '0')}`, ...fields })
const credit = (fr, en, name) => item({ role: t(fr, en), name })
const text = (fr, en) => item({ type: 'texte', text: t(fr, en) })
const gallery = (...files) => item({ type: 'galerie', files: files.filter(Boolean) })
const quote = (fr, en, author) => item({ type: 'citation', quote: t(fr, en), author })

const content = {
  site: {
    name: 'Atelier Morane',
    baseline: t('Architecture en territoire de pente, entre Arve et Giffre.', 'Architecture on sloping ground, between the Arve and the Giffre.'),
    about: t(
      rich(
        [
          { text: 'L’atelier construit peu, et ' },
          { text: 'toujours en montagne', bold: true },
          { text: '. Chaque projet part du terrain : sa pente, son eau, ce que l’hiver en fait. Nous dessinons des bâtiments compacts, en bois et en pierre du pays, pensés pour être entretenus par ceux qui les habitent.' },
        ],
        'Fondé en 2014 à Sallanches, l’atelier réunit quatre architectes et travaille avec les mêmes charpentiers depuis ses débuts.',
      ),
      rich(
        [
          { text: 'The studio builds little, and ' },
          { text: 'always in the mountains', bold: true },
          { text: '. Each project starts from the ground: its slope, its water, what winter does to it. We draw compact buildings in local timber and stone, meant to be looked after by the people who live in them.' },
        ],
        'Founded in 2014 in Sallanches, the studio brings together four architects and has worked with the same carpenters since its first day.',
      ),
    ),
    portrait: await drawing('atelier', 'contours', 11),
    contact: { address: '12 quai de l’Arve\n74700 Sallanches', email: 'bonjour@atelier-morane.example', phone: '04 50 00 00 00' },
  },
  projects: [
    {
      id: 'p_refuge',
      slug: 'refuge-de-la-combe-noire',
      title: 'Refuge de la Combe Noire',
      year: '2024',
      place: 'Vallorcine',
      program: 'Équipement public',
      surface: '310 m²',
      summary: t(
        'Un refuge de trente-deux couchages à 2 180 m, héliporté en onze rotations et monté en six semaines.',
        'A thirty-two-bed mountain hut at 2,180 m, flown in over eleven helicopter rotations and assembled in six weeks.',
      ),
      cover: await drawing('combe-noire-facade-sud', 'elevation', 3),
      credits: [
        credit('Maîtrise d’ouvrage', 'Client', 'Commune de Vallorcine'),
        credit('Charpente', 'Timber frame', 'Scierie du Giffre'),
        credit('Photographies', 'Photographs', 'Lise Arnaud'),
      ],
      sections: [
        text(
          rich(
            'Le bâtiment tourne le dos au couloir d’avalanche et s’ouvre au sud-est, vers le lever du jour. Sa structure en épicéa lamellé a été préfabriquée dans la vallée, par modules dimensionnés pour l’hélicoptère.',
            [
              { text: 'Le socle en pierre du site abrite le local hors-sac, ' },
              { text: 'accessible tout l’hiver sans gardien', italic: true },
              { text: '. Le chantier est raconté dans le ' },
              { text: 'carnet de l’atelier', href: '/#atelier' },
              { text: '.' },
            ],
          ),
          rich(
            'The building turns its back on the avalanche path and opens to the south-east, towards sunrise. Its laminated spruce frame was prefabricated in the valley, in modules sized for the helicopter.',
            [
              { text: 'The plinth, built with stone from the site, houses the winter room, ' },
              { text: 'open all winter with no warden', italic: true },
              { text: '. The building site is told in the ' },
              { text: 'studio’s notebook', href: '/en#atelier' },
              { text: '.' },
            ],
          ),
        ),
        gallery(
          await drawing('combe-noire-plan-de-masse', 'contours', 5, true, 'Plan de masse, courbes de niveau tous les cinq mètres'),
          await drawing('combe-noire-niveau-1', 'plan', 8, false, 'Niveau 1, dortoirs'),
          await film('combe-noire-survol', 5, 'Survol du site'),
        ),
        quote('On y mange face à la combe.', 'You eat facing the combe.', 'Le gardien'),
        gallery(
          await file('combe-noire-maquette.glb', glb(), 'model/gltf-binary', 'model', { caption: 'Maquette de volume' }),
          await drawing('combe-noire-facade-est', 'elevation', 21, true, 'Façade est'),
          await file(
            'combe-noire-notice.pdf',
            pdf(['Refuge de la Combe Noire', 'Notice descriptive', 'Atelier Morane, 2024', 'Structure epicea lamelle, socle en pierre du site.']),
            'application/pdf',
            'pdf',
            { caption: 'Notice descriptive' },
          ),
        ),
      ],
    },
    {
      id: 'p_halle',
      slug: 'halle-aux-grains',
      title: 'Halle aux grains',
      year: '2023',
      place: 'Bonneville',
      program: 'Réhabilitation',
      surface: '1 240 m²',
      summary: t(
        'Une halle de 1887 devenue marché couvert et salle de quartier, sans toucher à sa charpente.',
        'An 1887 grain hall turned covered market and neighbourhood room, without touching its roof frame.',
      ),
      cover: await drawing('halle-facade', 'elevation', 34),
      credits: [credit('Maîtrise d’ouvrage', 'Client', 'Ville de Bonneville'), credit('Structure', 'Structure', 'BE Chablais')],
      sections: [
        text(
          rich(
            'La halle était fermée depuis vingt ans. Le projet retire tout ce qui avait été ajouté, puis glisse sous la charpente deux volumes bas en bois qui ne la touchent nulle part.',
            'Le sol en béton désactivé se prolonge sur le parvis : les jours de marché, les étals débordent dehors.',
          ),
          rich(
            'The hall had been closed for twenty years. The project removes everything that had been added, then slides two low timber volumes under the roof frame without touching it anywhere.',
            'The exposed-aggregate concrete floor runs out onto the forecourt: on market days, the stalls spill outside.',
          ),
        ),
        gallery(
          await drawing('halle-rez-de-chaussee', 'plan', 13, false, 'Rez-de-chaussée'),
          await drawing('halle-facade-nord', 'elevation', 55, true, 'Façade nord, sur le parvis'),
          await drawing('halle-situation', 'contours', 89, true, 'Plan de situation'),
        ),
      ],
    },
    {
      id: 'p_maison',
      slug: 'maison-sur-la-pente',
      title: 'Maison sur la pente',
      year: '2022',
      place: 'Talloires',
      program: 'Logement',
      surface: '148 m²',
      summary: t('Trois demi-niveaux posés sur un terrain à 38 %, pour ne rien terrasser.', 'Three half-levels set on a 38% slope, so that nothing is levelled.'),
      cover: await drawing('maison-pente-facade', 'elevation', 144),
      credits: [credit('Pierre sèche', 'Dry stone', 'Les Murs du Lac')],
      sections: [
        text(
          rich(
            'La maison suit la pente au lieu de la corriger. On entre par le haut, côté route, et l’on descend vers le lac de demi-niveau en demi-niveau.',
            'Chaque palier donne sur une terrasse de plain-pied, tenue par un mur en pierre sèche remonté avec les blocs trouvés sur place.',
          ),
          rich(
            'The house follows the slope instead of correcting it. You enter from the top, on the road side, and walk down towards the lake half a level at a time.',
            'Each landing opens onto a terrace at the same level, held by a dry-stone wall rebuilt with the blocks found on site.',
          ),
        ),
        gallery(
          await drawing('maison-pente-terrain', 'contours', 233, true, 'Le terrain avant travaux'),
          await drawing('maison-pente-niveau-haut', 'plan', 377, false, 'Niveau haut, entrée et séjour'),
        ),
      ],
    },
    {
      id: 'p_chai',
      slug: 'chai-des-roches',
      title: 'Chai des Roches',
      year: '2021',
      place: 'Ayse',
      program: 'Équipement public',
      surface: '520 m²',
      summary: t('Un chai semi-enterré pour une coopérative de sept vignerons.', 'A half-buried winery for a cooperative of seven winegrowers.'),
      cover: await drawing('chai-facade', 'elevation', 610),
      credits: [],
      sections: [
        text(
          rich('Le chai s’enfonce dans le coteau pour garder les cuves à température sans machine. Seule la salle de dégustation émerge, sous un toit à une pente tourné vers les vignes.'),
          rich('The winery digs into the hillside to keep the vats at temperature without machines. Only the tasting room emerges, under a single-pitch roof turned towards the vines.'),
        ),
        gallery(await drawing('chai-plan', 'plan', 987, false, 'Niveau des cuves'), await drawing('chai-coteau', 'contours', 1597, true, 'Le coteau')),
      ],
    },
  ],
}

await mkdir(path.join(demo, 'content'), { recursive: true })
await writeFile(path.join(demo, 'content', 'content.json'), `${JSON.stringify(content, null, 2)}\n`)
const missing = [!tools.sharp && 'sharp', !tools.ffmpeg && 'ffmpeg'].filter(Boolean)
console.log(`Démo remplie : ${content.projects.length} projets, ${counter} fichiers.${missing.length ? ` Sans ${missing.join(' ni ')} : médias simplifiés.` : ''}`)
