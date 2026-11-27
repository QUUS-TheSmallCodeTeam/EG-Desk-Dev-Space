// L1 c23 (owner rule U11): the browser, plan and annotation tool providers and the bounded-execution (QA) gate read the readiness of the SLOT that
// will run the turn: the shared app-server for the default account, the profile's own app-server for an Agent profile's account. Each case is run
// with the shared server down and a profile up, and the reverse. The runtime, the plan and annotation providers and the readiness module are real;
// the app-servers are fake engine slots. Mocks only.
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { rm } from 'node:fs/promises'
import { CodexChatRuntime } from './codex-chat-runtime.mjs'
import { openChatStore } from './egdesk-chat-store.mjs'
import { createSlotReadiness, isProfileSlot } from './egdesk-slot-readiness.mjs'
import { createPlanToolProvider } from './egdesk-plan-tool-provider.mjs'
import { createAnnotationToolProvider } from './egdesk-annotation-tool-provider.mjs'
import { createCodexBrowserToolProvider } from './codex-browser-tool-provider.mjs'
import { createPrivateQaTempDirectory } from '../scripts/egdesk-qa-platform.mjs'

const MAIN = 'codex-default', WORK = 'codex-abcdef01'
const ALL = { dynamicTools: true, qaReadOnly: true }, NONE = { dynamicTools: false, qaReadOnly: false }
// the states of the two app-servers, changed by the test
function world({ shared = { schemaMatch: true, qaReadOnly: true, ready: true }, work = ALL } = {}) {
  const state = { shared: { ...shared }, work: { ...work } }
  const readiness = createSlotReadiness({ shared: () => state.shared, profiles: { capabilities: id => (id === WORK ? state.work : NONE) } })
  return { state, readiness }
}

test('the readiness module: shared down + profile up, and the reverse; each slot answers from its own server only', () => {
  const { state, readiness } = world()
  const answer = () => ({ sharedSchema: readiness.schemaReady({ engineId: 'codex', engineProfileId: MAIN }), sharedQa: readiness.qaReady(MAIN), sharedNoProfile: readiness.schemaReady({ engineId: 'codex' }),
    profileSchema: readiness.schemaReady({ engineId: 'codex', engineProfileId: WORK }), profileQa: readiness.qaReady(WORK) })
  assert.deepEqual(answer(), { sharedSchema: true, sharedQa: true, sharedNoProfile: true, profileSchema: true, profileQa: true }, 'both up')
  state.shared = { schemaMatch: true, qaReadOnly: true, ready: false } // the shared app-server is down
  assert.deepEqual(answer(), { sharedSchema: false, sharedQa: false, sharedNoProfile: false, profileSchema: true, profileQa: true }, 'shared down, profile up')
  state.shared = { schemaMatch: true, qaReadOnly: true, ready: true }; state.work = NONE // the profile's server is down or signed out
  assert.deepEqual(answer(), { sharedSchema: true, sharedQa: true, sharedNoProfile: true, profileSchema: false, profileQa: false }, 'profile down, shared up')
  state.shared = { schemaMatch: false, qaReadOnly: false, ready: true }; state.work = ALL // the shared binary lacks the contract; the profile's has it
  assert.deepEqual(answer(), { sharedSchema: false, sharedQa: false, sharedNoProfile: false, profileSchema: true, profileQa: true }, 'another binary')
  state.work = { dynamicTools: true, qaReadOnly: false } // the profile's binary has the tools contract but not the QA policy contract
  assert.deepEqual([readiness.schemaReady({ engineProfileId: WORK }), readiness.qaReady(WORK)], [true, false])
  // robustness: a throwing reader or a missing state is "not ready", never a throw
  assert.equal(createSlotReadiness({ shared: () => { throw new Error('x') }, profiles: { capabilities: () => { throw new Error('y') } } }).schemaReady({ engineProfileId: WORK }), false)
  assert.equal(createSlotReadiness({ shared: () => null, profiles: { capabilities: () => null } }).qaReady(undefined), false)
  assert.deepEqual([isProfileSlot(MAIN), isProfileSlot(undefined), isProfileSlot(''), isProfileSlot(WORK)], [false, false, false, true])
  assert.throws(() => createSlotReadiness({}), TypeError)
})

// ---- end to end through the real runtime: which native tools a thread starts with ----
async function runtimeFixture(t, readiness, { qaLog = null } = {}) {
  const dataDir = createPrivateQaTempDirectory('egdesk-slot-readiness-')
  const store = openChatStore({ dataDir, ownerScope: 'local-desktop-test' })
  t.after(async () => { try { store.close() } catch {} await rm(dataDir, { recursive: true, force: true }) })
  const threads = new Map(), started = []
  let serial = 0
  const key = slot => (slot === MAIN ? 'account-main' : slot === WORK ? 'account-work' : null)
  const profiles = { runProfile(profileId) {
    return { binding: { profileId, revision: 3, hash: `${profileId}/3` }, developerInstructions: 'Fixture agent', model: { engine: 'codex', engineProfileId: profileId === 'work' ? WORK : MAIN, modelId: 'm', effort: null } }
  } }
  const engine = {
    id: 'codex', describe: () => ({ id: 'codex', version: '0.162.1', profiles: [{ id: MAIN, status: 'available', active: true }, { id: WORK, status: 'available', active: false }] }),
    refresh: async () => ({}), dispose() {}, subscribe() { return () => {} },
    capabilities: () => new Set(['stream', 'resume', 'interrupt', 'modelSelect.perTurn', 'boundedQa']),
    async ensureReady() { return true }, isReady: () => true, ownerKey: slot => key(slot ?? MAIN), request(method) { throw new Error(`Unexpected ${method}`) }, respond() { return true },
    async startThread(params, slot = MAIN) { started.push({ slot, tools: (params.dynamicTools ?? []).map(spec => spec.name) }); const thread = { id: `thread-${++serial}`, turns: [] }; threads.set(thread.id, { slot, thread }); return { thread, model: params.model } },
    async resumeThread(params) { return { thread: threads.get(params.threadId).thread } },
    async startTurn(params) { const turn = { id: `turn-${++serial}`, status: 'inProgress', items: [] }; threads.get(params.threadId).thread.turns.push(turn); return { turn } },
    async releaseThread() { return {} }, async interruptTurn() {},
  }
  const plan = createPlanToolProvider({ plans: () => ({}), schemaReady: route => readiness.schemaReady(route) })
  const annotation = createAnnotationToolProvider({ schemaReady: route => readiness.schemaReady(route) })
  const chat = new CodexChatRuntime({ engines: [engine], profiles, store, requireStore: true, getOwnerKey: () => key(MAIN), toolProviders: [plan, annotation],
    qaReady: slot => { qaLog?.push(slot ?? null); return readiness.qaReady(slot) } })
  chat.setConnection(true)
  return { chat, started }
}
const toolsOf = (started, i) => started[i].tools.sort()
const PLAN_AND_ANNOTATION = tools => tools.some(n => /plan/i.test(n)) && tools.some(n => /annot/i.test(n))
let sends = 0
const send = (chat, room, request, extra = {}) => chat.send({ clientThreadId: room, requestId: `${room}-${request}-${++sends}`, message: request, ...extra })

test('end to end: a room on a profile gets its native tools while the shared server is down; a shared room does not (and the reverse)', async t => {
  const { state, readiness } = world()
  const { chat, started } = await runtimeFixture(t, readiness)
  await send(chat, 'room-both', 'one', { profileId: 'main' }); await send(chat, 'room-work', 'one', { profileId: 'work' })
  assert.deepEqual([started[0].slot, started[1].slot], [MAIN, WORK])
  assert.equal(PLAN_AND_ANNOTATION(started[0].tools), true); assert.equal(PLAN_AND_ANNOTATION(started[1].tools), true, 'both up: both rooms have the tools')
  state.shared = { schemaMatch: true, qaReadOnly: true, ready: false } // shared down, profile up
  await send(chat, 'room-shared-2', 'two', { profileId: 'main' }); await send(chat, 'room-work-2', 'two', { profileId: 'work' })
  assert.deepEqual(started[2].tools, [], 'a room on the shared server: no native tools while it is down')
  assert.equal(PLAN_AND_ANNOTATION(started[3].tools), true, 'a room on the profile: its tools, though the shared server is down')
  state.shared = { schemaMatch: true, qaReadOnly: true, ready: true }; state.work = NONE // profile down, shared up
  await send(chat, 'room-shared-3', 'three', { profileId: 'main' }); await send(chat, 'room-work-3', 'three', { profileId: 'work' })
  assert.equal(PLAN_AND_ANNOTATION(started[4].tools), true, 'shared room: unaffected by the profile being down')
  assert.deepEqual(started[5].tools, [], 'profile room: no native tools while its own server is not ready')
})

test('the bounded-execution gate is asked about the slot that will run the turn, and refuses on that slot\'s state only', async t => {
  const log = []
  const { state, readiness } = world()
  const { chat, started } = await runtimeFixture(t, readiness, { qaLog: log })
  const bounded = { executionPolicy: { mode: 'readOnlyQa' } }
  state.shared = { schemaMatch: true, qaReadOnly: true, ready: false } // shared down, profile up
  for (const [room, profile] of [['room-shared', 'main'], ['room-work', 'work']]) {
    log.length = 0
    const attempt = await send(chat, room, 'qa', { profileId: profile, ...bounded }).then(() => null, error => error)
    assert.equal(log[0], profile === 'work' ? WORK : MAIN, `${room}: the gate got the room's own slot`)
    if (profile === 'main') { assert.equal(attempt?.code, 'QA_POLICY_UNAVAILABLE'); assert.equal(started.length, 0, 'refused before any thread started') }
    else assert.ok(!(attempt?.code === 'QA_POLICY_UNAVAILABLE' && log.length === 1), 'the profile room passed the gate while the shared server is down')
  }
  state.shared = { schemaMatch: true, qaReadOnly: true, ready: true }; state.work = NONE // profile down, shared up
  log.length = 0
  const profileDown = await send(chat, 'room-work-2', 'qa', { profileId: 'work', ...bounded }).then(() => null, error => error)
  assert.deepEqual([log[0], profileDown?.code], [WORK, 'QA_POLICY_UNAVAILABLE'], 'the profile room is refused on its own server\'s state')
  log.length = 0
  const sharedUp = await send(chat, 'room-shared-2', 'qa', { profileId: 'main', ...bounded }).then(() => null, error => error)
  assert.equal(log[0], MAIN); assert.ok(sharedUp?.code !== 'QA_POLICY_UNAVAILABLE' || log.length > 1, 'the shared room passed the gate while the profile server is down')
})

test('the browser provider offers and prepares by the slot: tools only where that slot\'s QA contract holds', async () => {
  const { state, readiness } = world()
  const provider = createCodexBrowserToolProvider({ transport: { hasClient: () => false }, getOwnerKey: () => 'owner', schemaReady: route => readiness.qaReady(route?.engineProfileId) })
  const route = id => ({ engineId: 'codex', engineProfileId: id })
  const offers = id => provider.specs(route(id)).some(spec => String(spec.name).startsWith('egdesk_browser_'))
  assert.deepEqual([offers(MAIN), offers(WORK)], [true, true])
  state.shared = { schemaMatch: true, qaReadOnly: true, ready: false } // shared down, profile up
  assert.deepEqual([offers(MAIN), offers(WORK)], [false, true])
  state.shared = { schemaMatch: true, qaReadOnly: true, ready: true }; state.work = NONE // profile down, shared up
  assert.deepEqual([offers(MAIN), offers(WORK)], [true, false])
  // prepare refuses with the contract error for the slot that is not ready (a selected source is required to get that far)
  const body = { selectedSources: [{ kind: 'browser-card', id: 'c1' }] }
  assert.throws(() => provider.prepare(body, route(WORK)), { code: 'BROWSER_TOOLS_UNAVAILABLE' })
  state.work = ALL; state.shared = { schemaMatch: true, qaReadOnly: true, ready: false }
  assert.throws(() => provider.prepare(body, route(MAIN)), { code: 'BROWSER_TOOLS_UNAVAILABLE' })
  assert.doesNotThrow(() => { try { provider.prepare(body, route(WORK)) } catch (error) { if (error?.code === 'BROWSER_TOOLS_UNAVAILABLE') throw error } }, 'the profile slot is past the readiness check while the shared server is down')
})

test('the bridge uses the module for the browser, plan and annotation providers and qaReady; nothing global is left', () => {
  const source = readFileSync(new URL('./codex-bridge-server.mjs', import.meta.url), 'utf8')
  assert.match(source, /const slotReadiness = createSlotReadiness\(\{ shared: \(\) => \(\{ schemaMatch: nativeCapabilities\.schemaMatch, qaReadOnly: nativeCapabilities\.qaReadOnly, ready: appServerReady \}\)/)
  // u5: the Codex answer is still the slot's own (codexReady); only a Claude route with the Claude browser capability live leaves it (egdesk-claude-browser-route)
  assert.match(source, /createCodexBrowserToolProvider\(\{[^\n]*schemaReady: browserSchemaReady\(\{[^\n]*codexReady: route => slotReadiness\.qaReady\(route\?\.engineProfileId\) \}\)/)
  assert.match(source, /createPlanToolProvider\(\{ plans: \(\) => workflow\?\.plans \?\? null, schemaReady: route => slotReadiness\.schemaReady\(route\) \}\)/)
  assert.match(source, /createAnnotationToolProvider\(\{ schemaReady: route => slotReadiness\.schemaReady\(route\) \}\)/)
  assert.match(source, /qaReady: slot => slotReadiness\.qaReady\(slot\),/)
  assert.equal(/schemaReady: \(\) =>/.test(source), false, 'no readiness callback ignores the slot')
  assert.equal(/qaReady: \(\) =>/.test(source), false)
  const runtime = readFileSync(new URL('./codex-chat-runtime.mjs', import.meta.url), 'utf8')
  assert.equal((runtime.match(/this\.qaReady\(slot\)/g) || []).length, 3, 'all three bounded-execution checks pass their slot')
  assert.equal(/this\.qaReady\(\)/.test(runtime), false)
  assert.match(runtime, /provider\.specs\?\.\(provider === this\.contexts \? authority : routeHint\)/)
})
