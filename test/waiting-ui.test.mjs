import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import vm from 'node:vm'
import { transformSync } from 'esbuild'
import { Store } from '../src/server/store.mjs'
import { Service } from '../src/server/service.mjs'

class Element {
  hidden = true; children = []; textContent = ''
  replaceChildren(...children) { this.children = children }
}
class Document extends EventTarget {
  hidden = false; documentElement = { dataset: { surface: 'waiting' } }; elements = new Map()
  getElementById(id) {
    if (!this.elements.has(id)) this.elements.set(id, new Element())
    return this.elements.get(id)
  }
  createElement() { return new Element() }
}
class Observer {
  constructor(callback) { this.callback = callback }
  observe() { queueMicrotask(() => this.callback([{ isIntersecting: true, intersectionRect: { width: 100, height: 30 } }])) }
  unobserve() {}
  disconnect() {}
}
const flush = async () => { for (let i = 0; i < 40; i++) await Promise.resolve() }
const code = transformSync(readFileSync(new URL('../src/ui/waiting.ts', import.meta.url), 'utf8'), { loader: 'ts', format: 'cjs' }).code

test('resume autoplay survives overlapping mode notifications and an iframe replacement until actual playback', async t => {
  const root = mkdtempSync(join(tmpdir(), 'hongguo-card-ui-')), store = new Store(root)
  t.after(() => { store.close(); rmSync(root, { recursive: true, force: true }) })
  store.save({ seriesId: 'hg-1', episodeId: 'hg-11', title: '合成剧', label: '第一集', positionMs: 6000, durationMs: 60000 })
  store.event({ session_id: 'synthetic', turn_id: 'one', hook_event_name: 'UserPromptSubmit' })
  const service = new Service(store, { waitingRecommendations: async () => [] })
  const scope = service.panel(service.openWaiting({ threadId: 'synthetic' }, 'one').panel)
  const call = (name, args = {}) => service.call(scope, name, args)
  function mount(initialMode) {
    const document = new Document(), exports = {}, replies = []
    let mode = initialMode, card, opened, activations = 0
    const api = {
      displayMode: () => mode,
      call: async (name, args) => {
        const result = await call(name, args)
        if (name === 'activate_waiting_player') {
          activations++
          await new Promise(resolve => replies.push(resolve))
        }
        return result
      },
      requestPlayerTab: async () => {
        mode = 'fullscreen'
        card.modeChanged()
        document.dispatchEvent(new Event('visibilitychange'))
      },
    }
    const context = vm.createContext({
      require: name => name === './api' ? api : { tr: value => value }, module: { exports }, exports,
      document, AbortController, IntersectionObserver: Observer, setInterval: () => 1, clearInterval() {},
    })
    vm.runInContext(code, context)
    card = context.module.exports.waitingCard(selection => { opened = selection }, () => {})
    t.after(() => card.dispose())
    card.connected()
    return { document, card, replies, opened: () => opened, activations: () => activations }
  }
  const first = mount('inline')
  await flush()
  first.document.getElementById('waitingTitles').children[0].onclick()
  await flush()
  assert.equal(first.activations(), 1)
  first.replies.forEach(resolve => resolve()); await flush()
  assert.equal(first.opened().play, true)
  await call('set_player_visible', { instance: 'first-iframe', visible: true })
  first.card.dispose()
  const replacement = mount('fullscreen')
  await flush(); replacement.replies.forEach(resolve => resolve()); await flush()
  assert.equal(replacement.opened().play, true)
  assert.equal(replacement.opened().playbackId, first.opened().playbackId)
  await call('confirm_waiting_playback', { playbackId: replacement.opened().playbackId })
  replacement.card.dispose()
  const reopened = mount('fullscreen')
  await flush(); reopened.replies.forEach(resolve => resolve()); await flush()
  assert.equal(reopened.opened().play, false)
})
