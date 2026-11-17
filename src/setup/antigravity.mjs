import { checkEnvironment } from './environment.mjs'
import { antigravity } from '../runtime/host.mjs'

console.log(JSON.stringify(await checkEnvironment(antigravity), null, 2))
