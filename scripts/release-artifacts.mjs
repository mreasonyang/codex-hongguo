// Bind a clean source commit, one package, and all three installers.
import { readFile, writeFile, mkdir, copyFile, appendFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { isVersion, releaseChannel, compareVersions } from '../src/runtime/version.mjs'

const name = '@kyun.si/codex-hongguo'
const shaPattern = /^[a-f0-9]{40}$/
const platforms = ['darwin', 'linux', 'win32']
const requiredChecks = ['native-npm-source', 'progress-preserved', 'sound-preferences-preserved']
const json = async path => JSON.parse(await readFile(path, 'utf8'))
const save = (path, value) => writeFile(path, JSON.stringify(value, null, 2) + '\n')
const hash = (bytes, algorithm = 'sha256', encoding = 'hex') => createHash(algorithm).update(bytes).digest(encoding)
const check = (condition, message) => { if (!condition) throw Error(message) }

export function git(root, ...args) {
  const result = spawnSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })
  check(result.status === 0, 'Git source validation failed')
  return result.stdout.trim()
}

export async function resolveRelease(root, { event, ref, sha, tag = '', publish = false }) {
  if (event === 'push' && ref?.startsWith('refs/tags/')) { tag = ref.slice(10); publish = true }
  check(shaPattern.test(sha), 'A full source SHA is required')
  check(!tag || (tag.startsWith('v') && isVersion(tag.slice(1))), 'Invalid release tag')
  check(!publish || tag, 'Publishing requires an existing version tag')
  const source = git(root, 'rev-parse', (tag ? 'refs/tags/' + tag : sha) + '^{commit}')
  if (event === 'push' && ref?.startsWith('refs/tags/')) check(source === git(root, 'rev-parse', sha + '^{commit}'), 'Pushed tag source changed')
  const pkg = JSON.parse(git(root, 'show', source + ':package.json'))
  check(pkg.name === name && isVersion(pkg.version), 'Invalid package version')
  check(!tag || tag === 'v' + pkg.version, 'Tag and package version differ')
  const channel = releaseChannel(pkg.version)
  if (publish && channel === 'latest') git(root, 'merge-base', '--is-ancestor', source, 'origin/main')
  return { source_sha: source, version: pkg.version, channel, release_tag: tag, publish: String(publish) }
}

export async function validateCandidate(root, expectedSha) {
  const candidate = await json(resolve(root, 'release/candidate.json'))
  const metadata = await json(resolve(root, 'release/package-metadata.json'))
  const pkg = await json(resolve(root, 'release/npm/codex-hongguo/package.json'))
  check(candidate.schema === 1 && shaPattern.test(candidate.sourceCommit), 'Invalid candidate source')
  check(!expectedSha || candidate.sourceCommit === expectedSha, 'Candidate source differs')
  check(candidate.name === name && isVersion(candidate.version), 'Invalid candidate version')
  check(candidate.channel === releaseChannel(candidate.version), 'Candidate channel differs')
  check(!candidate.releaseTag || candidate.releaseTag === 'v' + candidate.version, 'Candidate tag differs')
  check(metadata.name === name && pkg.name === name && metadata.version === candidate.version && pkg.version === candidate.version, 'Package metadata differs')
  check(candidate.filename === `kyun.si-codex-hongguo-${candidate.version}.tgz` && metadata.filename === candidate.filename, 'Invalid archive name')
  const bytes = await readFile(resolve(root, 'release', candidate.filename))
  check(candidate.sha256 === hash(bytes) && candidate.integrity === 'sha512-' + hash(bytes, 'sha512', 'base64'), 'Package integrity differs')
  check(candidate.offlineSha256 === hash(await readFile(resolve(root, `release/codex-hongguo-${candidate.version}.zip`))), 'Offline ZIP integrity differs')
  const indexBytes = await readFile(resolve(root, 'release/marketplace/.agents/plugins/marketplace.json'))
  check(candidate.indexSha256 === hash(indexBytes), 'Marketplace integrity differs')
  const plugins = JSON.parse(indexBytes).plugins
  check(plugins?.length === 1 && plugins[0].source?.source === 'npm' && plugins[0].source.package === name && plugins[0].source.version === candidate.version, 'Marketplace version differs')
  return candidate
}

export async function prepareCandidate(root, expectedSha, releaseTag = '') {
  check(shaPattern.test(expectedSha) && git(root, 'rev-parse', 'HEAD') === expectedSha, 'Checkout source differs')
  check(!git(root, 'status', '--porcelain'), 'Release source must be clean')
  const pkg = await json(resolve(root, 'package.json'))
  const metadata = await json(resolve(root, 'release/package-metadata.json'))
  check(pkg.name === name && isVersion(pkg.version) && metadata.version === pkg.version, 'Package version differs')
  check(!releaseTag || (releaseTag === 'v' + pkg.version && git(root, 'rev-parse', 'refs/tags/' + releaseTag + '^{commit}') === expectedSha), 'Release tag differs')
  check(metadata.filename === `kyun.si-codex-hongguo-${pkg.version}.tgz`, 'Invalid archive name')
  const bytes = await readFile(resolve(root, 'release', metadata.filename))
  const candidate = {
    schema: 1, name, version: pkg.version, channel: releaseChannel(pkg.version), sourceCommit: expectedSha, releaseTag, filename: metadata.filename,
    sha256: hash(bytes), integrity: 'sha512-' + hash(bytes, 'sha512', 'base64'),
    offlineSha256: hash(await readFile(resolve(root, `release/codex-hongguo-${pkg.version}.zip`))),
    indexSha256: hash(await readFile(resolve(root, 'release/marketplace/.agents/plugins/marketplace.json'))),
  }
  await save(resolve(root, 'release/candidate.json'), candidate)
  return validateCandidate(root, expectedSha)
}

export function validateReceipts(candidate, receipts) {
  check(Array.isArray(receipts) && receipts.length === 3 && new Set(receipts.map(r => r.platform)).size === 3, 'Three distinct platform receipts are required')
  for (const receipt of receipts) {
    check(platforms.includes(receipt.platform) && receipt.name === candidate.name && receipt.version === candidate.version && receipt.sha256 === candidate.sha256 && receipt.sourceCommit === candidate.sourceCommit, 'Installer receipt differs from candidate')
    check(receipt.installation === 'fresh' && requiredChecks.every(item => receipt.checks?.includes(item)), 'Installer checks are incomplete')
  }
}

export async function sealReceipt(root, expectedSha, platform = process.platform) {
  const candidate = await validateCandidate(root, expectedSha)
  check(git(root, 'rev-parse', 'HEAD') === candidate.sourceCommit, 'Installer source differs')
  const receipt = await json(resolve(root, 'release/verification.json'))
  check(platforms.includes(platform) && receipt.platform === platform && receipt.name === name && receipt.version === candidate.version && receipt.sha256 === candidate.sha256, 'Native installer receipt differs')
  check(receipt.installation === 'fresh' && requiredChecks.every(item => receipt.checks?.includes(item)), 'Native installer checks are incomplete')
  await mkdir(resolve(root, 'release/qualifications'), { recursive: true })
  await save(resolve(root, `release/qualifications/${platform}.json`), { ...receipt, sourceCommit: candidate.sourceCommit })
}

export async function collectReceipts(root, expectedSha) {
  const candidate = await validateCandidate(root, expectedSha)
  const qualifications = await Promise.all(platforms.map(platform => json(resolve(root, `release/qualifications/${platform}.json`))))
  validateReceipts(candidate, qualifications)
  await save(resolve(root, 'release/verification.json'), {
    schema: 1, name, version: candidate.version, sourceCommit: candidate.sourceCommit, sha256: candidate.sha256,
    checks: ['three-platform-same-artifact'], qualifications, desktopPlaybackObserved: false,
  })
  return candidate
}

export async function qualifiedCandidate(root, expectedSha) {
  const candidate = await validateCandidate(root, expectedSha)
  const receipt = await json(resolve(root, 'release/verification.json'))
  check(receipt.schema === 1 && receipt.name === name && receipt.version === candidate.version && receipt.sourceCommit === candidate.sourceCommit && receipt.sha256 === candidate.sha256, 'Aggregate receipt differs')
  validateReceipts(candidate, receipt.qualifications)
  return candidate
}

export async function registryPackage(candidate, fetchImpl = fetch) {
  const response = await fetchImpl('https://registry.npmjs.org/' + encodeURIComponent(candidate.name) + '/' + candidate.version, { headers: { 'Cache-Control': 'no-cache' }, signal: AbortSignal.timeout(10000) })
  if (response.status === 404) return null
  check(response.ok, 'Registry request failed')
  const pkg = await response.json()
  check(pkg.name === candidate.name && pkg.version === candidate.version && pkg.dist?.integrity === candidate.integrity, 'Registry package differs')
  return pkg
}

export async function registryTags(candidate, fetchImpl = fetch) {
  const response = await fetchImpl('https://registry.npmjs.org/' + encodeURIComponent(candidate.name), {
    headers: { Accept: 'application/vnd.npm.install-v1+json', 'Cache-Control': 'no-cache' }, signal: AbortSignal.timeout(10000),
  })
  if (response.status === 404) return {}
  check(response.ok, 'Registry channel request failed')
  const pkg = await response.json(), tags = pkg['dist-tags']
  check(pkg.name === name && tags && typeof tags === 'object', 'Invalid registry channels')
  for (const channel of ['latest', 'beta']) check(tags[channel] === undefined ||
    (isVersion(tags[channel]) && releaseChannel(tags[channel]) === channel), 'Invalid registry channel version')
  return tags
}

export async function updatePublishedIndex(root, fetchImpl = fetch) {
  const candidate = await qualifiedCandidate(root)
  const publication = await json(resolve(root, 'release/publication.json'))
  check(publication.registryConfirmed === true && publication.channel === candidate.channel && publication.name === name && publication.version === candidate.version && publication.sourceCommit === candidate.sourceCommit && publication.integrity === candidate.integrity && publication.sha256 === candidate.sha256, 'Publication receipt differs')
  check(await registryPackage(candidate, fetchImpl), 'Package is not visible in npm')
  const indexPath = resolve(root, '.agents/plugins/marketplace.json')
  const current = (await json(indexPath)).plugins?.[0]?.source?.version
  check(isVersion(current) && releaseChannel(current) === 'latest', 'Invalid current marketplace version')
  const recordPath = resolve(root, `docs/releases/npm-${candidate.version}.json`)
  const existing = await json(recordPath).catch(error => { if (error.code !== 'ENOENT') throw error })
  check(!existing || (existing.integrity === candidate.integrity && existing.sourceCommit === candidate.sourceCommit), 'Existing release record differs')
  if (candidate.channel === 'latest' && compareVersions(current, candidate.version) <= 0)
    await copyFile(resolve(root, 'release/marketplace/.agents/plugins/marketplace.json'), indexPath)
  await mkdir(resolve(root, 'docs/releases'), { recursive: true })
  if (!existing) await save(recordPath, publication)
}

async function main() {
  const root = process.cwd(), mode = process.argv[2], sha = process.env.RELEASE_SOURCE_SHA
  let outputs = {}
  if (mode === 'resolve') outputs = await resolveRelease(root, {
    event: process.env.GITHUB_EVENT_NAME, ref: process.env.GITHUB_REF, sha: process.env.GITHUB_SHA,
    tag: process.env.INPUT_TAG || '', publish: process.env.INPUT_PUBLISH === 'true',
  })
  else if (mode === 'prepare') {
    const candidate = await prepareCandidate(root, sha, process.env.RELEASE_TAG || '')
    outputs = { source_sha: candidate.sourceCommit, version: candidate.version, artifact_name: `candidate-${process.env.GITHUB_RUN_ID || 'local'}-${process.env.GITHUB_RUN_ATTEMPT || '1'}` }
  } else if (mode === 'receipt') await sealReceipt(root, sha)
  else if (mode === 'collect') {
    await collectReceipts(root, sha)
    outputs.artifact_name = `qualified-${process.env.GITHUB_RUN_ID || 'local'}-${process.env.GITHUB_RUN_ATTEMPT || '1'}`
  } else if (mode === 'index') await updatePublishedIndex(root)
  else throw Error('Unknown release command')
  if (process.env.GITHUB_OUTPUT) await appendFile(process.env.GITHUB_OUTPUT, Object.entries(outputs).map(([key, value]) => `${key}=${value}\n`).join(''))
  console.log('Release artifact/source checks passed: ' + mode)
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(() => { console.error('Release artifact/source validation failed; publication/index steps were stopped.'); process.exitCode = 1 })
}
