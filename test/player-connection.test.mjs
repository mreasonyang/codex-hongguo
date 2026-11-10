import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import vm from 'node:vm'
import { transformSync } from 'esbuild'

const code = transformSync(readFileSync(new URL('../src/ui/api.ts', import.meta.url), 'utf8'), {
  loader: 'ts', format: 'cjs',
}).code
function fixture(browser = false) {
  const calls = [], requests = []
  let instance, result = { _meta: { panel: 'synthetic-new-panel' }, structuredContent: { identified: true, source: 'bilibili' } }
  let response = { ok: true, json: async () => ({ identified: true, source: 'hongguo' }) }
  class App {
    constructor() { instance = this }
    connect() { return Promise.resolve() }
    getHostContext() { return {} }
    async callServerTool(input) { calls.push(input); return result }
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
  return { api: scope.module.exports, calls, requests, app: instance,
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
