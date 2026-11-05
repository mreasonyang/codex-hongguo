import { homedir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

export const projectRoot = fileURLToPath(new URL('../../', import.meta.url))
export function dataRoot() {
  if (process.env.HONGGUO_DATA_DIR) return process.env.HONGGUO_DATA_DIR
  if (process.platform === 'darwin') return join(homedir(), 'Library', 'Application Support', 'CodexHongguo')
  if (process.platform === 'win32')
    return join(process.env.LOCALAPPDATA || join(homedir(), 'AppData', 'Local'), 'CodexHongguo')
  return join(process.env.XDG_DATA_HOME || join(homedir(), '.local', 'share'), 'codex-hongguo')
}
