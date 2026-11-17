import { App, applyDocumentTheme, applyHostStyleVariables } from '@modelcontextprotocol/ext-apps'
import { trackInlineSize } from './inline-size'
import pkg from '../../package.json' with { type: 'json' }
import type { CoverStyle } from './cover-page'
export type Context = {
  source?: SourceId
  identified: boolean
  waitingTurn?: string
  turnId?: string
  selection?: { seriesId: string; episodeId?: string; title?: string }
}
export type SourceId = string
export type Preferences = {
  defaultSource: SourceId
  contentPreferences?: Record<string, { contentType: string; category?: string }>
  autoPrompt: boolean
  excludeNsfwRecommendations: boolean
  autoplayNext: boolean
  autoPauseOnFinish: boolean
  autoPlayOnStart: boolean
  defaultMuted: boolean
  hoverDecoyEnabled: boolean
  coverStyle: CoverStyle
  volume: number
  searchTerms: string[]
}
export type State = {
  authRevision?: string
  source?: SourceId
  state: 'unknown' | 'submitted' | 'stopped' | 'interrupted'
  turnId: string | null
  observedAt: number | null
  preferences?: Preferences
}
export const browser = document.documentElement.dataset.host === 'browser'
const waitingSurface = document.documentElement.dataset.surface === 'waiting'
let panel = ''
const deniedTools = new Map<string, ToolAuthorizationDenied>()
class ToolAuthorizationDenied extends Error {
  constructor() { super('已取消授权，请重新打开播放器后重试') }
}
export const isToolAuthorizationDenied = (error: unknown): boolean => error instanceof ToolAuthorizationDenied
const app = browser ? null : new App({ name: '红果短剧', version: pkg.version }, {}, { autoResize: !waitingSurface })
// Use the initialized MCP Apps host identity, not the browser's user agent or
// the fact that a client happens to run Codex underneath.
const officialDesktop = () => app?.getHostVersion()?.name === 'chatgpt' && app?.getHostContext()?.platform === 'desktop'
export const antigravity = () => app?.getHostVersion()?.name === 'Antigravity' && app?.getHostContext()?.platform === 'web'
const supportedHost = () => officialDesktop() || antigravity()
export const unsupportedHostMessage = '红果短剧仅在官方 Codex App 或 Antigravity App 中启用'
function requireSupportedHost() {
  if (!supportedHost()) throw Error(unsupportedHostMessage)
}
// Antigravity allows four concurrent app calls. Keep progress/state ahead of
// queued covers and media, and reject stale queued work after reconnecting.
let inFlight = 0
const pending: { priority: number; run: () => void }[] = []
function hostCall(name: string, args: Record<string, unknown>, timeout: number, scope?: string) {
  if (!antigravity()) return app!.callServerTool({ name, arguments: args }, { timeout })
  const expires = Date.now() + timeout
  return new Promise<Awaited<ReturnType<App['callServerTool']>>>((resolve, reject) => {
    const run = () => {
      if (scope !== undefined && scope !== panel) { reject(Error('请重新打开短剧面板')); return }
      if (deniedTools.has(name)) { reject(deniedTools.get(name)); return }
      const remaining = expires - Date.now()
      if (remaining <= 0) { reject(Error('本机服务请求超时，请重试')); return }
      inFlight++
      Promise.resolve().then(() => app!.callServerTool({ name, arguments: args }, { timeout: remaining }))
        .then(resolve, reject).finally(() => { inFlight--; drain() })
    }
    pending.push({ priority: ['save_progress', 'get_run_state', 'set_preferences'].includes(name) ? 1 : 0, run })
    drain()
  })
}
function drain() {
  pending.sort((a, b) => b.priority - a.priority)
  while (pending.length && inFlight < 4) pending.shift()!.run()
}
let expandedInline = false, modeChangedCallback = () => {}
let inlineSizing: ReturnType<typeof trackInlineSize> | undefined
export const hostLocale = () => app?.getHostContext()?.locale || navigator.language
export const displayMode = () => expandedInline ? 'fullscreen' : app?.getHostContext()?.displayMode
export async function requestPlayerTab() {
  requireSupportedHost()
  if (antigravity()) {
    // This host cannot change display modes. Expand the card in place; its
    // separate aux_pane entrypoint is available for a persistent side panel.
    await app!.sendSizeChanged({ height: 760 })
    inlineSizing?.dispose()
    expandedInline = true
    modeChangedCallback()
    return
  }
  const result = await app?.requestDisplayMode({ mode: 'fullscreen' }, { timeout: 5000 })
  if (result?.mode !== 'fullscreen') throw Error('当前 Codex 无法在会话中打开播放器')
}
type HostContext = NonNullable<ReturnType<App['getHostContext']>>
/** Follow the host theme and design tokens. Without a host, the stylesheet follows the system theme. */
function syncHostLook(ctx?: Partial<HostContext>) {
  if (!ctx) return
  if (ctx.theme) applyDocumentTheme(ctx.theme)
  if (ctx.styles?.variables) applyHostStyleVariables(ctx.styles.variables)
}
type PanelResult = { _meta?: Record<string, unknown>; structuredContent?: Record<string, unknown> }
function acceptPanel(result: PanelResult): Context {
  if (typeof result._meta?.panel !== 'string' || !result._meta.panel) throw Error('等待会话面板连接')
  if (panel !== result._meta.panel) deniedTools.clear()
  panel = result._meta.panel
  const waitingTurn = typeof result._meta.waitingTurn === 'string' ? result._meta.waitingTurn : undefined
  const source = result.structuredContent?.source
  return { identified: !!result.structuredContent?.identified || !!waitingTurn, waitingTurn,
    ...(typeof source === 'string' && /^[a-z][a-z0-9-]{0,31}$/.test(source) ? { source } : {}) }
}
async function browserContext(): Promise<Context> {
  const r = await fetch('context', { signal: AbortSignal.timeout(4000) })
  if (!r.ok) throw Error('分屏已失效，请从面板重新打开')
  return r.json()
}
/** Renew through the normal host tool so an expired in-memory panel is never reused. */
export async function reopenPanel(): Promise<Context> {
  if (browser) return browserContext()
  requireSupportedHost()
  const result = await hostCall('open_drama_panel', {}, 10000)
  if (result.isError) throw Error('连接失败，请重试')
  return acceptPanel(result)
}
export async function connect(ready: (c: Context) => void, teardown: () => Promise<void>, modeChanged: () => void) {
  modeChangedCallback = modeChanged
  if (browser) {
    ready(await browserContext())
    return
  }
  app!.ontoolresult = (r) => {
    if (!supportedHost()) return
    if (typeof r._meta?.panel !== 'string') return
    ready(acceptPanel(r))
  }
  app!.onteardown = async () => {
    inlineSizing?.dispose()
    await teardown()
    return {}
  }
  app!.onhostcontextchanged = (ctx) => {
    if (!supportedHost()) return
    syncHostLook(ctx)
    if (ctx.displayMode !== undefined) {
      modeChanged()
      inlineSizing?.refresh()
    }
  }
  await app!.connect()
  requireSupportedHost()
  syncHostLook(app!.getHostContext())
  if (waitingSurface) inlineSizing = trackInlineSize(
    document.getElementById('waitingCard')!,
    () => (displayMode() || 'inline') === 'inline',
    height => { void app!.sendSizeChanged({ height }).catch(() => {}) },
  )
  modeChanged()
}
export async function call<T>(name: string, args: Record<string, unknown> = {}, timeout = 15000): Promise<T> {
  if (browser) {
    const r = await fetch('api/' + name, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(args),
      keepalive: name === 'save_progress' || (name === 'set_preferences' && 'volume' in args),
      signal: AbortSignal.timeout(timeout),
    })
    const data = await r.json()
    if (!r.ok) throw Error(data.error || '分屏连接已中断')
    return data as T
  }
  requireSupportedHost()
  if (!panel) throw Error('等待会话面板连接')
  const denied = deniedTools.get(name)
  if (denied) throw denied
  const currentPanel = panel
  try {
    const r = await hostCall(name, { ...args, panel: currentPanel }, timeout, currentPanel)
    if (r.isError) throw Error(r.content?.[0]?.type === 'text' ? r.content[0].text : '本机服务不可达')
    return r._meta?.data as T
  } catch (error) {
    // T3 returns this host refusal as an MCP error. Background retries must not
    // ask again; only a newly opened panel resets this tool's authorization.
    if (error instanceof Error && /(?:^|: )Declined by the user[.!]?$/i.test(error.message)) {
      const denied = new ToolAuthorizationDenied()
      if (panel === currentPanel) deniedTools.set(name, denied)
      throw denied
    }
    throw error
  }
}
