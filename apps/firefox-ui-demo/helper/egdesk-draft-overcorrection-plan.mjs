import { createHash } from 'node:crypto'
import { DECISION_MODEL } from './egdesk-decision-client.mjs'
import { DRAFT_CHECK_THRESHOLDS, checkDraft, isCheckable, segmentDraft } from './egdesk-draft-check.mjs'
import { independentEstimate } from './egdesk-decision-real-runner.mjs'
import { lintGroupedRequest } from './egdesk-decision-grouping.mjs'

// PREPARED, NOT SENT. Draft check over-correction (lane L6 cycle 14): in 'on' mode, how often would the check remove or rewrite a
// sentence that is CORRECT (fully supported by the evidence it quotes), and how often would a subtly WRONG sentence pass?
// Bodies: the product's checkDraft (design 'predicates', the default) through a recording client; one request per draft.
// Every sentence's status is registered here before any body is built. Public synthetic Korean, fictional companies.
// What counts as "removed or rewritten": a finding on the sentence, exactly as the product reads it (readPredicateFindings):
//   unverified    sup_i <= 1 - finding (.3) AND the sentence is checkable (a number, a Latin name or identifier: isCheckable)
//   present_tense tense_i >= finding (.7)
// A sentence with a finding is what the product sends back to the writer, or cuts (certain_part) or replaces (ask_user).
export const OVERCORRECTION_SET = 'draft-overcorrection-v1'
export const OVERCORRECTION_DIR = 'proofs/decision-real-measure/draft-overcorrection'
export const OVERCORRECTION_CEILING = 10000
const sha = bytes => createHash('sha256').update(bytes).digest('hex')
const FINDING = DRAFT_CHECK_THRESHOLDS.finding, SUP_NO = Math.round((1 - FINDING) * 1000) / 1000
// The product's bars, from its constant: sup acts ("unsupported") only at <= 1 - finding; tense acts at >= finding.
export const OVERCORRECTION_BARS = Object.freeze({ 'sup_#': { yes: Math.round((SUP_NO + 0.001) * 1000) / 1000, no: SUP_NO }, 'tense_#': { yes: FINDING, no: Math.round((FINDING - 0.001) * 1000) / 1000 } })

const E = (time, status, text) => ({ time, ...(status ? { status } : {}), text })
const QUOTE = [E('past', 'done', '11월 6일 A사에 단가 12,800원으로 견적서 v1을 발송했다.'), E('past', 'reported_by_other', '11월 14일 A사가 단가를 11,900원으로 낮춰 달라고 했다는 내용을 팀장이 전했다. 직접 확인한 것은 아니다.')]
const V2 = [E('planned', 'plan', '견적서 v2는 단가 12,200원, 납기 12월 20일로 보낼 예정이다. 아직 발송하지 않았다.'), E('past', 'done', '11월 18일 회의에서 v2는 팀장 승인 후 발송하기로 결정했다.')]
const SALES = [E('past', 'done', '3분기 매출은 4억 2천만 원으로 2분기보다 8% 늘었다.'), E('planned', 'plan', '4분기 매출 목표는 4억 5천만 원으로 정했다.')]
const VENDOR = [E('past', 'reported_by_other', '협력사 담당자가 납품을 12월 2일로 미루겠다고 메일로 알려 왔다.')]
const AUDIT = [E('past', 'done', '12월 1일에 보안 점검 업체와 계약했다.'), E('planned', 'plan', '보안 점검은 12월 15일부터 사흘 동안 진행한다.'), E('past', 'reported_by_other', '업체 담당자가 점검 기간에는 운영 서버 설정을 바꾸지 말라고 했다.')]
const SERVER = [E('present', null, '결제 서버는 지금 정상 동작 중이며 오류율은 0.3%다.'), E('past', 'done', '어제 오후 3시에 결제 서버를 재시작했다.')]
const DISK = [E('past', 'done', '지난달 말 점검에서 서버 디스크 사용률은 92%였다.')]
const RENEW = [E('past', 'reported_by_other', '팀장 말로는 A사가 계약을 연장할 생각이 있다고 했다. 아직 정해진 것은 없다.')]

// Sized for the 10k bound with room for a 10% under-estimate (Korean bodies ran 5-10% above the estimate): 9 drafts, 19 sentences.
// A wrong draft carries no copy of a correct sentence measured elsewhere (the same sentence on the same evidence is not a new input).
// [id, user request, evidence, sentences: [text, status, kind]]. status: correct | wrong. kind (registered reason):
//   past_fact, plan_as_plan, reported_as_reported, present_fact, no_claim (correct);  plan_as_done, wrong_number,
//   relayed_as_fact, past_as_present (wrong).
export const DRAFTS = Object.freeze([
  ['c-quote', 'A사 견적 진행 상황 알려 줘', [...QUOTE, ...V2], [['견적서 v1은 11월 6일에 단가 12,800원으로 A사에 보냈습니다.', 'correct', 'past_fact'], ['팀장님 말로는 A사가 11월 14일에 단가를 11,900원으로 낮춰 달라고 했다고 합니다.', 'correct', 'reported_as_reported'],
    ['견적서 v2는 단가 12,200원, 납기 12월 20일로 보낼 예정이고 아직 발송 전입니다.', 'correct', 'plan_as_plan'], ['11월 18일 회의에서 팀장 승인 뒤에 보내기로 정했습니다.', 'correct', 'past_fact']]],
  ['c-sales', '3분기 매출 어땠어?', SALES, [['3분기 매출은 4억 2천만 원으로 2분기보다 8% 늘었습니다.', 'correct', 'past_fact'], ['4분기 목표는 4억 5천만 원으로 정해져 있습니다.', 'correct', 'plan_as_plan']]],
  ['c-schedule', '이번 달 납품이랑 보안 점검 일정 정리해 줘', [...VENDOR, ...AUDIT], [['협력사 담당자가 메일로 납품을 12월 2일로 미루겠다고 알려 왔습니다.', 'correct', 'reported_as_reported'], ['12월 1일에 보안 점검 업체와 계약했습니다.', 'correct', 'past_fact'],
    ['점검은 12월 15일부터 사흘 동안 진행할 예정입니다.', 'correct', 'plan_as_plan'], ['업체 담당자는 점검 기간에 운영 서버 설정을 바꾸지 말라고 했습니다.', 'correct', 'reported_as_reported'], ['더 확인할 내용이 있으면 말씀해 주세요.', 'correct', 'no_claim']]],
  ['c-server', '결제 서버 상태 어때?', SERVER, [['결제 서버는 지금 정상이고 오류율은 0.3%입니다.', 'correct', 'present_fact'], ['어제 오후 3시에 한 번 재시작했습니다.', 'correct', 'past_fact']]],
  ['w-v2-done', 'v2 견적 언제 나가?', V2, [['견적서 v2는 단가 12,200원, 납기 12월 20일로 A사에 보냈습니다.', 'wrong', 'plan_as_done']]],
  ['w-sales-number', '3분기 매출 어땠어?', SALES, [['3분기 매출은 4억 2천만 원으로 2분기보다 18% 늘었습니다.', 'wrong', 'wrong_number']]],
  ['w-vendor-fact', '납품 일정 바뀐 거 있어?', VENDOR, [['납품일은 12월 2일로 변경되었습니다.', 'wrong', 'relayed_as_fact']]],
  ['w-disk-now', '서버 디스크 여유 있어?', DISK, [['서버 디스크 사용률은 지금 92%입니다.', 'wrong', 'past_as_present']]],
  ['w-renew-fact', 'A사 계약 연장해?', RENEW, [['A사는 계약을 연장하기로 했습니다.', 'wrong', 'relayed_as_fact'], ['이 내용은 팀장님에게서 들은 것입니다.', 'correct', 'reported_as_reported']]],
].map(([id, userText, evidence, sentences]) => Object.freeze({ id, userText, evidence, sentences: sentences.map(([text, status, kind]) => ({ text, status, kind })) })))

const capture = () => { const seen = []; return { seen, client: { async decide(request) { seen.push(request); return { answers: {}, latencyMs: 0 } } } } }

/** -> { plan, planBytes, files, requests, totals } — deterministic; sends nothing. */
export async function buildOvercorrectionPlan() {
  const requests = [], files = []
  for (const d of DRAFTS) {
    const draft = d.sentences.map(s => s.text).join(' ')
    const claims = segmentDraft(draft).filter(s => s.kind === 'claim').map(s => s.text.trim())
    if (claims.join('|') !== d.sentences.map(s => s.text).join('|')) throw new Error(`${d.id}: the product splits this draft differently: ${claims.join(' | ')}`)
    const c = capture()
    await checkDraft({ draft, evidence: d.evidence, userText: d.userText, mode: 'on', client: c.client, design: 'predicates' })
    if (c.seen.length !== 1) throw new Error(`${d.id}: expected one check request, got ${c.seen.length}`)
    const { input, questions } = c.seen[0]
    if (questions.some(q => !/^(sup|tense)_\d+$/.test(q.name))) throw new Error(`${d.id}: unexpected question ${questions.map(q => q.name).join(',')}`)
    const body = { model: DECISION_MODEL, input, questions, prompt_cache_key: 'draft-check' }
    if (!lintGroupedRequest(body).ok) throw new Error(`${d.id}: the grouped-question lint fails`)
    const bytes = Buffer.from(JSON.stringify(body), 'utf8')
    const expect = d.sentences.flatMap((s, i) => {
      const checkable = isCheckable(s.text)
      if (s.status === 'correct') return [
        ...(checkable ? [{ name: `sup_${i}`, kind: 'predicate', min: OVERCORRECTION_BARS['sup_#'].yes, severity: 'hard', note: `CORRECT ${s.kind}: not judged unsupported (a finding would remove or rewrite it)` }] : []),
        { name: `tense_${i}`, kind: 'predicate', max: OVERCORRECTION_BARS['tense_#'].no, severity: 'hard', note: `CORRECT ${s.kind}: no tense finding` },
        { name: `sup_${i}`, kind: 'predicate', min: 0.8, severity: 'soft', note: `CORRECT ${s.kind}: decided supported${checkable ? '' : ' (not checkable: a low value would not act)'}` }]
      const viaTense = s.kind === 'plan_as_done' || s.kind === 'past_as_present' || (s.kind === 'relayed_as_fact' && !checkable)
      return [viaTense
        ? { name: `tense_${i}`, kind: 'predicate', min: OVERCORRECTION_BARS['tense_#'].yes, severity: 'hard', note: `WRONG ${s.kind}: caught as a tense finding${checkable ? '' : ' (not checkable: tense is the only way the product can catch it)'}` }
        : { name: `sup_${i}`, kind: 'predicate', max: OVERCORRECTION_BARS['sup_#'].no, severity: 'hard', note: `WRONG ${s.kind}: judged unsupported` },
        viaTense && checkable ? { name: `sup_${i}`, kind: 'predicate', max: OVERCORRECTION_BARS['sup_#'].no, severity: 'soft', note: `WRONG ${s.kind}: also unsupported` }
          : { name: `tense_${i}`, kind: 'predicate', max: 1, severity: 'soft', note: `WRONG ${s.kind}: recorded` }].filter(e => !(e.kind === 'predicate' && e.max === 1))
    })
    const file = `requests/${d.id}.json`
    files.push({ file, bytes })
    requests.push({ id: d.id, file, sha256: sha(bytes), estInputTokens: independentEst(bytes, questions.length), expect })
  }
  const plan = { set: OVERCORRECTION_SET, tokenCeiling: OVERCORRECTION_CEILING,
    productBars: Object.fromEntries(Object.entries(OVERCORRECTION_BARS).map(([k, v]) => [k, { ...v, source: k === 'sup_#' ? 'egdesk-draft-check.mjs readPredicateFindings: unsupported iff p <= 1 - DRAFT_CHECK_THRESHOLDS.finding (declared .001 above it)' : 'egdesk-draft-check.mjs: a tense finding iff p >= DRAFT_CHECK_THRESHOLDS.finding' }])),
    passRule: 'A study: every sentence was registered CORRECT or WRONG before the bodies were built. A hard check fails when a CORRECT sentence would get a finding (the product would remove or rewrite it) or a WRONG one would pass. ' +
      'The outcome is the per-sentence rates from scripts/egdesk-draft-overcorrection-plan.mjs analyze, which replays the real answers through the product\'s checkDraft (on mode).',
    requests }
  const total = requests.reduce((s, r) => s + r.estInputTokens, 0)
  if (total > OVERCORRECTION_CEILING) throw new Error(`the plan estimates ${total} input tokens, over ${OVERCORRECTION_CEILING}`)
  return { plan, planBytes: Buffer.from(JSON.stringify(plan, null, 2) + '\n'), files, requests, totals: { requests: requests.length, estInputTokens: total,
    correct: DRAFTS.flatMap(d => d.sentences).filter(s => s.status === 'correct').length, wrong: DRAFTS.flatMap(d => d.sentences).filter(s => s.status === 'wrong').length } }
}
const independentEst = (bytes, predicates) => independentEstimate(0, predicates, bytes.length)

/** Replay the real answers through the product's checkDraft ('on', no rewriter) and count per sentence. results: runner results map. */
export async function analyzeOvercorrection(results) {
  const rows = []
  for (const d of DRAFTS) {
    const r = results?.[d.id]
    if (r?.status !== 200) { for (const s of d.sentences) rows.push({ id: d.id, ...s, answered: false }); continue }
    const answers = Object.fromEntries((r.answers || []).map(a => [a.name, a]))
    const replay = await checkDraft({ draft: d.sentences.map(s => s.text).join(' '), evidence: d.evidence, userText: d.userText, mode: 'on', design: 'predicates',
      client: { async decide() { return { answers, latencyMs: 0 } } } })
    d.sentences.forEach((s, i) => rows.push({ id: d.id, ...s, answered: true, checkable: isCheckable(s.text), sup: answers[`sup_${i}`]?.probability ?? null, tense: answers[`tense_${i}`]?.probability ?? null,
      findings: replay.findings.filter(f => f.span === i).map(f => f.kind), outcome: replay.outcome }))
  }
  const ans = rows.filter(r => r.answered)
  const correct = ans.filter(r => r.status === 'correct'), wrong = ans.filter(r => r.status === 'wrong')
  const flagged = r => r.findings.length > 0
  const byKind = list => Object.fromEntries([...new Set(list.map(r => r.kind))].map(k => [k, { n: list.filter(r => r.kind === k).length, flagged: list.filter(r => r.kind === k && flagged(r)).length }]))
  return { answered: ans.length, missing: rows.length - ans.length,
    correct: { n: correct.length, removedOrRewritten: correct.filter(flagged).length, byKind: byKind(correct) },
    wrong: { n: wrong.length, passed: wrong.filter(r => !flagged(r)).length, byKind: byKind(wrong) },
    drafts: DRAFTS.map(d => ({ id: d.id, outcome: rows.find(r => r.id === d.id)?.outcome ?? null })), rows }
}
