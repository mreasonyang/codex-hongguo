import { lstat, readdir, realpath } from 'node:fs/promises'
import { homedir } from 'node:os'
import { win32 } from 'node:path'
import { spawnSync } from './executables.mjs'

// These collectors read executable identity, PID and creation time only. Never
// read CommandLine, process environments, authentication files or host logs.
const emitJson = `$json = ConvertTo-Json -InputObject $result -Compress -Depth 4
$bytes = [Text.Encoding]::UTF8.GetBytes($json)
$output = [Console]::OpenStandardOutput()
$output.Write($bytes, 0, $bytes.Length)
$output.Flush()`
const collectScript = `$ErrorActionPreference = 'Stop'
$result = @()
foreach ($name in @('run-node', 'run-node-arm64')) {
  foreach ($candidate in [Diagnostics.Process]::GetProcessesByName($name)) {
    try {
      $result += @{ pid = $candidate.Id; executable = $candidate.MainModule.FileName; started = [string]$candidate.StartTime.ToUniversalTime().Ticks }
    } catch { } finally { $candidate.Dispose() }
  }
}
${emitJson}`
const stopScript = `$ErrorActionPreference = 'Stop'
$reader = [IO.StreamReader]::new([Console]::OpenStandardInput(), [Text.Encoding]::UTF8)
$payload = $reader.ReadToEnd()
$expected = @(ConvertFrom-Json -InputObject $payload)
$result = @{ stopped = 0; skipped = 0; failed = 0 }
foreach ($entry in $expected) {
  $candidate = $null
  try {
    $candidate = [Diagnostics.Process]::GetProcessById([int]$entry.pid)
    $boundHandle = $candidate.Handle
    if ($candidate.HasExited) { $result.skipped++; continue }
    $samePath = [String]::Equals($candidate.MainModule.FileName, [string]$entry.executable, [StringComparison]::OrdinalIgnoreCase)
    $sameStart = [string]$candidate.StartTime.ToUniversalTime().Ticks -eq [string]$entry.started
    if (-not ($samePath -and $sameStart)) { $result.skipped++; continue }
    $candidate.Kill()
    if ($candidate.WaitForExit(5000)) { $result.stopped++ } else { $result.failed++ }
  } catch [ArgumentException] { $result.skipped++ }
    catch {
      try { if ($null -ne $candidate -and $candidate.HasExited) { $result.skipped++ } else { $result.failed++ } }
      catch { $result.failed++ }
    }
    finally { if ($null -ne $candidate) { $candidate.Dispose() } }
}
${emitJson}`

const processFailure = () => Error('无法安全停止红果后台进程，插件文件可能仍被占用。请关闭红果播放器及使用该插件的 Codex 会话，再重新运行 uninstall；尚未清理观看数据。')
function invokePowerShell(script, input, env) {
  const command = win32.join(env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
  const result = spawnSync(command, ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', script], {
    env, input, encoding: 'utf8', timeout: 20000, windowsHide: true,
    maxBuffer: 2 * 1024 * 1024, stdio: ['pipe', 'pipe', 'ignore'],
  })
  if (result.status !== 0) throw processFailure()
  try { return JSON.parse(result.stdout) } catch { throw processFailure() }
}
const normalize = path => win32.normalize(path.replace(/^\\\\\?\\UNC\\/i, '\\\\').replace(/^\\\\\?\\/, '')).toLowerCase()

export async function ownedWindowsExecutables({ env = process.env, home = homedir() } = {}) {
  const codexHome = env.CODEX_HOME || win32.join(home, '.codex')
  if (!win32.isAbsolute(codexHome)) throw processFailure()
  const root = win32.join(codexHome, 'plugins', 'cache', 'hongguo-local', 'codex-hongguo')
  let versions
  try { versions = await readdir(root, { withFileTypes: true }) } catch (error) { if (error.code === 'ENOENT') return []; throw processFailure() }
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
    } catch (error) { if (error.code !== 'ENOENT') throw processFailure() }
  }
  return paths
}

export async function selectOwnedWindowsProcesses(records, executables, canonicalize = realpath) {
  const allowed = new Set(executables.map(normalize)), selected = []
  for (const row of records) {
    if (!Number.isInteger(row?.pid) || row.pid <= 0 || row.pid === process.pid || typeof row.executable !== 'string' ||
      !win32.isAbsolute(row.executable) || typeof row.started !== 'string' || !/^\d{10,20}$/.test(row.started)) continue
    let path
    try { path = await canonicalize(row.executable) } catch { continue }
    if (allowed.has(normalize(path))) selected.push({ pid: row.pid, executable: row.executable, started: row.started })
  }
  return selected
}

export async function stopWindowsPluginProcesses({ env = process.env, home = homedir(), platform = process.platform, invoke = invokePowerShell } = {}) {
  if (platform !== 'win32') return { stopped: 0 }
  const executables = await ownedWindowsExecutables({ env, home })
  if (!executables.length) return { stopped: 0 }
  const records = invoke(collectScript, undefined, env)
  if (!Array.isArray(records)) throw processFailure()
  const selected = await selectOwnedWindowsProcesses(records, executables)
  if (!selected.length) return { stopped: 0 }
  const result = invoke(stopScript, JSON.stringify(selected), env)
  if (!Number.isInteger(result?.stopped) || !Number.isInteger(result?.failed) || result.failed !== 0) throw processFailure()
  // Closing each launcher's existing Windows Job also terminates its own Node
  // and playback children. Never terminate unrelated node.exe/codex.exe by name.
  if (result.stopped) await new Promise(resolve => setTimeout(resolve, 150))
  return { stopped: result.stopped }
}
