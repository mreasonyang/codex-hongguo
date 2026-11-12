// Isolated, opt-in live verification. Output contains counts and fixed stages only.
// Source locators, titles, signatures, credentials and media never enter receipts.
import assert from 'node:assert/strict'
import { mkdtemp, rm, readFile, writeFile, mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve, dirname } from 'node:path'
import { createHash } from 'node:crypto'
import { setTimeout as pause } from 'node:timers/promises'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { runFfmpeg } from '../src/server/media.mjs'

if (!process.argv.includes('--live')) throw Error('Pass --live to request the upstream catalog; --playback also prepares one full episode.')
const scratch = await mkdtemp(join(tmpdir(), 'huangguo-verify-'))
const server = resolve('dist/server/index.mjs')
const report = { status: 'fail', checkedAt: new Date().toISOString(), platform: process.platform, arch: process.arch,
  upstreamCommit: 'a83dfd9a29b23d439da4f853d104568696cd401c',
  serverSha256: createHash('sha256').update(await readFile(server)).digest('hex'),
  fullEpisodeDecoded: false, installedAppPlaybackObserved: false }
let client, stage = 'start'
const failed = code => Object.assign(new Error('Verification failed'), { verificationCode: code })
try {
  client = new Client({ name: 'huangguo-verifier', version: '1.0.0' })
  await client.connect(new StdioClientTransport({ command: process.execPath,
    args: ['--no-warnings', server], env: { PATH: process.env.PATH, HONGGUO_DATA_DIR: join(scratch, 'data'),
      HONGGUO_PROVIDERS_DIR: '', ...(process.env.HONGGUO_RUNTIME_DIR ? { HONGGUO_RUNTIME_DIR: process.env.HONGGUO_RUNTIME_DIR } : {}) }, stderr: 'ignore' }))
  const opened = await client.callTool({ name: 'open_drama_panel', arguments: {} })
  const panel = opened._meta?.panel
  if (!panel) throw failed('PANEL_UNAVAILABLE')
  async function rpc(name, args = {}) {
    const reply = await client.callTool({ name, arguments: { panel, ...args } }, undefined, { timeout: 45000 })
    if (reply.isError || !reply._meta?.data) {
      // Keep only the host's fixed health fields, never raw error text or RPC data.
      try {
        const state = await client.callTool({ name: 'get_providers', arguments: { panel } })
        const health = state._meta?.data?.items?.find(item => item.id === 'huangguo')?.health
        const codes = ['NETWORK', 'TIMEOUT', 'CONTENT_UNAVAILABLE', 'CONTRACT', 'NOT_FOUND', 'NO_VIDEO', 'RATE_LIMITED', 'AUTHENTICATION_REQUIRED', 'ABORTED', 'HOST_NOT_ALLOWED']
        report.providerHealth = Object.fromEntries(Object.entries(health || {}).map(([key, value]) => [
          ['catalog', 'search', 'detail', 'cover', 'episodes', 'resolve'].includes(key) ? key : 'other',
          { status: ['passed', 'failed'].includes(value.status) ? value.status : 'other', ...(codes.includes(value.code) ? { code: value.code } : {}) },
        ]))
      } catch {}
      throw failed('RPC_FAILED')
    }
    return reply._meta.data
  }
  const providers = (await rpc('get_providers')).items
  assert.ok(providers.some(p => p.id === 'huangguo' && p.available && p.nsfw))
  stage = 'confirmation'
  const blocked = await client.callTool({ name: 'set_source', arguments: { panel, source: 'huangguo' } })
  assert.equal(blocked.isError, true)
  await rpc('set_source', { source: 'huangguo', confirmNsfw: true })
  report.confirmationRequired = true
  stage = 'catalog'
  const list = await rpc('list_series', { preview: true })
  if (!list.items?.length) throw failed('EMPTY_CATALOG')
  report.catalogItems = list.items.length
  const show = list.items[0]
  stage = 'search'
  report.searchQuery = 'AI'
  report.searchItems = (await rpc('list_series', { query: report.searchQuery })).items.length
  if (!report.searchItems) throw failed('EMPTY_SEARCH')
  stage = 'cover'
  report.coverDecoded = !!(await rpc('get_cover', { seriesId: show.id })).cover
  if (!report.coverDecoded) throw failed('COVER_UNAVAILABLE')
  stage = 'episodes'
  const episodes = await rpc('get_episodes', { seriesId: show.id })
  report.episodeCount = episodes.items.length
  const episode = episodes.items.find(ep => ep.playable)
  if (!episode) throw failed('NO_PLAYABLE_EPISODE')
  console.log(JSON.stringify({ stage: 'catalog-complete', catalogItems: report.catalogItems,
    searchItems: report.searchItems, episodeCount: report.episodeCount, coverDecoded: report.coverDecoded }))
  if (process.argv.includes('--playback')) {
    stage = 'prepare'
    const deadline = Date.now() + 240000
    let prepared
    while (Date.now() < deadline) {
      prepared = await rpc('prepare_playback', { episodeId: episode.id })
      if (prepared.status !== 'preparing') break
      await pause(500)
    }
    if (prepared?.status !== 'ready') throw failed('MEDIA_NOT_READY')
    stage = 'manifest'
    let manifest = prepared.manifest
    while (!manifest.includes('#EXT-X-ENDLIST') && Date.now() < deadline) {
      await pause(300)
      manifest = (await rpc('read_panel_manifest', { episodeId: episode.id, stream: prepared.stream })).manifest
    }
    if (!manifest.includes('#EXT-X-ENDLIST') || /https?:|EXT-X-KEY/.test(manifest)) throw failed('MANIFEST_INVALID')
    const assets = [...(prepared.format === 'hls' ? [] : ['init.mp4']), ...manifest.split(/\r?\n/).filter(line => line && !line.startsWith('#'))]
    const buffers = []
    let bytes = 0, chunks = 0
    stage = 'mcp-chunks'
    for (const asset of assets) {
      if (!/^(?:init\.mp4|seg\d{5}\.(?:m4s|ts))$/.test(asset)) throw failed('ASSET_INVALID')
      let offset = 0, size
      do {
        const part = await rpc('read_panel_chunk', { episodeId: episode.id, stream: prepared.stream, asset, offset })
        const buffer = Buffer.from(part.bytes, 'base64')
        if (!buffer.length || buffer.length > 192 * 1024) throw failed('CHUNK_INVALID')
        size = part.size; offset += buffer.length; bytes += buffer.length; chunks++
        if (bytes > 256 * 1024 * 1024) throw failed('MEDIA_BUDGET')
        buffers.push(buffer)
      } while (offset < size)
      if (offset !== size) throw failed('ASSET_INCOMPLETE')
    }
    const output = join(scratch, 'verified.mp4')
    await writeFile(output, Buffer.concat(buffers), { mode: 0o600 })
    stage = 'decode'
    await runFfmpeg(['-xerror', '-protocol_whitelist', 'file', '-i', output, '-map', '0:v:0', '-map', '0:a:0', '-f', 'null', '-'])
    Object.assign(report, { fullEpisodeDecoded: true, durationMs: prepared.durationMs, assets: assets.length, chunkCalls: chunks, mediaBytes: bytes })
    stage = 'history'
    await rpc('save_progress', { seriesId: show.id, episodeId: episode.id, title: show.title, label: episode.label,
      positionMs: 1000, durationMs: Math.max(1001, prepared.durationMs) })
    assert.equal((await rpc('get_history')).items.length, 1)
    await rpc('set_source', { source: 'hongguo' })
    assert.equal((await rpc('get_history')).items.length, 0)
    await rpc('set_source', { source: 'huangguo', confirmNsfw: true })
    assert.equal((await rpc('get_history')).items[0].positionMs, 1000)
    report.historyIsolated = true
  }
  report.status = 'pass'
} catch (error) {
  report.failedStage = stage
  report.failureCode = ['PANEL_UNAVAILABLE', 'RPC_FAILED', 'EMPTY_CATALOG', 'EMPTY_SEARCH', 'COVER_UNAVAILABLE', 'NO_PLAYABLE_EPISODE',
    'MEDIA_NOT_READY', 'MANIFEST_INVALID', 'ASSET_INVALID', 'CHUNK_INVALID', 'MEDIA_BUDGET', 'ASSET_INCOMPLETE'].includes(error?.verificationCode)
    ? error.verificationCode : 'CHECK_FAILED'
  process.exitCode = 1
} finally {
  await client?.close().catch(() => {})
  await rm(scratch, { recursive: true, force: true })
}
const index = process.argv.indexOf('--report')
if (index >= 0) {
  const path = resolve(process.argv[index + 1])
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, JSON.stringify(report, null, 2) + '\n')
}
console.log(JSON.stringify(report))
