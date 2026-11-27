// L6c a2: the real window 11-26 19:27 KST (Claude DM, the DuckDuckGo home Card): Claude called the browser task tool; the objective loop's fill was refused by the Card twice
// (BROWSER_OBSERVATION_STALE, staleBy 'target', targetBy 'not-editable') and the task ended; Claude's own egdesk_card_type then typed into the same Card's box. Cause: the home
// page wraps its box (<textarea role="combobox" aria-label="DuckDuckGo로 검색">) in the ARIA search landmark <form role="search" aria-label="DuckDuckGo로 웹 검색">, which the
// Firefox child lists as role 'search', tag 'form'; the loop's candidate rule read role 'search' (the child's name for an <input type="search">) as a text field, so the form was
// [F1] beside the real [F2], and both value mappings chose [F1]. The Claude path and the Codex path send the same fill (the Browser provider's runDirectTask); 17:18's Codex
// "success" was on the results page (one observation, no fill).
// REPLAY over the real runtime, Claude adapter, MCP server, Browser provider, page tools and task tool (L8 taskDecide, L6 cardSites 'window'). The home page's elements and the
// Card's fill refusal come from the REAL Firefox child's own rules (roleFor, labelFor, isFillableControl, navigationFacts) over a fake DOM of the home page's form (its markup as
// duckduckgo.com served it, 2026-11-26); only Claude, the page and the decision model are scripted.
import test from 'node:test'
import assert from 'node:assert/strict'
import { callTool, world } from './egdesk-claude-browser-world.fixture.mjs'
import { BROWSER_TASK_TOOL_NAME } from './egdesk-browser-task-tool.mjs'
import { buildReflexCandidates, decideReflexStep, runBrowserReflex } from './egdesk-browser-reflex.mjs'
import { pageStateAnswers } from './egdesk-browser-page-state.fixture.mjs'
import { decisionThresholds } from './egdesk-decision-questions.mjs'

globalThis.JSWindowActorChild ||= class {}
const { EGDeskBrowserAgentRuntimeChild } = await import('../overlay/resources/EGDeskBrowserAgentRuntimeChild.sys.mjs')
const child = new EGDeskBrowserAgentRuntimeChild()
const DDG = 'duckduckgo.com'
const NOT_EDITABLE = 'Browser target is not an editable field [not-editable]; observe again' // the page actor's own refusal (assertGuard)

// a fake node of the home page: what the child's rules read (tag, attributes, form, value)
const doc = { URL: `https://${DDG}/`, baseURI: `https://${DDG}/`, getElementById: () => null, querySelector: () => null }
function node(tagName, attrs = {}, extra = {}) {
  const n = { tagName, getAttribute: name => (Object.hasOwn(attrs, name) ? attrs[name] : null), closest: () => null, querySelector: () => null, ownerDocument: doc, getRootNode: () => doc, textContent: '', innerText: '', ...extra }
  return n
}
/** the DuckDuckGo home page as the Firefox child reports it: elements (elementItem's fields by the child's own rules) and the nodes behind each ref */
function ddgHome({ readOnlyFirst = false } = {}) {
  const nodes = new Map()
  const item = (ref, n, extra = {}) => { nodes.set(ref, n); return { ref, role: child.roleFor(n), label: child.labelFor(n), tag: String(n.tagName).toLowerCase(), href: n.getAttribute('href') ?? '', value: '', disabled: false, ...extra } }
  const box = node('TEXTAREA', { name: 'q', role: 'combobox', 'aria-label': 'DuckDuckGo로 검색', placeholder: '개인 정보 노출 없이 검색', autocomplete: 'off', 'aria-haspopup': 'listbox' }, { value: '' })
  const submit = node('BUTTON', { type: 'submit', 'aria-label': '검색' })
  const form = { getAttribute: name => ({ id: 'searchbox_homepage', role: 'search', 'aria-label': 'DuckDuckGo로 웹 검색', action: '/', method: 'GET' })[name] ?? null,
    elements: [node('INPUT', { type: 'hidden', name: 'ia' }, { value: 'web' }), node('INPUT', { type: 'hidden', name: 'origin' }, { value: 'funnel_home_website' }), box, submit] }
  form.elements.forEach(field => { field.form = form })
  const landmark = node('FORM', { id: 'searchbox_homepage', role: 'search', 'aria-label': 'DuckDuckGo로 웹 검색', action: '/', method: 'GET' }, { elements: form.elements })
  const elements = [
    item('el_2', node('A', { href: `https://${DDG}/`, 'aria-label': 'DuckDuckGo 홈' }), { href: `https://${DDG}/` }),
    item('el_4', node('DIV', { role: 'radiogroup', 'aria-label': '검색 모드' })),
    item('el_5', node('BUTTON', { type: 'button', role: 'radio', 'aria-checked': 'true' }, { innerText: '검색' }), { value: 'checked' }),
    item('el_6', node('BUTTON', { type: 'button', role: 'radio', 'aria-checked': 'false' }, { innerText: 'Duck.ai' }), { value: 'unchecked' }),
    ...(readOnlyFirst ? [item('el_6b', node('INPUT', { type: 'text', 'aria-label': '검색 기록', readonly: '' }, { readOnly: true, value: '' }))] : []),
    item('el_7', landmark),
    item('el_8', box),
    item('el_9', node('A', { href: `https://${DDG}/app`, 'aria-label': 'Mac용 DuckDuckGo 다운로드' }), { href: `https://${DDG}/app` }),
    item('el_20', node('A', { href: `https://${DDG}/mac`, 'aria-label': 'Mac용 DuckDuckGo 다운로드' }), { href: `https://${DDG}/mac` }),
  ]
  const boxItem = elements.find(e => e.ref === 'el_8')
  // the submit button shows once the box has text (the real home page lists none while it is empty); its GET facts are the child's own, from the box's value
  const button = { ref: 'el_10', role: child.roleFor(submit), label: child.labelFor(submit), tag: 'button', href: '', value: '', disabled: false, get nav() { box.value = boxItem.value; return child.navigationFacts(submit) } }
  nodes.set('el_10', submit)
  const page = { text: ['DuckDuckGo'], get elements() { return boxItem.value ? [...elements.slice(0, -2), button, ...elements.slice(-2)] : elements } }
  return { page, nodes, box: boxItem }
}

const ranked = (q, rows) => { const list = rows.filter(([value]) => value); return { name: q.name, type: 'choice', choice: list[0][0], confidence: list[0][1], probabilities: list.map(([value, probability]) => ({ value, probability })) } }
// the loop's decision model as the real one answered on this page: the value mappings chose the FIRST field listed (both requests at 19:27), the step's choice spread
// (Main's real-model replay of the home page: needs_free_text 0.43, [F1] 0.35, [F2] 0.12), after typing the read-only search led at 0.74 (L8b's measurement), the results page meets the goal
function homeModel(body) {
  const text = body.input.map(item => (typeof item.content === 'string' ? item.content : JSON.stringify(item.content))).join('\n')
  const onResults = /URL: https:\/\/duckduckgo\.com\/\?\S*q=/.test(text)
  return body.questions.map(q => {
    if (q.name === 'choice_requested') return { name: q.name, type: 'predicate', probability: 1 } // synthetic user requested this search
    if (q.type === 'predicate') return { name: q.name, type: 'predicate', probability: q.name === 'goal_met' ? (onResults ? 0.96 : 0.02) : 0.02 }
    const values = q.choices.map(choice => choice.value)
    const fields = values.filter(value => /^\[F\d+\]/.test(value))
    if (q.name === 'next_step') {
      if (/filled \[F\d+\]/.test(text)) return ranked(q, [[values.find(value => /^\[B\d+\] 검색$/.test(value)), 0.74], [fields[0], 0.14]])
      return ranked(q, [['needs_free_text', 0.43], [fields[0], 0.35], [fields[1], 0.12]])
    }
    if (/^field_\d+$/.test(q.name)) return ranked(q, [[fields[0], 0.9]])
    if (q.name === 'field_text') return ranked(q, [[values.find(value => value === '장화 신은 고양이') ?? values.at(-1), 0.97]])
    return ranked(q, [[values.at(-1), 0.95]])
  })
}
// the Card: a fill on a node the page actor would not fill is refused before any input, with the actor's own words; every fill is recorded
function card(w, nodes) {
  const fills = []
  const send = w.pw.transport.sendToUi.bind(w.pw.transport)
  w.pw.transport.sendToUi = async request => {
    if (request.kind === 'act' && request.action?.type === 'fill') {
      const target = nodes.get(request.action.ref)
      const refused = !child.isFillableControl(target)
      fills.push({ ref: request.action.ref, actor: request.actor ?? null, refused })
      if (refused) return { requestId: request.requestId, status: 'rejected', error: NOT_EDITABLE, dispatchPhase: 'not-dispatched', timing: {} }
    }
    return send(request)
  }
  return fills
}
const fieldsOf = snapshot => buildReflexCandidates(snapshot, { textComboboxes: true }).options.filter(option => option.item.kind === 'fill').map(option => [option.value, option.item.element.ref, option.item.element.tag])
const decisionChoices = (w, name) => w.decisionBodies.flatMap(body => body.questions.filter(q => q.name === name).map(q => q.choices.map(choice => choice.value)))

test('L6c: the search landmark of DuckDuckGo\'s home (<form role="search">) is no text field; its real box (<textarea role="combobox">) is the one field; an <input type="search"> stays a field', () => {
  const home = ddgHome()
  assert.deepEqual(home.page.elements.filter(e => ['el_7', 'el_8'].includes(e.ref)).map(e => [e.ref, e.role, e.tag]), [['el_7', 'search', 'form'], ['el_8', 'combobox', 'textarea']], 'the child\'s own reading')
  assert.equal(child.isFillableControl(home.nodes.get('el_7')), false, 'the page actor never fills the landmark')
  assert.equal(child.isFillableControl(home.nodes.get('el_8')), true)
  assert.deepEqual(fieldsOf({ url: `https://${DDG}/`, interactiveElements: home.page.elements }), [['[F1] DuckDuckGo로 검색', 'el_8', 'textarea']])
  // the objective loop without textComboboxes: no field at all (as before), the landmark is not one either
  assert.deepEqual(buildReflexCandidates({ url: `https://${DDG}/`, interactiveElements: home.page.elements }).options.filter(option => option.item.kind === 'fill'), [])
  const searchInput = { ref: 's', role: child.roleFor(node('INPUT', { type: 'search', 'aria-label': '사이트 검색' })), label: '사이트 검색', tag: 'input', href: '', value: '', disabled: false }
  assert.equal(searchInput.role, 'search')
  assert.deepEqual(fieldsOf({ url: `https://${DDG}/`, interactiveElements: [searchInput, { ...searchInput, ref: 'u', tag: undefined }] }).map(([, ref]) => ref), ['s', 'u'], 'an <input type=search>, and a snapshot without a tag, as before')
  assert.deepEqual(fieldsOf({ url: `https://${DDG}/`, interactiveElements: [{ ...searchInput, ref: 'd', tag: 'div' }] }), [], 'a <div role="search"> landmark neither')
})

test('L6c (replay of 19:27, values given): Claude\'s browser task types into the real box on the first try and runs the read-only search to done', async t => {
  const home = ddgHome()
  const w = world(t, { host: DDG, pages: () => ({ '/': home.page }), start: '/', hold: true, init: 'real', taskDecide: homeModel, cardSites: 'window' })
  const fills = card(w, home.nodes)
  const sent = await w.browserSend('덕덕고 카드에서 장화 신은 고양이 검색해줘'); await w.drain()
  const out = await callTool(w, BROWSER_TASK_TOOL_NAME, { goal: '장화 신은 고양이 검색', values: { 검색어: '장화 신은 고양이' } })
  assert.equal(out.status, 'done', JSON.stringify(out))
  assert.deepEqual(fills, [{ ref: 'el_8', actor: 'decision', refused: false }], 'one fill, into the box, never the landmark')
  assert.match(w.pw.state.cur.href ?? '', /^https:\/\/duckduckgo\.com\/\?ia=web&origin=funnel_home_website&q=%EC%9E%A5%ED%99%94/, 'the read-only GET search ran')
  assert.ok(decisionChoices(w, 'field_0').every(choices => !choices.some(value => /웹 검색/.test(value))), 'the landmark was never offered as a field')
  await w.drain()
  assert.doesNotMatch(JSON.stringify(w.events.filter(event => JSON.stringify(event).includes('browser.tool.failed'))), /not-editable/)
  // the conversation model's own page tools go on in the same run
  const read = await callTool(w, 'egdesk_card_read', { mode: 'structure' })
  assert.equal(read.status, 'read', JSON.stringify(read))
  w.transports.at(-1).finish(); await w.settled(sent)
})

test('L6c (replay, no values: the step\'s choice spread with needs_free_text on top): the typing step is not turned into a question about two alike links; the box gets the person\'s words, then done', async t => {
  const home = ddgHome()
  const w = world(t, { host: DDG, pages: () => ({ '/': home.page }), start: '/', hold: true, init: 'real', taskDecide: homeModel, cardSites: 'window' })
  const fills = card(w, home.nodes)
  const sent = await w.browserSend('덕덕고 카드에서 장화 신은 고양이 검색해줘'); await w.drain()
  const out = await callTool(w, BROWSER_TASK_TOOL_NAME, { goal: '장화 신은 고양이 검색' })
  assert.equal(out.status, 'done', JSON.stringify(out))
  assert.deepEqual(fills.map(fill => [fill.ref, fill.refused]), [['el_8', false]])
  assert.equal(decisionChoices(w, 'field_text').length, 1, 'the span question once')
  w.transports.at(-1).finish(); await w.settled(sent)
})

test('L6c (safeguard): a field the page actor refuses as not editable leaves the task\'s fields; the value is decided anew among the others on a new observation, typed once, done', async t => {
  // a read-only input listed before the box: the candidate rule reads it as a text field, the actor does not (readOnly)
  const home = ddgHome({ readOnlyFirst: true })
  assert.deepEqual(fieldsOf({ url: `https://${DDG}/`, interactiveElements: home.page.elements }).map(([, ref]) => ref), ['el_6b', 'el_8'])
  const w = world(t, { host: DDG, pages: () => ({ '/': home.page }), start: '/', hold: true, init: 'real', taskDecide: homeModel, cardSites: 'window' })
  const fills = card(w, home.nodes)
  const sent = await w.browserSend('덕덕고 카드에서 장화 신은 고양이 검색해줘'); await w.drain()
  const out = await callTool(w, BROWSER_TASK_TOOL_NAME, { goal: '장화 신은 고양이 검색', values: { 검색어: '장화 신은 고양이' } })
  assert.equal(out.status, 'done', JSON.stringify(out))
  assert.deepEqual(fills.map(fill => [fill.ref, fill.refused]), [['el_6b', true], ['el_8', false]], 'refused once, then the box: typed once')
  const mappings = decisionChoices(w, 'field_0')
  assert.equal(mappings.length, 2)
  assert.ok(mappings[0].some(value => /검색 기록/.test(value)) && !mappings[1].some(value => /검색 기록/.test(value)), 'the refused field is not offered again')
  await w.drain()
  const failed = JSON.stringify(w.events.filter(event => JSON.stringify(event).includes('browser.tool.failed')))
  assert.match(failed, /"staleBy":"target"/); assert.match(failed, /"targetBy":"not-editable"/)
  w.transports.at(-1).finish(); await w.settled(sent)
})

// the loop alone: the provider's step error carries targetBy; which refusals take the field out, and for how long
function loopRun({ targetBy = 'not-editable', resumeState = null, documentId = 'doc-1', maxSteps = 4 } = {}) {
  const snap = { url: 'https://example.invalid/form', documentId, revision: 1, text: ['Form'], viewport: { width: 1280, height: 800 }, interactiveElements: [
    { ref: 'f_1', role: 'textbox', label: 'Shown', tag: 'input', href: '', value: '', disabled: false },
    { ref: 'f_2', role: 'textbox', label: 'Name', tag: 'input', href: '', value: '', disabled: false }] }
  const usage = { inputTokens: 1, cachedTokens: 0, cacheWriteTokens: 0, outputTokens: 0, totalTokens: 1 }
  let observed = 0
  const fills = [], mapped = []
  const answer = value => ({ type: 'choice', choice: value, confidence: 0.9, probabilities: [{ value, probability: 0.9 }] })
  const client = { async decide(request) {
    const answers = Object.create(null)
    for (const q of request.questions) {
      if (q.name.startsWith('ps_')) { answers[q.name] = pageStateAnswers('content', 0.9)[q.name]; continue }
      if (/^field_\d+$/.test(q.name)) { mapped.push(q.choices.map(choice => choice.value).filter(value => /^\[F/.test(value))); answers[q.name] = answer(q.choices[0].value); continue }
      if (q.name === 'next_step') { answers[q.name] = answer('scroll_more'); continue }
      answers[q.name] = { type: 'predicate', probability: q.name === 'goal_met' && fills.some(fill => fill.ok) ? 0.96 : 0.05 }
    }
    return { answers, model: 'gpt-6-luna', usage, latencyMs: 100 }
  } }
  const callTool = async (name, args) => {
    if (name === 'egdesk_browser_observe') { observed++; return { status: 'observed', cardId: args.cardId, observationId: `obs-${observed}`, snapshot: { ...snap, revision: observed } } }
    if (name !== 'egdesk_browser_fill') return { status: 'observed' }
    const refused = args.ref === 'f_1'
    fills.push({ ref: args.ref, ok: !refused })
    if (refused) throw Object.assign(new Error('Browser reflex step failed'), { code: 'BROWSER_OBSERVATION_STALE', staleBy: 'target', ...(targetBy ? { targetBy } : {}) })
    return { status: 'postcondition-observed' }
  }
  return runBrowserReflex({ cardId: 'c', goal: 'Fill in the name', values: { 이름: 'synthetic' }, callTool, client, maxSteps, valuesFirst: true, resumeState }).then(result => ({ result, fills, mapped }))
}

test('L6c, the loop: a not-editable refusal takes that field out for the task (kept in the resumable state, per document); any other target refusal is decided anew as before', async () => {
  const out = await loopRun()
  assert.deepEqual(out.fills, [{ ref: 'f_1', ok: false }, { ref: 'f_2', ok: true }])
  assert.deepEqual(out.mapped, [['[F1] Shown', '[F2] Name'], ['[F2] Name']], 'the second mapping offers only the other field')
  assert.equal(out.result.steps[0].rule, 'fill_not_sent'); assert.equal(out.result.steps[0].notEditable, true)
  assert.deepEqual(out.result.state.notEditable, ['d:doc-1|f_1'])
  // the L6 rule, unchanged: a target refusal of another kind (value) may land on the same field again; once per value
  const other = await loopRun({ targetBy: 'value' })
  assert.deepEqual(other.mapped, [['[F1] Shown', '[F2] Name'], ['[F1] Shown', '[F2] Name']])
  assert.deepEqual(other.fills, [{ ref: 'f_1', ok: false }, { ref: 'f_1', ok: false }])
  assert.equal(other.result.state.notEditable, undefined, 'no new state key unless a field was refused as not editable')
  // a resumed task keeps it out on the same document; a new document lists it again (the child's refs are per document)
  const first = await loopRun({ maxSteps: 1 })
  assert.deepEqual(first.result.state.notEditable, ['d:doc-1|f_1'])
  const resumed = await loopRun({ resumeState: { ...first.result.state, pending: [['이름', 'synthetic']], assigned: [], attemptedRefs: [] } })
  assert.deepEqual(resumed.mapped[0], ['[F2] Name'])
  const elsewhere = await loopRun({ resumeState: { ...first.result.state, pending: [['이름', 'synthetic']], assigned: [], attemptedRefs: [] }, documentId: 'doc-2' })
  assert.deepEqual(elsewhere.mapped[0], ['[F1] Shown', '[F2] Name'])
})

test('L6c, the step: needs_free_text on top of a page with a text field stays undecided (no alike-links question); without any field the alike question is asked as before', async () => {
  const usage = { inputTokens: 1, cachedTokens: 0, cacheWriteTokens: 0, outputTokens: 0, totalTokens: 1 }
  const client = { async decide(request) {
    const answers = Object.create(null)
    for (const q of request.questions) {
      if (q.name.startsWith('ps_')) { answers[q.name] = pageStateAnswers('content', 0.9)[q.name]; continue }
      if (q.name === 'next_step') { const fields = q.choices.map(c => c.value).filter(v => /^\[F/.test(v)); answers[q.name] = { type: 'choice', choice: 'needs_free_text', confidence: 0.43, probabilities: [{ value: 'needs_free_text', probability: 0.43 }, ...(fields[0] ? [{ value: fields[0], probability: 0.35 }] : [])] }; continue }
      answers[q.name] = { type: 'predicate', probability: 0.02 }
    }
    return { answers, model: 'gpt-6-luna', usage, latencyMs: 100 }
  } }
  const home = ddgHome()
  const snapshot = { url: `https://${DDG}/`, documentId: 'd', revision: 1, text: ['DuckDuckGo'], interactiveElements: home.page.elements }
  const withField = buildReflexCandidates(snapshot, { textComboboxes: true }).options
  const step = await decideReflexStep({ goal: '장화 신은 고양이 검색', snapshot, options: withField, client, thresholds: decisionThresholds() })
  assert.equal(step.kind, 'uncertain', JSON.stringify(step))
  const noField = withField.filter(option => option.item.kind !== 'fill')
  const asked = await decideReflexStep({ goal: '장화 신은 고양이 검색', snapshot, options: noField, client, thresholds: decisionThresholds() })
  assert.equal(asked.kind, 'user_context')
  assert.equal(asked.candidates.length, 2, 'the two alike links, as before')
})
