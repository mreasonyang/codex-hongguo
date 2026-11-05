import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { inspectHooks } from '../src/server/setup.mjs'
import { Store } from '../src/server/store.mjs'
import { Service } from '../src/server/service.mjs'

const eventNames = ['userPromptSubmit', 'stop', 'interrupt']
function fixture(t, hooks, error = false) {
  const dir = mkdtempSync(join(tmpdir(), 'hongguo-setup-test-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const file = join(dir, 'host.mjs')
  mkdirSync(join(dir, 'hooks'))
  writeFileSync(join(dir, 'hooks/hooks.json'), '{}')
  const scopedHooks = hooks.map(hook => ({ ...hook, sourcePath: hook.sourcePath === '/different-install/hooks.json' ? hook.sourcePath : join(dir, 'hooks/hooks.json') }))
  writeFileSync(file, `import {createInterface} from 'node:readline';
    createInterface({input:process.stdin}).on('line',line=>{
      const request=JSON.parse(line);
      if (!request.id) return;
      const response=request.id===1 ? {result:{}} : ${JSON.stringify(error ? { error: { code: -1, message: 'PRIVATE_TEST_METADATA_MUST_STAY_INTERNAL' } } : { result: { data: [{ hooks: scopedHooks }] } })};
      process.stdout.write(JSON.stringify({id:request.id,...response})+'\\n');
    });`)
  return { command: process.execPath, args: [file], cwd: dir, pluginRoot: dir, timeoutMs: 2000 }
}
const hooks = trust => eventNames.map(eventName => ({
  eventName, enabled: true, trustStatus: trust, pluginId: 'codex-hongguo@hongguo-local',
  command: 'PRIVATE_TEST_METADATA_MUST_STAY_INTERNAL', sourcePath: '/private-test-hook',
}))

test('setup reports only this plugin and requires all three hooks to be trusted and enabled', async t => {
  const configured = hooks('trusted')
  const unrelated = { ...configured[0], pluginId: 'another-plugin@local', trustStatus: 'untrusted' }
  const ready = await inspectHooks(fixture(t, [...configured, unrelated]))
  assert.deepEqual(ready, { status: 'ready', events: eventNames.map(event => ({ event, status: 'ready' })) })
  for (const trust of ['untrusted', 'modified']) {
    const result = await inspectHooks(fixture(t, hooks(trust)))
    assert.equal(result.status, 'needs_attention')
    assert.ok(result.events.every(event => event.status === 'needs_review'))
    assert.ok(!JSON.stringify(result).includes('PRIVATE_TEST_METADATA'))
  }
  configured[1].enabled = false
  const disabled = await inspectHooks(fixture(t, configured))
  assert.equal(disabled.status, 'needs_attention')
  assert.equal(disabled.events[1].status, 'disabled')
  const missing = await inspectHooks(fixture(t, configured.slice(0, 1)))
  assert.equal(missing.events[1].status, 'missing')
  assert.equal((await inspectHooks(fixture(t, []))).status, 'unknown')
  const otherInstall = hooks('trusted').map(hook => ({ ...hook, sourcePath: '/different-install/hooks.json' }))
  assert.equal((await inspectHooks(fixture(t, otherInstall))).status, 'unknown')
})

test('unavailable, failed or timed-out host checks stay unverified', async t => {
  const unknown = { status: 'unknown', events: eventNames.map(event => ({ event, status: 'unknown' })) }
  assert.deepEqual(await inspectHooks(fixture(t, [], true)), unknown)
  assert.deepEqual(await inspectHooks({ command: join(tmpdir(), 'hongguo-absent-executable'), timeoutMs: 500 }), unknown)
  assert.deepEqual(await inspectHooks({ command: process.execPath, args: ['-e', 'setInterval(()=>{},1000)'], timeoutMs: 100 }), unknown)
})

test('Windows setup reads the host protocol through a .cmd CLI shim', { skip: process.platform !== 'win32' }, async t => {
  const options = fixture(t, hooks('trusted'))
  const pidFile = join(options.cwd, 'host-pid.json')
  const entry = join(options.cwd, 'host-entry.mjs')
  writeFileSync(entry, `import {writeFileSync} from 'node:fs';writeFileSync(${JSON.stringify(pidFile)},String(process.pid));await import(${JSON.stringify(pathToFileURL(options.args[0]).href)});`)
  const command = join(options.cwd, 'Codex 入口.cmd')
  writeFileSync(command, `@echo off\r\n"${process.execPath}" "${entry}" %*\r\n`)
  const result = await inspectHooks({ ...options, command, args: ['app-server'] })
  assert.equal(result.status, 'ready')
  assert.ok(result.events.every(event => event.status === 'ready'))
  const pid = Number(readFileSync(pidFile, 'utf8'))
  assert.throws(() => process.kill(pid, 0), error => error.code === 'ESRCH', 'the .cmd host process must not outlive the check')
})

test('dismissing the guide persists independently of viewing progress, preferences and hook readiness', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'hongguo-setup-store-'))
  let store = new Store(dir)
  t.after(() => { store.close(); rmSync(dir, { recursive: true, force: true }) })
  store.setPreferences({ autoPrompt: false, searchTerms: ['都市'] })
  store.save({ seriesId: 'hg-1', episodeId: 'hg-2', title: 'Test', label: '1', positionMs: 500, durationMs: 1000 })
  for (const hook_event_name of ['UserPromptSubmit', 'Stop', 'Interrupt'])
    store.event({ session_id: 'test', turn_id: 'test', hook_event_name })
  const unavailable = async () => ({ status: 'needs_attention', events: eventNames.map(event => ({ event, status: 'needs_review' })) })
  let service = new Service(store, { ffmpeg: true }, unavailable)
  let panel = service.panel(service.open({ thread_id: 'test' }).panel)
  const before = await service.call(panel, 'get_setup_status', {})
  assert.equal(before.dismissed, false)
  assert.equal(before.hooks.status, 'needs_attention')
  assert.deepEqual(await service.call(panel, 'set_setup_dismissed', { dismissed: true }), { dismissed: true })
  store.close()
  store = new Store(dir)
  service = new Service(store, { ffmpeg: true }, unavailable)
  panel = service.panel(service.open({ thread_id: 'test' }).panel)
  assert.equal((await service.call(panel, 'get_setup_status', {})).dismissed, true)
  assert.deepEqual(store.preferences(), { autoPrompt: false, autoplayNext: true, autoPauseOnFinish: true, autoPlayOnStart: true, searchTerms: ['都市'] })
  await service.call(panel, 'set_preferences', { autoplayNext: false })
  assert.deepEqual(store.preferences(), { autoPrompt: false, autoplayNext: false, autoPauseOnFinish: true, autoPlayOnStart: true, searchTerms: ['都市'] })
  assert.equal(store.history()[0].positionMs, 500)
  assert.equal((await service.call(panel, 'get_setup_status', {})).hooks.status, 'needs_attention')
  await service.call(panel, 'set_setup_dismissed', { dismissed: false })
  assert.equal(store.setupDismissed(), false)
})

test('a fallback progress store cannot claim to persist guide dismissal', async t => {
  const store = new Store(tmpdir(), true)
  t.after(() => store.close())
  const service = new Service(store, { ffmpeg: true }, async () => ({ status: 'unknown', events: [] }))
  const panel = service.panel(service.open({}).panel)
  assert.equal((await service.call(panel, 'get_setup_status', {})).database, false)
  await assert.rejects(service.call(panel, 'set_setup_dismissed', { dismissed: true }), /不可写/)
})
