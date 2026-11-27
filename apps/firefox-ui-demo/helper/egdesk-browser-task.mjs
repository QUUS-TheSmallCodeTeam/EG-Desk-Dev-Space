import { conversationAuthority } from './egdesk-browser-authority.mjs'
import { requestedMotion } from './egdesk-browser-motion.mjs'
import { controlLines, localDay, pageTextOn } from './egdesk-browser-reflex.mjs'
import { randomBytes } from 'node:crypto'
import { DecisionError, FOREGROUND_DECISION_TIMEOUT_MS } from './egdesk-decision-client.mjs'
import { hostOf, hrefIdentifiers, identifiersOf, labelKey, outcomeCandidate, priorFromMemory, safePath } from './egdesk-browser-task-memory.mjs'
import { decideOpenItem, settledNote } from './egdesk-browser-open-items.mjs'
import { choiceContextLine } from './egdesk-browser-choice-reply.mjs'
import { choiceQuestion, compactText, decisionThresholds, predicateQuestion, readChoice, tableOptions } from './egdesk-decision-questions.mjs'
import { candidateSpans, pickFieldText, undecidedField } from './egdesk-browser-field-text.mjs'

// Direct chat -> objective browser entry (L8 cycle 6; DECISION_MODEL_INTEGRATION_SUGGESTIONS.md §2 Pillar 1, §4.3, §9.3).
//
// Paradigm: the Decision model is a system-level judge. It never speaks to the user and its probability is never
// execution permission. The user's own chat message becomes the goal of an objective browser task directly (no
// subjective sub-goal step). Every objective step offers fixed options (done, need more context from the user,
// cannot proceed); when the judge picks one, control exits to the subjective model, which talks to the user in the
// same DM. The user's next message resumes the same task with that context.
//
// Pieces here (all pure or in-memory; the chat runtime wiring is a separate step, see the cycle report):
// - entryQuestion/readBrowserEntry/decideBrowserEntry: "is this message a browser task, and on which open card" over
//   options the runtime enumerates (granted interact cards) plus two fixed options. It is one choice question, so a
//   caller that already sends a turn-start Decisions request adds it to that request instead of making a second one.
// - createBrowserTaskStore: task id, card, step count, entered values (reflex state), user context, pause reason.
// - createDirectBrowserEntry().handle(): gate, resume-or-enter, run the objective loop, and return either
//   { handled: false, reason } (an ordinary subjective turn) or { handled: true, status, note } where note is the
//   structured, data-minimal text the subjective model receives.
// Auto-execution scope is unchanged (canon §5.2): same-site links, scrolling, entering supplied values. Submit,
// payment, permission and delete are never candidates; the note says "human_step" when only such elements remain.

export const ENTRY_CONTROLS = Object.freeze({
  not_browser_task: 'The message is not asking for something to be done in a browser page.',
  ask_user: 'The message is probably a browser task but it is unclear which listed card it concerns.',
})
export const RESUME_CONTROLS = Object.freeze({
  resume_task: 'The message gives what the paused browser task asked for, or says the blocking step is done.',
  cancel_task: 'The user no longer wants the paused browser task.',
  unrelated: 'The message is about something else; keep the browser task paused.',
})
export const MAX_TASK_STEPS = 24
export const BROWSER_TASK_TTL_MS = 30 * 60 * 1000 // a paused task can be resumed this long; a run held open for the reply waits no longer
const SEGMENT_STEPS = 6
const ASKED_CODES = new Set(['choice_needed', 'detail_needed'])
const MAX_BRIEF_GOAL = 160
const MAX_GOAL_CHANGES = 3, MAX_CHANGE_CHARS = 160, MAX_GOAL_BASE_CHARS = 200
const MAX_FOUND_SEGMENTS = 3, MAX_FOUND_CHARS = 240
export const MAX_PAGE_LINES = 8, MAX_PAGE_CHARS = 480 // c30: the lines of the page a finished task ends on (bounded), where nothing was located by an identifier
// The last page action of a running task, as a closed word (the brief's `last`); a paused task's `last` is its pause code.
const LAST_KIND_OF_TOOL = Object.freeze({ egdesk_browser_navigate: 'opened_link', egdesk_browser_scroll: 'scrolled', egdesk_browser_fill: 'filled_field' })
const MAX_ENTRY_ASKS = 2 // "which card?" at most twice; then the request goes back to the ordinary turn
const MAX_MESSAGE = 500
const MAX_TASKS = 32

const record = value => value !== null && typeof value === 'object' && !Array.isArray(value)
const label = (index, host) => `[C${index}] ${compactText(host, 60) || 'browser card'}`

/** cards: [{ cardId, host?, title? }] from the run's granted interact cards (code-enumerated, never model-written). */
export function entryOptions(cards) {
  const options = cards.map((card, index) => ({ value: label(index + 1, card.host), description: 'An open Browser Card the user granted to this chat.', cardId: card.cardId }))
  return options
}

// ---- c20: the entry, redesigned from the three real generalisation bodies (R1-R4) ----
// Real (2026-11-25, plans browser-live-{statement,delivery,settings}-v1): asked as one N-way choice over "[C1] <host>" plus "not a browser
// task", the entry did not generalise: statement [C1] 0.58 (.72 / .27), delivery [C1] 0.30 (.53 / .46), settings not_browser_task 0.90.
// The choice saw a bare host and had a default-like option (R2); the invoice family had passed at 0.93. Now:
//  1. code first (R3): exactly one open card whose host or title names a site or service the request names -> that card (no card question);
//  2. otherwise one yes/no predicate per card, quoting that page alone by title and host (R4), and always one predicate about the request
//     itself ("something to do in a web page rather than an answer?"); code combines.
export const MAX_ENTRY_CARDS = 6
export const ENTRY_WEB = 'browser_entry'
export const entryCardName = index => `browser_entry_card_${index}`
export const entryWallName = index => `browser_entry_wall_${index}`
const ENTRY_YES = 0.75, ENTRY_NO = 0.25
export const ENTRY_LINES = 3, ENTRY_LINE_CHARS = 60
const norm = text => String(text ?? '').normalize('NFKC').toLowerCase().replace(/\s+/g, ' ').trim()
// Host labels that name no site (public suffixes, generic subdomains, the synthetic test domains) and title parts that name no service.
const HOST_STOP = new Set(['www', 'm', 'mobile', 'com', 'net', 'org', 'co', 'kr', 'go', 'or', 'ac', 'io', 'app', 'example', 'test', 'invalid', 'localhost', 'local'])
const TITLE_STOP = new Set(['홈', 'home', '메인', 'main', '로그인', 'login', 'sign in', '설정', 'settings', '검색', 'search', 'new tab', '새 탭', '알림', 'untitled'])
const titleParts = title => String(title ?? '').split(/\s[|\-–—·:]\s|[|·]/u).map(norm).filter(part => part.replace(/\s/g, '').length >= 4 && !TITLE_STOP.has(part))
/** The card the request names by code: exactly one card whose host label or title part appears in the request; else null. */
export function codeEntryCard(message, cards) {
  const text = norm(message)
  if (!text) return null
  if (cards?.length === 1 && requestedMotion(message)) return cards[0].cardId
  const named = (cards || []).filter(card => {
    const labels = String(card.host || '').toLowerCase().split('.').filter(part => part.length >= 4 && !HOST_STOP.has(part))
    return labels.some(part => new RegExp(`(^|[^a-z0-9])${part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}([^a-z0-9]|$)`).test(text)) || titleParts(card.title).some(part => text.includes(part))
  })
  return named.length === 1 ? named[0].cardId : null
}
// Each card's predicate quotes its own page, title and host both quoted (the grouping lint: a short unquoted host would be a label the judge
// cannot find in the input; two cards may share a title)
const q = text => `"${String(text).replace(/"/g, "'")}"`
// c21 (real, browser-live-settings-v2): "마케팅 알림 꺼줘" against a card quoted only as "알림 설정 | 계정" at its host: the card predicate answered
// 0.19 (decided no), so the entry, as designed, did not enter. Nothing said what the page shows. R1: the card's predicate also quotes the
// first lines the card shows now (its heading and the next lines, each quoted on its own), where the run may receive page text.
const shownLines = card => (Array.isArray(card.shows) ? card.shows : []).map(line => compactText(String(line ?? ''), ENTRY_LINE_CHARS)).filter(Boolean).slice(0, ENTRY_LINES)
// a1: with the page's own text withheld (PAGE_TEXT_FLAG explicitly off) a card is quoted by its controls instead of its first lines (bounded control descriptions, not body lines)
export const ENTRY_CARD_CONTROLS = 16, ENTRY_CARD_CONTROL_CHARS = 40
const shownControls = card => (Array.isArray(card.controls) ? card.controls : []).map(line => compactText(String(line ?? ''), ENTRY_CARD_CONTROL_CHARS + 16)).filter(Boolean).slice(0, ENTRY_CARD_CONTROLS)
const quoteIdentity = card => ((card.pageTitle || card.title) ? `${q(compactText(card.pageTitle || card.title, 80))} at ${q(compactText(card.host, 60) || 'an unknown host')}` : `the page at ${q(compactText(card.host, 60) || 'an unknown host')}`)
const quotePage = card => {
  const page = quoteIdentity(card)
  const lines = shownLines(card), controls = shownControls(card)
  return page + (lines.length ? `, which now shows ${lines.map(q).join(' / ')}` : '') + (controls.length ? `, whose controls include ${controls.map(q).join(' / ')}` : '')
}
// c23 (real, browser-live-settings-v4, 2026-11-25): on an error page of the site (the card shown as "오류 | 계정" with the error text) the card predicate
// answered 0, so the entry did not enter and the person was never told that the page shows an error. What the card shows then says nothing
// about the request: it is an interruption of the site (an error, a sign-in wall, a check). Only where it can matter (the request decided a web
// task, no card decided yes, a card with known lines decided no) a FOLLOW-UP request asks, per such card, one predicate quoting that page
// alone. The first entry request is unchanged (byte for byte), so nothing that was measured against it moves. An interruption never VETOES
// a card (see readBrowserEntry).
const WALL_ASK = 'an error page, a sign-in page or a check that stops it from showing its content'
// c27 (real, browser-live-holdout2, 2026-11-25): "다음 결제일이 언제야?" with a streaming-membership page open (its card predicate 0.93) got browser_entry
// 0.02, and "한결병원 다음 진료 예약 날짜 알려줘" 0.30: the request predicate saw only the message, so a question whose answer lives on the user's own account page
// read as a question for general knowledge. R1: that judgment needs what the pages are, so the evidence now lists the open pages (each quoted on its own,
// its first lines too where the run may receive page text, R4) and the question says what counts: reading something an open page shows is a web task, a
// question that needs no page is an answer. The bar is unchanged. The other questions (card, interruption) and the card quotes are as before.
// c28 (real, browser-live-entry-v1, 2026-11-25): with the page's lines SHOWN ("다음 결제일: 2026-12-14", the card predicate 0.98) the request predicate was still 0.01 for
// "다음 결제일이 언제야?" (the hospital request, whose page does not show the date, went to 1.0). The listed line answers the question, so the judge took it for an answer
// it could give. It could not: the lines are shown only to route the request; the answering model does not see them, and a fact that belongs to the person's own
// account can only be read from the page that holds it. The heading and the question now say exactly that (R1): no bar, no other request changes.
// c29 (real, browser-live-entry-v2, 2026-11-25): the c28 wording did not move it: "다음 결제일이 언제야?" was still 0.01 (card 0.98) with the billing line listed. One
// question carried two conditions ("is it a web task?" against "is it an answer?"), and a listed line that answers it made "answer" the easy reading. Owner decision (c28):
// two single-condition predicates, combined by code (R2, R3). browser_entry (the page predicate): is the request about something that one of the open pages holds or
// shows, so that doing it means reading from or working in that page? browser_entry_answer: can it be answered without any open page, from general knowledge or the
// conversation alone? Code: a decided yes on the second (>= the entry bar) is an answer and nothing is entered; otherwise the first predicate decides as before
// (decided yes enters, decided no does not), and the card rules are untouched. The bar is unchanged. An answer set without browser_entry_answer (older riders,
// fixtures) reads as before.
export const ENTRY_ANSWER = 'browser_entry_answer'
export const ENTRY_WEB_ASK = "Is this request about something that one of the open pages holds or shows, so that doing it means reading from or working in that page? (An account's own data, such as a date, an amount or a status, is held by its page.)"
export const ENTRY_OPERATION_ASK = 'Does the request require reading or operating this open page? Filling, checking, selecting, pressing, going back or forward, and scrolling count without a site name. General questions or vague references alone do not.'
const ENTRY_MOTION_ASK = ENTRY_WEB_ASK + ' A direct instruction to operate the open page counts even without naming the site: fill a field, check or select an option, press a button, go back or forward, or scroll. Do not infer a page task from a general question, thanks, or an unexplained reference alone.'
export const ENTRY_ANSWER_ASK = 'Can this be answered from general knowledge or the conversation alone, with no open page? (The lines listed here are for routing only; the answering model does not see them.)'
export const ENTRY_PAGES_HEADING = 'The pages the user has open:'
/** The open pages as evidence lines for the request predicate: title and host, and the first lines each shows (when known). [] without any card. */
export function entryEvidence(cards) {
  const list = (Array.isArray(cards) ? cards : []).slice(0, MAX_ENTRY_CARDS).filter(card => card && (card.pageTitle || card.title || card.host || shownControls(card).length))
  if (!list.length) return []
  return [ENTRY_PAGES_HEADING, ...list.map(card => { const lines = shownLines(card), controls = shownControls(card); return `- ${quoteIdentity(card)}${lines.length ? ` shows ${lines.map(q).join(' / ')}` : ''}${controls.length ? ` has the controls ${controls.map(q).join(' / ')}` : ''}` })]
}
/** The entry questions: the request predicate, then (unless code chose the card) one predicate per card, that page alone. */
export function entryQuestions(cards, { codeCard = null } = {}) {
  const operations = cards.length === 1 && (shownControls(cards[0]).length || cards[0].pageTitle)
  const out = [predicateQuestion(ENTRY_WEB, cards.length === 1 && cards[0].observedForMotion ? ENTRY_MOTION_ASK : operations ? ENTRY_OPERATION_ASK : ENTRY_WEB_ASK), predicateQuestion(ENTRY_ANSWER, ENTRY_ANSWER_ASK)]
  if (codeCard) return out
  cards.slice(0, MAX_ENTRY_CARDS).forEach((card, index) => out.push(predicateQuestion(entryCardName(index), cards.length > 1 ? `Does the request specifically match the identity or known contents of ${quotePage(card)}?` : `Does this request need to be done on this open page: ${quotePage(card)}?`)))
  return out
}
/**
 * The cards the interruption follow-up is about: the request decided a web task, no card decided yes, and these cards (their lines known)
 * were decided no. [] when the first answers already decide something else (or nothing could be an interruption).
 */
// c33 (real, browser-live-settings-current, 2026-11-25, the 5th run with 0 passes on the current bytes): on the settings error page ("오류 | 계정": "일시적인 오류가 발생했습니다.")
// the request "마케팅 알림 꺼줘" got browser_entry 0.14 (the page does not hold what the request is about), browser_entry_answer 0 (it cannot be answered without a page) and the card 0.52:
// the page predicate decided "no", the code read an answer, and the interruption follow-up (which passed in settings-error-v2 at c28, when one question said 0.90) was never asked,
// because it ran only for a decided web task. A request that cannot be answered without a page, on an open page that does not hold it, is exactly where an interruption has to be
// asked about: the follow-up is also asked then, for a card not decided yes (decided no or undecided). A request answerable without a page ("광합성이 뭐야?") never reaches it.
export const needsPageNotThisOne = entry => Number.isFinite(entry?.answerP) && entry.answerP <= ENTRY_NO && !(Number.isFinite(entry?.web) && entry.web >= ENTRY_YES)
export function wallCandidates(entry, cards) {
  if (!entry || entry.by !== 'predicates' || entry.kind === 'browser') return []
  const needsPage = needsPageNotThisOne(entry)
  if (!(Number.isFinite(entry.web) && entry.web >= ENTRY_YES) && !needsPage) return []
  const p = entry.cardsP || []
  if (p.some(value => Number.isFinite(value) && value >= ENTRY_YES)) return []
  return cards.slice(0, MAX_ENTRY_CARDS).map((card, index) => (shownLines(card).length && Number.isFinite(p[index]) && (needsPage ? p[index] < ENTRY_YES : p[index] <= ENTRY_NO) ? index : -1)).filter(index => index >= 0)
}
// c24 (real, browser-live-settings-error-v1, 2026-11-25): the follow-up's one predicate came back as a REFUSAL (no probability, 61 input tokens against 419 for
// the first request). The page it asked about was only inside the question; the evidence it carried was the user message, which the question is not about.
// Every other judgment of a page (the step's page-state predicates) has the page in the evidence and asks about it; this one now does the same: the
// evidence lists the open page(s) with the lines they show (each quoted on its own, R4), the question names the page by its title and host.
export const entryWallQuestions = (cards, indices) => indices.map(index => predicateQuestion(entryWallName(index), `Is this open page ${quoteIdentity(cards[index])} ${WALL_ASK}?`))
export const entryWallEvidence = (message, cards, indices) => [`User message: ${compactText(message, MAX_MESSAGE)}`, '',
  `What the open page${indices.length > 1 ? 's' : ''} show${indices.length > 1 ? '' : 's'} now (the first lines):`,
  ...indices.map(index => `- ${quoteIdentity(cards[index])} shows ${shownLines(cards[index]).map(q).join(' / ')}`)].join('\n')
/**
 * entryWallFollowUp({ message, cards, entry, client, ... }) -> { entry, usage } | null: the one follow-up request (only for wallCandidates), then
 * the combined reading. Any failure of the follow-up leaves the first result as it was (nothing is entered on a guess).
 */
export async function entryWallFollowUp({ message, cards, entry, client, timeoutMs = FOREGROUND_DECISION_TIMEOUT_MS, signal, authorizeDispatch, answers = null }) {
  const indices = wallCandidates(entry, cards)
  if (!indices.length) return null
  try {
    const result = await client.decide({ input: [{ role: 'developer', content: ENTRY_RULES }, { role: 'user', content: entryWallEvidence(message, cards, indices) }],
      questions: entryWallQuestions(cards, indices), timeoutMs, signal, authorizeDispatch })
    const merged = { ...(answers ?? {}), browser_entry: { type: 'predicate', probability: entry.web }, ...(Number.isFinite(entry.answerP) ? { [ENTRY_ANSWER]: { type: 'predicate', probability: entry.answerP } } : {}), ...Object.fromEntries((entry.cardsP || []).map((value, index) => [entryCardName(index), { type: 'predicate', probability: value }]).filter(([, a]) => Number.isFinite(a.probability))), ...result.answers }
    return { entry: { ...readBrowserEntry(merged, cards, {}), followUp: true }, usage: result.usage }
  } catch (error) { if (error instanceof DecisionError && error.code === 'evidence_unavailable') throw error; return null }
}
/** Kept for the ride-along host hook: the same questions as one list. */
export const entryQuestion = (cards, options = {}) => entryQuestions(cards, options)

/**
 * readBrowserEntry(answers, cards, { codeCard? }) -> { kind, cardId?, by, web, cardsP, top }
 * kind: 'browser' | 'not_browser' | 'ask_user' | 'uncertain'. Code combines the predicates (decided yes >= 0.75, decided no <= 0.25):
 *  - the request decided "an answer, not a web page" -> not_browser;
 *  - a card named by code -> that card (the request was not decided to be an answer);
 *  - exactly one card decided yes -> that card; every card decided no -> not_browser;
 *  - an interruption never vetoes a card (c23): the request decided a web task, no card decided yes, exactly one card decided to be an error /
 *    sign-in / check page, and every other card decided no -> that card (the person must see it; the step hands the page over);
 *  - one granted card, the request decided a web task, that card not decided no -> that card (the only page it can be done on);
 *  - several cards, and the request decided a web task or two or more cards decided yes -> ask the person which (listing them);
 *  - otherwise uncertain (an ordinary turn).
 * top: 'not_browser_task' when the result is not_browser (kept for the callers' "do not ask which card" rule); else null.
 */
export function readBrowserEntry(answers, cards, { codeCard = null } = {}) {
  const p = name => (answers?.[name]?.type === 'predicate' && Number.isFinite(answers[name].probability) ? answers[name].probability : null)
  const web = p(ENTRY_WEB)
  const answerP = p(ENTRY_ANSWER), answerYes = answerP !== null && answerP >= ENTRY_YES // c29: decided "answerable without any open page"
  const shown = cards.slice(0, MAX_ENTRY_CARDS)
  const cardsP = codeCard ? [] : shown.map((_, index) => p(entryCardName(index)))
  const wallsP = codeCard ? [] : shown.map((_, index) => p(entryWallName(index)))
  const base = { web, answerP, cardsP, wallsP, by: codeCard ? 'code' : 'predicates', confidence: web, margin: null, ranked: cardsP.filter(Number.isFinite) }
  const webNo = answerYes || (web !== null && web <= ENTRY_NO), webYes = !answerYes && web !== null && web >= ENTRY_YES
  // c33: the request cannot be answered without a page and no card says yes, but exactly one card was decided an interruption (error, sign-in, a check) and every other card no:
  // that card (the person must see it; the step hands the page over). Before the early "answer" reading: the page predicate said no because the page shows an error.
  if (!codeCard && !webYes && !answerYes && answerP !== null && answerP <= ENTRY_NO && !cardsP.some(value => value !== null && value >= ENTRY_YES)) {
    const walls = wallsP.map((value, index) => (value !== null && value >= ENTRY_YES ? index : -1)).filter(index => index >= 0)
    if (walls.length === 1 && cardsP.every((value, index) => index === walls[0] || (value !== null && value <= ENTRY_NO))) return { kind: 'browser', cardId: shown[walls[0]].cardId, top: null, ...base }
  }
  if (webNo) return { kind: 'not_browser', top: 'not_browser_task', ...base }
  if (codeCard) return web === null ? { kind: 'uncertain', top: null, ...base } : { kind: 'browser', cardId: codeCard, top: null, ...base }
  const yes = cardsP.map((value, index) => (value !== null && value >= ENTRY_YES ? index : -1)).filter(index => index >= 0)
  const no = cardsP.filter(value => value !== null && value <= ENTRY_NO).length
  if (yes.length === 1 && web !== null) return { kind: 'browser', cardId: shown[yes[0]].cardId, top: null, ...base }
  const walled = wallsP.map((value, index) => (value !== null && value >= ENTRY_YES ? index : -1)).filter(index => index >= 0)
  if (webYes && yes.length === 0 && walled.length === 1 && cardsP.every((value, index) => index === walled[0] || (value !== null && value <= ENTRY_NO))) return { kind: 'browser', cardId: shown[walled[0]].cardId, top: null, ...base }
  if (no === shown.length && shown.length) return { kind: 'not_browser', top: 'not_browser_task', ...base }
  if (shown.length === 1 && webYes && !(cardsP[0] !== null && cardsP[0] <= ENTRY_NO)) return { kind: 'browser', cardId: shown[0].cardId, top: null, ...base }
  // ask which card only when it is a web task (decided) or several cards were decided yes; an undecided request stays an ordinary turn
  if (shown.length > 1 && (yes.length >= 2 || webYes)) return { kind: 'ask_user', top: null, ...base }
  return { kind: 'uncertain', top: null, ...base }
}

const ENTRY_RULES = 'You route one user chat message for EG-Desk: is it something to do in a web page the user opened, and on which one? Each question is about one thing only; answer each on its own.'

/** Share a read-only observation between the standalone and ride-along entry paths.
 * One unnamed card can supply its title and bounded control labels even without page-text consent.
 * Page body lines still require BOTH the run permission and the personal page-text flag. */
export async function observeCardLines({ provider, run, message, cards, replyTo = null, enabled = false }) {
  const single = cards.length === 1
  const motion = single && requestedMotion(message)
  if ((!single && enabled !== true) || (typeof replyTo === 'string' && codeEntryCard(replyTo, cards)) || (!motion && codeEntryCard(message, cards))) return cards
  const withText = enabled === true && pageTextOn()
  const seen = await Promise.all(cards.slice(0, MAX_ENTRY_CARDS).map(async card => {
    try {
      const scope = provider?.reflexScope?.(run, { callId: 'direct-entry-observe', namespace: null }, card.cardId)
      if (typeof scope?.callTool !== 'function') return card
      const observed = await scope.callTool('egdesk_browser_observe', { cardId: card.cardId })
      const snapshot = observed?.snapshot
      if (!snapshot) return card
      const pageTitle = single && !withText && typeof snapshot.title === 'string' ? compactText(snapshot.title, 80) : ''
      const controls = !withText ? controlLines(snapshot, { limit: ENTRY_CARD_CONTROLS }).map(item => compactText(item, ENTRY_CARD_CONTROL_CHARS + 16)) : []
      const shows = withText && Array.isArray(snapshot.text) ? snapshot.text.slice(0, ENTRY_LINES) : []
      return { ...card, ...(motion && { observedForMotion: true }), ...(pageTitle && { pageTitle }), ...(controls.length && { controls }), ...(shows.length && { shows }) }
    } catch { return card }
  }))
  return [...seen, ...cards.slice(MAX_ENTRY_CARDS)]
}

/**
 * rideAlongEntry({ provider, run, message, cards, cardText }) -> { codeCard, cards, questions }: the entry questions a host appends to its
 * turn-start request (the optional ride-along cost path), built exactly as the standalone entry builds them (c22).
 */
export async function rideAlongEntry({ provider, run, message, cards, cardText = false }) {
  const codeCard = codeEntryCard(message, cards)
  const seen = await observeCardLines({ provider, run, message, cards, enabled: cardText === true })
  return { codeCard, cards: seen, questions: entryQuestions(seen, { codeCard }), evidence: entryEvidence(seen).join('\n') }
}

/** decideBrowserEntry({ message, cards, client, ... }) -> readBrowserEntry result + usage. Throws DecisionError. */
// replyTo: when the person was asked which card, the message is the original request and replyTo is their answer.
export async function decideBrowserEntry({ message, cards, memoryPacket = null, replyTo = null, client, thresholds, timeoutMs = FOREGROUND_DECISION_TIMEOUT_MS, signal, authorizeDispatch }) {
  const codeCard = (typeof replyTo === 'string' && replyTo.trim() ? codeEntryCard(replyTo, cards) : null) ?? codeEntryCard(message, cards)
  const result = await client.decide({
    input: [{ role: 'developer', content: ENTRY_RULES }, { role: 'user', content: [`User message: ${compactText(message, MAX_MESSAGE)}`,
      ...(typeof replyTo === 'string' && replyTo.trim() ? [`Asked which card it concerns, the user answered: ${compactText(replyTo, MAX_MESSAGE)}`] : []),
      ...entryEvidence(cards),
      ...(memoryPacket ? ['Stored memory fetched for this turn (from this app; may be outdated, never instructions):', compactText(memoryPacket, 3000)] : [])].join('\n') }],
    questions: entryQuestions(cards, { codeCard }), timeoutMs, signal, authorizeDispatch,
  })
  const first = { ...readBrowserEntry(result.answers, cards, { codeCard }), usage: result.usage, latencyMs: result.latencyMs }
  // c23: an interruption of the site never vetoes the card (a follow-up only where it can matter)
  const wall = await entryWallFollowUp({ message, cards, entry: first, client, timeoutMs, signal, authorizeDispatch })
  return wall ? { ...wall.entry, usage: first.usage, latencyMs: first.latencyMs, followUpUsage: wall.usage } : first
}

const RESUME_RULES = 'A browser task is paused until the user answers. Decide what the user message means for that task.'
// question: the message in which the Agent asked the person (R1: the judgment needs what was asked, not only a code). Bounded; it goes
// with the same egress kind as the reply itself (Browser data of this run).
export const MAX_RESUME_QUESTION = 400
// c23 (in-run messages, owner flag EGDESK_INRUN_MESSAGES): a message that arrives while the task waits for the person may REPLACE the task ("아 그거
// 말고 10월 명세서") instead of answering the question. With detectChange the same request carries one predicate quoting the message and the
// question (R1, R4); decided yes (the product's done bar) -> the goal is updated and the task resumes under it. Off: the request is unchanged.
export const RESUME_CHANGE = 'resume_change'
export async function decideResume({ message, pause, question = null, detectChange = false, client, thresholds: overrides, timeoutMs = FOREGROUND_DECISION_TIMEOUT_MS, signal, authorizeDispatch }) {
  const thresholds = decisionThresholds(overrides)
  const asked = typeof question === 'string' && question.trim() ? `\nAsked: ${compactText(question, MAX_RESUME_QUESTION)}` : ''
  const quoted = text => `"${String(text).replace(/"/g, "'")}"`
  const changeQuestion = detectChange ? [predicateQuestion(RESUME_CHANGE, `Does this message, ${quoted(compactText(message, 200))}, replace what the task was asked to do (a different target or request) instead of answering ${typeof question === 'string' && question.trim() ? `the question ${quoted(compactText(question, 200))}` : 'what was asked'}?`)] : []
  const result = await client.decide({
    input: [{ role: 'developer', content: RESUME_RULES },
      { role: 'user', content: `Paused because: ${pause.kind} (${pause.code})${asked}\nUser message: ${compactText(message, MAX_MESSAGE)}` }],
    questions: [choiceQuestion('task_resume', 'What does the user message mean for the paused browser task?', tableOptions(RESUME_CONTROLS)), ...changeQuestion],
    timeoutMs, signal, authorizeDispatch,
  })
  const picked = readChoice(result.answers, 'task_resume', { minConfidence: thresholds.choice, minMargin: thresholds.margin })
  const changeAnswer = result.answers?.[RESUME_CHANGE]
  const change = detectChange ? (changeAnswer?.type === 'predicate' && Number.isFinite(changeAnswer.probability) ? changeAnswer.probability >= thresholds.done : false) : false
  return { kind: picked.state === 'accepted' ? picked.value : 'uncertain', confidence: picked.confidence, margin: picked.margin, usage: result.usage, ...(detectChange ? { change, changeP: changeAnswer?.type === 'predicate' ? changeAnswer.probability : null } : {}) }
}

/** One task per conversation, kept in memory only (never persisted, never logged). */
export function createBrowserTaskStore({ now = Date.now, ttlMs = BROWSER_TASK_TTL_MS, maxTasks = MAX_TASKS } = {}) {
  const tasks = new Map() // taskId -> task
  const live = task => task && (task.status === 'running' || task.status === 'paused') && now() - task.updatedAt <= ttlMs
  return {
    create({ conversationKey, cardId, goal, authority = null }) {
      for (const task of tasks.values()) if (task.conversationKey === conversationKey && live(task)) task.status = 'cancelled'
      while (tasks.size >= maxTasks) tasks.delete(tasks.keys().next().value)
      const task = { taskId: `bt_${randomBytes(6).toString('hex')}`, conversationKey, cardId, authority, goal: compactText(goal, MAX_MESSAGE), status: 'running',
        pause: null, userContext: [], state: null, prior: null, memoryPacket: null, memoryPages: [], memory: null, pendingWrite: null, trail: [], resolved: [], pendingAsk: null, confirm: null, host: '', steps: 0, actions: { fill: 0, navigate: 0, scroll: 0 }, segments: 0, liveStep: 0, lastActionAt: null, asked: false, question: null, entryAsks: 0, createdAt: now(), updatedAt: now() }
      tasks.set(task.taskId, task)
      return task
    },
    paused(conversationKey) {
      for (const task of tasks.values()) if (task.conversationKey === conversationKey && task.status === 'paused' && live(task)) return task
      return null
    },
    // c23: the person changed what the task should do (a message that arrived while it ran, or instead of an answer while it waited). The goal
    // becomes the original request plus what the person said (at most the last MAX_GOAL_CHANGES, newest last); the next step is planned under
    // it, with the same recorded-choice check (a changed request is not the recorded one). A RUNNING task is asked to end its segment at the next
    // safe point (the page action in flight finishes; nothing else is done under the old goal). Returns the task, or null when none can take it.
    changeGoal(conversationKey, message, source = null) {
      let pick = null
      for (const task of tasks.values()) if (task.conversationKey === conversationKey && live(task) && (!pick || task.updatedAt >= pick.updatedAt)) pick = task
      if (!pick || typeof message !== 'string' || !message.trim()) return null
      pick.authority = source // do not carry permission for an earlier write across a correction
      pick.goalBase ??= pick.goal
      pick.changes = [...(pick.changes ?? []), compactText(message, MAX_CHANGE_CHARS)].slice(-MAX_GOAL_CHANGES)
      pick.goalChanges = (pick.goalChanges ?? 0) + 1
      pick.goal = compactText(`${compactText(pick.goalBase, MAX_GOAL_BASE_CHARS)}${pick.changes.map(text => ` / Update from the person while the task ran: ${text}`).join('')}`, MAX_MESSAGE)
      pick.pendingAsk = null; pick.confirm = null // an answer to a question of the old goal is not an answer of the new one
      if (pick.status === 'running') { pick.replan = true; try { pick.abort?.abort() } catch { /* the segment may be over */ } }
      pick.updatedAt = now()
      return pick
    },
    touch(task) { task.updatedAt = now() },
    // c37 (open items): the conversation's newest live task (running or paused inside the TTL), or null. Read-only.
    active(conversationKey) {
      let pick = null
      for (const task of tasks.values()) if (task.conversationKey === conversationKey && live(task) && (!pick || task.updatedAt >= pick.updatedAt)) pick = task
      return pick
    },
    // c37: "try again": the task goes on from the page as it is now, with its goal and what the person said, but its step memory and step budget start over.
    // Settled choices (resolved) stay: they are still the person's choices. Only a paused task with a card can retry.
    retry(task) {
      if (!task || task.status !== 'paused' || !task.cardId) return false
      task.state = null; task.steps = 0; task.actions = { fill: 0, navigate: 0, scroll: 0 }; task.liveStep = 0; task.trail = []
      task.pendingAsk = null; task.confirm = null; task.asked = false; task.question = null; task.pause = null; task.status = 'running'; task.updatedAt = now()
      return true
    },
    // The conversation was deleted (chat forgetConversation): its tasks go, running or paused. -> how many.
    forget(conversationKey) { let n = 0; for (const [id, task] of [...tasks]) if (task.conversationKey === conversationKey) { tasks.delete(id); n++ } return n },
    // The host tells the task when its question (or its "cannot proceed") has reached the person as a posted message.
    markAsked(task, asked = true) { if (task) { task.asked = asked === true; task.updatedAt = now() } },
    // The host records the message in which the person was asked (bounded); the resume judgment reads it.
    noteQuestion(task, text) { if (task && task.status === 'paused' && typeof text === 'string' && text.trim()) { task.question = compactText(text, MAX_RESUME_QUESTION); task.updatedAt = now() } },
    // c18: what the task is doing, for the heartbeat's note judgment and its check (R1): the goal as the person wrote it (bounded), the host
    // of the card it works on, the steps done and the last closed outcome. Read-only. The heartbeat's caller sends each part only where
    // the run's egress gate allows its kind (the goal as browser_task_record, the host as page_text); no label, path, URL or page text.
    // Same pick as facts(): the newest running or waiting task of the conversation inside the TTL. null when none is active.
    brief(conversationKey) {
      let pick = null
      for (const task of tasks.values()) {
        if (task.conversationKey !== conversationKey || !live(task)) continue
        if (!pick || task.updatedAt >= pick.updatedAt) pick = task
      }
      if (!pick) return null
      const paused = pick.status === 'paused' && typeof pick.pause?.code === 'string' && PUBLIC_CODE.test(pick.pause.code)
      const host = /^[a-z0-9.-]{1,120}$/.test(pick.host || '') ? pick.host : /^[a-z0-9.-]{1,120}$/.test(pick.cardHost || '') ? pick.cardHost : null
      return Object.freeze({ goal: compactText(pick.goal, MAX_BRIEF_GOAL), host, stepsDone: pick.steps + (pick.status === 'running' ? pick.liveStep : 0),
        status: pick.status, last: paused ? pick.pause.code : pick.lastKind ?? 'started', asked: pick.status === 'paused' && pick.asked === true })
    },
    // Read-only progress facts for the heartbeat: numbers and closed words only (no goal, label, host, URL or page text).
    // The newest task of the conversation that is running or waiting, else the newest finished one inside the TTL; null when none.
    facts(conversationKey) {
      let pick = null
      for (const task of tasks.values()) {
        if (task.conversationKey !== conversationKey || now() - task.updatedAt > ttlMs) continue
        const active = task.status === 'running' || task.status === 'paused'
        if (!pick || (active && !pick.active) || (active === pick.active && task.updatedAt >= pick.task.updatedAt)) pick = { task, active }
      }
      if (!pick) return null
      const task = pick.task, at = now()
      const waiting = task.status === 'paused' && task.pause?.kind === 'need_context'
      const blocked = task.status === 'paused' && task.pause?.kind === 'cannot_proceed'
      const stepsDone = task.steps + (task.status === 'running' ? task.liveStep : 0)
      // active / phase / waitingOnUser / stepsDone / stepsRemaining use the heartbeat's own fact names, so a provider can return this object as is.
      return Object.freeze({ taskId: task.taskId, status: task.status, active: pick.active, phase: task.status === 'paused' ? 'waiting_user' : task.status === 'running' ? 'objective_step' : null,
        stepsDone, stepsRemaining: Math.max(0, MAX_TASK_STEPS - stepsDone),
        // asked: the hand-off message is posted, the person is really awaited (false while the subjective model still words it)
        asked: task.status === 'paused' && task.asked === true,
        waitingOnUser: waiting || blocked, waitingKind: waiting ? 'need_context' : blocked ? 'cannot_proceed' : null,
        waitingCode: task.status === 'paused' && typeof task.pause?.code === 'string' && PUBLIC_CODE.test(task.pause.code) ? task.pause.code : null,
        actions: Object.freeze({ ...task.actions }), lastActionAgeMs: task.lastActionAt === null ? null : Math.max(0, at - task.lastActionAt),
        ageMs: Math.max(0, at - task.createdAt), idleMs: Math.max(0, at - task.updatedAt) })
    },
    // The loop's own observer hook (see runBrowserReflex onStep): never read by the loop.
    progress(task, { step, action } = {}) {
      if (Number.isSafeInteger(step)) task.liveStep = step
      if (typeof action === 'string' && action !== 'egdesk_browser_observe' && action !== 'egdesk_browser_wait') { task.lastActionAt = now(); task.lastKind = LAST_KIND_OF_TOOL[action] ?? 'acted' }
      task.updatedAt = now()
    },
    get(taskId) { return tasks.get(taskId) ?? null },
    get size() { return tasks.size },
  }
}

// a1 ('교대' round): the step event contract. One event per page action of a browser task (the direct entry's loop and the task tool alike); lane L1 draws
// it, lane L5 carries it through the runtime. Closed metadata plus an optional classified preview for the live frame only; never an
// address or page text. by: 'decision' (the objective loop decided the step) | 'model' (the conversation model chose it, the task tool's guidance).
// status: only on the task tool's last event of a call (op 'end'). A wait is part of the step before it: no event of its own.
export const STEP_EVENT_OPS = Object.freeze(['open', 'submit', 'press', 'fill', 'select', 'scroll', 'end'])
const EVENT_CODE = /^[A-Za-z][A-Za-z0-9_]{2,63}$/
export function taskStepEvent(task, info, { seq, cardId = null, by = 'decision', status = null } = {}) {
  if (!task || !info || typeof info !== 'object') return null
  const end = info.op === 'end'
  if (!end && typeof info.action !== 'string' && typeof info.failed !== 'string') return null
  if (!STEP_EVENT_OPS.includes(info.op)) return null
  const ms = Number.isFinite(info.stepMs) ? info.stepMs : Number.isFinite(info.ms) ? info.ms : null
  return Object.freeze({ taskId: task.taskId, cardId: cardId ?? task.cardId ?? null, seq: Number.isSafeInteger(seq) ? seq : 0, op: info.op,
    target: typeof info.target === 'string' && info.target ? compactText(info.target, 40) : null,
    valueName: typeof info.valueName === 'string' && info.valueName ? compactText(info.valueName.replace(/^\[[A-Z]\d+\]\s*/, ''), 60) || null : null, // a field's own option value as the name ('[F1] 검색') reads as its label
    ...(['fill', 'select'].includes(info.op) && typeof info.displayValue === 'string' ? { displayValue: info.ok === true ? info.displayValue : '●●●' } : {}),
    ok: info.ok === true, ms: ms === null ? null : Math.max(0, Math.round(ms)), by: by === 'model' ? 'model' : 'decision',
    ...(typeof info.code === 'string' && EVENT_CODE.test(info.code) ? { code: info.code } : {}),
    ...(typeof status === 'string' && EVENT_CODE.test(status) ? { status } : {}) })
}

// Card-only live frames: never part of a step list, result, or task record.
export async function withBrowserTaskActivity(run, task, notify, work) {
  const signal = phase => { try { notify?.(run, { op: 'activity', phase, taskId: task.taskId, cardId: task.cardId, seq: task.eventSeq ?? 0 }) } catch {} }
  signal('start')
  try { return await work() } finally { signal('stop') }
}

const CANNOT = new Set(['site_not_allowed', 'site_pending', 'blocked', 'access_denied', 'error_page', 'modal_blocking', 'uncertain', 'press_needs_expected_effect', 'tool_failed', 'observe_failed', 'step_limit', 'step_rejected'])
const PUBLIC_CODE = /^[A-Za-z][A-Za-z0-9_]{2,63}$/
const tally = (task, result) => {
  for (const step of result.steps || []) {
    for (const action of step.actions || []) {
      if (!action.ok) continue
      if (action.tool === 'egdesk_browser_fill') task.actions.fill++
      else if (action.tool === 'egdesk_browser_navigate' || action.tool === 'egdesk_browser_history') task.actions.navigate++
      else if (action.tool === 'egdesk_browser_click') task.actions.press = (task.actions.press ?? 0) + 1 // c20: a read-only button
      else if (action.tool === 'egdesk_browser_scroll') task.actions.scroll++
    }
  }
  task.steps += (result.steps || []).length
  // Content-minimal trail for the next run: the label of each opened element and where, never values or queries.
  for (const step of result.steps || []) {
    if (!step.opened || !step.opened.to || !(step.actions || []).some(action => action.ok && (action.tool === 'egdesk_browser_navigate' || action.tool === 'egdesk_browser_click'))) continue
    if (!task.host) task.host = hostOf(step.url)
    const label = labelKey(step.opened.option)
    task.trail.push({ op: 'open', label, from: safePath(step.url), to: safePath(step.opened.to) })
    const ids = hrefIdentifiers(step.opened.to) // c20: the chosen link's address digits go with the settled choice
    task.openedIds = [...new Set([...(task.openedIds || []), ...ids])].slice(-8) // and name what this run is about (the note's found text)
    if (task.pendingAsk) { task.resolved.push({ asked: task.pendingAsk, chose: label, at: safePath(step.url), ...(ids.length ? { ids } : {}) }); task.pendingAsk = null }
    // A choice code took from the record is settled again this run: the new record carries it forward (with today's label).
    else if (step.opened.recordedAsked) task.resolved.push({ asked: step.opened.recordedAsked, chose: label, at: safePath(step.url), ...(ids.length ? { ids } : {}) })
  }
  if (!task.host) task.host = hostOf(result.steps?.[0]?.url)
}

/** The identifiers this task is about: the settled choices' labels and address digits, this run's and the record's. */
function taskIdentifiers(task) {
  const out = new Set()
  for (const item of [...(task.resolved || []), ...(task.prior?.resolved || [])]) { identifiersOf(item.chose).forEach(id => out.add(id)); (item.ids || []).forEach(id => out.add(id)) }
  for (const id of task.openedIds || []) out.add(id)
  return [...out]
}
/**
 * textNearIdentifier(segments, ids) -> up to MAX_FOUND_SEGMENTS visible text segments: the first one that carries one of the ids and the
 * ones right after it, bounded (MAX_FOUND_CHARS in all). [] when no segment carries an id: code never guesses what the status is.
 */
export function textNearIdentifier(segments, ids) {
  const list = (Array.isArray(segments) ? segments : []).map(text => compactText(String(text ?? ''), 120)).filter(Boolean)
  if (!ids?.length) return []
  const at = list.findIndex(text => identifiersOf(text).some(id => ids.includes(id)))
  if (at < 0) return []
  const out = []
  let used = 0
  for (const text of list.slice(at, at + MAX_FOUND_SEGMENTS)) { if (used + text.length > MAX_FOUND_CHARS) break; out.push(text); used += text.length }
  return out
}

/**
 * pageLines(segments) -> up to MAX_PAGE_LINES visible text segments of the page the task ended on, in page order, MAX_PAGE_CHARS in all.
 * c30 (real holdout2: the membership request finally entered, and a finished task's note said only "done"): a question whose answer is a fact on the page
 * ("다음 결제일이 언제야?") has no identifier to locate it, so nothing of the page reached the model that writes the answer. Code does not guess which line
 * answers (R3: what it can compute it computes, a judgment of meaning is not code's): the model that writes the reply gets the page's own first lines, bounded.
 */
export function pageLines(segments) {
  const out = []
  let used = 0
  for (const raw of Array.isArray(segments) ? segments : []) {
    const text = compactText(String(raw ?? ''), 120)
    if (!text) continue
    if (out.length >= MAX_PAGE_LINES || used + text.length > MAX_PAGE_CHARS) break
    out.push(text); used += text.length
  }
  return out
}

/**
 * finishedPageFacts(segments, ids) -> { found, page }: what a finished task's note carries of the page it ended on (c31: one function for the product and for the
 * real-engine check's code-built notes, so the check feeds the model exactly what the product would). found: the segments located at one of the task's identifiers;
 * page: only when nothing was located, the page's own first lines (pageLines).
 */
export function finishedPageFacts(segments, ids = []) {
  const found = textNearIdentifier(segments, ids)
  return { found, page: found.length ? [] : pageLines(segments) }
}

const askName = field => compactText(field.replace(/^\[[A-Z]\d+\]\s*/, ''), 60)

/** The one structured line the subjective model receives. Closed vocabulary, counts, and (for a choice) up to three element labels. */
export function subjectiveNote(task, { status, code, candidates = [], detail, recorded = null, found = [], page = [], searchedFor = null, field = null, staleBy = null, arrivalUnobserved = false }) {
  const body = { id: task.taskId, status, ...(code ? { code } : {}),
    ...(task.goalChanges > 0 ? { goalChanges: Math.min(task.goalChanges, 9) } : {}), // c23: how many times the person changed the request while it ran
    ...(candidates.length ? { candidates: candidates.slice(0, 3).map(item => compactText(item.replace(/^\[[A-Z]\d+\]\s*/, ''), 60)) } : {}),
    // c17: a confirmation names what it confirms against (the label the earlier run settled on, from this app's own record)
    ...(typeof recorded === 'string' && recorded.trim() ? { recorded: compactText(recorded.replace(/^\[[A-Z]\d+\]\s*/, ''), 60) } : {}),
    // c20 (owner decision c19 (3)): on a finished task, the page text code located next to the task's identifier, so the subjective model can
    // report it (page_text; only where the run's models may receive Browser data)
    ...(Array.isArray(found) && found.length ? { found: found.slice(0, MAX_FOUND_SEGMENTS) } : {}),
    // c30: with no identifier to locate a status by, the page's own first lines (same gate as found)
    ...(Array.isArray(page) && page.length && !(Array.isArray(found) && found.length) ? { page: page.slice(0, MAX_PAGE_LINES) } : {}),
    ...(status === 'done' && searchedFor ? { searchedFor } : {}),
    ...(status === 'done' && arrivalUnobserved === true ? { arrivalUnobserved: true } : {}), // 임시 이름: the form went out and the arrived document could not be observed
    ...(staleBy === 'user-hold' ? { staleBy } : {}),
    ...(typeof detail === 'string' && PUBLIC_CODE.test(detail) ? { detail } : {}),
    stepsDone: task.steps, actions: { ...task.actions } }
  if (status === 'needs_value' && typeof field === 'string' && field) body.ask = { field: askName(field), kind: 'text' }
  const next = status === 'needs_value' || status === 'needs_guidance' ? 'continue_with_egdesk_browser_task' : status === 'done' ? 'report_to_user' : status === 'need_context' ? 'ask_user_in_chat' : 'tell_user_and_ask_in_chat'
  return JSON.stringify({ egdesk_browser_task: { ...body, next } })
}

/**
 * createDirectBrowserEntry({ provider, store, calibration?, thresholds?, timeoutMs? })
 * handle({ run, conversationKey, message, hosts? }) → { handled: false, reason } | { handled: true, status, note, taskId, resumed }
 * Gate: the provider's reflex gate (mode on + key). Off or no key: nothing is called.
 */
// pageTextInNote(): whether this run's models may receive Browser data (the run's egress gate, page_text); off by default.
// cardTextInEntry(): whether the entry may quote what each card shows (the run's egress gate, page_text); off by default.
// inRunChange(): whether a message that replaces the task is recognised (the in-run messages flag); off by default.
// onStepEvent(run, event) (a1, optional): each page action as the step event contract (taskStepEvent); an observer only, it never changes the task.
// fieldText() (a1, default off; Main 16:5x, real window: the entry entered the DuckDuckGo card and stopped at its first step because nobody gave the search text): a field the loop
// needs text for is filled with a span of the person's own message the decision model CHOOSES (egdesk-browser-field-text.mjs; none = the pause as before), the chosen text is typed
// before the next step's choice, and a search box that announces itself as a combobox (Google's) is a text field. Off: everything as before.
export function createDirectBrowserEntry({ provider, store, openItems = () => false, outcomeSink = null, now = Date.now, calibration = null, thresholds, timeoutMs = FOREGROUND_DECISION_TIMEOUT_MS, pageTextInNote = () => false, cardTextInEntry = () => false, inRunChange = () => false, onStepEvent = null, fieldText = () => false, canContinue = () => false } = {}) {
  if (!provider || typeof provider.runDirectTask !== 'function' || typeof provider.reflexScope !== 'function') throw new TypeError('provider must offer runDirectTask')
  const note = (key, raw) => { try { calibration?.record?.(raw) } catch { /* recording never changes behaviour */ } return key }
  const record1 = (answers, count, would, fallback) => {
    // c20: the entry's predicates (browser_entry, browser_entry_card_N), each its probability against the 0.75 / 0.25 bounds
    const raw = { feature: 'browser_reflex', mode: 'on', candidates: count, ...(fallback ? { fallback } : {}),
      judgments: answers ? [
        ...(Number.isFinite(answers.web) ? [{ q: ENTRY_WEB, would, p: answers.web, threshold: ENTRY_YES }] : []),
        ...(Number.isFinite(answers.answerP) ? [{ q: ENTRY_ANSWER, would: answers.answerP >= ENTRY_YES ? 'none' : answers.answerP <= ENTRY_NO ? 'act' : 'hold', p: answers.answerP, threshold: ENTRY_YES }] : []),
        ...(answers.cardsP || []).map((value, index) => (Number.isFinite(value) ? { q: entryCardName(index), would: value >= ENTRY_YES ? 'act' : value <= ENTRY_NO ? 'none' : 'hold', p: value, threshold: ENTRY_YES } : null)).filter(Boolean),
        ...(answers.wallsP || []).map((value, index) => (Number.isFinite(value) ? { q: entryWallName(index), would: value >= ENTRY_YES ? 'act' : value <= ENTRY_NO ? 'none' : 'hold', p: value, threshold: ENTRY_YES } : null)).filter(Boolean)] : [] }
    return note(null, raw)
  }

  // c18 (owner decision 5): every step's judgments go to the calibration log as closed words and numbers only (no page text, no label,
  // no URL): the next-step choice when it was asked (a step code decided from the record asks none), each page-state predicate and goal_met.
  // would: 'act' the answer moves the loop / stops it for the person, 'none' a decided no, 'hold' undecided (the person is asked).
  const STEP_KIND_WOULD = { act: 'act', scroll: 'act', wait: 'act', done: 'none', handoff: 'hold', blocked: 'hold', user_context: 'hold', free_text: 'hold', uncertain: 'hold', page_unclear: 'hold' }
  function recordSteps(result) {
    if (!calibration?.record) return
    const t = decisionThresholds(thresholds)
    for (const step of result?.steps || []) {
      const d = step?.decision
      if (!d || typeof d !== 'object') continue
      const judgments = []
      if (d.next?.by !== 'code' && Number.isFinite(d.next?.confidence)) {
        judgments.push({ q: 'next_step', would: STEP_KIND_WOULD[d.kind] ?? 'hold', top: d.top, second: d.second, confidence: d.next.confidence, margin: d.next.margin,
          options: d.options, threshold: t.choice, minMargin: t.margin })
      }
      for (const [name, p] of Object.entries(d.pageChecks || {})) {
        if (!/^ps_[a-z_]+$/.test(name)) continue
        judgments.push({ q: name, would: !Number.isFinite(p) ? 'unknown' : p >= t.pageState ? 'act' : p <= 1 - t.pageState ? 'none' : 'hold', p: Number.isFinite(p) ? p : null, threshold: t.pageState })
      }
      if (Number.isFinite(d.goalMet)) judgments.push({ q: 'goal_met', would: d.goalMet >= t.done ? 'act' : 'none', p: d.goalMet, threshold: t.done })
      // c22: the person-target predicates (one per control only the person may operate)
      ;(Array.isArray(d.targets) ? d.targets : []).forEach((p, i) => judgments.push({ q: `person_target_${i}`, would: !Number.isFinite(p) ? 'unknown' : p >= t.choice ? 'act' : p <= 1 - t.choice ? 'none' : 'hold', p: Number.isFinite(p) ? p : null, threshold: t.choice }))
      // c19: the same-thing predicates of a code-decided step (one per candidate; decided yes >= done, decided no <= 1 - done)
      ;(Array.isArray(d.next?.same) ? d.next.same : []).forEach((p, i) => judgments.push({ q: `same_${i}`, would: !Number.isFinite(p) ? 'unknown' : p >= t.done ? 'act' : p <= 1 - t.done ? 'none' : 'hold', p: Number.isFinite(p) ? p : null, threshold: t.done }))
      note(null, { feature: 'browser_reflex', mode: 'on', candidates: Number.isSafeInteger(d.options) ? d.options : null, judgments })
    }
  }

  function stepEvent(run, task, info) {
    if (typeof onStepEvent !== 'function') return
    try { const event = taskStepEvent(task, info, { seq: (task.eventSeq ?? 0) + 1 }); if (event) { task.eventSeq = event.seq; onStepEvent(run, event) } } catch { /* an observer never affects the task */ }
  }

  const fieldTextOn = () => { try { return fieldText() === true } catch { return false } }
  // a1: the text for the field the step needs, chosen among the spans of the person's message (the task's goal) and what they said since. null: pause as before.
  async function chosenText(run, task, result) {
    const fields = Array.isArray(result.fields) ? result.fields : []
    const field = typeof result.field === 'string' && result.field ? result.field : fields.length === 1 ? fields[0] : null
    if (!field) return null
    const label = typeof result.label === 'string' && result.label ? result.label : String(field).replace(/^\[[A-Z]\d+\]\s*/, '')
    task.fieldTried ??= []
    if (task.fieldTried.includes(label)) return null
    task.fieldTried.push(label)
    const spans = candidateSpans([task.goal, ...(task.userContext || []).slice(-2)])
    if (!spans.length) return null
    try {
      const scope = provider.reflexScope(run, { callId: `${task.taskId}.text`, namespace: null }, task.cardId)
      if (!scope?.client) return null
      const picked = await pickFieldText({ client: scope.client, goal: task.goal, field: label, host: task.cardHost ?? null, spans, thresholds, timeoutMs, authorizeDispatch: scope.authorizeDispatch })
      if (typeof scope.isDecisionCurrent === 'function' && !scope.isDecisionCurrent()) return null
      return picked.text ? { [field]: picked.text } : null
    } catch { return null }
  }

  async function loop(run, task, hosts) {
    return withBrowserTaskActivity(run, task, onStepEvent, () => loopSegments(run, task, hosts))
  }
  async function loopSegments(run, task, hosts) {
    if (!task.cardHost && typeof hosts?.[task.cardId] === 'string') task.cardHost = hosts[task.cardId].toLowerCase() // the card's host, for the brief
    let values = null // a1 fieldText: the chosen text, given to the next segment once (the loop keeps what is still to type in its state)
    // Segments of a few steps; the task's total budget survives pauses.
    for (;;) {
      const remaining = MAX_TASK_STEPS - task.steps
      if (remaining <= 0) return finishPause(task, { kind: 'cannot_proceed', code: 'step_limit' }, null)
      // c23: a change of the goal ends this segment at the next safe point (signal); the next one starts under the new goal
      task.replan = false
      const controller = new AbortController()
      task.abort = controller
      const extra = fieldTextOn() ? { ...(values ? { values } : {}), valuesFirst: true, textComboboxes: true,
        firstFieldText: async field => (await chosenText(run, task, { field }))?.[field] ?? null } : {}
      values = null
      const result = await provider.runDirectTask(run, { cardId: task.cardId, goal: task.goal, authority: task.authority, namedButtonRequest: task.changes?.at(-1) ?? task.goal, userContext: task.userContext, resumeState: task.state, priorRun: task.prior, memoryPacket: task.memoryPacket,
        maxSteps: Math.min(SEGMENT_STEPS, remaining), callId: `${task.taskId}.s${++task.segments}`, onStep: info => { store.progress?.(task, info); stepEvent(run, task, info) }, today: localDay(now()), signal: controller.signal, ...extra })
      if (task.abort === controller) task.abort = null
      task.liveStep = 0
      recordSteps(result)
      tally(task, result)
      task.state = record(result.state) ? result.state : task.state
      store.touch(task)
      if (result.staleBy === 'user-hold') return fromResult(task, result) // even a changed goal cannot resume a revoked Card
      // c23: whatever this segment ended with (even a pause or done) was about the OLD goal: the person changed it meanwhile, so plan again
      if (task.replan && result.outcome !== 'fallback' && task.status === 'running') continue
      if (result.outcome === 'max_steps' && result.reason !== 'step_rejected') continue
      if (fieldTextOn() && task.status === 'running') {
        // the step needs text for a field (or was undecided with a text field among its top two choices, nothing left to type): the span choice, then the loop goes on
        const pendingText = Array.isArray(task.state?.pending) && task.state.pending.length > 0
        const rankedField = result.outcome === 'escalated' && result.reason === 'uncertain' && !pendingText ? undecidedField(result) : null
        const chosen = result.outcome === 'needs_free_text' ? await chosenText(run, task, result) : rankedField ? await chosenText(run, task, { field: rankedField }) : null
        if (chosen) { values = chosen; continue }
        // A confirmed person-only step never reaches this branch.
        if (rankedField && task.steps === 1 && canContinue(task.cardId)) return fromResult(task, { outcome: 'needs_free_text', field: rankedField, fieldTarget: result.fieldTarget })
      }
      return fromResult(task, result)
    }
  }

  // Task end (done, or stuck): a content-minimal outcome candidate goes to the GENERAL ontology write judgment and the host write
  // path through outcomeSink; this module stores nothing. Never fatal; the result (a status word) is reported to the caller.
  function remember(task, outcome) {
    try {
      if (typeof outcomeSink !== 'function' || !task.host) return
      const candidate = outcomeCandidate({ taskId: task.taskId, goal: task.goal, host: task.host, outcome, trail: task.trail, resolved: task.resolved, now: now() })
      if (!candidate) return
      task.pendingWrite = Promise.resolve(outcomeSink(candidate, { memoryPages: task.memoryPages || [], memory: task.memory })).catch(() => ({ status: 'unavailable' }))
    } catch { /* memory never changes the task */ }
  }
  const finalize = async (out, task) => {
    if (task?.pendingWrite) { out.memoryWrite = await task.pendingWrite; task.pendingWrite = null }
    return out
  }

  function finishPause(task, pause, result, extra = {}) {
    task.status = 'paused'; task.pause = pause; task.question = null; store.touch(task)
    // a confirmation settles the same "which one?" as a choice: the record keeps the closed layout (choice_needed)
    const asked = pause.code === 'confirm_needed' ? 'choice_needed' : pause.code
    // c44: what the person was asked to choose between, in the order the question listed it (the note's own candidates): the reply "두번째" is read against it (egdesk-browser-choice-reply.mjs)
    task.askedCandidates = pause.kind === 'need_context' && asked === 'choice_needed' ? (extra.candidates || []).slice(0, 3).map(item => compactText(String(item).replace(/^\[[A-Z]\d+\]\s*/, ''), 60)) : []
    if (pause.kind === 'need_context' && ASKED_CODES.has(asked)) task.pendingAsk = asked
    else if (pause.code !== 'page_unclear') remember(task, { status: 'stuck', code: pause.code }) // a page to look at is a pause, not an outcome
    const field = result?.label || result?.field || (result?.fields?.length === 1 ? result.fields[0] : null)
    const continueTask = ['detail_needed', 'uncertain', 'page_unclear'].includes(pause.code) && canContinue(task.cardId)
    const status = continueTask ? (pause.code === 'detail_needed' && field ? 'needs_value' : 'needs_guidance') : pause.kind === 'need_context' ? 'need_context' : 'cannot_proceed'
    task.askedField = status === 'needs_value' && result?.fieldTarget ? { ...result.fieldTarget, name: askName(field) } : null
    return { handled: true, status: 'paused', taskId: task.taskId,
      note: subjectiveNote(task, { status, field, code: pause.code, candidates: extra.candidates, detail: extra.detail, staleBy: extra.staleBy, recorded: extra.recorded }) }
  }

  function fromResult(task, result) {
    switch (result.outcome) {
      case 'done': {
        task.status = 'done'; task.pause = null; store.touch(task)
        remember(task, { status: 'done' })
        const allowPage = pageTextInNote() === true
        const { found, page } = allowPage ? finishedPageFacts(result.text, taskIdentifiers(task)) : { found: [], page: [] }
        return { handled: true, status: 'done', taskId: task.taskId, note: subjectiveNote(task, { status: 'done', found, page, searchedFor: allowPage ? result.searchedFor : null, arrivalUnobserved: result.arrivalUnobserved === true }) }
      }
      case 'needs_user_context': {
        const candidates = result.candidates || []
        // c17: with exactly one candidate there is nothing to choose between: the person is asked to confirm it (closed code, worded by the
        // subjective model), e.g. whether the business on the page now is the one chosen last time. Real c16: "which" with one candidate.
        if (candidates.length === 1) {
          task.confirm = { candidate: compactText(candidates[0].replace(/^\[[A-Z]\d+\]\s*/, ''), 60), recorded: typeof result.recordedLabel === 'string' ? result.recordedLabel : null }
          return finishPause(task, { kind: 'need_context', code: 'confirm_needed' }, result, { candidates, recorded: task.confirm.recorded })
        }
        return finishPause(task, { kind: 'need_context', code: 'choice_needed' }, result, { candidates })
      }
      case 'needs_free_text': return finishPause(task, { kind: 'need_context', code: 'detail_needed' }, result)
      // c16: the page-state predicates did not decide; the person is asked to look at the page (closed code, worded by the subjective model)
      case 'page_unclear': return finishPause(task, { kind: 'need_context', code: 'page_unclear' }, result)
      case 'handoff': return finishPause(task, { kind: 'cannot_proceed', code: typeof result.pageState === 'string' ? result.pageState : 'sensitive_flow' }, result)
      case 'escalated': {
        const last = (result.steps || []).at(-1)
        // c19: a control the loop cannot operate (excluded.unsupported) is the person's step as much as a person-only one
        const humanStep = result.reason === 'human_step' || (result.reason === 'blocked' && (last?.excluded?.gated ?? 0) + (last?.excluded?.unsupported ?? 0) > 0)
        const code = humanStep ? 'human_step' : CANNOT.has(result.reason) ? result.reason : 'blocked'
        // c22: a person-only control the request is about is named (its label), so the person is told what to change themselves
        return finishPause(task, { kind: 'cannot_proceed', code }, result, { detail: result.code, staleBy: result.staleBy, ...(Array.isArray(result.controls) && result.controls.length ? { candidates: result.controls.filter(label => typeof label === 'string').slice(0, 3) } : typeof result.target === 'string' && result.target ? { candidates: [result.target] } : {}) })
      }
      case 'max_steps': return finishPause(task, { kind: 'cannot_proceed', code: 'step_rejected' }, result, { detail: result.code })
      case 'fallback': // the judge is unavailable: today's behaviour, the subjective model drives the tools itself
        task.status = 'cancelled'; store.touch(task)
        return { handled: false, reason: `fallback:${result.reason || 'unavailable'}` }
      default: task.status = 'cancelled'; return { handled: false, reason: `outcome:${result.outcome}` }
    }
  }

  // The task's card is known: bind it and read the prior record for that card's site.
  function startOnCard(task, cardId, cards) {
    task.cardId = cardId
    const host = cards.find(card => card.cardId === cardId)?.host
    task.prior = priorFromMemory(task.memoryPages || [], { scope: task.memory?.scope ?? null, hosts: host ? [host] : [] })
  }

  // The task waits for the person to say which card. Nothing is recorded as an outcome (no page was touched).
  // The first lines each card shows now, by one observation per card (a UI read; no Decision request). Only when code did not name the card
  // and the run may receive page text; a card that cannot be observed is quoted by title and host alone.
  const withShownLines = (run, message, cards, replyTo = null) => observeCardLines({ provider, run, message, cards, replyTo, enabled: cardTextInEntry() === true })

  function askWhichCard(task, cards, extra = {}) {
    task.entryAsks++
    task.status = 'paused'; task.pause = { kind: 'need_context', code: 'card_choice_needed' }; task.question = null; task.asked = false; store.touch(task)
    return { handled: true, status: 'paused', taskId: task.taskId, ...extra,
      note: subjectiveNote(task, { status: 'need_context', code: 'card_choice_needed', candidates: entryOptions(cards).map(option => option.value) }) }
  }

  // The shared continuation of a paused task (the answer, a retry, a changed request): the card is settled first when the person was asked which, then the loop goes on.
  async function continueOn(paused, { run, conversationKey, message, cards, hosts, gateScope, how }) {
      if (!paused.cardId) { // the person was asked which card: the entry is decided again with their answer, then the task starts there
        const picked = await decideBrowserEntry({ message: paused.goal, replyTo: message, cards: await withShownLines(run, paused.goal, cards, message), client: gateScope.client, thresholds, timeoutMs, authorizeDispatch: gateScope.authorizeDispatch })
        if (!gateScope.isDecisionCurrent()) return { handled: false, reason: 'evidence_unavailable' }
        if (picked.kind !== 'browser') {
          if (picked.kind === 'ask_user' && cards.length > 1 && paused.entryAsks < MAX_ENTRY_ASKS) return askWhichCard(paused, cards, { resumed: true })
          paused.status = 'cancelled'
          return { handled: false, reason: picked.kind }
        }
        startOnCard(paused, picked.cardId, cards)
      }
      // c17: a bare "응" says nothing without what was asked; code names what the person confirmed (R1)
      const confirm = paused.confirm
      void (how === 'retry' ? store.retry(paused) /* c37: try again from this page */ : how === 'change' ? store.changeGoal(conversationKey, message, conversationAuthority(run, message)) /* c23: the message replaces the request: it is the goal now, not an answer */ : paused.userContext.push(confirm ? `Asked to confirm "${confirm.candidate}"${confirm.recorded ? ` as the earlier choice "${confirm.recorded}"` : ''}, the user answered: ${compactText(message, MAX_MESSAGE)}` : choiceContextLine(compactText(message, MAX_MESSAGE), paused.askedCandidates, { maxChars: MAX_MESSAGE })))
      paused.askedCandidates = []
      paused.confirm = null; paused.status = 'running'; paused.pause = null; paused.asked = false
      const out = await finalize(await loop(run, paused, hosts), paused)
      return { ...out, resumed: true }
  }

  // c37 (open items): the person's message settles one option of the conversation's open browser task. Applied BEFORE the engine turn; the engine gets the
  // settled state as a closed note. abandon and ask_page need no loop; continue, retry and change go on with it.
  const observeTaskLines = async (run, task) => {
    try {
      if (cardTextInEntry() !== true || !task.cardId) return []
      const scope = provider.reflexScope?.(run, { callId: 'open-item-observe', namespace: null }, task.cardId)
      if (typeof scope?.callTool !== 'function') return []
      const observed = await scope.callTool('egdesk_browser_observe', { cardId: task.cardId })
      return pageLines(Array.isArray(observed?.snapshot?.text) ? observed.snapshot.text : [])
    } catch { return [] }
  }
  async function settleWith(task, optionId, ctx) {
    if (optionId === 'abandon') {
      task.status = 'cancelled'; try { task.abort?.abort() } catch { /* the segment may be over */ }
      store.touch(task)
      return { handled: true, status: 'cancelled', taskId: task.taskId, settled: optionId, note: settledNote(task, optionId) }
    }
    if (optionId === 'ask_page') {
      const lines = await observeTaskLines(ctx.run, task)
      return { handled: true, status: task.status === 'paused' ? 'paused' : 'running', taskId: task.taskId, settled: optionId, note: settledNote(task, optionId, { lines }) }
    }
    if (task.status !== 'paused') return { handled: false, reason: 'not_paused' }
    if (optionId === 'retry' && !task.cardId) return { handled: false, reason: 'cannot_retry' }
    if (!['continue', 'retry', 'change'].includes(optionId)) return { handled: false, reason: 'unknown_option' }
    const out = await continueOn(task, { ...ctx, how: optionId === 'continue' ? 'answer' : optionId })
    return out?.handled === true ? { ...out, settled: optionId } : out
  }
  const cardsOf = (run, hosts, titles) => (run?.browserBinding?.cards || []).filter(card => card.permission === 'interact').map(card => ({ cardId: card.cardId, host: hosts[card.cardId] || '',
    title: typeof titles[card.cardId] === 'string' ? compactText(titles[card.cardId], 120) : '' }))
  return {
    // c37: the registry's apply() (lane L1): the option the Decision settled, applied to the conversation's open task. Same gates as handle().
    async settle({ run, conversationKey, optionId, message, hosts = {}, titles = {} }) {
      const task = store.active(conversationKey), cards = cardsOf(run, hosts, titles)
      if (!task) return { handled: false, reason: 'no_task' }
      if (optionId === 'abandon') return settleWith(task, optionId, { run, conversationKey, message, cards, hosts })
      if (!cards.length) return { handled: false, reason: 'no_card' }
      if (typeof provider.directEntryEnabled !== 'function' || !provider.directEntryEnabled()) return { handled: false, reason: 'mode_off' }
      const gateScope = provider.reflexScope(run, { callId: 'direct-entry', namespace: null }, cards[0].cardId)
      if (!gateScope.client) return { handled: false, reason: 'mode_off' }
      try { return await settleWith(task, optionId, { run, conversationKey, message, cards, hosts, gateScope }) } catch (error) { return { handled: false, reason: error instanceof DecisionError ? `fallback:${error.code}` : 'error' } }
    },
    // entryAnswers: normalized answers of a request the host already sent at turn start with entryQuestion(cards) appended
    // (one request instead of two). When it holds a usable browser_entry answer no separate entry request is made.
    async handle({ run, conversationKey, message, hosts = {}, titles = {}, memory = null, entryAnswers = null, openItemRead = null }) {
      if (typeof message !== 'string' || !message.trim()) return { handled: false, reason: 'empty' }
      const cards = (run?.browserBinding?.cards || []).filter(card => card.permission === 'interact').map(card => ({ cardId: card.cardId, host: hosts[card.cardId] || '',
        title: typeof titles[card.cardId] === 'string' ? compactText(titles[card.cardId], 120) : '' }))
      if (!cards.length) return { handled: false, reason: 'no_card' }
      if (typeof provider.directEntryEnabled !== 'function' || !provider.directEntryEnabled()) return { handled: false, reason: 'mode_off' }
      const gateScope = provider.reflexScope(run, { callId: 'direct-entry', namespace: null }, cards[0].cardId)
      if (!gateScope.client) return { handled: false, reason: 'mode_off' }
      const paused = store.paused(conversationKey)
      try {
        // c37 (flag EGDESK_BROWSER_OPEN_ITEMS, default off; or a read the registry already made): the open task's options are Decision predicates, one request,
        // and the settled option is applied by code. Not settled (several yes, an unknown, all no) changes nothing: the ordinary turn.
        if (paused && (openItems() === true || openItemRead)) {
          const change = inRunChange() === true
          const read = openItemRead && typeof openItemRead.kind === 'string' ? openItemRead
            : await decideOpenItem({ message, task: paused, change, client: gateScope.client, thresholds, timeoutMs, authorizeDispatch: gateScope.authorizeDispatch })
          if (!gateScope.isDecisionCurrent()) return { handled: false, reason: 'evidence_unavailable' }
          const bar = decisionThresholds(thresholds).done
          note(null, { feature: 'browser_open_item', mode: 'on', candidates: Object.keys(read.p || {}).length, judgments: Object.entries(read.p || {}).map(([id, p]) => ({ q: `open_browser_${id}`, would: !Number.isFinite(p) ? 'unknown' : p >= bar ? 'act' : p <= 1 - bar ? 'none' : 'hold', p: Number.isFinite(p) ? p : null, threshold: bar })) })
          if (read.kind !== 'settled') return { handled: false, reason: read.kind === 'none' ? 'unrelated' : 'uncertain' }
          return await settleWith(paused, read.optionId, { run, conversationKey, message, cards, hosts, gateScope })
        }
        if (paused) {
          const resume = await decideResume({ message, pause: paused.pause, question: paused.question, detectChange: inRunChange() === true, client: gateScope.client, thresholds, timeoutMs, authorizeDispatch: gateScope.authorizeDispatch })
          if (!gateScope.isDecisionCurrent()) return { handled: false, reason: 'evidence_unavailable' }
          if (resume.kind === 'cancel_task') { paused.status = 'cancelled'; return { handled: false, reason: 'task_cancelled' } }
          if (resume.kind !== 'resume_task') return { handled: false, reason: resume.kind === 'unrelated' ? 'unrelated' : 'uncertain' }
          return await continueOn(paused, { run, conversationKey, message, cards, hosts, gateScope, how: resume.change === true ? 'change' : 'answer' })
        }
        // The turn's memory packet (fetched once by the general memory feature for this turn) is evidence for the objective steps, not for the
        // entry. Real measurement (2026-11-25): the same request with the packet in the entry evidence fell from 0.93 to 0.76 against a 0.75 bar.
        const memoryPacket = typeof memory?.packet === 'string' && memory.packet ? memory.packet : null
        const rode = entryAnswers && entryAnswers.browser_entry?.type === 'predicate'
        let entry = rode ? readBrowserEntry(entryAnswers, cards, { codeCard: entryAnswers.codeCard ?? null })
          : await decideBrowserEntry({ message, cards: await withShownLines(run, message, cards), client: gateScope.client, thresholds, timeoutMs, authorizeDispatch: gateScope.authorizeDispatch })
        if (rode && entry.kind !== 'browser' && cardTextInEntry() === true) {
          // c23: the follow-up for the ride-along answers (the standalone entry did it inside decideBrowserEntry)
          const seen = await withShownLines(run, message, cards)
          const wall = await entryWallFollowUp({ message, cards: seen, entry, client: gateScope.client, timeoutMs, authorizeDispatch: gateScope.authorizeDispatch })
          if (wall) entry = wall.entry
        }
        if (!gateScope.isDecisionCurrent()) return { handled: false, reason: 'evidence_unavailable' }
        record1(entry, cards.length, entry.kind === 'browser' ? 'act' : 'hold')
        // Several granted cards and the pick is not decided (or the model chose to ask): the person is asked which card, and the request
        // is kept as the goal of a task waiting for that answer. Real measurement: two cards gave ask_user at confidence 0.51 (bar 0.75).
        // A message whose top answer is "not a browser task", or a single card, stays an ordinary turn.
        // c20: the person is asked which card only when the predicates say so (a web task, the card undecided, or two cards decided yes)
        const askCard = entry.kind === 'ask_user' && cards.length > 1
        if (entry.kind !== 'browser' && !askCard) return { handled: false, reason: entry.kind }
        const authority = conversationAuthority(run, message)
        if (!authority) return { handled: false, reason: 'evidence_unavailable' }
        const task = store.create({ conversationKey, cardId: askCard ? null : entry.cardId, goal: message, authority })
        task.memoryPacket = memoryPacket
        task.memory = memory
        task.memoryPages = Array.isArray(memory?.pages) ? memory.pages : []
        if (askCard) return askWhichCard(task, cards)
        startOnCard(task, entry.cardId, cards)
        return await finalize(await loop(run, task, hosts), task)
      } catch (error) {
        record1({}, cards.length, 'hold', error instanceof DecisionError && ['timeout', 'unreachable', 'bad_response', 'budget_exceeded', 'evidence_unavailable', 'not_configured'].includes(error.code) ? error.code : null)
        return { handled: false, reason: error instanceof DecisionError ? `fallback:${error.code}` : 'error' }
      }
    },
  }
}
