// Feasibility experiment only. Does not install a source or modify application state.
import assert from 'node:assert/strict'
import { createHash, randomBytes, createCipheriv, createDecipheriv } from 'node:crypto'
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, dirname, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { createRequire } from 'node:module'

const here = dirname(fileURLToPath(import.meta.url))
const repo = resolve(here, '../../..')
const require = createRequire(join(repo, 'package.json'))
const { Parser } = require('m3u8-parser')
const scratch = await mkdtemp(join(tmpdir(), 'hongguo-source-feasibility-'))
const upstream = '0013315087149b1f717e6a260524de0dce0d1485'
const expectedBlob = '4a649383a55a7cb14abee3b4b7389a895cf70c58'
const nativeFetch = globalThis.fetch
const results = []
const report = { schema: 1, checkedAt: new Date().toISOString(), upstream, runtime: process.version,
  baselineCommit: '5033523ca1a39bfb01ac3ad447fe788aa4db99a4',
  probeSha256: createHash('sha256').update(await readFile(fileURLToPath(import.meta.url))).digest('hex'),
  scope: 'isolated feasibility probe; no application integration or desktop observation', results,
  desktopPlaybackObserved: false, realMediaDecoded: false }
const noProfile = { load: async () => null, save: async () => { throw Error('Unexpected profile write') }, reset: async () => {} }
function code(error) {
  const value = error?.code || error?.name || 'FAILED'
  return /^[A-Z_0-9]{1,40}$/.test(value) ? value : 'FAILED'
}
async function check(name, fn) {
  const start = performance.now()
  try {
    const metadata = await fn()
    const row = { name, status: 'pass', elapsedMs: Math.round(performance.now() - start), ...metadata }
    results.push(row); console.log(JSON.stringify(row)); return metadata
  } catch (error) {
    const row = { name, status: 'fail', elapsedMs: Math.round(performance.now() - start), code: code(error) }
    results.push(row); console.log(JSON.stringify(row)); return null
  }
}
function parse(text) { const p = new Parser(); p.push(text); p.end(); return p.manifest }
function ivFor(value, sequence) {
  const iv = Buffer.alloc(16)
  if (value) { assert.equal(value.length, 4); Array.from(value).forEach((n, i) => iv.writeUInt32BE(n, i * 4)) }
  else iv.writeBigUInt64BE(BigInt(sequence), 8)
  return iv
}
function decrypt(bytes, key, iv) {
  assert.equal(key.length, 16)
  const cipher = createDecipheriv('aes-128-cbc', key, iv)
  return Buffer.concat([cipher.update(bytes), cipher.final()])
}
// A bounded TS-only prototype. Production must also define encrypted MAP/range/discontinuity behavior.
async function prepareSample(manifest, base, get, output, run, { maxSegments = 128 } = {}) {
  const p = parse(manifest)
  assert.ok(p.endList && p.segments?.length)
  assert.ok(p.segments.length <= maxSegments)
  const pieces = []
  let keyRequests = 0
  for (const [i, segment] of p.segments.entries()) {
    assert.ok(!segment.map && !segment.byterange && !segment.discontinuity && !segment.gap)
    let bytes = await get(new URL(segment.uri, base))
    if (segment.key) {
      assert.equal(segment.key.method, 'AES-128')
      assert.ok(!segment.key.keyFormat || segment.key.keyFormat === 'identity')
      const key = await get(new URL(segment.key.uri, base)); keyRequests++
      bytes = decrypt(bytes, key, ivFor(segment.key.iv, (p.mediaSequence || 0) + i))
    }
    pieces.push(bytes)
  }
  const local = output + '.ts'
  await writeFile(local, Buffer.concat(pieces), { mode: 0o600 })
  try { await run(['-protocol_whitelist', 'file', '-f', 'mpegts', '-i', local, '-map', '0:v:0', '-map', '0:a:0?', '-c', 'copy', '-movflags', '+faststart', output]) }
  finally { await rm(local, { force: true }) }
  return { segments: pieces.length, keyRequests, bytes: pieces.reduce((n, b) => n + b.length, 0) }
}
async function panelRoundTrip(file, label, run) {
  const { PanelMedia } = await import(pathToFileURL(join(repo, 'src/server/panel-media.mjs')))
  const panel = new PanelMedia(join(scratch, label), run)
  const id = 'hh-117_1'
  try {
    panel.prepare(id, file, false, 'h264')
    const entry = panel.entries.get(id)
    await entry.job
    const ready = panel.prepare(id, file, false, 'h264')
    assert.equal(ready.status, 'ready')
    const manifest = panel.manifest(id, ready.stream).manifest
    assert.ok(!manifest.includes('https:') && !manifest.includes('EXT-X-KEY'))
    const assets = ['init.mp4', ...manifest.split(/\r?\n/).filter(l => l && !l.startsWith('#'))]
    const chunks = []
    let calls = 0
    for (const asset of assets) {
      let offset = 0, size
      do {
        const part = await panel.chunk(id, ready.stream, asset, offset); calls++
        const bytes = Buffer.from(part.bytes, 'base64')
        assert.ok(bytes.length > 0 && bytes.length <= 192 * 1024)
        chunks.push(bytes); offset += bytes.length; size = part.size
      } while (offset < size)
      assert.equal(offset, size)
    }
    const roundTrip = join(scratch, label + '-roundtrip.mp4')
    await writeFile(roundTrip, Buffer.concat(chunks), { mode: 0o600 })
    await run(['-protocol_whitelist', 'file', '-xerror', '-i', roundTrip, '-map', '0:v:0', '-map', '0:a:0?', '-f', 'null', '-'])
    return { assets: assets.length, chunkCalls: calls, durationMs: ready.durationMs, decoded: true }
  } finally { panel.close() }
}
let sdk, run, localSample
try {
  const sdkArg = process.argv.indexOf('--sdk')
  const imported = await check('upstream-sdk-integrity', async () => {
    const bytes = sdkArg >= 0 ? await readFile(process.argv[sdkArg + 1]) : Buffer.from(await (await nativeFetch(
      `https://raw.githubusercontent.com/frostming/dsh-hongguo/${upstream}/sdk/hghub/index.js`,
      { signal: AbortSignal.timeout(15000) })).arrayBuffer())
    const blob = createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex')
    assert.equal(blob, expectedBlob)
    const path = join(scratch, 'hghub.mjs'); await writeFile(path, bytes, { mode: 0o600 })
    sdk = await import(pathToFileURL(path)); return { sourceVerified: true }
  })
  if (!imported) throw Object.assign(Error('SDK unavailable'), { code: 'SDK_UNAVAILABLE' })
  await check('current-boundaries-confirmed', async () => {
    const { schemas } = await import(pathToFileURL(join(repo, 'src/server/service.mjs')))
    const { Store } = await import(pathToFileURL(join(repo, 'src/server/store.mjs')))
    const { cdn } = await import(pathToFileURL(join(repo, 'src/server/media.mjs')))
    assert.equal(schemas.list_series.safeParse({ source: 'hghub' }).success, false)
    assert.equal(schemas.get_episodes.safeParse({ seriesId: 'hh-117' }).success, false)
    assert.equal(schemas.get_episodes.safeParse({ seriesId: 'hg-117' }).success, true)
    await assert.rejects(cdn('https://tp1.drleao.cn/probe', 1024, 1000))
    const store = new Store(join(scratch, 'store'))
    try {
      store.save({ seriesId: 'hh-117', episodeId: 'hh-117_1', title: 'fixture', label: '1', positionMs: 1000, durationMs: 2000 })
      assert.equal(store.history('hh-117', 'hh-117_1').length, 1)
      assert.equal(store.history().length, 0)
    } finally { store.close() }
    return { sourceSchemaBlocksHghub: true, idSchemaBlocksHghub: true, cdnBlocksHghub: true, historyListOmitsHghub: true }
  })
  await check('page-and-identity-contract', async () => {
    const cursor = (source, page, query) => Buffer.from(JSON.stringify({ source, page, query })).toString('base64url')
    const read = (value, source, query) => {
      const p = JSON.parse(Buffer.from(value, 'base64url')); assert.equal(p.source, source); assert.equal(p.query, query)
      assert.ok(Number.isSafeInteger(p.page) && p.page > 0); return p.page
    }
    const c = cursor('hghub', 2, 'fixture')
    assert.equal(read(c, 'hghub', 'fixture'), 2)
    assert.throws(() => read(c, 'hongguo', 'fixture')); assert.throws(() => read(c, 'hghub', 'other'))
    assert.deepEqual(sdk.parseEpisodeId(sdk.episodeId(117, 3)), { videoId: '117', ep: 3 })
    assert.notEqual('hg-117', 'hh-117'); assert.notEqual('hh-117_1', 'hh-118_1')
    return { nextPageRoundTrip: true, foreignSourceRejected: true, changedQueryRejected: true, compositeEpisodeRoundTrip: true }
  })
  const ready = await check('existing-runtime-and-fixture', async () => {
    const media = await import(pathToFileURL(join(repo, 'src/server/media.mjs')))
    run = media.runFfmpeg
    const dir = join(scratch, 'plain'); await mkdir(dir)
    await run(['-stream_loop', '5', '-i', join(repo, 'test/fixtures/avc-aac.mp4'), '-t', '6', '-c', 'copy', '-f', 'hls', '-hls_time', '2', '-hls_playlist_type', 'vod', 'index.m3u8'], null, false, dir)
    const playlist = parse(await readFile(join(dir, 'index.m3u8'), 'utf8'))
    assert.ok(playlist.segments.length >= 2)
    localSample = { dir, playlist }; return { segments: playlist.segments.length }
  })
  if (ready) {
    for (const mode of ['explicit-iv', 'sequence-iv', 'rotating-keys']) {
      await check('encrypted-hls-' + mode, async () => {
        const resources = new Map(), keys = [randomBytes(16), randomBytes(16)], explicit = randomBytes(16)
        const base = 'https://fixture.invalid/index.m3u8', sequence = 7
        let text = '#EXTM3U\n#EXT-X-VERSION:3\n#EXT-X-TARGETDURATION:3\n#EXT-X-MEDIA-SEQUENCE:7\n'
        for (const [i, segment] of localSample.playlist.segments.entries()) {
          const keyIndex = mode === 'rotating-keys' ? i % 2 : 0
          const key = keys[keyIndex], iv = mode === 'explicit-iv' ? explicit : ivFor(null, sequence + i)
          const plain = await readFile(join(localSample.dir, segment.uri))
          const cipher = createCipheriv('aes-128-cbc', key, iv)
          resources.set('/seg' + i + '.ts', Buffer.concat([cipher.update(plain), cipher.final()]))
          resources.set('/key' + keyIndex, key)
          text += `#EXT-X-KEY:METHOD=AES-128,URI="/key${keyIndex}"${mode === 'explicit-iv' ? ',IV=0x' + explicit.toString('hex') : ''}\n#EXTINF:${segment.duration},\n/seg${i}.ts\n`
          assert.ok(decrypt(resources.get('/seg' + i + '.ts'), key, iv).equals(plain))
        }
        text += '#EXT-X-ENDLIST\n'
        resources.set('/index.m3u8', Buffer.from(text))
        const get = async url => { const bytes = resources.get(url.pathname); assert.ok(bytes); return bytes }
        const { prepareAdaptive } = await import(pathToFileURL(join(repo, 'src/server/adaptive.mjs')))
        const dir = join(scratch, mode); await mkdir(dir)
        await assert.rejects(prepareAdaptive(base, dir, join(dir, 'old.mp4'), {
          cdn: async url => ({ body: new Response(await get(new URL(url))).body, url: String(url) }), run,
          codec: 'h264', budget: 64 * 1024 * 1024,
        }))
        const output = join(dir, 'sample.mp4')
        const metadata = await prepareSample(text, base, get, output, run)
        await run(['-protocol_whitelist', 'file', '-xerror', '-i', output, '-map', '0:v:0', '-map', '0:a:0', '-f', 'null', '-'])
        const transport = mode === 'rotating-keys' ? await panelRoundTrip(output, 'synthetic-panel', run) : undefined
        return { ...metadata, existingAdaptiveRejects: true, decoded: true, ...(transport ? { panelModule: transport } : {}) }
      })
    }
  }
  if (process.argv.includes('--live')) {
    let totalBytes = 0, requests = 0
    const allowed = new Set(sdk.HGHUB_LINES.map(l => new URL(l.url).hostname))
    const getLive = async (input, options = {}) => {
      let url = new URL(input)
      const headers = new Headers(options.headers)
      assert.ok(!headers.has('authorization') && !headers.has('cookie'))
      for (let redirects = 0; redirects <= 3; redirects++) {
        assert.ok(url.protocol === 'https:' && !url.port && !url.username && !url.password)
        assert.ok(allowed.has(url.hostname) || sdk.isMediaHost(url.hostname) || sdk.isImageHost(url.hostname))
        if (++requests > 24) throw Object.assign(Error(), { code: 'REQUEST_BUDGET' })
        const response = await nativeFetch(url, { ...options, headers, redirect: 'manual', signal: AbortSignal.timeout(10000) })
        if ([301, 302, 303, 307, 308].includes(response.status)) {
          const next = response.headers.get('location'); await response.body?.cancel()
          assert.ok(next && redirects < 3); url = new URL(next, url); continue
        }
        const parts = []; let bytes = 0
        try {
          for await (const chunk of response.body || []) {
            bytes += chunk.length; totalBytes += chunk.length
            if (bytes > 16 * 1024 * 1024 || totalBytes > 48 * 1024 * 1024) throw Object.assign(Error(), { code: 'BYTE_BUDGET' })
            parts.push(chunk)
          }
        } finally { await response.body?.cancel().catch(() => {}) }
        return new Response(Buffer.concat(parts), { status: response.status, headers: response.headers })
      }
    }
    globalThis.fetch = getLive
    let client, page, detail, play
    for (let index = 0; index < sdk.HGHUB_LINES.length && !page; index++) {
      await check('live-feed-line-' + (index + 1), async () => {
        client = await sdk.createClient({ base: sdk.HGHUB_LINES[index].url, store: noProfile, retries: 0, timeoutMs: 10000, minIntervalMs: 300 })
        const value = await client.feed({ page: 1, size: 2 })
        assert.ok(value.items?.length); page = value
        return { items: value.items.length, total: value.total, authenticated: client.isLoggedIn }
      })
    }
    if (page) {
      await check('live-detail-and-search', async () => {
        detail = await client.getVideo(page.items[0].id)
        assert.ok(detail.episodeList?.length)
        const found = await client.search(detail.title.slice(0, 2), { page: 1, size: 2 })
        return { episodes: detail.episodeList.length, searchItems: found.items.length, playableEpisodes: detail.episodeList.filter(e => e.playable).length }
      })
      await check('live-cover', async () => {
        const response = await getLive(detail.cover); assert.ok(response.ok)
        const bytes = sdk.decryptCover(Buffer.from(await response.arrayBuffer()))
        assert.ok(sdk.imageKind(bytes)); return { mime: sdk.imageKind(bytes), bytes: bytes.length }
      })
      await check('live-playback-locator', async () => {
        const episode = detail.episodeList.find(e => e.playable); assert.ok(episode)
        play = await client.getPlay(detail.id, episode.number)
        assert.ok(sdk.isMediaHost(new URL(play.videoUrl).hostname))
        return { locatorReturned: true, alternateHevcAvailable: !!play.videoUrlHevc }
      })
      if (play && run) await check('live-bounded-media-and-panel', async () => {
        const get = async url => {
          const response = await getLive(url, { headers: { 'user-agent': client.userAgent, referer: new URL(url).origin + '/' } })
          if (!response.ok) throw Object.assign(Error(), { code: 'MEDIA_HTTP' })
          return Buffer.from(await response.arrayBuffer())
        }
        let base = play.videoUrl, text = (await get(base)).toString('utf8'), playlist = parse(text)
        for (let depth = 0; playlist.playlists?.length && depth < 3; depth++) {
          base = new URL(playlist.playlists[0].uri, base).href
          text = (await get(base)).toString('utf8'); playlist = parse(text)
        }
        assert.ok(playlist.segments?.length)
        const selected = playlist.segments.slice(0, 2)
        let sample = `#EXTM3U\n#EXT-X-VERSION:3\n#EXT-X-TARGETDURATION:${Math.ceil(Math.max(...selected.map(s => s.duration)))}\n#EXT-X-MEDIA-SEQUENCE:${playlist.mediaSequence || 0}\n`
        for (const segment of selected) {
          assert.ok(!segment.map && !segment.byterange && !segment.discontinuity)
          if (segment.key) {
            assert.equal(segment.key.method, 'AES-128')
            assert.ok(!segment.key.keyFormat || segment.key.keyFormat === 'identity')
            const iv = segment.key.iv ? ',IV=0x' + ivFor(segment.key.iv, 0).toString('hex') : ''
            sample += `#EXT-X-KEY:METHOD=AES-128,URI="${new URL(segment.key.uri, base)}"${iv}\n`
          } else sample += '#EXT-X-KEY:METHOD=NONE\n'
          sample += `#EXTINF:${segment.duration},\n${new URL(segment.uri, base)}\n`
        }
        sample += '#EXT-X-ENDLIST\n'
        const output = join(scratch, 'live-sample.mp4')
        const metadata = await prepareSample(sample, base, get, output, run, { maxSegments: 2 })
        await run(['-protocol_whitelist', 'file', '-xerror', '-i', output, '-map', '0:v:0', '-map', '0:a:0?', '-f', 'null', '-'])
        const panelModule = await panelRoundTrip(output, 'live-panel', run)
        report.realMediaDecoded = true
        return { ...metadata, panelModule, sampleOnly: true, fullEpisodeTested: false }
      })
    }
    report.liveRequestCount = requests; report.liveBytes = totalBytes
  }
} catch (error) { results.push({ name: 'probe-setup', status: 'fail', code: code(error) }) }
finally {
  globalThis.fetch = nativeFetch
  report.passed = results.filter(r => r.status === 'pass').length
  report.failed = results.filter(r => r.status === 'fail').length
  await writeFile(join(here, 'receipt.json'), JSON.stringify(report, null, 2) + '\n')
  await rm(scratch, { recursive: true, force: true })
  console.log(JSON.stringify({ passed: report.passed, failed: report.failed, realMediaDecoded: report.realMediaDecoded, desktopPlaybackObserved: false }))
  if (results.some(r => r.status === 'fail' && !r.name.startsWith('live-')) ||
      (process.argv.includes('--live') && !report.realMediaDecoded)) process.exitCode = 1
}
