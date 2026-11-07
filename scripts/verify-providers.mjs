// Opt-in live checks through the compiled MCP server, using disposable app state.
// Only fixed stages/counts leave this process. Locators, keys and capabilities stay private.
import assert from 'node:assert/strict'
import { mkdtemp, readFile, writeFile, rm, mkdir, access } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { createHash } from 'node:crypto'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { ensureFfmpeg } from '../src/runtime/ffmpeg-runtime.mjs'
import { spawnSync } from '../src/runtime/executables.mjs'

if (!process.argv.includes('--live')) {
  console.log('真实 Provider 验证需要显式传入 --live；使用临时数据并获取两片源各一集。')
  process.exit(0)
}
const scratch = await mkdtemp(join(tmpdir(), 'hongguo-providers-live-'))
const report = { schema: 1, checkedAt: new Date().toISOString(), runtime: process.version,
  compiledServerSha256: createHash('sha256').update(await readFile('dist/server/index.mjs')).digest('hex'),
  providers: [], desktopPlaybackObserved: false, isolatedState: true }
const pause = ms => new Promise(resolve => setTimeout(resolve, ms))
const fail = code => Object.assign(Error(code), { code })
let client, stage = 'setup'
try {
  const ffmpeg = await ensureFfmpeg()
  await mkdir(join(scratch, 'plugins'))
  const transport = new StdioClientTransport({ command: process.execPath,
    args: ['--no-warnings', resolve('dist/server/index.mjs')], stderr: 'pipe',
    env: { PATH: process.env.PATH || '', HONGGUO_DATA_DIR: join(scratch, 'data'),
      HONGGUO_PROFILE_PATH: join(scratch, 'anonymous.json'), HONGGUO_FFMPEG: ffmpeg,
      HONGGUO_PROVIDERS_DIR: join(scratch, 'plugins'),
      ...Object.fromEntries(['SystemRoot', 'WINDIR', 'ComSpec'].filter(key => process.env[key]).map(key => [key, process.env[key]])),
    },
  })
  client = new Client({ name: 'provider-live-verifier', version: '1.0.0' })
  await client.connect(transport)
  transport.stderr?.resume()
  const opened = await client.callTool({ name: 'open_drama_panel', arguments: {} })
  const panel = opened._meta?.panel
  if (!panel) throw fail('PANEL_UNAVAILABLE')
  async function rpc(name, args = {}, timeout = 90000) {
    const reply = await client.callTool({ name, arguments: { panel, ...args } }, undefined, { timeout })
    if (reply.isError || !reply._meta?.data) throw fail('RPC_FAILED')
    return reply._meta.data
  }
  const available = (await rpc('get_providers')).items.filter(p => p.available)
  assert.ok(available.some(p => p.id === 'hongguo') && available.some(p => p.id === 'hghub'))
  for (const source of ['hongguo', 'hghub']) {
    const started = performance.now(), result = { source, fullEpisodeDecoded: false, attemptedShows: 0 }
    report.providers.push(result)
    stage = source + ':catalog'
    await rpc('set_source', { source })
    const catalog = await rpc('list_series', { source, preview: true })
    if (!catalog.items?.length) throw fail('EMPTY_CATALOG')
    result.catalogItems = catalog.items.length
    console.log(JSON.stringify({ stage, status: 'pass', count: catalog.items.length }))
    let chosen, prepared, series
    for (const show of catalog.items.slice(0, 2)) {
      result.attemptedShows++
      stage = source + ':episodes'
      const page = await rpc('get_episodes', { seriesId: show.id })
      chosen = page.items.find(ep => ep.playable)
      if (!chosen) continue
      result.episodeCount = page.items.length
      stage = source + ':prepare'
      const deadline = Date.now() + 180000
      while (Date.now() < deadline) {
        prepared = await rpc('prepare_playback', { episodeId: chosen.id }, 20000)
        if (prepared.status !== 'preparing') break
        await pause(500)
      }
      if (prepared?.status === 'ready') { series = show; break }
    }
    if (!series || prepared?.status !== 'ready') throw fail('NO_READY_EPISODE')
    stage = source + ':complete-manifest'
    const deadline = Date.now() + 180000
    let manifest = prepared.manifest
    while (!manifest.includes('#EXT-X-ENDLIST') && Date.now() < deadline) {
      await pause(300)
      manifest = (await rpc('read_panel_manifest', { episodeId: chosen.id, stream: prepared.stream })).manifest
    }
    if (!manifest.includes('#EXT-X-ENDLIST')) throw fail('MANIFEST_INCOMPLETE')
    assert.ok(!manifest.includes('https:') && !manifest.includes('EXT-X-KEY'))
    const assets = ['init.mp4', ...manifest.split(/\r?\n/).filter(line => line && !line.startsWith('#'))]
    let bytes = 0, chunks = 0
    const buffers = []
    stage = source + ':mcp-chunks'
    for (const asset of assets) {
      assert.match(asset, /^(?:init\.mp4|seg\d{5}\.m4s)$/)
      let offset = 0, size
      do {
        const part = await rpc('read_panel_chunk', { episodeId: chosen.id, stream: prepared.stream, asset, offset })
        const buffer = Buffer.from(part.bytes, 'base64')
        assert.ok(buffer.length && buffer.length <= 192 * 1024)
        size = part.size; offset += buffer.length; bytes += buffer.length; chunks++
        if (bytes > 256 * 1024 * 1024) throw fail('MEDIA_BUDGET')
        buffers.push(buffer)
      } while (offset < size)
      assert.equal(offset, size)
    }
    const output = join(scratch, source + '.mp4')
    await writeFile(output, Buffer.concat(buffers), { mode: 0o600 })
    stage = source + ':decode'
    const decode = spawnSync(ffmpeg, ['-v', 'error', '-xerror', '-protocol_whitelist', 'file', '-i', output,
      '-map', '0:v:0', '-map', '0:a:0', '-f', 'null', '-'], { stdio: 'ignore', timeout: 120000 })
    if (decode.status !== 0) throw fail('DECODE_FAILED')
    stage = source + ':history'
    await rpc('save_progress', { seriesId: series.id, episodeId: chosen.id, title: series.title,
      label: chosen.label, positionMs: 1000, durationMs: Math.max(1001, prepared.durationMs) })
    const history = await rpc('get_history', { source })
    assert.ok(history.items.some(row => row.seriesId === series.id && row.episodeId === chosen.id))
    Object.assign(result, { fullEpisodeDecoded: true, durationMs: prepared.durationMs, assets: assets.length,
      chunkCalls: chunks, bytes, historySaved: true, elapsedMs: Math.round(performance.now() - started) })
    console.log(JSON.stringify({ stage: source + ':complete', ...result }))
  }
  stage = 'source-history-isolation'
  for (const source of ['hongguo', 'hghub']) {
    const history = await rpc('get_history', { source })
    assert.equal(history.items.length, 1)
    assert.ok(history.items[0].seriesId.startsWith(source === 'hongguo' ? 'hg-' : 'hh-'))
  }
  report.historyIsolated = true
  report.status = 'pass'
  const control = process.argv.indexOf('--browser-control')
  if (control >= 0) {
    stage = 'browser-handoff'
    const path = resolve(process.argv[control + 1])
    // Private one-use capability transfer to the local browser driver, never an evidence artifact.
    await writeFile(path, JSON.stringify(await rpc('create_browser_pairing', { follow: false })), { mode: 0o600 })
    console.log(JSON.stringify({ stage: 'browser-ready', isolated: true }))
    const until = Date.now() + 10 * 60000
    while (Date.now() < until) {
      try { await access(path) } catch { break }
      await pause(300)
    }
    await rm(path, { force: true })
  }
} catch (error) {
  report.status = 'fail'
  report.failure = { stage, code: /^[A-Z_]{1,40}$/.test(error?.code) ? error.code : 'CHECK_FAILED' }
  console.log(JSON.stringify(report.failure)); process.exitCode = 1
} finally {
  await client?.close().catch(() => {})
  await rm(scratch, { recursive: true, force: true })
  const directory = resolve('docs/audits/2026-11-08-provider-implementation')
  await mkdir(directory, { recursive: true })
  await writeFile(join(directory, 'live-mcp.json'), JSON.stringify(report, null, 2) + '\n')
  console.log(JSON.stringify({ status: report.status, decodedProviders: report.providers.filter(p => p.fullEpisodeDecoded).length,
    desktopPlaybackObserved: false }))
}
