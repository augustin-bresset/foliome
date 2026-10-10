import gsap from 'gsap'
import { ScrollTrigger } from 'gsap/ScrollTrigger'
import { SplitText } from 'gsap/SplitText'
import Lenis from 'lenis'
import 'lenis/dist/lenis.css'

gsap.registerPlugin(ScrollTrigger, SplitText)

const reduced = matchMedia('(prefers-reduced-motion: reduce)')
let lenis: Lenis | undefined
let context: gsap.Context | undefined
let firstLoad = true

function intro() {
  // Home: the project titles rise into place, one after the other.
  if (document.querySelector('.row-title-in')) {
    gsap.from('.row-title-in', { yPercent: 108, duration: 1.1, ease: 'expo.out', stagger: 0.07 })
    gsap.from('.baseline, .row-meta', { opacity: 0, duration: 0.8, delay: 0.35 })
  }
  // Project page: the title is set letter by letter.
  const title = document.querySelector<HTMLElement>('.project-title')
  if (title) {
    const split = SplitText.create(title, { type: 'words,chars', mask: 'chars' })
    gsap.from(split.chars, { yPercent: 108, duration: 0.9, ease: 'expo.out', stagger: 0.018 })
  }
}

function preview() {
  const figure = document.querySelector<HTMLElement>('.preview')
  const list = document.querySelector<HTMLElement>('.rows')
  if (!figure || !list || !matchMedia('(hover: hover) and (pointer: fine)').matches) return

  const x = gsap.quickTo(figure, 'x', { duration: 0.5, ease: 'power3' })
  const y = gsap.quickTo(figure, 'y', { duration: 0.5, ease: 'power3' })
  gsap.set(figure, { xPercent: 10, yPercent: -50 })

  list.addEventListener('pointermove', (e) => {
    x(Math.min(e.clientX, window.innerWidth - figure.offsetWidth * 1.15))
    y(e.clientY)
  })
  list.addEventListener('pointerleave', () => gsap.to(figure, { autoAlpha: 0, duration: 0.25 }))
  for (const row of list.querySelectorAll<HTMLElement>('.row')) {
    row.addEventListener('pointerenter', () => {
      for (const img of figure.querySelectorAll('img')) img.classList.toggle('is-on', img.dataset.for === row.dataset.row)
      gsap.to(figure, { autoAlpha: 1, duration: 0.25 })
    })
  }
}

function setup() {
  // An editing session reloads the page after each change (`foliome-quiet`):
  // replaying the intro every time would get in the way.
  const quiet = document.documentElement.classList.contains('foliome-quiet')
  const playIntro = firstLoad && !quiet && !reduced.matches
  firstLoad = false

  if (!reduced.matches && !lenis) {
    lenis = new Lenis({ autoRaf: true })
    lenis.on('scroll', ScrollTrigger.update)
  }
  lenis?.resize()

  context = gsap.context(() => {
    if (playIntro) intro()
    preview()
    if (!reduced.matches && document.querySelector('.cover img')) {
      gsap.fromTo(
        '.cover img',
        { yPercent: -10 },
        { yPercent: 0, ease: 'none', scrollTrigger: { trigger: '.cover', start: 'top bottom', end: 'bottom top', scrub: true } },
      )
    }
  })

  // The 3D viewer is heavy: only pages that show a model pay for it.
  if (document.querySelector('model-viewer')) import('@google/model-viewer')
}

document.addEventListener('astro:page-load', setup)
document.addEventListener('astro:before-swap', () => {
  context?.revert()
  context = undefined
})
