import test from 'node:test'
import assert from 'node:assert/strict'
import { createCipheriv } from 'node:crypto'
import { mkdtemp, rm, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { HuangguoSource, huangguoManifest } from '../src/server/sources/huangguo.mjs'
import { decodeCover } from '../src/server/sources/vendor/veyra-cover.mjs'
import { ProviderRegistry, builtins } from '../src/server/providers/registry.mjs'
import { Store } from '../src/server/store.mjs'
import { Catalog } from '../src/server/catalog.mjs'
import { Service } from '../src/server/service.mjs'
import { qualify } from '../src/server/sources/ids.mjs'
import { Readable } from 'node:stream'
import { ensureFfmpeg } from '../src/runtime/ffmpeg-runtime.mjs'
import { runFfmpeg } from '../src/server/media.mjs'

const row = { id: 'series_1', title: 'Fixture series', cover: 'https://pic.drleao.cn/cover.jpg', total_episodes: 2 }
const detail = { ...row, episodes: [{ ep_num: 2, title: 'Second' }, { ep_num: 1, title: 'First' }] }
const hotRows = (prefix, count) => Array.from({ length: count }, (_, i) => ({ ...row, id: `${prefix}_${i + 1}`, title: `${prefix} ${i + 1}` }))
function deferred() {
  let resolve, reject
  const promise = new Promise((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}
function fixture(t, respond) {
  const requests = [], mediaHeaders = [], controller = new AbortController()
  const context = { signal: controller.signal,
    async fetch(url, options) {
      const path = JSON.parse(options.body).path
      requests.push({ url: new URL(url), path, options })
      const result = await respond?.(path, options, url)
      if (result instanceof Response) return result
      const data = result ?? (/\/playback$/.test(path) ? { manifest_method: 'GET', streams: { main: 'https://v.hzjvlo.cn/fixture.m3u8?expires=synthetic' } }
        : /^\/api\/videos\/series_1$/.test(path) ? detail
          : { items: [row], pagination: { pages: 2 } })
      return Response.json({ status: 1, data })
    },
    mediaFetcher(headers) { mediaHeaders.push(headers); return async () => { throw Error('Fixture media not requested') } },
  }
  const provider = new HuangguoSource(context)
  t.after(() => provider.dispose())
  return { provider, context, requests, mediaHeaders, controller }
}

test('Huangguo is registered as NSFW without network, state files or an automatic default', async t => {
  const root = await mkdtemp(join(tmpdir(), 'huangguo-lazy-'))
  const registry = new ProviderRegistry(root)
  await registry.ready
  t.after(async () => { await registry.dispose(); await rm(root, { recursive: true, force: true }) })
  const provider = registry.get('huangguo')
  assert.equal(registry.list().find(row => row.id === 'huangguo').nsfw, true)
  assert.equal(provider.operations, undefined)
  assert.equal(provider.details.size, 0)
  assert.equal(registry.defaultSource('huangguo'), 'hongguo')
  assert.deepEqual(provider.recommendationTerms, [])
  await assert.rejects(readFile(join(root, 'device/providers/huangguo/account/session.json')))
})

test('real Veyra mapping honors page sizes and query-bound cursors through anonymous host transport', async t => {
  const f = fixture(t), first = await f.provider.listSeries({ query: 'fixture', pageSize: 1 })
  assert.equal(first.items[0].id, 'series_1')
  assert.equal(first.items[0].episodes, 2)
  await f.provider.listSeries({ query: 'fixture', pageSize: 1, cursor: first.cursor })
  assert.ok(f.requests.some(row => row.path === '/api/search?q=fixture&page=2&size=1'))
  await assert.rejects(f.provider.listSeries({ query: 'fixture', pageSize: 2, cursor: first.cursor }), error => error.code === 'CONTRACT')
  await assert.rejects(f.provider.listSeries({ query: 'other', cursor: first.cursor }), /分页/)
  const episodes = await f.provider.listEpisodes('series_1', { pageSize: 1 })
  assert.deepEqual(episodes.items.map(row => [row.id, row.label]), [['series_1:1', 'First']])
  const second = await f.provider.listEpisodes('series_1', { pageSize: 1, cursor: episodes.cursor })
  assert.equal(second.items[0].id, 'series_1:2')
  assert.equal(f.requests.filter(row => row.path === '/api/videos/series_1').length, 1)
  await assert.rejects(f.provider.listEpisodes('other', { cursor: episodes.cursor }), /分页/)
  for (const { options, url } of f.requests) {
    assert.equal(options.method, 'POST')
    assert.ok(huangguoManifest.network.api.includes(url.hostname))
    assert.equal(options.headers.has('Cookie'), false)
    assert.equal(options.headers.has('Authorization'), false)
    assert.ok(options.signal)
  }
})

test('playback returns a host-only HLS descriptor with a matching Referer and fresh resolution', async t => {
  const f = fixture(t)
  for (let i = 0; i < 2; i++) {
    const result = await f.provider.resolvePlayback('series_1:2')
    assert.equal(result.candidates[0].kind, 'hls')
    assert.match(result.candidates[0].url, /fixture\.m3u8/)
    const headers = f.mediaHeaders.at(-1)
    assert.match(headers.Referer, /^https:\/\/(huangguoai\.io|0624\.gitiecgad\.cc)\/video\/series_1\/$/)
    assert.equal(headers.Cookie, undefined)
  }
  assert.equal(f.requests.filter(row => row.path.endsWith('/playback')).length, 2)
  const envelope = JSON.parse(f.requests.find(row => row.path.endsWith('/playback')).options.body)
  assert.equal(envelope.method, 'POST')
  assert.equal(envelope.content_type, 'application/json')
  assert.equal(Buffer.from(envelope.body, 'base64').toString(), '{}')
  assert.equal(f.requests.some(row => row.path.includes('/play?')), false)
  await assert.rejects(f.provider.resolvePlayback('series_1:0'), /无效分集/)
  await assert.rejects(f.provider.resolvePlayback('series_1:999'), /片源/)
  const bad = fixture(t, path => path.endsWith('/playback') ? { streams: { main: 'https://127.0.0.1/private.m3u8' } } : undefined)
  await assert.rejects(bad.provider.resolvePlayback('series_1:1'), /域名/)
})

test('a rejected native catalog does not gate hot browsing, search, detail or fresh playback', async t => {
  const f = fixture(t, path => path.startsWith('/api/videos?')
    ? Response.json({ status: 0, msg: 'synthetic private upstream failure', data: [] }) : undefined)
  await assert.rejects(f.provider.call('category', ['', 1, 16]), error => error.code === 'CONTENT_UNAVAILABLE' && !error.message.includes('private'))
  assert.equal(f.requests.length, 1, 'business rejection must not trigger mirror probes')
  assert.equal((await f.provider.listSeries()).items[0].id, 'series_1')
  assert.equal(f.requests[1].path, '/api/ranks/hot')
  assert.equal((await f.provider.listSeries({ query: 'fixture' })).items[0].id, 'series_1')
  assert.equal((await f.provider.getSeries('series_1')).id, 'series_1')
  const fresh = fixture(t, path => path.startsWith('/api/videos?')
    ? Response.json({ status: 0, msg: 'synthetic unavailable catalog' }) : undefined)
  assert.ok((await fresh.provider.resolvePlayback('series_1:1')).candidates.length)
  assert.deepEqual(fresh.requests.map(row => row.path), ['/api/videos/series_1', '/api/videos/series_1/episodes/1/playback'])
})

test('default hot browsing paginates one complete snapshot exactly and binds size, query and instance', async t => {
  const rows = hotRows('hot', 7)
  const f = fixture(t, path => path === '/api/ranks/hot' ? { items: rows } : undefined)
  const first = await f.provider.listSeries({ pageSize: 2 })
  const collected = [...first.items.map(row => row.id)]
  let cursor = first.cursor
  const sizes = []
  while (cursor) {
    const next = await f.provider.listSeries({ pageSize: 2, cursor })
    sizes.push(next.items.length)
    collected.push(...next.items.map(row => row.id))
    cursor = next.cursor
  }
  assert.deepEqual(collected, rows.map(row => row.id))
  assert.deepEqual(sizes, [2, 2, 1])
  assert.equal(new Set(collected).size, 7)
  assert.deepEqual(f.requests.map(row => row.path), ['/api/ranks/hot'])
  for (const options of [{ pageSize: 3, cursor: first.cursor }, { pageSize: 2, query: 'fixture', cursor: first.cursor }, { cursor: '' }]) {
    await assert.rejects(f.provider.listSeries(options), error => error.code === 'CONTRACT')
  }
  const other = fixture(t)
  await assert.rejects(other.provider.listSeries({ pageSize: 2, cursor: first.cursor }), error => error.code === 'CONTRACT')
  assert.equal(other.requests.length, 0, 'foreign snapshot must not silently restart browsing')
  const search = await f.provider.listSeries({ query: 'fixture', pageSize: 2 })
  await assert.rejects(f.provider.listSeries({ pageSize: 2, cursor: search.cursor }), error => error.code === 'CONTRACT')
  assert.ok(f.requests.at(-1).path.startsWith('/api/search?'))
  assert.equal(f.requests.filter(row => row.path === '/api/ranks/hot').length, 1)
})

test('the application homepage renders real rank rows keyed by video_id', async t => {
  const root = await mkdtemp(join(tmpdir(), 'huangguo-rank-home-'))
  const f = fixture(t, path => path === '/api/ranks/hot'
    ? { items: [{ id: 'rank-entry', video_id: 'series_1', title: 'Fixture series', rank: 1 }] } : undefined)
  const sources = new ProviderRegistry(root, { directory: '', builtins: [builtins.find(plugin => plugin.manifest.id === 'hongguo'),
    { manifest: huangguoManifest, createProvider: () => f.provider }] })
  const store = new Store(root), catalog = new Catalog(store, { sources }), service = new Service(store, catalog)
  t.after(async () => { await sources.dispose(); store.close(); await rm(root, { recursive: true, force: true }) })
  const scope = service.panel(service.open({ threadId: 'rank-home' }).panel)
  await service.call(scope, 'set_source', { source: 'huangguo', confirmNsfw: true })
  const page = await service.call(scope, 'list_series', { preview: true })
  assert.equal(page.items.length, 1)
  assert.equal(page.items[0].id, qualify('huangguo', 'series_1'))
})

test('hot snapshots refresh after five minutes while old cursors retain their data until bounded eviction', async t => {
  let now = Date.now(), revision = 0
  t.mock.method(Date, 'now', () => now)
  const f = fixture(t, path => path === '/api/ranks/hot' ? { items: hotRows(`hot${++revision}`, 5) } : undefined)
  const first = await f.provider.listSeries({ pageSize: 2 })
  assert.deepEqual((await f.provider.listSeries({ pageSize: 2 })).items, first.items)
  assert.equal(revision, 1)
  now += 5 * 60000 + 1
  const second = await f.provider.listSeries({ pageSize: 2 })
  assert.equal(second.items[0].id, 'hot2_1')
  assert.deepEqual((await f.provider.listSeries({ pageSize: 2, cursor: first.cursor })).items.map(row => row.id), ['hot1_3', 'hot1_4'])
  for (let i = 0; i < 2; i++) { now += 5 * 60000 + 1; await f.provider.listSeries({ pageSize: 2 }) }
  assert.equal(f.provider.hotSnapshots.size, 3)
  const before = f.requests.length
  await assert.rejects(f.provider.listSeries({ pageSize: 2, cursor: first.cursor }), error => error.code === 'CONTRACT')
  assert.equal(f.requests.length, before)
  now += 30 * 60000
  await assert.rejects(f.provider.listSeries({ pageSize: 2, cursor: second.cursor }), error => error.code === 'CONTRACT')
  assert.equal(f.provider.hotSnapshots.size, 0)
  assert.equal(f.requests.length, before, 'expired cursor must not silently fetch a new dataset')
})

test('the first complete hot snapshot wins over an independently queued late response', { timeout: 5000 }, async t => {
  const enteredA = deferred(), enteredB = deferred(), releaseA = deferred(), releaseB = deferred()
  let count = 0
  const f = fixture(t, path => {
    if (path !== '/api/ranks/hot') return
    if (++count === 1) { enteredA.resolve(); return releaseA.promise }
    enteredB.resolve(); return releaseB.promise
  })
  const a = f.provider.listSeries({ pageSize: 2 }), b = f.provider.listSeries({ pageSize: 2 })
  await enteredA.promise
  assert.equal(f.provider.hotSnapshots.size, 0, 'an incomplete request must not publish a snapshot')
  releaseA.resolve({ items: hotRows('first', 5) })
  const first = await a
  await enteredB.promise
  releaseB.resolve({ items: hotRows('late', 5) })
  assert.deepEqual(await b, first)
  assert.deepEqual(await f.provider.listSeries({ pageSize: 2 }), first)
  assert.equal(f.provider.hotSnapshots.size, 1)
  assert.deepEqual((await f.provider.listSeries({ pageSize: 2, cursor: first.cursor })).items.map(row => row.id), ['first_3', 'first_4'])
})

test('cancelling hot caller A does not cancel independent caller B or publish partial data', { timeout: 5000 }, async t => {
  const enteredA = deferred(), enteredB = deferred(), releaseB = deferred(), cancel = new AbortController()
  let count = 0, firstSignal, secondSignal
  const f = fixture(t, (path, options) => {
    if (path !== '/api/ranks/hot') return
    if (++count === 1) {
      firstSignal = options.signal; enteredA.resolve()
      return new Promise((_, reject) => options.signal.addEventListener('abort', () => reject(options.signal.reason), { once: true }))
    }
    secondSignal = options.signal; enteredB.resolve(); return releaseB.promise
  })
  const a = f.provider.listSeries({ pageSize: 2, signal: cancel.signal })
  const rejected = assert.rejects(a, error => error.code === 'ABORTED')
  const b = f.provider.listSeries({ pageSize: 2 })
  await enteredA.promise
  cancel.abort(); await rejected
  await enteredB.promise
  assert.equal(firstSignal.aborted, true)
  assert.equal(secondSignal.aborted, false)
  assert.equal(f.provider.hotSnapshots.size, 0)
  releaseB.resolve({ items: hotRows('survivor', 4) })
  assert.deepEqual((await b).items.map(row => row.id), ['survivor_1', 'survivor_2'])
  assert.equal(f.provider.hotSnapshots.size, 1)
})

test('the source deadline aborts the real transport and cannot publish a late hot snapshot', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const entered = deferred()
  let transportSignal
  const f = fixture(t, (_path, options) => {
    transportSignal = options.signal
    entered.resolve()
    return new Promise((_, reject) => options.signal.addEventListener('abort', () => reject(options.signal.reason), { once: true }))
  })
  const pending = f.provider.listSeries()
  const rejected = assert.rejects(pending, error => error.code === 'TIMEOUT')
  await entered.promise
  t.mock.timers.tick(30001)
  await rejected
  assert.equal(transportSignal.aborted, true)
  await f.provider.operations
  assert.equal(f.provider.hotSnapshots.size, 0)
})

test('hot snapshots reject oversized, duplicate or invalid records instead of silently dropping content', async t => {
  for (const rows of [hotRows('oversized', 513), [row, row], [{ ...row, id: 'invalid/id' }]]) {
    const f = fixture(t, path => path === '/api/ranks/hot' ? { items: rows } : undefined)
    await assert.rejects(f.provider.listSeries(), error => error.code === 'CONTRACT')
    assert.equal(f.provider.hotSnapshots.size, 0)
  }
  const f = fixture(t, path => path === '/api/ranks/hot' ? Response.json({ status: 0, msg: 'synthetic private hot error' }) : undefined)
  await assert.rejects(f.provider.listSeries(), error => error.code === 'CONTENT_UNAVAILABLE' && !error.message.includes('private'))
  assert.equal((await f.provider.listSeries({ query: 'fixture' })).items[0].id, 'series_1')
  assert.equal(f.requests.filter(row => row.path.startsWith('/api/videos?')).length, 0)
})

test('detail caches only completed values so cancelling A leaves same-id caller B able to complete', { timeout: 5000 }, async t => {
  const enteredA = deferred(), enteredB = deferred(), releaseB = deferred(), cancel = new AbortController()
  let count = 0, secondSignal
  const f = fixture(t, (path, options) => {
    if (path !== '/api/videos/series_1') return
    if (++count === 1) {
      enteredA.resolve()
      return new Promise((_, reject) => options.signal.addEventListener('abort', () => reject(options.signal.reason), { once: true }))
    }
    secondSignal = options.signal; enteredB.resolve(); return releaseB.promise
  })
  const a = f.provider.getSeries('series_1', { signal: cancel.signal })
  const rejected = assert.rejects(a, error => error.code === 'ABORTED')
  const b = f.provider.getSeries('series_1')
  await enteredA.promise
  assert.equal(f.provider.details.size, 0)
  cancel.abort(); await rejected
  await enteredB.promise
  assert.equal(secondSignal.aborted, false)
  releaseB.resolve(detail)
  assert.equal((await b).id, 'series_1')
  assert.equal(f.provider.details.get('series_1').value.id, 'series_1')
  assert.equal(typeof f.provider.details.get('series_1').value.then, 'undefined')
  await f.provider.listEpisodes('series_1')
  await f.provider.getSeries('series_1')
  assert.equal(count, 2, 'successful history detail should be reused after completion')
})

test('completed detail cache retains its fifteen-minute TTL and 128-entry limit, and dispose clears it', async t => {
  let now = Date.now()
  t.mock.method(Date, 'now', () => now)
  const f = fixture(t, path => {
    const match = /^\/api\/videos\/([A-Za-z0-9_]+)$/.exec(path)
    return match ? { ...detail, id: match[1] } : undefined
  })
  await f.provider.getSeries('history_0')
  now += 15 * 60000 - 1
  await f.provider.getSeries('history_0')
  assert.equal(f.requests.length, 1)
  now++
  await f.provider.getSeries('history_0')
  assert.equal(f.requests.length, 2)
  for (let i = 1; i <= 128; i++) await f.provider.getSeries(`history_${i}`)
  assert.equal(f.provider.details.size, 128)
  assert.equal(f.provider.details.has('history_0'), false)
  await f.provider.listSeries()
  f.provider.dispose()
  assert.equal(f.provider.details.size, 0)
  assert.equal(f.provider.hotSnapshots.size, 0)
  const before = f.requests.length
  await assert.rejects(f.provider.getSeries('history_128'), error => error.code === 'ABORTED')
  assert.equal(f.requests.length, before)
})

test('wrong detail identity is a fixed isolated failure and never plays another series', async t => {
  const f = fixture(t, path => path === '/api/videos/series_1' ? { ...detail, id: 'another_series' } : undefined)
  await assert.rejects(f.provider.getSeries('series_1'), error => error.code === 'NOT_FOUND')
  await assert.rejects(f.provider.resolvePlayback('series_1:1'), error => error.code === 'NOT_FOUND')
  assert.equal(f.provider.details.size, 0)
  assert.equal(f.requests.some(row => row.path.includes('/episodes/')), false)
  assert.equal((await f.provider.listSeries({ query: 'fixture' })).items[0].id, 'series_1')
})

test('cold terminal responses and ambiguous playback POST failures do not fan out', async t => {
  for (const status of [401, 403, 404, 429]) {
    const f = fixture(t, () => new Response('synthetic private detail', { status }))
    await assert.rejects(f.provider.listSeries({ query: 'fixture' }))
    assert.equal(f.requests.length, 1)
    assert.match(f.requests[0].path, /^\/api\/search\?/)
  }
  const f = fixture(t, path => { if (path.endsWith('/playback')) throw Error('Synthetic lost response') })
  await assert.rejects(f.provider.resolvePlayback('series_1:1'), error => error.code === 'NETWORK')
  assert.equal(f.requests.filter(row => row.path.endsWith('/playback')).length, 1)
})

test('host hot browsing preserves terminal errors and cancellation with the unchanged SDK', async t => {
  const limited = fixture(t, () => new Response(null, { status: 429 }))
  await assert.rejects(limited.provider.listSeries(), error => error.code === 'RATE_LIMITED')
  assert.equal(limited.requests.length, 1)
  const cancelled = fixture(t, () => { throw new DOMException('Synthetic abort', 'AbortError') })
  await assert.rejects(cancelled.provider.listSeries(), error => error.code === 'ABORTED')
})

test('an available mirror survives the other failing and 429 does not fan out or leak upstream text', async t => {
  const f = fixture(t, (_path, _options, url) => {
    if (new URL(url).hostname === 'huangguoai.io') throw Error('Synthetic connection failure')
  })
  await f.provider.listSeries()
  assert.equal(f.requests.at(-1).url.hostname, '0624.gitiecgad.cc')
  const g = fixture(t, path => path.startsWith('/api/search') ? new Response('private upstream detail', { status: 429 }) : undefined)
  await g.provider.listSeries()
  const before = g.requests.length
  await assert.rejects(g.provider.listSeries({ query: 'fixture' }), error => error.code === 'RATE_LIMITED' && !error.message.includes('private'))
  assert.equal(g.requests.length, before + 1)
})

test('only full streams are accepted and the HEVC stream is the fallback when main is absent', async t => {
  const f = fixture(t, path => path.endsWith('/playback') ? { manifest_method: 'GET', streams: { hevc: 'https://v.hzjvlo.cn/hevc.m3u8' } } : undefined)
  assert.equal((await f.provider.resolvePlayback('series_1:1')).candidates[0].codec, 'hevc')
  const preview = fixture(t, path => path.endsWith('/playback') ? { streams: { preview: 'https://v.hzjvlo.cn/preview.m3u8' } } : undefined)
  await assert.rejects(preview.provider.resolvePlayback('series_1:1'), error => error.code === 'NO_VIDEO')
  const unsupported = fixture(t, path => path.endsWith('/playback') ? { manifest_method: 'POST', streams: { main: 'https://v.hzjvlo.cn/video.m3u8' } } : undefined)
  await assert.rejects(unsupported.provider.resolvePlayback('series_1:1'), /片源/)
})

test('cancellation reaches the in-flight fetch and a disposed source cannot issue requests', async t => {
  const f = fixture(t)
  await f.provider.listSeries()
  const cancel = new AbortController()
  let began
  const started = new Promise(resolve => { began = resolve })
  f.context.fetch = async (_url, options) => {
    began(options.signal)
    return new Promise((_, reject) => options.signal.addEventListener('abort', () => reject(options.signal.reason), { once: true }))
  }
  const pending = f.provider.listSeries({ query: 'fixture', signal: cancel.signal })
  const requestSignal = await started
  cancel.abort()
  await assert.rejects(pending, /取消/)
  assert.equal(requestSignal.aborted, true)
  f.provider.dispose()
  const before = f.requests.length
  await assert.rejects(f.provider.listSeries(), /取消/)
  assert.equal(f.requests.length, before)
})

test('Veyra cover decoder handles plain/encrypted images and repairs the site PNG header', () => {
  const plain = Buffer.alloc(48, 0x40)
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(plain)
  assert.deepEqual(decodeCover(plain), plain)
  const damaged = Buffer.from(plain); damaged[6] = 0x14
  const cipher = createCipheriv('aes-128-cbc', Buffer.from('f5d965df75336270'), Buffer.from('97b60374abc2fbe1'))
  assert.deepEqual(decodeCover(Buffer.concat([cipher.update(damaged), cipher.final()])), plain)
  assert.equal(decodeCover(Buffer.from('bad image')), null)
})

test('the altered JPEG cover header is restored before real thumbnail decoding, including encrypted covers', async () => {
  await ensureFfmpeg()
  const encoded = await runFfmpeg(['-f', 'lavfi', '-i', 'color=c=blue:s=32x48', '-frames:v', '1',
    '-pix_fmt', 'yuvj420p', '-f', 'image2pipe', '-c:v', 'mjpeg', 'pipe:1'], null, true)
  const parts = []; let table
  for (let p = 2; p + 4 <= encoded.length;) {
    assert.equal(encoded[p], 255)
    const marker = encoded[p + 1], length = encoded.readUInt16BE(p + 2)
    if (marker === 0xda) { parts.push(encoded.subarray(p)); break }
    if (marker === 0xdb) table = Buffer.from(encoded.subarray(p + 4, p + 2 + length))
    else if (marker !== 0xfe && !(marker >= 0xe0 && marker <= 0xef)) parts.push(encoded.subarray(p, p + 2 + length))
    p += 2 + length
  }
  assert.equal(table.length, 65); assert.equal(table[0], 0)
  const second = Buffer.from(table); second[0] = 1
  const valid = Buffer.concat([Buffer.from([255, 216, 255, 219, 0, 132]), table, second, ...parts])
  const damaged = Buffer.from(valid); damaged[6] = 14
  const convert = bytes => runFfmpeg(['-protocol_whitelist', 'pipe', '-i', 'pipe:0', '-vf',
    'scale=240:320:force_original_aspect_ratio=decrease', '-frames:v', '1', '-f', 'image2pipe', '-c:v', 'mjpeg', 'pipe:1'], bytes, true)
  await assert.rejects(convert(damaged), /无法处理/)
  assert.deepEqual(decodeCover(damaged), valid)
  assert.equal(damaged[6], 14, 'repair must not mutate the caller buffer')
  assert.ok((await convert(decodeCover(damaged))).length > 0)
  const cipher = createCipheriv('aes-128-cbc', Buffer.from('f5d965df75336270'), Buffer.from('97b60374abc2fbe1'))
  const encrypted = Buffer.concat([cipher.update(damaged), cipher.final()])
  assert.deepEqual(decodeCover(encrypted), valid)
  assert.deepEqual(decodeCover(valid), valid)
  const otherVariant = Buffer.from(damaged); otherVariant[71] = 2
  assert.deepEqual(decodeCover(otherVariant), otherVariant, 'other headers must not be blindly rewritten')
  assert.equal(decodeCover(damaged.subarray(0, 100))[6], 14)
})

test('the real provider remains behind NSFW confirmation and scopes its catalog, history and playback grants', async t => {
  const root = await mkdtemp(join(tmpdir(), 'huangguo-service-'))
  const f = fixture(t), sources = new ProviderRegistry(root, { builtins: builtins.map(plugin => plugin.manifest.id === 'huangguo'
    ? { manifest: huangguoManifest, createProvider: () => f.provider } : plugin) })
  const store = new Store(root), catalog = new Catalog(store, { sources }), service = new Service(store, catalog)
  catalog.ffmpeg = true
  t.after(async () => { await sources.dispose(); store.close(); await rm(root, { recursive: true, force: true }) })
  const scope = service.panel(service.open({ threadId: 'huangguo-fixture' }).panel)
  await assert.rejects(service.call(scope, 'set_source', { source: 'huangguo' }), /NSFW/)
  assert.equal(f.requests.length, 0)
  await service.call(scope, 'set_source', { source: 'huangguo', confirmNsfw: true })
  const home = await service.call(scope, 'list_series', { preview: true })
  assert.equal(home.items[0].id, qualify('huangguo', 'series_1'))
  const list = await service.call(scope, 'list_series', { query: 'fixture' })
  assert.equal(list.items[0].id, qualify('huangguo', 'series_1'))
  const episodes = await service.call(scope, 'get_episodes', { seriesId: list.items[0].id })
  assert.ok(episodes.items.every(ep => ep.id.startsWith('p.huangguo.e.')))
  assert.equal(JSON.stringify(list).includes('https://'), false)
  assert.equal(JSON.stringify(episodes).includes('https://'), false)
  assert.equal(service.open({ threadId: 'other' }).source, 'hongguo')
})

test('Huangguo playback prepares a long HLS index and grants only the requested panel fragment', async t => {
  const root = await mkdtemp(join(tmpdir(), 'huangguo-stream-')), f = fixture(t), requested = []
  f.context.mediaFetcher = () => async url => {
    requested.push(String(url))
    const text = String(url).includes('.m3u8') ? ['#EXTM3U', '#EXT-X-TARGETDURATION:5',
      ...Array.from({ length: 200 }, (_, i) => '#EXTINF:5,\npart-' + i + '.ts'), '#EXT-X-ENDLIST'].join('\n') : 'fixture segment'
    return { body: Readable.from([Buffer.from(text)]), url: String(url) }
  }
  const sources = new ProviderRegistry(root, { directory: '', builtins: [builtins.find(plugin => plugin.manifest.id === 'hongguo'),
    { manifest: huangguoManifest, createProvider: () => f.provider }] })
  const store = new Store(root), catalog = new Catalog(store, { sources }), service = new Service(store, catalog)
  t.after(async () => { catalog.panelMedia?.close(); await sources.dispose(); store.close(); await rm(root, { recursive: true, force: true }) })
  const scope = service.panel(service.open({ threadId: 'hls-panel' }).panel)
  await service.call(scope, 'set_source', { source: 'huangguo', confirmNsfw: true })
  const seriesId = qualify('huangguo', 'series_1'), episodeId = qualify('huangguo', 'series_1:1', 'episode')
  await service.call(scope, 'get_episodes', { seriesId })
  await service.call(scope, 'prepare_playback', { episodeId }, true)
  await catalog.panelMedia.remote.entries.get(episodeId).job
  const ready = await service.call(scope, 'prepare_playback', { episodeId }, true)
  assert.equal(ready.format, 'hls'); assert.equal(ready.durationMs, 1000000)
  assert.equal(catalog.cache, undefined, 'a long HLS video must bypass the whole-episode 256 MiB cache')
  assert.equal(requested.length, 1, 'preparation must fetch only the playlist')
  const chunk = await service.call(scope, 'read_panel_chunk', { episodeId, stream: ready.stream, asset: 'seg00150.ts', offset: 0 }, true)
  assert.equal(Buffer.from(chunk.bytes, 'base64').toString(), 'fixture segment')
  assert.equal(requested.length, 2)
  await service.call(scope, 'set_source', { source: 'huangguo' })
  await assert.rejects(service.call(scope, 'read_panel_chunk', { episodeId, stream: ready.stream, asset: 'seg00150.ts', offset: 0 }, true), /准备当前分集/)
})
