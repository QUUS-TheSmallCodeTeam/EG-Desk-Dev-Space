import assert from 'node:assert/strict'
import { test } from 'node:test'
import { PROCEDURE_FLAG, bindProcedureParams, confirmKindOf, draftFromJournal, normalizeProcedure, procedureFlagOn, procedureSummary } from './egdesk-browser-procedure.mjs'

const NOW = 1_700_000_000_000
const field = (label, text, extra = {}) => ({ at: NOW, tool: 'egdesk_browser_fill', expectedTarget: { ref: 'e1', role: 'textbox', label, href: '', value: '', tag: 'input' },
  text, postcondition: { kind: 'target-value', value: text }, pageUrl: 'http://127.0.0.1:8770/form', pageTitle: '배송 정보', displaySafe: true, ...extra })
const press = (label, extra = {}) => ({ at: NOW, tool: 'egdesk_browser_click', expectedTarget: { ref: 'e9', role: 'button', label, href: '', value: '', tag: 'button' },
  postcondition: { kind: 'visible-text', value: 'x' }, pageUrl: 'http://127.0.0.1:8770/form', ...extra })

test('flag helper reads only "on"', () => {
  assert.equal(PROCEDURE_FLAG, 'EGDESK_BROWSER_PROCEDURES')
  assert.equal(procedureFlagOn({ EGDESK_BROWSER_PROCEDURES: 'on' }), true)
  for (const v of [undefined, '', '1', 'true', 'off']) assert.equal(procedureFlagOn({ EGDESK_BROWSER_PROCEDURES: v }), false)
})

test('confirmKindOf: POST submit, vocabulary, and nothing for plain buttons', () => {
  assert.equal(confirmKindOf({ label: '보내기' }, { type: 'submit', formMethod: 'post' }), 'submit')
  assert.equal(confirmKindOf({ label: '보내기' }, { type: 'submit', formMethod: 'get' }), null)
  assert.equal(confirmKindOf({ label: '검색' }, null), null)
  assert.equal(confirmKindOf({ label: '결제하기' }, null), 'payment')
  assert.equal(confirmKindOf({ label: 'Place order' }, null), 'payment')
  assert.equal(confirmKindOf({ label: '계정 삭제' }, null), 'delete')
  assert.equal(confirmKindOf({ label: 'Unsubscribe' }, null), 'delete')
  assert.equal(confirmKindOf({ label: '제출' }, null), 'submit')
  assert.equal(confirmKindOf({ label: '다음' }, { regionLabel: '주문 확인' }), 'payment')
  assert.equal(confirmKindOf({ label: 'Next' }, { regionLabel: 'Details' }), null)
})

test('draft: params from labels, last value wins, duplicates numbered, sensitive never stored', () => {
  const draft = draftFromJournal([
    field('받는 분', '김하늘'), field('받는 분', '이하늘'), field('주소', '서울'), field('주소', '부산', { expectedTarget: { ref: 'e2', role: 'textbox', label: '주소', tag: 'input', href: '', value: '' }, displaySafe: true, text: 'x' }),
    field('비밀번호', 'hunter2', { displaySafe: false }), field('Memo', 'a', { expectedTarget: { ref: 'e5', role: 'textbox', label: '주소 ', tag: 'textarea', href: '', value: '' } }),
    field('OTP', '123456', { displaySafe: true }),
    press('다음', { afterUrl: 'http://127.0.0.1:8770/step2' }), press('보내기', { facts: { type: 'submit', formMethod: 'post' } }),
  ], { now: NOW })
  assert.equal(draft.start.url, 'http://127.0.0.1:8770/form')
  assert.equal(draft.start.host, '127.0.0.1:8770')
  assert.equal(draft.name, '배송 정보 받는 분')
  const byName = Object.fromEntries(draft.params.map(p => [p.name, p]))
  assert.equal(byName['받는 분'].default, '이하늘')
  assert.equal(byName['주소'].default, 'x')
  assert.ok(byName['주소 2'], 'same label, different tag gets a numbered name')
  assert.deepEqual(byName['비밀번호'], { name: '비밀번호', default: null, sensitive: true })
  assert.equal(byName.OTP.sensitive, true, 'label vocabulary applies even if the actor said safe')
  const pw = draft.steps.find(s => s.target.label === '비밀번호')
  assert.deepEqual([pw.person, pw.value], [true, { param: '비밀번호' }])
  assert.ok(!JSON.stringify(draft).includes('hunter2') && !JSON.stringify(draft).includes('123456'))
  const next = draft.steps.find(s => s.target?.label === '다음')
  assert.deepEqual(next.expect, { kind: 'url', value: 'http://127.0.0.1:8770/step2' })
  assert.equal(next.confirm, undefined)
  const send = draft.steps.find(s => s.target?.label === '보내기')
  assert.deepEqual([send.expect, send.confirm], [{ kind: 'changed' }, 'submit'])
  assert.deepEqual(draft.steps.find(s => s.target?.label === '받는 분').expect, { kind: 'target-value' })
  assert.equal(normalizeProcedure(draft, { now: NOW }).ok, true)
})

test('draft: failed acts dropped, missing displaySafe fails closed, navigate/scroll/history/press steps', () => {
  const draft = draftFromJournal([
    { at: 1, tool: 'egdesk_browser_navigate', url: 'http://a.test/x', expectedTarget: null, pageUrl: 'http://a.test/', postcondition: { kind: 'url', value: 'http://a.test/x' } },
    field('이름', 'zz', { ok: false }), field('메모', 'hi', { displaySafe: undefined }),
    { at: 2, tool: 'egdesk_browser_scroll', direction: 'down', amount: 'half', pageUrl: 'http://a.test/x' },
    { at: 3, tool: 'egdesk_browser_history', action: 'back', pageUrl: 'http://a.test/x' },
    { at: 4, tool: 'egdesk_browser_press', key: 'Enter', expectedTarget: { ref: 'e1', role: 'textbox', label: '검색', tag: 'input', href: '', value: '' }, postcondition: { kind: 'url', value: 'http://a.test/s' }, pageUrl: 'http://a.test/x' },
    { at: 5, tool: 'egdesk_browser_observe' },
  ], { now: NOW, name: '내 절차' })
  assert.equal(draft.name, '내 절차')
  assert.deepEqual(draft.steps.map(s => s.op), ['navigate', 'fill', 'scroll', 'history', 'press'])
  assert.deepEqual(draft.params, [{ name: '메모', default: null, sensitive: true }])
  assert.deepEqual(draft.steps[4].expect, { kind: 'url', value: 'http://a.test/s' })
  assert.equal(draft.start.url, 'http://a.test/')
  assert.equal(normalizeProcedure(draft, { now: NOW }).ok, true)
})

test('draft: empty journal gives a draft that does not validate; long names are trimmed', () => {
  const empty = draftFromJournal([], { now: NOW })
  assert.equal(normalizeProcedure(empty, { now: NOW }).ok, false)
  const long = draftFromJournal([field('x'.repeat(200), 'v', { pageTitle: 't'.repeat(200) })], { now: NOW })
  assert.ok(long.name.length <= 80)
  assert.ok(long.params[0].name.length <= 60)
})

const base = () => ({ id: 'proc-0123456789ab', name: 'n', start: { url: 'https://a.test/p', host: 'ignored' }, params: [{ name: 'A', default: 'x', sensitive: false }, { name: 'P', default: 'secret', sensitive: true }],
  steps: [{ id: 's1', op: 'fill', target: { label: 'A' }, value: { param: 'A' } }, { id: 's2', op: 'fill', target: { label: 'P' }, value: { param: 'P' } }, { id: 's3', op: 'click', target: { label: 'Go' }, confirm: 'submit' }], junk: 1 })

test('normalizeProcedure: shape, derived host, stamps, sensitive scrubbing', () => {
  const r = normalizeProcedure(base(), { now: NOW })
  assert.equal(r.ok, true)
  const p = r.procedure
  assert.deepEqual([p.version, p.start.host, p.createdAt, p.updatedAt, 'junk' in p], [1, 'a.test', NOW, NOW, false])
  assert.deepEqual(p.params[1], { name: 'P', default: null, sensitive: true })
  assert.deepEqual([p.steps[1].person, p.steps[1].value], [true, { param: 'P' }])
  assert.equal(procedureSummary(p).stepCount, 3)
  assert.deepEqual(procedureSummary(p), { id: 'proc-0123456789ab', name: 'n', host: 'a.test', stepCount: 3, paramNames: ['A', 'P'], updatedAt: NOW })
})

test('normalizeProcedure: errors', () => {
  const bad = fn => { const b = base(); fn(b); return normalizeProcedure(b, { now: NOW }) }
  for (const fn of [b => { b.id = 'x' }, b => { b.name = '' }, b => { b.name = 'n'.repeat(81) }, b => { b.start.url = 'ftp://a' }, b => { b.steps = [] },
    b => { b.steps[0].id = 's2' }, b => { b.steps[0].op = 'zap' }, b => { delete b.steps[0].target }, b => { b.steps[0].value = { param: 'Z' } },
    b => { b.steps[0].value = { text: 'a' }; b.steps[0].target.label = '비밀번호' }, b => { b.steps[0].person = true; b.steps[0].value = { text: 'a' } },
    b => { b.params.push({ name: 'A', default: null, sensitive: false }) }, b => { b.steps[2].confirm = 'boom' }, b => { b.steps[2].expect = { kind: 'zz' } },
    b => { b.steps.push({ id: 's4', op: 'scroll', direction: 'left' }) }, b => { b.steps.push({ id: 's4', op: 'navigate', url: 'javascript:1' }) },
    b => { b.steps.push({ id: 's4', op: 'history', action: 'go' }) }, b => { b.steps.push({ id: 's4', op: 'press', target: { label: 'x' } }) },
    b => { b.steps = Array.from({ length: 101 }, (_, i) => ({ id: `s${i}`, op: 'history', action: 'back' })) }]) {
    const r = bad(fn)
    assert.equal(r.ok, false); assert.ok(r.errors.length > 0)
  }
  assert.equal(normalizeProcedure(null).ok, false)
  const huge = base(); huge.params[0].default = 'z'.repeat(1024 * 1024)
  assert.deepEqual(normalizeProcedure(huge, { now: NOW }).errors, ['procedure is larger than 1 MB'])
  const ok = base(); ok.params[0].default = 'z'.repeat(5000)
  assert.equal(normalizeProcedure(ok, { now: NOW }).ok, true)
})

test('bindProcedureParams: values, defaults, missing, person steps', () => {
  const p = normalizeProcedure(base(), { now: NOW }).procedure
  let b = bindProcedureParams(p, {})
  assert.deepEqual([b.missing, b.personSteps, b.steps[0].value, b.steps[1].value], [[], ['s2'], { text: 'x' }, { param: 'P' }])
  b = bindProcedureParams(p, { A: 'y', P: 'ignored' })
  assert.deepEqual([b.steps[0].value, b.steps[1].value], [{ text: 'y' }, { param: 'P' }])
  const cleared = structuredClone(p); cleared.params[0].default = null
  b = bindProcedureParams(cleared, {})
  assert.deepEqual([b.missing, b.steps[0].value], [['A'], { param: 'A' }])
  assert.deepEqual(bindProcedureParams(cleared, { A: '' }).missing, [])
  assert.deepEqual(p.steps[0].value, { param: 'A' }, 'the procedure is not changed')
})
