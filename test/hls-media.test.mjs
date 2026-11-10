import test from 'node:test'
import assert from 'node:assert/strict'
import { createCipheriv } from 'node:crypto'
import { mkdtemp, rm, writeFile, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { Readable } from 'node:stream'
import { DashMedia } from '../src/server/dash-media.mjs'
import { ensureFfmpeg } from '../src/runtime/ffmpeg-runtime.mjs'
import { runFfmpeg } from '../src/server/media.mjs'
import { defer } from './cleanup.mjs'

async function fixture(t, { maxBytes, rotation = false, count = 200 } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'hls-on-demand-'))
  defer(t, () => rm(root, { recursive: true, force: true }))
  const media = new DashMedia(root, { maxBytes }); defer(t, () => media.close())
  // These keys encrypt only deterministic synthetic test data.
  const keys = [Buffer.alloc(16, 7), Buffer.alloc(16, 9)], requested = []
  const plain = i => Buffer.alloc(32, i % 256)
  const playlist = ['#EXTM3U', '#EXT-X-TARGETDURATION:5', '#EXT-X-MEDIA-SEQUENCE:42',
    ...Array.from({ length: count }, (_, i) => [
      ...(i === 0 || (rotation && i === 100) ? ['#EXT-X-KEY:METHOD=AES-128,URI="same-key"'] : []),
      '#EXTINF:5,', 'original-' + i + '.ts',
    ]).flat(), '#EXT-X-ENDLIST'].join('\n')
  let keyCalls = 0
  const descriptor = { candidates: [{ kind: 'hls', codec: 'h264', url: 'https://fixture.invalid/master.m3u8' }],
    fetchMedia: async (url, budget, _timeout, _redirects, range, signal) => {
      assert.equal(range, undefined); assert.equal(signal.aborted, false)
      const path = new URL(url).pathname; requested.push(path)
      let bytes
      if (path === '/master.m3u8') bytes = Buffer.from('#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=1000,CODECS="avc1.64001e,mp4a.40.2"\nindex.m3u8\n')
      else if (path === '/index.m3u8') bytes = Buffer.from(playlist)
      else if (path === '/same-key') bytes = keys[rotation && keyCalls++ ? 1 : 0]
      else {
        const i = Number(/original-(\d+)\.ts$/.exec(path)?.[1]); assert.ok(Number.isSafeInteger(i))
        const iv = Buffer.alloc(16); iv.writeBigUInt64BE(BigInt(42 + i), 8)
        const cipher = createCipheriv('aes-128-cbc', keys[rotation && i >= 100 ? 1 : 0], iv)
        bytes = Buffer.concat([cipher.update(plain(i)), cipher.final()])
      }
      assert.ok(bytes.length <= budget)
      return { body: Readable.from([bytes]), url: String(url) }
    } }
  let revision = 'a'
  const prepare = (retry = false, preload = false) => media.prepare('episode', () => descriptor, () => revision, retry, preload)
  const ready = async (preload = false) => {
    prepare(false, preload); await media.entries.get('episode').job
    const result = prepare(); assert.equal(result.status, 'ready', result.reason); return result
  }
  return { root, media, requested, descriptor, plain, prepare, ready, changeRevision: () => { revision = 'b' } }
}

test('long AES HLS prepares only its index and fetches the selected fragment on demand', async t => {
  const f = await fixture(t), ready = await f.ready()
  assert.equal(ready.format, 'hls'); assert.equal(ready.durationMs, 1000000)
  assert.deepEqual(f.requested, ['/master.m3u8', '/index.m3u8'])
  assert.equal(f.media.bytes, 0)
  assert.doesNotMatch(ready.manifest, /https?:|EXT-X-KEY|same-key|original-/)
  assert.match(ready.manifest, /#EXT-X-ENDLIST/)
  const part = await f.media.chunk('episode', ready.stream, 'seg00150.ts', 0)
  assert.deepEqual(Buffer.from(part.bytes, 'base64'), f.plain(150))
  assert.equal(part.size, 32)
  assert.deepEqual(f.requested.slice(2).sort(), ['/original-150.ts', '/same-key'])
  await f.media.chunk('episode', ready.stream, 'seg00150.ts', 0)
  assert.equal(f.requested.length, 4)
  await assert.rejects(f.media.chunk('episode', ready.stream, '../same-key', 0))
  await assert.rejects(f.media.chunk('episode', 'other-stream', 'seg00150.ts', 0))
})

test('concurrent fragments share one key declaration, while same-URI key rotations remain distinct', async t => {
  const f = await fixture(t, { rotation: true }), ready = await f.ready()
  const first = await Promise.all([0, 1].map(i => f.media.chunk('episode', ready.stream, 'seg' + String(i).padStart(5, '0') + '.ts', 0)))
  assert.equal(f.requested.filter(p => p === '/same-key').length, 1)
  first.forEach((p, i) => assert.deepEqual(Buffer.from(p.bytes, 'base64'), f.plain(i)))
  const rotated = await f.media.chunk('episode', ready.stream, 'seg00100.ts', 0)
  assert.deepEqual(Buffer.from(rotated.bytes, 'base64'), f.plain(100))
  assert.equal(f.requested.filter(p => p === '/same-key').length, 2)
})

test('fragment caches stay bounded, revision changes revoke streams, and disposal zeroes held keys', async t => {
  const f = await fixture(t, { maxBytes: 50 }), ready = await f.ready()
  for (const asset of ['seg00000.ts', 'seg00001.ts', 'seg00002.ts']) await f.media.chunk('episode', ready.stream, asset, 0)
  assert.ok(f.media.bytes <= 50)
  const heldKeys = await Promise.all(f.media.entries.get('episode').keys.values())
  f.changeRevision()
  await assert.rejects(f.media.chunk('episode', ready.stream, 'seg00002.ts', 0), /失效/)
  f.media.close(); await Promise.resolve()
  assert.ok(heldKeys.every(key => key.every(byte => byte === 0)))
})

test('preloading warms only two HLS segments and never downloads the entire episode', async t => {
  const f = await fixture(t), ready = await f.ready(true), entry = f.media.entries.get('episode')
  for (let i = 0; (entry.jobs.size || f.requested.length < 5) && i < 100; i++) await new Promise(r => setTimeout(r, 5))
  assert.equal(ready.format, 'hls')
  assert.deepEqual(f.requested.filter(p => p.endsWith('.ts')), ['/original-0.ts', '/original-1.ts'])
  assert.equal(f.requested.filter(p => p === '/same-key').length, 1)
})

test('live or unsupported HLS encryption is rejected before any key or segment is fetched', async t => {
  for (const body of ['#EXTM3U\n#EXTINF:5,\nsegment.ts\n',
    '#EXTM3U\n#EXT-X-KEY:METHOD=SAMPLE-AES,URI="private"\n#EXTINF:5,\nsegment.ts\n#EXT-X-ENDLIST']) {
    const f = await fixture(t)
    let calls = 0
    f.descriptor.fetchMedia = async url => { calls++; return { url, body: Readable.from([Buffer.from(body)]) } }
    f.prepare(); await f.media.entries.get('episode').job
    assert.equal(f.prepare().status, 'error'); assert.equal(calls, 1)
  }
})

test('real encrypted MPEG-TS fragments decode from the beginning and a later keyframe', async t => {
  await ensureFfmpeg()
  const f = await fixture(t), fixturePath = fileURLToPath(new URL('./fixtures/avc-aac.mp4', import.meta.url))
  await runFfmpeg(['-stream_loop', '-1', '-i', fixturePath, '-t', '8', '-c:v', 'libx264', '-preset', 'ultrafast',
    '-force_key_frames', 'expr:gte(t,n_forced*2)', '-c:a', 'aac', '-f', 'hls', '-hls_time', '2',
    '-hls_list_size', '0', '-hls_segment_filename', join(f.root, 'source-%03d.ts'), join(f.root, 'source.m3u8')])
  const key = Buffer.alloc(16, 11), requested = []
  const body = (await readFile(join(f.root, 'source.m3u8'), 'utf8')).replace('#EXTM3U', '#EXTM3U\n#EXT-X-KEY:METHOD=AES-128,URI="key"')
  f.descriptor.candidates[0].url = 'https://fixture.invalid/index.m3u8'
  f.descriptor.fetchMedia = async url => {
    const path = new URL(url).pathname; requested.push(path)
    let bytes
    if (path === '/index.m3u8') bytes = Buffer.from(body)
    else if (path === '/key') bytes = key
    else {
      const i = Number(/source-(\d+)\.ts/.exec(path)[1]), iv = Buffer.alloc(16)
      iv.writeBigUInt64BE(BigInt(i), 8)
      const cipher = createCipheriv('aes-128-cbc', key, iv)
      bytes = Buffer.concat([cipher.update(await readFile(join(f.root, path.slice(1)))), cipher.final()])
    }
    return { body: Readable.from([bytes]), url }
  }
  const ready = await f.ready()
  for (const index of [0, 2]) {
    const asset = 'seg' + String(index).padStart(5, '0') + '.ts', buffers = []
    let offset = 0, size
    do {
      const chunk = await f.media.chunk('episode', ready.stream, asset, offset)
      const bytes = Buffer.from(chunk.bytes, 'base64'); buffers.push(bytes); offset += bytes.length; size = chunk.size
    } while (offset < size)
    const output = join(f.root, 'decode.ts'); await writeFile(output, Buffer.concat(buffers))
    await runFfmpeg(['-xerror', '-i', output, '-map', '0:v:0', '-map', '0:a:0', '-f', 'null', '-'])
  }
  assert.deepEqual(requested.filter(path => path.endsWith('.ts')), ['/source-000.ts', '/source-002.ts'])
})
