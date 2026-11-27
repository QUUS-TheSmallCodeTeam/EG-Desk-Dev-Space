import test from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { createDecisionBudget, DECISION_MODEL, DECISIONS_ENDPOINT } from './egdesk-decision-client.mjs'
import { createBoardPresentationHttpHandler } from './egdesk-board-presentation-http.mjs'

const root = '/decision/board-presentation'
const fixtureKey = 'fixture-only-not-a-provider-key'
const dto = { cue: '  Cafe\u0301 인계  ', items: [
  { kind: '업무 전표', focus: true, movable: true }, { kind: '메모', focus: false, movable: true },
], wide: true, tall: true }
const pair = '선택한 두 장 나란히 비교'
const keep = '현재 배치 유지'
const accepted = (a = 0.94, b = 0.06) => ({ name: 'board_view', type: 'choice', choice: pair, confidence: a,
  probabilities: [{ value: pair, probability: a }, { value: keep, probability: b }] })
const result = (answers = [accepted()]) => Response.json({ answers, usage: { input_tokens: 10 } })

async function setup(t, options = {}) {
  const state = { key: fixtureKey, savedAt: 123, mode: 'on', time: 0, getKey: null, ...options.state }
  const calls = []
  const budget = options.budget || createDecisionBudget({ monthlyInputTokenCap: 100 })
  let handler
  const server = createServer(async (req, res) => {
    if (!(await handler(req, res, new URL(req.url, 'http://127.0.0.1')))) { res.writeHead(404); res.end() }
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address()
  t.after(() => { handler.invalidate(); server.closeAllConnections(); return new Promise(resolve => server.close(resolve)) })
  handler = createBoardPresentationHttpHandler({
    credentials: { getApiKey: () => state.getKey ? state.getKey() : state.key, savedAt: () => state.savedAt },
    getMode: () => state.mode, budget, now: () => state.time,
    fetchImpl: (endpoint, init) => { calls.push({ endpoint, init }); return options.provider?.(endpoint, init) ?? result() },
    port,
  })
  // Actual local HTTP only; all provider requests are captured by fetchImpl above.
  async function post(action, body, { headers = {}, method = 'POST', signal } = {}) {
    const response = await fetch(`http://127.0.0.1:${port}${root}/${action}`, {
      method, headers: { 'Content-Type': 'application/json', ...headers },
      body: method === 'POST' && body !== undefined ? JSON.stringify(body) : undefined, signal,
    })
    return { code: response.status, body: await response.json(), headers: response.headers }
  }
  const prepare = async (input = dto) => (await post('prepare', input)).body
  const run = async ticket => (await post('run', { ticket, confirm: true })).body
  return { state, calls, budget, handler, post, prepare, run }
}

const manual = { status: 'manual' }
test('prepare is local; a fresh confirm sends only reviewed cue, coarse descriptors and one choice', async t => {
  const { calls, post, run } = await setup(t)
  const response = await post('prepare', dto)
  assert.equal(response.code, 200)
  assert.equal(response.headers.get('cache-control'), 'no-store')
  const { status, ticket, mode, preview, expiresInMs } = response.body
  assert.equal(status, 'prepared')
  assert.match(ticket, /^[a-f0-9]{48}$/)
  assert.equal(mode, 'on')
  assert.equal(expiresInMs, 60_000)
  assert.deepEqual(preview, { cue: 'Café 인계', items: dto.items.map((x, i) => ({ slot: 'AB'[i], ...x })),
    options: ['keep', 'overview', 'focus', 'pair'], wide: true, tall: true })
  assert.equal(calls.length, 0)
  for (const body of [{ ticket }, { ticket, confirm: false }, { ticket, confirm: 'true' }, { ticket, confirm: true, cue: 'different' }]) {
    assert.equal((await post('run', body)).code, 400)
    assert.equal(calls.length, 0)
  }
  assert.deepEqual(await run(ticket), { status: 'preview', preview: 'pair' })
  assert.deepEqual(await run(ticket), manual)
  assert.equal(calls.length, 1)
  const [{ endpoint, init }] = calls
  assert.equal(endpoint, DECISIONS_ENDPOINT)
  assert.equal(init.redirect, 'error')
  assert.equal(init.credentials, 'omit')
  assert.equal(init.headers.authorization, `Bearer ${fixtureKey}`)
  const packet = JSON.parse(init.body)
  assert.deepEqual(Object.keys(packet).sort(), ['input', 'model', 'questions'])
  assert.equal(packet.model, DECISION_MODEL)
  assert.deepEqual(packet.input, [{ role: 'user', content: [
    { type: 'input_text', text: preview.cue },
    { type: 'input_json', data: { availableWidth: '두 장 폭', selected: [
      { slot: 'A', kind: '업무 전표', designatedFocus: true }, { slot: 'B', kind: '메모', designatedFocus: false },
    ] } },
  ] }])
  assert.equal(packet.questions.length, 1)
  assert.equal(packet.questions[0].type, 'choice')
  assert.equal(packet.questions[0].name, 'board_view')
  assert.equal(packet.questions[0].choices.length, 4)
  for (const forbidden of [ticket, fixtureKey]) assert.ok(!init.body.includes(forbidden))
})

test('rejects untrusted origin, wrong method, non-JSON, query fields, private fields and malformed coarse DTOs', async t => {
  const { calls, post } = await setup(t)
  for (const origin of ['https://untrusted.example', 'http://127.0.0.1:1', 'null']) {
    assert.equal((await post('prepare', dto, { headers: { Origin: origin } })).code, 403)
  }
  assert.equal((await post('prepare', dto, { headers: { 'Sec-Fetch-Site': 'same-site' } })).code, 403)
  assert.equal((await post('prepare', dto, { method: 'GET' })).code, 405)
  assert.equal((await post('prepare', dto, { headers: { 'Content-Type': 'text/plain' } })).code, 415)
  assert.equal((await post('prepare?boardId=forbidden', dto)).code, 400)
  assert.equal((await post('prepare', { ...dto, cue: 'x'.repeat(5000) })).code, 413)
  for (const input of [{ ...dto, boardId: 'secret' }, { ...dto, width: 900 }, { ...dto, wide: 1 },
    { ...dto, items: [] }, { ...dto, items: Array(13).fill(dto.items[1]) },
    { ...dto, items: [dto.items[0], dto.items[0]] },
    ...['id', 'privateId', 'title', 'x', 'url'].map(key => ({ ...dto, items: [{ ...dto.items[0], [key]: 'secret' }] })),
    { ...dto, items: [{ ...dto.items[0], kind: 'private title' }] },
    ...['', 'x'.repeat(281), 'xx\nyy', 'xx\u202eyy', '\ud800'].map(cue => ({ ...dto, cue })),
  ]) assert.equal((await post('prepare', input)).code, 400)
  assert.equal(calls.length, 0)
})

test('off, absent key, and an exhausted shared budget disable preparation', async t => {
  const { state, calls, budget, prepare } = await setup(t)
  state.mode = 'off'
  assert.deepEqual(await prepare(), { status: 'disabled', mode: 'off', reason: 'mode-off' })
  state.mode = 'on'; state.key = null
  assert.deepEqual(await prepare(), { status: 'disabled', mode: 'on', reason: 'not-configured' })
  state.key = fixtureKey; state.savedAt = null
  assert.equal((await prepare()).reason, 'not-configured')
  state.savedAt = 123
  budget.record({ inputTokens: 100 })
  assert.deepEqual(await prepare(), { status: 'disabled', mode: 'on', reason: 'budget-exceeded' })
  assert.equal(calls.length, 0)
})

test('mode, revision, key and budget are checked again on run; denied attempts consume the ticket', async t => {
  const { state, calls, budget, prepare, run, handler } = await setup(t)
  for (const [key, value] of [['mode', 'advisory'], ['savedAt', 124], ['key', 'replacement-fixture']]) {
    const { ticket } = await prepare()
    const original = state[key]
    state[key] = value
    assert.deepEqual(await run(ticket), manual)
    state[key] = original
    assert.deepEqual(await run(ticket), manual)
  }
  const { ticket: revoked } = await prepare()
  handler.invalidate() // Mode/key writes revoke even if values are later restored or the save time is identical.
  assert.deepEqual(await run(revoked), manual)
  const { ticket } = await prepare()
  budget.record({ inputTokens: 100 })
  // The one refusal the owner can act on carries a closed reason word (never provider text), so the screen can name it.
  assert.deepEqual(await run(ticket), { status: 'manual', reason: 'budget_exceeded' })
  assert.equal(calls.length, 0)
})

test('the real client dispatch hook rejects a different selected key and a last-moment key change', async t => {
  const { state, calls, prepare, run } = await setup(t)
  for (const rotate of [false, true]) {
    const { ticket } = await prepare()
    let reads = 0
    state.getKey = () => {
      if (++reads !== 2) return state.key // Run authority snapshot, then client credential read.
      if (!rotate) return 'different-fixture-selected-by-client'
      const keyAtSelection = state.key
      queueMicrotask(() => { state.key = 'replacement-fixture' }) // Same revision, after selection, before auth callback.
      return keyAtSelection
    }
    assert.deepEqual(await run(ticket), manual)
    state.getKey = null; state.key = fixtureKey
  }
  assert.equal(calls.length, 0)
})

test('dispatch hook also rechecks the current mode and budget after the client check', async t => {
  let checks = 0
  const budget = { canSpend() { return ++checks < 4 }, record() { assert.fail('no spend') } }
  const { state, calls, prepare, run } = await setup(t, { budget })
  assert.deepEqual(await run((await prepare()).ticket), manual)
  assert.equal(checks, 4)
  checks = 0
  const { ticket } = await prepare()
  let reads = 0
  state.getKey = () => {
    if (++reads === 2) queueMicrotask(() => { state.mode = 'advisory' })
    return state.key
  }
  assert.deepEqual(await run(ticket), manual)
  assert.equal(calls.length, 0)
})

test('cancel and expiry discard tickets; memory is bounded and capacity is reclaimed', async t => {
  const { calls, state, post, prepare, run } = await setup(t)
  const { ticket } = await prepare()
  assert.deepEqual((await post('cancel', { ticket })).body, { status: 'cancelled' })
  assert.deepEqual(await run(ticket), manual)
  const { ticket: expiring } = await prepare()
  state.time = 60_000
  assert.deepEqual(await run(expiring), manual)
  let last
  for (let i = 0; i < 32; i++) {
    last = await prepare()
    assert.equal(last.status, 'prepared')
  }
  assert.equal((await prepare()).reason, 'busy')
  await post('cancel', { ticket: last.ticket })
  assert.equal((await prepare()).status, 'prepared')
  assert.equal(calls.length, 0)
})

test('duplicate confirmations dispatch once; cancelling in flight aborts and suppresses late success', async t => {
  let announce, finish
  const started = new Promise(resolve => { announce = resolve })
  const delayed = new Promise(resolve => { finish = resolve })
  const { calls, post, prepare, run } = await setup(t, { provider: (_url, init) => { announce(init.signal); return delayed } })
  const { ticket } = await prepare()
  const first = run(ticket)
  const signal = await started
  assert.deepEqual(await run(ticket), manual)
  const other = await prepare()
  assert.deepEqual(await run(other.ticket), manual)
  assert.deepEqual((await post('cancel', { ticket })).body, { status: 'cancelled' })
  assert.equal(signal.aborted, true)
  finish(result()) // Provider transport ignoring abort must still not give a preview.
  assert.deepEqual(await first, manual)
  assert.equal(calls.length, 1)
})

test('in-flight authority revocation hides an otherwise valid result', async t => {
  let announce, finish
  const started = new Promise(resolve => { announce = resolve })
  const delayed = new Promise(resolve => { finish = resolve })
  const { handler, prepare, run } = await setup(t, { provider: (_url, init) => { announce(init.signal); return delayed } })
  const request = run((await prepare()).ticket)
  const signal = await started
  handler.invalidate()
  assert.equal(signal.aborted, true)
  finish(result())
  assert.deepEqual(await request, manual)
})

test('advisory yields a suggestion and an authorized response may reach the shared cap', async t => {
  const { calls, budget, prepare, run } = await setup(t, { state: { mode: 'advisory' },
    budget: createDecisionBudget({ monthlyInputTokenCap: 10 }) })
  assert.deepEqual(await run((await prepare()).ticket), { status: 'advisory-only', suggestion: 'pair' })
  assert.equal(budget.canSpend(), false)
  assert.equal(calls.length, 1)
})

test('uncertain, ineligible, refused, malformed and provider failure are manual, never retried', async t => {
  let next
  const { calls, prepare, run } = await setup(t, { provider: () => next() })
  // Provider failures add only a closed reason word to the manual reply; no provider text, detail or answer is ever echoed.
  for (const [input, provider, reason] of [
    [dto, () => result([accepted(0.51, 0.49)]), null],
    [{ ...dto, tall: false }, () => result(), null],
    [dto, () => result([{ name: 'board_view', type: 'refusal' }]), 'REFUSAL'],
    [dto, () => Response.json({ noisy: 'do not return' }), 'bad_response'],
    [dto, () => { throw new Error('noisy transport failure') }, 'unreachable'],
    [dto, () => Response.json({ error: { code: 'insufficient_quota', message: 'do not return' } }, { status: 429 }), 'no_credit'],
  ]) {
    next = provider
    const before = calls.length
    const reply = await run((await prepare(input)).ticket)
    if (reason === 'REFUSAL') assert.equal(reply.status, 'manual')
    else assert.deepEqual(reply, reason ? { status: 'manual', reason } : manual)
    assert.doesNotMatch(JSON.stringify(reply), /noisy|do not return/)
    assert.equal(calls.length, before + 1)
  }
})

test('a disconnected confirmation aborts the provider transport and never revives the ticket', { timeout: 4000 }, async t => {
  let announce, finish, resolveAborted
  const started = new Promise(resolve => { announce = resolve })
  const delayed = new Promise(resolve => { finish = resolve })
  const aborted = new Promise(resolve => { resolveAborted = resolve })
  const { calls, post, prepare, run } = await setup(t, {
    provider: (_url, init) => { init.signal.addEventListener('abort', resolveAborted, { once: true }); announce(); return delayed },
  })
  t.after(() => finish(result()))
  const { ticket } = await prepare()
  const controller = new AbortController()
  const request = assert.rejects(post('run', { ticket, confirm: true }, { signal: controller.signal }), { name: 'AbortError' })
  await started
  controller.abort()
  await request
  await aborted
  finish(result())
  assert.deepEqual(await run(ticket), manual)
  assert.equal(calls.length, 1)
})

const sceneBase = { overlap: 'selected', frame: 'inside', clip: 'inside', target: 'title', reach: 'hit', obscured: false }
const sceneDto = (focusScene = {}, cue = '출고 작업을 이어가기 좋게 보여줘') => ({ ...dto, cue, items: [
  { ...dto.items[0], scene: { ...sceneBase, target: 'claim', ...focusScene } },
  { ...dto.items[1], scene: { ...sceneBase } },
] })
const focus = '지정 자료 한 장에 집중'
const front = '지정 자료만 앞으로'
// An explicit fixture policy checks wiring, not how a live model would decide.
function sceneProvider(_endpoint, { body }) {
  const { input, questions } = JSON.parse(body)
  const [purpose, { data }] = input[0].content
  const { scene } = data.selected.find(item => item.designatedFocus)
  const allowed = questions[0].choices.map(({ value }) => value)
  const choice = purpose.text.includes('비교') && scene.overlap === 'selected' && allowed.includes(pair) ? pair
    : scene.obscured && ['miss', 'partial'].includes(scene.reach) && allowed.includes(front) ? front
    : scene.reach === 'partial' && scene.frame === 'partial' && allowed.includes(focus) ? focus : keep
  return result([{ name: 'board_view', type: 'choice', choice, confidence: 0.94,
    probabilities: [{ value: choice, probability: 0.94 }, { value: choice === keep ? pair : keep, probability: 0.06 }] }])
}

test('scene and reviewed purpose independently reach the choice fixture; preview packet is exactly the wire body', async t => {
  const { calls, prepare, run } = await setup(t, { provider: sceneProvider })
  const accessible = sceneDto()
  const targetsPartlyReachable = sceneDto({ frame: 'partial', clip: 'partial', reach: 'partial' })
  const compareSameScene = { ...targetsPartlyReachable, cue: '두 자료를 비교하기 좋게 보여줘' }
  const obscuredAction = sceneDto({ reach: 'miss', obscured: true })
  let i = 0
  for (const [request, expected, expectedLabels] of [
    [accessible, 'keep', [keep, '선택 자료 전체 보기', focus, pair]],
    [targetsPartlyReachable, 'focus', [keep, '선택 자료 전체 보기', focus, pair]],
    [compareSameScene, 'pair', [keep, '선택 자료 전체 보기', focus, pair]],
    [obscuredAction, 'front', [keep, '선택 자료 전체 보기', focus, pair, front]],
  ]) {
    const prepared = await prepare(request)
    assert.equal(prepared.status, 'prepared')
    const { packet } = prepared.preview
    assert.equal(calls.length, i)
    assert.deepEqual(Object.keys(packet).sort(), ['input', 'model', 'questions'])
    assert.equal(packet.model, DECISION_MODEL)
    assert.deepEqual(packet.input, [{ role: 'user', content: [
      { type: 'input_text', text: request.cue },
      { type: 'input_json', data: { availableWidth: '두 장 폭', selected: request.items.map((item, j) => ({
        slot: 'AB'[j], kind: item.kind, designatedFocus: item.focus, scene: item.scene,
      })) } },
    ] }])
    assert.equal(packet.questions.length, 1)
    assert.deepEqual(packet.questions[0].choices.map(c => c.value), expectedLabels)
    assert.deepEqual(prepared.preview.options, ['keep', 'overview', 'focus', 'pair', ...(expected === 'front' ? ['front'] : [])])
    assert.deepEqual(await run(prepared.ticket), { status: 'preview', preview: expected })
    const { endpoint, init } = calls[i++]
    assert.equal(endpoint, DECISIONS_ENDPOINT)
    assert.deepEqual(packet, JSON.parse(init.body))
    assert.equal(JSON.stringify(packet), init.body)
    assert.doesNotMatch(init.body, /"(?:id|cardId|titleText|copy|x|y|bounds|count|blocker|movable)"\s*:/)
    assert.ok(!init.body.includes(prepared.ticket) && !init.body.includes(fixtureKey))
  }
  assert.equal(calls.length, 4)
})

test('scene prepare is local; decline, cancellation and off mode have zero provider calls', async t => {
  const { state, calls, post, prepare, run } = await setup(t, { provider: sceneProvider })
  const request = sceneDto({ obscured: true, reach: 'partial' })
  const { ticket } = await prepare(request)
  assert.equal((await post('run', { ticket, confirm: false })).code, 400)
  assert.deepEqual((await post('cancel', { ticket })).body, { status: 'cancelled' })
  assert.deepEqual(await run(ticket), manual)
  state.mode = 'off'
  assert.deepEqual(await prepare(request), { status: 'disabled', mode: 'off', reason: 'mode-off' })
  assert.equal(calls.length, 0)
})

test('scene DTO is strict and all-or-none; malformed or private evidence is rejected before a ticket', async t => {
  const { calls, post } = await setup(t)
  const valid = sceneDto()
  const { reach, ...missing } = valid.items[0].scene
  for (const invalid of [null, [], missing, { ...sceneBase, obscured: 1 }, { ...sceneBase, overlap: 'private-blocker' },
    { ...sceneBase, frame: 'visible' }, { ...sceneBase, clip: 'outside' }, { ...sceneBase, target: 'delete' }, { ...sceneBase, reach: 'maybe' },
    ...['id', 'copy', 'bounds', 'x', 'count', 'blocker', 'unknownBlocker'].map(key => ({ ...sceneBase, [key]: 'private-sentinel' })),
  ]) {
    const response = await post('prepare', { ...valid, items: [{ ...valid.items[0], scene: invalid }, valid.items[1]] })
    assert.equal(response.code, 400)
    assert.deepEqual(response.body, { status: 'manual', reason: 'invalid-request' })
  }
  for (const items of [[valid.items[0], dto.items[1]], [dto.items[0], valid.items[1]]]) {
    assert.equal((await post('prepare', { ...valid, items })).code, 400)
  }
  assert.equal(calls.length, 0)
})
