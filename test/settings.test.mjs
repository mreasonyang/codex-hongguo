import test from 'node:test'
import assert from 'node:assert/strict'
import { createSettings } from '../src/ui/settings.ts'

const settle = async () => { for (let i = 0; i < 80; i++) await Promise.resolve() }
function deferred() { let resolve; return { promise: new Promise(done => { resolve = done }), resolve } }
function fixture() {
  const elements = new Map(), document = { getElementById: id => {
    if (!elements.has(id)) elements.set(id, {
      hidden: true, disabled: false, checked: false, value: '', dataset: {}, attributes: {},
      setAttribute(key, value) { this.attributes[key] = value },
      removeAttribute(key) { delete this.attributes[key] }, focus() {},
    })
    return elements.get(id)
  } }
  let stored = { autoPrompt: true, autoplayNext: true, autoPauseOnFinish: true, autoPlayOnStart: true,
    defaultMuted: true, hoverDecoyEnabled: false, volume: 0.42, searchTerms: ['都市'] }
  let current = structuredClone(stored), beforeSave = async () => {}, covers = 0, applied = 0
  const requests = []
  const settings = createSettings({
    read: () => current,
    save: async patch => {
      requests.push(structuredClone(patch)); await beforeSave(patch)
      stored = { ...stored, ...patch }; return structuredClone(stored)
    },
    applied: value => { current = value; applied++ }, edited() {}, translate: value => value,
    changeCover: () => { covers++ },
  }, document)
  settings.open()
  return { settings, elements, requests,
    get stored() { return stored }, get covers() { return covers }, get applied() { return applied },
    beforeSave: callback => { beforeSave = callback },
    external(patch) { stored = { ...stored, ...patch }; current = structuredClone(stored) },
    toggle(key, checked) { const input = elements.get(key); input.checked = checked; input.onchange() },
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

for (const value of ['', '，, ', 'a,b,c,d,e,f,g', 'x'.repeat(31)]) test(`invalid keywords prevent closing or changing the cover (${JSON.stringify(value)})`, async () => {
  const f = fixture()
  f.terms(value)
  assert.equal(await f.settings.finish(true), false)
  assert.equal(f.covers, 0)
  assert.equal(f.requests.length, 0)
  assert.equal(f.elements.get('settings').hidden, false)
  assert.equal(f.elements.get('terms').attributes['aria-invalid'], 'true')
  f.terms('都市，悬疑')
  assert.equal(await f.settings.finish(true), true)
  assert.equal(f.covers, 1)
  assert.equal(f.elements.get('settings').hidden, true)
})

test('Change page waits for the current write, runs once, then closes Settings', async () => {
  const f = fixture(), gate = deferred()
  f.beforeSave(() => gate.promise)
  f.toggle('hoverDecoyEnabled', true)
  const first = f.settings.finish(true), second = f.settings.finish(true)
  assert.equal(first, second)
  assert.equal(f.covers, 0)
  assert.equal(f.elements.get('settings').hidden, false)
  assert.equal(f.elements.get('settingsClose').disabled, true)
  gate.resolve()
  assert.equal(await first, true)
  assert.equal(f.stored.hoverDecoyEnabled, true)
  assert.equal(f.covers, 1)
  assert.equal(f.elements.get('settings').hidden, true)
})

test('a failed in-flight save blocks changing and closing; retry preserves the desired values', async () => {
  const f = fixture(), gate = deferred()
  f.beforeSave(async () => { await gate.promise; throw Error('synthetic failure') })
  f.toggle('defaultMuted', false)
  const closing = f.settings.finish(true)
  gate.resolve()
  assert.equal(await closing, false)
  assert.equal(f.stored.defaultMuted, true)
  assert.equal(f.elements.get('defaultMuted').checked, false)
  assert.equal(f.elements.get('settings').hidden, false)
  assert.equal(f.covers, 0)
  assert.equal(f.elements.get('settingsClose').disabled, false)
  assert.equal(f.elements.get('settingsStatus').dataset.state, 'error')
  f.beforeSave(async () => {})
  assert.equal(await f.settings.finish(true), true)
  assert.equal(f.stored.defaultMuted, false)
  assert.equal(f.covers, 1)
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
  const closing = f.settings.finish(true)
  f.settings.reset(); f.settings.open()
  gate.resolve()
  assert.equal(await closing, false)
  assert.equal(f.applied, 0)
  assert.equal(f.covers, 0)
  assert.equal(f.elements.get('settings').hidden, false)
})
