// Round g, lane L62: real-window QA cases P1..P7 for Browser procedures (save, edit, reuse). Contract: round-g-procedures.md section 5.
// Run: node run-proc.mjs P3 [rep]   |   node run-proc.mjs all     Print one case: node cases-proc.mjs P3
// A case is { name, card, url, then?, msg-bearing phases, checks }. Phases run in order (see PHASE_KINDS):
//   goto {to:'url'|'then'}            move the Card (go-card.mjs); 'then' is a second, fresh copy of the same page
//   seed {procedure}                  POST /v1/procedures with a literal procedure; '{{URL}}' in start.url / navigate urls is replaced by the case url
//   chat {msg, answerRe?, answerNotRe?, id?}  send one chat message ({{NAME}} = saved procedure name), wait idle, check the last answer
//   capture {name?}                   POST /v1/procedures/capture for the last chat thread + card -> ctx.draft
//   save {from:'draft'}               POST /v1/procedures with ctx.draft -> ctx.proc (and ctx.name)
//   put {edits:[...]}                 GET, apply edits (rename | setDefault {param,value} | removeStepWithLabel), PUT
//   get                               GET /v1/procedures/:id -> ctx.proc
//   eval {checks:[expr], id?}         page-eval expressions on the Card's page (true expected)
//   proc {checks:[expr], on?:'draft'|'proc'}  expressions over p (the procedure JSON), ctx ({url, name, seed})
// anyOf: ids (of eval/chat phases) of which at least one must pass (P7). Every other check must pass.
// All fixture pages are delivery-form pages with fake data only. data: URLs are rewritten to http://127.0.0.1:8770/ by the runner (fixture-server.mjs).
import { CHANGE_URL } from './change-fixture.mjs'
export const dataUrl = html => 'data:text/html;charset=utf-8,' + encodeURIComponent(html).replace(/[!'()*]/g, c => '%' + c.charCodeAt(0).toString(16).toUpperCase())
const H = (title, body) => `<!doctype html><html lang="ko"><head><meta charset="utf-8"><title>${title}</title><style>body{font:14px sans-serif;margin:16px;max-width:620px}label{display:block;margin:6px 0}input,textarea{padding:4px;width:320px}button{padding:6px 12px;margin:8px 4px 0 0}.msg{margin:8px 0;color:#085}</style></head><body data-state="draft">${body}</body></html>`
const FIELDS = [['recipient', '받는 분'], ['phone', '연락처'], ['zip', '우편번호'], ['addr1', '주소'], ['addr2', '상세 주소'], ['memo', '배송 요청사항']]
const field = (name, label, type = 'text') => `<label for="${name}">${label}</label><input id="${name}" name="${name}" type="${type}">`
const SUBMIT_JS = `<script>const B=document.body.dataset;B.submits='0';document.getElementById('f').addEventListener('submit',e=>{e.preventDefault();B.submits=String(+B.submits+1);B.state='submitted';document.getElementById('msg').textContent='접수되었습니다 (모의)'})</script>`
// Delivery form with 6 fields and NO submit button of its own (P1, P2, P3): a plain "임시 확인" button only.
export const deliveryHtml = (labels = {}) => H('배송지 입력 (모의)', `<h2>배송지 입력</h2><form id="f" onsubmit="return false">${FIELDS.map(([n, l]) => field(n, labels[n] || l)).join('')}<button type="button" id="peek">입력 내용 확인</button></form><div class="msg" id="msg"></div><script>document.body.dataset.submits='0'</script>`)
// Variant: the first label "받는 분" became "수령인" (P7).
export const deliveryVariantHtml = () => deliveryHtml({ recipient: '수령인' })
// Final POST submit button (P5): 2 fields and a submit button of a method=post form. The handler only counts (no network).
export const deliverySubmitHtml = () => H('배송 주문 (모의)', `<h2>배송 주문</h2><form id="f" method="post" action="/order">${field('recipient', '받는 분')}${field('phone', '연락처')}<button type="submit" id="go">제출</button></form><div class="msg" id="msg"></div>${SUBMIT_JS}`)
// Password field (P6): id, password, login. Login only counts.
export const deliveryLoginHtml = () => H('배송 조회 로그인 (모의)', `<h2>배송 조회 로그인</h2><form id="f" method="post" action="/login">${field('uid', '아이디')}${field('pw', '비밀번호', 'password')}<button type="submit" id="go">로그인</button></form><div class="msg" id="msg"></div>${SUBMIT_JS}`)

const el = (id, v) => `document.getElementById("${id}").value === ${JSON.stringify(v)}`
const empty = id => `document.getElementById("${id}").value === ""`
export const DEFAULTS = { recipient: '김하늘', phone: '010-0000-1234', zip: '04524', addr1: '서울 중구 세종대로 110', addr2: '3층', memo: '문 앞에 놓아주세요' }
const textbox = label => ({ label, role: 'textbox', tag: 'input' })
const button = label => ({ label, role: 'button', tag: 'button' })
// Seed procedure builder (Procedure JSON v1 without id/createdAt/updatedAt: the service assigns them).
export const mkProc = (name, fills, extra = [], { host = '127.0.0.1', params } = {}) => ({
  version: 1, name, start: { url: '{{URL}}', host, title: '' },
  params: params || fills.map(([label, value, sensitive]) => ({ name: label, default: sensitive ? null : value, sensitive: !!sensitive })),
  steps: [...fills.map(([label, value, sensitive], i) => ({ id: 's' + (i + 1), op: 'fill', target: textbox(label), value: { param: label }, expect: { kind: 'target-value' }, ...(sensitive ? { person: true } : {}) })), ...extra.map((s, i) => ({ id: 's' + (fills.length + i + 1), ...s }))],
})
const six = FIELDS.map(([n, l]) => [l, DEFAULTS[n]])
const ASK6 = `이 카드 배송지 폼에 ${six.map(([l, v]) => `${l} ${v}`).join(', ')} 입력해줘. 제출은 하지 마`
const STEP_LABELS = six.map(([l]) => l)
const noSubmit = 'document.body.dataset.submits === "0"'
const fillDefaults = (skip = []) => FIELDS.filter(([n]) => !skip.includes(n)).map(([n]) => el(n, DEFAULTS[n]))

export const CASES = {
  P1: { name: '저장: 6칸 입력을 채팅으로 시킨 뒤 캡처하고 저장', card: 'egd-browser-card-13', url: dataUrl(deliveryHtml()), expected: '6개 fill 단계, 6개 params(기본값 포함), start.url 일치, confirm 없음; 저장 후 목록에 나타남',
    phases: [
      { do: 'goto', to: 'url' },
      { do: 'chat', msg: ASK6 },
      { do: 'eval', checks: fillDefaults().concat(noSubmit) },
      { do: 'capture', name: '배송지 입력 (QA)' },
      { do: 'proc', on: 'draft', checks: [
        'p.steps.length === 6', 'p.steps.every(s => s.op === "fill")', 'p.params.length === 6', 'p.params.every(q => typeof q.default === "string" && q.default && !q.sensitive)',
        `${JSON.stringify(six)}.every(([l, v]) => p.params.some(q => q.name === l && q.default === v))`, 'p.start.url === ctx.url', 'p.start.host.split(":")[0] === "127.0.0.1"', '!p.steps.some(s => s.confirm)', '!p.steps.some(s => s.person)'] },
      { do: 'save', from: 'draft' },
      { do: 'proc', on: 'proc', checks: ['/^proc-[0-9a-f]{12,32}$/.test(p.id)', 'p.steps.length === 6'] },
    ] },
  P2: { name: '수정: 이름 변경, 기본값 하나 변경, 단계 하나 삭제 뒤 GET', card: 'egd-browser-card-13', url: dataUrl(deliveryHtml()), expected: 'PUT 뒤 GET에 새 이름, 바뀐 기본값, 5단계(삭제된 단계 없음), createdAt 유지',
    seed: mkProc('배송지 입력 (QA 수정 전)', six),
    phases: [
      { do: 'seed' },
      { do: 'put', edits: [{ rename: '배송지 입력 (QA 수정 후)' }, { setDefault: { param: '받는 분', value: '이하늘' } }, { removeStepWithLabel: '배송 요청사항' }] },
      { do: 'get' },
      { do: 'proc', on: 'proc', checks: [
        'p.name === "배송지 입력 (QA 수정 후)"', 'p.params.find(q => q.name === "받는 분").default === "이하늘"', 'p.steps.length === 5', '!p.steps.some(s => s.target && s.target.label === "배송 요청사항")',
        'p.params.find(q => q.name === "연락처").default === "010-0000-1234"', 'p.createdAt === ctx.seed.createdAt', 'p.updatedAt >= ctx.seed.updatedAt'] },
    ] },
  P3: { name: '채팅으로 실행: 기본값과 덮어쓰기, 삭제된 단계의 칸은 빈 채로, 제출 없음', card: 'egd-browser-card-13', url: dataUrl(deliveryHtml()), then: dataUrl(deliveryHtml()), expected: '받는 분=이하늘(덮어씀), 나머지 4칸=기본값, 삭제된 배송 요청사항 칸 비어 있음, submits=0',
    seed: mkProc('배송지 입력 (QA 실행)', six.slice(0, 5)),
    phases: [
      { do: 'seed' }, { do: 'goto', to: 'then' },
      { do: 'chat', msg: '‘{{NAME}}’ 절차를 실행해줘. 받는 분: 이하늘' },
      { do: 'eval', checks: [el('recipient', '이하늘')].concat(fillDefaults(['recipient', 'memo']), [empty('memo'), noSubmit]) },
    ] },
  P4: { name: '계속 바뀌는 페이지(L55 변화 픽스처)에서 1단계 절차 실행', card: 'egd-browser-card-13', url: CHANGE_URL, expected: '이름 칸이 채워지고 페이지는 계속 바뀌었음(ticks > 30)',
    seed: mkProc('변화 폼 이름 입력 (QA)', [['이름', '차민수']]),
    phases: [
      { do: 'goto', to: 'url' }, { do: 'seed' },
      { do: 'chat', msg: '‘{{NAME}}’ 절차를 실행해줘.' },
      { do: 'eval', checks: [el('name', '차민수'), '+document.documentElement.dataset.ticks > 30'] },
    ] },
  P5: { name: '확인: 마지막 제출 클릭 앞에서 멈추고, 승인 뒤에 제출', card: 'egd-browser-card-13', url: dataUrl(deliverySubmitHtml()), expected: '첫 실행은 제출 전에 멈춤(needs_confirm; submits=0, 답이 확인을 구함); "응 제출해" 뒤 submits=1',
    seed: mkProc('배송 주문 제출 (QA)', six.slice(0, 2), [{ op: 'click', target: button('제출'), expect: { kind: 'changed' }, confirm: 'submit' }]),
    phases: [
      { do: 'goto', to: 'url' }, { do: 'seed' },
      { do: 'proc', on: 'proc', checks: ['p.steps.length === 3', 'p.steps[2].confirm === "submit"'] },
      { do: 'chat', msg: '‘{{NAME}}’ 절차를 실행해줘.', id: 'ask', answerRe: '제출|확인|승인', answerNotRe: '제출(했|되었|됐)(습니다|어요)|접수(되었|됐)(습니다|어요)' },
      { do: 'eval', id: 'before', checks: [el('recipient', DEFAULTS.recipient), el('phone', DEFAULTS.phone), noSubmit] },
      { do: 'chat', msg: '응 제출해', id: 'go' },
      { do: 'eval', id: 'after', checks: ['document.body.dataset.submits === "1"', 'document.body.dataset.state === "submitted"'] },
    ] },
  P6: { name: '민감: 비밀번호 칸은 사람 단계, 값은 저장되지 않고 실행은 거기서 멈춤', card: 'egd-browser-card-13', url: dataUrl(deliveryLoginHtml()), expected: '비밀번호 단계는 person:true, param은 sensitive:true default:null, JSON에 비밀번호 문자열 없음; 실행은 human_step으로 멈추고 비밀번호 칸 비어 있음, 로그인 미누름',
    seed: mkProc('배송 조회 로그인 (QA)', [['아이디', 'hanul01'], ['비밀번호', null, true]], [{ op: 'click', target: button('로그인'), expect: { kind: 'changed' } }]),
    phases: [
      { do: 'goto', to: 'url' }, { do: 'seed' },
      { do: 'proc', on: 'proc', checks: [
        'p.params.find(q => q.name === "비밀번호").sensitive === true', 'p.params.find(q => q.name === "비밀번호").default === null', 'p.steps[1].person === true', 'JSON.stringify(p).indexOf("QA-SECRET") < 0'] },
      { do: 'chat', msg: '‘{{NAME}}’ 절차를 실행해줘. 비밀번호: QA-SECRET-9911', id: 'stop', answerRe: '비밀번호|직접|사람', answerNotRe: '로그인(했|되었|됐)(습니다|어요)' },
      { do: 'eval', checks: [empty('pw'), noSubmit] }, // the login form as a whole is the person's (same as case 16 today): the id field may stay empty
      { do: 'get' },
      { do: 'proc', on: 'proc', checks: ['JSON.stringify(p).indexOf("QA-SECRET") < 0'] },
    ] },
  P7: { name: '라벨 변경: "받는 분"이 "수령인"이 된 페이지', card: 'egd-browser-card-13', url: dataUrl(deliveryVariantHtml()), expected: '결정 모델 폴백으로 수령인 칸을 채우거나, 단계를 짚어 말하고 깔끔히 멈춤(엉뚱한 칸을 채우거나 제출하지 않음)',
    seed: mkProc('배송지 입력 (QA 라벨)', six.slice(0, 2)),
    anyOf: ['filled', 'stop-named'],
    phases: [
      { do: 'goto', to: 'url' }, { do: 'seed' },
      { do: 'chat', msg: '‘{{NAME}}’ 절차를 실행해줘.', id: 'stop-named', answerRe: '받는 분|수령인|s1|첫 번째|찾지 못|찾을 수 없' },
      { do: 'eval', id: 'filled', checks: [el('recipient', DEFAULTS.recipient), el('phone', DEFAULTS.phone)] },
      { do: 'eval', checks: [noSubmit, 'document.getElementById("zip").value === "" && document.getElementById("memo").value === ""'] },
    ] },
}
export const PHASE_KINDS = ['goto', 'seed', 'chat', 'capture', 'save', 'put', 'get', 'eval', 'proc']
export const CASE_IDS = Object.keys(CASES)
// Fixture pages by logical name (for tests).
export const FIXTURES = { delivery: deliveryHtml, variant: deliveryVariantHtml, submit: deliverySubmitHtml, login: deliveryLoginHtml }

// ---- pure helpers used by run-proc.mjs (kept here so the structure test covers them) ----
export const SKIP_MESSAGE = 'SKIP: /v1/state has no capabilities.browserProcedures (EGDESK_BROWSER_PROCEDURES is off or the build lacks the procedures lanes). No case was run.'
export const hasProcedureCapability = state => state?.capabilities?.browserProcedures === true
export const fillTemplate = (s, vars) => String(s).replace(/\{\{(\w+)\}\}/g, (m, k) => (k in vars ? String(vars[k]) : m))
export function resolveSeed(seed, url, name) { const s = JSON.parse(JSON.stringify(seed).replaceAll('{{URL}}', url)); if (name) s.name = name; return s }
export function applyEdits(proc, edits) {
  const p = JSON.parse(JSON.stringify(proc))
  for (const e of edits) {
    if (e.rename) p.name = e.rename
    if (e.setDefault) { const q = p.params.find(x => x.name === e.setDefault.param); if (!q) throw new Error('no param ' + e.setDefault.param); q.default = e.setDefault.value }
    if (e.removeStepWithLabel) { const n = p.steps.length; p.steps = p.steps.filter(s => s.target?.label !== e.removeStepWithLabel); if (p.steps.length === n) throw new Error('no step ' + e.removeStepWithLabel); const used = new Set(p.steps.map(s => s.value?.param).filter(Boolean)); p.params = p.params.filter(q => used.has(q.name)); p.steps.forEach((s, i) => { s.id = 's' + (i + 1) }) }
  }
  return p
}
// Evaluate a procedure-JSON check expression. Returns true/false, or an Error string.
export function evalProcCheck(expr, p, ctx = {}) { try { return !!new Function('p', 'ctx', `return (${expr})`)(p, ctx) } catch (e) { return 'ERR ' + String(e.message).slice(0, 80) } }
// Find the client thread id of the most recent chat from /v1/state (chat.runs) or /chat/history/threads (any common shape).
export function pickThreadId(state, threads) {
  const runs = state?.chat?.runs; if (Array.isArray(runs)) for (let i = runs.length - 1; i >= 0; i--) { const t = runs[i]?.clientThreadId || runs[i]?.threadId; if (t) return String(t) }
  const list = Array.isArray(threads) ? threads : threads?.threads; if (Array.isArray(list) && list.length) {
    const sorted = [...list].sort((a, b) => Number(b.updatedAt || b.lastEventAt || 0) - Number(a.updatedAt || a.lastEventAt || 0)); const t = sorted[0]?.clientThreadId || sorted[0]?.id; if (t) return String(t) }
  return null
}
if (process.argv[1] && import.meta.url === new URL(process.argv[1], 'file://').href) { const c = CASES[process.argv[2]]; console.log(c ? JSON.stringify({ ...c, url: c.url.slice(0, 60) + '…', then: c.then && c.then.slice(0, 40) + '…' }, null, 1) : 'cases: ' + CASE_IDS.join(' ')) }
