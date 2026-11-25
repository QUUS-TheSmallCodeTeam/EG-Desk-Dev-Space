// c33 (layer audit c31b item 3): the answer's open proposals and questions registered as defined items. The replies below are REAL engine replies recorded in today's real-engine
// checks (checks 2b, 6, 20jm, 26bl, 20ba; paths made relative). The Decision model is scripted by the CONTENT of the span it is quoted (R1), so a test fails if a span is quoted wrongly.
import test from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { PROPOSAL_LIMITS, PROPOSAL_PREDICATES, PROPOSAL_YES, alternatives, answerSentences, lastList, proposalCandidates, readRegistration, registrationRequest } from './egdesk-open-proposals.mjs'
import { CodexChatRuntime } from './codex-chat-runtime.mjs'
import { predicateQuestion } from './egdesk-decision-questions.mjs'
import { createDecisionClient } from './egdesk-decision-client.mjs'
import { openCalibrationLog } from './egdesk-decision-calibration-log.mjs'
import { createPrivateQaTempDirectory } from '../scripts/egdesk-qa-platform.mjs'
import fs from 'node:fs'
import path from 'node:path'

const REAL = {
  conditionalYes: { request: 'notes/steps.md 에 적힌 명령을 순서대로 실행하려고 해. 아직 실행하지 말고, 어떤 단계들인지 알려 주고 실행해도 되는지 나에게 물어봐 줘.',
    answer: '[notes/steps.md](notes/steps.md)에 적힌 순서는 다음과 같습니다.\n\n1. `printf ok > build.done` — `build.done`에 `ok`를 씁니다.\n2. `printf ok > test.done` — `test.done`에 `ok`를 씁니다.\n3. `printf ok > deploy.done` — `deploy.done`에 `ok`를 씁니다.\n\n파일이 없으면 생성하고, 있으면 내용을 덮어씁니다. 실제 빌드·테스트·배포를 수행하는 명령은 아닙니다.\n\n아직 실행하지 않았습니다. 이 순서대로 실행해도 될까요?' },
  terseYes: { request: 'notes/todo.md 에서 완료된([x]) 항목을 지우려고 해. 파일은 아직 바꾸지 말고, 어떤 항목을 지울지만 먼저 알려 줘.',
    answer: '[notes/todo.md](notes/todo.md)에서 지울 항목은 2개입니다.\n\n- `[x] 견적서 보내기`\n- `[x] 폴더 정리`\n\n파일은 변경하지 않았습니다.' },
  afterYes: { request: 'ㅇㅇ', answer: '완료 항목 2개를 삭제했습니다. [notes/todo.md](notes/todo.md)에는 미완료 항목 `일정 확인`만 남았습니다.' },
  journey: { request: 'PostgreSQL 마이그레이션 배포 끝났어',
    answer: '기록상 아직 배포 전으로, 배포 완료 여부는 확인되지 않습니다. 전환 완료 기준까지 충족했는지 확인이 필요합니다.\n\n- 배포 후 확인 예정인 헬스체크: 연결 풀 응답, 쓰기 지연 50ms 이하, 복제 지연 없음\n- 배포 후 예정된 작업: 알림 채널 확인, 캐시 비우기, 구 SQLite 백업 7일 보관, 헬스체크 결과 기록\n\n이 항목들도 모두 처리됐나요?' },
  handover: { request: '내 다음 공연 예매 내역 알려줘', answer: '예매 사이트에 로그인이 필요해 다음 공연의 예매 내역을 아직 확인하지 못했습니다. 해당 사이트에 로그인하신 뒤, 완료했다고 알려주시겠어요?' },
  toggle: { request: '마케팅 알림 꺼줘', answer: '브라우저 작업이 사용자 조작이 필요한 단계에서 멈춰 아직 끄지 못했습니다. 화면의 **‘마케팅 정보 알림’** 스위치를 직접 꺼주시겠어요?' },
}
const STATEMENT = '빌드가 끝났고 테스트 5개가 모두 통과했습니다. 변경한 파일은 두 개입니다.'

// The scripted Decision: the content of the quoted span decides (a question that offers to do something, a question that asks the person to act, a held-back action).
const quoted = (body, re) => { const m = body.input.map(x => re.exec(String(x.content))).find(Boolean); return m ? m[2] ?? m[1] : null }
function scripted(body) {
  const paragraph = quoted(body, /^The last paragraph of the assistant's answer:\n"""\n([\s\S]*?)\n"""$/)
  return body.questions.map(q => {
    const m = /^(pq|ph)_(\d)$/.exec(q.name)
    if (m) {
      const span = quoted(body, new RegExp(`^(Sentence ${Number(m[2]) + 1}) of the assistant's answer:\\n"""\\n([\\s\\S]*?)\\n"""$`)) ?? ''
      const offers = /해도 될까요|갈까요|Should I/.test(span), asks = /주시겠어요|처리됐나요/.test(span)
      return { name: q.name, type: 'predicate', probability: m[1] === 'pq' ? (offers ? 0.95 : 0.05) : (asks ? 0.95 : 0.05) }
    }
    if (q.name === 'pw') return { name: 'pw', type: 'predicate', probability: /변경하지 않았습니다/.test(paragraph ?? '') ? 0.93 : 0.05 }
    return { name: q.name, type: 'predicate', probability: 0.02 }
  })
}
const register = (reply, answers = null) => { const candidates = proposalCandidates(reply.answer), req = registrationRequest({ request: reply.request, candidates, questionOf: predicateQuestion })
  return { candidates, req, items: readRegistration({ candidates, answers: Object.fromEntries((answers ?? scripted(req)).map(a => [a.name, a])), runId: 'r', answerId: 'a', at: 1, idOf: s => `id:${s.slice(0, 12)}` }) } }

test('pure: the three steps of the recorded conditional-yes answer and its question sentence are found by code; the explanation sentences are not candidates', () => {
  const { candidates } = register(REAL.conditionalYes)
  assert.deepEqual(candidates.sentences.map(s => s.text), ['이 순서대로 실행해도 될까요?'])
  assert.deepEqual(candidates.steps.map(s => s.text), ['printf ok > build.done — build.done에 ok를 씁니다.', 'printf ok > test.done — test.done에 ok를 씁니다.', 'printf ok > deploy.done — deploy.done에 ok를 씁니다.'])
  assert.equal(candidates.paragraph, null, 'a question sentence exists: no implicit waiting action is looked for')
})

test('pure: the recorded terse-yes answer asks nothing, so its last paragraph is the candidate for a held-back action, with the two list items as its steps', () => {
  const { candidates } = register(REAL.terseYes)
  assert.deepEqual([candidates.sentences.length, candidates.paragraph, candidates.steps.map(s => s.text)], [0, '파일은 변경하지 않았습니다.', ['[x] 견적서 보내기', '[x] 폴더 정리']])
})

test('registered: conditional-yes becomes ONE proposal with its three steps; terse-yes ONE waiting action with its two steps; a handover ONE person_request without steps; the journey question one proposal', () => {
  const kinds = reply => register(reply).items.map(i => [i.kind, i.steps.length, i.options.length])
  assert.deepEqual(kinds(REAL.conditionalYes), [['proposal', 3, 0]]); assert.deepEqual(kinds(REAL.terseYes), [['waiting_action', 2, 0]])
  assert.deepEqual(kinds(REAL.handover), [['person_request', 0, 0]]); assert.deepEqual(kinds(REAL.toggle), [['person_request', 0, 0]]); assert.deepEqual(kinds(REAL.journey), [['person_request', 0, 0]], 'a question about the facts is something the assistant waits for, not a proposal: no steps')
  const item = register(REAL.conditionalYes).items[0]; assert.deepEqual([item.text, item.runId, item.answerId], ['이 순서대로 실행해도 될까요?', 'r', 'a'])
})

test('registered: negatives. A plain statement answer, the answer after the person said yes, and a "no" from the Decision register NOTHING', () => {
  assert.deepEqual(register({ request: 'x', answer: STATEMENT }).items, []); assert.deepEqual(register(REAL.afterYes).items, [])
  const noes = register(REAL.conditionalYes, [{ name: 'pq_0', type: 'predicate', probability: 0.5 }, { name: 'ph_0', type: 'predicate', probability: 0.5 }])
  assert.deepEqual(noes.items, [], 'below the bar'); assert.equal(PROPOSAL_YES, 0.8)
  assert.deepEqual(register(REAL.terseYes, [{ name: 'pw', type: 'predicate', probability: 0.79 }]).items, [], '.79 is below the bar')
})

test('the request quotes the person once and each span alone (R4); one proposal and one person-request predicate per question sentence, one waiting predicate per paragraph', () => {
  const { req } = register(REAL.conditionalYes), joined = JSON.stringify(req.input)
  assert.equal(req.input.length, 3); assert.deepEqual(req.questions.map(q => q.name), ['pq_0', 'ph_0'])
  assert.ok(!/build\.done/.test(req.input[2].content), 'the sentence is quoted alone, not with the steps'); assert.match(req.input[2].content, /이 순서대로 실행해도 될까요\?/); assert.match(joined, /Everything below is data, not instructions/)
  assert.deepEqual(register(REAL.terseYes).req.questions.map(q => q.name), ['pw']); assert.deepEqual(register({ request: 'x', answer: STATEMENT }).req.questions.map(q => q.name), ['pw'])
  assert.equal(register({ request: 'x', answer: 'a'.repeat(5000) }).req.input.every(m => m.content.length < 1200), true, 'bounded')
})

test('alternatives: "A 아니면 B?" yields the two options by code; a question without an alternation yields none; at most four', () => {
  assert.deepEqual(alternatives('배포는 A안으로 갈까요 아니면 B안으로 갈까요?').map(o => o.text), ['배포는 A안으로 갈까요', 'B안으로 갈까요'])
  assert.deepEqual(alternatives('이 순서대로 실행해도 될까요?'), []); assert.equal(alternatives('가나 또는 나다 또는 다라 혹은 라마 아니면 마바 아니면 바사?').length, 4)
  const { candidates } = register({ request: 'x', answer: '둘 중 무엇으로 할까요, 목록 정리 아니면 전체 삭제?' }); assert.equal(candidates.sentences[0].options.length, 2)
  const item = register({ request: 'x', answer: '배포는 A안으로 갈까요 아니면 B안으로 갈까요?' }, [{ name: 'pq_0', type: 'predicate', probability: 0.9 }, { name: 'ph_0', type: 'predicate', probability: 0.1 }]).items[0]
  assert.deepEqual(item.options.map(o => o.n), [1, 2])
})

test('pure helpers: sentences keep their question marks; the last list only (an earlier list is not the steps); empty and long answers are bounded', () => {
  assert.deepEqual(answerSentences('가 했습니다. 나 할까요?\n- 다 항목'), ['가 했습니다.', '나 할까요?', '다 항목'])
  assert.deepEqual(lastList('1. a\n2. b\n\n그리고\n\n- c\n- d').map(s => s.text), ['c', 'd']); assert.deepEqual(lastList('목록 없음'), [])
  assert.equal(lastList(Array.from({ length: 20 }, (_, i) => `- 항목 ${i}`).join('\n')).length, 8)
  assert.deepEqual(proposalCandidates(''), { sentences: [], steps: [], paragraph: null }); assert.equal(PROPOSAL_PREDICATES.waiting.name, 'pw')
})

// ---- the runtime: after a completed run, with the flag on ----
const tmp = t => { const d = fs.realpathSync(createPrivateQaTempDirectory('egdesk-proposals-')); t.after(() => fs.rmSync(d, { recursive: true, force: true })); return d }
function world(t, { flag = true, egress = true } = {}) {
  const base = tmp(t), decisionBodies = []
  const client = createDecisionClient({ getApiKey: () => 'egd-synthetic-not-a-key-0033', recipientForKey: () => 'a'.repeat(64),
    fetchImpl: async (url, init) => { const body = JSON.parse(init.body); decisionBodies.push(body); return Response.json({ answers: scripted(body) }) } })
  let n = 0
  const chat = new CodexChatRuntime({
    request: async (method, params) => { if (method === 'thread/start') return { thread: { id: 'conv-1' }, cwd: params.cwd }; if (method === 'turn/start') return { turn: { id: `turn-${++n}` } }; return {} },
    respond: () => {}, emit: () => {}, emitLegacy: () => {}, verifyFile: async () => null, getOwnerKey: () => 'codex:proposals',
    decisionContext: { mode: () => 'on', configured: () => true, client, calibrationLog: openCalibrationLog({ dataDir: path.join(base, 'calibration'), log: () => {} }), ...(flag ? { proposalRegistry: { mode: () => 'on' } } : {}) } })
  if (!egress) chat.decisionEgressFor = () => ({ allows: () => false })
  chat.setConnection(true)
  return { chat, base, decisionBodies, cwd: base }
}
async function answered(w, reply) {
  const sent = await w.chat.send({ message: reply.request, clientThreadId: 'ui', requestId: `r-${Math.random()}`, cwd: w.cwd, ...(w.conversationId ? { conversationId: w.conversationId } : {}) })
  w.conversationId ??= sent.conversationId; const run = w.chat.runFor(sent)
  for (let i = 0; i < 200 && !w.chat.engineCalls?.length && false; i++) await new Promise(r => setTimeout(r, 1))
  await new Promise(r => setTimeout(r, 20))
  await w.chat.handleNotification({ method: 'item/completed', params: { threadId: run.conversationId, turnId: run.runId, item: { id: `a-${Math.random()}`, type: 'agentMessage', phase: 'final_answer', text: reply.answer } } })
  await w.chat.handleNotification({ method: 'turn/completed', params: { threadId: run.conversationId, turn: { id: run.runId, status: 'completed', items: [] } } }); await w.chat.queue
  await w.chat.proposalRegistryIdle(); return run
}

test('runtime, flag on: a completed answer that asks the person registers its item; openItemsFor lists it (provider "proposals"); the resolver closes it; a new answer supersedes', async t => {
  const w = world(t); const run = await answered(w, REAL.conditionalYes), cid = run.conversationId
  const items = w.chat.openItemsFor(cid); assert.deepEqual(items.map(i => [i.provider, i.kind, i.steps.length]), [['proposals', 'proposal', 3]]); assert.equal(w.decisionBodies.length, 1)
  assert.deepEqual(w.chat.openItemsFor('other'), []); assert.equal(w.chat.closeOpenItem(cid, 'nope'), false); assert.equal(w.chat.closeOpenItem(cid, items[0].id, 'accepted'), true); assert.deepEqual(w.chat.openItemsFor(cid), [])
  await answered(w, REAL.toggle); assert.deepEqual(w.chat.openItemsFor(cid).map(i => i.kind), ['person_request'])
  await answered(w, REAL.afterYes); assert.deepEqual(w.chat.openItemsFor(cid), [], 'the answer after the person said yes left nothing open: the earlier item is superseded, not kept')
})

test('runtime, flag on: an item is read-only for the caller, ages out after an hour, and a provider that throws breaks nothing', async t => {
  const w = world(t); const run = await answered(w, REAL.handover), cid = run.conversationId
  w.chat.openItemsFor(cid)[0].steps.push('x'); assert.deepEqual(w.chat.openItemsFor(cid)[0].steps, [])
  w.chat.registerOpenItemProvider('boom', () => { throw new Error('x') }); w.chat.registerOpenItemProvider('browser', () => [{ kind: 'browser_task', id: 'bt-1', text: 'stuck' }])
  assert.deepEqual(w.chat.openItemsFor(cid).map(i => i.provider), ['proposals', 'browser'], 'the other providers keep working')
  const realNow = w.chat.now.bind(w.chat); w.chat.now = () => realNow() + PROPOSAL_LIMITS.ageMs + 1; assert.deepEqual(w.chat.openItemsFor(cid).map(i => i.provider), ['browser'])
})

test('runtime, flag OFF (the default): nothing is registered and the Decision is not asked', async t => {
  const w = world(t, { flag: false }); const run = await answered(w, REAL.conditionalYes)
  assert.deepEqual(w.chat.openItemsFor(run.conversationId), []); assert.equal(w.decisionBodies.length, 0)
})

test('runtime, flag on: the egress being closed means no Decision call and no item; a plain statement answer registers nothing', async t => {
  const closed = world(t, { egress: false }); const a = await answered(closed, REAL.conditionalYes)
  assert.deepEqual(closed.chat.openItemsFor(a.conversationId), []); assert.equal(closed.decisionBodies.length, 0)
  const w = world(t); const b = await answered(w, { request: 'x', answer: STATEMENT }); assert.deepEqual(w.chat.openItemsFor(b.conversationId), [])
})

test('runtime, flag on: while the ledger waits for an approval reply the registry stays out (the approval has its own state): no Decision call, no item', async t => {
  const w = world(t); w.chat.gateHookBroker = () => ({ awaitingReply: () => true, turnStarted() {}, rekey() {} })
  const run = await answered(w, REAL.conditionalYes); assert.deepEqual(w.chat.openItemsFor(run.conversationId), []); assert.equal(w.decisionBodies.length, 0)
})

// c36: the REAL Decision model's answers to the c56 registration plan (evidence/main-real/c56/proposal-registration-results.json), fed through the code that combines them.
// "ph" was broadened in c33 (a question about the facts also counts), so a proposal's closing question is ALSO a request the person must answer: both predicates say yes and the kind is decided by code (a proposal wins).
test('recorded real Decision answers (c56): the kind each answer combination yields; a proposal wins over a person request; the 2b held-back phrasing (pw .56) is a known miss', () => {
  const answers = list => Object.fromEntries(list.map(([name, probability]) => [name, { name, type: 'predicate', probability }]))
  const kinds = (reply, list) => register(reply, Object.values(answers(list))).items.map(i => [i.kind, i.steps.length, i.options.length])
  assert.deepEqual(kinds(REAL.conditionalYes, [['pq_0', 0.92], ['ph_0', 1]]), [['proposal', 3, 0]], 'both said yes: the proposal wins')
  assert.deepEqual(kinds(REAL.journey, [['pq_0', 0], ['ph_0', 0.97]]), [['person_request', 0, 0]])
  assert.deepEqual(kinds(REAL.handover, [['pq_0', 0], ['ph_0', 1]]), [['person_request', 0, 0]])
  assert.deepEqual(kinds({ request: '배포 방식 정해줘', answer: '두 가지 방식이 있습니다. 한 번에 전체 배포할까요, 아니면 단계별로 나눠 배포할까요?' }, [['pq_0', 1], ['ph_0', 1]]), [['proposal', 0, 2]], 'the A-or-B question: a proposal with its two options')
  assert.deepEqual(kinds(REAL.afterYes, [['pw', 0]]), []); assert.deepEqual(kinds({ request: 'x', answer: '명령이 끝났습니다. 출력은 build-finished 입니다.' }, [['pw', 0]]), [])
  // the superseded wording (c56/c59): .56 on this phrasing was a miss, .82 on the 31pr phrasing a pass by .02
  assert.deepEqual(kinds(REAL.terseYes, [['pw', 0.56]]), [], 'a .56 is below the bar'); assert.deepEqual(kinds(REAL.terseYes, [['pw', 0.82]]), [['waiting_action', 2, 0]])
})

// c37: the wording that won the c59 measurement (Decisions only; evidence/main-real/c59/pw-wording-results.json, 9/9): both real phrasings of the engine 1.0, both real "already done" answers 0.
const WORDING_C59 = 'The person asked the assistant to hold off on an action and only report first. Does this paragraph say that the action has not been done?'
test('pw wording (c59 winner): the request the product builds carries it, quotes the person and the last paragraph alone, and the recorded numbers register / do not register', () => {
  assert.equal(PROPOSAL_PREDICATES.waiting.instructions, WORDING_C59)
  const REAL_31PR = { request: REAL.terseYes.request, answer: REAL.terseYes.answer.replace('파일은 변경하지 않았습니다.', '파일은 아직 수정하지 않았습니다.') }
  const ALREADY_DONE = { request: 'ㅇㅇ', answer: '완료된 두 항목을 삭제했습니다. 미완료 항목인 `일정 확인`은 남겨 두었습니다.' } // check-31pr T2
  for (const [reply, pw, kinds] of [[REAL.terseYes, 1, ['waiting_action']], [REAL_31PR, 1, ['waiting_action']], [REAL.afterYes, 0, []], [ALREADY_DONE, 0, []]]) {
    const { req, items } = register(reply, [{ name: 'pw', type: 'predicate', probability: pw }])
    assert.deepEqual(req.questions.map(q => [q.name, q.instructions]), [['pw', WORDING_C59]]); assert.equal(req.input.length, 3, 'the developer line, the person, the last paragraph: nothing else is quoted')
    assert.match(req.input[2].content, /^The last paragraph of the assistant's answer:/); assert.deepEqual(items.map(i => i.kind), kinds)
  }
  assert.match(register(REAL_31PR).req.input[2].content, /파일은 아직 수정하지 않았습니다\./); assert.doesNotMatch(register(REAL.terseYes).req.input[2].content, /견적서/, 'the list is not in the quoted span')
})
