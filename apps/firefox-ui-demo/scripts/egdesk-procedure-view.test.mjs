import test from 'node:test'
import assert from 'node:assert/strict'
import * as V from '../overlay/resources/EGDeskProcedureView.sys.mjs'

const proc = () => ({
  id: 'proc-abcdef012345', version: 1, name: '택배 보내기', createdAt: 1, updatedAt: 2,
  start: { url: 'https://shop.example/send', host: 'shop.example' },
  params: [
    { name: '받는 분', default: '이하늘', sensitive: false },
    { name: '주소', default: '서울', sensitive: false },
    { name: '비밀번호', default: null, sensitive: true },
  ],
  steps: [
    { id: 's1', op: 'fill', target: { label: '받는 분' }, value: { param: '받는 분' } },
    { id: 's2', op: 'fill', target: { label: '주소' }, value: { param: '주소' } },
    { id: 's3', op: 'fill', target: { label: '비밀번호' }, value: { param: '비밀번호' }, person: true },
    { id: 's4', op: 'click', target: { label: '보내기' }, confirm: 'submit' },
  ],
})

test('op labels', () => {
  assert.deepEqual(['fill', 'select', 'click', 'navigate', 'press', 'scroll', 'history'].map(V.opLabel),
    ['입력', '선택', '누름', '이동', '키', '스크롤', '뒤로'])
  assert.equal(V.opLabel({ op: 'history', action: 'reload' }), '새로고침')
  assert.equal(V.opLabel('zzz'), 'zzz')
})

test('list rows: newest first, exact fields, missing host', () => {
  const now = new Date(2026, 10, 29, 12, 0).getTime()
  const rows = V.procedureListRows([
    { id: 'a', name: 'A', host: 'x.com', stepCount: 3, paramNames: ['q'], updatedAt: new Date(2026, 10, 1, 9, 5).getTime() },
    { id: 'b', name: 'B\n', host: '', stepCount: 1, paramNames: [], updatedAt: new Date(2026, 10, 29, 8, 7).getTime() },
    null, { name: 'no id' },
  ], { now })
  assert.deepEqual(rows.map((r) => r.id), ['b', 'a'])
  assert.equal(rows[0].name, 'B'); assert.equal(rows[0].site, V.COPY.siteUnknown)
  assert.equal(rows[0].updatedText, '오늘 08:07'); assert.equal(rows[1].updatedText, '11월 1일 09:05')
  assert.equal(rows[1].stepsText, '3단계'); assert.deepEqual(rows[1].actions, ['실행', '편집', '삭제'])
  assert.deepEqual(V.procedureListRows(undefined), [])
})

test('editor model: rows, fields, sensitive has no field, confirm, moves', () => {
  const m = V.procedureEditorModel(proc())
  assert.equal(m.valid, true); assert.equal(m.startUrl, 'https://shop.example/send')
  assert.equal(m.steps.length, 4)
  assert.deepEqual(m.steps[0].field, { param: '받는 분', sensitive: false, editable: true, value: '이하늘', placeholder: '' })
  assert.equal(m.steps[2].field.editable, false); assert.equal(m.steps[2].field.value, null)
  assert.equal(m.steps[2].field.placeholder, '실행 중 직접 입력'); assert.equal(m.steps[2].person, true)
  assert.equal(m.steps[2].canConfirm, false)
  assert.equal(m.steps[3].confirmOn, true); assert.equal(m.steps[3].opLabel, '누름'); assert.equal(m.steps[3].targetLabel, '보내기')
  assert.deepEqual([m.steps[0].canUp, m.steps[0].canDown, m.steps[3].canUp, m.steps[3].canDown], [false, true, true, false])
})

test('edit ops return a new procedure and leave the input alone', () => {
  const p = proc(); const snap = JSON.stringify(p)
  const r = V.renameProcedure(p, '새 이름'); assert.equal(r.procedure.name, '새 이름'); assert.deepEqual(r.messages, [])
  assert.equal(JSON.stringify(p), snap); assert.notEqual(r.procedure, p)
  assert.equal(V.setParamDefault(p, '주소', '부산').procedure.params[1].default, '부산')
  const s = V.setParamDefault(p, '비밀번호', 'hunter2')
  assert.equal(s.procedure.params[2].default, null); assert.deepEqual(s.messages, [V.COPY.msgSensitiveDefault])
  assert.equal(V.toggleStepConfirm(p, 's4').procedure.steps[3].confirm, undefined)
  assert.equal(V.toggleStepConfirm(p, 's1').procedure.steps[0].confirm, 'submit')
  assert.equal(V.toggleStepConfirm(p, 's1', 'payment').procedure.steps[0].confirm, 'payment')
  assert.equal(V.toggleStepConfirm(p, 's3').procedure.steps[2].confirm, undefined, 'person step takes no confirm')
  assert.equal(JSON.stringify(p), snap)
})

test('rename validation: empty and over 80 chars', () => {
  assert.deepEqual(V.renameProcedure(proc(), '  ').messages, [V.COPY.msgNameEmpty])
  assert.deepEqual(V.renameProcedure(proc(), 'a'.repeat(81)).messages, [V.COPY.msgNameLong(80)])
  assert.deepEqual(V.renameProcedure(proc(), 'a'.repeat(80)).messages, [])
})

test('delete step drops an unused param; deleting all steps says so', () => {
  const r = V.deleteStep(proc(), 's2')
  assert.deepEqual(r.procedure.steps.map((s) => s.id), ['s1', 's3', 's4'])
  assert.deepEqual(r.procedure.params.map((p) => p.name), ['받는 분', '비밀번호'])
  assert.deepEqual(r.messages, [V.COPY.msgParamDropped('주소')])
  assert.equal(V.deleteStep(proc(), 'nope').procedure.steps.length, 4)
  let q = proc(); for (const id of ['s1', 's2', 's3', 's4']) q = V.deleteStep(q, id).procedure
  assert.deepEqual(V.deleteStep(q, 'x').messages, [V.COPY.msgNoSteps])
})

test('move up and down; ends are no-ops', () => {
  const up = V.moveStepUp(proc(), 's2').procedure; assert.deepEqual(up.steps.map((s) => s.id), ['s2', 's1', 's3', 's4'])
  const down = V.moveStepDown(proc(), 's1').procedure; assert.deepEqual(down.steps.map((s) => s.id), ['s2', 's1', 's3', 's4'])
  assert.deepEqual(V.moveStepUp(proc(), 's1').procedure.steps.map((s) => s.id), ['s1', 's2', 's3', 's4'])
  assert.deepEqual(V.moveStepDown(proc(), 's4').procedure.steps.map((s) => s.id), ['s1', 's2', 's3', 's4'])
})

test('run form and message: defaults, overrides, sensitive never in text', () => {
  const form = V.procedureRunForm(proc())
  assert.deepEqual(form.fields.map((f) => [f.name, f.value, f.sensitive]), [['받는 분', '이하늘', false], ['주소', '서울', false], ['비밀번호', null, true]])
  assert.equal(form.fields[2].placeholder, '실행 중 직접 입력')
  assert.equal(V.procedureRunMessage(proc()), '‘택배 보내기’ 절차를 실행해줘. 받는 분: 이하늘, 주소: 서울')
  assert.equal(V.procedureRunMessage(proc(), { '받는 분': '김철수', 비밀번호: 'hunter2' }), '‘택배 보내기’ 절차를 실행해줘. 받는 분: 김철수, 주소: 서울')
  assert.ok(!V.procedureRunMessage(proc(), { 비밀번호: 'hunter2' }).includes('hunter2'))
  // a param that a person step uses is sensitive even if the param flag is missing
  const p = proc(); p.params[2].sensitive = false; p.params[2].default = 'leak'
  assert.ok(!V.procedureRunMessage(p).includes('leak'))
  const none = proc(); none.params = []; none.steps = [none.steps[3]]
  assert.equal(V.procedureRunMessage(none), '‘택배 보내기’ 절차를 실행해줘.'); assert.equal(V.procedureRunForm(none).empty, true)
  const multi = proc(); multi.params[0].default = '이\n하늘'
  assert.equal(V.procedureRunMessage(multi), '‘택배 보내기’ 절차를 실행해줘. 받는 분: 이 하늘, 주소: 서울')
})

test('save offer: needs a finished block with an ok act and a card', () => {
  const step = (o) => ({ clientThreadId: 't1', cardId: 'c1', op: 'fill', ok: true, ...o })
  assert.deepEqual(V.procedureSaveOffer({ steps: [step({}), step({ op: 'observe' })] }), { clientThreadId: 't1', cardId: 'c1' })
  assert.equal(V.procedureSaveOffer({ steps: [step({})] }, { busy: true }), null)
  assert.equal(V.procedureSaveOffer({ steps: [step({ op: 'observe' })] }), null)
  assert.equal(V.procedureSaveOffer({ steps: [step({ ok: false })] }), null)
  assert.equal(V.procedureSaveOffer({ steps: [step({ cardId: '' })] }), null)
  assert.equal(V.procedureSaveOffer(null), null)
})
