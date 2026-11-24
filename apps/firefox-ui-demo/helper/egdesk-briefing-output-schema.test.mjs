// L4 cycle 30: the briefing's fill / design turn constrained by a JSON Schema (Codex TurnStartParams.outputSchema), built from the accepted shape of the render
// components. Default off; with the flag on the engine's final message must be a valid fill / design. Synthetic: fake runText, no Codex binary, no network.
import assert from 'node:assert/strict'
import test from 'node:test'
import { designOutputSchema, fillOutputSchema, outputSchemaFor, schemaProblems, slotSchema, stripNulls, violation } from './egdesk-briefing-output-schema.mjs'
import { BRIEFING_ENGINE_LIMITS, briefingDeps, createBriefingEngine, designPrompt, fillPrompt } from './egdesk-briefing-engine.mjs'
import { BRIEFING_CATALOG } from './egdesk-briefing-catalog.mjs'
import { buildGuide, enumerateSkeleton, fillRequest, normalizeMaterials, validateFill } from './egdesk-briefing-skeleton.mjs'

const row = (alias, title, excerpt, at, status) => ({ alias, kind: 'page', time: { slice: 'past', at }, provenance: { kind: 'document', by: null, basis: 'record_based' }, status, title, excerpt, links: [], held: false })
const MATS = normalizeMaterials([row('M1', 'A사 견적서 v1', '총액 1,200만원. 납기 6주.', '2026-11-03', 'done'), row('M2', 'A사 견적서 v2 안', '총액 1,050만원. 납기 8주.', '2026-11-10', 'plan'), row('M3', 'A사 미팅 메모', '가격 인하 요청을 수용함.', '2026-11-12', 'done')])
// a guide over these materials of the three components that create cards (compare, lines, text) and a step that only points at a card already on the board
function guideOf() {
  const scene = enumerateSkeleton({ materials: MATS, candidates: [] })
  const item = (id, trait, materials, component, creates, reuse = []) => ({ id, trait, materials, component, reuse, creates, emphasis: 'spotlight', tried: [component] })
  return buildGuide([item('P1', 'compare', ['M1', 'M2'], 'result_compare', 'N1'), item('P2', 'sequence', ['M1', 'M2', 'M3'], 'result_lines', 'N2'), item('P3', 'single', ['M3'], 'result_text', 'N3'), item('P4', 'single', ['M1'], null, null, ['T1'])], scene)
}
const GUIDE = guideOf()
const asJson = v => JSON.stringify(v)

test('fill schema from the guide: exactly the guide\'s items and their slots, material slots limited to the item\'s own aliases, strict-mode subset only', () => {
  assert.deepEqual(GUIDE.items.map(i => i.component), ['result_compare', 'result_lines', 'result_text', 'existing_card'])
  const schema = fillOutputSchema(GUIDE)
  assert.deepEqual(schemaProblems(schema), [])
  assert.deepEqual(Object.keys(schema.properties.items.properties), GUIDE.items.map(i => i.id))
  for (const item of GUIDE.items) {
    const s = schema.properties.items.properties[item.id]
    assert.deepEqual(s.required, ['text', 'fallback', 'slots']); assert.deepEqual(Object.keys(s.properties.slots.properties), item.slots.map(x => x.name), `${item.id}: only the slots its component lists`)
    for (const slot of item.slots.filter(x => x.type === 'material')) assert.deepEqual(s.properties.slots.properties[slot.name].anyOf[0].enum, item.materials, 'a material slot is one of the item\'s own materials')
  }
  assert.deepEqual(schema.properties.unfillable.items.properties.item.enum, GUIDE.items.map(i => i.id))
  assert.deepEqual(slotSchema({ type: 'text', name: 't', max: 40 }, GUIDE.items[0]), { type: 'string' }, 'a max is the code\'s limit (validateFill), not a schema keyword')
  // a partial fill (rewrite one item) lists only that item
  assert.deepEqual(Object.keys(fillOutputSchema(GUIDE, { only: new Set([GUIDE.items[0].id]) }).properties.items.properties), [GUIDE.items[0].id])
  assert.throws(() => fillOutputSchema({ items: [] }))
  assert.deepEqual(outputSchemaFor(fillRequest(GUIDE, MATS)), schema, 'the engine\'s request carries the same guide')
})
test('design schema from the request: the board aliases and "new:<part>" for an allowed part; emphasis a closed word or null; strict subset', () => {
  const request = { kind: 'briefing_design', targets: [{ alias: 'T1' }, { alias: 'T2' }], reuse: ['T1', 'T2'], retire: [], newAllowed: [{ part: 'P3', label: 'Next steps' }], maxNew: 1 }
  const schema = designOutputSchema(request)
  assert.deepEqual(schemaProblems(schema), []); assert.deepEqual(schema.properties.steps.items.properties.targets.items.enum, ['T1', 'T2', 'new:P3'])
  assert.deepEqual(schema.properties.newComponents.items.properties.part.enum, ['P3']); assert.deepEqual(schema.properties.steps.items.properties.emphasis.anyOf[0].enum, ['spotlight', 'outline'])
  assert.deepEqual(outputSchemaFor({ ...request, kind: 'briefing_redesign' }), schema); assert.equal(outputSchemaFor({ kind: 'briefing_component', title: 't' }), null, 'a component text is markdown, not JSON')
  assert.throws(() => designOutputSchema({ targets: [] }))
})
test('schemaProblems names what a strict schema may not contain; violation checks a value against the subset', () => {
  assert.deepEqual(schemaProblems({ type: 'object', properties: { a: { type: 'string', maxLength: 5 } }, required: [] }).sort(), ['$.a: maxLength is not allowed', '$: additionalProperties must be false', '$: every property must be required'].sort())
  const schema = fillOutputSchema(GUIDE), ok = JSON.parse(asJson({ title: 'x', unfillable: [], items: Object.fromEntries(GUIDE.items.map(i => [i.id, { text: 't', fallback: 'f', slots: Object.fromEntries(i.slots.map(s => [s.name, null])) }])) }))
  assert.equal(violation(ok, schema), null, 'null is a slot left out')
  assert.match(violation({ ...ok, extra: 1 }, schema), /extra: not a listed property/); assert.match(violation({ ...ok, title: 5 }, schema), /title: expected a string/)
  const bad = structuredClone(ok); bad.items[GUIDE.items[0].id].slots[GUIDE.items[0].slots.find(s => s.type === 'material')?.name ?? 'x'] = 'M9'
  if (GUIDE.items[0].slots.some(s => s.type === 'material')) assert.match(violation(bad, schema), /not one of the allowed values/)
  assert.match(violation('text', schema), /expected an object/)
})
const fillReply = (guide = GUIDE) => ({ title: 'A사 견적 정리', unfillable: [], items: Object.fromEntries(guide.items.map(i => [i.id, { text: `${i.shows} 설명`, fallback: '카드를 열어 보세요.', slots: Object.fromEntries(i.slots.map(s => [s.name,
  s.type === 'text' ? `${s.name} 값` : s.type === 'material' ? i.materials[s.name === 'right' ? 1 : 0] : [Object.fromEntries(s.of.map(f => [f.name, f.type === 'material' ? i.materials[0] : `${f.name} 값`]))]])) }])) })
test('stripNulls: a null slot is a slot left out (validateFill reads it as an issue, never a value); null emphasis and empty lists are absent', () => {
  const item = GUIDE.items.find(i => i.component === 'result_text'), schema = fillOutputSchema(GUIDE)
  const reply = fillReply()
  assert.equal(violation(reply, schema), null)
  reply.items[item.id].slots.body = null
  const read = validateFill(GUIDE, stripNulls('briefing_fill', reply))
  assert.equal(read.ok, true); assert.deepEqual(read.issues, [{ item: item.id, slot: 'body', kind: 'empty' }])
  assert.deepEqual(stripNulls('briefing_design', { title: 't', steps: [{ text: 'a', targets: ['T1'], emphasis: null, fallback: 'f' }, { text: 'b', targets: ['T1'], emphasis: 'outline', fallback: 'f' }], newComponents: [] }),
    { title: 't', steps: [{ text: 'a', targets: ['T1'], fallback: 'f' }, { text: 'b', targets: ['T1'], emphasis: 'outline', fallback: 'f' }] })
})

test('engine, flag OFF: runText gets exactly { timeoutMs } (no outputSchema key), the prompt is the same, stats have no schemaInvalid; a fenced reply with prose is still tolerated', async () => {
  const seen = []
  const engine = createBriefingEngine({ runText: async (prompt, options) => { seen.push([prompt, options]); return `Here you go:\n\`\`\`json\n${asJson(fillReply())}\n\`\`\`` } })
  const out = await engine(fillRequest(GUIDE, MATS))
  assert.deepEqual(Object.keys(seen[0][1]), ['timeoutMs']); assert.equal(seen[0][0], fillPrompt(fillRequest(GUIDE, MATS))); assert.equal(out.title, 'A사 견적 정리'); assert.deepEqual(Object.keys(engine.stats()), ['turns', 'refused', 'elapsedMs'])
  assert.equal(briefingDeps({ chat: {}, contexts: {} }).outputSchema, 'off'); assert.equal(briefingDeps({ chat: {}, contexts: {}, outputSchema: 'on' }).outputSchema, 'on'); assert.equal(briefingDeps({ chat: {}, contexts: {}, outputSchema: 'yes' }).outputSchema, 'off')
})
test('engine, flag ON: the same prompt plus the turn\'s outputSchema; a conforming bare JSON message is the fill; invalid, prose-wrapped, fenced, refused or empty messages are null and counted', async () => {
  const seen = [], replies = [asJson(fillReply())]
  const engine = createBriefingEngine({ outputSchema: true, limits: { maxTurns: 20 }, runText: async (prompt, options) => { seen.push([prompt, options]); return replies.shift() ?? null } })
  const request = fillRequest(GUIDE, MATS), good = await engine(request)
  assert.deepEqual(seen[0][1].outputSchema, fillOutputSchema(GUIDE)); assert.equal(seen[0][0], fillPrompt(request), 'the prompt does not change: the schema carries the constraint')
  assert.deepEqual(validateFill(GUIDE, good).ok, true)
  const bad = [
    asJson({ ...fillReply(), extra: 1 }), `Sure!\n${asJson(fillReply())}`, `\`\`\`json\n${asJson(fillReply())}\n\`\`\``, '죄송하지만 이 요청은 도와드릴 수 없습니다.', '', asJson({ title: 'x', unfillable: [], items: {} }),
    asJson({ ...fillReply(), items: { ...fillReply().items, P9: { text: 't', fallback: 'f', slots: {} } } })]
  for (const reply of bad) { replies.push(reply); assert.equal(await engine(request), null, reply.slice(0, 30)) }
  assert.equal(engine.stats().schemaInvalid, bad.length, 'every message that is not a conforming bare JSON object is counted (an empty final message too)'); assert.equal(engine.stats().turns, 1 + bad.length)
  // a turn that failed (runText null) is null too, and is not a schema failure
  const failed = createBriefingEngine({ outputSchema: true, runText: async () => null }); assert.equal(await failed(request), null); assert.equal(failed.stats().schemaInvalid, 0)
  // a request that cannot be described is asked without a schema, exactly as with the flag off
  const loose = []; const e2 = createBriefingEngine({ outputSchema: true, runText: async (p, o) => { loose.push(o); return '# 요약\n본문' } })
  assert.deepEqual(await e2({ kind: 'briefing_component', part: 'P1', title: '요약', summary: 's' }), { markdown: '# 요약\n본문' }); assert.deepEqual(Object.keys(loose[0]), ['timeoutMs'])
})
test('engine, flag ON, design-first: the design request carries its schema; a valid design (null emphasis read as none) goes through shapeDesign; an unknown alias is refused by the schema', async () => {
  const request = { kind: 'briefing_design', targets: [{ alias: 'T1', kind: 'output', label: 'a' }, { alias: 'T2', kind: 'output', label: 'b' }], reuse: ['T1', 'T2'], retire: [], newAllowed: [], maxNew: 0 }
  const design = { title: '요약', steps: [{ text: '첫째', targets: ['T1'], emphasis: null, fallback: '열기' }, { text: '둘째', targets: ['T2'], emphasis: 'outline', fallback: '열기' }], newComponents: [] }
  const seen = [], replies = [asJson(design), asJson({ ...design, steps: [{ text: 'x', targets: ['T7'], emphasis: null, fallback: 'f' }] })]
  const engine = createBriefingEngine({ outputSchema: true, runText: async (p, o) => { seen.push([p, o]); return replies.shift() } })
  assert.deepEqual(await engine(request), { title: '요약', steps: [{ text: '첫째', targets: ['T1'], fallback: '열기' }, { text: '둘째', targets: ['T2'], emphasis: 'outline', fallback: '열기' }] })
  assert.deepEqual(seen[0][1].outputSchema, designOutputSchema(request)); assert.equal(seen[0][0], designPrompt(request, ''))
  assert.equal(await engine(request), null); assert.equal(engine.stats().schemaInvalid, 1)
  assert.ok(BRIEFING_ENGINE_LIMITS.replyMax > 0 && BRIEFING_CATALOG.ids.length === 4)
})
