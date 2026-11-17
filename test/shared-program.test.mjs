import test from 'node:test'
import assert from 'node:assert/strict'
import { access, lstat, mkdir, mkdtemp, readFile, readdir, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { execFile, fork } from 'node:child_process'
import { once } from 'node:events'
import { promisify } from 'node:util'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { codex, antigravity } from '../src/runtime/host.mjs'
import { installSharedProgram, removeSharedProgram, sharedProgramHome } from '../src/runtime/shared-program.mjs'
import { leasedProgramEntry } from '../src/runtime/program-lease.mjs'

const execute = promisify(execFile)
const nothing = () => {}
async function fixture(t) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'hongguo shared program ')))
  t.after(() => rm(root, { recursive: true, force: true }))
  const sourceRoot = join(root, 'source'), programHome = join(root, 'store')
  const options = { sourceRoot, host: codex, env: { HONGGUO_PROGRAM_DIR: programHome } }
  for (const file of ['package.json', 'LICENSE', 'COPYING', 'NOTICE', 'dist/server/index.mjs', 'dist/launcher/run-node.exe',
    'dist/launcher/run-node-arm64.exe', 'bin/run-node', 'docs/providers.md', 'licenses/notice.txt', 'src/dev.js', 'node_modules/dev/index.js']) {
    await mkdir(dirname(join(sourceRoot, file)), { recursive: true })
    await writeFile(join(sourceRoot, file), file === 'package.json' ? '{"version":"1.0.0"}' : file)
  }
  return { options, root, sourceRoot, programHome }
}
const missing = path => assert.rejects(lstat(path), { code: 'ENOENT' })
const active = async home => join(home, JSON.parse(await readFile(join(home, 'current.json'), 'utf8')).directory)

async function serverFixture(t) {
  const f = await fixture(t), shim = join(f.root, 'server.mjs')
  const entry = 'dist/server/index.mjs'
  await writeFile(join(f.sourceRoot, entry), `import { readFileSync } from 'node:fs'
    process.on('message', message => {
      if (message === 'stop') process.exit(0)
      process.send(readFileSync(new URL('../../NOTICE', import.meta.url), 'utf8'))
    })
    process.send('ready')`)
  await writeFile(shim, leasedProgramEntry(f.programHome, entry))
  async function start() {
    const child = fork(shim, [], { execArgv: [], stdio: ['ignore', 'ignore', 'inherit', 'ipc'] })
    t.after(() => { if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL') })
    const ready = Promise.race([once(child, 'message'), once(child, 'exit').then(() => { throw Error('server exited before readiness') })])
    assert.equal((await ready)[0], 'ready')
    return child
  }
  return { ...f, start }
}
async function stopServer(child) {
  const exited = once(child, 'exit')
  child.send('stop')
  assert.deepEqual(await exited, [0, null])
}

test('live servers keep their build for lazy reads across updates and the last uninstall, then collect it on exit', async t => {
  const { options, sourceRoot, programHome, start } = await serverFixture(t)
  const first = await installSharedProgram(options, nothing)
  const a = await start(), b = await start()
  await writeFile(join(sourceRoot, 'NOTICE'), 'new program')
  const next = await installSharedProgram(options, nothing)
  const newer = await start()
  for (const [server, expected] of [[a, 'NOTICE'], [newer, 'new program']]) {
    const response = once(server, 'message')
    server.send('load')
    assert.equal((await response)[0], expected)
  }
  await stopServer(a)
  await access(first.programRoot)
  await stopServer(b)
  await missing(first.programRoot)
  await removeSharedProgram(options)
  await missing(join(programHome, 'current.json'))
  await access(next.programRoot)
  await stopServer(newer)
  await missing(next.programRoot)
})

test('after a server is killed, the next lifecycle operation collects its retired build', async t => {
  const { options, sourceRoot, start } = await serverFixture(t)
  const first = await installSharedProgram(options, nothing)
  const server = await start()
  await writeFile(join(sourceRoot, 'NOTICE'), 'updated')
  await installSharedProgram(options, nothing)
  await access(first.programRoot)
  const exited = once(server, 'exit')
  server.kill('SIGKILL')
  await exited
  await installSharedProgram(options, nothing)
  await missing(first.programRoot)
})

test('shared program locations are independent of both host profiles and the FFmpeg cache', () => {
  assert.equal(sharedProgramHome({ platform: 'win32', env: { LOCALAPPDATA: 'C:\\AppData' } }), 'C:\\AppData\\HongguoShared\\program')
  assert.equal(sharedProgramHome({ platform: 'linux', env: { XDG_DATA_HOME: '/data' } }), '/data/hongguo-shared/program')
  assert.equal(sharedProgramHome({ platform: 'darwin', home: '/example', env: {} }), '/example/Library/Application Support/HongguoShared/program')
})

test('both hosts reuse one verified build, including when updating from the installed program', async t => {
  const { options, sourceRoot, programHome } = await fixture(t)
  const first = await installSharedProgram(options, async installed => assert.equal(await active(programHome), installed.programRoot))
  assert.equal(first.programHome, programHome)
  for (const file of ['bin/run-node-arm64.exe', 'bin/run-node.exe', 'licenses/notice.txt', 'docs/providers.md']) await access(join(first.programRoot, file))
  for (const file of ['dist/launcher', 'src', 'node_modules']) await missing(join(first.programRoot, file))
  const second = await installSharedProgram({ ...options, sourceRoot: first.programRoot, host: antigravity }, nothing)
  assert.equal(first.programRoot, second.programRoot)
  await writeFile(join(sourceRoot, 'src/dev.js'), 'development-only change')
  assert.equal((await installSharedProgram(options, nothing)).programRoot, first.programRoot)
  await writeFile(join(sourceRoot, 'dist/server/index.mjs'), 'new build, same package version')
  const updated = await installSharedProgram(options, nothing)
  assert.notEqual(updated.programRoot, first.programRoot)
  assert.equal(await active(programHome), updated.programRoot)
  await missing(first.programRoot)
  await removeSharedProgram(options, async () => assert.equal(await active(programHome), updated.programRoot))
  await removeSharedProgram(options)
  assert.equal(await active(programHome), updated.programRoot)
  await removeSharedProgram({ ...options, host: antigravity })
  await missing(join(programHome, 'current.json'))
  await missing(updated.programRoot)
})

test('failed publishes and adapter removals restore the old program and its owners', async t => {
  const { options, sourceRoot, programHome } = await fixture(t)
  function fail() { throw Error('adapter failed') }
  await assert.rejects(installSharedProgram(options, fail), /adapter failed/)
  await missing(join(programHome, 'current.json'))
  await missing(join(programHome, 'builds'))
  const first = await installSharedProgram(options, nothing)
  await writeFile(join(sourceRoot, 'NOTICE'), 'a different build')
  await assert.rejects(installSharedProgram({ ...options, host: antigravity }, async candidate => {
    assert.equal(await active(programHome), candidate.programRoot)
    assert.notEqual(candidate.programRoot, first.programRoot)
    fail()
  }), /adapter failed/)
  assert.equal(await active(programHome), first.programRoot)
  assert.equal((await readdir(join(programHome, 'builds'))).length, 1)
  await assert.rejects(removeSharedProgram(options, fail), /adapter failed/)
  assert.equal(await active(programHome), first.programRoot)
  await removeSharedProgram(options)
  await missing(first.programRoot)
})

test('a committed publish remains successful when retirement fails and the next operation retries cleanup', async t => {
  const { options, sourceRoot, programHome } = await fixture(t)
  const first = await installSharedProgram(options, nothing)
  const lease = join(first.programRoot, '.server-lease.sqlite')
  await rm(lease)
  await mkdir(lease) // Simulate a leftover that cannot be deleted through the lease protocol.
  await writeFile(join(sourceRoot, 'NOTICE'), 'updated')
  const next = await installSharedProgram(options, nothing)
  assert.equal(await active(programHome), next.programRoot)
  await access(first.programRoot)
  let removedAdapter = false
  await assert.rejects(removeSharedProgram(options, () => { removedAdapter = true }), /已卸载并完成注销/)
  assert.equal(removedAdapter, true)
  await missing(join(programHome, 'current.json'))
  await rm(lease, { recursive: true })
  await removeSharedProgram(options)
  await missing(first.programRoot)
  await missing(next.programRoot)
})

test('install repairs damaged content from a clean source and leaves unrelated store files alone', async t => {
  const { options, programHome } = await fixture(t)
  const { programRoot } = await installSharedProgram(options, nothing)
  await writeFile(join(programRoot, 'dist/server/index.mjs'), 'damaged')
  await assert.rejects(installSharedProgram({ ...options, sourceRoot: programRoot }, nothing), /重新运行安装/)
  assert.equal((await installSharedProgram(options, nothing)).programRoot, programRoot)
  assert.equal(await readFile(join(programRoot, 'dist/server/index.mjs'), 'utf8'), 'dist/server/index.mjs')
  const unrelated = join(programHome, 'builds', 'f'.repeat(64))
  await mkdir(unrelated)
  await writeFile(join(unrelated, 'keep'), 'keep')
  await removeSharedProgram(options)
  assert.equal(await readFile(join(unrelated, 'keep'), 'utf8'), 'keep')
})

test('separate installers serialize adapter publication and retain both owners', async t => {
  const { options, sourceRoot, programHome } = await fixture(t)
  const module = new URL('../src/runtime/shared-program.mjs', import.meta.url).href
  const code = `import { installSharedProgram } from ${JSON.stringify(module)}
    import { mkdir, rmdir } from 'node:fs/promises'
    import { setTimeout as sleep } from 'node:timers/promises'
    const [sourceRoot, home, id] = process.argv.slice(1)
    await installSharedProgram({ sourceRoot, env: { HONGGUO_PROGRAM_DIR: home }, host: {id} }, async () => {
      await mkdir(home + '/one-at-a-time')
      await sleep(60)
      await rmdir(home + '/one-at-a-time')
    })`
  await Promise.all(['codex', 'antigravity'].map(host => execute(process.execPath, ['--input-type=module', '-e', code, sourceRoot, programHome, host])))
  const installed = await active(programHome)
  await removeSharedProgram(options)
  await access(installed)
  await removeSharedProgram({ ...options, host: antigravity })
  await missing(installed)
})

test('a terminated updater releases its lock and the next operation restores the last committed build', async t => {
  const { options, sourceRoot, programHome } = await fixture(t)
  const first = await installSharedProgram(options, nothing)
  await writeFile(join(sourceRoot, 'NOTICE'), 'uncommitted update')
  const module = new URL('../src/runtime/shared-program.mjs', import.meta.url).href
  const code = `import { installSharedProgram } from ${JSON.stringify(module)}
    await installSharedProgram({ sourceRoot: process.argv[1], env: { HONGGUO_PROGRAM_DIR: process.argv[2] }, host: {id:'antigravity'} }, () => process.exit(53))`
  await assert.rejects(execute(process.execPath, ['--input-type=module', '-e', code, sourceRoot, programHome]), { code: 53 })
  await removeSharedProgram({ ...options, host: antigravity }, async () => assert.equal(await active(programHome), first.programRoot))
  assert.equal(await active(programHome), first.programRoot)
  assert.equal((await readdir(join(programHome, 'builds'))).length, 1)
})

test('a user-selected program directory link works while a substituted builds directory is rejected', async t => {
  const { root, options, programHome } = await fixture(t)
  await mkdir(programHome)
  const alias = join(root, 'alias'), outside = join(root, 'outside')
  await mkdir(outside)
  const type = process.platform === 'win32' ? 'junction' : 'dir'
  await symlink(programHome, alias, type)
  const linked = { ...options, env: { HONGGUO_PROGRAM_DIR: alias } }
  const installed = await installSharedProgram(linked, nothing)
  assert.equal(installed.programHome, programHome)
  await removeSharedProgram(linked)
  await symlink(outside, join(programHome, 'builds'), type)
  await assert.rejects(installSharedProgram(linked, nothing), /占用/)
  assert.deepEqual(await readdir(outside), [])
})
