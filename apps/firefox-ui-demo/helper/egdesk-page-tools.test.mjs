// L8 u1: the page tools ('위': the browser as EG-Desk tools for the conversation). Replay over the REAL Browser tool provider and its service with a fixture page world (no Firefox, no network).
import test from 'node:test'
import assert from 'node:assert/strict'
import { createCodexBrowserToolProvider } from './codex-browser-tool-provider.mjs'
import { OWNER, pageWorld } from './egdesk-browser-live-runner.mjs'
import { PAGE_TOOL_NAMES, PAGE_TOOL_SPECS, createPageToolsProvider, pageToolGate, pageToolBrowserEquivalent } from './egdesk-page-tools.mjs'

const H = 'shop.example.test', O = `https://${H}`
const el = (ref, role, label, extra = {}) => ({ ref, role, label, tag: role === 'link' ? 'a' : role === 'button' ? 'button' : 'input', href: '', value: '', ...extra })
const PAGES = () => ({
  '/home': { text: ['쇼핑몰', '찾는 상품을 검색하세요.'], elements: [
    el('q', 'textbox', '상품 검색'), el('go', 'button', '검색', { nav: { type: 'submit', form: { method: 'get', fields: ['search'], sensitive: false, submitUrl: `${O}/search?q=` } } }),
    el('list', 'link', '상품 목록', { href: `${O}/list` }), el('pay', 'button', '결제하기'), el('del', 'button', '계정 삭제'), el('fav', 'button', '관심 상품에 담기'),
    el('pw', 'textbox', '비밀번호', { type: 'password' }), el('login', 'link', '로그인', { href: `${O}/login` }), el('ext', 'link', '다른 사이트', { href: 'https://other.example.net/' }), el('ai', 'link', 'Claude 로그인', { href: 'https://claude.ai/login' })] },
  '/list': { text: ['상품 목록', '상품 3개'], elements: [el('back', 'link', '홈', { href: `${O}/home` })] },
  '/login': { text: ['로그인'], elements: [] }, '/search': { text: ['검색 결과', '우산 12개'], elements: [] },
})
const GOOD = { cardEpoch: 'epoch', userContextId: 0, engineAccountKey: OWNER, authorityEpoch: 1 }

async function rig({ host = H, permission = 'interact', mode = 'on', ledger = null, env = {}, pages = PAGES, start = '/home' } = {}) {
  const world = pageWorld('x', host, 'card', { pages: pages() }); world.go(start)
  // the fixture world fills a field when asked (the service reads the value back)
  const send = world.transport.sendToUi.bind(world.transport)
  world.transport.sendToUi = async request => {
    if (request.kind === 'act' && request.action.type === 'fill') { const page = world.state.pages[world.state.cur.path]; const target = page.elements.find(e => e.ref === request.action.ref); if (target) { target.value = request.action.text; world.state.cur = { ...world.state.cur, revision: world.state.cur.revision + 1 } } }
    return send(request)
  }
  const browser = createCodexBrowserToolProvider({ transport: world.transport, getOwnerKey: () => OWNER })
  const events = []
  browser.runtime = { emit: (run, type, payload) => events.push([type, payload]) }
  const run = { answerId: 'p1', runId: 'p1', conversationId: 'c1', clientThreadId: 't1', status: 'inProgress', executionPolicy: { mode: 'browserBounded' } }
  const prepared = browser.prepare({ clientThreadId: 't1', effectiveExecutionPolicy: 'browserBounded', browserTransportId: 'ui', selectedSources: [{ id: 'source', kind: 'browser', selectedByUser: true, browserToolPermission: permission,
    browserToolSelection: { token: 'tok', threadId: 't1' }, browserToolIdentity: GOOD, sourceRef: { viewId: 'card', profileId: 'synthetic', accountId: '', uri: `https://${host}${start}` } }] })
  await browser.bindRun(run, prepared)
  const dispatched = []
  const spy = { dispatch: (r, e) => { dispatched.push(e.tool); return browser.dispatch(r, e) } }
  const page = createPageToolsProvider({ mode: () => mode, browser: spy, ledger, env })
  let n = 0
  const call = async (tool, args = {}) => { const out = await page.dispatch(run, { tool, callId: `call-${++n}`, arguments: args }); return { success: out.success, ...JSON.parse(out.contentItems[0].text) } }
  return { world, browser, page, run, call, events, dispatched }
}
const T = PAGE_TOOL_NAMES

test('the catalog: four tools with object schemas, provisional names that collide with no browser, file or command tool; empty when the flag is off', async () => {
  const on = createPageToolsProvider({ mode: () => 'on' }), off = createPageToolsProvider({ mode: () => 'off' })
  assert.deepEqual(on.specs().map(s => s.name), [T.read, T.press, T.type, T.open]); assert.deepEqual(off.specs(), [])
  assert.ok(PAGE_TOOL_SPECS.every(s => s.type === 'function' && s.inputSchema.type === 'object' && s.inputSchema.additionalProperties === false))
  assert.ok(PAGE_TOOL_SPECS.every(s => !/^egdesk_(browser|read_file|search_files|edit_file|undo_edit|run_command)/.test(s.name)))
  const { BROWSER_TOOL_SPECS } = await import('./egdesk-browser-tool-runtime.mjs'); const { FILE_TOOL_NAMES } = await import('./egdesk-file-tools.mjs')
  const taken = new Set([...BROWSER_TOOL_SPECS.map(s => s.name), ...Object.values(FILE_TOOL_NAMES), 'egdesk_run_command', 'egdesk_list_context', 'egdesk_read_source'])
  assert.ok(PAGE_TOOL_SPECS.every(s => !taken.has(s.name)))
  const rejected = await createPageToolsProvider({ mode: () => 'off' }).dispatch({ runId: 'r' }, { tool: T.read, callId: 'x', arguments: {} })
  assert.equal(JSON.parse(rejected.contentItems[0].text).error.code, 'PAGE_TOOLS_OFF')
})

test('read: title, address and visible lines of the granted Card; with structure every control is marked auto, approval or person by code', async () => {
  const h = await rig()
  const summary = await h.call(T.read, {})
  assert.deepEqual([summary.status, summary.cardId, summary.host, summary.path, summary.title, summary.lines, summary.elements], ['read', 'card', H, '/home', '쇼핑몰', ['쇼핑몰', '찾는 상품을 검색하세요.'], undefined])
  const structure = await h.call(T.read, { mode: 'structure' })
  assert.match(structure.forYouOnly, /^Not for the person: act, why, status, via and codes/, 'u8: the markings carry a note that they are not for the person')
  assert.equal((await h.call(T.read, {})).forYouOnly, undefined, 'a plain read has no markings and no note')
  const act = Object.fromEntries(structure.elements.map(e => [e.ref, e.act]))
  assert.deepEqual(act, { q: 'auto', go: 'auto', list: 'auto', pay: 'person', del: 'approval', fav: 'approval', pw: 'person', login: 'person', ext: 'approval', ai: 'approval' })
  assert.ok(h.events.some(([type]) => type === 'browser.tool.completed'), 'the Browser provider recorded the observation in the activity')
})

test('press: a same-site link and a read-only GET search run at once through the Browser provider; payment, sign-in and credentials are the person\'s and nothing is sent', async () => {
  const h = await rig()
  await h.call(T.read, { mode: 'structure' })
  const link = await h.call(T.press, { ref: 'list' })
  assert.deepEqual([link.status, link.via], ['pressed', 'auto']); assert.equal(h.world.state.cur.path, '/list'); assert.ok(h.dispatched.includes('egdesk_browser_navigate'))
  h.world.go('/home'); await h.call(T.read, { mode: 'structure' })
  const before = h.world.state.acts.length
  for (const ref of ['pay', 'login', 'pw']) { const out = await h.call(T.press, { ref }); assert.deepEqual([out.status, out.written], ['person_step', false], ref) }
  assert.equal(h.world.state.acts.length, before, 'no action reached the page')
  const search = await h.call(T.press, { ref: 'go' })
  assert.deepEqual([search.status, search.via], ['pressed', 'auto'])
})

test('type: an ordinary text field is typed into (never Enter, never a submit) and read back; a credential field is the person\'s; a non-field is refused', async () => {
  const h = await rig()
  await h.call(T.read, { mode: 'structure' })
  const typed = await h.call(T.type, { ref: 'q', text: '우산' })
  assert.deepEqual([typed.status, typed.submitted], ['typed', false]); assert.equal(h.world.state.pages['/home'].elements.find(e => e.ref === 'q').value, '우산')
  assert.ok(h.dispatched.includes('egdesk_browser_fill') && !h.dispatched.includes('egdesk_browser_type'), 'the DOM fill route, not a key press')
  await h.call(T.read, { mode: 'structure' })
  assert.deepEqual([(await h.call(T.type, { ref: 'pw', text: 'x' })).status, h.world.state.pages['/home'].elements.find(e => e.ref === 'pw').value], ['person_step', ''])
  assert.equal((await h.call(T.type, { ref: 'list', text: 'x' })).code, 'PAGE_NOT_A_FIELD')
  assert.equal((await h.call(T.type, { ref: 'q', text: '' })).code, 'PAGE_TEXT_INVALID')
})

test('approval: a control that may change something is not pressed until the person agrees (the same ledger as the command and file tools); the press needs the text it will produce; payment is never approved', async () => {
  const asks = []
  const ledger = { check: async arg => { asks.push(arg); return asks.length === 1 ? { decision: 'deny', note: JSON.stringify({ egdesk_command_gate: { status: 'needs_person', reasons: arg.floor, next: 'ask_user_in_chat' } }) } : { decision: 'allow' } } }
  const h = await rig({ ledger })
  await h.call(T.read, { mode: 'structure' })
  assert.equal((await h.call(T.press, { ref: 'fav' })).status, 'needs_expect_text', 'a press without a provable effect names the text it will show; nothing was asked yet'); assert.equal(asks.length, 0)
  const first = await h.call(T.press, { ref: 'fav', expectText: '담았습니다' })
  assert.deepEqual([first.status, first.written, first.reasons], ['needs_person', false, ['page_press_unproven']]); assert.equal(h.world.state.acts.length, 0)
  assert.deepEqual([asks[0].sessionId, asks[0].cwd, asks[0].command], ['c1', '/', `press "관심 상품에 담기" on ${H}`]); assert.match(asks[0].identity, /^page:press:shop\.example\.test:[0-9a-f]{16}$/)
  world: { /* the person said yes in chat: the same call goes through once */ }
  h.world.state.pages['/home'].elements.find(e => e.ref === 'fav').nav = undefined
  const second = await h.call(T.press, { ref: 'fav', expectText: '쇼핑몰' })
  assert.equal(second.via, 'approved'); assert.equal(asks.length, 2); assert.equal(asks[1].identity, asks[0].identity.replace(/[0-9a-f]{16}$/, asks[1].identity.slice(-16)))
  const deletion = await h.call(T.press, { ref: 'del', expectText: '삭제됨' })
  assert.deepEqual([asks.at(-1).floor], [['page_delete']]); assert.ok(['pressed', 'needs_person', 'not_done'].includes(deletion.status))
  assert.equal((await h.call(T.press, { ref: 'pay' })).status, 'person_step', 'payment never reaches the ledger'); assert.ok(!asks.some(a => /결제/.test(a.command)))
  // without the ledger nothing that needs approval is done
  const none = await rig({ ledger: null }); await none.call(T.read, { mode: 'structure' })
  assert.equal((await none.call(T.press, { ref: 'fav', expectText: 'x' })).error.code, 'PAGE_APPROVAL_UNAVAILABLE'); assert.equal(none.world.state.acts.length, 0)
})

test('AI-service sign-in pages stay opaque (flag EGDESK_TERMINAL_OPEN_URL): read, press, type and open all refuse, before and through the Browser service', async () => {
  const prev = process.env.EGDESK_TERMINAL_OPEN_URL
  process.env.EGDESK_TERMINAL_OPEN_URL = 'on'
  try {
    const env = { EGDESK_TERMINAL_OPEN_URL: 'on' }
    const h = await rig({ env }); await h.call(T.read, { mode: 'structure' })
    assert.equal((await h.call(T.press, { ref: 'ai' })).code, 'BROWSER_CARD_OPAQUE', 'a link to an AI service sign-in page')
    assert.equal((await h.call(T.open, { url: 'https://claude.ai/login' })).code, 'BROWSER_CARD_OPAQUE'); assert.equal((await h.call(T.open, { url: 'https://auth.openai.com/x' })).code, 'BROWSER_CARD_OPAQUE')
    assert.equal(h.world.state.acts.length, 0)
    // the Card itself shows such a page: no content is given to the engine
    const on = await rig({ host: 'claude.ai', env, start: '/home' })
    const read = await on.call(T.read, { mode: 'structure' })
    // the Browser service refuses the observation itself (its public classification is the reviewed BROWSER_TOOL_FAILED; the opacity code is internal): nothing of the page reaches the engine
    assert.deepEqual([read.status, ['BROWSER_CARD_OPAQUE', 'BROWSER_TOOL_FAILED'].includes(read.code), read.lines, read.elements, read.title], ['refused', true, undefined, undefined, undefined])
    for (const out of [await on.call(T.press, { ref: 'list' }), await on.call(T.type, { ref: 'q', text: 'x' })]) assert.deepEqual([out.status, ['BROWSER_CARD_OPAQUE', 'BROWSER_TOOL_FAILED'].includes(out.code)], ['refused', true])
    assert.equal(on.world.state.acts.length, 0)
  } finally { if (prev === undefined) delete process.env.EGDESK_TERMINAL_OPEN_URL; else process.env.EGDESK_TERMINAL_OPEN_URL = prev }
})

test('open: an http(s) page opens in a new Card from a granted one; another scheme, credentials in the address, no Card or a Card granted only to observe are refused with closed codes', async () => {
  const h = await rig()
  for (const url of ['javascript:alert(1)', 'file:///etc/passwd', `https://user:pw@${H}/x`, 'not a url', '']) assert.equal((await h.call(T.open, { url })).code, 'PAGE_URL_INVALID', url)
  const observeOnly = await rig({ permission: 'observe' })
  assert.equal((await observeOnly.call(T.open, { url: `${O}/list` })).code, 'PAGE_NO_INTERACT_GRANT'); assert.equal((await observeOnly.call(T.press, { ref: 'list' })).code, 'PAGE_NO_INTERACT_GRANT')
  assert.equal((await observeOnly.call(T.read, {})).status, 'read', 'reading needs only the observe grant')
  const noCard = await rig(); noCard.run.browserBinding = { cards: [] }
  assert.equal((await noCard.call(T.read, {})).code, 'PAGE_NO_CARD')
  assert.equal((await h.call(T.read, { cardId: 'other' })).code, 'PAGE_CARD_NOT_GRANTED')
  const opened = await h.call(T.open, { url: `${O}/list` })
  assert.ok(['opened', 'not_done'].includes(opened.status), `open_card went through the Browser provider: ${JSON.stringify(opened)}`); assert.ok(h.dispatched.includes('egdesk_browser_open_card'))
})

test('stale or unknown refs, a disabled control and an unobserved press are handled without acting; calls with the same id are answered once', async () => {
  const h = await rig()
  assert.equal((await h.call(T.press, { ref: 'zzz' })).code, 'PAGE_REF_UNKNOWN')
  h.world.state.pages['/home'].elements.find(e => e.ref === 'list').disabled = true
  await h.call(T.read, { mode: 'structure' })
  assert.equal((await h.call(T.press, { ref: 'list' })).code, 'PAGE_CONTROL_DISABLED')
  const once = []
  const spy = createPageToolsProvider({ mode: () => 'on', browser: { dispatch: async () => { once.push(1); return { success: true, contentItems: [{ type: 'inputText', text: JSON.stringify({ snapshot: { url: `${O}/x`, text: ['a'], interactiveElements: [], revision: 1 }, observationId: 'o' }) }] } } } })
  const run = { runId: 'r', answerId: 'r', browserBinding: { cards: [{ cardId: 'card', permission: 'interact' }] } }
  const a = await spy.dispatch(run, { tool: T.read, callId: 'same', arguments: {} }), b = await spy.dispatch(run, { tool: T.read, callId: 'same', arguments: {} })
  assert.equal(a, b); assert.equal(once.length, 1)
})

test('the runtime gate treats a page tool as the Browser tool it needs: its Card is the one it names, else the first interact Card', () => {
  const run = { browserBinding: { cards: [{ cardId: 'a', permission: 'observe' }, { cardId: 'b', permission: 'interact' }] } }
  assert.deepEqual(pageToolGate(run, { tool: T.read, arguments: {} }), { tool: 'egdesk_browser_observe', cardId: 'b' })
  assert.deepEqual(pageToolGate(run, { tool: T.press, arguments: { cardId: 'a' } }), { tool: 'egdesk_browser_click', cardId: 'a' })
  assert.deepEqual([pageToolGate(run, { tool: T.type, arguments: {} }).tool, pageToolGate(run, { tool: T.open, arguments: {} }).tool], ['egdesk_browser_fill', 'egdesk_browser_open_card'])
  assert.equal(pageToolGate(run, { tool: 'egdesk_browser_click', arguments: {} }), null); assert.equal(pageToolGate(run, { namespace: 'x', tool: T.read }), null); assert.equal(pageToolBrowserEquivalent('nope'), null)
})
