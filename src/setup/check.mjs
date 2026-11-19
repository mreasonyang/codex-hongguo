import { checkEnvironment } from './environment.mjs'
import { codex } from '../runtime/host.mjs'

console.log(JSON.stringify(await checkEnvironment(codex), null, 2))
