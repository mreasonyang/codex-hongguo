import test from 'node:test'
import assert from 'node:assert/strict'
import { createSettings } from '../src/ui/settings.ts'

const settle = async () => { for (let i = 0; i < 80; i++) await Promise.resolve() }
function deferred() { let resolve; return { promise: new Promise(done => { resolve = done }), resolve } }
function fixture({ hoverDecoyEnabled = false } = {}) {
  const elements = new Map(), document = Object.assign(new EventTarget(), { getElementById: id => {
    if (!elements.has(id)) elements.set(id, {
      hidden: true, disabled: false, checked: false, value: '', dataset: {}, attributes: {},
      setAttribute(key, value) { this.attributes[key] = value },
      removeAttribute(key) { delete this.attributes[key] }, focus() {},
    })
    return elements.get(id)
  } })
  document.getElementById('playerContent')
  document.getElementById('decoy')
  let stored = { autoPrompt: true, autoplayNext: true, autoPauseOnFinish: true, autoPlayOnStart: true,
    defaultMuted: true, hoverDecoyEnabled, coverStyle: 'random', volume: 0.42, searchTerms: ['都市'] }
  let current = structuredClone(stored), beforeSave = async () => {}, applied = 0
  const requests = []
  const settings = createSettings({
    read: () => current,
    save: async patch => {
      requests.push(structuredClone(patch)); await beforeSave(patch)
      stored = { ...stored, ...patch }; return structuredClone(stored)
    },
    applied: value => { current = value; applied++ }, edited() {}, translate: value => value,
  }, document)
  settings.open()
  return { settings, elements, requests, document,
    get stored() { return stored }, get applied() { return applied },
    beforeSave: callback => { beforeSave = callback },
    external(patch) { stored = { ...stored, ...patch }; current = structuredClone(stored) },
    dispatch(type, path = [], properties = {}) {
      const event = new Event(type, { cancelable: true })
      Object.assign(event, properties, { composedPath: () => path.map(id => elements.get(id)) })
      document.dispatchEvent(event)
      return event
    },
    toggle(key, checked) { const input = elements.get(key); input.checked = checked; input.onchange() },
    style(value) { const input = elements.get('coverStyle'); if (input.attributes['aria-expanded'] !== 'true') input.onclick(); elements.get('coverStyle-' + value).onclick() },
    terms(value) { const input = elements.get('terms'); input.value = value; input.oninput(); return input },
  }
}

test('switches save small patches automatically, preserve unrelated settings and leave Settings open', async () => {
  const f = fixture()
  f.toggle('defaultMuted', false); await settle()
  assert.deepEqual(f.requests, [{ defaultMuted: false }])
  assert.equal(f.stored.defaultMuted, false)
  assert.equal(f.stored.volume, 0.42)
  assert.equal(f.elements.get('settings').hidden, false)
  assert.equal(f.elements.get('settingsStatus').textContent, '已自动保存')
  assert.equal(await f.settings.finish(), true)
  assert.equal(f.elements.get('settings').hidden, true)
  assert.equal(f.requests.length, 1)
})

test('help reveals on hover or click without changing settings, and Escape dismisses help before Settings', async () => {
  const f = fixture(), help = f.elements.get('hoverDecoyEnabledHelp'), tip = f.elements.get('hoverDecoyEnabledTip')
  help.onpointerenter()
  assert.equal(tip.hidden, false)
  f.settings.sync()
  assert.equal(tip.hidden, false)
  help.onclick()
  assert.equal(f.elements.get('hoverDecoyEnabled').checked, false)
  assert.equal(f.requests.length, 0)
  f.dispatch('keydown', ['hoverDecoyEnabledHelp'], { key: 'Escape' })
  await settle()
  assert.equal(tip.hidden, true)
  assert.equal(f.elements.get('settings').hidden, false)
  f.dispatch('keydown', ['hoverDecoyEnabledHelp'], { key: 'Escape' })
  await settle()
  assert.equal(f.elements.get('settings').hidden, true)
})

test('help remains readable while the pointer crosses into it and closes after leaving', t => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const f = fixture(), help = f.elements.get('defaultMutedHelp'), tip = f.elements.get('defaultMutedTip')
  help.onpointerenter(); help.onpointerleave()
  t.mock.timers.tick(60); tip.onpointerenter(); t.mock.timers.tick(200)
  assert.equal(tip.hidden, false)
  tip.onpointerleave(); t.mock.timers.tick(119)
  assert.equal(tip.hidden, false)
  t.mock.timers.tick(1)
  assert.equal(tip.hidden, true)
  assert.equal(f.elements.get('settings').hidden, false)
  assert.equal(f.requests.length, 0)
})

test('keyboard help opens one explanation at a time and outside dismissal or reset clears it', async () => {
  const f = fixture(), first = f.elements.get('autoPlayOnStartHelp'), second = f.elements.get('termsHelp')
  first.onfocus(); second.onfocus()
  assert.equal(f.elements.get('autoPlayOnStartTip').hidden, true)
  assert.equal(f.elements.get('termsTip').hidden, false)
  f.dispatch('pointerdown', ['settingsClose'])
  assert.equal(f.elements.get('termsTip').hidden, true)
  second.onfocus(); f.settings.reset()
  assert.equal(f.elements.get('termsTip').hidden, true)
  f.settings.open(); first.onfocus()
  await f.settings.finish()
  assert.equal(f.elements.get('autoPlayOnStartTip').hidden, true)
  assert.equal(f.requests.length, 0)
})

test('keywords save on blur or Enter, not each keystroke, with no accidental form close', async () => {
  const f = fixture(), input = f.terms(' 总裁, 都市，重生 ')
  await settle(); assert.equal(f.requests.length, 0)
  input.onblur(); await settle()
  assert.deepEqual(f.stored.searchTerms, ['总裁', '都市', '重生'])
  let prevented = false
  f.terms('悬疑')
  assert.equal(f.elements.get('settingsStatus').textContent, '按 Enter 或离开输入框时保存')
  input.onkeydown({ key: 'Enter', isComposing: false, preventDefault() { prevented = true } })
  await settle()
  assert.equal(prevented, true)
  assert.deepEqual(f.stored.searchTerms, ['悬疑'])
  assert.equal(f.elements.get('settings').hidden, false)
  await f.settings.finish()
  assert.equal(f.requests.length, 2)
})

test('an IME composition Enter does not submit partial keywords', async () => {
  const f = fixture(), input = f.terms('都市')
  input.onkeydown({ key: 'Enter', isComposing: true, preventDefault() { assert.fail('composition should continue') } })
  await settle(); assert.equal(f.requests.length, 0)
})

for (const value of ['', '，, ', 'a,b,c,d,e,f,g', 'x'.repeat(31)]) test(`invalid keywords prevent closing (${JSON.stringify(value)})`, async () => {
  const f = fixture()
  f.terms(value)
  assert.equal(await f.settings.finish(), false)
  assert.equal(f.requests.length, 0)
  assert.equal(f.elements.get('settings').hidden, false)
  assert.equal(f.elements.get('terms').attributes['aria-invalid'], 'true')
  f.terms('都市，悬疑')
  assert.equal(await f.settings.finish(), true)
  assert.equal(f.elements.get('settings').hidden, true)
})

test('cover styles follow the hover switch, save automatically and never dismiss Settings', async () => {
  const f = fixture()
  assert.equal(f.elements.get('coverSettings').hidden, true)
  assert.equal((f.elements.get('coverStyle').attributes['aria-disabled'] === 'true'), true)
  f.style('report'); await settle()
  assert.equal(f.requests.length, 0)
  f.toggle('hoverDecoyEnabled', true)
  assert.equal(f.elements.get('coverSettings').hidden, false)
  f.style('report'); await settle()
  assert.deepEqual(f.requests, [{ hoverDecoyEnabled: true }, { coverStyle: 'report' }])
  assert.equal(f.stored.coverStyle, 'report')
  assert.equal(f.elements.get('settings').hidden, false)
  for (const type of ['pointerleave', 'blur', 'focusout']) f.dispatch(type)
  assert.equal(f.elements.get('settings').hidden, false)
  f.toggle('hoverDecoyEnabled', false); await settle()
  assert.equal(f.elements.get('coverSettings').hidden, true)
  assert.equal((f.elements.get('coverStyle').attributes['aria-disabled'] === 'true'), true)
  assert.equal(f.stored.coverStyle, 'report')
  f.toggle('hoverDecoyEnabled', true); await settle()
  assert.equal(f.elements.get('coverStyle').dataset.value, 'report')
  assert.equal(f.elements.get('settings').hidden, false)
})

test('rapid style choices serialize with enabling hover and preserve the last choice', async () => {
  const f = fixture(), gate = deferred()
  f.beforeSave(() => gate.promise)
  f.toggle('hoverDecoyEnabled', true); await settle()
  f.style('tasks'); f.style('minutes')
  assert.equal(f.elements.get('coverStyle').dataset.value, 'minutes')
  assert.equal(f.elements.get('settings').hidden, false)
  gate.resolve(); await settle()
  assert.equal(f.stored.hoverDecoyEnabled, true)
  assert.equal(f.stored.coverStyle, 'minutes')
  assert.deepEqual(f.requests, [{ hoverDecoyEnabled: true }, { coverStyle: 'minutes' }])
  assert.equal(f.elements.get('settings').hidden, false)
})

test('a failed style save retains its choice, reports failure and retries on Close', async () => {
  const f = fixture({ hoverDecoyEnabled: true })
  f.beforeSave(async () => { throw Error('synthetic failure') })
  f.style('document'); await settle()
  assert.equal(f.stored.coverStyle, 'random')
  assert.equal(f.elements.get('coverStyle').dataset.value, 'document')
  assert.equal(f.elements.get('settingsStatus').dataset.state, 'error')
  assert.equal(f.elements.get('settings').hidden, false)
  f.beforeSave(async () => {})
  assert.equal(await f.settings.finish(), true)
  assert.equal(f.stored.coverStyle, 'document')
})

test('an open sheet follows saved hover/style changes from another chat without discarding a keyword draft', () => {
  const f = fixture({ hoverDecoyEnabled: true })
  f.terms('未完成的输入')
  f.external({ hoverDecoyEnabled: false, coverStyle: 'minutes' }); f.settings.sync()
  assert.equal(f.elements.get('hoverDecoyEnabled').checked, false)
  assert.equal(f.elements.get('coverSettings').hidden, true)
  assert.equal(f.elements.get('coverStyle').dataset.value, 'minutes')
  assert.equal(f.elements.get('terms').value, '未完成的输入')
  assert.equal(f.elements.get('settings').hidden, false)
})

test('moving through every open dropdown option and polling cannot save, close or reset the menu', () => {
  const f = fixture({ hoverDecoyEnabled: true }), combo = f.elements.get('coverStyle')
  combo.onclick()
  for (const key of ['random', 'tasks', 'document', 'report', 'minutes']) {
    f.elements.get('coverStyle-' + key).onpointermove()
    for (let poll = 0; poll < 5; poll++) f.settings.sync()
    assert.equal(combo.attributes['aria-expanded'], 'true')
    assert.equal(combo.attributes['aria-activedescendant'], 'coverStyle-' + key)
    assert.equal(f.elements.get('settings').hidden, false)
    assert.equal(f.elements.get('coverStyleOptions').hidden, false)
  }
  assert.equal(f.requests.length, 0)
  assert.equal(f.stored.coverStyle, 'random')
  f.dispatch('keydown', ['coverStyle'], { key: 'Escape' })
  assert.equal(f.elements.get('coverStyleOptions').hidden, true)
  assert.equal(f.elements.get('settings').hidden, false)
  f.dispatch('keydown', [], { key: 'Escape' })
})

test('keyboard navigation commits only with Enter or Tab and keeps Settings open', async () => {
  const f = fixture({ hoverDecoyEnabled: true }), combo = f.elements.get('coverStyle')
  const key = key => combo.onkeydown({ key, preventDefault() {}, isComposing: false })
  key('ArrowDown'); key('End')
  assert.equal(f.requests.length, 0)
  f.settings.sync()
  assert.equal(combo.attributes['aria-activedescendant'], 'coverStyle-minutes')
  key('Enter'); await settle()
  assert.equal(f.stored.coverStyle, 'minutes')
  assert.equal(f.elements.get('settings').hidden, false)
  key('Home'); key('ArrowDown'); key('Tab'); await settle()
  assert.equal(f.stored.coverStyle, 'tasks')
  assert.equal(f.elements.get('coverStyleOptions').hidden, true)
  assert.equal(f.elements.get('settings').hidden, false)
})

test('closing while saving dismisses and disables the style popup until the save finishes', async () => {
  const f = fixture({ hoverDecoyEnabled: true }), gate = deferred()
  f.beforeSave(() => gate.promise)
  f.toggle('defaultMuted', false)
  f.elements.get('coverStyle').onclick()
  const closing = f.settings.finish()
  assert.equal(f.elements.get('coverStyleOptions').hidden, true)
  assert.equal(f.elements.get('coverStyle').attributes['aria-disabled'], 'true')
  f.style('minutes')
  gate.resolve(); await closing
  assert.equal(f.stored.coverStyle, 'random')
  assert.equal(f.elements.get('settings').hidden, true)
})

test('one outside click closes both the style popup and Settings', async () => {
  const f = fixture({ hoverDecoyEnabled: true })
  f.elements.get('coverStyle').onclick()
  f.dispatch('pointerdown', ['playerContent'])
  f.dispatch('click', ['playerContent']); await settle()
  assert.equal(f.elements.get('coverStyleOptions').hidden, true)
  assert.equal(f.elements.get('settings').hidden, true)
})

test('a press on the cover cannot dismiss Settings even if reveal completes before click', async () => {
  const f = fixture({ hoverDecoyEnabled: true })
  f.elements.get('playerContent').inert = true
  f.dispatch('pointerdown', ['decoy'])
  assert.equal(f.dispatch('keydown', [], { key: 'Escape' }).defaultPrevented, false)
  f.elements.get('playerContent').inert = false
  f.dispatch('click', ['playerContent']); await settle()
  assert.equal(f.elements.get('settings').hidden, false)
  f.dispatch('pointerdown', ['playerContent'])
  f.dispatch('click', ['playerContent']); await settle()
  assert.equal(f.elements.get('settings').hidden, true)
})

test('a failed in-flight save blocks closing; retry preserves the desired values', async () => {
  const f = fixture(), gate = deferred()
  f.beforeSave(async () => { await gate.promise; throw Error('synthetic failure') })
  f.toggle('defaultMuted', false)
  const closing = f.settings.finish()
  gate.resolve()
  assert.equal(await closing, false)
  assert.equal(f.stored.defaultMuted, true)
  assert.equal(f.elements.get('defaultMuted').checked, false)
  assert.equal(f.elements.get('settings').hidden, false)
  assert.equal(f.elements.get('settingsClose').disabled, false)
  assert.equal(f.elements.get('settingsStatus').dataset.state, 'error')
  f.beforeSave(async () => {})
  assert.equal(await f.settings.finish(), true)
  assert.equal(f.stored.defaultMuted, false)
})

test('rapid edits serialize writes and coalesce obsolete queued values', async () => {
  const f = fixture(), gate = deferred()
  f.beforeSave(() => gate.promise)
  f.toggle('defaultMuted', false); await settle()
  f.toggle('defaultMuted', true)
  f.toggle('defaultMuted', false)
  f.toggle('autoPrompt', false)
  assert.equal(f.requests.length, 1)
  const closing = f.settings.finish()
  gate.resolve(); await closing
  assert.equal(f.stored.defaultMuted, false)
  assert.equal(f.stored.autoPrompt, false)
  assert.equal(f.stored.volume, 0.42)
  assert.equal(f.requests.length, 3)
})

test('closing an untouched keyword field preserves changes synchronized from another chat', async () => {
  const f = fixture()
  f.external({ searchTerms: ['悬疑'] })
  assert.equal(await f.settings.finish(), true)
  assert.equal(f.requests.length, 0)
  assert.deepEqual(f.stored.searchTerms, ['悬疑'])
})

test('a closed player ignores late UI responses and cannot close a newly opened form', async () => {
  const f = fixture(), gate = deferred()
  f.beforeSave(() => gate.promise)
  f.toggle('autoPrompt', false); await settle()
  const closing = f.settings.finish()
  f.settings.reset(); f.settings.open()
  gate.resolve()
  assert.equal(await closing, false)
  assert.equal(f.applied, 0)
  assert.equal(f.elements.get('settings').hidden, false)
})

for (const hoverDecoyEnabled of [false, true]) {
  test(`outside clicks wait for saves and close Settings with hover=${hoverDecoyEnabled}`, async () => {
    const f = fixture({ hoverDecoyEnabled }), gate = deferred()
    f.beforeSave(() => gate.promise)
    f.terms('都市，悬疑')
    const event = f.dispatch('click', ['playerContent'])
    await settle()
    assert.equal(event.defaultPrevented, true)
    assert.equal(f.elements.get('settings').hidden, false)
    assert.equal(f.elements.get('settingsClose').disabled, true)
    gate.resolve(); await settle()
    assert.deepEqual(f.stored.searchTerms, ['都市', '悬疑'])
    assert.equal(f.elements.get('settings').hidden, true)
    })

  test(`Escape closes Settings with hover=${hoverDecoyEnabled}`, async () => {
    const f = fixture({ hoverDecoyEnabled })
    const event = f.dispatch('keydown', [], { key: 'Escape', isComposing: false })
    await settle()
    assert.equal(event.defaultPrevented, true)
    assert.equal(f.elements.get('settings').hidden, true)
    assert.equal(f.requests.length, 0)
  })
}

test('clicks inside Settings and on its toggle do not dismiss it', async () => {
  const f = fixture()
  for (const path of [['terms', 'settings', 'playerContent'], ['prefs', 'playerContent']]) {
    assert.equal(f.dispatch('click', path).defaultPrevented, false)
    await settle()
    assert.equal(f.elements.get('settings').hidden, false)
  }
  assert.equal(f.requests.length, 0)
})

test('pointer movement, focus changes, IME Escape, and a canceled Escape leave Settings open', async () => {
  const f = fixture()
  for (const type of ['pointerleave', 'mouseleave', 'blur', 'focusout']) f.dispatch(type)
  for (const properties of [{ key: 'Escape', isComposing: true }, { key: 'Escape', keyCode: 229 }, { key: 'Enter' }])
    assert.equal(f.dispatch('keydown', [], properties).defaultPrevented, false)
  const canceled = new Event('keydown', { cancelable: true })
  Object.assign(canceled, { key: 'Escape' }); canceled.preventDefault()
  // A previously handled Escape must not start a close or save operation.
  f.terms('悬疑')
  f.document.dispatchEvent(canceled)
  await settle()
  assert.equal(f.elements.get('settings').hidden, false)
  assert.equal(f.requests.length, 0)
})

for (const dismissal of ['blank area', 'Escape']) test(`${dismissal} dismisses visible Settings without requiring a click inside player content`, async () => {
  const f = fixture({ hoverDecoyEnabled: true })
  const event = dismissal === 'Escape' ? f.dispatch('keydown', [], { key: 'Escape' })
    : f.dispatch('click', dismissal === 'cover' ? ['decoy'] : [])
  await settle()
  assert.equal(event.defaultPrevented, true)
  assert.equal(f.elements.get('settings').hidden, true)
})

for (const dismissal of ['outside', 'Escape']) test(`${dismissal} retains invalid or unsaved Settings and allows a later retry`, async () => {
  const f = fixture()
  const dismiss = () => dismissal === 'outside'
    ? f.dispatch('click', ['playerContent']) : f.dispatch('keydown', [], { key: 'Escape' })
  f.terms('')
  dismiss(); await settle()
  assert.equal(f.elements.get('settings').hidden, false)
  assert.equal(f.elements.get('terms').attributes['aria-invalid'], 'true')
  assert.equal(f.requests.length, 0)
  f.terms('悬疑')
  f.beforeSave(async () => { throw Error('synthetic failure') })
  dismiss(); await settle()
  assert.equal(f.elements.get('settings').hidden, false)
  assert.equal(f.elements.get('settingsStatus').dataset.state, 'error')
  assert.deepEqual(f.stored.searchTerms, ['都市'])
  f.beforeSave(async () => {})
  dismiss(); await settle()
  assert.equal(f.elements.get('settings').hidden, true)
  assert.deepEqual(f.stored.searchTerms, ['悬疑'])
})
