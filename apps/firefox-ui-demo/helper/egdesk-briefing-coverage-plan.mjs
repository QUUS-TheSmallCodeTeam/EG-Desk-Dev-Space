// Lane L4 cycle 19/20: the briefing coverage re-measure plan (declarative format of scripts/egdesk-decision-real-measure.mjs). Builds the exact bytes the PRODUCT
// sends (runSkeletonFlow through the production Board/Decisions handler, with a local provider). Sends nothing, reads no key. The subjective model's fills are
// scripted; the Decision answers that steer the flow are scripted too (they only decide which request comes next, never what a body says).
// The product bars come from the code (SKELETON_BARS) in the runner's productBars schema, so the runner refuses any hard check looser than the product.
import { createHash } from 'node:crypto'
import { runSkeletonFlow, SKELETON_BARS } from './egdesk-briefing-skeleton.mjs'
import { memoryMaterials } from './egdesk-turn-memory.mjs'
import { buildWiki } from './egdesk-wiki-reconstruction.mjs'
import { SYNTHETIC_PAGES } from './egdesk-wiki-reconstruction.fixture.mjs'
import { DECISION_MODEL } from './egdesk-decision-client.mjs'
import { rig } from '../scripts/egdesk-briefing-rig.support.mjs'

export const BRIEFING_COVERAGE_SET = 'l4-briefing-coverage'
export const BRIEFING_COVERAGE_DIR = 'proofs/decision-real-measure/briefing-coverage'
export const BRIEFING_COVERAGE_CEILING = 4000
export const S3_REQUEST = '방금 그 내용 정리해줘'
export const S3_ANSWER = 'A사 견적은 11월 3일 요청, 11월 6일 v1 발송, v2는 팀장 승인 후 발송 예정입니다.'
const sha = bytes => createHash('sha256').update(bytes).digest('hex')
// lane L6's typed estimate + 15 %
const est = wire => { const body = JSON.parse(wire); return Math.ceil(1.15 * (134.8 * body.questions.length + 0.1983 * Buffer.byteLength(wire))) }
const SOURCE = 'egdesk-briefing-skeleton.mjs:19,347 SKELETON_BARS { yes .7, no .3 }: isYes iff p >= .7 (acted on), isNo iff p <= .3 (decided no); between is undecided'
/** The runner's schema: { family: { yes, no, source } } with the code's values. Every family this plan checks is named. */
export const productBars = () => Object.fromEntries(['combines', 'covers', 'about_M#', 'same_M#_M#'].map(f => [f, { yes: SKELETON_BARS.yes, no: SKELETON_BARS.no, source: SOURCE }]))

const wiki = buildWiki(SYNTHETIC_PAGES)
const rowsFor = ids => memoryMaterials({ memory: { status: 'ready', delivered: Object.fromEntries(ids.map(id => [id, true])), picks: [] }, held: [] }, wiki, { scope: { allowedScopes: ['dm:this-room'] } })
const bare = rows => rows.map(m => ({ title: m.title, excerpt: m.excerpt, status: 'unknown', time: { at: null }, links: [] }))

async function flow({ request, answer, materials, script = () => undefined, fill = null }) {
  const captured = [], cleanups = []
  const provider = async (_url, init) => { const body = JSON.parse(init.body); captured.push({ wire: init.body, names: body.questions.map(q => q.name), stage: body.prompt_cache_key })
    return Response.json({ answers: body.questions.map(q => ({ name: q.name, type: 'predicate', probability: script(q) ?? (q.name.startsWith('same_') ? .03 : .95) })), usage: { input_tokens: 1 } }) }
  const R = rig({ after: fn => cleanups.push(fn) }, { mode: 'on', handlerOptions: { fetchImpl: provider } })
  const root = '/decision/briefing-skeleton'
  const judge = { prepare: async dto => (await R.http('POST', `${root}/prepare`, dto)).body, run: async ticket => (await R.http('POST', `${root}/run`, { ticket, confirm: true })).body, cancel: async ticket => (await R.http('POST', `${root}/cancel`, { ticket })).body }
  try {
    const out = await runSkeletonFlow({ request, answer, materials, candidates: [], currentAnswerId: 'ans-now', viewport: { x: 0, y: 0, width: 2400, height: 1400 }, judge, fill })
    return { out, captured, all: stage => captured.filter(c => c.stage === `briefing-skeleton-${stage}`) }
  } finally { for (const fn of cleanups) fn() }
}
export const boardOf = wire => JSON.parse(JSON.parse(wire).questions[0].instructions.split('The board, its parts quoted in order as JSON: ')[1].split('. Does this board')[0])

/** -> { plan, planBytes, files: [{ file, bytes }], requests, flows, totals } — deterministic; sends nothing. */
export async function buildBriefingCoveragePlan() {
  // s3 exactly as the all-on run attached it (three A사 pages, no date, status or links); the place body no longer asks "several" (cycle 19)
  const S3_MATS = bare(rowsFor(['quote/a-v1', 'quote/a-v2-plan', 'quote/a-decision']))
  const place = await flow({ request: S3_REQUEST, answer: S3_ANSWER, materials: S3_MATS })
  // the s3 follow-up with the A사 request page attached too: every fact of the answer is in a material. M1 request, M2 v1, M3 v2 plan, M4 decision
  const FULL = bare(rowsFor(['quote/a-request', 'quote/a-v1', 'quote/a-v2-plan', 'quote/a-decision']))
  const PARTS = {
    M1: { text: '11월 3일 A사가 스피커 모듈 200개 견적을 요청했습니다.', fallback: '요청 카드를 열어 보세요.', slots: { title: 'A사 견적 요청', body: 'A사 구매팀이 11월 3일 스피커 모듈 200개 견적을 요청했다.' } },
    compare: { text: '11월 6일 보낸 v1과 아직 보내지 않은 v2의 단가를 나란히 봅니다.', fallback: '비교 카드를 열어 보세요.', slots: { title: 'A사 견적서 v1과 v2', left: 'M2', right: 'M3', rows: [{ aspect: '단가', left: '12,800원', right: '12,200원' }] } },
    M4: { text: 'v2는 팀장 승인 후 발송합니다. 승인 기한은 11월 25일입니다.', fallback: '결정 카드를 열어 보세요.', slots: { title: 'A사 건 결정', body: '11월 18일 회의에서 v2는 팀장 승인 후 발송하기로 결정했다. 승인 기한은 11월 25일이다.' } },
  }
  const fillFor = asked => ({ title: 'A사 견적 정리', items: Object.fromEntries(asked.guide.items.map(i => [i.id, i.component === 'result_compare' ? PARTS.compare : PARTS[i.materials[0]]])) })
  // versions as measured (c18 same_M1_M2 .96 for this pair); the order as it happened: the request (P2, 11/3) before the v1/v2 compare (P1), the decision (P3) last
  const ORDER = { before_P1_P2: .03, before_P1_P3: .95, before_P2_P3: .95 }
  const versions = q => (q.name.startsWith('same_') ? (q.name === 'same_M2_M3' ? .96 : .03) : ORDER[q.name])
  const complete = await flow({ request: S3_REQUEST, answer: S3_ANSWER, materials: FULL, script: versions, fill: fillFor })
  const without = await flow({ request: S3_REQUEST, answer: S3_ANSWER, materials: FULL, script: q => (q.name === 'fact_M4' ? .03 : q.name === 'covers' ? .05 : versions(q)), fill: fillFor })
  const asAttached = await flow({ request: S3_REQUEST, answer: S3_ANSWER, materials: S3_MATS, script: q => (q.name.startsWith('same_') ? (q.name === 'same_M1_M2' ? .96 : .03) : undefined),
    fill: asked => ({ title: 'A사 견적 정리', items: Object.fromEntries(asked.guide.items.map(i => [i.id, i.component === 'result_compare' ? { ...PARTS.compare, slots: { ...PARTS.compare.slots, left: 'M1', right: 'M2' } } : PARTS.M4])) }) })
  const pick = (f, stage, names) => { const c = f.all(stage)[0]; if (!c || (names && c.names.join() !== names)) throw new Error(`coverage plan: ${stage} is ${c?.names.join() ?? 'missing'}`); return c }
  const s3Place = pick(place, 'place', 'combines,about_M1,about_M2,about_M3,same_M1_M2'), cov1 = pick(complete, 'coverage', 'covers'), cov2 = pick(without, 'coverage', 'covers'), cov3 = pick(asAttached, 'coverage', 'covers')
  if (complete.out.status !== 'presented' || boardOf(cov1.wire).length !== 3) throw new Error(`coverage plan: complete is ${complete.out.status}`)
  if (without.out.status !== 'fallback-chat' || without.out.reason !== 'not-covered' || boardOf(cov2.wire).length !== 2 || JSON.stringify(boardOf(cov2.wire)).includes('팀장 승인')) throw new Error(`coverage plan: incomplete is ${without.out.status}`)
  if (asAttached.out.status !== 'presented' || boardOf(cov3.wire).length !== 2) throw new Error(`coverage plan: as-attached is ${asAttached.out.status}`)

  const YES = { min: SKELETON_BARS.yes }, NO = { max: SKELETON_BARS.no }
  const hard = (name, rest, note) => ({ name, kind: 'predicate', ...rest, severity: 'hard', note }), soft = (name, rest, note) => ({ name, kind: 'predicate', ...rest, severity: 'soft', note })
  const specs = [
    ['q-s3-place-new', s3Place, [hard('combines', YES, 'product bar: yes >= .7. The body the product now sends for s3 (no "several"); c18 measured .98 with "several" next to it'),
      soft('about_M1', YES, 'c18 .99'), soft('about_M2', YES, 'c18 .98'), soft('about_M3', YES, 'c18 .97'), soft('same_M1_M2', YES, 'c18 .96')]],
    ['q-cov-complete', cov1, [hard('covers', YES, 'product bar: yes >= .7 proposes the board. Every fact of the answer is on the board: 11/3 request (part 1), 11/6 v1 vs v2 not sent yet (part 2), v2 after the team lead approval, by 11/25 (part 3)')]],
    ['q-cov-incomplete', cov2, [hard('covers', NO, 'product bar: a decided no (<= .3) starts the one re-design. FLAGGED: the remaining-work part is removed; the compare text still says v2 is not sent, but not that it waits for the team lead approval or the 11/25 deadline. A reading of "not sent yet" as enough would answer yes')]],
    ['q-cov-as-attached', cov3, [soft('covers', NO, 'product bar: decided no <= .3. Recorded, not a pass condition: the s3 board as the all-on run attached it (no request page). The 11/3 request date of the answer is on no material, so the board cannot show it; a no here would send s3 back to chat for a memory gap (lane L7)')]],
  ]
  const files = [], requests = []
  for (const [id, c, expect] of specs) {
    const bytes = Buffer.from(c.wire, 'utf8'), body = JSON.parse(c.wire)
    if (body.model !== DECISION_MODEL || Object.keys(body).some(k => !['model', 'input', 'questions', 'prompt_cache_key'].includes(k)) || body.questions.some(q => q.type !== 'predicate')) throw new Error(`${id}: not a plain predicate body`)
    files.push({ file: `requests/${id}.json`, bytes })
    requests.push({ id, file: `requests/${id}.json`, sha256: sha(bytes), estInputTokens: est(c.wire), expect })
  }
  const plan = { set: BRIEFING_COVERAGE_SET, tokenCeiling: BRIEFING_COVERAGE_CEILING, productBars: productBars(),
    passRule: 'PASS when every hard check passes at the product bar: the s3 answer is still judged to combine several facts without the "several" question next to it (yes >= .7), the complete s3 board is judged to cover the request (yes >= .7) and the board without its remaining-work part is judged not to (decided no <= .3). q-cov-as-attached is recorded only.',
    requests }
  const totals = { requests: requests.length, questions: specs.reduce((s, [, c]) => s + c.names.length, 0), bytes: files.reduce((s, f) => s + f.bytes.length, 0), estInputTokens: requests.reduce((s, r) => s + r.estInputTokens, 0) }
  if (totals.estInputTokens > BRIEFING_COVERAGE_CEILING) throw new Error(`coverage plan over the ceiling: ${totals.estInputTokens}`)
  return { plan, planBytes: Buffer.from(JSON.stringify(plan, null, 2) + '\n'), files, requests, totals,
    flows: { complete: complete.out.coverage, incomplete: { status: without.out.status, reason: without.out.reason }, asAttached: asAttached.out.coverage } }
}
