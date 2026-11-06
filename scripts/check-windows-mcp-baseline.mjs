import { spawnSync } from 'node:child_process'
import { resolve } from 'node:path'

// Compare only the known shutdown assertion against the pre-patch source.
// Host output stays in memory; emit a fixed result without raw diagnostics.
const result = spawnSync(process.execPath, ['--test', '--test-timeout=120000', '--test-name-pattern=MCP manifest launches', 'test/windows.test.mjs'], {
  cwd: resolve(process.argv[2]), encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 150000,
})
const reproduced = result.status !== 0 && result.stdout.includes('MCP did not exit after stdin closed')
console.log(JSON.stringify({ baselineMcpShutdownFailureReproduced: reproduced, exitStatus: result.status, timeout: result.error?.code === 'ETIMEDOUT' }))
process.exitCode = reproduced ? 0 : 1
