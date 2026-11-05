import { accessSync, constants, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { posix, win32 } from 'node:path'
import crossSpawn from 'cross-spawn'
import { ffmpegPath } from './ffmpeg-runtime.mjs'

// Keep callers on an argv API; cross-spawn escapes Windows command shims.
export const spawn = crossSpawn
export const spawnSync = crossSpawn.sync

export function stopChild(child) {
  if (!child?.pid || child.exitCode !== null || child.signalCode !== null) return
  child.stdin?.destroy()
  if (process.platform === 'win32') {
    // Killing cmd.exe alone leaves the CLI shim's descendants alive. Target only our own child tree.
    const taskkill = win32.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'taskkill.exe')
    spawnSync(taskkill, ['/pid', String(child.pid), '/t', '/f'], { stdio: 'ignore', timeout: 3000, windowsHide: true })
  } else child.kill()
}

export function findExecutable(name, override, { env = process.env, home = homedir(), platform = process.platform, arch = process.arch } = {}) {
  if (override) return override
  if (name === 'ffmpeg') return ffmpegPath({ env, home, platform, arch })
  const { delimiter, dirname, join, isAbsolute, extname } = platform === 'win32' ? win32 : posix
  const pathKey = Object.keys(env).find(key => key.toUpperCase() === 'PATH') || 'PATH'
  const directories = [dirname(process.execPath), ...(env[pathKey] || '').split(delimiter).filter(Boolean).map(dir => dir.replace(/^"(.*)"$/, '$1'))]
  if (platform !== 'win32') directories.push('/opt/homebrew/bin', '/usr/local/bin', '/usr/bin', '/bin', join(home, '.volta/bin'), join(home, '.local/bin'))
  else directories.push(join(env.APPDATA || join(home, 'AppData', 'Roaming'), 'npm'), join(home, '.volta', 'bin'))
  // Prefer native binaries, then command shims. Never select PowerShell scripts or a relative PATH.
  const extensions = platform !== 'win32' || extname(name) ? [''] : ['.exe', '.com', '.cmd', '.bat']
  const candidates = directories.filter(isAbsolute).flatMap(dir => extensions.map(extension => join(dir, name + extension)))
  if (name === 'codex' && platform === 'darwin') candidates.push('/Applications/Codex.app/Contents/Resources/codex')
  for (const path of candidates) {
    try {
      accessSync(path, platform === 'win32' ? constants.F_OK : constants.X_OK)
      if (statSync(path).isFile()) return path
    } catch { /* Try the next known executable location. */ }
  }
  return name
}

export function prepareRuntime() {
  const { delimiter, dirname } = process.platform === 'win32' ? win32 : posix
  const pathKey = Object.keys(process.env).find(key => key.toUpperCase() === 'PATH') || 'PATH'
  process.env[pathKey] = [...new Set([dirname(process.execPath), ...(process.env[pathKey] || '').split(delimiter).filter(Boolean)])].join(delimiter)
  process.env.HONGGUO_CODEX = findExecutable('codex', process.env.HONGGUO_CODEX)
}
