// Conversation examples for the simulations: how the person actually talks to LLM apps (user request, 2026-11-24, relayed by Main:
// "사용자가 llm 앱을 대화로 사용하는 예시를 확대 수집 ... 프로젝트 내용은 연관 없어도 사용자 반응이 뭔가 좋은 예시다 (좋든 나쁘든) 그러면 수집").
// The selection criterion is the PERSON'S BEHAVIOUR in the turn (corrections, pushback, terse approvals, ambiguous answers, referential
// follow-ups, topic switches and returns, interruptions and recovery requests, praise, frustration, re-asking, instruction changes),
// not the project content. Two areas: 'taehwa' (태화트랜스 / ontology work) and 'egdesk' (EG-Desk development); every other turn is
// counted and dropped.
//
// Sources (read-only, streamed line by line, never loaded whole): Codex rollouts (rollout-*.jsonl), Claude Code project logs
// (~/.claude/projects/<cwd>/*.jsonl), pinned Codex transcripts (transcript.raw.jsonl, the rollout format), and an Aside session export
// ({ role, at, text } per line). Only conversation records are read: the person's typed turns and the assistant's messages. Tool calls,
// tool outputs, reasoning, injected instructions and agent-to-agent messages are skipped.
//
// Per user turn: the assistant message before it (the end of it, bounded), the turn, the next assistant message (its start, bounded),
// timestamps, source file + line, code features and heuristic tags (cheap; the Decision model labels candidates afterwards, one yes/no
// predicate per type, each request quoting the turn and the assistant excerpt before it in isolation: labelRequest). Secrets are masked
// always (maskSecrets of helper/egdesk-scenario-seeds.mjs). The owner approved real sends of these masked examples (2026-11-24, relayed
// by Main: "당연하지"): privacy 'owner-approved'.
import { createReadStream } from 'node:fs'
import { createHash } from 'node:crypto'
import readline from 'node:readline'
import { maskSecrets } from './egdesk-scenario-seeds.mjs'
import { independentEstimate } from './egdesk-decision-real-runner.mjs'

export const EXAMPLE_SCHEMA = 'egdesk.conversation-example/1'
export const EXAMPLE_LIMITS = Object.freeze({ prev: 400, user: 600, next: 300, lineBytes: 4_000_000 })
export const AREAS = Object.freeze(['taehwa', 'egdesk'])
export const APPROVAL = Object.freeze({ approved: '2026-11-24', by: 'owner', relayedBy: 'Main (session 5yGDgeI9gUvBBXY9)', scope: 'real Decision labelling and simulations of masked conversation examples' })

const sha = text => createHash('sha256').update(text).digest('hex')
const squash = text => String(text ?? '').replace(/\r/g, '').replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim()
const head = (text, n) => { const t = squash(text); return t.length > n ? `${t.slice(0, n - 1)}…` : t }
const tail = (text, n) => { const t = squash(text); return t.length > n ? `…${t.slice(t.length - n + 1)}` : t }

// ---- record readers: each yields { role: 'user' | 'assistant', text, at, line, cwd? } -------------------------------------------------
const INJECTED = /^\s*(?:<[a-z_-]+[\s>]|# AGENTS\.md|<INSTRUCTIONS>|Caveat: |\[Request interrupted|This session is being continued from a previous conversation)/i
const textParts = (content, types) => (Array.isArray(content) ? content : []).filter(c => types.includes(c?.type) && typeof c.text === 'string').map(c => c.text)

/** fromCodex(record, line) → turn | { cwd } | null (a Codex rollout line: response_item messages; session_meta / turn_context give the cwd). */
export function fromCodex(o, line) {
  const p = o?.payload
  if (!p || typeof p !== 'object') return null
  if ((o.type === 'session_meta' || o.type === 'turn_context') && typeof p.cwd === 'string') return { cwd: p.cwd }
  if (o.type !== 'response_item' || p.type !== 'message') return null
  if (p.role === 'user') { const text = textParts(p.content, ['input_text']).filter(t => !INJECTED.test(t)).join('\n').trim(); return text ? { role: 'user', text, at: o.timestamp ?? null, line } : null }
  if (p.role === 'assistant') { const text = textParts(p.content, ['output_text']).join('\n').trim(); return text ? { role: 'assistant', text, at: o.timestamp ?? null, line } : null }
  return null
}
/** fromClaude(record, line) → turn | null (a Claude Code log line: user text that is not a tool result or meta; assistant text parts). */
export function fromClaude(o, line) {
  if (!o || o.isMeta || o.isSidechain) return null
  const c = o.message?.content, cwd = typeof o.cwd === 'string' ? o.cwd : undefined
  if (o.type === 'user') {
    const text = typeof c === 'string' ? c : textParts(c, ['text']).join('\n')
    if (!text.trim() || INJECTED.test(text) || (Array.isArray(c) && c.some(x => x?.type === 'tool_result'))) return null
    return { role: 'user', text: text.trim(), at: o.timestamp ?? null, line, cwd }
  }
  if (o.type === 'assistant') { const text = textParts(c, ['text']).join('\n').trim(); return text ? { role: 'assistant', text, at: o.timestamp ?? null, line, cwd } : null }
  return null
}
/** fromAside(record, line) → turn | null ({ role, at (ms), text }). */
export function fromAside(o, line) {
  if (!o || (o.role !== 'user' && o.role !== 'assistant') || typeof o.text !== 'string' || !o.text.trim()) return null
  return { role: o.role, text: o.text.trim(), at: Number.isFinite(o.at) ? new Date(o.at).toISOString() : o.at ?? null, line }
}
export const READERS = Object.freeze({ codex: fromCodex, claude: fromClaude, aside: fromAside })

/** streamTurns(file, kind) → async iterable of turns; lines over EXAMPLE_LIMITS.lineBytes (tool payloads) are skipped unparsed. */
export async function* streamTurns(file, kind) {
  const read = READERS[kind]
  const rl = readline.createInterface({ input: createReadStream(file, { highWaterMark: 1 << 20 }), crlfDelay: Infinity })
  let n = 0, cwd = null
  for await (const raw of rl) {
    n++
    if (raw.length > EXAMPLE_LIMITS.lineBytes || !raw.includes('"')) continue
    let o
    try { o = JSON.parse(raw) } catch { continue }
    const turn = read(o, n)
    if (!turn) continue
    if (turn.cwd && !turn.role) { cwd = turn.cwd; continue }
    if (turn.cwd) cwd = turn.cwd
    yield { ...turn, cwd: turn.cwd ?? cwd }
  }
}

// ---- area, features, heuristic tags --------------------------------------------------------------------------------------------------
const TAEHWA = /태화|taehwa|온톨로지|ontology|jev\b/i
const EGDESK = /eg-?desk/i
/** areaOf({ cwd, project, text }) → 'taehwa' | 'egdesk' | null: the session's cwd / project first, then explicit mentions in the turn. */
export function areaOf({ cwd = '', project = '', text = '' }) {
  const where = `${cwd} ${project}`
  if (EGDESK.test(where)) return 'egdesk'
  if (/taehwa|태화/i.test(where)) return 'taehwa'
  if (TAEHWA.test(text)) return 'taehwa'
  if (EGDESK.test(text)) return 'egdesk'
  return null
}

// The closed set of interaction types (each one yes/no predicate in the labelling request). Heuristics only pick candidates.
export const INTERACTION_TYPES = Object.freeze({
  correction: { re: /^(아니|아냐|아뇨|노노|그게 아니라|그거 말고)|아니라\s|내가 말하는\s?건|내 말은|잘못 (이해|알아)|틀렸/, q: 'Does the person correct something the assistant said, read or did (a wrong fact, target or reading of what they meant)?' },
  pushback: { re: /왜 (멈|안 ?하|물어|묻)|빨리|그냥 (진행|해)|계속 (진행|해)|이제야|하라고|라니까|몇 번|또 (물어|멈)/, q: 'Does the person push back on how the assistant works (stopping, asking permission, being slow or cautious) and tell it to go on?' },
  approval: { re: /^(그래|응|ㅇㅇ|ㅇㅋ|좋아|좋습니다|ok|okay|오케이|ㄱㄱ|고고|진행(해|해줘|하자)?|당연하지|해줘|해|넵|네|예|yes|go)[.!~ ]*$/i, q: 'Is the turn a short approval or go-ahead of what the assistant proposed?' },
  ambiguous: { short: 14, q: 'Is the turn so short or vague that what it approves, chooses or asks can only be guessed from the assistant\'s message?' },
  referential: { re: /(방금|아까|위에|위의|그거|그것|그 내용|이거|저거|앞에서).{0,12}(정리|요약|다시|설명|말한|뭐|어떻게)/, q: 'Does the turn point back to something earlier ("that", "just now", "the above") instead of naming it?' },
  topic_switch: { re: /^(그리고|근데|그런데|참고로|아 그리고|다른 얘기|그건 그렇고)|이제 .{0,20}(하자|해보자|넘어가)/, q: 'Does the person move to a different topic from the assistant\'s message?' },
  topic_return: { re: /(다시|아까).{0,15}(돌아|얘기|그거|이어)|원래 (하던|얘기)/, q: 'Does the person return to a topic from earlier in the conversation (not the assistant\'s last message)?' },
  interruption: { re: /복구|되돌려|롤백|취소|멈춰|중지|그만|stop\b|^뭐야/i, q: 'Does the person stop the assistant, or ask it to undo or recover work?' },
  praise: { re: /좋네|좋다|잘했|완벽|훌륭|굿|나이스|고마워|감사|최고|great|nice|perfect/i, q: 'Does the person praise or thank the assistant?' },
  frustration: { re: /짜증|답답|기분 ?나|왜 이래|엉망|대충|도대체|대체 |ㅡㅡ|;;|\?\?|아오|하\.\.|진짜/, q: 'Does the person show frustration or annoyance?' },
  reask: { re: /안 ?보여|무슨 .{0,12}\?|뭔 소리|무슨 말|이해가 안|다시 설명|모르겠|뭐라는|뭘 말하는/, q: 'Does the person say the assistant\'s explanation was unclear or missing and ask again?' },
  instruction_change: { re: /말고 |대신 |바꿔|변경|이제부터|앞으로는|기준(을|은) /, q: 'Does the person change the instructions or criteria of the task in progress?' },
})
export const TYPE_NAMES = Object.freeze(Object.keys(INTERACTION_TYPES))

/** featuresOf(user, prev) → code features. */
export function featuresOf(user, prev = '') {
  const t = squash(user), p = squash(prev)
  const quotes = (() => { if (p.length < 12) return false; for (let i = 0; i + 12 <= t.length; i += 3) if (p.includes(t.slice(i, i + 12))) return true; return false })()
  return { length: t.length, lines: t.split('\n').length, question: /\?\s*$|[까나요니]\?*\s*$|뭐(야|지|였지)|어떻게|왜/.test(t), command: /(해|해줘|해봐|하자|해라|진행|정리|보여|찾아|알려)[.!~ ]*$/.test(t),
    approval: INTERACTION_TYPES.approval.re.test(t), quotesAssistant: quotes, code: /```|`[^`]+`/.test(t), url: /https?:\/\//.test(t) }
}
/** tagsOf(user, prev) → heuristic interaction types (candidates for labelling, not labels). */
export function tagsOf(user, prev = '') {
  const t = squash(user), f = featuresOf(user, prev)
  return TYPE_NAMES.filter(name => {
    const type = INTERACTION_TYPES[name]
    if (name === 'ambiguous') return f.length <= type.short && !f.question && prev.length > 0 && !/^(고마워|감사)/.test(t)
    return type.re.test(t)
  })
}

/**
 * examplesOf(turns, { source, file, project }) → examples. turns: one file's turns in order. Each user turn with an area becomes an
 * example; others are counted in .dropped.
 */
export function examplesOf(turns, { source, file, project = '' }) {
  const out = [], dropped = { no_area: 0, empty: 0 }
  let prev = null
  for (let i = 0; i < turns.length; i++) {
    const t = turns[i]
    if (t.role === 'assistant') { prev = t; continue }
    const userText = maskSecrets(head(t.text, EXAMPLE_LIMITS.user))
    if (!userText) { dropped.empty++; continue }
    const area = areaOf({ cwd: t.cwd ?? '', project, text: `${t.text}\n${prev?.text ?? ''}` })
    if (!area) { dropped.no_area++; prev = null; continue }
    const next = turns.slice(i + 1).find(x => x.role === 'assistant' || x.role === 'user')
    const prevText = prev ? maskSecrets(tail(prev.text, EXAMPLE_LIMITS.prev)) : ''
    const example = { schema: EXAMPLE_SCHEMA, area, privacy: 'owner-approved', source: { kind: source, file, line: t.line, ...(t.cwd ? { cwd: t.cwd } : {}) },
      at: t.at, prev: prev ? { text: prevText, at: prev.at, line: prev.line } : null, user: { text: userText },
      next: next?.role === 'assistant' ? { text: maskSecrets(head(next.text, EXAMPLE_LIMITS.next)), at: next.at, line: next.line } : null,
      features: featuresOf(userText, prevText), tags: tagsOf(userText, prevText) }
    example.id = sha(`${source}|${file}|${t.line}|${userText}`).slice(0, 16)
    example.hash = sha(JSON.stringify(example))
    out.push(example)
    prev = null
  }
  out.dropped = dropped
  return out
}

/** dedupe(examples) → examples without repeats of the same (assistant excerpt, user turn), keeping the earliest. */
export function dedupe(examples) {
  const seen = new Set()
  return [...examples].sort((a, b) => (String(a.at) < String(b.at) ? -1 : String(a.at) > String(b.at) ? 1 : a.id < b.id ? -1 : 1)).filter(e => { const k = sha(`${e.prev?.text ?? ''}|${e.user.text}`); if (seen.has(k)) return false; seen.add(k); return true })
}

// ---- the labelling request (one turn per request, R4; one predicate per type, R2) -------------------------------------------------------
export const LABEL_BAR = 0.8
const DEVELOPER = 'You read one turn a person wrote to an AI assistant, with the end of the assistant message just before it. Answer each question about the PERSON\'S TURN only, from what it says; the assistant excerpt is there so you can tell what the turn reacts to. Probability is how likely the answer is yes.'
/** labelRequest(example, model) → the Decisions body labelling this turn (no other turn in it). */
export function labelRequest(example, model) {
  const text = `${example.prev ? `The end of the assistant message before the turn:\n"""\n${example.prev.text}\n"""\n\n` : 'There is no assistant message before the turn.\n\n'}The person's turn:\n"""\n${example.user.text}\n"""`
  return { model, input: [{ role: 'developer', content: DEVELOPER }, { role: 'user', content: text }],
    questions: TYPE_NAMES.map(name => ({ type: 'predicate', name: `conv_${name}`, instructions: INTERACTION_TYPES[name].q })), prompt_cache_key: 'conversation-labels' }
}
/** readLabels(answers) → { [type]: 'yes' | 'no' | 'unknown' } at LABEL_BAR (a missing or refused answer is unknown, never no). */
export function readLabels(answers) {
  const list = Array.isArray(answers) ? answers : Object.entries(answers ?? {}).map(([name, a]) => ({ name, ...a }))
  return Object.fromEntries(TYPE_NAMES.map(name => { const a = list.find(x => x.name === `conv_${name}`), p = a?.probability
    return [name, typeof p !== 'number' ? 'unknown' : p >= LABEL_BAR ? 'yes' : p <= 0.2 ? 'no' : 'unknown'] }))
}

// ---- scenarios for the Decision features --------------------------------------------------------------------------------------------
// Which feature an interaction type exercises, and the proposed expectation (reviewed and pre-registered before any measurement).
export const FEATURE_OF = Object.freeze({
  approval: { feature: 'confirmation_reading', expect: 'A short approval confirms only what the assistant message just proposed; a pending reading it does not name stays pending.' },
  ambiguous: { feature: 'confirmation_reading', expect: 'An ambiguous short turn is not read as confirming a pending reading or a choice; the next step asks or proceeds only on what is unambiguous.' },
  correction: { feature: 'memory_update', expect: 'The correction moves the reading to what the person names; the corrected item is not kept as the person\'s statement.' },
  instruction_change: { feature: 'memory_update', expect: 'The changed instruction replaces the earlier one for the rest of the task; the earlier one is not applied again.' },
  pushback: { feature: 'heartbeat_waiting', expect: 'The person is waiting on the assistant: the next progress message (if any) says what is being done, never asks for a permission already given.' },
  frustration: { feature: 'heartbeat_waiting', expect: 'A frustrated, waiting person gets a concrete status (what happened, what is next) rather than another question.' },
  interruption: { feature: 'heartbeat_waiting', expect: 'Stop / recover requests end or undo the work first; no further step of the stopped work is taken.' },
  referential: { feature: 'referential_followup', expect: '"That / just now" resolves to the matter of the assistant\'s last message (briefing of that matter).' },
  topic_return: { feature: 'topic_return', expect: 'The earlier topic is picked up with its own materials, not the materials of the assistant\'s last message.' },
  topic_switch: { feature: 'topic_return', expect: 'The new topic does not inherit the previous topic\'s materials or pending readings.' },
  reask: { feature: 'closed_open_switch', expect: 'The person could not use the closed (option) answer: the next turn explains in plain words or opens the question (U4), not the same options again.' },
  praise: { feature: 'confirmation_reading', expect: 'Praise is not read as an approval of a pending proposal it does not name.' },
})
/** scenarioOf(example, labels?) → a scenario seed per feature the turn exercises (labels: readLabels output; else the heuristic tags). */
export function scenariosOf(example, labels = null) {
  const types = labels ? TYPE_NAMES.filter(n => labels[n] === 'yes') : example.tags
  const by = new Map()
  for (const type of types) { const f = FEATURE_OF[type]; if (!f) continue; if (!by.has(f.feature)) by.set(f.feature, []); by.get(f.feature).push(type) }
  return [...by].map(([feature, list]) => ({ id: `${example.id}:${feature}`, feature, area: example.area, privacy: example.privacy, labelledBy: labels ? 'decision_model' : 'heuristic',
    types: list, provenance: example.source, at: example.at,
    turns: [...(example.prev ? [{ role: 'assistant', text: example.prev.text }] : []), { role: 'user', text: example.user.text }],
    observedNext: example.next?.text ?? null,
    expectations: list.map(type => ({ status: 'proposed', type, says: FEATURE_OF[type].expect })) }))
}

// ---- the labelling plan -------------------------------------------------------------------------------------------------------------
// Two SYNTHETIC control turns ride in every chunk with hard expectations (they are written here, not taken from any conversation):
// the candidates' answers are recorded only (recordOnly: nothing is known about them before the labels), the controls say whether the
// labelling question set works at all.
export const CONTROL_EXAMPLES = Object.freeze([
  { id: 'control-correction', area: 'egdesk', privacy: 'owner-approved', prev: { text: '병합 기록을 c17 페이지에 남겼습니다.' }, user: { text: '아니 그거 c17이 아니라 c18이야' },
    expect: [{ name: 'conv_correction', kind: 'predicate', min: 0.8, severity: 'hard', note: 'names the wrong target and the right one' }, { name: 'conv_praise', kind: 'predicate', max: 0.2, severity: 'hard' }] },
  { id: 'control-praise', area: 'egdesk', privacy: 'owner-approved', prev: { text: '테스트를 모두 통과했고 보고서를 남겼습니다.' }, user: { text: '고마워요, 깔끔하게 잘했어' },
    expect: [{ name: 'conv_praise', kind: 'predicate', min: 0.8, severity: 'hard' }, { name: 'conv_correction', kind: 'predicate', max: 0.2, severity: 'hard' }, { name: 'conv_frustration', kind: 'predicate', max: 0.2, severity: 'hard' }] },
])
export const LABEL_PRODUCT_BARS = Object.freeze({ '*predicate': Object.freeze({ yes: LABEL_BAR, no: 0.2, source: 'helper/egdesk-conversation-examples.mjs readLabels (LABEL_BAR .8; a labelling study, no product action)' }) })
// The real-measure runner's own estimate (bytes and per-question overhead), so a chunk's declared estimate is what the runner checks.
const estimate = body => independentEstimate(0, JSON.parse(body).questions.length, Buffer.byteLength(body))
/** candidateOrder(examples) → candidates (any heuristic tag) in a deterministic order that covers every type and both areas early. */
export function candidateOrder(examples) {
  const buckets = TYPE_NAMES.map(type => AREAS.map(area => examples.filter(e => e.area === area && e.tags.includes(type)).sort((a, b) => (String(b.at) < String(a.at) ? -1 : String(b.at) > String(a.at) ? 1 : a.id < b.id ? -1 : 1))))
  const out = [], seen = new Set()
  for (let round = 0; out.length < examples.length; round++) {
    let added = false
    for (const byArea of buckets) for (const list of byArea) { const e = list.filter(x => !seen.has(x.id))[0]; if (e) { seen.add(e.id); out.push(e); added = true } }
    if (!added) break
  }
  return out
}
/** buildLabelPlan(examples, { model, chunkTokens, sha }) → [{ plan, requests: [{ file, body }], preregistration }] */
export function buildLabelPlan(examples, { model, chunkTokens = 12_000, sha }) {
  const controls = CONTROL_EXAMPLES.map(c => ({ id: `control-${c.id.replace(/^control-/, '')}`, body: JSON.stringify(labelRequest(c, model)), expect: c.expect, control: c }))
  const controlTokens = controls.reduce((n, c) => n + estimate(c.body), 0)
  const chunks = []
  let cur = null
  // The controls ride in the first chunk only (each request costs about 2,200 tokens: twelve predicates).
  const open = () => { const first = !chunks.length; cur = { items: first ? [...controls] : [], tokens: first ? controlTokens : 0, base: first ? controls.length : 0 }; chunks.push(cur) }
  for (const e of candidateOrder(examples)) {
    const body = JSON.stringify(labelRequest(e, model)), t = estimate(body)
    // A chunk stays within chunkTokens / 1.25 so its ceiling (estimate x 1.25) is at most chunkTokens.
    if (!cur || (cur.tokens + t > chunkTokens / 1.25 && cur.items.length > cur.base)) open()
    cur.items.push({ id: `ex-${e.id}`, body, example: e }); cur.tokens += t
  }
  return chunks.map((c, i) => {
    const requests = c.items.map(item => ({ file: `requests/${item.id}.json`, body: item.body }))
    const total = c.items.reduce((n, item) => n + estimate(item.body), 0)
    const plan = { set: `conversation-labels-${String(i + 1).padStart(3, '0')}`, tokenCeiling: Math.min(Math.ceil(total * 1.25), chunkTokens), productBars: LABEL_PRODUCT_BARS,
      seeds: [{ id: 'conversation-examples', privacy: 'owner-approved' }],
      passRule: i === 0 ? 'Pass: every hard expectation of the two synthetic controls holds. The candidate turns are recordOnly: their answers become labels (readLabels at .8), never counted as passed.' : 'Record only: the answers become labels (readLabels at .8); the controls of chunk 001 say whether the question set works.',
      requests: c.items.map(item => ({ id: item.id, file: `requests/${item.id}.json`, sha256: sha(item.body), estInputTokens: estimate(item.body), ...(item.expect ? { expect: item.expect } : { expect: [], recordOnly: true }) })) }
    const preregistration = c.items.map(item => (item.control ? { id: item.id, control: true, turn: item.control.user.text, expect: item.expect }
      : { id: item.id, area: item.example.area, at: item.example.at, provenance: item.example.source, heuristicTags: item.example.tags, recordOnly: true }))
    return { plan, requests, preregistration }
  })
}
