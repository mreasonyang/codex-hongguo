import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import vm from 'node:vm'
import { transformSync } from 'esbuild'

const code = transformSync(readFileSync(new URL('../src/ui/api.ts', import.meta.url), 'utf8'), {
  loader: 'ts', format: 'cjs',
}).code
function fixture(browser = false, host = { name: 'chatgpt', platform: 'desktop' }) {
  const calls = [], requests = []
  let instance, failure, handler, result = { _meta: { panel: 'synthetic-new-panel' }, structuredContent: { identified: true, source: 'bilibili' } }
  let response = { ok: true, json: async () => ({ identified: true, source: 'hongguo' }) }
  class App {
    constructor() { instance = this }
    connect() { return Promise.resolve() }
    getHostVersion() { return host.name ? { name: host.name, version: 'synthetic' } : undefined }
    getHostContext() { return { platform: host.platform } }
    async callServerTool(input) { calls.push(input); if (failure) throw failure; return handler ? handler(input) : result }
    async sendSizeChanged(size) { requests.push(size) }
    async requestDisplayMode(mode) { requests.push(mode); return mode }
  }
  const exports = {}, scope = vm.createContext({
    exports, module: { exports }, Error, AbortSignal, navigator: { language: 'zh-CN' },
    document: { documentElement: { dataset: { host: browser ? 'browser' : 'panel', surface: 'player' } } },
    fetch: async (...args) => { requests.push(args); return response },
    require(name) {
      if (name === '@modelcontextprotocol/ext-apps') return { App }
      if (name === '../../package.json') return { version: 'synthetic' }
      return {}
    },
  })
  vm.runInContext(code, scope)
  return { api: scope.module.exports, calls, requests, app: instance, error(value) { failure = value },
    result(value) { result = value }, response(value) { response = value }, handler(value) { handler = value } }
}

test('reconnecting obtains a new panel through the host tool and uses it for later calls', async () => {
  const f = fixture()
  let original
  await f.api.connect(context => { original = context }, async () => {}, () => {})
  f.app.ontoolresult({ _meta: { panel: 'synthetic-old-panel' }, structuredContent: { identified: true, source: 'hongguo' } })
  assert.equal(original.source, 'hongguo')
  const context = await f.api.reopenPanel()
  assert.equal(context.source, 'bilibili')
  assert.equal(f.calls[0].name, 'open_drama_panel')
  assert.deepEqual(Object.keys(f.calls[0].arguments), [], 'renewal must not reuse the expired panel')
  await f.api.call('get_preferences')
  assert.equal(f.calls[1].arguments.panel, 'synthetic-new-panel')
})

test('third-party, web and unidentified hosts cannot start player requests, even from tool-result callbacks', async () => {
  for (const host of [{ name: 'T3 Code', platform: 'desktop' }, { name: 'paseo', platform: 'desktop' },
    { name: 'chatgpt', platform: 'web' }, { name: 'chatgpt' }, { name: 'Antigravity', platform: 'desktop' },
    { name: 'Antigravity' }, {}]) {
    const f = fixture(false, host)
    let ready = 0, modes = 0
    await assert.rejects(f.api.connect(() => ready++, async () => {}, () => modes++), /仅在官方 Codex App/)
    f.app.ontoolresult({ _meta: { panel: 'synthetic-third-party-panel' } })
    f.app.onhostcontextchanged({ displayMode: 'inline' })
    await assert.rejects(f.api.reopenPanel(), /仅在官方 Codex App/)
    await assert.rejects(f.api.call('get_waiting_status'), /仅在官方 Codex App/)
    await assert.rejects(f.api.requestPlayerTab(), /仅在官方 Codex App/)
    assert.equal(ready, 0)
    assert.equal(modes, 0)
    assert.equal(f.calls.length, 0)
  }
})

test('a declined app tool is not sent to the host again until a new panel is opened', async () => {
  const f = fixture()
  await f.api.reopenPanel()
  f.error(new Error('MCP error -32000: Declined by the user.'))
  await assert.rejects(f.api.call('save_progress'), error => f.api.isToolAuthorizationDenied(error))
  f.error(undefined)
  const calls = f.calls.length
  for (let i = 0; i < 3; i++) await assert.rejects(f.api.call('save_progress'), /已取消授权/)
  assert.equal(f.calls.length, calls, 'background retries must not open another approval dialog')
  await f.api.call('get_run_state')
  assert.equal(f.calls.at(-1).name, 'get_run_state', 'a refusal must not block unrelated tools')
  f.result({ _meta: { panel: 'synthetic-reopened-panel' } })
  await f.api.reopenPanel()
  await f.api.call('save_progress')
  assert.equal(f.calls.at(-1).arguments.panel, 'synthetic-reopened-panel')
})

test('ordinary connection failures remain retryable', async () => {
  const f = fixture()
  await f.api.reopenPanel()
  f.error(new Error('Connection closed'))
  await assert.rejects(f.api.call('get_run_state'), /Connection closed/)
  f.error(undefined)
  await f.api.call('get_run_state')
  assert.equal(f.calls.filter(call => call.name === 'get_run_state').length, 2)
})

test('failed or malformed renewal cannot replace a valid connection', async () => {
  const f = fixture()
  await f.api.reopenPanel()
  for (const result of [{ isError: true }, { _meta: {} }, { _meta: { panel: '' } }]) {
    f.result(result)
    await assert.rejects(f.api.reopenPanel())
    f.result({ _meta: { data: {} } })
    await f.api.call('get_preferences')
    assert.equal(f.calls.at(-1).arguments.panel, 'synthetic-new-panel')
  }
})

test('browser recovery rechecks its existing context without creating another session', async () => {
  const f = fixture(true)
  assert.equal((await f.api.reopenPanel()).source, 'hongguo')
  assert.equal(f.requests[0][0], 'context')
  assert.equal(f.calls.length, 0)
  f.response({ ok: false })
  await assert.rejects(f.api.reopenPanel(), /分屏已失效/)
})

const flush = async () => { for (let i = 0; i < 30; i++) await Promise.resolve() }
test('Codex keeps its direct request path, full concurrency and native player mode', async () => {
  const f = fixture()
  await f.api.reopenPanel()
  const releases = []
  f.handler(() => new Promise(resolve => releases.push(() => resolve({ _meta: { data: {} } }))))
  const requests = Array.from({ length: 10 }, () => f.api.call('read_panel_chunk'))
  assert.equal(f.calls.length, 11, 'Codex dispatch stays synchronous and does not enter the Antigravity queue')
  assert.equal(releases.length, 10)
  releases.forEach(release => release())
  await Promise.all(requests)
  await f.api.requestPlayerTab()
  assert.equal(f.requests.at(-1).mode, 'fullscreen')
  assert.equal(f.requests.at(-1).height, undefined)
})
test('Antigravity expands recommendations locally without requesting an unsupported display mode', async () => {
  const f = fixture(false, { name: 'Antigravity', platform: 'web' })
  let modes = 0
  await f.api.connect(() => {}, async () => {}, () => modes++)
  await f.api.reopenPanel()
  await f.api.call('get_preferences')
  await f.api.requestPlayerTab()
  assert.equal(f.api.displayMode(), 'fullscreen')
  assert.equal(modes, 2)
  assert.equal(f.requests.at(-1).height, 760)
})
test('Antigravity caps calls at four and prioritizes progress over queued media', async () => {
  const f = fixture(false, { name: 'Antigravity', platform: 'web' })
  await f.api.reopenPanel()
  const releases = []
  let active = 0, max = 0
  f.handler(() => new Promise(resolve => {
    active++; max = Math.max(active, max)
    releases.push(() => { active--; resolve({ _meta: { data: {} } }) })
  }))
  const media = Array.from({ length: 8 }, () => f.api.call('read_panel_chunk'))
  const progress = f.api.call('save_progress')
  await flush()
  assert.equal(active, 4)
  releases.shift()(); await flush()
  assert.equal(f.calls.at(-1).name, 'save_progress')
  while (releases.length) { releases.shift()(); await flush() }
  await Promise.all([...media, progress])
  assert.equal(max, 4)
})
test('queued requests from a replaced Antigravity panel never reach the host', async () => {
  const f = fixture(false, { name: 'Antigravity', platform: 'web' })
  await f.api.connect(() => {}, async () => {}, () => {})
  await f.api.reopenPanel()
  const releases = []
  f.handler(() => new Promise(resolve => releases.push(() => resolve({ _meta: { data: {} } }))))
  const calls = Array.from({ length: 5 }, () => f.api.call('get_cover'))
  const done = Promise.allSettled(calls)
  await flush()
  f.app.ontoolresult({ _meta: { panel: 'replacement' } })
  while (releases.length) { releases.shift()(); await flush() }
  const results = await done
  assert.equal(results[4].status, 'rejected')
  assert.equal(f.calls.filter(c => c.name === 'get_cover').length, 4)
})
