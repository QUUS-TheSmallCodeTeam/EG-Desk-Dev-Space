import { DECISION_MODEL } from './egdesk-decision-client.mjs'
import { ASKED, NOT_YES, NO, OWN_REPLY, OWN_SAID, YES, adder, bars, finish, p } from './egdesk-c36-plans.mjs'
import { buildMemoryFirstV2Script } from './egdesk-memory-first-real-engine-scripts.mjs'
import { buildMemoryWriteV3Script } from './egdesk-memory-real-engine-scripts.mjs'
import { memoryGraph } from './egdesk-real-engine-memory.mjs'
import { pagesFromOntologyGraph } from './egdesk-wiki-adapter.mjs'
import { buildWiki } from './egdesk-wiki-reconstruction.mjs'
import { choiceAnswer, mockJudge } from './egdesk-wiki-reconstruction.fixture.mjs'
import { prepareTurnMemory } from './egdesk-turn-memory.mjs'
import { judgeConfirmation } from './egdesk-record-confirmation.mjs'
import { contradictionPairs, contradictionRequest, judgeRecordConflict } from './egdesk-record-settled.mjs'
import { SPEECH_SPLIT_BARS, SPEECH_THRESHOLDS } from './egdesk-speech-grounding.mjs'

// L7 c41: a Decisions-only REPLAY of the memory-first layer (EGDESK_TURN_MEMORY_WRITE_FIRST=on) on the recorded real turns, for the days the real engine is off. NOTHING here sends or reads a key.
//
// The person's messages and the store states are the recorded ones: the three schedule records and the two workshop records are the seeds of the committed scripts (write-v3, memory-first-v2), the
// messages are those of check-20mw, check-27mw and check-31mf (own-confirm, hedged, relayed, control), plus the conflict, contradiction and new-record turns of memory-first-v2 (never run on the real engine:
// check-32mf did not run). Every request body is built BY THE PRODUCT'S OWN FUNCTIONS from those inputs (prepareTurnMemory: the recording triage and the write judgment with its axes, its second step
// and its link question; judgeRecordConflict; contradictionRequest; judgeConfirmation), the way the runtime builds them at the start of a turn. The product is walked through the recorded
// first turn first, so the second turn has the held page and the position (mid, live thread) it had in the recorded run. The engine is not involved; the answers used to walk the chain are
// scripted, never part of a request, and not an expectation.
//
// Expectations are built by code from what the real runs recorded (named in each note), at the product's own bars, hard where a real run showed the outcome, soft where this is the first time a question is asked.
// Timing per request: the generic runner records every request's elapsed time and (transport "product") whether its socket was warm; replayTimingReport() adds them up per turn start and compares with
// the turn-context budgets (warm 2.5 s, cold 4 s: TURN_MEMORY_CAPS).
export const REPLAY_SET = 'memory-first-replay-v1'
export const REPLAY_BUDGET = Object.freeze({ warmMs: 2500, coldMs: 4000 })
// The declared ceiling (the owner's cap for this replay is 12,000 input tokens). The product's request bodies are what they are (a write request with the three speech axes is ~1,450 tokens), so the
// replay sends the requests that carry a distinct claim and leaves out the ones another request or an earlier real run already settles:
//   own-triage, relayed-triage, newrecord-triage, hedged-triage    the positive triage ("worth recording") is what made the real runs' write judgments run (check-20mw, 27mw, 31mf)
//   hedged-conflict, control-conflict                                the conflict question was measured on the same pair shapes in conflict-pair-v1 (6/6, c57)
//   newrecord-write-second, newrecord-link                           soft-only, first-time questions
// Every request omitted is still BUILT (captureScenario), so a later, larger plan can send it.
export const REPLAY_TOKEN_CEILING = 12_000
export const REPLAY_SENT = Object.freeze(['own-write', 'own-write-second', 'own-conflict', 'hedged-write', 'relayed-write', 'relayed-conflict', 'control-triage', 'newrecord-write', 'own-confirm-yes', 'contradiction-yes', 'contradiction-control'])
const T = { first: { kind: 'first', reason: 'new_thread' }, mid: { kind: 'mid', reason: 'live_thread' } }
const COMMON = { writeTarget: 'about', speechDesign: 'hybrid-two-step-ask', splitWording: 'v4', budget: { linksFirst: true }, skipOnNeed: true, heldExcerpts: true, ontologyWrite: true, packetFirst: true }
const v3 = () => buildMemoryWriteV3Script().conversations.find(c => c.id === 'own-confirm')
const v2 = () => buildMemoryFirstV2Script().conversations
const NAMES = Object.freeze({ review: '신제품 리뷰 회의 일정', vendor: '거래처 점검 방문 일정', legal: '법무 검토 마감 일정' })
const NEWFACT = '아 그리고 다음 달 둘째 주에 재고 실사를 할 거야'
const CONTROL_SAID = '신제품 리뷰 회의 일정 아직 안 정해졌지?'

/** The scenarios: the recorded first turn, the recorded person message, what the real runs showed. */
export const SCENARIOS = Object.freeze([
  { id: 'own', first: '신제품 리뷰 회의 일정 어떻게 돼 있어?', say: OWN_SAID, about: NAMES.review, evidence: 'check-20mw, check-27mw (own-confirm turn 2: a pending reading on the review record, basis self_reported_observation)',
    script: { record: 0.95, status: 'plan', source: 'unspecified', form: 'plan', time: 'future_anchored', own: 0.95, conflict: 0.97 } },
  { id: 'hedged', first: '거래처 점검 방문 일정 어떻게 돼 있어?', say: '아 그 점검 방문은 아마 화요일쯤일 거야', about: NAMES.vendor, evidence: 'check-20mw, check-27mw, check-31mf (hedged turn 2: not an own statement; never self_reported_observation)',
    script: { record: 0.9, status: 'plan', source: 'inference', form: 'plan', time: 'future_unspecified', own: 0.03 } },
  { id: 'relayed', first: '법무 검토 마감 일정 어떻게 돼 있어?', say: '법무팀 말로는 그 마감을 수요일로 정했대', about: NAMES.legal, evidence: 'check-20mw, check-27mw, check-31mf (relayed turn 2: pending reading, basis attributed_report; check-31mf: conflict yes, p 1.0, 1,341 ms settled)',
    script: { record: 0.95, status: 'plan', source: 'attributed_report', form: 'assertion', time: 'past_unspecified', own: 0.03, conflict: 0.97 } },
  { id: 'control', first: '신제품 리뷰 회의 일정 어떻게 돼 있어?', say: CONTROL_SAID, about: NAMES.review, evidence: 'check-31mf control-first (turn 2: nothing to record, no write judgment, no conflict)',
    script: { record: 0.03 }, conflictOf: { page: NAMES.review, p: 0.03 } },
  { id: 'newrecord', first: '신제품 리뷰 회의 일정 어떻게 돼 있어?', say: NEWFACT, about: null, evidence: 'memory-first-v2 newrecord-first (never run on the real engine); no seeded record is about it',
    script: { record: 0.95, status: 'plan', source: 'unspecified', form: 'plan', time: 'future_anchored', own: 0.9, link: 0.03 } },
])

function seed() {
  // the committed scripts' seeds: write-v3's three schedule records and v2's two workshop records
  const schedule = v3().memory, workshop = v2().find(c => c.id === 'contradiction-first').memory
  return { schedule, workshop }
}
async function wikiOf(memory) { return buildWiki(await pagesFromOntologyGraph(memoryGraph(memory))) }

// ---- the scripted walk (answers are never part of a request) ----
const blockOf = (req, alias) => new RegExp(`(?:^|\\n)${alias} \\|[^\\n]*(?:\\n(?!P\\d+ \\|)[^\\n]*)*`).exec(req.input.map(m => String(m.content)).join('\n'))?.[0] ?? ''
function scripted(spec, base) {
  const s = spec.script
  return async req => {
    const answers = { ...(await base.decide(req)).answers }
    for (const q of req.questions) {
      const n = q.name
      if (n === 'tn_record') answers[n] = { type: 'predicate', probability: s.record }
      else if (n === 'tn_courtesy' || n === 'tn_recall' || n === 'tn_action') answers[n] = { type: 'predicate', probability: 0.03 }
      else if (n === 'tn_need') answers[n] = { type: 'predicate', probability: 0.03 }
      else if (n === 'tw_status') answers[n] = choiceAnswer(q, s.status, 0.95)
      else if (/^tw_about_\d+$/.test(n)) answers[n] = { type: 'predicate', probability: spec.about && blockOf(req, `P${Number(n.split('_').at(-1)) + 1}`).includes(spec.about) ? 0.95 : 0.03 }
      else if (n === 'speech_source_0') answers[n] = choiceAnswer(q, s.source, 0.93)
      else if (n === 'speech_form_0') answers[n] = choiceAnswer(q, s.form, 0.95)
      else if (n === 'speech_time_0') answers[n] = choiceAnswer(q, s.time, 0.93)
      else if (n === 'speechs_own_0') answers[n] = { type: 'predicate', probability: s.own ?? 0.03 }
      else if (/^speechs_/.test(n)) answers[n] = { type: 'predicate', probability: 0.03 }
      else if (/^tw_link_\d+$/.test(n)) answers[n] = { type: 'predicate', probability: s.link ?? 0.03 }
    }
    return { answers, usage: { input_tokens: 1 } }
  }
}

/** Walks one scenario through the product and returns the requests of its SECOND turn, in the order the runtime sends them: { id, stage, request: { input, questions } }. */
export async function captureScenario(spec) {
  const { schedule } = seed(), wiki = await wikiOf(schedule), base = mockJudge()
  const captured = []
  let on = false
  const client = { async decide(req) { const out = await (on ? scripted(spec, base)(req) : base.decide(req)); if (on) captured.push({ stage: stageOf(req.questions.map(q => q.name)), request: { input: req.input, questions: req.questions } }); return out } }
  const r1 = await prepareTurnMemory({ message: spec.first, wiki, client, askedAt: ASKED, position: T.first, threadKey: 'replay', ...COMMON })
  on = true
  const r2 = await prepareTurnMemory({ message: spec.say, wiki, client, askedAt: ASKED + 60_000, position: T.mid, delivered: { ...r1.nextDelivered(), usable: true }, threadKey: 'replay', previous: Object.keys(r1.memory.delivered ?? {}), ...COMMON })
  const judged = typeof r2.judgeWrite === 'function' ? await r2.judgeWrite() : null
  const proposal = judged?.proposal ?? null
  // the conflict pair of the settlement: asked only when the judgment targets an existing record (runtime: startWriteFirst)
  const target = proposal?.op === 'update_status' ? wiki.pages.get(proposal.pageId) : spec.conflictOf ? [...wiki.pages.values()].find(pg => pg.title === spec.conflictOf.page) : null
  if (target) await judgeRecordConflict({ message: spec.say, page: target, askedAt: ASKED + 60_000, client: { async decide(req) { captured.push({ stage: 'conflict', request: { input: req.input, questions: req.questions } }); return { answers: { cf_differs: { type: 'predicate', probability: spec.conflictOf?.p ?? spec.script.conflict ?? 0.03 } } } } } })
  return { captured: captured.filter(c => ['triage', 'write', 'write-second', 'link', 'conflict'].includes(c.stage)), proposal, triage: r2.triage }
}
export const stageOf = names => (names.some(n => n.startsWith('tn_')) ? 'triage' : names.some(n => n.startsWith('tw_link_')) ? 'link' : names.some(n => n.startsWith('speechs_')) ? 'write-second'
  : names.some(n => n === 'tw_status') ? 'write' : names.some(n => n === 'cf_differs') ? 'conflict' : names.some(n => n.startsWith('rc_')) ? 'confirm' : names.some(n => n.startsWith('ct_')) ? 'contradiction' : 'fetch')

// ---- expectations: by code, from what the real runs recorded ----
const aliasIndex = (request, title) => { const text = request.input.map(m => String(m.content)).join('\n'); const hit = [...text.matchAll(/(?:^|\n)P(\d+) \|[^\n]*(?:\n(?!P\d+ \|)[^\n]*)*/g)].find(m => m[0].includes(title)); return hit ? Number(hit[1]) - 1 : -1 }
// whenAccepted (default): checked only where the product would install the answer at its bar, so a hard check fails on a wrong install only; whenAccepted false: the answer must be decided and in the set
const choiceIn = (name, oneOf, bar, severity, note, whenAccepted = true) => ({ name, kind: 'choice', oneOf, ...(whenAccepted ? { whenAccepted: { minConfidence: bar.confidence, minMargin: bar.margin } } : { minConfidence: bar.confidence, minMargin: bar.margin }), severity, note })
const AXIS_BAR = { confidence: SPEECH_THRESHOLDS.confidence, margin: SPEECH_THRESHOLDS.margin }
const STATUS_BAR = { confidence: 0.75, margin: 0.2 }
function expectFor(spec, stage, request) {
  const names = request.questions.map(q => q.name)
  const ev = spec.evidence
  const x = []
  if (stage === 'triage') {
    if (spec.id === 'control') x.push(p('tn_record', 'max', NOT_YES, 'hard', `no write judgment is wanted for a question about the record: ${ev}`), p('tn_record', 'max', NO, 'soft', 'a clear no'))
    else if (spec.id === 'hedged') x.push(p('tn_record', 'min', 0, 'soft', `either answer is allowed (the script allows pending or none): ${ev}`))
    else x.push(p('tn_record', 'min', YES, 'hard', `the write judgment ran in the real run: ${ev}`))
    if (names.includes('tn_courtesy')) x.push(p('tn_courtesy', 'max', NO, 'soft', 'not a courtesy'))
  } else if (stage === 'write') {
    const hit = spec.about ? aliasIndex(request, spec.about) : -1
    names.filter(n => /^tw_about_\d+$/.test(n)).forEach((n, i) => {
      const target = i === hit
      x.push(spec.id === 'hedged' ? p(n, target ? 'min' : 'max', target ? YES : NO, target ? 'soft' : 'hard', target ? 'the visit record is what it is about' : 'not about another record')
        : p(n, target ? 'min' : 'max', target ? YES : NO, 'hard', target ? `about this record (${ev})` : spec.about ? 'not about another record (the target is exactly one yes and every other a decided no)' : 'about no stored record: a new record'))
    })
    if (spec.id === 'own') x.push(choiceIn('tw_status', ['plan', 'done'], STATUS_BAR, 'hard', `a status the person reports (${ev})`, false),
      choiceIn('speech_source_0', ['self_reported_observation', 'unspecified'], AXIS_BAR, 'hard', 'own statement: never an attributed report or an inference (wrong install only)'),
      choiceIn('speech_form_0', ['plan', 'assertion'], AXIS_BAR, 'soft', 'a plan or a settled fact'))
    else if (spec.id === 'relayed') x.push(choiceIn('tw_status', ['plan', 'done'], STATUS_BAR, 'hard', 'a status the person relays', false),
      choiceIn('speech_source_0', ['attributed_report'], AXIS_BAR, 'hard', `relayed: basis attributed_report (${ev})`))
    else if (spec.id === 'hedged') x.push(choiceIn('speech_source_0', ['inference', 'unspecified', 'record_based', 'unknown'], AXIS_BAR, 'hard', `hedged: never self_reported_observation or attributed_report (${ev})`))
    else if (spec.id === 'newrecord') x.push(choiceIn('tw_status', ['plan'], STATUS_BAR, 'hard', 'an intention for next month', false),
      choiceIn('speech_form_0', ['plan'], AXIS_BAR, 'soft', 'a plan'))
  } else if (stage === 'write-second') {
    const bar = SPEECH_SPLIT_BARS
    if (spec.id === 'own') x.push(p('speechs_own_0', 'min', bar.yes, 'hard', 'the person\'s own decision reaches the own bar (wording v4: c36 own-wording-v4 10/10)'), p('speechs_other_0', 'max', bar.no, 'hard', 'not attributed to someone else'))
    else if (spec.id === 'newrecord') x.push(p('speechs_own_0', 'min', 0, 'soft', 'first time asked for this sentence'))
    else x.push(p('speechs_own_0', 'max', bar.no, 'hard', 'not an own act'))
  } else if (stage === 'link') {
    names.forEach(n => x.push(p(n, 'max', NO, 'soft', 'a new record about no stored record is not the same task as one')))
  } else if (stage === 'conflict') {
    if (spec.id === 'control') x.push(p('cf_differs', 'max', NOT_YES, 'hard', `a question about the record states nothing different (${ev})`), p('cf_differs', 'max', NO, 'soft', 'a clear no'))
    else x.push(p('cf_differs', 'min', YES, 'hard', `the message differs from the record that says undecided (${ev})`))
  }
  return x
}

// ---- the recorded confirmation and the contradiction pairs ----
const CONFIRM = { id: 'own-confirm-yes', say: '응 맞아', reply: OWN_REPLY, evidence: 'check-20mw own-confirm turn 3 reply (the real one) and turn 4 "응 맞아"' }
async function confirmRequest() {
  let request = null
  await judgeConfirmation({ message: CONFIRM.say, previousAnswer: CONFIRM.reply, records: [{ title: NAMES.review, status: 'plan', said: OWN_SAID }], wording: 'v2', client: { async decide(r) { request = r; return { answers: {} } } }, askedAt: ASKED + 120_000 })
  return request
}
async function contradictionRequests() {
  const { workshop } = seed(), wiki = await wikiOf(workshop), pages = [...wiki.pages.values()]
  const vendor = (await wikiOf(seed().schedule)).pages.get('ontology:schedule/vendor-visit')
  const linked = (a, b) => wiki.links(a.id).some(l => l.to === b.id)
  return [{ id: 'contradiction-yes', pages, expectP: 'min', note: 'the same workshop on two days, no link between the records (memory-first-v2 contradiction-first; check-32mf did not run)' },
    { id: 'contradiction-control', pages: [pages[0], vendor], expectP: 'max', note: 'two different matters (memory-first-v2 contradiction-control)' }].map(c => ({ ...c, request: contradictionRequest(contradictionPairs(c.pages, { linked }), ASKED) }))
}

// ---- the plan ----
const FAMILY_BARS = () => ({
  ...bars(['tn_record', 'tn_courtesy', 'cf_differs', 'ct_#', 'rc_stated_#', 'rc_confirms_#'], YES, YES - 1e-6, 'the product acts only at a decided yes (ternary .8; triage, conflict, contradiction, confirmation)'),
  'rc_rejects_#': { yes: YES, no: NO, source: 'egdesk-record-confirmation.mjs CONFIRM_BARS' },
  'tw_about_#': { yes: YES, no: NO, source: 'egdesk-turn-memory.mjs deriveWriteTarget: exactly one yes and every other a decided no' },
  'tw_link_#': { yes: YES, no: NO, source: 'egdesk-turn-memory.mjs judgeWriteAbout related(): a link at a decided yes' },
  ...bars(['speechs_own_#', 'speechs_other_#'], SPEECH_SPLIT_BARS.yes, SPEECH_SPLIT_BARS.no, 'egdesk-speech-grounding.mjs SPEECH_SPLIT_BARS (.85 / .15)'),
  ...Object.fromEntries(['speech_source_#', 'speech_form_#', 'speech_time_#'].map(k => [k, { minConfidence: SPEECH_THRESHOLDS.confidence, minMargin: SPEECH_THRESHOLDS.margin, source: 'egdesk-speech-grounding.mjs SPEECH_THRESHOLDS (.85 / .20): a label is installed only above it' }])),
  '*choice': { minConfidence: 0.75, minMargin: 0.2, source: 'egdesk-turn-memory.mjs readChoice for tw_status (.75 / .2)' },
})
/** The scenario chains in turn-start order, for the timing report: each entry lists the request ids a turn start sends in sequence. */
export function chainsOf() {
  return [{ id: 'own', kind: 'added after the loop: write, second step, conflict (sequential)', ids: ['own-write', 'own-write-second', 'own-conflict'] },
    { id: 'hedged', kind: 'added after the loop: write', ids: ['hedged-write'] },
    { id: 'relayed', kind: 'added after the loop: write, conflict (sequential)', ids: ['relayed-write', 'relayed-conflict'] },
    { id: 'newrecord', kind: 'added after the loop: write', ids: ['newrecord-write'] },
    { id: 'control', kind: 'the triage of a turn with nothing to record (inside the loop)', ids: ['control-triage'] },
    { id: 'own-confirm', kind: 'before the loop: the confirmation of the stated note', ids: ['own-confirm-yes'] },
    { id: 'contradiction', kind: 'beside the write judgment (the slower of the two)', ids: ['contradiction-yes', 'contradiction-control'] }]
}

export async function buildMemoryFirstReplayPlan() {
  const a = adder()
  for (const spec of SCENARIOS) {
    const { captured } = await captureScenario(spec)
    const counts = {}
    for (const c of captured) {
      counts[c.stage] = (counts[c.stage] ?? 0) + 1
      const id = `${spec.id}-${c.stage}${counts[c.stage] > 1 ? counts[c.stage] : ''}`
      if (REPLAY_SENT.includes(id)) a.add(id, { model: DECISION_MODEL, input: c.request.input, questions: c.request.questions }, expectFor(spec, c.stage, c.request))
    }
  }
  const confirm = await confirmRequest()
  a.add(CONFIRM.id, { model: DECISION_MODEL, input: confirm.input, questions: confirm.questions }, [
    p('rc_stated_0', 'min', YES, 'hard', `v2: the reply mentioned the note as unconfirmed (${CONFIRM.evidence}; c36 confirmation-stated-v1 6/6)`), p('rc_confirms_0', 'min', YES, 'hard', 'an explicit yes'), p('rc_rejects_0', 'max', NO, 'hard', 'not a rejection')])
  for (const c of await contradictionRequests()) a.add(c.id, { model: DECISION_MODEL, input: c.request.input, questions: c.request.questions },
    [c.expectP === 'min' ? p('ct_0', 'min', YES, 'hard', c.note) : p('ct_0', 'max', NOT_YES, 'hard', c.note), ...(c.expectP === 'max' ? [p('ct_0', 'max', NO, 'soft', 'a clear no')] : [])])
  const built = finish(REPLAY_SET, a.requests, a.files, FAMILY_BARS(),
    'Every hard check passes: at each recorded turn start the product\'s own requests read as the real runs did: the own statement is about the review record (one yes, the others no), a plan or done status, an own source (never relayed or inferred), conflict yes; the hedged message is never installed as own or relayed; the relayed message is attributed_report with conflict yes; the question about the record asks for no write; a new record is about no stored record; the workshop on two days contradicts, two different matters do not; the person\'s "응 맞아" confirms the stated note. Soft checks are first-time questions. The bars are the product\'s and are not changed here.')
  built.plan.transport = 'product'
  if (built.estInputTokens * 1.1 > REPLAY_TOKEN_CEILING) throw new Error(`the replay's estimate ${built.estInputTokens} leaves no room under the ${REPLAY_TOKEN_CEILING} ceiling`)
  built.plan.tokenCeiling = REPLAY_TOKEN_CEILING
  return built
}

/**
 * replayTimingReport(results) -> { rows, chains, text }: per request the elapsed milliseconds and whether the socket was warm (transport "product"), and per turn start the sum of its
 * sequential requests against the turn-context budget of its socket (warm 2.5 s, cold 4 s). The runner's results file is the input; the key never appears in it.
 */
export function replayTimingReport(results, plan) {
  const res = results?.results ?? {}, rows = Object.entries(res).map(([id, r]) => ({ id, status: r.status, ms: r.elapsedMs ?? null, warm: r.warmBefore ?? null }))
  const chains = chainsOf().map(chain => {
    const mine = chain.ids.map(id => rows.find(r => r.id === id)).filter(Boolean)
    const sequential = chain.id === 'contradiction' ? Math.max(0, ...mine.map(r => r.ms ?? 0)) : mine.reduce((n, r) => n + (r.ms ?? 0), 0)
    const warm = mine.length > 0 && mine.every(r => r.warm !== false), budget = warm ? REPLAY_BUDGET.warmMs : REPLAY_BUDGET.coldMs
    return { id: chain.id, kind: chain.kind, requests: mine.length, ms: sequential, budget, within: mine.length > 0 ? sequential <= budget : null }
  })
  const lines = ['| request | status | ms | warm socket |', '|---|---|---|---|', ...rows.map(r => `| ${r.id} | ${r.status} | ${r.ms ?? '?'} | ${r.warm === null ? '?' : r.warm ? 'yes' : 'no'} |`), '',
    '| turn start | requests | sequential ms | budget ms | within |', '|---|---|---|---|---|', ...chains.map(c => `| ${c.id} (${c.kind}) | ${c.requests} | ${c.ms} | ${c.budget} | ${c.within === null ? '-' : c.within ? 'yes' : 'NO'} |`)]
  return { rows, chains, text: lines.join('\n') }
}
