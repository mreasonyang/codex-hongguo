import { PlayerError } from './errors.mjs'
import { hasFfmpeg, MediaCache, runFfmpeg } from './media.mjs'
import { ensureFfmpeg } from '../runtime/ffmpeg-runtime.mjs'
import { createHash } from 'node:crypto'
import { SharedCatalogCache } from './catalog-cache.mjs'

import { PanelMedia } from './panel-media.mjs'
import { SourceRegistry } from './sources/registry.mjs'
import { sourceId, qualify, parseId } from './sources/ids.mjs'
import { decodeCursor, sourceCall } from './sources/contracts.mjs'
export class Catalog {
  constructor(store, { sources = new SourceRegistry(store.root) } = {}) {
    this.store = store
    this.sources = sources
    this.ffmpeg = hasFfmpeg()
    this.covers = new Map()
    this.coverLookups = new Map()
    this.metadata = new SharedCatalogCache(store)
    this.firstPages = new Map()
    this.coverJobs = new Map()
    void this.prepareMediaRuntime().catch(() => {})
  }
  async syncProviders() {
    await this.sources.ready
  }
  prepareMediaRuntime() {
    this.preparingRuntime ??= ensureFfmpeg().then(() => { this.ffmpeg = true }).catch(error => {
      this.ffmpeg = false
      throw error
    }).finally(() => { this.preparingRuntime = null })
    return this.preparingRuntime
  }
  defaultSource() {
    const preferred = this.store.preferences().defaultSource
    return this.sources.defaultSource?.(preferred) ?? this.sources.fallback(preferred)
  }
  contentContext(source = this.defaultSource(), overrides = {}) {
    return this.sources.contentContext?.(source, this.store.preferences(), overrides) ?? {}
  }
  feedContext(context) { return !context.contentType || (context.contentType === 'bangumi' && !context.category) ? '' : JSON.stringify(context) }
  async list({ source = this.defaultSource(), query = '', cursor, preview, contentType, category } = {}) {
    if (!this.sources.loaded) await this.sources.ready
    source = sourceId(source)
    const adapter = this.sources.get(source)
    const context = this.contentContext(source, { contentType, category })
    if (!query && adapter.discovery === false) {
      const page = await sourceCall(() => adapter.listSeries({ cursor, pageSize: 16, ...context }))
      return { items: this.rows(page, true, source), cursor: page.cursor }
    }
    if (!query) return { items: this.withLocalSeries(await this.recommendations(preview, source, context), source, context), cursor: null }
    const page = await sourceCall(() => this.sources.get(source).listSeries({ query, cursor, pageSize: 16, ...context }))
    return { items: this.rows(page, true, source), cursor: page.cursor }
  }
  async recommendations(preview = false, source = this.defaultSource(), context = this.contentContext(source)) {
    if (!this.sources.loaded) await this.sources.ready
    source = sourceId(source)
    const adapter = this.sources.get(source)
    const feedContext = this.feedContext(context)
    if (adapter.discovery === false) {
      const rows = this.rows(await sourceCall(() => adapter.listSeries({ pageSize: 48, ...context })), false, source)
      this.store.saveWaitingFeed(rows, Date.now(), source, feedContext)
      return rows
    }
    const terms = adapter.recommendationTerms ?? this.store.preferences().searchTerms
    const key = 'feed:' + source + ':' + createHash('sha256').update(JSON.stringify(feedContext ? [terms, context] : terms)).digest('hex')
    const cached = this.store.catalogCache(key)?.value
    const titles = preview && !cached ? this.store.waitingFeed(true, source, feedContext) : []
    const refresh = this.metadata.get(key, async () => {
      const firstPage = Promise.withResolvers()
      this.firstPages.set(key, firstPage.promise)
      try {
        const rows = await this.collectFeed(firstPage.resolve, terms, source, context)
        if (!rows.length && this.sources.get(source).discovery !== false) throw new PlayerError('片源暂时不可达，请稍后重试', 503)
        const covered = rows.filter(row => row.hasCover)
        return { items: (covered.length >= 12 ? covered : rows).slice(0, 48),
          titles: rows.map(({ id, title, contentType, episodes }) => ({ id, title, ...(contentType ? { contentType } : {}), ...(episodes ? { episodes } : {}) })),
          covers: rows.flatMap(({ id }) => this.covers.get(id)?.url ? [[id, this.covers.get(id).url]] : []) }
      } finally { this.firstPages.delete(key) }
    }, { feed: feedContext ? { source, context: feedContext } : source }).then(value => this.feedItems(value))
    if (preview && (cached || titles.length)) {
      void refresh.catch(() => {})
      return cached ? this.feedItems(cached) : titles
    }
    const first = this.firstPages.get(key)
    return preview && first ? Promise.race([first, refresh]) : refresh
  }
  feedItems(value) {
    for (const [id, url] of value.covers) {
      if (this.covers.get(id)?.url !== url) this.covers.set(id, { url })
    }
    while (this.covers.size > 160) this.covers.delete(this.covers.keys().next().value)
    return value.items
  }
  withLocalSeries(rows, source, context = this.contentContext(source)) {
    const local = this.sources.get(source).localSeries?.(context)?.filter(row => !context.category || context.category === 'all' || row.category === context.category)
    return local?.length ? [...new Map([...this.rows({ items: local.slice(0, 8) }, true, source), ...rows].map(row => [row.id, row])).values()].slice(0, 48) : rows
  }
  async waitingRecommendations(source = this.defaultSource(), context = this.contentContext(source)) {
    this.sources.get(source)
    const feedContext = this.feedContext(context)
    const cached = this.store.waitingFeed(false, source, feedContext)
    if (cached.length) return this.withLocalSeries(cached, source, context)
    const previous = this.store.waitingFeed(true, source, feedContext)
    const refresh = this.recommendations(false, source, context)
    if (previous.length) {
      void refresh.catch(() => {})
      return this.withLocalSeries(previous, source, context)
    }
    await refresh
    return this.withLocalSeries(this.store.waitingFeed(true, source, feedContext), source, context)
  }
  async collectFeed(onFirstPage, terms = this.store.preferences().searchTerms, source = 'hongguo', context = {}) {
    const adapter = this.sources.get(source)
    const rows = new Map(),
      seen = new Set()
    const merge = (page) => {
      const wasEmpty = !rows.size
      for (const row of this.rows(page, false, source))
        if (!rows.has(row.id) || (!rows.get(row.id).hasCover && row.hasCover)) rows.set(row.id, row)
      if (wasEmpty && rows.size) onFirstPage([...rows.values()])
    }
    let cursor, lastError
    for (let i = 0; i < 6 && rows.size < 48; i++) {
      try {
        const page = await sourceCall(() => adapter.listSeries({ cursor, pageSize: 16, ...context }))
        merge(page)
        cursor = page.cursor
        if (!cursor || seen.has(cursor)) break
        seen.add(cursor)
      } catch (e) {
        lastError = e
        break
      }
    }
    for (const term of adapter.discovery === false ? [] : adapter.recommendationTerms ?? terms) {
      if (rows.size >= 24) break
      try {
        merge(await sourceCall(() => adapter.listSeries({ query: term, pageSize: 16, ...context })))
      } catch (e) {
        lastError = e
      }
    }
    if (!rows.size && lastError) throw lastError
    return [...rows.values()]
  }
  rows(page, lookupCover = false, source = 'hongguo') {
    const items = (page.items || [])
      .flatMap((s) => {
        let id
        try { id = qualify(source, s.id) } catch { return [] }
        if (typeof s.title !== 'string' || !s.title.trim() || s.title.length > 320) return []
        if (s.coverURL && this.covers.get(id)?.url !== s.coverURL) this.covers.set(id, { url: s.coverURL })
        return {
          id,
          title: s.title,
          description: s.description || '',
          episodes: s.episodes || null,
          ...(s.contentType ? { contentType: s.contentType } : {}),
          ...(s.author ? { author: String(s.author).slice(0, 80) } : {}),
          ...(s.durationMs > 0 ? { durationMs: s.durationMs } : {}),
          ...(s.defaultEpisodeId ? { defaultEpisodeId: qualify(source, s.defaultEpisodeId, 'episode') } : {}),
          hasCover: !!this.covers.get(id)?.url,
          ...(lookupCover ? { lookupCover: true } : {}),
        }
      })
    while (this.covers.size > 160) this.covers.delete(this.covers.keys().next().value)
    return items
  }
  async cover(id) {
    this.sources.forId(id)
    if (!this.ffmpeg) return { cover: null }
    const entry = this.covers.get(id)
    if (entry?.cover !== undefined) return { cover: entry.cover }
    if (this.coverLookups.has(id)) return this.coverLookups.get(id)
    const { source } = parseId(id)
    if ((this.coverJobs.get(source) || 0) >= 3) return { cover: null }
    this.coverJobs.set(source, (this.coverJobs.get(source) || 0) + 1)
    const job = this.loadCover(id).finally(() => {
      this.coverJobs.set(source, this.coverJobs.get(source) - 1)
      this.coverLookups.delete(id)
    })
    this.coverLookups.set(id, job)
    return job
  }
  async loadCover(id) {
    let entry = this.covers.get(id)
    try {
      const { adapter, id: raw } = this.sources.forId(id)
      const image = await sourceCall(() => adapter.getCover(raw, { url: entry?.url }))
      if (!image) return { cover: null }
      entry ||= {}
      this.covers.set(id, entry)
      while (this.covers.size > 160) this.covers.delete(this.covers.keys().next().value)
      const jpeg = await runFfmpeg(
        [
          '-protocol_whitelist',
          'pipe',
          '-i',
          'pipe:0',
          '-vf',
          'scale=240:320:force_original_aspect_ratio=decrease',
          '-frames:v',
          '1',
          '-f',
          'image2pipe',
          '-c:v',
          'mjpeg',
          'pipe:1',
        ],
        image.bytes,
        true,
      )
      entry.cover = 'data:image/jpeg;base64,' + jpeg.toString('base64')
    } catch {
      return { cover: null }
    }
    return { cover: entry.cover }
  }
  async episodes({ seriesId, cursor }) {
    if (!this.sources.loaded) await this.sources.ready
    this.sources.forId(seriesId)
    const ref = parseId(seriesId)
    const canPlay = this.ffmpeg || this.sources.get(ref.source).progressivePlayback === true
    const key = 'episodes:v2:' + JSON.stringify([seriesId, decodeCursor(cursor, ref.source, 'episodes', ref.id) ?? null])
    const page = await this.metadata.get(key, () => this.loadEpisodes(seriesId, cursor))
    return { ...page, items: page.items.map(ep => ({ ...ep, playable: ep.playable && canPlay })) }
  }
  async loadEpisodes(seriesId, cursor) {
    if (!this.sources.loaded) await this.sources.ready
    const { adapter, id, source } = this.sources.forId(seriesId)
    const page = await sourceCall(() => adapter.listEpisodes(id, { cursor, pageSize: 120 }))
    return {
      ...(page.series ? { series: this.rows({ items: [page.series] }, true, source)[0] } : {}),
      items: (page.items || [])
        .map((ep) => ({
          id: qualify(source, ep.id, 'episode'),
          number: ep.number,
          label: ep.label,
          codec: '',
          playable: ep.playable !== false,
        })),
      cursor: page.cursor,
    }
  }
  async nextEpisode(seriesId, episodeId) {
    let cursor, found = false
    const seen = new Set(), episodes = new Set()
    do {
      const page = await this.episodes({ seriesId, cursor })
      for (const ep of page.items) {
        if (episodes.has(ep.id)) continue
        episodes.add(ep.id)
        if (ep.id === episodeId) found = true
        else if (found && ep.playable) {
          const [progress] = this.store.history(seriesId, ep.id)
          if (!progress || progress.positionMs < progress.durationMs)
            return { episodeId: ep.id, kind: progress ? 'resume' : 'next' }
        }
      }
      cursor = page.cursor
      if (seen.has(cursor)) break
      seen.add(cursor)
    } while (cursor)
    return null
  }
  prepare(id, browser, retry, preload = false) {
    const { adapter } = this.sources.forId(id, 'episode')
    if (adapter.progressivePlayback) {
      this.panelMedia ??= new PanelMedia(this.store.root)
      const result = this.panelMedia.remote.prepare(id, () => this.sources.resolvePlayback(id),
        () => this.sources.forId(id, 'episode').adapter.auth?.revision?.() ?? '', retry, preload)
      if (result.status !== 'fallback') return result
    }
    if (!this.ffmpeg) {
      void this.prepareMediaRuntime().catch(() => {})
      return { status: 'preparing' }
    }
    if (adapter.rangedFilePlayback) {
      this.panelMedia ??= new PanelMedia(this.store.root)
      return this.panelMedia.file.prepare(id, () => this.sources.resolvePlayback(id),
        () => this.sources.forId(id, 'episode').adapter.auth?.revision?.() ?? '', retry, preload)
    }
    this.cache ??= new MediaCache(this.store, (ep) => this.sources.resolvePlayback(ep), {
      revision: ep => this.sources.forId(ep, 'episode').adapter.auth?.revision?.() ?? '',
    })
    const result = this.cache.prepare(id, retry)
    if (result.status !== 'ready') return result
    if (browser) return { ...result, src: 'media/' + id }
    this.panelMedia ??= new PanelMedia(this.store.root)
    return { ...result, ...this.panelMedia.prepare(id, this.cache.path(id), retry, result.codec, preload) }
  }
}
