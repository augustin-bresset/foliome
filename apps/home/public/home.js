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
      create: 'Créer',
      created: 'Créé',
      remove: 'Supprimer',
      removed: 'Supprimé',
      paper: 'Couleur du papier',
      pickColour: 'Choisir une couleur',
      colourCode: 'Code de la couleur',
      colour: 'Couleur',
      works: 'Projets',
      work: 'Projet',
      yourWorks: 'Vos projets',
      worksTag: 'Projets : il n’y en a pas encore',
      newWork: 'Nouveau projet',
      title: 'Titre',
      year: 'Année',
      image: 'Image',
      pickImage: 'Choisir une image',
      otherImage: 'Changer d’image',
      imageStays: 'Elle reste sur votre appareil.',
      editing: 'Édition de votre site',
      undo: 'Annuler',
      undoHint: 'Annuler la dernière modification enregistrée',
      undone: 'Dernière modification annulée',
      nothingToUndo: 'Rien à annuler',
      publish: 'Mettre en ligne',
      published: 'Sur votre site, vos visiteurs verraient maintenant cette version.',
      signIn: 'Accéder à mon site',
      enterCode: 'Saisissez le code d’accès que vous avez reçu.',
      accessCode: 'Code d’accès',
      badCode: 'Ce code n’est pas le bon. Vérifiez-le et réessayez.',
      tooMany: 'Trop d’essais. Patientez cinq minutes avant de réessayer.',
      down: 'Votre site ne répond pas pour le moment. Réessayez dans quelques minutes.',
      busy: 'Le serveur est très demandé en ce moment. Réessayez dans quelques minutes.',
      opening: 'Ouverture de votre site…',
      offline: 'Impossible de joindre Foliome. Vérifiez votre connexion et réessayez.',
      stories: [
        { name: 'Atelier Morane', role: 'Architecture, Nantes', work: 'Halle aux grains', year: '2025', paper: 'Rose' },
        { name: 'Maison Vesper', role: 'Design graphique, Lyon', work: 'Affiches du quai', year: '2024', paper: 'Outremer' },
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
      create: 'Create',
      created: 'Created',
      remove: 'Delete',
      removed: 'Deleted',
      paper: 'Paper colour',
      pickColour: 'Pick a colour',
      colourCode: 'Colour code',
      colour: 'Colour',
      works: 'Projects',
      work: 'Project',
      yourWorks: 'Your projects',
      worksTag: 'Projects: none yet',
      newWork: 'New project',
      title: 'Title',
      year: 'Year',
      image: 'Image',
      pickImage: 'Pick an image',
      otherImage: 'Change the image',
      imageStays: 'It stays on your device.',
      editing: 'Editing your site',
      undo: 'Undo',
      undoHint: 'Undo the last saved change',
      undone: 'Last change undone',
      nothingToUndo: 'Nothing to undo',
      publish: 'Publish',
      published: 'On your site, visitors would now see this version.',
      signIn: 'Go to my site',
      enterCode: 'Enter the access code you were given.',
      accessCode: 'Access code',
      badCode: 'That code is not right. Check it and try again.',
      tooMany: 'Too many tries. Wait five minutes before trying again.',
      down: 'Your site is not responding right now. Try again in a few minutes.',
      busy: 'The server is very busy right now. Try again in a few minutes.',
      opening: 'Opening your site…',
      offline: 'Foliome cannot be reached. Check your connection and try again.',
      stories: [
        { name: 'Atelier Morane', role: 'Architecture, Nantes', work: 'Grain hall', year: '2025', paper: 'Pink' },
        { name: 'Maison Vesper', role: 'Graphic design, Lyon', work: 'Posters for the quay', year: '2024', paper: 'Ultramarine' },
      ],
    },
  }
  const t = WORDS[root.lang]

  // While the page itself is being edited, the real editor has its own bar and the trial must keep out of its way.
  const editing = document.body.hasAttribute('data-editing')

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
  const state = { ...START, works: [] }
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
  const showRole = (value) => {
    $('role').textContent = value.trim() || t.role
  }
  new ResizeObserver(fit).observe(line)
  document.fonts?.ready.then(fit)
  fit()

  const el = (tag, props = {}, ...children) => {
    const node = Object.assign(document.createElement(tag), props)
    node.append(...children)
    return node
  }

  const icon = (d) => {
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg')
    svg.setAttribute('viewBox', '0 0 16 16')
    svg.setAttribute('width', '13')
    svg.setAttribute('height', '13')
    svg.setAttribute('aria-hidden', 'true')
    svg.innerHTML = d
    return svg
  }

  // The panel

  let open = null

  const place = () => {
    if (!open || innerWidth <= 600) return
    const { offsetWidth: width, offsetHeight: height } = panel
    // Opened from the bar: the panel stands just above it.
    if (!open.anchor) {
      panel.style.left = `${(innerWidth - width) / 2}px`
      panel.style.top = `${Math.max(12, innerHeight - height - 64)}px`
      return
    }
    const box = open.anchor.getBoundingClientRect()
    const fits = box.bottom + 12 + height < innerHeight - 56
    const top = fits ? box.bottom + 12 : Math.max(12, box.top - height - 12)
    const left = Math.min(Math.max(12, box.left), innerWidth - width - 12)
    panel.style.left = `${left}px`
    panel.style.top = `${Math.max(12, top)}px`
  }

  // A panel that grows, with an image chosen or an error shown, stays on the screen.
  new ResizeObserver(() => open && place()).observe(panel)

  const remove = el('button', { type: 'button', className: 'link is-danger', textContent: t.remove, hidden: true })
  $('panel-cancel').before(remove)

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
    remove.hidden = !config.remove
    body.replaceChildren(...config.fields())
    config.anchor?.classList.add('is-active')
    document.body.classList.remove('is-waiting')
    panel.hidden = false
    place()
    if (playing) return
    panel.querySelector('input')?.select?.()
    panel.querySelector('input')?.focus({ preventScroll: true })
  }

  const field = (label, ...controls) => el('label', { className: 'field' }, el('span', { className: 'label', textContent: label }), ...controls)

  const toast = (message) => {
    const box = $('toast')
    box.textContent = message
    box.hidden = false
    clearTimeout(toast.timer)
    toast.timer = setTimeout(() => (box.hidden = true), 2600)
  }

  // What was saved, so it can be undone: as in the editor, one step per save.

  const history = []
  const snapshot = () => ({ ...state, works: state.works.map((work) => ({ ...work })) })
  const remember = () => {
    history.push(snapshot())
    undoButton.disabled = false
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
        context: t.trial,
        action: t.save,
        fields: () => {
          input = el('input', { className: 'input', value: before, maxLength: 60, autocomplete: 'off' })
          input.addEventListener('input', () => apply(input.value))
          return [field(title, input)]
        },
        restore: () => apply(before),
        save: () => {
          remember()
          state[key] = input.value.trim() || before
          apply(state[key])
          return t.saved
        },
      })
    })
  }

  textZone('name', 'name', t.name, showName)
  textZone('role', 'role', t.activity, showRole)

  $('sheet').addEventListener('click', () => {
    const before = state.sheet
    let current = before
    show({
      anchor: $('sheet'),
      trigger: $('sheet'),
      title: t.paper,
      context: t.trial,
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
        remember()
        state.sheet = current
        return t.saved
      },
    })
  })

  // The visitor's projects: what the bar's "New project" adds to.

  const works = $('works')
  let nextWork = 1

  const showWorks = () => {
    if (editing) return
    const list = state.works.map((work) => {
      const cover = el('span', { className: 'work-cover' })
      if (work.image) cover.append(el('img', { src: work.image, alt: '' }))
      else cover.textContent = work.title.charAt(0)
      const zone = el(
        'button',
        { type: 'button', className: 'zone work' },
        cover,
        el('span', { className: 'work-title', textContent: work.title }),
        el('span', { className: 'work-year', textContent: work.year }),
      )
      zone.dataset.tag = t.work
      zone.dataset.work = work.id
      zone.addEventListener('click', () => openWork(work.id))
      return el('li', {}, zone)
    })
    if (list.length) return works.replaceChildren(el('ol', { className: 'works-list', ariaLabel: t.works }, ...list))
    const empty = el('button', { type: 'button', className: 'zone works-empty', textContent: t.yourWorks })
    empty.dataset.tag = t.worksTag
    empty.addEventListener('click', () => openWork(null, empty))
    works.replaceChildren(empty)
  }

  /** A new project when `id` is null, from the bar or the empty list; otherwise the project shown with that id. */
  const openWork = (id, trigger = addButton) => {
    const work = state.works.find((one) => one.id === id)
    const zone = work && works.querySelector(`[data-work="${work.id}"]`)
    let title
    let year
    let image = work?.image ?? null
    show({
      anchor: zone ?? (works.contains(trigger) ? trigger : null),
      trigger: zone ?? trigger,
      title: work ? work.title : t.newWork,
      context: t.trial,
      action: work ? t.save : t.create,
      fields: () => {
        title = el('input', { className: 'input', value: work?.title ?? '', maxLength: 60, autocomplete: 'off', required: true })
        year = el('input', { className: 'input', value: work?.year ?? '', maxLength: 4, inputMode: 'numeric', autocomplete: 'off' })
        const preview = el('img', { className: 'file-preview', alt: '', hidden: !image, src: image ?? '' })
        const name = el('span', { textContent: image ? t.otherImage : t.pickImage })
        const picker = el('input', { type: 'file', accept: 'image/*', className: 'file-input' })
        picker.addEventListener('change', () => {
          const file = picker.files[0]
          if (!file) return
          image = URL.createObjectURL(file)
          preview.src = image
          preview.hidden = false
          name.textContent = t.otherImage
        })
        return [
          field(t.title, title),
          field(t.year, year),
          el('div', { className: 'field' }, el('span', { className: 'label', textContent: t.image }), preview, el('label', { className: 'btn file-pick' }, name, picker), el('span', { className: 'hint', textContent: t.imageStays })),
        ]
      },
      remove: work
        ? () => {
            remember()
            state.works = state.works.filter((one) => one.id !== work.id)
            showWorks()
            return t.removed
          }
        : null,
      save: () => {
        remember()
        const values = { title: title.value.trim(), year: year.value.trim(), image }
        if (work) Object.assign(state.works.find((one) => one.id === work.id), values)
        else state.works.push({ id: String(nextWork++), ...values })
        showWorks()
        return work ? t.saved : t.created
      },
    })
  }

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
        // A site that was asleep takes a few seconds to wake.
        const slow = setTimeout(() => (submit.textContent = t.opening), 1200)
        try {
          const res = await fetch('/entrer', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ code: input.value }) })
          if (res.ok) {
            location.assign((await res.json()).url)
            return false
          }
          if (res.status === 401) return fail(t.badCode)
          if (res.status === 429) return fail(t.tooMany)
          if (res.status === 503 && (await res.json().catch(() => ({}))).error === 'busy') return fail(t.busy)
          return fail(t.down)
        } catch {
          return fail(t.offline)
        } finally {
          clearTimeout(slow)
          submit.textContent = t.signIn
          submit.disabled = false
        }
      },
    })
  }
  $('signin').addEventListener('click', () => signIn($('signin')))
  $('signin-foot').addEventListener('click', () => signIn($('signin-foot')))

  // A light copy of the editor's bar: what the artist finds at the bottom of their own site.

  const addButton = el('button', { type: 'button', className: 'bar-btn', onclick: () => openWork(null) }, icon('<path d="M8 2.5v11M2.5 8h11" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/>'), t.newWork)
  const undoButton = el(
    'button',
    { type: 'button', className: 'bar-btn', title: t.undoHint, disabled: true, onclick: () => undo() },
    icon('<path d="M3 6.5h6.2a3.8 3.8 0 0 1 0 7.6H6M3 6.5l3-3M3 6.5l3 3" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/>'),
    t.undo,
  )
  const publishButton = el('button', { type: 'button', className: 'bar-btn is-strong', textContent: t.publish, onclick: () => toast(t.published) })
  if (!editing) {
    document.body.append(el('div', { className: 'bar', role: 'toolbar', ariaLabel: t.editing }, addButton, undoButton, publishButton))
    document.body.classList.add('has-bar')
  }
  showWorks()

  const undo = () => {
    const before = history.pop()
    if (!before) return toast(t.nothingToUndo)
    close(false)
    Object.assign(state, before)
    showName(state.name)
    showRole(state.role)
    showSheet(state.sheet)
    showWorks()
    undoButton.disabled = !history.length
    toast(t.undone)
  }

  $('panel-form').addEventListener('submit', async (event) => {
    event.preventDefault()
    const message = await open?.save()
    if (!message) return
    close(false)
    toast(message)
  })
  remove.addEventListener('click', () => {
    const message = open?.remove?.()
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

  const type = async (value, input = panel.querySelector('input')) => {
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
    Object.assign(state, START, { works: [] })
    history.length = 0
    undoButton.disabled = true
    showName(START.name)
    showRole(START.role)
    showWorks()
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
        await reach(addButton)
        await press(addButton)
        const [title, year] = panel.querySelectorAll('input')
        await type(story.work, title)
        await type(story.year, year)
        await reach(submit)
        await press(submit)
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
  // Sent here by a site whose editing had gone to sleep: straight to the code.
  if (location.hash === '#entrer') signIn($('signin'))
  else if (!stillness.matches && !editing) play()
})()
