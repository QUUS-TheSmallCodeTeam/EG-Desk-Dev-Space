// L1 c25 (owner decision U11, decision 3: "each task's account is checked on resume"): behind EGDESK_ROOM_ACCOUNT a plan (and its sources, its graph's
// delegation scope, its listing and its HTTP checks) belongs to the account of the room that proposed it. A room on an Agent profile proposes, approves and
// runs under THAT account while the default sign-in is signed out or someone else; another account on the profile ends it; a room that moved to another
// account no longer finds it. The default room and flag off are unchanged. The workflow runtime, plan service, source registry and graph are real; the
// chat is a recording stub. Mocks only.
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { openWorkflowRuntime } from './egdesk-workflow-runtime.mjs'
import { isProfileSlot } from './egdesk-slot-readiness.mjs'
import { readFileSync } from 'node:fs'

const WORK = 'codex-abcdef01', MAIN = 'codex-default'
const delay = ms => new Promise(resolve => setTimeout(resolve, ms))
const PLAN = { title: 'Quarterly report', tasks: [{ taskId: 'collect', title: 'Collect numbers', instructions: 'Collect the Q3 numbers.', dependsOn: [] }] }

async function fixture(t, { flag = true, defaultOwner = null } = {}) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'egdesk-plan-room-'))
  const w = { flag, defaultOwner, profiles: { [WORK]: 'email:work@example.test' }, threads: new Map([['conv-w', WORK], ['conv-d', MAIN]]), sends: [] }
  const chat = { threads: new Map(), conversationBusy: () => false, interrupt: async () => ({}), resume: async () => ({ runs: [] }), snapshot: () => ({ runs: [] }),
    send: async body => { w.sends.push(body); return { accepted: true, requestId: body.requestId, conversationId: body.conversationId ?? 'child-conv', runId: 'native-run', answerId: `${body.conversationId ?? 'child-conv'}/native-run` } } }
  const ownerKeyFor = id => (w.flag && isProfileSlot(id) ? (w.profiles[id] ?? null) : w.defaultOwner)
  const runtime = await openWorkflowRuntime({ dataDir: dir, chat, port: 39218, broadcast() {}, ensureAuth: async () => {}, getOwnerKey: () => w.defaultOwner,
    ownerKeyFor, roomKeyed: () => w.flag, roomSlotOf: origin => { if (!w.flag) return undefined; const slot = origin?.engineProfileId ?? w.threads.get(origin?.conversationId); return isProfileSlot(slot) ? slot : undefined } })
  t.after(async () => { await runtime.close(); await rm(dir, { recursive: true, force: true }) })
  const run = (conversationId, slot, runId = `run-${conversationId}`) => ({ runId, conversationId, clientThreadId: `room-${conversationId}`, engine: { id: 'codex', engineProfileId: slot } })
  return { w, runtime, run, chat }
}

test('a profile room proposes, lists, views and approves its plan while the default is signed out and while the default is someone else; steps run under the room\'s account', async t => {
  for (const defaultOwner of [null, 'email:someone-else@example.test']) {
    const f = await fixture(t, { defaultOwner })
    const plan = await f.runtime.plans.propose({ run: f.run('conv-w', WORK), args: PLAN })
    assert.equal(plan.status, 'proposed', `default ${defaultOwner}`)
    assert.deepEqual(f.runtime.plans.list().map(p => p.planId), [plan.planId])
    assert.equal(f.runtime.plans.view(plan.planId).planId, plan.planId)
    assert.equal(f.runtime.plans.slotOfGraph(plan.graphId), WORK)
    assert.equal(f.runtime.plans.slotOfBoard(plan.boardId), WORK)
    const decided = await f.runtime.plans.approve(plan.planId)
    assert.equal(decided.plan.status, 'approved')
    for (let i = 0; i < 300 && !f.w.sends.length; i++) await delay(5)
    assert.equal(f.w.sends.length, 1, 'the step ran')
    assert.equal(f.w.sends[0].conversationId, 'conv-w', 'in the room, on its own account')
  }
})

test('the room\'s plan follows ITS account: the default changing is no matter, another account on the profile ends it, a room moved to another account does not find it', async t => {
  const f = await fixture(t, { defaultOwner: 'email:a@example.test' })
  const plan = await f.runtime.plans.propose({ run: f.run('conv-w', WORK), args: PLAN })
  f.w.defaultOwner = 'email:c@example.test'
  assert.equal(f.runtime.plans.view(plan.planId).planId, plan.planId, 'default changed: still there')
  f.w.defaultOwner = null
  assert.equal(f.runtime.plans.list().length, 1, 'default signed out: still listed')
  f.w.profiles[WORK] = 'email:z@example.test'
  assert.throws(() => f.runtime.plans.view(plan.planId), { code: 'PLAN_NOT_FOUND' }, 'another account signed in on the profile')
  assert.equal(f.runtime.plans.list().length, 0)
  await assert.rejects(f.runtime.plans.approve(plan.planId), { code: 'PLAN_NOT_FOUND' })
  f.w.profiles[WORK] = 'email:work@example.test'
  assert.ok(f.runtime.plans.view(plan.planId), 'the account came back')
  f.w.threads.set('conv-w', MAIN)
  assert.throws(() => f.runtime.plans.view(plan.planId), { code: 'PLAN_NOT_FOUND' }, 'the room moved to the default account: the plan of the old account stays with it')
})

test('the default sign-in changing while a profile room\'s step is being sent does not end its delegation (the scope does not move with the default)', async t => {
  const f = await fixture(t, { defaultOwner: 'email:a@example.test' })
  f.runtime.observeAuth({ signedIn: true, accountKey: 'codex:chatgpt:a' })
  const originalSend = f.chat.send
  f.chat.send = async body => { f.w.defaultOwner = 'email:c@example.test'; f.runtime.observeAuth({ signedIn: true, accountKey: 'codex:chatgpt:c' }); return originalSend(body) }
  const work = await f.runtime.plans.propose({ run: f.run('conv-w', WORK), args: PLAN })
  await f.runtime.plans.approve(work.planId)
  for (let i = 0; i < 300 && !f.w.sends.length; i++) await delay(5)
  await delay(50)
  const attempt = f.runtime.adapter.getState(work.graphId).attempts[0]
  assert.equal(attempt?.phase, 'accepted', 'the native send was accepted under the room\'s scope (not ended by the default account changing mid-send)')
  assert.equal(f.w.sends.length, 1)
})

test('the default room is unchanged: it needs the default sign-in to plan, and a profile account does not matter to it; the two kinds never see each other\'s plans', async t => {
  const f = await fixture(t, { defaultOwner: null })
  await assert.rejects(f.runtime.plans.propose({ run: f.run('conv-d', MAIN), args: PLAN }), { code: 'TASK_AUTHORITY' })
  f.w.defaultOwner = 'email:a@example.test'
  const own = await f.runtime.plans.propose({ run: f.run('conv-d', MAIN), args: PLAN })
  const work = await f.runtime.plans.propose({ run: f.run('conv-w', WORK, 'run-w2'), args: PLAN })
  assert.deepEqual(f.runtime.plans.list().map(p => p.planId).sort(), [own.planId, work.planId].sort())
  f.w.profiles[WORK] = 'email:z@example.test'
  assert.deepEqual(f.runtime.plans.list().map(p => p.planId), [own.planId], 'another account on the profile: only the default room\'s plan')
  f.w.defaultOwner = 'email:c@example.test'
  assert.deepEqual(f.runtime.plans.list(), [], 'the default account changed: its plan is gone')
})

test('flag off: a profile room\'s plan follows the default sign-in exactly as before', async t => {
  const f = await fixture(t, { flag: false, defaultOwner: null })
  await assert.rejects(f.runtime.plans.propose({ run: f.run('conv-w', WORK), args: PLAN }), { code: 'TASK_AUTHORITY' })
  assert.throws(() => f.runtime.plans.list(), { code: 'TASK_AUTHORITY' }, 'the list also errors signed out, as before')
  f.w.defaultOwner = 'email:a@example.test'
  const plan = await f.runtime.plans.propose({ run: f.run('conv-w', WORK), args: PLAN })
  f.w.profiles[WORK] = 'email:z@example.test'
  assert.ok(f.runtime.plans.view(plan.planId), 'the profile account is not consulted')
  assert.equal(f.runtime.plans.hintsOf(plan.planId), undefined)
})

test('the HTTP layer authenticates the plan\'s own room, not the default: hints are the room\'s conversation pair (profile plans only)', async t => {
  const f = await fixture(t, { defaultOwner: 'email:a@example.test' })
  const own = await f.runtime.plans.propose({ run: f.run('conv-d', MAIN), args: PLAN })
  const work = await f.runtime.plans.propose({ run: f.run('conv-w', WORK, 'run-w3'), args: PLAN })
  assert.equal(f.runtime.plans.hintsOf(own.planId), undefined)
  assert.deepEqual(f.runtime.plans.hintsOf(work.planId), { conversationId: 'conv-w', clientThreadId: 'room-conv-w' })
  assert.equal(f.runtime.plans.hintsOf('plan-nope'), undefined)
  const src = readFileSync(new URL('./egdesk-task-plans.mjs', import.meta.url), 'utf8')
  assert.match(src, /await ensureAuth\(plans\.hintsOf\?\.\(match\[1\]\)\)/)
  assert.match(src, /ensureAuth\(planId \? plans\.hintsOf\?\.\(planId\) : undefined\)/)
})

test('the bridge gives the workflow runtime the slot-aware owner rule behind the flag, and routes the plan HTTP check by hints', () => {
  const server = readFileSync(new URL('./codex-bridge-server.mjs', import.meta.url), 'utf8')
  assert.match(server, /ensureAuth: hints => ensureChatAuth\(hints\), getOwnerKey: \(\) => publicAuthIdentityKey\(authState\), maxConcurrency: 2, localCapacity,/)
  assert.match(server, /ownerKeyFor: browserOwnerKeyFor, roomKeyed: \(\) => process\.env\.EGDESK_ROOM_ACCOUNT === 'on',/)
  assert.match(server, /if \(process\.env\.EGDESK_ROOM_ACCOUNT !== 'on'\) return undefined\n    const slot = origin\?\.engineProfileId \?\? chat\.threadEngineProfile\(origin\?\.conversationId\)/)
})
