import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { after, test } from 'node:test'
import { promisify } from 'node:util'
import { contentHistory } from '../src/git.ts'

const run = promisify(execFile)
const folders: string[] = []
after(() => Promise.all(folders.map((folder) => rm(folder, { recursive: true, force: true }))))

// Whoever runs the tests has their own git identity and hooks: they play no part here.
const env = { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null' }
const git = async (cwd: string, ...args: string[]) => (await run('git', ['-c', 'user.name=Dev', '-c', 'user.email=dev@example.org', ...args], { cwd, env })).stdout.trim()

async function write(root: string, file: string, text: string) {
  await mkdir(path.dirname(path.join(root, file)), { recursive: true })
  await writeFile(path.join(root, file), text)
}

/** A site in a repository with one commit, cloned from a remote that a second clone (the developer's) also uses. */
async function site() {
  const base = await mkdtemp(path.join(os.tmpdir(), 'foliome-git-'))
  folders.push(base)
  const remote = path.join(base, 'remote.git')
  const root = path.join(base, 'site')
  const developer = path.join(base, 'developer')
  await git(base, 'init', '-q', '--bare', '-b', 'main', remote)
  await git(base, 'clone', '-q', remote, root)
  await git(root, 'checkout', '-q', '-b', 'main')
  await write(root, 'content/content.json', '{}\n')
  await write(root, 'src/page.astro', 'page\n')
  await git(root, 'add', '.')
  await git(root, 'commit', '-q', '-m', 'first')
  await git(root, 'push', '-q', '-u', 'origin', 'main')
  await git(base, 'clone', '-q', remote, developer)
  const warnings: string[] = []
  const history = (options = {}) => contentHistory({ root, name: 'Atelier Morane', warn: (message) => warnings.push(message), ...options })
  return { root, developer, warnings, history }
}

const commits = async (root: string) => Number(await git(root, 'rev-list', '--count', 'HEAD'))
const changedBy = (root: string, ref = 'HEAD') => git(root, 'show', '--name-only', '--format=', ref)

test('commits the content and its files, and nothing of the developer’s', async () => {
  const { root, warnings, history } = await site()
  await write(root, 'content/content.json', '{"title":"Nouveau"}\n')
  await write(root, 'public/media/a_1/photo.jpg', 'photo')
  await write(root, 'public/media/a_2/video.mp4.part', 'half a video')
  await write(root, 'src/page.astro', 'work in progress\n')
  await write(root, 'src/staged.ts', 'staged\n')
  await git(root, 'add', 'src/staged.ts')

  await history().close()

  assert.deepEqual(warnings, [])
  assert.equal(await changedBy(root), 'content/content.json\npublic/media/a_1/photo.jpg')
  assert.equal(await git(root, 'log', '-1', '--format=%an <%ae>'), 'Foliome (Atelier Morane) <foliome@foliome.invalid>')
  const left = await git(root, 'status', '--porcelain')
  assert.match(left, /^A {2}src\/staged\.ts$/m, 'what the developer staged stays staged')
  assert.match(left, /^ ?M src\/page\.astro$/m, 'what the developer is writing stays as it is')
  assert.match(left, /^\?\? public\/media\/a_2\/$/m, 'a file still arriving stays out')
})

test('a burst of saves makes one commit, once the artist has stopped', async () => {
  const { root, history } = await site()
  const before = await commits(root)
  const session = history({ quiet: 150 })
  for (const n of [1, 2, 3]) {
    await write(root, 'content/content.json', `{"n":${n}}\n`)
    session.changed()
    await new Promise((done) => setTimeout(done, 40))
  }
  assert.equal(await commits(root), before, 'nothing while the artist is saving')
  await new Promise((done) => setTimeout(done, 400))
  await session.close()
  assert.equal(await commits(root), before + 1)
  assert.equal(await git(root, 'show', 'HEAD:content/content.json'), '{"n":3}')
})

test('nothing to commit makes no commit', async () => {
  const { root, warnings, history } = await site()
  const before = await commits(root)
  await history({ push: true }).close()
  assert.equal(await commits(root), before)
  assert.deepEqual(warnings, [])
})

test('sends the commits, along with what the developer pushed meanwhile', async () => {
  const { root, developer, warnings, history } = await site()
  await write(developer, 'src/page.astro', 'new design\n')
  await git(developer, 'commit', '-q', '-am', 'design')
  await git(developer, 'push', '-q')

  await write(root, 'content/content.json', '{"title":"Nouveau"}\n')
  await history({ push: true }).close()

  assert.deepEqual(warnings, [])
  assert.equal(await readFile(path.join(root, 'src/page.astro'), 'utf8'), 'new design\n')
  await git(developer, 'pull', '-q')
  assert.equal(await readFile(path.join(developer, 'content/content.json'), 'utf8'), '{"title":"Nouveau"}\n')
})

test('a conflict keeps the artist’s work and reports it, and clears up once the developer has dealt with it', async () => {
  const { root, developer, warnings, history } = await site()
  await write(developer, 'content/content.json', '{"title":"Du développeur"}\n')
  await git(developer, 'commit', '-q', '-am', 'content by hand')
  await git(developer, 'push', '-q')

  await write(root, 'content/content.json', '{"title":"De l’artiste"}\n')
  await history({ push: true }).close()

  assert.equal(warnings.length, 1)
  assert.match(warnings[0] ?? '', /pas envoyé/)
  assert.equal(await readFile(path.join(root, 'content/content.json'), 'utf8'), '{"title":"De l’artiste"}\n')
  assert.equal(await git(root, 'status', '--porcelain'), '', 'no merge left half done')

  // Saving keeps working while the conflict lasts.
  await write(root, 'content/content.json', '{"title":"Encore de l’artiste"}\n')
  await history().close()
  assert.equal(await git(root, 'show', 'HEAD:content/content.json'), '{"title":"Encore de l’artiste"}')
})

test('without a remote the commit is still made, and the failure to send it reported', async () => {
  const { root, warnings, history } = await site()
  await git(root, 'remote', 'remove', 'origin')
  await write(root, 'content/content.json', '{"title":"Nouveau"}\n')
  await history({ push: true }).close()
  assert.equal(await git(root, 'show', 'HEAD:content/content.json'), '{"title":"Nouveau"}')
  assert.equal(warnings.length, 1)
})

test('a site with no content or file yet commits nothing of what else is in the folder', async () => {
  const { root, warnings, history } = await site()
  await rm(path.join(root, 'content'), { recursive: true })
  await git(root, 'commit', '-q', '-am', 'no content')
  const before = await commits(root)
  await write(root, 'src/page.astro', 'work in progress\n')
  await history().close()
  assert.equal(await commits(root), before)
  assert.deepEqual(warnings, [])
})

test('a site outside any repository only gets a warning', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'foliome-git-'))
  folders.push(root)
  await write(root, 'content/content.json', '{}\n')
  const warnings: string[] = []
  await contentHistory({ root, name: 'Site', warn: (message) => warnings.push(message) }).close()
  assert.equal(warnings.length, 1)
})
