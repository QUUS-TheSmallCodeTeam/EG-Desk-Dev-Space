import { sameSiteNavigation } from './egdesk-browser-tool-runtime.mjs'
import { compactText } from './egdesk-decision-questions.mjs'
import { allowsPage } from './egdesk-wiki-reconstruction.mjs'
import { judgeTurnWrite } from './egdesk-turn-memory.mjs'

// How the objective browser task USES the general conversation-memory feature (L8 cycle 8). There is no browser-only
// history store: memory lives in the ontology (llm-wiki) and is fetched and written by the general feature.
//
//   READ  (task start): the turn's memory packet (first-turn reconstruction or mid-session fetch, egdesk-turn-memory.mjs)
//         is evidence for the entry decision and for every objective step. Code also parses the strict task-outcome pages
//         among the fetched pages into structured facts ("on this path the earlier run settled the question by choosing
//         X") for one code rule: if that earlier choice is no longer listed on the page, ask the user, whatever the
//         Decision model picked.
//   WRITE (task end, done or stuck): a content-minimal task-outcome candidate is handed to the GENERAL per-turn ontology
//         write judgment (judgeTurnWrite) and the host write path (createWikiWriter; its flag, permission, revision and
//         idempotency checks). This module stores nothing itself.
//
// An outcome holds only: a UTC day, the host name, the user's request (shortened), the outcome (done, or a closed stop
// code), labels of opened elements, sanitized paths (no query, fragment or token-like segment), and for each "which
// one?" question the label that settled it and the path it was asked on. Never a field value, page text, URL with a
// query, credential, cookie, user reply or model output.

export const OUTCOME_PAGE_PREFIX = 'browser-task/'
export const OUTCOME_OPERATION_PREFIX = 'browser-task:'
const STUCK_CODES = new Set(['blocked', 'access_denied', 'error_page', 'modal_blocking', 'uncertain', 'press_needs_expected_effect', 'tool_failed',
  'observe_failed', 'step_rejected', 'step_limit', 'human_step', 'login_required', 'two_factor_required', 'bot_check', 'sensitive_flow'])
const ASKED = new Set(['choice_needed', 'detail_needed'])
const MAX_TRAIL = 12, MAX_RESOLVED = 4
const record = value => value !== null && typeof value === 'object' && !Array.isArray(value)
const dayOf = ms => new Date(ms).toISOString().slice(0, 10)
const stripPrefix = text => String(text ?? '').replace(/^\[[A-Z]\d+\]\s*/, '')
export const labelKey = text => compactText(stripPrefix(text), 60).replace(/[\r\n|@]/g, ' ')

// A path without query or fragment; a long or token-like segment becomes '*'. Returns '' when it cannot be a path.
export function safePath(href) {
  let pathname
  try { pathname = new URL(href, 'https://x.invalid').pathname } catch { return '' }
  const parts = pathname.split('/').filter(Boolean).slice(0, 6).map(part => {
    let seg = part
    try { seg = decodeURIComponent(part) } catch { /* keep raw */ }
    if (seg.length > 32 || /^[0-9a-f]{12,}$/i.test(seg) || /^(?=.*\d)(?=.*[a-z])[a-z0-9_-]{16,}$/i.test(seg) || /[@=\s]/.test(seg)) return '*'
    return seg
  })
  return `/${parts.join('/')}`
}

export function hostOf(href) {
  try { const url = new URL(href); return ['http:', 'https:'].includes(url.protocol) ? url.hostname.toLowerCase() : '' } catch { return '' }
}

/**
 * outcomeCandidate({ taskId, goal, host, outcome, trail, resolved, now }) -> { taskId, host, day, outcome, text } | null
 * Whitelist rebuild; text is composed by code from the sanitized parts in a fixed layout (parseOutcomeText reads it back).
 */
export function outcomeCandidate({ taskId, goal, host, outcome, trail = [], resolved = [], now = Date.now() } = {}) {
  if (typeof taskId !== 'string' || !/^bt_[0-9a-f]{12}$/.test(taskId) || typeof host !== 'string' || !/^[a-z0-9.-]{1,120}$/.test(host)) return null
  const done = outcome?.status === 'done'
  if (!done && !(outcome?.status === 'stuck' && STUCK_CODES.has(outcome.code))) return null
  const day = dayOf(now)
  const goalText = compactText(goal, 120).replace(/[\r\n]/g, ' ')
  const lines = ['브라우저 작업 기록', `요청: ${goalText}`, `사이트: ${host} / 날짜: ${day}`]
  for (const item of (Array.isArray(resolved) ? resolved : []).slice(0, MAX_RESOLVED)) {
    if (!record(item) || !ASKED.has(item.asked)) continue
    const chose = labelKey(item.chose), at = safePath(item.at || '')
    if (chose && at) lines.push(`선택: ${chose} @ ${at} [${item.asked}]`)
  }
  for (const step of (Array.isArray(trail) ? trail : []).slice(0, MAX_TRAIL)) {
    if (!record(step) || step.op !== 'open') continue
    const label = labelKey(step.label)
    if (label) lines.push(`연 항목: ${label} (${safePath(step.from || '') || '/'} -> ${safePath(step.to || '') || '/'})`)
  }
  lines.push(done ? '작업을 완료했다.' : `작업이 중단됐다 (${outcome.code}).`)
  return { taskId, host, day, outcome: done ? { status: 'done' } : { status: 'stuck', code: outcome.code }, text: lines.join('\n') }
}

/** The strict reverse of outcomeCandidate().text; null for anything that does not match the layout exactly. */
export function parseOutcomeText(text) {
  if (typeof text !== 'string' || !text.startsWith('브라우저 작업 기록\n')) return null
  const lines = text.split('\n')
  const goal = /^요청: (.*)$/.exec(lines[1] ?? '')
  const site = /^사이트: ([a-z0-9.-]{1,120}) \/ 날짜: (\d{4}-\d{2}-\d{2})$/.exec(lines[2] ?? '')
  const last = lines.at(-1)
  const end = last === '작업을 완료했다.' ? { status: 'done' } : (() => { const m = /^작업이 중단됐다 \(([a-z_]+)\)\.$/.exec(last ?? ''); return m && STUCK_CODES.has(m[1]) ? { status: 'stuck', code: m[1] } : null })()
  if (!goal || !site || !end) return null
  const resolved = [], trail = []
  for (const line of lines.slice(3, -1)) {
    let m
    if ((m = /^선택: (.+) @ (\/\S*) \[(choice_needed|detail_needed)\]$/.exec(line))) resolved.push({ asked: m[3], chose: m[1], at: m[2] })
    else if ((m = /^연 항목: (.+) \((\/\S*) -> (\/\S*)\)$/.exec(line))) trail.push({ op: 'open', label: m[1], from: m[2], to: m[3] })
    else return null
  }
  return { goal: goal[1], host: site[1], day: site[2], outcome: end, resolved, trail }
}

/**
 * priorFromMemory(pages, { scope, hosts }) -> the newest parsed task-outcome record for one of the granted sites, or null.
 * pages: the pages the memory feature fetched for this turn. Only strict browser-task pages (id prefix, agent_note
 * provenance, exact layout) become structured facts; any other page is evidence text only. Permission is re-checked.
 */
export function priorFromMemory(pages, { scope = null, hosts = [] } = {}) {
  const parsed = []
  for (const page of Array.isArray(pages) ? pages : []) {
    if (!record(page) || typeof page.id !== 'string' || !page.id.startsWith(OUTCOME_PAGE_PREFIX) || page.provenance?.kind !== 'agent_note') continue
    let allowed = false
    try { allowed = allowsPage(page, scope) } catch { allowed = false }
    if (!allowed) continue
    const rec = parseOutcomeText(page.body)
    if (rec && hosts.some(host => host && sameSiteNavigation(`https://${host}/`, `https://${rec.host}/`))) parsed.push({ ...rec, pageId: page.id })
  }
  parsed.sort((a, b) => (a.day < b.day ? 1 : a.day > b.day ? -1 : (a.outcome.status === 'done' ? 0 : 1) - (b.outcome.status === 'done' ? 0 : 1)))
  return parsed[0] ?? null
}

/**
 * createOutcomeToOntology({ wiki, client, writer, scope, enabled, now }) -> { write(candidate, { memoryPages }) -> Promise<{ status, ... }> }
 * Hands a candidate to the general write judgment and the host write path. enabled=false (the default) calls nothing.
 */
export function createOutcomeToOntology({ wiki, client, writer, scope = null, enabled = false, now = Date.now, egress = null } = {}) {
  return {
    async write(candidate, { memoryPages = [] } = {}) {
      if (enabled !== true) return { status: 'flag_off' }
      if (!candidate || !wiki?.pages || !writer || typeof writer.apply !== 'function') return { status: 'unavailable' }
      // Records of a Browser task leave only when the run's models may see Browser data (shared gate).
      if (egress && (!egress.allows('browser_task_record') || !egress.allows('memory_page'))) return { status: 'unavailable', reason: 'egress' }
      try {
        const candidates = memoryPages.filter(page => page && wiki.pages.has(page.id) && allowsPage(page, scope))
        const { proposal, receipt } = await judgeTurnWrite({ message: candidate.text, candidates, client, askedAt: now() })
        if (proposal.op === 'none') return { status: 'not_written', reason: proposal.reason, judged: receipt?.target?.value ?? null }
        // The text is the host's own record of a browser task, not something the person said. It is always a NEW page: a task
        // outcome never changes another page's status, so an update proposal becomes a page of its own (links dropped).
        const provenance = { kind: 'agent_note' }
        const shaped = proposal.op === 'update_status'
          ? { op: 'new_page', time: proposal.time, status: proposal.proposedStatus, links: [], spokenAt: proposal.spokenAt ?? null }
          : proposal
        const applied = writer.apply({ ...shaped, provenance }, { message: candidate.text, scope, operationId: `${OUTCOME_OPERATION_PREFIX}${candidate.taskId}${candidate.outcome?.status === 'stuck' ? '-stuck' : ''}` })
        return { status: applied.status, ...(applied.reason ? { reason: applied.reason } : {}), ...(applied.pageId ? { pageId: applied.pageId } : {}) }
      } catch { return { status: 'unavailable' } }
    },
  }
}

// ---- the recorded choice, compared by code (R3) ----
// Real measurement (2026-11-25, plan browser-live-v1): with the record in the evidence the model picked the recorded business at only 0.76
// (one hundredth above the bar), and on a page where it was gone it answered flat (0.21 / 0.22) without naming the candidates. Whether the
// recorded label is among the offered labels is a string comparison, so code makes it.
// c17 (real, plan browser-live-recorded-v2, 2026-11-25): asked whether "가나상사 (987-65-43210)" is the same thing as "사업자 987-65-43210",
// the model answered 0.75, undecided, and the task paused. An identical long identifier in both labels is a fact code can compare: it is a
// code match. The same-thing predicate stays only for label pairs without identifiers on both sides (one candidate per predicate, R4).
export const MAX_SAME_THING = 3
export const MIN_IDENTIFIER_DIGITS = 8
const normLabel = text => String(text ?? '').normalize('NFKC').toLowerCase().replace(/^\[[a-z]\d+\]\s*/, '').replace(/\s+/g, ' ').trim()
// A digit run joined only by "-" or "." (never by spaces, so two numbers side by side never merge into one).
const DIGIT_RUN = /\d+(?:[-.]\d+)*/g
// A calendar date is not an identifier: 2026-11-19, 2026.11.19, 20261119 (year 1900-2099, a real month and day).
const isDate = run => {
  const parts = run.split(/[-.]/)
  const [y, m, d] = parts.length === 3 ? parts : /^\d{8}$/.test(run) ? [run.slice(0, 4), run.slice(4, 6), run.slice(6)] : []
  return y !== undefined && /^(?:19|20)\d\d$/.test(y) && +m >= 1 && +m <= 12 && +d >= 1 && +d <= 31
}
/**
 * identifiersOf(text) -> the long identifiers in a label: digit runs of at least MIN_IDENTIFIER_DIGITS digits once the separators are
 * removed (a registration, account or order number), never a date. Compared whole: a prefix, a suffix or a part is a different number.
 */
export const identifiersOf = text => [...new Set((normLabel(text).match(DIGIT_RUN) || []).filter(run => !isDate(run)).map(run => run.replace(/\D/g, '')).filter(digits => digits.length >= MIN_IDENTIFIER_DIGITS))]
const wordsOf = text => normLabel(text).replace(DIGIT_RUN, ' ').split(/[^\p{L}\p{N}]+/u).filter(word => word.length >= 2)
const names = (text, option) => {
  const hay = normLabel(text), label = normLabel(labelKey(option.value)), ids = identifiersOf(text)
  return (label.length >= 4 && hay.includes(label)) || identifiersOf(option.value).some(id => ids.includes(id))
}
/**
 * sameByCode(recorded, label) -> 'same' | 'different' | 'unknown' (code facts only):
 *  'same'      the labels are equal once normalised, or both carry long identifiers and share one;
 *  'different' both carry long identifiers and share none (two registration numbers that differ are two businesses);
 *  'unknown'   at least one side has no long identifier; whether they are the same thing is a judgment, asked only when they share a word.
 */
export function sameByCode(recorded, label) {
  if (normLabel(recorded) === normLabel(labelKey(label))) return 'same'
  const a = identifiersOf(recorded), b = identifiersOf(label)
  if (a.length && b.length) return a.some(id => b.includes(id)) ? 'same' : 'different'
  return 'unknown'
}

/**
 * recordedChoice(prior, snapshot, options, { goal, userContext }) -> null | { kind, item, option?, by?, maybe?, candidates? }
 * For the newest "which one?" the earlier run settled on THIS path, compared with the labels offered now (sameByCode):
 *  - 'one'      exactly one offered label is the same by code (equal label, or the same long identifier): code takes it (by: label|identifier).
 *  - 'several'  more than one is the same by code: the person decides among them.
 *  - 'maybe'    none is the same by code, and 1..MAX_SAME_THING labels without an identifier on both sides share a word with it: one predicate each.
 *  - 'none'     nothing offered is, or may be, the recorded choice: the person decides among the page's candidates.
 * null when nothing was settled on this path, or when the person's words in this task (a reply), or a current request that differs from
 * the recorded one and does not name the recorded choice, or a request naming another offered element, should be judged instead: then
 * the step is asked as before (the current request overrides the earlier run).
 */
export function recordedChoice(prior, snapshot, options, { goal = '', userContext = [] } = {}) {
  if (!record(prior)) return null
  const here = safePath(snapshot?.url || '')
  const item = [...(prior.resolved || [])].reverse().find(entry => entry.at === here && ASKED.has(entry.asked))
  if (!item) return null
  if ((Array.isArray(userContext) ? userContext : []).some(line => typeof line === 'string' && line.trim())) return null
  const offered = (options || []).filter(option => option.item?.kind !== 'fill')
  const key = normLabel(item.chose)
  const verdict = new Map(offered.map(option => [option, sameByCode(item.chose, option.value)]))
  const matches = offered.filter(option => verdict.get(option) === 'same')
  const recordedWords = new Set(wordsOf(item.chose))
  const sharesWord = option => wordsOf(labelKey(option.value)).some(word => recordedWords.has(word))
  const maybe = matches.length ? [] : offered.filter(option => verdict.get(option) === 'unknown' && sharesWord(option))
  const others = offered.filter(option => !matches.includes(option) && !maybe.includes(option))
  if (others.some(option => names(goal, option))) return null
  const ids = identifiersOf(item.chose)
  const sameRequest = normLabel(compactText(goal, 120).replace(/[\r\n]/g, ' ')) === normLabel(prior.goal)
  const namesRecorded = normLabel(goal).includes(key) || identifiersOf(goal).some(id => ids.includes(id))
  if (matches.length === 1) {
    const by = normLabel(labelKey(matches[0].value)) === key ? 'label' : 'identifier'
    return sameRequest || namesRecorded ? { kind: 'one', item, option: matches[0], by } : null
  }
  if (matches.length > 1) return { kind: 'several', item, candidates: matches.map(option => option.value) }
  if (maybe.length) {
    if (maybe.length > MAX_SAME_THING) return { kind: 'several', item, candidates: maybe.map(option => option.value) }
    return sameRequest || namesRecorded ? { kind: 'maybe', item, maybe } : null
  }
  if (offered.some(option => names(goal, option))) return null
  const alike = offered.filter(sharesWord)
  return { kind: 'none', item, candidates: (alike.length ? alike : offered).map(option => option.value) }
}

/**
 * priorFacts(prior, snapshot, options) -> { lines, conflict }
 * Code-computed facts about the earlier run against THIS page: where an earlier "which one?" was settled on this path, is
 * that label listed now? A label that is gone is a conflict: the loop must ask the user, whatever the Decision model
 * picked among the listed elements.
 */
export function priorFacts(prior, snapshot, options) {
  if (!record(prior)) return { lines: [], conflict: false }
  const lines = [`Earlier run (${prior.day}, ${prior.outcome?.status === 'done' ? 'done' : `stopped: ${prior.outcome?.code}`}) of this task on this site: ${(prior.trail || []).map(step => `opened "${step.label}" (${step.from} -> ${step.to})`).join(', ') || 'nothing opened'}.`]
  let conflict = false
  const here = safePath(snapshot?.url || '')
  for (const item of prior.resolved || []) {
    if (item.at !== here) continue
    const match = (options || []).find(option => labelKey(option.value) === item.chose)
    if (match) lines.push(`On this page the earlier run settled "${item.asked}" by choosing "${item.chose}"; it is listed now as ${match.value}.`)
    else { conflict = true; lines.push(`On this page the earlier run settled "${item.asked}" by choosing "${item.chose}"; it is NOT listed now.`) }
  }
  return { lines, conflict }
}
