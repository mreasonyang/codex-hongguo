import { realpathSync } from 'node:fs'
import { lstat, readlink } from 'node:fs/promises'

// Only canonicalize a base selected by the user or OS. Names owned by the
// plugin below that base must remain visible to the lstat checks.
export function configuredBase(path, platform, paths) {
  if (platform !== process.platform || !paths.isAbsolute(path)) return path
  try { return realpathSync.native(path) } catch (error) {
    if (error.code !== 'ENOENT') throw error
    const parent = paths.dirname(path)
    if (parent === path) return path
    return paths.join(configuredBase(parent, platform, paths), paths.basename(path))
  }
}

export async function plainDirectory(path, paths) {
  let current = path
  for (;;) {
    const info = await lstat(current)
    if (info.isSymbolicLink()) {
      // macOS exposes its standard temporary directories through root-owned
      // aliases. Validate the documented destination and inspect its ancestry too.
      if (process.platform !== 'darwin' || info.uid !== 0 || !['/tmp', '/var', '/etc'].includes(current)) return false
      const destination = paths.resolve('/', await readlink(current))
      if (destination !== '/private' + current) return false
      current = destination
      continue
    }
    if (!info.isDirectory()) return false
    const parent = paths.dirname(current)
    if (parent === current) return true
    current = parent
  }
}
