import { createHash } from 'node:crypto'
import { DECISION_MODEL } from './egdesk-decision-client.mjs'
import { independentEstimate } from './egdesk-decision-real-runner.mjs'
import { SPEECH_SPLIT, SPEECH_SPLIT_BARS, SPEECH_SPLIT_KEYS, speechSegments, speechSplitQuestions, splitLabels } from './egdesk-speech-grounding.mjs'
import { judgeTurnWrite } from './egdesk-turn-memory.mjs'
import { SENTENCES, STUDY_ASKED_AT, labelsFile } from './egdesk-utterance-threshold-study.mjs'

// PREPARED, NOT SENT. Re-measure of the source and time axes with the 'split-isolated' design (egdesk-speech-grounding.mjs), on the SAME
// frozen labels as the 60-sentence threshold study (labels.json sha256 d29d9007..., lane L6; nothing here changes a label).
// Selection criteria, fixed before any request was built (L7 c20):
//   1 Unit: one sentence and ONE axis per request. The input is the product's write-judgment input for that sentence (judgeTurnWrite,
//     'about', no stored record, the study clock), the questions are the product's split predicates of that axis only. tw_status and form are
//     not asked: they are not under study and the form question is unchanged. (A body with both axes, form and tw_status costs about 2,900
//     estimated tokens per sentence; the 55 sentences whose source or time axis was not installed would need about 160k, over the 25k cap.)
//   2 Targets: clear axes (allowed set is not only "unknown") NOT installed at .85 in the study, one or two per failure class seen there:
//       source  bare plan, bare question -> unspecified (c20 .78, c15 .57); plain statement given self_reported_observation (c26 and c30,
//               both WRONG at .80); a read mail given self_reported_observation (c22, wrong top label); inference just under the bar (c12 .78)
//       time    "방금" split between anchored and unspecified (c32 .47/.47); ongoing under the bar (c07 .57); "아침부터 ... 안 와" given
//               past_anchored (c37, WRONG at .80); "3년째 ~고 있어" given past_anchored (c30, wrong top label); "지금" under the bar (c08 .49)
//   3 Guards: deliberately ambiguous axes (allowed only "unknown"), where any install is wrong: source a09, a14; time a13, a16 (their top
//     labels in the study were wrong ones under the bar).
//   4 Controls: axes installed correctly at .85 in the study: source c01 (own), c02 (other), c10 (record); time c01 (past_anchored),
//     c04 (future_anchored), c26 (past_anchored, "작년 이맘때").
// Pre-registered outcome (hard, judged by analyzeSplit at the product bar yes >= .85 / no <= .15, code combination splitLabels):
//   0 wrong installs over all 21 requests. Coverage (soft): targets installed correctly > 0 of 11 (the study installed 0 of these 11);
//   predicted 6 or more; controls 6 of 6 installed correctly; guards 0 installs.
export const SPLIT_SET = 'axis-split-v1'
export const SPLIT_DIR = 'proofs/decision-real-measure/axis-split'
export const SPLIT_LABELS_SHA = 'd29d9007bd871377dd2e30fb9c6b84fae98b401072abad2cca5eb76249d1b7aa'
export const SPLIT_TOKEN_CEILING = 25000
export const SPLIT_CHUNK_CEILING = 12000
export const SPLIT_SELECTION = Object.freeze({
  source: Object.freeze({ targets: ['c20', 'c15', 'c26', 'c30', 'c22', 'c12'], guards: ['a09', 'a14'], controls: ['c01', 'c02', 'c10'] }),
  time: Object.freeze({ targets: ['c32', 'c07', 'c37', 'c30', 'c08'], guards: ['a13', 'a16'], controls: ['c01', 'c04', 'c26'] }),
})
// Chunks: source in one, time in two (each under SPLIT_CHUNK_CEILING).
export const SPLIT_CHUNKS = Object.freeze([['source', null], ['time', 0, 5], ['time', 5, 10]])
const U = 'unknown'
const sha = bytes => createHash('sha256').update(bytes).digest('hex')
const LABEL_OF = { other: 'attributed_report', own: 'self_reported_observation', record: 'record_based', guess: 'inference' }
const DIRECTION_OF = { past_anchored: 'before', past_unspecified: 'before', at_utterance: 'now', ongoing_no_end: 'ongoing', future_anchored: 'after', future_unspecified: 'after' }
const name = key => `speechs_${key}_0`
const roleOf = (axis, id) => (SPLIT_SELECTION[axis].targets.includes(id) ? 'target' : SPLIT_SELECTION[axis].guards.includes(id) ? 'guard' : 'control')

/** Soft expectations from the frozen allowed set (what a correct install needs); none on a guard axis. */
export function expectationsFor(axis, allowed) {
  const S = allowed.filter(v => v !== U)
  if (!S.length) return []
  const out = [], max = (key, why) => out.push({ name: name(key), kind: 'predicate', max: SPEECH_SPLIT_BARS.no, severity: 'soft', note: why }),
    min = (key, why) => out.push({ name: name(key), kind: 'predicate', min: SPEECH_SPLIT_BARS.yes, severity: 'soft', note: why })
  if (axis === 'source') {
    for (const key of SPEECH_SPLIT_KEYS.source) {
      if (!S.includes(LABEL_OF[key])) max(key, `${LABEL_OF[key]} is not an allowed label`)
      else if (S.length === 1) min(key, `${LABEL_OF[key]} is the only allowed label`)
    }
    return out
  }
  const dirs = new Set(S.map(v => DIRECTION_OF[v]))
  for (const key of ['before', 'now', 'ongoing', 'after']) {
    if (key === 'now' && dirs.has('ongoing')) continue // {now, ongoing} combines to ongoing_no_end: now is free there
    if (!dirs.has(key)) max(key, `no allowed label is ${key}`)
    else if (dirs.size === 1) min(key, `every allowed label is ${key}`)
  }
  const dated = S.filter(v => /_(anchored|unspecified)$/.test(v))
  if (dated.length === S.length && dated.every(v => v.endsWith('_anchored'))) min('when', 'every allowed label is anchored')
  if (dated.length === S.length && dated.every(v => v.endsWith('_unspecified'))) max('when', 'every allowed label is unspecified')
  return out
}

const recorder = () => { const seen = []; return { seen, async decide(request) { seen.push(request); return { answers: {} } } } }

/** -> { labels, chunks: [{ dir, plan, planBytes, files }], totals } — deterministic; sends nothing. */
export async function buildSplitPlan() {
  const labels = labelsFile()
  if (labels.sha256 !== SPLIT_LABELS_SHA) throw new Error(`labels changed: ${labels.sha256} (frozen ${SPLIT_LABELS_SHA})`)
  const byId = new Map(SENTENCES.map(s => [s.id, s]))
  const rows = []
  for (const axis of ['source', 'time']) {
    const sel = SPLIT_SELECTION[axis]
    for (const id of [...sel.targets, ...sel.guards, ...sel.controls]) {
      const s = byId.get(id)
      if (!s) throw new Error(`${id}: not a study sentence`)
      const spans = speechSegments(s.text)
      if (spans.length !== 1) throw new Error(`${id}: the product does not read this as exactly one sentence`)
      const client = recorder()
      await judgeTurnWrite({ message: s.text, candidates: [], client, askedAt: STUDY_ASKED_AT, targetDesign: 'about', speechDesign: SPEECH_SPLIT })
      if (client.seen.length !== 1) throw new Error(`${id}: expected one request`)
      const wanted = new Set(SPEECH_SPLIT_KEYS[axis].map(name))
      const product = speechSplitQuestions(spans, s.text)
      const questions = client.seen[0].questions.filter(q => wanted.has(q.name))
      // the questions are the product's own objects, in the product's order; nothing is reworded here
      if (questions.length !== wanted.size || JSON.stringify(questions) !== JSON.stringify(product.filter(q => wanted.has(q.name)))) throw new Error(`${id}: product questions differ`)
      const body = { model: DECISION_MODEL, input: client.seen[0].input, questions }
      const bytes = Buffer.from(JSON.stringify(body), 'utf8')
      const allowed = s.allowed[axis], role = roleOf(axis, id), expect = expectationsFor(axis, allowed)
      rows.push({ id: `${axis}-${id}`, sentence: id, axis, role, allowed, file: `requests/${axis}-${id}.json`, bytes, sha256: sha(bytes),
        estInputTokens: independentEstimate(0, questions.length, bytes.length), expect, ...(expect.length ? {} : { recordOnly: true }) })
    }
  }
  const chunks = SPLIT_CHUNKS.map(([axis, from, to], k) => {
    const items = rows.filter(r => r.axis === axis).slice(from ?? 0, to ?? undefined)
    const est = items.reduce((n, r) => n + r.estInputTokens, 0)
    const dir = `chunk-${String(k + 1).padStart(2, '0')}`
    if (est > SPLIT_CHUNK_CEILING) throw new Error(`${dir}: ${est} estimated input tokens, over ${SPLIT_CHUNK_CEILING}`)
    const plan = { set: `${SPLIT_SET}/${dir}`, tokenCeiling: SPLIT_CHUNK_CEILING,
      productBars: { '*predicate': { yes: SPEECH_SPLIT_BARS.yes, no: SPEECH_SPLIT_BARS.no, source: 'egdesk-speech-grounding.mjs SPEECH_SPLIT_BARS (yes >= SPEECH_THRESHOLDS.confidence .85, no <= .15; the speech bar, not lowered)' } },
      passRule: `Labels frozen in labels.json sha256 ${SPLIT_LABELS_SHA} (the 60-sentence study). One sentence, one axis per request. ` +
        'The outcome is computed by scripts/egdesk-axis-split-plan.mjs analyze with the product combination (splitLabels) at the product bar: ' +
        'HARD 0 wrong installs (a label outside the allowed set) over all requests of all chunks; SOFT coverage of the 11 targets (study: 0 of 11; predicted >= 6), ' +
        'controls 6 of 6, guards 0 installs. The per-predicate expectations below are soft: what a correct install needs.',
      requests: items.map(r => ({ id: r.id, file: r.file, sha256: r.sha256, estInputTokens: r.estInputTokens, role: r.role, axis: r.axis, allowed: r.allowed,
        // a guard has no per-predicate expectation (any combination that installs a label is wrong; analyzeSplit judges it): record-only
        expect: r.expect, ...(r.recordOnly ? { recordOnly: true } : {}) })) }
    return { dir, items, est, plan, planBytes: Buffer.from(JSON.stringify(plan, null, 2) + '\n'), files: items.map(r => ({ file: r.file, bytes: r.bytes })) }
  })
  const total = chunks.reduce((n, c) => n + c.est, 0)
  if (total > SPLIT_TOKEN_CEILING) throw new Error(`${total} estimated input tokens, over ${SPLIT_TOKEN_CEILING}`)
  return { labels, chunks, rows, totals: { requests: rows.length, estInputTokens: total, maxChunk: Math.max(...chunks.map(c => c.est)) } }
}

// ---- analysis (after sending) ----
const verdictOf = answer => {
  const p = answer?.type === 'predicate' ? answer.probability : null
  return Number.isFinite(p) ? (p >= SPEECH_SPLIT_BARS.yes ? 'yes' : p <= SPEECH_SPLIT_BARS.no ? 'no' : U) : U
}
/**
 * analyzeSplit(results) with results: { [requestId]: { status, answers: [...] } } merged across chunks ->
 * { rows: [{ id, axis, role, label, allowed, installed, correct }], wrong, byRole, pass }
 * The other axis's predicates are absent from a request; splitLabels then leaves that axis unknown (it is not read).
 */
export function analyzeSplit(results, rows) {
  const out = rows.map(r => {
    const res = results[r.id]
    const answers = Array.isArray(res?.answers) ? res.answers : []
    const verdicts = Object.fromEntries(SPEECH_SPLIT_KEYS[r.axis].map(key => [key, verdictOf(answers.find(a => a.name === name(key)))]))
    const label = res?.status === 200 ? splitLabels(verdicts)[r.axis] : U
    const installed = label !== U
    return { id: r.id, axis: r.axis, role: r.role, label, allowed: r.allowed, installed, correct: installed ? r.allowed.includes(label) : null, verdicts, answered: res?.status === 200 }
  })
  const wrong = out.filter(r => r.installed && !r.correct)
  const byRole = Object.fromEntries(['target', 'guard', 'control'].map(role => {
    const list = out.filter(r => r.role === role)
    return [role, { requests: list.length, installedCorrect: list.filter(r => r.correct === true).length, wrong: list.filter(r => r.installed && !r.correct).length }]
  }))
  return { rows: out, wrong: wrong.length, byRole, answered: out.filter(r => r.answered).length, pass: wrong.length === 0 && out.every(r => r.answered) }
}
