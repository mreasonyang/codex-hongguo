import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, readFileSync, cpSync, rmSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, isAbsolute } from 'node:path'
import { spawnSync } from 'node:child_process'
import { findExecutable } from '../src/runtime/executables.mjs'
import { Store } from '../src/server/store.mjs'

const windows = process.platform === 'win32'
const definitions = JSON.parse(readFileSync(new URL('../hooks/hooks.json', import.meta.url), 'utf8')).hooks
const system = process.env.SystemRoot || 'C:\\Windows'
const shells = [
  { name: 'CMD', command: join(system, 'System32', 'cmd.exe'), args: ['/d', '/s', '/c'], cmd: true },
  { name: 'Windows PowerShell 5.1', command: join(system, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'), args: ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command'] },
  { name: 'PowerShell 7', command: findExecutable('pwsh'), args: ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command'] },
]

for (const shell of shells) test(`packaged hooks run through ${shell.name} with real stdin and quoted Windows paths`, { skip: !windows }, t => {
  assert.ok(isAbsolute(shell.command) && existsSync(shell.command), shell.name + ' must be installed on the Windows qualification runner')
  const dir = mkdtempSync(join(tmpdir(), "红果 shell $ & ' "))
  const plugin = join(dir, '插件 目录')
  mkdirSync(join(plugin, 'bin'), { recursive: true })
  cpSync('dist', join(plugin, 'dist'), { recursive: true })
  for (const name of ['run-node.exe', 'run-node-arm64.exe']) cpSync(join('dist/launcher', name), join(plugin, 'bin', name))
  const data = join(dir, '进度 目录'), store = new Store(data)
  t.after(() => { store.close(); rmSync(dir, { recursive: true, force: true }) })
  const env = { ...process.env, PLUGIN_ROOT: plugin, HONGGUO_NODE: process.execPath, HONGGUO_DATA_DIR: data }
  const run = (command, input, deadline) => spawnSync(shell.command, [...shell.args, shell.cmd ? '"' + command + '"' : command], {
    env, cwd: tmpdir(), input, encoding: 'utf8', windowsHide: true, windowsVerbatimArguments: !!shell.cmd, timeout: deadline,
  })
  if (!shell.cmd) {
    const legacy = run('"%PLUGIN_ROOT%\\bin\\run-node.exe" hook', '{}', 10000)
    assert.notEqual(legacy.status, 0, 'The legacy CMD command must reproduce the PowerShell parsing failure')
    assert.ok(/Unexpected token|ParserError/i.test(legacy.stderr || ''), 'The legacy command must fail in the actual PowerShell parser')
  }
  for (const [event, state] of [['UserPromptSubmit', 'submitted'], ['Stop', 'stopped'], ['Interrupt', 'interrupted']]) {
    const definition = definitions[event][0].hooks[0]
    const session = 'shell-session', turn = 'shell-' + event
    const command = definition.commandWindows
    const result = run(command, JSON.stringify({ session_id: session, turn_id: turn, hook_event_name: event }), definition.timeout * 1000)
    const categories = [
      ['parser_error', /Unexpected token|ParserError|SplattingNotPermitted/i],
      ['command_not_found', /not recognized|CommandNotFound|cannot find/i],
      ['startup_failed', /failed to start|requires Node|runtime job/i],
    ].filter(([, pattern]) => pattern.test(result.stderr || '')).map(([name]) => name)
    assert.equal(result.status, 0, JSON.stringify({ shell: shell.name, event, status: result.status, errorCode: result.error?.code, categories }))
    let output
    try { output = JSON.parse(result.stdout) } catch { assert.fail(shell.name + ' ' + event + ' did not return hook JSON') }
    if (event === 'UserPromptSubmit') assert.match(output.hookSpecificOutput?.additionalContext || '', /show_waiting_picks.*turnId "shell-UserPromptSubmit"/)
    else assert.deepEqual(output, {})
    assert.equal(store.state(session, turn).state, state, shell.name + ' ' + event + ' must persist the matching event')
  }
})
