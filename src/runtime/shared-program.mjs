import { createHash, randomUUID } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { chmod, copyFile, lstat, mkdir, mkdtemp, open, readFile, readdir, realpath, rename, rm, rmdir, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join, posix, win32 } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { setTimeout as sleep } from 'node:timers/promises'
import { codex, hostProfile } from './host.mjs'
import { configuredBase, plainDirectory } from './plain-directory.mjs'
import { ensureServerLauncher, markRetired, prepareServerLease, removeServerLauncher, retireProgramBuild } from './program-lease.mjs'

const owner = '@kyun.si/codex-hongguo'
const buildMarker = '.hongguo-program.json'
const buildName = /^[a-f0-9]{64}$/
const required = ['dist', 'bin', 'package.json', 'LICENSE', 'COPYING', 'NOTICE']
const optional = ['.codex-plugin', '.mcp.json', 'hooks', '.antigravity-plugin', 'mcp_config.json', 'hooks.json',
  'assets', 'skills', 'sidecars', 'provider-kit', 'licenses', 'docs/providers.md', 'README.md', 'README.en.md']
const windowsLaunchers = ['run-node.exe', 'run-node-arm64.exe']
const modeFor = name => /^bin\/(run-node(?:-arm64)?(?:\.exe)?|(?:codex|antigravity)-hongguo\.mjs)$/.test(name) ? 0o755 : 0o644

export function sharedProgramHome({ env = process.env, home = homedir(), platform = process.platform } = {}) {
  const paths = platform === 'win32' ? win32 : posix
  const base = path => {
    if (!paths.isAbsolute(path)) throw Error('共享程序目录需要使用绝对路径。')
    return configuredBase(path, platform, paths)
  }
  if (env.HONGGUO_PROGRAM_DIR) return base(env.HONGGUO_PROGRAM_DIR)
  if (platform === 'darwin') return paths.join(base(home), 'Library', 'Application Support', 'HongguoShared', 'program')
  if (platform === 'win32') return paths.join(base(env.LOCALAPPDATA || paths.join(home, 'AppData', 'Local')), 'HongguoShared', 'program')
  return paths.join(base(env.XDG_DATA_HOME || paths.join(home, '.local', 'share')), 'hongguo-shared', 'program')
}

async function info(path) {
  try { return await lstat(path) } catch (error) { if (error.code !== 'ENOENT') throw error }
}
async function directory(path) {
  if (!await info(path)) {
    await directory(dirname(path))
    try { await mkdir(path, { mode: 0o700 }) } catch (error) { if (error.code !== 'EEXIST') throw error }
  }
  if (!await plainDirectory(path, process.platform === 'win32' ? win32 : posix)) throw Error('共享程序目录被其他文件或链接占用。')
}
async function json(path) {
  if (!(await info(path))?.isFile()) throw Error('共享程序元数据不是普通文件。')
  return JSON.parse(await readFile(path, 'utf8'))
}

// Normalize the checkout and npm layouts. Only explicit distribution entries
// participate; build scripts, local dependencies, and user files stay outside.
async function inventory(root) {
  const entries = new Map()
  async function visit(name, source, stat) {
    if (stat.isFile()) { entries.set(name, source); return }
    if (!stat.isDirectory()) throw Error('共享程序包含不支持的目录链接或文件：' + name)
    entries.set(name, null)
    for (const child of await readdir(source)) {
      const relative = name + '/' + child
      if (relative === 'dist/launcher') continue
      const path = join(source, child)
      await visit(relative, path, await lstat(path))
    }
  }
  for (const name of [...required, ...optional]) {
    if (name === 'docs/providers.md') {
      const docs = await info(join(root, 'docs'))
      if (docs && !docs.isDirectory()) throw Error('共享程序文档目录不是普通目录。')
    }
    const source = join(root, name), stat = await info(source)
    if (stat) await visit(name, source, stat)
    else if (required.includes(name)) throw Error('共享程序缺少必要文件：' + name)
  }
  for (const name of windowsLaunchers) {
    if (entries.has('bin/' + name)) continue
    const launcher = join(root, 'dist', 'launcher')
    const stat = await info(launcher)
    if (!stat) continue
    if (!stat.isDirectory()) throw Error('Windows 启动器目录不是普通目录。')
    const fallback = join(launcher, name), file = await info(fallback)
    if (file) await visit('bin/' + name, fallback, file)
  }
  return entries
}
async function contentId(entries) {
  const hash = createHash('sha256')
  for (const name of [...entries.keys()].sort()) {
    const path = entries.get(name)
    let digest = null
    if (path) {
      const file = createHash('sha256')
      for await (const bytes of createReadStream(path)) file.update(bytes)
      digest = file.digest('hex')
    }
    hash.update(JSON.stringify([name, digest]) + '\n')
  }
  return hash.digest('hex')
}
async function ownedBuild(root, id) {
  if (!(await info(root))?.isDirectory()) return false
  const marker = join(root, buildMarker)
  if (!(await info(marker))?.isFile()) return false
  const receipt = await json(marker)
  return receipt.owner === owner && receipt.id === id
}
async function recoverStaging(home, active) {
  const builds = join(home, 'builds')
  if (!await info(builds)) return
  await directory(builds)
  for (const name of await readdir(builds)) {
    if (!/^(?:\.stage-[a-zA-Z0-9]{6}|\.replaced-[a-f0-9-]{36})$/.test(name)) continue
    const path = join(builds, name)
    if (!(await info(path))?.isDirectory() || !(await info(join(path, buildMarker)))?.isFile()) continue
    const receipt = await json(join(path, buildMarker))
    if (receipt.owner !== owner || !buildName.test(receipt.id)) continue
    const installed = join(builds, receipt.id)
    if (name.startsWith('.replaced-') && receipt.id === active && !await info(installed)) {
      await rename(path, installed)
      prepareServerLease(installed)
    } else {
      if (name.startsWith('.stage-') && receipt.id === active && await ownedBuild(installed, active))
        prepareServerLease(installed)
      await rm(path, { recursive: true, force: true })
    }
  }
}
async function prepareBuild(home, sourceRoot) {
  const source = await realpath(sourceRoot)
  const entries = await inventory(source), id = await contentId(entries)
  const builds = join(home, 'builds'), root = join(builds, id)
  await directory(builds)
  const existing = await info(root)
  if (existing) {
    if (!await ownedBuild(root, id)) throw Error('共享程序的构建目录已被其他文件占用。')
    if (root === source || await contentId(await inventory(root)).catch(() => null) === id) return id
  }
  if (dirname(source) === builds && await info(join(source, buildMarker)))
    throw Error('已安装的共享程序内容发生变化，请从发行包重新运行安装。')
  const stage = await mkdtemp(join(builds, '.stage-'))
  const displaced = join(builds, '.replaced-' + randomUUID())
  try {
    await writeFile(join(stage, buildMarker), JSON.stringify({ owner, id }), { mode: 0o600 })
    for (const [name, path] of entries) {
      const destination = join(stage, name)
      if (!path) { await mkdir(destination, { recursive: true }); continue }
      await mkdir(dirname(destination), { recursive: true })
      await copyFile(path, destination)
      await chmod(destination, modeFor(name))
    }
    if (await contentId(await inventory(stage)) !== id) throw Error('安装源在复制过程中发生变化，请重试。')
    prepareServerLease(stage) // A replacement at the active hash must be leasable immediately after rename.
    if (existing) {
      if (!markRetired(root)) throw Error('正在运行的红果服务使用了损坏的构建，请重启服务后重新安装。')
      try { await rename(root, displaced) } catch (error) { prepareServerLease(root); throw error }
    }
    try { await rename(stage, root) } catch (error) {
      if (existing) { await rename(displaced, root); prepareServerLease(root) }
      throw error
    }
    if (existing) await rm(displaced, { recursive: true, force: true })
    return id
  } finally { await rm(stage, { recursive: true, force: true }) }
}
async function writePointer(home, id) {
  const pointer = join(home, 'current.json')
  const stat = await info(pointer)
  if (stat) {
    const value = await json(pointer)
    if (typeof value.directory !== 'string' || !/^builds\/[a-f0-9]{64}$/.test(value.directory))
      throw Error('共享程序的 current.json 已被其他文件占用。')
    if (id && value.directory === 'builds/' + id) return
    if (!id) { await rm(pointer); return }
  } else if (!id) return
  if (!buildName.test(id)) throw Error('共享程序登记无效。')
  const temp = join(home, '.current-' + randomUUID())
  try {
    await writeFile(temp, JSON.stringify({ directory: 'builds/' + id }) + '\n', { flag: 'wx', mode: 0o600 })
    await rename(temp, pointer)
  } finally { await rm(temp, { force: true }) }
}
async function prune(home, active) {
  if (!active) await removeServerLauncher(home)
  const builds = join(home, 'builds')
  if (!await info(builds)) return
  await directory(builds)
  for (const name of await readdir(builds)) {
    if (name === active) continue
    const path = join(builds, name)
    if (buildName.test(name) && await ownedBuild(path, name)) retireProgramBuild(path)
  }
  try { await rmdir(builds) } catch (error) { if (!['ENOTEMPTY', 'EEXIST'].includes(error.code)) throw error }
}
async function lock(db) {
  const deadline = Date.now() + 65 * 60_000
  for (;;) {
    try { db.exec('BEGIN IMMEDIATE'); return } catch (error) {
      if (![5, 6].includes(error.errcode) || Date.now() >= deadline) throw error
      await sleep(100)
    }
  }
}
const activeId = db => db.prepare('SELECT id FROM active').get()?.id
async function withProgram(options, change) {
  const host = hostProfile((options.host ?? codex).id)
  const home = sharedProgramHome(options)
  await directory(home)
  const path = join(home, 'program.sqlite')
  try { await (await open(path, 'wx', 0o600)).close() } catch (error) {
    if (error.code !== 'EEXIST' || !(await info(path))?.isFile()) throw error
  }
  // Never unlink this database: another process may already be waiting on its inode.
  const db = new DatabaseSync(path)
  try {
    await lock(db)
    db.exec('CREATE TABLE IF NOT EXISTS owners(host TEXT PRIMARY KEY); CREATE TABLE IF NOT EXISTS active(id TEXT PRIMARY KEY)')
    const previous = activeId(db)
    await recoverStaging(home, previous)
    await writePointer(home, previous) // Recover an interrupted publish before changing the next adapter.
    let result
    try {
      result = await change({ db, home, host, previous })
      db.exec('COMMIT')
    } catch (error) {
      await writePointer(home, previous)
      await prune(home, previous).catch(() => {}) // An occupied orphan can be collected by the next installation.
      throw error // closing the connection rolls back host registration
    }
    // Commit ownership before deleting the former version. Reacquire the lock
    // and reread active in case another installer committed in the meantime.
    try {
      await lock(db)
      await prune(home, activeId(db))
      db.exec('COMMIT')
    } catch (error) {
      // A committed publish must not tell the adapter to roll back. Old files
      // temporarily held by Windows can be retried by a later setup or uninstall.
      if (!result) throw Error('宿主已卸载并完成注销，部分共享程序文件仍未清理。请关闭播放器并重新运行 uninstall。', { cause: error })
    }
    return result
  } finally { db.close() }
}

export async function installSharedProgram(options, publish) {
  return withProgram(options, async ({ db, home, host }) => {
    const id = await prepareBuild(home, options.sourceRoot)
    const result = { programHome: home, programRoot: join(home, 'builds', id) }
    prepareServerLease(result.programRoot)
    await ensureServerLauncher(home)
    await writePointer(home, id)
    await publish(result)
    db.prepare('INSERT OR IGNORE INTO owners VALUES(?)').run(host.id)
    db.exec('DELETE FROM active')
    db.prepare('INSERT INTO active VALUES(?)').run(id)
    return result
  })
}

export async function removeSharedProgram(options, removeAdapter) {
  return withProgram(options, async ({ db, home, host, previous }) => {
    await removeAdapter?.({ programHome: home, programRoot: previous ? join(home, 'builds', previous) : undefined })
    db.prepare('DELETE FROM owners WHERE host=?').run(host.id)
    if (!db.prepare('SELECT 1 FROM owners LIMIT 1').get()) {
      await writePointer(home)
      db.exec('DELETE FROM active')
    }
  })
}
