import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import test from 'node:test'
import { changePolicy, planUpdate, releasePolicy } from '../scripts/follow-openhongguo.mjs'

const before = 'a'.repeat(40), after = 'b'.repeat(40), tree = 'c'.repeat(40)
const pin = { version: '0.4.0', upstreamVersion: '0.4.0', repository: 'https://github.com/beilunyang/openhongguo', revision: before }
const release = (version, body = '') => ({ tag_name: 'v' + version, draft: false, prerelease: false, body })
const diff = {
  status: 'ahead', merge_base_commit: { sha: before }, ahead_by: 1,
  commits: [{ sha: after, commit: { message: 'fix: preserve optional catalog fields' } }],
  files: [{ filename: 'sdk/catalog.go' }],
}
function apiFixture({ latest = release('0.4.2'), releases = [latest], comparison = diff } = {}) {
  const responses = {
    'releases/latest': latest,
    'releases?per_page=100': [releases],
    ['git/ref/tags/' + latest.tag_name]: { object: { type: 'tag', sha: 'd'.repeat(40) } },
    ['git/tags/' + 'd'.repeat(40)]: { object: { type: 'commit', sha: after } },
    ['compare/' + before + '...' + after]: comparison,
    ['git/commits/' + after]: { tree: { sha: tree } },
  }
  return path => { assert.ok(Object.hasOwn(responses, path), path); return responses[path] }
}

test('stable release boundaries and declared breaking changes', () => {
  for (const [current, next, action] of [
    ['0.4.0', '0.4.1', 'candidate'], ['0.4.0', '0.5.0', 'review'], ['0.4.0', '1.0.0', 'review'],
    ['1.2.3', '1.3.0', 'candidate'], ['1.2.3', '2.0.0', 'review'], ['1.2.3', '1.2.3', 'current'],
    ['1.2.3', '1.2.2', 'current'], ['1.2.3', '1.3.0-beta.1', 'review'],
  ]) assert.equal(releasePolicy(current, release(next)).action, action)
  assert.equal(releasePolicy('0.4.0', release('0.4.1', 'BREAKING CHANGE: renamed field')).action, 'review')
  assert.equal(releasePolicy('0.4.0', release('0.4.1', 'No breaking changes.')).action, 'candidate')
})

test('review an intermediate release, incompatible commit, incomplete comparison or sensitive rename before download', async () => {
  const blocked = [
    { releases: [release('0.4.2'), release('0.4.1', '破坏性变更')] },
    { comparison: { ...diff, commits: [{ sha: after, commit: { message: 'feat(api)!: renamed field' } }] } },
    { comparison: { ...diff, ahead_by: 2 } },
    { comparison: { ...diff, files: Array(300).fill({ filename: 'sdk/file.go' }) } },
    { comparison: { ...diff, files: [{ filename: 'new.go', previous_filename: 'internal/protocol/sign/old.go' }] } },
    { comparison: { ...diff, status: 'diverged' } },
  ]
  for (const scenario of blocked) {
    const plan = await planUpdate(pin, { readAPI: apiFixture(scenario), prepare: true, download: assert.fail })
    assert.equal(plan.action, 'review')
    assert.equal(plan.manifest, undefined)
  }
  assert.equal(changePolicy(diff, before, 'e'.repeat(40)).action, 'review')
})

test('preview is read-only and a candidate binds the peeled tag, tree and exact archive bytes', async () => {
  const readAPI = apiFixture()
  const preview = await planUpdate(pin, { readAPI, download: assert.fail })
  assert.deepEqual(preview, { action: 'candidate', tag: 'v0.4.2', revision: after, tree })
  const bytes = Buffer.from('fixture archive')
  const { manifest } = await planUpdate(pin, { readAPI, prepare: true, download: revision => {
    assert.equal(revision, after)
    return bytes
  } })
  assert.equal(pin.version, '0.4.0')
  assert.equal(manifest.version, '0.4.2')
  assert.equal(manifest.upstreamVersion, manifest.version)
  assert.equal(manifest.sourceTree, tree)
  assert.equal(manifest.sourceSHA256, createHash('sha256').update(bytes).digest('hex'))
  assert.equal(manifest.sourceURL, pin.repository + '/tree/' + after)
  assert.equal(manifest.releaseURL, pin.repository + '/releases/tag/v0.4.2')
  assert.equal(manifest.archiveURL, 'https://codeload.github.com/beilunyang/openhongguo/tar.gz/' + after)
})
