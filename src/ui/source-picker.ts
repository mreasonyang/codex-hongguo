type Choice = { id: string; label: string }
type Options = { changed: (id: string) => void | Promise<void> }

// Like the cover-style picker, keep focus and the popup inside the iframe.
// The selected source is controlled by the service, including NSFW confirmation.
export function createSourcePicker(options: Options, doc: Document = document) {
  const get = (id: string) => doc.getElementById(id)!
  const root = get('settingsSourcePicker'), combo = get('settingsSource')
  const label = get('settingsSourceValue'), list = get('settingsSourceOptions')
  let choices: readonly Choice[] = [], items: HTMLElement[] = [], signature = ''
  let value = '', active = 0, expanded = false, disabled = true, query = '', typedAt = 0
  function attribute(element: HTMLElement, name: string, text: string) {
    if (element.getAttribute(name) !== text) element.setAttribute(name, text)
  }
  function paint() {
    const text = choices.find(choice => choice.id === value)?.label ?? ''
    if (label.textContent !== text) label.textContent = text
    if (combo.dataset.value !== value) combo.dataset.value = value
    attribute(combo, 'aria-expanded', String(expanded))
    attribute(combo, 'aria-disabled', String(disabled))
    combo.tabIndex = disabled ? -1 : 0
    list.hidden = !expanded
    if (expanded && items[active]) attribute(combo, 'aria-activedescendant', items[active].id)
    else combo.removeAttribute('aria-activedescendant')
    items.forEach((item, index) => {
      attribute(item, 'aria-selected', String(expanded ? index === active : choices[index].id === value))
      item.dataset.active = String(expanded && index === active)
    })
  }
  function close() {
    const wasOpen = expanded
    if (expanded) { expanded = false; query = ''; paint() }
    return wasOpen
  }
  function open(index = choices.findIndex(choice => choice.id === value)) {
    if (disabled || !choices.length) return
    active = Math.max(0, index); expanded = true; paint()
    const rect = combo.getBoundingClientRect?.(), height = doc.defaultView?.innerHeight
    if (rect && height) {
      const below = height - rect.bottom - 8, above = rect.top - 8
      const up = below < Math.min(200, choices.length * 36 + 8) && above > below
      list.dataset.side = up ? 'above' : 'below'
      list.style.maxHeight = Math.min(200, Math.max(32, up ? above : below)) + 'px'
    }
    combo.focus()
    items[active].scrollIntoView?.({ block: 'nearest' })
  }
  function choose(index = active) {
    if (disabled || !expanded || !choices[index]) return
    const next = choices[index].id
    close()
    combo.focus()
    if (next !== value) return options.changed(next)
  }
  combo.onclick = () => { if (expanded) close(); else open() }
  combo.onblur = close
  combo.onkeydown = event => {
    if (disabled || event.isComposing || event.keyCode === 229 || event.key === 'Escape') return
    const key = event.key
    if (event.altKey && key === 'ArrowUp' && expanded) { event.preventDefault(); return choose() }
    if (key === 'Tab') { if (expanded) return choose(); return }
    if (['Enter', ' ', 'ArrowDown', 'ArrowUp', 'Home', 'End', 'PageUp', 'PageDown'].includes(key)) {
      event.preventDefault()
      if (key === 'Enter' || key === ' ') { if (expanded) return choose(); open(); return }
      if (!expanded) open(key === 'Home' || key === 'PageUp' || key === 'ArrowUp' ? 0
        : key === 'End' || key === 'PageDown' ? choices.length - 1 : undefined)
      else {
        active = key === 'Home' || key === 'PageUp' ? 0
          : key === 'End' || key === 'PageDown' ? choices.length - 1
          : Math.max(0, Math.min(choices.length - 1, active + (key === 'ArrowDown' ? 1 : -1)))
        paint(); items[active].scrollIntoView?.({ block: 'nearest' })
      }
    } else if (key.length === 1 && !event.ctrlKey && !event.metaKey && !event.altKey) {
      event.preventDefault()
      const now = Date.now(), repeated = query === key.toLocaleLowerCase()
      query = now - typedAt < 750 && !repeated ? query + key.toLocaleLowerCase() : key.toLocaleLowerCase()
      typedAt = now
      const start = repeated ? active + 1 : 0
      for (let offset = 0; offset < choices.length; offset++) {
        const index = (start + offset) % choices.length
        if (choices[index].label.toLocaleLowerCase().startsWith(query)) { open(index); break }
      }
    }
  }
  doc.addEventListener('pointerdown', event => {
    if (expanded && !event.composedPath().includes(root)) close()
  }, true)
  return {
    get expanded() { return expanded }, close,
    sync(next: readonly Choice[], selected: string, unavailable: boolean) {
      const nextSignature = JSON.stringify(next)
      if (signature !== nextSignature) {
        const highlighted = choices[active]?.id
        choices = next; signature = nextSignature
        items = choices.map((choice, index) => {
          const item = doc.createElement('div')
          item.id = 'settingsSource-' + choice.id
          item.textContent = choice.label
          item.setAttribute('role', 'option')
          item.onmousedown = event => event.preventDefault()
          item.onpointermove = () => { if (expanded && active !== index) { active = index; paint() } }
          item.onclick = () => choose(index)
          return item
        })
        list.replaceChildren(...items)
        active = Math.max(0, choices.findIndex(choice => choice.id === highlighted))
      }
      value = selected; disabled = unavailable || !choices.length
      if (disabled) close()
      if (!expanded) active = Math.max(0, choices.findIndex(choice => choice.id === value))
      paint()
    },
  }
}
