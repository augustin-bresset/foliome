import { useLayoutEffect } from 'preact/hooks'

const INTERACTIVE = 'a[href],button,input,select,textarea,summary,label,[role="button"],[contenteditable=""],[contenteditable="true"]'

/**
 * The editable zone under a point, if any.
 *
 * Looks through whatever is stacked above the zone — a WebGL canvas, a grain
 * overlay, a decorative layer — because stylised sites routinely cover their
 * content. Stops at anything clickable that is not itself inside a zone, so
 * menus and buttons floating above the page keep working.
 */
export function zoneAt(x: number, y: number, host: Element): HTMLElement | null {
  for (const el of document.elementsFromPoint(x, y)) {
    if (el === host) return null
    const zone = el.closest<HTMLElement>('[data-foliome]')
    if (zone) return zone
    if (el.closest(INTERACTIVE)) return null
  }
  return null
}

/** Keeps something aligned with an element that the page may move at any time (smooth scroll, pinning, transitions). */
export function useFollow(el: HTMLElement | null, apply: (rect: DOMRect) => void): void {
  useLayoutEffect(() => {
    if (!el) return
    let frame = 0
    const tick = () => {
      if (el.isConnected) apply(el.getBoundingClientRect())
      frame = requestAnimationFrame(tick)
    }
    tick()
    return () => cancelAnimationFrame(frame)
  }, [el])
}
