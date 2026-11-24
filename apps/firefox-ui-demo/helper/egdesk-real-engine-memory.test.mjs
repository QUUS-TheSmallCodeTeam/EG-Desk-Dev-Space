// L7 c26: memory seeding for the real-engine check. The module's own rules (validation, graph, page parsing, expectations), the two committed
// scripts, and the whole check run offline against the FAKE app-server (scripts/real-engine/fake-app-server.mjs) with the scripted Decision
// model of the all-on world: what the product sends to the engine is observed on the wire, no Codex binary runs and nothing is sent anywhere.
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
import { DECISION_KEY_ENV, loadScripts, preflight, runCheck } from './egdesk-real-engine-check.mjs'
import { REAL_ENGINE_SCRIPT_SCHEMA, validateEngineScript } from './egdesk-real-engine-script.mjs'
import { createMemoryHook, memoryGraph, memoryNeedsDecisions, pagesIn, validateMemory, validateMemoryExpect } from './egdesk-real-engine-memory.mjs'
import { buildMemoryHeldScript, buildMemoryRecallScript, RETENTION } from './egdesk-memory-real-engine-scripts.mjs'
import { candidatesFromOntologyGraph } from './egdesk-context-setup.mjs'

const app = path.join(path.dirname(fileURLToPath(import.meta.url)), '..')
const scriptFile = name => path.join(app, 'scripts', 'real-engine', 'scripts', `real-engine-${name}-v1.json`)

test('the committed scripts are what the builders produce, validate, and need the Decision model', () => {
  for (const [name, build] of [['memory-recall', buildMemoryRecallScript], ['memory-held', buildMemoryHeldScript]]) {
    const committed = JSON.parse(fs.readFileSync(scriptFile(name), 'utf8'))
    assert.deepEqual(committed, JSON.parse(JSON.stringify(build())))
    assert.deepEqual(validateEngineScript(committed), { ok: true, errors: [] })
  }
  const scripts = loadScripts([scriptFile('memory-recall'), scriptFile('memory-held')])
  const problems = preflight({ codexBin: '/x', home: { kind: 'person' }, decisions: false }, scripts, { exists: () => true, env: {} })
  assert.match(problems.join('\n'), /seeded memory pages .* need --decisions: real-engine-memory-recall-v1\/memory-recall, real-engine-memory-held-v1\/memory-held/)
  assert.deepEqual(preflight({ codexBin: '/x', home: { kind: 'person' }, decisions: true }, scripts, { exists: () => true, env: { [DECISION_KEY_ENV]: 'k' } }), [])
  assert.equal(memoryNeedsDecisions({}), false)
})

test('the committed JSON schema file carries the memory fields', () => {
  const schema = JSON.parse(fs.readFileSync(path.join(app, 'scripts', 'real-engine', 'real-engine-script.schema.json'), 'utf8'))
  assert.deepEqual(schema, JSON.parse(JSON.stringify(REAL_ENGINE_SCRIPT_SCHEMA)))
  assert.ok(schema.properties.conversations.items.properties.memory.properties.pages)
})

test('validation: unknown keys, bad ids, dangling links, expectations that name no page', () => {
  const ok = { mode: 'on', pages: [{ id: 'a/b', title: 't', body: 'x' }, { id: 'c', title: 't', body: 'y', links: [{ to: 'a/b' }] }] }
  assert.deepEqual(validateMemory(ok), [])
  assert.match(validateMemory({ ...ok, extra: 1 })[0], /unknown key/)
  assert.match(validateMemory({ pages: [{ id: 'A B', title: 't', body: 'x' }] })[0], /\.id/)
  assert.match(validateMemory({ pages: [{ id: 'a', title: 't', body: 'x' }, { id: 'a', title: 't', body: 'x' }] }).join(), /unique/)
  assert.match(validateMemory({ pages: [{ id: 'a', title: 't', body: 'x', links: [{ to: 'zzz' }] }] }).join(), /a page of this memory/)
  assert.match(validateMemory({ mode: 'maybe', pages: ok.pages }).join(), /mode/)
  assert.deepEqual(validateMemoryExpect({ attached: ['a/b'], noResends: true }, ok), [])
  assert.match(validateMemoryExpect({ attached: ['nope'] }, ok).join(), /not a page of this memory/)
  assert.match(validateMemoryExpect({ attached: ['a/b'], notAttached: ['a/b'] }, ok).join(), /contradict/)
  assert.match(validateMemoryExpect({ attached: ['a/b'] }, undefined).join(), /no memory\.pages/)
  const withExpect = { set: 'real-engine-x-v1', conversations: [{ id: 'x', turns: [{ say: 'hi', expect: { memory: { attached: ['a'] } } }] }] }
  assert.match(validateEngineScript(withExpect).errors.join(), /no memory\.pages/)
})

test('the graph is what the context setup reads: ids, titles, bodies, time slices, status and typed links', () => {
  const g = memoryGraph(buildMemoryHeldScript().conversations[0].memory)
  const candidates = candidatesFromOntologyGraph(g)
  const retention = candidates.find(c => c.id === `ontology:${RETENTION.id}`)
  assert.equal(retention.title, RETENTION.title); assert.equal(retention.timeSlice, 'past'); assert.equal(retention.status, 'done'); assert.equal(retention.loadText(), RETENTION.body)
  const restore = candidates.find(c => c.id === 'ontology:backup/restore-test')
  assert.deepEqual(restore.links, [{ type: 'follows_from', to: `ontology:${RETENTION.id}` }])
  assert.deepEqual(memoryGraph(undefined).nodes, [])
})

test('pagesIn: a body is a page or item block; a reference line is not a body', () => {
  const ctx = {
    egdesk_decision_context: { kind: 'application', value: '[item id=ontology:backup/retention kind=timeline time=past status=done]\n11월 5일 …' },
    egdesk_turn_memory: { kind: 'application', value: '[page id=ontology:backup/restore-test time=past rev=aa via=scan]\nbody\n\n[page id=ontology:backup/retention rev=bb already delivered earlier in this thread, unchanged; content not re-sent]' },
    egdesk_channel: { kind: 'application', value: 'no pages here' } }
  assert.deepEqual(pagesIn(ctx), { bodies: ['backup/restore-test', 'backup/retention'].sort(), refs: [], keys: ['egdesk_decision_context', 'egdesk_turn_memory', 'egdesk_channel'], copies: { 'backup/retention': 1, 'backup/restore-test': 1 } }, 'the item block of the retention page is a body')
  assert.equal(pagesIn({ a: { value: '[item id=ontology:x kind=timeline]' }, b: { value: '[page id=ontology:x rev=1 via=scan]' } }).copies.x, 2, 'a page in both the selection and the memory packet')
  const onlyRef = { egdesk_turn_memory: { kind: 'application', value: '[page id=ontology:backup/retention rev=bb already delivered earlier in this thread, unchanged; content not re-sent]' } }
  assert.deepEqual(pagesIn(onlyRef), { bodies: [], refs: ['backup/retention'], keys: ['egdesk_turn_memory'], copies: {} })
  assert.deepEqual(pagesIn(undefined), { bodies: [], refs: [], keys: [], copies: {} })
})

test('the hook: attached, notAttached and noResends are judged on what turn/start carried; a re-sent body fails noResends, a reference does not', () => {
  const hook = createMemoryHook({ mode: 'on', pages: [{ id: 'a', title: 'A', body: 'x' }, { id: 'b', title: 'B', body: 'y' }] })
  const start = text => hook.observe('turn/start', { additionalContext: { egdesk_turn_memory: { kind: 'application', value: text } } })
  hook.beginTurn(); start('[page id=ontology:a rev=1 via=scan]\nbody'); hook.observe('thread/resume', {})
  let r = hook.finishTurn({ attached: ['a'], notAttached: ['b'], noResends: true })
  assert.deepEqual(r.expectations.map(e => [e.check, e.ok]), [['memory.attached', true], ['memory.notAttached', true], ['memory.noResends', true]])
  hook.beginTurn(); start('[page id=ontology:a rev=1 already delivered earlier in this thread, unchanged; content not re-sent]')
  r = hook.finishTurn({ noResends: true }); assert.equal(r.expectations[0].ok, true); assert.deepEqual(r.record.referenced, ['a'])
  hook.beginTurn(); start('[item id=ontology:a kind=timeline]\nagain')
  r = hook.finishTurn({ noResends: true, notAttached: ['a'] }); assert.deepEqual(r.expectations.map(e => e.ok), [false, false]); assert.deepEqual(r.record.resent, ['a'])
  const off = createMemoryHook(undefined); off.beginTurn(); off.observe('turn/start', { additionalContext: { k: 'x' } }); assert.deepEqual(off.finishTurn({}), { record: null, expectations: [] })
})

// ---- the whole check against the fake app-server ----
function world(t, fakeScript) {
  const base = fs.realpathSync(createPrivateQaTempDirectory('egdesk-real-engine-memory-'))
  t.after(() => fs.rmSync(base, { recursive: true, force: true }))
  const out = path.join(base, 'out'), spawns = [], decisionCalls = []
  const spawn = (bin, argv, options) => {
    const stdin = new PassThrough(), stdout = new PassThrough(), stderr = new PassThrough(), child = new EventEmitter()
    Object.assign(child, { pid: 4300 + spawns.length, stdin, stdout, stderr, exitCode: null, signalCode: null, kill: () => true })
    spawns.push({ bin, argv, options })
    runFakeAppServer({ script: fakeScript, log: path.join(base, 'fake.log'), input: stdin, output: stdout, stderr: { write: line => stderr.write(line) }, env: options.env, exit: code => { child.exitCode = code; child.emit('close', code, null) } })
    return child
  }
  const killGroup = async child => { child.stdin.end(); await new Promise(resolve => { if (child.exitCode != null) return resolve(); child.once('close', resolve); setTimeout(resolve, 500) }); return { signal: 'SIGTERM' } }
  const scripted = scriptedDecisions()
  const fetchImpl = async (url, init) => {
    const wire = JSON.parse(init.body); decisionCalls.push(wire.questions.map(q => q.name))
    let answers = await scripted.answer(wire)
    // the context selection: the retention line ('보관 기간') is needed when the message is about the backup or the period (turn 2 says only 그 기간), the others are not
    if (wire.questions.some(q => q.name === 'answer_type')) {
      const flat = wire.input.map(m => (typeof m.content === 'string' ? m.content : JSON.stringify(m.content))).join('\n')
      const message = flat.slice(flat.lastIndexOf('Message:') + 8)
      answers = answers.map(a => { const m = /^rel_(\d+)$/.exec(a.name); if (!m) return a
        const line = new RegExp(`#${m[1]} \\|[^\\n]*`).exec(flat)?.[0] ?? ''
        return { ...a, probability: /백업|기간/.test(message) && /보관 기간/.test(line) ? 0.95 : 0.02 } })
    }
    return Response.json({ answers, usage: { input_tokens: 20, output_tokens: 1 } })
  }
  const options = { mode: 'run', codexBin: '/fake/codex', home: { kind: 'person', dir: null }, scripts: [], out, decisions: true, model: null, effort: null, appServerConfig: [], turnTimeoutMs: 8000, json: false }
  const deps = { spawn, runnerSpawn: () => { throw new Error('no command runs here') }, fetchImpl, killGroup, killGroupRunner: () => {}, gitStatus: async () => null, env: { PATH: '/usr/bin:/bin', HOME: path.join(base, 'home'), [DECISION_KEY_ENV]: 'egd-synthetic-not-a-key-0026' } }
  return { out, options, deps, decisionCalls, base }
}
const asScripts = (...scripts) => scripts.map(script => ({ file: `${script.set}.json`, script }))

test('end to end (fake engine): the recall script passes when the product attaches the retention page and not the decoys', async t => {
  const w = world(t, { turns: [{ steps: [], final: '보관 기간은 47일로 정했습니다.' }] })
  const result = await runCheck(w.options, asScripts(buildMemoryRecallScript()), w.deps)
  const rec = result.records[0], turn = rec.turns[0]
  if (process.env.L7_DEBUG) console.log('DBG', JSON.stringify({ calls: w.decisionCalls, turn: turn.memory, decisions: turn.subTurns.map(s => s.decisions) }))
  assert.equal(rec.aborted, null, rec.abortDetail)
  assert.deepEqual(turn.memory.attached.includes(RETENTION.id), true, JSON.stringify(turn.memory))
  assert.deepEqual(turn.memory.attached.filter(id => id.startsWith('office/') || id.startsWith('lunch/')), [])
  assert.equal(turn.ok, true, JSON.stringify(turn.expectations))
  assert.ok(w.decisionCalls.some(names => names.includes('answer_type')), 'the Decision model picked the pages')
})

const HELD_FAKE = { turns: [{ steps: [], final: '보관 기간은 47일로 정했습니다.' }, { steps: [], final: '47일이 지나면 자동 삭제하기로 했습니다.' }] }

test('end to end (fake engine): the held script passes with the held-record pruning on: the retention page has its body once, turn 2 sends none again', async t => {
  const w = world(t, HELD_FAKE)
  const rec = (await runCheck(w.options, asScripts(buildMemoryHeldScript()), w.deps)).records[0]
  assert.equal(rec.aborted, null, rec.abortDetail)
  const [t1, t2] = rec.turns
  if (process.env.L7_DEBUG) console.log('DBG', JSON.stringify([t1.memory, t2.memory]))
  assert.deepEqual(t1.memory.attached.includes(RETENTION.id), true)
  assert.ok(t1.memory.keys.includes('egdesk_turn_memory'), 'turn memory ran on the one-time thread (the check opts in for memory mode on)')
  assert.deepEqual(t2.memory.resent, [])
  assert.equal(t1.ok, true, JSON.stringify(t1.expectations)); assert.equal(t2.ok, true, JSON.stringify(t2.expectations))
  assert.equal(rec.ok, true)
})

test('end to end (fake engine): the same conversation WITHOUT the pruning flag: the check sees the re-send and the turn fails (the expectation can fail)', async t => {
  const w = world(t, HELD_FAKE)
  const script = buildMemoryHeldScript(); delete script.conversations[0].flags
  const rec = (await runCheck(w.options, asScripts(script), w.deps)).records[0]
  const t2 = rec.turns[1]
  assert.ok(t2.memory.resent.includes(RETENTION.id), JSON.stringify(t2.memory))
  assert.equal(t2.expectations.find(e => e.check === 'memory.noResends').ok, false)
  assert.equal(t2.ok, false); assert.equal(rec.ok, false)
})

test('end to end (fake engine): a conversation without memory is untouched (no memory field in the turn records, the graph is empty)', async t => {
  const w = world(t, { turns: [{ steps: [], final: 'ok' }] })
  const script = { set: 'real-engine-plain-v1', conversations: [{ id: 'plain', turns: [{ say: '안녕', expect: { posted: true } }] }] }
  const rec = (await runCheck(w.options, asScripts(script), w.deps)).records[0]
  assert.equal('memory' in rec.turns[0], false); assert.equal(rec.ok, true)
})

test('the scorer reads a record of the whole check: pages, re-sends, the numbers that decided it, the answer, the check\'s own expectations', async t => {
  const { scoreMemoryRecord, formatScore } = await import('./egdesk-real-engine-memory-score.mjs')
  const w = world(t, HELD_FAKE)
  const rec = (await runCheck(w.options, asScripts(buildMemoryHeldScript()), w.deps)).records[0]
  const score = scoreMemoryRecord(JSON.parse(JSON.stringify(rec)))
  assert.equal(score.ok, true)
  assert.deepEqual(score.summary.resentPages, []); assert.deepEqual(score.summary.turnMemoryRanOn.includes(1), true)
  assert.deepEqual(score.turns[0].memory.attached.includes(RETENTION.id), true)
  assert.ok(Object.keys(score.turns[0].decisions.selection.rel).length >= 3, 'the selection numbers are kept')
  assert.ok(Object.keys(score.turns[0].decisions.triage).length >= 1)
  assert.match(score.turns[1].answer, /자동 삭제/)
  assert.deepEqual(score.turns[1].checks.map(c => [c.check, c.ok]).filter(([c]) => c.startsWith('memory.')), [['memory.notAttached', true], ['memory.noResends', true]])
  assert.match(formatScore(score), /\| 2 \|/)
  // a failing record scores as failing and names the failed check
  const bad = JSON.parse(JSON.stringify(rec)); bad.turns[1].memory.resent = [RETENTION.id]; bad.turns[1].expectations = [{ check: 'memory.noResends', ok: false, detail: { resent: [RETENTION.id] } }]; bad.turns[1].ok = false; bad.ok = false
  const s2 = scoreMemoryRecord(bad); assert.equal(s2.ok, false); assert.deepEqual(s2.summary.failed, ['memory.noResends']); assert.deepEqual(s2.summary.resentPages, [RETENTION.id])
})
