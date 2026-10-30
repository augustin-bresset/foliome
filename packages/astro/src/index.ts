import type { IncomingMessage, ServerResponse } from 'node:http'
import { createRequire } from 'node:module'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Fields } from '@foliome/core'
import type { AstroIntegration } from 'astro'
import { contentHistory } from './git.ts'
import { createLocal, formatCode } from './local.ts'

export type { Asset, FieldDef, Fields, GroupDef, ItemType, ListDef, RichText, Schema } from '@foliome/core'

export interface FoliomeOptions {
  /** Name shown to the artist in the editor. */
  name: string
  /** Everything the artist can edit: the top level of `content/content.json`. */
  content: Fields
  /** Languages of the site, default first. Fields marked `translate` then hold one value per language. */
  locales?: string[]
  /**
   * Shell command that builds and deploys the site, e.g. "npm run deploy".
   * When set, the editor shows a "Mettre en ligne" button that runs it.
   */
  publish?: string
  /** Extra host names the editing API answers to, besides localhost, IP addresses and *.local names. */
  allowedHosts?: string[]
  /**
   * The address this server is reached at from outside, when a tunnel opens it to an artist who is elsewhere:
   * "https://atelier.example.org". Once it is set the access code is asked of everyone, on this machine too, since
   * a tunnel's requests cannot be told from the developer's own.
   */
  address?: string
  /**
   * Commits what the artist changes (`content/` and `public/media/`, nothing else) to the site's git repository: once
   * they have stopped saving for ten minutes, before each publish, and when the server stops. With `push`, the commits
   * also go to the remote, after a merge of what is new there. Meant for a server the artist reaches on their own; a
   * developer working in the same folder commits for themselves.
   */
  git?: { push?: boolean }
}

// Runs before anything else on the page. The editor only loads for someone who
// asked for it (`?edit`) or used it before on this device.
const LOADER = `(function(){try{var q=new URLSearchParams(location.search);if(q.has('edit')||localStorage.getItem('foliome')==='1'){if(sessionStorage.getItem('foliome:quiet')){document.documentElement.classList.add('foliome-quiet')}var s=document.createElement('script');s.src='/_foliome/editor.js';s.defer=true;document.head.appendChild(s)}}catch(e){}})()`

export default function foliome(options: FoliomeOptions): AstroIntegration {
  const { name, content, locales, publish, allowedHosts = [], git } = options
  let outside: URL | undefined
  if (options.address) {
    try {
      outside = new URL(options.address)
    } catch {
      // Judged below.
    }
    if (!outside || !/^https?:$/.test(outside.protocol)) {
      throw new Error(`foliome : « address » doit être une adresse complète, par exemple https://atelier.exemple.fr (reçu : ${options.address})`)
    }
  }
  let root = process.cwd()
  let local: Awaited<ReturnType<typeof createLocal>> | undefined
  let history: ReturnType<typeof contentHistory> | undefined
  let listening = false
  let code = ''
  let missing: string[] = []

  return {
    name: 'foliome',
    hooks: {
      'astro:config:setup': ({ command, injectScript, updateConfig }) => {
        if (command !== 'dev') return
        injectScript('head-inline', LOADER)
        updateConfig({
          // The artist edits on this server: Astro's own developer toolbar has no place on their screen.
          devToolbar: { enabled: false },
          vite: {
            plugins: [
              {
                name: 'foliome:door',
                enforce: 'post',
                // Once every middleware is in place Astro puts checks of its own ahead of them all, and some answer
                // for files of the project. The door goes in front of those too.
                configureServer: (server) => () => {
                  server.middlewares.stack.unshift({
                    route: '',
                    handle: (req: IncomingMessage, res: ServerResponse, next: (err?: unknown) => void) => {
                      if (local) local.gate(req, res, next)
                      else res.writeHead(503).end()
                    },
                  })
                },
              },
            ],
          },
        })
        // Vite turns away requests made under a name it was not told about.
        if (outside) updateConfig({ server: { allowedHosts: [outside.hostname] } })
      },

      'astro:config:done': ({ config }) => {
        root = fileURLToPath(config.root)
        // Read by `@foliome/astro/content`, which runs in the pages.
        process.env.FOLIOME_ROOT = root
        process.env.FOLIOME_BASE = config.base
        process.env.FOLIOME_LOCALES = (locales ?? []).join(',')
      },

      'astro:server:setup': async ({ server, logger }) => {
        process.env.FOLIOME_EDITABLE = '1'
        const editorPackage = createRequire(import.meta.url).resolve('@foliome/editor/package.json')
        if (git) {
          const session = contentHistory({ root, name, push: git.push, warn: (message) => logger.warn(message) })
          history = session
          // Whatever a server that went down left uncommitted or unsent.
          session.changed()
          // Vite answers SIGTERM by closing this server, then exits at once. Astro's hooks are not called.
          const close = server.close.bind(server)
          server.close = () => session.close().then(close)
          // Nothing answers SIGINT: the process would end on the spot. A restart comes back here, and once is enough.
          if (!listening) {
            listening = true
            process.once('SIGINT', () => void history?.close().then(() => process.kill(process.pid, 'SIGINT')))
          }
        }
        local = await createLocal({
          root,
          name,
          schema: { content, locales },
          allowedHosts,
          address: outside,
          publish,
          beforePublish: history?.flush,
          editorFile: path.join(path.dirname(editorPackage), 'dist', 'editor.js'),
          // Pages are rendered from the content file, which Vite does not know
          // they depend on. Astro also keeps the list of dynamic routes
          // (getStaticPaths) for as long as a page module lives. Dropping the
          // server-side modules makes the next request start from the new content.
          onChange: () => {
            for (const [environment, { moduleGraph }] of Object.entries(server.environments)) {
              if (environment !== 'client') moduleGraph.invalidateAll()
            }
            history?.changed()
          },
        })
        code = local.code
        missing = [
          !local.tools.sharp && 'sharp (les images sont gardées telles qu’envoyées)',
          !local.tools.heic && 'heic-convert (les photos HEIC sont refusées)',
          !local.tools.ffmpeg && 'ffmpeg (les vidéos sont gardées telles qu’envoyées)',
        ].filter((tool): tool is string => !!tool)
        const { allows, middleware } = local
        server.middlewares.use(middleware)
        // Live reload travels on a socket of its own, which no middleware sees: it is held to the same rule.
        server.httpServer?.prependListener('upgrade', (req, socket) => {
          if (!allows(req)) socket.destroy()
        })
      },

      'astro:server:start': ({ address, logger }) => {
        const port = address.port
        const onNetwork = !['127.0.0.1', '::1', 'localhost'].includes(address.address)
        // Virtual interfaces (containers, VMs) are not networks the artist can join.
        const lan = Object.entries(os.networkInterfaces())
          .filter(([name]) => !/^(docker|br-|veth|virbr|vmnet|vboxnet)/.test(name))
          .flatMap(([, addresses]) => addresses ?? [])
          .filter((i) => i.family === 'IPv4' && !i.internal)
          .map((i) => i.address)

        const key = `?edit=${formatCode(code)}`
        if (outside) {
          logger.info(`Lien pour l'artiste (à distance) : ${new URL(`/${key}`, outside)}`)
          logger.info(`Le code est demandé ici aussi : http://localhost:${port}/${key}`)
        } else {
          logger.info(`Édition sur cet ordinateur : http://localhost:${port}/?edit`)
        }
        if (onNetwork && lan.length > 0) {
          for (const ip of lan) logger.info(`Lien pour l'artiste (même réseau) : http://${ip}:${port}/${key}`)
        } else if (!outside) {
          logger.info(`Pour ouvrir l'édition à l'artiste sur le réseau local, relancez avec --host`)
        }
        for (const tool of missing) logger.warn(`Outil absent : ${tool}`)
      },
    },
  }
}
