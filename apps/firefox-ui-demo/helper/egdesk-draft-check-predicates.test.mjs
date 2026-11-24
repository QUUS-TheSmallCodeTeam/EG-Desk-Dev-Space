import test from 'node:test'
import assert from 'node:assert/strict'
import { checkDraft } from './egdesk-draft-check.mjs'

// The draft check's second way of asking (design 'predicates'): per sentence its own block (the sentence and the evidence code relates
// to it, quoted with time tags) and two yes/no questions; code combines. The default ('choice') is unchanged. Mock clients only.
// The s1 material is the public synthetic wiki of the all-on journey (the evidence items as the product built them on 2026-11-24).
const S1_EVIDENCE = [
  { id: 'a-v1', kind: 'document', time: 'past', status: 'unknown', source: 'document', text: 'A사 견적서 v1 발송 11월 6일 단가 12,800원으로 견적서 v1을 발송했다. A사 회신을 기다리는 중이다.' },
  { id: 'a-v2', kind: 'document', time: 'planned', status: 'unknown', source: 'document', text: 'A사 견적서 v2 수정 계획 단가 12,200원, 납기 12월 20일로 견적서 v2를 보낼 예정이다. 아직 발송하지 않았다. 팀장 승인 후 발송한다.' },
  { id: 'pg', kind: 'document', time: 'present', text: 'PostgreSQL 헬스체크 3종 체크리스트' },
  { id: 'tool1', kind: 'tool', opaque: true },
]
const S1_DRAFT = 'A사 견적은 v1 발송 후 v2 수정 계획 단계이며 팀장 승인 후 발송 예정입니다.'
function client(answer) {
  const requests = []
  return { requests, async decide(request) { requests.push(request); const answers = {}; for (const q of request.questions) answers[q.name] = answer(q, request); return { answers, usage: { inputTokens: 10 } } } }
}
const p = probability => ({ type: 'predicate', probability })

test('default design is the choice, unchanged; the predicate design quotes the evidence once and each sentence on its own, with two yes/no questions per sentence', async () => {
  const choice = client(q => (q.type === 'choice' ? { type: 'choice', choice: 'supported', confidence: 0.9, probabilities: [{ value: 'supported', probability: 0.95 }, { value: 'insufficient', probability: 0.03 }] } : p(0.02)))
  await checkDraft({ draft: S1_DRAFT, evidence: S1_EVIDENCE.filter(e => !e.opaque), mode: 'on', client: choice })
  assert.deepEqual(choice.requests[0].questions.map(q => [q.name, q.type]), [['claim_0', 'choice'], ['present_0', 'predicate']])
  const pred = client(q => p(q.name.startsWith('sup_') ? 0.95 : 0.04))
  const out = await checkDraft({ draft: `${S1_DRAFT}\n담당자는 김 대리입니다.`, evidence: S1_EVIDENCE, mode: 'on', client: pred, design: 'predicates' })
  const request = pred.requests[0]
  assert.deepEqual(request.questions.map(q => [q.name, q.type]), [['sup_0', 'predicate'], ['tense_0', 'predicate'], ['sup_1', 'predicate'], ['tense_1', 'predicate']])
  assert.match(request.questions[0].instructions, /^Does the evidence say what sentence S1 says/); assert.match(request.questions[1].instructions, /^Does sentence S1 say that something is done or true now that the evidence records only as planned or only as past\?$/)
  const blocks = request.input.map(row => row.content)
  assert.equal(blocks.length, 4, 'the rules, the evidence once, then one block per sentence')
  assert.match(blocks[1], /^Evidence:\n\[E1 time=past status=unknown\]\n"""\nA사 견적서 v1 발송 11월 6일/); assert.match(blocks[1], /\[E2 time=planned status=unknown\]\n"""\nA사 견적서 v2 수정 계획/)
  assert.match(blocks[1], /\[E3 time=present\]\n"""\nPostgreSQL/); assert.doesNotMatch(blocks[1], /content not available/, 'a content-free reference is not quoted')
  assert.deepEqual(blocks.slice(2), ['Sentence S1:\n"""\nA사 견적은 v1 발송 후 v2 수정 계획 단계이며 팀장 승인 후 발송 예정입니다.\n"""', 'Sentence S2:\n"""\n담당자는 김 대리입니다.\n"""'])
  assert.equal(out.outcome, 'passed'); assert.equal(out.calibration.design, 'predicates')
  assert.deepEqual(out.calibration.judgments.map(j => [j.q, j.would]), [['claim_supported', 'accept'], ['claim_tense', 'accept'], ['claim_supported', 'accept'], ['claim_tense', 'accept']])
})

test('code combines: unverified needs a confident no on a concrete sentence and no content-free reference; a tense yes is a finding; the middle settles nothing', async () => {
  const run = async (sup, tense, { evidence = S1_EVIDENCE.filter(e => !e.opaque), draft = S1_DRAFT } = {}) => {
    const c = client(q => p(q.name.startsWith('sup_') ? sup : tense))
    const out = await checkDraft({ draft, evidence, mode: 'advisory', client: c, design: 'predicates' })
    return out.findings.map(f => f.kind)
  }
  assert.deepEqual(await run(0.95, 0.05), [])
  assert.deepEqual(await run(0.1, 0.05), ['unverified'])
  assert.deepEqual(await run(0.31, 0.05), [], 'not confidently unsupported: nothing concluded')
  assert.deepEqual(await run(0.1, 0.05, { evidence: S1_EVIDENCE }), [], 'a content-free reference may hold it')
  assert.deepEqual(await run(0.1, 0.05, { draft: '곧 정리해서 알려 드릴게요.' }), [], 'nothing concrete to verify')
  assert.deepEqual(await run(0.95, 0.9), ['present_tense'])
  // a failed or missing answer settles nothing
  const broken = client(() => null)
  const out = await checkDraft({ draft: S1_DRAFT, evidence: S1_EVIDENCE, mode: 'on', client: broken, design: 'predicates' })
  assert.deepEqual([out.outcome, out.text], ['passed', S1_DRAFT])
})

test('the s1 answer: with sound answers on the predicate design it is posted as written; with the real choice answers of 2026-11-24 it was replaced', async () => {
  const sound = client(q => p(q.name.startsWith('sup_') ? 0.96 : 0.04))
  const posted = await checkDraft({ draft: S1_DRAFT, evidence: S1_EVIDENCE, mode: 'on', client: sound, design: 'predicates', revise: async () => assert.fail('no revision') })
  assert.deepEqual([posted.outcome, posted.text], ['passed', S1_DRAFT])
  // the real answers to the choice body: claim_0 insufficient (.69 then .76), present_0 .97 then .96
  const real = [{ claim_0: { type: 'choice', choice: 'insufficient', confidence: 0.69, probabilities: [{ value: 'insufficient', probability: 0.77 }, { value: 'supported', probability: 0.2 }] }, present_0: p(0.97) },
    { claim_0: { type: 'choice', choice: 'insufficient', confidence: 0.76, probabilities: [{ value: 'insufficient', probability: 0.82 }, { value: 'supported', probability: 0.15 }] }, present_0: p(0.96) }]
  let n = 0
  const replay = { async decide() { return { answers: real[n++], usage: null } } }
  const blocked = await checkDraft({ draft: S1_DRAFT, evidence: S1_EVIDENCE, mode: 'on', client: replay, revise: async () => '앞에서 확인한 내용 기준으로, A사 견적은 요청을 받은 뒤 첫 견적서를 보냈고 수정본은 팀장 승인 뒤 보낼 예정입니다.' })
  assert.equal(blocked.outcome, 'ask_user', 'the present predicate flagged a correctly worded plan twice')
})

test('concreteOnly (heartbeat messages, composed from facts of the present): a sentence without a concrete detail is not sent; none left, no request', async () => {
  const c = client(() => p(0.5))
  const facts = [{ id: 'now', kind: 'run_state', time: 'present', text: '10 seconds have passed. The assistant is running a command: `npm test`.' }]
  const none = await checkDraft({ draft: '확인하는 데 시간이 조금 걸리고 있어요. 곧 이어서 말씀드릴게요.', evidence: facts, mode: 'on', client: c, concreteOnly: true })
  assert.deepEqual([none.outcome, c.requests.length], ['unchecked', 0])
  const some = await checkDraft({ draft: '`npm test`를 10초째 돌리고 있어요. 곧 이어서 말씀드릴게요.', evidence: facts, mode: 'on', client: c, concreteOnly: true, design: 'predicates' })
  assert.equal(c.requests.length, 1); assert.deepEqual(c.requests[0].questions.map(q => q.name), ['sup_0', 'tense_0'])
  assert.notEqual(some.outcome, undefined)
  const all = client(() => p(0.5))
  await checkDraft({ draft: '확인하는 데 시간이 조금 걸리고 있어요.', evidence: facts, mode: 'on', client: all })
  assert.equal(all.requests.length, 1, 'without concreteOnly the plain sentence is still asked about (answers, unchanged)')
})
