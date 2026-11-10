const fields = ['autoPlayOnStart', 'defaultMuted', 'hoverDecoyEnabled', 'coverStyle', 'terms', 'excludeNsfwRecommendations'] as const

/** Help stays inside the iframe; it never opens a native popup or changes settings. */
export function createSettingsHelp(doc: Document = document) {
  const items = fields.map(id => ({
    button: doc.getElementById(id + 'Help')!, tip: doc.getElementById(id + 'Tip')!,
  }))
  let active: typeof items[number] | undefined, timer: ReturnType<typeof setTimeout> | undefined
  function close() {
    clearTimeout(timer)
    const wasOpen = !!active
    if (active) active.tip.hidden = true
    active = undefined
    return wasOpen
  }
  function position(item: typeof items[number]) {
    const anchor = item.button.getBoundingClientRect?.(), view = doc.defaultView
    if (!anchor || !view) return
    if (anchor.bottom < 0 || anchor.top > view.innerHeight) { close(); return }
    const margin = 12, gap = 6
    item.tip.style.width = Math.min(300, view.innerWidth - margin * 2) + 'px'
    const bounds = item.tip.getBoundingClientRect()
    const left = Math.max(margin, Math.min(anchor.left, view.innerWidth - bounds.width - margin))
    const above = anchor.top - bounds.height - gap
    const top = above >= margin ? above : anchor.bottom + gap
    item.tip.style.left = left + 'px'
    item.tip.style.top = Math.max(margin, Math.min(top, view.innerHeight - bounds.height - margin)) + 'px'
  }
  function show(item: typeof items[number]) {
    clearTimeout(timer)
    if (active !== item) close()
    active = item
    item.tip.hidden = false
    position(item)
  }
  function leave(item: typeof items[number]) {
    if (doc.activeElement === item.button && item.button.matches?.(':focus-visible')) return
    clearTimeout(timer)
    // Give the pointer time to cross the small gap into the tooltip itself.
    timer = setTimeout(() => { if (active === item) close() }, 120)
  }
  for (const item of items) {
    item.button.onpointerenter = item.button.onfocus = item.button.onclick = () => show(item)
    item.button.onpointerleave = item.tip.onpointerleave = () => leave(item)
    item.tip.onpointerenter = () => clearTimeout(timer)
    item.button.onblur = () => {
      if (active === item && !item.button.matches?.(':hover') && !item.tip.matches?.(':hover')) close()
    }
  }
  doc.addEventListener('pointerdown', event => {
    if (active && !event.composedPath().includes(active.button) && !event.composedPath().includes(active.tip)) close()
  }, true)
  doc.addEventListener('scroll', () => { if (active) position(active) }, true)
  doc.defaultView?.addEventListener('resize', close)
  doc.defaultView?.addEventListener('blur', close)
  return { close, sync() { if (active?.button.closest?.('[hidden]')) close() } }
}
