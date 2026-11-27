import test from 'node:test'
import assert from 'node:assert/strict'
import { lintGroupedRequest } from './egdesk-decision-grouping.mjs'
import { sameMatterBody, FAMILIES } from './egdesk-contamination-plan.mjs'
import { placementQuestions } from './egdesk-work-placement.mjs'

const pred = (name, instructions) => ({ type: 'predicate', name, instructions })
const problems = body => lintGroupedRequest(body).families.flatMap(f => f.problems.map(p => p.problem))

test('grouping lint: the L1 c12 construction fails, the c13 construction and labelled references pass', () => {
  const f = FAMILIES['same-matter']
  // c12: every card in its own input message, the same instruction for every question (grouped answers collapsed in the real run)
  const c12 = sameMatterBody(f.request, [f.yes, ...f.noSiblings])
  assert.deepEqual(problems(c12), ['identical_instructions', 'identical_instructions', 'identical_instructions'])
  // c13: each card quoted inside its own question (real: grouped answers equal to one card per request)
  const c13 = placementQuestions({ kind: 'placement', surface: 'file', related: [f.yes, ...f.noSiblings].map((c, i) => ({ alias: `R${i + 1}`, title: c.title, excerpt: c.text })) }, { request: f.request })
  const r = lintGroupedRequest(c13)
  assert.deepEqual([r.ok, r.families.map(x => [x.family, x.kind])], [true, [['same_matter_R#', 'inline']]])
  // a short label passes only when the input carries it
  const labelled = { input: [{ role: 'user', content: 'c1: 봄 학기 환불 규정\nc2: 주차장 점검' }], questions: [pred('c1', 'Is the excerpt labeled c1 relevant?'), pred('c2', 'Is the excerpt labeled c2 relevant?')] }
  assert.equal(lintGroupedRequest(labelled).families[0].kind, 'reference')
  const dangling = { input: [{ role: 'user', content: '봄 학기 환불 규정과 주차장 점검' }], questions: labelled.questions }
  assert.deepEqual(problems(dangling), ['unresolved_reference', 'unresolved_reference'])
  // developer text does not count as the input that carries the label
  assert.deepEqual(problems({ input: [{ role: 'developer', content: 'c1 c2' }, { role: 'user', content: '본문' }], questions: labelled.questions }), ['unresolved_reference', 'unresolved_reference'])
  // two near-identical quoted lines are still each their own item
  const near = { input: [], questions: [pred('slot_P3_r1', 'Line: {"text":"견적서 v2 납기 12월 15일"}. Supported?'), pred('slot_P3_r2', 'Line: {"text":"견적서 v2 납기 12월 20일"}. Supported?')] }
  assert.equal(lintGroupedRequest(near).families[0].kind, 'inline')
  // a single question, or questions of different families, are not a group
  assert.deepEqual(lintGroupedRequest({ input: [], questions: [pred('a', 'x'), pred('b', 'x')] }).families, [])
})

const bodiesOf = (x, out = [], seen = new Set()) => {
  if (typeof x === 'string' && x.startsWith('{') && x.includes('"questions"')) { try { const b = JSON.parse(x); if (Array.isArray(b?.questions)) out.push(b) } catch { /* not a body */ } return out }
  if (!x || typeof x !== 'object' || seen.has(x)) return out
  seen.add(x)
  if (Buffer.isBuffer(x) || x instanceof Uint8Array) { try { const b = JSON.parse(Buffer.from(x).toString('utf8')); if (Array.isArray(b?.questions)) out.push(b) } catch { /* not a body */ } return out }
  if (Array.isArray(x.questions) && x.input !== undefined && x.questions.every(q => q && typeof q.name === 'string')) { out.push(x); return out }
  for (const v of Object.values(x)) bodiesOf(v, out, seen)
  return out
}

// Every builder that groups per-item questions, through the product code that builds its bodies (the plan builders record the exact
// bytes the product would post). The only failing bodies allowed are the contamination study's deliberate reproduction of L1 c12.
const BUILDERS = [['egdesk-board-reply-real-plan.mjs', 'buildBoardReplyPlan'], ['egdesk-browser-real-plan.mjs', 'buildBrowserRealPlan'], ['egdesk-command-risk-plan.mjs', 'buildCommandRiskPlanV2'],
  ['egdesk-confirmation-plan.mjs', 'buildConfirmationPlan'], ['egdesk-contamination-plan.mjs', 'buildContaminationPlan'], ['egdesk-heartbeat-real-plan.mjs', 'buildHeartbeatPlan'],
  ['egdesk-l1-remeasure-plan.mjs', 'buildRemeasurePlan'], ['egdesk-memory-real-plan.mjs', 'buildPlan'], ['egdesk-memory-real-plan.mjs', 'buildUtterancePlan'],
  ['egdesk-work-placement-real-plan.mjs', 'buildPlacementPlan'], ['egdesk-working-memory-real-plan.mjs', 'buildWorkingMemoryPlan'], ['egdesk-write-target-plan.mjs', 'buildWriteTargetPlan']]

test('grouping lint: every product-built grouped request passes; only the registered c12 reproduction fails', async () => {
  const seenFamilies = new Set(), failing = []
  for (const [file, fn] of BUILDERS) {
    const bodies = bodiesOf(await (await import(`./${file}`))[fn]())
    assert.ok(bodies.length > 0, `${fn} built no body`)
    for (const b of bodies) {
      const r = lintGroupedRequest(b)
      for (const f of r.families) seenFamilies.add(f.family)
      if (!r.ok) failing.push(`${fn}: ${r.families.filter(f => f.problems.length).map(f => f.family).join(',')}`)
    }
  }
  assert.deepEqual([...new Set(failing)], ['buildContaminationPlan: same_matter_R#'])
  for (const family of ['c#', 'c#_now', 'same_matter_R#', 'slot_P#_r#', 'pg_#', 'st_P#', 'op_P#', 'tw_link_#', 'tw_about_#', 'wm_need_b#']) assert.ok(seenFamilies.has(family), `${family} was linted`)
})

test('grouping lint: builders asked directly (turn context catalog, draft check, log blocks, working-memory choice design)', async () => {
  const captured = []
  const client = { async decide(request) { captured.push(request); return { answers: {}, latencyMs: 0 } } }
  const { prepareTurnContext } = await import('./egdesk-context-setup.mjs')
  await prepareTurnContext({ message: 'A사 견적 정리해 줘', client, candidates: ['A사 견적서 v1', 'A사 단가 협의', 'B사 계약'].map((title, i) => ({ id: `c${i}`, kind: 'ontology', title, summary: `${title} 요약`, timeSlice: 'past', status: 'done' })) }).catch(() => null)
  const { pickRelevantBlocks, enumerateLogBlocks } = await import('./egdesk-terminal-judge.mjs')
  const log = ['> build', ...Array.from({ length: 30 }, (_, i) => `compiling module ${i}`), 'src/a.ts(3,1): error TS2345: Argument of type string', '', 'npm ERR! code 1', ...Array.from({ length: 10 }, (_, i) => `at frame ${i}`)].join('\n')
  await pickRelevantBlocks({ blocks: enumerateLogBlocks(log), mode: 'on', client, egress: { allows: () => true } }).catch(() => null)
  const { checkDraft } = await import('./egdesk-draft-check.mjs')
  // L3 c18 made the predicate design the default (sup_#/tense_#); the choice design (claim_#/present_#) stays selectable: lint both
  for (const design of ['predicates', 'choice']) await checkDraft({ design, draft: 'A사 견적서 v1은 11월 6일에 12,800원으로 발송했습니다. v2는 12월 20일 납기로 보낼 예정입니다. 팀장 승인이 남았습니다.', evidence: [{ time: 'past', status: 'done', text: '11월 6일 단가 12,800원으로 견적서 v1을 발송했다.' }, { time: 'planned', status: 'plan', text: '납기 12월 20일로 견적서 v2를 보낼 예정이다.' }],
    userText: 'A사 견적 정리', mode: 'on', client }).catch(() => null)
  const { buildGateRequest, enumerateBlockOptions } = await import('./egdesk-working-memory-gate.mjs')
  const text = Array.from({ length: 6 }, (_, k) => [`## 절 ${k}`, ...Array.from({ length: 8 }, (_, i) => `절 ${k}의 ${i}번째 문장은 서로 다른 내용을 담고 있습니다.`)].join('\n')).join('\n\n')
  const { lines, blocks } = enumerateBlockOptions(text, { kind: 'page', canSpill: true })
  captured.push(buildGateRequest({ lines, blocks, kind: 'page', goal: '요약', design: 'choice' }).request, buildGateRequest({ lines, blocks, kind: 'page', goal: '요약' }).request)
  const families = new Set()
  for (const body of captured) { const r = lintGroupedRequest(body); assert.equal(r.ok, true, JSON.stringify(r.families.filter(f => f.problems.length))); r.families.forEach(f => families.add(f.family)) }
  for (const family of ['rel_#', 'claim_#', 'present_#', 'sup_#', 'tense_#', 'log_b#', 'wm_b#', 'wm_need_b#']) assert.ok(families.has(family), `${family} was linted (got ${[...families].join(',')})`)
})

test('grouping lint: the browser reflex (same_#, field_#) and session topic (topic_need_#) builders, through their own code', async () => {
  const captured = []
  const client = { async decide(request) { captured.push(request); return { answers: {}, latencyMs: 0 } } }
  const { decideRecordedStep, mapValuesToFields } = await import('./egdesk-browser-reflex.mjs')
  const { decisionThresholds } = await import('./egdesk-decision-questions.mjs')
  const snapshot = { url: 'https://shop.example/checkout', text: '배송지 입력\n받는 분 이름\n연락처\n주소' }
  await decideRecordedStep({ goal: '배송지 입력', snapshot, client, thresholds: decisionThresholds(),
    recorded: { kind: 'maybe', maybe: [{ value: '[L1] 기본 배송지' }, { value: '[L2] 회사 배송지' }, { value: '[L3] 새 배송지 추가' }], item: { chose: '기본 배송지 사용' } } }).catch(() => null)
  await mapValuesToFields({ keys: ['받는 분 이름', '연락처', '주소'], fieldOptions: [{ value: '[F1] 이름' }, { value: '[F2] 전화번호' }, { value: '[F3] 주소 입력' }], snapshot, client, thresholds: decisionThresholds() }).catch(() => null)
  const { planSessionTopic } = await import('./egdesk-session-topic.mjs')
  const row = (key, extra = {}) => ({ key, topic: key, parent: null, needs: [], userText: `${key} 질문`, assistantText: `${key} 답`, ...extra })
  const topic = planSessionTopic({ turns: [row('a'), row('b', { parent: 'a', needs: ['a'] }), row('c')], currentKey: 'next' })
  captured.push({ input: topic.input, questions: topic.questions })
  const families = new Map()
  for (const body of captured) { const r = lintGroupedRequest(body); assert.equal(r.ok, true, JSON.stringify(r.families.filter(f => f.problems.length))); r.families.forEach(f => families.set(f.family, f.kind)) }
  assert.deepEqual([families.get('same_#'), families.get('field_#'), families.get('topic_need_#')], ['inline', 'inline', 'reference'])
})
