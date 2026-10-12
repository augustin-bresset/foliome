import { type Doc, resolvePath, type Schema } from '@foliome/core'
import { useEffect, useRef, useState } from 'preact/hooks'
import { api, explain, type SiteConfig } from './api.ts'
import { type Open, Panel } from './Panel.tsx'
import { useFollow, zoneAt } from './zones.ts'

interface Props {
  host: HTMLElement
  config: SiteConfig
  initial: { content: Doc; canUndo: boolean }
  onQuit: () => void
}

type Mode = 'edit' | 'browse'

/** Reads a one-shot value left for the next page load. */
function take(key: string): string | null {
  const value = sessionStorage.getItem(key)
  if (value !== null) sessionStorage.removeItem(key)
  return value
}

function labelOf(schema: Schema, content: Doc, path: string): string {
  const target = resolvePath(schema, content, path)
  if (!target) return path
  return target.kind === 'item' ? target.type.label : target.def.label
}

function Outline(props: { el: HTMLElement; active?: boolean; label?: string; link?: HTMLAnchorElement | null; onEdit?: () => void; onFollow?: () => void }) {
  const box = useRef<HTMLDivElement>(null)
  useFollow(props.el, (r) => {
    const el = box.current
    if (!el) return
    el.style.transform = `translate(${r.left}px, ${r.top}px)`
    el.style.width = `${r.width}px`
    el.style.height = `${r.height}px`
    // No room above the zone at the top of the screen: tuck the tag inside.
    el.classList.toggle('is-flipped', r.top < 30)
  })
  return (
    <div ref={box} class={props.active ? 'outline is-active' : 'outline'}>
      {props.label && (
        <div class="tag">
          <button type="button" class="tag-btn" onClick={props.onEdit}>
            {props.label}
          </button>
          {props.link && (
            <button type="button" class="tag-btn is-quiet" onClick={props.onFollow}>
              Ouvrir la page
            </button>
          )}
        </div>
      )}
    </div>
  )
}

export function App({ host, config, initial, onQuit }: Props) {
  const { schema } = config
  const [mode, setMode] = useState<Mode>(() => (sessionStorage.getItem('foliome:mode') === 'browse' ? 'browse' : 'edit'))
  const [hovered, setHovered] = useState<HTMLElement | null>(null)
  const [open, setOpen] = useState<Open | null>(null)
  const [panelKey, setPanelKey] = useState(0)
  const [nudge, setNudge] = useState(0)
  const [menu, setMenu] = useState(false)
  const [toast, setToast] = useState<string | null>(() => take('foliome:toast'))
  const [busy, setBusy] = useState<'undo' | 'publish' | null>(null)
  const [failure, setFailure] = useState<string | null>(null)

  // Event handlers below are registered once; they read the latest state through this ref.
  const dirty = useRef(false)
  const live = useRef({ mode, open })
  live.current = { mode, open }
  const following = useRef(false)

  const show = (next: Open | null) => {
    setOpen(next)
    setPanelKey((k) => k + 1)
    setMenu(false)
  }

  /** Opens something else, unless that would throw away what is being typed. */
  const go = (next: Open) => (dirty.current ? setNudge((n) => n + 1) : show(next))

  const edit = (zone: HTMLElement) => {
    go({ kind: 'path', path: zone.dataset.foliome ?? '', anchor: zone })
    setHovered(null)
  }

  /** Reloads so the page is rendered again from the stored content, with every effect set up by the site itself. */
  const refresh = (message: string, goto?: string) => {
    sessionStorage.setItem('foliome:toast', message)
    sessionStorage.setItem('foliome:quiet', '1')
    if (goto && location.pathname.replace(/\/$/, '') !== goto.replace(/\/$/, '')) location.assign(goto)
    else location.reload()
  }

  useEffect(() => {
    sessionStorage.removeItem('foliome:quiet')
    const inEditor = (e: Event) => e.composedPath().includes(host)

    const onMove = (e: PointerEvent) => {
      if (live.current.mode !== 'edit' || e.pointerType === 'touch') return
      // Over the editor's own controls, keep the current zone: its tag is being reached for.
      if (inEditor(e)) return
      setHovered(zoneAt(e.clientX, e.clientY, host))
    }
    const onLeave = () => setHovered(null)

    const onClick = (e: MouseEvent) => {
      if (inEditor(e)) return
      setMenu(false)
      if (live.current.mode !== 'edit' || following.current) return
      const zone = zoneAt(e.clientX, e.clientY, host)
      if (zone) {
        e.preventDefault()
        e.stopImmediatePropagation()
        edit(zone)
      } else if (live.current.open?.kind === 'path' && live.current.open.anchor && !dirty.current) {
        show(null)
      }
    }

    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return
      setMenu(false)
      if (live.current.open && !dirty.current) show(null)
    }

    // Page transitions replace the content: anything attached to the old page is gone.
    const onSwap = () => {
      setHovered(null)
      if (live.current.open?.kind === 'path' && live.current.open.anchor) show(null)
    }

    window.addEventListener('pointermove', onMove, { passive: true })
    document.documentElement.addEventListener('pointerleave', onLeave)
    window.addEventListener('click', onClick, true)
    window.addEventListener('keydown', onKey)
    document.addEventListener('astro:before-swap', onSwap)
    return () => {
      window.removeEventListener('pointermove', onMove)
      document.documentElement.removeEventListener('pointerleave', onLeave)
      window.removeEventListener('click', onClick, true)
      window.removeEventListener('keydown', onKey)
      document.removeEventListener('astro:before-swap', onSwap)
    }
  }, [])

  // Lets the page (and the editor's own marks for empty zones) know which mode is on.
  useEffect(() => {
    document.documentElement.dataset.foliomeMode = mode
  }, [mode])

  useEffect(() => {
    if (!toast) return
    const timer = setTimeout(() => setToast(null), 2600)
    return () => clearTimeout(timer)
  }, [toast])

  const choose = (next: Mode) => {
    setMode(next)
    sessionStorage.setItem('foliome:mode', next)
    if (next === 'browse') {
      setHovered(null)
      if (!dirty.current && open?.kind === 'path' && open.anchor) show(null)
    }
  }

  const undo = async () => {
    if (busy) return
    setBusy('undo')
    try {
      const { ok } = await api.undo()
      if (ok) {
        // Undoing the creation of a page while standing on it leaves nothing here to reload: go back to the home page, in the same language.
        const gone = await fetch(location.href, { method: 'HEAD' }).then(
          (response) => response.status === 404,
          () => false,
        )
        const first = location.pathname.split('/').find(Boolean)
        const home = first && schema.locales?.slice(1).includes(first) ? `/${first}` : '/'
        return refresh('Dernière modification annulée', gone ? home : undefined)
      }
      setToast('Rien à annuler')
    } catch (err) {
      setToast(explain(err))
    }
    setBusy(null)
  }

  const publish = async () => {
    if (busy) return
    if (dirty.current) return setNudge((n) => n + 1)
    setBusy('publish')
    setFailure(null)
    try {
      const result = await api.publish()
      if (result.ok) setToast('Site mis en ligne')
      else setFailure(result.log)
    } catch (err) {
      setFailure(explain(err))
    }
    setBusy(null)
  }

  const anchor = open?.kind === 'path' ? open.anchor : null
  const link = hovered?.closest<HTMLAnchorElement>('a[href]') ?? null
  const entries = Object.entries(schema.content)

  return (
    <>
      {mode === 'edit' && hovered && hovered !== anchor && (
        <Outline
          el={hovered}
          label={labelOf(schema, initial.content, hovered.dataset.foliome ?? '')}
          link={link}
          onEdit={() => edit(hovered)}
          onFollow={() => {
            // Let the site handle its own link, page transition included.
            following.current = true
            link?.click()
            following.current = false
          }}
        />
      )}
      {anchor && <Outline el={anchor} active />}

      {open && (
        <Panel
          key={panelKey}
          schema={schema}
          content={initial.content}
          open={open}
          nudge={nudge}
          onDirty={(value) => {
            dirty.current = value
          }}
          onClose={() => show(null)}
          onOpen={show}
          onSaved={refresh}
        />
      )}

      {failure && (
        <>
          <div class="scrim" />
          <div class="panel is-centered" role="alertdialog" aria-label="La mise en ligne a échoué">
            <header class="panel-head">
              <div>
                <h2 class="panel-title">La mise en ligne a échoué</h2>
                <p class="panel-context">Vos modifications sont bien enregistrées. Transmettez ce message à votre développeur.</p>
              </div>
              <button type="button" class="close" aria-label="Fermer" onClick={() => setFailure(null)} />
            </header>
            <pre class="log">{failure}</pre>
            <footer class="panel-foot">
              <button type="button" class="btn" onClick={() => setFailure(null)}>
                Fermer
              </button>
            </footer>
          </div>
        </>
      )}

      {/* Everything editable, including what cannot be clicked on the page: content drawn in WebGL, hidden states, text for search engines. */}
      {menu && (
        <div class="menu" role="menu" aria-label="Contenu du site">
          {entries.map(([name, def]) => (
            <button type="button" class="menu-item" role="menuitem" onClick={() => go({ kind: 'path', path: name, anchor: null })}>
              {def.label}
            </button>
          ))}
        </div>
      )}

      <div class="bar" role="toolbar" aria-label={`Édition de ${config.name}`}>
        <div class="seg">
          <button type="button" class="seg-btn" aria-pressed={mode === 'edit'} onClick={() => choose('edit')}>
            Modifier
          </button>
          <button type="button" class="seg-btn" aria-pressed={mode === 'browse'} onClick={() => choose('browse')}>
            Parcourir
          </button>
        </div>
        <button type="button" class="bar-btn" aria-haspopup="menu" aria-expanded={menu} onClick={() => setMenu(!menu)}>
          Contenu
        </button>
        {entries.map(
          ([name, def]) =>
            def.type === 'list' &&
            def.addLabel && (
              <button type="button" class="bar-btn" onClick={() => go({ kind: 'create', list: name })}>
                <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true">
                  <path d="M8 2.5v11M2.5 8h11" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" />
                </svg>
                {def.addLabel}
              </button>
            ),
        )}
        <button type="button" class="bar-btn" disabled={!!busy || !initial.canUndo} title="Annuler la dernière modification enregistrée" onClick={undo}>
          <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true">
            <path d="M3 6.5h6.2a3.8 3.8 0 0 1 0 7.6H6M3 6.5l3-3M3 6.5l3 3" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" />
          </svg>
          Annuler
        </button>
        {config.publish && (
          <button type="button" class="bar-btn is-strong" disabled={!!busy} onClick={publish}>
            {busy === 'publish' ? 'Mise en ligne…' : 'Mettre en ligne'}
          </button>
        )}
        <button type="button" class="bar-btn" onClick={onQuit}>
          Quitter
        </button>
      </div>

      {toast && !menu && (
        <div class="toast" role="status">
          {toast}
        </div>
      )}
    </>
  )
}
