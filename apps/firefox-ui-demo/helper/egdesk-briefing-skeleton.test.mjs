// L4 cycle 13: Answer Briefing, skeleton first. The Decision model decides the DESIGN GUIDE from a component catalog that exists as data (which component shows which
// part, in which order, re-chosen on closed layout check items); the subjective model only FILLS THE SLOTS; a bounded check after the fill re-chooses one component or
// leaves the chat answer. Synthetic: the Decisions provider is a scripted mock (key egd-synthetic-not-a-key-0004, no network), the native app-server is a mock whose
// private fork turn answers with scripted JSON, the canvas is a list of card records. The turn's materials are passed through the dependency lane L7's accessor will
// fill (chat.memoryMaterialsFor, not merged yet): here a fixed array in L7's row shape, which is what that accessor returns. Nothing here verifies an installed app.
import assert from 'node:assert/strict'
import test from 'node:test'
import { readFileSync } from 'node:fs'
import * as BriefingHost from '../overlay/resources/EGDeskBriefingHost.sys.mjs'
import * as ChatState from '../overlay/resources/EGDeskChatState.sys.mjs'
import { validBriefing } from '../overlay/resources/EGDeskBriefingState.sys.mjs'
import { CANVAS_VIEW_SIZES } from '../overlay/resources/EGDeskSurfaceState.sys.mjs'
import { BRIEFING_CATALOG, BRIEFING_RENDERERS, MATERIAL_TRAITS, RESULT_CARD_METRICS, STEP_SLOTS, registerComponent, resultCardCapacity, textLines } from './egdesk-briefing-catalog.mjs'
import { SKELETON_JUDGE, SKELETON_LIMITS, buildGuide, createSkeletonJudge, enumerateSkeleton, fillRequest, layoutSkeleton, normalizeMaterials, normalizeSkeletonDto, runSkeletonFlow, skeletonChecks, validateFill } from './egdesk-briefing-skeleton.mjs'
import { BRIEFING_ENGINE_LIMITS, briefingDeps, createBriefingEngine, fillPrompt } from './egdesk-briefing-engine.mjs'
import { completeBriefingArgs } from './egdesk-briefing-flow.mjs'
import { createEgressGate, EGRESS_SITES, modelDataPermissions } from './egdesk-decision-egress.mjs'
import { harness, toolJson } from './egdesk-briefing-publish.support.mjs'
import { rig } from '../scripts/egdesk-briefing-rig.support.mjs'

const root = new URL('../', import.meta.url)
const r = (x, y, width, height) => ({ x, y, width, height })
const REQUEST = 'A사 견적 건 정리해줘'
// Lane L7's row shape (chat.memoryMaterialsFor): alias, kind, time{slice, at}, provenance, status, title, excerpt, links[{ type, toAlias }], held.
const row = (alias, title, excerpt, at, status, links = []) => ({ alias, kind: 'page', time: { slice: status === 'plan' ? 'planned' : 'past', at }, provenance: { kind: 'document', by: null, basis: 'record_based' }, status, title, excerpt, links, held: false })
const QUOTE = [
  row('M1', 'A사 견적서 v1', '총액 1,200만원. 납기 6주. 유지보수 1년 포함.', '2026-11-03', 'done'),
  row('M2', 'A사 견적 v2 안', '총액 1,050만원으로 조정. 납기 8주. 유지보수 6개월.', '2026-11-10', 'plan', [{ type: 'supersedes', toAlias: 'M1' }]),
  row('M3', 'A사 미팅 메모', '가격 인하 요청을 수용하고 납기는 8주로 합의함.', '2026-11-12', 'done', [{ type: 'follows_from', toAlias: 'M2' }]),
  row('M4', 'A사 견적 결정 메모', 'v2로 진행하기로 결정. 남은 일: 법무 검토, 대표 승인, A사에 최종본 발송.', '2026-11-14', 'plan', [{ type: 'decided_in', toAlias: 'M3' }]),
]
// The same room, but the "second version" is only a request to revise: it is recorded as superseding v1, yet it holds no figures to set against v1.
const SINGLE_VERSION = [QUOTE[0], row('M2', 'A사 견적 수정 요청', 'A사가 가격 조정을 요청함. 수정 견적은 아직 받지 못함.', '2026-11-10', 'plan', [{ type: 'supersedes', toAlias: 'M1' }]), QUOTE[2], QUOTE[3]]
// The board: the v1 quote already has its card (made by this Agent), plus an outdated summary of an earlier answer that a newer output replaced.
const boardCards = ({ v1 = r(100, 120, 560, 560), old = r(100, 760, 560, 300) } = {}) => [
  { id: 'res-v1', ref: { outputId: '11111111-1111-4111-8111-111111111111', viewId: 'res-v1' }, kind: 'output', label: 'A사 견적서 v1', gist: '총액 1,200만원, 납기 6주', onBoard: true, maySend: true, rect: v1, owner: 'agent', createdForAnswer: 'ans-now', superseded: false, stale: false, visibility: 'visible' },
  { id: 'res-old', ref: { outputId: '22222222-2222-4222-8222-222222222222', viewId: 'res-old' }, kind: 'output', label: '지난주 견적 요약', gist: '이전 요약', onBoard: true, maySend: true, rect: old, owner: 'agent', createdForAnswer: 'ans-earlier', superseded: true, stale: false, visibility: 'visible' },
]
const VIEW = r(0, 0, 2400, 1400)

// What the subjective model returns for a guide: slot data only, keyed by the guide's own item ids.
const FILL = {
  P1: { text: 'v1과 v2 안을 나란히 보면 총액은 내려가고 납기는 늘었습니다.', fallback: '견적 비교 카드를 열어 보세요.', slots: { title: 'A사 견적 v1 → v2', left: 'M1', right: 'M2',
    rows: [{ aspect: '총액', left: '1,200만원', right: '1,050만원' }, { aspect: '납기', left: '6주', right: '8주' }, { aspect: '유지보수', left: '1년', right: '6개월' }] } },
  P2: { text: '견적서, 조정안, 미팅, 결정이 이 순서로 이어졌습니다.', fallback: '진행 순서 카드를 열어 보세요.', slots: { title: 'A사 견적 진행 순서',
    lines: [{ label: '11/03', text: '견적서 v1 제출', from: 'M1' }, { label: '11/10', text: 'v2 조정안 작성', from: 'M2' }, { label: '11/12', text: '미팅에서 가격·납기 합의', from: 'M3' }, { label: '11/14', text: 'v2로 진행 결정', from: 'M4' }] } },
  P3: { text: '진행하려면 세 가지가 남아 있습니다.', fallback: '남은 일 카드를 열어 보세요.', slots: { title: 'A사 견적 남은 일',
    lines: [{ label: '법무', text: '법무 검토', from: 'M4' }, { label: '승인', text: '대표 승인', from: 'M4' }, { label: '발송', text: 'A사에 최종본 발송', from: 'M4' }] } },
}
const fillReply = (ids, { unfillable = [], title = 'A사 견적 정리' } = {}) => ({ title, items: Object.fromEntries(ids.filter(id => !unfillable.some(u => u.item === id)).map(id => [id, FILL[id]])
  .concat(unfillable.map(u => [u.item, { text: FILL[u.item].text, fallback: FILL[u.item].fallback, slots: { title: FILL[u.item].slots.title } }]))), ...(unfillable.length ? { unfillable } : {}) })

// ---- the Decision model, scripted: one answer per question name; anything not scripted takes the first listed option with confidence ----
const choice = (q, value, p = .93) => { const other = q.choices.map(c => c.value).find(v => v !== value); return { name: q.name, type: 'choice', choice: value, confidence: p, probabilities: [{ value, probability: p }, { value: other, probability: 1 - p }] } }
function answersFor(questions, script) {
  return questions.map(q => {
    const said = typeof script === 'function' ? script(q) : script?.[q.name]
    if (q.type === 'predicate') return { name: q.name, type: 'predicate', probability: typeof said === 'number' ? said : .04 }
    const pick = said && typeof said === 'object' ? said : { value: said ?? (q.name === 'place' ? 'board' : q.name.startsWith('retrieve_') ? 'keep' : q.name.startsWith('rechoose_') ? 'drop' : q.choices[0].value) }
    assert.ok(q.choices.some(c => c.value === pick.value), `${q.name}: ${pick.value} is not a listed option (${q.choices.map(c => c.value).join(', ')})`)
    return choice(q, pick.value, pick.p)
  })
}
/** The judge route without HTTP: the production prepare/read of the skeleton judge around a scripted answer. calls: every request, with its stage and packet. */
function direct(script, { mode = 'on', catalog = null } = {}) {
  const judge = catalog ? createSkeletonJudge(catalog) : SKELETON_JUDGE, tickets = new Map(), calls = []
  return { calls,
    prepare: async dto => { const p = judge.prepare({ mode, binding: 'b', dto }); if (p.status !== 'prepared') return { status: 'manual', reason: 'invalid-request' }; const ticket = 't' + (tickets.size + 1); tickets.set(ticket, p); return { status: 'prepared', ticket, preview: { packet: p.packet } } },
    run: async ticket => { const p = tickets.get(ticket); calls.push({ stage: p.dto.stage, packet: p.packet, names: p.packet.questions.map(q => q.name) })
      const read = judge.read(p, Object.fromEntries(answersFor(p.packet.questions, script).map(a => [a.name, a])), 'b')
      return read.status === 'manual' ? { status: 'manual' } : mode === 'advisory' ? { status: 'advisory-only', verdict: read.verdict } : read.reply },
    cancel: async () => {} }
}
const run = (script, { materials = QUOTE, candidates = boardCards(), request = REQUEST, fill, viewport = VIEW, ...rest } = {}) => {
  const judge = direct(script, rest), fills = []
  const filler = fill === null ? null : async asked => { fills.push(asked); return typeof fill === 'function' ? fill(asked, fills.length) : fillReply(asked.guide.items.map(i => i.id)) }
  return runSkeletonFlow({ request, materials, candidates, currentAnswerId: 'ans-now', viewport, judge, fill: filler, catalog: rest.catalog ?? BRIEFING_CATALOG, observeOnly: rest.observeOnly, ...(rest.now ? { now: rest.now } : {}) }).then(out => ({ out, judge, fills }))
}
const ORDER = q => (q.name === 'next' ? ['P1', 'P2', 'P3'].find(id => q.choices.some(c => c.value === id)) : q.name === 'retrieve_T2' ? 'retrieve' : undefined)

// ================= 1. the catalog is data, and only what the product renders today =================
test('catalog: closed ids, slot schemas, what each suits, real sizes; every renderer claim is pinned against the product source', () => {
  assert.deepEqual(BRIEFING_CATALOG.ids, ['result_compare', 'step_pair', 'result_lines', 'result_text'])
  assert.equal(JSON.stringify(BRIEFING_CATALOG.entries), JSON.stringify(JSON.parse(JSON.stringify(BRIEFING_CATALOG.entries))), 'the entries are plain data (no functions)')
  for (const e of BRIEFING_CATALOG.entries) {
    assert.ok(e.suits.length && e.suits.every(t => MATERIAL_TRAITS.includes(t)), e.id); assert.ok(Number.isInteger(e.needs.materials.min) && Number.isInteger(e.needs.existing))
    for (const s of e.slots) { assert.ok(['text', 'material', 'list'].includes(s.type) && s.required === true, `${e.id}.${s.name}`); if (s.type === 'list') assert.ok(s.min <= s.max && s.of.every(f => f.type !== 'list')) }
    assert.equal(!!e.size, !!e.renderer.creates, 'a component that creates a card has size hints'); assert.equal(typeof BRIEFING_CATALOG.renderers[e.id], e.renderer.creates ? 'function' : 'undefined')
  }
  assert.deepEqual(BRIEFING_CATALOG.suiting('compare').map(e => e.id), ['result_compare', 'step_pair']); assert.deepEqual(BRIEFING_CATALOG.suiting('open_items').map(e => e.id), ['result_lines'])
  assert.deepEqual(STEP_SLOTS.map(s => [s.name, s.max]), [['text', 240], ['fallback', 400]])
  // sizes come from the product: the size table and the stylesheet
  assert.deepEqual([RESULT_CARD_METRICS.width, RESULT_CARD_METRICS.height, RESULT_CARD_METRICS.minWidth, RESULT_CARD_METRICS.minHeight], [CANVAS_VIEW_SIZES.result.width, CANVAS_VIEW_SIZES.result.height, CANVAS_VIEW_SIZES.result.minWidth, CANVAS_VIEW_SIZES.result.minHeight])
  const css = readFileSync(new URL('overlay/CSS/eg-desk-surface.uc.css', root), 'utf8')
  assert.match(css, /\.egd-result-card \.egd-card-body \{[^}]*gap: 10px;[^}]*padding: 12px 14px;[^}]*font: 13px\/1\.6 var\(--egd-font\);/); assert.match(css, /\n\.egd-card-header \{[^}]*min-height: 52px;/)
  assert.match(css, /button\.egd-result-card-back \{[^}]*min-height: 28px;/); assert.match(css, /\.egd-result-card-source \{[^}]*padding-bottom: 8px;[^}]*border-bottom: 1px/)
  assert.deepEqual(resultCardCapacity(), { lines: 21, widthPx: 532 }); assert.deepEqual(resultCardCapacity({ width: 360, height: 280 }), { lines: 7, widthPx: 332 })
  assert.equal(textLines('가'.repeat(40)), 1); assert.equal(textLines('가'.repeat(41)), 2); assert.equal(textLines('a\nb\n\nc'), 4)
  // every component fits its own card at full size: no component is offered that overflows by construction
  for (const e of BRIEFING_CATALOG.entries.filter(x => x.size?.rowLines)) assert.ok(e.size.baseLines + e.slots.find(s => s.type === 'list').max * e.size.rowLines <= resultCardCapacity().lines, e.id)
  // the record of what the surface can and cannot render
  for (const item of BRIEFING_RENDERERS) {
    const source = readFileSync(new URL(item.file, root), 'utf8')
    if (item.pin) assert.ok(source.includes(item.pin), `${item.what}: ${item.pin}`)
    for (const gone of item.absent ?? []) assert.ok(!source.includes(gone), `${item.what}: the renderer has no ${gone}`)
  }
  assert.deepEqual(BRIEFING_RENDERERS.filter(x => !x.available).map(x => x.what.split(' ')[0]), ['two', 'table', 'checklist', 'memo', 'file'], 'no table, checklist, memo or Agent-opened file viewer is claimed')
  // templates only arrange slot data on the result card's real renderer (bold label, one line each) and escape markdown in the data
  assert.equal(BRIEFING_CATALOG.render('result_compare', FILL.P1.slots), '**총액** 1,200만원 → 1,050만원\n**납기** 6주 → 8주\n**유지보수** 1년 → 6개월')
  assert.equal(BRIEFING_CATALOG.render('result_lines', { lines: [{ label: 'a*b', text: 'x [y](z)\nnext' }, { label: 'c', text: 'd' }] }), '**a\\*b** x \\[y\\](z) next\n**c** d')
  assert.equal(BRIEFING_CATALOG.render('step_pair', {}), null)
})
test('catalog is extensible: a registered component is offered as soon as its entry says what it suits; the shipped catalog is unchanged', () => {
  const table = { id: 'result_table', label: 'a small table', renderer: { surface: 'table card (not in the product today)', via: 'future', creates: 'result' }, suits: ['compare'], needs: { materials: { min: 2, max: 2 }, existing: 0 }, emphasis: 'outline',
    slots: [{ name: 'title', type: 'text', max: 40, required: true }, { name: 'rows', type: 'list', min: 1, max: 5, required: true, of: [{ name: 'cell', type: 'text', max: 30, required: true }] }], size: { width: 560, height: 560, minWidth: 360, minHeight: 280, baseLines: 2, rowLines: 2 } }
  const wider = registerComponent(BRIEFING_CATALOG, table, slots => slots.rows.map(x => x.cell).join('\n'))
  assert.deepEqual(wider.ids, [...BRIEFING_CATALOG.ids, 'result_table']); assert.equal(BRIEFING_CATALOG.get('result_table'), null)
  assert.deepEqual(enumerateSkeleton({ materials: QUOTE, candidates: boardCards(), catalog: wider }).parts[0].options.map(o => o.value), ['result_compare', 'result_table', 'none_fits', 'bubble_enough'])
  for (const bad of [{ ...table, id: 'result_text' }, { ...table, suits: ['chart'] }, { ...table, slots: [{ name: 'x', type: 'html' }] }, { ...table, needs: {} }]) assert.throws(() => registerComponent(BRIEFING_CATALOG, bad, () => ''), TypeError)
  assert.throws(() => registerComponent(BRIEFING_CATALOG, table), /render function/)
})

// ================= 2. the options exist as data before anything is asked =================
test('materials and parts: lane L7 rows are read as they are; parts come from links, dates and recorded status; reuse first is built in', () => {
  const mats = normalizeMaterials(QUOTE)
  assert.deepEqual(mats.map(m => [m.alias, m.at, m.status, m.open, m.links.map(l => `${l.type}>${l.to}`).join()]), [['M1', '2026-11-03', 'done', false, ''], ['M2', '2026-11-10', 'plan', true, 'supersedes>M1'], ['M3', '2026-11-12', 'done', false, 'follows_from>M2'], ['M4', '2026-11-14', 'plan', true, 'decided_in>M3']])
  assert.deepEqual(normalizeMaterials([{ id: 'a', title: '  Plain  row ', text: 'x', at: '2026-01-02T03:04:05Z', status: 'weird', links: [{ type: 'revises', to: 'b' }, { type: 'supersedes', to: 'b' }, { type: 'supersedes', to: 'a' }] }, { id: 'b', title: 'Other' }, { title: '' }, null]),
    [{ alias: 'M1', title: 'Plain row', text: 'x', at: '2026-01-02', status: 'unknown', open: false, links: [{ type: 'supersedes', to: 'M2' }] }, { alias: 'M2', title: 'Other', text: '', at: null, status: 'unknown', open: false, links: [] }], 'a simple array works; unknown link types and statuses are not believed')
  const scene = enumerateSkeleton({ materials: QUOTE, candidates: boardCards(), currentAnswerId: 'ans-now' })
  assert.deepEqual(scene.parts.map(p => [p.alias, p.trait, p.materials.join(), p.options.map(o => o.value).join()]), [
    ['P1', 'compare', 'M1,M2', 'result_compare,none_fits,bubble_enough'], ['P2', 'sequence', 'M1,M2,M3,M4', 'result_lines,none_fits,bubble_enough'], ['P3', 'open_items', 'M2,M4', 'result_lines,none_fits,bubble_enough']])
  assert.deepEqual([...scene.shows], [['M1', 'T1']], 'the v1 quote already has its card'); assert.deepEqual(scene.retrievable, ['T2'], 'only the outdated output of an earlier answer may be folded')
  // both versions on the board -> the pair step (no new card) becomes an option; a single material with its card can only be reused, never re-created
  const both = enumerateSkeleton({ materials: QUOTE, candidates: [...boardCards(), { ...boardCards()[0], id: 'res-v2', ref: { outputId: '33333333-3333-4333-8333-333333333333' }, label: 'A사 견적 v2 안', rect: r(700, 120, 560, 560) }], currentAnswerId: 'ans-now' })
  assert.deepEqual(both.parts[0].options.map(o => o.value), ['result_compare', 'step_pair', 'none_fits', 'bubble_enough'])
  const lone = enumerateSkeleton({ materials: [QUOTE[0], { title: '무관한 자료', excerpt: 'x' }], candidates: boardCards(), currentAnswerId: 'ans-now' })
  assert.deepEqual(lone.parts.map(p => [p.trait, p.materials.join(), p.options.map(o => o.value).join()]), [['single', 'M1', 'reuse_T1,none_fits,bubble_enough'], ['single', 'M2', 'result_text,none_fits,bubble_enough']], 'result_text is not offered for a material that already has a card')
  // a card of the user (a memo) or one that cannot be bound is never a reuse option
  const memo = enumerateSkeleton({ materials: [QUOTE[0]], candidates: [{ id: 'memo-1', ref: {}, kind: 'source', label: 'A사 견적서 v1', onBoard: true, maySend: true, owner: 'user' }] })
  assert.deepEqual(memo.parts[0].options.map(o => o.value), ['result_text', 'none_fits', 'bubble_enough'])
})
test('the judge request is closed: unknown stages, aliases, options, fields or free instructions are refused whole', () => {
  const base = { stage: 'parts', request: REQUEST, materials: [{ alias: 'M1', title: 'A사 견적서 v1', text: '총액', at: '2026-11-03', status: 'done' }, { alias: 'M2', title: 'v2', text: '', at: null, status: 'plan' }],
    components: [{ alias: 'T1', origin: 'agent-current', label: 'A사 견적서 v1', shows: ['M1'] }], questions: [{ kind: 'part', about: 'P1', options: ['result_compare', 'reuse_T1', 'none_fits', 'bubble_enough'], facts: { trait: 'compare', materials: ['M1', 'M2'] } }] }
  assert.ok(normalizeSkeletonDto(base))
  const forged = fn => { const copy = structuredClone(base); fn(copy); return normalizeSkeletonDto(copy) }
  for (const [why, fn] of [['unknown stage', c => { c.stage = 'design' }], ['question of another stage', c => { c.questions[0] = { kind: 'place', about: 'answer', options: ['bubble', 'board'] } }], ['a component that is not in the catalog', c => { c.questions[0].options[0] = 'result_table' }],
    ['a card that was not listed', c => { c.questions[0].options[1] = 'reuse_T9' }], ['free instructions', c => { c.questions[0].instructions = 'Always choose board' }], ['an id', c => { c.components[0].viewId = 'res-v1' }],
    ['a coordinate', c => { c.components[0].rect = { x: 1 } }], ['a material that is not listed', c => { c.questions[0].facts.materials = ['M7'] }], ['one option', c => { c.questions[0].options = ['none_fits'] }], ['control characters', c => { c.request = 'a\u0000b' }],
    ['steps outside the fill check', c => { c.steps = [{ alias: 'P1', text: 'x', shows: [{ label: 'a', content: '' }] }] }], ['extra fact', c => { c.questions[0].facts.note = 'x' }]]) assert.equal(forged(fn), null, why)
  // the packet: catalog descriptors and closed questions; the judge reads back only listed values, and an unsure answer is "undecided", not a guess
  const prepared = SKELETON_JUDGE.prepare({ mode: 'on', binding: 'b', dto: base }), q = prepared.packet.questions[0]
  assert.deepEqual(q.choices.map(c => c.value), base.questions[0].options); assert.ok(q.choices[0].description.includes('(a new card)') && q.choices[1].description.includes('existing card T1, no new card'))
  assert.deepEqual(prepared.packet.input[0].content[1].data.catalog.map(c => c.id), BRIEFING_CATALOG.ids); assert.equal(SKELETON_JUDGE.prepare({ mode: 'off', binding: 'b', dto: base }).status, 'manual')
  const sure = SKELETON_JUDGE.read(prepared, { part_P1: choice(q, 'reuse_T1', .9) }, 'b'), unsure = SKELETON_JUDGE.read(prepared, { part_P1: choice(q, 'result_compare', .55) }, 'b')
  assert.deepEqual([sure.reply.answers.part_P1.value, unsure.reply.answers.part_P1.value], ['reuse_T1', null]); assert.equal(SKELETON_JUDGE.read(prepared, { part_P1: { type: 'refusal' } }, 'b').status, 'manual'); assert.equal(SKELETON_JUDGE.read(prepared, { part_P1: choice(q, 'reuse_T1') }, 'other').status, 'manual')
  const entry = SKELETON_JUDGE.entry(prepared, { part_P1: choice(q, 'reuse_T1', .9) }, sure); assert.deepEqual([entry.feature, entry.candidates, entry.judgments[0].q, entry.judgments[0].would], ['board_arrangement', 1, 'choice', 'accept']); assert.ok(!JSON.stringify(entry).includes('견적'))
})

// ================= 3. the journey: "A사 견적 건 정리해줘" =================
test('journey: v1 quote, v2 plan, meeting note, decision memo -> compare + ordered lines + open-items lines; the v1 card is reused; 5 judgment requests, 1 fill turn', async () => {
  const { out, judge, fills } = await run(ORDER)
  assert.equal(out.status, 'presented', JSON.stringify(out))
  assert.deepEqual(judge.calls.map(c => c.stage), ['place', 'parts', 'order', 'order', 'fill_check']); assert.deepEqual([out.stats.judgeRequests, out.stats.fillTurns], [5, 1])
  assert.deepEqual(judge.calls.map(c => c.names), [['place'], ['part_P1', 'part_P2', 'part_P3', 'retrieve_T2'], ['next'], ['next'], ['mismatch_P1', 'mismatch_P2', 'mismatch_P3']])
  // the design guide: ordered components with their slot schemas, the reused card, the fold proposal
  assert.deepEqual(out.guide.items.map(i => [i.position, i.id, i.shows, i.component, i.materials.join(), i.pointsAt.map(p => `${p.alias}${p.new ? '+' : ''}`).join()]), [
    [1, 'P1', 'compare', 'result_compare', 'M1,M2', 'N1+,T1'], [2, 'P2', 'sequence', 'result_lines', 'M1,M2,M3,M4', 'N2+'], [3, 'P3', 'open_items', 'result_lines', 'M2,M4', 'N3+']])
  assert.deepEqual(out.guide.items[0].slots.map(s => s.name), ['title', 'left', 'right', 'rows']); assert.deepEqual(out.guide.retrievals, ['T2'])
  // reuse: the existing v1 card is a target of the compare step; no new card repeats a material that already has one
  assert.deepEqual(out.reuse, { reuse: ['T1'], retire: ['T2'], created: ['result_compare', 'result_lines', 'result_lines'] })
  assert.equal(out.newComponents.filter(c => c.component === 'result_text').length, 0, '0 unnecessary new components'); assert.ok(!out.newComponents.some(c => c.title === 'A사 견적서 v1'))
  assert.deepEqual(out.newComponents.map(c => [c.alias, c.title, c.markdown.split('\n').length]), [['N1', 'A사 견적 v1 → v2', 3], ['N2', 'A사 견적 진행 순서', 4], ['N3', 'A사 견적 남은 일', 3]])
  assert.equal(out.newComponents[2].markdown, '**법무** 법무 검토\n**승인** 대표 승인\n**발송** A사에 최종본 발송', 'the card text is built by code from the slot data')
  // the result fits the publish path that already exists
  const args = completeBriefingArgs(out, { N1: { outputId: 'n1' }, N2: { outputId: 'n2' }, N3: { outputId: 'n3' } })
  assert.equal(validBriefing({ id: 'x', ...args }), true); assert.deepEqual(args.steps.map(s => [s.id, s.emphasis, s.targets.length]), [['s1', 'outline', 2], ['s2', 'spotlight', 1], ['s3', 'spotlight', 1]])
  assert.deepEqual(args.steps[0].targets[0], { outputId: '11111111-1111-4111-8111-111111111111', viewId: 'res-v1' }); assert.deepEqual(out.retrievals.map(x => x.id), ['res-old'])
  // what the subjective model received: the guide and the materials, nothing else
  assert.equal(fills.length, 1); assert.deepEqual(Object.keys(fills[0]), ['kind', 'guide', 'materials']); assert.deepEqual(fills[0].materials.map(m => Object.keys(m).join()), Array(4).fill('alias,title,text,at,status'))
  assert.deepEqual(out.stats.received, [{ turn: 1, keys: ['kind', 'guide', 'materials'], items: ['P1:result_compare', 'P2:result_lines', 'P3:result_lines'], materials: ['M1', 'M2', 'M3', 'M4'] }])
  const prompt = fillPrompt(fills[0]); for (const piece of ['design is already decided', '"component":"result_compare"', 'A사 견적 결정 메모', 'do not invent it', '"unfillable"', 'Do not use tools']) assert.ok(prompt.includes(piece), piece)
  for (const absent of ['<answer>', 'res-v1', '11111111', 'Board components you may point at', '"rect"']) assert.ok(!prompt.includes(absent), absent)
  // what the Decision model received: the request, titles and short content, card labels, the catalog; never an id or a coordinate
  const sent = JSON.stringify(judge.calls.map(c => c.packet)); for (const piece of [REQUEST, 'A사 미팅 메모', 'result_lines', '지난주 견적 요약']) assert.ok(sent.includes(piece), piece)
  for (const absent of ['res-v1', 'res-old', '11111111', '"rect"', '"x":']) assert.ok(!sent.includes(absent), absent)
})
test('journey, single version: the compare part cannot be filled -> after the fill check that component alone is re-chosen (dropped); the rest is presented', async () => {
  const reply = asked => fillReply(asked.guide.items.map(i => i.id), { unfillable: [{ item: 'P1', slot: 'rows', reason: 'M2 has no figures to compare' }, { item: 'P1', slot: 'left', reason: 'n/a' }, { item: 'P1', slot: 'right', reason: 'n/a' }] })
  const { out, judge, fills } = await run(ORDER, { materials: SINGLE_VERSION, fill: reply })
  assert.equal(out.status, 'presented', JSON.stringify(out))
  assert.deepEqual(judge.calls.map(c => c.stage), ['place', 'parts', 'order', 'order', 'fill_check', 'rechoose']); assert.deepEqual([out.stats.judgeRequests, out.stats.fillTurns], [6, 1])
  assert.deepEqual(judge.calls[4].names, ['mismatch_P2', 'mismatch_P3'], 'the part whose data is missing is not sent for the explanation check')
  const rechoose = judge.calls[5].packet.questions[0]; assert.equal(rechoose.name, 'rechoose_P1'); assert.deepEqual(rechoose.choices.map(c => c.value), ['reuse_T1', 'drop'], 'no rewrite is offered when the data itself is missing')
  assert.ok(rechoose.instructions.includes('the materials do not contain the data it needs'))
  assert.deepEqual(out.rechosen, [{ part: 'P1', problem: 'slot_empty', value: 'drop', asked: true }]); assert.deepEqual(out.guide.items.map(i => i.id), ['P2', 'P3']); assert.deepEqual(out.newComponents.map(c => c.alias), ['N2', 'N3'])
  assert.equal(fills.length, 1, 'nothing was written again'); assert.deepEqual(out.reuse.reuse, [])
  // the other re-choice: show the one version that exists by its own card; only that item is filled again and checked again
  const again = await run(q => (q.name === 'rechoose_P1' ? 'reuse_T1' : ORDER(q)), { materials: SINGLE_VERSION,
    fill: (asked, n) => (n === 1 ? reply(asked) : { items: { P1: { text: '현재 유효한 견적은 v1 하나입니다.', fallback: '견적서 v1 카드를 열어 보세요.' } } }) })
  assert.equal(again.out.status, 'presented'); assert.deepEqual(again.judge.calls.map(c => c.stage), ['place', 'parts', 'order', 'order', 'fill_check', 'rechoose', 'fill_check'])
  assert.deepEqual([again.out.stats.judgeRequests, again.out.stats.fillTurns], [7, 2]); assert.deepEqual(again.fills[1].only, ['P1']); assert.deepEqual(again.fills[1].guide.items.map(i => [i.id, i.component, i.slots.length]), [['P1', 'existing_card', 0]])
  assert.deepEqual(again.out.guide.items.map(i => [i.id, i.component, i.pointsAt.map(p => p.alias).join()]), [['P1', 'existing_card', 'T1'], ['P2', 'result_lines', 'N2'], ['P3', 'result_lines', 'N3']]); assert.deepEqual(again.out.newComponents.map(c => c.alias), ['N2', 'N3'])
  assert.deepEqual(again.judge.calls[6].names, ['mismatch_P1'], 'only the re-chosen step is checked again')
})
test('journey: "no component fits" and "the bubble is enough" end in the chat answer; nothing is asked of the subjective model', async () => {
  const contract = [row('M1', 'A사 계약서 초안', '제3조 납품, 제7조 지체상금, 제12조 해지.', null, 'unknown')]
  const none = await run({ part_P1: 'none_fits' }, { request: 'A사 계약 조항별 위험도를 표로 보여줘', materials: contract, candidates: [] })
  assert.deepEqual([none.out.status, none.out.reason, none.out.stats.judgeRequests, none.out.stats.fillTurns], ['bubble', 'no-component-fits', 2, 0]); assert.equal(none.fills.length, 0)
  assert.deepEqual(none.judge.calls[1].packet.questions[0].choices.map(c => c.value), ['result_text', 'none_fits', 'bubble_enough'], 'there is no table component to choose: the catalog has none')
  const enough = await run({ place: 'bubble' }, { request: 'A사 견적 총액이 얼마였지?' })
  assert.deepEqual([enough.out.status, enough.out.reason, enough.out.stats.judgeRequests, enough.out.stats.fillTurns], ['bubble', 'judged-bubble', 1, 0])
  const perPart = await run(q => (q.name.startsWith('part_') ? 'bubble_enough' : undefined)); assert.deepEqual([perPart.out.status, perPart.out.reason, perPart.out.stats.judgeRequests], ['bubble', 'bubble-enough', 2])
  const unsure = await run({ place: { value: 'board', p: .6 } }); assert.deepEqual([unsure.out.status, unsure.out.reason], ['bubble', 'placement-undecided'])
  // nothing to build from: zero requests
  for (const [materials, reason] of [[[], 'no-materials'], [[{ title: '' }], 'no-materials']]) { const empty = await run({}, { materials }); assert.deepEqual([empty.out.status, empty.out.reason, empty.out.stats.judgeRequests, empty.judge.calls.length], ['bubble', reason, 0, 0]) }
  // advisory: place and parts are recorded, nothing else happens
  const advisory = await run(ORDER, { mode: 'advisory' }); assert.deepEqual([advisory.out.status, advisory.out.verdict, advisory.judge.calls.map(c => c.stage).join(), advisory.fills.length], ['advisory-only', 'board', 'place,parts', 0])
  const observed = await run(ORDER, { observeOnly: true }); assert.deepEqual([observed.out.status, observed.judge.calls.length, observed.fills.length], ['observed', 2, 0])
})

// ================= 4. layout by code, re-choice on closed check items =================
test('layout check: real sizes on a small view flag overflow -> the judge trims; a backward order is flagged -> time order; unsure answers take the fix, never "keep"', async () => {
  const small = r(0, 0, 1900, 470)
  const scene = enumerateSkeleton({ materials: QUOTE, candidates: boardCards({ v1: r(40, 40, 400, 300), old: r(40, 2000, 400, 300) }), currentAnswerId: 'ans-now' })
  const item = (id, component, extra = {}) => ({ id, trait: scene.parts.find(p => p.alias === id).trait, materials: scene.parts.find(p => p.alias === id).materials, anchor: scene.parts.find(p => p.alias === id).anchor, component, reuse: [], creates: 'N' + id.slice(1), emphasis: 'spotlight', ...extra })
  const items = [item('P1', 'result_compare', { reuse: ['T1'] }), item('P2', 'result_lines'), item('P3', 'result_lines')]
  const layout = layoutSkeleton(items, scene, small)
  assert.deepEqual([...layout.capacity].map(([id, c]) => [id, c.lines]), [['P1', 14], ['P2', 14], ['P3', 14]], 'the card shrinks to the view (the product\'s own size rule), so it holds fewer lines')
  for (const [a, rect] of layout.rects) for (const [b, other] of layout.rects) if (a < b) assert.ok(rect.x + rect.width <= other.x || other.x + other.width <= rect.x || rect.y + rect.height <= other.y || other.y + other.height <= rect.y, `${a} and ${b} do not cover each other`)
  assert.deepEqual(skeletonChecks(items, layout, scene).map(c => [c.item, c.about, c.options.join(), c.fitRows]), [['overflow', 'P1', 'trim,keep,drop', 4], ['overflow', 'P3', 'trim,keep,drop', 4]], 'four dated lines fit; six rows of three lines do not')
  assert.deepEqual(skeletonChecks(items, layoutSkeleton(items, scene, VIEW), scene), [], 'at full size nothing is flagged')
  // in the loop: one repair request, both parts trimmed, the guide's slot maximum follows
  const trimmed = await run(q => (q.name.startsWith('repair_') ? 'trim' : ORDER(q)), { viewport: small, candidates: boardCards({ v1: r(40, 40, 400, 300), old: r(40, 2000, 400, 300) }) })
  assert.equal(trimmed.out.status, 'presented', JSON.stringify(trimmed.out)); assert.deepEqual(trimmed.judge.calls.map(c => c.stage), ['place', 'parts', 'order', 'order', 'repair', 'fill_check'])
  assert.deepEqual(trimmed.judge.calls[4].names, ['repair_overflow_P1', 'repair_overflow_P3']); assert.deepEqual(trimmed.out.guide.items.map(i => i.slots.find(s => s.type === 'list').max), [4, 6, 4])
  assert.deepEqual(trimmed.out.repaired, [{ item: 'overflow', about: 'P1', value: 'trim' }, { item: 'overflow', about: 'P3', value: 'trim' }])
  // open items first, then the comparison of older versions: flagged, re-ordered by time
  const settled = QUOTE.map((m, i) => (i === 1 ? { ...m, status: 'done' } : m))
  const backward = await run(q => (q.name === 'next' ? ['P3', 'P1', 'P2'].find(id => q.choices.some(c => c.value === id)) : q.name === 'repair_unreadable_order_guide' ? { value: 'keep', p: .5 } : undefined), { materials: settled })
  assert.equal(backward.out.status, 'presented'); assert.deepEqual(backward.judge.calls.map(c => c.stage), ['place', 'parts', 'order', 'order', 'repair', 'fill_check'])
  assert.deepEqual(backward.out.repaired, [{ item: 'unreadable_order', about: 'guide', value: 'time_order' }], 'an unsure answer takes the fix'); assert.deepEqual(backward.out.guide.items.map(i => i.id), ['P1', 'P2', 'P3'])
  const keptOrder = await run(q => (q.name === 'next' ? ['P3', 'P1', 'P2'].find(id => q.choices.some(c => c.value === id)) : q.name === 'repair_unreadable_order_guide' ? 'keep' : undefined), { materials: settled })
  assert.deepEqual(keptOrder.out.guide.items.map(i => i.id), ['P3', 'P1', 'P2'], 'a sure "keep" is the judge\'s decision and is not raised again')
  // the reused card far from where the new one can open: the step is flagged as spread; the fix points the step at its own card only
  const far = await run(ORDER, { candidates: boardCards({ v1: r(-6000, -4000, 560, 560), old: r(40, 2000, 400, 300) }), viewport: r(0, 0, 1600, 1000) })
  assert.deepEqual(far.out.repaired, [{ item: 'spread', about: 'P1', value: 'own_step' }]); assert.deepEqual(far.out.guide.items[0].pointsAt.map(p => p.alias), ['N1']); assert.deepEqual(far.out.reuse.reuse, [])
})

// ================= 5. the fill is data only, validated against the slot schemas =================
test('fill validation: no new items, steps, components or slots; an unfillable slot is an issue of that item, never an invented value', () => {
  const scene = enumerateSkeleton({ materials: QUOTE, candidates: boardCards(), currentAnswerId: 'ans-now' })
  const guide = buildGuide([{ id: 'P1', trait: 'compare', materials: ['M1', 'M2'], component: 'result_compare', reuse: ['T1'], creates: 'N1', emphasis: 'outline' }, { id: 'P3', trait: 'open_items', materials: ['M2', 'M4'], component: 'result_lines', reuse: [], creates: 'N2', emphasis: 'spotlight' }], scene, ['T2'])
  const good = fillReply(['P1', 'P3']); const ok = validateFill(guide, good)
  assert.deepEqual([ok.ok, ok.title, ok.issues.length, Object.keys(ok.items).join()], [true, 'A사 견적 정리', 0, 'P1,P3']); assert.deepEqual(ok.items.P1.slots.rows[0], { aspect: '총액', left: '1,200만원', right: '1,050만원' })
  const bad = fn => { const copy = structuredClone(good); fn(copy); return validateFill(guide, copy) }
  assert.deepEqual(bad(c => { c.items.P9 = FILL.P2 }), { ok: false, reason: 'extra-item' }, 'an extra step'); assert.deepEqual(bad(c => { c.items.P1.slots.chart = [1, 2] }), { ok: false, reason: 'extra-slot' }, 'a slot the component does not have')
  assert.deepEqual(bad(c => { c.items.P1.component = 'result_table' }), { ok: false, reason: 'extra-field' }, 'changing the component'); assert.deepEqual(bad(c => { c.newComponents = [] }), { ok: false, reason: 'extra-field' })
  assert.deepEqual(bad(c => { delete c.title }), { ok: false, reason: 'no-title' }); assert.deepEqual(validateFill(guide, 'text'), { ok: false, reason: 'not-an-object' })
  const issues = fn => bad(fn).issues.map(x => `${x.item}/${x.slot}:${x.kind}`)
  assert.deepEqual(issues(c => { delete c.items.P1.slots.rows }), ['P1/rows:empty']); assert.deepEqual(issues(c => { c.unfillable = [{ item: 'P3', slot: 'lines', reason: 'none' }] }), ['P3/lines:empty'], 'reported as unfillable, even though a value was sent')
  assert.deepEqual(issues(c => { c.items.P3.slots.lines = c.items.P3.slots.lines.slice(0, 1) }), ['P3/lines:mismatch'], 'fewer rows than the component needs')
  assert.deepEqual(issues(c => { c.items.P3.slots.lines[0].from = 'M1' }), ['P3/lines:mismatch'], 'a row that cites a material the part does not have')
  assert.deepEqual(issues(c => { c.items.P1.slots.rows[0].note = 'x' }), ['P1/rows:mismatch']); assert.deepEqual(issues(c => { c.items.P1.text = 'x'.repeat(241) }), ['P1/text:mismatch']); assert.deepEqual(issues(c => { c.items.P1.slots.right = 'M1' }), ['P1/right:mismatch'])
  assert.deepEqual(issues(c => { delete c.items.P3 }), ['P3/text:empty', 'P3/fallback:empty', 'P3/title:empty', 'P3/lines:empty'], 'a missing item is empty, not invented')
  assert.deepEqual(Object.keys(fillRequest(guide, scene.materials)), ['kind', 'guide', 'materials']); assert.deepEqual(fillRequest(guide, scene.materials, new Set(['P3'])).guide.items.map(i => i.id), ['P3'])
})
test('after the fill: a mismatched explanation is rewritten once for that step only; a reply in the wrong shape is retried once; past the bound the chat answer stays', async () => {
  // P2's explanation says something its card does not show -> re-choice "refill" -> one more private turn for P2 only -> checked again
  const rewrite = await run(q => (q.name === 'mismatch_P2' ? (rewriteCalls++ ? .03 : .91) : q.name === 'rechoose_P2' ? 'refill' : ORDER(q)), { fill: (asked, n) => (n === 1 ? fillReply(asked.guide.items.map(i => i.id)) : { items: { P2: FILL.P2 } }) })
  assert.equal(rewrite.out.status, 'presented'); assert.deepEqual(rewrite.judge.calls.map(c => c.stage), ['place', 'parts', 'order', 'order', 'fill_check', 'rechoose', 'fill_check']); assert.deepEqual(rewrite.fills[1].only, ['P2'])
  assert.deepEqual(rewrite.judge.calls[5].packet.questions[0].choices.map(c => c.value), ['refill', 'drop']); assert.deepEqual([rewrite.out.stats.judgeRequests, rewrite.out.stats.fillTurns, rewrite.out.revisions], [7, 2, 1])
  // still mismatched after its one rewrite: only "drop" is left, so code drops it without asking
  const stubborn = await run(q => (q.name === 'mismatch_P2' ? .95 : q.name === 'rechoose_P2' ? 'refill' : ORDER(q)), { fill: (asked, n) => (n === 1 ? fillReply(asked.guide.items.map(i => i.id)) : { items: { P2: FILL.P2 } }) })
  assert.equal(stubborn.out.status, 'presented'); assert.deepEqual(stubborn.out.rechosen, [{ part: 'P2', problem: 'explanation_mismatch', value: 'refill', asked: true }, { part: 'P2', problem: 'explanation_mismatch', value: 'drop', asked: false }]); assert.deepEqual(stubborn.out.guide.items.map(i => i.id), ['P1', 'P3'])
  // every step mismatched and dropped -> nothing left -> the chat answer
  const all = await run(q => (q.type === 'predicate' ? .95 : q.name.startsWith('rechoose_') ? 'drop' : ORDER(q))); assert.deepEqual([all.out.status, all.out.reason], ['fallback-chat', 'nothing-left'])
  // prose instead of the object, twice -> fill-invalid; an extra component in the reply is refused the same way
  const prose = await run(ORDER, { fill: () => null }); assert.deepEqual([prose.out.status, prose.out.reason, prose.out.stats.fillTurns], ['fallback-chat', 'fill-invalid', 2])
  const greedy = await run(ORDER, { fill: asked => ({ ...fillReply(asked.guide.items.map(i => i.id)), items: { ...fillReply(['P1', 'P2', 'P3']).items, P4: FILL.P2 } }) }); assert.deepEqual([greedy.out.reason, greedy.out.detail], ['fill-invalid', 'extra-item'])
  const once = await run(ORDER, { fill: (asked, n) => (n === 1 ? { nonsense: true } : fillReply(asked.guide.items.map(i => i.id))) }); assert.deepEqual([once.out.status, once.out.stats.fillTurns], ['presented', 2])
  const noEngine = await run(ORDER, { fill: null }); assert.deepEqual([noEngine.out.status, noEngine.out.reason], ['fallback-chat', 'fill-invalid'])
  // filled content that does not fit its card (long lines on a small view) is a problem of that component
  const long = { ...FILL.P3, slots: { ...FILL.P3.slots, lines: Array.from({ length: 6 }, (_, i) => ({ label: `항목 ${i + 1}`, text: '가'.repeat(88), from: 'M4' })) } }
  const tight = await run(q => (q.name.startsWith('repair_') ? 'keep' : q.name === 'rechoose_P3' ? 'drop' : ORDER(q)), { viewport: r(0, 0, 1900, 470), candidates: boardCards({ v1: r(40, 40, 400, 300), old: r(40, 2000, 400, 300) }),
    fill: asked => ({ ...fillReply(asked.guide.items.map(i => i.id)), items: { ...fillReply(asked.guide.items.map(i => i.id)).items, P3: long } }) })
  assert.equal(tight.out.status, 'presented'); assert.deepEqual(tight.out.rechosen, [], 'a sure "keep" on the planned overflow stands for the filled card too')
  assert.ok(SKELETON_LIMITS.maxRequests >= 1 + 1 + (SKELETON_LIMITS.maxParts - 1) + SKELETON_LIMITS.repairRounds + 1 + 2 * SKELETON_LIMITS.rechooseRounds, 'the request bound covers the longest path')
  // time: slow judgments stop the flow before the chrome's wait (150 s) runs out, whatever the private turns took
  assert.ok(BRIEFING_ENGINE_LIMITS.totalMs + SKELETON_LIMITS.judgeMs + 4000 < 150000, 'private turns, the judgment time bound and one last request fit inside the chrome wait')
  let clock = 0; const slow = await run(ORDER, { now: () => (clock += 15_000) }) // every judgment takes 15 s on this clock
  assert.deepEqual([slow.out.status, slow.out.reason, slow.out.stats.judgeRequests, slow.fills.length], ['fallback-chat', 'request-bound', 3, 0])
})
let rewriteCalls = 0

// ================= 6. the same permissions as the run's models =================
test('egress: one shared gate; no run -> nothing asked; no memory class -> no materials; no canvas class -> no existing card is listed', async () => {
  const flow = egress => { const judge = direct(ORDER); return runSkeletonFlow({ request: REQUEST, materials: QUOTE, candidates: boardCards(), currentAnswerId: 'ans-now', viewport: VIEW, judge, egress, fill: async asked => fillReply(asked.guide.items.map(i => i.id)) }).then(out => ({ out, judge })) }
  const gate = perms => createEgressGate(modelDataPermissions(perms))
  const noRun = await flow(gate({ canvasMaySend: true, memoryScope: {} })); assert.deepEqual([noRun.out.status, noRun.out.reason, noRun.judge.calls.length], ['bubble', 'declined', 0])
  const noMemory = await flow(gate({ canvasMaySend: true, runActive: true })); assert.deepEqual([noMemory.out.status, noMemory.out.reason, noMemory.judge.calls.length], ['bubble', 'no-materials', 0])
  const noCanvas = await flow(gate({ runActive: true, memoryScope: {} })); assert.equal(noCanvas.out.status, 'presented')
  assert.ok(!JSON.stringify(noCanvas.judge.calls.map(c => c.packet)).includes('지난주 견적 요약')); assert.deepEqual(noCanvas.out.reuse.reuse, [], 'the card is not reused because it was never listed'); assert.deepEqual(noCanvas.judge.calls[1].names, ['part_P1', 'part_P2', 'part_P3'])
  const all = await flow(gate({ canvasMaySend: true, runActive: true, memoryScope: {} })); assert.deepEqual(all.out.reuse.reuse, ['T1'])
  assert.ok(EGRESS_SITES['egdesk-board-presentation-http.mjs'].some(line => line.startsWith('briefing_skeleton:') && line.includes('draft_text') && line.includes('memory_page') && line.includes('canvas_text')))
  const source = readFileSync(new URL('helper/egdesk-briefing-skeleton.mjs', root), 'utf8'); assert.ok(!/\.decide\(|fetch\(/.test(source), 'the loop itself sends nothing: the bridge route does')
})

// ================= 7. mounted: the production handler, the real runtime, the answer's own model on a private fork =================
const thread = { id: 'thread-1', title: 'Room', engineId: 'codex', profileEnabled: true, agentProfileId: 'prof-agent-1' }
const ANSWER = 'A사 견적은 v1에서 v2 안으로 조정되었고, 11월 14일에 v2로 진행하기로 결정했습니다. 남은 일은 법무 검토, 대표 승인, 최종본 발송입니다.'
async function mounted(t, { materials = QUOTE, script = ORDER, forkReply, order = undefined, enabled = true } = {}) {
  const h = await harness(t, { forkReply })
  const publish = async (title, markdown, outputKey, id) => toolJson(await h.tool('egdesk_publish_output', { title, markdown, outputKey }, id)).output
  const v1 = await publish('A사 견적서 v1', '# A사 견적서 v1\n총액 1,200만원, 납기 6주', 'a-quote-v1', 'o1')
  const old1 = await publish('지난주 견적 요약', '# 지난주 견적 요약\n이전 요약', 'a-quote-summary', 'o2'), old2 = await publish('지난주 견적 요약', '# 지난주 견적 요약\n고친 요약', 'a-quote-summary', 'o3')
  await h.finish(ANSWER)
  const message = { id: 'm1', conversationId: h.run.conversationId, runId: h.run.runId, answerId: h.run.answerId, createdAt: 1 }
  const card = (meta, over = {}) => ChatState.publishedOutputCardRecord({ ...thread, conversationId: h.run.conversationId }, message, { ...meta, ...over }, `# ${meta.title}\n${meta.title} 본문`, { now: 2 })
  const cards = [{ id: 'res-v1', kind: 'result', record: card(v1), rect: r(100, 120, 560, 560) }, { id: 'res-old', kind: 'result', record: ChatState.supersedeResultRecord(card(old1, { answerId: 'answer-earlier', runId: 'run-earlier' }), old2, { now: 9 }), rect: r(100, 760, 560, 300) }]
  const decisions = []
  const provider = async (_url, init) => { const body = JSON.parse(init.body); decisions.push(body); return Response.json({ answers: answersFor(body.questions, script), usage: { input_tokens: 11 } }) }
  // materialsFor models lane L7's accessor (chat.memoryMaterialsFor, not merged): the rows the answering model was given this turn.
  const deps = { ...briefingDeps({ chat: h.chat, contexts: h.contexts, enabled, ...(order ? { order } : {}) }), materialsFor: () => materials }
  const R = rig(t, { mode: 'on', handlerOptions: { briefing: deps, fetchImpl: provider } })
  const body = BriefingHost.observeRequest({ mode: 'on', report: ANSWER, answerId: h.ids.answerId, conversationId: h.ids.conversationId, runId: h.ids.runId, candidates: BriefingHost.canvasBriefingCandidates(cards), request: REQUEST, viewport: VIEW })
  return { h, R, body, decisions, v1, count: event => h.events.filter(e => e.event === event).length }
}
const fence = value => '```json\n' + JSON.stringify(value) + '\n```'
test('mounted journey: 5 judgment requests and ONE private fork turn; three cards are built by code and published by the finished run, then the briefing that reuses the v1 card', async t => {
  const s = await mounted(t, { forkReply: () => fence(fillReply(['P1', 'P2', 'P3'])) })
  assert.deepEqual(Object.keys(s.body), ['flow', 'conversationId', 'runId', 'report', 'currentAnswerId', 'candidates', 'request', 'viewport'])
  const outputsBefore = s.count('output.published'), completedAt = s.h.events.findIndex(e => e.event === 'run.completed'), messages = s.count('message.completed')
  const res = await s.R.http('POST', '/decision/briefing-observe', s.body)
  assert.equal(res.body.outcome, 'presented', JSON.stringify(res.body)); assert.deepEqual([res.body.order, res.body.judgeRequests, res.body.fillTurns, res.body.steps, res.body.newComponents], ['skeleton', 5, 1, 3, 3])
  assert.deepEqual(res.body.stages, ['place', 'parts', 'order', 'fill_check']); assert.deepEqual(res.body.retrievals, [{ viewId: 'res-old' }])
  // the subjective model: one private turn, and its prompt is the guide and the materials only
  assert.equal(s.h.forkPrompts.length, 1); assert.equal(s.h.native.filter(([m]) => m === 'thread/fork').length, 1)
  const prompt = s.h.forkPrompts[0]; for (const piece of ['Design guide (decided; do not change it)', '"component":"result_compare"', '"pointsAt":[{"alias":"N1","new":true},{"alias":"T1","new":false,"label":"A사 견적서 v1"}]', 'A사 미팅 메모', '"unfillable"']) assert.ok(prompt.includes(piece), piece)
  for (const absent of ['<answer>', '11월 14일에 v2로 진행하기로', 'res-v1', s.v1.id, 'Board components you may point at']) assert.ok(!prompt.includes(absent), absent)
  // the Decision model: request text, material titles and short content, card labels, the catalog; never an id
  assert.equal(s.decisions.length, 5); const sent = JSON.stringify(s.decisions); for (const piece of [REQUEST, 'A사 견적 결정 메모', 'result_compare', 'A사 견적서 v1']) assert.ok(sent.includes(piece), piece)
  for (const absent of [s.v1.id, 'res-v1', s.h.ids.runId, ANSWER.slice(0, 20)]) assert.ok(!sent.includes(absent), absent)
  // published: the three new results first, then the proposal; the answer was already complete; no new chat message
  const after = s.h.events.slice(completedAt + 1).map(e => e.event).filter(e => e !== 'context.bound'); assert.deepEqual(after, ['output.published', 'output.published', 'output.published', 'briefing.published'])
  assert.equal(s.count('output.published'), outputsBefore + 3); assert.equal(s.count('message.completed'), messages)
  assert.deepEqual(s.h.events.filter(e => e.event === 'output.published').slice(-3).map(e => e.details.output.title), ['A사 견적 v1 → v2', 'A사 견적 진행 순서', 'A사 견적 남은 일'])
  const briefing = s.h.chat.runFor(s.h.ids).context.briefings.at(-1)
  assert.equal(briefing.presentationStatus, 'proposed'); assert.equal(briefing.title, 'A사 견적 정리'); assert.equal(validBriefing({ id: briefing.id, title: briefing.title, steps: briefing.steps }), true)
  assert.deepEqual(briefing.steps.map(x => [x.targets.length, x.emphasis ?? 'spotlight']), [[2, 'outline'], [1, 'spotlight'], [1, 'spotlight']]); assert.equal(briefing.steps[0].targets[0].viewId, 'res-v1', 'the existing v1 card is a target of the compare step')
  assert.equal(briefing.steps[2].text, FILL.P3.text); assert.equal(s.R.budget.snapshot().inputTokens, 55)
  // once per answer
  assert.deepEqual((await s.R.http('POST', '/decision/briefing-observe', s.body)).body, { status: 'skipped', reason: 'already' })
})
test('mounted, single version: the compare card is never published; two cards and a two-step briefing are', async t => {
  const s = await mounted(t, { materials: SINGLE_VERSION, forkReply: () => fence(fillReply(['P1', 'P2', 'P3'], { unfillable: [{ item: 'P1', slot: 'rows', reason: 'no second version' }, { item: 'P1', slot: 'left', reason: '' }, { item: 'P1', slot: 'right', reason: '' }] })) })
  const before = s.count('output.published'), res = await s.R.http('POST', '/decision/briefing-observe', s.body)
  assert.deepEqual([res.body.outcome, res.body.judgeRequests, res.body.fillTurns, res.body.steps, res.body.newComponents], ['presented', 6, 1, 2, 2], JSON.stringify(res.body)); assert.deepEqual(res.body.stages, ['place', 'parts', 'order', 'fill_check', 'rechoose'])
  assert.equal(s.count('output.published'), before + 2); assert.ok(!s.h.events.filter(e => e.event === 'output.published').some(e => e.details.output.title === 'A사 견적 v1 → v2'))
  assert.equal(s.h.chat.runFor(s.h.ids).context.briefings.at(-1).steps.length, 2)
})
test('mounted: bubble, no component, no materials, a model that will not fill -> the chat answer stays, nothing is published; the earlier order is still there behind the switch', async t => {
  const quiet = async (options, expect) => { const s = await mounted(t, options); const before = s.h.events.length, res = await s.R.http('POST', '/decision/briefing-observe', s.body)
    assert.deepEqual([res.body.outcome, res.body.reason, res.body.judgeRequests, res.body.fillTurns], expect, JSON.stringify(res.body)); assert.deepEqual(s.h.events.slice(before).map(e => e.event), [], 'no event of any kind'); return s }
  await quiet({ script: { place: 'bubble' } }, ['bubble', 'judged-bubble', 1, 0])
  await quiet({ script: q => (q.name.startsWith('part_') ? 'none_fits' : undefined) }, ['bubble', 'no-component-fits', 2, 0])
  const none = await quiet({ materials: [] }, ['bubble', 'no-materials', 0, 0]); assert.equal(none.decisions.length, 0, 'without materials nothing is asked')
  const prose = await quiet({ forkReply: () => 'I would start with the comparison.' }, ['fallback-chat', 'fill-invalid', 4, 2]); assert.equal(prose.h.forkPrompts.length, 2)
  const off = await mounted(t, { enabled: false }); assert.deepEqual((await off.R.http('POST', '/decision/briefing-observe', off.body)).body, { status: 'skipped', reason: 'no-engine' })
  // the internal switch: design-first never touches the skeleton judge (here the report names fewer than two cards, so that order asks nothing at all)
  const old = await mounted(t, { order: 'design-first' }); const res = await old.R.http('POST', '/decision/briefing-observe', old.body)
  assert.deepEqual([res.body.outcome, res.body.reason, res.body.order], ['bubble', 'no-board-targets', undefined]); assert.equal(old.decisions.length, 0)
})
test('the engine adapter fills on the same bounded private turns; the chrome sends the request text only on the `on` path', async () => {
  const prompts = []; const engine = createBriefingEngine({ report: 'THE ANSWER TEXT', runText: async prompt => { prompts.push(prompt); return fence({ title: 't', items: {} }) } })
  assert.deepEqual(await engine({ kind: 'briefing_fill', guide: { items: [] }, materials: [] }), { title: 't', items: {} }); assert.ok(!prompts[0].includes('THE ANSWER TEXT'), 'the answer text is not part of the fill prompt')
  assert.ok(fillPrompt({ only: ['P2'], guide: {}, materials: [] }).includes('Fill only these items again: P2.')); assert.deepEqual(engine.stats().turns, 1)
  const two = [{ id: 'a', ref: {}, kind: 'output', label: 'Alpha one' }, { id: 'b', ref: {}, kind: 'output', label: 'Beta two' }]
  assert.equal(BriefingHost.observeRequest({ mode: 'on', report: 'nothing named', candidates: two }), null); assert.equal(BriefingHost.observeRequest({ mode: 'advisory', report: 'nothing named', candidates: two, request: REQUEST }), null, 'advisory is unchanged')
  const on = BriefingHost.observeRequest({ mode: 'on', report: 'nothing named', candidates: [], request: `  ${REQUEST}\u0007 `, viewport: { x: 1, y: 2, width: 3, height: 4, zoom: 9 } })
  assert.deepEqual([on.request, on.viewport], [REQUEST, { x: 1, y: 2, width: 3, height: 4 }]); assert.deepEqual(Object.keys(BriefingHost.observeRequest({ mode: 'advisory', report: 'Alpha one and Beta two', candidates: two, request: REQUEST, viewport: VIEW })), ['report', 'currentAnswerId', 'candidates'])
  const surface = readFileSync(new URL('overlay/JS/eg-desk-surface.uc.js', root), 'utf8')
  assert.match(surface, /let request = '', viewport = null;\n      if \(flowMode === 'on'\) \{/, 'the advisory path computes neither')
  const server = readFileSync(new URL('helper/codex-bridge-server.mjs', root), 'utf8'); assert.match(server, /order: process\.env\.EGDESK_BRIEFING_ORDER === 'design-first' \? 'design-first' : 'skeleton'/)
})
