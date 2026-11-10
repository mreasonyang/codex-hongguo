type Settings = { hoverDecoyEnabled: boolean }
type Options = { changed: (covered: boolean) => void }

/** Panel-local hover state. Conceal synchronously; only revealing is debounced. */
export function createHoverDecoy({ changed }: Options) {
  const root = document.documentElement
  const content = document.getElementById('playerContent')!
  const layer = document.getElementById('decoy')!
  let enabled = root.dataset.hoverDecoy === 'on', inside = false, covered = enabled, configured = false, unavailable = false
  let timer: ReturnType<typeof setTimeout> | undefined
  const paint = () => {
    root.dataset.hoverDecoy = enabled ? 'on' : 'off'
    root.dataset.decoyCovered = covered ? 'true' : 'false'
    content.inert = covered || !configured || unavailable
    content.setAttribute('aria-hidden', String(content.inert))
    layer.setAttribute('aria-hidden', String(!covered))
  }
  function setCovered(next: boolean) {
    clearTimeout(timer)
    timer = undefined
    if (next === covered) { paint(); return }
    covered = next
    paint()
    changed(covered)
  }
  function conceal() { inside = false; if (enabled) setCovered(true) }
  const outside = (event: MouseEvent) => event.clientX < 0 || event.clientY < 0 ||
    event.clientX >= window.innerWidth || event.clientY >= window.innerHeight
  function enter() {
    if (document.hidden) return
    inside = true
    if (!enabled || !covered || timer !== undefined) return
    timer = setTimeout(() => { if (inside && !document.hidden) setCovered(false) }, 150)
  }
  function move(event: PointerEvent) {
    if (event.pointerType === 'touch') return
    // Native controls can capture the pointer; then pointerleave is delayed until release.
    if (outside(event)) conceal()
    else enter()
  }
  // Removed menu options can emit null-related out events inside the viewport.
  // Only these bubbling element events need the coordinate guard. Root/document
  // leave events mark the panel boundary, even if the host retains the last
  // in-panel coordinates after dismissing Settings.
  const out = (event: MouseEvent) => { if (event.relatedTarget === null && outside(event)) conceal() }
  const visibility = () => { if (document.hidden) conceal() }
  root.addEventListener('pointerenter', enter)
  root.addEventListener('pointerleave', conceal)
  document.addEventListener('pointermove', move, true)
  document.addEventListener('pointerout', out)
  document.addEventListener('mouseout', out)
  document.addEventListener('mouseleave', conceal)
  window.addEventListener('blur', conceal)
  document.addEventListener('visibilitychange', visibility)
  paint()

  return {
    get covered() { return covered },
    get enabled() { return enabled },
    setUnavailable(value: boolean) { unavailable = value; paint() },
    configure(settings: Settings) {
      const nextEnabled = !!settings.hoverDecoyEnabled
      if (nextEnabled !== enabled) {
        enabled = nextEnabled
        setCovered(enabled && (!inside || document.hidden))
      }
      configured = true
      root.dataset.decoyReady = 'true'
      paint()
    },
    conceal,
    dispose() {
      clearTimeout(timer)
      root.removeEventListener('pointerenter', enter)
      root.removeEventListener('pointerleave', conceal)
      document.removeEventListener('pointermove', move, true)
      document.removeEventListener('pointerout', out)
      document.removeEventListener('mouseout', out)
      document.removeEventListener('mouseleave', conceal)
      window.removeEventListener('blur', conceal)
      document.removeEventListener('visibilitychange', visibility)
    },
  }
}
