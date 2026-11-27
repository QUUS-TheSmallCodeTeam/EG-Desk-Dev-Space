// L4 cycle 29: a TRUE same-window briefing case from the person's own conversation (Main's bounds: EG-Desk-area conversations only, message text only - the
// person's and the assistant's, no tool outputs, no attachments - masked; nothing from Taehwa_Gmail_PoC or any 태화 customer mail / SQL). Pure: turns in, rows out.
// - the request: a real summary / compare / progress request (briefingRequestKind)
// - the materials: the SAME conversation's message turns before it (the person's and the assistant's), as pages
// - the answer: the REAL completed assistant answer that followed (the last assistant message before the person's next turn; D1: completed messages only)
import { answerFacts, lineTextMax } from './egdesk-briefing-skeleton.mjs'
import { maskSecrets } from './egdesk-secret-mask.mjs'
import { briefingRequestKind } from './egdesk-briefing-real-requests.mjs'

export const SAME_WINDOW_LIMITS = Object.freeze({ materials: 3, excerpt: 400, title: 80, answer: 1200, minAnswer: 300, controlAnswer: 300 })
// Out of bounds whatever the area says: the Taehwa Gmail PoC and 태화 customer mail / SQL
const EXCLUDED = /Taehwa_Gmail_PoC|taehwatrans|태화\S*\s*(?:고객|메일|mail|SQL)|@taehwa/i
const INJECTED_ANSWER = /^\s*<[a-z_-]+[\s>]/i // an automation record that reached the log as assistant text (<heartbeat>...), not an answer the person read
const mask = t => maskSecrets(String(t ?? '')).replace(/\/Users\/[^/\s)>\]]+\//g, '~/')
const squash = t => String(t).replace(/\s+/g, ' ').trim()
const cut = (t, n) => (t.length <= n ? t : `${t.slice(0, n - 1).trimEnd()}…`)
const stamp = at => { const d = new Date(at); return Number.isNaN(d.getTime()) ? null : { day: d.toISOString().slice(0, 10), hm: d.toISOString().slice(11, 16), md: d.toISOString().slice(5, 10) } }
export const excluded = text => EXCLUDED.test(String(text ?? ''))

/** finalAnswer(turns, i) -> the last assistant turn after turns[i] and before the person's next turn, or null */
export function finalAnswer(turns, i) {
  let a = null
  for (let j = i + 1; j < turns.length && turns[j].role !== 'user'; j++) if (turns[j].role === 'assistant') a = turns[j]
  return a
}
/** turnPages(before) -> pages in lane L7's memory-row shape: one per message turn, dated by the log's own timestamp (UTC), linked in order (follows_from) */
export function turnPages(before, { idPrefix = 't' } = {}) {
  return before.map((t, k) => {
    const s = stamp(t.at), who = t.role === 'user' ? '사람' : 'Agent', text = squash(mask(t.text))
    const id = `${idPrefix}-${t.line}`
    return { id, kind: 'page', title: cut(`${who}${s ? ` ${s.md} ${s.hm}` : ''} ${text}`, SAME_WINDOW_LIMITS.title), excerpt: cut(text, SAME_WINDOW_LIMITS.excerpt),
      time: { at: s?.day ?? null }, status: 'unknown', links: k ? [{ type: 'follows_from', toAlias: `${idPrefix}-${before[k - 1].line}` }] : [], held: false, source: 'conversation', role: t.role, line: t.line }
  })
}
/**
 * sameWindowCase(turns, line, { materials }) -> { request, answer, pages, dropped } for the person's turn at that log line.
 * dropped: 'not-found' | 'no-answer' | 'short-answer' | 'no-material' | 'excluded' (out of bounds) | null
 */
export function sameWindowCase(turns, line, { materials = SAME_WINDOW_LIMITS.materials, minAnswer = SAME_WINDOW_LIMITS.minAnswer } = {}) {
  const i = turns.findIndex(t => t.role === 'user' && t.line === line)
  if (i < 0) return { dropped: 'not-found' }
  const ans = finalAnswer(turns, i)
  if (!ans || INJECTED_ANSWER.test(ans.text)) return { dropped: 'no-answer' }
  if (excluded(turns[i].text) || excluded(ans.text)) return { dropped: 'excluded' }
  if (ans.text.length < minAnswer) return { dropped: 'short-answer' }
  const before = turns.slice(0, i).filter(t => (t.role === 'user' || t.role === 'assistant') && !excluded(t.text)).slice(-materials)
  if (before.length < 2) return { dropped: 'no-material' }
  return { request: { text: squash(mask(turns[i].text)), line, at: turns[i].at }, // the answer as the person read it (its line structure kept: the product splits a markdown answer by its own bullets / rows), masked, at the product's 1,200
    answer: { text: cut(mask(ans.text).trim(), SAME_WINDOW_LIMITS.answer), line: ans.line, at: ans.at },
    pages: turnPages(before, { idPrefix: `t${line}` }), dropped: null }
}
/** askKind(text) -> 'compare' | 'progress' | 'summary' (the kind of ask, for diversity) */
export function askKind(text) {
  const t = String(text)
  if (/비교|compare/i.test(t)) return 'compare'
  if (/어디까지|진행 ?상황|현황|진척|progress|status/i.test(t)) return 'progress'
  return 'summary'
}
/** pickDiverse(cases, n) -> one case per kind of ask first (compare, progress, summary), then by distinct conversation; longer real answers first. */
export function pickDiverse(cases, n = 3) {
  const ok = cases.filter(c => !c.dropped).sort((a, b) => b.answer.text.length - a.answer.text.length)
  const out = []
  for (const kind of ['compare', 'progress', 'summary']) { const c = ok.find(x => askKind(x.request.text) === kind && !out.includes(x)); if (c && out.length < n) out.push(c) }
  for (const c of ok) if (out.length < n && !out.includes(c) && !out.some(x => x.file === c.file)) out.push(c)
  return out
}
/** oneFactControl(turns) -> the person's short one-fact question whose REAL answer is one fact (at most one fact by the coverage split, short), or null */
export function oneFactControl(turns, { maxAnswer = SAME_WINDOW_LIMITS.controlAnswer } = {}) {
  for (let i = 0; i < turns.length; i++) {
    if (turns[i].role !== 'user' || briefingRequestKind(turns[i].text) !== 'one_fact' || excluded(turns[i].text)) continue
    const ans = finalAnswer(turns, i)
    if (!ans || INJECTED_ANSWER.test(ans.text) || excluded(ans.text) || ans.text.length > maxAnswer) continue
    const text = mask(ans.text).trim()
    if (answerFacts(text).facts.length > 1) continue // a list, a table or several sentences is not one fact
    return { line: turns[i].line, request: { text: squash(mask(turns[i].text)), line: turns[i].line, at: turns[i].at }, answer: { text, line: ans.line, at: ans.at } }
  }
  return null
}

// Cycle 30 (item 0, c29 coverage F1/F2 and F6 were pre-registered as shown, the board did not carry them): a fact is EXPECTED on the board only when what the
// faithful fill copies from a cited turn carries all of its distinctive content. A list line holds lineTextMax characters (90) from the START of the turn's text;
// "the turn contains the number somewhere in its 400-character excerpt" says the material has it, not that the card shows it.
const norm = t => String(t).toLowerCase().replace(/[\s·*`|_~\-—:.,()]+/g, '')
/** distinctive tokens of a fact: numbers with their unit, ids and Latin words of 3+ characters, Korean words of 3+ syllables */
export const distinctiveTokens = fact => [...new Set([...String(fact).matchAll(/[A-Za-z][A-Za-z0-9_/.-]{2,}|\d[\d,.]*\s?[가-힣A-Za-z%]*|[가-힣]{3,}/g)].map(m => norm(m[0])).filter(x => x.length >= 3))]
/** what the faithful fill copies from a page into one list line */
export const copiedLine = (page, max = lineTextMax()) => cut(squash(page.excerpt ?? ''), max)
/** -> { tokens, inLine: the cited pages whose copied line carries every token, inExcerpt: pages whose excerpt does, inTurn: tokens found in the excerpts at all } */
export function factPlacement(fact, pages) {
  const tokens = distinctiveTokens(fact)
  const has = (text, ts) => ts.every(t => norm(text).includes(t))
  return { tokens: tokens.length, inLine: pages.filter(p => tokens.length && has(copiedLine(p), tokens)).map(p => p.id), inExcerpt: pages.filter(p => tokens.length && has(p.excerpt ?? '', tokens)).map(p => p.id),
    found: tokens.filter(t => pages.some(p => norm(p.excerpt ?? '').includes(t))).length }
}
