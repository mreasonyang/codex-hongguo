import { homedir } from 'node:os'
import { posix, win32 } from 'node:path'
import { fileURLToPath } from 'node:url'
import { antigravity, codex } from '../runtime/host.mjs'
import { configuredBase } from '../runtime/plain-directory.mjs'

export const projectRoot = fileURLToPath(new URL('../../', import.meta.url))
export function dataRoot({ host = codex, env = process.env, home = homedir(), platform = process.platform } = {}) {
  const paths = platform === 'win32' ? win32 : posix
  const defaultFor = app => {
    if (platform === 'darwin') return paths.join(home, 'Library', 'Application Support', app.dataName)
    if (platform === 'win32') return paths.join(env.LOCALAPPDATA || paths.join(home, 'AppData', 'Local'), app.dataName)
    return paths.join(env.XDG_DATA_HOME || paths.join(home, '.local', 'share'), app.cacheName)
  }
  const codexRoot = env.HONGGUO_DATA_DIR || defaultFor(codex)
  const antigravityRoot = env.HONGGUO_ANTIGRAVITY_DATA_DIR || defaultFor(antigravity)
  if (env.HONGGUO_DATA_DIR || env.HONGGUO_ANTIGRAVITY_DATA_DIR) {
    const canonical = path => configuredBase(paths.resolve(path), platform, paths)
    const codexPath = canonical(codexRoot), antigravityPath = canonical(antigravityRoot)
    const relative = paths.relative(codexPath, antigravityPath)
    const reverse = paths.relative(antigravityPath, codexPath)
    const nested = path => !paths.isAbsolute(path) && path !== '..' && !path.startsWith('..' + paths.sep)
    if (nested(relative) || nested(reverse)) throw Error('Codex 和 Antigravity 的数据目录必须分开。请为两个宿主指定不同且互不包含的目录。')
  }
  return host.id === antigravity.id ? antigravityRoot : codexRoot
}
