// c24: an internal turn on a conversation that cannot be forked. Main's smoke-5 on the official 0.171: thread/fork of an EPHEMERAL source fails with
// -32600 "no rollout found for thread id …" (after a completed turn, mid-turn, with lastTurnId); a persisted source forks fine. The turn then runs on a
// fresh ephemeral thread with the pure-engine overrides. Mock engines only; the end-to-end case against the schema-checked fake app-server is in
// egdesk-real-engine-check.test.mjs.
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { INTERNAL_INSTRUCTIONS, NO_ROLLOUT, createInternalTurns } from './codex-internal-turn.mjs'
import { CodexChatRuntime } from './codex-chat-runtime.mjs'
import { openChatStore } from './egdesk-chat-store.mjs'
import { createPrivateQaTempDirectory } from '../scripts/egdesk-qa-platform.mjs'

const refusal = id => Object.assign(new Error(`no rollout found for thread id ${id}`), { code: -32600 })

/** A mock engine: fork works unless refuseFork; startThread/startTurn record their params; the turn answers through turns.feed on the next tick. */
function mockEngine(turns, { refuseFork = false, forkError = null, startedEphemeral = true, hang = null } = {}) {
  const calls = []
  let n = 0
  const engine = {
    calls,
    forkThread: async (params, slot) => { calls.push(['fork', params, slot]); if (refuseFork) throw refusal(params.threadId); if (forkError) throw forkError; return { thread: { id: `fork-${++n}` } } },
    startThread: async (params, slot) => { calls.push(['start', params, slot]); if (hang === 'start') await new Promise(() => {}); return { thread: { id: `fresh-${++n}`, ephemeral: startedEphemeral } } },
    startTurn: async (params, slot) => {
      calls.push(['turn', params, slot])
      setImmediate(() => {
        turns.feed({ method: 'item/completed', params: { threadId: params.threadId, item: { type: 'agentMessage', phase: 'commentary', text: 'thinking' } } })
        turns.feed({ method: 'item/completed', params: { threadId: params.threadId, item: { type: 'agentMessage', phase: 'final_answer', text: `answer to: ${params.input[0].text.slice(-12)}` } } })
        turns.feed({ method: 'turn/completed', params: { threadId: params.threadId, turn: { status: 'completed' } } })
      })
      return { turn: { id: 't' } }
    },
    releaseThread: async (id, slot) => { calls.push(['release', id, slot]) },
  }
  return engine
}
const FRESH = { preamble: 'Context: the person\'s last message to you was "stop".', overrides: async () => ({ cwd: '/engine/empty', sandbox: 'read-only', approvalPolicy: 'never', model: 'm1', config: { features: { shell_tool: false } } }), effort: 'low' }
const kinds = engine => engine.calls.map(c => c[0])

test('a persisted parent forks exactly as before: no fresh thread, the fork carries the turn, the fork is released', async () => {
  const turns = createInternalTurns(), engine = mockEngine(turns)
  const out = await turns.run({ engine, slot: 's', parentThreadId: 'parent', text: 'write it', parentEphemeral: false, fresh: FRESH })
  assert.deepEqual(out, { text: out.text, via: 'fork', model: null, effort: 'low', source: null }); assert.match(out.text, /^answer to: /)
  assert.deepEqual(kinds(engine), ['fork', 'turn', 'release'])
  assert.deepEqual(engine.calls[0][1], { threadId: 'parent', excludeTurns: true, ephemeral: true })
  assert.equal(engine.calls[1][1].input[0].text, 'write it', 'no preamble on a fork: it has the history')
  assert.equal('effort' in engine.calls[1][1], false)
})

test('an ephemeral parent is never forked: a fresh ephemeral thread with the pure-engine overrides, the preamble, outputSchema and effort', async () => {
  const turns = createInternalTurns(), engine = mockEngine(turns), schema = { type: 'object', properties: { a: { type: 'string' } } }
  const out = await turns.run({ engine, slot: 's', parentThreadId: 'parent', text: 'Design the board', parentEphemeral: true, fresh: FRESH, outputSchema: schema })
  assert.equal(out.via, 'fresh'); assert.match(out.text, /^answer to: /, 'only the final answer is read, not the commentary')
  assert.deepEqual(kinds(engine), ['start', 'turn', 'release'], 'no fork was even tried')
  const start = engine.calls[0][1]
  assert.equal(start.ephemeral, true); assert.equal(start.sandbox, 'read-only'); assert.equal(start.approvalPolicy, 'never'); assert.equal(start.cwd, '/engine/empty'); assert.equal(start.model, 'm1')
  assert.equal(start.config.features.shell_tool, false); assert.equal(start.developerInstructions, INTERNAL_INSTRUCTIONS); assert.match(INTERNAL_INSTRUCTIONS, /private one-off task/)
  assert.equal('dynamicTools' in start, false, 'an internal thread has no tools')
  const turn = engine.calls[1][1]
  assert.equal(turn.threadId, 'fresh-1'); assert.equal(turn.input[0].text, `${FRESH.preamble}\n\nDesign the board`); assert.deepEqual(turn.outputSchema, schema, 'outputSchema passes unchanged'); assert.equal(turn.effort, 'low')
  assert.equal(engine.calls[2][1], 'fresh-1', 'the fresh thread is released')
})

test('a fork refused with "no rollout found" falls back to the fresh thread; any other fork failure does not', async () => {
  assert.equal(NO_ROLLOUT.test('no rollout found for thread id abc'), true); assert.equal(NO_ROLLOUT.test('thread not found'), false)
  const turns = createInternalTurns(), engine = mockEngine(turns, { refuseFork: true })
  const out = await turns.run({ engine, slot: 's', parentThreadId: 'parent', text: 'revise', parentEphemeral: false, fresh: FRESH })
  assert.equal(out.via, 'fresh'); assert.deepEqual(kinds(engine), ['fork', 'start', 'turn', 'release'])
  const other = createInternalTurns(), failing = mockEngine(other, { forkError: Object.assign(new Error('engine is busy'), { code: -32000 }) })
  await assert.rejects(other.run({ engine: failing, slot: 's', parentThreadId: 'parent', text: 'x', fresh: FRESH }), /engine is busy/)
  assert.deepEqual(kinds(failing), ['fork'], 'no fresh thread for an unrelated failure')
})

test('without `fresh` nothing changes: an ephemeral parent still forks, a refused fork still fails', async () => {
  const turns = createInternalTurns(), engine = mockEngine(turns, { refuseFork: true })
  await assert.rejects(turns.run({ engine, slot: 's', parentThreadId: 'parent', text: 'x', parentEphemeral: true }), /no rollout found/)
  assert.deepEqual(kinds(engine), ['fork'])
})

test('a fresh thread the engine reports as saved is not used and is released; an engine without startThread is unsupported; a hung start is bounded', async () => {
  const turns = createInternalTurns(), saved = mockEngine(turns, { startedEphemeral: false })
  await assert.rejects(turns.run({ engine: saved, slot: 's', parentThreadId: 'p', text: 'x', parentEphemeral: true, fresh: FRESH }), { code: 'INTERNAL_TURN_FAILED' })
  assert.deepEqual(kinds(saved), ['start', 'release'], 'never a turn on a saved thread')
  const noStart = mockEngine(turns); delete noStart.startThread
  await assert.rejects(turns.run({ engine: noStart, slot: 's', parentThreadId: 'p', text: 'x', parentEphemeral: true, fresh: FRESH }), { code: 'INTERNAL_TURN_UNSUPPORTED' })
  const hung = mockEngine(turns, { hang: 'start' })
  await assert.rejects(turns.run({ engine: hung, slot: 's', parentThreadId: 'p', text: 'x', parentEphemeral: true, fresh: FRESH, timeoutMs: 40 }), { code: 'INTERNAL_TURN_TIMEOUT' })
  assert.equal(turns.has('fresh-1'), false)
})

test('the fresh thread is declined like a fork: its tool and approval requests are refused, and it is no run of the chat', async () => {
  const turns = createInternalTurns(), seen = []
  const engine = mockEngine(turns)
  const original = engine.startTurn
  engine.startTurn = async (params, slot) => { seen.push([turns.has(params.threadId), turns.declines({ params: { threadId: params.threadId } }), turns.feed({ method: 'x', params: { threadId: 'other' } })]); return original(params, slot) }
  await turns.run({ engine, slot: 's', parentThreadId: 'p', text: 'x', parentEphemeral: true, fresh: FRESH })
  assert.deepEqual(seen, [[true, true, false]])
  assert.equal(turns.has('fresh-1'), false, 'forgotten when done')
})

// ---- the runtime's three callers (heartbeat writer, draft revision, briefing fill) ride on it ----
function runtimeOn(t, { refuseFork = true, profile = () => ({ model: 'egdesk-model', effort: 'low' }) } = {}) {
  const base = fs.realpathSync(createPrivateQaTempDirectory('egdesk-internal-turn-'))
  t.after(() => fs.rmSync(base, { recursive: true, force: true }))
  const real = path.join(base, 'project'), empty = path.join(base, 'engine-folder'); fs.mkdirSync(real); fs.mkdirSync(empty)
  const calls = []
  let chat = null, threads = 0, turnCount = 0
  const request = async (method, params) => {
    calls.push([method, structuredClone(params)])
    if (method === 'thread/start') return { thread: { id: `thr-${++threads}`, ephemeral: params.ephemeral === true }, cwd: params.cwd, model: params.model ?? 'engine-default-model' }
    if (method === 'thread/fork') { if (refuseFork && calls.some(c => c[0] === 'thread/start' && c[1].ephemeral === true && params.threadId === 'thr-1')) throw refusal(params.threadId); return { thread: { id: `fork-${++threads}` } } }
    if (method === 'turn/start') {
      const id = `turn-${++turnCount}`, threadId = params.threadId
      if (!threadId.startsWith('thr-1')) setImmediate(async () => {
        await chat.handleNotification({ method: 'item/completed', params: { threadId, turnId: id, item: { type: 'agentMessage', phase: 'final_answer', text: `internal answer for ${threadId}` } } })
        await chat.handleNotification({ method: 'turn/completed', params: { threadId, turn: { id, status: 'completed', items: [] } } })
      })
      return { turn: { id, status: 'inProgress', items: [] } }
    }
    if (method === 'mcpServerStatus/list') return { data: [{ name: 'my-notes', tools: { a: {} }, resources: [], resourceTemplates: [] }], nextCursor: null }
    if (method === 'config/read') return { config: {}, layers: [{ name: { type: 'user' }, config: { mcp_servers: { 'my-notes': { command: 'x' } } } }] }
    return {}
  }
  const store = openChatStore({ dataDir: path.join(base, 'chat'), ownerScope: 'internal-turn' })
  t.after(() => { try { store.close() } catch {} })
  chat = new CodexChatRuntime({ request, respond: () => {}, emit: () => {}, emitLegacy: () => {}, verifyFile: async () => null, store, requireStore: true, getOwnerKey: () => 'codex:internal-turn-test', decisionContext: { mode: () => 'off', configured: () => false, client: null },
    ownTools: { mode: () => 'on', neutralFolder: () => empty, profile } })
  chat.setConnection(true)
  return { chat, calls, real, empty, of: m => calls.filter(([x]) => x === m).map(([, p]) => p) }
}

test('the runtime: an ephemeral room\'s internal text (the briefing fill\'s path) runs on a fresh thread; nothing was forked; the overrides are the pure ones', async t => {
  const w = runtimeOn(t)
  const run = w.chat.runFor(await w.chat.send({ message: 'Summarise the quote please', clientThreadId: 'ui', requestId: 'r1', cwd: w.real, stateless: true }))
  const text = await w.chat.internalText(run, 'DESIGN GUIDE', { timeoutMs: 3000, outputSchema: { type: 'object' } })
  assert.equal(text, 'internal answer for thr-2')
  assert.equal(w.of('thread/fork').length, 0, 'an ephemeral source is never forked')
  // the room's thread start already read the person's MCP inventory (1-2 s on the real 0.171): the first internal thread reuses it, it does not read it again
  assert.equal(w.of('config/read').length, 1); assert.equal(w.calls.filter(([m]) => m === 'mcpServerStatus/list').length, 1)
  const [, fresh] = w.of('thread/start')
  assert.equal(fresh.ephemeral, true); assert.equal(fresh.sandbox, 'read-only'); assert.equal(fresh.approvalPolicy, 'never'); assert.equal(fresh.cwd, w.empty, 'the parent\'s engine folder, never the real one')
  assert.equal(fresh.config.features.shell_tool, false); assert.equal(fresh.config.features.hooks, false); assert.deepEqual(fresh.config.mcp_servers, { 'my-notes': { enabled: false } })
  assert.equal(fresh.model, 'egdesk-model', 'the parent thread\'s model'); assert.match(fresh.developerInstructions, /private one-off task/); assert.equal('dynamicTools' in fresh, false)
  assert.doesNotMatch(JSON.stringify(w.calls), new RegExp(w.real.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&')), 'the real folder never reaches the engine')
  const turn = w.of('turn/start').at(-1)
  assert.equal(turn.threadId, 'thr-2'); assert.match(turn.input[0].text, /^Context: the person's last message to you was "Summarise the quote please"\.\n\nDESIGN GUIDE$/); assert.deepEqual(turn.outputSchema, { type: 'object' })
  // a second internal turn of the same room reuses the overrides (no new inventory reads)
  const reads = () => w.calls.filter(([m]) => m === 'config/read').length
  const before = reads()
  assert.equal(await w.chat.internalText(run, 'AGAIN', { timeoutMs: 3000 }), 'internal answer for thr-3')
  assert.equal(reads(), before, 'cached per conversation')
})

test('the runtime: the draft revision and the heartbeat writer take the same path; a persisted room still forks', async t => {
  const w = runtimeOn(t)
  const run = w.chat.runFor(await w.chat.send({ message: 'Fix the readme', clientThreadId: 'ui', requestId: 'r1', cwd: w.real, stateless: true }))
  assert.equal(await w.chat.reviseOnFork(run, 'my draft', 'be shorter'), 'internal answer for thr-2')
  assert.match(w.of('turn/start').at(-1).input[0].text, /Here is your draft answer[\s\S]*my draft[\s\S]*be shorter/); assert.match(w.of('turn/start').at(-1).input[0].text, /^Context: the person's last message to you was "Fix the readme"/)
  assert.equal(w.of('thread/fork').length, 0)
  // a persisted room: the fork is tried and works (the fork id is not thr-1, the refusal rule does not apply)
  const keep = runtimeOn(t, { refuseFork: false })
  const kept = keep.chat.runFor(await keep.chat.send({ message: 'Fix the readme', clientThreadId: 'ui', requestId: 'r1', cwd: keep.real }))
  assert.equal(await keep.chat.internalText(kept, 'x', { timeoutMs: 3000 }), 'internal answer for fork-2')
  assert.equal(keep.of('thread/fork').length, 1); assert.equal(keep.of('thread/start').length, 1, 'only the room\'s own thread')
})

test('the runtime: preamble: false sends the caller\'s text and nothing else (the briefing fill is guide and materials only)', async t => {
  const w = runtimeOn(t)
  const run = w.chat.runFor(await w.chat.send({ message: 'Secret person text', clientThreadId: 'ui', requestId: 'r1', cwd: w.real, stateless: true }))
  assert.equal(await w.chat.internalText(run, 'GUIDE ONLY', { timeoutMs: 3000, preamble: false }), 'internal answer for thr-2')
  assert.equal(w.of('turn/start').at(-1).input[0].text, 'GUIDE ONLY')
  assert.doesNotMatch(JSON.stringify(w.of('turn/start').at(-1)), /Secret person text/)
  assert.match((await (async () => { await w.chat.internalText(run, 'DEFAULT', { timeoutMs: 3000 }); return w.of('turn/start').at(-1).input[0].text })()), /Secret person text[\s\S]*DEFAULT/, 'the default keeps the preamble for the other callers')
})

// ---- posted answers: engine-folder paths become the real folder's ----
test('own-tools posted answers link the real file, not the engine\'s empty folder; artifacts verify the real path; other runs and other paths are untouched', async t => {
  const base = fs.realpathSync(createPrivateQaTempDirectory('egdesk-own-links-'))
  t.after(() => fs.rmSync(base, { recursive: true, force: true }))
  const real = path.join(base, 'project'), empty = path.join(base, 'engine-folders', 'empty'), sibling = `${empty}-other`
  fs.mkdirSync(real); fs.mkdirSync(empty, { recursive: true }); fs.writeFileSync(path.join(real, 'app.js'), 'x')
  const verified = []
  const make = ownFlag => {
    const chat = new CodexChatRuntime({ request: async (m, p) => (m === 'thread/start' ? { thread: { id: 'thr-1' }, cwd: p.cwd } : m === 'turn/start' ? { turn: { id: 'turn-1', status: 'inProgress', items: [] } } : {}),
      respond: () => {}, emit: () => {}, emitLegacy: () => {}, verifyFile: async p => { verified.push(p); return p }, getOwnerKey: () => 'codex:links',
      ownTools: { mode: () => ownFlag, neutralFolder: () => empty } })
    chat.setConnection(true)
    return chat
  }
  const finalText = `Done. See [app.js](${empty}/app.js) and [the folder](<${empty}>), also ${empty}/sub/b.js, [x](${sibling}/y.js), [etc](/etc/hosts).`
  const answer = async (chat, run) => {
    await chat.handleNotification({ method: 'item/completed', params: { threadId: run.conversationId, turnId: run.runId, item: { id: 'm1', type: 'agentMessage', phase: 'final_answer', text: finalText } } })
    await chat.handleNotification({ method: 'turn/completed', params: { threadId: run.conversationId, turn: { id: run.runId, status: 'completed', items: [] } } })
    await chat.queue
    return chat.runFor(run)
  }
  const on = make('on'), run = await on.send({ message: 'edit', clientThreadId: 'ui', requestId: 'r1', cwd: real })
  const posted = (await answer(on, run)).messages.find(m => m.role === 'assistant').text
  assert.ok(posted.includes(`[app.js](${real}/app.js)`), posted)
  assert.ok(posted.includes(`[the folder](<${real}>)`)); assert.ok(posted.includes(`${real}/sub/b.js`))
  assert.ok(posted.includes(`[x](${sibling}/y.js)`), 'a sibling folder that merely starts with the same name is not mapped'); assert.ok(posted.includes('[etc](/etc/hosts)'))
  assert.equal(posted.includes(`${empty}/app.js`), false)
  assert.ok(verified.includes(path.join(real, 'app.js')), 'the artifact check opened the real file'); assert.equal(verified.includes(path.join(empty, 'app.js')), false)
  assert.ok(on.runFor(run).artifacts.some(a => a.target.path === path.join(real, 'app.js')), 'the artifact points at the real file')
  // without own tools (the engine works in the real folder itself) nothing is rewritten
  verified.length = 0
  const off = make('off'), plain = await off.send({ message: 'edit', clientThreadId: 'ui', requestId: 'r1', cwd: real })
  assert.ok((await answer(off, plain)).messages.find(m => m.role === 'assistant').text.includes(`${empty}/app.js`), 'not an own-tools run: untouched')
})

// ---- c25: the model and effort of internal turns (Main's check-9: briefing fill turns of 20-30 s at the engine's default, highest effort; forkTrace said null, null) ----
test('internal turns: the selection is sent on a fork only when it is an explicit pick; the result and onStart say what the turn ran with; a throwing observer changes nothing', async () => {
  const turns = createInternalTurns(), seen = []
  const engine = mockEngine(turns)
  const out = await turns.run({ engine, slot: 's', parentThreadId: 'parent', text: 'x', fresh: { ...FRESH, model: 'm-egdesk', effort: 'low', source: 'egdesk' }, onStart: v => { seen.push(v); throw new Error('observer bug') } })
  assert.deepEqual([out.via, out.model, out.effort, out.source], ['fork', 'm-egdesk', 'low', 'egdesk']); assert.deepEqual(seen, [{ via: 'fork', model: 'm-egdesk', effort: 'low', source: 'egdesk' }])
  assert.deepEqual([engine.calls[1][1].model, engine.calls[1][1].effort], ['m-egdesk', 'low'], 'a fork carries the explicit selection on its turn')
  const plain = mockEngine(turns), res = await turns.run({ engine: plain, slot: 's', parentThreadId: 'parent', text: 'x', fresh: { ...FRESH, model: 'm-thread', effort: 'xhigh', source: 'engine' } })
  assert.deepEqual([res.model, res.effort, res.source], ['m-thread', 'xhigh', 'engine'], 'recorded')
  assert.equal('model' in plain.calls[1][1] || 'effort' in plain.calls[1][1], false, 'a fork with no explicit pick inherits the thread\'s: nothing sent')
  const fresh = mockEngine(turns), r3 = await turns.run({ engine: fresh, slot: 's', parentThreadId: 'parent', text: 'x', parentEphemeral: true, fresh: { ...FRESH, model: 'm-thread', effort: 'xhigh', source: 'engine' } })
  assert.deepEqual([r3.via, fresh.calls[1][1].model, fresh.calls[1][1].effort], ['fresh', 'm-thread', 'xhigh'], 'a fresh thread always sends what it runs with')
})

test('the runtime: internal turns run with EG-Desk\'s own model and effort; the room\'s own pick wins; an explicit option wins over both; unknown words are ignored; what ran is reported', async t => {
  const w = runtimeOn(t)
  const run = w.chat.runFor(await w.chat.send({ message: 'Summarise', clientThreadId: 'ui', requestId: 'r1', cwd: w.real, stateless: true }))
  const started = []
  assert.equal(await w.chat.internalText(run, 'FILL', { timeoutMs: 3000, onStart: v => started.push(v) }), 'internal answer for thr-2')
  assert.equal(w.of('thread/start').at(-1).model, 'egdesk-model'); assert.equal(w.of('turn/start').at(-1).effort, 'low', 'the fresh thread\'s turn names EG-Desk\'s effort')
  assert.deepEqual(started, [{ via: 'fresh', model: 'egdesk-model', effort: 'low', source: 'egdesk' }])
  // explicit: the effort of the caller (the briefing fill), the model stays EG-Desk's; the cached isolation does not pin the model
  await w.chat.internalText(run, 'FILL', { timeoutMs: 3000, effort: 'minimal', onStart: v => started.push(v) })
  assert.equal(w.of('turn/start').at(-1).effort, 'minimal'); assert.equal(w.of('thread/start').at(-1).model, 'egdesk-model'); assert.deepEqual(started.at(-1), { via: 'fresh', model: 'egdesk-model', effort: 'minimal', source: 'explicit' })
  await w.chat.internalText(run, 'FILL', { timeoutMs: 3000, effort: 'high; rm -rf', model: 'not a model' })
  assert.equal(w.of('turn/start').at(-1).effort, 'low', 'an unusable word is ignored'); assert.equal(w.of('thread/start').at(-1).model, 'egdesk-model')
  await w.chat.internalText(run, 'FILL', { timeoutMs: 3000, model: 'caller-model' })
  assert.equal(w.of('thread/start').at(-1).model, 'caller-model'); assert.equal(w.of('turn/start').at(-1).effort, 'low')
  // the room's own pick (a request): it wins over EG-Desk's setting, for the fresh thread and for the draft revision
  const own = runtimeOn(t), picked = own.chat.runFor(await own.chat.send({ message: 'Summarise', clientThreadId: 'ui', requestId: 'r1', cwd: own.real, stateless: true, model: 'room-model', effort: 'high' }))
  await own.chat.internalText(picked, 'FILL', { timeoutMs: 3000 })
  assert.equal(own.of('thread/start').at(-1).model, 'room-model'); assert.equal(own.of('turn/start').at(-1).effort, 'high')
  assert.equal(await own.chat.reviseOnFork(picked, 'draft', 'shorter'), 'internal answer for thr-3'); assert.equal(own.of('turn/start').at(-1).effort, 'high')
})

test('the runtime: a persisted room\'s fork carries EG-Desk\'s effort and model on its turn; with no setting anywhere it inherits and the record says "engine"', async t => {
  const keep = runtimeOn(t, { refuseFork: false })
  const kept = keep.chat.runFor(await keep.chat.send({ message: 'Fix', clientThreadId: 'ui', requestId: 'r1', cwd: keep.real }))
  const started = []
  assert.equal(await keep.chat.internalText(kept, 'x', { timeoutMs: 3000, onStart: v => started.push(v) }), 'internal answer for fork-2')
  assert.deepEqual([keep.of('turn/start').at(-1).model, keep.of('turn/start').at(-1).effort], ['egdesk-model', 'low']); assert.deepEqual(started, [{ via: 'fork', model: 'egdesk-model', effort: 'low', source: 'egdesk' }])
  const none = runtimeOn(t, { refuseFork: false, profile: () => ({}) })
  const run = none.chat.runFor(await none.chat.send({ message: 'Fix', clientThreadId: 'ui', requestId: 'r1', cwd: none.real }))
  const seen = []
  assert.equal(await none.chat.internalText(run, 'x', { timeoutMs: 3000, onStart: v => seen.push(v) }), 'internal answer for fork-2')
  assert.equal(seen[0].source, 'engine'); assert.equal(seen[0].model, 'engine-default-model')
  assert.equal('model' in none.of('turn/start').at(-1) || 'effort' in none.of('turn/start').at(-1), false, 'nothing explicit: nothing sent')
})
