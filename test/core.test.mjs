import test from 'node:test'
import { defer } from './cleanup.mjs'
import { get } from 'node:http'
import assert from 'node:assert/strict'
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, rmSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { spawnSync } from 'node:child_process'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { Store, callerId } from '../src/server/store.mjs'
import { Catalog } from '../src/server/catalog.mjs'
import { Service } from '../src/server/service.mjs'
import { BrowserServer, range } from '../src/server/browser.mjs'
import { waitForMetadata } from '../src/ui/media-startup.ts'
import { finishedTurn } from '../src/ui/playback-turn.ts'
import { ffmpeg, hasFfmpeg, MediaCache, runFfmpeg } from '../src/server/media.mjs'
import { PanelMedia } from '../src/server/panel-media.mjs'
import { projectRoot } from '../src/server/paths.mjs'
import { ensureFfmpeg } from '../src/runtime/ffmpeg-runtime.mjs'
await ensureFfmpeg()
const avcFixture = join(projectRoot, 'test/fixtures/avc-aac.mp4')

test('the first snapshot, running turns and repeated terminal snapshots leave Play alone', () => {
  const running = { state: 'submitted', turnId: 'one' }
  const stopped = { ...running, state: 'stopped' }
  assert.equal(finishedTurn(null, stopped), null)
  assert.equal(finishedTurn(running, running), null)
  assert.match(finishedTurn(running, stopped), /本轮已停止/)
  assert.equal(finishedTurn(stopped, stopped), null)
  assert.equal(finishedTurn(stopped, { ...stopped, state: 'interrupted' }), null)
})

test('a player resumed while idle also pauses once for the next turn, including a short turn between polls', () => {
  const idle = { state: 'stopped', turnId: 'one' }
  const next = { state: 'submitted', turnId: 'two' }
  const interrupted = { ...next, state: 'interrupted' }
  assert.equal(finishedTurn(idle, next), null)
  assert.match(finishedTurn(next, interrupted), /本轮已中断/)
  assert.match(finishedTurn(idle, interrupted), /本轮已中断/)
  assert.equal(finishedTurn(interrupted, interrupted), null)
})
// Only the provider and the pre-existing download are supplied by the test.
test('panel startup distinguishes policy, missing metadata, source and decode failures', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const video = new EventTarget()
  const wait = (abort = new AbortController()) => waitForMetadata(video, abort.signal)
  const timeout = wait()
  t.mock.timers.tick(30000)
  await assert.rejects(timeout, /等待视频元数据超时/)
  for (const [code, expected] of [[4, /无法打开视频来源/], [3, /解码视频数据失败/], [2, /读取视频数据失败/]]) {
    const result = wait()
    video.error = { code }
    video.dispatchEvent(new Event('error'))
    await assert.rejects(result, expected)
  }
  const abort = new AbortController(), blocked = wait(abort)
  abort.abort(Error('桌面安全策略阻止了侧栏载入本地视频'))
  video.dispatchEvent(new Event('error'))
  await assert.rejects(blocked, /桌面安全策略/)
  const loaded = wait()
  video.dispatchEvent(new Event('loadedmetadata'))
  await loaded
})

// Episode selection, cache lookup, panel streaming and browser grants use the normal service.
function cachedCatalog(t, store, source = avcFixture, codec = 'h264') {
  const catalog = new Catalog(store)
  t.mock.method(catalog.sources.get('hongguo'), 'sdkCall', async (method, id) => {
    assert.equal(method, 'listEpisodes')
    assert.equal(id, '10')
    return { items: [{ id: '101', number: 1, title: '第1集', playable: true }] }
  })
  catalog.ffmpeg = true
  catalog.cache = new MediaCache(store, () => assert.fail('expected a cache hit'))
  copyFileSync(source, catalog.cache.path('hg-101'))
  store.db.prepare("INSERT INTO media(id, status, codec) VALUES ('hg-101', 'ready', ?)").run(codec)
  return catalog
}
function hlsCommands(run) {
  return run.mock.calls.map(call => call.arguments[0]).filter(args => args.at(-1) === 'index.m3u8')
}
function ffOption(args, name) {
  const index = args.indexOf(name)
  return index < 0 ? undefined : args[index + 1]
}
const env = (dir) => ({ PATH: process.env.PATH, HONGGUO_DATA_DIR: dir })
function setup(t) {
  const dir = mkdtempSync(join(tmpdir(), '红果 测试 ')),
    store = new Store(dir)
  defer(t, () => {
    store.close()
    rmSync(dir, { force: true, recursive: true })
  })
  return { dir, store }
}
function event(store, id, turn, kind, at = Date.now()) {
  store.event({ session_id: id, turn_id: turn, hook_event_name: kind }, at)
}
test('only matching bounded host thread aliases may select a session', () => {
  assert.equal(callerId({ thread_id: 'a', threadId: 'a' }), 'a')
  for (const meta of [
    { thread_id: 'a', threadId: 'b' },
    { thread_id: 42 },
    { thread_id: ' a ' },
    { 'openai/session': 'a' },
    {},
  ])
    assert.equal(callerId(meta), null)
})
test('terminal events survive duplicate, out-of-order and concurrent-session submissions', (t) => {
  const { store } = setup(t)
  event(store, 'a', 'old', 'Stop', 1)
  event(store, 'b', 'b1', 'UserPromptSubmit', 2)
  event(store, 'a', 'new', 'UserPromptSubmit', 3)
  event(store, 'a', 'old', 'UserPromptSubmit', 4)
  event(store, 'a', 'old', 'Stop', 5)
  event(store, 'b', 'b1', 'Interrupt', 6)
  assert.equal(store.state('a').turnId, 'new')
  assert.equal(store.state('a', 'old').state, 'stopped')
  assert.equal(store.state('a', 'old').revision, 2)
  assert.equal(store.state('a', 'new').state, 'submitted')
  assert.equal(store.state('b').state, 'interrupted')
  assert.equal(store.state(null).sessionId, null)
})
test('only a fresh valid submit produces private widget guidance and no prompt content is stored', (t) => {
  const { dir, store } = setup(t)
  const script = join(projectRoot, 'dist/hooks/write.mjs')
  for (const [index, input] of [
    {
      session_id: 'A',
      turn_id: '1',
      hook_event_name: 'UserPromptSubmit',
      prompt: 'synthetic private sentence',
    },
    { session_id: 'A', turn_id: '1', hook_event_name: 'UserPromptSubmit' },
    { session_id: 'A', turn_id: '1', hook_event_name: 'Stop' },
    null,
  ].entries()) {
    const r = spawnSync(process.execPath, ['--no-warnings', script], {
      input: JSON.stringify(input),
      encoding: 'utf8',
      env: env(dir),
      timeout: 1500,
    })
    assert.equal(r.status, 0)
    const output = JSON.parse(r.stdout)
    if (index === 0) {
      assert.equal(output.hookSpecificOutput.hookEventName, 'UserPromptSubmit')
      assert.match(output.hookSpecificOutput.additionalContext, /show_waiting_picks.*turnId "1"/)
      assert.doesNotMatch(r.stdout, /synthetic private sentence/)
    } else assert.deepEqual(output, {})
  }
  assert.equal(store.state('A').state, 'stopped')
  assert.ok(
    !JSON.stringify(store.db.prepare('SELECT * FROM turn_state').all()).includes(
      'synthetic private sentence',
    ),
  )
})
test('unidentified panels require an explicit choice and cannot swap a bound identity', async (t) => {
  const { store } = setup(t),
    service = new Service(store, new Catalog(store))
  event(store, 'thread123456789', 'one', 'UserPromptSubmit')
  const session = service.panel(service.open({}).panel)
  assert.equal((await service.call(session, 'get_run_state', {})).state, 'unknown')
  const [item] = (await service.call(session, 'list_sessions', {})).items
  assert.equal(item.suffix, '23456789')
  assert.ok(!('sessionId' in item))
  await service.call(session, 'select_session', { choice: item.choice })
  assert.equal((await service.call(session, 'get_run_state', {})).turnId, 'one')
  await assert.rejects(service.call(session, 'list_sessions', {}))
})
test('closed, suffix, open, clamped, invalid and multisegment ranges', () => {
  for (const [header, expected] of [
    [undefined, null],
    ['bytes=1-3', [1, 3]],
    ['bytes=-3', [7, 9]],
    ['bytes=6-', [6, 9]],
    ['bytes=0-999', [0, 9]],
    ['bytes=-100', [0, 9]],
    ['bytes=-0', false],
    ['bytes=10-', false],
    ['bytes=4-2', false],
    ['bytes=0-1,4-5', false],
    ['bytes=-', false],
  ])
    assert.deepEqual(range(header, 10), expected)
})
test('loopback pairing, origin, Host, cookie, fixed-turn scope, replay and contiguous byte ranges', async (t) => {
  const { store } = setup(t),
    service = new Service(store, cachedCatalog(t, store)),
    web = new BrowserServer(service)
  defer(t, () => web.close())
  service.pair = (s) => web.pair(s)
  event(store, 'thread-a', 'turn1', 'UserPromptSubmit')
  const panel = service.panel(service.open({ thread_id: 'thread-a' }).panel)
  const link = await service.call(panel, 'create_browser_pairing', { follow: true, turnId: 'turn1' })
  const origin = new URL(link.url).origin,
    ticket = new URL(link.url).hash.slice(1)
  const post = (path, data, cookie = '', from = origin) =>
    fetch(origin + path, {
      method: 'POST',
      headers: { Origin: from, Cookie: cookie, 'Content-Type': 'application/json' },
      body: JSON.stringify(data),
    })
  assert.equal((await post('/exchange', { ticket }, '', 'https://example.org')).status, 403)
  const auth = await post('/exchange', { ticket })
  assert.equal(auth.status, 200)
  const cookie = auth.headers.get('set-cookie').split(';')[0],
    { page } = await auth.json()
  assert.equal((await post('/exchange', { ticket })).status, 403)
  assert.equal((await fetch(origin + page)).status, 401)
  const invalidHost = await new Promise((ok, fail) =>
    get(origin + page, { headers: { host: 'example.org', cookie } }, (r) => {
      r.resume()
      ok(r.statusCode)
    }).on('error', fail),
  )
  assert.equal(invalidHost, 403)
  assert.equal((await post(page + 'api/get_run_state', { turnId: 'turnX' }, cookie)).status, 403)
  assert.equal((await post(page + 'api/list_sessions', {}, cookie)).status, 403)
  assert.equal((await post(page + 'api/create_browser_pairing', { follow: false }, cookie)).status, 403)
  const media = origin + page + 'media/hg-101'
  assert.equal((await fetch(media, { headers: { Cookie: cookie } })).status, 403)
  assert.equal((await post(page + 'api/prepare_playback', { episodeId: 'hg-101' }, cookie)).status, 403)
  await post(page + 'api/get_episodes', { seriesId: 'hg-10' }, cookie)
  const ready = await post(page + 'api/prepare_playback', { episodeId: 'hg-101' }, cookie)
  assert.equal((await ready.json()).status, 'ready')
  const ref = readFileSync(avcFixture)
  for (const [start, end] of [
    [0, 55],
    [999, 1024],
  ]) {
    const res = await fetch(media, { headers: { Cookie: cookie, Range: 'bytes=' + start + '-' + end } })
    assert.equal(res.status, 206)
    assert.deepEqual(Buffer.from(await res.arrayBuffer()), ref.subarray(start, end + 1))
  }
  assert.equal((await fetch(media, { headers: { Cookie: cookie, Range: 'bytes=9999999-' } })).status, 416)
  assert.equal(
    (
      await post(
        page + 'api/save_progress',
        {
          seriesId: 'hg-10',
          episodeId: 'hg-101',
          title: '剧名',
          label: '首集',
          positionMs: 1234,
          durationMs: 14000,
        },
        cookie,
      )
    ).status,
    200,
  )
  assert.equal(store.history()[0].positionMs, 1234)
  const expired = await web.pair({})
  const stale = new URL(expired.url).hash.slice(1)
  web.tickets.get(stale).expires = 0
  assert.equal((await post('/exchange', { ticket: stale })).status, 403)
})
test('compiled MCP starts all installed providers and persists source selection across restarts', async t => {
  const { dir } = setup(t)
  const directory = join(dir, 'plugins'), local = join(directory, 'demo')
  mkdirSync(local, { recursive: true })
  writeFileSync(join(local, 'provider.json'), JSON.stringify({ apiVersion: 1, id: 'demo', name: 'Demo', version: '1.0.0', entry: 'index.mjs' }))
  writeFileSync(join(local, 'index.mjs'), `export function createProvider({id}) { return { id,
    async listSeries() { return {items:[],cursor:null} }, async getSeries() {},
    async listEpisodes() { return {items:[],cursor:null} }, async getCover() {}, async resolvePlayback() { return {candidates:[]} },
  } }`)
  async function start() {
    const client = new Client({ name: 'provider-config-test', version: '1' })
    await client.connect(new StdioClientTransport({ command: process.execPath,
      args: ['--no-warnings', join(projectRoot, 'dist/server/index.mjs')], env: { ...env(dir), HONGGUO_PROVIDERS_DIR: directory }, stderr: 'ignore' }))
    defer(t, () => client.close())
    const opened = await client.callTool({ name: 'open_drama_panel', arguments: {} })
    return { client, async call(name, args = {}) {
      const result = await client.callTool({ name, arguments: { panel: opened._meta.panel, ...args } })
      assert.ok(!result.isError)
      return result._meta.data
    } }
  }
  const first = await start()
  assert.deepEqual((await first.call('get_providers')).items.filter(p => p.available).map(p => p.id), ['hongguo', 'bilibili', 'demo'])
  await first.client.close()
  const second = await start()
  assert.deepEqual((await second.call('get_providers')).items.filter(p => p.available).map(p => p.id), ['hongguo', 'bilibili', 'demo'])
  await second.call('set_source', { source: 'demo' })
  await second.client.close()
  const third = await start()
  assert.deepEqual((await third.call('get_providers')).items.filter(p => p.available).map(p => p.id), ['hongguo', 'bilibili', 'demo'])
  assert.equal((await third.call('get_preferences')).defaultSource, 'demo')
})
test('compiled plugin exposes a model-visible waiting widget and keeps player controls app-only', async (t) => {
  let client
  const { dir } = setup(t)
  defer(t, () => client?.close())
  client = new Client({ name: 'test', version: '1' })
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: ['--no-warnings', join(projectRoot, 'dist/server/index.mjs')],
    env: env(dir),
    stderr: 'ignore',
  })
  await client.connect(transport)
  const { version } = JSON.parse(readFileSync(join(projectRoot, 'package.json'), 'utf8'))
  assert.equal(client.getServerVersion()?.version, version)
  const { tools } = await client.listTools()
  assert.deepEqual(tools.filter(t => t._meta.ui.visibility.includes('model')).map(t => t.name), ['show_waiting_picks'])
  assert.ok(tools.filter(t => t.name !== 'show_waiting_picks').every(t => t._meta.ui.visibility.join(',') === 'app'))
  assert.equal(tools.filter((tool) => tool._meta['openai/ui']?.entrypoints?.[0]?.type === 'thread').length, 1)
  assert.equal(tools.find(t => t.name === 'show_waiting_picks')._meta['openai/ui'].preferredModelDisplayMode, 'inline')
  const r = await client.callTool({ name: 'open_drama_panel', arguments: {}, _meta: { thread_id: 'A' } })
  assert.ok(typeof r._meta?.panel === 'string')
  assert.equal(r.structuredContent.identified, true)
  const data = await client.callTool({
    name: 'list_series',
    arguments: { panel: r._meta.panel, source: 'local' },
  })
  assert.equal(data.isError, true)
  const resources = (await client.listResources()).resources
  const playerUri = 'ui://hongguo/v38/player', waitingUri = 'ui://hongguo/v38/waiting'
  assert.equal(tools.find(t => t.name === 'show_waiting_picks')._meta.ui.resourceUri, waitingUri)
  assert.equal(tools.find(t => t.name === 'open_drama_panel')._meta.ui.resourceUri, playerUri)
  assert.deepEqual(resources.map(r => r.uri).sort(), [playerUri, waitingUri])
  const policy = { connectDomains: [], resourceDomains: ['blob:'] }
  for (const resource of resources) assert.deepEqual(resource._meta.ui.csp, policy)
  for (const uri of [playerUri, waitingUri, 'ui://hongguo/player', 'ui://hongguo/waiting',
    'ui://hongguo/v2/player', 'ui://hongguo/v2/waiting', 'ui://hongguo/v3/player', 'ui://hongguo/v3/waiting',
    'ui://hongguo/v4/player', 'ui://hongguo/v4/waiting', 'ui://hongguo/v5/player', 'ui://hongguo/v5/waiting',
    'ui://hongguo/v6/player', 'ui://hongguo/v6/waiting', 'ui://hongguo/v7/waiting',
    'ui://hongguo/v8/player', 'ui://hongguo/v9/waiting', 'ui://hongguo/v11/player', 'ui://hongguo/v12/waiting',
    'ui://hongguo/v16/player', 'ui://hongguo/v16/waiting', 'ui://hongguo/v17/player', 'ui://hongguo/v17/waiting',
    'ui://hongguo/v34/player', 'ui://hongguo/v34/waiting',
    'ui://hongguo/v35/player', 'ui://hongguo/v35/waiting',
    'ui://hongguo/v36/player', 'ui://hongguo/v36/waiting',
    'ui://hongguo/v37/player', 'ui://hongguo/v37/waiting',
    ...Array.from({ length: 16 }, (_, i) => [`ui://hongguo/v${i + 18}/player`, `ui://hongguo/v${i + 18}/waiting`]).flat()]) {
    const read = (await client.readResource({ uri })).contents[0]
    assert.equal(read.uri, uri)
    assert.deepEqual(read._meta.ui.csp, policy)
    assert.equal(read._meta['openai/widgetShowCodexWidgetInline'], uri.endsWith('/waiting') ? true : undefined)
  }
  const widget = (await client.readResource({ uri: waitingUri })).contents[0]
  assert.equal(widget._meta['openai/widgetHeightHint'], 96)
  assert.equal(widget._meta['openai/widgetMinFrameHeight'], 1)
  assert.doesNotMatch(widget.text, /id="mode"|Switch to manual playback to watch/)
  assert.deepEqual(widget._meta['openai/ui'], { availableDisplayModes: ['inline', 'fullscreen'], preferredDisplayMode: 'inline' })
  assert.match(widget.text, /<html[^>]*data-surface="waiting"/)
  const ui = await client.readResource({ uri: playerUri })
  assert.equal(ui.contents[0].mimeType, 'text/html;profile=mcp-app')
  assert.doesNotMatch(ui.contents[0].text, /自制样片|id="local"|video:\/\/hongguo\//)
  const preferences = patch => client.callTool({ name: 'set_preferences', arguments: { panel: r._meta.panel, ...patch } })
  await preferences({ hoverDecoyEnabled: true })
  assert.equal((await client.listTools()).tools.find(t => t.name === 'open_drama_panel')._meta.ui.resourceUri, playerUri)
  assert.deepEqual((await client.readResource({ uri: playerUri })).contents[0]._meta.ui.csp, policy)
  assert.doesNotMatch(ui.contents[0].text, /<iframe|decoyUrl|decoyFrameUrl|decoyWebsite|canEmbedDecoy|data-decoy-origin/)
  await assert.rejects(client.readResource({ uri: 'video://hongguo/tide' }))
  for (const [name, input] of [
    ['get_episodes', { seriesId: 'tide' }],
    ['prepare_playback', { episodeId: 'full-tide' }],
    ['create_browser_pairing', { follow: false, seriesId: 'ridge' }],
    [
      'save_progress',
      { seriesId: 'tide', episodeId: 'tide', title: '旧记录', label: '1', positionMs: 1, durationMs: 1000 },
    ],
  ]) {
    const denied = await client.callTool({ name, arguments: { panel: r._meta.panel, ...input } })
    assert.equal(denied.isError, true, name)
  }
})

test('self-created CENC sample decrypts from stdin and decodes video and audio', async (t) => {
  const { dir } = setup(t)
  const { remux, hasFfmpeg } = await import('../src/server/media.mjs')
  if (!hasFfmpeg()) {
    t.skip('FFmpeg unavailable')
    return
  }
  const raw = join(projectRoot, 'test/fixtures/encrypted.mp4'),
    out = join(dir, 'clear.mp4')
  assert.ok(readFileSync(raw).includes(Buffer.from('tenc')))
  // Published, deterministic test vector for this original one-second film only.
  const fixtureKey = Buffer.from(Array.from({ length: 16 }, (_, i) => i)).toString('hex')
  await remux(raw, out, 'h264', fixtureKey)
  const decode = (path) =>
    spawnSync(
      ffmpeg,
      ['-nostdin', '-v', 'error', '-xerror', '-i', path, '-map', '0:v', '-map', '0:a', '-f', 'null', '-'],
      { stdio: 'ignore', timeout: 5000 },
    ).status
  assert.notEqual(decode(raw), 0)
  assert.equal(decode(out), 0)
})

test('media preparation deduplicates across database connections and protects active files', async (t) => {
  let second
  const { store, dir } = setup(t)
  defer(t, () => second?.close())
  const { MediaCache, hasFfmpeg } = await import('../src/server/media.mjs')
  if (!hasFfmpeg()) {
    t.skip('FFmpeg unavailable')
    return
  }
  second = new Store(dir)
  let calls = 0
  const resolve = async () => {
    calls++
    return { candidates: [{ kind: 'file', url: 'https://media.byteimg.com/example.mp4', codec: 'h264' }] }
  }
  const bytes = readFileSync(avcFixture)
  t.mock.method(globalThis, 'fetch', async () => new Response(bytes))
  const first = new MediaCache(store, resolve, { maxFiles: 1 }),
    other = new MediaCache(second, resolve, { maxFiles: 1 })
  async function settled(cache, id) {
    for (let i = 0; i < 120; i++) {
      const r = cache.prepare(id)
      if (r.status !== 'preparing') return r
      await new Promise((ok) => setTimeout(ok, 30))
    }
    throw Error('媒体准备超时')
  }
  first.prepare('hg-1')
  other.prepare('hg-1')
  assert.equal((await settled(other, 'hg-1')).status, 'ready')
  assert.equal(calls, 1)
  assert.equal((await settled(first, 'hg-2')).status, 'error')
  assert.equal(other.prepare('hg-1').status, 'ready')
  store.db.prepare('UPDATE media SET hold_until=0 WHERE id=?').run('hg-1')
  first.prepare('hg-2', true)
  assert.equal((await settled(first, 'hg-2')).status, 'ready')
  assert.equal(store.db.prepare("SELECT count(*) AS n FROM media WHERE status='ready'").get().n, 1)
})
test('an inaccessible data directory reports failed persistence and cannot pretend to save progress', async (t) => {
  const { dir } = setup(t),
    fallback = new Store(dir, true)
  defer(t, () => fallback.close())
  const svc = new Service(fallback, new Catalog(fallback)),
    ctx = svc.panel(svc.open({}).panel)
  const health = await svc.call(ctx, 'get_health', {})
  assert.equal(health.database, false)
  assert.ok(!Object.hasOwn(health, 'fixture'))
  const progress = { seriesId: 'hg-10', episodeId: 'hg-101', title: '剧名', label: '1', positionMs: 0, durationMs: 1000 }
  await assert.rejects(svc.call(ctx, 'save_progress', progress), /不可写/)
  await assert.rejects(svc.call(ctx, 'get_run_state', {}))
  await assert.rejects(svc.call(ctx, 'set_preferences', { autoPauseOnFinish: false }), /不可写/)
})

test('history has one row per drama and removes all its episodes', (t) => {
  const { store } = setup(t)
  const base = { title: '测试', label: '分集', positionMs: 1000, durationMs: 120000 }
  store.save({ ...base, seriesId: 'hg-10', episodeId: 'hg-1' })
  store.save({ ...base, seriesId: 'hg-20', episodeId: 'hg-3' })
  store.save({ ...base, seriesId: 'hg-10', episodeId: 'hg-2' })
  assert.equal(store.history().length, 2)
  assert.equal(store.history('hg-10')[0].episodeId, 'hg-2')
  assert.equal(store.history('hg-10', 'hg-1')[0].positionMs, 1000)
  store.removeHistory('hg-10')
  assert.equal(store.history('hg-10', 'hg-1').length, 0)
  assert.deepEqual(
    store.history().map((row) => row.seriesId),
    ['hg-20'],
  )
})
test('upgrading removes only the old sample progress and ignores late writes from an older open panel', (t) => {
  let current
  const { dir, store: old } = setup(t)
  defer(t, () => current?.close())
  old.db.exec('PRAGMA user_version=0')
  const progress = { title: '剧名', label: '1', positionMs: 57000, durationMs: 120000 }
  old.save({ ...progress, seriesId: 'hg-10', episodeId: 'hg-101' })
  for (const name of ['tide', 'ridge']) old.save({ ...progress, seriesId: name, episodeId: name })
  current = new Store(dir)
  assert.equal(current.history('tide').length, 0)
  assert.equal(current.history('ridge').length, 0)
  old.save({ ...progress, seriesId: 'ridge', episodeId: 'full-ridge-hevc' })
  assert.deepEqual(
    current.history().map((row) => [row.seriesId, row.positionMs]),
    [['hg-10', 57000]],
  )
})
test('sparse feeds merge keyword results and reuse one cached request', async (t) => {
  const { store } = setup(t),
    catalog = new Catalog(store)
  let requests = 0
  catalog.sources.get('hongguo').sdkCall = async (method, ...args) => {
    requests++
    return {
      items: [
        {
          id: method === 'discover' ? '1' : String(requests),
          title: method === 'search' ? args[0] : '推荐',
          cover_url: 'https://cover.byteimg.com/a.jpg',
        },
      ],
    }
  }
  const [first, second] = await Promise.all([catalog.list({}), catalog.list({})])
  assert.equal(requests, 4)
  assert.deepEqual(first, second)
  assert.equal((await catalog.list()).items.length, 4)
  assert.equal(requests, 4)
})
test('search posters reuse known covers and lazily resolve missing details once through the normal converter', async t => {
  if (!hasFfmpeg()) return t.skip('FFmpeg unavailable')
  const { store } = setup(t), catalog = new Catalog(store)
  const jpeg = await runFfmpeg(['-f', 'lavfi', '-i', 'color=c=blue:s=24x32', '-frames:v', '1', '-f', 'image2pipe', '-c:v', 'mjpeg', 'pipe:1'], null, true)
  let details = 0, downloads = 0
  catalog.rows({ items: [{ id: '2', title: '缓存剧', coverURL: 'https://cover.byteimg.com/known.jpg' }] })
  t.mock.method(catalog.sources.get('hongguo'), 'sdkCall', async (method, id) => {
    if (method === 'search') return { items: [{ id: '1', title: '搜索剧' }, { id: '2', title: '缓存剧' }], has_more: true, cursor: 'more' }
    assert.equal(method, 'getSeries'); assert.equal(id, '1'); details++
    return { cover_url: 'https://cover.byteimg.com/detail.jpg' }
  })
  t.mock.method(globalThis, 'fetch', async url => {
    assert.equal(url.href, 'https://cover.byteimg.com/detail.jpg'); downloads++
    return new Response(jpeg)
  })
  const results = await catalog.list({ query: '剧' })
  assert.match(results.cursor, /^v1\./)
  assert.equal(results.items[0].lookupCover, true)
  assert.equal(results.items[1].hasCover, true)
  const posters = await Promise.all([catalog.cover('hg-1'), catalog.cover('hg-1')])
  assert.match(posters[0].cover, /^data:image\/jpeg;base64,/)
  assert.deepEqual(posters[0], posters[1])
  assert.deepEqual(await catalog.cover('hg-1'), posters[0])
  assert.equal(details, 1); assert.equal(downloads, 1)
})

test('empty or failed provider feeds cool down before retrying and never become a local show', async (t) => {
  const { store } = setup(t)
  const catalog = new Catalog(store)
  let now = 1000000
  catalog.metadata.now = () => now
  const provider = catalog.sources.get('hongguo')
  t.mock.method(provider, 'sdkCall', async () => ({ items: [] }))
  await assert.rejects(catalog.list(), { status: 503 })
  const requests = provider.sdkCall.mock.callCount()
  await assert.rejects(catalog.list(), { status: 503 })
  assert.equal(provider.sdkCall.mock.callCount(), requests)
  now = store.db.prepare('SELECT retry_at FROM catalog_cache').get().retry_at
  provider.sdkCall.mock.mockImplementation(async () => {
    throw Error('provider unavailable')
  })
  await assert.rejects(catalog.list(), { status: 503 })
  assert.deepEqual(store.waitingFeed(true), [])
  now = store.db.prepare('SELECT retry_at FROM catalog_cache').get().retry_at
  provider.sdkCall.mock.mockImplementation(async () => ({ items: [{ id: '17', title: '返回的剧名' }] }))
  assert.deepEqual((await catalog.list()).items.map((s) => s.id), ['hg-17'])
})
test('MCP full episode segments require the preparing panel and bounded offsets', async (t) => {
  const { store } = setup(t)
  if (!hasFfmpeg()) return t.skip('FFmpeg unavailable')
  const catalog = cachedCatalog(t, store)
  const run = t.mock.fn(runFfmpeg)
  catalog.panelMedia = new PanelMedia(store.root, run)
  defer(t, () => catalog.panelMedia.close())
  const svc = new Service(store, catalog)
  const a = svc.panel(svc.open({}).panel),
    b = svc.panel(svc.open({}).panel)
  const ep = { episodeId: 'hg-101' }
  await assert.rejects(svc.call(a, 'prepare_playback', ep))
  await svc.call(a, 'get_episodes', { seriesId: 'hg-10' })
  let r = await svc.call(a, 'prepare_playback', ep)
  for (let i = 0; r.status === 'preparing' && i < 120; i++) {
    await new Promise((ok) => setTimeout(ok, 20))
    r = await svc.call(a, 'prepare_playback', ep)
  }
  assert.equal(r.status, 'ready')
  assert.equal(r.codec, 'h264')
  const commands = hlsCommands(run)
  assert.equal(commands.length, 1)
  assert.equal(ffOption(commands[0], '-c'), 'copy')
  assert.equal(ffOption(commands[0], '-c:v'), undefined)
  assert.match(r.manifest, /#EXT-X-ENDLIST/)
  assert.match(r.manifest, /#EXT-X-MAP:URI="init\.mp4"/)
  assert.doesNotMatch(r.manifest, /https?:|file:/)
  const args = { ...ep, stream: r.stream, asset: 'init.mp4', offset: 0 }
  const chunk = await svc.call(a, 'read_panel_chunk', args)
  assert.ok(Buffer.from(chunk.bytes, 'base64').length <= 192 * 1024)
  assert.ok(Buffer.from(chunk.bytes, 'base64').includes(Buffer.from('avcC')))
  await assert.rejects(svc.call(b, 'read_panel_chunk', args))
  await assert.rejects(svc.call(a, 'read_panel_chunk', args, true))
  await assert.rejects(svc.call(a, 'read_panel_chunk', { ...args, asset: '../index.m3u8' }))
  await assert.rejects(svc.call(a, 'read_panel_chunk', { ...args, offset: chunk.size }))
})

test('a panel can decode its first fragment while the rest is still being prepared and refresh its manifest', async t => {
  const { store } = setup(t), source = join(store.root, 'longer.mp4')
  await runFfmpeg(['-stream_loop', '5', '-i', avcFixture, '-t', '6', '-c', 'copy', source])
  const catalog = cachedCatalog(t, store, source)
  let publish, finish
  const published = new Promise(resolve => { publish = resolve })
  const gate = new Promise(resolve => { finish = resolve })
  defer(t, () => finish())
  catalog.panelMedia = new PanelMedia(store.root, async (...args) => {
    const output = await runFfmpeg(...args)
    if (args[0].at(-1) === 'index.m3u8') {
      const path = join(args[3], 'index.m3u8'), complete = readFileSync(path, 'utf8')
      writeFileSync(path, complete.replace('#EXT-X-ENDLIST', ''))
      publish()
      await gate
      writeFileSync(path, complete)
    }
    return output
  })
  defer(t, () => catalog.panelMedia.close())
  const svc = new Service(store, catalog), scope = svc.panel(svc.open({}).panel), other = svc.panel(svc.open({}).panel)
  await svc.call(scope, 'get_episodes', { seriesId: 'hg-10' })
  assert.equal((await svc.call(scope, 'prepare_playback', { episodeId: 'hg-101' })).status, 'preparing')
  await published
  try {
    const ready = await svc.call(scope, 'prepare_playback', { episodeId: 'hg-101' })
    assert.equal(ready.status, 'ready')
    assert.ok(ready.durationMs > 0)
    assert.equal(catalog.panelMedia.entries.get('hg-101').pending, true)
    const args = { episodeId: 'hg-101', stream: ready.stream }
    assert.doesNotMatch((await svc.call(scope, 'read_panel_manifest', args)).manifest, /#EXT-X-ENDLIST/)
    await assert.rejects(svc.call(other, 'read_panel_manifest', args))
    await assert.rejects(svc.call(scope, 'read_panel_manifest', args, true))
    const entry = catalog.panelMedia.entries.get('hg-101')
    const fragment = join(store.root, 'first-fragment.mp4')
    writeFileSync(fragment, Buffer.concat(['init.mp4', ready.manifest.match(/seg\d{5}\.m4s/)[0]].map(asset => readFileSync(join(entry.dir, asset)))))
    await runFfmpeg(['-xerror', '-i', fragment, '-map', '0:v:0', '-map', '0:a:0', '-f', 'null', '-'])
    finish()
    await entry.job
    assert.match((await svc.call(scope, 'read_panel_manifest', args)).manifest, /#EXT-X-ENDLIST/)
  } finally { finish(); await catalog.panelMedia.entries.get('hg-101').job }
})

test('next-episode preload preserves the active stream and reuses real prepared fragments', async t => {
  const { store } = setup(t)
  const catalog = cachedCatalog(t, store)
  copyFileSync(avcFixture, catalog.cache.path('hg-102'))
  store.db.prepare("INSERT INTO media(id,status,codec) VALUES('hg-102','ready','h264')").run()
  catalog.episodes = async () => ({ items: [101, 102].map(id => ({ id: 'hg-' + id, playable: true })) })
  const run = t.mock.fn(runFfmpeg)
  catalog.panelMedia = new PanelMedia(store.root, run)
  defer(t, () => catalog.panelMedia.close())
  const svc = new Service(store, catalog), scope = svc.panel(svc.open({}).panel)
  await assert.rejects(svc.call(scope, 'preload_playback', { episodeId: 'hg-102' }), /请先选择/)
  await svc.call(scope, 'get_episodes', { seriesId: 'hg-10' })
  async function ready(method, id) {
    for (let i = 0; i < 120; i++) {
      const result = await svc.call(scope, method, { episodeId: id })
      if (result.status !== 'preparing') return result
      await new Promise(resolve => setTimeout(resolve, 20))
    }
    assert.fail('media preparation timed out')
  }
  const current = await ready('prepare_playback', 'hg-101')
  assert.deepEqual(await ready('preload_playback', 'hg-102'), { status: 'ready' })
  assert.equal(scope.playing, 'hg-101')
  assert.equal(scope.streams.get('hg-101'), current.stream)
  assert.equal(scope.streams.has('hg-102'), false)
  assert.ok((await svc.call(scope, 'read_panel_chunk', {
    episodeId: 'hg-101', stream: current.stream, asset: 'init.mp4', offset: 0,
  })).bytes)
  const built = run.mock.callCount()
  const next = await svc.call(scope, 'prepare_playback', { episodeId: 'hg-102', retry: true })
  assert.equal(next.status, 'ready')
  assert.equal(run.mock.callCount(), built, 'switching must reuse fragments without another FFmpeg job')
  scope.grants = new Set()
  assert.deepEqual(await svc.call(scope, 'preload_playback', { episodeId: 'hg-102' }, true), { status: 'ready' })
  assert.equal(scope.grants.size, 0, 'speculation must not grant browser media access')
})

test('speculative preparation cannot evict any pinned panel stream', t => {
  const { store } = setup(t), media = new PanelMedia(store.root)
  defer(t, () => media.close())
  for (let i = 0; i < 4; i++) media.entries.set('hg-' + i, {
    id: 'hg-' + i, dir: join(media.root, 'absent-' + i), used: Date.now() - 60000,
    pending: false, viewers: new Set([{}]),
  })
  assert.throws(() => media.prepare('hg-102', avcFixture, false, 'h264', true), /正忙/)
  assert.equal(media.entries.size, 4)
})

test('provider HEVC labels select H.264, copy AAC and discard partial hardware output before fallback', async (t) => {
  const { dir, store } = setup(t)
  // Keep the probed streams constant to verify that the cached provider label reaches the segmenter.
  const catalog = cachedCatalog(t, store)
  const partial = 'seg99999.m4s'
  const run = t.mock.fn(async (args, _input, capture, cwd) => {
    if (capture) return Buffer.from('#codec_id 0: h264\n#codec_id 1: aac\n')
    if (ffOption(args, '-c:v') !== 'libx264') {
      writeFileSync(join(cwd, partial), 'incomplete')
      throw Error('GPU unavailable')
    }
    assert.equal(existsSync(join(cwd, partial)), false)
    writeFileSync(join(cwd, 'index.m3u8'), '#EXTM3U\n#EXT-X-ENDLIST\n')
  })
  catalog.panelMedia = new PanelMedia(dir, run)
  defer(t, () => catalog.panelMedia.close())
  for (const [index, label] of ['bytevc1', 'hevc', 'h265'].entries()) {
    const id = 'hg-' + (200 + index)
    copyFileSync(avcFixture, catalog.cache.path(id))
    store.db.prepare("INSERT INTO media(id,status,codec) VALUES(?,'ready',?)").run(id, label)
    run.mock.resetCalls()
    assert.equal(catalog.prepare(id, false, false).status, 'preparing')
    assert.equal(catalog.prepare(id, false, false).status, 'preparing')
    await catalog.panelMedia.entries.get(id).job
    const ready = catalog.prepare(id, false, false)
    assert.equal(ready.status, 'ready')
    assert.equal(ready.codec, 'h264')
    const commands = hlsCommands(run)
    const encoders = commands.map(args => ffOption(args, '-c:v'))
    if (process.platform === 'darwin') assert.deepEqual(encoders, ['h264_videotoolbox', 'libx264'])
    assert.equal(encoders.at(-1), 'libx264')
    assert.equal(encoders.filter(encoder => encoder === 'libx264').length, 1)
    for (const args of commands) {
      assert.match(ffOption(args, '-c:v'), /^(h264_\w+|libx264)$/)
      assert.equal(ffOption(args, '-c'), undefined)
      assert.equal(ffOption(args, '-c:a'), 'copy')
    }
    assert.equal(catalog.prepare(id, true, false).codec, label)
  }
})

for (const video of ['hevc', 'h264']) {
  test('real ' + video + ' with ALAC produces decodable H.264/AAC fMP4 for the panel', async (t) => {
    if (!hasFfmpeg()) return t.skip('FFmpeg unavailable')
    const { dir, store } = setup(t)
    const source = join(dir, 'source.mp4')
    let fixtureVideo = ['-c:v', 'copy']
    if (video === 'hevc') {
      const encoders = spawnSync(ffmpeg, ['-hide_banner', '-encoders'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })
      if (!/\blibx265\b/.test(encoders.stdout)) return t.skip('libx265 unavailable to generate the HEVC fixture')
      fixtureVideo = ['-c:v', 'libx265', '-preset', 'ultrafast', '-x265-params', 'pools=1:frame-threads=1', '-tag:v', 'hvc1']
    }
    await runFfmpeg(['-i', avcFixture, '-t', '1', ...fixtureVideo, '-c:a', 'alac', source])
    // A legacy row may carry only the container label. Read the actual first video and audio tracks.
    const catalog = cachedCatalog(t, store, source, 'MP4')
    const run = t.mock.fn(runFfmpeg)
    catalog.panelMedia = new PanelMedia(dir, run)
    defer(t, () => catalog.panelMedia.close())
    assert.equal(catalog.prepare('hg-101', false, false).status, 'preparing')
    const entry = catalog.panelMedia.entries.get('hg-101')
    await entry.job
    const ready = catalog.prepare('hg-101', false, false)
    assert.equal(ready.codec, 'h264')
    const args = hlsCommands(run).at(-1)
    assert.equal(ffOption(args, '-c:a'), 'aac')
    if (video === 'hevc') assert.match(ffOption(args, '-c:v'), /^(h264_\w+|libx264)$/)
    else assert.equal(ffOption(args, '-c:v'), 'copy')
    assert.match(ready.manifest, /#EXT-X-MAP:URI="init\.mp4"/)
    assert.match(ready.manifest, /#EXT-X-ENDLIST/)
    const init = readFileSync(join(entry.dir, 'init.mp4'))
    assert.ok(init.includes(Buffer.from('avcC')) && init.includes(Buffer.from('mp4a')))
    assert.ok(!init.includes(Buffer.from('hvcC')) && !init.includes(Buffer.from('alac')))
    const decoded = spawnSync(ffmpeg, [
      '-nostdin', '-v', 'error', '-xerror', '-protocol_whitelist', 'file', '-i', join(entry.dir, 'index.m3u8'),
      '-map', '0:v:0', '-map', '0:a:0', '-f', 'null', '-',
    ], { stdio: 'ignore' })
    assert.equal(decoded.status, 0)
    assert.ok(readFileSync(source).equals(readFileSync(catalog.cache.path('hg-101'))))
  })
}
for (const kind of ['hls', 'dash'])
  test('real ' + kind + ' VOD segments remux with decodable audio and video', async (t) => {
    const { store, dir } = setup(t)
    const { MediaCache, hasFfmpeg } = await import('../src/server/media.mjs')
    if (!hasFfmpeg()) return t.skip('FFmpeg unavailable')
    const filename = kind === 'hls' ? 'test.m3u8' : 'test.mpd'
    const pack = spawnSync(
      ffmpeg,
      [
        '-nostdin',
        '-v',
        'error',
        '-i',
        avcFixture,
        '-map',
        '0:v',
        '-map',
        '0:a',
        '-c',
        'copy',
        '-f',
        kind,
        ...(kind === 'hls' ? ['-hls_playlist_type', 'vod', '-hls_time', '2'] : ['-seg_duration', '2']),
        filename,
      ],
      { cwd: dir, stdio: 'ignore' },
    )
    assert.equal(pack.status, 0)
    t.mock.method(globalThis, 'fetch', async (url) => {
      assert.equal(url.hostname, 'media.byteimg.com')
      return new Response(readFileSync(join(dir, url.pathname.slice(1))))
    })
    const cache = new MediaCache(store, async () => ({
      candidates: [{ kind, url: 'https://media.byteimg.com/' + filename, codec: 'h264' }],
    }))
    let r
    for (let i = 0; i < 120; i++) {
      r = cache.prepare('hg-1')
      if (r.status !== 'preparing') break
      await new Promise((ok) => setTimeout(ok, 20))
    }
    assert.equal(r.status, 'ready', r.reason)
    assert.equal(
      spawnSync(
        ffmpeg,
        [
          '-nostdin',
          '-v',
          'error',
          '-xerror',
          '-i',
          cache.path('hg-1'),
          '-map',
          '0:v',
          '-map',
          '0:a',
          '-f',
          'null',
          '-',
        ],
        { stdio: 'ignore' },
      ).status,
      0,
    )
  })
test('CDN checks nested destinations and verifies the requested byte range', async (t) => {
  const { cdn } = await import('../src/server/media.mjs')
  let requests = 0
  t.mock.method(globalThis, 'fetch', async (_url, opts) => {
    requests++
    assert.equal(opts.headers.Range, 'bytes=2-5')
    return new Response('bad response', { status: 200 })
  })
  await assert.rejects(cdn('http://127.0.0.1/oops', 128, 2000), /域名/)
  assert.equal(requests, 0)
  await assert.rejects(
    cdn('https://media.byteimg.com/sample', 128, 2000, 0, { offset: 2, length: 4 }),
    /失效/,
  )
})
