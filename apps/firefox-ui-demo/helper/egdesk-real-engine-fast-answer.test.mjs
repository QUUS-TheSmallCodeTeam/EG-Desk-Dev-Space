// L1 c31: the fast answer in lane L5's real-engine check, end to end against the FAKE app-server (scripts/real-engine/fake-app-server.mjs): the check's own runtime, the bridge's own turn memory,
// the all-on scripted Decision model for the loop and a scripted answer for the fast-answer questions. No Codex binary, no network, no key. The numbers of the real run are Main's.
import test from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { runFakeAppServer } from '../scripts/real-engine/fake-app-server.mjs'
import { scriptedDecisions } from '../scripts/egdesk-all-on.support.mjs'
import { choiceAnswer } from './egdesk-wiki-reconstruction.fixture.mjs'
import { createPrivateQaTempDirectory } from '../scripts/egdesk-qa-platform.mjs'
import { BRIDGE_COMPOSITION, DECISION_DEPENDENT_FLAGS, DECISION_KEY_ENV, runCheck } from './egdesk-real-engine-check.mjs'
import { validateEngineScript } from './egdesk-real-engine-script.mjs'
import { registeredDecisionFlags, registeredExpectKeys, registeredFlags, registeredTurnHookNames } from './egdesk-real-engine-extensions.mjs'
import { FAST_EXPECT_SCHEMA, FAST_FLAG, createFastAnswerHook, validateFastExpect } from './egdesk-real-engine-fast-answer.mjs'
import { COMPUTE_QUESTION, DINNER_QUESTION, FAST_ANSWER_SET, FAST_QUESTION, FAST_SENTENCE, VISIT_QUESTION, VISIT_SENTENCE, WHOLE_QUESTION, buildFastAnswerScript } from './egdesk-fast-answer-real-engine-script.mjs'
import { FAST_REASONS, FAST_RUN_PREFIX } from './egdesk-memory-fast-answer.mjs'

const app = path.join(path.dirname(fileURLToPath(import.meta.url)), '..')
const ENGINE_47 = '서버 백업은 47일 보관하기로 정했습니다.'
function world(t, fakeScript, fa) {
  const base = fs.realpathSync(createPrivateQaTempDirectory('egdesk-real-engine-fast-')); t.after(() => fs.rmSync(base, { recursive: true, force: true }))
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
    if (wire.questions.some(q => q.name.startsWith('fa_'))) return Response.json({ answers: wire.questions.map(q => ({ name: q.name, type: 'predicate', probability: fa(q.name) })), usage: { input_tokens: 5, output_tokens: 1 } })
    // the memory loop's scan: the stand-in judge is lexical, so which page a question is about is stated here (a judge reading the pages would say the same): 백업 -> the retention record, 방문 -> the visit, 회식 -> the dinner
    const flat = wire.input.map(m => (typeof m.content === 'string' ? m.content : JSON.stringify(m.content))).join('\n'), message = flat.slice(flat.lastIndexOf('Message:') + 8)
    // the status reading of a picked page (st_P<n>): what a judge reading the record says, which for these pages is the recorded status (a planned line is a plan, the others are done)
    const status = wire.questions.filter(q => /^st_P\d+$/.test(q.name)).map(q => ({ name: q.name, value: new RegExp(`^${q.name.slice(3)} \\| time=(\\w+)`, 'm').exec(flat)?.[1] === 'planned' ? 'plan' : 'done', q }))
    const answers = (await scripted.answer(wire)).map(a => { const st = status.find(x => x.name === a.name); if (st) return choiceAnswer(st.q, st.value, 0.95); const m = /^pg_(\d+)$/.exec(a.name); if (!m) return a
      const title = new RegExp(`^P${Number(m[1]) + 1} \\|[^\\n]*\\| ([^\\n]*)$`, 'm').exec(flat)?.[1] ?? ''
      const wanted = (/백업/.test(message) && /백업/.test(title)) || (/방문/.test(message) && /방문/.test(title)) || (/회식/.test(message) && /회식/.test(title))
      return { ...a, probability: wanted ? 0.95 : 0.02 } })
    return Response.json({ answers, usage: { input_tokens: 20, output_tokens: 1 } })
  }
  const options = { mode: 'run', codexBin: '/fake/codex', home: { kind: 'person', dir: null }, scripts: [], out, decisions: true, model: null, effort: null, appServerConfig: [], turnTimeoutMs: 8000, json: false }
  const deps = { spawn, runnerSpawn: () => { throw new Error('no command runs here') }, fetchImpl, killGroup, killGroupRunner: () => {}, gitStatus: async () => null, env: { PATH: '/usr/bin:/bin', HOME: path.join(base, 'home'), [DECISION_KEY_ENV]: 'egd-synthetic-not-a-key-0031' } }
  return { options, deps, wireQuestions, base, wire: () => fs.readFileSync(path.join(base, 'fake.log'), 'utf8').trim().split('\n').map(line => JSON.parse(line)) }
}
const only = id => { const s = buildFastAnswerScript(); return { file: `${FAST_ANSWER_SET}.json`, script: { ...s, conversations: s.conversations.filter(c => c.id === id) } } }
const yesFirst = name => (name === 'fa_ans_0' ? 0.97 : 0.02)
const go = async (t, id, fakeFinals, fa = yesFirst) => {
  const w = world(t, { turns: fakeFinals.map(final => ({ steps: [], final })) }, fa)
  const result = await runCheck(w.options, [only(id)], w.deps)
  return { w, rec: result.records[0], turns: result.records[0].turns }
}
const turnStarts = w => w.wire().filter(m => m.dir === 'in' && m.method === 'turn/start' || m.method === 'turn/start').length

test('the committed script is the builder\'s and validates; the check registers the flag, the expect key and the hook; the flag is reproduced', () => {
  const committed = JSON.parse(fs.readFileSync(path.join(app, 'scripts', 'real-engine', 'scripts', `${FAST_ANSWER_SET}.json`), 'utf8'))
  assert.deepEqual(committed, JSON.parse(JSON.stringify(buildFastAnswerScript()))); assert.deepEqual(validateEngineScript(committed), { ok: true, errors: [] })
  assert.ok(registeredExpectKeys().includes('fastAnswer') && registeredTurnHookNames().includes('fastAnswer') && registeredFlags().includes(FAST_FLAG) && registeredDecisionFlags().includes(FAST_FLAG))
  assert.ok(DECISION_DEPENDENT_FLAGS.includes(FAST_FLAG) && BRIDGE_COMPOSITION.flags.includes(FAST_FLAG) && !BRIDGE_COMPOSITION.notReproduced.flags.includes(FAST_FLAG))
  assert.deepEqual(committed.conversations.map(c => c.id), ['fast-off', 'fast-on', 'fast-compute', 'fast-whole', 'fast-dinner', 'fast-visit'])
  assert.ok(committed.conversations.every(c => c.memory.mode === 'on'))
  assert.equal(committed.conversations[0].flags, undefined); assert.ok(committed.conversations.slice(1).every(c => c.flags[FAST_FLAG] === 'on'))
  assert.equal(FAST_SENTENCE, '11월 5일 점검 회의에서 서버 백업 보관 기간을 47일로 정했다.')
  assert.equal(FAST_SENTENCE.includes('자동 삭제'), false)
  for (const q of [FAST_QUESTION, COMPUTE_QUESTION, WHOLE_QUESTION, DINNER_QUESTION, VISIT_QUESTION]) assert.ok(committed.conversations.some(c => c.turns.some(tn => tn.say === q)))
})

test('the validator: closed keys, the flag and the memory are needed, used and reason do not mix, answerIs belongs to a code answer', () => {
  const conv = (flags, extra = {}) => ({ id: 'c', ...(flags ? { flags } : {}), memory: { mode: 'on', pages: [{ id: 'a/b', title: 't', body: 'x' }] }, ...extra })
  const turn = {}
  const v = (value, c = conv({ [FAST_FLAG]: 'on' })) => validateFastExpect(value, c, turn)
  assert.deepEqual(v({ used: true, answerIs: 'x', maxSeconds: 5 }), [])
  assert.deepEqual(v({ used: false, reason: ['several_sentences', 'time_unsettled'], noDecisionCall: true }), [])
  assert.match(v({ used: true, reason: 'time_unsettled' }).join('\n'), /belongs to used: false/)
  assert.match(v({ used: false, answerIs: 'x' }).join('\n'), /only an answer posted by code/)
  assert.match(v({ used: true }, conv(null)).join('\n'), /needs flags\.EGDESK_TURN_MEMORY_FAST_ANSWER/)
  assert.deepEqual(v({ used: false }, conv(null)), [], 'the engine path of a conversation with the flag off may state used: false')
  assert.match(v({ used: true }, { id: 'c', flags: { [FAST_FLAG]: 'on' } }).join('\n'), /memory\.mode/)
  assert.match(v({ nope: 1 }).join('\n'), /unknown key/)
  assert.match(v({ reason: 'Bad Word' }).join('\n'), /closed words/)
  assert.equal(FAST_EXPECT_SCHEMA.additionalProperties, false)
  for (const bad of [{ used: 'yes' }, { maxSeconds: 'fast' }, { maxSeconds: -1 }, { answerIs: 5 }, { noDecisionCall: false }]) assert.ok(v(bad).length > 0, JSON.stringify(bad))
  const doc = JSON.stringify(validateEngineScript({ set: 'real-engine-x-v1', conversations: [{ id: 'c', flags: { [FAST_FLAG]: 'on' }, memory: { mode: 'on', pages: [{ id: 'a/b', title: 't', body: 'x' }] }, turns: [{ say: 'hi', expect: { fastAnswer: { used: 'yes' } } }] }] }))
  assert.match(doc, /fastAnswer/, 'the script validator runs the registered validator')
  assert.ok(FAST_REASONS.includes('answered') && FAST_REASONS.every(r => /^[a-z][a-z_]{2,39}$/.test(r)))
})

test('the hook: counts turn/start per turn, reads the runtime\'s record, and judges used / reason / answerIs / maxSeconds / noDecisionCall by code', () => {
  const run = { runId: 'r1', conversationId: 'c1' }
  const make = (record, flagOn = true) => {
    const hook = createFastAnswerHook({ flags: flagOn ? { [FAST_FLAG]: 'on' } : {} })
    hook.attach({ chat: { runs: new Map([['k', { runId: 'r1', conversationId: 'c1' }]]), fastAnswerRecord: () => record } })
    return hook
  }
  const turn = (hook, { starts = 0, answer = 'x', latencyMs = 1900, expect }) => { hook.beginTurn(); for (let i = 0; i < starts; i++) hook.observe('turn/start', {}); hook.observe('thread/start', {}); hook.afterTurn({ run, answer }); return hook.finishTurn({ expect: { fastAnswer: expect }, latencyMs }) }
  const used = make({ used: true, reason: 'answered', calls: 1, ms: 350, pageId: 'p', p: 0.97 })
  let r = turn(used, { answer: '문장.', expect: { used: true, answerIs: '문장.', maxSeconds: 2, } })
  assert.deepEqual(r.expectations.map(e => [e.check, e.ok]), [['fastAnswer.used', true], ['fastAnswer.answerIs', true], ['fastAnswer.maxSeconds', true]])
  assert.deepEqual([r.record.seconds, r.record.engineTurns, r.record.decisionMs, r.record.pageId], [1.9, 0, 350, 'p'])
  r = turn(used, { starts: 1, answer: '문장.', expect: { used: true } }); assert.equal(r.expectations[0].ok, false, 'a turn/start reached the engine: not a fast answer')
  r = turn(used, { answer: '다른 문장', expect: { answerIs: '문장.' } }); assert.equal(r.expectations[0].ok, false)
  r = turn(used, { latencyMs: 2100, expect: { maxSeconds: 2 } }); assert.equal(r.expectations[0].ok, false)
  const engine = make({ used: false, reason: 'several_sentences', calls: 1, ms: 400 })
  r = turn(engine, { starts: 1, expect: { used: false, reason: ['time_unsettled', 'several_sentences'] } }); assert.deepEqual(r.expectations.map(e => e.ok), [true, true])
  r = turn(engine, { starts: 0, expect: { used: false } }); assert.equal(r.expectations[0].ok, false, 'no turn started and nothing was posted by code')
  r = turn(engine, { starts: 1, expect: { reason: 'needs_more_than_a_sentence' } }); assert.equal(r.expectations[0].ok, false)
  r = turn(engine, { starts: 1, expect: { noDecisionCall: true } }); assert.equal(r.expectations[0].ok, false, 'a request was sent')
  const floor = make({ used: false, reason: 'time_unsettled', calls: 0, ms: 0 })
  r = turn(floor, { starts: 1, expect: { used: false, reason: 'time_unsettled', noDecisionCall: true } }); assert.deepEqual(r.expectations.map(e => e.ok), [true, true, true])
  const off = make(null, false); r = turn(off, { starts: 1, expect: { used: false } })
  assert.deepEqual([r.record.flag, r.record.used, r.record.reason, r.record.engineTurns], [false, false, null, 1]); assert.equal(r.expectations[0].ok, true)
  assert.equal(createFastAnswerHook({ flags: {} }).finishTurn({ expect: {} }), null, 'no flag and no expectation: no record')
})

test('end to end (fake engine): fast-off asks the engine, fast-on posts the record\'s sentence with no engine turn and the next turn goes to the engine with the exchange', async t => {
  const off = await go(t, 'fast-off', [ENGINE_47])
  assert.equal(off.rec.aborted, null, off.rec.abortDetail); assert.equal(off.turns[0].ok, true, JSON.stringify(off.turns[0].expectations.filter(e => !e.ok)))
  assert.deepEqual([off.turns[0].fastAnswer.used, off.turns[0].fastAnswer.engineTurns, off.turns[0].fastAnswer.flag], [false, 1, false])
  assert.equal(off.w.wireQuestions.flat().some(n => n.startsWith('fa_')), false, 'flag off: no fast-answer request')
  const on = await go(t, 'fast-on', ['방금 백업을 며칠 보관하기로 했는지 물어보셨어요.'])
  assert.equal(on.rec.aborted, null, on.rec.abortDetail)
  const [t1, t2] = on.turns
  assert.equal(t1.ok, true, JSON.stringify(t1.expectations.filter(e => !e.ok)))
  assert.deepEqual([t1.fastAnswer.used, t1.fastAnswer.engineTurns, t1.finalAnswer], [true, 0, FAST_SENTENCE])
  assert.equal(t2.ok, true, JSON.stringify(t2.expectations.filter(e => !e.ok)))
  assert.deepEqual([t2.fastAnswer.used, t2.fastAnswer.engineTurns], [false, 1])
  const starts = on.w.wire().filter(m => m.method === 'turn/start')
  assert.equal(starts.length, 1, 'one engine turn in the whole conversation: turn 2')
  assert.ok(JSON.stringify(starts[0]).includes(FAST_SENTENCE), 'the engine was told the sentence the person already got (the carried exchange)')
  assert.match(t1.subTurns[0].error ?? '', /^$/)
  assert.ok(String(on.rec.turns[0].subTurns[0].status) === 'completed')
  assert.ok(FAST_RUN_PREFIX.startsWith('egdesk-fast'))
})

test('end to end (fake engine): every doubt and floor goes to the engine, and the scheduled line is posted by code', async t => {
  const cases = [
    ['fast-compute', ['12월 22일에 지워집니다.'], name => (name === 'fa_more' ? 0.93 : name === 'fa_ans_0' ? 0.97 : 0.02)],
    ['fast-whole', ['47일 보관하고 월 1회 복원 시험을 합니다.'], name => (name.startsWith('fa_ans_') ? 0.97 : 0.02)],
    ['fast-dinner', ['아직 정하지 못했습니다.'], name => 0.99],
  ]
  for (const [id, finals, fa] of cases) {
    const { rec, turns, w } = await go(t, id, finals, fa)
    assert.equal(rec.aborted, null, `${id}: ${rec.abortDetail}`)
    assert.equal(turns[0].ok, true, `${id}: ${JSON.stringify(turns[0].expectations.filter(e => !e.ok))}`)
    assert.equal(turns[0].fastAnswer.used, false, id); assert.equal(turns[0].fastAnswer.engineTurns, 1, id)
    if (id === 'fast-dinner') assert.equal(w.wireQuestions.flat().some(n => n.startsWith('fa_')), false, 'a record whose time is hypothetical never reaches the Decision model for a sentence')
  }
  const visit = await go(t, 'fast-visit', ['unused'])
  assert.equal(visit.rec.aborted, null, visit.rec.abortDetail); assert.equal(visit.turns[0].ok, true, JSON.stringify(visit.turns[0].expectations.filter(e => !e.ok)))
  assert.equal(visit.turns[0].finalAnswer, VISIT_SENTENCE); assert.equal(visit.turns[0].fastAnswer.engineTurns, 0)
})

test('the compare script: one row per turn with a record, the pair of the same question across flag off and on, facts from the check\'s own verdicts', async () => {
  const { rowsOf, pairsOf, render } = await import('../scripts/egdesk-fast-answer-compare.mjs')
  const turn = (index, say, flag, fa, answer, facts) => ({ index, say, finalAnswer: answer, ok: true, expectations: facts, fastAnswer: { flag, used: fa.used, reason: fa.reason ?? null, seconds: fa.seconds, decisionMs: fa.ms ?? null, engineTurns: fa.used ? 0 : 1, answer } })
  const ok = [{ check: 'answerIncludes', ok: true }, { check: 'answerExcludes', ok: true }]
  const records = [{ id: 'fast-off', turns: [turn(1, 'Q', false, { used: false, seconds: 9.2 }, '47일입니다.', ok)] },
    { id: 'fast-on', turns: [turn(1, 'Q', true, { used: true, seconds: 1.8, ms: 350 }, '47일로 정했다.', ok), turn(2, 'R', true, { used: false, reason: 'no_picked_record', seconds: 6 }, '백업을 물었어요.', [{ check: 'answerIncludes', ok: false }])] },
    { id: 'other', turns: [{ index: 1, say: 'no hook', expectations: [] }] }]
  const rows = rowsOf(records)
  assert.deepEqual(rows.map(r => [r.conversation, r.turn, r.path, r.flag, r.seconds, r.factsOk]), [['fast-off', 1, 'engine', false, 9.2, true], ['fast-on', 1, 'fast', true, 1.8, true], ['fast-on', 2, 'engine', true, 6, false]])
  assert.deepEqual(pairsOf(rows), [{ say: 'Q', engineSeconds: 9.2, fastSeconds: 1.8, savedSeconds: 7.4, engineAnswer: '47일입니다.', fastAnswer: '47일로 정했다.', bothFactsOk: true }])
  const text = render(rows, pairsOf(rows))
  assert.match(text, /fast-on \| 1 \| fast \|/); assert.match(text, /FAIL/); assert.match(text, /\| Q \| 9\.2 \| 1\.8 \| 7\.4 \| yes \|/)
  assert.deepEqual(rowsOf([]), [])
})
