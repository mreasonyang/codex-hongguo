// Disposable HTTPS registry for exercising the native npm source loader; no authentication or logs.
import { createServer } from 'node:https'
import { readFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { join } from 'node:path'
const [root, archivePath, version] = process.argv.slice(2)
const archive = readFileSync(archivePath)
const integrity = 'sha512-' + createHash('sha512').update(archive).digest('base64')
const server = createServer({ key: readFileSync(join(root, 'registry.key')), cert: readFileSync(join(root, 'registry.crt')) }, (request, response) => {
  if (request.method !== 'GET') { response.writeHead(405).end(); return }
  if (request.url === '/codex-hongguo' || request.url === '/codex-hongguo/' + version) {
    const item = { name: 'codex-hongguo', version, bin: { 'codex-hongguo': 'bin/codex-hongguo.mjs' }, dist: { tarball: origin + '/codex-hongguo/-/package.tgz', integrity } }
    const body = request.url.endsWith('/' + version) ? item : { name: 'codex-hongguo', 'dist-tags': { latest: version }, versions: { [version]: item } }
    response.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify(body))
  } else if (request.url === '/codex-hongguo/-/package.tgz') response.writeHead(200, { 'Content-Type': 'application/octet-stream' }).end(archive)
  else response.writeHead(404).end()
})
let origin
server.listen(0, '127.0.0.1', () => {
  origin = 'https://127.0.0.1:' + server.address().port
  process.send({ origin })
})
process.on('disconnect', () => server.close())
