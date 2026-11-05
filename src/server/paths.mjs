import { homedir } from 'node:os'
import { posix, win32 } from 'node:path'
import { fileURLToPath } from 'node:url'

export const projectRoot = fileURLToPath(new URL('../../', import.meta.url))
export function dataRoot({ env = process.env, home = homedir(), platform = process.platform } = {}) {
  const { join } = platform === 'win32' ? win32 : posix
  if (env.HONGGUO_DATA_DIR) return env.HONGGUO_DATA_DIR
  if (platform === 'darwin') return join(home, 'Library', 'Application Support', 'CodexHongguo')
  if (platform === 'win32') return join(env.LOCALAPPDATA || join(home, 'AppData', 'Local'), 'CodexHongguo')
  return join(env.XDG_DATA_HOME || join(home, '.local', 'share'), 'codex-hongguo')
}
