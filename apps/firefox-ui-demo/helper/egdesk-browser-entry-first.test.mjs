import test from 'node:test'
import assert from 'node:assert/strict'
import { buildReflexCandidates, runBrowserReflex } from './egdesk-browser-reflex.mjs'
import { createBrowserTaskStore, createDirectBrowserEntry } from './egdesk-browser-task.mjs'
import { pageStateAnswers } from './egdesk-browser-page-state.fixture.mjs'

const SITE = 'https://duckduckgo.com/'
const QUERY = '장화 신은 고양이'
const MESSAGE = `덕덕고 카드에서 ${QUERY} 검색해줘`
const el = (ref, role, tag, label) => ({ ref, role, tag, label, value: '' })
const home = { url: SITE, revision: 1, interactiveElements: [el('mode', 'radiogroup', 'div', '모드'), el('r', 'radio', 'button', '검색'), el('other', 'radio', 'button', '다른 모드'), el('q', 'combobox', 'textarea', 'DuckDuckGo로 검색')] }
const submit = (method, label = '검색') => ({ ...el('go', 'button', 'button', label), nav: { type: 'submit', form: { method, fields: ['textarea', 'submit'], sensitive: false, submitUrl: `${SITE}?q=${encodeURIComponent(QUERY)}` } } })
const pred = (name, probability) => ({ name, type: 'predicate', probability })
const choice = (name, a, p, b, p2) => ({ name, type: 'choice', choice: a, confidence: p, probabilities: [{ value: a, probability: p }, ...(b ? [{ value: b, probability: p2 }] : [])] })

async function replay(initial, { chooseText = true, later = submit('get') } = {}) {
  let snapshot = structuredClone(initial)
  const actions = [], asks = []
  const client = { async decide({ questions }) {
    const answers = { ...pageStateAnswers('content') }
    for (const q of questions) {
      asks.push(q.name)
      if (q.name === 'next_step') {
        const field = q.choices.find(c => c.value.startsWith('[F'))?.value
        const search = q.choices.find(c => c.value === '[B1] 검색' || /^\[B\d+\] 검색$/.test(c.value))?.value
        answers[q.name] = actions.length === 0 ? choice(q.name, 'needs_free_text', .68, field, .25) : search ? choice(q.name, search, .74, field, .20) : choice(q.name, 'blocked', .95)
      } else if (q.name === 'field_text') answers[q.name] = choice(q.name, chooseText ? QUERY : q.choices.at(-1).value, .97)
      else if (q.name === 'goal_met') answers[q.name] = pred(q.name, actions.includes('GET') ? .98 : .01)
      else if (q.type === 'choice') answers[q.name] = choice(q.name, q.choices[0].value, .95)
      else if (!(q.name in answers)) answers[q.name] = pred(q.name, ['browser_entry', 'browser_entry_card_0', 'person_target_1'].includes(q.name) ? .97 : .01)
    }
    return { answers, latencyMs: 1 }
  } }
  const callTool = async (name, args) => {
    if (name === 'egdesk_browser_observe') return { observationId: `o${snapshot.revision}`, snapshot }
    if (name === 'egdesk_browser_fill') {
      assert.equal(args.text, QUERY); const box = snapshot.interactiveElements.find(e => e.ref === args.ref); assert.equal(box.tag, 'textarea'); actions.push('fill')
      snapshot = { ...snapshot, revision: snapshot.revision + 1, interactiveElements: [...snapshot.interactiveElements.map(e => e === box ? { ...e, value: QUERY } : e), later] }
    } else if (name === 'egdesk_browser_navigate') {
      assert.equal(new URL(args.url).searchParams.get('q'), QUERY); actions.push('GET'); snapshot = { url: args.url, revision: snapshot.revision + 1, interactiveElements: [] }
    } else assert.equal(name, 'egdesk_browser_wait')
    return { status: 'postcondition-observed' }
  }
  const scope = { callTool, client, isDecisionCurrent: () => true }
  const provider = { directEntryEnabled: () => true, reflexScope: () => scope, runDirectTask: (_run, args) => runBrowserReflex({ ...args, ...scope, pageText: false }) }
  const entry = createDirectBrowserEntry({ provider, store: createBrowserTaskStore(), fieldText: () => true })
  const run = { runId: 'r', browserBinding: { cards: [{ cardId: 'card', permission: 'interact' }] } }
  const out = await entry.handle({ run, conversationKey: 'dm', message: MESSAGE, hosts: { card: 'duckduckgo.com' } })
  return { status: out.status, code: JSON.parse(out.note).egdesk_browser_task.code, actions, askedPerson: asks.includes('person_target_1'), askedText: asks.includes('field_text') }
}

test('an uncertain entry chooses the message span for its field before asking about the identically named search mode radio', async () => {
  const out = await replay(home)
  assert.deepEqual([out.status, out.actions, out.askedText, out.askedPerson], ['done', ['fill', 'GET'], true, false])
})

test('no chosen span: the original person-target follow-up still decides the handoff', async () => {
  const out = await replay(home, { chooseText: false })
  assert.deepEqual([out.code, out.actions, out.askedText, out.askedPerson], ['human_step', [], true, true])
})

test('proven GET submit is not a person target; POST, payment, permission and delete submits are withheld', () => {
  for (const [method, label, withheld] of [['get','검색',false], ['post','제출',true], ['get','결제',true], ['get','권한 허용',true], ['get','삭제',true]]) {
    const built = buildReflexCandidates({ ...home, interactiveElements: [submit(method, label)] })
    assert.equal(built.withheld.some(c => c.label === label), withheld)
    assert.equal(built.options.some(c => c.item.readOnly?.kind === 'get_form'), !withheld)
  }
})

test('the direct entry hands over POST submission and payment; neither is operated', async () => {
  for (const button of [submit('post', '제출'), submit('get', '결제')]) {
    const out = await replay({ ...home, interactiveElements: [button] })
    assert.deepEqual([out.code, out.actions, out.askedText], ['human_step', [], false])
  }
})
