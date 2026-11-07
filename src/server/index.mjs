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
import { message } from './errors.mjs'
import { decoyOrigin, decoyPolicyKey, decoyDocument } from './decoy.mjs'

process.umask(0o077)
let store
try {
  store = new Store()
} catch {
  store = new Store(undefined, true)
}
const catalog = new Catalog(store),
  service = new Service(store, catalog)
const browser = new BrowserServer(service)
service.pair = (scope) => browser.pair(scope)
const server = new McpServer({ name: 'codex-hongguo', version: pkg.version })
const uri = 'ui://hongguo/v20/player', waitingUri = 'ui://hongguo/v20/waiting',
  mimeType = 'text/html;profile=mcp-app'
const ui = { visibility: ['app'] }
// Both resources can become the player. hls.js attaches its in-memory MediaSource via a blob URL.
// The host caches HTML and CSP by URI. Keep each origin and initial cover state immutable per URI.
const policies = new Map()
let policyId
function currentPolicy() {
  const settings = store.preferences(), origin = decoyOrigin(settings.decoyUrl)
  const id = `${settings.hoverDecoyEnabled ? 'on' : 'off'}-${decoyPolicyKey(origin)}`
  policies.set(id, { origin, hoverDecoyEnabled: settings.hoverDecoyEnabled })
  return id
}
policyId = currentPolicy()
const resourceUri = base => policyId === 'off-builtin' ? base : base + '/' + policyId
function resourceMeta(waiting, origin = '') {
  const scopeMeta = { ui: { csp: { connectDomains: [], resourceDomains: ['blob:'], frameDomains: origin ? [origin] : [] }, prefersBorder: false } }
  return waiting ? {
    ...scopeMeta,
    'openai/widgetShowCodexWidgetInline': true,
    'openai/widgetHeightHint': 96,
    'openai/widgetMinFrameHeight': 1,
    'openai/ui': { availableDisplayModes: ['inline', 'fullscreen'], preferredDisplayMode: 'inline' },
  } : scopeMeta
}
for (const [resourceUri, name] of [[uri, '红果短剧'], [waitingUri, '等待时看一集']]) {
  const waiting = resourceUri === waitingUri
  const meta = resourceMeta(waiting)
  const read = (requested, snapshot = { origin: '', hoverDecoyEnabled: false }) => {
    const html = readFileSync(join(projectRoot, 'dist/ui/player.html'), 'utf8')
    const text = decoyDocument(html, snapshot, snapshot.origin)
    return { contents: [{ uri: requested.href, mimeType, _meta: resourceMeta(waiting, snapshot.origin),
      text: waiting ? text.replace('data-surface="player"', 'data-surface="waiting"') : text }] }
  }
  server.registerResource(name, resourceUri, { mimeType, _meta: meta }, requested => read(requested))
  server.registerResource(name + '（显示策略）', new ResourceTemplate(resourceUri + '/{policy}', { list: undefined }),
    { mimeType }, (requested, variables) => {
      currentPolicy()
      const snapshot = policies.get(variables.policy)
      if (!snapshot) throw Error('播放器显示策略已过期，请重新打开')
      return read(requested, snapshot)
    })
  // Older conversations can reopen their original URI without advertising a second entry.
  for (const prefix of ['ui://hongguo/', 'ui://hongguo/v2/', 'ui://hongguo/v3/', 'ui://hongguo/v4/', 'ui://hongguo/v5/', 'ui://hongguo/v6/', 'ui://hongguo/v7/', 'ui://hongguo/v8/', 'ui://hongguo/v9/', 'ui://hongguo/v10/', 'ui://hongguo/v11/', 'ui://hongguo/v12/', 'ui://hongguo/v13/', 'ui://hongguo/v14/', 'ui://hongguo/v15/', 'ui://hongguo/v16/', 'ui://hongguo/v17/', 'ui://hongguo/v18/', 'ui://hongguo/v19/']) {
    const oldUri = prefix + (waiting ? 'waiting' : 'player')
    if (oldUri === resourceUri) continue
    const legacy = new ResourceTemplate(oldUri, { list: undefined })
    server.registerResource(name + '（' + prefix + '）', legacy, { mimeType, _meta: meta },
      requested => read(requested, policies.get(currentPolicy())))
  }
}
const waitingMeta = () => ({ ui: { visibility: ['model'], resourceUri: resourceUri(waitingUri) }, 'openai/ui': { preferredModelDisplayMode: 'inline' } })
const playerMeta = () => ({ ui: { ...ui, resourceUri: resourceUri(uri) }, 'openai/ui': { entrypoints: [{ type: 'thread' }, { type: 'global' }] } })
function refreshPolicy() {
  const next = currentPolicy()
  if (next === policyId) return
  policyId = next
  waitingTool.update({ _meta: waitingMeta() })
  playerTool.update({ _meta: playerMeta() })
}
const waitingTool = server.registerTool(
  'show_waiting_picks', {
    title: '等待时看一集',
    description: 'Show optional Hongguo titles inline when requested by the Hongguo turn-start hook. Returns immediately.',
    inputSchema: { turnId: z.string().regex(/^[A-Za-z0-9_-]{1,128}$/) },
    annotations: { readOnlyHint: true, openWorldHint: false },
    _meta: waitingMeta(),
  },
  ({ turnId }, extra) => {
    refreshPolicy()
    const initial = service.openWaiting(extra._meta, turnId)
    return { content: [], structuredContent: { shown: !!initial },
      _meta: initial ? { panel: initial.panel, waitingTurn: turnId, ui: { resourceUri: resourceUri(waitingUri) } } : {} }
  },
)
const playerTool = server.registerTool(
  'open_drama_panel',
  {
    title: '红果短剧',
    description: '在当前会话选剧与续播',
    inputSchema: {},
    _meta: playerMeta(),
  },
  (_args, extra) => {
    refreshPolicy()
    const initial = service.open(extra._meta)
    void catalog.recommendations().catch(() => {})
    return {
      content: [],
      structuredContent: { state: initial.state, identified: initial.identified },
      _meta: { panel: initial.panel, ui: { resourceUri: resourceUri(uri) } },
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
        if (['set_preferences', 'get_preferences', 'get_run_state'].includes(name)) refreshPolicy()
        return { content: [], _meta: { data } }
      } catch (e) {
        return { isError: true, content: [{ type: 'text', text: message(e) }] }
      }
    },
  )
}
server.server.onclose = () => {
  catalog.panelMedia?.close()
  browser.close()
  store.close()
}
await server.connect(new StdioServerTransport())
