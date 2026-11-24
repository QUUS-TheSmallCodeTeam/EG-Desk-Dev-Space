import { BOARD_REPLY_PASS_RULE, buildBoardReplyPlan, estimateBoardReplyTokens } from './egdesk-board-reply-real-plan.mjs'
import { PLACEMENT_PASS_RULE, placementPlanRequests, planEntry } from './egdesk-work-placement-real-plan.mjs'
import { createHash } from 'node:crypto'

// L1 cycle 13 RE-MEASUREMENT (declarative format of the generic runner), the two v2 failures only, every body built by the product code:
//   same_matter  both scenes, isolation 'question' (each card inside its own question; the product default)        2 requests
//                both scenes, isolation 'request'  (one card per request; the alternative, for its cost and effect)  6 requests
//   arrangement  the two excerpts v2 judged still in effect (.96 parking "closed in January 2026", .74 refund rule "abolished from 2026"), asked the new
//                way (the arrangement, on the date the question is about, only for the relevant excerpts), with still-valid controls in the same requests
//                (parking c2 and c5, workshop c1)                                                                      2 requests
// Nothing is sent from here.
export const REMEASURE_SET = 'l1-remeasure-c13'
export const REMEASURE_TOKEN_CEILING = 5000
export const REMEASURE_PLAN_DIR = 'proofs/decision-real-measure/l1-remeasure-c13'
export const REMEASURE_ASKS = Object.freeze(['ask-visitor-parking', 'ask-workshop-refund'])
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex')

export async function buildRemeasurePlan() {
  const byQuestion = await placementPlanRequests({ isolation: 'question', results: [] })
  const byRequest = await placementPlanRequests({ isolation: 'request', results: [] })
  const board = (await buildBoardReplyPlan()).requests.filter(r => r.stage === 'now' && REMEASURE_ASKS.includes(r.ask))
  const requests = [...byQuestion, ...byRequest, ...board]
  const plan = { set: REMEASURE_SET, tokenCeiling: REMEASURE_TOKEN_CEILING,
    passRule: `Same matter (requests pl-*): ${PLACEMENT_PASS_RULE(byQuestion.length + byRequest.length)} The two isolations are scored separately: requests pl-same-matter-quote and pl-same-matter-report (one card per question) against pl-*-R# (one card per request). ` +
      `Arrangement (requests ask-*-now): ${BOARD_REPLY_PASS_RULE(board.length)}`,
    requests: requests.map(r => (r.stage ? { id: r.id, file: r.file, sha256: sha256(r.bytes), estInputTokens: estimateBoardReplyTokens(r.body.questions.length, r.bytes.length), expect: r.expect } : planEntry(r))) }
  return { plan, planBytes: Buffer.from(JSON.stringify(plan, null, 2) + '\n', 'utf8'), requests, groups: { byQuestion, byRequest, board } }
}
