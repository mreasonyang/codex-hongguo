import { accessSync, constants } from 'node:fs'
import { homedir } from 'node:os'
import { delimiter, dirname, join, isAbsolute } from 'node:path'

export function findExecutable(name, override, { env = process.env, home = homedir(), platform = process.platform } = {}) {
  if (override) return override
  const directories = [dirname(process.execPath), ...(env.PATH || '').split(delimiter).filter(Boolean)]
  if (platform !== 'win32') directories.push('/opt/homebrew/bin', '/usr/local/bin', '/usr/bin', '/bin', join(home, '.volta/bin'), join(home, '.local/bin'))
  const candidates = directories.filter(isAbsolute).map(dir => join(dir, platform === 'win32' ? name + '.exe' : name))
  if (name === 'codex' && platform === 'darwin') candidates.push('/Applications/Codex.app/Contents/Resources/codex')
  for (const path of candidates) {
    try { accessSync(path, constants.X_OK); return path } catch { /* Try the next known executable location. */ }
  }
  return name
}

export function prepareRuntime() {
  process.env.PATH = [...new Set([dirname(process.execPath), ...(process.env.PATH || '').split(delimiter).filter(Boolean)])].join(delimiter)
  process.env.HONGGUO_FFMPEG = findExecutable('ffmpeg', process.env.HONGGUO_FFMPEG)
  process.env.HONGGUO_CODEX = findExecutable('codex', process.env.HONGGUO_CODEX)
}
