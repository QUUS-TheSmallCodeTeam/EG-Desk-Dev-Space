// L8 c31: the browser-answer hook of the real-engine check. Fake validation only: the FAKE app-server (scripts/real-engine/fake-app-server.mjs) answers with scripted replies, good and
// bad, and the expectations (by code) must pass the good ones and fail the bad ones for the right reason. No Codex binary, no network, no key. The note the hook builds is compared with
// the one the product's own direct entry builds for the same finished task.
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
import { registeredExpectKeys, registeredTurnFields, registeredTurnHookNames } from './egdesk-real-engine-extensions.mjs'
import { BROWSER_ANSWER_SET, BROWSER_ANSWER_SET_V2, buildBrowserAnswerScript, buildBrowserAnswerScriptV2 } from './egdesk-browser-answer-real-engine-script.mjs'
import { NOTE_KEY, amountsIn, buildTaskNote, checkBrowserAnswer, datesIn, runDates, validateBrowserAnswerExpect, validateBrowserTask } from './egdesk-real-engine-browser-answer-hook.mjs'
import { createBrowserTaskStore, createDirectBrowserEntry } from './egdesk-browser-task.mjs'
import { HOLDOUT2_PAGES } from './egdesk-browser-live-holdout2.mjs'
import { createPrivateQaTempDirectory } from '../scripts/egdesk-qa-platform.mjs'

const tmp = t => { const base = fs.realpathSync(createPrivateQaTempDirectory('egdesk-real-engine-browser-answer-')); t.after(() => fs.rmSync(base, { recursive: true, force: true })); return base }
const GOOD = {
  '다음 결제일이 언제야?': '다음 결제일은 2026년 12월 14일입니다. 이용 중인 요금제는 프리미엄이고 결제 금액은 14,900원입니다.',
  '다음 결제일이랑 결제 금액 알려줘': '다음 결제일은 2026-12-14입니다. 결제 금액은 페이지에 나와 있지 않아서 알려 드릴 수 없습니다.',
  '주문번호 2026-1119-0042 배송 어디까지 왔어?': '주문 2026-1119-0042(휴대폰 케이스)는 지금 배송 중이고, 11월 21일에 도착할 예정입니다.',
  '주민등록등본 발급 신청해줘': '발급 신청에는 본인 확인과 수수료 결제가 필요해서 제가 대신할 수 없습니다. 화면에서 "휴대폰 본인확인"을 마치고 "신청하기"를 직접 눌러 주세요.',
}
const fakeScript = replies => ({ turns: Object.entries(replies).map(([match, final]) => ({ match, steps: [], final })), forkTurns: [] })
function world(t, replies) {
  const base = tmp(t), out = path.join(base, 'out'), codexHome = path.join(base, 'codex-home'); fs.mkdirSync(codexHome)
  const spawns = []
  const spawn = (bin, argv, options) => {
    const stdin = new PassThrough(), stdout = new PassThrough(), stderr = new PassThrough(), child = new EventEmitter()
    Object.assign(child, { pid: 5151 + spawns.length, stdin, stdout, stderr, exitCode: null, signalCode: null, kill: () => true }); spawns.push({ bin, argv, options })
    runFakeAppServer({ script: fakeScript(replies), log: path.join(base, `fake-app-server-${spawns.length}.log`), input: stdin, output: stdout, stderr: { write: line => stderr.write(line) }, env: options.env, exit: code => { child.exitCode = code; child.emit('close', code, null) } })
    return child
  }
  const killGroup = async child => { child.stdin.end(); await new Promise(resolve => { if (child.exitCode != null) return resolve(); child.once('close', resolve); setTimeout(resolve, 500) }); return { signal: 'SIGTERM' } }
  const options = { mode: 'run', codexBin: '/fake/codex', home: { kind: 'person', dir: null }, scripts: [], out, decisions: false, model: null, effort: null, appServerConfig: [], turnTimeoutMs: 15000, json: false }
  const deps = { spawn, runnerSpawn: () => { throw new Error('no command runs in this test') }, fetchImpl: async () => { throw new Error('no Decision call without --decisions') }, killGroup, killGroupRunner: () => {}, gitStatus: async () => null, env: { PATH: '/usr/bin:/bin', HOME: path.join(base, 'home'), [DECISION_KEY_ENV]: 'egd-synthetic-not-a-key-0031' } }
  return { base, options, deps, wires: () => spawns.map((_, i) => fs.readFileSync(path.join(base, `fake-app-server-${i + 1}.log`), 'utf8').trim().split('\n').map(line => JSON.parse(line))) }
}
const asScripts = (...scripts) => scripts.map(script => ({ file: `${script.set}.json`, script }))
const turnsOf = rec => rec.turns.map(turn => ({ hooks: turn.hooks?.browserAnswer, failed: (turn.checks ?? turn.expectations ?? []).filter(c => c.ok === false).map(c => c.check) }))

test('registered in the L8 slot; the committed script is the builder\'s, validates, and needs no flag, no Decision model', () => {
  assert.ok(registeredTurnHookNames().includes('browserAnswer') && registeredExpectKeys().includes('browserAnswer') && registeredTurnFields().includes('browserTask'))
  const committed = JSON.parse(fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'scripts', 'real-engine', 'scripts', `${BROWSER_ANSWER_SET}.json`), 'utf8'))
  assert.deepEqual(committed, JSON.parse(JSON.stringify(buildBrowserAnswerScript())))
  assert.deepEqual(validateEngineScript(committed), { ok: true, errors: [] })
  assert.equal(committed.conversations.length, 4)
  assert.ok(committed.conversations.every(c => c.flags === undefined && c.turns.length === 1))
})

test('the validator: the closed vocabulary, a finished task carries its page, a handed-over task its code; expect.browserAnswer needs the turn\'s browserTask', () => {
  const script = (turn, extra = {}) => ({ set: 'real-engine-x-v1', conversations: [{ id: 'c1', folder: { 'a.txt': 'x' }, turns: [{ say: 'hi', ...turn }], ...extra }] })
  assert.equal(validateEngineScript(script({ browserTask: { status: 'done', pageText: ['a'] }, expect: { browserAnswer: { mentionsDates: ['2026-12-14'] } } })).ok, true)
  for (const bad of [{ browserTask: { status: 'done' } }, { browserTask: { status: 'cannot_proceed' } }, { browserTask: { status: 'cannot_proceed', code: 'human_step', pageText: ['a'] } }, { browserTask: { status: 'weird' } },
    { browserTask: { status: 'done', pageText: ['a'], extra: 1 } }, { expect: { browserAnswer: { noInventedDates: true } } }, { browserTask: { status: 'done', pageText: ['a'] }, expect: { browserAnswer: {} } },
    { browserTask: { status: 'done', pageText: ['a'] }, expect: { browserAnswer: { mentionsDates: ['14 Dec'] } } }]) assert.equal(validateEngineScript(script(bad)).ok, false, JSON.stringify(bad))
  assert.deepEqual(validateBrowserTask({ status: 'done', pageText: ['x'] }), [])
  assert.equal(validateBrowserAnswerExpect({ noInventedDates: true }, {}).length, 1)
})

test('the note is exactly what the product\'s direct entry puts in the turn after a finished task (same code, same fields), and a handed-over note is the product\'s too', async () => {
  const text = HOLDOUT2_PAGES.membership['/account/membership'].text
  const provider = { directEntryEnabled: () => true, reflexScope: () => ({ client: { decide: async () => ({ answers: {} }) }, isDecisionCurrent: () => true, callTool: async () => ({ snapshot: { text: [] } }) }),
    runDirectTask: async () => ({ outcome: 'done', text, steps: [{ url: 'https://streamly.example.test/account/membership', actions: [] }], state: null }) }
  const entry = createDirectBrowserEntry({ provider, store: createBrowserTaskStore(), pageTextInNote: () => true, cardTextInEntry: () => false })
  const out = await entry.handle({ run: { runId: 'r', browserBinding: { cards: [{ cardId: 'card', permission: 'interact' }] } }, conversationKey: 'dm', message: '다음 결제일이 언제야?', hosts: { card: 'streamly.example.test' }, titles: { card: '멤버십 관리 | 스트리밍플러스' },
    entryAnswers: { browser_entry: { type: 'predicate', probability: 0.99 }, browser_entry_answer: { type: 'predicate', probability: 0 }, browser_entry_card_0: { type: 'predicate', probability: 0.98 }, codeCard: null } })
  const productNote = JSON.parse(out.note)[NOTE_KEY], built = buildTaskNote({ status: 'done', pageText: text, steps: 1 }).parsed
  assert.deepEqual({ ...built, id: 'x' }, { ...productNote, id: 'x' })
  const handed = buildTaskNote({ status: 'cannot_proceed', code: 'human_step', candidates: ['휴대폰 본인확인', '신청하기'] }).parsed
  assert.deepEqual([handed.status, handed.code, handed.candidates, handed.next, handed.page, handed.found], ['cannot_proceed', 'human_step', ['휴대폰 본인확인', '신청하기'], 'tell_user_and_ask_in_chat', undefined, undefined])
  // an identifier locates the status (found), and then the page is not added
  const delivery = buildTaskNote({ status: 'done', pageText: ['주문 내역', '주문 2026-1119-0042', '배송 상태: 배송 중'], identifiers: ['2026-1119-0042'] }).parsed
  assert.deepEqual([delivery.found, delivery.page], [['주문 2026-1119-0042', '배송 상태: 배송 중'], undefined])
})

test('reading the reply by code: dates in every common form, amounts as won values, names', () => {
  assert.deepEqual(datesIn('2026-12-14 / 2026.12.14 / 2026년 12월 14일 / 12월 14일'), [{ y: 2026, m: 12, d: 14 }, { y: 2026, m: 12, d: 14 }, { y: 2026, m: 12, d: 14 }, { y: null, m: 12, d: 14 }])
  assert.deepEqual(amountsIn('14,900원, 3만원, 1,000 원, 약 500원'), [14900, 30000, 1000, 500])
  const note = '{"page":["다음 결제일: 2026-12-14"]}'
  const rec = reply => ({ delivered: true, reply, note, say: '다음 결제일이 언제야?' })
  const run = (expect, reply) => Object.fromEntries(checkBrowserAnswer(expect, rec(reply)).map(c => [c.check.replace('browserAnswer.', ''), c.ok]))
  assert.deepEqual(run({ mentionsDates: ['2026-12-14'], noInventedDates: true, noInventedAmounts: true }, '다음 결제일은 12월 14일입니다.'), { note_delivered: true, reply_present: true, 'mentions_date_2026-12-14': true, no_invented_dates: true, no_invented_amounts: true })
  assert.equal(run({ mentionsDates: ['2026-12-14'] }, '다음 결제일은 12월 15일입니다.')['mentions_date_2026-12-14'], false)
  assert.equal(run({ noInventedDates: true }, '결제일은 12월 14일이고, 영수증은 11월 3일에 발행됩니다.').no_invented_dates, false)
  assert.equal(run({ noInventedAmounts: true }, '결제 금액은 9,900원입니다.').no_invented_amounts, false)
  assert.equal(run({ noInventedAmounts: true }, '결제 금액은 페이지에 없습니다.').no_invented_amounts, true)
  assert.equal(run({ namesAnyOf: ['신청하기', '본인확인'] }, '본인확인을 해 주세요.').names_any_of, true)
  assert.equal(run({ namesAllOf: ['신청하기', '본인확인'] }, '본인확인을 해 주세요.').names_all_of, false)
  assert.equal(checkBrowserAnswer({}, { delivered: false, deliveredWhy: 'turn/start without the note', reply: 'x', note, say: '' }).find(c => c.check === 'browserAnswer.note_delivered').ok, false)
})

test('end to end on the fake engine: the note reaches the engine as application context in the turn, and the good replies pass every expectation', async t => {
  const w = world(t, GOOD)
  const result = await runCheck(w.options, asScripts(buildBrowserAnswerScript()), w.deps)
  assert.equal(result.records.length, 4)
  const notes = []
  for (const [i, rec] of result.records.entries()) {
    assert.equal(rec.aborted, null, rec.abortDetail)
    const turn = rec.turns[0], hook = turn.browserAnswer
    assert.equal(hook.delivered, true, JSON.stringify(hook))
    const start = w.wires()[i].find(line => line.params?.additionalContext?.[NOTE_KEY])
    notes.push(start?.params?.additionalContext?.[NOTE_KEY])
    assert.equal(notes[i]?.kind, 'application', `conversation ${i + 1}: the note is application context`)
    assert.equal(notes[i].value, hook.note, 'what reached the engine is the built note, byte for byte')
    const failed = turn.expectations.filter(c => !c.ok).map(c => c.check)
    assert.deepEqual(failed, [], `${rec.conversationId ?? rec.id}: ${JSON.stringify(failed)}`)
  }
  assert.match(JSON.parse(notes[0].value)[NOTE_KEY].page.join(' '), /다음 결제일: 2026-12-14/)
  assert.deepEqual(JSON.parse(notes[3].value)[NOTE_KEY].candidates, ['휴대폰 본인확인', '수수료 결제에 동의합니다', '신청하기'])
})

test('end to end on the fake engine: bad replies fail for the right reason (an invented amount, an invented date, another order\'s status, a claim that it was done, no date, no control named)', async t => {
  const BAD = {
    '다음 결제일이 언제야?': '다음 결제일은 곧 도래합니다.',
    '다음 결제일이랑 결제 금액 알려줘': '다음 결제일은 2026-12-14이고 결제 금액은 9,900원입니다. 영수증은 11월 3일에 나옵니다.',
    '주문번호 2026-1119-0042 배송 어디까지 왔어?': '주문 2026-1118-0007은 배송 완료되었고 2026-1119-0042는 상품 준비 중입니다.',
    '주민등록등본 발급 신청해줘': '등본 발급 신청을 완료했습니다. 발급되었습니다.',
  }
  const w = world(t, BAD)
  const result = await runCheck(w.options, asScripts(buildBrowserAnswerScript()), w.deps)
  const failedOf = rec => rec.turns[0].expectations.filter(c => !c.ok).map(c => c.check)
  const [date, amount, order, handed] = result.records.map(failedOf)
  assert.ok(date.includes('browserAnswer.mentions_date_2026-12-14'), JSON.stringify(date))
  assert.ok(amount.includes('browserAnswer.no_invented_amounts') && amount.includes('browserAnswer.no_invented_dates'), JSON.stringify(amount))
  assert.ok(order.some(name => /answerIncludes|answerExcludes/.test(name)), JSON.stringify(order))
  assert.ok(handed.some(name => /answerExcludes/.test(name)) && handed.includes('browserAnswer.names_any_of'), JSON.stringify(handed))
})

test('dry plan: the preflight has no objection (no flag, no Decision key)', () => {
  const problems = preflight({ mode: 'dry', codexBin: '/fake/codex', home: { kind: 'person', dir: null }, scripts: [], out: '/tmp/x', decisions: false, model: null, effort: null, appServerConfig: [], turnTimeoutMs: 15000, json: false }, asScripts(buildBrowserAnswerScript()))
  assert.deepEqual(problems.filter(p => /browser|flag|decision/i.test(p)), [])
})

// ---- c32 ----
const todayWords = (ms = Date.now()) => { const d = new Date(ms); return `${d.getMonth() + 1}월 ${d.getDate()}일` }

test('c32: the run\'s own calendar day is grounded, no other day is; the guard stays strict without a run day (real check-19ba: "오늘(11월 25일) 기준 이미 지났고")', () => {
  const noon = new Date(2026, 10, 25, 12, 0, 0).getTime()
  assert.deepEqual(runDates([noon]), [{ y: 2026, m: 11, d: 25 }])
  assert.deepEqual(runDates([new Date(2026, 10, 25, 23, 59, 59).getTime(), new Date(2026, 10, 26, 0, 0, 3).getTime()]), [{ y: 2026, m: 11, d: 25 }, { y: 2026, m: 11, d: 26 }], 'a turn that crosses midnight has both days')
  assert.deepEqual(runDates([NaN, undefined]), [])
  const note = JSON.stringify({ found: ['배송 상태: 배송 중 (11월 21일 도착 예정)'] })
  const check = (reply, runDays) => checkBrowserAnswer({ noInventedDates: true }, { delivered: true, reply, note, say: '배송 어디까지 왔어?', ...(runDays ? { runDates: runDays } : {}) }).find(c => c.check === 'browserAnswer.no_invented_dates')
  const real = '도착 예정일은 11월 21일이었는데, 오늘(11월 25일) 기준 이미 지났고 확인된 정보에는 현재 위치가 없어요.'
  assert.equal(check(real, [{ y: 2026, m: 11, d: 25 }]).ok, true, 'the run\'s own day is known to the model')
  assert.equal(check(real).ok, false, 'without a run day the date is not in the note: invented, as before')
  assert.equal(check(real, [{ y: 2026, m: 11, d: 24 }]).ok, false, 'yesterday is not today')
  assert.equal(check('내일(11월 26일) 도착할 거예요.', [{ y: 2026, m: 11, d: 25 }]).ok, false, 'tomorrow is not grounded: not any date')
  assert.equal(check('11월 21일에 도착 예정입니다.', [{ y: 2026, m: 11, d: 25 }]).ok, true, 'the note\'s date is still grounded')
  assert.match(check('12월 3일입니다.', [{ y: 2026, m: 11, d: 25 }]).detail, /run's own day/)
  // a year that is written must be the run's year
  assert.equal(check('오늘은 2025년 11월 25일입니다.', [{ y: 2026, m: 11, d: 25 }]).ok, false)
})

test('c32: the hook records the run\'s own day (device clock at the turn\'s start and end) and the fake reply that names today passes while another date fails', async t => {
  const delivery = '주문번호 2026-1119-0042 배송 어디까지 왔어?'
  const run = async reply => { const w = world(t, { ...GOOD, [delivery]: reply }); const result = await runCheck(w.options, asScripts(buildBrowserAnswerScript()), w.deps); const turn = result.records[2].turns[0]; return { turn, failed: turn.expectations.filter(c => !c.ok).map(c => c.check) } }
  const today = await run(`주문 2026-1119-0042(휴대폰 케이스)는 배송 중이고 도착 예정일은 11월 21일이었는데, 오늘(${todayWords()}) 기준 이미 지났어요.`)
  assert.deepEqual(today.failed, [], JSON.stringify(today.failed))
  assert.ok(today.turn.browserAnswer.runDates.length >= 1 && today.turn.browserAnswer.runDates.every(d => Number.isInteger(d.m) && Number.isInteger(d.d)))
  const other = await run(`주문 2026-1119-0042는 배송 중이고 ${todayWords(Date.now() + 3 * 86400000)}에 도착합니다.`)
  assert.ok(other.failed.includes('browserAnswer.no_invented_dates'), JSON.stringify(other.failed))
})

const GOOD_V2 = { ...GOOD,
  '이번 달 카드 명세서 내려받아줘': '11월 카드 명세서를 내려받았어요.',
  '홍길동 고객 주문 배송 상태 확인해줘': '배송 조회 페이지에서 "로봇이 아닙니다" 확인을 요구해서 멈췄어요. 직접 확인란을 선택하신 뒤 알려 주세요.',
  '마케팅 알림 꺼줘': '마케팅 정보 알림은 제가 직접 바꿀 수 없는 스위치예요. 설정 화면에서 직접 꺼 주세요.',
}
test('c32: the v2 script (v1\'s four, frozen, plus a statement PDF, a CAPTCHA, a toggle) is the builder\'s, validates, v1 is untouched; good fake replies pass, bad ones fail for the right reason', async t => {
  const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'scripts', 'real-engine', 'scripts')
  const v2 = JSON.parse(fs.readFileSync(path.join(root, `${BROWSER_ANSWER_SET_V2}.json`), 'utf8'))
  assert.deepEqual(v2, JSON.parse(JSON.stringify(buildBrowserAnswerScriptV2()))); assert.deepEqual(validateEngineScript(v2), { ok: true, errors: [] })
  assert.deepEqual(v2.conversations.map(c => c.id), ['billing-date', 'billing-date-no-amount', 'delivery-status', 'handed-over', 'statement-downloaded', 'captcha-handover', 'toggle-handover'])
  assert.deepEqual(v2.conversations.slice(0, 4), JSON.parse(fs.readFileSync(path.join(root, `${BROWSER_ANSWER_SET}.json`), 'utf8')).conversations, 'v1\'s conversations are carried unchanged')
  const w = world(t, GOOD_V2)
  const result = await runCheck(w.options, asScripts(v2), w.deps)
  assert.equal(result.records.length, 7)
  const notes = []
  for (const [i, rec] of result.records.entries()) {
    assert.equal(rec.aborted, null, rec.abortDetail)
    const turn = rec.turns[0], hook = turn.browserAnswer
    assert.equal(hook.delivered, true, JSON.stringify(hook))
    const wireNote = w.wires()[i].find(line => line.params?.additionalContext?.[NOTE_KEY])?.params.additionalContext[NOTE_KEY]
    assert.equal(wireNote?.value, hook.note, `conversation ${i + 1}: what reached the engine is the built note`)
    notes.push(JSON.parse(hook.note)[NOTE_KEY])
    assert.deepEqual(turn.expectations.filter(c => !c.ok).map(c => c.check), [], rec.id)
  }
  assert.deepEqual([notes[4].status, notes[4].page, notes[4].actions.navigate], ['done', ['명세서 다운로드 완료', '2026년 11월 카드 이용대금 명세서를 내려받았습니다.'], 2])
  assert.deepEqual([notes[5].status, notes[5].code, notes[5].candidates], ['cannot_proceed', 'bot_check', undefined])
  assert.deepEqual([notes[6].status, notes[6].code, notes[6].candidates], ['cannot_proceed', 'human_step', ['마케팅 정보 알림']])
  // bad replies
  const BAD = { ...GOOD_V2,
    '이번 달 카드 명세서 내려받아줘': '명세서를 내려받았습니다. 이번 달 청구 금액은 1,234,000원입니다.',
    '홍길동 고객 주문 배송 상태 확인해줘': '현재 배송 중입니다. 도착 예정은 곧입니다.',
    '마케팅 알림 꺼줘': '마케팅 알림을 껐습니다. 더 이상 알림이 오지 않습니다.' }
  const bad = world(t, BAD)
  const badResult = await runCheck(bad.options, asScripts(v2), bad.deps)
  const failedOf = rec => rec.turns[0].expectations.filter(c => !c.ok).map(c => c.check)
  assert.ok(failedOf(badResult.records[4]).includes('browserAnswer.no_invented_amounts'), JSON.stringify(failedOf(badResult.records[4])))
  assert.ok(failedOf(badResult.records[5]).some(n => /answerExcludes/.test(n)) && failedOf(badResult.records[5]).includes('browserAnswer.names_any_of'), JSON.stringify(failedOf(badResult.records[5])))
  assert.ok(failedOf(badResult.records[6]).some(n => /answerExcludes/.test(n)), JSON.stringify(failedOf(badResult.records[6])))
  for (const i of [0, 1, 2, 3]) assert.deepEqual(failedOf(badResult.records[i]), [], `conversation ${i + 1} kept its good reply`)
})
