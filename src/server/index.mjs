import { startServer } from './app.mjs'
import { codex } from '../runtime/host.mjs'

await startServer(codex)
