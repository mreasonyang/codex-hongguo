import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { Readable, PassThrough } from 'node:stream'
import { DashMedia, byteRange, sidxSegments } from '../src/server/dash-media.mjs'
import { runFfmpeg } from '../src/server/media.mjs'
import { ensureFfmpeg } from '../src/runtime/ffmpeg-runtime.mjs'
import { defer } from './cleanup.mjs'

function sidx({ version = 0, first = 0, earliest = 0, refs = [20, 30, 40], scale = 1000 } = {}) {
  const bytes = Buffer.alloc((version ? 40 : 32) + refs.length * 12)
  bytes.writeUInt32BE(bytes.length); bytes.write('sidx', 4); bytes[8] = version
  bytes.writeUInt32BE(1, 12); bytes.writeUInt32BE(scale, 16)
  let p = 20
  for (const n of [earliest, first]) {
    if (version) { bytes.writeBigUInt64BE(BigInt(n), p); p += 8 }
    else { bytes.writeUInt32BE(n, p); p += 4 }
  }
  bytes.writeUInt16BE(refs.length, p + 2); p += 4
  for (const length of refs) { bytes.writeUInt32BE(length, p); bytes.writeUInt32BE(5000, p + 4); p += 12 }
  return bytes
}
test('SIDX v0/v1 uses absolute byte ranges and validates duration, nesting and integer limits', () => {
  assert.deepEqual(byteRange('10-19'), { offset: 10, length: 10 })
  for (const bad of ['2-1', '-1-2', '0-9007199254740992', '0-1048576']) assert.throws(() => byteRange(bad))
  for (const version of [0, 1]) {
    const bytes = sidx({ version, first: 17 })
    const rows = sidxSegments(bytes, 100, 15000)
    assert.deepEqual(rows.map(r => r.time), [0, 5, 10])
    assert.equal(rows[0].offset, 100 + bytes.length + 17)
    assert.equal(rows[2].offset, rows[0].offset + 50)
  }
  for (const bytes of [sidx({ refs: [0x80000001] }), sidx({ scale: 0 }), sidx().subarray(0, 20),
    sidx({ version: 1, first: 9007199254740992n })]) assert.throws(() => sidxSegments(bytes, 100, 15000))
  assert.throws(() => sidxSegments(sidx(), 100, 60000))
})
async function fixture(t, options) {
  const root = await mkdtemp(join(tmpdir(), 'dash-media-'))
  defer(t, () => rm(root, { recursive: true, force: true }))
  const media = new DashMedia(root, options); defer(t, () => media.close())
  const index = sidx(), file = Buffer.concat([Buffer.alloc(16), index, Buffer.alloc(90)])
  const requested = []
  const descriptor = { durationMs: 15000, candidates: [{ kind: 'tracks',
    video: { url: 'video', initialization: '0-15', indexRange: '16-' + (15 + index.length), mime: 'video/mp4; codecs="avc1.64001e"' },
    audio: { url: 'audio', initialization: '0-15', indexRange: '16-' + (15 + index.length), mime: 'audio/mp4; codecs="mp4a.40.2"' },
  }], fetchMedia: async (url, budget, _timeout, _redirects, range, signal) => {
    assert.ok(range, 'whole-file downloads are forbidden on the on-demand path')
    assert.ok(!signal.aborted)
    assert.equal(budget, range.length)
    requested.push({ url, ...range })
    return { body: Readable.from([file.subarray(range.offset, range.offset + range.length)]), limit: new PassThrough() }
  } }
  let revision = 'a'
  const prepare = (id = 'episode', retry = false) => media.prepare(id, () => descriptor, () => revision, retry, false)
  const ready = async (id = 'episode') => {
    let r = prepare(id)
    for (let i = 0; r.status === 'preparing' && i < 100; i++) { await new Promise(r => setTimeout(r, 5)); r = prepare(id) }
    assert.equal(r.status, 'ready', r.reason); return r
  }
  return { root, media, descriptor, requested, prepare, ready, changeRevision: () => { revision = 'b' } }
}
test('preparation reads only indexes; fragments and long-distance seeks fetch only their own ranges', async t => {
  const f = await fixture(t), ready = await f.ready()
  assert.equal(ready.format, 'dash')
  assert.equal(f.requested.length, 2)
  const manifest = JSON.parse(ready.manifest)
  assert.doesNotMatch(ready.manifest, /url|offset|initialization.*https|cookie/)
  const track = manifest.tracks[0], last = track.segments.at(-1)
  const first = await f.media.chunk('episode', ready.stream, last.asset, 0)
  assert.equal(first.size, 40)
  assert.equal(f.requested.length, 3)
  assert.equal(f.requested.at(-1).offset, 16 + sidx().length + 50)
  await f.media.chunk('episode', ready.stream, last.asset, 0)
  assert.equal(f.requested.length, 3, 'an already downloaded fragment is reused')
  await assert.rejects(f.media.chunk('episode', ready.stream, '../private', 0))
  await assert.rejects(f.media.chunk('episode', 'other-panel-stream', last.asset, 0))
  assert.equal(f.requested.length, 3)
})
test('changed account revisions revoke previously prepared fragments and pending reads', async t => {
  const f = await fixture(t), ready = await f.ready()
  f.changeRevision()
  await assert.rejects(f.media.chunk('episode', ready.stream, 'video-init.mp4', 0), /失效/)
  const next = await f.ready()
  assert.notEqual(next.stream, ready.stream)
  await assert.rejects(f.media.chunk('episode', ready.stream, 'video-init.mp4', 0), /失效/)
})
test('fragment cache is bounded and full-file candidates use the existing compatibility path', async t => {
  const f = await fixture(t, { maxBytes: 50 }), ready = await f.ready()
  await f.media.chunk('episode', ready.stream, 'video-00000.m4s', 0)
  await f.media.chunk('episode', ready.stream, 'video-00001.m4s', 0)
  await f.media.chunk('episode', ready.stream, 'video-00002.m4s', 0)
  assert.ok(f.media.bytes <= 50)
  f.descriptor.candidates = [{ kind: 'file' }]
  let result = f.prepare('legacy')
  await new Promise(r => setTimeout(r, 10)); result = f.prepare('legacy')
  assert.equal(result.status, 'fallback')
})
test('next-episode preloading warms only initialization and two fragments per track', async t => {
  const f = await fixture(t)
  f.media.prepare('warm', () => f.descriptor, () => 'a', false, true)
  await f.ready('warm')
  for (let i = 0; f.media.entries.get('warm').jobs.size && i < 100; i++) await new Promise(r => setTimeout(r, 5))
  assert.equal(f.requested.length, 8)
  assert.equal(f.media.entries.get('warm').viewers.size, 0)
  assert.ok(!f.requested.some(range => range.offset === 16 + sidx().length + 50))
})

test('real fragmented AVC/AAC MP4 ranges decode from the beginning and a later keyframe without a whole download', async t => {
  await ensureFfmpeg()
  const f = await fixture(t), fixtureURL = new URL('./fixtures/avc-aac.mp4', import.meta.url)
  const tracks = []
  for (const [i, type] of ['v', 'a'].entries()) {
    const path = join(f.root, 'track' + i + '.mp4')
    await runFfmpeg(['-stream_loop', '-1', '-i', fileURLToPath(fixtureURL), '-t', '16', '-map', '0:' + type + ':0',
      ...(type === 'v' ? ['-c:v', 'libx264', '-preset', 'ultrafast', '-force_key_frames', 'expr:gte(t,n_forced*2)'] : ['-c:a', 'copy']),
      '-frag_duration', '2000000',
      '-movflags', '+dash+global_sidx+frag_keyframe+empty_moov+default_base_moof', path])
    const bytes = await readFile(path)
    let offset = 0
    while (bytes.toString('ascii', offset + 4, offset + 8) !== 'sidx') offset += bytes.readUInt32BE(offset)
    const length = bytes.readUInt32BE(offset)
    tracks.push({ bytes, initialization: '0-' + (offset - 1), indexRange: offset + '-' + (offset + length - 1) })
  }
  f.descriptor.candidates[0].video = { ...f.descriptor.candidates[0].video, ...tracks[0] }
  f.descriptor.candidates[0].audio = { ...f.descriptor.candidates[0].audio, ...tracks[1] }
  f.descriptor.durationMs = 16000
  let fetched = 0
  f.descriptor.fetchMedia = async (name, budget, _timeout, _r, range) => {
    assert.ok(range); fetched += range.length
    const bytes = tracks[name === 'video' ? 0 : 1].bytes.subarray(range.offset, range.offset + range.length)
    return { body: Readable.from([bytes]), limit: new PassThrough() }
  }
  const r = await f.ready(), manifest = JSON.parse(r.manifest)
  assert.ok(fetched < tracks[0].bytes.length / 10)
  for (const [i, track] of manifest.tracks.entries()) {
    for (const segment of [track.segments[0], track.segments.at(-2)]) {
      const buffers = []
      for (const asset of [track.initialization, segment.asset]) {
        let offset = 0
        do {
          const chunk = await f.media.chunk('episode', r.stream, asset, offset)
          const bytes = Buffer.from(chunk.bytes, 'base64'); buffers.push(bytes); offset += bytes.length
          if (offset === chunk.size) break
        } while (true)
      }
      const path = join(f.root, 'decode.mp4'); await writeFile(path, Buffer.concat(buffers))
      const output = await runFfmpeg(['-i', path, '-map', i ? '0:a:0' : '0:v:0', i ? '-frames:a' : '-frames:v', '1',
        '-f', 'framehash', 'pipe:1'], null, true)
      assert.match(output.toString(), /^0,\s/m, 'an actual decoded audio/video frame is required')
    }
  }
})
