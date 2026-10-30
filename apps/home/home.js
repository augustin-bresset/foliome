(() => {
  const $ = (id) => document.getElementById(id)
  const root = document.documentElement
  const panel = $('panel')
  const body = $('panel-body')
  const submit = $('panel-submit')

  const WORDS = {
    fr: {
      papers: ['Jaune', 'Rose', 'Outremer', 'Vert sapin', 'Blanc'],
      name: 'Votre nom',
      role: 'Votre discipline, votre ville',
      activity: 'Votre activité',
      trial: 'Un essai : rien n’est conservé.',
      save: 'Enregistrer',
      saved: 'Enregistré',
      paper: 'Couleur du papier',
      pickColour: 'Choisir une couleur',
      colourCode: 'Code de la couleur',
      colour: 'Couleur',
      signIn: 'Accéder à mon site',
      enterCode: 'Saisissez le code d’accès que vous avez reçu.',
      accessCode: 'Code d’accès',
      badCode: 'Ce code n’est pas le bon. Vérifiez-le et réessayez.',
      tooMany: 'Trop d’essais. Patientez cinq minutes avant de réessayer.',
      down: 'Votre site ne répond pas pour le moment. Réessayez dans quelques minutes.',
      offline: 'Impossible de joindre Foliome. Vérifiez votre connexion et réessayez.',
      stories: [
        { name: 'Atelier Morane', role: 'Architecture, Nantes', paper: 'Rose' },
        { name: 'Maison Vesper', role: 'Design graphique, Lyon', paper: 'Outremer' },
      ],
    },
    en: {
      papers: ['Yellow', 'Pink', 'Ultramarine', 'Fir green', 'White'],
      name: 'Your name',
      role: 'Your discipline, your city',
      activity: 'Your work',
      trial: 'Just a try: nothing is kept.',
      save: 'Save',
      saved: 'Saved',
      paper: 'Paper colour',
      pickColour: 'Pick a colour',
      colourCode: 'Colour code',
      colour: 'Colour',
      signIn: 'Go to my site',
      enterCode: 'Enter the access code you were given.',
      accessCode: 'Access code',
      badCode: 'That code is not right. Check it and try again.',
      tooMany: 'Too many tries. Wait five minutes before trying again.',
      down: 'Your site is not responding right now. Try again in a few minutes.',
      offline: 'Foliome cannot be reached. Check your connection and try again.',
      stories: [
        { name: 'Atelier Morane', role: 'Architecture, Nantes', paper: 'Pink' },
        { name: 'Maison Vesper', role: 'Graphic design, Lyon', paper: 'Ultramarine' },
      ],
    },
  }
  const t = WORDS[root.lang]

  // Each paper comes with the ink it is printed in.
  const PAPERS = [
    [t.papers[0], '#ffdf3d', '#1a1fa8'],
    [t.papers[1], '#f6c3d5', '#1a1fa8'],
    [t.papers[2], '#1a1fa8', '#ffdf3d'],
    [t.papers[3], '#0e5a45', '#f6c3d5'],
    [t.papers[4], '#f3f3ef', '#141414'],
  ]
  const INKS = ['#1a1fa8', '#ffdf3d', '#000000', '#ffffff']

  const START = { name: t.name, role: t.role, sheet: '#ffdf3d' }
  const state = { ...START }
  const stillness = matchMedia('(prefers-reduced-motion: reduce)')
  let playing = false

  const luminance = (hex) => {
    const channel = (at) => {
      const value = parseInt(hex.slice(at, at + 2), 16) / 255
      return value <= 0.03928 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4
    }
    return 0.2126 * channel(1) + 0.7152 * channel(3) + 0.0722 * channel(5)
  }
  const contrast = (a, b) => {
    const [light, dark] = [luminance(a), luminance(b)].sort((x, y) => y - x)
    return (light + 0.05) / (dark + 0.05)
  }
  const inkFor = (paper) =>
    PAPERS.find(([, hex]) => hex === paper)?.[2] ?? INKS.reduce((best, ink) => (contrast(ink, paper) > contrast(best, paper) ? ink : best))

  const showSheet = (hex) => {
    root.style.setProperty('--sheet', hex)
    root.style.setProperty('--print', inkFor(hex))
    document.querySelector('meta[name=theme-color]').content = hex
  }

  /** A paper chosen in one click spreads over the page from where it was chosen. */
  const spreadSheet = (hex, from) => {
    if (!document.startViewTransition || stillness.matches) return showSheet(hex)
    const box = from.getBoundingClientRect()
    root.style.setProperty('--spread-x', `${box.left + box.width / 2}px`)
    root.style.setProperty('--spread-y', `${box.top + box.height / 2}px`)
    document.startViewTransition(() => showSheet(hex))
  }

  /** A sheet taller than the screen is read to its end before the next one comes over it. */
  const sheets = [...document.querySelectorAll('.sheet-of-paper')]
  const stack = () => {
    for (const sheet of sheets) sheet.style.top = `${Math.min(0, innerHeight - sheet.offsetHeight)}px`
  }
  sheets.forEach((sheet) => new ResizeObserver(stack).observe(sheet))
  addEventListener('resize', stack)

  /** The name fills the sheet's width, whatever its length, without taking the whole screen. */
  const line = $('name-line')
  const text = $('name-text')
  const fit = () => {
    line.style.fontSize = '100px'
    const width = text.getBoundingClientRect().width || 1
    line.style.fontSize = `${Math.min((100 * line.clientWidth) / width, innerHeight * 0.42)}px`
    if (!panel.hidden) place()
  }
  const showName = (value) => {
    text.textContent = value.trim() || t.name
    fit()
  }
  new ResizeObserver(fit).observe(line)
  document.fonts?.ready.then(fit)
  fit()

  // The panel

  let open = null

  const place = () => {
    if (!open?.anchor || innerWidth <= 600) return
    const box = open.anchor.getBoundingClientRect()
    const { offsetWidth: width, offsetHeight: height } = panel
    const fits = box.bottom + 12 + height < innerHeight
    const top = fits ? box.bottom + 12 : Math.max(12, box.top - height - 12)
    const left = Math.min(Math.max(12, box.left), innerWidth - width - 12)
    panel.style.left = `${left}px`
    panel.style.top = `${Math.max(12, top)}px`
  }

  const close = (restore = true) => {
    if (!open) return
    if (restore) open.restore?.()
    open.anchor?.classList.remove('is-active')
    if (!playing) open.trigger?.focus({ preventScroll: true })
    panel.hidden = true
    open = null
    body.replaceChildren()
  }

  const show = (config) => {
    close()
    open = config
    $('panel-title').textContent = config.title
    $('panel-context').textContent = config.context
    submit.textContent = config.action
    submit.disabled = false
    body.replaceChildren(...config.fields())
    config.anchor?.classList.add('is-active')
    document.body.classList.remove('is-waiting')
    panel.hidden = false
    place()
    if (playing) return
    panel.querySelector('input')?.select?.()
    panel.querySelector('input')?.focus({ preventScroll: true })
  }

  const el = (tag, props = {}, ...children) => {
    const node = Object.assign(document.createElement(tag), props)
    node.append(...children)
    return node
  }

  const field = (label, ...controls) => el('label', { className: 'field' }, el('span', { className: 'label', textContent: label }), ...controls)

  const toast = (message) => {
    const box = $('toast')
    box.textContent = message
    box.hidden = false
    clearTimeout(toast.timer)
    toast.timer = setTimeout(() => (box.hidden = true), 2600)
  }

  const textZone = (id, key, title, apply) => {
    const zone = $(id)
    zone.addEventListener('click', () => {
      const before = state[key]
      let input
      show({
        anchor: zone,
        trigger: zone,
        title,
        context: 'Un essai : rien n’est conservé.',
        action: t.save,
        fields: () => {
          input = el('input', { className: 'input', value: before, maxLength: 60, autocomplete: 'off' })
          input.addEventListener('input', () => apply(input.value))
          return [field(title, input)]
        },
        restore: () => apply(before),
        save: () => {
          state[key] = input.value.trim() || before
          apply(state[key])
          return t.saved
        },
      })
    })
  }

  textZone('name', 'name', t.name, showName)
  textZone('role', 'role', t.activity, (value) => {
    $('role').textContent = value.trim() || t.role
  })

  $('sheet').addEventListener('click', () => {
    const before = state.sheet
    let current = before
    show({
      anchor: $('sheet'),
      trigger: $('sheet'),
      title: t.paper,
      context: 'Un essai : rien n’est conservé.',
      action: t.save,
      fields: () => {
        const well = el('input', { className: 'color-well', type: 'color', value: before, ariaLabel: t.pickColour })
        const code = el('input', { className: 'input color-code', value: before, maxLength: 7, spellcheck: false, ariaLabel: t.colourCode })
        const swatches = PAPERS.map(([name, hex]) => {
          const swatch = el('button', { type: 'button', className: 'swatch', title: name, ariaLabel: name })
          swatch.style.background = hex
          swatch.addEventListener('click', () => set(hex, swatch))
          return swatch
        })
        const mark = () => swatches.forEach((swatch, at) => swatch.setAttribute('aria-pressed', String(PAPERS[at][1] === current)))
        const set = (hex, from) => {
          current = hex
          well.value = hex
          if (code.value !== hex) code.value = hex
          if (from) spreadSheet(hex, from)
          else showSheet(hex)
          mark()
        }
        well.addEventListener('input', () => set(well.value))
        code.addEventListener('input', () => {
          const value = code.value.trim().toLowerCase()
          if (/^#[0-9a-f]{6}$/.test(value)) set(value)
        })
        mark()
        return [el('div', { className: 'field' }, el('span', { className: 'label', textContent: t.colour }), el('div', { className: 'color-row' }, well, code), el('div', { className: 'swatches' }, ...swatches))]
      },
      restore: () => showSheet(before),
      save: () => {
        state.sheet = current
        return t.saved
      },
    })
  })

  // Signing in: the access code leads to the artist's own site.
  const signIn = (trigger) => {
    let input
    let error
    show({
      anchor: trigger,
      trigger,
      title: t.signIn,
      context: t.enterCode,
      action: t.signIn,
      fields: () => {
        input = el('input', { className: 'input', autocomplete: 'off', autocapitalize: 'characters', spellcheck: false, placeholder: 'ABCD-EFGH', required: true })
        error = el('p', { className: 'error', hidden: true, role: 'alert' })
        return [field(t.accessCode, input), error]
      },
      save: async () => {
        const fail = (message) => {
          error.textContent = message
          error.hidden = false
          place()
          return false
        }
        submit.disabled = true
        try {
          const res = await fetch('/entrer', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ code: input.value }) })
          if (res.ok) {
            location.assign((await res.json()).url)
            return false
          }
          if (res.status === 401) return fail(t.badCode)
          if (res.status === 429) return fail(t.tooMany)
          return fail(t.down)
        } catch {
          return fail(t.offline)
        } finally {
          submit.disabled = false
        }
      },
    })
  }
  $('signin').addEventListener('click', () => signIn($('signin')))
  $('signin-foot').addEventListener('click', () => signIn($('signin-foot')))

  $('panel-form').addEventListener('submit', async (event) => {
    event.preventDefault()
    const message = await open?.save()
    if (!message) return
    close(false)
    toast(message)
  })
  $('panel-close').addEventListener('click', () => close())
  $('panel-cancel').addEventListener('click', () => close())
  addEventListener('keydown', (event) => {
    if (event.key === 'Escape') close()
  })
  addEventListener('resize', place)
  addEventListener('scroll', place, { passive: true })

  // The page shows what it does by itself, until the visitor does anything at all.

  const ghost = $('ghost')
  const STOPPED = Symbol('stopped')
  let cancel = () => {}

  const sleep = (ms) =>
    new Promise((done, fail) => {
      const timer = setTimeout(done, ms)
      cancel = () => {
        clearTimeout(timer)
        fail(STOPPED)
      }
    })

  const reach = async (target) => {
    const box = target.getBoundingClientRect()
    ghost.style.setProperty('--ghost-x', `${box.left + Math.min(box.width / 2, 140)}px`)
    ghost.style.setProperty('--ghost-y', `${box.top + box.height * 0.6}px`)
    await sleep(760)
    target.classList.add('is-reached')
    await sleep(240)
  }

  const press = async (target) => {
    ghost.classList.add('is-pressing')
    await sleep(120)
    ghost.classList.remove('is-pressing')
    target.classList.remove('is-reached')
    target.click()
    await sleep(380)
  }

  const type = async (value) => {
    const input = panel.querySelector('input')
    const change = (next) => {
      input.value = next
      input.dispatchEvent(new Event('input'))
    }
    while (input.value) {
      change(input.value.slice(0, -1))
      await sleep(24)
    }
    for (const letter of value) {
      change(input.value + letter)
      await sleep(55 + Math.random() * 55)
    }
    await sleep(320)
  }

  const edit = async (zone, value) => {
    await reach(zone)
    await press(zone)
    await type(value)
    await reach(submit)
    await press(submit)
  }

  const backToStart = () => {
    Object.assign(state, START)
    showName(START.name)
    $('role').textContent = START.role
    ghost.hidden = true
    document.querySelectorAll('.is-reached').forEach((zone) => zone.classList.remove('is-reached'))
    document.body.classList.add('is-waiting')
  }

  const stop = () => {
    if (!playing) return
    cancel()
    close()
    playing = false
    showSheet(START.sheet)
    backToStart()
  }

  const play = async () => {
    playing = true
    try {
      await sleep(1500)
      document.body.classList.remove('is-waiting')
      ghost.hidden = false
      await sleep(60)
      for (const story of t.stories) {
        await edit($('name'), story.name)
        await edit($('role'), story.role)
        await reach($('sheet'))
        await press($('sheet'))
        const swatch = panel.querySelector(`.swatch[title="${story.paper}"]`)
        await reach(swatch)
        await press(swatch)
        await sleep(950)
        await reach(submit)
        await press(submit)
        await sleep(1900)
      }
      playing = false
      spreadSheet(START.sheet, $('name'))
      backToStart()
    } catch (reason) {
      if (reason !== STOPPED) throw reason
    }
  }

  for (const event of ['pointerdown', 'keydown', 'wheel', 'touchstart']) {
    addEventListener(event, stop, { capture: true, passive: true })
  }
  if (!stillness.matches) play()
})()
