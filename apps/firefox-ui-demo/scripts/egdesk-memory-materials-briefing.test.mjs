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

// ---- s2 of the real all-on run (2026-11-25): "방금 그 내용 정리해줘" fetched two unrelated PostgreSQL pages ----
test('product path: a referential follow-up\'s memory loop is told which held pages the previous reply was given with (titles of held pages only)', async t => {
  const w = allOnWorld(t)
  await w.settings.turnMemory.save('on')
  w.step('m1'); await w.send(QUOTE); await w.idle(); await w.advance(3000); await w.answer('A사 견적은 v1 발송 후 v2 수정 계획 단계입니다.'); await w.idle()
  w.step('m2'); const sent = await w.send('방금 그 내용 정리해줘'); await w.idle()
  const scans = w.decisionsIn('m2').filter(d => d.feature === 'memory_fetch')
  assert.ok(scans.length >= 1, 'the follow-up still asks (recall points back), as the real triage did')
  const line = scans[0].raw.match(/The assistant's previous reply in this conversation was given with these held pages: ([^"\\]*)\./)?.[1] ?? ''
  for (const title of ['A사 견적 요청 접수', 'A사 견적서 v1 발송', 'A사 견적서 v2 수정 계획']) assert.ok(line.includes(title), `${title} in: ${line}`)
  assert.ok(!/PostgreSQL/.test(line), 'only held pages are named')
  // and nothing new is attached: the materials of the follow-up are the held A사 pages
  const rows = w.chat.memoryMaterialsFor(w.chat.runFor(sent))
  assert.ok(rows.length && rows.every(r => r.held && r.title.startsWith('A사')), rows.map(r => `${r.title}:${r.held}`).join(', '))
})
