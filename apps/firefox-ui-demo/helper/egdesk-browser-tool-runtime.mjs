import { createHash, randomUUID } from 'node:crypto'
import { CURRENT_ACTION_GATE_POLICY, actionGate, classifyAction } from './egdesk-browser-action-classifier.mjs'
import { authOpaqueOn, isAuthOpaqueUrl } from './egdesk-auth-opaque.mjs'
import { DEFAULT_NAVIGATION_POLICY, evaluateNavigation, formResultLanded, normalizeNavigationPolicy, sitePatternsFromInput } from './egdesk-browser-url-policy.mjs'

// Lane A/native adapter: chrome /chat/send includes selectedSources from the
// submitted Chat draft before it is cleared. Never infer action authority from
// immutable read-only attachments. prepare({selectedSources}) -> specs(prepared)
// -> bind(run, prepared) -> dispatch(run, {tool, arguments, callId}).
// sendToUi(request) must correlate requestId to a single response from the
// chrome UI's browserAgentTools.attachTransport({source, respond}) listener for
// a Lane A-validated SSE stream's `browser-tool-request` event.
// Requests carry runId, cardId, targetCardEpoch, deadlineMs, permission-bound selection/binding,
// actor guard and postcondition; never fan out to all open Browser Cards.
// Lane A owns native registration, response mapping, run cancellation and
// transport authentication. This module owns run admission/preconditions;
// Firefox chrome owns the final live Card/actor comparison and actual input.
const target = { type: 'object', additionalProperties: false, required: ['ref', 'role', 'label', 'href', 'value', 'tag'],
  properties: { ...Object.fromEntries(['ref', 'role', 'label', 'href', 'value', 'tag'].map(key => [key, { type: 'string' }])),
    disabled: { type: 'boolean' }, bounds: { type: 'object', additionalProperties: false,
      properties: Object.fromEntries(['x', 'y', 'width', 'height'].map(key => [key, { type: 'number' }])) } } }
const postcondition = { type: 'object', additionalProperties: false, required: ['kind', 'value'],
  properties: { kind: { type: 'string', enum: ['visible-text', 'url', 'target-value'] }, value: { type: 'string' } } }
const base = { cardId: { type: 'string' }, observationId: { type: 'string' }, expectedRevision: { type: 'integer' } }
// Existing tool inputSchemas are hashed into native thread manifests; change
// only descriptions of observe/navigate/click/fill, never their schemas.
const SCROLL_DIRECTIONS = ['up', 'down', 'top', 'bottom']
const SCROLL_AMOUNTS = ['page', 'half']
const PRESS_KEYS = ['Enter', 'Escape', 'Tab', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Backspace', 'Space']
// Activation keys can submit or activate like a click; they need a testable effect.
const ACTIVATION_KEYS = new Set(['Enter', 'Space'])
const WAIT_CONDITIONS = ['load', 'idle', 'selector-visible']
const MAX_WAIT_MS = 10000
const WAIT_RESPONSE_MARGIN_MS = 2000
// egdesk_browser_wait_text: a short visible text to appear or disappear.
const MAX_WAIT_TEXT = 200
const OBSERVE_TEXT_LIMIT = 60
// BRW-09 egdesk_browser_screenshot: an observe request that also carries a
// masked capture. The image never replaces the Card's fresh observation.
const SCREENSHOT_BUDGET_CHARS = 150000
const SCREENSHOT_OBSERVE_OPTIONS = Object.freeze({ textLimit: 1, elementLimit: 1,
  screenshot: Object.freeze({ maxEdge: 1280, budgetChars: SCREENSHOT_BUDGET_CHARS, format: 'jpeg', quality: 0.7 }) })
// BRW-12: one read-only reconcile question after a lost act response, on a
// short budget of its own. Never a retry of the action (REA EG-01).
const RECONCILE_TIMEOUT_MS = 3000
const DIALOG_TYPES = new Set(['alert', 'confirm', 'prompt', 'beforeunload'])
// Fill text and its full-value postcondition share one bounded UI request
// (codex-browser-tool-transport.mjs refuses requests over 48000 characters).
const MAX_FILL_TEXT = 8000
const MAX_FILL_REQUEST_JSON = 40000
const OBSERVED_VALUE_MAX = 120
// BRW-07: history moves EG-Desk chrome dispatches on the Card; Cards per run.
const HISTORY_ACTIONS = ['back', 'forward', 'reload']
const MAX_RUN_CARDS = 4
// BRW-05 (D-B1): one question to the person about one more site, on the
// longest budget the UI transport allows, so the Card can wait for an answer.
const SITE_REQUEST_BUDGET_MS = 55000
// Same-clock receipts: helper, Firefox chrome and the page actor stamp
// performance.timeOrigin + performance.now() (epoch ms, may be fractional).
const sameClock = () => performance.timeOrigin + performance.now()
// UI/actor timing fields copied into receipts as sent; malformed ones are dropped.
const UI_TIMING_MS = ['receivedAtMs', 'authorizedAtMs', 'actorReceivedAtMs', 'performEnterMs', 'performExitMs', 'firstEventAtMs']
const UI_TIMING_COUNTS = ['performCallsBefore', 'performCallsAfter']
function spec(name, description, properties, required) {
  return { type: 'function', name, description, inputSchema: { type: 'object', additionalProperties: false, properties, required } }
}
export const BROWSER_TOOL_SPECS = [
  spec('egdesk_browser_observe', 'Observe one explicitly selected Browser Card. Coordinates are Browser surface-local; camera movement does not change the target. Elements inside open and closed shadow roots and same-origin frames are included, and a frame element ref carries its frame path (for example f2/el_9); cross-origin, private or unreadable frames appear only in inaccessibleFrames and cannot be read or operated. Elements a page made clickable without a native control (cursor:pointer or onclick) have role clickable; a label around a hidden radio or checkbox has that role with value checked or unchecked; an element that scrolls its own content has role scrollable (or its own role) and its scroll offsets in scrollContainers. A selected account label does not prove site login.',
    { cardId: base.cardId }, ['cardId']),
  spec('egdesk_browser_navigate', 'Request navigation in the bound Browser Card to an http(s) URL on the same site (registrable domain) as the currently observed document; other sites and https-to-http downgrades are rejected. Then observe. A dispatched request does not prove load or an external effect.',
    { ...base, url: { type: 'string' }, postcondition }, ['cardId', 'observationId', 'expectedRevision', 'url', 'postcondition']),
  spec('egdesk_browser_click', 'Request one guarded DOM click on an observed element without pointerdown or a focus step. A site may ignore synthetic clicks or focus another element itself. Requires a fresh observation, exact target precondition and testable DOM postcondition; an interaction grant is not proof of external authorization or submission success. A click that would land on another element is refused before input, and the error names what covers it (obscuredBy) so you can deal with that element first.',
    { ...base, ref: { type: 'string' }, expectedTarget: target, postcondition },
    ['cardId', 'observationId', 'expectedRevision', 'ref', 'expectedTarget', 'postcondition']),
  spec('egdesk_browser_fill', 'Fill an observed non-password field, or replace the text of an observed contenteditable editor, in the bound Browser Card with up to 8000 characters, without moving focus. Requires a fresh observation, exact target precondition and a target-value postcondition holding the full value you expect. Observations show a field value over 120 characters as a prefix with its length and fingerprint, and editor text only as its length and fingerprint; EG-Desk compares the postcondition in that form. An editor may handle the input itself, so a multi-line editor value can stay unverified.',
    { ...base, ref: { type: 'string' }, expectedTarget: target, text: { type: 'string' }, postcondition },
    ['cardId', 'observationId', 'expectedRevision', 'ref', 'expectedTarget', 'text', 'postcondition']),
  spec('egdesk_browser_scroll', 'Scroll the bound Browser Card with the DOM scroll API, without focus or pointer input: either direction (up, down, top, bottom) by amount (page or half, default page) for the page, ref with expectedTarget to bring one observed element into view, or ref and expectedTarget of an element listed in scrollContainers together with direction (and amount) to scroll inside that element. Requires a fresh observation and returns the observed scroll position change; scrolling does not prove that more content loaded.',
    { ...base, direction: { type: 'string', enum: SCROLL_DIRECTIONS }, amount: { type: 'string', enum: SCROLL_AMOUNTS },
      ref: { type: 'string' }, expectedTarget: target }, ['cardId', 'observationId', 'expectedRevision']),
  spec('egdesk_browser_press', 'Dispatch one synthetic DOM key event to an observed element that is already focused, or to the field just filled with egdesk_browser_fill. EG-Desk never moves focus. Synthetic key events are untrusted, so the browser runs no default key action; only Enter on a form text field emulates implicit form submission, and the receipt states it. Enter and Space require a testable postcondition; other keys may omit it.',
    { ...base, ref: { type: 'string' }, expectedTarget: target, key: { type: 'string', enum: PRESS_KEYS }, postcondition },
    ['cardId', 'observationId', 'expectedRevision', 'ref', 'expectedTarget', 'key']),
  spec('egdesk_browser_wait', 'Wait up to timeoutMs (100 to 10000) for the bound Browser document to finish loading (load), to stop changing (idle), or for an observed element ref to become visible (selector-visible, which needs that observationId), then return a fresh observation. wait-timeout means the condition was not observed in time; a replaced document or lost response is an unknown outcome. Never acts on the page.',
    { cardId: base.cardId, for: { type: 'string', enum: WAIT_CONDITIONS }, ref: { type: 'string' },
      observationId: base.observationId, timeoutMs: { type: 'integer' } }, ['cardId', 'for', 'timeoutMs']),
  // New tool, appended so existing schemas and their manifest order stay.
  spec('egdesk_browser_wait_text', 'Wait up to timeoutMs (100 to 10000) until the visible page text of one selected Browser Card contains text, or no longer contains textGone (give exactly one, up to 200 characters), then return a fresh observation. Matching is case-sensitive after collapsing whitespace, on visible page text only: field values, editors, sensitive fields and hidden text are never read. Read-only and allowed with an observe grant; it never acts on the page. wait-timeout means the condition was not seen in time; a replaced document or lost response is an unknown outcome.',
    { cardId: base.cardId, text: { type: 'string' }, textGone: { type: 'string' }, timeoutMs: { type: 'integer' } },
    ['cardId', 'timeoutMs']),
  // BRW-05 / BRW-07 / BRW-11 tools, appended in this order so earlier schemas
  // and their manifest order stay. Every one names a Card of this run.
  spec('egdesk_browser_list_cards', 'List the Browser Cards this run may use: cardId, permission (observe or interact), the last observed URL, and whether this run opened the Card. Every other Browser tool names one of these cardIds; naming another listed Card switches the target. Read-only; cardId is any Card of this run.',
    { cardId: base.cardId }, ['cardId']),
  spec('egdesk_browser_request_site', 'Ask the person to allow one more site for this conversation: Agent navigation, links, redirects, history moves and new Cards may then reach that site in addition to the current site. site is a host or http(s) URL; its registrable domain is what gets allowed, never a path. The person answers on the Browser Card; site-allowed, site-refused or site-pending (no answer in time) is the whole result. Ask only after a navigation was refused as outside-site, and do not repeat a refused request in the same run.',
    { cardId: base.cardId, site: { type: 'string' } }, ['cardId', 'site']),
  spec('egdesk_browser_open_card', 'Open a new Browser Card beside the named Card, in the same profile, container and account, at an http(s) URL on the current site or on a site this conversation allowed. The new Card inherits this run\'s permission and appears in egdesk_browser_list_cards with its own cardId; observe it before acting. A Card a person opened, or a popup a page opened, is never adopted this way. Up to four Cards per run.',
    { cardId: base.cardId, url: { type: 'string' } }, ['cardId', 'url']),
  spec('egdesk_browser_close_card', 'Close a Browser Card this run opened with egdesk_browser_open_card. Cards a person opened or selected cannot be closed by the Agent.',
    { cardId: base.cardId }, ['cardId']),
  spec('egdesk_browser_history', 'Move the named Browser Card back or forward in its history, or reload it, from a fresh observation. EG-Desk chrome dispatches the move, not the page; a page outside the current and allowed sites is replaced with a blank page by the same rule as navigation. The result reports the dispatch only; observe again to see the page.',
    { ...base, action: { type: 'string', enum: HISTORY_ACTIONS } }, ['cardId', 'observationId', 'expectedRevision', 'action']),
  // BRW-09 (D-B6): appended; read-only, allowed with an observe grant.
  spec('egdesk_browser_screenshot', 'Capture the visible viewport of one selected Browser Card as an image (JPEG, longest edge up to 1280 pixels) for pictures, charts and layout that text observation cannot show. Password and other sensitive fields, payment autocomplete fields, other-site or unreadable frames and embedded objects are painted over before the image leaves the browser, and maskedRegions lists each covered box in Browser surface-local CSS pixels (image pixel = CSS pixel x imageScale). When a box cannot be trusted or the page changed during capture, no image is sent and reason says why; observe and try again. Image pixels are never input coordinates: observe again and use element refs before any action. Read-only; never acts on the page.',
    { cardId: base.cardId }, ['cardId']),
  // BRW-10 (REA 웹1·웹2, D-B4): appended; egdesk_browser_click and
  // egdesk_browser_press keep their schemas and behaviour.
  spec('egdesk_browser_pointer_click', 'Press an observed element like a person: one trusted pointer move, button down and button up at the centre of its observed bounds, for menus and buttons that react to pointerdown, mousedown or hover and ignore egdesk_browser_click. Use it only after egdesk_browser_click on the same element was dispatched and a quiet settle reported no observed effect. Observe again first: the document, exact URL and revision must still match, with no intervening state-changing Browser request in this run. The point comes only from the fresh observation and is used only while the page, its scroll position, the viewport size, devicePixelRatio and page zoom are unchanged; otherwise it is refused before input. It is never retried and never replaces a click on its own. It moves the page\'s own focus to the pressed element, may let the page open a popup or download as after a person\'s click, and a press that would land on another element is refused with obscuredBy. Requires the exact target precondition and a testable postcondition; neither a quiet settle nor a dispatched press proves anything about external effects.',
    { ...base, ref: { type: 'string' }, expectedTarget: target, postcondition },
    ['cardId', 'observationId', 'expectedRevision', 'ref', 'expectedTarget', 'postcondition']),
  spec('egdesk_browser_type', 'Type text like a person into the observed text field or editor that already has the focus in its page (observe focusedElement; egdesk_browser_pointer_click on a field focuses it), through the browser\'s own text input path, then optionally press one key the same way (key; the browser runs that key\'s default action, so Enter may submit a form). EG-Desk never moves focus; an unfocused, password or sensitive target is refused. Text goes in at the caret and does not replace the existing value (use egdesk_browser_fill to replace). Up to 8000 characters, or empty text with a key. Requires a fresh observation, exact target precondition and a testable postcondition; never retried.',
    { ...base, ref: { type: 'string' }, expectedTarget: target, text: { type: 'string' }, key: { type: 'string', enum: PRESS_KEYS }, postcondition },
    ['cardId', 'observationId', 'expectedRevision', 'ref', 'expectedTarget', 'text', 'postcondition']),
]
const SPEC_BY_NAME = new Map(BROWSER_TOOL_SPECS.map(item => [item.name, item]))
// Tool classes for the runtime and provider (1-R imports these instead of
// keeping its own copy). Read tools never take an action lease and work
// with an observe grant; interaction tools need an interact grant.
export const BROWSER_READ_TOOL_NAMES = Object.freeze(['egdesk_browser_observe', 'egdesk_browser_wait_text',
  'egdesk_browser_list_cards', 'egdesk_browser_screenshot'])
export const BROWSER_INTERACTION_TOOL_NAMES = Object.freeze(['egdesk_browser_navigate', 'egdesk_browser_click',
  'egdesk_browser_fill', 'egdesk_browser_scroll', 'egdesk_browser_press', 'egdesk_browser_wait',
  'egdesk_browser_request_site', 'egdesk_browser_open_card', 'egdesk_browser_close_card', 'egdesk_browser_history',
  'egdesk_browser_pointer_click', 'egdesk_browser_type'])
const READ_TOOLS = new Set(BROWSER_READ_TOOL_NAMES)

function reject(code, message) { throw Object.assign(new Error(message), { code }) }
// L6 a1 (D25): which observed fact made a Browser action "not sent" (BROWSER_OBSERVATION_STALE), in one closed word. Every refusal before any input
// reached the helper as that one code, so a deterministic refusal (the Card's site rule, a viewport or focus that moves, another binding) could not be told
// from a page that really changed. Read from the Card's or the page actor's refusal text, never from page content: a word outside this list is 'other'.
//   observation  the helper's own copy: not the latest observation of this Card, or another revision (nothing was sent to the Card)
//   document / revision / viewport / focus / url / identity / scroll / frame   the page actor's (or the Card's) observed-state guard, by the fact that moved
//   site-rule    the Card's rule for the conversation's sites refused the move     target   the observed element changed or is not usable
//   binding / card-generation / card-busy / budget / user-hold   the Card refused the request itself     reply-lost   the reply was lost; the actor proved it never entered
//   input-authority   the Card did not authorize the input at the last moment (another run or binding holds the Card's selection, the lease or the document moved)
export const BROWSER_STALE_REASONS = Object.freeze(['observation', 'document', 'revision', 'viewport', 'focus', 'url', 'identity', 'scroll', 'frame',
  'site-rule', 'target', 'binding', 'card-generation', 'card-busy', 'budget', 'user-hold', 'input-authority', 'reply-lost', 'other'])
// With input-authority: which check of the Card's last-moment authorization denied the input (browserToolAuthorizePhysicalAction's deny words).
// A parent/actor refusal can precede the lease callback, so it has no lease.deniedBy.
// Both engines use this same list; never store the actor's free-form error.
const ACTOR_INPUT_DENIED_REASONS = ['missing-browsing-context', 'missing-embedder', 'missing-authorizer',
  'ui-denied', 'parent-callback-error', 'deadline-expired-after-approval', 'unknown']
export const BROWSER_INPUT_DENIED_REASONS = Object.freeze([...ACTOR_INPUT_DENIED_REASONS, 'lease-already-used', 'request-id-mismatch', 'deadline-mismatch', 'deadline-expired',
  'browser-identity-mismatch', 'browsing-context-identity-mismatch', 'window-global-identity-mismatch', 'window-global-not-current',
  'inner-window-id-mismatch', 'browsing-context-id-mismatch', 'run-binding-changed', 'run-cancelled', 'run-stopped', 'card-lease-changed', 'card-closed',
  'card-browser-mismatch', 'interaction-not-granted', 'selection-run-mismatch', 'action-type-mismatch', 'action-ref-mismatch', 'action-url-mismatch',
  'live-binding-changed', 'live-binding-unavailable'])
export function inputDeniedReasonOf(response) {
  const match = /^Browser action authority was revoked before input \[([a-z-]{1,40})\]$/.exec(typeof response.error === 'string' ? response.error : '')
  if (BROWSER_INPUT_DENIED_REASONS.includes(response.inputDeniedBy)) return response.inputDeniedBy
  return ACTOR_INPUT_DENIED_REASONS.includes(match?.[1]) ? match[1] : null
}
// With target (L6 a1b): which check of the page actor refused the observed element: a field that moved (role, label, href, value, tag), not a listed control any more
// (candidate), another element under that ref (reference), gone from the page, hidden, disabled, or not an editable field.
export const BROWSER_TARGET_REASONS = Object.freeze(['role', 'label', 'href', 'value', 'tag', 'candidate', 'reference', 'gone', 'hidden', 'disabled', 'not-editable'])
export function targetReasonOf(text) {
  const word = /Browser (?:target (?:changed|is unavailable|is not an editable field)|action requires an observed element reference) \[([a-z-]{1,24})\]/.exec(typeof text === 'string' ? text.slice(0, 600) : '')?.[1]
  return word && BROWSER_TARGET_REASONS.includes(word) ? word : null
}
export function staleReasonOf(text) {
  const message = typeof text === 'string' ? text.slice(0, 600) : ''
  const named = /\bstale \[([a-z-]{1,24})\]/.exec(message)?.[1]
  if (named && BROWSER_STALE_REASONS.includes(named)) return named
  if (/outside the allowed sites/.test(message)) return 'site-rule'
  if (/Browser frame is stale/.test(message)) return 'frame'
  if (/Browser target (?:changed|is unavailable|is not an editable field)|observed element reference/.test(message)) return 'target'
  if (/run binding is missing or changed|profile or account (?:epoch|context) changed|Card, profile or account context changed/.test(message)) return 'binding'
  if (/different Card generation/.test(message)) return 'card-generation'
  if (/Browser Card is (?:already )?being operated/.test(message)) return 'card-busy'
  if (/authority was revoked before input/.test(message)) return 'input-authority'
  if (/reconciled as never sent/.test(message)) return 'reply-lost'
  if (/budget expired|lease is missing or expired|budget is too short/.test(message)) return 'budget'
  if (/operating this Browser Card directly/.test(message)) return 'user-hold'
  return 'other'
}
function record(value) { return value && typeof value === 'object' && !Array.isArray(value) }
function short(value, max = 512) { return typeof value === 'string' && value.length > 0 && value.length <= max }
function sameTarget(left, right) {
  return ['ref', 'role', 'label', 'href', 'value', 'tag'].every(key => left?.[key] === right?.[key])
}
function safeUrl(value) {
  if (!short(value, 2048) || /[\u0000-\u0020\u007f]/.test(value)) return false
  try { const url = new URL(value); return ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password }
  catch { return false }
}
function sameUrl(left, right) {
  try { return new URL(left).href === new URL(right).href }
  catch { return false }
}
// Conservative helper-side approximation of the registrable domain. The
// Firefox actor re-checks with the full Public Suffix List before input.
// Listed multi-label suffixes (including shared hosting) never form a site.
const MULTI_LABEL_SUFFIXES = new Set([
  'co.kr', 'or.kr', 'ne.kr', 'go.kr', 'ac.kr', 're.kr', 'pe.kr', 'ms.kr', 'hs.kr', 'es.kr', 'sc.kr', 'kg.kr', 'mil.kr',
  'co.uk', 'org.uk', 'ac.uk', 'gov.uk', 'me.uk', 'net.uk', 'ltd.uk', 'plc.uk', 'co.jp', 'ne.jp', 'or.jp', 'ac.jp', 'go.jp',
  'com.au', 'net.au', 'org.au', 'edu.au', 'gov.au', 'com.cn', 'net.cn', 'org.cn', 'gov.cn', 'com.tw', 'com.hk', 'com.sg',
  'com.br', 'co.nz', 'co.in', 'co.za', 'com.mx', 'com.tr',
  'github.io', 'gitlab.io', 'githubusercontent.com', 'vercel.app', 'netlify.app', 'pages.dev', 'workers.dev', 'web.app',
  'firebaseapp.com', 'appspot.com', 'herokuapp.com', 'blogspot.com', 'azurewebsites.net', 'cloudfront.net',
  'amazonaws.com', 'onrender.com', 'fly.dev', 'glitch.me', 'ngrok.io', 'ngrok-free.app', 'surge.sh', 'wordpress.com',
])
function hostSite(hostname) {
  const host = String(hostname || '').toLowerCase().replace(/\.$/, '')
  if (!host || host.includes(':') || host.startsWith('[') || /^\d+(?:\.\d+){3}$/.test(host) || !host.includes('.')) return null
  const labels = host.split('.')
  const keep = MULTI_LABEL_SUFFIXES.has(labels.slice(-2).join('.')) ? 3 : 2
  return labels.length >= keep ? labels.slice(-keep).join('.') : null
}
export function sameSiteNavigation(fromUrl, toUrl) {
  let from, to
  try { from = new URL(fromUrl); to = new URL(toUrl) } catch { return false }
  if (![from, to].every(url => ['http:', 'https:'].includes(url.protocol))) return false
  if (from.protocol === 'https:' && to.protocol === 'http:') return false
  const fromSite = hostSite(from.hostname)
  const toSite = hostSite(to.hostname)
  // IP, single-label and public-suffix hosts are scoped to their exact origin.
  if (!fromSite || !toSite) return from.origin === to.origin
  return fromSite === toSite
}
// Mirrors EGDeskBrowserAgentRuntimeChild compact, fingerprint and boundedValue
// byte for byte, so a long or hidden observed value can be compared with the
// value the model expects. The fingerprint notices change; it is not a
// security hash.
function compact(value, max) {
  const text = String(value || '').replace(/\s+/g, ' ').trim()
  return text.length > max ? `${text.slice(0, max - 3).trimEnd()}...` : text
}
function fingerprint(text) {
  let h1 = 0xdeadbeef, h2 = 0x41c6ce57
  for (let index = 0; index < text.length; index++) {
    const code = text.charCodeAt(index)
    h1 = Math.imul(h1 ^ code, 2654435761)
    h2 = Math.imul(h2 ^ code, 1597334677)
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909)
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909)
  return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(16).padStart(14, '0')
}
export function boundedFieldValue(raw, { editor = false } = {}) {
  const text = String(raw ?? '')
  const size = text.length > MAX_FILL_TEXT ? `over ${MAX_FILL_TEXT} chars` : `${text.length} chars, #${fingerprint(text)}`
  if (editor) return text ? `[editor text hidden: ${size}]` : '[editor text hidden: empty]'
  return text.length <= OBSERVED_VALUE_MAX ? compact(text, OBSERVED_VALUE_MAX) : `${compact(text, 96)} [${size}]`
}
function targetValueMatches(observed, expected) {
  return observed === expected || (typeof observed === 'string' && (
    (expected.length > OBSERVED_VALUE_MAX && observed === boundedFieldValue(expected)) ||
    observed === boundedFieldValue(expected, { editor: true })))
}
function validPostcondition(condition, maxValue = 512) {
  return record(condition) && ['visible-text', 'url', 'target-value'].includes(condition.kind) &&
    typeof condition.value === 'string' && condition.value.length <= maxValue &&
    (condition.kind === 'target-value' || !!condition.value) &&
    (condition.kind !== 'url' || safeUrl(condition.value)) &&
    Object.keys(condition).every(key => ['kind', 'value'].includes(key))
}
function validTarget(args) {
  return short(args.ref, 160) && record(args.expectedTarget) && args.expectedTarget.ref === args.ref &&
    Object.keys(args.expectedTarget).every(key => ['ref', 'role', 'label', 'href', 'value', 'tag', 'disabled', 'bounds'].includes(key)) &&
    ['ref', 'role', 'label', 'href', 'value', 'tag'].every(key => typeof args.expectedTarget[key] === 'string')
}
function validScroll(value) {
  return record(value) && ['x', 'y', 'maxY'].every(key => Number.isSafeInteger(value[key]) && value[key] >= 0)
}
// The observed scroll offsets of one listed scroll container, or null.
function scrollContainerOf(snapshot, ref) {
  const entry = Array.isArray(snapshot?.scrollContainers) ? snapshot.scrollContainers.find(item => item?.ref === ref) : null
  return entry && validScroll(entry) ? { x: entry.x, y: entry.y, maxY: entry.maxY } : null
}
function validContainerScroll(value) {
  return record(value) && validScroll(value.before) && validScroll(value.after)
}
// Collapsed like the actor collapses page text; 1-200 characters.
function waitNeedle(value) {
  if (typeof value !== 'string' || value.length > 2000) return null
  const text = value.replace(/\s+/g, ' ').trim()
  return text && text.length <= MAX_WAIT_TEXT ? text : null
}
// A page dialog the UI saw while the action ran (type only, never its text).
function dialogOf(value) {
  return record(value) && DIALOG_TYPES.has(value.type) ? { type: value.type } : null
}
// What covered a refused click: the actor's structural description (tag,
// id, classes, role, ref), from the structured field or its fixed message.
const OBSCURED_PATTERN = /target (?:is|became) obscured(?: before click)? by ([A-Za-z0-9 #._=:/-]{1,160}); observe again/
function obscuredByOf(response) {
  const value = typeof response?.obscuredBy === 'string' ? response.obscuredBy
    : OBSCURED_PATTERN.exec(String(response?.error || ''))?.[1]
  return typeof value === 'string' && /^[A-Za-z0-9 #._=:/-]{1,160}$/.test(value) ? value : null
}
function validateArgs(tool, args) {
  const schema = SPEC_BY_NAME.get(tool)?.inputSchema
  if (!schema || !record(args)) reject('INVALID_BROWSER_TOOL', 'Unsupported Browser tool or argument object')
  if (Object.keys(args).some(key => !Object.hasOwn(schema.properties, key)) ||
      schema.required.some(key => !Object.hasOwn(args, key))) reject('INVALID_BROWSER_TOOL', 'Invalid Browser tool arguments')
  if (!short(args.cardId, 160)) reject('INVALID_BROWSER_TOOL', 'cardId is required')
  if (['egdesk_browser_observe', 'egdesk_browser_list_cards', 'egdesk_browser_close_card', 'egdesk_browser_screenshot'].includes(tool)) return
  if (tool === 'egdesk_browser_request_site') {
    if (!sitePatternsFromInput(args.site).ok) reject('INVALID_BROWSER_TOOL', 'Site request needs a host or http(s) URL')
    return
  }
  if (tool === 'egdesk_browser_open_card') {
    if (!safeUrl(args.url)) reject('INVALID_BROWSER_TOOL', 'Open Card requires an explicit safe http(s) URL')
    return
  }
  if (tool === 'egdesk_browser_wait_text') {
    const wanted = Object.hasOwn(args, 'text') ? args.text : args.textGone
    if (Object.hasOwn(args, 'text') === Object.hasOwn(args, 'textGone') || !waitNeedle(wanted) ||
        !Number.isSafeInteger(args.timeoutMs) || args.timeoutMs < 100 || args.timeoutMs > MAX_WAIT_MS) {
      reject('INVALID_BROWSER_TOOL', 'Wait for text requires exactly one of text or textGone (1-200 characters) and a 100-10000 ms timeout')
    }
    return
  }
  if (tool === 'egdesk_browser_wait') {
    const byRef = args.for === 'selector-visible'
    if (!WAIT_CONDITIONS.includes(args.for) || !Number.isSafeInteger(args.timeoutMs) ||
        args.timeoutMs < 100 || args.timeoutMs > MAX_WAIT_MS ||
        (byRef ? !short(args.ref, 160) || !short(args.observationId, 160)
          : Object.hasOwn(args, 'ref') || Object.hasOwn(args, 'observationId'))) {
      reject('INVALID_BROWSER_TOOL', 'Wait requires a known condition, a 100-10000 ms timeout and, for selector-visible only, an observed ref')
    }
    return
  }
  if (!short(args.observationId, 160) || !Number.isSafeInteger(args.expectedRevision) || args.expectedRevision < 0) {
    reject('INVALID_BROWSER_TOOL', 'Fresh observation and postcondition are required')
  }
  if (tool === 'egdesk_browser_history') {
    if (!HISTORY_ACTIONS.includes(args.action)) reject('INVALID_BROWSER_TOOL', 'History requires back, forward or reload')
    return
  }
  if (tool === 'egdesk_browser_scroll') {
    // Schema unchanged: direction alone scrolls the document, ref alone brings
    // that element into view, ref with direction scrolls inside that observed
    // scroll container (BRW-08).
    const byRef = Object.hasOwn(args, 'ref'), byDirection = Object.hasOwn(args, 'direction')
    const amountOk = !Object.hasOwn(args, 'amount') || SCROLL_AMOUNTS.includes(args.amount)
    if ((!byRef && !byDirection) ||
        (byRef ? !validTarget(args) || (byDirection ? !SCROLL_DIRECTIONS.includes(args.direction) || !amountOk
          : Object.hasOwn(args, 'amount'))
          : !SCROLL_DIRECTIONS.includes(args.direction) || Object.hasOwn(args, 'expectedTarget') || !amountOk)) {
      reject('INVALID_BROWSER_TOOL', 'Scroll requires a direction, one exact observed element, or an observed scroll container with a direction')
    }
    return
  }
  if (tool === 'egdesk_browser_press') {
    if (!validTarget(args)) reject('INVALID_BROWSER_TOOL', 'An exact observed element precondition is required')
    if (!PRESS_KEYS.includes(args.key) || (Object.hasOwn(args, 'postcondition')
      ? !validPostcondition(args.postcondition) : ACTIVATION_KEYS.has(args.key))) {
      reject('INVALID_BROWSER_TOOL', 'Press requires a guarded key; Enter and Space require a testable postcondition')
    }
    return
  }
  if (!validPostcondition(args.postcondition, ['egdesk_browser_fill', 'egdesk_browser_type'].includes(tool) ? MAX_FILL_TEXT : 512)) {
    reject('INVALID_BROWSER_TOOL', 'Fresh observation and postcondition are required')
  }
  if (tool === 'egdesk_browser_navigate') {
    if (!safeUrl(args.url) || args.postcondition.kind !== 'url') reject('INVALID_BROWSER_TOOL', 'Navigation requires an explicit safe URL and URL postcondition')
    return
  }
  if (!validTarget(args)) reject('INVALID_BROWSER_TOOL', 'An exact observed element precondition is required')
  if (tool === 'egdesk_browser_fill' && (typeof args.text !== 'string' || args.text.length > MAX_FILL_TEXT ||
      args.postcondition.kind !== 'target-value' ||
      JSON.stringify(args.text).length + JSON.stringify(args.postcondition.value).length > MAX_FILL_REQUEST_JSON)) {
    reject('INVALID_BROWSER_TOOL', 'Fill requires text up to 8000 characters and a target-value postcondition')
  }
  if (tool === 'egdesk_browser_type' && (typeof args.text !== 'string' || args.text.length > MAX_FILL_TEXT ||
      (Object.hasOwn(args, 'key') && !PRESS_KEYS.includes(args.key)) || (!args.text && !Object.hasOwn(args, 'key')) ||
      JSON.stringify(args.text).length + JSON.stringify(args.postcondition.value).length > MAX_FILL_REQUEST_JSON)) {
    reject('INVALID_BROWSER_TOOL', 'Type requires text up to 8000 characters (or a guarded key) and a postcondition')
  }
}
function sameClickScope(left, right) {
  return ['documentId', 'url', 'revision', 'innerWindowId', 'browsingContextId']
    .every(key => left[key] === right[key])
}
// BRW-10 (D-B4): a bounded actor report, not proof that a click had no
// delayed, unobserved or external effect. Hitting the cap is not quiet.
function clickHadNoEffect(observed, after, observation) {
  const settle = observation?.settle
  return sameClickScope(observed, after) && observation?.visibleTextChanged === false &&
    !['urlChanged', 'titleChanged', 'focusedElementChanged', 'interactiveChanged'].some(key => observation[key] === true) &&
    record(settle) && settle.endedBy === 'quiet' && settle.domChanges === 0 &&
    Array.isArray(settle.requests) && settle.requests.length === 0 &&
    (!Object.hasOwn(settle, 'moreRequests') || settle.moreRequests === 0)
}
const POINTER_API_ROUTES = new Set(['synthesizeMouseEvent', 'sendMouseEvent', 'sendMouseEventToWindow'])
// The tools the action classifier gates, as for click (D-B3 policy hook).
const GATED_TOOLS = new Set(['egdesk_browser_click', 'egdesk_browser_pointer_click', 'egdesk_browser_type'])
function validSnapshot(snapshot, cardId) {
  return record(snapshot) && snapshot.cardId === cardId &&
    short(snapshot.documentId, 160) && Number.isSafeInteger(snapshot.revision) &&
    record(snapshot.viewport) && Number.isFinite(snapshot.viewport.width) && Number.isFinite(snapshot.viewport.height) &&
    Number.isFinite(snapshot.viewport.devicePixelRatio) && snapshot.viewport.devicePixelRatio > 0 &&
    typeof snapshot.url === 'string' && Array.isArray(snapshot.interactiveElements) && Array.isArray(snapshot.text)
}
function observationFrom(response, cardId) {
  const snapshot = response?.snapshot
  if (response?.status !== 'observed' || !validSnapshot(snapshot, cardId)) {
    reject('BROWSER_OBSERVATION_UNAVAILABLE', 'The selected Browser did not return a verifiable observation')
  }
  return snapshot
}
// The actor's screenshot field: a withheld capture with its reason, or a
// bounded JPEG/PNG data URL with its size, scale and covered boxes.
function validScreenshot(value) {
  if (!record(value)) return false
  if (value.send === false) return short(value.reason, 80)
  const box = bounds => record(bounds) && ['x', 'y', 'width', 'height'].every(key => Number.isSafeInteger(bounds[key]) && bounds[key] >= 0)
  return value.send === true && typeof value.imageUrl === 'string' && value.imageUrl.length <= SCREENSHOT_BUDGET_CHARS &&
    /^data:image\/(?:jpeg|png);base64,[A-Za-z0-9+/]+=*$/.test(value.imageUrl) &&
    ['jpeg', 'png'].includes(value.format) && Number.isSafeInteger(value.width) && value.width > 0 &&
    Number.isSafeInteger(value.height) && value.height > 0 && Number.isFinite(value.imageScale) && value.imageScale > 0 &&
    Array.isArray(value.maskedRegions) && value.maskedRegions.length <= 60 &&
    Number.isSafeInteger(value.maskCount) && value.maskCount >= value.maskedRegions.length &&
    (!Object.hasOwn(value, 'maskedRegionsTruncated') || value.maskedRegionsTruncated === true) &&
    value.maskedRegions.every(region => record(region) && short(region.kind, 40) && short(region.reason, 40) && box(region.bounds))
}
function checkPostcondition(condition, snapshot, ref) {
  if (!snapshot || !condition) return false
  if (condition.kind === 'url') return sameUrl(snapshot.url, condition.value)
  if (condition.kind === 'visible-text') return snapshot.text.some(text => String(text).includes(condition.value))
  if (condition.kind === 'target-value') return snapshot.interactiveElements.some(item => item.ref === ref &&
    targetValueMatches(item.value, condition.value))
  return false
}
// true/false from observed bounds, null when the element is not in the bounded list.
function elementInView(snapshot, ref) {
  const bounds = snapshot?.interactiveElements?.find(item => item.ref === ref)?.bounds
  if (!record(bounds) || !['x', 'y', 'width', 'height'].every(key => Number.isFinite(bounds[key]))) return null
  const { width, height } = snapshot.viewport
  return bounds.width > 0 && bounds.height > 0 && bounds.x < width && bounds.y < height &&
    bounds.x + bounds.width > 0 && bounds.y + bounds.height > 0
}
function withoutWait(snapshot) {
  if (!record(snapshot)) return snapshot
  const { wait, ...rest } = snapshot
  return rest
}
function uiTiming(value) {
  if (!record(value)) return {}
  return Object.fromEntries([
    ...UI_TIMING_MS.filter(key => Number.isFinite(value[key]) && value[key] >= 0),
    ...UI_TIMING_COUNTS.filter(key => Number.isSafeInteger(value[key]) && value[key] >= 0),
  ].map(key => [key, value[key]]))
}
// EGQ8: only an explicit, uncontradicted refusal before input frees the Card.
// 'dispatched', 'unknown', a missing or malformed phase, any sign that the
// actor entered perform, or a partial perform count keeps the outcome unknown (EG-01).
function noPerformEvidence(timing = {}) {
  if (!record(timing)) return false
  const counts = [timing.performCallsBefore, timing.performCallsAfter]
  return ['performEnterMs', 'performExitMs', 'firstEventAtMs'].every(key => timing[key] == null) &&
    (counts.every(count => count === undefined) ||
      (Number.isSafeInteger(counts[0]) && counts[0] >= 0 && counts[1] === counts[0]))
}
function provenNotDispatched(response) {
  return response.status === 'rejected' && response.dispatchPhase === 'not-dispatched' &&
    response.receipt?.dispatchReceipt?.eventDispatched !== true && noPerformEvidence(response.timing)
}

// D-B1: the conversation's navigation rule as the UI reports it beside a bind,
// observe, open-card or allow-site answer (same site plus the sites the person
// allowed). An unreadable or widened policy is ignored; the default is today's
// same-site rule, so the helper never grants more than the UI proved.
function adoptNavigationPolicy(binding, response) {
  if (!record(response) || !Object.hasOwn(response, 'navigationPolicy')) return
  const normalized = normalizeNavigationPolicy(response.navigationPolicy)
  if (normalized.ok && normalized.policy.scope === 'same-site' && !normalized.policy.allowDowngrade) { binding.navigationPolicy = normalized.policy; holdVouchedSites(binding) }
}
// u10: a site the Card itself answered 'site-allowed' for, in THIS run, stays in the helper's copy of the policy even when a later policy the Card sends does not list it (the Card re-checks every navigation,
// history move and new Card against its own set; the helper's copy only decides whether to send the request). A block rule still wins (evaluateNavigation checks the block list first).
function holdVouchedSites(binding) {
  if (!binding.vouchedSites?.size) return
  const policy = binding.navigationPolicy || DEFAULT_NAVIGATION_POLICY
  const merged = normalizeNavigationPolicy({ scope: policy.scope, allow: [...new Set([...policy.allow, ...binding.vouchedSites])], block: [...policy.block], allowDowngrade: false })
  if (merged.ok) binding.navigationPolicy = merged.policy
}
function navigationDecision(binding, fromUrl, url) {
  return evaluateNavigation(url, binding.navigationPolicy || DEFAULT_NAVIGATION_POLICY, { fromUrl, layer: 'tool' })
}
function rejectNavigation(decision) {
  throw Object.assign(new Error('Navigation is limited to http(s) pages on the current site or a site this conversation allowed; ask with egdesk_browser_request_site'),
    { code: 'BROWSER_NAVIGATE_OUT_OF_SCOPE', navigation: { reason: decision.reason, ...(decision.host ? { host: decision.host } : {}) } })
}
function cardSummary(binding) {
  return [...binding.cards.values()].map(card => ({ cardId: card.cardId, permission: card.permission,
    url: card.observation?.snapshot?.url ?? card.ui?.url ?? null, openedByAgent: card.openedByAgent === true,
    ...(card.openedFrom ? { openedFrom: card.openedFrom } : {}) }))
}

export function createBrowserToolService({ sendToUi, getOwnerKey, ownerKeyFor = () => getOwnerKey(), timeoutMs = 15000, now = Date.now, clock = sameClock,
  actionGatePolicy = CURRENT_ACTION_GATE_POLICY } = {}) {
  if (typeof sendToUi !== 'function' || typeof getOwnerKey !== 'function' || typeof clock !== 'function' ||
      !Number.isSafeInteger(timeoutMs) || timeoutMs < 1000 || timeoutMs > 60000) {
    throw new TypeError('Browser tool service requires UI transport, current account provider and bounded timeout')
  }
  const bindings = new Map()
  const pendingBindings = new Map()
  const closedRuns = new Set()
  const preparedRuns = new WeakSet()

  // Spend eligibility across the run before sending a state-changing request.
  // A delayed reply must not mint or restore it across a later dispatch.
  function beginMutation(binding) {
    binding.mutationGeneration = (binding.mutationGeneration || 0) + 1
    for (const card of binding.cards.values()) card.noEffectClick = null
    return binding.mutationGeneration
  }

  function narrowPointerFallback(card, snapshot) {
    if (card.noEffectClick && !sameClickScope(card.noEffectClick.scope, snapshot)) card.noEffectClick = null
  }

  function cancelCards(binding) {
    return Promise.allSettled(binding.selectedCards.map(card => requestUi({ kind: 'cancel',
      runId: binding.runId, clientThreadId: binding.clientThreadId, cardId: card.cardId,
      cardEpoch: card.cardEpoch, selectionToken: card.selectionToken,
    }, binding)))
  }

  // trace receives this request's same-clock record: seq and sentAtMs at
  // handoff, then responseAtMs plus the UI/actor timing, or timedOutAtMs.
  // budgetMs is the same deadline as a relative budget, so Firefox can spend
  // it on its own monotonic clock (REA 웹8, BRW-12).
  async function requestUi(payload, binding, run, trace = {}, { budgetMs = timeoutMs } = {}) {
    // c34 (flag EGDESK_TERMINAL_OPEN_URL): a card showing an AI provider's sign-in or account page, and any request to go to one, is opaque to the Agent (no observe, screenshot, click, fill, navigate, open)
    if (payload.kind !== 'cancel' && authOpaqueOn() && (isAuthOpaqueUrl(payload.binding?.url) || isAuthOpaqueUrl(payload.url) || isAuthOpaqueUrl(payload.action?.url))) reject('BROWSER_CARD_OPAQUE', 'This Browser Card shows a sign-in page of an AI service. The person signs in themselves; EG-Desk does not observe or operate it')
    const requestId = randomUUID()
    const targetCardEpoch = payload.selection?.cardEpoch || payload.binding?.cardEpoch || payload.cardEpoch
    if (!short(targetCardEpoch, 160)) reject('BROWSER_UI_PROTOCOL', 'Browser request has no exact Card generation')
    let timer
    try {
      const response = await Promise.race([
        Promise.resolve().then(() => {
          if (payload.kind !== 'cancel' && (!binding || binding.closed || closedRuns.has(run?.answerId) ||
              binding.ownerKey !== ownerNow(binding) || run?.status !== 'inProgress')) {
            reject('BROWSER_RUN_ENDED', 'Browser run or account ended before UI dispatch')
          }
          // Allocated at the actual handoff (open-browser-use moveSequence),
          // so the run's seq rises with every request that left the helper.
          if (binding) trace.seq = binding.seq = (binding.seq || 0) + 1
          trace.sentAtMs = clock()
          return sendToUi({ version: 1, requestId, targetCardEpoch,
            deadlineMs: now() + budgetMs, budgetMs, ...payload, ...(binding ? { seq: trace.seq } : {}), sentAtMs: trace.sentAtMs })
        }),
        new Promise((_, rejectTimeout) => { timer = setTimeout(() => rejectTimeout(Object.assign(new Error('Browser UI response timed out; outcome is unknown'), { code: 'BROWSER_UI_TIMEOUT' })), budgetMs) }),
      ])
      trace.responseAtMs = clock()
      if (!record(response) || response.requestId !== requestId) reject('BROWSER_UI_PROTOCOL', 'Browser UI response does not match this request')
      if (JSON.stringify(response).length > 180000) reject('BROWSER_UI_PROTOCOL', 'Browser UI response exceeded the bounded limit')
      Object.assign(trace, uiTiming(response.timing))
      return response
    } catch (error) {
      // A timeout is neither "no effect" nor "cancelled" (REA T-03); it only
      // records when the helper stopped waiting.
      if (error?.code === 'BROWSER_UI_TIMEOUT' && Object.hasOwn(trace, 'sentAtMs')) trace.timedOutAtMs = clock()
      if (record(error) && Object.hasOwn(trace, 'sentAtMs')) error.timing = { ...trace }
      throw error
    } finally { clearTimeout(timer) }
  }

  // L1 c24 (owner decision U11): the account a Browser grant is bound to is the account of the slot running the room. `ownerKeyFor(engineProfileId)` answers the
  // room's own account when the room-account flag is on and the room is on an Agent profile; otherwise (and by default) the default sign-in, as before.
  // The binding remembers its slot, so every later check compares with THAT account.
  const ownerNow = item => ownerKeyFor(item?.engineProfileId)
  function prepare({ selectedSources = [], engineProfileId, ownerKey = ownerKeyFor(engineProfileId) } = {}) {
    if (Array.isArray(selectedSources) && selectedSources.length === 0) return null
    if (!short(ownerKey, 256) || ownerKey !== ownerKeyFor(engineProfileId)) reject('BROWSER_OWNER_REQUIRED', 'Current Engine account must be known and unchanged')
    if (!Array.isArray(selectedSources) || selectedSources.length > 4) reject('INVALID_BROWSER_SELECTION', 'Select at most four Browser Cards')
    const cards = new Map()
    for (const source of selectedSources) {
      const ref = source?.sourceRef
      const identity = source?.browserToolIdentity
      const selection = source?.browserToolSelection
      if (source?.kind !== 'browser' || !short(source.id, 160) || source.selectedByUser !== true ||
          !['observe', 'interact'].includes(source.browserToolPermission) || !record(ref) ||
          !short(ref.viewId, 160) || !short(ref.profileId, 160) || typeof ref.accountId !== 'string' ||
          ref.accountId.length > 160 || !short(ref.uri, 2048) || cards.has(ref.viewId) ||
          !record(identity) || !short(identity.cardEpoch, 160) || !short(identity.engineAccountKey, 256) ||
          !Number.isSafeInteger(identity.authorityEpoch) || !Number.isSafeInteger(identity.userContextId) ||
          !record(selection) || !short(selection.token, 160) || !short(selection.threadId, 160)) {
        reject('INVALID_BROWSER_SELECTION', 'Browser tool source must be explicitly selected with a bound Card, profile and permission')
      }
      cards.set(ref.viewId, { cardId: ref.viewId, profileId: ref.profileId, accountId: ref.accountId,
        selectedUrl: ref.uri, permission: source.browserToolPermission,
        selectionToken: selection.token, clientThreadId: selection.threadId, sourceId: source.id, ...identity })
    }
    const value = { ownerKey, ...(engineProfileId ? { engineProfileId } : {}), cards, preparedAt: now() }
    preparedRuns.add(value)
    return value
  }

  function specs(prepared = null) {
    if (!prepared || !preparedRuns.has(prepared)) return []
    const permissions = [...prepared.cards.values()].map(card => card.permission)
    if (!permissions.length) return []
    return permissions.includes('interact') ? BROWSER_TOOL_SPECS : BROWSER_TOOL_SPECS.filter(item => READ_TOOLS.has(item.name))
  }

  async function bind(run, prepared) {
    if (!short(run?.answerId, 160) || !short(run?.clientThreadId, 160) ||
        !preparedRuns.has(prepared) || prepared.ownerKey !== ownerNow(prepared)) reject('BROWSER_BINDING_FORBIDDEN', 'Browser run binding is unavailable for this account')
    if (closedRuns.has(run.answerId)) reject('BROWSER_RUN_ENDED', 'Cancelled Browser run cannot be rebound')
    if (bindings.has(run.answerId) || pendingBindings.has(run.answerId)) reject('BROWSER_BINDING_EXISTS', 'Browser run is already bound or binding')
    const binding = { ownerKey: prepared.ownerKey, ...(prepared.engineProfileId ? { engineProfileId: prepared.engineProfileId } : {}), runId: run.runId || run.answerId,
      clientThreadId: run.clientThreadId, selectedCards: [...prepared.cards.values()],
      cards: new Map(), pending: new Set(), calls: new Map(), closed: false, seq: 0,
      navigationPolicy: DEFAULT_NAVIGATION_POLICY, refusedSites: new Set() }
    pendingBindings.set(run.answerId, binding)
    try {
      for (const card of prepared.cards.values()) {
        if (binding.closed || closedRuns.has(run.answerId) || prepared.ownerKey !== ownerNow(prepared) || run.status !== 'inProgress') {
          reject('BROWSER_RUN_ENDED', 'Browser run or account ended during binding')
        }
        if (card.clientThreadId !== binding.clientThreadId) reject('BROWSER_BINDING_FORBIDDEN', 'Browser selection belongs to another Chat thread')
        const response = await requestUi({ kind: 'bind', runId: binding.runId,
          clientThreadId: binding.clientThreadId, cardId: card.cardId, selection: card }, binding, run)
        if (response.status !== 'bound' || !record(response.binding) || response.binding.cardId !== card.cardId ||
            response.binding.profileId !== card.profileId || response.binding.accountId !== card.accountId ||
            !short(response.binding.cardEpoch, 160) || !Number.isSafeInteger(response.binding.userContextId) ||
            !sameUrl(response.binding.url, card.selectedUrl) || response.binding.cardEpoch !== card.cardEpoch ||
            response.binding.userContextId !== card.userContextId ||
            response.binding.engineAccountKey !== card.engineAccountKey ||
            response.binding.authorityEpoch !== card.authorityEpoch) reject('BROWSER_BINDING_STALE', 'Selected Browser identity changed before binding')
        if (binding.closed || closedRuns.has(run.answerId) || run.status !== 'inProgress') reject('BROWSER_RUN_ENDED', 'Browser run ended during binding')
        if (prepared.ownerKey !== ownerNow(prepared)) reject('BROWSER_OWNER_CHANGED', 'Engine account changed during Browser binding')
        adoptNavigationPolicy(binding, response)
        binding.cards.set(card.cardId, { ...card, ui: response.binding, observation: null,
          busy: false, uncertain: false, uncertainAction: null, pendingTransition: null, lastFill: null, noEffectClick: null })
      }
      if (binding.closed || closedRuns.has(run.answerId) || prepared.ownerKey !== ownerNow(prepared) || run.status !== 'inProgress') {
        reject('BROWSER_RUN_ENDED', 'Browser run or account ended before binding completed')
      }
      bindings.set(run.answerId, binding)
      return { cards: [...binding.cards.values()].map(({ cardId, profileId, accountId, permission, ui }) =>
        ({ cardId, profileId, accountId, permission, userContextId: ui.userContextId, accountStatus: ui.accountStatus || 'unverified' })) }
    } catch (error) {
      // Cancel even the card whose bind response was lost; UI tombstones the
      // run/Card key so a delayed bind cannot resurrect authority.
      binding.closed = true
      closedRuns.add(run.answerId)
      await cancelCards(binding)
      throw error
    } finally {
      if (pendingBindings.get(run.answerId) === binding) pendingBindings.delete(run.answerId)
    }
  }

  // C9: hand a live binding from one run object to another (the pre-turn binding of the direct browser entry becomes the
  // turn's run once the native turn exists). The UI keeps seeing the original runId (binding.runId); only the helper's key
  // changes. Same owner and Chat thread are required; a closed or unknown binding is refused.
  function adopt(fromRun, toRun) {
    const binding = bindings.get(fromRun?.answerId)
    if (!binding || binding.closed || closedRuns.has(fromRun.answerId) || !short(toRun?.answerId, 160) || !short(toRun?.clientThreadId, 160) ||
        bindings.has(toRun.answerId) || pendingBindings.has(toRun.answerId) || closedRuns.has(toRun.answerId) ||
        binding.clientThreadId !== toRun.clientThreadId || binding.ownerKey !== ownerNow(binding)) {
      reject('BROWSER_BINDING_FORBIDDEN', 'Browser binding cannot move to this run')
    }
    bindings.delete(fromRun.answerId)
    bindings.set(toRun.answerId, binding)
    return { cards: [...binding.cards.values()].map(({ cardId, profileId, accountId, permission, ui }) =>
      ({ cardId, profileId, accountId, permission, userContextId: ui.userContextId, accountStatus: ui.accountStatus || 'unverified' })) }
  }

  // Observation and wait both replace the Card's single fresh observation.
  // A pending document transition is resolved only by a new document whose
  // readback satisfies the original postcondition.
  function recordObservation(card, snapshot) {
    const transition = card.pendingTransition
    const transitionRecovered = !!(transition &&
      snapshot.documentId !== transition.priorDocumentId &&
      ['interactive', 'complete'].includes(snapshot.readyState) &&
      !transition.wasAlreadyTrue && (checkPostcondition(transition.condition, snapshot, transition.ref) ||
        (transition.typedGet && formResultLanded(snapshot.url, transition.condition.value))))
    if (transitionRecovered) { card.uncertain = false; card.uncertainAction = null; card.pendingTransition = null }
    if (card.lastFill && card.lastFill.documentId !== snapshot.documentId) card.lastFill = null
    narrowPointerFallback(card, snapshot)
    card.observation = { id: randomUUID(), snapshot }
    return { navigationPostconditionReobserved: transitionRecovered && transition.actionType === 'navigate',
      documentTransitionPostconditionReobserved: transitionRecovered,
      // While the Card stays locked, the observation repeats the unknown
      // action's same-clock record so a late effect can be dated against it.
      ...(card.uncertain && card.uncertainAction ? { uncertainAction: card.uncertainAction } : {}) }
  }

  async function observeRequest(run, binding, card, options, trace) {
    card.busy = true
    const pending = requestUi({ kind: 'observe', runId: binding.runId,
      clientThreadId: binding.clientThreadId, cardId: card.cardId, binding: card.ui, options }, binding, run, trace)
    binding.pending.add(pending)
    try { return await pending } finally { binding.pending.delete(pending); card.busy = false }
  }

  // Wait is read-only: it never takes an action lease and never marks the
  // Card uncertain. Its answer is met, not met before timeout, or unknown.
  async function waitForCondition(run, binding, card, args) {
    if (args.timeoutMs + WAIT_RESPONSE_MARGIN_MS > timeoutMs) reject('INVALID_BROWSER_TOOL', 'Wait timeout exceeds the bounded Browser request budget')
    let documentId = null
    if (args.for === 'selector-visible') {
      const observed = card.observation
      if (!observed || observed.id !== args.observationId) reject('BROWSER_OBSERVATION_STALE', 'Observe this Browser Card again before waiting for an element')
      if (!observed.snapshot.interactiveElements.some(item => item.ref === args.ref)) reject('BROWSER_TARGET_STALE', 'Wait target is not in the observed element list')
      documentId = observed.snapshot.documentId
    }
    const transition = card.pendingTransition
    const wait = { for: args.for, timeoutMs: args.timeoutMs,
      ...(documentId ? { ref: args.ref, documentId } : {}),
      // While a dispatched transition is pending, the prior document cannot
      // satisfy load/idle. For navigation, chrome can wait for the replacement
      // WindowGlobal before sending the document-scoped actor query.
      ...(transition ? { notDocumentId: transition.priorDocumentId } : {}),
      ...(args.for === 'load' && transition?.priorInnerWindowId ? { notInnerWindowId: transition.priorInnerWindowId } : {}) }
    // A wait spends the current observation: the page is expected to change.
    card.observation = null
    const trace = {}
    const response = await observeRequest(run, binding, card, { textLimit: 60, elementLimit: 80, wait }, trace)
    if (binding.closed || binding.ownerKey !== ownerNow(binding)) reject('BROWSER_RUN_ENDED', 'Browser run ended during wait')
    const reported = response?.snapshot?.wait
    let snapshot
    try { snapshot = observationFrom({ ...response, snapshot: withoutWait(response?.snapshot) }, card.cardId) }
    catch { reject('BROWSER_WAIT_OUTCOME_UNKNOWN', 'Wait ended without a verifiable observation; observe again before acting') }
    if (!record(reported) || reported.for !== args.for || !['met', 'timeout'].includes(reported.outcome) ||
        !Number.isSafeInteger(reported.elapsedMs) || reported.elapsedMs < 0) {
      reject('BROWSER_WAIT_OUTCOME_UNKNOWN', 'Wait ended without a verifiable observation; observe again before acting')
    }
    // The helper re-checks what the returned observation can prove.
    const consistent = (args.for === 'selector-visible' || snapshot.readyState === 'complete') &&
      (!wait.notDocumentId || snapshot.documentId !== wait.notDocumentId) &&
      (!documentId || snapshot.documentId === documentId)
    const status = reported.outcome === 'timeout' ? 'wait-timeout' : consistent ? 'wait-condition-met' : 'wait-condition-unverified'
    const recovery = recordObservation(card, snapshot)
    return { status, cardId: card.cardId, action: 'wait', observationId: card.observation.id, snapshot,
      wait: { for: args.for, timeoutMs: args.timeoutMs, elapsedMs: reported.elapsedMs,
        outcome: status === 'wait-condition-met' ? 'met' : status === 'wait-timeout' ? 'not-met-before-timeout' : 'unverified',
        documentReplaced: !!wait.notDocumentId && snapshot.documentId !== wait.notDocumentId },
      ...recovery, timing: { ...trace }, externalEffectVerified: false }
  }

  // egdesk_browser_wait_text: read-only like wait, allowed with an observe
  // grant. The text goes to the actor as a wait option and is never echoed
  // back in the result; the result says met, not met in time, or unverified.
  async function waitForText(run, binding, card, args) {
    if (args.timeoutMs + WAIT_RESPONSE_MARGIN_MS > timeoutMs) reject('INVALID_BROWSER_TOOL', 'Wait timeout exceeds the bounded Browser request budget')
    const gone = Object.hasOwn(args, 'textGone')
    const needle = waitNeedle(gone ? args.textGone : args.text)
    const condition = gone ? 'text-gone' : 'text'
    const transition = card.pendingTransition
    const wait = { for: condition, text: needle, timeoutMs: args.timeoutMs,
      ...(transition ? { notDocumentId: transition.priorDocumentId } : {}) }
    card.observation = null
    const trace = {}
    const response = await observeRequest(run, binding, card, { textLimit: OBSERVE_TEXT_LIMIT, elementLimit: 80, wait }, trace)
    if (binding.closed || binding.ownerKey !== ownerNow(binding)) reject('BROWSER_RUN_ENDED', 'Browser run ended during wait')
    const reported = response?.snapshot?.wait
    let snapshot
    try { snapshot = observationFrom({ ...response, snapshot: withoutWait(response?.snapshot) }, card.cardId) }
    catch { reject('BROWSER_WAIT_OUTCOME_UNKNOWN', 'Wait ended without a verifiable observation; observe again before acting') }
    if (!record(reported) || reported.for !== condition || !['met', 'timeout'].includes(reported.outcome) ||
        !Number.isSafeInteger(reported.elapsedMs) || reported.elapsedMs < 0 ||
        !Number.isSafeInteger(reported.matchCount) || reported.matchCount < 0) {
      reject('BROWSER_WAIT_OUTCOME_UNKNOWN', 'Wait ended without a verifiable observation; observe again before acting')
    }
    // What the returned (bounded) text can prove: present text is visible in
    // it, unless the list was cut at its limit; gone text is absent from it.
    const seen = snapshot.text.some(text => String(text).replace(/\s+/g, ' ').includes(needle))
    const truncated = snapshot.text.length >= OBSERVE_TEXT_LIMIT
    const consistent = (!wait.notDocumentId || snapshot.documentId !== wait.notDocumentId) && (gone
      ? reported.matchCount === 0 && !seen
      : reported.matchCount > 0 && (seen || truncated))
    const status = reported.outcome === 'timeout' ? 'wait-timeout' : consistent ? 'wait-condition-met' : 'wait-condition-unverified'
    const recovery = recordObservation(card, snapshot)
    return { status, cardId: card.cardId, action: 'wait_text', observationId: card.observation.id, snapshot,
      wait: { for: condition, timeoutMs: args.timeoutMs, elapsedMs: reported.elapsedMs,
        outcome: status === 'wait-condition-met' ? 'met' : status === 'wait-timeout' ? 'not-met-before-timeout' : 'unverified',
        documentReplaced: !!wait.notDocumentId && snapshot.documentId !== wait.notDocumentId },
      ...recovery, timing: { ...trace }, externalEffectVerified: false }
  }

  // One 'reconcile' question: {callId, actRequestId, guard document} ->
  // {entered: true|false|'unknown', fenced, performing}. dispatched false only
  // when the actor answered "never entered" for the observed document and
  // fenced that call, with no perform timing; malformed or missing answers
  // are 'unknown'. Read-only: no lease, never a second action.
  async function reconcileAct(run, binding, card, { callId, actRequestId, guard, actSeq }) {
    const unknown = reason => ({ dispatched: 'unknown', summary: { answered: false, reason } })
    if (binding.closed || closedRuns.has(run?.answerId) || binding.ownerKey !== ownerNow(binding) || run?.status !== 'inProgress') {
      return unknown('run-ended')
    }
    let response
    try {
      response = await requestUi({ kind: 'reconcile', runId: binding.runId, clientThreadId: binding.clientThreadId,
        cardId: card.cardId, binding: card.ui, callId, ...(actRequestId ? { actRequestId } : {}),
        ...(Number.isSafeInteger(actSeq) ? { actSeq } : {}),
        guard: { documentId: guard.documentId,
          ...(Object.hasOwn(guard, 'innerWindowId') ? { innerWindowId: guard.innerWindowId } : {}),
          ...(Object.hasOwn(guard, 'browsingContextId') ? { browsingContextId: guard.browsingContextId } : {}) } },
      binding, run, {}, { budgetMs: Math.min(RECONCILE_TIMEOUT_MS, timeoutMs) })
    } catch { return unknown('no-answer') }
    const answer = response?.reconcile
    const dialog = dialogOf(response?.dialog)
    if (response?.status !== 'reconciled' || !record(answer) ||
        (answer.callId !== callId && !(actRequestId && answer.requestId === actRequestId))) return unknown('unrecognized-answer')
    if (answer.entered === true) {
      return { dispatched: true, ...(dialog ? { dialog } : {}),
        summary: { answered: true, entered: true, performing: answer.performing === true } }
    }
    if (answer.entered === false && answer.fenced === true && answer.documentId === guard.documentId &&
        (answer.performing === undefined || answer.performing === false) && noPerformEvidence(answer.timing) && !response.dialog) {
      return { dispatched: false, summary: { answered: true, entered: false, fenced: true } }
    }
    return unknown(answer.entered === 'unknown' && ['other-document', 'record-evicted'].includes(answer.reason)
      ? answer.reason : 'unproven')
  }

  async function executeDispatch(run, event) {
    const args = event?.arguments
    const tool = event?.tool
    validateArgs(tool, args)
    const binding = bindings.get(run?.answerId)
    if (!binding || binding.closed || closedRuns.has(run?.answerId) || binding.ownerKey !== ownerNow(binding) || run?.status !== 'inProgress') reject('BROWSER_RUN_ENDED', 'Browser tool run or account is no longer active')
    const card = binding.cards.get(args.cardId)
    if (!card) reject('BROWSER_CARD_NOT_SELECTED', 'Browser Card was not selected for this run')
    if (card.busy) reject('BROWSER_CARD_BUSY', 'Wait for the current Browser request to finish')
    if (!READ_TOOLS.has(tool) && card.permission !== 'interact') reject('BROWSER_INTERACTION_NOT_GRANTED', 'Read-only Browser context does not authorize interaction')
    if (tool === 'egdesk_browser_observe') {
      const trace = {}
      const response = await observeRequest(run, binding, card, { textLimit: 60, elementLimit: 80 }, trace)
      if (binding.closed || binding.ownerKey !== ownerNow(binding)) reject('BROWSER_RUN_ENDED', 'Browser run ended during observation')
      const snapshot = observationFrom(response, card.cardId)
      adoptNavigationPolicy(binding, response)
      const recovery = recordObservation(card, snapshot)
      return { status: 'observed', cardId: card.cardId, observationId: card.observation.id,
        snapshot, ...recovery, timing: { ...trace }, externalEffectVerified: false }
    }
    if (tool === 'egdesk_browser_screenshot') {
      // Observe with options.screenshot; the Firefox parent actor captures and
      // covers, the child measures. Not recorded as the Card's observation:
      // pixels never become input coordinates (REA 웹6).
      const trace = {}
      const response = await observeRequest(run, binding, card, SCREENSHOT_OBSERVE_OPTIONS, trace)
      if (binding.closed || binding.ownerKey !== ownerNow(binding)) reject('BROWSER_RUN_ENDED', 'Browser run ended during observation')
      const snapshot = observationFrom(response, card.cardId)
      narrowPointerFallback(card, snapshot)
      if (!validScreenshot(snapshot.screenshot)) reject('BROWSER_OBSERVATION_UNAVAILABLE', 'The selected Browser did not return a verifiable screenshot')
      const { send, ...screenshot } = snapshot.screenshot
      return { status: send ? 'screenshot-observed' : 'screenshot-withheld', cardId: card.cardId,
        documentId: snapshot.documentId, revision: snapshot.revision, url: snapshot.url, viewport: snapshot.viewport,
        screenshot, timing: { ...trace }, externalEffectVerified: false }
    }
    if (tool === 'egdesk_browser_list_cards') {
      return { status: 'cards-listed', cardId: card.cardId, action: 'list_cards', cards: cardSummary(binding), externalEffectVerified: false }
    }
    if (tool === 'egdesk_browser_wait') return waitForCondition(run, binding, card, args)
    if (tool === 'egdesk_browser_wait_text') return waitForText(run, binding, card, args)
    if (tool === 'egdesk_browser_request_site') return requestSite(run, binding, card, args)
    if (tool === 'egdesk_browser_open_card') return openCard(run, binding, card, args)
    if (tool === 'egdesk_browser_close_card') return closeCard(run, binding, card)
    // D-B4: the one exception to the lock is a pointer press on the element
    // whose DOM click was dispatched and changed nothing (checked below).
    const observed = card.observation
    const prior = card.noEffectClick
    const pointerAfterClick = tool === 'egdesk_browser_pointer_click' && prior?.ref === args.ref &&
      (!observed || sameClickScope(prior.scope, observed.snapshot)) && sameTarget(prior.target, args.expectedTarget)
    if (card.uncertain && !(pointerAfterClick && card.uncertainAction?.action === 'click')) {
      reject('BROWSER_OUTCOME_UNKNOWN', 'A prior Browser action has an unknown outcome; select the context again')
    }
    if (!observed || observed.id !== args.observationId || observed.snapshot.revision !== args.expectedRevision) {
      throw Object.assign(new Error('Observe this Browser Card again before acting'), { code: 'BROWSER_OBSERVATION_STALE', staleBy: 'observation' })
    }
    if (tool === 'egdesk_browser_history') return historyMove(run, binding, card, args, observed)
    const byRef = Object.hasOwn(args, 'ref')
    if (byRef) {
      const original = observed.snapshot.interactiveElements.find(item => item.ref === args.ref)
      if (!original || !sameTarget(original, args.expectedTarget) ||
          (tool !== 'egdesk_browser_scroll' && original.disabled)) reject('BROWSER_TARGET_STALE', 'Target precondition does not match the observed element')
      // Same classifier gate for click and the trusted routes; the default
      // policy allows every class (today's grant covers guarded actions).
      if (GATED_TOOLS.has(tool)) {
        const judged = classifyAction({ mode: tool === 'egdesk_browser_type' && args.key === 'Enter' ? 'enter' : 'activate',
          label: original.label, role: original.role, tag: original.tag, url: observed.snapshot.url })
        const gate = actionGate(judged, actionGatePolicy)
        if (gate !== 'allow') {
          throw Object.assign(new Error('This action is the person\'s step or needs their confirmation; nothing was sent'),
            { code: 'BROWSER_ACTION_NEEDS_PERSON', dispatchPhase: 'not-dispatched', dispatched: false,
              actionCategory: judged.category, actionGate: gate })
        }
      }
    }
    // BRW-10 (D-B4): a pointer press only follows a no-effect DOM click on the
    // same ref and scope, from an observation taken after that click.
    let pointerBounds = null
    if (tool === 'egdesk_browser_pointer_click') {
      if (!pointerAfterClick) {
        reject('BROWSER_POINTER_NEEDS_CLICK_FIRST', 'A pointer press is only for an element whose egdesk_browser_click was dispatched and changed nothing; click it first, then observe again')
      }
      if (!validScroll(observed.snapshot.scroll)) reject('BROWSER_OBSERVATION_STALE', 'Observe this Browser Card again; the observation has no scroll position')
      pointerBounds = observed.snapshot.interactiveElements.find(item => item.ref === args.ref)?.bounds
      if (!record(pointerBounds) || !elementInView(observed.snapshot, args.ref)) {
        reject('BROWSER_TARGET_STALE', 'The observed element has no bounds inside the viewport; scroll it into view and observe again')
      }
    }
    if (tool === 'egdesk_browser_type' && (observed.snapshot.focusedElement?.ref || null) !== args.ref) {
      reject('BROWSER_PRESS_TARGET_NOT_FOCUSED', 'Typing needs the observed focused element; EG-Desk never moves focus')
    }
    // D-B1: the current site by default, plus the sites this conversation
    // allowed. An allowed other site is dispatched by EG-Desk chrome, since the
    // page actor only ever navigates within its own site.
    let navigation = null
    if (tool === 'egdesk_browser_navigate') {
      navigation = navigationDecision(binding, observed.snapshot.url, args.url)
      if (!navigation.allowed) rejectNavigation(navigation)
    }
    // The policy names an allow-list hit 'allow-list'; the guard calls that scope 'allowed-site'.
    const navigationScope = navigation?.reason === 'allow-list' ? 'allowed-site' : 'same-site'
    if (tool === 'egdesk_browser_scroll' && !validScroll(observed.snapshot.scroll)) {
      reject('BROWSER_OBSERVATION_STALE', 'Observe this Browser Card again; the observation has no scroll position')
    }
    const containerScroll = tool === 'egdesk_browser_scroll' && byRef && Object.hasOwn(args, 'direction')
    const containerBefore = containerScroll ? scrollContainerOf(observed.snapshot, args.ref) : null
    if (containerScroll && !containerBefore) {
      reject('BROWSER_TARGET_STALE', 'Scroll with a direction inside an element needs an observed scroll container (scrollContainers)')
    }
    // Key input never moves focus: the target must already be focused or be
    // the field this run just filled with a confirmed value.
    let pressPolicy = null
    if (tool === 'egdesk_browser_press') {
      const focusedRef = observed.snapshot.focusedElement?.ref || null
      pressPolicy = focusedRef === args.ref ? 'already-focused'
        : card.lastFill?.ref === args.ref && card.lastFill.documentId === observed.snapshot.documentId ? 'after-fill' : null
      if (!pressPolicy) reject('BROWSER_PRESS_TARGET_NOT_FOCUSED', 'Key input needs the observed focused element or the field just filled; EG-Desk never moves focus')
    }
    // A single observation authorizes at most one dispatch. Unknown outcomes are
    // not retried automatically; the next action requires a new observation.
    card.observation = null
    const previousFill = card.lastFill
    if (!(tool === 'egdesk_browser_press' && card.lastFill?.ref === args.ref)) card.lastFill = null
    // One dispatched press per no-effect click. A proven refusal may restore
    // only the original scope; it never restores the spent observation.
    const eligibility = pointerAfterClick ? prior : null
    const clickLock = eligibility ? { uncertain: card.uncertain, uncertainAction: card.uncertainAction,
      pendingTransition: card.pendingTransition } : null
    card.busy = true
    const action = tool === 'egdesk_browser_navigate' ? { type: 'navigate', url: args.url } :
      tool === 'egdesk_browser_click' ? { type: 'click', ref: args.ref } :
      tool === 'egdesk_browser_fill' ? { type: 'fill', ref: args.ref, text: args.text } :
      tool === 'egdesk_browser_press' ? { type: 'press', ref: args.ref, key: args.key } :
      tool === 'egdesk_browser_pointer_click' ? { type: 'pointer-click', ref: args.ref } :
      tool === 'egdesk_browser_type' ? { type: 'type-text', ref: args.ref, text: args.text,
        ...(Object.hasOwn(args, 'key') ? { key: args.key } : {}) } :
      containerScroll ? { type: 'scroll', ref: args.ref, direction: args.direction, amount: args.amount || 'page' } :
      byRef ? { type: 'scroll', ref: args.ref } : { type: 'scroll', direction: args.direction, amount: args.amount || 'page' }
    const condition = args.postcondition || null
    const wasAlreadyTrue = condition ? checkPostcondition(condition, observed.snapshot, args.ref) : false
    // Scroll changes only the viewport, which the next observation reports in
    // full; its unknown outcome needs re-observation but does not lock the Card.
    const trace = {}
    const mutationGeneration = beginMutation(binding)
    // Restore only eligibility to be checked by the next valid observation, never input permission.
    const restoreFallback = () => {
      if (!eligibility || binding.closed || binding.ownerKey !== ownerNow(binding) || run.status !== 'inProgress') return
      Object.assign(card, clickLock)
      if (binding.mutationGeneration === mutationGeneration) card.noEffectClick = eligibility
    }
    const markUnknown = () => {
      if (action.type === 'scroll') return
      card.uncertain = true
      card.uncertainAction = { action: action.type, timing: { ...trace } }
      if (action.type === 'navigate' ||
          (['click', 'press', 'pointer-click', 'type-text'].includes(action.type) && condition && ['url', 'visible-text'].includes(condition.kind))) {
        // The loop can recognize a GET landing with added site parameters. Its next action must not
        // remain locked behind an exact-URL mismatch. Require the confirmed fill on this document,
        // the observed submitter's exact GET destination and a new, ready document (recordObservation).
        const filled = previousFill?.documentId === observed.snapshot.documentId && observed.snapshot.interactiveElements.find(el => el.ref === previousFill.ref && el.value === previousFill.value)?.value
        const typedGet = action.type === 'navigate' && condition?.kind === 'url' && args.url === condition.value &&
          sameSiteNavigation(observed.snapshot.url, args.url) && filled && [...new URL(args.url).searchParams.values()].includes(filled) &&
          observed.snapshot.interactiveElements.some(el => !el.disabled && el.nav?.form?.method === 'get' && el.nav.form.submitUrl === args.url && !el.nav.form.sensitive && !el.nav.sensitiveRegion && ['submit', 'image'].includes(el.nav.type))
        card.pendingTransition = { ...(typedGet ? { typedGet: true } : {}), condition, ref: args.ref || null,
          priorDocumentId: observed.snapshot.documentId, actionType: action.type, wasAlreadyTrue,
          ...(action.type === 'navigate' && observed.snapshot.innerWindowId ? { priorInnerWindowId: observed.snapshot.innerWindowId } : {}) }
      }
    }
    // BRW-12: after a lost response, ask once whether the actor entered
    // perform for this call. Proven "never entered" (fenced by the actor)
    // frees the Card like a refusal; anything else stays locked. The action
    // itself is never sent again.
    const reconcileLostAct = async error => {
      const outcome = await reconcileAct(run, binding, card, { callId, guard,
        actRequestId: short(error.wireRequestId, 160) ? error.wireRequestId : null, actSeq: trace.seq })
      error.dispatched = outcome.dispatched
      error.reconcile = outcome.summary
      if (outcome.dialog) error.dialog = outcome.dialog
      if (card.uncertainAction) card.uncertainAction.dispatched = outcome.dispatched
      if (outcome.dispatched === false) {
        card.uncertain = false; card.uncertainAction = null; card.pendingTransition = null
        // The no-effect click's own lock stays; only the unsent press is undone.
        restoreFallback()
        throw Object.assign(new Error('Browser action was not sent; observe this Browser Card again before trying it'),
          { code: 'BROWSER_OBSERVATION_STALE', staleBy: 'reply-lost', dispatchPhase: 'not-dispatched', dispatched: false,
            reconcile: outcome.summary, timing: { ...trace } })
      }
      error.dispatchPhase = outcome.dispatched === true ? 'dispatched' : 'unknown'
    }
    const guard = { documentId: observed.snapshot.documentId, revision: observed.snapshot.revision,
      viewport: observed.snapshot.viewport, url: observed.snapshot.url,
      focusedRef: observed.snapshot.focusedElement?.ref || null,
      // Gecko document identities from the observation, passed through as
      // observed; Firefox chrome compares them with the live document.
      ...(Object.hasOwn(observed.snapshot, 'innerWindowId') ? { innerWindowId: observed.snapshot.innerWindowId } : {}),
      ...(Object.hasOwn(observed.snapshot, 'browsingContextId') ? { browsingContextId: observed.snapshot.browsingContextId } : {}),
      // A pointer press uses the observed bounds, never the model's copy.
      ...(args.expectedTarget ? { target: pointerBounds ? { ...args.expectedTarget, bounds: { ...pointerBounds } } : args.expectedTarget } : {}),
      ...(pointerBounds ? { pointer: { scroll: { x: observed.snapshot.scroll.x, y: observed.snapshot.scroll.y },
        ...(Object.hasOwn(observed.snapshot, 'zoom') ? { zoom: observed.snapshot.zoom } : {}) } } : {}),
      ...(action.type === 'navigate' ? { navigationScope,
        ...(navigationScope === 'allowed-site' ? { allowedSites: [...binding.navigationPolicy.allow] } : {}) } : {}),
      ...(action.type === 'scroll' ? { scroll: observed.snapshot.scroll } : {}),
      ...(containerBefore ? { containerScroll: { x: containerBefore.x, y: containerBefore.y } } : {}),
      ...(pressPolicy ? { pressPolicy } : {}) }
    // callId names this one native call to the UI and actor, so a lost
    // response can be reconciled against what the actor recorded.
    const callId = short(event?.callId, 160) ? event.callId : null
    const pending = requestUi({ kind: 'act', runId: binding.runId,
      clientThreadId: binding.clientThreadId, cardId: card.cardId, binding: card.ui,
      ...(callId ? { callId } : {}), ...(event?.actor === 'decision' || event?.actor === 'model' ? { actor: event.actor } : {}), // a1: who chose this action (the task tool's loop or the conversation model), for the Card's record
      action, guard, ...(condition ? { postcondition: condition } : {}) }, binding, run, trace)
    binding.pending.add(pending)
    let response
    try { response = await pending }
    catch (error) {
      markUnknown()
      if (error?.code === 'BROWSER_UI_TIMEOUT' && callId) await reconcileLostAct(error)
      throw error
    }
    finally { binding.pending.delete(pending); card.busy = false }
    if (binding.closed || binding.ownerKey !== ownerNow(binding)) reject('BROWSER_RUN_ENDED', 'Browser run ended during action; effect is unknown')
    const dialog = dialogOf(response.dialog)
    if (response.status !== 'acted' || !record(response.receipt)) {
      const obscuredBy = obscuredByOf(response)
      // Not sent: only this observation is spent; no lock, no retry. The
      // model re-observes and may decide again under a new call ID.
      if (provenNotDispatched(response) && !response.dialog) {
        const inputDeniedBy = inputDeniedReasonOf(response)
        restoreFallback()
        throw Object.assign(new Error('Browser action was not sent; observe this Browser Card again before trying it'),
          { code: 'BROWSER_OBSERVATION_STALE', staleBy: staleReasonOf(response.error), dispatchPhase: 'not-dispatched', dispatched: false, timing: { ...trace },
            ...(inputDeniedBy ? { inputDeniedBy } : {}),
            ...(targetReasonOf(response.error) ? { targetBy: targetReasonOf(response.error) } : {}),
            ...(obscuredBy ? { obscuredBy } : {}) })
      }
      markUnknown()
      // The helper's conclusion, not the UI's claim: a contradicted
      // 'not-dispatched' is reported as unknown.
      const dispatchPhase = response.dispatchPhase === 'dispatched' ? 'dispatched' : 'unknown'
      throw Object.assign(new Error(response.error || 'Browser action was not confirmed; do not retry blindly'),
        { code: 'BROWSER_ACTION_UNVERIFIED', timing: { ...trace }, dispatchPhase,
          dispatched: dispatchPhase === 'dispatched' ? true : 'unknown', ...(dialog ? { dialog } : {}) })
    }
    const after = response.receipt.after
    const dispatchReceipt = response.receipt.dispatchReceipt
    // Display markers and dispatch are separate from effect: only the actor's
    // reported route plus a current-document readback can confirm a result.
    const readbackIsCurrent = validSnapshot(after, card.cardId) && record(dispatchReceipt) &&
      dispatchReceipt.actor === 'JSWindowActor' && dispatchReceipt.eventDispatched === true &&
      dispatchReceipt.documentStillCurrent === true &&
      (action.type === 'navigate' || after.documentId === observed.snapshot.documentId) &&
      (action.type !== 'click' || (
        dispatchReceipt.clickInputRoute === 'dom-click-no-pointerdown' &&
        dispatchReceipt.targetClickObserved === true)) &&
      (action.type !== 'scroll' || (dispatchReceipt.inputRoute === 'dom-scroll-api' &&
        dispatchReceipt.scrollMode === (containerScroll ? 'container' : byRef ? 'into-view' : 'document') &&
        validScroll(after.scroll) && (!containerScroll || validContainerScroll(dispatchReceipt.containerScroll)))) &&
      (action.type !== 'press' || (dispatchReceipt.inputRoute === 'dom-keyboard-event' &&
        dispatchReceipt.key === args.key && dispatchReceipt.trustedInput === false &&
        dispatchReceipt.targetKeyObserved === true && dispatchReceipt.focusPolicy === pressPolicy)) &&
      // BRW-10: a full move/down/up reached the target, with no release
      // compensation; typing went through the focused element's input path.
      (action.type !== 'pointer-click' || (dispatchReceipt.inputRoute === 'trusted-pointer' &&
        dispatchReceipt.trustedInput === true && POINTER_API_ROUTES.has(dispatchReceipt.apiRoute) &&
        dispatchReceipt.downDispatched === true && dispatchReceipt.upDispatched === true &&
        dispatchReceipt.compensatedUp === false && dispatchReceipt.targetPointerObserved === true)) &&
      (action.type !== 'type-text' || (dispatchReceipt.inputRoute === 'trusted-text-input' &&
        dispatchReceipt.trustedInput === true && dispatchReceipt.focusPolicy === 'already-focused' &&
        dispatchReceipt.key === (action.key ?? null) && (action.key == null || dispatchReceipt.keyDispatched === true) &&
        (!action.text || (dispatchReceipt.textCommitted === true && dispatchReceipt.targetInputObserved === true))))
    const common = { cardId: card.cardId, action: action.type, dispatchReceipt: dispatchReceipt || null,
      after: after || null, observation: response.receipt.observation || null, timing: { ...trace },
      ...(dialog ? { dialog } : {}) }
    if (containerScroll) {
      // Readback: the container's offsets in the current after-snapshot.
      const afterContainer = readbackIsCurrent ? scrollContainerOf(after, args.ref) : null
      const moved = afterContainer ? afterContainer.y - containerBefore.y : null
      const wantDown = ['down', 'bottom'].includes(action.direction)
      const matched = moved !== null && (wantDown ? moved > 0 : moved < 0)
      const atLimit = moved === 0 && (wantDown ? containerBefore.y >= containerBefore.maxY : containerBefore.y <= 0)
      // Like any scroll it never locks the Card; a dialog only withholds "observed".
      return { status: matched && !dialog ? 'postcondition-observed' : atLimit && !dialog ? 'scroll-at-limit' : 'postcondition-unverified',
        ...common, postcondition: { kind: 'container-scroll-position', ref: args.ref, direction: action.direction,
          amount: action.amount, matched },
        scroll: { container: { ref: args.ref, before: containerBefore, after: afterContainer } }, externalEffectVerified: false }
    }
    if (action.type === 'scroll') {
      const before = observed.snapshot.scroll
      const moved = readbackIsCurrent ? after.scroll.y - before.y : null
      const wantDown = ['down', 'bottom'].includes(action.direction)
      const inView = byRef && readbackIsCurrent && dispatchReceipt.targetInView === true && elementInView(after, args.ref) !== false
      const matched = byRef ? inView : moved !== null && (wantDown ? moved > 0 : moved < 0)
      const atLimit = !byRef && moved === 0 && (wantDown ? before.y >= before.maxY : before.y <= 0)
      return { status: matched ? 'postcondition-observed' : atLimit ? 'scroll-at-limit' : 'postcondition-unverified',
        ...common, postcondition: byRef
          ? { kind: 'target-in-view', matched, wasAlreadyTrue: elementInView(observed.snapshot, args.ref) === true }
          : { kind: 'scroll-position', direction: action.direction, amount: action.amount, matched },
        scroll: { before, after: readbackIsCurrent ? after.scroll : null }, externalEffectVerified: false }
    }
    if (action.type === 'press' && !condition) {
      // Non-activation keys may omit a postcondition: the dispatch is reported,
      // never its effect. A non-current readback still makes the outcome unknown.
      if (!readbackIsCurrent || dialog) markUnknown()
      return { status: readbackIsCurrent && !dialog ? 'key-dispatched' : 'postcondition-unverified', ...common,
        postcondition: null, externalEffectVerified: false }
    }
    // A page dialog still open after the action leaves the outcome unknown.
    const matched = !wasAlreadyTrue && readbackIsCurrent && !dialog && checkPostcondition(condition, after, args.ref)
    if (!matched) markUnknown()
    if (!matched && action.type === 'click' && !wasAlreadyTrue && readbackIsCurrent && !response.dialog &&
        binding.mutationGeneration === mutationGeneration &&
        clickHadNoEffect(observed.snapshot, after, response.receipt.observation)) {
      const { documentId, url, revision, innerWindowId, browsingContextId } = observed.snapshot
      card.noEffectClick = { ref: args.ref, scope: { documentId, url, revision, innerWindowId, browsingContextId },
        target: { ...args.expectedTarget } }
    }
    // The press reached what the no-effect click could not: the Card's lock
    // from that click ends with an observed postcondition.
    if (matched && action.type === 'pointer-click') { card.uncertain = false; card.uncertainAction = null; card.pendingTransition = null }
    if (matched && action.type === 'fill') card.lastFill = { ref: args.ref, value: args.text, documentId: observed.snapshot.documentId }
    return { status: matched ? 'postcondition-observed' : 'postcondition-unverified', ...common,
      postcondition: { ...condition, matched, wasAlreadyTrue },
      ...(action.type === 'navigate' ? { navigationScope, pageLoadVerified: false } : {}),
      externalEffectVerified: false }
  }

  // egdesk_browser_request_site (D-B1): one question to the person on the Card,
  // on a long budget. The UI's answer carries the conversation's new policy;
  // the helper reports the site allowed only once its own copy says so.
  async function requestSite(run, binding, card, args) {
    const site = sitePatternsFromInput(args.site)
    if (!site.ok) reject('INVALID_BROWSER_TOOL', 'Site request needs a host or http(s) URL')
    if (binding.refusedSites.has(site.site)) reject('BROWSER_NAVIGATE_OUT_OF_SCOPE', 'The person refused that site in this run; do not ask again')
    beginMutation(binding)
    const trace = {}
    const pending = requestUi({ kind: 'allow-site', runId: binding.runId, clientThreadId: binding.clientThreadId,
      cardId: card.cardId, binding: card.ui, site: site.site, patterns: [...site.patterns] }, binding, run, trace,
      { budgetMs: Math.min(SITE_REQUEST_BUDGET_MS, 60000) })
    binding.pending.add(pending)
    const askedAt = now()
    let response
    try { response = await pending }
    catch (error) {
      if (error?.code === 'BROWSER_UI_TIMEOUT') {
        return { status: 'site-pending', pendingBy: 'helper-timeout', waitedMs: Math.max(0, now() - askedAt), cardId: card.cardId, action: 'request_site', site: site.site, timing: { ...trace }, externalEffectVerified: false }
      }
      throw error
    }
    finally { binding.pending.delete(pending) }
    if (binding.closed || binding.ownerKey !== ownerNow(binding)) reject('BROWSER_RUN_ENDED', 'Browser run ended during the site request')
    if (!['site-allowed', 'site-refused', 'site-pending'].includes(response?.status)) reject('BROWSER_UI_PROTOCOL', 'Browser UI site answer is unreadable')
    adoptNavigationPolicy(binding, response)
    if (response.status === 'site-refused') binding.refusedSites.add(site.site)
    let reflected = site.patterns.every(pattern => binding.navigationPolicy.allow.includes(pattern))
    let policySync = null
    if (!reflected && response.status === 'site-allowed' && response.site === site.site) { // the Card vouches for exactly the site asked about
      binding.vouchedSites ||= new Set(); for (const pattern of site.patterns) binding.vouchedSites.add(pattern)
      holdVouchedSites(binding)
      reflected = site.patterns.every(pattern => binding.navigationPolicy.allow.includes(pattern)); policySync = reflected ? 'card-vouched' : null
    }
    const status = response.status === 'site-allowed' && reflected ? 'site-allowed'
      : response.status === 'site-refused' ? 'site-refused' : 'site-pending'
    // u10: why a site request ended 'site-pending', in closed words and numbers (never text): the Card's question timed out or was dismissed unanswered ('unanswered'), the helper stopped waiting
    // ('helper-timeout', above), or the person allowed it but this run's navigation policy does not hold the site ('unreflected'). waitedMs: how long the person's answer took.
    const pendingBy = status !== 'site-pending' ? null : response.status === 'site-allowed' ? 'unreflected' : 'unanswered'
    const ui = record(response.diag) ? { askedLeftMs: Number.isSafeInteger(response.diag.leftMs) ? response.diag.leftMs : null, answeredAfterMs: Number.isSafeInteger(response.diag.waitedMs) ? response.diag.waitedMs : null } : null
    return { status, ...(pendingBy ? { pendingBy } : {}), ...(policySync ? { policySync } : {}), waitedMs: Math.max(0, now() - askedAt), ...(ui ? { ui } : {}), cardId: card.cardId, action: 'request_site', site: site.site, timing: { ...trace }, externalEffectVerified: false }
  }

  // egdesk_browser_open_card (D-B2): the UI opens a Card in the same profile,
  // container and account and binds it to this run; the helper admits it only
  // when the UI's binding proves that identity. The URL follows the D-B1 rule
  // from the source Card's current page.
  async function openCard(run, binding, card, args) {
    if (binding.cards.size >= MAX_RUN_CARDS) reject('BROWSER_CARD_LIMIT', 'This run already has four Browser Cards')
    const fromUrl = card.observation?.snapshot?.url ?? card.ui?.url ?? null
    const navigation = navigationDecision(binding, fromUrl, args.url)
    if (!navigation.allowed) rejectNavigation(navigation)
    beginMutation(binding)
    const trace = {}
    const pending = requestUi({ kind: 'open-card', runId: binding.runId, clientThreadId: binding.clientThreadId,
      cardId: card.cardId, binding: card.ui, url: args.url, permission: card.permission,
      navigationScope: navigation.reason === 'allow-list' ? 'allowed-site' : 'same-site' }, binding, run, trace)
    binding.pending.add(pending)
    let response
    try { response = await pending } finally { binding.pending.delete(pending) }
    if (binding.closed || binding.ownerKey !== ownerNow(binding)) reject('BROWSER_RUN_ENDED', 'Browser run ended while opening a Card')
    const opened = response?.binding
    if (response?.status !== 'card-opened' || !record(opened) || !short(opened.cardId, 160) || binding.cards.has(opened.cardId) ||
        !short(opened.cardEpoch, 160) || opened.profileId !== card.profileId || opened.accountId !== card.accountId ||
        opened.userContextId !== card.userContextId || opened.engineAccountKey !== card.engineAccountKey ||
        opened.authorityEpoch !== card.authorityEpoch) {
      reject('BROWSER_BINDING_STALE', 'The opened Browser Card did not bind with the same profile, container and account')
    }
    adoptNavigationPolicy(binding, response)
    const entry = { cardId: opened.cardId, profileId: card.profileId, accountId: card.accountId, selectedUrl: args.url,
      permission: card.permission, selectionToken: null, clientThreadId: binding.clientThreadId, sourceId: null,
      cardEpoch: opened.cardEpoch, userContextId: card.userContextId, engineAccountKey: card.engineAccountKey,
      authorityEpoch: card.authorityEpoch, ui: opened, observation: null, busy: false, uncertain: false,
      uncertainAction: null, pendingTransition: null, lastFill: null, openedByAgent: true, openedFrom: card.cardId }
    binding.cards.set(opened.cardId, entry)
    binding.selectedCards.push(entry)
    return { status: 'card-opened', cardId: opened.cardId, action: 'open_card', openedFrom: card.cardId, permission: entry.permission,
      cardEpoch: entry.cardEpoch, url: args.url, cards: cardSummary(binding), pageLoadVerified: false,
      timing: { ...trace }, externalEffectVerified: false }
  }

  // egdesk_browser_close_card: only a Card this run opened (D-B2); a person's
  // Card is never closed by the Agent.
  async function closeCard(run, binding, card) {
    if (card.openedByAgent !== true) reject('BROWSER_CARD_NOT_AGENT_OPENED', 'Only a Browser Card this run opened can be closed by the Agent')
    beginMutation(binding)
    const trace = {}
    card.busy = true
    const pending = requestUi({ kind: 'close-card', runId: binding.runId, clientThreadId: binding.clientThreadId,
      cardId: card.cardId, binding: card.ui }, binding, run, trace)
    binding.pending.add(pending)
    let response
    try { response = await pending } finally { binding.pending.delete(pending); card.busy = false }
    if (response?.status !== 'card-closed') reject('BROWSER_ACTION_UNVERIFIED', 'The Browser Card was not confirmed closed')
    binding.cards.delete(card.cardId)
    binding.selectedCards = binding.selectedCards.filter(item => item.cardId !== card.cardId)
    return { status: 'card-closed', cardId: card.cardId, action: 'close_card', cards: cardSummary(binding),
      timing: { ...trace }, externalEffectVerified: false }
  }

  // egdesk_browser_history: EG-Desk chrome moves the Card's own history. The
  // result is the dispatch only; the observation is spent and the Card is not
  // locked, because the next observation shows wherever the move landed.
  async function historyMove(run, binding, card, args, observed) {
    beginMutation(binding)
    card.observation = null
    card.lastFill = null
    card.busy = true
    const trace = {}
    const guard = { documentId: observed.snapshot.documentId, revision: observed.snapshot.revision, url: observed.snapshot.url,
      ...(Object.hasOwn(observed.snapshot, 'innerWindowId') ? { innerWindowId: observed.snapshot.innerWindowId } : {}),
      ...(Object.hasOwn(observed.snapshot, 'browsingContextId') ? { browsingContextId: observed.snapshot.browsingContextId } : {}) }
    const pending = requestUi({ kind: 'history', runId: binding.runId, clientThreadId: binding.clientThreadId,
      cardId: card.cardId, binding: card.ui, historyAction: args.action, guard }, binding, run, trace)
    binding.pending.add(pending)
    let response
    try { response = await pending } finally { binding.pending.delete(pending); card.busy = false }
    if (binding.closed || binding.ownerKey !== ownerNow(binding)) reject('BROWSER_RUN_ENDED', 'Browser run ended during the history move; effect is unknown')
    const receipt = response?.receipt?.dispatchReceipt
    if (response?.status !== 'acted' || !record(receipt)) {
      if (record(response) && provenNotDispatched(response)) {
        throw Object.assign(new Error('History move was not sent; observe this Browser Card again'),
          { code: 'BROWSER_OBSERVATION_STALE', staleBy: staleReasonOf(response.error), dispatchPhase: 'not-dispatched', dispatched: false, timing: { ...trace } })
      }
      throw Object.assign(new Error(response?.error || 'History move was not confirmed'),
        { code: 'BROWSER_ACTION_UNVERIFIED', timing: { ...trace }, dispatchPhase: 'unknown', dispatched: 'unknown' })
    }
    const dispatched = receipt.actor === 'chrome' && receipt.inputRoute === 'chrome-history' &&
      receipt.historyAction === args.action && receipt.eventDispatched === true
    return { status: dispatched ? 'history-dispatched' : 'postcondition-unverified', cardId: card.cardId, action: 'history',
      historyAction: args.action, dispatchReceipt: receipt, pageLoadVerified: false, timing: { ...trace }, externalEffectVerified: false }
  }

  async function dispatch(run, event) {
    const tool = event?.tool
    validateArgs(tool, event?.arguments)
    const binding = bindings.get(run?.answerId)
    if (!binding || binding.closed || closedRuns.has(run?.answerId) || binding.ownerKey !== ownerNow(binding) || run?.status !== 'inProgress') {
      reject('BROWSER_RUN_ENDED', 'Browser tool run or account is no longer active')
    }
    const callId = event?.callId
    if (tool !== 'egdesk_browser_observe' && !short(callId, 160)) {
      reject('BROWSER_CALL_ID_REQUIRED', 'Native Browser actions require a stable call ID')
    }
    if (!short(callId, 160)) return executeDispatch(run, event)
    const fingerprint = createHash('sha256').update(JSON.stringify([tool, event.arguments])).digest('hex')
    const previous = binding.calls.get(callId)
    if (previous) {
      if (previous.fingerprint !== fingerprint) reject('BROWSER_CALL_ID_REUSED', 'Browser call ID was reused with different arguments')
      return previous.operation
    }
    if (binding.calls.size >= 1024) reject('BROWSER_CALL_LIMIT', 'Browser run reached its bounded call limit')
    const operation = executeDispatch(run, event)
    binding.calls.set(callId, { fingerprint, operation })
    return operation
  }

  async function cancelRun(run) {
    if (short(run?.answerId, 160)) closedRuns.add(run.answerId)
    const binding = bindings.get(run?.answerId) || pendingBindings.get(run?.answerId)
    if (!binding) return []
    binding.closed = true
    for (const card of binding.cards.values()) { card.observation = null; card.lastFill = null; card.noEffectClick = null }
    return cancelCards(binding)
  }
  function reset() {
    const pending = [...new Set([...bindings.values(), ...pendingBindings.values()])].flatMap(binding => {
      binding.closed = true
      return [cancelCards(binding)]
    })
    for (const answerId of [...bindings.keys(), ...pendingBindings.keys()]) closedRuns.add(answerId)
    bindings.clear()
    pendingBindings.clear()
    return Promise.allSettled(pending)
  }
  return { prepare, specs, bind, adopt, dispatch, cancelRun, reset }
}
