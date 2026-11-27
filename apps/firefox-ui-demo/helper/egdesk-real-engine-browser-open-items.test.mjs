// L8 c37: browser-open-items-v1. FAKE validation: a scripted Decision model (it reads the message and the open task's evidence) and the fake app-server; the product's entry, its open-item options and the objective loop run on the ticket fixture world across two turns of one conversation.
import test from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { runFakeAppServer } from '../scripts/real-engine/fake-app-server.mjs'
import { DECISION_KEY_ENV, runCheck } from './egdesk-real-engine-check.mjs'
import { validateEngineScript } from './egdesk-real-engine-script.mjs'
import { BROWSER_OPEN_ITEMS_SET, buildBrowserOpenItemsScript } from './egdesk-browser-answer-real-engine-script.mjs'
import { NOTE_KEY } from './egdesk-real-engine-browser-answer-hook.mjs'
import { checkBrowserLoop } from './egdesk-real-engine-browser-loop-hook.mjs'
import { estimateTokens } from './egdesk-memory-real-plan.mjs'
import { createPrivateQaTempDirectory } from '../scripts/egdesk-qa-platform.mjs'
import { pageTextFor } from './egdesk-page-text.fixture.mjs'
pageTextFor(["end to end on the fake engine: the Decision settles the option","c43 (c64: the referent read the short replies"]) // a1: these pin what was sent WITH the page text (the flag on for them only; the default is off)

const tmp = t => { const base = fs.realpathSync(createPrivateQaTempDirectory('egdesk-real-engine-loop2-')); t.after(() => fs.rmSync(base, { recursive: true, force: true })); return base }
const FIRST = '내 다음 공연 예매 내역 알려줘'
const REPLIES = {
  [FIRST]: '예매 내역은 로그인이 필요해서 제가 볼 수 없었어요. 직접 로그인해 주시면 이어서 확인할게요.',
  '했어': '다음 공연은 2026년 12월 20일 별빛 콘서트이고 좌석은 B구역 12열이에요.',
  '다시 해줘': '다시 확인했어요. 다음 공연은 2026년 12월 20일 별빛 콘서트입니다.',
  '아냐 됐어, 그만할래': '알겠어요. 예매 내역 확인은 여기서 멈출게요.',
  '지금 화면에 뭐라고 나와?': '지금 화면에는 로그인이 필요하다는 안내가 나와 있어요.',
  '고마워. 그런데 자바스크립트 배열 정렬은 어떻게 해?': 'arr.sort()를 쓰면 되고, 숫자는 (a, b) => a - b 비교 함수를 넘기세요.',
}
let STRICT = false
/** The scripted Decision model: what a sensible one answers, from the evidence it is given. */
function decide(body) {
  const ev = body.input.map(m => (typeof m.content === 'string' ? m.content : '')).join('\n')
  const message = /User message: (.*)/.exec(ev)?.[1] ?? /Message of the person: "(.*)"/.exec(body.questions.map(q => q.instructions ?? '').join('\n'))?.[1] ?? /Message:\n(.*)/.exec(ev)?.[1] ?? ''
  const visible = ev.split('Visible text:')[1] ?? ''
  return body.questions.map(q => {
    const values = (q.choices ?? []).map(c => c.value)
    const yes = p => ({ name: q.name, type: 'predicate', probability: p })
    if (/^oi_ref_/.test(q.name)) return yes(STRICT ? 0.3 : /자바스크립트/.test(message) ? 0.04 : 0.96) // the resolver: does this message settle the open browser task? (STRICT: the c64 reading: short replies stay under the bar)
    const open = /^open_browser_(.*)$/.exec(q.name)?.[1]
    if (open) { const want = /다시 해줘/.test(message) ? 'retry' : /^했어$/.test(message) ? 'continue' : /그만/.test(message) ? 'abandon' : /화면/.test(message) ? 'ask_page' : null; return yes(open === want ? 0.97 : 0.03) }
    if (q.name === 'browser_entry' || /^browser_entry_card_/.test(q.name)) return yes(0.95)
    if (q.name === 'browser_entry_answer' || /^browser_entry_wall_/.test(q.name)) return yes(0.03)
    if (q.name === 'goal_met') return yes(/공연일: 2026-12-20/.test(visible) ? 0.97 : 0.02)
    if (q.name === 'ps_sign_in') return yes(/로그인이 필요합니다/.test(visible) ? 0.96 : 0.02)
    if (/^ps_/.test(q.name)) return yes(0.02)
    if (/^person_target_/.test(q.name)) return yes(0.03)
    if (q.name === 'next_step') {
      const pick = word => values.find(v => /^\[L\d+\]/.test(v) && v.includes(word))
      const word = /내 공연 내역 1건/.test(visible) ? '별빛 콘서트 상세' : /마이티켓/.test(visible) ? '공연 내역 보기' : null
      const value = (word && pick(word)) || 'blocked'
      return { name: q.name, type: 'choice', choice: value, confidence: 0.92, probabilities: [{ value, probability: 0.92 }] }
    }
    return yes(0.02)
  })
}
function world(t, replies) {
  const base = tmp(t), out = path.join(base, 'out'), codexHome = path.join(base, 'codex-home'); fs.mkdirSync(codexHome)
  const spawns = [], decisionBodies = []
  const spawn = (bin, argv, options) => {
    const stdin = new PassThrough(), stdout = new PassThrough(), stderr = new PassThrough(), child = new EventEmitter()
    Object.assign(child, { pid: 7171 + spawns.length, stdin, stdout, stderr, exitCode: null, signalCode: null, kill: () => true }); spawns.push({ bin, argv, options })
    runFakeAppServer({ script: { turns: Object.entries(replies).map(([match, final]) => ({ match, steps: [], final })), forkTurns: [] }, log: path.join(base, `fake-${spawns.length}.log`), input: stdin, output: stdout, stderr: { write: line => stderr.write(line) }, env: options.env, exit: code => { child.exitCode = code; child.emit('close', code, null) } })
    return child
  }
  const killGroup = async child => { child.stdin.end(); await new Promise(resolve => { if (child.exitCode != null) return resolve(); child.once('close', resolve); setTimeout(resolve, 500) }); return { signal: 'SIGTERM' } }
  const fetchImpl = async (_url, init) => { const body = JSON.parse(init.body); decisionBodies.push(body); return Response.json({ answers: decide(body), usage: { input_tokens: 20 } }) }
  const options = { mode: 'run', codexBin: '/fake/codex', home: { kind: 'person', dir: null }, scripts: [], out, decisions: true, model: null, effort: null, appServerConfig: [], turnTimeoutMs: 15000, json: false }
  const deps = { spawn, runnerSpawn: () => { throw new Error('no command runs in this test') }, fetchImpl, killGroup, killGroupRunner: () => {}, gitStatus: async () => null, env: { PATH: '/usr/bin:/bin', HOME: path.join(base, 'home'), [DECISION_KEY_ENV]: 'egd-synthetic-not-a-key-0035' } }
  return { options, deps, decisionBodies, wires: () => spawns.map((_, i) => fs.readFileSync(path.join(base, `fake-${i + 1}.log`), 'utf8').trim().split('\n').map(line => JSON.parse(line))) }
}
const asScripts = (...scripts) => scripts.map(script => ({ file: `${script.set}.json`, script }))
const failedOf = rec => rec.turns.flatMap((turn, i) => turn.expectations.filter(c => !c.ok).map(c => `turn${i + 1}:${c.check}`))


test('the committed open-items script is the builder\'s and validates: five conversations of two turns each; the conversation flag is required', () => {
  const committed = JSON.parse(fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'scripts', 'real-engine', 'scripts', `${BROWSER_OPEN_ITEMS_SET}.json`), 'utf8'))
  assert.deepEqual(committed, JSON.parse(JSON.stringify(buildBrowserOpenItemsScript()))); assert.deepEqual(validateEngineScript(committed), { ok: true, errors: [] })
  assert.deepEqual(committed.conversations.map(c => c.id), ['oi-continue', 'oi-retry', 'oi-abandon', 'oi-ask-page', 'oi-unrelated'])
  assert.ok(committed.conversations.every(c => c.turns.length === 2 && c.turns[0].browserLoop.keep === true && c.turns[1].browserLoop.continues))
  const bad = JSON.parse(JSON.stringify(committed)); delete bad.conversations[0].flags.EGDESK_BROWSER_OPEN_ITEMS
  assert.equal(validateEngineScript(bad).ok, false, 'the open-items flag is declared by the script')
})

test('end to end on the fake engine: the Decision settles the option, code applies it before the engine turn, the loop continues from the next step after the person\'s step, and every conversation passes its checks', async t => {
  const w = world(t, REPLIES)
  const result = await runCheck(w.options, asScripts(buildBrowserOpenItemsScript()), w.deps)
  assert.equal(result.records.length, 5)
  for (const rec of result.records) { assert.equal(rec.aborted, null, rec.abortDetail); assert.deepEqual(failedOf(rec), [], `${rec.id}: ${JSON.stringify(rec.turns.map(turn => turn.expectations.filter(c => !c.ok)))}`) }
  const second = id => result.records.find(r => r.id === id).turns[1].browserLoop
  assert.deepEqual(second('oi-continue').acts.map(a => [a.type, a.path]), [['navigate', '/my/bookings/9001']], 'only the step after the person\'s own step: nothing is redone')
  assert.deepEqual(second('oi-retry').acts.map(a => a.type), ['navigate'])
  assert.deepEqual([second('oi-abandon').acts, second('oi-ask-page').acts, second('oi-unrelated').acts], [[], [], []])
  assert.equal(second('oi-continue').openItem.settled, 'continue'); assert.equal(second('oi-unrelated').entry.reason, 'unrelated')
  // the engine of the second turn got the closed note (or, for an unrelated message, nothing about the task)
  const notes = result.records.map(r => r.turns[1].browserLoop.note)
  assert.deepEqual(notes.map(n => (n ? JSON.parse(n)[NOTE_KEY].status : null)), ['done', 'done', 'cancelled', 'cannot_proceed', null])
  // every open-item request is ONE request with the option predicates only (no second request to decide it)
  const openRequests = w.decisionBodies.filter(b => b.questions.some(q => /^open_browser_/.test(q.name)))
  assert.equal(openRequests.length, 5)
  assert.ok(openRequests.every(b => b.questions.map(q => q.name).join() === ['oi_ref_1', 'continue', 'retry', 'abandon', 'ask_page'].map(id => (id === 'oi_ref_1' ? id : `open_browser_${id}`)).join()), 'c39: the resolver\'s referent predicate and the task\'s options are ONE request, as the product sends them')
  assert.equal(w.decisionBodies.filter(b => b.questions.some(q => q.name === 'oi_ref_1')).length, 5, 'and the entry asks nothing of its own: no second request for the options')
  assert.deepEqual(result.records.map(r => r.turns[1].browserLoop.openItem.resolver.status), ['settled', 'settled', 'settled', 'settled', 'none'])
  assert.equal(result.records.at(-1).turns[1].browserLoop.openItem.resolver.reason, 'no_item_referred')
})

test('the checks by code: a wrong option, an option applied when none fit, a note that is not the settled state are each named', () => {
  const base = { delivered: true, reply: 'x', say: 'x', note: '{}', noteParsed: { status: 'done', page: ['공연일: 2026-12-20'] }, entry: { handled: true }, entryAnswers: {}, acts: [], openItem: { settled: 'continue', p: { continue: 0.97 } } }
  const run = (expect, rec = {}) => Object.fromEntries(checkBrowserLoop(expect, { ...base, ...rec }).map(c => [c.check.replace(/^browser(Loop|Answer)\./, ''), c.ok]))
  assert.equal(run({ openItemSettled: 'continue' }).open_item_settled, true)
  assert.equal(run({ openItemSettled: 'retry' }).open_item_settled, false)
  assert.equal(run({ noteSettled: 'abandon' }, { noteParsed: { status: 'cancelled', settled: 'abandon' } }).note_settled, true)
  assert.equal(run({ noteSettled: 'abandon' }).note_settled, false)
  const noneRec = { entry: { handled: false, reason: 'unrelated' }, note: '', noteParsed: null, delivered: false, openItem: { settled: null, p: {} } }
  const none = run({ openItemNone: true }, noneRec)
  assert.deepEqual([none.open_item_none, none.note_delivered, none.entered], [true, undefined, undefined], 'no note by design: nothing to deliver, no entry to check')
  assert.equal(run({ openItemNone: true }).open_item_none, false)
})

test('c43 (c64: the referent read the short replies under the 0.85 bar): with the browser task as the sole open item the options of the same request settle the option, every conversation still passes, and the unrelated message still settles nothing', async t => {
  STRICT = true
  try {
    const w = world(t, REPLIES)
    const result = await runCheck(w.options, asScripts(buildBrowserOpenItemsScript()), w.deps)
    for (const rec of result.records) { assert.equal(rec.aborted, null, rec.abortDetail); assert.deepEqual(failedOf(rec), [], `${rec.id}: ${JSON.stringify(rec.turns.map(turn => turn.expectations.filter(c => !c.ok)))}`) }
    const second = id => result.records.find(r => r.id === id).turns[1].browserLoop
    assert.deepEqual(result.records.map(r => r.turns[1].browserLoop.openItem.resolver.status), ['none', 'none', 'none', 'none', 'none'], 'the referent settled nothing')
    assert.deepEqual(['oi-continue', 'oi-retry', 'oi-abandon', 'oi-ask-page'].map(id => second(id).openItem.settled), ['continue', 'retry', 'abandon', 'ask_page'], 'the options of the same request did')
    assert.equal(second('oi-unrelated').entry.reason, 'unrelated'); assert.equal(w.decisionBodies.filter(b => b.questions.some(q => q.name === 'oi_ref_1')).length, 5, 'still one request per message')
  } finally { STRICT = false }
})
