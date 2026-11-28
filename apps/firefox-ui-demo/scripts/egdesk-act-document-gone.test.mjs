import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { actCanLeaveDocument, raceActWithDocumentGone } from '../overlay/resources/EGDeskActDocumentGone.sys.mjs'

const never = new Promise(() => {})
const fast = { graceMs: 30, pollMs: 5 }

test('L52: a silent actor after the document went away is rejected promptly as unknown (not dispatched, not a timeout)', async () => {
  let replaced = false
  setTimeout(() => { replaced = true }, 20)
  const t0 = Date.now()
  await assert.rejects(raceActWithDocumentGone(never, { isReplaced: () => replaced, ...fast }), error => {
    assert.equal(error.name, 'DocumentGone'); assert.equal(error.browserToolActor.dispatchPhase, 'unknown'); return true })
  assert.ok(Date.now() - t0 < 1000)
})
test('L52: the actor reply wins when it arrives, also inside the grace after the document changed', async () => {
  const reply = new Promise(resolve => setTimeout(() => resolve({ ok: true }), 15))
  assert.deepEqual(await raceActWithDocumentGone(reply, { isReplaced: () => true, graceMs: 200, pollMs: 5 }), { ok: true })
})
test('L52: an actor error passes through unchanged; a page that stays the same never triggers it', async () => {
  const boom = Object.assign(new Error('x'), { name: 'AbortError' })
  await assert.rejects(raceActWithDocumentGone(Promise.reject(boom), { isReplaced: () => false, ...fast }), error => error === boom)
  const slow = new Promise(resolve => setTimeout(() => resolve('late'), 80))
  assert.equal(await raceActWithDocumentGone(slow, { isReplaced: () => false, ...fast }), 'late')
})
test('L52: a failing document probe counts as gone, and only input actions are watched', async () => {
  await assert.rejects(raceActWithDocumentGone(never, { isReplaced: () => { throw new Error('dead') }, ...fast }), error => error.name === 'DocumentGone')
  for (const type of ['click', 'pointer-click', 'press']) assert.equal(actCanLeaveDocument({ type }), true)
  for (const type of ['navigate', 'scroll', 'type-text', undefined]) assert.equal(actCanLeaveDocument({ type }), false)
})
for (const type of ['click', 'press']) test('L52: same-document ' + type + ' (radio, checkbox, button, Enter) with no navigation: the actor result is delivered even when it is slower than the grace', async () => {
  const slow = new Promise(resolve => setTimeout(() => resolve({ ok: true, type }), 120)) // 4x the 30 ms grace, document never replaced
  assert.equal(actCanLeaveDocument({ type }), true)
  assert.deepEqual(await raceActWithDocumentGone(slow, { isReplaced: () => false, graceMs: 30, pollMs: 5 }), { ok: true, type })
})
test('L52: a transient replaced reading that reverts inside the grace never rejects (the window restarts from the first reading only while replaced)', async () => {
  let flips = 0
  const reply = new Promise(resolve => setTimeout(() => resolve('ok'), 60))
  assert.equal(await raceActWithDocumentGone(reply, { isReplaced: () => (flips++ < 3), graceMs: 200, pollMs: 5 }), 'ok')
})
test('L52: after the real navigation the rejection still comes promptly', async () => {
  let replaced = false; setTimeout(() => { replaced = true }, 15)
  await assert.rejects(raceActWithDocumentGone(never, { isReplaced: () => replaced, graceMs: 40, pollMs: 5 }), error => error.name === 'DocumentGone')
})
test('L52: the surface resolves the race module before sending the act, a load failure only turns the race off, and the act is sent in every case (wiring)', () => {
  const src = readFileSync(new URL('../overlay/JS/eg-desk-surface.uc.js', import.meta.url), 'utf8')
  assert.match(src, /EGDeskActDocumentGone\.sys\.mjs/)
  const load = src.indexOf('gone = typeof actDocumentGoneModule'), send = src.indexOf("const actRequest = browserAgentActorRequest('act'")
  assert.ok(load > 0 && send > load, 'module resolved before the act request is sent')
  assert.match(src, /try \{ gone = typeof actDocumentGoneModule === 'function'[^\n]*catch \{ gone = null; \}/)
  assert.match(src, /result = watched\s*\n\s*\? await gone\.raceActWithDocumentGone\(actRequest[\s\S]{0,260}: await actRequest;/)
})
