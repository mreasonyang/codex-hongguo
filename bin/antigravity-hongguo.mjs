#!/usr/bin/env node
import { main } from '../dist/cli/main.mjs'
await main(process.argv.slice(2), 'antigravity')
