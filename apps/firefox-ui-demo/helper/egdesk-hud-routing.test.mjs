// L1 c20: Desk HUD routing (Jev Pillar 4 as reviewed). Code first; one yes/no question per row the list already has; code ranks; nothing runs
// and focus never moves because an answer arrived. Mocks only: the Decision client is a mock that reads the CONTENT it is sent.
import assert from 'node:assert/strict'
import test from 'node:test'
import { EventEmitter } from 'node:events'
import { Readable } from 'node:stream'
import { readFileSync } from 'node:fs'
import * as HR from '../overlay/resources/EGDeskHudRouting.sys.mjs'
import { HUD_ROUTING_PATH, createHudRouting, createHudRoutingHttpHandler, hudRoutingQuestions, normalizeHudRouting } from './egdesk-hud-routing.mjs'
import { createEgressGate, modelDataPermissions } from './egdesk-decision-egress.mjs'
import { lintGroupedRequest } from './egdesk-decision-grouping.mjs'

const surface = readFileSync(new URL('../overlay/JS/eg-desk-surface.uc.js', import.meta.url), 'utf8')
const decl = name => { const at = surface.indexOf(`  function ${name}(`), s = at >= 0 ? at : surface.indexOf(`  async function ${name}(`); assert.ok(s >= 0, name); return surface.slice(s, surface.indexOf('\n  }\n', s) + 4) }
const nav = q => /^[a-z][a-z0-9+.-]*:/i.test(q) || /^[\w-]+(\.[\w-]+)+([/:?#].*)?$/i.test(q) // the field's own test (railSearchLooksLikeNavigation)

// The field's rows as buildRailSearchResults makes them (keys and types); execute is a spy: nothing may call it here
function rows(query, { cards = [{ id: 'res-v1', title: 'A사 견적서 v1 단가표' }, { id: 'res-lunch', title: '점심 메뉴 투표 결과' }], navigation = nav(query) } = {}) {
  const ran = []
  const local = cards.map(c => ({ key: `card:${c.id}`, type: 'card', title: c.title, subtitle: '결과', execute: () => ran.push(c.id) }))
  const web = { key: `web:${query}`, type: 'web', title: navigation ? query : `웹에서 "${query}" 검색`, execute: () => ran.push('web') }
  const ask = { key: 'ask:dm', type: 'ask', title: `Agent에게 요청: ${query}`, execute: () => ran.push('ask') }
  return { list: navigation ? [web, ...local, ask] : [...local, web, ask], ran }
}
const quoteOf = row => (row.type === 'card' ? { label: row.title, excerpt: '' } : null)

// a Decisions client that answers from the content it was sent (each item question carries its own item; the typed text is quoted once)
function contentClient({ fail = null, delayMs = 0 } = {}) {
  const calls = []
  return { calls, model: 'mock', async decide(request) {
    calls.push(request)
    if (delayMs) await new Promise(r => setTimeout(r, delayMs))
    if (fail) throw Object.assign(new Error(fail), { code: fail })
    const typed = /«([^»]*)»/.exec(request.input[1].content)[1]
    const answers = {}
    for (const q of request.questions) {
      let yes
      if (q.name.startsWith('goes_to_')) { const item = /“([^”]*)”/.exec(q.instructions)[1]; yes = /열어|보여|가자|찾아/.test(typed) && item.split(' ').slice(0, 2).every(w => typed.includes(w)) }
      else if (q.name === 'web_search') yes = /검색|문법|방법|뜻/.test(typed) && !/열어/.test(typed)
      else yes = /\?|알려|얼마|해 ?줘|정리/.test(typed) && !/열어/.test(typed)
      answers[q.name] = { type: 'predicate', probability: yes ? 0.96 : 0.03 }
    }
    return { answers, usage: { inputTokens: 9 } }
  } }
}
// FUTURE_PERMISSION: a gate as if the owner had decided a permission covering typed search text for all models (does not exist today)
const FUTURE_PERMISSION = () => ({ allows: kind => kind === 'hud_text' || kind === 'canvas_text', guardClient: client => client })
function route(client, { enabled = true, egressFor = FUTURE_PERMISSION } = {}) {
  const routing = createHudRouting({ client, mode: () => 'on', enabled: () => enabled, egressFor })
  const handler = createHudRoutingHttpHandler({ routing, enabled: () => enabled })
  const call = async (body, { method = 'POST', origin = 'chrome://browser' } = {}) => {
    const req = Object.assign(Readable.from([Buffer.from(JSON.stringify(body))]), { url: HUD_ROUTING_PATH, method, headers: { host: '127.0.0.1:39218', origin, 'content-type': 'application/json' } })
    const res = Object.assign(new EventEmitter(), { setHeader() {}, writeHead(c) { this.status = c }, end(j) { this.body = JSON.parse(j); this.writableEnded = true } })
    await handler(req, res, new URL(HUD_ROUTING_PATH, 'http://127.0.0.1:39218')); return { status: res.status, body: res.body }
  }
  return { routing, call }
}

// ---------------- 1. code first ----------------
test('code first: an address, the exact name of one open card, a slash word and a command line are decided by rule, with no model call', () => {
  const url = rows('github.com/egdesk/desk')
  assert.deepEqual(HR.explicitRoute('github.com/egdesk/desk', url.list, { looksLikeNavigation: nav }), { rule: 'address', key: 'web:github.com/egdesk/desk' })
  const named = rows('A사 견적서 v1 단가표')
  assert.deepEqual(HR.explicitRoute('  a사 견적서 V1   단가표 ', named.list, { looksLikeNavigation: nav }), { rule: 'name', key: 'card:res-v1' })
  const twin = rows('결과', { cards: [{ id: 'a', title: '결과' }, { id: 'b', title: '결과' }] })
  assert.equal(HR.explicitRoute('결과', twin.list, { looksLikeNavigation: nav }), null, 'two cards of that name: not one target')
  assert.deepEqual(HR.explicitRoute('/open 견적', rows('/open 견적').list, { looksLikeNavigation: nav }), { rule: 'slash', key: null })
  for (const command of ['git status --short', 'npm test', './run.sh', '$ ls -la', 'cat a.txt | grep 단가', 'make && make install'])
    assert.deepEqual(HR.explicitRoute(command, rows(command).list, { looksLikeNavigation: nav }), { rule: 'command', key: null }, command)
  for (const words of ['v1이랑 v2 견적 차이 알려줘', '견적', 'A사 견적서 v1 열어줘']) assert.equal(HR.explicitRoute(words, rows(words).list, { looksLikeNavigation: nav }), null, words)
})

// ---------------- 2. candidates from what exists now; one question each ----------------
test('candidates (U2): only rows the list has now; a card is asked about only when its words may leave; each question carries its own item', () => {
  const r = rows('A사 견적서 v1 열어줘')
  const c = HR.routingCandidates(r.list, { quoteOf: row => (row.key === 'card:res-v1' ? { label: row.title } : null) })
  assert.deepEqual(c.wire, [{ kind: 'item', alias: 'I1', label: 'A사 견적서 v1 단가표' }, { kind: 'web' }, { kind: 'ask' }], 'the lunch card (no maySend) is not asked about')
  assert.equal(c.keyOf.get('I1'), 'card:res-v1')
  assert.ok(!JSON.stringify(c.wire).includes('res-v1'), 'no card id or row key leaves')
  const body = normalizeHudRouting({ query: 'A사 견적서 v1 열어줘', candidates: HR.routingCandidates(r.list, { quoteOf }).wire })
  const q = hudRoutingQuestions(body)
  assert.deepEqual(q.questions.map(x => x.name), ['goes_to_I1', 'goes_to_I2', 'web_search', 'assistant_request'])
  assert.ok(q.questions[0].instructions.includes('A사 견적서 v1 단가표') && !q.questions[0].instructions.includes('점심'))
  assert.ok(q.questions[1].instructions.includes('점심 메뉴 투표 결과') && !q.questions[1].instructions.includes('견적서'))
  assert.equal(lintGroupedRequest({ model: 'm', input: q.input, questions: q.questions }).ok, true, 'grouping lint: each item question carries its item')
  assert.deepEqual(q.kinds, ['hud_text', 'canvas_text'])
  for (const bad of [{}, { query: '', candidates: [{ kind: 'ask' }] }, { query: 'x', candidates: [] }, { query: 'x', candidates: [{ kind: 'item', alias: 'I9', label: 'a' }] },
    { query: 'x', candidates: [{ kind: 'ask' }, { kind: 'ask' }] }, { query: 'x', candidates: [{ kind: 'run' }] }]) assert.equal(normalizeHudRouting(bad), null, JSON.stringify(bad))
})

// ---------------- 3. code ranks ----------------
test('code ranks (R2): exactly one desk item yes and the others no; else the request or web row when exactly one is yes and the other no; else nothing', () => {
  const c = HR.routingCandidates(rows('x').list, { quoteOf })
  const rank = answers => HR.rankRoute(c, answers)?.key ?? null
  assert.equal(rank({ goes_to_I1: 0.96, goes_to_I2: 0.03, web_search: 0.03, assistant_request: 0.9 }), 'card:res-v1', 'a named desk item wins over the request row')
  assert.equal(rank({ goes_to_I1: 0.96, goes_to_I2: 0.9, web_search: 0.03, assistant_request: 0.03 }), null, 'two items: not ours to pick')
  assert.equal(rank({ goes_to_I1: 0.96, goes_to_I2: 0.5, web_search: 0.03, assistant_request: 0.03 }), null, 'an undecided item blocks')
  assert.equal(rank({ goes_to_I1: 0.03, goes_to_I2: 0.03, web_search: 0.03, assistant_request: 0.95 }), 'ask:dm')
  assert.equal(rank({ goes_to_I1: 0.03, goes_to_I2: 0.03, web_search: 0.95, assistant_request: 0.1 }), 'web:x')
  assert.equal(rank({ goes_to_I1: 0.03, goes_to_I2: 0.03, web_search: 0.9, assistant_request: 0.9 }), null, 'both: today\'s highlight')
  assert.equal(rank({ goes_to_I1: 0.03, goes_to_I2: 0.03, web_search: 0.5, assistant_request: 0.95 }), null, 'the other undecided: today\'s highlight')
  assert.equal(rank({}), null, 'no answers: nothing')
})

// ---------------- 4. bridge: egress, route ----------------
test('bridge: off -> 404 and no request; loopback JSON only; the typed text is its own egress kind, refused by every gate today; failures are closed statuses', async () => {
  const client = contentClient()
  const off = route(client, { enabled: false })
  assert.deepEqual(await off.call({ query: 'x', candidates: [{ kind: 'ask' }] }), { status: 404, body: { status: 'off' } })
  const r = route(client)
  assert.equal((await r.call({ query: 'x', candidates: [{ kind: 'ask' }] }, { origin: 'https://evil.example' })).status, 403)
  assert.equal((await r.call({ query: 'x', candidates: [{ kind: 'ask' }] }, { method: 'GET' })).status, 405)
  assert.deepEqual((await r.call({ query: '', candidates: [] })).body, { status: 'invalid' })
  assert.equal(client.calls.length, 0)
  const ok = await r.call({ query: 'v1이랑 v2 견적 차이 알려줘', candidates: [{ kind: 'web' }, { kind: 'ask' }] })
  assert.deepEqual(ok.body, { status: 'decided', answers: { web_search: 0.03, assistant_request: 0.96 } })
  // TODAY (the product's own gate): no permission covers the typed text, so nothing is sent, whatever the flags say
  const today = createHudRouting({ client, mode: () => 'on', enabled: () => true })
  const before = client.calls.length
  assert.deepEqual(await today.judge({ query: 'x', candidates: [{ kind: 'ask' }] }), { status: 'not_allowed' }); assert.equal(client.calls.length, before)
  for (const perms of [{}, { canvasMaySend: true, runActive: true, toolCeiling: null, browserGranted: true, boardExcerptsToModel: true, speechConsent: true, topicConsent: true, memoryScope: {} }])
    assert.equal(createEgressGate(modelDataPermissions(perms)).allows('hud_text'), false, 'no model permission opens the typed search text')
  assert.equal(Object.hasOwn(modelDataPermissions({}), 'hud'), false, 'Decisions gets no permission of its own (U9)')
  const down = createHudRouting({ client: contentClient({ fail: 'timeout' }), mode: () => 'on', enabled: () => true, egressFor: FUTURE_PERMISSION })
  assert.deepEqual(await down.judge({ query: 'x', candidates: [{ kind: 'ask' }] }), { status: 'failed', fallback: 'timeout' })
  assert.deepEqual(await createHudRouting({ client, mode: () => 'off', enabled: () => true }).judge({ query: 'x', candidates: [{ kind: 'ask' }] }), { status: 'off' }, 'Decisions mode off')
})

// ---------------- 5. the window: the real glue over a synthetic DOM ----------------
function windowRig(options) {
  const { query, rowsOf = q => rows(q), client = contentClient(), maySend = ['res-v1', 'res-lunch'] } = options
  const pref = Object.hasOwn(options, 'pref') ? options.pref : 'on'
  const timers = [], updates = [], focus = { active: 'egd-rail-search-input' }
  const cardsById = { 'res-v1': { _resultRecord: { title: 'A사 견적서 v1 단가표', text: '단가 12,000원' } }, 'res-lunch': { _resultRecord: { title: '점심 메뉴 투표 결과', text: '' } } }
  for (const id of Object.keys(cardsById)) if (!maySend.includes(id)) cardsById[id] = {}
  let current = rowsOf(query)
  const state = { railSearch: { query, open: true, activeIndex: 0, personMoved: false, suggestion: null } }
  const r = route(client, Object.hasOwn(options, 'egressFor') ? { egressFor: options.egressFor } : {})
  const deps = { HudRouting: HR, readSurfacePref: key => (key === HR.HUD_ROUTING_PREF ? pref : undefined), state,
    window: { setTimeout: (fn, ms) => { timers.push({ fn, ms }); return timers.length }, clearTimeout() {} },
    document: { getElementById: id => cardsById[id] ?? null, get activeElement() { return focus.active } },
    buildRailSearchResults: q => { current = rowsOf(q); return current.list }, updateRailSearchActiveRow: () => updates.push(state.railSearch.activeIndex),
    deskStoreRequest: async (method, path, body) => (path === HUD_ROUTING_PATH ? r.call(body) : { status: 404, body: null }) }
  const body = `let hudRoutingTimer = null, hudRoutingSeq = 0;\n${decl('railSearchQuery')}\n${decl('railSearchLooksLikeNavigation')}\n${decl('hudRoutingModeNow')}\n${decl('scheduleHudRouting')}\n${decl('hudRowQuote')}\n${decl('routeHudQuery')}\n${decl('suggestHudRow')}\nreturn { scheduleHudRouting, routeHudQuery };`
  const api = new Function(...Object.keys(deps), body)(...Object.values(deps))
  // the timer callback starts the question without awaiting it (void): wait until the route, the mock and the reading have all finished
  const settle = async () => { for (let i = 0; i < 20; i++) await new Promise(res => setImmediate(res)) }
  const fire = async () => { const t = timers.shift(); assert.ok(t, 'a debounced question'); assert.equal(t.ms, HR.HUD_ROUTING_LIMITS.debounceMs); t.fn(); await settle() }
  return { ...api, state, timers, updates, focus, client, fire, settle, ran: () => current.ran }
}

test('window, default off (and "off"): no timer, no request, the highlight stays where it is', async () => {
  for (const pref of [undefined, null, 'off', 'yes']) {
    const w = windowRig({ pref, query: 'v1이랑 v2 견적 차이 알려줘' })
    w.scheduleHudRouting(); assert.equal(w.timers.length, 0, String(pref))
    assert.equal(await w.routeHudQuery(1), null); assert.equal(w.client.calls.length, 0); assert.equal(w.state.railSearch.activeIndex, 0)
  }
})

test('window "on": a question highlights the request row; an "open this card" request highlights that card; nothing runs, focus stays in the field', async () => {
  const ask = windowRig({ query: 'v1이랑 v2 견적 차이 알려줘' })
  ask.scheduleHudRouting(); await ask.fire()
  assert.equal(ask.client.calls.length, 1)
  assert.equal(ask.state.railSearch.activeIndex, 3, 'the request row (cards, web, ask)'); assert.deepEqual(ask.updates, [3])
  assert.deepEqual(ask.state.railSearch.suggestion.previous, 0)
  assert.deepEqual(ask.ran(), [], 'nothing ran'); assert.equal(ask.focus.active, 'egd-rail-search-input', 'focus did not move')
  assert.deepEqual(ask.state.railSearch.routingLog, [{ rule: 'decision', type: 'ask', applied: true }])
  const open = windowRig({ query: 'A사 견적서 v1 열어줘' })
  open.scheduleHudRouting(); await open.fire()
  assert.equal(open.state.railSearch.activeIndex, 0, 'already the first row: unchanged'); assert.deepEqual(open.state.railSearch.routingLog, [{ rule: 'decision', type: 'card', applied: false }])
  const second = windowRig({ query: '점심 메뉴 투표 열어줘', rowsOf: q => rows(q, { cards: [{ id: 'res-v1', title: 'A사 견적서 v1 단가표' }, { id: 'res-lunch', title: '점심 메뉴 투표 결과' }] }) })
  second.scheduleHudRouting(); await second.fire()
  assert.equal(second.state.railSearch.activeIndex, 1, 'the lunch card'); assert.deepEqual(second.ran(), [])
})

test('window "on": an address and an exact card name route by rule with NO request; a command line and a slash word change nothing and ask nothing', async () => {
  for (const [query, index, rule] of [['github.com/egdesk/desk', 0, 'address'], ['점심 메뉴 투표 결과', 1, 'name'], ['git status --short', 0, 'command'], ['/open 견적', 0, 'slash']]) {
    const w = windowRig({ query })
    w.scheduleHudRouting(); await w.fire()
    assert.equal(w.client.calls.length, 0, query); assert.equal(w.state.railSearch.activeIndex, index, query)
    assert.equal(w.state.railSearch.routingLog[0].rule, rule)
  }
})

test('window: the answer is dropped when the person typed on, moved the highlight, or closed the list; "advisory" records and moves nothing; a failure keeps today\'s highlight', async () => {
  const typed = windowRig({ query: 'v1이랑 v2 견적 차이 알려줘' })
  typed.scheduleHudRouting(); const t = typed.timers.shift(); t.fn(); typed.state.railSearch.query = 'v1이랑 v2 견적 차이 알려줘 단가만'; await typed.settle()
  assert.equal(typed.client.calls.length, 1, 'the question was answered'); assert.equal(typed.state.railSearch.activeIndex, 0); assert.equal(typed.state.railSearch.routingLog, undefined, 'and dropped')
  const moved = windowRig({ query: 'v1이랑 v2 견적 차이 알려줘' })
  moved.scheduleHudRouting(); moved.state.railSearch.personMoved = true; moved.state.railSearch.activeIndex = 2; await moved.fire()
  assert.equal(moved.state.railSearch.activeIndex, 2, 'the person\'s own choice stays'); assert.deepEqual(moved.state.railSearch.routingLog, [{ rule: 'decision', type: 'ask', applied: false }])
  const closed = windowRig({ query: 'v1이랑 v2 견적 차이 알려줘' })
  closed.scheduleHudRouting(); const c = closed.timers.shift(); c.fn(); closed.state.railSearch.open = false; await closed.settle()
  assert.equal(closed.client.calls.length, 1); assert.equal(closed.state.railSearch.activeIndex, 0); assert.equal(closed.state.railSearch.routingLog, undefined)
  const adv = windowRig({ pref: 'advisory', query: 'v1이랑 v2 견적 차이 알려줘' })
  adv.scheduleHudRouting(); await adv.fire()
  assert.equal(adv.state.railSearch.activeIndex, 0); assert.deepEqual(adv.state.railSearch.routingLog, [{ rule: 'decision', type: 'ask', applied: false }])
  const down = windowRig({ query: 'v1이랑 v2 견적 차이 알려줘', client: contentClient({ fail: 'timeout' }) })
  down.scheduleHudRouting(); await down.fire()
  assert.equal(down.state.railSearch.activeIndex, 0); assert.deepEqual(down.state.railSearch.routingLog, [{ rule: 'failed', type: null, applied: false }])
  const quiet = windowRig({ query: '점심 메뉴 투표 열어줘', maySend: [] })
  quiet.scheduleHudRouting(); await quiet.fire()
  assert.deepEqual(quiet.client.calls[0].questions.map(q => q.name), ['web_search', 'assistant_request'], 'no card whose words may not leave is quoted')
})

test('Enter: within one reaction time after the highlight moved, Enter runs the row the person saw; later, the highlighted row; the keyboard path is wired', () => {
  const s = { previous: 0, index: 3, at: 1000 }
  assert.equal(HR.hudEnterIndex({ activeIndex: 3, suggestion: s, now: 1100 }), 0)
  assert.equal(HR.hudEnterIndex({ activeIndex: 3, suggestion: s, now: 1000 + HR.HUD_ROUTING_LIMITS.enterGuardMs }), 3)
  assert.equal(HR.hudEnterIndex({ activeIndex: 2, suggestion: s, now: 1100 }), 2, 'the person moved it since')
  assert.equal(HR.hudEnterIndex({ activeIndex: 1, suggestion: null, now: 5 }), 1, 'no suggestion: as today')
  assert.match(surface, /results\[state\.railSearchEnterIndex\?\.\(\) \?\? state\.railSearch\.activeIndex\] \|\| results\[0\];/)
  assert.match(surface, /state\.railSearchEnterIndex = \(\) => HudRouting\.hudEnterIndex\(\{ activeIndex: state\.railSearch\.activeIndex, suggestion: state\.railSearch\.suggestion, now: Date\.now\(\) \}\);/)
  assert.match(surface, /state\.railSearch\.personMoved = true; state\.railSearch\.suggestion = null; \/\/ L1 c20: the person's own choice wins\n      state\.railSearch\.activeIndex = \(state\.railSearch\.activeIndex \+ delta/)
  assert.match(surface, /onmouseenter: \(\) => \{\n          state\.railSearch\.activeIndex = index;\n          state\.railSearch\.personMoved = true; state\.railSearch\.suggestion = null;/)
  assert.match(surface, /    scheduleRailSearchFiles\(state\.railSearch\.query\);\n    \/\/ L1 c20:[^\n]*\n    state\.railSearch\.personMoved = false; state\.railSearch\.suggestion = null;\n    scheduleHudRouting\(\);/)
  // the glue never executes a row or moves focus
  for (const name of ['routeHudQuery', 'suggestHudRow', 'scheduleHudRouting']) assert.ok(!/execute|\.focus\(|executeRailSearchResult|spawn|setDraft/.test(decl(name)), name)
})

test('window "on" TODAY (the product\'s own gate): the typed text goes to no model, so there is no request and the highlight stays; the code rules still work', async () => {
  const w = windowRig({ query: 'v1이랑 v2 견적 차이 알려줘', egressFor: null })
  w.scheduleHudRouting(); await w.fire()
  assert.equal(w.client.calls.length, 0); assert.equal(w.state.railSearch.activeIndex, 0)
  assert.deepEqual(w.state.railSearch.routingLog, [{ rule: 'not_allowed', type: null, applied: false }])
  const named = windowRig({ query: '점심 메뉴 투표 결과', egressFor: null })
  named.scheduleHudRouting(); await named.fire()
  assert.equal(named.state.railSearch.activeIndex, 1, 'an exact card name is routed by rule'); assert.equal(named.client.calls.length, 0)
})
