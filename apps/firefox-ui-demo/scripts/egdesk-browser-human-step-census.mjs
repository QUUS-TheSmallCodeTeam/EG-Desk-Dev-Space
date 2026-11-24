#!/usr/bin/env node
import { buildReflexCandidates } from '../helper/egdesk-browser-reflex.mjs'

// L8 c16 census (offline, code only): which page SHAPES stop by the c15 rule "nothing may be chosen and person-only controls were
// withheld" (no request, reason human_step), and for which of those a page-state request would have added a person-state label
// (two_factor_required, login_required, bot_check, sensitive_flow). The label column is the shape's design, not a model answer.
// This is not a frequency of real use: no browsing log exists to count from.
const O = 'https://portal.example.test'
const el = (ref, role, label, extra = {}) => ({ ref, role, label, tag: role === 'link' ? 'a' : role === 'button' ? 'button' : 'input', href: '', value: '', ...extra })
export const SHAPES = [
  { id: '2fa-code', label: 'two_factor_required', elements: [el('a', 'textbox', '인증번호'), el('b', 'button', '인증 확인')] },
  { id: '2fa-push', label: 'two_factor_required', elements: [el('b', 'button', '인증 확인')] },
  { id: '2fa-push-resend', label: 'two_factor_required', elements: [el('b', 'button', '인증 확인'), el('c', 'button', '다시 보내기')] },
  { id: 'login-password', label: 'login_required', elements: [el('a', 'textbox', '아이디'), el('p', 'password', '비밀번호'), el('b', 'button', '로그인')] },
  { id: 'login-sso-only', label: 'login_required', elements: [el('b', 'button', '카카오로 로그인')] },
  { id: 'captcha', label: 'bot_check', elements: [el('a', 'checkbox', '로봇이 아닙니다'), el('b', 'button', '확인')] },
  { id: 'checkout-pay', label: null, elements: [el('b', 'button', '결제하기')] },
  { id: 'delete-confirm', label: null, elements: [el('b', 'button', '삭제'), el('c', 'button', '취소')] },
  { id: 'subscription-cancel', label: null, elements: [el('l', 'link', '구독 해지', { href: `${O}/subscription/cancel` }), el('b', 'button', '제출')] },
  { id: 'permission-grant', label: null, elements: [el('b', 'button', '권한 허용')] },
  { id: 'form-submit-only', label: null, elements: [el('b', 'button', '발행 제출')] },
  { id: 'logout-only', label: null, elements: [el('l', 'link', '로그아웃', { href: `${O}/logout` })] },
]
export function census() {
  return SHAPES.map(shape => {
    const snapshot = { cardId: 'card', documentId: 'd', revision: 1, url: `${O}/${shape.id}`, readyState: 'complete', text: [], interactiveElements: shape.elements }
    const { options, excluded } = buildReflexCandidates(snapshot)
    const rule = !options.length && excluded.gated > 0 && excluded.sensitive === 0
    return { id: shape.id, offered: options.length, gated: excluded.gated, sensitive: excluded.sensitive, stops: rule ? 'human_step (no request)' : 'asked', labelLost: rule && shape.label ? shape.label : null }
  })
}
if (import.meta.url === `file://${process.argv[1]}`) {
  const rows = census()
  console.table(rows)
  console.log(JSON.stringify({ shapes: rows.length, stopByRule: rows.filter(r => r.stops !== 'asked').length, labelLost: rows.filter(r => r.labelLost).map(r => `${r.id}:${r.labelLost}`) }))
}
