import { maskSecrets } from './egdesk-briefing-ledger-materials.mjs'
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

// ---- v3 (cycle 37): the same board-design turn on REAL material, as long as a real ledger is. LOOP_ENTRIES are twelve entries of the decision loop's own ledger (the EG-Desk
// development record Main approved as a source; EG-Desk only, nothing of a customer; the text is the ledger line verbatim, masked by maskSecrets, none above the 400
// characters a material keeps), two topics interleaved in time: "integration" (the merges and their gates) and "measure" (the real-call measurements). Every entry is
// longer than the 90 characters of a sequence line (95 to 243), so no line can simply be copied: the model must keep each entry's key `fact` inside its line. The key facts are
// ids and figures exactly as the ledger writes them; the builder and a test check that each is in its entry's text.
export const LOOP_SET = 'real-engine-briefing-realistic-v1'
export const LOOP_SAY = 'ledger 폴더의 기록을 읽고 두 흐름(통합 게이트, 실호출 측정)을 각각 날짜와 시간 순서로 정리해줘. 항목마다 커밋 id나 건수·측정값을 기록에 적힌 그대로 같이 적어줘. 파일은 바꾸지 마.'
export const LOOP_ENTRIES = Object.freeze([
  Object.freeze({ file: "ledger/11-24-1353-integration.md", topic: "integration", day: "11-24", time: "13:53", fact: "9aeed73",
    text: "통합 수정 9aeed73: L3 c3 추정 집계와 Board 시험의 우연한 상한 100 충돌 → 시험 고정값만 상향(제품 동작 불변). 게이트 2256건 통과 2254·건너뜀 2·실패 0." }),
  Object.freeze({ file: "ledger/11-24-1414-integration.md", topic: "integration", day: "11-24", time: "14:14", fact: "5752건",
    text: "int/c2 구성: int/c1 + L6c2·L1c3·L4c2·L8c3·L2c3·L7c3·L5c2(충돌 Main 해소: decision-client의 dispatched 단일화+onDispatch+추정 집계, 시험 2개 모두 유지; context-setup localOnly+calibration). 표준 게이트를 L6 권장 234개+새 시험(가드) gate.sh로 교체: 242개 파일 5752건 통과 5719·건너뜀 33·실패 0." }),
  Object.freeze({ file: "ledger/11-24-1529-integration.md", topic: "integration", day: "11-24", time: "15:29", fact: "5930건",
    text: "int/c5 = int/c4 + L1c6·L7c6·L5c5·L4c5·L8c6·L3c7(보정 어휘 충돌 합집합 해소). 게이트 258개 파일 5930건: 통과 5897·건너뜀 33·실패 0." }),
  Object.freeze({ file: "ledger/11-24-1552-integration.md", topic: "integration", day: "11-24", time: "15:52", fact: "5990건",
    text: "int/c7 = int/c6 + L7c8(사전 분류 수정·조용한 연결, 기본 꺼짐) + L8c8(브라우저가 공통 기억·온톨로지 경로 사용) + L4c7(재사용 우선 브리핑). 게이트 263개 파일 5990건: 통과 5957·건너뜀 33·실패 0." }),
  Object.freeze({ file: "ledger/11-24-1642-integration.md", topic: "integration", day: "11-24", time: "16:42", fact: "6085건",
    text: "int/c10 = int/c9 + L3c10(전송 등록·run_facts) + L4c10(브리핑 on 경로를 공통 전송 게이트로) + L7c11(중간 턴 수정). 등록부 중복 키 Main 정리. 게이트 274개 파일 6085건: 통과 6052·건너뜀 33·실패 0." }),
  Object.freeze({ file: "ledger/11-25-0131-integration.md", topic: "integration", day: "11-25", time: "01:31", fact: "218c711",
    text: "병합: L7 c24, L4 c29, L3 c22(L2 c17 포함), L2 c18, L8 c22, L6 c17, L1 c21(생성자 인자 충돌을 합집합으로 해결) → int/c14 218c711. 게이트 386/6976, 실패 1 = 미등록 계획 2개(L2 v6, L8 stability; 각 레인 항목 0)." }),
  Object.freeze({ file: "ledger/11-24-1511-measure.md", topic: "measure", day: "11-24", time: "15:11", fact: "2.48s",
    text: "실호출(승인): 지연 4회(새 연결 TCP 7ms·TLS 18ms, 재연결 0.48s, 60초 유휴 재사용 0.47s, 프로세스 첫 요청 2.48s) + 발언 질문 비교 2회(현행 채택 0, 예/아니오형은 두 구간을 구분 못 해 오답·6,017토큰 → 미채택). 장시간 유휴 측정 진행 중." }),
  Object.freeze({ file: "ledger/11-24-1609-measure.md", topic: "measure", day: "11-24", time: "16:09", fact: "0.27~0.29s",
    text: "실호출(승인 범위) 사전 분류 후속 4건(보유 자료 상태·본문 앞부분 표시): 완료보고 필요 .04·기록 1, 다른 주제 필요 1, 롤백 미보유 필요 1(이전 .02 오판 해소), 롤백 보유 대조군 필요 0 → 4/4 사전 기대 일치. 첫 호출 1.8s(장시간 유휴 후), 나머지 0.27~0.29s, 약 3.4k토큰." }),
  Object.freeze({ file: "ledger/11-24-1642-measure.md", topic: "measure", day: "11-24", time: "16:42", fact: "13,404토큰",
    text: "실호출(승인 범위) 중간 턴 재측정 6건(13,404토큰): 4/4 통과·하드 실패 0. PG 중간 턴 스캔 헬스체크 .99·후속 .98(이전 .37 미선택), jev 중간 턴 사전 분류 필요 1·회상 1(이전 .02 오건너뜀), 보유 대조군 필요 0·회상 0(건너뜀 유지), A사 첫 턴 31/31. 지연 0.25~0.43s(첫 호출 1.6s)." }),
  Object.freeze({ file: "ledger/11-24-1922-measure.md", topic: "measure", day: "11-24", time: "19:22", fact: "13,579토큰",
    text: "실호출(승인 범위) 첫 턴 스캔 재확인 2건(13,579토큰): PG 첫 턴 통과(계획 .99·헬스체크 .98·후속 .97·롤백 .82, 무관한 jev 메모 0.2 미만), jev 첫 턴 통과(흐름 메모 1.0)." }),
  Object.freeze({ file: "ledger/11-25-0152-measure.md", topic: "measure", day: "11-25", time: "01:52", fact: "269ms",
    text: "대기 측정 C1(예열 10초 뒤) 269ms, A2(예열 없음, 10분 쉼) 561ms. 브라우저 안정성 2회차 = 1회차와 모든 판정 값 동일(같은 본문이면 같은 답)." }),
  Object.freeze({ file: "ledger/11-25-0231-measure.md", topic: "measure", day: "11-25", time: "02:31", fact: "248ms",
    text: "예열 측정 6지점 완료: A1 1,812 / A2 561(예열 없음), B1 324 / B2 322(1초 전 예열), C1 269 / C2 316(10초 전 예열) → 등록 판정 '예열 효과 있음'(L6: 느린 꼬리는 1회차에만 나타나 증거는 약함). 크기 측정 S1(작은 예열) 248ms." }),
])
const loopText = e => `# ${e.day} ${e.time}\n\n- ${e.text}\n`
/** buildLoopScript(entries) -> the v3 script object. Folder, answer expectations and board expectations all come from the entries. */
export function buildLoopScript(entries = LOOP_ENTRIES) {
  for (const e of entries) { if (maskSecrets(e.text) !== e.text) throw new Error(`${e.file} has something maskSecrets would mask`); if (!e.text.includes(e.fact)) throw new Error(`the fact ${e.fact} is not in ${e.file}`); if (e.text.length > 400) throw new Error(`${e.file} is over the 400 characters a material keeps`) }
  const folder = Object.fromEntries(entries.map(e => [e.file, loopText(e)]))
  const inTime = topic => entries.filter(e => e.topic === topic).sort((a, b) => `${a.day} ${a.time}`.localeCompare(`${b.day} ${b.time}`)).map(e => e.fact)
  const topics = [...new Set(entries.map(e => e.topic))], facts = entries.map(e => e.fact)
  // c38: no `toolCalls` expectation: check-17b's engine read the twelve files with egdesk_run_command (cat) in one conversation and egdesk_read_file in the other; both are the engine's own
  // tools, and what the turn must not do is checked by `files` (nothing changed) and `noNativeTools`.
  const turn = schema => ({ say: LOOP_SAY, expect: { posted: true, answerIncludes: facts, files: folder, undoRecords: 0, noNativeTools: true, turnStatus: 'completed',
    briefing: { outcome: 'presented', schemaSent: schema, schemaInvalid: schema ? 0 : null, factsInCards: facts, inOrder: topics.map(inTime) } } })
  return { set: LOOP_SET,
    description: 'Pattern: the board-design turn of the briefing on REAL material. Twelve entries of the decision loop\'s own ledger (EG-Desk only), two topics interleaved in time, every entry longer than the 90 characters of a sequence line. The engine reads them, writes the progress answer, and after it is posted the check runs the briefing flow (the production Board/Decisions handler, the Decision model, the engine\'s private fresh-thread turns writing the fill). Expectations, derived by code from the entries: the board is presented, every key fact (commit id, count or measurement, as the ledger writes it) is in the text of the published cards, and within each topic the facts are in time order. Two conversations: EGDESK_BRIEFING_OUTPUT_SCHEMA on and off. Runs only with --decisions.',
    conversations: [
      { id: 'realistic-schema-on', folder, flags: { EGDESK_BRIEFING_FLOW: 'on', EGDESK_BRIEFING_OUTPUT_SCHEMA: 'on' }, turns: [turn(true)] },
      { id: 'realistic-schema-off', folder, flags: { EGDESK_BRIEFING_FLOW: 'on' }, turns: [turn(false)] },
    ] }
}
