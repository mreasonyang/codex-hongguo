import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, realpath, rm, mkdir, writeFile, readFile, access } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execFileSync } from 'node:child_process'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { codex, antigravity } from '../src/runtime/host.mjs'
import { dataRoot } from '../src/server/paths.mjs'
import { Store } from '../src/server/store.mjs'
import { ffmpegPath } from '../src/runtime/ffmpeg-runtime.mjs'
import { removeUserData } from '../src/runtime/uninstall-data.mjs'

async function temporary(t) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'hongguo-host-isolation-')))
  t.after(() => rm(root, { recursive: true, force: true }))
  return root
}
test('explicit App profiles ignore inherited identity variables on all platforms', () => {
  for (const host of [codex, antigravity]) {
    assert.ok(Object.isFrozen(host))
    for (const platform of ['darwin', 'linux', 'win32']) {
      const home = platform === 'win32' ? 'C:\\test' : '/test'
      const options = { host, platform, home, arch: 'arm64', env: {} }
      for (const value of ['codex', 'antigravity', 'unknown']) {
        const inherited = { ...options, env: { HONGGUO_HOST: value } }
        assert.equal(dataRoot(inherited), dataRoot(options))
        assert.equal(ffmpegPath(inherited), ffmpegPath(options))
      }
    }
  }
})
test('both fixed MCP and Hook entrypoints keep their sessions and progress with opposite inherited identities', async t => {
  const root = await temporary(t), clients = []
  try {
    const apps = []
    for (const host of [codex, antigravity]) {
      const data = join(root, host.id), agy = host === antigravity
      const env = { ...process.env, HONGGUO_HOST: agy ? 'codex' : 'antigravity', HONGGUO_DATA_DIR: join(root, 'codex'), HONGGUO_ANTIGRAVITY_DATA_DIR: join(root, 'antigravity'),
        HONGGUO_RUNTIME_DIR: join(root, 'runtime'), HONGGUO_FFMPEG: join(root, 'missing-ffmpeg'), CODEX_INTERNAL_ORIGINATOR_OVERRIDE: 'Codex Desktop' }
      const event = (mode) => {
        const input = agy ? { conversationId: 'same-chat', invocationNum: 0, initialNumSteps: 1,
          transcriptPath: '/test/.gemini/antigravity/brain/same-chat/.system_generated/logs/transcript.jsonl',
          fullyIdle: true, terminationReason: 'NO_TOOL_CALL' }
          : { session_id: 'same-chat', turn_id: 'codex-turn', hook_event_name: mode === 'start' ? 'UserPromptSubmit' : 'Stop' }
        return JSON.parse(execFileSync(process.execPath, ['dist/hooks/' + (agy ? 'antigravity' : 'write') + '.mjs', mode],
          { env, input: JSON.stringify(input), encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'], timeout: 5000 }))
      }
      const result = event('start')
      const turnId = agy ? /turnId "([A-Za-z0-9_-]+)"/.exec(result.injectSteps[0].systemMessage.systemMessage)[1] : 'codex-turn'
      const client = new Client({ name: 'host-isolation-test', version: '1' })
      clients.push(client)
      await client.connect(new StdioClientTransport({ command: process.execPath,
        args: ['dist/server/' + (agy ? 'antigravity' : 'index') + '.mjs'], env, stderr: 'pipe' }))
      const call = (name, args = {}) => client.callTool({ name, arguments: args, _meta: { threadId: 'same-chat' } })
      const opened = await call('open_drama_panel')
      assert.equal(opened.structuredContent.identified, true)
      const panel = opened._meta.panel
      const dataCall = async (name, args = {}) => {
        const result = await call(name, { ...args, panel })
        assert.ok(!result.isError, name + ' failed')
        return result._meta.data
      }
      assert.equal((await dataCall('get_run_state')).state, 'submitted')
      assert.equal((await call('show_waiting_picks', { turnId })).structuredContent.shown, true)
      const hooks = (await dataCall('get_setup_status')).hooks.events.map(e => e.event)
      assert.deepEqual(hooks, agy ? ['PreInvocation', 'Stop'] : ['userPromptSubmit', 'stop', 'interrupt'])
      await dataCall('save_progress', { seriesId: 'hg-123', episodeId: 'hg-456', title: 'Isolation', label: '1',
        positionMs: agy ? 2000 : 1000, durationMs: 10000 })
      apps.push({ event, dataCall, call, data, turnId })
    }
    const [a, b] = apps
    assert.equal((await a.call('show_waiting_picks', { turnId: b.turnId })).structuredContent.shown, false)
    assert.equal((await b.call('show_waiting_picks', { turnId: a.turnId })).structuredContent.shown, false)
    a.event('stop')
    assert.equal((await a.dataCall('get_run_state')).state, 'stopped')
    assert.equal((await b.dataCall('get_run_state')).state, 'submitted')
    for (const [index, app] of apps.entries()) {
      const store = new Store(app.data)
      try { assert.equal(store.history()[0].positionMs, (index + 1) * 1000) }
      finally { store.close() }
    }
  } finally { await Promise.all(clients.map(client => client.close())) }
})
test('CLI entrypoints select their fixed defaults and explicit targets without mutating the environment', async t => {
  const root = await temporary(t)
  for (const [entry, inherited, expected] of [['codex', 'antigravity', 'userPromptSubmit'], ['antigravity', 'codex', 'PreInvocation']]) {
    const env = { ...process.env, HONGGUO_HOST: inherited, HONGGUO_DATA_DIR: join(root, 'codex'), HONGGUO_ANTIGRAVITY_DATA_DIR: join(root, 'antigravity'), HONGGUO_FFMPEG: join(root, 'missing') }
    const doctor = (...args) => JSON.parse(execFileSync(process.execPath, ['bin/' + entry + '-hongguo.mjs', 'doctor', ...args],
      { env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 10000 }))
    assert.equal(doctor().hooks.events[0].event, expected)
    assert.equal(doctor('--host', 'codex').hooks.events[0].event, 'userPromptSubmit')
    assert.equal(doctor('--host', 'antigravity').hooks.events[0].event, 'PreInvocation')
    assert.equal(doctor('--agy').hooks.events[0].event, 'PreInvocation')
    assert.equal(doctor('--antigravity').hooks.events[0].event, 'PreInvocation')
    assert.equal(doctor('--codex').hooks.events[0].event, 'userPromptSubmit')
    execFileSync(process.execPath, ['--input-type=module', '-e',
      "import { main } from './dist/cli/main.mjs'; const previous = process.env.HONGGUO_HOST; await main(['doctor'], " +
      JSON.stringify(entry) + "); if (process.env.HONGGUO_HOST !== previous) process.exit(2)"],
      { env, stdio: ['ignore', 'pipe', 'pipe'], timeout: 10000 })
  }
})
test('deleting a host data directory preserves the other host with a reversed inherited identity', async t => {
  const root = await temporary(t)
  const shared = { home: root, env: { HONGGUO_RUNTIME_DIR: join(root, 'cache'), HONGGUO_HOST: 'codex' } }
  for (const host of [codex, antigravity]) {
    const data = dataRoot({ ...shared, host })
    await mkdir(data, { recursive: true }); await writeFile(join(data, 'watch-progress'), host.id)
  }
  await removeUserData({ ...shared, host: antigravity })
  await assert.rejects(access(dataRoot({ ...shared, host: antigravity })), { code: 'ENOENT' })
  assert.equal(await readFile(join(dataRoot({ ...shared, host: codex }), 'watch-progress'), 'utf8'), 'codex')
})

test('an inherited Codex data override cannot merge or delete Antigravity data', async t => {
  const home = await temporary(t)
  const custom = join(home, 'custom')
  const env = { HONGGUO_DATA_DIR: custom }
  assert.equal(dataRoot({ host: codex, home, env }), custom)
  assert.equal(dataRoot({ host: antigravity, home, env }), dataRoot({ host: antigravity, home, env: {} }))
  for (const other of [custom, join(custom, 'nested'), home]) {
    const conflict = { ...env, HONGGUO_ANTIGRAVITY_DATA_DIR: other }
    assert.throws(() => dataRoot({ host: antigravity, home, env: conflict }), /数据目录必须分开/)
    await assert.rejects(removeUserData({ host: codex, home, env: conflict }), /数据目录必须分开/)
  }
})
