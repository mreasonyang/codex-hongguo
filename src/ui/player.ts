import { initLocale, tr } from './locale'
import { coverArt, fill, icon, setCover, setIcon } from './ui-kit'
import { panelStream } from './panel-stream'
import { mediaErrorMessage, waitForMetadata } from './media-startup'
import { finishedTurn, startedTurn } from './playback-turn'
import { browser, call, connect, hostLocale, type Context, type State, type Preferences, type SourceId } from './api'
import { pickLabel, showWaitingPicks, waitingCard, type WaitingSelection } from './waiting'

type Series = {
  id: string
  title: string
  description?: string
  episodes?: number
  cover?: string
  hasCover?: boolean
  lookupCover?: boolean
}
type Episode = { id: string; label: string; number: number; codec: string; playable: boolean }
type Page<T> = { items: T[]; cursor?: string }
type Progress = {
  seriesId: string
  episodeId: string
  title: string
  label: string
  positionMs: number
  durationMs: number
}
type Prepared =
  | { status: 'preparing' | 'error'; reason?: string }
  | ({ status: 'ready'; codec?: string; durationMs?: number } & ({ stream: string; manifest: string } | { src: string }))
const el = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T
const video = document.querySelector('video')!,
  seek = el<HTMLInputElement>('seek')
const play = el<HTMLButtonElement>('play'),
  center = el<HTMLButtonElement>('center'),
  autoNext = el<HTMLInputElement>('autonext')
const text = (id: string, s: string) => {
  el(id).textContent = id === 'title' ? s : tr(s)
}
const notice = (s: string) => text('notice', s)
const explain = (e: unknown) => (e instanceof Error ? e.message : '操作失败，请重试')
const clock = (s: number) => Math.floor(s / 60) + ':' + String(Math.floor(s % 60)).padStart(2, '0')
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
function button(label: string, fn: () => void | Promise<void>) {
  const b = document.createElement('button')
  b.textContent = tr(label)
  b.onclick = () => void Promise.resolve(fn()).catch((e) => notice(explain(e)))
  return b
}
let context: Context = { identified: false },
  current: State | null = null
let series: Series | null = null,
  episode: Episode | null = null,
  episodes: Episode[] = [],
  epCursor: string | undefined
let activeQuery = '',
  cursor: string | undefined,
  cards: Series[] = [],
  loaded = false
let activeSource: SourceId = 'hongguo', sourceGeneration = 0, switchingSource = false
let sourceUpdate = Promise.resolve()
const sourceOf = (id: string): SourceId => id.startsWith('p.') ? id.split('.')[1] : 'hongguo'
type Provider = { id: string; name: string; available: boolean; enabled?: boolean; configurable?: boolean; code?: string }
let providers: Provider[] = [{ id: 'hongguo', name: '红果', available: true }]
let providerOptions: Provider[] = []
const providerInputs = new Map<string, HTMLInputElement>()
let sourceMenuTimer: ReturnType<typeof setTimeout> | undefined
async function refreshProviders() {
  providerOptions = (await call<{ items: Provider[] }>('get_providers')).items
  providers = providerOptions.filter(provider => provider.available)
  closeSourceMenu()
  syncSourceButton()
  if (!providers.some(provider => provider.id === activeSource) && providers.length) await changeSource(providers[0].id)
}
function renderProviderSettings() {
  providerInputs.clear()
  el('providerSettings').replaceChildren(...providerOptions.filter(provider => provider.configurable).map(provider => {
    const row = document.createElement('label'), label = document.createElement('span'), input = document.createElement('input')
    row.className = 'switchRow'; label.textContent = tr(provider.name)
    if (provider.id === 'hongguo' || (provider.enabled && !provider.available)) {
      const hint = document.createElement('small')
      hint.textContent = tr(provider.id === 'hongguo' ? '始终启用' : '启动失败'); label.append(hint)
    }
    input.type = 'checkbox'; input.className = 'switch'; input.checked = !!provider.enabled
    input.disabled = provider.id === 'hongguo'
    providerInputs.set(provider.id, input)
    row.append(label, input); return row
  }))
}
function closeSourceMenu(focus = false) {
  clearTimeout(sourceMenuTimer)
  el('sourceMenu').hidden = true
  el('source').setAttribute('aria-expanded', 'false')
  if (focus) el('source').focus()
}
function syncSourceButton() {
  const control = el<HTMLButtonElement>('source')
  control.dataset.source = activeSource
  control.dataset.busy = String(switchingSource)
  const name = providers.find(provider => provider.id === activeSource)?.name || activeSource
  el('sourceName').textContent = activeSource === 'hongguo' ? tr('红果短剧') : name
  const label = tr('切换视频源')
  control.setAttribute('aria-label', providers.length < 2 ? tr(name) : label)
  control.disabled = switchingSource || providers.length < 2
  if (providers.length > 1) {
    control.setAttribute('aria-haspopup', 'menu')
    control.setAttribute('aria-controls', 'sourceMenu')
    control.setAttribute('aria-expanded', String(!el('sourceMenu').hidden))
  } else {
    control.removeAttribute('aria-haspopup')
    control.removeAttribute('aria-controls')
    control.removeAttribute('aria-expanded')
  }
}
function showSourceMenu(focus = false) {
  if (el<HTMLButtonElement>('source').disabled) return
  clearTimeout(sourceMenuTimer)
  const menu = el('sourceMenu')
  if (menu.hidden) {
    const items = providers.map(provider => {
      const b = button('', async () => { closeSourceMenu(true); await changeSource(provider.id) })
      b.setAttribute('role', 'menuitemradio')
      b.setAttribute('aria-checked', String(provider.id === activeSource))
      const dot = document.createElement('span'), name = document.createElement('span')
      dot.className = 'sourceDot'; dot.dataset.source = provider.id; dot.setAttribute('aria-hidden', 'true')
      name.className = 'sourceLabel'; name.textContent = tr(provider.name)
      b.append(dot, name)
      if (provider.id === activeSource) b.append(icon('check'))
      return b
    })
    menu.replaceChildren(...items)
    menu.hidden = false
    el('source').setAttribute('aria-expanded', 'true')
  }
  if (focus) menu.querySelector<HTMLButtonElement>('button[aria-checked="true"]')?.focus()
}
let action = 0,
  selection = 0,
  listing = 0,
  preparing = false,
  pageActive = false
let polling: Promise<void> | undefined
let lastSave = 0,
  saved = Promise.resolve()

let prefs: Preferences = {
  autoPrompt: true, autoplayNext: true, autoPauseOnFinish: true, autoPlayOnStart: true,
  defaultMuted: true, volume: 0.7,
  searchTerms: ['总裁', '重生', '逆袭'], defaultSource: 'hongguo', enabledProviders: ['hongguo'],
}
let playback: 'idle' | 'playing' | 'finished' = 'idle'
type InterruptedPlayback = { action: number; lastPosition?: number }
let backgroundPlayback: InterruptedPlayback | undefined
let closeStream: (() => void) | undefined
let mediaLoad: AbortController | undefined
let mediaDuration = 0, pendingSeek: number | undefined
let nextPreload: { selection: number; episodeId: string } | undefined
let episodePage: { selection: number; cursor: string; promise: Promise<boolean> } | undefined
let group = 0,
  batch = 0,
  watched: Progress[] = [],
  dismissedTurn: string | null = null
const isWaiting = document.documentElement.dataset.surface === 'waiting'
const instance = Array.from(crypto.getRandomValues(new Uint32Array(4)), n => n.toString(16).padStart(8, '0')).join('')
let playerReady = false, timer: number | undefined
let promptTurn: string | null = null, promptRender: AbortController | undefined
let waitingPlaybackId: number | undefined
let pendingRecommendationTurn: string | undefined
let openingPreferencesLoaded = false, openingPreferencesLoading: Promise<void> | undefined
let preferencesGeneration = 0, lastVolume = 0.7, lastDefaultMuted = true, pendingVolume: number | undefined
let volumeTimer: ReturnType<typeof setTimeout> | undefined, volumeSaved = Promise.resolve()
function flushVolume() {
  clearTimeout(volumeTimer)
  volumeTimer = undefined
  const volume = pendingVolume
  pendingVolume = undefined
  if (volume !== undefined) volumeSaved = volumeSaved
    .then(() => call('set_preferences', { volume }, 1800))
    .then(() => {})
    .catch(() => notice('音量暂未保存，请检查本机服务'))
  return volumeSaved
}
function openingPreferences() {
  if (openingPreferencesLoaded) return Promise.resolve()
  if (openingPreferencesLoading) return openingPreferencesLoading
  const generation = preferencesGeneration
  const work = flushVolume().then(() => call<Preferences>('get_preferences')).then(settings => {
    if (generation !== preferencesGeneration || !playerReady) return
    prefs = settings
    lastVolume = Number.isFinite(prefs.volume) && prefs.volume > 0 && prefs.volume <= 1 ? prefs.volume : 0.7
    video.volume = lastVolume
    video.muted = lastDefaultMuted = prefs.defaultMuted ?? true
    autoNext.checked = prefs.autoplayNext ?? true
    openingPreferencesLoaded = true
    el<HTMLButtonElement>('mute').disabled = false
    renderPicks()
  }).finally(() => { if (openingPreferencesLoading === work) openingPreferencesLoading = undefined })
  openingPreferencesLoading = work
  return work
}
function syncDefaultMute(settings: Preferences) {
  const muted = settings.defaultMuted ?? true
  if (!openingPreferencesLoaded || muted === lastDefaultMuted) return
  lastDefaultMuted = muted
  if (!muted && video.volume === 0) video.volume = lastVolume
  video.muted = muted
}
function confirmWaitingPlayback() {
  pendingRecommendationTurn = undefined
  const playbackId = waitingPlaybackId
  waitingPlaybackId = undefined
  if (playbackId) void call('confirm_waiting_playback', { playbackId }, 1800).catch(() => {})
}
function syncButtons() {
  play.disabled = center.disabled = !episode?.playable
  el<HTMLButtonElement>('pair').disabled = !episode
  const label = tr(preparing ? '取消准备' : video.paused ? '播放' : '暂停')
  const glyph = preparing ? 'x' : video.paused ? 'play' : 'pause'
  setIcon(play, glyph, label)
  setIcon(center, glyph, label)
  el('stage').classList.toggle('playing', !video.paused)
  el('stage').classList.toggle('busy', preparing)
  el<HTMLButtonElement>('prev').disabled =
    !episode || !episodes.slice(0, episodes.indexOf(episode)).some((e) => e.playable)
  el<HTMLButtonElement>('next').disabled =
    !episode || (!epCursor && !episodes.slice(episodes.indexOf(episode) + 1).some((e) => e.playable))
  center.hidden = preparing
  document
    .querySelectorAll<HTMLButtonElement>('#episodes button')
    .forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.id === episode?.id)))
}
function save(reset = false) {
  const duration = totalDuration()
  if (!loaded || !series || !episode || !Number.isFinite(duration) || !duration || (!video.currentTime && !reset)) return saved
  const p: Progress = {
    seriesId: series.id,
    episodeId: episode.id,
    title: series.title,
    label: episode.label,
    positionMs: Math.round((playback === 'finished' ? duration : video.currentTime) * 1000),
    durationMs: Math.round(duration * 1000),
  }
  saved = saved
    .then(() => call('save_progress', { ...p, ...(reset && p.positionMs === 0 ? { reset: true } : {}) }, 1800))
    .then(() => {})
    .catch(() => notice('观看进度暂未写入，请检查本机服务'))
  return saved
}
function pause(reason = '', preserveRecommendation = false) {
  if (!preserveRecommendation) pendingRecommendationTurn = undefined
  if (reason === '已手动暂停') confirmWaitingPlayback()
  action++
  cancelNextPreload()
  backgroundPlayback = undefined
  preparing = false
  if (playback !== 'finished') playback = 'idle'
  video.pause()
  syncButtons()
  const stopped = !!series && /本轮已停止|本轮已中断/.test(reason)
  if (reason) notice(stopped ? '' : reason)
  el('stopped').hidden = !stopped
  if (stopped) text('whyStopped', reason)
  return save()
}
function release() {
  cancelNextPreload()
  mediaDuration = 0
  pendingSeek = undefined
  loaded = false
  playback = 'idle'
  mediaLoad?.abort()
  mediaLoad = undefined
  el('stopped').hidden = true
  el('resumed').hidden = true
  closeStream?.()
  closeStream = undefined
  video.removeAttribute('src')
  video.load()
}
function pick(ep: Episode) {
  void pause('', true)
  release()
  el('link').hidden = true
  el<HTMLInputElement>('linkValue').value = ''
  episode = ep
  group = Math.floor(Math.max(0, episodes.indexOf(ep)) / 50)
  notice('')
  const number = '第 ' + ep.number + ' 集'
  const named = ep.label.replace(/\s/g, '') !== '第' + ep.number + '集'
  text('subtitle', [number, named ? ep.label : '', ep.codec].filter(Boolean).join(' · '))
  text('time', '0:00')
  seek.value = '0'
  fill(seek)
  syncButtons()
  if (!ep.playable) notice('该集当前不可播放，请检查片源许可或 FFmpeg 自检结果')
}
function drawEpisodes() {
  const pages = Math.ceil(episodes.length / 50)
  el('groups').replaceChildren(
    ...Array.from({ length: pages > 1 ? pages : 0 }, (_, i) => {
      const b = button(
        episodes[i * 50].number + '–' + episodes[Math.min(episodes.length, (i + 1) * 50) - 1].number,
        () => {
          group = i
          drawEpisodes()
        },
      )
      b.setAttribute('aria-pressed', String(i === group))
      return b
    }),
  )
  el('episodes').replaceChildren(
    ...episodes.slice(group * 50, (group + 1) * 50).map((ep) => {
      const b = button(String(ep.number), () => playEpisode(ep))
      b.disabled = !ep.playable
      b.title = ep.label
      b.dataset.id = ep.id
      return b
    }),
  )
  el('moreEpisodes').hidden = !epCursor
  el('episodeCount').textContent = episodes.length ? tr(episodes.length + (epCursor ? '+' : '') + ' 集') : ''
  syncButtons()
}
async function select(s: Series, requested?: string, playNow = false, waitingTurn?: string) {
  const nextSource = sourceOf(s.id), changingSource = nextSource !== activeSource
  if (changingSource) {
    activeSource = nextSource
    ++sourceGeneration; ++listing
    cards = []; watched = []; cursor = undefined; activeQuery = ''
    closeSourceMenu(); syncSourceButton()
  }
  const exactEpisode = waitingTurn && requested
  el('home').hidden = true
  el('watch').hidden = false
  el('back').focus({ preventScroll: true })
  window.scrollTo(0, 0)
  group = 0

  const ticket = ++selection
  void pause()
  pendingRecommendationTurn = playNow ? waitingTurn : undefined
  const interaction = action
  release()
  episode = null
  episodes = []
  epCursor = undefined
  series = s
  renderPicks()
  video.poster = s.cover || ''
  text('title', s.title)
  text('subtitle', '正在读取分集…')
  drawEpisodes()
  syncCards()
  await saved
  if (ticket !== selection) return
  if (changingSource) {
    sourceUpdate = sourceUpdate.catch(() => {}).then(() => call('set_source', { source: nextSource, remember: false })).then(() => {})
  }
  await sourceUpdate
  if (ticket !== selection) return
  const [first, recent] = await Promise.all([
    call<Page<Episode>>('get_episodes', { seriesId: s.id }),
    call<Page<Progress>>('get_history', { seriesId: s.id }),
  ])
  requested ??= recent.items[0]?.episodeId
  let page = first
  if (ticket !== selection) return
  episodes = page.items || []
  epCursor = page.cursor
  // A saved episode can be on a later page.
  const seen = new Set<string>()
  while (requested && !episodes.some((e) => e.id === requested) && epCursor && !seen.has(epCursor)) {
    seen.add(epCursor)
    page = await call<Page<Episode>>('get_episodes', { seriesId: s.id, cursor: epCursor })
    if (ticket !== selection) return
    episodes.push(...page.items)
    epCursor = page.cursor
  }
  const ep = (requested && episodes.find((e) => e.id === requested && (!playNow || e.playable))) ||
    (!exactEpisode && ((playNow && episodes.find(e => e.playable)) || episodes[0]))
  const playRequested = playNow && pageActive && (action === interaction ||
    (!!waitingTurn && pendingRecommendationTurn === waitingTurn))
  if (ep) pick(ep)
  else text('subtitle', '暂无可用分集')
  drawEpisodes()
  if (playRequested && ep && ticket === selection) await start(waitingTurn)
}
async function playEpisode(ep: Episode) {
  pick(ep)
  drawEpisodes()
  await start()
}
async function moreEpisodes(quiet = false): Promise<boolean> {
  if (!series || !epCursor) return false
  const t = selection,
    old = epCursor
  try {
    if (episodePage?.selection !== t || episodePage.cursor !== old) {
      const seriesId = series.id
      const pending = {
        selection: t, cursor: old,
        promise: (async () => {
          const page = await call<Page<Episode>>('get_episodes', { seriesId, cursor: old })
          if (t !== selection || old !== epCursor) return false
          const known = new Set(episodes.map(ep => ep.id))
          for (const ep of page.items) if (!known.has(ep.id)) { episodes.push(ep); known.add(ep.id) }
          epCursor = page.cursor === old ? undefined : page.cursor
          drawEpisodes()
          return true
        })(),
      }
      episodePage = pending
      void pending.promise.finally(() => { if (episodePage === pending) episodePage = undefined }).catch(() => {})
    }
    return await episodePage.promise
  } catch (e) {
    if (!quiet && t === selection) notice(explain(e))
    return false
  }
}
el('moreEpisodes').onclick = () => { void moreEpisodes() }
async function followingEpisode(valid: () => boolean, quiet = false) {
  if (!episode) return
  const following = () => episodes.slice(episodes.indexOf(episode!) + 1).find(e => e.playable)
  let next = following()
  const tried = new Set<string>()
  while (!next && epCursor && !tried.has(epCursor) && valid()) {
    tried.add(epCursor)
    if (!await moreEpisodes(quiet) || !valid()) return
    next = following()
  }
  return valid() ? next : undefined
}
function cancelNextPreload() {
  nextPreload = undefined
}
function preloadNextEpisode() {
  const duration = totalDuration(), remaining = duration - video.currentTime
  if (!loaded || !episode || !pageActive || video.paused || !autoNext.checked ||
      !Number.isFinite(duration) || !Number.isFinite(remaining) || duration <= 0 || remaining <= 0 ||
      remaining > Math.min(30 * (video.playbackRate || 1), duration / 4)) return
  if (nextPreload?.selection === selection && nextPreload.episodeId === episode.id) return
  const work = nextPreload = { selection, episodeId: episode.id }
  const valid = () => nextPreload === work && pageActive && autoNext.checked &&
    selection === work.selection && episode?.id === work.episodeId
  void (async () => {
    const next = await followingEpisode(valid, true)
    if (!next || !valid()) return
    const until = Date.now() + 240000
    while (valid() && Date.now() < until) {
      const result = await call<{ status: 'preparing' | 'ready' | 'error' }>(
        'preload_playback', { episodeId: next.id },
      )
      if (result.status !== 'preparing' || !valid()) return
      await sleep(700)
    }
  })().catch(() => { /* Speculation must never interrupt or replace the playing episode. */ })
}
async function nextEpisode(auto = false) {
  if (!episode) return
  const id = episode.id,
    show = selection,
    ticket = action
  const valid = () => selection === show && episode?.id === id && action === ticket &&
    pageActive && (!auto || autoNext.checked)
  const next = await followingEpisode(valid)
  if (!valid()) return
  if (next) await playEpisode(next)
  else if (auto) void pause('本集已播完')
}
el('prev').onclick = () => {
  const prev = episodes
    .slice(0, episodes.indexOf(episode!))
    .reverse()
    .find((e) => e.playable)
  if (prev) void playEpisode(prev)
}
el('next').onclick = () => void nextEpisode()
el('random').onclick = () => {
  const list = episodes.filter((e) => e.playable)
  const last = watched.find((p) => p.seriesId === series?.id)
  const at = last ? list.findIndex((e) => e.id === last.episodeId) : -1
  const pool = at < 0 ? list.slice(0, 1) : list.slice(Math.min(at + 1, list.length - 1))
  if (pool.length) void playEpisode(pool[Math.floor(Math.random() * pool.length)])
}
async function home() {
  confirmWaitingPlayback()
  if (document.fullscreenElement) await document.exitFullscreen()
  el('stage').classList.remove('expanded')
  syncFullscreen()
  notice('')
  ++selection
  const pending = pause()
  release()
  episode = null
  series = null
  episodes = []
  epCursor = undefined
  el('home').hidden = false
  el('watch').hidden = true
  el('link').hidden = true
  if (!cards.length) void list()
  else drawCards()
  await pending
  await history()
  if (!series && cards.length) drawCards()
}
el('back').onclick = () => void home().catch((e) => notice(explain(e)))
function syncCards() {
  document
    .querySelectorAll<HTMLButtonElement>('.card')
    .forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.id === series?.id)))
}
function drawCards() {
  const covers: Array<{ span: HTMLElement; s: Series }> = []
  const seen = new Set(watched.map((p) => p.seriesId))
  const featured = !activeQuery ? cards.find((s) => !seen.has(s.id)) || cards[0] : undefined
  const pool = cards.filter((s) => s !== featured)
  const resumeArt = drawContinue()
  if (resumeArt) covers.push(resumeArt)
  el('featured').replaceChildren()
  if (featured) {
    const b = button('', () => select(featured, undefined, true)),
      art = coverArt(featured.title, featured.episodes ? tr(featured.episodes + ' 集') : ''),
      body = document.createElement('span'),
      eyebrow = document.createElement('small'),
      title = document.createElement('strong'),
      cta = document.createElement('span')
    b.className = 'feature'
    b.dataset.id = featured.id
    b.setAttribute('aria-label', tr('播放') + ' · ' + featured.title)
    body.className = 'featureText'
    eyebrow.className = 'eyebrow'
    eyebrow.textContent = tr(seen.has(featured.id) ? '看过' : '推荐')
    title.textContent = featured.title
    body.append(eyebrow, title)
    if (featured.description) {
      const desc = document.createElement('span')
      desc.className = 'desc'
      desc.textContent = featured.description
      body.append(desc)
    }
    cta.className = 'playPill'
    cta.append(icon('play'), tr('播放'))
    body.append(cta)
    b.append(art, body)
    el('featured').append(b)
    covers.push({ span: art, s: featured })
  }
  renderPicks()
  el('cards').replaceChildren(
    ...pool.slice(batch * 12, (batch + 1) * 12).map((s) => {
      const b = button('', () => select(s, undefined, true))
      b.className = 'card'
      b.dataset.id = s.id
      b.title = s.title
      const img = coverArt(s.title, s.episodes ? tr(s.episodes + ' 集') : ''),
        title = document.createElement('span')
      title.className = 'cardTitle'
      title.textContent = s.title
      b.append(img, title)
      covers.push({ span: img, s })
      return b
    }),
  )
  syncCards()
  const version = listing
  void (async () => {
    for (const { span, s } of covers) {
      if (version !== listing) return
      if (!s.cover && (s.hasCover || s.lookupCover)) {
        try {
          s.cover = (await call<{ cover: string }>('get_cover', { seriesId: s.id }, 9000)).cover
        } catch {
          /* keep title artwork */
        }
      }
      if (s.cover) {
        setCover(span, s.cover)
        if (series?.id === s.id) video.poster = s.cover
      }
    }
  })()
}
function renderPicks() {
  const show =
    prefs.autoPrompt &&
    !!current?.turnId &&
    current.state === 'submitted' &&
    !series &&
    !activeQuery &&
    cards.length > 0 &&
    dismissedTurn !== current.turnId
  const turnId = show ? current!.turnId : null
  if (turnId === promptTurn) return
  promptTurn = turnId
  promptRender?.abort()
  const card = el('prompt'), titles = el('picks')
  if (!turnId) { card.hidden = true; return }
  const work = promptRender = new AbortController()
  void showWaitingPicks(card, titles, work.signal, turnId, items => {
    titles.replaceChildren(...items.map(pick => button(pickLabel(pick), () => {
      void call('mark_waiting_picks_shown', { turnId }).catch(() => {})
      return select(cards.find(s => s.id === pick.id) ?? pick, pick.episodeId, true, turnId)
    })), button('更多…', () => {
      dismissPicks()
      el('query').focus()
    }))
  }).catch(() => { if (!work.signal.aborted) card.hidden = true })
}
function dismissPicks() {
  dismissedTurn = current?.turnId || null
  if (dismissedTurn) void call('dismiss_waiting_picks', { turnId: dismissedTurn }).catch(() => {})
  renderPicks()
}
el('dismiss').onclick = dismissPicks
/** Catalog status: skeletons while the first batch loads, actionable empty and error states. */
function catalogState(kind: '' | 'loading' | 'empty' | 'error', message = '') {
  const status = el('catalogStatus'),
    grid = el('cards'),
    query = el<HTMLInputElement>('query')
  status.dataset.state = kind === 'loading' && cards.length ? 'busy' : kind
  status.replaceChildren()
  if (message) {
    const line = document.createElement('span')
    line.textContent = tr(message)
    status.append(line)
  }
  if (status.dataset.state === 'busy') status.prepend(icon('spin'))
  if (kind === 'error') status.append(button('重试', () => list()))
  if (kind === 'empty' && activeQuery)
    status.append(
      button('清除搜索', () => {
        query.value = ''
        return list(false, '')
      }),
    )
  status.querySelectorAll('button').forEach((b) => (b.className = 'btn'))
  if (kind === 'loading' && !cards.length)
    grid.replaceChildren(
      ...Array.from({ length: 6 }, () => {
        const card = document.createElement('div'),
          art = document.createElement('span'),
          line = document.createElement('span')
        card.className = 'skel'
        card.setAttribute('aria-hidden', 'true')
        art.className = 'skelArt'
        line.className = 'skelLine'
        card.append(art, line)
        return card
      }),
    )
  else if (grid.querySelector('.skel')) grid.replaceChildren()
}
async function list(more = false, query = activeQuery) {
  const t = ++listing
  if (!more) {
    activeQuery = query
    cards = []
    cursor = undefined
    batch = 0
    drawCards()
  }
  const desired = more ? batch + 1 : 0
  el('more').hidden = true
  catalogState('loading', '正在读取片库…')
  const results = more ? [...cards] : []
  let liveResults = false
  if (!more && !query) {
    // Paint cached titles (or the first discovery page) while the full catalog loads.
    void call<Page<Series>>('list_series', { source: activeSource, preview: true }, 90000).then(page => {
      if (t !== listing || liveResults || !page.items.length) return
      cards = page.items
      drawCards()
      if (el('catalogStatus').dataset.state !== 'error') catalogState('')
      el('more').hidden = cards.length <= 13
    }).catch(() => {})
  }
  try {
    const visited = new Set<string>()
    const needed = (desired + 1) * 12 + (query ? 0 : 1)
    let fetchFirst = !more
    while (fetchFirst || (results.length < needed && cursor && !visited.has(cursor))) {
      fetchFirst = false
      if (cursor) visited.add(cursor)
      const page = await call<Page<Series>>('list_series', { source: activeSource, query, cursor }, 90000)
      if (t !== listing) return
      const known = new Set(results.map((s) => s.id))
      for (const item of page.items)
        if (!known.has(item.id)) {
          known.add(item.id)
          results.push(item)
        }
      cursor = page.cursor
      if (cursor && visited.has(cursor)) cursor = undefined
    }
    liveResults = results.length > 0
    if (liveResults) cards = results
    const pages = Math.max(1, Math.ceil((cards.length - (query ? 0 : 1)) / 12))
    if (more && desired >= pages && !cursor && !query) {
      await list()
      return
    }
    batch = desired % pages
    drawCards()
    if (cards.length) catalogState('')
    else if (query) catalogState('empty', '没有找到相符的剧目')
    else catalogState('error', '片源暂时没有返回推荐剧目')
    el('more').hidden = pages <= 1 && !cursor
  } catch (e) {
    if (t === listing) {
      catalogState('error', explain(e))
      el('more').hidden = !more
    }
  }
}
async function history() {
  const source = activeSource, generation = sourceGeneration
  const page = await call<Page<Progress>>('get_history', { source })
  if (source !== activeSource || generation !== sourceGeneration) return
  watched = page.items
  drawContinue()
  el('history').replaceChildren(
    ...watched.map((p) => {
      const row = document.createElement('div'),
        name = document.createElement('strong'),
        meta = document.createElement('small')
      row.className = 'historyRow'
      const resume = button('', () => resumeItem(p))
      resume.className = 'historyItem'
      name.textContent = p.title
      meta.textContent = p.label + ' · ' + clock(p.positionMs / 1000)
      resume.append(name, meta)
      const remove = button('', async () => {
        await saved
        await call('remove_history', { seriesId: p.seriesId })
        await history()
        drawCards()
      })
      const removeLabel = tr('移除 ' + p.title + ' 的观看历史')
      remove.className = 'icon sm'
      remove.setAttribute('aria-label', removeLabel)
      remove.title = removeLabel
      remove.append(icon('x'))
      row.append(resume, remove)
      return row
    }),
  )
  el('historyCount').textContent = watched.length ? String(watched.length) : ''
  el('resume').hidden = !watched.length
}
function resumeItem(p: Progress) {
  return select(cards.find((s) => s.id === p.seriesId) || { id: p.seriesId, title: p.title }, p.episodeId, true)
}
/** The most recent show, weighted above the catalog. Returns its artwork so drawCards can load the cover. */
function drawContinue(): { span: HTMLElement; s: Series } | undefined {
  const last = watched[0]
  if (!last) {
    el('continue').replaceChildren()
    return
  }
  const s = cards.find((c) => c.id === last.seriesId) || { id: last.seriesId, title: last.title }
  const b = button('', () => resumeItem(last)),
    art = coverArt(last.title),
    body = document.createElement('span'),
    eyebrow = document.createElement('small'),
    title = document.createElement('strong'),
    meta = document.createElement('span'),
    bar = document.createElement('span'),
    fillBar = document.createElement('i'),
    go = document.createElement('span')
  const ratio = last.durationMs ? Math.min(1, last.positionMs / last.durationMs) : 0
  b.className = 'resumeCard'
  b.setAttribute('aria-label', tr('继续观看 · ' + last.title + ' · ' + last.label))
  body.className = 'resumeText'
  eyebrow.className = 'eyebrow'
  eyebrow.textContent = tr('继续观看')
  title.textContent = last.title
  meta.className = 'meta'
  meta.textContent =
    last.label + ' · ' + clock(last.positionMs / 1000) + (last.durationMs ? ' / ' + clock(last.durationMs / 1000) : '')
  bar.className = 'bar'
  fillBar.style.setProperty('--p', (ratio * 100).toFixed(1) + '%')
  bar.append(fillBar)
  body.append(eyebrow, title, meta, bar)
  go.className = 'resumePlay'
  go.append(icon('play'))
  b.append(art, body, go)
  el('continue').replaceChildren(b)
  return { span: art, s }
}
function displayState() {
  const running = current?.state === 'submitted'
  el('lamp').classList.toggle('on', running)
  text(
    'state',
    !context.identified && browser
      ? '未关联对话'
      : !current || current.state === 'unknown'
        ? '等待回合开始'
        : running
          ? '当前回合进行中'
          : current.state === 'interrupted'
            ? '回合已中断'
            : '回合已停止',
  )
}
function poll() {
  if (!pageActive) return Promise.resolve()
  polling ??= readTurnState().finally(() => { polling = undefined })
  return polling
}
async function readTurnState() {
  try {
    const state = await call<State>('get_run_state', {
      observeSession: true, playerInstance: document.hidden ? undefined : instance,
    }, 1800)
    if (!pageActive) return
    if (state.preferences) {
      const promptChanged = prefs.autoPrompt !== state.preferences.autoPrompt
      const providersChanged = JSON.stringify(prefs.enabledProviders) !== JSON.stringify(state.preferences.enabledProviders)
      syncDefaultMute(state.preferences)
      prefs = state.preferences
      autoNext.checked = prefs.autoplayNext
      if (!autoNext.checked) cancelNextPreload()
      if (promptChanged) renderPicks()
      if (providersChanged) await refreshProviders()
    }
    const reason = finishedTurn(current, state)
    const starting = startedTurn(current, state)
    const changed = current?.state !== state.state || current?.turnId !== state.turnId
    current = state
    if (changed) renderPicks()
    displayState()
    if (reason && series && prefs.autoPauseOnFinish) void pause(reason)
    else if (starting && prefs.autoPlayOnStart && series && episode?.playable &&
        video.paused && !preparing) void start(state.turnId!, true)
  } catch {
    if (!pageActive) return
    el('lamp').classList.remove('on')
    text('state', '本机状态不可达')
  }
}
function updateTime() {
  const dur = totalDuration()
  if (!Number.isFinite(dur) || !loaded) return
  seek.value = String(Math.round((video.currentTime / dur) * 1000))
  fill(seek)
  text('time', clock(video.currentTime) + ' / ' + clock(dur))
}
function totalDuration() { return mediaDuration || video.duration }
function seekTo(position: number) {
  pendingSeek = position
  applySeek()
}
function applySeek() {
  if (pendingSeek !== undefined && Number.isFinite(video.duration) && pendingSeek <= video.duration) {
    video.currentTime = pendingSeek
    pendingSeek = undefined
  }
}
function playlistDuration(manifest: string) {
  return Array.from(manifest.matchAll(/#EXTINF:([\d.]+)/g), match => Number(match[1])).reduce((a, b) => a + b, 0)
}
async function start(recommendationTurn?: string, automatic = false) {
  if (!episode?.playable || !series || !pageActive) return
  pendingRecommendationTurn = automatic ? undefined : recommendationTurn
  const n = ++action,
    ep = episode,
    show = series
  preparing = true
  syncButtons()
  el('stopped').hidden = true
  try {
    const sound = openingPreferences()
    void sound.catch(() => {})
    if (!loaded) {
      notice('正在准备播放…')
      // Progress lookup can run while the server downloads and prepares the first fragment.
      const recent = saved.then(() => call<Page<Progress>>('get_history', { seriesId: show.id, episodeId: ep.id }))
      void recent.catch(() => {})
      let result = await call<Prepared>('prepare_playback', { episodeId: ep.id, retry: true })
      const until = Date.now() + 240000
      while (result.status === 'preparing' && n === action && Date.now() < until) {
        notice('正在准备首批视频分段…')
        await sleep(200)
        if (n !== action) return
        result = await call<Prepared>('prepare_playback', { episodeId: ep.id })
      }
      if (n !== action) return
      if (result.status !== 'ready') throw Error(result.reason || '准备超时，请重试')
      const r = await recent
      if (n !== action) return
      const progress = r.items[0]
      const pos = progress && progress.positionMs < progress.durationMs ? progress.positionMs / 1000 : 0
      // A resumed position must exist in the growing playlist before HLS attaches.
      while ('stream' in result && result.durationMs && pos > 0 && !result.manifest.includes('#EXT-X-ENDLIST') &&
          playlistDuration(result.manifest) < pos + 3 && Date.now() < until) {
        await sleep(200)
        if (n !== action) return
        result = await call<Prepared>('prepare_playback', { episodeId: ep.id })
        if (n !== action) return
        if (result.status !== 'ready') throw Error('分集续播位置尚未准备好，请重试')
      }
      if ('stream' in result && result.durationMs && pos > 0 && !result.manifest.includes('#EXT-X-ENDLIST') &&
          playlistDuration(result.manifest) < pos + 3) throw Error('分集续播位置准备超时，请重试')
      const media = result
      if (browser !== ('src' in media)) throw Error('本集播放地址已失效，请重试')
      release()
      mediaDuration = Number.isFinite(media.durationMs) && media.durationMs! > 0 ? media.durationMs! / 1000 : 0
      const load = new AbortController()
      mediaLoad = load
      const metadata = waitForMetadata(video, load.signal)
      const streamError = (reason: string) => {
        if (mediaLoad !== load) return
        load.abort(Error(reason))
        if (loaded) {
          void pause(reason)
          release()
        }
      }
      try {
        if ('stream' in media) {
          closeStream = panelStream(video, ep.id, media.stream, media.manifest, streamError, () => {
            if (mediaLoad === load) finishEpisode()
          })
        } else {
          video.src = media.src
          video.load()
        }
      } catch (e) {
        streamError(explain(e))
      }
      await metadata
      if (n !== action) return
      seekTo(pos > 0 && pos < totalDuration() - 5 ? pos : 0)
      if (video.currentTime > 0) {
        text('resumeTime', '已从 ' + clock(pos) + ' 继续')
        el('resumed').hidden = false
      }
      loaded = true
    }
    await sound
    if (n !== action || !pageActive) return
    // Delayed recommendations and turn-start autoplay must still belong to a
    // running turn. Ordinary Play on loaded media needs no host request.
    if (recommendationTurn) {
      const state = await call<State>('get_run_state', { observeSession: true }, 1800)
      if (n !== action) return
      if (state.turnId !== recommendationTurn || state.state !== 'submitted' ||
          (automatic && !state.preferences?.autoPlayOnStart)) {
        void pause(automatic ? '' : '推荐所属任务已结束，点击播放继续观看')
        return
      }
    }
    if (n !== action || !pageActive) return
    preparing = false
    if (playback === 'finished') seekTo(0)
    playback = 'playing'
    video.playbackRate = parseFloat(el<HTMLSelectElement>('speed').value)
    try {
      await video.play()
    } catch (error) {
      if (n !== action || !pageActive) return
      if (!(error instanceof DOMException && ['AbortError', 'NotAllowedError'].includes(error.name)) ||
          (!document.hidden && document.hasFocus() && backgroundPlayback?.action !== n)) {
        if (error instanceof DOMException && error.name === 'NotAllowedError' && recommendationTurn && !automatic)
          throw Error('宿主阻止了自动播放，请点击播放继续')
        throw error
      }
      rememberBackgroundPlayback()
      return
    }
    if (n === action) {
      confirmWaitingPlayback()
      notice('正在播放')
      lastSave = Date.now()
      syncButtons()
    }
  } catch (e) {
    if (n === action) {
      if (!loaded) release()
      void pause(explain(e))
    }
  }
}
function togglePlayback() {
  if (!video.paused || preparing) void pause('已手动暂停')
  else void start()
}
for (const control of [video, center, play, el('resumePlayback')]) {
  control.addEventListener('click', togglePlayback)
}
function finishEpisode() {
  const duration = totalDuration()
  if (!loaded || playback !== 'playing' || !Number.isFinite(duration) ||
      video.currentTime < duration - 1) return
  playback = 'finished'
  void save()
  if (autoNext.checked && pageActive) {
    void nextEpisode(true).catch(e => notice(explain(e)))
  } else void pause('本集已播完')
  void saved.then(history).catch(() => {})
}
video.onended = finishEpisode
autoNext.onchange = () => {
  if (!autoNext.checked) cancelNextPreload()
  void call<Preferences>('set_preferences', { autoplayNext: autoNext.checked })
    .then(updated => { prefs = updated })
    .catch(e => notice(explain(e)))
}
video.ontimeupdate = () => {
  updateTime()
  preloadNextEpisode()
  if (!video.paused && Date.now() - lastSave >= 5000) {
    lastSave = Date.now()
    void save()
  }
}
video.onpause = () => {
  syncButtons()
  if (loaded) void save()
  if (document.hidden || !document.hasFocus() || backgroundPlayback?.action === action)
    rememberBackgroundPlayback()
}
video.onplay = syncButtons
video.onplaying = confirmWaitingPlayback
video.onerror = () => {
  if (loaded) {
    void pause(mediaErrorMessage(video.error?.code))
    release()
  }
}
seek.oninput = () => {
  fill(seek)
  if (loaded && Number.isFinite(totalDuration())) {
    if (playback === 'finished') playback = 'idle'
    seekTo((Number(seek.value) * totalDuration()) / 1000)
  }
}
seek.onchange = () => { if (pendingSeek === undefined) void save(video.currentTime === 0) }
video.onloadedmetadata = () => {
  if (video.videoWidth && video.videoHeight)
    el('stage').style.aspectRatio = video.videoWidth + '/' + video.videoHeight
}
video.ondurationchange = () => {
  const requested = pendingSeek
  applySeek()
  if (loaded && requested !== undefined && pendingSeek === undefined) void save(requested === 0)
  updateTime()
}
el('restart').onclick = () => {
  if (playback === 'finished') playback = 'idle'
  seekTo(0)
  el('resumed').hidden = true
  void save(true)
}
el('mute').onclick = () => {
  if (video.volume === 0) {
    video.volume = lastVolume
    video.muted = false
  } else video.muted = !video.muted
}
async function fullscreen() {
  const stage = el('stage')
  if (document.fullscreenElement) {
    await document.exitFullscreen()
    return
  }
  if (stage.classList.contains('expanded')) {
    stage.classList.remove('expanded')
    syncFullscreen()
    return
  }
  try {
    await stage.requestFullscreen()
  } catch {
    stage.classList.add('expanded')
    syncFullscreen()
  }
}
el('fullscreen').onclick = () => void fullscreen().catch((e) => notice(explain(e)))
document.addEventListener('fullscreenchange', syncFullscreen)
/** Keeps the fullscreen glyph and name in step with real and fallback (expanded) fullscreen. */
function syncFullscreen() {
  const stage = el('stage'),
    on = !!document.fullscreenElement || stage.classList.contains('expanded')
  stage.classList.toggle('isFull', on)
  setIcon(el('fullscreen'), on ? 'collapse' : 'expand', tr(on ? '退出全屏' : '全屏'))
}
// In-picture controls fade while playing and return on pointer movement or keyboard focus.
let idle: ReturnType<typeof setTimeout> | undefined
el('stage').addEventListener('pointermove', () => {
  const stage = el('stage')
  stage.classList.add('awake')
  clearTimeout(idle)
  idle = setTimeout(() => stage.classList.remove('awake'), 2400)
})
el('stage').addEventListener('pointerleave', () => el('stage').classList.remove('awake'))
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && el('stage').classList.contains('expanded')) void fullscreen()
})
video.onvolumechange = () => {
  const silent = video.muted || video.volume === 0
  setIcon(el('mute'), silent ? 'mute' : 'volume', tr(silent ? '取消静音' : '静音'))
  el('mute').setAttribute('aria-pressed', String(silent))
  if (openingPreferencesLoaded && Number.isFinite(video.volume) && video.volume > 0 && video.volume !== lastVolume) {
    lastVolume = video.volume
    prefs.volume = pendingVolume = lastVolume
    clearTimeout(volumeTimer)
    volumeTimer = setTimeout(() => { void flushVolume() }, 150)
  }
}
el<HTMLButtonElement>('mute').disabled = true
el<HTMLSelectElement>('speed').onchange = (e) =>
  (video.playbackRate = parseFloat((e.target as HTMLSelectElement).value))
const queryInput = el<HTMLInputElement>('query')
let searchTimer: ReturnType<typeof setTimeout> | undefined, composing = false
function searchNow() {
  clearTimeout(searchTimer)
  if (!composing) void list(false, queryInput.value.trim())
}
function scheduleSearch() {
  clearTimeout(searchTimer)
  ++listing // Drop replies for the previous text, including during the debounce.
  if (composing) return
  if (!queryInput.value.trim()) searchNow()
  else searchTimer = setTimeout(searchNow, 400)
}
queryInput.addEventListener('input', scheduleSearch)
queryInput.addEventListener('compositionstart', () => { composing = true; scheduleSearch() })
queryInput.addEventListener('compositionend', () => { composing = false; scheduleSearch() })
el('search').onsubmit = (e) => { e.preventDefault(); searchNow() }
el('more').onclick = () => void list(true)
async function changeSource(next: SourceId) {
  if (next === activeSource || !playerReady) return
  const generation = ++sourceGeneration
  ++listing; ++selection
  closeSourceMenu()
  switchingSource = true
  syncSourceButton()
  const pending = pause()
  release()
  series = null; episode = null; episodes = []; epCursor = undefined
  cards = []; watched = []; cursor = undefined; activeQuery = ''; batch = group = 0
  promptTurn = null; promptRender?.abort()
  el('prompt').hidden = true
  el('home').hidden = false; el('watch').hidden = true
  el('link').hidden = true; el<HTMLInputElement>('linkValue').value = ''
  el<HTMLInputElement>('query').value = ''
  drawCards()
  try {
    await pending
    sourceUpdate = sourceUpdate.catch(() => {}).then(() => call('set_source', { source: next })).then(() => {})
    await sourceUpdate
    if (generation !== sourceGeneration || !playerReady) return
    activeSource = next; context.source = next
    syncSourceButton()
    await Promise.all([list(false, ''), history()])
  } catch {
    if (generation === sourceGeneration) {
      notice('视频源暂未切换，请重试')
      catalogState('error', '视频源暂未切换，请重试')
    }
  }
  finally { switchingSource = false; syncSourceButton() }
}
el('source').onclick = e => {
  showSourceMenu(e?.detail === 0)
}
el('source').onpointerenter = e => { if (e.pointerType !== 'touch') showSourceMenu() }
el('source').onkeydown = e => {
  if (e.key === 'ArrowDown' || e.key === 'ArrowUp') { e.preventDefault(); showSourceMenu(true) }
}
el('sourceControl').onpointerenter = () => clearTimeout(sourceMenuTimer)
el('sourceControl').onpointerleave = e => {
  if (e?.pointerType === 'touch') return
  clearTimeout(sourceMenuTimer)
  sourceMenuTimer = setTimeout(() => {
    if (!el('sourceMenu').contains(document.activeElement)) closeSourceMenu()
  }, 160)
}
el('sourceControl').addEventListener('focusout', e => {
  if (!el('sourceControl').contains(e.relatedTarget as Node | null)) closeSourceMenu()
})
el('sourceMenu').onkeydown = e => {
  if (e.key === 'Escape') { e.preventDefault(); closeSourceMenu(true) }
  else if (e.key === 'Tab') closeSourceMenu()
  else if (['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(e.key)) {
    e.preventDefault()
    const items = [...el('sourceMenu').querySelectorAll<HTMLButtonElement>('button')]
    const at = items.indexOf(document.activeElement as HTMLButtonElement)
    const next = e.key === 'Home' ? 0 : e.key === 'End' ? items.length - 1 : (at + (e.key === 'ArrowUp' ? -1 : 1) + items.length) % items.length
    items[next]?.focus()
  }
}
document.addEventListener('pointerdown', e => {
  if (!el('sourceMenu').hidden && !el('sourceControl').contains(e.target as Node)) closeSourceMenu()
})
document.addEventListener('keydown', e => { if (e.key === 'Escape' && !el('sourceMenu').hidden) closeSourceMenu(true) })
async function openPairing() {
  const show = series
  const ep = episode
  if (!show || !ep) return
  try {
    await pause()
    const r = await call<{ url: string }>('create_browser_pairing', {
      seriesId: show.id,
      episodeId: ep.id,
      title: show.title,
    })
    if (series !== show || episode !== ep) return
    el<HTMLInputElement>('linkValue').value = r.url
    el('link').hidden = false
    el('link').scrollIntoView({ block: 'nearest' })
    setTimeout(() => {
      if (el<HTMLInputElement>('linkValue').value === r.url) {
        el('link').hidden = true
        el<HTMLInputElement>('linkValue').value = ''
      }
    }, 60000)
  } catch (e) {
    notice(explain(e))
  }
}
el('pair').onclick = openPairing
el('copy').onclick = async () => {
  const input = el<HTMLInputElement>('linkValue')
  try {
    await navigator.clipboard.writeText(input.value)
    notice('已复制，请在 Codex 内置浏览器打开')
  } catch {
    input.select()
    notice('链接已选中，请复制并在 Codex 内置浏览器打开')
  }
}
el('settingsCancel').onclick = () => el('prefs').click()
el('prefs').onclick = async () => {
  if (!playerReady) return
  try {
    await openingPreferences()
    await refreshProviders()
    if (!playerReady) return
    el('settings').hidden = !el('settings').hidden
    el('prefs').setAttribute('aria-expanded', String(!el('settings').hidden))
    el<HTMLInputElement>('autoPrompt').checked = prefs.autoPrompt
    el<HTMLInputElement>('autoPauseOnFinish').checked = prefs.autoPauseOnFinish
    el<HTMLInputElement>('autoPlayOnStart').checked = prefs.autoPlayOnStart
    el<HTMLInputElement>('defaultMuted').checked = prefs.defaultMuted
    el<HTMLInputElement>('terms').value = prefs.searchTerms.join('，')
    renderProviderSettings()
  } catch (error) { notice(explain(error)) }
}
el('settings').onsubmit = (e) => {
  e.preventDefault()
  const generation = preferencesGeneration
  const searchTerms = el<HTMLInputElement>('terms')
    .value.split(/[,，]/)
    .map((s) => s.trim())
    .filter(Boolean)
  const enabledProviders = providerInputs.size ? [...providerInputs].filter(([, input]) => input.checked).map(([id]) => id) : prefs.enabledProviders
  void (async () => {
    if (!enabledProviders.includes(activeSource)) await pause()
    return call<typeof prefs>('set_preferences', {
      autoPrompt: el<HTMLInputElement>('autoPrompt').checked,
      autoPauseOnFinish: el<HTMLInputElement>('autoPauseOnFinish').checked,
      autoPlayOnStart: el<HTMLInputElement>('autoPlayOnStart').checked,
      defaultMuted: el<HTMLInputElement>('defaultMuted').checked,
      searchTerms,
      enabledProviders,
    })
  })()
    .then(async (updated) => {
      if (generation !== preferencesGeneration || !playerReady) return
      syncDefaultMute(updated)
      prefs = updated
      await refreshProviders()
      autoNext.checked = prefs.autoplayNext
      el('settings').hidden = true
      el('prefs').setAttribute('aria-expanded', 'false')
      renderPicks()
      if (!series) await list()
    })
    .catch((err) => notice(explain(err)))
}
el('choose').onclick = async () => {
  try {
    const r = await call<{ items: { choice: string; suffix: string; at: number }[] }>('list_sessions')
    el('choices').replaceChildren(
      ...r.items.map((c) =>
        button('…' + c.suffix + ' · ' + new Date(c.at).toLocaleString(), async () => {
          await call('select_session', { choice: c.choice })
          context.identified = true
          void presence(pageActive && !document.hidden)
          el('choose').hidden = true
          el('choices').replaceChildren()
          await poll()
        }),
      ),
    )
    if (!r.items.length) notice('还没有本机回合记录，可先手动观看')
  } catch (e) {
    notice(explain(e))
  }
}
function presence(visible: boolean) {
  if (!context.identified) return Promise.resolve()
  return call('set_player_visible', { instance, visible }, 1800).catch(() => {})
}
async function suspend() {
  if (!pageActive) return flushVolume()
  pageActive = false
  await Promise.all([pause('已暂停，点击播放继续', true), presence(false), flushVolume()])
}
function retryInterruptedPlayback(intent: InterruptedPlayback) {
  if (intent.action !== action || !pageActive || !loaded || playback !== 'playing' ||
      !video.paused || video.ended || video.error) return
  const position = video.currentTime
  // If the host refuses to play, wait for focus to return instead of looping at the same frame.
  if (intent.lastPosition !== undefined && Math.abs(position - intent.lastPosition) < 0.25) return
  intent.lastPosition = position
  void video.play().then(() => {
    if (intent.action === action && !video.paused) notice('正在播放')
  }).catch(() => {})
}
function rememberBackgroundPlayback() {
  if (!pageActive || playback !== 'playing') return
  if (backgroundPlayback?.action !== action) backgroundPlayback = { action }
  retryInterruptedPlayback(backgroundPlayback)
}
function restoreAfterFocus() {
  const intent = backgroundPlayback
  if (!intent) return
  backgroundPlayback = undefined
  // A task may have ended while the renderer was in the background.
  void poll().then(() => retryInterruptedPlayback({ action: intent.action }))
}
function syncVisibility() {
  if (!pageActive) return
  void presence(!document.hidden)
  if (document.hidden) {
    rememberBackgroundPlayback()
    void save()
  } else restoreAfterFocus()
  void poll()
}
function activatePage() {
  if (!playerReady || pageActive) return
  pageActive = true
  syncVisibility()
  if (pendingRecommendationTurn && episode?.playable && video.paused && !preparing)
    void start(pendingRecommendationTurn)
}
document.addEventListener('visibilitychange', syncVisibility)
window.addEventListener('blur', rememberBackgroundPlayback)
window.addEventListener('focus', restoreAfterFocus)
window.addEventListener('pagehide', () => void suspend())
window.addEventListener('pageshow', activatePage)

async function initPlayer(selection?: WaitingSelection) {
  if (playerReady) return
  const generation = sourceGeneration
  playerReady = true
  pendingRecommendationTurn = undefined
  waitingPlaybackId = selection?.play ? selection.playbackId : undefined
  if (navigator.mediaSession) {
    navigator.mediaSession.setActionHandler('pause', () => { void pause('已手动暂停') })
    navigator.mediaSession.setActionHandler('play', () => { if (video.paused && !preparing) void start() })
  }
  timer = window.setInterval(() => void poll(), 1000)
  el('pair').hidden = browser || isWaiting
  el('choose').hidden = browser || context.identified
  current = null
  displayState()
  activatePage()
  await openingPreferences()
  if (!playerReady || generation !== sourceGeneration) return
  await refreshProviders()
  if (!playerReady || generation !== sourceGeneration) return
  activeSource = context.source ?? prefs.defaultSource ?? 'hongguo'
  syncSourceButton()
  if (selection?.pick) {
    const pick = selection.pick
    await select(pick, pick.episodeId, selection.play, selection.turnId)
    if (selection.reason === 'turn-ended' && series?.id === pick.id && video.paused && !preparing)
      notice('推荐所属任务已结束，点击播放继续观看')
    return
  }
  el('home').hidden = false
  el('watch').hidden = true
  const catalog = list()
  void history().then(() => {
    if (!series && watched.length && cards.length) drawCards()
  }).catch(e => notice(explain(e)))
  if (context.selection)
    await select({ id: context.selection.seriesId, title: context.selection.title || '红果短剧' }, context.selection.episodeId)
  await catalog
}
function closePlayer() {
  closeSourceMenu()
  const stopped = suspend()
  playerReady = false
  ++preferencesGeneration
  openingPreferencesLoaded = false
  openingPreferencesLoading = undefined
  el<HTMLButtonElement>('mute').disabled = true
  pendingRecommendationTurn = undefined
  if (navigator.mediaSession) {
    navigator.mediaSession.setActionHandler('pause', null)
    navigator.mediaSession.setActionHandler('play', null)
  }
  window.clearInterval(timer)
  ++selection
  ++listing; ++sourceGeneration
  release()
  return stopped
}
const waiting = isWaiting ? waitingCard(
  selected => { void initPlayer(selected).catch(e => notice(explain(e))) }, closePlayer,
) : null
void connect(ctx => {
  initLocale(hostLocale())
  context = ctx
  if (waiting) { if (ctx.waitingTurn) waiting.connected() }
  else void initPlayer().catch(e => notice(explain(e)))
}, async () => { waiting?.dispose(); await closePlayer() }, () => waiting?.modeChanged()).catch(e => notice(explain(e)))
