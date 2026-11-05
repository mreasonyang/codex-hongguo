import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Store } from '../src/server/store.mjs'
import { Service } from '../src/server/service.mjs'
import { Catalog } from '../src/server/catalog.mjs'

function fixture(t, recommendations = async () => []) {
  const dir = mkdtempSync(join(tmpdir(), 'hongguo-waiting-'))
  const store = new Store(dir), peer = new Store(dir)
  const service = new Service(store, { waitingRecommendations: recommendations })
  t.after(() => { store.close(); peer.close(); rmSync(dir, { recursive: true, force: true }) })
  const event = (session_id, turn_id, hook_event_name = 'UserPromptSubmit') =>
    peer.event({ session_id, turn_id, hook_event_name })
  const open = (threadId, turnId) => service.openWaiting({ threadId }, turnId)
  const call = (opened, name, args = {}) => service.call(service.panel(opened.panel), name, args)
  return { store, peer, service, event, open, call }
}

test('eligible hooks produce at most one card across server processes and only for the owning live turn', t => {
  const { store, peer, service, open, event } = fixture(t)
  event('A', 'a1'); event('B', 'b1')
  assert.equal(open('B', 'a1'), null)
  assert.equal(service.openWaiting({}, 'a1'), null)
  assert.equal(service.openWaiting({ threadId: 'A', turn_id: 'b1' }, 'a1'), null)
  assert.ok(open('A', 'a1'))
  assert.equal(new Service(peer, {}).openWaiting({ thread_id: 'A' }, 'a1'), null)
  event('A', 'a2'); event('A', 'a3')
  assert.equal(open('A', 'a2'), null)
  event('A', 'a3', 'Interrupt')
  assert.equal(open('A', 'a3'), null)
  store.setPreferences({ ...store.preferences(), autoPrompt: false })
  assert.equal(open('B', 'b1'), null)
  store.setPreferences({ ...store.preferences(), autoPrompt: true })
  assert.ok(open('B', 'b1'))
})

test('only a visible player suppresses its own chat, including multiple windows and expired leases', async t => {
  const { store, peer, service, call, event, open } = fixture(t)
  event('A', 'one'); event('B', 'two')
  const ordinary = service.open({ threadId: 'A' })
  assert.equal(peer.offerable('A', 'one'), true)
  for (const instance of ['x','y']) await call(ordinary, 'set_player_visible', { instance, visible: true })
  assert.equal(peer.offerable('A', 'one'), false)
  assert.equal(peer.offerable('B', 'two'), true)
  await call(ordinary, 'set_player_visible', { instance: 'x', visible: false })
  assert.equal(open('A', 'one'), null)
  store.db.prepare('UPDATE visible_player SET seen_at=0').run()
  await call(ordinary, 'get_run_state', { playerInstance: 'y' })
  assert.equal(peer.offerable('A', 'one'), false)
  store.db.prepare('UPDATE visible_player SET seen_at=0').run()
  assert.ok(open('A', 'one'))
})

test('claim never waits for the catalog, resume and recommendations deduplicate, one click survives a remount', async t => {
  let reads = 0, feed
  const { store, service, call, open, event } = fixture(t, () => {
    reads++
    return new Promise(resolve => { feed = resolve })
  })
  store.save({ seriesId: 'hg-1', episodeId: 'hg-11', title: '剧一', label: '第一集', positionMs: 6000, durationMs: 16000 })
  event('A', 'a'); event('B', 'b')
  const card = open('A', 'a')
  assert.ok(card)
  await assert.rejects(call(card, 'get_run_state', { observeSession: true }))
  assert.equal(reads, 0)
  const loading = call(card, 'get_waiting_picks')
  assert.equal(reads, 1)
  feed([1, 2, 2, 3, 4].map(n => ({ id: 'hg-' + n, title: '剧' + n })))
  const { items } = await loading
  assert.deepEqual(items.map(item => item.id), ['hg-1','hg-2','hg-3'])
  assert.equal(items[0].episodeId, 'hg-11')
  await assert.rejects(call(card, 'select_waiting_pick', { seriesId: 'hg-4' }))
  assert.equal((await call(card, 'activate_waiting_player')).play, false)
  assert.equal((await call(card, 'get_run_state', { observeSession: true })).turnId, 'a')
  await call(card, 'select_waiting_pick', { seriesId: 'hg-2' })
  const selected = await call(card, 'activate_waiting_player')
  assert.deepEqual(selected, { pick: items[1], turnId: 'a', play: true, playbackId: 1 })
  await call(card, 'set_player_visible', { instance: 'first-mount', visible: true })
  assert.deepEqual(await call(card, 'activate_waiting_player'), selected)
  await call(card, 'confirm_waiting_playback', { playbackId: selected.playbackId })
  assert.equal((await call(card, 'activate_waiting_player')).play, false)
  assert.throws(() => service.panel(card.panel, { threadId: 'B' }))
  event('B', 'b', 'Stop')
  assert.equal((await call(card, 'get_run_state')).state, 'submitted')
  event('A', 'a', 'Interrupt')
  event('A', 'next')
  assert.equal((await call(card, 'get_run_state')).state, 'interrupted')
  assert.equal((await call(card, 'get_run_state', { observeSession: true })).turnId, 'next')
  await assert.rejects(call(card, 'get_run_state', { turnId: 'next' }))
  await assert.rejects(call(card, 'select_waiting_pick', { seriesId: 'hg-2' }))
  assert.deepEqual(await call(card, 'get_waiting_picks'), { items: [] })
})

test('a late catalog response or a stop between the click and mounting never starts playback', async t => {
  let feed
  const { call, open, event } = fixture(t, () => new Promise(resolve => { feed = resolve }))
  event('A', 'a'); event('B', 'b')
  const a = open('A', 'a'), b = open('B', 'b')
  const late = call(a, 'get_waiting_picks')
  event('A', 'a', 'Interrupt')
  feed([{ id: 'hg-1', title: '剧一' }])
  assert.deepEqual(await late, { items: [] })
  const current = call(b, 'get_waiting_picks')
  feed([{ id: 'hg-2', title: '剧二' }])
  await current
  await call(b, 'select_waiting_pick', { seriesId: 'hg-2' })
  event('B', 'b', 'Stop')
  assert.equal((await call(b, 'activate_waiting_player')).play, false)
})

const shows = (...numbers) => numbers.map(n => ({ id: 'hg-' + n, title: '剧' + n }))
const ids = rows => rows.map(item => item.id)

test('a delayed playback confirmation cannot consume a newer recommendation click', async t => {
  const { event, open, call } = fixture(t, async () => shows(1,2,3))
  event('A', 'one')
  const card = open('A', 'one')
  await call(card, 'get_waiting_picks')
  await call(card, 'select_waiting_pick', { seriesId: 'hg-1' })
  const first = await call(card, 'activate_waiting_player')
  await call(card, 'select_waiting_pick', { seriesId: 'hg-2' })
  await call(card, 'confirm_waiting_playback', { playbackId: first.playbackId })
  const second = await call(card, 'activate_waiting_player')
  assert.equal(second.play, true)
  assert.equal(second.pick.id, 'hg-2')
  assert.notEqual(second.playbackId, first.playbackId)
})

test('dismissal survives a remount and only hides the owning turn; More opens a catalog without playback', async t => {
  const { store, peer, service, event, open, call } = fixture(t, async () => shows(1,2,3))
  event('A', 'one'); event('B', 'other')
  const a = open('A', 'one'), b = open('B', 'other')
  assert.equal((await call(a, 'get_waiting_status')).visible, true)
  await call(a, 'get_waiting_picks')
  await call(a, 'select_waiting_pick', { seriesId: 'hg-1' })
  await call(a, 'browse_waiting_catalog')
  assert.deepEqual(await call(a, 'activate_waiting_player'), { pick: null, turnId: 'one', play: false })
  assert.equal((await call(a, 'get_run_state', { observeSession: true })).turnId, 'one')
  assert.equal(peer.picksDismissed('A', 'one'), true)
  assert.equal((await call(a, 'get_waiting_status')).visible, false)
  assert.deepEqual(await call(a, 'get_waiting_picks'), { items: [] })
  assert.equal((await call(b, 'get_waiting_status')).visible, true)
  await call(b, 'dismiss_waiting_picks')
  assert.equal(peer.offerable('B', 'other'), false)
  event('A', 'two')
  assert.equal((await call(open('A', 'two'), 'get_waiting_status')).visible, true)
  event('A', 'two', 'Stop')
  assert.equal((await call(a, 'get_waiting_status')).visible, false)
  await assert.rejects(service.call(service.panel(service.open({ threadId: 'A' }).panel), 'browse_waiting_catalog', {}))
  assert.equal(store.picksDismissed('A', 'two'), false)
})

test('an explicit zero remains the latest episode across processes, while incidental zero is ignored', async t => {
  const { store, peer, service, event, open, call } = fixture(t, async () => shows(1,2,3))
  const ordinary = service.open({ threadId: 'A' })
  const progress = { seriesId: 'hg-1', episodeId: 'hg-11', title: '剧1', label: '第一集', positionMs: 45000, durationMs: 120000 }
  await call(ordinary, 'save_progress', progress)
  await call(ordinary, 'save_progress', { ...progress, episodeId: 'hg-12', label: '第二集', positionMs: 2000 })
  await call(ordinary, 'save_progress', { ...progress, positionMs: 0, reset: true })
  for (const rows of [peer.history(), peer.history('hg-1'), peer.history('hg-1', 'hg-11')]) {
    assert.equal(rows[0].episodeId, 'hg-11')
    assert.equal(rows[0].positionMs, 0)
  }
  assert.deepEqual(await call(ordinary, 'save_progress', { ...progress, episodeId: 'hg-12', positionMs: 0 }), { saved: false })
  assert.equal(peer.history('hg-1')[0].episodeId, 'hg-11')
  event('A', 'one')
  const picks = (await call(open('A', 'one'), 'get_waiting_picks')).items
  assert.equal(picks[0].kind, 'resume')
  assert.equal(picks.filter(p => p.id === 'hg-1').length, 1)
  await call(ordinary, 'save_progress', { ...progress, positionMs: 1000 })
  assert.equal(store.db.prepare('SELECT count(*) AS n FROM watch_restart').get().n, 0)
  await call(ordinary, 'save_progress', { ...progress, positionMs: 0, reset: true })
  await call(ordinary, 'remove_history', { seriesId: 'hg-1' })
  assert.deepEqual(peer.history(), [])
  assert.equal(store.db.prepare('SELECT count(*) AS n FROM watch_restart').get().n, 0)
})

test('cold cards share multi-page discovery and cache ranked public titles across processes including titles without covers', async t => {
  const { store, peer } = fixture(t)
  const catalog = new Catalog(store), next = new Catalog(peer)
  const requests = []
  const secondPage = Promise.withResolvers()
  t.mock.method(catalog, 'sdkCall', async (method, { cursor }) => {
    assert.equal(method, 'discover')
    requests.push(cursor)
    if (cursor) await secondPage.promise
    const start = cursor ? 15 : 1
    return {
      items: Array.from({ length: 15 }, (_, i) => ({ id: String(start + i), title: '剧' + (start + i),
        description: 'extra provider data', cover_url: i ? '/cover' : undefined })),
      has_more: !cursor, cursor: 'second',
    }
  })
  t.mock.method(next, 'sdkCall', () => assert.fail('the warm card should not contact the provider'))
  const expected = shows(...Array.from({ length: 29 }, (_, i) => i + 1))
  const loading = Promise.all([catalog.waitingRecommendations(), catalog.waitingRecommendations()])
  const preview = await catalog.list({ preview: true })
  assert.deepEqual(ids(preview.items), ids(expected.slice(0, 15)))
  secondPage.resolve()
  const [cold, simultaneous] = await loading
  assert.deepEqual(requests, [undefined, 'second'])
  assert.deepEqual(cold, expected)
  assert.deepEqual(simultaneous, expected)
  assert.deepEqual(await next.waitingRecommendations(), expected)
  store.db.exec('UPDATE recommendation_feed SET updated_at=0')
  assert.deepEqual(peer.waitingFeed(), [])
  assert.deepEqual((await next.list({ preview: true })).items, expected)
})

test('only first display advances rotation, shared across chats and pinned across remounts and feed changes', async t => {
  let pool = shows(1,2,3,4,5,6,7)
  const { store, peer, service, event, open, call } = fixture(t, async () => pool)
  const other = new Service(peer, { waitingRecommendations: async () => pool })
  const get = async opened => (await call(opened, 'get_waiting_picks')).items
  const shown = opened => call(opened, 'mark_waiting_picks_shown')
  event('preview', 'p')
  const preview = open('preview', 'p')
  assert.deepEqual(await get(preview), pool.slice(0,3))
  event('preview', 'p', 'Stop')
  assert.deepEqual(await shown(preview), { recorded: false })
  event('A', 'one')
  const a = open('A', 'one')
  const first = await get(a)
  assert.deepEqual(first, pool.slice(0,3))
  const view = other.panel(other.open({ threadId: 'A' }).panel)
  assert.deepEqual((await other.call(view, 'get_waiting_picks', { turnId: 'one' })).items, first)
  assert.deepEqual(await other.call(view, 'mark_waiting_picks_shown', { turnId: 'one' }), { recorded: true })
  assert.deepEqual(await shown(a), { recorded: false })
  event('B', 'two')
  const b = open('B', 'two')
  assert.deepEqual(await get(b), shows(4,5,6))
  assert.deepEqual(await shown(b), { recorded: true })
  pool = shows(3,2,1,6,5,4,7)
  assert.deepEqual(await get(a), first)
  event('A', 'three')
  const c = open('A', 'three')
  assert.deepEqual(await get(c), shows(7,3,2))
  assert.deepEqual(await shown(c), { recorded: true })
  event('A', 'four')
  assert.deepEqual(await get(open('A', 'four')), shows(1,6,5))
  assert.deepEqual(await other.call(view, 'get_waiting_picks', { turnId: 'two' }), { items: [] })
  assert.deepEqual(await other.call(view, 'mark_waiting_picks_shown', { turnId: 'three' }), { recorded: false })
  assert.equal(store.db.prepare('SELECT count(*) AS n FROM pick_exposure').get().n, 7)
  await assert.rejects(service.call({ sessionId: 'A', fixedTurn: 'four' }, 'get_waiting_picks', { turnId: 'two' }, true))
})

test('simultaneously visible cards reserve different choices and abandoned reservations never count as exposures', async t => {
  const pool = shows(1,2,3,4,5,6,7,8,9)
  const { store, peer, event, open, call } = fixture(t, async () => pool)
  event('A', 'one'); event('B', 'two')
  const a = open('A', 'one')
  const other = new Service(peer, { waitingRecommendations: async () => pool })
  const b = other.panel(other.openWaiting({ threadId: 'B' }, 'two').panel)
  const [first, second] = await Promise.all([
    call(a, 'get_waiting_picks', { inView: true }), other.call(b, 'get_waiting_picks', { inView: true }),
  ])
  assert.equal(new Set(ids(first.items).concat(ids(second.items))).size, 6)
  assert.deepEqual(await other.call(b, 'mark_waiting_picks_shown', {}), { recorded: true })
  store.db.exec('UPDATE turn_picks SET reserved_at=0 WHERE shown=0')
  event('C', 'three')
  assert.deepEqual((await call(open('C', 'three'), 'get_waiting_picks')).items, first.items)
  assert.equal(store.db.prepare('SELECT count(*) AS n FROM pick_exposure').get().n, 3)
})

test('zero never overwrites real progress, later legacy zero rows do not hide it, and all watched shows are excluded', async t => {
  const { store, event, open, call } = fixture(t, async () => shows(1,2,36,37,38,39,40))
  const save = (n, positionMs) => store.save({ seriesId: 'hg-' + n, episodeId: 'hg-' + (n + 100), title: '剧' + n,
    label: '第一集', positionMs, durationMs: 16000 })
  for (let n = 1; n <= 36; n++) save(n, 1000)
  save(36, 14900)
  assert.deepEqual(save(36, 0), { saved: false })
  store.db.exec(`INSERT INTO watch_progress VALUES('hg-36','hg-200','剧36','第二集',0,16000,9999999999998),
    ('hg-37','hg-237','剧37','第一集',0,16000,9999999999999)`)
  assert.equal(store.history('hg-36')[0].positionMs, 14900)
  assert.deepEqual(store.history('hg-37'), [])
  event('A', 'a')
  const a = open('A', 'a')
  const first = (await call(a, 'get_waiting_picks')).items
  assert.deepEqual(first, [{ ...shows(36)[0], episodeId: 'hg-136', kind: 'resume' }, ...shows(37,38)])
  await call(a, 'mark_waiting_picks_shown')
  event('B', 'b')
  assert.deepEqual((await call(open('B', 'b'), 'get_waiting_picks')).items, [first[0], ...shows(39,40)])
  assert.deepEqual(ids(store.db.prepare('SELECT series_id AS id FROM pick_exposure ORDER BY series_id').all()), ids(shows(37,38)))
})

test('completed series are skipped; the next playable episode follows real paginated order and opens exactly once', async t => {
  const pool = shows(8,9,10,11,12)
  const { store, service, event, open, call } = fixture(t)
  const catalog = service.catalog = new Catalog(store)
  catalog.ffmpeg = true
  t.mock.method(catalog, 'waitingRecommendations', async () => pool)
  const reads = []
  t.mock.method(catalog, 'sdkCall', async (method, id, { cursor }) => {
    assert.equal(method, 'listEpisodes')
    reads.push([id, cursor])
    if (id === '9') return { items: [{ id: '84', number: 1 }] }
    assert.equal(id, '8')
    return cursor ? { items: [{ id: '61' }, { id: '91', playable: false }, { id: '4' }, { id: '503' }] }
      : { items: [{ id: '61' }], has_more: true, cursor: 'more' }
  })
  const save = (show, ep, positionMs) => store.save({ seriesId: 'hg-' + show, episodeId: 'hg-' + ep,
    title: '剧' + show, label: '分集', positionMs, durationMs: 10000 })
  save(8, 4, 10000); save(8, 61, 10000); save(9, 84, 10000)
  event('A', 'a')
  const a = open('A', 'a')
  const first = (await call(a, 'get_waiting_picks')).items
  assert.deepEqual(first, [{ ...shows(8)[0], episodeId: 'hg-503', kind: 'next' }, ...shows(10,11)])
  assert.deepEqual(reads, [['9',undefined], ['8',undefined], ['8','more']])
  await call(a, 'select_waiting_pick', { seriesId: 'hg-8' })
  const selected = await call(a, 'activate_waiting_player')
  assert.deepEqual(selected.pick, first[0])
  await call(a, 'confirm_waiting_playback', { playbackId: selected.playbackId })
  assert.equal((await call(a, 'activate_waiting_player')).play, false)
  save(8, 503, 10000)
  event('B', 'b')
  assert.deepEqual((await call(open('B', 'b'), 'get_waiting_picks')).items, shows(12,10,11))
  assert.equal(reads.length, 3)
})

test('sparse feeds only return eligible real titles and an empty result can be retried', async t => {
  let pool = []
  const { event, open, call } = fixture(t, async () => pool)
  event('A', 'a')
  const a = open('A', 'a')
  assert.deepEqual((await call(a, 'get_waiting_picks')).items, [])
  assert.deepEqual(await call(a, 'mark_waiting_picks_shown'), { recorded: false })
  pool = [...shows(1,1), { id: 'fixture', title: '假的' }, { id: 'hg-2', title: ' ' }]
  assert.deepEqual((await call(a, 'get_waiting_picks')).items, shows(1))
})

test('one unavailable episode list cannot hide another show with a real next episode', async t => {
  const { store, service, event, open, call } = fixture(t, async () => shows(10,11))
  for (const n of [1,2]) store.save({ seriesId: 'hg-' + n, episodeId: 'hg-' + (n + 10),
    title: '剧' + n, label: '第一集', positionMs: 10000, durationMs: 10000 })
  service.catalog.nextEpisode = async seriesId => {
    if (seriesId === 'hg-2') throw Error('provider removed this show')
    return { episodeId: 'hg-15', kind: 'next' }
  }
  event('A', 'a')
  assert.deepEqual((await call(open('A', 'a'), 'get_waiting_picks')).items,
    [{ ...shows(1)[0], episodeId: 'hg-15', kind: 'next' }, ...shows(10,11)])
})
