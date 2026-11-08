// Upload the qualified archive unchanged; only CI may perform the publication.
import { readFile, writeFile } from 'node:fs/promises'
import { spawnSync } from 'node:child_process'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { git, qualifiedCandidate, registryPackage, registryTags } from './release-artifacts.mjs'
import { releaseChannel, compareVersions } from '../src/runtime/version.mjs'

export function publicationFailureCode(output) {
  const code = /npm (?:error|ERR!) code (E[A-Z0-9_]+)/.exec(output)?.[1]
  if (['E403', 'E404', 'ENEEDAUTH', 'EOTP', 'EUSAGE', 'EINTEGRITY', 'EPUBLISHCONFLICT', 'EPRIVATE', 'EUNSCOPED'].includes(code)) return 'NPM_' + code
  if (/oidc|openid|trusted publish/i.test(output)) return 'NPM_OIDC'
  if (/provenance|sigstore|attestation/i.test(output)) return 'NPM_PROVENANCE'
  return 'NPM_FAILED'
}

export async function publishRelease({ root = process.cwd(), execute = false, env = process.env, fetchImpl = fetch,
  delay = ms => new Promise(done => setTimeout(done, ms)), publishImpl } = {}) {
  const candidate = await qualifiedCandidate(root, env.RELEASE_SOURCE_SHA)
  const pkg = JSON.parse(await readFile(resolve(root, 'package.json'), 'utf8'))
  if (pkg.name !== candidate.name || pkg.version !== candidate.version || git(root, 'rev-parse', 'HEAD') !== candidate.sourceCommit)
    throw Error('Publish source differs from qualified source')
  if (!execute) {
    await writeFile(resolve(root, 'release/publish-plan.json'), JSON.stringify({ ...candidate, action: 'dry-run', platforms: ['darwin', 'linux', 'win32'] }, null, 2) + '\n')
    return candidate
  }
  if (env.GITHUB_ACTIONS !== 'true' || env.RELEASE_PUBLISH !== 'true' || !env.ACTIONS_ID_TOKEN_REQUEST_URL || !env.ACTIONS_ID_TOKEN_REQUEST_TOKEN)
    throw Error('Publishing requires GitHub Actions OIDC')
  if (candidate.releaseTag !== 'v' + candidate.version || env.RELEASE_TAG !== candidate.releaseTag || git(root, 'rev-parse', 'refs/tags/' + candidate.releaseTag + '^{commit}') !== candidate.sourceCommit)
    throw Error('Publishing requires the qualified version tag')
  const channel = releaseChannel(candidate.version), before = await registryTags(candidate, fetchImpl)
  if (before[channel] && compareVersions(before[channel], candidate.version) > 0) throw Error('Registry channel already has a newer version')
  if (channel === 'beta' && before.latest && compareVersions(candidate.version, before.latest) <= 0)
    throw Error('Beta version must follow the stable version')
  if (!await registryPackage(candidate, fetchImpl)) {
    if (publishImpl) await publishImpl(resolve(root, 'release', candidate.filename), { channel })
    else {
      const result = spawnSync('npm', ['publish', resolve(root, 'release', candidate.filename), '--tag', channel, '--access', 'public', '--registry', 'https://registry.npmjs.org', '--provenance'], {
        cwd: root, stdio: ['ignore', 'pipe', 'pipe'], encoding: 'utf8', maxBuffer: 4 * 1024 * 1024, timeout: 120000,
      })
      if (result.status !== 0) throw Object.assign(Error('npm publication failed'), {
        code: publicationFailureCode((result.stderr || '') + '\n' + (result.stdout || '')),
      })
    }
  }
  let confirmed = false, confirmedTags
  // Newly published metadata can take several minutes to reach npm read replicas.
  // Allow ten minutes before failing; a retry reuses the identical published bytes.
  const confirmationAttempts = 41
  for (let attempt = 0; attempt < confirmationAttempts; attempt++) {
    if (await registryPackage(candidate, fetchImpl)) {
      const tags = await registryTags(candidate, fetchImpl)
      if (channel === 'beta' && tags.latest !== before.latest) throw Error('Stable npm channel changed during beta publication')
      if (tags[channel] === candidate.version) { confirmed = true; confirmedTags = tags; break }
    }
    if (attempt < confirmationAttempts - 1) await delay(15000)
  }
  if (!confirmed) throw Error('Registry integrity has not been confirmed')
  await writeFile(resolve(root, 'release/publication.json'), JSON.stringify({
    name: candidate.name, version: candidate.version, channel, sourceCommit: candidate.sourceCommit,
    releaseTag: candidate.releaseTag, sha256: candidate.sha256, integrity: candidate.integrity,
    ...(channel === 'beta' ? { stableVersionBefore: before.latest ?? null, stableVersionAfter: confirmedTags.latest ?? null } : {}),
    publicationMethod: 'GitHub Actions OIDC', registryConfirmed: true, confirmedAt: new Date().toISOString(),
    url: 'https://www.npmjs.com/package/' + candidate.name + '/v/' + candidate.version,
  }, null, 2) + '\n')
  return candidate
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const flags = process.argv.slice(2)
  if (flags.some(flag => !['--publish', '--dry-run'].includes(flag)) || (flags.includes('--publish') && flags.includes('--dry-run'))) {
    console.error('Use --dry-run to preview or --publish in the release workflow.'); process.exitCode = 1
  } else {
    publishRelease({ execute: flags.includes('--publish') }).then(candidate => {
      console.log(`${flags.includes('--publish') ? 'Registry integrity confirmed' : 'Publication preview only'}: ${candidate.name}@${candidate.version}`)
    }).catch(error => {
      const reasons = new Map([
        ['Publishing requires GitHub Actions OIDC', 'OIDC_ENV'],
        ['Publishing requires the qualified version tag', 'TAG'],
        ['Publish source differs from qualified source', 'SOURCE'],
        ['Registry channel already has a newer version', 'NEWER_CHANNEL'],
        ['Beta version must follow the stable version', 'OLDER_BETA'],
        ['Stable npm channel changed during beta publication', 'STABLE_CHANNEL_CHANGED'],
        ['Registry integrity has not been confirmed', 'REGISTRY_CONFIRMATION'],
        ['Invalid registry channels', 'REGISTRY_CHANNELS'],
        ['Invalid registry channel version', 'REGISTRY_CHANNEL_VERSION'],
        ['Registry request failed', 'REGISTRY_HTTP'],
        ['Registry package differs', 'REGISTRY_INTEGRITY'],
        ['Registry channel request failed', 'REGISTRY_TAG_HTTP'],
      ])
      const code = /^NPM_[A-Z0-9_]+$/.test(error.code) ? error.code : reasons.get(error.message) || 'CHECKS'
      console.error(`Publication checks failed [${code}]; the marketplace index was not advanced.`)
      process.exitCode = 1
    })
  }
}
