// Give the desktop renderer a real, project-scoped MCP server and hooks without replacing the installed plugin.
import { accessSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir, homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { execFileSync } from 'node:child_process'
import { pathToFileURL } from 'node:url'
import pkg from '../package.json' with { type: 'json' }
import { findExecutable } from '../src/runtime/executables.mjs'
import { ensureFfmpeg } from '../src/runtime/ffmpeg-runtime.mjs'

const release = resolve('release')
const trial = join(release, '桌面对话试用')
const local = join(trial, '.codex')
const plugin = join(release, 'codex-hongguo-' + pkg.version, 'plugins', 'codex-hongguo')
const server = join(plugin, 'dist/server/index.mjs')
const hook = join(plugin, 'dist/hooks/write.mjs')
accessSync(server)
accessSync(hook)
const ffmpeg = await ensureFfmpeg()
execFileSync(ffmpeg, ['-version'], { stdio: 'ignore', timeout: 3000 })
const data = process.platform === 'darwin'
  ? join(homedir(), 'Library', 'Caches', 'CodexHongguoInlineTrial', pkg.version)
  : join(tmpdir(), 'codex-hongguo-inline-trial', pkg.version)
mkdirSync(local, { recursive: true, mode: 0o700 })
// Let this test folder have its own project trust boundary even when release/ is inside a Git worktree.
execFileSync('git', ['init', '--quiet', trial], { stdio: 'ignore' })
const file = (name, text) => writeFileSync(join(local, name), text + '\n', { mode: 0o600 })
const quote = JSON.stringify
const wrapper = join(local, 'run-hongguo-hook.mjs')
file('run-hongguo-hook.mjs', [
  'process.env.HONGGUO_DATA_DIR = ' + quote(data),
  'await import(' + quote(pathToFileURL(hook).href) + ')',
].join('\n'))
const shellQuote = text => "'" + text.replaceAll("'", "'\"'\"'") + "'"
const invoke = {
  type: 'command',
  command: shellQuote(process.execPath) + ' ' + shellQuote(wrapper),
  commandWindows: '"' + process.execPath + '" "' + wrapper + '"',
  timeout: 2,
}
file('hooks.json', JSON.stringify({ hooks: Object.fromEntries(
  ['UserPromptSubmit', 'Stop', 'Interrupt'].map(event => [event, [{ hooks: [invoke] }]]),
) }, null, 2))
file('config.toml', [
  '[features]', 'enable_mcp_apps = true',
  // This project has its own player and hooks, including when the same release is installed globally.
  '[plugins."codex-hongguo@hongguo-local"]', 'enabled = false',
  '[mcp_servers.hongguo-inline]', 'command = ' + quote(process.execPath),
  'args = ' + quote(['--no-warnings', server]), 'cwd = ' + quote(plugin),
  '[mcp_servers.hongguo-inline.env]', 'HONGGUO_DATA_DIR = ' + quote(data), 'HONGGUO_FFMPEG = ' + quote(ffmpeg),
].join('\n'))
writeFileSync(join(trial, '试用说明.md'), [
  '# 红果对话试用', '',
  '用 Codex 把这个目录作为项目打开。首次在「设置 → Hooks」审查并信任本项目的 UserPromptSubmit、Stop 和 Interrupt。',
  '关着播放器，在本项目的新对话里照常发一个需要一些时间的任务。看到「等待时看一集」后点剧名即可试播，也可以直接忽略。',
  '',
].join('\n'))
console.log('Codex 桌面试用项目 ' + trial)
