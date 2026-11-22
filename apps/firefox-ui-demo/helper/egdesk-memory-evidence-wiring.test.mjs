// Integration test: immutable source pins through the actual decision/turn/transcript path.
// Real: CodexChatRuntime.send, turn/start params, ImmutableContextStore captures, MemoryEvidenceStore, chat SQLite, reopen.
// Synthetic: answer provider (uses supplied evidence), fixture classification, transport and profiles. The production topic cases run the real Decisions client. No network/CLI/accounts.
import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import os from 'node:os'
import path from 'node:path'
import { mkdtemp, rm, chmod, readdir, readFile } from 'node:fs/promises'
import { ImmutableContextStore } from './egdesk-context-store.mjs'
import { MemoryEvidenceStore } from './egdesk-memory-evidence.mjs'
import { CodexChatRuntime } from './codex-chat-runtime.mjs'
import { openChatStore } from './egdesk-chat-store.mjs'
import { createDecisionClient, DecisionError } from './egdesk-decision-client.mjs'
import { choiceQuestion, predicateQuestion, readChoice } from './egdesk-decision-questions.mjs'
import { collectDecisionCandidates } from './egdesk-decision-candidates.mjs'

const OWNER = 'codex:synthetic:qa', AGENT = 'sol', DM = 'dm-1'
const profiles = { runProfile: (profileId, revision) => ({ binding: { profileId, revision: revision ?? 1, hash: `hash-${profileId}` }, developerInstructions: `You are ${profileId}`, toolCeiling: null, model: null }) }

// ---- synthetic JSONL fixtures (the numbers live ONLY in these captured lines) ----
const fixtures = ({ count = 30, out = 2, through = '10:00' } = {}) => ({
  'ledger.jsonl': ['{"note":"header"}', `LEDGER item=A qty=${count} at=09:00`, '{"secret":"SENSITIVE_NEIGHBOR_TOKEN"}'],
  'count.jsonl': ['{"note":"stocktake"}', `COUNT item=A qty=${count} at=09:00`, '{"secret":"SENSITIVE_NEIGHBOR_TOKEN"}'],
  'copy.jsonl': [`COPY item=A qty=${count} at=09:05`], // a copy of the ledger: must never be bound
  'post.jsonl': ['{"note":"goods-out"}', `POST item=A delta=-${out} at=09:35`, '{"secret":"SENSITIVE_NEIGHBOR_TOKEN"}'],
  'cover.jsonl': ['{"note":"coverage"}', `COVER from=09:00 through=${through}`, '{"secret":"SENSITIVE_NEIGHBOR_TOKEN"}'],
})
const hhmm = s => { const [h, m] = s.split(':').map(Number); return `${h}시${m ? ` ${m}분` : ''}` }
// Provider: derive quantity from evidence lines + relations. Fails closed (NO_QUANTITY) on anything missing/unauthorised.
function derive(packet, style) {
  const line = packet.split('\n').find(l => l.startsWith('{')); if (!line) return { text: '알 수 없어요.', fields: null }
  let ev; try { ev = JSON.parse(line) } catch { return { text: '알 수 없어요.', fields: null } }
  const by = rel => (ev.sources || []).filter(s => s.relation === rel).map(s => s.text)
  const counted = by('counted').join('\n').match(/COUNT item=A qty=(\d+) at=(\d\d:\d\d)/)
  const posted = [...by('posted').join('\n').matchAll(/POST item=A delta=(-?\d+) at=(\d\d:\d\d)/g)]
  const cover = by('coverage').join('\n').match(/COVER from=(\d\d:\d\d) through=(\d\d:\d\d)/)
  if (!counted || !cover || !posted.length || cover[1] > counted[2] || cover[2] < '10:00' || posted.some(p => p[2] < counted[2] || p[2] > cover[2])) return { text: '알 수 없어요.', fields: ev }
  const out = -posted.reduce((n, p) => n + Number(p[1]), 0), q = Number(counted[1]) - out
  return { fields: ev, text: style === 'direct' ? `지금 ${q}개예요.` : `${hhmm(counted[2])} 실사에서 ${counted[1]}개였고, 이후 ${out}개가 출고됐어요.` }
}

async function newWorld(t, { count, out } = {}) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'egdesk-memev-qa-')); await chmod(dir, 0o700)
  const w = { dir, requestN: 0, clock: 1_000_000, turns: [], collected: [], events: [], legacy: [], decisionInputs: [], errors: [], threads: 0, turnN: 0, hooks: {}, mode: 'on', conv: {}, handles: {}, fx: fixtures({ count, out }) }
  const boot = () => {
    w.captures = new ImmutableContextStore({ dataDir: path.join(dir, 'state'), allowedRoots: [dir], now: () => w.clock })
    w.evidence = new MemoryEvidenceStore({ dataDir: path.join(dir, 'state'), captures: w.captures, now: () => w.clock })
    w.store = openChatStore({ dataDir: path.join(dir, 'chat'), ownerScope: 'synthetic-memev-qa' })
    const chat = new CodexChatRuntime({
      now: () => w.clock, store: w.store, requireStore: true, getOwnerKey: () => OWNER, profiles, resolveProjectWorkspace: async () => null,
      request: async (method, params) => {
        await w.hooks.onNative?.(method)
        if (method === 'thread/start') return { thread: { id: `thread-${++w.threads}` }, cwd: '/work', model: 'synthetic' }
        if (method === 'thread/resume') return { thread: { id: params.threadId, turns: w.hooks.restoreTurns || [] }, cwd: '/work' }
        if (method === 'config/read') return { config: { developer_instructions: null } }
        if (method === 'thread/unsubscribe') return { status: 'unsubscribed' }
        if (method === 'turn/interrupt') return {}
        if (method !== 'turn/start') throw new Error(`Unexpected method: ${method}`)
        const id = `turn-${++w.turnN}`
        const style = /왜/.test(JSON.stringify(params.input)) ? 'reason' : 'direct'
        const packet = params.additionalContext?.egdesk_decision_context?.value || ''
        const { text, fields } = w.hooks.reply?.(packet, style) ?? derive(packet, style)
        const terminal = w.hooks.nativeTerminal ?? 'completed'
        w.turns.push({ params, packet, fields, text })
        const timing = { threadId: params.threadId, turnId: id }
        if (w.hooks.manualAnswer) { w.fixtureRun = timing; return { turn: { id, status: 'inProgress', items: [] } } }
        setTimeout(async () => {
          const n = (m, p) => chat.handleNotification({ method: m, params: p })
          await n('item/started', { ...timing, item: { id: `w${id}`, type: 'agentMessage', phase: 'commentary', text: '' } })
          await n('item/completed', { ...timing, item: { id: `w${id}`, type: 'agentMessage', phase: 'commentary', text: `NATIVE_WORK_NOTE ${id}` } })
          if (terminal !== 'completed') {
            await n('turn/completed', { threadId: params.threadId, turn: { id, status: terminal, items: [] } })
            return
          }
          await n('item/started', { ...timing, item: { id: `a${id}`, type: 'agentMessage', phase: 'final_answer', text: '' } })
          await n('item/agentMessage/delta', { ...timing, itemId: `a${id}`, delta: text })
          await n('item/completed', { ...timing, item: { id: `a${id}`, type: 'agentMessage', phase: 'final_answer', text } })
          await n('turn/completed', { threadId: params.threadId, turn: { id, status: 'completed', items: [] } })
        }, 5)
        return { turn: { id, status: 'inProgress', items: [] } }
      },
      respond: () => {}, emit: e => w.events.push(e), emitLegacy: e => w.legacy.push(e), verifyFile: async () => null,
      decisionContext: { mode: () => w.mode, configured: () => true, budgetMs: 5000, memoryEvidence: w.evidence,
        topicRecipient: () => w.hooks.topicRecipient?.() ?? null,
        client: { model: 'synthetic-decision', async decide(request) {
          w.decisionInputs.push(JSON.stringify(request.input)); await w.hooks.duringDecide?.(request)
          if (w.hooks.resolveDecision) return w.hooks.resolveDecision(request)
          if (w.hooks.hasHistoryStage?.()) return w.hooks.resolveHistory(request)
          const answers = {}
          for (const q of request.questions) answers[q.name] = w.hooks.choice?.(q, request) ?? (q.type === 'choice'
            ? { type: 'choice', choice: q.name === 'time_intent' ? 'present' : 'answer', confidence: 0.95, probabilities: [{ value: q.name === 'time_intent' ? 'present' : 'answer', probability: 0.95 }] }
            : { type: 'predicate', probability: 0.02 }) // relevance never selects: only the explicit (mandatory) handle can attach
          return { answers, model: 'synthetic-decision', usage: { inputTokens: 1 }, latencyMs: 1 }
        } },
        collect: async ({ body, context, memoryEvidenceFor, speech }) => {
          const list = (await collectDecisionCandidates({ body, clientThreadId: context.clientThreadId, excludeMessageId: context.localMessageId, chatStore: w.store, memoryEvidenceFor, speech })).candidates
          w.collected.push({ message: body.message, ids: list.map(c => c.id), texts: list.map(c => `${c.title}|${c.summary}`) }); return w.hooks.stageHistory ? w.hooks.stageHistory({ list, speech, body, context }) : list
        } },
    })
    chat.setConnection(true); w.chat = chat
  }
  boot()
  w.restart = () => { w.store.close(); w.evidence.close(); boot() }
  w.scope = (thread = DM, agentId = AGENT) => ({ ownerKey: OWNER, agentId, clientThreadId: thread })
  w.capture = async (name, lines = w.fx[name]) => {
    const m = await w.captures.capture(OWNER, DM, { id: name, kind: 'browser', label: name, sourceRef: { viewId: 'v', resourceId: name, url: `https://example.invalid/${name}` }, capturedAt: 10,
      captureScope: { type: 'dom-range', locator: '#x' }, content: { mime: 'text/plain', text: lines.join('\n'), truncated: false } })
    return { sourceId: m.sourceId, revision: m.revision }
  }
  // Binds only the authorised lines (line 2 of each capture), never the copy or neighbouring sensitive line.
  w.bindStandard = async ({ thread = DM, agentId = AGENT, expiresAt, discovery, caps = null } = {}) => {
    const c = caps || { ledger: await w.capture('ledger.jsonl'), count: await w.capture('count.jsonl'), post: await w.capture('post.jsonl'), cover: await w.capture('cover.jsonl') }
    const r = (x, relation) => ({ ...(relation ? { relation } : {}), sourceId: x.sourceId, revision: x.revision, startLine: 2, endLine: 2 })
    const handle = await w.evidence.bind(w.scope(thread, agentId), { ...(discovery ? { discovery } : {}), ledger: r(c.ledger), sources: [r(c.count, 'counted'), r(c.post, 'posted'), r(c.cover, 'coverage')], ...(expiresAt != null ? { expiresAt } : {}) })
    return { handle, caps: c }
  }
  w.ask = async (message, handle, { thread = DM, direct = true, profile = true, body = {} } = {}) => {
    const count = () => { try { return w.store.listMessages(thread).messages.filter(m => m.role === 'assistant').length } catch { return 0 } }
    const before = w.turns.length, rows = count()
    let r; try { r = await w.chat.send({ message, clientThreadId: thread, requestId: `r-${++w.requestN}`,
      ...(w.conv[thread] ? { conversationId: w.conv[thread] } : {}), ...(profile ? { profileId: AGENT } : {}), ...(direct ? { replyDestination: 'direct' } : {}),
      ...(handle ? { selectedSources: [{ id: handle, label: 'UNTRUSTED_LABEL', kind: 'memory-evidence' }] } : {}), ...body }) } catch (e) { w.errors.push(e.code || e.message); return { packet: '', fields: null, params: {}, none: true, error: e.code || e.message } }
    w.conv[thread] ||= r.conversationId
    const complete = () => w.hooks.nativeTerminal
      ? w.store.getLatestRun(thread)?.status === w.hooks.nativeTerminal : count() > rows
    for (let i = 0; i < 400 && !(w.turns.length > before && complete()); i++) await new Promise(r => setTimeout(r, 10))
    await new Promise(r => setTimeout(r, 30))
    return w.turns.length > before ? w.turns.at(-1) : { packet: '', fields: null, params: {}, none: true }
  }
  w.rows = (thread = DM) => { try { return w.store.listMessages(thread).messages.map(m => [m.role, m.text]) } catch { return [] /* thread never created (send refused) */ } }
  t.after(async () => { try { w.store.close() } catch {} try { w.evidence.close() } catch {} await rm(dir, { recursive: true, force: true }) })
  return w
}

const LEAK = /UNTRUSTED_LABEL|memrow:|SENSITIVE|NATIVE_WORK|catalogHash|egdesk_decision_context|COUNT item|POST item|COVER from|LEDGER item|"relation"|receipt/
const assertPublicClean = (w, thread = DM) => {
  for (const [, text] of w.rows(thread)) assert.doesNotMatch(text, LEAK)
  assert.doesNotMatch(JSON.stringify(w.events.filter(e => String(e.event).startsWith('message.'))), LEAK)
}
// Deny means no FRESH PINNED evidence: a generic decision packet with authorised prior public messages is allowed.
const PINNED = /COUNT item=A|POST item=A|COVER from|LEDGER item=A|"relation"/
const hasPinned = turn => !!turn.fields && PINNED.test(turn.packet)
const noPinned = turn => { assert.doesNotMatch(turn.packet, PINNED); assert.ok(!turn.fields?.ledger && !turn.fields?.sources); assert.doesNotMatch(turn.packet, /UNTRUSTED_LABEL|memrow:|SENSITIVE/) }
const noEvidence = noPinned

for (const [count, out] of [[30, 2], [37, 4], [44, 6]]) {
  test(`positive ${count}-${out}=${count - out}: exact quantity then Korean why from pinned source lines, authorised lines only`, async t => {
    const w = await newWorld(t, { count, out }), q = count - out
    const { handle } = await w.bindStandard()
    assert.match(handle, /^memrow:/)
    const a = await w.ask('지금 몇 개야?', handle), b = await w.ask(`왜 ${q}개야?`, handle)
    assert.deepEqual(w.rows(), [['user', '지금 몇 개야?'], ['assistant', `지금 ${q}개예요.`], ['user', `왜 ${q}개야?`], ['assistant', `9시 실사에서 ${count}개였고, 이후 ${out}개가 출고됐어요.`]])
    for (const x of [a, b]) {
      assert.equal(x.params.additionalContext.egdesk_decision_context.kind, 'application')
      assert.equal(x.fields.version, 1); assert.deepEqual(x.fields.sources.map(s => s.relation), ['counted', 'posted', 'coverage'])
      assert.doesNotMatch(x.packet, /SENSITIVE_NEIGHBOR_TOKEN|COPY item|UNTRUSTED_LABEL|header|stocktake/)
      assert.ok(!/"(quantity|answer|basis)"/.test(x.packet), 'no computed number or answer in packet')
      assert.ok(x.packet.includes(`qty=${count}`) && x.packet.includes(`delta=-${out}`))
    }
    assert.ok(!w.decisionInputs.join('\n').match(/UNTRUSTED_LABEL|memrow:/), 'label/handle never reach the decision model catalog')
    assert.ok(!w.collected.at(-1).texts.join('\n').match(/NATIVE_WORK|UNTRUSTED_LABEL/))
    assert.ok(!w.collected.at(-1).ids.some(i => i.startsWith('message:') || i === 'conversation:recent'), 'a file grant does not opt in to speech')
    assertPublicClean(w)
  })
}

test('restart: reopened capture + evidence + chat stores serve the same handle; turn 2 sees persisted public exchange only', async t => {
  const w = await newWorld(t, { count: 37, out: 4 }); const { handle } = await w.bindStandard()
  await w.ask('지금 몇 개야?', handle); w.restart()
  const b = await w.ask('왜 33개야?', handle)
  assert.equal(w.rows().at(-1)[1], '9시 실사에서 37개였고, 이후 4개가 출고됐어요.'); assert.ok(b.fields)
  assert.ok(!w.collected.at(-1).texts.join('\n').match(/NATIVE_WORK|왜 33개야/)); assertPublicClean(w)
})

test('version pinned: a later capture with the same UI filename never replaces the bound revision until a new bind', async t => {
  const w = await newWorld(t, { count: 30, out: 2 }); const { handle, caps } = await w.bindStandard()
  await w.ask('지금 몇 개야?', handle)
  const newer = await w.capture('count.jsonl', ['{"note":"stocktake"}', 'COUNT item=A qty=99 at=09:00', '{"secret":"SENSITIVE_NEIGHBOR_TOKEN"}'])
  assert.notEqual(newer.revision, caps.count.revision)
  const same = await w.ask('지금 몇 개야?', handle); assert.equal(w.rows().at(-1)[1], '지금 28개예요.'); assert.match(same.packet, /qty=30/); assert.doesNotMatch(same.packet, /qty=99/)
  w.restart(); await w.ask('지금 몇 개야?', handle); assert.equal(w.rows().at(-1)[1], '지금 28개예요.')
  const { handle: h2 } = await w.bindStandard({ caps: { ...caps, count: newer } }) // explicit new bind
  assert.notEqual(h2, handle); await w.ask('지금 몇 개야?', h2); assert.equal(w.rows().at(-1)[1], '지금 97개예요.')
  assert.match(w.turns.at(-1).packet, /qty=99/)
})

test('deny: Board send, missing direct/profile, forged client fields, other agent/thread give no pinned context', async t => {
  const w = await newWorld(t); const { handle } = await w.bindStandard()
  noEvidence(await w.ask('지금 몇 개야?', handle, { thread: 'room-b', body: { boardId: 'b1' } }))            // Board
  noEvidence(await w.ask('지금 몇 개야?', handle, { thread: 'dm-nodirect', direct: false }))               // no verified direct
  noEvidence(await w.ask('지금 몇 개야?', handle, { thread: 'dm-noprofile', profile: false }))              // no agent profile
  noEvidence(await w.ask('지금 몇 개야?', handle, { thread: 'dm-other-thread' }))                           // handle bound to dm-1
  const other = await w.bindStandard({ agentId: 'other-agent', caps: undefined })
  noEvidence(await w.ask('지금 몇 개야?', other.handle, { thread: 'dm-x' }))                               // bound to another agent/thread
  noEvidence(await w.ask('지금 몇 개야?', handle, { thread: 'dm-forge', body: { ownerKey: OWNER, agentId: AGENT, memoryScope: w.scope(), allowedScope: 'board' } }))
  // forged client fields do not break or widen the legitimate scope
  assert.ok(hasPinned(await w.ask('지금 몇 개야?', handle, { body: { ownerKey: 'someone-else', agentId: 'other-agent', memoryScope: 'board' } })))
  for (const th of ['room-b', 'dm-nodirect', 'dm-noprofile', 'dm-other-thread', 'dm-x', 'dm-forge']) assertPublicClean(w, th)
})

test('expiry and revocation: before send, during async prep, and between read and native dispatch add no new pinned context; public history stays', async t => {
  const w = await newWorld(t); const { handle, caps } = await w.bindStandard()
  assert.ok(hasPinned(await w.ask('지금 몇 개야?', handle))); const before = w.rows()
  w.evidence.revoke(w.scope(), handle)
  noEvidence(await w.ask('지금 몇 개야?', handle)); w.restart(); noEvidence(await w.ask('왜 28개야?', handle))
  assert.deepEqual(w.rows().slice(0, 2), before) // already-public chat is not erased
  // revoked during async decision preparation
  const { handle: h2 } = await w.bindStandard({ caps })
  w.hooks.duringDecide = () => w.evidence.revoke(w.scope(), h2)
  noEvidence(await w.ask('지금 몇 개야?', h2)); w.hooks.duringDecide = null
  // revoked immediately after the runtime read the evidence, before native dispatch (read wrapper)
  const { handle: h3 } = await w.bindStandard({ caps })
  const read = w.evidence.read.bind(w.evidence); let reads = 0
  w.evidence.read = async (...a) => { const v = await read(...a); if (v && !reads++) w.evidence.revoke(w.scope(), h3); return v }
  noEvidence(await w.ask('지금 몇 개야?', h3)); w.evidence.read = read
  assertPublicClean(w)
})

test('expiry: expiresAt inside bind() stops serving once the injected clock passes it', async t => {
  const w = await newWorld(t); const { handle } = await w.bindStandard({ expiresAt: w.clock + 1000 })
  assert.ok(hasPinned(await w.ask('지금 몇 개야?', handle)))
  w.clock += 5000; noPinned(await w.ask('지금 몇 개야?', handle)); assertPublicClean(w)
})

test('durable files: pinned evidence text, handle and sensitive neighbour never land in the chat SQLite file or public events', async t => {
  const w = await newWorld(t); const { handle } = await w.bindStandard(); await w.ask('지금 몇 개야?', handle); await w.ask('왜 28개야?', handle)
  w.store.close(); let raw = ''
  for (const f of await readdir(path.join(w.dir, 'chat'))) raw += (await readFile(path.join(w.dir, 'chat', f))).toString('latin1')
  assert.doesNotMatch(raw, /SENSITIVE_NEIGHBOR_TOKEN|COUNT item=A|POST item=A|COVER from|egdesk_decision_context/)
  assert.ok(!raw.includes(handle)); assert.doesNotMatch(raw, /UNTRUSTED_LABEL/)
  assert.doesNotMatch(JSON.stringify(w.events.filter(e => String(e.event).startsWith('message.'))), /memrow:|SENSITIVE/)
  w.store = openChatStore({ dataDir: path.join(w.dir, 'chat'), ownerScope: 'synthetic-memev-qa' })
})

test('identity + selection: direct identity comes from the verified profile/stored conversation agent; only the user-selected handle attaches', async t => {
  const w = await newWorld(t, { count: 30, out: 2 })
  const a = await w.bindStandard(), b = await w.bindStandard({ caps: { ...a.caps, count: await w.capture('count.jsonl', ['{"note":"s"}', 'COUNT item=A qty=77 at=09:00', 'x']) } })
  // bound but not selected: nothing attaches
  noPinned(await w.ask('지금 몇 개야?', null))
  assert.equal(w.store.getConversation(DM)?.agent?.profileId, AGENT, 'stored conversation agent is the verified direct identity')
  // two bound handles, only one selected: only that row's lines reach the model
  const t2 = await w.ask('지금 몇 개야?', a.handle); assert.match(t2.packet, /COUNT item=A qty=30/); assert.doesNotMatch(t2.packet, /qty=77/)
  const t3 = await w.ask('지금 몇 개야?', b.handle); assert.match(t3.packet, /COUNT item=A qty=77/); assert.doesNotMatch(t3.packet, /COUNT item=A qty=30/)
  // Native history can retain old inputs: do not even resume it as another Agent.
  const before = w.turns.length
  const foreign = await w.ask('지금 몇 개야?', a.handle, { body: { profileId: 'other-agent' } })
  assert.equal(foreign.error, 'NATIVE_AUDIENCE_LOCKED'); assert.equal(w.turns.length, before)
  assert.equal(w.store.getConversation(DM)?.agent?.profileId, AGENT)
  assert.ok(hasPinned(await w.ask('지금 몇 개야?', a.handle)))
  assertPublicClean(w)
})

test('genuine late revoke after assembly: revoked inside native thread/start or thread/resume, before turn/start, dispatches no pinned evidence', async t => {
  const w = await newWorld(t, { count: 30, out: 2 }); const { handle, caps } = await w.bindStandard()
  // new thread: revoke when the runtime calls thread/start (prep + assembly already done)
  let fired = []; w.hooks.onNative = m => { if (m === 'thread/start') { fired.push(m); w.evidence.revoke(w.scope(), handle) } }
  const a = await w.ask('지금 몇 개야?', handle); noPinned(a); assert.deepEqual(fired, ['thread/start'])
  w.hooks.onNative = null
  // continued thread after restart: revoke when the runtime calls thread/resume
  const h2 = (await w.bindStandard({ caps })).handle; w.restart(); fired = []
  w.hooks.onNative = m => { if (m === 'thread/resume') { fired.push(m); w.evidence.revoke(w.scope(), h2) } }
  const b = await w.ask('지금 몇 개야?', h2); noPinned(b)
  assert.ok(fired.length > 0); assert.ok(!a.none && !b.none); assert.deepEqual(w.errors, [])
  w.hooks.onNative = null
  // control: same flow with no revoke serves pinned evidence
  const h3 = (await w.bindStandard({ caps })).handle; assert.ok(hasPinned(await w.ask('지금 몇 개야?', h3)))
  assertPublicClean(w)
})

test('mode off: no decision request, no resolver read; advisory: decision runs but no pinned evidence is attached', async t => {
  const w = await newWorld(t, { count: 30, out: 2 }); const { handle } = await w.bindStandard()
  w.mode = 'off'; const off = await w.ask('지금 몇 개야?', handle)
  assert.equal(w.decisionInputs.length, 0); noPinned(off); assert.equal(off.params.additionalContext?.egdesk_decision_context, undefined)
  w.mode = 'advisory'; const noCatalog = await w.ask('지금 몇 개야?', handle)
  assert.equal(w.decisionInputs.length, 0, 'unconsented transcript is not an advisory catalog'); noPinned(noCatalog)
  const adv = await w.ask('지금 몇 개야?', handle, {body:{attachments:[{id:'public',label:'선택한 문서'}]}})
  assert.ok(w.decisionInputs.length > 0); noPinned(adv); assert.equal(adv.params.additionalContext?.egdesk_decision_context, undefined)
  assert.doesNotMatch(w.decisionInputs.join('\n'), PINNED)
  w.mode = 'on'; assert.ok(hasPinned(await w.ask('지금 몇 개야?', handle)), 'same handle still valid when mode returns to on')
  assertPublicClean(w)
})

test('the actual Board send planner and lead dispatch do not resolve a DM source selection', async t => {
  const { boardSendPlan } = await import('../overlay/resources/EGDeskBoardThread.sys.mjs')
  const w = await newWorld(t); const { handle } = await w.bindStandard(); const seen = []
  const original = w.evidence.isActive.bind(w.evidence)
  w.evidence.isActive = (...args) => { seen.push(true); return original(...args) }
  const room = { id: 'public-board', type: 'group', participants: ['나', '솔빛', '물결'],
    participantAgents: { 솔빛: { profileId: 'sol' }, 물결: { profileId: 'water' } }, profileEnabled: true, agentProfileId: 'sol', messages: [] }
  const plan = boardSendPlan(room, { clientThreadId: room.id, message: '@솔빛 지금 몇 개야?', requestId: 'board-1',
    profileEnabled: true, profileId: 'sol', engineId: 'codex', selectedSources: [{ id: handle, kind: 'memory-evidence', label: 'UNTRUSTED_LABEL' }] })
  assert.equal(plan.body.expectedBoardDelivery.route, 'board'); assert.equal(plan.body.selectedSources[0].id, handle)
  const delivery = await w.chat.sendBoard(plan.body); assert.deepEqual(delivery.recipients.map(r => r.status), ['started'])
  assert.equal(w.turns.length, 1); noPinned(w.turns[0]); assert.deepEqual(seen, [])
  assert.match(w.turns[0].params.additionalContext.egdesk_channel.value, /shared Board/)
  for (let i = 0; i < 300 && !w.rows(room.id).some(([role]) => role === 'assistant'); i++) await new Promise(r => setTimeout(r, 5))
  assert.equal(w.rows(room.id).length, 2); assertPublicClean(w, room.id)
})

test('implicit retrieval: the same verified DM asks without any selected source, reopens the DB and cites only its preceding public answer', async t => {
  const w = await newWorld(t)
  await w.ask('안녕하세요', null)
  const hints = { clientThreadId: DM, conversationId: w.conv[DM], expectedProfileId: AGENT }
  const authority = w.chat.memoryDmAuthority(hints); assert.deepEqual(authority.scope, w.scope()); authority.assertCurrent()
  assert.throws(() => w.chat.memoryDmAuthority({ ...hints, expectedProfileId: 'other' }))
  assert.throws(() => w.chat.memoryDmAuthority({ ...hints, clientThreadId: 'not-the-DM' }))
  const { handle } = await w.bindStandard({ discovery: { label: 'A창고 재고', terms: ['재고','몇 개'] } })
  const a = await w.ask('지금 재고는 몇 개야?', null)
  assert.equal(a.text, '지금 28개예요.'); assert.ok(hasPinned(a)); assert.doesNotMatch(w.decisionInputs.join('\n'), /A창고 재고|memrow:|COUNT item/)
  w.restart(); const b = await w.ask('왜 28개야?', null)
  assert.equal(b.text, '9시 실사에서 30개였고, 이후 2개가 출고됐어요.'); assert.deepEqual(a.fields, b.fields)
  assert.equal(w.chat.memoryDmAuthority(hints).recentEvidence()?.id, handle)
  noPinned(await w.ask('점심 메뉴 알려줘', null)); assert.equal(w.chat.memoryDmAuthority(hints).recentEvidence(), null)
  noPinned(await w.ask('왜?', null))
  assert.ok(w.evidence.revoke(w.scope(), handle)); w.restart(); const c = await w.ask('지금 재고는 몇 개야?', null)
  assert.ok(!c.none); noPinned(c); assertPublicClean(w)
})

test('automatic match never chooses between two equally matching rows and is not a fallback for a different explicit selection', async t => {
  const w = await newWorld(t); const d = { label: '창고 재고', terms: ['재고'] }
  const a = await w.bindStandard({ discovery: d }); const b = await w.bindStandard({ discovery: { ...d, label: '다른 창고' }, caps: a.caps })
  noPinned(await w.ask('재고는?', null)); w.evidence.revoke(w.scope(), b.handle)
  assert.ok(hasPinned(await w.ask('재고는?', null)))
  noPinned(await w.ask('재고는?', b.handle)); assertPublicClean(w)
})

const recorded = packet => packet.split('\n').filter(l => l.startsWith('{')).map(l => JSON.parse(l)).find(p => p.kind === 'speech-record')?.utterances || []
const speechChoice = (q, req) => {
  if (q.type === 'predicate' && /^rel_/.test(q.name)) return {type:'predicate', probability:/[?？]/u.test(req.input.at(-1).content) ? 0.97 : 0.01}
  const m = /^speech_(source|form|time)_(\d+)$/.exec(q.name); if (!m) return null
  const now = req.input.at(-1).content.split('Message:\n').at(-1), n = Number(m[2]); let parts
  if (now.includes('열렸다고 했어.')) parts = n === 0 ? ['attributed_report','assertion','past_unspecified'] : ['unspecified','plan','future_anchored']
  else if (now.includes('직접 봤어.')) parts = ['self_reported_observation','assertion','past_anchored']
  else if (now.includes('추정이야.')) parts = ['inference','assertion','unknown']
  else parts = ['unknown','question','unknown']
  const pick = parts[['source','form','time'].indexOf(m[1])]; assert.ok(q.choices.some(c => c.value === pick))
  return { type:'choice', choice:pick, confidence:0.97, probabilities:[{value:pick,probability:0.97},{value:pick === 'unknown'?'unused':'unknown',probability:0.02}] }
}
for (const name of ['민지','하늘']) test(`everyday DM: ${name}'s report and a plan stay two claims; the event clock is not the chat clock`, async t => {
  const w = await newWorld(t); w.clock = Date.UTC(2026,10,17,3); w.hooks.choice = speechChoice
  await w.ask('PRECONSENT_CANARY: 이전에 나온 말.'); const grant=w.evidence.enableSpeech(w.scope()); assert.ok(grant)
  const says = `${name}가 다리가 열렸다고 했어. 내일 직접 확인할 예정이야.`, question='직접 봤다는 거야?'
  w.hooks.reply = packet => {const r = recorded(packet).find(x => x.role==='user' && x.interpretations.some(i => i.source==='attributed_report'))
    const speaker = r?.quote.match(/^(.+?)가 /u)?.[1]; return {text:speaker && r.interpretations.some(i=>i.form==='plan') ? `${speaker}가 열렸다고 했고, 직접 확인은 그다음 날 예정이었어요.` : '직접 확인한 근거는 없어요.',fields:null} }
  const stem = await w.ask(says); assert.doesNotMatch(stem.packet,/PRECONSENT_CANARY/)
  const firstRefs=w.evidence.recentSpeech(w.scope(),grant); assert.deepEqual(firstRefs.map(x=>x.role),['user','assistant'])
  w.clock+=86400000*2; w.restart(); const reply = await w.ask(question)
  const rows=recorded(reply.packet), u=rows.find(x=>x.role==='user'); assert.equal(u.quote,says); assert.equal(u.spokenAt,'2026-11-17T03:00:00.000Z'); assert.equal(u.verification,'utterance-only')
  assert.equal(reply.text,`${name}가 열렸다고 했고, 직접 확인은 그다음 날 예정이었어요.`)
  assert.deepEqual(u.interpretations.map(i=>[u.quote.slice(i.start,i.end),i.source,i.form,i.time]),[[`${name}가 다리가 열렸다고 했어.`,'attributed_report','assertion','past_unspecified'],['내일 직접 확인할 예정이야.','unspecified','plan','future_anchored']]); assert.match(reply.packet,/2026-11-19T03:00:00.000Z/)
  assert.deepEqual(rows.map(x=>x.role),['user','assistant']);assert.deepEqual(rows[1].interpretations,[]);assert.doesNotMatch(reply.packet,/PRECONSENT|NATIVE_WORK/)
  assert.doesNotMatch(w.decisionInputs.at(-1), /다리가 열렸다고|직접 확인할 예정|직접 확인한 근거는/)
  assert.doesNotMatch(JSON.stringify(w.rows().map(x=>x[1])),/speech-record|speech_source_|attributed_report|utterance-only/)
  assert.ok(w.evidence.disableSpeech(w.scope(),grant)); w.restart(); const no = await w.ask(question); assert.deepEqual(recorded(no.packet),[]); assert.equal(no.text,'직접 확인한 근거는 없어요.')
  const next = w.evidence.enableSpeech(w.scope()); assert.notEqual(grant,next);assert.deepEqual(w.evidence.recentSpeech(w.scope(),next),[])
  const fresh = await w.ask('지금 무슨 말을 기억해?'); assert.doesNotMatch(fresh.packet,/PRECONSENT|다리가 열렸다고|직접 확인할 예정/)
})

test('everyday DM opt-in excludes plans as facts, assistant echo as a witness, mismatched Agent or thread, off, advisory, and a late revoke or rotated generation', async t => {
  const w=await newWorld(t); w.hooks.choice=speechChoice; await w.ask('인사.'); const g=w.evidence.enableSpeech(w.scope());
  await w.ask('어제 새 표지판을 직접 봤어.'); await w.ask('원인은 추정이야.'); const r=await w.ask('방금 확인한 건가?');
  const rows=recorded(r.packet); assert.equal(rows.find(x=>x.quote.includes('표지판')).interpretations[0].source,'self_reported_observation');assert.equal(rows.find(x=>x.quote.includes('추정')).interpretations[0].source,'inference');assert.ok(rows.filter(x=>x.role==='assistant').every(x=>x.verification==='utterance-only' && !x.interpretations.length));
  const other=await w.ask('표지판은?',null,{thread:'other-dm'}); assert.deepEqual(recorded(other.packet),[])
  const otherAgent=await w.ask('표지판은?',null,{body:{profileId:'other'}}); assert.ok(otherAgent.error); assert.deepEqual(recorded(otherAgent.packet),[])
  const board=await w.ask('표지판은?',null,{thread:'other-room',direct:false,body:{boardId:'b1'}}); assert.deepEqual(recorded(board.packet),[])
  for (const mode of ['off','advisory']) { w.mode=mode; const no=await w.ask('이전 말은?'); assert.deepEqual(recorded(no.packet),[]);assert.doesNotMatch(no.packet,/표지판|원인은 추정/); }
  w.mode='on'; let rotated=false; w.hooks.duringDecide=()=>{if (!rotated) {rotated=true;assert.ok(w.evidence.disableSpeech(w.scope(),g));w.evidence.enableSpeech(w.scope())}};
  const late=await w.ask('다시 볼래?'); assert.ok(rotated);assert.deepEqual(recorded(late.packet),[]);assert.doesNotMatch(late.packet,/표지판|원인은 추정/)
})


test('scoped speech GAP: Korean speech consent separates Decisions wire and native context', async t => {
  const w = await newWorld(t)
  const pre = '동의 전에는 종이배를 접었어.'
  const prior = '민지가 파란 이름표를 놓았다고 했어. 내일 화분을 살펴볼 예정이야.'
  const reply = '파란 이름표는 민지에게 들은 말이고, 화분 확인은 계획이에요.'
  const ask = '방금 말한 내용을 다시 알려 줄래?'
  const missing = '이전 발언이 첨부되지 않았어요.'
  const title = '화분 관리표', summary = '창가 화분 점검 기준', body = '화분 점검표는 금요일에 갱신해요.'
  const wires = []
  let beforeResponse = null
  // Deterministic in-process Decisions answer adapter. No native engine or network.
  const installAdapter = () => {
    w.chat.decisionContext.client = createDecisionClient({
      endpoint: 'https://synthetic-offline.invalid/v1/decisions', model: 'synthetic-in-process',
      getApiKey: () => 'synthetic-not-a-real-key',
      fetchImpl: async (_url, init) => {
        const request = JSON.parse(init.body)
        wires.push({ raw: init.body, request })
        const recall = request.input.at(-1).content === 'Message:\n' + ask
        const labels = recall ? { source: ['unknown'], form: ['question'], time: ['unknown'] }
          : { source: ['attributed_report', 'unspecified'], form: ['assertion', 'plan'], time: ['past_unspecified', 'future_anchored'] }
        const answers = request.questions.map(q => {
          const { name, type } = q
          if (type === 'predicate') return { name, type, probability: name === 'rel_0' || (name === 'rel_recall' && recall) ? 0.99 : 0.01 }
          const axis = /^speech_(source|form|time)_(\d+)$/.exec(name)
          const choice = axis ? labels[axis[1]][Number(axis[2])] : name === 'answer_type' ? 'answer' : 'not_time_specific'
          return { name, type, choice, confidence: 0.99, probabilities: [
            { value: choice, probability: 0.99 }, { value: q.choices.find(c => c.value !== choice).value, probability: 0.01 },
          ] }
        })
        return { ok: true, status: 200, text: async () => {
          beforeResponse?.()
          return JSON.stringify({ model: 'synthetic-in-process', answers })
        } }
      },
    })
  }
  installAdapter()
  assert.equal(w.evidence.speechGrant(w.scope()), null)
  assert.ok(!(await w.ask(pre)).none)
  // An ordinary authorized item ensures advisory has a packet it could install.
  let ordinaryLoads = 0
  w.hooks.stageHistory = ({ list }) => [...list, { id: 'fixture:plant', kind: 'document', title, summary, loadText: () => { ordinaryLoads++; return body } }]
  const contextOnlyReply = packet => ({ text: recorded(packet).find(x => x.quote === prior)?.quote || missing, fields: null })
  const base = ['answer_type', 'time_intent', 'rel_0']
  const labels0 = ['speech_source_0', 'speech_form_0', 'speech_time_0']
  const recallNames = [...base, ...labels0, 'rel_recall']
  const assertWire = ({ raw, request }, message, names) => {
    assert.deepEqual(request.questions.map(q => q.name), names)
    assert.equal(request.input.length, 3, 'rules, ordinary catalog, and only the current message')
    assert.deepEqual(request.input[2], { role: 'user', content: 'Message:\n' + message })
    for (const sent of [title, summary]) assert.ok(raw.includes(sent), sent)
    for (const withheld of [pre, reply, body, 'conversation:recent', '이 DM에서 허용한 최근 발언']) assert.ok(!raw.includes(withheld), withheld)
    for (const span of prior.split('. ').map(s => s.replace(/\.$/, ''))) {
      assert.equal(raw.includes(span), message === prior, 'neither prior span can carry over to another message')
    }
  }
  const exercise = async (mode, names) => {
    w.mode = mode; w.hooks.reply = contextOnlyReply
    const before = wires.length, loads = ordinaryLoads
    const turn = await w.ask(ask)
    assert.equal(ordinaryLoads - loads, mode === 'off' ? 0 : 1, 'advisory assembles ordinary context without installing it')
    assert.ok(!turn.none)
    assert.equal(wires.length - before, names ? 1 : 0)
    const wire = wires[before]
    if (names) assertWire(wire, ask, names)
    return { turn, wire }
  }
  const plain = await exercise('on', base)
  assert.ok(plain.turn.params.additionalContext?.egdesk_decision_context?.value.includes(body))
  assert.deepEqual(recorded(plain.turn.packet), [])
  assert.doesNotMatch(plain.turn.packet, /fallible semantic labels/)

  const grant = w.evidence.enableSpeech(w.scope())
  assert.ok(grant)
  const seed = async generation => {
    w.hooks.reply = () => ({ text: reply, fields: null })
    const before = wires.length
    const turn = await w.ask(prior)
    assert.ok(!turn.none)
    assert.equal(wires.length - before, 1)
    assertWire(wires[before], prior, [...base, ...labels0, 'speech_source_1', 'speech_form_1', 'speech_time_1', 'rel_recall'])
    assert.deepEqual(recorded(turn.packet), [])
    assert.deepEqual(w.evidence.recentSpeech(w.scope(), generation).map(r => r.role), ['user', 'assistant'])
  }
  await seed(grant)
  for (const [mode, names] of [['off', null], ['advisory', base]]) {
    const { turn, wire } = await exercise(mode, names)
    assert.equal(w.evidence.speechGrant(w.scope()), grant, 'an active grant does not override the mode')
    assert.equal(turn.params.additionalContext?.egdesk_decision_context, undefined)
    if (wire) assert.equal(wire.raw, plain.wire.raw, 'advisory cannot observe the now-populated private history')
  }
  const allowed = await exercise('on', recallNames)
  assert.ok(allowed.turn.packet.includes(body))
  assert.match(allowed.turn.packet, /fallible semantic labels by UTF-16 offsets/)
  const rows = recorded(allowed.turn.packet)
  assert.deepEqual(rows.map(r => [r.role, r.quote, r.verification]), [['user', prior, 'utterance-only'], ['assistant', reply, 'utterance-only']])
  assert.deepEqual(rows[0].interpretations.map(i => [i.source, i.form, i.time]), [['attributed_report', 'assertion', 'past_unspecified'], ['unspecified', 'plan', 'future_anchored']])
  assert.deepEqual(rows[1].interpretations, [])
  assert.ok(!allowed.turn.packet.includes(pre))
  assert.equal(allowed.turn.text, prior, 'the in-process reply uses installed speech, not native session history')

  let rotated = null
  beforeResponse = () => { if (w.evidence.disableSpeech(w.scope(), grant)) rotated = w.evidence.enableSpeech(w.scope()) }
  const during = await exercise('on', recallNames)
  beforeResponse = null
  assert.ok(rotated && rotated !== grant)
  assert.equal(during.wire.raw, allowed.wire.raw)
  assert.ok(during.turn.packet.includes(body))
  assert.doesNotMatch(during.turn.packet, /fallible semantic labels/)
  assert.deepEqual(recorded(during.turn.packet), [])
  assert.equal(during.turn.text, missing)

  await seed(rotated)
  w.restart(); installAdapter()
  let revoked = false
  const beforeResume = wires.length
  w.hooks.onNative = method => {
    if (!revoked && method === 'thread/resume' && wires.length > beforeResume) revoked = w.evidence.disableSpeech(w.scope(), rotated)
  }
  const late = await exercise('on', recallNames)
  assert.equal(revoked, true)
  assert.equal(late.wire.raw, allowed.wire.raw)
  assert.equal(late.turn.params.additionalContext?.egdesk_decision_context, undefined, 'post-assembly revocation drops the guarded packet')
  assert.equal(late.turn.text, missing)
  assert.deepEqual(w.errors, [])
})

// Historical prototype installed in the harness ONLY. The separately tested
// production topic path below does not use this file selector or the fixture's picker.
// Real components: chat send + final ingestion + reopen, scoped original speech, immutable
// file grants, decision wire encoder/decoder, private-packet dispatch fence. All text, the
// separate egress grant and the semantic endpoint are synthetic. No external transport.
const returnQuestion = '리더 이야기로 돌아가자. 확정한 구역의 검토 수는?'
const pick = (name, instructions, vals) => choiceQuestion(name, instructions, vals.map(value => ({ value })))
const chosenAnswer = (q, value) => ({ type: 'choice', name: q.name, choice: value, confidence: .96, probabilities: [{ value, probability: .96 }] })
const questionWire = r => ({ input: r.input, questions: r.questions, cache: r.promptCacheKey ?? null })
// Pair by exact persisted event seq and accepted request/native run, not adjacent rows.
function eligiblePairs(w, dm, utterances) {
  const pairs = new Map(), completed = w.store.listRuns(dm, { limit: 100 }).runs.filter(r => r.status === 'completed') // bounded fixture
  for (const u of utterances) {
    const e = w.store.listEvents(dm, { afterSeq: u.sequence - 1, limit: 1 }).events[0]
    if (!e || e.seq !== u.sequence || !e.requestId) continue
    const outcome = w.store.getRequest({ clientThreadId: dm, requestId: e.requestId })?.outcome
    if (!outcome?.accepted || !completed.some(r => r.runId === outcome.runId && r.localRunId === outcome.localRunId)) continue
    const p = pairs.get(e.requestId) || {}; if (p[u.role]) p.invalid = true
    p[u.role] = u; pairs.set(e.requestId, p)
  }
  return [...pairs.values()].filter(p => !p.invalid && p.user && p.assistant && p.user.sequence < p.assistant.sequence)
    .sort((a,b) => a.user.sequence - b.user.sequence)
    .map((p,i) => ({ key: `p${i+1}`, user: p.user.quote, final: p.assistant.quote }))
}
// The same fake semantic service sees only the actual serialized request in each case.
// No gold routes/dependency list, answer quantities, world state or fixture variant go in.
// A narrow Korean grammar intentionally replaces a model; this cannot measure model quality.
function evaluateTopicWire(body) {
  const catalog = body.input[1].content[0].data
  const history = body.input.slice(2,-1); const rows = catalog.pairs.map((key,i) => ({ key, u: history[i*2].content[0].text, a: history[i*2+1].content[0].text }))
  const goal = rows.find(r => r.u.includes('점검 대상을 정하자'))
  const correction = rows.find(r => /^정정: (첫|두) 번째 안/u.test(r.u))
  const labels = goal?.a.match(/후보 순서: (\S+), (\S+)$/u)?.slice(1)
  const label = labels && correction ? labels[correction.u.startsWith('정정: 첫') ? 0 : 1] : null
  const doc = catalog.docs.find(d => d.label === label), resolved = /리더|점검/.test(body.input.at(-1).content) && !!doc && !!goal && !!correction
  return body.questions.map(q => {
    if (q.name === 'route') return chosenAnswer(q, resolved ? goal.key : '미상')
    if (q.name === 'doc') return chosenAnswer(q, resolved ? doc.key : '미상')
    if (q.name.startsWith('need_')) return { type: 'predicate', name:q.name, probability: resolved && [goal.key,correction.key].includes(q.name.slice(5)) ? .98 : .01 }
    if (q.type === 'predicate') return { type:'predicate', name:q.name, probability:.95 }
    const v = q.choices.find(x=>x.value==='unknown')?.value ?? q.choices[0].value
    return chosenAnswer(q,v)
  })
}
function installTopicProbe(w, scope, expectedGeneration, state) {
  let pairs=[], docs=[], selected=null, open, frame, current=null
  w.hooks.hasHistoryStage = () => pairs.length > 0
  const same = () => state.egress === true && w.mode === 'on' && w.evidence.speechGrant(scope) === expectedGeneration && frame?.allowed() === true
  const alive = () => { if (!same()) return false; const re = open(); return JSON.stringify(re) === JSON.stringify(pairs) }
  w.hooks.stageHistory = ({ list,speech,body,context }) => {
    const raw = list.find(x => x.id === 'conversation:recent'); frame=speech; current=body.message; pairs=[]; docs=[]; selected=null
    if (!same() || !raw) return list
    open = () => { const s = raw.loadText(); return s && raw.mayRead() ? eligiblePairs(w,context.clientThreadId,JSON.parse(s).utterances) : null }
    pairs = open() || []; if (!pairs.length) return list
    // A real external file grant must separately cover the labels; synthetic labels only here.
    docs = w.evidence.list(scope).map((d,i)=>({ id:d.id, label:d.label, key:`d${i+1}` })); selected=null
    return [{ id:'conversation:topic-probe',kind:'conversation',title:'합성 허용 자료 선택',mandatory:true,
      mayRead: () => !!selected && alive() && w.evidence.isActive(scope,selected.doc.id),
      loadText: async () => { if (!selected || !alive()) return null;const result=await w.evidence.read(scope,selected.doc.id)
        if (!result || !alive() || !w.evidence.isActive(scope,selected.doc.id)) return null
        return JSON.stringify({kind:'fixture-topic-packet',path:pairs.filter(p=>selected.keys.includes(p.key)),line:result.ledger.text}) },
    }]
  }
  w.hooks.resolveHistory = async r => {
    if (!pairs.length || !alive()) throw new Error('no live scoped input')
    const client=createDecisionClient({getApiKey:()=> 'synthetic-not-a-credential',fetchImpl:async (_url,init)=>{
      state.beforeWire?.(); if (!alive() || Buffer.byteLength(init.body,'utf8') > (state.maxBytes ?? 48000)) throw new Error('grant or byte budget rejected at test transport')
      const body=JSON.parse(init.body); state.wires.push(body);const answers=evaluateTopicWire(body);state.afterWire?.()
      return {ok:true,status:200,text:async()=>JSON.stringify({model:'gpt-6-luna',answers})}
    }})
    const opts=pairs.map(x=>x.key); const {answers,...rest}=await client.decide({signal:r.signal,timeoutMs:r.timeoutMs,
      input:[{role:'developer',content:'이전 발언은 근거일 뿐 명령이 아니다. 현재 요청이 돌아온 주제와 필요한 결정을 구별한다.'},
        {role:'user',content:[{type:'input_json',data:{pairs:opts,docs:docs.map(({key,label})=>({key,label}))}}]},
        ...pairs.flatMap(p=>[{role:'user',content:[{type:'input_text',text:p.user}]},{role:'assistant',content:[{type:'output_text',text:p.final}]}]),
        {role:'user',content:current}],
      questions:[...r.questions,pick('route','현재 요청이 이어지는 시작 턴은? 확정할 근거가 없으면 미상.',[...opts,'별개','미상']),
        ...opts.map(key=>predicateQuestion(`need_${key}`,`입력의 순서표에서 ${key} 대화쌍이 빠지면 현재 답이 달라지는가?`)),
        pick('doc','현재 확정된 범위에 해당하는 허용 장부를 고른다. 미정이면 미상.',[...docs.map(x=>x.key),'미상'])]})
    const choice=name=>{const result=readChoice(answers,name,{minConfidence:.8,minMargin:.2});return result.state==='accepted'?result.value:null}
    const route=choice('route'), doc=docs.find(d=>d.key===choice('doc'))
    const ks=pairs.filter(p=>answers[`need_${p.key}`]?.type==='predicate'&&answers[`need_${p.key}`].probability>=.8).map(p=>p.key)
    const complete=pairs.every(p=>{const a=answers[`need_${p.key}`];return a?.type==='predicate'&&(a.probability>=.8||a.probability<=.2)})
    if (alive()&&complete&&doc&&ks.includes(route)) selected={keys:ks,doc}
    return {answers,...rest}
  }
}
async function sourceWorld(t, {order='가람, 누리', correction='두 번째', sideFirst=false}={}) {
  const w=await newWorld(t);w.hooks.choice=speechChoice;await w.ask('PRECONSENT_TOPIC_IGNORE');const g=w.evidence.enableSpeech(w.scope());assert.ok(g)
  const send=async(u,a)=>{w.hooks.reply=()=>({text:a,fields:null});await w.ask(u)}
  const side=()=>send('표지 색은 따로 고르자.','표지 제목에 가람과 누리를 모두 쓴다.')
  if(sideFirst)await side(); await send('자료 리더의 점검 대상을 정하자.',`후보 순서: ${order}`)
  await send(correction?`정정: ${correction} 안으로만 진행하자.`:'두 안 중 어느 쪽인지는 아직 정하지 말자.','범위에 관한 말을 접수했어요.')
  if(!sideFirst) await side(); w.restart()
  for(const [name,num] of (sideFirst?[['누리',43],['가람',17]]:[['가람',17],['누리',43]])) {
    const c=await w.capture(`fixture-${name}`,['header',`CHECKED=${num}`,'DO_NOT_SEND_NEIGHBOR']);const p={...c,startLine:2,endLine:2}
    const audit=await w.capture(`audit-${name}`,['audit',`REVIEW_LOG=${num}`]);
    assert.ok(await w.evidence.bind(w.scope(),{discovery:{label:name,terms:['nevermatchfixture']},ledger:p,sources:[{...audit,startLine:2,endLine:2,relation:'counted'}]}))
  }
  return {w,g}
}
const extractTopic = packet => packet.split('\n').filter(x=>x.startsWith('{')).map(x=>JSON.parse(x)).find(x=>x.kind==='fixture-topic-packet')

test('ordinary DM: opposing corrections do not change the history-blind Decisions payload; only the answering engine sees the quotes', async t=>{
  const shapes=[],packets=[]
  for(const correction of ['첫 번째','두 번째']) {const {w}=await sourceWorld(t,{correction});w.hooks.duringDecide=r=>shapes.push(questionWire(r)); w.hooks.reply=()=>({text:'접수했어요.',fields:null});const a=await w.ask(returnQuestion);packets.push(recorded(a.packet))}
  assert.equal(shapes.length,2);assert.deepEqual(shapes[0],shapes[1]);assert.doesNotMatch(JSON.stringify(shapes),/후보 순서|안으로만|표지 색|CHECKED=|PRECONSENT/)
  assert.ok(packets[0].some(x=>x.quote.includes('첫 번째 안')));assert.ok(packets[1].some(x=>x.quote.includes('두 번째 안')))
})
for(const [name,config,expected] of [
  ['first',{correction:'첫 번째'},17],['second',{correction:'두 번째'},43],
  ['reordered pairs, labels, documents',{order:'누리, 가람',sideFirst:true,correction:'두 번째'},17],
  ['abstain',{correction:null},null],['different current ask',{question:'지난번 표지 색을 다시 볼까?'},null],
  ['no history transfer consent',{},null],['byte limit',{},null],['revoked before network',{},null],['rotated after request',{},null],
]) test(`opt-in prototype on actual DM dispatch: ${name}`,async t=>{
  const {w,g}=await sourceWorld(t,config),s={egress:name!=='no history transfer consent',wires:[],maxBytes:name==='byte limit'?10:48000}; const rotate=()=>{assert.ok(w.evidence.disableSpeech(w.scope(),g));assert.notEqual(w.evidence.enableSpeech(w.scope()),g)}
  if(name==='revoked before network')s.beforeWire=rotate;if(name==='rotated after request')s.afterWire=rotate
  installTopicProbe(w,w.scope(),g,s);w.hooks.reply=packet=>{const p=extractTopic(packet),v=p?.line.match(/^CHECKED=(\d+)$/)?.[1];return {text:v?`${v}건입니다.`:'범위가 확인되지 않았어요.',fields:null}}
  const question=config.question ?? returnQuestion
  const a=await w.ask(question);assert.ok(!a.none);assert.equal(s.wires.length,['revoked before network','byte limit','no history transfer consent'].includes(name)?0:1)
  for(const body of s.wires){assert.equal(body.input.at(-1).content,question);assert.equal(body.questions.filter(q=>q.name.startsWith('need_')).length,3);assert.doesNotMatch(JSON.stringify(body),/CHECKED=|DO_NOT_SEND|memrow:|PRECONSENT|NATIVE_WORK/)}
  assert.equal(a.text,expected?`${expected}건입니다.`:'범위가 확인되지 않았어요.');assert.equal(w.rows().at(-1)[1],a.text)
  const p=extractTopic(a.packet);if(expected){assert.equal(p.path.length,2);assert.match(p.path[0].user,/점검 대상/);assert.match(p.path[1].user,/^정정/);assert.doesNotMatch(a.packet,/표지 색|DO_NOT_SEND|PRECONSENT/)} else assert.equal(p,undefined)
})

// Production topic wiring, deliberately separate from the prototype above. The
// test transport sees the request produced by send(); it never builds a graph,
// calls append/commit, modifies candidates, or receives the fixture variant.
const TOPIC_RECIPIENT = 'a3'.repeat(32)
const OTHER_RECIPIENT = 'c7'.repeat(32)
const PRE_TOPIC = 'PRECONSENT_LIVE_TOPIC: 비공개 이전 대화'
const FAILED_TOPIC = 'FAILED_LIVE_TOPIC: 중단된 요청'
const OUTSIDE_TOPIC = 'OTHER_DM_LIVE_TOPIC: 참고하지 말아야 할 다른 대화'
const LIVE_ROOT = ['서가 목록부터 만들자.', '서가 1은 17권이고 서가 2는 43권이에요.']
const LIVE_CHILD = ['서가에서 대여 계산을 별도로 다루자.', '대여 한도는 전체 권수의 절반을 버림해요.']
const LIVE_SIBLING = ['서가에서 표지 전시를 별도로 다루자.', '전시용 표지에는 99권이라고 적어요.']
const LIVE_RETURN = '대여 계산으로 돌아가자. 적용된 규칙대로 몇 권까지 빌릴 수 있어?'
const LIVE_FOLLOW = '대여 계산의 지난 답을 다시 확인해 줘.'
const LIVE_NOTE = /PRECONSENT_LIVE_TOPIC|FAILED_LIVE_TOPIC|OTHER_DM_LIVE_TOPIC|NATIVE_WORK_NOTE/
const LIVE_META = /topic_route|topic_need_\d+|egdesk_decision_context|session_topic_(?:evidence|graph)|omittedPairs|"recipient"/
const CORRECTION = /^정정: 서가 (1|2)만 이용할 수 있어\.$/u
const decisionNames = body => body.questions.filter(q => /^topic_(?:route|need_\d+)$/u.test(q.name)).map(q => q.name)
const textOfDecisionMessage = m => typeof m.content === 'string' ? m.content : m.content.map(x => x.text || '').join('')
function topicWireHistory(body) {
  const graphAt = body.input.findIndex(m => m.role === 'user' && Array.isArray(m.content) &&
    m.content.some(x => x.type === 'input_json' && Array.isArray(x.data?.pairs)))
  if (graphAt < 0) return null
  const graph = body.input[graphAt].content.find(x => x.type === 'input_json' && Array.isArray(x.data?.pairs)).data
  const quoted = body.input.slice(graphAt + 1, -1)
  return { graph, quoted, pairs: graph.pairs.map((row, i) => ({ ...row,
    u: textOfDecisionMessage(quoted[2 * i]), a: textOfDecisionMessage(quoted[2 * i + 1]),
  })) }
}
function decideLiveTopic(body) {
  const history = topicWireHistory(body)
  const current = body.input.at(-1).content.replace(/^Message:\n/u, '')
  const find = matcher => history?.pairs.find(p => matcher.test(p.u))
  const root = find(/^서가 목록부터 만들자\./u), branch = find(/^서가에서 대여 계산을/u)
  const correction = find(CORRECTION)
  const split = /^서가에서 .+ 별도로 다루자\.$/u.test(current)
  const back = /^대여 계산으로 돌아가자\./u.test(current)
  const follow = /^대여 계산의 지난 답을/u.test(current)
  const needed = follow ? find(/^대여 계산으로 돌아가자\./u) : back ? correction : null
  const route = split && root ? `split_${root.alias}` : (back || follow) && branch ? `continue_${branch.alias}` : 'separate'
  return body.questions.map(q => {
    if (q.name === 'topic_route') return chosenAnswer(q, route)
    const need = /^topic_need_(\d+)$/u.exec(q.name)
    // Model identifies only the independent correction, not ancestry, from the
    // input. Production must supply the routed pair and close over its ancestry.
    if (need) return { type:'predicate', name:q.name,
      probability:needed && history.pairs[Number(need[1])]?.alias === needed.alias ? .98 : .02 }
    if (q.type === 'predicate') return { type:'predicate', name:q.name, probability:.02 }
    return chosenAnswer(q, q.name === 'time_intent' ? 'present' : 'answer')
  })
}
async function liveTopicWorld(t) {
  const w = await newWorld(t)
  w.liveAttempts = []; w.liveWires = []; w.recipient = TOPIC_RECIPIENT; w.transportRecipient = TOPIC_RECIPIENT
  w.hooks.topicRecipient = () => w.recipient
  w.hooks.resolveDecision = async request => {
    const gated = typeof request.authorizeDispatch === 'function'
    const attempt = { body:null, gated, allowed:!gated }; w.liveAttempts.push(attempt)
    // Real request validation, bearer-key selection, last-moment guard, JSON wire,
    // response decoder and budget boundary. Only the transport and model are synthetic.
    const client = createDecisionClient({ model:'synthetic-decision', getApiKey:() => 'fixture-not-a-real-api-key',
      recipientForKey:() => w.transportRecipient, fetchImpl:async (_endpoint, init) => {
        const body = JSON.parse(init.body); attempt.body = body; w.liveWires.push(body)
        const answers = decideLiveTopic(body)
        const response = await w.hooks.topicResponse?.({ body, answers }) ?? { answers, model:'synthetic-decision' }
        return { ok:true, status:200, text:async () => JSON.stringify(response) }
      } })
    return client.decide({ ...request, ...(gated ? { authorizeDispatch:fp => (attempt.allowed = request.authorizeDispatch(fp) === true) } : {}) })
  }
  return w
}
const topicState = w => w.evidence.topicState(w.scope())
function topicEnable(w) {
  w.evidence.enableTopic(w.scope(), w.conv[DM], w.recipient, w.store.topicBoundary(DM))
  const s = topicState(w)
  assert.ok(s?.generation); assert.equal(s.recipient, w.recipient)
  assert.equal(s.conversationId, w.conv[DM]); assert.deepEqual(s.turns, [])
  return s
}
async function topicSay(w, [user, assistant], options) {
  w.hooks.reply = () => ({ text:assistant, fields:null })
  return w.ask(user, null, options)
}
function assertTopicDecision(w, before, message, priorPairs) {
  const attempts = w.liveAttempts.slice(before)
  assert.equal(attempts.length, 1, 'one Decision request, not a separate history/routing call')
  const [{ body, gated, allowed }] = attempts
  assert.ok(gated && allowed, 'live synthetic recipient authorizes actual request dispatch')
  assert.ok(w.liveWires.includes(body))
  assert.deepEqual(body.input.at(-1), { role:'user', content:`Message:\n${message}` })
  const { graph, quoted, pairs } = topicWireHistory(body)
  const aliases = priorPairs.map((_, i) => `p${i}`)
  assert.equal(graph.kind, 'session_topic_graph'); assert.equal(graph.complete, true); assert.equal(graph.omittedPairs, 0)
  assert.deepEqual(pairs.map(p => p.alias), aliases)
  assert.deepEqual(pairs.map(p => [p.u, p.a]), priorPairs, 'each prior authorized pair is exact and complete')
  assert.deepEqual(quoted.map(m => m.role), priorPairs.flatMap(() => ['user', 'assistant']))
  assert.deepEqual(decisionNames(body), ['topic_route', ...aliases.map((_, i) => `topic_need_${i}`)])
  const serialized = JSON.stringify(body)
  assert.doesNotMatch(JSON.stringify({ ...body, input:body.input.slice(0, -1) }), LIVE_NOTE)
  return { graph, serialized, choices:body.questions.find(q => q.name === 'topic_route').choices.map(q => q.value) }
}
function assertTopicAppend(w, before, pair) {
  const state = topicState(w)
  assert.equal(state.generation, before.generation)
  assert.equal(state.revision, before.revision + 1)
  assert.deepEqual(state.turns.slice(0, -1), before.turns)
  assert.equal(state.turns.length, before.turns.length + 1)
  const row = state.turns.at(-1)
  assert.ok(row.key && !before.turns.some(r => r.key === row.key))
  const eventAt = seq => w.store.listEvents(DM, { afterSeq:seq - 1, limit:1 }).events.find(e => e.seq === seq)
  const messages = w.store.listMessages(DM).messages
  for (const [role, text] of [['user', pair[0]], ['assistant', pair[1]]]) {
    const ref = row[role], accepted = eventAt(ref.seq)
    assert.equal(accepted?.event, role === 'user' ? 'message.accepted' : 'message.completed')
    assert.equal(accepted.localMessageId, ref.localMessageId)
    assert.equal(messages.find(m => m.localMessageId === ref.localMessageId)?.text, text)
    assert.equal(ref.hash, createHash('sha256').update(text).digest('hex'))
  }
  assert.ok(row.user.seq < row.assistant.seq)
  assert.equal(eventAt(row.user.seq).requestId, eventAt(row.assistant.seq).requestId)
  return row
}
const parsePacketObjects = packet => packet.split('\n').filter(line => line.startsWith('{')).map(line => JSON.parse(line))
const liveEvidence = packet => parsePacketObjects(packet).find(p => p.kind === 'session_topic_evidence')
// Only packet text drives the synthetic answer, not native session state, the
// prior correction setting, a fallback answer keyed by the test, or fixture docs.
function replyToLiveTopic(packet) {
  const s = JSON.stringify(liveEvidence(packet)?.path ?? [])
  const shelf = /정정: 서가 ([12])만 이용할 수 있어\./u.exec(s)?.[1]
  const totals = /서가 1은 (\d+)권이고 서가 2는 (\d+)권이에요\./u.exec(s)
  const rule = s.includes(LIVE_CHILD[1])
  const n = shelf && totals && rule ? Math.floor(Number(totals[shelf]) / 2) : null
  return { text:n === null ? '대여 한도를 알 수 없어요.' : `${n}권까지 빌릴 수 있어요.`, fields:null }
}
const assertLivePublic = w => {
  // Pre-consent utterances remain in the original local transcript. They must
  // never be copied into answer text, a private packet, or public metadata.
  const texts = w.rows().filter(([role]) => role === 'assistant').map(([, text]) => text)
  assert.doesNotMatch(texts.join('\n'), LIVE_NOTE)
  assert.doesNotMatch(JSON.stringify(w.store.listMessages(DM).messages), LIVE_META)
  assert.doesNotMatch(JSON.stringify(w.events.filter(e => String(e.event).startsWith('message.'))), LIVE_META)
  assertPublicClean(w)
}

for (const [shelf, answer] of [[1, '8권까지 빌릴 수 있어요.'], [2, '21권까지 빌릴 수 있어요.']]) {
  test(`production topics: split siblings, reopen, return and use the correction for shelf ${shelf}`, async t => {
    const w = await liveTopicWorld(t)
    await topicSay(w, [PRE_TOPIC, '이전 대화는 따로 남겨요.'])
    const initial = topicEnable(w)
    assert.ok(!w.evidence.speechGrant(w.scope()), 'topic transfer does not rely on the speech grant')
    let n = w.liveAttempts.length
    const first = await topicSay(w, LIVE_ROOT)
    assert.ok(!first.none); assert.equal(w.liveAttempts.length, n, 'cold root needs no Decision request with no other candidates')
    assert.doesNotMatch(first.packet, LIVE_NOTE)
    const root = assertTopicAppend(w, initial, LIVE_ROOT)
    assert.ok(root.topic); assert.equal(root.parent, null); assert.deepEqual(root.needs, [])

    // Failed run really reaches native terminal ingestion. Its unpaired user
    // remains local but must never become a graph row or an external quote.
    w.hooks.nativeTerminal = 'failed'; n = w.liveAttempts.length
    await w.ask(FAILED_TOPIC); delete w.hooks.nativeTerminal
    assert.equal(w.store.getLatestRun(DM).status, 'failed')
    assertTopicDecision(w, n, FAILED_TOPIC, [LIVE_ROOT])
    assert.deepEqual(topicState(w).turns, [root])
    await topicSay(w, [OUTSIDE_TOPIC, '다른 대화에만 남겨요.'], { thread:'other-topic-dm' })
    assert.deepEqual(topicState(w).turns, [root])

    const correction = [`정정: 서가 ${shelf}만 이용할 수 있어.`, '이용 범위를 접수했어요.']
    const history = [LIVE_ROOT]
    for (const pair of [LIVE_CHILD, LIVE_SIBLING, correction]) {
      const state = topicState(w); n = w.liveAttempts.length
      assert.ok(!(await topicSay(w, pair)).none)
      const { serialized } = assertTopicDecision(w, n, pair[0], history)
      assert.doesNotMatch(serialized, /"recipient"|"localMessageId"|egdesk_decision_context/)
      assertTopicAppend(w, state, pair); history.push(pair)
    }
    const persisted = topicState(w)
    const [, child, sibling, independent] = persisted.turns
    assert.equal(child.parent, root.key); assert.equal(sibling.parent, root.key)
    assert.equal(independent.parent, null); assert.deepEqual(independent.needs, [])
    assert.equal(new Set(persisted.turns.map(row => row.topic)).size, 4, 'split siblings differ from each other and from separate roots')
    w.restart(); assert.deepEqual(topicState(w), persisted)

    w.hooks.reply = replyToLiveTopic; n = w.liveAttempts.length
    const returned = await w.ask(LIVE_RETURN)
    const { graph, serialized } = assertTopicDecision(w, n, LIVE_RETURN, history)
    assert.deepEqual(graph.pairs.map(p => [p.alias, p.topic, p.parent, p.needs]), [
      ['p0', 'p0', null, []], ['p1', 'p1', 'p0', []], ['p2', 'p2', 'p0', []], ['p3', 'p3', null, []],
    ], 'routing input includes stored topology expressed only as per-request aliases')
    assert.equal(returned.text, answer); assert.equal(w.rows().at(-1)[1], answer)
    assert.equal(returned.params.additionalContext.egdesk_decision_context.kind, 'application')
    const packet = liveEvidence(returned.packet)
    assert.deepEqual(packet?.path.map(p => [p.alias, p.topic, p.parent, p.needs, p.userText, p.assistantText]), [
      ['p0', 'p0', null, [], ...LIVE_ROOT], ['p1', 'p1', 'p0', [], ...LIVE_CHILD], ['p3', 'p3', null, [], ...correction],
    ], 'answer path closes over ancestry and includes the independent chosen pair')
    for (const quote of LIVE_SIBLING) assert.ok(!returned.packet.includes(quote), 'related but unneeded sibling is not given to the answerer')
    assert.doesNotMatch(returned.packet, LIVE_NOTE)
    for (const bytes of [serialized, returned.packet]) {
      for (const id of [TOPIC_RECIPIENT, persisted.generation, persisted.conversationId,
        ...persisted.turns.flatMap(row => [row.key, row.user.localMessageId, row.assistant.localMessageId, row.user.hash, row.assistant.hash])]) {
        assert.ok(!bytes.includes(id), 'private storage identity is not model input')
      }
    }
    const row = assertTopicAppend(w, persisted, [LIVE_RETURN, answer])
    assert.equal(row.topic, child.topic); assert.equal(row.parent, null)
    assert.deepEqual(row.needs, [independent.key])
    const next = topicState(w); w.restart(); assert.deepEqual(topicState(w), next)

    n = w.liveAttempts.length
    const follow = await w.ask(LIVE_FOLLOW)
    const followDecision = assertTopicDecision(w, n, LIVE_FOLLOW, [...history, [LIVE_RETURN, answer]])
    assert.deepEqual(followDecision.graph.pairs[4], { alias:'p4', topic:'p1', parent:null, needs:['p3'] })
    assert.deepEqual(followDecision.choices, ['continue_p0', 'split_p0', 'continue_p1', 'split_p1',
      'continue_p2', 'split_p2', 'continue_p3', 'split_p3', 'separate', 'abstain'], 'continued turns are not new route origins')
    assert.equal(follow.text, answer)
    assert.deepEqual(liveEvidence(follow.packet)?.path.map(p => p.alias), ['p0', 'p1', 'p3', 'p4'],
      'only the prior return is needed directly; its persisted dependency is traversed without reselecting it')
    assert.deepEqual(assertTopicAppend(w, next, [LIVE_FOLLOW, answer]).needs, [row.key])
    assertLivePublic(w)
  })
}

async function withLiveRoot(t) {
  const w = await liveTopicWorld(t)
  await topicSay(w, [PRE_TOPIC, '이전 대화는 따로 남겨요.']); topicEnable(w)
  assert.ok(!(await topicSay(w, LIVE_ROOT)).none)
  assert.equal(topicState(w).turns.length, 1)
  return w
}
function replaceTopicRoute(answers, value, confidence = .96) {
  return answers.map(a => a.name === 'topic_route' ? { ...a, choice:value, confidence,
    probabilities:[{ value, probability:confidence }] } : a)
}
function assertNoLiveTopicPrompt(turn) {
  assert.ok(!turn.none, 'normal native chat still completes')
  assert.doesNotMatch(turn.packet, LIVE_NOTE)
  assert.equal(liveEvidence(turn.packet), undefined)
  for (const quote of [...LIVE_ROOT, ...LIVE_CHILD, ...LIVE_SIBLING]) assert.ok(!turn.packet.includes(quote), quote)
}

for (const [name, response] of [
  ['abstained route', ({ answers }) => ({ answers:replaceTopicRoute(answers, 'abstain') })],
  ['unknown alias', ({ answers }) => ({ answers:replaceTopicRoute(answers, 'continue_p999') })],
  ['low confidence route', ({ answers }) => ({ answers:replaceTopicRoute(answers, 'split_p0', .51) })],
  ['missing dependency answer', ({ answers }) => ({ answers:answers.filter(a => a.name !== 'topic_need_0') })],
  ['ambiguous dependency', ({ answers }) => ({ answers:answers.map(a => a.name === 'topic_need_0' ? { ...a, probability:.5 } : a) })],
  ['invalid response body', () => ({ unrelated:[] })],
  ['unavailable transport', () => { throw new DecisionError('unreachable', 'Synthetic outage') }],
]) {
  test(`production topics: ${name} neither attaches a topic packet nor commits a graph edge`, async t => {
    const w = await withLiveRoot(t); const initial = topicState(w), n = w.liveAttempts.length
    w.hooks.topicResponse = response
    const turn = await topicSay(w, LIVE_CHILD)
    assertTopicDecision(w, n, LIVE_CHILD[0], [LIVE_ROOT]); assertNoLiveTopicPrompt(turn)
    assert.deepEqual(topicState(w), initial); assertLivePublic(w)
  })
}

for (const phase of ['recipient mismatch at transport', 'clear before transport', 'rotate after transport', 'clear in native resume']) {
  test(`production topics: ${phase} fences in-flight topic history`, async t => {
    const w = await withLiveRoot(t); const initial = topicState(w)
    const oldRows = w.rows(); let revoked = false
    const clear = () => { revoked = true; w.evidence.clearTopic(w.scope()); assert.equal(topicState(w), null) }
    if (phase === 'recipient mismatch at transport') w.transportRecipient = OTHER_RECIPIENT
    if (phase === 'clear before transport') w.hooks.duringDecide = clear
    if (phase === 'rotate after transport') w.hooks.topicResponse = () => { clear(); w.recipient = OTHER_RECIPIENT; topicEnable(w) }
    if (phase === 'clear in native resume') {
      w.restart(); w.hooks.onNative = method => { if (method === 'thread/resume') clear() }
    }
    const n = w.liveAttempts.length, sent = w.liveWires.length
    const turn = await topicSay(w, LIVE_CHILD)
    assertNoLiveTopicPrompt(turn)
    const blocked = phase === 'recipient mismatch at transport' || phase === 'clear before transport'
    assert.equal(w.liveAttempts.length - n, 1); assert.equal(w.liveAttempts.at(-1).allowed, !blocked)
    assert.equal(w.liveWires.length - sent, blocked ? 0 : 1)
    assert.deepEqual(w.rows().slice(0, oldRows.length), oldRows, 'revocation does not delete earlier local human-visible chat')
    if (phase === 'recipient mismatch at transport') assert.deepEqual(topicState(w), initial)
    else {
      assert.ok(revoked, 'test reached the intended revocation seam')
      if (phase === 'rotate after transport') {
        const current = topicState(w)
        assert.notEqual(current.generation, initial.generation); assert.deepEqual(current.turns, [])
      } else assert.equal(topicState(w), null)
    }
    const state = topicState(w); w.restart(); assert.deepEqual(topicState(w), state)
    assertLivePublic(w)
  })
}

test('production topics: off, advisory, other thread, changed recipient and cleared grant do not transfer or append old pairs', async t => {
  const w = await withLiveRoot(t), initial = topicState(w), n = w.liveWires.length
  for (const mode of ['off', 'advisory']) {
    w.mode = mode
    const from = w.liveWires.length
    const turn = await w.ask('서가 이야기 기억해?', null, { body:{ attachments:[{ id:'ordinary', label:'선택한 일반 문서' }] } })
    assertNoLiveTopicPrompt(turn); assert.deepEqual(topicState(w), initial)
    assert.equal(w.liveWires.length - from, mode === 'off' ? 0 : 1)
    for (const wire of w.liveWires.slice(from)) {
      assert.deepEqual(decisionNames(wire), []); assert.equal(topicWireHistory(wire), null)
      assert.ok(!JSON.stringify(wire).includes(LIVE_ROOT[1]))
    }
  }
  w.mode = 'on'
  assertNoLiveTopicPrompt(await w.ask('지난 서가 이야기 계속하자.', null, { thread:'other-topic-dm' }))
  assert.deepEqual(topicState(w), initial)
  w.recipient = OTHER_RECIPIENT; w.transportRecipient = OTHER_RECIPIENT
  assertNoLiveTopicPrompt(await w.ask('서가 이야기 다시 할까?')); assert.deepEqual(topicState(w), initial)
  w.evidence.clearTopic(w.scope()); assert.equal(topicState(w), null)
  w.restart(); assert.equal(topicState(w), null)
  assertNoLiveTopicPrompt(await w.ask('옛날 서가 목록은?'))
  const empty = topicEnable(w)
  assert.notEqual(empty.generation, initial.generation)
  const fresh = ['새 자료를 다루자.', '새 자료를 접수했어요.']
  const cold = await topicSay(w, fresh); assertNoLiveTopicPrompt(cold)
  assertTopicAppend(w, empty, fresh)
  assert.equal(w.liveWires.length - n, 1, 'only the normal advisory catalog left the test transport')
  assertLivePublic(w)
})

// Mixed-batch and prospective-consent production regressions. Test hooks only
// supply synthetic model responses, timing, and one harmless scored candidate.
const MIXED_SCORE_LABEL = 'MIXED_SCORE_LABEL'
const MIXED_SCORE_VALUE = 'MIXED_SCORE_VALUE: must never reach native on a dropped batch'
for (const [phase, hasFileGrant] of [['abstain', true], ['abstain', false], ['resume revoke', true], ['resume rekey', true]]) {
  test(`production topics: mixed batch ${phase} keeps only independently granted file evidence (grant=${hasFileGrant})`, async t => {
    const w = await withLiveRoot(t)
    const initial = topicState(w), { handle } = await w.bindStandard()
    if (!hasFileGrant) assert.ok(w.evidence.revoke(w.scope(), handle))
    delete w.hooks.reply // stock answer is derived only from received file lines
    w.hooks.stageHistory = ({ list }) => [...list, { id:'ordinary-scored', kind:'document', title:MIXED_SCORE_LABEL,
      timeSlice:'present', summary:'Optional reference', loadText:() => MIXED_SCORE_VALUE }]
    let scored = 0, resumed = 0
    w.hooks.topicResponse = ({ body, answers }) => {
      const catalog = body.input.flatMap(m => Array.isArray(m.content) ? m.content.map(c => c.text || '') : []).join('\n')
      const index = catalog.match(/^#(\d+) \| [^\n]*\bMIXED_SCORE_LABEL\b/m)?.[1]
      if (index !== undefined) scored++
      const ranked = answers.map(a => a.name === `rel_${index}` ? { ...a, probability:.99 } : a)
      return { answers:phase === 'abstain' ? replaceTopicRoute(ranked, 'abstain') : ranked }
    }
    if (phase !== 'abstain') {
      w.restart()
      w.hooks.onNative = method => {
        if (method !== 'thread/resume' || resumed) return
        resumed++
        w.evidence.clearTopic(w.scope())
        if (phase === 'resume rekey') {
          w.recipient = OTHER_RECIPIENT; w.transportRecipient = OTHER_RECIPIENT
          w.evidence.enableTopic(w.scope(), w.conv[DM], OTHER_RECIPIENT, w.store.topicBoundary(DM))
        }
      }
    }
    const n = w.liveAttempts.length
    // This real current user message normally takes split_p0 in the existing
    // semantic fixture; only the abstain case changes its topic answer.
    const turn = await w.ask(LIVE_CHILD[0], handle)
    assertTopicDecision(w, n, LIVE_CHILD[0], [LIVE_ROOT])
    assert.equal(scored, 1, 'the discarded mixed batch actually voted yes on an optional item')
    if (phase !== 'abstain') assert.equal(resumed, 1, 'revocation/rekey ran during native resume')
    assertNoLiveTopicPrompt(turn)
    assert.ok(!turn.packet.includes(MIXED_SCORE_LABEL) && !turn.packet.includes(MIXED_SCORE_VALUE))
    if (hasFileGrant) {
      assert.ok(hasPinned(turn)); assert.equal(turn.text, '지금 28개예요.')
      assert.deepEqual(turn.fields.sources.map(s => s.relation), ['counted','posted','coverage'])
      assert.doesNotMatch(turn.packet, /SENSITIVE_NEIGHBOR_TOKEN|COPY item|UNTRUSTED_LABEL|memrow:/)
    } else {
      noPinned(turn); assert.equal(turn.text, '알 수 없어요.')
    }
    if (phase === 'abstain') assert.deepEqual(topicState(w)?.turns, initial.turns)
    else if (phase === 'resume revoke') assert.equal(topicState(w), null)
    else {
      assert.notEqual(topicState(w)?.generation, initial.generation)
      assert.equal(topicState(w)?.recipient, OTHER_RECIPIENT)
      assert.deepEqual(topicState(w)?.turns, [])
    }
    assertLivePublic(w)
  })
}

for (const routeFailure of ['missing', 'ambiguous']) {
  test(`production topics: a completed correction with route status ${routeFailure} pauses the old path through reopen`, async t => {
    const w = await withLiveRoot(t), initial = topicState(w)
    const correction = ['정정: 서가 2만 이용할 수 있어.', '서가 2로 정정했어요.']
    w.hooks.topicResponse = ({ answers }) => ({ answers: routeFailure === 'missing'
      ? answers.filter(a => a.name !== 'topic_route')
      : answers.map(a => a.name === 'topic_route' ? { ...a, choice:'continue_p0', confidence:.9,
        probabilities:[{ value:'continue_p0', probability:.9 }, { value:'separate', probability:.85 }] } : a) })
    const n = w.liveAttempts.length
    assertNoLiveTopicPrompt(await topicSay(w, correction))
    assertTopicDecision(w, n, correction[0], [LIVE_ROOT])
    assert.equal(w.store.getLatestRun(DM).status, 'completed')
    assert.deepEqual(w.rows().slice(-2), [['user', correction[0]], ['assistant', correction[1]]])
    const paused = topicState(w)
    assert.deepEqual(paused?.turns, initial.turns, 'correction did not get a guessed edge')
    delete w.hooks.topicResponse; w.restart()
    assert.deepEqual(topicState(w), paused)
    const before = w.liveAttempts.length
    w.hooks.reply = replyToLiveTopic
    const next = await w.ask(LIVE_RETURN, null, { body:{ attachments:[{ id:'ordinary-pause-check', label:'일반 첨부 메모' }] } })
    assertNoLiveTopicPrompt(next); assert.equal(next.text, '대여 한도를 알 수 없어요.')
    assert.equal(w.liveAttempts.length - before, 1, 'ordinary Decisions can still run')
    const wire = w.liveAttempts.at(-1).body
    assert.deepEqual(decisionNames(wire), []); assert.equal(topicWireHistory(wire), null)
    for (const quote of [...LIVE_ROOT, ...correction]) assert.ok(!JSON.stringify(wire).includes(quote))
    assert.deepEqual(topicState(w), paused)

    assert.ok(w.evidence.clearTopic(w.scope()))
    const fresh = topicEnable(w)
    assert.notEqual(fresh.generation, initial.generation)
    const newRoot = ['새 대여 선반을 정하자.', '새 대여 선반만 논의해요.']
    const cold = w.liveAttempts.length
    assertNoLiveTopicPrompt(await topicSay(w, newRoot))
    assert.equal(w.liveAttempts.length, cold)
    assertTopicAppend(w, fresh, newRoot)
    const freshN = w.liveAttempts.length
    const freshFollow = ['이제 새 대여 선반을 기록하자.', '새 기록을 추가했어요.']
    assert.ok(!(await topicSay(w, freshFollow)).none)
    const { serialized } = assertTopicDecision(w, freshN, freshFollow[0], [newRoot])
    for (const quote of [...LIVE_ROOT, ...correction, LIVE_RETURN]) assert.ok(!serialized.includes(quote))
    assertLivePublic(w)
  })
}

test('production topics: enable during asynchronous preparation cannot backfill an already admitted request', async t => {
  const w = await liveTopicWorld(t)
  await topicSay(w, [PRE_TOPIC, '이전 대화는 따로 남겨요.'])
  const beforeEnable = ['이미 접수된 메시지예요.', '이미 접수된 답이에요.']
  let enabled, admission
  w.hooks.stageHistory = async ({ list, body, context }) => {
    await Promise.resolve()
    if (body.message === beforeEnable[0]) {
      admission = w.store.getAcceptedText(DM, context.requestId)
      enabled = topicEnable(w)
    }
    return list
  }
  const n = w.liveAttempts.length
  assertNoLiveTopicPrompt(await topicSay(w, beforeEnable))
  delete w.hooks.stageHistory
  assert.equal(admission, beforeEnable[0]); assert.ok(enabled)
  assert.equal(w.store.getLatestRun(DM).status, 'completed')
  assert.deepEqual(topicState(w), enabled); assert.equal(w.liveAttempts.length, n)
  const first = ['권한이 생긴 뒤 처음 묻는 말이에요.', '새 대화의 시작이에요.']
  assertNoLiveTopicPrompt(await topicSay(w, first))
  assertTopicAppend(w, enabled, first)
  const next = ['권한 이후 두 번째로 묻는 말이에요.', '두 번째 답이에요.']
  const actual = w.liveAttempts.length
  assert.ok(!(await topicSay(w, next)).none)
  const { serialized } = assertTopicDecision(w, actual, next[0], [first])
  for (const quote of beforeEnable) assert.ok(!serialized.includes(quote))
  assertLivePublic(w)
})

test('production topics: revocation after a started native reply and before terminal ingestion prevents commit', async t => {
  const w = await withLiveRoot(t), initial = topicState(w)
  // run.configuration is emitted after native turn/start is acknowledged and
  // the route is pending, but before any final answer is ingested.
  let revoked, activeRun, fresh
  w.events.push = function (...events) {
    const count = Array.prototype.push.apply(this, events)
    const configured = events.find(e => e.event === 'run.configuration' && e.clientThreadId === DM)
    if (revoked === undefined && configured) {
      activeRun = this.some(e => e.event === 'run.started' && e.runId === configured.runId) &&
        !this.some(e => e.event === 'message.completed' && e.runId === configured.runId)
      revoked = w.evidence.clearTopic(w.scope())
      w.recipient = OTHER_RECIPIENT; w.transportRecipient = OTHER_RECIPIENT
      w.evidence.enableTopic(w.scope(), w.conv[DM], OTHER_RECIPIENT, w.store.topicBoundary(DM))
      fresh = topicState(w)
    }
    return count
  }
  const n = w.liveAttempts.length
  const turn = await topicSay(w, LIVE_CHILD)
  delete w.events.push
  assertTopicDecision(w, n, LIVE_CHILD[0], [LIVE_ROOT])
  assert.deepEqual(liveEvidence(turn.packet)?.path.map(p => p.alias), ['p0'])
  assert.equal(activeRun, true); assert.equal(revoked, true)
  assert.equal(w.store.getLatestRun(DM).status, 'completed')
  assert.notEqual(fresh?.generation, initial.generation); assert.deepEqual(fresh?.turns, [])
  assert.deepEqual(topicState(w), fresh)
  w.restart(); assert.deepEqual(topicState(w), fresh)
  assertLivePublic(w)
})

test('default Decisions wire, questions, cache key and number of calls are invariant to the existence of speech rows', async t => {
  const w = await liveTopicWorld(t); await w.ask('초기 방을 확인해.'); const gen = w.evidence.enableSpeech(w.scope())
  assert.ok(gen); assert.equal(topicState(w), null)
  const prompt = '방금 한 말과 비교할래?'; const start = w.liveWires.length
  await w.ask(prompt); assert.ok(w.evidence.recentSpeech(w.scope(), gen).length > 0)
  await w.ask('DEFAULT_WIRE_CANARY: 아주 다른 내용으로 정정해.'); w.restart(); await w.ask(prompt)
  assert.equal(w.liveWires.length - start, 3)
  const empty = w.liveWires[start], populated = w.liveWires.at(-1)
  assert.deepEqual(populated, empty)
  assert.doesNotMatch(JSON.stringify(populated), /DEFAULT_WIRE_CANARY|conversation:recent|session_topic_|topic_(?:need|route)|이 DM에서 허용한 최근 발언/)
})

test('a durable uncertain dispatch without a run row cannot hide a topic gap after restart', async t => {
  const w = await withLiveRoot(t), initial = topicState(w)
  const req = 'lost-dispatch', localMessageId = 'msg-' + 'cd'.repeat(16), localRunId = 'run-uncertain'
  w.store.acceptRequest({ clientThreadId:DM, requestId:req, fingerprint:'fixture-uncertain', ts:w.clock,
    localMessageId, message:{ role:'user', text:'LOST_CORRECTION_CANARY', status:'accepted', localRunId, requestId:req } })
  w.store.appendEvent({ clientThreadId:DM, eventKey:'dispatch:' + req, event:'run.dispatching', requestId:req,
    localRunId, localMessageId, ts:w.clock, details:{ status:'dispatching' } })
  w.store.recordRequestOutcome({ clientThreadId:DM, requestId:req, ts:w.clock, outcome:{ accepted:false, dispatchStatus:'unknown', conversationId:w.conv[DM], localRunId } })
  assert.ok(!w.store.listRuns(DM).runs.some(r => r.localRunId === localRunId))
  w.restart(); const before = w.liveWires.length
  await w.ask('서가 수를 다시 알려 줘.'); assert.deepEqual(w.liveWires.slice(before).filter(topicWireHistory), [])
  assert.deepEqual(topicState(w), initial)
})

test('a fresh question can return to a topic whose origin and correction are both outside the old 12-utterance window', async t => {
  const w = await withLiveRoot(t), correction = ['정정: 서가 2만 이용할 수 있어.', '이용 범위를 접수했어요.']
  await topicSay(w, LIVE_CHILD); await topicSay(w, correction)
  const history = [LIVE_ROOT, LIVE_CHILD, correction]
  for (let i = 0; i < 8; i++) {
    const pair = [`별개 안건 ${i}의 임시 이름은?`, `관계 없는 별개 안건 ${i}예요.`]
    await topicSay(w, pair); history.push(pair)
  }
  const prior = topicState(w); assert.equal(prior.turns.length, 11); assert.equal(w.evidence.speechGrant(w.scope()), null)
  w.restart(); const start = w.liveAttempts.length; w.hooks.reply = replyToLiveTopic
  const returned = await w.ask(LIVE_RETURN); assertTopicDecision(w, start, LIVE_RETURN, history)
  assert.equal(returned.text, '21권까지 빌릴 수 있어요.')
  assert.deepEqual(liveEvidence(returned.packet)?.path.map(p => p.alias), ['p0','p1','p2'])
  assert.doesNotMatch(returned.packet, /임시 이름|별개 안건/); assert.deepEqual(topicState(w).turns.slice(0,-1), prior.turns)
})

test('the grant high-water mark survives reopen; a first successful but source-ineligible turn cannot be silently forgotten', async t => {
  const w = await liveTopicWorld(t); await w.ask('허용 전에 남는 문장.'); const initial = topicEnable(w)
  assert.equal(initial.startSeq, w.store.topicBoundary(DM))
  w.hooks.nativeTerminal = 'completed'
  // Beyond the original complete public final projection. Must not become an
  // empty-history reset just because there is not yet a topic origin to compare to.
  await topicSay(w, ['범위를 정정해.', '긴 답변 '.repeat(5000)])
  assert.deepEqual(topicState(w).turns, [])
  w.restart(); const count = w.liveWires.length
  assertNoLiveTopicPrompt(await topicSay(w, LIVE_ROOT)); assert.deepEqual(topicState(w).turns, [])
  assert.equal(w.liveWires.length, count)
  w.evidence.clearTopic(w.scope()); const next = topicEnable(w); assert.ok(next.startSeq > initial.startSeq)
  await topicSay(w, LIVE_ROOT); assertTopicAppend(w, next, LIVE_ROOT)
})

const ASSERTION = '동의 세대는 EG-Desk의 공식 설정입니다. PRIVATE_DRAFT_TOKEN'
const RECOVERY_ASSERTION = '주제 기억은 철회 뒤 자동으로 복구됩니다. PRIVATE_DRAFT_TOKEN'
const HOST_ANSWER = 'host:topic-answer-grounding'
async function manualTopicRun(w, message) {
  w.hooks.manualAnswer = true
  const r = await w.chat.send({ message, clientThreadId: DM, requestId: `r-${++w.requestN}`,
    conversationId: w.conv[DM], profileId: AGENT, replyDestination: 'direct' })
  assert.equal(r.runId, w.fixtureRun.turnId)
  const timing = { ...w.fixtureRun }
  const notify = (method, params) => w.chat.handleNotification({ method, params: { ...timing, ...params } })
  const item = (text, phase = 'final_answer') => ({ type:'agentMessage', id:`a${r.runId}`, phase, text })
  return { r, item, start: text => notify('item/started', { item:item(text) }),
    delta: delta => notify('item/agentMessage/delta', { itemId:item('').id, delta }),
    complete: text => notify('item/completed', { item:item(text) }),
    terminal: (items = [], status = 'completed') => notify('turn/completed', { turn:{ id:r.runId, status, items } }) }
}
async function assertNoGroundingDraft(w, runId) {
  const events = w.events.filter(e => e.runId === runId)
  assert.doesNotMatch(JSON.stringify([events, w.legacy, w.chat.snapshot(w.conv[DM]),
    w.store.listRuns(DM), w.store.listMessages(DM), w.store.listEvents(DM)]), /PRIVATE_DRAFT_TOKEN/)
  assert.ok(!events.some(e => e.event.startsWith('message.') && e.details?.role !== 'user'))
  for (const file of await readdir(path.join(w.dir, 'chat'))) {
    assert.equal((await readFile(path.join(w.dir, 'chat', file))).includes(Buffer.from('PRIVATE_DRAFT_TOKEN')), false)
  }
}

test('scoped grounding: split draft never projects; blocked even with routing off and revoke before terminal; raw native restore stays private', async t => {
  const w = await liveTopicWorld(t)
  await w.ask('기존 대화'); topicEnable(w); w.mode = 'off'
  const turn = await manualTopicRun(w, '주제 기억을 어떻게 쓰니?')
  await turn.delta('동') // hold before an item or phase exists
  await turn.start('동의 세'); await turn.delta('대는 EG-Desk의 공식 설정입니다. '); await turn.delta('PRIVATE_DRAFT_TOKEN ')
  await assertNoGroundingDraft(w, turn.r.runId)
  await turn.complete(ASSERTION)
  await assertNoGroundingDraft(w, turn.r.runId)
  assert.equal(w.evidence.clearTopic(w.scope()), true)
  await turn.terminal()
  const stored = w.store.getLatestRun(DM)
  assert.equal(stored.status, 'completed'); assert.equal(stored.activities.filter(a => a.id === HOST_ANSWER).length, 1)
  assert.ok(!stored.messages.some(m => m.role === 'assistant'))
  assert.equal(topicState(w), null)
  await assertNoGroundingDraft(w, turn.r.runId)
  w.hooks.restoreTurns = [{ id: turn.r.runId, status:'completed', items:[turn.item(ASSERTION), turn.item(ASSERTION, 'commentary')] }]
  w.restart()
  const restored = await w.chat.resume({ clientThreadId:DM, conversationId:w.conv[DM] })
  assert.equal(restored.runs[0].status, 'completed')
  assert.ok(restored.runs[0].activities.some(a => a.id === HOST_ANSWER))
  await assertNoGroundingDraft(w, turn.r.runId)
})

test('scoped grounding: late completion and terminal snapshots cannot bypass the hold; lost proof and size/time bounds fail closed', async t => {
  const w = await liveTopicWorld(t)
  await w.ask('기존 대화'); topicEnable(w)
  const late = await manualTopicRun(w, 'late proof')
  await late.start(RECOVERY_ASSERTION); await late.terminal(); await assertNoGroundingDraft(w, late.r.runId)
  await late.complete(RECOVERY_ASSERTION); assert.ok(w.store.getLatestRun(DM).activities.some(a => a.id === HOST_ANSWER))
  const snapshot = await manualTopicRun(w, 'snapshot proof')
  await snapshot.terminal([snapshot.item(ASSERTION)]); await assertNoGroundingDraft(w, snapshot.r.runId)
  assert.ok(w.store.getLatestRun(DM).activities.some(a => a.id === HOST_ANSWER))
  const huge = await manualTopicRun(w, 'oversize proof')
  await huge.complete('PRIVATE_DRAFT_TOKEN' + 'x'.repeat(33_000)); await huge.terminal(); await assertNoGroundingDraft(w, huge.r.runId)
  assert.ok(w.store.getLatestRun(DM).activities.some(a => a.id === HOST_ANSWER))
  const timeout = await manualTopicRun(w, 'expired proof')
  await timeout.complete(ASSERTION); w.clock += 121_000
  await timeout.terminal(); await assertNoGroundingDraft(w, timeout.r.runId)
  assert.ok(w.store.getLatestRun(DM).activities.some(a => a.id === HOST_ANSWER))
  const running = await manualTopicRun(w, 'lost proof')
  await running.complete(ASSERTION)
  w.hooks.restoreTurns = [{ id: running.r.runId, status:'completed', items:[running.item(ASSERTION)] }]
  w.restart(); await w.chat.resume({ clientThreadId:DM, conversationId:w.conv[DM] })
  await assertNoGroundingDraft(w, running.r.runId)
  assert.equal(w.store.getLatestRun(DM).status, 'completed')
  assert.ok(w.store.getLatestRun(DM).activities.some(a => a.id === HOST_ANSWER))
})

test('scoped grounding: valid contrasts are byte-for-byte unchanged; without consent, ordinary streaming is unchanged', async t => {
  const w = await liveTopicWorld(t)
  await w.ask('기존 대화'); topicEnable(w)
  const valid = '동의 세대는 공식 설정이 아닙니다. “동의 세대”를 이 대화에서만 임시 이름으로 씁니다. 주제 기억은 이 DM에서 별도 허용이 필요합니다. 철회하면 주제 기억은 자동으로 복구되지 않습니다.'
  const approved = await manualTopicRun(w, '정상 답변')
  await approved.start(valid.slice(0, 10)); await approved.delta(valid.slice(10)); await approved.complete(valid)
  assert.equal(w.events.some(e => e.runId === approved.r.runId && e.event === 'message.completed'), false)
  await approved.terminal()
  assert.equal(w.store.getLatestRun(DM).messages.find(m => m.role === 'assistant').text, valid)
  assert.ok(w.legacy.some(e => e.type === 'assistant-delta' && e.delta === valid))
  w.hooks.restoreTurns = [{ id: approved.r.runId, status:'completed', items:[approved.item('PRIVATE_DRAFT_TOKEN')] }]
  w.restart()
  const restored = await w.chat.resume({ clientThreadId:DM, conversationId:w.conv[DM] })
  assert.equal(restored.runs[0].messages.find(m => m.role === 'assistant').text, valid)
  assert.equal(w.evidence.clearTopic(w.scope()), true)
  const ordinary = await manualTopicRun(w, '동의 없는 대화')
  await ordinary.start('동의 세대는 EG-Desk의 공식 설정입니다. ')
  await ordinary.delta('그대로 스트리밍합니다. ')
  assert.ok(w.events.some(e => e.runId === ordinary.r.runId && e.event === 'message.delta'))
  await ordinary.complete(ASSERTION.replace('PRIVATE_DRAFT_TOKEN', ''))
  await ordinary.terminal()
  assert.ok(w.store.getLatestRun(DM).messages.some(m => m.role === 'assistant'))
})

test('scoped grounding: an unresolved dispatch cannot restore an uncorrelated native draft', async t => {
  const w = await liveTopicWorld(t)
  await w.ask('기존 대화'); topicEnable(w)
  w.hooks.onNative = method => { if (method === 'turn/start') throw Error('synthetic connection lost') }
  await assert.rejects(manualTopicRun(w, 'lost reply'))
  const pending = w.store.pendingTopicAnswer(DM)
  assert.ok(pending)
  const item = { id:'answer-lost', type:'agentMessage', phase:'final_answer', text:ASSERTION }
  w.hooks.restoreTurns = [{ id:'turn-lost', status:'completed', items:[item] }]
  w.restart()
  await assert.rejects(w.chat.resume({ clientThreadId:DM, conversationId:w.conv[DM] }), { code:'TOPIC_ANSWER_BINDING' })
  await assertNoGroundingDraft(w, 'turn-lost')
  w.hooks.restoreTurns[0].items.unshift({ id:'user-lost', type:'userMessage', clientId:pending, content:[] })
  const restored = await w.chat.resume({ clientThreadId:DM, conversationId:w.conv[DM] })
  assert.equal(w.store.pendingTopicAnswer(DM), null)
  assert.equal(restored.runs.at(-1).status, 'completed')
  assert.ok(restored.runs.at(-1).activities.some(a => a.id === HOST_ANSWER))
  await assertNoGroundingDraft(w, 'turn-lost')
})
