import { closeSync, lstatSync, openSync, unlinkSync } from 'node:fs'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'

// Keep this database at a stable path. Unlinking a locked database would let
// another process lock a different inode while this installation is still live.
export function lockAntigravityInstall(configRoot) {
  const databasePath = join(configRoot, '.hongguo-install.sqlite')
  const existing = lstatSync(databasePath, { throwIfNoEntry: false })
  if (existing && !existing.isFile()) throw Error('红果安装锁文件不是普通文件：' + databasePath)
  const db = new DatabaseSync(databasePath)
  const legacyPath = join(configRoot, '.hongguo-install-lock')
  try {
    db.exec('BEGIN EXCLUSIVE')
    // Older installers acquire this name with mkdir. A regular file blocks
    // them too and distinguishes our recoverable guard from their directory.
    try { closeSync(openSync(legacyPath, 'wx', 0o600)) } catch (error) {
      const guard = lstatSync(legacyPath, { throwIfNoEntry: false })
      if (guard?.isDirectory())
        throw Error('检测到旧版红果安装锁。请确认所有旧版红果安装命令均已退出，再删除这个空目录并重试：' + legacyPath)
      if (error.code !== 'EEXIST' || !guard) throw error
      if (!guard.isFile() || guard.size !== 0) throw Error('红果安装锁路径被其他文件占用：' + legacyPath)
      // The SQLite lock is ours, so the previous process that created this
      // empty guard has exited. Keep the guard in place until release.
    }
  } catch (error) {
    db.close()
    if (error.errcode === 5 || error.errcode === 6) throw Error('另一个红果安装操作尚未完成；请稍后重试。')
    throw error
  }
  return () => {
    try { unlinkSync(legacyPath) } finally { db.close() }
  }
}
