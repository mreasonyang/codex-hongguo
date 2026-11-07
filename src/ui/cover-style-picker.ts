import type { CoverStyle } from './cover-page'

const choices: readonly [CoverStyle, string][] = [
  ['random', '随机'], ['tasks', '项目待办'], ['document', '技术文档'],
  ['report', '测试报告'], ['minutes', '会议纪要'],
]
type Options = { changed: (style: CoverStyle) => void; translate: (text: string) => string }

// Keep the popup in the panel DOM: a system picker can leave the iframe and
// trigger hover concealment. Keyboard focus stays on the select-only combobox.
export function createCoverStylePicker(options: Options, doc: Document = document) {
  const get = (id: string) => doc.getElementById(id)!
  const root = get('coverStylePicker'), combo = get('coverStyle')
  const label = get('coverStyleValue'), list = get('coverStyleOptions')
  const items = choices.map(([value]) => get('coverStyle-' + value))
  let value: CoverStyle = 'random', active = 0, expanded = false, disabled = true
  let query = '', typedAt = 0
  function attribute(element: HTMLElement, name: string, text: string) {
    if (element.getAttribute?.(name) !== text) element.setAttribute(name, text)
  }
  function paint() {
    const text = options.translate(choices.find(([key]) => key === value)![1])
    if (label.textContent !== text) label.textContent = text
    if (combo.dataset.value !== value) combo.dataset.value = value
    attribute(combo, 'aria-expanded', String(expanded))
    attribute(combo, 'aria-disabled', String(disabled))
    if (combo.tabIndex !== (disabled ? -1 : 0)) combo.tabIndex = disabled ? -1 : 0
    if (list.hidden === expanded) list.hidden = !expanded
    if (expanded) attribute(combo, 'aria-activedescendant', 'coverStyle-' + choices[active][0])
    else combo.removeAttribute('aria-activedescendant')
    items.forEach((item, index) => {
      const selected = expanded ? index === active : choices[index][0] === value
      attribute(item, 'aria-selected', String(selected))
      item.dataset.active = String(expanded && index === active)
    })
  }
  function close() { if (expanded) { expanded = false; query = ''; paint() } }
  function open(index = choices.findIndex(([key]) => key === value)) {
    if (disabled) return
    active = index; expanded = true; paint()
    const rect = combo.getBoundingClientRect?.(), height = doc.defaultView?.innerHeight
    if (rect && height) {
      const below = height - rect.bottom - 8, above = rect.top - 8
      const up = below < 180 && above > below
      list.dataset.side = up ? 'above' : 'below'
      list.style.maxHeight = Math.min(200, Math.max(32, up ? above : below)) + 'px'
    }
    combo.focus()
    items[active].scrollIntoView?.({ block: 'nearest' })
  }
  function choose(index = active) {
    if (disabled || !expanded) return
    const next = choices[index][0], changed = next !== value
    value = next; close(); paint()
    if (changed) options.changed(next)
  }
  combo.onclick = () => { if (expanded) close(); else open() }
  combo.onblur = close
  combo.onkeydown = event => {
    if (disabled || event.isComposing || event.keyCode === 229 || event.key === 'Escape') return
    const key = event.key
    if (event.altKey && key === 'ArrowUp' && expanded) { event.preventDefault(); choose(); return }
    if (key === 'Tab') { if (expanded) choose(); return }
    if (['Enter', ' ', 'ArrowDown', 'ArrowUp', 'Home', 'End', 'PageUp', 'PageDown'].includes(key)) {
      event.preventDefault()
      if (key === 'Enter' || key === ' ') { if (expanded) choose(); else open(); return }
      if (!expanded) {
        open(key === 'Home' || key === 'PageUp' || key === 'ArrowUp' ? 0
          : key === 'End' || key === 'PageDown' ? choices.length - 1 : undefined)
      } else {
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
        if (options.translate(choices[index][1]).toLocaleLowerCase().startsWith(query)) { open(index); break }
      }
    }
  }
  items.forEach((item, index) => {
    item.onmousedown = event => event.preventDefault()
    item.onpointermove = () => { if (expanded && active !== index) { active = index; paint() } }
    item.onclick = () => { choose(index); if (!disabled) combo.focus() }
  })
  doc.addEventListener('pointerdown', event => {
    if (expanded && !event.composedPath().includes(root)) close()
  }, true)
  return {
    get expanded() { return expanded }, close,
    sync(next: CoverStyle, unavailable: boolean) {
      value = next; disabled = unavailable
      if (disabled) close()
      if (!expanded) active = choices.findIndex(([key]) => key === value)
      paint()
    },
  }
}
