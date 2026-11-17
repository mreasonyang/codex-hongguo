import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, cp, copyFile, writeFile, readFile, rm, readdir, symlink } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { manageAntigravity, quoteCommand } from '../src/cli/antigravity.mjs'
import { antigravity } from '../src/runtime/host.mjs'

async function setup(t) {
  const root = await mkdtemp(join(tmpdir(), '红果 agy install ')), sourceRoot = join(root, 'source'), configRoot = join(root, 'config')
  t.after(() => rm(root, { recursive: true, force: true }))
  await mkdir(sourceRoot)
  for (const name of ['.antigravity-plugin', 'mcp_config.json', 'hooks.json']) await cp(name, join(sourceRoot, name), { recursive: true })
  for (const name of ['assets', 'dist/server', 'dist/hooks', 'bin', 'skills', 'provider-kit', 'docs']) await mkdir(join(sourceRoot, name), { recursive: true })
  for (const name of ['assets/logo.png', 'docs/providers.md', 'LICENSE', 'COPYING', 'NOTICE', 'dist/hooks/antigravity.mjs']) await writeFile(join(sourceRoot, name), 'fixture')
  await cp('package.json', join(sourceRoot, 'package.json'))
  await writeFile(join(sourceRoot, 'dist/server/antigravity.mjs'), "console.log('shared-server')")
  await writeFile(join(sourceRoot, 'bin/antigravity-hongguo.mjs'), "console.log('shared-cli')")
  const checkHost = async ({ host }) => assert.equal(host, antigravity)
  const programHome = join(root, 'program')
  const options = { sourceRoot, configRoot, home: root, env: { HONGGUO_PROGRAM_DIR: programHome }, node: process.execPath, log() {}, prepare: checkHost, register: checkHost }
  return { root, sourceRoot, configRoot, programHome, destination: join(configRoot, 'plugins/codex-hongguo'), options }
}
async function activeProgram(f) {
  const { directory } = JSON.parse(await readFile(join(f.programHome, 'current.json'), 'utf8'))
  return join(f.programHome, directory)
}
test('Antigravity install and update use absolute Node paths without Codex and preserve other plugins and data', async t => {
  const f = await setup(t)
  await mkdir(join(f.configRoot, 'plugins/other'), { recursive: true })
  const data = join(f.root, 'player.sqlite')
  await writeFile(data, 'existing-progress')
  await manageAntigravity('setup', f.options)
  const mcp = JSON.parse(await readFile(join(f.destination, 'mcp_config.json'), 'utf8'))
  assert.equal(mcp.mcpServers.hongguo.command, process.execPath)
  assert.deepEqual(mcp.mcpServers.hongguo.args, ['${PLUGIN_ROOT}/dist/server/antigravity.mjs'])
  assert.equal(mcp.mcpServers.hongguo.env, undefined)
  for (const [file, output] of [['dist/server/antigravity.mjs', 'shared-server'], ['bin/codex-hongguo.mjs', 'shared-cli']])
    assert.equal(execFileSync(process.execPath, [join(f.destination, file)], { encoding: 'utf8' }).trim(), output)
  for (const path of ['dist/ui', 'dist/vendor', 'provider-kit'])
    await assert.rejects(readdir(join(f.destination, path)), { code: 'ENOENT' })
  const hooks = JSON.parse(await readFile(join(f.destination, 'hooks.json'), 'utf8'))
  if (process.platform !== 'win32') {
    assert.equal(hooks.hongguo.Stop[0].command, quoteCommand(process.execPath) + ' ./dist/hooks/antigravity.mjs stop')
  }
  await writeFile(join(f.sourceRoot, 'NOTICE'), 'updated')
  await manageAntigravity('update', f.options)
  assert.equal(await readFile(join(await activeProgram(f), 'NOTICE'), 'utf8'), 'updated')
  assert.equal(await readFile(data, 'utf8'), 'existing-progress')
  assert.deepEqual((await readdir(join(f.configRoot, 'plugins'))).sort(), ['codex-hongguo', 'other'])
  assert.deepEqual((await readdir(f.configRoot)).sort(), ['.hongguo-install.sqlite', 'plugins'])
})
test('Windows manifest hooks use the pinned Node path, raw stdin and the correct event argument', { skip: process.platform !== 'win32' }, async t => {
  const f = await setup(t), node = join(f.root, "中文 %USERNAME% !test! & ' node.exe")
  await copyFile(process.execPath, node)
  const options = { ...f.options, node }
  const entry = 'dist/hooks/antigravity.mjs'
  const source = join(f.sourceRoot, entry)
  const env = { ...process.env, ...options.env, HONGGUO_ANTIGRAVITY_DATA_DIR: join(f.root, 'antigravity-data'),
    HONGGUO_DATA_DIR: join(f.root, 'codex-data') }
  const run = (file, args, input, windowsVerbatimArguments = false) => JSON.parse(execFileSync(file, args, {
    cwd: f.destination, env, input, encoding: 'utf8', timeout: 15000, windowsVerbatimArguments,
  }))
  await writeFile(source, `import { createHash } from 'node:crypto'
const hash = createHash('sha256')
let bytes = 0
for await (const chunk of process.stdin) { bytes += chunk.length; hash.update(chunk) }
console.log(JSON.stringify({ node: process.execPath, args: process.argv.slice(2), bytes, sha256: hash.digest('hex') }))
`)
  await manageAntigravity('setup', options)
  const hooks = JSON.parse(await readFile(join(f.destination, 'hooks.json'), 'utf8')).hongguo
  const shellHook = (event, input) => run(process.env.ComSpec || 'cmd.exe',
    ['/d', '/s', '/v:off', '/c', hooks[event][0].command], input, true)
  const sample = Buffer.from(JSON.stringify({ prompt: "中文 %USERNAME% ! & | ^ $ \' \" 换行\n" }))
  for (const [event, mode] of [['PreInvocation', 'start'], ['Stop', 'stop']]) {
    assert.deepEqual(shellHook(event, sample), { node, args: [mode], bytes: sample.length,
      sha256: createHash('sha256').update(sample).digest('hex') })
  }

  await copyFile(entry, source)
  await manageAntigravity('update', options)
  const start = conversationId => JSON.stringify({ invocationNum: 0, initialNumSteps: 0, conversationId,
    transcriptPath: 'C:/test/antigravity/brain/' + conversationId + '/.system_generated/logs/transcript.jsonl' })
  assert.ok(run(node, [entry, 'start'], start('direct-test')).injectSteps?.length, 'direct Node hook must recognize PreInvocation')
  assert.ok(shellHook('PreInvocation', start('shell-test')).injectSteps?.length, 'cmd hook must recognize PreInvocation')
})
test('a failed Antigravity update leaves the working installation in place', async t => {
  const f = await setup(t)
  await manageAntigravity('setup', f.options)
  await rm(join(f.sourceRoot, 'NOTICE'))
  await assert.rejects(manageAntigravity('update', f.options))
  assert.equal(await readFile(join(await activeProgram(f), 'NOTICE'), 'utf8'), 'fixture')
  assert.deepEqual((await readdir(f.configRoot)).sort(), ['.hongguo-install.sqlite', 'plugins'])
})
test('dry runs do not create configuration, prepare media or clean data', async t => {
  const f = await setup(t), forbidden = () => assert.fail('dry run changed state')
  for (const action of ['setup', 'update', 'uninstall'])
    await manageAntigravity(action, { ...f.options, dryRun: true, prepare: forbidden, register: forbidden, removeData: forbidden, removeFfmpeg: forbidden })
  await assert.rejects(readdir(f.configRoot), { code: 'ENOENT' })
  await assert.rejects(readdir(f.programHome), { code: 'ENOENT' })
})
test('failed shared runtime registration rolls back the new plugin and restores an existing installation', async t => {
  const f = await setup(t)
  const failed = { ...f.options, register: async () => { throw Error('registration failed') } }
  await assert.rejects(manageAntigravity('setup', failed), /registration failed/)
  await assert.rejects(readdir(f.destination), { code: 'ENOENT' })
  await manageAntigravity('setup', f.options)
  await writeFile(join(f.sourceRoot, 'NOTICE'), 'replacement')
  await assert.rejects(manageAntigravity('update', failed), /registration failed/)
  assert.equal(await readFile(join(await activeProgram(f), 'NOTICE'), 'utf8'), 'fixture')
})
test('uninstall cleans only its host, is repeatable, and refuses an unmanaged destination', async t => {
  const f = await setup(t), cleaned = []
  await manageAntigravity('setup', f.options)
  const cleanup = async ({ host }) => {
    assert.equal(host, antigravity)
    await assert.rejects(readdir(f.destination), { code: 'ENOENT' })
    cleaned.push(true)
  }
  for (let i = 0; i < 2; i++) await manageAntigravity('uninstall', { ...f.options, removeData: cleanup, removeFfmpeg: cleanup })
  assert.equal(cleaned.length, 4)
  await mkdir(f.destination)
  await writeFile(join(f.destination, 'keep'), 'unmanaged')
  await assert.rejects(manageAntigravity('setup', f.options), /非本安装器/)
  await assert.rejects(manageAntigravity('uninstall', { ...f.options, removeData: cleanup }), /非本安装器/)
  assert.equal(await readFile(join(f.destination, 'keep'), 'utf8'), 'unmanaged')
})
test('installer rejects symlink destinations without touching their targets', { skip: process.platform === 'win32' }, async t => {
  const f = await setup(t)
  await mkdir(join(f.configRoot, 'plugins'), { recursive: true })
  await symlink(f.sourceRoot, f.destination)
  await assert.rejects(manageAntigravity('setup', f.options), /普通目录/)
  assert.equal(await readFile(join(f.sourceRoot, 'NOTICE'), 'utf8'), 'fixture')
})
