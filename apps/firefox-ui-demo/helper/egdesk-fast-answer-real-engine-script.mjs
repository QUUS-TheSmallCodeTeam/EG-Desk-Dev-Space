// L1 c31: the conversation script that measures the fast answer (helper/egdesk-memory-fast-answer.mjs) against the engine, built here and committed as JSON under
// scripts/real-engine/scripts/ (a test keeps the file equal to what this builds). SYNTHETIC pages: L7's server-backup retention record and its two decoys, plus a scheduled visit and an
// undecided dinner. Needs --decisions: the Decision model picks the record and judges the sentences. Run (the engine and the fast path answer the SAME question in two conversations):
//   node scripts/egdesk-real-engine-check.mjs --run --codex-bin <bin> --person-home --decisions --out <dir> --script scripts/real-engine/scripts/real-engine-memory-fast-answer-v1.json
//   node scripts/egdesk-fast-answer-compare.mjs <dir>        # seconds and answer facts, engine vs fast path, one row per question
import { DECOYS, RETENTION } from './egdesk-memory-real-engine-scripts.mjs'
import { FAST_FLAG } from './egdesk-real-engine-fast-answer.mjs'

export const FAST_ANSWER_SET = 'real-engine-memory-fast-answer-v1'
export const FAST_QUESTION = '지난번 점검 회의에서 서버 백업을 며칠 보관하기로 정했는지 알려줘.'
export const FAST_SENTENCE = RETENTION.body.split('. ')[0] + '.' // the record's first sentence: the one that answers the question
export const VISIT = Object.freeze({ id: 'visit/inspection', title: '고객사 설비 점검 방문 일정', time: 'planned', status: 'plan',
  body: '고객사 설비 점검 방문은 11월 19일 화요일 오후 2시로 확정했다. 담당자는 박 대리다.' })
export const VISIT_QUESTION = '고객사 설비 점검 방문이 언제로 잡혔는지 알려줘.'
export const VISIT_SENTENCE = VISIT.body.split('. ')[0] + '.'
export const DINNER = Object.freeze({ id: 'office/dinner', title: '12월 회식 장소', time: 'hypothetical', status: 'plan', body: '12월 회식 장소는 아직 정하지 못했고, 후보는 두 곳이다.' })
export const COMPUTE_QUESTION = '백업을 47일 보관하기로 했으면, 11월 5일에 만든 백업은 몇 월 며칠에 지워지는지 날짜를 계산해서 알려줘.'
export const WHOLE_QUESTION = '지난번 점검 회의에서 백업에 대해 정한 것을 전부 알려줘.'
export const DINNER_QUESTION = '12월 회식 장소는 어디로 정했지?'
export const FAST_ANSWER_QUESTIONS = Object.freeze([FAST_QUESTION, COMPUTE_QUESTION, WHOLE_QUESTION, DINNER_QUESTION, VISIT_QUESTION])
const page = p => ({ id: p.id, title: p.title, body: p.body, time: p.time, status: p.status })
const PAGES = [page(RETENTION), page(VISIT), page(DINNER), ...DECOYS.map(page)]
const on = { [FAST_FLAG]: 'on' }
const conv = (id, flags, turns) => ({ id, ...(flags ? { flags } : {}), memory: { mode: 'on', pages: PAGES }, turns })
const base = { posted: true, noNativeTools: true, turnStatus: 'completed' }

export function buildFastAnswerScript() {
  return { set: FAST_ANSWER_SET,
    description: 'Pattern: a question that one sentence of a stored record answers, asked with the fast answer off (the engine writes the answer) and on (code posts the record\'s sentence, no engine turn). Six conversations over the same synthetic pages (a server-backup retention record, a scheduled visit, an undecided dinner, two decoys): fast-off and fast-on ask the same question and are compared on seconds and on the answer\'s facts (47 days, and not the record\'s other fact); fast-on turn 2 asks what the person asked a moment ago, which only the carried exchange can tell the engine (the engine never saw turn 1); fast-compute, fast-whole and fast-dinner are questions the fast path must leave to the engine (a calculation, two answering sentences, a record whose time is hypothetical: a code floor, time_unsettled, or the loop\'s own status reading disagreeing with the record, status_read_differs; either way no Decision request); fast-visit is a scheduled line (a recalled plan). Needs --decisions. The reasons are the Decision model\'s own reading: a real model that reads a question differently fails the expectation, and that is the finding.',
    conversations: [
      conv('fast-off', null, [{ say: FAST_QUESTION, expect: { ...base, answerIncludes: [RETENTION.days], answerExcludes: ['자동 삭제'], memory: { attached: [RETENTION.id] }, fastAnswer: { used: false } } }]),
      conv('fast-on', on, [
        { say: FAST_QUESTION, expect: { ...base, answerIncludes: [RETENTION.days], answerExcludes: ['자동 삭제'], fastAnswer: { used: true, answerIs: FAST_SENTENCE, maxSeconds: 8 } } },
        { say: '방금 내가 뭘 물어봤더라? 한 문장으로만 알려줘.', expect: { posted: true, noNativeTools: true, turnStatus: 'completed', answerIncludes: ['백업'], fastAnswer: { used: false } } }]),
      conv('fast-compute', on, [{ say: COMPUTE_QUESTION, expect: { ...base, answerIncludes: ['12월 22일'], fastAnswer: { used: false, reason: ['needs_more_than_a_sentence', 'no_sentence_is_the_answer', 'sentence_needs_context'] } } }]),
      conv('fast-whole', on, [{ say: WHOLE_QUESTION, expect: { ...base, answerIncludes: [RETENTION.days, '복원'], fastAnswer: { used: false, reason: ['several_sentences', 'needs_more_than_a_sentence', 'another_sentence_unsure'] } } }]),
      conv('fast-dinner', on, [{ say: DINNER_QUESTION, expect: { ...base, answerIncludes: ['아직'], fastAnswer: { used: false, reason: ['time_unsettled', 'status_read_differs'], noDecisionCall: true } } }]),
      conv('fast-visit', on, [{ say: VISIT_QUESTION, expect: { ...base, answerIncludes: ['19일'], answerExcludes: ['박 대리'], fastAnswer: { used: true, answerIs: VISIT_SENTENCE, maxSeconds: 8 } } }]),
    ] }
}
