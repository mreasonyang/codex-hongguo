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

const row = { id: 'series_1', title: 'Fixture series', cover: 'https://pic.drleao.cn/cover.jpg', total_episodes: 2 }
const detail = { ...row, episodes: [{ ep_num: 2, title: 'Second' }, { ep_num: 1, title: 'First' }] }
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
