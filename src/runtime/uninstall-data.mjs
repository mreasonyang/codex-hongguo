import { lstat, rm, unlink } from 'node:fs/promises'
import { homedir } from 'node:os'
import { posix, win32 } from 'node:path'
import { dataRoot } from '../server/paths.mjs'
import { codex } from './host.mjs'
import { configuredBase, plainDirectory } from './plain-directory.mjs'

export async function removeUserData(options = {}) {
  const { host = codex, env = process.env, home = homedir(), platform = process.platform } = options
  const paths = platform === 'win32' ? win32 : posix
  let root = paths.resolve(dataRoot({ host, env, home, platform }))
  const defaultRoot = paths.resolve(dataRoot({ host, env: { ...env, HONGGUO_DATA_DIR: undefined, HONGGUO_ANTIGRAVITY_DATA_DIR: undefined }, home, platform }))
  const useDefault = root === defaultRoot
  if (useDefault && platform === 'win32' && env.LOCALAPPDATA) {
    root = paths.join(configuredBase(env.LOCALAPPDATA, platform, paths), paths.relative(env.LOCALAPPDATA, root))
  }
  // An explicit shared directory reserves these names for Hongguo, but its other files are not ours.
  const targets = useDefault ? [root] : [
    'player.sqlite', 'player.sqlite-wal', 'player.sqlite-shm', 'player.sqlite-journal',
    'media', 'panel-media', 'dash-media', 'device', 'managed-marketplace', 'provider-library',
  ].map(name => paths.join(root, name))
  let failed = false
  for (const target of targets) {
    try {
      if (!await plainDirectory(paths.dirname(target), paths)) throw Error('Substituted data ancestor')
      const info = await lstat(target)
      if (info.isDirectory() && !info.isSymbolicLink()) await rm(target, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
      else await unlink(target)
    } catch (error) { if (error.code !== 'ENOENT') failed = true }
  }
  if (failed) throw Error('插件已卸载，但本地数据清理失败。请关闭播放器并检查数据目录权限后，重新运行 uninstall。')
}
