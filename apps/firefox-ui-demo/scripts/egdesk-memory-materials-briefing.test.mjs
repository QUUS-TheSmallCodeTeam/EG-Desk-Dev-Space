// The materials the briefing receives, on the product path (L2's all-on world: the bridge's wiring, the ontology graph, turn memory 'on'):
// they carry the date and status the records give and their recorded version links, so L4's code rules (sequence by date, open items
// by status plan, compare by a version link) fire on them. L7 c17. Synthetic harness only.
import test from 'node:test'
import assert from 'node:assert/strict'
import { allOnWorld } from './egdesk-all-on.support.mjs'
import { enumerateSkeleton, normalizeMaterials } from '../helper/egdesk-briefing-skeleton.mjs'

const QUOTE = '지난주 A사 견적 건 어디까지 됐지?'

test('product path: the A사 materials carry recorded dates, the plan status and the v2 -> v1 version link; the sequence, open-items and compare parts are offered', async t => {
  const w = allOnWorld(t)
  await w.settings.turnMemory.save('on')
  w.step('m1'); const sent = await w.send(QUOTE); await w.idle()
  const rows = w.chat.memoryMaterialsFor(w.chat.runFor(sent))
  const by = title => rows.find(r => r.title === title)
  assert.ok(rows.length >= 3, `materials: ${rows.map(r => r.title)}`)
  // dates as recorded on the pages (no computation), status as recorded
  assert.equal(by('A사 견적서 v1 발송')?.time.at, '2026-11-06')
  assert.equal(by('A사 견적서 v2 수정 계획')?.status, 'plan')
  assert.ok(by('A사 견적서 v2 수정 계획').links.some(l => l.type === 'supersedes' && l.toAlias === by('A사 견적서 v1 발송').alias), 'the recorded version link')
  // L4's normalisation reads them, and its code rules fire
  const mats = normalizeMaterials(rows)
  assert.ok(mats.filter(m => m.at).length >= 2); assert.ok(mats.some(m => m.open))
  const { parts } = enumerateSkeleton({ materials: rows })
  const traits = new Set(parts.map(p => p.trait))
  assert.ok(traits.has('sequence') && traits.has('open_items') && traits.has('compare'), `traits: ${[...traits]}`)
})
