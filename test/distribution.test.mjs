import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, cpSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { install, codexRunner, pluginId } from '../src/cli/main.mjs'
import { findExecutable, spawnSync } from '../src/runtime/executables.mjs'
import { Store } from '../src/server/store.mjs'
const legacySource = 'mreasonyang/codex-hongguo'

test('setup migrates one ZIP registration and restores its original source after an installation failure', t => {
  const dir = mkdtempSync(join(tmpdir(), '红果 migration '))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const store = new Store(join(dir, 'data'))
  store.save({ seriesId: 'hg-1', episodeId: 'hg-2', title: '保留进度', label: '2', positionMs: 12345, durationMs: 60000 })
  store.close()
  const calls = [], previous = join(dir, '旧 ZIP 市场')
  const run = args => {
    calls.push(args)
    if (args[2] === 'list') return { marketplaces: [{ name: 'hongguo-local', marketplaceSource: { sourceType: 'local', source: previous } }] }
    if (args[1] === 'add' && calls.length < 7) throw Error('install failed')
    return {}
  }
  assert.throws(() => install({ run, source: legacySource, log() {} }), /install failed/)
  assert.deepEqual(calls, [
    ['plugin', 'marketplace', 'list'], ['plugin', 'marketplace', 'remove', 'hongguo-local'],
    ['plugin', 'marketplace', 'add', legacySource], ['plugin', 'add', pluginId],
    ['plugin', 'marketplace', 'remove', 'hongguo-local'], ['plugin', 'marketplace', 'add', previous],
    ['plugin', 'add', pluginId],
  ])
  const reopened = new Store(join(dir, 'data'))
  try { assert.equal(reopened.history()[0].positionMs, 12345) } finally { reopened.close() }
})

test('native updates keep the same marketplace registration and dry-run never invokes Codex', () => {
  const calls = []
  install({ source: legacySource, run(args) {
    calls.push(args)
    return args[2] === 'list' ? { marketplaces: [{ name: 'hongguo-local', marketplaceSource: { sourceType: 'git', source: 'https://github.com/' + legacySource + '.git' } }] } : {}
  }, log() {} })
  assert.ok(!calls.some(args => args.includes('remove')))
  assert.ok(calls.some(args => args[2] === 'upgrade'))
  assert.deepEqual(calls.at(-1), ['plugin', 'add', pluginId])
  install({ run() { assert.fail('dry-run must not touch Codex') }, dryRun: true, log() {} })
  assert.throws(() => install({ run() { assert.fail() }, source: 'https://user:password@example.test/private' }), /只接受/)
})

test('setup also refreshes a registered Git marketplace before installing, so reinstall cannot use a stale index', () => {
  let refreshed=false
  install({ source: legacySource, run(args) {
    if (args[2]==='list') return {marketplaces:[{name:'hongguo-local',marketplaceSource:{sourceType:'git',source:legacySource}}]}
    if (args[2]==='upgrade') refreshed=true
    if (args[1]==='add') assert.equal(refreshed,true,'plugin add must use a refreshed marketplace snapshot')
    return {}
  },log(){} })
  assert.equal(refreshed,true)
})

test('launcher works from another directory with a minimal GUI PATH and preserves hook stdin', t => {
  const dir = mkdtempSync(join(tmpdir(), "红果 '$ launcher "))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const event = { session_id: 'npm-session', turn_id: 'npm-turn', hook_event_name: 'UserPromptSubmit' }
  const windows = process.platform === 'win32'
  const plugin = join(dir, '插件 目录')
  mkdirSync(join(plugin, 'bin'), { recursive: true })
  cpSync('dist', join(plugin, 'dist'), { recursive: true })
  cpSync(windows ? 'dist/launcher/run-node.exe' : 'bin/run-node', join(plugin, 'bin', windows ? 'run-node.exe' : 'run-node'))
  if (windows) cpSync('dist/launcher/run-node-arm64.exe', join(plugin, 'bin/run-node-arm64.exe'))
  const launcher = join(plugin, 'bin', windows ? 'run-node.exe' : 'run-node')
  const runtimeEnv = { ...process.env, HOME: dir, USERPROFILE: dir, PATH: windows ? process.env.SystemRoot : '/usr/bin:/bin', HONGGUO_NODE: process.execPath, HONGGUO_DATA_DIR: join(dir, 'data') }
  const result = spawnSync(launcher, ['hook'], {
    cwd: dir, encoding: 'utf8', input: JSON.stringify(event), timeout: 5000,
    env: runtimeEnv,
  })
  assert.equal(result.status, 0)
  assert.match(JSON.parse(result.stdout).hookSpecificOutput.additionalContext, /show_waiting_picks/)
  const store = new Store(join(dir, 'data'))
  try {
    assert.equal(store.state('npm-session').turnId, 'npm-turn')
    for (const hook_event_name of ['Stop', 'Interrupt']) {
      const turn_id = hook_event_name
      for (const name of ['UserPromptSubmit', hook_event_name]) {
        const reply = spawnSync(launcher, ['hook'], { env: runtimeEnv, input: JSON.stringify({ ...event, turn_id, hook_event_name: name }), encoding: 'utf8', timeout: 5000 })
        assert.equal(reply.status, 0)
      }
      assert.equal(store.state('npm-session', turn_id).state, hook_event_name === 'Stop' ? 'stopped' : 'interrupted')
    }
  } finally { store.close() }
  const invalid = spawnSync(launcher, ['hook'], {
    cwd: dir, encoding: 'utf8', timeout: 5000, env: { ...runtimeEnv, HONGGUO_NODE: join(dir, 'absent') },
  })
  assert.equal(invalid.status, 1)
  assert.doesNotMatch(invalid.stderr, /absent|\$ launcher/)
})

test('executable lookup ignores relative PATH entries and failure diagnostics never relay host output', t => {
  const dir = mkdtempSync(join(tmpdir(), 'hongguo-executable-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  mkdirSync(join(dir, 'tools'))
  const tool = process.platform === 'win32' ? 'custom-tool.exe' : 'custom-tool'
  writeFileSync(join(dir, 'tools', tool), '', { mode: 0o755 })
  assert.equal(findExecutable('custom-tool', undefined, { env: { PATH: 'tools' }, home: dir }), 'custom-tool')
  assert.equal(findExecutable('custom-tool', undefined, { env: { PATH: join(dir, 'tools') }, home: dir }), join(dir, 'tools', tool))
  const fake = join(dir, process.platform === 'win32' ? 'fake-codex.cmd' : 'fake-codex')
  writeFileSync(fake, process.platform === 'win32' ? '@echo SYNTHETIC_PRIVATE_DIAGNOSTIC 1>&2\r\n@exit /b 1\r\n' : '#!/bin/sh\nprintf "SYNTHETIC_PRIVATE_DIAGNOSTIC" >&2\nexit 1\n', { mode: 0o755 })
  assert.throws(() => codexRunner(fake)(['plugin', 'marketplace', 'list']), error => /Codex 步骤失败/.test(error.message) && !error.message.includes('SYNTHETIC'))
})
