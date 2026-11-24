import { createHash } from 'node:crypto'
import { DECISION_MODEL } from './egdesk-decision-client.mjs'
import { prepareTurnContext } from './egdesk-context-setup.mjs'
import { DECISION_IDLE_MS } from './egdesk-decision-transport.mjs'
import { independentEstimate } from './egdesk-decision-real-runner.mjs'
import { TURN_CONTEXT_BUDGET_MS, TURN_CONTEXT_COLD_BUDGET_MS } from './codex-chat-runtime.mjs'

// PREPARED, NOT SENT. Cold vs warm latency of the turn-context request (lane L6 cycle 14). The same product-built turn_context request
// shape (prepareTurnContext through a recording client: one catalog, a different short message each time, so the catalog prefix is the
// conversation's cached prefix as in the product and no two bodies are identical) is sent through the PRODUCT's Decisions transport:
//   a  the first request of a fresh process (no socket yet: cold)
//   b  immediately after a       (a kept-alive socket should be free: warm)
//   c  20 s after b               (inside the 55 s idle window: warm)
//   d  70 s after c               (past DECISION_IDLE_MS: the socket was dropped, cold again)
// Two repetitions, each its own run (each must be a fresh process for "a"): rep-1/plan.json, rep-2/plan.json. Record only: the answers
// are not the point; the runner records elapsedMs, warmBefore (the product's own warm() just before the send), socket reuse and phases.
export const LATENCY_SET = 'turn-context-latency-v1'
export const LATENCY_DIR = 'proofs/decision-real-measure/turn-context-latency'
export const LATENCY_CEILING = 6000
export const CONDITIONS = Object.freeze([['a-first', 0, 'first request of a fresh process'], ['b-immediate', 0, 'immediately after a'], ['c-after-20s', 20_000, '20 s idle'], ['d-after-70s', 70_000, `70 s idle (past the ${DECISION_IDLE_MS / 1000} s transport idle window)`]])
export const BUDGETS = Object.freeze({ warm: TURN_CONTEXT_BUDGET_MS, cold: TURN_CONTEXT_COLD_BUDGET_MS })
const sha = bytes => createHash('sha256').update(bytes).digest('hex')

// One catalog item: the smallest real turn_context body (answer_type, time_intent and one relevance question) keeps 8 requests in 6k.
// The real first turns that missed the budget were ~2.5k-token bodies (c20, c21): connection setup, not size, is what is measured here.
const CANDIDATES = Object.freeze([
  { id: 'quote-a-v2', kind: 'ontology', title: 'A사 견적서 v2 수정 계획', summary: '단가 12,200원, 납기 12월 20일로 보낼 예정이다.', timeSlice: 'planned', status: 'plan' },
])
// Eight short messages of nearly the same length, one per request.
export const MESSAGES = Object.freeze([
  'A사 견적 지금 어디까지 됐어?', 'v2 견적은 언제 보내기로 했지?', '보안 점검은 며칠부터 시작해?', 'A사 단가는 지금 얼마로 되어 있어?',
  'v1 견적은 언제 보냈었지?', '점검 기간이 며칠 동안이야?', 'v2 납기는 언제로 잡혀 있어?', 'A사 건 남은 일이 뭐야?',
])

async function bodyFor(message) {
  const seen = []
  await prepareTurnContext({ message, candidates: CANDIDATES, client: { async decide(request) { seen.push(request); return { answers: {}, latencyMs: 0 } } } }).catch(() => null)
  if (seen.length !== 1) throw new Error(`expected one turn_context request, got ${seen.length}`)
  const { input, questions, promptCacheKey } = seen[0]
  return { model: DECISION_MODEL, input, questions, ...(promptCacheKey ? { prompt_cache_key: promptCacheKey } : {}) }
}

/** -> { reps: [{ dir, plan, planBytes, files }], totals } — deterministic; sends nothing. */
export async function buildLatencyPlan() {
  const reps = []
  for (const rep of [1, 2]) {
    const files = [], requests = []
    for (const [k, [id, waitBeforeMs]] of CONDITIONS.entries()) {
      const body = await bodyFor(MESSAGES[(rep - 1) * CONDITIONS.length + k])
      const bytes = Buffer.from(JSON.stringify(body), 'utf8'), file = `requests/${id}.json`
      const choice = body.questions.filter(q => q.type === 'choice').length
      files.push({ file, bytes })
      requests.push({ id, file, sha256: sha(bytes), estInputTokens: independentEstimate(choice, body.questions.length - choice, bytes.length), ...(waitBeforeMs ? { waitBeforeMs } : {}), expect: [], recordOnly: true })
    }
    const plan = { set: `${LATENCY_SET}/rep-${rep}`, tokenCeiling: Math.floor(LATENCY_CEILING / 2), transport: 'product',
      passRule: `Record only (latency probe). Run each repetition as its own process: a = first request of the process, b = immediately after, c = after 20 s, d = after 70 s ` +
        `(past the ${DECISION_IDLE_MS} ms transport idle window). Read elapsedMs, warmBefore and the socket phases against the turn-context budgets ${BUDGETS.warm} ms (warm) / ${BUDGETS.cold} ms (cold) with scripts/egdesk-turn-context-latency-plan.mjs analyze.`,
      requests }
    reps.push({ dir: `rep-${rep}`, plan, planBytes: Buffer.from(JSON.stringify(plan, null, 2) + '\n'), files, est: requests.reduce((s, r) => s + r.estInputTokens, 0) })
  }
  const total = reps.reduce((s, r) => s + r.est, 0)
  if (total > LATENCY_CEILING) throw new Error(`the probe estimates ${total} input tokens, over ${LATENCY_CEILING}`)
  return { reps, totals: { requests: reps.length * CONDITIONS.length, estInputTokens: total, waitMsPerRep: CONDITIONS.reduce((s, c) => s + c[1], 0) } }
}

/** results: [rep-1 results map, rep-2 results map] (runner `results`). -> one row per request and a summary per condition. */
export function analyzeLatency(repResults) {
  const rows = []
  repResults.forEach((results, r) => {
    for (const [id, , label] of CONDITIONS) {
      const x = results?.[id]
      if (!x) { rows.push({ rep: r + 1, id, label, sent: false }); continue }
      const budget = x.warmBefore === true ? BUDGETS.warm : BUDGETS.cold // the product's choice when it is not the conversation's first turn
      rows.push({ rep: r + 1, id, label, sent: true, status: x.status, elapsedMs: x.elapsedMs, warmBefore: x.warmBefore ?? null, reusedSocket: x.reusedSocket ?? null,
        connectMs: x.connectMs ?? null, tlsMs: x.tlsMs ?? null, serverMs: x.openaiProcessingMs == null ? null : Number(x.openaiProcessingMs), cachedTokens: x.usage?.cached_tokens ?? null,
        within800: x.elapsedMs <= BUDGETS.warm, within1500: x.elapsedMs <= BUDGETS.cold, withinProductBudget: x.elapsedMs <= budget, productBudget: budget })
    }
  })
  const byCondition = Object.fromEntries(CONDITIONS.map(([id]) => { const list = rows.filter(r => r.id === id && r.sent); return [id, { n: list.length, elapsedMs: list.map(r => r.elapsedMs), warmBefore: list.map(r => r.warmBefore), reusedSocket: list.map(r => r.reusedSocket), within800: list.filter(r => r.within800).length, within1500: list.filter(r => r.within1500).length }] }))
  return { rows, byCondition }
}

// ---- cycle 15: the idle probe (PREPARED, NOT SENT) ----
// Recorded first turns (c20-c23 multiuser, the same 2,583-token body) took 946 / 1,098 / 1,797 ms after 7-38 min without any Decisions
// request from this machine, and 317 ms six seconds after another run. Across every real file, 0 of 31 first requests sent within 2 min of
// a previous run exceeded 800 ms; 9 of 14 sent after >= 5 min did. So the open question is the idle gap, not the body size. This probe
// separates them: each run is started by Main only after >= 10 minutes with no Decisions request from this machine (the runner cannot
// enforce that: it is the run's precondition, stated in the plan).
//   run-A  A1 the realistic ~2.5k-token turn_context body (12 catalog items, as the multiuser first turn) as the first request,
//          A2 the same size immediately after, A3 the smallest body immediately after
//   run-B  B1 the smallest body as the first request, B2 the smallest body immediately after
// Registered readings: A1 and B1 slow (> 800 ms) with A2, A3, B2 fast -> the idle gap explains it, whatever the size; A1 slow and B1 fast
// -> size matters on a cold path; all fast -> the tail is intermittent and two samples cannot show it.
export const IDLE_SET = 'turn-context-idle-v1'
export const IDLE_DIR = 'proofs/decision-real-measure/turn-context-idle'
export const IDLE_CEILING = 8000
export const IDLE_MIN_MINUTES = 10
const REALISTIC = Object.freeze(Array.from({ length: 12 }, (_, i) => ({
  id: `item-${i + 1}`, kind: 'ontology', title: ['A사 견적 요청 접수', 'A사 견적서 v1 발송', 'A사 단가 협의 메모', 'A사 견적서 v2 수정 계획', 'A사 건 결정 메모', 'B사 견적 요청', 'B사 견적서 v1 발송', 'C사 계약 검토', '스피커 모듈 부품표', 'PostgreSQL 상태 점검', 'PostgreSQL 이전 계획', '보안 점검 일정'][i],
  summary: ['A사 구매팀이 11월 3일 스피커 모듈 200개 견적을 요청했다.', '11월 6일 단가 12,800원으로 견적서 v1을 발송했다.', '팀장 말로는 A사가 단가를 11,900원으로 낮춰 달라고 했다고 함.', '단가 12,200원, 납기 12월 20일로 보낼 예정이다.', '11월 18일 회의에서 v2는 팀장 승인 후 발송하기로 결정했다.', 'B사가 11월 10일 케이스 500개 견적을 요청했다.', '11월 12일 B사에 케이스 견적서 v1을 발송했다.', 'C사 공급 계약서 3조 지급 조건을 검토 중이다.', '드라이버 1, 앰프 칩 1, 단자 2. 부품 수급은 안정적이다.', '연결 수와 복제 지연을 매일 확인한다.', '12월 첫 주에 버전 16으로 옮길 계획이다.', '12월 15일부터 사흘 동안 진행한다.'][i],
  timeSlice: [ 'past', 'past', 'past', 'planned', 'past', 'past', 'past', 'present', 'present', 'present', 'planned', 'planned'][i], status: ['done', 'done', 'reported_by_other', 'plan', 'done', 'done', 'done', 'plan', 'done', 'done', 'plan', 'plan'][i] })))
async function idleBody(message, candidates) {
  const seen = []
  await prepareTurnContext({ message, candidates, client: { async decide(request) { seen.push(request); return { answers: {}, latencyMs: 0 } } } }).catch(() => null)
  if (seen.length !== 1) throw new Error('expected one turn_context request')
  const { input, questions, promptCacheKey } = seen[0]
  return { model: DECISION_MODEL, input, questions, ...(promptCacheKey ? { prompt_cache_key: promptCacheKey } : {}) }
}
export const IDLE_RUNS = Object.freeze([
  ['run-A', [['A1-realistic-first', 'realistic', 'A사 견적은 지금 어디까지 진행됐어?'], ['A2-realistic-next', 'realistic', 'v2 견적은 언제 보내기로 했어?'], ['A3-small-next', 'small', 'A사 단가는 지금 얼마야?']]],
  ['run-B', [['B1-small-first', 'small', '보안 점검은 언제 시작해?'], ['B2-small-next', 'small', '점검은 며칠 동안 해?']]],
])
/** -> { runs: [{ dir, plan, planBytes, files, est }], totals } — deterministic; sends nothing. */
export async function buildIdlePlan() {
  const runs = []
  for (const [dir, items] of IDLE_RUNS) {
    const files = [], requests = []
    for (const [id, size, message] of items) {
      const body = await idleBody(message, size === 'realistic' ? REALISTIC : CANDIDATES)
      const bytes = Buffer.from(JSON.stringify(body), 'utf8'), file = `requests/${id}.json`, choice = body.questions.filter(q => q.type === 'choice').length
      files.push({ file, bytes })
      requests.push({ id, file, sha256: sha(bytes), estInputTokens: independentEstimate(choice, body.questions.length - choice, bytes.length), expect: [], recordOnly: true })
    }
    const est = requests.reduce((s, r) => s + r.estInputTokens, 0)
    const plan = { set: `${IDLE_SET}/${dir}`, tokenCeiling: Math.ceil(est * 1.05 / 100) * 100, transport: 'product',
      passRule: `Record only (latency probe). PRECONDITION, not enforced by the runner: start this run only after at least ${IDLE_MIN_MINUTES} minutes with no Decisions request from this machine. ` +
        'The first request is the measured cold-after-idle case; the others follow immediately. Read with scripts/egdesk-turn-context-latency-plan.mjs analyze-idle.',
      requests }
    runs.push({ dir, plan, planBytes: Buffer.from(JSON.stringify(plan, null, 2) + '\n'), files, est })
  }
  const total = runs.reduce((s, r) => s + r.est, 0)
  if (total > IDLE_CEILING) throw new Error(`the idle probe estimates ${total} input tokens, over ${IDLE_CEILING}`)
  const ceilings = runs.reduce((s, r) => s + r.plan.tokenCeiling, 0)
  if (ceilings > IDLE_CEILING) throw new Error(`the idle runs' token ceilings add up to ${ceilings}, over ${IDLE_CEILING}`)
  return { runs, totals: { requests: runs.reduce((s, r) => s + r.plan.requests.length, 0), estInputTokens: total } }
}
/** [run-A results, run-B results] -> the registered reading. */
export function analyzeIdle([a = {}, b = {}] = []) {
  const ms = (x, id) => (Number.isFinite(x?.[id]?.elapsedMs) ? x[id].elapsedMs : null)
  const A1 = ms(a, 'A1-realistic-first'), A2 = ms(a, 'A2-realistic-next'), A3 = ms(a, 'A3-small-next'), B1 = ms(b, 'B1-small-first'), B2 = ms(b, 'B2-small-next')
  const slow = v => v !== null && v > BUDGETS.warm, fast = v => v !== null && v <= BUDGETS.warm
  const reading = [A1, A2, A3, B1, B2].some(v => v === null) ? 'incomplete'
    : slow(A1) && slow(B1) && fast(A2) && fast(A3) && fast(B2) ? 'idle gap explains it, whatever the size'
      : slow(A1) && fast(B1) ? 'size matters on a cold path'
        : [A1, A2, A3, B1, B2].every(fast) ? 'all fast: the tail is intermittent; two samples cannot show it'
          : 'mixed: report the numbers'
  return { A1, A2, A3, B1, B2, reading, serverMs: Object.fromEntries([['A1', a, 'A1-realistic-first'], ['B1', b, 'B1-small-first']].map(([k, x, id]) => [k, x?.[id]?.openaiProcessingMs == null ? null : Number(x[id].openaiProcessingMs)])) }
}
