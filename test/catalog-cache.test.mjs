import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fork } from 'node:child_process'
import { once } from 'node:events'
import { Store } from '../src/server/store.mjs'
import { Catalog } from '../src/server/catalog.mjs'
import { SharedCatalogCache, catalogTtl } from '../src/server/catalog-cache.mjs'
import { stopChild } from '../src/runtime/executables.mjs'

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'hongguo-catalog-cache-'))
  const store = new Store(root), peer = new Store(root)
  t.after(() => { store.close(); peer.close(); rmSync(root, { force: true, recursive: true }) })
  return { root, store, peer }
}
const tick = () => new Promise(resolve => setTimeout(resolve, 15))

// Three cold Node startups need headroom on hosted Windows runners under load.
test('cold loads from independent Node processes share one refresh and survive another process restart', { timeout: 30000 }, async t => {
  const workers = [], requests = []
  async function worker() {
    const child = fork(new URL('./fixtures/catalog-cache-worker.mjs', import.meta.url), [], { stdio: ['ignore','ignore','ignore','ipc'] })
    workers.push(child)
    child.on('message', message => { if (message.type === 'request') requests.push(child) })
    const ready = once(child, 'message')
    child.send({ type: 'init', root, options: { poll: 15, wait: 10000 } })
    assert.equal((await ready)[0].type, 'ready')
    return child
  }
  // Register before the fixture cleanup so Windows has closed the SQLite handles first.
  t.after(async () => {
    await Promise.all(workers.map(async child => {
      if (child.exitCode !== null || child.signalCode !== null) return
      const ended = once(child, 'exit')
      stopChild(child)
      await ended
    }))
  })
  const { root } = fixture(t)
  const a = await worker(), b = await worker()
  const result = child => new Promise(resolve => {
    const listener = message => { if (message.type === 'result' || message.type === 'failed') { child.off('message', listener); resolve(message) } }
    child.on('message', listener)
  })
  const first = result(a), second = result(b)
  a.send({ type: 'get', key: 'episodes:shared' }); b.send({ type: 'get', key: 'episodes:shared' })
  while (!requests.length) await tick()
  await new Promise(resolve => setTimeout(resolve, 80))
  assert.equal(requests.length, 1)
  requests[0].send({ type: 'finish', value: { items: [{ id: 'hg-11' }], cursor: null } })
  assert.deepEqual(await first, await second)
  const c = await worker(), third = result(c)
  c.send({ type: 'get', key: 'episodes:shared' })
  assert.equal((await third).value.items[0].id, 'hg-11')
  assert.equal(requests.length, 1)
})

test('stale metadata returns immediately during one shared refresh and keeps its original age on failure', async t => {
  const { store, peer } = fixture(t)
  let now = 1000000, reads = 0
  const a = new SharedCatalogCache(store, { now: () => now }), b = new SharedCatalogCache(peer, { now: () => now, poll: 1 })
  await a.get('feed:test', async () => ({ items: ['old'] }))
  now += catalogTtl + 1
  let reject
  const loading = () => { reads++; return new Promise((_, no) => { reject = no }) }
  assert.deepEqual(await a.get('feed:test', loading), { items: ['old'] })
  assert.deepEqual(await b.get('feed:test', loading), { items: ['old'] })
  assert.equal(reads, 1)
  const jobs = [...a.jobs.values(), ...b.jobs.values()]
  reject(Error('synthetic provider outage'))
  await Promise.allSettled(jobs)
  assert.equal(store.catalogCache('feed:test').updatedAt, 1000000)
  assert.equal(store.catalogCache('feed:test').retryAt, now + 30000)
  assert.deepEqual(await b.get('feed:test', loading), { items: ['old'] })
  await Promise.allSettled([...b.jobs.values()])
  assert.equal(reads, 1)
})

test('failures back off across connections and restart, empty metadata is cached, and success resets backoff', async t => {
  const { store, peer } = fixture(t)
  let now = 1000000, reads = 0
  const options = { now: () => now }
  const failing = async () => { reads++; throw Error('synthetic outage') }
  const cache = new SharedCatalogCache(store, options)
  await assert.rejects(cache.get('episodes:bad', failing))
  let restarted = new SharedCatalogCache(peer, options)
  await assert.rejects(restarted.get('episodes:bad', failing))
  assert.equal(reads, 1)
  for (const delay of [30000, 60000, 120000, 240000, 480000, 900000, 900000]) {
    const state = peer.catalogCache('episodes:bad')
    assert.equal(state.retryAt - now, delay)
    now = state.retryAt
    await assert.rejects(restarted.get('episodes:bad', failing))
  }
  now = peer.catalogCache('episodes:bad').retryAt
  assert.deepEqual(await restarted.get('episodes:bad', async () => ({ items: [], cursor: null })), { items: [], cursor: null })
  restarted = new SharedCatalogCache(store, options)
  assert.deepEqual(await restarted.get('episodes:bad', failing), { items: [], cursor: null })
  assert.equal(store.catalogCache('episodes:bad').failures, 0)
  assert.equal(store.catalogCache('episodes:bad').retryAt, 0)
  assert.equal(reads, 8)
})

test('an expired or invalidated lease cannot overwrite a newer result or its retry policy', t => {
  const { store, peer } = fixture(t)
  assert.equal(store.claimCatalogCache('feed:test', 'old', 1000, catalogTtl, 100), true)
  assert.equal(peer.claimCatalogCache('feed:test', 'new', 1101, catalogTtl, 100), true)
  assert.equal(store.renewCatalogCache('feed:test', 'old', 1102, 100), false)
  assert.equal(store.completeCatalogCache('feed:test', 'old', { titles: [{ id: 'hg-1', title: 'old' }] }, 1102, true), false)
  assert.equal(peer.completeCatalogCache('feed:test', 'new', { titles: [{ id: 'hg-2', title: 'new' }] }, 1102, true), true)
  assert.equal(store.failCatalogCache('feed:test', 'old', 1103), false)
  assert.deepEqual(store.waitingFeed(true), [{ id: 'hg-2', title: 'new' }])
  store.setPreferences({ searchTerms: ['新关键词'] })
  assert.equal(peer.catalogCache('feed:test'), null)
  assert.equal(peer.completeCatalogCache('feed:test', 'new', { titles: [] }, 1104, true), false)
})

test('a slow refresh renews its lease while a peer waits rather than launching another load', async t => {
  const { store, peer } = fixture(t)
  const options = { lease: 600, poll: 15, wait: 5000 }
  const a = new SharedCatalogCache(store, options), b = new SharedCatalogCache(peer, options)
  let finish, reads = 0
  const loader = () => { reads++; return new Promise(resolve => { finish = resolve }) }
  const first = a.get('slow', loader), second = b.get('slow', loader)
  await new Promise(resolve => setTimeout(resolve, 850))
  assert.equal(reads, 1)
  finish({ ready: true })
  assert.deepEqual(await first, await second)
})

test('a cold abandoned lease can be recovered and persistent catalog metadata stays bounded', async t => {
  const { store, peer } = fixture(t)
  let now = 1000000
  store.claimCatalogCache('abandoned', 'gone', now, catalogTtl, 100)
  now += 101
  const cache = new SharedCatalogCache(peer, { now: () => now })
  assert.deepEqual(await cache.get('abandoned', async () => ['recovered']), ['recovered'])
  for (let n = 0; n < 140; n++) {
    now++
    await cache.get('page:' + n, async () => [n])
  }
  assert.equal(store.db.prepare('SELECT count(*) AS n FROM catalog_cache').get().n, 128)
  assert.deepEqual(store.catalogCache('page:139').value, [139])
  assert.equal(store.catalogCache('page:0'), null)
})

test('episode pagination survives new Catalog instances, respects runtime readiness, and persists empty final pages', async t => {
  const { store, peer } = fixture(t)
  t.mock.method(Catalog.prototype, 'prepareMediaRuntime', async () => {})
  const a = new Catalog(store), b = new Catalog(peer)
  a.ffmpeg = true; b.ffmpeg = false
  let reads = 0
  t.mock.method(a.sources.get('hongguo'), 'sdkCall', async (method, id, { cursor }) => {
    assert.equal(method, 'listEpisodes'); assert.equal(id, '8'); reads++
    return cursor === 'done' ? { items: [] } : cursor
      ? { items: [{ id: '2', title: '第二集' }], has_more: true, cursor: 'done' }
      : { items: [{ id: '1', title: '第一集' }], has_more: true, cursor: 'next' }
  })
  t.mock.method(b.sources.get('hongguo'), 'sdkCall', () => assert.fail('persistent metadata must avoid another upstream call'))
  assert.equal((await a.nextEpisode('hg-8', 'hg-1')).episodeId, 'hg-2')
  assert.equal((await b.episodes({ seriesId: 'hg-8', cursor: 'next' })).items[0].playable, false)
  b.ffmpeg = true
  assert.equal((await b.nextEpisode('hg-8', 'hg-1')).episodeId, 'hg-2')
  assert.equal(await a.nextEpisode('hg-8', 'hg-2'), null)
  assert.equal(await b.nextEpisode('hg-8', 'hg-2'), null)
  assert.equal(reads, 3)
})

test('simultaneous cold Catalog instances share discovery and failed or empty feeds cool down without losing saved titles', async t => {
  const { store, peer } = fixture(t)
  t.mock.method(Catalog.prototype, 'prepareMediaRuntime', async () => {})
  const a = new Catalog(store), b = new Catalog(peer)
  let reads = 0, finish
  t.mock.method(a, 'collectFeed', () => { reads++; return new Promise(resolve => { finish = resolve }) })
  t.mock.method(b, 'collectFeed', () => assert.fail('only one Catalog should refresh the shared feed'))
  const first = a.waitingRecommendations(), second = b.waitingRecommendations()
  finish([{ id: 'hg-1', title: '剧一', hasCover: false }])
  assert.deepEqual(await first, await second)
  assert.equal(reads, 1)
  store.db.exec('UPDATE recommendation_feed SET updated_at=0; UPDATE catalog_cache SET updated_at=0')
  t.mock.method(a, 'collectFeed', async () => { reads++; return [] })
  assert.deepEqual(await a.waitingRecommendations(), [{ id: 'hg-1', title: '剧一' }])
  await Promise.allSettled([...a.metadata.jobs.values()])
  assert.deepEqual(await b.waitingRecommendations(), [{ id: 'hg-1', title: '剧一' }])
  await Promise.allSettled([...b.metadata.jobs.values()])
  assert.equal(reads, 2)
  assert.equal(store.waitingFeed().length, 0, 'failed refresh must not extend stale data freshness')
})

test('changing recommendation terms invalidates an in-flight result without replacing the newer feed', async t => {
  const { store, peer } = fixture(t)
  t.mock.method(Catalog.prototype, 'prepareMediaRuntime', async () => {})
  const a = new Catalog(store), b = new Catalog(peer)
  let finish
  t.mock.method(a, 'collectFeed', () => new Promise(resolve => { finish = resolve }))
  t.mock.method(b, 'collectFeed', async (_, terms) => {
    assert.deepEqual(terms, ['新关键词'])
    return [{ id: 'hg-2', title: '新推荐', hasCover: false }]
  })
  const old = a.recommendations()
  const rejected = assert.rejects(old)
  store.setPreferences({ searchTerms: ['新关键词'] })
  assert.equal((await b.recommendations())[0].id, 'hg-2')
  finish([{ id: 'hg-1', title: '旧推荐', hasCover: false }])
  await rejected
  assert.deepEqual(store.waitingFeed(), [{ id: 'hg-2', title: '新推荐' }])
})
