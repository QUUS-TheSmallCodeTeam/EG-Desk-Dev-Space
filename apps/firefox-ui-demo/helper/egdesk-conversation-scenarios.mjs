// Real-behaviour scenarios (L3 c20): the person's ACTUAL turns (masked conversation examples, helper/egdesk-conversation-examples.mjs)
// replayed through the product paths that receive such a turn today, in lane L2's all-on world (scripts/egdesk-all-on.support.mjs).
// Each scenario plays the exchange in order: the person's earlier turn (or a neutral opener when the log has none), the assistant
// message the person reacted to (scripted as the engine's answer), then the person's real turn; the Decision requests the product builds
// for that turn are recorded. Mock decisions only; the bodies are what a real measurement sends (Main sends).
//
//   kind              types it takes                    product path (what reads the turn)                     proposed expectation
//   triage_recall     referential                       turn memory triage (memory_triage: tn_recall)          tn_recall yes
//   triage_correction correction, instruction_change    turn memory triage                                     tn_courtesy no (a correction is not small talk)
//   triage_approval   approval, ambiguous               turn memory triage                                     tn_courtesy no (a go-ahead decides; soft)
//   triage_praise     praise                            turn memory triage                                     tn_courtesy yes (soft: praise often carries a request)
//   heartbeat_waiting pushback, frustration, interruption the person's turn as the request of a run that goes silent (a command, 25 s):
//                                                       the heartbeat's message judgment (heartbeat: message__note) note yes
//   context_reask     reask                             the turn's Decision context (turn_context: answer_type)  answer_type = answer
//   confirm_unstated  approval, ambiguous               record confirmation (egdesk-record-confirmation.mjs judgeConfirmation) with the
//                                                       real assistant message as the previous reply and one pending note it never stated
//                                                                                                          rc_stated no; rc_confirms no (soft)
// What the product cannot take today is said, not simulated: a message sent while a run is busy is refused (RUN_IN_PROGRESS; only a
// browser task's open question takes an in-run reply), so a nudge reaches the heartbeat only as the request of the next run.
import { createHash } from 'node:crypto'
import { TYPE_NAMES } from './egdesk-conversation-examples.mjs'

export const SCENARIO_KINDS = Object.freeze({
  triage_recall: { types: ['referential'], count: 2, cue: /아까|방금|전에|지난번|다시/, family: 'memory_triage', expect: [{ name: 'tn_recall', kind: 'predicate', min: 0.8, severity: 'hard', note: 'the person points back to something earlier' }] },
  triage_correction: { types: ['correction', 'instruction_change'], count: 2, family: 'memory_triage', expect: [{ name: 'tn_courtesy', kind: 'predicate', max: 0.2, severity: 'hard', note: 'a correction is not small talk' }] },
  triage_approval: { types: ['approval', 'ambiguous'], family: 'memory_triage', expect: [{ name: 'tn_courtesy', kind: 'predicate', max: 0.2, severity: 'soft', note: 'a go-ahead of the assistant\'s proposal decides something; whether the product question counts it as an acknowledgement is what is measured' }] },
  triage_praise: { types: ['praise'], family: 'memory_triage', expect: [{ name: 'tn_courtesy', kind: 'predicate', min: 0.8, severity: 'soft', note: 'praise only, when the turn carries no request (soft: real praise often does)' }] },
  heartbeat_waiting: { types: ['frustration', 'pushback', 'interruption'], count: 2, cue: /왜 ?(멈|안 ?하|벌써|이렇게)|빨리|언제 (돼|끝)|아직이야/, family: 'heartbeat', expect: [{ name: 'message__note', kind: 'predicate', min: 0.8, severity: 'hard', note: 'an impatient person, a command running, 25 s of silence: a short note is due' }] },
  context_reask: { types: ['reask'], family: 'turn_context', expect: [{ name: 'answer_type', kind: 'choice', equals: 'answer', minConfidence: 0.75, severity: 'hard', note: 'the person asks to have something explained' }] },
  confirm_unstated: { types: ['approval', 'ambiguous'], family: 'record_confirmation', expect: [{ name: 'rc_stated_0', kind: 'predicate', max: 0.2, severity: 'hard', note: 'the real assistant message never mentions the note' },
    { name: 'rc_confirms_0', kind: 'predicate', max: 0.2, severity: 'soft', note: 'the go-ahead answers the assistant\'s proposal, not the note' }] },
})
export const SCENARIO_PRODUCT_BARS = Object.freeze({
  tn_recall: { yes: 0.8, no: 0.2, source: 'turn memory triage yes/no bar (egdesk-turn-memory, DEFAULT bars .8/.2)' }, tn_courtesy: { yes: 0.8, no: 0.2, source: 'turn memory triage' },
  message__note: { yes: 0.8, no: 0.2, source: 'helper/egdesk-heartbeat-judge.mjs BEAT_PREDICATE_YES .8' },
  answer_type: { minConfidence: 0.75, source: 'helper/egdesk-decision-questions.mjs DEFAULT_DECISION_THRESHOLDS.choice .75' },
  'rc_stated_#': { yes: 0.8, no: 0.2, source: 'CONFIRM_BARS' }, 'rc_confirms_#': { yes: 0.8, no: 0.2, source: 'CONFIRM_BARS' },
})
// The one pending note of confirm_unstated (synthetic: the harness's public wiki page "PostgreSQL 이전"), never mentioned by the real reply.
export const UNSTATED_NOTE = Object.freeze({ title: 'PostgreSQL 이전', status: 'done' })
export const NEUTRAL_OPENER = '이어서 진행해 줘'

/** pickScenarios(examples, labels) → [{ kind, example, labelledBy }]: one example per kind, labelled yes first, else a heuristic candidate. */
export function pickScenarios(examples, labels = new Map(), { prefer = [] } = {}) {
  const out = [], used = new Set()
  const yesFor = def => e => { const l = labels.get(e.id); return l && def.types.some(t => l[t] === 'yes') }
  // Kinds with the fewest labelled examples choose first, so one labelled turn is not spent where another could serve.
  const kinds = Object.entries(SCENARIO_KINDS).map(([kind, def], i) => ({ kind, def, i, n: examples.filter(yesFor(def)).length }))
    .sort((a, b) => ((a.n || Infinity) - (b.n || Infinity)) || a.i - b.i)
  for (const { kind, def } of kinds) {
    // a real assistant message (not an automation stub such as "No response requested.") and a turn short enough to read alone
    const ok = e => !used.has(e.id) && e.prev && e.prev.text.length >= 40 && !/^No response requested/i.test(e.prev.text) && e.user.text.length >= 2 && e.user.text.length <= 400
    const yes = yesFor(def)
    // earlier types of the kind first (e.g. frustration before pushback), then the shorter turn
    const rank = e => { const tags = labels.get(e.id) ? def.types.filter(t => labels.get(e.id)[t] === 'yes') : e.tags; const i = def.types.findIndex(t => tags.includes(t)); return i < 0 ? def.types.length : i }
    const cue = e => (def.cue && def.cue.test(e.user.text) ? 0 : 1)
    const order = list => [...list].sort((a, b) => (prefer.includes(b.id) - prefer.includes(a.id)) || (cue(a) - cue(b)) || (rank(a) - rank(b)) || (a.user.text.length - b.user.text.length) || (a.id < b.id ? -1 : 1))
    for (let n = 0; n < (def.count ?? 1); n++) {
      const labelled = order(examples.filter(e => ok(e) && yes(e)))
      const heuristic = order(examples.filter(e => ok(e) && !labels.has(e.id) && def.types.some(t => e.tags.includes(t))))
      const e = labelled[0] ?? heuristic[0]
      if (!e) break
      used.add(e.id); out.push({ kind, example: e, labelledBy: labelled[0] ? 'decision_model' : 'heuristic' })
    }
  }
  return out.sort((a, b) => Object.keys(SCENARIO_KINDS).indexOf(a.kind) - Object.keys(SCENARIO_KINDS).indexOf(b.kind))
}

const sha = text => createHash('sha256').update(text).digest('hex')
/**
 * runScenario({ kind, example }, { allOnWorld, makeClient }) → { kind, requests: [{ family, names, body }], target: { family, body } | null, seen }
 * allOnWorld: lane L2's world factory; makeClient: (fetchImpl) => a product Decisions client (confirm_unstated only).
 */
export async function runScenario({ kind, example }, { allOnWorld, judgeConfirmation, makeClient }) {
  const def = SCENARIO_KINDS[kind]
  const cleanups = [], t = { after: fn => cleanups.push(fn) }
  try {
    if (kind === 'confirm_unstated') {
      const captured = []
      const client = makeClient(async (url, init) => { captured.push(String(init.body)); const wire = JSON.parse(init.body)
        return { ok: true, status: 200, headers: { get: () => null }, text: async () => JSON.stringify({ answers: wire.questions.map(q => ({ type: 'predicate', name: q.name, probability: /stated/.test(q.name) ? 0.03 : 0.04 })), usage: { input_tokens: 10 } }) } })
      const verdict = await judgeConfirmation({ message: example.user.text, previousAnswer: example.prev.text, records: [UNSTATED_NOTE], client })
      return { kind, requests: captured.map(body => ({ family: def.family, names: JSON.parse(body).questions.map(q => q.name), body })), target: captured[0] ? { family: def.family, body: captured[0] } : null,
        seen: { action: verdict.verdicts?.[0]?.action ?? null, status: verdict.status } }
    }
    const w = allOnWorld(t)
    await w.settings.turnMemory.save('on')
    if (kind === 'heartbeat_waiting') {
      w.step('turn'); await w.send(example.user.text); await w.idle()
      const timing = w.timing()
      await w.notify('item/started', { ...timing, item: { id: 'cmd-1', type: 'commandExecution', command: 'npm test', cwd: '/work', status: 'inProgress', commandActions: [] } })
      await w.advance(25_000); await w.idle()
      await w.notify('item/completed', { ...timing, item: { id: 'cmd-1', type: 'commandExecution', command: 'npm test', cwd: '/work', status: 'completed', exitCode: 0, commandActions: [], aggregatedOutput: 'ok\n' } })
      await w.answer(example.next?.text || '진행했습니다.'); await w.idle()
    } else {
      w.step('before'); await w.send(example.before?.text || NEUTRAL_OPENER); await w.idle(); await w.answer(example.prev.text); await w.idle()
      w.step('turn'); await w.send(example.user.text); await w.idle(); await w.answer(example.next?.text || '네.'); await w.idle()
    }
    const rows = w.decisionsIn('turn')
    const requests = rows.map(d => ({ family: d.feature, names: JSON.parse(d.raw).questions.map(q => q.name), body: d.raw }))
    const target = requests.find(r => r.family === def.family && def.expect.every(e => r.names.includes(e.name))) ?? null
    return { kind, requests, target, seen: { posted: w.history().filter(([role]) => role === 'assistant').length } }
  } finally { for (const fn of cleanups.reverse()) { try { await fn() } catch { /* cleanup */ } } }
}

/** scenarioPlan(results, { estimate, chunkTokens }) → { plan, requests: [{ file, body }], preregistration } (target bodies only). */
export function scenarioPlan(results, { estimate, chunkTokens = 12_000, set = 'conversation-scenarios-001' }) {
  const items = results.filter(r => r.target).map(r => ({ id: `${r.kind}-${r.example.id}`, body: r.target.body, r }))
  const requests = items.map(i => ({ file: `requests/${i.id}.json`, body: i.body }))
  const rows = items.map(i => ({ id: i.id, file: `requests/${i.id}.json`, sha256: sha(i.body), estInputTokens: estimate(i.body), expect: SCENARIO_KINDS[i.r.kind].expect }))
  const total = rows.reduce((n, r) => n + r.estInputTokens, 0)
  const plan = { set, tokenCeiling: Math.min(Math.ceil(total * 1.25), chunkTokens), productBars: SCENARIO_PRODUCT_BARS, seeds: [{ id: 'conversation-examples', privacy: 'owner-approved' }],
    passRule: 'Pass: every hard expectation holds. Each request is the product\'s own body for the person\'s real turn (masked), replayed in lane L2\'s all-on world after the assistant message it reacted to. The expectations are PROPOSED (L3 c20) and pre-registered here before any send.',
    requests: rows }
  const preregistration = items.map(i => ({ id: i.id, kind: i.r.kind, family: SCENARIO_KINDS[i.r.kind].family, labelledBy: i.r.labelledBy, types: SCENARIO_KINDS[i.r.kind].types.filter(t => i.r.example.tags.includes(t) || i.r.labelledBy === 'decision_model'),
    area: i.r.example.area, provenance: i.r.example.source, expect: SCENARIO_KINDS[i.r.kind].expect, status: 'proposed' }))
  return { plan, requests, preregistration, total }
}
export { TYPE_NAMES }
