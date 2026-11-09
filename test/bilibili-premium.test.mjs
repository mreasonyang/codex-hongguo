import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { defer } from './cleanup.mjs'
import assert from 'node:assert/strict'
import { mkdtemp, rm, readFile, mkdir, copyFile, access } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { BilibiliSource } from '../src/server/sources/bilibili.mjs'
import { sdk } from '../dist/vendor/amagi/index.mjs'
import { Readable, PassThrough } from 'node:stream'
import { Store } from '../src/server/store.mjs'
import { MediaCache, runFfmpeg } from '../src/server/media.mjs'
import { ensureFfmpeg } from '../src/runtime/ffmpeg-runtime.mjs'
import { qualify } from '../src/server/sources/ids.mjs'

const season = { season_id: 2251, title: 'Test series', episodes: [{ id: 50188, cid: 77345, title: '1', long_title: 'First' }] }
const video = (id, bandwidth, codec = 'avc1.640028') => ({ id, bandwidth, codecs: codec,
  base_url: 'https://v.bilivideo.com/track-' + id + '.m4s' })
async function fixture(t, { cookie = '', vip = false, delay = false } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'bilibili-premium-'))
  const calls = [], controller = new AbortController(), options = { vip, delay, cookie }
  const context = { dataDir: root, signal: controller.signal,
    mediaFetcher(headers) {
      assert.equal(Object.keys(headers).some(name => name.toLowerCase() === 'cookie'), false)
      return async () => { throw Error('not requested') }
    },
    async fetch(input, init) {
      const url = new URL(input)
      assert.equal(url.hostname, 'api.bilibili.com')
      assert.equal(init.headers.Cookie === options.cookie || (!options.cookie && init.headers.Cookie === undefined), true)
      if (options.delay) await new Promise(resolve => setTimeout(resolve, 5))
      if (init.signal?.aborted) throw Error('aborted')
      calls.push({ path: url.pathname, params: url.searchParams })
      if (url.pathname.endsWith('/nav')) {
        if (options.onNav) await options.onNav(init)
        if (options.navError) return Response.json({ code: options.navError })
        return Response.json({ code: 0, data: { isLogin: options.loggedIn !== false, vipStatus: options.vip ? 1 : 0,
          wbi_img: { img_url: 'https://i0.hdslb.com/bfs/wbi/' + 'a'.repeat(32) + '.png',
            sub_url: 'https://i0.hdslb.com/bfs/wbi/' + 'b'.repeat(32) + '.png' } } })
      }
      if (url.pathname.endsWith('/season')) return Response.json({ code: 0, result: season })
      if (url.pathname.endsWith('/playurl')) {
        if (options.playError) return Response.json({ code: options.playError })
        return Response.json({ code: 0, result: {
          timelength: 1436992, is_preview: options.preview ? 1 : 0, is_drm: !!options.drm,
          dash: { video: options.tracks || [video(32, 250000), video(64, 600000),
            ...(options.vip ? [video(80, 900000), video(120, 4000000), video(127, 500000, 'hev1.test')] : [])],
          audio: [{ bandwidth: 64000, codecs: 'mp4a.40.2', base_url: 'https://a.bilivideo.com/audio.m4s' }] },
        } })
      }
      throw Error('unexpected API')
    },
  }
  const provider = new BilibiliSource(context, { cookie })
  defer(t, async () => { provider.dispose(); await rm(root, { recursive: true, force: true }) })
  return { root, provider, calls, options, controller }
}
test('the real SDK performs both native membership and WBI checks through the bounded transport', async t => {
  const f = await fixture(t, { cookie: 'synthetic-premium', vip: true })
  const playback = await f.provider.resolvePlayback('2251:50188')
  assert.equal(f.calls.filter(call => call.path.endsWith('/nav')).length, 2)
  const params = f.calls.find(call => call.path.endsWith('/playurl')).params
  assert.equal(params.get('fnval'), '4048')
  assert.equal(params.get('fourk'), '1')
  assert.equal(params.has('w_rid'), true); assert.equal(params.has('wts'), true)
  assert.equal(params.get('platform'), null); assert.equal(params.get('qn'), null)
  assert.equal(playback.candidates[0].video.url.endsWith('track-80.m4s'), true)
  assert.equal(playback.candidates.every(track => !track.video.url.includes('track-120.') && !track.video.url.includes('track-127.')), true)
})
test('ordinary signed-in accounts retain the SDK native non-premium request and anonymous mode is unchanged', async t => {
  const signed = await fixture(t, { cookie: 'synthetic-standard' })
  const playback = await signed.provider.resolvePlayback('2251:50188')
  const params = signed.calls.find(call => call.path.endsWith('/playurl')).params
  assert.equal(params.get('qn'), '64'); assert.equal(params.get('fnval'), '16')
  assert.equal(params.has('w_rid'), true); assert.equal(params.has('fourk'), false)
  assert.equal(playback.candidates[0].video.url.endsWith('track-64.m4s'), true)
  const anonymous = await fixture(t)
  const initial = await anonymous.provider.resolvePlayback('2251:50188')
  const h5 = anonymous.calls.find(call => call.path.endsWith('/playurl')).params
  assert.equal(anonymous.calls.some(call => call.path.endsWith('/nav')), false)
  assert.equal(h5.get('platform'), 'html5'); assert.equal(h5.get('fnval'), '16'); assert.equal(h5.get('qn'), '32')
  assert.equal(initial.candidates[0].video.url.endsWith('track-32.m4s'), true)
})
test('concurrent SDK accounts cannot exchange transports or credentials', async t => {
  const premium = await fixture(t, { cookie: 'synthetic-account-a', vip: true, delay: true })
  const regular = await fixture(t, { cookie: 'synthetic-account-b', delay: true })
  const [a, b] = await Promise.all([premium.provider.resolvePlayback('2251:50188'), regular.provider.resolvePlayback('2251:50188')])
  assert.equal(a.candidates[0].video.url.endsWith('track-80.m4s'), true)
  assert.equal(b.candidates[0].video.url.endsWith('track-64.m4s'), true)
  assert.equal(premium.calls.filter(call => call.path.endsWith('/nav')).length, 2)
  assert.equal(regular.calls.filter(call => call.path.endsWith('/nav')).length, 2)
})
test('SDK methods without a host transport fail closed', async () => {
  assert.throws(() => sdk.fetchBangumiStreamUrl({ ep_id: 'ep1', cid: 1 }, 'synthetic', {}), /transport/)
})
test('membership checks remain cancellable and native signing errors do not fall back to anonymous playback', async t => {
  const expired = await fixture(t, { cookie: 'synthetic-expired' })
  expired.options.navError = -101
  await assert.rejects(expired.provider.resolvePlayback('2251:50188'), /需要登录/)
  assert.equal(expired.calls.some(call => call.path.endsWith('/playurl')), false)
  const loggedOut = await fixture(t, { cookie: 'synthetic-signed-out' })
  loggedOut.options.loggedIn = false
  await assert.rejects(loggedOut.provider.resolvePlayback('2251:50188'), /需要登录/)
  assert.equal(loggedOut.calls.some(call => call.path.endsWith('/playurl')), false)
  const cancelled = await fixture(t, { cookie: 'synthetic-cancelled', vip: true })
  cancelled.options.onNav = async () => { cancelled.controller.abort() }
  await assert.rejects(cancelled.provider.resolvePlayback('2251:50188'), /取消/)
  assert.equal(cancelled.calls.some(call => call.path.endsWith('/playurl')), false)
})
test('a premium account still requires rights and a full non-DRM stream', async t => {
  for (const [patch, message] of [[{ preview: true }, /试看/], [{ drm: true }, /DRM/], [{ playError: -10403 }, /权益/]]) {
    const f = await fixture(t, { cookie: 'synthetic-premium', vip: true })
    Object.assign(f.options, patch)
    await assert.rejects(f.provider.resolvePlayback('2251:50188'), message)
  }
})
test('member quality falls back within the combined video/audio budget rather than rejecting the whole episode', async t => {
  const f = await fixture(t, { cookie: 'synthetic-premium', vip: true })
  f.options.tracks = [video(80, 4000000), video(64, 500000)]
  const playback = await f.provider.resolvePlayback('2251:50188')
  assert.equal(playback.candidates[0].video.url.endsWith('track-64.m4s'), true)
})
test('login replaces a cached preview error, muxes the member tracks, and logout cannot reuse member media', async t => {
  await ensureFfmpeg()
  const f = await fixture(t)
  const store = new Store(join(f.root, 'host')); defer(t, () => store.close())
  const input = fileURLToPath(new URL('./fixtures/avc-aac.mp4', import.meta.url))
  const v = join(f.root, 'video.mp4'), a = join(f.root, 'audio.mp4')
  await runFfmpeg(['-i', input, '-map', '0:v:0', '-an', '-c', 'copy', v])
  await runFfmpeg(['-i', input, '-map', '0:a:0', '-vn', '-c', 'copy', a])
  const fetched = []
  f.provider.fetchMedia = async url => {
    fetched.push(new URL(url).pathname)
    return { body: Readable.from([await readFile(url.includes('/audio.') ? a : v)]), limit: new PassThrough() }
  }
  const id = qualify('bilibili', '2251:50188', 'episode')
  const cache = new MediaCache(store, () => f.provider.resolvePlayback('2251:50188'), {
    revision: () => f.provider.auth.revision(),
  })
  async function settle() {
    for (let i = 0; i < 400; i++) {
      const result = cache.prepare(id)
      if (result.status !== 'preparing') return result
      await new Promise(resolve => setTimeout(resolve, 30))
    }
    throw Error('cache preparation timed out')
  }
  f.options.preview = true
  assert.equal((await settle()).status, 'error')
  f.options.preview = false; f.options.vip = true; f.options.cookie = 'synthetic-premium'
  f.provider.auth.credentials.save(f.options.cookie)
  assert.equal((await settle()).status, 'ready')
  assert.equal(fetched.includes('/track-80.m4s'), true)
  await runFfmpeg(['-i', cache.path(id), '-map', '0:v:0', '-map', '0:a:0', '-t', '0.2', '-f', 'null', '-'])
  f.provider.auth.logout(); f.options.cookie = ''; f.options.preview = true
  assert.equal((await settle()).status, 'error')
})
test('the media cache migration preserves existing Hongguo files and cache hits', async t => {
  const root = await mkdtemp(join(tmpdir(), 'hongguo-cache-migration-'))
  defer(t, () => rm(root, { recursive: true, force: true }))
  const store = new Store(root); defer(t, () => store.close())
  store.db.exec(`CREATE TABLE media(id TEXT PRIMARY KEY,status TEXT,owner TEXT,expires INTEGER,accessed INTEGER,
    size INTEGER DEFAULT 0,codec TEXT DEFAULT '',reason TEXT DEFAULT '',hold_until INTEGER DEFAULT 0)`)
  await mkdir(join(root, 'media'))
  await copyFile(new URL('./fixtures/avc-aac.mp4', import.meta.url), join(root, 'media/hg-1.mp4'))
  store.db.prepare("INSERT INTO media(id,status,codec) VALUES('hg-1','ready','h264')").run()
  const cache = new MediaCache(store, () => assert.fail('an existing Hongguo cache must not be downloaded again'))
  assert.equal(cache.prepare('hg-1').status, 'ready')
})
test('an account change during media preparation prevents the old result from being published', async t => {
  await ensureFfmpeg()
  const root = await mkdtemp(join(tmpdir(), 'bilibili-cache-account-race-'))
  defer(t, () => rm(root, { recursive: true, force: true }))
  const store = new Store(root); defer(t, () => store.close())
  let revision = 'old-account', release, started
  const gate = new Promise(resolve => { release = resolve }), downloading = new Promise(resolve => { started = resolve })
  const bytes = await readFile(new URL('./fixtures/avc-aac.mp4', import.meta.url))
  const id = qualify('bilibili', '2251:50188', 'episode')
  const cache = new MediaCache(store, async () => ({ candidates: [{ kind: 'file', codec: 'h264', url: 'fixture' }],
    fetchMedia: async () => { started(); await gate; return { body: Readable.from([bytes]), limit: new PassThrough() } },
  }), { revision: () => revision })
  assert.equal(cache.prepare(id).status, 'preparing')
  await downloading; revision = 'new-account'; release()
  for (let i = 0; i < 400 && store.db.prepare('SELECT id FROM media WHERE id=?').get(id); i++)
    await new Promise(resolve => setTimeout(resolve, 30))
  assert.equal(!!store.db.prepare('SELECT id FROM media WHERE id=?').get(id), false)
  await assert.rejects(access(cache.path(id)))
})
