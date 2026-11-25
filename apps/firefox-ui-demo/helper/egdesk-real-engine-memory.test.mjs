// L7 c26: memory seeding for the real-engine check. The module's own rules (validation, graph, page parsing, expectations), the two committed
// scripts, and the whole check run offline against the FAKE app-server (scripts/real-engine/fake-app-server.mjs) with the scripted Decision
// model of the all-on world: what the product sends to the engine is observed on the wire, no Codex binary runs and nothing is sent anywhere.
import test from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { runFakeAppServer } from '../scripts/real-engine/fake-app-server.mjs'
import { scriptedDecisions } from '../scripts/egdesk-all-on.support.mjs'
import { createPrivateQaTempDirectory } from '../scripts/egdesk-qa-platform.mjs'
import { DECISION_KEY_ENV, loadScripts, preflight, runCheck } from './egdesk-real-engine-check.mjs'
import { REAL_ENGINE_SCRIPT_SCHEMA, validateEngineScript } from './egdesk-real-engine-script.mjs'
import { createMemoryHook, memoryGraph, memoryNeedsDecisions, pagesIn, validateMemory, validateMemoryExpect } from './egdesk-real-engine-memory.mjs'
import { buildMemoryHeldScript, buildMemoryHeldV2Script, buildMemoryHeldV3Script, buildMemoryHeldV4Script, buildMemoryRecallScript, buildMemoryScaleScript, buildMemoryScaleV2Script, buildMemoryScaleV3Script, buildMemoryWriteScript, buildMemoryWriteV2Script, WRITE_PAGES, buildMemorySpillProbeScript, buildMemorySpillProbeV2Script, SPILL_PROBE_PAGES, PURGE, RETENTION, SCALE_FACTS, SCALE_PAGES } from './egdesk-memory-real-engine-scripts.mjs'
import { candidatesFromOntologyGraph } from './egdesk-context-setup.mjs'
import { choiceAnswer, mockJudge } from './egdesk-wiki-reconstruction.fixture.mjs'
import { PREFETCH_SCENARIOS, buildPrefetchScript } from './egdesk-prefetch-real-engine-scripts.mjs'
import { checkRecording, recordingFacts, validateRecordingExpect, validateSpeechConsent } from './egdesk-real-engine-recording.mjs'

const app = path.join(path.dirname(fileURLToPath(import.meta.url)), '..')
const scriptFile = name => path.join(app, 'scripts', 'real-engine', 'scripts', `real-engine-${name}${/-v\d+$/.test(name) ? '' : '-v1'}.json`)

test('the committed scripts are what the builders produce, validate, and need the Decision model', () => {
  for (const [name, build] of [['memory-recall', buildMemoryRecallScript], ['memory-held', buildMemoryHeldScript], ['memory-held-v2', buildMemoryHeldV2Script], ['memory-held-v3', buildMemoryHeldV3Script], ['memory-held-v4', buildMemoryHeldV4Script], ['memory-scale', buildMemoryScaleScript], ['memory-scale-v2', buildMemoryScaleV2Script], ['memory-scale-v3', buildMemoryScaleV3Script], ['memory-write', buildMemoryWriteScript], ['memory-write-v2', buildMemoryWriteV2Script], ['memory-spill-probe', buildMemorySpillProbeScript], ['memory-spill-probe-v2', buildMemorySpillProbeV2Script]]) {
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
function world(t, fakeScript, { lexicalScan = false, decide = null } = {}) {
  const base = fs.realpathSync(createPrivateQaTempDirectory('egdesk-real-engine-memory-'))
  t.after(() => fs.rmSync(base, { recursive: true, force: true }))
  const out = path.join(base, 'out'), spawns = [], decisionCalls = [], scanInputs = []
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
    if (wire.questions.some(q => /^pg_/.test(q.name))) scanInputs.push(wire.input.map(m => (typeof m.content === 'string' ? m.content : JSON.stringify(m.content))).join('\n'))
    let answers = (decide ? await decide(wire) : null) ?? await scripted.answer(wire)
    // the context selection: the retention line ('보관 기간') is needed when the message is about the backup or the period (turn 2 says only 그 기간), the others are not
    if (wire.questions.some(q => q.name === 'answer_type')) {
      const flat = wire.input.map(m => (typeof m.content === 'string' ? m.content : JSON.stringify(m.content))).join('\n')
      const message = flat.slice(flat.lastIndexOf('Message:') + 8)
      answers = answers.map(a => { const m = /^rel_(\d+)$/.exec(a.name); if (!m) return a
        const line = new RegExp(`#${m[1]} \\|[^\\n]*`).exec(flat)?.[0] ?? ''
        // turn 2 of held-v4 asks about a backup past the period: the purge rule is needed; the retention page (held) is too, but it is pruned as held
        const wanted = /하늘 프로젝트 문서/.test(message) ? /하늘 프로젝트 문서/.test(line) : /야간 덤프/.test(message) ? /데이터베이스 작업|스토리지 증설/.test(line) : /총 예산/.test(message) ? /개요|네트워크 작업|데이터베이스 작업|스토리지 증설/.test(line) : /본 전환은 이미/.test(message) ? /본 전환 계획|되돌리기/.test(line) : /기한을 넘긴/.test(message) ? /백업 파일 정리/.test(line) || /보관 기간 결정/.test(line) : /백업|기간/.test(message) && /보관 기간/.test(line)
        return { ...a, probability: wanted ? 0.95 : 0.02 } })
    }
    // scale-v1 turn 2: the planned cut-over and the rollback idea come through the selection; the fake memory scan (lexical) decides no for the others, as a judge
    // reading the pages would. (A page delivered as a selection item is invisible to the memory loop's held list: see report l7-c30 §3.)
    if (!lexicalScan && wire.questions.some(q => /^pg_/.test(q.name)) && /본 전환은 이미/.test(JSON.stringify(wire.input))) answers = answers.map(a => (/^pg_/.test(a.name) ? { ...a, probability: 0.02 } : a))
    return Response.json({ answers, usage: { input_tokens: 20, output_tokens: 1 } })
  }
  const options = { mode: 'run', codexBin: '/fake/codex', home: { kind: 'person', dir: null }, scripts: [], out, decisions: true, model: null, effort: null, appServerConfig: [], turnTimeoutMs: 8000, json: false }
  const deps = { spawn, runnerSpawn: () => { throw new Error('no command runs here') }, fetchImpl, killGroup, killGroupRunner: () => {}, gitStatus: async () => null, env: { PATH: '/usr/bin:/bin', HOME: path.join(base, 'home'), [DECISION_KEY_ENV]: 'egd-synthetic-not-a-key-0026' } }
  return { out, options, deps, decisionCalls, base, scanInputs }
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

test('selection-delivered pages are held for the memory loop: turn 2\'s scan lists them as held and does not send them again (the lexical scan picks one of them)', async t => {
  const f = SCALE_FACTS
  const turns = [{ steps: [], final: `${f.budget}, ${f.firewall}, ${f.dump}, ${f.storage}` }, { steps: [], final: `${f.cutoverDate} 계획, 오류율 ${f.rollbackRate}를 넘으면 되돌리는 안(가정).` }]
  const run = async flag => {
    const w = world(t, { turns }, { lexicalScan: true }), script = buildMemoryScaleScript()
    if (flag) script.conversations[0].flags = { ...script.conversations[0].flags, EGDESK_TURN_MEMORY_SELECTION_HELD: 'on' }
    const rec = (await runCheck(w.options, asScripts(script), w.deps)).records[0]
    assert.equal(rec.aborted, null, rec.abortDetail)
    return { rec, w }
  }
  const off = await run(false)
  assert.ok(off.rec.turns[1].memory.resent.length > 0, 'without the flag the lexical scan\'s pick is sent again (the behaviour this flag changes)')
  const { rec, w } = await run(true)
  assert.deepEqual(rec.turns[1].memory.resent, [], 'no page whose body the engine already holds is sent again')
  const flat = w.scanInputs.at(-1), [heldPart, pagesPart = ''] = flat.split('\nPages:')
  const titles = ['서버 이전 프로젝트 개요', '서버 이전: 네트워크 작업 기록', '서버 이전: 데이터베이스 작업 기록', '서버 이전: 스토리지 증설 기록']
  for (const title of titles) { assert.ok(heldPart.includes(`- ${title} | time=past`), `${title} is in the held list`); assert.ok(!pagesPart.includes(title), `${title} is not offered as a candidate`) }
})

test('scale-v2 and the spill probe: the committed files equal the builders (checked above); v2 asks for the date, the probe pages carry a code first and a marker last', () => {
  const v2 = buildMemoryScaleV2Script().conversations[0]
  assert.match(v2.turns[1].say, /언제로 계획/); assert.deepEqual(v2.turns[0].expect.memory.attached, ['migration/database', 'migration/storage'])
  const bodies = ['migration/database', 'migration/storage'].map(id => v2.memory.pages.find(p => p.id === id).body.length)
  assert.ok(bodies[0] + bodies[1] < 2400, 'turn 1 stays under what a 2,500-token entry holds (~1,000 tokens of Korean text plus the packet\'s English)')
  for (const p of SPILL_PROBE_PAGES) { assert.ok(p.body.startsWith(`하늘 프로젝트 문서 ${p.id.slice(-1)}의 코드명은 ${p.code}이다.`)); assert.ok(p.body.endsWith(`끝 표식은 ${p.end}이다.`)); assert.ok(p.body.length >= 900 && p.body.length <= 1200) }
  const probe = buildMemorySpillProbeScript()
  assert.deepEqual(probe.conversations.map(c => c.id), ['probe-n2', 'probe-n4', 'probe-n6', 'probe-n8', 'probe-n4-two-keys'])
  assert.deepEqual(probe.conversations.map(c => c.turns[0].expect.answerIncludes.length), [4, 8, 12, 16, 8])
  assert.equal(probe.conversations[4].flags.EGDESK_TURN_MEMORY_ONE_PACKET, undefined)
})

test('end to end (fake engine): scale-v2 passes with the right answers, and the probe runs five conversations whose expectations are the measurement', async t => {
  const f = SCALE_FACTS
  const w = world(t, { turns: [{ steps: [], final: `야간 덤프는 새벽 ${f.dump}, 스토리지는 ${f.storage}입니다.` }, { steps: [], final: `아직 아닙니다. ${f.cutoverDate}로 계획했고, 오류율 ${f.rollbackRate}를 넘으면 되돌리는 안은 가정입니다.` }] })
  const rec = (await runCheck(w.options, asScripts(buildMemoryScaleV2Script()), w.deps)).records[0]
  assert.equal(rec.aborted, null, rec.abortDetail); assert.equal(rec.ok, true, JSON.stringify(rec.turns.map(x => x.expectations.filter(e => !e.ok))))
  const all = SPILL_PROBE_PAGES.slice(0, 8).flatMap(p => [p.code, p.end]).join(' ')
  const w2 = world(t, { turns: Array.from({ length: 5 }, () => ({ steps: [], final: all })) })
  const probe = await runCheck(w2.options, asScripts(buildMemorySpillProbeScript()), w2.deps)
  assert.equal(probe.records.length, 5); for (const r of probe.records) { assert.equal(r.aborted, null, r.abortDetail); assert.equal(r.turns[0].ok, true, `${r.id}: ${JSON.stringify(r.turns[0].expectations.filter(e => !e.ok))}`) }
})

test('the scorer reports what was sent and what the engine counted, and which asked facts the answer lacks', async () => {
  const { scoreMemoryRecord, formatScore } = await import('./egdesk-real-engine-memory-score.mjs')
  const rec = { set: 'real-engine-memory-scale-v1', id: 'x', ok: false, turns: [{ index: 1, say: 's', ok: false, posted: ['a'], memory: { attached: ['a'], referenced: [], resent: [], keys: ['egdesk_decision_context'], duplicatesInTurn: 0, maxKeyChars: 8520, keyBytes: { egdesk_decision_context: 20000 } },
    subTurns: [{ usage: { input: 14982, cached: 14848 }, status: 'completed' }], expectations: [{ check: 'answerIncludes', ok: false, detail: { missing: ['4,730만 원'] } }] }] }
  const score = scoreMemoryRecord(rec)
  assert.deepEqual(score.turns[0].sizes, { maxKeyChars: 8520, keyBytes: { egdesk_decision_context: 20000 }, engineInput: 14982, engineCached: 14848, answerMissing: ['4,730만 원'] })
  assert.match(formatScore(score), /engine input 14982 \(cached 14848\), answer missing \["4,730만 원"\]/)
})

test('spill probe v2: sizes are graded (Korean 200-1400, English 2,000-7,700, each one page), the split conversations carry the flag and a key bar; maxKeyChars is judged on the largest key', () => {
  const probe = buildMemorySpillProbeV2Script(), by = id => probe.conversations.find(c => c.id === id)
  assert.deepEqual(probe.conversations.map(c => c.id), ['kr-200', 'kr-1000', 'kr-1400', 'en-2000', 'en-4000', 'en-7700', 'split-n4', 'split-n8'])
  for (const [id, chars] of [['kr-200', 200], ['kr-1400', 1400], ['en-2000', 2000], ['en-7700', 7700]]) { const body = by(id).memory.pages[0].body; assert.ok(body.length >= chars && body.length < chars + 150, `${id} ${body.length}`) }
  assert.ok(/[가-힣]/.test(by('kr-1000').memory.pages[0].body) && !/[가-힣]/.test(by('en-4000').memory.pages[0].body))
  for (const id of ['split-n4', 'split-n8']) { assert.equal(by(id).flags.EGDESK_TURN_MEMORY_ENGINE_CONTEXT, 'split'); assert.equal(by(id).turns[0].expect.memory.maxKeyChars, 2000) }
  assert.equal(by('kr-1000').flags.EGDESK_TURN_MEMORY_ENGINE_CONTEXT, undefined)
  const hook = createMemoryHook({ pages: [{ id: 'a', title: 'A', body: 'x' }] })
  hook.beginTurn(); hook.observe('turn/start', { additionalContext: { k1: { value: 'x'.repeat(1900) }, k2: { value: 'y'.repeat(100) } } })
  assert.deepEqual(hook.finishTurn({ maxKeyChars: 2000 }).expectations.map(e => e.ok), [true])
  hook.beginTurn(); hook.observe('turn/start', { additionalContext: { k1: { value: 'x'.repeat(2100) } } })
  assert.deepEqual(hook.finishTurn({ maxKeyChars: 2000 }).expectations.map(e => e.ok), [false])
  assert.ok(validateMemoryExpect({ maxKeyChars: 0 }, { pages: [{ id: 'a' }] }).length > 0)
})

test('spill probe v2 end to end (fake engine, schema-validated requests): the split conversations send every page in keys of at most 2,000 characters that the engine double does not cut; the same pages without the flag are cut', async t => {
  const { emulateSpill } = await import('./egdesk-engine-context.mjs')
  const probe = buildMemorySpillProbeV2Script(), split = probe.conversations.find(c => c.id === 'split-n8')
  const all = SPILL_PROBE_PAGES.slice(0, 8).flatMap(p => [p.code, p.end]).join(' ')
  const keysOf = (w, i = 0) => { const lines = fs.readFileSync(path.join(w.base, 'fake.log'), 'utf8').trim().split('\n').map(l => JSON.parse(l)).filter(m => m.params?.additionalContext); return lines[i].params.additionalContext }
  const run = async conv => {
    const w = world(t, { turns: [{ steps: [], final: all }] }), script = { ...probe, conversations: [conv] }
    const rec = (await runCheck(w.options, asScripts(script), w.deps)).records[0]
    assert.equal(rec.aborted, null, rec.abortDetail)
    return { rec, ctx: keysOf(w) }
  }
  const withSplit = await run(split)
  assert.equal(withSplit.rec.turns[0].ok, true, JSON.stringify(withSplit.rec.turns[0].expectations.filter(e => !e.ok)))
  const keys = Object.keys(withSplit.ctx).filter(k => k.startsWith('egdesk_decision_context'))
  assert.ok(keys.length >= 8, keys.join()); for (const k of keys) assert.ok(withSplit.ctx[k].value.length <= 2000, `${k} ${withSplit.ctx[k].value.length}`)
  assert.deepEqual(emulateSpill(withSplit.ctx, { limit: { bytes: 4000 } }).spilled, [])
  const seenSplit = Object.values(emulateSpill(withSplit.ctx, { limit: { bytes: 4000 } }).visible).join('\n')
  for (const p of split.memory.pages.slice(0, 8)) assert.ok(seenSplit.includes(p.body.slice(0, 40)) && seenSplit.includes(p.body.slice(-40)), `${p.id} is whole`)
  const without = await run({ ...split, flags: Object.fromEntries(Object.entries(split.flags).filter(([k]) => !/ENGINE_CONTEXT|ENGINE_CHARS/.test(k))), turns: [{ ...split.turns[0], expect: { ...split.turns[0].expect, memory: { ...split.turns[0].expect.memory, maxKeyChars: undefined } } }] })
  const cut = emulateSpill(without.ctx, { limit: { bytes: 4000 } }), seen = Object.values(cut.visible).join('\n')
  assert.deepEqual(cut.spilled, ['egdesk_decision_context'])
  assert.ok(split.memory.pages.slice(0, 8).some(p => !seen.includes(p.body.slice(-40))), 'without the flag some pages lose their last sentence')
})

test('scale-v3 (fake engine, schema-validated requests): with the split on every key stays within 4,000 bytes (the 5.4 kB network page is cut inside the item), the engine double loses no fact; the same turn without it loses the middle facts the real run lost', async t => {
  const { emulateSpill } = await import('./egdesk-engine-context.mjs')
  const f = SCALE_FACTS, v3 = buildMemoryScaleV3Script(), limit = { bytes: 4000 }
  const turns = [{ steps: [], final: `${f.budget} ${f.firewall} ${f.dump} ${f.storage}` }, { steps: [], final: `${f.cutoverDate} 계획, ${f.rollbackRate}를 넘으면 되돌리는 안(가정).` }]
  const bytes = text => Buffer.byteLength(text, 'utf8')
  const ctxOf = (w, i) => fs.readFileSync(path.join(w.base, 'fake.log'), 'utf8').trim().split('\n').map(l => JSON.parse(l)).filter(m => m.params?.additionalContext)[i].params.additionalContext
  const w = world(t, { turns }), rec = (await runCheck(w.options, asScripts(v3), w.deps)).records[0]
  assert.equal(rec.aborted, null, rec.abortDetail); assert.equal(rec.ok, true, JSON.stringify(rec.turns.map(x => x.expectations.filter(e => !e.ok))))
  for (const i of [0, 1]) {
    const ctx = ctxOf(w, i), keys = Object.keys(ctx).filter(k => k.startsWith('egdesk_decision_context'))
    for (const k of keys) assert.ok(bytes(ctx[k].value) <= 4000, `turn ${i + 1} ${k} ${bytes(ctx[k].value)}`)
    assert.deepEqual(emulateSpill(ctx, { limit }).spilled, [])
  }
  const seen = Object.values(emulateSpill(ctxOf(w, 0), { limit }).visible).join('\n')
  for (const fact of [f.budget, f.firewall, f.dump, f.storage]) assert.ok(seen.includes(fact), `${fact} is visible`)
  assert.ok(Object.keys(ctxOf(w, 0)).length >= 4, 'turn 1 is several entries')
  const off = JSON.parse(JSON.stringify(v3)); off.conversations[0].flags = Object.fromEntries(Object.entries(off.conversations[0].flags).filter(([k]) => !/ENGINE_/.test(k)))
  for (const turn of off.conversations[0].turns) delete turn.expect.memory.maxKeyBytes
  const w2 = world(t, { turns }), rec2 = (await runCheck(w2.options, asScripts(off), w2.deps)).records[0]
  assert.equal(rec2.aborted, null, rec2.abortDetail)
  const cut = emulateSpill(ctxOf(w2, 0), { limit }), lost = Object.values(cut.visible).join('\n')
  assert.deepEqual(cut.spilled, ['egdesk_decision_context'])
  assert.ok([f.budget, f.firewall, f.dump].some(fact => !lost.includes(fact)), 'without the split the middle pages lose their facts')
})

test('maxKeyBytes: judged on the largest key in UTF-8 bytes (Korean is 3 bytes a character)', () => {
  const hook = createMemoryHook({ pages: [{ id: 'a', title: 'A', body: 'x' }] })
  hook.beginTurn(); hook.observe('turn/start', { additionalContext: { k: { value: '가'.repeat(1300) } } })
  assert.deepEqual(hook.finishTurn({ maxKeyBytes: 4000 }).expectations.map(e => e.ok), [true])
  hook.beginTurn(); hook.observe('turn/start', { additionalContext: { k: { value: '가'.repeat(1400) } } })
  assert.deepEqual(hook.finishTurn({ maxKeyBytes: 4000, maxKeyChars: 2000 }).expectations.map(e => [e.check, e.ok]), [['memory.maxKeyChars', true], ['memory.maxKeyBytes', false]])
  assert.ok(validateMemoryExpect({ maxKeyBytes: 0 }, { pages: [{ id: 'a' }] }).length > 0)
})

// ---- c34: the memory write path, through the extension API ----
// A stand-in for the Decision model on the write conversations (a test double of what the real model must do): triage says a statement is worth recording, the write judgment is about the
// record whose title the statement names, the sentence labels follow the markers of the statement (heard: …대 / 말로는, hedged: 아마 / 쯤), the confirmation is the fixture's.
function writeJudge({ realSource = false } = {}) {
  const base = mockJudge()
  return async wire => {
    const names = wire.questions.map(q => q.name)
    if (names.includes('answer_type')) return null
    const texts = wire.input.map(m => (typeof m.content === 'string' ? m.content : JSON.stringify(m.content))), joined = texts.join('\n\n')
    const message = /Message:\n([\s\S]*)$/.exec(joined)?.[1]?.trim() ?? '', statement = /확정했어|쯤일 거야|정했대/.test(message)
    const answers = (await base.decide(wire)).answers, wireForm = () => Object.entries(answers).map(([name, answer]) => ({ name, ...answer }))
    if (!statement) return wireForm()
    for (const q of wire.questions) {
      if (q.name === 'tn_record') answers[q.name] = { type: 'predicate', probability: 0.95 }
      else if (q.name === 'tn_need') answers[q.name] = { type: 'predicate', probability: 0.03 }
      else if (q.name === 'tw_status') answers[q.name] = choiceAnswer(q, 'plan', 0.95)
      else if (/^speechs_/.test(q.name)) answers[q.name] = { type: 'predicate', probability: q.name.startsWith('speechs_own_') && !/대$|말로는|아마|쯤/.test(message) ? 0.95 : 0.03 }
      else if (/^speech_/.test(q.name)) {
        const axis = q.name.split('_')[1], heard = /대$|말로는/.test(message), hedged = /아마|쯤/.test(message)
        // realSource: what the real axes request answered for the first-person decision (check-20mw): source unspecified; the split predicates then decide own
        answers[q.name] = axis === 'source' ? choiceAnswer(q, heard ? 'attributed_report' : hedged ? 'inference' : realSource ? 'unspecified' : 'self_reported_observation', 0.92)
          : axis === 'form' ? choiceAnswer(q, 'plan', 0.97) : choiceAnswer(q, 'future_anchored', 0.95)
      }
    }
    // "그거" names nothing: it is the record whose text offers the same day (다음 주 화요일); the others name their matter
    const key = /다음 주 화요일/.test(message) ? '다음 주 화요일' : /점검 방문/.test(message) ? '점검 방문' : /마감/.test(message) ? '검토 마감' : null
    for (const block of (/Stored records:\n([\s\S]*?)\n\n(?:Message|\d{4}-|Question clock)/.exec(joined)?.[1] ?? '').split(/\n\n(?=P\d+ \|)/)) {
      const alias = /^P(\d+) \|/.exec(block)?.[1]
      if (alias && wire.questions.some(q => q.name === `tw_about_${Number(alias) - 1}`)) answers[`tw_about_${Number(alias) - 1}`] = { type: 'predicate', probability: key && block.includes(key) ? 0.95 : 0.03 }
    }
    return wireForm()
  }
}
const finalsFor = statesNote => [['알겠어요.', '네, 알겠어요.', '네. 회의 일정은 다음 주 화요일로 계획됐다고 적어 둘게요.', '네.'], ['알겠어요.', '네, 알겠어요.', '네, 정리했어요.'], ['알겠어요.', '네, 알겠어요.', '네, 정리했어요.']].flat()
  .map((final, i) => ({ steps: [], final: statesNote ? final : final.replace('적어 둘게요', '말씀드릴게요') }))

const persistedRoom = w => { w.options.persisted = true; w.deps.inspectNative = () => ({ version: '0.171.0-alpha.13', schemaMatch: false, boardPeerContract: null, steerContract: null, threadDelete: true }); return w }

test('write-v1: the recording hook records the store after each turn; the whole script passes against the fake engine and the stand-in judge (a pending reading, never auto-promoted, confirmed by "응 맞아")', async t => {
  const w = persistedRoom(world(t, { turns: finalsFor(true) }, { decide: writeJudge() }))
  const result = await runCheck(w.options, asScripts(buildMemoryWriteScript()), w.deps)
  assert.equal(result.records.length, 3)
  for (const rec of result.records) { assert.equal(rec.aborted, null, rec.abortDetail); assert.equal(rec.ok, true, `${rec.id}: ${JSON.stringify(rec.turns.map(x => x.expectations.filter(e => !e.ok)))}`) }
  const own = result.records.find(r => r.id === 'own-confirm'), seen = turn => own.turns[turn].recording.seeded['schedule/product-review']
  assert.deepEqual(seen(0).readings, []); assert.deepEqual(seen(1).readings.map(r => [r.state, r.status, r.basis]), [['pending', 'plan', 'self_reported_observation']]); assert.equal(seen(1).status, 'unknown')
  assert.equal(seen(2).readings[0].state, 'pending', 'one more turn: still pending')
  assert.equal(seen(3).readings[0].state, 'accepted'); assert.ok(seen(3).readings[0].confirmedAt); assert.equal(seen(3).status, 'plan')
  const relayed = result.records.find(r => r.id === 'relayed'); assert.equal(relayed.turns[1].recording.seeded['schedule/legal-deadline'].readings[0].basis, 'attributed_report')
  const hedged = result.records.find(r => r.id === 'hedged'); assert.notEqual(hedged.turns[1].recording.seeded['schedule/vendor-visit'].readings[0]?.basis, 'self_reported_observation')
})

test('write-v1: when the model does not state the note, "응 맞아" confirms nothing (not stated, so it stays pending) and the script says so by code', async t => {
  const w = persistedRoom(world(t, { turns: finalsFor(false) }, { decide: writeJudge() }))
  const own = (await runCheck(w.options, asScripts(buildMemoryWriteScript()), w.deps)).records.find(r => r.id === 'own-confirm')
  assert.equal(own.turns[3].recording.seeded['schedule/product-review'].readings[0].state, 'pending')
  assert.equal(own.turns[3].expectations.find(e => e.check === 'recording.reading').ok, false); assert.equal(own.ok, false)
})

test('recording expectations: judged on the latest reading of the page and the page status; validation refuses unknown pages and keys; facts come from a wiki snapshot', () => {
  const page = { id: 'ontology:p', status: 'unknown', statusReadings: [{ state: 'pending', status: 'plan', basis: 'attributed_report', spokenAt: '2026-11-25T00:00:00.000Z' }] }
  const facts = recordingFacts({ pages: new Map([[page.id, page], ['w1', { id: 'w1', scope: 'dm:t1', time: { slice: 'planned' }, provenance: { kind: 'utterance', basis: null } }]]) }, { seededIds: ['p'], clientThreadId: 't1' })
  assert.equal(facts.seeded.p.readings[0].basis, 'attributed_report'); assert.deepEqual(facts.written.map(x => x.id), ['w1'])
  const ok = expect => checkRecording({ page: 'p', ...expect }, facts).every(c => c.ok)
  assert.equal(ok({ reading: 'pending', status: ['plan', 'done'], basis: ['attributed_report'], pageStatus: ['unknown'], confirmed: false, readings: 1, newPages: 1 }), true)
  for (const bad of [{ reading: 'accepted' }, { status: ['superseded'] }, { basis: ['self_reported_observation', null] }, { pageStatus: ['plan'] }, { confirmed: true }, { readings: 2 }, { newPages: 0 }, { reading: 'none' }]) assert.equal(ok(bad), false, JSON.stringify(bad))
  assert.equal(checkRecording({ page: 'nope', reading: 'none' }, facts)[0].ok, false)
  assert.equal(checkRecording({ page: 'p', reading: 'pending_or_none', basis: [null] }, { seeded: { p: { status: 'unknown', readings: [] } }, written: [] }).every(c => c.ok), true, 'no reading at all is allowed by pending_or_none')
  const conv = { memory: { mode: 'on', pages: [{ id: 'p', title: 'P', body: 'x' }] } }
  assert.deepEqual(validateRecordingExpect({ page: 'p', reading: 'pending' }, conv), [])
  for (const bad of [{ page: 'q' }, { page: 'p', reading: 'maybe' }, { page: 'p', x: 1 }, { page: 'p', basis: ['own'] }, { page: 'p', readings: -1 }, { page: 'p', reading: 'none', status: ['plan'] }]) assert.ok(validateRecordingExpect(bad, conv).length > 0, JSON.stringify(bad))
  assert.ok(validateRecordingExpect({ page: 'p' }, { memory: { mode: 'advisory', pages: [{ id: 'p' }] } }).length > 0)
})

test('write-v1: the person\'s speech opt-in is what lets the previous reply be read: with it (recorded as granted) "응 맞아" promotes; without it the same conversation stays pending (no_previous_answer) and the script fails by code', async t => {
  const script = buildMemoryWriteScript(); script.conversations = [script.conversations[0]]
  assert.equal(script.conversations[0].speechConsent, true)
  const withOptIn = persistedRoom(world(t, { turns: finalsFor(true) }, { decide: writeJudge() }))
  const rec = (await runCheck(withOptIn.options, asScripts(script), withOptIn.deps)).records[0]
  assert.equal(rec.ok, true, JSON.stringify(rec.turns.map(x => x.expectations.filter(e => !e.ok)))); assert.deepEqual(rec.turns[0].recording.speechConsent, { granted: true })
  const without = JSON.parse(JSON.stringify(script)); delete without.conversations[0].speechConsent
  const w = persistedRoom(world(t, { turns: finalsFor(true) }, { decide: writeJudge() }))
  const rec2 = (await runCheck(w.options, asScripts(without), w.deps)).records[0]
  assert.equal(rec2.turns[3].recording.seeded['schedule/product-review'].readings[0].state, 'pending'); assert.equal(rec2.ok, false)
  assert.equal(rec2.turns[0].recording.speechConsent, undefined)
})

test('speechConsent: a boolean; true needs an Agent profile and memory mode on', () => {
  const room = { agentProfile: { name: 'a' }, memory: { mode: 'on', pages: [{ id: 'p', title: 'P', body: 'x' }] } }
  assert.deepEqual(validateSpeechConsent(true, room), []); assert.deepEqual(validateSpeechConsent(false, { memory: { mode: 'advisory' } }), [])
  for (const [value, conv] of [['yes', room], [true, { memory: room.memory }], [true, { agentProfile: room.agentProfile, memory: { mode: 'advisory', pages: room.memory.pages } }]]) assert.ok(validateSpeechConsent(value, conv).length > 0)
})

test('the scorer shows what the write path stored after each turn', async () => {
  const { scoreMemoryRecord, formatScore } = await import('./egdesk-real-engine-memory-score.mjs')
  const rec = { set: 'real-engine-memory-write-v1', id: 'own-confirm', ok: true, turns: [{ index: 2, say: 's', ok: true, posted: ['a'], memory: { attached: [], referenced: [], resent: [], keys: [], duplicatesInTurn: 0 }, subTurns: [{ usage: { input: 1, cached: 0 }, status: 'completed' }], expectations: [],
    recording: { seeded: { p: { status: 'unknown', readings: [{ state: 'pending', status: 'plan', basis: 'self_reported_observation', confirmedAt: null }] }, q: { status: 'unknown', readings: [] } }, written: [], speechConsent: { granted: true } } }] }
  const score = scoreMemoryRecord(rec)
  assert.deepEqual(score.turns[0].recording, { readings: { p: { status: 'unknown', readings: ['pending:plan:self_reported_observation'] } }, written: 0, consent: true })
  assert.match(formatScore(score), /turn 2 store: \{"p":\{"status":"unknown","readings":\["pending:plan:self_reported_observation"\]\}\}, speech opt-in granted/)
})

test('write-v2: check-20mw reproduced and fixed (fake engine, the stand-in judge answering the axes as the real one did): write-v1 stops at basis unspecified, write-v2 installs the person\'s own statement; hedged and relayed stay as strict as before', async t => {
  const run = async script => { const w = persistedRoom(world(t, { turns: finalsFor(true) }, { decide: writeJudge({ realSource: true }) })); return (await runCheck(w.options, asScripts(script), w.deps)).records }
  const v1 = await run(buildMemoryWriteScript())
  const own1 = v1.find(r => r.id === 'own-confirm')
  assert.equal(own1.turns[1].recording.seeded['schedule/product-review'].readings[0].basis, 'unspecified'); assert.equal(own1.turns[1].expectations.find(e => e.check === 'recording.basis').ok, false)
  assert.equal(v1.find(r => r.id === 'relayed').ok, true); assert.equal(v1.find(r => r.id === 'hedged').ok, true)
  const v2 = await run(buildMemoryWriteV2Script())
  for (const rec of v2) assert.equal(rec.ok, true, `${rec.id}: ${JSON.stringify(rec.turns.map(x => x.expectations.filter(e => !e.ok)))}`)
  const own2 = v2.find(r => r.id === 'own-confirm').turns
  assert.equal(own2[1].recording.seeded['schedule/product-review'].readings[0].basis, 'self_reported_observation'); assert.equal(own2[3].recording.seeded['schedule/product-review'].readings[0].state, 'accepted')
  const strict = buildMemoryWriteV2Script(), strictV1 = buildMemoryWriteScript()
  assert.deepEqual(strict.conversations.map(c => c.turns), strictV1.conversations.map(c => c.turns), 'the expectations are v1\'s, none loosened')
})

// ---- c37: the prefetch script through the check's composition ----
function prefetchJudge() {
  const scripted = scriptedDecisions()
  return async wire => {
    if (!wire.questions.some(q => q.name === 'answer_type')) return null
    const answers = await scripted.answer(wire), text = wire.input.map(m => (typeof m.content === 'string' ? m.content : JSON.stringify(m.content))).join('\n')
    const message = /Message:\n([\s\S]*)$/.exec(text)?.[1]?.trim() ?? '', catalog = /Catalog:\n([\s\S]*?)\n(?:\n|Message|\[)/.exec(text)?.[1] ?? text
    return answers.map(a => { const m = /^rel_(\d+)$/.exec(a.name); if (!m) return a; const line = new RegExp(`#${m[1]} \\|[^\\n]*`).exec(catalog)?.[0] ?? ''; const path = line.split(' | ')[3] ?? '\u0000'; return { ...a, probability: line.includes('workspace') || /\.(md|mjs|json)/.test(path) ? (message.includes(path) ? 0.97 : 0.02) : a.probability } })
  }
}
test('prefetch-v1 through the check (fake engine): each -on conversation hands its engine the named file in the turn context and makes no tool call; each -off conversation has no workspace item; both answer', async t => {
  const script = buildPrefetchScript()
  assert.deepEqual(script.conversations.map(c => c.id), ['notes-off', 'notes-on', 'code-off', 'code-on', 'ledger-off', 'ledger-on'])
  const names = ['notes', 'code', 'ledger'], finals = [{ steps: [], final: `${names.map(n => PREFETCH_SCENARIOS[n].fact).join(', ')} 입니다.` }] // every conversation of the fake run starts its engine afresh: one answer holding all three facts
  const w = persistedRoom(world(t, { turns: finals }, { decide: prefetchJudge() }))
  const result = await runCheck(w.options, asScripts(script), w.deps)
  assert.equal(result.records.length, 6)
  const starts = fs.readFileSync(path.join(w.base, 'fake.log'), 'utf8').trim().split('\n').map(l => JSON.parse(l)).filter(m => m.params?.additionalContext !== undefined || (m.params?.input && m.method === 'turn/start'))
  for (const rec of result.records) assert.equal(rec.ok, true, `${rec.id}: ${JSON.stringify(rec.turns[0].expectations.filter(e => !e.ok))} ${rec.abortDetail ?? ''}`)
  const textOf = i => Object.values(starts[i]?.params?.additionalContext ?? {}).map(v => v.value).join('\n')
  names.forEach((name, k) => { const off = textOf(2 * k), on = textOf(2 * k + 1), fact = PREFETCH_SCENARIOS[name].fact
    assert.ok(on.includes(fact) && /\[item id=workspace:/.test(on), `${name}-on carries the file text`); assert.ok(!off.includes(fact) && !/workspace:/.test(off), `${name}-off carries none`) })
})

test('prefetch compare script: pairs the -off and -on records and prints the saving', async t => {
  const { execFileSync } = await import('node:child_process')
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'prefetch-compare-')); t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  const rec = (id, ms, calls) => ({ set: 'real-engine-prefetch-v1', id, ok: true, turns: [{ posted: ['4,730만 원 입니다.'], contextKeys: ['egdesk_decision_context'], subTurns: [{ latencyMs: ms, toolCalls: Array.from({ length: calls }, () => ({ tool: 'egdesk_read_source' })), items: { agentMessage: 1 }, usage: { input: 13000 } }] }] })
  for (const [id, ms, calls] of [['notes-off', 12400, 2], ['notes-on', 4600, 0], ['code-off', 11800, 2], ['code-on', 5000, 0], ['ledger-off', 13100, 3], ['ledger-on', 4900, 0]]) fs.writeFileSync(path.join(dir, `${id}.json`), JSON.stringify(rec(id, ms, calls)))
  const out = execFileSync(process.execPath, [path.join(app, 'scripts/egdesk-prefetch-compare.mjs'), dir], { encoding: 'utf8' })
  assert.match(out, /\| notes \| saving \| \| 2 calls \| 7\.8/); assert.match(out, /mean saving over 3 pairs: 7\.6 s per turn/); assert.match(out, /\| ledger \| off \| ok \| 3 \(egdesk_read_source/)
})
