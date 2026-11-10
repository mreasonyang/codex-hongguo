// Opt-in live startup/resume/seek proof. No profile, URL, key or raw error is logged.
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { createClient, memoryProfileStore } from '../dist/vendor/openhongguo/index.js'
import { HongguoSource } from '../src/server/sources/hongguo.mjs'
import { FileMedia } from '../src/server/file-media.mjs'
import { runFfmpeg } from '../src/server/media.mjs'

const root = await mkdtemp(join(tmpdir(), 'hongguo-progressive-live-'))
const output = resolve(process.argv[2] || 'release/progressive-validation/live.json')
const sdkSource = JSON.parse(await readFile('dist/vendor/openhongguo/SOURCE.json', 'utf8'))
const report = { startedAt: new Date().toISOString(), sdkRevision: sdkSource.revision, samples: [] }
const media = new FileMedia(root)
let client
const allowed = new Set(['ANONYMOUS_LIMITED', 'RATE_LIMITED', 'AUTHENTICATION_REQUIRED', 'UNSUPPORTED_CODEC', 'MEDIA_EXPIRED'])
try {
  let samples = [['7686785692659108889', 'long'], ['7685836257414368318', 'medium']]
  if (process.argv[3]) {
    const previous = JSON.parse(await readFile(resolve(process.argv[3]), 'utf8')), seen = new Set()
    samples = (previous.samples || []).filter(row => {
      if (!row.decodeOK || !/^\d{1,32}$/.test(row.catalogEpisodeId) || seen.has(row.series)) return false
      seen.add(row.series); return true
    }).slice(0, 8).map((row, i) => [row.catalogEpisodeId, 'sample-' + (i + 1)])
    if (!samples.length) throw Error('no-samples')
  }
  client = await createClient({ profile: memoryProfileStore(), timeoutMs: 15000, retryAttempts: 2, deviceResets: 2 })
  for (const [id, label] of samples) {
    const row = { label, positions: [] }; report.samples.push(row)
    const source = new HongguoSource(root); source.sdkCall = (name, ...args) => client[name](...args)
    const fetchMedia = source.fetchMedia; let received = 0, wholeRequests = 0
    source.fetchMedia = async (...args) => {
      if (!args[4]) wholeRequests++
      const result = await fetchMedia(...args), body = result.body
      return { ...result, body: (async function* () { for await (const bytes of body) { received += bytes.length; yield bytes } })() }
    }
    const begin = Date.now(), prepare = () => media.prepare(id, () => source.resolvePlayback(id), () => '', false, false)
    let ready = prepare()
    while (ready.status === 'preparing' && Date.now() - begin < 60000) {
      await new Promise(r => setTimeout(r, 100)); ready = prepare()
    }
    if (ready.status !== 'ready') throw Error('not-ready')
    row.prepareMs = Date.now() - begin; row.indexBytes = received
    const e = media.entries.get(id); row.totalBytes = e.totalBytes; row.durationMs = ready.durationMs
    // Resume first, then start, then a distant seek. No prior sequential warm-up.
    for (const position of [Math.floor(ready.durationMs / 12000) * 6, 0, Math.floor((ready.durationMs - 1) / 6000) * 6]) {
      const before = received, start = Date.now(), asset = 'seg' + String(position / 6).padStart(5, '0') + '.ts'
      const parts = []; let offset = 0, size
      do {
        const part = await media.chunk(id, ready.stream, asset, offset)
        size = part.size; const bytes = Buffer.from(part.bytes, 'base64'); parts.push(bytes); offset += bytes.length
      } while (offset < size)
      const readyMs = Date.now() - start, file = join(root, 'decode.ts')
      await writeFile(file, Buffer.concat(parts))
      await runFfmpeg(['-xerror', '-i', file, '-map', '0:v', '-map', '0:a', '-f', 'null', '-'])
      const framehash = (await runFfmpeg(['-copyts', '-i', file, '-map', '0:v', '-f', 'framehash', 'pipe:1'], null, true)).toString()
      const frames = framehash.split('\n').filter(s => /^0,/.test(s)), scale = Number(/^#tb 0: 1\/(\d+)/m.exec(framehash)?.[1])
      const firstPTS = Number(frames[0]?.split(',')[2]) / scale
      const sample = { position, readyMs, bytesFetched: received - before, cumulativeBytes: received,
        totalBytes: e.totalBytes, wholeRequests, decoded: true, frames: frames.length, firstPTS,
        partial: received < e.totalBytes, targetTimestamp: Math.abs(firstPTS - position) < 0.2 }
      row.positions.push(sample)
      if (!sample.partial || !sample.targetTimestamp || wholeRequests || frames.length < 10) throw Error('progressive-gate')
      console.log(JSON.stringify({ label, ...sample }))
    }
    media.drop(e)
  }
  report.passed = true
} catch (error) {
  report.passed = false; report.error = allowed.has(error?.code) ? error.code : 'VALIDATION_FAILED'
  process.exitCode = 1
} finally {
  await media.close(); await client?.close?.()
  await mkdir(join(output, '..'), { recursive: true })
  await writeFile(output, JSON.stringify(report, null, 2) + '\n')
  await rm(root, { recursive: true, force: true })
  console.log(JSON.stringify({ passed: report.passed, completed: report.samples.reduce((n, s) => n + s.positions.length, 0), error: report.error }))
}
