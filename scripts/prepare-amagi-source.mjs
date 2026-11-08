import { readFile, writeFile, mkdir } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { resolve } from 'node:path'

// Ship the preferred upstream TypeScript source beside the compiled GPL SDK.
// The immutable release revision and digest are reviewed in source control.
const manifest = JSON.parse(await readFile('third_party/amagi/source.json', 'utf8'))
const target = resolve('dist/licenses/amagi-' + manifest.version + '-source.tar.gz')
const hash = bytes => createHash('sha256').update(bytes).digest('hex')
let bytes = await readFile(target).catch(() => null)
if (!bytes || hash(bytes) !== manifest.sourceSHA256) {
  const url = new URL(manifest.sourceURL)
  if (url.origin !== 'https://codeload.github.com' || !url.pathname.endsWith('/' + manifest.revision))
    throw Error('Invalid SDK source location')
  const response = await fetch(url, { redirect: 'error', signal: AbortSignal.timeout(30000) })
  if (!response.ok || Number(response.headers.get('content-length')) > 32 * 1024 * 1024) throw Error('SDK source unavailable')
  const chunks = []; let size = 0
  for await (const chunk of response.body) {
    size += chunk.length
    if (size > 32 * 1024 * 1024) throw Error('SDK source exceeds limit')
    chunks.push(chunk)
  }
  bytes = Buffer.concat(chunks)
  if (hash(bytes) !== manifest.sourceSHA256) throw Error('SDK source checksum mismatch')
  await mkdir(resolve('dist/licenses'), { recursive: true })
  await writeFile(target, bytes)
}
