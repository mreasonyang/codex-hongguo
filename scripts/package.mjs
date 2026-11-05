import { mkdir, cp, readFile, writeFile, readdir, rm, chmod } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { spawnSync } from 'node:child_process'
import { zipSync } from 'fflate'
import { marketplace } from './distribution.mjs'

const pkg = JSON.parse(await readFile('package.json', 'utf8'))
const folder = 'codex-hongguo-' + pkg.version
const release = resolve('release'), npmRoot = join(release, 'npm', 'codex-hongguo')
const offline = join(release, folder), plugin = join(offline, 'plugins', 'codex-hongguo')
await mkdir(join(release, 'marketplace/.agents/plugins'), { recursive: true })
await writeFile(join(release, 'marketplace/.agents/plugins/marketplace.json'), JSON.stringify(marketplace(pkg.version), null, 2) + '\n')
await rm(npmRoot, { recursive: true, force: true })
await rm(offline, { recursive: true, force: true })
await mkdir(npmRoot, { recursive: true })
for (const file of ['.codex-plugin/plugin.json', '.mcp.json', 'hooks/hooks.json', 'bin', 'skills', 'dist']) {
  await mkdir(dirname(join(npmRoot, file)), { recursive: true })
  await cp(file, join(npmRoot, file), { recursive: true })
}
await chmod(join(npmRoot, 'bin/codex-hongguo.mjs'), 0o755)
await chmod(join(npmRoot, 'bin/run-node'), 0o755)
// Keep the tested compatibility manifest canonical until portable hook discovery is qualified.
await writeFile(join(npmRoot, 'package.json'), JSON.stringify({
  name: pkg.name, version: pkg.version, description: '在 Codex 桌面对话中观看红果短剧并跟随回合暂停。',
  type: 'module', license: 'UNLICENSED', engines: pkg.engines, os: ['darwin', 'linux'],
  repository: { type: 'git', url: 'git+https://github.com/mreasonyang/codex-hongguo.git' },
  homepage: 'https://github.com/mreasonyang/codex-hongguo#readme',
  bin: { 'codex-hongguo': './bin/codex-hongguo.mjs' },
  files: ['.codex-plugin/', '.mcp.json', 'hooks/', 'skills/', 'bin/', 'dist/', 'licenses/', 'README.md', 'README.en.md'],
  publishConfig: { access: 'public', registry: 'https://registry.npmjs.org' },
}, null, 2) + '\n')
const guides = {}
for (const name of ['README.md', 'README.en.md']) {
  const [guide, development] = (await readFile(name, 'utf8')).split('<!-- development -->')
  if (!development) throw Error(name + ' 缺少消费者指南与开发说明的分界')
  guides[name] = guide
    .replace(/^首次 npm\/GitHub 发布尚未完成.*\n/m, '')
    .replace(/^First npm\/GitHub publication is pending.*\n/m, '')
    .replaceAll('(docs/npm-distribution.md)', '(https://github.com/mreasonyang/codex-hongguo/blob/main/docs/npm-distribution.md)')
    .trimEnd() + '\n'
  await writeFile(join(npmRoot, name), guides[name])
}
const notices = join(npmRoot, 'licenses')
await mkdir(notices)
const lock = JSON.parse(await readFile('package-lock.json', 'utf8'))
for (const [path, dependency] of Object.entries(lock.packages)) {
  if (!path || dependency.dev) continue
  const files = await readdir(path).catch(() => [])
  for (const file of files.filter(name => /^(license|licence|copying|notice)(\.|$)/i.test(name)))
    await cp(join(path, file), join(notices, path.replaceAll('node_modules/', '').replaceAll('/', '-') + '-' + file))
}
await writeFile(join(notices, 'PROJECT-NOTICE.txt'), '本项目尚未授予开源许可证。第三方运行时依赖按此目录各自的许可分发；短剧媒体版权归原权利人所有。\n')
const packed = spawnSync(process.platform === 'win32' ? 'npm.cmd' : 'npm', ['pack', '--ignore-scripts', '--json', '--pack-destination', release], {
  cwd: npmRoot, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 30000,
})
if (packed.status !== 0) throw Error('npm 打包失败；未执行发布。')
const [{ filename, size, unpackedSize }] = JSON.parse(packed.stdout)
await mkdir(dirname(plugin), { recursive: true })
await cp(npmRoot, plugin, { recursive: true })
await mkdir(join(offline, '.agents/plugins'), { recursive: true })
await writeFile(join(offline, '.agents/plugins/marketplace.json'), JSON.stringify(marketplace(pkg.version, { source: 'local', path: './plugins/codex-hongguo' }), null, 2) + '\n')
for (const [name, guide] of Object.entries(guides)) await writeFile(join(offline, name), guide)
const entries = {}
async function collect(dir, base) {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name), name = base + '/' + entry.name
    if (entry.isDirectory()) await collect(path, name)
    else entries[name] = new Uint8Array(await readFile(path))
  }
}
await collect(offline, folder)
await writeFile(join(release, folder + '.zip'), zipSync(entries, { level: 6 }))
await writeFile(join(release, 'package-metadata.json'), JSON.stringify({ version: pkg.version, filename, size, unpackedSize }, null, 2) + '\n')
console.log('已生成 npm 包 ' + filename + ' 和离线 ZIP ' + folder + '.zip')
