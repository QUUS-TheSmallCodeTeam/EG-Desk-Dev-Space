import { requestedSiteEvidence } from './egdesk-browser-authority.mjs'
// L8b a2 (real window 2026-11-26 17:27 KST, EGDESK_BROWSER_ENTRY=alternate, page text off): "덕덕고 카드에서 장화 신은 고양이 검색해줘" on the DuckDuckGo Card. The entry entered
// (browser_entry 1.0), its first step held (next_step top 0.52, second 0.21, 47 options) and the conversation model did the whole request (23.4 s). Found by replaying the Card's
// controls (egdesk-ddg-live-controls.fixture.mjs) through the product code and the real model (report l8b-a2):
//  1. DuckDuckGo's search box is an <input role="combobox">: the loop never offered it (a combobox was a text field only on a <textarea>), so no option could type the search;
//  2. a long page asks one choice over 40+ options and the answer spreads; a crowded step is now fanned out by the kind of action in the same request;
//  3. two links with one name ("Duck.ai") turned an undecided TYPING step into "which of these two?";
//  4. after typing, the read-only search was the top choice at 0.74 (bar 0.75) on the short home page.
// Synthetic: the observed controls, page doubles, fake decision answers (shaped like the measured ones), the real objective loop and entry; no Firefox, no engine.
import test from 'node:test'
import assert from 'node:assert/strict'
import { createDecisionClient, decisionTopicRecipient } from './egdesk-decision-client.mjs'
import { CROWDED_STEP_OPTIONS, STEP_GROUPS, buildReflexCandidates, crowdedStep, decideReflexStep, runBrowserReflex, typedSearch, withoutPageText } from './egdesk-browser-reflex.mjs'
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

test('a2 a crowded step is fanned out in one request: the decisive options and one option per other kind, each kind\'s targets its own question; a short page is asked as before', async () => {
  const snapshot = ddgResultsSnapshot()
  const { options } = buildReflexCandidates(snapshot, { textComboboxes: true })
  const fan = crowdedStep(options)
  assert.ok(options.length > CROWDED_STEP_OPTIONS && fan)
  assert.deepEqual(fan.direct.map(option => option.value), [FIELD, '[B2] 검색'])
  assert.deepEqual([fan.groups.open_link.length, fan.groups.press_other.length], [18, 20])
  const client = fakeClient(() => ({ next_step: ranked('next_step', [['goal_met', 0.6], [FIELD, 0.2]]), goal_met: { name: 'goal_met', type: 'predicate', probability: 0.97 } }))
  const out = await decideReflexStep({ goal: MESSAGE, snapshot: withoutPageText(snapshot), options, client, thresholds: T })
  const [request] = client.requests
  const questions = Object.fromEntries(request.questions.map(q => [q.name, q]))
  assert.deepEqual(questions.next_step.choices.map(choice => choice.value), [FIELD, '[B2] 검색', 'open_link', 'press_other', 'scroll_more', 'goal_met', 'needs_free_text', 'needs_user_context', 'blocked'])
  assert.deepEqual([questions.step_link.choices.length, questions.step_press.choices.length], [18, 20])
  assert.equal(questions.step_link.instructions, STEP_GROUPS.open_link.ask)
  assert.equal(out.kind, 'done')
  // a page of at most CROWDED_STEP_OPTIONS element options: one choice over all of them, no target questions (the request as before)
  const short = { url: `${D}/`, revision: 1, title: 'DuckDuckGo', text: [], interactiveElements: ddgResultsSnapshot({ value: '' }).interactiveElements.filter(element => ['el_1', 'el_2', 'el_3', 'el_4', 'el_12', 'el_14', 'el_78'].includes(element.ref)) }
  const few = buildReflexCandidates(short, { textComboboxes: true }).options
  assert.equal(crowdedStep(few), null)
  const small = fakeClient(() => ({ next_step: ranked('next_step', [[FIELD, 0.9], ['needs_free_text', 0.05]]), goal_met: { name: 'goal_met', type: 'predicate', probability: 0.02 } }))
  await decideReflexStep({ goal: MESSAGE, snapshot: withoutPageText(short), options: few, client: small, thresholds: T })
  assert.deepEqual(small.requests[0].questions.filter(q => q.type === 'choice').map(q => [q.name, q.choices.length]), [['next_step', few.length + 5]])
})

test('a2 the fanned answer: a kind is taken only when next_step decided it and its own question decided one target; otherwise undecided with the targets ranked', async () => {
  const snapshot = ddgResultsSnapshot()
  const { options } = buildReflexCandidates(snapshot, { textComboboxes: true })
  const no = { goal_met: { name: 'goal_met', type: 'predicate', probability: 0.02 } }
  const ask = async answers => decideReflexStep({ goal: '이미지 탭 열어줘', snapshot: withoutPageText(snapshot), options, client: fakeClient(() => ({ ...no, ...answers })), thresholds: T })
  const decided = await ask({ next_step: ranked('next_step', [['open_link', 0.9], [FIELD, 0.05]]), step_link: ranked('step_link', [['[L3] 이미지', 0.95], ['[L4] 동영상', 0.02]]), step_press: ranked('step_press', [['[B1] react-search-form', 0.5], ['[B4] 검색 설정', 0.3]]) })
  assert.deepEqual([decided.kind, decided.option?.value, decided.next.fan.group], ['act', '[L3] 이미지', 'open_link'])
  assert.ok(Math.abs(decided.next.confidence - 0.9 * 0.95) < 1e-9)
  const unsure = await ask({ next_step: ranked('next_step', [['open_link', 0.9], [FIELD, 0.05]]), step_link: ranked('step_link', [['[L3] 이미지', 0.5], ['[L4] 동영상', 0.4]]), step_press: ranked('step_press', [['[B1] react-search-form', 0.5], ['[B4] 검색 설정', 0.3]]) })
  // undecided; on this page the c16 rule then asks which of its alike elements (two "namu.wiki 도메인 검색" links), with the targets ranked by kind x target
  assert.deepEqual([unsure.kind, unsure.candidates], ['user_context', ['[L8] namu.wiki 도메인 검색', '[L9] namu.wiki 도메인 검색']])
  assert.deepEqual(unsure.ranked.map(row => row.value), ['[L3] 이미지', '[L4] 동영상', FIELD])
  const weakKind = await ask({ next_step: ranked('next_step', [['open_link', 0.6], ['scroll_more', 0.3]]), step_link: ranked('step_link', [['[L3] 이미지', 0.99], ['[L4] 동영상', 0.01]]), step_press: ranked('step_press', [['[B1] react-search-form', 0.5], ['[B4] 검색 설정', 0.3]]) })
  assert.notEqual(weakKind.kind, 'act', 'the kind itself was not decided')
  const direct = await ask({ next_step: ranked('next_step', [['[B2] 검색', 0.93], [FIELD, 0.07]]), step_link: ranked('step_link', [['[L1] DuckDuckGo home', 0.4], ['[L2] 모두', 0.3]]), step_press: ranked('step_press', [['[B1] react-search-form', 0.9], ['[B4] 검색 설정', 0.05]]) })
  assert.deepEqual([direct.kind, direct.option?.value], ['act', '[B2] 검색'], 'a decisive option is taken as itself; the other kinds\' answers do not matter')
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
function duckCard({ crowded = false, searchTop = 0.74, goalOnResults = true, more = false, mismatch = false, settledIntent = false } = {}) {
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
      cur = { url: mismatch ? `${D}/?q=wrong` : `${args.url}&ia=web`, revision: cur.revision + 1, value: '' }
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
        // measured (real gpt-6-luna, l8b-a2): home 0.61 / 0.49 (crowded) for the field; after typing the search at 0.74 (short page) / 0.92 (crowded); the results page: goal met
        const pick = onResults ? (more ? [['scroll_more', 0.98], [FIELD, 0.01]] : [['goal_met', 0.61], [FIELD, 0.16]]) : typed ? [['[B2] 검색', crowded ? 0.92 : searchTop], [FIELD, 0.14]] : [[FIELD, crowded ? 0.49 : 0.61], ['[B1] react-search-form', 0.15]]
        answers.push(ranked('next_step', pick), ...pageStateWire('content'), { name: 'goal_met', type: 'predicate', probability: onResults && goalOnResults ? 0.97 : 0.01 })
        if (names.includes('search_only')) answers.push({ name: 'search_only', type: 'predicate', probability: settledIntent && !more ? .99 : .01 })
        if (names.includes('arrival_finishes')) answers.push({ name: 'arrival_finishes', type: 'predicate', probability: more || settledIntent ? 0.01 : 0.98 })
        for (const q of request.questions.filter(item => /^step_/.test(item.name))) answers.push(ranked(q.name, [[q.choices[0].value, 0.6], [q.choices[1].value, 0.2]]))
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
    assert.equal(stepRequests[0].questions.some(q => q.name === 'step_link'), crowded, 'the crowded home is fanned out')
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

for (const [what, opts, goal, expected] of [
  ['search alone', {}, MESSAGE, 'done'],
  ['resolved value, landing judgment undecided', { settledIntent: true }, '비 올 때 쓰는 거 검색해줘', 'done'],
  ['more browser work', { more: true }, MESSAGE + ', 아래로 내려줘', 'max_steps'],
  ['wrong query landed', { mismatch: true, settledIntent: true }, MESSAGE, 'escalated'],
]) test(`b verified GET landing: ${what}`, async () => {
  const w = duckCard({ goalOnResults: false, ...opts })
  const out = await w.provider.runDirectTask(w.run, { cardId: 'card', goal, maxSteps: 3, ...(opts.settledIntent ? { resumeState: { pending: [] } } : {}), values: { [FIELD]: opts.settledIntent ? '우산' : QUERY }, valuesFirst: true, textComboboxes: true, pageText: false })
  assert.equal(out.outcome, expected)
  if (opts.settledIntent && !opts.mismatch) assert.equal(new URL(w.cur.url).searchParams.get('q'), '우산')
  if (opts.more) assert.ok(w.calls.includes('egdesk_browser_scroll'))
  assert.equal(out.steps.some(s => s.rule === 'search_arrived'), expected === 'done')
  assert.equal(w.requests.some(r => r.questions.some(q => q.name === 'arrival_finishes')), !opts.mismatch)
})

for (const [status, mode, reason] of [
  ['site-allowed', 'normal', undefined], ['site-refused', 'normal', 'site_not_allowed'],
  ['site-pending', 'normal', 'site_pending'], ['site-allowed', 'gone', 'tool_failed'], ['site-allowed', 'abort', undefined],
]) test(`b Card site question: ${status}, ${mode}`, async () => {
  const href = 'https://namu.wiki/w/Cat', calls = [], controller = new AbortController()
  let url = `${D}/?q=cat`, answered = false, asked, answer
  const started = new Promise(resolve => { asked = resolve })
  const reply = new Promise(resolve => { answer = resolve })
  const client = fakeClient(req => {
    const landing = req.questions.some(q => q.name === 'arrival_finishes')
    return { next_step: ranked('next_step', [[landing ? 'goal_met' : '[L1] Cat', landing ? 0.6 : 0.99]]), goal_met: { type: 'predicate', probability: 0.01 }, ...(landing ? { arrival_finishes: { type: 'predicate', probability: 0.99 } } : {}) }
  })
  const result = runBrowserReflex({ cardId: 'card', goal: '첫 결과를 열고 요약해줘', textComboboxes: true, client, signal: controller.signal, callTool: async (tool, args) => {
    calls.push(tool.replace('egdesk_browser_', ''))
    if (tool.endsWith('_observe')) return { observationId: `o${calls.length}`, snapshot: { revision: calls.length, documentId: url, url, text: ['Cat'], interactiveElements: url === href || (mode === 'gone' && answered) ? [] : [{ ref: 'a', role: 'link', tag: 'a', label: 'Cat', href }] } }
    if (tool.endsWith('_request_site')) { assert.equal(args.site, 'namu.wiki'); asked(); await reply; answered = true; return { status } }
    if (tool.endsWith('_navigate')) { assert.equal(args.observationId, 'o3'); assert.equal(args.expectedRevision, 3); assert.equal(args.url, href); url = args.url }
    return {}
  } })
  await started
  assert.deepEqual(calls, ['observe', 'request_site'])
  if (mode === 'abort') controller.abort()
  answer()
  const out = await result
  assert.equal(out.reason, reason)
  const success = status === 'site-allowed' && mode === 'normal'
  assert.equal(out.outcome, success ? 'done' : mode === 'abort' ? 'aborted' : 'escalated')
  assert.equal(calls.filter(c => c === 'navigate').length, success ? 1 : 0)
  if (success) { assert.equal(calls.at(-1), 'observe'); assert.equal(out.steps.at(-1).rule, 'link_arrived') }
})

for (const [receipt, code, second] of [['site-allowed', undefined], ['site-refused', 'site_not_allowed'], ['site-pending', 'site_pending'], ['site-allowed', undefined, true]]) {
  test(`alternate entry on crowded results: selected external title -> Card ${receipt}, result ${second ? 2 : 1}`, async () => {
    const page = ddgResultsSnapshot(), title = second ? '장화신은 고양이: 끝내주는 모험 - 나무위키' : '장화 신은 고양이 - 나무위키'
    // The role/name-only fixture reconstructs these two breadcrumbs as the same /w; real result URLs are distinct.
    if (second) for (const el of page.interactiveElements.filter(el => ['el_31','el_32'].includes(el.ref))) el.href = 'https://namu.wiki/w/second-result'
    const href = page.interactiveElements.find(el => el.label === title).href
    let landed = false
    const calls = [], reply = Promise.withResolvers(), asked = Promise.withResolvers()
    const client = fakeClient(req => {
      const next = req.questions.find(q => q.name === 'next_step')
      if (req.questions.some(q => q.name === 'choice_requested') && !next) return { choice_requested: { type: 'predicate', probability: receipt === 'site-allowed' ? 1 : 0 } }
      if (!landed && second) {
        assert.ok(next.choices.every(c => /^\[L\d+\]/.test(c.value) || ['needs_user_context','blocked'].includes(c.value)))
        assert.ok(!req.questions.some(q => ['open_only','read_here','field_text'].includes(q.name)))
      }
      const picked = next.choices.find(c => c.value.endsWith('] ' + title))
      return { next_step: ranked('next_step', [[landed ? 'goal_met' : picked?.value ?? 'needs_user_context', 0.98]]),
        goal_met: { type: 'predicate', probability: 0.02 }, ...(landed ? { arrival_finishes: { type: 'predicate', probability: 0.45 } } : { open_only: { type: 'predicate', probability: 0.99 } }) }
    })
    const callTool = async (name, args) => {
      calls.push(name.replace('egdesk_browser_', ''))
      if (name.endsWith('_observe')) return { observationId: `o${calls.length}`, snapshot: landed ? { ...page, url: href, documentId: 'landed', interactiveElements: [] } : { ...page, revision: calls.length } }
      if (name.endsWith('_request_site')) {
        assert.equal(args.site, 'namu.wiki')
        assert.equal(args[requestedSiteEvidence]?.href, receipt === 'site-allowed' ? href : undefined)
        assert.ok(!JSON.stringify(args).includes('observationId'), 'internal source evidence is never a JSON tool argument')
        asked.resolve(); return args[requestedSiteEvidence] ? { status: 'site-allowed' } : reply.promise
      }
      if (name.endsWith('_navigate')) { assert.deepEqual([args.url, args.observationId, args.expectedRevision], [href, 'o3', 3]); landed = true }
      return {}
    }
    const scope = { client, callTool, isDecisionCurrent: () => true }
    const provider = { directEntryEnabled: () => true, reflexScope: () => scope, runDirectTask: (_run, args) => runBrowserReflex({ ...args, ...scope, pageText: false }) }
    const entry = createDirectBrowserEntry({ provider, store: createBrowserTaskStore(), fieldText: () => true })
    const yes = { type: 'predicate', probability: 0.98 }
    const result = entry.handle({ run: { requestId: 'person-1', browserBinding: { cards: [{ cardId: 'card', permission: 'interact' }] } }, conversationKey: 'dm', message: second ? '두 번째 결과 열어줘' : '첫 번째 검색 결과 열어줘',
      hosts: { card: 'duckduckgo.com' }, entryAnswers: { browser_entry: yes, browser_entry_card_0: yes, browser_entry_answer: { ...yes, probability: 0.02 } } })
    await Promise.race([asked.promise, result]); assert.deepEqual(calls.slice(0,2), ['observe', 'request_site'])
    reply.resolve({ status: receipt })
    const note = JSON.parse((await result).note).egdesk_browser_task
    assert.deepEqual([note.status, note.code], [code ? 'cannot_proceed' : 'done', code])
    assert.deepEqual(calls, code ? ['observe', 'request_site'] : ['observe', 'request_site', 'observe', 'navigate', 'wait', 'observe'])
  })
}

test('ranked result open: an uncertain link (even a spurious field answer) is not a request to supply search text', async () => {
  const calls = [], client = fakeClient(() => ({ next_step: ranked('next_step', [[FIELD, .62]]), goal_met: { type: 'predicate', probability: .99 } }))
  const out = await runBrowserReflex({ cardId: 'card', goal: '두 번째 결과 열어줘', firstFieldText: () => { throw new Error('not a typing request') }, textComboboxes: true, valuesFirst: true, client,
    callTool: async name => { calls.push(name); return { observationId: 'o1', snapshot: ddgResultsSnapshot() } } })
  assert.deepEqual(calls, ['egdesk_browser_observe']); assert.equal(out.outcome, 'needs_user_context'); assert.deepEqual(out.candidates, [])
})
