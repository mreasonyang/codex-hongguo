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

class Element extends EventTarget {
  hidden = true; checked = false; value = '1'; dataset = {}; children = []; textContent = ''
  classList = { toggle() {}, add() {}, remove() {}, contains() { return false } }
  style = { setProperty() {} }
  setAttribute() {}
  replaceChildren(...children) { this.children = children }
  append(...children) { this.children.push(...children) }
  querySelectorAll() { return [] }
}
class Video extends Element {
  paused = true; ended = false; duration = 60; currentTime = 12; plays = 0
  pause() { this.paused = true; this.onpause?.() }
  async play() { this.plays++; this.paused = false; this.onplay?.(); this.onplaying?.() }
}
// Export controls only in the test copy. The production poll, settings handlers,
// start and pause paths run unchanged against a real Service and SQLite store.
const source = readFileSync(new URL('../src/ui/player.ts', import.meta.url), 'utf8') + `
export const fixture = {
  poll, pause, suspend,
  selected() {
    context = { identified: true }; pageActive = playerReady = loaded = true;
    series = { id: 'hg-1', title: 'Test' };
    episode = { id: 'hg-11', label: '1', number: 1, codec: 'h264', playable: true };
    episodes = [episode];
  },
  clearSelection() { series = null; episode = null },
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
    getElementById(id) { if (!elements.has(id)) elements.set(id, new Element()); return elements.get(id) },
    querySelector: () => video, querySelectorAll: () => [], createElement: () => new Element(),
  })
  const window = Object.assign(new EventTarget(), { setInterval: () => 1, clearInterval() {} })
  const api = {
    browser: false, connect: async () => {}, hostLocale: () => 'zh',
    call: (name, args = {}) => service.call(panel, name, args),
  }
  const exports = {}, context = vm.createContext({
    module: { exports }, exports, document, window, navigator: {}, crypto: webcrypto,
    AbortController, DOMException, setTimeout, clearTimeout,
    require(name) {
      if (name === './api') return api
      if (name === './locale') return { tr: value => value }
      if (name === './playback-turn') return turnHelpers
      if (name === './ui-kit') return { setIcon() {}, fill() {}, icon: () => new Element() }
      return {}
    },
  })
  vm.runInContext(code, context)
  const ui = context.module.exports.fixture
  ui.selected()
  let at = Date.now()
  return {
    store, peer, service, panel, video, document, ui, elements,
    event(turn, kind = 'UserPromptSubmit', session = 'A') {
      peer.event({ session_id: session, turn_id: turn, hook_event_name: kind }, ++at)
    },
    async poll() { await ui.poll(); await flush() },
    settings: patch => other.call(otherPanel, 'set_preferences', patch),
  }
}
const turnHelpers = await import('../src/ui/playback-turn.ts')

test('global playback switches default for older settings, synchronize across chats and survive restart', async t => {
  const f = setup(t)
  f.store.preferences()
  f.store.db.prepare('INSERT OR REPLACE INTO player_preferences VALUES(1,?)').run(JSON.stringify({ autoPrompt: false }))
  assert.equal(f.peer.preferences().autoPauseOnFinish, true)
  assert.equal(f.peer.preferences().autoPlayOnStart, false)
  await f.settings({ autoPauseOnFinish: false, autoPlayOnStart: true })
  const snapshot = await f.service.call(f.panel, 'get_run_state', { observeSession: true })
  assert.equal(snapshot.preferences.autoPauseOnFinish, false)
  assert.equal(snapshot.preferences.autoPlayOnStart, true)
  const reopened = new Store(f.store.root)
  try {
    assert.equal(reopened.preferences().autoPauseOnFinish, false)
    assert.equal(reopened.preferences().autoPlayOnStart, true)
    assert.equal(reopened.preferences().autoPrompt, false)
  } finally { reopened.close() }
  await assert.rejects(f.settings({ autoPlayOnStart: 'yes' }), /参数无效/)
})

test('the two settings controls load and save through the player form', async t => {
  const f = setup(t)
  f.event('one'); await f.poll()
  f.elements.get('prefs').onclick()
  assert.equal(f.elements.get('autoPauseOnFinish').checked, true)
  assert.equal(f.elements.get('autoPlayOnStart').checked, false)
  f.elements.get('autoPauseOnFinish').checked = false
  f.elements.get('autoPlayOnStart').checked = true
  f.elements.get('settings').onsubmit({ preventDefault() {} })
  await flush()
  assert.equal(f.peer.preferences().autoPauseOnFinish, false)
  assert.equal(f.peer.preferences().autoPlayOnStart, true)
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
