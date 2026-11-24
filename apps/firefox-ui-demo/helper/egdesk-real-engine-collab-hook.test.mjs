// L1 cycle 27: the collaboration hook (helper/egdesk-real-engine-collab-hook.mjs, registered in helper/egdesk-real-engine-hooks.mjs) inside lane L5's real-engine check.
// End to end against the FAKE app-server of scripts/real-engine/fake-app-server.mjs (0.171 protocol subset, every message schema-checked): the check's own runtime, the
// bridge's own presence and requester routes, the product's work-placement runtime, a scripted Decision model. No Codex binary, no network, no real key. Mocks only.
import test from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { runFakeAppServer } from '../scripts/real-engine/fake-app-server.mjs'
import { BRIDGE_COMPOSITION, DECISION_DEPENDENT_FLAGS, DECISION_KEY_ENV, preflight, runCheck } from './egdesk-real-engine-check.mjs'
import { APPROVER_TEXT, validateEngineScript } from './egdesk-real-engine-script.mjs'
import { COLLAB_DECISION_FLAGS, COLLAB_FLAGS, COLLAB_PEOPLE, attentionScene, checkCollabExpect, createCollabTurnHook, createCollabWorld, identityLeak, presenceRows, validateCollabExpect } from './egdesk-real-engine-collab-hook.mjs'
import { registeredDecisionFlags, registeredExpectKeys, registeredFlags, registeredTurnFields, registeredTurnHookNames } from './egdesk-real-engine-extensions.mjs'
import { COLLAB_RESTART_SAYS, COLLAB_RESTART_SET, COLLAB_SAYS, COLLAB_SET, FORCE_PUSH, buildCollabRestartScript, buildCollabScript } from './egdesk-collab-real-engine-script.mjs'
import { createPrivateQaTempDirectory } from '../scripts/egdesk-qa-platform.mjs'

const tmp = t => { const base = fs.realpathSync(createPrivateQaTempDirectory('egdesk-real-engine-collab-')); t.after(() => fs.rmSync(base, { recursive: true, force: true })); return base }
const ANSWER_NEEDS_OWNER = 'v2는 v1보다 단가가 12,000원에서 11,000원으로 낮고 납기가 3주에서 2주로 짧습니다. 수정 견적서를 보내기 전에 이 단가 인하를 소유자께서 승인해 주셔야 합니다.'
const ANSWER_INFO = 'A사 견적서 v2의 납기는 2주입니다. 따로 확인하실 일은 없습니다.'
const ANSWER_RECAP = '견적서 v1과 v2의 차이와 v2의 납기를 정리했습니다.'
const ANSWER_LIST = 'quotes 폴더에는 a-v1.md와 a-v2.md가 있습니다.'
const fakeScript = () => ({ turns: [
  { steps: [], final: ANSWER_LIST },
  { steps: [{ toolCall: { tool: 'egdesk_read_file', arguments: { path: 'quotes/a-v1.md' } } }, { toolCall: { tool: 'egdesk_read_file', arguments: { path: 'quotes/a-v2.md' } } }, { usage: { input: 8200, cached: 7900, output: 60, reasoning: 0 } }], final: ANSWER_NEEDS_OWNER },
  { steps: [], final: ANSWER_INFO },
  { steps: [], final: ANSWER_RECAP }],
// the session's pointer message and the other private turns are written by the model: here a short sentence
forkTurns: [{ steps: [], final: '소유자 승인이 필요한 견적 비교 결과가 있습니다.' }, { steps: [], final: '확인할 일이 없습니다.' }, { steps: [], final: '요약했습니다.' }, { steps: [], final: '확인했습니다.' }] })
/** The scripted Decision model: the owner question is yes for the answer that asks for the owner's approval (read from what it was shown), everything else says no. */
const decisionFor = (body, q) => (q.name === 'owner_action' ? (/소유자께서 승인/.test(JSON.stringify(body.input)) ? .96 : .03) : .03)

function world(t, fakeScript, { decisions = true, decisionDelayMs = 0, runCommands = false } = {}) {
  const base = tmp(t), out = path.join(base, 'out'), codexHome = path.join(base, 'codex-home'); fs.mkdirSync(codexHome)
  const spawns = [], decisionBodies = [], stderrLines = [], ranCommands = []
  const shared = { persisted: new Set(), threads: new Map(), used: new Set(), usedFork: new Set(), counters: { thread: 0, turn: 0, item: 0 } } // what a restarted app-server finds on disk
  const spawn = (bin, argv, options) => {
    const stdin = new PassThrough(), stdout = new PassThrough(), stderr = new PassThrough(), child = new EventEmitter()
    Object.assign(child, { pid: 4242 + spawns.length, stdin, stdout, stderr, exitCode: null, signalCode: null, kill: () => true }); spawns.push({ bin, argv, options })
    runFakeAppServer({ script: fakeScript, log: path.join(base, 'fake-app-server.log'), input: stdin, output: stdout, shared, stderr: { write: line => { stderrLines.push(line); stderr.write(line) } }, env: options.env, exit: code => { child.exitCode = code; child.emit('close', code, null) } })
    return child
  }
  const killGroup = async child => { child.stdin.end(); await new Promise(resolve => { if (child.exitCode != null) return resolve(); child.once('close', resolve); setTimeout(resolve, 500) }); return { signal: 'SIGTERM' } }
  const fetchImpl = async (url, init) => {
    const body = JSON.parse(init.body); decisionBodies.push(body)
    if (decisionDelayMs && body.questions.some(q => q.name === 'owner_action')) await new Promise(resolve => setTimeout(resolve, decisionDelayMs)) // the real model takes seconds
    const reply = body.input.find(m => Array.isArray(m.content))?.content[0].data?.reply ?? null // the owner's reply to an approval question, read as two predicates
    return Response.json({ answers: body.questions.map(q => ({ name: q.name, type: 'predicate', probability: q.name === 'reply_runs_command' ? (reply === APPROVER_TEXT.yes ? 0.96 : 0.03) : q.name === 'reply_declines_command' ? (reply === APPROVER_TEXT.yes ? 0.02 : 0.9) : decisionFor(body, q) })), usage: { input_tokens: 20 } })
  }
  const options = { mode: 'run', codexBin: '/fake/codex', home: { kind: 'person', dir: null }, scripts: [], out, decisions, model: null, effort: null, appServerConfig: [], turnTimeoutMs: 15000, json: false }
  const deps = { spawn, runnerSpawn: runCommands ? (file, args) => { const child = new EventEmitter(); Object.assign(child, { pid: 9000 + ranCommands.length, stdout: new PassThrough(), stderr: new PassThrough(), kill: () => true }); ranCommands.push(String(args.at(-1))); setImmediate(() => { child.stdout.write(`ran: ${args.at(-1)}\n`); setImmediate(() => child.emit('close', 0, null)) }); return child } : () => { throw new Error('no command runs in this test') }, fetchImpl, killGroup, killGroupRunner: () => {}, gitStatus: async () => null, env: { PATH: '/usr/bin:/bin', HOME: path.join(base, 'home'), [DECISION_KEY_ENV]: 'egd-synthetic-not-a-key-0031' } }
  return { base, options, deps, decisionBodies, stderrLines, ranCommands, shared, spawns, wire: () => fs.readFileSync(path.join(base, 'fake-app-server.log'), 'utf8').trim().split('\n').map(line => JSON.parse(line)) }
}

const asScripts = (...scripts) => scripts.map(script => ({ file: `${script.set}.json`, script }))
const run = async (t, script, { decisions = true, decisionDelayMs = 0 } = {}) => { const w = world(t, fakeScript(), { decisions, decisionDelayMs }); const result = await runCheck(w.options, asScripts(script), w.deps); return { w, result, rec: result.records[0] } }
const hooksOf = rec => rec.turns.map(turn => turn.collab)

test('the registration point: the check lists the collaboration flags from the hook, reproduced now and not listed as missing; the committed script is the builder\'s and validates', () => {
  // registered through the check's extension API (a turn field, an expect key, a turn hook, the flags), not listed in the core
  assert.ok(registeredTurnHookNames().includes('collab') && registeredExpectKeys().includes('collab') && registeredTurnFields().includes('from'))
  for (const flag of COLLAB_FLAGS) assert.ok(registeredFlags().includes(flag)); assert.deepEqual(registeredDecisionFlags().filter(f => COLLAB_DECISION_FLAGS.includes(f)), ['EGDESK_WORK_PLACEMENT']); assert.ok(DECISION_DEPENDENT_FLAGS.includes('EGDESK_WORK_PLACEMENT'))
  for (const flag of COLLAB_FLAGS) assert.ok(BRIDGE_COMPOSITION.flags.includes(flag) && !BRIDGE_COMPOSITION.notReproduced.flags.includes(flag), `${flag} is reproduced now`)
  const committed = JSON.parse(fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'scripts', 'real-engine', 'scripts', `${COLLAB_SET}.json`), 'utf8'))
  assert.deepEqual(committed, JSON.parse(JSON.stringify(buildCollabScript()))); assert.deepEqual(validateEngineScript(committed), { ok: true, errors: [] })
})

test('the validator: from and expect.collab need the presence flag, the attention needs the flow, the placement flag and the draft check for a pointer; closed keys and words', () => {
  const conv = (flags, turn, extra = {}) => ({ set: 'real-engine-x-v1', conversations: [{ id: 'c1', folder: { 'a.txt': 'x' }, ...(flags ? { flags } : {}), ...extra, turns: [turn] }] })
  const full = { EGDESK_PRESENCE: 'on', EGDESK_CONVERSATION_FLOW: 'on', EGDESK_WORK_PLACEMENT: 'on' }
  assert.equal(validateEngineScript(conv(full, { say: 'hi', from: 'invited', expect: { collab: { requester: 'invited', attention: { branch: 'owner', pointer: 'posted' } } } }, { draftCheck: { mode: 'on' } })).ok, true)
  assert.match(validateEngineScript(conv(null, { say: 'hi', from: 'invited' })).errors.join('\n'), /needs flags\.EGDESK_PRESENCE/)
  assert.match(validateEngineScript(conv({ EGDESK_PRESENCE: 'on' }, { say: 'hi', expect: { collab: { attention: { branch: 'owner' } } } })).errors.join('\n'), /EGDESK_WORK_PLACEMENT/)
  assert.match(validateEngineScript(conv(full, { say: 'hi', expect: { collab: { attention: { pointer: 'posted' } } } })).errors.join('\n'), /draft check/)
  const bad = collab => validateEngineScript(conv(full, { say: 'hi', expect: { collab } }, { draftCheck: { mode: 'on' } }))
  assert.equal(bad({ requester: 'someone' }).ok, false); assert.equal(bad({ other: 1 }).ok, false); assert.equal(bad({ attention: { branch: 'both' } }).ok, false)
  assert.equal(bad({ ownerQuestion: { questions: ['owner_action'] } }).ok, false, 'the question is the attention scene\'s'); assert.equal(bad({ cameraUntouched: true }).ok, false); assert.equal(bad({ noIdentity: true }).ok, false)
  assert.equal(validateEngineScript(conv(full, { say: 'hi', from: 'stranger' })).ok, false)
  assert.deepEqual(validateCollabExpect({ requester: 'owner' }), [])
})

test('the world: the invited member is taken only while the presence snapshot lists them; an owner turn clears; the flow\'s audience is recorded', async () => {
  const world = createCollabWorld(), keys = { clientThreadId: 'room-1', conversationId: null }
  assert.equal(world.requesters.audience({ run: keys }), null)
  assert.equal(await world.tell('invited', keys), 'held'); assert.deepEqual(world.audience({ run: keys }), { requester: COLLAB_PEOPLE.invited.member, owner: 'self', participants: ['self'] })
  assert.equal(await world.tell('owner', keys), 'cleared'); assert.equal(world.audience({ run: keys }), null)
  assert.deepEqual(world.flowAudience.map(a => a.requester), [COLLAB_PEOPLE.invited.member, null])
  // without a presence snapshot the registry refuses a member (the bridge's own rule): a mirror that went stale is not vouching
  let clock = 1000
  const stale = createCollabWorld({ now: () => clock }); await stale.publish(); clock += 20_000
  const refused = await (async () => { const body = { clientThreadId: 'r', conversationId: null, requester: { board: COLLAB_PEOPLE.invited.board, alias: COLLAB_PEOPLE.invited.member } }; return stale.requesters.set([body.clientThreadId], body.requester) })()
  assert.equal(refused, 'unknown-member')
  assert.equal(presenceRows().filter(r => r.self).length, 1); assert.equal(presenceRows()[0].self, true)
})

test('end to end on the fake engine: who sends each turn, the owner question, the owner\'s pointer, the requester\'s branch, no identity, no coordinate', async t => {
  const { rec, w } = await run(t, buildCollabScript())
  assert.equal(rec.aborted, null, rec.abortDetail)
  const [warm, owner, info, recap] = hooksOf(rec)
  assert.deepEqual([warm.from, warm.set, warm.audience.requester, warm.attention], ['owner', 'cleared', null, null])
  assert.deepEqual([owner.from, owner.set, owner.audience.requester], ['invited', 'held', COLLAB_PEOPLE.invited.member])
  assert.deepEqual([info.from, info.audience.requester], ['invited', COLLAB_PEOPLE.invited.member]); assert.deepEqual([recap.from, recap.set, recap.audience.requester], ['owner', 'cleared', null])
  assert.ok(recap.flowAudienceTotal > 0, 'the conversation flow itself asked the registry who asked, over the run'); assert.deepEqual([warm.optedIn, owner.optedIn], [false, true], 'the live session is opted in from the second turn')
  assert.equal(owner.attention.submitted, 'queued'); assert.equal(owner.attention.result.branch, 'owner'); assert.equal(owner.attention.result.kind, 'point')
  assert.equal(owner.ownAnswer, ANSWER_NEEDS_OWNER)
  const q = owner.attention.requests; assert.equal(q.length, 1); assert.deepEqual(q[0].questions, ['owner_action']); assert.ok(q[0].shared.includes('A사 견적서 v1과 v2를 읽고')); assert.ok(q[0].shared.includes(ANSWER_NEEDS_OWNER)); assert.equal(q[0].identityLeak, false)
  assert.equal(info.attention.result.branch, 'requester'); assert.equal(info.attention.result.kind, 'surface_near_requester'); assert.equal(info.attention.pointer, 'none'); assert.equal(recap.attention, null)
  for (const turn of rec.turns) for (const e of turn.expectations.filter(x => x.check.startsWith('collab.'))) assert.equal(e.ok, true, `${turn.index}: ${e.check} ${JSON.stringify(e.detail)}`)
  assert.equal(JSON.stringify(rec.turns).includes(COLLAB_PEOPLE.invited.board), false, 'the Board id is not in the records')
  assert.ok(w.decisionBodies.every(body => !JSON.stringify(body).includes(COLLAB_PEOPLE.invited.member)), 'no member alias in any Decision request of the whole run')
})

test('the checks are by code on the record: each one fails on the record that breaks it, and a missing record fails all', () => {
  const I = COLLAB_PEOPLE.invited.member
  const good = { from: 'invited', set: 'held', audience: { requester: I, owner: 'self' }, flowAudience: [{ requester: I }], ownAnswer: ANSWER_NEEDS_OWNER,
    attention: { submitted: 'queued', heartbeat: 'running', result: { status: 'decided', branch: 'owner', kind: 'point', source: 'decision', forMember: 'M1' }, pointer: 'posted', flowMessages: 1,
      requests: [{ family: 'work_placement', questions: ['owner_action'], shared: `The person's request: ${COLLAB_SAYS.compare}\n${ANSWER_NEEDS_OWNER}`, identityLeak: false }], landedInsideOthers: false, sceneHasCoordinates: false } }
  const expect = { requester: 'invited', attention: { branch: 'owner', kind: 'point', pointer: 'posted' }, ownerQuestion: { questions: ['owner_action'], quotesRequest: ['A사 견적서 v1과 v2를 읽고'], quotesOwnAnswer: true }, noIdentity: true, cameraUntouched: true }
  const failing = rec => checkCollabExpect(expect, rec).filter(c => !c.ok).map(c => c.check)
  assert.deepEqual(failing(good), [])
  assert.deepEqual(checkCollabExpect(expect, null).map(c => [c.check, c.ok]), [['collab.ran', false]])
  assert.deepEqual(failing({ ...good, audience: { requester: null, owner: null } }), ['collab.requester'], 'nobody named although the invited member sent it')
  assert.deepEqual(failing({ ...good, flowAudience: [{ requester: null }] }), ['collab.requester'], 'the flow was told something else')
  assert.deepEqual(failing({ ...good, set: 'unknown-member' }), ['collab.requester'], 'the bridge did not take the requester')
  assert.deepEqual(checkCollabExpect({ requester: 'owner' }, { ...good, from: 'owner', set: 'cleared', audience: { requester: null, owner: null }, flowAudience: [] }).map(c => c.ok), [true])
  assert.deepEqual(checkCollabExpect({ requester: 'owner' }, good).map(c => c.ok), [false], 'an owner turn with a requester named')
  const att = patch => ({ ...good, attention: { ...good.attention, ...patch } })
  assert.deepEqual(failing(att({ result: { ...good.attention.result, branch: 'requester' } })), ['collab.attention'])
  assert.deepEqual(failing(att({ pointer: 'raised' })), ['collab.attention'], 'raised is not posted')
  assert.deepEqual(failing(att({ flowMessages: 2 })), ['collab.attention'], 'exactly one pointer message')
  assert.deepEqual(failing(att({ result: { status: 'pending' } })), ['collab.attention', 'collab.cameraUntouched'])
  assert.deepEqual(failing(att({ requests: [{ ...good.attention.requests[0], questions: ['owner_action', 'same_matter_R1'] }] })), ['collab.ownerQuestion'])
  assert.deepEqual(failing(att({ requests: [{ ...good.attention.requests[0], shared: 'The person\'s request: something else' }] })), ['collab.ownerQuestion'], 'the request is not quoted')
  assert.deepEqual(failing({ ...good, ownAnswer: 'A sentence the judge was never shown.' }), ['collab.ownerQuestion'], 'the model\'s own sentences are not what was quoted')
  assert.deepEqual(failing(att({ requests: [{ ...good.attention.requests[0], identityLeak: true }] })), ['collab.noIdentity'])
  assert.deepEqual(failing(att({ requests: [] })), ['collab.ownerQuestion', 'collab.noIdentity'])
  assert.deepEqual(failing(att({ landedInsideOthers: true })), ['collab.cameraUntouched'])
  assert.deepEqual(failing(att({ sceneHasCoordinates: true })), ['collab.cameraUntouched'])
  assert.deepEqual(failing(att({ result: { ...good.attention.result, kind: 'teleport' } })), ['collab.attention', 'collab.cameraUntouched'], 'only the placement words')
  // the scene the hook builds is a valid placement scene with no coordinate in it, and its two outcomes are for the two people
  const scene = attentionScene(); assert.equal(JSON.stringify(scene).includes('"x"'), false); assert.equal(scene.requester, 'M2'); assert.equal(scene.forOwner.forMember, 'M1'); assert.equal(scene.forRequester.forMember, 'M2')
  // the turn expectations go through the script's own checker too
})

test('the hook\'s timer: presence is posted again every 3 s while the conversation runs, and stops with dispose', async () => {
  const ticks = []; let cleared = 0, fn = null
  const world = createCollabWorld({ setTimer: (f, ms) => { fn = f; ticks.push(ms); return { unref() {} } }, clearTimer: () => { cleared++ } })
  world.start(); world.start(); assert.deepEqual(ticks, [3000], 'one timer'); fn(); world.stop(); world.stop(); assert.equal(cleared, 1)
  assert.equal((await world.publish()).status, 200); assert.equal(world.mirror.snapshot()?.length, 2, 'the snapshot is held for the flow and the registry')
})

test('the identity rule (v4 K2): the member\'s feed alias, the Board id, a scene alias and a coordinate are leaks; the owner question\'s own words are not; the check disposes its hooks', () => {
  const clean = JSON.stringify({ input: [{ role: 'user', content: `The person\'s request:\n${COLLAB_SAYS.compare}` }, { role: 'user', content: ANSWER_NEEDS_OWNER }], questions: [{ name: 'owner_action', instructions: 'Does this result need the owner of the desk to do something?' }] })
  assert.equal(identityLeak(clean), false)
  for (const leak of [COLLAB_PEOPLE.invited.member, COLLAB_PEOPLE.invited.board, '"x":12', '"width": 1200', 'asked by M2', '"M1"']) assert.equal(identityLeak(`${clean} ${leak}`), true, leak)
  const check = fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), 'egdesk-real-engine-check.mjs'), 'utf8')
  for (const call of ['turnHooks.flowOptions({ FLAG, conversation })', 'turnHooks.attach({ chat, contexts, client, store,', 'await turnHooks.beforeSend({ ...hookCtx, turn, index })', 'await turnHooks.afterTurn({ ...hookCtx,', 'turnHooks.dispose()']) assert.ok(check.includes(call), `the check calls ${call}`)
})

test('a slow Decision model (Main\'s first real run: seconds, not instant): the attention scene is still waited for and decided, never read as "unknown" while it is being judged', async t => {
  const script = buildCollabScript(); script.conversations[0].turns = script.conversations[0].turns.slice(0, 3) // the owner's turn, the owner-needed turn, the requester's turn
  const { rec } = await run(t, script, { decisionDelayMs: 1500 })
  assert.equal(rec.aborted, null, rec.abortDetail)
  const [, owner, info] = hooksOf(rec)
  for (const [name, turn, branch] of [['owner-needed', owner, 'owner'], ['requester', info, 'requester']]) {
    assert.equal(turn.attention.result.status, 'decided', `${name}: ${JSON.stringify(turn.attention.result)}`); assert.equal(turn.attention.result.branch, branch)
  }
  for (const turn of rec.turns) for (const e of turn.expectations.filter(x => x.check.startsWith('collab.'))) assert.equal(e.ok, true, `${turn.index}: ${e.check} ${JSON.stringify(e.detail)}`)
})

// ---- c29: across a restart of the bridge and the engine ----
const restartFake = () => ({ turns: [
  { steps: [], final: ANSWER_LIST },
  { steps: [{ toolCall: { tool: 'egdesk_run_command', arguments: { command: FORCE_PUSH } } }], final: 'That force push needs your OK. Should I run it?' },
  // after the restart: the owner's "yes" reaches a bridge that holds no question: the Agent tries the command again and the person is asked once more; then the owner's reply to THAT question
  { steps: [{ toolCall: { tool: 'egdesk_run_command', arguments: { command: FORCE_PUSH } } }], final: 'I need your OK for that force push. Run it?' },
  { steps: [{ toolCall: { tool: 'egdesk_run_command', arguments: { command: FORCE_PUSH } } }], final: 'Done, it ran.' },
  { steps: [], final: ANSWER_INFO }],
forkTurns: [{ steps: [], final: '확인할 일이 없습니다.' }, { steps: [], final: '확인했습니다.' }, { steps: [], final: '요약했습니다.' }] })
const persistedWorld = t => { const w = world(t, restartFake(), { runCommands: true }); w.options.persisted = true; w.deps.inspectNative = () => ({ version: '0.171.0-alpha.13', schemaMatch: false, boardPeerContract: null, steerContract: null, threadDelete: true }); return w }

test('restart: the validator takes the action with its own rules (persisted, a message turn follows, no core expectation) and the new collab keys only where they belong', () => {
  const script = turns => ({ set: 'real-engine-r-v1', conversations: [{ id: 'c', flags: { EGDESK_PRESENCE: 'on' }, turns }] })
  const errors = turns => validateEngineScript(script(turns)).errors.join('\n')
  assert.equal(validateEngineScript(script([{ say: 'a' }, { action: 'restart', expect: { collab: { roomKept: true, receiptsClosed: true } } }, { say: 'b', expect: { collab: { continuity: true } } }])).ok, true)
  assert.match(errors([{ action: 'restart' }, { say: 'b' }]), /cannot be the first turn/); assert.match(errors([{ say: 'a' }, { action: 'restart' }]), /cannot be the last turn/)
  assert.match(errors([{ say: 'a' }, { action: 'restart', say: 'x' }, { say: 'b' }]), /restart takes no say/); assert.match(errors([{ say: 'a' }, { action: 'restart', afterMs: 5 }, { say: 'b' }]), /restart takes no afterMs/)
  assert.match(errors([{ say: 'a' }, { action: 'restart', approve: ['yes'] }, { say: 'b' }]), /takes no approve/); assert.match(errors([{ say: 'a' }, { action: 'restart' }, { action: 'restart' }, { say: 'b' }]), /followed by a plain message turn/)
  assert.match(errors([{ say: 'a' }, { action: 'restart', expect: { posted: true } }, { say: 'b' }]), /takes no expectation of the core/)
  assert.match(errors([{ say: 'a' }, { action: 'restart', expect: { collab: { requester: 'owner' } } }, { say: 'b' }]), /takes only roomKept and receiptsClosed/)
  assert.match(errors([{ say: 'a', expect: { collab: { roomKept: true } } }]), /belongs to a restart turn/); assert.match(errors([{ say: 'a', expect: { collab: { continuity: true } } }]), /message turn right after a restart/)
  const agent = { set: 'real-engine-r-v1', conversations: [{ id: 'c', agentProfile: { name: 'x' }, turns: [{ say: 'a' }, { action: 'restart' }, { say: 'b' }] }] }
  assert.match(validateEngineScript(agent).errors.join('\n'), /not available in an agentProfile/)
  // the committed restart script is the builder's and validates
  const committed = JSON.parse(fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'scripts', 'real-engine', 'scripts', `${COLLAB_RESTART_SET}.json`), 'utf8'))
  assert.deepEqual(committed, JSON.parse(JSON.stringify(buildCollabRestartScript()))); assert.deepEqual(validateEngineScript(committed), { ok: true, errors: [] })
})

test('restart: it needs --persisted-with-cleanup (preflight and the run refuse without), and the dry plan names it', async t => {
  const w = world(t, { turns: [] })
  assert.match(preflight({ ...w.options, codexBin: '/x', persisted: false }, asScripts(buildCollabRestartScript()), { exists: () => true, env: { [DECISION_KEY_ENV]: 'k' } }).join('\n'), /a restart turn needs a saved engine thread/)
  assert.deepEqual(preflight({ ...w.options, codexBin: '/x', persisted: true }, asScripts(buildCollabRestartScript()), { exists: () => true, env: { [DECISION_KEY_ENV]: 'k' } }).filter(p => /restart/.test(p)), [])
  await assert.rejects(runCheck(w.options, asScripts(buildCollabRestartScript()), w.deps), { code: 'restart_needs_persisted' })
})

test('restart, end to end on the fake engine: the room, its account and the invited member survive; the pending owner question is asked again and goes to the owner; nothing carried over is assumed', async t => {
  const w = persistedWorld(t)
  const rec = (await runCheck(w.options, asScripts(buildCollabRestartScript()), w.deps)).records[0]
  assert.equal(rec.aborted, null, rec.abortDetail)
  assert.deepEqual(rec.turns.map(turn => [turn.index, turn.action ?? 'message']), [[1, 'message'], [2, 'message'], [3, 'restart'], [4, 'message'], [5, 'message']], 'the script\'s own turn numbers across the restart')
  for (const turn of rec.turns) assert.equal(turn.ok, true, `${turn.index}: ${JSON.stringify(turn.expectations.filter(e => !e.ok))}`)
  const [, push, restart, yes, due] = rec.turns
  // before: the question is open (the old bridge's approval ledger), the invited member asked for it
  assert.equal(push.asked, 1); assert.equal(push.collab.audience.requester, COLLAB_PEOPLE.invited.member)
  // the restart turn: the same room (route, saved row, account), the new bridge holds nothing of the old one's memory
  const r = restart.collab.restart
  assert.equal(r.before.awaiting, true, 'the old bridge held the open question'); assert.equal(r.after.awaiting, false, 'the new one holds none'); assert.deepEqual([r.after.memoryReceipts, r.after.contextReceipts], [0, 0])
  assert.deepEqual(r.before.route, r.after.route); assert.deepEqual(r.before.row, r.after.row); assert.equal(r.before.account, r.after.account); assert.ok(r.after.account)
  assert.equal(r.requesterBefore, COLLAB_PEOPLE.invited.member); assert.equal(r.requesterAfter, null, 'the requester registry was the old process\'s memory: empty until the window tells again')
  assert.deepEqual(restart.expectations.map(e => e.check), ['restart.resumed', 'collab.roomKept', 'collab.receiptsClosed'])
  // after: the owner's yes did not approve a question the new bridge did not hold: it was asked again (asked 1), and only the reply to THAT question ran the command, once
  assert.equal(yes.asked, 1); assert.deepEqual(w.ranCommands, [FORCE_PUSH], 'one run, after the owner\'s reply to the second question; none before the restart')
  assert.deepEqual(yes.subTurns.map(s => s.approver), [null, 'yes']); assert.match(yes.subTurns[0].toolCalls[0].result.text, /needs_person|ask|approval/i, 'the first try after the restart was refused: needs the person')
  assert.equal(yes.collab.audience.requester, null, 'the question is the owner\'s own room and the owner\'s own reply: nobody is named as requester'); assert.deepEqual([yes.collab.continuity.sameThread, yes.collab.continuity.resumed, yes.collab.continuity.sentOnce], [true, true, true])
  // the invited member again: attributed through the new bridge, and the result card's attention goes to them
  assert.equal(due.collab.audience.requester, COLLAB_PEOPLE.invited.member); assert.equal(due.collab.set, 'held'); assert.equal(due.collab.attention.result.branch, 'requester'); assert.equal(due.collab.attention.result.kind, 'surface_near_requester')
  // two engines were started, the persisted thread was resumed on the second, and every thread of the check is gone at the end
  assert.equal(rec.restarts.length, 1); assert.equal(w.spawns.length, 2)
  assert.ok(w.wire().some(m => m.dir === 'in' && m.method === 'thread/resume'), 'the new engine was asked to resume the room\'s saved thread')
  assert.equal(rec.cleanup.persisted, rec.cleanup.verifiedGone, 'the persisted threads of both engines are deleted and verified gone'); assert.ok(rec.cleanup.persisted >= 1)
})
