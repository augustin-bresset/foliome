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
/** What a restore commit says, so that a history can tell one: `content: back to the version of <ISO date> (<short hash>)`. */
export const restoredMessage = (date: string, short: string) => `content: back to the version of ${date} (${short})`
/** Where HEAD was just before a restore: `before-restore/2026-11-05-1630`. */
const SAFETY = 'before-restore/'
const HASH = /^[0-9a-f]{7,40}$/i
const PATHS = ['content', path.join('public', 'media')]
// A file still being uploaded is `.part` until it is whole.
const UPLOADING = ':(exclude)*.part'

/** Why the content could not be brought back, when that version does not fit the site as it is now. */
export interface Unfit {
  error: 'misfit' | 'build'
  /** The places in the content that do not fit, or the end of the build's output. */
  detail: string
}

export type Restored =
  | { ok: true; commit: string; from: string; date: string; branch: string }
  | { ok: false; error: 'bad_commit' | 'unknown_commit' | 'unchanged' }
  | ({ ok: false } & Unfit)

const pad = (n: number) => String(n).padStart(2, '0')
const minute = (at: Date) => `${at.getFullYear()}-${pad(at.getMonth() + 1)}-${pad(at.getDate())}-${pad(at.getHours())}${pad(at.getMinutes())}`

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
  /** In turn too, but its outcome, or its failure, goes back to whoever asked. */
  const ownTurn = <T>(task: () => Promise<T>) => {
    const done = turn.then(task)
    turn = done.catch(() => {})
    return done
  }

  /**
   * The content paths, as git is given them: those that exist here or in `at`. git refuses a path found nowhere. The
   * site may be a folder within a larger repository: paths are read from the site's folder.
   */
  async function present(at: string) {
    const found: string[] = []
    for (const name of PATHS) {
      const here = existsSync(path.join(root, name))
      if (here || (await git('cat-file', '-e', `${at}:./${name.split(path.sep).join('/')}`).then(() => true, () => false))) found.push(name)
    }
    return found
  }

  /**
   * Brings the content and its files back as they were at `asked`, a commit of this branch, on top of the current
   * history: whatever is there now is committed first, a branch keeps where HEAD was, and the version brought back is
   * a new commit, so that it can itself be undone the same way. Only `content/` and `public/media/` go back; the code
   * stays as it is. `check` judges the result before anything is committed (the build, say): when it finds the old
   * content does not fit, everything is put back as it was, the branch goes, and nothing is committed.
   */
  async function restore(asked: string, check: () => Promise<Unfit | null>): Promise<Restored> {
    if (!HASH.test(asked)) return { ok: false, error: 'bad_commit' }
    return ownTurn(async (): Promise<Restored> => {
      const full = await git('rev-parse', '--verify', '--quiet', `${asked}^{commit}`).then(({ stdout }) => stdout.trim(), () => '')
      // Only a version this site has been through: nothing from another branch, nothing that is not a commit.
      if (!full || !(await git('merge-base', '--is-ancestor', full, 'HEAD').then(() => true, () => false))) return { ok: false, error: 'unknown_commit' }
      await commit()
      const paths = await present(full)
      if (paths.length === 0) return { ok: false, error: 'unchanged' }
      const same = await git('diff', '--quiet', full, '--', ...paths, UPLOADING).then(() => true, () => false)
      if (same) return { ok: false, error: 'unchanged' }

      const { stdout } = await git('log', '-1', '--format=%aI%x00%h', full)
      const [date = '', short = ''] = stdout.trim().split('\0')
      let branch = `${SAFETY}${minute(new Date())}`
      for (let n = 2; await git('rev-parse', '--verify', '--quiet', `refs/heads/${branch}`).then(() => true, () => false); n++) {
        branch = `${SAFETY}${minute(new Date())}-${n}`
      }
      await git('branch', branch, 'HEAD')
      const putBack = async () => {
        await git('restore', '--source=HEAD', '--staged', '--worktree', '--', ...(await present('HEAD')), UPLOADING)
        await git('branch', '-D', branch)
      }
      try {
        await git('restore', `--source=${full}`, '--staged', '--worktree', '--', ...paths, UPLOADING)
        const unfit = await check()
        if (unfit) {
          await putBack()
          return { ok: false, ...unfit }
        }
        // Already staged by the restore. `git add` would refuse a folder that is gone, all its files with it.
        await git('commit', '--no-verify', '-m', restoredMessage(date, short), '--', ...paths, UPLOADING)
      } catch (err) {
        await putBack().catch(() => {})
        throw err
      }
      const { stdout: head } = await git('rev-parse', 'HEAD')
      if (push) {
        inTurn(send, 'Contenu remis dans git, mais pas envoyé')
        inTurn(async () => {
          // Wherever the branch is sent: the copy elsewhere keeps where the site was too.
          const upstream = await git('rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}').then(({ stdout }) => stdout.trim().split('/')[0], () => '')
          await git('push', '--no-verify', upstream || 'origin', `refs/heads/${branch}:refs/heads/${branch}`)
        }, `Branche ${branch} pas envoyée`)
      }
      return { ok: true, commit: head.trim(), from: full, date, branch }
    })
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
    restore,
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
