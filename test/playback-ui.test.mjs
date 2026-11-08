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
  poll, pause, suspend, start, select, nextEpisode, home, openingPreferences, closePlayer, changeSource, list, history, refreshProviders,
  sourceState() { return { source: activeSource, cards: cards.map(row => row.id), watched: watched.map(row => row.seriesId) } },
  setProviders(items) { providers = items.filter(item => item.available); syncSourceButton() },
  selected() {
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
    hidden: false, documentElement: { dataset: {} }, hasFocus: () => true,
    getElementById(id) { if (!elements.has(id)) { const e = new Element(); e.focus = () => { document.activeElement = e }; elements.set(id, e) } return elements.get(id) },
    querySelector: () => video, querySelectorAll: () => [], createElement: () => {
      const e = new Element(); e.focus = () => { document.activeElement = e }; return e
    },
  })
  const window = Object.assign(new EventTarget(), { setInterval: () => 1, clearInterval() {}, scrollTo() {} })
  const api = {
    browser: false, connect: async () => {}, hostLocale: () => 'zh',
    call: (name, args = {}) => name === 'get_providers' && !service.catalog.sources
      ? Promise.resolve({ items: store.preferences().enabledProviders.map(id => ({ id, name: id === 'hongguo' ? '红果' : id === 'hghub' ? '黄果' : id, available: true, enabled: true, configurable: true })) })
      : service.call(panel, name, args),
  }
  const exports = {}, context = vm.createContext({
    module: { exports }, exports, document, window, navigator: {}, crypto: webcrypto,
    AbortController, DOMException, setTimeout, clearTimeout,
    require(name) {
      if (name === './api') return api
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
  ui.selected()
  ui.setProviders([{ id: 'hongguo', name: '红果', available: true }, { id: 'hghub', name: '黄果', available: true }])
  store.setPreferences({ enabledProviders: ['hongguo', 'hghub'] })
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
  assert.equal(f.ui.sourceState().source, 'hghub')
  assert.equal(control.dataset.source, 'hghub')
  assert.equal(control.getAttribute('aria-label'), '切换视频源')
  assert.equal(f.elements.get('sourceName').textContent, '黄果短剧')
  assert.equal(f.elements.get('sourceMenu').hidden, true)
  assert.equal(control.disabled, false)
  control.onclick(); await flush()
  assert.equal(f.ui.sourceState().source, 'hghub')
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
  f.store.setPreferences({ enabledProviders: ['hongguo', 'hghub', 'local'] })
  f.service.catalog = { list: async () => ({ items: [] }) }
  f.ui.setProviders([{ id: 'hongguo', name: '红果', available: true }, { id: 'hghub', name: '黄果', available: true },
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
test('a single available provider disables switching instead of opening an empty menu', t => {
  const f = setup(t)
  f.ui.setProviders([{ id: 'hongguo', name: '红果', available: true }, { id: 'hghub', name: '黄果', available: false }])
  const control = f.elements.get('source')
  assert.equal(control.disabled, true)
  control.onpointerenter({ pointerType: 'mouse' })
  control.onclick()
  assert.equal(f.elements.get('sourceMenu').hidden, true)
  assert.equal(f.ui.sourceState().source, 'hongguo')
})
test('the settings form enables Huangguo explicitly, then disabling it returns to Hongguo', async t => {
  const f = setup(t)
  f.store.setPreferences({ enabledProviders: ['hongguo'] })
  const sources = new ProviderRegistry(f.store.root, { builtins: ['hongguo', 'hghub'].map(id => ({
    manifest: { apiVersion: 1, id, name: id === 'hongguo' ? '红果' : '黄果', version: '1.0.0' },
    createProvider: () => ({ id, async listSeries() { return { items: [], cursor: null } },
      async getSeries() {}, async listEpisodes() { return { items: [], cursor: null } }, async getCover() {}, async resolvePlayback() {} }),
  })) })
  t.after(() => sources.dispose())
  f.service.catalog = new Catalog(f.store, { sources })
  await f.elements.get('prefs').onclick()
  let rows = f.elements.get('providerSettings').children
  assert.equal(rows[0].children[1].disabled, true)
  assert.equal(rows[1].children[1].checked, false)
  assert.equal(f.elements.get('source').disabled, true)
  rows[1].children[1].checked = true
  f.elements.get('settings').onsubmit({ preventDefault() {} }); await flush()
  assert.equal(sources.get('hghub').id, 'hghub')
  assert.equal(f.elements.get('source').disabled, false)
  await f.ui.changeSource('hghub')
  await f.elements.get('prefs').onclick()
  rows = f.elements.get('providerSettings').children
  rows[1].children[1].checked = false
  f.elements.get('settings').onsubmit({ preventDefault() {} }); await flush()
  assert.throws(() => sources.get('hghub'))
  assert.equal(f.ui.sourceState().source, 'hongguo')
  assert.equal(f.elements.get('source').disabled, true)
})

test('switching providers saves progress, stops playback and discards the old catalog response', async t => {
  const f = setup(t), old = Promise.withResolvers()
  f.service.catalog = { list: async options => options.source === 'hghub'
    ? { items: [{ id: 'hh-1', title: 'Yellow' }] } : old.promise }
  const initial = f.ui.list()
  await flush()
  await f.ui.changeSource('hghub')
  assert.equal(f.ui.sourceState().source, 'hghub')
  assert.deepEqual([...f.ui.sourceState().cards], ['hh-1'])
  assert.equal(f.ui.episodeId(), undefined)
  assert.equal(f.video.paused, true)
  assert.equal(f.store.history('hg-1', 'hg-11')[0].positionMs, 12000)
  old.resolve({ items: [{ id: 'hg-1', title: 'Late red' }] })
  await initial; await flush()
  assert.deepEqual([...f.ui.sourceState().cards], ['hh-1'])
  assert.equal(f.panel.source, 'hghub')
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
  await f.ui.changeSource('hghub')
  deferRed = false
  delayed.resolve({ items: [{ seriesId: 'hg-1', episodeId: 'hg-11', title: 'late', label: '1', positionMs: 1, durationMs: 10 }] })
  await history
  assert.equal(f.ui.sourceState().watched.length, 0)
  const other = f.service.panel(f.service.open({ threadId: 'C' }).panel)
  await f.service.call(other, 'set_source', { source: 'hongguo' })
  await f.poll()
  assert.equal(f.ui.sourceState().source, 'hghub')
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
  for (const volume of [0, -1, 1.01, NaN, Infinity]) await assert.rejects(f.settings({ volume }), /参数无效/)
})

test('playback and default-mute settings load and save through the player form', async t => {
  const f = setup(t)
  f.event('one'); await f.poll()
  await f.elements.get('prefs').onclick()
  assert.equal(f.elements.get('autoPauseOnFinish').checked, true)
  assert.equal(f.elements.get('autoPlayOnStart').checked, true)
  assert.equal(f.elements.get('defaultMuted').checked, true)
  f.elements.get('autoPauseOnFinish').checked = false
  f.elements.get('autoPlayOnStart').checked = false
  f.elements.get('defaultMuted').checked = false
  f.elements.get('settings').onsubmit({ preventDefault() {} })
  await flush()
  assert.equal(f.peer.preferences().autoPauseOnFinish, false)
  assert.equal(f.peer.preferences().autoPlayOnStart, false)
  assert.equal(f.peer.preferences().defaultMuted, false)
  assert.equal(f.elements.get('settings').hidden, true)
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
  f.elements.get('settings').onsubmit({ preventDefault() {} }); await flush()
  assert.equal(f.video.muted, false)
  assert.equal(f.video.plays, 1)
  f.elements.get('mute').onclick(); f.video.onvolumechange()
  await f.elements.get('prefs').onclick()
  f.elements.get('autoPrompt').checked = false
  f.elements.get('settings').onsubmit({ preventDefault() {} }); await flush()
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
  f.elements.get('settings').onsubmit({ preventDefault() {} }); await flush()
  await f.poll()
  assert.equal(f.video.muted, false)
  f.elements.get('mute').onclick(); f.video.onvolumechange()
  release(); await flush()
  assert.equal(f.video.muted, true)
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
