import { createHash } from 'node:crypto'
import { DECISION_MODEL } from './egdesk-decision-client.mjs'
import { independentEstimate } from './egdesk-decision-real-runner.mjs'
import { SPEECH_SPLIT_BARS, SPEECH_SPLIT_KEYS, SPLIT_WORDING_V2_AS_SENT, speechSegments, speechSplitQuestions, splitLabels } from './egdesk-speech-grounding.mjs'
import { SECOND_LABEL_RULES } from './egdesk-turn-memory.mjs'
import { clockLine } from './egdesk-wiki-reconstruction.mjs'
import { SPLIT_LABELS_SHA, expectationsFor } from './egdesk-axis-split-plan.mjs'
import { SENTENCES, STUDY_ASKED_AT, labelsFile } from './egdesk-utterance-threshold-study.mjs'

// PREPARED, NOT SENT. Split wording v2 (egdesk-speech-grounding.mjs SPLIT_WORDINGS) on the five targets that stayed uninstalled in c23 and the
// five hybrid controls as guards (L7 c22). Same frozen labels (d29d9007...).
// Each request is the hybrid two-step's SECOND request for one sentence and one axis (SECOND_LABEL_RULES + the clock and the message), but
// carries only the predicates whose wording changed in v2: source other / own / guess, time before / now. The unchanged predicates (source
// record; time ongoing / after / when) keep their v1 text, and their real c23 answers are used in the combination: c24 re-asked the same v1
// predicates in another body and every one of its 27 predicate answers equalled c23's.
//   targets  source c22 (record_based; other .73, own .62), c12 (inference; own .68); time c32 (past_anchored; now .35), c37
//            (ongoing / at_utterance; now .77), c30 (ongoing; before .19, now .65)
//   guards   the 5 controls the axes question installs in the hybrid (c24): source c01, c02, c10; time c01, c26. In the two-step they never reach
//            the second request; here the split reading alone must not install a wrong label on them.
// Pre-registered: HARD 0 wrong installs over the 10 (analyzeWording, the product combination at .85 / .15); SOFT targets installed
// correctly >= 3 of 5 (c23: 0 of 5), guards installed correctly >= 3 of 5 (c23 split alone: 0 of 5).
export const WORDING_SET = 'split-wording-v2'
export const WORDING_DIR = 'proofs/decision-real-measure/split-wording'
export const WORDING_CEILING = 8000
export const WORDING_CHANGED = Object.freeze({ source: ['other', 'own', 'guess'], time: ['before', 'now'] })
export const WORDING_REQUESTS = Object.freeze([
  ['source', 'c22', 'target'], ['source', 'c12', 'target'], ['time', 'c32', 'target'], ['time', 'c37', 'target'], ['time', 'c30', 'target'],
  ['source', 'c01', 'guard'], ['source', 'c02', 'guard'], ['source', 'c10', 'guard'], ['time', 'c01', 'guard'], ['time', 'c26', 'guard'],
])
// The real c23 answers of the unchanged v1 predicates (evidence/main-real/c23/axis-split_chunk-0*_plan-results.json), frozen here.
export const C23_UNCHANGED = Object.freeze({
  'source-c22': { record: 1 }, 'source-c12': { record: 0.03 }, 'source-c01': { record: 0.1 }, 'source-c02': { record: 0.07 }, 'source-c10': { record: 0.97 },
  'time-c32': { ongoing: 0, after: 0, when: 0.99 }, 'time-c37': { ongoing: 0.98, after: 0.01, when: 1 }, 'time-c30': { ongoing: 1, after: 0, when: 0.99 },
  'time-c01': { ongoing: 0, after: 0, when: 1 }, 'time-c26': { ongoing: 0, after: 0, when: 0.99 },
})
const sha = bytes => createHash('sha256').update(bytes).digest('hex')

export function buildWordingPlan() {
  if (labelsFile().sha256 !== SPLIT_LABELS_SHA) throw new Error('labels changed')
  const rows = WORDING_REQUESTS.map(([axis, id, role]) => {
    const s = SENTENCES.find(x => x.id === id), spans = speechSegments(s.text)
    if (spans.length !== 1) throw new Error(`${id}: not one sentence`)
    const names = new Set(WORDING_CHANGED[axis].map(k => `speechs_${k}_0`))
    const questions = speechSplitQuestions(spans, s.text, { wording: SPLIT_WORDING_V2_AS_SENT }).filter(q => names.has(q.name))
    const body = { model: DECISION_MODEL, input: [{ role: 'developer', content: SECOND_LABEL_RULES }, { role: 'user', content: `${clockLine(STUDY_ASKED_AT)}\nMessage:\n${s.text}` }], questions }
    const bytes = Buffer.from(JSON.stringify(body), 'utf8'), allowed = s.allowed[axis]
    const expect = expectationsFor(axis, allowed).filter(e => names.has(e.name))
    return { id: `${axis}-${id}`, sentence: id, axis, role, allowed, file: `requests/${axis}-${id}.json`, bytes, sha256: sha(bytes),
      estInputTokens: independentEstimate(0, questions.length, bytes.length), expect }
  })
  const est = rows.reduce((n, r) => n + r.estInputTokens, 0)
  if (est > WORDING_CEILING) throw new Error(`${est} over ${WORDING_CEILING}`)
  const plan = { set: WORDING_SET, tokenCeiling: WORDING_CEILING,
    productBars: { '*predicate': { yes: SPEECH_SPLIT_BARS.yes, no: SPEECH_SPLIT_BARS.no, source: 'egdesk-speech-grounding.mjs SPEECH_SPLIT_BARS (.85 / .15)' } },
    passRule: `Labels frozen in labels.json sha256 ${SPLIT_LABELS_SHA}. Only the v2-changed predicates are asked; the unchanged v1 ones use their real c23 answers. ` +
      'HARD: 0 wrong installs over the 10 from scripts/egdesk-split-wording-plan.mjs analyze (splitLabels at .85 / .15). SOFT: targets >= 3 of 5, guards >= 3 of 5 installed correctly.',
    requests: rows.map(r => ({ id: r.id, file: r.file, sha256: r.sha256, estInputTokens: r.estInputTokens, role: r.role, axis: r.axis, allowed: r.allowed, expect: r.expect })) }
  return { rows, est, plan, planBytes: Buffer.from(JSON.stringify(plan, null, 2) + '\n'), files: rows.map(r => ({ file: r.file, bytes: r.bytes })) }
}

const verdict = p => (Number.isFinite(p) ? (p >= SPEECH_SPLIT_BARS.yes ? 'yes' : p <= SPEECH_SPLIT_BARS.no ? 'no' : 'unknown') : 'unknown')
/** results: { [id]: { status, answers } } -> the combined label per request (new answers for the changed predicates, c23 for the rest). */
export function analyzeWording(results, rows) {
  const out = rows.map(r => {
    const res = results[r.id], got = Object.fromEntries((Array.isArray(res?.answers) ? res.answers : []).map(a => [String(a.name).replace(/^speechs_|_0$/g, ''), a.probability]))
    const p = { ...C23_UNCHANGED[r.id], ...Object.fromEntries(WORDING_CHANGED[r.axis].map(k => [k, got[k]])) }
    const label = res?.status === 200 ? splitLabels(Object.fromEntries(SPEECH_SPLIT_KEYS[r.axis].map(k => [k, verdict(p[k])])))[r.axis] : 'unknown'
    const installed = label !== 'unknown'
    return { id: r.id, role: r.role, label, allowed: r.allowed, installed, correct: installed ? r.allowed.includes(label) : null, answered: res?.status === 200 }
  })
  const wrong = out.filter(r => r.installed && !r.correct).length
  const count = role => out.filter(r => r.role === role && r.correct).length
  return { rows: out, wrong, targets: count('target'), guards: count('guard'), pass: wrong === 0 && out.every(r => r.answered) }
}
