type Settings = { hoverDecoyEnabled: boolean; decoyUrl: string }
type Options = { changed: (covered: boolean) => void; canEmbed: (url: string) => boolean }

/** Panel-local hover state. Conceal synchronously; only revealing is debounced. */
export function createHoverDecoy({ changed, canEmbed }: Options) {
  const root = document.documentElement
  const content = document.getElementById('playerContent')!
  const layer = document.getElementById('decoy')!
  const frameHost = document.getElementById('decoyWebsite')!
  let enabled = root.dataset.hoverDecoy === 'on', inside = false, covered = enabled, configured = false
  let timer: ReturnType<typeof setTimeout> | undefined, url = '', framedUrl = ''
  const paint = () => {
    root.dataset.hoverDecoy = enabled ? 'on' : 'off'
    root.dataset.decoyCovered = covered ? 'true' : 'false'
    content.inert = covered || !configured
    content.setAttribute('aria-hidden', String(covered))
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
  function enter() {
    if (document.hidden) return
    inside = true
    if (!enabled || !covered || timer !== undefined) return
    timer = setTimeout(() => { if (inside && !document.hidden) setCovered(false) }, 150)
  }
  function move(event: PointerEvent) {
    if (event.pointerType === 'touch') return
    // Native controls can capture the pointer; then pointerleave is delayed until release.
    if (event.clientX < 0 || event.clientY < 0 || event.clientX >= window.innerWidth || event.clientY >= window.innerHeight)
      conceal()
    else enter()
  }
  const out = (event: MouseEvent) => { if (event.relatedTarget === null) conceal() }
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
    get needsReopen() { return !!url && !canEmbed(url) },
    configure(settings: Settings) {
      const nextEnabled = !!settings.hoverDecoyEnabled
      if (nextEnabled !== enabled) {
        enabled = nextEnabled
        setCovered(enabled && (!inside || document.hidden))
      }
      url = settings.decoyUrl || ''
      const nextFrame = enabled && url && canEmbed(url) ? url : ''
      if (nextFrame !== framedUrl) {
        framedUrl = nextFrame
        frameHost.replaceChildren()
        if (nextFrame) {
          const frame = document.createElement('iframe')
          frame.title = root.lang?.startsWith('en') ? 'Cover page' : '替身网页'
          frame.src = nextFrame
          frame.tabIndex = -1
          frame.referrerPolicy = 'no-referrer'
          frame.setAttribute('sandbox', 'allow-scripts allow-same-origin')
          frame.setAttribute('allow', "autoplay 'none'; camera 'none'; microphone 'none'; geolocation 'none'")
          frameHost.append(frame)
        }
      }
      document.getElementById('decoyNotes')!.hidden = !!nextFrame
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
      frameHost.replaceChildren()
    },
  }
}
