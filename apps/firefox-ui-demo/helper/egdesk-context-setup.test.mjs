import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { DecisionError } from './egdesk-decision-client.mjs'
import { DECISION_CONTEXT_KEY, candidatesFromOntologyGraph, decisionContextActivity, judgeBranchSave, planBranchContext,
  planTimelineTransition, prepareTurnContext } from './egdesk-context-setup.mjs'

const USAGE = Object.freeze({ inputTokens: 100, cachedTokens: 0, cacheWriteTokens: 0, outputTokens: 0, totalTokens: 100 })
const choice = (value, confidence = 0.9, runnerUp = 0.05) => ({ type: 'choice', choice: value, confidence,
  probabilities: [{ value, probability: confidence }, { value: '__other', probability: runnerUp }] })
const predicate = probability => ({ type: 'predicate', probability })

function fakeClient(answerFor) {
  const calls = []
  return {
    calls,
    client: {
      async decide(request) {
        calls.push(request)
        const answers = Object.create(null)
        for (const question of request.questions) answers[question.name] = answerFor(question, request, calls.length)
        return { answers, model: 'gpt-6-luna', usage: USAGE, latencyMs: 120 }
      },
    },
  }
}
// Catalog lines are '#i | kind | time=… | title | summary'.
const catalogTitles = request => request.input[1].content[0].text.split('\n').slice(1).map(line => line.split(' | ')[3])

const CANDIDATES = [
  { id: 'code-v1', kind: 'source', title: '결제 모듈 v1 코드', summary: '동기 처리', timeSlice: 'present', status: 'observed', sourceRef: 'src/pay/v1',
    loadText: async () => 'v1 full text' },
  { id: 'design-v2', kind: 'document', title: 'v2 설계안', summary: '비동기 전환 계획', timeSlice: 'planned', status: 'planned', sourceRef: 'ideas/v2.md' },
  { id: 'incident', kind: 'document', title: '3월 장애 기록', summary: '타임아웃', timeSlice: 'past' },
  { id: 'unrelated', kind: 'board', title: '마케팅 일정', summary: '광고', timeSlice: 'present' },
  { id: 'pinned', kind: 'board', title: '보드 목표', summary: '결제 안정화', timeSlice: 'present', mandatory: true },
]
const RELEVANCE = { '결제 모듈 v1 코드': 0.95, 'v2 설계안': 0.7, '3월 장애 기록': 0.6, '마케팅 일정': 0.1, '보드 목표': 0.05 }
function contextAnswers(timeIntent = 'present', overrides = {}) {
  return (question, request) => {
    if (question.name === 'answer_type') return choice('answer')
    if (question.name === 'time_intent') return choice(timeIntent)
    const title = catalogTitles(request)[Number(question.name.slice(4))]
    return Object.hasOwn(overrides, title) ? overrides[title] : predicate(RELEVANCE[title])
  }
}

test('one request picks the items, tags their time and keeps planned items out of a present-tense answer', async () => {
  const { client, calls } = fakeClient(contextAnswers('present'))
  const message = '결제 모듈 v1 코드 지금 어떻게 돼 있어?'
  const result = await prepareTurnContext({ message, candidates: CANDIDATES, client, cacheScope: 'thread-1' })
  assert.equal(result.status, 'ready')
  assert.equal(result.answerType, 'answer')
  assert.equal(result.timeIntent, 'present')
  // mandatory, then mentioned, then scored; v2 (planned, 0.7) stays below the strict 0.8 bar.
  assert.deepEqual(result.selected.map(item => [item.id, item.reason]), [['pinned', 'mandatory'], ['code-v1', 'mentioned'], ['incident', 'scored']])
  const packet = result.extraContext[DECISION_CONTEXT_KEY]
  assert.match(packet, /Never state a planned or hypothetical item as a current fact/)
  assert.match(packet, /\[item id=code-v1 kind=source time=present status=observed source=src\/pay\/v1\]\nv1 full text/)
  assert.match(packet, /\[item id=incident kind=document time=past\]\n타임아웃/)
  assert.doesNotMatch(packet, /design-v2|마케팅/)
  assert.equal(calls.length, 1)
  const request = calls[0]
  assert.equal(request.questions.length, 2 + CANDIDATES.length)
  assert.equal(request.input[1].content[0].prompt_cache_breakpoint.mode, 'explicit')
  assert.equal(request.input[2].content, `Message:\n${message}`)
  assert.ok(request.promptCacheKey.startsWith('egd-thread-1-') && request.promptCacheKey.length <= 64)
  assert.equal(result.receipt.outcome, 'ready')
  assert.deepEqual(result.receipt.unknown, [])
  assert.deepEqual(result.receipt.usage, USAGE)
})

test('a question about plans attaches the planned item at the normal bar', async () => {
  const { client } = fakeClient(contextAnswers('planned'))
  const result = await prepareTurnContext({ message: '다음 버전 계획은?', candidates: CANDIDATES, client })
  assert.ok(result.selected.some(item => item.id === 'design-v2' && item.timeSlice === 'planned'))
  assert.match(result.extraContext[DECISION_CONTEXT_KEY], /\[item id=design-v2 kind=document time=planned status=planned source=ideas\/v2.md\]/)
})

test('a refused relevance question is unknown, not irrelevant, and is reported', async () => {
  const { client } = fakeClient(contextAnswers('present', { '3월 장애 기록': { type: 'refusal' } }))
  const result = await prepareTurnContext({ message: '장애 원인 알려줘', candidates: CANDIDATES, client })
  assert.ok(!result.selected.some(item => item.id === 'incident'))
  assert.deepEqual(result.receipt.unknown, ['incident'])
})

test('decision failures fall back to the turn as it runs today', async () => {
  const failing = { async decide() { throw new DecisionError('no_credit', 'Decision request failed (no_credit)') } }
  const result = await prepareTurnContext({ message: '질문', candidates: CANDIDATES, client: failing })
  assert.equal(result.status, 'fallback')
  assert.equal(result.reason, 'no_credit')
  assert.deepEqual(result.extraContext, {})
  assert.equal((await prepareTurnContext({ message: '질문', candidates: CANDIDATES, client: null })).status, 'skipped')
  assert.equal((await prepareTurnContext({ message: '질문', candidates: [], client: failing })).reason, 'no_candidates')
  assert.equal((await prepareTurnContext({ message: '  ', candidates: CANDIDATES, client: failing })).reason, 'no_message')
})

test('text budgets truncate long items and a failing loader falls back to the summary', async () => {
  const long = 'ㄱ'.repeat(500)
  const candidates = [
    { id: 'long', title: '긴 문서', summary: '요약', timeSlice: 'present', loadText: () => long },
    { id: 'broken', title: '깨진 문서', summary: '깨진 요약', timeSlice: 'present', loadText: () => { throw new Error('read failed') } },
  ]
  const { client } = fakeClient((question) => (question.type === 'choice' ? choice(question.choices[0].value) : predicate(0.9)))
  const result = await prepareTurnContext({ message: '문서', candidates, client, itemChars: 100, maxChars: 10000 })
  const packet = result.extraContext[DECISION_CONTEXT_KEY]
  assert.match(packet, /\[…truncated\]/)
  assert.match(packet, /\[item id=broken kind=document time=present\]\n깨진 요약/)
  assert.deepEqual(result.receipt.selected.map(item => item.textSource), ['full-truncated', 'summary-after-error'])
})

test('more candidates than questions keep the forced ones', async () => {
  const many = Array.from({ length: 500 }, (_, index) => ({ id: `doc-${index}`, title: `문서 ${index}`, timeSlice: 'present' }))
  many.push({ id: 'must', title: '필수 자료', mandatory: true })
  const { client, calls } = fakeClient((question) => (question.type === 'choice' ? choice(question.choices[0].value) : predicate(0.1)))
  const result = await prepareTurnContext({ message: '아무 질문', candidates: many, client })
  assert.equal(calls[0].questions.length, 400)
  assert.equal(result.receipt.trimmed, 103)
  assert.deepEqual(result.selected.map(item => item.id), ['must'])
})

test('a what-if branch picks its base, then only facts that belong to it', async () => {
  const bases = [
    { id: 'now', kind: 'timeline', title: '현재 스냅샷', summary: '팀 4명, 진행률 60%', timeSlice: 'present', branchId: 'snap-now' },
    { id: 'plan-a', kind: 'timeline', title: '3월 출시 계획', timeSlice: 'planned', branchId: 'plan-a' },
  ]
  const facts = [
    { id: 'team', title: '팀 4명', timeSlice: 'present' },
    { id: 'progress', title: '진행률 60%', timeSlice: 'present' },
    { id: 'plan-a-qa', title: 'QA 2주', timeSlice: 'planned', branchId: 'plan-a' },
    { id: 'other-branch', title: '다른 가정', timeSlice: 'hypothetical', branchId: 'b2' },
  ]
  const { client, calls } = fakeClient((question) => {
    if (question.name === 'branch_base') return choice('[현재] 현재 스냅샷')
    return predicate({ fact_0: 0.9, fact_1: 0.8 }[question.name] ?? 0.1)
  })
  const message = '다음 달에 인력 2명 늘리면 출시 일정 어떻게 바뀌어?'
  const result = await planBranchContext({ message, bases, facts, client })
  assert.equal(result.status, 'ready')
  assert.equal(result.base.id, 'now')
  assert.deepEqual(result.facts.map(item => item.id), ['team', 'progress'])
  assert.equal(calls.length, 2)
  assert.equal(calls[1].questions.length, 2) // the plan-a and other-branch facts are not eligible on the current base
  const packet = result.extraContext[DECISION_CONTEXT_KEY]
  assert.match(packet, /\[base\]\n\[item id=now kind=timeline time=present\]/)
  assert.ok(packet.endsWith(`[hypothetical assumption, the person's words]\n${message}`))
  const unsure = fakeClient(() => choice('[현재] 현재 스냅샷', 0.5, 0.4))
  const uncertain = await planBranchContext({ message, bases, facts, client: unsure.client })
  assert.equal(uncertain.status, 'uncertain')
  assert.equal(unsure.calls.length, 1)
})

test('a finished plan becomes a proposal the person confirms; a changed plan needs words', async () => {
  const openItems = [
    { id: 'v2', title: 'v2 배포안', timeSlice: 'planned', summary: '비동기 결제' },
    { id: 'live', title: '운영 중 v1', timeSlice: 'present' },
  ]
  const run = async (plan, kind, confidence = 0.95) => {
    const { client, calls } = fakeClient((question) => (question.name === 'plan' ? choice(plan, confidence, 0.02) : choice(kind, confidence, 0.02)))
    const result = await planTimelineTransition({ message: 'v2 배포 끝났어. 헬스체크도 통과했어.', openItems, client })
    return { result, calls }
  }
  const done = await run('v2 배포안', 'completed')
  assert.equal(done.result.status, 'proposal')
  assert.deepEqual(done.result.proposal, { itemId: 'v2', title: 'v2 배포안', from: 'planned', to: 'present', demoteCurrentTo: 'past' })
  assert.match(done.result.confirmText, /"v2 배포안"을\(를\) 현재 상태로 올릴까요/)
  assert.equal(done.calls[0].questions[0].choices.length, 2) // 'no listed plan' + the one planned item
  assert.equal((await run('v2 배포안', 'cancelled')).result.proposal.to, 'past')
  assert.equal((await run('v2 배포안', 'changed')).result.status, 'needs_reasoning')
  assert.equal((await run('no listed plan', 'completed')).result.status, 'none')
  assert.equal((await run('v2 배포안', 'completed', 0.6)).result.status, 'uncertain')
})

test('an exact top tie in transition kind does not produce a timeline proposal', async () => {
  const { client } = fakeClient(question => question.name === 'plan'
    ? { type: 'choice', choice: 'v2 배포안', confidence: 0.95,
      probabilities: [{ value: 'v2 배포안', probability: 0.95 }, { value: 'no listed plan', probability: 0.05 }] }
    : { type: 'choice', choice: 'completed', confidence: 0.95,
      probabilities: [{ value: 'completed', probability: 0.5 }, { value: 'cancelled', probability: 0.5 }] })
  const result = await planTimelineTransition({ message: 'v2 배포 상태가 바뀌었어.',
    openItems: [{ id: 'v2', title: 'v2 배포안', timeSlice: 'planned' }], client })
  assert.equal(result.status, 'uncertain')
  assert.equal(result.receipt.plan.state, 'accepted')
  assert.deepEqual(result.receipt.kind, { value: 'completed', confidence: 0.95, state: 'uncertain' })
  assert.equal(result.proposal, undefined)
})

test('branch save offer and activity row', async () => {
  const { client } = fakeClient(() => predicate(0.8))
  assert.deepEqual(await judgeBranchSave({ message: 'm', answerText: 'a', client }), { status: 'ready', offer: true, probability: 0.8, usage: USAGE })
  const row = decisionContextActivity({ answerId: 'answer-1', latencyMs: 123.4, model: 'gpt-6-luna',
    selected: [{ id: 'code-v1', title: '결제 모듈 v1 코드', timeSlice: 'present', sourceRef: 'src/pay/v1' }, { id: 'v2', title: 'v2 설계안', timeSlice: 'planned' }] })
  assert.equal(row.kind, 'decisionContext')
  assert.equal(row.status, 'completed')
  assert.equal(row.title, '컨텍스트 세팅 · 자료 2개')
  assert.deepEqual(row.detail, { items: [{ id: 'code-v1', time: '현재', title: '결제 모듈 v1 코드', source: 'src/pay/v1' }, { id: 'v2', time: '계획', title: 'v2 설계안' }],
    latencyMs: 123, model: 'gpt-6-luna' })
  assert.deepEqual(row.sourceRefs, [])
  assert.match(row.id, /^decision-context-[0-9a-f]{24}$/)
})

test('the bundled ontology graph maps to timeline and document candidates', async () => {
  const graph = JSON.parse(readFileSync(new URL('../overlay/resources/ontology/graph.json', import.meta.url), 'utf8'))
  const candidates = candidatesFromOntologyGraph(graph)
  assert.equal(candidates.length, graph.snapshots.length + graph.nodes.length)
  const snapshots = candidates.filter(candidate => candidate.id.startsWith('ontology-snapshot:'))
  assert.deepEqual(snapshots.map(item => item.timeSlice).sort(), graph.snapshots.map(item => ({ future: 'planned', present: 'present' }[item.timeSlice])).sort())
  const withBody = candidates.find(candidate => typeof candidate.loadText === 'function')
  assert.ok(withBody && withBody.loadText().length > 0)
  const { client } = fakeClient((question) => (question.type === 'choice' ? choice(question.choices[0].value) : predicate(0.1)))
  const result = await prepareTurnContext({ message: '온톨로지 구조', candidates, client })
  assert.ok(['ready', 'empty'].includes(result.status))
})

const speechStub = (message, allowed = () => true) => ({ allowed, modeActive: () => true,
  segments: [{ start: 0, end: message.length }] })
const lowSpeech = (name, request) => (/^speech_/.test(name) ? { type: 'choice', choice: 'plan', confidence: 0.16,
  probabilities: [{ value: 'plan', probability: 0.16 }, { value: 'assertion', probability: 0.15 }] } : null)

test('speech trace: an unconfirmed label is withheld, and the receipt/activity say how many labels and what recall verdict, with no text', async () => {
  const message = '내일 살펴볼 예정이야.'
  const { client } = fakeClient((q, r) => lowSpeech(q.name, r) || (q.name === 'rel_recall' ? predicate(0.16) : q.name === 'answer_type' ? choice('answer') : q.name === 'time_intent' ? choice('not_time_specific') : predicate(0.9)))
  const out = await prepareTurnContext({ message, candidates: [...CANDIDATES.slice(0, 1), { id: 'conversation:recent', kind: 'conversation', title: 'recent', timeSlice: 'unknown', mayRead: () => true, loadText: () => '{}' }],
    client, askedAt: Date.UTC(2026, 10, 23, 3), speech: speechStub(message) })
  assert.deepEqual(out.speechInterpretations, [])
  assert.deepEqual(out.receipt.speech, { segments: 1, axes: 3, accepted: 0, anchor: '2026-11-23T03:00:00.000Z', recall: { state: 'no', probability: 0.16 } })
  const row = decisionContextActivity({ answerId: 'a', selected: out.selected, speech: out.receipt.speech, dropped: out.receipt.dropped })
  assert.match(row.title, /발언 해석 0\/3개 채택/)
  assert.ok(!JSON.stringify(row).includes('살펴볼'))
})

test('items beyond the limit are reported as dropped by id, never silently', async () => {
  const { client } = fakeClient((q, r) => q.name === 'answer_type' ? choice('answer') : q.name === 'time_intent' ? choice('not_time_specific') : predicate(0.9))
  const out = await prepareTurnContext({ message: '정리해 줘', candidates: CANDIDATES, client, maxItems: 2 })
  assert.equal(out.selected.length, 2)
  assert.ok(out.receipt.dropped.length >= 1 && out.receipt.dropped.every(d => d.reason === 'over_item_limit' && typeof d.id === 'string'))
  assert.match(decisionContextActivity({ answerId: 'a', selected: out.selected, dropped: out.receipt.dropped }).title, /못 붙인 자료/)
})

test('a discarded topic batch keeps a typed-name item but none of the model-scored items', async () => {
  const message = '보드 목표 기준으로 정리해 줘'
  const topic = { plan: { questions: [{ type: 'predicate', name: 'topic_need_0', instructions: 'x' }], input: [], resolve: () => null },
    allowed: () => true, authorizeDispatch: () => true }
  const { client } = fakeClient(q => (q.name === 'answer_type' ? choice('answer') : q.name === 'time_intent' ? choice('not_time_specific') : predicate(0.95)))
  const out = await prepareTurnContext({ message, candidates: CANDIDATES.slice(0, 5), client, topic })
  assert.equal(out.privateTopicBatch, true)
  assert.deepEqual(out.selected.map(s => s.id).sort(), ['pinned'])
})
