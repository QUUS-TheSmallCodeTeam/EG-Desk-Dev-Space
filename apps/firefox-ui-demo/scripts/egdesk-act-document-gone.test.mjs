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
test('L52: the surface races the act request only for input actions and never presses again (wiring)', () => {
  const src = readFileSync(new URL('../overlay/JS/eg-desk-surface.uc.js', import.meta.url), 'utf8')
  assert.match(src, /EGDeskActDocumentGone\.sys\.mjs/); assert.match(src, /gone\?\.actCanLeaveDocument\(action\)\s*\n?\s*\? await gone\.raceActWithDocumentGone\(actRequest/)
})
