import { choiceQuestion, compactText, decisionThresholds, readChoice } from './egdesk-decision-questions.mjs'
import { FOREGROUND_DECISION_TIMEOUT_MS } from './egdesk-decision-client.mjs'

// L8 a1 ('교대'): the text for a field nobody gave a value for, CHOSEN by the decision model among spans code cut out of the person's own message and the goal (it never
// writes text). Shared by the browser task tool (egdesk-browser-task-tool.mjs) and the direct entry (egdesk-browser-task.mjs, opt-in fieldText). Measured on the real model
// (2026-11-26, 8 Korean/English requests): 6 of 8 at 0.2-0.3 s; "none of these" when the value is not word for word in the message (it must then be written by a model or the person).
export const FIELD_TEXT_LIMITS = Object.freeze({ goal: 500, message: 600, spans: 60, spanWords: 6 })

// ---- the spans code cuts out of the person's message and the goal (the decision model chooses one; it never writes text) ----
const QUOTED = /["“”„'‘’「」『』《》]([^"“”„'‘’「」『』《》\n]{1,80})["“”„'‘’「」『』《》]/g
// words that ask for an action, and the connectives after them: a value never spans one (a request's verbs split it into segments)
const ACTION_WORD = /^(검색|입력|적어|넣어|찾아|열어|열고|눌러|클릭|요약|정리|이동|들어가|알려|보여|가서|가줘|틀어|재생|보내|해줘|해주세요|해서|하고|하면|해봐|줘|주세요|좀|search|type|enter|find|open|click|go|look|please|and|then)/i
const PARTICLE = ['이라고', '라고', '에서', '에게', '한테', '으로', '을', '를', '은', '는', '에', '로']
const EDGE_PUNCTUATION = /^[\s.,!?~…·:;()[\]{}<>]+|[\s.,!?~…·:;()[\]{}<>]+$/g
const stripParticle = word => { for (const p of PARTICLE) if (word.length - p.length >= 2 && word.endsWith(p)) return word.slice(0, -p.length); return null }
export const NO_FIELD_TEXT = 'none of these'
// a1/a2: the field an UNDECIDED step (the loop's 'uncertain' escalation) is about, for the callers that fill a field with the person's own words: a text field among the step's top two
// choices (a1), else the page's only text field (a2, soleField: the real DuckDuckGo step spread over 47 options and ranked none in its top two). null: none (the step pauses as before).
export function undecidedField(result) {
  const ranked = (Array.isArray(result?.ranked) ? result.ranked : []).slice(0, 2).map(row => row?.value).find(value => /^\[F\d+\]/.test(value ?? ''))
  if (ranked) return ranked
  return typeof result?.soleField === 'string' && /^\[F\d+\]/.test(result.soleField) ? result.soleField : null
}
/**
 * candidateSpans(texts) -> up to FIELD_TEXT_LIMITS.spans distinct spans, best first: quoted text, then for each segment (between action words) its word
 * runs of 1 to FIELD_TEXT_LIMITS.spanWords words, longest first, each also without a trailing particle ("차민수라고" -> "차민수"). Code only: nothing is judged here.
 */
export function candidateSpans(texts) {
  const out = []
  const add = span => { const value = compactText(String(span ?? '').replace(EDGE_PUNCTUATION, ''), 80); if (value && value !== NO_FIELD_TEXT && !out.includes(value)) out.push(value) }
  const list = (Array.isArray(texts) ? texts : [texts]).filter(text => typeof text === 'string' && text.trim()).map(text => compactText(text, FIELD_TEXT_LIMITS.message))
  for (const text of list) for (const match of text.matchAll(QUOTED)) add(match[1])
  for (const text of list) {
    const segments = [[]]
    for (const raw of text.replace(QUOTED, ' ').split(/\s+/)) {
      const word = raw.replace(EDGE_PUNCTUATION, '')
      if (!word) continue
      if (ACTION_WORD.test(word)) { if (segments.at(-1).length) segments.push([]); continue }
      segments.at(-1).push(word)
    }
    for (const words of segments) {
      for (let size = Math.min(FIELD_TEXT_LIMITS.spanWords, words.length); size >= 1; size--) {
        for (let at = 0; at + size <= words.length; at++) {
          const run = words.slice(at, at + size)
          add(run.join(' '))
          const bare = stripParticle(run.at(-1))
          if (bare) add([...run.slice(0, -1), bare].join(' '))
        }
      }
    }
  }
  return out.slice(0, FIELD_TEXT_LIMITS.spans)
}

const SPAN_RULES = 'You choose what EG-Desk types into one text field of a web page for the person. Choose the text exactly as it should be typed, or none when no listed text belongs in this field.'
/** pickFieldText({ client, goal, message?, field, host?, spans, thresholds?, ... }) -> { text|null, confidence, usage }: one choice question (+ none). Throws DecisionError. */
export async function pickFieldText({ client, goal, message = null, field, host = null, spans, thresholds, timeoutMs = FOREGROUND_DECISION_TIMEOUT_MS, signal, authorizeDispatch }) {
  const t = decisionThresholds(thresholds)
  const list = (Array.isArray(spans) ? spans : []).filter(span => typeof span === 'string' && span && span !== NO_FIELD_TEXT).slice(0, FIELD_TEXT_LIMITS.spans)
  if (!list.length) return { text: null, confidence: null, usage: null }
  const label = compactText(field, 80) || 'text field'
  const evidence = [`Request: ${compactText(goal, FIELD_TEXT_LIMITS.goal)}`, ...(typeof message === 'string' && message.trim() ? [`The person's message: ${compactText(message, FIELD_TEXT_LIMITS.message)}`] : []),
    `Field: "${label.replace(/"/g, "'")}"${host ? ` on ${host}` : ''}`].join('\n')
  const result = await client.decide({
    input: [{ role: 'developer', content: SPAN_RULES }, { role: 'user', content: evidence }],
    questions: [choiceQuestion('field_text', `Which text should be typed into the field "${label.replace(/"/g, "'")}" to do this request?`, [...list.map(value => ({ value })), { value: NO_FIELD_TEXT, description: 'No listed text belongs in this field.' }])],
    timeoutMs, signal, authorizeDispatch,
  })
  const picked = readChoice(result.answers, 'field_text', { minConfidence: t.choice, minMargin: t.margin })
  return { text: picked.state === 'accepted' && picked.value !== NO_FIELD_TEXT && list.includes(picked.value) ? picked.value : null, confidence: picked.confidence, usage: result.usage ?? null }
}

