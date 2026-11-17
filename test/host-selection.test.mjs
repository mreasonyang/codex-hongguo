import test from 'node:test'
import assert from 'node:assert/strict'
import { PassThrough } from 'node:stream'
import { mkdtemp, mkdir, writeFile, readdir, rm, access } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
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
async function choose(answers, state) {
  const input = new PassThrough(), output = new PassThrough()
  input.isTTY = output.isTTY = true
  let text = '', index = 0
  output.on('data', chunk => {
    text += chunk
    if (chunk.toString().endsWith('要安装哪些应用？> ')) setImmediate(() => {
      const answer = answers[index++]
      if (answer === undefined) input.end()
      else input.write(answer)
    })
  })
  try { return { selected: await selectSetupHosts({ input, output, inspect: async () => state }), text } }
  finally { input.destroy(); output.destroy() }
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

test('first setup supports selecting one host or both and does not default to an unchosen host', async () => {
  const state = installations(false, false)
  for (const [answer, expected] of [['1\n', [codex]], ['2\n', [antigravity]], ['1,2\n', [codex, antigravity]], ['2 1 2\n', [antigravity, codex]]]) {
    const { selected, text } = await choose([answer], state)
    assert.deepEqual(selected, expected)
    assert.match(text, /Codex（未安装）/)
    assert.match(text, /Antigravity（未安装）/)
  }
  const { selected, text } = await choose(['\n', '3\n', '2\n'], state)
  assert.deepEqual(selected, [antigravity])
  assert.match(text, /请输入 1 或 2/)
})

test('repeated setup keeps the installed host visible and can add the missing host or repair an existing one', async () => {
  const state = installations(true, false)
  const { selected, text } = await choose(['2\n'], state)
  assert.deepEqual(selected, [antigravity])
  assert.match(text, /Codex（已安装，可重新安装）/)
  assert.match(text, /Antigravity（未安装）/)
  const other = await choose(['1\n'], installations(false, true))
  assert.deepEqual(other.selected, [codex])
  assert.match(other.text, /Antigravity（已安装，可重新安装）/)
  assert.deepEqual((await choose(['1,2\n'], installations(true, true))).selected, [codex, antigravity])
  assert.match((await choose(['1\n'], installations(null, true))).text, /安装状态暂无法确认/)
})

test('cancel, Ctrl-C and EOF select nothing, while headless setup fails before inspecting or installing', async () => {
  for (const answer of ['q\n', '\x03', undefined])
    assert.deepEqual((await choose([answer], installations(false, false))).selected, [])
  await assert.rejects(selectSetupHosts({ input: { isTTY: false }, output: { isTTY: false }, inspect() { assert.fail('inspected headless setup') } }), /setup --codex.*setup --agy/)
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
