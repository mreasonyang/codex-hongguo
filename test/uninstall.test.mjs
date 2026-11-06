import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, rmSync, mkdirSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { uninstall, codexRunner, pluginId } from '../src/cli/main.mjs'
import { marketplaceSource, isManagedMarketplace } from '../src/cli/local-marketplace.mjs'
import { selectOwnedWindowsProcesses } from '../src/runtime/windows-processes.mjs'

function fixture() {
  const calls = [], managedRoot = join(tmpdir(), 'hongguo-managed-marketplace')
  let registered = { name: 'hongguo-local', root: join(managedRoot, '0.0.32') }, installed = true
  const options = {
    managedRoot,
    run(args) {
      calls.push(args.join(' '))
      if (args[1] === 'marketplace' && args[2] === 'list') return { marketplaces: registered ? [registered] : [] }
      if (args[1] === 'list') return { installed: installed ? [{ pluginId }] : [] }
      if (args[1] === 'remove') { installed = false; return {} }
      if (args[1] === 'marketplace' && args[2] === 'remove') { registered = null; return {} }
      assert.fail('Unexpected Codex operation')
    },
    stopProcesses: async () => { calls.push('stop owned processes') },
    removeFfmpeg: async () => { calls.push('clean playback runtime') },
    removeData: async () => { calls.push('clean user data') },
  }
  return { options, calls, setRegistration(value) { registered = value } }
}

test('root-only local marketplace is unregistered before data cleanup; repeated uninstall succeeds without Git', async () => {
  const { options, calls } = fixture()
  await uninstall(options)
  assert.ok(calls.indexOf('stop owned processes') < calls.indexOf('plugin remove ' + pluginId))
  assert.ok(calls.indexOf('plugin remove ' + pluginId) < calls.indexOf('plugin marketplace remove hongguo-local'))
  assert.ok(calls.indexOf('plugin marketplace remove hongguo-local') < calls.indexOf('clean user data'))
  await uninstall(options)
  assert.equal(calls.filter(call => call === 'plugin remove ' + pluginId).length, 1)
  assert.equal(calls.filter(call => call === 'plugin marketplace remove hongguo-local').length, 1)
  assert.ok(calls.every(call => !call.includes(' git') && !call.includes('upgrade')))
})

test('source and root layouts preserve explicit custom marketplaces', async () => {
  const { options, calls, setRegistration } = fixture()
  const external = join(tmpdir(), 'external-marketplace')
  setRegistration({ name: 'hongguo-local', root: join(options.managedRoot, '0.0.32'), marketplaceSource: { source: external } })
  assert.equal(marketplaceSource({ root: external }), external)
  await uninstall(options)
  assert.ok(!calls.includes('plugin marketplace remove hongguo-local'))
  assert.ok(calls.includes('clean user data'))
})

test('managed marketplace detection resolves directory aliases without accepting a prefix sibling', t => {
  const dir = mkdtempSync(join(tmpdir(), 'hongguo-market-alias-'))
  t.after(() => rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }))
  const root = join(dir, 'managed'), alias = join(dir, 'alias')
  mkdirSync(join(root, '0.0.32'), { recursive: true })
  symlinkSync(root, alias, process.platform === 'win32' ? 'junction' : 'dir')
  assert.equal(isManagedMarketplace(join(alias, '0.0.32'), root), true)
  assert.equal(isManagedMarketplace(join(dir, 'managed-other', '0.0.32'), root), false)
})

test('unknown marketplace location or failed process stop leaves plugin data intact', async () => {
  for (const unknown of [true, false]) {
    const { options, calls, setRegistration } = fixture()
    if (unknown) setRegistration({ name: 'hongguo-local' })
    else options.stopProcesses = async () => { throw Error('stop failed') }
    await assert.rejects(uninstall(options))
    assert.ok(!calls.includes('plugin remove ' + pluginId))
    assert.ok(!calls.includes('clean user data'))
  }
})

test('cache lock retries remain bounded and never unregister or erase data on failure', async () => {
  const { options, calls } = fixture(), original = options.run
  options.platform = 'win32'
  options.run = args => {
    if (args[1] === 'remove') { calls.push('locked'); throw Object.assign(Error('occupied'), { code: 'PLUGIN_CACHE_IN_USE' }) }
    return original(args)
  }
  await assert.rejects(uninstall(options), { code: 'PLUGIN_CACHE_IN_USE' })
  assert.equal(calls.filter(c => c === 'locked').length, 3)
  assert.ok(!calls.includes('plugin marketplace remove hongguo-local'))
  assert.ok(!calls.includes('clean user data'))
})

test('unsuccessful marketplace deregistration preserves its index and user data', async () => {
  const { options, calls } = fixture(), original = options.run
  options.run = args => args[2] === 'remove' ? {} : original(args)
  await assert.rejects(uninstall(options), /市场尚未注销/)
  assert.ok(!calls.includes('clean user data'))
})

test('cache access errors produce actionable fixed diagnostics without relaying private host output', t => {
  const dir = mkdtempSync(join(tmpdir(), 'hongguo-uninstall-diagnostic-'))
  t.after(() => rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }))
  const command = join(dir, process.platform === 'win32' ? 'codex.cmd' : 'codex')
  writeFileSync(command, process.platform === 'win32'
    ? '@echo off\r\necho SYNTHETIC_PRIVATE_DIAGNOSTIC Access is denied (os error 5) 1>&2\r\nexit /b 1\r\n'
    : '#!/bin/sh\nprintf "%s\\n" "SYNTHETIC_PRIVATE_DIAGNOSTIC Access is denied (os error 5)" >&2\nexit 1\n', { mode: 0o755 })
  assert.throws(() => codexRunner(command)(['plugin', 'remove', pluginId]), error =>
    error.code === 'PLUGIN_CACHE_IN_USE' && /占用.*权限/.test(error.message) && !error.message.includes('SYNTHETIC_PRIVATE_DIAGNOSTIC'))
})

test('process selection uses canonical executable identity and excludes shared Node, prefix siblings and malformed identities', async () => {
  const own = 'C:\\Users\\Eason\\.codex\\plugins\\cache\\hongguo-local\\codex-hongguo\\0.0.32\\bin\\run-node.exe'
  const rows = [
    { pid: 810001, executable: own.toUpperCase(), started: '638000000000000000' },
    { pid: 810002, executable: own.replace('codex-hongguo\\', 'codex-hongguo-other\\'), started: '638000000000000000' },
    { pid: 810003, executable: 'C:\\Program Files\\nodejs\\node.exe', started: '638000000000000000' },
    { pid: 810004, executable: own, started: 'invalid' },
  ]
  const chosen = await selectOwnedWindowsProcesses(rows, [own], async path => path)
  assert.deepEqual(chosen.map(row => row.pid), [810001])
})
