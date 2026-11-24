import { createHash } from 'node:crypto'
import { DECISION_MODEL } from './egdesk-decision-client.mjs'
import { judgeConfirmation } from './egdesk-record-confirmation.mjs'

// The real measurement of the conversational confirmation (two yes/no readings of the person's message, plus whether the previous reply
// stated the note) as a DECLARATIVE plan for the generic runner (scripts/egdesk-decision-real-measure.mjs). Nothing here sends anything.
// The nine cases are the ones simulated in L7 c15 (confirmation-simulation.json); every body is built by judgeConfirmation itself through a
// recording client. Expectations are registered here, before any call. Public synthetic Korean text only.
export const CONFIRMATION_SET = 'record-confirmation-predicates-v1'
const estimate = (choice, predicate, bytes) => Math.round(56.5 * choice + 134.8 * predicate + 0.1983 * bytes) // the typed model of 2026-11-24
const sha = bytes => createHash('sha256').update(bytes).digest('hex')
const NOTE = Object.freeze([{ title: 'PostgreSQL 마이그레이션 배포 계획', status: 'done' }])
export const STATED_REPLY = 'PostgreSQL 마이그레이션 배포 계획은 완료로 적어 둘게요. 헬스체크는 응답 시간부터 보세요.'
export const UNSTATED_REPLY = '헬스체크는 응답 시간부터 보세요. 그렇게 진행할까요?'

const p = (name, bound, value, severity, note) => ({ name, kind: 'predicate', [bound]: value, severity, note })
// Promotion needs all three: stated >= 0.8, confirms >= 0.8, rejects <= 0.2. "Must not promote" is therefore registered on the question
// that decides it: a value below the yes bar (max 0.79) cannot promote whatever the others say.
const NOT_YES = 0.79
const mustNotPromote = note => p('rc_confirms_0', 'max', NOT_YES, 'hard', `must NOT promote: ${note}`)
export const CONFIRMATION_CASES = Object.freeze([
  { id: 'c1-yes-right', message: '응, 맞아.', reply: 'stated', outcome: 'promote', expect: [
    p('rc_stated_0', 'min', 0.8, 'hard', 'the reply said "완료로 적어 둘게요"'), p('rc_confirms_0', 'min', 0.8, 'hard', 'an explicit yes to the stated note'), p('rc_rejects_0', 'max', 0.2, 'hard', 'not a rejection')] },
  { id: 'c2-do-so', message: '그래, 그렇게 해.', reply: 'stated', outcome: 'promote', expect: [
    p('rc_confirms_0', 'min', 0.8, 'soft', '"그렇게 해" may be read as about the advice in the same reply; promotion here is wanted, not required'), p('rc_rejects_0', 'max', 0.2, 'hard', 'not a rejection')] },
  { id: 'c3-not-yet', message: '아니, 아직 스테이징만 끝났어.', reply: 'stated', outcome: 'revert', expect: [
    p('rc_rejects_0', 'min', 0.8, 'hard', 'it is not done yet: the note is rejected'), p('rc_confirms_0', 'max', 0.2, 'hard', 'not a confirmation')] },
  { id: 'c4-do-not-record', message: '그거 기록하지 마.', reply: 'stated', outcome: 'revert', expect: [
    p('rc_rejects_0', 'min', 0.8, 'hard', 'do not record it'), p('rc_confirms_0', 'max', 0.2, 'hard', 'not a confirmation')] },
  { id: 'c5-next-question', message: '그럼 롤백 조건은 뭐였지?', reply: 'stated', outcome: 'keep', expect: [
    mustNotPromote('a new question is not agreement'), p('rc_confirms_0', 'max', 0.2, 'soft', 'a decided no, as expected'), p('rc_rejects_0', 'max', 0.2, 'soft', 'nor a rejection')] },
  { id: 'c6-thanks', message: '고마워', reply: 'stated', outcome: 'keep', expect: [
    mustNotPromote('thanks is not agreement (no promotion on silence)'), p('rc_confirms_0', 'max', 0.2, 'soft', 'a decided no, as expected'), p('rc_rejects_0', 'max', 0.2, 'soft', 'nor a rejection')] },
  { id: 'c7-hesitation', message: '음...', reply: 'stated', outcome: 'keep', expect: [
    mustNotPromote('a hesitation is not agreement'), p('rc_rejects_0', 'max', NOT_YES, 'soft', 'and should not withdraw the note either')] },
  { id: 'c8-yes-to-other-question', message: '응, 맞아.', reply: 'unstated', outcome: 'keep', expect: [
    p('rc_stated_0', 'max', NOT_YES, 'hard', 'must NOT promote: the reply never told the person about the note (its "응" answers the reply\'s own question)'),
    p('rc_stated_0', 'max', 0.2, 'soft', 'a decided no, as expected')] },
  { id: 'c9-object-unstated', message: '아니, 그거 기록하지 마.', reply: 'unstated', outcome: 'revert', expect: [
    p('rc_stated_0', 'max', NOT_YES, 'hard', 'the reply did not state the note'), p('rc_confirms_0', 'max', 0.2, 'hard', 'not a confirmation'),
    p('rc_rejects_0', 'min', 0.8, 'soft', '"그거" may or may not be read as the note when it was not mentioned; withdrawing is wanted, not required')] },
])
export const CONFIRMATION_PASS_RULE = 'Every request passes (no failed hard check): explicit agreement with a stated note confirms it; "not yet" and "do not record it" reject it; '
  + 'a new question, thanks, a hesitation, or a yes to a reply that never stated the note can never promote it (the confirming reading stays below the 0.8 yes bar, or the stated reading does). '
  + 'Soft checks (decided no where a no is expected, the paraphrased yes, the objection to an unstated note) are reported, not required. The bars are the product\'s and are not changed here.'

async function bodyOf(def) {
  let request = null
  await judgeConfirmation({ message: def.message, previousAnswer: def.reply === 'stated' ? STATED_REPLY : UNSTATED_REPLY, records: NOTE,
    client: { async decide(r) { request = r; return { answers: {} } } }, askedAt: Date.parse('2026-11-24T14:30:00+09:00') })
  if (!request) throw new Error(`${def.id}: no request was built`)
  return { model: DECISION_MODEL, input: request.input, questions: request.questions }
}

/** -> { plan, files: [{ file, bytes }], estInputTokens }. Deterministic: the same code gives the same bytes. */
export async function buildConfirmationPlan() {
  const requests = [], files = []
  for (const def of CONFIRMATION_CASES) {
    const body = await bodyOf(def), bytes = Buffer.from(JSON.stringify(body), 'utf8')
    const names = new Set(body.questions.map(q => q.name))
    for (const e of def.expect) if (!names.has(e.name)) throw new Error(`${def.id}: no question named ${e.name}`)
    const file = `requests/${def.id}.json`
    files.push({ file, bytes })
    requests.push({ id: def.id, file, sha256: sha(bytes), estInputTokens: estimate(0, body.questions.length, bytes.length), expect: def.expect.map(e => ({ ...e })) })
  }
  const total = requests.reduce((n, r) => n + r.estInputTokens, 0)
  return { plan: { set: CONFIRMATION_SET, tokenCeiling: Math.ceil(total * 1.15 / 100) * 100, passRule: CONFIRMATION_PASS_RULE, requests }, files, estInputTokens: total }
}
