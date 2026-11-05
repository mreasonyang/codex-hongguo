import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { spawnSync } from 'node:child_process'
import { install, codexRunner, defaultSource, pluginId } from '../src/cli/main.mjs'
import { findExecutable } from '../src/runtime/executables.mjs'
import { Store } from '../src/server/store.mjs'

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
  assert.throws(() => install({ run, log() {} }), /install failed/)
  assert.deepEqual(calls, [
    ['plugin', 'marketplace', 'list'], ['plugin', 'marketplace', 'remove', 'hongguo-local'],
    ['plugin', 'marketplace', 'add', defaultSource], ['plugin', 'add', pluginId],
    ['plugin', 'marketplace', 'remove', 'hongguo-local'], ['plugin', 'marketplace', 'add', previous],
    ['plugin', 'add', pluginId],
  ])
  const reopened = new Store(join(dir, 'data'))
  try { assert.equal(reopened.history()[0].positionMs, 12345) } finally { reopened.close() }
})

test('native updates keep the same marketplace registration and dry-run never invokes Codex', () => {
  const calls = []
  install({ run(args) {
    calls.push(args)
    return args[2] === 'list' ? { marketplaces: [{ name: 'hongguo-local', marketplaceSource: { sourceType: 'git', source: 'https://github.com/' + defaultSource + '.git' } }] } : {}
  }, update: true, log() {} })
  assert.ok(!calls.some(args => args.includes('remove')))
  assert.ok(calls.some(args => args[2] === 'upgrade'))
  assert.deepEqual(calls.at(-1), ['plugin', 'add', pluginId])
  install({ run() { assert.fail('dry-run must not touch Codex') }, dryRun: true, log() {} })
  assert.throws(() => install({ run() { assert.fail() }, source: 'https://user:password@example.test/private' }), /只接受/)
})

test('launcher works from another directory with a minimal GUI PATH and preserves hook stdin', t => {
  const dir = mkdtempSync(join(tmpdir(), "红果 '$ launcher "))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const event = { session_id: 'npm-session', turn_id: 'npm-turn', hook_event_name: 'UserPromptSubmit' }
  const result = spawnSync('/bin/sh', [resolve('bin/run-node'), 'hook'], {
    cwd: dir, encoding: 'utf8', input: JSON.stringify(event), timeout: 5000,
    env: { HOME: dir, PATH: '/usr/bin:/bin', HONGGUO_NODE: process.execPath, HONGGUO_DATA_DIR: join(dir, 'data') },
  })
  assert.equal(result.status, 0)
  assert.match(JSON.parse(result.stdout).hookSpecificOutput.additionalContext, /show_waiting_picks/)
  const store = new Store(join(dir, 'data'))
  try { assert.equal(store.state('npm-session').turnId, 'npm-turn') } finally { store.close() }
  const invalid = spawnSync('/bin/sh', [resolve('bin/run-node'), 'hook'], {
    cwd: dir, encoding: 'utf8', timeout: 5000, env: { HOME: dir, PATH: '/usr/bin:/bin', HONGGUO_NODE: join(dir, 'absent') },
  })
  assert.equal(invalid.status, 1)
  assert.doesNotMatch(invalid.stderr, /absent|\$ launcher/)
})

test('executable lookup ignores relative PATH entries and failure diagnostics never relay host output', t => {
  const dir = mkdtempSync(join(tmpdir(), 'hongguo-executable-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  mkdirSync(join(dir, 'tools'))
  writeFileSync(join(dir, 'tools', 'custom-tool'), '', { mode: 0o755 })
  assert.equal(findExecutable('custom-tool', undefined, { env: { PATH: 'tools' }, home: dir }), 'custom-tool')
  assert.equal(findExecutable('custom-tool', undefined, { env: { PATH: join(dir, 'tools') }, home: dir }), join(dir, 'tools', 'custom-tool'))
  const fake = join(dir, 'fake-codex')
  writeFileSync(fake, '#!/bin/sh\nprintf "SYNTHETIC_PRIVATE_DIAGNOSTIC" >&2\nexit 1\n', { mode: 0o755 })
  assert.throws(() => codexRunner(fake)(['plugin', 'marketplace', 'list']), error => /Codex 步骤失败/.test(error.message) && !error.message.includes('SYNTHETIC'))
})
