import { readFileSync, writeFileSync } from 'node:fs'

const read = (path) => JSON.parse(readFileSync(path, 'utf8'))
const mode = process.argv[2]
const current = read('package.json').version
// npm supplies the proposed version before changing package.json or the lockfile.
const version = mode === '--next' ? process.env.npm_new_version : current
if (typeof version !== 'string' || !/^(?:0|[1-9]\d{0,2})(?:\.(?:0|[1-9]\d{0,2})){2}$/.test(version)) {
  throw new Error('版本号须为三段 0–999 的整数。第三位达到 999 后，请由维护者明确指定下一版本。')
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
