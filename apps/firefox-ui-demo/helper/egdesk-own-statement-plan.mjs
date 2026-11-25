import { createHash } from 'node:crypto'
import { DECISION_MODEL } from './egdesk-decision-client.mjs'
import { judgeConfirmation } from './egdesk-record-confirmation.mjs'
import { SPEECH_SPLIT_BARS, speechHybridSecondQuestions, speechSegments } from './egdesk-speech-grounding.mjs'
import { SECOND_LABEL_RULES } from './egdesk-turn-memory.mjs'
import { clockLine } from './egdesk-wiki-reconstruction.mjs'

// own-statement-v1 (L7 c35). PREPARED, NOT SENT; nothing here sends or reads a key. The two questions the real write run check-20mw got wrong for a person's own decision:
//  rc-*   the confirmation with the note quoted WITH the person's own words (noteQuote with `said`): 3 predicates per request. Real case: the reply of turn 3 ("…'다음 주 화요일 확정'은 아직 확인 전인
//         보고로 덧붙어 있어요."), the person's "응 맞아": with the old quote stated .09, confirms .01, rejects .01. HARD: explicit agreement is read as stated and confirming, "not so" as rejecting, thanks
//         and a reply that never mentioned the note can never promote (stated or confirms under the yes bar).
//  src-*  the second request of the 'hybrid-two-step-ask' design: the source split predicates for a sentence whose axes request said "unspecified" (own v3 wording, the product's choice). HARD: the
//         first-person decision's own >= .85 (the split bar); a plain fact that says nothing about who did or saw anything: own <= .15 (the past-fact guard 'src-past-fact' was left out to stay at 5k).
// Bodies are the product's own (judgeConfirmation through a recording client; speechHybridSecondQuestions with the axes answers of the real run), so what is sent is what the product would send.
export const OWN_STATEMENT_SET = 'own-statement-v1'
const estimate = (choice, predicate, bytes) => Math.round(56.5 * choice + 134.8 * predicate + 0.1983 * bytes)
const sha = bytes => createHash('sha256').update(bytes).digest('hex')
const ASKED = Date.parse('2026-11-24T14:30:00+09:00')
export const OWN_SAID = '아 그거 다음 주 화요일로 확정했어'
export const OWN_REPLY = '기존 기록에는 일정 미정, 후보는 다음 주 화요일·수요일로 남아 있고, 방금 말씀하신 ‘다음 주 화요일 확정’은 아직 확인 전인 보고로 덧붙어 있어요.'
export const UNSTATED = '네, 알겠어요. 다른 일정도 궁금하시면 말씀해 주세요.'
const NOTE = Object.freeze({ title: '신제품 리뷰 회의 일정', status: 'done', said: OWN_SAID })
const p = (name, bound, value, severity, note) => ({ name, kind: 'predicate', [bound]: value, severity, note })
const NOT_YES = 0.79, YES = 0.8, NO = 0.2
export const RC_CASES = Object.freeze([
  { id: 'rc-own-yes', reply: OWN_REPLY, message: '응 맞아', expect: [p('rc_stated_0', 'min', YES, 'hard', 'the reply told the person what was noted, in its own words (check-20mw: .09 with the old quote)'),
    p('rc_confirms_0', 'min', YES, 'hard', 'an explicit yes to it (check-20mw: .01)'), p('rc_rejects_0', 'max', NO, 'hard', 'not a rejection (check-20mw: .01)')] },
  { id: 'rc-own-reject', reply: OWN_REPLY, message: '아니 수요일로 해줘', expect: [p('rc_rejects_0', 'min', YES, 'hard', 'a correction of the reported day'), p('rc_confirms_0', 'max', NO, 'hard', 'not a confirmation')] },
  { id: 'rc-own-thanks', reply: OWN_REPLY, message: '고마워', expect: [p('rc_confirms_0', 'max', NOT_YES, 'hard', 'must NOT promote: thanks is not agreement')] },
  { id: 'rc-own-unstated', reply: UNSTATED, message: '응 맞아', expect: [p('rc_stated_0', 'max', NOT_YES, 'hard', 'must NOT promote: the reply never mentioned the note (its "응" answers something else)')] },
])
export const SRC_CASES = Object.freeze([
  { id: 'src-own-decision', text: OWN_SAID, form: 'assertion', time: 'future_anchored', expect: [p('speechs_own_0', 'min', SPEECH_SPLIT_BARS.yes, 'hard', 'the person\'s own act: decided it (own v3: "personally … did")'),
    p('speechs_other_0', 'max', SPEECH_SPLIT_BARS.no, 'soft', 'not credited to anyone else'), p('speechs_record_0', 'max', SPEECH_SPLIT_BARS.no, 'soft', 'not read from a record'), p('speechs_guess_0', 'max', SPEECH_SPLIT_BARS.no, 'soft', 'not a conclusion')] },
  { id: 'src-plain-fact', text: '그 서버는 3번 랙에 있어.', form: 'assertion', time: 'at_utterance', expect: [p('speechs_own_0', 'max', SPEECH_SPLIT_BARS.no, 'hard', 'a fact that does not say how the speaker knows it: no (the guard of the change)')] },
])

async function rcBody(def) {
  let request = null
  await judgeConfirmation({ message: def.message, previousAnswer: def.reply, records: [NOTE], client: { async decide(r) { request = r; return { answers: {} } } }, askedAt: ASKED })
  if (!request) throw new Error(`${def.id}: no request was built`)
  return { model: DECISION_MODEL, input: request.input, questions: request.questions }
}
const choice = (value, c) => ({ type: 'choice', choice: value, confidence: c, probabilities: [{ value, probability: c }, { value: 'unknown', probability: 1 - c }] })
function srcBody(def) {
  const spans = speechSegments(def.text)
  // the axes request's answer as the real run got it: source unspecified (installed), form and time installed
  const axes = { speech_source_0: choice('unspecified', 0.93), speech_form_0: choice(def.form, 0.95), speech_time_0: choice(def.time, 0.93) }
  const questions = speechHybridSecondQuestions(axes, spans, def.text, { wording: 'v2', askUnspecified: true })
  return { model: DECISION_MODEL, input: [{ role: 'developer', content: SECOND_LABEL_RULES }, { role: 'user', content: `${clockLine(ASKED)}\nMessage:\n${def.text}` }], questions }
}
export const OWN_STATEMENT_PASS_RULE = 'Every hard check passes. rc-*: explicit agreement with a note that the reply told is read as stated and confirming; "not so" as rejecting; thanks and a reply that never mentioned the note never reach the yes bar. '
  + 'src-*: the first-person decision\'s own predicate reaches the split yes bar (.85), the plain fact stays under the split no bar (.15). Soft checks are reported. The bars are the product\'s and are not changed here.'

/** -> { plan, files, estInputTokens }. Deterministic. */
export async function buildOwnStatementPlan() {
  const requests = [], files = []
  const add = (def, body) => {
    const bytes = Buffer.from(JSON.stringify(body), 'utf8'), names = new Set(body.questions.map(q => q.name))
    for (const e of def.expect) if (!names.has(e.name)) throw new Error(`${def.id}: no question named ${e.name}`)
    const file = `requests/${def.id}.json`
    files.push({ file, bytes })
    requests.push({ id: def.id, file, sha256: sha(bytes), estInputTokens: estimate(0, body.questions.length, bytes.length), expect: def.expect.map(e => ({ ...e })) })
  }
  for (const def of RC_CASES) add(def, await rcBody(def))
  for (const def of SRC_CASES) add(def, srcBody(def))
  const total = requests.reduce((n, r) => n + r.estInputTokens, 0)
  return { plan: { set: OWN_STATEMENT_SET, tokenCeiling: Math.ceil(total * 1.15 / 100) * 100,
    // promotion needs a decided yes of rc_stated and of rc_confirms (anything under the yes bar keeps the note pending: a yes-only bar); a revert needs rc_rejects decided (both bars)
    productBars: { ...Object.fromEntries(['rc_stated_#', 'rc_confirms_#'].map(k => [k, { yes: YES, no: YES - 1e-6, source: 'egdesk-record-confirmation.mjs CONFIRM_BARS.yes: promote needs a decided yes; anything under it keeps the note pending' }])),
      'rc_rejects_#': { yes: YES, no: NO, source: 'egdesk-record-confirmation.mjs CONFIRM_BARS (between: keep pending)' },
      ...Object.fromEntries(['speechs_own_#', 'speechs_other_#', 'speechs_record_#', 'speechs_guess_#'].map(k => [k, { yes: SPEECH_SPLIT_BARS.yes, no: SPEECH_SPLIT_BARS.no, source: 'egdesk-speech-grounding.mjs SPEECH_SPLIT_BARS (.85 / .15)' }])) },
    passRule: OWN_STATEMENT_PASS_RULE, requests }, files, estInputTokens: total }
}
