import test from 'node:test'
import assert from 'node:assert/strict'
import { CHANGE_LOOKS, labelKey, matchTarget, runProcedure } from './egdesk-browser-procedure-run.mjs'

// Round g (L60): the procedure runner over fake guarded tools and fake observations. No browser, no model.
const field = (ref, label, extra = {}) => ({ ref, label, role: 'textbox', tag: 'input', value: '', ...extra })
const button = (ref, label, extra = {}) => ({ ref, label, role: 'button', tag: 'button', ...extra })
const proc = (steps, extra = {}) => ({ id: 'proc-abcdef123456', version: 1, name: '배송지', createdAt: 1, updatedAt: 1, start: { url: 'https://shop.example.test/form', host: 'shop.example.test' },
  params: [{ name: '받는 분', default: '이하늘', sensitive: false }, { name: '비밀번호', default: null, sensitive: true }], steps, ...extra })
const fill = (id, label, param = '받는 분') => ({ id, op: 'fill', target: { label, role: 'textbox' }, value: { param } })
const click = (id, label, extra = {}) => ({ id, op: 'click', target: { label, role: 'button' }, expect: { kind: 'changed' }, ...extra })

function world({ url = 'https://shop.example.test/form', elements = [], stale = 0, refuseNavigate = false } = {}) {
  const w = { url, revision: 1, elements, calls: [], staleLeft: stale, observes: 0 }
  w.callTool = async (name, args) => {
    w.calls.push([name, args])
    if (name === 'egdesk_browser_observe') { w.observes++; return { observationId: `o${w.observes}`, snapshot: { url: w.url, revision: w.revision, interactiveElements: w.elements } } }
    if (name === 'egdesk_browser_wait') return {}
    if (name === 'egdesk_browser_navigate') {
      if (refuseNavigate) throw Object.assign(new Error('out of scope'), { code: 'BROWSER_NAVIGATE_OUT_OF_SCOPE' })
      w.url = args.url; return {}
    }
    if (w.staleLeft > 0 && ['egdesk_browser_fill', 'egdesk_browser_click'].includes(name)) { w.staleLeft--; w.revision++; throw Object.assign(new Error('stale'), { code: 'BROWSER_OBSERVATION_STALE', staleBy: 'revision' }) }
    return { status: 'ok' }
  }
  w.acts = () => w.calls.filter(([name]) => !['egdesk_browser_observe', 'egdesk_browser_wait'].includes(name))
  return w
}
const frames = () => { const list = []; return { list, onStep: (run, event) => list.push(event) } }

test('labels and roles: exactly one match is a match, none or several are candidates', () => {
  assert.equal(labelKey('  받는   분 '), '받는 분')
  const els = [field('a', 'Name'), field('b', ' name '), button('c', 'Name')]
  assert.deepEqual(matchTarget(els, { label: 'NAME', role: 'button' }).element.ref, 'c')
  assert.equal(matchTarget(els, { label: 'name', role: 'textbox' }).candidates.length, 2)
  assert.equal(matchTarget(els, { label: 'zzz' }).candidates.length, 0)
  assert.equal(matchTarget([field('a', 'Name', { disabled: true })], { label: 'Name' }).candidates.length, 0)
})

test('exact match: fill takes the default, the press is a named press (c20), the run is done', async () => {
  const w = world({ elements: [field('e1', '받는 분'), button('e2', '다음')] })
  const f = frames()
  const out = await runProcedure({ procedure: proc([fill('s1', '받는 분'), click('s2', '다음')]), cardId: 'card', tools: w, onStep: f.onStep })
  assert.equal(out.status, 'done'); assert.deepEqual(out.done, ['s1', 's2'])
  const [fillCall, clickCall] = w.acts()
  assert.equal(fillCall[0], 'egdesk_browser_fill'); assert.equal(fillCall[1].text, '이하늘'); assert.deepEqual(fillCall[1].postcondition, { kind: 'target-value', value: '이하늘' })
  assert.equal(clickCall[0], 'egdesk_browser_click'); assert.deepEqual(clickCall[1].postcondition, { kind: 'named-page-change', value: 'same-document' })
  assert.deepEqual(f.list.filter(e => e.op === 'fill' || e.op === 'press').map(e => [e.op, e.target, e.ok]), [['fill', '받는 분', true], ['press', '다음', true]])
})

test('an override beats the default', async () => {
  const w = world({ elements: [field('e1', '받는 분')] })
  await runProcedure({ procedure: proc([fill('s1', '받는 분')]), cardId: 'card', values: { '받는 분': '차민수' }, tools: w })
  assert.equal(w.acts()[0][1].text, '차민수')
})

test('ambiguous label: the decision fallback chooses among the offered elements, once', async () => {
  const w = world({ elements: [field('e1', '이름'), field('e2', '이름'), button('e3', '다음')] })
  const asked = []
  const decide = async arg => { asked.push(arg); return arg.elements.find(e => e.ref === 'e2').ref }
  const out = await runProcedure({ procedure: proc([fill('s1', '이름')]), cardId: 'card', tools: w, decide })
  assert.equal(out.status, 'done'); assert.equal(asked.length, 1)
  assert.equal(asked[0].candidates.length, 2); assert.ok(!asked[0].elements.some(e => e.role === 'button'), 'a fill is offered fields only')
  assert.equal(w.acts()[0][1].ref, 'e2')
})

test('not found: no match and no model answer is cannot_proceed target_not_found, and nothing was acted', async () => {
  const w = world({ elements: [field('e1', '수령인')] })
  const a = await runProcedure({ procedure: proc([fill('s1', '받는 분')]), cardId: 'card', tools: w })
  assert.deepEqual([a.status, a.code, a.stepId, a.index], ['cannot_proceed', 'target_not_found', 's1', 0])
  const b = await runProcedure({ procedure: proc([fill('s1', '받는 분')]), cardId: 'card', tools: w, decide: async () => null })
  assert.equal(b.code, 'target_not_found')
  const c = await runProcedure({ procedure: proc([fill('s1', '받는 분')]), cardId: 'card', tools: w, decide: async () => 'not-listed' })
  assert.equal(c.code, 'target_not_found', 'a ref the page does not list is no answer')
  assert.equal(w.acts().length, 0)
})

test('missing value: needs_value before anything is done', async () => {
  const w = world({ elements: [field('e1', '메모')] })
  const p = proc([fill('s1', '메모', '메모')], { params: [{ name: '메모', default: null, sensitive: false }] })
  const out = await runProcedure({ procedure: p, cardId: 'card', tools: w })
  assert.deepEqual([out.status, out.stepId, out.params], ['needs_value', 's1', ['메모']])
  assert.equal(w.calls.length, 0)
  const again = await runProcedure({ procedure: p, cardId: 'card', values: { 메모: '문 앞' }, tools: w })
  assert.equal(again.status, 'done')
})

test('person step: human_step stops there, with the end frame the card lease hands over on', async () => {
  const w = world({ elements: [field('e1', '받는 분'), field('e2', '비밀번호', { role: 'textbox' })] })
  const f = frames()
  const person = { id: 's2', op: 'fill', target: { label: '비밀번호', role: 'textbox' }, value: { param: '비밀번호' }, person: true }
  const out = await runProcedure({ procedure: proc([fill('s1', '받는 분'), person]), cardId: 'card', tools: w, onStep: f.onStep })
  assert.deepEqual([out.status, out.stepId, out.done], ['human_step', 's2', ['s1']])
  assert.equal(w.acts().length, 1)
  const end = f.list.find(e => e.op === 'end'); assert.equal(end.status, 'human_step')
  assert.ok(!JSON.stringify(f.list).includes('비밀번호') || f.list.every(e => e.displayValue === undefined || e.target !== '비밀번호'))
})

test('a sign-in control found by label stays with the person even in a saved press', async () => {
  const w = world({ elements: [button('e1', '로그인')] })
  const out = await runProcedure({ procedure: proc([click('s1', '로그인')]), cardId: 'card', tools: w })
  assert.deepEqual([out.status, out.stepId], ['human_step', 's1']); assert.equal(w.acts().length, 0)
})

test('confirm: stops BEFORE acting, then resumes from that step with confirmed', async () => {
  const w = world({ elements: [field('e1', '받는 분'), button('e2', '제출')] })
  const p = proc([fill('s1', '받는 분'), click('s2', '제출', { confirm: 'submit' })])
  const first = await runProcedure({ procedure: p, cardId: 'card', tools: w })
  assert.deepEqual([first.status, first.stepId, first.confirm, first.done], ['needs_confirm', 's2', 'submit', ['s1']])
  assert.equal(w.acts().length, 1, 'the submit was not pressed')
  const second = await runProcedure({ procedure: p, cardId: 'card', fromStep: 's2', confirmed: ['s2'], tools: w })
  assert.deepEqual([second.status, second.done], ['done', ['s2']])
  assert.equal(w.acts().length, 2); assert.equal(w.acts()[1][1].ref, 'e2')
  const notConfirmed = await runProcedure({ procedure: p, cardId: 'card', fromStep: 's2', confirmed: ['s1'], tools: w })
  assert.equal(notConfirmed.status, 'needs_confirm')
})

test('an unmarked payment or delete press is confirmed anyway', async () => {
  const w = world({ elements: [button('e1', '결제하기')] })
  const out = await runProcedure({ procedure: proc([click('s1', '결제하기')]), cardId: 'card', tools: w })
  assert.deepEqual([out.status, out.confirm], ['needs_confirm', 'payment']); assert.equal(w.acts().length, 0)
})

test('STALE: the refused act looks again (fresh observation) and succeeds; a page that never settles stops after the bound', async () => {
  const w = world({ elements: [field('e1', '받는 분')], stale: 1 })
  const out = await runProcedure({ procedure: proc([fill('s1', '받는 분')]), cardId: 'card', tools: w })
  assert.equal(out.status, 'done')
  assert.equal(w.calls.filter(([name]) => name === 'egdesk_browser_fill').length, 2)
  assert.ok(w.calls.filter(([name]) => name === 'egdesk_browser_observe').length >= 2)
  assert.equal(w.calls.find(([name], i) => name === 'egdesk_browser_fill' && i > 3)[1].expectedRevision, 2, 'the retry carries the new revision')
  const never = world({ elements: [field('e1', '받는 분')], stale: 99 })
  const stuck = await runProcedure({ procedure: proc([fill('s1', '받는 분')]), cardId: 'card', tools: never })
  assert.deepEqual([stuck.status, stuck.code], ['cannot_proceed', 'page_changing'])
  assert.equal(never.calls.filter(([name]) => name === 'egdesk_browser_fill').length, CHANGE_LOOKS + 1)
})

test('user hold: the person took the Card, the run says human_step', async () => {
  const w = world({ elements: [field('e1', '받는 분')] })
  const tools = { callTool: async (name, args) => { if (name === 'egdesk_browser_fill') throw Object.assign(new Error('hold'), { code: 'BROWSER_OBSERVATION_STALE', staleBy: 'user-hold' }); return w.callTool(name, args) } }
  const out = await runProcedure({ procedure: proc([fill('s1', '받는 분')]), cardId: 'card', tools })
  assert.deepEqual([out.status, out.code], ['human_step', 'user_hold'])
})

test('start page: another host navigates to start.url first, the same host does not, a refusal carries the tool code', async () => {
  const away = world({ url: 'https://other.example.test/x', elements: [field('e1', '받는 분')] })
  const out = await runProcedure({ procedure: proc([fill('s1', '받는 분')]), cardId: 'card', tools: away })
  assert.equal(out.status, 'done')
  assert.equal(away.acts()[0][0], 'egdesk_browser_navigate'); assert.deepEqual(away.acts()[0][1].postcondition, { kind: 'url', value: 'https://shop.example.test/form' })
  const here = world({ elements: [field('e1', '받는 분')] })
  await runProcedure({ procedure: proc([fill('s1', '받는 분')]), cardId: 'card', tools: here })
  assert.ok(!here.acts().some(([name]) => name === 'egdesk_browser_navigate'))
  const resumed = world({ url: 'https://other.example.test/x', elements: [field('e1', '받는 분')] })
  await runProcedure({ procedure: proc([fill('s1', '받는 분')]), cardId: 'card', fromStep: 's1', tools: resumed })
  assert.ok(!resumed.acts().some(([name]) => name === 'egdesk_browser_navigate'), 'fromStep never re-navigates')
  const refused = world({ url: 'https://other.example.test/x', elements: [], refuseNavigate: true })
  const no = await runProcedure({ procedure: proc([fill('s1', '받는 분')]), cardId: 'card', tools: refused })
  assert.deepEqual([no.status, no.code], ['cannot_proceed', 'BROWSER_NAVIGATE_OUT_OF_SCOPE'])
})

test('other ops: navigate, select, scroll, history and an Enter press use their guarded tools', async () => {
  const w = world({ elements: [{ ref: 'e1', label: '지역', role: 'combobox', tag: 'select', value: 'a', options: [{ value: 'a', label: '서울' }, { value: 'b', label: '부산' }] }, field('e2', '검색')] })
  const steps = [{ id: 's1', op: 'navigate', url: 'https://shop.example.test/next' }, { id: 's2', op: 'select', target: { label: '지역', role: 'combobox' }, value: { text: '부산' } },
    { id: 's3', op: 'scroll', direction: 'down' }, { id: 's4', op: 'history', action: 'reload' }, { id: 's5', op: 'fill', target: { label: '검색' }, value: { text: '우산' } },
    { id: 's6', op: 'press', target: { label: '검색' }, key: 'Enter', expect: { kind: 'url', value: 'https://shop.example.test/s' } }]
  const out = await runProcedure({ procedure: proc(steps), cardId: 'card', tools: w })
  assert.equal(out.status, 'done', JSON.stringify(out))
  assert.deepEqual(w.acts().map(([name]) => name), ['egdesk_browser_navigate', 'egdesk_browser_fill', 'egdesk_browser_scroll', 'egdesk_browser_history', 'egdesk_browser_fill', 'egdesk_browser_press'])
  assert.equal(w.acts()[1][1].text, 'b'); assert.equal(w.acts()[2][1].amount, 'page')
})

test('activity frames: start first, stop last (also on a stop), step frames between, seq grows', async () => {
  const w = world({ elements: [] })
  const f = frames()
  const out = await runProcedure({ procedure: proc([fill('s1', '받는 분')]), cardId: 'card', tools: w, onStep: f.onStep, run: { runId: 'r' } })
  assert.equal(out.status, 'cannot_proceed')
  assert.deepEqual([f.list[0].op, f.list[0].phase], ['activity', 'start'])
  assert.deepEqual([f.list.at(-1).op, f.list.at(-1).phase], ['activity', 'stop'])
  assert.ok(f.list.some(e => e.op === 'end' && e.status === 'cannot_proceed' && e.code === 'target_not_found'))
  const seqs = f.list.filter(e => e.op !== 'activity').map(e => e.seq); assert.deepEqual(seqs, [...seqs].sort((a, b) => a - b))
})
