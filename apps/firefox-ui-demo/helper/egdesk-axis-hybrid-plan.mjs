import { createHash } from 'node:crypto'
import { DECISION_MODEL } from './egdesk-decision-client.mjs'
import { independentEstimate } from './egdesk-decision-real-runner.mjs'
import { SPEECH_HYBRID, SPEECH_SPLIT_BARS, SPEECH_SPLIT_KEYS, SPEECH_THRESHOLDS, speechHybridInterpretations, speechSegments } from './egdesk-speech-grounding.mjs'
import { judgeTurnWrite } from './egdesk-turn-memory.mjs'
import { SPLIT_LABELS_SHA } from './egdesk-axis-split-plan.mjs'
import { SENTENCES, STUDY_ASKED_AT, labelsFile } from './egdesk-utterance-threshold-study.mjs'

// PREPARED, NOT SENT. Re-measure of the 'hybrid-isolated' design (egdesk-speech-grounding.mjs) on the requests of axis-split-v1 whose outcome
// would change (L7 c21), same frozen labels (d29d9007...). Decided from the real c23 numbers (evidence/l7-c21/options.txt, offline):
//   split as sent          targets 6/11, controls 1/6, guards wrong 1 (a16)
//   split + when rule      targets 6/11, controls 1/6, guards wrong 0
//   hybrid                 targets 6/11, controls 6/6, guards wrong 1
//   hybrid + when rule     targets 6/11, controls 6/6, guards wrong 0   <- adopted
//   split, others only "not yes" (weakens the no side; NOT adopted): targets 11/11, controls 4/6, guards wrong 2 (a13, a16)
// "Exactly one yes AND every other decided no" is already the split rule; it is what lost the controls (a second predicate undecided).
// Outcome changes under hybrid + when rule, i.e. the requests sent here (6):
//   controls that lost their install: source c01, c02, c10 (now from the axes question, which installed them at .85 in the study);
//   time c01, c26 (same); the guard a16 time (the when rule: now .92 with when 1.0 -> unknown). Unchanged and NOT re-sent: the 11 targets
//   (the axes question left all 11 uninstalled in the study, so the split reading stands), guards a09 / a14 / a13, control c04 time.
// Each request: the product's write-judgment input for the sentence and, for the axis under study, the product's hybrid questions (the
// isolated axes question plus that axis's split predicates). Note: the axes answers of the study came from a different body (all axes,
// tw_status); here the axes question rides with the predicates, which is why it is re-measured and not assumed.
// Pre-registered: HARD 0 wrong installs (per request, the axes question at its product bar .85 / .20, and analyzeHybrid with the product
// interpretation); SOFT controls 5 of 5 installed correctly, a16 not installed.
export const HYBRID_SET = 'axis-hybrid-v1'
export const HYBRID_DIR = 'proofs/decision-real-measure/axis-hybrid'
export const HYBRID_CEILING = 12000
export const HYBRID_REQUESTS = Object.freeze([
  ['source', 'c01', 'control'], ['source', 'c02', 'control'], ['source', 'c10', 'control'],
  ['time', 'c01', 'control'], ['time', 'c26', 'control'], ['time', 'a16', 'guard'],
])
const U = 'unknown'
const sha = bytes => createHash('sha256').update(bytes).digest('hex')
const recorder = () => { const seen = []; return { seen, async decide(request) { seen.push(request); return { answers: {} } } } }

export async function buildHybridPlan() {
  if (labelsFile().sha256 !== SPLIT_LABELS_SHA) throw new Error('labels changed')
  const rows = []
  for (const [axis, id, role] of HYBRID_REQUESTS) {
    const s = SENTENCES.find(x => x.id === id), spans = speechSegments(s.text)
    if (spans.length !== 1) throw new Error(`${id}: not one sentence`)
    const client = recorder()
    await judgeTurnWrite({ message: s.text, candidates: [], client, askedAt: STUDY_ASKED_AT, targetDesign: 'about', speechDesign: SPEECH_HYBRID })
    const keep = new Set([`speech_${axis}_0`, ...SPEECH_SPLIT_KEYS[axis].map(k => `speechs_${k}_0`)])
    const questions = client.seen[0].questions.filter(q => keep.has(q.name))
    if (questions.length !== keep.size) throw new Error(`${id}: product questions missing`)
    const body = { model: DECISION_MODEL, input: client.seen[0].input, questions }
    const bytes = Buffer.from(JSON.stringify(body), 'utf8'), allowed = s.allowed[axis]
    const expect = [
      { name: `speech_${axis}_0`, kind: 'choice', oneOf: [...new Set([...allowed, U])], whenAccepted: { minConfidence: SPEECH_THRESHOLDS.confidence, minMargin: SPEECH_THRESHOLDS.margin }, severity: 'hard',
        note: `no label outside ${allowed.join('/')} installed by the axes question at the product bar` },
      ...(role === 'control' ? [{ name: `speech_${axis}_0`, kind: 'choice', oneOf: allowed.filter(v => v !== U), minConfidence: SPEECH_THRESHOLDS.confidence, minMargin: SPEECH_THRESHOLDS.margin, severity: 'soft', note: 'installed as in the study (coverage)' }] : []),
    ]
    rows.push({ id: `${axis}-${id}`, sentence: id, axis, role, allowed, text: s.text, file: `requests/${axis}-${id}.json`, bytes, sha256: sha(bytes),
      estInputTokens: independentEstimate(questions.filter(q => q.type === 'choice').length, questions.filter(q => q.type === 'predicate').length, bytes.length), expect })
  }
  const est = rows.reduce((n, r) => n + r.estInputTokens, 0)
  if (est > HYBRID_CEILING) throw new Error(`${est} over ${HYBRID_CEILING}`)
  const plan = { set: HYBRID_SET, tokenCeiling: HYBRID_CEILING,
    productBars: {
      '*choice': { minConfidence: SPEECH_THRESHOLDS.confidence, minMargin: SPEECH_THRESHOLDS.margin, source: 'egdesk-speech-grounding.mjs SPEECH_THRESHOLDS (axes are installed at confidence >= .85 and margin >= .20)' },
      '*predicate': { yes: SPEECH_SPLIT_BARS.yes, no: SPEECH_SPLIT_BARS.no, source: 'egdesk-speech-grounding.mjs SPEECH_SPLIT_BARS (.85 / .15)' } },
    passRule: `Labels frozen in labels.json sha256 ${SPLIT_LABELS_SHA}. HARD: no wrong install by the axes question at its product bar (runner), and 0 wrong installs ` +
      'from scripts/egdesk-axis-hybrid-plan.mjs analyze (the product interpretation speechHybridInterpretations). SOFT: the 5 controls installed correctly, the a16 guard not installed.',
    requests: rows.map(r => ({ id: r.id, file: r.file, sha256: r.sha256, estInputTokens: r.estInputTokens, role: r.role, axis: r.axis, allowed: r.allowed, expect: r.expect })) }
  return { rows, est, plan, planBytes: Buffer.from(JSON.stringify(plan, null, 2) + '\n'), files: rows.map(r => ({ file: r.file, bytes: r.bytes })) }
}

/** results: { [requestId]: { status, answers: [...] } } -> per request the label the product reads for the axis under study. */
export function analyzeHybrid(results, rows) {
  const out = rows.map(r => {
    const res = results[r.id], list = Array.isArray(res?.answers) ? res.answers : []
    const answers = Object.fromEntries(list.filter(a => a && typeof a.name === 'string').map(({ name, ...a }) => [name, a]))
    const [label] = res?.status === 200 ? speechHybridInterpretations(answers, speechSegments(r.text)).map(k => k[r.axis]) : []
    const value = label ?? U, installed = value !== U
    return { id: r.id, role: r.role, label: value, allowed: r.allowed, installed, correct: installed ? r.allowed.includes(value) : null, answered: res?.status === 200 }
  })
  const wrong = out.filter(r => r.installed && !r.correct).length
  return { rows: out, wrong, controls: out.filter(r => r.role === 'control' && r.correct).length, pass: wrong === 0 && out.every(r => r.answered) }
}
