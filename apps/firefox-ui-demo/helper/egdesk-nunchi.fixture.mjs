import { choiceAnswer } from './egdesk-wiki-reconstruction.fixture.mjs'

// Test stand-in for the Decision model's answers to the nunchi questions (u4: six questions, the sixth a yes/no).
// want: { nk_kind, nk_about, ... } single values, or { dist: { nk_kind: { value: probability } ... }, manner?: probability }.
const ASKING = ['correction', 'complaint', 'instruction_change', 'urging']
// an uncertain stand-in (top < .95) is uncertain about the yes/no question too
const mannerOf = (want, top = 0.95) => (Number.isFinite(want?.manner) ? want.manner : Number.isFinite(want?.nk_manner) ? want.nk_manner
  : want?.dist?.nk_kind ? ASKING.reduce((n, k) => n + (want.dist.nk_kind[k] ?? 0), 0) : ASKING.includes(want?.nk_kind) ? Math.min(0.97, top + 0.02) : 0.02)
/** nunchiAnswer(question, want, top) -> the answer of one question: a predicate gets the manner probability, a choice its single value at `top` or its distribution. */
export function nunchiAnswer(question, want, top = 0.95) {
  if (question.type === 'predicate') return { type: 'predicate', probability: mannerOf(want, top) }
  const d = want?.dist?.[question.name]
  if (!d) return choiceAnswer(question, want?.[question.name], top)
  const rows = question.choices.map(c => ({ value: c.value, probability: d[c.value] ?? 0 })).sort((a, b) => b.probability - a.probability), n = question.choices.length
  return { type: 'choice', choice: rows[0].value, confidence: Math.max(0, (rows[0].probability - 1 / n) / (1 - 1 / n)), probabilities: rows }
}
