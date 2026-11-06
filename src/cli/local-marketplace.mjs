import { mkdir, readFile, writeFile, rename, rm } from 'node:fs/promises'
import { join, relative, resolve } from 'node:path'
import { randomUUID } from 'node:crypto'
import { dataRoot } from '../server/paths.mjs'
import { marketplace, packageVersion } from '../runtime/distribution.mjs'

export const managedMarketplaceRoot = resolve(dataRoot(), 'managed-marketplace')
// Keep the index outside npm's disposable exec cache. A new CLI version gets a
// new registration path, so upgrades refresh the host's marketplace snapshot.
export const defaultSource = join(managedMarketplaceRoot, packageVersion)

export function isManagedMarketplace(source) {
  return typeof source === 'string' && /^\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(relative(managedMarketplaceRoot, resolve(source)))
}

export async function prepareLocalMarketplace() {
  const directory = join(defaultSource, '.agents', 'plugins')
  const path = join(directory, 'marketplace.json')
  // Install the same immutable npm release as this CLI. A newer npx update
  // registers its own versioned index instead of refreshing a Git checkout.
  const contents = JSON.stringify(marketplace(packageVersion), null, 2) + '\n'
  const temporary = join(directory, '.marketplace-' + randomUUID() + '.tmp')
  try {
    await mkdir(directory, { recursive: true, mode: 0o700 })
    if (await readFile(path, 'utf8').catch(() => '') === contents) return defaultSource
    await writeFile(temporary, contents, { mode: 0o600 })
    await rename(temporary, path)
    return defaultSource
  } catch {
    throw Error('无法准备本机 npm 插件市场索引，请检查红果用户数据目录权限后重试。')
  } finally { await rm(temporary, { force: true }).catch(() => {}) }
}
