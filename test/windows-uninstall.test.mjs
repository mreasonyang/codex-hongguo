import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile, cp, readdir, rm, access } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { once } from 'node:events'
import { createInterface } from 'node:readline'
import { uninstall, codexRunner, pluginId } from '../src/cli/main.mjs'
import { spawn, spawnSync, findExecutable, stopChild } from '../src/runtime/executables.mjs'
import { stopWindowsPluginProcesses } from '../src/runtime/windows-processes.mjs'
import { removeUserData } from '../src/runtime/uninstall-data.mjs'
import { removeManagedFfmpeg } from '../src/runtime/ffmpeg-runtime.mjs'
import { isManagedMarketplace } from '../src/cli/local-marketplace.mjs'

const alive = pid => { try { process.kill(pid, 0); return true } catch { return false } }
const waitGone = async pid => {
  for (let n = 0; n < 50 && alive(pid); n++) await new Promise(resolve => setTimeout(resolve, 100))
  assert.equal(alive(pid), false, 'The plugin-owned process must exit')
}

test('isolated native Windows uninstall stops only owned launchers, deregisters root-only marketplace, removes cache/data and is repeatable', { skip: process.platform !== 'win32', timeout: 180000 }, async t => {
  const cli = findExecutable('codex'), root = await mkdtemp(join(tmpdir(), '红果 uninstall ')), children = []
  t.after(async () => {
    for (const child of children) stopChild(child)
    for (const child of children) if (child.exitCode === null && child.signalCode === null) await Promise.race([once(child, 'close'), new Promise(resolve => setTimeout(resolve, 5000))])
    await rm(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 })
  })
  const home = join(root, 'home'), profile = join(home, '.codex'), local = join(home, 'AppData', 'Local'), data = join(local, 'CodexHongguo')
  const managedRoot = join(data, 'managed-marketplace'), market = join(managedRoot, '0.0.32'), payload = join(market, 'plugins', 'codex-hongguo')
  await mkdir(join(payload, '.codex-plugin'), { recursive: true })
  await mkdir(join(payload, 'bin'), { recursive: true })
  await mkdir(join(payload, 'dist', 'server'), { recursive: true })
  await mkdir(profile, { recursive: true })
  await writeFile(join(payload, '.codex-plugin', 'plugin.json'), JSON.stringify({ name: 'codex-hongguo', version: '0.0.32', mcpServers: './.mcp.json' }))
  await writeFile(join(payload, '.mcp.json'), JSON.stringify({ mcpServers: { 'codex-hongguo': { command: './bin/run-node', args: ['server'] } } }))
  for (const name of ['run-node.exe', 'run-node-arm64.exe']) await cp(join('dist', 'launcher', name), join(payload, 'bin', name))
  await writeFile(join(payload, 'dist', 'server', 'index.mjs'), `import {DatabaseSync} from 'node:sqlite';import {mkdirSync} from 'node:fs';import {join} from 'node:path';mkdirSync(process.env.HONGGUO_DATA_DIR,{recursive:true});const db=new DatabaseSync(join(process.env.HONGGUO_DATA_DIR,'player.sqlite'));db.exec('PRAGMA journal_mode=WAL;CREATE TABLE IF NOT EXISTS fixture(id INTEGER)');console.log(JSON.stringify({ready:true,nodePid:process.pid}));setInterval(()=>{},1000);`)
  await mkdir(join(market, '.agents', 'plugins'), { recursive: true })
  await writeFile(join(market, '.agents', 'plugins', 'marketplace.json'), JSON.stringify({ name: 'hongguo-local', plugins: [{ name: 'codex-hongguo', source: { source: 'local', path: './plugins/codex-hongguo' }, policy: { installation: 'AVAILABLE', authentication: 'ON_INSTALL' }, category: 'Entertainment' }] }))
  const noGit = join(root, 'no-git'); await mkdir(noGit)
  await writeFile(join(noGit, 'git.cmd'), '@echo off\r\nexit /b 127\r\n')
  const env = { ...process.env, HOME: home, USERPROFILE: home, LOCALAPPDATA: local, APPDATA: join(home, 'AppData', 'Roaming'), CODEX_HOME: profile, HONGGUO_DATA_DIR: data, HONGGUO_NODE: process.execPath, HONGGUO_CODEX: cli, PATH: noGit + ';' + (process.env.PATH || process.env.Path) }
  const nativeRun = codexRunner(cli, env)
  nativeRun(['plugin', 'marketplace', 'add', market]); nativeRun(['plugin', 'add', pluginId])
  const cache = join(profile, 'plugins', 'cache', 'hongguo-local', 'codex-hongguo')
  const copies = (await readdir(cache, { withFileTypes: true })).filter(entry => entry.isDirectory())
  assert.equal(copies.length, 1)
  const installedRoot = join(cache, copies[0].name)
  const start = async (plugin, dataDirectory) => {
    const child = spawn(join(plugin, 'bin', 'run-node.exe'), ['server'], { env: { ...env, HONGGUO_DATA_DIR: dataDirectory }, stdio: ['pipe', 'pipe', 'ignore'], windowsHide: true })
    children.push(child)
    const reader = createInterface({ input: child.stdout })
    let timer
    try {
      const [line] = await Promise.race([once(reader, 'line'), new Promise((_, reject) => { timer = setTimeout(() => reject(Error('Fixture launcher did not become ready')), 15000) })])
      const ready = JSON.parse(line)
      assert.equal(ready.ready, true)
      return { child, nodePid: ready.nodePid }
    } finally { clearTimeout(timer); reader.close() }
  }
  const owned = await start(installedRoot, data)
  const outsideRoot = cache + '-outside'
  await cp(payload, outsideRoot, { recursive: true })
  const outside = await start(outsideRoot, join(root, 'outside-data'))
  const sharedNode = spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { stdio: 'ignore', windowsHide: true }); children.push(sharedNode)
  assert.equal(alive(owned.child.pid), true)
  let rootOnlySeen = false
  const run = args => {
    if (args[1] === 'remove') {
      assert.equal(alive(owned.child.pid), false, 'Stop the owned launcher before native cache removal')
      assert.equal(alive(outside.child.pid), true, 'Never stop a same-name executable outside the plugin cache')
      assert.equal(alive(sharedNode.pid), true, 'Never stop shared Node by name')
    }
    const result = nativeRun(args)
    if (args[1] === 'marketplace' && args[2] === 'list') result.marketplaces = result.marketplaces.map(row => {
      if (row.name !== 'hongguo-local') return row
      assert.equal(typeof row.root, 'string')
      assert.ok(isManagedMarketplace(row.root, managedRoot), 'Native local root must identify the managed marketplace')
      rootOnlySeen = true
      return { name: row.name, root: row.root }
    })
    return result
  }
  await uninstall({ run, managedRoot, stopProcesses: () => stopWindowsPluginProcesses({ env, home }), removeFfmpeg: () => removeManagedFfmpeg({ env, home }), removeData: () => removeUserData({ env, home }) })
  assert.equal(rootOnlySeen, true)
  await waitGone(owned.nodePid)
  await assert.rejects(access(installedRoot), { code: 'ENOENT' })
  await assert.rejects(access(data), { code: 'ENOENT' })
  assert.ok(!nativeRun(['plugin', 'marketplace', 'list']).marketplaces.some(row => row.name === 'hongguo-local'))
  assert.ok(!nativeRun(['plugin', 'list', '--marketplace', 'hongguo-local']).installed.some(row => row.pluginId === pluginId))
  assert.equal(alive(outside.child.pid), true)
  assert.equal(alive(outside.nodePid), true)
  assert.equal(alive(sharedNode.pid), true)
  const repeated = spawnSync(process.execPath, [resolve('bin/codex-hongguo.mjs'), 'uninstall'], { env, cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 60000 })
  assert.equal(repeated.status, 0, 'Repeated uninstall through the real CLI entry must succeed without Git')
  assert.match(repeated.stdout, /已卸载/)
})
