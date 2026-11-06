import { mkdir } from 'node:fs/promises'
import { spawnSync } from 'node:child_process'

await mkdir('dist/launcher', { recursive: true })
for (const [arch, name] of [['amd64', 'run-node.exe'], ['arm64', 'run-node-arm64.exe']]) {
  const result = spawnSync('go', ['build', '-trimpath', '-ldflags=-s -w -buildid=', '-o', 'dist/launcher/' + name, './launcher/windows/main.go'], {
    env: { ...process.env, GOOS: 'windows', GOARCH: arch, CGO_ENABLED: '0' },
    stdio: 'ignore', timeout: 120000, windowsHide: true,
  })
  if (result.status !== 0) throw Error('Windows ' + arch + ' 启动器构建失败。请安装 Go >=1.25 后重试；未执行发布。')
}
