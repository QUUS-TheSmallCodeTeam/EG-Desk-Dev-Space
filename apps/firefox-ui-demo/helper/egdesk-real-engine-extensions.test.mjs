// c25: the extension API of the real-engine check (helper/egdesk-real-engine-extensions.mjs): a lane adds a script key, a conversation field and a per-turn hook by registering;
// the core files list none of the lanes' keys. This file registers a probe lane in its own process.
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { EXPECT_KEYS, REAL_ENGINE_SCRIPT_SCHEMA, checkTurnExpectations, validateEngineScript } from './egdesk-real-engine-script.mjs'
import { createTurnHooks, registerConversationFields, registerExpectKeys, registerTurnHooks, registeredConversationFields, registeredExpectKeys, registeredTurnHookNames } from './egdesk-real-engine-extensions.mjs'

const here = path.dirname(fileURLToPath(import.meta.url))
const turnEntry = REAL_ENGINE_SCRIPT_SCHEMA.properties.conversations.items.properties.turns.items.properties.expect.properties
const script = expect => ({ set: 'real-engine-ext-v1', conversations: [{ id: 'c', turns: [{ say: 'hi', expect }] }] })

test('the lanes\' keys are registered, not listed in the core: the same keys, schemas and validators as before the move', () => {
  assert.deepEqual(registeredExpectKeys(), ['memory', 'engine', 'briefing']); assert.deepEqual(registeredConversationFields(), ['memory']); assert.deepEqual(registeredTurnHookNames(), ['memory', 'journey'])
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
