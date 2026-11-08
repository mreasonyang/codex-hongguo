import type { Preferences } from './api'

const switches = ['autoPauseOnFinish', 'autoPlayOnStart', 'defaultMuted', 'hoverDecoyEnabled', 'autoPrompt'] as const
type Options = {
  read: () => Preferences
  save: (patch: Partial<Preferences>) => Promise<Preferences>
  applied: (settings: Preferences) => void
  edited: () => void
  changeCover: () => void
  translate: (value: string) => string
}

/** Serialize small setting patches; only successful saves allow Close or Change page. */
export function createSettings(options: Options, doc: Document = document) {
  const element = <T extends HTMLElement = HTMLElement>(id: string) => doc.getElementById(id) as T
  const form = element<HTMLFormElement>('settings'), terms = element<HTMLInputElement>('terms')
  const status = element('settingsStatus'), close = element<HTMLButtonElement>('settingsClose')
  const change = element<HTMLButtonElement>('changeCover'), trigger = element<HTMLButtonElement>('prefs')
  const content = element('playerContent')
  let pending: Partial<Preferences> = {}, generation = 0, revision = 0, busy = 0
  let queue = Promise.resolve(), finishing: Promise<boolean> | undefined
  let invalidTerms = false, saved = false, termsBaseline = ''
  const revisions = new Map<keyof Preferences, number>()
  const keys = (patch: Partial<Preferences>) => Object.keys(patch) as (keyof Preferences)[]
  const controls = [...switches.map(id => element<HTMLInputElement>(id)), terms, close, change]
  function showStatus() {
    const failed = !busy && keys(pending).length > 0
    status.dataset.state = invalidTerms || failed ? 'error' : 'status'
    status.textContent = options.translate(invalidTerms ? '请输入1～6个关键词，每个不超过30个字符'
      : busy ? '正在保存…' : failed ? '设置未保存，请点击关闭或换一页重试'
      : terms.value !== termsBaseline ? '按 Enter 或离开输入框时保存' : saved ? '已自动保存' : '')
  }
  function enqueue(patch: Partial<Preferences>) {
    const epoch = generation, ticket = ++revision, fields = keys(patch)
    pending = { ...pending, ...patch }
    fields.forEach(key => revisions.set(key, ticket))
    options.edited()
    ++busy; showStatus()
    queue = queue.then(async () => {
      if (epoch !== generation) return
      // A newer queued value supersedes a value that has not been sent yet.
      const current = fields.filter(key => revisions.get(key) === ticket)
      if (!current.length) return
      const update = Object.fromEntries(current.map(key => [key, patch[key]])) as Partial<Preferences>
      try {
        const result = await options.save(update)
        if (epoch !== generation) return
        for (const key of current) if (revisions.get(key) === ticket) {
          delete pending[key]; revisions.delete(key)
        }
        saved = true
        options.applied(result)
      } catch {
        // Keep the latest desired values so a later edit or explicit Close can retry.
      }
    }).finally(() => {
      if (epoch === generation) { --busy; showStatus() }
    })
    return queue
  }
  function saveTerms() {
    if (terms.value === termsBaseline && !invalidTerms) return true
    const values = terms.value.split(/[,，]/).map(value => value.trim()).filter(Boolean)
    invalidTerms = values.length < 1 || values.length > 6 || values.some(value => value.length > 30)
    terms.setAttribute('aria-invalid', String(invalidTerms))
    if (invalidTerms) { showStatus(); return false }
    termsBaseline = terms.value
    if (JSON.stringify(values) !== JSON.stringify(pending.searchTerms ?? options.read().searchTerms))
      void enqueue({ searchTerms: values })
    else showStatus()
    return true
  }
  function hide() {
    form.hidden = true
    trigger.setAttribute('aria-expanded', 'false')
    trigger.focus()
  }
  function finish(changeCover = false): Promise<boolean> {
    if (finishing) return finishing
    if (!saveTerms()) { terms.focus(); return Promise.resolve(false) }
    const epoch = generation
    if (!busy && keys(pending).length) void enqueue({ ...pending })
    controls.forEach(control => { control.disabled = true })
    finishing = (async () => {
      await queue
      if (epoch !== generation || keys(pending).length) return false
      if (changeCover) options.changeCover()
      hide()
      return true
    })().finally(() => {
      if (epoch === generation) {
        controls.forEach(control => { control.disabled = false })
        finishing = undefined
      }
    })
    return finishing
  }
  for (const key of switches) element<HTMLInputElement>(key).onchange = () => {
    void enqueue({ [key]: element<HTMLInputElement>(key).checked })
  }
  terms.onblur = () => { if (!form.hidden) saveTerms() }
  terms.onkeydown = event => {
    if (event.key === 'Enter' && !event.isComposing) { event.preventDefault(); saveTerms() }
  }
  terms.oninput = () => { invalidTerms = false; terms.removeAttribute('aria-invalid'); showStatus() }
  form.onsubmit = event => { event.preventDefault(); saveTerms() }
  close.onclick = () => { void finish() }
  change.onclick = () => { void finish(true) }
  doc.addEventListener('click', event => {
    if (form.hidden || content.inert || event.defaultPrevented) return
    const path = event.composedPath()
    if (!path.includes(content) || path.includes(form) || path.includes(trigger)) return
    // Dismiss first, without also activating a player control beneath the click.
    event.preventDefault()
    event.stopPropagation()
    void finish()
  }, true)
  doc.addEventListener('keydown', event => {
    if (form.hidden || content.inert || event.defaultPrevented || event.key !== 'Escape' ||
      event.isComposing || event.keyCode === 229) return
    event.preventDefault()
    event.stopPropagation()
    void finish()
  }, true)
  return {
    get busy() { return busy > 0 },
    open() {
      const settings = options.read()
      for (const key of switches) element<HTMLInputElement>(key).checked = pending[key] ?? settings[key]
      terms.value = (pending.searchTerms ?? settings.searchTerms).join('，')
      termsBaseline = terms.value
      form.hidden = false
      trigger.setAttribute('aria-expanded', 'true')
      showStatus()
    },
    finish,
    reset() {
      ++generation
      pending = {}; revisions.clear(); busy = 0; invalidTerms = saved = false; finishing = undefined
      controls.forEach(control => { control.disabled = false })
      terms.removeAttribute('aria-invalid')
      form.hidden = true
      trigger.setAttribute('aria-expanded', 'false')
      showStatus()
    },
  }
}
