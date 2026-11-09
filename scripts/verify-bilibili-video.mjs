// Real public-network qualification of the compiled MCP, using a disposable
// profile. Only counts, timings and decode outcomes are reported, never media
// locators, account material, full SDK errors or child diagnostics.
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import assert from 'node:assert/strict'
import { Store } from '../src/server/store.mjs'
import { runFfmpeg } from '../src/server/media.mjs'

const root = await mkdtemp(join(tmpdir(), 'bilibili-video-qualification-'))
const pluginRoot = resolve(process.env.BILIBILI_VERIFY_PACKAGE_ROOT || '.')
const report = { artifact: process.env.BILIBILI_VERIFY_PACKAGE_ROOT ? 'packaged' : 'source-build',
  authentication: 'anonymous', userPluginChanged: false }
let client, panel, stage = 'startup'
async function start() {
  client = new Client({ name: 'bilibili-video-qualification', version: '1' })
  await client.connect(new StdioClientTransport({ command: process.execPath,
    args: ['--no-warnings', join(pluginRoot, 'dist/server/index.mjs')],
    env: { PATH: process.env.PATH || process.env.Path, HONGGUO_DATA_DIR: root }, stderr: 'ignore' }))
  const opened = await client.callTool({ name: 'open_drama_panel', arguments: {}, _meta: { thread_id: 'video-qualification' } })
  panel = opened._meta.panel
}
async function call(name, args = {}) {
  const response = await client.callTool({ name, arguments: { panel, ...args } }, undefined, { timeout: 90000 })
  if (response.isError) {
    const message = response.content?.find(c => c.type === 'text')?.text || ''
    const error = Error('MCP operation failed')
    error.reason = /验证/.test(message) ? 'verification' : /限制/.test(message) ? 'rate-limited'
      : /参数/.test(message) ? 'arguments' : /分区/.test(message) ? 'category'
      : /大小/.test(message) ? 'size-limit' : /时长/.test(message) ? 'duration' : 'unavailable'
    throw error
  }
  return response._meta?.data ?? response.structuredContent
}
async function prepared(episodeId) {
  const began = Date.now()
  while (Date.now() - began < 45000) {
    const result = await call('prepare_playback', { episodeId })
    if (result.status !== 'preparing') {
      if (result.status !== 'ready' || result.format !== 'dash') {
        const error = Error('Playback did not prepare on-demand')
        error.reason = result.status === 'ready' ? 'whole-file-fallback'
          : /索引|分段/.test(result.reason || '') ? 'index' : /大小/.test(result.reason || '') ? 'size-limit'
          : /媒体地址/.test(result.reason || '') ? 'cdn' : /时长/.test(result.reason || '') ? 'duration' : 'unavailable'
        throw error
      }
      return result
    }
    await new Promise(resolve => setTimeout(resolve, 250))
  }
  throw Error('Playback timeout')
}
async function asset(episodeId, stream, name) {
  const chunks = []; let offset = 0, size
  do {
    const part = await call('read_panel_chunk', { episodeId, stream, asset: name, offset })
    const bytes = Buffer.from(part.bytes, 'base64'); size = part.size
    assert.ok(bytes.length && offset + bytes.length <= size)
    chunks.push(bytes); offset += bytes.length
  } while (offset < size)
  return Buffer.concat(chunks)
}
async function decode(episodeId, ready) {
  const manifest = JSON.parse(ready.manifest)
  report.decodeChecks ??= []
  let bytes = 0
  for (const position of [0, Math.max(1, Math.floor(ready.durationMs / 2000))]) {
    for (const [i, track] of manifest.tracks.entries()) {
      const segment = track.segments.find(s => s.time <= position && s.time + s.duration > position) ||
        (position === 0 && track.segments[0]?.time < 1 ? track.segments[0] : undefined)
      if (!segment) { const error = Error('Missing segment'); error.reason = 'segment-gap'; throw error }
      const data = Buffer.concat([await asset(episodeId, ready.stream, track.initialization), await asset(episodeId, ready.stream, segment.asset)])
      bytes += data.length
      const path = join(root, 'decode-' + i + '.mp4'); await writeFile(path, data)
      const output = await runFfmpeg(['-i', path, '-map', i ? '0:a:0' : '0:v:0', i ? '-frames:a' : '-frames:v', '1', '-f', 'framehash', 'pipe:1'], null, true)
      report.decodeChecks.push({ positionSeconds: position, track: i ? 'audio' : 'video', bytes: data.length,
        frameDecoded: /^0,\s/m.test(output.toString()) })
      assert.match(output.toString(), /^0,\s/m)
    }
  }
  return bytes
}
try {
  await start()
  await call('set_source', { source: 'bilibili' })
  await call('set_content_preferences', { source: 'bilibili', contentType: 'video', category: 'all' })
  stage = 'video-homepage'
  const home = await call('list_series')
  assert.ok(home.items.length > 3 && home.items.every(p => p.contentType === 'video'))
  report.homepageVideos = home.items.length
  stage = 'video-search'
  try {
    const search = await call('list_series', { query: '摄影教程' })
    assert.ok(search.items.length); report.searchResults = search.items.length
  } catch (error) {
    if (!['verification', 'rate-limited'].includes(error.reason)) throw error
    report.search = 'RESTRICTED'; report.searchRestriction = error.reason
  }
  stage = 'category-discovery'
  try {
    const regional = await call('list_series', { contentType: 'video', category: '36' })
    assert.ok(regional.items.length); report.categoryVideos = regional.items.length
  } catch (error) {
    if (!['verification', 'rate-limited'].includes(error.reason)) throw error
    report.category = 'RESTRICTED'; report.categoryRestriction = error.reason
  }
  stage = 'single-video'
  const single = (await call('list_series', { query: 'BV1xx411c7mD' })).items[0]
  assert.equal(single.contentType, 'video')
  const singleParts = (await call('get_episodes', { seriesId: single.id })).items
  assert.equal(singleParts.length, 1)
  const first = singleParts[0], began = Date.now()
  const ready = await prepared(first.id)
  report.singleIndexReadyMs = Date.now() - began
  stage = 'single-video-av-decode'
  report.singleDecodedBytes = await decode(first.id, ready)
  report.singleVideo = 'PASS'
  stage = 'multi-p'
  const multi = (await call('list_series', { query: 'https://www.bilibili.com/video/BV17x411w7KC/?p=3' })).items[0]
  const parts = await call('get_episodes', { seriesId: multi.id })
  const third = parts.items.find(p => p.number === 3)
  assert.equal(third.id, multi.defaultEpisodeId)
  assert.ok(parts.items.length > 3)
  report.firstPageParts = parts.items.length; report.morePartsAvailable = !!parts.cursor
  const multiReady = await prepared(third.id)
  stage = 'multi-p-av-decode'
  report.multiDecodedBytes = await decode(third.id, multiReady)
  await call('save_progress', { seriesId: multi.id, episodeId: third.id, title: multi.title, label: 'P3 · ' + third.label, positionMs: 1000, durationMs: multiReady.durationMs })
  report.multiP = 'PASS'
  stage = 'chat-recommendations'
  const peer = new Store(root)
  peer.event({ session_id: 'video-qualification', turn_id: 'one', hook_event_name: 'UserPromptSubmit' }); peer.close()
  const picks = (await call('get_waiting_picks', { turnId: 'one' })).items
  assert.equal(picks[0].episodeId, third.id)
  assert.ok(picks.every(p => p.contentType === 'video'))
  report.videoChatPicks = picks.length
  stage = 'restart-resume'
  await client.close(); await start()
  const preferences = await call('get_preferences')
  assert.equal(preferences.defaultSource, 'bilibili'); assert.equal(preferences.contentPreferences.bilibili.contentType, 'video')
  assert.equal((await call('get_history', { contentType: 'video' })).items[0].episodeId, third.id)
  assert.equal((await call('get_history', { contentType: 'bangumi' })).items.length, 0)
  report.restartResume = 'PASS'
  stage = 'bangumi-regression'
  await call('set_content_preferences', { source: 'bilibili', contentType: 'bangumi' })
  const season = (await call('list_series', { query: 'ss2251' })).items[0]
  assert.equal((await call('get_episodes', { seriesId: season.id })).items.length, 13)
  const peer2 = new Store(root)
  peer2.event({ session_id: 'video-qualification', turn_id: 'two', hook_event_name: 'UserPromptSubmit' }); peer2.close()
  const seriesPicks = (await call('get_waiting_picks', { turnId: 'two' })).items
  assert.ok(seriesPicks.length && seriesPicks.every(p => p.contentType === 'bangumi'))
  report.bangumiCatalogAndChat = 'PASS'
  stage = 'hongguo-isolation'
  await call('set_source', { source: 'hongguo' })
  assert.equal((await call('get_history')).items.length, 0)
  const denied = await client.callTool({ name: 'prepare_playback', arguments: { panel, episodeId: third.id } })
  assert.equal(denied.isError, true)
  report.hongguoIsolation = 'PASS'; report.result = report.search === 'RESTRICTED' || report.category === 'RESTRICTED' ? 'PARTIAL' : 'PASS'
} catch (error) {
  report.result = 'FAIL'; report.stage = stage; report.errorType = error.name; report.reason = error.reason; process.exitCode = 1
} finally {
  await client?.close().catch(() => {})
  await rm(root, { recursive: true, force: true })
}
if (process.argv.includes('--report')) {
  const index = process.argv.indexOf('--report')
  await writeFile(process.argv[index + 1], JSON.stringify(report, null, 2) + '\n')
}
console.log(JSON.stringify(report))
