import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { Store } from '../src/server/store.mjs'
import { Service } from '../src/server/service.mjs'
import { dataRoot } from '../src/server/paths.mjs'
import { ffmpegPath } from '../src/runtime/ffmpeg-runtime.mjs'
import { isAntigravityApp, recordAntigravityEvent } from '../src/hooks/antigravity-state.mjs'
import { codex, antigravity } from '../src/runtime/host.mjs'

function fixture(t, host = codex) {
  const root = mkdtempSync(join(tmpdir(), 'hongguo-agy-')), store = new Store(root, false, { host })
  t.after(() => { store.close(); rmSync(root, { recursive: true, force: true }) })
  const input = { conversationId: 'test-chat', invocationNum: 0, initialNumSteps: 10,
    lastUserInput: 'PRIVATE PROMPT', transcriptPath: '/PRIVATE/.gemini/antigravity/brain/test-chat/.system_generated/logs/transcript.jsonl' }
  return { root, store, input, event: (kind, extra = {}) => recordAntigravityEvent(store, kind, { ...input, ...extra }) }
}
test('Antigravity starts once per run, waits for background work, and records cancellation without resuming manual pauses', t => {
  const { store, event } = fixture(t)
  const first = event('start')
  assert.match(first.turnId, /^[A-Za-z0-9_-]{32}$/)
  assert.equal(first.sessionId, 'agy_test-chat')
  assert.equal(event('start'), null)
  assert.equal(event('start', { invocationNum: 1, initialNumSteps: 12 }), null)
  event('stop', { fullyIdle: false, terminationReason: 'NO_TOOL_CALL' })
  assert.equal(store.state(first.sessionId).state, 'submitted')
  assert.equal(event('start', { initialNumSteps: 15 }), null, 'background wakeup retains the turn')
  event('stop', { fullyIdle: false, terminationReason: 'USER_CANCELED' })
  assert.equal(store.state(first.sessionId).state, 'interrupted')
  assert.equal(event('start'), null, 'replayed start cannot revive a stopped turn')
  const next = event('start', { initialNumSteps: 20 })
  assert.notEqual(next.turnId, first.turnId)
  event('start', { conversationId: 'another-chat' })
  event('stop', { fullyIdle: true, terminationReason: 'NO_TOOL_CALL' })
  assert.equal(store.state(next.sessionId).state, 'stopped')
  assert.equal(store.state('agy_another-chat').state, 'submitted')
  assert.equal(event('start', { initialNumSteps: 10 }), null)
  const rows = JSON.stringify(store.db.prepare('SELECT * FROM antigravity_runs').all())
  assert.doesNotMatch(rows, /PRIVATE/)
})
test('malformed hook counters and incomplete stop payloads do not change playback state', t => {
  const { store, event } = fixture(t)
  for (const bad of [{ conversationId: '../bad' }, { invocationNum: -1 }, { initialNumSteps: '10' }, { initialNumSteps: NaN }])
    assert.equal(event('start', bad), null)
  assert.equal(store.state('agy_test-chat').state, 'unknown')
  event('start')
  event('stop')
  assert.equal(store.state('agy_test-chat').state, 'submitted')
})
test('real Antigravity hook process emits one private recommendation and fails open on invalid JSON', t => {
  const { root, store, input } = fixture(t)
  const hook = (kind, payload) => spawnSync(process.execPath, ['dist/hooks/antigravity.mjs', kind], {
    input: payload, encoding: 'utf8', timeout: 3000, env: { ...process.env, HONGGUO_ANTIGRAVITY_DATA_DIR: root },
  })
  const first = hook('start', JSON.stringify(input))
  assert.equal(first.status, 0)
  const text = JSON.parse(first.stdout).injectSteps[0].systemMessage.systemMessage
  assert.match(text, /show_waiting_picks/)
  assert.doesNotMatch(text, /PRIVATE|test-chat/)
  assert.deepEqual(JSON.parse(hook('start', JSON.stringify(input)).stdout), {})
  assert.deepEqual(JSON.parse(hook('stop', JSON.stringify({ ...input, fullyIdle: true })).stdout), {})
  assert.equal(store.state('agy_test-chat').state, 'stopped')
  for (const payload of ['null', 'broken json']) assert.equal(hook('start', payload).stdout, '{}\n')
  for (const host of ['antigravity-cli', 'antigravity-ide', 'unknown']) {
    const unsupported = { ...input, conversationId: 'other-chat', transcriptPath:
      input.transcriptPath.replace('antigravity/', host + '/').replace('test-chat/', 'other-chat/') }
    assert.equal(hook('start', JSON.stringify(unsupported)).stdout, '{}\n')
    assert.equal(store.state('agy_other-chat').state, 'unknown')
  }
})
test('App hook origin detection accepts Windows paths and rejects absent or mismatched metadata', () => {
  const input = { conversationId: 'chat', transcriptPath: 'C:\\Users\\test\\.gemini\\antigravity\\brain\\chat\\.system_generated\\logs\\transcript.jsonl' }
  assert.equal(isAntigravityApp(input), true)
  assert.equal(isAntigravityApp({ ...input, conversationId: 'different' }), false)
  for (const value of [null, {}, { conversationId: 'chat' }]) assert.equal(isAntigravityApp(value), false)
})
test('only an Antigravity-issued turn capability can bind an unlabelled recommendation; direct panels stay unbound', t => {
  const { root, store, event } = fixture(t, antigravity), start = event('start')
  const codexStore = new Store(root)
  try { assert.equal(new Service(codexStore, {}).openWaiting({}, start.turnId), null) }
  finally { codexStore.close() }
  const agy = new Service(store, {})
  assert.equal(agy.open({}).identified, false, 'never guess the latest session for a side panel')
  assert.equal(agy.openWaiting({}, 'forged'), null)
  assert.equal(agy.openWaiting({ threadId: 'wrong-chat' }, start.turnId), null)
  const opened = agy.openWaiting({}, start.turnId)
  assert.equal(agy.panel(opened.panel).sessionId, start.sessionId)
  assert.equal(agy.openWaiting({}, start.turnId), null, 'one card per turn')
  assert.throws(() => agy.panel(opened.panel, { threadId: 'wrong-chat' }), /会话/)
  const native = event('start', { conversationId: 'native-chat' })
  assert.equal(agy.openWaiting({ thread_id: 'native-chat', threadId: 'conflict' }, native.turnId), null)
  const labelled = agy.openWaiting({ threadId: 'native-chat' }, native.turnId)
  assert.equal(labelled.state.state, 'submitted')
  assert.equal(agy.panel(labelled.panel, { thread_id: 'native-chat' }).sessionId, native.sessionId)
})
test('each OS shares FFmpeg between hosts and keeps their default data separate', () => {
  for (const platform of ['darwin', 'linux', 'win32']) {
    const options = { home: platform === 'win32' ? 'C:\\Users\\test' : '/home/test', platform, arch: 'arm64' }
    for (const env of [{}, { HONGGUO_RUNTIME_DIR: platform === 'win32' ? 'C:\\cache' : '/cache' }]) {
      assert.notEqual(dataRoot({ ...options, env, host: codex }), dataRoot({ ...options, env, host: antigravity }))
      const shared = ffmpegPath({ ...options, env, host: codex })
      assert.equal(shared, ffmpegPath({ ...options, env, host: antigravity }))
      for (const host of [codex, antigravity]) {
        const separator = platform === 'win32' ? '\\' : '/'
        assert.ok(!shared.startsWith(dataRoot({ ...options, env, host }) + separator))
      }
    }
  }
  const hooks = JSON.parse(readFileSync('hooks.json', 'utf8'))
  assert.deepEqual(Object.keys(hooks.hongguo), ['PreInvocation', 'Stop'])
})
