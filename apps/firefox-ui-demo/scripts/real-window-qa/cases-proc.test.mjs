import test from 'node:test'; import assert from 'node:assert/strict'; import vm from 'node:vm'; import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path'
import * as P from './cases-proc.mjs'
import { rewriteFixtureUrls } from './fixture-server.mjs'
const { CASES, PHASE_KINDS } = P
const decode = u => decodeURIComponent(u.slice(u.indexOf(',') + 1))
test('P1..P7 exist with the contract shape', () => {
  assert.deepEqual(Object.keys(CASES), ['P1', 'P2', 'P3', 'P4', 'P5', 'P6', 'P7'])
  for (const [id, c] of Object.entries(CASES)) {
    for (const k of ['name', 'card', 'url', 'expected']) assert.equal(typeof c[k], 'string', `${id}.${k}`)
    assert.match(c.card, /^egd-browser-card-\d+$/); assert.ok(Array.isArray(c.phases) && c.phases.length, id)
    for (const ph of c.phases) assert.ok(PHASE_KINDS.includes(ph.do), `${id} phase ${ph.do}`)
    assert.ok(c.phases.some(p => p.do === 'eval' || p.do === 'proc'), `${id} has checks`)
    if (c.phases.some(p => p.do === 'seed')) assert.ok(c.seed, `${id} seed`)
    if (c.phases.some(p => p.do === 'goto' && p.to === 'then')) assert.ok(c.then, id)
    for (const ph of c.phases) { if (ph.answerRe) new RegExp(ph.answerRe); if (ph.answerNotRe) new RegExp(ph.answerNotRe); if (ph.do === 'chat') assert.ok(ph.msg, id) }
    if (c.anyOf) for (const g of c.anyOf) assert.ok(c.phases.some(p => p.id === g), `${id} anyOf ${g}`)
  }
})
test('P1 chat then capture then save; P2 has put+get; P5 has two chats; P6/P7 stop', () => {
  const k = id => CASES[id].phases.map(p => p.do).join(',')
  assert.match(k('P1'), /chat.*capture.*save/); assert.match(k('P2'), /put,get/); assert.equal(CASES.P5.phases.filter(p => p.do === 'chat').length, 2); assert.ok(CASES.P5.phases[CASES.P5.phases.findIndex(p => p.do === 'chat') + 2].msg.includes('응 제출해'))
  assert.ok(CASES.P4.url === P.CASES.P4.url && CASES.P4.url.includes('data:'))
})
test('fixtures: labels, POST submit, password, variant', () => {
  const d = P.deliveryHtml(); for (const l of ['받는 분', '연락처', '우편번호', '주소', '상세 주소', '배송 요청사항']) assert.ok(d.includes('>' + l + '</label>'), l)
  assert.equal((d.match(/<input /g) || []).length, 6)
  const v = P.deliveryVariantHtml(); assert.ok(v.includes('>수령인</label>') && !v.includes('받는 분'))
  const s = P.deliverySubmitHtml(); assert.ok(/<form[^>]*method="post"/.test(s) && /type="submit"[^>]*>제출</.test(s) && s.includes('preventDefault'))
  const l = P.deliveryLoginHtml(); assert.ok(/type="password"/.test(l) && l.includes('>비밀번호</label>') && /method="post"/.test(l))
  for (const html of [d, v, s, l]) { assert.ok(html.includes('<meta charset="utf-8">')); for (const m of html.matchAll(/<script>([^]*?)<\/script>/g)) assert.doesNotThrow(() => new vm.Script(m[1])) }
})
test('every case url is a valid ascii data: url (or the change fixture) and rewrites to http', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'procfx-'))
  for (const [id, c] of Object.entries(CASES)) {
    for (const u of [c.url, c.then].filter(Boolean)) { assert.match(u, /^data:text\/html;charset=utf-8,/); assert.ok(/^[\x21-\x7e]+$/.test(u), id) }
    const { c: r, files } = rewriteFixtureUrls(c, 'proc-' + id, { dir, port: 8770 }); assert.match(r.url, /^http:\/\/127\.0\.0\.1:8770\/proc-P\d\.html$/); assert.ok(files.length >= 1)
    if (c.then) { assert.match(r.then, /^http:\/\/127\.0\.0\.1:8770\//); assert.notEqual(r.then, r.url) }
    assert.ok(fs.readFileSync(path.join(dir, files[0]), 'utf8').includes('<meta charset="utf-8">'))
  }
})
test('check expressions parse; proc checks hold on a hand-built P1 draft', () => {
  for (const [id, c] of Object.entries(CASES)) for (const ph of c.phases) for (const e of ph.checks || []) assert.doesNotThrow(() => new vm.Script(`(${e})`), `${id}: ${e}`)
  const fills = Object.entries(P.DEFAULTS).map(([n]) => n); assert.equal(fills.length, 6)
  const labels = ['받는 분', '연락처', '우편번호', '주소', '상세 주소', '배송 요청사항'], vals = Object.values(P.DEFAULTS)
  const draft = { ...P.mkProc('x', labels.map((l, i) => [l, vals[i]])), start: { url: 'http://127.0.0.1:8770/proc-P1.html', host: '127.0.0.1' } }
  const ctx = { url: draft.start.url }
  for (const e of CASES.P1.phases.find(p => p.do === 'proc' && p.on === 'draft').checks) assert.equal(P.evalProcCheck(e, draft, ctx), true, e)
})
test('seed procedures: P5 confirm, P6 sensitive, applyEdits (P2) and template helpers', () => {
  const p5 = P.resolveSeed(CASES.P5.seed, 'http://h/x.html', 'n'); assert.equal(p5.start.url, 'http://h/x.html'); assert.equal(p5.steps.at(-1).confirm, 'submit'); assert.equal(p5.steps.at(-1).op, 'click')
  const p6 = CASES.P6.seed; assert.equal(p6.steps[1].person, true); assert.deepEqual(p6.params[1], { name: '비밀번호', default: null, sensitive: true }); assert.ok(!JSON.stringify(p6).includes('QA-SECRET'))
  const p2 = P.applyEdits(P.resolveSeed(CASES.P2.seed, 'u'), CASES.P2.phases.find(p => p.do === 'put').edits)
  assert.equal(p2.steps.length, 5); assert.equal(p2.params.length, 5); assert.equal(p2.params[0].default, '이하늘'); assert.deepEqual(p2.steps.map(s => s.id), ['s1', 's2', 's3', 's4', 's5'])
  assert.equal(P.fillTemplate('‘{{NAME}}’ 절차', { NAME: 'a' }), '‘a’ 절차'); assert.equal(P.fillTemplate('{{X}}', {}), '{{X}}')
  assert.ok(CASES.P3.phases.find(p => p.do === 'chat').msg.includes('받는 분: 이하늘'))
})
test('capability gate and thread id helpers', () => {
  assert.equal(P.hasProcedureCapability({ capabilities: { browserProcedures: true } }), true); assert.equal(P.hasProcedureCapability({ capabilities: {} }), false); assert.equal(P.hasProcedureCapability(null), false); assert.match(P.SKIP_MESSAGE, /^SKIP/)
  assert.equal(P.pickThreadId({ chat: { runs: [{ clientThreadId: 'a' }, { clientThreadId: 'b' }] } }, null), 'b')
  assert.equal(P.pickThreadId({}, { threads: [{ clientThreadId: 'o', updatedAt: 1 }, { clientThreadId: 'n', updatedAt: 9 }] }), 'n'); assert.equal(P.pickThreadId({}, null), null)
  assert.equal(P.evalProcCheck('p.x === 1', { x: 1 }), true); assert.match(P.evalProcCheck('p.x.y.z', {}), /^ERR/)
})
test('no real-looking personal data', () => { const t = JSON.stringify(CASES); assert.ok(!/@[a-z0-9-]+\.(com|co\.kr|net)/i.test(t)); assert.ok(!/010-(?!0000-1234)\d{4}-\d{4}/.test(t)); assert.ok(!/\d{6}-\d{7}/.test(t)) })
