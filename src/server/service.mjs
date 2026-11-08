import { randomBytes } from 'node:crypto'
import { z } from 'zod'
import { callerId } from './store.mjs'
import { PlayerError } from './errors.mjs'
import { manualHooks } from './setup.mjs'
import { providerPattern, seriesPattern, episodePattern, parseId, matchesSeries } from './sources/ids.mjs'

export const secret = () => randomBytes(24).toString('base64url')
const id = z.string().regex(/^[a-zA-Z0-9_-]{1,128}$/)
const dramaId = z.string().regex(seriesPattern)
const episodeId = z.string().regex(episodePattern)
const source = z.string().regex(providerPattern)
const cursor = z.string().max(4096).optional()
const short = z.string().min(1).max(320)
const ms = z
  .number()
  .int()
  .min(0)
  .max(24 * 3600 * 1000)
export const schemas = {
  get_run_state: z.object({ turnId: id.optional(), playerInstance: id.optional(), observeSession: z.literal(true).optional() }),
  set_player_visible: z.object({ instance: id, visible: z.boolean() }),
  get_waiting_picks: z.object({ turnId: id.optional(), inView: z.literal(true).optional() }),
  mark_waiting_picks_shown: z.object({ turnId: id.optional() }),
  get_waiting_status: z.object({}),
  dismiss_waiting_picks: z.object({ turnId: id.optional() }),
  browse_waiting_catalog: z.object({}),
  select_waiting_pick: z.object({ seriesId: dramaId }),
  activate_waiting_player: z.object({}),
  confirm_waiting_playback: z.object({ playbackId: z.number().int().positive() }),
  list_sessions: z.object({}),
  select_session: z.object({ choice: id }),
  list_series: z.object({
    source: source.optional(),
    preview: z.literal(true).optional(),
    query: z.string().max(120).optional(),
    cursor,
  }),
  get_cover: z.object({ seriesId: dramaId }),
  get_episodes: z.object({ seriesId: dramaId, cursor }),
  set_source: z.object({ source, remember: z.boolean().optional() }),
  get_history: z.object({ seriesId: dramaId.optional(), episodeId: episodeId.optional(), source: source.optional() }),
  save_progress: z.object({
    seriesId: dramaId,
    episodeId,
    title: short,
    label: short,
    positionMs: ms,
    durationMs: ms.positive(),
    reset: z.literal(true).optional(),
  }),
  prepare_playback: z.object({ episodeId, retry: z.boolean().optional() }),
  preload_playback: z.object({ episodeId }),
  create_browser_pairing: z.object({
    follow: z.boolean().optional(),
    turnId: id.optional(),
    seriesId: dramaId.optional(),
    episodeId: episodeId.optional(),
    title: short.optional(),
  }),
  get_health: z.object({}),
  get_setup_status: z.object({}),
  set_setup_dismissed: z.object({ dismissed: z.boolean() }),
  get_preferences: z.object({}),
  get_providers: z.object({}),
  get_provider_auth: z.object({ source }),
  start_provider_login: z.object({ source }),
  poll_provider_login: z.object({ source, loginId: id }),
  cancel_provider_login: z.object({ source, loginId: id }),
  logout_provider: z.object({ source }),
  set_preferences: z.object({
    autoPrompt: z.boolean().optional(),
    searchTerms: z.array(z.string().trim().min(1).max(30)).min(1).max(6).optional(),
    autoplayNext: z.boolean().optional(),
    autoPauseOnFinish: z.boolean().optional(),
    autoPlayOnStart: z.boolean().optional(),
    defaultMuted: z.boolean().optional(),
    hoverDecoyEnabled: z.boolean().optional(),
    coverStyle: z.enum(['random', 'tasks', 'document', 'report', 'minutes']).optional(),
    volume: z.number().positive().max(1).optional(),
    enabledProviders: z.array(source).min(1).max(32).refine(ids => ids.includes('hongguo')).optional(),
  }),
  read_panel_chunk: z.object({
    episodeId,
    stream: id,
    asset: z.string().max(32),
    offset: z
      .number()
      .int()
      .nonnegative()
      .max(32 * 1024 * 1024),
  }),
  read_panel_manifest: z.object({ episodeId, stream: id }),
  remove_history: z.object({ seriesId: dramaId }),
}
export class Service {
  constructor(store, catalog) {
    this.store = store
    this.catalog = catalog
    this.panels = new Map()
  }
  open(meta) {
    const key = secret(),
      scope = { sessionId: callerId(meta), choices: new Map(), lastSeen: Date.now(), source: this.catalog.defaultSource?.() ?? this.store.preferences().defaultSource }
    for (const [k, v] of this.panels) if (Date.now() - v.lastSeen > 12 * 3600000) this.panels.delete(k)
    scope.caller = scope.sessionId
    this.panels.set(key, scope)
    return { panel: key, state: this.store.state(scope.sessionId), identified: !!scope.sessionId, source: scope.source }
  }
  openWaiting(meta, turnId) {
    const sessionId = callerId(meta)
    if (!sessionId || [meta?.turn_id, meta?.turnId].some(value => value !== undefined && value !== turnId) ||
      !this.store.claimCard(sessionId, turnId)) return null
    const initial = this.open(meta)
    this.panels.get(initial.panel).waiting = { turnId, selected: null, taken: false }
    return initial
  }
  async resumePick(source = 'hongguo') {
    for (const row of this.store.history(undefined, undefined, -1, source)) {
      if (!dramaId.safeParse(row.seriesId).success || !episodeId.safeParse(row.episodeId).success) continue
      const show = { id: row.seriesId, title: row.title }
      if (row.positionMs < row.durationMs) return { ...show, episodeId: row.episodeId, kind: 'resume' }
      try {
        const next = await this.catalog.nextEpisode(row.seriesId, row.episodeId)
        if (next) return { ...show, ...next }
      } catch {
        // One removed or unavailable show must not hide another show's continuation.
        continue
      }
    }
    return null
  }
  async waitingPicks(sessionId, turnId, inView, eligible, preferred) {
    if (!eligible()) return { items: [] }
    const pinned = this.store.turnPicks(sessionId, turnId)
    const enabled = pick => {
      try {
        const source = parseId(pick.id).source
        return !this.catalog.sources?.fallback || this.catalog.sources.fallback(source) === source
      } catch { return false }
    }
    if (pinned.length) return { items: pinned.filter(enabled) }
    const source = this.store.recommendationSource(sessionId, turnId, preferred)
    if (this.catalog.sources?.fallback && this.catalog.sources.fallback(source) !== source) return { items: [] }
    const [feed, resume] = await Promise.all([
      this.catalog.waitingRecommendations(source).catch(() => []), this.resumePick(source),
    ])
    return { items: this.store.allocatePicks(sessionId, turnId, resume, feed, inView, eligible) }
  }
  panel(key, meta) {
    const scope = this.panels.get(key)
    if (!scope || Date.now() - scope.lastSeen > 12 * 3600000) throw new PlayerError('请重新打开短剧面板', 401)
    if ((meta?.thread_id !== undefined || meta?.threadId !== undefined) && callerId(meta) !== scope.caller)
      throw new PlayerError('会话不匹配', 403)
    scope.lastSeen = Date.now()
    return scope
  }
  resetSource(scope, source) {
    scope.source = source
    const belongs = id => { try { return parseId(id).source === source } catch { return false } }
    if (scope.selection && !belongs(scope.selection.seriesId)) scope.selection = undefined
    if (scope.waiting?.selected && !belongs(scope.waiting.selected.id)) scope.waiting.selected = null
    scope.sourceRevision = (scope.sourceRevision || 0) + 1
    scope.allowed?.clear(); scope.grants?.clear()
    this.catalog.panelMedia?.unpin(scope.playing, scope)
    scope.streams?.clear(); scope.playing = null
  }
  async syncProviders(scope) {
    await this.catalog.syncProviders?.()
    if (!this.catalog.sources?.fallback) return
    for (const panel of new Set([...this.panels.values(), scope])) {
      const source = this.catalog.sources.fallback(panel.source)
      if (source !== panel.source) this.resetSource(panel, source)
      const revision = this.catalog.sources.get(source).auth?.revision?.()
      if (panel.authRevision !== undefined && panel.authRevision !== revision) this.resetSource(panel, source)
      panel.authRevision = revision
    }
  }
  preferences() {
    const settings = this.store.preferences()
    return { ...settings, defaultSource: this.catalog.defaultSource?.() ?? settings.defaultSource }
  }
  async call(scope, name, args, browser = false) {
    const a = schemas[name]?.strict().safeParse(args)
    if (!a?.success) throw new PlayerError('请求参数无效')
    const p = a.data
    if (this.catalog.syncProviders) await this.syncProviders(scope)
    switch (name) {
      case 'get_waiting_status':
      case 'browse_waiting_catalog': {
        const card = scope.waiting
        if (browser || !card) throw new PlayerError('请从本轮推荐中选剧', 403)
        if (name === 'get_waiting_status') return { visible: this.store.offerable(scope.sessionId, card.turnId) }
        card.selected = null
        card.taken = false
        card.browsing = true
        card.played = true
        return {}
      }
      case 'dismiss_waiting_picks': {
        const turnId = p.turnId ?? scope.waiting?.turnId
        if (!scope.sessionId || !turnId ||
          (scope.waiting && turnId !== scope.waiting.turnId) ||
          (browser && scope.fixedTurn && turnId !== scope.fixedTurn) ||
          !this.store.state(scope.sessionId, turnId).turnId) throw new PlayerError('请从本轮推荐中选剧', 403)
        return this.store.dismissPicks(scope.sessionId, turnId)
      }
      case 'get_waiting_picks':
      case 'mark_waiting_picks_shown': {
        const card = scope.waiting
        const turnId = p.turnId ?? card?.turnId
        if (!scope.sessionId || !turnId || (browser && scope.fixedTurn && turnId !== scope.fixedTurn) ||
          (card && p.turnId && !card.taken))
          throw new PlayerError('请从本轮推荐中选剧', 403)
        const eligible = () => p.turnId
          ? this.store.activeTurn(scope.sessionId, turnId) && this.store.preferences().autoPrompt && !this.store.picksDismissed(scope.sessionId, turnId)
          : this.store.offerable(scope.sessionId, turnId)
        if (name === 'mark_waiting_picks_shown') return this.store.markPicksShown(scope.sessionId, turnId, eligible)
        return this.waitingPicks(scope.sessionId, turnId, !!p.inView, eligible, scope.source)
      }
      case 'select_waiting_pick':
      case 'confirm_waiting_playback':
      case 'activate_waiting_player': {
        const card = scope.waiting
        if (browser || !card) throw new PlayerError('请从本轮推荐中选剧', 403)
        if (name === 'confirm_waiting_playback') {
          if (card.playbackId === p.playbackId) card.played = true
          return {}
        }
        if (name === 'select_waiting_pick') {
          this.catalog.sources?.forId(p.seriesId)
          if (!this.store.offerable(scope.sessionId, card.turnId)) throw new PlayerError('这条推荐已结束')
          const pick = this.store.turnPicks(scope.sessionId, card.turnId).find(item => item.id === p.seriesId)
          if (!pick) throw new PlayerError('请从本轮推荐中选剧', 403)
          this.store.markPicksShown(scope.sessionId, card.turnId, () => this.store.offerable(scope.sessionId, card.turnId))
          card.selected = pick
          scope.source = parseId(pick.id).source
          card.taken = false
          card.browsing = false
          card.played = false
          card.playbackId = (card.playbackId || 0) + 1
          return {}
        }
        // Mounting is not playback: a host can replace or redraw the iframe before it starts.
        const running = this.store.activeTurn(scope.sessionId, card.turnId)
        const play = !!card.selected && !card.played && running &&
          !this.store.picksDismissed(scope.sessionId, card.turnId)
        card.taken = true
        if (card.browsing) {
          this.store.dismissPicks(scope.sessionId, card.turnId)
          card.browsing = false
        }
        return { pick: card.selected, turnId: card.turnId, play, ...(play ? { playbackId: card.playbackId } : {}),
          ...(card.selected && !running ? { reason: 'turn-ended' } : {}) }
      }
      case 'set_player_visible':
        if (scope.waiting && !scope.waiting.taken) throw new PlayerError('请从本轮推荐中选剧', 403)
        this.store.playerVisible(scope.sessionId, p.instance, p.visible)
        return {}
      case 'get_run_state': {
        if (!this.store.persistent) throw new PlayerError('本机会话状态不可达', 503)
        this.store.touchPlayer(scope.sessionId, p.playerInstance)
        // A mounted player observes its own chat across turns. An unclaimed card
        // and legacy fixed-turn browser links retain their original scope.
        if (p.observeSession) {
          if (p.turnId || (scope.waiting && !scope.waiting.taken)) throw new PlayerError('请先打开播放器', 403)
          return {
            ...this.store.state(scope.sessionId, browser ? scope.fixedTurn : undefined),
            preferences: this.preferences(),
            source: scope.source,
            authRevision: scope.authRevision,
          }
        }
        const fixed = scope.waiting?.turnId ?? (browser ? scope.fixedTurn : null)
        if (fixed && p.turnId && p.turnId !== fixed) throw new PlayerError('播放器已绑定其他回合', 403)
        const turn = fixed ?? p.turnId
        const state = this.store.state(scope.sessionId, turn)
        if (scope.waiting && state.state === 'submitted' && !this.store.activeTurn(scope.sessionId, turn))
          return { ...state, state: 'unknown' }
        return state
      }
      case 'list_sessions':
        if (browser || scope.sessionId) throw new PlayerError('当前入口不允许选择其他会话', 403)
        scope.choices.clear()
        return {
          items: this.store.candidates().map((row) => {
            const choice = secret()
            scope.choices.set(choice, row.session_id)
            return { choice, suffix: row.session_id.slice(-8), at: row.at }
          }),
        }
      case 'select_session':
        if (browser || scope.sessionId || !scope.choices.has(p.choice))
          throw new PlayerError('请重新选择会话', 403)
        scope.sessionId = scope.choices.get(p.choice)
        scope.choices.clear()
        return this.store.state(scope.sessionId)
      case 'list_series':
        return this.catalog.list({ ...p, source: p.source ?? scope.source })
      case 'set_source':
        await this.catalog.sources?.ready
        this.catalog.sources?.get(p.source)
        if (p.remember !== false) {
          if (!this.store.persistent) throw new PlayerError('本机设置目录不可写', 503)
          this.store.setPreferences({ defaultSource: p.source })
        }
        this.resetSource(scope, p.source)
        return { source: p.source }
      case 'get_cover':
        return this.catalog.cover(p.seriesId)
      case 'get_episodes': {
        const revision = scope.sourceRevision
        const page = await this.catalog.episodes(p)
        if (scope.sourceRevision !== revision) throw new PlayerError('选源已变更，请重新选剧')
        scope.allowed ??= new Set()
        for (const ep of page.items) if (ep.playable && matchesSeries(p.seriesId, ep.id)) scope.allowed.add(ep.id)
        return page
      }
      case 'get_history':
        return { items: this.store.history(p.seriesId, p.episodeId, 30, p.source ?? scope.source) }
      case 'remove_history':
        return this.store.removeHistory(p.seriesId)
      case 'read_panel_chunk':
      case 'read_panel_manifest':
        if (browser || scope.streams?.get(p.episodeId) !== p.stream)
          throw new PlayerError('请先准备当前分集', 403)
        if (name === 'read_panel_manifest') return this.catalog.panelMedia.manifest(p.episodeId, p.stream)
        return this.catalog.panelMedia.chunk(p.episodeId, p.stream, p.asset, p.offset)
      case 'save_progress':
        if (!matchesSeries(p.seriesId, p.episodeId)) throw new PlayerError('剧目与分集来源不匹配')
        if (!this.store.persistent) throw new PlayerError('本机进度目录不可写', 503)
        this.catalog.cache?.hold(p.episodeId)
        return this.store.save(p)
      case 'preload_playback': {
        if (!scope.allowed?.has(p.episodeId))
          throw new PlayerError('请先选择可播放的分集', 403)
        // Warm the shared cache without changing the current stream or granting
        // access to speculative media. Playback still goes through prepare_playback.
        const { status } = this.catalog.prepare(p.episodeId, browser, false, true)
        return { status }
      }
      case 'prepare_playback': {
        if (!scope.allowed?.has(p.episodeId))
          throw new PlayerError('请先选择可播放的分集', 403)
        if (!browser && scope.playing !== p.episodeId) {
          this.catalog.panelMedia?.unpin(scope.playing, scope)
          scope.streams?.clear()
          scope.playing = p.episodeId
        }
        const result = this.catalog.prepare(p.episodeId, browser, !!p.retry)
        if (browser && result.status === 'ready') scope.grants.add(p.episodeId)
        if (!browser && result.stream) {
          this.catalog.panelMedia.pin(p.episodeId, scope)
          scope.streams ??= new Map()
          scope.streams.set(p.episodeId, result.stream)
        }
        return result
      }
      case 'get_preferences':
        return this.preferences()
      case 'get_provider_auth':
      case 'start_provider_login':
      case 'poll_provider_login':
      case 'cancel_provider_login':
      case 'logout_provider': {
        const auth = this.catalog.sources?.get(p.source).auth
        if (!auth) throw new PlayerError('该片源不支持登录')
        if (name === 'get_provider_auth') return auth.status()
        if (name === 'start_provider_login') return auth.start(scope)
        if (name === 'poll_provider_login') return auth.poll(scope, p.loginId)
        if (name === 'cancel_provider_login') return auth.cancel(scope, p.loginId)
        const result = await auth.logout()
        for (const panel of this.panels.values()) if (panel.source === p.source) this.resetSource(panel, panel.source)
        return result
      }
      case 'get_providers':
        await this.catalog.sources?.ready
        return { items: this.catalog.sources?.list() ?? [
          { id: 'hongguo', name: '红果', available: true, enabled: true, configurable: true },
        ] }
      case 'set_preferences': {
        if (!this.store.persistent) throw new PlayerError('本机设置目录不可写', 503)
        if (p.enabledProviders) this.catalog.sources?.validateEnabled(p.enabledProviders)
        const previous = this.store.preferences()
        const settings = this.store.setPreferences(p)
        if (p.enabledProviders) await this.syncProviders(scope)
        if (JSON.stringify(previous.searchTerms) !== JSON.stringify(settings.searchTerms)) {
          this.catalog.feed = null
          this.catalog.refresh = null
        }
        return this.preferences()
      }
      case 'get_health':
        if (!this.catalog.ffmpeg) void this.catalog.prepareMediaRuntime?.().catch(() => {})
        return {
          runtime: process.version,
          database: this.store.writable(),
          ffmpeg: this.catalog.ffmpeg,
        }
      case 'get_setup_status': {
        if (!this.catalog.ffmpeg) void this.catalog.prepareMediaRuntime?.().catch(() => {})
        return {
          runtime: process.version,
          database: this.store.writable(),
          ffmpeg: this.catalog.ffmpeg,
          dismissed: this.store.setupDismissed(),
          hooks: manualHooks(),
        }
      }
      case 'set_setup_dismissed':
        if (!this.store.persistent) throw new PlayerError('本机设置目录不可写', 503)
        return this.store.setSetupDismissed(p.dismissed)
      case 'create_browser_pairing': {
        if (browser) throw new PlayerError('请从会话面板打开分屏', 403)
        if (p.seriesId && p.episodeId && !matchesSeries(p.seriesId, p.episodeId)) throw new PlayerError('剧目与分集来源不匹配')
        const state = p.follow && this.store.state(scope.sessionId, p.turnId)
        if (p.follow && (!p.turnId || state.state !== 'submitted'))
          throw new PlayerError('当前回合无法绑定，请选择手动播放')
        return this.pair({
          sessionId: p.follow === false ? null : scope.sessionId,
          source: p.seriesId ? parseId(p.seriesId).source : scope.source,
          fixedTurn: p.follow ? p.turnId : null,
          selection: p.seriesId ? { seriesId: p.seriesId, episodeId: p.episodeId, title: p.title } : null,
        })
      }
    }
  }
}
