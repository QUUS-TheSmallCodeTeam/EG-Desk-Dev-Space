import { createHash } from 'node:crypto'
import { rmSync } from 'node:fs'
import path from 'node:path'
import { createPrivateQaTempDirectory } from '../scripts/egdesk-qa-platform.mjs'
import { createBoardAgentAskService } from './egdesk-board-agent-ask.mjs'
import { BOARD_AGENT_RELEVANCE_BAR, selectBoardAgentContext } from './egdesk-board-agent-context.mjs'
import { createBoardAgentDraftTransport } from './egdesk-board-agent-draft.mjs'
import { createDecisionClient, DECISION_MODEL } from './egdesk-decision-client.mjs'
import { openDeskStore } from './egdesk-desk-store.mjs'

// REAL-MEASUREMENT PLAN for the Board reply screening (which approved public excerpts are relevant evidence for a member's question).
// Declarative format of the generic runner (helper/egdesk-decision-real-runner.mjs, lane L6): plan.json + requests/<id>.json.
// Nothing here sends anything. The PRODUCT CODE builds every request body: the real Board ask service runs a draft ask with the saved
// Decisions mode "on" over the real selector and the real Decisions client, whose fetch is replaced by a recorder that keeps the exact
// bytes the client would have posted and answers with the pre-registered expectation. The drafting API is a recorder too.
// Data: synthetic, public-style Korean notices written for this plan. No person, no account, no real organisation.
//
// One request per ask; one predicate per approved excerpt (the product's own question). The bar is the product's own
// BOARD_AGENT_RELEVANCE_BAR: an excerpt is selected when probability >= bar.
//   relevant    clearly answers the question                    hard: probability >= bar (it is selected)
//   irrelevant  another subject altogether                      hard: probability <  bar (it is not selected)
//   near_miss   same subject words, does not answer             soft: probability <  bar
//   wrong_time  right subject, an older period or version       soft: probability <  bar
// near_miss and wrong_time are soft on purpose: the product's question asks only "is it relevant evidence", and the request carries no
// current date. Whether the model keeps those below the bar is what this measurement is for; a miss is a finding, not a broken run.
export const BOARD_REPLY_SET = 'board-reply-screening-v1'
export const BOARD_REPLY_TOKEN_CEILING = 8000
export const BOARD_REPLY_PLAN_DIR = 'proofs/decision-real-measure/board-reply-screening'
export const BELOW_BAR = Math.round((BOARD_AGENT_RELEVANCE_BAR - 0.001) * 1000) / 1000 // "max" is inclusive in the runner: just under the bar
export const CASES = Object.freeze(['relevant', 'irrelevant', 'near_miss', 'wrong_time'])

export const ASKS = Object.freeze([
  { id: 'ask-visitor-parking', question: '이번 주 금요일 공개 설명회에 오는 방문자는 어디에 주차하면 되나요?', excerpts: [
    ['irrelevant', '구내식당 점심 메뉴는 매주 월요일 오전에 본관 게시판에 올라옵니다.', 'canteen menu'],
    ['relevant', '공개 설명회 방문자는 체육관 뒤 제2주차장을 이용합니다. 주차권은 안내 데스크에서 무료로 받습니다.', 'where visitors park'],
    ['near_miss', '직원 정기 주차권은 매 분기 첫 주에 총무팀에서 갱신합니다.', 'parking, but staff permits'],
    ['wrong_time', '작년 가을 설명회까지는 방문자 주차를 정문 앞 임시 주차장에서 받았으며, 그 주차장은 올해 1월에 폐쇄되었습니다.', 'last year\'s visitor parking, closed since'],
    ['relevant', '금요일 설명회 당일에는 제2주차장이 오전 9시부터 오후 6시까지 방문자에게 열립니다.', 'the lot\'s hours on the day'],
    ['irrelevant', '분실물은 본관 1층 경비실에서 30일 동안 보관합니다.', 'lost property'],
  ] },
  { id: 'ask-plan-price-version', question: '현재 판매 중인 스탠다드 요금제(2026년 개정판)의 월 요금과 포함된 사용자 수를 알려 주세요.', excerpts: [
    ['wrong_time', '2024년 스탠다드 요금제는 월 9,000원에 사용자 3명까지였고 2025년 12월에 판매가 끝났습니다.', 'the discontinued 2024 version'],
    ['irrelevant', '고객센터 전화 상담은 평일 오전 10시부터 오후 5시까지 운영합니다.', 'support hours'],
    ['relevant', '2026년 개정 스탠다드 요금제는 월 12,000원이며 사용자 5명까지 포함됩니다.', 'the current price and seats'],
    ['near_miss', '프리미엄 요금제는 월 30,000원이며 사용자 수 제한이 없습니다.', 'another plan\'s price'],
    ['irrelevant', '회사 블로그에는 매달 제품 활용 사례가 한 편씩 올라옵니다.', 'blog schedule'],
    ['relevant', '요금 안내(2026년 개정): 스탠다드 요금제에 포함된 사용자 5명에는 관리자 계정도 들어갑니다.', 'what the included seats count'],
  ] },
  { id: 'ask-workshop-refund', question: '봄 학기 워크숍 참가 신청을 취소하면 언제까지 전액 환불을 받을 수 있나요?', excerpts: [
    ['relevant', '봄 학기 워크숍은 시작 7일 전까지 취소하면 참가비 전액을 환불합니다.', 'the full-refund deadline'],
    ['near_miss', '봄 학기 워크숍 참가 신청은 3월 2일부터 3월 20일까지 홈페이지에서 받습니다.', 'same workshop, the sign-up period'],
    ['irrelevant', '도서관 열람실은 시험 기간에 자정까지 연장 운영합니다.', 'library hours'],
    ['wrong_time', '지난 가을 학기 워크숍은 시작 3일 전까지 전액 환불이 가능했으나, 이 규정은 가을 학기에만 적용되었습니다.', 'last term\'s refund rule'],
    ['relevant', '봄 학기 워크숍을 시작 7일 전 이후에 취소하면 참가비의 50%만 환불하며, 시작한 뒤에는 환불하지 않습니다.', 'what happens after the deadline'],
    ['irrelevant', '지하 주차장은 정기 점검으로 4월 둘째 주 토요일에 쓸 수 없습니다.', 'car park maintenance'],
  ] },
])

// Typed input-token model solved from the real requests of 2026-11-24 (the same formula as egdesk-memory-real-plan.mjs estimateTokens and the
// runner's independent cross-check): 56.5 per choice question, 134.8 per predicate, 0.1983 per body byte.
export const estimateBoardReplyTokens = (predicates, bytes) => Math.round(134.8 * predicates + 0.1983 * bytes)
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex')
const DRAFT_MODEL = 'synthetic-responses-model'
const expectationOf = ([kind, , note], index) => ({ name: `c${index + 1}`, kind: 'predicate', ...(kind === 'relevant' ? { min: BOARD_AGENT_RELEVANCE_BAR } : { max: BELOW_BAR }),
  severity: kind === 'relevant' || kind === 'irrelevant' ? 'hard' : 'soft', note: `${kind}: ${note}` })

/**
 * buildBoardReplyPlan() -> { plan, planBytes, requests: [{ id, file, bytes (Buffer), body, cases, forcedSelection, localSelection }] }
 * Runs every ask through the real service twice in a private temp Desk: a draft ask with Decisions "on" (records the request body and what the
 * product would select if the model answered exactly as pre-registered) and an extract ask (what today's word match selects, nothing sent).
 */
export async function buildBoardReplyPlan() {
  const root = createPrivateQaTempDirectory('egdesk-board-reply-plan-')
  const desk = openDeskStore({ dataDir: path.join(root, 'desk'), ownerScope: 'board-reply-plan' })
  const profileId = 'profile-board-reply-plan'
  const profile = { lifecycle: 'active', activeRevision: 1, active: { revision: 1, hash: 'b'.repeat(64), body: { name: 'Plan Agent', model: null } } }
  const wire = [], drafted = []
  let forced = null
  const client = createDecisionClient({ getApiKey: () => 'egd-synthetic-not-a-key-0001', fetchImpl: async (url, init) => {
    wire.push({ url: String(url), bytes: Buffer.from(init.body, 'utf8') })
    const body = JSON.parse(init.body)
    return Response.json({ model: DECISION_MODEL, answers: body.questions.map((q, i) => ({ name: q.name, type: 'predicate', probability: forced[i][0] === 'relevant' ? 0.9 : 0.1 })) })
  } })
  const draft = createBoardAgentDraftTransport({ readConfig: () => ({ apiKey: 'egd-synthetic-draft-not-a-key-0002', model: DRAFT_MODEL }), fetchImpl: async (url, init) => {
    drafted.push(JSON.parse(JSON.parse(init.body).input[0].content[0].text).excerpts)
    return Response.json({ object: 'response', status: 'completed', model: DRAFT_MODEL, output: [{ type: 'message', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: 'Synthetic drafted reply.' }] }] })
  } })
  const service = createBoardAgentAskService({ desk, profiles: { get: id => (id === profileId ? profile : null) }, selectContext: selectBoardAgentContext,
    decisionStatus: () => ({ mode: 'on', model: DECISION_MODEL, bindingId: 'plan-binding', client }), draft })
  const requests = []
  try {
    for (const [n, ask] of ASKS.entries()) {
      const boardId = `board-reply-plan-${n + 1}`, texts = ask.excerpts.map(row => row[1])
      desk.saveBoard(boardId, { body: { version: 1, agenda: { id: boardId, title: 'Plan Board' }, cards: [], shapes: [] }, expectedRevision: null })
      let version = service.policy({ boardId, action: 'save', expectedVersion: null, profileId, excerpts: texts, publicInstructions: '' }).policy.version
      const run = async mode => {
        const issued = service.policy({ boardId, action: 'issue', expectedVersion: version }); version = issued.policy.version
        const request = { kind: 'request', requestId: `00000000-0000-4000-8000-00000000000${n + 1}`, requestDigest: sha256(`${ask.id}:${mode}`), question: ask.question, recipient: 'Member', excerpt: '', expectedReply: 'short', askCode: issued.askCode }
        const prepared = service.prepare({ boardId, request, mode })
        return service.run({ ticket: prepared.ticket, confirm: true })
      }
      forced = ask.excerpts
      const before = wire.length, draftedBefore = drafted.length
      const screened = await run('draft')
      if (wire.length !== before + 1 || screened.screening !== 'decision') throw new Error(`${ask.id}: the product did not build exactly one screening request`)
      const local = await run('extract') // today's word match; an extract run sends nothing to any model
      if (wire.length !== before + 1) throw new Error(`${ask.id}: an extract run built a Decisions request`)
      const bytes = wire[before].bytes, body = JSON.parse(bytes.toString('utf8'))
      requests.push({ id: ask.id, file: `requests/${ask.id}.json`, bytes, body, url: wire[before].url, cases: ask.excerpts.map(row => row[0]),
        forcedSelection: drafted.length === draftedBefore + 1 ? drafted[draftedBefore].map(text => texts.indexOf(text) + 1) : null,
        localSelection: local.answer ? local.answer.split('\n\n').map(text => texts.indexOf(text) + 1) : [] })
    }
  } finally { service.close(); desk.close(); rmSync(root, { recursive: true, force: true }) }
  const plan = { set: BOARD_REPLY_SET, tokenCeiling: BOARD_REPLY_TOKEN_CEILING,
    passRule: `A request passes when every hard check holds: each clearly relevant excerpt has probability >= ${BOARD_AGENT_RELEVANCE_BAR} (the product's bar: it is selected) and each clearly irrelevant excerpt has probability <= ${BELOW_BAR} (below the bar: it is not selected). ` +
      `The set passes when all ${ASKS.length} requests pass. Near-miss and wrong-time/version excerpts are soft checks (expected <= ${BELOW_BAR}); soft misses never fail the run and are reported per kind (the note of every check starts with its kind).`,
    requests: requests.map((r, n) => ({ id: r.id, file: r.file, sha256: sha256(r.bytes), estInputTokens: estimateBoardReplyTokens(r.body.questions.length, r.bytes.length), expect: ASKS[n].excerpts.map(expectationOf) })) }
  return { plan, planBytes: Buffer.from(JSON.stringify(plan, null, 2) + '\n', 'utf8'), requests }
}
