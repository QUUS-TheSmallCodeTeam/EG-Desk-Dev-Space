// L4 cycle 30: a conversation script for lane L5's real-engine check (scripts/egdesk-real-engine-check.mjs; format { set, conversations: [{ id, folder, flags, turns:
// [{ say, approve, expect }] }] }) in which the person asks for a progress summary over dated materials in the folder. Pure: entries in, script out. The folder is
// SYNTHETIC (a made-up dev log, no real data); every expectation is DERIVED BY CODE from the entries (ids, counts, open items, the unchanged file contents), never
// from an answer, and checked by code on the turn record (nothing asks a model whether the turn went well).
//
// What the real-engine check can and cannot cover (read from its composition, BRIDGE_COMPOSITION in helper/egdesk-real-engine-check.mjs): it runs the REAL answering
// engine with EG-Desk's own tools, the runtime and the Decision client, and it lists EGDESK_BRIEFING_FLOW as NOT reproduced (no Board presentation route, no chrome).
// So this script covers the half it can: the real engine reads the dated materials with the own tools, posts the progress summary (the answer a briefing is built from)
// with every fact of the materials, never touches the files and never uses a native tool. It sets no briefing flag: in that harness such a flag would silently do nothing.
// The other half - the real engine's private fork turn constrained by outputSchema - needs a hook in that harness (see the cycle 30 report).

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
