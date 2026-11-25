import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { runInNewContext } from 'node:vm'

const surface = readFileSync(new URL('../overlay/JS/eg-desk-surface.uc.js', import.meta.url), 'utf8')

// ---- D1: after opening the activity record of the active room, Send must still send ----
function activityRig(activeThreadId, owners = []) {
  const src = surface.slice(surface.indexOf('  function openCodexActivityPanel(threadId, focus = null) {'), surface.indexOf('  // A file condition names its folder as the File card that connected it does.'))
  assert.ok(src.length > 200)
  const rendered = [], liveManualSendOwners = new Set(owners)
  const state = { codex: { activeThreadId, activityThreadId: null, activityRoomGeneration: 3, activityFocus: null } }
  const api = runInNewContext(`${src}\n({ openCodexActivityPanel })`, { state, liveManualSendOwners, renderCodexActivityPanel: () => rendered.push(state.codex.activityThreadId) })
  return { ...api, state, rendered }
}

test('u2/D1: opening the activity record of the active room moves the composer owners that were current to the new generation; stale owners and other rooms\' owners are not', () => {
  const current = { threadId: 'room-a', roomGeneration: 3 }, stale = { threadId: 'room-a', roomGeneration: 1 }, other = { threadId: 'room-b', roomGeneration: 3 }
  const rig = activityRig('room-a', [current, stale, other])
  rig.openCodexActivityPanel('room-a')
  assert.equal(rig.state.codex.activityRoomGeneration, 4, 'the generation still moves (the Briefing reads it)')
  assert.equal(current.roomGeneration, 4, 'the composer of the active room stays able to send'); assert.equal(stale.roomGeneration, 1, 'an owner that was already stale stays stale (left and returned to)'); assert.equal(other.roomGeneration, 3)
  rig.openCodexActivityPanel('room-a', { runId: 'r1' }); assert.equal(rig.state.codex.activityRoomGeneration, 4, 'once per change'); assert.equal(current.roomGeneration, 4)
  // a record of a room that is not the active one: nobody is re-stamped
  const o2 = { threadId: 'room-a', roomGeneration: 3 }, rig2 = activityRig('room-a', [o2]); rig2.openCodexActivityPanel('room-b')
  assert.equal(rig2.state.codex.activityRoomGeneration, 4); assert.equal(o2.roomGeneration, 3)
  // without the registry (older callers) nothing breaks
  const src = surface.slice(surface.indexOf('  function openCodexActivityPanel(threadId, focus = null) {'), surface.indexOf('  // A file condition names its folder as the File card that connected it does.'))
  const state = { codex: { activeThreadId: 'room-a', activityRoomGeneration: 0 } }
  runInNewContext(`${src}\nopenCodexActivityPanel('room-a')`, { state, renderCodexActivityPanel() {} }); assert.equal(state.codex.activityRoomGeneration, 1)
})

test('u2/D1: wiring: owners are registered and unregistered with their release; the composer shows the existing blocked line when a send is refused and brings a same-room owner up to date', () => {
  assert.match(surface, /const liveManualSendOwners = new Set\(\);/)
  assert.match(surface, /release: \(\) => \{ if \(typeof liveManualSendOwners !== 'undefined'\) liveManualSendOwners\.delete\(owner\); watch\.release\(\); \} \};\n\s+if \(typeof liveManualSendOwners !== 'undefined'\) liveManualSendOwners\.add\(owner\);\n\s+return owner;/)
  assert.match(surface, /onBlocked: \(\) => \{\n\s+blockedSend\.textContent = '아직 보낼 수 없습니다\.';/)
  assert.match(surface, /manualOwner\.current\(\)\)\) manualOwner\.roomGeneration = state\.codex\.activityRoomGeneration \|\| 0;/)
  assert.match(surface, /const ownerRefused = \(\) => \{ try \{ options\.onBlocked\?\.\('stale-owner'\); \} catch/)
  assert.match(surface, /\{ ownerRefused\(\); return; \}\n\s+\} catch \{ ownerRefused\(\); return; \}/)
})
