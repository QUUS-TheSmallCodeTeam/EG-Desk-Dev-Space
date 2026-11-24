import test from 'node:test'
import assert from 'node:assert/strict'
import os from 'node:os'
import path from 'node:path'
import { chmod, mkdtemp, readFile } from 'node:fs/promises'
import { ImmutableContextStore } from './egdesk-context-store.mjs'
import { MemoryEvidenceStore } from './egdesk-memory-evidence.mjs'
import { CodexChatRuntime, TURN_MEMORY_KEY } from './codex-chat-runtime.mjs'
import { openChatStore } from './egdesk-chat-store.mjs'
import { collectDecisionCandidates } from './egdesk-decision-candidates.mjs'
import { createTurnMemoryConfig } from './egdesk-turn-memory-wiring.mjs'
import { createWikiAdapter, openWikiWrites } from './egdesk-wiki-adapter.mjs'
import { createFakeClock, mockJudge, until } from './egdesk-wiki-reconstruction.fixture.mjs'

// A pending reading becomes the record's status through the conversation: the answering model says what was noted, the person's next
// message is read as confirm / object / neither. No form, no button, no question the person must answer.
// Real: the runtime, the chat store, the consent store, the wiki adapter and its write store (through createTurnMemoryConfig), the loop,
// the write path. Synthetic: the native engine (it "follows" the note by saying the sentence, or ignores it when told to) and the
// Decisions client (lexical stand-in). Public synthetic text only.
const OWNER = 'codex:synthetic:qa', AGENT = 'sol', DM = 'dm-1'
const profiles = { runProfile: (p, r) => ({ binding: { profileId: p, revision: r ?? 1, hash: 'h' }, developerInstructions: 'x', toolCeiling: null, model: null }) }
const quiet = () => {}
const GRAPH = { snapshots: [], edges: [], nodes: [{ id: 'plan', label: 'PostgreSQL 마이그레이션 배포 계획', body: '12월 첫째 주에 전환 배포할 예정이다. 아직 배포 전이다.', timeSlice: 'future' }] }
const DONE = 'PostgreSQL 마이그레이션 배포 끝났어', NEXT = '그럼 헬스체크는 뭐부터 보면 돼?'
const NOTE_HEAD = '[noted in this conversation, not confirmed]'

async function world({ confirm = true, consent = true, modelStatesNote = true, writeTarget = 'choice' } = {}) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'egdesk-confirm-')); await chmod(dir, 0o700)
  const w = { dir, now: 1_800_000_000_000, requests: [], starts: [], events: [], turns: 0, threads: 0, clock: createFakeClock(), modelStatesNote }
  const captures = new ImmutableContextStore({ dataDir: path.join(dir, 'state'), allowedRoots: [dir], now: () => w.now })
  w.evidence = new MemoryEvidenceStore({ dataDir: path.join(dir, 'state'), captures, now: () => w.now })
  w.store = openChatStore({ dataDir: path.join(dir, 'chat'), ownerScope: 'synthetic-confirm' })
  const judge = mockJudge()
  let adapter = null
  const config = createTurnMemoryConfig({ settings: { turnMemory: { mode: 'on' } }, ontologyStore: { readGraph: async () => GRAPH }, confirmInConversation: confirm, writeTarget,
    getAdapter: () => adapter ??= createWikiAdapter({ writes: openWikiWrites({ dataDir: path.join(dir, 'settings'), log: quiet }) }) })
  const chat = new CodexChatRuntime({ now: () => (w.now += 1000), store: w.store, requireStore: true, getOwnerKey: () => OWNER, profiles, resolveProjectWorkspace: async () => null,
    request: async (method, p) => {
      if (method === 'thread/start') return { thread: { id: `t${++w.threads}` }, cwd: '/work', model: 'syn' }
      if (method === 'thread/resume') return { thread: { id: p.threadId, turns: [] }, cwd: '/work' }
      if (method === 'config/read') return { config: { developer_instructions: null } }
      if (method === 'thread/unsubscribe') return { status: 'unsubscribed' }
      w.starts.push(p)
      const id = `turn-${++w.turns}`, timing = { threadId: p.threadId, turnId: id }
      // The stand-in for the answering model: when it was given the note, it says what was noted (unless this world's model ignores it).
      const noted = Object.values(p.additionalContext ?? {}).some(entry => typeof entry.value === 'string' && entry.value.includes(NOTE_HEAD))
      const text = noted && w.modelStatesNote ? '네. PostgreSQL 마이그레이션 배포 계획은 완료로 적어 둘게요. 헬스체크는 응답 시간부터 보세요.' : '네, 알겠어요. 헬스체크는 응답 시간부터 보세요.'
      const finish = async () => { const n = (m, q) => chat.handleNotification({ method: m, params: q })
        await n('item/started', { ...timing, item: { id: `a${id}`, type: 'agentMessage', phase: 'final_answer', text: '' } })
        await n('item/completed', { ...timing, item: { id: `a${id}`, type: 'agentMessage', phase: 'final_answer', text } })
        await n('turn/completed', { threadId: p.threadId, turn: { id, status: 'completed', items: [] } }) }
      setImmediate(() => setImmediate(finish))
      return { turn: { id, status: 'inProgress', items: [] } } },
    respond: () => {}, emit: e => w.events.push(e), emitLegacy: () => {}, verifyFile: async () => null,
    decisionContext: { mode: () => 'on', settingsGeneration: () => 0, configured: () => true, budgetMs: 5000, memoryEvidence: w.evidence,
      client: { model: 'syn', async decide(req) {
        const names = req.questions.map(q => q.name)
        const stage = names.includes('answer_type') ? 'context' : names.some(n => n.startsWith('rc_')) ? 'confirm' : names.some(n => n.startsWith('tw_')) ? 'write' : names.some(n => n.startsWith('tn_')) ? 'triage' : 'fetch'
        w.requests.push({ turn: w.asked, stage, names, text: JSON.stringify(req.input) })
        if (stage !== 'context') return judge.decide(req)
        const answers = {}
        for (const q of req.questions) answers[q.name] = q.type !== 'choice' ? { type: 'predicate', probability: 0.02 }
          : q.name.startsWith('speech_') ? { type: 'choice', choice: q.choices[0].value, confidence: 0.3, probabilities: q.choices.map((c, i) => ({ value: c.value, probability: i === 0 ? 0.3 : 0.7 / (q.choices.length - 1) })) }
          : { type: 'choice', choice: q.name === 'time_intent' ? 'present' : 'answer', confidence: 0.95, probabilities: [{ value: q.name === 'time_intent' ? 'present' : 'answer', probability: 0.95 }] }
        return { answers, model: 'syn', usage: { inputTokens: 1 }, latencyMs: 1 }
      } },
      collect: async ({ body, context, memoryEvidenceFor, speech }) => (await collectDecisionCandidates({ body, clientThreadId: context.clientThreadId, excludeMessageId: context.localMessageId, chatStore: w.store, memoryEvidenceFor, speech })).candidates,
      turnMemory: { ...config, get ontologyWrite() { return config.ontologyWrite }, clock: w.clock } } })
  chat.setConnection(true); w.chat = chat
  w.scope = () => ({ ownerKey: OWNER, agentId: AGENT, clientThreadId: DM })
  const completed = () => w.store.listMessages(DM).messages.filter(m => m.role === 'assistant' && m.status === 'complete').length
  w.ask = async message => {
    w.asked = (w.asked ?? 0) + 1
    const r = await chat.send({ message, clientThreadId: DM, requestId: `r${w.asked}`, ...(w.cid ? { conversationId: w.cid } : {}), profileId: AGENT, replyDestination: 'direct' }); w.cid ||= r.conversationId
    await until(() => completed() >= w.asked, `answer ${w.asked} completed`); await w.clock.settle(); await chat.turnMemoryIdle(); await w.clock.settle()
    return [...chat.runs.values()].at(-1)
  }
  w.memory = i => w.starts[i]?.additionalContext?.[TURN_MEMORY_KEY]?.value ?? ''
  w.readings = async () => { try { return JSON.parse(await readFile(path.join(dir, 'settings', 'egdesk-wiki-writes.json'), 'utf8')).readings.map(r => [r.pageId, r.reading.status, r.reading.state]) } catch { return [] } }
  w.page = async () => { const wiki = await config.wiki({ body: { message: 'x' }, context: { clientThreadId: DM }, sources: {} }); return wiki.pages.get('ontology:plan') }
  w.confirmOf = run => chat.turnMemoryTurns.get(run)?.confirm ?? null
  w.rows = run => run.activities.filter(a => a.detail?.confirmation).map(a => [a.title, a.detail.confirmation, a.detail.status])
  w.close = () => { w.store.close(); w.evidence.close() }
  // a first question that brings the plan page into the conversation (before consent), the report that gets noted, and a follow-up whose
  // reply states the note
  w.open = async () => {
    await w.ask('PostgreSQL 마이그레이션 배포 계획 알려줘')
    if (consent) assert.ok(w.evidence.enableSpeech(w.scope()))
    await w.ask(DONE)
    assert.deepEqual(await w.readings(), [['ontology:plan', 'done', 'pending']])
    await w.ask(NEXT)
  }
  return w
}

test('the person confirms: the note is stated once by the reply, "응, 맞아" promotes it with the person as the authority, and a row says so', async () => {
  const w = await world()
  await w.open()
  // turn 3 carried the note to the answering model (a statement to make), and its reply said it
  assert.ok(w.memory(2).includes(NOTE_HEAD) && w.memory(2).includes('"PostgreSQL 마이그레이션 배포 계획": the person reported it as done'))
  assert.ok(!w.memory(1).includes(NOTE_HEAD), 'not on the turn that reported it: nothing was noted yet')
  assert.equal(w.requests.filter(r => r.stage === 'confirm').length, 0, 'nothing is judged before a reply has stated the note')
  assert.equal((await w.page()).status, 'unknown', 'still only reported')
  const run = await w.ask('응, 맞아.')
  const confirm = w.requests.filter(r => r.stage === 'confirm')
  assert.deepEqual(confirm.map(r => [r.turn, r.names]), [[4, ['rc_stated_0', 'rc_reply_0']]])
  assert.ok(confirm[0].text.includes('완료로 적어 둘게요') && confirm[0].text.includes('응, 맞아.'), 'the judge reads the previous reply and the new message')
  assert.deepEqual(w.confirmOf(run).actions.map(a => [a.action, a.reason, a.reply]), [['promoted', 'confirmed', 'confirm']])
  assert.deepEqual(await w.readings(), [['ontology:plan', 'done', 'pending'], ['ontology:plan', 'done', 'accepted']])
  const page = await w.page()
  assert.deepEqual([page.status, page.statusReadings.map(r => [r.status, r.state])], ['done', [['done', 'accepted']]])
  assert.deepEqual(w.rows(run), [['기록 확정 1건', 'promoted', 'done']])
  assert.ok(!w.memory(3).includes(NOTE_HEAD), 'a confirmed note is not mentioned again')
  // and it is over: later turns neither judge nor mention it
  await w.ask('고마워')
  assert.equal(w.requests.filter(r => r.stage === 'confirm').length, 1); assert.equal(w.chat.turnMemoryNoted.get(w.cid).length, 0)
  w.close()
})

test('the person objects: the pending reading is withdrawn, the status is untouched, and it is not raised again', async () => {
  const w = await world()
  await w.open()
  const run = await w.ask('아니, 아직 스테이징만 끝났어.')
  assert.deepEqual(w.confirmOf(run).actions.map(a => [a.action, a.reason, a.reply]), [['withdrawn', 'objected', 'object']])
  const stored = await w.readings()
  assert.deepEqual(stored, [['ontology:plan', 'done', 'pending'], ['ontology:plan', 'done', 'rejected']])
  const page = await w.page()
  assert.equal(page.status, 'unknown'); assert.ok(!page.statusReadings.some(r => r.state === 'pending' && r.status === 'done'), 'no pending "done" is left on the page')
  assert.deepEqual(w.rows(run), [['기록 취소 1건', 'withdrawn', 'done']])
  assert.ok(!w.memory(3).includes(NOTE_HEAD))
  w.close()
})

test('the person says nothing about it: it stays pending (not objecting is not agreeing), is mentioned once more, then simply stays pending', async () => {
  const w = await world()
  await w.open()
  const run4 = await w.ask('그럼 롤백 조건은 뭐였지?')
  assert.deepEqual(w.confirmOf(run4).actions.map(a => [a.action, a.reason]), [['kept', 'no_response']])
  assert.equal(w.confirmOf(run4).silent, 1, 'counted for the owner: this is where a "no objection counts" rule would have promoted')
  assert.deepEqual(await w.readings(), [['ontology:plan', 'done', 'pending']]); assert.deepEqual(w.rows(run4), [])
  assert.ok(w.memory(3).includes(NOTE_HEAD), 'mentioned a second time')
  const run5 = await w.ask('알림 채널은 어디야?')
  assert.deepEqual(w.confirmOf(run5).actions.map(a => [a.action, a.reason]), [['kept', 'no_response']])
  assert.ok(!w.memory(4).includes(NOTE_HEAD), 'not a third time')
  await w.ask('응, 맞아.')
  assert.equal(w.requests.filter(r => r.stage === 'confirm').length, 2, 'and nothing is judged once it is no longer being mentioned')
  assert.deepEqual(await w.readings(), [['ontology:plan', 'done', 'pending']])
  assert.equal((await w.page()).status, 'unknown')
  w.close()
})

test('"응" to a reply that never stated the note confirms nothing; without the speech consent the previous reply is not sent and nothing is judged', async () => {
  const silentModel = await world({ modelStatesNote: false })
  await silentModel.open()
  const run = await silentModel.ask('응, 맞아.')
  assert.deepEqual(silentModel.confirmOf(run).actions.map(a => [a.action, a.reason]), [['kept', 'confirmed_but_not_stated']])
  assert.deepEqual(await silentModel.readings(), [['ontology:plan', 'done', 'pending']])
  silentModel.close()
  const noConsent = await world({ consent: false })
  await noConsent.open()
  assert.ok(noConsent.memory(2).includes(NOTE_HEAD), 'the note itself needs no consent: it is the page the DM may already read')
  const run2 = await noConsent.ask('응, 맞아.')
  assert.equal(noConsent.requests.filter(r => r.stage === 'confirm').length, 0)
  assert.deepEqual([noConsent.confirmOf(run2).judged, noConsent.confirmOf(run2).reason], [0, 'no_previous_answer'])
  assert.deepEqual(await noConsent.readings(), [['ontology:plan', 'done', 'pending']])
  noConsent.close()
})

test('flag off (default): no note, no confirmation request, the same turn/start as before; the reading just stays pending', async () => {
  const sent = w => w.starts.map(p => JSON.stringify(p).replace(/"(?:clientId|requestId|localMessageId|localRunId|clientUserMessageId)":"[^"]*"/g, '"id":"x"').replace(/\d{4}-\d{2}-\d{2}T[\d:.]+Z/g, 'T'))
  const off = await world({ confirm: false }), on = await world()
  await off.open(); await on.open()
  await off.ask('응, 맞아.')
  assert.ok(!off.starts.some(p => JSON.stringify(p).includes(NOTE_HEAD))); assert.equal(off.requests.filter(r => r.stage === 'confirm').length, 0)
  assert.deepEqual(await off.readings(), [['ontology:plan', 'done', 'pending']]); assert.equal(off.chat.turnMemoryNoted.size, 0)
  // up to the turn that first carries the note the two worlds sent exactly the same thing
  assert.deepEqual(sent(on).slice(0, 2), sent(off).slice(0, 2))
  assert.notEqual(sent(on)[2], sent(off)[2])
  for (const w of [off, on]) w.close()
})

test('with the "about" write target the same flow holds; a new native thread ends the session: old notes are not raised in it', async () => {
  const w = await world({ writeTarget: 'about' })
  await w.open()
  assert.ok(w.requests.some(r => r.stage === 'write' && r.names.includes('tw_about_0')) && !w.requests.some(r => r.names.includes('tw_target')))
  w.chat.markContextCompacted(w.cid) // the engine compacted: the next turn is a first turn again
  const run = await w.ask('응, 맞아.')
  assert.equal(w.requests.filter(r => r.stage === 'confirm').length, 0); assert.equal(w.confirmOf(run), null)
  assert.deepEqual(await w.readings(), [['ontology:plan', 'done', 'pending']]); assert.equal(w.chat.turnMemoryNoted.has(w.cid), false)
  w.close()
})
