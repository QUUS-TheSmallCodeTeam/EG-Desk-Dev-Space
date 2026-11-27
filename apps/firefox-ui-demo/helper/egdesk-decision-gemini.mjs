// Gemini Decisions provider for the EG-Desk decision client (Gemini Developer API v1beta, POST /v1beta/decisions,
// model gemini-decision-1). The client keeps ONE caller-facing shape (the OpenAI-shaped questions and the normalized
// answers); this module only translates the request out and the response back, so no caller changes.
// Sources: aistudio.google.com/docs/decisions-api, /api-reference/decisions/create-decision, /docs/rate-limits (2026-11).
//   request : { model, input: string | content[], questions: { <id>: { type: 'noul'|'choice'|'score', instructions, criteria } } }
//   auth    : header x-goog-api-key
//   response: { answers: { <id>: noul {noul, confidence} | choice {choice, probabilities{}, confidence}
//               | score {score, legend, probabilities{}, confidence} }, usage: { total_input_tokens, ... },
//               prompt_feedback?: { block_reason } }   (a blocked prompt returns no answers)
// Security: the key is only placed in the x-goog-api-key header by the client; nothing here sees it.

export const GEMINI_DECISIONS_ENDPOINT = 'https://generativelanguage.googleapis.com/v1beta/decisions'
export const GEMINI_DECISION_MODEL = 'gemini-decision-1'

const record = v => v !== null && typeof v === 'object' && !Array.isArray(v)
const isText = v => typeof v === 'string' && v.trim().length > 0

function partToBlocks(part) {
  if (typeof part === 'string') return [{ type: 'text', text: part }]
  if (!record(part)) return []
  if (part.type === 'input_text' || part.type === 'text') return typeof part.text === 'string' ? [{ type: 'text', text: part.text }] : []
  if (part.type === 'input_json') return [{ type: 'text', text: JSON.stringify(part.data) }]
  if (part.type === 'input_image') {
    const url = typeof part.image_url === 'string' ? part.image_url : ''
    const m = /^data:([a-z]+\/[a-z0-9.+-]+);base64,(.+)$/is.exec(url)
    const resolution = part.detail === 'low' ? { resolution: 'low' } : part.detail === 'high' ? { resolution: 'high' } : {}
    if (m) return [{ type: 'image', data: m[2], mime_type: m[1].toLowerCase(), ...resolution }]
    return /^https:\/\//i.test(url) ? [{ type: 'image', uri: url, ...resolution }] : []
  }
  return []
}

/** The shared input: OpenAI-style messages become ordered text/image blocks (no roles in Decisions; non-user roles are labelled). */
export function geminiInput(input) {
  if (typeof input === 'string') return input
  const blocks = []
  const push = list => { for (const b of list) blocks.push(b) }
  for (const item of input) {
    if (record(item) && typeof item.role === 'string') {
      if (item.role !== 'user') blocks.push({ type: 'text', text: `[${item.role}]\n` })
      const parts = typeof item.content === 'string' ? [item.content] : Array.isArray(item.content) ? item.content : []
      for (const part of parts) push(partToBlocks(part))
      blocks.push({ type: 'text', text: '\n\n' })
    } else push(partToBlocks(item))
  }
  // Adjacent text blocks are concatenated by the API; trailing separator is harmless but trimmed for tokens.
  const last = blocks[blocks.length - 1]
  if (last?.type === 'text' && /^\s+$/.test(last.text)) blocks.pop()
  return blocks.length ? blocks : ''
}

function instructionText(instructions) {
  if (typeof instructions === 'string') return instructions
  return instructions.map(p => (typeof p?.text === 'string' ? p.text : '')).join('')
}

/**
 * geminiRequest({ input, questions }) → { body, plan }
 * body: the Gemini request fields without `model`. plan: how to read answers back (id per question name; value per choice id).
 * Choice option values are strings or booleans; ids are the string form (a clashing id gets a suffix) and are mapped back.
 */
export function geminiRequest({ input, questions }) {
  const out = {}, plan = new Map(), usedKeys = new Set()
  questions.forEach((q, index) => {
    let key = /^[A-Za-z0-9_-]{1,64}$/.test(q.name) ? q.name : `q${index + 1}`
    while (usedKeys.has(key)) key = `${key}_${index + 1}`
    usedKeys.add(key)
    const instructions = instructionText(q.instructions)
    if (q.type === 'predicate') { out[key] = { type: 'noul', instructions }; plan.set(q.name, { key, type: 'predicate' }); return }
    if (q.type === 'choice') {
      const criteria = {}, valueOf = new Map()
      for (const choice of q.choices) {
        let id = String(choice.value)
        while (Object.hasOwn(criteria, id)) id += '_'
        criteria[id] = isText(choice.description) ? choice.description : ''
        valueOf.set(id, choice.value)
      }
      out[key] = { type: 'choice', instructions, criteria }; plan.set(q.name, { key, type: 'choice', valueOf }); return
    }
    const criteria = q.levels.map(level => (isText(level.description) ? `${level.label}: ${level.description}` : level.label))
    out[key] = { type: 'score', instructions, criteria }; plan.set(q.name, { key, type: 'score', labels: q.levels.map(l => l.label) })
  })
  return { body: { input: geminiInput(input), questions: out }, plan }
}

function rows(map, convert) {
  if (!record(map)) return []
  return Object.entries(map).map(([id, p]) => ({ ...convert(id), probability: p }))
}

/**
 * geminiToCommon(parsed, questions, plan) → OpenAI-shaped body { model, answers: [{ name, type, ... }], usage }
 * so the client's existing normalization (validation, typed choice keys, refusal/missing handling) stays the only reader.
 * A blocked prompt (prompt_feedback.block_reason) has no answers: the caller turns it into a closed failure.
 */
export function geminiToCommon(parsed, questions, plan) {
  const raw = record(parsed?.answers) ? parsed.answers : {}
  const answers = questions.flatMap(q => {
    const spec = plan.get(q.name), a = raw[spec.key]
    if (!record(a)) return [] // absent: the client reads it as missing (unknown)
    if (spec.type === 'predicate') return a.type === 'noul' ? { name: q.name, type: 'predicate', probability: a.noul } : { name: q.name, type: a.type }
    if (spec.type === 'choice') {
      if (a.type !== 'choice' || !spec.valueOf.has(a.choice)) return { name: q.name, type: 'choice', choice: undefined, confidence: a.confidence, probabilities: [] }
      return { name: q.name, type: 'choice', choice: spec.valueOf.get(a.choice), confidence: a.confidence,
        probabilities: rows(a.probabilities, id => ({ value: spec.valueOf.get(id) })) }
    }
    if (a.type !== 'score') return { name: q.name, type: a.type }
    return { name: q.name, type: 'score', score: a.score, confidence: a.confidence,
      probabilities: rows(a.probabilities, id => ({ value: Number(id), label: spec.labels[Number(id)] })) }
  })
  const u = record(parsed?.usage) ? parsed.usage : {}
  return { model: GEMINI_DECISION_MODEL, answers,
    usage: { input_tokens: u.total_input_tokens, output_tokens: u.total_output_tokens, total_tokens: u.total_tokens } }
}

/** Why a 200 response has no answers: a closed reason word or null. */
export function geminiBlockReason(parsed) {
  const r = parsed?.prompt_feedback?.block_reason
  return typeof r === 'string' && /^[a-z_]{1,40}$/.test(r) ? r : null
}

/**
 * classifyGeminiFailure(status, body) → { code, retryable, apiCode }
 * Google error body: { error: { code, message, status: 'RESOURCE_EXHAUSTED', details: [...] } }. Message text is never kept.
 * 429 RESOURCE_EXHAUSTED: the free tier's per-minute limits are retryable (rate_limited); a per-day quota
 * (quotaId containing PerDay) or a spend cap does not clear soon (spend_limit_reached).
 * 400 INVALID_ARGUMENT with reason API_KEY_INVALID is a bad key (invalid_key); other 400 is invalid_request.
 */
export function classifyGeminiFailure(status, body) {
  const err = record(body?.error) ? body.error : {}
  const apiCode = typeof err.status === 'string' ? err.status.toLowerCase() : null
  let detailText = ''
  try { detailText = JSON.stringify(err.details ?? '') } catch {}
  if (status === 401 || (status === 400 && /API_KEY_INVALID|API key not valid/i.test(detailText + String(err.message ?? '')))) return { code: 'invalid_key', retryable: false, apiCode }
  if (status === 429) {
    if (/PerDay|spend/i.test(detailText)) return { code: 'spend_limit_reached', retryable: false, apiCode }
    return { code: 'rate_limited', retryable: true, apiCode }
  }
  if (status === 403 || status === 404) return { code: 'model_unavailable', retryable: false, apiCode }
  if (status >= 500 || status === 408) return { code: 'server_error', retryable: true, apiCode }
  return { code: 'invalid_request', retryable: false, apiCode }
}
