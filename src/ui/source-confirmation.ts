type Options = { translate: (value: string) => string }

/** A source change is committed only after an explicit affirmative action. */
export function createSourceConfirmation({ translate }: Options, doc: Document = document) {
  const element = <T extends HTMLElement = HTMLElement>(id: string) => doc.getElementById(id) as T
  const layer = element('sourceConfirmation'), content = element('playerContent')
  const cancel = element<HTMLButtonElement>('sourceCancel'), confirm = element<HTMLButtonElement>('sourceConfirm')
  let complete: ((accepted: boolean) => void) | undefined
  let previous: HTMLElement | null = null
  function finish(accepted: boolean) {
    if (!complete) return
    const done = complete
    complete = undefined
    layer.hidden = true
    if (!content.inert) previous?.focus()
    previous = null
    done(accepted)
  }
  cancel.onclick = () => finish(false)
  confirm.onclick = () => finish(true)
  layer.onclick = event => { if (event.target === layer) finish(false) }
  doc.addEventListener('click', event => {
    if (!complete || layer.contains(event.target as Node)) return
    event.preventDefault(); event.stopImmediatePropagation()
  }, true)
  doc.addEventListener('focusin', event => {
    if (complete && !content.inert && !layer.contains(event.target as Node)) cancel.focus()
  })
  doc.addEventListener('keydown', event => {
    if (!complete || content.inert) return
    if (event.key === 'Escape') {
      event.preventDefault(); event.stopImmediatePropagation(); finish(false)
    } else if (event.key === 'Tab') {
      event.preventDefault(); event.stopImmediatePropagation()
      // Two explicit actions, with Cancel as the initial/default focus.
      if (doc.activeElement === cancel) confirm.focus()
      else cancel.focus()
    }
  }, true)
  return {
    get pending() { return !!complete },
    cancel: () => finish(false),
    request(name: string) {
      finish(false)
      previous = doc.activeElement as HTMLElement | null
      element('sourceConfirmationName').textContent = name
      element('sourceConfirmationTitle').textContent = translate('切换到 NSFW 片源？')
      element('sourceConfirmationDescription').textContent = translate('该片源可能包含不适合工作场合的内容。确认后才会切换。')
      cancel.textContent = translate('取消')
      confirm.textContent = translate('确认切换')
      layer.hidden = false
      const result = new Promise<boolean>(resolve => { complete = resolve })
      cancel.focus()
      return result
    },
  }
}
