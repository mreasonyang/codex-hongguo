export const playerLink = '[红果短剧](sidecar://codex-hongguo/player/)'

export function recordSidecarReady(store) {
  store.db.prepare(`INSERT INTO antigravity_player_ready VALUES (1, ?)
    ON CONFLICT(id) DO UPDATE SET seen_at=excluded.seen_at`).run(Date.now())
}

export function sidecarReady(store) {
  const row = store.db.prepare('SELECT seen_at FROM antigravity_player_ready WHERE id=1').get()
  return !!row && row.seen_at > Date.now() - 25000 && row.seen_at <= Date.now()
}
