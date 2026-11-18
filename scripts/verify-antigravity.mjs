// Validate the packaged Antigravity adapter without changing the user's app
// configuration, requiring an account, or making model requests.
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, rm, readFile, writeFile, copyFile, chmod, access, realpath } from 'node:fs/promises'
import { constants } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { manageAntigravity } from '../src/cli/antigravity.mjs'
import { Store } from '../src/server/store.mjs'
import { ensureFfmpeg, ffmpegPath, registerFfmpegHost, removeManagedFfmpeg } from '../src/runtime/ffmpeg-runtime.mjs'
import { removeUserData } from '../src/runtime/uninstall-data.mjs'
import { installSharedProgram, removeSharedProgram } from '../src/runtime/shared-program.mjs'
import { codex, antigravity } from '../src/runtime/host.mjs'

const sourceRoot = resolve('release/npm/codex-hongguo')
const pkg = JSON.parse(await readFile(join(sourceRoot, 'package.json'), 'utf8'))
const htmlHash = createHash('sha256').update(await readFile(join(sourceRoot, 'dist/ui/player.html'))).digest('hex')
const root = await realpath(await mkdtemp(join(tmpdir(), 'hongguo-agy-verification-')))
const configRoot = join(root, 'config'), data = join(root, 'data')
const sourceFfmpeg = await ensureFfmpeg({ env: { ...process.env, HONGGUO_FFMPEG: undefined } })
// Use an isolated managed runtime without an executable override. Every App
// process inherits the opposite identity; only the fixed entrypoint is valid.
const env = { ...process.env, HONGGUO_HOST: 'codex', HONGGUO_DATA_DIR: join(root, 'codex-data'), HONGGUO_ANTIGRAVITY_DATA_DIR: data, HONGGUO_FFMPEG: '', HONGGUO_PROGRAM_DIR: join(root, '程序 program'), HONGGUO_RUNTIME_DIR: join(root, 'runtime') }
const ffmpeg = ffmpegPath({ host: antigravity, env })
const destination = join(configRoot, 'plugins/codex-hongguo')
const options = { sourceRoot, configRoot, env, home: root, log() {},
  prepare: options => ensureFfmpeg({ ...options, env }),
  register: options => registerFfmpegHost({ ...options, env }),
}
let client
try {
  await mkdir(dirname(ffmpeg), { recursive: true })
  await copyFile(sourceFfmpeg, ffmpeg, constants.COPYFILE_FICLONE)
  await copyFile(sourceFfmpeg + '.json', ffmpeg + '.json')
  await chmod(ffmpeg, 0o755)
  const program = await installSharedProgram({ sourceRoot, host: codex, env }, () => registerFfmpegHost({ host: codex, env }))
  await manageAntigravity('setup', options)
  for (const file of ['bin/run-node', 'bin/run-node.exe', 'bin/run-node-arm64.exe', 'dist/launcher', 'dist/ui', 'dist/vendor', 'provider-kit'])
    await assert.rejects(access(join(destination, file)), { code: 'ENOENT' })
  assert.deepEqual(await readFile(join(program.programRoot, 'dist/ui/player.html')), await readFile(join(sourceRoot, 'dist/ui/player.html')))
  const activeProgram = async () => join(program.programHome, JSON.parse(await readFile(join(program.programHome, 'current.json'), 'utf8')).directory)
  assert.equal(await activeProgram(), program.programRoot)
  const cli = join(destination, 'bin/codex-hongguo.mjs'), provider = join(root, 'provider')
  const run = (args, input, runEnv = env) => execFileSync(process.execPath, args, { env: runEnv, input, encoding: 'utf8', timeout: 30000, stdio: ['pipe', 'pipe', 'pipe'] })
  // The installed CLI has a fixed App default, including Provider subprocesses.
  const doctor = JSON.parse(run([cli, 'doctor']))
  assert.equal(doctor.manualReady, true)
  assert.deepEqual(doctor.hooks.events.map(e => e.event), ['PreInvocation', 'Stop'])
  const explicit = JSON.parse(run([cli, 'doctor', '--host', 'codex'], undefined, { ...env, HONGGUO_FFMPEG: sourceFfmpeg }))
  assert.deepEqual(explicit.hooks.events.map(e => e.event), ['userPromptSubmit', 'stop', 'interrupt'])
  run([cli, 'provider', 'create', provider, '--id', 'agy-sample'])
  run([cli, 'provider', 'install', provider])
  const providerReport = JSON.parse(run([cli, 'provider', 'doctor', '--installed', 'agy-sample', '--query', 'Sample']))
  assert.equal(providerReport.ok, true)
  assert.equal(providerReport.stages.decode.status, 'passed')
  assert.equal(providerReport.stages.audio.status, 'passed')
  const store = new Store(data)
  store.setPreferences({ defaultSource: 'agy-sample' })
  store.close()
  const mcp = JSON.parse(await readFile(join(destination, 'mcp_config.json'), 'utf8')).mcpServers.hongguo
  client = new Client({ name: 'Antigravity adapter verification', version: '1' })
  await client.connect(new StdioClientTransport({ command: mcp.command,
    args: mcp.args.map(arg => arg.replaceAll('${PLUGIN_ROOT}', destination)), env, stderr: 'pipe' }))
  const tools = (await client.listTools()).tools
  const entry = tools.find(tool => tool.name === 'open_drama_panel')
  assert.deepEqual(entry._meta['com.google.antigravity/ui'].entrypoints.map(e => e.type), ['aux_pane', 'global'])
  assert.deepEqual(entry._meta.ui.visibility, ['app'])
  const resource = await client.readResource({ uri: entry._meta.ui.resourceUri })
  assert.equal(resource.contents[0].mimeType, 'text/html;profile=mcp-app')
  assert.ok(Buffer.byteLength(resource.contents[0].text) < 10 * 1024 * 1024)
  const manifestHooks = JSON.parse(await readFile(join(destination, 'hooks.json'), 'utf8')).hongguo
  const hook = (kind, payload) => {
    const command = manifestHooks[kind === 'start' ? 'PreInvocation' : 'Stop'][0].command
    const windows = process.platform === 'win32'
    return JSON.parse(execFileSync(windows ? process.env.ComSpec || 'cmd.exe' : '/bin/sh',
      windows ? ['/d', '/s', '/v:off', '/c', command] : ['-c', command], {
        cwd: destination, env, input: JSON.stringify(payload), encoding: 'utf8', timeout: 15000, windowsVerbatimArguments: windows,
      }))
  }
  const input = { conversationId: 'verification-chat', initialNumSteps: 0, invocationNum: 0,
    transcriptPath: '/test/.gemini/antigravity/brain/verification-chat/.system_generated/logs/transcript_full.jsonl' }
  const start = hook('start', input)
  const message = start.injectSteps?.[0]?.systemMessage?.systemMessage
  assert.equal(typeof message, 'string', 'The installed PreInvocation hook must respond to the synthetic start event')
  const turnId = /turnId "([A-Za-z0-9_-]+)"/.exec(message)?.[1]
  assert.ok(turnId, 'The PreInvocation response must bind the waiting card to this turn')
  assert.deepEqual(hook('start', { ...input, invocationNum: 1 }), {})
  const waiting = await client.callTool({ name: 'show_waiting_picks', arguments: { turnId } })
  assert.equal(waiting.structuredContent.shown, true)
  const panel = waiting._meta.panel
  const call = async (name, args = {}) => {
    const result = await client.callTool({ name, arguments: { ...args, panel } }, undefined, { timeout: 60000 })
    assert.ok(!result.isError, name + ' failed')
    return result._meta.data
  }
  const picks = await call('get_waiting_picks', { inView: true })
  assert.ok(picks.items.length)
  await call('select_waiting_pick', { seriesId: picks.items[0].id })
  const selected = await call('activate_waiting_player')
  assert.equal(selected.play, true)
  const episodes = await call('get_episodes', { seriesId: selected.pick.id })
  const episodeId = episodes.items[0].id
  let prepared
  const deadline = Date.now() + 60000
  do {
    prepared = await call('prepare_playback', { episodeId })
    if (prepared.status !== 'preparing') break
    await new Promise(resolve => setTimeout(resolve, 50))
  } while (Date.now() < deadline)
  assert.equal(prepared.status, 'ready')
  const segment = prepared.manifest.match(/seg\d{5}\.(?:m4s|ts)/)?.[0]
  assert.ok(segment)
  const buffers = []
  for (const asset of [...(prepared.manifest.includes('init.mp4') ? ['init.mp4'] : []), segment]) {
    let offset = 0, size
    do {
      const part = await call('read_panel_chunk', { episodeId, stream: prepared.stream, asset, offset })
      const bytes = Buffer.from(part.bytes, 'base64')
      assert.ok(bytes.length)
      buffers.push(bytes); offset += bytes.length; size = part.size
    } while (offset < size)
  }
  const clip = join(root, 'transport-sample.mp4')
  await writeFile(clip, Buffer.concat(buffers))
  execFileSync(ffmpeg, ['-v', 'error', '-i', clip, '-t', '1', '-f', 'null', '-'], { stdio: 'pipe', timeout: 15000 })
  await call('save_progress', { seriesId: selected.pick.id, episodeId, title: 'Sample', label: '1', positionMs: 1000, durationMs: 10000 })
  hook('stop', { ...input, fullyIdle: false, terminationReason: 'NO_TOOL_CALL' })
  assert.equal((await call('get_run_state')).state, 'submitted')
  hook('stop', { ...input, fullyIdle: true, terminationReason: 'USER_CANCELED' })
  assert.equal((await call('get_run_state')).state, 'interrupted')
  await client.close(); client = undefined
  await manageAntigravity('update', options)
  const reopened = new Store(data)
  assert.equal(reopened.history(selected.pick.id, episodeId)[0].positionMs, 1000)
  reopened.close()
  assert.equal(ffmpeg, ffmpegPath({ host: codex, env }))
  await manageAntigravity('uninstall', { ...options,
    removeFfmpeg: options => removeManagedFfmpeg({ ...options, env }), removeData: options => removeUserData({ ...options, env }) })
  await assert.rejects(readFile(join(destination, 'mcp_config.json')), { code: 'ENOENT' })
  execFileSync(ffmpeg, ['-version'], { stdio: 'ignore', timeout: 5000 })
  assert.equal(await activeProgram(), program.programRoot)
  await access(join(program.programRoot, 'dist/vendor/openhongguo/dist/openhongguo.wasm'))
  await removeSharedProgram({ host: codex, env })
  await assert.rejects(access(program.programRoot), { code: 'ENOENT' })
  await removeManagedFfmpeg({ host: codex, env })
  await assert.rejects(access(ffmpeg), { code: 'ENOENT' })
  await assert.rejects(access(join(data, 'player.sqlite')), { code: 'ENOENT' })
  const receipt = { version: pkg.version, platform: process.platform, uiSha256: htmlHash,
    checks: ['isolated-install-update-uninstall', 'packaged-stdio-mcp', 'app-entrypoints-and-html',
      'fixed-entrypoints-with-opposite-environment', 'installed-cli-host-selection', 'provider-worker-app-profile',
      'one-program-and-ffmpeg-survive-single-host-uninstall', 'native-shell-hooks', 'hook-deduplication-and-cancellation', 'bound-waiting-card',
      'sample-media-transport-and-decode', 'progress-preserved'],
    desktopPlaybackObserved: false, liveAntigravityHooksObserved: false }
  await mkdir('release', { recursive: true })
  await writeFile('release/verification-antigravity.json', JSON.stringify(receipt, null, 2) + '\n')
  console.log(JSON.stringify(receipt, null, 2))
} finally {
  await client?.close()
  await rm(root, { recursive: true, force: true, maxRetries: 3 })
}
