import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile, symlink, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { ProviderRegistry } from '../src/server/providers/registry.mjs'
import { qualify, parseId, matchesSeries } from '../src/server/sources/ids.mjs'
import { HongguoSource } from '../src/server/sources/hongguo.mjs'
import { HghubSource } from '../src/server/sources/hghub.mjs'
import { decodeCursor, sourceCall } from '../src/server/sources/contracts.mjs'
import { boundedResponse, responseBytes } from '../src/server/sources/network.mjs'
import { Store } from '../src/server/store.mjs'
import { Service } from '../src/server/service.mjs'
import { Catalog } from '../src/server/catalog.mjs'
import { DatabaseSync } from 'node:sqlite'

async function temporary(t) {
  const root = await mkdtemp(join(tmpdir(), 'hongguo-providers-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  return root
}
function adapter(id) {
  return { id, async listSeries() { return { items: [{ id: '1', title: id }], cursor: null } },
    async getSeries() { return { id: '1', title: id } },
    async listEpisodes() { return { items: [{ id: id === 'hghub' ? '1_1' : '1', number: 1, label: '1', playable: true }], cursor: null } },
    async getCover() { return null }, async resolvePlayback() { return { candidates: [] } } }
}
const pluginCode = `export function createProvider(context) {
  return { id: context.id, signal: context.signal,
    async listSeries() { return { items: [{ id: 'series/中文', title: 'Local show' }], cursor: null } },
    async getSeries(id) { return { id, title: 'Local show' } },
    async listEpisodes(id) { return { items: [{ id: 'ep/1', number: 1, label: 'First', playable: true }], cursor: null } },
    async getCover() { return null }, async resolvePlayback() { return { candidates: [] } },
    dispose() { this.disposed = true },
  }
}`
async function install(root, folder, patch = {}, code = pluginCode) {
  const dir = join(root, folder); await mkdir(dir, { recursive: true })
  await writeFile(join(dir, 'provider.json'), JSON.stringify({ apiVersion: 1, id: folder, name: 'Local provider', version: '1.0.0', entry: 'index.mjs', ...patch }))
  await writeFile(join(dir, 'index.mjs'), code)
  return dir
}
test('local providers load through the same contract, retain opaque IDs and dispose cleanly', async t => {
  const root = await temporary(t), directory = join(root, 'plugins'); await mkdir(directory)
  await install(directory, 'local')
  const registry = new ProviderRegistry(root, { directory }); await registry.ready
  const provider = registry.get('local')
  assert.equal(registry.list().filter(p => p.available).length, 3)
  assert.equal(registry.get('hongguo').id, 'hongguo')
  const store = new Store(join(root, 'data')); t.after(() => store.close())
  const catalog = new Catalog(store, { sources: registry }); catalog.ffmpeg = true
  const list = await catalog.list({ source: 'local', query: 'fixture' })
  assert.equal(parseId(list.items[0].id).id, 'series/中文')
  const episodes = await catalog.episodes({ seriesId: list.items[0].id })
  assert.equal(parseId(episodes.items[0].id, 'episode').id, 'ep/1')
  const service = new Service(store, catalog), panel = service.panel(service.open({ threadId: 'A' }).panel)
  await service.call(panel, 'set_source', { source: 'local' })
  await service.call(panel, 'get_episodes', { seriesId: list.items[0].id })
  await service.call(panel, 'save_progress', { seriesId: list.items[0].id, episodeId: episodes.items[0].id,
    title: 'Local show', label: 'First', positionMs: 1000, durationMs: 2000 })
  assert.equal((await service.call(panel, 'get_history', {})).items.length, 1)
  assert.equal(store.history().length, 0)
  await registry.dispose()
  assert.equal(provider.disposed, true); assert.equal(provider.signal.aborted, true)
})
test('invalid, duplicate, disabled, escaping and broken plugins leave both builtins operational', async t => {
  const root = await temporary(t), directory = join(root, 'plugins'); await mkdir(directory)
  await install(directory, 'bad-version', { apiVersion: 2 })
  await install(directory, 'duplicate', { id: 'hongguo' })
  await install(directory, 'disabled', { enabled: false }, 'throw Error("must not import")')
  await install(directory, 'escaping', { entry: '../outside.mjs' })
  await install(directory, 'broken', {}, 'export function createProvider(){throw Error("private diagnostic detail")}')
  await install(directory, 'incomplete', {}, 'export function createProvider(){return {id:"incomplete"}}')
  const linked = await install(directory, 'linked')
  await rm(join(linked, 'index.mjs')); await symlink(join(directory, 'broken/index.mjs'), join(linked, 'index.mjs'))
  const registry = new ProviderRegistry(root, { directory }); await registry.ready
  assert.deepEqual(registry.list().filter(p => p.available).map(p => p.id), ['hongguo', 'hghub'])
  assert.equal(registry.get('hongguo') instanceof HongguoSource, true)
  assert.equal(registry.get('hghub') instanceof HghubSource, true)
  assert.ok(!JSON.stringify(registry.list()).includes('private diagnostic'))
  assert.ok(!JSON.stringify(registry.list()).includes(root))
  await registry.dispose()
})
test('an unavailable local directory is isolated and a removed default falls back to Hongguo', async t => {
  const root = await temporary(t), registry = new ProviderRegistry(root, { directory: join(root, 'missing') })
  await registry.ready
  assert.equal(registry.fallback('removed'), 'hongguo')
  assert.equal(registry.get('hongguo').id, 'hongguo')
  assert.equal(registry.list().at(-1).code, 'DIRECTORY_UNAVAILABLE')
  await registry.dispose()
})
test('IDs preserve legacy Hongguo paths and isolate arbitrary plugin IDs on all platforms', () => {
  assert.equal(qualify('hongguo', '123'), 'hg-123')
  assert.equal(qualify('hghub', '117_3', 'episode'), 'hh-117_3')
  const id = qualify('local', 'a/b:中文', 'episode')
  assert.deepEqual(parseId(id, 'episode'), { source: 'local', id: 'a/b:中文' })
  assert.ok(!/[/:\\]/.test(id))
  assert.throws(() => parseId(id))
  assert.throws(() => parseId('p.hongguo.s.MQ'))
  assert.throws(() => qualify('local', 'x'.repeat(100), 'episode'))
  assert.equal(matchesSeries('hh-117', 'hh-118_1'), false)
  assert.equal(matchesSeries('hg-117', 'hh-117_1'), false)
})
for (const name of ['hongguo', 'hghub']) test(name + ' implements browsing, search and bound pagination', async t => {
  const provider = name === 'hongguo' ? new HongguoSource('/unused') : new HghubSource()
  const calls = []
  if (name === 'hongguo') t.mock.method(provider, 'sdkCall', async (method, arg, options) => {
    calls.push([method, arg, options])
    if (method === 'getSeries') return { id: arg, title: 'show', episode_count: 2 }
    if (method === 'listEpisodes') return { items: [{ id: options.cursor ? '12' : '11', number: 1 }], has_more: !options.cursor, cursor: 'next' }
    const page = (typeof arg === 'object' ? arg : options)?.cursor
    return { items: [{ id: page ? '2' : '1', title: 'show', episode_count: 2 }], has_more: !page, cursor: 'next' }
  })
  else t.mock.method(provider, 'sdk', async () => ({ base: 'https://huangguoai.com', setBase(value) { this.base = value },
    async feed({ page }) { calls.push(['feed', page]); return { items: [{ id: page, title: 'show', episodes: 2 }], pages: 2 } },
    async search(query, { page }) { calls.push(['search', page]); return { items: [{ id: page, title: query }], pages: 2 } },
    async getVideo(id) { calls.push(['detail', id]); return { id, title: 'show', episodeList: [1, 2].map(number => ({ number, playable: true })) } },
  }))
  const first = await provider.listSeries({ query: 'a', pageSize: 1 })
  const second = await provider.listSeries({ query: 'a', cursor: first.cursor, pageSize: 1 })
  assert.equal(first.items[0].id, '1'); assert.equal(second.items[0].id, '2'); assert.equal(second.cursor, null)
  await assert.rejects(provider.listSeries({ query: 'b', cursor: first.cursor }))
  assert.throws(() => decodeCursor(first.cursor, name === 'hongguo' ? 'hghub' : 'hongguo', 'list', 'a'))
  const ep = await provider.listEpisodes('1', { pageSize: 1 })
  const next = await provider.listEpisodes('1', { cursor: ep.cursor, pageSize: 1 })
  assert.equal(next.items.length, 1)
  await assert.rejects(provider.listEpisodes('2', { cursor: ep.cursor, pageSize: 1 }))
  if (name === 'hghub') assert.equal(calls.filter(c => c[0] === 'detail').length, 1)
})
test('Hghub does not load global profiles, rotates failed lines once and does not fan out 429', async t => {
  const provider = new HghubSource(), seen = []
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    assert.equal(options.headers.authorization, undefined)
    seen.push(url.hostname)
    return url.hostname === 'huangguoai.com' ? new Response('unavailable', { status: 503 })
      : new Response(JSON.stringify({ status: 1, data: { items: [{ id: 1, title: 'fixture' }], pagination: { pages: 1 } } }))
  })
  const page = await provider.listSeries({ pageSize: 1 })
  assert.equal(page.items.length, 1)
  assert.deepEqual([...new Set(seen)], ['huangguoai.com', 'huangguoai.ai'])
  assert.equal((await provider.sdk()).isLoggedIn, false)
  seen.length = 0
  t.mock.method(globalThis, 'fetch', async url => { seen.push(url.hostname); return new Response('{}', { status: 429 }) })
  await assert.rejects(provider.listSeries(), e => e.code === 'RATE_LIMITED')
  assert.equal(seen.length, 1)
})
test('network policies validate every redirect, preserve ranges and bound unknown-length bodies', async t => {
  let requests = 0
  t.mock.method(globalThis, 'fetch', async () => { requests++; return new Response('', { status: 302, headers: { location: 'https://blocked.invalid/a' } }) })
  await assert.rejects(boundedResponse('https://allowed.invalid/a', { allows: h => h === 'allowed.invalid', budget: 8 }))
  assert.equal(requests, 1)
  await assert.rejects(boundedResponse('https://allowed.invalid:443/a', { allows: () => false, budget: 8 }))
  t.mock.method(globalThis, 'fetch', async () => new Response('too long'))
  const result = await boundedResponse('https://allowed.invalid/a', { allows: h => h === 'allowed.invalid', budget: 2 })
  await assert.rejects(responseBytes(result.response.body, 2))
})
test('source changes preserve another panel, its history and fixed per-turn recommendations', async t => {
  const root = await temporary(t), store = new Store(root); t.after(() => store.close())
  const providers = new ProviderRegistry(root, { builtins: ['hongguo', 'hghub'].map(id => ({
    manifest: { apiVersion: 1, id, name: id, version: '1.0.0' }, createProvider: () => adapter(id),
  })) })
  t.after(() => providers.dispose())
  const catalog = new Catalog(store, { sources: providers }); catalog.ffmpeg = true
  const service = new Service(store, catalog)
  const a = service.panel(service.open({ threadId: 'A' }).panel), b = service.panel(service.open({ threadId: 'B' }).panel)
  const progress = { title: 'fixture', label: '1', positionMs: 500, durationMs: 1000 }
  store.save({ ...progress, seriesId: 'hg-1', episodeId: 'hg-1' })
  store.save({ ...progress, seriesId: 'hh-1', episodeId: 'hh-1_1' })
  await service.call(a, 'set_source', { source: 'hghub' })
  assert.equal(b.source, 'hongguo')
  assert.equal(service.panel(service.open({ threadId: 'C' }).panel).source, 'hghub')
  assert.equal((await service.call(a, 'get_history', {})).items[0].seriesId, 'hh-1')
  assert.equal((await service.call(b, 'get_history', {})).items[0].seriesId, 'hg-1')
  assert.equal(store.recommendationSource('A', 'turn', 'hongguo'), 'hongguo')
  assert.equal(store.recommendationSource('A', 'turn', 'hghub'), 'hongguo')
  await assert.rejects(service.call(a, 'save_progress', { ...progress, seriesId: 'hg-1', episodeId: 'hh-1_1' }))
  await assert.rejects(service.call(a, 'set_source', { source: 'not-installed' }))
})
test('a late episode response cannot restore grants after switching providers', async t => {
  const root = await temporary(t), store = new Store(root); t.after(() => store.close())
  const pending = Promise.withResolvers()
  const service = new Service(store, { episodes: () => pending.promise })
  const scope = service.panel(service.open({ threadId: 'A' }).panel)
  const loading = service.call(scope, 'get_episodes', { seriesId: 'hg-1' })
  const rejected = assert.rejects(loading, /选源已变更/)
  await service.call(scope, 'set_source', { source: 'hghub' })
  pending.resolve({ items: [{ id: 'hg-1', playable: true }] })
  await rejected
  assert.equal(scope.allowed?.size || 0, 0)
})

test('a version-one database keeps legacy Hongguo progress, preferences and recommendation titles', async t => {
  const root = await temporary(t), old = new DatabaseSync(join(root, 'player.sqlite'))
  old.exec(`CREATE TABLE watch_progress(series_id TEXT,episode_id TEXT,title TEXT,label TEXT,position_ms INTEGER,duration_ms INTEGER,updated_at INTEGER,PRIMARY KEY(series_id,episode_id));
    CREATE TABLE recommendation_feed(id INTEGER PRIMARY KEY CHECK(id=1),items TEXT,updated_at INTEGER);
    CREATE TABLE player_preferences(id INTEGER PRIMARY KEY,body TEXT); PRAGMA user_version=1;`)
  old.prepare('INSERT INTO watch_progress VALUES(?,?,?,?,?,?,?)').run('hg-1', 'hg-11', 'Legacy', '1', 12345, 60000, 123)
  old.prepare('INSERT INTO recommendation_feed VALUES(1,?,?)').run(JSON.stringify([{ id: 'hg-2', title: 'Existing recommendation' }]), Date.now())
  old.prepare('INSERT INTO player_preferences VALUES(1,?)').run(JSON.stringify({ autoPauseOnFinish: false, autoPlayOnStart: false,
    defaultMuted: false, volume: 0.43, searchTerms: ['保留'] }))
  old.close()
  const store = new Store(root)
  try {
    assert.equal(store.history()[0].positionMs, 12345)
    assert.equal(store.preferences().defaultSource, 'hongguo')
    assert.equal(store.preferences().autoPauseOnFinish, false)
    assert.equal(store.preferences().autoPlayOnStart, false)
    assert.equal(store.preferences().volume, 0.43)
    assert.deepEqual(store.waitingFeed(), [{ id: 'hg-2', title: 'Existing recommendation' }])
    store.saveWaitingFeed([{ id: 'hh-1', title: 'Other source' }], Date.now(), 'hghub')
    assert.equal(store.waitingFeed(false, 'hongguo')[0].id, 'hg-2')
    assert.equal(store.waitingFeed(false, 'hghub')[0].id, 'hh-1')
    assert.equal(store.db.prepare('PRAGMA user_version').get().user_version, 2)
  } finally { store.close() }
  const reopened = new Store(root)
  try { assert.equal(reopened.history()[0].positionMs, 12345) } finally { reopened.close() }
})
test('provider request timeout and cancellation reject without exposing provider exceptions', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const pending = sourceCall(() => new Promise(() => {}))
  const timeout = assert.rejects(pending, /片源请求超时/)
  t.mock.timers.tick(30000); await timeout
  const controller = new AbortController()
  const aborted = sourceCall(() => new Promise(() => {}), controller.signal)
  const cancellation = assert.rejects(aborted, /请求已取消/)
  controller.abort(); await cancellation
  await assert.rejects(sourceCall(() => { throw Error('private endpoint diagnostic') }), error => !error.message.includes('private'))
})
