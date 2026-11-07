import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { Store } from '../src/server/store.mjs'
import { Service } from '../src/server/service.mjs'
import { spawnSync, findExecutable } from '../src/runtime/executables.mjs'

test('setup, update and doctor never query Hook authorization and only ask the user to check native settings', t => {
  const dir = mkdtempSync(join(tmpdir(), 'hongguo-manual-hooks-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const marker = join(dir, 'authorization-query'), entry = join(dir, 'codex.mjs')
  writeFileSync(entry, `import {writeFileSync} from 'node:fs';
    const args=process.argv.slice(2);
    if(args[0]==='app-server'){writeFileSync(process.env.HOOK_QUERY_MARKER,'queried');process.exit(91)}
    if(args.includes('--version'))console.log('1.0.0');
    else console.log(JSON.stringify(args[1]==='marketplace'&&args[2]==='list'?{marketplaces:[]}:{}));`)
  const command = join(dir, process.platform === 'win32' ? 'codex.cmd' : 'codex')
  const quote = value => "'" + value.replaceAll("'", "'\\''") + "'"
  writeFileSync(command, process.platform === 'win32'
    ? `@echo off\r\n"${process.execPath}" "${entry}" %*\r\n`
    : `#!/bin/sh\nexec ${quote(process.execPath)} ${quote(entry)} "$@"\n`, { mode: 0o755 })
  const profile = join(dir, 'codex-home')
  mkdirSync(profile)
  const env = {
    HOME: dir, USERPROFILE: dir, CODEX_HOME: profile, PATH: process.env.PATH || process.env.Path,
    ...Object.fromEntries(['SystemRoot','WINDIR','ComSpec','PATHEXT'].filter(key=>process.env[key]).map(key=>[key,process.env[key]])),
    HONGGUO_CODEX: command, HONGGUO_FFMPEG: findExecutable('ffmpeg'),
    HONGGUO_DATA_DIR: join(dir, 'data'), HOOK_QUERY_MARKER: marker,
  }
  for (const action of ['setup','update','doctor']) {
    const result = spawnSync(process.execPath, ['--input-type=module','-e',
      `import {main} from './src/cli/main.mjs';await main(${JSON.stringify([action])})`],
    { cwd: resolve('.'), env, encoding: 'utf8', stdio: ['ignore','pipe','ignore'], timeout: 15000 })
    assert.equal(result.status, 0, 'CLI action failed: ' + action)
    assert.equal(existsSync(marker), false, 'CLI must not start an app-server to inspect authorization')
    assert.match(result.stdout, /UserPromptSubmit.*Stop.*Interrupt/)
    assert.doesNotMatch(result.stdout, /均已信任|无需重复授权|followReady/)
    if (action === 'doctor') assert.equal(JSON.parse(result.stdout).hooks.status, 'manual_check')
    else assert.match(result.stdout, /Codex 设置 → Hooks.*检查授权/)
  }
})

test('dismissing the guide persists independently of viewing progress, preferences and hook readiness', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'hongguo-setup-store-'))
  let store = new Store(dir)
  t.after(() => { store.close(); rmSync(dir, { recursive: true, force: true }) })
  store.setPreferences({ autoPrompt: false, searchTerms: ['都市'], defaultMuted: false, volume: 0.43 })
  store.save({ seriesId: 'hg-1', episodeId: 'hg-2', title: 'Test', label: '1', positionMs: 500, durationMs: 1000 })
  for (const hook_event_name of ['UserPromptSubmit', 'Stop', 'Interrupt'])
    store.event({ session_id: 'test', turn_id: 'test', hook_event_name })
  let service = new Service(store, { ffmpeg: true })
  let panel = service.panel(service.open({ thread_id: 'test' }).panel)
  const before = await service.call(panel, 'get_setup_status', {})
  assert.equal(before.dismissed, false)
  assert.equal(before.hooks.status, 'manual_check')
  assert.deepEqual(await service.call(panel, 'set_setup_dismissed', { dismissed: true }), { dismissed: true })
  store.close()
  store = new Store(dir)
  service = new Service(store, { ffmpeg: true })
  panel = service.panel(service.open({ thread_id: 'test' }).panel)
  assert.equal((await service.call(panel, 'get_setup_status', {})).dismissed, true)
  assert.deepEqual(store.preferences(), { autoPrompt: false, autoplayNext: true, autoPauseOnFinish: true, autoPlayOnStart: true, defaultMuted: false, volume: 0.43, hoverDecoyEnabled: false, decoyUrl: '', searchTerms: ['都市'] })
  await service.call(panel, 'set_preferences', { autoplayNext: false })
  assert.deepEqual(store.preferences(), { autoPrompt: false, autoplayNext: false, autoPauseOnFinish: true, autoPlayOnStart: true, defaultMuted: false, volume: 0.43, hoverDecoyEnabled: false, decoyUrl: '', searchTerms: ['都市'] })
  assert.equal(store.history()[0].positionMs, 500)
  assert.equal((await service.call(panel, 'get_setup_status', {})).hooks.status, 'manual_check')
  await service.call(panel, 'set_setup_dismissed', { dismissed: false })
  assert.equal(store.setupDismissed(), false)
})

test('a fallback progress store cannot claim to persist guide dismissal', async t => {
  const store = new Store(tmpdir(), true)
  t.after(() => store.close())
  const service = new Service(store, { ffmpeg: true })
  const panel = service.panel(service.open({}).panel)
  assert.equal((await service.call(panel, 'get_setup_status', {})).database, false)
  await assert.rejects(service.call(panel, 'set_setup_dismissed', { dismissed: true }), /不可写/)
})
