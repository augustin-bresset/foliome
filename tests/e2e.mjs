// A whole editing session, driven in a real browser the way the artist would
// go through it: over the network address, with the access code.
//
//   npm run test:e2e
//
// Resets the demo content before and after, and runs its own dev server on a
// separate port. Needs Chrome or Chromium (CHROME=/path/to/chrome to choose).
// Video checks need ffmpeg. HEIC_SAMPLE=/path/to/photo.heic adds the HEIC check.

import { execFile, spawn } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { cp, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { chromium } from 'playwright-core'
import sharp from 'sharp'

const run = promisify(execFile)
const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..')
const DEMO = path.join(ROOT, 'apps', 'demo')
const PORT = 4391

const chrome =
  process.env.CHROME ??
  ['/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser', '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'].find(existsSync)
if (!chrome) throw new Error('No Chrome found. Set CHROME=/path/to/chrome.')

const sh = (command, options = {}) =>
  new Promise((done) => {
    const child = spawn(command, { shell: true, stdio: 'ignore', ...options })
    child.on('close', done)
  })
const hasFfmpeg = await run('ffmpeg', ['-version']).then(
  () => true,
  () => false,
)

/* Fixtures */

const tmp = await mkdtemp(path.join(os.tmpdir(), 'foliome-e2e-'))
const fx = (name) => path.join(tmp, name)

// A camera photo: bigger than the site keeps, held sideways, carrying a GPS position.
await sharp({ create: { width: 4000, height: 3000, channels: 3, background: { r: 42, g: 54, b: 168 } } })
  .withExif({ IFD0: { Copyright: 'Test' }, IFD3: { GPSLatitudeRef: 'N', GPSLatitude: '45/1 55/1 30/1', GPSLongitudeRef: 'E', GPSLongitude: '6/1 42/1 0/1' } })
  .withMetadata({ orientation: 6 })
  .jpeg({ quality: 90 })
  .toFile(fx('Photo chantier (été).jpg'))
await writeFile(fx('plan-masse.dwg'), crypto.getRandomValues(new Uint8Array(30000)))
await writeFile(fx('descriptif.zip'), crypto.getRandomValues(new Uint8Array(12000)))
if (hasFfmpeg) {
  await run('ffmpeg', ['-y', '-f', 'lavfi', '-i', 'testsrc=duration=2:size=642x362:rate=25', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=2', '-c:v', 'mpeg4', '-c:a', 'pcm_s16le', fx('visite.mov')])
  await run('ffmpeg', ['-y', '-f', 'lavfi', '-i', 'sine=frequency=330:duration=1', fx('ambiance.mp3')])
}
const heic = process.env.HEIC_SAMPLE && existsSync(process.env.HEIC_SAMPLE) ? fx('IMG_4012.HEIC') : null
if (heic) await cp(process.env.HEIC_SAMPLE, heic)

/* Server */

const seed = () => run('node', [path.join(ROOT, 'scripts', 'seed-demo.mjs')])
await seed()
await rm(path.join(DEMO, '.foliome', 'history'), { recursive: true, force: true })
await rm(path.join(DEMO, 'dist'), { recursive: true, force: true })
for (const dir of await readdir(path.join(DEMO, 'public', 'media'))) {
  if (existsSync(path.join(DEMO, 'public', 'media', dir, 'combe-noire-maquette.glb'))) {
    await cp(path.join(DEMO, 'public', 'media', dir, 'combe-noire-maquette.glb'), fx('maquette-v2.glb'))
  }
}

await sh('npx astro dev stop', { cwd: DEMO })
// "Mettre en ligne" runs this command. A build is enough to check the whole path.
await sh(`npx astro dev --host --port ${PORT}`, { cwd: DEMO, env: { ...process.env, FOLIOME_PUBLISH: 'npm run build' } })
const local = `http://localhost:${PORT}`
for (let i = 0; ; i++) {
  if (await fetch(`${local}/_foliome/session`).then((r) => r.ok, () => false)) break
  if (i > 60) throw new Error('The dev server did not start.')
  await new Promise((r) => setTimeout(r, 500))
}
const stored = JSON.parse(readFileSync(path.join(DEMO, '.foliome', 'local.json'), 'utf8')).code
const CODE = `${stored.slice(0, 4)}-${stored.slice(4)}`
const lan = Object.entries(os.networkInterfaces())
  .filter(([name]) => !/^(docker|br-|veth|virbr|vmnet|vboxnet)/.test(name))
  .flatMap(([, list]) => list ?? [])
  .find((i) => i.family === 'IPv4' && !i.internal)?.address
// Without a network the session still runs, as the developer on this machine.
const BASE = lan ? `http://${lan}:${PORT}` : local

/* Session */

const content = () => JSON.parse(readFileSync(path.join(DEMO, 'content', 'content.json'), 'utf8'))
const project = (id) => content().projects.find((p) => p.id === id)
const browser = await chromium.launch({ executablePath: chrome, args: ['--no-sandbox'] })
const page = await (await browser.newContext({ viewport: { width: 1440, height: 900 } })).newPage()
const problems = []
page.on('console', (m) => m.type() === 'error' && problems.push(`console: ${m.text()}`))
page.on('pageerror', (e) => problems.push(`pageerror: ${e}`))
page.on('response', (r) => r.status() >= 400 && problems.push(`${r.status()} ${r.request().method()} ${new URL(r.url()).pathname}`))

const results = []
const check = (name, ok, detail = '') => results.push(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok || !detail ? '' : `  — ${detail}`}`)
const skip = (name, why) => results.push(`SKIP  ${name}  — ${why}`)
const ed = (selector, options) => page.locator(`foliome-editor ${selector}`, options)
const settled = async () => {
  await page.waitForLoadState('networkidle')
  await page.waitForTimeout(500)
}
const pause = (ms = 300) => page.waitForTimeout(ms)
const pathname = () => new URL(page.url()).pathname
// Every stored change reloads the page. Waiting for "the network to go quiet"
// can be satisfied by the page about to be replaced: wait for the new one, and
// for the editor to be back on it.
const reloads = async (action) => {
  await page.evaluate(() => {
    window.__previous = true
  })
  await action()
  await page.waitForFunction(() => !window.__previous && !!document.querySelector('foliome-editor')?.shadowRoot?.querySelector('.bar'), null, { timeout: 180000 })
  await settled()
}
const save = () => reloads(() => ed('.panel button[type=submit]').click())
const visit = async (url) => {
  await page.goto(url)
  await settled()
  await ed('.bar').waitFor({ timeout: 30000 })
}
const bar = (label) => ed('.bar-btn', { hasText: label })
const text = (locator) => locator.textContent()
const shots = process.env.SHOTS
let shot = 0
const snap = async (name) => shots && page.screenshot({ path: path.join(shots, `${String(++shot).padStart(2, '0')}-${name}.png`) })

try {
  /* Access */
  if (lan) {
    await page.goto(`${BASE}/?edit`)
    await settled()
    check('code prompt for a visitor from the network', await ed('.panel.is-narrow').isVisible())
    await ed('#foliome-code').fill('AAAA-BBBB')
    await ed('button[type=submit]').click()
    await pause(400)
    check('wrong code is refused', (await text(ed('.error')))?.includes('pas le bon'))
    await ed('#foliome-code').fill(CODE.toLowerCase().replace('-', ' '))
    await ed('button[type=submit]').click()
    await pause(800)
  } else {
    skip('access code', 'no network interface')
    await page.goto(`${BASE}/?edit`)
    await settled()
  }
  check('editor opens', await ed('.bar').isVisible())
  check('?edit leaves the address bar', !page.url().includes('edit'))

  /* A text on the home page */
  const halle = page.locator('[data-foliome="projects.p_halle.title"]')
  await halle.hover()
  await pause()
  check('hovering a zone shows its name', (await text(ed('.tag')))?.startsWith('Titre'))
  await snap('hover')
  await halle.click()
  await pause()
  check('clicking a zone opens its panel instead of following the link', (await ed('.panel').isVisible()) && pathname() === '/')
  await ed('.panel input.input').fill('Halle aux grains de Bonneville')
  await save()
  check('text saved to the content file', project('p_halle').title === 'Halle aux grains de Bonneville')
  check('page shows it, with a confirmation', (await text(halle)) === 'Halle aux grains de Bonneville' && (await text(ed('.toast'))) === 'Enregistré')
  check('the page address does not follow the title', project('p_halle').slug === 'halle-aux-grains')

  await halle.click()
  await pause(200)
  await ed('.panel input.input').fill('Brouillon non enregistré')
  await page.locator('[data-foliome="projects.p_maison.title"]').click()
  await pause()
  check('unsaved text is not thrown away by a stray click', (await ed('.panel input.input').inputValue()) === 'Brouillon non enregistré' && (await ed('.nudge').count()) === 1)
  await ed('.panel-foot .btn:not(.is-primary)').click()
  await pause(200)
  check('cancel closes without saving', (await ed('.panel').count()) === 0 && project('p_halle').title === 'Halle aux grains de Bonneville')

  await page.locator('[data-foliome="projects.p_refuge.title"]').hover()
  await pause(250)
  await ed('.tag-btn.is-quiet').click()
  await page.waitForURL('**/projets/refuge-de-la-combe-noire')
  await settled()
  check('"Ouvrir la page" follows the site’s own link', pathname() === '/projets/refuge-de-la-combe-noire')
  check('editor survives the page transition', await ed('.bar').isVisible())

  /* Effects: a title split letter by letter, content under a canvas */
  await page.evaluate(() => sessionStorage.clear())
  await visit(`${BASE}/projets/refuge-de-la-combe-noire`)
  await pause(1200)
  check('the site splits its title into letters', (await page.locator('.project-title div').count()) > 10)
  await page.locator('.project-title').click({ position: { x: 60, y: 40 } })
  await pause()
  check('a split title still opens its panel', (await text(ed('.panel-title'))) === 'Titre' && (await ed('.panel input.input').inputValue()) === 'Refuge de la Combe Noire')
  await page.keyboard.press('Escape')
  await pause(150)
  check('Escape closes the panel', (await ed('.panel').count()) === 0)

  // What a WebGL site does: the real image stays in the page, invisible, under a canvas that redraws it.
  await page.evaluate(() => {
    const canvas = document.createElement('canvas')
    canvas.id = 'fake-webgl'
    canvas.style.cssText = 'position:fixed;inset:0;width:100vw;height:100vh;z-index:40'
    document.body.append(canvas)
    document.querySelector('.cover img').style.opacity = '0'
  })
  await page.locator('.project > .cover').scrollIntoViewIfNeeded()
  await pause(600)
  const coverBox = await page.locator('.project > .cover').boundingBox()
  await page.mouse.click(coverBox.x + coverBox.width / 2, Math.min(coverBox.y + coverBox.height / 2, 700))
  await pause()
  check('a zone under a canvas is still reachable', (await ed('.panel-title').count()) === 1 && (await text(ed('.panel-title'))) === 'Image de couverture')
  await page.keyboard.press('Escape')
  await page.evaluate(() => document.querySelector('#fake-webgl').remove())

  /* Files of every kind, prepared on arrival */
  await page.locator('.gallery .media img').first().scrollIntoViewIfNeeded()
  await pause(600)
  await page.locator('.gallery .media img').first().click()
  await pause()
  const before = await ed('.grid-item').count()
  check('a gallery block lists its files', (await text(ed('.panel-title'))) === 'Fichiers' && before === (hasFfmpeg ? 3 : 2), `${before} tiles`)
  const uploads = ['Photo chantier (été).jpg', 'maquette-v2.glb', 'plan-masse.dwg', 'descriptif.zip', ...(hasFfmpeg ? ['visite.mov', 'ambiance.mp3'] : [])].map(fx)
  if (heic) uploads.push(heic)
  await ed('.panel input[type=file]').setInputFiles(uploads)
  await ed('.grid-item').nth(before + uploads.length - 1).waitFor({ timeout: 120000 })
  await pause()
  check('every upload arrives', (await ed('.grid-item').count()) === before + uploads.length && (await ed('.pending-item').count()) === 0)
  await ed('.grid-item .thumb').nth(before).click()
  await ed('.detail input').fill('Chantier, été 2024')
  await ed('.detail-actions .link').nth(0).click()
  await snap('gallery')
  await save()

  const files = project('p_refuge').sections[1].files
  const photo = files.find((a) => a.caption === 'Chantier, été 2024')
  check('photo: straightened, capped at 3200 px, with smaller versions', photo?.width === 2400 && photo.height === 3200 && photo.variants?.map((v) => v.width).join() === '640,1280,1920', JSON.stringify(photo))
  check('photo: readable name on disk, caption and position kept', photo?.path.endsWith('/Photo-chantier-ete.jpg') && files.indexOf(photo) === before - 1)
  const published = photo && (await sharp(path.join(DEMO, 'public', photo.path)).metadata())
  check('photo: no GPS position or other metadata left', published && !published.exif && published.width === 2400, JSON.stringify({ exif: !!published?.exif }))
  const kindOf = (name) => files.find((a) => a.name === name)?.kind
  check('3D model, CAD plan and archive are kept as files', kindOf('maquette-v2.glb') === 'model' && kindOf('plan-masse.dwg') === 'file' && kindOf('descriptif.zip') === 'file')
  const dwg = await page.request.get(BASE + files.find((a) => a.name === 'plan-masse.dwg').path)
  check('an unknown format downloads byte for byte', dwg.status() === 200 && (await dwg.body()).length === 30000)
  check(
    'page shows each kind its own way',
    (await page.locator('.gallery model-viewer').count()) === 2 && (await page.locator('.gallery .doc').count()) === 3 && (await page.locator(`.gallery img[src="${photo?.path}"][srcset]`).count()) === 1,
  )
  if (hasFfmpeg) {
    const video = files.find((a) => a.name === 'visite.mp4')
    check('video: re-encoded to MP4 with even dimensions, a duration and a poster', video?.mime === 'video/mp4' && video.width === 642 && video.height === 362 && video.duration > 1.5 && !!video.poster, JSON.stringify(video))
    const range = await page.request.get(BASE + video.path, { headers: { range: 'bytes=0-99' } })
    check('video: served in ranges, so players can seek', range.status() === 206 && (await range.body()).length === 100)
    check('video and sound play on the page', (await page.locator(`.gallery video[poster="${video?.poster?.path}"]`).count()) === 1 && kindOf('ambiance.mp3') === 'audio' && (await page.locator('.gallery audio').count()) === 1)
  } else {
    skip('video and sound', 'ffmpeg is not installed')
  }
  if (heic) {
    const converted = files.find((a) => a.name === 'IMG_4012.jpg')
    check('HEIC photo: converted to JPEG', converted?.kind === 'image' && converted.mime === 'image/jpeg' && converted.width > 0, JSON.stringify(converted))
  } else {
    skip('HEIC photo', 'no HEIC_SAMPLE given')
  }

  /* Formatted text, in two languages */
  await page.locator('.section-text .prose').first().scrollIntoViewIfNeeded()
  await pause(600)
  await page.locator('.section-text .prose p').first().click()
  await pause()
  check('a text block opens on the page’s language', (await text(ed('.panel-title'))) === 'Texte' && (await text(ed('.tab[aria-selected=true]'))) === 'fr')
  const area = ed('.rich-area')
  check('formatted text is shown as formatted', (await area.locator('em').count()) === 1 && (await area.locator('a').count()) === 1)
  await area.click()
  await page.keyboard.press('Control+End')
  await page.keyboard.press('Enter')
  await page.keyboard.type('Ouvert de juin à ')
  await ed('.tool[aria-label="Gras"]').click()
  await page.keyboard.type('septembre')
  await ed('.tool[aria-label="Gras"]').click()
  await page.keyboard.type(', voir horaires')
  await page.keyboard.press('Control+Shift+ArrowLeft')
  await ed('.tool.is-wide').click()
  await ed('.rich-link input').fill('exemple.fr/horaires')
  await page.keyboard.press('Enter')
  await pause(200)
  await snap('richtext')
  await ed('.tab', { hasText: 'en' }).click()
  await pause(200)
  check('the other language has its own text', (await text(area))?.startsWith('The building turns its back'))
  await area.click()
  await page.keyboard.press('Control+End')
  await page.keyboard.type(' Open June to September.')
  await save()
  const body = project('p_refuge').sections[0].text.$t
  const added = body.fr.at(-1)
  check('bold and link are stored as data', added?.length === 4 && added[1].text === 'septembre' && added[1].bold === true && added[3].text === 'horaires' && added[3].href === 'https://exemple.fr/horaires', JSON.stringify(added))
  check('both languages saved from one panel', body.en.at(-1).at(-1).text.endsWith('Open June to September.') && body.fr.length === 3)
  const prose = page.locator('.section-text .prose').first()
  check('page renders bold and link', (await text(prose.locator('strong'))) === 'septembre' && (await prose.locator('a[href="https://exemple.fr/horaires"][target=_blank]').count()) === 1)

  /* A list inside the project */
  await page.locator('.credits li').first().click()
  await pause()
  check('one line of a list opens as an item', (await text(ed('.panel-title'))) === 'Crédit' && (await text(ed('.panel-context'))) === 'Maîtrise d’ouvrage')
  await ed('.more .link', { hasText: 'Toute la liste' }).click()
  await pause()
  check('from an item, the whole list', (await text(ed('.panel-title'))) === 'Crédits' && (await ed('.item').count()) === 3)
  await ed('.add .btn').click()
  await pause(200)
  check('adding steps into the new item', (await text(ed('.panel-title'))) === 'Crédit' && (await ed('.back').count()) === 1)
  await ed('.panel .field input.input').nth(0).fill('Paysage')
  await ed('.panel .field input.input').nth(1).fill('Atelier des Cimes')
  await ed('.back').click()
  await pause(200)
  check('back in the list, the new line carries its title', (await text(ed('.item').nth(3).locator('.item-summary'))) === 'Paysage')
  await ed('.item').nth(3).locator('.icon[aria-label="Monter"]').click()
  await snap('list')
  await save()
  const credits = project('p_refuge').credits
  check('nested list saved in its new order', credits.length === 4 && credits[2].name === 'Atelier des Cimes' && credits[2].role.$t.fr === 'Paysage')
  check('page shows the new line', (await text(page.locator('.credits li').nth(2))).includes('Atelier des Cimes'))

  /* Blocks: the page body is composed by the artist */
  const sections = page.locator('.sections')
  await sections.scrollIntoViewIfNeeded()
  await pause(600)
  await sections.click({ position: { x: 30, y: 12 } })
  await pause()
  check('the page body is a list of blocks of several kinds', (await text(ed('.panel-title'))) === 'Sections de la page' && (await ed('.item').count()) === 4 && (await text(ed('.item').nth(2).locator('.item-type'))) === 'Citation')
  await ed('.add .btn', { hasText: 'Citation' }).click()
  await pause(200)
  await ed('.panel textarea').fill('Onze rotations, pas une de plus.')
  await ed('.panel .field input.input').fill('La pilote')
  await ed('.back').click()
  await pause(200)
  await ed('.item').nth(4).locator('.icon[aria-label="Monter"]').click()
  await snap('blocks')
  await save()
  check('new block saved at its place', project('p_refuge').sections.length === 5 && project('p_refuge').sections[3].type === 'citation' && project('p_refuge').sections[3].author === 'La pilote')
  check('page shows the new block', (await page.locator('.quote').count()) === 2 && (await text(page.locator('.quote blockquote').nth(1))) === 'Onze rotations, pas une de plus.')

  await page.locator('.quote blockquote').nth(1).scrollIntoViewIfNeeded()
  await pause(600)
  await page.locator('.quote blockquote').nth(1).click()
  await pause()
  await ed('.more .link', { hasText: 'Voir tous les champs' }).click()
  await pause()
  check('a block opens whole, with its position', (await text(ed('.panel-title'))) === 'Citation' && (await text(ed('.item-position'))) === 'Position 4 sur 5')
  await ed('.item-actions .link.is-danger').click()
  await pause(200)
  await reloads(() => ed('.panel-foot .btn.is-danger').click())
  check('a block can be removed from the page', project('p_refuge').sections.length === 4 && (await page.locator('.quote').count()) === 1 && pathname() === '/projets/refuge-de-la-combe-noire')

  /* Everything is reachable from the menu, clickable on the page or not */
  await bar('Contenu').click()
  await pause(200)
  check('the menu lists the whole content', (await ed('.menu-item').allTextContents()).join() === 'Atelier,Projets')
  await snap('menu')
  await ed('.menu-item', { hasText: 'Atelier' }).click()
  await pause()
  check('a group opens in the middle of the screen, sub-groups included', (await ed('.panel.is-centered').count()) === 1 && (await text(ed('.group legend'))) === 'Contact')
  await ed('.group input[type=text]').nth(1).fill('04 50 11 22 33')
  await save()
  check('nested group saved', content().site.contact.phone === '04 50 11 22 33' && content().site.contact.email === 'bonjour@atelier-morane.example')

  await bar('Contenu').click()
  await ed('.menu-item', { hasText: 'Projets' }).click()
  await pause()
  check('the list of projects, from the menu', (await ed('.item').count()) === 4)
  await ed('.item-open', { hasText: 'Chai des Roches' }).click()
  await pause(200)
  await ed('.panel .field input.input').nth(1).fill('2020')
  await ed('.back').click()
  await save()
  check('a project edited from the menu keeps its address and place', project('p_chai').year === '2020' && project('p_chai').slug === 'chai-des-roches' && content().projects.map((p) => p.id).join() === 'p_refuge,p_halle,p_maison,p_chai')

  /* A new project */
  await bar('Nouveau projet').click()
  await pause()
  check('new project: every field, lists included', (await ed('.panel.is-centered .field').count()) === 9 && (await ed('.panel button[type=submit]').isDisabled()))
  await ed('#f-title').fill('Passerelle du Giffre')
  await ed('#f-year').fill('2025')
  await ed('#f-program').selectOption('Paysage')
  await save()
  check('new project has its own page at once', pathname() === '/projets/passerelle-du-giffre' && (await text(page.locator('.project-title'))) === 'Passerelle du Giffre')
  check('new project comes first', content().projects[0].slug === 'passerelle-du-giffre' && content().projects[0].program === 'Paysage')

  await page.locator('.project > .cover').click()
  await pause()
  await ed('.panel input[type=file]').setInputFiles(fx('plan-masse.dwg'))
  await pause(500)
  check('a cover refuses what is not an image, and says what it expects', (await text(ed('.pending-error')))?.includes('attend une image'))
  await ed('.panel input[type=file]').setInputFiles(heic ?? fx('Photo chantier (été).jpg'))
  await ed('.file-current').waitFor({ timeout: 60000 })
  await save()
  check('cover saved and shown', content().projects[0].cover?.kind === 'image' && (await page.locator('.project > .cover img[srcset]').count()) === 1)

  const emptySections = page.locator('.sections')
  check('an empty zone keeps a size', (await emptySections.boundingBox()).height > 10)
  await emptySections.click({ position: { x: 30, y: 12 } })
  await pause()
  await ed('.add .btn', { hasText: 'Texte' }).click()
  await pause(200)
  await ed('.rich-area').click()
  await page.keyboard.type('Une passerelle en mélèze.')
  await save()
  check('first block added to an empty page', (await text(page.locator('.section-text .prose'))) === 'Une passerelle en mélèze.')

  await reloads(() => bar('Annuler').click())
  check('undo takes back the last save only', content().projects[0].sections.length === 0 && content().projects[0].cover?.kind === 'image' && (await text(ed('.toast'))) === 'Dernière modification annulée')

  await page.locator('[data-foliome$=".year"]').click()
  await pause(200)
  await ed('.panel input.input').fill('')
  await save()
  await visit(`${BASE}/`)
  const emptyYear = page.locator('.row').first().locator('[data-foliome$=".year"]')
  check('an emptied text keeps a clickable size', (await emptyYear.boundingBox())?.width >= 30)
  await emptyYear.click()
  await pause()
  check('and opens its panel', (await text(ed('.panel-title'))) === 'Année')
  await page.keyboard.press('Escape')

  await visit(`${BASE}/projets/passerelle-du-giffre`)
  await page.locator('.cartouche dt').first().click()
  await pause()
  check('whole project panel', (await text(ed('.panel-title'))) === 'Projet' && (await text(ed('.item-position'))) === 'Position 1 sur 5')
  await reloads(() => ed('.item-actions .link', { hasText: 'Descendre' }).click())
  check('project moved down', content().projects[1].slug === 'passerelle-du-giffre')
  await page.locator('.cartouche dt').first().click()
  await pause()
  await ed('.item-actions .link.is-danger').click()
  await pause(200)
  await reloads(() => ed('.panel-foot .btn.is-danger').click())
  check('project deleted, back on the home page', pathname() === '/' && content().projects.length === 4)
  check('its page is gone', (await page.request.get(`${BASE}/projets/passerelle-du-giffre`)).status() === 404)

  /* The English side of the site */
  await visit(`${BASE}/en/projets/maison-sur-la-pente`)
  await page.locator('.summary').click()
  await pause()
  check('on an English page the panel opens in English', (await text(ed('.tab[aria-selected=true]'))) === 'en' && (await ed('.panel textarea').inputValue()).startsWith('Three half-levels'))
  await snap('languages')
  await ed('.panel textarea').fill('Edited in English.')
  await save()
  const summary = project('p_maison').summary.$t
  check('only the English text changed', summary.en === 'Edited in English.' && summary.fr.startsWith('Trois demi-niveaux') && (await text(page.locator('.summary'))) === 'Edited in English.')
  const french = await (await page.request.get(`${BASE}/projets/maison-sur-la-pente`)).text()
  check('the French page is untouched', french.includes('Trois demi-niveaux') && !french.includes('Edited in English.'))
  await bar('Nouveau projet').click()
  await pause()
  await ed('#f-title').fill('Footbridge')
  await save()
  check('a project created from the English side opens in English', pathname() === '/en/projets/footbridge')
  await reloads(() => bar('Annuler').click())
  check('undoing its creation from its own page returns to the English home', pathname().replace(/\/$/, '') === '/en' && content().projects.length === 4)

  /* Putting the site online */
  check('"Mettre en ligne" is offered when a command is configured', (await bar('Mettre en ligne').count()) === 1)
  await bar('Mettre en ligne').click()
  await ed('.toast', { hasText: 'Site mis en ligne' }).waitFor({ timeout: 180000 })
  const built = existsSync(path.join(DEMO, 'dist', 'index.html')) ? readFileSync(path.join(DEMO, 'dist', 'index.html'), 'utf8') : ''
  const builtEn = existsSync(path.join(DEMO, 'dist', 'en', 'index.html')) ? readFileSync(path.join(DEMO, 'dist', 'en', 'index.html'), 'utf8') : ''
  check('the command ran and built the site in both languages', built.includes('Halle aux grains de Bonneville') && builtEn.includes('Architecture on sloping ground'))
  check('what goes online carries no trace of the editor', built !== '' && !built.includes('data-foliome') && !built.includes('_foliome'))

  /* Browsing, phone, leaving */
  await visit(`${BASE}/`)
  await ed('.seg-btn', { hasText: 'Parcourir' }).click()
  await page.locator('[data-foliome="projects.p_maison.title"]').click()
  await page.waitForURL('**/projets/maison-sur-la-pente')
  await settled()
  check('browse mode leaves the site alone', pathname() === '/projets/maison-sur-la-pente' && (await ed('.panel').count()) === 0)
  await ed('.seg-btn', { hasText: 'Modifier' }).click()

  await page.setViewportSize({ width: 390, height: 780 })
  await visit(`${BASE}/projets/maison-sur-la-pente`)
  await page.locator('.summary').click()
  await pause(400)
  const sheet = await ed('.panel').boundingBox()
  check('on a phone the panel is a sheet at the bottom', sheet?.x === 0 && Math.round(sheet.y + sheet.height) === 780 && sheet.width === 390)
  await snap('phone')
  await page.keyboard.press('Escape')

  await page.setViewportSize({ width: 1440, height: 900 })
  await bar('Quitter').click()
  await pause(400)
  await page.reload()
  await settled()
  check('quitting removes the editor for good', (await page.locator('foliome-editor').count()) === 0)
  if (lan) check('and closes the session', (await page.request.get(`${BASE}/_foliome/content`)).status() === 401)
} catch (err) {
  results.push(`CRASH  ${String(err).split('\n')[0]}`)
  if (shots) await page.screenshot({ path: path.join(shots, 'crash.png') })
}

/* A deploy that fails must say so, and reassure about what was saved */
try {
  await sh('npx astro dev stop', { cwd: DEMO })
  await sh(`npx astro dev --port ${PORT}`, { cwd: DEMO, env: { ...process.env, FOLIOME_PUBLISH: `node -e "console.error('upload refused: disk full'); process.exit(3)"` } })
  await page.goto(`${local}/?edit`)
  await ed('.bar').waitFor({ timeout: 60000 })
  check('on the developer’s own machine no code is asked', (await ed('.panel.is-narrow').count()) === 0)
  await bar('Mettre en ligne').click()
  await ed('.panel[role=alertdialog]').waitFor({ timeout: 60000 })
  check('a failed deploy shows the command’s own message', (await text(ed('.log')))?.includes('upload refused: disk full') && (await text(ed('.panel-context')))?.includes('bien enregistrées'))
  check('and no success is announced', (await ed('.toast').count()) === 0)
} catch (err) {
  results.push(`CRASH  ${String(err).split('\n')[0]}`)
}

await browser.close()
await sh('npx astro dev stop', { cwd: DEMO })
await seed()
await rm(path.join(DEMO, '.foliome', 'history'), { recursive: true, force: true })
await rm(path.join(DEMO, 'dist'), { recursive: true, force: true })
await rm(tmp, { recursive: true, force: true })

// Expected: the wrong code typed on purpose, the deleted project's page, and the editor checking whether an undone page still exists.
const expected = [/401 POST \/_foliome\/login/, /status of 401/, /404 GET \/projets\/passerelle-du-giffre/, /404 HEAD \/en\/projets\/footbridge/, /status of 404/]
const unexpected = [...new Set(problems)].filter((p) => !expected.some((e) => e.test(p)))
const failed = results.filter((r) => !r.startsWith('PASS') && !r.startsWith('SKIP'))
console.log(results.join('\n'))
console.log(unexpected.length ? `\nUnexpected in the browser:\n${unexpected.join('\n')}` : '\nNothing unexpected in the browser console or network.')
console.log(`\n${results.filter((r) => r.startsWith('PASS')).length} passed, ${failed.length} failed, ${results.filter((r) => r.startsWith('SKIP')).length} skipped`)
process.exit(failed.length || unexpected.length ? 1 : 0)
