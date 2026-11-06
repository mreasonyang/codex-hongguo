import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, realpath, mkdir, writeFile, readFile, lstat, rm, symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { dataRoot } from '../src/server/paths.mjs'
import { removeUserData } from '../src/runtime/uninstall-data.mjs'

async function fixture(t) {
  const home = await realpath(await mkdtemp(join(tmpdir(), 'hongguo-uninstall-data-')))
  t.after(() => rm(home, { recursive: true, force: true }))
  const options = { home, env: {} }, root = dataRoot(options)
  await mkdir(root, { recursive: true })
  return { home, root, options }
}

test('uninstall removes all default user data, including corrupt databases, caches, device profiles and partial files', async t => {
  const { root, options } = await fixture(t)
  for (const file of ['player.sqlite', 'player.sqlite-wal', 'player.sqlite-shm', 'player.sqlite-journal', 'unfinished-file']) await writeFile(join(root, file), 'data')
  for (const folder of ['media', 'panel-media', 'device']) {
    await mkdir(join(root, folder)); await writeFile(join(root, folder, 'file'), 'data')
  }
  await removeUserData(options)
  await assert.rejects(lstat(root), { code: 'ENOENT' })
  await removeUserData(options)
})

test('a custom data directory loses all plugin data but keeps unrelated user files', async t => {
  const { home, options } = await fixture(t)
  const root = join(home, 'shared')
  await mkdir(root)
  await writeFile(join(root, 'user-file'), 'keep')
  for (const file of ['player.sqlite', 'player.sqlite-wal', 'player.sqlite-shm', 'player.sqlite-journal']) await writeFile(join(root, file), 'data')
  for (const folder of ['media', 'panel-media', 'device']) {
    await mkdir(join(root, folder)); await writeFile(join(root, folder, 'file'), 'data')
  }
  await removeUserData({ ...options, env: { HONGGUO_DATA_DIR: root } })
  assert.equal(await readFile(join(root, 'user-file'), 'utf8'), 'keep')
  for (const file of ['player.sqlite', 'player.sqlite-wal', 'player.sqlite-shm', 'player.sqlite-journal', 'media', 'panel-media', 'device']) await assert.rejects(lstat(join(root, file)), { code: 'ENOENT' })
})

test('default data links and links inside the data directory are deleted without deleting external targets', { skip: process.platform === 'win32' }, async t => {
  for (const linkRoot of [false, true]) {
    const { home, root, options } = await fixture(t)
    const outside = join(home, linkRoot ? 'outside-root' : 'outside-cache')
    await mkdir(outside); await writeFile(join(outside, 'file'), 'keep')
    if (linkRoot) { await rm(root, { recursive: true }); await symlink(outside, root) }
    else await symlink(outside, join(root, 'media'))
    await removeUserData(options)
    await assert.rejects(lstat(root), { code: 'ENOENT' })
    assert.equal(await readFile(join(outside, 'file'), 'utf8'), 'keep')
  }
})
