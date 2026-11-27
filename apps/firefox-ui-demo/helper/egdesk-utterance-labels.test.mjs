import test from 'node:test'
import assert from 'node:assert/strict'
import os from 'node:os'
import path from 'node:path'
import { chmod, mkdtemp, readFile } from 'node:fs/promises'
import { ImmutableContextStore } from './egdesk-context-store.mjs'
import { MemoryEvidenceStore } from './egdesk-memory-evidence.mjs'
import { CodexChatRuntime } from './codex-chat-runtime.mjs'
import { openChatStore } from './egdesk-chat-store.mjs'
import { collectDecisionCandidates } from './egdesk-decision-candidates.mjs'
import { createTurnMemoryConfig } from './egdesk-turn-memory-wiring.mjs'
import { createWikiAdapter, openWikiWrites } from './egdesk-wiki-adapter.mjs'
import { createFakeClock, mockJudge, until } from './egdesk-wiki-reconstruction.fixture.mjs'

// Labels of an utterance: today three questions per sentence ride EVERY message of a consenting DM, on the turn path. With the internal
// speech design 'at-page' nothing rides the turn; the write judgment that runs after the answer labels each sentence once (isolated), and only
// for a turn worth recording. What it installs is stored with the utterance and reused whenever the utterance is recalled.
// Real: the runtime, the chat store, the consent store (MemoryEvidenceStore), the wiki adapter and its write store, the memory loop.
// Synthetic: the native engine and the Decisions client (scripted context answers, the lexical stand-in for memory). Public synthetic text.
const OWNER = 'codex:synthetic:qa', AGENT = 'sol', DM = 'dm-1'
const profiles = { runProfile: (p, r) => ({ binding: { profileId: p, revision: r ?? 1, hash: 'h' }, developerInstructions: 'x', toolCeiling: null, model: null }) }
const quiet = () => {}
const REPORT = '거래처 D사가 어제 단가를 올렸다고 들었어.', THANKS = '고마워', RECALL = 'D사 단가 얘기 다시 정리해줘'

async function world({ speechDesign, memoryMode = 'on' } = {}) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'egdesk-utt-labels-')); await chmod(dir, 0o700)
  const w = { dir, now: 1_800_000_000_000, requests: [], starts: [], turns: 0, threads: 0, memoryMode, clock: createFakeClock() }
  const captures = new ImmutableContextStore({ dataDir: path.join(dir, 'state'), allowedRoots: [dir], now: () => w.now })
  w.evidence = new MemoryEvidenceStore({ dataDir: path.join(dir, 'state'), captures, now: () => w.now })
  w.store = openChatStore({ dataDir: path.join(dir, 'chat'), ownerScope: 'synthetic-utt' })
  const judge = mockJudge()
  let adapter = null
  const settings = { turnMemory: { get mode() { return w.memoryMode } } }
  const config = createTurnMemoryConfig({ settings, getAdapter: () => adapter ??= createWikiAdapter({ writes: openWikiWrites({ dataDir: path.join(dir, 'settings'), log: quiet }) }) })
  const chat = new CodexChatRuntime({ now: () => (w.now += 1000), store: w.store, requireStore: true, getOwnerKey: () => OWNER, profiles, resolveProjectWorkspace: async () => null,
    request: async (method, p) => {
      if (method === 'thread/start') return { thread: { id: `t${++w.threads}` }, cwd: '/work', model: 'syn' }
      if (method === 'thread/resume') return { thread: { id: p.threadId, turns: [] }, cwd: '/work' }
      if (method === 'config/read') return { config: { developer_instructions: null } }
      if (method === 'thread/unsubscribe') return { status: 'unsubscribed' }
      w.starts.push(p)
      const id = `turn-${++w.turns}`, timing = { threadId: p.threadId, turnId: id }
      const finish = async () => { const n = (m, q) => chat.handleNotification({ method: m, params: q })
        await n('item/started', { ...timing, item: { id: `a${id}`, type: 'agentMessage', phase: 'final_answer', text: '' } })
        await n('item/completed', { ...timing, item: { id: `a${id}`, type: 'agentMessage', phase: 'final_answer', text: '네, 알겠어요.' } })
        await n('turn/completed', { threadId: p.threadId, turn: { id, status: 'completed', items: [] } }) }
      setImmediate(() => setImmediate(finish))
      return { turn: { id, status: 'inProgress', items: [] } } },
    respond: () => {}, emit: () => {}, emitLegacy: () => {}, verifyFile: async () => null,
    decisionContext: { mode: () => 'on', settingsGeneration: () => 0, configured: () => true, budgetMs: 5000, memoryEvidence: w.evidence, ...(speechDesign === undefined ? {} : { speechDesign }),
      client: { model: 'syn', async decide(req) {
        const names = req.questions.map(q => q.name), text = JSON.stringify({ input: req.input, questions: req.questions })
        const stage = names.includes('answer_type') ? 'context' : names.some(n => n.startsWith('tw_')) ? 'write' : names.some(n => n.startsWith('tn_')) ? 'triage' : 'fetch'
        w.requests.push({ turn: w.asked, stage, names, speech: names.filter(n => n.startsWith('speech_')).length, bytes: Buffer.byteLength(text), text })
        if (stage !== 'context') return judge.decide(req)
        // The context selection: nothing is judged relevant, and the offset label questions come back flat (as in both real runs).
        const answers = {}
        for (const q of req.questions) answers[q.name] = q.type !== 'choice' ? { type: 'predicate', probability: 0.02 }
          : q.name.startsWith('speech_') ? { type: 'choice', choice: q.choices[0].value, confidence: 0.3, probabilities: q.choices.map((c, i) => ({ value: c.value, probability: i === 0 ? 0.3 : 0.7 / (q.choices.length - 1) })) }
          : { type: 'choice', choice: q.name === 'time_intent' ? 'present' : 'answer', confidence: 0.95, probabilities: [{ value: q.name === 'time_intent' ? 'present' : 'answer', probability: 0.95 }] }
        return { answers, model: 'syn', usage: { inputTokens: 1 }, latencyMs: 1 }
      } },
      collect: async ({ body, context, memoryEvidenceFor, speech }) => (await collectDecisionCandidates({ body, clientThreadId: context.clientThreadId, excludeMessageId: context.localMessageId, chatStore: w.store, memoryEvidenceFor, speech })).candidates,
      turnMemory: { mode: config.mode, wiki: config.wiki, scope: config.scope, writer: config.writer, get ontologyWrite() { return config.ontologyWrite }, budget: config.budget, clock: w.clock } } })
  chat.setConnection(true); w.chat = chat
  w.scope = () => ({ ownerKey: OWNER, agentId: AGENT, clientThreadId: DM })
  const completed = () => w.store.listMessages(DM).messages.filter(m => m.role === 'assistant' && m.status === 'complete').length
  w.ask = async message => {
    w.asked = (w.asked ?? 0) + 1
    const r = await chat.send({ message, clientThreadId: DM, requestId: `r${w.asked}`, ...(w.cid ? { conversationId: w.cid } : {}), profileId: AGENT, replyDestination: 'direct' }); w.cid ||= r.conversationId
    await until(() => completed() >= w.asked, `answer ${w.asked} completed`); await w.clock.settle(); await chat.turnMemoryIdle(); await w.clock.settle()
  }
  w.of = turn => w.requests.filter(r => r.turn === turn)
  w.records = () => w.evidence.recentSpeech(w.scope(), w.evidence.speechGrant(w.scope())) ?? []
  w.userRecords = () => w.records().filter(r => r.role === 'user')
  w.writes = async () => { try { return JSON.parse(await readFile(path.join(dir, 'settings', 'egdesk-wiki-writes.json'), 'utf8')) } catch { return { pages: [], readings: [] } } }
  w.close = () => { w.store.close(); w.evidence.close() }
  return w
}
// One conversation: a greeting before consent, then (consent on) a report worth recording, a thank-you, and a request to go over it again.
async function conversation(w) {
  await w.ask('안녕')
  assert.ok(w.evidence.enableSpeech(w.scope()))
  await w.ask(REPORT); await w.ask(THANKS); await w.ask(RECALL)
}
const speechQuestions = (w, stage) => w.requests.filter(r => r.stage === stage).reduce((n, r) => n + r.speech, 0)

test('at-page: no label question rides any turn; the recorded utterance is labelled once, after the answer, and those labels are what recall shows', async () => {
  const w = await world({ speechDesign: 'at-page' })
  await conversation(w)
  // turn path: the context request of every consenting turn still asks the recall question, and no label question at all
  const context = w.requests.filter(r => r.stage === 'context' && r.turn >= 2)
  assert.equal(context.length, 3); assert.ok(context.every(r => r.names.includes('rel_recall') && r.speech === 0))
  assert.equal(speechQuestions(w, 'context') + speechQuestions(w, 'triage') + speechQuestions(w, 'fetch'), 0)
  // after the answer: one write judgment in the whole conversation (the report), three isolated questions for its one sentence
  const writes = w.requests.filter(r => r.stage === 'write')
  assert.deepEqual(writes.map(r => [r.turn, r.speech]), [[2, 3]])
  assert.ok(writes[0].text.includes('Judge only this one sentence, quoted exactly as a JSON string'))
  // stored: installed labels only, with offsets, on the utterance's own (immutable) speech record; the unrecorded turns have none
  const users = w.userRecords()
  assert.equal(users.length, 3)
  assert.deepEqual(users[0].interpretations, [{ start: 0, end: REPORT.length, source: 'attributed_report', form: 'assertion', time: 'past_anchored' }])
  assert.deepEqual([users[1].interpretations, users[2].interpretations], [[], []])
  assert.doesNotMatch(JSON.stringify(users), /0\.\d|confidence|probab/, 'no score is stored')
  // the page that was created keeps a reference to the utterance (no second copy of the words) and the attributes those labels give
  const saved = await w.writes()
  assert.equal(saved.pages.length, 1)
  assert.deepEqual([saved.pages[0].time.slice, saved.pages[0].provenance.kind, saved.pages[0].provenance.basis, saved.pages[0].status, /^chat-message:/.test(saved.pages[0].ref), saved.pages[0].body], ['past', 'reported_by_other', 'attributed_report', 'done', true, undefined])
  assert.ok(!JSON.stringify(saved).includes('단가를 올렸다'))
  // recall, a later turn: the utterance is offered to the judge with those attributes, and nobody is asked to label it again
  const recall = w.of(4), scan = recall.find(r => r.stage === 'fetch')
  assert.ok(scan, 'the recall turn fetched')
  const lines = scan.text.split('\\n').filter(l => /time=past/.test(l) && /provenance=reported_by_other/.test(l) && l.includes('거래처 D사'))
  assert.equal(lines.length, 1, 'ONE page for the utterance (the written page stands for it), with the stored attributes')
  assert.match(lines[0], / rev=1 /)
  assert.equal(recall.reduce((n, r) => n + r.speech, 0), 0)
  w.close()
})

test('today (flag absent): three label questions per sentence ride every consenting message; at-page asks 3 where today asks 12', async () => {
  const today = await world()
  await conversation(today)
  const context = today.requests.filter(r => r.stage === 'context' && r.turn >= 2)
  assert.deepEqual(context.map(r => r.speech), [3, 3, 3], 'report, thank-you and recall request each carry the offset label questions')
  assert.deepEqual(today.requests.filter(r => r.stage === 'write').map(r => [r.turn, r.speech]), [[2, 3]], 'and the recorded turn is labelled a second time by its write judgment')
  const atPage = await world({ speechDesign: 'at-page' })
  await conversation(atPage)
  const total = w => w.requests.reduce((n, r) => n + r.speech, 0)
  assert.deepEqual([total(today), total(atPage)], [12, 3])
  // the labels the person's record ends up with: today the turn-path answers (flat in both real runs: nothing installed), at-page the isolated ones
  assert.deepEqual(today.userRecords()[0].interpretations, [])
  assert.equal(atPage.userRecords()[0].interpretations.length, 1)
  for (const w of [today, atPage]) w.close()
})

test('at-page is honoured only where a write judgment can label: with turn memory off or advisory it is the current design, request for request', async () => {
  const strip = w => w.requests.filter(r => r.stage === 'context').map(r => r.text.replace(/\d{4}-\d{2}-\d{2}T[\d:.]+Z/g, 'T'))
  const sent = w => w.starts.map(p => JSON.stringify(p).replace(/"(?:clientId|requestId|localMessageId|localRunId|clientUserMessageId)":"[^"]*"/g, '"id":"x"').replace(/\d{4}-\d{2}-\d{2}T[\d:.]+Z/g, 'T'))
  for (const memoryMode of ['off', 'advisory']) {
    const base = await world({ memoryMode }), flagged = await world({ memoryMode, speechDesign: 'at-page' })
    await conversation(base); await conversation(flagged)
    assert.deepEqual(strip(flagged), strip(base), `${memoryMode}: the same context requests`)
    assert.deepEqual(sent(flagged), sent(base), `${memoryMode}: the same turn/start`)
    assert.deepEqual(flagged.userRecords().map(r => r.interpretations), base.userRecords().map(r => r.interpretations))
    assert.equal(flagged.userRecords().length, 3, 'every utterance is still recorded, at once')
    for (const w of [base, flagged]) w.close()
  }
})
