// L8 c36 (U13 R-C): the fast-answer comparison script. FAKE validation: a scripted Decision model (it picks the line that answers the request) and the fake app-server; the product's entry and objective loop run on the fixture worlds.
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
import { BROWSER_FAST_SET, buildBrowserFastScript } from './egdesk-browser-answer-real-engine-script.mjs'
import { NOTE_KEY } from './egdesk-real-engine-browser-answer-hook.mjs'
import { checkBrowserLoop } from './egdesk-real-engine-browser-loop-hook.mjs'
import { FAST_MORE } from './egdesk-browser-fast-answer.mjs'
import { estimateTokens } from './egdesk-memory-real-plan.mjs'
import { createPrivateQaTempDirectory } from '../scripts/egdesk-qa-platform.mjs'

const tmp = t => { const base = fs.realpathSync(createPrivateQaTempDirectory('egdesk-real-engine-loop2-')); t.after(() => fs.rmSync(base, { recursive: true, force: true })); return base }
const SAYS = ['다음 결제일이 언제야?', '다음 결제일까지 며칠 남았어?', '주문번호 2026-1119-0042 배송 어디까지 왔어?', '모래의 도시 반납 예정일 알려줘', '다음 연금 수령일 언제야?', '마케팅 알림 꺼줘']
const GOOD = { [SAYS[0]]: '다음 결제일은 2026년 12월 14일입니다.', [SAYS[1]]: '다음 결제일은 2026년 12월 14일이라서, 오늘(' + new Date().getMonth() + '월)부터 계산해 드릴게요.',
  [SAYS[2]]: '주문 2026-1119-0042(휴대폰 케이스)는 지금 배송 중이에요.', [SAYS[3]]: '모래의 도시의 반납 예정일은 2026년 12월 9일입니다.', [SAYS[4]]: '다음 연금 수령일은 2026년 12월 25일입니다.',
  [SAYS[5]]: '마케팅 정보 알림은 제가 직접 바꿀 수 없는 스위치예요. 설정 화면에서 직접 꺼 주세요.' }
/** The scripted Decision model: what a sensible one answers on these pages (it reads the evidence it is given). */
function decide(body) {
  const ev = body.input.map(m => (typeof m.content === 'string' ? m.content : '')).join('\n')
  const goalLine = /Goal: (.*)/.exec(ev)?.[1] ?? ''
  const request = /Request: (.*)/.exec(ev)?.[1] ?? ''
  return body.questions.map(q => {
    const values = (q.choices ?? []).map(c => c.value)
    const yes = p => ({ name: q.name, type: 'predicate', probability: p })
    if (/^fast_line_\d+$/.test(q.name)) { const line = /"([^"]*)"/.exec(q.instructions ?? '')?.[1] ?? ''; const wanted = /결제일/.test(request) ? '다음 결제일' : /배송/.test(request) ? '배송 상태' : /반납/.test(request) ? '반납 예정일' : /수령일/.test(request) ? '다음 수령일' : '\u0000'; return yes(line.startsWith(wanted) ? 0.96 : 0.03) }
    if (q.name === FAST_MORE) return yes(/며칠/.test(request) ? 0.95 : 0.03)
    if (q.name === 'browser_entry' || /^browser_entry_card_/.test(q.name)) return yes(0.95)
    if (q.name === 'browser_entry_answer' || /^browser_entry_wall_/.test(q.name)) return yes(0.03)
    if (q.name === 'goal_met') return yes(/반납 예정일: 2026-12-09|내 순번: 7번째|다음 수령일: 2026-12-25|다음 결제일: 2026-12-14|배송 상태: 배송 중/.test(ev.split('Visible text:')[1] ?? '') ? 0.97 : 0.02)
    if (q.name === 'ps_sign_in') return yes(/로그인이 필요합니다/.test(ev.split('Visible text:')[1] ?? '') ? 0.96 : 0.02)
    if (/^ps_/.test(q.name)) return yes(0.02)
    if (/^person_target_/.test(q.name)) return yes(0.03)
    if (q.name === 'next_step') {
      const pick = word => values.find(v => /^\[[LB]\d+\]/.test(v) && v.includes(word))
      const word = /주문번호/.test(goalLine) ? '2026-1119-0042' : /결제일/.test(goalLine) ? null : /모래의 도시/.test(goalLine) ? (/URL: \S+\/loans\n/.test(ev) ? '모래의 도시' : '대출 중인 도서') : /공연/.test(goalLine) ? '공연 내역 보기' : /대관/.test(goalLine) ? '회의실 대관하기' : /순번/.test(goalLine) ? '내 순번 보기' : /연금/.test(goalLine) ? '수령 내역' : null
      const value = (word && pick(word)) || (/제출하세요/.test(ev) ? 'scroll_more' : 'blocked')
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
const failedOf = rec => rec.turns[0].expectations.filter(c => !c.ok).map(c => c.check)


const noTiming = script => { const copy = JSON.parse(JSON.stringify(script)); for (const c of copy.conversations) { const f = c.turns[0].expect.browserLoop.fast; if (f) delete f.fasterThanEngine } return copy }

test('the committed fast script is the builder\'s and validates: six conversations, the engine turn still runs beside the fast decision', () => {
  const committed = JSON.parse(fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'scripts', 'real-engine', 'scripts', `${BROWSER_FAST_SET}.json`), 'utf8'))
  assert.deepEqual(committed, JSON.parse(JSON.stringify(buildBrowserFastScript()))); assert.deepEqual(validateEngineScript(committed), { ok: true, errors: [] })
  assert.deepEqual(committed.conversations.map(c => c.id), ['fast-membership', 'fast-membership-inference', 'fast-delivery', 'fast-library', 'fast-dashboard-tab', 'fast-toggle-handover'])
  assert.ok(committed.conversations.every(c => c.turns[0].browserLoop.fast === true))
})

test('end to end on the fake engine: the Decision picks the one line and code shows it verbatim; the calculation goes to the engine; a hand-over has nothing to show; both timings are recorded', async t => {
  const w = world(t, GOOD)
  const result = await runCheck(w.options, asScripts(noTiming(buildBrowserFastScript())), w.deps)
  assert.equal(result.records.length, 6)
  const loops = []
  for (const [i, rec] of result.records.entries()) {
    assert.equal(rec.aborted, null, rec.abortDetail)
    loops.push(rec.turns[0].browserLoop)
    assert.deepEqual(failedOf(rec), [], `${rec.id}: ${JSON.stringify(rec.turns[0].expectations.filter(c => !c.ok))}`)
  }
  const [membership, inference, delivery, library, tab, toggle] = loops.map(l => l.fast)
  assert.deepEqual([membership.kind, membership.text], ['show', '다음 결제일: 2026-12-14'])
  assert.deepEqual([inference.kind, inference.reason], ['engine', 'needs_more_than_a_line'])
  assert.deepEqual([delivery.kind, delivery.text], ['show', '배송 상태: 배송 중 (11월 21일 도착 예정)'])
  assert.deepEqual([library.kind, library.text, tab.kind, tab.text], ['show', '반납 예정일: 2026-12-09', 'show', '다음 수령일: 2026-12-25'])
  assert.deepEqual([toggle.kind, toggle.reason], ['none', 'task_not_finished'])
  assert.ok(loops.every(l => Number.isFinite(l.engineMs)) && [membership, delivery, library, tab].every(f => Number.isFinite(f.ms)), 'both timings are in the record (seconds engine vs fast)')
  // the fast decision is one request per task with a finished page: (lines + 1) predicates
  assert.equal(w.decisionBodies.filter(b => b.questions.some(q => q.name === FAST_MORE)).length, 5)
})

test('the checks by code: a wrong kind, a line that is not the page\'s, a fast path not faster than the engine are each named', () => {
  const base = { delivered: true, reply: 'x', say: 'x', note: '{}', noteParsed: { status: 'done', page: ['다음 결제일: 2026-12-14'] }, entry: { handled: true }, entryAnswers: {}, acts: [], engineMs: 10800 }
  const run = (expect, fast) => Object.fromEntries(checkBrowserLoop(expect, { ...base, fast }).map(c => [c.check.replace(/^browser(Loop|Answer)\./, ''), c.ok]))
  const show = { kind: 'show', line: '다음 결제일: 2026-12-14', text: '다음 결제일: 2026-12-14', ms: 800, reason: 'one_line_decided', p: {} }
  assert.deepEqual(run({ fast: { kind: 'show', line: '다음 결제일: 2026-12-14', fasterThanEngine: true } }, show), { entered: true, fast_kind: true, fast_line: true, fast_line_grounded: true, fast_faster_than_engine: true, note_delivered: true, reply_present: true })
  assert.equal(run({ fast: { kind: 'engine' } }, show).fast_kind, false)
  assert.equal(run({ fast: { kind: 'show', line: '다음 결제일: 2026-12-15' } }, show).fast_line, false)
  assert.equal(run({ fast: { kind: 'show' } }, { ...show, line: '지어낸 줄', text: '지어낸 줄' }).fast_line_grounded, false)
  assert.equal(run({ fast: { kind: 'show', fasterThanEngine: true } }, { ...show, ms: 12000 }).fast_faster_than_engine, false)
})
