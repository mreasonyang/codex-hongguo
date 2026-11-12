import test from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { createCipheriv, randomBytes, randomUUID } from 'node:crypto'
import { access, copyFile, cp, mkdir, mkdtemp, readFile, writeFile, rm, symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { prepareCandidate, runFfmpeg } from '../src/server/media.mjs'
import { Catalog } from '../src/server/catalog.mjs'
import { Store } from '../src/server/store.mjs'
import { Service } from '../src/server/service.mjs'
import { builtins, ProviderRegistry } from '../src/server/providers/registry.mjs'
import { activatePackage, libraryDirectory } from '../src/server/providers/library.mjs'
import { defer } from './cleanup.mjs'

const cliPath = fileURLToPath(new URL('../bin/codex-hongguo.mjs', import.meta.url))
async function workspace(t) {
  const root = await mkdtemp(join(tmpdir(), 'hongguo-toolkit-')), data = join(root, 'data')
  defer(t, () => rm(root, { recursive: true, force: true }))
  function cli(...args) {
    const result = spawnSync(process.execPath, [cliPath, 'provider', ...args], {
      cwd: root, env: { ...process.env, HONGGUO_DATA_DIR: data, HONGGUO_PROVIDERS_DIR: '' },
      encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 55000,
    })
    assert.ok([0, 1].includes(result.status), 'CLI must finish')
    const report = JSON.parse(result.stdout)
    assert.equal(result.status, report.ok === false ? 1 : 0)
    return report
  }
  async function host() {
    const store = new Store(data)
    defer(t, () => store.close())
    const sources = new ProviderRegistry(data)
    defer(t, () => sources.dispose())
    await sources.ready
    const catalog = new Catalog(store, { sources }), service = new Service(store, catalog)
    return { store, catalog, sources, service, scope: service.panel(service.open({ threadId: 'demo' }).panel) }
  }
  return { root, data, cli, host }
}

test('installed snapshots route paginated catalog, isolate stale sessions and survive repair and rollback', async t => {
  const { root, cli, host } = await workspace(t)
  const dir = join(root, 'demo'), index = join(dir, 'index.mjs'), manifestPath = join(dir, 'provider.json')
  assert.equal(cli('create', dir).id, 'demo')
  const offline = cli('test', dir)
  assert.equal(offline.stages.emptyResult.status, 'passed')
  assert.equal(offline.stages.episodePage2.status, 'passed')
  assert.equal(offline.stages.decode.status, 'unverified')
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8')), initial = await readFile(index, 'utf8')
  assert.ok(manifest.files.includes('sdk/LICENSE') && manifest.files.includes('sdk/NOTICE'))
  assert.deepEqual(await readFile(join(dir, 'sdk/LICENSE')), await readFile(new URL('../LICENSE', import.meta.url)))
  assert.match(await readFile(join(dir, 'sdk/NOTICE'), 'utf8'), /AGPL-3\.0-only/)
  const samplePath = join(dir, 'sample.mjs'), sample = await readFile(samplePath, 'utf8')
  await writeFile(samplePath, sample.replace('return filePlayback(media)', "throw providerError('ANONYMOUS_LIMITED')"))
  assert.equal(cli('install', dir).version, '1.0.0')
  assert.equal(cli('install', dir).code, 'ALREADY_INSTALLED')
  const old = await host(), { catalog, sources, service, scope } = old
  await service.call(scope, 'set_source', { source: 'demo' })
  const list = await catalog.list({ source: 'demo', query: 'Sample' })
  const second = await catalog.list({ source: 'demo', query: 'Sample', cursor: list.cursor })
  assert.equal(second.items[0].title, 'Sample 2')
  await assert.rejects(catalog.list({ source: 'demo', query: 'other', cursor: list.cursor }))
  const seriesId = list.items[0].id
  const first = await service.call(scope, 'get_episodes', { seriesId })
  const next = await service.call(scope, 'get_episodes', { seriesId, cursor: first.cursor })
  assert.equal(next.items[0].label, 'Episode 2')
  await assert.rejects(catalog.episodes({ seriesId: second.items[0].id, cursor: first.cursor }))
  const episodeId = first.items[0].id
  await service.call(scope, 'save_progress', { seriesId, episodeId, title: 'Demo', label: 'First', positionMs: 800, durationMs: 3000 })
  await assert.rejects(sources.resolvePlayback(episodeId), { code: 'ANONYMOUS_LIMITED' })
  const row = (await service.call(scope, 'get_providers', {})).items.find(p => p.id === 'demo')
  assert.equal(row.available, true)
  assert.equal(row.health.resolve.code, 'ANONYMOUS_LIMITED')
  assert.equal(row.health.episodes.status, 'passed')
  assert.ok(Date.parse(row.health.resolve.checkedAt))
  const broken = cli('doctor', '--installed', 'demo')
  assert.deepEqual(broken.stages.resolve, { status: 'failed', code: 'ANONYMOUS_LIMITED' })
  assert.equal(broken.stages.media.status, 'unverified')

  await writeFile(index, "console.error('synthetic-private-debug'); throw Error('synthetic-private-debug')")
  const rejected = cli('test', dir)
  assert.equal(rejected.ok, false)
  assert.ok(!JSON.stringify(rejected).includes('synthetic-private-debug'))
  assert.equal(cli('update', dir).code, 'LOAD_FAILED')
  assert.equal(cli('list').items[0].version, '1.0.0')
  await writeFile(index, initial)
  await writeFile(manifestPath, JSON.stringify({ ...manifest, version: '1.0.1' }))
  await writeFile(samplePath, sample.replace("'Episode ' + number", "'Updated ' + number"))
  assert.equal(cli('update', dir).version, '1.0.1')
  const updated = await host()
  const fresh = await updated.catalog.episodes({ seriesId })
  assert.equal(fresh.items[0].label, 'Updated 1')
  assert.equal(updated.store.history(seriesId, episodeId)[0].positionMs, 800)
  assert.equal(updated.sources.list().find(p => p.id === 'demo').version, '1.0.1')
  const doctor = cli('doctor', '--installed', 'demo', '--query', 'Sample')
  assert.deepEqual(doctor.stages.decode, { status: 'passed' })
  assert.deepEqual(doctor.stages.audio, { status: 'passed' })
  await assert.rejects(sources.resolvePlayback(episodeId), { code: 'ANONYMOUS_LIMITED' })
  assert.equal(cli('rollback', 'demo').version, '1.0.0')
  assert.equal((await (await host()).catalog.episodes({ seriesId })).items[0].label, 'Episode 1')
  assert.equal(cli('remove', 'demo').version, null)
  assert.deepEqual(cli('list').items, [])
  assert.equal((await host()).sources.list().some(p => p.id === 'demo'), false)
})

test('bundled source IDs cannot be installed, and an older colliding copy can be diagnosed and removed', async t => {
  const { root, data, cli, host } = await workspace(t)
  for (const { manifest } of builtins) assert.equal(cli('create', join(root, manifest.id)).code, 'PROVIDER_ID')
  const dir = join(root, 'demo'), manifestPath = join(dir, 'provider.json')
  cli('create', dir)
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'))
  const id = 'huangguo'
  await writeFile(manifestPath, JSON.stringify({ ...manifest, id, nsfw: false }))
  await writeFile(join(dir, 'index.mjs'), "import {writeFileSync} from 'node:fs'; writeFileSync(new URL('entry-ran', import.meta.url), '')")
  assert.equal(cli('install', dir).code, 'PROVIDER_ID')
  assert.deepEqual(cli('list').items, [])

  // An upgrade can introduce a built-in with an already installed ID.
  const active = randomUUID(), library = libraryDirectory(data), snapshot = join(library, active)
  await mkdir(library, { recursive: true }); await cp(dir, snapshot, { recursive: true })
  activatePackage(data, 'install', id, active, manifest.version)
  const { sources } = await host()
  assert.deepEqual(sources.list().filter(row => row.id === id).map(({ builtin, nsfw, available }) =>
    ({ builtin, nsfw, available })), [{ builtin: true, nsfw: true, available: true }])
  assert.equal(sources.defaultSource(id), 'hongguo')
  assert.equal(cli('list').items[0].code, 'PROVIDER_ID')
  assert.equal(cli('update', dir).code, 'PROVIDER_ID')
  assert.equal(cli('rollback', id).code, 'PROVIDER_ID')
  const report = cli('doctor', '--installed', id)
  assert.deepEqual(report.provider, { id, version: manifest.version })
  assert.deepEqual(report.stages.load, { status: 'failed', code: 'PROVIDER_ID' })
  await assert.rejects(access(join(snapshot, 'entry-ran')), { code: 'ENOENT' })
  assert.equal(cli('remove', id).version, null)
  assert.deepEqual(cli('list').items, [])
  assert.equal(cli('remove', id).code, 'NOT_INSTALLED')
  assert.equal((await host()).sources.get(id).id, id)
})

test('link scaffold imports into a disposable library and rejects unsafe or missing install files', async t => {
  const { root, cli } = await workspace(t), dir = join(root, 'links')
  const created = cli('create', dir, '--template', 'link')
  assert.equal(cli('create', dir).code, 'EEXIST')
  assert.equal(cli('test', dir).ok, true)
  const report = cli('doctor', dir, '--query', created.exampleQuery)
  assert.equal(report.ok, true)
  assert.equal(report.mediaScope, 'complete')
  assert.equal(report.stages.seriesPage2.status, 'unverified')
  assert.equal(report.stages.episodePage2.status, 'passed')
  const external = join(root, 'external.mjs')
  await writeFile(external, 'export default 1')
  await symlink(external, join(dir, 'linked.mjs'))
  const path = join(dir, 'provider.json'), manifest = JSON.parse(await readFile(path, 'utf8'))
  for (const unsafe of ['../external.mjs', 'linked.mjs', 'missing.mjs']) {
    await writeFile(path, JSON.stringify({ ...manifest, files: [...manifest.files, unsafe] }))
    assert.equal(cli('install', dir).ok, false)
    assert.deepEqual(cli('list').items, [])
  }
})

test('doctor skips a stale first sample, records it and decodes an available installed sample', async t => {
  const { root, cli } = await workspace(t), directory = join(root, 'stale-sample')
  cli('create', directory)
  const index = join(directory, 'index.mjs')
  const original = await readFile(index, 'utf8')
  await writeFile(index, "import { providerError } from './sdk/index.mjs'\n" + original.replace('...sampleMethods(context),', `...sampleMethods(context),
    getSeries(id, options) {
      if (id === 'sample-one') throw providerError('CONTENT_UNAVAILABLE')
      return sampleMethods(context).getSeries(id, options)
    },`))
  assert.equal(cli('install', directory).version, '1.0.0')
  const report = cli('doctor', '--installed', 'stale-sample', '--query', 'Sample')
  assert.equal(report.ok, true)
  assert.equal(report.sampleLimit, 3)
  assert.ok(report.stages.catalog.itemCount > 0)
  assert.ok(report.stages.search.itemCount > 0)
  assert.deepEqual(report.samples, [
    { index: 1, origin: 'search', outcome: 'skipped', stage: 'detail', code: 'CONTENT_UNAVAILABLE' },
    { index: 2, origin: 'search', outcome: 'selected' },
  ])
  assert.equal(report.stages.decode.status, 'passed')
  assert.equal(report.stages.audio.status, 'passed')
})

test('doctor preserves a failed pagination check while completing independent media checks', async t => {
  const { root, cli } = await workspace(t), directory = join(root, 'bad-pagination')
  cli('create', directory)
  const index = join(directory, 'index.mjs'), original = await readFile(index, 'utf8')
  await writeFile(index, "import { providerError } from './sdk/index.mjs'\n" + original.replace(
    "listSeries({ query = '', ...options } = {}) {", "listSeries({ query = '', ...options } = {}) {\n    if (options.cursor) throw providerError('CONTENT_UNAVAILABLE')"))
  const report = cli('doctor', directory, '--query', 'Sample')
  assert.equal(report.ok, false)
  assert.deepEqual(report.stages.seriesPage2, { status: 'failed', code: 'CONTENT_UNAVAILABLE' })
  assert.equal(report.stages.media.status, 'passed')
  assert.equal(report.stages.decode.status, 'passed')
  assert.equal(report.stages.audio.status, 'passed')
})

test('doctor rejects an empty discoverable homepage while still testing searchable media', async t => {
  const { root, cli } = await workspace(t), directory = join(root, 'empty-home')
  cli('create', directory)
  const index = join(directory, 'index.mjs'), original = await readFile(index, 'utf8')
  await writeFile(index, original.replace("listSeries({ query = '', ...options } = {}) {", "listSeries({ query = '', ...options } = {}) {\n    if (!query) return { items: [], cursor: null }"))
  const report = cli('doctor', directory, '--query', 'Sample')
  assert.equal(report.ok, false)
  assert.deepEqual(report.stages.catalog, { status: 'failed', code: 'NOT_FOUND' })
  assert.equal(report.stages.search.status, 'passed')
  assert.equal(report.stages.media.status, 'passed')
  assert.equal(report.stages.audio.status, 'passed')
})

test('doctor stops on terminal restrictions instead of trying a different sample', async t => {
  const { root, cli } = await workspace(t), directory = join(root, 'restricted-sample')
  cli('create', directory)
  const index = join(directory, 'index.mjs'), original = await readFile(index, 'utf8')
  await writeFile(index, "import { providerError } from './sdk/index.mjs'\n" + original.replace('...sampleMethods(context),', `...sampleMethods(context),
    getSeries(id, options) {
      if (id === 'sample-one') throw providerError('RATE_LIMITED')
      return sampleMethods(context).getSeries(id, options)
    },`))
  const report = cli('doctor', directory, '--query', 'Sample')
  assert.equal(report.ok, false)
  assert.deepEqual(report.stages.detail, { status: 'failed', code: 'RATE_LIMITED' })
  assert.equal(report.stages.resolve.status, 'unverified')
  assert.equal(report.stages.media.status, 'unverified')
  assert.equal(report.samples, undefined)
})

test('host stops a pending resolve and forwards a per-request signal to the provider', async t => {
  const { root } = await workspace(t)
  const registry = new ProviderRegistry(root, { directory: '', builtins: [] })
  defer(t, () => registry.dispose())
  const started = Promise.withResolvers(), manifest = { apiVersion: 1, id: 'wait', name: 'wait', version: '1.0.0', entry: 'index.mjs' }
  const queries = []
  registry.register(manifest, () => ({
    id: 'wait',
    listSeries({ query }) { queries.push(query); return { items: [{ id: 'one', title: 'One' }] } },
    getSeries() {}, getCover() {}, listEpisodes() {},
    async resolvePlayback(_id, { signal }) {
      started.resolve(signal)
      return new Promise((_, reject) => signal.addEventListener('abort', () => reject(Error('upstream aborted')), { once: true }))
    },
  }))
  const store = new Store(root)
  defer(t, () => store.close())
  const catalog = new Catalog(store, { sources: registry })
  await catalog.recommendations(false, 'wait')
  assert.deepEqual(queries.filter(Boolean), [])
  const controller = new AbortController(), pending = registry.resolvePlayback('p.wait.e.b25l', { signal: controller.signal })
  const signal = await started.promise
  controller.abort()
  await assert.rejects(pending, { code: 'ABORTED' })
  assert.equal(signal.aborted, true)
})

test('doctor samples encrypted first segments from both HLS tracks of an installed provider', async t => {
  const { root, cli, host } = await workspace(t)
  const directory = join(root, 'segmented')
  assert.equal(cli('create', directory).id, 'segmented')
  const write = (name, bytes) => writeFile(join(directory, name), bytes)
  await copyFile(new URL('fixtures/toolkit-hls-provider.mjs', import.meta.url), join(directory, 'hls.mjs'))
  await write('master.m3u8', [
    '#EXTM3U',
    '#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="audio",NAME="main",DEFAULT=YES,URI="audio.m3u8"',
    '#EXT-X-STREAM-INF:BANDWIDTH=200000,AUDIO="audio"', 'video.m3u8', '',
  ].join('\n'))
  const key = randomBytes(16), iv = Buffer.alloc(16)
  iv.writeUInt32BE(17, 12)
  await write('sample.key', key)
  const assets = ['index.mjs', 'master.m3u8', 'sample.key']
  const input = fileURLToPath(new URL('fixtures/avc-aac.mp4', import.meta.url))
  for (const [track, map] of [['video', '0:v:0'], ['audio', '0:a:0']]) {
    const bytes = await runFfmpeg(['-i', input, '-t', '1', '-map', map, '-c', 'copy', '-f', 'mpegts', 'pipe:1'], null, true)
    const cipher = createCipheriv('aes-128-cbc', key, iv)
    await write(track + '.ts', Buffer.concat([cipher.update(bytes), cipher.final()]))
    await write(track + '.m3u8', [
      '#EXTM3U', '#EXT-X-TARGETDURATION:1', '#EXT-X-MEDIA-SEQUENCE:17',
      '#EXT-X-KEY:METHOD=AES-128,URI="sample.key"', '#EXTINF:1,', track + '.ts',
      '#EXTINF:1,', 'missing-second.ts', '#EXT-X-ENDLIST', '',
    ].join('\n'))
    assets.push(track + '.m3u8', track + '.ts')
  }
  const manifest = JSON.parse(await readFile(join(directory, 'provider.json'), 'utf8'))
  manifest.entry = 'hls.mjs'
  manifest.files.push(...assets)
  await write('provider.json', JSON.stringify(manifest))
  assert.equal(cli('install', directory).version, '1.0.0')
  const report = cli('doctor', '--installed', 'segmented')
  assert.deepEqual(report.stages.media, { status: 'passed' })
  assert.equal(report.ok, true)
  assert.equal(report.mediaScope, 'hls-first-segment')
  assert.deepEqual(report.stages.decode, { status: 'passed' })
  assert.deepEqual(report.stages.audio, { status: 'passed' })

  const { sources } = await host()
  const playback = await sources.get('segmented').resolvePlayback('sample-one/1')
  await assert.rejects(prepareCandidate(playback.candidates[0], join(root, 'raw'), join(root, 'full.mp4'),
    playback.fetchMedia), { code: 'NOT_FOUND' })

  // Dropping the key from the installation must fail the sample even though the development folder still has it.
  manifest.version = '1.0.1'
  manifest.files = manifest.files.filter(name => name !== 'sample.key')
  await write('provider.json', JSON.stringify(manifest))
  assert.equal(cli('update', directory).version, '1.0.1')
  const missingKey = cli('doctor', '--installed', 'segmented')
  assert.equal(missingKey.ok, false)
  assert.deepEqual(missingKey.stages.media, { status: 'failed', code: 'MEDIA_EXPIRED' })
  assert.equal(missingKey.stages.decode.status, 'unverified')
  assert.equal(missingKey.mediaScope, undefined)
})
