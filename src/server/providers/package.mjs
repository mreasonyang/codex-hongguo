import { lstat, readFile, realpath } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { validateManifest, providerError, relativeFile } from '../../../provider-kit/sdk/index.mjs'

export async function packageFile(directory, name) {
  if (!relativeFile(name)) throw providerError('MANIFEST')
  const file = join(directory, name)
  const stat = await lstat(file)
  if (!stat.isFile() || await realpath(file) !== file) throw providerError('MANIFEST')
  return { file, size: stat.size }
}
export async function readPackage(directory) {
  if (!(await lstat(directory)).isDirectory()) throw providerError('MANIFEST')
  directory = await realpath(resolve(directory))
  const { file, size } = await packageFile(directory, 'provider.json')
  if (size > 16384) throw providerError('MANIFEST')
  const manifest = validateManifest(JSON.parse(await readFile(file, 'utf8')))
  // Older local manifests can spell the relative entry with a leading "./".
  const entry = (await packageFile(directory, manifest.entry?.replace(/^\.\//, ''))).file
  return { directory, manifest, factory: async context => {
    const module = await import(pathToFileURL(entry).href)
    if (typeof module.createProvider !== 'function') throw providerError('CONTRACT')
    return module.createProvider(context)
  } }
}
