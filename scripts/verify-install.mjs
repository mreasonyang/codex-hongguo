// Exercise the installed copy in a disposable CLI profile, including paths with spaces.
import { mkdtemp, mkdir, rm, readFile, writeFile, access, realpath } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fork } from 'node:child_process'
import { spawnSync, spawn, findExecutable, stopChild } from '../src/runtime/executables.mjs'
import { dataRoot } from '../src/server/paths.mjs'
import { createInterface } from 'node:readline'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { Store } from '../src/server/store.mjs'
import { marketplace, npmPackageName } from './distribution.mjs'

const tmp = await realpath(await mkdtemp(join(tmpdir(), '红果 安装 ')))
const root = join(tmp, '本地 市场'),
  profile = join(tmp, '独立配置')
const npmMarket = join(tmp, 'npm 市场')
const version = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8')).version
const playerUri = 'ui://hongguo/v15/player', waitingUri = 'ui://hongguo/v15/waiting'
const commands = Object.fromEntries(['npm', 'codex', 'openssl'].map(name => [name, findExecutable(name)]))
const env = {
  HOME: tmp,
  USERPROFILE: tmp,
  APPDATA: tmp,
  LOCALAPPDATA: tmp,
  CODEX_HOME: profile,
  HONGGUO_DATA_DIR: join(tmp, 'data'),
  PATH: process.env.PATH || process.env.Path,
  ...Object.fromEntries(['SystemRoot', 'WINDIR', 'ComSpec', 'PATHEXT', 'ProgramFiles', 'ProgramW6432'].filter(key => process.env[key]).map(key => [key, process.env[key]])),
  TEMP: tmp,
  TMP: tmp,
  HONGGUO_NODE: process.execPath,
  HONGGUO_CODEX: commands.codex,
  npm_config_cafile: join(tmp, 'registry.crt'),
  npm_config_cache: join(tmp, 'npm-cache'),
  // Preview-only qualification: published npm metadata stays gated until Windows desktop acceptance.
  ...(process.platform === 'win32' ? { npm_config_force: 'true' } : {}),
  NODE_EXTRA_CA_CERTS: join(tmp, 'registry.crt'),
}
function run(bin, args) {
  const r = spawnSync(commands[bin] || bin, args, { cwd: root, env, stdio: ['ignore', 'pipe', 'ignore'], encoding: 'utf8', timeout: bin === 'npm' ? 420000 : 120000, windowsHide: true })
  assert.equal(r.status, 0, '隔离安装步骤失败 ' + args.slice(0, 2).join(' '))
  return r.stdout
}
let child, registry
try {
  await mkdir(profile)
  await mkdir(root, { recursive: true })
  const trap = join(tmp, 'no-system-ffmpeg')
  await mkdir(trap)
  env.HONGGUO_FORBIDDEN_FFMPEG = join(tmp, 'system-ffmpeg-was-used')
  await writeFile(join(trap, process.platform === 'win32' ? 'ffmpeg.cmd' : 'ffmpeg'), process.platform === 'win32'
    ? '@echo off\r\necho used>"%HONGGUO_FORBIDDEN_FFMPEG%"\r\nexit /b 91\r\n'
    : '#!/bin/sh\nprintf used > "$HONGGUO_FORBIDDEN_FFMPEG"\nexit 91\n', { mode: 0o755 })
  env.PATH = trap + (process.platform === 'win32' ? ';' : ':') + env.PATH
  const cert = spawnSync(commands.openssl, ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1',
    '-keyout', join(tmp, 'registry.key'), '-out', join(tmp, 'registry.crt'),
    '-subj', '/CN=127.0.0.1', '-addext', 'subjectAltName=IP:127.0.0.1'], { stdio: 'ignore', timeout: 15000 })
  assert.equal(cert.status, 0, '无法生成临时测试仓库证书')
  const metadata = JSON.parse(await readFile(resolve('release/package-metadata.json'), 'utf8'))
  assert.equal(metadata.name, npmPackageName)
  assert.equal(metadata.version, version)
  const archivePath = resolve('release', metadata.filename)
  registry = fork(new URL('./test-registry.mjs', import.meta.url), [tmp, archivePath, version, npmPackageName], { stdio: ['ignore', 'ignore', 'ignore', 'ipc'] })
  const { origin } = await new Promise((ok, fail) => {
    const timer = setTimeout(() => fail(Error('临时 npm 仓库启动超时')), 5000)
    registry.once('message', message => { clearTimeout(timer); ok(message) })
    registry.once('error', () => { clearTimeout(timer); fail(Error('临时 npm 仓库启动失败')) })
  })
  await mkdir(join(npmMarket, '.agents/plugins'), { recursive: true })
  await writeFile(join(npmMarket, '.agents/plugins/marketplace.json'), JSON.stringify(marketplace(version, { source: 'npm', package: npmPackageName, version, registry: origin })))
  const defaultData = dataRoot({ env: { ...env, HONGGUO_DATA_DIR: undefined }, home: tmp })
  env.HONGGUO_DATA_DIR = defaultData
  const setupOutput = run('npm', ['exec', '--yes', '--registry', origin, '--package', npmPackageName + '@' + version, '--', 'codex-hongguo', 'setup', '--marketplace', npmMarket])
  assert.match(setupOutput, /审查.*信任.*UserPromptSubmit.*Stop.*Interrupt/, '安装完成时必须明确告知 Hooks 信任步骤')
  commands.ffmpeg = findExecutable('ffmpeg', undefined, { env, home: tmp })
  assert.ok(commands.ffmpeg.startsWith(tmp), '播放组件必须位于隔离用户缓存')
  await access(commands.ffmpeg)
  await assert.rejects(access(env.HONGGUO_FORBIDDEN_FFMPEG), '不应调用系统 FFmpeg')
  const seeded = new Store(defaultData)
  seeded.save({ seriesId: 'hg-987654321', episodeId: 'hg-987654322', title: '安装验收进度', label: '2', positionMs: 12345, durationMs: 60000 })
  seeded.setPreferences({ autoPrompt: true, searchTerms: ['总裁', '重生', '逆袭'] })
  seeded.setSetupDismissed(true)
  seeded.close()
  run('npm', ['exec', '--yes', '--registry', origin, '--package', npmPackageName + '@' + version, '--', 'codex-hongguo', 'setup', '--marketplace', npmMarket])
  console.log('全新 npm 安装、播放组件自动准备和重复安装通过，未调用系统 FFmpeg')
  child = spawn(commands.codex, ['app-server'], { cwd: root, env, stdio: ['pipe', 'pipe', 'ignore'], windowsHide: true })
  const requests = new Map()
  createInterface({ input: child.stdout }).on('line', (line) => {
    let msg
    try {
      msg = JSON.parse(line)
    } catch {
      return
    }
    const finish = requests.get(msg.id)
    if (finish) {
      requests.delete(msg.id)
      finish(msg)
    }
  })
  let id = 0
  const rpc = (method, params, timeoutMs = 15000) =>
    new Promise((ok, fail) => {
      const key = ++id
      const timeout = setTimeout(() => {
        requests.delete(key)
        fail(Error('响应超时 ' + method))
      }, timeoutMs)
      requests.set(key, (msg) => {
        clearTimeout(timeout)
        if (msg.error) fail(Error('请求失败 ' + method))
        else ok(msg.result)
      })
      child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: key, method, params }) + '\n')
    })
  await rpc('initialize', {
    clientInfo: { name: 'hongguo-test', version: '1' },
    capabilities: { experimentalApi: true },
  })
  child.stdin.write('{"jsonrpc":"2.0","method":"initialized"}\n')
  const detail = (
    await rpc('plugin/read', {
      marketplacePath: join(npmMarket, '.agents/plugins/marketplace.json'),
      pluginName: 'codex-hongguo',
    })
  ).plugin
  assert.equal(detail.onboardingSkill?.name?.split(':').at(-1), 'hongguo-setup', '宿主未识别安装后的设置引导')
  assert.equal(detail.onboardingSkill.enabled, true)
  const installedRoot = resolve(dirname(detail.onboardingSkill.path), '../..')
  await access(join(installedRoot, 'bin/run-node'))
  await access(join(installedRoot, 'bin/run-node.exe'))
  await access(join(installedRoot, 'dist/vendor/openhongguo/dist/openhongguo.wasm'))
  await assert.rejects(access(join(installedRoot, 'node_modules')))
  const checked = spawnSync(process.execPath, [join(installedRoot, 'dist/setup/check.mjs')], {
    cwd: root, env, encoding: 'utf8', timeout: 15000, stdio: ['ignore', 'pipe', 'ignore'],
  })
  assert.equal(checked.status, 0, '安装副本的设置检查未完成')
  const setup = JSON.parse(checked.stdout)
  assert.equal(setup.manualReady, true)
  assert.equal(setup.followReady, false, '隔离配置中尚未信任的 Hooks 不应显示已配置')
  console.log('宿主已识别设置引导，安装副本检查通过，未信任的回合联动保持待配置')
  console.log(
    '安装状态',
    detail.summary.installed,
    detail.summary.enabled,
    '声明的服务',
    detail.mcpServers?.length,
    '声明的 hooks',
    detail.hooks?.length,
  )
  const thread = await rpc('thread/start', { cwd: root, ephemeral: true })
  let status
  for (let attempt = 0; attempt < 8; attempt++) {
    status = await rpc('mcpServerStatus/list', { threadId: thread.thread.id })
    if (status.data.some((item) => item.name.includes('hongguo') && item.resources?.length)) break
    await new Promise((ok) => setTimeout(ok, 350))
  }
  const server = status.data.find((item) => item.name.includes('hongguo'))
  console.log(
    '安装副本',
    !!server,
    '已发现工具',
    Object.keys(server?.tools || {}).length,
    'UI 资源',
    server?.resources?.some((r) => r.uri === playerUri) || false,
  )
  assert.ok(
    server?.resources?.some((r) => r.uri === playerUri),
    '插件未成功启动或未注册资源',
  )
  assert.deepEqual(server.resources.map((r) => r.uri).sort(), [playerUri, waitingUri])
  assert.deepEqual(Object.values(server.tools).filter(t => t._meta?.ui?.visibility?.includes('model')).map(t => t.name),
    ['show_waiting_picks'])
  const entry = Object.values(server.tools).find((t) => t.name === 'open_drama_panel')
  assert.deepEqual(
    entry?._meta?.['openai/ui']?.entrypoints?.map((e) => e.type),
    ['thread', 'global'],
  )
  const hostCall = (tool, args, timeoutMs) =>
    rpc('mcpServer/tool/call', { threadId: thread.thread.id, server: server.name, tool, arguments: args }, timeoutMs)
  const event = (name, turnId) => {
    const launcher = join(installedRoot, 'bin', process.platform === 'win32' ? 'run-node.exe' : 'run-node')
    const result = spawnSync(launcher, ['hook'], {
      cwd: root, env, encoding: 'utf8', timeout: 2000, stdio: ['pipe', 'pipe', 'ignore'],
      input: JSON.stringify({ session_id: thread.thread.id, turn_id: turnId, hook_event_name: name }),
    })
    assert.equal(result.status, 0)
    return JSON.parse(result.stdout)
  }
  const turnId = 'installation-probe'
  assert.match(event('UserPromptSubmit', turnId).hookSpecificOutput.additionalContext, /show_waiting_picks/)
  const hostIdentity = await hostCall('open_drama_panel', {})
  console.log('宿主直接调用时传入可辨认的会话', hostIdentity.structuredContent?.identified === true)
  const card = await hostCall('show_waiting_picks', { turnId })
  assert.equal(card.structuredContent?.shown, true, '宿主传入的会话与提交事件未匹配')
  assert.equal((await hostCall('show_waiting_picks', { turnId })).structuredContent?.shown, false)
  const cardCall = (tool, args = {}) => hostCall(tool, { ...args, panel: card._meta.panel }, 90000)
  const picks = (await cardCall('get_waiting_picks'))._meta?.data?.items
  assert.ok(picks?.length > 0 && picks.length <= 3 && picks.every(item => /^hg-\d+$/.test(item.id) && item.title))
  assert.deepEqual((await cardCall('get_waiting_picks'))._meta?.data?.items, picks)
  assert.equal((await cardCall('mark_waiting_picks_shown'))._meta?.data?.recorded, true)
  assert.equal((await cardCall('mark_waiting_picks_shown'))._meta?.data?.recorded, false)
  await cardCall('select_waiting_pick', { seriesId: picks[0].id })
  const selected = (await cardCall('activate_waiting_player'))._meta?.data
  assert.equal(selected?.play, true)
  await cardCall('confirm_waiting_playback', { playbackId: selected.playbackId })
  assert.equal((await cardCall('activate_waiting_player'))._meta?.data?.play, false)
  assert.deepEqual(event('Stop', turnId), {})
  assert.equal((await cardCall('get_run_state'))._meta?.data?.state, 'stopped')
  event('UserPromptSubmit', 'installation-interrupt')
  assert.deepEqual(event('Interrupt', 'installation-interrupt'), {})
  assert.equal((await hostCall('get_run_state', { panel: card._meta.panel, observeSession: true }))._meta?.data?.state, 'interrupted')
  const waiting = await rpc('mcpServer/resource/read', { threadId: thread.thread.id, server: server.name, uri: waitingUri })
  assert.deepEqual(waiting.contents[0]._meta.ui.csp, { connectDomains: [], resourceDomains: ['blob:'] })
  assert.equal(waiting.contents?.[0]?._meta?.['openai/ui']?.preferredDisplayMode, 'inline')
  assert.equal(waiting.contents[0]._meta['openai/widgetShowCodexWidgetInline'], true)
  console.log('安装副本通过真实宿主协议匹配会话、展示候选、单次领取播放及停止事件检查，返回剧目数', picks.length)
  const opened = await hostCall('open_drama_panel', {})
  assert.ok(!opened.isError && typeof opened._meta?.panel === 'string', '打开播放器失败')
  const history = await hostCall('get_history', { panel: opened._meta.panel })
  assert.equal(history._meta?.data?.items?.find(row => row.seriesId === 'hg-987654321')?.positionMs, 12345, '重复安装后观看进度丢失')
  const firstSetup = await hostCall('get_setup_status', { panel: opened._meta.panel })
  assert.equal(firstSetup._meta?.data?.dismissed, true, '重复安装后引导设置丢失')
  assert.notEqual(firstSetup._meta.data.hooks.status, 'ready')
  assert.ok(firstSetup._meta.data.hooks.events.every(event => event.status !== 'ready'))
  const dismissed = await hostCall('set_setup_dismissed', { panel: opened._meta.panel, dismissed: true })
  assert.equal(dismissed._meta?.data?.dismissed, true)
  const nextSetup = await hostCall('get_setup_status', { panel: opened._meta.panel })
  assert.equal(nextSetup._meta?.data?.dismissed, true)
  assert.notEqual(nextSetup._meta.data.hooks.status, 'ready')
  const listed = await hostCall('list_series', { panel: opened._meta.panel }, 90000)
  const shows = listed._meta?.data?.items
  assert.ok(shows?.length && shows.every((s) => /^hg-\d+$/.test(s.id) && s.title), '未取得真实红果片库')
  const nextTurn = 'rotation-probe'
  event('UserPromptSubmit', nextTurn)
  const secondCard = await hostCall('show_waiting_picks', { turnId: nextTurn })
  const nextPicks = (await hostCall('get_waiting_picks', { panel: secondCard._meta.panel }, 90000))._meta?.data?.items
  assert.ok(nextPicks?.length)
  if (shows.length >= 6) assert.equal(nextPicks.filter(p => p.id !== 'hg-987654321' && picks.some(old => old.id === p.id)).length, 0)
  console.log('隔离安装的两轮推荐', [picks, nextPicks].map(rows => rows.map(row => row.title).join('、')).join(' → '))
  event('Stop', nextTurn)
  const episodes = await hostCall('get_episodes', { panel: opened._meta.panel, seriesId: shows[0].id }, 90000)
  assert.ok(episodes._meta?.data?.items?.some((ep) => /^hg-\d+$/.test(ep.id)), '未取得真实红果分集')
  if (process.argv.includes('--playback')) {
    const episodeId = episodes._meta.data.items[0].id
    let prepared
    const deadline = Date.now() + 120000
    do {
      const reply = await hostCall('prepare_playback', { panel: opened._meta.panel, episodeId }, 15000)
      assert.ok(!reply.isError, '真实分集准备失败')
      prepared = reply._meta?.data
      if (prepared?.status === 'ready') break
      await new Promise(resolve => setTimeout(resolve, 500))
    } while (Date.now() < deadline)
    assert.equal(prepared?.status, 'ready', '真实分集准备超时')
    const segment = prepared.manifest.match(/seg\d{5}\.m4s/)?.[0]
    assert.ok(segment, '分集缺少可播放分段')
    const buffers = []
    for (const asset of ['init.mp4', segment]) {
      let offset = 0, size
      do {
        const reply = await hostCall('read_panel_chunk', { panel: opened._meta.panel, episodeId, stream: prepared.stream, asset, offset })
        assert.ok(!reply.isError, '分集分段读取失败')
        const chunk = reply._meta?.data
        const bytes = Buffer.from(chunk.bytes, 'base64')
        assert.ok(bytes.length > 0 && chunk.size <= 32 * 1024 * 1024)
        buffers.push(bytes); offset += bytes.length; size = chunk.size
      } while (offset < size)
    }
    const fragment = join(tmp, 'first-fragment.mp4')
    await writeFile(fragment, Buffer.concat(buffers))
    const decoded = spawnSync(commands.ffmpeg, ['-v', 'error', '-i', fragment, '-f', 'null', '-'], { stdio: 'ignore', timeout: 20000 })
    assert.equal(decoded.status, 0, '真实 npm 安装副本的音视频分段无法解码')
    console.log('真实分集经 npm 安装副本准备、MCP 分段传输与 FFmpeg 解码通过')
  }
  const resource = await rpc('mcpServer/resource/read', {
    threadId: thread.thread.id,
    server: server.name,
    uri: playerUri,
  })
  assert.deepEqual(resource.contents[0]._meta.ui.csp, { connectDomains: [], resourceDomains: ['blob:'] })
  assert.ok(resource.contents?.[0]?.text?.includes('id="fullscreen"'))
  assert.match(resource.contents[0].text, /class="setupHooks">[^<]*审查、信任并启用[^<]*UserPromptSubmit/,
    '安装副本必须包含明确的 Hooks 信任指南')
  assert.doesNotMatch(resource.contents[0].text, /自制样片|id="local"|video:\/\/hongguo\//)
  console.log(
    '两个入口、真实红果片库、分集和播放器资源通过安装验证。已识别会话',
    !!opened.structuredContent?.identified,
  )
  const hooks = await rpc('hooks/list', { cwds: [root] })
  const expected = ['UserPromptSubmit', 'Stop', 'Interrupt']
  const entries = hooks.data.flatMap((row) => row.hooks).filter((h) => h.pluginId?.includes('codex-hongguo'))
  assert.ok(
    expected.every((s) => entries.some((h) => h.eventName.toLowerCase() === s.toLowerCase())),
    '插件 hooks 未全部发现',
  )
  console.log('已发现三个待审查事件')
  stopChild(child)
  child = undefined
  const cachedMedia = join(defaultData, 'media', 'uninstall-delete.mp4')
  await mkdir(dirname(cachedMedia), { recursive: true })
  await writeFile(cachedMedia, 'uninstall-cache-sentinel')
  await mkdir(join(defaultData, 'panel-media'), { recursive: true })
  await writeFile(join(defaultData, 'panel-media', 'partial-fragment'), 'panel fragment')
  await mkdir(join(defaultData, 'device'), { recursive: true })
  await writeFile(join(defaultData, 'device', 'uninstall-sentinel'), 'anonymous device data')
  // Removal must not execute or change an externally configured component.
  env.HONGGUO_FFMPEG = join(tmp, 'external-ffmpeg')
  await writeFile(env.HONGGUO_FFMPEG, 'external-executable-sentinel')
  const uninstall = ['exec', '--yes', '--registry', origin, '--package', npmPackageName + '@' + version, '--', 'codex-hongguo', 'uninstall']
  run('npm', [...uninstall, '--dry-run'])
  await access(commands.ffmpeg)
  await access(cachedMedia)
  const progress = new Store(defaultData)
  try {
    assert.equal(progress.history().find(row => row.seriesId === 'hg-987654321').positionMs, 12345)
    assert.equal(progress.preferences().autoPrompt, true)
    assert.deepEqual(progress.preferences().searchTerms, ['总裁', '重生', '逆袭'])
  } finally { progress.close() }
  const installed = () => {
    const result = spawnSync(commands.codex, ['plugin', 'list', '--marketplace', 'hongguo-local', '--json'], { cwd: root, env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 15000 })
    assert.equal(result.status, 0, '无法检查隔离插件注册')
    return JSON.parse(result.stdout).installed.some(plugin => plugin.pluginId === 'codex-hongguo@hongguo-local')
  }
  assert.equal(installed(), true, '卸载预览不应移除插件')
  const componentRoot = resolve(dirname(commands.ffmpeg), '../..')
  await writeFile(commands.ffmpeg, 'broken-owned-component')
  await rm(commands.ffmpeg + '.json')
  await mkdir(join(componentRoot, 'old-version'), { recursive: true })
  await writeFile(join(componentRoot, 'old-version', 'unfinished.archive'), 'partial download')
  run('npm', uninstall)
  assert.equal(installed(), false, 'npx 卸载后插件不应仍在已安装列表中')
  await assert.rejects(access(defaultData), '卸载后应删除整个默认用户数据目录，包括进度、设置、视频缓存和设备档案')
  await assert.rejects(access(componentRoot), '应清空组件专属目录，包括损坏文件、未知版本与下载残片')
  assert.equal(await readFile(env.HONGGUO_FFMPEG, 'utf8'), 'external-executable-sentinel')
  run('npm', uninstall)
  console.log('npx 完整卸载、预览和重复卸载通过；组件、进度、设置、视频缓存和设备档案均已删除，外部程序未受影响')
  await assert.rejects(access(env.HONGGUO_FORBIDDEN_FFMPEG), '不应调用系统 FFmpeg')
  const sha256 = createHash('sha256').update(await readFile(archivePath)).digest('hex')
  await writeFile(resolve('release/verification.json'), JSON.stringify({
    name: npmPackageName, version, installation: 'fresh', sha256,
    platform: process.platform, arch: process.arch, windowsPreview: process.platform === 'win32',
    checkedAt: new Date().toISOString(),
    checks: ['npx-setup', 'fresh-install', 'repeat-setup', 'native-npm-source', 'progress-preserved', 'managed-ffmpeg-without-system-install', 'hook-review-required', 'installation-trust-instructions', 'packaged-trust-guide', 'launcher-stdin', 'hook-stop', 'hook-interrupt', 'host-mcp', 'live-catalog', 'npx-uninstall', 'uninstall-dry-run', 'repeat-uninstall', 'uninstall-without-media-runtime', 'uninstall-cleans-component-directory-and-partial-downloads', 'uninstall-preserves-external-executables', 'uninstall-deletes-all-local-data'],
    mediaDecoded: process.argv.includes('--playback'), desktopPlaybackObserved: false,
  }, null, 2) + '\n')
} finally {
  stopChild(child)
  stopChild(registry)
  await rm(tmp, { force: true, recursive: true, maxRetries: 10, retryDelay: 100 })
}
