import { mkdir, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import { leasedProgramEntry } from '../runtime/program-lease.mjs'

// Native hosts copy their manifests and entry points into separate plugin folders.
// The entry point reads the active build at launch, so both hosts switch together.
export async function writeProgramShim(path, programHome, relativeEntry) {
  await mkdir(dirname(path), { recursive: true })
  if (relativeEntry.startsWith('dist/server/')) {
    await writeFile(path, leasedProgramEntry(programHome, relativeEntry), { mode: 0o755 })
    return
  }
  const body = `#!/usr/bin/env node
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

const home = ${JSON.stringify(programHome)}
process.env.HONGGUO_PROGRAM_DIR = home
const { directory } = JSON.parse(readFileSync(join(home, 'current.json'), 'utf8'))
if (typeof directory !== 'string' || !/^builds\\/[a-f0-9]{64}$/.test(directory)) {
  throw Error('红果共享程序登记无效，请重新运行 setup。')
}
await import(pathToFileURL(join(home, directory, ${JSON.stringify(relativeEntry)})).href)
`
  await writeFile(path, body, { mode: 0o755 })
}
