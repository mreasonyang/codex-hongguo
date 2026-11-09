// Real anonymous QR endpoints through the compiled app-only MCP surface.
// No account is scanned. QR images, tickets, cookies and raw errors are never logged.
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { mkdtemp, rm, access } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import assert from 'node:assert/strict'

const root = await mkdtemp(join(tmpdir(), 'bilibili-auth-qualification-'))
const pluginRoot = resolve(process.env.BILIBILI_VERIFY_PACKAGE_ROOT || '.')
const client = new Client({ name: 'bilibili-auth-qualification', version: '1' })
const report = { artifact: process.env.BILIBILI_VERIFY_PACKAGE_ROOT ? 'packaged' : 'source-build',
  authentication: 'anonymous', realAccountConfirmed: false, checks: [] }
let panel, stage = 'startup'
async function call(name, input = {}, target = panel) {
  const result = await client.callTool({ name, arguments: { panel: target, source: 'bilibili', ...input } })
  assert.equal(result.isError, undefined)
  assert.equal(result.content.length, 0)
  return result._meta.data
}
try {
  await client.connect(new StdioClientTransport({ command: process.execPath,
    args: ['--no-warnings', join(pluginRoot, 'dist/server/index.mjs')],
    env: { PATH: process.env.PATH || process.env.Path, HONGGUO_DATA_DIR: root }, stderr: 'ignore' }))
  const open = async thread => (await client.callTool({ name: 'open_drama_panel', arguments: {}, _meta: { thread_id: thread } }))._meta.panel
  panel = await open('auth-owner')
  const other = await open('auth-other')
  const names = ['get_provider_auth', 'start_provider_login', 'poll_provider_login', 'cancel_provider_login', 'logout_provider']
  const tools = (await client.listTools()).tools
  assert.ok(names.every(name => tools.some(tool => tool.name === name && tool._meta.ui.visibility.join(',') === 'app')))
  report.checks.push('auth-tools-app-only')
  assert.equal((await call('get_provider_auth')).status, 'signed-out')
  stage = 'generate-real-qr'
  const qr = await call('start_provider_login')
  assert.equal(qr.status, 'waiting'); assert.match(qr.svg, /^<svg/)
  assert.deepEqual(Object.keys(qr).sort(), ['expiresAt', 'loginId', 'status', 'svg'])
  report.checks.push('real-qr-generated-without-credential-fields')
  stage = 'poll-real-qr'
  assert.equal((await call('poll_provider_login', { loginId: qr.loginId }, other)).status, 'cancelled')
  assert.equal((await call('poll_provider_login', { loginId: qr.loginId })).status, 'waiting')
  report.checks.push('real-qr-waiting', 'panel-owner-binding')
  await call('cancel_provider_login', { loginId: qr.loginId })
  assert.equal((await call('poll_provider_login', { loginId: qr.loginId })).status, 'cancelled')
  assert.equal((await call('logout_provider')).status, 'signed-out')
  report.checks.push('real-qr-cancelled', 'local-logout')
  stage = 'disable-provider'
  const disabled = await client.callTool({ name: 'start_provider_login', arguments: { panel, source: 'bilibili' } })
  assert.equal(disabled.isError, true)
  report.checks.push('disabled-provider-cannot-login')
  report.result = 'PASS'
} catch (error) { report.result = 'FAIL'; report.stage = stage; report.errorType = error.name; process.exitCode = 1 }
finally { await client.close().catch(() => {}); await rm(root, { recursive: true, force: true }) }
console.log(JSON.stringify(report))
