import { DECISION_MODEL } from './egdesk-decision-client.mjs'
import { ASKED, NOT_YES, NO, YES, adder, bars, finish, p } from './egdesk-c36-plans.mjs'
import { contradictionPairs, contradictionRequest, judgeRecordConflict } from './egdesk-record-settled.mjs'

// L7 c39: two PREPARED, NOT SENT plans for the questions memory-first (EGDESK_TURN_MEMORY_WRITE_FIRST=on) added in c38 and c39; nothing here sends or reads a key. Bodies are the product's own,
// built by the product's functions with a capturing client.
//  conflict-pair-v1       cf_differs (c38): does the person's message say something other than the stored record says (a different state or date)? One question over one pair.
//  contradiction-pairs-v1 ct_<k> (c39): do two stored records contradict each other (a different state, date, time, amount or place for the very same matter)? One request, one question per pair.
// The product marks a conflict / a contradiction only at a decided yes (>= .8, the ternary bar); under it nothing is marked and nothing changes for the turn.
const page = (title, status, slice, body) => ({ id: `ontology:${title}`, title, status, time: { slice }, body })
const REVIEW = page('신제품 리뷰 회의 일정', 'unknown', 'planned', '신제품 리뷰 회의 일정은 아직 정해지지 않았다. 후보는 다음 주 화요일과 수요일이다.')
const WORKSHOP = page('사내 워크숍 일정', 'done', 'planned', '사내 워크숍은 12월 5일 금요일로 확정됐다. 장소는 판교 사무실이다.')
const DEPLOY = page('PostgreSQL 마이그레이션 배포 계획', 'plan', 'planned', '12월 첫째 주에 전환 배포할 예정이다. 아직 배포 전이다.')

// ---- conflict-pair-v1 ----
export const CONFLICT_SET = 'conflict-pair-v1'
export const CONFLICT_CASES = Object.freeze([
  { id: 'cf-undecided-settled', page: REVIEW, message: '아 그거 다음 주 화요일로 확정했어', expect: [p('cf_differs', 'min', YES, 'hard', 'the record leaves it undecided and the person settles it (check-27mw own-confirm turn 2)')] },
  { id: 'cf-plan-done', page: DEPLOY, message: 'PostgreSQL 마이그레이션 배포 끝났어', expect: [p('cf_differs', 'min', YES, 'hard', 'the record plans it, the person says it is done')] },
  { id: 'cf-other-date', page: WORKSHOP, message: '워크숍 12월 12일로 옮겼대', expect: [p('cf_differs', 'min', YES, 'hard', 'the record names 12월 5일, the message another day')] },
  { id: 'cf-same', page: WORKSHOP, message: '워크숍 12월 5일 금요일 맞지?', expect: [p('cf_differs', 'max', NOT_YES, 'hard', 'the message repeats the record: must not be marked'), p('cf_differs', 'max', NO, 'soft', 'a clear no')] },
  { id: 'cf-question', page: REVIEW, message: '그 회의 일정 지금 어떻게 돼 있어?', expect: [p('cf_differs', 'max', NOT_YES, 'hard', 'a question about the record states nothing different')] },
  { id: 'cf-other-matter', page: WORKSHOP, message: '점심 뭐 먹을지 고민이야', expect: [p('cf_differs', 'max', NOT_YES, 'hard', 'about something else'), p('cf_differs', 'max', NO, 'soft', 'a clear no')] },
])
async function conflictBody(def) {
  let request = null
  await judgeRecordConflict({ message: def.message, page: def.page, askedAt: ASKED, client: { async decide(r) { request = r; return { answers: {} } } } })
  return { model: DECISION_MODEL, input: request.input, questions: request.questions }
}
export async function buildConflictPairPlan() {
  const a = adder()
  for (const def of CONFLICT_CASES) a.add(def.id, await conflictBody(def), def.expect)
  return finish(CONFLICT_SET, a.requests, a.files, bars(['cf_differs'], YES, YES - 1e-6, 'egdesk-record-settled.mjs: a conflict is marked only at a decided yes (the ternary bar .8); under it nothing is marked'),
    'Every hard check passes: the three differing messages (undecided to settled, planned to done, another date) reach the yes bar, the three that do not differ (a repeat, a question, another matter) stay under it. The soft checks are the clear no. The bars are the product\'s and are not changed here.')
}

// ---- contradiction-pairs-v1 ----
export const CONTRADICTION_SET = 'contradiction-pairs-v1'
const WS_A = page('사내 워크숍 일정', 'unknown', 'planned', '사내 워크숍은 12월 5일 금요일로 확정됐다.')
const WS_B = page('워크숍 날짜 메모', 'unknown', 'planned', '사내 워크숍은 12월 12일 금요일로 잡혀 있다.')
const WS_PLACE = page('워크숍 장소', 'unknown', 'planned', '사내 워크숍 장소는 판교 사무실이다.')
const WS_SAME = page('워크숍 확정 공지', 'unknown', 'planned', '12월 5일 금요일에 사내 워크숍을 한다고 공지했다.')
const VENDOR = page('거래처 점검 방문 일정', 'unknown', 'planned', '거래처 점검 방문은 아직 정해지지 않았다. 담당자가 날짜를 조율 중이다.')
const REVIEW_SET = page('신제품 리뷰 회의 확정', 'unknown', 'planned', '신제품 리뷰 회의는 다음 주 화요일 오후 2시로 확정됐다.')
export const CONTRADICTION_CASES = Object.freeze([
  { id: 'ct-dates', pages: [WS_A, WS_B], expect: [p('ct_0', 'min', YES, 'hard', 'the same workshop on two different days')] },
  { id: 'ct-undecided-settled', pages: [REVIEW, REVIEW_SET], expect: [p('ct_0', 'min', YES, 'hard', 'one record says the meeting is undecided, the other that it is settled')] },
  { id: 'ct-different-matters', pages: [WS_A, VENDOR], expect: [p('ct_0', 'max', NOT_YES, 'hard', 'two different matters: no contradiction'), p('ct_0', 'max', NO, 'soft', 'a clear no')] },
  { id: 'ct-added-detail', pages: [WS_A, WS_PLACE], expect: [p('ct_0', 'max', NOT_YES, 'hard', 'the second adds a detail (the place), it does not contradict'), p('ct_0', 'max', NO, 'soft', 'a clear no')] },
  { id: 'ct-same', pages: [WS_A, WS_SAME], expect: [p('ct_0', 'max', NOT_YES, 'hard', 'both name the same day: no contradiction'), p('ct_0', 'max', NO, 'soft', 'a clear no')] },
  { id: 'ct-three-records', pages: [WS_A, WS_B, VENDOR], expect: [p('ct_0', 'min', YES, 'hard', 'pair 1 (the workshop on two days)'), p('ct_1', 'max', NOT_YES, 'hard', 'pair 2 (workshop vs vendor visit)'), p('ct_2', 'max', NOT_YES, 'hard', 'pair 3 (workshop memo vs vendor visit): each question judges its own pair')] },
])
export async function buildContradictionPairsPlan() {
  const a = adder()
  for (const def of CONTRADICTION_CASES) {
    const { input, questions } = contradictionRequest(contradictionPairs(def.pages), ASKED)
    a.add(def.id, { model: DECISION_MODEL, input, questions }, def.expect)
  }
  return finish(CONTRADICTION_SET, a.requests, a.files, bars(['ct_#'], YES, YES - 1e-6, 'egdesk-record-settled.mjs: a contradiction is stated only at a decided yes (the ternary bar .8); under it nothing is stated'),
    'Every hard check passes: the same workshop on two days and a settled-versus-undecided meeting reach the yes bar, two different matters, an added detail and a repeat stay under it, and in the three-record request each question is read for its own pair. The bars are the product\'s and are not changed here.')
}
