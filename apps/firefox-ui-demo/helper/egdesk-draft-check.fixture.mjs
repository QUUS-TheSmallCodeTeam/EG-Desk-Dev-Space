// Deterministic stand-ins for the sims and tests. They exercise the orchestration (segments, options, one revision,
// fallbacks), not the accuracy of any real model.
import { DecisionError } from './egdesk-decision-client.mjs'

const PRESENT = /현재|운영 중|사용 중|동작 중|적용되어 있/
const words = text => new Set(String(text).toLowerCase().match(/[\p{L}\p{N}_]{4,}/gu) ?? [])
const answerChoice = (name, choice) => ({ type: 'choice', name, choice, confidence: 0.95, probabilities: [{ value: choice, probability: 0.96 }, { value: choice === 'supported' ? 'insufficient' : 'supported', probability: 0.02 }] })

// delayMs: one number for every call, or a list by call index (the last entry repeats), e.g. [1350, 450] = cold then warm.
export function mockJudge({ internalTerms = [], delayMs: delays = 0, calls = [] } = {}) {
  return { model: 'mock-judge', async decide(request) {
    const delayMs = Array.isArray(delays) ? delays[Math.min(calls.length, delays.length - 1)] : delays
    calls.push(request)
    const late = request.timeoutMs !== undefined && delayMs > request.timeoutMs
    if (delayMs) await new Promise(resolve => setTimeout(resolve, late ? request.timeoutMs : delayMs))
    if (late) throw new DecisionError('timeout', 'mock timeout', { retryable: true })
    const evidenceText = request.input[1].content, tail = request.input[2].content
    const items = [...evidenceText.matchAll(/\[E\d+ time=(\S+)[^\]]*\]\n([^\[]*)/g)].map(m => ({ time: m[1], text: m[2] }))
    const claims = [...tail.matchAll(/^\[C(\d+)\] (.*)$/gm)].map(m => ({ i: Number(m[1]) - 1, text: m[2] }))
    const terms = [...tail.matchAll(/^\[T(\d+)\] (.*)$/gm)].map(m => ({ i: Number(m[1]) - 1, text: m[2] }))
    const answers = {}
    for (const c of claims) {
      const mine = words(c.text)
      const hit = items.filter(it => [...words(it.text)].some(w => mine.has(w)))
      answers[`claim_${c.i}`] = answerChoice(`claim_${c.i}`, hit.length ? 'supported' : items.length ? 'not_mentioned' : 'insufficient')
      answers[`present_${c.i}`] = { type: 'predicate', name: `present_${c.i}`, probability: hit.some(it => it.time !== 'present') && PRESENT.test(c.text) ? 0.93 : 0.04 }
    }
    for (const t of terms) answers[`term_${t.i}`] = { type: 'predicate', name: `term_${t.i}`, probability: internalTerms.some(x => t.text.includes(x)) ? 0.9 : 0.05 }
    return { answers, model: 'mock-judge', usage: { inputTokens: 300 }, latencyMs: delayMs }
  } }
}

// The subjective model's one revision, scripted per finding kind.
export function mockReviser(rules = {}) {
  const log = []
  const revise = async ({ draft, note, findings }) => {
    log.push({ note, kinds: findings.map(f => f.kind) })
    let text = draft
    for (const [from, to] of Object.entries(rules)) text = text.split(from).join(to)
    return text
  }
  revise.log = log
  return revise
}
