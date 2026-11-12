// Each running host holds immutable package paths. Only the small active-version
// index changes when a writer installs, rolls back or removes a provider.
import { DatabaseSync } from 'node:sqlite'
import { existsSync, mkdirSync, lstatSync } from 'node:fs'
import { join } from 'node:path'

export function libraryDirectory(root) { return join(root, 'provider-library') }
function withIndex(root, write, run) {
  const directory = libraryDirectory(root), file = join(directory, 'index.sqlite')
  if (!write && !existsSync(file)) return []
  if (write) mkdirSync(directory, { recursive: true, mode: 0o700 })
  const index = lstatSync(file, { throwIfNoEntry: false })
  if (!lstatSync(directory).isDirectory() || (index && !index.isFile())) throw Error('LIBRARY')
  const db = new DatabaseSync(file, { readOnly: !write })
  try {
    db.exec('PRAGMA busy_timeout=5000')
    if (write) db.exec(`BEGIN IMMEDIATE; CREATE TABLE IF NOT EXISTS packages (
      id TEXT PRIMARY KEY, active TEXT NOT NULL, version TEXT NOT NULL, previous TEXT, previousVersion TEXT)`)
    const result = run(db)
    if (write) db.exec('COMMIT')
    return result
  } finally { db.close() }
}
export function installedProviders(root) {
  return withIndex(root, false, db => {
    // A concurrent first installation can have created the DB file just before committing its schema.
    if (!db.prepare("SELECT 1 FROM sqlite_schema WHERE type='table' AND name='packages'").get()) return []
    const rows = db.prepare('SELECT id, active, version, previousVersion FROM packages ORDER BY id').all()
    if (rows.some(row => !/^[0-9a-f-]{36}$/.test(row.active))) throw Error('LIBRARY')
    return rows
  })
}
export function activatePackage(root, action, id, active, version) {
  return withIndex(root, true, db => {
    const current = db.prepare('SELECT * FROM packages WHERE id=?').get(id)
    if (action === 'install') {
      if (current) throw Error('ALREADY_INSTALLED')
      if (db.prepare('SELECT count(*) AS count FROM packages').get().count >= 32) throw Error('LIBRARY_FULL')
      db.prepare('INSERT INTO packages(id,active,version) VALUES(?,?,?)').run(id, active, version)
    } else {
      if (!current) throw Error('NOT_INSTALLED')
      if (action === 'remove') db.prepare('DELETE FROM packages WHERE id=?').run(id)
      else {
        if (action === 'rollback') {
          if (!current.previous) throw Error('NO_PREVIOUS_VERSION')
          active = current.previous; version = current.previousVersion
        }
        db.prepare('UPDATE packages SET active=?,version=?,previous=active,previousVersion=version WHERE id=?').run(active, version, id)
      }
    }
    return { id, version: action === 'remove' ? null : version, reconnect: true }
  })
}
