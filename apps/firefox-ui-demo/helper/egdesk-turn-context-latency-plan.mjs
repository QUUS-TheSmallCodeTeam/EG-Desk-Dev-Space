import { createHash } from 'node:crypto'
import { DECISION_MODEL } from './egdesk-decision-client.mjs'
import { CONTENT_FREE_REQUESTS } from './egdesk-decision-egress.mjs'
import { prepareTurnContext } from './egdesk-context-setup.mjs'
import { DECISION_IDLE_MS } from './egdesk-decision-transport.mjs'
import { TOKEN_MODEL, estimateBodyTokens, independentEstimate } from './egdesk-decision-real-runner.mjs'
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

// ---- cycle 16: the warm-up probe (PREPARED, NOT SENT) ----
// The product question: after a long idle, does a TINY request sent first (the smallest real body: the one-item turn_context) make the
// following turn_context fast? Every run starts after >= 10 minutes with no Decisions request from this machine (Main pauses all sends).
//   A  the measured turn_context alone (cold after idle)
//   B  the tiny warm-up, then the measured turn_context 1 s later
//   C  the tiny warm-up, then the measured turn_context 10 s later
// Two repetitions each, six runs, interleaved A1 B1 C1 A2 B2 C2 so the time of day is spread. The measured body is a 3-item turn_context
// (~1k tokens), not the ~2.6k-token one: six 2.6k bodies alone are 15.6k, over the 10k bound. The recorded slow first requests ranged from
// 325 to 2,057 tokens with the same slowdown, and warm requests differ by ~50 ms between 1k and 2.6k (cycle 15); the c15 idle probe
// (turn-context-idle) is the one that asks about size on the cold path.
// Registered readings (on the measured request; "slow" = over the 800 ms warm budget):
//   inconclusive               A is fast in both repetitions: the idle tail did not occur, nothing follows about the warm-up
//   warm-up works              A slow at least once, and B and C fast in both repetitions
//   warm-up works with lead    A slow at least once, C fast in both, B slow at least once
//   warm-up does not help      A slow at least once, and C slow at least once
export const WARMUP_SET = 'turn-context-warmup-v1'
export const WARMUP_DIR = 'proofs/decision-real-measure/turn-context-warmup'
export const WARMUP_CEILING = 10000
const MEASURED = Object.freeze(REALISTIC.slice(0, 3))
export const WARMUP_RUNS = Object.freeze([
  ['A-rep1', [['measured', 0, 'A사 견적은 지금 어디까지 진행됐어?']]],
  ['B-rep1', [['warmup', 0, '견적 상태 알려 줘'], ['measured', 1000, 'v2 견적은 언제 보내기로 했어?']]],
  ['C-rep1', [['warmup', 0, '견적 일정 알려 줘'], ['measured', 10000, 'A사 단가는 지금 얼마로 되어 있어?']]],
  ['A-rep2', [['measured', 0, 'v1 견적은 언제 보냈었지?']]],
  ['B-rep2', [['warmup', 0, '견적 진행 알려 줘'], ['measured', 1000, 'A사 건 남은 일이 뭐야?']]],
  ['C-rep2', [['warmup', 0, '견적 내용 알려 줘'], ['measured', 10000, 'v2 납기는 언제로 잡혀 있어?']]],
])
/** -> { runs: [{ dir, plan, planBytes, files, est }], totals } — deterministic; sends nothing. */
export async function buildWarmupPlan() {
  const runs = []
  for (const [dir, items] of WARMUP_RUNS) {
    const files = [], requests = []
    for (const [id, waitBeforeMs, message] of items) {
      const body = await idleBody(message, id === 'warmup' ? CANDIDATES : MEASURED)
      const bytes = Buffer.from(JSON.stringify(body), 'utf8'), file = `requests/${id}.json`
      files.push({ file, bytes })
      requests.push({ id, file, sha256: sha(bytes), estInputTokens: estimateBodyTokens(bytes.toString('utf8')), ...(waitBeforeMs ? { waitBeforeMs } : {}), expect: [], recordOnly: true })
    }
    const est = requests.reduce((t, r) => t + r.estInputTokens, 0)
    const plan = { set: `${WARMUP_SET}/${dir}`, tokenCeiling: Math.ceil(est * TOKEN_MODEL.margin / 10) * 10, transport: 'product',
      passRule: 'Record only (latency probe). PRECONDITION, not enforced by the runner: start this run only after at least 10 minutes with no Decisions request from this machine. ' +
        'Run order A-rep1, B-rep1, C-rep1, A-rep2, B-rep2, C-rep2. Read the "measured" request with scripts/egdesk-turn-context-latency-plan.mjs analyze-warmup.',
      requests }
    runs.push({ dir, plan, planBytes: Buffer.from(JSON.stringify(plan, null, 2) + '\n'), files, est })
  }
  const ceilings = runs.reduce((t, r) => t + r.plan.tokenCeiling, 0)
  if (ceilings > WARMUP_CEILING) throw new Error(`the warm-up runs' token ceilings add up to ${ceilings}, over ${WARMUP_CEILING}`)
  return { runs, totals: { runs: runs.length, requests: runs.reduce((t, r) => t + r.plan.requests.length, 0), estInputTokens: runs.reduce((t, r) => t + r.est, 0), ceilings } }
}
/** { 'A-rep1': results, ... } -> per run the measured request (elapsed, server, socket) and the registered reading. */
export function analyzeWarmup(byRun) {
  const row = dir => { const x = byRun?.[dir]?.measured, w = byRun?.[dir]?.warmup
    return x ? { elapsedMs: x.elapsedMs, serverMs: x.openaiProcessingMs == null ? null : Number(x.openaiProcessingMs), reusedSocket: x.reusedSocket ?? null, warmBefore: x.warmBefore ?? null,
      connectMs: x.connectMs ?? null, tlsMs: x.tlsMs ?? null, ...(w ? { warmupMs: w.elapsedMs, warmupServerMs: w.openaiProcessingMs == null ? null : Number(w.openaiProcessingMs) } : {}) } : null }
  const runs = Object.fromEntries(WARMUP_RUNS.map(([dir]) => [dir, row(dir)]))
  const slow = r => r && r.elapsedMs > BUDGETS.warm
  const pick = c => [runs[`${c}-rep1`], runs[`${c}-rep2`]]
  const [A, B, C] = ['A', 'B', 'C'].map(pick)
  // The registered readings as a function of which measured requests were slow (true) or fast (false); null = that point is not in yet.
  const readingOf = (a, b, c) => [...a, ...b, ...c].some(v => v === null) ? 'incomplete'
    : !a.some(Boolean) ? 'inconclusive: the idle tail did not occur in A'
      : c.some(Boolean) ? 'warm-up does not help'
        : b.some(Boolean) ? 'warm-up works with lead time (10 s, not 1 s)'
          : 'warm-up works'
  const flags = list => list.map(r => (r ? slow(r) : null))
  const [fa, fb, fc] = [flags(A), flags(B), flags(C)]
  const reading = readingOf(fa, fb, fc)
  // c18: which registered readings are still possible given the points that are in (every missing point tried both ways), and the reading
  // when only one is left. "A slow once and C slow once" already fixes 'warm-up does not help', whatever the remaining points show.
  const missing = [...fa, ...fb, ...fc].map((v, i) => (v === null ? i : -1)).filter(i => i >= 0)
  const possible = new Set()
  for (let mask = 0; mask < (1 << missing.length); mask++) {
    const all = [...fa, ...fb, ...fc]
    missing.forEach((idx, bit) => { all[idx] = Boolean(mask & (1 << bit)) })
    possible.add(readingOf(all.slice(0, 2), all.slice(2, 4), all.slice(4, 6)))
  }
  const possibleReadings = [...possible]
  return { runs, reading, pointsIn: 6 - missing.length, possibleReadings, decidedAlready: possibleReadings.length === 1 ? possibleReadings[0] : null }
}

// ---- cycle 19: does the SIZE of the warm-up request matter? (PREPARED, NOT SENT; run only after the six turn-context-warmup points) ----
// The product warm-up (helper/egdesk-decision-warmup.mjs) is the fixed content-free request, about 159 estimated tokens. The probe points B and C
// used the smallest real turn_context body (about 648 tokens) as the warm-up and the measured request was fast after it (324 and 269 ms). The
// design ASSUMES the smaller product body warms as well; this probe tests that assumption directly, with the same two-request shape as B:
//   S1-small  the product warm-up body (CONTENT_FREE_REQUESTS.warmup), then the measured turn_context 1 s later
//   S2-large  the 648-token warm-up (as in B and C), then the measured turn_context 1 s later
// Each is its own run and must start after at least 10 minutes with no Decisions request from this machine (the point runner enforces it with the
// shared send stamp: scripts/egdesk-turn-context-warmup-run.mjs --set size --point S1|S2). The measured body is a 2-item turn_context (about 840
// tokens). Total estimate about 2.5k input tokens (bound 3k), the run ceilings add up to 2.7k. The idle tail is judged by the
// warm-up request itself: a warm-up over the warm budget (800 ms) means the tail occurred in that run (it did in B1: 1,597 ms, C1: 1,187 ms).
// Registered readings (measured request over 800 ms = slow):
//   inconclusive                  neither warm-up was slow: the idle tail did not occur, nothing follows about the size
//   size does not matter          both warm-ups slow (the tail occurred in both) and both measured requests fast
//   small body does not warm      S1's warm-up slow and S1's measured slow while S2's measured is fast: the assumption is wrong, send the larger body
//   warm-up did not help          both measured slow although a tail occurred: contradicts points B and C, repeat before any design change
//   one run only                  the tail occurred in one run only: that run is read, the other is repeated
export const SIZE_SET = 'turn-context-warmup-size-v1'
export const SIZE_DIR = 'proofs/decision-real-measure/turn-context-warmup-size'
export const SIZE_CEILING = 3000
export const SIZE_ESTIMATE_BOUND = 3000
const SIZE_MEASURED = Object.freeze(REALISTIC.slice(0, 2))
export const SIZE_RUNS = Object.freeze([
  ['S1-small', [['warmup', 0, null], ['measured', 1000, 'A사 견적서는 지금 어디까지 진행됐어?']]],
  ['S2-large', [['warmup', 0, 'v1 견적은 언제 보냈었지?'], ['measured', 1000, 'v2 납기는 언제로 잡혀 있어?']]],
])
/** -> { runs: [{ dir, plan, planBytes, files, est }], totals } — deterministic; sends nothing. */
export async function buildSizePlan() {
  const runs = []
  for (const [dir, items] of SIZE_RUNS) {
    const files = [], requests = []
    for (const [id, waitBeforeMs, message] of items) {
      const body = id === 'warmup' && message === null
        ? { model: DECISION_MODEL, input: CONTENT_FREE_REQUESTS.warmup.input, questions: CONTENT_FREE_REQUESTS.warmup.questions }
        : await idleBody(message, id === 'warmup' ? CANDIDATES : SIZE_MEASURED)
      const bytes = Buffer.from(JSON.stringify(body), 'utf8'), file = `requests/${id}.json`
      files.push({ file, bytes })
      requests.push({ id, file, sha256: sha(bytes), estInputTokens: estimateBodyTokens(bytes.toString('utf8')), ...(waitBeforeMs ? { waitBeforeMs } : {}), expect: [], recordOnly: true })
    }
    const est = requests.reduce((t, r) => t + r.estInputTokens, 0)
    const plan = { set: `${SIZE_SET}/${dir}`, tokenCeiling: Math.ceil(est * TOKEN_MODEL.margin / 10) * 10, transport: 'product',
      passRule: 'Record only (latency probe). PRECONDITION, not enforced by the runner: start this run only after at least 10 minutes with no Decisions request from this machine ' +
        '(the point runner checks the shared send stamp). Run order S1-small, S2-large. Read with scripts/egdesk-turn-context-warmup-run.mjs --set size --analyze.',
      requests }
    runs.push({ dir, plan, planBytes: Buffer.from(JSON.stringify(plan, null, 2) + '\n'), files, est })
  }
  const est = runs.reduce((t, r) => t + r.est, 0), ceilings = runs.reduce((t, r) => t + r.plan.tokenCeiling, 0)
  if (est > SIZE_ESTIMATE_BOUND) throw new Error(`the size probe estimates ${est} input tokens, over ${SIZE_ESTIMATE_BOUND}`)
  if (ceilings > SIZE_CEILING) throw new Error(`the size probe's ceilings add up to ${ceilings}, over ${SIZE_CEILING}`)
  return { runs, totals: { runs: runs.length, requests: runs.reduce((t, r) => t + r.plan.requests.length, 0), estInputTokens: est, ceilings } }
}
/** { 'S1-small': results, 'S2-large': results } (a run's results: { warmup, measured }) -> per run the two requests and the registered reading. */
export function analyzeSize(byRun) {
  const row = dir => { const m = byRun?.[dir]?.measured, w = byRun?.[dir]?.warmup
    return m && w ? { warmupMs: w.elapsedMs, warmupServerMs: w.openaiProcessingMs == null ? null : Number(w.openaiProcessingMs), measuredMs: m.elapsedMs,
      measuredServerMs: m.openaiProcessingMs == null ? null : Number(m.openaiProcessingMs), reusedSocket: m.reusedSocket ?? null, tail: w.elapsedMs > BUDGETS.warm, slow: m.elapsedMs > BUDGETS.warm } : null }
  const runs = Object.fromEntries(SIZE_RUNS.map(([dir]) => [dir, row(dir)]))
  const [s1, s2] = [runs['S1-small'], runs['S2-large']]
  const reading = !s1 || !s2 ? 'incomplete'
    : !s1.tail && !s2.tail ? 'inconclusive: the idle tail did not occur in either run'
      : s1.tail !== s2.tail ? 'one run only: the tail occurred in one run, repeat the other'
        : s1.slow && s2.slow ? 'warm-up did not help: contradicts points B and C, repeat before any design change'
          : s1.slow ? 'small body does not warm: send the larger body'
            : s2.slow ? 'large body failed while the small one warmed: size does not matter for the product body, repeat S2'
              : 'size does not matter'
  return { runs, reading }
}
