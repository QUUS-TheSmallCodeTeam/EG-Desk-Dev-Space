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

// ---- v2 (c39): the two gaps of v1 behind the same flag ----
// v1 (without control-first: the check takes at most 8 conversations) plus
//   newrecord-first         a statement that is a NEW record ("다음 달 둘째 주에 재고 실사를 할 거야": no seeded record is about it): decided at the start of the turn, stored when the turn is accepted
//                           (one utterance page, nothing on the seeded records), the engine's words do not call it settled; the turn after asks for it back (the stored page is read)
//   contradiction-off       two unlinked records that give the same workshop two different days, asked about it, WITHOUT the flag: the baseline for what the engine says
//   contradiction-first     the same with the flag: the settlement marks one contradicting pair (code reads the product's receipt), the engine is told, and its answer must name BOTH days
//                           (it may not pick one silently); nothing is stored for it
//   contradiction-control   two unlinked records about different matters (a workshop day, a vendor visit): nothing to mark, 0 pairs, the answer holds the workshop day
// Fixtures: the schedule pages of write-v3 plus the two workshop records. Everything of v1 stays as strict as it was.
export const MEMORY_FIRST_V2_SET = 'real-engine-memory-first-v2'
const WORKSHOP_PAGES = Object.freeze([
  { id: 'schedule/workshop-a', title: '사내 워크숍 일정', body: '사내 워크숍은 12월 5일 금요일로 확정됐다.', time: 'planned' },
  { id: 'schedule/workshop-b', title: '워크숍 날짜 메모', body: '사내 워크숍은 12월 12일 금요일로 잡혀 있다.', time: 'planned' }])
export function buildMemoryFirstV2Script() {
  const v1 = buildMemoryFirstScript(), own = buildMemoryWriteV3Script().conversations.find(c => c.id === 'own-confirm')
  const FIRST = { EGDESK_TURN_MEMORY_WRITE_FIRST: 'on' }, base = { posted: true, noNativeTools: true, turnStatus: 'completed' }
  const turn = (say, expect) => ({ say, expect })
  const page = 'schedule/product-review'
  const newrecord = { ...own, id: 'newrecord-first', flags: { ...own.flags, ...FIRST }, turns: [
    own.turns[0],
    turn('아 그리고 다음 달 둘째 주에 재고 실사를 할 거야', { recording: { page, reading: 'none', readings: 0, newPages: 1, settled: true }, answerExcludes: [...NOT_SETTLED_WORDS], ...base }),
    turn('방금 말한 재고 실사 일정 어떻게 정리돼 있어?', { recording: { page, reading: 'none', readings: 0, newPages: 1 }, answerIncludes: ['재고 실사'], ...base }) ] }
  const withWorkshop = (id, flags, turns, pages = WORKSHOP_PAGES) => ({ ...own, id, flags: { ...own.flags, ...flags }, memory: { mode: 'on', pages: [...pages] }, turns })
  const ask = '사내 워크숍 언제야?'
  const contradictionOff = withWorkshop('contradiction-off', {}, [turn(ask, { recording: { page: 'schedule/workshop-a', reading: 'none', readings: 0, newPages: 0 }, ...base })])
  const contradictionFirst = withWorkshop('contradiction-first', FIRST, [turn(ask, { recording: { page: 'schedule/workshop-a', reading: 'none', readings: 0, newPages: 0, settled: true, contradictions: 1 }, answerIncludes: ['12월 5일', '12월 12일'], answerExcludes: [...NOT_SETTLED_WORDS], ...base })])
  const control = withWorkshop('contradiction-control', FIRST, [turn(ask, { recording: { page: 'schedule/workshop-a', reading: 'none', readings: 0, newPages: 0, contradictions: 0 }, answerIncludes: ['12월 5일'], ...base })],
    [WORKSHOP_PAGES[0], { id: 'schedule/vendor-visit', title: '거래처 점검 방문 일정', body: '거래처 점검 방문은 아직 정해지지 않았다. 담당자가 날짜를 조율 중이다.', time: 'planned' }])
  return { ...v1, set: MEMORY_FIRST_V2_SET,
    description: v1.description + ' v2 (c39): a statement that is a new record is decided at the start and stored when the turn is accepted (newrecord-first), and two unlinked records of the picked set that disagree are stated to the engine as contradicting (contradiction-first against contradiction-off; contradiction-control has nothing to mark). Expectation keys: recording.newPages, settled, contradictions; the answer of contradiction-first must name both days.',
    conversations: [...v1.conversations.filter(c => c.id !== 'control-first'), newrecord, contradictionOff, contradictionFirst, control] }
}
