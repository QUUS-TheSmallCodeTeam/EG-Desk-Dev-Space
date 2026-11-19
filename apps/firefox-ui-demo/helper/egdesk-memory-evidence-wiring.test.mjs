// Integration test: immutable source pins through the actual decision/turn/transcript path.
// Real: CodexChatRuntime.send, turn/start params, ImmutableContextStore captures, MemoryEvidenceStore, chat SQLite, reopen.
// Synthetic: provider (derives the number ONLY from packet source lines), decision client, profiles stub. No network/CLI/accounts.
import test from 'node:test'
import assert from 'node:assert/strict'
import os from 'node:os'
import path from 'node:path'
import { mkdtemp, rm, chmod, readdir, readFile } from 'node:fs/promises'
import { ImmutableContextStore } from './egdesk-context-store.mjs'
import { MemoryEvidenceStore } from './egdesk-memory-evidence.mjs'
import { CodexChatRuntime } from './codex-chat-runtime.mjs'
import { openChatStore } from './egdesk-chat-store.mjs'
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
  const w = { dir, requestN: 0, clock: 1_000_000, turns: [], collected: [], events: [], decisionInputs: [], errors: [], threads: 0, turnN: 0, hooks: {}, mode: 'on', conv: {}, handles: {}, fx: fixtures({ count, out }) }
  const boot = () => {
    w.captures = new ImmutableContextStore({ dataDir: path.join(dir, 'state'), allowedRoots: [dir], now: () => w.clock })
    w.evidence = new MemoryEvidenceStore({ dataDir: path.join(dir, 'state'), captures: w.captures, now: () => w.clock })
    w.store = openChatStore({ dataDir: path.join(dir, 'chat'), ownerScope: 'synthetic-memev-qa' })
    const chat = new CodexChatRuntime({
      store: w.store, requireStore: true, getOwnerKey: () => OWNER, profiles, resolveProjectWorkspace: async () => null,
      request: async (method, params) => {
        await w.hooks.onNative?.(method)
        if (method === 'thread/start') return { thread: { id: `thread-${++w.threads}` }, cwd: '/work', model: 'synthetic' }
        if (method === 'thread/resume') return { thread: { id: params.threadId, turns: [] }, cwd: '/work' }
        if (method === 'config/read') return { config: { developer_instructions: null } }
        if (method === 'thread/unsubscribe') return { status: 'unsubscribed' }
        if (method === 'turn/interrupt') return {}
        if (method !== 'turn/start') throw new Error(`Unexpected method: ${method}`)
        const id = `turn-${++w.turnN}`
        const style = /왜/.test(JSON.stringify(params.input)) ? 'reason' : 'direct'
        const packet = params.additionalContext?.egdesk_decision_context?.value || ''
        const { text, fields } = derive(packet, style)
        w.turns.push({ params, packet, fields, text })
        const timing = { threadId: params.threadId, turnId: id }
        setTimeout(async () => {
          const n = (m, p) => chat.handleNotification({ method: m, params: p })
          await n('item/started', { ...timing, item: { id: `w${id}`, type: 'agentMessage', phase: 'commentary', text: '' } })
          await n('item/completed', { ...timing, item: { id: `w${id}`, type: 'agentMessage', phase: 'commentary', text: `NATIVE_WORK_NOTE ${id}` } })
          await n('item/started', { ...timing, item: { id: `a${id}`, type: 'agentMessage', phase: 'final_answer', text: '' } })
          await n('item/agentMessage/delta', { ...timing, itemId: `a${id}`, delta: text })
          await n('item/completed', { ...timing, item: { id: `a${id}`, type: 'agentMessage', phase: 'final_answer', text } })
          await n('turn/completed', { threadId: params.threadId, turn: { id, status: 'completed', items: [] } })
        }, 5)
        return { turn: { id, status: 'inProgress', items: [] } }
      },
      respond: () => {}, emit: e => w.events.push(e), emitLegacy: () => {}, verifyFile: async () => null,
      decisionContext: { mode: () => w.mode, configured: () => true, budgetMs: 5000, memoryEvidence: w.evidence,
        client: { model: 'synthetic-decision', async decide(request) {
          w.decisionInputs.push(JSON.stringify(request.input)); await w.hooks.duringDecide?.()
          const answers = {}
          for (const q of request.questions) answers[q.name] = q.type === 'choice'
            ? { type: 'choice', choice: q.name === 'time_intent' ? 'present' : 'answer', confidence: 0.95, probabilities: [{ value: q.name === 'time_intent' ? 'present' : 'answer', probability: 0.95 }] }
            : { type: 'predicate', probability: 0.02 } // relevance never selects: only the explicit (mandatory) handle can attach
          return { answers, model: 'synthetic-decision', usage: { inputTokens: 1 }, latencyMs: 1 }
        } },
        collect: async ({ body, context, memoryEvidenceFor }) => {
          const list = (await collectDecisionCandidates({ body, clientThreadId: context.clientThreadId, excludeMessageId: context.localMessageId, chatStore: w.store, memoryEvidenceFor })).candidates
          w.collected.push({ message: body.message, ids: list.map(c => c.id), texts: list.map(c => `${c.title}|${c.summary}`) }); return list
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
  w.bindStandard = async ({ thread = DM, agentId = AGENT, expiresAt, caps = null } = {}) => {
    const c = caps || { ledger: await w.capture('ledger.jsonl'), count: await w.capture('count.jsonl'), post: await w.capture('post.jsonl'), cover: await w.capture('cover.jsonl') }
    const r = (x, relation) => ({ ...(relation ? { relation } : {}), sourceId: x.sourceId, revision: x.revision, startLine: 2, endLine: 2 })
    const handle = await w.evidence.bind(w.scope(thread, agentId), { ledger: r(c.ledger), sources: [r(c.count, 'counted'), r(c.post, 'posted'), r(c.cover, 'coverage')], ...(expiresAt != null ? { expiresAt } : {}) })
    return { handle, caps: c }
  }
  w.ask = async (message, handle, { thread = DM, direct = true, profile = true, body = {} } = {}) => {
    const count = () => { try { return w.store.listMessages(thread).messages.filter(m => m.role === 'assistant').length } catch { return 0 } }
    const before = w.turns.length, rows = count()
    let r; try { r = await w.chat.send({ message, clientThreadId: thread, requestId: `r-${++w.requestN}`,
      ...(w.conv[thread] ? { conversationId: w.conv[thread] } : {}), ...(profile ? { profileId: AGENT } : {}), ...(direct ? { replyDestination: 'direct' } : {}),
      ...(handle ? { selectedSources: [{ id: handle, label: 'UNTRUSTED_LABEL', kind: 'memory-evidence' }] } : {}), ...body }) } catch (e) { w.errors.push(e.code || e.message); return { packet: '', fields: null, params: {}, none: true, error: e.code || e.message } }
    w.conv[thread] ||= r.conversationId
    for (let i = 0; i < 400 && !(w.turns.length > before && count() > rows); i++) await new Promise(r => setTimeout(r, 10))
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
    assert.equal(w.collected.at(-1).ids.filter(i => i.startsWith('message:')).length, 2)
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
  // a different profile id in the body for a thread owned by the stored agent cannot read the handle bound to sol
  noPinned(await w.ask('지금 몇 개야?', a.handle, { body: { profileId: 'other-agent' } }))
  // A body profileId is the UI's way to switch the thread's agent (profile transition), so the stored agent follows it;
  // the security property is that a handle bound to sol never serves while the verified agent is another one.
  assert.equal(w.store.getConversation(DM)?.agent?.profileId, 'other-agent')
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
  w.mode = 'advisory'; const adv = await w.ask('지금 몇 개야?', handle)
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
