import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { BilibiliSource } from '../src/server/sources/bilibili.mjs'
import { videoLink } from '../src/server/sources/bilibili-content.mjs'
import { ProviderRegistry, builtins } from '../src/server/providers/registry.mjs'
import { Catalog } from '../src/server/catalog.mjs'
import { Store } from '../src/server/store.mjs'
import { Service } from '../src/server/service.mjs'
import { qualify } from '../src/server/sources/ids.mjs'
import { defer } from './cleanup.mjs'

const bvid = 'BV17x411w7KC', native = 'video:' + bvid, sid = qualify('bilibili', native)
const info = { bvid, aid: 170001, title: '摄影教程', desc: '基础教程', tid: 124, pic: 'https://i0.hdslb.com/test.jpg',
  owner: { name: '测试 UP 主' }, duration: 9000,
  pages: [{ cid: 11, page: 1, part: '曝光基础' }, { cid: 12, page: 2, part: '构图实践' }, { cid: 13, page: 3, part: '后期处理' }] }
const stream = { timelength: 9000000, dash: {
  video: [{ id: 32, bandwidth: 400000, codecs: 'avc1.64001e', base_url: 'https://v.bilivideo.com/video',
    SegmentBase: { Initialization: '0-100', indexRange: '101-200' } }],
  audio: [{ bandwidth: 64000, codecs: 'mp4a.40.2', base_url: 'https://v.bilivideo.com/audio',
    SegmentBase: { Initialization: '0-100', indexRange: '101-200' } }],
} }
async function fixture(t, { root, cookie = '', vip = 0, videoInfo = info, playback = stream } = {}) {
  const own = !root
  root ||= await mkdtemp(join(tmpdir(), 'bilibili-videos-'))
  if (own) defer(t, () => rm(root, { recursive: true, force: true }))
  const requests = [], controller = new AbortController()
  const context = { dataDir: join(root, 'provider'), signal: controller.signal,
    async fetch(input, options = {}) {
      const url = new URL(input); requests.push({ url, options })
      if (url.pathname.endsWith('/finger/spi')) return Response.json({ code: 0, data: { b_3: 'synthetic-video-visitor' } })
      if (url.pathname.endsWith('/nav')) return Response.json({ code: 0, data: { isLogin: true, vipStatus: vip,
        wbi_img: { img_url: 'https://i0.hdslb.com/bfs/wbi/' + 'a'.repeat(32) + '.png', sub_url: 'https://i0.hdslb.com/bfs/wbi/' + 'b'.repeat(32) + '.png' } } })
      if (url.pathname.endsWith('/view')) return Response.json({ code: 0, data: videoInfo })
      if (url.pathname.endsWith('/playurl')) return Response.json({ code: 0, data: playback })
      if (url.pathname.endsWith('/search/type')) return Response.json({ code: 0, data: {
        result: [{ ...info, title: '<em>摄影</em>&amp;教程', author: '测试 UP 主', videos: 3 }], numPages: 2 } })
      if (url.pathname.endsWith('/popular') || url.pathname.endsWith('/ranking/v2')) return Response.json({ code: 0, data: {
        list: [info, { ...info, bvid: 'BV1xx411c7mD', title: '新的视频' }], no_more: true } })
      if (url.pathname.endsWith('/index/result')) return Response.json({ code: 0, data: { list: [{ season_id: 2251, title: '番剧', cover: info.pic }], has_next: 0 } })
      if (url.pathname.endsWith('/season')) return Response.json({ code: 0, result: { season_id: 2251, title: '番剧', episodes: [{ id: 50188, cid: 20, title: '1' }] } })
      throw Error('Unexpected fixture endpoint')
    }, mediaFetcher: () => async () => { throw Error('No fixture media download') },
  }
  const provider = new BilibiliSource(context, { cookie })
  const store = new Store(join(root, 'host'))
  const sources = new ProviderRegistry(root, { builtins: [builtins[0], { manifest: builtins[1].manifest, createProvider: () => provider }] })
  await sources.ready
  const catalog = new Catalog(store, { sources }), service = new Service(store, catalog)
  const panel = service.panel(service.open({ threadId: 'video-chat' }).panel)
  defer(t, async () => { await sources.dispose(); store.close() })
  return { root, provider, store, catalog, service, panel, requests, context }
}

test('canonical BV/AV links preserve P selection and reject unsafe or ambiguous links', () => {
  assert.deepEqual(videoLink(bvid), { bvid, page: 1 })
  assert.deepEqual(videoLink('av170001'), { avid: 170001, page: 1 })
  assert.deepEqual(videoLink('https://www.bilibili.com/video/' + bvid + '/?p=3'), { bvid, page: 3 })
  for (const input of ['https://bilibili.com.evil.test/video/' + bvid, 'https://user@bilibili.com/video/' + bvid,
    'http://www.bilibili.com/video/' + bvid, 'https://b23.tv/test', 'av9007199254740992',
    'https://www.bilibili.com/video/' + bvid + '?p=0', 'https://www.bilibili.com/video/' + bvid + '?p=1&p=2']) assert.throws(() => videoLink(input))
})
test('the pinned SDK normalizes AV/BV to one library entry and honors an explicit P ahead of history', async t => {
  const { provider, catalog } = await fixture(t)
  const a = await provider.listSeries({ query: 'av170001' })
  assert.equal(a.items[0].id, native)
  const b = await catalog.list({ source: 'bilibili', query: 'https://www.bilibili.com/video/' + bvid + '?p=3' })
  assert.equal(b.items[0].defaultEpisodeId, qualify('bilibili', native + ':13', 'episode'))
  assert.equal(provider.localSeries({ contentType: 'video' }).length, 1)
  assert.equal(provider.localSeries().length, 0)
  await assert.rejects(provider.listSeries({ query: 'https://www.bilibili.com/video/' + bvid + '?p=4' }), /不存在/)
})
test('multi-P ordering, pagination, next-P and membership validation share the existing player contract', async t => {
  const { provider, catalog } = await fixture(t)
  const a = await provider.listEpisodes(native, { pageSize: 2 }), b = await provider.listEpisodes(native, { pageSize: 2, cursor: a.cursor })
  assert.deepEqual([...a.items, ...b.items].map(p => p.label), ['曝光基础', '构图实践', '后期处理'])
  assert.equal(a.series.contentType, 'video')
  assert.equal((await catalog.nextEpisode(sid, qualify('bilibili', native + ':11', 'episode'))).episodeId, qualify('bilibili', native + ':12', 'episode'))
  assert.equal(await catalog.nextEpisode(sid, qualify('bilibili', native + ':13', 'episode')), null)
  await assert.rejects(provider.resolvePlayback(native + ':999'), /不属于/)
  const result = await provider.resolvePlayback(native + ':12')
  assert.equal(result.durationMs, 9000000)
  assert.equal(result.candidates[0].kind, 'tracks')
})
test('anonymous and signed-in ordinary streams use SDK account selection and retain bounded transport', async t => {
  const guest = await fixture(t), signed = await fixture(t, { cookie: 'SESSDATA=synthetic-video-account' })
  for (const f of [guest, signed]) await f.provider.resolvePlayback(native + ':11')
  const a = guest.requests.find(r => r.url.pathname.endsWith('/playurl')), b = signed.requests.find(r => r.url.pathname.endsWith('/playurl'))
  assert.equal(a.url.searchParams.get('fnval'), '16'); assert.equal(a.url.searchParams.get('qn'), '32')
  assert.equal(a.url.searchParams.get('platform'), 'pc')
  assert.equal(a.options.headers.Cookie, undefined)
  assert.equal(b.url.searchParams.get('qn'), '64'); assert.equal(b.options.headers.Cookie, 'SESSDATA=synthetic-video-account')
  assert.equal(b.url.searchParams.get('avid'), '170001'); assert.equal(b.url.searchParams.get('cid'), '11')
})
test('video search and category browsing bind cursors to kind, query and category', async t => {
  const { provider, requests } = await fixture(t)
  const page = await provider.listSeries({ contentType: 'video', category: '36', query: '摄影' })
  assert.equal(page.items[0].title, '摄影&教程')
  const request = requests.find(r => r.url.pathname.endsWith('/search/type'))
  assert.equal(request.url.searchParams.get('search_type'), 'video'); assert.equal(request.url.searchParams.get('tids'), '36')
  assert.match(request.url.searchParams.get('w_rid'), /^[a-f0-9]{32}$/)
  await assert.rejects(provider.listSeries({ contentType: 'video', category: '4', query: '摄影', cursor: page.cursor }), /不匹配/)
  await assert.rejects(provider.listSeries({ query: '摄影', cursor: page.cursor }), /不匹配/)
  const a = await provider.listSeries({ contentType: 'video', category: '36', pageSize: 1 })
  const b = await provider.listSeries({ contentType: 'video', category: '36', pageSize: 1, cursor: a.cursor })
  assert.notEqual(a.items[0].id, b.items[0].id); assert.equal(b.cursor, null)
})
test('ordinary Premium requests retain SDK membership selection without guest quality or H5 overrides', async t => {
  const { provider, requests } = await fixture(t, { cookie: 'SESSDATA=synthetic-premium-account', vip: 1 })
  await provider.resolvePlayback(native + ':11')
  const request = requests.find(r => r.url.pathname.endsWith('/playurl'))
  assert.equal(request.url.searchParams.get('fnval'), '4048')
  assert.equal(request.url.searchParams.get('fourk'), '1')
  assert.equal(request.url.searchParams.has('qn'), false)
  assert.equal(request.url.searchParams.has('platform'), false)
})
test('content preferences persist across processes; homepage, history and chat use the same selected kind', async t => {
  const a = await fixture(t), b = await fixture(t, { root: a.root })
  await a.service.call(a.panel, 'set_source', { source: 'bilibili' })
  await a.service.call(a.panel, 'set_content_preferences', { source: 'bilibili', contentType: 'video', category: 'all' })
  assert.equal(b.store.preferences().contentPreferences.bilibili.contentType, 'video')
  const home = await b.catalog.list({ source: 'bilibili' })
  assert.ok(home.items.every(x => x.contentType === 'video'))
  const episodeId = qualify('bilibili', native + ':12', 'episode')
  await a.provider.getSeries(native)
  await a.service.call(a.panel, 'save_progress', { seriesId: sid, episodeId, title: info.title, label: 'P2 · 构图实践', positionMs: 30000, durationMs: 60000 })
  a.store.event({ session_id: 'video-chat', turn_id: 'one', hook_event_name: 'UserPromptSubmit' })
  const picks = (await a.service.call(a.panel, 'get_waiting_picks', { turnId: 'one' })).items
  assert.equal(picks[0].episodeId, episodeId); assert.ok(picks.every(p => p.contentType === 'video'))
  await a.service.call(a.panel, 'set_content_preferences', { source: 'bilibili', contentType: 'bangumi' })
  assert.ok((await a.catalog.list({ source: 'bilibili' })).items.every(p => p.contentType === 'bangumi'))
  assert.deepEqual((await a.service.call(a.panel, 'get_waiting_picks', { turnId: 'one' })).items, picks)
  a.store.event({ session_id: 'video-chat', turn_id: 'two', hook_event_name: 'UserPromptSubmit' })
  const next = (await a.service.call(a.panel, 'get_waiting_picks', { turnId: 'two' })).items
  assert.ok(next.length && next.every(p => p.contentType === 'bangumi'))
  assert.equal((await a.service.call(a.panel, 'get_history', { source: 'bilibili', contentType: 'bangumi' })).items.length, 0)
  assert.equal((await a.service.call(a.panel, 'get_history', { source: 'bilibili', contentType: 'video' })).items.length, 1)
  assert.deepEqual(a.store.waitingFeed(true, 'hongguo'), [])
})
test('video recommendations learn only from watching and explicit partitions; cached feeds never mix types or partitions', async t => {
  const { provider, service, panel, catalog, store, requests } = await fixture(t)
  await service.call(panel, 'set_content_preferences', { source: 'bilibili', contentType: 'video', category: '' })
  assert.equal(catalog.contentContext('bilibili').category, 'all')
  await provider.getSeries(native)
  await service.call(panel, 'save_progress', { seriesId: sid, episodeId: qualify('bilibili', native + ':11', 'episode'), title: info.title, label: 'P1', positionMs: 1000, durationMs: 9000000 })
  assert.equal(catalog.contentContext('bilibili').category, '36')
  await catalog.waitingRecommendations('bilibili')
  assert.ok(requests.some(r => r.url.pathname.endsWith('/ranking/v2') && r.url.searchParams.get('rid') === '36'))
  await service.call(panel, 'set_content_preferences', { source: 'bilibili', contentType: 'video', category: '4' })
  assert.equal(catalog.contentContext('bilibili').category, '4')
  await catalog.waitingRecommendations('bilibili')
  assert.ok(requests.some(r => r.url.searchParams.get('rid') === '4'))
  assert.ok(store.db.prepare('SELECT count(*) AS n FROM content_recommendation_feed').get().n >= 2)
  await assert.rejects(service.call(panel, 'set_content_preferences', { source: 'bilibili', contentType: 'video', category: '99999' }), /分区/)
  await assert.rejects(service.call(panel, 'set_content_preferences', { source: 'hongguo', contentType: 'video' }), /不支持/)
})
for (const [name, patch, message] of [
  ['interactive', { rights: { is_stein_gate: 1 } }, /互动/],
  ['PGC redirect', { redirect_url: 'https://www.bilibili.com/bangumi/play/ep1' }, /番剧链接/],
  ['no P', { pages: [] }, /分 P/],
]) test('unsupported ' + name + ' is explained before playback', async t => {
  const { provider } = await fixture(t, { videoInfo: { ...info, ...patch } })
  await assert.rejects(provider.getSeries(native), message)
})
for (const [name, patch, message] of [['preview', { is_preview: 1 }, /试看/], ['DRM', { is_drm: true }, /DRM/]])
  test('ordinary ' + name + ' never becomes a complete playable stream', async t => {
    const { provider } = await fixture(t, { playback: { ...stream, ...patch } })
    await assert.rejects(provider.resolvePlayback(native + ':11'), message)
  })
