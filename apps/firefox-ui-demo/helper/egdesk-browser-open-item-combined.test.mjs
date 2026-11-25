// L8 c42: the combined measurement (the resolver's referent question + the browser option predicates). Fake client: nothing is sent.
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { APPROVAL_SUMMARY, COMBINED_PLAN_FILES, MEMORY_SUMMARY, combinedStandIn, combinedVerdict, loadCombinedPlan, outcomeOf, planRequest, runCombined, scoreCombined, selectCombined } from './egdesk-browser-open-item-combined.mjs'
import { OPEN_ITEM_HARD_LIMITS, loadOpenItemPlan } from './egdesk-browser-open-item-measure.mjs'
import { resolveOpenItem } from './egdesk-open-items.mjs'

const here = path.dirname(fileURLToPath(import.meta.url))
const plan = loadCombinedPlan() // v1: as sent in c62 (its requests are the old summary; the sizes below are v2's)
const plan2 = loadCombinedPlan(COMBINED_PLAN_FILES.v2)
const KEY = 'egd-synthetic-not-a-key-0008-long-enough'

test('the plan is pre-registered and valid: the 12 replies of v1 unchanged plus 4 controls with another open item, every prediction sums to one, the ceiling is 16000, the drop order is fixed', () => {
  const v1 = loadOpenItemPlan()
  assert.equal(plan.replies.length, 16)
  assert.deepEqual(plan.replies.slice(0, 12).map(r => [r.id, r.message]), v1.replies.map(r => [r.id, r.message]))
  assert.deepEqual(plan.replies.slice(0, 12).map(r => r.acceptable), v1.replies.map(r => r.acceptable))
  assert.deepEqual(plan.replies.slice(12).map(r => [r.id, r.items, r.wantItem]), [['ctl-appr', ['approval', 'browser'], 'approval'], ['ctl-appr-browser', ['approval', 'browser'], 'browser'], ['ctl-mem', ['memory', 'browser'], 'memory'], ['ctl-mem-page', ['memory', 'browser'], 'browser']])
  assert.ok(plan.replies.every(r => r.items.at(-1) === 'browser'), 'the runtime lists the browser task last')
  assert.deepEqual([plan.tokenCeiling, OPEN_ITEM_HARD_LIMITS.tokenCeiling], [16000, 16000]); assert.deepEqual(plan.dropOrder, ['typo', 'again2', 'stop2', 'compound', 'okok'])
  assert.ok(plan.prediction.hypothesis.includes('ask_page is unreachable through the resolver'))
})

test('the request is the product\'s own: referent questions for each item (browser last) and the five option predicates in ONE request, built by buildRegistry and the provider\'s questions; the item words are the runtime\'s', async () => {
  const { items, extraQuestions } = planRequest(plan, plan.replies.find(r => r.id === 'ctl-appr'))
  assert.deepEqual(items.map(i => [i.id, i.kind]), [['oi1', 'approval'], ['oi2', 'browser_task']])
  assert.equal(items[0].summary, APPROVAL_SUMMARY('git push --force origin main'))
  assert.deepEqual(extraQuestions.map(q => q.name), ['continue', 'retry', 'abandon', 'ask_page', 'change'].map(o => `open_browser_${o}`))
  const bodies = []
  const client = { decide: async request => { bodies.push(request); return { answers: Object.fromEntries(request.questions.map(q => [q.name, { type: 'predicate', probability: 0.03 }])) } } }
  const out = await resolveOpenItem({ message: '응 실행해', items, client, extraQuestions })
  assert.deepEqual(bodies[0].questions.map(q => q.name), ['oi_ref_1', 'oi_ref_2', 'open_browser_continue', 'open_browser_retry', 'open_browser_abandon', 'open_browser_ask_page', 'open_browser_change'])
  assert.equal(bodies.length, 1); assert.equal(out.status, 'none')
  // the runtime's own source holds the words the measurement uses for the other items (a drift would be caught here)
  const runtime = fs.readFileSync(path.join(here, 'codex-chat-runtime.mjs'), 'utf8')
  assert.ok(runtime.includes("A command waits for the person's yes or no before it runs: "))
  assert.ok(runtime.includes(MEMORY_SUMMARY))
  assert.ok(runtime.includes('const items = buildRegistry([...this.builtinOpenItemSources(egress, previous), ...registeredOpenItemProviders()], key)'), 'the built-ins first, then the registered providers: the browser task comes last')
})

test('verdict by code: the right item and option, the wrong item, an option on a message that settles nothing, a miss', () => {
  const r = id => plan.replies.find(x => x.id === id)
  const o = (item, option = null, optionKind = option ? 'settled' : 'uncertain') => ({ item, option, optionKind })
  assert.equal(combinedVerdict(r('ack'), o('browser', 'continue')), 'correct')
  assert.equal(combinedVerdict(r('ack'), o('browser')), 'safe_miss')
  assert.equal(combinedVerdict(r('ack'), o(null, null, null)), 'safe_miss')
  assert.equal(combinedVerdict(r('ack'), o('approval', null, null)), 'wrong', 'settled to another item')
  assert.equal(combinedVerdict(r('again'), o('browser', 'continue')), 'acceptable')
  assert.equal(combinedVerdict(r('again'), o('browser', 'abandon')), 'wrong')
  assert.equal(combinedVerdict(r('notyet'), o(null, null, null)), 'correct')
  assert.equal(combinedVerdict(r('notyet'), o('browser')), 'acceptable', 'referred but no option settled: nothing applied')
  assert.equal(combinedVerdict(r('notyet'), o('browser', 'continue')), 'wrong', 'an option settled on "아직"')
  assert.equal(combinedVerdict(r('okok'), o('browser', 'continue')), 'acceptable')
  assert.equal(combinedVerdict(r('compound'), o('browser')), 'acceptable')
  assert.equal(combinedVerdict(r('ctl-appr'), o('approval', null, null)), 'correct')
  assert.equal(combinedVerdict(r('ctl-appr'), o('browser', 'continue')), 'wrong', 'the command\'s yes must not settle the browser task')
  assert.equal(combinedVerdict(r('ctl-mem'), o(null, null, null)), 'safe_miss')
  assert.equal(combinedVerdict(r('ctl-mem-page'), o('memory', null, null)), 'wrong')
  assert.deepEqual(scoreCombined({ replies: [1, 2] }, [{ id: 'a', verdict: 'correct' }, { id: 'b', verdict: 'wrong' }]), { ran: 2, notRun: 0, correct: 1, acceptable: 0, safeMiss: 0, wrong: 1, wrongReplies: ['b'], pass: false })
})

test('selectCombined (plan v2): under 16000 the pre-registered order drops typo, again2, stop2, compound, okok, offtopic; all 16 are about 23k; the kept 10 fit with room for the +3% the real requests ran at', async () => {
  const all = await selectCombined(plan2, 99999)
  assert.ok(Object.values(all.perReply).reduce((a, b) => a + b, 0) > 22500)
  const fit = await selectCombined(plan2, 16000)
  assert.deepEqual(fit.dropped, ['typo', 'again2', 'stop2', 'compound', 'okok', 'offtopic'])
  assert.equal(fit.kept.length, 10); assert.ok(fit.estInputTokens * 1.03 <= 16000 && fit.estInputTokens > 13500, `estimated ${fit.estInputTokens}`)
  assert.ok(fit.kept.includes('page') && fit.kept.includes('notyet') && fit.kept.filter(id => id.startsWith('ctl-')).length === 4)
})

test('a full run with the stand-in (plan v2): every request is one resolver request; the plan\'s own expectations pass; nothing wrong; what was dropped is recorded; an unrun reply is not counted as run', async () => {
  const bodies = []
  const out = await runCombined({ plan: plan2, scripted: body => { bodies.push(body); return combinedStandIn(plan2)(body) } })
  assert.deepEqual([out.sent, out.rows.length, out.stoppedBecause, out.score.pass, out.score.wrong], [10, 10, null, true, 0])
  assert.deepEqual(out.dropped, ['typo', 'again2', 'stop2', 'compound', 'okok', 'offtopic'])
  assert.deepEqual(out.rows.map(r => [r.id, r.outcome]), [['ack', 'browser:continue'], ['again', 'browser:retry'], ['stop', 'browser:abandon'], ['page', 'browser:ask_page'], ['notyet', 'none'], ['change', 'browser:change'], ['ctl-appr', 'approval'], ['ctl-appr-browser', 'browser:continue'], ['ctl-mem', 'memory'], ['ctl-mem-page', 'browser:ask_page']])
  assert.ok(bodies.every(b => b.questions.filter(q => q.name.startsWith('oi_ref_')).length === (b.questions.length === 6 ? 1 : 2)), 'one referent question per open item')
  assert.ok(bodies.every(b => b.questions.find(q => q.name === 'oi_ref_' + b.questions.filter(x => x.name.startsWith('oi_ref_')).length).instructions.includes('Asked of the person')), 'the browser item the resolver reads says what the person was asked')
  assert.ok(out.rows.every(r => Array.isArray(r.refs)), 'every referent probability is recorded')
  // c62: the ceiling stopped the run after 10 of 11 and the unrun control was counted as a safe miss; now a stop is not a row
  const ceiling = await runCombined({ plan: plan2, budget: 6000, scripted: combinedStandIn(plan2) })
  assert.equal(ceiling.stoppedBecause, 'token_ceiling'); assert.equal(ceiling.rows.length, ceiling.sent); assert.ok(ceiling.score.notRun > 0 && ceiling.rows.every(r => !r.error))
})

test('a model that settles every message to the browser task is caught; one that answers yes to the wrong item is caught; the guards hold', async () => {
  const yesBrowser = body => body.questions.map(q => ({ name: q.name, type: 'predicate', probability: q.name === 'open_browser_continue' || q.name === `oi_ref_${body.questions.filter(x => x.name.startsWith('oi_ref_')).length}` ? 0.97 : 0.02 }))
  const bad = await runCombined({ plan, budget: 16000, scripted: yesBrowser })
  assert.equal(bad.score.pass, false)
  assert.deepEqual(bad.score.wrongReplies, ['stop', 'page', 'notyet', 'offtopic', 'change', 'ctl-appr', 'ctl-mem', 'ctl-mem-page'].filter(id => bad.score.wrongReplies.includes(id)))
  assert.ok(['notyet', 'offtopic', 'ctl-appr', 'ctl-mem'].every(id => bad.score.wrongReplies.includes(id)), `wrong: ${bad.score.wrongReplies}`)
  assert.equal((await runCombined({ plan })).stoppedBecause, 'dry_run')
  assert.equal((await runCombined({ plan, send: true, key: null })).stoppedBecause, 'no_key')
  let calls = 0
  const failing = await runCombined({ plan, send: true, key: KEY, fetchImpl: async () => { calls++; return { status: 500, text: async () => '{}' } } })
  assert.deepEqual([calls, failing.sent], [1, 1]); assert.equal(failing.stoppedBecause?.startsWith('http_500') || failing.stoppedBecause?.startsWith('resolver_'), true)
  const ok = await runCombined({ plan, send: true, key: KEY, fetchImpl: async (url, init) => ({ status: 200, text: async () => JSON.stringify({ answers: combinedStandIn(plan)(JSON.parse(init.body)), usage: { input_tokens: 1600 } }) }) })
  assert.equal(ok.stoppedBecause, 'token_ceiling', 'real usage above the estimate stops the run at the ceiling')
  assert.ok(ok.usage.inputTokens <= 16000); assert.equal(JSON.stringify(ok).includes(KEY), false)
})
