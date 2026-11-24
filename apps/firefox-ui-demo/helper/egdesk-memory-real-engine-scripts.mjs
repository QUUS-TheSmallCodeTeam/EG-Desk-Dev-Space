// L7 c26: the two memory conversation scripts for the real-engine check, built here and committed as JSON under scripts/real-engine/scripts/
// (a test keeps the files equal to what this builds). SYNTHETIC pages (a made-up server-backup policy); every expectation is DERIVED BY CODE from
// the pages (ids, a number and a phrase that only the page holds), checked on what the product sent and what the real engine answered.
// Both need --decisions: the Decision model picks and reads the pages (memory mode "on"). Run:
//   node scripts/egdesk-real-engine-check.mjs --codex-bin <bin> --person-home --decisions --out <dir> --run \
//     --script scripts/real-engine/scripts/real-engine-memory-recall-v1.json --script scripts/real-engine/scripts/real-engine-memory-held-v1.json
export const MEMORY_RECALL_SET = 'real-engine-memory-recall-v1'
export const MEMORY_HELD_SET = 'real-engine-memory-held-v1'
export const MEMORY_HELD_V2_SET = 'real-engine-memory-held-v2'
export const RETENTION = Object.freeze({ id: 'backup/retention', title: '서버 백업 보관 기간 결정', time: 'past', status: 'done', days: '47',
  body: '11월 5일 점검 회의에서 서버 백업 보관 기간을 47일로 정했다. 47일이 지나면 자동 삭제하고, 월 1회 복원 시험을 한다.' })
export const DECOYS = Object.freeze([
  Object.freeze({ id: 'office/room-rules', title: '회의실 예약 규칙', time: 'present', status: 'done', body: '3층 회의실은 사용 30분 전까지 예약하고, 취소는 10분 전까지 할 수 있다.' }),
  Object.freeze({ id: 'lunch/survey', title: '점심 설문 결과', time: 'past', status: 'done', body: '11월 둘째 주 점심 설문에서 한식을 고른 사람이 가장 많았다.' }),
])
const page = p => ({ id: p.id, title: p.title, body: p.body, time: p.time, status: p.status })

export function buildMemoryRecallScript() {
  return { set: MEMORY_RECALL_SET,
    description: 'Pattern: a first turn that refers to a stored page. Three synthetic pages are seeded into the isolated memory (the server-backup retention decision and two unrelated ones, a meeting-room rule and a lunch survey). The person asks what was decided about the backup retention at the last maintenance meeting. Needs --decisions (memory mode on). Expectations by code: the retention page has its body in the context the product sent, neither unrelated page does, the answer holds the number only that page holds (47), and the engine used no native tool.',
    conversations: [{ id: 'memory-recall', memory: { mode: 'on', pages: [page(RETENTION), ...DECOYS.map(page)] },
      turns: [{ say: '지난번 점검 회의에서 서버 백업을 며칠 보관하기로 정했는지 알려줘.',
        expect: { memory: { attached: [RETENTION.id], notAttached: DECOYS.map(d => d.id) }, posted: true, answerIncludes: [RETENTION.days], noNativeTools: true, turnStatus: 'completed' } }] }] }
}

// held-v2 (c27, from the real run of held-v1, check-2): the real model answered turn 1 of held-v1 ("어떻게 정했는지") with BOTH facts of the page (47 days and
// the automatic deletion), so its turn-2 answer "자동 삭제" could come from its own earlier answer and not from the held page. In v2 turn 1 asks only for the
// number (the recall script's wording, whose real answer held 47 and nothing else) and the turn-1 expectation answerExcludes ['자동 삭제'] makes sure of it: if the
// model volunteers the fact anyway the conversation fails at turn 1 (the precondition is not met), instead of passing turn 2 for the wrong reason.
export function buildMemoryHeldV2Script() {
  const v1 = buildMemoryHeldScript(), conv = v1.conversations[0]
  return { set: MEMORY_HELD_V2_SET,
    description: 'Pattern: a page already in the conversation is not sent again, and the answer comes from it. Turn 1 asks only how many days the backups are kept (the page is attached; the answer must NOT contain the page\'s other fact, 자동 삭제: a precondition checked by code). Turn 2 asks what happens after that period; the retention page must not have its body again (EGDESK_TURN_MEMORY_PRUNE_HELD + live receipts), yet the answer holds 자동 삭제, a phrase only that page has, so the engine answered from what it holds in the thread. Needs --decisions. Expectations by code.',
    conversations: [{ ...conv, id: 'memory-held-v2', turns: [
      { say: '지난번 점검 회의에서 서버 백업을 며칠 보관하기로 정했는지 알려줘.',
        expect: { memory: { attached: [RETENTION.id], notAttached: DECOYS.map(d => d.id) }, posted: true, answerIncludes: [RETENTION.days], answerExcludes: ['자동 삭제'], noNativeTools: true, turnStatus: 'completed' } },
      conv.turns[1],
    ] }] }
}

export function buildMemoryHeldScript() {
  const restore = { id: 'backup/restore-test', title: '백업 복원 시험 절차', time: 'past', status: 'done', body: '복원 시험은 매월 첫째 월요일에 하고, 실패하면 그날 안에 담당자를 호출한다.', links: [{ to: RETENTION.id, type: 'follows_from' }] }
  return { set: MEMORY_HELD_SET,
    description: 'Pattern: a page that is already in the conversation is not sent again. Turn 1 asks about the backup retention (the retention page is attached, its body once). Turn 2 asks a follow-up that the same page answers ("그럼 그 기간이 지나면 어떻게 하기로 했지?"). With turn-memory receipts and the held-record pruning (EGDESK_TURN_MEMORY_PRUNE_HELD) on a live thread, the retention page must not have its body again in turn 2; the engine still answers from what it already holds (the phrase 자동 삭제 comes only from that page). Needs --decisions. Expectations by code.',
    conversations: [{ id: 'memory-held', flags: { EGDESK_TURN_MEMORY_PRUNE_HELD: 'on' }, memory: { mode: 'on', pages: [page(RETENTION), restore, ...DECOYS.map(page)] },
      turns: [
        { say: '지난번 점검 회의에서 서버 백업 보관 기간을 어떻게 정했는지 알려줘.',
          expect: { memory: { attached: [RETENTION.id], notAttached: DECOYS.map(d => d.id) }, posted: true, answerIncludes: [RETENTION.days], noNativeTools: true, turnStatus: 'completed' } },
        { say: '그럼 그 기간이 지나면 어떻게 하기로 했지?',
          expect: { memory: { noResends: true, notAttached: DECOYS.map(d => d.id) }, posted: true, answerIncludes: ['자동 삭제'], noNativeTools: true, turnStatus: 'completed' } },
      ] }] }
}
