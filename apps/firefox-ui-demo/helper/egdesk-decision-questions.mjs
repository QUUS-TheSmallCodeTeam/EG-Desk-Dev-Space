import { createHash } from 'node:crypto'
import { DECISION_LIMITS } from './egdesk-decision-client.mjs'

// Shared builders and readers for decision questions. The rules here are the
// ones every EG-Desk decision follows:
// - Option values are short, human-readable and unique (the model reads the
//   value and description as part of the prompt; opaque ids read worse).
//   Callers keep their own map from option value back to the item.
// - A refusal, missing or invalid answer reads as 'unknown', never as 'no'.
// - Thresholds are placeholders until advisory-mode logs calibrate them.

export const DEFAULT_DECISION_THRESHOLDS = Object.freeze({
  relevant: 0.5, // attach a context item
  relevantStrict: 0.8, // attach a planned or hypothetical item to a present-tense question
  choice: 0.75, // act on a choice answer (its confidence)
  margin: 0.2, // top-1 minus top-2 probability before acting
  done: 0.85, // the browsing goal is reached
  pageState: 0.7, // route on a page state
  transition: 0.85, // propose a timeline transition
  saveBranch: 0.7, // offer to keep a what-if branch
})

export function decisionThresholds(overrides = {}) {
  const out = { ...DEFAULT_DECISION_THRESHOLDS }
  for (const [key, value] of Object.entries(overrides || {})) {
    if (Object.hasOwn(out, key) && typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 1) out[key] = value
  }
  return Object.freeze(out)
}

export function compactText(value, max) {
  const text = String(value ?? '').replace(/\s+/g, ' ').trim()
  return text.length > max ? `${text.slice(0, Math.max(1, max - 1)).trimEnd()}…` : text
}

export function sha256Hex(text) {
  return createHash('sha256').update(String(text)).digest('hex')
}

/**
 * uniqueOptions(entries, { maxLabel? }) → [{ value, description, item }]
 * entries: [{ label, description?, item }]. Values are compacted labels made
 * unique with ' (2)', ' (3)' … so the decision model can tell them apart.
 */
export function uniqueOptions(entries, { maxLabel = 120 } = {}) {
  const used = new Set()
  return entries.map(entry => {
    const base = compactText(entry.label, maxLabel - 6) || 'item'
    let value = base
    for (let index = 2; used.has(value); index++) value = `${base} (${index})`
    used.add(value)
    return { value, ...(entry.description ? { description: compactText(entry.description, 240) } : {}), item: entry.item }
  })
}

export function predicateQuestion(name, instructions) {
  return { type: 'predicate', name, instructions }
}

export function choiceQuestion(name, instructions, options) {
  if (!Array.isArray(options) || options.length < DECISION_LIMITS.choicesMin || options.length > DECISION_LIMITS.choicesMax) {
    throw new RangeError(`${name} needs ${DECISION_LIMITS.choicesMin} to ${DECISION_LIMITS.choicesMax} options`)
  }
  return { type: 'choice', name, instructions,
    choices: options.map(option => ({ value: option.value, ...(option.description ? { description: option.description } : {}) })) }
}

export function scoreQuestion(name, instructions, levels) {
  return { type: 'score', name, instructions, levels: levels.map(level => ({ label: level.label, ...(level.description ? { description: level.description } : {}) })) }
}

// Options from a { value: description } table, in table order.
export function tableOptions(table) {
  return Object.entries(table).map(([value, description]) => ({ value, description }))
}

/**
 * readPredicate(answers, name, threshold) → { state: 'yes'|'no'|'unknown', probability }
 */
export function readPredicate(answers, name, threshold) {
  const answer = answers?.[name]
  if (answer?.type !== 'predicate') return { state: 'unknown', probability: null }
  return { state: answer.probability >= threshold ? 'yes' : 'no', probability: answer.probability }
}

/**
 * readChoice(answers, name, { minConfidence, minMargin? }) →
 *   { state: 'accepted'|'uncertain'|'unknown', value, confidence, margin, ranked }
 * ranked: the top probabilities (at most 3) for escalation messages.
 */
export function readChoice(answers, name, { minConfidence, minMargin = 0 } = {}) {
  const answer = answers?.[name]
  if (answer?.type !== 'choice') return { state: 'unknown', value: null, confidence: null, margin: null, ranked: [] }
  const ranked = answer.probabilities.slice(0, 3).map(row => ({ value: row.value, probability: row.probability }))
  const top = answer.probabilities[0]?.probability ?? answer.confidence
  const second = answer.probabilities[1]?.probability ?? 0
  const margin = Math.max(0, top - second)
  const accepted = answer.confidence >= minConfidence && margin >= minMargin
  return { state: accepted ? 'accepted' : 'uncertain', value: answer.choice, confidence: answer.confidence, margin, ranked }
}
