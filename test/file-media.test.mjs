import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { Readable } from 'node:stream'
import { FileMedia } from '../src/server/file-media.mjs'
import { movieIndex, windowRanges } from '../src/server/mp4-index.mjs'
import { runFfmpeg } from '../src/server/media.mjs'
import { ensureFfmpeg } from '../src/runtime/ffmpeg-runtime.mjs'
import { defer } from './cleanup.mjs'
import { Store } from '../src/server/store.mjs'
import { Catalog } from '../src/server/catalog.mjs'
import { Service } from '../src/server/service.mjs'
import { PanelMedia } from '../src/server/panel-media.mjs'
import { filePlayback } from '../src/server/sources/contracts.mjs'
import { PlayerError } from '../src/server/errors.mjs'

const delay = ms => new Promise(resolve => setTimeout(resolve, ms))
// Public deterministic key for this self-created fixture; never a provider key.
const key = Buffer.from(Array.from({ length: 16 }, (_, i) => i)).toString('hex')
const candidates = (url, backup_url) => filePlayback({ playback: { protected: true,
  streams: [{ url, backup_url, codec: 'h264' }] }, contentKey: { key } }).candidates
const expired = () => Object.assign(new PlayerError('Fixture media address expired'), { code: 'MEDIA_EXPIRED' })
async function fixture(t) {
  await ensureFfmpeg()
  const root = await mkdtemp(join(tmpdir(), 'hongguo-file-media-'))
  defer(t, () => rm(root, { recursive: true, force: true }))
  const path = join(root, 'encrypted.mp4')
  await runFfmpeg(['-stream_loop', '59', '-i', 'test/fixtures/avc-aac.mp4', '-t', '120',
    '-c', 'copy', '-movflags', '+faststart', '-encryption_scheme', 'cenc-aes-ctr',
    '-encryption_key', key, '-encryption_kid', '0'.repeat(32), path])
  const bytes = await readFile(path), requested = [], calls = []
  let revision = 'a', block = false, resolves = 0
  const media = new FileMedia(root, { run: async (args, control, ...rest) => {
    assert.ok(!args.some(arg => String(arg).includes(key)), 'key stays out of argv')
    assert.ok(!args.some(arg => /^https?:/.test(String(arg))), 'FFmpeg cannot contact a provider')
    calls.push(args)
    return runFfmpeg(args, control, ...rest)
  } })
  defer(t, () => media.close())
  const descriptor = { candidates: [{ kind: 'file', url: 'private-fixture', encryption: { kind: 'cenc', key } }],
    fetchMedia: async (_url, budget, _timeout, _redirects, range, signal) => {
      assert.ok(range, 'whole episode requests are forbidden')
      assert.equal(budget, range.length)
      assert.ok(range.length < bytes.length / 2, 'individual requests must stay bounded')
      assert.ok(!signal.aborted)
      requested.push({ url: _url, ...range })
      if (block) await new Promise((_, reject) => signal.addEventListener('abort', () => reject(Error('cancelled')), { once: true }))
      return { totalBytes: bytes.length, body: Readable.from([bytes.subarray(range.offset, range.offset + range.length)]) }
    } }
  const prepare = (id = 'episode', retry = false) => media.prepare(id, () => { resolves++; return descriptor }, () => revision, retry, false)
  const ready = async (id = 'episode', retry = false) => {
    let result = prepare(id, retry)
    for (let i = 0; result.status === 'preparing' && i < 500; i++) { await delay(5); result = prepare(id) }
    assert.equal(result.status, 'ready', result.reason)
    return result
  }
  return { root, bytes, media, descriptor, requested, calls, prepare, ready,
    revise: () => { revision = 'b' }, block: () => { block = true }, get resolveCalls() { return resolves } }
}
async function collect(media, ready, asset) {
  const parts = []; let offset = 0, size
  do {
    const part = await media.chunk('episode', ready.stream, asset, offset)
    size = part.size; const bytes = Buffer.from(part.bytes, 'base64'); parts.push(bytes); offset += bytes.length
  } while (offset < size)
  return Buffer.concat(parts)
}
test('encrypted MP4 starts, resumes and seeks using only requested windows, with decodable audio/video', async t => {
  const f = await fixture(t), ready = await f.ready()
  assert.equal(ready.format, 'hls')
  assert.ok(ready.manifest.includes('#EXT-X-ENDLIST'))
  assert.doesNotMatch(JSON.stringify(ready), /private-fixture|decryption_key|https?:/)
  assert.ok(!JSON.stringify(ready).includes(key))
  const initialBytes = f.requested.reduce((n, r) => n + r.length, 0)
  assert.ok(initialBytes < f.bytes.length / 4, 'prepare reads indexes only')
  for (const [asset, start] of [['seg00015.ts', 90], ['seg00000.ts', 0], ['seg00019.ts', 114]]) {
    f.requested.length = 0
    const bytes = await collect(f.media, ready, asset)
    assert.ok(f.requested.reduce((n, r) => n + r.length, 0) < f.bytes.length / 3, 'ready before the complete file is fetched')
    const out = join(f.root, asset); await writeFile(out, bytes)
    await runFfmpeg(['-xerror', '-i', out, '-map', '0:v', '-map', '0:a', '-f', 'null', '-'])
    const hash = await runFfmpeg(['-copyts', '-i', out, '-map', '0:v', '-f', 'framehash', 'pipe:1'], null, true)
    const text = hash.toString(), scale = Number(/^#tb 0: 1\/(\d+)/m.exec(text)?.[1])
    const rows = text.split('\n').filter(s => /^0,/.test(s)), pts = Number(rows[0]?.split(',')[2]) / scale
    assert.ok(rows.length / scale >= 5.5, 'requested segment contains video frames: ' + rows.length + ', pts=' + pts + ', scale=' + scale)
    assert.ok(Math.abs(pts - start) < 0.15, 'segment timestamps match the seek position')
    assert.equal(f.calls.at(-1)[f.calls.at(-1).indexOf('-ss') + 1], String(start))
    const count = f.requested.length
    await collect(f.media, ready, asset)
    assert.equal(f.requested.length, count, 'cached segments do not download again')
  }
  await assert.rejects(f.media.chunk('episode', 'unowned', 'seg00000.ts', 0))
  await assert.rejects(f.media.chunk('episode', ready.stream, '../input.mp4', 0))
  f.revise()
  await assert.rejects(collect(f.media, ready, 'seg00000.ts'), /失效/)
  const next = await f.ready(); assert.notEqual(next.stream, ready.stream)
})
test('in-flight segment reads are deduplicated and cancellation revokes a pending fetch', async t => {
  const f = await fixture(t), ready = await f.ready()
  await Promise.all([collect(f.media, ready, 'seg00010.ts'), collect(f.media, ready, 'seg00010.ts')])
  assert.equal(f.calls.length, 1)
  f.block()
  const reading = collect(f.media, ready, 'seg00011.ts')
  // Attach rejection handling before cancelling the producer.
  const rejected = assert.rejects(reading)
  await delay(30)
  const entry = f.media.entries.get('episode')
  f.media.close(); await rejected
  assert.ok(!entry.failedAssets?.size, 'cancellation does not mark playback as failed')
})
test('a primary address expiring after preparation uses its SDK-provided mirror without discarding a healthy stream', async t => {
  const f = await fixture(t), serve = f.descriptor.fetchMedia
  f.descriptor.candidates = candidates('primary', 'backup')
  let primaryExpired = false, backupReads = 0
  f.descriptor.fetchMedia = async (url, ...args) => {
    if (primaryExpired && url === 'primary') throw expired()
    if (primaryExpired && url === 'backup') backupReads++
    return serve(url, ...args)
  }
  const ready = await f.ready(); primaryExpired = true
  const bytes = await collect(f.media, ready, 'seg00015.ts')
  assert.ok(backupReads > 0, 'the selected file mirror is used for fragment reads')
  const path = join(f.root, 'mirror.ts'); await writeFile(path, bytes)
  await runFfmpeg(['-xerror', '-i', path, '-map', '0:v', '-map', '0:a', '-f', 'null', '-'])
  const retry = f.prepare('episode', true)
  assert.equal(retry.stream, ready.stream, 'successful fallback keeps the ready cache')
  assert.equal(f.resolveCalls, 1)
  const reads = f.requested.length; await collect(f.media, retry, 'seg00015.ts')
  assert.equal(f.requested.length, reads)
})
test('explicit retry after a fragment failure refreshes the descriptor and revokes the expired stream', async t => {
  const f = await fixture(t), serve = f.descriptor.fetchMedia
  f.descriptor.candidates = candidates('old-primary', 'old-backup')
  let oldExpired = false, backupAttempts = 0
  f.descriptor.fetchMedia = async (url, ...args) => {
    if (oldExpired && url.startsWith('old-')) {
      if (url === 'old-backup') backupAttempts++
      throw expired()
    }
    return serve(url, ...args)
  }
  const ready = await f.ready(), oldEntry = f.media.entries.get('episode')
  await collect(f.media, ready, 'seg00000.ts')
  oldExpired = true
  await assert.rejects(collect(f.media, ready, 'seg00015.ts'))
  assert.ok(backupAttempts > 0, 'all mirrors are exhausted before requesting new playback information')
  // A failed future fragment does not revoke already-buffered content.
  await collect(f.media, ready, 'seg00000.ts')
  f.descriptor.candidates = candidates('fresh-primary', 'fresh-backup')
  const fresh = await f.ready('episode', true)
  assert.notEqual(fresh.stream, ready.stream)
  assert.equal(f.resolveCalls, 2, 'manual retry resolves a fresh descriptor')
  assert.equal(oldEntry.abort.signal.aborted, true)
  await assert.rejects(collect(f.media, ready, 'seg00000.ts'), /失效/)
  const bytes = await collect(f.media, fresh, 'seg00015.ts'), path = join(f.root, 'refreshed.ts')
  await writeFile(path, bytes)
  await runFfmpeg(['-xerror', '-i', path, '-map', '0:v', '-map', '0:a', '-f', 'null', '-'])
  assert.ok(f.requested.some(r => r.url === 'fresh-primary'))
  assert.ok(!f.media.entries.get('episode').failedAssets?.size)
})
test('refreshing failed playback aborts old pending reads without poisoning the replacement stream', async t => {
  const f = await fixture(t), serve = f.descriptor.fetchMedia
  let phase = 'healthy', firstFailure = true, pendingStarted
  const pending = new Promise(resolve => { pendingStarted = resolve })
  f.descriptor.fetchMedia = async (url, ...args) => {
    if (phase === 'fault') {
      if (firstFailure) { firstFailure = false; throw expired() }
      const signal = args[4]; pendingStarted()
      await new Promise((_, reject) => signal.addEventListener('abort', () => reject(expired()), { once: true }))
    }
    return serve(url, ...args)
  }
  const ready = await f.ready(), oldEntry = f.media.entries.get('episode')
  await collect(f.media, ready, 'seg00000.ts')
  phase = 'fault'
  await assert.rejects(collect(f.media, ready, 'seg00010.ts'))
  const cancelled = assert.rejects(collect(f.media, ready, 'seg00011.ts'))
  await pending
  phase = 'healthy'
  const fresh = await f.ready('episode', true)
  await cancelled
  assert.notEqual(fresh.stream, ready.stream)
  assert.equal(oldEntry.abort.signal.aborted, true)
  assert.ok(!f.media.entries.get('episode').failedAssets?.size)
  await collect(f.media, fresh, 'seg00011.ts')
})
test('MP4 index rejects corrupt offsets/counts and has bounded window requests', async () => {
  const bytes = await readFile('test/fixtures/encrypted.mp4')
  let p = 0, moov
  while (p + 8 <= bytes.length) { const size = bytes.readUInt32BE(p); if (bytes.toString('ascii', p + 4, p + 8) === 'moov') moov = bytes.subarray(p, p + size); p += size }
  const index = movieIndex(moov, bytes.length)
  assert.ok(windowRanges(index, 0, 1).length)
  assert.throws(() => movieIndex(moov, 16))
  const corrupt = Buffer.from(moov), at = corrupt.indexOf(Buffer.from('stsz'))
  corrupt.writeUInt32BE(0xffffffff, at + 12)
  assert.throws(() => movieIndex(corrupt, bytes.length))
})
test('Hongguo MCP and browser playback use the indexed path and keep stream access scoped to the preparing viewer', async t => {
  const f = await fixture(t), store = new Store(join(f.root, 'store'))
  defer(t, () => store.close())
  const catalog = new Catalog(store), source = catalog.sources.get('hongguo')
  assert.equal(source.rangedFilePlayback, true)
  source.sdkCall = async method => {
    assert.equal(method, 'listEpisodes')
    return { items: [{ id: '101', number: 1, playable: true }] }
  }
  let resolves = 0
  source.resolvePlayback = async () => { resolves++; return f.descriptor }
  catalog.cache = { prepare: () => assert.fail('Hongguo must not enter the whole-file download path') }
  catalog.panelMedia = new PanelMedia(store.root); catalog.panelMedia.file = f.media
  defer(t, () => catalog.panelMedia.close())
  const svc = new Service(store, catalog), a = svc.panel(svc.open({}).panel), b = svc.panel(svc.open({}).panel)
  await svc.call(a, 'get_episodes', { seriesId: 'hg-10' })
  const before = { playing: a.playing, streams: a.streams?.size }
  await svc.call(a, 'preload_playback', { episodeId: 'hg-101' })
  assert.deepEqual({ playing: a.playing, streams: a.streams?.size }, before)
  const e = f.media.entries.get('hg-101'); await e.job
  await Promise.allSettled([...e.jobs.values()])
  const reads = f.requested.length
  const r = await svc.call(a, 'prepare_playback', { episodeId: 'hg-101', retry: true }, true)
  assert.equal(r.status, 'ready'); assert.equal(r.format, 'hls')
  assert.equal(r.stream, e.stream, 'first playback reuses a healthy preload even with retry enabled')
  assert.equal(resolves, 1)
  const args = { episodeId: 'hg-101', stream: r.stream, asset: 'seg00000.ts', offset: 0 }
  const chunk = await svc.call(a, 'read_panel_chunk', args, true)
  assert.ok(Buffer.from(chunk.bytes, 'base64').length)
  assert.equal(f.requested.length, reads, 'the preloaded first fragment is reused')
  await svc.call(a, 'read_panel_chunk', args)
  await assert.rejects(svc.call(b, 'read_panel_chunk', args, true))
  await assert.rejects(svc.call(a, 'read_panel_chunk', { ...args, asset: 'input.mp4' }, true))
  assert.ok(f.requested.reduce((n, r) => n + r.length, 0) < f.bytes.length / 2)
})
