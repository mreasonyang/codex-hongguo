import { readFileSync, writeFileSync } from 'node:fs'
import { isVersion, nextBetaVersion } from '../src/runtime/version.mjs'
import { spawnSync, findExecutable } from '../src/runtime/executables.mjs'

const read = (path) => JSON.parse(readFileSync(path, 'utf8'))
const mode = process.argv[2]
const current = read('package.json').version
if (mode === '--beta') {
  const result = spawnSync(findExecutable('npm'), ['version', nextBetaVersion(current), '--no-git-tag-version'], { stdio: 'inherit' })
  if (result.status !== 0) throw Error('Beta 版本更新失败')
  process.exit(0)
}
// npm supplies the proposed version before changing package.json or the lockfile.
const version = mode === '--next' ? process.env.npm_new_version : current
if (!isVersion(version)) {
  throw new Error('版本号须为三段 0–999 的整数，可附加 -beta.N（N 为正整数）。第三位达到 999 后，请明确指定下一版本。')
}
if (mode !== '--next') {
  const lock = read('package-lock.json')
  if (lock.version !== current || lock.packages[''].version !== current) {
    throw new Error('package-lock.json 的项目版本与 package.json 不一致')
  }
  for (const path of ['plugin.json', '.codex-plugin/plugin.json']) {
    const manifest = read(path)
    if (manifest.version === current) continue
    if (mode !== '--sync') throw new Error(path + ' 的版本不一致，请运行 node scripts/version.mjs --sync 同步清单')
    manifest.version = current
    writeFileSync(path, JSON.stringify(manifest, null, 2) + '\n')
  }
}
