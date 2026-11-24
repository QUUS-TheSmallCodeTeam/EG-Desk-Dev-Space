// L4 cycle 35: the fill is asked for the MINIMUM the render needs (Main's check-9: 20-30 s per card on the real engine, output + reasoning dominate).
//  - no fallback sentence is asked for (the validator uses the step's text),
//  - in a SEQUENCE line the label and the text may be null: code copies the cited material's date / its sentences that fit the line, exactly,
//  - the same replies the real engine wrote in check-9 (kept here as fixtures), compacted by these rules, give the SAME board lines with fewer characters.
import assert from 'node:assert/strict'
import test from 'node:test'
import { buildGuide, copyField, enumerateSkeleton, fillRequest, normalizeMaterials, sentencesThatFit, validateFill } from './egdesk-briefing-skeleton.mjs'
import { fillPrompt } from './egdesk-briefing-engine.mjs'
import { fillOutputSchema, schemaProblems, stripNulls, violation } from './egdesk-briefing-output-schema.mjs'
import { folderMaterials } from './egdesk-real-engine-briefing-hook.mjs'
import { buildBoardScript } from './egdesk-briefing-real-engine-script.mjs'

const rows = folderMaterials(buildBoardScript().conversations[0].folder)
const scene = enumerateSkeleton({ materials: rows, candidates: [] })
const parts = scene.parts, item = (part, n) => ({ id: part.alias, trait: part.trait, materials: part.materials, component: part.options[0].component, reuse: [], creates: `N${n}`, emphasis: 'spotlight', tried: [part.options[0].component] })
const GUIDE = buildGuide(parts.map((p, i) => item(p, i + 1)), scene)
const MATS = scene.materials
// what the real engine wrote in check-9 (schema-on conversation): the whole fill timed out, then one reply per card
const REAL_P1 = { title: '개발 진행 현황과 남은 일', items: { P1: { text: '로그인 화면·결제 모듈 병합 결과, 알림 설정 화면 시안 확정, 검색 화면 착수와 남은 일을 날짜순으로 보여준다.',
  fallback: '2026-11-20 로그인 화면 병합 완료(커밋 a1b2c3d, 테스트 120건 통과), 2026-11-22 결제 모듈 병합 완료(커밋 e4f5a6b, 테스트 98건 통과) 및 알림 설정 화면 시안만 확정, 2026-11-24 검색 화면 착수이며, 남은 일은 알림 설정 구현, 검색 성능 점검, 배포 체크리스트 작성이다.',
  slots: { title: '진행 내역과 남은 일', lines: [{ label: '2026-11-20', text: '로그인 화면 병합 완료 (커밋 a1b2c3d, 테스트 120건 통과).', from: 'M1' }, { label: '2026-11-22', text: '결제 모듈 병합 완료 (커밋 e4f5a6b, 테스트 98건 통과). 알림 설정 화면은 시안만 확정.', from: 'M2' },
    { label: '2026-11-24', text: '검색 화면 착수. 남은 일: 알림 설정 구현, 검색 성능 점검, 배포 체크리스트 작성.', from: 'M3' }] } } }, unfillable: [] }
const REAL_P2 = { title: '남은 일', items: { P2: { text: '알림 설정 구현, 검색 성능 점검, 배포 체크리스트 작성을 남은 일로 보여준다.', fallback: '남은 일은 알림 설정 구현, 검색 성능 점검, 배포 체크리스트 작성이다.',
  slots: { title: '남은 일', lines: [{ label: '알림 설정', text: '알림 설정 구현', from: 'M3' }, { label: '검색 성능', text: '검색 성능 점검', from: 'M3' }, { label: '배포 체크리스트', text: '배포 체크리스트 작성', from: 'M3' }] } } }, unfillable: [] }
/** The real reply as a model following the compact request writes it: no fallback; a sequence line whose label / text is exactly what the code would copy is null. */
function compacted(reply, request) {
  const byAlias = new Map(MATS.map(m => [m.alias, m]))
  return { ...reply, items: Object.fromEntries(Object.entries(reply.items).map(([id, { fallback: _f, ...it }]) => {
    const guideItem = request.guide.items.find(i => i.id === id)
    const slots = Object.fromEntries(Object.entries(it.slots).map(([name, v]) => [name, !Array.isArray(v) ? v : v.map(row => {
      const m = byAlias.get(row.from)
      return { ...row, ...(copyField(guideItem, { name: 'label' }) && row.label === m?.at ? { label: null } : {}), ...(copyField(guideItem, { name: 'text' }) && row.text === sentencesThatFit(m?.text, 90) ? { text: null } : {}) }
    })]))
    return [id, { ...it, slots }]
  })) }
}

test('the design of the v2 notes: a sequence card and an open-items card; only the sequence rows are copy fields', () => {
  assert.deepEqual(GUIDE.items.map(i => [i.id, i.shows, i.component]), [['P1', 'sequence', 'result_lines'], ['P2', 'open_items', 'result_lines']])
  const request = fillRequest(GUIDE, MATS), [p1, p2] = request.guide.items
  assert.deepEqual(p1.step.map(s => s.name), ['text']); assert.deepEqual(p2.step.map(s => s.name), ['text'])
  assert.deepEqual(p1.slots.find(s => s.name === 'lines').of.map(f => [f.name, f.copy === true]), [['label', true], ['text', true], ['from', false]])
  assert.deepEqual(p2.slots.find(s => s.name === 'lines').of.map(f => [f.name, f.copy === true]), [['label', false], ['text', false], ['from', false]], 'an open-items line is something the model must write')
  assert.deepEqual(GUIDE.items[0].step.map(s => s.name), ['text', 'fallback'], 'the decided guide itself is unchanged: the compaction is only in what the model is asked')
  assert.equal(p1.slots.find(s => s.name === 'lines').of.every(f => f.copy === undefined || copyField(GUIDE.items[0], f)), true)
})

test('a sequence line left null is the cited material\'s own date and sentences, exactly; what does not fit the line is an empty slot, not a cut id', () => {
  const full = compacted(REAL_P1, fillRequest(GUIDE, MATS))
  const read = validateFill(GUIDE, stripNulls('briefing_fill', full), { materials: MATS, only: new Set(['P1']), needTitle: true })
  assert.equal(read.ok, true); assert.deepEqual(read.issues, [])
  assert.deepEqual(read.items.P1.slots.lines, REAL_P1.items.P1.slots.lines, 'copying reproduces exactly the lines the real model had typed out')
  assert.deepEqual(read.items.P1.fallback, REAL_P1.items.P1.text, 'no fallback in the reply: the step text stands in')
  // a material whose first sentence is longer than the line: nothing is copied (never a half id)
  const long = MATS.map(m => (m.alias === 'M1' ? { ...m, text: `${'가'.repeat(95)}. 다음 문장.` } : m))
  const over = validateFill(GUIDE, stripNulls('briefing_fill', full), { materials: long, only: new Set(['P1']), needTitle: true })
  assert.deepEqual(over.issues, [{ item: 'P1', slot: 'lines', kind: 'mismatch' }], 'the line the code cannot copy is an issue of the list slot (a row of several that does not fit), which the flow rewrites')
  // the sentences that fit are whole sentences
  assert.equal(sentencesThatFit('하나입니다. 둘입니다. 셋입니다.', 11), '하나입니다.'); assert.equal(sentencesThatFit('하나입니다. 둘입니다. 셋입니다.', 12), '하나입니다. 둘입니다.'); assert.equal(sentencesThatFit('하나입니다. 둘입니다.', 40), '하나입니다. 둘입니다.'); assert.equal(sentencesThatFit('가'.repeat(100), 90), '')
  // without the materials the validator does not guess (a null stays an empty line)
  assert.deepEqual(validateFill(GUIDE, stripNulls('briefing_fill', full), { only: new Set(['P1']), needTitle: true }).issues, [{ item: 'P1', slot: 'lines', kind: 'mismatch' }])
  // the model may still write its own line (shorter or different); and an open-items line is never copied
  const own = structuredClone(full); own.items.P1.slots.lines[0].text = '로그인 화면 병합'; own.items.P1.slots.lines[0].label = '11/20'
  assert.equal(validateFill(GUIDE, stripNulls('briefing_fill', own), { materials: MATS, only: new Set(['P1']), needTitle: true }).items.P1.slots.lines[0].text, '로그인 화면 병합')
  const openNull = compacted(REAL_P2, fillRequest(GUIDE, MATS)); openNull.items.P2.slots.lines[0].text = null
  assert.deepEqual(validateFill(GUIDE, stripNulls('briefing_fill', openNull), { materials: MATS, only: new Set(['P2']), needTitle: true }).issues, [{ item: 'P2', slot: 'lines', kind: 'mismatch' }])
})

test('the fallback: absent in the reply -> the step text; a blank one is still empty; one the model wrote is kept (an older request)', () => {
  const noFb = compacted(REAL_P2, fillRequest(GUIDE, MATS)), read = o => validateFill(GUIDE, stripNulls('briefing_fill', o), { materials: MATS, only: new Set(['P2']), needTitle: true })
  assert.equal(read(noFb).items.P2.fallback, REAL_P2.items.P2.text)
  const blank = structuredClone(noFb); blank.items.P2.fallback = ''; assert.deepEqual(read(blank).issues, [{ item: 'P2', slot: 'fallback', kind: 'empty' }])
  const own = structuredClone(noFb); own.items.P2.fallback = '직접 쓴 문장'; assert.equal(read(own).items.P2.fallback, '직접 쓴 문장')
})

test('the compact schema and the validator agree: every schema-valid reply (nulls in copy fields included) is read; seeded fuzz', () => {
  const request = fillRequest(GUIDE, MATS), schema = fillOutputSchema(request.guide)
  assert.deepEqual(schemaProblems(schema), [])
  let seed = 35; const rnd = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff, pick = l => l[Math.floor(rnd() * l.length)]
  let valid = 0, hard = []
  for (let n = 0; n < 500; n++) {
    const field = (f, i) => (f.type === 'material' ? pick(i.materials) : pick(f.copy ? [null, '', 'v', 'w'.repeat(200)] : ['', 'v', 'w'.repeat(200)]))
    const slot = (s, i) => (s.type === 'text' ? pick([null, '', 'z', 'q'.repeat(300)]) : pick([null, Array.from({ length: pick([0, 1, 2, 3, 9]) }, () => Object.fromEntries(s.of.map(f => [f.name, field(f, i)])))]))
    const itemReply = i => ({ text: pick(['', 'a', '짧은 설명']), slots: Object.fromEntries(i.slots.map(s => [s.name, slot(s, i)])) })
    const reply = { title: pick(['', 't', '제목', 'x'.repeat(200)]), unfillable: [], items: Object.fromEntries(request.guide.items.map(i => [i.id, itemReply(i)])) }
    if (violation(reply, schema) !== null) continue
    valid++
    const read = validateFill(GUIDE, stripNulls('briefing_fill', reply), { materials: MATS })
    if (!read.ok && !(read.reason === 'no-title' && !reply.title.trim())) hard.push(read.reason)
  }
  assert.ok(valid > 300, String(valid)); assert.deepEqual(hard, [])
})

test('size, measured on the real check-9 replies: the compact reply is the same board in fewer characters; the prompt does not grow', () => {
  const request = fillRequest(GUIDE, MATS), size = o => JSON.stringify(o).length
  const real = [REAL_P1, REAL_P2], small = real.map(r => compacted(r, request))
  const before = real.map(size), after = small.map(size)
  assert.ok(after[0] < before[0] * 0.6, `P1 ${before[0]} -> ${after[0]}`); assert.ok(after[1] < before[1], `P2 ${before[1]} -> ${after[1]}`)
  // the same text on the board (the lines of P1 are exactly the real ones; P2 keeps what the model wrote)
  const board = (r, id, only) => validateFill(GUIDE, stripNulls('briefing_fill', r), { materials: MATS, only: new Set([id]), needTitle: true }).items[id].slots
  assert.deepEqual(board(small[0], 'P1'), board(real[0], 'P1')); assert.deepEqual(board(small[1], 'P2'), board(real[1], 'P2'))
  // the prompt: a request whose guide still lists the fallback (as before this cycle) versus the compact one
  const oldPrompt = fillPrompt({ ...request, guide: { ...GUIDE } }), newPrompt = fillPrompt(request)
  assert.ok(newPrompt.length <= oldPrompt.length + 450, `prompt ${oldPrompt.length} -> ${newPrompt.length}`)
  assert.ok(!/fallback/.test(newPrompt) && /fallback/.test(oldPrompt)); assert.ok(newPrompt.includes('"copy": true may be null') && !oldPrompt.includes('"copy": true may be null')); assert.ok(newPrompt.includes('at most 80 characters'))
  console.log(JSON.stringify({ realReplyChars: before, compactReplyChars: after, promptChars: { before: oldPrompt.length, after: newPrompt.length }, schemaChars: { before: JSON.stringify(fillOutputSchema(GUIDE)).length, after: JSON.stringify(fillOutputSchema(request.guide)).length } }))
})
