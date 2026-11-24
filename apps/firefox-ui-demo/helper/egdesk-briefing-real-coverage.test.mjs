// L4 cycle 36: Main's check-11 on the real engine. The fill was valid and fast; the flow still ended fallback-chat / not-covered after the rewrite. Per answer fact (by the materials,
// not by the judge): F3/F4/F5/F6 are on the board and the judge said yes; F1 "devlog 기록을 날짜순으로 정리했습니다." and F2 "파일은 변경하지 않았습니다." are statements ABOUT the
// answer (no material says them), the judge said no, and they were enforced because no code anchor ties them to a material (cites null = "any material may hold it").
// The fix asks the judge, in the same coverage request, whether such a sentence restates something the materials say; a decided no is "no board can show it" (recorded, not
// missing). Everything below is the real answer, the real fill replies and the judge's real per-fact answers of the schema-on conversation of check-11.
import assert from 'node:assert/strict'
import test from 'node:test'
import { SKELETON_JUDGE, answerFacts, factCites, normalizeMaterials, runSkeletonFlow } from './egdesk-briefing-skeleton.mjs'
import { folderMaterials } from './egdesk-real-engine-briefing-hook.mjs'
import { buildBoardScript, BOARD_SAY } from './egdesk-briefing-real-engine-script.mjs'

const rows = folderMaterials(buildBoardScript().conversations[0].folder), MATS = normalizeMaterials(rows)
const ANSWER = '| 날짜 | 진행 상황 | 커밋 ID | 테스트 |\n|---|---|---|---|\n| [11-20](/x/devlog/11-20.md) | 로그인 화면 병합 완료 | `a1b2c3d` | 120건 통과 |\n| [11-22](/x/devlog/11-22.md) | 결제 모듈 병합 완료. 알림 설정 화면은 시안만 확정 | `e4f5a6b` | 98건 통과 |\n| [11-24](/x/devlog/11-24.md) | 검색 화면 착수 | 기록 없음 | 기록 없음 |\n\n기록된 테스트 통과 건수의 합계는 **218건**입니다. 최신 기록 기준 남은 작업은 **알림 설정 구현, 검색 성능 점검, 배포 체크리스트 작성**입니다.\n'
const PREFIX = 'devlog 기록을 날짜순으로 정리했습니다. 파일은 변경하지 않았습니다.\n\n'
const REAL_ANSWER = PREFIX + ANSWER
// the whole fill the real engine wrote (check-11, schema-on, reply 0): a sequence card whose lines are all null (copied by code) and an open-items card it wrote itself
const REAL_FILL = { title: '작업 진행 경과와 남은 일', items: { P1: { text: '작업 진행 흐름을 시간순으로 정리', slots: { title: '진행 경과', lines: [{ label: null, text: null, from: 'M1' }, { label: null, text: null, from: 'M2' }, { label: null, text: null, from: 'M3' }] } },
  P2: { text: '후속 작업으로 남은 항목을 정리', slots: { title: '남은 일', lines: [{ label: '구현', text: '알림 설정 구현', from: 'M3' }, { label: '점검', text: '검색 성능 점검', from: 'M3' }, { label: '작성', text: '배포 체크리스트 작성', from: 'M3' }] } } }, unfillable: [] }
// what the judge answered per fact of the answer in check-11 (onboard_F#), by the fact's text
const REAL_ONBOARD = { 'devlog 기록을 날짜순으로 정리했습니다.': 0, '파일은 변경하지 않았습니다.': 0, '11-20 · 로그인 화면 병합 완료 · a1b2c3d · 120건 통과': 1, '11-22 · 결제 모듈 병합 완료. 알림 설정 화면은 시안만 확정 · e4f5a6b · 98건 통과': 1, '11-24 · 검색 화면 착수': 1,
  '기록된 테스트 통과 건수의 합계는 218건입니다.': .56, '최신 기록 기준 남은 작업은 알림 설정 구현, 검색 성능 점검, 배포 체크리스트 작성입니다.': 1 }
// what a judge that reads the sentence against the materials says (the stated question): the two sentences about the answer itself are not statements of the materials
const META = new Set(['devlog 기록을 날짜순으로 정리했습니다.', '파일은 변경하지 않았습니다.'])

function harness({ stated = text => (META.has(text) ? .02 : .97), onboard = text => REAL_ONBOARD[text] ?? .9, fillReplies = [REAL_FILL] } = {}) {
  const tickets = new Map(), calls = [], fills = []
  const judge = { prepare: async dto => { const p = SKELETON_JUDGE.prepare({ mode: 'on', binding: 'b', dto }); assert.equal(p.status, 'prepared', 'the packet is a closed, valid request'); const t = `t${tickets.size + 1}`; tickets.set(t, { p, dto }); return { status: 'prepared', ticket: t, preview: { packet: p.packet } } },
    run: async t => { const { p, dto } = tickets.get(t); const factOf = q => dto.questions.find(x => `onboard_${x.fact}` === q.name || `stated_${x.fact}` === q.name)?.text
      const answers = Object.fromEntries(p.packet.questions.map(q => { const text = factOf(q); const probability = q.name.startsWith('stated_') ? stated(text) : q.name.startsWith('onboard_') ? onboard(text) : q.name.startsWith('same_') ? .03 : .97; return [q.name, { name: q.name, type: 'predicate', probability }] }))
      calls.push({ stage: dto.stage, names: p.packet.questions.map(q => q.name), packet: p.packet }); return SKELETON_JUDGE.read(p, answers, 'b').reply }, cancel: async () => {} }
  const fill = async want => { fills.push(want); return structuredClone(fillReplies[Math.min(fills.length, fillReplies.length) - 1]) }
  return { judge, calls, fills, fill, run: () => runSkeletonFlow({ request: BOARD_SAY, answer: REAL_ANSWER, materials: rows, candidates: [], currentAnswerId: null, viewport: { x: 0, y: 0, width: 2400, height: 1400 }, judge, fill, observeOnly: false }) }
}

test('the answer\'s facts, by the materials: two statements about the answer, a derived sum, and four content facts that the board shows', () => {
  const { facts, cut } = answerFacts(REAL_ANSWER)
  assert.deepEqual(facts, ['devlog 기록을 날짜순으로 정리했습니다.', '파일은 변경하지 않았습니다.', '11-20 · 로그인 화면 병합 완료 · a1b2c3d · 120건 통과', '11-22 · 결제 모듈 병합 완료. 알림 설정 화면은 시안만 확정 · e4f5a6b · 98건 통과', '11-24 · 검색 화면 착수',
    '기록된 테스트 통과 건수의 합계는 218건입니다.']); assert.equal(cut, 1)
  assert.deepEqual(facts.map(f => factCites(f, MATS)), [null, null, ['M1'], ['M2'], null, []], 'the two statements about the answer and the 11-24 row have no code anchor; the sum is anchored and no material holds it')
})

test('check-11 reproduced: the two sentences about the answer no longer block; the fill is checked and the coverage asked ONCE; the board is presented', async () => {
  const h = harness(), out = await h.run()
  assert.equal(out.status, 'presented', JSON.stringify({ reason: out.reason, coverage: out.coverage }))
  assert.deepEqual(h.calls.map(c => c.stage), ['place', 'fit', 'order', 'fill_check', 'coverage']); assert.equal(h.fills.length, 1, 'no rewrite round: nothing was missing')
  const cov = h.calls.at(-1); assert.deepEqual(cov.names, ['onboard_F1', 'onboard_F2', 'onboard_F3', 'onboard_F4', 'onboard_F5', 'onboard_F6', 'stated_F1', 'stated_F2', 'stated_F5'], 'every fact is asked if the board shows it; the three without a code anchor are also asked if the materials state them')
  assert.deepEqual([out.coverage.missing, out.coverage.unshowable], [[], ['F1', 'F2']], 'a decided "no" on stated: no board can show it (recorded)')
  assert.deepEqual(out.coverage.facts.map(f => [f.id, f.p, f.stated ?? null]), [['F1', 0, .02], ['F2', 0, .02], ['F3', 1, null], ['F4', 1, null], ['F5', 1, .97], ['F6', .56, null]])
  // the request is closed and carries the materials once (not per question) and the rule that mentions them
  assert.ok(cov.packet.input[0].content.includes('quoted materials') && cov.packet.input[1].content.split('The materials, each quoted as JSON:').length === 2)
  const stated = cov.packet.questions.find(q => q.name === 'stated_F1').instructions
  assert.ok(stated.includes('"devlog 기록을 날짜순으로 정리했습니다."') && stated.includes('restate something that the materials quoted above say'), 'the sentence is quoted alone; the materials are quoted once above')
  assert.ok(!cov.packet.input.some(m => m.content.includes('| 날짜 | 진행 상황 |')), 'the answer itself is not sent, only the facts'); assert.ok(!cov.packet.questions.find(q => q.name === 'onboard_F3').instructions.includes('stated'))
})

test('the direction stays conservative: an undecided or a yes on "states the materials" still enforces the fact (missing -> the one rewrite -> chat); only a decided no excuses it', async () => {
  for (const stated of [.5, .97]) {
    const h = harness({ stated: text => (META.has(text) ? stated : .97), fillReplies: [REAL_FILL, REAL_FILL] }), out = await h.run()
    assert.deepEqual([out.status, out.reason, out.coverage.missing], ['fallback-chat', 'not-covered', ['F1', 'F2']], `stated ${stated}`)
    assert.equal(h.fills.length, 2, 'the one bounded rewrite ran'); assert.deepEqual(h.calls.map(c => c.stage).slice(-3), ['coverage', 'fill_check', 'coverage'])
    assert.deepEqual(h.calls.at(-1).names, ['onboard_F1', 'onboard_F2'], 'the second ask is only the missing facts, without the stated question')
  }
})

test('a content fact the board really lacks is still caught: the judge says it is on no board AND stated by the materials', async () => {
  // the board lacks the 11-24 row (a fill whose sequence card has two lines only): F5 "11-24 · 검색 화면 착수" is a statement of the materials and not shown
  const two = structuredClone(REAL_FILL); two.items.P1.slots.lines = two.items.P1.slots.lines.slice(0, 2)
  const h = harness({ onboard: text => (text.startsWith('11-24') ? 0 : REAL_ONBOARD[text] ?? .9), fillReplies: [two, two] }), out = await h.run()
  assert.deepEqual([out.status, out.reason, out.coverage.missing], ['fallback-chat', 'not-covered', ['F5']])
  assert.deepEqual(out.coverage.unshowable, ['F1', 'F2'], 'the two sentences about the answer are still not blamed on the board')
})
