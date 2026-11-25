// L8 u7 (U19): real-window findings D19 and D20 of the Claude browser conversation.
//  D19: Google's search box (<textarea role="combobox" aria-label="검색">) was the person's field, and the GET search button asked for approval.
//  D20: the grant "Chat 조작 허용" lasted one send for Claude (the input row was cleared), not the conversation.
// REPLAY over the real runtime, Claude adapter, MCP bridge, providers and the bridge's readiness function, on Google's first page as the window showed it; Claude and the page are fake.
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { claudeKeptInputs } from '../overlay/resources/EGDeskClaudeBrowserSend.sys.mjs'
import * as ChatState from '../overlay/resources/EGDeskChatState.sys.mjs'
import { buildReflexCandidates, readOnlyPress } from './egdesk-browser-reflex.mjs'
import { GOOGLE_HOST, GOOGLE_PAGES, callTool, googleSearchFacts, world } from './egdesk-claude-browser-world.fixture.mjs'

const here = path.dirname(new URL(import.meta.url).pathname)
const surface = fs.readFileSync(path.join(here, '..', 'overlay', 'JS', 'eg-desk-surface.uc.js'), 'utf8')
const google = (t, over = {}) => world(t, { host: GOOGLE_HOST, pages: GOOGLE_PAGES, start: '/', hold: true, init: 'real', ...over })
const interact = (id = 'b1') => ({ id, kind: 'browser', selectedByUser: true, browserToolPermission: 'interact' })

test('D19: on Google\'s first page the search box is an ordinary text field (auto) and the GET search button is a read-only submission (auto); sign-in stays the person\'s', async t => {
  const w = google(t)
  const sent = await w.browserSend('검색창에 우산 입력해줘'); assert.equal(sent.accepted, true); await w.drain()
  const read = await callTool(w, 'egdesk_card_read', { mode: 'structure' })
  const act = ref => read.elements.find(e => e.ref === ref)?.act
  assert.deepEqual(['q', 'btnK', 'login', 'sel'].map(act), ['auto', 'auto', 'person', 'approval'])
  const typed = await callTool(w, 'egdesk_card_type', { ref: 'q', text: '우산' })
  assert.deepEqual([typed.status, typed.submitted], ['typed', false], JSON.stringify(typed))
  assert.equal(w.pw.state.pages['/'].elements.find(e => e.ref === 'q').value, '우산')
  assert.equal(w.pw.state.cur.path, '/', 'typing submits nothing')
  const pressed = await callTool(w, 'egdesk_card_press', { ref: 'btnK' })
  assert.deepEqual([pressed.status, pressed.via], ['pressed', 'auto'], JSON.stringify(pressed))
  assert.equal(w.pw.state.cur.path, '/search', 'the read-only GET search ran, without asking')
  w.transports.at(-1).finish?.(); await w.settled(sent)
})

test('D19, what stays the person\'s: sign-in, a password or card field, a POST form, and a combobox that is a <select>', async t => {
  const w = google(t)
  await w.browserSend('로그인해줘'); await w.drain()
  assert.equal((await callTool(w, 'egdesk_card_press', { ref: 'login' })).status, 'person_step')
  assert.equal((await callTool(w, 'egdesk_card_type', { ref: 'sel', text: '영어' })).status, 'person_step', 'a <select> is not a text field')
  w.pw.state.pages['/'].elements.push({ ref: 'pw', role: 'combobox', tag: 'textarea', label: '비밀번호', href: '', value: '' })
  await callTool(w, 'egdesk_card_read', { mode: 'structure' }) // a fresh observation lists the field
  assert.equal((await callTool(w, 'egdesk_card_type', { ref: 'pw', text: 'x' })).status, 'person_step', 'a credential field is the person\'s even when it calls itself a combobox')
  // a textarea combobox labelled as a credential is still the person's; a POST form is no read-only submission
  const pass = { ref: 'pw', role: 'combobox', tag: 'textarea', label: '비밀번호', href: '', value: '' }
  const snapshot = { url: `https://${GOOGLE_HOST}/`, interactiveElements: [pass], text: [] }
  assert.equal(buildReflexCandidates(snapshot, { textComboboxes: true }).options.length, 0, 'a credential label is excluded as a field')
  assert.equal(buildReflexCandidates({ ...snapshot, interactiveElements: [{ ...pass, label: '카드 번호' }] }, { textComboboxes: true }).options.length, 0, 'a sensitive label is excluded')
  const post = { ref: 'go', role: 'button', tag: 'input', label: 'Google 검색', nav: { type: 'submit', sensitiveRegion: false, regionLabel: '', form: { method: 'post', sensitive: false, fields: ['textarea', 'submit'], submitUrl: `https://${GOOGLE_HOST}/search` } } }
  assert.equal(readOnlyPress(post, { url: `https://${GOOGLE_HOST}/` }), null)
  const get = { ...post, nav: { ...post.nav, form: { ...post.nav.form, method: 'get' } } }
  assert.equal(readOnlyPress(get, { url: `https://${GOOGLE_HOST}/` })?.kind, 'get_form')
  const sensitive = { ...post, nav: { ...post.nav, form: { ...post.nav.form, method: 'get', sensitive: true } } }
  assert.equal(readOnlyPress(sensitive, { url: `https://${GOOGLE_HOST}/` }), null)
})

test('D19, the objective loop is unchanged: without the page tools\' option a combobox textarea is still not a fill candidate', () => {
  const snapshot = { url: `https://${GOOGLE_HOST}/`, interactiveElements: [{ ref: 'q', role: 'combobox', tag: 'textarea', label: '검색', href: '', value: '' }], text: [] }
  const loop = buildReflexCandidates(snapshot)
  assert.deepEqual([loop.options.length, loop.excluded.unsupported], [0, 1])
  assert.equal(buildReflexCandidates(snapshot, { textComboboxes: true }).options.length, 1)
})

test('D20: the pure rule: only Browser Cards granted to operate stay in a Claude conversation\'s input row after a LIVE send; not live keeps nothing, and everything else is spent', () => {
  const file = { id: 'f', kind: 'file', selectedByUser: true }, observe = { ...interact('o'), browserToolPermission: 'observe' }
  assert.deepEqual(claudeKeptInputs(true, [file, observe, interact()]), [interact()])
  assert.deepEqual(claudeKeptInputs(false, [interact()]), [])
  assert.deepEqual(claudeKeptInputs(undefined, [interact()]), [])
  assert.deepEqual(claudeKeptInputs(true, undefined), [])
  assert.equal(ChatState.claudeKeptInputs, claudeKeptInputs)
  assert.ok(surface.includes('inputSources: ChatState.claudeKeptInputs(claudeBrowserPlan.live, thread.inputSources), briefingInputs: []'))
  assert.ok(surface.includes("ChatState.chatThreadEngineId(thread, state.codex) === 'claude'"), 'ending the grant takes the chip away for a Claude conversation only')
})

test('D20: the same Card carries the next turns of the conversation (a fresh token from the standing grant), the run binding continues, and the Card tools work on every turn; with the grant ended there are none', async t => {
  const w = google(t)
  const first = await w.browserSend('이 페이지 제목 알려줘'); await w.drain()
  assert.equal((await callTool(w, 'egdesk_card_read', {})).title, 'Google')
  w.transports.at(-1).finish(); await w.settled(first)
  for (const message of ['검색창에 우산 입력해줘', '검색해줘']) {
    const next = await w.browserSend(message, { conversationId: first.conversationId }); assert.equal(next.accepted, true); await w.drain()
    assert.equal(next.conversationId, first.conversationId)
    const read = await callTool(w, 'egdesk_card_read', { mode: 'structure' })
    assert.equal(read.status, 'read', `${message}: ${JSON.stringify(read)}`)
    if (message.includes('입력')) assert.equal((await callTool(w, 'egdesk_card_type', { ref: 'q', text: '우산' })).status, 'typed')
    else assert.equal((await callTool(w, 'egdesk_card_press', { ref: 'btnK' })).via, 'auto')
    w.transports.at(-1).finish(); await w.settled(next)
  }
  assert.equal(w.pw.state.cur.path, '/search')
  // grant ended (the chip is gone, nothing selected): the send is accepted and Claude is given no Card tool
  const ended = await w.send('다시 읽어줘', { conversationId: first.conversationId, executionPolicy: { mode: 'browserBounded' } })
  assert.equal(ended.accepted, true); await w.drain()
  const gone = await callTool(w, 'egdesk_card_read', {}); assert.notEqual(gone.status, 'read', JSON.stringify(gone)); w.transports.at(-1).finish()
})

test('D20, no leak: a Card granted in one conversation is not carried by another, and a login-domain Card stays opaque on later turns', async t => {
  const w = google(t, { host: 'claude.ai' })
  const prev = process.env.EGDESK_TERMINAL_OPEN_URL; process.env.EGDESK_TERMINAL_OPEN_URL = 'on'
  try {
    const sent = await w.browserSend('읽어줘'); await w.drain()
    const read = await callTool(w, 'egdesk_card_read', {})
    assert.notEqual(read.status, 'read'); assert.equal(read.lines, undefined)
    w.transports.at(-1).finish?.(); await w.settled(sent)
  } finally { if (prev === undefined) delete process.env.EGDESK_TERMINAL_OPEN_URL; else process.env.EGDESK_TERMINAL_OPEN_URL = prev }
  const other = google(t)
  const stranger = await other.send('읽어줘', { clientThreadId: 'ui-other', executionPolicy: { mode: 'browserBounded' }, selectedSources: [] })
  assert.equal(stranger.accepted, true); await other.drain()
  assert.notEqual((await callTool(other, 'egdesk_card_read', {})).status, 'read'); other.transports.at(-1).finish()
})

test('D19 (u8), the facts of Google\'s real search form: the unnamed hidden file input and the six hidden inputs no longer make the GET form "sensitive", so the button is provably a read-only search', () => {
  const { btnK, btnI } = googleSearchFacts()
  for (const nav of [btnK, btnI]) {
    assert.deepEqual([nav.form.method, nav.form.sensitive, nav.sensitiveRegion], ['get', false, false])
    assert.ok(!nav.form.fields.includes('file'), 'an unnamed file input is not part of a submission')
    assert.equal(nav.form.fields.filter(kind => kind === 'hidden').length, 6)
    assert.match(nav.form.submitUrl, /^https:\/\/www\.google\.com\/search\?.*q=%EC%9A%B0%EC%82%B0/)
  }
  assert.equal(readOnlyPress({ ref: 'b', role: 'button', tag: 'input', label: 'Google 검색', nav: btnK }, { url: `https://${GOOGLE_HOST}/` })?.kind, 'get_form')
  // no method attribute = GET (as on the real page); an explicit POST has no URL and no proof
  assert.equal(googleSearchFacts({ method: null }).btnK.form.method, 'get')
  const post = googleSearchFacts({ method: 'POST' }).btnK
  assert.deepEqual([post.form.method, post.form.submitUrl], ['post', null])
})

test('D19 (u8), what still makes a GET form sensitive, with the same real-shaped form: a password field, a NAMED file input, a hidden field named like a secret, a data-sensitive mark, and an AI-service-style sign-in field', () => {
  const sensitive = extra => googleSearchFacts({ extraFields: [extra] }).btnK.form
  const make = googleSearchFacts().node
  assert.equal(sensitive(make('INPUT', { type: 'password', name: 'pw' })).sensitive, true)
  const named = sensitive(make('INPUT', { type: 'file', name: 'upload' })); assert.deepEqual([named.sensitive, named.submitUrl], [true, null]); assert.ok(named.fields.length)
  assert.equal(sensitive(make('INPUT', { type: 'hidden', name: 'csrf_token' }, { value: 'x' })).sensitive, true)
  assert.equal(sensitive(make('INPUT', { type: 'hidden', name: 'note', 'data-private': 'true' }, { value: 'x' })).sensitive, true)
  assert.equal(sensitive(make('INPUT', { type: 'text', name: 'otp_code' })).sensitive, true)
  // an unnamed or a disabled file input stays out; a disabled NAMED one too
  assert.equal(sensitive(make('INPUT', { type: 'file' })).sensitive, false)
  assert.equal(sensitive(make('INPUT', { type: 'file', name: 'x' }, { disabled: true })).sensitive, false)
  // the default of the field-sensitivity check (masking what is read) still treats every hidden field as sensitive
  const { actor } = googleSearchFacts()
  assert.equal(actor.isSensitiveControl(make('INPUT', { type: 'hidden', name: 'ei' })), true)
  assert.equal(actor.isSensitiveControl(make('INPUT', { type: 'hidden', name: 'ei' }), { allowHidden: true }), false)
})
