import { lstat, rm, unlink } from 'node:fs/promises'
import { homedir } from 'node:os'
import { posix, win32 } from 'node:path'
import { dataRoot } from '../server/paths.mjs'

export async function removeUserData(options = {}) {
  const { env = process.env, home = homedir(), platform = process.platform } = options
  const paths = platform === 'win32' ? win32 : posix
  const root = paths.resolve(dataRoot({ env, home, platform }))
  const defaultRoot = paths.resolve(dataRoot({ env: { ...env, HONGGUO_DATA_DIR: undefined }, home, platform }))
  // An explicit shared directory reserves these names for Hongguo, but its other files are not ours.
  const targets = root === defaultRoot ? [root] : [
    'player.sqlite', 'player.sqlite-wal', 'player.sqlite-shm', 'player.sqlite-journal',
    'media', 'panel-media', 'device',
  ].map(name => paths.join(root, name))
  let failed = false
  for (const target of targets) {
    try {
      for (let parent = paths.dirname(target); ; parent = paths.dirname(parent)) {
        const info = await lstat(parent)
        if (!info.isDirectory() || info.isSymbolicLink()) throw Error('Substituted data ancestor')
        if (paths.dirname(parent) === parent) break
      }
      const info = await lstat(target)
      if (info.isDirectory() && !info.isSymbolicLink()) await rm(target, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
      else await unlink(target)
    } catch (error) { if (error.code !== 'ENOENT') failed = true }
  }
  if (failed) throw Error('插件已卸载，但本地数据清理失败。请关闭播放器并检查数据目录权限后，重新运行 uninstall。')
}
