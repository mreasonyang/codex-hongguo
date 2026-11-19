import { constants } from 'node:fs'
import { copyFile, cp, lstat, mkdir, mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { setTimeout as sleep } from 'node:timers/promises'
import { configuredBase, plainDirectory } from '../runtime/plain-directory.mjs'
import { marketplaceName, npmPackageName } from '../runtime/distribution.mjs'
import { isVersion } from '../runtime/version.mjs'
import { writeProgramShim } from './program-shim.mjs'

const pluginName = 'codex-hongguo'
const readJson = async file => JSON.parse(await readFile(file, 'utf8'))

// A custom marketplace chooses its payload inside "plugin add". Serialize that
// native step with default installs and uninstalls before entering the store.
export async function withCodexInstall(operation, { env = process.env, home = homedir() } = {}) {
  const profile = configuredBase(path.resolve(env.CODEX_HOME || path.join(home, '.codex')), process.platform, path)
  await mkdir(profile, { recursive: true })
  const lock = path.join(profile, '.hongguo-install.sqlite')
  const previous = await lstat(lock).catch(error => { if (error.code !== 'ENOENT') throw error })
  if (previous && !previous.isFile()) throw Error('Codex 红果安装锁不是普通文件。')
  const db = new DatabaseSync(lock)
  try {
    const deadline = Date.now() + 65 * 60_000
    for (;;) {
      try { db.exec('BEGIN IMMEDIATE'); break } catch (error) {
        if (error.errcode !== 5 || Date.now() >= deadline) throw error
        await sleep(100)
      }
    }
    return await operation()
  } finally { db.close() }
}

export async function writeCodexAdapter(directory, { sourceRoot, programRoot, programHome, platform = process.platform }) {
  const entries = ['.codex-plugin', '.mcp.json', 'hooks', 'skills', 'assets', 'docs/providers.md']
  for (const entry of entries) {
    const target = path.join(directory, entry)
    await mkdir(path.dirname(target), { recursive: true })
    await cp(path.join(sourceRoot, entry), target, { recursive: true, mode: constants.COPYFILE_FICLONE })
  }
  const { name, version, license, engines, os } = await readJson(path.join(sourceRoot, 'package.json'))
  await writeFile(path.join(directory, 'package.json'), JSON.stringify({ name, version, license, engines, os, type: 'module' }, null, 2) + '\n')
  await mkdir(path.join(directory, 'bin'))
  const launchers = platform === 'win32' ? ['run-node.exe', 'run-node-arm64.exe'] : ['run-node']
  for (const name of launchers) {
    await copyFile(path.join(programRoot, 'bin', name), path.join(directory, 'bin', name), constants.COPYFILE_FICLONE)
  }
  for (const entry of ['dist/server/index.mjs', 'dist/hooks/write.mjs', 'dist/setup/check.mjs', 'bin/codex-hongguo.mjs']) {
    await writeProgramShim(path.join(directory, entry), programHome, entry)
  }
}

// Use the native add receipt, not its marketplace source path. Verify ownership
// before replacing anything, including when CODEX_HOME is an intentional alias.
export async function nativeProgramSource(receipt, { env = process.env, home = homedir() } = {}) {
  if (receipt?.pluginId !== pluginName + '@' + marketplaceName || typeof receipt.installedPath !== 'string' || !path.isAbsolute(receipt.installedPath))
    throw Error('Codex 未返回可核验的插件安装目录，请更新 Codex CLI 后重试。')
  const profile = configuredBase(path.resolve(env.CODEX_HOME || path.join(home, '.codex')), process.platform, path)
  const base = path.join(profile, 'plugins', 'cache', marketplaceName, pluginName)
  const installed = path.resolve(receipt.installedPath)
  if (path.relative(base, path.dirname(installed)) !== '' || !await plainDirectory(installed, path))
    throw Error('Codex 返回的安装目录不在红果插件缓存内，已保留原生安装。')
  const manifest = await readJson(path.join(installed, '.codex-plugin', 'plugin.json'))
  if (manifest.name !== pluginName)
    throw Error('Codex 红果插件清单与安装记录不一致，已保留原生安装。')
  let pkg
  try { pkg = await readJson(path.join(installed, 'package.json')) } catch (error) { if (error.code !== 'ENOENT') throw error }
  if (pkg?.hongguoSharedProgram !== 1) return null
  if (pkg.name !== npmPackageName || pkg.version !== receipt.version || manifest.version !== receipt.version || !isVersion(pkg.version))
    throw Error('自定义市场的共享程序标记与发行信息不一致，已保留原生安装。')
  return installed
}

// The backup remains usable until the shared program transaction commits.
// Stage on the same filesystem so publication and recovery are renames.
export async function replaceDirectory(destination, operation) {
  const parent = path.dirname(destination)
  await mkdir(parent, { recursive: true })
  if (!await plainDirectory(parent, path)) throw Error('红果安装目录的父级被其他文件或链接占用。')
  const staging = await mkdtemp(path.join(parent, '.hongguo-stage-'))
  const candidate = path.join(staging, 'new'), previous = path.join(staging, 'old')
  let backedUp = false, installed = false, keepBackup = false
  try {
    await operation(async write => {
      await mkdir(candidate)
      await write(candidate)
      const old = await lstat(destination).catch(error => { if (error.code !== 'ENOENT') throw error })
      if (old) {
        if (!old.isDirectory() || old.isSymbolicLink()) throw Error('红果安装目录已被替换，已停止安装。')
        await rename(destination, previous)
        backedUp = true
      }
      await rename(candidate, destination)
      installed = true
    })
  } catch (error) {
    try {
      if (installed) await rename(destination, candidate)
      if (backedUp) await rename(previous, destination)
    } catch {
      keepBackup = true
      throw Error('红果安装未完成，原有文件保存在 ' + staging + '，请关闭使用插件的会话后重试。')
    }
    throw error
  } finally {
    if (!keepBackup) await rm(staging, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
  }
}
