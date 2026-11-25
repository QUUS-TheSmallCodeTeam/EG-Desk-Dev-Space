import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { GUIDANCE_FILE, GUIDANCE_LIMITS, USER_GUIDANCE_PATH, createUserGuidanceHttpHandler, createUserGuidanceStore } from './egdesk-user-guidance.mjs'

const tmp = t => { const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'egdesk-guidance-')); t.after(() => fs.rmSync(dir, { recursive: true, force: true })); return dir }
const korean = { guidance: 'language', value: 'korean', kind: 'correction', strength: 'clear', sourceRef: 'chat-message:msg-aaa', thread: 'thread-1' }

test('a candidate: closed words, the source by reference and time, never the person\'s words; the same guidance again adds its source and counts it', t => {
  let clock = Date.parse('2026-11-26T01:30:00Z')
  const store = createUserGuidanceStore({ dataDir: tmp(t), now: () => clock })
  const a = store.propose(korean)
  assert.deepEqual(a, { id: a.id, guidance: 'language', value: 'korean', kind: 'correction', strength: 'clear', status: 'candidate', seen: 1, sources: [{ ref: 'chat-message:msg-aaa', thread: 'thread-1', at: '2026-11-26T01:30:00.000Z' }], createdAt: '2026-11-26T01:30:00.000Z', history: [{ status: 'candidate', at: '2026-11-26T01:30:00.000Z', by: 'decision_model' }] })
  assert.match(a.id, /^ug-[0-9a-f]{12}$/)
  clock += 60_000
  const b = store.propose({ ...korean, sourceRef: 'chat-message:msg-bbb', thread: 'thread-2', strength: 'strong' })
  assert.deepEqual([b.id, b.seen, b.strength, b.sources.length], [a.id, 2, 'strong', 2]); assert.equal(store.size(), 1)
  assert.equal(store.propose({ ...korean, sourceRef: 'chat-message:msg-bbb' }).seen, 2, 'the same source twice counts once')
  for (let i = 0; i < 8; i++) store.propose({ ...korean, sourceRef: `chat-message:m${i}` })
  assert.equal(store.list()[0].sources.length, GUIDANCE_LIMITS.sources, 'at most five sources')
  const raw = JSON.stringify(store.list()); assert.ok(!/야 한글|한국어/.test(raw))
})

test('only closed words are accepted: an unknown guidance or value, a mild reading, a source that is not a message reference, free text', t => {
  const store = createUserGuidanceStore({ dataDir: tmp(t) })
  for (const bad of [{ ...korean, guidance: 'tone' }, { ...korean, value: 'klingon' }, { ...korean, strength: 'mild' }, { ...korean, sourceRef: '야 한글로 보고해' }, { ...korean, sourceRef: 'file:/etc/passwd' }, { ...korean, thread: '' }, { ...korean, guidance: 'length', value: 'korean' }, { ...korean, guidance: 'format', value: 'korean' }, {}, undefined]) assert.equal(store.propose(bad), null, JSON.stringify(bad))
  assert.equal(store.size(), 0); assert.ok(store.propose({ ...korean, guidance: 'length', value: 'less' })); assert.ok(store.propose({ ...korean, guidance: 'format', value: null })); assert.ok(store.propose({ ...korean, guidance: 'repeated_question', value: null }))
})

test('status: a candidate is applied or dismissed by the person, an applied one can be reverted (and applied again), nothing else; only applied guidance reaches the engine', t => {
  const store = createUserGuidanceStore({ dataDir: tmp(t) }), { id } = store.propose(korean)
  assert.deepEqual(store.appliedLines(), [], 'a candidate is never applied by itself')
  assert.deepEqual(store.setStatus(id, 'reverted'), { ok: false, reason: 'transition_refused' }); assert.deepEqual(store.setStatus('ug-000000000000', 'applied'), { ok: false, reason: 'not_found' }); assert.deepEqual(store.setStatus('x', 'applied'), { ok: false, reason: 'invalid' })
  assert.equal(store.setStatus(id, 'applied').entry.status, 'applied'); assert.deepEqual(store.appliedLines(), ['Reply in Korean in every conversation, as the person asked.'])
  assert.equal(store.setStatus(id, 'reverted').entry.status, 'reverted'); assert.deepEqual(store.appliedLines(), [], 'reverted: gone from the engine\'s entry, kept in the record')
  assert.deepEqual(store.get(id).history.map(h => [h.status, h.by]), [['candidate', 'decision_model'], ['applied', 'user'], ['reverted', 'user']])
  assert.equal(store.setStatus(id, 'applied').ok, true); assert.equal(store.setStatus(id, 'reverted', 'whoever').entry.history.at(-1).by, 'host', 'only "user" counts as the person')
  const other = store.propose({ ...korean, guidance: 'length', value: 'less' }); assert.equal(store.setStatus(other.id, 'dismissed').entry.status, 'dismissed'); assert.equal(store.setStatus(other.id, 'candidate').entry.status, 'candidate')
})

test('the file: private (0600), atomic, reloaded by a new store, a broken file starts empty and never crashes, bounded', t => {
  const dir = tmp(t), a = createUserGuidanceStore({ dataDir: dir }), { id } = a.propose(korean); a.setStatus(id, 'applied')
  const file = path.join(dir, GUIDANCE_FILE); assert.equal(fs.statSync(file).mode & 0o777, 0o600); assert.deepEqual(fs.readdirSync(dir), [GUIDANCE_FILE], 'no temp file left')
  assert.equal(createUserGuidanceStore({ dataDir: dir }).get(id).status, 'applied')
  fs.writeFileSync(file, '{ not json'); const logs = []; const broken = createUserGuidanceStore({ dataDir: dir, log: l => logs.push(l) }); assert.equal(broken.size(), 0); assert.equal(logs.length, 1)
  assert.ok(broken.propose(korean)); fs.writeFileSync(file, JSON.stringify({ version: 1, entries: [{ id: 'ug-123456789abc', guidance: 'bogus', status: 'applied', sources: [], history: [] }] })); assert.equal(createUserGuidanceStore({ dataDir: dir }).size(), 0, 'entries outside the closed words are dropped')
  const many = createUserGuidanceStore({ dataDir: tmp(t) }); for (const guidance of ['language', 'length']) for (const value of guidance === 'language' ? ['korean', 'english', 'japanese', 'chinese'] : ['less', 'more']) many.propose({ ...korean, guidance, value })
  assert.ok(many.size() <= GUIDANCE_LIMITS.entries)
  assert.throws(() => createUserGuidanceStore({}), /data directory/)
})

test('the route: off (404) unless enabled, loopback only, GET lists the record, POST applies / reverts / dismisses / restores by id; wrong ids, actions and methods are refused', async t => {
  const store = createUserGuidanceStore({ dataDir: tmp(t) }), { id } = store.propose(korean)
  let on = false, loopback = true
  const handler = createUserGuidanceHttpHandler({ store, enabled: () => on, guard: () => loopback, send: (res, code, body) => { res.code = code; res.body = body } })
  const call = async (method, pathname) => { const res = { destroyed: false, writableEnded: false, setHeader() {} }; const handled = await handler({ method }, res, new URL(`http://x${pathname}`)); return { handled, code: res.code, body: res.body } }
  assert.deepEqual(await call('GET', '/v1/state'), { handled: false, code: undefined, body: undefined })
  assert.equal((await call('GET', USER_GUIDANCE_PATH)).code, 404); on = true; loopback = false; assert.equal((await call('GET', USER_GUIDANCE_PATH)).code, 403); loopback = true
  const list = await call('GET', USER_GUIDANCE_PATH); assert.deepEqual([list.code, list.body.entries.length, list.body.entries[0].status], [200, 1, 'candidate'])
  assert.equal((await call('POST', USER_GUIDANCE_PATH)).code, 405); assert.equal((await call('GET', `${USER_GUIDANCE_PATH}/${id}/apply`)).code, 405)
  const applied = await call('POST', `${USER_GUIDANCE_PATH}/${id}/apply`); assert.deepEqual([applied.code, applied.body.entry.status], [200, 'applied']); assert.equal(store.appliedLines().length, 1)
  assert.equal((await call('POST', `${USER_GUIDANCE_PATH}/${id}/apply`)).code, 409, 'applied twice is refused'); assert.equal((await call('POST', `${USER_GUIDANCE_PATH}/${id}/revert`)).body.entry.status, 'reverted'); assert.equal(store.appliedLines().length, 0)
  assert.equal((await call('POST', `${USER_GUIDANCE_PATH}/ug-000000000000/apply`)).code, 404); for (const bad of [`${USER_GUIDANCE_PATH}/${id}/delete`, `${USER_GUIDANCE_PATH}/bogus/apply`, `${USER_GUIDANCE_PATH}/${id}`, `${USER_GUIDANCE_PATH}/${id}/apply/extra`]) assert.equal((await call('POST', bad)).code, 400, bad)
  assert.throws(() => createUserGuidanceHttpHandler({}), /store/)
})
