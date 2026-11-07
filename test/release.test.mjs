import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile, readFile, rm, access } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { git, resolveRelease, prepareCandidate, validateCandidate, sealReceipt, collectReceipts, qualifiedCandidate, updatePublishedIndex } from '../scripts/release-artifacts.mjs'
import { publishRelease } from '../scripts/publish.mjs'

const name = '@kyun.si/codex-hongguo', version = '0.0.34'
const writeJson = (path, value) => writeFile(path, JSON.stringify(value) + '\n')
const readJson = async path => JSON.parse(await readFile(path, 'utf8'))
const index = version => ({ plugins: [{ source: { source: 'npm', package: name, version } }] })
const missing = path => assert.rejects(access(path), { code: 'ENOENT' })
const registry = candidate => async () => ({ ok: true, status: 200, json: async () => ({ name, version, dist: { integrity: candidate.integrity } }) })
const absent = async () => ({ ok: false, status: 404 })

async function fixture(t, { tagged = true, qualified = true } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'hongguo-release-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  await mkdir(join(root, '.agents/plugins'), { recursive: true })
  await writeJson(join(root, 'package.json'), { name, version })
  await writeJson(join(root, '.agents/plugins/marketplace.json'), index('0.0.33'))
  await writeFile(join(root, '.gitignore'), '/release/\n')
  git(root, 'init', '-b', 'main')
  git(root, 'config', 'core.autocrlf', 'false')
  git(root, 'add', '.')
  git(root, '-c', 'user.name=Release Test', '-c', 'user.email=release@example.invalid', '-c', 'commit.gpgsign=false', 'commit', '-m', 'fixture')
  const sha = git(root, 'rev-parse', 'HEAD')
  git(root, 'update-ref', 'refs/remotes/origin/main', sha)
  if (tagged) git(root, 'tag', 'v' + version)
  for (const path of ['release/npm/codex-hongguo', 'release/marketplace/.agents/plugins']) await mkdir(join(root, path), { recursive: true })
  await writeJson(join(root, 'release/npm/codex-hongguo/package.json'), { name, version })
  await writeJson(join(root, 'release/package-metadata.json'), { name, version, filename: `kyun.si-codex-hongguo-${version}.tgz` })
  await writeJson(join(root, 'release/marketplace/.agents/plugins/marketplace.json'), index(version))
  await writeFile(join(root, `release/kyun.si-codex-hongguo-${version}.tgz`), 'synthetic archive for release metadata checks')
  await writeFile(join(root, `release/codex-hongguo-${version}.zip`), 'synthetic offline archive')
  const candidate = await prepareCandidate(root, sha, tagged ? 'v' + version : '')
  if (qualified) {
    for (const platform of ['darwin', 'linux', 'win32']) {
      await writeJson(join(root, 'release/verification.json'), {
        name, version, platform, sha256: candidate.sha256, installation: 'fresh',
        checks: ['native-npm-source', 'progress-preserved', 'sound-preferences-preserved'],
      })
      await sealReceipt(root, sha, platform)
    }
    await collectReceipts(root, sha)
  }
  // Synthetic OIDC metadata: no real credential is read or used in these tests.
  const env = { GITHUB_ACTIONS: 'true', RELEASE_PUBLISH: 'true', RELEASE_SOURCE_SHA: sha, RELEASE_TAG: 'v' + version,
    ACTIONS_ID_TOKEN_REQUEST_URL: 'https://example.invalid/oidc', ACTIONS_ID_TOKEN_REQUEST_TOKEN: 'synthetic-test-placeholder' }
  return { root, sha, candidate, env }
}

test('release resolution pins the tag commit after main advances and requires main ancestry', async t => {
  const { root, sha } = await fixture(t)
  await writeFile(join(root, 'later.txt'), 'later main commit')
  git(root, 'add', 'later.txt')
  git(root, '-c', 'user.name=Release Test', '-c', 'user.email=release@example.invalid', '-c', 'commit.gpgsign=false', 'commit', '-m', 'later')
  const latest = git(root, 'rev-parse', 'HEAD')
  git(root, 'update-ref', 'refs/remotes/origin/main', latest)
  assert.deepEqual(await resolveRelease(root, { event: 'push', ref: 'refs/tags/v' + version, sha }), {
    source_sha: sha, version, release_tag: 'v' + version, publish: 'true',
  })
  assert.equal((await resolveRelease(root, { event: 'workflow_dispatch', sha: latest })).source_sha, latest)
  await assert.rejects(resolveRelease(root, { sha, publish: true }), /requires/)
  git(root, 'tag', 'v0.0.35', sha)
  await assert.rejects(resolveRelease(root, { sha, tag: 'v0.0.35', publish: true }), /differ/)
  await assert.rejects(resolveRelease(root, { sha, tag: '../main' }), /Invalid/)
  git(root, 'checkout', '--orphan', 'unrelated')
  git(root, '-c', 'user.name=Release Test', '-c', 'user.email=release@example.invalid', '-c', 'commit.gpgsign=false', 'commit', '-m', 'unrelated')
  git(root, 'tag', '-f', 'v' + version)
  await assert.rejects(resolveRelease(root, { sha, tag: 'v' + version, publish: true }), /Git source/)
})

test('candidate rejects dirty source, a different source SHA and modified archives', async t => {
  const { root, sha } = await fixture(t)
  await assert.rejects(validateCandidate(root, 'a'.repeat(40)), /source differs/)
  await writeFile(join(root, 'dirty.txt'), 'uncommitted')
  await assert.rejects(prepareCandidate(root, sha), /must be clean/)
  await writeFile(join(root, `release/kyun.si-codex-hongguo-${version}.tgz`), 'changed archive')
  await assert.rejects(qualifiedCandidate(root, sha), /integrity differs/)
})

test('qualification rejects missing, duplicate and foreign-source platform receipts', async t => {
  const { root, sha } = await fixture(t)
  const path = join(root, 'release/qualifications/win32.json'), original = await readJson(path)
  await rm(path)
  await assert.rejects(collectReceipts(root, sha), { code: 'ENOENT' })
  await writeJson(path, { ...original, platform: 'darwin' })
  await assert.rejects(collectReceipts(root, sha), /distinct platform/)
  await writeJson(path, { ...original, sourceCommit: 'a'.repeat(40) })
  await assert.rejects(collectReceipts(root, sha), /differs/)
  await writeJson(path, { ...original, checks: ['native-npm-source'] })
  await assert.rejects(collectReceipts(root, sha), /incomplete/)
})

test('preview cannot access npm or change the marketplace', async t => {
  const { root, sha } = await fixture(t, { tagged: false })
  const before = await readFile(join(root, '.agents/plugins/marketplace.json'), 'utf8')
  const forbidden = () => assert.fail('preview must not contact npm')
  await publishRelease({ root, env: { RELEASE_SOURCE_SHA: sha }, fetchImpl: forbidden, publishImpl: forbidden })
  assert.equal((await readJson(join(root, 'release/publish-plan.json'))).action, 'dry-run')
  assert.equal(await readFile(join(root, '.agents/plugins/marketplace.json'), 'utf8'), before)
  await missing(join(root, 'release/publication.json'))
})

test('publication requires CI OIDC, a matching tag, and the qualified checkout', async t => {
  const { root, env } = await fixture(t)
  const forbidden = () => assert.fail('invalid publication must not contact npm')
  await assert.rejects(publishRelease({ root, execute: true, env: {}, fetchImpl: forbidden }), /OIDC/)
  await assert.rejects(publishRelease({ root, execute: true, env: { ...env, ACTIONS_ID_TOKEN_REQUEST_TOKEN: '' }, fetchImpl: forbidden }), /OIDC/)
  await assert.rejects(publishRelease({ root, execute: true, env: { ...env, RELEASE_TAG: 'v0.0.35' }, fetchImpl: forbidden }), /version tag/)
  git(root, 'tag', '-d', 'v' + version)
  await assert.rejects(publishRelease({ root, execute: true, env, fetchImpl: forbidden }), /Git source/)
  await writeJson(join(root, 'package.json'), { name, version: '0.0.35' })
  await assert.rejects(publishRelease({ root, execute: true, env, fetchImpl: forbidden }), /Publish source/)
})

test('publication uploads the exact archive and waits for registry integrity before recording success', async t => {
  const { root, candidate, env } = await fixture(t)
  let uploaded = false, attempts = 0
  const fetchImpl = async (...args) => !uploaded || attempts++ < 1 ? absent() : registry(candidate)(...args)
  await publishRelease({ root, execute: true, env, fetchImpl, delay: async () => {}, publishImpl: async archive => {
    assert.equal(archive, join(root, 'release', candidate.filename))
    uploaded = true
  } })
  assert.equal(uploaded, true)
  assert.equal((await readJson(join(root, 'release/publication.json'))).integrity, candidate.integrity)
  assert.equal((await readJson(join(root, '.agents/plugins/marketplace.json'))).plugins[0].source.version, '0.0.33')
})

test('publication retries accept only identical existing npm bytes', async t => {
  const { root, candidate, env } = await fixture(t)
  await publishRelease({ root, execute: true, env, fetchImpl: registry(candidate), publishImpl: () => assert.fail('must reuse identical publication') })
  await rm(join(root, 'release/publication.json'))
  await assert.rejects(publishRelease({ root, execute: true, env, fetchImpl: registry({ ...candidate, integrity: 'different' }), publishImpl: () => assert.fail() }), /Registry package differs/)
  await missing(join(root, 'release/publication.json'))
  await assert.rejects(publishRelease({ root, execute: true, env, fetchImpl: absent, delay: async () => {}, publishImpl: async () => {} }), /not been confirmed/)
  await missing(join(root, 'release/publication.json'))
})

test('index advances only after registry confirmation, tolerates newer main and never downgrades', async t => {
  const { root, candidate, env } = await fixture(t)
  await publishRelease({ root, execute: true, env, fetchImpl: registry(candidate) })
  await assert.rejects(updatePublishedIndex(root, absent), /not visible/)
  assert.equal((await readJson(join(root, '.agents/plugins/marketplace.json'))).plugins[0].source.version, '0.0.33')
  await writeJson(join(root, 'package.json'), { name, version: '0.0.35' })
  await updatePublishedIndex(root, registry(candidate))
  assert.equal((await readJson(join(root, '.agents/plugins/marketplace.json'))).plugins[0].source.version, version)
  assert.equal((await readJson(join(root, 'docs/releases/npm-' + version + '.json'))).sourceCommit, candidate.sourceCommit)
  await writeJson(join(root, '.agents/plugins/marketplace.json'), index('0.0.35'))
  await updatePublishedIndex(root, registry(candidate))
  assert.equal((await readJson(join(root, '.agents/plugins/marketplace.json'))).plugins[0].source.version, '0.0.35')
})
