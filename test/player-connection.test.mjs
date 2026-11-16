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
  let instance, failure, result = { _meta: { panel: 'synthetic-new-panel' }, structuredContent: { identified: true, source: 'bilibili' } }
  let response = { ok: true, json: async () => ({ identified: true, source: 'hongguo' }) }
  class App {
    constructor() { instance = this }
    connect() { return Promise.resolve() }
    getHostVersion() { return host.name ? { name: host.name, version: 'synthetic' } : undefined }
    getHostContext() { return { platform: host.platform } }
    async callServerTool(input) { calls.push(input); if (failure) throw failure; return result }
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
    result(value) { result = value }, response(value) { response = value } }
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
    { name: 'chatgpt', platform: 'web' }, { name: 'chatgpt' }, {}]) {
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
