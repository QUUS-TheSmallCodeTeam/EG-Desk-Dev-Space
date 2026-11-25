// c25: the extension API of the real-engine check (helper/egdesk-real-engine-extensions.mjs): a lane adds a script key, a conversation field and a per-turn hook by registering;
// the core files list none of the lanes' keys. This file registers a probe lane in its own process.
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { EXPECT_KEYS, REAL_ENGINE_SCRIPT_SCHEMA, checkTurnExpectations, validateEngineScript } from './egdesk-real-engine-script.mjs'
import { SCHEMA_FILE, renderSchemaFile } from './egdesk-real-engine-schema-file.mjs'
import { createTurnHooks, registerConversationFields, registerExpectKeys, registerFlags, registerTurnFields, registerTurnHooks, registeredConversationFields, registeredDecisionFlags, registeredExpectKeys, registeredFlags, registeredTurnFields, registeredTurnHookNames } from './egdesk-real-engine-extensions.mjs'

const here = path.dirname(fileURLToPath(import.meta.url))
const turnEntry = REAL_ENGINE_SCRIPT_SCHEMA.properties.conversations.items.properties.turns.items.properties.expect.properties
const script0 = expect => ({ set: 'real-engine-ext-v1', conversations: [{ id: 'c', turns: [{ say: 'hi', expect }] }] })

// What each lane registers (per-lane invariants; a lane's line is the only thing to touch when it registers more). No exact global list: another lane's keys never break this test.
// `before` pairs are the only ordering rules that matter (c25: the records and expectations of memory come before journey's, byte-identical to before the move).
const LANES = {
  L1: { expectKeys: ['collab'], turnFields: ['from'], turnHooks: ['collab'] },
  L3: { expectKeys: ['flow'], turnHooks: ['flow'] },
  L2: { expectKeys: ['engine'], turnHooks: ['journey'] },
  L4: { expectKeys: ['briefing'] },
  L5: { expectKeys: ['deleted', 'coding'], conversationFields: ['seededWrites'], turnHooks: ['coding'] },
  L8: { expectKeys: ['browserAnswer'], turnFields: ['browserTask'], turnHooks: ['browserAnswer'] },
  L7: { expectKeys: ['memory'], conversationFields: ['memory'], turnHooks: ['memory'] },
}
const BEFORE = { turnHooks: [['memory', 'journey']] }
const registered = { expectKeys: registeredExpectKeys, conversationFields: registeredConversationFields, turnFields: registeredTurnFields, turnHooks: registeredTurnHookNames }

test('registrations: every lane\'s keys are registered, once, with a schema in the generated script schema; the core lists none of them', () => {
  for (const [lane, wanted] of Object.entries(LANES)) for (const [kind, names] of Object.entries(wanted)) for (const name of names) assert.ok(registered[kind]().includes(name), `${lane}: ${kind} ${name} is registered`)
  for (const [kind, list] of Object.entries(registered)) { const names = list(); assert.equal(new Set(names).size, names.length, `${kind}: no name twice`) }
  for (const [kind, pairs] of Object.entries(BEFORE)) for (const [first, second] of pairs) assert.ok(registered[kind]().indexOf(first) < registered[kind]().indexOf(second), `${kind}: ${first} before ${second}`)
  const conversationProps = REAL_ENGINE_SCRIPT_SCHEMA.properties.conversations.items.properties, turnProps = conversationProps.turns.items.properties
  for (const name of registeredExpectKeys()) { assert.ok(EXPECT_KEYS.includes(name), `${name} is an accepted expect key`); assert.ok(turnEntry[name], `${name} has its schema in expect`) }
  for (const name of registeredConversationFields()) assert.ok(conversationProps[name], `${name} has its schema on the conversation`)
  for (const name of registeredTurnFields()) assert.ok(turnProps[name], `${name} has its schema on the turn`)
  // the core files do not list a lane's key as their own: every registered expect key's name appears in the core only inside registry calls, never as an own EXPECT_KEYS literal
  const script = fs.readFileSync(path.join(here, 'egdesk-real-engine-script.mjs'), 'utf8'), literal = script.match(/export const EXPECT_KEYS = Object\.freeze\(\[([^\]]*)\.\.\.registeredExpectKeys\(\)\]\)/)
  assert.ok(literal, 'EXPECT_KEYS is the core list plus the registered keys')
  for (const name of registeredExpectKeys()) assert.ok(!literal[1].includes(`'${name}'`), `the core list has no literal ${name}`)
  assert.equal(validateEngineScript(script0({ engine: { steers: 1 } })).ok, true)
  assert.match(validateEngineScript(script0({ briefing: { outcome: 'presented' } })).errors.join(), /EGDESK_BRIEFING_FLOW/)
  assert.match(validateEngineScript(script0({ memory: { attached: ['x'] } })).errors.join(), /expect\.memory/)
})

test('the schema file is a pure function of the registrations: regenerated text equals the committed text (after a merge conflict, run node scripts/real-engine/regenerate-schema.mjs)', () => {
  const file = path.join(here, '..', SCHEMA_FILE), committed = fs.readFileSync(file, 'utf8'), fresh = renderSchemaFile(REAL_ENGINE_SCRIPT_SCHEMA)
  assert.equal(committed, fresh, 'real-engine-script.schema.json is stale or hand-edited: run node scripts/real-engine/regenerate-schema.mjs')
  assert.doesNotMatch(committed, /^(<<<<<<<|=======|>>>>>>>)/m, 'no conflict markers')
  assert.equal(fresh, renderSchemaFile(JSON.parse(fresh)), 'rendering is stable (a fixed point)')
  const o = { b: 1, a: { d: [3, 1], c: 2 } }; assert.equal(renderSchemaFile(o), '{\n  "a": {\n    "c": 2,\n    "d": [\n      3,\n      1\n    ]\n  },\n  "b": 1\n}\n', 'keys are sorted, arrays keep their order')
})

test('registering: a key with a schema, a validator and a check; duplicates and malformed registrations are refused', () => {
  registerExpectKeys({ probeKey: { schema: { type: 'integer' }, validate: (v, { path, bad }) => { if (!(v >= 1)) bad(path, 'at least 1') }, check: (v, record) => [{ check: 'probeKey', ok: record.n === v, detail: { n: record.n ?? null } }] } })
  registerConversationFields({ probeField: { schema: { type: 'string' }, validate: (v, { path, bad }) => { if (v !== 'ok') bad(path, 'must be ok') } } })
  assert.throws(() => registerExpectKeys({ probeKey: { schema: {} } }), /already registered/); assert.throws(() => registerExpectKeys({ x: {} }), /needs a schema/)
  assert.throws(() => registerExpectKeys({ 'bad name': { schema: {} } }), /bad name/); assert.throws(() => registerExpectKeys({ y: { schema: {}, check: 3 } }), /must be a function/)
  assert.throws(() => registerTurnHooks('memory', () => ({})), /already registered/)
  // the key joins the validator (unknown keys are still refused), the evaluator and the converted core list of keys; the script's own conversation field too
  const bad = validateEngineScript(script0({ probeKey: 0 })); assert.equal(bad.ok, false); assert.match(bad.errors.join(), /probeKey: at least 1|probeKey.*at least 1/)
  assert.equal(validateEngineScript(script0({ probeKey: 2 })).ok, true); assert.match(validateEngineScript(script0({ nopeKey: 2 })).errors.join(), /nopeKey/)
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
