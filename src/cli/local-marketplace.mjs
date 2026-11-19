import { mkdir, writeFile } from 'node:fs/promises'
import path, { join, relative, resolve } from 'node:path'
import { realpathSync } from 'node:fs'
import { dataRoot } from '../server/paths.mjs'
import { marketplace, packageVersion } from '../runtime/distribution.mjs'
import { isVersion } from '../runtime/version.mjs'
import { writeCodexAdapter } from './codex-adapter.mjs'
import { configuredBase } from '../runtime/plain-directory.mjs'

export const managedMarketplaceRoot = join(configuredBase(resolve(dataRoot()), process.platform, path), 'managed-marketplace')
// Keep the index outside npm's disposable exec cache. A new CLI version gets a
// new registration path, so upgrades refresh the host's marketplace snapshot.
export const defaultSource = join(managedMarketplaceRoot, packageVersion)

export function marketplaceSource(registration) {
  const source = registration?.marketplaceSource?.source
  return typeof source === 'string' && source.length ? source : registration?.root
}

export function isManagedMarketplace(source, managedRoot = managedMarketplaceRoot) {
  if (typeof source !== 'string') return false
  if (isVersion(relative(managedRoot, resolve(source)))) return true
  try { return isVersion(relative(realpathSync.native(managedRoot), realpathSync.native(source))) } catch { return false }
}

export async function prepareLocalMarketplace(root, options) {
  const local = './plugins/codex-hongguo'
  await writeCodexAdapter(join(root, local), options)
  const directory = join(root, '.agents', 'plugins')
  await mkdir(directory, { recursive: true, mode: 0o700 })
  const index = marketplace(packageVersion, { source: 'local', path: local })
  await writeFile(join(directory, 'marketplace.json'), JSON.stringify(index, null, 2) + '\n', { mode: 0o600 })
}
