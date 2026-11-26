// u1: the '위' bundle (EGDESK_UPPER=on), U9 (mode 끔 sends nothing, at one place), the order of a turn, and the product key path. No network, no real key, no Codex.
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { HUD_ROUTING_CAPABILITIES, NOT_IN_BUNDLE, TURN_STAGES, UPPER_BUNDLE, hudRoutingCapability, applyUpperBundle, describeUpperBundle, markStage, modeGatedClient, stagesOf, upperBundleFlags } from './egdesk-upper-bundle.mjs'
import { CodexChatRuntime } from './codex-chat-runtime.mjs'
import { createDecisionClient } from './egdesk-decision-client.mjs'
import { openCalibrationLog } from './egdesk-decision-calibration-log.mjs'
import { DECISION_CREDENTIAL_FILE } from './egdesk-decision-credential.mjs'
import { createPrivateQaTempDirectory } from '../scripts/egdesk-qa-platform.mjs'

const here = path.dirname(fileURLToPath(import.meta.url))
const read = file => fs.readFileSync(path.join(here, file), 'utf8')
const NAMES = UPPER_BUNDLE.map(row => row.flag)

test('bundle off by default: without EGDESK_UPPER=on (unset, off, anything else) nothing is filled and the input is not touched', () => {
  for (const value of [undefined, 'off', 'advisory', '1', '']) {
    const env = value === undefined ? {} : { EGDESK_UPPER: value }, before = JSON.stringify(env), out = upperBundleFlags(env)
    assert.deepEqual([out.on, out.applied, out.kept], [false, [], []]); assert.equal(JSON.stringify(env), before); assert.deepEqual(applyUpperBundle(env), { on: false, applied: [], kept: [] }); assert.equal(JSON.stringify(env), before)
  }
  assert.deepEqual(upperBundleFlags(null).flags, {}); assert.equal(describeUpperBundle({ on: false, applied: [], kept: [] }), 'EGDESK_UPPER off')
})

test('bundle on: every flag of the bundle is filled with its value; the input of the pure function is not changed, applyUpperBundle sets them into the env', () => {
  const input = { EGDESK_UPPER: 'on', UNRELATED: 'x' }, out = upperBundleFlags(input)
  assert.deepEqual(Object.keys(input).sort(), ['EGDESK_UPPER', 'UNRELATED']); assert.deepEqual(out.applied, NAMES); assert.deepEqual(out.kept, [])
  for (const row of UPPER_BUNDLE) assert.equal(out.flags[row.flag], row.value, row.flag)
  assert.equal(out.flags.UNRELATED, 'x')
  const env = { EGDESK_UPPER: 'on' }, applied = applyUpperBundle(env)
  assert.equal(applied.applied.length, NAMES.length); for (const row of UPPER_BUNDLE) assert.equal(env[row.flag], row.value)
  assert.equal(describeUpperBundle(applied), `EGDESK_UPPER=on: ${NAMES.length} flags set, 0 kept (explicitly set)`)
  // a1: the count comes from the list (a lane that adds or removes a row does not edit a number here); every row is counted once, by its role
  const byRole = UPPER_BUNDLE.reduce((counts, row) => ({ ...counts, [row.role]: (counts[row.role] ?? 0) + 1 }), {})
  assert.equal(Object.values(byRole).reduce((sum, n) => sum + n, 0), UPPER_BUNDLE.length); assert.equal(NAMES.length, UPPER_BUNDLE.length); assert.ok(UPPER_BUNDLE.length > 0)
})

test('any single flag stays overridable: an explicit value (including off, none, advisory, empty is NOT explicit) wins over the bundle, the rest are filled', () => {
  const out = upperBundleFlags({ EGDESK_UPPER: 'on', EGDESK_DRAFT_CHECK: 'advisory', EGDESK_DECISION_FIRST: 'off', EGDESK_TURN_MEMORY_PREFETCH: 'none', EGDESK_PROPOSAL_REGISTRY: '' })
  assert.deepEqual(out.kept.sort(), ['EGDESK_DECISION_FIRST', 'EGDESK_DRAFT_CHECK', 'EGDESK_TURN_MEMORY_PREFETCH'])
  assert.deepEqual([out.flags.EGDESK_DRAFT_CHECK, out.flags.EGDESK_DECISION_FIRST, out.flags.EGDESK_TURN_MEMORY_PREFETCH, out.flags.EGDESK_PROPOSAL_REGISTRY], ['advisory', 'off', 'none', 'on'])
  assert.equal(out.applied.length, NAMES.length - 3)
})

test('bundle contents are consistent: each flag is read by product code, requires point inside the bundle, the excluded list is disjoint and every dormant flag names its feature', () => {
  const product = ['codex-bridge-server.mjs', 'egdesk-own-tools-wiring.mjs', 'egdesk-turn-memory-wiring.mjs', 'egdesk-prefetch.mjs', 'egdesk-decision-first-approvals.mjs', 'egdesk-open-items.mjs', 'egdesk-open-proposals.mjs', 'codex-chat-runtime.mjs'].map(read).join('\n')
  for (const row of UPPER_BUNDLE) { assert.ok(row.lands || product.includes(row.flag), `${row.flag} is read by product code (or its lane has not merged: lands)`); assert.ok(['prerequisite', 'turn', 'tool', 'surface', 'dormant'].includes(row.role)); assert.ok(row.why.length > 20, row.flag) }
  for (const row of UPPER_BUNDLE) for (const need of row.requires ?? []) assert.ok(NAMES.includes(need), `${row.flag} requires ${need}`)
  for (const flag of Object.keys(NOT_IN_BUNDLE)) assert.ok(!NAMES.includes(flag), `${flag} is excluded and not in the bundle`)
  assert.equal(new Set(NAMES).size, NAMES.length); assert.ok(!NAMES.includes('EGDESK_UPPER'))
  for (const row of UPPER_BUNDLE.filter(r => r.role === 'dormant')) assert.match(row.why, /EGDESK_CONVERSATION_FLOW/)
  for (const flag of ['EGDESK_CONVERSATION_FLOW', 'EGDESK_INRUN_MESSAGES', 'EGDESK_CHAT_CHOICE']) assert.ok(NOT_IN_BUNDLE[flag], flag)
})

test('modeGatedClient (U9): mode 끔 and a missing key send nothing, advisory and on pass through, the rest of the client (model, verifyKey) stays usable with the mode off', async () => {
  const calls = []
  const client = { model: 'gpt-6-luna', async decide(request) { calls.push(request); return { answers: [] } }, async verifyKey(key) { return { status: 'ok', key } } }
  for (const [mode, saved, sent] of [['off', true, false], ['off', false, false], ['advisory', false, false], ['on', false, false], [undefined, true, false], ['bogus', true, false], ['advisory', true, true], ['on', true, true]]) {
    calls.length = 0
    const gated = modeGatedClient(client, { mode: () => mode, configured: () => saved })
    const result = await gated.decide({ q: 1 }).then(() => 'sent', error => error.code)
    assert.equal(calls.length, sent ? 1 : 0, `${mode}/${saved}`); assert.equal(result, sent ? 'sent' : (mode === 'off' || mode === undefined || mode === 'bogus' ? 'decision_mode_off' : 'decision_not_configured'), `${mode}/${saved}`)
  }
  const off = modeGatedClient(client, { mode: () => 'off', configured: () => true })
  assert.equal(off.model, 'gpt-6-luna'); assert.deepEqual(await off.verifyKey('k'), { status: 'ok', key: 'k' }, 'the settings key check does not go through the gate')
  assert.equal(await modeGatedClient(client, { mode: () => { throw new Error('x') }, configured: () => true }).decide({}).catch(e => e.code), 'decision_mode_off', 'a mode that cannot be read is off')
})

test('the bridge applies the bundle before it reads any flag, gives every turn-judgment feature the gated client, and uses the product key store (settings folder), not an env key', () => {
  const bridge = read('codex-bridge-server.mjs'), first = bridge.indexOf('process.env.EGDESK_')
  assert.ok(bridge.indexOf('applyUpperBundle(process.env)') > 0 && bridge.indexOf('applyUpperBundle(process.env)') < first, 'applied before the first flag read')
  assert.match(bridge, /decisionContext: \{[^]*?client: modeGatedClient\(decisionClient, \{ mode: \(\) => bridgeSettings\.decisionContext\.mode, configured: \(\) => decisionCredentials\.getApiKey\(\) !== null \}\)/)
  assert.ok(!/decisionContext: \{[^]*?\n\s+client: decisionClient,/.test(bridge.slice(bridge.indexOf('decisionContext: {'), bridge.indexOf('decisionContext: {') + 900)), 'the decisionContext does not take the bare client')
  assert.match(bridge, /openDecisionCredentialStore\(\{ dataDir: path\.join\(dataDir, 'settings'\) \}\)/); assert.equal(DECISION_CREDENTIAL_FILE, 'egdesk-decision-credential.json')
  assert.match(bridge, /getApiKey: \(\) => decisionCredentials\.getApiKey\(\)/)
})

test('the product reads the Decision key only from the saved credential: no product module reads an API key from the environment (only the measurement tools do)', () => {
  const tools = new Set(['egdesk-decision-real-runner.mjs'])
  const offenders = fs.readdirSync(here).filter(f => f.endsWith('.mjs') && !/\.(test|fixture)\./.test(f) && !f.includes('real-engine') && !tools.has(f)).filter(f => /process\.env\.OPENAI_API_KEY|env\.OPENAI_API_KEY|EGDESK_REAL_CHECK_DECISION_KEY|EGDESK_DECISION_API_KEY/.test(read(f)))
  assert.deepEqual(offenders, [], 'a product feature bound to a test-only env key would not run with the key saved in the settings screen')
})

// ---- the runtime: U9 for the memory loop, and the order of a turn ----
const tmp = t => { const d = fs.realpathSync(createPrivateQaTempDirectory('egdesk-upper-')); t.after(() => fs.rmSync(d, { recursive: true, force: true })); return d }
function world(t, { mode = 'on', draftCheck = null, turnMemory = null, bundleKeys = {} } = {}) {
  const base = tmp(t), fetched = []
  const client = createDecisionClient({ getApiKey: () => 'egd-synthetic-not-a-key-0u1', recipientForKey: () => 'a'.repeat(64),
    fetchImpl: async (url, init) => { const body = JSON.parse(init.body); fetched.push(body); return Response.json({ answers: body.questions.map(q => ({ name: q.name, type: 'predicate', probability: 0.03 })) }) } })
  let n = 0
  const chat = new CodexChatRuntime({
    request: async (method, params) => { if (method === 'thread/start') return { thread: { id: 'conv-1' }, cwd: params.cwd }; if (method === 'turn/start') return { turn: { id: `turn-${++n}` } }; return {} },
    respond: () => {}, emit: () => {}, emitLegacy: () => {}, verifyFile: async () => null, getOwnerKey: () => 'codex:upper',
    decisionContext: { mode: () => mode, configured: () => true, client: modeGatedClient(client, { mode: () => mode, configured: () => true }), calibrationLog: openCalibrationLog({ dataDir: path.join(base, 'calibration'), log: () => {} }),
      ...(draftCheck ? { draftCheck: { mode: () => draftCheck } } : {}), ...(turnMemory ? { turnMemory } : {}), ...bundleKeys } })
  chat.setConnection(true)
  return { chat, fetched, cwd: base }
}

test('U9 in the memory loop: with the Decision mode 끔 a memory setting that is left on does not start a turn memory (mode stays off), with 기록만/사용 it is as before', () => {
  const tm = { mode: () => 'on', wiki: async () => ({}), eligible: () => true }
  const modeOf = decision => { const w = world({ after() {} }, { mode: decision, turnMemory: tm }); return w.chat.turnMemoryMode() }
  assert.deepEqual(['off', 'advisory', 'on'].map(modeOf), ['off', 'advisory', 'on'])
  const off = world({ after() {} }, { mode: 'off', turnMemory: { ...tm, wiki: async () => { throw new Error('the memory loop must not start') } } })
  assert.equal(off.chat.beginTurnMemory({ message: 'hi' }, { channelKind: 'direct', requestId: 'r' }), null); assert.equal(off.fetched.length, 0)
})

async function turn(w, { final = '완료했습니다.' } = {}) {
  const requestId = `req-${Math.random()}`
  const sent = await w.chat.send({ message: '안녕', clientThreadId: 'ui', requestId, cwd: w.cwd })
  const run = w.chat.runFor(sent); await new Promise(r => setTimeout(r, 20))
  await w.chat.handleNotification({ method: 'item/completed', params: { threadId: run.conversationId, turnId: run.runId, item: { id: 'a1', type: 'agentMessage', phase: 'final_answer', text: final, completionConfirmed: true } } })
  await w.chat.handleNotification({ method: 'turn/completed', params: { threadId: run.conversationId, turn: { id: run.runId, status: 'completed', items: [] } } }); await w.chat.queue
  return { requestId, run }
}

test('order of a turn (U13): memory and action are settled first, then the engine speaks once, then the check; marks are state only and keep the first mark of each stage', async t => {
  const w = world(t, { draftCheck: 'advisory' }), { requestId } = await turn(w)
  const stages = w.chat.turnStagesFor(requestId)
  assert.deepEqual(stages.map(s => s.stage), [...TURN_STAGES], 'memory -> action -> engine -> check, each once')
  for (let i = 1; i < stages.length; i++) assert.ok(stages[i].at >= stages[i - 1].at, 'in time order')
  assert.deepEqual(Object.keys(stages[0]).sort(), ['at', 'stage']); assert.deepEqual(w.chat.turnStagesFor('nope'), [])
  const marks = new Map(); assert.equal(markStage(marks, 'r', 'engine'), true); assert.equal(markStage(marks, 'r', 'engine'), false, 'the first mark counts'); assert.equal(markStage(marks, 'r', 'bogus'), false); assert.equal(markStage(marks, '', 'memory'), false)
  assert.deepEqual(stagesOf(marks, 'r').map(s => s.stage), ['engine'])
})

test('order of a turn without the check: the three layers before it are still in order, and "check" is simply absent (nothing was checked)', async t => {
  const w = world(t), { requestId } = await turn(w)
  assert.deepEqual(w.chat.turnStagesFor(requestId).map(s => s.stage), ['memory', 'action', 'engine'])
})

// ---- the real-engine check: a conversation may say EGDESK_UPPER=on, like the bridge's environment ----
import { validateEngineScript } from './egdesk-real-engine-script.mjs'
import { BRIDGE_COMPOSITION, DECISION_DEPENDENT_FLAGS } from './egdesk-real-engine-check.mjs'
test('the real-engine check knows EGDESK_UPPER: a script may set it, it needs --decisions, and the check fills the bundle through the same function as the bridge', () => {
  const script = flags => ({ set: 'real-engine-upper-v1', conversations: [{ id: 'c', flags, turns: [{ say: 'hi' }] }] })
  assert.equal(validateEngineScript(script({ EGDESK_UPPER: 'on' })).ok, true, JSON.stringify(validateEngineScript(script({ EGDESK_UPPER: 'on' })).errors))
  assert.ok(DECISION_DEPENDENT_FLAGS.includes('EGDESK_UPPER')); assert.ok(BRIDGE_COMPOSITION.flags.includes('EGDESK_UPPER'))
  const check = read('egdesk-real-engine-check.mjs')
  assert.match(check, /const flags = upperBundleFlags\(\{[^]*?EGDESK_OWN_TOOLS: 'on' \}\)\.flags/)
})

test('every flag of the bundle reaches the product wiring from process.env (the bridge reads it itself, or hands process.env to the module that does): none is bound to a harness-only path', () => {
  const bridge = read('codex-bridge-server.mjs'), ownTools = read('egdesk-own-tools-wiring.mjs'), turnMemory = read('egdesk-turn-memory-wiring.mjs')
  assert.match(bridge, /createOwnToolsWiring\(\{ env: process\.env,/); assert.match(bridge, /\.\.\.turnMemoryFlagsFromEnv\(process\.env\)/)
  const reads = {
    EGDESK_OWN_TOOLS: ownTools, EGDESK_DECISION_FIRST: ownTools, EGDESK_DECISION_FIRST_APPROVALS: read('egdesk-decision-first-approvals.mjs') + ownTools,
    EGDESK_TURN_MEMORY_WRITE_FIRST: turnMemory, EGDESK_TURN_MEMORY_PREFETCH: turnMemory, EGDESK_TURN_MEMORY_KEEP_LATE: turnMemory,
  }
  for (const row of UPPER_BUNDLE.filter(r => !r.lands)) assert.ok(bridge.includes(`process.env.${row.flag}`) || (reads[row.flag] ?? '').includes(row.flag), `${row.flag} is read on the product path`)
  assert.deepEqual(UPPER_BUNDLE.filter(r => r.lands).map(r => [r.flag, r.lands]), [['EGDESK_PAGE_TOOLS', 'lane/u1-browser-tools']], 'only the L8 page tools are waiting for their lane to merge')
})

// ---- the stages hook of the real-engine check, through the dispatcher the check uses ----
import './egdesk-real-engine-registrations.mjs'
import { createTurnHooks } from './egdesk-real-engine-extensions.mjs'
import { judgeStages, validateStagesExpect } from './egdesk-real-engine-stages-hook.mjs'
test('stages hook through the dispatcher: records the marked order for the turn\'s request, judges expect.stages, and an expectation it cannot evaluate fails', async () => {
  const marks = [{ stage: 'memory', at: 1 }, { stage: 'action', at: 2 }, { stage: 'engine', at: 3 }]
  const chat = { turnStagesFor: id => (id === 'req-1' ? marks : []) }
  const run = async (expect, attached = true, requestId = 'req-1') => { const hooks = createTurnHooks({ id: 'c', flags: {} }); if (attached) hooks.attach({ chat }); return hooks.afterTurn({ state: () => ({ conversationId: 'n' }), expect, run: { requestId } }) }
  const ok = await run({ stages: { order: ['memory', 'action', 'engine'] } })
  assert.deepEqual(ok.records.stages, { stages: ['memory', 'action', 'engine'], inTimeOrder: true }); assert.deepEqual(ok.expectations.map(e => [e.check, e.ok]), [['stages.order', true], ['stages.inTimeOrder', true]])
  assert.deepEqual((await run({ stages: { order: ['engine', 'memory', 'action'] } })).expectations.map(e => e.ok), [false, true], 'a different order fails')
  assert.deepEqual((await run({ stages: { includes: ['check'] } })).expectations.map(e => [e.check, e.ok]), [['stages.includes', false], ['stages.inTimeOrder', true]])
  assert.deepEqual((await run({ stages: { order: ['memory'] } }, false)).expectations.map(e => [e.check, e.ok]), [['stages.evaluated', false]], 'no runtime: fails, not passes')
  assert.deepEqual((await run({}, true)).expectations, [], 'nothing expected: records only')
  assert.deepEqual(judgeStages({ order: ['memory'] }, [{ stage: 'memory', at: 5 }, { stage: 'engine', at: 4 }]).map(e => [e.check, e.ok]), [['stages.order', false], ['stages.inTimeOrder', false]])
  assert.equal(validateStagesExpect({ order: ['engine'], includes: ['engine'] }).length, 1); assert.equal(validateStagesExpect({ order: ['engine'] }).length, 0)
})

// ---- the Desk search field's routing (lane L1's window): the bundle turns it on and the bridge tells the window ----
test('HUD routing through the bundle: the bridge\'s per-request enabled check reads the bundle\'s value from process.env, and chatCapabilities carries the word the window reads', () => {
  assert.deepEqual(HUD_ROUTING_CAPABILITIES, { advisory: 'hud-routing-advisory', on: 'hud-routing-on' }, 'the words lane L1\'s window reads (HUD_ROUTING_CAPABILITIES)')
  assert.deepEqual([undefined, 'off', 'bogus', 'advisory', 'on'].map(v => hudRoutingCapability(v === undefined ? {} : { EGDESK_HUD_ROUTING: v })), [null, null, null, 'hud-routing-advisory', 'hud-routing-on']); assert.equal(hudRoutingCapability(null), null)
  const env = { EGDESK_UPPER: 'on' }; applyUpperBundle(env)
  assert.equal(env.EGDESK_HUD_ROUTING, 'advisory'); assert.equal(hudRoutingCapability(env), 'hud-routing-advisory')
  const own = { EGDESK_UPPER: 'on', EGDESK_HUD_ROUTING: 'off' }; applyUpperBundle(own)
  assert.equal(hudRoutingCapability(own), null, 'a person who set it off keeps it off, and then the window is not told')
  const bridge = read('codex-bridge-server.mjs')
  assert.match(bridge, /const hudRoutingEnabled = \(\) => \['advisory', 'on'\]\.includes\(process\.env\.EGDESK_HUD_ROUTING\)/, 'read per request, so the value the bundle set is seen')
  assert.match(bridge, /\.\.\.\(hudRoutingCapability\(process\.env\) \? \[hudRoutingCapability\(process\.env\)\] : \[\]\)/)
  assert.ok(bridge.indexOf('applyUpperBundle(process.env)') < bridge.indexOf('const hudRoutingEnabled'))
  const hud = read('egdesk-hud-routing.mjs')
  assert.match(hud, /hud_text/, 'the typed text is its own egress kind'); assert.match(hud, /every gate REFUSES today/, 'nothing leaves until the owner decides D1')
})
