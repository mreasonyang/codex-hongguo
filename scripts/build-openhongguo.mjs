import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const source = resolve('third_party/openhongguo')
const manifest = JSON.parse(await readFile(join(source, 'source.json'), 'utf8'))
const archive = join(source, 'source.tar.gz')
const digest = createHash('sha256').update(await readFile(archive)).digest('hex')
if (digest !== manifest.sourceSHA256) throw Error('openhongguo source checksum mismatch')

const temporary = await mkdtemp(join(tmpdir(), 'codex-hongguo-sdk-'))
try {
  execFileSync('tar', ['-xzf', archive, '-C', temporary], { stdio: 'pipe', windowsHide: true })
  execFileSync(process.execPath, [join(temporary, 'bindings/node/scripts/build.mjs')], {
    cwd: temporary, stdio: 'pipe', windowsHide: true, timeout: 120000,
    env: { ...process.env, CGO_ENABLED: '0' },
  })
  const binding = join(temporary, 'bindings/node')
  const target = resolve('dist/vendor/openhongguo')
  await rm(target, { recursive: true, force: true })
  await mkdir(target, { recursive: true })
  for (const file of ['index.js', 'index.d.ts', 'types.d.ts', 'README.md', 'LICENSE', 'GO_LICENSE', 'dist'])
    await cp(join(binding, file), join(target, file), { recursive: true })
  const pkg = JSON.parse(await readFile(join(binding, 'package.json'), 'utf8'))
  pkg.version = manifest.version
  await writeFile(join(target, 'package.json'), JSON.stringify(pkg, null, 2) + '\n')
  await writeFile(join(target, 'SOURCE.json'), JSON.stringify(manifest, null, 2) + '\n')
  console.log('Built openhongguo playback patch ' + manifest.revision.slice(0, 12))
} finally {
  await rm(temporary, { recursive: true, force: true })
}
