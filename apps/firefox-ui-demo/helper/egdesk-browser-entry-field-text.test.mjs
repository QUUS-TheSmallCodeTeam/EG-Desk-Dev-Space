// L8 a1 ('교대', Main 16:5x real window): "덕덕고 카드에서 장화 신은 고양이 검색해줘" on a DuckDuckGo Card. The direct entry entered the Card and its first step stopped: nobody had
// given the search text, so the turn went to Codex (+27 s). Here, with the entry's fieldText on: entry -> the field text CHOSEN among the spans of the person's message -> the
// read-only GET search (whose address DuckDuckGo extends with ia=web, so the url postcondition reads a failure while the results page opens) -> done, one closed note for the
// answering model. Synthetic: a page double, a mock Decisions endpoint, the real objective loop; no Firefox, no engine.
import test from 'node:test'
import assert from 'node:assert/strict'
import { createDecisionClient, decisionTopicRecipient } from './egdesk-decision-client.mjs'
import { formResultLanded, runBrowserReflex } from './egdesk-browser-reflex.mjs'
import { createBrowserTaskStore, createDirectBrowserEntry } from './egdesk-browser-task.mjs'
import { createPageToolsProvider } from './egdesk-page-tools.mjs'
import { pageStateWire } from './egdesk-browser-page-state.fixture.mjs'

const KEY = 'egd-synthetic-not-a-key-a1e'
const D = 'https://duckduckgo.com'
const MESSAGE = '덕덕고 카드에서 장화 신은 고양이 검색해줘'
const choice = (name, value, p = 0.95) => ({ name, type: 'choice', choice: value, confidence: p, probabilities: [{ value, probability: p }] })

test('a1 formResultLanded: the same origin and path, every submitted parameter with its value; added parameters are no evidence against it', () => {
  assert.equal(formResultLanded(`${D}/?q=%EC%9E%A5%ED%99%94&ia=web&origin=funnel_home_website&t=h_`, `${D}/?q=%EC%9E%A5%ED%99%94`), true)
  assert.equal(formResultLanded(`${D}/?q=other&ia=web`, `${D}/?q=%EC%9E%A5%ED%99%94`), false, 'the query changed')
  assert.equal(formResultLanded(`${D}/html/?q=x`, `${D}/?q=x`), false, 'another path')
  assert.equal(formResultLanded(`https://evil.example/?q=x`, `${D}/?q=x`), false, 'another origin')
  assert.equal(formResultLanded(`${D}/?ia=web`, `${D}/?q=x`), false, 'the query dropped')
  assert.equal(formResultLanded(`${D}/`, `${D}/`), false, 'nothing was submitted')
  assert.equal(formResultLanded('not a url', `${D}/?q=x`), false)
  assert.equal(formResultLanded('https://www.google.com/search?q=x&sca_esv=1&source=hp&ei=v', 'https://www.google.com/search?q=x&source=hp'), true)
})

function duck({ fieldText = 'pick', extend = true } = {}) {
  let cur = { url: `${D}/`, revision: 1, value: '' }
  const calls = [], requests = []
  const submitUrl = () => `${D}/?q=${encodeURIComponent(cur.value)}`
  const snapshot = () => (new URL(cur.url).searchParams.get('q') === null ? {
    url: cur.url, documentId: `d${cur.revision}`, revision: cur.revision, readyState: 'complete', title: 'DuckDuckGo', text: ['DuckDuckGo', '개인정보 보호'],
    interactiveElements: [
      { ref: 'q', role: 'searchbox', tag: 'input', label: '검색', href: '', value: cur.value },
      { ref: 's', role: 'button', tag: 'button', label: '검색', href: '', value: '', nav: { type: 'submit', sensitiveRegion: false, regionLabel: '', form: { method: 'get', fields: ['search', 'submit'], sensitive: false, submitUrl: submitUrl() }, controls: null } },
      { ref: 'p', role: 'link', tag: 'a', label: '개인정보 보호', href: `${D}/privacy`, value: '' },
    ] } : {
    url: cur.url, documentId: `d${cur.revision}`, revision: cur.revision, readyState: 'complete', title: '장화 신은 고양이 at DuckDuckGo', text: ['장화 신은 고양이', '장화 신은 고양이 - 나무위키', '샤를 페로의 동화'],
    interactiveElements: [{ ref: 'r1', role: 'link', tag: 'a', label: '장화 신은 고양이 - 나무위키', href: 'https://namu.wiki/w/x', value: '' }] })
  const callTool = async (name, args) => {
    calls.push(name)
    if (name === 'egdesk_browser_observe') return { observationId: `o${calls.length}`, snapshot: snapshot() }
    if (name === 'egdesk_browser_fill') { cur = { ...cur, value: args.text, revision: cur.revision + 1 }; return { status: 'postcondition-observed' } }
    if (name === 'egdesk_browser_navigate') {
      cur = { url: extend && args.url.includes('?q=') ? `${args.url}&ia=web` : args.url, revision: cur.revision + 1, value: '' }
      if (extend && args.url.includes('?q=')) { const error = new Error('url postcondition not observed'); error.code = 'TOOL_FAILED'; throw error } // what the dispatch reported in the real window
      return { status: 'postcondition-observed' }
    }
    return { status: 'wait-condition-met' }
  }
  const client = createDecisionClient({ recipientForKey: (value, endpoint, model) => decisionTopicRecipient(value, 1, endpoint, model), getApiKey: async () => KEY,
    fetchImpl: async (_e, { body }) => {
      const request = JSON.parse(body)
      requests.push(request)
      const evidence = request.input.map(item => item.content).join('\n')
      const names = request.questions.map(q => q.name)
      const answers = []
      if (names.includes('browser_entry')) {
        for (const q of request.questions) answers.push({ name: q.name, type: 'predicate', probability: q.name === 'browser_entry_answer' ? 0.02 : 0.95 })
      } else if (names.includes('field_text')) {
        const q = request.questions[0]
        answers.push(choice('field_text', fieldText === 'pick' && q.choices.some(c => c.value === '장화 신은 고양이') ? '장화 신은 고양이' : q.choices.at(-1).value))
      } else if (names.includes('next_step')) {
        const q = request.questions.find(item => item.name === 'next_step')
        const onHome = /URL: https:\/\/duckduckgo\.com\/\n/.test(`${evidence}\n`)
        const typed = /filled \[F1\]/.test(evidence)
        // as in the real window: on the home page the step needs text nobody gave (the field is empty and no value was supplied)
        const pick = !onHome ? 'goal_met' : typed ? q.choices.find(c => c.value.startsWith('[B')).value : 'needs_free_text'
        answers.push(choice('next_step', pick), ...pageStateWire('content'), { name: 'goal_met', type: 'predicate', probability: onHome ? 0.02 : 0.95 })
      } else {
        for (const q of request.questions) answers.push(q.type === 'choice' ? choice(q.name, q.choices[0].value) : { name: q.name, type: 'predicate', probability: 0.02 })
      }
      return { ok: true, text: async () => JSON.stringify({ answers }) }
    } })
  const provider = {
    directEntryEnabled: () => true,
    reflexScope: () => ({ client, callTool, isDecisionCurrent: () => true, authorizeDispatch: undefined }),
    runDirectTask: (run, args) => runBrowserReflex({ ...args, callTool, client }),
  }
  const run = { runId: 'r', browserBinding: { cards: [{ cardId: 'card', permission: 'interact' }] } }
  return { provider, run, calls, requests, get cur() { return cur } }
}

test('a1 the real-window flow with the entry\'s fieldText on: entry -> the search text chosen among the spans of the message -> the GET search (its address extended by the site) -> done', async () => {
  const w = duck()
  const steps = []
  const entry = createDirectBrowserEntry({ provider: w.provider, store: createBrowserTaskStore(), fieldText: () => true, onStepEvent: (_run, event) => steps.push(event) })
  const out = await entry.handle({ run: w.run, conversationKey: 'dm', message: MESSAGE, hosts: { card: 'duckduckgo.com' }, titles: { card: 'DuckDuckGo' } })
  assert.equal(out.handled, true)
  assert.equal(out.status, 'done', JSON.stringify(out))
  assert.equal(JSON.parse(out.note).egdesk_browser_task.next, 'report_to_user', 'one closed note: the answering model reports once')
  assert.equal(new URL(w.cur.url).searchParams.get('q'), '장화 신은 고양이')
  const spanAsk = w.requests.find(request => request.questions.some(q => q.name === 'field_text'))
  assert.ok(spanAsk.questions[0].choices.some(option => option.value === '장화 신은 고양이'))
  assert.ok(!spanAsk.questions[0].choices.some(option => /검색/.test(option.value)), 'an action word is no part of a span')
  assert.deepEqual(steps.filter(event => !event.phase).map(event => [event.op, event.ok]), [['fill', true], ['submit', true]], 'the extended GET search counts as done (the page that loaded proves it)')
})

test('a1 the same with fieldText off: the entry pauses at the first step as before (detail_needed), nothing typed; and a span nobody chose leaves the same pause', async () => {
  const off = duck()
  const before = await createDirectBrowserEntry({ provider: off.provider, store: createBrowserTaskStore() }).handle({ run: off.run, conversationKey: 'dm', message: MESSAGE, hosts: { card: 'duckduckgo.com' } })
  assert.deepEqual([before.status, JSON.parse(before.note).egdesk_browser_task.code], ['paused', 'detail_needed'])
  assert.ok(!off.calls.includes('egdesk_browser_fill'))
  assert.ok(!off.requests.some(request => request.questions.some(q => q.name === 'field_text')), 'no span request without the option')
  const none = duck({ fieldText: 'none' })
  const unchosen = await createDirectBrowserEntry({ provider: none.provider, store: createBrowserTaskStore(), fieldText: () => true }).handle({ run: none.run, conversationKey: 'dm', message: MESSAGE, hosts: { card: 'duckduckgo.com' } })
  assert.deepEqual([unchosen.status, JSON.parse(unchosen.note).egdesk_browser_task.code], ['paused', 'detail_needed'])
  assert.ok(!none.calls.includes('egdesk_browser_fill'))
})

test('a1 a GET search whose url postcondition failed but whose result page loaded: the loop counts it done; a page that is not that result stays a failure', async () => {
  const landed = duck()
  const result = await runBrowserReflex({ cardId: 'card', goal: MESSAGE, values: { '[F1] 검색': '장화 신은 고양이' }, valuesFirst: true, callTool: landed.provider.reflexScope().callTool, client: landed.provider.reflexScope().client, maxSteps: 4 })
  assert.equal(result.outcome, 'done')
  assert.ok(result.steps.some(step => step.actions.some(action => action.tool === 'egdesk_browser_navigate' && action.ok && action.status === 'form-result-observed')))
  // the page tools' own GET search press reads the landed page the same way
  const w = duck()
  const ok = body => ({ success: true, contentItems: [{ type: 'inputText', text: JSON.stringify(body) }] })
  const fail = body => ({ success: false, contentItems: [{ type: 'inputText', text: JSON.stringify(body) }] })
  const call = w.provider.reflexScope().callTool
  const browser = { dispatch: async (_run, event) => { try { return ok(await call(event.tool, event.arguments)) } catch (error) { return fail({ error: { code: error.code } }) } } }
  const page = createPageToolsProvider({ mode: () => 'on', browser })
  await call('egdesk_browser_fill', { text: '장화 신은 고양이' })
  const read = JSON.parse((await page.dispatch(w.run, { tool: 'egdesk_card_read', callId: 'r1', arguments: { mode: 'structure' } })).contentItems[0].text)
  assert.equal(read.elements.find(element => element.ref === 's').act, 'auto')
  const pressed = JSON.parse((await page.dispatch(w.run, { tool: 'egdesk_card_press', callId: 'p1', arguments: { ref: 's' } })).contentItems[0].text)
  assert.deepEqual([pressed.status, pressed.outcome], ['pressed', 'form-result-observed'])
  const elsewhere = duck({ extend: false })
  const plain = await runBrowserReflex({ cardId: 'card', goal: MESSAGE, values: { '[F1] 검색': '장화 신은 고양이' }, valuesFirst: true, callTool: elsewhere.provider.reflexScope().callTool, client: elsewhere.provider.reflexScope().client, maxSteps: 4 })
  assert.equal(plain.outcome, 'done', 'an address the site did not extend passes its postcondition as before')
})

test('d: entry and steps include page text by default; explicit off uses controls only', async t => {
  const { PAGE_TEXT_FLAG } = await import('./egdesk-browser-reflex.mjs')
  const sent = async () => {
    const w = duck()
    const entry = createDirectBrowserEntry({ provider: w.provider, store: createBrowserTaskStore(), fieldText: () => true, cardTextInEntry: () => true })
    const out = await entry.handle({ run: w.run, conversationKey: 'dm', message: MESSAGE, hosts: { card: 'duckduckgo.com' }, titles: { card: 'DuckDuckGo' } })
    const entryBody = JSON.stringify(w.requests.find(request => request.questions.some(q => q.name === 'browser_entry'))?.input ?? null)
    const stepBodies = w.requests.filter(request => request.questions.some(q => q.name === 'next_step')).map(request => JSON.stringify(request.input)).join('\n')
    return { out, entryBody, stepBodies }
  }
  process.env[PAGE_TEXT_FLAG] = 'off'
  const off = await sent()
  assert.equal(off.out.status, 'done', 'the flow finishes without the page text')
  assert.match(off.entryBody, /has the controls/, 'the card is quoted by its controls')
  assert.doesNotMatch(off.entryBody, /shows \\"DuckDuckGo\\"/, 'no first line of the page')
  assert.doesNotMatch(off.stepBodies, /샤를 페로의 동화/, 'no line of the results page body in any step')
  assert.match(off.stepBodies, /the page's own text is not sent/)
  delete process.env[PAGE_TEXT_FLAG]
  t.after(() => { delete process.env[PAGE_TEXT_FLAG] })
  const on = await sent()
  assert.equal(on.out.status, 'done')
  assert.match(on.entryBody, /shows/, 'the first lines, as before')
  assert.match(on.stepBodies, /샤를 페로의 동화/, 'the page text, as before')
})
