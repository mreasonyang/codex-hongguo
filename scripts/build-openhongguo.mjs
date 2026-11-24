import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { cp, mkdir, mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { archiveURL, downloadArchive } from './openhongguo-archive.mjs'

const source = resolve('third_party/openhongguo')
const manifest = JSON.parse(await readFile(join(source, 'source.json'), 'utf8'))
const archive = resolve('node_modules/.cache/codex-hongguo/openhongguo-source.tar.gz')
const distribution = resolve('dist/licenses/openhongguo-source.tar.gz')
if (manifest.archiveURL !== archiveURL(manifest.revision))
  throw Error('Invalid official openhongguo source location')
const hash = bytes => createHash('sha256').update(bytes).digest('hex')
let bytes = await readFile(archive).catch(() => null)
if (!bytes || hash(bytes) !== manifest.sourceSHA256) {
  bytes = await downloadArchive(manifest.revision)
  if (hash(bytes) !== manifest.sourceSHA256) throw Error('openhongguo source checksum mismatch')
  await mkdir(dirname(archive), { recursive: true })
  const part = archive + '.' + process.pid + '.part'
  try { await writeFile(part, bytes); await rename(part, archive) }
  finally { await rm(part, { force: true }) }
}

const temporary = await mkdtemp(join(tmpdir(), 'codex-hongguo-sdk-'))
try {
  const folder = 'openhongguo-' + manifest.revision
  const sourceRoot = join(temporary, folder)
  await mkdir(sourceRoot)
  execFileSync('tar', ['-xzf', archive, '--strip-components=1', '-C', sourceRoot], { stdio: 'pipe', windowsHide: true })
  // The standalone signing service includes a native binary and is not used by this SDK build.
  await mkdir(dirname(distribution), { recursive: true })
  const sourcePart = distribution + '.' + process.pid + '.part'
  try {
    execFileSync('tar', ['-czf', sourcePart, '--exclude', folder + '/signer', '-C', temporary, folder], { stdio: 'pipe', windowsHide: true })
    await rename(sourcePart, distribution)
  } finally { await rm(sourcePart, { force: true }) }
  const binding = join(sourceRoot, 'bindings/node')
  execFileSync(process.execPath, [join(binding, 'scripts/build.mjs')], {
    cwd: sourceRoot, stdio: 'pipe', windowsHide: true, timeout: 120000,
    env: { ...process.env, CGO_ENABLED: '0' },
  })
  const target = resolve('dist/vendor/openhongguo')
  await rm(target, { recursive: true, force: true })
  await mkdir(target, { recursive: true })
  for (const file of ['package.json', 'index.js', 'index.d.ts', 'types.d.ts', 'README.md', 'LICENSE', 'GO_LICENSE', 'dist'])
    await cp(join(binding, file), join(target, file), { recursive: true })
  await writeFile(join(target, 'SOURCE.json'), JSON.stringify(manifest, null, 2) + '\n')
  console.log('Built unmodified upstream openhongguo ' + manifest.revision.slice(0, 12))
} finally {
  await rm(temporary, { recursive: true, force: true })
}
