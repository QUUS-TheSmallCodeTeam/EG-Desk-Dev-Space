#!/usr/bin/env node
// Pre-registered VARIANTS of the all-on journey (L6 cycle 24, in coordination with lane L2, who owns the journey, its plans and its checks).
//
//   node scripts/egdesk-journey-variants.mjs            compare mode: each variant plan is rebuilt from the base plan and compared with the committed file
//   node scripts/egdesk-journey-variants.mjs --write    write the variant plan files next to the base plan
//
// Why: identical request bytes give identical answers (70 of 70 pairs measured: journeys v6/v7b, browser-live, a duplicate send). So a second
// run of the same journey is not a new draw from the Decision model, and the readiness rule (two passing full runs) needs DIFFERENT inputs.
// A variant keeps what each step is for and what its pre-registered checks expect, and changes what the model reads:
//   - the person's words: a natural rephrasing per turn (a spoken one, a terse one, a formal one), Korean;
//   - the scripted answering model's wording (it writes the draft that the draft check judges), with the same facts and tenses;
//   - the page set: pages renamed (new ids and titles, same content) and decoy pages added (other companies' quotes, other topics);
//   - the order, where order is not the point (V3: the browser pair runs before the status remark).
// Every request body is still built by the product code; a variant changes only the scripted world's inputs. Every hard check of the base plan
// is in the variant plan under the same id, with the same check and the same expectation, its page ids and its needles (the person's words, a page
// title) mapped to the variant's. Where a packet check excludes pages by prefix, the variant's decoys are added to that exclusion: a page about
// another matter must not reach the model, whatever it is called. No hard check is dropped, loosened or turned soft.
//
// Registered here, before any send. A variant plan file records the variant's sha256 and the loader refuses a plan whose variant changed.
import { createHash } from 'node:crypto'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { SYNTHETIC_PAGES } from '../helper/egdesk-wiki-reconstruction.fixture.mjs'

const here = path.dirname(fileURLToPath(import.meta.url))
export const BASE_PLAN = 'egdesk-all-on-live-measure.plan-v7.json'
export const variantPlanFile = id => `egdesk-all-on-live-measure.plan-v7-variant-${id}.json`
export const SAYS_KEYS = Object.freeze(['quote', 'tidy', 'tests', 'recall', 'deployed', 'portal', 'second', 'nudge', 'change', 'stop', 'again'])
export const AGENT_KEYS = Object.freeze(['quote', 'tidy', 'recall', 'tests', 'noted', 'heard', 'ask', 'got', 'stuck', 'stuckAsk'])

const deepFreeze = value => { if (value && typeof value === 'object' && !Object.isFrozen(value)) { Object.freeze(value); for (const v of Object.values(value)) deepFreeze(v) } return value }
const sha256 = text => createHash('sha256').update(text).digest('hex')

// ---- the variants ----
// says: the person's words per turn ('kind' says how it differs from the base wording: spoken, terse or formal). agent: the scripted answering
// model's texts: the same facts, tenses and claims as the base text (the draft check must find them supported), in other words. pages.rename:
// one entry per renamed page (from: base id; id and title: the variant's; the title keeps the word the checks and the topics rely on:
// A사 for the quote pages, PostgreSQL for the migration pages). pages.decoys: fixture pages added to the graph (never relevant to any step).
// order: null (the base order) or the step order of the variant.
export const VARIANTS = deepFreeze({
  V1: {
    id: 'V1', ceiling: { tokenCeiling: 70_000, maxRequests: 70 }, intent: 'spoken rephrasing; another company\'s quote page as a decoy; four pages renamed',
    says: {
      quote: { text: 'A사 견적 지금 어떻게 돼 있어?', kind: 'spoken' }, tidy: { text: '그 내용 한번 정리해 줘', kind: 'spoken' }, tests: { text: '테스트 전부 돌려서 결과 말해 줘', kind: 'spoken' },
      recall: { text: 'PostgreSQL 전환 설계 어떻게 잡았었지?', kind: 'spoken' }, deployed: { text: 'PostgreSQL 마이그레이션 배포 방금 끝났어', kind: 'spoken' },
      portal: { text: '포털에서 이번 달 세금계산서 받아 줘', kind: 'spoken' }, second: { text: '두 번째 사업자로 해 줘', kind: 'spoken' }, nudge: { text: '지금 어디까지 된 거야?', kind: 'spoken' },
      change: { text: 'A 말고 B 먼저 해 줘', kind: 'spoken' }, stop: { text: '중지해 줘', kind: 'terse' }, again: { text: '테스트 다시 한 번 돌려 줘', kind: 'spoken' } },
    agent: {
      quote: 'A사 견적서는 v1을 이미 보냈고, v2 수정안은 팀장 승인을 받은 뒤 보낼 예정입니다.', tidy: 'A사 견적 정리입니다. 11월 3일에 요청을 받았고, 11월 6일에 v1을 보냈으며, v2는 팀장 승인 후 보낼 예정입니다.',
      recall: 'PostgreSQL 전환 설계는 스키마 변환, 데이터 이관, 롤백 순서를 정하는 것으로 확정했습니다.', tests: '전체 테스트를 돌렸고 모두 통과했습니다.', noted: '네, 기록해 둘게요.', heard: '네, 확인했습니다.',
      ask: '사업자가 두 곳입니다. 어느 쪽에서 받을까요?', got: '이번 달 세금계산서를 내려받았습니다.', stuck: '포털 작업을 끝내지 못했습니다.', stuckAsk: '포털에서 다음에 할 일을 정하지 못했습니다. 어느 사업자의 세금계산서를 받을지 알려 주세요.' },
    pages: {
      rename: [{ from: 'quote/a-request', id: 'quote/a-intake', title: 'A사 견적 문의 접수' }, { from: 'quote/a-v1', id: 'quote/a-first-sent', title: 'A사 첫 견적서(v1) 발송' },
        { from: 'db/pg-design', id: 'db/pg-design-doc', title: 'PostgreSQL 전환 설계 문서' }, { from: 'db/pg-plan', id: 'db/pg-plan-dates', title: 'PostgreSQL 마이그레이션 배포 일정' }],
      decoys: ['quote/b-request'] },
    order: null },
  V2: {
    id: 'V2', ceiling: { tokenCeiling: 76_000, maxRequests: 75 }, intent: 'terse rephrasing; the parts list of the same product as a decoy; four pages renamed',
    says: {
      quote: { text: 'A사 견적?', kind: 'terse' }, tidy: { text: '정리', kind: 'terse' }, tests: { text: '테스트 돌려', kind: 'terse' }, recall: { text: 'PostgreSQL 설계 뭐였지', kind: 'terse' },
      deployed: { text: 'PostgreSQL 배포 끝났어', kind: 'terse' }, portal: { text: '이번 달 세금계산서 받아줘', kind: 'terse' }, second: { text: '두번째', kind: 'terse' }, nudge: { text: '멈춘 거야?', kind: 'terse' },
      change: { text: 'B로 바꿔', kind: 'terse' }, stop: { text: '그만', kind: 'terse' }, again: { text: '테스트 다시', kind: 'terse' } },
    agent: {
      quote: 'A사 견적은 v1을 이미 보냈고, v2는 아직 수정 계획 단계여서 팀장 승인 후 발송할 예정입니다.', tidy: 'A사 견적은 11월 3일 요청 접수, 11월 6일 v1 발송 순서이고, v2는 팀장 승인 후 발송할 예정입니다.',
      recall: 'PostgreSQL 전환 설계에서 스키마 변환, 데이터 이관, 롤백 순서는 정해 둔 상태입니다.', tests: '테스트를 모두 돌렸고 전부 통과했습니다.', noted: '네, 기록해 두겠어요.', heard: '네, 알겠어요.',
      ask: '사업자가 둘 있습니다. 어느 쪽으로 진행할까요?', got: '세금계산서를 다운로드했습니다.', stuck: '포털에서 작업을 끝내지 못했습니다.', stuckAsk: '포털에서 다음 단계를 정하지 못했습니다. 어느 사업자의 세금계산서가 필요한지 알려 주세요.' },
    pages: {
      rename: [{ from: 'quote/a-request', id: 'quote/a-ask', title: 'A사 견적 요청 건' }, { from: 'quote/a-decision', id: 'quote/a-approval', title: 'A사 견적 결정 사항' },
        { from: 'db/pg-design', id: 'db/pg-spec', title: 'PostgreSQL 전환 설계 (확정)' }, { from: 'db/pg-plan', id: 'db/pg-rollout', title: 'PostgreSQL 마이그레이션 배포 계획서' }],
      decoys: ['quote/parts'] },
    order: null },
  V3: {
    id: 'V3', ceiling: { tokenCeiling: 76_000, maxRequests: 75 }, intent: 'formal, longer rephrasing; a Redis note as a decoy; four pages renamed; the browser pair runs last, after the stop nudge',
    says: {
      quote: { text: '지난주에 요청받은 A사 견적 건이 지금 어느 단계인지 알려 주세요', kind: 'formal' }, tidy: { text: '방금 말씀하신 내용을 항목별로 정리해 주세요', kind: 'formal' },
      tests: { text: '전체 테스트를 실행하고 결과를 알려 주세요', kind: 'formal' }, recall: { text: '예전에 잡아 둔 PostgreSQL 전환 설계를 다시 알려 주세요', kind: 'formal' },
      deployed: { text: 'PostgreSQL 마이그레이션 배포를 마쳤습니다', kind: 'formal' }, portal: { text: '거래처 포털에서 이번 달 세금계산서를 다운로드해 주세요', kind: 'formal' },
      second: { text: '두 번째 사업자 걸로 진행해 주세요', kind: 'formal' }, nudge: { text: '왜 이렇게 오래 걸리는지 알려 주세요', kind: 'formal' },
      change: { text: '그것 말고 B를 먼저 진행해 주세요', kind: 'formal' }, stop: { text: '중지', kind: 'terse' }, again: { text: '전체 테스트를 한 번 더 실행해 주세요', kind: 'formal' } },
    agent: {
      quote: 'A사 견적은 v1 발송 이후 v2 수정 계획 단계에 있고, 팀장 승인이 나면 발송할 예정입니다.', tidy: 'A사 견적: 11월 3일 요청 접수, 11월 6일 v1 발송, v2는 팀장 승인 후 발송할 예정입니다.',
      recall: 'PostgreSQL 전환은 설계에서 스키마 변환, 데이터 이관, 롤백 순서를 정하기로 확정했습니다.', tests: '전체 테스트가 모두 통과했습니다.', noted: '네, 알겠습니다. 기록해 둘게요.', heard: '네, 확인하겠습니다.',
      ask: '사업자가 두 곳 있습니다. 어느 쪽으로 받아 드릴까요?', got: '이번 달 세금계산서를 받았습니다.', stuck: '포털 작업을 완료하지 못했습니다.', stuckAsk: '포털에서 다음 단계를 정하지 못했습니다. 어느 사업자의 세금계산서를 받아야 하는지 알려 주세요.' },
    pages: {
      rename: [{ from: 'quote/a-v1', id: 'quote/a-sent-v1', title: 'A사 견적서 v1 발송 기록' }, { from: 'quote/a-v2-plan', id: 'quote/a-next', title: 'A사 견적서 v2 수정안' },
        { from: 'db/pg-plan', id: 'db/pg-schedule', title: 'PostgreSQL 마이그레이션 배포 일정 계획' }, { from: 'db/pg-rollback', id: 'db/pg-back', title: '롤백 절차 안내' }],
      decoys: ['db/redis'] },
    order: ['s1-first-turn', 's2-follow-up', 's3-briefing', 's3b-recall', 's4-long-command', 's4n-nudge', 's4c-change-nudge', 's5-silence', 's6-answer', 's7-pointer-advisory', 's8-pointer-on', 's8b-finished-result',
      's9-status-remark', 's12-stop-nudge', 's10-browser-task', 's11-browser-reply'] },
})

export const variantSha256 = id => sha256(JSON.stringify(VARIANTS[id]))

// ---- the page set ----
const fixturePage = id => { const page = SYNTHETIC_PAGES.find(p => p.id === id); if (!page) throw new Error(`no fixture page ${id}`); return page }
/** The variant's page list: the base pages with the renames applied (id, title, and every link that pointed at the old id), then the decoys. */
export function variantPages(basePages, variant) {
  const rename = new Map((variant.pages?.rename ?? []).map(r => [r.from, r]))
  const idOf = id => rename.get(id)?.id ?? id
  const mapPage = p => ({ ...p, id: idOf(p.id), title: rename.get(p.id)?.title ?? p.title, links: (p.links ?? []).map(l => ({ ...l, to: idOf(l.to) })) })
  return [...basePages.map(mapPage), ...(variant.pages?.decoys ?? []).map(id => mapPage(fixturePage(id)))]
}
/** The graph page ids of a variant, as the plan's packet checks name them ('ontology:' + id). */
export const idMapOf = variant => Object.fromEntries((variant.pages?.rename ?? []).map(r => [`ontology:${r.from}`, `ontology:${r.id}`]))
export const decoyIdsOf = variant => (variant.pages?.decoys ?? []).map(id => `ontology:${id}`)

// ---- validation: the claims the file header makes, checked ----
export function variantProblems(variant, { baseSays, baseAgent, basePages, baseStepIds }) {
  const out = [], bad = text => out.push(text)
  for (const key of SAYS_KEYS) {
    const s = variant.says?.[key]
    if (!s || typeof s.text !== 'string' || !s.text.trim()) { bad(`says.${key}: missing`); continue }
    if (s.text === baseSays[key]) bad(`says.${key}: same as the base wording`)
    if (/["\\\n]/.test(s.text)) bad(`says.${key}: a quote, a backslash or a line break would be escaped in a request body, and the plan's needles are plain text`)
    if (!['spoken', 'terse', 'formal'].includes(s.kind)) bad(`says.${key}: kind must be spoken, terse or formal`)
  }
  for (const key of Object.keys(variant.says ?? {})) if (!SAYS_KEYS.includes(key)) bad(`says.${key}: unknown key`)
  if (!Object.values(variant.says ?? {}).some(s => s.kind === 'terse')) bad('every variant has at least one terse turn')
  for (const key of AGENT_KEYS) { const text = variant.agent?.[key]; if (typeof text !== 'string' || !text.trim()) bad(`agent.${key}: missing`); else if (text === baseAgent[key]) bad(`agent.${key}: same as the base text`) }
  // what the checks read in the answering model's words
  if (!/PostgreSQL/.test(variant.agent?.recall ?? '') || /A사/.test(variant.agent?.recall ?? '')) bad('agent.recall must name PostgreSQL and not A사 (s3b.on-topic, s3b.not-off-topic)')
  if (!/기록해 두|기록했|기록해 둘|저장해 두|적어 두/.test(variant.agent?.noted ?? '')) bad('agent.noted must carry the recording claim the s9 claim check reads')
  if (/기록해 두|기록했|기록해 둘|저장해 두|적어 두/.test(variant.agent?.heard ?? '')) bad('agent.heard must not claim a record (it is said when the recording rule was given)')
  if (/통과|실패|완료|끝났/.test(variant.agent?.quote ?? '')) bad('agent.quote: no result words')
  if (!/통과/.test(variant.agent?.tests ?? '')) bad('agent.tests must say the tests passed (the command output says 40 passed, 0 failed)')
  const ids = new Set(basePages.map(p => p.id)), renamed = new Set(), taken = new Set([...ids, ...(variant.pages?.decoys ?? [])])
  for (const r of variant.pages?.rename ?? []) {
    if (!ids.has(r.from)) bad(`pages.rename: no base page ${r.from}`)
    if (renamed.has(r.from)) bad(`pages.rename: ${r.from} twice`); renamed.add(r.from)
    if (ids.has(r.id) && !(variant.pages.rename.some(x => x.from === r.id))) bad(`pages.rename: ${r.id} is another page's id`)
    if (r.id.split('/')[0] !== r.from.split('/')[0]) bad(`pages.rename: ${r.from} -> ${r.id} changes the prefix (the checks exclude pages by prefix)`)
    const base = basePages.find(p => p.id === r.from)
    for (const word of ['A사', 'PostgreSQL']) if (base?.title.includes(word) && !r.title.includes(word)) bad(`pages.rename: the title of ${r.id} loses "${word}"`)
    if (r.id === r.from && r.title === base?.title) bad(`pages.rename: ${r.from} is not changed`)
  }
  void taken
  const decoys = variant.pages?.decoys ?? []
  if (decoys.length < 1) bad('at least one decoy page')
  for (const id of decoys) { if (ids.has(id)) bad(`pages.decoys: ${id} is already a base page`); try { fixturePage(id) } catch { bad(`pages.decoys: no fixture page ${id}`) } }
  if (variant.order !== null) {
    if (JSON.stringify([...variant.order].sort()) !== JSON.stringify([...baseStepIds].sort())) bad('order must be a permutation of the base plan\'s steps')
    // order that is not the point: the pairs and groups below stay as they are (a step that reads an earlier one, or whose clock matters)
    const pos = id => variant.order.indexOf(id), before = (a, b) => pos(a) < pos(b)
    for (const [a, b] of [['s1-first-turn', 's2-follow-up'], ['s2-follow-up', 's3-briefing'], ['s3-briefing', 's3b-recall'], ['s3b-recall', 's4-long-command'], ['s4-long-command', 's4n-nudge'], ['s4n-nudge', 's4c-change-nudge'],
      ['s4c-change-nudge', 's5-silence'], ['s5-silence', 's6-answer'], ['s6-answer', 's8b-finished-result'], ['s7-pointer-advisory', 's8-pointer-on'], ['s8-pointer-on', 's8b-finished-result'], ['s10-browser-task', 's11-browser-reply'],
      ['s4-long-command', 's12-stop-nudge'], ['s9-status-remark', 's12-stop-nudge']]) if (!before(a, b)) bad(`order: ${a} must stay before ${b}`)
    if (!['s12-stop-nudge', 's9-status-remark', 's11-browser-reply'].includes(variant.order.at(-1))) bad('order: the run ends with s12, s9 or the browser pair')
  }
  return out
}

// ---- the variant plan ----
const clone = value => JSON.parse(JSON.stringify(value))
const mapIds = (list, idMap) => (Array.isArray(list) ? list.map(id => idMap[id] ?? id) : list)
/**
 * buildVariantPlan(baseRaw, baseBytes, id) -> the variant plan object. The base plan's steps and expectations are kept as they are, except:
 *   - page ids (include, excludePrefix, pageId) are the variant's;
 *   - packet checks that exclude pages by prefix also exclude every decoy page;
 *   - the needle that quotes the person's words (s4n.heard) is the variant's words, the needle that names a page title (s9.target-offered) its new title;
 *   - the plan's set, registration, ceiling and variant fields.
 * The person's words, the agent's texts, the page list and the order are not in the plan file text: the loader takes them from the variant by its id.
 */
export function buildVariantPlan(baseRaw, baseBytes, id) {
  const variant = VARIANTS[id]
  if (!variant) throw new Error(`no variant ${id}`)
  const plan = clone(baseRaw), idMap = idMapOf(variant), decoys = decoyIdsOf(variant)
  const titles = Object.fromEntries((variant.pages.rename ?? []).map(r => [fixtureTitle(r.from), r.title]))
  const saysTitle = key => variant.says[key].text
  for (const step of plan.steps) for (const e of step.expect) {
    const a = e.args ?? {}
    if (e.check === 'packet' || e.check === 'packetOrHeld') {
      a.include = mapIds(a.include, idMap)
      if (Array.isArray(a.excludePrefix) && a.excludePrefix.length) a.excludePrefix = [...mapIds(a.excludePrefix, idMap), ...decoys]
    }
    if (e.check === 'readingPending') a.pageId = idMap[a.pageId] ?? a.pageId
    if (e.id === 's4n.heard') a.needles = [saysTitle('nudge')]
    if (e.id === 's9.target-offered') a.needles = a.needles.map(n => titles[n] ?? n)
    if (e.args !== undefined) e.args = a
  }
  // the plan lists its steps in the variant's order (the loader checks the plan against it)
  if (variant.order) plan.steps = variant.order.map(stepId => plan.steps.find(step => step.id === stepId))
  const sha = sha256(baseBytes)
  plan.set = `${baseRaw.set}-variant-${id.toLowerCase()}`
  plan.registered = `2026-11-25 (lane L6 cycle 24), before any send of the variant; variant ${id} of plan v${baseRaw.version} (${path.basename(BASE_PLAN)}, sha256 ${sha.slice(0, 16)}): ${variant.intent}. Same steps, same hard checks under the same ids; the person's words, the scripted answering model's words, the page set and the order are the variant's (scripts/egdesk-journey-variants.mjs, sha256 ${variantSha256(id).slice(0, 16)})`
  plan.basedOn = { file: path.basename(BASE_PLAN), sha256: sha, note: 'every step and expectation of the base plan; page ids and the two needles mapped; decoy pages added to the prefix exclusions' }
  plan.variant = id
  plan.variantSha256 = variantSha256(id)
  plan.ceiling = { ...variant.ceiling, note: 'declared before the send: the run stops before a request that would go over it, and a higher one is refused for a send. The scripted dry run over-selects memory pages (about twice the fetch requests of a real run), so its estimate is above the real count; the replay estimate (the answers of the last real journey drive the requests, the estimate is converted with that journey\'s per-family reported/estimated ratios) is what the ceiling is set against' }
  return plan
}
const fixtureTitle = id => fixturePage(id).title
export const planBytesOf = plan => `${JSON.stringify(plan, null, 1)}\n`

export function buildAll() {
  const baseBytes = readFileSync(path.join(here, BASE_PLAN)), baseRaw = JSON.parse(baseBytes.toString('utf8'))
  return Object.keys(VARIANTS).map(id => { const plan = buildVariantPlan(baseRaw, baseBytes, id); return { id, plan, bytes: planBytesOf(plan), file: path.join(here, variantPlanFile(id)) } })
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  const write = process.argv.includes('--write')
  let differs = 0
  for (const { id, bytes, file } of buildAll()) {
    if (write) { writeFileSync(file, bytes); console.log(`written: ${path.basename(file)}`); continue }
    const same = existsSync(file) && readFileSync(file, 'utf8') === bytes
    if (!same) differs++
    console.log(`${same ? 'matches' : 'DIFFERS'}: variant ${id} -> ${path.basename(file)}`)
  }
  process.exitCode = differs ? 1 : 0
}
