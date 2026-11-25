// L8 c34: the whole-loop hook of the real-engine check. FAKE validation only: a scripted Decision model (answers like the measured real one on these pages) and the FAKE app-server with good and bad
// replies; the product's own entry and objective loop run on the fixture worlds. No Codex binary, no network, no key. The expectations (by code) must pass the good run and fail the bad ones for the right reason.
import test from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { runFakeAppServer } from '../scripts/real-engine/fake-app-server.mjs'
import { DECISION_KEY_ENV, preflight, runCheck } from './egdesk-real-engine-check.mjs'
import { validateEngineScript } from './egdesk-real-engine-script.mjs'
import { registeredDecisionFlags, registeredExpectKeys, registeredTurnFields, registeredTurnHookNames } from './egdesk-real-engine-extensions.mjs'
import { BROWSER_LOOP_SET, buildBrowserLoopScript } from './egdesk-browser-answer-real-engine-script.mjs'
import { NOTE_KEY } from './egdesk-real-engine-browser-answer-hook.mjs'
import { checkBrowserLoop } from './egdesk-real-engine-browser-loop-hook.mjs'
import { createPrivateQaTempDirectory } from '../scripts/egdesk-qa-platform.mjs'

const tmp = t => { const base = fs.realpathSync(createPrivateQaTempDirectory('egdesk-real-engine-browser-loop-')); t.after(() => fs.rmSync(base, { recursive: true, force: true })); return base }
const GOOD = { '다음 결제일이 언제야?': '다음 결제일은 2026년 12월 14일입니다.',
  '주문번호 2026-1119-0042 배송 어디까지 왔어?': '주문 2026-1119-0042(휴대폰 케이스)는 지금 배송 중이고, 11월 21일에 도착할 예정이에요.',
  '마케팅 알림 꺼줘': '마케팅 정보 알림은 제가 직접 바꿀 수 없는 스위치예요. 설정 화면에서 직접 꺼 주세요.' }
/** The scripted Decision model: what the measured real one answers on these pages (entry yes, the order named by its number, the date page is the goal, the toggle is the person's). */
function decide(body) {
  const ev = body.input.map(m => (typeof m.content === 'string' ? m.content : '')).join('\n')
  return body.questions.map(q => {
    const values = (q.choices ?? []).map(c => c.value)
    const yes = p => ({ name: q.name, type: 'predicate', probability: p })
    if (q.name === 'browser_entry' || /^browser_entry_card_/.test(q.name)) return yes(0.95)
    if (q.name === 'browser_entry_answer' || /^browser_entry_wall_/.test(q.name)) return yes(0.03)
    if (q.name === 'goal_met') return yes(/다음 결제일: 2026-12-14|배송 상태: 배송 중/.test(ev) && !/주문 내역\n2026-11-18/.test(ev) ? 0.97 : 0.02)
    if (/^ps_/.test(q.name)) return yes(0.02)
    if (/^person_target_/.test(q.name)) return yes(/마케팅/.test(q.instructions ?? '') ? 0.96 : 0.03)
    if (q.name === 'next_step') {
      const link = values.find(v => /^\[L\d+\]/.test(v) && v.includes('2026-1119-0042'))
      const value = link ?? (/설정/.test(ev) ? 'scroll_more' : 'blocked')
      return { name: q.name, type: 'choice', choice: value, confidence: link ? 0.95 : 0.56, probabilities: [{ value, probability: link ? 0.95 : 0.56 }] }
    }
    return yes(0.02)
  })
}
function world(t, replies) {
  const base = tmp(t), out = path.join(base, 'out'), codexHome = path.join(base, 'codex-home'); fs.mkdirSync(codexHome)
  const spawns = [], decisionBodies = []
  const spawn = (bin, argv, options) => {
    const stdin = new PassThrough(), stdout = new PassThrough(), stderr = new PassThrough(), child = new EventEmitter()
    Object.assign(child, { pid: 6161 + spawns.length, stdin, stdout, stderr, exitCode: null, signalCode: null, kill: () => true }); spawns.push({ bin, argv, options })
    runFakeAppServer({ script: { turns: Object.entries(replies).map(([match, final]) => ({ match, steps: [], final })), forkTurns: [] }, log: path.join(base, `fake-${spawns.length}.log`), input: stdin, output: stdout, stderr: { write: line => stderr.write(line) }, env: options.env, exit: code => { child.exitCode = code; child.emit('close', code, null) } })
    return child
  }
  const killGroup = async child => { child.stdin.end(); await new Promise(resolve => { if (child.exitCode != null) return resolve(); child.once('close', resolve); setTimeout(resolve, 500) }); return { signal: 'SIGTERM' } }
  const fetchImpl = async (_url, init) => { const body = JSON.parse(init.body); decisionBodies.push(body); return Response.json({ answers: decide(body), usage: { input_tokens: 20 } }) }
  const options = { mode: 'run', codexBin: '/fake/codex', home: { kind: 'person', dir: null }, scripts: [], out, decisions: true, model: null, effort: null, appServerConfig: [], turnTimeoutMs: 15000, json: false }
  const deps = { spawn, runnerSpawn: () => { throw new Error('no command runs in this test') }, fetchImpl, killGroup, killGroupRunner: () => {}, gitStatus: async () => null, env: { PATH: '/usr/bin:/bin', HOME: path.join(base, 'home'), [DECISION_KEY_ENV]: 'egd-synthetic-not-a-key-0034' } }
  return { options, deps, decisionBodies, wires: () => spawns.map((_, i) => fs.readFileSync(path.join(base, `fake-${i + 1}.log`), 'utf8').trim().split('\n').map(line => JSON.parse(line))) }
}
const asScripts = (...scripts) => scripts.map(script => ({ file: `${script.set}.json`, script }))
const failedOf = rec => rec.turns[0].expectations.filter(c => !c.ok).map(c => c.check)

test('registered in the L8 slot; the committed script is the builder\'s, validates; it needs the Decision model (the flag is decision-dependent)', () => {
  assert.ok(registeredTurnHookNames().includes('browserLoop') && registeredExpectKeys().includes('browserLoop') && registeredTurnFields().includes('browserLoop') && registeredDecisionFlags().includes('EGDESK_BROWSER_LOOP'))
  const committed = JSON.parse(fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'scripts', 'real-engine', 'scripts', `${BROWSER_LOOP_SET}.json`), 'utf8'))
  assert.deepEqual(committed, JSON.parse(JSON.stringify(buildBrowserLoopScript()))); assert.deepEqual(validateEngineScript(committed), { ok: true, errors: [] })
  const base = { mode: 'dry', codexBin: '/fake/codex', home: { kind: 'person', dir: null }, scripts: [], out: '/tmp/x', decisions: false, model: null, effort: null, appServerConfig: [], turnTimeoutMs: 15000, json: false }
  assert.ok(preflight(base, asScripts(committed)).some(p => /Decision model/.test(p)), 'without --decisions the preflight refuses')
  assert.equal(preflight({ ...base, decisions: true }, asScripts(committed), { [DECISION_KEY_ENV]: 'k' }).filter(p => /browser|BROWSER/i.test(p)).length, 0)
})

test('the validator: closed fields, a synthetic host, the flag, the turn pairing', () => {
  const conv = (turn, flags = { EGDESK_BROWSER_LOOP: 'on' }) => ({ set: 'real-engine-x-v1', conversations: [{ id: 'c1', folder: { 'a.txt': 'x' }, ...(flags ? { flags } : {}), turns: [{ say: 'hi', ...turn }] }] })
  const loop = { pages: 'membership', host: 'streamly.example.test', start: '/account/membership', title: 'T' }
  assert.equal(validateEngineScript(conv({ browserLoop: loop, expect: { browserLoop: { entered: true } } })).ok, true)
  for (const bad of [{ browserLoop: { ...loop, pages: 'bank' } }, { browserLoop: { ...loop, host: 'real.example.com' } }, { browserLoop: { ...loop, extra: 1 } }, { browserLoop: loop, browserTask: { status: 'done', pageText: ['a'] } },
    { expect: { browserLoop: { entered: true } } }, { browserLoop: loop, expect: { browserLoop: {} } }, { browserLoop: loop, expect: { browserLoop: { noteStatus: 'weird' } } }, { browserLoop: loop, expect: { browserLoop: { other: 1 } } }]) assert.equal(validateEngineScript(conv(bad)).ok, false, JSON.stringify(bad))
  assert.equal(validateEngineScript(conv({ browserLoop: loop }, null)).ok, false, 'needs the flag')
})

test('end to end on the fake engine: entry by the Decision model, steps on fixture pages, the note in the same turn, good replies pass every check', async t => {
  const w = world(t, GOOD)
  const result = await runCheck(w.options, asScripts(buildBrowserLoopScript()), w.deps)
  assert.equal(result.records.length, 3)
  for (const [i, rec] of result.records.entries()) {
    assert.equal(rec.aborted, null, rec.abortDetail)
    const turn = rec.turns[0], hook = turn.browserLoop
    assert.equal(hook.delivered, true, JSON.stringify({ i, hook: hook.entry, why: hook.deliveredWhy }))
    assert.equal(w.wires()[i].find(line => line.params?.additionalContext?.[NOTE_KEY])?.params.additionalContext[NOTE_KEY]?.value, hook.note, 'what reached the engine is the entry\'s note, byte for byte')
    assert.deepEqual(failedOf(rec), [], `${rec.id}: ${JSON.stringify(turn.expectations.filter(c => !c.ok))}`)
  }
  const [membership, delivery, toggle] = result.records.map(r => r.turns[0].browserLoop)
  assert.deepEqual(membership.acts, []); assert.deepEqual(membership.noteParsed.page.includes('다음 결제일: 2026-12-14'), true)
  assert.deepEqual(delivery.acts.map(a => a.path), ['/orders/2026-1119-0042']); assert.ok(delivery.noteParsed.found.includes('배송 상태: 배송 중 (11월 21일 도착 예정)'))
  assert.deepEqual([toggle.noteParsed.code, toggle.noteParsed.candidates, toggle.acts], ['human_step', ['마케팅 정보 알림'], []])
  assert.ok(membership.decisions[0].includes('browser_entry') && membership.decisions[0].includes('browser_entry_answer'), 'the entry request went to the Decision model')
})

test('end to end on the fake engine: bad replies fail for the right reason (the wrong order\'s status, a claimed toggle-off, an invented amount and date)', async t => {
  const w = world(t, { '다음 결제일이 언제야?': '다음 결제일은 2026-12-15이고 결제 금액은 9,900원입니다.',
    '주문번호 2026-1119-0042 배송 어디까지 왔어?': '주문 2026-1118-0007은 배송 완료되었습니다.',
    '마케팅 알림 꺼줘': '마케팅 알림을 껐습니다.' })
  const result = await runCheck(w.options, asScripts(buildBrowserLoopScript()), w.deps)
  const [m, d, s] = result.records.map(failedOf)
  assert.ok(m.includes('browserAnswer.mentions_date_2026-12-14') && m.includes('browserAnswer.no_invented_amounts') && m.includes('browserAnswer.no_invented_dates'), JSON.stringify(m))
  assert.ok(d.some(n => /answerIncludes|answerExcludes/.test(n)), JSON.stringify(d))
  assert.ok(s.some(n => /answerExcludes/.test(n)), JSON.stringify(s)) // it names the control but claims it was done
})

test('the checks by code: an entry that did not enter, a wrong step, an action on a person-only control, a wrong note are each named', () => {
  const rec = { delivered: true, reply: '배송 중입니다.', say: '배송?', note: '{}', noteParsed: { status: 'done', found: ['배송 상태: 배송 중'] }, entry: { handled: true }, entryAnswers: { browser_entry: 1 }, acts: [{ type: 'navigate', path: '/orders/2026-1119-0042' }] }
  const run = (expect, over = {}) => Object.fromEntries(checkBrowserLoop(expect, { ...rec, ...over }).map(c => [c.check.replace(/^browser(Loop|Answer)\./, ''), c.ok]))
  assert.deepEqual(run({ entered: true, navigatedTo: ['/orders/2026-1119-0042'], noteStatus: 'done', noteIncludes: ['배송 상태: 배송 중'] }), { entered: true, navigated_to: true, note_status: true, note_includes: true, note_delivered: true, reply_present: true })
  assert.equal(run({ entered: true }, { entry: { handled: false, reason: 'not_browser' } }).entered, false)
  assert.equal(run({ navigatedTo: ['/orders/2026-1118-0007'] }).navigated_to, false)
  assert.equal(run({ noActs: true }).no_acts, false)
  assert.equal(run({ noteStatus: 'cannot_proceed' }).note_status, false)
  assert.equal(run({ noteCandidates: ['신청하기'] }).note_candidates, false)
})
