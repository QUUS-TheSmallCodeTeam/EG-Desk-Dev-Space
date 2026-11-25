// c36: the proposals hook of the real-engine check, exercised THROUGH THE DISPATCHER the check uses. c33 wrote it as an async finishTurn; the dispatcher reads finishTurn synchronously, so the
// record and the expectations were a Promise nobody read, expect.proposals was never judged and check-31pr passed without it. These tests would have failed then.
import test from 'node:test'
import assert from 'node:assert/strict'
import './egdesk-real-engine-registrations.mjs'
import { createTurnHooks, registerTurnHooks } from './egdesk-real-engine-extensions.mjs'
import { judgeProposals, validateProposalsExpect } from './egdesk-real-engine-proposals-hook.mjs'

const item = (kind, steps = [], options = []) => ({ provider: 'proposals', kind, text: '이 순서대로 실행해도 될까요?', steps: steps.map((text, i) => ({ n: i + 1, text })), options: options.map((text, i) => ({ n: i + 1, text })) })
const fakeChat = items => ({ calls: [], async proposalRegistryIdle() { this.calls.push('idle'); await new Promise(r => setTimeout(r, 5)) }, openItemsFor(cid) { this.calls.push(['items', cid]); return items } })
const state = () => ({ conversationId: 'native-1', store: null, clientThreadId: 't' })
async function turn(expect, chat) {
  const hooks = createTurnHooks({ id: 'conv-p', flags: { EGDESK_PROPOSAL_REGISTRY: 'on' } })
  if (chat) hooks.attach({ chat })
  const after = await hooks.afterTurn({ state, expect, run: null }), done = hooks.finishTurn({ state, expect, latencyMs: 1 })
  return { records: { ...done.records, ...after.records }, expectations: [...after.expectations, ...done.expectations] }
}

test('through the dispatcher: the hook waits for the registry, records the items under "proposals" and its expectations join the turn', async () => {
  const chat = fakeChat([item('proposal', ['a', 'b', 'c']), { ...item('person_request'), provider: 'browser' }])
  const out = await turn({ proposals: { kinds: ['proposal'], stepsAtLeast: 3 } }, chat)
  assert.deepEqual(chat.calls, ['idle', ['items', 'native-1']], 'it waited for the registration before reading')
  assert.deepEqual(out.records.proposals.items.map(i => [i.kind, i.steps]), [['proposal', ['a', 'b', 'c']]], 'only this registry\'s items')
  assert.deepEqual(out.expectations.map(e => [e.check, e.ok]), [['proposals.kinds', true], ['proposals.stepsAtLeast', true]])
})

test('through the dispatcher: a wrong kind, too few steps and "none" with an item open all FAIL', async () => {
  const wrong = await turn({ proposals: { kinds: ['waiting_action'], stepsAtLeast: 2 } }, fakeChat([item('proposal', ['a'])]))
  assert.deepEqual(wrong.expectations.map(e => [e.check, e.ok]), [['proposals.kinds', false], ['proposals.stepsAtLeast', false]])
  const none = await turn({ proposals: { none: true } }, fakeChat([item('person_request')])); assert.deepEqual(none.expectations.map(e => e.ok), [false])
  assert.deepEqual((await turn({ proposals: { none: true } }, fakeChat([]))).expectations.map(e => e.ok), [true])
})

test('through the dispatcher: an expectation that cannot be evaluated (no runtime attached) fails instead of passing silently; with nothing expected the hook records without judging', async () => {
  const unattached = await turn({ proposals: { none: true } }, null)
  assert.deepEqual(unattached.expectations.map(e => [e.check, e.ok]), [['proposals.evaluated', false]])
  const quiet = await turn({}, fakeChat([item('proposal')])); assert.deepEqual([quiet.expectations, quiet.records.proposals.items.length], [[], 1])
})

test('the dispatcher refuses a finishTurn that returns a Promise (its result would never be read)', () => {
  registerTurnHooks('asyncProbe', () => ({ finishTurn: async () => ({ record: { x: 1 }, expectations: [{ check: 'x', ok: true }] }) }))
  assert.throws(() => createTurnHooks({ id: 'conv-async' }).finishTurn({ state, expect: {} }), /asyncProbe.*finishTurn is synchronous.*use afterTurn/)
})

test('judgeProposals and validation: exact kinds in order, options, none excludes the rest, the flag is required in the conversation', () => {
  assert.deepEqual(judgeProposals({ kinds: ['proposal', 'person_request'] }, [item('proposal'), item('person_request')]).map(e => e.ok), [true])
  assert.deepEqual(judgeProposals({ kinds: ['person_request', 'proposal'] }, [item('proposal'), item('person_request')]).map(e => e.ok), [false], 'order matters')
  assert.deepEqual(judgeProposals({ optionsAtLeast: 2 }, [item('proposal', [], ['a', 'b'])]).map(e => e.ok), [true]); assert.deepEqual(judgeProposals({ optionsAtLeast: 2 }, [item('proposal', [], ['a'])]).map(e => e.ok), [false])
  assert.equal(validateProposalsExpect({ none: true, kinds: ['proposal'] }, { conv: { flags: { EGDESK_PROPOSAL_REGISTRY: 'on' } } }).length, 1); assert.equal(validateProposalsExpect({ none: true }, { conv: {} }).length, 1)
})
