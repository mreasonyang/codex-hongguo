// Anonymous real-network qualification of the compiled MCP Provider. No user
// account, browser Cookie, signed URL or raw child diagnostic is recorded.
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { mkdtemp, rm, writeFile, stat, readdir } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import assert from 'node:assert/strict'
import { runFfmpeg } from '../src/server/media.mjs'

const root = await mkdtemp(join(tmpdir(), 'bilibili-qualification-'))
const pluginRoot = resolve(process.env.BILIBILI_VERIFY_PACKAGE_ROOT || '.')
let client, panel, stage = 'startup'
const report = { sdk: '@ikenxuan/amagi@6.6.0', authentication: 'anonymous',
  artifact: process.env.BILIBILI_VERIFY_PACKAGE_ROOT ? 'packaged' : 'source-build', installedUserPluginChanged: false }
async function start() {
  client = new Client({ name: 'bilibili-qualification', version: '1' })
  await client.connect(new StdioClientTransport({ command: process.execPath,
    args: ['--no-warnings', join(pluginRoot, 'dist/server/index.mjs')],
    env: { PATH: process.env.PATH || process.env.Path, HONGGUO_DATA_DIR: root }, stderr: 'ignore' }))
  const opened = await client.callTool({ name: 'open_drama_panel', arguments: {}, _meta: { thread_id: 'bilibili-test' } })
  panel = opened._meta.panel
}
async function call(name, args = {}) {
  stage = name
  const response = await client.callTool({ name, arguments: { panel, ...args } })
  if (response.isError) throw Error('MCP operation failed')
  return response._meta?.data ?? response.structuredContent
}
async function prepared(episodeId, limit = 240000) {
  const began = Date.now()
  while (Date.now() - began < limit) {
    const value = await call('prepare_playback', { episodeId })
    if (value.status !== 'preparing') return value
    await new Promise(resolve => setTimeout(resolve, 1000))
  }
  throw Error('Playback preparation timed out')
}
async function asset(episodeId, stream, name) {
  const chunks = []; let offset = 0, size
  do {
    const part = await call('read_panel_chunk', { episodeId, stream, asset: name, offset })
    const bytes = Buffer.from(part.bytes, 'base64')
    size = part.size; assert.ok(bytes.length && offset + bytes.length <= size)
    chunks.push(bytes); offset += bytes.length
  } while (offset < size)
  return Buffer.concat(chunks)
}
try {
  await start()
  assert.deepEqual((await call('get_providers')).items.filter(p => p.available).map(p => p.id), ['hongguo'])
  await call('set_preferences', { enabledProviders: ['hongguo', 'bilibili'] })
  await call('set_source', { source: 'bilibili' })
  stage = 'homepage-discovery'
  report.homepageSeries = (await call('list_series')).items.length
  assert.ok(report.homepageSeries > 3)
  stage = 'name-search'
  const search = await call('list_series', { query: '鬼灭之刃' })
  report.searchResults = search.items.length
  assert.ok(search.items.length && search.items.every(item => !/<[^>]*>/.test(item.title)))
  const series = (await call('list_series', { query: 'ss2251' })).items[0]
  const episodes = (await call('get_episodes', { seriesId: series.id })).items
  assert.equal(episodes.length, 13)
  report.regularEpisodes = episodes.length
  const first = episodes[0], began = Date.now()
  console.log(JSON.stringify({ check: 'Bilibili SDK catalog', result: 'PASS', regularEpisodes: episodes.length }))
  const ready = await prepared(first.id)
  stage = 'on-demand-preparation'; assert.equal(ready.status, 'ready'); assert.equal(ready.format, 'dash')
  report.indexReadyMs = Date.now() - began
  report.durationMs = ready.durationMs
  assert.ok(report.durationMs > 1400000 && report.durationMs < 1500000)
  const manifest = JSON.parse(ready.manifest)
  const full = await stat(join(root, 'media', first.id + '.mp4')).catch(() => null)
  assert.equal(full, null, 'the first frame must not wait for a full-episode cache')
  let requested = 0
  for (const position of [0, 600, Math.floor(report.durationMs / 1000) - 5]) {
    stage = 'MCP-on-demand-fragment-decode'
    for (const [i, track] of manifest.tracks.entries()) {
      const segment = track.segments.find(s => s.time <= position && s.time + s.duration > position)
      assert.ok(segment)
      const bytes = Buffer.concat([await asset(first.id, ready.stream, track.initialization),
        await asset(first.id, ready.stream, segment.asset)])
      requested += bytes.length
      if (!position && i === 1) report.firstAVFragmentsReadyMs = Date.now() - began
      const path = join(root, 'mcp-track-' + i + '.mp4'); await writeFile(path, bytes)
      const decoded = await runFfmpeg(['-i', path, '-map', i ? '0:a:0' : '0:v:0', i ? '-frames:a' : '-frames:v', '1',
        '-f', 'framehash', 'pipe:1'], null, true)
      assert.match(decoded.toString(), /^0,\s/m)
    }
    if (!position) report.initialAVBytes = requested
  }
  report.decodedPositionsSeconds = [0, 600, Math.floor(report.durationMs / 1000) - 5]
  report.mcpFragmentBytes = requested
  report.cachedFragmentBytes = 0
  for (const dir of await readdir(join(root, 'dash-media'), { withFileTypes: true }))
    if (dir.isDirectory()) for (const file of await readdir(join(root, 'dash-media', dir.name)))
      report.cachedFragmentBytes += (await stat(join(root, 'dash-media', dir.name, file))).size
  assert.ok(report.cachedFragmentBytes < 5 * 1024 * 1024)
  await call('save_progress', { seriesId: series.id, episodeId: first.id, title: series.title,
    label: first.label, positionMs: 30000, durationMs: report.durationMs })
  await client.close(); await start()
  assert.equal((await call('get_preferences')).defaultSource, 'bilibili')
  const library = await call('list_series', { source: 'bilibili' })
  assert.ok(library.items.some(item => item.id === series.id))
  assert.equal((await call('get_history')).items[0].positionMs, 30000)
  assert.equal((await call('get_history', { source: 'hongguo' })).items.length, 0)
  await call('get_episodes', { seriesId: series.id })
  assert.equal((await prepared(first.id)).status, 'ready')
  report.restartResume = 'PASS'
  const previewSeries = (await call('list_series', { query: 'ss33073' })).items[0]
  const previewEpisode = (await call('get_episodes', { seriesId: previewSeries.id })).items[0]
  const rejected = await prepared(previewEpisode.id, 30000)
  stage = 'preview-rejection'; assert.equal(rejected.status, 'error'); assert.match(rejected.reason, /试看/)
  report.previewRejected = 'PASS'
  await call('set_source', { source: 'hongguo' })
  await call('set_preferences', { enabledProviders: ['hongguo'] })
  const unavailable = await client.callTool({ name: 'prepare_playback', arguments: { panel, episodeId: first.id } })
  assert.equal(unavailable.isError, true)
  report.disableRevokesCache = 'PASS'
  report.result = 'PASS'
  if (process.argv.includes('--keep')) report.reviewDataDirectory = root
} catch (error) {
  report.result = 'FAIL'; report.stage = stage; report.errorType = error.name; process.exitCode = 1
} finally {
  await client?.close().catch(() => {})
  if (report.result !== 'PASS' || !process.argv.includes('--keep')) await rm(root, { recursive: true, force: true })
}
console.log(JSON.stringify(report))
