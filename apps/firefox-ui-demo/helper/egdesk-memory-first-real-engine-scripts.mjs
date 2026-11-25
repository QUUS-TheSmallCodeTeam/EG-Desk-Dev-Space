// L7 c38: the memory layer settled BEFORE the engine answers (EGDESK_TURN_MEMORY_WRITE_FIRST=on, egdesk-record-settled.mjs) against the same turns without it, on the real engine.
// Fixtures are write-v3's (three synthetic schedule records without a date, the flags of write-v3: hybrid-ask, own wording v4, confirmation wording v2), so a pair differs in ONE flag.
//   own-confirm-off    write-v3's own-confirm, unchanged (the baseline: four turns; the note is stated by the reply of turn 3 and "응 맞아" at turn 4 confirms it)
//   own-confirm-first  the same statement with the flag: turn 2 is settled before the engine (the pending reading exists, the engine is told it, conflict marked: the record says undecided and the
//                      person says settled), its words must not call it settled; "응 맞아" at turn 3 confirms it with no turn in between
//   control-first      a message that agrees with the record (asks about it): nothing to settle, no conflict marked, nothing stored
//   hedged-first, relayed-first   write-v3's hedged and relayed turns with the flag: their expectations unchanged (hedged is not recorded as a statement, relayed stays attributed)
// Expectations by code, none asked of a model: the store (reading, status, basis), settled / conflict (the product's receipt of the turn), and for turn 2 words the answer must not contain.
// The comparison is scripts/egdesk-memory-first-compare.mjs: per turn engine seconds, the answer, and what was settled when.
import { buildMemoryWriteV3Script } from './egdesk-memory-real-engine-scripts.mjs'
export const MEMORY_FIRST_SET = 'real-engine-memory-first-v1'
// What an answer must not say about a report that is only kept unconfirmed (check-27mw: "확정됐군요" before the record was judged).
export const NOT_SETTLED_WORDS = Object.freeze(['확정됐', '확정되었', '확정 완료', '확정이군요', '확정이네요'])
export function buildMemoryFirstScript() {
  const v3 = buildMemoryWriteV3Script(), by = id => v3.conversations.find(c => c.id === id)
  const FIRST = { EGDESK_TURN_MEMORY_WRITE_FIRST: 'on' }
  const own = by('own-confirm'), hedged = by('hedged'), relayed = by('relayed')
  const page = 'schedule/product-review'
  const withFlag = (conv, id) => ({ ...conv, id, flags: { ...conv.flags, ...FIRST } })
  const turn = (say, expect) => ({ say, expect })
  const base = { posted: true, noNativeTools: true, turnStatus: 'completed' }
  const ownFirst = { ...withFlag(own, 'own-confirm-first'), turns: [
    own.turns[0],
    turn(own.turns[1].say, { ...own.turns[1].expect, recording: { ...own.turns[1].expect.recording, settled: true, conflict: true }, answerExcludes: [...NOT_SETTLED_WORDS] }),
    turn('응 맞아', { ...own.turns[3].expect }) ] }
  const control = { ...withFlag(own, 'control-first'), turns: [
    own.turns[0],
    turn('신제품 리뷰 회의 일정 아직 안 정해졌지?', { recording: { page, reading: 'none', readings: 0, newPages: 0, conflict: false }, ...base }) ] }
  const hedgedFirst = { ...withFlag(hedged, 'hedged-first'), turns: hedged.turns.slice(0, 2) }
  const relayedFirst = { ...withFlag(relayed, 'relayed-first'), turns: relayed.turns.slice(0, 2) }
  return { set: MEMORY_FIRST_SET,
    description: 'Pattern: the memory layer is settled before the engine answers (EGDESK_TURN_MEMORY_WRITE_FIRST=on): at the start of the turn the write judgment runs, a pending reading is stored, the pair (record, message) is judged for a conflict, and the engine is handed the settled state, so its words follow the record. write-v3\'s own-confirm without the flag is the baseline. Expectations by code: the store, the product\'s receipt (settled, conflict), words the answer must not contain. Needs --decisions, --person-home and --persisted-with-cleanup (the opt-in of the confirmation).',
    conversations: [by('own-confirm') && { ...own, id: 'own-confirm-off' }, ownFirst, control, hedgedFirst, relayedFirst] }
}
