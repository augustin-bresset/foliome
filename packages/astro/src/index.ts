import { createRequire } from 'node:module'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Fields } from '@foliome/core'
import type { AstroIntegration } from 'astro'
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
}

// Runs before anything else on the page. The editor only loads for someone who
// asked for it (`?edit`) or used it before on this device.
const LOADER = `(function(){try{var q=new URLSearchParams(location.search);if(q.has('edit')||localStorage.getItem('foliome')==='1'){if(sessionStorage.getItem('foliome:quiet')){document.documentElement.classList.add('foliome-quiet')}var s=document.createElement('script');s.src='/_foliome/editor.js';s.defer=true;document.head.appendChild(s)}}catch(e){}})()`

export default function foliome(options: FoliomeOptions): AstroIntegration {
  const { name, content, locales, publish, allowedHosts = [] } = options
  let root = process.cwd()
  let code = ''
  let missing: string[] = []

  return {
    name: 'foliome',
    hooks: {
      'astro:config:setup': ({ command, injectScript, updateConfig }) => {
        if (command !== 'dev') return
        injectScript('head-inline', LOADER)
        // The artist edits on this server: Astro's own developer toolbar has no place on their screen.
        updateConfig({ devToolbar: { enabled: false } })
      },

      'astro:config:done': ({ config }) => {
        root = fileURLToPath(config.root)
        // Read by `@foliome/astro/content`, which runs in the pages.
        process.env.FOLIOME_ROOT = root
        process.env.FOLIOME_BASE = config.base
        process.env.FOLIOME_LOCALES = (locales ?? []).join(',')
      },

      'astro:server:setup': async ({ server }) => {
        process.env.FOLIOME_EDITABLE = '1'
        const editorPackage = createRequire(import.meta.url).resolve('@foliome/editor/package.json')
        const local = await createLocal({
          root,
          name,
          schema: { content, locales },
          allowedHosts,
          publish,
          editorFile: path.join(path.dirname(editorPackage), 'dist', 'editor.js'),
          // Pages are rendered from the content file, which Vite does not know
          // they depend on. Astro also keeps the list of dynamic routes
          // (getStaticPaths) for as long as a page module lives. Dropping the
          // server-side modules makes the next request start from the new content.
          onChange: () => {
            for (const [environment, { moduleGraph }] of Object.entries(server.environments)) {
              if (environment !== 'client') moduleGraph.invalidateAll()
            }
          },
        })
        code = local.code
        missing = [
          !local.tools.sharp && 'sharp (les images sont gardées telles qu’envoyées)',
          !local.tools.heic && 'heic-convert (les photos HEIC sont refusées)',
          !local.tools.ffmpeg && 'ffmpeg (les vidéos sont gardées telles qu’envoyées)',
        ].filter((tool): tool is string => !!tool)
        server.middlewares.use(local.middleware)
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

        logger.info(`Édition sur cet ordinateur : http://localhost:${port}/?edit`)
        if (onNetwork && lan.length > 0) {
          for (const ip of lan) logger.info(`Lien pour l'artiste (même réseau) : http://${ip}:${port}/?edit=${formatCode(code)}`)
        } else {
          logger.info(`Pour ouvrir l'édition à l'artiste sur le réseau local, relancez avec --host`)
        }
        for (const tool of missing) logger.warn(`Outil absent : ${tool}`)
      },
    },
  }
}
