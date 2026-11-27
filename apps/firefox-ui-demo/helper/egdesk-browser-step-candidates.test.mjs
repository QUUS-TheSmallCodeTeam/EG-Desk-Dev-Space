// L8b a2 (real window 2026-11-26 17:27 KST, EGDESK_BROWSER_ENTRY=alternate, page text off): "덕덕고 카드에서 장화 신은 고양이 검색해줘" on the DuckDuckGo Card. The entry entered
// (browser_entry 1.0), its first step held (next_step top 0.52, second 0.21, 47 options) and the conversation model did the whole request (23.4 s). Found by replaying the Card's
// controls (egdesk-ddg-live-controls.fixture.mjs) through the product code and the real model (report l8b-a2):
//  1. DuckDuckGo's search box is an <input role="combobox">: the loop never offered it (a combobox was a text field only on a <textarea>), so no option could type the search;
//  2. with no option that types, the choice spread over the controls that look like search (the form wrapper 0.34-0.53, the 검색 button 0.33, needs_free_text);
//  3. two links with one name ("Duck.ai") turned an undecided TYPING step (and the search after it) into "which of these two?";
//  4. after typing, the read-only search was the top choice at 0.74 / 0.65 (bar 0.75).
// A crowded step stays ONE choice: a fan-out by kind (tried, measured) dropped link steps under the bar ("이미지 탭 열어줘" 0.84 -> 0.66).
// Synthetic: the observed controls, page doubles, fake decision answers (shaped like the measured ones), the real objective loop and entry; no Firefox, no engine.
import test from 'node:test'
import assert from 'node:assert/strict'
import { createDecisionClient, decisionTopicRecipient } from './egdesk-decision-client.mjs'
import { buildReflexCandidates, decideReflexStep, runBrowserReflex, typedSearch, withoutPageText } from './egdesk-browser-reflex.mjs'
import { createBrowserTaskStore, createDirectBrowserEntry } from './egdesk-browser-task.mjs'
import { undecidedField } from './egdesk-browser-field-text.mjs'
import { decisionThresholds } from './egdesk-decision-questions.mjs'
import { DDG_LIVE_ROWS, ddgResultsSnapshot } from './egdesk-ddg-live-controls.fixture.mjs'
import { pageStateWire } from './egdesk-browser-page-state.fixture.mjs'

const D = 'https://duckduckgo.com'
const MESSAGE = '덕덕고 카드에서 장화 신은 고양이 검색해줘'
const QUERY = '장화 신은 고양이'
const FIELD = '[F1] 개인 정보 노출 없이 검색'
const T = decisionThresholds()
const ranked = (name, rows) => ({ name, type: 'choice', choice: rows[0][0], confidence: rows[0][1], probabilities: rows.map(([value, probability]) => ({ value, probability })) })
const content = () => Object.fromEntries(pageStateWire('content').map(answer => [answer.name, answer]))
const fakeClient = answer => { const requests = []; return { requests, decide: async request => { requests.push(request); return { answers: { ...content(), ...answer(request) }, usage: null, latencyMs: 1 } } } }

test('a2 the replayed Card: the search box is an <input> combobox; the loop offers it as a text field only where text comboboxes are asked for, and the page text flag changes no option', () => {
  assert.equal(DDG_LIVE_ROWS.length, 80)
  const snapshot = ddgResultsSnapshot()
  const box = snapshot.interactiveElements.find(element => element.ref === 'el_3')
  assert.deepEqual([box.role, box.tag, box.label], ['combobox', 'input', '개인 정보 노출 없이 검색'])
  const plain = buildReflexCandidates(snapshot)
  const asked = buildReflexCandidates(snapshot, { textComboboxes: true })
  assert.equal(plain.options.some(option => option.item.kind === 'fill'), false, 'the objective loop without the option: still the person\'s')
  assert.ok(plain.personOnly.some(control => control.role === 'combobox'))
  assert.deepEqual(asked.options.filter(option => option.item.kind === 'fill').map(option => [option.value, option.description]), [[FIELD, `text field, current value: ${QUERY}`]])
  assert.equal(asked.personOnly.some(control => control.role === 'combobox'), false)
  // 39 element options (18 same-site links, 21 labelled buttons and clickables) + the field = 40; the real step had 42 (+5 controls = 47) on the page it saw
  assert.deepEqual([plain.options.length, asked.options.length], [39, 40])
  assert.equal(asked.offSite.length, 6, 'result links to other sites are never options (the first six are kept for guidance)')
  // the page text flag decides what the step READS, never what it may choose: the options come from the real snapshot either way
  assert.deepEqual(buildReflexCandidates(withoutPageText(snapshot), { textComboboxes: true }).options.map(option => option.value), asked.options.map(option => option.value))
  // a <select> stays the person's, and so does a combobox that is neither an input nor a textarea (a custom list)
  const lists = buildReflexCandidates({ url: `${D}/`, interactiveElements: [{ ref: 's', role: 'combobox', tag: 'select', label: '지역', href: '', value: '' }, { ref: 'c', role: 'combobox', tag: 'div', label: '정렬', href: '', value: '' }] }, { textComboboxes: true })
  assert.deepEqual([lists.options.length, lists.personOnly.map(control => control.label)], [0, ['지역', '정렬']])
})

test('a2 a crowded step is still ONE choice over all its options (the request as before, now with the search box among them)', async () => {
  const snapshot = ddgResultsSnapshot()
  const { options } = buildReflexCandidates(snapshot, { textComboboxes: true })
  const client = fakeClient(() => ({ next_step: ranked('next_step', [['goal_met', 0.6], [FIELD, 0.2]]), goal_met: { name: 'goal_met', type: 'predicate', probability: 0.97 } }))
  const out = await decideReflexStep({ goal: MESSAGE, snapshot: withoutPageText(snapshot), options, client, thresholds: T })
  const choices = client.requests[0].questions.filter(q => q.type === 'choice')
  assert.deepEqual(choices.map(q => [q.name, q.choices.length]), [['next_step', 45]])
  assert.equal(choices[0].choices[2].value, FIELD)
  assert.equal(out.kind, 'done')
})

test('a2 an undecided TYPING step is not a "which of these alike elements" question; an undecided step over alike elements still is', async () => {
  const page = { url: `${D}/`, revision: 1, title: 'DuckDuckGo', text: [], interactiveElements: [
    { ref: 'q', role: 'combobox', tag: 'input', label: '검색', href: '', value: '' },
    { ref: 'a', role: 'link', tag: 'a', label: 'Duck.ai', href: `${D}/?ia=chat`, value: '' },
    { ref: 'b', role: 'link', tag: 'a', label: 'Duck.ai', href: `${D}/chat`, value: '' }] }
  const { options } = buildReflexCandidates(page, { textComboboxes: true })
  const no = { goal_met: { name: 'goal_met', type: 'predicate', probability: 0.02 } }
  const typing = await decideReflexStep({ goal: MESSAGE, snapshot: page, options, client: fakeClient(() => ({ ...no, next_step: ranked('next_step', [['[F1] 검색', 0.55], ['needs_free_text', 0.3]]) })), thresholds: T })
  assert.equal(typing.kind, 'uncertain')
  const alike = await decideReflexStep({ goal: 'Duck.ai 열어줘', snapshot: page, options, client: fakeClient(() => ({ ...no, next_step: ranked('next_step', [['[L1] Duck.ai', 0.5], ['[L2] Duck.ai', 0.45]]) })), thresholds: T })
  assert.deepEqual([alike.kind, alike.candidates], ['user_context', ['[L1] Duck.ai', '[L2] Duck.ai']])
  // the search of the text this run typed is exempt as well (only with that text: the same answer without it asks which)
  const typedPage = { ...page, interactiveElements: [...page.interactiveElements.map(element => (element.ref === 'q' ? { ...element, value: QUERY } : element)),
    { ref: 's', role: 'button', tag: 'button', label: '검색', href: '', value: '', nav: { type: 'submit', sensitiveRegion: false, regionLabel: '', form: { method: 'get', fields: ['text'], sensitive: false, submitUrl: `${D}/?q=${encodeURIComponent(QUERY)}` }, controls: null } }] }
  const typedOptions = buildReflexCandidates(typedPage, { textComboboxes: true }).options
  const after = answers => fakeClient(() => ({ ...no, next_step: ranked('next_step', [['[B1] 검색', 0.65], ['[F1] 검색', 0.28]]) }))
  assert.equal((await decideReflexStep({ goal: MESSAGE, snapshot: typedPage, options: typedOptions, typedTexts: [QUERY], client: after(), thresholds: T })).kind, 'uncertain')
  assert.equal((await decideReflexStep({ goal: MESSAGE, snapshot: typedPage, options: typedOptions, client: after(), thresholds: T })).kind, 'user_context')
})

test('a2 undecidedField: a text field in the top two, else the page\'s only text field (soleField), else none', () => {
  assert.equal(undecidedField({ ranked: [{ value: '[B1] x', probability: 0.5 }, { value: '[F2] 이름', probability: 0.3 }], soleField: '[F1] 검색' }), '[F2] 이름')
  assert.equal(undecidedField({ ranked: [{ value: '[B1] x', probability: 0.5 }, { value: 'scroll_more', probability: 0.3 }, { value: '[F1] 검색', probability: 0.1 }], soleField: '[F1] 검색' }), '[F1] 검색')
  assert.equal(undecidedField({ ranked: [{ value: '[B1] x', probability: 0.5 }] }), null)
  assert.equal(undecidedField({ ranked: [], soleField: 'goal_met' }), null)
})

test('a2 typedSearch: only a read-only GET search that submits exactly a text this run typed', () => {
  const press = (url, kind = 'get_form') => ({ item: { kind: 'press', readOnly: { kind, url } } })
  assert.equal(typedSearch(press(`${D}/?q=${encodeURIComponent(QUERY)}`), [QUERY]), true)
  assert.equal(typedSearch(press(`${D}/?q=${encodeURIComponent(QUERY)}&t=h_`), [QUERY]), true)
  assert.equal(typedSearch(press(`${D}/?q=`), [QUERY]), false, 'the search of an empty box')
  assert.equal(typedSearch(press(`${D}/?q=other`), [QUERY]), false)
  assert.equal(typedSearch(press(`${D}/?q=${encodeURIComponent(QUERY)}`, 'view'), [QUERY]), false)
  assert.equal(typedSearch({ item: { kind: 'navigate' } }, [QUERY]), false)
  assert.equal(typedSearch(press(`${D}/?q=${encodeURIComponent(QUERY)}`), []), false, 'nothing typed in this run')
})

// ---- the real-window request through the alternate entry (fieldText on), the real loop, page text off; answers shaped like the measured real ones ----
function duckCard({ crowded = false, searchTop = 0.74 } = {}) {
  let cur = { url: `${D}/`, revision: 1, value: '' }
  const calls = [], requests = []
  const extra = crowded ? Array.from({ length: 34 }, (_, i) => (i % 2 ? { ref: `b${i}`, role: 'button', tag: 'button', label: `도움말 ${i}`, href: '', value: '', nav: { type: 'button', sensitiveRegion: false, regionLabel: '', form: null, controls: null } }
    : { ref: `h${i}`, role: 'link', tag: 'a', label: `소개 ${i}`, href: `${D}/about/${i}`, value: '' })) : []
  const home = () => {
    const s = ddgResultsSnapshot({ value: cur.value, revision: cur.revision })
    const keep = ['el_1', 'el_2', 'el_3', 'el_4', 'el_12', 'el_14', 'el_78']
    const elements = s.interactiveElements.filter(element => keep.includes(element.ref)).map(element => (element.ref === 'el_4' ? { ...element, nav: { ...element.nav, form: { ...element.nav.form, submitUrl: `${D}/?q=${encodeURIComponent(cur.value)}` } } } : element))
    return { ...s, url: cur.url, title: 'DuckDuckGo', interactiveElements: [...elements, ...extra] }
  }
  const snapshot = () => (new URL(cur.url).searchParams.get('q') === null ? home() : { ...ddgResultsSnapshot({ revision: cur.revision }), url: cur.url })
  const callTool = async (name, args) => {
    calls.push(name)
    if (name === 'egdesk_browser_observe') return { observationId: `o${calls.length}`, snapshot: snapshot() }
    if (name === 'egdesk_browser_fill') { cur = { ...cur, value: args.text, revision: cur.revision + 1 }; return { status: 'postcondition-observed' } }
    if (name === 'egdesk_browser_navigate') {
      cur = { url: `${args.url}&ia=web`, revision: cur.revision + 1, value: '' }
      const error = new Error('url postcondition not observed'); error.code = 'TOOL_FAILED'; throw error // DuckDuckGo extends the address (a1)
    }
    return { status: 'wait-condition-met' }
  }
  const client = createDecisionClient({ recipientForKey: (value, endpoint, model) => decisionTopicRecipient(value, 1, endpoint, model), getApiKey: async () => 'egd-synthetic-not-a-key-a2',
    fetchImpl: async (_e, { body }) => {
      const request = JSON.parse(body)
      requests.push(request)
      const evidence = request.input.map(item => item.content).join('\n')
      const names = request.questions.map(q => q.name)
      const answers = []
      if (names.includes('browser_entry')) for (const q of request.questions) answers.push({ name: q.name, type: 'predicate', probability: q.name === 'browser_entry_answer' ? 0.02 : 0.97 })
      else if (names.includes('field_text')) answers.push(ranked('field_text', [[QUERY, 0.97], [request.questions[0].choices.at(-1).value, 0.01]]))
      else if (names.includes('next_step')) {
        const onResults = /URL: https:\/\/duckduckgo\.com\/\?q=/.test(evidence)
        const typed = /filled \[F1\]/.test(evidence)
        // measured (real gpt-6-luna, l8b-a2): the field at 0.61 (short page) / 0.55 (crowded); after typing the search at 0.74 / 0.65; the results page: goal met
        const pick = onResults ? [['goal_met', 0.61], [FIELD, 0.16]] : typed ? [['[B2] 검색', crowded && searchTop === 0.74 ? 0.65 : searchTop], [FIELD, crowded ? 0.28 : 0.14]] : [[FIELD, crowded ? 0.55 : 0.61], ['[B1] react-search-form', 0.15]]
        answers.push(ranked('next_step', pick), ...pageStateWire('content'), { name: 'goal_met', type: 'predicate', probability: onResults ? 0.97 : 0.01 })
      } else for (const q of request.questions) answers.push(q.type === 'choice' ? ranked(q.name, [[q.choices[0].value, 0.9]]) : { name: q.name, type: 'predicate', probability: 0.02 })
      return { ok: true, text: async () => JSON.stringify({ answers }) }
    } })
  const provider = { directEntryEnabled: () => true, reflexScope: () => ({ client, callTool, isDecisionCurrent: () => true, authorizeDispatch: undefined }), runDirectTask: (run, args) => runBrowserReflex({ ...args, callTool, client }) }
  const run = { runId: 'r', browserBinding: { cards: [{ cardId: 'card', permission: 'interact' }] } }
  return { provider, run, calls, requests, get cur() { return cur } }
}

for (const crowded of [false, true]) {
  test(`a2 the real-window request on a ${crowded ? 'crowded' : 'short'} DuckDuckGo home: entry -> the field (undecided, top choice) -> the chosen span typed -> the search of that text -> done`, async () => {
    const w = duckCard({ crowded })
    const steps = []
    const entry = createDirectBrowserEntry({ provider: w.provider, store: createBrowserTaskStore(), fieldText: () => true, onStepEvent: (_run, event) => steps.push(event) })
    const out = await entry.handle({ run: w.run, conversationKey: 'dm', message: MESSAGE, hosts: { card: 'duckduckgo.com' }, titles: { card: 'DuckDuckGo' } })
    assert.equal(out.status, 'done')
    assert.deepEqual(steps.filter(event => event.op !== 'end').map(event => [event.op, event.target, event.ok]), [['fill', '개인 정보 노출 없이 검색', true], ['submit', '검색', true]])
    assert.equal(new URL(w.cur.url).searchParams.get('q'), QUERY)
    const stepRequests = w.requests.filter(request => request.questions.some(q => q.name === 'next_step'))
    assert.equal(stepRequests.length, 3)
    assert.deepEqual(stepRequests[0].questions.filter(q => q.type === 'choice').map(q => q.name), ['next_step'], 'one choice, crowded or not')
    if (crowded) assert.ok(stepRequests[0].questions[0].choices.length > 40, 'the crowded home offers every element')
    assert.equal(stepRequests[0].questions.find(q => q.name === 'next_step').choices.some(choice => choice.value === FIELD), true, 'the search box is an option')
    for (const request of stepRequests) assert.match(request.input[1].content, /the page's own text is not sent/, 'page text off (the default)')
    assert.equal(w.requests.filter(request => request.questions.some(q => q.name === 'field_text')).length, 1)
  })
}

test('a2 the typed-search rule needs the search to be the top choice: a short page whose top after typing is another control pauses as before', async () => {
  const w = duckCard({ searchTop: 0.1 }) // the search now ranks under the field (0.14)
  const out = await createDirectBrowserEntry({ provider: w.provider, store: createBrowserTaskStore(), fieldText: () => true }).handle({ run: w.run, conversationKey: 'dm', message: MESSAGE, hosts: { card: 'duckduckgo.com' } })
  assert.equal(out.status, 'paused')
  assert.equal(w.calls.includes('egdesk_browser_navigate'), false, 'nothing submitted')
})
