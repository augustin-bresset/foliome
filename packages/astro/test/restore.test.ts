import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { after, test } from 'node:test'
import { promisify } from 'node:util'
import { contentHistory } from '../src/git.ts'
import { createLocal } from '../src/local.ts'

const run = promisify(execFile)
const KEY = 'the-host-key'
const closing: (() => Promise<unknown>)[] = []
after(() => Promise.all(closing.map((close) => close())))

const env = { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null' }
const git = async (cwd: string, ...args: string[]) => (await run('git', ['-c', 'user.name=Dev', '-c', 'user.email=dev@example.org', ...args], { cwd, env })).stdout.trim()

async function write(root: string, file: string, text: string) {
  await mkdir(path.dirname(path.join(root, file)), { recursive: true })
  await writeFile(path.join(root, file), text)
}
const read = (root: string, file: string) => readFile(path.join(root, file), 'utf8')

const schema = { content: { title: { type: 'text', label: 'Titre' }, projects: { type: 'list', label: 'Projets', fields: { title: { type: 'text', label: 'Titre' } } } } } as const

/**
 * A site with a history the artist made, pushed to a remote: a first version with one photo, a second where the photo
 * was replaced by another, then an update of the site's code. Its editing server keeps the content in git, and its
 * publish command fails on a content file holding « casse », the way a build fails on content it cannot read.
 */
async function site({ publish = `node -e "if (require('fs').readFileSync('content/content.json', 'utf8').includes('casse')) process.exit(1); require('fs').writeFileSync('built', 'ok')"`, within = '' } = {}) {
  const base = await mkdtemp(path.join(os.tmpdir(), 'foliome-restore-'))
  const remote = path.join(base, 'remote.git')
  const clone = path.join(base, 'site')
  // The site may be one folder of a larger repository, as foliome.eu is in Foliome's.
  const root = path.join(clone, within)
  await git(base, 'init', '-q', '--bare', '-b', 'main', remote)
  await git(base, 'clone', '-q', remote, clone)
  await mkdir(root, { recursive: true })
  await git(root, 'checkout', '-q', '-b', 'main')
  await write(root, '.gitignore', 'built\n.foliome/\neditor.js\n')
  await write(root, 'src/page.astro', 'page v1\n')
  await write(root, 'content/content.json', '{"title":"Première","projects":[{"id":"p1","title":"Halle"}]}\n')
  await write(root, 'public/media/a_1/halle.jpg', 'halle')
  await git(root, 'add', '.')
  await git(root, 'commit', '-q', '-m', 'first')
  const first = await git(root, 'rev-parse', 'HEAD')
  await write(root, 'content/content.json', '{"title":"Deuxième","projects":[]}\n')
  await rm(path.join(root, 'public/media/a_1'), { recursive: true })
  await write(root, 'public/media/a_2/refuge.jpg', 'refuge')
  await git(root, 'add', '-A')
  await git(root, 'commit', '-q', '-m', 'content: edited in the editor')
  const second = await git(root, 'rev-parse', 'HEAD')
  await write(root, 'src/page.astro', 'page v2\n')
  await git(root, 'commit', '-q', '-am', 'feat: the new page')
  await git(root, 'push', '-q', '-u', 'origin', 'main')

  const warnings: string[] = []
  const history = contentHistory({ root, name: 'Atelier', push: true, warn: (message) => warnings.push(message) })
  await writeFile(path.join(root, 'editor.js'), '')
  const local = await createLocal({
    root,
    name: 'Atelier',
    schema: schema as never,
    allowedHosts: [],
    editorFile: path.join(root, 'editor.js'),
    onChange: () => history.changed(),
    hostKey: KEY,
    publish,
    beforePublish: history.flush,
    restore: history.restore,
  })
  const server = http.createServer((req, res) => local.gate(req, res, () => local.middleware(req, res, () => res.end('site'))))
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done))
  const { port } = server.address() as AddressInfo
  closing.push(async () => {
    server.closeAllConnections()
    await new Promise((done) => server.close(done))
    await history.close()
    await rm(base, { recursive: true, force: true })
  })
  /** From this machine, as the developer's browser, or with the host's key. */
  const ask = async (url: string, { method = 'GET', body, host = false, cookie = '' }: { method?: string; body?: unknown; host?: boolean; cookie?: string } = {}) => {
    const res = await fetch(`http://127.0.0.1:${port}/_foliome${url}`, {
      method,
      headers: {
        origin: `http://127.0.0.1:${port}`,
        'content-type': 'application/json',
        ...(host ? { 'x-foliome-host': KEY } : {}),
        ...(cookie ? { cookie } : {}),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    })
    return { status: res.status, json: (await res.json().catch(() => null)) as Record<string, unknown> }
  }
  const restore = (commit: string, notice?: unknown) => ask('/host/restore', { method: 'POST', host: true, body: { commit, ...(notice ? { notice } : {}) } })
  const branches = async (where = root) => (await git(where, 'for-each-ref', '--format=%(refname:short)', 'refs/heads/')).split('\n').filter((name) => name.startsWith('before-restore/'))
  const files = async () => (await git(root, 'ls-files', 'public/media')).split('\n').filter(Boolean)
  return { root, remote, first, second, warnings, history, ask, restore, branches, files }
}

test('brings the content and its files back as they were, on top of the history, with a branch where it was', async () => {
  const { root, remote, first, second, warnings, history, ask, restore, branches, files } = await site()
  const before = await git(root, 'rev-parse', 'HEAD')
  const done = await restore(first.slice(0, 7))
  assert.equal(done.status, 200, JSON.stringify(done.json))
  assert.equal(done.json.ok, true)
  assert.equal(done.json.from, first)

  // The content and its files are those of the first version; the code is today's.
  assert.equal(await read(root, 'content/content.json'), '{"title":"Première","projects":[{"id":"p1","title":"Halle"}]}\n')
  assert.deepEqual(await files(), ['public/media/a_1/halle.jpg'])
  assert.equal(existsSync(path.join(root, 'public/media/a_2')), false)
  assert.equal(await read(root, 'src/page.astro'), 'page v2\n')
  assert.equal(await read(root, 'built'), 'ok', 'the site was put online as it was')

  // A new commit on top, which says what it is, signed like the artist's; nothing rewritten.
  assert.equal(await git(root, 'rev-parse', 'HEAD~1'), before)
  assert.equal(done.json.commit, await git(root, 'rev-parse', 'HEAD'))
  const date = await git(root, 'log', '-1', '--format=%aI', first)
  assert.equal(await git(root, 'log', '-1', '--format=%s'), `content: back to the version of ${date} (${first.slice(0, 7)})`)
  assert.equal(await git(root, 'log', '-1', '--format=%an'), 'Foliome (Atelier)')
  assert.equal(await git(root, 'status', '--porcelain'), '')

  // The branch keeps where the site was, here and on the remote.
  const [branch] = await branches()
  assert.match(branch ?? '', /^before-restore\/\d{4}-\d\d-\d\d-\d{4}$/)
  assert.equal(done.json.branch, branch)
  assert.equal(await git(root, 'rev-parse', branch!), before)
  await history.close()
  assert.deepEqual(warnings, [])
  assert.equal(await git(remote, 'rev-parse', 'main'), done.json.commit)
  assert.equal(await git(remote, 'rev-parse', branch!), before)

  // A restore is undone the same way: back to the version just before it, with a second branch.
  const back = await restore(before)
  assert.equal(back.status, 200, JSON.stringify(back.json))
  assert.equal(await read(root, 'content/content.json'), '{"title":"Deuxième","projects":[]}\n')
  assert.deepEqual(await files(), ['public/media/a_2/refuge.jpg'])
  assert.equal(await git(root, 'diff', second, 'HEAD', '--', 'content', 'public/media'), '')
  assert.equal((await branches()).length, 2)
  assert.notEqual((await branches())[1], branch)

  // Nothing to bring back: the content is as it was then.
  assert.deepEqual((await restore(second)).json, { ok: false, error: 'unchanged' })
  assert.equal((await ask('/host')).status, 404, 'without the key there is nothing there')
})

test('a site in a folder of a larger repository goes back the same way', async () => {
  const { root, first, restore, files } = await site({ within: 'apps/home' })
  await write(root, '../other/content/content.json', '{"other":true}\n')
  await git(root, 'add', '../other')
  await git(root, 'commit', '-q', '-m', 'another app')
  const done = await restore(first)
  assert.equal(done.status, 200, JSON.stringify(done.json))
  assert.equal(await read(root, 'content/content.json'), '{"title":"Première","projects":[{"id":"p1","title":"Halle"}]}\n')
  assert.deepEqual(await files(), ['public/media/a_1/halle.jpg'])
  assert.equal(await git(root, 'show', '--name-only', '--format=', 'HEAD'), 'apps/home/content/content.json\napps/home/public/media/a_1/halle.jpg\napps/home/public/media/a_2/refuge.jpg')
  assert.equal(await read(root, '../other/content/content.json'), '{"other":true}\n')
})

test('back to a version without any file: the media folder goes with them', async () => {
  const { root, restore, files } = await site()
  await rm(path.join(root, 'public/media'), { recursive: true })
  await git(root, 'commit', '-q', '-am', 'content: edited in the editor')
  const none = await git(root, 'rev-parse', 'HEAD')
  await write(root, 'public/media/a_5/neuf.jpg', 'neuf')
  await git(root, 'add', '-A')
  await git(root, 'commit', '-q', '-m', 'content: edited in the editor')
  const done = await restore(none)
  assert.equal(done.status, 200, JSON.stringify(done.json))
  assert.deepEqual(await files(), [])
  assert.equal(existsSync(path.join(root, 'public/media')), false)
  assert.equal(await git(root, 'status', '--porcelain'), '')
})

test('what the artist saved since the last commit is committed first, and kept on the branch', async () => {
  const { root, first, restore, branches } = await site()
  await write(root, 'content/content.json', '{"title":"Pas encore dans git","projects":[]}\n')
  assert.equal((await restore(first)).status, 200)
  const [branch] = await branches()
  assert.equal(await git(root, 'show', `${branch}:content/content.json`), '{"title":"Pas encore dans git","projects":[]}')
  assert.equal(await git(root, 'log', '-1', '--format=%s', branch!), 'content: edited in the editor')
})

test('refused while the artist holds unsaved changes, or while something is under way', async () => {
  const { root, first, ask, restore, branches } = await site({ publish: 'sleep 1' })
  const before = await git(root, 'rev-parse', 'HEAD')
  await ask('/presence', { method: 'POST', body: { dirty: true, active: true } })
  assert.deepEqual(await restore(first), { status: 409, json: { error: 'editing' } })
  assert.equal(await git(root, 'rev-parse', 'HEAD'), before)
  assert.deepEqual(await branches(), [])

  await ask('/presence', { method: 'POST', body: { dirty: false } })
  const publishing = ask('/publish', { method: 'POST', body: {} })
  await new Promise((done) => setTimeout(done, 200))
  assert.deepEqual(await restore(first), { status: 409, json: { error: 'publishing' } })
  await publishing

  // While it runs, nothing else changes the content, and another restore waits for none.
  const restoring = restore(first)
  await new Promise((done) => setTimeout(done, 300))
  assert.equal((await ask('/host', { host: true })).json.restoring, true)
  assert.deepEqual(await ask('/ops', { method: 'POST', body: { ops: [{ op: 'set', path: 'title', value: 'Entre-temps' }] } }), { status: 409, json: { error: 'restoring' } })
  assert.deepEqual(await restore(first), { status: 409, json: { error: 'restoring' } })
  assert.equal((await restoring).status, 200)
  assert.equal((await ask('/ops', { method: 'POST', body: { ops: [{ op: 'set', path: 'title', value: 'Après' }] } })).status, 200)
})

test('content the site can no longer be built from changes nothing: no commit, no branch, the files put back', async () => {
  const { root, history, ask, restore, branches, files } = await site()
  // An older version the build fails on.
  await write(root, 'content/content.json', '{"title":"casse","projects":[]}\n')
  await write(root, 'public/media/a_3/vieux.jpg', 'vieux')
  await git(root, 'add', '-A')
  await git(root, 'commit', '-q', '-m', 'content: edited in the editor')
  const broken = await git(root, 'rev-parse', 'HEAD')
  await write(root, 'content/content.json', '{"title":"Aujourd’hui","projects":[]}\n')
  await rm(path.join(root, 'public/media/a_3'), { recursive: true })
  await write(root, 'public/media/a_4/neuf.jpg', 'neuf')
  await git(root, 'add', '-A')
  await git(root, 'commit', '-q', '-m', 'content: edited in the editor')
  // Saved in the editor, which keeps it for undo, and committed.
  await ask('/ops', { method: 'POST', body: { ops: [{ op: 'set', path: 'title', value: 'Aujourd’hui encore' }] } })
  await history.flush()
  const before = await git(root, 'rev-parse', 'HEAD')
  const today = await read(root, 'content/content.json')

  const refused = await restore(broken)
  assert.equal(refused.status, 422)
  assert.equal(refused.json.error, 'build')
  assert.equal(await git(root, 'rev-parse', 'HEAD'), before)
  assert.equal(await git(root, 'status', '--porcelain'), '')
  assert.equal(await read(root, 'content/content.json'), today)
  assert.deepEqual(await files(), ['public/media/a_2/refuge.jpg', 'public/media/a_4/neuf.jpg'])
  assert.equal(existsSync(path.join(root, 'public/media/a_3')), false)
  assert.deepEqual(await branches(), [])
  assert.equal(existsSync(path.join(root, 'built')), false, 'nothing was put online')
  assert.equal((await ask('/content')).status, 200)
  assert.equal((await ask('/content')).json.canUndo, true, 'the undo history is still there')
})

test('content of a shape the schema no longer has is refused before any build', async () => {
  const { root, restore, branches } = await site()
  await write(root, 'content/content.json', '{"title":"Ancienne forme","projects":{"p1":{"title":"Halle"}}}\n')
  await git(root, 'commit', '-q', '-am', 'content: edited in the editor')
  const old = await git(root, 'rev-parse', 'HEAD')
  await write(root, 'content/content.json', '{"title":"Nouvelle forme","projects":[]}\n')
  await git(root, 'commit', '-q', '-am', 'feat: projects as a list')
  const before = await git(root, 'rev-parse', 'HEAD')
  assert.deepEqual(await restore(old), { status: 422, json: { ok: false, error: 'misfit', detail: 'projects' } })
  assert.equal(await git(root, 'rev-parse', 'HEAD'), before)
  assert.equal(await read(root, 'content/content.json'), '{"title":"Nouvelle forme","projects":[]}\n')
  assert.equal(existsSync(path.join(root, 'built')), false)
  assert.deepEqual(await branches(), [])
})

test('only a commit of the site’s own history, given as a hash', async () => {
  const { root, restore, branches } = await site()
  const before = await git(root, 'rev-parse', 'HEAD')
  for (const commit of ['', 'HEAD~1', 'main', '--source=HEAD', 'abc', 'zzzzzzz', `${before}0`]) {
    assert.deepEqual(await restore(commit), { status: 400, json: { ok: false, error: 'bad_commit' } }, commit)
  }
  assert.deepEqual(await restore(123 as never), { status: 400, json: { error: 'bad_commit' } })
  assert.deepEqual(await restore('0123456789abcdef0123456789abcdef01234567'), { status: 400, json: { ok: false, error: 'unknown_commit' } })
  // A commit that exists, but not in this branch's history.
  await git(root, 'checkout', '-q', '-b', 'elsewhere')
  await write(root, 'content/content.json', '{"title":"Ailleurs"}\n')
  await git(root, 'commit', '-q', '-am', 'elsewhere')
  const elsewhere = await git(root, 'rev-parse', 'HEAD')
  await git(root, 'checkout', '-q', 'main')
  assert.deepEqual(await restore(elsewhere), { status: 400, json: { ok: false, error: 'unknown_commit' } })
  assert.equal(await git(root, 'rev-parse', 'HEAD'), before)
  assert.deepEqual(await branches(), [])
})

test('an editor open during a restore is told so until it loads the content again', async () => {
  const { first, ask, restore } = await site()
  await ask('/content')
  assert.equal((await ask('/presence', { method: 'POST', body: { dirty: false } })).json.notice, null)
  const words = { text: { fr: 'Revenu en arrière.', en: 'Gone back.' }, actions: [{ label: 'Recharger', do: 'reload' }] }
  assert.equal((await restore(first, words)).status, 200)
  assert.deepEqual((await ask('/presence', { method: 'POST', body: { dirty: false } })).json.notice, words)
  // Whatever the host says meanwhile, the page shows what is no longer there: reloading it comes first.
  await ask('/host/notice', { method: 'POST', host: true, body: { notice: null } })
  assert.deepEqual((await ask('/presence', { method: 'POST', body: { dirty: false } })).json.notice, words)
  await ask('/content')
  assert.equal((await ask('/presence', { method: 'POST', body: { dirty: false } })).json.notice, null)
  assert.equal((await ask('/content')).json.canUndo, false, 'undo does not lead back past a restore')
  assert.deepEqual((await restore(first, { text: 3 })).json, { error: 'invalid', field: 'notice' })
})
