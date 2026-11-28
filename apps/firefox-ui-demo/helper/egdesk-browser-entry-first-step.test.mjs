// L51 (real window, round d, cases 5 and 7): the entry did not take the first step of "토핑은 베이컨이랑 양파로 체크해줘" and "배달 시간 저녁 7시 반으로 넣어줘".
//  1. routing: with the page text on, the single open card was quoted by its first text lines only, so the request was judged not to be about it (browser_entry 0.00, real model);
//     the card now keeps its title and control labels beside the lines (the request wording measured for a card with lines stays).
//  2. step: after Bacon the next_step top for "check Onion" was 0.61-0.63 (bar 0.75, 4 of 4 real runs). Each checkable box is judged against the person's words (box_N, like the
//     list's select_N); a step is taken only when every box is decided and at least one is a yes. Synthetic: fake decision answers, no network.
import test from 'node:test'
import assert from 'node:assert/strict'
import { decideReflexStep, buildReflexCandidates, MAX_BOX_QUESTIONS } from './egdesk-browser-reflex.mjs'
import { observeCardLines, entryQuestions, ENTRY_OPERATION_ASK, ENTRY_WEB_ASK, ENTRY_WEB } from './egdesk-browser-task.mjs'
import { formPage } from '../scripts/egdesk-entry-first-step-pages.mjs'

const GOAL = '토핑은 베이컨이랑 양파로 체크해줘, 제출하지 마'
const pred = (name, probability) => ({ name, type: 'predicate', probability })
const choice = (name, value, confidence, other) => ({ name, type: 'choice', choice: value, confidence, probabilities: [{ value, probability: confidence }, ...(other ? [{ value: other, probability: 0.1 }] : [])] })
const thresholds = { choice: 0.75, margin: 0.2, done: 0.75, pageState: 0.75 }

function setup(checked = {}) {
  const snapshot = formPage({ rev: 1, checked })
  const options = buildReflexCandidates(snapshot, { namedButtonRequest: GOAL, askSite: true, textComboboxes: true }).options
  return { snapshot, options }
}
// answers: box score per option label (default 0), next_step pick and its confidence, goal_met
function client({ boxes = {}, next, nextP = 0.6, goalMet = 0.02, asked = [] }, options) {
  return { decide: async req => {
    asked.push(req.questions.map(q => q.name))
    const answers = {}
    for (const q of req.questions) {
      if (q.name === 'next_step') answers.next_step = choice('next_step', next, nextP, 'scroll_more')
      else if (q.name.startsWith('box_')) {
        const option = options.filter(o => o.item.kind === 'choice' && o.item.element.tag === 'input')[+q.name.slice(4)]
        answers[q.name] = pred(q.name, boxes[option.value] ?? 0.02)
      } else if (q.name === 'goal_met') answers.goal_met = pred('goal_met', goalMet)
      else if (q.name.startsWith('ps_')) answers[q.name] = pred(q.name, q.name === 'ps_covered' ? 0 : 0)
      else answers[q.name] = pred(q.name, q.name === 'choice_requested' ? 0.9 : 0.02)
    }
    return { answers, usage: { inputTokens: 1 }, latencyMs: 1 }
  } }
}
const label = (options, text) => options.find(o => o.value.includes(text)).value

test('box predicates: only Onion is still wanted (Bacon is checked): Onion is taken although next_step ranked it at 0.61', async () => {
  const { snapshot, options } = setup({ Bacon: true })
  const asked = []
  const onion = label(options, 'check Onion')
  const result = await decideReflexStep({ chatTask: true, goal: GOAL, snapshot, options, client: client({ boxes: { [onion]: 0.97 }, next: onion, nextP: 0.61, asked }, options), thresholds })
  assert.equal(result.kind, 'act')
  assert.equal(result.option.value, onion)
  assert.ok(asked[0].some(name => name.startsWith('box_')), 'the boxes were asked in the same request')
  assert.equal(asked.length, 1, 'no extra request')
})

test('box predicates: two named boxes, the first in page order is the step, even when next_step ranked the other', async () => {
  const { snapshot, options } = setup()
  const bacon = label(options, 'check Bacon'), onion = label(options, 'check Onion')
  const result = await decideReflexStep({ chatTask: true, goal: GOAL, snapshot, options, client: client({ boxes: { [bacon]: 0.95, [onion]: 0.96 }, next: onion, nextP: 0.55 }, options), thresholds })
  assert.equal(result.kind, 'act')
  assert.equal(result.option.value, bacon)
})

test('box predicates: a box nobody named is never the step (the ranking said Cheese, the person named Onion only)', async () => {
  const { snapshot, options } = setup()
  const cheese = label(options, 'check Extra Cheese'), onion = label(options, 'check Onion')
  const result = await decideReflexStep({ chatTask: true, goal: GOAL, snapshot, options, client: client({ boxes: { [onion]: 0.97 }, next: cheese, nextP: 0.9 }, options), thresholds })
  assert.equal(result.kind, 'user_context', 'a confident disagreement between the ranking and the named box hands the step to the person')
})

test('box predicates: an undecided box (0.5) leaves the step to the ranking and its bar', async () => {
  const { snapshot, options } = setup()
  const onion = label(options, 'check Onion'), mushroom = label(options, 'check Mushroom')
  const result = await decideReflexStep({ chatTask: true, goal: GOAL, snapshot, options, client: client({ boxes: { [onion]: 0.97, [mushroom]: 0.5 }, next: onion, nextP: 0.6 }, options), thresholds })
  assert.notEqual(result.kind, 'act', 'below the next_step bar and no decided box set')
})

test('box predicates: no box named at all changes nothing (the ranking decides as before)', async () => {
  const { snapshot, options } = setup()
  const bacon = label(options, 'check Bacon')
  const high = await decideReflexStep({ chatTask: true, goal: GOAL, snapshot, options, client: client({ next: bacon, nextP: 0.9 }, options), thresholds })
  assert.equal(high.kind, 'act')
  const low = await decideReflexStep({ chatTask: true, goal: GOAL, snapshot, options, client: client({ next: bacon, nextP: 0.6 }, options), thresholds })
  assert.notEqual(low.kind, 'act')
})

test('box predicates: more than MAX_BOX_QUESTIONS boxes are not asked one by one (the ranking path as before)', async () => {
  const { snapshot } = setup()
  const many = { ...snapshot, interactiveElements: [...snapshot.interactiveElements, ...Array.from({ length: MAX_BOX_QUESTIONS }, (_, i) => ({ ref: 'x' + i, tag: 'input', role: 'checkbox', type: 'checkbox', label: 'Extra ' + i, value: 'x' + i, checked: false, choice: { inForm: true, immediate: false, sensitiveRegion: false, regionLabels: ['Pizza Toppings'] } }))] }
  const options = buildReflexCandidates(many, { namedButtonRequest: GOAL, askSite: true, textComboboxes: true }).options
  const asked = []
  await decideReflexStep({ chatTask: true, goal: GOAL, snapshot: many, options, client: client({ next: label(options, 'check Onion'), nextP: 0.9, asked }, options), thresholds })
  assert.ok(!asked[0].some(name => name.startsWith('box_')))
})

test('a person-only choice (payment-like label) is never offered as a box', () => {
  const { snapshot } = setup()
  const gated = { ...snapshot, interactiveElements: [...snapshot.interactiveElements, { ref: 'pay', tag: 'input', role: 'checkbox', type: 'checkbox', label: '수수료 결제에 동의합니다', value: 'pay', checked: false, choice: { inForm: true, immediate: false, sensitiveRegion: false, regionLabels: [] } }] }
  const { options } = buildReflexCandidates(gated, { namedButtonRequest: GOAL, askSite: true, textComboboxes: true })
  assert.ok(!options.some(o => o.value.includes('결제')))
})

// ---- routing ----
const provider = page => ({ reflexScope: () => ({ callTool: async () => ({ observationId: 'o', snapshot: page }) }) })

test('entry card with the page text on keeps its title and control labels beside the first lines; the measured request wording stays', async () => {
  const page = formPage({ rev: 1, checked: {} })
  const [card] = await observeCardLines({ provider: provider(page), run: {}, message: GOAL, cards: [{ cardId: 'c13', host: 'httpbin.org' }], enabled: true })
  assert.deepEqual(card.shows, ['Customer name:', 'Telephone:', 'E-mail address:'])
  assert.equal(card.pageTitle, 'Order form')
  assert.ok(card.controls.some(line => line.includes('Bacon')) && card.controls.some(line => /delivery time/i.test(line)), 'the toppings and the time field are named')
  const question = entryQuestions([card]).find(q => q.name === ENTRY_WEB)
  assert.ok(JSON.stringify(question).includes(ENTRY_WEB_ASK.slice(0, 40)) && !JSON.stringify(question).includes(ENTRY_OPERATION_ASK.slice(0, 40)), 'lines and controls: the wording measured in c27-c29')
  const { shows, entryExtra, ...textOff } = card
  assert.ok(JSON.stringify(entryQuestions([textOff]).find(q => q.name === ENTRY_WEB)).includes(ENTRY_OPERATION_ASK.slice(0, 40)), 'controls and title without lines (text off): the operation wording as before')
})
