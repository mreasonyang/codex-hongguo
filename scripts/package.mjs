import { mkdir, cp, readFile, writeFile, readdir, rm, chmod } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { spawnSync, findExecutable } from '../src/runtime/executables.mjs'
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
for (const file of ['.codex-plugin/plugin.json', '.mcp.json', 'hooks/hooks.json', 'bin', 'skills', 'dist', 'LICENSE', 'docs/images']) {
  await mkdir(dirname(join(npmRoot, file)), { recursive: true })
  await cp(file, join(npmRoot, file), { recursive: true })
}
await chmod(join(npmRoot, 'bin/codex-hongguo.mjs'), 0o755)
await chmod(join(npmRoot, 'bin/run-node'), 0o755)
await cp('dist/launcher/run-node.exe', join(npmRoot, 'bin/run-node.exe'))
await cp('dist/launcher/run-node-arm64.exe', join(npmRoot, 'bin/run-node-arm64.exe'))
await rm(join(npmRoot, 'dist/launcher'), { recursive: true })
// Keep the tested compatibility manifest canonical until portable hook discovery is qualified.
await writeFile(join(npmRoot, 'package.json'), JSON.stringify({
  name: pkg.name, version: pkg.version, description: '在 Codex 桌面对话中观看红果短剧并跟随回合暂停。',
  type: 'module', license: pkg.license, engines: pkg.engines, os: ['darwin', 'linux', 'win32'], cpu: ['x64', 'arm64'],
  repository: { type: 'git', url: 'git+https://github.com/mreasonyang/codex-hongguo.git' },
  homepage: 'https://github.com/mreasonyang/codex-hongguo#readme',
  bin: { 'codex-hongguo': './bin/codex-hongguo.mjs' },
  files: ['.codex-plugin/', '.mcp.json', 'hooks/', 'skills/', 'bin/', 'dist/', 'licenses/', 'LICENSE', 'README.md', 'README.en.md', 'docs/images/'],
  publishConfig: { access: 'public', registry: 'https://registry.npmjs.org' },
}, null, 2) + '\n')
const guides = {}
for (const name of ['README.md', 'README.en.md']) {
  const [guide, development] = (await readFile(name, 'utf8')).split('<!-- development -->')
  if (!development) throw Error(name + ' 缺少消费者指南与开发说明的分界')
  guides[name] = guide
    .replace(/^首次 npm\/GitHub 发布尚未完成.*\n/m, '')
    .replace(/^First npm\/GitHub publication is pending.*\n/m, '')
    .replace('npm 公网安装和 GitHub Releases 安装包尚未发布', 'GitHub Releases 安装包尚未发布')
    .replace('The public npm package and GitHub Releases installers have not been published.', 'GitHub Releases installers have not been published.')
    .replaceAll('(docs/npm-distribution.md)', '(https://github.com/mreasonyang/codex-hongguo/blob/main/docs/npm-distribution.md)')
    .replaceAll('(docs/windows-support.md)', '(https://github.com/mreasonyang/codex-hongguo/blob/main/docs/windows-support.md)')
    .trimEnd() + '\n'
  await writeFile(join(npmRoot, name), guides[name])
}
const notices = join(npmRoot, 'licenses')
await mkdir(notices)
await cp('third_party/ffmpeg', join(notices, 'ffmpeg'), { recursive: true })
await cp('src/runtime/ffmpeg-artifacts.json', join(notices, 'ffmpeg/ffmpeg-artifacts.json'))
const lock = JSON.parse(await readFile('package-lock.json', 'utf8'))
for (const [path, dependency] of Object.entries(lock.packages)) {
  if (!path || dependency.dev) continue
  const files = await readdir(path).catch(() => [])
  for (const file of files.filter(name => /^(license|licence|copying|notice)(\.|$)/i.test(name)))
    await cp(join(path, file), join(notices, path.replaceAll('node_modules/', '').replaceAll('/', '-') + '-' + file))
}
await writeFile(join(notices, 'PROJECT-NOTICE.txt'), '本项目采用 MIT 许可证，全文见插件根目录 LICENSE。第三方运行时依赖按此目录各自的许可分发；短剧媒体版权归原权利人所有。\n')
const packed = spawnSync(findExecutable('npm'), ['pack', '--ignore-scripts', '--json', '--pack-destination', release], {
  cwd: npmRoot, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 30000,
})
if (packed.status !== 0) throw Error('npm 打包失败；未执行发布。')
const [{ filename, size, unpackedSize }] = JSON.parse(packed.stdout)
await mkdir(dirname(plugin), { recursive: true })
await cp(npmRoot, plugin, { recursive: true })
await mkdir(join(offline, '.agents/plugins'), { recursive: true })
await writeFile(join(offline, '.agents/plugins/marketplace.json'), JSON.stringify(marketplace(pkg.version, { source: 'local', path: './plugins/codex-hongguo' }), null, 2) + '\n')
for (const [name, guide] of Object.entries(guides)) await writeFile(join(offline, name), guide)
await cp('LICENSE', join(offline, 'LICENSE'))
await mkdir(join(offline, 'docs'), { recursive: true })
await cp('docs/images', join(offline, 'docs/images'), { recursive: true })
const entries = {}
async function collect(dir, base) {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name), name = base + '/' + entry.name
    if (entry.isDirectory()) await collect(path, name)
    else {
      // Native unzip must retain the POSIX launcher's executable bit too, including Windows-built ZIPs.
      const executable = /\/bin\/(?:run-node(?:-arm64)?(?:\.exe)?|codex-hongguo\.mjs)$/.test(name)
      entries[name] = [new Uint8Array(await readFile(path)), { os: 3, attrs: ((executable ? 0o100755 : 0o100644) << 16) >>> 0 }]
    }
  }
}
await collect(offline, folder)
await writeFile(join(release, folder + '.zip'), zipSync(entries, { level: 6 }))
await writeFile(join(release, 'package-metadata.json'), JSON.stringify({ name: pkg.name, version: pkg.version, filename, size, unpackedSize }, null, 2) + '\n')
console.log('已生成 npm 包 ' + filename + ' 和离线 ZIP ' + folder + '.zip')
