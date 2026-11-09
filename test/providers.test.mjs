import test from 'node:test'
import { defer } from './cleanup.mjs'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile, symlink, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { ProviderRegistry } from '../src/server/providers/registry.mjs'
import { qualify, parseId, matchesSeries } from '../src/server/sources/ids.mjs'
import { HongguoSource } from '../src/server/sources/hongguo.mjs'
import { decodeCursor, sourceCall } from '../src/server/sources/contracts.mjs'
import { boundedResponse, responseBytes } from '../src/server/sources/network.mjs'
import { Store } from '../src/server/store.mjs'
import { Service } from '../src/server/service.mjs'
import { Catalog } from '../src/server/catalog.mjs'
import { DatabaseSync } from 'node:sqlite'

async function temporary(t) {
  const root = await mkdtemp(join(tmpdir(), 'hongguo-providers-'))
  defer(t, () => rm(root, { recursive: true, force: true }))
  return root
}
function adapter(id) {
  return { id, async listSeries() { return { items: [{ id: '1', title: id }], cursor: null } },
    async getSeries() { return { id: '1', title: id } },
    async listEpisodes() { return { items: [{ id: '1', number: 1, label: '1', playable: true }], cursor: null } },
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
function fixtures(create = id => adapter(id)) {
  return ['hongguo', 'demo'].map(id => ({
    manifest: { apiVersion: 1, id, name: id, version: '1.0.0' }, createProvider: context => create(id, context),
  }))
}
test('all discovered providers start by default and own their shutdown lifecycle', async t => {
  const root = await temporary(t), created = [], disposed = []
  const registry = new ProviderRegistry(root, { builtins: fixtures((id, context) => {
    created.push([id, context.signal]); return { ...adapter(id), dispose() { disposed.push(id) } }
  }) })
  await registry.ready; defer(t, () => registry.dispose())
  assert.deepEqual(created.map(([id]) => id), ['hongguo', 'demo'])
  assert.equal(registry.get('demo').id, 'demo')
  assert.equal(registry.list().find(p => p.id === 'demo').nsfw, false)
  await registry.dispose()
  assert.deepEqual(disposed.sort(), ['demo', 'hongguo'])
  assert.ok(created.every(([,signal]) => signal.aborted))
})
test('configured directories load local entries by default and isolate broken entries', async t => {
  const root = await temporary(t), directory = join(root, 'plugins'); await mkdir(directory)
  await install(directory, 'broken', {}, 'throw Error("entry failure detail")')
  await install(directory, 'disabled', { enabled: false }, 'throw Error("must not import")')
  const registry = new ProviderRegistry(root, { directory }); await registry.ready
  defer(t, () => registry.dispose())
  assert.equal(registry.list().find(p => p.id === 'broken').code, 'LOAD_FAILED')
  assert.equal(registry.list().find(p => p.id === 'disabled').code, 'DISABLED')
  assert.equal(registry.get('hongguo').id, 'hongguo')
  assert.ok(!JSON.stringify(registry.list()).includes('entry failure detail'))
})
test('legacy enable lists are ignored, selected sources persist and removed-source grants are revoked', async t => {
  const root = await temporary(t), store = new Store(root), peer = new Store(root)
  defer(t, () => { store.close(); peer.close() })
  store.db.prepare('INSERT OR REPLACE INTO player_preferences VALUES(1,?)').run(JSON.stringify({ enabledProviders: ['hongguo'] }))
  const make = database => {
    const sources = new ProviderRegistry(root, { builtins: fixtures() }); defer(t, () => sources.dispose())
    const catalog = new Catalog(database, { sources }); catalog.ffmpeg = true
    const service = new Service(database, catalog), scope = service.panel(service.open({ threadId: 'A' }).panel)
    return { sources, catalog, service, scope }
  }
  const a = make(store), b = make(peer)
  assert.deepEqual((await a.service.call(a.scope, 'get_providers', {})).items.filter(p => p.available).map(p => p.id), ['hongguo', 'demo'])
  await assert.rejects(a.service.call(a.scope, 'set_preferences', { enabledProviders: ['hongguo'] }))
  await b.service.call(b.scope, 'set_source', { source: 'demo' })
  await b.service.call(b.scope, 'get_episodes', { seriesId: 'p.demo.s.MQ' })
  b.scope.grants = new Set(['p.demo.e.MQ']); b.scope.streams = new Map([['p.demo.e.MQ', 'old']]); b.scope.playing = 'p.demo.e.MQ'
  b.scope.selection = { seriesId: 'p.demo.s.MQ', episodeId: 'p.demo.e.MQ' }
  b.scope.waiting = { selected: { id: 'p.demo.s.MQ', title: 'Old pick' } }
  await b.service.call(b.scope, 'save_progress', { seriesId: 'p.demo.s.MQ', episodeId: 'p.demo.e.MQ', title: 'Kept', label: '1', positionMs: 1234, durationMs: 5000 })
  const restarted = make(peer); await restarted.sources.ready
  assert.equal(restarted.scope.source, 'demo')
  b.sources.adapters.delete('demo')
  await b.service.call(b.scope, 'get_providers', {})
  assert.equal(b.scope.source, 'hongguo'); assert.equal(b.scope.allowed.size, 0)
  assert.equal(b.scope.grants.size, 0); assert.equal(b.scope.streams.size, 0)
  assert.equal(b.scope.selection, undefined); assert.equal(b.scope.waiting.selected, null)
  assert.equal((await b.service.call(b.scope, 'get_preferences', {})).defaultSource, 'hongguo')
  await assert.rejects(b.service.call(b.scope, 'get_episodes', { seriesId: 'p.demo.s.MQ' }))
  assert.equal(peer.history(undefined, undefined, 30, 'demo')[0].positionMs, 1234)
  assert.equal('enabledProviders' in peer.preferences(), false)
})
test('NSFW switching requires explicit confirmation each time and never becomes an automatic default', async t => {
  const root = await temporary(t), store = new Store(root); defer(t, () => store.close())
  const sources = new ProviderRegistry(root, { builtins: fixtures().map(plugin => ({ ...plugin,
    manifest: { ...plugin.manifest, nsfw: plugin.manifest.id === 'demo' } })) })
  defer(t, () => sources.dispose())
  const catalog = new Catalog(store, { sources }), service = new Service(store, catalog)
  const scope = service.panel(service.open({ threadId: 'A' }).panel)
  scope.allowed = new Set(['hg-1']); scope.playing = 'hg-1'
  await assert.rejects(service.call(scope, 'set_source', { source: 'demo' }), /NSFW/)
  await assert.rejects(service.call(scope, 'set_source', { source: 'demo', confirmNsfw: false }))
  assert.equal(scope.source, 'hongguo'); assert.equal(scope.playing, 'hg-1')
  assert.ok(scope.allowed.has('hg-1')); assert.equal(store.preferences().defaultSource, 'hongguo')
  store.event({ session_id: 'A', turn_id: 'nsfw-turn', hook_event_name: 'UserPromptSubmit' })
  store.db.prepare('INSERT INTO turn_picks VALUES(?,?,?,?,?)').run('A', 'nsfw-turn', JSON.stringify([{ id: 'p.demo.s.MQ', title: 'Sensitive fixture' }]), null, 1)
  assert.deepEqual((await service.waitingPicks('A', 'nsfw-turn', true, () => true, 'hongguo')).items, [])
  scope.waiting = { turnId: 'nsfw-turn', selected: null }
  await assert.rejects(service.call(scope, 'select_waiting_pick', { seriesId: 'p.demo.s.MQ' }), /NSFW/)
  await assert.rejects(service.call(scope, 'create_browser_pairing', { follow: false, seriesId: 'p.demo.s.MQ', episodeId: 'p.demo.e.MQ' }), /NSFW/)
  assert.equal(scope.source, 'hongguo'); assert.equal(scope.waiting.selected, null)
  await service.call(scope, 'set_source', { source: 'demo', confirmNsfw: true })
  assert.equal(scope.source, 'demo'); assert.equal(store.preferences().defaultSource, 'demo')
  assert.equal((await service.waitingPicks('A', 'nsfw-turn', true, () => true, scope.source)).items.length, 1)
  assert.equal(service.open({ threadId: 'B' }).source, 'hongguo')
  assert.equal((await service.call(scope, 'get_preferences', {})).defaultSource, 'hongguo')
  await service.call(scope, 'set_source', { source: 'hongguo' })
  await assert.rejects(service.call(scope, 'set_source', { source: 'demo' }), /NSFW/)
  assert.equal(scope.source, 'hongguo')
})
test('invalid NSFW metadata rejects a local plugin before its entry runs', async t => {
  const root = await temporary(t), directory = join(root, 'plugins'); await mkdir(directory)
  await install(directory, 'bad-nsfw', { nsfw: 'false' }, 'throw Error("must not import")')
  const registry = new ProviderRegistry(root, { directory }); await registry.ready; defer(t, () => registry.dispose())
  assert.throws(() => registry.get('bad-nsfw'))
  assert.ok(registry.list().some(p => p.code === 'LOAD_FAILED'))
  assert.equal(registry.list().find(p => p.id === 'hongguo').nsfw, false)
  assert.equal(registry.list().find(p => p.id === 'bilibili').nsfw, false)
})

test('version 3 preference migration removes the old enable list and preserves source, preferences and progress', async t => {
  const root = await temporary(t)
  let store = new Store(root)
  store.setPreferences({ defaultSource: 'bilibili', volume: 0.43, coverStyle: 'minutes' })
  store.save({ seriesId: 'hg-1', episodeId: 'hg-11', title: 'Kept', label: '1', positionMs: 1234, durationMs: 5000 })
  const preferences = store.preferences(), history = store.history()
  store.db.prepare('UPDATE player_preferences SET body=? WHERE id=1').run(JSON.stringify({ ...preferences, enabledProviders: ['hongguo'] }))
  store.db.exec('PRAGMA user_version=3'); store.close()
  store = new Store(root); defer(t, () => store.close())
  assert.equal(store.db.prepare('PRAGMA user_version').get().user_version, 4)
  assert.deepEqual(store.preferences(), preferences)
  assert.deepEqual(store.history(), history)
  assert.equal('enabledProviders' in JSON.parse(store.db.prepare('SELECT body FROM player_preferences WHERE id=1').get().body), false)
})
test('local providers load through the same contract, retain opaque IDs and dispose cleanly', async t => {
  const root = await temporary(t), directory = join(root, 'plugins'); await mkdir(directory)
  await install(directory, 'local')
  const registry = new ProviderRegistry(root, { directory }); await registry.ready
  const provider = registry.get('local')
  assert.equal(registry.list().filter(p => p.available).length, 3)
  assert.equal(registry.get('hongguo').id, 'hongguo')
  const store = new Store(join(root, 'data')); defer(t, () => store.close())
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
test('invalid, duplicate, disabled, escaping and broken plugins leave Hongguo operational', async t => {
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
  assert.deepEqual(registry.list().filter(p => p.available).map(p => p.id), ['hongguo', 'bilibili'])
  assert.equal(registry.get('hongguo') instanceof HongguoSource, true)
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
test('removed sources cannot reopen through saved defaults or stale recommendations', async t => {
  const root = await temporary(t), store = new Store(root); defer(t, () => store.close())
  store.setPreferences({ defaultSource: 'removed' })
  const catalog = new Catalog(store), service = new Service(store, catalog)
  defer(t, () => catalog.sources.dispose())
  const scope = service.panel(service.open({ threadId: 'A' }).panel)
  assert.equal(scope.source, 'hongguo')
  assert.equal((await service.call(scope, 'get_preferences', {})).defaultSource, 'hongguo')
  assert.equal((await service.call(scope, 'set_preferences', { volume: 0.42 })).defaultSource, 'hongguo')
  scope.source = 'removed'; scope.selection = { seriesId: 'hh-1' }; scope.waiting = { selected: { id: 'hh-1' } }
  assert.deepEqual((await service.call(scope, 'get_providers', {})).items.map(row => row.id), ['hongguo', 'bilibili'])
  assert.equal(scope.source, 'hongguo'); assert.equal(scope.selection, undefined); assert.equal(scope.waiting.selected, null)
  await assert.rejects(service.call(scope, 'set_source', { source: 'removed' }))
  store.db.prepare('INSERT INTO turn_picks VALUES(?,?,?,?,?)').run('A', 'old', JSON.stringify([{ id: 'hh-1', title: 'Removed' }]), null, 1)
  assert.deepEqual((await service.waitingPicks('A', 'old', true, () => true)).items, [])
  assert.throws(() => parseId('hh-1'))
})
test('IDs preserve legacy Hongguo paths and isolate arbitrary plugin IDs on all platforms', () => {
  assert.equal(qualify('hongguo', '123'), 'hg-123')
  const id = qualify('local', 'a/b:中文', 'episode')
  assert.deepEqual(parseId(id, 'episode'), { source: 'local', id: 'a/b:中文' })
  assert.ok(!/[/:\\]/.test(id))
  assert.throws(() => parseId(id))
  assert.throws(() => parseId('p.hongguo.s.MQ'))
  assert.throws(() => qualify('local', 'x'.repeat(100), 'episode'))
  assert.equal(matchesSeries('hg-117', qualify('local', '117', 'episode')), false)
})
test('Hongguo implements browsing, search and bound pagination', async t => {
  const provider = new HongguoSource('/unused')
  t.mock.method(provider, 'sdkCall', async (method, arg, options) => {
    if (method === 'getSeries') return { id: arg, title: 'show', episode_count: 2 }
    if (method === 'listEpisodes') return { items: [{ id: options.cursor ? '12' : '11', number: 1 }], has_more: !options.cursor, cursor: 'next' }
    const page = (typeof arg === 'object' ? arg : options)?.cursor
    return { items: [{ id: page ? '2' : '1', title: 'show', episode_count: 2 }], has_more: !page, cursor: 'next' }
  })
  const first = await provider.listSeries({ query: 'a', pageSize: 1 })
  const second = await provider.listSeries({ query: 'a', cursor: first.cursor, pageSize: 1 })
  assert.equal(first.items[0].id, '1'); assert.equal(second.items[0].id, '2'); assert.equal(second.cursor, null)
  await assert.rejects(provider.listSeries({ query: 'b', cursor: first.cursor }))
  assert.throws(() => decodeCursor(first.cursor, 'local', 'list', 'a'))
  const ep = await provider.listEpisodes('1', { pageSize: 1 })
  const next = await provider.listEpisodes('1', { cursor: ep.cursor, pageSize: 1 })
  assert.equal(next.items.length, 1)
  await assert.rejects(provider.listEpisodes('2', { cursor: ep.cursor, pageSize: 1 }))
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
  const root = await temporary(t), store = new Store(root); defer(t, () => store.close())
  const providers = new ProviderRegistry(root, { builtins: ['hongguo', 'demo'].map(id => ({
    manifest: { apiVersion: 1, id, name: id, version: '1.0.0' }, createProvider: () => adapter(id),
  })) })
  defer(t, () => providers.dispose())
  const catalog = new Catalog(store, { sources: providers }); catalog.ffmpeg = true
  const service = new Service(store, catalog)
  const a = service.panel(service.open({ threadId: 'A' }).panel), b = service.panel(service.open({ threadId: 'B' }).panel)
  const progress = { title: 'fixture', label: '1', positionMs: 500, durationMs: 1000 }
  store.save({ ...progress, seriesId: 'hg-1', episodeId: 'hg-1' })
  store.save({ ...progress, seriesId: 'p.demo.s.MQ', episodeId: 'p.demo.e.MQ' })
  await service.call(a, 'set_source', { source: 'demo' })
  assert.equal(b.source, 'hongguo')
  assert.equal(service.panel(service.open({ threadId: 'C' }).panel).source, 'demo')
  assert.equal((await service.call(a, 'get_history', {})).items[0].seriesId, 'p.demo.s.MQ')
  assert.equal((await service.call(b, 'get_history', {})).items[0].seriesId, 'hg-1')
  assert.equal(store.recommendationSource('A', 'turn', 'hongguo'), 'hongguo')
  assert.equal(store.recommendationSource('A', 'turn', 'demo'), 'hongguo')
  await assert.rejects(service.call(a, 'save_progress', { ...progress, seriesId: 'hg-1', episodeId: 'p.demo.e.MQ' }))
  await assert.rejects(service.call(a, 'set_source', { source: 'not-installed' }))
})
test('a late episode response cannot restore grants after switching providers', async t => {
  const root = await temporary(t), store = new Store(root); defer(t, () => store.close())
  const pending = Promise.withResolvers()
  const service = new Service(store, { episodes: () => pending.promise })
  const scope = service.panel(service.open({ threadId: 'A' }).panel)
  const loading = service.call(scope, 'get_episodes', { seriesId: 'hg-1' })
  const rejected = assert.rejects(loading, /选源已变更/)
  await service.call(scope, 'set_source', { source: 'demo' })
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
    store.saveWaitingFeed([{ id: 'p.demo.s.MQ', title: 'Other source' }], Date.now(), 'demo')
    assert.equal(store.waitingFeed(false, 'hongguo')[0].id, 'hg-2')
    assert.equal(store.waitingFeed(false, 'demo')[0].id, 'p.demo.s.MQ')
    assert.equal(store.db.prepare('PRAGMA user_version').get().user_version, 4)
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

for (const branch of ['main', 'provider']) test(`version-two ${branch} database receives both migrations without losing saved state`, async t => {
  const root = await temporary(t)
  let store = new Store(root)
  const feed = [{ id: 'hg-3', title: 'Legacy recommendation' }]
  store.saveWaitingFeed(feed)
  store.save({ seriesId: 'hg-3', episodeId: 'hg-31', title: 'Legacy', label: '1', positionMs: 13000, durationMs: 60000 })
  store.setPreferences({ volume: 0.43, hoverDecoyEnabled: true, coverStyle: 'minutes', defaultSource: 'demo' })
  store.saveWaitingFeed([{ id: 'p.demo.s.MQ', title: 'Plugin recommendation' }], Date.now(), 'demo')
  const history = store.history()
  if (branch === 'main') {
    const { defaultSource, ...legacy } = store.preferences()
    store.db.prepare('UPDATE player_preferences SET body=? WHERE id=1').run(JSON.stringify(legacy))
    store.db.exec('DROP TABLE source_recommendation_feed; DROP TABLE recommendation_source;')
  }
  const preferences = store.preferences()
  if (branch === 'provider') store.db.prepare('UPDATE player_preferences SET body=? WHERE id=1').run(JSON.stringify({ ...preferences, decoyUrl: 'https://example.org/obsolete', decoyFrameUrl: 'https://example.org/frame' }))
  store.db.exec('PRAGMA user_version=2')
  store.close()
  for (let i = 0; i < 2; i++) {
    store = new Store(root)
    assert.equal(store.db.prepare('PRAGMA user_version').get().user_version, 4)
    assert.deepEqual(store.preferences(), preferences)
    assert.deepEqual(store.history(), history)
    assert.deepEqual(store.waitingFeed(), feed)
    assert.deepEqual(JSON.parse(store.db.prepare("SELECT items FROM source_recommendation_feed WHERE source='hongguo'").get().items), feed)
    if (branch === 'provider') assert.equal(store.waitingFeed(false, 'demo')[0].id, 'p.demo.s.MQ')
    else assert.deepEqual(store.waitingFeed(false, 'demo'), [])
    assert.equal('decoyUrl' in JSON.parse(store.db.prepare('SELECT body FROM player_preferences').get().body), false)
    store.close()
  }
})
