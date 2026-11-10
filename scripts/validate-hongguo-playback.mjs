// Opt-in live validation. Credentials and media locators never enter the report.
import { spawn } from 'node:child_process'
import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { createClient, memoryProfileStore, nodeTransport } from '../dist/vendor/openhongguo/index.js'
import { ensureFfmpeg, ffmpegPath } from '../src/runtime/ffmpeg-runtime.mjs'
import { HongguoSource } from '../src/server/sources/hongguo.mjs'
import { MediaCache } from '../src/server/media.mjs'
import { PanelMedia } from '../src/server/panel-media.mjs'
import { Store } from '../src/server/store.mjs'
import { mediaFetcher, hongguoHosts, allowsHongguoRedirect, allowsHongguoRedirectPort } from '../src/server/sources/network.mjs'

const reportPath = resolve(process.argv[2] || 'release/playback-signature-validation/live.json')
const longOnly = process.argv.includes('--long')
const scratch = await mkdtemp(join(tmpdir(), 'hongguo-playback-validation-'))
const sdkSource = JSON.parse(await readFile('dist/vendor/openhongguo/SOURCE.json', 'utf8'))
const report = { startedAt: new Date().toISOString(), sdkRevision: sdkSource.revision,
  series: [], samples: [], freshDevice: [], concurrency: [], fullPipeline: [] }
const counters = { registration: 0, playback: 0, emptyPlayback: 0 }
let store, panel
let cache
const descriptors = new Map()
const rejectedHosts = new Set()
let routingRedirects = 0
const media = mediaFetcher({ allows: host => {
  const allowed = hongguoHosts.test(host)
  if (!allowed) rejectedHosts.add(host)
  return allowed
}, redirectAllows: host => {
  if (/(?:^|\.)bdcgslb\.com$/i.test(host)) routingRedirects++
  const allowed = allowsHongguoRedirect(host)
  if (!allowed) rejectedHosts.add(host)
  return allowed
}, redirectPorts: allowsHongguoRedirectPort })
const delay = ms => new Promise(ok => setTimeout(ok, ms))
const errorClass = error => new Set(['ANONYMOUS_LIMITED', 'RATE_LIMITED', 'AUTHENTICATION_REQUIRED',
  'CONTENT_UNAVAILABLE', 'TRANSPORT', 'SIGNATURE_REJECTED', 'CHALLENGE_REQUIRED']).has(error?.code) ? error.code : 'OTHER'
const transport = nodeTransport({ timeoutMs: 15000 })
const tracked = async request => {
  const response = await transport(request)
  const path = new URL(request.url).pathname
  if (path.includes('device_register')) counters.registration++
  if (path.includes('video_model')) {
    counters.playback++
    if (!response.body?.length) counters.emptyPlayback++
  }
  return response
}
function decoder(args, input = null, timeout = 60000) {
  return new Promise(ok => {
    const child = spawn(ffmpegPath(), ['-hide_banner', '-v', 'error', '-nostdin', ...args], {
      stdio: ['pipe', 'ignore', 'pipe'], timeout, windowsHide: true, killSignal: 'SIGKILL',
    })
    let bytes = 0, finished = false
    const finish = result => { if (!finished) { finished = true; ok({ ok: result, stderrBytes: bytes }) } }
    child.stderr.on('data', chunk => { bytes += chunk.length })
    child.stdin.on('error', () => {})
    child.on('error', () => finish(false))
    child.on('close', code => finish(code === 0))
    child.stdin.end(input)
  })
}
async function sample(client, episode, seriesIndex, position, decode = true) {
  const row = { series: seriesIndex, position, episodeNumber: episode.number, catalogEpisodeId: episode.id }
  let resolved
  const start = Date.now()
  try {
    const provider = new HongguoSource(scratch)
    let calls = 0
    provider.sdkCall = async (method, ...args) => { calls++; resolved = await client[method](...args); return resolved }
    const descriptor = await provider.resolvePlayback(episode.id)
    const candidate = descriptor.candidates[0]
    row.codecRefreshes = Math.max(0, calls - 1)
    row.resolveOK = Boolean(candidate)
    row.resolveMs = Date.now() - start
    row.streams = resolved.playback.streams.length
    row.codec = String(candidate?.codec || '').replace(/[^a-z0-9.-]/gi, '').slice(0, 24)
    row.mediaHost = candidate ? new URL(candidate.url).hostname : undefined
    row.durationSeconds = resolved.playback.duration_seconds
    if (decode && candidate) {
      const id = 'hg-' + episode.id
      descriptors.set(id, { ...descriptor, fetchMedia: media })
      let status
      do { status = cache.prepare(id); if (status.status !== 'preparing') break; await delay(250) } while (Date.now() - start < 120000)
      row.cacheReady = status.status === 'ready'
      if (!row.cacheReady) row.prepareFailure = /FFmpeg/.test(status.reason) ? 'FFMPEG'
        : /地址.*域名/.test(status.reason) ? 'URL_DOMAIN' : /失效/.test(status.reason) ? 'MEDIA_EXPIRED' : 'OTHER'
      if (row.cacheReady) {
        const result = await decoder(['-protocol_whitelist', 'file', '-i', cache.path(id), '-t', '3', '-xerror', '-f', 'null', '-'])
        row.decodeOK = result.ok
        row.decoderStderrBytes = result.stderrBytes
      }
    }
  } catch (error) { row.resolveOK ??= false; row.errorClass = errorClass(error) }
  return { row, resolved, episode }
}
async function assetBytes(id, stream, asset) {
  const chunks = []
  let offset = 0, size
  do {
    const chunk = await panel.chunk(id, stream, asset, offset)
    size = chunk.size
    const data = Buffer.from(chunk.bytes, 'base64')
    chunks.push(data); offset += data.length
  } while (offset < size)
  return Buffer.concat(chunks)
}
async function restartProfile(profile, episodeId) {
  const code = `
    const {createClient,nodeTransport}=await import(process.argv[3]);
    const base=nodeTransport({timeoutMs:15000});let registrations=0;
    try{const c=await createClient({profile:process.argv[1],deviceResets:0,retryAttempts:1,transport:async r=>{if(new URL(r.url).pathname.includes('device_register'))registrations++;return base(r)}});
      const result=await c.resolvePlayback(process.argv[2]);console.log(JSON.stringify({resolved:Boolean(result.playback.streams.length),registrations}));
    }catch{console.log(JSON.stringify({resolved:false,registrations}))}
  `
  return new Promise(ok => {
    const child = spawn(process.execPath, ['--input-type=module', '-e', code, profile, episodeId,
      new URL('../dist/vendor/openhongguo/index.js', import.meta.url).href], {
      stdio: ['ignore', 'pipe', 'ignore'], timeout: 45000, windowsHide: true,
    })
    let output = ''
    child.stdout.on('data', data => { if (output.length < 4096) output += data })
    child.on('error', () => ok({ resolved: false }))
    child.on('close', () => { try { ok(JSON.parse(output)) } catch { ok({ resolved: false }) } })
  })
}

try {
  await ensureFfmpeg()
  store = new Store(join(scratch, 'pipeline'))
  const client = await createClient({ profile: join(scratch, 'device/anonymous.json'),
    transport: tracked, deviceResets: 0, retryAttempts: 1 })
  const source = new HongguoSource(store.root)
  source.client = Promise.resolve(client)
  cache = new MediaCache(store, async id => {
    const first = descriptors.get(id)
    if (first) { descriptors.delete(id); return first }
    return { ...await source.resolvePlayback(id.slice(3)), fetchMedia: media }
  }, { maxFiles: 48 })
  const candidates = new Map()
  let longSample
  if (process.argv[3]) {
    const previous = JSON.parse(await readFile(resolve(process.argv[3]), 'utf8'))
    if (longOnly) longSample = [...previous.samples].sort((a, b) => b.durationSeconds - a.durationSeconds)[0]
    for (const row of previous.series) if (row.catalogSeriesId && (!longOnly || row.series === longSample.series)) candidates.set(row.catalogSeriesId, { id: row.catalogSeriesId })
  } else for (const row of (await client.discover()).items || []) if (row.episode_count > 2) candidates.set(row.id, row)
  for (const query of ['重生', '都市', '修仙']) {
    if (longOnly || candidates.size >= 8) break
    for (const row of (await client.search(query, { filters: ['content_type_short_play'] })).items || [])
      if (row.episode_count > 2) candidates.set(row.id, row)
  }
  const selected = []
  for (const row of candidates.values()) {
    if (selected.length >= 8) break
    try {
      const episodes = (await client.listEpisodes(row.id)).items || []
      if (episodes.length < 3) continue
      const index = selected.length + 1
      selected.push({ id: row.id, index, episodes })
      report.series.push({ series: index, catalogSeriesId: row.id, episodeCount: episodes.length })
    } catch (error) { report.series.push({ selected: false, errorClass: errorClass(error) }) }
  }
  const sampled = []
  for (const series of selected) {
    const positions = longOnly ? [['long', series.episodes.findIndex(e => e.id === longSample.catalogEpisodeId)]]
      : [['first', 0], ['middle', Math.floor(series.episodes.length / 2)], ['last', series.episodes.length - 1]]
    for (const [position, index] of positions) {
      const result = await sample(client, series.episodes[index], series.index, position)
      sampled.push(result); report.samples.push(result.row)
      console.log(JSON.stringify({ stage: 'sample', completed: report.samples.length, ...result.row }))
    }
  }
  const fresh = await createClient({ profile: memoryProfileStore(), transport: tracked, deviceResets: 0, retryAttempts: 1 })
  for (const series of selected.slice(0, 4)) report.freshDevice.push((await sample(fresh, series.episodes[0], series.index, 'first')).row)
  const resumedBefore = counters.registration
  const resumed = await createClient({ profile: join(scratch, 'device/anonymous.json'),
    transport: tracked, deviceResets: 0, retryAttempts: 1 })
  const resumedResult = await sample(resumed, selected[0].episodes[0], 1, 'reopen')
  report.resume = { ...resumedResult.row, registrationDelta: counters.registration - resumedBefore }
  report.processRestart = await restartProfile(join(scratch, 'device/anonymous.json'), selected[0].episodes[0].id)
  report.concurrency = (await Promise.all(selected.slice(0, 3).map(s => sample(client, s.episodes[1], s.index, 'concurrent')))).map(r => r.row)

  panel = new PanelMedia(store.root)
  const full = sampled.filter(r => r.row.decodeOK && r.row.durationSeconds > 0)
    .sort((a, b) => a.row.durationSeconds - b.row.durationSeconds)
    .filter((r, i, all) => all.findIndex(x => x.row.series === r.row.series) === i).slice(0, 2)
  for (const item of full) {
    const id = 'hg-' + item.episode.id, start = Date.now()
    const row = { series: item.row.series, position: item.row.position }
    let status
    do { status = cache.prepare(id); if (status.status !== 'preparing') break; await delay(250) } while (Date.now() - start < 150000)
    row.cacheReady = status.status === 'ready'
    if (row.cacheReady) {
      row.fileBytes = (await stat(cache.path(id))).size
      row.fullDecodeOK = (await decoder(['-i', cache.path(id), '-xerror', '-f', 'null', '-'], null, 120000)).ok
      row.middleSeekOK = (await decoder(['-ss', String(Math.floor(item.row.durationSeconds / 2)), '-i', cache.path(id), '-t', '3', '-xerror', '-f', 'null', '-'])).ok
      row.endSeekOK = (await decoder(['-sseof', '-4', '-i', cache.path(id), '-t', '3', '-xerror', '-f', 'null', '-'])).ok
      row.reopenCacheReady = new MediaCache(store, () => { throw Error('Cache should avoid the network') }).prepare(id).status === 'ready'
      let ready
      do { ready = panel.prepare(id, cache.path(id), false, status.codec); if (ready.status === 'ready') break; await delay(250) } while (Date.now() - start < 240000)
      row.panelReady = ready?.status === 'ready'
      if (row.panelReady) {
        await panel.entries.get(id).job
        const manifest = panel.manifest(id, ready.stream).manifest
        const segments = manifest.match(/seg\d{5}\.m4s/g) || []
        row.panelSegments = segments.length
        row.panelCodec = ready.codec
        const fragment = Buffer.concat([await assetBytes(id, ready.stream, 'init.mp4'), await assetBytes(id, ready.stream, segments[0])])
        row.panelChunkDecodeOK = (await decoder(['-protocol_whitelist', 'pipe', '-i', 'pipe:0', '-t', '1', '-xerror', '-f', 'null', '-'], fragment)).ok
      }
    }
    report.fullPipeline.push(row)
    console.log(JSON.stringify({ stage: 'fullPipeline', ...row }))
  }
  report.registrationCount = counters.registration
  report.playbackRequests = counters.playback
  report.emptyPlaybackResponses = counters.emptyPlayback
  report.rejectedMediaHosts = [...new Set([...rejectedHosts].map(host => host.split('.').slice(-2).join('.')))]
  report.routingRedirects = routingRedirects
  report.finishedAt = new Date().toISOString()
} catch (error) { report.fatal = errorClass(error) }
finally {
  panel?.close()
  store?.db.close()
  await mkdir(join(reportPath, '..'), { recursive: true })
  await writeFile(reportPath, JSON.stringify(report, null, 2) + '\n')
  await rm(scratch, { recursive: true, force: true })
}
const groups = [report.samples, report.freshDevice, report.concurrency]
const allSamples = groups.flat()
const failures = allSamples.filter(r => !r.resolveOK || !r.decodeOK).length
const fullFailures = report.fullPipeline.filter(r => !r.cacheReady || !r.fullDecodeOK || !r.middleSeekOK || !r.endSeekOK || !r.reopenCacheReady || !r.panelChunkDecodeOK).length
const pass = !report.fatal && report.samples.length >= (longOnly ? 1 : 24) && !failures && report.fullPipeline.length === (longOnly ? 1 : 2) && !fullFailures && report.resume?.decodeOK && report.resume.registrationDelta === 0 && report.processRestart?.resolved && report.processRestart.registrations === 0
console.log(JSON.stringify({ complete: true, pass, series: report.series.filter(r => r.series).length,
  samples: allSamples.length, sampleFailures: failures, fullPipelineFailures: fullFailures,
  fullPipelineCount: report.fullPipeline.length, resume: report.resume, processRestart: report.processRestart, registrations: report.registrationCount,
  emptyPlaybackResponses: report.emptyPlaybackResponses, ...(report.fatal ? { fatal: report.fatal } : {}) }))
process.exitCode = pass ? 0 : 1
