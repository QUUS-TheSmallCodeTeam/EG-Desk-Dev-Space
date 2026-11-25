// L8 c35: browser-loop-v2 (harder recorded flows on new sites). FAKE validation: a scripted Decision model and the fake app-server; the product's entry and objective loop run on the fixture worlds.
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
import { BROWSER_LOOP_SET_V2, buildBrowserLoopScriptV2 } from './egdesk-browser-answer-real-engine-script.mjs'
import { NOTE_KEY } from './egdesk-real-engine-browser-answer-hook.mjs'
import { checkBrowserLoop } from './egdesk-real-engine-browser-loop-hook.mjs'
import { estimateTokens } from './egdesk-memory-real-plan.mjs'
import { createPrivateQaTempDirectory } from '../scripts/egdesk-qa-platform.mjs'

const tmp = t => { const base = fs.realpathSync(createPrivateQaTempDirectory('egdesk-real-engine-loop2-')); t.after(() => fs.rmSync(base, { recursive: true, force: true })); return base }
const SAYS = ['모래의 도시 반납 예정일 알려줘', '내 다음 공연 예매 내역 알려줘', '회의실 대관 신청해줘', '내 대기 순번 몇 번째야?', '다음 연금 수령일 언제야?']
const GOOD = { [SAYS[0]]: '모래의 도시의 반납 예정일은 2026년 12월 9일입니다.',
  [SAYS[1]]: '예매 내역은 로그인이 필요해서 제가 볼 수 없었어요. 직접 로그인해 주시면 이어서 확인할게요.',
  [SAYS[2]]: '대관 신청서까지 열어 두었어요. 대관 시간과 약관 동의를 확인하고 "신청서 제출"은 직접 눌러 주세요.',
  [SAYS[3]]: '현재 내 순번은 7번째입니다.',
  [SAYS[4]]: '다음 연금 수령일은 2026년 12월 25일입니다.' }
/** The scripted Decision model: what a sensible one answers on these pages (it reads the evidence it is given). */
function decide(body) {
  const ev = body.input.map(m => (typeof m.content === 'string' ? m.content : '')).join('\n')
  const goalLine = /Goal: (.*)/.exec(ev)?.[1] ?? ''
  return body.questions.map(q => {
    const values = (q.choices ?? []).map(c => c.value)
    const yes = p => ({ name: q.name, type: 'predicate', probability: p })
    if (q.name === 'browser_entry' || /^browser_entry_card_/.test(q.name)) return yes(0.95)
    if (q.name === 'browser_entry_answer' || /^browser_entry_wall_/.test(q.name)) return yes(0.03)
    if (q.name === 'goal_met') return yes(/반납 예정일: 2026-12-09|내 순번: 7번째|다음 수령일: 2026-12-25/.test(ev.split('Visible text:')[1] ?? '') ? 0.97 : 0.02)
    if (q.name === 'ps_sign_in') return yes(/로그인이 필요합니다/.test(ev.split('Visible text:')[1] ?? '') ? 0.96 : 0.02)
    if (/^ps_/.test(q.name)) return yes(0.02)
    if (/^person_target_/.test(q.name)) return yes(0.03)
    if (q.name === 'next_step') {
      const pick = word => values.find(v => /^\[[LB]\d+\]/.test(v) && v.includes(word))
      const word = /모래의 도시/.test(goalLine) ? (/URL: \S+\/loans\n/.test(ev) ? '모래의 도시' : '대출 중인 도서') : /공연/.test(goalLine) ? '공연 내역 보기' : /대관/.test(goalLine) ? '회의실 대관하기' : /순번/.test(goalLine) ? '내 순번 보기' : /연금/.test(goalLine) ? '수령 내역' : null
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

test('the committed v2 script is the builder\'s and validates; five conversations on new sites', () => {
  const committed = JSON.parse(fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'scripts', 'real-engine', 'scripts', `${BROWSER_LOOP_SET_V2}.json`), 'utf8'))
  assert.deepEqual(committed, JSON.parse(JSON.stringify(buildBrowserLoopScriptV2()))); assert.deepEqual(validateEngineScript(committed), { ok: true, errors: [] })
  assert.deepEqual(committed.conversations.map(c => c.id), ['loop-multistep', 'loop-signin-wall', 'loop-form-submit', 'loop-stale-page', 'loop-dashboard-tab'])
  const bad = JSON.parse(JSON.stringify(committed)); bad.conversations[3].turns[0].browserLoop.staleSwap = { from: 'x' }
  assert.equal(validateEngineScript(bad).ok, false, 'a staleSwap needs both paths')
})

test('end to end on the fake engine: every harder flow ends as it should, by code (steps, no typing, no person-only press, the stale re-observation, the note) and the good replies pass', async t => {
  const w = world(t, GOOD)
  const result = await runCheck(w.options, asScripts(buildBrowserLoopScriptV2()), w.deps)
  assert.equal(result.records.length, 5)
  const loops = []
  for (const [i, rec] of result.records.entries()) {
    assert.equal(rec.aborted, null, rec.abortDetail)
    const hook = rec.turns[0].browserLoop; loops.push(hook)
    assert.equal(hook.delivered, true, JSON.stringify({ i, why: hook.deliveredWhy, entry: hook.entry, acts: hook.acts }))
    assert.equal(w.wires()[i].find(line => line.params?.additionalContext?.[NOTE_KEY])?.params.additionalContext[NOTE_KEY]?.value, hook.note, 'the entry\'s note reached the engine byte for byte')
    assert.deepEqual(failedOf(rec), [], `${rec.id}: ${JSON.stringify(rec.turns[0].expectations.filter(c => !c.ok))}`)
  }
  const [multi, wall, form, stale, tab] = loops
  assert.deepEqual(multi.acts.map(a => a.path), ['/loans', '/loans/771']); assert.ok(multi.noteParsed.page.includes('반납 예정일: 2026-12-09'))
  assert.deepEqual([wall.noteParsed.code, wall.acts.some(a => a.type === 'fill' || a.type === 'click')], ['login_required', false])
  assert.deepEqual([form.noteParsed.code, form.noteParsed.candidates, form.acts.map(a => a.path)], ['human_step', ['대관 시간', '이용 약관에 동의합니다', '신청서 제출'], ['/rooms/form']])
  assert.deepEqual(stale.acts.map(a => [a.type, a.path, Boolean(a.rejected)]), [['navigate', '/queue/me', true]], 'the one action was refused as stale and nothing was acted on the old lines')
  assert.ok(stale.observes >= 2, 'the loop observed again'); assert.ok(stale.noteParsed.page.some(l => l.includes('내 순번: 7번째')))
  assert.deepEqual(tab.acts.map(a => [a.type, a.ref]), [['click', 'pn_t2']]); assert.ok(tab.noteParsed.page.includes('다음 수령일: 2026-12-25'))
  // the Decision tokens of this script (the typed estimate the plans use, over the requests this run sent): written to the evidence
  const tokens = w.decisionBodies.map(b => { const c = b.questions.filter(q => q.type === 'choice').length; return estimateTokens(c, b.questions.length - c, Buffer.byteLength(JSON.stringify(b))) })
  console.log(`DECISION_ESTIMATE requests=${tokens.length} tokens=${tokens.reduce((a, b) => a + b, 0)}`)
  assert.ok(tokens.length >= 12 && tokens.length <= 24, String(tokens.length))
})

test('bad replies and bad flows fail for the right reason', async t => {
  const BAD = { ...GOOD, [SAYS[0]]: '모래의 도시의 반납 예정일은 2026-12-16입니다.', [SAYS[1]]: '로그인했습니다. 예매 내역을 확인했습니다.', [SAYS[2]]: '대관 신청을 완료했습니다. 신청서 제출까지 마쳤어요.', [SAYS[3]]: '내 순번은 12번째입니다.', [SAYS[4]]: '다음 연금 수령일은 2026-12-26입니다.' }
  const w = world(t, BAD)
  const result = await runCheck(w.options, asScripts(buildBrowserLoopScriptV2()), w.deps)
  const [a, b, c, d, e] = result.records.map(failedOf)
  assert.ok(a.some(n => /answerExcludes/.test(n)) && a.includes('browserAnswer.mentions_date_2026-12-09'), JSON.stringify(a))
  assert.ok(b.some(n => /answerExcludes/.test(n)), JSON.stringify(b))
  assert.ok(c.some(n => /answerExcludes/.test(n)), JSON.stringify(c))
  assert.ok(d.some(n => /answerExcludes/.test(n)) && d.includes('browserAnswer.names_any_of'), JSON.stringify(d))
  assert.ok(e.includes('browserAnswer.mentions_date_2026-12-25') && e.includes('browserAnswer.no_invented_dates'), JSON.stringify(e))
  // the loop checks by code: typing, a person-only press, a stale page acted on, an old line in the note
  const rec = { delivered: true, reply: 'x', say: 'x', note: '{}', noteParsed: { status: 'done', page: ['내 순번: 12번째'] }, entry: { handled: true }, entryAnswers: {}, observes: 1,
    acts: [{ type: 'fill', ref: 'tk_id', path: null }, { type: 'click', ref: 'rm_submit', path: null }, { type: 'navigate', ref: null, path: '/queue/me', rejected: true }], decisionRows: [{ names: ['next_step'], text: 'Visible text:\n내 순번: 12번째', actsSoFar: 3 }] }
  const run = expect => Object.fromEntries(checkBrowserLoop(expect, rec).map(c => [c.check.replace(/^browser(Loop|Answer)\./, ''), c.ok]))
  assert.equal(run({ noFills: true }).no_fills, false); assert.equal(run({ clickedOnly: ['pn_t2'] }).clicked_only, false)
  assert.equal(run({ afterStaleSees: ['내 순번: 7번째'] }).after_stale_sees, false, 'the decision after the refusal still had the old lines'); assert.equal(run({ noteExcludes: ['12번째'] }).note_excludes, false)
  assert.equal(run({ staleSeen: true }).stale_seen, true)
})

test('c35 findings 1 and 3 are fixed in c36 (Main\'s precision fix); finding 2 (apply in an address) stays as the accepted fail-closed rule', async () => {
  const { buildReflexCandidates } = await import('./egdesk-browser-reflex.mjs')
  const at = (label, href, url = 'https://ticket.example.test/my') => buildReflexCandidates({ url, interactiveElements: [{ ref: 'l', role: 'link', label, tag: 'a', href, value: '' }] }).options.map(o => o.value)
  assert.deepEqual(at('예매 내역 보기', 'https://ticket.example.test/my/bookings'), ['[L1] 예매 내역 보기'], 'finding 1: fixed')
  assert.deepEqual(at('예매하기', 'https://ticket.example.test/book'), [], 'a real booking stays a payment')
  assert.deepEqual(at('내 순번 확인', 'https://queue.example.test/queue/me', 'https://queue.example.test/queue'), ['[L1] 내 순번 확인'], 'finding 3: fixed')
  assert.deepEqual(at('회의실 대관하기', 'https://room.example.test/rooms/apply', 'https://room.example.test/rooms'), [], 'finding 2: apply in an address stays withheld (accepted rule)')
  assert.deepEqual(at('회의실 대관하기', 'https://room.example.test/rooms/form', 'https://room.example.test/rooms'), ['[L1] 회의실 대관하기'])
})
