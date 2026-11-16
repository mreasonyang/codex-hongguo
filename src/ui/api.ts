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
function requireOfficialDesktop() {
  if (!officialDesktop()) throw Error('红果短剧仅在官方 Codex App 中启用')
}
let inlineSizing: ReturnType<typeof trackInlineSize> | undefined
export const hostLocale = () => app?.getHostContext()?.locale || navigator.language
export const displayMode = () => app?.getHostContext()?.displayMode
export async function requestPlayerTab() {
  requireOfficialDesktop()
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
  requireOfficialDesktop()
  const result = await app!.callServerTool({ name: 'open_drama_panel', arguments: {} }, { timeout: 10000 })
  if (result.isError) throw Error('连接失败，请重试')
  return acceptPanel(result)
}
export async function connect(ready: (c: Context) => void, teardown: () => Promise<void>, modeChanged: () => void) {
  if (browser) {
    ready(await browserContext())
    return
  }
  app!.ontoolresult = (r) => {
    if (!officialDesktop()) return
    if (typeof r._meta?.panel !== 'string') return
    ready(acceptPanel(r))
  }
  app!.onteardown = async () => {
    inlineSizing?.dispose()
    await teardown()
    return {}
  }
  app!.onhostcontextchanged = (ctx) => {
    if (!officialDesktop()) return
    syncHostLook(ctx)
    if (ctx.displayMode !== undefined) {
      modeChanged()
      inlineSizing?.refresh()
    }
  }
  await app!.connect()
  requireOfficialDesktop()
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
  requireOfficialDesktop()
  if (!panel) throw Error('等待会话面板连接')
  const denied = deniedTools.get(name)
  if (denied) throw denied
  const currentPanel = panel
  try {
    const r = await app!.callServerTool({ name, arguments: { ...args, panel: currentPanel } }, { timeout })
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
