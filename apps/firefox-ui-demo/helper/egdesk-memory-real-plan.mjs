import { createHash } from 'node:crypto'
import { buildWiki, ternary } from './egdesk-wiki-reconstruction.mjs'
import { SYNTHETIC_PAGES, choiceAnswer, mockSpeechAnswer } from './egdesk-wiki-reconstruction.fixture.mjs'
import { prepareTurnMemory } from './egdesk-turn-memory.mjs'
import { readChoice } from './egdesk-decision-questions.mjs'

// END-TO-END real-measurement plan for the whole turn-memory loop (triage -> first-turn reconstruction or mid-session fetch -> write judgment)
// on the public synthetic wiki, three scenarios x first/mid position = 6 runs.
//
// Why "teacher forcing": the loop is adaptive (round 2 is built from the answers of round 1), so a request body cannot be fixed offline
// unless the earlier answers are fixed. The PRODUCT CODE therefore builds every request while a scripted client answers with the
// PRE-REGISTERED expectations; each recorded request is then sent as is and scored against the expectation for that stage only. Every stage is
// measured on identical input and a wrong early answer cannot hide or distort a later stage. What this does NOT measure: error propagation in a
// live loop (a wrong scan answer changing the next request). A live pass can follow if this one passes.
//
// Thresholds are the product's own: predicate yes >= 0.8, no <= 0.2; choice accepted at confidence 0.75 and margin 0.2.

export const ASKED_AT = Date.parse('2026-11-24T14:30:00+09:00')
export const SCOPE = Object.freeze({ allowedScopes: ['dm:this-room'], writeScope: 'dm:this-room' })
const NOT = (prefixes, ids = []) => ({ prefixes, ids })
const OFF_TOPIC_PG = NOT(['quote/', 'jev/', 'misc/'], ['db/redis'])
const OFF_TOPIC_A = NOT(['db/', 'jev/', 'misc/'], ['quote/b-request', 'quote/b-v1', 'quote/c-contract', 'quote/parts'])
const OFF_TOPIC_J = NOT(['quote/', 'db/', 'misc/'])

// forced: what the scripted client answers yes to (so the product builds the next request). must/mustNot/soft: what is scored.
export const RUNS = Object.freeze([
  { id: 'pg-first', message: 'PostgreSQL 마이그레이션 배포 끝났어', position: 'first', held: [],
    triage: { courtesy: 'no', need: 'yes', record: 'yes' }, scan: ['db/pg-plan', 'db/pg-design', 'db/pg-health'], open: ['db/sqlite-schema', 'db/pg-followup', 'db/pg-rollback'],
    status: { 'db/pg-plan': 'plan', 'db/pg-design': 'done' }, write: { target: 'db/pg-plan', status: 'done', form: 'assertion', time: 'past_unspecified' },
    hard: { triage: { courtesy: 'no', record: 'yes' }, mustPick: ['db/pg-plan'], mustNot: OFF_TOPIC_PG, status: { 'db/pg-plan': 'plan', 'db/pg-design': 'done' }, write: { target: 'db/pg-plan', status: 'done' } },
    soft: { open: ['db/sqlite-schema', 'db/pg-followup'], labels: { form: 'assertion' } } },
  { id: 'pg-mid', message: 'PostgreSQL 마이그레이션 배포 끝났어', position: 'mid', held: ['db/pg-design', 'db/pg-plan', 'db/pg-rollback', 'db/sqlite-schema'],
    triage: { courtesy: 'no', need: 'yes', record: 'yes' }, scan: ['db/pg-health', 'db/pg-followup'], open: [], status: { 'db/pg-health': 'done', 'db/pg-followup': 'plan' },
    write: { target: 'db/pg-plan', status: 'done', form: 'assertion', time: 'past_unspecified' },
    hard: { triage: { courtesy: 'no', needNotNo: true, record: 'yes' }, mustPick: ['db/pg-health', 'db/pg-followup'], mustNot: NOT([], ['db/pg-bench']), heldNeverScanned: true, write: { target: 'db/pg-plan', status: 'done' } },
    soft: { triageNeed: 'yes', labels: { form: 'assertion' } } },
  { id: 'a-first', message: '지난주 A사 견적 건 어디까지 됐지?', position: 'first', held: [],
    triage: { courtesy: 'no', need: 'yes', record: 'no' }, scan: ['quote/a-request', 'quote/a-v1', 'quote/a-v2-plan'], open: ['quote/a-meeting', 'quote/a-decision'],
    status: { 'quote/a-v2-plan': 'plan', 'quote/a-meeting': 'reported_by_other', 'quote/a-v1': 'done' }, write: null,
    hard: { triage: { courtesy: 'no', record: 'no' }, mustPick: ['quote/a-v1', 'quote/a-v2-plan'], mustNot: OFF_TOPIC_A, status: { 'quote/a-v2-plan': 'plan', 'quote/a-meeting': 'reported_by_other' }, noPrivate: 'quote/a-cost' },
    soft: { open: ['quote/a-meeting', 'quote/a-decision'] } },
  { id: 'a-mid', message: '지난주 A사 견적 건 어디까지 됐지?', position: 'mid', held: ['quote/a-request', 'quote/a-v1'],
    triage: { courtesy: 'no', need: 'yes', record: 'no' }, scan: ['quote/a-v2-plan', 'quote/a-decision', 'quote/a-meeting'], open: [], status: { 'quote/a-v2-plan': 'plan', 'quote/a-meeting': 'reported_by_other' }, write: null,
    hard: { triage: { courtesy: 'no', needNotNo: true, record: 'no' }, mustPick: ['quote/a-v2-plan'], mustNot: NOT([]), heldNeverScanned: true, status: { 'quote/a-v2-plan': 'plan', 'quote/a-meeting': 'reported_by_other' }, noPrivate: 'quote/a-cost' },
    soft: { triageNeed: 'yes', pick: ['quote/a-decision', 'quote/a-meeting'] } },
  { id: 'j-first', message: '아까 jev hook 흐름 다시 정리해줘', position: 'first', held: [],
    triage: { courtesy: 'no', need: 'yes', record: 'no' }, scan: ['jev/flow-note', 'jev/utt-user', 'jev/draft'], open: ['jev/utt-agent'], status: { 'jev/draft': 'plan' }, write: null,
    hard: { triage: { courtesy: 'no', record: 'no' }, mustPick: ['jev/flow-note'], mustNot: OFF_TOPIC_J, status: { 'jev/draft': 'plan' } }, soft: { open: ['jev/utt-agent'], pick: ['jev/utt-user', 'jev/draft'] } },
  { id: 'j-mid', message: '아까 jev hook 흐름 다시 정리해줘', position: 'mid', held: ['jev/draft', 'jev/utt-user'],
    triage: { courtesy: 'no', need: 'yes', record: 'no' }, scan: ['jev/flow-note', 'jev/utt-agent'], open: [], status: {}, write: null,
    hard: { triage: { courtesy: 'no', needNotNo: true, record: 'no' }, mustPick: ['jev/flow-note'], mustNot: NOT([]), heldNeverScanned: true }, soft: { triageNeed: 'yes', pick: ['jev/utt-agent'] } },
])

const sha = text => createHash('sha256').update(text).digest('hex')
export const estimateTokens = (choiceQ, predQ, bytes) => Math.round(56.5 * choiceQ + 134.8 * predQ + 0.1983 * bytes) // typed model solved from the three real requests of 2026-11-24
const blocks = (content, header) => {
  if (typeof content !== 'string' || !content.startsWith(header)) return []
  return content.slice(header.length).split(/\n\n(?=P\d+ \|)/).map(b => /^(P\d+) \| ([^\n]*)/.exec(b)).filter(Boolean).map(m => ({ alias: m[1], title: m[2].split(' | ').at(-1) }))
}

/** A client that answers with the run's pre-registered expectations and records every request the product code builds. */
function scriptedClient(run, wiki, recorded) {
  const idOfTitle = new Map([...wiki.pages.values()].map(p => [p.title, p.id]))
  const yesNo = (v) => ({ type: 'predicate', probability: v ? 0.97 : 0.02 })
  return { async decide(request) {
    const texts = request.input.map(m => (typeof m.content === 'string' ? m.content : ''))
    const find = header => texts.find(t => t.startsWith(header))
    const map = header => Object.fromEntries(blocks(find(header), header).map(b => [b.alias, idOfTitle.get(b.title) ?? null]))
    const aliases = { ...map('Pages:\n'), ...map('Picked pages:\n'), ...map('Linked pages you may open:\n'), ...map('Candidate pages:\n') }
    const answers = {}
    for (const q of request.questions) {
      if (q.name === 'tn_courtesy') answers[q.name] = yesNo(run.triage.courtesy === 'yes')
      else if (q.name === 'tn_need') answers[q.name] = yesNo(run.triage.need === 'yes')
      else if (q.name === 'tn_record') answers[q.name] = yesNo(run.triage.record === 'yes')
      else if (/^pg_\d+$/.test(q.name)) answers[q.name] = yesNo(run.scan.includes(aliases[`P${Number(q.name.slice(3)) + 1}`]))
      else if (/^op_P\d+$/.test(q.name)) answers[q.name] = yesNo(run.open.includes(aliases[q.name.slice(3)]))
      else if (/^st_P\d+$/.test(q.name)) answers[q.name] = choiceAnswer(q, run.status[aliases[q.name.slice(3)]] ?? 'unknown', 0.95)
      else if (q.name === 'tw_target') answers[q.name] = choiceAnswer(q, Object.entries(aliases).find(([, id]) => id === run.write?.target)?.[0] ?? 'none', 0.95)
      else if (q.name === 'tw_status') answers[q.name] = choiceAnswer(q, run.write?.status ?? 'unknown', 0.95)
      else if (/^tw_link_\d+$/.test(q.name)) answers[q.name] = yesNo(false)
      else if (/^speech_/.test(q.name)) answers[q.name] = mockSpeechAnswer(q)
    }
    recorded.push({ questions: request.questions, input: request.input, aliases, scripted: answers })
    return { answers, usage: { inputTokens: 0 }, model: 'scripted', latencyMs: 0 }
  } }
}

const receiptsFor = (wiki, ids, threadKey) => ({ usable: true, threadKey, pages: Object.fromEntries(ids.map(id => [id, { revision: wiki.pages.get(id).revision, hash: wiki.pages.get(id).contentKey ?? sha(wiki.pages.get(id).body) }])) })

/** Build the six runs offline: every request body, its sha256, size and expected tokens. Nothing is sent. */
export async function buildPlan({ pages = SYNTHETIC_PAGES, askedAt = ASKED_AT } = {}) {
  const wiki = buildWiki(pages)
  const runs = []
  for (const run of RUNS) {
    const recorded = []
    const client = scriptedClient(run, wiki, recorded)
    const position = run.position === 'mid' ? { kind: 'mid', reason: 'live_thread' } : { kind: 'first', reason: 'no_native_thread' }
    const memory = await prepareTurnMemory({ message: run.message, wiki, client, scope: SCOPE, askedAt, position, threadKey: 'thread-1', ontologyWrite: true,
      budget: run.position === 'mid' ? { linksFirst: true } : {}, delivered: run.held.length ? receiptsFor(wiki, run.held, 'thread-1') : null })
    if (memory.judgeWrite) await memory.judgeWrite()
    const requests = recorded.map((r, index) => {
      const names = r.questions.map(q => q.name)
      const stage = names.includes('tn_courtesy') ? 'triage' : names.some(n => n.startsWith('tw_')) ? 'write' : names.some(n => /^pg_/.test(n)) ? 'scan' : 'expand'
      const body = { model: 'gpt-6-luna', input: r.input, questions: r.questions }
      const text = JSON.stringify(body)
      const choice = r.questions.filter(q => q.type === 'choice').length, predicate = r.questions.length - choice
      return { name: `${run.id}-${index + 1}-${stage}`, stage, body, bytes: Buffer.byteLength(text), sha256: sha(text), questions: names.length, choice, predicate, estInputTokens: estimateTokens(choice, predicate, Buffer.byteLength(text)), aliases: r.aliases, scripted: r.scripted }
    })
    runs.push({ id: run.id, message: run.message, position: run.position, held: run.held, requests, estInputTokens: requests.reduce((n, r) => n + r.estInputTokens, 0) })
  }
  const totals = { runs: runs.length, requests: runs.reduce((n, r) => n + r.requests.length, 0), estInputTokens: runs.reduce((n, r) => n + r.estInputTokens, 0), bytes: runs.reduce((n, r) => n + r.requests.reduce((m, q) => m + q.bytes, 0), 0) }
  return { wiki, runs, totals }
}

// ---- scoring: per stage, against the pre-registered expectation of that run ----
const state = answer => ternary(answer)
function answerMap(list) {
  const out = {}
  for (const a of Array.isArray(list) ? list : []) {
    if (!a || typeof a.name !== 'string') continue
    out[a.name] = a.type === 'choice' ? { ...a, probabilities: [...(a.probabilities ?? [])].sort((x, y) => y.probability - x.probability) } : a
  }
  return out
}

/** score(runDef, planRun, resultsByRequestName) -> { id, pass, hardFailures, checks }. results: { [name]: { status, answers: [...] } } */
export function scoreRun(def, planRun, results, wiki) {
  const checks = []
  const add = (severity, name, ok, detail = null) => checks.push({ severity, name, ok, ...(detail === null ? {} : { detail }) })
  const answersOf = request => answerMap(results[request.name]?.answers)
  for (const request of planRun.requests) {
    const r = results[request.name]
    if (!r || r.status !== 200) { add('hard', `${request.name}: HTTP 200 with typed answers`, false, r?.status ?? 'not sent'); continue }
    const a = answersOf(request)
    const complete = request.body.questions.every(q => a[q.name]?.type === q.type)
    add('hard', `${request.name}: every question answered with its own type`, complete)
    if (request.stage === 'triage') {
      const c = state(a.tn_courtesy), n = state(a.tn_need), rec = state(a.tn_record)
      add('hard', 'triage courtesy is decided and as pre-registered', c.state === def.hard.triage.courtesy, `p=${c.p}`)
      add('hard', 'triage record is decided and as pre-registered', rec.state === def.hard.triage.record, `p=${rec.p}`)
      if (def.hard.triage.needNotNo) add('hard', 'triage need is not a decided "no" (a wrong skip loses material)', n.state !== 'no', `p=${n.p}`)
      if (def.soft.triageNeed) add('soft', 'triage need is a decided yes', n.state === def.soft.triageNeed, `p=${n.p}`)
    }
    if (request.stage === 'scan') {
      const pickedIds = []
      for (const [alias, id] of Object.entries(request.aliases)) {
        const v = state(a[`pg_${Number(alias.slice(1)) - 1}`])
        if (id && v.state === 'yes') pickedIds.push(id)
        if (id && def.hard.mustPick?.includes(id)) add('hard', `scan picks ${id}`, v.state === 'yes', `p=${v.p}`)
        const off = def.hard.mustNot
        if (id && off && (off.ids?.includes(id) || off.prefixes?.some(pre => id.startsWith(pre)))) add('hard', `scan does not pick ${id}`, v.state !== 'yes', `p=${v.p}`)
        if (id && def.soft.pick?.includes(id)) add('soft', `scan picks ${id}`, v.state === 'yes', `p=${v.p}`)
      }
      if (def.hard.heldNeverScanned) add('hard', 'held pages are not among the scanned options', !Object.values(request.aliases).some(id => def.held.includes(id)))
      if (def.hard.noPrivate) add('hard', 'the private-scope page was never offered', !Object.values(request.aliases).includes(def.hard.noPrivate))
    }
    if (request.stage === 'expand') {
      for (const [alias, id] of Object.entries(request.aliases)) {
        if (a[`st_${alias}`] && def.hard.status?.[id]) {
          const read = readChoice({ x: a[`st_${alias}`] }, 'x', { minConfidence: 0.75, minMargin: 0.2 })
          add('hard', `status of ${id} reads as ${def.hard.status[id]}`, read.state === 'accepted' && read.value === def.hard.status[id], `read=${read.value}/${read.state}`)
        }
        if (a[`op_${alias}`] && def.soft.open?.includes(id)) add('soft', `link to ${id} is opened`, state(a[`op_${alias}`]).state === 'yes', `p=${state(a[`op_${alias}`]).p}`)
        if (a[`op_${alias}`] && def.soft.pick?.includes(id)) add('soft', `link to ${id} is opened`, state(a[`op_${alias}`]).state === 'yes', `p=${state(a[`op_${alias}`]).p}`)
      }
    }
    if (request.stage === 'write' && def.write) {
      const target = readChoice({ x: a.tw_target }, 'x', { minConfidence: 0.75, minMargin: 0.2 })
      const expectedAlias = Object.entries(request.aliases).find(([, id]) => id === def.hard.write.target)?.[0]
      add('hard', `write target is ${def.hard.write.target}`, target.state === 'accepted' && target.value === expectedAlias, `read=${target.value}/${target.state}`)
      const status = readChoice({ x: a.tw_status }, 'x', { minConfidence: 0.75, minMargin: 0.2 })
      add('hard', `write status is ${def.hard.write.status}`, status.state === 'accepted' && status.value === def.hard.write.status, `read=${status.value}/${status.state}`)
      // Installed speech labels must not be wrong (an uninstalled label is not a failure)
      for (const axis of ['form']) {
        const want = def.soft.labels?.[axis]
        const read = readChoice({ x: a[`speech_${axis}_0`] }, 'x', { minConfidence: 0.85, minMargin: 0.2 })
        if (want) add('soft', `isolated ${axis} label, when installed, is ${want}`, read.state !== 'accepted' || read.value === want, `read=${read.value}/${read.state}`)
      }
    }
  }
  // Pre-registered shape of the run: no write request when the turn is not worth recording.
  if (!def.write) add('hard', 'no write judgment request is made when triage says "not worth recording"', !planRun.requests.some(r => r.stage === 'write'))
  const hard = checks.filter(c => c.severity === 'hard')
  const hardFailures = hard.filter(c => !c.ok)
  return { id: def.id, pass: hardFailures.length === 0, hardFailures: hardFailures.map(c => c.name), hardTotal: hard.length, softMisses: checks.filter(c => c.severity === 'soft' && !c.ok).map(c => c.name), checks }
}

/** Whole measurement: passes when at least 5 of 6 runs have no hard failure AND every triage hard check holds in all six. */
export function scorePlan(plan, results) {
  const scored = RUNS.map(def => scoreRun(def, plan.runs.find(r => r.id === def.id), results, plan.wiki))
  const triageFailures = scored.flatMap(s => s.checks.filter(c => c.severity === 'hard' && !c.ok && /^triage/.test(c.name)))
  return { runsPassed: scored.filter(s => s.pass).length, pass: scored.filter(s => s.pass).length >= 5 && triageFailures.length === 0, triageFailures: triageFailures.map(c => c.name), scored }
}
