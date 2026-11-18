import { McpServer, ResourceTemplate } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { getUiCapability, registerAppTool } from '@modelcontextprotocol/ext-apps/server'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { z } from 'zod'
import pkg from '../../package.json' with { type: 'json' }
import { projectRoot } from './paths.mjs'
import { Store } from './store.mjs'
import { Service, schemas } from './service.mjs'
import { Catalog } from './catalog.mjs'
import { registerFfmpegHost } from '../runtime/ffmpeg-runtime.mjs'
import { BrowserServer } from './browser.mjs'
import { message } from './errors.mjs'
import { playerLink, sidecarReady } from './antigravity-sidecar.mjs'

export async function startServer(host) {
  process.umask(0o077)
  let store
  try {
    store = new Store(undefined, false, { host })
  } catch {
    store = new Store(undefined, true, { host })
  }
  // A host can load this plugin directly from a marketplace or local package.
  const catalog = new Catalog(store, { prepareRuntime: registerFfmpegHost }),
    service = new Service(store, catalog)
  await catalog.sources.ready
  const browser = new BrowserServer(service)
  service.pair = (scope) => browser.pair(scope)
  const server = new McpServer({ name: 'codex-hongguo', version: pkg.version })
  const uri = 'ui://hongguo/v41/player', waitingUri = 'ui://hongguo/v41/waiting',
    mimeType = 'text/html;profile=mcp-app'
  const ui = { visibility: ['app'] }
  // Both resources can become the player. hls.js attaches its in-memory MediaSource via a blob URL.
  const scopeMeta = { ui: { csp: { connectDomains: [], resourceDomains: ['blob:'] }, prefersBorder: false } }
  for (const [resourceUri, name] of [[uri, '红果短剧'], [waitingUri, '等待时看一集']]) {
    const waiting = resourceUri === waitingUri
    const meta = waiting ? {
      ...scopeMeta,
      // Codex controls whether the conversation shows the titles separately from the display mode.
      'openai/widgetShowCodexWidgetInline': true,
      'openai/widgetHeightHint': 96,
      'openai/widgetMinFrameHeight': 1,
      'openai/ui': { availableDisplayModes: ['inline', 'fullscreen'], preferredDisplayMode: 'inline' },
    } : scopeMeta
    const read = (requested) => {
      const html = readFileSync(join(projectRoot, 'dist/ui/player.html'), 'utf8')
      return { contents: [{ uri: requested.href, mimeType, _meta: meta,
        text: waiting ? html.replace('data-surface="player"', 'data-surface="waiting"') : html }] }
    }
    server.registerResource(name, resourceUri, { mimeType, _meta: meta }, read)
    // Older conversations can reopen their original URI without advertising a second entry.
    for (const prefix of ['ui://hongguo/', ...Array.from({ length: 39 }, (_, i) => `ui://hongguo/v${i + 2}/`)]) {
      const oldUri = prefix + (waiting ? 'waiting' : 'player')
      if (oldUri === resourceUri) continue
      const legacy = new ResourceTemplate(oldUri, { list: undefined })
      server.registerResource(name + '（' + prefix + '）', legacy, { mimeType, _meta: meta }, read)
    }
  }
  registerAppTool(server,
    'show_waiting_picks', {
      title: '等待时看一集',
      description: 'Show optional Hongguo titles inline when requested by the Hongguo turn-start hook. Returns immediately.',
      inputSchema: { turnId: z.string().regex(/^[A-Za-z0-9_-]{1,128}$/) },
      annotations: { readOnlyHint: true, openWorldHint: false },
      _meta: {
        ui: { visibility: ['model'], resourceUri: waitingUri },
        'openai/ui': { preferredModelDisplayMode: 'inline' },
        ...(host.id === 'antigravity' ? { 'antigravity/alwaysLoad': true } : {}),
      },
    },
    async ({ turnId }, extra) => {
      const initial = service.openWaiting(extra._meta, turnId)
      const apps = getUiCapability(server.server.getClientCapabilities())
      const nativePlayer = host.id === 'antigravity' && sidecarReady(store)
      if (initial && host.id === 'antigravity' && (nativePlayer || !apps?.mimeTypes?.includes(mimeType))) {
        const titles = await service.textWaitingPicks(initial.panel)
        const text = titles.length ? '等待时看一集 · 红果短剧：' + titles.map(title => '《' + title + '》').join('、')
          : '这一轮暂无红果短剧推荐。'
        const link = nativePlayer && titles.length ? playerLink : undefined
        return { content: [{ type: 'text', text: link ? text + '\n' + link : text }], structuredContent: {
          shown: false, presentation: link ? 'sidecar' : 'text', hasPicks: titles.length > 0, ...(link && { playerLink: link }),
        }, _meta: { panel: initial.panel, waitingTurn: turnId, ui: { resourceUri: waitingUri } } }
      }
      return { content: [], structuredContent: { shown: !!initial },
        _meta: initial ? { panel: initial.panel, waitingTurn: turnId, ui: { resourceUri: waitingUri } } : {} }
    },
  )
  registerAppTool(server,
    'open_drama_panel',
    {
      title: '红果短剧',
      description: '在当前会话选剧与续播',
      inputSchema: {},
      annotations: { readOnlyHint: true },
      _meta: {
        ui: { ...ui, resourceUri: uri },
        'openai/ui': { entrypoints: [{ type: 'thread' }, { type: 'global' }] },
        'com.google.antigravity/ui': { entrypoints: [
          { type: 'aux_pane', title: '红果短剧' }, { type: 'global', title: '红果短剧' },
        ] },
      },
    },
    (_args, extra) => {
      const initial = service.open(extra._meta)
      void catalog.recommendations().catch(() => {})
      return {
        content: [],
        structuredContent: { state: initial.state, identified: initial.identified, source: initial.source },
        _meta: { panel: initial.panel },
      }
    },
  )
  // Reads may refresh scoped handles, caches or player liveness. They do not
  // change viewing progress, preferences or account state. Hosts such as T3 use
  // this annotation to keep app polling and media reads out of approval dialogs.
  const readOnlyTools = new Set([
    'get_waiting_status', 'get_waiting_picks', 'get_run_state', 'list_sessions',
    'list_series', 'get_cover', 'get_episodes', 'get_history',
    'read_panel_chunk', 'read_panel_manifest', 'get_preferences',
    'get_provider_auth', 'get_providers',
  ])
  for (const [name, schema] of Object.entries(schemas)) {
    server.registerTool(
      name,
      { inputSchema: { ...schema.shape, panel: z.string().max(80) },
        annotations: { readOnlyHint: readOnlyTools.has(name) }, _meta: { ui } },
      async ({ panel, ...input }, extra) => {
        try {
          const data = await service.call(service.panel(panel, extra._meta), name, input, false, extra.signal)
          return { content: [], _meta: { data } }
        } catch (e) {
          return { isError: true, content: [{ type: 'text', text: message(e) }] }
        }
      },
    )
  }
  server.server.onclose = () => {
    void catalog.sources.dispose()
    catalog.panelMedia?.close()
    browser.close()
    store.close()
  }
  await server.connect(new StdioServerTransport())
}
