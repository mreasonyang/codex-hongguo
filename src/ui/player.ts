import { initLocale, tr } from './locale'
import { coverArt, fill, icon, setCover, setIcon } from './ui-kit'
import { panelStream } from './panel-stream'
import { mediaErrorMessage, waitForMetadata } from './media-startup'
import { finishedTurn } from './playback-turn'
import { initOnboarding, showSetup } from './onboarding'
import { browser, call, connect, hostLocale, type Context, type State } from './api'
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
  | ({ status: 'ready'; codec?: string } & ({ stream: string; manifest: string } | { src: string }))
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
let action = 0,
  selection = 0,
  listing = 0,
  preparing = false,
  pageActive = false
let polling: Promise<void> | undefined
let lastSave = 0,
  saved = Promise.resolve()

let prefs = { autoPrompt: true, autoplayNext: true, searchTerms: ['总裁', '重生', '逆袭'] }
let playback: 'idle' | 'playing' | 'finished' = 'idle'
type InterruptedPlayback = { action: number; lastPosition?: number }
let backgroundPlayback: InterruptedPlayback | undefined
let closeStream: (() => void) | undefined
let mediaLoad: AbortController | undefined
let group = 0,
  batch = 0,
  watched: Progress[] = [],
  dismissedTurn: string | null = null
const isWaiting = document.documentElement.dataset.surface === 'waiting'
const instance = Array.from(crypto.getRandomValues(new Uint32Array(4)), n => n.toString(16).padStart(8, '0')).join('')
let playerReady = false, timer: number | undefined
let promptTurn: string | null = null, promptRender: AbortController | undefined
let waitingPlaybackId: number | undefined
function confirmWaitingPlayback() {
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
  if (!loaded || !series || !episode || !Number.isFinite(video.duration) || !video.duration || (!video.currentTime && !reset)) return saved
  const p: Progress = {
    seriesId: series.id,
    episodeId: episode.id,
    title: series.title,
    label: episode.label,
    positionMs: Math.round((playback === 'finished' || video.ended ? video.duration : video.currentTime) * 1000),
    durationMs: Math.round(video.duration * 1000),
  }
  saved = saved
    .then(() => call('save_progress', { ...p, ...(reset && p.positionMs === 0 ? { reset: true } : {}) }, 1800))
    .then(() => {})
    .catch(() => notice('观看进度暂未写入，请检查本机服务'))
  return saved
}
function pause(reason = '') {
  if (reason === '已手动暂停') confirmWaitingPlayback()
  action++
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
  void pause()
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
  const exactEpisode = waitingTurn && requested
  el('home').hidden = true
  el('watch').hidden = false
  el('back').focus({ preventScroll: true })
  window.scrollTo(0, 0)
  group = 0

  const ticket = ++selection
  void pause()
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
  const playRequested = playNow && action === interaction && pageActive
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
async function moreEpisodes() {
  if (!series || !epCursor) return
  const t = selection,
    old = epCursor
  try {
    const page = await call<Page<Episode>>('get_episodes', { seriesId: series.id, cursor: old })
    if (t !== selection || old !== epCursor) return
    episodes.push(...page.items)
    epCursor = page.cursor === old ? undefined : page.cursor
    drawEpisodes()
  } catch (e) {
    notice(explain(e))
  }
}
el('moreEpisodes').onclick = moreEpisodes
async function nextEpisode(auto = false) {
  if (!episode) return
  const id = episode.id,
    show = selection,
    ticket = action
  let next = episodes.slice(episodes.indexOf(episode) + 1).find((e) => e.playable)
  const tried = new Set<string>()
  while (!next && epCursor && !tried.has(epCursor)) {
    tried.add(epCursor)
    await moreEpisodes()
    if (selection !== show || episode?.id !== id || action !== ticket) return
    next = episodes.slice(episodes.indexOf(episode) + 1).find((e) => e.playable)
  }
  if (!pageActive || (auto && !autoNext.checked)) return
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
    void call<Page<Series>>('list_series', { preview: true }, 90000).then(page => {
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
      const page = await call<Page<Series>>('list_series', { query, cursor }, 90000)
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
    else catalogState('error', '红果暂时没有返回推荐剧目')
    el('more').hidden = pages <= 1 && !cursor
  } catch (e) {
    if (t === listing) {
      catalogState('error', explain(e))
      el('more').hidden = !more
    }
  }
}
async function history() {
  watched = (await call<Page<Progress>>('get_history')).items
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
  if (!pageActive || (browser && !context.identified)) return Promise.resolve()
  polling ??= readTurnState().finally(() => { polling = undefined })
  return polling
}
async function readTurnState() {
  try {
    const state = await call<State>('get_run_state', {
      observeSession: true, playerInstance: document.hidden ? undefined : instance,
    }, 1800)
    if (!pageActive) return
    const reason = finishedTurn(current, state)
    const changed = current?.state !== state.state || current?.turnId !== state.turnId
    current = state
    if (changed) renderPicks()
    displayState()
    if (reason && series) void pause(reason)
  } catch {
    if (!pageActive) return
    el('lamp').classList.remove('on')
    text('state', '本机状态不可达')
  }
}
function updateTime() {
  const dur = video.duration
  if (!Number.isFinite(dur) || !loaded) return
  seek.value = String(Math.round((video.currentTime / dur) * 1000))
  fill(seek)
  text('time', clock(video.currentTime) + ' / ' + clock(dur))
}
async function start(recommendationTurn?: string) {
  if (!episode?.playable || !series || !pageActive) return
  const n = ++action,
    ep = episode,
    show = series
  preparing = true
  syncButtons()
  el('stopped').hidden = true
  try {
    if (!loaded) {
      notice('正在准备播放…')
      let result = await call<Prepared>('prepare_playback', { episodeId: ep.id, retry: true })
      const until = Date.now() + 240000
      while (result.status === 'preparing' && n === action && Date.now() < until) {
        notice('正在本机准备整集…')
        await sleep(700)
        if (n !== action) return
        result = await call<Prepared>('prepare_playback', { episodeId: ep.id })
      }
      if (n !== action) return
      if (result.status !== 'ready') throw Error(result.reason || '准备超时，请重试')
      const media = result
      if (browser !== ('src' in media)) throw Error('本集播放地址已失效，请重试')
      await saved
      const r = await call<Page<Progress>>('get_history', { seriesId: show.id, episodeId: ep.id })
      if (n !== action) return
      release()
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
      const progress = r.items[0]
      const pos = progress && progress.positionMs < progress.durationMs ? progress.positionMs / 1000 : 0
      video.currentTime = pos > 0 && pos < video.duration - 5 ? pos : 0
      if (video.currentTime > 0) {
        text('resumeTime', '已从 ' + clock(pos) + ' 继续')
        el('resumed').hidden = false
      }
      loaded = true
    }
    // Only a delayed recommendation belongs to a specific turn. An ordinary
    // Play gesture on loaded media reaches video.play() without a host request.
    if (recommendationTurn) {
      const state = await call<State>('get_run_state', { observeSession: true }, 1800)
      if (n !== action) return
      if (state.turnId !== recommendationTurn || state.state !== 'submitted') {
        void pause('这条推荐已结束')
        return
      }
    }
    if (n !== action || !pageActive) return
    preparing = false
    if (playback === 'finished') video.currentTime = 0
    playback = 'playing'
    video.playbackRate = parseFloat(el<HTMLSelectElement>('speed').value)
    try {
      await video.play()
    } catch (error) {
      if (n !== action || !pageActive) return
      if (!(error instanceof DOMException && ['AbortError', 'NotAllowedError'].includes(error.name)) ||
          (!document.hidden && document.hasFocus() && backgroundPlayback?.action !== n)) throw error
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
  if (!loaded || playback !== 'playing' || !Number.isFinite(video.duration) ||
      video.currentTime < video.duration - 1) return
  playback = 'finished'
  void save()
  if (autoNext.checked && pageActive) {
    void nextEpisode(true).catch(e => notice(explain(e)))
  } else void pause('本集已播完')
  void saved.then(history).catch(() => {})
}
video.onended = finishEpisode
autoNext.onchange = () => {
  void call('set_preferences', { autoplayNext: autoNext.checked }).catch(e => notice(explain(e)))
}
video.ontimeupdate = () => {
  updateTime()
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
  if (loaded && Number.isFinite(video.duration)) {
    if (playback === 'finished') playback = 'idle'
    video.currentTime = (Number(seek.value) * video.duration) / 1000
  }
}
seek.onchange = () => void save(video.currentTime === 0)
video.onloadedmetadata = () => {
  if (video.videoWidth && video.videoHeight)
    el('stage').style.aspectRatio = video.videoWidth + '/' + video.videoHeight
}
el('restart').onclick = () => {
  if (playback === 'finished') playback = 'idle'
  video.currentTime = 0
  el('resumed').hidden = true
  void save(true)
}
el('mute').onclick = () => {
  if (video.volume === 0) {
    video.volume = 0.7
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
const volume = el<HTMLInputElement>('volume')
video.onvolumechange = () => {
  const silent = video.muted || video.volume === 0
  setIcon(el('mute'), silent ? 'mute' : 'volume', tr(silent ? '取消静音' : '静音'))
  el('mute').setAttribute('aria-pressed', String(silent))
  volume.value = String(Math.round(video.volume * 100))
  fill(volume)
}
video.volume = Number(volume.value) / 100
fill(volume)
volume.oninput = () => {
  video.volume = Number(volume.value) / 100
  video.muted = video.volume === 0
}
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
el('setupOpen').onclick = () => {
  el('settings').hidden = true
  el('prefs').setAttribute('aria-expanded', 'false')
  void showSetup()
}
el('prefs').onclick = () => {
  el('settings').hidden = !el('settings').hidden
  el('prefs').setAttribute('aria-expanded', String(!el('settings').hidden))
  el<HTMLInputElement>('autoPrompt').checked = prefs.autoPrompt
  el<HTMLInputElement>('terms').value = prefs.searchTerms.join('，')
}
el('settings').onsubmit = (e) => {
  e.preventDefault()
  const searchTerms = el<HTMLInputElement>('terms')
    .value.split(/[,，]/)
    .map((s) => s.trim())
    .filter(Boolean)
  void call<typeof prefs>('set_preferences', {
    autoPrompt: el<HTMLInputElement>('autoPrompt').checked,
    searchTerms,
  })
    .then(async (updated) => {
      prefs = updated
      el('settings').hidden = true
      el('prefs').setAttribute('aria-expanded', 'false')
      renderPicks()
      if (!series) await list()
    })
    .catch((err) => notice(explain(err)))
}
el('health').onclick = async () => {
  const box = el('healthInfo')
  box.hidden = !box.hidden
  el('health').setAttribute('aria-expanded', String(!box.hidden))
  if (box.hidden) return
  box.textContent = tr('正在检查…')
  try {
    const h = await call<{ runtime: string; database: boolean; ffmpeg: boolean }>('get_health')
    const rows: Array<[string, string, boolean]> = [
      ['Node', h.runtime, true],
      ['进度库', h.database ? '可写' : '不可用', h.database],
      ['FFmpeg', h.ffmpeg ? '就绪' : '缺失', h.ffmpeg],
    ]
    box.replaceChildren(
      ...rows.map(([name, value, ok]) => {
        const row = document.createElement('div'),
          label = document.createElement('span'),
          result = document.createElement('span')
        row.className = 'healthRow ' + (ok ? 'ok' : 'bad')
        label.textContent = tr(name)
        result.textContent = tr(value)
        row.append(icon(ok ? 'check' : 'alert'), label, result)
        return row
      }),
    )
  } catch (e) {
    box.textContent = explain(e)
  }
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
  if (!pageActive) return
  pageActive = false
  await Promise.all([pause('已暂停，点击播放继续'), presence(false)])
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
}
document.addEventListener('visibilitychange', syncVisibility)
window.addEventListener('blur', rememberBackgroundPlayback)
window.addEventListener('focus', restoreAfterFocus)
window.addEventListener('pagehide', () => void suspend())
window.addEventListener('pageshow', activatePage)

async function initPlayer(selection?: WaitingSelection) {
  if (playerReady) return
  playerReady = true
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
  initOnboarding(notice)
  void call<typeof prefs>('get_preferences').then(settings => {
    if (!playerReady) return
    prefs = settings
    autoNext.checked = prefs.autoplayNext ?? true
    renderPicks()
  }).catch(e => notice(explain(e)))
  if (selection?.pick) {
    const pick = selection.pick
    await select(pick, pick.episodeId, selection.play, selection.turnId)
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
  const stopped = suspend()
  playerReady = false
  if (navigator.mediaSession) {
    navigator.mediaSession.setActionHandler('pause', null)
    navigator.mediaSession.setActionHandler('play', null)
  }
  window.clearInterval(timer)
  ++selection
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
