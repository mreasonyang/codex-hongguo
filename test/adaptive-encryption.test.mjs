import test from 'node:test'
import assert from 'node:assert/strict'
import { randomBytes, createCipheriv } from 'node:crypto'
import { mkdtemp, readFile, writeFile, mkdir, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { Parser } from 'm3u8-parser'
import { prepareAdaptive } from '../src/server/adaptive.mjs'
import { MediaCache, runFfmpeg, cdn } from '../src/server/media.mjs'
import { ensureFfmpeg } from '../src/runtime/ffmpeg-runtime.mjs'
import { Store } from '../src/server/store.mjs'
import { PlayerError } from '../src/server/errors.mjs'

await ensureFfmpeg()
async function fixture(t, mode) {
  const dir = await mkdtemp(join(tmpdir(), 'hongguo-aes-hls-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  const plain = join(dir, 'plain'); await mkdir(plain)
  await runFfmpeg(['-stream_loop', '3', '-i', new URL('fixtures/avc-aac.mp4', import.meta.url).pathname,
    '-t', '4', '-c', 'copy', '-f', 'hls', '-hls_time', '1', '-hls_playlist_type', 'vod', 'index.m3u8'], null, false, plain)
  const parser = new Parser(); parser.push(await readFile(join(plain, 'index.m3u8'), 'utf8')); parser.end()
  const resources = new Map(), keys = [randomBytes(16), randomBytes(16)], iv = randomBytes(16)
  const original = parser.manifest.segments
  let text = '#EXTM3U\n#EXT-X-VERSION:3\n#EXT-X-TARGETDURATION:2\n#EXT-X-MEDIA-SEQUENCE:17\n'
  for (const [i, segment] of original.entries()) {
    const key = keys[mode.includes('rotation') ? i % 2 : 0]
    const effectiveIV = mode === 'explicit' ? iv : Buffer.alloc(16)
    if (mode !== 'explicit') effectiveIV.writeBigUInt64BE(BigInt(17 + i), 8)
    const cipher = createCipheriv('aes-128-cbc', key, effectiveIV)
    const bytes = await readFile(join(plain, segment.uri))
    resources.set('/seg' + i + '.ts', Buffer.concat([cipher.update(bytes), cipher.final()]))
    const keyPath = mode === 'same-uri-rotation' ? '/key' : '/key' + (mode === 'rotation' ? i % 2 : 0)
    resources.set(keyPath, key)
    text += `#EXT-X-KEY:METHOD=AES-128,URI="${keyPath}"${mode === 'explicit' ? ',IV=0x' + iv.toString('hex') : ''}\n#EXTINF:${segment.duration},\n/seg${i}.ts\n`
  }
  text += '#EXT-X-ENDLIST\n'; resources.set('/index.m3u8', Buffer.from(text))
  let keyReads = 0
  const fetcher = async url => {
    const path = new URL(url).pathname
    let bytes = resources.get(path)
    if (path.startsWith('/key')) {
      bytes = mode === 'same-uri-rotation' ? keys[keyReads % 2] : bytes
      keyReads++
    }
    assert.ok(bytes, 'fixture asset exists')
    return { body: new Response(bytes).body, url: String(url) }
  }
  return { dir, resources, fetcher, keyReads: () => keyReads, count: original.length }
}
for (const mode of ['explicit', 'sequence', 'rotation', 'same-uri-rotation']) test('AES-128 ' + mode + ' HLS remuxes and decodes audio/video', async t => {
  const f = await fixture(t, mode), output = join(f.dir, 'output.mp4'), tracks = join(f.dir, 'tracks'); await mkdir(tracks)
  await prepareAdaptive('https://fixture.invalid/index.m3u8', tracks, output, { cdn: f.fetcher, run: runFfmpeg, codec: 'h264', budget: 4 * 1024 * 1024 })
  await runFfmpeg(['-xerror', '-protocol_whitelist', 'file', '-i', output, '-map', '0:v:0', '-map', '0:a:0', '-f', 'null', '-'])
  assert.equal(f.keyReads(), f.count)
})
test('encrypted HLS rejects unsupported encryption, encrypted MAP/ranges and invalid keys', async t => {
  const f = await fixture(t, 'explicit'), original = f.resources.get('/index.m3u8').toString()
  const cases = [
    original.replaceAll('METHOD=AES-128', 'METHOD=SAMPLE-AES'),
    original.replace('METHOD=AES-128', 'METHOD=AES-128,KEYFORMAT="com.example.drm"'),
    original.replace('#EXTINF:', '#EXT-X-MAP:URI="init.mp4"\n#EXTINF:'),
    original.replace('#EXTINF:', '#EXT-X-BYTERANGE:16@0\n#EXTINF:'),
    original.replace('#EXTINF:', '#EXT-X-DISCONTINUITY\n#EXTINF:'),
    original.replace('#EXT-X-ENDLIST', ''),
  ]
  for (const [i, manifest] of cases.entries()) {
    f.resources.set('/index.m3u8', Buffer.from(manifest))
    const dir = join(f.dir, 'bad' + i); await mkdir(dir)
    await assert.rejects(prepareAdaptive('https://fixture.invalid/index.m3u8', dir, join(f.dir, 'bad.mp4'), {
      cdn: f.fetcher, run: async () => assert.fail('unsupported manifest reached FFmpeg'), budget: 4 * 1024 * 1024,
    }))
  }
  f.resources.set('/index.m3u8', Buffer.from(original))
  f.resources.set('/key0', randomBytes(15))
  const dir = join(f.dir, 'bad-key'); await mkdir(dir)
  await assert.rejects(prepareAdaptive('https://fixture.invalid/index.m3u8', dir, join(f.dir, 'bad.mp4'), {
    cdn: f.fetcher, run: async () => assert.fail('bad key reached FFmpeg'), budget: 4 * 1024 * 1024,
  }))
})
async function settled(cache, id) {
  for (let i = 0; i < 300; i++) {
    const result = cache.prepare(id)
    if (result.status !== 'preparing') return result
    await new Promise(resolve => setTimeout(resolve, 10))
  }
  throw Error('fixture timed out')
}
test('MediaCache refreshes an expired authorization once and retains both source namespaces', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'hongguo-auth-refresh-')), store = new Store(dir)
  t.after(async () => { store.close(); await rm(dir, { recursive: true, force: true }) })
  const bytes = await readFile(new URL('fixtures/avc-aac.mp4', import.meta.url))
  let resolves = 0, attempts = 0
  const cache = new MediaCache(store, async id => {
    assert.ok(id === 'hg-1' || id === 'p.demo.e.MQ'); resolves++
    return { candidates: [{ kind: 'file', url: 'https://fixture.invalid/video' }], fetchMedia: async () => {
      attempts++
      if (attempts === 1) { const e = new PlayerError('expired', 503); e.code = 'MEDIA_EXPIRED'; throw e }
      return { body: new Response(bytes).body, limit: new (await import('node:stream')).PassThrough() }
    } }
  })
  assert.equal((await settled(cache, 'hg-1')).status, 'ready')
  assert.equal(resolves, 2)
  assert.equal((await settled(cache, 'p.demo.e.MQ')).status, 'ready')
  assert.notEqual(cache.path('hg-1'), cache.path('p.demo.e.MQ'))
  assert.equal(resolves, 3)
  assert.equal(cache.prepare('hg-1').status, 'ready')
  const denied = new MediaCache(store, async () => ({ candidates: [{ kind: 'file', url: 'https://fixture.invalid/x' }],
    fetchMedia: async () => { const e = new PlayerError('expired'); e.code = 'MEDIA_EXPIRED'; throw e } }))
  let deniedCount = 0
  const originalResolve = denied.resolve; denied.resolve = async (...args) => { deniedCount++; return originalResolve(...args) }
  assert.equal((await settled(denied, 'p.demo.e.Mg')).status, 'error')
  assert.equal(deniedCount, 2)
})
