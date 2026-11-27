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

// ---- L7 c18: a referential follow-up with a decided need "no" fetches nothing; a genuine recall still fetches ----
import { scriptedDecisions } from './egdesk-all-on.support.mjs'
// The real answers of 2026-11-25 for this turn: the s2 triage of the all-on run, and the s2 scan Main sent in c17 (with the previous-reply line).
const S2_TRIAGE = { tn_courtesy: 0, tn_need: 0, tn_recall: 0.96, tn_record: 0 }
const S2_SCAN = { pg_0: 0.02, pg_1: 0.8, pg_2: 0.66, pg_3: 0.26, pg_4: 0.27, pg_5: 0.03, pg_6: 0.05 }
const p = probability => ({ type: 'predicate', probability })
function replayingTransport(overrides) {
  const scripted = scriptedDecisions()
  return async ({ wire }) => {
    const answers = await scripted.answer(wire), names = wire.questions.map(q => q.name), message = /Message:\n([\s\S]*?)(?:"|$)/.exec(JSON.stringify(wire.input).replace(/\\n/g, '\n'))?.[1] ?? ''
    // the scripted answers are in wire form (a list of { name, ... }); the real values replace those of the same name
    for (const [when, values] of overrides) if (when(names, message)) for (const [name, v] of Object.entries(values)) {
      if (!names.includes(name)) continue
      const i = answers.findIndex(x => x?.name === name), real = { name, ...p(v) }
      if (i >= 0) answers[i] = real; else answers.push(real)
    }
    return { status: 200, json: { answers, usage: { input_tokens: 10 } } }
  }
}
const isTriage = names => names.includes('tn_need'), isScan = names => names.some(n => n.startsWith('pg_'))

test('c18 product path: "방금 그 내용 정리해줘" with the real triage (need 0, recall 0.96) asks no scan and attaches no page; the held A사 pages are its materials', async t => {
  const transport = replayingTransport([[(n, m) => isTriage(n) && m.includes('방금 그 내용'), S2_TRIAGE], [(n, m) => isScan(n) && m.includes('방금 그 내용'), S2_SCAN]])
  const w = allOnWorld(t, { transport })
  await w.settings.turnMemory.save('on')
  w.step('m1'); await w.send(QUOTE); await w.idle(); await w.advance(3000); await w.answer('A사 견적은 v1 발송 후 v2 수정 계획 단계입니다.'); await w.idle()
  w.step('m2'); const sent = await w.send('방금 그 내용 정리해줘'); await w.idle()
  const features = w.decisionsIn('m2').map(d => d.feature)
  assert.ok(features.includes('memory_triage') && !features.includes('memory_fetch'), `no scan: ${features}`)
  const start = w.turnStarts().at(-1).params
  assert.doesNotMatch(JSON.stringify(start.additionalContext), /PostgreSQL|헬스체크/, 'no PostgreSQL page reaches the answering model')
  const rows = w.chat.memoryMaterialsFor(w.chat.runFor(sent))
  assert.ok(rows.length >= 3 && rows.every(r => r.held && r.title.startsWith('A사')), rows.map(r => `${r.title}:${r.held}`).join(', '))
})

test('c18 product path: the same real answers under the c11 rule (recall overrides need) would fetch and attach the PostgreSQL plan; a genuine recall still fetches under c18', async t => {
  const { triageSkipsFetch } = await import('../helper/egdesk-turn-memory.mjs')
  const t2 = { courtesy: { state: 'no', p: 0 }, need: { state: 'no', p: 0 }, recall: { state: 'yes', p: 0.96 }, catalog: { complete: true }, held: 5 }
  assert.deepEqual([triageSkipsFetch(t2), triageSkipsFetch(t2, { legacyRecall: true })], [true, false], 'c18 skips; the c11 rule fetched')
  assert.equal(triageSkipsFetch({ ...t2, held: 0 }), false, 'nothing held: a decided need "no" alone does not skip')
  assert.equal(triageSkipsFetch({ ...t2, need: { state: 'unknown', p: 0.5 } }), false, 'an undecided need fetches')
  // a genuine recall about another matter, in the same conversation. Its triage values are ASSUMED to follow the real pattern of a-mid and
  // j-mid (need 1 with recall high, 2026-11-24): nobody has measured this message.
  const transport = replayingTransport([[(n, m) => isTriage(n) && m.includes('지난달 PG'), { tn_courtesy: 0, tn_need: 1, tn_recall: 1, tn_record: 0 }]])
  const w = allOnWorld(t, { transport })
  await w.settings.turnMemory.save('on')
  w.step('m1'); await w.send(QUOTE); await w.idle(); await w.advance(3000); await w.answer('A사 견적은 v1 발송 후 v2 수정 계획 단계입니다.'); await w.idle()
  w.step('m2'); await w.send('지난달 PG 마이그레이션 결정 뭐였지?'); await w.idle()
  assert.ok(w.decisionsIn('m2').some(d => d.feature === 'memory_fetch'), 'a recall of material that is not held is fetched')
})
