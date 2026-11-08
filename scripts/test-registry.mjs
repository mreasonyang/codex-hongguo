// Disposable HTTPS registry for exercising the native npm source loader; no authentication or logs.
import { createServer } from 'node:https'
import { releaseChannel } from '../src/runtime/version.mjs'
import { readFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { join } from 'node:path'
const [root, archivePath, version, packageName, manifestPath] = process.argv.slice(2)
const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
const archive = readFileSync(archivePath)
const integrity = 'sha512-' + createHash('sha512').update(archive).digest('base64')
const server = createServer({ key: readFileSync(join(root, 'registry.key')), cert: readFileSync(join(root, 'registry.crt')) }, (request, response) => {
  if (request.method !== 'GET') { response.writeHead(405).end(); return }
  let path
  try { path = decodeURIComponent(new URL(request.url, 'https://127.0.0.1').pathname) } catch { response.writeHead(400).end(); return }
  if (path === '/' + packageName || path === '/' + packageName + '/' + version) {
    const item = { ...manifest, dist: { tarball: origin + '/package.tgz', integrity } }
    const body = path.endsWith('/' + version) ? item : { name: packageName, 'dist-tags': { [releaseChannel(version)]: version }, versions: { [version]: item } }
    response.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify(body))
  } else if (path === '/package.tgz') response.writeHead(200, { 'Content-Type': 'application/octet-stream' }).end(archive)
  else response.writeHead(404).end()
})
let origin
server.listen(0, '127.0.0.1', () => {
  origin = 'https://127.0.0.1:' + server.address().port
  process.send({ origin })
})
process.on('disconnect', () => server.close())
