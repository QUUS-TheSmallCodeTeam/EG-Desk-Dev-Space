import { createHash } from 'node:crypto'
import { DECISION_MODEL } from './egdesk-decision-client.mjs'
import { prepareTurnContext } from './egdesk-context-setup.mjs'
import { judgeConfirmation } from './egdesk-record-confirmation.mjs'
import { SPEECH_SPLIT_BARS, speechSegments, speechSplitQuestions } from './egdesk-speech-grounding.mjs'
import { SECOND_LABEL_RULES } from './egdesk-turn-memory.mjs'
import { clockLine } from './egdesk-wiki-reconstruction.mjs'

// L7 c36: three PREPARED, NOT SENT plans (nothing here sends or reads a key). Bodies are the product's own.
//  confirmation-stated-v1  the "stated" question of the confirmation and the quote of the note (CONFIRM_WORDINGS v2 / v3), on the real reply of check-20mw turn 3.
//  own-wording-v4          the own predicate of the source split, wording v4 (decided / fixed / arranged count), on targets and guards.
//  status-question-v1      the context selection's 'action+status' rule on the V1 catalog (L2 c29's s1.packet).
export const estimate = (choice, predicate, bytes) => Math.round(56.5 * choice + 134.8 * predicate + 0.1983 * bytes)
const sha = bytes => createHash('sha256').update(bytes).digest('hex')
export const ASKED = Date.parse('2026-11-24T14:30:00+09:00')
export const p = (name, bound, value, severity, note) => ({ name, kind: 'predicate', [bound]: value, severity, note })
export const YES = 0.8, NO = 0.2, NOT_YES = 0.79
export const bars = (names, yes, no, source) => Object.fromEntries(names.map(k => [k, { yes, no, source }]))
export function finish(set, requests, files, productBars, passRule) {
  const total = requests.reduce((n, r) => n + r.estInputTokens, 0)
  return { plan: { set, tokenCeiling: Math.ceil(total * 1.3 / 100) * 100, productBars, passRule, requests }, files, estInputTokens: total }
}
export function adder() {
  const requests = [], files = []
  return { requests, files, add(id, body, expect) {
    const bytes = Buffer.from(JSON.stringify(body), 'utf8'), names = new Set(body.questions.map(q => q.name))
    for (const e of expect) if (!names.has(e.name)) throw new Error(`${id}: no question named ${e.name}`)
    const file = `requests/${id}.json`
    files.push({ file, bytes })
    requests.push({ id, file, sha256: sha(bytes), estInputTokens: estimate(body.questions.filter(q => q.type === 'choice').length, body.questions.filter(q => q.type === 'predicate').length, bytes.length), expect: expect.map(e => ({ ...e })) })
  } }
}

// ---- confirmation-stated-v1 ----
export const CONFIRM_SET = 'confirmation-stated-v1'
export const OWN_SAID = '아 그거 다음 주 화요일로 확정했어'
export const OWN_REPLY = '기존 기록에는 일정 미정, 후보는 다음 주 화요일·수요일로 남아 있고, 방금 말씀하신 ‘다음 주 화요일 확정’은 아직 확인 전인 보고로 덧붙어 있어요.'
export const UNSTATED = '네, 알겠어요. 다른 일정도 궁금하시면 말씀해 주세요.'
const NOTE = Object.freeze({ title: '신제품 리뷰 회의 일정', status: 'done', said: OWN_SAID })
export const CONFIRM_CASES = Object.freeze([
  { id: 'rc2-own-yes', wording: 'v2', reply: OWN_REPLY, message: '응 맞아', expect: [p('rc_stated_0', 'min', YES, 'hard', 'v2: the reply mentioned the note, as an unconfirmed report (v1: .19)'), p('rc_confirms_0', 'min', YES, 'hard', 'an explicit yes (v1: .98)'), p('rc_rejects_0', 'max', NO, 'hard', 'not a rejection')] },
  { id: 'rc3-own-yes', wording: 'v3', reply: OWN_REPLY, message: '응 맞아', expect: [p('rc_stated_0', 'min', YES, 'hard', 'v3: the reply refers to the quoted message (v1: .19)'), p('rc_confirms_0', 'min', YES, 'soft', 'an explicit yes'), p('rc_rejects_0', 'max', NO, 'soft', 'not a rejection')] },
  { id: 'rc2-unstated', wording: 'v2', reply: UNSTATED, message: '응 맞아', expect: [p('rc_stated_0', 'max', NOT_YES, 'hard', 'must NOT promote: the reply never mentioned the note')] },
  { id: 'rc3-unstated', wording: 'v3', reply: UNSTATED, message: '응 맞아', expect: [p('rc_stated_0', 'max', NOT_YES, 'hard', 'must NOT promote: the reply never mentioned the note')] },
  { id: 'rc2-thanks', wording: 'v2', reply: OWN_REPLY, message: '고마워', expect: [p('rc_confirms_0', 'max', NOT_YES, 'hard', 'must NOT promote: thanks is not agreement')] },
  { id: 'rc2-reject', wording: 'v2', reply: OWN_REPLY, message: '아니 수요일로 해줘', expect: [p('rc_rejects_0', 'min', YES, 'hard', 'a correction of the reported day'), p('rc_confirms_0', 'max', NO, 'hard', 'not a confirmation')] },
])
async function confirmBody(def) {
  let request = null
  await judgeConfirmation({ message: def.message, previousAnswer: def.reply, records: [NOTE], wording: def.wording, client: { async decide(r) { request = r; return { answers: {} } } }, askedAt: ASKED })
  return { model: DECISION_MODEL, input: request.input, questions: request.questions }
}
export async function buildConfirmationStatedPlan() {
  const a = adder()
  for (const def of CONFIRM_CASES) a.add(def.id, await confirmBody(def), def.expect)
  return finish(CONFIRM_SET, a.requests, a.files, { ...bars(['rc_stated_#', 'rc_confirms_#'], YES, YES - 1e-6, 'egdesk-record-confirmation.mjs CONFIRM_BARS.yes: promote needs a decided yes; under it the note stays pending'), 'rc_rejects_#': { yes: YES, no: NO, source: 'egdesk-record-confirmation.mjs CONFIRM_BARS' } },
    'Every hard check passes: the reply that mentioned the note (in its own words, as unconfirmed) reads as stated under the new wording v2, the reply that never mentioned it does not under v2 or v3, thanks never reaches the confirming bar, a correction is read as rejecting. v3\'s targets are soft except stated. The bars are the product\'s and are not changed here.')
}

// ---- own-wording-v4 ----
export const OWN_SET = 'own-wording-v4'
const OWN_WORDING = { other: 'v2', own: 'v4', guess: 'v2' }
export const OWN_CASES = Object.freeze([
  ...[['t-decision', OWN_SAID, 'the person\'s own decision (own v3: .01, c46)'], ['t-decided2', '그 점검은 목요일로 정했어.', 'another decision, without "내가"'], ['t-fixed', '그 버그는 내가 고쳤어.', 'a v3 target that must stay (study c17)'], ['t-booked', '회의실 예약은 내가 아까 해 뒀어.', 'a v3 target that must stay (study c38)']]
    .map(([id, text, note]) => ({ id, text, expect: [p('speechs_own_0', 'min', SPEECH_SPLIT_BARS.yes, 'hard', note)] })),
  ...[['g-order-record', '주문 내역을 보니 지난달 15일에 결제가 두 번 됐어.', 'read in a record (study c10; v3 .12)'], ['g-conclusion', '서버 응답이 느린 걸 보니 트래픽이 몰린 것 같아.', 'a conclusion (study c12; v3 .06)'],
    ['g-promise', '다음 주 화요일에 고객사에 견적서를 보낼게.', 'a promise for later, not a report of an act (study c04)'], ['g-proposal', '내일 오전 10시에 점검 회의를 하자.', 'a proposal (study c13)'],
    ['g-minutes', '회의록에 따르면 지난 회의에서 출시일을 정했어.', 'a decision read in the minutes (study c16)'], ['g-told', '팀장님 말로는 지난주 금요일에 계약서에 서명했대.', 'told by someone else (study c11)']]
    .map(([id, text, note]) => ({ id, text, expect: [p('speechs_own_0', 'max', SPEECH_SPLIT_BARS.no, 'hard', note)] })),
])
function ownBody(text) {
  const spans = speechSegments(text), questions = speechSplitQuestions(spans, text, { wording: OWN_WORDING }).filter(q => q.name === 'speechs_own_0')
  return { model: DECISION_MODEL, input: [{ role: 'developer', content: SECOND_LABEL_RULES }, { role: 'user', content: `${clockLine(ASKED)}\nMessage:\n${text}` }], questions }
}
export async function buildOwnWordingPlan() {
  const a = adder()
  for (const def of OWN_CASES) a.add(def.id, ownBody(def.text), def.expect)
  return finish(OWN_SET, a.requests, a.files, bars(['speechs_own_#'], SPEECH_SPLIT_BARS.yes, SPEECH_SPLIT_BARS.no, 'egdesk-speech-grounding.mjs SPEECH_SPLIT_BARS (.85 / .15)'),
    'Every hard check passes: the four own acts (the person\'s decision first) reach the split yes bar, the six guards (a record read, a conclusion, a promise, a proposal, minutes, being told) stay under the split no bar. The bars are the product\'s and are not changed here.')
}

// ---- status-question-v1 ----
export const STATUS_SET = 'status-question-v1'
const CATALOG = Object.freeze([
  ['A사 견적 문의 접수', 'past', 'done'], ['A사 첫 견적서(v1) 발송', 'past', 'done'], ['A사 단가 협의 메모', 'past', 'reported_by_other'], ['A사 견적서 v2 수정 계획', 'planned', 'plan'], ['A사 건 결정 메모', 'past', 'done'],
  ['PostgreSQL 전환 설계 문서', 'past', 'done'], ['PostgreSQL 마이그레이션 배포 일정', 'planned', 'plan'], ['헬스체크 3종 체크리스트', 'present', 'done'], ['현재 SQLite 스키마(운영)', 'present', 'done'],
  ['배포 후 후속 체크리스트', 'present', 'plan'], ['롤백 절차', 'present', 'done'], ['전환 벤치마크 결과', 'past', 'done'], ['B사 견적 요청', 'past', 'done']])
export const STATUS_CASES = Object.freeze([
  { id: 's1-quote-status', message: 'A사 견적 지금 어떻게 돼 있어?', expect: [...[0, 1, 3, 4].map(i => p(`rel_${i}`, 'min', 0.5, i === 0 ? 'hard' : 'soft', i === 0 ? 'the page that began the matter ("A사 견적 문의 접수"): .40 under the default rules (L2 c29)' : 'the other A사 pages stay attached (v9 and V1 real runs)')),
    ...[5, 6].map(i => p(`rel_${i}`, 'max', 0.49, 'hard', 'a PostgreSQL page is not about the A사 quote')), p('rel_12', 'max', 0.49, 'hard', 'B사\'s request page looks like the A사 one but is another matter: the rule must not pull it in')] },
  { id: 's2-other-status', message: 'PostgreSQL 전환 지금 어떻게 돼 있어?', expect: [...[0, 1, 2, 3, 4].map(i => p(`rel_${i}`, 'max', 0.49, 'hard', 'a status question about another matter does not pull the A사 pages in')),
    p('rel_5', 'min', 0.5, 'soft', 'the PostgreSQL design page is the matter\'s beginning')] },
])
async function statusBody(def) {
  let request = null
  const candidates = CATALOG.map(([title, timeSlice, status], i) => ({ id: `ontology:c36/${i}`, kind: 'timeline', title, timeSlice, status }))
  await prepareTurnContext({ message: def.message, candidates, ruleSet: 'action+status', cacheScope: 'ctx-c36', askedAt: ASKED, client: { model: 'x', async decide(r) { request = r; return { answers: {}, usage: {} } } } })
  return { model: DECISION_MODEL, input: request.input, questions: request.questions }
}
export async function buildStatusQuestionPlan() {
  const a = adder()
  for (const def of STATUS_CASES) a.add(def.id, await statusBody(def), def.expect)
  return finish(STATUS_SET, a.requests, a.files, { 'rel_#': { yes: 0.5, no: 0.4999, source: 'egdesk-context-setup.mjs thresholds.relevant (.5): an item is attached iff p >= .5' } },
    'Every hard check passes: under the status rule the page that began the A사 matter reaches the attach bar for "지금 어떻게 돼 있어?" (default rules: .40), the PostgreSQL pages do not; the same question about PostgreSQL pulls no A사 page; the request page of B사 stays out. Soft checks are reported.')
}
