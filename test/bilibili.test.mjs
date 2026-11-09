import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { defer } from './cleanup.mjs'
import assert from 'node:assert/strict'
import { mkdtemp, rm, access, readFile, mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { Readable, PassThrough } from 'node:stream'
import { BilibiliSource, bangumiLink } from '../src/server/sources/bilibili.mjs'
import { ProviderRegistry, builtins } from '../src/server/providers/registry.mjs'
import { allowedURL } from '../src/server/sources/network.mjs'
import { Store } from '../src/server/store.mjs'
import { Catalog } from '../src/server/catalog.mjs'
import { Service } from '../src/server/service.mjs'
import { qualify } from '../src/server/sources/ids.mjs'
import { prepareTracks } from '../src/server/tracks.mjs'
import { runFfmpeg } from '../src/server/media.mjs'
import { ensureFfmpeg } from '../src/runtime/ffmpeg-runtime.mjs'

const season = { season_id: 2251, title: '番剧测试', evaluate: '简介', cover: 'https://i0.hdslb.com/cover.jpg',
  episodes: [{ id: 50188, cid: 11, title: '1', long_title: '第一话' },
    { id: 50189, cid: 12, title: '2', long_title: '第二话' }, { id: 50190, cid: 13, title: 'PV', badge: '预告' }],
  section: [{ episodes: [{ id: 999, cid: 99, title: '预告' }] }] }
const media = { timelength: 1440000, is_preview: 0, is_drm: false, dash: {
  video: [{ id: 32, bandwidth: 400000, codecs: 'avc1.64001E', base_url: 'https://v.bilivideo.com/video.m4s',
    backup_url: ['https://backup.bilivideo.com/video.m4s'] },
    { id: 80, bandwidth: 1000000, codecs: 'hev1.test', base_url: 'https://v.bilivideo.com/hevc.m4s' }],
  audio: [{ bandwidth: 64000, codecs: 'mp4a.40.2', base_url: 'https://a.bilivideo.com/audio.m4s' }],
} }
async function fixture(t, { payload = media, cookie = '', root } = {}) {
  const ownRoot = root == null
  root ??= await mkdtemp(join(tmpdir(), 'bilibili-provider-'))
  if (ownRoot) defer(t, () => rm(root, { recursive: true, force: true }))
  const controller = new AbortController(), requests = []
  const context = { dataDir: join(root, 'bilibili'), signal: controller.signal,
    async fetch(input, options) {
      const url = new URL(input); requests.push({ url, options })
      assert.equal(url.hostname, 'api.bilibili.com')
      if (url.pathname.endsWith('/finger/spi')) return Response.json({ code: 0, data: { b_3: 'synthetic-visitor' } })
      if (url.pathname.endsWith('/index/result')) return Response.json({ code: 0, data: { list: [], has_next: 0 } })
      if (url.pathname.endsWith('/nav')) return Response.json({ code: 0, data: { isLogin: true, vipStatus: 0,
        wbi_img: { img_url: 'https://i0.hdslb.com/bfs/wbi/' + 'a'.repeat(32) + '.png',
          sub_url: 'https://i0.hdslb.com/bfs/wbi/' + 'b'.repeat(32) + '.png' } } })
      return Response.json({ code: 0, result: url.pathname.endsWith('/season') ? season : payload })
    },
    mediaFetcher(headers) { return async () => { assert.equal(headers.Cookie, undefined); throw Error('not requested') } },
  }
  const provider = new BilibiliSource(context, { cookie })
  defer(t, () => provider.dispose())
  return { root, controller, context, requests, provider }
}

test('Bilibili is available by default with NSFW false while its SDK and library stay lazy', async t => {
  const root = await mkdtemp(join(tmpdir(), 'bilibili-default-'))
  defer(t, () => rm(root, { recursive: true, force: true }))
  const registry = new ProviderRegistry(root); await registry.ready; defer(t, () => registry.dispose())
  assert.deepEqual(registry.list().filter(p => p.available).map(p => p.id), ['hongguo', 'bilibili'])
  assert.equal(registry.list().find(p => p.id === 'bilibili').nsfw, false)
  await assert.rejects(access(join(root, 'device/providers/bilibili')))
  assert.equal(registry.get('bilibili').sdk, undefined)
  assert.equal(registry.get('hongguo').id, 'hongguo')
  await registry.dispose()
  await assert.rejects(access(join(root, 'device/providers/bilibili')))
  assert.throws(() => registry.get('bilibili').db, /片源已关闭/)
})

test('only canonical season/episode links and ss/ep IDs are accepted', () => {
  assert.deepEqual(bangumiLink('ss2251'), { season_id: 'ss2251' })
  assert.deepEqual(bangumiLink(' https://www.bilibili.com/bangumi/play/ep50188/?t=1 '), { ep_id: 'ep50188' })
  for (const value of ['BV1test', 'ss0', 'ss../1', 'https://bilibili.com.evil.test/bangumi/play/ss2251',
    'https://user@bilibili.com/bangumi/play/ss2251', 'http://www.bilibili.com/bangumi/play/ss2251',
    'https://127.0.0.1/bangumi/play/ss2251', 'https://b23.tv/abcd']) assert.throws(() => bangumiLink(value))
})
test('the pinned real amagi SDK lists a season and resolves ordered main episodes through the bounded adapter', async t => {
  const { provider, requests } = await fixture(t)
  assert.deepEqual(await provider.listSeries(), { items: [], cursor: null })
  const page = await provider.listSeries({ query: 'ss2251' })
  assert.equal(page.items[0].episodes, 2)
  assert.equal(requests.filter(r => r.url.pathname.endsWith('/season')).length, 1)
  const first = await provider.listEpisodes('2251', { pageSize: 1 })
  const second = await provider.listEpisodes('2251', { cursor: first.cursor, pageSize: 1 })
  assert.deepEqual([...first.items, ...second.items].map(e => e.id), ['2251:50188', '2251:50189'])
  await assert.rejects(provider.listEpisodes('other', { cursor: first.cursor }))
  assert.equal((await provider.listSeries()).items[0].id, '2251')
  const result = await provider.resolvePlayback('2251:50188')
  assert.equal(result.candidates[0].kind, 'tracks')
  assert.equal(result.candidates[0].codec, 'h264')
  assert.equal(result.candidates[0].video.backupURLs.length, 1)
  const playback = requests.at(-1).url
  assert.equal(playback.searchParams.get('ep_id'), '50188')
  assert.equal(playback.searchParams.get('fnval'), '16')
  assert.equal(requests.some(r => r.url.pathname.includes('/nav')), false)
  await assert.rejects(provider.resolvePlayback('2251:999'), /不属于/)
})
test('saved Bilibili library persists and merges across Provider processes without a catalog TTL delay', async t => {
  const a = await fixture(t), b = await fixture(t, { root: a.root })
  await a.provider.listSeries({ query: 'ss2251' })
  assert.equal((await b.provider.listSeries()).items[0].id, '2251')
  const store = new Store(join(a.root, 'host')); defer(t, () => store.close())
  const registry = new ProviderRegistry(a.root, { builtins: [builtins[0], { manifest: builtins[1].manifest,
    createProvider: () => b.provider }], enabled: ['hongguo', 'bilibili'] })
  const catalog = new Catalog(store, { sources: registry }); await registry.ready
  assert.equal((await catalog.list({ source: 'bilibili' })).items[0].id, qualify('bilibili', '2251'))
  assert.equal((await catalog.waitingRecommendations('bilibili'))[0].id, qualify('bilibili', '2251'))
  assert.equal(b.requests.some(r => r.url.search.includes('总裁')), false)
})
test('browse and signed name search work without importing a link, with source/query-bound pagination and plain titles', async t => {
  const { provider, context, requests } = await fixture(t)
  context.fetch = async (input, options) => {
    const url = new URL(input); requests.push({ url, options })
    if (url.pathname.endsWith('/finger/spi')) return Response.json({ code: 0, data: { b_3: 'synthetic-visitor' } })
    if (url.pathname.endsWith('/nav')) return Response.json({ code: -101, data: { isLogin: false,
      wbi_img: { img_url: 'https://i0.hdslb.com/bfs/wbi/' + 'a'.repeat(32) + '.png',
        sub_url: 'https://i0.hdslb.com/bfs/wbi/' + 'b'.repeat(32) + '.png' } } })
    const row = { season_id: '123', title: '<em class="keyword">番剧</em>&amp;动画', cover: 'https://i0.hdslb.com/cover.jpg' }
    if (url.pathname.endsWith('/index/result')) return Response.json({ code: 0, data: { list: [row], has_next: 1 } })
    assert.equal(url.pathname, '/x/web-interface/wbi/search/type')
    assert.match(options.headers['User-Agent'], /AppleWebKit.*Chrome\/142/)
    assert.equal(url.searchParams.get('keyword'), '番剧')
    assert.equal(url.searchParams.get('search_type'), 'media_bangumi')
    assert.equal(url.searchParams.get('fnval'), null)
    assert.match(url.searchParams.get('w_rid'), /^[0-9a-f]{32}$/)
    assert.ok(url.searchParams.has('wts'))
    return Response.json({ code: 0, data: { result: [row], numPages: 2 } })
  }
  const browse = await provider.listSeries()
  assert.equal(browse.items[0].title, '番剧&动画')
  const first = await provider.listSeries({ query: '番剧' })
  assert.equal(first.items[0].id, '123')
  await provider.listSeries({ query: '番剧', cursor: first.cursor })
  assert.equal(requests.at(-1).url.searchParams.get('page'), '2')
  await assert.rejects(provider.listSeries({ query: '其他番剧', cursor: first.cursor }), /不匹配/)
  await assert.rejects(provider.listSeries({ cursor: first.cursor }), /不匹配/)
  assert.equal(requests.find(r => r.url.pathname.endsWith('/search/type')).options.headers.Cookie, 'buvid3=synthetic-visitor')
  assert.equal(requests.find(r => r.url.pathname.endsWith('/finger/spi')).options.headers.Cookie, undefined)
  assert.equal(requests.some(r => String(r.options.headers.Cookie).includes('SESSDATA')), false)
})
test('Bilibili discovery populates homepage and chat recommendations without Hongguo seed searches', async t => {
  const { provider, root, context } = await fixture(t)
  context.fetch = async input => {
    const url = new URL(input)
    assert.ok(url.pathname.endsWith('/index/result'))
    return Response.json({ code: 0, data: { list: Array.from({ length: 16 }, (_, i) => ({
      season_id: String(100 + i), title: '番剧' + i, cover: 'https://i0.hdslb.com/' + i + '.jpg',
    })), has_next: 0 } })
  }
  const store = new Store(join(root, 'host')); defer(t, () => store.close())
  const registry = new ProviderRegistry(root, { builtins: [{ manifest: builtins[1].manifest,
    createProvider: () => provider }], enabled: ['bilibili'] }); await registry.ready
  const catalog = new Catalog(store, { sources: registry })
  const home = await catalog.list({ source: 'bilibili' })
  assert.equal(home.items.length, 16)
  assert.ok(home.items.every(row => row.id.startsWith('p.bilibili.')))
  assert.deepEqual((await catalog.waitingRecommendations('bilibili')).map(row => row.id), home.items.map(row => row.id))
  assert.deepEqual(store.waitingFeed(true, 'hongguo'), [])
})
test('a successful search with no result array is empty, and still finds matching imported titles', async t => {
  const { provider, context } = await fixture(t), fetch = context.fetch
  context.fetch = async (input, options) => new URL(input).pathname.endsWith('/wbi/search/type')
    ? Response.json({ code: 0, data: { numResults: 0, numPages: 0 } }) : fetch(input, options)
  assert.deepEqual(await provider.listSeries({ query: '不存在的番剧' }), { items: [], cursor: null })
  await provider.listSeries({ query: 'ss2251' })
  const local = await provider.listSeries({ query: season.title })
  assert.equal(local.items[0].id, '2251')
  assert.equal(local.items[0].title, season.title)
})
test('a verification ticket is never a search result and local matches remain usable without revealing the ticket', async t => {
  const { provider, context } = await fixture(t), fetch = context.fetch
  context.fetch = async (input, options) => new URL(input).pathname.endsWith('/wbi/search/type')
    ? Response.json({ code: 0, data: { v_voucher: 'synthetic-verification-ticket' } }) : fetch(input, options)
  await assert.rejects(provider.listSeries({ query: '未知番剧' }), error => /验证/.test(error.message) && !/ticket/.test(error.message))
  await provider.listSeries({ query: 'ss2251' })
  const local = await provider.listSeries({ query: season.title })
  assert.equal(local.items[0].id, '2251')
  assert.doesNotMatch(JSON.stringify(local), /voucher|ticket/)
})
test('search adds a guest identifier without replacing an existing account cookie or exposing either in results', async t => {
  const { provider, context, requests } = await fixture(t, { cookie: 'SESSDATA=synthetic-login' }), fetch = context.fetch
  context.fetch = async (input, options) => {
    if (new URL(input).pathname.endsWith('/search/type')) {
      requests.push({ url: new URL(input), options })
      return Response.json({ code: 0, data: { numResults: 0, numPages: 0 } })
    }
    return fetch(input, options)
  }
  const first = await provider.listSeries({ query: '新番' })
  await provider.listSeries({ query: '动画' })
  assert.equal(requests.filter(r => r.url.pathname.endsWith('/finger/spi')).length, 1)
  assert.equal(requests.find(r => r.url.pathname.endsWith('/search/type')).options.headers.Cookie,
    'SESSDATA=synthetic-login; buvid3=synthetic-visitor')
  assert.doesNotMatch(JSON.stringify(first), /SESSDATA|buvid3|synthetic/)
})
test('a newly imported title is visible across processes even while homepage and waiting feeds are cached', async t => {
  const a = await fixture(t), b = await fixture(t, { root: a.root })
  b.context.fetch = async input => new URL(input).pathname.endsWith('/index/result')
    ? Response.json({ code: 0, data: { list: [{ season_id: '333', title: '目录番剧' }], has_next: 0 } })
    : Response.json({ code: 0, result: season })
  const store = new Store(join(a.root, 'host')); defer(t, () => store.close())
  const sources = new ProviderRegistry(a.root, { builtins: [{ manifest: builtins[1].manifest, createProvider: () => b.provider }], enabled: ['bilibili'] })
  await sources.ready
  const catalog = new Catalog(store, { sources })
  assert.equal((await catalog.list({ source: 'bilibili' })).items[0].title, '目录番剧')
  await a.provider.listSeries({ query: 'ss2251' })
  assert.ok((await catalog.list({ source: 'bilibili' })).items.some(row => row.id === qualify('bilibili', '2251')))
  assert.ok((await catalog.waitingRecommendations('bilibili')).some(row => row.id === qualify('bilibili', '2251')))
  assert.equal((await catalog.waitingRecommendations('bilibili')).some(row => row.id.startsWith('hg-')), false)
})
test('Bilibili uses normal selection, next-episode and isolated progress contracts', async t => {
  const { provider, root } = await fixture(t)
  const store = new Store(join(root, 'host')); defer(t, () => store.close())
  const sources = new ProviderRegistry(root, { builtins: [builtins[0], { manifest: builtins[1].manifest,
    createProvider: () => provider }], enabled: ['hongguo', 'bilibili'] }); await sources.ready
  const catalog = new Catalog(store, { sources }); catalog.ffmpeg = false
  assert.ok((await catalog.episodes({ seriesId: qualify('bilibili', '2251') })).items.every(ep => ep.playable),
    'on-demand playback must not race FFmpeg startup after a fast cached restart')
  catalog.ffmpeg = true
  const service = new Service(store, catalog), panel = service.panel(service.open({ threadId: 'B' }).panel)
  await service.call(panel, 'set_source', { source: 'bilibili' })
  const page = await service.call(panel, 'list_series', { query: 'ep50188' })
  const sid = page.items[0].id, eps = await service.call(panel, 'get_episodes', { seriesId: sid })
  await service.call(panel, 'save_progress', { seriesId: sid, episodeId: eps.items[0].id,
    title: '番剧测试', label: '第一话', positionMs: 30000, durationMs: 1440000 })
  assert.equal((await catalog.nextEpisode(sid, eps.items[0].id)).episodeId, eps.items[1].id)
  assert.equal(store.history().length, 0)
  assert.equal(store.history(undefined, undefined, 30, 'bilibili')[0].positionMs, 30000)
})
for (const [label, patch, message] of [
  ['preview flag', { is_preview: 1 }, /试看/],
  ['new preview marker', { play_check: { play_detail: 'PLAY_PREVIEW' } }, /试看/],
  ['DRM', { is_drm: true }, /DRM/],
  ['region restriction', { plugins: [{ name: 'AreaLimitPanel', config: { is_block: true } }] }, /地区/],
  ['missing audio', { dash: { ...media.dash, audio: [] } }, /AVC\/AAC/],
  ['oversized tracks', { dash: { ...media.dash, video: [{ ...media.dash.video[0], bandwidth: 9000000 }] } }, /AVC\/AAC/],
  ['too long', { timelength: 7200001 }, /时长/],
]) test('Bilibili rejects ' + label + ' instead of reporting a complete playable episode', async t => {
  const { provider } = await fixture(t, { payload: { ...media, ...patch } })
  await assert.rejects(provider.resolvePlayback('2251:50188'), message)
})
test('credentials stay on the API transport and all upstream failures have safe messages', async t => {
  const { provider, requests, context } = await fixture(t, { cookie: 'synthetic-cookie' })
  await provider.resolvePlayback('2251:50188')
  assert.equal(requests.at(-1).options.headers.Cookie, 'synthetic-cookie')
  for (const [code, message] of [[-10403, /权益/], [-101, /登录/], [-412, /限制/]]) {
    context.fetch = async () => Response.json({ code, message: 'private-upstream-details' })
    await assert.rejects(provider.getSeries('123'), error => message.test(error.message) && !error.message.includes('private'))
  }
  context.fetch = async () => { throw Error('private-cookie-or-signed-url') }
  await assert.rejects(provider.getSeries('123'), error => !error.message.includes('private'))
})
test('disabled/aborted providers cannot finish an SDK call', async t => {
  const { provider, context, controller } = await fixture(t)
  context.fetch = async () => { controller.abort(); return Response.json({ code: 0, result: season }) }
  await assert.rejects(provider.getSeries('2251'), /取消/)
  assert.equal(provider.seasons.size, 0)
})
test('media locators use the Bilibili domain policy, including backup URLs', async t => {
  const { provider } = await fixture(t, { payload: { ...media, dash: { ...media.dash,
    video: [{ ...media.dash.video[0], base_url: 'https://127.0.0.1/private' }] } } })
  await assert.rejects(provider.resolvePlayback('2251:50188'), /域名/)
  assert.throws(() => allowedURL('https://v.bilivideo.com.evil.test/video', host => host.endsWith('.bilivideo.com')))
})
test('generic dual-track preparation combines real AVC/AAC tracks and retries a failed CDN', async t => {
  await ensureFfmpeg()
  const root = await mkdtemp(join(tmpdir(), 'bilibili-tracks-')); defer(t, () => rm(root, { recursive: true, force: true }))
  const input = fileURLToPath(new URL('./fixtures/avc-aac.mp4', import.meta.url))
  const video = join(root, 'video.mp4'), audio = join(root, 'audio.mp4'), output = join(root, 'output.mp4')
  await runFfmpeg(['-i', input, '-map', '0:v:0', '-an', '-c', 'copy', video])
  await runFfmpeg(['-i', input, '-map', '0:a:0', '-vn', '-c', 'copy', audio])
  const dir = join(root, 'raw'); await mkdir(dir)
  const seen = []
  await prepareTracks({ video: { url: 'bad', backupURLs: ['video'] }, audio: { url: 'audio' } }, dir, output, {
    budget: 1024 * 1024, run: runFfmpeg,
    cdn: async url => { seen.push(url); if (url === 'bad') throw Error('network')
      return { body: Readable.from([await readFile(url === 'video' ? video : audio)]), limit: new PassThrough() } },
  })
  assert.deepEqual(seen, ['bad', 'video', 'audio'])
  await runFfmpeg(['-i', output, '-map', '0:v:0', '-map', '0:a:0', '-t', '0.2', '-f', 'null', '-'])
  const limited = join(root, 'limited'); await mkdir(limited)
  await assert.rejects(prepareTracks({ video: { url: 'v' }, audio: { url: 'a' } }, limited, output, {
    budget: 1, run() { assert.fail() }, cdn: async () => ({ body: Readable.from([Buffer.alloc(2)]), limit: new PassThrough() }),
  }), /大小限制/)
})
