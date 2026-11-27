// L8 c25: the two false exclusions the c24 hold-out families found in the real option code, fixed, and the look-alikes that must STAY withheld.
//   (a) a button the code proved to be a read-only GET search is not withheld by its label alone ("확인" is submit vocabulary);
//   (b) 등록 is a submit word as a word of its own or in a registering phrase, never inside 주민등록 (a certificate) or another noun.
import test from 'node:test'
import assert from 'node:assert/strict'
import { classifyAction } from './egdesk-browser-action-classifier.mjs'
import { buildReflexCandidates, reflexActionArgs } from './egdesk-browser-reflex.mjs'

const SITE = 'https://power.example.test'
const el = (ref, role, label, extra = {}) => ({ ref, role, label, tag: role === 'link' ? 'a' : role === 'button' ? 'button' : 'input', href: '', value: '', ...extra })
const form = (method, extra = {}) => ({ type: 'submit', sensitiveRegion: false, regionLabel: '요금 조회', controls: null, form: { method, fields: ['select', 'submit'], sensitive: false, submitUrl: `${SITE}/bill/view?month=2026-11`, ...extra } })
const offered = (elements, url = `${SITE}/bill`) => buildReflexCandidates({ url, interactiveElements: elements }).options.map(o => o.value)
const gated = (elements, url = `${SITE}/bill`) => buildReflexCandidates({ url, interactiveElements: elements }).excluded

test('(a) a 확인 button proven to be a read-only GET form is offered, with where it goes, and is executed as that navigation', () => {
  const snapshot = { url: `${SITE}/bill`, revision: 1, interactiveElements: [el('go', 'button', '확인', { nav: form('get') })] }
  const { options, excluded } = buildReflexCandidates(snapshot)
  assert.deepEqual(options.map(o => o.value), ['[B1] 확인'])
  assert.match(options[0].description, /opens \/bill\/view\?month=2026-11 \(a read-only search\)/)
  assert.equal(excluded.gated, 0)
  const act = reflexActionArgs(options[0], { cardId: 'card', observationId: 'o', snapshot })
  assert.deepEqual([act.tool, act.args.url], ['egdesk_browser_navigate', `${SITE}/bill/view?month=2026-11`])
  // the label is not what decides: the same proof offers the other submit words too
  for (const label of ['조회하기', '검색', '적용', '다음']) assert.deepEqual(offered([el('go', 'button', label, { nav: form('get') })]), [`[B1] ${label}`], label)
})

test('(a) look-alikes stay withheld: a POST 확인, a 확인 without the proof, a sensitive form or region, off-site, a risky address, and pay/delete words', () => {
  const withheld = (label, nav, why) => { const e = gated([el('go', 'button', label, nav === undefined ? {} : { nav })]); assert.deepEqual([offered([el('go', 'button', label, nav === undefined ? {} : { nav })]), e.gated], [[], 1], why) }
  withheld('확인', form('post'), 'POST')
  withheld('확인', undefined, 'no facts (an older runtime)')
  withheld('확인', form('get', { sensitive: true }), 'a form with a credential, payment or consent field')
  withheld('확인', form('get', { fields: ['password', 'submit'] }), 'a field kind outside the safe ones')
  withheld('확인', { ...form('get'), sensitiveRegion: true }, 'a region marked sensitive')
  withheld('확인', { ...form('get'), regionLabel: '결제 정보' }, 'a region whose label is payment vocabulary')
  withheld('확인', form('get', { submitUrl: 'https://elsewhere.test/bill/view' }), 'another site')
  withheld('확인', form('get', { submitUrl: `${SITE}/account/delete?confirm=1` }), 'an address that says delete')
  withheld('확인', form('get', { submitUrl: `${SITE}/login?next=/bill` }), 'an address that says log in')
  withheld('결제 확인', form('get'), 'pay vocabulary is never overridden by the proof')
  withheld('삭제', form('get'), 'delete vocabulary is never overridden by the proof')
  withheld('권한 허용', form('get'), 'grant vocabulary is never overridden by the proof')
  // a view-only button is not a GET form: a submit word on it stays withheld
  withheld('확인', { type: 'button', sensitiveRegion: false, regionLabel: '', form: null, controls: { text: '내역' } }, 'a view button with a submit label')
})

test('(b) 등록 is a submit word alone or in a registering phrase, never inside a noun', () => {
  const cls = label => classifyAction({ mode: 'activate', label, role: 'button', tag: 'button' }).category
  for (const label of ['주민등록표 등본 교부', '주민등록표 초본 교부', '주민등록증 재발급 안내', '사업자등록증 조회', '사업자등록번호 안내', '등록한 근거', '등록증 보기', '토지등기 등록현황']) assert.equal(cls(label), 'none', label)
  for (const label of ['등록', '댓글 등록', '등록하기', '등록 하기', '등록 완료', '회원등록', '회원 등록', '상품 등록', '리뷰 등록', '게시물 등록', '등록하세요']) assert.equal(cls(label), 'submit', label)
  assert.equal(cls('카드 등록'), 'pay')
  assert.equal(cls('Register'), 'submit')
  assert.equal(cls('주민등록 등본 신청'), 'submit', '신청 is still a submit word')
})

test('(b) the certificate links are offered; a registering link on the same site is a page change; a 등록하기 button, another site and a register address stay withheld', () => {
  const I = 'https://minwon.example.test'
  const certificates = [el('a', 'link', '주민등록표 등본 교부', { href: `${I}/issue/resident` }), el('b', 'link', '주민등록표 초본 교부', { href: `${I}/issue/extract` }), el('c', 'link', '가족관계증명서 발급', { href: `${I}/issue/family` })]
  assert.deepEqual(offered(certificates, `${I}/issue`), ['[L1] 주민등록표 등본 교부', '[L2] 주민등록표 초본 교부', '[L3] 가족관계증명서 발급'])
  assert.deepEqual(offered([el('m', 'link', '회원등록', { href: `${I}/member/join` })], `${I}/`), ['[L1] 회원등록'], 'same site, a page change, the address is clean')
  const closed = (element, why) => assert.deepEqual(offered([element], `${I}/`), [], why)
  closed(el('m', 'link', '회원등록', { href: 'https://elsewhere.test/member/join' }), 'a 회원등록 link to ANOTHER site')
  closed(el('m', 'link', '회원등록', { href: `${I}/member/register` }), 'the address says register')
  closed(el('m', 'link', '가입 신청', { href: `${I}/member/join` }), '신청 is still a submit word on a link')
  closed(el('r', 'button', '등록하기'), 'a 등록하기 submit button (no proof)')
  closed(el('r', 'button', '등록하기', { nav: form('post') }), 'a 등록하기 POST button')
})

// ---- c36 (Main's precision fix): link phrases 예매 내역 and … 확인 ----
test('c36: a same-site link ending in 확인 and a booking-history link are page changes; 예매하기, 결제 확인, other sites, buttons and risky addresses stay withheld', () => {
  const T = 'https://ticket.example.test'
  const link = (label, href) => offered([el('l', 'link', label, { href })], `${T}/my`)
  assert.deepEqual(link('내 순번 확인', `${T}/queue/me`), ['[L1] 내 순번 확인'])
  assert.deepEqual(link('예매 내역 보기', `${T}/my/bookings`), ['[L1] 예매 내역 보기'])
  assert.deepEqual(link('예매 확인', `${T}/my/bookings`), ['[L1] 예매 확인'])
  assert.deepEqual(link('예매 조회', `${T}/my/bookings`), ['[L1] 예매 조회'])
  // look-alikes that stay withheld
  assert.deepEqual(link('예매하기', `${T}/book`), [], '예매하기 is a payment')
  assert.deepEqual(link('콘서트 예매', `${T}/book`), [], '예매 alone is a payment')
  assert.deepEqual(link('결제 확인', `${T}/pay/confirm`), [], 'pay vocabulary never yields')
  assert.deepEqual(link('주문 취소 확인', `${T}/orders/cancel`), [], 'delete vocabulary never yields')
  assert.deepEqual(link('내 순번 확인', 'https://elsewhere.test/queue/me'), [], 'another site')
  assert.deepEqual(link('내 순번 확인', `${T}/queue/delete`), [], 'a risky address stays classified')
  assert.deepEqual(link('내 순번 확인', `${T}/login?next=/queue`), [], 'a sign-in address stays withheld')
  assert.deepEqual(link('신청 확인', `${T}/apply/status`), [], 'only 확인 as the term (신청 comes first here and stays submit)')
  assert.deepEqual(offered([el('b', 'button', '확인')], `${T}/my`), [], 'a button is not a link (no proof: withheld)')
  assert.deepEqual(offered([el('b', 'button', '예매 내역')], `${T}/my`), [], 'a button named 예매 내역 stays withheld (no proof)')
})
