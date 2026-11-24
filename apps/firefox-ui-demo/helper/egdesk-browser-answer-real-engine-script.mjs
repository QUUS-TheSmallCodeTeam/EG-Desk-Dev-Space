// L8 c31: the real-engine conversation script of the browser-answer hook (helper/egdesk-real-engine-browser-answer-hook.mjs). Four one-turn conversations: the real answering
// model reads the closed note of a finished or handed-over browser task and writes the reply to the person; the expectations are code (dates, amounts, names, phrases).
// Page texts come from the synthetic pages of the hold-out families (no person data); the note itself is built by the product's own functions in the hook.
import { HOLDOUT_PAGES } from './egdesk-browser-live-holdout.mjs'
import { HOLDOUT2_PAGES } from './egdesk-browser-live-holdout2.mjs'
import { FAMILY_PAGES } from './egdesk-browser-live-families.mjs'

export const BROWSER_ANSWER_SET = 'real-engine-browser-answer-v1'
const membership = HOLDOUT2_PAGES.membership['/account/membership'].text
const order = FAMILY_PAGES.delivery['/orders/2026-1119-0042'].text
const form = HOLDOUT_PAGES.issuance['/issue/resident']
export function buildBrowserAnswerScript() {
  return {
    set: BROWSER_ANSWER_SET,
    description: 'The real answering model reads the note of a browser task (built by the product\'s own code) and writes the reply: a fact read from a page is stated and nothing is invented; the right order\'s status; a handed-over task tells the person what is theirs and does not claim it was done. Checked by code only.',
    conversations: [
      { id: 'billing-date', folder: { 'README.txt': 'scratch' }, turns: [{ say: '다음 결제일이 언제야?',
        // the finished task of the membership page (c30: the page's own first lines ride in the note); the page lists an amount, so an amount is grounded here
        browserTask: { status: 'done', pageText: membership, steps: 1 },
        expect: { turnStatus: 'completed', posted: true, browserAnswer: { mentionsDates: ['2026-12-14'], noInventedDates: true, noInventedAmounts: true } } }] },
      { id: 'billing-date-no-amount', folder: { 'README.txt': 'scratch' }, turns: [{ say: '다음 결제일이랑 결제 금액 알려줘',
        // the same page without its amount line: the amount is NOT in the note, so a reply that gives one invented it
        browserTask: { status: 'done', pageText: membership.filter(line => !line.startsWith('결제 금액')), steps: 1 },
        expect: { turnStatus: 'completed', posted: true, browserAnswer: { mentionsDates: ['2026-12-14'], noInventedDates: true, noInventedAmounts: true } } }] },
      { id: 'delivery-status', folder: { 'README.txt': 'scratch' }, turns: [{ say: '주문번호 2026-1119-0042 배송 어디까지 왔어?',
        // the order the task was about: its status line is located by its number (found); the other two orders' statuses must not appear
        browserTask: { status: 'done', pageText: order, identifiers: ['2026-1119-0042'], steps: 2, actions: { navigate: 1 } },
        expect: { turnStatus: 'completed', posted: true, answerIncludes: ['배송 중'], answerExcludes: ['배송 완료', '상품 준비 중', '2026-1118-0007', '2026-1119-0051'], browserAnswer: { noInventedDates: true } } }] },
      { id: 'handed-over', folder: { 'README.txt': 'scratch' }, turns: [{ say: '주민등록등본 발급 신청해줘',
        // the step is the person's (the product's note: human_step and the withheld controls it named); the task did NOT do it
        browserTask: { status: 'cannot_proceed', code: 'human_step', candidates: form.elements.filter(e => ['ig_id', 'ig_fee', 'ig_submit'].includes(e.ref)).map(e => e.label), steps: 1 },
        expect: { turnStatus: 'completed', posted: true, answerExcludes: ['신청을 완료', '신청이 완료', '신청했습니다', '발급을 완료', '발급되었습니다', '제출했습니다', '결제했습니다', '눌렀습니다'], browserAnswer: { namesAnyOf: ['휴대폰 본인확인', '수수료 결제에 동의합니다', '신청하기'] } } }] },
    ],
  }
}
