// L3 c27: expect.flow of the real-engine check (helper/egdesk-real-engine-flow.mjs): the heartbeat's own messages in a turn's window. Structure, the judgment on its own, the hook on a fake store, and
// the two c27 scripts (real-engine-unsolicited-note-v1, real-engine-approval-words-v1) run against the FAKE app-server (no Codex binary, no command, no network): a pass says the mechanics work, the real
// model's behaviour is Main's run.
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { FLOW_EXPECT_SCHEMA, FLOW_PREFIX, FLOW_WRITER_SLACK_MS, createFlowHook, judgeFlow, statedSeconds, validateFlowExpect } from './egdesk-real-engine-flow.mjs'
import { REAL_ENGINE_SCRIPT_SCHEMA, validateEngineScript } from './egdesk-real-engine-script.mjs'

const here = path.dirname(fileURLToPath(import.meta.url)), scripts = path.join(here, '..', 'scripts', 'real-engine', 'scripts')
const load = name => JSON.parse(fs.readFileSync(path.join(scripts, `${name}.json`), 'utf8'))

test('the schema is in the committed schema file; the validator accepts the right shapes and refuses the rest', () => {
  const committed = JSON.parse(fs.readFileSync(path.join(here, '..', 'scripts', 'real-engine', 'real-engine-script.schema.json'), 'utf8'))
  assert.deepEqual(committed, JSON.parse(JSON.stringify(REAL_ENGINE_SCRIPT_SCHEMA)))
  assert.deepEqual(committed.properties.conversations.items.properties.turns.items.properties.expect.properties.flow, JSON.parse(JSON.stringify(FLOW_EXPECT_SCHEMA)))
  const conv = { flags: { EGDESK_CONVERSATION_FLOW: 'on' } }
  const ok = (e, o = { conv }) => assert.deepEqual(validateFlowExpect(e, o), [], JSON.stringify(e))
  const bad = (e, pattern, o = { conv }) => assert.match(validateFlowExpect(e, o).join('\n'), pattern, JSON.stringify(e))
  ok({ notes: { equals: 1 }, firstNoteMs: { min: 10000, max: 40000 }, statedSecondsTrue: true, noResult: ['done-42'] }); ok({ notes: { max: 0 } })
  bad({}, /at least one key/); bad({ x: 1 }, /unknown key/); bad({ notes: {} }, /at least one/); bad({ notes: { equals: 1, max: 2 } }, /excludes/); bad({ notes: { min: 3, max: 1 } }, /above/); bad({ notes: { equals: 9 } }, /integer/)
  bad({ firstNoteMs: { min: -1 } }, /integer/); bad({ statedSecondsTrue: false }, /true/); bad({ noResult: [] }, /1-4 strings/); bad({ noResult: ['ab'] }, /1-4 strings/); bad({ noResult: [1] }, /1-4 strings/)
  bad({ firstNoteMs: { min: 1 }, notes: { equals: 0 } }, /contradict/); bad({ notes: { equals: 1 } }, /EGDESK_CONVERSATION_FLOW/, { conv: { flags: {} } }); bad({ notes: { equals: 1 } }, /whileRunning/, { conv, turn: { whileRunning: { afterMs: 1 } } })
  const script = expect => ({ set: 'real-engine-t-v1', conversations: [{ id: 'c', flags: { EGDESK_CONVERSATION_FLOW: 'on' }, turns: [{ say: 'a', expect }] }] })
  assert.equal(validateEngineScript(script({ flow: { notes: { equals: 1 } } })).ok, true)
  assert.match(validateEngineScript(script({ flow: { notes: { equals: 9 } } })).errors.join('\n'), /flow/)
})

test('statedSeconds reads seconds, not minutes or other numbers', () => {
  assert.deepEqual(statedSeconds('약 30초 지났고 두 단계를 마쳤어요'), [30]); assert.deepEqual(statedSeconds('about 12 seconds so far, 3 steps'), [12]); assert.deepEqual(statedSeconds('3분 걸려요, 7개 남았어요'), [])
})

test('judgeFlow: one note, in time, truthful seconds, no output the work has not produced; each expectation can fail', () => {
  const note = (atMs, text) => ({ atMs, text })
  const expect = { notes: { equals: 1 }, firstNoteMs: { min: 10000, max: 40000 }, statedSecondsTrue: true, noResult: ['done-42'] }
  const good = [note(31000, '명령이 약 30초째 실행 중이에요. 끝나면 알려 드릴게요.')]
  assert.deepEqual(judgeFlow(expect, good).map(r => [r.check, r.ok]), [['flow.notes', true], ['flow.firstNoteMs', true], ['flow.statedSecondsTrue', true], ['flow.noResult', true]])
  const fails = (notes, name) => judgeFlow(expect, notes).filter(r => !r.ok).map(r => r.check).includes(name)
  assert.ok(fails([], 'flow.notes') && fails([], 'flow.firstNoteMs') && fails([], 'flow.statedSecondsTrue'), 'no note at all fails all three that need one')
  assert.ok(fails([...good, note(41000, '아직 실행 중이에요.')], 'flow.notes'), 'repeated')
  assert.ok(fails([note(5000, '실행 중이에요.')], 'flow.firstNoteMs'), 'too early'); assert.ok(fails([note(50000, '실행 중이에요.')], 'flow.firstNoteMs'), 'too late')
  assert.ok(fails([note(31000, '명령이 45초째 실행 중이에요.')], 'flow.statedSecondsTrue'), 'later than the clock')
  assert.ok(fails([note(31000, '명령이 3초째 실행 중이에요.')], 'flow.statedSecondsTrue'), `older than the writer's own deadline (${FLOW_WRITER_SLACK_MS / 1000} s) allows`)
  assert.ok(!fails([note(31000, '명령이 11초째 실행 중이에요.')], 'flow.statedSecondsTrue'), 'the writer takes time: 31 s - 11 s is within the slack')
  assert.ok(fails([note(31000, '결과는 done-42 입니다.')], 'flow.noResult'), 'a result the work has not produced')
  assert.deepEqual(judgeFlow({ notes: { max: 0 } }, []).map(r => r.ok), [true])
})

test('the hook: the window\'s own messages from the store, timed from the person\'s message; a record only when there were notes', () => {
  const rows = []
  const store = { listMessages: () => ({ messages: rows }) }
  const ctx = expectFlow => ({ state: () => ({ store, clientThreadId: 'ui' }), expect: expectFlow ? { flow: expectFlow } : {} })
  let clock = 5000
  const hook = createFlowHook({ now: () => clock })
  rows.push({ localMessageId: 'old', role: 'assistant', messageId: `${FLOW_PREFIX}old`, createdAt: 1000, text: 'an earlier turn\'s note' })
  hook.beginTurn(ctx())
  rows.push({ localMessageId: 'u', role: 'user', messageId: null, text: 'run it' }, // the store's user message carries no timestamp: the window opened at the turn's start (5000)
    { localMessageId: 'n1', role: 'assistant', messageId: `${FLOW_PREFIX}n1`, createdAt: 36000, text: '약 30초째 실행 중이에요.' },
    { localMessageId: 'a', role: 'assistant', messageId: 'agent-1', createdAt: 51000, text: 'done-42' })
  const out = hook.finishTurn(ctx({ notes: { equals: 1 }, firstNoteMs: { min: 10000, max: 40000 }, statedSecondsTrue: true, noResult: ['done-42'] }))
  assert.deepEqual(out.record, { notes: [{ atMs: 31000, text: '약 30초째 실행 중이에요.' }] }, 'the earlier turn\'s note and the Agent\'s own answer are not notes of this window')
  assert.deepEqual(out.expectations.map(e => e.ok), [true, true, true, true])
  hook.beginTurn(ctx()); const none = hook.finishTurn(ctx({ notes: { equals: 0 } }))
  assert.equal(none.record, null); assert.deepEqual(none.expectations.map(e => [e.check, e.ok]), [['flow.notes', true]])
  assert.deepEqual(createFlowHook().finishTurn({ state: () => ({ store: { listMessages() { throw new Error('x') } }, clientThreadId: 'ui' }), expect: {} }), { record: null, expectations: [] }, 'a store that fails is no finding of its own')
})

test('the committed scripts validate, name the flags that need the decision composition, and state what the pattern means', () => {
  const note = load('real-engine-unsolicited-note-v1'), words = load('real-engine-approval-words-v1')
  for (const s of [note, words]) assert.equal(validateEngineScript(s).ok, true, s.set)
  const c = note.conversations[0], turn = c.turns[0]
  assert.deepEqual([c.flags.EGDESK_CONVERSATION_FLOW, c.draftCheck.mode], ['on', 'on']); assert.ok(c.agentProfile.name, 'an Agent room: only a direct DM of an Agent is held and may be spoken in (an ordinary one-time room never reaches the check or the heartbeat\'s own notes)')
  assert.match(turn.say, /sleep 45/); assert.equal(c.turns.length, 1, 'no message from the person: the note is unsolicited')
  assert.deepEqual(turn.expect.flow, { notes: { equals: 1 }, firstNoteMs: { min: 10000, max: 40000 }, statedSecondsTrue: true, noResult: ['done-42'] })
  assert.deepEqual(turn.expect.engine, { flowMessages: { equals: 1 } }); assert.ok(turn.expect.postedMin >= 2, 'the note and the final answer'); assert.deepEqual(turn.expect.answerIncludes, ['done-42'])
  assert.ok(!turn.say.includes('done-42'), 'the output marker is computed, so a note that holds it invented a result')
  const [yes, no] = words.conversations
  assert.deepEqual([yes.turns[1].say, no.turns[1].say], ['그냥 해', '아니 잠깐']); for (const conv of words.conversations) { assert.equal(conv.flags.EGDESK_TERMINAL_GATE, 'on'); assert.deepEqual(conv.turns[0].expect.commandsRan, [], 'the open question: nothing ran') }
  assert.deepEqual(yes.turns[1].expect.commandsRan, ['git push --force origin main']); assert.deepEqual(no.turns[1].expect.commandsRan, []); assert.equal(yes.turns[1].expect.asked, 0); assert.equal(no.turns[1].expect.asked, 0)
})

// ---- the scripts on the fake app-server (journey support: real time, the journey's scripted Decision answers) ----
import { commandFake, journeyWorld, runJourneyConversation } from '../scripts/egdesk-real-engine-journey.support.mjs'
const failed = record => record.turns.flatMap(t => t.expectations.filter(e => !e.ok).map(e => `${t.index}:${e.check}`))

test('real-engine-unsolicited-note-v1 on the fake: one note is written, checked and posted while the command runs (no message from the person), then the final answer; every expectation passes', async t => {
  const script = load('real-engine-unsolicited-note-v1')
  const fake = commandFake({ command: 'sleep 45 && echo done-$((20+22))', final: '다 끝났어요. 출력은 done-42 입니다.' })
  fake.forkTurns = Array.from({ length: 4 }, () => ({ steps: [], final: '명령이 아직 실행 중이에요. 끝나는 대로 알려 드릴게요.' }))
  const w = journeyWorld(t, fake, { commandMs: () => 24_000, persisted: true })
  w.options.turnTimeoutMs = 60_000
  // the journey's mock judge reads "a command is running" from a native command item; EG-Desk's own command runner is a dynamic tool (run facts: "running the tool egdesk_run_command"):
  // a sound judge says yes to the progress-note question for it (the real judge decides this on the real run)
  const original = w.deps.fetchImpl
  w.deps.fetchImpl = async (url, init) => {
    const body = JSON.parse(init.body), response = await original(url, init)
    if (!body.questions.some(q => q.name === 'message__note') || !JSON.stringify(body.input).includes('egdesk_run_command')) return response
    const json = await response.json()
    for (const a of json.answers) if (a.name === 'message__note') a.probability = 0.97
    return Response.json(json)
  }
  const rec = await runJourneyConversation(w, script, 'unsolicited-note')
  assert.equal(rec.aborted, null, rec.abortDetail); assert.deepEqual(failed(rec), [], JSON.stringify(rec.turns.map(x => x.expectations.filter(e => !e.ok))))
  const turn = rec.turns[0]
  assert.equal(turn.flow.notes.length, 1, 'one note'); assert.ok(turn.flow.notes[0].atMs >= 10_000 && turn.flow.notes[0].atMs <= 40_000, `at ${turn.flow.notes[0].atMs} ms`)
  assert.equal(turn.posted.length, 2); assert.equal(turn.posted.at(-1), '다 끝났어요. 출력은 done-42 입니다.'); assert.equal(turn.posted[0].includes('done-42'), false, 'the note holds no output')
  assert.deepEqual(w.stderrLines, [])
})

// ---- approval-words: the person answers the pending question in their own words ----
const FORCE = 'git push --force origin main'
function approvalWorld(t, { second }) {
  const fake = { turns: [{ steps: [{ toolCall: { tool: 'egdesk_run_command', arguments: { command: FORCE } } }], final: '이 명령은 되돌릴 수 없어서 확인이 필요해요. 실행할까요?' }, second], forkTurns: [] }
  const w = journeyWorld(t, fake, { commandMs: () => 50 })
  // a sound judge for the command gate and for the reply (the real judge decides these on the real run): a force push is not restorable; the reply is read against the one command asked about
  const original = w.deps.fetchImpl
  w.deps.fetchImpl = async (url, init) => {
    const body = JSON.parse(init.body), names = body.questions.map(q => q.name)
    if (!names.some(n => /^(risk_|reply_)/.test(n))) return original(url, init)
    const text = JSON.stringify(body.input), json = { answers: [], usage: { input_tokens: 40 } }
    const reply = /"role":"user","content":"[^"]*Reply[^"]*"/.test(text) ? text : text
    for (const q of body.questions) {
      const p = q.name === 'reply_runs_command' ? (/그냥 해/.test(text) ? 0.96 : 0.03) : q.name === 'reply_declines_command' ? (/아니 잠깐/.test(text) ? 0.96 : 0.03) : q.name === 'risk_unrestorable' ? (/--force/.test(text) ? 0.95 : 0.03) : 0.03
      json.answers.push({ type: 'predicate', name: q.name, probability: p })
    }
    return Response.json(json)
  }
  return w
}
test('real-engine-approval-words-v1 "그냥 해" on the fake: nothing runs while the question is open; the reply runs exactly that command once; every expectation passes', async t => {
  const w = approvalWorld(t, { second: { steps: [{ toolCall: { tool: 'egdesk_run_command', arguments: { command: FORCE } } }], final: '실행했어요.' } })
  const rec = await runJourneyConversation(w, load('real-engine-approval-words-v1'), 'approval-just-do-it')
  assert.equal(rec.aborted, null, rec.abortDetail); assert.deepEqual(failed(rec), [], JSON.stringify(rec.turns.map(x => x.expectations.filter(e => !e.ok))))
  assert.deepEqual(rec.turns.map(x => x.subTurns.flatMap(s => s.commandsRan)), [[], [FORCE]]); assert.deepEqual(w.commands.map(c => c.command.includes('--force')), [true], 'one process, in the second turn only')
})
test('real-engine-approval-words-v1 "아니 잠깐" on the fake: the reply settles it as declined; nothing runs; every expectation passes', async t => {
  const w = approvalWorld(t, { second: { steps: [], final: '알겠어요, 실행하지 않았어요.' } })
  const rec = await runJourneyConversation(w, load('real-engine-approval-words-v1'), 'approval-wait-no')
  assert.equal(rec.aborted, null, rec.abortDetail); assert.deepEqual(failed(rec), [], JSON.stringify(rec.turns.map(x => x.expectations.filter(e => !e.ok))))
  assert.deepEqual(rec.turns.map(x => x.subTurns.flatMap(s => s.commandsRan)), [[], []]); assert.deepEqual(w.commands, [])
})
test('the approval expectations can fail: a command that ran while the question was open, and a declined reply that ran it anyway', async t => {
  // the fake model runs the command in the second turn although the person declined: the expectation commandsRan [] of that turn fails
  const w = approvalWorld(t, { second: { steps: [{ toolCall: { tool: 'egdesk_run_command', arguments: { command: FORCE } } }], final: '실행했어요.' } })
  w.deps.fetchImpl = (orig => async (url, init) => { const r = await orig(url, init); const j = await r.json(); for (const a of j.answers ?? []) if (a.name === 'reply_runs_command') a.probability = 0.96; if (j.answers) for (const a of j.answers) if (a.name === 'reply_declines_command') a.probability = 0.02; return Response.json(j) })(w.deps.fetchImpl)
  const rec = await runJourneyConversation(w, load('real-engine-approval-words-v1'), 'approval-wait-no')
  assert.ok(failed(rec).some(name => /commandsRan/.test(name)), `a run after "아니 잠깐" is a failure: ${JSON.stringify(failed(rec))}`)
})
