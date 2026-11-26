import { isBrowserUserHold } from './egdesk-browser-tool-runtime.mjs'
import { createHash } from 'node:crypto'
import { RECOMMENDED_ACTION_GATE_POLICY, actionGate, classifyAction } from './egdesk-browser-action-classifier.mjs'
import { authOpaqueOn, isAuthOpaqueUrl } from './egdesk-auth-opaque.mjs'
import { grantHint } from './egdesk-browser-grant-path.mjs'
import { DEFAULT_NAVIGATION_POLICY, evaluateNavigation } from './egdesk-browser-url-policy.mjs'
import { buildReflexCandidates, expectedTargetOf, navigationLanded, reflexActionArgs } from './egdesk-browser-reflex.mjs'
import { BROWSER_TASK_TOOL_NAME } from './egdesk-browser-task-tool.mjs'

// L8 u1 ('위': up to the conversation): the browser as EG-Desk tools (the tools are named after the Card: egdesk_card_*; egdesk_page_* is the working-memory fixture's stand-in) the conversation engine calls (Claude through the EG-Desk MCP catalog, Codex through the own-tools path: both read
// this provider's specs()). Four coarse tools on top of the Browser tool service, whose checks stay in force because EVERY action goes through that provider's own dispatch for the same run
// (verified run binding, the Card grant, the action gate, the AI-service sign-in opacity (BROWSER_CARD_OPAQUE), receipts, the activity record). Names are provisional.
//
//   egdesk_card_open   open a page in a new Card from one the person granted
//   egdesk_card_read   what the Card shows: title, address, the visible lines (summary), and with mode structure the controls, each marked with what pressing or typing would do
//   egdesk_card_press  press a control
//   egdesk_card_type   type text into a text field (never Enter, never a submit)
//
// What may act without asking is decided by CODE, never by the engine (R3, R5): the same proof the objective loop uses (buildReflexCandidates: a same-site link, a read-only GET search, a
// view tab, an ordinary text field). Everything else is classified by the action classifier with the RECOMMENDED gate policy:
//   auto      code proved it read-only / same-site / not in a sensitive region: acts
//   approval  anything else that is not payment, permission, sign-in or credential: EG-Desk asks the person first (the same approval ledger as the command and file tools: the call is refused
//             with a closed note, the person answers in chat, the identical call then goes through once). A press without a provable effect needs `expectText`, the text the page will show after it.
//   person    payment, permission grant, sign-in, a password, card or ID-number field: never done by a tool, even with a yes: the person does it on the page
// No new user-facing text: results are closed words and the page's own lines for the engine.
export const PAGE_TOOLS_PROVIDER_ID = 'egdesk-page' // provisional
export const PAGE_TOOLS_FLAG = 'EGDESK_PAGE_TOOLS'
export const pageToolsEnabled = env => env?.[PAGE_TOOLS_FLAG] === 'on'
export const PAGE_TOOL_NAMES = Object.freeze({ open: 'egdesk_card_open', read: 'egdesk_card_read', press: 'egdesk_card_press', type: 'egdesk_card_type' }) // model-facing, provisional
export const PAGE_LIMITS = Object.freeze({ lines: 60, lineChars: 240, textChars: 8000, elements: 60, labelChars: 100, typeChars: 500, urlChars: 2000, observations: 16 })

// u8 (D23): the markings of a page tool result are EG-Desk's own words; this note rides in the results that carry them so a commentary line before the answer never repeats them to the person.
export const INTERNAL_NOTE = 'Not for the person: act, why, status, via and codes in this result are EG-Desk\'s own markings. Say what happened in everyday words.'
export const PAGE_TOOL_SPECS = Object.freeze([
  Object.freeze({ type: 'function', name: PAGE_TOOL_NAMES.read, description: 'Read an EG-Desk Browser Card the person granted to this conversation: its title, address and visible lines. mode "structure" also lists its controls (ref, role, label) each marked auto (pressing or typing runs at once), approval (the person is asked first) or person (only the person does it on the page: sign-in, payment, permission, password). Read again after anything changes the page. The marks and the result fields are for you: never say them to the person; describe what you do in everyday words.',
    inputSchema: { type: 'object', additionalProperties: false, properties: { cardId: { type: 'string', description: 'Omit when exactly one Card is granted.' }, mode: { type: 'string', enum: ['summary', 'structure'] } } } }),
  Object.freeze({ type: 'function', name: PAGE_TOOL_NAMES.press, description: 'Press one control of a Card the person granted for operation (their Browser card menu: Chat 조작 허용), by the ref from the last egdesk_card_read in structure mode. A same-site link, a read-only search button and a view tab run at once; a control that may change something asks the person first (give expectText: the text the page will show afterwards); sign-in, payment, permission and credentials are only the person\'s.',
    inputSchema: { type: 'object', additionalProperties: false, required: ['ref'], properties: { cardId: { type: 'string' }, ref: { type: 'string' }, expectText: { type: 'string', description: 'Text expected on the page after the press; needed when the press may change something.' } } } }),
  Object.freeze({ type: 'function', name: PAGE_TOOL_NAMES.type, description: 'Type text into one text field of a Card the person granted for operation (their Browser card menu: Chat 조작 허용), by the ref from the last egdesk_card_read in structure mode. It never presses Enter and never submits. Password, card and ID-number fields are only the person\'s.',
    inputSchema: { type: 'object', additionalProperties: false, required: ['ref', 'text'], properties: { cardId: { type: 'string' }, ref: { type: 'string' }, text: { type: 'string', maxLength: PAGE_LIMITS.typeChars } } } }),
  Object.freeze({ type: 'function', name: PAGE_TOOL_NAMES.open, description: 'Open an http(s) page in a new Browser Card, from a Card the person granted for operation (their Browser card menu: Chat 조작 허용). The page belongs to the person\'s own browser; sign-in pages of AI services cannot be opened.',
    inputSchema: { type: 'object', additionalProperties: false, required: ['url'], properties: { url: { type: 'string', maxLength: PAGE_LIMITS.urlChars }, cardId: { type: 'string', description: 'The granted Card to open it from; omit when exactly one is granted.' } } } }),
])

const respond = (success, body) => ({ success, contentItems: [{ type: 'inputText', text: JSON.stringify(body) }] })
const refused = code => respond(false, { error: { code } })
const short = (value, max) => String(value ?? '').replace(/\s+/g, ' ').trim().slice(0, max)
const sha = text => createHash('sha256').update(String(text)).digest('hex').slice(0, 16)
const hostOf = url => { try { return new URL(url).host.toLowerCase() } catch { return null } }
const pathOf = url => { try { return new URL(url).pathname } catch { return null } }
const CREDENTIAL_ROLES = new Set(['password', 'passwordbox'])
const CREDENTIAL_LABEL = /(비밀번호|패스워드|password|passcode|카드\s*번호|card\s*number|cvv|cvc|주민\s*등록|주민번호|보안\s*코드|인증\s*번호|otp|pin\b)/i

function parse(response) {
  try { return { ok: response?.success === true, data: JSON.parse(response?.contentItems?.[0]?.text ?? 'null') } } catch { return { ok: false, data: null } }
}

/**
 * createPageToolsProvider({ mode, browser, ledger?, env?, now? })
 *   browser: the Browser tool provider (providerId 'egdesk-browser'); every action is its dispatch(run, { tool, arguments, callId }) for the SAME run
 *   ledger:  the approval ledger of the command and file tools (check({ sessionId, turnId, cwd, command, floor, identity })); without it nothing that needs approval is done
 */
// taskTool (L8 a1, optional): the browser task tool (egdesk-browser-task-tool.mjs) served beside these four (its flag EGDESK_BROWSER_TASK_TOOL); without it nothing changes.
export function createPageToolsProvider({ mode = () => 'off', browser = null, ledger = null, env = process.env, limits = {}, taskTool = null } = {}) {
  const L = { ...PAGE_LIMITS, ...limits }
  const on = () => { try { return mode() === 'on' } catch { return false } }
  const last = new Map() // `${runId}/${cardId}` -> { observationId, snapshot, options }
  const calls = new Map()
  const remember = (run, cardId, value) => { last.set(`${run?.runId ?? run?.answerId}/${cardId}`, value); while (last.size > L.observations) last.delete(last.keys().next().value) }
  const recall = (run, cardId) => last.get(`${run?.runId ?? run?.answerId}/${cardId}`) ?? null
  const opaque = url => authOpaqueOn(env) && isAuthOpaqueUrl(url)

  const pageFailure = error => isBrowserUserHold(error)
    ? respond(true, { status: 'refused', code: error.code, staleBy: 'user-hold', forYouOnly: 'The person took control of the Card: say so, stop, and do not retry.' })
    : respond(false, { error: { code: 'PAGE_TOOL_FAILED' } })
  async function call(run, event, tool, args, suffix) {
    if (!browser || typeof browser.dispatch !== 'function') return { ok: false, data: { error: { code: 'PAGE_BROWSER_UNAVAILABLE' } } }
    const out = parse(await browser.dispatch(run, { tool, arguments: args, callId: `${event?.callId ?? 'page'}.${suffix}`, namespace: null }))
    if (!out.ok && isBrowserUserHold(out.data?.error)) throw out.data.error // terminal, including a navigation readback
    return out
  }
  const cardsOf = run => (Array.isArray(run?.browserBinding?.cards) ? run.browserBinding.cards : [])
  const pickCard = (run, args, { interact = false } = {}) => {
    const cards = cardsOf(run).filter(card => !interact || card.permission === 'interact')
    if (!cards.length) return { error: cardsOf(run).length ? 'PAGE_NO_INTERACT_GRANT' : 'PAGE_NO_CARD', hint: grantHint(cardsOf(run).length ? 'PAGE_NO_INTERACT_GRANT' : 'PAGE_NO_CARD') }
    if (typeof args.cardId === 'string' && args.cardId) { const card = cards.find(item => item.cardId === args.cardId); return card ? { card } : { error: 'PAGE_CARD_NOT_GRANTED' } }
    return cards.length === 1 ? { card: cards[0] } : { error: 'PAGE_CARD_REQUIRED', cardIds: cards.map(card => card.cardId).slice(0, 4) }
  }
  async function observe(run, event, cardId, suffix = 'obs') {
    const out = await call(run, event, 'egdesk_browser_observe', { cardId }, suffix)
    const snapshot = out.data?.snapshot
    if (!out.ok || !snapshot) return { error: out.data?.error?.code ?? 'PAGE_OBSERVE_FAILED', detail: out.data?.error }
    if (opaque(snapshot.url)) return { error: 'BROWSER_CARD_OPAQUE' }
    const value = { observationId: out.data.observationId, snapshot, options: buildReflexCandidates(snapshot, { textComboboxes: true }).options }
    remember(run, cardId, value)
    return value
  }

  /** What an action on this element would do: 'auto' | 'approval' | 'person' | 'disabled' (code only). */
  function classify(snapshot, options, element) {
    if (element.disabled === true) return { act: 'disabled' }
    const label = String(element.label ?? '')
    if (CREDENTIAL_ROLES.has(String(element.role)) || String(element.type ?? '').toLowerCase() === 'password' || CREDENTIAL_LABEL.test(label)) return { act: 'person', why: 'credential' }
    const option = options.find(item => item.item.element.ref === element.ref)
    if (option) {
      if (option.item.kind === 'navigate' || option.item.kind === 'fill') return { act: 'auto', option }
      if (option.item.readOnly) return { act: 'auto', option }
    }
    const judged = classifyAction({ mode: 'activate', label: element.label, role: element.role, tag: element.tag, url: snapshot.url })
    const gate = actionGate(judged, RECOMMENDED_ACTION_GATE_POLICY)
    if (gate === 'user-step' || gate === 'deny') return { act: 'person', why: judged.category }
    return { act: 'approval', why: judged.category === 'none' ? 'unproven' : judged.category }
  }
  const isFieldElement = element => ['textbox', 'searchbox', 'combobox', 'textarea'].includes(String(element.role)) || ['input', 'textarea'].includes(String(element.tag).toLowerCase())

  function condense(snapshot) {
    const lines = []
    let used = 0
    for (const raw of Array.isArray(snapshot.text) ? snapshot.text : []) {
      const text = short(raw, L.lineChars)
      if (!text) continue
      if (lines.length >= L.lines || used + text.length > L.textChars) return { lines, truncated: true }
      lines.push(text); used += text.length
    }
    return { lines, truncated: false }
  }

  async function read(run, event, args) {
    const picked = pickCard(run, args)
    if (picked.error) return respond(true, { status: 'refused', code: picked.error, ...(picked.cardIds ? { cardIds: picked.cardIds } : {}), ...(picked.hint ? { grant: picked.hint } : {}) })
    const obs = await observe(run, event, picked.card.cardId)
    if (obs.error) return respond(true, { status: 'refused', code: obs.error })
    const { snapshot } = obs
    const { lines, truncated } = condense(snapshot)
    const body = { status: 'read', cardId: picked.card.cardId, host: hostOf(snapshot.url), path: pathOf(snapshot.url), title: short(snapshot.title ?? snapshot.text?.[0] ?? '', 160), lines, truncated }
    if (args.mode === 'structure') {
      const elements = []
      for (const element of Array.isArray(snapshot.interactiveElements) ? snapshot.interactiveElements : []) {
        if (elements.length >= L.elements) break
        if (typeof element?.ref !== 'string') continue
        const verdict = classify(snapshot, obs.options, element)
        elements.push({ ref: element.ref, role: String(element.role ?? ''), label: short(element.label, L.labelChars), ...(element.href ? { href: pathOf(element.href) ?? undefined } : {}), ...(element.value ? { value: short(element.value, 60) } : {}), act: verdict.act })
      }
      body.elements = elements
      body.forYouOnly = INTERNAL_NOTE
    }
    return respond(true, body)
  }

  async function ask(run, { command, reason, identity }) {
    if (typeof ledger?.check !== 'function') return { unavailable: true }
    let decision
    try { decision = await ledger.check({ sessionId: run.conversationId, turnId: run.runId, cwd: '/', command, floor: [reason], identity, own: 'page' }) } catch { return { unavailable: true } }
    if (decision?.decision === 'allow' || decision?.decision === 'none') return { allowed: true }
    if (decision?.decision === 'deny') { let gate = { status: 'needs_person' }; try { gate = JSON.parse(decision.note).egdesk_command_gate ?? gate } catch { /* closed default */ } return { gate } }
    return { unavailable: true }
  }

  async function act(run, event, args, kind) {
    const picked = pickCard(run, args, { interact: true })
    if (picked.error) return respond(true, { status: 'refused', code: picked.error, ...(picked.cardIds ? { cardIds: picked.cardIds } : {}), ...(picked.hint ? { grant: picked.hint } : {}) })
    const cardId = picked.card.cardId
    if (typeof args.ref !== 'string' || !args.ref) return refused('PAGE_REF_REQUIRED')
    let obs = recall(run, cardId)
    if (!obs) { obs = await observe(run, event, cardId); if (obs.error) return respond(true, { status: 'refused', code: obs.error }) }
    const { snapshot } = obs
    const element = (snapshot.interactiveElements ?? []).find(item => item.ref === args.ref)
    if (!element) return respond(true, { status: 'refused', code: 'PAGE_REF_UNKNOWN', next: 'read_again' })
    if (opaque(element.href) || opaque(snapshot.url)) return respond(true, { status: 'refused', code: 'BROWSER_CARD_OPAQUE' })
    const verdict = classify(snapshot, obs.options, element)
    const label = short(element.label, L.labelChars)
    if (verdict.act === 'disabled') return respond(true, { status: 'refused', code: 'PAGE_CONTROL_DISABLED' })
    if (verdict.act === 'person') return respond(true, { status: 'person_step', cardId, label, why: verdict.why, written: false, forYouOnly: INTERNAL_NOTE })
    const base = { cardId, observationId: obs.observationId, expectedRevision: snapshot.revision }
    if (kind === 'type') {
      if (!isFieldElement(element)) return respond(true, { status: 'refused', code: 'PAGE_NOT_A_FIELD' })
      const text = typeof args.text === 'string' ? args.text : ''
      if (!text || text.length > L.typeChars) return respond(true, { status: 'refused', code: 'PAGE_TEXT_INVALID' })
      // a text field is typed into only where the objective loop would (an ordinary field the code lists as a fill option); anything else is the person's
      const fill = obs.options.find(item => item.item.kind === 'fill' && item.item.element.ref === element.ref)
      if (!fill) return respond(true, { status: 'person_step', cardId, label, why: 'field', written: false })
      const planned = reflexActionArgs(fill, { cardId, observationId: obs.observationId, snapshot, text })
      const done = await call(run, event, planned.tool, planned.args, 'type')
      return result(done, { status: 'typed', cardId, label, submitted: false }, run, cardId)
    }
    // press
    if (verdict.act === 'auto') {
      const planned = reflexActionArgs(verdict.option, { cardId, observationId: obs.observationId, snapshot })
      if (planned.tool) {
        const done = await call(run, event, planned.tool, planned.args, 'press')
        const outcome = planned.tool === 'egdesk_browser_navigate' ? await landed(run, event, cardId, done, { expected: planned.args.url, from: snapshot.url, submitted: verdict.option.item.readOnly?.kind === 'get_form' }) : null
        if (outcome) return landedPress(run, cardId, { status: 'pressed', via: 'auto', cardId, label }, outcome)
        return result(done, { status: 'pressed', via: 'auto', cardId, label }, run, cardId)
      }
    }
    // u9 (D25): a link to ANOTHER site (outside the conversation's sites). The person's consent for that is the site question the Card already asks (egdesk_browser_request_site: "Agent가 이 대화에서 … 사이트도
    // 열려고 합니다. 허용할까요?"), so the tool asks it ITSELF, in this run on this Card, instead of leaving the engine to call it (a Claude run's question stayed unanswered for its whole 55 s: nobody saw it) or
    // to ask for a chat approval first and the site question after (two questions, and the approval is spent by the first). Allowed: the link is followed once, on a fresh observation. Refused or unanswered:
    // nothing moves, in closed words. Sign-in, payment and the other person-only kinds were already decided above; a link that is not a plain unproven one (a submit or delete word) still needs the person's yes.
    if (verdict.act === 'approval' && verdict.why === 'unproven' && String(element.tag).toLowerCase() === 'a' && typeof element.href === 'string' && /^https?:\/\//i.test(element.href)
        && evaluateNavigation(element.href, DEFAULT_NAVIGATION_POLICY, { fromUrl: snapshot.url, layer: 'tool' }).reason === 'outside-site') {
      const site = hostOf(element.href)
      const asked = await call(run, event, 'egdesk_browser_request_site', { cardId, site }, 'site')
      if (!asked.ok || asked.data?.status !== 'site-allowed') return respond(true, { status: 'not_done', code: 'BROWSER_NAVIGATE_OUT_OF_SCOPE', site: typeof asked.data?.status === 'string' ? asked.data.status : 'site-refused', ...(typeof asked.data?.pendingBy === 'string' ? { pendingBy: asked.data.pendingBy } : {}), ...(Number.isSafeInteger(asked.data?.waitedMs) ? { waitedMs: asked.data.waitedMs } : {}), cardId, label, written: false })
      // What changed since the engine read the page is the POLICY only; the link is found again on a new observation by what it is (the same address and the same words), not by its ref (refs may be renumbered when
      // the page re-renders). Another address or other words: refused as before. A new call id each time (a call id repeated with the same arguments returns the earlier observation).
      const linkOf = snapshot => { const items = (snapshot.interactiveElements ?? []).filter(item => item.href === element.href && String(item.label ?? '') === String(element.label ?? '') && String(item.tag).toLowerCase() === 'a'); return items.find(item => item.ref === args.ref) ?? items[0] ?? null }
      let moved = null, from = snapshot.url
      for (const attempt of [1, 2]) {
        const fresh = await observe(run, event, cardId, `siteobs${attempt}`)
        from = fresh.snapshot?.url ?? from
        if (fresh.error) return respond(true, { status: 'refused', code: fresh.error })
        if (!linkOf(fresh.snapshot)) return respond(true, { status: 'refused', code: 'PAGE_REF_UNKNOWN', next: 'read_again' })
        moved = await call(run, event, 'egdesk_browser_navigate', { cardId, observationId: fresh.observationId, expectedRevision: fresh.snapshot.revision, url: element.href, postcondition: { kind: 'url', value: element.href } }, `sitepress${attempt}`)
        if (moved.ok || moved.data?.error?.code !== 'BROWSER_OBSERVATION_STALE') break // one more new observation when the page moved under the first
      }
      const outcome = await landed(run, event, cardId, moved, { expected: element.href, from })
      if (outcome) return landedPress(run, cardId, { status: 'pressed', via: 'site', cardId, label }, outcome)
      return result(moved, { status: 'pressed', via: 'site', cardId, label }, run, cardId)
    }
    const expectText = short(args.expectText, 200)
    const link = String(element.tag).toLowerCase() === 'a' && typeof element.href === 'string' && element.href
    if (!link && !expectText) return respond(true, { status: 'needs_expect_text', cardId, label, written: false })
    const reason = verdict.why === 'unproven' || verdict.why === undefined ? 'page_press_unproven' : `page_${verdict.why}`
    const decision = await ask(run, { command: `press "${label}" on ${hostOf(snapshot.url)}`, reason, identity: `page:press:${hostOf(snapshot.url)}:${sha(`${args.ref}|${label}`)}` }) // u8 (D24): the person approves pressing THIS control on THIS site; the words the engine expects to see afterwards (expectText) are not part of what was approved, so the engine's retry may word them differently
    if (decision.unavailable) return respond(false, { error: { code: 'PAGE_APPROVAL_UNAVAILABLE' } })
    if (decision.gate) return respond(true, { ...decision.gate, kind: 'press', cardId, label, written: false })
    const tool = link ? 'egdesk_browser_navigate' : 'egdesk_browser_click'
    const args2 = link ? { ...base, url: element.href, postcondition: { kind: 'url', value: element.href } } : { ...base, ref: element.ref, expectedTarget: expectedTargetOf(element), postcondition: { kind: 'visible-text', value: expectText } }
    const done = await call(run, event, tool, args2, 'press')
    const outcome = link ? await landed(run, event, cardId, done, { expected: element.href, from: snapshot.url }) : null
    if (outcome) return landedPress(run, cardId, { status: 'pressed', via: 'approved', cardId, label }, outcome)
    return result(done, { status: 'pressed', via: 'approved', cardId, label }, run, cardId)
  }

  // a1 (Main 16:55, D33; L6's DuckDuckGo reading): a navigation whose url postcondition read a failure while the page did move (a redirect, parameters the site adds). The page that
  // loaded decides, by the loop's own rule (navigationLanded): -> 'navigation-observed' | 'form-result-observed', or null (the failure stands).
  async function landed(run, event, cardId, done, { expected, from, submitted = false }) {
    if (done?.ok || typeof expected !== 'string' || !expected) return null
    const fresh = await observe(run, event, cardId, 'landed')
    if (fresh.error) return null
    return navigationLanded({ actual: fresh.snapshot.url, expected, from, submitted }) ? (submitted ? 'form-result-observed' : 'navigation-observed') : null
  }
  const landedPress = (run, cardId, body, outcome) => { last.delete(`${run?.runId ?? run?.answerId}/${cardId}`); return respond(true, { ...body, outcome, next: 'read_again', forYouOnly: INTERNAL_NOTE }) }

  function result(done, body, run, cardId) {
    last.delete(`${run?.runId ?? run?.answerId}/${cardId}`) // the page may have changed: the next action observes again
    if (!done.ok) return respond(true, { ...body, status: 'not_done', code: done.data?.error?.code ?? 'PAGE_ACTION_FAILED', ...(done.data?.error?.actionGate ? { actionGate: done.data.error.actionGate } : {}), ...(typeof done.data?.error?.staleBy === 'string' ? { staleBy: done.data.error.staleBy } : {}), next: 'read_again' }) // staleBy (L6 a1): the provider's closed word for a "not sent"
    return respond(true, { ...body, outcome: done.data?.status ?? null, next: 'read_again', forYouOnly: INTERNAL_NOTE })
  }

  async function open(run, event, args) {
    const url = typeof args.url === 'string' ? args.url.trim() : ''
    let parsed = null
    try { parsed = new URL(url) } catch { /* invalid */ }
    if (!parsed || !['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password || url.length > L.urlChars) return respond(true, { status: 'refused', code: 'PAGE_URL_INVALID' })
    if (opaque(url)) return respond(true, { status: 'refused', code: 'BROWSER_CARD_OPAQUE' })
    const picked = pickCard(run, args, { interact: true })
    if (picked.error) return respond(true, { status: 'refused', code: picked.error, ...(picked.cardIds ? { cardIds: picked.cardIds } : {}), ...(picked.hint ? { grant: picked.hint } : {}) })
    const done = await call(run, event, 'egdesk_browser_open_card', { cardId: picked.card.cardId, url }, 'open')
    if (!done.ok) return respond(true, { status: 'not_done', code: done.data?.error?.code ?? 'PAGE_OPEN_FAILED', ...(done.data?.error?.navigation ? { navigation: done.data.error.navigation } : {}) })
    return respond(true, { status: 'opened', cardId: done.data?.cardId ?? null, host: parsed.host.toLowerCase(), next: 'read' })
  }

  // a1: the task tool's guidance opens a link to another site through this tool's own press (its site question, u9 D25), never a path of its own: the link is found on a FRESH
  // observation of this provider (so the press reads the same refs), by its exact address
  const pressLink = async (run, event, { cardId, href } = {}) => {
    if (typeof cardId !== 'string' || typeof href !== 'string' || !href) return refused('PAGE_REF_REQUIRED')
    const fresh = await observe(run, event, cardId, 'taskobs')
    if (fresh.error) return respond(true, { status: 'refused', code: fresh.error })
    const element = (fresh.snapshot.interactiveElements ?? []).find(item => typeof item?.ref === 'string' && item.href === href && String(item.tag).toLowerCase() === 'a')
    if (!element) return respond(true, { status: 'refused', code: 'PAGE_REF_UNKNOWN', next: 'read_again' })
    return act(run, event, { cardId, ref: element.ref }, 'press')
  }
  try { taskTool?.usePagePress?.((...args) => pressLink(...args).catch(pageFailure)) } catch { /* the task tool then offers no link to another site */ }
  return {
    providerId: PAGE_TOOLS_PROVIDER_ID,
    runtime: null,
    specs() { return on() ? (taskTool?.spec ? [...PAGE_TOOL_SPECS, taskTool.spec] : PAGE_TOOL_SPECS) : [] },
    dispatch(run, event) {
      const key = `${run?.answerId ?? run?.runId ?? ''}/${event?.callId ?? ''}`
      if (event?.callId && calls.has(key)) return calls.get(key)
      const work = this.handle(run, event).catch(pageFailure)
      if (event?.callId) { calls.set(key, work); while (calls.size > 256) calls.delete(calls.keys().next().value) }
      return work
    },
    async handle(run, event) {
      const name = event?.tool
      if (!event?.namespace && taskTool?.spec && name === taskTool.spec.name) return on() ? taskTool.handle(run, event) : refused('PAGE_TOOLS_OFF') // a1
      if (event?.namespace || !Object.values(PAGE_TOOL_NAMES).includes(name)) return refused('PAGE_TOOL_UNKNOWN')
      if (!on()) return refused('PAGE_TOOLS_OFF')
      const args = event.arguments && typeof event.arguments === 'object' ? event.arguments : {}
      if (name === PAGE_TOOL_NAMES.read) return read(run, event, args)
      if (name === PAGE_TOOL_NAMES.open) return open(run, event, args)
      return act(run, event, args, name === PAGE_TOOL_NAMES.type ? 'type' : 'press')
    },
  }
}

// ---- the runtime's gate: a page tool is a Browser tool for the checks that run BEFORE the provider (the run's policy, the Card grant, the Agent ceiling) ----
// The page tool needs exactly what its Browser equivalent needs: read = observe (a Card granted to observe or interact), press = click, type = fill, open = open_card (a Card granted to interact).
// The runtime asks these functions instead of knowing the page tools; the Browser provider checks again for every action it is asked to do.
export const PAGE_BROWSER_EQUIVALENT = Object.freeze({ [PAGE_TOOL_NAMES.read]: 'egdesk_browser_observe', [PAGE_TOOL_NAMES.press]: 'egdesk_browser_click', [PAGE_TOOL_NAMES.type]: 'egdesk_browser_fill', [PAGE_TOOL_NAMES.open]: 'egdesk_browser_open_card' })
// a1: the browser task tool acts on its Card (opens links, types, runs read-only searches): it needs what egdesk_browser_navigate needs (an interact grant, an Agent ceiling that allows interaction)
export const pageToolBrowserEquivalent = name => PAGE_BROWSER_EQUIVALENT[name] ?? (name === BROWSER_TASK_TOOL_NAME ? 'egdesk_browser_navigate' : null)
/** { tool: <the Browser tool it needs>, cardId } for a page tool call (the Card it names, else the first interact Card, else the first Card), null for any other tool. */
export function pageToolGate(run, event) {
  if (event?.namespace) return null
  const tool = pageToolBrowserEquivalent(event?.tool)
  if (!tool) return null
  const cards = Array.isArray(run?.browserBinding?.cards) ? run.browserBinding.cards : []
  const named = typeof event?.arguments?.cardId === 'string' && event.arguments.cardId ? event.arguments.cardId : null
  return { tool, cardId: named ?? (cards.find(card => card.permission === 'interact') ?? cards[0])?.cardId ?? null }
}
