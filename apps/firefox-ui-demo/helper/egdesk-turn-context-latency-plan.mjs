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
