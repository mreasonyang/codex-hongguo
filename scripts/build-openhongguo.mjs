import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { cp, mkdir, mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const source = resolve('third_party/openhongguo')
const manifest = JSON.parse(await readFile(join(source, 'source.json'), 'utf8'))
// Generated inputs stay outside the source tree, like the other SDK sources.
const archive = resolve('dist/licenses/openhongguo-source.tar.gz')
const hash = bytes => createHash('sha256').update(bytes).digest('hex')
let bytes = await readFile(archive).catch(() => null)
if (!bytes || hash(bytes) !== manifest.sourceSHA256) {
  const expectedURL = 'https://codeload.github.com/beilunyang/openhongguo/tar.gz/' + manifest.revision
  if (!/^[a-f0-9]{40}$/.test(manifest.revision) || manifest.archiveURL !== expectedURL)
    throw Error('Invalid official openhongguo source location')
  const response = await fetch(expectedURL, { redirect: 'error', signal: AbortSignal.timeout(60000) })
  if (!response.ok || Number(response.headers.get('content-length')) > 8 * 1024 * 1024)
    throw Error('Official openhongguo source unavailable')
  const chunks = []; let size = 0
  for await (const chunk of response.body) {
    size += chunk.length
    if (size > 8 * 1024 * 1024) throw Error('openhongguo source exceeds limit')
    chunks.push(chunk)
  }
  bytes = Buffer.concat(chunks)
  if (hash(bytes) !== manifest.sourceSHA256) throw Error('openhongguo source checksum mismatch')
  await mkdir(resolve('dist/licenses'), { recursive: true })
  const part = archive + '.' + process.pid + '.part'
  try { await writeFile(part, bytes); await rename(part, archive) }
  finally { await rm(part, { force: true }) }
}

const temporary = await mkdtemp(join(tmpdir(), 'codex-hongguo-sdk-'))
try {
  execFileSync('tar', ['-xzf', archive, '--strip-components=1', '-C', temporary], { stdio: 'pipe', windowsHide: true })
  execFileSync(process.execPath, [join(temporary, 'bindings/node/scripts/build.mjs')], {
    cwd: temporary, stdio: 'pipe', windowsHide: true, timeout: 120000,
    env: { ...process.env, CGO_ENABLED: '0' },
  })
  const binding = join(temporary, 'bindings/node')
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
