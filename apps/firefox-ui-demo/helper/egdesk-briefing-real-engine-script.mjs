// L4 cycle 30: a conversation script for lane L5's real-engine check (scripts/egdesk-real-engine-check.mjs; format { set, conversations: [{ id, folder, flags, turns:
// [{ say, approve, expect }] }] }) in which the person asks for a progress summary over dated materials in the folder. Pure: entries in, script out. The folder is
// SYNTHETIC (a made-up dev log, no real data); every expectation is DERIVED BY CODE from the entries (ids, counts, open items, the unchanged file contents), never
// from an answer, and checked by code on the turn record (nothing asks a model whether the turn went well).
//
// v1 (cycle 30) covers the answer half: the real engine reads the dated materials with the own tools, posts the progress summary (the answer a briefing is built from)
// with every fact of the materials, never touches the files and never uses a native tool. It sets no briefing flag, so it runs without --decisions. The other half, the
// board-design turn on the real engine, is v2 below (cycle 31), run through the briefing hook of the check.

export const PROGRESS_SET = 'real-engine-briefing-progress-v1'
export const PROGRESS_ENTRIES = Object.freeze([
  Object.freeze({ file: 'devlog/11-20.md', day: '11-20', status: 'done', topic: '로그인 화면', commit: 'a1b2c3d', tests: 120 }),
  Object.freeze({ file: 'devlog/11-22.md', day: '11-22', status: 'done', topic: '결제 모듈', commit: 'e4f5a6b', tests: 98, note: '알림 설정 화면은 시안만 확정' }),
  Object.freeze({ file: 'devlog/11-24.md', day: '11-24', status: 'plan', topic: '검색 화면', open: Object.freeze(['알림 설정 구현', '검색 성능 점검', '배포 체크리스트 작성']) }),
])
const fileText = e => e.status === 'done'
  ? `# ${e.day} 기록\n\n- ${e.topic} 병합 완료 (커밋 ${e.commit}, 테스트 ${e.tests}건 통과).${e.note ? `\n- ${e.note}.` : ''}\n`
  : `# ${e.day} 기록\n\n- ${e.topic} 착수.\n- 남은 일: ${e.open.join(', ')}.\n`

/** buildProgressScript(entries) -> the script object. folder, turns and expectations all come from the entries. */
export function buildProgressScript(entries = PROGRESS_ENTRIES) {
  const folder = Object.fromEntries(entries.map(e => [e.file, fileText(e)]))
  const done = entries.filter(e => e.status === 'done'), open = entries.flatMap(e => e.open ?? [])
  return { set: PROGRESS_SET,
    description: 'Pattern: a progress summary over dated materials. A synthetic dev log (three dated notes: two merges with commit ids and test counts, one started with three open items). Turn 1 asks for the progress in date order with the commit ids and test counts; the answer must carry every merged topic, commit id and test count, read the notes with the own file tool, change nothing and use no native tool. Turn 2 asks what is still to do; it must name every open item. All expectations are derived by code from the notes. The briefing flags are not set: the real-engine check does not reproduce the Board presentation path (its BRIDGE_COMPOSITION lists EGDESK_BRIEFING_FLOW as not reproduced).',
    conversations: [{ id: 'briefing-progress', folder,
      turns: [
        { say: 'devlog 폴더의 기록을 읽고 진행 상황을 날짜 순서로 정리해줘. 커밋 id와 테스트 건수도 같이. 파일은 바꾸지 마.',
          expect: { toolCalls: ['egdesk_read_file'], posted: true, answerIncludes: [...done.flatMap(e => [e.topic, e.commit, String(e.tests)]), ...entries.filter(e => e.status === 'plan').map(e => e.topic)],
            files: folder, undoRecords: 0, noNativeTools: true, turnStatus: 'completed' } },
        { say: '그래서 남은 일은 뭐야?', expect: { posted: true, answerIncludes: open, files: folder, undoRecords: 0, noNativeTools: true, turnStatus: 'completed' } },
      ] }] }
}

// ---- v2 (cycle 31): the board-design turn on the real engine. The check now runs the briefing flow (helper/egdesk-real-engine-briefing-hook.mjs, registered in
// helper/egdesk-real-engine-hooks.mjs) for a conversation whose flags say EGDESK_BRIEFING_FLOW=on, and only with --decisions. The same dev log and the same first turn run in
// TWO conversations that differ in one flag: EGDESK_BRIEFING_OUTPUT_SCHEMA on / off. The real engine writes the fill (no scripted fill). The expectations are derived by code
// from the notes: the board is proposed (three dated notes cited by an answer of several facts), every commit id, test count and open item the notes state is carried by the
// board's cards (each note fits one 90-character line, so a faithful card carries it verbatim), the schema was sent exactly when the flag is on, and with it on no reply of the
// engine broke the schema (schemaInvalid 0). A failure of one of these on the real engine is the finding, not a broken check.
export const BOARD_SET = 'real-engine-briefing-progress-v2'
export const BOARD_SAY = 'devlog 폴더의 기록을 읽고 진행 상황을 날짜 순서로 정리해줘. 커밋 id와 테스트 건수도 같이. 파일은 바꾸지 마.'
/** buildBoardScript(entries) -> the v2 script object. */
export function buildBoardScript(entries = PROGRESS_ENTRIES) {
  const folder = Object.fromEntries(entries.map(e => [e.file, fileText(e)]))
  const done = entries.filter(e => e.status === 'done'), open = entries.flatMap(e => e.open ?? [])
  const turn = schema => ({ say: BOARD_SAY, expect: { toolCalls: ['egdesk_read_file'], posted: true, answerIncludes: [...done.flatMap(e => [e.topic, e.commit, String(e.tests)]), ...entries.filter(e => e.status === 'plan').map(e => e.topic)],
    files: folder, undoRecords: 0, noNativeTools: true, turnStatus: 'completed',
    briefing: { outcome: 'presented', schemaSent: schema, schemaInvalid: schema ? 0 : null, factsOnBoard: [...done.flatMap(e => [e.commit, String(e.tests)]), ...open] } } })
  return { set: BOARD_SET,
    description: 'Pattern: the board-design turn of the briefing on the REAL engine. The same synthetic dev log and the same progress request run in two conversations that differ in one flag, EGDESK_BRIEFING_OUTPUT_SCHEMA on and off. After the answer is posted the check runs the briefing flow (the production Board/Decisions handler, the Decision model, the real engine\'s private fork turn writing the fill) and records the board. Expectations, derived by code from the notes: a board is proposed, every commit id, test count and open item is on its cards, the schema is sent exactly when the flag is on, and with the flag on no reply of the engine breaks the schema. Runs only with --decisions.',
    conversations: [
      { id: 'briefing-schema-on', folder, flags: { EGDESK_BRIEFING_FLOW: 'on', EGDESK_BRIEFING_OUTPUT_SCHEMA: 'on' }, turns: [turn(true)] },
      { id: 'briefing-schema-off', folder, flags: { EGDESK_BRIEFING_FLOW: 'on' }, turns: [turn(false)] },
    ] }
}
