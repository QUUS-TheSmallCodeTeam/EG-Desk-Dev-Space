// L4 cycle 31: the briefing flow inside lane L5's real-engine check, as a hook (helper/egdesk-real-engine-briefing-hook.mjs, registered in helper/egdesk-real-engine-hooks.mjs).
// End to end against the FAKE app-server of scripts/real-engine/fake-app-server.mjs (0.171 protocol subset, every message schema-checked): the check's own runtime, the
// production Board/Decisions handler, the fake's private fork turn as the subjective model, a scripted Decision model. No Codex binary, no network, no real key.
import test from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { runFakeAppServer } from '../scripts/real-engine/fake-app-server.mjs'
import { BRIDGE_COMPOSITION, DECISION_DEPENDENT_FLAGS, DECISION_KEY_ENV, preflight, runCheck } from './egdesk-real-engine-check.mjs'
import { validateEngineScript } from './egdesk-real-engine-script.mjs'
import { BOARD_SAY, PROGRESS_ENTRIES, buildBoardScript } from './egdesk-briefing-real-engine-script.mjs'
import { BRIEFING_FLAGS, boardText, briefingHook, checkBriefingExpect, folderMaterials, validateBriefingExpect } from './egdesk-real-engine-briefing-hook.mjs'
import { CHECK_HOOKS, hookDecisionFlags, hookFlags } from './egdesk-real-engine-hooks.mjs'
import { createPrivateQaTempDirectory } from '../scripts/egdesk-qa-platform.mjs'

const tmp = t => { const base = fs.realpathSync(createPrivateQaTempDirectory('egdesk-real-engine-briefing-')); t.after(() => fs.rmSync(base, { recursive: true, force: true })); return base }

// ---- the fake model: the answer (reads the three notes), and the private fork turn that fills the guide it is given ----
const NOTES = PROGRESS_ENTRIES.map(e => e.file)
const ANSWER = '진행 상황을 날짜 순서로 정리했습니다. 11-20 로그인 화면 병합(커밋 a1b2c3d, 테스트 120건), 11-22 결제 모듈 병합(커밋 e4f5a6b, 테스트 98건), 11-24 검색 화면 착수. 남은 일은 알림 설정 구현, 검색 성능 점검, 배포 체크리스트 작성입니다.'
const block = (text, label, next) => JSON.parse(new RegExp(`${label}:\\n(.*)\\n\\n${next}`, 's').exec(text)[1])
/** A fill built from the prompt itself: every text is a line of the material the item cites (as a faithful model copies it). */
function fillFrom(prompt) {
  const guide = block(prompt, 'Design guide \\(decided; do not change it\\)', 'Materials'), materials = block(prompt, 'Materials', 'Rules')
  const line = (alias, max = 90) => String(materials.find(m => m.alias === alias)?.text ?? '').slice(0, max)
  const rowFor = (fields, alias) => Object.fromEntries(fields.map(f => [f.name, f.type === 'material' ? alias : line(alias, f.max ?? 40) || f.name]))
  const slot = (s, item) => (s.type === 'text' ? line(item.materials[0], s.max ?? 60) || s.name : s.type === 'material' ? item.materials[s.name === 'right' ? 1 : 0] ?? item.materials[0]
    : item.materials.slice(0, s.max ?? 6).map(alias => rowFor(s.of, alias)))
  return { title: '진행 정리', unfillable: [], items: Object.fromEntries(guide.items.map(i => [i.id, { text: line(i.materials[0], 200) || i.id, fallback: '카드를 열어 보세요.', slots: Object.fromEntries(i.slots.map(s => [s.name, slot(s, i)])) }])) }
}
const FILL_PLAN = (mode = 'json') => ({ steps: [], finalFor: text => { const fill = JSON.stringify(fillFrom(text)); return mode === 'fenced' ? `Here you go:\n\`\`\`json\n${fill}\n\`\`\`` : mode === 'prose' ? 'I could not make a board of this.' : fill } })
const fakeFor = mode => ({ turns: [
  { steps: [...NOTES.map(file => ({ toolCall: { tool: 'egdesk_read_file', arguments: { path: file } } })), { usage: { input: 23200, cached: 22900, output: 60, reasoning: 0 } }], final: ANSWER },
  { steps: [], final: '더 필요하면 말해주세요.' }],
forkTurns: [FILL_PLAN(mode), FILL_PLAN(mode), FILL_PLAN(mode)] })

const DEFAULT_P = name => (name === 'several' ? .96 : name === 'one_sentence' ? .03 : name.startsWith('about_') ? .96 : name.startsWith('same_') ? .03 : /^(?:aspect|happened|todo|fact)_/.test(name) ? .95 : name.startsWith('before_') ? .9 : name.startsWith('slot_') ? .97 : .96)

function world(t, fakeScript, { decisions = true } = {}) {
  const base = tmp(t), out = path.join(base, 'out'), codexHome = path.join(base, 'codex-home'); fs.mkdirSync(codexHome)
  const spawns = [], decisionBodies = [], stderrLines = []
  const spawn = (bin, argv, options) => {
    const stdin = new PassThrough(), stdout = new PassThrough(), stderr = new PassThrough(), child = new EventEmitter()
    Object.assign(child, { pid: 4242 + spawns.length, stdin, stdout, stderr, exitCode: null, signalCode: null, kill: () => true }); spawns.push({ bin, argv, options })
    runFakeAppServer({ script: fakeScript, log: path.join(base, 'fake-app-server.log'), input: stdin, output: stdout, stderr: { write: line => { stderrLines.push(line); stderr.write(line) } }, env: options.env, exit: code => { child.exitCode = code; child.emit('close', code, null) } })
    return child
  }
  const killGroup = async child => { child.stdin.end(); await new Promise(resolve => { if (child.exitCode != null) return resolve(); child.once('close', resolve); setTimeout(resolve, 500) }); return { signal: 'SIGTERM' } }
  const fetchImpl = async (url, init) => {
    const body = JSON.parse(init.body); decisionBodies.push(body)
    return Response.json({ answers: body.questions.map(q => ({ name: q.name, type: 'predicate', probability: DEFAULT_P(q.name) })), usage: { input_tokens: 20 } })
  }
  const options = { mode: 'run', codexBin: '/fake/codex', home: { kind: 'person', dir: null }, scripts: [], out, decisions, model: null, effort: null, appServerConfig: [], turnTimeoutMs: 15000, json: false }
  const deps = { spawn, runnerSpawn: () => { throw new Error('no command runs in this test') }, fetchImpl, killGroup, killGroupRunner: () => {}, gitStatus: async () => null, env: { PATH: '/usr/bin:/bin', HOME: path.join(base, 'home'), [DECISION_KEY_ENV]: 'egd-synthetic-not-a-key-0031' } }
  return { base, options, deps, decisionBodies, stderrLines, wire: () => fs.readFileSync(path.join(base, 'fake-app-server.log'), 'utf8').trim().split('\n').map(line => JSON.parse(line)) }
}
const asScripts = (...scripts) => scripts.map(script => ({ file: `${script.set}.json`, script }))
const turnStarts = w => w.wire().filter(m => m.dir === 'in' && m.method === 'turn/start')

test('the registration point: the check lists the briefing flags and the decision-dependent one from the hook; the committed v2 script validates and is the builder\'s', () => {
  assert.deepEqual(CHECK_HOOKS.map(h => h.name), ['briefing']); assert.deepEqual(hookFlags(), [...BRIEFING_FLAGS]); assert.deepEqual(hookDecisionFlags(), ['EGDESK_BRIEFING_FLOW'])
  for (const flag of BRIEFING_FLAGS) assert.ok(BRIDGE_COMPOSITION.flags.includes(flag) && !BRIDGE_COMPOSITION.notReproduced.flags.includes(flag), `${flag} is reproduced now, not listed as missing`)
  assert.ok(DECISION_DEPENDENT_FLAGS.includes('EGDESK_BRIEFING_FLOW'))
  const v2 = JSON.parse(fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'scripts', 'real-engine', 'scripts', 'real-engine-briefing-progress-v2.json'), 'utf8'))
  assert.deepEqual(v2, JSON.parse(JSON.stringify(buildBoardScript()))); assert.deepEqual(validateEngineScript(v2), { ok: true, errors: [] })
  assert.deepEqual(v2.conversations.map(c => c.id), ['briefing-schema-on', 'briefing-schema-off'])
  assert.deepEqual(v2.conversations.map(c => c.flags), [{ EGDESK_BRIEFING_FLOW: 'on', EGDESK_BRIEFING_OUTPUT_SCHEMA: 'on' }, { EGDESK_BRIEFING_FLOW: 'on' }])
})

test('the validator: expect.briefing only in a conversation that runs the briefing flow, closed keys and words', () => {
  const script = (flags, briefing) => ({ set: 'real-engine-x-v1', conversations: [{ id: 'c1', folder: { 'a.txt': 'x' }, ...(flags ? { flags } : {}), turns: [{ say: 'hi', expect: { briefing } }] }] })
  assert.equal(validateEngineScript(script({ EGDESK_BRIEFING_FLOW: 'on' }, { outcome: 'presented', schemaInvalid: 0, factsOnBoard: ['a'] })).ok, true)
  assert.match(validateEngineScript(script(null, { outcome: 'presented' })).errors.join('\n'), /needs flags\.EGDESK_BRIEFING_FLOW/)
  const bad = briefing => validateEngineScript(script({ EGDESK_BRIEFING_FLOW: 'on' }, briefing))
  assert.equal(bad({ outcome: 'great' }).ok, false); assert.equal(bad({ other: 1 }).ok, false); assert.equal(bad({ schemaInvalid: -1 }).ok, false); assert.equal(bad({ factsOnBoard: [''] }).ok, false)
  assert.deepEqual(validateBriefingExpect({ outcome: 'bubble', factsOnBoard: ['x'] }), ['factsOnBoard: only for an outcome presented'])
})

test('the checks run on the record by code: outcome, reason, schema sent, schema invalid, facts on the board; no record fails', () => {
  const rec = { outcome: 'presented', reason: null, forkTurns: 1, forkSchemaTurns: 1, schemaInvalid: 0, published: [{ title: 'A', markdown: '커밋 a1b2c3d, 테스트 120건' }], steps: [{ text: '단계' }] }
  const run = expect => checkBriefingExpect(expect, rec).map(c => [c.check, c.ok])
  assert.deepEqual(run({ outcome: 'presented', schemaSent: true, schemaInvalid: 0, factsOnBoard: ['a1b2c3d', '120'] }), [['briefing.outcome', true], ['briefing.schemaSent', true], ['briefing.schemaInvalid', true], ['briefing.factsOnBoard', true]])
  assert.deepEqual(run({ outcome: 'bubble', schemaSent: false, schemaInvalid: null, factsOnBoard: ['a1b2c3d', '없는 사실'] }).map(x => x[1]), [false, false, false, false])
  assert.equal(checkBriefingExpect({ factsOnBoard: ['x'] }, { ...rec, outcome: 'fallback-chat' })[0].ok, false, 'facts count only on a board that was proposed')
  assert.deepEqual(checkBriefingExpect({ outcome: 'presented' }, null).map(c => [c.check, c.ok]), [['briefing.ran', false]])
  assert.equal(boardText(rec).includes('단계'), true)
  assert.equal(checkBriefingExpect({ outcome: 'presented' }, { ...rec, steps: [] })[0].ok, false, 'presented by the flow, but the runtime took no proposal: not a board')
})

test('folderMaterials: a note named MM-DD.md is a dated page (declared year), status from its words, nothing else is read', () => {
  const rows = folderMaterials({ 'devlog/11-22.md': '# 11-22\n\n- 결제 모듈 병합 완료 (커밋 e4f5a6b).\n', 'devlog/11-24.md': '# t\n- 검색 화면 착수.\n- 남은 일: 가', 'README.md': 'x', 'devlog/13-40.md': 'x' }, { year: 2026 })
  assert.deepEqual(rows.map(r => [r.alias, r.time.at, r.status]), [['note-1122', '2026-11-22', 'done'], ['note-1124', '2026-11-24', 'plan']]); assert.equal(rows[0].title, '결제 모듈 병합 완료 (커밋 e4f5a6b).')
})

test('without --decisions the briefing flow is refused by the check\'s own preflight (the briefing runs on Decision calls)', () => {
  const scripts = asScripts(buildBoardScript())
  assert.match(preflight({ codexBin: '/x', home: { kind: 'person' }, decisions: false }, scripts, { exists: () => true, env: {} }).join('\n'), /decisions/i)
  assert.deepEqual(preflight({ codexBin: '/x', home: { kind: 'person' }, decisions: true }, scripts, { exists: () => true, env: { [DECISION_KEY_ENV]: 'k' } }), [])
})

test('v2 end to end: the real fork turn (here the fake) fills the board; schema ON sends outputSchema on every fork turn, OFF sends none; both boards carry every fact of the notes', async t => {
  const w = world(t, fakeFor('json'))
  const { records } = await runCheck(w.options, asScripts(buildBoardScript()), w.deps)
  assert.equal(records.length, 2)
  for (const rec of records) { assert.equal(rec.aborted, null, rec.id); assert.equal(rec.turns[0].ok, true, `${rec.id}: ${JSON.stringify(rec.turns[0].expectations.filter(e => !e.ok))}`) }
  const [on, off] = records.map(r => r.turns[0].hooks.briefing)
  assert.deepEqual([on.outcome, on.schemaFlag, on.forkSchemaTurns === on.forkTurns && on.forkTurns >= 1, on.schemaInvalid], ['presented', true, true, 0])
  assert.deepEqual([off.outcome, off.schemaFlag, off.forkSchemaTurns, off.forkTurns >= 1, off.schemaInvalid], ['presented', false, 0, true, null])
  assert.equal(on.materialsFrom, 'folder'); assert.equal(on.materials, 3); assert.ok(on.published.length >= 1 && on.steps.length >= 1)
  // on the wire: the fork's turn/start carried outputSchema exactly in the ON conversation
  const forks = turnStarts(w).filter(m => m.params?.outputSchema !== undefined); assert.equal(forks.length, on.forkTurns)
  assert.equal(turnStarts(w).length, 2 /* answers */ + on.forkTurns + off.forkTurns); assert.deepEqual(w.stderrLines, [], 'nothing the fake saw was off the schema')
  // the Decision model got the request and the notes through the check's own fetch; the key is in no record
  assert.ok(w.decisionBodies.length >= 6); assert.ok(on.decisions.length >= 3 && on.decisions.every(d => d.names.length > 0))
  assert.doesNotMatch(JSON.stringify(records), /egd-synthetic-not-a-key/)
  assert.ok(JSON.stringify(w.decisionBodies).includes(BOARD_SAY.slice(0, 12)))
})

test('the same fenced reply: schema ON refuses it and counts it (fill-invalid, chat only); schema OFF tolerates it (presented); the expectations of each hold', async t => {
  const w = world(t, fakeFor('fenced'))
  const script = buildBoardScript()
  const [onTurn, offTurn] = script.conversations.map(c => c.turns[0])
  onTurn.expect.briefing = { outcome: 'fallback-chat', reason: 'fill-invalid', schemaSent: true, schemaInvalid: 2 }
  offTurn.expect.briefing = { outcome: 'presented', schemaSent: false, schemaInvalid: null, factsOnBoard: offTurn.expect.briefing.factsOnBoard }
  assert.deepEqual(validateEngineScript(script), { ok: true, errors: [] })
  const { records } = await runCheck(w.options, asScripts(script), w.deps)
  for (const rec of records) assert.equal(rec.turns[0].ok, true, `${rec.id}: ${JSON.stringify(rec.turns[0].expectations.filter(e => !e.ok))}`)
  const [on, off] = records.map(r => r.turns[0].hooks.briefing)
  assert.deepEqual([on.forkTurns, on.published.length, on.steps.length], [2, 0, 0]); assert.deepEqual([off.outcome, off.schemaInvalid], ['presented', null])
  assert.deepEqual(w.stderrLines, [])
})

test('a failing expectation is reported by code (the board was proposed but the script expected a bubble); a prose reply is chat only in both modes', async t => {
  const w = world(t, fakeFor('json'))
  const script = buildBoardScript(); script.conversations.length = 1; script.conversations[0].turns[0].expect.briefing = { outcome: 'bubble' }
  const wrong = (await runCheck(w.options, asScripts(script), w.deps)).records[0]
  assert.equal(wrong.turns[0].ok, false); assert.deepEqual(wrong.turns[0].expectations.filter(e => !e.ok).map(e => e.check), ['briefing.outcome'])
  const p = world(t, fakeFor('prose')), both = buildBoardScript(); for (const c of both.conversations) c.turns[0].expect.briefing = { outcome: 'fallback-chat', reason: 'fill-invalid' }
  const prose = (await runCheck(p.options, asScripts(both), p.deps)).records
  for (const rec of prose) assert.equal(rec.turns[0].ok, true, `${rec.id}: ${JSON.stringify(rec.turns[0].expectations.filter(e => !e.ok))}`)
  assert.deepEqual(prose.map(r => r.turns[0].hooks.briefing.schemaInvalid), [2, null])
})

test('a conversation without expect.briefing never runs the hook: no fork turn, no record, and chat.send carries the capabilities only when the flow is on', async t => {
  const w = world(t, fakeFor('json'))
  const script = buildBoardScript(); script.conversations.length = 1; delete script.conversations[0].turns[0].expect.briefing
  const rec = (await runCheck(w.options, asScripts(script), w.deps)).records[0]
  assert.equal(rec.turns[0].ok, true); assert.equal(rec.turns[0].hooks, undefined); assert.equal(w.wire().filter(m => m.method === 'thread/fork').length, 0)
  assert.equal(briefingHook.active({ EGDESK_BRIEFING_FLOW: 'on' }), true); assert.equal(briefingHook.active({}), false); assert.equal(briefingHook.active({ EGDESK_BRIEFING_FLOW: 'advisory' }), false)
})
