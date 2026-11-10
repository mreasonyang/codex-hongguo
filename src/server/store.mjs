import { DatabaseSync } from 'node:sqlite'
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { dataRoot } from './paths.mjs'
import { sourceId, seriesPattern, belongsTo, idGlob } from './sources/ids.mjs'

export function validId(value) {
  return typeof value === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(value)
}
export function callerId(meta = {}) {
  const ids = [meta.thread_id, meta.threadId].filter((id) => id !== undefined)
  return ids.length && ids.every((id) => validId(id) && id === ids[0]) ? ids[0] : null
}
function rankedTitles(rows) {
  const titles = new Map()
  for (const { id, title, contentType, episodes } of rows) {
    if (seriesPattern.test(id) && typeof title === 'string' && title.trim() && !titles.has(id))
      titles.set(id, { id, title, ...(contentType ? { contentType } : {}), ...(episodes ? { episodes } : {}) })
    if (titles.size === 48) break
  }
  return [...titles.values()]
}
export class Store {
  constructor(root = dataRoot(), memoryOnly = false) {
    if (!memoryOnly) mkdirSync(root, { recursive: true, mode: 0o700 })
    this.persistent = !memoryOnly
    this.root = root
    this.db = new DatabaseSync(memoryOnly ? ':memory:' : join(root, 'player.sqlite'))
    this.db.exec(`PRAGMA busy_timeout=250; PRAGMA journal_mode=WAL;
      CREATE TABLE IF NOT EXISTS turn_state (
        session_id TEXT NOT NULL, turn_id TEXT NOT NULL, submitted_at INTEGER,
        stop_kind TEXT, interrupted INTEGER NOT NULL DEFAULT 0, stopped INTEGER NOT NULL DEFAULT 0,
        observed_at INTEGER NOT NULL, revision INTEGER NOT NULL DEFAULT 1, PRIMARY KEY(session_id,turn_id));
      CREATE INDEX IF NOT EXISTS latest_turn ON turn_state(session_id, submitted_at DESC);
      CREATE TABLE IF NOT EXISTS waiting_card (
        session_id TEXT NOT NULL, turn_id TEXT NOT NULL, PRIMARY KEY(session_id,turn_id));
      CREATE TABLE IF NOT EXISTS waiting_dismissal (
        session_id TEXT NOT NULL, turn_id TEXT NOT NULL, PRIMARY KEY(session_id,turn_id));
      CREATE TABLE IF NOT EXISTS recommendation_feed (
        id INTEGER PRIMARY KEY CHECK(id=1), items TEXT NOT NULL, updated_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS source_recommendation_feed (
        source TEXT PRIMARY KEY, items TEXT NOT NULL, updated_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS content_recommendation_feed (
        source TEXT NOT NULL, context TEXT NOT NULL, items TEXT NOT NULL, updated_at INTEGER NOT NULL, PRIMARY KEY(source,context));
      CREATE TABLE IF NOT EXISTS recommendation_context (
        session_id TEXT NOT NULL, turn_id TEXT NOT NULL, context TEXT NOT NULL, PRIMARY KEY(session_id,turn_id));
      CREATE TABLE IF NOT EXISTS recommendation_source (
        session_id TEXT NOT NULL, turn_id TEXT NOT NULL, source TEXT NOT NULL, PRIMARY KEY(session_id,turn_id));
      CREATE TABLE IF NOT EXISTS catalog_cache (
        key TEXT PRIMARY KEY, value TEXT, updated_at INTEGER NOT NULL DEFAULT 0,
        retry_at INTEGER NOT NULL DEFAULT 0, failures INTEGER NOT NULL DEFAULT 0,
        lease_owner TEXT, lease_until INTEGER NOT NULL DEFAULT 0, touched_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS turn_picks (
        session_id TEXT NOT NULL, turn_id TEXT NOT NULL, items TEXT NOT NULL,
        reserved_at INTEGER, shown INTEGER NOT NULL DEFAULT 0, PRIMARY KEY(session_id,turn_id));
      CREATE INDEX IF NOT EXISTS pending_picks ON turn_picks(reserved_at) WHERE shown=0;
      CREATE TABLE IF NOT EXISTS pick_exposure (series_id TEXT PRIMARY KEY, last_shown INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS visible_player (
        session_id TEXT NOT NULL, instance TEXT NOT NULL, seen_at INTEGER NOT NULL,
        PRIMARY KEY(session_id,instance));
      CREATE TABLE IF NOT EXISTS player_onboarding (
        id INTEGER PRIMARY KEY CHECK(id=1), dismissed INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS watch_progress (
        series_id TEXT NOT NULL, episode_id TEXT NOT NULL, title TEXT NOT NULL, label TEXT NOT NULL,
        position_ms INTEGER NOT NULL, duration_ms INTEGER NOT NULL, updated_at INTEGER NOT NULL,
        PRIMARY KEY(series_id,episode_id));
      CREATE TABLE IF NOT EXISTS watch_restart (
        series_id TEXT NOT NULL, episode_id TEXT NOT NULL, PRIMARY KEY(series_id,episode_id));
      CREATE TABLE IF NOT EXISTS player_preferences(id INTEGER PRIMARY KEY, body TEXT NOT NULL);`)
    // Remove only the two local demonstration shows shipped in 0.0.1 and 0.0.2.
    if (this.db.prepare('PRAGMA user_version').get().user_version === 0) {
      this.db.exec(`BEGIN IMMEDIATE;
        DELETE FROM watch_progress WHERE series_id IN ('tide','ridge');
        PRAGMA user_version=1;
        COMMIT;`)
    }
    // Both predecessor branches used version 2 for different migrations.
    // Complete both idempotently, including databases already marked version 2.
    if (this.db.prepare('PRAGMA user_version').get().user_version < 3) {
      this.db.exec(`BEGIN IMMEDIATE;
        INSERT OR IGNORE INTO source_recommendation_feed
          SELECT 'hongguo',items,updated_at FROM recommendation_feed WHERE id=1;
        UPDATE player_preferences SET body=json_remove(body, '$.decoyUrl', '$.decoyFrameUrl')
          WHERE json_type(body, '$.decoyUrl') IS NOT NULL OR json_type(body, '$.decoyFrameUrl') IS NOT NULL;
        PRAGMA user_version=3; COMMIT;`)
    }
    if (this.db.prepare('PRAGMA user_version').get().user_version < 4) {
      this.db.exec(`BEGIN IMMEDIATE;
        UPDATE player_preferences SET body=json_remove(body, '$.enabledProviders');
        PRAGMA user_version=4; COMMIT;`)
    }
  }
  preferences() {
    const row = this.db.prepare('SELECT body FROM player_preferences WHERE id=1').get()
    const defaults = {
      autoPrompt: true, autoplayNext: true, autoPauseOnFinish: true, autoPlayOnStart: true,
      defaultMuted: true, volume: 0.7, hoverDecoyEnabled: false, coverStyle: 'random',
      searchTerms: ['总裁', '重生', '逆袭'], defaultSource: 'hongguo', contentPreferences: {},
    }
    const settings = row ? { ...defaults, ...JSON.parse(row.body) } : defaults
    delete settings.enabledProviders
    return settings
  }
  setupDismissed() {
    return this.db.prepare('SELECT dismissed FROM player_onboarding WHERE id=1').get()?.dismissed === 1
  }
  setSetupDismissed(dismissed) {
    this.db.prepare('INSERT OR REPLACE INTO player_onboarding VALUES(1,?)').run(Number(dismissed))
    return { dismissed }
  }
  setPreferences(settings) {
    return this.transaction(() => {
      const previous = this.preferences()
      const updated = { ...previous, ...settings, contentPreferences: { ...previous.contentPreferences, ...settings.contentPreferences } }
      delete updated.enabledProviders
      this.db.prepare('INSERT OR REPLACE INTO player_preferences VALUES(1,?)').run(JSON.stringify(updated))
      if (JSON.stringify(previous.searchTerms) !== JSON.stringify(updated.searchTerms)) {
        this.db.exec('DELETE FROM recommendation_feed')
        this.db.exec('DELETE FROM source_recommendation_feed')
        this.db.exec('DELETE FROM content_recommendation_feed')
        this.db.exec("DELETE FROM catalog_cache WHERE key LIKE 'feed:%'")
      }
      return updated
    })
  }
  event({ session_id, turn_id, hook_event_name }, now = Date.now()) {
    if (
      !validId(session_id) ||
      !validId(turn_id) ||
      !['UserPromptSubmit', 'Stop', 'Interrupt'].includes(hook_event_name)
    )
      return
    const stop = Number(hook_event_name === 'Stop'),
      interrupt = Number(hook_event_name === 'Interrupt')
    return this.db
      .prepare(
        `INSERT INTO turn_state(session_id,turn_id,submitted_at,stop_kind,stopped,interrupted,observed_at)
      VALUES(?,?,?,?,?,?,?) ON CONFLICT(session_id,turn_id) DO UPDATE SET
      submitted_at=COALESCE(submitted_at,CASE WHEN excluded.submitted_at IS NOT NULL THEN min(observed_at,excluded.submitted_at) END),
      stop_kind=COALESCE(excluded.stop_kind,stop_kind), stopped=max(stopped,excluded.stopped),
      interrupted=max(interrupted,excluded.interrupted), observed_at=excluded.observed_at, revision=revision+1
      WHERE (submitted_at IS NULL AND excluded.submitted_at IS NOT NULL) OR
            stopped<excluded.stopped OR interrupted<excluded.interrupted`,
      )
      .run(
        session_id,
        turn_id,
        stop || interrupt ? null : now,
        stop || interrupt ? hook_event_name : null,
        stop,
        interrupt,
        now,
      ).changes > 0
  }
  activeTurn(sessionId, turnId) {
    const latest = this.state(sessionId)
    return this.persistent && !!turnId && latest.turnId === turnId && latest.state === 'submitted'
  }
  offerable(sessionId, turnId) {
    return this.activeTurn(sessionId, turnId) && this.preferences().autoPrompt && !this.picksDismissed(sessionId, turnId) &&
      !this.db.prepare('SELECT 1 FROM visible_player WHERE session_id=? AND seen_at>? LIMIT 1')
        .get(sessionId, Date.now() - 6500)
  }
  picksDismissed(sessionId, turnId) {
    return !!this.db.prepare('SELECT 1 FROM waiting_dismissal WHERE session_id=? AND turn_id=?').get(sessionId, turnId)
  }
  dismissPicks(sessionId, turnId) {
    this.db.prepare('INSERT OR IGNORE INTO waiting_dismissal VALUES(?,?)').run(sessionId, turnId)
    return { dismissed: true }
  }
  transaction(work) {
    this.db.exec('BEGIN IMMEDIATE')
    try {
      const result = work()
      this.db.exec('COMMIT')
      return result
    } catch (error) {
      this.db.exec('ROLLBACK')
      throw error
    }
  }
  claimCard(sessionId, turnId) {
    return this.transaction(() => this.offerable(sessionId, turnId) &&
      this.db.prepare('INSERT OR IGNORE INTO waiting_card VALUES(?,?)').run(sessionId, turnId).changes === 1)
  }
  playerVisible(sessionId, instance, visible) {
    if (!sessionId) return
    const now = Date.now()
    if (visible) {
      this.db.prepare('DELETE FROM visible_player WHERE seen_at<=?').run(now - 6500)
      this.db.prepare('INSERT OR REPLACE INTO visible_player VALUES(?,?,?)').run(sessionId, instance, now)
    } else this.db.prepare('DELETE FROM visible_player WHERE session_id=? AND instance=?').run(sessionId, instance)
  }
  touchPlayer(sessionId, instance) {
    if (sessionId && instance) this.db.prepare(
      'UPDATE visible_player SET seen_at=? WHERE session_id=? AND instance=? AND seen_at<?',
    ).run(Date.now(), sessionId, instance, Date.now() - 1800)
  }
  waitingFeed(includeExpired = false, source = 'hongguo', context = '') {
    sourceId(source)
    // The legacy Hongguo table remains canonical while older processes are alive.
    const row = context ? this.db.prepare('SELECT items, updated_at FROM content_recommendation_feed WHERE source=? AND context=?').get(source, context) : source === 'hongguo'
      ? this.db.prepare('SELECT items, updated_at FROM recommendation_feed WHERE id=1').get()
      : this.db.prepare('SELECT items, updated_at FROM source_recommendation_feed WHERE source=?').get(source)
    if (row && !includeExpired && row.updated_at <= Date.now() - 15 * 60000) return []
    return row ? JSON.parse(row.items) : []
  }
  catalogCache(key) {
    const row = this.db.prepare('SELECT * FROM catalog_cache WHERE key=?').get(key)
    if (!row) return null
    let value
    try { if (row.value !== null) value = JSON.parse(row.value) } catch { /* Reload invalid metadata. */ }
    return { value, updatedAt: row.updated_at, retryAt: row.retry_at, failures: row.failures,
      owner: row.lease_owner, leaseUntil: row.lease_until }
  }
  claimCatalogCache(key, owner, now, ttl, lease) {
    return this.transaction(() => {
      this.db.prepare('INSERT OR IGNORE INTO catalog_cache(key,touched_at) VALUES(?,?)').run(key, now)
      const claimed = this.db.prepare(`UPDATE catalog_cache SET lease_owner=?,lease_until=?,touched_at=?
        WHERE key=? AND lease_until<=? AND retry_at<=?
        AND (value IS NULL OR json_valid(value)=0 OR updated_at<=? OR updated_at>?)`)
        .run(owner, now + lease, now, key, now, now, now - ttl, now).changes === 1
      if (claimed) this.pruneCatalogCache(key, now)
      return claimed
    })
  }
  renewCatalogCache(key, owner, now, lease) {
    return this.db.prepare('UPDATE catalog_cache SET lease_until=? WHERE key=? AND lease_owner=? AND lease_until>?')
      .run(now + lease, key, owner, now).changes === 1
  }
  completeCatalogCache(key, owner, value, now, feed = false) {
    return this.transaction(() => {
      const saved = this.db.prepare(`UPDATE catalog_cache SET value=?,updated_at=?,retry_at=0,failures=0,
        lease_owner=NULL,lease_until=0,touched_at=? WHERE key=? AND lease_owner=? AND lease_until>?`)
        .run(JSON.stringify(value), now, now, key, owner, now).changes === 1
      if (saved && feed) this.saveWaitingFeed(value.titles, now, typeof feed === 'object' ? feed.source : feed === true ? 'hongguo' : feed, typeof feed === 'object' ? feed.context : '')
      if (saved) this.pruneCatalogCache(key, now)
      return saved
    })
  }
  failCatalogCache(key, owner, now) {
    return this.transaction(() => {
      const row = this.db.prepare('SELECT failures FROM catalog_cache WHERE key=? AND lease_owner=? AND lease_until>?')
        .get(key, owner, now)
      if (!row) return false
      const failures = row.failures + 1
      const delay = Math.min(15 * 60000, 30000 * 2 ** Math.min(failures - 1, 5))
      this.db.prepare(`UPDATE catalog_cache SET failures=?,retry_at=?,lease_owner=NULL,lease_until=0,touched_at=? WHERE key=?`)
        .run(failures, now + delay, now, key)
      return true
    })
  }
  pruneCatalogCache(keep, now) {
    this.db.prepare(`DELETE FROM catalog_cache WHERE key IN (
      SELECT key FROM catalog_cache WHERE key<>? AND lease_until<=? ORDER BY touched_at DESC,key LIMIT -1 OFFSET 127)`)
      .run(keep, now)
  }
  saveWaitingFeed(rows, now = Date.now(), source = 'hongguo', context = '') {
    sourceId(source)
    const items = rankedTitles(rows).filter(row => belongsTo(row.id, source))
    if (items.length) {
      const json = JSON.stringify(items)
      if (context) this.db.prepare('INSERT OR REPLACE INTO content_recommendation_feed VALUES(?,?,?,?)').run(source, context, json, now)
      else this.db.prepare('INSERT OR REPLACE INTO source_recommendation_feed VALUES(?,?,?)').run(source, json, now)
      if (!context && source === 'hongguo') this.db.prepare('INSERT OR REPLACE INTO recommendation_feed VALUES(1,?,?)').run(json, now)
    }
    return items
  }
  recommendationSource(sessionId, turnId, preferred = this.preferences().defaultSource) {
    sourceId(preferred)
    this.db.prepare('INSERT OR IGNORE INTO recommendation_source VALUES(?,?,?)').run(sessionId, turnId, preferred)
    return this.db.prepare('SELECT source FROM recommendation_source WHERE session_id=? AND turn_id=?').get(sessionId, turnId).source
  }
  recommendationContext(sessionId, turnId, context = {}) {
    this.db.prepare('INSERT OR IGNORE INTO recommendation_context VALUES(?,?,?)').run(sessionId, turnId, JSON.stringify(context))
    return JSON.parse(this.db.prepare('SELECT context FROM recommendation_context WHERE session_id=? AND turn_id=?').get(sessionId, turnId).context)
  }
  turnPicks(sessionId, turnId) {
    const row = this.db.prepare('SELECT items FROM turn_picks WHERE session_id=? AND turn_id=?').get(sessionId, turnId)
    return row ? JSON.parse(row.items) : []
  }
  allocatePicks(sessionId, turnId, resume, feed, inView, eligible) {
    return this.transaction(() => {
      if (!eligible()) return []
      const pinned = this.turnPicks(sessionId, turnId)
      if (pinned.length) return pinned
      // Avoid duplicating titles while another visible window is still rendering them.
      // An abandoned render never advances exposure history.
      const reserved = new Set()
      const pending = this.db.prepare('SELECT session_id,turn_id,items FROM turn_picks WHERE shown=0 AND reserved_at>?')
      for (const row of pending.all(Date.now() - 15000)) {
        if (!this.activeTurn(row.session_id, row.turn_id)) continue
        for (const pick of JSON.parse(row.items)) if (!pick.episodeId) reserved.add(pick.id)
      }
      const fresh = this.db.prepare(`SELECT c.value->>'id' AS id, c.value->>'title' AS title, c.value->>'contentType' AS contentType, c.value->>'episodes' AS episodes
        FROM json_each(?) c LEFT JOIN pick_exposure e ON e.series_id=c.value->>'id'
        WHERE NOT EXISTS (SELECT 1 FROM watch_progress w WHERE w.series_id=c.value->>'id' AND
          (w.position_ms>0 OR (w.series_id,w.episode_id) IN (SELECT series_id,episode_id FROM watch_restart)))
        ORDER BY e.last_shown, c.key`).all(JSON.stringify(rankedTitles(feed))).map(({ id, title, contentType, episodes }) => ({ id, title, ...(contentType ? { contentType } : {}), ...(episodes ? { episodes } : {}) }))
      fresh.sort((a, b) => Number(reserved.has(a.id)) - Number(reserved.has(b.id)))
      const items = resume ? [resume, ...fresh.filter(item => item.id !== resume.id).slice(0, 2)] : fresh.slice(0, 3)
      if (items.length) this.db.prepare('INSERT INTO turn_picks(session_id,turn_id,items,reserved_at) VALUES(?,?,?,?)')
        .run(sessionId, turnId, JSON.stringify(items), inView ? Date.now() : null)
      return items
    })
  }
  markPicksShown(sessionId, turnId, eligible) {
    return this.transaction(() => {
      const row = eligible() && this.db.prepare(
        'UPDATE turn_picks SET shown=1 WHERE session_id=? AND turn_id=? AND shown=0 RETURNING items',
      ).get(sessionId, turnId)
      if (row) {
        const order = this.db.prepare('SELECT coalesce(max(last_shown),0)+1 AS n FROM pick_exposure').get().n
        const expose = this.db.prepare('INSERT OR REPLACE INTO pick_exposure(series_id,last_shown) VALUES(?,?)')
        for (const item of JSON.parse(row.items)) if (!item.episodeId) expose.run(item.id, order)
      }
      return { recorded: !!row }
    })
  }
  state(sessionId, turnId) {
    const row =
      sessionId &&
      (turnId
        ? this.db.prepare('SELECT * FROM turn_state WHERE session_id=? AND turn_id=?').get(sessionId, turnId)
        : this.db
            .prepare(
              'SELECT * FROM turn_state WHERE session_id=? ORDER BY (submitted_at IS NOT NULL) DESC,coalesce(submitted_at,observed_at) DESC,rowid DESC LIMIT 1',
            )
            .get(sessionId))
    if (!row) return { sessionId: null, turnId: null, state: 'unknown', revision: 0, observedAt: null }
    const state = row.interrupted ? 'interrupted' : row.stopped ? 'stopped' : 'submitted'
    return {
      sessionId: row.session_id,
      turnId: row.turn_id,
      state,
      revision: row.revision,
      observedAt: row.observed_at,
    }
  }
  candidates() {
    return this.db
      .prepare(
        'SELECT session_id, max(observed_at) AS at FROM turn_state GROUP BY session_id ORDER BY at DESC LIMIT 8',
      )
      .all()
  }
  save({ seriesId, episodeId, title, label, positionMs, durationMs, reset = false }) {
    if (positionMs <= 0 && !reset) return { saved: false }
    return this.transaction(() => {
      if (positionMs === 0) this.db.prepare('INSERT OR IGNORE INTO watch_restart VALUES(?,?)').run(seriesId, episodeId)
      else this.db.prepare('DELETE FROM watch_restart WHERE series_id=? AND episode_id=?').run(seriesId, episodeId)
      this.db
        .prepare(
          `INSERT INTO watch_progress VALUES(?,?,?,?,?,?,max(?,coalesce((SELECT max(updated_at)+1 FROM watch_progress),0))) ON CONFLICT(series_id,episode_id) DO UPDATE SET
        title=excluded.title,label=excluded.label,position_ms=excluded.position_ms,duration_ms=excluded.duration_ms,updated_at=excluded.updated_at`,
        )
        .run(seriesId, episodeId, title, label, Math.min(positionMs, durationMs), durationMs, Date.now())
      return { saved: true }
    })
  }
  history(seriesId, episodeId, limit = 30, source = 'hongguo') {
    sourceId(source)
    const seriesGlob = idGlob(source), episodeGlob = idGlob(source, 'episode')
    const fields =
      'series_id AS seriesId,episode_id AS episodeId,title,label,position_ms AS positionMs,duration_ms AS durationMs,updated_at AS updatedAt'
    const meaningful = '(position_ms>0 OR (series_id,episode_id) IN (SELECT series_id,episode_id FROM watch_restart))'
    if (seriesId && episodeId)
      return this.db
        .prepare('SELECT ' + fields + ' FROM watch_progress WHERE series_id=? AND episode_id=? AND ' + meaningful)
        .all(seriesId, episodeId)
    if (seriesId)
      return this.db
        .prepare(
          'SELECT ' +
            fields +
            ' FROM watch_progress WHERE series_id=? AND ' + meaningful + ' ORDER BY updated_at DESC,rowid DESC LIMIT 1',
        )
        .all(seriesId)
    return this.db
      .prepare(
        'SELECT ' +
          fields +
          ` FROM (SELECT *, row_number() OVER(PARTITION BY series_id ORDER BY updated_at DESC,rowid DESC) AS rank
            FROM watch_progress WHERE ${meaningful} AND series_id GLOB ? AND episode_id GLOB ?)
            WHERE rank=1 ORDER BY updated_at DESC LIMIT ?`,
      )
      .all(seriesGlob, episodeGlob, limit)
  }
  removeHistory(seriesId) {
    return this.transaction(() => {
      this.db.prepare('DELETE FROM watch_progress WHERE series_id=?').run(seriesId)
      this.db.prepare('DELETE FROM watch_restart WHERE series_id=?').run(seriesId)
      return { removed: true }
    })
  }
  writable() {
    if (!this.persistent) return false
    try {
      this.db.exec('UPDATE watch_progress SET updated_at=updated_at WHERE 0')
      return true
    } catch {
      return false
    }
  }
  close() {
    this.db.close()
  }
}
