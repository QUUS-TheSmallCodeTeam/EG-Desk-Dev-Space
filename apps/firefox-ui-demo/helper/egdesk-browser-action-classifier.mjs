// Risky Browser action classifier for Agent-driven Browser Cards (BRW-11 groundwork, batch 1-X).
// Pure and deterministic: from the observed accessible name, role and form facts it
// answers whether a click or an Enter will pay, grant access, delete or submit.
// No I/O, no node: imports, so the Firefox actor can mirror it.
//
// Adapted from nanobrowser src/browser-control/core/interaction/classify.ts:1-188
//   Copyright Nanobrowser authors, Licensed under the Apache License, Version 2.0
//   (English and Chinese vocabulary, the class rule, money next to a generic
//   confirmation, consent pages, HTML implicit submission, Enter in a formless text box).
// Gate presets follow nanobrowser core/interaction/gate.ts:1-60, :179-240 (Apache-2.0)
// and agent-browser cli/src/native/policy.rs:1-140 (Apache-2.0): allow / confirm / deny,
// with pay and grant handed to the person.
// EG-Desk additions: Korean vocabulary, cancellation phrases, non-activating roles,
// unknown facts leaning toward a write, and a judgement basis without page text.
//
// The vocabulary errs toward inclusion (the map's rule): a false positive costs one
// question, a false negative an irreversible action. Results carry fixed reason codes
// and a vocabulary term; never the label, the form address or an amount.

export const ACTION_CATEGORIES = Object.freeze(['pay', 'grant', 'delete', 'submit', 'none'])
export const ACTION_GATES = Object.freeze(['allow', 'confirm', 'user-step', 'deny'])
// Today: a Run's interaction grant covers every guarded action; classification is only reported.
export const CURRENT_ACTION_GATE_POLICY = Object.freeze({ pay: 'allow', grant: 'allow', delete: 'allow', submit: 'allow' })
// D-B3 recommendation: payment and access grants are always the person's step, deletion and submission ask first.
export const RECOMMENDED_ACTION_GATE_POLICY = Object.freeze({ pay: 'user-step', grant: 'user-step', delete: 'confirm', submit: 'confirm' })

export const ACTION_CATEGORY_TEXT = Object.freeze({
  pay: Object.freeze({ ko: '결제', en: 'payment' }),
  grant: Object.freeze({ ko: '권한 부여', en: 'access grant' }),
  delete: Object.freeze({ ko: '삭제·해지', en: 'deletion' }),
  submit: Object.freeze({ ko: '제출·전송', en: 'submission' }),
  none: Object.freeze({ ko: '일반 조작', en: 'ordinary action' }),
})
export const ACTION_GATE_TEXT = Object.freeze({
  allow: Object.freeze({ ko: '', en: '' }),
  confirm: Object.freeze({ ko: '누르기 전에 먼저 확인을 받습니다.', en: "Needs the user's confirmation before it is dispatched." }),
  'user-step': Object.freeze({ ko: '결제와 권한 부여는 직접 하셔야 합니다. Agent는 누르지 않았습니다.', en: "This is the user's step; nothing was dispatched." }),
  deny: Object.freeze({ ko: '허용되지 않은 동작이라 누르지 않았습니다.', en: 'Not allowed; nothing was dispatched.' }),
})

// Labels are matched in full up to this length; a longer one by its head and tail, so
// padding a button name cannot push the word that matters out of reach at either end.
const MAX_LABEL = 4096
const MAX_RAW = 65536

// English phrases match on word boundaries (spaces optional inside a phrase);
// Korean and Chinese phrases match anywhere, spaces optional, since particles and
// endings attach to the word ("결제하기", "삭제할까요").
// Longer phrases first, so the reported term is the whole phrase ("pay now", not "pay").
function vocabulary(english, other) {
  const pattern = list => [...list].sort((a, b) => b.length - a.length).map(phrase => phrase.trim().split(/\s+/).join('\\s*'))
  const en = pattern(english)
  const rest = pattern(other)
  return new RegExp(`\\b(?:${en.join('|')})\\b${rest.length ? `|${rest.join('|')}` : ''}`, 'i')
}

// Cancelling a payment, order, booking or subscription is destructive, not a new payment.
// Checked before pay, because these labels contain pay words (결제·주문·구독·예약).
const CANCEL_WORDS = new RegExp([
  '\\bcancel\\s*(?:my\\s*)?(?:subscription|order|booking|reservation|payment|purchase|membership|plan)\\b',
  '(?:구독|주문|예약|예매|결제|구매|후원|정기\\s*결제|자동\\s*결제|멤버십)\\s*(?:취소|해지|중단|철회)',
  '取消订阅',
].join('|'), 'i')
const PAY_WORDS = vocabulary(
  ['pay', 'payment', 'pay now', 'buy', 'buy now', 'purchase', 'checkout', 'check out', 'place order', 'place the order',
    'place your order', 'confirm order', 'confirm purchase', 'submit order', 'order now', 'complete order', 'complete purchase', 'complete booking', 'book now', 'subscribe', 'donate',
    'confirm and pay', 'transfer money', 'send money', 'top up', 'add funds', 'withdraw', 'place bid', 'bid',
    'start trial', 'start free trial', 'upgrade'],
  ['결제', '지불', '구매', '구입', '주문하기', '주문 완료', '주문 확정', '바로 주문', '주문 결제', '송금', '이체',
    '충전하기', '포인트 충전', '머니 충전', '선물하기', '후원', '기부', '구독', '예약하기', '예약 확정', '예약 완료',
    '예매', '입찰', '매수', '매도', '환전', '출금', '인출', '할부', '카드 등록', '무료 체험 시작', '업그레이드',
    '付款', '支付', '购买', '下单', '结账', '结算', '充值', '订阅', '转账', '捐款'],
)
const GRANT_WORDS = vocabulary(
  ['authorize', 'authorise', 'allow access', 'grant access', 'give access', 'grant permission', 'give permission',
    'connect account', 'link account'],
  ['권한 허용', '권한 부여', '접근 허용', '액세스 허용', '엑세스 허용', '계정 연결', '계정 연동', '연동하기', '앱 연결',
    '정보 제공 동의', '정보 제공에 동의', '授权', '允许访问', '授予访问'],
)
const DELETE_WORDS = vocabulary(
  ['delete', 'remove', 'discard', 'deactivate', 'destroy', 'erase', 'purge', 'trash', 'unsubscribe', 'uninstall',
    'revoke', 'disconnect', 'terminate', 'wipe', 'empty trash', 'clear all', 'clear history', 'clear data',
    'cancel subscription', 'cancel my subscription', 'cancel account', 'cancel membership', 'cancel order', 'close account'],
  ['삭제', '제거', '지우기', '비우기', '휴지통', '탈퇴', '해지', '초기화', '비활성화', '폐기', '연결 해제', '연동 해제',
    '권한 해제', '등록 해제', '删除', '移除', '清空', '注销', '取消订阅'],
)
const SUBMIT_WORDS = vocabulary(
  ['submit', 'send', 'publish', 'post', 'confirm', 'apply', 'sign up', 'register', 'save', 'update', 'create', 'approve',
    'reject', 'agree', 'accept', 'upload', 'share', 'invite', 'reply', 'comment', 'request', 'vote', 'transfer', 'connect'],
  ['제출', '보내기', '전송', '발송', '게시', '등록', '올리기', '업로드', '확인', '신청', '가입', '저장', '업데이트', '적용',
    '만들기', '생성', '작성 완료', '수정 완료', '변경 완료', '변경하기', '완료', '승인', '거절', '거부', '반려', '동의',
    '수락', '공유', '초대', '답장', '답글', '투표', '요청',
    '提交', '发送', '发布', '确认', '保存', '更新', '创建', '批准', '拒绝', '驳回'],
)
// A cookie banner's refusal is not a write although "reject"/"거부" is submission vocabulary.
const COOKIE_REJECT = /cookie|쿠키|^reject\s*all$|^(?:모두|전체)\s*거부$|^(?:拒绝所有|全部拒绝|拒绝全部)$/i
// Affirmative labels grant access on a consent page; "Allow" alone elsewhere is a cookie banner's.
const AFFIRMATIVE = /^(?:allow|continue|accept|approve|agree|yes)(?:\b|$)|^(?:허용|계속|수락|승인|동의|확인)|^(?:예|네)$|^(?:允许|继续|接受|同意|批准)/i
const CONSENT_PATH = /oauth|authori[sz]e|consent/i
// A generic confirmation label: pay when a money amount is next to it.
const GENERIC_CONFIRM = /^(?:confirm|ok|okay|continue|next|proceed|agree|submit|yes)(?:\b|$)|^(?:확인|확정|다음|계속|진행|동의|완료)|^(?:예|네)$|^(?:确认|确定|继续|下一步)/i
// A money amount in the label itself (the Child may also report one next to the element).
const MONEY = /[$€£¥₩]\s?\d|\d[\d,.]*\s?(?:만\s?)?(?:원|달러|엔|위안)|\b\d[\d,.]*\s?(?:usd|krw|eur|gbp|jpy|won)\b|\b(?:usd|krw|eur|gbp|jpy)\s?\d/i
const DELETE_CLASSES = /(^|[\s_-])(delete|remove|destroy|trash|discard)([\s_-]|$)/i
// Focusing or opening these never writes; a click on them is not classified by its label.
const NON_ACTIVATING_ROLES = new Set(['textbox', 'searchbox', 'spinbutton', 'slider', 'scrollbar', 'scrollable',
  'separator', 'combobox'])
const TEXT_INPUT_TYPES = new Set(['', 'text', 'search', 'email', 'url', 'tel', 'password', 'number', 'date', 'month',
  'week', 'time', 'datetime-local'])
const SEARCH_WORDS = /\bsearch\b|검색|찾기|搜索/i

function text(value, max = MAX_LABEL) {
  if (typeof value !== 'string') return ''
  const raw = value.length > MAX_RAW ? `${value.slice(0, MAX_RAW / 2)} ${value.slice(-MAX_RAW / 2)}` : value
  const flat = raw.normalize('NFKC').replace(/\s+/g, ' ').trim()
  if (flat.length <= max) return flat
  return `${flat.slice(0, Math.ceil(max / 2))} ${flat.slice(-Math.floor(max / 2))}`
}
function lower(value) { return text(value, 64).toLowerCase() }
function record(value) { return !!value && typeof value === 'object' && !Array.isArray(value) }

function term(pattern, label) {
  const match = pattern.exec(label)
  return match ? match[0].toLowerCase().replace(/\s+/g, ' ').trim() : undefined
}

function onConsentPage(url) {
  if (typeof url !== 'string' || !url) return false
  try { return CONSENT_PATH.test(new URL(url).pathname) } catch { return false }
}

function hasAmount(input, label) {
  if (input.amount === true) return true
  if (typeof input.amount === 'string' && MONEY.test(input.amount.slice(0, 200))) return true
  return MONEY.test(label)
}

function result(category, reason, extra = {}) {
  const out = { category, reason }
  if (extra.term) out.term = extra.term
  if (extra.source) out.source = extra.source
  return out
}

// The label decides pay, grant and delete (nanobrowser byName order: pay, grant,
// consent affirmative, money next to a generic confirm, delete); cancellations first.
function byName(label, amount, url) {
  if (!label) return null
  let found
  if ((found = term(CANCEL_WORDS, label))) return result('delete', 'cancel-vocabulary', { term: found })
  if ((found = term(PAY_WORDS, label))) return result('pay', 'pay-vocabulary', { term: found })
  // Grant before submit, so a consent form's submit button is a grant.
  if ((found = term(GRANT_WORDS, label))) return result('grant', 'grant-vocabulary', { term: found })
  if (onConsentPage(url) && (found = term(AFFIRMATIVE, label))) return result('grant', 'consent-affirmative', { term: found })
  if (amount && (found = term(GENERIC_CONFIRM, label))) return result('pay', 'amount-with-confirm', { term: found })
  if ((found = term(DELETE_WORDS, label))) return result('delete', 'delete-vocabulary', { term: found })
  return null
}

function roleOf(input) {
  const role = lower(input.role)
  if (role) return role
  const tag = lower(input.tag)
  const type = lower(input.type)
  if (tag === 'textarea') return 'textbox'
  if (tag === 'select') return 'combobox'
  if (tag === 'input' && TEXT_INPUT_TYPES.has(type)) return type === 'search' ? 'searchbox' : 'textbox'
  return ''
}

function isTextEntry(input, role) {
  if (typeof input.textEntry === 'boolean') return input.textEntry
  return role === 'textbox' || role === 'searchbox'
}

function isSearchField(input, role, label) {
  if (typeof input.searchField === 'boolean') return input.searchField
  return role === 'searchbox' || lower(input.type) === 'search' || SEARCH_WORDS.test(label)
}

// HTML implicit submission (nanobrowser enterSubmits): a default button that is not
// disabled, or no submit button and at most one blocking field. The Child's own answer
// (implicitSubmission: true|false) wins; missing facts lean toward a submission.
export function enterSubmits(input = {}) {
  if (typeof input.implicitSubmission === 'boolean') return input.implicitSubmission
  const form = input.form
  if (!record(form)) return form === null ? false : true
  if (record(form.defaultButton)) return form.defaultButton.disabled !== true
  if (form.hasSubmitButton === false && Number.isInteger(form.blockingFields)) return form.blockingFields <= 1
  return true
}

function defaultButtonNames(form) {
  const button = record(form) && record(form.defaultButton) ? form.defaultButton : null
  if (!button) return []
  return [text(button.accessibleName), text(button.label)].filter(Boolean)
}

function classifyEnter(input, label, role, amount) {
  const form = input.form
  const formKnown = form !== undefined || typeof input.implicitSubmission === 'boolean'
  const search = record(form) ? form.search === true : isSearchField(input, role, label)
  if (!formKnown) {
    // Nothing is known about a form owner: lean toward a submission unless it is a search field.
    if (search) return result('none', 'search-form', { source: 'form' })
    return result('submit', 'enter-unknown-form', { source: 'form' })
  }
  if (form === null && input.implicitSubmission !== true) {
    // Enter in a text box with no form sends what it holds in chat, comment and message boxes.
    if (isTextEntry(input, role) && !search) return result('submit', 'enter-sends-text', { source: 'form' })
    return result('none', 'enter-no-submit', { source: 'form' })
  }
  if (!enterSubmits(input)) return result('none', 'enter-no-submit', { source: 'form' })
  // The default button's name says what the submission does; a search form is exempt from submit only.
  for (const name of defaultButtonNames(form)) {
    const named = byName(name, amount, input.url)
    if (named) return { ...named, source: 'default-button' }
  }
  if (search) return result('none', 'search-form', { source: 'form' })
  return result('submit', 'enter-submits-form', { source: 'form' })
}

function classifyActivate(input, label, role, amount) {
  if (NON_ACTIVATING_ROLES.has(role)) return result('none', 'non-activating-role', { source: 'role' })
  const named = byName(label, amount, input.url)
  if (named) return { ...named, source: 'label' }
  if (DELETE_CLASSES.test(text(input.classes, 300))) return result('delete', 'delete-class', { source: 'class' })
  const form = input.form
  const search = record(form) && form.search === true
  // A submitter submits its form owner; an unknown owner leans toward a submission.
  if (input.submitter === true && form !== null && !search) return result('submit', 'form-submitter', { source: 'form' })
  const found = term(SUBMIT_WORDS, label)
  if (found && !search && COOKIE_REJECT.test(label)) return result('none', 'cookie-reject', { source: 'label' })
  if (found && !search) return result('submit', 'submit-vocabulary', { term: found, source: 'label' })
  return result('none', 'no-signal')
}

// 32-bit FNV-1a: the basis compares two judgements without keeping the page text.
function fnv1a(value) {
  let hash = 0x811c9dc5
  for (let index = 0; index < value.length; index++) {
    hash ^= value.charCodeAt(index)
    hash = Math.imul(hash, 0x01000193) >>> 0
  }
  return hash.toString(16).padStart(8, '0')
}

// classifyAction(input) -> frozen { category, reason, term?, source?, basis }
//   mode        'activate' (click, or Enter/Space on a button or link; default) | 'enter' (Enter in a field)
//   label       accessible name as observed       role, tag, type   as observed
//   url         address of the frame the element is in (consent-page rule)
//   classes     class and test ids (data-testid, data-test, data-qa)
//   amount      true, or the text of a money amount next to the element (only tested, never kept)
//   submitter   activating it submits its form owner
//   textEntry, searchField   optional; derived from role, type and label when absent
//   form        null (no form owner) | undefined (unknown) |
//               { search, method, hasSubmitButton, blockingFields, defaultButton: { label, accessibleName, disabled } | null }
//   implicitSubmission  for 'enter': the Child's answer whether Enter submits (EGDeskBrowserAgentRuntimeChild implicitSubmission)
export function classifyAction(input) {
  const facts = record(input) ? input : {}
  const mode = facts.mode === 'enter' ? 'enter' : 'activate'
  const label = text(facts.label)
  const role = roleOf(facts)
  const amount = hasAmount(facts, label)
  const judged = mode === 'enter' ? classifyEnter(facts, label, role, amount) : classifyActivate(facts, label, role, amount)
  const formKey = record(facts.form)
    ? [facts.form.search === true, lower(facts.form.method), ...defaultButtonNames(facts.form),
      facts.form.defaultButton?.disabled === true].join('\u0001')
    : String(facts.form)
  const basis = `${judged.category}:${judged.reason}:${fnv1a([mode, label, role, amount, formKey,
    facts.submitter === true, typeof facts.implicitSubmission === 'boolean' ? facts.implicitSubmission : ''].join('\u0000'))}`
  return Object.freeze({ ...judged, basis })
}

// After the person answers, the action is classified again just before dispatch; a
// different basis (label, amount, form or category changed) means the answer is stale.
export function sameJudgement(before, after) {
  return record(before) && record(after) && typeof before.basis === 'string' && before.basis === after.basis
}

function validGatePolicy(policy) {
  if (!record(policy)) return false
  for (const [key, value] of Object.entries(policy)) {
    if (!['pay', 'grant', 'delete', 'submit'].includes(key) || !ACTION_GATES.includes(value)) return false
  }
  return true
}

// actionGate(classificationOrCategory, policy = CURRENT_ACTION_GATE_POLICY)
//   -> 'allow' | 'confirm' | 'user-step' | 'deny'
// 'none' is always 'allow'. An unknown category is the person's step. A policy that
// cannot be read falls back to RECOMMENDED_ACTION_GATE_POLICY for that category.
export function actionGate(classification, policy = CURRENT_ACTION_GATE_POLICY) {
  const category = typeof classification === 'string' ? classification : classification?.category
  if (category === 'none') return 'allow'
  if (!['pay', 'grant', 'delete', 'submit'].includes(category)) return 'user-step'
  if (!validGatePolicy(policy)) return RECOMMENDED_ACTION_GATE_POLICY[category]
  return policy[category] ?? RECOMMENDED_ACTION_GATE_POLICY[category]
}
