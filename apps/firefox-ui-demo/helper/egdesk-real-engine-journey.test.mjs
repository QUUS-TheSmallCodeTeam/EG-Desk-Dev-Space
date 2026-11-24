// L2 c21: the journey's real-engine scripts (scripts/real-engine/scripts/real-engine-journey-{memory,nudges}-v1.json) and the engine-side expectations
// (helper/egdesk-real-engine-journey.mjs): structure, the committed files against their builder, and every conversation run through the real-engine check
// against the FAKE app-server with the journey's scripted Decision answers. No Codex binary, no command, no network. A pass here means the mechanics work;
// how the real model behaves is Main's run. The negative tests show each expectation can fail.
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { EventEmitter } from 'node:events'
import { fileURLToPath } from 'node:url'
import { ENGINE_EXPECT_SCHEMA, createJourneyHook, messageCounts, validateEngineExpect } from './egdesk-real-engine-journey.mjs'
import { REAL_ENGINE_SCRIPT_SCHEMA, checkTurnExpectations, validateEngineScript } from './egdesk-real-engine-script.mjs'
import { GRAPH } from '../scripts/egdesk-all-on.support.mjs'
import { SAYS } from '../scripts/egdesk-all-on-live-measure.mjs'
import { DB_IDS, MEMORY_SET, MEMORY_SET_V2, NUDGES_SET, NUDGES_SET_V2, QUOTE_IDS, SCRIPTS_DIR, buildJourneyScripts, journeyMemoryPages, scriptText } from '../scripts/egdesk-real-engine-journey-scripts.mjs'
import { MEMORY_FAKE, commandFake, costOf, fastScript, journeyWorld, ruleJudge, runJourneyConversation } from '../scripts/egdesk-real-engine-journey.support.mjs'
import { secretsIn } from './egdesk-secret-mask.mjs'

const here = path.dirname(fileURLToPath(import.meta.url))
const load = set => JSON.parse(fs.readFileSync(path.join(SCRIPTS_DIR, `${set}.json`), 'utf8'))
const failed = record => record.turns.flatMap(t => t.expectations.filter(e => !e.ok).map(e => `${t.index}:${e.check}`))
const nudgeFast = () => fastScript(load(NUDGES_SET))

// ---- structure ----
test('the engine expectation: its schema is in the committed schema file, and the validator accepts the right shapes and refuses the rest', () => {
  const committed = JSON.parse(fs.readFileSync(path.join(here, '..', 'scripts', 'real-engine', 'real-engine-script.schema.json'), 'utf8'))
  assert.deepEqual(committed, JSON.parse(JSON.stringify(REAL_ENGINE_SCRIPT_SCHEMA)))
  assert.deepEqual(committed.properties.conversations.items.properties.turns.items.properties.expect.properties.engine, JSON.parse(JSON.stringify(ENGINE_EXPECT_SCHEMA)))
  const ok = (e, o = {}) => assert.deepEqual(validateEngineExpect(e, o), [], JSON.stringify(e))
  const bad = (e, pattern, o = {}) => assert.match(validateEngineExpect(e, o).join('\n'), pattern, JSON.stringify(e))
  ok({ steers: 1, interrupts: 0, flowMessages: { max: 0 }, agentMessages: { equals: 0 } }); ok({ steerCarries: true, steers: 1 }, { whileRunning: true }); ok({ maxLatencyMs: 30000, commandStopped: true })
  bad({}, /at least one key/); bad({ x: 1 }, /unknown key/); bad({ steers: -1 }, /integer/); bad({ steers: 1.5 }, /integer/); bad({ steers: 9 }, /integer/); bad({ interrupts: '1' }, /integer/)
  bad({ steerCarries: true }, /only on a whileRunning turn/); bad({ steerCarries: true, steers: 0 }, /contradict/, { whileRunning: true }); bad({ steerCarries: false }, /true/, { whileRunning: true })
  bad({ maxLatencyMs: 10 }, /1000/); bad({ maxLatencyMs: 5000 }, /not on a whileRunning turn/, { whileRunning: true }); bad({ commandStopped: true }, /not on a whileRunning turn/, { whileRunning: true }); bad({ commandStopped: false }, /true/)
  bad({ flowMessages: {} }, /object/); bad({ flowMessages: { equals: 1, max: 2 } }, /excludes/); bad({ flowMessages: { min: 3, max: 1 } }, /above/); bad({ agentMessages: { top: 1 } }, /unknown key/); bad({ agentMessages: { max: 99 } }, /integer/)
  const script = (turn1, turn2) => ({ set: 'real-engine-t-v1', conversations: [{ id: 'c', flags: { EGDESK_INRUN_MESSAGES: 'on' }, turns: [{ say: 'a', expect: turn1 }, { say: 'b', whileRunning: { afterMs: 10 }, expect: turn2 }] }] })
  assert.equal(validateEngineScript(script({ engine: { interrupts: 0 } }, { engine: { steers: 1, steerCarries: true } })).ok, true)
  assert.match(validateEngineScript(script({ engine: { steerCarries: true } }, {})).errors.join('\n'), /only on a whileRunning turn/)
  assert.match(validateEngineScript(script({}, { engine: { maxLatencyMs: 2000 } })).errors.join('\n'), /not on a whileRunning turn/)
})

test('the committed script files are what the builder makes, validate, and use the journey\'s own world', () => {
  const built = buildJourneyScripts()
  for (const [set, script] of Object.entries(built)) { assert.equal(fs.readFileSync(path.join(SCRIPTS_DIR, `${set}.json`), 'utf8'), scriptText(script), `${set} is stale: node scripts/egdesk-real-engine-journey-scripts.mjs --write`); assert.deepEqual(validateEngineScript(load(set)), { ok: true, errors: [] }) }
  // the pages are the journey's own (scripts/egdesk-all-on.support.mjs GRAPH): same ids, titles and bodies; only the kinds of link and status the seeding knows are carried
  const pages = journeyMemoryPages()
  assert.deepEqual(pages.map(p => [p.id, p.title, p.body]), GRAPH.nodes.map(n => [n.id, n.label, n.body]))
  assert.equal(pages.length, 12); assert.deepEqual([QUOTE_IDS.length, DB_IDS.length], [5, 7])
  for (const script of Object.values(built)) for (const c of script.conversations) assert.deepEqual(c.memory.pages, pages, `${c.id}: the same twelve pages`)
  // the sentences are the journey's
  const memory = load(MEMORY_SET).conversations[0]
  assert.deepEqual(memory.turns.map(t => t.say), [SAYS.quote, SAYS.tidy, SAYS.recall, SAYS.deployed])
  const [status, change, stop] = load(NUDGES_SET).conversations
  assert.deepEqual([status.turns[1].say, change.turns[1].say, stop.turns[1].say], [SAYS.nudge, SAYS.change, SAYS.stop])
  assert.deepEqual(load(NUDGES_SET).conversations.map(c => c.id), ['journey-status', 'journey-change', 'journey-stop'])
  // flags: names and values only, the nudge conversations need the in-run flags, and every one asks for the action rule
  for (const c of load(NUDGES_SET).conversations) assert.deepEqual([c.flags.EGDESK_INRUN_MESSAGES, c.flags.EGDESK_CONVERSATION_FLOW, c.flags.EGDESK_DRAFT_CHECK, c.flags.EGDESK_CONTEXT_RELEVANCE], ['on', 'on', 'on', 'action'])
  assert.equal(memory.flags.EGDESK_INRUN_MESSAGES, undefined)
  // every long command is an action request: no page may be attached for it; each in-run message is typed after the wait note's 10 s
  for (const c of load(NUDGES_SET).conversations) { assert.deepEqual(c.turns[0].expect.memory.notAttached.slice().sort(), pages.map(p => p.id).sort()); assert.equal(c.turns[1].whileRunning.afterMs, 12000); assert.deepEqual(c.turns[0].expect.toolCalls, ['egdesk_run_command']) }
  assert.deepEqual(status.turns[0].expect.engine, { steers: 0, interrupts: 0, flowMessages: { min: 1, max: 2 } }); assert.deepEqual(status.turns[1].expect.engine, { steers: 0, interrupts: 0, flowMessages: { equals: 1 } })
  assert.deepEqual(change.turns[1].expect.engine, { steers: 1, interrupts: 0, steerCarries: true, flowMessages: { max: 0 } })
  assert.deepEqual(stop.turns[0].expect, { toolCalls: ['egdesk_run_command'], commandsRan: ['sleep 40 && echo never-printed'], memory: stop.turns[0].expect.memory, noNativeTools: true, turnStatus: 'interrupted', engine: { interrupts: 1, steers: 0, agentMessages: { equals: 0 }, flowMessages: { max: 1 }, commandStopped: true, maxLatencyMs: 30000 } })
  assert.deepEqual(stop.turns[1].expect.engine, { interrupts: 1, steers: 0, flowMessages: { max: 0 } })
  for (const set of [MEMORY_SET, NUDGES_SET]) assert.deepEqual(secretsIn(fs.readFileSync(path.join(SCRIPTS_DIR, `${set}.json`), 'utf8')), [], set)
})

test('the hook on its own: windows, counts, and what each expectation judges', () => {
  const hook = createJourneyHook(), at = { flows: 0, agents: 0 }, counts = () => ({ ...at })
  hook.observe('turn/steer', { expectedTurnId: 'ignored: no window yet' })
  hook.beginTurn({ counts })
  hook.observe('turn/start', {}); hook.observe('turn/interrupt', { threadId: 't', turnId: 'turn-1' })
  at.flows = 1
  hook.markInRun({ text: 'B부터', counts })
  hook.observe('turn/steer', { threadId: 't', expectedTurnId: 'turn-1', clientUserMessageId: 'req-2', input: [{ type: 'text', text: 'B부터', text_elements: [] }] })
  at.flows = 2; at.agents = 1
  const done = hook.finishTurn({ expect: { engine: { interrupts: 1, steers: 1, flowMessages: { equals: 2 }, agentMessages: { equals: 1 }, maxLatencyMs: 5000 } }, nextExpect: { engine: { steers: 1, interrupts: 0, steerCarries: true, flowMessages: { equals: 1 }, agentMessages: { equals: 1 } } }, latencyMs: 4000, counts, steerContract: true })
  assert.deepEqual(done.expectations.map(e => [e.check, e.ok]), [['engine.steers', true], ['engine.interrupts', true], ['engine.flowMessages', true], ['engine.agentMessages', true], ['engine.maxLatencyMs', true]])
  assert.deepEqual(done.nextExpectations.map(e => [e.check, e.ok]), [['engine.steers', true], ['engine.interrupts', true], ['engine.steerCarries', true], ['engine.flowMessages', true], ['engine.agentMessages', true]], 'the later window starts at the message')
  assert.deepEqual(done.record.steers, [{ turnId: 'turn-1', texts: ['B부터'], clientUserMessageId: 'req-2' }])
  // a steer with other words, an extra input, or no client id is not "carries"
  for (const input of [[{ type: 'text', text: '다른 말' }], [{ type: 'text', text: 'B부터' }, { type: 'text', text: '더' }], [{ type: 'image' }]]) {
    const h = createJourneyHook(); h.beginTurn({ counts: () => ({ flows: 0, agents: 0 }) }); h.markInRun({ text: 'B부터', counts }); h.observe('turn/steer', { expectedTurnId: 't1', clientUserMessageId: 'r', input })
    assert.equal(h.finishTurn({ nextExpect: { engine: { steerCarries: true } }, counts }).nextExpectations[0].ok, false, JSON.stringify(input))
  }
  const noContract = createJourneyHook(); noContract.beginTurn({ counts }); noContract.markInRun({ text: 'x', counts })
  const miss = noContract.finishTurn({ nextExpect: { engine: { steers: 1 } }, counts, steerContract: false }).nextExpectations[0]
  assert.deepEqual([miss.ok, miss.detail], [false, { wanted: 1, seen: 0, steerContract: false }], 'a missing steer says whether the binary had the contract')
  assert.equal(createJourneyHook().finishTurn({ expect: {}, counts }).expectations.length, 0)
  // commandStopped: every command of the window ended, the last one by a signal (not by finishing, not still running, not no command at all)
  const ended = (...ways) => { const h = createJourneyHook(); h.beginTurn({ counts }); const kids = ways.map((way, i) => { const child = new EventEmitter(); h.observeCommand(`cmd ${i}`, child); return [child, way] }); for (const [child, way] of kids) if (way) child.emit('close', way === 'signal' ? null : 0, way === 'signal' ? 'SIGTERM' : null); return h.finishTurn({ expect: { engine: { commandStopped: true } }, counts }) }
  assert.equal(ended('signal').expectations[0].ok, true); assert.equal(ended('exit', 'signal').expectations[0].ok, true)
  assert.equal(ended('exit').expectations[0].ok, false, 'finished by itself'); assert.equal(ended(null).expectations[0].ok, false, 'still running'); assert.equal(ended('signal', 'exit').expectations[0].ok, false, 'the last one finished by itself'); assert.equal(ended().expectations[0].ok, false, 'no command ran')
  assert.deepEqual(ended('exit').expectations[0].detail.commands, [{ command: 'cmd 0', closed: true, code: 0, signal: null }])
})

test('messageCounts separates the system\'s own messages from the Agent\'s', () => {
  const rows = [{ role: 'user', messageId: 'm1' }, { role: 'assistant', messageId: 'egdesk-flow:a' }, { role: 'assistant', messageId: 'x1' }, { role: 'assistant', messageId: 'egdesk-flow:b' }]
  assert.deepEqual(messageCounts({ listMessages: () => ({ messages: rows }) }, 't'), { flows: 2, agents: 1 })
  assert.deepEqual(messageCounts({ listMessages: () => { throw new Error('none') } }, 't'), { flows: 0, agents: 0 })
})

// ---- the conversations, on the fake app-server (real time, so afterMs and the commands are shortened; the expectations are not changed) ----
test('journey-memory: the four memory steps pass their expectations on the fake; what the run costs is counted', async t => {
  const script = load(MEMORY_SET), w = journeyWorld(t, MEMORY_FAKE)
  const rec = await runJourneyConversation(w, script, 'journey-memory')
  assert.equal(rec.aborted, null, rec.abortDetail); assert.deepEqual(failed(rec), [], JSON.stringify(rec.turns.map(x => x.expectations.filter(e => !e.ok))))
  assert.equal(rec.ok, true); assert.deepEqual(w.stderrLines, [])
  const attached = rec.turns.map(x => x.memory.attached)
  assert.ok(attached[0].includes('quote/a-request') && attached[0].includes('quote/a-v1') && !attached[0].some(id => id.startsWith('db/')))
  assert.ok(attached[2].includes('db/pg-design') && !attached[2].some(id => id.startsWith('quote/')))
  assert.equal(rec.turns[1].memory.resent.length, 0); assert.equal(rec.turns[3].memory.resent.length, 0); assert.ok(rec.turns[3].memory.referenced.includes('db/pg-design'), 'what s3b delivered is referenced, not sent again')
  const cost = costOf(w, rec)
  assert.equal(cost.engineTurns, 4); assert.ok(cost.decisionRequests >= 8 && cost.decisionEstTokens > 0, JSON.stringify(cost))
})

test('journey-status: a status nudge neither interrupts nor steers; the command finishes, one reply is posted', async t => {
  const script = nudgeFast(), w = journeyWorld(t, commandFake({ command: 'sleep 20 && echo tests-passed-40', final: '테스트가 모두 통과했습니다. tests-passed-40' }))
  const rec = await runJourneyConversation(w, script, 'journey-status')
  assert.equal(rec.aborted, null, rec.abortDetail); assert.deepEqual(failed(rec), [], JSON.stringify(rec.turns.map(x => x.expectations.filter(e => !e.ok))))
  assert.equal(rec.turns[0].subTurns[0].status, 'completed'); assert.deepEqual(rec.turns[0].journey.steers, []); assert.equal(rec.turns[0].journey.flowMessages, 1)
  const cost = costOf(w, rec); assert.deepEqual([cost.engineTurns, cost.steers, cost.interrupts], [1, 0, 0]); assert.equal(cost.writerForkTurns, 1, 'one internal writing turn: the reply (on a fresh ephemeral thread since L5 c24)')
  // exactly one reply besides the final answer: after the message the person has two posts (the reply and the run's own answer), one of them the system's
  assert.equal(rec.turns[1].posted.length, 2); assert.equal(rec.turns[1].posted.at(-1), '테스트가 모두 통과했습니다. tests-passed-40', 'the final answer is the run\'s own')
  assert.deepEqual([rec.turns[0].journey.flowMessages, rec.turns[0].journey.agentMessages], [1, 1], 'one system message (the reply) and one Agent message (the final answer)')
  assert.deepEqual(w.stderrLines, [])
})

test('journey-change: the change is steered into the working turn with only the person\'s words; nothing is posted for it; the command is not interrupted', async t => {
  const script = nudgeFast(), w = journeyWorld(t, commandFake({ command: 'sleep 25 && echo build-A-finished', final: 'build-A-finished 까지 실행했습니다.', steerFinal: 'B부터 하라는 말씀에 따라 B를 먼저 진행하겠습니다.' }))
  const rec = await runJourneyConversation(w, script, 'journey-change')
  assert.equal(rec.aborted, null, rec.abortDetail); assert.deepEqual(failed(rec), [], JSON.stringify(rec.turns.map(x => x.expectations.filter(e => !e.ok))))
  assert.deepEqual(rec.turns[0].journey.steers.map(s => s.texts), [[SAYS.change]]); assert.equal(rec.turns[0].journey.interrupts.length, 0)
  assert.match(rec.turns[1].posted.at(-1), /B부터/, 'the run took it: its own answer follows the steer')
  const cost = costOf(w, rec); assert.deepEqual([cost.engineTurns, cost.steers, cost.interrupts, cost.writerForkTurns], [1, 1, 0, 0]); assert.deepEqual(w.stderrLines, [])
})

test('journey-stop: the stop interrupts the working turn once, the Agent posts no answer, and EG-Desk stops the command process (c25: the finding of c21 is fixed)', async t => {
  const script = nudgeFast(), w = journeyWorld(t, commandFake({ command: 'sleep 40 && echo never-printed', final: 'never-printed' }))
  const rec = await runJourneyConversation(w, script, 'journey-stop')
  assert.equal(rec.aborted, null, rec.abortDetail); assert.deepEqual(w.stderrLines, [])
  assert.equal(rec.turns[0].subTurns[0].status, 'interrupted'); assert.deepEqual(rec.turns[0].posted, []); assert.equal(rec.turns[0].journey.interrupts.length, 1); assert.deepEqual(rec.turns[0].journey.steers, [])
  assert.ok(rec.turns[1].expectations.every(e => e.ok), JSON.stringify(rec.turns[1].expectations))
  // c21 pinned the finding that an interrupt left the command running (the executor had no cancelRun). c25 (helper/egdesk-command-executor.mjs cancelRun): the interrupt stops
  // the command's process group (SIGTERM, SIGKILL after the grace), so engine.commandStopped passes and nothing fails.
  assert.deepEqual(failed(rec), [], JSON.stringify(rec.turns[0].expectations.filter(e => !e.ok)))
  const stopped = rec.turns[0].expectations.find(e => e.check === 'engine.commandStopped')
  assert.equal(stopped.ok, true); assert.equal(stopped.detail.commands.length, 1); assert.equal(stopped.detail.commands[0].closed, true); assert.notEqual(stopped.detail.commands[0].signal, null, 'it was stopped by a signal, it did not run out')
  assert.notEqual(w.commands[0].killedAfterMs, null, 'EG-Desk killed it')
  const cost = costOf(w, rec); assert.deepEqual([cost.engineTurns, cost.steers, cost.interrupts], [1, 0, 1])
})

// ---- each expectation can fail ----
const reads = (names, p) => (url, init) => { const body = JSON.parse(init.body); return Promise.resolve(Response.json({ answers: body.questions.map(q => ({ name: q.name, type: 'predicate', probability: names.includes(q.name) ? p : 0.03 })), usage: { input_tokens: 10 } })) }
// the fake model for a no-op Decision world: the memory pages are not picked, the message questions answer as told
test('a stop that the model reads as a status question does not interrupt: the stop conversation fails on interrupts, turnStatus and the latency cap', async t => {
  const w = journeyWorld(t, commandFake({ command: 'sleep 40 && echo never-printed', final: 'never-printed' })), script = nudgeFast()
  script.conversations[2].turns[0].expect.engine.maxLatencyMs = 5000 // the fake command takes 8 s: a turn that is not cut short misses this cap (the committed cap is 30 s)
  w.deps.fetchImpl = reads(['person_status'], 0.95)
  const rec = await runJourneyConversation(w, script, 'journey-stop')
  assert.equal(rec.aborted, null, rec.abortDetail)
  const bad = failed(rec); for (const check of ['1:turnStatus', '1:engine.interrupts', '1:engine.maxLatencyMs', '2:engine.interrupts']) assert.ok(bad.includes(check), check + ' in ' + bad.join(','))
  assert.equal(rec.ok, false); assert.equal(costOf(w, rec).interrupts, 0)
})

test('a status question that the model reads as a change is steered: the status conversation fails on steers (and a reply nobody posted fails the flow count)', async t => {
  const w = journeyWorld(t, commandFake({ command: 'sleep 20 && echo tests-passed-40', final: '테스트가 모두 통과했습니다. tests-passed-40', steerFinal: '테스트가 모두 통과했습니다. tests-passed-40' }))
  w.deps.fetchImpl = reads(['person_change'], 0.95)
  const rec = await runJourneyConversation(w, nudgeFast(), 'journey-status')
  const bad = failed(rec); for (const check of ['1:engine.steers', '2:engine.steers', '2:engine.flowMessages']) assert.ok(bad.includes(check), check + ' in ' + bad.join(','))
  assert.equal(costOf(w, rec).steers, 1)
})

test('a binary without the steer contract: the change is not steered (the message waits), the expectation fails and says the contract was missing', async t => {
  const w = journeyWorld(t, commandFake({ command: 'sleep 25 && echo build-A-finished', final: 'build-A-finished 까지 실행했습니다.' }), { steerContract: false })
  const rec = await runJourneyConversation(w, nudgeFast(), 'journey-change')
  assert.equal(rec.aborted, null, rec.abortDetail)
  assert.equal(rec.engine.nativeContract.boardPeerContract, false); assert.equal(rec.engine.nativeContract.steerContract, false)
  const steers = rec.turns[1].expectations.find(e => e.check === 'engine.steers'), carries = rec.turns[1].expectations.find(e => e.check === 'engine.steerCarries')
  assert.deepEqual([steers.ok, steers.detail], [false, { wanted: 1, seen: 0, steerContract: false }]); assert.equal(carries.ok, false)
  assert.equal(rec.turns[0].subTurns[0].status, 'completed', 'the command still ends normally'); assert.equal(costOf(w, rec).steers, 0)
})

test('memory expectations fail when the product sends the wrong pages: a Decision model that picks nothing leaves s1\'s pages unattached', async t => {
  const w = journeyWorld(t, MEMORY_FAKE)
  w.deps.fetchImpl = reads([], 0.03)
  const rec = await runJourneyConversation(w, load(MEMORY_SET), 'journey-memory')
  const bad = failed(rec); assert.ok(bad.includes('1:memory.attached'), bad.join(','))
})

test('the fast copy changes only the timings: every other part of a script is the committed one', () => {
  const real = load(NUDGES_SET), fast = fastScript(real)
  for (const [i, c] of real.conversations.entries()) for (const [j, turn] of c.turns.entries()) {
    const { whileRunning: a, ...restReal } = turn, { whileRunning: b, ...restFast } = fast.conversations[i].turns[j]
    assert.deepEqual(restFast, restReal); assert.deepEqual([a === undefined, b === undefined], [a === undefined, a === undefined]); if (a) assert.equal(b.afterMs, 1200)
  }
  assert.deepEqual(fast.conversations.map(c => c.memory), real.conversations.map(c => c.memory))
})

// ---- c27: v2 of both sets (v1 stays as committed) ----
test('v2 sets: v1 is untouched; v2 is v1 plus what changed (an Agent room with the draft check on and the posting outcome for memory; the postedMin and the stopped-command question for the nudges)', () => {
  const built = buildJourneyScripts()
  assert.deepEqual(Object.keys(built), [MEMORY_SET, NUDGES_SET, MEMORY_SET_V2, NUDGES_SET_V2])
  for (const [set, script] of Object.entries(built)) assert.equal(fs.readFileSync(path.join(SCRIPTS_DIR, `${set}.json`), 'utf8'), scriptText(script), set)
  const v1m = load(MEMORY_SET).conversations[0], v2m = load(MEMORY_SET_V2).conversations[0]
  assert.equal(v1m.agentProfile, undefined, 'v1 keeps its ordinary room'); assert.ok(v2m.agentProfile.instructions); assert.deepEqual(v2m.draftCheck, { mode: 'on' }); assert.deepEqual(v2m.memory, v1m.memory)
  assert.deepEqual(v2m.turns.map(t => t.say), v1m.turns.map(t => t.say))
  for (const [i, t] of v2m.turns.entries()) {
    assert.deepEqual(t.expect.rewrite, { answered: true, neverShown: { numbers: true } }); assert.equal(t.expect.memory.noDuplicates, true); assert.equal(t.expect.memory.maxKeyBytes, 4000)
    const { rewrite, ...rest } = t.expect; const { noDuplicates, maxKeyBytes, ...memory } = rest.memory
    assert.deepEqual({ ...rest, memory }, v1m.turns[i].expect, `turn ${i + 1}: every v1 expectation kept`)
  }
  assert.deepEqual([v2m.flags.EGDESK_TURN_MEMORY_ONE_PACKET, v2m.flags.EGDESK_TURN_MEMORY_ENGINE_CONTEXT, v2m.flags.EGDESK_TURN_MEMORY_ENGINE_BYTES, v2m.flags.EGDESK_TURN_MEMORY_SELECTION_HELD], ['on', 'split', '4000', 'on'])
  const v1n = load(NUDGES_SET).conversations, v2n = load(NUDGES_SET_V2).conversations
  assert.deepEqual(v2n.map(c => c.id), v1n.map(c => c.id)); assert.deepEqual(v2n.map(c => c.flags), v1n.map(c => c.flags)); assert.deepEqual(v2n[1], v1n[1], 'journey-change is unchanged')
  assert.deepEqual(v2n[0].turns[1].expect, { ...v1n[0].turns[1].expect, postedMin: 2 }); assert.deepEqual(v2n[0].turns[0], v1n[0].turns[0])
  assert.deepEqual(v2n[2].turns.slice(0, 2), v1n[2].turns); assert.equal(v2n[2].turns.length, 3); assert.match(v2n[2].turns[2].say, /끝까지 실행된 거야/); assert.deepEqual(v2n[2].turns[2].expect.answerExcludes.slice(0, 1), ['never-printed'])
  for (const set of [MEMORY_SET_V2, NUDGES_SET_V2]) { assert.deepEqual(validateEngineScript(load(set)), { ok: true, errors: [] }, set); assert.deepEqual(secretsIn(fs.readFileSync(path.join(SCRIPTS_DIR, `${set}.json`), 'utf8')), [], set) }
})

const rewriteOf = rec => rec.turns.map(t => t.rewrite)
test('memory-v2: the four steps pass on the fake in an Agent room with the draft check on: the check ran each time, every answer posted as written, no page twice, the engine context within its bytes', async t => {
  const script = load(MEMORY_SET_V2), w = journeyWorld(t, MEMORY_FAKE, { persisted: true })
  const rec = await runJourneyConversation(w, script, 'journey-memory')
  assert.equal(rec.aborted, null, rec.abortDetail); assert.deepEqual(failed(rec), [], JSON.stringify(rec.turns.map(x => x.expectations.filter(e => !e.ok)))); assert.equal(rec.ok, true)
  assert.deepEqual(rec.cleanup.failures, []); assert.equal(rec.cleanup.verifiedGone, rec.cleanup.persisted)
  assert.deepEqual(rewriteOf(rec).map(r => [r.checked, r.finding, r.posted, r.nothingRemains]), [[true, false, 'as_written', false], [true, false, 'as_written', false], [true, false, 'as_written', false], [true, false, 'as_written', false]])
  assert.ok(rec.turns.every(x => x.draftCheck.rows.length >= 1), 'in v1 the check never ran in this conversation: rows were empty')
  assert.ok(rec.turns.every(x => x.memory.duplicatesInTurn === 0))
  // one packet: where the selection and the memory both attach (s1, s3b) the pages ride under the selection's key and there is no separate memory key
  for (const i of [0, 2]) { assert.ok(rec.turns[i].memory.keys.includes('egdesk_decision_context') && !rec.turns[i].memory.keys.includes('egdesk_turn_memory'), JSON.stringify(rec.turns[i].memory.keys)); assert.ok(rec.turns[i].memory.merged.length > 0) }
  // the same steps in the ordinary room (v1) never reached the check: its rows were empty
  const v1 = await runJourneyConversation(journeyWorld(t, MEMORY_FAKE), load(MEMORY_SET), 'journey-memory')
  assert.ok(v1.turns.every(x => x.draftCheck.rows.length === 0))
})

test('memory-v2: a check that finds the (correct) answer wrong and a rewrite that keeps it leaves nothing: the person gets no answer, and v2 says so by code (answered and posted fail)', async t => {
  const w = journeyWorld(t, { turns: MEMORY_FAKE.turns, forkTurns: [{ steps: [], final: MEMORY_FAKE.turns[0].final }] }, { persisted: true, judge: ruleJudge(s => (s.includes('12,800') ? { support: 0.02 } : null)) })
  const rec = await runJourneyConversation(w, load(MEMORY_SET_V2), 'journey-memory')
  assert.deepEqual([rec.turns[0].rewrite.posted, rec.turns[0].rewrite.nothingRemains, rec.turns[0].posted], ['withheld', true, []])
  assert.ok(failed(rec).includes('1:rewrite.answered') && failed(rec).includes('1:posted'), failed(rec).join())
})

test('nudges-v2 journey-status: the reply and the final answer are both posted (postedMin 2); an answer-only run fails it by code', async t => {
  const script = fastScript(load(NUDGES_SET_V2)), w = journeyWorld(t, commandFake({ command: 'sleep 20 && echo tests-passed-40', final: '테스트가 모두 통과했습니다. tests-passed-40' }))
  const rec = await runJourneyConversation(w, script, 'journey-status')
  assert.equal(rec.aborted, null, rec.abortDetail); assert.deepEqual(failed(rec), [], JSON.stringify(rec.turns.flatMap(x => x.expectations.filter(e => !e.ok))))
  assert.ok(rec.turns[1].expectations.some(e => e.check === 'postedMin' && e.ok), 'the in-run turn counted two posted messages')
  // a run that posts only its final answer (no reply to the question) fails the same expectation by code
  assert.deepEqual(checkTurnExpectations(load(NUDGES_SET_V2).conversations[0].turns[1].expect, { posted: ['테스트가 모두 통과했습니다.'] }).filter(c => c.check === 'postedMin').map(c => c.ok), [false])
})

test('nudges-v2 journey-stop: after the stop a third turn asks what happened to the command; an answer that tells the truth passes, one that claims the output or cannot tell fails by code', async t => {
  const run = async then => runJourneyConversation(journeyWorld(t, commandFake({ command: 'sleep 40 && echo never-printed', final: 'never-printed', then: [then] })), fastScript(load(NUDGES_SET_V2)), 'journey-stop')
  const good = await run('중간에 멈췄습니다. 끝까지 실행되지는 않았습니다.')
  assert.equal(good.aborted, null, good.abortDetail); assert.deepEqual(failed(good), [], JSON.stringify(good.turns.flatMap(x => x.expectations.filter(e => !e.ok)))); assert.equal(good.turns.length, 3)
  assert.deepEqual((await run('끝까지 실행되어 never-printed 가 출력되었습니다.')).turns[2].expectations.filter(e => !e.ok).map(e => e.check), ['answerExcludes'])
  assert.deepEqual((await run('끝까지 실행됐는지 확인할 수 없습니다.')).turns[2].expectations.filter(e => !e.ok).map(e => e.check), ['answerExcludes'])
})
