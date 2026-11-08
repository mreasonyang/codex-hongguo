import test from 'node:test'
import assert from 'node:assert/strict'
import { isVersion, releaseChannel, compareVersions, nextBetaVersion } from '../src/runtime/version.mjs'
import { isManagedMarketplace } from '../src/cli/local-marketplace.mjs'
import { join } from 'node:path'

test('stable and beta versions retain the three bounded numeric segments and require canonical positive beta sequences', () => {
  for (const version of ['0.0.1', '0.0.35', '999.999.999', '0.0.35-beta.1', '0.0.35-beta.12']) assert.equal(isVersion(version), true)
  for (const version of ['', 'v0.0.35', '0.0', '0.00.35', '1000.0.1', '0.0.1000', '0.0.35-beta', '0.0.35-beta.0', '0.0.35-beta.01', '0.0.35-beta.1.extra', '0.0.35-rc.1', '0.0.35-beta.9007199254740992', '../0.0.35-beta.1']) assert.equal(isVersion(version), false, version)
  assert.equal(releaseChannel('0.0.35'), 'latest')
  assert.equal(releaseChannel('0.0.35-beta.2'), 'beta')
})
test('beta sequence and promotion order are numeric and do not change the selected base version', () => {
  const order = ['0.0.34', '0.0.35-beta.1', '0.0.35-beta.2', '0.0.35-beta.10', '0.0.35', '0.0.36-beta.1']
  for (let i = 1; i < order.length; i++) assert.equal(compareVersions(order[i - 1], order[i]), -1)
  assert.equal(nextBetaVersion('0.0.34'), '0.0.35-beta.1')
  assert.equal(nextBetaVersion('0.0.35-beta.1'), '0.0.35-beta.2')
  assert.equal(nextBetaVersion('0.0.35'), '0.0.36-beta.1')
  assert.throws(() => nextBetaVersion('0.0.999'), /exhausted/)
})
test('beta installation indexes are recognized as managed while external and traversal paths remain excluded', () => {
  const root = join(process.cwd(), 'synthetic-marketplace')
  assert.equal(isManagedMarketplace(join(root, '0.0.35-beta.1'), root), true)
  assert.equal(isManagedMarketplace(join(root, '0.0.35'), root), true)
  assert.equal(isManagedMarketplace(join(root, '..', 'external', '0.0.35-beta.1'), root), false)
  assert.equal(isManagedMarketplace(join(root, '0.0.35-beta.01'), root), false)
})
