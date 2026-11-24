// c25: the extension API of the real-engine check (helper/egdesk-real-engine-extensions.mjs): a lane adds a script key, a conversation field and a per-turn hook by registering;
// the core files list none of the lanes' keys. This file registers a probe lane in its own process.
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { EXPECT_KEYS, REAL_ENGINE_SCRIPT_SCHEMA, checkTurnExpectations, validateEngineScript } from './egdesk-real-engine-script.mjs'
import { createTurnHooks, registerConversationFields, registerExpectKeys, registerFlags, registerTurnFields, registerTurnHooks, registeredConversationFields, registeredDecisionFlags, registeredExpectKeys, registeredFlags, registeredTurnFields, registeredTurnHookNames } from './egdesk-real-engine-extensions.mjs'

const here = path.dirname(fileURLToPath(import.meta.url))
const turnEntry = REAL_ENGINE_SCRIPT_SCHEMA.properties.conversations.items.properties.turns.items.properties.expect.properties
const script = expect => ({ set: 'real-engine-ext-v1', conversations: [{ id: 'c', turns: [{ say: 'hi', expect }] }] })

test('the lanes\' keys are registered, not listed in the core: the same keys, schemas and validators as before the move', () => {
  // lanes add their own keys over time: the three moved ones (and the deletion proof, L5) are there, in this order among themselves; no key is registered twice
  const keys = registeredExpectKeys(), at = k => keys.indexOf(k); assert.ok(at('memory') >= 0 && at('memory') < at('engine') && at('engine') < at('briefing') && at('deleted') > at('briefing'), keys.join()); assert.equal(new Set(keys).size, keys.length)
  assert.ok(registeredConversationFields().includes('memory') && registeredConversationFields().includes('seededWrites')); assert.ok(registeredTurnHookNames().indexOf('memory') < registeredTurnHookNames().indexOf('journey')); assert.ok(registeredTurnFields().includes('from') && registeredTurnFields().includes('browserTask')); assert.ok(registeredExpectKeys().includes('browserAnswer') && registeredTurnHookNames().includes('browserAnswer')) // L8 c31
  for (const k of ['engine', 'memory', 'briefing']) { assert.ok(EXPECT_KEYS.includes(k)); assert.ok(turnEntry[k]) }
  const core = fs.readFileSync(path.join(here, 'egdesk-real-engine-script.mjs'), 'utf8') + fs.readFileSync(path.join(here, 'egdesk-real-engine-check.mjs'), 'utf8')
  for (const lane of ['egdesk-real-engine-memory.mjs', 'egdesk-real-engine-journey.mjs', 'egdesk-real-engine-briefing-hook.mjs']) assert.ok(!core.includes(`from './${lane}'`) || lane === 'egdesk-real-engine-memory.mjs', `${lane} is not imported by the core`)
  assert.equal(validateEngineScript(script({ engine: { steers: 1 } })).ok, true)
  assert.match(validateEngineScript(script({ briefing: { outcome: 'presented' } })).errors.join(), /EGDESK_BRIEFING_FLOW/)
  assert.match(validateEngineScript(script({ memory: { attached: ['x'] } })).errors.join(), /expect\.memory/)
})

test('registering: a key with a schema, a validator and a check; duplicates and malformed registrations are refused', () => {
  registerExpectKeys({ probeKey: { schema: { type: 'integer' }, validate: (v, { path, bad }) => { if (!(v >= 1)) bad(path, 'at least 1') }, check: (v, record) => [{ check: 'probeKey', ok: record.n === v, detail: { n: record.n ?? null } }] } })
  registerConversationFields({ probeField: { schema: { type: 'string' }, validate: (v, { path, bad }) => { if (v !== 'ok') bad(path, 'must be ok') } } })
  assert.throws(() => registerExpectKeys({ probeKey: { schema: {} } }), /already registered/); assert.throws(() => registerExpectKeys({ x: {} }), /needs a schema/)
  assert.throws(() => registerExpectKeys({ 'bad name': { schema: {} } }), /bad name/); assert.throws(() => registerExpectKeys({ y: { schema: {}, check: 3 } }), /must be a function/)
  assert.throws(() => registerTurnHooks('memory', () => ({})), /already registered/)
  // the key joins the validator (unknown keys are still refused), the evaluator and the converted core list of keys; the script's own conversation field too
  const bad = validateEngineScript(script({ probeKey: 0 })); assert.equal(bad.ok, false); assert.match(bad.errors.join(), /probeKey: at least 1|probeKey.*at least 1/)
  assert.equal(validateEngineScript(script({ probeKey: 2 })).ok, true); assert.match(validateEngineScript(script({ nopeKey: 2 })).errors.join(), /nopeKey/)
  assert.deepEqual(checkTurnExpectations({ probeKey: 2 }, { n: 2 }).map(c => c.ok), [true]); assert.deepEqual(checkTurnExpectations({ probeKey: 2 }, { n: 3 }).map(c => c.ok), [false])
  const conv = { set: 'real-engine-ext-v1', conversations: [{ id: 'c', probeField: 'no', turns: [{ say: 'hi' }] }] }
  assert.match(validateEngineScript(conv).errors.join(), /probeField: must be ok/); conv.conversations[0].probeField = 'ok'; assert.equal(validateEngineScript(conv).ok, true)
})

test('turn hooks: observe, beginTurn, inRun, finishTurn reach every registered hook; records go under the hook\'s name, expectations are collected, a missing member is skipped', () => {
  const seen = []
  registerTurnHooks('probeHook', conversation => ({ hook: { id: conversation.id }, observe: (m, p) => seen.push(['observe', m, p]), observeCommand: c => seen.push(['command', c]), beginTurn: ctx => seen.push(['begin', ctx.n]), inRun: ctx => seen.push(['inRun', ctx.text]),
    finishTurn: ctx => ({ record: { n: ctx.n }, expectations: [{ check: 'e1', ok: true }], nextExpectations: [{ check: 'n1', ok: true }] }) }))
  const state = () => ({ store: null, clientThreadId: null }), hooks = createTurnHooks({ id: 'conv-1', memory: undefined })
  assert.deepEqual(hooks.get('probeHook').hook, { id: 'conv-1' }); assert.equal(hooks.get('nope'), null)
  hooks.observe('turn/start', { a: 1 }); hooks.observeCommand('ls', {}); hooks.beginTurn({ n: 1, state }); hooks.inRun({ text: 'steer', state })
  const out = hooks.finishTurn({ n: 1, expect: {}, state })
  assert.deepEqual(seen, [['observe', 'turn/start', { a: 1 }], ['command', 'ls'], ['begin', 1], ['inRun', 'steer']])
  assert.deepEqual(out.records.probeHook, { n: 1 }); assert.equal(out.records.memory, undefined, 'a hook with nothing to record adds no field'); assert.equal(out.records.journey, undefined)
  assert.deepEqual(out.expectations, [{ check: 'e1', ok: true }]); assert.deepEqual(out.nextExpectations, [{ check: 'n1', ok: true }])
})

// c27: what the collaboration lane needed and the API lacked: a turn's own field, the flags a lane's feature reproduces, and the hook members that need the live runtime
test('registering a turn field: its schema joins the script schema, its validator sees the turn, unknown turn keys are still refused; duplicates and malformed ones are refused', () => {
  registerTurnFields({ probeTurnField: { schema: { enum: ['a', 'b'] }, validate: (v, { turn, path, bad }) => { if (v === 'b' && turn.say === 'no') bad(path, 'b is not allowed with this say') } } })
  assert.ok(registeredTurnFields().includes('probeTurnField'))
  assert.throws(() => registerTurnFields({ probeTurnField: { schema: {} } }), /already registered/); assert.throws(() => registerTurnFields({ z: {} }), /needs a schema/); assert.throws(() => registerTurnFields({ 'bad name': { schema: {} } }), /bad name/)
  assert.deepEqual(REAL_ENGINE_SCRIPT_SCHEMA.properties.conversations.items.properties.turns.items.properties.from, { enum: ['owner', 'invited'] }, 'the lanes\' own turn field is in the schema (a field registered after load is validated, like a key)')
  const turn = t => ({ set: 'real-engine-ext-v1', conversations: [{ id: 'c', turns: [t] }] })
  assert.equal(validateEngineScript(turn({ say: 'hi', probeTurnField: 'a' })).ok, true)
  assert.match(validateEngineScript(turn({ say: 'no', probeTurnField: 'b' })).errors.join(), /probeTurnField: b is not allowed/)
  assert.match(validateEngineScript(turn({ say: 'hi', nopeField: 'a' })).errors.join(), /nopeField/)
})

test('registering flags: reproduced and decision-dependent flag names are listed for the check; duplicates and malformed names are refused', () => {
  assert.ok(registeredFlags().includes('EGDESK_PRESENCE') && registeredFlags().includes('EGDESK_WORK_PLACEMENT')); assert.deepEqual(registeredDecisionFlags(), ['EGDESK_WORK_PLACEMENT'])
  registerFlags({ reproduced: ['EGDESK_PROBE_FLAG'], decisionDependent: ['EGDESK_PROBE_DECISION'] })
  assert.ok(registeredFlags().includes('EGDESK_PROBE_FLAG')); assert.ok(registeredDecisionFlags().includes('EGDESK_PROBE_DECISION'))
  assert.throws(() => registerFlags({ reproduced: ['EGDESK_PROBE_FLAG'] }), /already registered/); assert.throws(() => registerFlags({ reproduced: ['probe'] }), /bad flag name/); assert.throws(() => registerFlags({ reproduced: 'EGDESK_X' }), /must be a list/)
  assert.equal(registeredFlags().includes('EGDESK_PROBE_FLAG'), true, 'a refused registration changes nothing')
})

test('turn hooks that need the live runtime: flowOptions merge, attach once with the deps, beforeSend and afterTurn are awaited in order, afterTurn\'s record and expectations are collected, dispose never throws', async () => {
  const order = []
  registerTurnHooks('probeLive', () => ({
    flowOptions: ({ FLAG }) => (FLAG.ON ? { probeKey: 1 } : {}), attach: deps => order.push(['attach', deps.chat]),
    beforeSend: async ctx => { await new Promise(r => setTimeout(r, 5)); order.push(['before', ctx.index, ctx.state().conversationId]) },
    afterTurn: async ctx => { await new Promise(r => setTimeout(r, 5)); order.push(['after', ctx.turnIndex]); return ctx.expect?.p === undefined ? null : { record: { saw: ctx.expect.p }, expectations: [{ check: 'live.p', ok: true }] } },
    dispose: () => { order.push(['dispose']); throw new Error('a hook\'s cleanup failing must not stop the check') } }))
  const hooks = createTurnHooks({ id: 'conv-2' }), state = () => ({ store: null, clientThreadId: 't', conversationId: 'native-1' })
  assert.deepEqual(hooks.flowOptions({ FLAG: { ON: true } }), { probeKey: 1 }); assert.deepEqual(hooks.flowOptions({ FLAG: {} }), {})
  hooks.attach({ chat: 'the-chat' })
  await hooks.beforeSend({ index: 0, state })
  assert.deepEqual(await hooks.afterTurn({ turnIndex: 1, expect: { p: 5 }, state }), { records: { probeLive: { saw: 5 } }, expectations: [{ check: 'live.p', ok: true }] })
  assert.deepEqual(await hooks.afterTurn({ turnIndex: 2, expect: {}, state }), { records: {}, expectations: [] }, 'a hook with nothing to say adds nothing')
  hooks.dispose()
  assert.deepEqual(order, [['attach', 'the-chat'], ['before', 0, 'native-1'], ['after', 1], ['after', 2], ['dispose']])
})

// c29: around a restart action (the bridge and the engine stopped and started again between two turns): the old hook hands something to its successor, the new one reports on the restart turn
test('turn hooks around a restart: beforeRestart\'s result is handed to the same hook\'s successor under its name; afterRestart\'s record and expectations are collected; a hook without them is skipped', async () => {
  const seen = []
  registerTurnHooks('probeRestart', () => ({
    beforeRestart: async ctx => { seen.push(['before', ctx.state().clientThreadId]); return { room: 'r1', n: 2 } },
    afterRestart: async ctx => { seen.push(['after', ctx.carried, ctx.expect?.k]); return { record: { carried: ctx.carried }, expectations: [{ check: 'restart.probe', ok: ctx.carried?.n === 2 }] } } }))
  const state = () => ({ store: null, clientThreadId: 'room-9', conversationId: 'native-9' })
  const old = createTurnHooks({ id: 'old' }), carried = await old.beforeRestart({ state })
  assert.deepEqual(carried.probeRestart, { room: 'r1', n: 2 }); assert.equal(carried.memory, undefined, 'a hook with nothing to carry hands over nothing')
  const fresh = createTurnHooks({ id: 'new' }), out = await fresh.afterRestart({ state, expect: { k: 1 }, carried })
  assert.deepEqual(out.records, { probeRestart: { carried: { room: 'r1', n: 2 } } }); assert.deepEqual(out.expectations, [{ check: 'restart.probe', ok: true }])
  assert.deepEqual(seen, [['before', 'room-9'], ['after', { room: 'r1', n: 2 }, 1]])
  assert.deepEqual(await fresh.afterRestart({ state, carried: {} }), { records: { probeRestart: { carried: undefined } }, expectations: [{ check: 'restart.probe', ok: false }] }, 'nothing carried: the successor sees undefined')
})
