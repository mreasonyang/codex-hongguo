import { DatabaseSync } from 'node:sqlite'
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { page } from './sdk/index.mjs'
import { shows, sampleMethods, slicePage } from './sample.mjs'

/** @type {import('./sdk/index.mjs').CreateProvider} */
export function createProvider(context) {
  mkdirSync(context.dataDir, { recursive: true, mode: 0o700 })
  const library = new DatabaseSync(join(context.dataDir, 'links.sqlite'))
  library.exec('PRAGMA busy_timeout=3000; CREATE TABLE IF NOT EXISTS links(id TEXT PRIMARY KEY)')
  return {
    ...sampleMethods(context),
    discovery: false,
    listSeries({ query = '', ...options } = {}) {
      options.signal?.throwIfAborted()
      if (query) {
        const show = shows.find(item => query === 'https://sample.invalid/watch/' + item.id)
        if (!show) return page([])
        library.prepare('INSERT OR IGNORE INTO links VALUES(?)').run(show.id)
        return page([show])
      }
      const saved = library.prepare('SELECT id FROM links ORDER BY id').all()
      return slicePage(saved.map(row => shows.find(item => item.id === row.id)).filter(Boolean), options)
    },
    dispose() { library.close() },
  }
}
