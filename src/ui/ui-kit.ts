// Render-only helpers for the panel: sprite icons, cover artwork and slider fills.
const SVG_NS = 'http://www.w3.org/2000/svg'

export type IconName =
  | 'play'
  | 'pause'
  | 'x'
  | 'volume'
  | 'mute'
  | 'expand'
  | 'collapse'
  | 'check'
  | 'alert'
  | 'spin'

/** An inline icon that points at an i-* symbol in the page sprite. */
export function icon(name: IconName): SVGSVGElement {
  const svg = document.createElementNS(SVG_NS, 'svg')
  const use = document.createElementNS(SVG_NS, 'use')
  svg.setAttribute('class', 'i')
  svg.setAttribute('aria-hidden', 'true')
  svg.setAttribute('focusable', 'false')
  use.setAttribute('href', '#i-' + name)
  svg.append(use)
  return svg
}

/** Swaps an icon button's glyph and accessible name; the SVG and other children stay in place. */
export function setIcon(button: HTMLElement, name: IconName, label: string) {
  let svg = button.querySelector<SVGSVGElement>('svg.i')
  if (!svg) {
    svg = icon(name)
    button.prepend(svg)
  }
  svg.querySelector('use')?.setAttribute('href', '#i-' + name)
  button.setAttribute('aria-label', label)
  button.title = label
}

/** Mirrors a range value into --p so the track can paint its filled part. */
export function fill(input: HTMLInputElement) {
  const min = Number(input.min) || 0,
    max = Number(input.max) || 100,
    pct = ((Number(input.value) - min) / (max - min || 1)) * 100
  input.style.setProperty('--p', Math.min(100, Math.max(0, pct)).toFixed(2) + '%')
}

function hue(seed: string) {
  let h = 7
  for (const ch of seed) h = (h * 31 + (ch.codePointAt(0) || 0)) % 360
  return h
}

/** Title artwork: a quiet tinted frame with the title set vertically, shown until a real cover loads. */
export function coverArt(title: string, badge = ''): HTMLSpanElement {
  const art = document.createElement('span'),
    name = document.createElement('span')
  art.className = 'cover'
  art.style.setProperty('--h', String(hue(title)))
  name.className = 'ph'
  name.setAttribute('aria-hidden', 'true')
  name.textContent = title
  art.append(name)
  if (badge) {
    const tag = document.createElement('span')
    tag.className = 'badge'
    tag.textContent = badge
    art.append(tag)
  }
  return art
}

const shown = new WeakMap<HTMLElement, string>()

/**
 * Shows a real cover. Tall art fills the frame; wide art is letterboxed over a
 * blurred copy of itself, so portrait and landscape covers share one grid.
 * If the image fails, the title artwork simply stays.
 */
export function setCover(art: HTMLElement, src: string) {
  if (shown.get(art) === src) return
  shown.set(art, src)
  const img = document.createElement('img')
  img.alt = ''
  img.decoding = 'async'
  img.className = 'fg'
  img.onload = () => {
    if (shown.get(art) !== src) return
    const wide = img.naturalWidth > img.naturalHeight * 0.9
    art.querySelectorAll('img').forEach((old) => old.remove())
    if (wide) {
      const back = document.createElement('img')
      back.alt = ''
      back.className = 'bg'
      back.src = src
      art.prepend(back, img)
    } else art.prepend(img)
    art.dataset.shape = wide ? 'wide' : 'tall'
    art.classList.add('loaded')
  }
  img.src = src
}
