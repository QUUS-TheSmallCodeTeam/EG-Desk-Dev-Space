// The scripted subjective model's briefing fill (scripts/egdesk-all-on.support.mjs fillFromGuide) follows the fill rules the product
// gives it: every line and value comes from the material it cites (whole sentences, or a value the material states), nothing a material
// does not say, and a redo drops what the check rejected instead of repeating it. Cycle 14: the first real run's fill check flagged the
// old fill (titles as lines, the same title on both sides of a row, "…의 내용입니다." explanations) and was right to.
import test from 'node:test'
import assert from 'node:assert/strict'
import { allOnWorld, fillFromGuide } from './egdesk-all-on.support.mjs'
import { STEPS, createMeasureTransport, loadJourneyPlan, DEFAULT_CAPS, PLAN_FILE_V3 } from './egdesk-all-on-live-measure.mjs'

// The fill prompt exactly as the product builds it in the all-on journey (s1..s3 on the scripted answers).
async function productFillPrompt(t) {
  const plan = loadJourneyPlan(PLAN_FILE_V3), { transport } = createMeasureTransport({ caps: DEFAULT_CAPS, plan })
  const w = allOnWorld(t, { transport })
  await w.settings.turnMemory.save('on')
  const j = { note: {}, sends: [], said: [], async say(text, extra) { await w.send(text, extra); await w.idle() }, async pause() { await w.idle() } }
  for (const def of STEPS.slice(0, STEPS.findIndex(s => s.id === 's3-briefing') + 1)) { w.step(def.id); await def.run(w, j); await w.idle() }
  const fill = w.forkPrompts.find(p => p.step === 's3-briefing' && /Design guide \(decided/.test(p.prompt))
  assert.ok(fill, 'the journey reaches the fill turn')
  return fill.prompt
}
const parse = text => JSON.parse(text.replace(/^```json\n|\n```$/g, ''))
const materialsOf = prompt => Object.fromEntries(JSON.parse(/Materials:\n(.*)\n\nRules:/s.exec(prompt)[1]).map(m => [m.alias, m]))
const guideOf = prompt => JSON.parse(/Design guide \(decided; do not change it\):\n(.*)\n\nMaterials:/s.exec(prompt)[1])

test('fill: lines are whole sentences of the material they cite, compare values are stated by the material of their side, no line is a bare title', async t => {
  const prompt = await productFillPrompt(t), M = materialsOf(prompt), guide = guideOf(prompt), out = parse(fillFromGuide(prompt))
  assert.deepEqual(Object.keys(out.items).sort(), guide.items.map(i => i.id).sort())
  for (const item of guide.items) {
    const got = out.items[item.id]
    assert.ok(got.text.trim(), `${item.id}: an explanation`)
    for (const line of got.slots.lines ?? []) {
      assert.ok(item.materials.includes(line.from), `${item.id}: a line cites one of the item's materials`)
      assert.ok(M[line.from].text.includes(line.text), `${item.id}: "${line.text}" is in ${line.from}`)
      assert.notEqual(line.text, M[line.from].title, `${item.id}: a line is not the material's title`)
    }
    if (got.slots.rows) {
      const left = M[got.slots.left], right = M[got.slots.right]
      assert.ok(left && right && left.alias !== right.alias)
      for (const row of got.slots.rows) {
        assert.ok(left.text.includes(row.left) && right.text.includes(row.right), `${item.id} ${row.aspect}: each side is stated by its own material`)
        assert.notEqual(row.left, row.right)
        assert.ok(got.text.includes(row.left) && got.text.includes(row.right), `${item.id}: the explanation says only what the rows show`)
      }
    }
  }
})

test('fill redo: only the items asked again, without the rejected parts; never the same data again', async t => {
  const prompt = await productFillPrompt(t), guide = guideOf(prompt), first = parse(fillFromGuide(prompt))
  const minOf = i => i.slots.find(s => s.name === 'lines')?.min ?? 1
  const withLines = guide.items.find(i => (first.items[i.id].slots.lines ?? []).length >= 2 && (first.items[i.id].slots.lines ?? []).length > minOf(i))
  const bound = guide.items.find(i => (first.items[i.id].slots.lines ?? []).length >= 2 && (first.items[i.id].slots.lines ?? []).length === minOf(i))
  assert.ok(withLines || bound, 'an item with at least two lines')
  if (!withLines) return redoBound(prompt, bound, first)
  const redo = prompt.replace('Design guide (decided; do not change it):', `Fill only these items again: ${withLines.id}.\nA check found these parts of your previous data not supported by the material they cite: ${withLines.id} line 2; ${withLines.id} explanation. Write them again from what the material says, keeping its actors, qualifiers, amounts and dates exactly, or report the slot as unfillable.\n\nDesign guide (decided; do not change it):`)
  const again = parse(fillFromGuide(redo))
  assert.deepEqual(Object.keys(again.items), [withLines.id])
  const before = first.items[withLines.id].slots.lines, after = again.items[withLines.id].slots.lines
  assert.deepEqual(after, [before[0], ...before.slice(2)], 'line 2 dropped, the others kept')
  assert.equal(again.items[withLines.id].text, before[0].text, 'the explanation is rewritten from a line it shows')
})

// c38: a sequence card has one line for every material it shows (min = the number of materials), so a rejected line cannot be dropped: it is written again, from its own material, and
// differently (never the same data again); the other lines and the number of lines stay.
function redoBound(prompt, item, first) {
  const redo = prompt.replace('Design guide (decided; do not change it):', `Fill only these items again: ${item.id}.\nA check found these parts of your previous data not supported by the material they cite: ${item.id} line 2. Write them again from what the material says, keeping its actors, qualifiers, amounts and dates exactly, or report the slot as unfillable.\n\nDesign guide (decided; do not change it):`)
  const again = parse(fillFromGuide(redo)), before = first.items[item.id].slots.lines, after = again.items[item.id].slots.lines
  assert.deepEqual(Object.keys(again.items), [item.id]); assert.equal(after.length, before.length, 'every material keeps its line')
  assert.deepEqual([after[0], ...after.slice(2)], [before[0], ...before.slice(2)], 'the other lines are unchanged'); assert.equal(after[1].from, before[1].from); assert.notDeepEqual(after[1], before[1], 'line 2 is not the same data again')
}
