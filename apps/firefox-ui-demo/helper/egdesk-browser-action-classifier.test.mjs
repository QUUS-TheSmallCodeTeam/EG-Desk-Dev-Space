import test from 'node:test'
import assert from 'node:assert/strict'
import {
  ACTION_CATEGORIES, ACTION_CATEGORY_TEXT, ACTION_GATE_TEXT, ACTION_GATES, CURRENT_ACTION_GATE_POLICY,
  RECOMMENDED_ACTION_GATE_POLICY, actionGate, classifyAction, enterSubmits, sameJudgement,
} from './egdesk-browser-action-classifier.mjs'

const activate = (label, facts = {}) => classifyAction({ mode: 'activate', label, role: 'button', ...facts }).category
const form = (over = {}) => ({ method: 'post', search: false, blockingFields: 2, hasSubmitButton: true,
  defaultButton: { label: 'Save', disabled: false }, ...over })
const enter = facts => classifyAction({ mode: 'enter', label: 'Field', role: 'textbox', tag: 'input', type: 'text',
  textEntry: false, ...facts }).category

// Cases mirror nanobrowser core/__tests__/classify.test.ts (Apache-2.0), with our input shape.
test('payment, deletion and submission vocabulary, pay first (nanobrowser cases)', () => {
  for (const label of ['Pay now', 'Place order', 'Checkout', '立即购买', '结账', 'Top up', 'Place your order', 'Proceed to checkout']) {
    assert.equal(activate(label), 'pay', label)
  }
  for (const label of ['Delete', 'Cancel subscription', 'Remove item']) assert.equal(activate(label), 'delete', label)
  for (const label of ['Publish', 'Send message']) assert.equal(activate(label), 'submit', label)
  for (const label of ['Show details', 'Cancel', 'Resend']) assert.equal(activate(label), 'none', label)
})

test('Korean vocabulary: pay, grant, delete, submit, with particles and endings attached', () => {
  for (const label of ['결제하기', '₩12,000 결제', '바로구매', '구매 확정', '주문하기', '주문완료', '송금', '계좌 이체',
    '포인트 충전하기', '선물하기', '구독', '예약하기', '예매', '매수', '카드 등록', '업그레이드', '네이버페이로 결제']) {
    assert.equal(activate(label), 'pay', label)
  }
  for (const label of ['권한 허용', '계정 연동하기', '정보 제공에 동의', '앱 연결']) assert.equal(activate(label), 'grant', label)
  for (const label of ['삭제', '영구 삭제할까요', '회원 탈퇴', '휴지통으로 이동', '계약 해지', '장바구니 비우기',
    '연결 해제', '초기화']) assert.equal(activate(label), 'delete', label)
  for (const label of ['보내기', '제출', '댓글 등록', '저장', '신청하기', '회원가입', '게시', '승인', '동의합니다', '확인']) {
    assert.equal(activate(label), 'submit', label)
  }
  for (const label of ['장바구니 담기', '자세히 보기', '주문 내역', '충전기', '선택 해제', '다음', '취소', '닫기', '']) {
    assert.equal(activate(label), 'none', label)
  }
})

test('cancelling a payment, order, booking or subscription is a deletion, not a new payment', () => {
  for (const label of ['구독 취소', '구독 해지', '주문 취소', '예약 취소', '결제 취소', '정기결제 해지', 'Cancel order',
    'Cancel my subscription', 'cancel payment']) {
    const result = classifyAction({ label, role: 'button' })
    assert.equal(result.category, 'delete', label)
    assert.equal(result.reason, 'cancel-vocabulary', label)
  }
})

test('a generic confirm label next to a money amount is pay', () => {
  assert.equal(activate('Confirm', { amount: '$49.00' }), 'pay')
  assert.equal(activate('Confirm'), 'submit')
  assert.equal(activate('OK', { amount: '¥1,280' }), 'pay')
  assert.equal(activate('확인', { amount: true }), 'pay')
  assert.equal(activate('다음', { amount: '12,000원' }), 'pay')
  assert.equal(activate('Confirm $49'), 'pay', 'an amount in the label counts')
  assert.equal(activate('확인 (5만원)'), 'pay')
  assert.equal(activate('다음', { amount: 'free' }), 'none', 'text with no amount is not money')
  assert.equal(activate('2024년 5월 확인'), 'submit', 'a date is not money')
  const reason = classifyAction({ label: 'Continue', role: 'button', amount: '$5' })
  assert.equal(reason.reason, 'amount-with-confirm')
  assert.equal(reason.term, 'continue')
})

test('class or test id decides when the name is neutral', () => {
  assert.equal(activate('', { classes: 'btn btn-delete' }), 'delete')
  assert.equal(activate('🗑', { classes: 'icon trash-button' }), 'delete')
  assert.equal(activate('Edit', { classes: 'deleted-items-link' }), 'none')
})

test('a submit button counts with a form owner, not for a search form; an unknown owner leans to submit', () => {
  assert.equal(activate('Continue', { submitter: true, form: form() }), 'submit')
  assert.equal(activate('Continue', { submitter: false, form: null }), 'none')
  assert.equal(activate('Go', { submitter: true, form: form({ search: true }) }), 'none')
  assert.equal(activate('Go', { submitter: true }), 'submit', 'form facts missing')
  assert.equal(activate('Go', { submitter: true, form: null }), 'none', 'known: no form owner')
  assert.equal(activate('Save', { form: form({ search: true }) }), 'none', 'a search form is exempt from submit')
  assert.equal(activate('Pay now', { form: form({ search: true }) }), 'pay', 'but not from pay')
})

test('Enter follows HTML implicit submission (nanobrowser cases)', () => {
  assert.equal(enter({ form: form({ defaultButton: { label: 'Place order', disabled: false } }) }), 'pay')
  assert.equal(enter({ form: form({ defaultButton: { label: 'Delete account', disabled: false } }) }), 'delete')
  assert.equal(enter({ form: form() }), 'submit')
  assert.equal(enter({ form: form({ defaultButton: { label: 'Save', disabled: true } }) }), 'none')
  assert.equal(enter({ form: form({ hasSubmitButton: false, defaultButton: null, blockingFields: 1 }) }), 'submit')
  assert.equal(enter({ form: form({ hasSubmitButton: false, defaultButton: null, blockingFields: 2 }) }), 'none')
  assert.equal(enter({ form: form({ search: true }) }), 'none')
  assert.equal(enter({ form: form({ search: true, defaultButton: { label: 'Pay now', disabled: false } }) }), 'pay')
  assert.equal(enter({ form: form({ search: true, defaultButton: { label: 'Delete all', disabled: false } }) }), 'delete')
  assert.equal(enter({ amount: '$15.00', form: form({ search: true, defaultButton: { label: 'Confirm', disabled: false } }) }), 'pay')
  assert.equal(enter({ form: form({ search: true, defaultButton: { label: 'Continue', accessibleName: 'Pay now', disabled: false } }) }), 'pay')
  assert.equal(enter({ form: form({ defaultButton: { label: 'Delete', accessibleName: 'Continue', disabled: false } }) }), 'delete')
  assert.equal(enter({ form: null }), 'none')
  const viaButton = classifyAction({ mode: 'enter', role: 'textbox', form: form({ defaultButton: { label: '주문하기' } }) })
  assert.equal(viaButton.category, 'pay')
  assert.equal(viaButton.source, 'default-button')
})

test('the Child\'s implicit-submission answer wins; missing facts lean toward a submission', () => {
  assert.equal(enter({ implicitSubmission: true, form: undefined }), 'submit')
  assert.equal(enter({ implicitSubmission: false, form: form() }), 'none')
  assert.equal(enter({ implicitSubmission: true, form: null }), 'submit', 'the Child saw a submission')
  const unknown = classifyAction({ mode: 'enter', label: 'Message', role: 'textbox' })
  assert.equal(unknown.category, 'submit')
  assert.equal(unknown.reason, 'enter-unknown-form')
  assert.equal(classifyAction({ mode: 'enter', label: '검색', role: 'searchbox' }).category, 'none')
  assert.equal(enterSubmits({ form: form({ hasSubmitButton: false, defaultButton: null, blockingFields: 0 }) }), true)
  assert.equal(enterSubmits({ form: null }), false)
  assert.equal(enterSubmits({ form: { search: false } }), true, 'incomplete form facts lean toward a submission')
  assert.equal(enterSubmits({}), true)
})

test('Enter in a text box with no form sends, unless it is a search field', () => {
  const box = { mode: 'enter', role: 'textbox', tag: 'textarea', form: null }
  assert.equal(classifyAction({ ...box, label: 'Message' }).category, 'submit')
  assert.equal(classifyAction({ ...box, label: 'Message' }).reason, 'enter-sends-text')
  assert.equal(classifyAction({ ...box, label: '메시지 입력' }).category, 'submit')
  assert.equal(classifyAction({ ...box, label: 'Search' }).category, 'none')
  assert.equal(classifyAction({ ...box, label: '상품 검색' }).category, 'none')
  assert.equal(classifyAction({ ...box, label: 'Message', searchField: true }).category, 'none')
  assert.equal(classifyAction({ mode: 'enter', role: 'button', label: 'Message', form: null, textEntry: false }).category, 'none')
  // Role is derived from tag and type when the observation has none.
  assert.equal(classifyAction({ mode: 'enter', tag: 'textarea', label: 'Note', form: null }).category, 'submit')
  assert.equal(classifyAction({ mode: 'enter', tag: 'input', type: 'search', label: 'q', form: null }).category, 'none')
})

test('access vocabulary is grant, and an affirmative label on a consent page', () => {
  assert.equal(activate('Authorize'), 'grant')
  assert.equal(activate('授权'), 'grant')
  assert.equal(activate('Allow', { url: 'https://acct.example/oauth/consent?x' }), 'grant')
  assert.equal(activate('Allow', { url: 'https://shop.example/' }), 'none', "a cookie banner's Allow elsewhere")
  assert.equal(activate('Continue', { submitter: true, form: form(), url: 'https://id.example/authorize' }), 'grant')
  assert.equal(activate('동의하고 계속하기', { url: 'https://nid.naver.com/oauth2.0/authorize?client_id=x' }), 'grant')
  assert.equal(activate('확인', { url: 'https://kauth.kakao.com/oauth/authorize' }), 'grant')
  assert.equal(activate('동의하고 계속하기', { url: 'https://shop.example/terms' }), 'submit')
  assert.equal(activate('네', { url: 'https://id.example/consent' }), 'grant')
  assert.equal(activate('네이버 로그인', { url: 'https://id.example/consent' }), 'none', "'네' only as a whole label")
  assert.equal(activate('Allow', { url: 'not a url' }), 'none')
})

test('cookie refusals are not writes; focusing a field is not classified by its label', () => {
  for (const label of ['Reject all', 'Reject cookies', '모두 거부', '쿠키 거부', '쿠키 설정 저장']) {
    const result = classifyAction({ label, role: 'button' })
    assert.equal(result.category, 'none', label)
  }
  assert.equal(activate('Reject'), 'submit')
  assert.equal(activate('거부'), 'submit')
  for (const role of ['textbox', 'searchbox', 'combobox', 'slider', 'spinbutton', 'scrollable']) {
    const result = classifyAction({ label: '메시지 보내기', role })
    assert.equal(result.category, 'none', role)
    assert.equal(result.reason, 'non-activating-role', role)
  }
  assert.equal(classifyAction({ label: 'Send', tag: 'textarea' }).reason, 'non-activating-role')
  assert.equal(classifyAction({ label: 'Delete', role: 'menuitem' }).category, 'delete', 'a menu item is the action')
  assert.equal(classifyAction({ label: '자동결제', role: 'switch' }).category, 'pay', 'a switch can change a payment setting')
})

test('results carry fixed codes and a vocabulary term, never the label, amount or form address', () => {
  const secret = 'LABEL_SENTINEL_44e1'
  const result = classifyAction({ label: `Pay now ${secret}`, role: 'button', amount: `$9 ${secret}`, url: `https://x.test/oauth?${secret}`,
    classes: secret, form: { search: false, method: 'post', defaultButton: { label: secret, disabled: false } } })
  assert.equal(result.category, 'pay')
  assert.equal(result.reason, 'pay-vocabulary')
  assert.equal(result.term, 'pay now')
  assert.equal(result.source, 'label')
  assert.equal(JSON.stringify(result).includes(secret), false)
  assert.match(result.basis, /^pay:pay-vocabulary:[0-9a-f]{8}$/)
  assert.ok(Object.isFrozen(result))
  assert.ok(ACTION_CATEGORIES.includes(result.category))
  for (const bad of [undefined, null, 'Pay', 42, [], { label: 42, role: {}, form: 'x' }]) {
    const judged = classifyAction(bad)
    assert.ok(ACTION_CATEGORIES.includes(judged.category))
  }
  assert.equal(classifyAction({ label: `${'a '.repeat(5000)} delete` }).category, 'delete', 'padding cannot hide the tail')
  assert.equal(classifyAction({ label: `Delete ${'a '.repeat(50000)}` }).category, 'delete', 'or the head')
  assert.equal(classifyAction({ label: `${'a '.repeat(5000)} delete ${'a '.repeat(5000)}` }).category, 'none',
    'a word buried in the middle of a very long name is not seen (the bound)')
})

test('the basis changes when the label, amount, form or mode changes, so a late answer can be refused', () => {
  const asked = classifyAction({ label: 'Pay $10', role: 'button' })
  assert.equal(sameJudgement(asked, classifyAction({ label: 'Pay $10', role: 'button' })), true)
  assert.equal(sameJudgement(asked, classifyAction({ label: 'Pay  $10 ', role: 'button' })), true, 'whitespace only')
  assert.equal(sameJudgement(asked, classifyAction({ label: 'Pay $1000', role: 'button' })), false)
  const save = classifyAction({ mode: 'enter', role: 'textbox', form: form() })
  assert.equal(sameJudgement(save, classifyAction({ mode: 'enter', role: 'textbox', form: form({ defaultButton: { label: 'Delete' } }) })), false)
  assert.equal(sameJudgement(save, classifyAction({ mode: 'enter', role: 'textbox', form: form({ method: 'get' }) })), false)
  assert.equal(sameJudgement(asked, classifyAction({ mode: 'enter', label: 'Pay $10', role: 'button' })), false)
  assert.equal(sameJudgement(asked, { basis: undefined }), false)
  assert.equal(sameJudgement(null, asked), false)
})

test('gates: today every classified action is allowed; the D-B3 preset hands pay and grant to the person', () => {
  const pay = classifyAction({ label: '결제하기', role: 'button' })
  assert.equal(actionGate(pay), 'allow', 'default is the current Run-scoped behaviour')
  for (const category of ['pay', 'grant', 'delete', 'submit']) assert.equal(actionGate(category, CURRENT_ACTION_GATE_POLICY), 'allow')
  assert.equal(actionGate(pay, RECOMMENDED_ACTION_GATE_POLICY), 'user-step')
  assert.equal(actionGate('grant', RECOMMENDED_ACTION_GATE_POLICY), 'user-step')
  assert.equal(actionGate('delete', RECOMMENDED_ACTION_GATE_POLICY), 'confirm')
  assert.equal(actionGate('submit', RECOMMENDED_ACTION_GATE_POLICY), 'confirm')
  assert.equal(actionGate('none', RECOMMENDED_ACTION_GATE_POLICY), 'allow')
  assert.equal(actionGate(classifyAction({ label: 'Show details' }), RECOMMENDED_ACTION_GATE_POLICY), 'allow')
  assert.equal(actionGate('submit', { submit: 'deny' }), 'deny')
  assert.equal(actionGate('delete', { submit: 'deny' }), 'confirm', 'a missing category falls back to the recommendation')
  // Unreadable policies and unknown categories fail closed.
  for (const policy of [null, 'allow', [], { pay: 'maybe' }, { upload: 'allow' }]) {
    assert.equal(actionGate('pay', policy), 'user-step')
    assert.equal(actionGate('submit', policy), 'confirm')
  }
  assert.equal(actionGate('script'), 'user-step')
  assert.equal(actionGate(undefined), 'user-step')
  for (const gate of ACTION_GATES) assert.ok(Object.hasOwn(ACTION_GATE_TEXT, gate))
  for (const category of ACTION_CATEGORIES) assert.ok(ACTION_CATEGORY_TEXT[category].ko)
})

// ---- L8 C4: same-site dangerous classes the c3 measurement missed (label and address paths) ----
test('ordering, permission grants, session end, account closure and contract cancellation are never "none" (English and Korean)', () => {
  const classes = {
    pay: ['Place order', '주문하기', '주문 하기', '결제하기', 'Order now', 'order place', 'orders place', 'Proceed to checkout'],
    grant: ['Allow notifications', 'Allow location access', '알림 허용', '위치 허용', '카메라 허용', '권한 부여', '권한 허용', 'Grant access', 'grant allow', 'Authorize'],
    delete: ['Log out', 'Logout', 'Sign out', 'signout', '로그아웃', '로그 아웃', '로그오프', '탈퇴', '회원 탈퇴', 'Close my account', 'account close', '계정 폐쇄',
      '구독 취소', '구독 해지', 'subscriptions cancel', 'Cancel my plan', 'Terminate contract', '계약 해지', 'membership cancel', 'plan cancel', 'contract cancellation'],
  }
  for (const [category, labels] of Object.entries(classes)) for (const label of labels) assert.equal(activate(label), category, label)
})
test('bare Allow stays a cookie banner outside consent pages for a button, but names a grant as a link destination', () => {
  assert.equal(activate('Allow', { url: 'https://shop.example/' }), 'none')
  assert.equal(activate('모두 허용', { url: 'https://shop.example/' }), 'none')
  assert.equal(classifyAction({ label: 'permissions allow', role: 'link', href: true, url: 'https://shop.example/' }).category, 'grant')
  assert.equal(classifyAction({ label: 'permissions allow', role: 'link', url: 'https://shop.example/' }).category, 'none', 'only the destination flag changes it')
})
test('benign labels that share a word stay ordinary', () => {
  for (const label of ['Show details', 'Cancel', 'Orders', 'My orders', '주문 내역', '다음', '취소', '닫기', 'Close', 'Sign in', '로그인', 'Log in', 'Settings', 'Search']) {
    assert.equal(activate(label), 'none', label)
  }
})
