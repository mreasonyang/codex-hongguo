import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile, rm, rmdir, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { manageAntigravity } from '../src/cli/antigravity.mjs'

const installer = new URL('../src/cli/antigravity.mjs', import.meta.url).href
const pauseDuringSetup = `
  import { manageAntigravity } from ${JSON.stringify(installer)}
  const [configRoot, sourceRoot] = process.argv.slice(1)
  await manageAntigravity('setup', {
    configRoot, sourceRoot,
    prepare: () => new Promise(() => {
      setInterval(() => {}, 60000)
      process.send('preparing')
    })
  })
`

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'hongguo-install-lock-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const sourceRoot = join(root, 'source'), configRoot = join(root, 'config')
  await mkdir(join(sourceRoot, 'dist/server'), { recursive: true })
  await writeFile(join(sourceRoot, 'dist/server/antigravity.mjs'), '')
  await mkdir(configRoot)
  const prepared = Error('reached media preparation')
  const options = { configRoot, sourceRoot, home: root, env: { HONGGUO_PROGRAM_DIR: join(root, 'program') }, log() {}, prepare: () => { throw prepared },
    removeFfmpeg() {}, removeData() {} }
  return { options, prepared, legacyLock: join(configRoot, '.hongguo-install-lock') }
}

for (const signal of ['SIGINT', 'SIGKILL']) {
  test('live installation excludes both installer generations, and its lock recovers after ' + signal, async t => {
    const { options, prepared, legacyLock } = await fixture(t)
    const child = spawn(process.execPath, ['--input-type=module', '-e', pauseDuringSetup, options.configRoot, options.sourceRoot], {
      stdio: ['ignore', 'ignore', 'inherit', 'ipc'],
    })
    const exited = once(child, 'exit')
    try {
      await Promise.race([once(child, 'message'), exited.then(() => { throw Error('installer exited before preparing') })])
      for (const action of ['setup', 'update', 'uninstall'])
        await assert.rejects(manageAntigravity(action, options), /另一个红果安装操作/)
      await assert.rejects(mkdir(legacyLock), { code: 'EEXIST' })
      child.kill(signal)
      await exited
      for (const action of ['setup', 'update'])
        await assert.rejects(manageAntigravity(action, options), error => error === prepared)
      await manageAntigravity('uninstall', options)
      // An older installer can also claim its directory after a normal release.
      await mkdir(legacyLock)
    } finally {
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
      await exited
    }
  })
}

test('an unmarked legacy directory is preserved until the old installation has been checked', async t => {
  const { options, legacyLock } = await fixture(t)
  await mkdir(legacyLock)
  await assert.rejects(manageAntigravity('uninstall', options), /旧版.*退出.*空目录/)
  assert.ok((await stat(legacyLock)).isDirectory())
  await rmdir(legacyLock)
  await manageAntigravity('uninstall', options)
})
