import { render } from 'preact'
import { api, setConversions } from './api.ts'
import { App } from './App.tsx'
import { Login } from './Login.tsx'
import css from './styles.css'

const FLAG = 'foliome'

async function boot() {
  if (document.querySelector('foliome-editor')) return

  // `?edit` asks for the editor; `?edit=CODE` also signs in. Either way it should not linger in the address bar.
  const url = new URL(location.href)
  const code = url.searchParams.get('edit')
  if (url.searchParams.has('edit')) {
    url.searchParams.delete('edit')
    history.replaceState(history.state, '', url)
  }

  const host = document.createElement('foliome-editor')
  // Smooth-scroll libraries must leave the wheel alone inside the editor's panels.
  host.setAttribute('data-lenis-prevent', '')
  const shadow = host.attachShadow({ mode: 'open' })
  const style = document.createElement('style')
  style.textContent = css
  const root = document.createElement('div')
  shadow.append(style, root)
  // A zone with nothing in it has no size: give it one, or it could never be clicked.
  const marks = document.createElement('style')
  marks.textContent = `
    html[data-foliome-mode="edit"] [data-foliome]:empty { min-width: 3em; min-height: 1.2em; outline: 1.5px dashed #e5197d; outline-offset: -1px; }
    html[data-foliome-mode="edit"] :is(span, a, em, strong, small, time)[data-foliome]:empty { display: inline-block; vertical-align: bottom; }
  `
  // Outside <head> and <body>, so page transitions that swap them leave the editor in place.
  document.documentElement.append(marks, host)

  const close = () => {
    render(null, root)
    host.remove()
    marks.remove()
    delete document.documentElement.dataset.foliomeMode
  }

  const start = async () => {
    const [config, initial] = await Promise.all([api.config(), api.content()])
    setConversions(config.converts)
    localStorage.setItem(FLAG, '1')
    const quit = async () => {
      localStorage.removeItem(FLAG)
      await api.logout().catch(() => {})
      close()
    }
    render(<App host={host} config={config} initial={initial} onQuit={quit} />, root)
  }

  if (code) await api.login(code).catch(() => {})
  const { editor } = await api.session()
  if (editor) await start()
  else render(<Login onSuccess={start} onClose={close} />, root)
}

boot().catch((err) => console.error('foliome:', err))
