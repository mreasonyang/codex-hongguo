import type { Preferences } from './api'
import { createCoverStylePicker } from './cover-style-picker.ts'

const switches = ['autoPauseOnFinish', 'autoPlayOnStart', 'defaultMuted', 'hoverDecoyEnabled', 'autoPrompt'] as const
type Options = {
  read: () => Preferences
  save: (patch: Partial<Preferences>) => Promise<Preferences>
  applied: (settings: Preferences) => void
  edited: () => void
  translate: (value: string) => string
}

/** Autosave settings; only explicit dismissal closes the sheet after pending saves. */
export function createSettings(options: Options, doc: Document = document) {
  const element = <T extends HTMLElement = HTMLElement>(id: string) => doc.getElementById(id) as T
  const form = element<HTMLFormElement>('settings'), terms = element<HTMLInputElement>('terms')
  const status = element('settingsStatus'), close = element<HTMLButtonElement>('settingsClose')
  const coverSettings = element('coverSettings')
  const trigger = element<HTMLButtonElement>('prefs')
  const content = element('playerContent'), cover = element('decoy')
  let pending: Partial<Preferences> = {}, generation = 0, revision = 0, busy = 0
  let queue = Promise.resolve(), finishing: Promise<boolean> | undefined
  let invalidTerms = false, saved = false, termsBaseline = ''
  let revealClick = false
  const revisions = new Map<keyof Preferences, number>()
  const keys = (patch: Partial<Preferences>) => Object.keys(patch) as (keyof Preferences)[]
  const controls = [...switches.map(id => element<HTMLInputElement>(id)), terms, close]
  const style = createCoverStylePicker({ changed: coverStyle => { void enqueue({ coverStyle }) },
    translate: options.translate }, doc)
  function sync() {
    if (form.hidden) return
    const settings = options.read()
    for (const key of switches) element<HTMLInputElement>(key).checked = pending[key] ?? settings[key]
    coverSettings.hidden = !element<HTMLInputElement>('hoverDecoyEnabled').checked
    style.sync(pending.coverStyle ?? settings.coverStyle, !!finishing || coverSettings.hidden)
  }
  function showStatus() {
    const failed = !busy && keys(pending).length > 0
    status.dataset.state = invalidTerms || failed ? 'error' : 'status'
    status.textContent = options.translate(invalidTerms ? '请输入1～6个关键词，每个不超过30个字符'
      : busy ? '正在保存…' : failed ? '设置未保存，请点击关闭重试'
      : terms.value !== termsBaseline ? '按 Enter 或离开输入框时保存' : saved ? '已自动保存' : '')
    sync()
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
    style.close()
    form.hidden = true
    trigger.setAttribute('aria-expanded', 'false')
    trigger.focus()
  }
  function finish(): Promise<boolean> {
    if (finishing) return finishing
    if (!saveTerms()) { terms.focus(); return Promise.resolve(false) }
    const epoch = generation
    if (!busy && keys(pending).length) void enqueue({ ...pending })
    controls.forEach(control => { control.disabled = true })
    style.sync(pending.coverStyle ?? options.read().coverStyle, true)
    finishing = (async () => {
      await queue
      if (epoch !== generation || keys(pending).length) return false
      hide()
      return true
    })().finally(() => {
      if (epoch === generation) {
        controls.forEach(control => { control.disabled = false })
        finishing = undefined
        sync()
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
  doc.addEventListener('pointerdown', event => {
    // A press can start on the cover and finish after hover has revealed the
    // player. It is a reveal gesture, not an outside click on Settings.
    revealClick = content.inert || event.composedPath().includes(cover)
  }, true)
  doc.addEventListener('click', event => {
    if (revealClick) { revealClick = false; return }
    if (form.hidden || content.inert || event.defaultPrevented) return
    const path = event.composedPath()
    if (path.includes(form) || path.includes(trigger)) return
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
    if (style.expanded) { style.close(); return }
    void finish()
  }, true)
  return {
    get busy() { return busy > 0 },
    sync,
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
      style.close()
      revealClick = false
      pending = {}; revisions.clear(); busy = 0; invalidTerms = saved = false; finishing = undefined
      controls.forEach(control => { control.disabled = false })
      terms.removeAttribute('aria-invalid')
      form.hidden = true
      trigger.setAttribute('aria-expanded', 'false')
      showStatus()
    },
  }
}
