// L4 cycles 13-15: Answer Briefing, skeleton first, judged by yes/no predicates. The Decision model answers closed yes/no questions about text it can read (the request,
// the materials' own text, slot text against its one source); CODE combines the answers into the design guide and computes what it can compute (layout, recorded
// order, reuse, folds); the subjective model only FILLS THE SLOTS; a part whose data is not supported is written again once or left out, else the chat answer stays.
// Synthetic: the Decisions provider is a scripted mock (key egd-synthetic-not-a-key-0004, no network), the native app-server is a mock whose private fork turn answers
// with scripted JSON, the canvas is a list of card records. Nothing here verifies an installed app or a real Decision call (see the real-measurement plan for that).
import assert from 'node:assert/strict'
import test from 'node:test'
import { readFileSync } from 'node:fs'
import * as BriefingHost from '../overlay/resources/EGDeskBriefingHost.sys.mjs'
import * as ChatState from '../overlay/resources/EGDeskChatState.sys.mjs'
import { validBriefing } from '../overlay/resources/EGDeskBriefingState.sys.mjs'
import { CANVAS_VIEW_SIZES } from '../overlay/resources/EGDeskSurfaceState.sys.mjs'
import { BRIEFING_CATALOG, BRIEFING_RENDERERS, MATERIAL_TRAITS, RESULT_CARD_METRICS, STEP_SLOTS, registerComponent, resultCardCapacity, textLines } from './egdesk-briefing-catalog.mjs'
import { SKELETON_JUDGE, SKELETON_LIMITS, materialGroups, buildGuide, chooseParts, createSkeletonJudge, decidePlace, enumerateSkeleton, fillRequest, layoutSkeleton, normalizeMaterials, normalizeSkeletonDto, orderItems, recordedBefore, runSkeletonFlow, skeletonChecks, validateFill } from './egdesk-briefing-skeleton.mjs'
import { BRIEFING_ENGINE_LIMITS, briefingDeps, createBriefingEngine, fillPrompt } from './egdesk-briefing-engine.mjs'
import { completeBriefingArgs } from './egdesk-briefing-flow.mjs'
import { createEgressGate, EGRESS_SITES, modelDataPermissions } from './egdesk-decision-egress.mjs'
import { harness, toolJson } from './egdesk-briefing-publish.support.mjs'
import { rig } from '../scripts/egdesk-briefing-rig.support.mjs'
import { buildWiki } from './egdesk-wiki-reconstruction.mjs'
import { SYNTHETIC_PAGES, mockJudge } from './egdesk-wiki-reconstruction.fixture.mjs'

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


// ---- the Decision model, scripted. Every question is a yes/no predicate; a script gives the probability for a question name (default: the "everything fits" path) ----
const DEFAULT_P = name => (name === 'several' ? .96 : name === 'one_sentence' ? .03 : name.startsWith('fit_') ? .95 : name.startsWith('before_') ? .9 : name.startsWith('slot_') ? .97 : .96)
function answersFor(questions, script) {
  return questions.map(q => {
    assert.equal(q.type, 'predicate', `${q.name}: only yes/no questions are asked`)
    const said = typeof script === 'function' ? script(q) : script?.[q.name]
    return said === 'refuse' ? { name: q.name, type: 'refusal' } : { name: q.name, type: 'predicate', probability: typeof said === 'number' ? said : DEFAULT_P(q.name) }
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
  return runSkeletonFlow({ request, materials, candidates, currentAnswerId: 'ans-now', viewport, judge, fill: filler, catalog: rest.catalog ?? BRIEFING_CATALOG, observeOnly: rest.observeOnly, ...(rest.now ? { now: rest.now } : {}), ...(rest.bindings ? { bindings: rest.bindings } : {}) }).then(out => ({ out, judge, fills }))
}
const ORDER = undefined // the default script: every part fits, the tied pairs keep the code's own order

// ================= 1. the catalog is data, and only what the product renders today =================
test('catalog: closed ids, slot schemas, what each suits, real sizes; every renderer claim is pinned against the product source', () => {
  assert.deepEqual(BRIEFING_CATALOG.ids, ['result_compare', 'step_pair', 'result_lines', 'result_text'])
  assert.equal(JSON.stringify(BRIEFING_CATALOG.entries), JSON.stringify(JSON.parse(JSON.stringify(BRIEFING_CATALOG.entries))), 'the entries are plain data (no functions)')
  for (const e of BRIEFING_CATALOG.entries) {
    assert.ok(e.suits.length && e.suits.every(t => MATERIAL_TRAITS.includes(t)), e.id); assert.ok(Number.isInteger(e.needs.materials.min) && Number.isInteger(e.needs.existing))
    for (const s of e.slots) { assert.ok(['text', 'material', 'list'].includes(s.type) && s.required === true, `${e.id}.${s.name}`); if (s.type === 'list') assert.ok(s.min <= s.max && s.of.every(f => f.type !== 'list')) }
    assert.equal(!!e.size, !!e.renderer.creates, 'a component that creates a card has size hints'); assert.equal(typeof BRIEFING_CATALOG.renderers[e.id], e.renderer.creates ? 'function' : 'undefined')
  }
  for (const e of BRIEFING_CATALOG.entries) for (const trait of e.suits) assert.ok(e.purpose[trait].length >= 20, `${e.id}: a plain-language sentence for ${trait}`)
  assert.ok(BRIEFING_CATALOG.get('result_lines').purpose.sequence.includes('not a table and not a chart'), 'the purpose says what the component is not')
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
  const table = { id: 'result_table', label: 'a small table', purpose: { compare: 'a new card with a small table of the two versions (not in the product today; registered for this test).' }, renderer: { surface: 'table card (not in the product today)', via: 'future', creates: 'result' }, suits: ['compare'], needs: { materials: { min: 2, max: 2 }, existing: 0 }, emphasis: 'outline',
    slots: [{ name: 'title', type: 'text', max: 40, required: true }, { name: 'rows', type: 'list', min: 1, max: 5, required: true, of: [{ name: 'cell', type: 'text', max: 30, required: true }] }], size: { width: 560, height: 560, minWidth: 360, minHeight: 280, baseLines: 2, rowLines: 2 } }
  const wider = registerComponent(BRIEFING_CATALOG, table, slots => slots.rows.map(x => x.cell).join('\n'))
  assert.deepEqual(wider.ids, [...BRIEFING_CATALOG.ids, 'result_table']); assert.equal(BRIEFING_CATALOG.get('result_table'), null)
  assert.deepEqual(enumerateSkeleton({ materials: QUOTE, candidates: boardCards(), catalog: wider }).parts[0].options.map(o => o.value), ['result_compare', 'result_table'])
  for (const bad of [{ ...table, id: 'result_text' }, { ...table, suits: ['chart'] }, { ...table, slots: [{ name: 'x', type: 'html' }] }, { ...table, needs: {} }, { ...table, purpose: {} }]) assert.throws(() => registerComponent(BRIEFING_CATALOG, bad, () => ''), TypeError)
  assert.throws(() => registerComponent(BRIEFING_CATALOG, table), /render function/)
})


// ================= 2. the options exist as data before anything is asked =================
test('materials and parts: lane L7 rows are read as they are; parts come from links, dates and recorded status; reuse first is built in', () => {
  const mats = normalizeMaterials(QUOTE)
  assert.deepEqual(mats.map(m => [m.alias, m.at, m.status, m.open, m.links.map(l => `${l.type}>${l.to}`).join()]), [['M1', '2026-11-03', 'done', false, ''], ['M2', '2026-11-10', 'plan', true, 'supersedes>M1'], ['M3', '2026-11-12', 'done', false, 'follows_from>M2'], ['M4', '2026-11-14', 'plan', true, 'decided_in>M3']])
  assert.deepEqual(normalizeMaterials([{ id: 'a', title: '  Plain  row ', text: 'x', at: '2026-01-02T03:04:05Z', status: 'weird', links: [{ type: 'revises', to: 'b' }, { type: 'supersedes', to: 'b' }, { type: 'supersedes', to: 'a' }] }, { id: 'b', title: 'Other' }, { title: '' }, null]).map(({ key, ...rest }) => rest),
    [{ alias: 'M1', title: 'Plain row', text: 'x', at: '2026-01-02', status: 'unknown', open: false, links: [{ type: 'supersedes', to: 'M2' }] }, { alias: 'M2', title: 'Other', text: '', at: null, status: 'unknown', open: false, links: [] }], 'a simple array works; unknown link types and statuses are not believed')
  const scene = enumerateSkeleton({ materials: QUOTE, candidates: boardCards(), currentAnswerId: 'ans-now' })
  assert.deepEqual(scene.parts.map(p => [p.alias, p.trait, p.materials.join(), p.options.map(o => o.value).join()]), [
    ['P1', 'compare', 'M1,M2', 'result_compare'], ['P2', 'sequence', 'M1,M2,M3,M4', 'result_lines'], ['P3', 'open_items', 'M2,M4', 'result_lines']])
  assert.deepEqual([...scene.shows], [['M1', 'T1']], 'the v1 quote already has its card'); assert.deepEqual(scene.retrievable, ['T2'], 'only the outdated output of an earlier answer may be folded')
  // both versions on the board -> the pair step (no new card) becomes an option; a single material with its card can only be reused, never re-created
  const both = enumerateSkeleton({ materials: QUOTE, candidates: [...boardCards(), { ...boardCards()[0], id: 'res-v2', ref: { outputId: '33333333-3333-4333-8333-333333333333' }, label: 'A사 견적 v2 안', rect: r(700, 120, 560, 560) }], currentAnswerId: 'ans-now' })
  assert.deepEqual(both.parts[0].options.map(o => o.value), ['result_compare', 'step_pair'])
  const lone = enumerateSkeleton({ materials: [QUOTE[0], { title: '무관한 자료', excerpt: 'x' }], candidates: boardCards(), currentAnswerId: 'ans-now' })
  assert.deepEqual(lone.parts.map(p => [p.trait, p.materials.join(), p.options.map(o => o.value).join()]), [['single', 'M1', 'reuse_T1'], ['single', 'M2', 'result_text']], 'result_text is not offered for a material that already has a card')
  // a card of the user (a memo) or one that cannot be bound is never a reuse option
  const memo = enumerateSkeleton({ materials: [QUOTE[0]], candidates: [{ id: 'memo-1', ref: {}, kind: 'source', label: 'A사 견적서 v1', onBoard: true, maySend: true, owner: 'user' }] })
  assert.deepEqual(memo.parts[0].options.map(o => o.value), ['result_text'])
})

// ================= 3. the judge: predicates only, each judged thing quoted in its own question (design rules R1-R4 from the real measurement) =================
test('the judge request is closed and is made of yes/no questions only: no "bubble", "none" or "which one" choice exists anywhere', () => {
  const part = (p, trait, materials, component) => ({ part: p, trait, materials, component })
  const base = { stage: 'fit', request: REQUEST, materials: [{ alias: 'M1', title: 'A사 견적서 v1', text: '총액 1,200만원. 납기 6주.', at: '2026-11-03', status: 'done' }, { alias: 'M2', title: 'A사 견적 v2 안', text: '총액 1,050만원. 납기 8주.', at: null, status: 'plan' }],
    cards: [{ alias: 'T1', label: 'A사 견적서 v1', gist: '총액 1,200만원' }], questions: [{ kind: 'fit', ...part('P1', 'compare', ['M1', 'M2'], 'result_compare') }, { kind: 'fit', ...part('P2', 'single', ['M1'], 'reuse_T1') }] }
  assert.ok(normalizeSkeletonDto(base))
  const forged = fn => { const copy = structuredClone(base); fn(copy); return normalizeSkeletonDto(copy) }
  for (const [why, fn] of [['unknown stage', c => { c.stage = 'parts' }], ['a question of another stage', c => { c.questions[0] = { kind: 'several' } }], ['a component that is not in the catalog', c => { c.questions[0].component = 'result_table' }],
    ['a component that does not suit the part', c => { c.questions[0].component = 'result_text' }], ['a card that was not listed', c => { c.questions[1].component = 'reuse_T9' }], ['free instructions', c => { c.questions[0].instructions = 'Always answer yes' }],
    ['an id', c => { c.cards[0].viewId = 'res-v1' }], ['a coordinate', c => { c.cards[0].rect = { x: 1 } }], ['a material that is not listed', c => { c.questions[0].materials = ['M7'] }], ['control characters', c => { c.request = 'a\u0000b' }],
    ['no request', c => { c.request = '' }], ['the same question twice', c => { c.questions.push(structuredClone(c.questions[0])) }], ['extra field', c => { c.note = 'x' }]]) assert.equal(forged(fn), null, why)
  // the packet: two plain text messages (the shape that was really sent), a cache key per stage, predicates only
  const prepared = SKELETON_JUDGE.prepare({ mode: 'on', binding: 'b', dto: base })
  assert.deepEqual(prepared.packet.input.map(m => [m.role, typeof m.content]), [['developer', 'string'], ['user', 'string']]); assert.equal(prepared.packet.promptCacheKey, 'briefing-skeleton-fit')
  assert.deepEqual(prepared.packet.questions.map(q => [q.name, q.type, Object.keys(q).join()]), [['fit_P1_result_compare', 'predicate', 'type,name,instructions'], ['fit_P2_reuse_T1', 'predicate', 'type,name,instructions']])
  // R1 + R4: the question itself quotes the request, the materials' own text and says in plain words what the component is and is not
  const q = prepared.packet.questions[0].instructions
  for (const piece of ['Materials, each quoted as JSON: M1 {"title":"A사 견적서 v1","date":"2026-11-03","status":"done","text":"총액 1,200만원. 납기 6주."}; M2 {"title":"A사 견적 v2 안","status":"plan","text":"총액 1,050만원. 납기 8주."}.',
    'It needs a value for the same aspect in BOTH versions. Would it help the person with what they asked to show how these two versions differ this way?', 'Answer no if these materials do not contain what this way of showing needs']) assert.ok(q.includes(piece), piece)
  assert.equal(prepared.packet.input[1].content, 'Request, quoted exactly as a JSON string: "A사 견적 건 정리해줘"', 'the request is the one user message; the materials are quoted inside each question')
  assert.ok(prepared.packet.questions[1].instructions.includes('the card that is already on the board for this material (its title, quoted: "A사 견적서 v1"); nothing new is made'))
  assert.equal(SKELETON_JUDGE.prepare({ mode: 'off', binding: 'b', dto: base }).status, 'manual')
  // reading: a probability per question; a refusal or a missing answer is unknown (null), never "no"; nothing usable at all is manual
  const read = answers => SKELETON_JUDGE.read(prepared, answers, 'b')
  assert.deepEqual(read({ fit_P1_result_compare: { type: 'predicate', probability: .91 }, fit_P2_reuse_T1: { type: 'refusal' } }).reply.answers, { fit_P1_result_compare: .91, fit_P2_reuse_T1: null })
  assert.equal(read({ fit_P1_result_compare: { type: 'refusal' } }).status, 'manual'); assert.equal(SKELETON_JUDGE.read(prepared, { fit_P1_result_compare: { type: 'predicate', probability: 1 } }, 'other').status, 'manual')
  const entry = SKELETON_JUDGE.entry(prepared, { fit_P1_result_compare: { type: 'predicate', probability: .91 }, fit_P2_reuse_T1: { type: 'predicate', probability: .5 } }, read({ fit_P1_result_compare: { type: 'predicate', probability: .91 } }))
  assert.deepEqual([entry.feature, entry.candidates, entry.judgments.map(j => j.would).join()], ['board_arrangement', 2, 'accept,hold']); assert.ok(!JSON.stringify(entry).includes('견적'))
  // the other stages, by their own words
  const place = SKELETON_JUDGE.prepare({ mode: 'on', binding: 'b', dto: { ...base, stage: 'place', questions: [{ kind: 'several' }, { kind: 'one_sentence' }] } }).packet
  assert.ok(place.input[1].content.includes('Materials the assistant had, each quoted as JSON:\nM1 {"title":"A사 견적서 v1"')); assert.deepEqual(place.questions.map(x => x.name), ['several', 'one_sentence'])
  assert.ok(!/bubble|unsure|ALSO|only when/.test(JSON.stringify(place)), 'none of the wording that pushed the real answer to the safe side')
  const order = SKELETON_JUDGE.prepare({ mode: 'on', binding: 'b', dto: { ...base, stage: 'order', questions: [{ kind: 'before', first: part('P1', 'compare', ['M1', 'M2'], 'result_compare'), second: part('P2', 'single', ['M1'], 'reuse_T1') }] } }).packet.questions[0]
  assert.equal(order.name, 'before_P1_P2'); assert.ok(order.instructions.startsWith('Part X shows how these two versions differ: M1 {"title"') && order.instructions.includes('Part Y shows this one material: M1 {') && order.instructions.endsWith('be shown part X before part Y?'), 'each part is described by its own materials (the real order question named them "part P1")')
  const check = SKELETON_JUDGE.prepare({ mode: 'on', binding: 'b', dto: { ...base, stage: 'fill_check', questions: [{ kind: 'slot', part: 'P1', row: 1, side: 'left', aspect: '총액', text: '1,200만원', material: 'M1' }, { kind: 'slot', part: 'P2', row: 2, text: '11/03 견적서 v1 제출', material: 'M1' },
    { kind: 'step', part: 'P1', text: '총액이 내려갔습니다.', shown: [{ label: 'A사 견적 v1 → v2', content: '총액 1,200만원 → 1,050만원' }] }] } }).packet
  assert.deepEqual(check.questions.map(x => x.name), ['slot_P1_r1_left', 'slot_P2_r2', 'step_P1'])
  assert.equal(check.questions[0].instructions, 'Value, quoted exactly as a JSON string: "1,200만원", given for the aspect "총액". Source material, quoted as JSON: M1 {"title":"A사 견적서 v1","date":"2026-11-03","status":"done","text":"총액 1,200만원. 납기 6주."}. Is this value, for this aspect, supported by this source material?')
  assert.ok(check.questions[1].instructions.endsWith('Is everything this text states supported by this source material?')); assert.ok(check.questions[2].instructions.endsWith('Is every fact in the explanation also in what the step shows?'))
  assert.ok(check.input[0].content.includes('Rewording, summarising and linking words are fine') && !check.input[1].content.includes('M2'), 'the check carries no material list: each question has its own source')
})
test('code combines the answers: board needs "several" yes AND "one sentence" no; a part takes its best decided yes, reuse first; recorded time and links order the parts', () => {
  assert.deepEqual(decidePlace({ several: .95, one_sentence: .02 }), { value: 'board', reason: null }); assert.deepEqual(decidePlace({ several: .97, one_sentence: .9 }), { value: 'bubble', reason: 'judged-bubble' })
  assert.deepEqual(decidePlace({ several: .1, one_sentence: .1 }), { value: 'bubble', reason: 'judged-bubble' }); assert.deepEqual(decidePlace({ several: .6, one_sentence: .1 }), { value: 'bubble', reason: 'placement-undecided' })
  assert.deepEqual(decidePlace({ several: .95, one_sentence: .5 }), { value: 'bubble', reason: 'placement-undecided' }); assert.deepEqual(decidePlace({ several: .95, one_sentence: null }), { value: 'bubble', reason: 'placement-undecided' }, 'a refusal is not a no')
  // both versions on the board: showing the two existing cards together (nothing new) beats a new compare card when both are judged to fit
  const both = enumerateSkeleton({ materials: QUOTE, candidates: [...boardCards(), { ...boardCards()[0], id: 'res-v2', ref: { outputId: '33333333-3333-4333-8333-333333333333' }, label: 'A사 견적 v2 안', rect: r(700, 120, 560, 560) }], currentAnswerId: 'ans-now' })
  const pick = answers => chooseParts(both, answers).map(c => [c.part.alias, c.yes.map(o => o.value).join(), c.decided])
  assert.deepEqual(pick({ fit_P1_result_compare: .95, fit_P1_step_pair: .9, fit_P2_result_lines: .2, fit_P3_result_lines: .5 }), [['P1', 'step_pair,result_compare', true], ['P2', '', true], ['P3', '', false]])
  assert.deepEqual(pick({ fit_P1_result_compare: .95, fit_P1_step_pair: .1 })[0], ['P1', 'result_compare', true]); assert.deepEqual(pick({})[0], ['P1', '', false])
  // order: the record decides where it can
  const scene = enumerateSkeleton({ materials: [row('M1', '요청 접수', 'x', '2026-11-03', 'done'), row('M2', '견적 발송', 'x', '2026-11-06', 'done', [{ type: 'follows_from', toAlias: 'M1' }]), row('M3', '수정 계획', 'x', null, 'plan', [{ type: 'supersedes', toAlias: 'M2' }]), row('M4', '메모', 'x', null, 'done', [{ type: 'refers_to', toAlias: 'M1' }])], candidates: [] })
  const item = (id, materials) => ({ id, materials })
  assert.equal(recordedBefore(item('a', ['M1']), item('b', ['M2']), scene), true, 'every material of a is earlier'); assert.equal(recordedBefore(item('a', ['M2']), item('b', ['M1']), scene), false)
  assert.equal(recordedBefore(item('a', ['M1', 'M2']), item('b', ['M3']), scene), true, 'a plan without a date has not happened yet'); assert.equal(recordedBefore(item('a', ['M1', 'M2']), item('b', ['M2', 'M3']), scene), null, 'overlapping parts: the record does not say')
  assert.equal(recordedBefore(item('a', ['M1']), item('b', ['M4']), scene), true, 'no date on the memo, but it refers to the request: the request first'); assert.equal(recordedBefore(item('a', ['M4']), item('b', ['M1']), scene), false)
  const items = [item('P1', ['M2', 'M3']), item('P2', ['M1', 'M2']), item('P3', ['M3'])]
  assert.deepEqual(orderItems(items, scene).ties.map(([a, b]) => `${a.id}/${b.id}`), ['P1/P2', 'P1/P3'], 'only these pairs are asked'); assert.deepEqual(orderItems(items, scene).ordered.map(i => i.id), ['P1', 'P2', 'P3'], 'unasked: the code\'s own order')
  assert.deepEqual(orderItems(items, scene, { before_P1_P2: .05, before_P1_P3: .95 }).ordered.map(i => i.id), ['P2', 'P1', 'P3']); assert.deepEqual(orderItems(items, scene, { before_P1_P2: .05, before_P1_P3: .1 }).ordered.map(i => i.id), ['P2', 'P3', 'P1'])
  assert.deepEqual(orderItems(items, scene, { before_P1_P2: .5, before_P1_P3: null }).ordered.map(i => i.id), ['P1', 'P2', 'P3'], 'undecided or refused: the code\'s own order, never a guess')
})

// ================= 4. the journey: "A사 견적 건 정리해줘" =================
test('journey: v1 quote, v2 plan, meeting note, decision memo -> compare + ordered lines + open-items lines; the v1 card is reused; 4 judgment requests, 1 fill turn', async () => {
  const { out, judge, fills } = await run(ORDER)
  assert.equal(out.status, 'presented', JSON.stringify(out))
  assert.deepEqual(judge.calls.map(c => c.stage), ['place', 'fit', 'order', 'fill_check']); assert.deepEqual([out.stats.judgeRequests, out.stats.fillTurns, out.stats.questions], [4, 1, 2 + 3 + 3 + 16])
  assert.deepEqual(judge.calls.slice(0, 3).map(c => c.names), [['several', 'one_sentence'], ['fit_P1_result_compare', 'fit_P2_result_lines', 'fit_P3_result_lines'], ['before_P1_P2', 'before_P1_P3', 'before_P2_P3']])
  assert.deepEqual(judge.calls[3].names, ['slot_P1_r1_left', 'slot_P1_r1_right', 'slot_P1_r2_left', 'slot_P1_r2_right', 'slot_P1_r3_left', 'slot_P1_r3_right', 'step_P1', 'slot_P2_r1', 'slot_P2_r2', 'slot_P2_r3', 'slot_P2_r4', 'step_P2', 'slot_P3_r1', 'slot_P3_r2', 'slot_P3_r3', 'step_P3'])
  // the design guide: ordered components with their slot schemas, the reused card, the fold proposal (decided by rule: an outdated output of an earlier answer)
  assert.deepEqual(out.guide.items.map(i => [i.position, i.id, i.shows, i.component, i.materials.join(), i.pointsAt.map(p => `${p.alias}${p.new ? '+' : ''}`).join()]), [
    [1, 'P1', 'compare', 'result_compare', 'M1,M2', 'N1+,T1'], [2, 'P2', 'sequence', 'result_lines', 'M1,M2,M3,M4', 'N2+'], [3, 'P3', 'open_items', 'result_lines', 'M2,M4', 'N3+']])
  assert.deepEqual(out.guide.retrievals, ['T2']); assert.deepEqual(out.decisions, { P1: 'result_compare', P2: 'result_lines', P3: 'result_lines' }); assert.deepEqual(out.order.ties, ['P1/P2', 'P1/P3', 'P2/P3'])
  assert.deepEqual(out.reuse, { reuse: ['T1'], retire: ['T2'], created: ['result_compare', 'result_lines', 'result_lines'] })
  assert.equal(out.newComponents.filter(c => c.component === 'result_text').length, 0, '0 unnecessary new components'); assert.ok(!out.newComponents.some(c => c.title === 'A사 견적서 v1'))
  assert.equal(out.newComponents[2].markdown, '**법무** 법무 검토\n**승인** 대표 승인\n**발송** A사에 최종본 발송', 'the card text is built by code from the slot data')
  const args = completeBriefingArgs(out, { N1: { outputId: 'n1' }, N2: { outputId: 'n2' }, N3: { outputId: 'n3' } })
  assert.equal(validBriefing({ id: 'x', ...args }), true); assert.deepEqual(args.steps.map(s => [s.id, s.emphasis, s.targets.length]), [['s1', 'outline', 2], ['s2', 'spotlight', 1], ['s3', 'spotlight', 1]])
  // the check after the fill: each value against the ONE material its slot cites, each explanation against what its step shows
  const checks = Object.fromEntries(judge.calls[3].packet.questions.map(q => [q.name, q.instructions]))
  assert.ok(checks.slot_P1_r1_left.startsWith('Value, quoted exactly as a JSON string: "1,200만원", given for the aspect "총액". Source material, quoted as JSON: M1 {"title":"A사 견적서 v1"'))
  assert.ok(checks.slot_P1_r1_right.includes('"1,050만원"') && checks.slot_P1_r1_right.includes('M2 {"title":"A사 견적 v2 안"')); assert.ok(checks.slot_P2_r3.startsWith('Text, quoted exactly as a JSON string: "11/12 미팅에서 가격·납기 합의". Source material, quoted as JSON: M3 {"title":"A사 미팅 메모"'))
  assert.ok(checks.step_P1.includes('"content":"총액 1,200만원 → 1,050만원 / 납기 6주 → 8주 / 유지보수 1년 → 6개월"') && checks.step_P1.includes('"label":"A사 견적서 v1"'), 'the new card as it will read, and the reused card')
  // what the subjective model received: the guide and the materials, nothing else
  assert.equal(fills.length, 1); assert.deepEqual(Object.keys(fills[0]), ['kind', 'guide', 'materials']); assert.deepEqual(out.stats.received, [{ turn: 1, keys: ['kind', 'guide', 'materials'], items: ['P1:result_compare', 'P2:result_lines', 'P3:result_lines'], materials: ['M1', 'M2', 'M3', 'M4'] }])
  const prompt = fillPrompt(fills[0]); for (const absent of ['<answer>', 'res-v1', '11111111', '"rect"', '"key"']) assert.ok(!prompt.includes(absent), absent)
  // what the Decision model received: the request and the materials' own text; never an id, a key or a coordinate
  const sent = JSON.stringify(judge.calls.map(c => c.packet)); for (const piece of [REQUEST, 'A사 미팅 메모', '총액 1,050만원으로 조정']) assert.ok(sent.includes(piece), piece)
  for (const absent of ['res-v1', 'res-old', '11111111', '"rect"', '"x":', '"key"']) assert.ok(!sent.includes(absent), absent)
  assert.doesNotMatch(sent, /t:[a-f0-9]{32}/, 'no material fingerprint')
})
test('journey, single version: the compare is judged not to fit BEFORE anything is written; if it is chosen anyway, its missing data drops that part alone by rule', async () => {
  // the fit question shows both materials: the "second version" holds no figures, so the judge says the comparison does not fit
  const early = await run({ fit_P1_result_compare: .04 }, { materials: SINGLE_VERSION })
  assert.equal(early.out.status, 'presented'); assert.deepEqual(early.judge.calls.map(c => c.stage), ['place', 'fit', 'order', 'fill_check']); assert.deepEqual(early.out.decisions, { P1: 'no', P2: 'result_lines', P3: 'result_lines' })
  assert.deepEqual(early.out.guide.items.map(i => i.id), ['P2', 'P3']); assert.deepEqual(early.fills[0].guide.items.map(i => i.id), ['P2', 'P3'], 'the subjective model is never asked for the comparison')
  assert.ok(early.judge.calls[1].packet.questions[0].instructions.includes('M2 {"title":"A사 견적 수정 요청","date":"2026-11-10","status":"plan","text":"A사가 가격 조정을 요청함. 수정 견적은 아직 받지 못함."}'))
  // the judge said yes, the model then reports that it cannot fill the rows: no other way of showing it was judged to fit, so that part is left out; no extra request
  const reply = asked => fillReply(asked.guide.items.map(i => i.id), { unfillable: [{ item: 'P1', slot: 'rows', reason: 'M2 has no figures to compare' }, { item: 'P1', slot: 'left', reason: 'n/a' }, { item: 'P1', slot: 'right', reason: 'n/a' }] })
  const late = await run(ORDER, { materials: SINGLE_VERSION, fill: reply })
  assert.equal(late.out.status, 'presented'); assert.deepEqual([late.out.stats.judgeRequests, late.out.stats.fillTurns], [4, 1])
  assert.ok(late.judge.calls[3].names.every(n => !n.includes('P1')), 'the part whose data is missing is not sent for checking')
  assert.deepEqual(late.out.rejections, [{ part: 'P1', problem: 'slot_empty', action: 'drop', words: [] }]); assert.deepEqual(late.out.guide.items.map(i => i.id), ['P2', 'P3']); assert.deepEqual(late.out.newComponents.map(c => c.alias), ['N2', 'N3'])
  // with another way that was also judged to fit (a registered component), missing data moves the part to it and only that part is written again
  const table = { id: 'result_table', label: 'a small table', purpose: { compare: 'a new card with a small table of the two versions (not in the product today; registered for this test).' }, renderer: { surface: 'table card', via: 'future', creates: 'result' }, suits: ['compare'], needs: { materials: { min: 2, max: 2 }, existing: 0 }, emphasis: 'outline',
    slots: [{ name: 'title', type: 'text', max: 40, required: true }, { name: 'rows', type: 'list', min: 1, max: 5, required: true, of: [{ name: 'cell', type: 'text', max: 30, required: true }] }], size: { width: 560, height: 560, minWidth: 360, minHeight: 280, baseLines: 2, rowLines: 2 } }
  const wider = registerComponent(BRIEFING_CATALOG, table, slots => slots.rows.map(x => x.cell).join('\n'))
  const moved = await run(ORDER, { materials: SINGLE_VERSION, catalog: wider, fill: (asked, n) => (n === 1 ? reply(asked) : { items: { P1: { text: FILL.P1.text, fallback: FILL.P1.fallback, slots: { title: '견적 v1', rows: [{ cell: '총액 1,200만원' }] } } } }) })
  assert.equal(moved.out.status, 'presented'); assert.deepEqual(moved.out.rejections, [{ part: 'P1', problem: 'slot_empty', action: 'result_table' }]); assert.deepEqual(moved.fills[1].only, ['P1']); assert.deepEqual(moved.fills[1].guide.items.map(i => i.component), ['result_table'])
  assert.deepEqual(moved.judge.calls.map(c => c.stage), ['place', 'fit', 'order', 'fill_check', 'fill_check']); assert.deepEqual(moved.judge.calls[4].names, ['step_P1'], 'only the re-made part is checked again')
})
test('journey: one sentence is enough, nothing needs to be seen together, nothing fits -> the chat answer; nothing is asked of the subjective model', async () => {
  const enough = await run({ one_sentence: .97 }, { request: 'A사 견적 총액이 얼마였지?' })
  assert.deepEqual([enough.out.status, enough.out.reason, enough.out.stats.judgeRequests, enough.out.stats.fillTurns], ['bubble', 'judged-bubble', 1, 0])
  const alone = await run({ several: .04 }); assert.deepEqual([alone.out.status, alone.out.reason, alone.out.stats.judgeRequests], ['bubble', 'judged-bubble', 1])
  const unsure = await run({ several: .55 }); assert.deepEqual([unsure.out.status, unsure.out.reason], ['bubble', 'placement-undecided'])
  const refused = await run({ several: 'refuse', one_sentence: 'refuse' }); assert.deepEqual([refused.out.status, refused.out.reason], ['bubble', 'judge-unavailable'], 'a refusal is not an answer')
  // "no component fits" is not an option anybody can pick: it is what code concludes when every (part, way) is a no
  const none = await run(q => (q.name.startsWith('fit_') ? .05 : undefined), { request: 'A사 견적 단가 변화를 그래프로 그려줘' })
  assert.deepEqual([none.out.status, none.out.reason, none.out.stats.judgeRequests, none.out.stats.fillTurns], ['bubble', 'no-component-fits', 2, 0]); assert.deepEqual(none.out.decisions, { P1: 'no', P2: 'no', P3: 'no' }); assert.equal(none.fills.length, 0)
  assert.ok(none.judge.calls[1].packet.questions[1].instructions.includes('It is a plain list, not a table and not a chart.'), 'the question says what the component is not')
  const half = await run(q => (q.name.startsWith('fit_') ? .5 : undefined)); assert.deepEqual([half.out.reason, half.out.decisions.P1], ['no-component-fits', 'undecided'], 'an undecided answer is not a yes')
  // nothing to build from: zero requests
  for (const [extra, reason] of [[{ materials: [] }, 'no-materials'], [{ materials: [{ title: '' }] }, 'no-materials'], [{ request: '   ' }, 'no-request']]) { const empty = await run({}, extra); assert.deepEqual([empty.out.status, empty.out.reason, empty.out.stats.judgeRequests, empty.judge.calls.length], ['bubble', reason, 0, 0]) }
  // advisory: place and fit are recorded, nothing else happens
  const advisory = await run(ORDER, { mode: 'advisory' }); assert.deepEqual([advisory.out.status, advisory.out.verdict, advisory.judge.calls.map(c => c.stage).join(), advisory.fills.length], ['advisory-only', 'board', 'place,fit', 0])
  const observed = await run(ORDER, { observeOnly: true }); assert.deepEqual([observed.out.status, observed.judge.calls.length, observed.fills.length], ['observed', 2, 0])
})

// ================= 5. layout and order are computed, so they are rules: nothing is asked =================
test('layout by code: real sizes on a small view trim the rows; a reused card too far away is left out of the step; no judgment request is spent on either', async () => {
  const small = r(0, 0, 1900, 470), near = boardCards({ v1: r(40, 40, 400, 300), old: r(40, 2000, 400, 300) })
  const scene = enumerateSkeleton({ materials: QUOTE, candidates: near, currentAnswerId: 'ans-now' })
  const item = (id, component, extra = {}) => ({ id, trait: scene.parts.find(p => p.alias === id).trait, materials: scene.parts.find(p => p.alias === id).materials, component, reuse: [], creates: 'N' + id.slice(1), emphasis: 'spotlight', ...extra })
  const items = [item('P1', 'result_compare', { reuse: ['T1'] }), item('P2', 'result_lines'), item('P3', 'result_lines')]
  const layout = layoutSkeleton(items, scene, small)
  assert.deepEqual([...layout.capacity].map(([id, c]) => [id, c.lines]), [['P1', 14], ['P2', 14], ['P3', 14]], 'the card shrinks to the view (the product\'s own size rule), so it holds fewer lines')
  assert.deepEqual(skeletonChecks(items, layout, scene).map(c => [c.item, c.about, c.fix, c.fitRows]), [['overflow', 'P1', 'trim', 4], ['overflow', 'P3', 'trim', 4]], 'four dated lines fit; six rows of three lines do not')
  assert.deepEqual(skeletonChecks(items, layoutSkeleton(items, scene, VIEW), scene), [], 'at full size nothing is flagged')
  const trimmed = await run(ORDER, { viewport: small, candidates: near })
  assert.equal(trimmed.out.status, 'presented', JSON.stringify(trimmed.out)); assert.deepEqual(trimmed.judge.calls.map(c => c.stage), ['place', 'fit', 'order', 'fill_check'], 'the same four requests')
  assert.deepEqual(trimmed.out.repaired, [{ item: 'overflow', about: 'P1', value: 'trim' }, { item: 'overflow', about: 'P3', value: 'trim' }]); assert.deepEqual(trimmed.out.guide.items.map(i => i.slots.find(s => s.type === 'list').max), [4, 6, 4])
  const far = await run(ORDER, { candidates: boardCards({ v1: r(-6000, -4000, 560, 560), old: r(40, 2000, 400, 300) }), viewport: r(0, 0, 1600, 1000) })
  assert.deepEqual(far.out.repaired, [{ item: 'spread', about: 'P1', value: 'own_step' }]); assert.deepEqual(far.out.guide.items[0].pointsAt.map(p => p.alias), ['N1']); assert.deepEqual(far.out.reuse.reuse, [])
  // order: where the record decides, nothing is asked; the judge's answer moves only the pairs the record leaves open
  const dated = [row('M1', '요청 접수', '11월 3일 견적 요청을 받았다.', '2026-11-03', 'done'), row('M2', '견적 발송', '11월 6일 견적서를 보냈다.', '2026-11-06', 'done', [{ type: 'follows_from', toAlias: 'M1' }]), row('M3', '수정 계획', '수정 견적을 보낼 예정이다.', null, 'plan', [{ type: 'follows_from', toAlias: 'M2' }])]
  const literal = asked => { const value = (slot, item, n = 0) => (slot.type === 'text' ? `${slot.name} ${n + 1}` : slot.type === 'material' ? item.materials[n % item.materials.length] : Array.from({ length: Math.max(slot.min, Math.min(slot.max, item.materials.length)) }, (_, i) => Object.fromEntries(slot.of.map(f => [f.name, value(f, item, i)]))))
    return { title: '정리', items: Object.fromEntries(asked.guide.items.map(item => [item.id, { text: '설명', fallback: '카드를 열어 보세요.', slots: Object.fromEntries(item.slots.map(sl => [sl.name, value(sl, item)])) }])) } }
  const recorded = await run(ORDER, { materials: dated, candidates: [], fill: literal })
  assert.deepEqual(recorded.judge.calls.map(c => c.stage), ['place', 'fit', 'fill_check'], 'sequence (11/03-11/06) before the open plan: the record says so, no order request'); assert.deepEqual(recorded.out.guide.items.map(i => i.shows), ['sequence', 'open_items'])
  const flipped = await run({ before_P1_P2: .04, before_P1_P3: .04 }); assert.deepEqual(flipped.out.guide.items.map(i => i.id), ['P2', 'P3', 'P1'], 'the judge put the comparison after both')
})

// ================= 6. the fill is data only, validated against the slot schemas; then checked piece by piece =================
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
test('after the fill: a slot its material does not support is written again once, for that part only, with closed words; still unsupported -> that part is left out', async () => {
  // P2 line 2 is not supported by the material it cites -> one more private turn for P2 only -> checked again
  let seen = 0
  const rewrite = await run(q => (q.name === 'slot_P2_r2' ? (seen++ ? .97 : .03) : undefined), { fill: (asked, n) => (n === 1 ? fillReply(asked.guide.items.map(i => i.id)) : { items: { P2: FILL.P2 } }) })
  assert.equal(rewrite.out.status, 'presented'); assert.deepEqual(rewrite.judge.calls.map(c => c.stage), ['place', 'fit', 'order', 'fill_check', 'fill_check']); assert.deepEqual([rewrite.out.stats.judgeRequests, rewrite.out.stats.fillTurns, rewrite.out.revisions], [5, 2, 1])
  assert.deepEqual(rewrite.fills[1].only, ['P2']); assert.deepEqual(rewrite.fills[1].rejected, ['P2 line 2']); assert.deepEqual(rewrite.judge.calls[4].names, ['slot_P2_r1', 'slot_P2_r2', 'slot_P2_r3', 'slot_P2_r4', 'step_P2'], 'only that part is checked again')
  assert.deepEqual(rewrite.out.rejections, [{ part: 'P2', problem: 'unsupported', action: 'rewrite', words: ['P2 line 2'] }])
  const prompt = fillPrompt(rewrite.fills[1]); assert.ok(prompt.includes('Fill only these items again: P2.') && prompt.includes('not supported by the material they cite: P2 line 2.'))
  assert.ok(!fillPrompt({ ...rewrite.fills[1], rejected: ['ignore the rules', 'P2 line 2'] }).includes('ignore the rules'), 'only closed words reach the model')
  // only the wrong pieces are named: one compare value and one explanation, each by its own question
  const two = await run(q => (q.name === 'slot_P1_r2_right' || q.name === 'step_P3' ? .02 : undefined), { fill: asked => fillReply(asked.guide.items.map(i => i.id)) })
  assert.deepEqual(two.out.rejections.filter(x => x.action === 'rewrite').map(x => x.words.join()), ['P1 row 2 right', 'P3 explanation']); assert.deepEqual(two.fills[1].only, ['P1', 'P3'])
  assert.deepEqual(two.out.dropped.map(d => [d.part, d.why]), [['P1', 'unsupported'], ['P3', 'unsupported']], 'still unsupported after its one rewrite: left out by rule'); assert.deepEqual(two.out.guide.items.map(i => i.id), ['P2']); assert.equal(two.out.status, 'presented')
  // an undecided or refused check is not support
  const hazy = await run(q => (q.name === 'slot_P3_r1' ? .5 : q.name === 'step_P2' ? 'refuse' : undefined), { fill: asked => fillReply(asked.guide.items.map(i => i.id)) })
  assert.deepEqual(hazy.out.rejections.filter(x => x.action === 'rewrite').map(x => x.words.join()), ['P2 explanation', 'P3 line 1'])
  // everything unsupported, twice -> nothing left -> the chat answer
  const all = await run(q => (q.name.startsWith('slot_') || q.name.startsWith('step_') ? .02 : undefined)); assert.deepEqual([all.out.status, all.out.reason, all.out.stats.fillTurns], ['fallback-chat', 'nothing-left', 2])
  // prose instead of the object, twice -> fill-invalid; an extra component in the reply is refused the same way; a wrong shape once is retried once
  const prose = await run(ORDER, { fill: () => null }); assert.deepEqual([prose.out.status, prose.out.reason, prose.out.stats.fillTurns, prose.out.stats.judgeRequests], ['fallback-chat', 'fill-invalid', 2, 3])
  const greedy = await run(ORDER, { fill: () => ({ ...fillReply(['P1', 'P2', 'P3']), items: { ...fillReply(['P1', 'P2', 'P3']).items, P4: FILL.P2 } }) }); assert.deepEqual([greedy.out.reason, greedy.out.detail], ['fill-invalid', 'extra-item'])
  const once = await run(ORDER, { fill: (asked, n) => (n === 1 ? { nonsense: true } : fillReply(asked.guide.items.map(i => i.id))) }); assert.deepEqual([once.out.status, once.out.stats.fillTurns], ['presented', 2])
  const noEngine = await run(ORDER, { fill: null }); assert.deepEqual([noEngine.out.status, noEngine.out.reason], ['fallback-chat', 'fill-invalid'])
  // bounds: at most 6 judgment requests (place, fit, order, check and one re-check per rewrite round) and 3 private turns; slow judgments stop the flow inside the chrome's wait
  assert.ok(SKELETON_LIMITS.maxRequests >= 3 + SKELETON_LIMITS.fillTurns, 'the request bound covers the longest path'); assert.ok(BRIEFING_ENGINE_LIMITS.totalMs + SKELETON_LIMITS.judgeMs + 4000 < 150000)
  let clock = 0; const slow = await run(ORDER, { now: () => (clock += 15_000) }) // every judgment takes 15 s on this clock
  assert.deepEqual([slow.out.status, slow.out.reason, slow.out.stats.judgeRequests, slow.fills.length], ['fallback-chat', 'request-bound', 3, 1])
})

// ================= 7. the same permissions as the run's models =================
test('egress: one shared gate; no run -> nothing asked; no memory class -> no materials; no canvas class -> no existing card is listed', async () => {
  const flow = egress => { const judge = direct(ORDER); return runSkeletonFlow({ request: REQUEST, materials: QUOTE, candidates: boardCards(), currentAnswerId: 'ans-now', viewport: VIEW, judge, egress, fill: async asked => fillReply(asked.guide.items.map(i => i.id)) }).then(out => ({ out, judge })) }
  const gate = perms => createEgressGate(modelDataPermissions(perms))
  const noRun = await flow(gate({ canvasMaySend: true, memoryScope: {} })); assert.deepEqual([noRun.out.status, noRun.out.reason, noRun.judge.calls.length], ['bubble', 'declined', 0])
  const noMemory = await flow(gate({ canvasMaySend: true, runActive: true })); assert.deepEqual([noMemory.out.status, noMemory.out.reason, noMemory.judge.calls.length], ['bubble', 'no-materials', 0])
  const noCanvas = await flow(gate({ runActive: true, memoryScope: {} })); assert.equal(noCanvas.out.status, 'presented')
  assert.ok(!JSON.stringify(noCanvas.judge.calls.map(c => c.packet)).includes('지난주 견적 요약')); assert.deepEqual(noCanvas.out.reuse.reuse, [], 'the card is not reused because it was never listed'); assert.deepEqual(noCanvas.out.guide.retrievals, [])
  const all = await flow(gate({ canvasMaySend: true, runActive: true, memoryScope: {} })); assert.deepEqual(all.out.reuse.reuse, ['T1'])
  assert.ok(EGRESS_SITES['egdesk-board-presentation-http.mjs'].some(line => line.startsWith('briefing_skeleton:') && line.includes('draft_text') && line.includes('memory_page') && line.includes('canvas_text')))
  const source = readFileSync(new URL('helper/egdesk-briefing-skeleton.mjs', root), 'utf8'); assert.ok(!/\.decide\(|fetch\(|choiceQuestion/.test(source), 'the loop itself sends nothing, and builds no choice question')
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
const guideIds = prompt => JSON.parse(/Design guide \(decided; do not change it\):\n(.*)\n\nMaterials:/s.exec(prompt)[1]).items.map(i => i.id)
test('mounted journey: 4 judgment requests and ONE private fork turn; three cards are built by code and published by the finished run, then the briefing that reuses the v1 card', async t => {
  const s = await mounted(t, { forkReply: () => fence(fillReply(['P1', 'P2', 'P3'])) })
  assert.deepEqual(Object.keys(s.body), ['flow', 'conversationId', 'runId', 'report', 'currentAnswerId', 'candidates', 'request', 'viewport'])
  const outputsBefore = s.count('output.published'), completedAt = s.h.events.findIndex(e => e.event === 'run.completed'), messages = s.count('message.completed')
  const res = await s.R.http('POST', '/decision/briefing-observe', s.body)
  assert.equal(res.body.outcome, 'presented', JSON.stringify(res.body)); assert.deepEqual([res.body.order, res.body.judgeRequests, res.body.fillTurns, res.body.steps, res.body.newComponents], ['skeleton', 4, 1, 3, 3])
  assert.deepEqual(res.body.stages, ['place', 'fit', 'order', 'fill_check']); assert.deepEqual(res.body.retrievals, [{ viewId: 'res-old' }])
  // the subjective model: one private turn, and its prompt is the guide and the materials only
  assert.equal(s.h.forkPrompts.length, 1); assert.equal(s.h.native.filter(([m]) => m === 'thread/fork').length, 1)
  const prompt = s.h.forkPrompts[0]; for (const piece of ['Design guide (decided; do not change it)', '"component":"result_compare"', '"pointsAt":[{"alias":"N1","new":true},{"alias":"T1","new":false,"label":"A사 견적서 v1"}]', 'A사 미팅 메모', '"unfillable"']) assert.ok(prompt.includes(piece), piece)
  for (const absent of ['<answer>', '11월 14일에 v2로 진행하기로', 'res-v1', s.v1.id, 'Board components you may point at']) assert.ok(!prompt.includes(absent), absent)
  // the Decision model: four requests of yes/no questions over the request and the materials' own text; never an id
  assert.equal(s.decisions.length, 4); assert.ok(s.decisions.every(d => d.questions.every(q => q.type === 'predicate') && d.input.every(m => typeof m.content === 'string')))
  assert.deepEqual(s.decisions.map(d => d.prompt_cache_key), ['briefing-skeleton-place', 'briefing-skeleton-fit', 'briefing-skeleton-order', 'briefing-skeleton-fill_check'])
  const sent = JSON.stringify(s.decisions); for (const piece of [REQUEST, 'A사 견적 결정 메모', '납기 8주', 'A사 견적서 v1']) assert.ok(sent.includes(piece), piece)
  for (const absent of [s.v1.id, 'res-v1', s.h.ids.runId, ANSWER.slice(0, 20)]) assert.ok(!sent.includes(absent), absent)
  // published: the three new results first, then the proposal; the answer was already complete; no new chat message
  const after = s.h.events.slice(completedAt + 1).map(e => e.event).filter(e => e !== 'context.bound'); assert.deepEqual(after, ['output.published', 'output.published', 'output.published', 'briefing.published'])
  assert.equal(s.count('output.published'), outputsBefore + 3); assert.equal(s.count('message.completed'), messages)
  assert.deepEqual(s.h.events.filter(e => e.event === 'output.published').slice(-3).map(e => e.details.output.title), ['A사 견적 v1 → v2', 'A사 견적 진행 순서', 'A사 견적 남은 일'])
  const briefing = s.h.chat.runFor(s.h.ids).context.briefings.at(-1)
  assert.equal(briefing.presentationStatus, 'proposed'); assert.equal(briefing.title, 'A사 견적 정리'); assert.equal(validBriefing({ id: briefing.id, title: briefing.title, steps: briefing.steps }), true)
  assert.deepEqual(briefing.steps.map(x => [x.targets.length, x.emphasis ?? 'spotlight']), [[2, 'outline'], [1, 'spotlight'], [1, 'spotlight']]); assert.equal(briefing.steps[0].targets[0].viewId, 'res-v1', 'the existing v1 card is a target of the compare step')
  assert.equal(briefing.steps[2].text, FILL.P3.text); assert.equal(s.R.budget.snapshot().inputTokens, 44)
  // once per answer
  assert.deepEqual((await s.R.http('POST', '/decision/briefing-observe', s.body)).body, { status: 'skipped', reason: 'already' })
})
test('mounted, single version: the compare card is never published; two cards and a two-step briefing are', async t => {
  const s = await mounted(t, { materials: SINGLE_VERSION, script: { fit_P1_result_compare: .04 }, forkReply: prompt => fence(fillReply(guideIds(prompt))) })
  const before = s.count('output.published'), res = await s.R.http('POST', '/decision/briefing-observe', s.body)
  assert.deepEqual([res.body.outcome, res.body.judgeRequests, res.body.fillTurns, res.body.steps, res.body.newComponents], ['presented', 4, 1, 2, 2], JSON.stringify(res.body)); assert.deepEqual(guideIds(s.h.forkPrompts[0]), ['P2', 'P3'])
  assert.equal(s.count('output.published'), before + 2); assert.ok(!s.h.events.filter(e => e.event === 'output.published').some(e => e.details.output.title === 'A사 견적 v1 → v2'))
  assert.equal(s.h.chat.runFor(s.h.ids).context.briefings.at(-1).steps.length, 2)
  // judged to fit, then the model reports the rows as unfillable: the same end, by rule, without another request
  const late = await mounted(t, { materials: SINGLE_VERSION, forkReply: () => fence(fillReply(['P1', 'P2', 'P3'], { unfillable: [{ item: 'P1', slot: 'rows', reason: 'no second version' }, { item: 'P1', slot: 'left', reason: '' }, { item: 'P1', slot: 'right', reason: '' }] })) })
  const again = await late.R.http('POST', '/decision/briefing-observe', late.body); assert.deepEqual([again.body.outcome, again.body.judgeRequests, again.body.fillTurns, again.body.steps, again.body.newComponents], ['presented', 4, 1, 2, 2])
})
test('mounted: bubble, nothing fits, no materials, a model that will not fill -> the chat answer stays, nothing is published; the earlier order is still there behind the switch', async t => {
  const quiet = async (options, expect) => { const s = await mounted(t, options); const before = s.h.events.length, res = await s.R.http('POST', '/decision/briefing-observe', s.body)
    assert.deepEqual([res.body.outcome, res.body.reason, res.body.judgeRequests, res.body.fillTurns], expect, JSON.stringify(res.body)); assert.deepEqual(s.h.events.slice(before).map(e => e.event), [], 'no event of any kind'); return s }
  await quiet({ script: { one_sentence: .97 } }, ['bubble', 'judged-bubble', 1, 0])
  await quiet({ script: q => (q.name.startsWith('fit_') ? .04 : undefined) }, ['bubble', 'no-component-fits', 2, 0])
  const none = await quiet({ materials: [] }, ['bubble', 'no-materials', 0, 0]); assert.equal(none.decisions.length, 0, 'without materials nothing is asked')
  const prose = await quiet({ forkReply: () => 'I would start with the comparison.' }, ['fallback-chat', 'fill-invalid', 3, 2]); assert.equal(prose.h.forkPrompts.length, 2)
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
  assert.equal(BriefingHost.observeRequest({ mode: 'on', report: 'nothing named', candidates: two }), null); assert.equal(BriefingHost.observeRequest({ mode: 'advisory', report: 'nothing named', candidates: two }), null)
  const on = BriefingHost.observeRequest({ mode: 'on', report: 'nothing named', candidates: [], request: `  ${REQUEST}\u0007 `, viewport: { x: 1, y: 2, width: 3, height: 4, zoom: 9 } })
  assert.deepEqual([on.request, on.viewport], [REQUEST, { x: 1, y: 2, width: 3, height: 4 }]); assert.deepEqual(Object.keys(BriefingHost.observeRequest({ mode: 'advisory', report: 'nothing named', candidates: [], conversationId: 'c', runId: 'r', request: REQUEST, viewport: VIEW })), ['conversationId', 'runId', 'report', 'currentAnswerId', 'candidates', 'request', 'viewport'], 'cycle 14: advisory sends the same facts, without `flow`')
  const surface = readFileSync(new URL('overlay/JS/eg-desk-surface.uc.js', root), 'utf8')
  assert.match(surface, /const request = thread\.messages\.slice\(0, thread\.messages\.indexOf\(message\)\)\.reverse\(\)\.find\(item => item\.role === 'user' && typeof item\.content === 'string'\)\?\.content \|\| '';/)
  const server = readFileSync(new URL('helper/codex-bridge-server.mjs', root), 'utf8'); assert.match(server, /order: process\.env\.EGDESK_BRIEFING_ORDER === 'design-first' \? 'design-first' : 'skeleton'/)
})

// ================= 8. cycle 14: the real turn memory, links and provenance instead of titles, advisory in the new order =================
test('links and provenance: unrelated materials are not mixed; held rows are options only; a card is matched by what it was built from before its title', () => {
  const other = [row('M5', 'B사 견적 요청', 'B사가 11월 10일 케이스 500개 견적을 요청했다.', '2026-11-10', 'done'), row('M6', 'B사 견적서 v1 발송', '11월 12일 B사에 견적서 v1을 발송했다.', '2026-11-12', 'done', [{ type: 'follows_from', toAlias: 'M5' }])]
  const mixed = enumerateSkeleton({ materials: [...QUOTE, ...other], candidates: boardCards(), currentAnswerId: 'ans-now' })
  assert.deepEqual(materialGroups(mixed.materials).map(g => g.map(m => m.alias).join()), ['M1,M2,M3,M4', 'M5,M6'], 'the records link the A사 materials to each other and the B사 ones to each other')
  assert.deepEqual(mixed.parts.map(p => [p.trait, p.materials.join()]), [['compare', 'M1,M2'], ['sequence', 'M1,M2,M3,M4'], ['open_items', 'M2,M4'], ['sequence', 'M5,M6']], 'one sequence per matter, never one list of every dated page')
  // rows the model only holds from earlier turns are not this answer's materials; they are used only when nothing was attached
  assert.deepEqual(normalizeMaterials([{ ...QUOTE[0] }, { ...other[0], held: true }]).map(m => m.title), ['A사 견적서 v1']); assert.deepEqual(normalizeMaterials([{ ...QUOTE[0], held: true }, { ...other[0], held: true }]).length, 2)
  // lane L7's key is a NON-ENUMERABLE property of the frozen row: read from the original, never copied into a request
  const keyed = (r0, hex) => Object.freeze(Object.defineProperty({ ...r0 }, 'key', { value: hex.repeat(16), enumerable: false }))
  const rows = [keyed(QUOTE[0], 'a1'), keyed(QUOTE[1], 'b2'), keyed(QUOTE[2], 'c3'), keyed(QUOTE[3], 'd4')]
  assert.deepEqual(normalizeMaterials(rows).map(m => m.key.slice(0, 4)), ['a1a1', 'b2b2', 'c3c3', 'd4d4']); assert.ok(!JSON.stringify(rows).includes('a1a1'))
  assert.match(normalizeMaterials(QUOTE)[0].key, /^t:[a-f0-9]{32}$/, 'a row without a key gets a fingerprint of its title, date and kind'); assert.equal(normalizeMaterials(QUOTE)[0].key, normalizeMaterials([{ ...QUOTE[0], excerpt: 'edited text' }])[0].key)
  // provenance first: a card with a DIFFERENT title that this flow built from M1 shows M1; the card with M1's title is then not needed
  const card = (id, outputId, label, extra = {}) => ({ id, ref: { outputId, viewId: id }, kind: 'output', label, onBoard: true, maySend: true, rect: r(100, 120, 560, 560), owner: 'agent', createdForAnswer: 'ans-earlier', superseded: false, stale: false, visibility: 'visible', ...extra })
  const O = n => `${String(n).repeat(8)}-${String(n).repeat(4)}-4${String(n).repeat(3)}-8${String(n).repeat(3)}-${String(n).repeat(12)}`
  const bindings = new Map([[O(5), { keys: ['a1'.repeat(16)], trait: 'single', component: 'result_text' }], [O(6), { keys: ['a1', 'b2', 'c3', 'd4'].map(x => x.repeat(16)), trait: 'sequence', component: 'result_lines' }]])
  const scene = enumerateSkeleton({ materials: rows, candidates: [card('res-x', O(5), '첫 견적 정리'), card('res-seq', O(6), '진행 순서'), card('res-title', O(7), 'A사 견적서 v1')], bindings })
  assert.deepEqual([...scene.shows], [['M1', 'T1']]); assert.deepEqual([...scene.how], [['M1', 'provenance']]); assert.deepEqual([...scene.built], [['P2', 'T2']])
  assert.deepEqual(scene.parts.map(p => p.options.map(o => o.value).join()), ['result_compare', 'reuse_T2', 'result_lines'], 'the sequence card that already exists can only be reused, never built again')
  // without a binding: the same title exactly; a title that is only PART of several titles matches nothing (no guess)
  assert.deepEqual([...enumerateSkeleton({ materials: rows, candidates: [card('res-title', O(7), 'A사 견적서 v1')] }).how], [['M1', 'title']])
  assert.deepEqual([...enumerateSkeleton({ materials: rows, candidates: [card('res-part', O(7), 'A사 견적')] }).shows], [], '"A사 견적" is inside three titles: ambiguous, so no card is claimed')
  assert.deepEqual([...enumerateSkeleton({ materials: rows, candidates: [card('res-part', O(7), '견적서 v1')] }).how], [['M1', 'title-part']], 'inside exactly one title')
  // provenance of the card itself: superseded or stale cards never show anything; a binding to materials that are not in this turn matches nothing
  assert.deepEqual([...enumerateSkeleton({ materials: rows, candidates: [card('res-x', O(5), '첫 견적 정리', { superseded: true, createdForAnswer: 'ans-now' })], bindings }).shows], [])
  assert.deepEqual([...enumerateSkeleton({ materials: other, candidates: [card('res-x', O(5), '첫 견적 정리')], bindings }).shows], [])
})

const autoFill = prompt => {
  // A subjective model that follows the guide literally: one value of the right type for every listed slot, from the listed materials.
  const guide = JSON.parse(/Design guide \(decided; do not change it\):\n(.*)\n\nMaterials:/s.exec(prompt)[1]), only = /Fill only these items again: (.+)\./.exec(prompt)?.[1].split(', ')
  const value = (slot, item, n = 0) => (slot.type === 'text' ? `${slot.name} ${n + 1}`.slice(0, slot.max) : slot.type === 'material' ? item.materials[n % item.materials.length]
    : Array.from({ length: Math.max(slot.min, Math.min(slot.max, item.materials.length)) }, (_, i) => Object.fromEntries(slot.of.map(f => [f.name, value(f, item, i)]))))
  const items = Object.fromEntries(guide.items.map(item => [item.id, { text: `${item.shows} 설명`, fallback: '카드를 열어 보세요.', slots: Object.fromEntries(item.slots.map((s, i) => [s.name, value(s, item, s.name === 'right' ? 1 : 0)])) }]))
  return fence(only ? { items } : { title: 'A사 견적 정리', items })
}
const realMemory = () => ({ mode: () => 'on', configured: () => true, settingsGeneration: () => 0, budgetMs: 800, client: mockJudge(), collect: async () => [],
  // Lane L7's turn memory, on, over its public synthetic wiki; eligible() stands in for "a direct conversation" (this harness has no Agent profile).
  turnMemory: { mode: () => 'on', wiki: async () => buildWiki(SYNTHETIC_PAGES), scope: () => ({ allowedScopes: ['dm:this-room'], writeScope: 'dm:this-room' }), budget: { linksFirst: true }, ontologyWrite: false, eligible: () => true } })

test('mounted on the REAL turn memory: the materials are what lane L7 attached to this answer\'s turn; the unrelated page gets no card', async t => {
  const h = await harness(t, { message: REQUEST, decisionContext: realMemory(), forkReply: prompt => autoFill(prompt) })
  await h.finish(ANSWER); await h.chat.turnMemoryIdle()
  const run = h.chat.runFor(h.ids), rows = h.chat.memoryMaterialsFor(run)
  assert.equal(h.chat.memoryMaterialsState(run), 'attached'); assert.ok(rows.length >= 5 && rows.every(m => m.held === false), `the real loop attached ${rows.length} pages`)
  assert.deepEqual(rows.filter(m => m.title.startsWith('A사')).map(m => m.title), ['A사 견적 요청 접수', 'A사 견적서 v1 발송', 'A사 단가 협의 메모', 'A사 견적서 v2 수정 계획', 'A사 건 결정 메모'])
  const decisions = []
  const provider = async (_url, init) => { const body = JSON.parse(init.body); decisions.push(body); return Response.json({ answers: answersFor(body.questions, { fit_P4_result_text: .03 }), usage: { input_tokens: 11 } }) }
  // the bridge's own dependency factory, unchanged: materialsFor is chat.memoryMaterialsFor
  const R = rig(t, { mode: 'on', handlerOptions: { briefing: briefingDeps({ chat: h.chat, contexts: h.contexts, enabled: true }), fetchImpl: provider } })
  const body = BriefingHost.observeRequest({ mode: 'on', report: ANSWER, answerId: h.ids.answerId, conversationId: h.ids.conversationId, runId: h.ids.runId, candidates: [], request: REQUEST, viewport: VIEW })
  const res = await R.http('POST', '/decision/briefing-observe', body)
  assert.equal(res.body.outcome, 'presented', JSON.stringify(res.body)); assert.equal(res.body.order, 'skeleton'); assert.deepEqual([res.body.steps, res.body.newComponents, res.body.fillTurns, res.body.judgeRequests], [3, 3, 1, 4])
  // parts came from the recorded links and dates of those pages: v1 against the v2 plan, the dated A사 pages in order, the open plan; the unrelated B사 page on its own
  const fit = decisions[1].questions
  assert.deepEqual(fit.map(q => q.name), ['fit_P1_result_compare', 'fit_P2_result_lines', 'fit_P3_result_lines', 'fit_P4_result_text'])
  assert.ok(fit[0].instructions.includes('M2 {"title":"A사 견적서 v1 발송"') && fit[0].instructions.includes('M4 {"title":"A사 견적서 v2 수정 계획","status":"plan","text":"단가 12,200원'), 'the question quotes the two versions\' own text')
  assert.ok(fit[3].instructions.includes('M6 {"title":"B사 견적 요청"') && !fit[1].instructions.includes('B사'), 'the unrelated page is asked about on its own and is not in the A사 sequence')
  // order: the dated pages come before the plan by record; only the pairs the record leaves open are asked
  assert.deepEqual(decisions[2].questions.map(q => q.name), ['before_P1_P2', 'before_P1_P3'])
  const sent = JSON.stringify(decisions); for (const absent of ['quote/a-', '"key"', '"held"', '"provenance"', 'rev=']) assert.ok(!sent.includes(absent), `no ${absent} reaches the Decision model`)
  assert.ok(h.forkPrompts[0].includes('A사 건 결정 메모') && !h.forkPrompts[0].includes('quote/a-') && !h.forkPrompts[0].includes('B사 견적 요청 "'))
  assert.equal(h.events.filter(e => e.event === 'output.published').length, 3); assert.equal(h.chat.runFor(h.ids).context.briefings.at(-1).steps.length, 3)
  // turn memory off: the accessor gives nothing, and only then is the outcome no-materials
  const off = await harness(t, { message: REQUEST }); await off.finish(ANSWER)
  const R2 = rig(t, { mode: 'on', handlerOptions: { briefing: briefingDeps({ chat: off.chat, contexts: off.contexts, enabled: true }), fetchImpl: provider } })
  const none = await R2.http('POST', '/decision/briefing-observe', BriefingHost.observeRequest({ mode: 'on', report: ANSWER, answerId: off.ids.answerId, conversationId: off.ids.conversationId, runId: off.ids.runId, candidates: [], request: REQUEST }))
  assert.deepEqual([none.body.outcome, none.body.reason, none.body.judgeRequests], ['bubble', 'no-materials', 0])
})
test('mounted, the next answer: the cards the first briefing built are recognised by what they were built from and reused; nothing is built twice', async t => {
  const s = await mounted(t, { forkReply: prompt => autoFill(prompt) })
  const first = await s.R.http('POST', '/decision/briefing-observe', s.body); assert.deepEqual([first.body.outcome, first.body.newComponents], ['presented', 3])
  const made = s.h.events.filter(e => e.event === 'output.published').slice(-3).map(e => e.details.output)
  // the person asks again in the same conversation; the three cards are on the board now (kept from the first briefing), with new titles the materials do not share
  const next = await s.h.chat.send({ message: 'A사 견적 건 다시 정리해줘', requestId: 'req-2', clientThreadId: 'ui', conversationId: s.h.ids.conversationId, cwd: s.h.cwd, contextCapabilities: { read: true, reader: true, publishBriefing: true } })
  const timing = { threadId: next.conversationId, turnId: next.runId }, notify = (method, params) => s.h.chat.handleNotification({ method, params })
  await notify('item/completed', { ...timing, item: { id: 'ans2', type: 'agentMessage', phase: 'final_answer', text: ANSWER } }); await notify('turn/completed', { threadId: timing.threadId, turn: { id: timing.turnId, status: 'completed', items: [] } })
  for (let i = 0; i < 8; i++) await new Promise(res => setTimeout(res, 2))
  const message = { id: 'm1', conversationId: s.h.ids.conversationId, runId: s.h.ids.runId, answerId: s.h.ids.answerId, createdAt: 1 }
  const cards = made.map((meta, i) => ({ id: `res-new-${i + 1}`, kind: 'result', rect: r(700 + 600 * i, 120, 560, 560), record: ChatState.publishedOutputCardRecord({ ...thread, conversationId: s.h.ids.conversationId }, message, meta, `# ${meta.title}\n본문`, { now: 3 }) }))
  const before = s.count('output.published'), asked = s.decisions.length
  const body = BriefingHost.observeRequest({ mode: 'on', report: ANSWER, answerId: next.answerId, conversationId: next.conversationId, runId: next.runId, candidates: BriefingHost.canvasBriefingCandidates(cards), request: 'A사 견적 건 다시 정리해줘', viewport: VIEW })
  const res = await s.R.http('POST', '/decision/briefing-observe', body)
  assert.equal(res.body.outcome, 'presented', JSON.stringify(res.body)); assert.deepEqual([res.body.steps, res.body.newComponents], [3, 0], 'three steps, no new card')
  assert.equal(s.count('output.published'), before, 'nothing was published again')
  assert.deepEqual(s.decisions[asked + 1].questions.map(q => q.name), ['fit_P1_reuse_T1', 'fit_P2_reuse_T2', 'fit_P3_reuse_T3'], 'building them again is not even asked about')
  assert.ok(s.decisions[asked + 1].questions[1].instructions.includes('the card that is already on the board for exactly these materials'))
  assert.deepEqual(s.decisions.at(-1).questions.map(q => q.name), ['step_P1', 'step_P2', 'step_P3'], 'a reused card has no slots to check: only its explanation')
  assert.deepEqual(s.h.chat.runFor({ conversationId: next.conversationId, runId: next.runId, answerId: next.answerId }).context.briefings.at(-1).steps.map(x => x.targets[0].viewId), ['res-new-1', 'res-new-2', 'res-new-3'])
})
test('advisory recording: place and fit are asked and recorded for the finished answer, nothing else happens; no engine is needed', async t => {
  const s = await mounted(t, { enabled: false })
  const R = rig(t, { mode: 'advisory', handlerOptions: { briefing: { ...briefingDeps({ chat: s.h.chat, contexts: s.h.contexts, enabled: false }), materialsFor: () => QUOTE }, fetchImpl: async (_u, init) => { const b = JSON.parse(init.body); s.decisions.push(b); return Response.json({ answers: answersFor(b.questions, ORDER), usage: { input_tokens: 11 } }) } } })
  const body = BriefingHost.observeRequest({ mode: 'advisory', report: ANSWER, answerId: s.h.ids.answerId, conversationId: s.h.ids.conversationId, runId: s.h.ids.runId, candidates: s.body.candidates, request: REQUEST, viewport: VIEW })
  assert.equal(body.flow, undefined); const events = s.h.events.length
  const res = await R.http('POST', '/decision/briefing-observe', body)
  assert.deepEqual(res.body, { status: 'observed', stages: ['place', 'fit'], outcome: 'advisory-only', judgeRequests: 2, order: 'skeleton', fillTurns: 0 })
  assert.deepEqual(s.decisions.map(d => d.questions.map(q => q.name).join()), ['several,one_sentence', 'fit_P1_result_compare,fit_P2_result_lines,fit_P3_result_lines']); assert.equal(s.h.events.length, events, 'no event'); assert.equal(s.h.forkPrompts.length, 0)
  const recorded = R.calibration.entries().filter(e => e.feature === 'board_arrangement'); assert.deepEqual(recorded.map(e => [e.mode, e.judgments.length]), [['advisory', 2], ['advisory', 3]], 'content-free calibration entries of the skeleton judge')
  assert.deepEqual((await R.http('POST', '/decision/briefing-observe', { ...body, runId: 'gone' })).body, { status: 'skipped', reason: 'run-gone' })
  // a handler without the bridge's dependency factory keeps the earlier recording (placement + reuse on the report)
  const old = rig(t, { mode: 'advisory', script: () => ({ placement: { value: 'bubble', p: .9 } }) })
  assert.equal((await old.http('POST', '/decision/briefing-observe', { report: 'The A사 견적서 v1 and the 지난주 견적 요약 are on the board.', currentAnswerId: 'x', candidates: s.body.candidates })).body.order, undefined)
})
