// Lane L4 cycle 49: does the way a coverage fact is QUOTED decide the judge? L2's V2 analysis (reports/l2-c37.md section s3): the scripted answer "A사 견적은 11월 3일 요청 접수, 11월 6일 v1 발송 순서이고,
// v2는 팀장 승인 후 발송할 예정입니다." is split at its commas into three facts; F2 reaches the judge as "11월 6일 v1 발송 순서이고" and is judged .29 on a board that shows "11월 6일 ... 견적서 v1을 발송했다"
// (twice, so the one redesign could not help and the board fell back to chat). Two readings: the TRAILING CONNECTIVE ("이고") makes an unnatural fragment (then the splitter should trim it), or the
// NOUN ("순서": it claims an order) does. The recorded V1 draw argues against the first: its fact "11월 6일에 v1을 보냈으며" kept its connective and was judged 1.0. This plan measures it on the
// recorded V2 request itself (same board, same question wording, the facts' names by index as the product writes them): the recorded fact, the connective trimmed, the natural noun phrase,
// and the V1-style clause with its connective. It sends nothing; Main sends it. No product code changes until the answers are in (a trim would also cut "…받았고" to "…받았", a broken verb).
import { createHash } from 'node:crypto'
import { SKELETON_BARS } from './egdesk-briefing-skeleton.mjs'
import { DECISION_MODEL } from './egdesk-decision-client.mjs'
import { estimateBodyTokens } from './egdesk-decision-real-runner.mjs'
import { layerProductBars } from './egdesk-briefing-layer-replay.mjs'
import { V2_S3_COVERAGE, V2_S3_COVERAGE_SHA } from './egdesk-briefing-fact-wording.fixture.mjs'

export const FACT_WORDING_SET = 'l4-briefing-fact-wording'
export const FACT_WORDING_DIR = 'proofs/decision-real-measure/briefing-fact-wording'
export const FACT_WORDING_CEILING = 3000
const sha = bytes => createHash('sha256').update(bytes).digest('hex')
const QUOTE = /(quoted exactly as a JSON string: )("(?:[^"\\]|\\.)*")(\. Is this fact shown)/
/** The wordings of the one fact, each the way the splitter could hand it to the judge. */
export const FACT_VARIANTS = Object.freeze([
  { id: 'recorded', fact: '11월 6일 v1 발송 순서이고', note: 'as the product quoted it in the V2 draw (c60): .29 in both coverage requests' },
  { id: 'connective-trimmed', fact: '11월 6일 v1 발송 순서', note: 'the trailing connective cut, the noun kept ("순서" still claims an order)' },
  { id: 'natural-fragment', fact: '11월 6일 v1 발송', note: 'the natural noun phrase L2 suggests' },
  { id: 'v1-clause', fact: '11월 6일에 v1을 보냈으며', note: 'the V1 draw\'s clause WITH its connective (c59: 1.0 on V1\'s board)' },
])
/** The recorded request with its facts replaced: the board, the developer line and the question wording are the recorded bytes; each question is the recorded F2 question with another quoted fact. */
export function buildFactWordingWire() {
  const body = JSON.parse(V2_S3_COVERAGE), template = body.questions.find(q => q.name === 'onboard_F2')
  if (!template || !QUOTE.test(template.instructions)) throw new Error('fact wording: the recorded question is not the expected shape')
  const make = (name, fact) => ({ ...template, name, instructions: template.instructions.replace(QUOTE, (_m, a, _q, c) => `${a}${JSON.stringify(fact)}${c}`) })
  if (JSON.stringify(make('onboard_F2', '11월 6일 v1 발송 순서이고')) !== JSON.stringify(template)) throw new Error('fact wording: the rebuilt question differs from the recorded one')
  const wire = JSON.stringify({ ...body, questions: FACT_VARIANTS.map((v, i) => make(`onboard_F${i + 1}`, v.fact)) })
  return wire
}
/** -> { plan, planBytes, files, requests, totals } — deterministic; sends nothing. */
export function buildFactWordingPlan() {
  if (sha(Buffer.from(V2_S3_COVERAGE, 'utf8')) !== V2_S3_COVERAGE_SHA) throw new Error('fact wording: the fixture is not the recorded request')
  const wire = buildFactWordingWire(), bytes = Buffer.from(wire, 'utf8'), body = JSON.parse(wire)
  if (body.model !== DECISION_MODEL || Object.keys(body).some(k => !['model', 'input', 'questions', 'prompt_cache_key'].includes(k)) || body.questions.some(q => q.type !== 'predicate')) throw new Error('fact wording: not a plain predicate body')
  const YES = { min: SKELETON_BARS.yes }, mk = (severity, name, rest, note) => ({ name, kind: 'predicate', ...rest, severity, note })
  const notNo = (name, note) => ({ name, kind: 'predicate', notDecidedNo: true, severity: 'hard', note })
  const expect = FACT_VARIANTS.flatMap((v, i) => {
    const name = `onboard_F${i + 1}`
    return v.id === 'natural-fragment' || v.id === 'v1-clause'
      ? [notNo(name, `${v.note}. The board shows "11월 6일 단가 12,800원으로 견적서 v1을 발송했다": a decided no (p <= .3) would start the product's re-design for a fact that is on the board`), mk('soft', name, YES, 'shown (yes >= .7)')]
      : [mk('soft', name, YES, `${v.note}: recorded, not a pass condition (the question is whether the wording moves the judge)`)]
  })
  const request = { id: 'fact-wording', file: 'requests/fact-wording.json', sha256: sha(bytes), estInputTokens: estimateBodyTokens(wire), expect }
  const plan = { set: FACT_WORDING_SET, tokenCeiling: FACT_WORDING_CEILING, productBars: Object.fromEntries(['onboard_F#'].map(f => [f, layerProductBars()[f]])),
    passRule: 'PASS when the natural noun phrase and the V1-style clause are not judged decided-not-shown (p > .3) on the recorded V2 board. The recorded fact and its connective-trimmed form are recorded: compare them with the other two (connective vs noun). Decision rule: if the trimmed form is judged yes (>= .7) while the recorded one stays under .3, the connective is the cause (trim copular endings in factUnits); if both stay low while the natural fragment is high, the noun is the cause (the answer\'s own wording; no splitter change); if the V1-style clause is high, a connective alone is not the cause.',
    requests: [request] }
  return { plan, planBytes: Buffer.from(JSON.stringify(plan, null, 2) + '\n'), files: [{ file: request.file, bytes }], requests: [request], totals: { requests: 1, questions: body.questions.length, bytes: bytes.length, estInputTokens: request.estInputTokens } }
}
