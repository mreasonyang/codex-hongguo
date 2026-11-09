import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import vm from 'node:vm'
import { webcrypto } from 'node:crypto'
import { transformSync } from 'esbuild'
import { Store } from '../src/server/store.mjs'
import { Service } from '../src/server/service.mjs'
import { Catalog } from '../src/server/catalog.mjs'
import { ProviderRegistry } from '../src/server/providers/registry.mjs'
import { createCoverPage } from '../src/ui/cover-page.ts'
import { createSettings } from '../src/ui/settings.ts'
import { createSourceConfirmation } from '../src/ui/source-confirmation.ts'

class Element extends EventTarget {
  hidden = true; checked = false; value = '1'; dataset = {}; children = []; textContent = ''
  classList = { toggle() {}, add() {}, remove() {}, contains() { return false } }
  style = { setProperty() {} }
  attributes = new Map()
  setAttribute(name, value) { this.attributes.set(name, value) }
  getAttribute(name) { return this.attributes.get(name) ?? null }
  replaceChildren(...children) { this.children = children }
  append(...children) { this.children.push(...children) }
  querySelectorAll() { return [] }
  querySelector(selector) { return selector === 'button[aria-checked="true"]' ? this.children.find(child => child.getAttribute('aria-checked') === 'true') : null }
  contains(target) { return target === this || this.children.some(child => child.contains?.(target)) }
  focus() {}
  removeAttribute(name) { this.attributes.delete(name) }
}
class Video extends Element {
  paused = true; ended = false; duration = 60; currentTime = 12; plays = 0
  muted = false; requireMuted = false
  pause() { this.paused = true; this.onpause?.() }
  load() { this.paused = true }
  async play() {
    if (this.requireMuted && !this.muted) throw new DOMException('A reused page cannot autoplay with sound','NotAllowedError')
    this.plays++; this.paused = false; this.onplay?.(); this.onplaying?.()
  }
}
// Export controls only in the test copy. The production poll, settings handlers,
// start and pause paths run unchanged against a real Service and SQLite store.
const source = readFileSync(new URL('../src/ui/player.ts', import.meta.url), 'utf8') + `
export const fixture = {
  poll, pause, suspend, start, select, nextEpisode, home, openingPreferences, closePlayer, changeSource, changeContent, contentChoice, list, history, refreshProviders,
  sourceState() { return { source: activeSource, cards: cards.map(row => row.id), watched: watched.map(row => row.seriesId) } },
  setProviders(items) { providers = items.filter(item => item.available); syncSourceButton() },
  decoy, coverPage, settings, sourceConfirmation,
  unload() { loaded = false },
  selected() {
    coverPage.initialize('zh-CN');
    context = { identified: true }; pageActive = playerReady = loaded = true;
    series = { id: 'hg-1', title: 'Test' };
    episode = { id: 'hg-11', label: '1', number: 1, codec: 'h264', playable: true };
    episodes = [episode];
    syncSourceButton();
  },
  clearSelection() { series = null; episode = null },
  setEpisodes(items, cursor) { episodes = items; episode = items[0]; epCursor = cursor },
  episodeId() { return episode?.id },
};`
const code = transformSync(source, { loader: 'ts', format: 'cjs' }).code
const accountCode = transformSync(readFileSync(new URL('../src/ui/provider-account.ts', import.meta.url), 'utf8'), { loader: 'ts', format: 'cjs' }).code
const decoyCode = transformSync(readFileSync(new URL('../src/ui/hover-decoy.ts', import.meta.url), 'utf8'), { loader: 'ts', format: 'cjs' }).code
const flush = async () => { for (let i = 0; i < 50; i++) await Promise.resolve() }

function setup(t) {
  const root = mkdtempSync(join(tmpdir(), 'hongguo-playback-ui-'))
  const store = new Store(root), peer = new Store(root)
  t.after(() => { store.close(); peer.close(); rmSync(root, { recursive: true, force: true }) })
  const service = new Service(store, {}), other = new Service(peer, {})
  const panel = service.panel(service.open({ threadId: 'A' }).panel)
  const otherPanel = other.panel(other.open({ threadId: 'B' }).panel)
  const video = new Video(), elements = new Map()
  const document = Object.assign(new EventTarget(), {
    hidden: false, documentElement: new Element(), hasFocus: () => true,
    getElementById(id) { if (!elements.has(id)) elements.set(id, this.createElement()); return elements.get(id) },
    querySelector: () => video, querySelectorAll: () => [],
    createElement: () => {
      const e = Object.assign(new Element(), { ownerDocument: document })
      e.focus = () => { document.activeElement = e }; return e
    },
  })
  const window = Object.assign(new EventTarget(), { innerWidth: 900, innerHeight: 700, setInterval: () => 1, clearInterval() {}, scrollTo() {} })
  const api = {
    browser: false, connect: async () => {}, hostLocale: () => 'zh',
    call: (name, args = {}) => name === 'get_providers' && !service.catalog.sources
      ? Promise.resolve({ items: ['hongguo', 'demo'].map(id => ({ id, name: id === 'hongguo' ? '红果' : '示例片源', available: true, nsfw: false })) })
      : service.call(panel, name, args),
  }
  const exports = {}, context = vm.createContext({
    module: { exports }, exports, document, window, navigator: {}, crypto: webcrypto,
    AbortController, DOMException, setTimeout, clearTimeout,
    require(name) {
      if (name === './provider-account') {
        const exports = {}, scope = vm.createContext({ module: { exports }, exports, document, Blob, URL, setTimeout, clearTimeout,
          require: name => name === './api' ? api : { tr: value => value } })
        vm.runInContext(accountCode, scope)
        return scope.module.exports
      }
      if (name === './api') return api
      if (name === './cover-page') return { createCoverPage }
      if (name === './source-confirmation') return { createSourceConfirmation: options => createSourceConfirmation(options, document) }
      if (name === './settings') return { createSettings: options => createSettings(options, document) }
      if (name === './hover-decoy') {
        const exports = {}, decoyContext = vm.createContext({ module: { exports }, exports, document, window, setTimeout, clearTimeout })
        vm.runInContext(decoyCode, decoyContext)
        return decoyContext.module.exports
      }
      if (name === './locale') return { tr: value => value }
      if (name === './playback-turn') return turnHelpers
      if (name === './media-startup') return mediaHelpers
      if (name === './panel-stream') return { panelStream(video) { queueMicrotask(()=>video.dispatchEvent(new Event('loadedmetadata'))); return ()=>{} } }
      if (name === './ui-kit') return { setIcon() {}, fill() {}, icon: () => new Element(), coverArt: () => new Element(), setCover() {} }
      return {}
    },
  })
  vm.runInContext(code, context)
  const ui = context.module.exports.fixture
  t.after(() => { ui.decoy.dispose(); ui.closePlayer() })
  ui.selected()
  ui.setProviders([{ id: 'hongguo', name: '红果', available: true }, { id: 'demo', name: '示例片源', available: true }])
  let at = Date.now()
  return {
    store, peer, service, panel, video, document, window, ui, elements,
    event(turn, kind = 'UserPromptSubmit', session = 'A') {
      peer.event({ session_id: session, turn_id: turn, hook_event_name: kind }, ++at)
    },
    async poll() { await ui.poll(); await flush() },
    settings: patch => other.call(otherPanel, 'set_preferences', patch),
  }
}
const turnHelpers = await import('../src/ui/playback-turn.ts')
const mediaHelpers = await import('../src/ui/media-startup.ts')

test('hovering or clicking the source mark opens a menu; only choosing a provider switches sources', async t => {
  const f = setup(t)
  f.service.catalog = { list: async () => ({ items: [] }) }
  const control = f.elements.get('source')
  const menu = f.elements.get('sourceMenu'), query = f.elements.get('query')
  f.document.activeElement = query
  assert.equal(control.getAttribute('aria-label'), '切换视频源')
  control.onpointerenter({ pointerType: 'touch' })
  assert.equal(menu.hidden, true)
  control.onpointerenter({ pointerType: 'mouse' })
  assert.equal(menu.hidden, false)
  assert.equal(f.ui.sourceState().source, 'hongguo')
  assert.equal(f.document.activeElement, query)
  control.onclick(); await flush()
  assert.equal(menu.hidden, false)
  assert.equal(f.ui.sourceState().source, 'hongguo')
  menu.children[1].onclick(); await flush()
  assert.equal(f.ui.sourceState().source, 'demo')
  assert.equal(control.dataset.source, 'demo')
  assert.equal(control.getAttribute('aria-label'), '切换视频源')
  assert.equal(f.elements.get('sourceName').textContent, '示例片源')
  assert.equal(f.elements.get('sourceMenu').hidden, true)
  assert.equal(control.disabled, false)
  control.onclick(); await flush()
  assert.equal(f.ui.sourceState().source, 'demo')
  menu.children[0].onclick(); await flush()
  assert.equal(f.ui.sourceState().source, 'hongguo')
})
test('leaving the source popover closes it, while crossing into it cancels dismissal', t => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const f = setup(t), control = f.elements.get('sourceControl'), menu = f.elements.get('sourceMenu')
  f.elements.get('source').onclick({ detail: 1 })
  control.onpointerleave({ pointerType: 'touch' }); t.mock.timers.tick(160)
  assert.equal(menu.hidden, false)
  menu.onkeydown({ key: 'Escape', preventDefault() {} })
  f.elements.get('source').onpointerenter({ pointerType: 'mouse' })
  control.onpointerleave(); t.mock.timers.tick(80)
  assert.equal(menu.hidden, false)
  control.onpointerenter(); t.mock.timers.tick(160)
  assert.equal(menu.hidden, false)
  control.onpointerleave(); t.mock.timers.tick(160)
  assert.equal(menu.hidden, true)
  assert.equal(f.ui.sourceState().source, 'hongguo')
})
test('Settings source select switches immediately, remembers the choice and tracks the top-left entry', async t => {
  const f = setup(t)
  f.service.catalog = { list: async () => ({ items: [] }) }
  f.ui.settings.open()
  const select = f.elements.get('settingsSource')
  assert.equal(select.value, 'hongguo')
  assert.deepEqual(select.children.map(o => o.textContent), ['红果短剧', '示例片源'])
  const option = select.children[0]
  f.ui.settings.sync(); f.ui.settings.sync()
  assert.equal(select.children[0], option, 'polling must not recreate the native menu')
  select.value = 'demo'; await select.onchange()
  assert.equal(f.store.preferences().defaultSource, 'demo')
  assert.equal(select.value, 'demo')
  assert.equal(f.elements.get('sourceName').textContent, '示例片源')
  assert.equal(f.elements.get('settings').hidden, false)
  await f.ui.changeSource('hongguo')
  assert.equal(select.value, 'hongguo')
  assert.equal(select.disabled, false)
})
test('Settings source selection preserves the current value when the service rejects a switch', async t => {
  const f = setup(t), call = f.service.call.bind(f.service)
  f.service.catalog = { list: async () => ({ items: [] }) }
  f.service.call = (scope, name, args) => name === 'set_source' ? Promise.reject(Error('Synthetic failure')) : call(scope, name, args)
  f.ui.settings.open()
  const select = f.elements.get('settingsSource')
  select.value = 'demo'; await select.onchange()
  assert.equal(select.value, 'hongguo')
  assert.equal(f.store.preferences().defaultSource, 'hongguo')
  assert.equal(f.ui.sourceState().source, 'hongguo')
  assert.equal(f.elements.get('settings').hidden, false)
  assert.equal(select.disabled, false)
})
test('Settings disables source selection when only one source is available and ignores reselecting the current source', async t => {
  const f = setup(t); f.video.paused = false
  f.ui.setProviders([{ id: 'hongguo', name: '红果', available: true }, { id: 'unavailable', name: 'Unavailable', available: false }])
  const select = f.elements.get('settingsSource')
  assert.equal(select.children.length, 1); assert.equal(select.disabled, true)
  select.value = 'hongguo'; await select.onchange()
  assert.equal(f.video.paused, false)
  assert.equal(f.ui.episodeId(), 'hg-11')
})
test('keyboard opening focuses the current provider and Escape returns to the source button', t => {
  const f = setup(t), control = f.elements.get('source'), menu = f.elements.get('sourceMenu')
  control.onkeydown({ key: 'ArrowDown', preventDefault() {} })
  assert.equal(menu.hidden, false)
  assert.equal(f.document.activeElement, menu.children[0])
  menu.onkeydown({ key: 'Escape', preventDefault() {} })
  assert.equal(menu.hidden, true)
  assert.equal(f.document.activeElement, control)
  assert.equal(f.ui.sourceState().source, 'hongguo')
})
test('additional providers use a checked menu and select through the existing source service', async t => {
  const f = setup(t)
  f.service.catalog = { list: async () => ({ items: [] }) }
  f.ui.setProviders([{ id: 'hongguo', name: '红果', available: true }, { id: 'demo', name: '示例片源', available: true },
    { id: 'local', name: 'Local provider', available: true }])
  const control = f.elements.get('source'), menu = f.elements.get('sourceMenu')
  control.onclick()
  assert.equal(menu.hidden, false)
  assert.equal(control.getAttribute('aria-expanded'), 'true')
  assert.equal(menu.children.length, 3)
  assert.equal(menu.children[0].getAttribute('aria-checked'), 'true')
  menu.children[2].onclick(); await flush()
  assert.equal(f.ui.sourceState().source, 'local')
  assert.equal(menu.hidden, true)
  assert.equal(f.store.preferences().defaultSource, 'local')
  assert.equal(f.elements.get('sourceName').textContent, 'Local provider')
})
test('link-based providers import only on submit while Hongguo keeps debounced search', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const f = setup(t), requests = []
  f.service.catalog = { list: async input => { requests.push(input); return { items: [] } } }
  f.ui.setProviders([{ id: 'hongguo', name: '红果', available: true },
    { id: 'bilibili', name: '哔哩哔哩', available: true, queryMode: 'link', queryHint: '粘贴番剧链接或 ss/ep 编号' }])
  await f.ui.changeSource('bilibili'); requests.length = 0
  const input = f.elements.get('query')
  assert.equal(input.placeholder, '粘贴番剧链接或 ss/ep 编号')
  input.value = 'ep50188'; input.dispatchEvent(new Event('input'))
  t.mock.timers.tick(500); await flush()
  assert.equal(requests.length, 0, 'typing a partial link must not import unrelated series')
  f.elements.get('search').onsubmit({ preventDefault() {} }); await flush()
  assert.equal(requests[0].query, 'ep50188')
  await f.ui.changeSource('hongguo'); requests.length = 0
  assert.equal(input.placeholder, '搜索剧名')
  input.value = '重生'; input.dispatchEvent(new Event('input'))
  t.mock.timers.tick(500); await flush()
  assert.equal(requests[0].query, '重生')
})
test('a single available provider disables switching instead of opening an empty menu', t => {
  const f = setup(t)
  f.ui.setProviders([{ id: 'hongguo', name: '红果', available: true }, { id: 'demo', name: '示例片源', available: false }])
  const control = f.elements.get('source')
  assert.equal(control.disabled, true)
  control.onpointerenter({ pointerType: 'mouse' })
  control.onclick()
  assert.equal(f.elements.get('sourceMenu').hidden, true)
  assert.equal(f.ui.sourceState().source, 'hongguo')
})
test('installed providers are available without any enable settings', async t => {
  const f = setup(t)
  const sources = new ProviderRegistry(f.store.root, { builtins: ['hongguo', 'demo'].map(id => ({
    manifest: { apiVersion: 1, id, name: id, version: '1.0.0', nsfw: false },
    createProvider: () => ({ id, async listSeries() { return { items: [], cursor: null } },
      async getSeries() {}, async listEpisodes() { return { items: [], cursor: null } }, async getCover() {}, async resolvePlayback() {} }),
  })) })
  t.after(() => sources.dispose()); f.service.catalog = new Catalog(f.store, { sources })
  await f.elements.get('prefs').onclick()
  assert.equal(f.elements.has('providerSettings'), false)
  assert.equal('enabledProviders' in f.store.preferences(), false)
  assert.equal(sources.get('demo').id, 'demo')
  assert.equal(f.elements.get('source').disabled, false)
  await f.ui.settings.finish()
  await f.ui.changeSource('demo')
  assert.equal(f.ui.sourceState().source, 'demo')
  assert.equal(f.elements.get('sourceConfirmation').hidden, true)
})
async function nsfwPlayer(t) {
  const f = setup(t); await f.poll()
  f.service.catalog = { list: async () => ({ items: [] }) }
  f.ui.setProviders([{ id: 'hongguo', name: '红果', available: true, nsfw: false },
    { id: 'demo', name: 'Sensitive fixture', available: true, nsfw: true },
    { id: 'local', name: 'Safe fixture', available: true, nsfw: false }])
  f.elements.get('sourceConfirmation').append(f.elements.get('sourceCancel'), f.elements.get('sourceConfirm'))
  return f
}
test('Settings NSFW selection keeps playback and Settings open until explicit confirmation', async t => {
  const f = await nsfwPlayer(t); f.video.paused = false; f.ui.settings.open()
  const select = f.elements.get('settingsSource')
  select.focus()
  assert.match(select.children[1].textContent, /NSFW/)
  select.value = 'demo'; const first = select.onchange(); await flush()
  assert.equal(select.value, 'hongguo'); assert.equal(select.disabled, true)
  assert.equal(f.video.paused, false)
  assert.equal(f.elements.get('settings').hidden, false)
  f.elements.get('sourceCancel').onclick(); await first
  assert.equal(select.value, 'hongguo'); assert.equal(select.disabled, false)
  assert.equal(f.video.paused, false)
  const escape = new Event('keydown', { cancelable: true }); Object.assign(escape, { key: 'Escape' })
  select.value = 'demo'; const second = select.onchange(); await flush()
  f.document.dispatchEvent(escape); await second
  assert.equal(f.elements.get('settings').hidden, false)
  assert.equal(select.value, 'hongguo')
  assert.equal(f.video.paused, false)
  select.value = 'demo'; const third = select.onchange(); await flush()
  f.elements.get('sourceConfirm').onclick(); await third
  assert.equal(select.value, 'demo'); assert.equal(f.store.preferences().defaultSource, 'demo')
  assert.equal(f.elements.get('settings').hidden, false)
})
test('cancelling NSFW selection leaves the source, playback, progress and default untouched', async t => {
  const f = await nsfwPlayer(t); f.video.paused = false
  const request = f.ui.changeSource('demo'); await flush()
  assert.equal(f.elements.get('sourceConfirmation').hidden, false)
  assert.equal(f.document.activeElement, f.elements.get('sourceCancel'))
  assert.equal(f.ui.sourceState().source, 'hongguo'); assert.equal(f.ui.episodeId(), 'hg-11')
  assert.equal(f.video.paused, false); assert.equal(f.store.preferences().defaultSource, 'hongguo')
  f.elements.get('sourceCancel').onclick(); await request
  assert.equal(f.elements.get('sourceConfirmation').hidden, true)
  assert.equal(f.ui.sourceState().source, 'hongguo'); assert.equal(f.ui.episodeId(), 'hg-11')
  assert.equal(f.video.paused, false); assert.equal(f.store.history().length, 0)
})
test('only explicit NSFW confirmation commits the switch and a later entry asks again', async t => {
  const f = await nsfwPlayer(t), requests = [], call = f.service.call.bind(f.service)
  f.service.call = (scope,name,args) => { if (name === 'set_source') requests.push(args); return call(scope,name,args) }
  const switching = f.ui.changeSource('demo'); await flush()
  assert.equal(requests.length, 0)
  f.elements.get('sourceConfirm').onclick(); await switching
  assert.equal(f.ui.sourceState().source, 'demo'); assert.equal(f.store.preferences().defaultSource, 'demo')
  assert.equal(requests[0].confirmNsfw, true)
  await f.ui.changeSource('hongguo')
  assert.equal(f.elements.get('sourceConfirmation').hidden, true)
  assert.equal(requests[1].confirmNsfw, undefined)
  const again = f.ui.changeSource('demo'); await flush()
  assert.equal(f.elements.get('sourceConfirmation').hidden, false)
  f.elements.get('sourceCancel').onclick(); await again
  assert.equal(f.ui.sourceState().source, 'hongguo')
})
test('NSFW dialog traps keyboard focus and Escape cancels without switching', async t => {
  const f = await nsfwPlayer(t), request = f.ui.changeSource('demo'); await flush()
  const key = value => { const event = new Event('keydown',{cancelable:true}); Object.assign(event,{key:value}); f.document.dispatchEvent(event) }
  key('Tab'); assert.equal(f.document.activeElement, f.elements.get('sourceConfirm'))
  key('Tab'); assert.equal(f.document.activeElement, f.elements.get('sourceCancel'))
  key('Escape'); await request
  assert.equal(f.elements.get('sourceConfirmation').hidden, true)
  assert.equal(f.ui.sourceState().source, 'hongguo')
})
test('a safe source choice supersedes a pending NSFW decision and closing cancels it', async t => {
  const f = await nsfwPlayer(t), old = f.ui.changeSource('demo'); await flush()
  await f.ui.changeSource('local'); await old
  f.elements.get('sourceConfirm').onclick(); await flush()
  assert.equal(f.ui.sourceState().source, 'local')
  const next = f.ui.changeSource('demo'); await flush()
  await f.ui.closePlayer(); await next
  f.elements.get('sourceConfirm').onclick(); await flush()
  assert.equal(f.ui.sourceState().source, 'local')
})
test('covering a pending NSFW decision cancels it and returning cannot switch sources', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const f = await nsfwPlayer(t); await f.settings({ hoverDecoyEnabled: true }); await f.poll()
  await enterPanel(t, f)
  const request = f.ui.changeSource('demo'); await flush()
  f.ui.decoy.conceal(); await request
  f.elements.get('sourceConfirm').onclick(); await flush()
  assert.equal(f.elements.get('sourceConfirmation').hidden, true)
  assert.equal(f.ui.sourceState().source, 'hongguo')
})

test('switching providers saves progress, stops playback and discards the old catalog response', async t => {
  const f = setup(t), old = Promise.withResolvers()
  f.service.catalog = { list: async options => options.source === 'demo'
    ? { items: [{ id: 'p.demo.s.MQ', title: 'Demo' }] } : old.promise }
  const initial = f.ui.list()
  await flush()
  await f.ui.changeSource('demo')
  assert.equal(f.ui.sourceState().source, 'demo')
  assert.deepEqual([...f.ui.sourceState().cards], ['p.demo.s.MQ'])
  assert.equal(f.ui.episodeId(), undefined)
  assert.equal(f.video.paused, true)
  assert.equal(f.store.history('hg-1', 'hg-11')[0].positionMs, 12000)
  old.resolve({ items: [{ id: 'hg-1', title: 'Late red' }] })
  await initial; await flush()
  assert.deepEqual([...f.ui.sourceState().cards], ['p.demo.s.MQ'])
  assert.equal(f.panel.source, 'demo')
})
test('global default changes do not switch an existing player and stale history cannot cross sources', async t => {
  const f = setup(t), delayed = Promise.withResolvers(), call = f.service.call.bind(f.service)
  let deferRed = true
  f.service.call = async (scope, name, args = {}) => {
    if (name === 'get_history' && args.source === 'hongguo' && deferRed) return delayed.promise
    return call(scope, name, args)
  }
  f.service.catalog = { list: async () => ({ items: [] }) }
  const history = f.ui.history(); await flush()
  await f.ui.changeSource('demo')
  deferRed = false
  delayed.resolve({ items: [{ seriesId: 'hg-1', episodeId: 'hg-11', title: 'late', label: '1', positionMs: 1, durationMs: 10 }] })
  await history
  assert.equal(f.ui.sourceState().watched.length, 0)
  const other = f.service.panel(f.service.open({ threadId: 'C' }).panel)
  await f.service.call(other, 'set_source', { source: 'hongguo' })
  await f.poll()
  assert.equal(f.ui.sourceState().source, 'demo')
  assert.equal(f.store.preferences().defaultSource, 'hongguo')
})

test('global playback switches default for older settings, synchronize across chats and survive restart', async t => {
  const f = setup(t)
  f.store.preferences()
  f.store.db.prepare('INSERT OR REPLACE INTO player_preferences VALUES(1,?)').run(JSON.stringify({ autoPrompt: false }))
  assert.equal(f.peer.preferences().autoPauseOnFinish, true)
  assert.equal(f.peer.preferences().autoPlayOnStart, true)
  assert.equal(f.peer.preferences().defaultMuted, true)
  assert.equal(f.peer.preferences().volume, 0.7)
  await f.settings({ autoPauseOnFinish: false, autoPlayOnStart: true, defaultMuted: false, volume: 0.42 })
  const snapshot = await f.service.call(f.panel, 'get_run_state', { observeSession: true })
  assert.equal(snapshot.preferences.autoPauseOnFinish, false)
  assert.equal(snapshot.preferences.autoPlayOnStart, true)
  const reopened = new Store(f.store.root)
  try {
    assert.equal(reopened.preferences().autoPauseOnFinish, false)
    assert.equal(reopened.preferences().autoPlayOnStart, true)
    assert.equal(reopened.preferences().autoPrompt, false)
    assert.equal(reopened.preferences().defaultMuted, false)
    assert.equal(reopened.preferences().volume, 0.42)
  } finally { reopened.close() }
  await f.settings({ autoPlayOnStart: false })
  const explicitlyDisabled = new Store(f.store.root)
  try { assert.equal(explicitlyDisabled.preferences().autoPlayOnStart, false) }
  finally { explicitlyDisabled.close() }
  await assert.rejects(f.settings({ autoPlayOnStart: 'yes' }), /参数无效/)
  await assert.rejects(f.settings({ defaultMuted: 'yes' }), /参数无效/)
  assert.equal(f.peer.preferences().hoverDecoyEnabled, false)
  await f.settings({ hoverDecoyEnabled: true })
  const decoySettings = new Store(f.store.root)
  try { assert.equal(decoySettings.preferences().hoverDecoyEnabled, true) }
  finally { decoySettings.close() }
  for (const volume of [0, -1, 1.01, NaN, Infinity]) await assert.rejects(f.settings({ volume }), /参数无效/)
})

test('player switches save immediately and explicit Close finishes Settings', async t => {
  const f = setup(t)
  f.event('one'); await f.poll()
  await f.elements.get('prefs').onclick()
  assert.equal(f.elements.get('autoPauseOnFinish').checked, true)
  assert.equal(f.elements.get('autoPlayOnStart').checked, true)
  assert.equal(f.elements.get('defaultMuted').checked, true)
  for (const key of ['autoPauseOnFinish', 'autoPlayOnStart', 'defaultMuted', 'hoverDecoyEnabled']) {
    f.elements.get(key).checked = key === 'hoverDecoyEnabled'
    f.elements.get(key).onchange()
  }
  await flush()
  assert.equal(f.peer.preferences().autoPauseOnFinish, false)
  assert.equal(f.peer.preferences().autoPlayOnStart, false)
  assert.equal(f.peer.preferences().defaultMuted, false)
  assert.equal(f.peer.preferences().hoverDecoyEnabled, true)
  assert.equal(f.elements.get('settings').hidden, false)
  f.elements.get('settingsClose').onclick(); await flush()
  assert.equal(f.elements.get('settings').hidden, true)
})

function movePointer(f, x = 40, y = 40) {
  const event = new Event('pointermove')
  Object.assign(event, { clientX: x, clientY: y, pointerType: 'mouse' })
  f.document.dispatchEvent(event)
}
function leavePanel(f) {
  const event = new Event('pointerleave')
  Object.assign(event, { clientX: -1, clientY: 40 })
  f.document.documentElement.dispatchEvent(event)
}
async function enterPanel(t, f) { movePointer(f); t.mock.timers.tick(150); await flush() }
async function hoveringPlayer(t, playing = true) {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const f = setup(t)
  movePointer(f)
  f.event('one'); await f.poll()
  await f.settings({ hoverDecoyEnabled: true }); await f.poll()
  if (playing) await f.ui.start()
  return f
}
test('selecting a cover style keeps Settings open and preserves playback and unrelated preferences', async t => {
  const f = await hoveringPlayer(t)
  const host = f.elements.get('decoy'), page = host.children[0]
  const plays = f.video.plays, position = f.video.currentTime
  f.ui.decoy.conceal(); await enterPanel(t, f); await f.poll()
  await f.elements.get('prefs').onclick()
  await f.poll()
  f.ui.coverPage.initialize('zh-CN')
  assert.equal(host.children[0], page)
  const settings = f.peer.preferences()
  const playsAfterHover = f.video.plays
  assert.equal(playsAfterHover, plays + 1)
  const style = page.dataset.template === 'report' ? 'tasks' : 'report'
  f.elements.get('coverStyle').onclick()
  f.elements.get('coverStyle-' + style).onclick(); await flush()
  assert.notEqual(host.children[0], page)
  assert.equal(host.children[0].dataset.template, style)
  assert.equal(f.video.paused, false)
  assert.equal(f.video.plays, playsAfterHover)
  assert.equal(f.video.currentTime, position)
  assert.deepEqual(f.peer.preferences(), { ...settings, coverStyle: style })
  assert.equal(f.elements.get('settings').hidden, false)
  await f.ui.pause()
  f.elements.get('coverStyle').onclick()
  f.elements.get('coverStyle-minutes').onclick(); await flush()
  assert.equal(f.video.paused, true)
  assert.equal(f.video.plays, playsAfterHover)
  assert.equal(f.elements.get('settings').hidden, false)
  const saved = host.children[0]
  await f.poll()
  assert.equal(host.children[0], saved)
})
test('leaving the panel pauses synchronously and returning preserves the player and its position', async t => {
  const f = await hoveringPlayer(t)
  leavePanel(f)
  assert.equal(f.ui.decoy.covered, true)
  assert.equal(f.video.paused, true)
  assert.equal(f.elements.get('playerContent').inert, true)
  assert.equal(f.video.currentTime, 12)
  const plays = f.video.plays
  movePointer(f); t.mock.timers.tick(149); await flush()
  assert.equal(f.video.plays, plays)
  t.mock.timers.tick(1); await flush()
  assert.equal(f.ui.decoy.covered, false)
  assert.equal(f.video.paused, false)
  assert.equal(f.video.plays, plays + 1)
  assert.equal(f.video.currentTime, 12)
  assert.equal(f.elements.get('playerContent').inert, false)
})

test('menu retargeting events inside the viewport never conceal the player or interrupt playback', async t => {
  const f = await hoveringPlayer(t)
  await f.elements.get('prefs').onclick()
  f.elements.get('coverStyle').onclick()
  for (const type of ['pointerout', 'mouseout']) {
    const event = new Event(type)
    Object.assign(event, { clientX: 40, clientY: 80, relatedTarget: null })
    f.document.dispatchEvent(event)
    assert.equal(f.ui.decoy.covered, false)
    assert.equal(f.video.paused, false)
    assert.equal(f.elements.get('settings').hidden, false)
    assert.equal(f.elements.get('coverStyleOptions').hidden, false)
  }
  const actualExit = new Event('pointerout')
  Object.assign(actualExit, { clientX: -1, clientY: 80, relatedTarget: null })
  f.document.dispatchEvent(actualExit)
  assert.equal(f.ui.decoy.covered, true)
  assert.equal(f.video.paused, true)
})

for (const type of ['pointerleave', 'mouseleave']) test(`first ${type} after changing style and dismissing Settings conceals even with last in-panel coordinates`, async t => {
  const f = await hoveringPlayer(t)
  await f.elements.get('prefs').onclick()
  f.elements.get('coverStyle').onclick()
  f.elements.get('coverStyle-report').onclick(); await flush()
  assert.equal(f.peer.preferences().coverStyle, 'report')
  const click = new Event('click', { cancelable: true })
  Object.assign(click, { composedPath: () => [f.elements.get('title')], clientX: 40, clientY: 80 })
  f.document.dispatchEvent(click); await flush()
  assert.equal(f.elements.get('settings').hidden, true)
  assert.equal(f.ui.decoy.covered, false)
  assert.equal(f.video.paused, false)
  const exit = new Event(type)
  Object.assign(exit, { clientX: 40, clientY: 80, relatedTarget: null })
  ;(type === 'pointerleave' ? f.document.documentElement : f.document).dispatchEvent(exit)
  assert.equal(f.ui.decoy.covered, true)
  assert.equal(f.elements.get('decoy').children[0].dataset.template, 'report')
  assert.equal(f.video.paused, true)
  await f.poll(); t.mock.timers.tick(150); await flush()
  assert.equal(f.ui.decoy.covered, true)
  assert.equal(f.video.paused, true)
  await enterPanel(t, f)
  assert.equal(f.ui.decoy.covered, false)
  assert.equal(f.elements.get('settings').hidden, true)
  assert.equal(f.video.paused, false)
})

test('a cover style saved in another chat applies once and synchronizes an open Settings sheet', async t => {
  const f = await hoveringPlayer(t)
  await f.elements.get('prefs').onclick()
  await f.settings({ coverStyle: 'minutes' }); await f.poll()
  const page = f.elements.get('decoy').children[0]
  assert.equal(page.dataset.template, 'minutes')
  assert.equal(f.elements.get('coverStyle').dataset.value, 'minutes')
  assert.equal(f.elements.get('settings').hidden, false)
  await f.poll()
  assert.equal(f.elements.get('decoy').children[0], page)
  await f.settings({ hoverDecoyEnabled: false }); await f.poll()
  assert.equal(f.elements.get('coverSettings').hidden, true)
  assert.equal(f.elements.get('settings').hidden, false)
})
for (const cancel of ['manual', 'Stop', 'Interrupt', 'close']) test(`hover return cannot undo ${cancel}`, async t => {
  const f = await hoveringPlayer(t)
  f.ui.decoy.conceal()
  const plays = f.video.plays
  if (cancel === 'manual') await f.ui.pause('已手动暂停')
  else if (cancel === 'close') await f.ui.closePlayer()
  else { f.event('one', cancel); await f.poll() }
  await enterPanel(t, f)
  assert.equal(f.video.paused, true)
  assert.equal(f.video.plays, plays)
})
test('an already manually paused player does not resume just because the pointer returns', async t => {
  const f = await hoveringPlayer(t)
  await f.ui.pause('已手动暂停')
  const plays = f.video.plays
  f.ui.decoy.conceal(); await enterPanel(t, f)
  assert.equal(f.video.paused, true)
  assert.equal(f.video.plays, plays)
})
for (const stops of [false, true]) test(`new-task playback is deferred behind the cover and rechecks ended=${stops}`, async t => {
  const f = await hoveringPlayer(t, false)
  f.ui.decoy.conceal()
  f.event('two'); await f.poll()
  assert.equal(f.video.plays, 0)
  if (stops) { f.event('two', 'Stop'); await f.poll() }
  await enterPanel(t, f)
  assert.equal(f.video.paused, stops)
  assert.equal(f.video.plays, stops ? 0 : 1)
})
test('pointer capture outside the viewport, blur and page hiding all conceal without focus-only reveal', async t => {
  const f = await hoveringPlayer(t)
  movePointer(f, -1, 20)
  assert.equal(f.video.paused, true)
  await enterPanel(t, f)
  assert.equal(f.video.paused, false)
  f.window.dispatchEvent(new Event('blur'))
  assert.equal(f.ui.decoy.covered, true)
  f.window.dispatchEvent(new Event('focus')); await flush()
  assert.equal(f.video.paused, true)
  await enterPanel(t, f)
  f.document.hidden = true
  f.document.dispatchEvent(new Event('visibilitychange'))
  assert.equal(f.video.paused, true)
  f.document.hidden = false
  f.document.dispatchEvent(new Event('visibilitychange')); await flush()
  assert.equal(f.ui.decoy.covered, true)
  await enterPanel(t, f)
  assert.equal(f.video.paused, false)
})
test('startup preferences finishing after conceal cannot play until a fresh hover', async t => {
  const f = await hoveringPlayer(t, false)
  let release
  const gate = new Promise(resolve => { release = resolve })
  const call = f.service.call.bind(f.service)
  f.service.call = async (scope, name, args) => {
    if (name === 'get_preferences') await gate
    return call(scope, name, args)
  }
  // Reset opening preferences without destroying the selected, loaded video.
  await f.ui.closePlayer(); f.ui.selected()
  const starting = f.ui.start()
  await flush()
  f.ui.decoy.conceal()
  release(); await starting; await flush()
  assert.equal(f.video.plays, 0)
  await enterPanel(t, f)
  assert.equal(f.video.plays, 1)
})
test('media preparation finishing behind the cover cannot attach or play until the pointer returns', async t => {
  const f = await hoveringPlayer(t, false)
  f.ui.unload()
  f.service.catalog = { prepare: () => ({ status: 'ready', stream: 'cover-stream', manifest: 'manifest' }), panelMedia: { pin() {}, unpin() {} } }
  f.panel.allowed = new Set(['hg-11'])
  let release
  const gate = new Promise(resolve => { release = resolve }), call = f.service.call.bind(f.service)
  f.service.call = async (scope, name, args) => {
    if (name === 'prepare_playback') await gate
    return call(scope, name, args)
  }
  const starting = f.ui.start(); await flush()
  f.ui.decoy.conceal()
  release(); await starting; await flush()
  assert.equal(f.video.plays, 0)
  assert.equal(f.video.paused, true)
  await enterPanel(t, f)
  assert.equal(f.video.plays, 1)
})
test('disabling hover mode restores a covered player and later pointer exits keep normal playback', async t => {
  const f = await hoveringPlayer(t)
  f.ui.decoy.conceal()
  await f.settings({ hoverDecoyEnabled: false }); await f.poll()
  assert.equal(f.ui.decoy.covered, false)
  assert.equal(f.video.paused, false)
  leavePanel(f)
  assert.equal(f.video.paused, false)
})
for (const enabled of [true, false]) test(`leaving and returning preserves open Settings with hover=${enabled}`, async t => {
  const f = await hoveringPlayer(t)
  await f.elements.get('prefs').onclick()
  if (!enabled) {
    f.elements.get('hoverDecoyEnabled').checked = false
    f.elements.get('hoverDecoyEnabled').onchange(); await flush()
  }
  leavePanel(f)
  assert.equal(f.elements.get('settings').hidden, false)
  assert.equal(f.ui.decoy.covered, enabled)
  assert.equal(f.video.paused, enabled)
  await enterPanel(t, f)
  assert.equal(f.elements.get('settings').hidden, false)
  assert.equal(f.ui.decoy.covered, false)
  assert.equal(f.video.paused, false)
  await f.elements.get('prefs').onclick()
  assert.equal(f.elements.get('settings').hidden, true)
})
test('a late play promise and host media play events cannot restart a covered player', async t => {
  const f = await hoveringPlayer(t, false)
  let release
  const gate = new Promise(resolve => { release = resolve })
  const play = f.video.play.bind(f.video)
  f.video.play = async () => { await play(); await gate }
  const starting = f.ui.start(); await flush()
  f.ui.decoy.conceal()
  assert.equal(f.video.paused, true)
  release(); await starting; await flush()
  assert.equal(f.video.paused, true)
  await play()
  assert.equal(f.video.paused, true)
})

for (const autoPauseOnFinish of [false, true]) for (const autoPlayOnStart of [false, true]) {
  test(`playback switches operate independently: pause=${autoPauseOnFinish}, play=${autoPlayOnStart}`, async t => {
    const f = setup(t)
    await f.settings({ autoPauseOnFinish, autoPlayOnStart })
    f.video.paused = false
    f.event('one'); await f.poll()
    f.event('one', 'Stop'); await f.poll()
    assert.equal(f.video.paused, autoPauseOnFinish)
    assert.equal(f.video.currentTime, 12)
    f.event('two'); await f.poll()
    assert.equal(f.video.paused, autoPauseOnFinish && !autoPlayOnStart)
    assert.equal(f.video.plays, Number(autoPauseOnFinish && autoPlayOnStart))
    await f.poll()
    assert.equal(f.video.plays, Number(autoPauseOnFinish && autoPlayOnStart))
    f.event('two', 'Interrupt'); await f.poll()
    assert.equal(f.video.paused, autoPauseOnFinish)
  })
}

test('task-start autoplay requires a new owning turn and preserves manual pause for the current task', async t => {
  const f = setup(t)
  await f.settings({ autoPlayOnStart: true })
  f.event('one'); await f.poll()
  assert.equal(f.video.plays, 0, 'opening during a task must not start playback')
  f.event('one', 'Stop'); await f.poll()
  f.event('other', 'UserPromptSubmit', 'B'); await f.poll()
  assert.equal(f.video.plays, 0)
  f.event('two'); await f.poll()
  assert.equal(f.video.plays, 1)
  await f.ui.pause('已手动暂停')
  await f.poll(); await f.poll()
  assert.equal(f.video.paused, true)
  assert.equal(f.video.plays, 1)
  f.event('three'); await f.poll()
  assert.equal(f.video.plays, 2)
  assert.equal(f.video.currentTime, 12)
})

test('changing a global switch takes effect in an already-open player without replaying the current turn', async t => {
  const f = setup(t)
  await f.settings({ autoPlayOnStart: false })
  f.event('one'); await f.poll()
  await f.settings({ autoPlayOnStart: true, autoPauseOnFinish: false })
  await f.poll()
  assert.equal(f.video.plays, 0)
  f.event('two'); await f.poll()
  assert.equal(f.video.paused, false)
  f.event('two', 'Stop'); await f.poll()
  assert.equal(f.video.paused, false)
  await f.settings({ autoPauseOnFinish: true })
  await f.poll()
  assert.equal(f.video.paused, false, 'changing settings must not replay an old Stop')
  f.event('three'); await f.poll()
  f.event('three', 'Interrupt'); await f.poll()
  assert.equal(f.video.paused, true)
})

test('empty or closed players never start, even when task-start autoplay is enabled', async t => {
  const f = setup(t)
  await f.settings({ autoPlayOnStart: true })
  f.event('one'); await f.poll()
  f.ui.clearSelection()
  f.event('two'); await f.poll()
  assert.equal(f.video.plays, 0)
  f.ui.selected()
  await f.ui.suspend()
  f.event('three'); await f.poll()
  assert.equal(f.video.plays, 0)
})

test('an automatic start rechecks its turn and global switch before invoking media playback', async t => {
  const f = setup(t)
  await f.settings({ autoPlayOnStart: true })
  f.event('one'); await f.poll()
  // Intercept only the recheck, after the poll has returned the new turn.
  const call = f.service.call.bind(f.service)
  let checks = 0, release
  const gate = new Promise(resolve => { release = resolve })
  f.service.call = async (scope, name, args) => {
    if (name === 'get_run_state' && ++checks === 2) await gate
    return call(scope, name, args)
  }
  f.event('two'); await f.poll()
  assert.equal(f.video.plays, 0)
  await f.settings({ autoPlayOnStart: false })
  release(); await flush()
  assert.equal(f.video.plays, 0)
  assert.equal(f.video.paused, true)
})

test('a delayed automatic start cannot play after its task has ended, even with automatic pausing off', async t => {
  const f = setup(t)
  await f.settings({ autoPlayOnStart: true, autoPauseOnFinish: false })
  f.event('one'); await f.poll()
  const call = f.service.call.bind(f.service)
  let checks = 0, release
  const gate = new Promise(resolve => { release = resolve })
  f.service.call = async (scope, name, args) => {
    if (name === 'get_run_state' && ++checks === 2) await gate
    return call(scope, name, args)
  }
  f.event('two'); await f.poll()
  f.event('two', 'Stop')
  release(); await flush()
  assert.equal(f.video.plays, 0)
})

test('a newly opened player applies default mute before a recommendation starts', async t=>{
  const f=setup(t)
  f.event('one'); await f.poll()
  f.video.muted=false; f.video.requireMuted=true
  await f.ui.start('one')
  assert.equal(f.video.paused,false)
  assert.equal(f.video.muted,true)
  assert.equal(f.video.plays,1)
})

for (const defaultMuted of [false, true]) test(`new players restore volume and default mute=${defaultMuted}, while resume preserves manual choices`, async t => {
  const f = setup(t)
  await f.settings({ defaultMuted, volume: 0.42 })
  await f.ui.openingPreferences()
  assert.equal(f.video.volume, 0.42)
  assert.equal(f.video.muted, defaultMuted)
  f.elements.get('mute').onclick(); f.video.onvolumechange()
  assert.equal(f.video.muted, !defaultMuted)
  await f.ui.start()
  await f.ui.pause('已手动暂停')
  await f.ui.start()
  f.event('one'); await f.poll()
  assert.equal(f.video.muted, !defaultMuted)
  assert.equal(f.video.volume, 0.42)
  assert.equal(f.peer.preferences().defaultMuted, defaultMuted)
  await f.ui.closePlayer()
  f.ui.selected()
  await f.ui.openingPreferences()
  assert.equal(f.video.muted, defaultMuted)
  assert.equal(f.video.volume, 0.42)
})

test('volume changes flush on close, while muting and zero volume preserve the last audible level', async t => {
  const f = setup(t)
  await f.settings({ defaultMuted: false, volume: 0.42 })
  await f.ui.openingPreferences()
  f.video.volume = 0.29; f.video.onvolumechange()
  f.elements.get('mute').onclick(); f.video.onvolumechange()
  f.video.volume = 0; f.video.onvolumechange()
  await f.ui.closePlayer()
  const reopened = new Store(f.store.root)
  try {
    assert.equal(reopened.preferences().volume, 0.29)
    assert.equal(reopened.preferences().defaultMuted, false)
  } finally { reopened.close() }
  f.ui.selected()
  await f.ui.openingPreferences()
  assert.equal(f.video.volume, 0.29)
  assert.equal(f.video.muted, false)
})

test('changing default mute synchronizes an open player once and preserves subsequent manual choices', async t => {
  const f = setup(t)
  await f.settings({ defaultMuted: false, volume: 0.42 })
  await f.ui.openingPreferences()
  await f.ui.start()
  await f.settings({ defaultMuted: true, volume: 0.81 })
  await f.poll()
  assert.equal(f.video.muted, true)
  assert.equal(f.video.volume, 0.42)
  assert.equal(f.video.plays, 1)
  f.elements.get('mute').onclick(); f.video.onvolumechange()
  await f.poll(); await f.poll()
  assert.equal(f.video.muted, false, 'unchanged preferences must preserve the manual unmute')
  f.video.volume = 0; f.video.onvolumechange()
  await f.settings({ defaultMuted: false })
  await f.poll()
  assert.equal(f.video.muted, false)
  assert.equal(f.video.volume, 0.42, 'disabling default mute restores the local audible volume')
  await f.ui.suspend()
  assert.equal(f.peer.preferences().volume, 0.81, 'a mute event must not overwrite another player volume')
})

test('saving a changed default mute immediately updates sound without restarting playback', async t => {
  const f = setup(t)
  await f.ui.openingPreferences()
  await f.ui.start()
  assert.equal(f.video.muted, true)
  await f.elements.get('prefs').onclick()
  f.elements.get('defaultMuted').checked = false
  f.elements.get('defaultMuted').onchange(); await flush()
  assert.equal(f.video.muted, false)
  assert.equal(f.video.plays, 1)
  f.elements.get('mute').onclick(); f.video.onvolumechange()
  f.elements.get('autoPrompt').checked = false
  f.elements.get('autoPrompt').onchange(); await flush()
  assert.equal(f.video.muted, true, 'saving unrelated settings must preserve manual mute')
  assert.equal(f.peer.preferences().defaultMuted, false)
})

test('a settings response arriving after polling cannot undo a newer manual sound choice', async t => {
  const f = setup(t)
  await f.ui.openingPreferences()
  await f.ui.start()
  const original = f.service.call.bind(f.service)
  let release
  const gate = new Promise(resolve => { release = resolve })
  f.service.call = async (scope, name, args) => {
    const result = await original(scope, name, args)
    if (name === 'set_preferences') await gate
    return result
  }
  await f.elements.get('prefs').onclick()
  f.elements.get('defaultMuted').checked = false
  f.elements.get('defaultMuted').onchange(); await flush()
  await f.poll()
  assert.equal(f.video.muted, false)
  f.elements.get('mute').onclick(); f.video.onvolumechange()
  release(); await flush()
  assert.equal(f.video.muted, true)
})

test('a poll snapshot taken before an autosave cannot restore the previous default mute', async t => {
  const f = setup(t)
  f.event('one'); await f.poll(); await f.ui.start()
  await f.elements.get('prefs').onclick()
  const original = f.service.call.bind(f.service)
  let release
  const gate = new Promise(resolve => { release = resolve })
  f.service.call = async (scope, name, args) => {
    const result = await original(scope, name, args)
    if (name === 'get_run_state') await gate
    return result
  }
  const polling = f.poll()
  await flush()
  f.elements.get('defaultMuted').checked = false
  f.elements.get('defaultMuted').onchange(); await flush()
  assert.equal(f.video.muted, false)
  release(); await polling
  assert.equal(f.video.muted, false)
})

test('disabling default mute keeps recommendations audible and never silently mutes after a host rejection', async t => {
  const f = setup(t)
  await f.settings({ defaultMuted: false, volume: 0.37 })
  f.event('one'); await f.poll()
  f.video.requireMuted = true
  await f.ui.start('one')
  assert.equal(f.video.muted, false)
  assert.equal(f.video.volume, 0.37)
  assert.equal(f.video.plays, 0)
  assert.match(f.elements.get('notice').textContent, /宿主阻止了自动播放.*点击播放/)
  f.video.requireMuted = false
  await f.ui.start()
  assert.equal(f.video.muted, false)
  assert.equal(f.video.plays, 1)
})

test('closing while sound preferences load prevents a late reply from starting or changing the closed player', async t => {
  const f = setup(t), original = f.service.call.bind(f.service)
  let release
  const gate = new Promise(resolve => { release = resolve })
  f.service.call = async (scope, name, args) => {
    if (name === 'get_preferences') await gate
    return original(scope, name, args)
  }
  const starting = f.ui.start()
  await flush()
  assert.equal(f.video.plays, 0)
  await f.ui.closePlayer()
  release(); await starting
  assert.equal(f.video.plays, 0)
  assert.equal(f.elements.get('mute').disabled, true)
})

test('an ended recommendation stays paused and explains that manual playback is available', async t=>{
  const f=setup(t)
  f.event('one'); await f.poll()
  f.event('one','Stop'); await f.poll()
  await f.ui.start('one')
  assert.equal(f.video.plays,0)
  assert.equal(f.video.paused,true)
  assert.match(f.elements.get('notice').textContent,/任务已结束.*播放/)
})

test('a recommendation still starts when the host hides and shows the same iframe during episode loading', async t=>{
  const f=setup(t)
  f.event('one'); await f.poll()
  let release
  const episodes=new Promise(resolve=>{release=resolve})
  f.service.catalog={episodes:()=>episodes,prepare:()=>({status:'ready',stream:'test-stream',manifest:'test manifest'}),panelMedia:{pin(){},unpin(){}}}
  const selected=f.ui.select({id:'hg-1',title:'Test'},undefined,true,'one')
  await flush()
  await f.ui.suspend()
  f.window.dispatchEvent(new Event('pageshow'))
  release({items:[{id:'hg-11',label:'1',number:1,codec:'h264',playable:true}]})
  await selected; await flush()
  assert.equal(f.video.plays,1)
  assert.equal(f.video.paused,false)
  assert.equal(f.video.muted,true)
})

for (const cancellation of ['none','stop','manual']) test(`a pending recommendation survives page activation without ignoring ${cancellation} cancellation`, async t=>{
  const f=setup(t)
  f.event('one'); await f.poll()
  const call=f.service.call.bind(f.service)
  let release,checks=0
  const gate=new Promise(resolve=>{release=resolve})
  f.service.call=async(scope,name,args)=>{
    if(name==='get_run_state'&&!args.playerInstance&&++checks===1)await gate
    return call(scope,name,args)
  }
  const starting=f.ui.start('one')
  await flush()
  if(cancellation==='manual')await f.ui.pause('已手动暂停')
  await f.ui.suspend()
  if(cancellation==='stop')f.event('one','Stop')
  f.window.dispatchEvent(new Event('pageshow'))
  await flush()
  release(); await starting; await flush()
  assert.equal(f.video.plays,cancellation==='none'?1:0)
  assert.equal(f.video.paused,cancellation!=='none')
})

test('a host autoplay denial explains the required click and does not retry on its own', async t=>{
  const f=setup(t)
  f.event('one'); await f.poll()
  const play=f.video.play.bind(f.video)
  f.video.play=async()=>{throw new DOMException('Host blocked autoplay','NotAllowedError')}
  await f.ui.start('one')
  assert.match(f.elements.get('notice').textContent,/宿主阻止了自动播放.*点击播放/)
  f.video.play=play
  await f.ui.suspend();f.window.dispatchEvent(new Event('pageshow'));await flush()
  assert.equal(f.video.plays,0)
  await f.ui.start()
  assert.equal(f.video.plays,1)
})

const preloadEpisodes = [11, 12].map((id, i) => ({
  id: 'hg-' + id, label: String(i + 1), number: i + 1, codec: 'h264', playable: true,
}))
async function preloadFixture(t, pending = false) {
  const f = setup(t), calls = [], warm = new Set()
  f.service.catalog = {
    episodes: async () => ({ items: preloadEpisodes }),
    prepare(id, browser, retry, preload) {
      calls.push({ id, preload, hit: warm.has(id) })
      if (preload && pending) return { status: 'preparing' }
      warm.add(id)
      return { status: 'ready', stream: 'stream-' + id, manifest: 'manifest' }
    },
    panelMedia: { pin() {}, unpin() {} },
  }
  await f.service.call(f.panel, 'get_episodes', { seriesId: 'hg-1' })
  f.ui.setEpisodes(preloadEpisodes)
  f.elements.get('autonext').checked = true
  await f.ui.start()
  return { ...f, calls }
}

test('switching episodes keeps the current manual mute state and volume', async t => {
  const f = await preloadFixture(t)
  f.video.muted = false; f.video.volume = 0.31; f.video.onvolumechange()
  await f.ui.nextEpisode()
  assert.equal(f.video.muted, false)
  assert.equal(f.video.volume, 0.31)
  await f.ui.suspend()
  assert.equal(f.peer.preferences().volume, 0.31)
})

test('only the next episode is warmed near the end and playback reuses that preparation', async t => {
  const f = await preloadFixture(t)
  f.video.currentTime = 44; f.video.ontimeupdate(); await flush()
  assert.equal(f.calls.length, 0)
  f.video.currentTime = 45; f.video.ontimeupdate(); await flush()
  f.video.currentTime = 46; f.video.ontimeupdate(); await flush()
  assert.deepEqual(f.calls, [{ id: 'hg-12', preload: true, hit: false }])
  assert.equal(f.ui.episodeId(), 'hg-11')
  assert.equal(f.video.paused, false)
  assert.equal(f.video.plays, 1)
  assert.equal(f.store.history('hg-1').length, 0, 'preloading must not create viewing progress')
  await f.ui.nextEpisode()
  assert.equal(f.ui.episodeId(), 'hg-12')
  assert.equal(f.video.plays, 2)
  assert.deepEqual(f.calls.at(-1), { id: 'hg-12', preload: undefined, hit: true })
})

for (const cancel of ['pause', 'disable', 'close']) test(`preloading stops polling after ${cancel}`, async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const f = await preloadFixture(t, true)
  f.video.currentTime = 50; f.video.ontimeupdate(); await flush()
  assert.equal(f.calls.length, 1)
  if (cancel === 'pause') await f.ui.pause('已手动暂停')
  if (cancel === 'disable') {
    f.elements.get('autonext').checked = false
    f.elements.get('autonext').onchange()
  }
  if (cancel === 'close') await f.ui.suspend()
  t.mock.timers.tick(700); await flush()
  assert.equal(f.calls.length, 1)
})

test('preload failures stay silent and disabled, paused or final episodes do not preload', async t => {
  const f = await preloadFixture(t)
  f.video.currentTime = 50
  f.elements.get('autonext').checked = false
  f.video.ontimeupdate(); await flush()
  f.elements.get('autonext').checked = true
  await f.ui.pause()
  f.video.ontimeupdate(); await flush()
  assert.equal(f.calls.length, 0)
  await f.ui.start()
  f.service.catalog.prepare = () => { throw Error('preload failed') }
  f.video.ontimeupdate(); await flush()
  assert.equal(f.video.paused, false)
  assert.equal(f.elements.get('notice').textContent, '正在播放')
  await f.ui.pause()
  await f.ui.start()
  f.ui.setEpisodes([preloadEpisodes[0]])
  f.video.ontimeupdate(); await flush()
  assert.equal(f.calls.length, 0)
})

test('preloading finds the next playable episode across a page boundary', async t => {
  const f = await preloadFixture(t)
  f.ui.setEpisodes([preloadEpisodes[0]], 'page-2')
  f.service.catalog.episodes = async () => ({ items: [
    preloadEpisodes[0], { ...preloadEpisodes[1], id: 'hg-99', playable: false }, preloadEpisodes[1],
  ] })
  f.video.currentTime = 50; f.video.ontimeupdate(); await flush()
  assert.deepEqual(f.calls, [{ id: 'hg-12', preload: true, hit: false }])
  assert.equal(f.ui.episodeId(), 'hg-11')
  await f.ui.nextEpisode()
  assert.equal(f.ui.episodeId(), 'hg-12')
})

test('a growing playlist keeps the full episode duration and waits for a deferred seek', async t => {
  const f = setup(t)
  f.video.duration = 5
  f.service.catalog = {
    episodes: async () => ({ items: preloadEpisodes }),
    prepare: () => ({ status: 'ready', stream: 'growing', manifest: '#EXTM3U\n#EXTINF:5,\nseg00000.m4s', durationMs: 120000 }),
    panelMedia: { pin() {}, unpin() {} },
  }
  await f.ui.select({ id: 'hg-1', title: 'Test' }, undefined, true)
  f.video.currentTime = 4
  f.video.ended = true
  f.video.onended()
  await f.ui.pause()
  const progress = f.store.history('hg-1')[0]
  assert.equal(progress.positionMs, 4000)
  assert.equal(progress.durationMs, 120000)
  const seek = f.elements.get('seek')
  seek.value = '500'; seek.oninput()
  seek.onchange(); await flush()
  assert.equal(f.video.currentTime, 4, 'unavailable positions wait for the remaining fragments')
  assert.equal(f.store.history('hg-1')[0].positionMs, 4000)
  f.video.duration = 120; f.video.ondurationchange()
  assert.equal(f.video.currentTime, 60)
  await flush()
  assert.equal(f.store.history('hg-1')[0].positionMs, 60000)
})

test('preloading and next playback share a pending episode page without switching after cancellation', async t => {
  const f = await preloadFixture(t)
  let resolve, pages = 0
  f.service.catalog.episodes = () => { pages++; return new Promise(done => { resolve = done }) }
  f.ui.setEpisodes([preloadEpisodes[0]], 'page-2')
  f.video.currentTime = 50; f.video.ontimeupdate(); await flush()
  const next = f.ui.nextEpisode()
  await flush()
  assert.equal(pages, 1)
  await f.ui.pause('已手动暂停')
  resolve({ items: [preloadEpisodes[1]] })
  await next; await flush()
  assert.equal(f.calls.length, 0)
  assert.equal(f.ui.episodeId(), 'hg-11')
  assert.equal(f.video.paused, true)
})

async function accountPlayer(t) {
  const f = setup(t), authCalls = []
  const auth = {
    revision: () => 'fixture-revision',
    status: async () => ({ status: 'signed-out' }),
    start: async () => ({ status: 'waiting', loginId: 'fixture-login', svg: '<svg/>', expiresAt: Date.now() + 180000 }),
    poll: async () => ({ status: 'waiting' }),
    cancel: async () => { authCalls.push('cancel'); return { status: 'cancelled' } },
    logout: async () => ({ status: 'signed-out' }),
  }
  const sources = new ProviderRegistry(f.store.root, { builtins: ['hongguo', 'demo'].map(id => ({
    manifest: { apiVersion: 1, id, name: id, version: '1.0.0', ...(id === 'demo' ? { authentication: 'qrcode' } : {}) },
    createProvider: () => ({ id, ...(id === 'demo' ? { auth } : {}),
      async listSeries() { return { items: [], cursor: null } }, async getSeries() {},
      async listEpisodes() { return { items: [], cursor: null } }, async getCover() {}, async resolvePlayback() {} }),
  })) })
  t.after(() => sources.dispose())
  f.service.catalog = new Catalog(f.store, { sources })
  await f.elements.get('prefs').onclick()
  f.elements.get('accountRows').children[0].onclick(); await flush()
  assert.equal(f.elements.get('accountQrArea').hidden, false)
  return { ...f, authCalls }
}
async function contentPlayer(t, single = false) {
  const f = setup(t), listing = []
  const types = [{ id: 'bangumi', name: '番剧' }, { id: 'video', name: '视频', queryHint: '搜索视频',
    categories: [{ id: '', name: '推荐' }, { id: 'all', name: '热门' }, { id: '36', name: '知识' }] }]
  const sources = new ProviderRegistry(f.store.root, { builtins: ['hongguo', 'demo'].map(id => ({
    manifest: { apiVersion: 1, id, name: id, version: '1.0.0', ...(id === 'demo' ? { contentTypes: types } : {}) },
    createProvider: () => ({ id, recommendationTerms: [],
      contentTypeOfId: value => value === 'v' ? 'video' : 'bangumi',
      async listSeries(options) { listing.push(options); return { items: [{ id: options.contentType === 'video' ? 'v' : 's',
        title: '测试内容', contentType: options.contentType || 'bangumi', episodes: single ? 1 : 2 }], cursor: null } },
      async getSeries() {}, async getCover() {}, async resolvePlayback() {},
      async listEpisodes(value) { return { series: { id: value, title: '视频标题', contentType: value === 'v' ? 'video' : 'bangumi', author: '测试 UP' },
        items: Array.from({ length: single ? 1 : 2 }, (_, i) => ({ id: value + (i + 1), number: i + 1, label: i ? '构图实践' : '曝光基础', playable: true })) } },
    }),
  })) })
  t.after(() => sources.dispose()); await sources.ready
  f.service.catalog = new Catalog(f.store, { sources })
  f.ui.setProviders(sources.list()); await f.ui.changeSource('demo')
  return { ...f, listing }
}
test('content tabs persist video/category choices and restore Hongguo chrome when switching back', async t => {
  const f = await contentPlayer(t)
  assert.equal(f.elements.get('contentTypes').hidden, false)
  assert.equal(f.elements.get('contentCategories').hidden, true)
  await f.ui.changeContent('video', '36')
  assert.equal(f.store.preferences().contentPreferences.demo.contentType, 'video')
  assert.equal(f.store.preferences().contentPreferences.demo.category, '36')
  assert.equal(f.elements.get('query').placeholder, '搜索视频')
  assert.equal(f.elements.get('contentCategories').hidden, false)
  assert.ok(f.listing.some(options => options.contentType === 'video' && options.category === '36'))
  await f.ui.changeSource('hongguo')
  assert.equal(f.elements.get('contentTypes').hidden, true)
  assert.equal(f.elements.get('contentCategories').hidden, true)
  assert.equal(f.elements.get('query').placeholder, '搜索剧名')
})
test('multi-P shows original chapter titles and single videos hide the episode selector', async t => {
  const f = await contentPlayer(t)
  await f.ui.changeContent('video', 'all')
  await f.ui.select({ id: 'p.demo.s.dg', title: '视频', contentType: 'video' })
  assert.equal(f.elements.get('episodeHeading').textContent, '分 P')
  assert.equal(f.elements.get('episodeCount').textContent, '2 P')
  assert.deepEqual(f.elements.get('episodes').children.map(b => b.textContent), ['P1 · 曝光基础', 'P2 · 构图实践'])
  assert.equal(f.elements.get('episodesPane').hidden, false)
  assert.equal(f.elements.get('next').getAttribute('aria-label'), '下一 P')
  const single = await contentPlayer(t, true)
  await single.ui.changeContent('video', 'all')
  await single.ui.select({ id: 'p.demo.s.dg', title: '单视频', contentType: 'video' })
  assert.equal(single.elements.get('episodesPane').hidden, true)
})
test('a login-required playback failure offers a direct route to the source account page', async t => {
  const f = await accountPlayer(t)
  await f.ui.settings.finish()
  await f.ui.changeSource('demo')
  f.ui.selected(); f.ui.unload()
  const call = f.service.call.bind(f.service)
  f.service.call = (scope, name, args) => name === 'prepare_playback'
    ? Promise.resolve({ status: 'error', reason: 'B 站需要登录后观看' }) : call(scope, name, args)
  await f.ui.start(); await flush()
  assert.equal(f.elements.get('accountNeeded').hidden, false)
  await f.elements.get('accountNeeded').onclick(); await flush()
  assert.equal(f.elements.get('settings').hidden, false)
  assert.equal(f.elements.get('settingsMain').hidden, true)
  assert.equal(f.elements.get('accountPage').hidden, false)
  assert.equal(f.elements.get('accountQrArea').hidden, false)
  assert.equal(f.ui.sourceState().source, 'demo')
  assert.equal(f.video.paused, true)
})
for (const dismiss of ['close', 'Escape', 'outside', 'trigger', 'player-close']) {
  test(`Provider QR is cancelled by ${dismiss} through main Settings lifecycle`, async t => {
    const f = await accountPlayer(t)
    for (let i = 0; i < 3; i++) await f.poll()
    assert.equal(f.elements.get('accountQrArea').hidden, false, 'polling does not restart a QR login')
    if (dismiss === 'close') f.elements.get('settingsClose').onclick()
    if (dismiss === 'trigger') await f.elements.get('prefs').onclick()
    if (dismiss === 'player-close') await f.ui.closePlayer()
    if (dismiss === 'Escape' || dismiss === 'outside') {
      const event = new Event(dismiss === 'Escape' ? 'keydown' : 'click', { cancelable: true })
      Object.assign(event, { key: 'Escape', composedPath: () => [] })
      f.document.dispatchEvent(event)
    }
    await flush()
    assert.equal(f.authCalls.length, 1)
    assert.equal(f.elements.get('providerAccount').hidden, dismiss !== 'Escape')
    assert.equal(f.elements.get('accountQrArea').hidden, true)
    assert.equal(f.elements.get('accountQr').getAttribute('src'), null)
    assert.equal(f.elements.get('settings').hidden, dismiss !== 'Escape')
    if (dismiss === 'Escape') {
      assert.equal(f.elements.get('accountPage').hidden, true)
      assert.equal(f.elements.get('settingsMain').hidden, false)
      await f.ui.settings.finish()
    }
  })
}
test('a stale poll cannot undo a pending setting edit while QR login is open and Close waits', async t => {
  const f = await accountPlayer(t), original = f.service.call.bind(f.service)
  let resolvePoll, resolveSave
  f.service.call = async (scope, name, args) => {
    if (name === 'get_run_state') {
      const result = await original(scope, name, args)
      await new Promise(resolve => { resolvePoll = resolve }); return result
    }
    if (name === 'set_preferences') await new Promise(resolve => { resolveSave = resolve })
    return original(scope, name, args)
  }
  const polling = f.ui.poll(); await flush()
  const input = f.elements.get('defaultMuted'); input.checked = false; input.onchange(); await flush()
  const closing = f.ui.settings.finish(); await flush()
  assert.equal(input.disabled, true)
  assert.equal(f.elements.get('settings').hidden, false)
  resolvePoll(); await polling; await flush()
  assert.equal(input.checked, false)
  resolveSave(); assert.equal(await closing, true); await flush()
  assert.equal(f.peer.preferences().defaultMuted, false)
  assert.equal(f.elements.get('settings').hidden, true)
})
test('switching Provider while covered cancels the old hover resume intent', async t => {
  const f = await hoveringPlayer(t)
  f.service.catalog = { list: async () => ({ items: [] }) }
  f.ui.decoy.conceal(); await flush()
  const played = f.video.plays
  await f.ui.changeSource('demo')
  await enterPanel(t, f)
  assert.equal(f.ui.sourceState().source, 'demo')
  assert.equal(f.video.paused, true)
  assert.equal(f.video.plays, played)
})

test('an on-demand stream resumes deep progress without waiting for a growing HLS playlist', async t => {
  const f = setup(t)
  f.event('dash'); await f.poll()
  f.ui.unload(); f.video.currentTime = 0; f.video.duration = 1200
  f.panel.allowed = new Set(['hg-11'])
  let preparations = 0
  f.service.catalog = { prepare: () => { preparations++; return { status: 'ready', format: 'dash',
    stream: 'dash-test', manifest: '{}', durationMs: 1200000 } }, panelMedia: { pin() {}, unpin() {} } }
  f.store.save({ seriesId: 'hg-1', episodeId: 'hg-11', title: 'Test', label: '1', positionMs: 600000, durationMs: 1200000 })
  await f.ui.start(); await flush()
  assert.equal(preparations, 1)
  assert.equal(f.video.currentTime, 600)
  assert.equal(f.video.paused, false)
})
for (const terminal of ['Stop', 'Interrupt']) test(`on-demand preparation cannot defeat the cover or a covered ${terminal}`, async t => {
  const f = await hoveringPlayer(t, false)
  f.ui.unload(); f.panel.allowed = new Set(['hg-11']); f.video.currentTime = 0
  f.service.catalog = { prepare: () => ({ status: 'ready', format: 'dash', stream: 'dash-test', manifest: '{}', durationMs: 60000 }),
    panelMedia: { pin() {}, unpin() {} } }
  let release
  const gate = new Promise(resolve => { release = resolve }), call = f.service.call.bind(f.service)
  f.service.call = async (scope, name, args) => { if (name === 'prepare_playback') await gate; return call(scope, name, args) }
  const starting = f.ui.start(); await flush()
  leavePanel(f); release(); await starting; await flush()
  assert.equal(f.ui.decoy.covered, true)
  assert.equal(f.video.plays, 0)
  f.event('one', terminal); await f.poll()
  await enterPanel(t, f)
  assert.equal(f.ui.decoy.covered, false)
  assert.equal(f.video.paused, true)
  assert.equal(f.video.plays, 0, 'returning to the panel cannot revive an ended task')
})
