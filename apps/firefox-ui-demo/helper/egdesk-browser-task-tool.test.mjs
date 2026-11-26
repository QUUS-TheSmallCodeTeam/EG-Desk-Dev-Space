import test from 'node:test'
import assert from 'node:assert/strict'
import { createDecisionClient, decisionTopicRecipient } from './egdesk-decision-client.mjs'
import { runBrowserReflex } from './egdesk-browser-reflex.mjs'
import { createBrowserTaskStore, taskStepEvent } from './egdesk-browser-task.mjs'
import { BROWSER_TASK_TOOL_FLAG, BROWSER_TASK_TOOL_NAME, BROWSER_TASK_TOOL_SPEC, browserTaskToolEnabled, candidateSpans, createBrowserTaskTool, outcomeBody, pickTaskCard, validateTaskArgs } from './egdesk-browser-task-tool.mjs'
import { createPageToolsProvider, pageToolBrowserEquivalent, pageToolGate } from './egdesk-page-tools.mjs'
import { createPageToolsWiring } from './egdesk-page-tools-wiring.mjs'
import { pageStateWire } from './egdesk-browser-page-state.fixture.mjs'

// L8 a1 ('교대'): the browser task tool. Synthetic only: a page double, a mock Decisions endpoint and the real objective loop; no Firefox, no engine.
const KEY = 'egd-synthetic-not-a-key-a1'
const O = 'https://wiki.example.test'
const RUN = (cards = [{ cardId: 'card', permission: 'interact' }]) => ({ runId: 'r1', answerId: 'a1', conversationId: 'conv-1', clientThreadId: 't1', status: 'inProgress', browserBinding: { cards } })
const parse = response => JSON.parse(response.contentItems[0].text)
const choice = (name, value, confidence = 0.95) => ({ name, type: 'choice', choice: value, confidence, probabilities: [{ value, probability: confidence }] })

test('a1 spec, flag and argument checks: closed shape, provisional name in one constant, default off', () => {
  assert.equal(BROWSER_TASK_TOOL_SPEC.name, BROWSER_TASK_TOOL_NAME)
  assert.equal(BROWSER_TASK_TOOL_SPEC.inputSchema.additionalProperties, false)
  assert.deepEqual(Object.keys(BROWSER_TASK_TOOL_SPEC.inputSchema.properties).sort(), ['cardId', 'goal', 'guidance', 'values'])
  assert.equal(browserTaskToolEnabled({}), false)
  assert.equal(browserTaskToolEnabled({ [BROWSER_TASK_TOOL_FLAG]: 'on' }), true)
  assert.equal(validateTaskArgs({ goal: '검색' }), null)
  assert.equal(validateTaskArgs({ values: { 검색어: '장화' }, guidance: { choose: 'o1' }, cardId: 'c' }), null)
  assert.match(validateTaskArgs({ goal: 'x', extra: 1 }), /unknown/)
  assert.match(validateTaskArgs({ values: { a: 1 } }), /values/)
  assert.match(validateTaskArgs({ values: { '': 'x' } }), /values/)
  assert.match(validateTaskArgs({ guidance: { choose: '' } }), /guidance/)
  assert.match(validateTaskArgs({ goal: 'x'.repeat(501) }), /goal/)
})

test('a1 candidate spans: code cuts the person\'s words between action words, quoted text first, a trailing particle dropped; nothing judged', () => {
  const one = candidateSpans(['구글에서 장화 신은 고양이 검색해서 첫 결과 열고 줄거리 요약해줘'])
  assert.ok(one.includes('장화 신은 고양이'))
  assert.ok(!one.some(span => /검색|열고|요약/.test(span)), 'no span crosses or holds an action word')
  assert.ok(one.indexOf('구글에서 장화 신은 고양이') < one.indexOf('장화 신은 고양이'), 'longer runs first')
  const two = candidateSpans(['받는 사람에 차민수라고 적어줘'])
  assert.ok(two.includes('차민수'), 'the particle 라고 is dropped')
  const three = candidateSpans(['"Puss in Boots" 검색해줘', 'search the wiki'])
  assert.equal(three[0], 'Puss in Boots', 'quoted text comes first')
  assert.ok(candidateSpans(['x '.repeat(400)]).length <= 60)
  assert.deepEqual(candidateSpans([null, '', '   ']), [])
})

test('a1 card choice and the closed outcome words', () => {
  assert.deepEqual(pickTaskCard([{ cardId: 'a', permission: 'observe' }], undefined), { error: 'TASK_NO_INTERACT_CARD' })
  assert.deepEqual(pickTaskCard([{ cardId: 'a', permission: 'interact' }], undefined), { cardId: 'a' })
  assert.equal(pickTaskCard([{ cardId: 'a', permission: 'interact' }, { cardId: 'b', permission: 'interact' }]).error, 'TASK_CARD_REQUIRED')
  assert.deepEqual(pickTaskCard([{ cardId: 'a', permission: 'interact' }, { cardId: 'b', permission: 'interact' }], 'b'), { cardId: 'b' })
  assert.equal(pickTaskCard([{ cardId: 'a', permission: 'interact' }], 'z').error, 'TASK_CARD_NOT_GRANTED')
  const task = { offered: [] }
  assert.deepEqual(outcomeBody(task, { outcome: 'done' }), { status: 'done' })
  assert.deepEqual(outcomeBody(task, { outcome: 'needs_free_text', field: '[F1] 검색', label: '검색' }), { status: 'needs_value', ask: { field: '검색', kind: 'text' } })
  const guided = outcomeBody(task, { outcome: 'needs_user_context', candidates: ['[L1] 2026년 11월 명세서', '[L2] 2026년 10월 명세서', 'scroll_more'] })
  assert.deepEqual(guided, { status: 'needs_guidance', code: 'choice_needed', options: [{ id: 'o1', label: '2026년 11월 명세서' }, { id: 'o2', label: '2026년 10월 명세서' }] })
  assert.equal(task.offered[1].value, '[L2] 2026년 10월 명세서')
  assert.equal(outcomeBody(task, { outcome: 'escalated', reason: 'uncertain', ranked: [{ value: '[B1] 조회' }, { value: 'blocked' }] }).options.length, 1)
  assert.deepEqual(outcomeBody(task, { outcome: 'handoff', pageState: 'login_required' }), { status: 'human_step', code: 'login_required' })
  assert.deepEqual(outcomeBody(task, { outcome: 'escalated', reason: 'human_step', controls: ['결제 제출'] }), { status: 'human_step', code: 'person_only_controls', controls: ['결제 제출'] })
  assert.equal(outcomeBody(task, { outcome: 'escalated', reason: 'press_needs_expected_effect', suggestion: { option: '[B2] 저장' } }).target, '저장')
  assert.deepEqual(outcomeBody(task, { outcome: 'fallback', reason: 'timeout' }), { status: 'cannot', code: 'decision_unavailable', next: 'use_card_tools' })
  assert.deepEqual(outcomeBody(task, { outcome: 'max_steps', reason: 'step_rejected', code: 'BROWSER_OBSERVATION_STALE' }), { status: 'cannot', code: 'step_rejected', detail: 'BROWSER_OBSERVATION_STALE' })
})

test('a1 step event contract: closed words and short names only, a wait is no event, the typed text never appears', () => {
  const task = { taskId: 'bt_1', cardId: 'card' }
  const ev = taskStepEvent(task, { step: 1, action: 'egdesk_browser_fill', ok: true, ms: 40, stepMs: 412, op: 'fill', target: '검색', valueName: '[F1] 검색' }, { seq: 3 })
  assert.deepEqual({ ...ev }, { taskId: 'bt_1', cardId: 'card', seq: 3, op: 'fill', target: '검색', valueName: '검색', ok: true, ms: 412, by: 'decision' })
  assert.equal(taskStepEvent(task, { step: 1, action: 'egdesk_browser_wait', ok: true, op: 'wait' }, { seq: 4 }), null)
  assert.equal(taskStepEvent(task, { step: 1 }, { seq: 4 }), null, 'a step start is no event')
  const fail = taskStepEvent(task, { step: 2, failed: 'egdesk_browser_navigate', ok: false, op: 'open', target: '다음', code: 'BROWSER_OBSERVATION_STALE', stepMs: 90 }, { seq: 5, by: 'model' })
  assert.deepEqual([fail.ok, fail.by, fail.code, fail.op], [false, 'model', 'BROWSER_OBSERVATION_STALE', 'open'])
  const end = taskStepEvent(task, { op: 'end', ok: true, stepMs: 1200 }, { seq: 6, status: 'done' })
  assert.deepEqual([end.op, end.status, end.ms], ['end', 'done', 1200])
})

// ---- the real objective loop on a page double: a wiki search page (a Google-style text combobox and a read-only GET search button) and its results ----
function wikiWorld({ answerFreeText = false, fieldText = '장화 신은 고양이' } = {}) {
  let cur = { url: `${O}/`, revision: 1, value: '' }
  const calls = [], requests = []
  const submitUrl = () => `${O}/w/index.php?search=${encodeURIComponent(cur.value)}`
  const snapshot = () => (cur.url === `${O}/` ? {
    url: cur.url, documentId: `d${cur.revision}`, revision: cur.revision, readyState: 'complete', title: '위키 대문', text: ['위키 대문', '오늘의 문서'],
    interactiveElements: [
      { ref: 'q', role: 'combobox', tag: 'textarea', label: '위키 검색', href: '', value: cur.value },
      { ref: 'go', role: 'button', tag: 'input', label: '검색', href: '', value: '검색', nav: { type: 'submit', sensitiveRegion: false, regionLabel: '', form: { method: 'get', fields: ['textarea', 'submit'], sensitive: false, submitUrl: submitUrl() }, controls: null } },
      { ref: 'today', role: 'link', tag: 'a', label: '오늘의 문서', href: `${O}/wiki/today`, value: '' },
    ] } : {
    url: cur.url, documentId: `d${cur.revision}`, revision: cur.revision, readyState: 'complete', title: '장화 신은 고양이 - 위키', text: ['장화 신은 고양이', '줄거리: 방앗간 셋째 아들이 고양이를 물려받는다.'],
    interactiveElements: [{ ref: 'r1', role: 'link', tag: 'a', label: '장화 신은 고양이 (동화)', href: `${O}/wiki/puss`, value: '' }] })
  const callTool = async (name, args) => {
    calls.push({ name, ...(args?.text ? { typed: true } : {}), ...(args?.url ? { url: args.url } : {}) })
    if (name === 'egdesk_browser_observe') return { observationId: `o${calls.length}`, snapshot: snapshot() }
    if (name === 'egdesk_browser_fill') { cur = { ...cur, value: args.text, revision: cur.revision + 1 }; return { status: 'postcondition-observed' } }
    if (name === 'egdesk_browser_navigate') { cur = { url: args.url, revision: cur.revision + 1, value: '' }; return { status: 'postcondition-observed' } }
    return { status: 'wait-condition-met' }
  }
  const client = createDecisionClient({ recipientForKey: (value, endpoint, model) => decisionTopicRecipient(value, 1, endpoint, model), getApiKey: async () => KEY,
    fetchImpl: async (_e, { body }) => {
      const request = JSON.parse(body)
      requests.push(request)
      const evidence = request.input.map(item => item.content).join('\n')
      const names = request.questions.map(q => q.name)
      const answers = []
      if (names.includes('field_text')) {
        const q = request.questions.find(item => item.name === 'field_text')
        answers.push(choice('field_text', q.choices.some(c => c.value === fieldText) ? fieldText : q.choices.at(-1).value))
      } else if (names.includes('field_0')) {
        const q = request.questions.find(item => item.name === 'field_0')
        answers.push(choice('field_0', q.choices.find(c => c.value.startsWith('[F')).value), ...(names.includes('ps_sign_in') ? pageStateWire('content') : []))
      } else {
        const q = request.questions.find(item => item.name === 'next_step')
        const onSearch = /URL: https:\/\/wiki\.example\.test\/\n/.test(`${evidence}\n`)
        const supplied = /Values the caller supplied for fields:/.test(evidence)
        const filled = /filled \[F1\]/.test(evidence)
        const pick = !onSearch ? 'goal_met' : filled ? q.choices.find(c => c.value.startsWith('[B')).value : supplied ? q.choices.find(c => c.value.startsWith('[F')).value : answerFreeText ? 'needs_free_text' : q.choices.find(c => c.value.startsWith('[F')).value
        answers.push(choice('next_step', pick), ...pageStateWire('content'), { name: 'goal_met', type: 'predicate', probability: onSearch ? 0.02 : 0.95 })
      }
      return { ok: true, text: async () => JSON.stringify({ answers }) }
    } })
  const browser = {
    directEntryEnabled: () => true,
    reflexScope: () => ({ client, callTool, isDecisionCurrent: () => true, authorizeDispatch: undefined }),
    runDirectTask: (run, args) => runBrowserReflex({ ...args, callTool, client }),
  }
  return { browser, calls, requests, get cur() { return cur } }
}

test('a1 values named by the model: the loop types the value where it belongs, submits the read-only GET search at once and finishes; step events carry no typed text', async () => {
  const world = wikiWorld()
  const events = []
  const tool = createBrowserTaskTool({ browser: world.browser, onStep: (_run, event) => events.push(event) })
  const out = parse(await tool.handle(RUN(), { callId: 'call-1', arguments: { goal: '위키에서 장화 신은 고양이 검색', values: { 검색어: '장화 신은 고양이' } } }))
  assert.equal(out.status, 'done')
  assert.deepEqual(out.steps.map(step => [step.op, step.target, step.valueName ?? null, step.ok]), [['fill', '위키 검색', '검색어', true], ['submit', '검색', null, true]])
  assert.deepEqual(out.page, { title: '장화 신은 고양이 - 위키', host: 'wiki.example.test' })
  assert.ok(world.cur.url.startsWith(`${O}/w/index.php?search=`), 'the GET search ran as its own navigation')
  assert.ok(world.calls.some(call => call.name === 'egdesk_browser_navigate' && call.url.includes('search=')))
  assert.deepEqual(events.map(event => event.op), ['fill', 'submit', 'end'])
  assert.deepEqual(events.map(event => event.seq), [1, 2, 3])
  assert.equal(events.at(-1).status, 'done')
  assert.ok(events.every(event => event.by === 'decision' && event.taskId === out.taskId && event.cardId === 'card'))
  assert.doesNotMatch(JSON.stringify(events) + JSON.stringify(out.steps), /장화 신은 고양이(?! - 위키)/, 'no typed text in the steps')
  assert.ok(Number.isFinite(out.elapsedMs))
})

test('a1 no value given: the decision model chooses the field text among the spans of the goal (it writes nothing), then the task goes on in the same call', async () => {
  const world = wikiWorld({ answerFreeText: true })
  const tool = createBrowserTaskTool({ browser: world.browser })
  const out = parse(await tool.handle(RUN(), { callId: 'call-2', arguments: { goal: '위키에서 장화 신은 고양이 검색해줘' } }))
  assert.equal(out.status, 'done')
  const spanRequest = world.requests.find(request => request.questions.some(q => q.name === 'field_text'))
  assert.ok(spanRequest, 'one span choice request')
  const options = spanRequest.questions[0].choices.map(c => c.value)
  assert.ok(options.includes('장화 신은 고양이') && options.at(-1) === 'none of these')
  assert.ok(!options.some(value => /검색해줘/.test(value)))
  assert.ok(decodeURIComponent(world.cur.url).includes('search=장화 신은 고양이'))
})

test('a1 no span fits: needs_value names the field; the next call with values (no goal) resumes the same task and finishes', async () => {
  const world = wikiWorld({ answerFreeText: true, fieldText: 'nothing listed' })
  const tool = createBrowserTaskTool({ browser: world.browser })
  const first = parse(await tool.handle(RUN(), { callId: 'c1', arguments: { goal: 'search the capital of France on the wiki' } }))
  assert.equal(first.status, 'needs_value')
  assert.deepEqual(first.ask, { field: '위키 검색', kind: 'text' })
  const second = parse(await tool.handle(RUN(), { callId: 'c2', arguments: { values: { query: 'Paris' } } }))
  assert.equal(second.taskId, first.taskId, 'the same task')
  assert.equal(second.status, 'done')
  assert.ok(world.cur.url.endsWith('search=Paris'))
  const third = parse(await tool.handle(RUN(), { callId: 'c3', arguments: {} }))
  assert.equal(third.code, 'TASK_GOAL_REQUIRED', 'a finished task is not continued')
})

test('a1 guidance: the model chooses one of the offered elements; it is acted on (by: model) and the loop goes on', async () => {
  const calls = []
  let url = `${O}/list`
  const page = () => ({ url, documentId: url, revision: 1, readyState: 'complete', title: url.endsWith('/list') ? '명세서 목록' : '11월 명세서', text: ['명세서'],
    interactiveElements: url.endsWith('/list') ? [{ ref: 'a', role: 'link', tag: 'a', label: '2026년 11월 명세서', href: `${O}/s/11` }, { ref: 'b', role: 'link', tag: 'a', label: '2026년 10월 명세서', href: `${O}/s/10` }] : [] })
  const callTool = async (name, args) => { calls.push(name); if (name === 'egdesk_browser_observe') return { observationId: `o${calls.length}`, snapshot: page() }; if (name === 'egdesk_browser_navigate') url = args.url; return { status: 'postcondition-observed' } }
  let round = 0
  const browser = {
    directEntryEnabled: () => true,
    reflexScope: () => ({ client: null, callTool, isDecisionCurrent: () => true }),
    runDirectTask: async (_run, args) => {
      round++
      if (round === 1) return { outcome: 'needs_user_context', candidates: ['[L1] 2026년 11월 명세서', '[L2] 2026년 10월 명세서'], steps: [{ step: 1 }], state: { pending: [], assigned: [], attemptedRefs: [], unmatched: [], history: [] } }
      args.onPage({ step: 1, title: '11월 명세서', host: 'wiki.example.test' })
      return { outcome: 'done', steps: [{ step: 1 }], state: args.resumeState }
    },
  }
  const events = []
  const tool = createBrowserTaskTool({ browser, onStep: (_run, event) => events.push(event) })
  const first = parse(await tool.handle(RUN(), { callId: 'g1', arguments: { goal: '명세서 열어줘' } }))
  assert.deepEqual([first.status, first.code, first.options.map(o => o.label)], ['needs_guidance', 'choice_needed', ['2026년 11월 명세서', '2026년 10월 명세서']])
  const unknown = parse(await tool.handle(RUN(), { callId: 'g2', arguments: { guidance: { choose: 'o9' } } }))
  assert.deepEqual([unknown.status, unknown.code, unknown.options.length], ['needs_guidance', 'option_unknown', 2])
  const second = parse(await tool.handle(RUN(), { callId: 'g3', arguments: { guidance: { choose: 'o1' } } }))
  assert.equal(second.status, 'done')
  assert.equal(url, `${O}/s/11`)
  assert.deepEqual(second.steps.map(step => [step.op, step.target, step.by]), [['open', '2026년 11월 명세서', 'model']])
  assert.ok(events.some(event => event.by === 'model' && event.op === 'open'))
})

test('a1 refusals: no interact Card, several Cards, the decision model off, a second call while the task runs', async () => {
  let release
  const browser = { directEntryEnabled: () => true, reflexScope: () => ({}), runDirectTask: () => new Promise(resolve => { release = () => resolve({ outcome: 'done', steps: [] }) }) }
  const tool = createBrowserTaskTool({ browser })
  assert.equal(parse(await tool.handle(RUN([{ cardId: 'c', permission: 'observe' }]), { arguments: { goal: 'x' } })).code, 'TASK_NO_INTERACT_CARD')
  const several = parse(await tool.handle(RUN([{ cardId: 'a', permission: 'interact' }, { cardId: 'b', permission: 'interact' }]), { arguments: { goal: 'x' } }))
  assert.deepEqual([several.code, several.cardIds], ['TASK_CARD_REQUIRED', ['a', 'b']])
  assert.equal(parse(await tool.handle(RUN(), { arguments: { goal: 'x', extra: true } })).code, 'TASK_ARGS_INVALID')
  const off = createBrowserTaskTool({ browser: { ...browser, directEntryEnabled: () => false } })
  assert.equal(parse(await off.handle(RUN(), { arguments: { goal: 'x' } })).code, 'decision_unavailable')
  const running = tool.handle(RUN(), { arguments: { goal: 'x' } })
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(parse(await tool.handle(RUN(), { arguments: {} })).code, 'TASK_BUSY')
  release()
  assert.equal(parse(await running).status, 'done')
})

test('a1 page tools carry the task tool only when it is given; the runtime gate reads it as an interaction (egdesk_browser_navigate) on the first interact Card', async () => {
  const plain = createPageToolsProvider({ mode: () => 'on', browser: { dispatch: async () => ({}) } })
  assert.ok(!plain.specs().some(spec => spec.name === BROWSER_TASK_TOOL_NAME))
  const seen = []
  const taskTool = { spec: BROWSER_TASK_TOOL_SPEC, handle: async (run, event) => { seen.push(event.arguments); return { success: true, contentItems: [{ type: 'inputText', text: '{"status":"done"}' }] } } }
  const page = createPageToolsProvider({ mode: () => 'on', browser: { dispatch: async () => ({}) }, taskTool })
  assert.equal(page.specs().at(-1).name, BROWSER_TASK_TOOL_NAME)
  assert.equal(parse(await page.dispatch(RUN(), { tool: BROWSER_TASK_TOOL_NAME, callId: 'x1', arguments: { goal: 'g' } })).status, 'done')
  assert.deepEqual(seen, [{ goal: 'g' }])
  const off = createPageToolsProvider({ mode: () => 'off', browser: { dispatch: async () => ({}) }, taskTool })
  assert.deepEqual(off.specs(), [])
  assert.equal(parse(await off.dispatch(RUN(), { tool: BROWSER_TASK_TOOL_NAME, callId: 'x2', arguments: { goal: 'g' } })).error.code, 'PAGE_TOOLS_OFF')
  assert.equal(pageToolBrowserEquivalent(BROWSER_TASK_TOOL_NAME), 'egdesk_browser_navigate')
  assert.deepEqual(pageToolGate(RUN([{ cardId: 'o', permission: 'observe' }, { cardId: 'i', permission: 'interact' }]), { tool: BROWSER_TASK_TOOL_NAME, arguments: {} }), { tool: 'egdesk_browser_navigate', cardId: 'i' })
  const wired = createPageToolsWiring({ env: { EGDESK_PAGE_TOOLS: 'on', [BROWSER_TASK_TOOL_FLAG]: 'on' }, getChat: () => null })
  assert.ok(wired.toolProviders[0].specs().some(spec => spec.name === BROWSER_TASK_TOOL_NAME))
  const unwired = createPageToolsWiring({ env: { EGDESK_PAGE_TOOLS: 'on' }, getChat: () => null })
  assert.ok(!unwired.toolProviders[0].specs().some(spec => spec.name === BROWSER_TASK_TOOL_NAME), 'flag off: the page tools are as before')
})

test('a1 a resumed loop takes the values given again; a value already typed is never typed twice', async () => {
  const typed = []
  let value = ''
  const snap = () => ({ url: `${O}/form`, documentId: 'form', revision: typed.length + 1, readyState: 'complete', title: 'f', text: ['f'], interactiveElements: [{ ref: 'n', role: 'textbox', tag: 'input', label: '이름', href: '', value }] })
  const callTool = async (name, args) => { if (name === 'egdesk_browser_observe') return { observationId: `o${typed.length}`, snapshot: snap() }; if (name === 'egdesk_browser_fill') { typed.push(args.text); value = args.text } return { status: 'postcondition-observed' } }
  const client = createDecisionClient({ recipientForKey: (v, e, m) => decisionTopicRecipient(v, 1, e, m), getApiKey: async () => KEY,
    fetchImpl: async (_e, { body }) => { const r = JSON.parse(body); const q = r.questions.find(item => item.name === 'next_step')
      return { ok: true, text: async () => JSON.stringify({ answers: q ? [choice('next_step', q.choices[0].value), ...pageStateWire('content'), { name: 'goal_met', type: 'predicate', probability: 0.02 }] : [choice('field_0', r.questions[0].choices[0].value)] }) } } })
  const first = await runBrowserReflex({ cardId: 'c', goal: '이름 적기', callTool, client, maxSteps: 1 })
  assert.deepEqual(typed, [])
  const second = await runBrowserReflex({ cardId: 'c', goal: '이름 적기', values: { '[F1] 이름': '차민수' }, resumeState: first.state, callTool, client, maxSteps: 2 })
  assert.deepEqual(typed, ['차민수'], 'the value given on resume was typed')
  await runBrowserReflex({ cardId: 'c', goal: '이름 적기', values: { '[F1] 이름': '차민수' }, resumeState: second.state, callTool, client, maxSteps: 2 })
  assert.deepEqual(typed, ['차민수'], 'given again, it is not typed a second time')
  const store = createBrowserTaskStore()
  assert.equal(store.size, 0)
})

test('a1 a link to another site: offered where the loop found no way on; choosing it goes through the page tools\' press (the site question), then the loop goes on', async () => {
  const task = { offered: [] }
  const far = [{ label: '장화 신은 고양이 - 나무위키', href: 'https://namu.wiki/w/puss' }]
  const body = outcomeBody(task, { outcome: 'escalated', reason: 'uncertain', ranked: [{ value: 'scroll_more' }] }, { outside: far })
  assert.deepEqual(body, { status: 'needs_guidance', code: 'outside_site', options: [{ id: 'o1', label: '장화 신은 고양이 - 나무위키', site: 'namu.wiki' }] })
  assert.equal(outcomeBody({ offered: [] }, { outcome: 'escalated', reason: 'error_page' }, { outside: far }).status, 'cannot', 'an error page is not a reason to leave the site')
  assert.equal(outcomeBody({ offered: [] }, { outcome: 'escalated', reason: 'blocked' }, { outside: far }).code, 'outside_site')

  let round = 0
  const pressed = []
  const browser = {
    directEntryEnabled: () => true,
    reflexScope: () => ({ client: null, callTool: async () => ({ status: 'wait-condition-met' }), isDecisionCurrent: () => true }),
    runDirectTask: async (_run, args) => {
      round++
      if (round === 1) { args.onPage({ step: 1, title: '검색 결과', host: 'www.google.com', offSite: far }); return { outcome: 'escalated', reason: 'uncertain', ranked: [], steps: [{ step: 1 }], state: {} } }
      args.onPage({ step: 1, title: '장화 신은 고양이 - 나무위키', host: 'namu.wiki', offSite: [] })
      return { outcome: 'done', steps: [{ step: 1 }], state: {} }
    },
  }
  const tool = createBrowserTaskTool({ browser })
  const first = parse(await tool.handle(RUN(), { callId: 's1', arguments: { goal: '첫 결과 열기' } }))
  assert.deepEqual([first.status, first.options], ['needs_guidance', []], 'without the page tools\' press no link to another site is offered')
  tool.usePagePress(async (_run, _event, args) => { pressed.push(args); return { success: true, contentItems: [{ type: 'inputText', text: JSON.stringify({ status: 'pressed', via: 'site' }) }] } })
  round = 0
  const offered = parse(await tool.handle(RUN(), { callId: 's2', arguments: { goal: '첫 결과 열기' } }))
  assert.deepEqual([offered.status, offered.code, offered.options[0].site], ['needs_guidance', 'outside_site', 'namu.wiki'])
  const opened = parse(await tool.handle(RUN(), { callId: 's3', arguments: { guidance: { choose: 'o1' } } }))
  assert.deepEqual(pressed, [{ cardId: 'card', href: 'https://namu.wiki/w/puss' }])
  assert.equal(opened.status, 'done')
  assert.deepEqual(opened.steps.map(step => [step.op, step.by]), [['open', 'model']])
  assert.equal(opened.page.host, 'namu.wiki')

  round = 0
  const refusedTool = createBrowserTaskTool({ browser })
  refusedTool.usePagePress(async () => ({ success: true, contentItems: [{ type: 'inputText', text: JSON.stringify({ status: 'not_done', code: 'BROWSER_NAVIGATE_OUT_OF_SCOPE', site: 'site-refused' }) }] }))
  parse(await refusedTool.handle(RUN(), { callId: 'r1', arguments: { goal: '첫 결과 열기' } }))
  const refused = parse(await refusedTool.handle(RUN(), { callId: 'r2', arguments: { guidance: { choose: 'o1' } } }))
  assert.deepEqual([refused.status, refused.code], ['cannot', 'site_not_allowed'])
})

test('a1 the page tools bind their own press for a link to another site: a fresh observation, the link found by its address, the site question, then the navigation', async () => {
  const calls = []
  const page = { url: 'https://www.google.com/search?q=x', title: 'x - Google', revision: 1, documentId: 'd', readyState: 'complete', text: ['결과'],
    interactiveElements: [{ ref: 'r7', role: 'link', tag: 'a', label: '장화 신은 고양이 - 나무위키', href: 'https://namu.wiki/w/puss', value: '' }] }
  const ok = body => ({ success: true, contentItems: [{ type: 'inputText', text: JSON.stringify(body) }] })
  const browser = { dispatch: async (_run, event) => {
    calls.push([event.tool, event.arguments?.url ?? event.arguments?.site ?? null])
    if (event.tool === 'egdesk_browser_observe') return ok({ observationId: `o${calls.length}`, snapshot: page })
    if (event.tool === 'egdesk_browser_request_site') return ok({ status: 'site-allowed' })
    return ok({ status: 'postcondition-observed' })
  } }
  let press = null
  createPageToolsProvider({ mode: () => 'on', browser, taskTool: { spec: BROWSER_TASK_TOOL_SPEC, handle: async () => ({}), usePagePress: fn => { press = fn } } })
  assert.equal(typeof press, 'function')
  const out = parse(await press(RUN(), { callId: 'p1' }, { cardId: 'card', href: 'https://namu.wiki/w/puss' }))
  assert.deepEqual([out.status, out.via], ['pressed', 'site'])
  assert.deepEqual(calls.map(call => call[0]), ['egdesk_browser_observe', 'egdesk_browser_request_site', 'egdesk_browser_observe', 'egdesk_browser_navigate'])
  assert.equal(calls.at(-1)[1], 'https://namu.wiki/w/puss')
  const gone = parse(await press(RUN(), { callId: 'p2' }, { cardId: 'card', href: 'https://elsewhere.example/x' }))
  assert.equal(gone.code, 'PAGE_REF_UNKNOWN')
})

test('a1 page text: by default the task tool\'s loop sends the title and the controls (names, a field\'s value) instead of the page\'s own text; a credential value is never listed', async () => {
  const { withoutPageText } = await import('./egdesk-browser-reflex.mjs')
  const seen = withoutPageText({ url: `${O}/login`, title: '로그인', text: ['본문 한 줄', '두 번째 줄'], interactiveElements: [
    { ref: 'u', role: 'textbox', label: '아이디', value: 'minsoo' }, { ref: 'p', role: 'password', label: '비밀번호', value: '••••' }, { ref: 'b', role: 'button', label: '로그인', value: '' }, { ref: 'x', role: 'link', label: '' }] })
  assert.deepEqual(seen.text, ['Page title: "로그인" (the page\'s own text is not sent; its controls are listed instead)', 'text field: 아이디 (now "minsoo")', 'control: 비밀번호', 'button: 로그인'])
  const world = wikiWorld()
  const tool = createBrowserTaskTool({ browser: world.browser })
  assert.equal(parse(await tool.handle(RUN(), { callId: 'pt', arguments: { goal: '위키에서 장화 신은 고양이 검색', values: { 검색어: '장화 신은 고양이' } } })).status, 'done')
  const sent = world.requests.map(request => JSON.stringify(request.input)).join('\n')
  assert.doesNotMatch(sent, /방앗간/, 'no line of the page body')
  assert.match(sent, /search field|list or field: 위키 검색/)
  const withText = wikiWorld()
  const textTool = createBrowserTaskTool({ browser: withText.browser, pageText: true })
  assert.equal(parse(await textTool.handle(RUN(), { callId: 'pt2', arguments: { goal: '위키에서 장화 신은 고양이 검색', values: { 검색어: '장화 신은 고양이' } } })).status, 'done')
  assert.match(withText.requests.map(request => JSON.stringify(request.input)).join('\n'), /방앗간/, 'pageText: true sends the page text as the direct entry does')
})

test('a1 who chose an action (actor) rides on the Browser dispatch a scope sends; a scope without one sends none (the direct entry is unchanged)', async () => {
  const { createCodexBrowserToolProvider } = await import('./codex-browser-tool-provider.mjs')
  const seen = []
  const service = { dispatch: async (_run, event) => { seen.push(event); return { status: 'observed', cardId: 'card' } }, prepare() {}, bind: async () => ({ cards: [] }), cancelRun: async () => [], reset() {} }
  const transport = { hasClient: () => true, runs: new Map(), sendToUi: async () => ({}), bindRun() {}, unbindRun() {}, reset() {} }
  const provider = createCodexBrowserToolProvider({ transport, getOwnerKey: () => 'o', service, decision: { mode: () => 'on', configured: () => true, recipient: () => 'r', generation: () => 1, client: {} } })
  provider.runtime = { emit() {}, currentEpoch: () => 1 }
  const run = { runId: 'r1', executionPolicy: { mode: 'browserBounded' }, browserBinding: { cards: [{ cardId: 'card', permission: 'interact' }] }, status: 'inProgress' }
  await provider.reflexScope(run, { callId: 'c' }, 'card', { actor: 'model' }).callTool('egdesk_browser_observe', { cardId: 'card' })
  await provider.reflexScope(run, { callId: 'c' }, 'card', { actor: 'nobody' }).callTool('egdesk_browser_observe', { cardId: 'card' })
  await provider.reflexScope(run, { callId: 'c' }, 'card').callTool('egdesk_browser_observe', { cardId: 'card' })
  assert.deepEqual(seen.map(event => event.actor ?? null), ['model', null, null])
})

test('a1 the wiring uses the runtime\'s hooks: the step events go to browserTaskStep(run, event, ids) and the task lives in browserTasks() (the entry\'s store), whose paused task the tool continues', async () => {
  const shared = createBrowserTaskStore()
  const entryTask = shared.create({ conversationKey: 't1', cardId: 'card', goal: '명세서 열기' }) // the entry's key: the person's chat id (RUN's clientThreadId)
  entryTask.status = 'paused'; entryTask.state = { pending: [], assigned: [], attemptedRefs: [], unmatched: [], history: ['opened [L1] 명세서'] }
  const received = [], directCalls = []
  const live = { dispatch: async () => ({}), directEntryEnabled: () => true, reflexScope: () => ({ client: null, callTool: async () => ({}) }),
    runDirectTask: async (_run, args) => { directCalls.push(args); args.onStep({ step: 1, action: 'egdesk_browser_navigate', ok: true, stepMs: 300, op: 'open', target: '11월 명세서' }); return { outcome: 'done', steps: [{ step: 1 }], state: args.resumeState } } }
  const wired = createPageToolsWiring({ env: { EGDESK_PAGE_TOOLS: 'on', [BROWSER_TASK_TOOL_FLAG]: 'on' }, getChat: () => ({ browserToolProvider: () => live }) })
  const page = wired.toolProviders[0]
  page.runtime = { browserTaskStep: (run, event, ids) => { received.push({ event, ids }); return true }, browserTasks: () => shared }
  const out = parse(await page.dispatch(RUN(), { tool: BROWSER_TASK_TOOL_NAME, callId: 'w1', arguments: {} }))
  assert.equal(out.status, 'done')
  assert.equal(out.taskId, entryTask.taskId, 'the entry\'s task, continued')
  assert.deepEqual(directCalls[0].resumeState.history, ['opened [L1] 명세서'], 'from where the entry left it')
  assert.equal(directCalls[0].actor, 'decision')
  assert.deepEqual(received.map(r => [r.event.op, r.ids.taskId, r.ids.cardId]), [['open', entryTask.taskId, 'card'], ['end', entryTask.taskId, 'card']])
  assert.match(out.forYouOnly, /Not for the person/)
})
