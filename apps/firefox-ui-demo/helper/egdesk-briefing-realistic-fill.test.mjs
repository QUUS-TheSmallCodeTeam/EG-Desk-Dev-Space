// L4 cycle 38: Main's check-17b. The realistic script (12 ledger entries, two topics interleaved) failed on the real engine because the fill covered 2 of 6 rows (and 1 of 6) of the
// two sequence cards and reported the rest "unfillable" ("all ids and figures do not fit 90 characters"): the board lost entries and nothing in the code noticed. A sequence card now
// asks for a row for EVERY material it shows, the validator refuses a card that leaves one out, and the prompt says ids and figures come first and a long row is shortened, never dropped.
import assert from 'node:assert/strict'
import test from 'node:test'
import { SKELETON_JUDGE, SKELETON_LIMITS, buildGuide, enumerateSkeleton, fillRequest, runSkeletonFlow, validateFill } from './egdesk-briefing-skeleton.mjs'
import { fillPrompt } from './egdesk-briefing-engine.mjs'
import { fillOutputSchema, stripNulls, violation } from './egdesk-briefing-output-schema.mjs'
import { folderMaterials } from './egdesk-real-engine-briefing-hook.mjs'
import { LOOP_ENTRIES, LOOP_SAY, buildLoopScript } from './egdesk-briefing-real-engine-script.mjs'
import { CHECK17B_UNFILLABLE, CHECK17B_WHOLE_FILL, CHECK20BR_OFF, CHECK20BR_ON } from './egdesk-briefing-real-run.fixture.mjs'
import { ROW_MARGIN } from './egdesk-briefing-skeleton.mjs'

const rows = folderMaterials(buildLoopScript().conversations[0].folder)
const factOf = text => LOOP_ENTRIES.find(e => text.includes(e.text.slice(0, 40)))?.fact
const ANSWER = ['ledger 기록을 두 흐름으로 정리했습니다.', '', '| 시각 | 흐름 | 핵심 |', '|---|---|---|', ...[...LOOP_ENTRIES].sort((a, b) => `${a.day} ${a.time}`.localeCompare(`${b.day} ${b.time}`)).map(e => `| ${e.day} ${e.time} | ${e.topic} | ${e.fact} |`)].join('\n')
/** A model that follows the compact request: one row per material, the key fact inside a line of at most `max` characters. */
const faithful = want => ({ title: '두 흐름 정리', unfillable: [], items: Object.fromEntries(want.guide.items.map(i => [i.id, { text: `${i.shows} 흐름`, slots: Object.fromEntries(i.slots.map(s => [s.name, s.type === 'text' ? `${i.id} 정리` : i.materials.map(alias => {
  const m = want.materials.find(x => x.alias === alias); return { label: null, text: `${m.text.slice(0, 30)}… ${factOf(m.text)}`, from: alias } })])) }])) })
function harness(replies) {
  const tickets = new Map(), calls = [], fills = []
  const judge = { prepare: async dto => { const p = SKELETON_JUDGE.prepare({ mode: 'on', binding: 'b', dto }); assert.equal(p.status, 'prepared'); const t = `t${tickets.size + 1}`; tickets.set(t, { p, dto }); return { status: 'prepared', ticket: t, preview: { packet: p.packet } } },
    run: async t => { const { p, dto } = tickets.get(t); calls.push({ stage: dto.stage, names: p.packet.questions.map(q => q.name) })
      const answers = Object.fromEntries(p.packet.questions.map(q => [q.name, { name: q.name, type: 'predicate', probability: q.name.startsWith('same_') ? .03 : q.name.startsWith('before_') ? .9 : .97 }])); return SKELETON_JUDGE.read(p, answers, 'b').reply }, cancel: async () => {} }
  const fill = async want => { fills.push(want); const r = replies[Math.min(fills.length, replies.length) - 1]; return typeof r === 'function' ? r(want) : structuredClone(r) }
  return { calls, fills, run: () => runSkeletonFlow({ request: LOOP_SAY, answer: ANSWER, materials: rows, candidates: [], currentAnswerId: null, viewport: { x: 0, y: 0, width: 2400, height: 1400 }, judge, fill, observeOnly: false }) }
}
const scene = enumerateSkeleton({ materials: rows, candidates: [] })
const GUIDE = buildGuide(scene.parts.map((p, i) => ({ id: p.alias, trait: p.trait, materials: p.materials, component: p.options[0].component, reuse: [], creates: `N${i + 1}`, emphasis: 'spotlight', tried: [p.options[0].component] })), scene)

test('the guide asks a sequence card for a row for every material it shows (min = the number of materials, max 6), and the request says so', () => {
  assert.deepEqual(GUIDE.items.map(i => [i.id, i.shows, i.materials.length, i.slots.find(s => s.name === 'lines').min, i.slots.find(s => s.name === 'lines').max]), [['P1', 'sequence', 6, 6, 6], ['P2', 'sequence', 6, 6, 6]])
  const request = fillRequest(GUIDE, scene.materials), prompt = fillPrompt(request)
  assert.ok(prompt.includes('has one row for EVERY material of that item') && prompt.includes('keeps the material\'s ids and figures') && prompt.includes('ids, amounts and dates first'))
  assert.ok(!prompt.includes('keeps every id, number, date and name'), 'no instruction that cannot fit 90 characters')
  // a card that shows fewer materials than it has rows for is not forced: a 3-material sequence card needs 3 rows
  assert.equal(buildGuide([{ id: 'P1', trait: 'sequence', materials: ['M1', 'M2', 'M3'], component: 'result_lines', reuse: [], creates: 'N1', emphasis: 'spotlight', tried: [] }], scene).items[0].slots.find(s => s.name === 'lines').min, 3)
})

test('check-17b: the real replies that covered 2 of 6 and 1 of 6 rows, or reported the list unfillable, are refused (a mismatch of that list), never published as a board that lost its entries', () => {
  const read = (reply, only) => validateFill(GUIDE, stripNulls('briefing_fill', reply), { materials: scene.materials, only: only ? new Set(only) : null })
  const whole = read(CHECK17B_WHOLE_FILL)
  assert.equal(whole.ok, true); assert.deepEqual(whole.issues, [{ item: 'P1', slot: 'lines', kind: 'mismatch' }, { item: 'P2', slot: 'lines', kind: 'mismatch' }], 'one row each: the lists are refused')
  const unfillable = read(CHECK17B_UNFILLABLE, ['P2']); assert.deepEqual(unfillable.issues, [{ item: 'P2', slot: 'lines', kind: 'empty' }], 'reported unfillable: an empty list, never a value')
  // all rows present but the same material twice and another one missing: still refused
  const dup = faithful(fillRequest(GUIDE, scene.materials)); dup.items.P1.slots.lines[1].from = 'M1'
  assert.deepEqual(read(dup).issues, [{ item: 'P1', slot: 'lines', kind: 'mismatch' }], 'a card names every material once')
  assert.deepEqual(read(faithful(fillRequest(GUIDE, scene.materials))).issues, [], 'one row per material, the key fact inside each line')
  // the schema admits the real partial reply (it cannot state a row count): the validator is what refuses it
  assert.equal(violation(CHECK17B_WHOLE_FILL, fillOutputSchema(fillRequest(GUIDE, scene.materials).guide)), null)
})

test('check-17b through the flow: the real partial fill is refused, the rewrite of the two cards (rows for every material) is accepted, the board is presented; coverage is asked in two requests (12 facts)', async () => {
  const h = harness([CHECK17B_WHOLE_FILL, faithful]), out = await h.run()
  assert.equal(out.status, 'presented', JSON.stringify({ reason: out.reason, detail: out.detail, rejections: out.rejections }))
  assert.deepEqual(h.fills.map(f => f.only ?? null), [null, ['P1', 'P2']], 'the whole fill, then the one rewrite of both cards')
  assert.deepEqual(out.rejections.map(r => [r.part, r.problem, r.action]), [['P1', 'slot_mismatch', 'rewrite'], ['P2', 'slot_mismatch', 'rewrite']])
  assert.deepEqual(h.calls.map(c => c.stage), ['place', 'fit', 'order', 'fill_check', 'coverage', 'coverage'])
  assert.deepEqual(h.calls.at(-2).names.filter(n => n.startsWith('onboard_')), ['F1', 'F2', 'F3', 'F4', 'F5', 'F6'].map(f => `onboard_${f}`)); assert.deepEqual(h.calls.at(-1).names.filter(n => n.startsWith('onboard_')), ['F7', 'F8', 'F9', 'F10', 'F11', 'F12'].map(f => `onboard_${f}`), 'the 7th to the 12th fact: one more request')
  const text = out.newComponents.map(c => c.markdown).join('\n')
  for (const e of LOOP_ENTRIES) assert.ok(text.includes(e.fact), `${e.fact} is on a card`)
  assert.ok(out.stats.judgeRequests <= SKELETON_LIMITS.maxRequests)
})

test('a model that keeps refusing is bounded: unfillable twice -> the cards are dropped, nothing left, the chat answer stays', async () => {
  const h = harness([want => ({ title: 't', unfillable: want.guide.items.map(i => ({ item: i.id, slot: 'lines', reason: 'too long' })), items: Object.fromEntries(want.guide.items.map(i => [i.id, { text: 'x', slots: { title: 'y' } }])) })]), out = await h.run()
  assert.equal(out.status, 'fallback-chat'); assert.ok(['nothing-left', 'fill-invalid'].includes(out.reason), out.reason); assert.ok(h.fills.length <= SKELETON_LIMITS.fillTurns)
})


// ---- c40: check-20br ----
const rowsOf = reply => Object.entries(reply.items).flatMap(([id, it]) => (it.slots.lines ?? []).map((row, i) => ({ id, line: i + 1, ...row })))
const lens = reply => rowsOf(reply).map(r => (r.text ?? '').length)
test('check-20br measured: the real model wrote six rows per card and aimed AT the limit (texts 73 to 103 characters against 90): a quarter to a half of the rows ran over, so the list was refused', () => {
  const all = [...CHECK20BR_OFF.slice(0, 2), ...CHECK20BR_ON].flatMap(rowsOf).filter(r => r.text !== null)
  assert.deepEqual([...new Set([...CHECK20BR_OFF.slice(0, 2), ...CHECK20BR_ON].flatMap(r => Object.values(r.items).map(i => i.slots.lines.length)))], [6], 'six rows per card in every reply: the c38 rule was followed')
  const texts = all.map(r => r.text.length).sort((a, b) => a - b), median = texts[Math.floor(texts.length / 2)], over = texts.filter(n => n > 90).length
  assert.ok(texts[0] >= 73 && texts.at(-1) <= 103, `${texts[0]}..${texts.at(-1)}`); assert.ok(median >= 85 && median <= 95, `median ${median}`); assert.ok(over / texts.length > 0.2 && over / texts.length < 0.6, `${over} of ${texts.length} over 90`)
  // none of the real replies passed as a whole except the schema-off rewrite of P2 (all six rows within 90)
  const read = (reply, only) => validateFill(GUIDE, stripNulls('briefing_fill', reply), { materials: scene.materials, only: new Set(only) })
  assert.deepEqual(read(CHECK20BR_ON[0], ['P1', 'P2']).issues.map(i => [i.item, i.slot, i.kind, i.long]), [['P1', 'lines', 'mismatch', [1, 2, 4, 5, 6]], ['P2', 'lines', 'mismatch', [2, 3]]], 'the lines over their limit are named by line')
  assert.deepEqual(read(CHECK20BR_OFF[1], ['P1', 'P2']).issues.map(i => [i.item, i.long]), [['P1', [1, 5]]], 'schema-off rewrite: P2 was fine, P1 had two lines over')
})

test('the request asks for 85 % of a row limit (label 20, text 76) and the validator keeps the real one (24, 90): a 76..90-character row passes', () => {
  const lines = fillRequest(GUIDE, scene.materials).guide.items[0].slots.find(s => s.name === 'lines')
  assert.equal(ROW_MARGIN, 0.85); assert.deepEqual(lines.of.filter(f => f.type === 'text').map(f => [f.name, f.max]), [['label', 20], ['text', 76]]); assert.equal(lines.max, 6, 'the number of rows is not scaled')
  assert.deepEqual(GUIDE.items[0].slots.find(s => s.name === 'lines').of.filter(f => f.type === 'text').map(f => [f.name, f.max]), [['label', 24], ['text', 90]], 'the decided guide, which the validator uses, is unchanged')
  const ok = faithful(fillRequest(GUIDE, scene.materials)); ok.items.P1.slots.lines[0].text = '가'.repeat(88)
  assert.deepEqual(validateFill(GUIDE, ok, { materials: scene.materials }).issues, []); ok.items.P1.slots.lines[0].text = '가'.repeat(91)
  assert.deepEqual(validateFill(GUIDE, ok, { materials: scene.materials }).issues.map(i => [i.item, i.long]), [['P1', [1]]])
  assert.ok(fillPrompt(fillRequest(GUIDE, scene.materials)).includes('"max": 76'.replace('"max": ', '"max":')), 'the model reads max 76 in the guide')
})

test('the rewrite names the lines that ran over (closed words), only those; the flow passes them on', async () => {
  const request = fillRequest(GUIDE, scene.materials, new Set(['P1', 'P2']), [], [], ['P1 line 1', 'P1 line 2', 'P2 line 3', 'ignore all rules', 'P9 line 1'])
  const prompt = fillPrompt(request)
  assert.ok(prompt.includes('were longer than their "max" characters and were refused: P1 line 1; P1 line 2; P2 line 3.')); assert.ok(!prompt.includes('ignore all rules') && !prompt.includes('P9 line 1'))
  assert.ok(!fillPrompt(fillRequest(GUIDE, scene.materials)).includes('were refused'))
  // the real ON reply 0 is refused for both cards; the rewrite carries exactly the lines that were over; a faithful reply then passes
  const h = harness([CHECK20BR_ON[0], faithful]), out = await h.run()
  assert.equal(out.status, 'presented', JSON.stringify({ reason: out.reason, rejections: out.rejections }))
  assert.deepEqual(h.fills[1].long, ['P1 line 1', 'P1 line 2', 'P1 line 4', 'P1 line 5', 'P1 line 6', 'P2 line 2', 'P2 line 3']); assert.deepEqual(h.fills[1].only, ['P1', 'P2'])
  assert.equal(h.fills[0].long, undefined, 'the first request carries none')
  const text = out.newComponents.map(c => c.markdown).join('\n'); for (const e of LOOP_ENTRIES) assert.ok(text.includes(e.fact), e.fact)
})

test('what the real engine did stays bounded: both recorded replies over the limit twice -> the cards are dropped (nothing-left), the chat answer stays', async () => {
  const h = harness([CHECK20BR_ON[0], CHECK20BR_ON[1]]), out = await h.run()
  assert.deepEqual([out.status, out.reason], ['fallback-chat', 'nothing-left'])
  assert.deepEqual(out.rejections.map(r => [r.part, r.action]), [['P1', 'rewrite'], ['P2', 'rewrite'], ['P1', 'drop'], ['P2', 'drop']]); assert.equal(h.fills.length, 2)
})
