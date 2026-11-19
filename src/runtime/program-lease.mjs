import fs from 'node:fs'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { DatabaseSync } from 'node:sqlite'
import { pathToFileURL } from 'node:url'

const launcherName = 'server-lease-v1.mjs'
const launcherMarker = '// @kyun.si/codex-hongguo shared server launcher v1\n'

// The same small implementation runs in the installer and the standalone
// server launcher. Keep its dependencies explicit: npm bundles the installer,
// whereas an already running server must still release its lease after updates.
function programLeases(fs, path, DatabaseSync, pathToFileURL) {
  const info = name => fs.lstatSync(name, { throwIfNoEntry: false })
  const leasePath = root => path.join(root, '.server-lease.sqlite')
  const busy = error => [5, 6].includes(error.errcode)

  function prepare(root) {
    const file = leasePath(root), existing = info(file)
    if (existing && !existing.isFile()) throw Error('共享程序租约文件无效。')
    const db = new DatabaseSync(file)
    try {
      if (!db.prepare("SELECT 1 FROM sqlite_schema WHERE type='table' AND name='state'").get())
        db.exec('BEGIN; CREATE TABLE state(retired INTEGER NOT NULL); INSERT INTO state VALUES(0); COMMIT')
      else if (db.prepare('SELECT retired FROM state').get().retired) db.exec('UPDATE state SET retired=0')
    } finally { db.close() }
  }

  // Commit the retirement before closing the database and removing the tree.
  // A racing reader either holds a read lock already or sees retired=1. Even
  // a stale handle cannot resurrect a deleted build when its hash is reused.
  function markRetired(root) {
    const file = leasePath(root), stat = info(file)
    if (stat) {
      if (!stat.isFile()) throw Error('共享程序租约文件无效。')
      const db = new DatabaseSync(file)
      try {
        db.exec('BEGIN EXCLUSIVE; UPDATE state SET retired=1; COMMIT')
      } catch (error) {
        if (busy(error)) return false
        throw error
      } finally { db.close() }
    }
    return true
  }
  function retire(root) {
    if (!markRetired(root)) return false
    fs.rmSync(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 })
    return true
  }

  function release(home, root, id, reader) {
    reader.close()
    // A lifecycle operation owns the same lock while publishing or pruning.
    // It also retries collection, including when a reader was killed outright.
    if (!info(path.join(home, 'program.sqlite'))?.isFile()) return
    const registry = new DatabaseSync(path.join(home, 'program.sqlite'))
    try {
      registry.exec('PRAGMA busy_timeout=1500; BEGIN IMMEDIATE')
      if (registry.prepare('SELECT id FROM active').get()?.id === id) return
      if (!info(root)?.isDirectory() || path.relative(home, fs.realpathSync(home)) ||
          !info(path.dirname(root))?.isDirectory()) return
      const markerPath = path.join(root, '.hongguo-program.json')
      if (!info(markerPath)?.isFile()) return
      const marker = JSON.parse(fs.readFileSync(markerPath, 'utf8'))
      if (marker.id !== id || marker.owner !== '@kyun.si/codex-hongguo') return
      if (retire(root)) {
        try { fs.rmdirSync(path.dirname(root)) } catch (error) { if (!['ENOTEMPTY', 'EEXIST'].includes(error.code)) throw error }
      }
    } finally { registry.close() }
  }

  async function start(home, entry) {
    const pointer = path.join(home, 'current.json')
    const current = () => {
      const relative = JSON.parse(fs.readFileSync(pointer, 'utf8')).directory
      if (typeof relative !== 'string' || !/^builds\/[a-f0-9]{64}$/.test(relative)) throw Error('共享程序登记无效。')
      return relative
    }
    const deadline = Date.now() + 5000
    do {
      const relative = current(), root = path.join(home, relative)
      let reader, pinned
      try {
        reader = new DatabaseSync(leasePath(root), { readOnly: true })
        reader.exec('BEGIN')
        if (!reader.prepare('SELECT retired FROM state').get().retired && current() === relative) {
          pinned = reader
          reader = undefined
        }
      } catch (error) {
        // Replacing a damaged active build can briefly move the old directory
        // before publishing its verified replacement at the same hash.
        if (current() === relative && !busy(error) && error.errcode !== 14 && error.code !== 'ENOENT') throw error
      } finally { reader?.close() }
      if (pinned) {
        process.once('exit', () => {
          try { release(home, root, relative.slice(7), pinned) } catch { /* Retry collection on the next lifecycle operation. */ }
        })
        return import(pathToFileURL(path.join(root, entry)).href)
      }
      await new Promise(resolve => setTimeout(resolve, 10))
    } while (Date.now() < deadline)
    throw Error('共享程序正在更新或不可用，请重新启动红果服务。')
  }

  return { prepare, markRetired, retire, start }
}

export const { prepare: prepareServerLease, markRetired, retire: retireProgramBuild } = programLeases(fs, path, DatabaseSync, pathToFileURL)
const launcher = launcherMarker + "import fs from 'node:fs'\nimport path from 'node:path'\nimport { DatabaseSync } from 'node:sqlite'\nimport { pathToFileURL } from 'node:url'\n" +
  'export const { start } = (' + programLeases.toString() + ')(fs, path, DatabaseSync, pathToFileURL)\n'

export async function ensureServerLauncher(home) {
  const file = path.join(home, launcherName), stat = fs.lstatSync(file, { throwIfNoEntry: false })
  if (stat) {
    if (!stat.isFile()) throw Error('共享程序启动器路径已被占用。')
    const old = await fs.promises.readFile(file, 'utf8')
    if (old === launcher) return
    if (!old.startsWith(launcherMarker)) throw Error('共享程序启动器路径已被占用。')
  }
  const staging = file + '.' + randomUUID()
  try {
    await fs.promises.writeFile(staging, launcher, { flag: 'wx', mode: 0o600 })
    await fs.promises.rename(staging, file)
  } finally { await fs.promises.rm(staging, { force: true }) }
}

export async function removeServerLauncher(home) {
  const file = path.join(home, launcherName)
  if (fs.lstatSync(file, { throwIfNoEntry: false })?.isFile() && (await fs.promises.readFile(file, 'utf8')).startsWith(launcherMarker))
    await fs.promises.unlink(file)
}

export function leasedProgramEntry(home, entry) {
  return '#!/usr/bin/env node\nimport { start } from ' + JSON.stringify(pathToFileURL(path.join(home, launcherName)).href) +
    '\nawait start(' + JSON.stringify(home) + ', ' + JSON.stringify(entry) + ')\n'
}
