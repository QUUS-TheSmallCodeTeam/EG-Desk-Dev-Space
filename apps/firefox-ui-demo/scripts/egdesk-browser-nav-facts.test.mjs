import test from 'node:test'
import assert from 'node:assert/strict'

// L8 c20: the Firefox child reports the facts of a button's read-only proof (no decision there). Fake DOM nodes; no Firefox.
globalThis.JSWindowActorChild ||= class {}
const { EGDeskBrowserAgentRuntimeChild } = await import('../overlay/resources/EGDeskBrowserAgentRuntimeChild.sys.mjs')
const actor = () => { const a = new EGDeskBrowserAgentRuntimeChild(); a.roleFor = node => node.role ?? (node.tagName === 'BUTTON' ? 'button' : 'textbox'); a.isSensitiveControl = node => node.sensitive === true; return a }
const node = (tagName, attrs = {}, extra = {}) => ({ tagName, getAttribute: name => (Object.hasOwn(attrs, name) ? attrs[name] : null), closest: () => null, ...extra })
const doc = { URL: 'https://bank.example.test/card', baseURI: 'https://bank.example.test/card', getElementById: () => null }
function formWith(attrs, fields) { return { getAttribute: name => attrs[name] ?? null, elements: fields } }

test('a GET form submitter: method, field kinds and the exact URL the submission loads (only named, enabled, checked fields; the submitter\'s own name)', () => {
  const fields = [node('SELECT', { name: 'period' }, { value: '2026-11' }), node('INPUT', { type: 'hidden', name: 'kind' }, { value: 'card' }),
    node('INPUT', { type: 'checkbox', name: 'detail' }, { value: 'on', checked: false }), node('INPUT', { type: 'text', name: 'memo' }, { value: 'x', disabled: true })]
  const submit = node('BUTTON', { type: 'submit', name: 'go' }, { value: '1', ownerDocument: doc })
  submit.form = formWith({ method: 'GET', action: '/card/result' }, [...fields, submit])
  const facts = actor().navigationFacts(submit)
  assert.deepEqual(facts, { type: 'submit', sensitiveRegion: false, regionLabel: '', controls: null,
    form: { method: 'get', fields: ['select', 'hidden', 'checkbox', 'text', 'button'], sensitive: false, submitUrl: 'https://bank.example.test/card/result?period=2026-11&kind=card&go=1' } })
})

test('POST reports only a verified native destination; missing ancestry, invalid URLs and private forms retain facts without a URL', () => {
  const post = node('BUTTON', { type: 'submit' }, { ownerDocument: doc }); post.form = formWith({ method: 'post', action: '/card/result' }, [post])
  assert.deepEqual([actor().navigationFacts(post).form.method, actor().navigationFacts(post).form.submitUrl], ['post', null])
  const field = node('INPUT', { type: 'text', name: 'feedback' })
  Object.defineProperty(field, 'value', { get() { throw Error('POST observation must not read this') } })
  post.form.elements.unshift(field)
  post.form.closest = () => null
  assert.deepEqual(actor().navigationFacts(post).form, { method: 'post', fields: ['text', 'button'], sensitive: false, submitUrl: 'https://bank.example.test/card/result' })
  for (const action of ['https://elsewhere.example.test/path', 'https://[']) {
    post.form = { ...formWith({ method: 'post', action }, [field, post]), closest: () => null }
    assert.deepEqual(actor().navigationFacts(post).form, { method: 'post', fields: ['text', 'button'], sensitive: false, submitUrl: null })
  }
  post.form = { ...formWith({ method: 'post', action: '/card/result' }, [post]), closest: () => ({}) }
  assert.equal(actor().navigationFacts(post).form.submitUrl, null)
  post.form = { ...post.form, closest: () => null, elements: [node('INPUT', { type: 'password' }), post] }
  assert.deepEqual(actor().navigationFacts(post).form, { method: 'post', fields: ['password', 'button'], sensitive: true, submitUrl: null })
})

test('a password marks the form sensitive (no URL); outside forms a region and a controlled panel are reported', () => {
  const pw = node('BUTTON', {}, { ownerDocument: doc }); pw.form = formWith({ action: '/login' }, [node('INPUT', { type: 'password', name: 'pw' }, { value: '' }), pw])
  assert.deepEqual([actor().navigationFacts(pw).form.sensitive, actor().navigationFacts(pw).form.submitUrl], [true, null])
  const region = { getAttribute: name => (name === 'aria-label' ? '결제 정보' : null), querySelector: () => null }
  const inPay = node('BUTTON', { type: 'button' }, { ownerDocument: doc, closest: selector => (selector.includes('fieldset') ? region : null) })
  inPay.form = null
  assert.equal(actor().navigationFacts(inPay).regionLabel, '결제 정보')
  const panel = { closest: () => null, querySelector: () => ({ textContent: '마케팅 정보 알림' }), textContent: '마케팅 정보 알림 켜짐' }
  const t = node('DIV', { 'aria-controls': 'alerts' }, { role: 'tab', ownerDocument: { ...doc, getElementById: id => (id === 'alerts' ? panel : null) } })
  assert.deepEqual(actor().navigationFacts(t), { type: null, sensitiveRegion: false, regionLabel: '', form: null, controls: { text: '마케팅 정보 알림' } })
  assert.equal(actor().navigationFacts(node('A', { href: '/x' }, { role: 'link' })), null, 'not a button: no facts')
  const hidden = node('BUTTON', { type: 'submit' }, { ownerDocument: doc, closest: selector => (selector.includes('data-sensitive') ? {} : null) }); hidden.form = null
  assert.equal(actor().navigationFacts(hidden).sensitiveRegion, true)
})
