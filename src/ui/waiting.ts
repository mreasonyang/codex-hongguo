import { call, displayMode, requestPlayerTab } from './api'
import { tr } from './locale'

export type WaitingPick = { id: string; title: string; episodeId?: string; kind?: 'resume' | 'next'; contentType?: string; episodes?: number; label?: string }
export type WaitingSelection = { turnId: string; pick: WaitingPick | null; play: boolean; playbackId?: number; reason?: 'turn-ended' }

export function pickLabel(pick: WaitingPick) {
  if (!pick.episodeId) return pick.title
  return tr(pick.kind === 'next' ? (pick.contentType === 'video' ? '看下一 P' : '看下一集') : '继续观看') + ' · ' + pick.title +
    (pick.contentType === 'video' && pick.kind !== 'next' && pick.label ? ' · ' + pick.label : '')
}
function whenVisible(element: HTMLElement, signal: AbortSignal): Promise<boolean> {
  if (signal.aborted) return Promise.resolve(false)
  return new Promise(resolve => {
    const observer = new IntersectionObserver(entries => {
      const last = entries[entries.length - 1]
      if (!document.hidden && last.isIntersecting && last.intersectionRect.width > 0 && last.intersectionRect.height > 0)
        finish(true)
    }, { threshold: [0, 0.01] })
    const finish = (visible: boolean) => {
      observer.disconnect()
      document.removeEventListener('visibilitychange', recheck)
      signal.removeEventListener('abort', abort)
      resolve(visible)
    }
    const abort = () => finish(false)
    const recheck = () => {
      if (!document.hidden) {
        observer.unobserve(element)
        observer.observe(element)
      }
    }
    signal.addEventListener('abort', abort)
    document.addEventListener('visibilitychange', recheck)
    observer.observe(element)
  })
}
export async function showWaitingPicks(
  card: HTMLElement, titles: HTMLElement, signal: AbortSignal, turnId: string | undefined,
  draw: (items: WaitingPick[]) => void,
  keepEmpty = false,
) {
  const scope = turnId ? { turnId } : {}
  titles.replaceChildren()
  card.hidden = false
  if (!await whenVisible(card, signal)) return
  const { items } = await call<{ items: WaitingPick[] }>('get_waiting_picks', { ...scope, inView: true }, 90000)
  if (signal.aborted) return
  if (!items.length) {
    if (keepEmpty) draw([])
    else card.hidden = true
    return
  }
  draw(items)
  if (!await whenVisible(titles, signal)) return
  try {
    await call('mark_waiting_picks_shown', scope)
  } catch {
    if (await whenVisible(titles, signal)) await call('mark_waiting_picks_shown', scope).catch(() => {})
  }
}

export function waitingCard(openPlayer: (selection: WaitingSelection) => void, closePlayer: () => void) {
  const card = document.getElementById('waitingCard')!
  const titles = document.getElementById('waitingTitles')!
  const status = document.getElementById('waitingMessage')!
  const dismiss = document.getElementById('waitingDismiss')!
  let ready = false, expanded = false, choosing = false, dismissed = false, allowed = true, checking = false
  let render = 0, lastMode: string | undefined
  let showing: AbortController | undefined
  let activation: Promise<WaitingSelection> | undefined
  let timer: ReturnType<typeof setInterval> | undefined

  function hide() {
    ++render
    showing?.abort()
    showing = undefined
    card.hidden = true
    titles.replaceChildren()
    status.textContent = ''
  }
  dismiss.onclick = () => {
    dismissed = true
    hide()
    void call('dismiss_waiting_picks').catch(() => {})
  }

  function message(error: unknown) {
    if (!ready || dismissed || !allowed || expanded) return
    status.textContent = tr(error instanceof Error ? error.message : '当前 Codex 无法在会话中打开播放器')
    card.hidden = false
  }
  async function refresh(force = false) {
    if (!ready) return
    const mode = displayMode() || 'inline'
    if (!force && mode === lastMode) return
    lastMode = mode
    const generation = ++render
    showing?.abort()
    const work = showing = new AbortController()
    if (mode === 'fullscreen') {
      if (expanded) return
      const selection = await (activation ??= call<WaitingSelection>('activate_waiting_player'))
      if (generation !== render) return
      expanded = true
      card.hidden = true
      document.documentElement.dataset.surface = 'player'
      openPlayer(selection)
      return
    } else {
      activation = undefined
      if (expanded) {
        expanded = false
        closePlayer()
        document.documentElement.dataset.surface = 'waiting'
      }
    }
    if (dismissed) { hide(); return }
    const state = await call<{ visible: boolean }>('get_waiting_status')
    if (generation !== render) return
    allowed = state.visible
    if (!allowed) { hide(); return }
    status.textContent = ''
    await showWaitingPicks(card, titles, work.signal, undefined, items => {
      const buttons = items.map(pick => {
        const button = document.createElement('button')
        button.type = 'button'
        button.textContent = pickLabel(pick)
        button.onclick = () => { void choose(pick) }
        return button
      })
      const more = document.createElement('button')
      more.type = 'button'
      more.textContent = tr('更多…')
      more.onclick = () => { void choose() }
      titles.replaceChildren(...buttons, more)
    }, true).catch(error => { if (!work.signal.aborted) message(error) })
  }
  async function choose(pick?: WaitingPick) {
    if (choosing) return
    choosing = true
    status.textContent = ''
    try {
      // The host can replace this iframe when opening the tab. Save the click on its tool scope first.
      if (pick) await call('select_waiting_pick', { seriesId: pick.id })
      else await call('browse_waiting_catalog')
      if (displayMode() === 'fullscreen') await refresh(true)
      else {
        await requestPlayerTab()
        card.hidden = true
      }
    } catch (error) {
      message(error)
      if (error instanceof Error && error.message === '这条推荐已结束') hide()
    } finally {
      choosing = false
    }
  }
  async function check() {
    if (!ready || expanded || choosing || dismissed || document.hidden || checking) return
    checking = true
    try {
      const state = await call<{ visible: boolean }>('get_waiting_status')
      if (!ready || expanded || choosing || dismissed) return
      if (state.visible !== allowed) {
        allowed = state.visible
        if (allowed) await refresh(true)
        else hide()
      }
    } catch {
      if (!expanded && !choosing) { allowed = false; hide() }
    } finally { checking = false }
  }
  const sync = () => { void refresh().catch(message) }
  const visible = () => {
    if (!document.hidden && ready && !expanded && !dismissed) void refresh(true).catch(message)
  }
  return {
    connected() {
      if (ready) return
      ready = true
      timer = setInterval(() => void check(), 1000)
      document.addEventListener('visibilitychange', visible)
      sync()
    },
    modeChanged: sync,
    dispose() {
      ready = false
      clearInterval(timer)
      document.removeEventListener('visibilitychange', visible)
      hide()
    },
  }
}
