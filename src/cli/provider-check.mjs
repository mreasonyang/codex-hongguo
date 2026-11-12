import { existsSync } from 'node:fs'
import { rm, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { ProviderRegistry } from '../server/providers/registry.mjs'
import { packageFile, readPackage } from '../server/providers/package.mjs'
import { checkInstalledFfmpeg } from '../runtime/ffmpeg-runtime.mjs'
import { prepareCandidate, runFfmpeg } from '../server/media.mjs'
import { errorCodes, providerError } from '../../provider-kit/sdk/index.mjs'

export const stages = ['manifest', 'load', 'catalog', 'search', 'seriesPage2', 'detail', 'cover', 'episodes',
  'episodePage2', 'emptyResult', 'cancellation', 'resolve', 'runtime', 'media', 'decode', 'audio']
export const byteBudget = 16 * 1024 * 1024
const offline = () => { throw providerError('OFFLINE') }
const sampleStages = ['detail', 'cover', 'episodes', 'episodePage2', 'resolve']
const recoverable = new Set(['NETWORK', 'TIMEOUT', 'NOT_FOUND', 'CONTENT_UNAVAILABLE', 'NO_VIDEO', 'UNSUPPORTED_CODEC', 'MEDIA_EXPIRED'])

export async function checkProvider({ directory, root, action, query }, report) {
  let stage, remaining = byteBudget, fixture = {}, deadline
  let failedChecks = false
  const failedStages = new Set()
  const countedBodies = new WeakSet()
  function start(name) { stage = name; report(name, 'running') }
  function passed(details) { if (!failedStages.has(stage)) report(stage, 'passed', undefined, details) }
  const codeFor = error => errorCodes.includes(error?.code) ? error.code : 'NETWORK'
  function consume(size) {
    remaining -= size
    if (remaining < 0) throw providerError('BUDGET')
  }
  function budgetMedia(transport, defaultSignal) {
    return async (url, budget = remaining, timeout = 30000, redirects, range, signal = defaultSignal) => {
      if (remaining <= 0 || range?.length > remaining) throw providerError('BUDGET')
      const response = await transport(url, Math.min(budget, remaining), Math.min(timeout, 30000), redirects, range, signal)
      // A provider can return the context fetcher's response directly or supply its own transport.
      if (countedBodies.has(response.body)) return response
      async function* chunks() {
        for await (const chunk of response.body) { consume(chunk.byteLength); yield chunk }
      }
      const body = ReadableStream.from(chunks())
      countedBodies.add(body)
      return { ...response, body }
    }
  }
  const registry = new ProviderRegistry(root, { directory: '', builtins: [], contextOverrides: context => {
    if (action === 'test') return { fetch: fixture.fetch || offline, fetchMedia: fixture.fetchMedia || offline,
      mediaFetcher: () => fixture.fetchMedia || offline }
    const fetch = context.fetch
    const mediaFetcher = context.mediaFetcher
    return {
      fetch: async (url, options = {}) => {
        if (remaining <= 0) throw providerError('BUDGET')
        const response = await fetch(url, { ...options, budget: Math.min(remaining, options.budget ?? remaining) })
        if (!response.body) return response
        const bytes = await response.arrayBuffer()
        consume(bytes.byteLength)
        return new Response(bytes, { status: response.status, headers: response.headers })
      },
      fetchMedia: budgetMedia(context.fetchMedia),
      mediaFetcher: headers => budgetMedia(mediaFetcher(headers)),
    }
  } })
  try {
    start('manifest')
    const plugin = await readPackage(directory), { manifest } = plugin, id = manifest.id
    report(stage, 'passed', undefined, { identity: { id, version: manifest.version } })
    start('load')
    if (action === 'test') {
      globalThis.fetch = offline
      if (existsSync(join(directory, 'provider.fixture.mjs'))) {
        const { file } = await packageFile(plugin.directory, 'provider.fixture.mjs')
        fixture = await import(pathToFileURL(file).href)
      }
    }
    await registry.register(manifest, plugin.factory)
    if (!registry.list().some(row => row.id === id && row.available)) throw providerError('LOAD_FAILED')
    passed()
    if (action === 'load') return true
    // Leave a small cleanup margin inside the CLI parent's unchanged 45s limit.
    const signal = deadline = AbortSignal.timeout(43000)
    const context = registry.contentContext(id)
    const pageSize = action === 'doctor' ? 3 : 1
    const invoke = (method, args, options) => registry.invoke(id, method, args, { ...context, pageSize, signal, ...options })
    const check = async (name, work) => {
      start(name)
      try {
        const value = await work()
        passed(Array.isArray(value?.items) ? { itemCount: value.items.length } : undefined)
        return value
      }
      catch (error) {
        if (action !== 'doctor' || signal.aborted || !recoverable.has(codeFor(error))) throw error
        failedChecks = true; failedStages.add(name)
        report(name, 'failed', codeFor(error))
      }
    }
    const secondPage = async (name, method, args, options, first, independent = false) => {
      if (!first.cursor) return
      const work = async () => {
        const next = await invoke(method, args, { ...options, cursor: first.cursor })
        if (next.cursor === first.cursor || next.items.some(row => first.items.some(old => old.id === row.id))) throw providerError('CONTRACT')
        return next
      }
      if (independent) return check(name, work)
      start(name); const next = await work(); passed(); return next
    }
    const catalog = await check('catalog', async () => {
      const value = await invoke('listSeries', [], {})
      if (action === 'doctor' && manifest.queryMode !== 'link' && manifest.discovery !== false && !value.items.length)
        throw providerError('NOT_FOUND')
      return value
    }) ?? { items: [] }
    query ??= fixture.query ?? (manifest.queryMode === 'link' ? undefined : catalog.items[0]?.title)
    let search = { items: [] }, searchNext
    if (query) {
      search = await check('search', async () => {
        const value = await invoke('listSeries', [], { query })
        if (!value.items.length) throw providerError('NOT_FOUND')
        return value
      }) ?? search
      searchNext = await secondPage('seriesPage2', 'listSeries', [], { query }, search, true)
    }
    const catalogNext = await secondPage('seriesPage2', 'listSeries', [], {}, catalog, true)
    // Interleave real search and catalog results: a stale first search result
    // must not make every later sample unreachable. Never use fixture media in
    // doctor, and never hide a failed catalog/search/pagination check.
    const pool = [], seen = new Set()
    const searchItems = [...search.items, ...(searchNext?.items || [])]
    const catalogItems = [...catalog.items, ...(catalogNext?.items || [])]
    for (let index = 0; index < pageSize; index++) {
      for (const [origin, list] of [['search', searchItems], ['catalog', catalogItems]]) {
        const item = list[index]
        if (item && !seen.has(item.id)) { seen.add(item.id); pool.push({ item, origin }) }
      }
    }
    const limit = action === 'doctor' ? 3 : 1
    let playback
    start('detail')
    if (!pool.length) throw providerError('NOT_FOUND')
    for (const [index, { item, origin }] of pool.slice(0, limit).entries()) {
      if (index) for (const name of sampleStages) report(name, 'unverified')
      try {
        start('detail')
        const series = await invoke('getSeries', [item.id])
        if (series.id !== item.id) throw providerError('CONTRACT')
        passed()
        start('cover')
        const cover = await invoke('getCover', [item.id], { url: item.coverURL || series.coverURL })
        report(stage, cover ? 'passed' : 'unverified')
        start('episodes')
        const episodes = await invoke('listEpisodes', [item.id])
        const episode = episodes.items.find(ep => ep.playable !== false)
        if (!episode) throw providerError('NO_VIDEO')
        passed()
        await secondPage('episodePage2', 'listEpisodes', [item.id], {}, episodes)
        if (action === 'test') {
          if (fixture.missingQuery) {
            start('emptyResult')
            if ((await invoke('listSeries', [], { query: fixture.missingQuery })).items.length) throw providerError('CONTRACT')
            passed()
          }
          start('cancellation')
          try {
            await invoke('resolvePlayback', [episode.id], { signal: AbortSignal.abort() })
            throw providerError('CONTRACT')
          } catch (error) { if (error.code !== 'ABORTED') throw error }
          passed()
        }
        start('resolve')
        playback = await invoke('resolvePlayback', [episode.id])
        passed(action === 'doctor' ? { sampleAttempt: { index: index + 1, origin, outcome: 'selected' } } : undefined)
        break
      } catch (error) {
        if (action !== 'doctor' || signal.aborted || !recoverable.has(codeFor(error)) || index + 1 >= Math.min(limit, pool.length)) throw error
        report(stage, 'unverified', undefined, { sampleAttempt: { index: index + 1, origin, outcome: 'skipped', stage, code: codeFor(error) } })
      }
    }
    if (action === 'test') return true

    start('runtime')
    if (!await checkInstalledFfmpeg()) throw providerError('RUNTIME_UNAVAILABLE')
    passed()
    start('media')
    const fetchMedia = budgetMedia(playback.fetchMedia || registry.fetchers.get(id), signal)
    const output = join(root, 'output.mp4'), raw = join(root, 'sample.source')
    let last, mediaScope
    for (const candidate of playback.candidates) {
      try {
        const convert = async (args, input = null, capture = false, cwd) => {
          try { return await runFfmpeg(args, input, capture, cwd, { signal }) }
          catch { throw providerError(signal.aborted ? 'TIMEOUT' : 'MEDIA_FORMAT') }
        }
        const firstHlsSegment = candidate.kind === 'hls'
        await prepareCandidate(candidate, raw, output, fetchMedia, remaining, convert, { firstHlsSegment })
        if (!(await stat(output)).size) throw providerError('MEDIA_FORMAT')
        mediaScope = firstHlsSegment ? 'hls-first-segment' : 'complete'
        last = undefined
        break
      } catch (error) {
        last = error
        await rm(output, { force: true })
      } finally { await rm(raw, { recursive: true, force: true }) }
    }
    if (last) throw last
    report(stage, 'passed', undefined, { mediaScope })
    start('decode')
    // Frame hashes require actual decoded samples from both tracks.
    const frames = await runFfmpeg(['-protocol_whitelist', 'file', '-f', 'mov', '-i', output, '-t', '1',
      '-map', '0:v:0', '-map', '0:a:0?', '-f', 'framehash', 'pipe:1'], null, true, undefined, { signal })
    const hashes = frames.toString()
    if (!/^0,\s*-?\d+/m.test(hashes)) throw providerError('DECODE_FAILED')
    passed()
    if (/^#media_type 1: audio$/m.test(hashes)) {
      start('audio')
      if (!/^1,\s*-?\d+/m.test(hashes)) throw providerError('DECODE_FAILED')
      passed()
    }
    return !failedChecks
  } catch (error) {
    const fallback = { manifest: 'MANIFEST', load: 'LOAD_FAILED', media: 'MEDIA_FETCH', decode: 'DECODE_FAILED' }
    report(stage, 'failed', deadline?.aborted ? 'TIMEOUT' : errorCodes.includes(error.code) ? error.code : fallback[stage] || 'NETWORK')
    return false
  } finally { await registry.dispose() }
}
