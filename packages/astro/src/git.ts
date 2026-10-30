import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import path from 'node:path'
import { promisify } from 'node:util'

/**
 * Keeps what the artist changes in the site's git repository, as a copy off this machine and a history longer than
 * undo. Only the content and its files are ever committed, so that the developer's work in the same folder is left
 * alone, and nothing here may get in the artist's way: a failure is reported to the developer and tried again later.
 */

export interface HistoryOptions {
  root: string
  /** The site's name, which signs the commits. */
  name: string
  /** Also send the commits to the repository's remote. */
  push?: boolean
  /** How long the artist has to stop saving, in milliseconds, before a commit is made. */
  quiet?: number
  warn: (message: string) => void
}

const run = promisify(execFile)
const QUIET = 10 * 60_000
/** Long enough to send a large video over a slow line. */
const LONGEST = 10 * 60_000
const EMAIL = 'foliome@foliome.invalid'
const MESSAGE = 'content: edited in the editor'
const PATHS = ['content', path.join('public', 'media')]
// A file still being uploaded is `.part` until it is whole.
const UPLOADING = ':(exclude)*.part'

export function contentHistory({ root, name, push = false, quiet = QUIET, warn }: HistoryOptions) {
  const author = `Foliome (${name})`
  const env = {
    ...process.env,
    GIT_AUTHOR_NAME: author,
    GIT_AUTHOR_EMAIL: EMAIL,
    GIT_COMMITTER_NAME: author,
    GIT_COMMITTER_EMAIL: EMAIL,
    // Nobody is there to type a password.
    GIT_TERMINAL_PROMPT: '0',
    GIT_SSH_COMMAND: process.env.GIT_SSH_COMMAND ?? 'ssh -o BatchMode=yes',
  }
  // The developer's hooks and signing are made for the developer's commits, and may be waiting for someone.
  const git = (...args: string[]) => run('git', ['-c', 'commit.gpgsign=false', ...args], { cwd: root, env, timeout: LONGEST })

  async function commit() {
    // git refuses a path that does not exist, such as the media of a site with no file yet. With none left, the
    // exclusion alone would mean everything else in the folder.
    const paths = PATHS.filter((name) => existsSync(path.join(root, name)))
    if (paths.length === 0) return
    const { stdout } = await git('status', '--porcelain', '--', ...paths, UPLOADING)
    if (!stdout) return
    await git('add', '-A', '--', ...paths, UPLOADING)
    await git('commit', '--no-verify', '-m', MESSAGE, '--', ...paths, UPLOADING)
  }

  async function send() {
    // A merge, not a rebase: a rebase rewinds the content file while it runs, and the artist may be saving.
    await git('pull', '--no-rebase', '--no-edit', '--no-verify').catch(async (err) => {
      await git('merge', '--abort').catch(() => {})
      throw err
    })
    await git('push', '--no-verify')
  }

  let turn: Promise<unknown> = Promise.resolve()
  const inTurn = (task: () => Promise<void>, failure: string) => {
    turn = turn.then(task).catch((err: Error) => warn(`${failure} : ${err.message.trim()}`))
    return turn
  }

  let timer: NodeJS.Timeout | undefined

  /** Commits now. Resolves once that is done, without waiting for the commit to be sent; it never rejects. */
  const flush = () => {
    clearTimeout(timer)
    const committed = inTurn(commit, 'Contenu non enregistré dans git')
    if (push) inTurn(send, 'Contenu enregistré dans git, mais pas envoyé')
    return committed
  }

  return {
    flush,
    /** To be called after each stored change. */
    changed() {
      clearTimeout(timer)
      timer = setTimeout(flush, quiet)
      timer.unref()
    },
    /** Commits and sends what is left, and waits for it. */
    async close() {
      await flush()
      await turn
    },
  }
}
