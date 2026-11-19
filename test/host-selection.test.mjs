import test from 'node:test'
import assert from 'node:assert/strict'
import { PassThrough } from 'node:stream'
import { mkdtemp, mkdir, writeFile, readdir, rm, access } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { stripVTControlCharacters } from 'node:util'
import { codex, antigravity } from '../src/runtime/host.mjs'
import { spawnSync } from '../src/runtime/executables.mjs'
import { parseHostArguments, hostInstallations, selectSetupHosts, configureSetupHosts } from '../src/cli/host-selection.mjs'

const mainURL = new URL('../src/cli/main.mjs', import.meta.url).href
const installations = (codexInstalled, agyInstalled) => [
  { host: codex, installed: codexInstalled }, { host: antigravity, installed: agyInstalled },
]
async function temporary(t) {
  const root = await mkdtemp(join(tmpdir(), '红果 setup 选择 '))
  t.after(() => rm(root, { recursive: true, force: true }))
  return root
}
function cli(args, root, env = {}) {
  return spawnSync(process.execPath, ['--input-type=module', '-e', `import {main} from ${JSON.stringify(mainURL)};await main(${JSON.stringify(args)})`], {
    env: { ...process.env, HOME: root, USERPROFILE: root, CODEX_HOME: join(root, 'codex'),
      HONGGUO_PROGRAM_DIR: join(root, 'program'), HONGGUO_CODEX: join(root, 'missing-codex'),
      HONGGUO_DATA_DIR: join(root, 'codex-data'), HONGGUO_ANTIGRAVITY_DATA_DIR: join(root, 'agy-data'), ...env },
    encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 15000,
  })
}
const down = '\x1b[B', up = '\x1b[A', enter = '\r'
function terminal() {
  const input = new PassThrough(), output = new PassThrough()
  input.isTTY = output.isTTY = true
  input.isRaw = false
  input.setRawMode = value => { input.isRaw = value; return input }
  output.columns = 80
  output.rows = 24
  // Unlike an ordinary pipe destination, stdout remains open when a prompt's
  // temporary output stream ends. Keep the simulated terminal reusable too.
  output.end = () => output
  return { input, output }
}
async function choose(keys, state, streams = terminal(), keepOpen = false) {
  const { input, output } = streams, wasRaw = input.isRaw
  let text = '', ready
  const rendered = new Promise(resolve => { ready = resolve })
  const capture = chunk => {
    text += chunk
    if (text.includes('Esc 取消')) ready()
  }
  output.on('data', capture)
  try {
    const selection = selectSetupHosts({ input, output, inspect: async () => state })
    await rendered
    for (const key of keys) {
      if (key === undefined) input.end()
      else input.write(key)
      await new Promise(resolve => setImmediate(resolve))
    }
    const selected = await selection
    assert.equal(input.isRaw, wasRaw, 'raw mode must be restored')
    assert.equal(input.listenerCount('keypress'), 0, 'prompt key handlers must be removed')
    assert.equal(output.listenerCount('resize'), 0, 'prompt resize handlers must be removed')
    assert.ok(text.includes('\x1b[?25h'), 'cursor must be visible after the prompt')
    return { selected, text: stripVTControlCharacters(text) }
  } finally {
    output.removeListener('data', capture)
    if (!keepOpen) { input.destroy(); output.destroy() }
  }
}

test('host aliases compose for setup, deduplicate and preserve option values', () => {
  assert.deepEqual(parseHostArguments(['setup', '--agy']), { args: ['setup'], hosts: [antigravity] })
  assert.deepEqual(parseHostArguments(['setup', '--antigravity']), { args: ['setup'], hosts: [antigravity] })
  assert.deepEqual(parseHostArguments(['setup', '--codex', '--agy', '--host', 'antigravity', '--antigravity']),
    { args: ['setup'], hosts: [codex, antigravity] })
  assert.deepEqual(parseHostArguments(['setup', '--host=codex', '--marketplace', '--agy']),
    { args: ['setup', '--marketplace', '--agy'], hosts: [codex] })
  assert.deepEqual(parseHostArguments(['provider', 'doctor', '--query', '--agy', '--host', 'codex']),
    { args: ['provider', 'doctor', '--query', '--agy'], hosts: [codex] })
  assert.throws(() => parseHostArguments(['setup', '--host']), /需要指定/)
  assert.throws(() => parseHostArguments(['setup', '--host', '--agy']), /需要指定/)
  assert.throws(() => parseHostArguments(['setup', '--host', 'other']), /未知 App/)
})

test('checkbox keys select one host or both and toggle a checked host off', async () => {
  const state = installations(false, false)
  for (const [keys, expected] of [
    [[' ', enter], [codex]],
    [[down, ' ', enter], [antigravity]],
    [[' ', down, ' ', enter], [codex, antigravity]],
    [[' ', ' ', down, ' ', enter], [antigravity]],
    [[up, ' ', enter], [antigravity]],
  ]) {
    const { selected, text } = await choose(keys, state)
    assert.deepEqual(selected, expected)
    assert.match(text, /\[ \] Codex（未安装）/)
    assert.match(text, /\[ \] Antigravity（未安装）/)
    assert.match(text, /\[x\]/)
    assert.match(text, /空格 勾选.*回车 确认/)
  }
})

test('Enter with no checkboxes selected stays in the prompt and shows a Chinese validation message', async () => {
  const { selected, text } = await choose([enter, ' ', enter], installations(false, false))
  assert.deepEqual(selected, [codex])
  assert.match(text, /请至少勾选一个应用/)
})

test('repeated setup keeps the installed host visible and can add the missing host or repair an existing one', async () => {
  const state = installations(true, false)
  const { selected, text } = await choose([down, ' ', enter], state)
  assert.deepEqual(selected, [antigravity])
  assert.match(text, /Codex（已安装，可重新安装）/)
  assert.match(text, /Antigravity（未安装）/)
  const other = await choose([' ', enter], installations(false, true))
  assert.deepEqual(other.selected, [codex])
  assert.match(other.text, /Antigravity（已安装，可重新安装）/)
  assert.deepEqual((await choose([' ', down, ' ', enter], installations(true, true))).selected, [codex, antigravity])
  assert.match((await choose([' ', enter], installations(null, true))).text, /安装状态暂无法确认/)
})

test('Escape, Ctrl-C, Ctrl-D, q and EOF cancel checked choices, while headless setup never inspects hosts', async () => {
  for (const key of ['\x1b', '\x03', '\x04', 'q', undefined])
    assert.deepEqual((await choose([' ', key], installations(false, false))).selected, [])
  await assert.rejects(selectSetupHosts({ input: { isTTY: false }, output: { isTTY: false }, inspect() { assert.fail('inspected headless setup') } }), /setup --codex.*setup --agy/)
})

test('a terminal can reopen the selector after confirmation or cancellation without retaining selections or raw mode', async () => {
  const streams = terminal(), state = installations(true, false)
  streams.input.isRaw = true
  try {
    assert.deepEqual((await choose([' ', enter], state, streams, true)).selected, [codex])
    assert.deepEqual((await choose([down, ' ', '\x1b'], state, streams, true)).selected, [])
    assert.deepEqual((await choose([enter, down, ' ', enter], state, streams, true)).selected, [antigravity])
  } finally { streams.input.destroy(); streams.output.destroy() }
})

test('inspection errors propagate before any terminal mode change', async () => {
  const { input, output } = terminal()
  try {
    await assert.rejects(selectSetupHosts({ input, output, inspect: async () => { throw Error('inspection failed') } }), /inspection failed/)
    assert.equal(input.isRaw, false)
    assert.equal(input.listenerCount('keypress'), 0)
  } finally { input.destroy(); output.destroy() }
})

test('an unavailable selected host does not prevent installation of the other selected host', async () => {
  const configured = [], failures = []
  await assert.rejects(configureSetupHosts([codex, antigravity], async host => {
    configured.push(host.id)
    if (host === codex) throw Error('Codex CLI 不可用')
  }, { error: message => failures.push(message) }), /Codex.*已完成的安装会保留/)
  assert.deepEqual(configured, ['codex', 'antigravity'])
  assert.match(failures[0], /Codex CLI 不可用/)
})

test('host status detection follows owned Antigravity receipts and native Codex registration without creating installer files', async t => {
  const root = await temporary(t), entry = join(root, 'codex.mjs')
  await writeFile(entry, 'console.log(JSON.stringify({installed:process.env.TEST_CODEX_INSTALLED ? [{pluginId:"codex-hongguo@hongguo-local"}] : []}))')
  const command = join(root, process.platform === 'win32' ? 'codex.cmd' : 'codex')
  const quote = value => "'" + value.replaceAll("'", "'\\''") + "'"
  // Keep the batch file ASCII, as npm does. Expand Unicode paths at runtime
  // instead of making them depend on cmd.exe's active script code page.
  await writeFile(command, process.platform === 'win32'
    ? '@echo off\r\n"%HONGGUO_HOST_SELECTION_TEST_NODE%" "%~dp0codex.mjs" %*\r\n'
    : `#!/bin/sh\nexec ${quote(process.execPath)} ${quote(entry)} "$@"\n`, { mode: 0o755 })
  const env = { ...process.env, HONGGUO_CODEX: command, HONGGUO_HOST_SELECTION_TEST_NODE: process.execPath }
  const before = await readdir(root)
  assert.deepEqual(await hostInstallations({ env, home: root }), installations(false, false))
  assert.deepEqual(await readdir(root), before)
  const agy = join(root, '.gemini/config/plugins/codex-hongguo')
  await mkdir(agy, { recursive: true })
  await writeFile(join(agy, '.hongguo-antigravity.json'), JSON.stringify({ owner: '@kyun.si/codex-hongguo', host: 'antigravity' }))
  assert.deepEqual(await hostInstallations({ env: { ...env, TEST_CODEX_INSTALLED: '1' }, home: root }), installations(true, true))
  await writeFile(join(agy, '.hongguo-antigravity.json'), '{}')
  assert.deepEqual(await hostInstallations({ env: { ...env, HONGGUO_CODEX: join(root, 'missing') }, home: root }), installations(null, null))
  await assert.rejects(access(join(root, 'program/program.sqlite')), { code: 'ENOENT' })
})

test('CLI requires an explicit headless target and Antigravity aliases never require Codex', async t => {
  const root = await temporary(t)
  const implicit = cli(['setup'], root)
  assert.equal(implicit.status, 1)
  assert.match(implicit.stderr, /交互终端.*--codex.*--agy/)
  assert.deepEqual(await readdir(root), [])
  for (const alias of ['--agy', '--antigravity']) for (const action of ['setup', 'update', 'uninstall']) {
    const result = cli([action, alias, '--dry-run'], root)
    assert.equal(result.status, 0, result.stderr)
    assert.match(result.stdout, /Antigravity/)
    assert.doesNotMatch(result.stdout, /Codex 原生市场/)
  }
  assert.deepEqual(await readdir(root), [])
  const both = cli(['setup', '--codex', '--agy', '--dry-run'], root)
  assert.equal(both.status, 1)
  assert.match(both.stderr, /未找到 Codex CLI/)
  assert.match(both.stdout, /Antigravity/)
  const invalid = cli(['update', '--codex', '--agy', '--dry-run'], root)
  assert.equal(invalid.status, 1)
  assert.match(invalid.stderr, /只有 setup 支持多选/)
  const marketplace = cli(['setup', '--codex', '--agy', '--marketplace', root, '--dry-run'], root)
  assert.equal(marketplace.status, 1)
  assert.match(marketplace.stderr, /--marketplace 请仅搭配 --codex/)
  assert.deepEqual(await readdir(root), [])
})
