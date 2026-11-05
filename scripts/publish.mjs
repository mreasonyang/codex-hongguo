// Publish only the exact artifact qualified by the isolated native npm installation.
import { readFile, copyFile, writeFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { spawnSync, findExecutable } from '../src/runtime/executables.mjs'
import { resolve } from 'node:path'

const pkg = JSON.parse(await readFile('package.json', 'utf8'))
const receipt = JSON.parse(await readFile('release/verification.json', 'utf8'))
const metadata = JSON.parse(await readFile('release/package-metadata.json', 'utf8'))
if (metadata.name !== pkg.name || metadata.version !== pkg.version) throw Error('打包元数据与当前包名或版本不一致，请重新打包并验收。')
const archive = resolve('release', metadata.filename)
const bytes = await readFile(archive)
const digest = createHash('sha256').update(bytes).digest('hex')
if (receipt.name !== pkg.name || receipt.version !== pkg.version || receipt.sha256 !== digest || !receipt.checks.includes('native-npm-source') || !receipt.checks.includes('progress-preserved'))
  throw Error('发行包与隔离安装验收回执不匹配，请重新打包并运行 verify:install。')
const npm = findExecutable('npm')
const args = ['publish', archive, '--access', 'public', '--registry', 'https://registry.npmjs.org']
if (process.argv.includes('--provenance')) args.push('--provenance')
if (!process.argv.includes('--index-only')) {
  const result = spawnSync(npm, args, { stdio: 'ignore', timeout: 120000 })
  if (result.status !== 0) throw Error('npm 发布未完成。请在自己的终端完成 npm login/双重认证，或配置受信任的 CI 发布者后重试；市场索引未更新。')
}
const integrity = 'sha512-' + createHash('sha512').update(bytes).digest('base64')
let visible = false
for (let i = 0; i < 5; i++) {
  try {
    const response = await fetch('https://registry.npmjs.org/' + encodeURIComponent(pkg.name) + '/' + pkg.version, { signal: AbortSignal.timeout(10000) })
    if (response.ok && (await response.json()).dist?.integrity === integrity) { visible = true; break }
  } catch { /* Wait briefly for registry visibility before advancing the index. */ }
  await new Promise(resolve => setTimeout(resolve, 2000))
}
if (!visible) throw Error('npm 已接受发布，但尚未核实同一安装包的完整性；市场索引未更新，请核实 registry 后处理。')
await copyFile('release/marketplace/.agents/plugins/marketplace.json', '.agents/plugins/marketplace.json')
const readme = await readFile('README.md', 'utf8')
await writeFile('README.md', readme
  .replace(/^首次 npm\/GitHub 发布尚未完成.*\n/m, 'npm 正式发行包已发布。安装与更新通过 Codex 原生插件市场完成。\n')
  .replace('npm 公网安装和 GitHub Releases 安装包尚未发布', 'GitHub Releases 安装包尚未发布'))
const english = await readFile('README.en.md', 'utf8')
await writeFile('README.en.md', english
  .replace(/^First npm\/GitHub publication is pending.*\n/m, 'The npm release is available. Installation and updates use the native Codex plugin marketplace.\n')
  .replace('The public npm package and GitHub Releases installers have not been published.', 'GitHub Releases installers have not been published.'))
console.log('已发布 ' + pkg.name + '@' + pkg.version + '，registry 完整性回读通过，市场索引已更新。')
