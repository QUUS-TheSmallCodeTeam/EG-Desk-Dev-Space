// L1 c32: the open-item resolver in lane L5's real-engine check: the hook, the script, the validator, the compare script; end to end against the FAKE app-server for the flag-on path with
// nothing open (no resolver request, a record that says so). The approval dialogue itself (a gate-stopped force-push) needs the real engine and is Main's run. No Codex binary, no network, no key.
import test from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { runFakeAppServer } from '../scripts/real-engine/fake-app-server.mjs'
import { scriptedDecisions } from '../scripts/egdesk-all-on.support.mjs'
import { createPrivateQaTempDirectory } from '../scripts/egdesk-qa-platform.mjs'
import { BRIDGE_COMPOSITION, DECISION_DEPENDENT_FLAGS, DECISION_KEY_ENV, runCheck } from './egdesk-real-engine-check.mjs'
import { validateEngineScript } from './egdesk-real-engine-script.mjs'
import { registeredDecisionFlags, registeredExpectKeys, registeredFlags, registeredTurnHookNames } from './egdesk-real-engine-extensions.mjs'
import { OPEN_EXPECT_SCHEMA, OPEN_FLAG, createOpenItemsHook, validateOpenExpect } from './egdesk-real-engine-open-items.mjs'
import { FORCE_PUSH, OPEN_ITEMS_SET, OPEN_SAYS, buildOpenItemsScript } from './egdesk-open-items-real-engine-script.mjs'

const app = path.join(path.dirname(fileURLToPath(import.meta.url)), '..')
function world(t, fakeScript) {
  const base = fs.realpathSync(createPrivateQaTempDirectory('egdesk-real-engine-open-')); t.after(() => fs.rmSync(base, { recursive: true, force: true }))
  const out = path.join(base, 'out'), spawns = [], wireQuestions = []
  const spawn = (bin, argv, options) => {
    const stdin = new PassThrough(), stdout = new PassThrough(), stderr = new PassThrough(), child = new EventEmitter()
    Object.assign(child, { pid: 4400 + spawns.length, stdin, stdout, stderr, exitCode: null, signalCode: null, kill: () => true }); spawns.push({ bin, argv, options })
    runFakeAppServer({ script: fakeScript, log: path.join(base, 'fake.log'), input: stdin, output: stdout, stderr: { write: line => stderr.write(line) }, env: options.env, exit: code => { child.exitCode = code; child.emit('close', code, null) } })
    return child
  }
  const killGroup = async child => { child.stdin.end(); await new Promise(resolve => { if (child.exitCode != null) return resolve(); child.once('close', resolve); setTimeout(resolve, 500) }); return { signal: 'SIGTERM' } }
  const scripted = scriptedDecisions()
  const fetchImpl = async (url, init) => {
    const wire = JSON.parse(init.body); wireQuestions.push(wire.questions.map(q => q.name))
    return Response.json({ answers: await scripted.answer(wire), usage: { input_tokens: 20, output_tokens: 1 } })
  }
  const options = { mode: 'run', codexBin: '/fake/codex', home: { kind: 'person', dir: null }, scripts: [], out, decisions: true, model: null, effort: null, appServerConfig: [], turnTimeoutMs: 8000, json: false }
  const deps = { spawn, runnerSpawn: () => { throw new Error('no command runs here') }, fetchImpl, killGroup, killGroupRunner: () => {}, gitStatus: async () => null, env: { PATH: '/usr/bin:/bin', HOME: path.join(base, 'home'), [DECISION_KEY_ENV]: 'egd-synthetic-not-a-key-0032' } }
  return { options, deps, wireQuestions, base, wire: () => fs.readFileSync(path.join(base, 'fake.log'), 'utf8').trim().split('\n').map(line => JSON.parse(line)) }
}

test('the committed script is the builder\'s and validates; the flag, the expect key and the hook are registered; the flag is reproduced and needs the Decision model', () => {
  const committed = JSON.parse(fs.readFileSync(path.join(app, 'scripts', 'real-engine', 'scripts', `${OPEN_ITEMS_SET}.json`), 'utf8'))
  assert.deepEqual(committed, JSON.parse(JSON.stringify(buildOpenItemsScript()))); assert.deepEqual(validateEngineScript(committed), { ok: true, errors: [] })
  assert.ok(registeredExpectKeys().includes('openItems') && registeredTurnHookNames().includes('openItems') && registeredFlags().includes(OPEN_FLAG) && registeredDecisionFlags().includes(OPEN_FLAG))
  assert.ok(DECISION_DEPENDENT_FLAGS.includes(OPEN_FLAG) && BRIDGE_COMPOSITION.flags.includes(OPEN_FLAG) && !BRIDGE_COMPOSITION.notReproduced.flags.includes(OPEN_FLAG))
  assert.deepEqual(committed.conversations.map(c => c.id), ['open-off-approve', 'open-on-approve', 'open-on-unrelated', 'open-on-ambiguous', 'open-off-unrelated'])
  assert.ok(committed.conversations.every(c => c.flags.EGDESK_TERMINAL_GATE === 'on')); assert.deepEqual(committed.conversations.map(c => c.flags[OPEN_FLAG] ?? null), [null, 'on', 'on', 'on', null])
  assert.equal(OPEN_SAYS.ask, `Run this command: ${FORCE_PUSH}`)
  const second = committed.conversations[2].turns
  assert.deepEqual(second[1].expect.openItems, { settled: 'none', reason: ['no_item_referred', 'several_items'], approvalWaiting: true }); assert.deepEqual(second[1].expect.commandsRan, [])
})

test('the validator: closed keys and words, the flag is needed, a reason belongs to settled: none', () => {
  const conv = (flags = { [OPEN_FLAG]: 'on' }) => ({ id: 'c', flags })
  const v = (value, c = conv()) => validateOpenExpect(value, c, {})
  assert.deepEqual(v({ settled: 'approval', maxResolverMs: 3000 }), []); assert.deepEqual(v({ settled: 'none', reason: ['no_item_referred'], approvalWaiting: true }), [])
  assert.match(v({ settled: 'approval' }, conv({})).join('\n'), /needs flags\.EGDESK_OPEN_ITEMS/)
  assert.match(v({ settled: 'approval', reason: 'no_item_referred' }).join('\n'), /belongs to settled: "none"/)
  for (const bad of [{ settled: 'banana' }, { approvalWaiting: 'yes' }, { maxResolverMs: -1 }, { reason: 'Bad Word', settled: 'none' }, { nope: 1 }]) assert.ok(v(bad).length > 0, JSON.stringify(bad))
  assert.equal(OPEN_EXPECT_SCHEMA.additionalProperties, false)
  assert.match(JSON.stringify(validateEngineScript({ set: 'real-engine-x-v1', conversations: [{ id: 'c', flags: { [OPEN_FLAG]: 'on' }, turns: [{ say: 'hi', expect: { openItems: { settled: 5 } } }] }] })), /openItems/)
})

test('the hook: reads the runtime\'s record and the broker, judges settled / reason / approvalWaiting / maxResolverMs by code; no record without the flag or an expectation', () => {
  const make = (record, waiting = true) => { const h = createOpenItemsHook({ flags: { [OPEN_FLAG]: 'on' } }); h.attach({ chat: { openItemRecord: () => record, gateHookBroker: () => ({ awaitingReply: () => waiting }) } }); return h }
  const turn = (hook, expect, starts = 1) => { hook.beginTurn(); for (let i = 0; i < starts; i++) hook.observe('turn/start', {}); hook.afterTurn({ run: { requestId: 'r', conversationId: 'c' } }); return hook.finishTurn({ expect: { openItems: expect }, latencyMs: 4100 }) }
  const settled = make({ status: 'settled', reason: null, kind: 'approval', id: 'oi1', p: 0.97, calls: 1, ms: 380, items: [{ id: 'oi1', kind: 'approval' }], states: { oi1: 'approved' }, today: 'new_turn' }, false)
  let r = turn(settled, { settled: 'approval', approvalWaiting: false, maxResolverMs: 400 }); assert.deepEqual(r.expectations.map(e => e.ok), [true, true, true])
  assert.deepEqual([r.record.resolverMs, r.record.seconds, r.record.engineTurns, r.record.states], [380, 4.1, 1, { oi1: 'approved' }])
  r = turn(settled, { settled: 'none' }); assert.equal(r.expectations[0].ok, false); r = turn(settled, { maxResolverMs: 300 }); assert.equal(r.expectations[0].ok, false)
  const none = make({ status: 'none', reason: 'no_item_referred', kind: null, id: null, p: 0.03, calls: 1, ms: 350, items: [{ id: 'oi1', kind: 'approval' }], states: {}, today: 'new_turn' }, true)
  r = turn(none, { settled: 'none', reason: ['several_items', 'no_item_referred'], approvalWaiting: true }); assert.deepEqual(r.expectations.map(e => e.ok), [true, true, true])
  r = turn(none, { settled: 'approval' }); assert.equal(r.expectations[0].ok, false); r = turn(none, { approvalWaiting: false }); assert.equal(r.expectations[0].ok, false)
  r = turn(none, { settled: 'none', reason: 'unanswered' }); assert.equal(r.expectations[1].ok, false)
  const nothing = make(null, false); r = turn(nothing, { settled: 'none', reason: 'no_items' }); assert.deepEqual([r.record.status, r.record.reason, r.record.calls], ['none', 'no_items', 0]); assert.deepEqual(r.expectations.map(e => e.ok), [true, true])
  assert.equal(createOpenItemsHook({ flags: {} }).finishTurn({ expect: {} }), null)
})

test('the compare script: rows per turn, the pair of the same turn off and on, the commands that ran', async () => {
  const { rowsOf, pairsOf, render } = await import('../scripts/egdesk-open-items-compare.mjs')
  const turn = (index, say, o, ran, lat, ok = true) => ({ index, say, ok, expectations: ok ? [] : [{ check: 'openItems.settled', ok: false }], subTurns: [{ latencyMs: lat, commandsRan: ran }], ...(o ? { openItems: o } : {}) })
  const recs = [{ id: 'open-off-unrelated', turns: [turn(1, 'ask', null, [], 9000), turn(2, 'other', null, [], 5000)] },
    { id: 'open-on-unrelated', turns: [turn(1, 'ask', { flag: true, status: 'none', reason: 'no_items', resolverMs: null, approvalWaiting: null }, [], 9100), turn(2, 'other', { flag: true, status: 'none', reason: 'no_item_referred', resolverMs: 380, approvalWaiting: true }, [], 5600, false)] },
    { id: 'something-else', turns: [turn(1, 'x', null, [], 1)] }]
  const rows = rowsOf(recs)
  assert.deepEqual(rows.map(r => [r.conversation, r.turn, r.flag, r.settled, r.seconds]), [['open-off-unrelated', 1, false, null, 9], ['open-off-unrelated', 2, false, null, 5], ['open-on-unrelated', 1, true, 'none', 9.1], ['open-on-unrelated', 2, true, 'none', 5.6]])
  assert.deepEqual(pairsOf(rows).map(p => [p.dialogue, p.turn, p.addedSeconds, p.sameCommands]), [['unrelated', 1, 0.1, true], ['unrelated', 2, 0.6, true]])
  const text = render(rows, pairsOf(rows)); assert.match(text, /FAIL openItems\.settled/); assert.match(text, /no_item_referred \| 380/)
})

const only = id => { const s = buildOpenItemsScript(); return { file: `${OPEN_ITEMS_SET}.json`, script: { ...s, conversations: [{ id, flags: { EGDESK_TERMINAL_GATE: 'on', [OPEN_FLAG]: 'on' }, folder: { 'README.md': 'x\n' }, turns: [{ say: '안녕', expect: { posted: true, turnStatus: 'completed' } }, { say: '폴더에 뭐 있어?', expect: { posted: true, turnStatus: 'completed', openItems: { settled: 'none', reason: 'no_items' } } }] }] } } }
test('end to end (fake engine): flag on with nothing open: no resolver request, the record says why, the turns are ordinary', async t => {
  const w = world(t, { turns: [{ steps: [], final: '안녕하세요.' }, { steps: [], final: 'README.md가 있습니다.' }] })
  const result = await runCheck(w.options, [only('open-on-nothing')], w.deps)
  const rec = result.records[0]
  assert.equal(rec.aborted, null, rec.abortDetail); assert.ok(rec.turns.every(tn => tn.ok), JSON.stringify(rec.turns.map(tn => tn.expectations.filter(e => !e.ok))))
  assert.deepEqual(rec.turns.map(tn => [tn.openItems.flag, tn.openItems.status, tn.openItems.reason, tn.openItems.calls, tn.openItems.engineTurns]), [[true, 'none', 'no_items', 0, 1], [true, 'none', 'no_items', 0, 1]])
  assert.equal(w.wireQuestions.flat().some(n => n.startsWith('oi_')), false)
})
