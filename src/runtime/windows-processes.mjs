import { lstat, readdir, realpath } from 'node:fs/promises'
import { homedir } from 'node:os'
import { win32 } from 'node:path'
import { spawnSync } from './executables.mjs'

// Only PID/executable metadata is collected. No argv, environment inspection or
// process termination. Unknown identities fail the preflight without deletion.
const collectScript = `$ErrorActionPreference = 'Stop'
$result = @{ processes = @(); unreadable = 0 }
$query = "SELECT ProcessId, ExecutablePath FROM Win32_Process WHERE Name = 'run-node.exe' OR Name = 'run-node-arm64.exe'"
foreach ($candidate in @(Get-CimInstance -Query $query)) {
  if ([string]::IsNullOrEmpty($candidate.ExecutablePath)) { $result.unreadable++ }
  else { $result.processes += @{ pid = [int]$candidate.ProcessId; executable = [string]$candidate.ExecutablePath } }
}
$json = ConvertTo-Json -InputObject $result -Compress -Depth 4
$bytes = [Text.Encoding]::UTF8.GetBytes($json)
$output = [Console]::OpenStandardOutput()
$output.Write($bytes, 0, $bytes.Length)
$output.Flush()`
const checkFailure = () => Object.assign(Error('无法确认红果后台是否已退出，卸载已停止且未修改文件或配置。请先关闭红果播放器及使用该插件的 Codex 会话，再重新运行 uninstall。'), { code: 'PLUGIN_PROCESS_CHECK_FAILED' })
const normalize = path => win32.normalize(path.replace(/^\\\\\?\\UNC\\/i, '\\\\').replace(/^\\\\\?\\/, '')).toLowerCase()

export async function ownedWindowsExecutables({ env = process.env, home = homedir() } = {}) {
  const codexHome = env.CODEX_HOME || win32.join(home, '.codex')
  if (!win32.isAbsolute(codexHome)) throw checkFailure()
  const root = win32.join(codexHome, 'plugins', 'cache', 'hongguo-local', 'codex-hongguo')
  let versions
  try { versions = await readdir(root, { withFileTypes: true }) } catch (error) { if (error.code === 'ENOENT') return []; throw checkFailure() }
  const paths = []
  for (const version of versions) {
    if (!version.isDirectory() || version.isSymbolicLink()) continue
    const directory = win32.join(root, version.name), bin = win32.join(directory, 'bin')
    try {
      const info = await lstat(bin)
      if (!info.isDirectory() || info.isSymbolicLink()) continue
      const canonicalRoot = await realpath(directory)
      for (const name of ['run-node.exe', 'run-node-arm64.exe']) {
        const file = win32.join(bin, name)
        try {
          const info = await lstat(file)
          if (!info.isFile() || info.isSymbolicLink()) continue
          const canonical = await realpath(file)
          if (win32.relative(canonicalRoot, canonical).toLowerCase() === 'bin\\' + name) paths.push(canonical)
        } catch (error) { if (error.code !== 'ENOENT') throw error }
      }
    } catch (error) { if (error.code !== 'ENOENT') throw checkFailure() }
  }
  return paths
}

export async function selectOwnedWindowsProcesses(records, executables, canonicalize = realpath) {
  const allowed = new Set(executables.map(normalize)), selected = []
  for (const row of records) {
    if (!Number.isInteger(row?.pid) || row.pid <= 0 || row.pid === process.pid || typeof row.executable !== 'string' || !win32.isAbsolute(row.executable)) continue
    let path
    try { path = await canonicalize(row.executable) } catch { continue }
    if (allowed.has(normalize(path))) selected.push({ pid: row.pid, executable: row.executable })
  }
  return selected
}

export async function assertWindowsPluginIdle({ env = process.env, home = homedir(), platform = process.platform } = {}) {
  if (platform !== 'win32') return
  const executables = await ownedWindowsExecutables({ env, home })
  if (!executables.length) return
  const command = win32.join(env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
  const result = spawnSync(command, ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', collectScript], {
    env, encoding: 'utf8', timeout: 20000, windowsHide: true,
    maxBuffer: 2 * 1024 * 1024, stdio: ['ignore', 'pipe', 'ignore'],
  })
  if (result.status !== 0) throw checkFailure()
  let metadata
  try { metadata = JSON.parse(result.stdout) } catch { throw checkFailure() }
  if (!Array.isArray(metadata.processes) || !Number.isInteger(metadata.unreadable)) throw checkFailure()
  const selected = await selectOwnedWindowsProcesses(metadata.processes, executables)
  if (selected.length) throw Object.assign(Error('红果后台仍在运行，正在占用插件文件。卸载尚未开始，缓存、市场配置和观看数据均已保留。请先关闭红果播放器及使用该插件的 Codex 会话，再重新运行 uninstall。'), { code: 'PLUGIN_RUNNING' })
  if (metadata.unreadable) throw checkFailure()
}
