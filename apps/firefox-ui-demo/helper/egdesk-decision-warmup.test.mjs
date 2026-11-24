// L6 c18: the idle warm-up of the Decisions endpoint. Fake transport and fake clock only; nothing leaves the process.
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { Readable } from 'node:stream'
import test from 'node:test'
import { createDecisionBudget, createDecisionClient, DECISIONS_ENDPOINT } from './egdesk-decision-client.mjs'
import { CONTENT_FREE_REQUESTS, createEgressGate, EGRESS_KINDS, EGRESS_SITES } from './egdesk-decision-egress.mjs'
import { createDecisionHttpHandler } from './egdesk-decision-http.mjs'
import { createDecisionActivity, createDecisionWarmup, WARMUP_IDLE_MS, WARMUP_MAX_JOIN_MS, warmupConfigFromEnv, warmupMode } from './egdesk-decision-warmup.mjs'
import { createComposerWarmup, decisionWarmupMode, DECISION_WARMUP_LIMITS } from '../overlay/resources/EGDeskDecisionWarmup.sys.mjs'
import { CodexChatRuntime } from './codex-chat-runtime.mjs'

const MIN = 60_000
const KEY = 'sk-proj-' + 'w'.repeat(48)
/** A fake clock and a fake Decisions transport: every request is recorded; `delay(ms)` advances the clock inside a request. */
function world({ mode = 'on', decisionsMode = 'on', key = true, idleMs = WARMUP_IDLE_MS, joinMs = 0, budget = null, respond = null } = {}) {
  const clock = { t: Date.parse('2026-11-25T01:00:00Z') }
  const now = () => clock.t
  const wire = []
  const fake = async (url, init) => {
    const body = JSON.parse(init.body)
    wire.push({ url, body, at: clock.t, headers: init.headers })
    const spec = respond ? await respond(body, wire.length) : { status: 200, ms: 300 }
    clock.t += spec.ms ?? 300
    if (spec.throw) throw Object.assign(new Error('network'), { name: 'TypeError' })
    return Response.json({ model: 'gpt-6-luna', usage: { input_tokens: spec.tokens ?? 90, output_tokens: 0 },
      answers: body.questions.map(q => ({ name: q.name, type: 'predicate', probability: 0.9 })) }, { status: spec.status ?? 200 })
  }
  const activity = createDecisionActivity({ now, idleMs })
  const client = createDecisionClient({ getApiKey: () => (key ? KEY : null), fetchImpl: activity.wrap(fake), budget })
  const state = { mode, decisionsMode, key }
  const warmup = createDecisionWarmup({ client, activity, now, idleMs, joinMs, mode: () => state.mode, decisionsMode: () => state.decisionsMode, hasKey: () => state.key })
  const real = async (text = 'a real question') => client.decide({ input: text, questions: [{ type: 'predicate', name: 'q', instructions: 'Is it?' }] })
  return { clock, wire, activity, client, warmup, state, real }
}

test('the flag: only advisory and on turn anything on; environment values are clamped', () => {
  assert.deepEqual(['on', 'advisory', 'off', '', undefined, 'ON', 'true', 1].map(warmupMode), ['on', 'advisory', 'off', 'off', 'off', 'off', 'off', 'off'])
  assert.deepEqual(warmupConfigFromEnv({}), { mode: 'off', idleMs: 5 * MIN, joinMs: 0 })
  assert.deepEqual(warmupConfigFromEnv({ EGDESK_DECISION_WARMUP: 'on', EGDESK_DECISION_WARMUP_IDLE_MIN: '10', EGDESK_DECISION_WARMUP_JOIN_MS: '800' }), { mode: 'on', idleMs: 10 * MIN, joinMs: 800 })
  assert.deepEqual(warmupConfigFromEnv({ EGDESK_DECISION_WARMUP: 'on', EGDESK_DECISION_WARMUP_IDLE_MIN: '0', EGDESK_DECISION_WARMUP_JOIN_MS: '99999' }), { mode: 'on', idleMs: 5 * MIN, joinMs: 0 }, 'out of range: the defaults')
  assert.deepEqual(warmupConfigFromEnv({ EGDESK_DECISION_WARMUP: 'on', EGDESK_DECISION_WARMUP_IDLE_MIN: '61', EGDESK_DECISION_WARMUP_JOIN_MS: 'x' }), { mode: 'on', idleMs: 5 * MIN, joinMs: 0 })
  assert.equal(WARMUP_MAX_JOIN_MS, 1500)
})

test('off (default): nothing is sent and nothing is counted as sent, whatever the idle time', async () => {
  const w = world({ mode: 'off' })
  assert.deepEqual(w.warmup.trigger('composer'), { action: 'skipped', why: 'disabled' })
  assert.equal(w.warmup.beforeTurn(), null)
  assert.equal(w.wire.length, 0)
  assert.equal(w.warmup.stats().sent, 0)
})

test('on: after a long idle the composer sends exactly the fixed content-free request, through the gate, and nobody waits for it', async () => {
  const w = world()
  const out = w.warmup.trigger('composer')
  assert.deepEqual(out, { action: 'sent' })
  assert.equal(w.wire.length, 0, 'the trigger itself waits for nothing: the request is on its way (the client looks the key up first)')
  await w.warmup.settled()
  assert.equal(w.wire.length, 1)
  const { url, body, headers } = w.wire[0]
  assert.equal(url, DECISIONS_ENDPOINT)
  // exactly the registered body: the model, the fixed input, the one fixed question; no cache key, no safety identifier, no extra field
  assert.deepEqual(Object.keys(body).sort(), ['input', 'model', 'questions'])
  assert.equal(body.input, CONTENT_FREE_REQUESTS.warmup.input)
  assert.deepEqual(body.questions, CONTENT_FREE_REQUESTS.warmup.questions)
  assert.deepEqual(Object.keys(headers).sort(), ['authorization', 'content-type'], 'no custom header')
  const s = w.warmup.stats()
  assert.deepEqual([s.sent, s.landed, s.failed, s.inputTokens, s.inputTokensPerWarmup], [1, 1, 0, 90, 90])
})

test('"the last request" is any Decisions request: real traffic or the key check keeps the warm-up away; the boundary is exactly idleMs after its end', async () => {
  const w = world()
  await w.real()                                   // ends at +300 ms
  assert.deepEqual(w.warmup.trigger('composer'), { action: 'skipped', why: 'recent_traffic' })
  w.clock.t += 5 * MIN - 1
  assert.equal(w.warmup.trigger('composer').why, 'recent_traffic', 'one millisecond short')
  w.clock.t += 1
  assert.deepEqual(w.warmup.trigger('composer'), { action: 'sent' }, 'exactly idleMs after the end of the last request')
  await w.warmup.settled()
  // the warm-up is traffic itself: the next trigger, right away, finds recent traffic: at most one warm-up per idle period
  assert.equal(w.warmup.trigger('composer').why, 'recent_traffic')
  // the key check (verifyKey) is a request too
  w.clock.t += 6 * MIN
  await w.client.verifyKey(KEY)
  assert.equal(w.warmup.trigger('composer').why, 'recent_traffic')
  assert.equal(w.wire.filter(x => x.body.input === CONTENT_FREE_REQUESTS.warmup.input).length, 1)
})

test('a request in flight is traffic; a second trigger while a warm-up is in flight does nothing', async () => {
  const w = world({ respond: async () => ({ status: 200, ms: 300 }) })
  w.warmup.trigger('composer')
  assert.equal(w.warmup.trigger('composer').why, 'in_flight')
  await w.warmup.settled()
  assert.equal(w.wire.length, 1)
  const slow = world()
  let release
  const gate = new Promise(resolve => { release = resolve })
  const hung = createDecisionActivity({ now: () => slow.clock.t })
  const client = createDecisionClient({ getApiKey: () => KEY, fetchImpl: hung.wrap(async () => { await gate; return Response.json({ answers: [] }) }) })
  const warm = createDecisionWarmup({ client, activity: hung, now: () => slow.clock.t, mode: () => 'on', decisionsMode: () => 'on', hasKey: () => true })
  const pending = client.decide({ input: 'x', questions: [{ type: 'predicate', name: 'q', instructions: 'Is it?' }] }).catch(() => {})
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(hung.busy(), true)
  assert.equal(warm.trigger('composer').why, 'recent_traffic', 'a request that has not ended yet is traffic')
  release(); await pending
})

test('skips are closed codes: Decisions mode off, no key, bad reason; none of them sends anything', async () => {
  const w = world({ decisionsMode: 'off' })
  assert.equal(w.warmup.trigger('composer').why, 'mode_off')
  w.state.decisionsMode = 'on'; w.state.key = false
  assert.equal(w.warmup.trigger('composer').why, 'no_key')
  w.state.key = true
  assert.equal(w.warmup.trigger('keystroke').why, 'bad_reason')
  assert.equal(w.warmup.trigger(undefined).why, 'bad_reason')
  assert.equal(w.wire.length, 0)
  const s = w.warmup.stats()
  assert.deepEqual(s.skipped, { mode_off: 1, no_key: 1, bad_reason: 2 })
  // a mode()/hasKey() that throws is a skip, never an exception
  const bad = createDecisionWarmup({ client: w.client, activity: w.activity, mode: () => { throw new Error('x') } })
  assert.equal(bad.trigger('composer').action, 'skipped')
})

test('advisory records what it would do and sends nothing: no request, no tokens', async () => {
  const w = world({ mode: 'advisory' })
  assert.deepEqual(w.warmup.trigger('composer'), { action: 'would_warm' })
  assert.deepEqual(w.warmup.trigger('turn'), { action: 'would_warm' })
  assert.equal(w.warmup.beforeTurn(), null)
  assert.equal(w.wire.length, 0)
  const s = w.warmup.stats()
  assert.deepEqual([s.wouldWarm, s.sent, s.inputTokens, s.turnMisses], [3, 0, 0, 2])
})

test('a failed warm-up is never retried, is counted by closed code, and pauses warm-ups for idleMs', async () => {
  // budget exhausted: the client refuses before any request, so the activity sees no traffic and only the pause holds the next warm-up back
  const budget = createDecisionBudget({ monthlyInputTokenCap: 10, initial: { month: new Date().toISOString().slice(0, 7), inputTokens: 10 } })
  const w = world({ budget })
  assert.equal(budget.canSpend(), false)
  assert.deepEqual(w.warmup.trigger('composer'), { action: 'sent' })
  await w.warmup.settled()
  assert.equal(w.wire.length, 0)
  let s = w.warmup.stats()
  assert.deepEqual([s.sent, s.landed, s.failed, s.failures], [1, 0, 1, { budget_exceeded: 1 }])
  assert.equal(w.warmup.trigger('composer').why, 'paused_after_failure')
  w.clock.t += 5 * MIN - 1
  assert.equal(w.warmup.trigger('composer').why, 'paused_after_failure')
  w.clock.t += 1
  assert.equal(w.warmup.trigger('composer').action, 'sent', 'after idleMs the pause is over')
  await w.warmup.settled()
  // a server error: one request, no second attempt
  const e = world({ respond: async () => ({ status: 500, ms: 200 }) })
  e.warmup.trigger('composer'); await e.warmup.settled()
  assert.equal(e.wire.length, 1)
  s = e.warmup.stats()
  assert.equal(s.failed, 1); assert.equal(Object.keys(s.failures).length, 1)
  // a network error: the same
  const n = world({ respond: async () => ({ throw: true, ms: 50 }) })
  n.warmup.trigger('composer'); await n.warmup.settled()
  assert.equal(n.wire.length, 1); assert.deepEqual(n.warmup.stats().failures, { unreachable: 1 })
})

test('the gate: only the registered fixed body can leave under the warm-up name; anything else is refused before a key lookup', async () => {
  const w = world()
  let lookups = 0
  const client = createDecisionClient({ getApiKey: () => { lookups++; return KEY }, fetchImpl: async () => { throw new Error('must not send') } })
  const gated = createEgressGate({}).guardContentFree(client, 'warmup')
  const fixed = { input: CONTENT_FREE_REQUESTS.warmup.input, questions: CONTENT_FREE_REQUESTS.warmup.questions }
  for (const bad of [
    { input: 'the person asked about the Acme quote', questions: fixed.questions },
    { ...fixed, input: fixed.input + ' ' },
    { ...fixed, questions: [{ ...fixed.questions[0], instructions: 'Is the person happy?' }] },
    { ...fixed, questions: [...fixed.questions, { type: 'predicate', name: 'extra', instructions: 'Is it?' }] },
    { ...fixed, promptCacheKey: 'thread-1' }, { ...fixed, safetyIdentifier: 'user-1' }, null, undefined, 'warm-up',
  ]) await assert.rejects(gated.decide(bad), e => e.code === 'evidence_unavailable', JSON.stringify(bad)?.slice(0, 60))
  assert.equal(lookups, 0, 'refused before any key lookup')
  await assert.rejects(createEgressGate({}).guardContentFree(client, 'anything_else').decide(fixed), e => e.code === 'evidence_unavailable')
  // the data classes have no say: a gate with every class open and a gate with none treat it alike
  assert.equal(Object.keys(EGRESS_KINDS).includes('warmup'), false, 'not a data kind: no model permission opens it, and none is needed')
  // the allowed body does reach the client (and only then a key lookup)
  await assert.rejects(gated.decide(fixed), e => e.code === 'unreachable')
  assert.equal(lookups, 1)
  // the warm-up object itself is built on the gated client: a client of the wrong shape is refused up front
  assert.throws(() => createDecisionWarmup({ client: {}, activity: w.activity }), TypeError)
  assert.throws(() => createDecisionWarmup({ client: w.client, activity: {} }), TypeError)
})

test('the request is content-free: nothing of any run, person or page is in it; the registry lists the file', () => {
  const body = JSON.stringify({ input: CONTENT_FREE_REQUESTS.warmup.input, questions: CONTENT_FREE_REQUESTS.warmup.questions })
  assert.equal(body, '{"input":"EG-Desk warm-up","questions":[{"type":"predicate","name":"warmup_check","instructions":"Is the input a warm-up message?"}]}')
  assert.ok(body.length < 160)
  assert.deepEqual(Object.keys(EGRESS_SITES).filter(f => f === 'egdesk-decision-warmup.mjs'), ['egdesk-decision-warmup.mjs'])
  assert.match(EGRESS_SITES['egdesk-decision-warmup.mjs'][0], /^content-free:/)
  const src = fs.readFileSync(path.join(path.dirname(new URL(import.meta.url).pathname), 'egdesk-decision-warmup.mjs'), 'utf8')
  assert.equal((src.match(/\.decide\(/g) || []).length, 1, 'one call site, on the gated client')
  assert.match(src, /gated\.decide\(/)
})

test('a turn: by default it never waits (joinMs 0) but starts the warm-up and counts a turn miss; with joinMs it waits for the landing, never longer', async () => {
  const w = world()
  assert.equal(w.warmup.beforeTurn(), null)
  await w.warmup.settled()
  let s = w.warmup.stats()
  assert.deepEqual([s.sent, s.turnMisses, s.byReason], [1, 1, { turn: 1 }])
  // joinMs: wait for the landing
  const fast = world({ joinMs: 500 })
  const joined = fast.warmup.beforeTurn()
  assert.ok(joined && typeof joined.then === 'function')
  const started = Date.now()
  await joined
  assert.ok(Date.now() - started < 400, 'resolved when the warm-up landed, not at joinMs')
  assert.equal(fast.warmup.stats().landed, 1)
  // a warm-up that does not land in time ends the wait at joinMs
  const hang = createDecisionActivity()
  const client = createDecisionClient({ getApiKey: () => KEY, fetchImpl: hang.wrap(() => new Promise(() => {})) })
  const slow = createDecisionWarmup({ client, activity: hang, mode: () => 'on', decisionsMode: () => 'on', hasKey: () => true, joinMs: 40, timeoutMs: 200 })
  const t0 = Date.now()
  await slow.beforeTurn()
  const waited = Date.now() - t0
  assert.ok(waited >= 30 && waited < 150, `waited ${waited} ms: the join ended at joinMs`)
  // joinMs above the cap is capped
  assert.equal(WARMUP_MAX_JOIN_MS, 1500)
  // nothing to wait for (recent traffic): null at once
  const busy = world({ joinMs: 500 })
  await busy.real()
  assert.equal(busy.warmup.beforeTurn(), null)
  s = busy.warmup.stats()
  assert.equal(s.sent, 0)
})

test('cost per idle period: warm-ups, tokens, lead, wasted warm-ups; never more than one warm-up in a period', async () => {
  const w = world()
  // period 1: the person types, the warm-up lands (300 ms), the real request follows 8 s later
  w.warmup.trigger('composer'); await w.warmup.settled()
  w.clock.t += 8_000
  await w.real('first question')
  w.clock.t += 20_000
  await w.real('second question')          // same period: traffic is recent, no warm-up
  assert.equal(w.warmup.trigger('composer').why, 'recent_traffic')
  // period 2: idle 6 minutes, the person types, a warm-up is sent, and nothing follows
  w.clock.t += 6 * MIN
  w.warmup.trigger('composer'); await w.warmup.settled()
  // period 3: idle again, the real request comes with no warm-up in front (the composer never signalled)
  w.clock.t += 7 * MIN
  await w.real('third question')
  const periods = w.warmup.periods()
  assert.equal(periods.length, 3)
  assert.deepEqual(periods.map(p => [p.warmups, p.realRequests, p.wasted]), [[1, 2, false], [1, 0, true], [0, 1, false]])
  assert.equal(periods[0].leadMs, 8_000, 'from the end of the warm-up to the start of the real request')
  assert.deepEqual([periods[0].warmupMs, periods[0].firstRealMs, periods[0].warmupStatus], [300, 300, 200])
  assert.equal(periods[0].idleBeforeMs, null); assert.ok(periods[1].idleBeforeMs >= 6 * MIN); assert.ok(periods[2].idleBeforeMs >= 7 * MIN)
  const s = w.warmup.stats()
  assert.deepEqual([s.periods, s.periodsWithWarmup, s.wastedPeriods, s.warmupsPerPeriodMax, s.sent, s.landed, s.inputTokens, s.inputTokensPerWarmup], [3, 2, 1, 1, 2, 2, 180, 90])
  // the record holds times, counts and closed words: no text of any request
  const text = JSON.stringify(s)
  assert.ok(!/question|EG-Desk|authorization|sk-proj/.test(text), text.slice(0, 200))
})

test('the bounded history: only the most recent periods are kept', async () => {
  const w = world()
  for (let i = 0; i < 60; i++) { await w.real(`q${i}`); w.clock.t += 6 * MIN }
  assert.equal(w.activity.periods().length, 50)
})

test('/decision/warmup: only the closed word, a closed reply, 404 when not wired, and the status carries the counts', async () => {
  const mk = (method, url, body) => {
    const req = Readable.from(body === undefined ? [] : [Buffer.from(JSON.stringify(body))]); req.method = method; req.url = url
    req.headers = { host: '127.0.0.1:39218', ...(body === undefined ? {} : { 'content-type': 'application/json' }) }; req.socket = { remoteAddress: '127.0.0.1' }
    return req
  }
  const run = async (handler, method, url, body) => { const res = { status: null, body: '', writeHead(s) { this.status = s }, end(b) { this.body = b ?? '' } }; const handled = await handler(mk(method, url, body), res, new URL(url, 'http://127.0.0.1:39218')); return { handled, status: res.status, data: res.body ? JSON.parse(res.body) : null } }
  const store = { getApiKey: () => KEY, status: 'memory', hint: () => '…WWWW', savedAt: () => 1, writable: true }
  const w = world()
  const handler = createDecisionHttpHandler({ store, verifyKey: async () => ({ status: 'verified' }), warmup: w.warmup, model: 'm' })
  let r = await run(handler, 'POST', '/decision/warmup', { reason: 'composer' })
  assert.deepEqual([r.handled, r.status, r.data], [true, 200, { action: 'sent' }])
  await w.warmup.settled()
  r = await run(handler, 'POST', '/decision/warmup', { reason: 'composer' })
  assert.deepEqual(r.data, { action: 'skipped', why: 'recent_traffic' })
  for (const body of [{ reason: 'turn' }, { reason: 'keystroke', text: 'secret draft' }, {}, { reason: 5 }]) {
    r = await run(handler, 'POST', '/decision/warmup', body)
    assert.equal(r.status, 400); assert.equal(r.data.code, 'DECISION_WARMUP_REASON'); assert.ok(!JSON.stringify(r.data).includes('secret'))
  }
  assert.equal((await run(handler, 'GET', '/decision/warmup')).status, 405)
  const status = await run(handler, 'GET', '/decision/status')
  assert.equal(status.data.warmup.sent, 1); assert.equal(status.data.warmup.mode, 'on')
  const plain = createDecisionHttpHandler({ store, verifyKey: async () => ({}), model: 'm' })
  assert.equal((await run(plain, 'POST', '/decision/warmup', { reason: 'composer' })).status, 404)
  assert.equal('warmup' in (await run(plain, 'GET', '/decision/status')).data, false)
})

test('overlay half: only a non-off pref, only with text in the composer, at most once a minute, a closed body, never throws', async () => {
  let t = 1_000_000
  const posts = []
  let mode = 'off'
  const c = createComposerWarmup({ mode: () => mode, post: (p, b) => { posts.push([p, b]); return Promise.reject(new Error('down')) }, now: () => t })
  assert.equal(c.note(true), false); assert.equal(posts.length, 0)
  assert.deepEqual(['on', 'advisory', 'off', undefined, 'yes'].map(decisionWarmupMode), ['on', 'advisory', 'off', 'off', 'off'])
  mode = 'on'
  assert.equal(c.note(false), false); assert.equal(c.note(), true, 'default hasText true'); assert.equal(c.note(true), false)
  assert.deepEqual(posts, [['/decision/warmup', { reason: 'composer' }]])
  t += DECISION_WARMUP_LIMITS.minGapMs - 1; assert.equal(c.note(true), false)
  t += 1; assert.equal(c.note(true), true); assert.equal(posts.length, 2)
  const throwing = createComposerWarmup({ mode: () => { throw new Error('x') }, post: () => { throw new Error('y') } })
  assert.equal(throwing.note(true), false)
  const syncThrow = createComposerWarmup({ mode: () => 'on', post: () => { throw new Error('y') } })
  assert.equal(syncThrow.note(true), false)
  await new Promise(resolve => setImmediate(resolve))
})

test('the chat runtime tells the warm-up before a turn asks, only when Decisions is on, and a failing hook never breaks the turn', async () => {
  const calls = []
  const make = warmup => ({
    decisionContext: { client: {}, collect: async () => { calls.push('collect'); return [] }, mode: () => 'on', configured: () => true, warmup },
    turnContextBudget: () => 40, keepLateFlag: () => false, pruneHeldFlag: () => false, directSpeech: () => null, directEvidenceReader: () => null,
    turnPosition: () => ({ reason: 'live_thread' }), topicIntakes: new WeakMap(), previousReplyFor: () => null, now: () => Date.now(),
  })
  const call = stub => CodexChatRuntime.prototype.prepareDecisionContext.call(stub, { message: 'hi' }, {})
  await call(make({ beforeTurn: () => { calls.push('beforeTurn'); return null } }))
  assert.deepEqual(calls.slice(0, 2), ['beforeTurn', 'collect'])
  calls.length = 0
  let release
  await call(make({ beforeTurn: () => { calls.push('beforeTurn'); return new Promise(resolve => { release = resolve; setTimeout(resolve, 30) }) } }))
  assert.deepEqual(calls.slice(0, 2), ['beforeTurn', 'collect'], 'a returned promise is awaited before the turn asks')
  calls.length = 0
  await call(make({ beforeTurn: () => { throw new Error('boom') } }))
  assert.ok(calls.includes('collect'), 'a throwing hook is ignored')
  calls.length = 0
  await call(make(undefined))
  assert.ok(calls.includes('collect'), 'no warm-up wired (flag off): as before')
  // Decisions off: the hook is not even called
  calls.length = 0
  const off = make({ beforeTurn: () => { calls.push('beforeTurn'); return null } }); off.decisionContext.mode = () => 'off'
  assert.equal(await call(off), null)
  assert.deepEqual(calls, [])
})

test('wiring: the flag is read in one place, the default is off, and with the flag off the client keeps the transport itself as its fetch', () => {
  const dir = path.dirname(new URL(import.meta.url).pathname)
  const bridge = fs.readFileSync(path.join(dir, 'codex-bridge-server.mjs'), 'utf8')
  assert.match(bridge, /warmupConfigFromEnv\(process\.env\)/)
  assert.match(bridge, /decisionWarmupConfig\.mode === 'off' \? null : createDecisionActivity/)
  assert.match(bridge, /fetchImpl: decisionActivity \? decisionActivity\.wrap\(decisionTransport\.fetch\) : decisionTransport\.fetch/)
  assert.match(bridge, /\.\.\.\(decisionWarmup \? \{ warmup: decisionWarmup \} : \{\}\)/)
  assert.match(bridge, /warmup: decisionWarmup, onSettingsChanged/)
  const surface = fs.readFileSync(path.join(dir, '..', 'overlay', 'JS', 'eg-desk-surface.uc.js'), 'utf8')
  assert.match(surface, /document\.addEventListener\('input', ev => \{\s*const target = ev\.target;\s*if \(target\?\.dataset\?\.testid === 'chat-composer'\) composerWarmup\.note\(/)
  assert.equal((surface.match(/composerWarmup\.note\(/g) || []).length, 1, 'the composer\'s own input handler is untouched')
  assert.equal((surface.match(/importESModule\('chrome:\/\/userchrome\/content\/EGDeskDecisionWarmup\.sys\.mjs'\)/g) || []).length, 1)
  assert.equal(warmupMode(undefined), 'off')
})
