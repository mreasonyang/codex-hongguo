import { randomUUID } from 'node:crypto'
import { PlayerError } from './errors.mjs'

export const catalogTtl = 15 * 60000
const unavailable = () => new PlayerError('红果片源暂时不可达，请稍后重试', 503)
const fresh = (entry, now, ttl) => entry?.value !== undefined && now >= entry.updatedAt && now - entry.updatedAt < ttl

// SQLite leases coordinate all local MCP processes. Network work never holds a DB transaction.
export class SharedCatalogCache {
  constructor(store, { now = Date.now, ttl = catalogTtl, lease = 30000, poll = 150, wait = 75000 } = {}) {
    this.store = store
    this.now = now
    this.ttl = ttl
    this.lease = lease
    this.poll = poll
    this.wait = wait
    this.jobs = new Map()
  }
  async get(key, load, { stale = true, feed = false } = {}) {
    const entry = this.store.catalogCache(key)
    if (fresh(entry, this.now(), this.ttl)) return entry.value
    const work = this.refresh(key, load, feed)
    if (stale && entry?.value !== undefined) {
      void work.catch(() => {})
      return entry.value
    }
    return work
  }
  refresh(key, load, feed) {
    if (this.jobs.has(key)) return this.jobs.get(key)
    const job = this.run(key, load, feed).finally(() => {
      if (this.jobs.get(key) === job) this.jobs.delete(key)
    })
    this.jobs.set(key, job)
    return job
  }
  async run(key, load, feed) {
    const owner = randomUUID(), deadline = performance.now() + this.wait
    while (true) {
      const now = this.now(), entry = this.store.catalogCache(key)
      if (fresh(entry, now, this.ttl)) return entry.value
      if (entry?.retryAt > now) throw unavailable()
      let claimed = false
      try { claimed = this.store.claimCatalogCache(key, owner, now, this.ttl, this.lease) }
      catch (error) { if (![5, 6].includes(error.errcode)) throw error }
      if (claimed) break
      if (performance.now() >= deadline) throw unavailable()
      await new Promise(resolve => setTimeout(resolve, this.poll))
    }
    const heartbeat = setInterval(() => {
      try { this.store.renewCatalogCache(key, owner, this.now(), this.lease) } catch { /* Publication still checks ownership. */ }
    }, this.lease / 3)
    heartbeat.unref()
    try {
      const value = await load()
      if (!this.store.completeCatalogCache(key, owner, value, this.now(), feed)) throw unavailable()
      return value
    } catch (error) {
      try { this.store.failCatalogCache(key, owner, this.now()) } catch { /* A closed or replaced store cannot be updated. */ }
      throw error instanceof PlayerError ? error : unavailable()
    } finally { clearInterval(heartbeat) }
  }
}
