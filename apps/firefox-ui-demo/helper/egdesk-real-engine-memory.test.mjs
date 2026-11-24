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
import { buildMemoryHeldScript, buildMemoryHeldV2Script, buildMemoryHeldV3Script, buildMemoryHeldV4Script, buildMemoryRecallScript, buildMemoryScaleScript, PURGE, RETENTION, SCALE_FACTS, SCALE_PAGES } from './egdesk-memory-real-engine-scripts.mjs'
import { candidatesFromOntologyGraph } from './egdesk-context-setup.mjs'

const app = path.join(path.dirname(fileURLToPath(import.meta.url)), '..')
const scriptFile = name => path.join(app, 'scripts', 'real-engine', 'scripts', `real-engine-${name}${/-v\d+$/.test(name) ? '' : '-v1'}.json`)

test('the committed scripts are what the builders produce, validate, and need the Decision model', () => {
  for (const [name, build] of [['memory-recall', buildMemoryRecallScript], ['memory-held', buildMemoryHeldScript], ['memory-held-v2', buildMemoryHeldV2Script], ['memory-held-v3', buildMemoryHeldV3Script], ['memory-held-v4', buildMemoryHeldV4Script], ['memory-scale', buildMemoryScaleScript]]) {
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
  assert.deepEqual(core(pagesIn(ctx)), { bodies: ['backup/restore-test', 'backup/retention'].sort(), refs: [], keys: ['egdesk_decision_context', 'egdesk_turn_memory', 'egdesk_channel'], copies: { 'backup/retention': 1, 'backup/restore-test': 1 } }, 'the item block of the retention page is a body')
  assert.equal(pagesIn({ a: { value: '[item id=ontology:x kind=timeline]' }, b: { value: '[page id=ontology:x rev=1 via=scan]' } }).copies.x, 2, 'a page in both the selection and the memory packet')
  const onlyRef = { egdesk_turn_memory: { kind: 'application', value: '[page id=ontology:backup/retention rev=bb already delivered earlier in this thread, unchanged; content not re-sent]' } }
  assert.deepEqual(core(pagesIn(onlyRef)), { bodies: [], refs: ['backup/retention'], keys: ['egdesk_turn_memory'], copies: {} })
  assert.deepEqual(core(pagesIn(undefined)), { bodies: [], refs: [], keys: [], copies: {} })
  // one packet: the memory part of the merged packet names the page without repeating its body
  const merged = { egdesk_decision_context: { value: '[item id=ontology:backup/retention kind=timeline]\nbody\n\n[page id=ontology:backup/retention time=past rev=aa via=scan]\n[content not repeated here: this page is among the selected items above]' } }
  assert.deepEqual(core(pagesIn(merged)), { bodies: ['backup/retention'], refs: [], keys: ['egdesk_decision_context'], copies: { 'backup/retention': 1 } })
  assert.deepEqual(pagesIn({ k: { value: '[page id=ontology:x rev=1 via=scan]\n[content not repeated here: this page is among the selected items above]' } }).refs, ['x'])
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
const core = ({ bodies, refs, keys, copies }) => ({ bodies, refs, keys, copies })
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
        // turn 2 of held-v4 asks about a backup past the period: the purge rule is needed; the retention page (held) is too, but it is pruned as held
        const wanted = /총 예산/.test(message) ? /개요|네트워크 작업|데이터베이스 작업|스토리지 증설/.test(line) : /본 전환은 이미/.test(message) ? /본 전환 계획|되돌리기/.test(line) : /기한을 넘긴/.test(message) ? /백업 파일 정리/.test(line) || /보관 기간 결정/.test(line) : /백업|기간/.test(message) && /보관 기간/.test(line)
        return { ...a, probability: wanted ? 0.95 : 0.02 } })
    }
    // scale-v1 turn 2: the planned cut-over and the rollback idea come through the selection; the fake memory scan (lexical) decides no for the others, as a judge
    // reading the pages would. (A page delivered as a selection item is invisible to the memory loop's held list: see report l7-c30 §3.)
    if (wire.questions.some(q => /^pg_/.test(q.name)) && /본 전환은 이미/.test(JSON.stringify(wire.input))) answers = answers.map(a => (/^pg_/.test(a.name) ? { ...a, probability: 0.02 } : a))
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

test('held-v2: turn 1 must not volunteer the later fact (checked by code), turn 2 re-sends nothing and still holds it; runs with the product against the fake engine', async t => {
  const w = world(t, { turns: [{ steps: [], final: '47일입니다.' }, { steps: [], final: '47일이 지나면 자동 삭제하기로 했습니다.' }] })
  const rec = (await runCheck(w.options, asScripts(buildMemoryHeldV2Script()), w.deps)).records[0]
  assert.equal(rec.aborted, null, rec.abortDetail); assert.equal(rec.ok, true, JSON.stringify(rec.turns.map(t => t.expectations)))
  assert.deepEqual(rec.turns[1].memory.resent, [])
  // the precondition: an engine that volunteers the fact in turn 1 fails the conversation there
  const w2 = world(t, { turns: [{ steps: [], final: '47일이고, 47일이 지나면 자동 삭제합니다.' }, { steps: [], final: '자동 삭제합니다.' }] })
  const rec2 = (await runCheck(w2.options, asScripts(buildMemoryHeldV2Script()), w2.deps)).records[0]
  assert.equal(rec2.turns[0].ok, false); assert.equal(rec2.turns[0].expectations.find(e => e.check === 'answerExcludes').ok, false); assert.equal(rec2.ok, false)
})

test('noDuplicates: a page whose body is in two keys of one turn fails it; one body passes; validation takes only true', () => {
  const hook = createMemoryHook({ mode: 'on', pages: [{ id: 'a', title: 'A', body: 'x' }] })
  hook.beginTurn()
  hook.observe('turn/start', { additionalContext: { egdesk_decision_context: { value: '[item id=ontology:a kind=timeline]\nx' }, egdesk_turn_memory: { value: '[page id=ontology:a rev=1 via=scan]\nx' } } })
  const twice = hook.finishTurn({ noDuplicates: true }); assert.equal(twice.expectations[0].ok, false); assert.deepEqual(twice.expectations[0].detail.twice, ['a'])
  hook.beginTurn(); hook.observe('turn/start', { additionalContext: { egdesk_decision_context: { value: '[item id=ontology:a kind=timeline]\nx' } } })
  assert.equal(hook.finishTurn({ noDuplicates: true }).expectations[0].ok, true)
  const memory = { pages: [{ id: 'a', title: 'A', body: 'x' }] }
  assert.deepEqual(validateMemoryExpect({ noDuplicates: true }, memory), []); assert.match(validateMemoryExpect({ noDuplicates: false }, memory).join(), /true/)
})

test('end to end (fake engine): held-v3 (one packet, no same body twice in a turn) passes; the same conversation without the one-packet flag fails turn 1 on noDuplicates', async t => {
  const fake = { turns: [{ steps: [], final: '47일입니다.' }, { steps: [], final: '47일이 지나면 자동 삭제하기로 했습니다.' }] }
  const w = world(t, fake)
  const rec = (await runCheck(w.options, asScripts(buildMemoryHeldV3Script()), w.deps)).records[0]
  assert.equal(rec.aborted, null, rec.abortDetail)
  assert.equal(rec.ok, true, JSON.stringify(rec.turns.map(x => x.expectations.filter(e => !e.ok))))
  assert.equal(rec.turns[0].memory.duplicatesInTurn, 0); assert.deepEqual(rec.turns[1].memory.resent, [])
  const w2 = world(t, fake)
  const script = buildMemoryHeldV3Script(); script.conversations[0].flags = { EGDESK_TURN_MEMORY_PRUNE_HELD: 'on' }
  const rec2 = (await runCheck(w2.options, asScripts(script), w2.deps)).records[0]
  assert.equal(rec2.turns[0].expectations.find(e => e.check === 'memory.noDuplicates').ok, false)
  assert.equal(rec2.turns[0].ok, false); assert.equal(rec2.ok, false)
})

test('held-v4: the second fact is on a page turn 1 cannot see; turn 2 fetches it and re-sends the held page nowhere; it does not need the model to withhold anything (fake engine)', async t => {
  // an engine that volunteers everything it can in turn 1 does not break the design: the phrase is not on the retention page
  const w = world(t, { turns: [{ steps: [], final: '47일이고, 47일이 지나면 삭제할 것 같습니다.' }, { steps: [], final: `매일 ${PURGE.phrase}에 자동으로 삭제합니다.` }] })
  const rec = (await runCheck(w.options, asScripts(buildMemoryHeldV4Script()), w.deps)).records[0]
  assert.equal(rec.aborted, null, rec.abortDetail); assert.equal(rec.ok, true, JSON.stringify(rec.turns.map(x => x.expectations.filter(e => !e.ok))))
  assert.deepEqual(rec.turns[0].memory.attached, [RETENTION.id]); assert.deepEqual(rec.turns[1].memory.attached, [PURGE.id]); assert.deepEqual(rec.turns[1].memory.resent, [])
  // an engine that answers turn 2 without the purge page's phrase fails turn 2 (the page was needed)
  const w2 = world(t, { turns: [{ steps: [], final: '47일입니다.' }, { steps: [], final: '삭제합니다.' }] })
  const rec2 = (await runCheck(w2.options, asScripts(buildMemoryHeldV4Script()), w2.deps)).records[0]
  assert.equal(rec2.turns[1].ok, false); assert.equal(rec2.turns[1].expectations.find(e => e.check === 'answerIncludes').ok, false)
})

test('scale-v1 pages are realistic: 7 pages of 500-2,300 characters, two linked, one decoy; every fact sits in the last fifth of its own page and is on no other page', () => {
  const script = buildMemoryScaleScript(), conv = script.conversations[0], pages = conv.memory.pages
  assert.equal(pages.length, 7)
  for (const p of pages) { assert.ok(p.body.length >= 500 && p.body.length <= 2300, `${p.id}: ${p.body.length} characters`); assert.ok(Buffer.byteLength(p.body) <= 8000) }
  assert.equal(pages.filter(p => p.links?.length).length, 2); assert.equal(pages.filter(p => /^office\//.test(p.id)).length, 1)
  assert.ok(pages.some(p => p.time === 'planned') && pages.some(p => p.time === 'hypothetical'))
  const home = { budget: 'migration/overview', firewall: 'migration/network', dump: 'migration/database', storage: 'migration/storage', cutoverDate: 'migration/cutover', rollbackRate: 'migration/rollback' }
  for (const [k, fact] of Object.entries(SCALE_FACTS)) {
    const holders = pages.filter(p => p.body.includes(fact)); assert.deepEqual(holders.map(p => p.id), [home[k]], `${k} is on exactly one page`)
    assert.ok(holders[0].body.lastIndexOf(fact) >= holders[0].body.length * 0.8, `${k} is in the last fifth of its page`)
  }
  const first = conv.turns[0].expect.memory; assert.deepEqual(first.attached.map(id => pages.find(p => p.id === id).body.length > 800), [true, true, true, true])
  assert.ok(first.minKeyChars <= first.attached.reduce((n, id) => n + pages.find(p => p.id === id).body.length, 0), 'the key bar is below what the four bodies alone hold')
  assert.deepEqual(validateEngineScript(JSON.parse(JSON.stringify(script))), { ok: true, errors: [] })
  assert.equal(SCALE_PAGES.length, 7)
})

test('minKeyChars and merged: judged on what turn/start carried; validation takes integers only', () => {
  const memory = { pages: [{ id: 'a', title: 'A', body: 'x' }] }
  const merged = { egdesk_decision_context: { value: '[item id=ontology:a kind=timeline]\n' + 'x'.repeat(500) + '\n\n[page id=ontology:a rev=1 via=scan]\n[content not repeated here: this page is among the selected items above]' } }
  const hook = createMemoryHook(memory)
  hook.beginTurn(); hook.observe('turn/start', { additionalContext: merged })
  const done = hook.finishTurn({ minKeyChars: 400, merged: 1 }); assert.deepEqual(done.expectations.map(e => [e.check, e.ok]), [['memory.minKeyChars', true], ['memory.merged', true]]); assert.deepEqual(done.record.merged, ['a']); assert.ok(done.record.maxKeyChars > 500)
  hook.beginTurn(); hook.observe('turn/start', { additionalContext: merged })
  assert.deepEqual(hook.finishTurn({ minKeyChars: 5000, merged: 2 }).expectations.map(e => e.ok), [false, false])
  hook.beginTurn(); hook.observe('turn/start', { additionalContext: { k: { value: '[item id=ontology:a kind=timeline]\nx\n\n[page id=ontology:a rev=1 via=scan]\nx' } } })
  assert.equal(hook.finishTurn({ merged: 1 }).expectations[0].ok, false, 'a page whose body is sent twice is not merged')
  assert.deepEqual(validateMemoryExpect({ minKeyChars: 100, merged: 2 }, memory), [])
  for (const bad of [{ minKeyChars: 0 }, { minKeyChars: 1.5 }, { merged: 0 }, { merged: '2' }]) assert.ok(validateMemoryExpect(bad, memory).length > 0, JSON.stringify(bad))
})

test('scale-v1 end to end (fake engine): the right answers pass; a missing tail fact, a plan stated as done, and an idea stated as decided each fail by code', async t => {
  const f = SCALE_FACTS
  const good = [{ steps: [], final: `총 예산은 ${f.budget}, 방화벽 규칙 점검은 ${f.firewall} 대리, 야간 덤프는 새벽 ${f.dump}, 스토리지는 ${f.storage}입니다.` }, { steps: [], final: `아직 아닙니다. 본 전환은 ${f.cutoverDate}로 계획만 되어 있고, 오류율이 ${f.rollbackRate}를 넘으면 되돌리는 안은 가정일 뿐입니다.` }]
  const w = world(t, { turns: good })
  const rec = (await runCheck(w.options, asScripts(buildMemoryScaleScript()), w.deps)).records[0]
  assert.equal(rec.aborted, null, rec.abortDetail); assert.equal(rec.ok, true, JSON.stringify(rec.turns.map(x => x.expectations.filter(e => !e.ok))))
  assert.ok(rec.turns[0].memory.maxKeyChars >= 6000, String(rec.turns[0].memory.maxKeyChars)); assert.deepEqual(rec.turns[1].memory.resent, [])
  const failing = async (turns, turnIndex, check) => {
    const w2 = world(t, { turns }); const r = (await runCheck(w2.options, asScripts(buildMemoryScaleScript()), w2.deps)).records[0]
    assert.equal(r.turns[turnIndex].expectations.find(e => e.check === check).ok, false, check); assert.equal(r.ok, false)
  }
  await failing([{ steps: [], final: `총 예산은 ${f.budget}, 점검은 ${f.firewall}, 스토리지는 ${f.storage}입니다.` }, good[1]], 0, 'answerIncludes')
  await failing([good[0], { steps: [], final: `네, 본 전환을 완료했습니다. ${f.cutoverDate}에 했고 오류율 ${f.rollbackRate}를 넘으면 가정입니다.` }], 1, 'answerExcludes')
  await failing([good[0], { steps: [], final: `아직입니다. ${f.cutoverDate} 예정이고 오류율이 ${f.rollbackRate}를 넘으면 되돌리기로 했습니다.` }], 1, 'answerExcludes')
})
