// Puts the demo site back as it is in the repository: its content, its files, and nothing anyone left behind (undo
// history, drafts, sessions). Run before each visitor on the public demo, by its service (ExecStartPre). Fast and
// local: git only reads what it already has, and nothing is generated again (that is `npm run seed`, which takes a
// while and a whole processor).
//
//   node scripts/reset-demo.mjs [folder of the site, apps/demo by default]

import { execFile } from 'node:child_process'
import { readFile, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'

const site = path.resolve(process.argv[2] ?? path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'apps', 'demo'))
const git = (...args) => promisify(execFile)('git', ['-C', site, ...args])
const kept = ['content', 'public/media']

// What was changed or removed comes back as committed; what was added goes.
await git('checkout', 'HEAD', '--', ...kept)
await git('clean', '-fdq', '--', ...kept)

const own = path.join(site, '.foliome')
await rm(path.join(own, 'history'), { recursive: true, force: true })
await rm(path.join(own, 'drafts.json'), { force: true })
// The code stays, though it opens nothing on the demo; the sessions of past visitors go.
try {
  const state = JSON.parse(await readFile(path.join(own, 'local.json'), 'utf8'))
  await writeFile(path.join(own, 'local.json'), JSON.stringify({ ...state, sessions: {} }, null, 2))
} catch {
  // Never started yet: nothing to clear.
}
console.log(`Démo remise à neuf : ${site}`)
