/** Measure the invitation itself, independent of the iframe's previous viewport height. */
export function trackInlineSize(card: HTMLElement, isInline: () => boolean, resize: (height: number) => void) {
  let frame: number | undefined, disposed = false
  const refresh = () => {
    if (disposed || frame !== undefined) return
    frame = requestAnimationFrame(() => {
      frame = undefined
      if (disposed || !isInline()) return
      // Codex accepts positive intrinsic heights; zero leaves the previous frame size in place.
      resize(card.hidden ? 1 : Math.max(1, Math.ceil(card.getBoundingClientRect().height)))
    })
  }
  const observer = new ResizeObserver(refresh)
  observer.observe(card)
  refresh()
  return {
    refresh,
    dispose() {
      disposed = true
      observer.disconnect()
      if (frame !== undefined) cancelAnimationFrame(frame)
    },
  }
}
