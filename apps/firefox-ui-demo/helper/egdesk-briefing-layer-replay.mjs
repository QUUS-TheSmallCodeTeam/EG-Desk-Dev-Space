// Lane L4 cycle 46: a Decisions-only REPLAY of the briefing's defined layers on recorded real inputs, with no engine. The inputs are what Main's real runs recorded: the request and the twelve
// ledger materials of the realistic script (check-25br, 29br, 29bh), the answers of check-25br (a 3.7 KB table) and check-29br (one sentence), and the engine's own written fills of those runs
// (replayed as scripted fills: the engine is never called). The plan holds the exact request bodies the PRODUCT sends for the layers that are settled before and around the writing: material
// relevance (about_M#, the version pairs), the card kind (happened_M#), the order, the check of the written rows (slot_, step_) and the coverage facts (onboard_, stated_). It sends nothing and
// reads no key: Main sends it with the runner (dry run by default). The product rules that turn the answers into layers (kept materials incl. c41's linked and c44's voted, topic groups,
// card components, the part order, coverage) are NOT re-implemented: replayLayers() feeds the real answers back through runSkeletonFlow itself.
import { createHash } from 'node:crypto'
import { runSkeletonFlow, SKELETON_BARS } from './egdesk-briefing-skeleton.mjs'
import { DECISION_MODEL } from './egdesk-decision-client.mjs'
import { estimateBodyTokens } from './egdesk-decision-real-runner.mjs'
import { rig } from '../scripts/egdesk-briefing-rig.support.mjs'
import { folderMaterials } from './egdesk-real-engine-briefing-hook.mjs'
import { LOOP_ENTRIES, LOOP_SAY, buildLoopScript } from './egdesk-briefing-real-engine-script.mjs'
import { CHECK25BR_ANSWER, CHECK25BR_ON, CHECK29BR_ANSWER, CHECK29BR_DECISIONS, CHECK29BR_OFF_FINAL } from './egdesk-briefing-real-run.fixture.mjs'

export const LAYER_REPLAY_SET = 'l4-briefing-layer-replay'
export const LAYER_REPLAY_DIR = 'proofs/decision-real-measure/briefing-layer-replay'
export const LAYER_REPLAY_CEILING = 15000
const VIEWPORT = { x: 0, y: 0, width: 2400, height: 1400 }
const sha = bytes => createHash('sha256').update(bytes).digest('hex')
// the runner's fitted estimate (estimateBodyTokens: per question type and per ASCII / non-ASCII character); the old byte model under-counts Korean-heavy bodies
const est = wire => estimateBodyTokens(wire)
const SOURCE = 'egdesk-briefing-skeleton.mjs SKELETON_BARS { yes .7, no .3 }: isYes iff p >= .7 (acted on), isNo iff p <= .3 (decided no); between is undecided'
const FAMILIES = ['combines', 'about_M#', 'same_M#_M#', 'happened_M#', 'before_P#_P#', 'slot_P#_r#', 'step_P#', 'onboard_F#', 'stated_F#']
export const layerProductBars = () => Object.fromEntries(FAMILIES.map(f => [f, { yes: SKELETON_BARS.yes, no: SKELETON_BARS.no, source: SOURCE }]))

export const ledgerMaterials = () => folderMaterials(buildLoopScript().conversations[0].folder)
const stageOf = body => String(body.prompt_cache_key ?? '').replace('briefing-skeleton-', '')

/** One offline run of the product flow with a local provider (the answers come from `script(question)`; the fill is scripted from a recorded reply). */
async function flow({ request = LOOP_SAY, answer, materials, script = () => undefined, fill }) {
  const captured = [], cleanups = []
  const provider = async (_url, init) => { const body = JSON.parse(init.body); captured.push({ wire: init.body, names: body.questions.map(q => q.name), stage: stageOf(body) })
    return Response.json({ answers: body.questions.map(q => ({ name: q.name, type: 'predicate', probability: script(q) ?? .97 })), usage: { input_tokens: 1 } }) }
  const R = rig({ after: fn => cleanups.push(fn) }, { mode: 'on', handlerOptions: { fetchImpl: provider } })
  const root = '/decision/briefing-skeleton'
  const judge = { prepare: async dto => (await R.http('POST', `${root}/prepare`, dto)).body, run: async ticket => (await R.http('POST', `${root}/run`, { ticket, confirm: true })).body, cancel: async ticket => (await R.http('POST', `${root}/cancel`, { ticket })).body }
  try {
    const out = await runSkeletonFlow({ request, answer, materials, candidates: [], currentAnswerId: null, viewport: VIEWPORT, judge, fill, coverageCheck: 'facts' })
    return { out, captured }
  } finally { for (const fn of cleanups) fn() }
}
// the answers that steer the recorded flow: sure everywhere, the version pairs not versions, the measurement flow before the integration flow as the real judge ordered them (before_P1_P2 .08 / .09)
const STEER = q => (q.name.startsWith('same_') ? .03 : q.name === 'before_P1_P2' ? .09 : .97)
const recordedFill = reply => () => structuredClone(reply)

/** The code-built expectation of the topics: each ledger file's own topic word (its name) names the flow; the materials of one topic are one part, in the order of their files (date and time). */
export function expectedTopics(materials = ledgerMaterials()) {
  const groups = new Map()
  materials.forEach((m, i) => { const topic = /-([a-z][a-z0-9_]*)$/.exec(m.alias)?.[1] ?? '?'; if (!groups.has(topic)) groups.set(topic, []); groups.get(topic).push(`M${i + 1}`) })
  return [...groups.entries()].map(([topic, aliases]) => ({ topic, aliases }))
}
const boardText = out => (out.newComponents ?? []).map(c => c.markdown).join('\n')
const factOfRow = text => LOOP_ENTRIES.find(e => text.includes(e.fact))?.fact ?? null
export const boardIn = wire => JSON.parse(JSON.parse(wire).input[1].content.split('The board, its parts quoted in order as JSON: ')[1].split('\n\nThe materials, each quoted as JSON:')[0])
export const factsOf = wire => JSON.parse(wire).questions.filter(q => q.name.startsWith('onboard_')).map(q => ({ name: q.name, fact: JSON.parse(q.instructions.split('The fact, quoted exactly as a JSON string: ')[1].split('. Is this fact shown')[0]) }))

/** -> { plan, planBytes, files, requests, totals, flows } — deterministic; sends nothing. */
export async function buildLayerReplayPlan() {
  const materials = ledgerMaterials()
  if (materials.length !== 12) throw new Error(`layer replay: ${materials.length} materials`)
  const s25 = await flow({ answer: CHECK25BR_ANSWER, materials, script: STEER, fill: recordedFill(CHECK25BR_ON.at(-1)) })
  const s29 = await flow({ answer: CHECK29BR_ANSWER, materials, script: STEER, fill: recordedFill(CHECK29BR_OFF_FINAL) })
  const pick = (f, stage, index = 0) => { const c = f.captured.filter(x => x.stage === stage)[index]; if (!c) throw new Error(`layer replay: no ${stage} request (${f.captured.map(x => x.stage).join()})`); return c }
  if (s25.out.status !== 'presented') throw new Error(`layer replay: the check-25br flow is ${s25.out.status} ${s25.out.reason ?? ''}`)
  if (s29.out.status !== 'presented') throw new Error(`layer replay: the check-29br flow is ${s29.out.status} ${s29.out.reason ?? ''}`)
  // ---- code-built structure: two topics, one part each, in date order, a sequence card of every material
  const topics = expectedTopics(materials)
  if (topics.length !== 2 || topics.some(t => t.aliases.length !== 6)) throw new Error(`layer replay: topics ${JSON.stringify(topics)}`)
  const items = s25.out.guide.items, sameSets = items.map(i => [...i.materials].sort().join()).sort().join('|'), want = topics.map(t => [...t.aliases].sort().join()).sort().join('|')
  if (sameSets !== want || items.some(i => i.shows !== 'sequence' || i.component !== 'result_lines' || i.materials.some((a, k) => k && Number(a.slice(1)) < Number(i.materials[k - 1].slice(1))))) throw new Error('layer replay: the recorded materials do not group into two sequence parts')

  const YES = { min: SKELETON_BARS.yes }, NO = { max: SKELETON_BARS.no }
  const mk = (severity, name, rest, note) => ({ name, kind: 'predicate', ...rest, severity, note })
  const specs = []
  const place = pick(s29, 'place'), fit = pick(s29, 'fit'), cov = pick(s25, 'coverage')
  specs.push(['layer-place', place, place.names.map(n => n === 'combines' ? mk('soft', n, YES, 'recorded: check-29br\'s answer is one sentence that says the result is attached; the real judge said .97')
    : n.startsWith('about_') ? mk('soft', n, YES, 'the request asks to read the ledger folder: every entry is asked about. Real runs saw .05 to .32 for one entry (M10, M12) in five of twelve runs; c41 (linked) and c44 (voted) keep it, which replayLayers() checks')
    : mk('soft', n, NO, 'a title shared by two entries is not a version pair (they are different records of one log): real .03 to .32'))])
  specs.push(['layer-fit', fit, fit.names.map(n => mk('soft', n, YES, 'a dated entry of a log records something that happened: the card kind of both parts (a sequence of rows) rests on it; real 1 / .99'))])
  // coverage: the first six facts of the real check-25br answer (a table row each). A fact whose key figure is on the recorded board is expected NOT DECIDED "no" (hard: the product's own bar: only a decided no, p <= .3,
  // marks a fact missing and starts the re-design; an undecided one does not block) and, softly, shown (yes >= .7). c48 (Main's c59 run: F2 .53, F3 .69, F4 .67 failed the c46 hard yes): the board's rows are 76-90
  // characters and drop the prose cells of a table row (see egdesk-briefing-coverage-replay.mjs), the question asks for EVERY value, so those rows are rightly undecided, never a decided no. One that is not on the board is the known loss, recorded.
  { const board = JSON.stringify(boardIn(cov.wire)), facts = factsOf(cov.wire)
    specs.push(['layer-coverage', cov, cov.names.flatMap(n => {
      if (n.startsWith('stated_')) return [mk('soft', n, NO, 'a sentence about the answer itself restates nothing the materials say (c36)')]
      const fact = facts.find(x => x.name === n)?.fact ?? '', key = factOfRow(fact)
      return key === null ? [mk('soft', n, NO, 'a sentence about the answer itself (no entry key figure): no board can show it')]
        : board.includes(key) ? [{ name: n, kind: 'predicate', notDecidedNo: true, severity: 'hard', note: `the key figure "${key}" of this entry is on the recorded board: the product acts only on a decided no (p <= .3)` }, mk('soft', n, YES, `shown in full (yes >= .7): the board's row may leave out the row's prose cells (the 76-90 character row), which the question counts`)] : mk('soft', n, NO, `the key figure "${key}" is NOT on the recorded board (the known loss of a dense row): recorded`)
    })]) }

  const files = [], requests = []
  for (const [id, c, expect] of specs) {
    const bytes = Buffer.from(c.wire, 'utf8'), body = JSON.parse(c.wire)
    if (body.model !== DECISION_MODEL || Object.keys(body).some(k => !['model', 'input', 'questions', 'prompt_cache_key'].includes(k)) || body.questions.some(q => q.type !== 'predicate')) throw new Error(`${id}: not a plain predicate body`)
    files.push({ file: `requests/${id}.json`, bytes })
    requests.push({ id, file: `requests/${id}.json`, sha256: sha(bytes), estInputTokens: est(c.wire), ...(expect ? { expect } : { recordOnly: true, expect: [] }) })
  }
  const plan = { set: LAYER_REPLAY_SET, tokenCeiling: LAYER_REPLAY_CEILING, productBars: layerProductBars(),
    passRule: 'PASS when every hard check passes at the product bar (every fact of the check-25br table whose key figure is on the recorded board is judged shown) AND replayLayers() on the results finds what the code builds from the records: all twelve entries kept (about_ answers through the product rule, c41 linked / c44 voted included), two topics each one sequence card in date order, the card kind result_lines for both, and the twelve facts on the cards. The place and fit answers (about_, same_, happened_) are soft one by one: the product rules decide what they mean, and replayLayers() judges the result. Soft checks and the timings are recorded.',
    requests }
  const totals = { requests: requests.length, questions: specs.reduce((sum, [, c]) => sum + c.names.length, 0), bytes: files.reduce((sum, f) => sum + f.bytes.length, 0), estInputTokens: requests.reduce((sum, r) => sum + r.estInputTokens, 0) }
  if (totals.estInputTokens > LAYER_REPLAY_CEILING) throw new Error(`layer replay over the ceiling: ${totals.estInputTokens}`)
  return { plan, planBytes: Buffer.from(JSON.stringify(plan, null, 2) + '\n'), files, requests, totals,
    flows: { s25: { status: s25.out.status, stages: s25.captured.map(c => c.stage), kept: s25.out.relevance?.kept?.length, parts: items.map(i => [i.id, i.component, i.materials.join('/')]) }, s29: { status: s29.out.status, stages: s29.captured.map(c => c.stage) } } }
}

/**
 * replayLayers({ results }) -> the layers the PRODUCT would have decided from the answers the real Decision model gave (results: the runner's results file, or its `results` object).
 * The flow runs again offline on the check-29br inputs (request, one-sentence answer, the twelve materials, the engine's recorded complete fill): the place and fit questions are answered
 * by name from the results (a name nobody answered is .5, undecided, and counted). The stages the plan does not send are answered with what check-29br's own flow recorded (slot_ and
 * step_ sure, the part order .09 = the measurement flow first, the coverage facts of that answer: its two sentences about itself shown / not restating a material); `defaulted` says so.
 * Returns the layers, the checks the code builds from the records (hard / soft), and the per-request timings against the stage times check-29br's flow measured.
 */
const DEFAULTED = q => (q.name.startsWith('slot_') ? .98 : q.name.startsWith('step_') ? .95 : q.name === 'before_P1_P2' ? .09 : q.name.startsWith('onboard_') ? .9 : q.name.startsWith('stated_') ? .05 : null)
export async function replayLayers({ results }) {
  const rows = results?.results ?? results ?? {}, answered = new Map(), timings = [], defaulted = new Set(), unanswered = new Set()
  for (const [id, r] of Object.entries(rows)) {
    if (id !== 'layer-coverage') for (const a of r.answers ?? []) if (a?.type === 'predicate' && Number.isFinite(a.probability)) answered.set(a.name, a.probability) // coverage answers belong to the check-25br table, not to this flow
    timings.push({ id, ms: r.elapsedMs ?? null, status: r.status ?? null, inputTokens: r.usage?.input_tokens ?? null, outputTokens: r.usage?.output_tokens ?? null })
  }
  const materials = ledgerMaterials()
  const script = q => { if (answered.has(q.name)) return answered.get(q.name); const d = DEFAULTED(q); if (d !== null) { defaulted.add(q.name); return d } unanswered.add(q.name); return .5 }
  const run = await flow({ answer: CHECK29BR_ANSWER, materials, script, fill: recordedFill(CHECK29BR_OFF_FINAL) })
  const out = run.out, rel = out.relevance ?? {}, items = out.guide?.items ?? [], topics = expectedTopics(materials), text = boardText(out)
  const asked = materials.map((_, i) => `about_M${i + 1}`), sureAbout = asked.filter(n => (answered.get(n) ?? 0) >= SKELETON_BARS.yes).length
  const layers = { status: out.status, reason: out.reason ?? null, kept: rel.kept ?? [], dropped: rel.dropped ?? [], linked: rel.linked ?? [], voted: rel.voted ?? [], aboutSure: sureAbout, versions: rel.versions ?? [],
    parts: items.map(i => ({ id: i.id, shows: i.shows, component: i.component, materials: i.materials })), order: items.map(i => i.id), stages: out.stages ?? [], judgeRequests: out.stats?.judgeRequests ?? null,
    coverage: out.coverage ? { redesign: out.coverage.redesign ?? null, unshowable: out.coverage.unshowable ?? [] } : null }
  const partSets = items.map(i => [...i.materials].sort().join()).sort().join('|'), topicSets = topics.map(t => [...t.aliases].sort().join()).sort().join('|')
  const checks = [
    { name: 'twelve entries kept', severity: 'hard', pass: layers.kept.length === 12 && layers.dropped.length === 0, observed: { kept: layers.kept.length, dropped: layers.dropped, linked: layers.linked, voted: layers.voted, aboutSure: sureAbout } },
    { name: 'two topics, one part each', severity: 'hard', pass: items.length === 2 && partSets === topicSets, observed: { parts: layers.parts.map(p => p.materials.join('/')), expected: topics.map(t => t.aliases.join('/')) } },
    { name: 'each part is a sequence card of result_lines in date order', severity: 'hard', pass: items.length === 2 && items.every(i => i.shows === 'sequence' && i.component === 'result_lines' && i.materials.every((a, k) => !k || Number(a.slice(1)) > Number(i.materials[k - 1].slice(1)))), observed: layers.parts.map(p => [p.shows, p.component]) },
    { name: 'the twelve facts are on the cards', severity: 'hard', pass: LOOP_ENTRIES.every(e => text.includes(e.fact)), observed: { missing: LOOP_ENTRIES.filter(e => !text.includes(e.fact)).map(e => e.fact) } },
    { name: 'presented, not sent back to chat', severity: 'hard', pass: out.status === 'presented', observed: { status: out.status, reason: out.reason ?? null } },
    { name: 'every question had an answer (real or recorded)', severity: 'soft', pass: unanswered.size === 0, observed: { unanswered: [...unanswered], defaulted: [...defaulted] } },
    { name: 'the part order (record only)', severity: 'soft', pass: true, observed: { order: layers.order, note: 'the order is a recorded default (.09, the measurement flow first, as the real judge said in check-29br / 29bh / 25br); this plan does not send it' } },
  ]
  const recorded = Object.fromEntries(CHECK29BR_DECISIONS.map(d => [d.stage, d.ms])), stageMs = Object.fromEntries(timings.map(t => [t.id, t.ms]))
  const table = [['layer-place', 'place'], ['layer-fit', 'fit'], ['layer-coverage', 'coverage']].map(([id, stage]) => ({ id, ms: stageMs[id] ?? null, recordedMs: recorded[stage] ?? null }))
  return { layers, checks, hardFailures: checks.filter(c => c.severity === 'hard' && !c.pass).map(c => c.name), timings, table, totalMs: timings.reduce((sum, t) => sum + (t.ms ?? 0), 0), inputTokens: timings.reduce((sum, t) => sum + (t.inputTokens ?? 0), 0) }
}
