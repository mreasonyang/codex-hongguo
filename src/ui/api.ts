import { App, applyDocumentTheme, applyHostStyleVariables } from '@modelcontextprotocol/ext-apps'
import { trackInlineSize } from './inline-size'
import pkg from '../../package.json' with { type: 'json' }
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
  autoPrompt: boolean
  autoplayNext: boolean
  autoPauseOnFinish: boolean
  autoPlayOnStart: boolean
  defaultMuted: boolean
  volume: number
  searchTerms: string[]
}
export type State = {
  state: 'unknown' | 'submitted' | 'stopped' | 'interrupted'
  turnId: string | null
  observedAt: number | null
  preferences?: Preferences
}
export const browser = document.documentElement.dataset.host === 'browser'
const waitingSurface = document.documentElement.dataset.surface === 'waiting'
let panel = ''
const app = browser ? null : new App({ name: '红果短剧', version: pkg.version }, {}, { autoResize: !waitingSurface })
let inlineSizing: ReturnType<typeof trackInlineSize> | undefined
export const hostLocale = () => app?.getHostContext()?.locale || navigator.language
export const displayMode = () => app?.getHostContext()?.displayMode
export async function requestPlayerTab() {
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
export async function connect(ready: (c: Context) => void, teardown: () => Promise<void>, modeChanged: () => void) {
  if (browser) {
    const r = await fetch('context', { signal: AbortSignal.timeout(4000) })
    if (!r.ok) throw Error('分屏已失效，请从面板重新打开')
    ready(await r.json())
    return
  }
  app!.ontoolresult = (r) => {
    if (typeof r._meta?.panel !== 'string') return
    panel = r._meta.panel
    const waitingTurn = typeof r._meta.waitingTurn === 'string' ? r._meta.waitingTurn : undefined
    const source = r.structuredContent?.source
    ready({ identified: !!r.structuredContent?.identified || !!waitingTurn, waitingTurn,
      ...(typeof source === 'string' && /^[a-z][a-z0-9-]{0,31}$/.test(source) ? { source } : {}) })
  }
  app!.onteardown = async () => {
    inlineSizing?.dispose()
    await teardown()
    return {}
  }
  app!.onhostcontextchanged = (ctx) => {
    syncHostLook(ctx)
    if (ctx.displayMode !== undefined) {
      modeChanged()
      inlineSizing?.refresh()
    }
  }
  await app!.connect()
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
  if (!panel) throw Error('等待会话面板连接')
  const r = await app!.callServerTool({ name, arguments: { ...args, panel } }, { timeout })
  if (r.isError) throw Error(r.content?.[0]?.type === 'text' ? r.content[0].text : '本机服务不可达')
  return r._meta?.data as T
}
