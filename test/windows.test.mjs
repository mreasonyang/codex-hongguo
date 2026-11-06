import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync, cpSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { findExecutable, spawnSync, spawn } from '../src/runtime/executables.mjs'
import { dataRoot } from '../src/server/paths.mjs'

test('Windows progress stays in LocalAppData and keeps an explicit override', () => {
  assert.equal(dataRoot({ platform: 'win32', home: 'C:\\Users\\用户', env: { LOCALAPPDATA: 'D:\\本地 数据' } }), 'D:\\本地 数据\\CodexHongguo')
  assert.equal(dataRoot({ platform: 'win32', home: 'C:\\Users\\用户', env: {} }), 'C:\\Users\\用户\\AppData\\Local\\CodexHongguo')
  assert.equal(dataRoot({ platform: 'win32', home: 'C:\\Users\\用户', env: { HONGGUO_DATA_DIR: 'D:\\自定义' } }), 'D:\\自定义')
})

test('Windows .cmd discovery and both process APIs preserve Chinese, spaces and shell metacharacters', { skip: process.platform !== 'win32' }, async t => {
  const dir = mkdtempSync(join(tmpdir(), '红果 Windows '))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const tools = join(dir, '工具 目录')
  mkdirSync(tools)
  const receiver = join(dir, '接收 参数.mjs')
  writeFileSync(receiver, 'process.stdout.write(JSON.stringify(process.argv.slice(2)))')
  const shim = join(tools, 'hongguo-probe.cmd')
  writeFileSync(shim, `@echo off\r\n"${process.execPath}" "${receiver}" %*\r\n`)
  const command = findExecutable('hongguo-probe', undefined, { env: { Path: `relative;"${tools}"` }, home: dir })
  assert.equal(command, shim)
  const args = ['中文 路径', 'a&b', '(test)', 'x^y', 'quote"here', 'trailing\\']
  const result = spawnSync(command, args, { encoding: 'utf8', windowsHide: true, timeout: 5000 })
  assert.equal(result.status, 0)
  assert.deepEqual(JSON.parse(result.stdout), args)
  const child = spawn(command, args, { stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true, timeout: 5000 })
  let stdout = ''
  child.stdout.on('data', chunk => { stdout += chunk })
  await new Promise((ok, fail) => { child.once('error', fail); child.once('close', code => code === 0 ? ok() : fail(Error('probe failed'))) })
  assert.deepEqual(JSON.parse(stdout), args)
})

test('MCP manifest launches the packaged platform entry and keeps stdout as JSON-RPC', async t => {
  const dir = mkdtempSync(join(tmpdir(), '红果 MCP '))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const manifest = JSON.parse(readFileSync('.mcp.json', 'utf8')).mcpServers['codex-hongguo']
  const plugin = join(dir, '插件 目录')
  mkdirSync(join(plugin, 'bin'), { recursive: true })
  cpSync('dist', join(plugin, 'dist'), { recursive: true })
  cpSync(process.platform === 'win32' ? 'dist/launcher/run-node.exe' : 'bin/run-node', join(plugin, 'bin', process.platform === 'win32' ? 'run-node.exe' : 'run-node'))
  // Windows resolves an extensionless command to .exe; exercise exactly that host contract.
  const command = resolve(plugin, manifest.command)
  const child = spawn(command, manifest.args, { cwd: plugin, env: { ...process.env, HONGGUO_NODE: process.execPath, HONGGUO_DATA_DIR: dir }, stdio: ['pipe', 'pipe', 'ignore'], windowsHide: true })
  t.after(() => child.kill())
  const ready = new Promise((ok, fail) => {
    let buffer = ''
    const timer = setTimeout(() => fail(Error('MCP initialization timed out')), 10000)
    child.once('error', error => { clearTimeout(timer); fail(error) })
    child.stdout.on('data', chunk => {
      buffer += chunk
      if (!buffer.includes('\n')) return
      clearTimeout(timer)
      try { const reply = JSON.parse(buffer.split('\n')[0]); assert.equal(reply.id, 1); assert.equal(reply.result.serverInfo.name, 'codex-hongguo'); ok() } catch (error) { fail(error) }
    })
  })
  child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'windows-probe', version: '1' } } }) + '\n')
  await ready
  child.stdin.end()
  await new Promise((ok, fail) => {
    const timer = setTimeout(() => { child.kill(); fail(Error('MCP did not exit after stdin closed')) }, 5000)
    child.once('close', code => { clearTimeout(timer); code === 0 ? ok() : fail(Error('MCP shutdown failed')) })
  })
})

test('Windows launcher termination reaps its Node runtime', { skip: process.platform !== 'win32' }, async t => {
  const dir = mkdtempSync(join(tmpdir(), '红果 退出 '))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  mkdirSync(join(dir, 'bin'), { recursive: true })
  mkdirSync(join(dir, 'dist/server'), { recursive: true })
  cpSync('dist/launcher/run-node.exe', join(dir, 'bin/run-node.exe'))
  writeFileSync(join(dir, 'dist/server/index.mjs'), 'console.log(JSON.stringify({pid:process.pid}));setInterval(()=>{},1000)')
  const child = spawn(join(dir, 'bin/run-node.exe'), ['server'], { env: { ...process.env, HONGGUO_NODE: process.execPath }, stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true })
  let pid
  t.after(() => { child.kill(); if (pid) { try { process.kill(pid) } catch {} } })
  await new Promise((ok, fail) => {
    let buffer = ''
    const timer = setTimeout(() => fail(Error('Windows runtime did not start')), 5000)
    child.once('error', error => { clearTimeout(timer); fail(error) })
    child.stdout.on('data', chunk => {
      buffer += chunk
      if (!buffer.includes('\n')) return
      clearTimeout(timer)
      try { pid = JSON.parse(buffer.split('\n')[0]).pid; ok() } catch (error) { fail(error) }
    })
  })
  child.kill()
  const deadline = Date.now() + 3000
  while (Date.now() < deadline) {
    try { process.kill(pid, 0) } catch (error) { if (error.code === 'ESRCH') { pid = undefined; return } throw error }
    await new Promise(ok => setTimeout(ok, 50))
  }
  assert.fail('Node survived the Windows launcher')
})
