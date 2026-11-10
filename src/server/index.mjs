import { McpServer, ResourceTemplate } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { z } from 'zod'
import pkg from '../../package.json' with { type: 'json' }
import { projectRoot } from './paths.mjs'
import { Store } from './store.mjs'
import { Service, schemas } from './service.mjs'
import { Catalog } from './catalog.mjs'
import { BrowserServer } from './browser.mjs'
import { DetachedPlayers } from './detached.mjs'
import { message } from './errors.mjs'

process.umask(0o077)
let store
try {
  store = new Store()
} catch {
  store = new Store(undefined, true)
}
const catalog = new Catalog(store),
  service = new Service(store, catalog)
await catalog.sources.ready
const browser = new BrowserServer(service)
service.detached = new DetachedPlayers(service)
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
server.registerTool(
  'show_waiting_picks', {
    title: '等待时看一集',
    description: 'Show optional Hongguo titles inline when requested by the Hongguo turn-start hook. Returns immediately.',
    inputSchema: { turnId: z.string().regex(/^[A-Za-z0-9_-]{1,128}$/) },
    annotations: { readOnlyHint: true, openWorldHint: false },
    _meta: { ui: { visibility: ['model'], resourceUri: waitingUri }, 'openai/ui': { preferredModelDisplayMode: 'inline' } },
  },
  ({ turnId }, extra) => {
    const initial = service.openWaiting(extra._meta, turnId)
    return { content: [], structuredContent: { shown: !!initial },
      _meta: initial ? { panel: initial.panel, waitingTurn: turnId, ui: { resourceUri: waitingUri } } : {} }
  },
)
server.registerTool(
  'open_drama_panel',
  {
    title: '红果短剧',
    description: '在当前会话选剧与续播',
    inputSchema: {},
    _meta: {
      ui: { ...ui, resourceUri: uri },
      'openai/ui': { entrypoints: [{ type: 'thread' }, { type: 'global' }] },
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
for (const [name, schema] of Object.entries(schemas)) {
  server.registerTool(
    name,
    { inputSchema: { ...schema.shape, panel: z.string().max(80) }, _meta: { ui } },
    async ({ panel, ...input }, extra) => {
      try {
        const data = await service.call(service.panel(panel, extra._meta), name, input)
        return { content: [], _meta: { data } }
      } catch (e) {
        return { isError: true, content: [{ type: 'text', text: message(e) }] }
      }
    },
  )
}
server.server.onclose = () => {
  service.detached.close()
  void catalog.sources.dispose()
  catalog.panelMedia?.close()
  browser.close()
  store.close()
}
await server.connect(new StdioServerTransport())
