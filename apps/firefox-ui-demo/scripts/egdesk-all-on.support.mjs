// Support module (not a test): ONE bridge-side world with every Decision-model feature of int/c13 switched ON (or all OFF), wired the way
// helper/codex-bridge-server.mjs wires them, for the all-features-on journey (scripts/egdesk-all-on-journey.test.mjs).
//
// Real (product code): CodexChatRuntime, the SQLite chat store, ContextRuntime + ImmutableContextStore, the browser tool provider, the Decisions
//   client (createDecisionClient) with ONE shared budget, the calibration log, bridge settings (turnMemory), createTurnMemoryConfig + the wiki
//   adapter and its write store, createBrowserEntryConfig, the presence mirror, createWorkPlacement + its HTTP route, the Board/Decisions
//   handler with briefingDeps (skeleton order), the chrome request builders (EGDeskBriefingHost, EGDeskWorkPlacement).
// Synthetic: the native engine (thread/start, turn/start, thread/fork, turn/steer and its notifications, scripted here), the Decisions provider
//   (one mock fetch that answers every feature's questions and records each request with its feature), the browser card (a UI double), the
//   ontology graph (public synthetic pages), the canvas (plain card records), presence rows.
// Nothing here touches the network, Firefox or a Codex binary.
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, chmodSync, mkdirSync, readFileSync } from 'node:fs'
import vm from 'node:vm'
import { EventEmitter } from 'node:events'
import { Readable } from 'node:stream'
import os from 'node:os'
import path from 'node:path'
import * as ChatState from '../overlay/resources/EGDeskChatState.sys.mjs'
import { CodexChatRuntime } from '../helper/codex-chat-runtime.mjs'
import { createChatHttpHandler } from '../helper/codex-bridge-http.mjs'
import { openChatStore } from '../helper/egdesk-chat-store.mjs'
import { ImmutableContextStore } from '../helper/egdesk-context-store.mjs'
import { ContextRuntime } from '../helper/egdesk-context-runtime.mjs'
import { createCodexBrowserToolProvider } from '../helper/codex-browser-tool-provider.mjs'
import { createDecisionBudget, createDecisionClient, decisionTopicRecipient } from '../helper/egdesk-decision-client.mjs'
import { openCalibrationLog } from '../helper/egdesk-decision-calibration-log.mjs'
import { openBridgeSettings } from '../helper/egdesk-bridge-settings.mjs'
import { createTurnMemoryConfig } from '../helper/egdesk-turn-memory-wiring.mjs'
import { createWikiAdapter, openWikiWrites } from '../helper/egdesk-wiki-adapter.mjs'
import { createBrowserEntryConfig } from '../helper/egdesk-browser-entry-wiring.mjs'
import { createPresenceMirror } from '../helper/egdesk-presence-mirror.mjs'
import { createWorkPlacement, createWorkPlacementHttpHandler } from '../helper/egdesk-work-placement.mjs'
import { createBoardPresentationHttpHandler } from '../helper/egdesk-board-presentation-http.mjs'
import { briefingDeps } from '../helper/egdesk-briefing-engine.mjs'
import { collectDecisionCandidates } from '../helper/egdesk-decision-candidates.mjs'
import { SYNTHETIC_PAGES, mockJudge } from '../helper/egdesk-wiki-reconstruction.fixture.mjs'

export const KEY = 'egd-synthetic-not-a-key-0009'
export const OWNER = 'codex:fixture-owner'
export const DM = 'dm-all-on'
export const AGENT = 'sol'
export const PORTAL = 'https://portal.example.test'

// ---- the ontology graph the turn memory reads (public synthetic pages: the A사 quote and the PostgreSQL migration) ----
const SLICE = { past: 'past', present: 'present', planned: 'future', hypothetical: 'hypothetical' }
const GRAPH_PAGES = SYNTHETIC_PAGES.filter(p => /^(quote\/a-|db\/pg-|db\/sqlite)/.test(p.id) && !p.scope)
export const GRAPH = { snapshots: [],
  nodes: GRAPH_PAGES.map(p => ({ id: p.id, label: p.title, body: p.body, timeSlice: SLICE[p.time.slice] ?? 'present' })),
  edges: GRAPH_PAGES.flatMap(p => (p.links || []).filter(l => GRAPH_PAGES.some(q => q.id === l.to)).map(l => ({ source: p.id, target: l.to, relation: l.type }))) }

// ---- the browser card double (the portal of the browser-task journeys) ----
const el = (ref, role, label, extra = {}) => ({ ref, role, label, tag: role === 'link' ? 'a' : 'button', href: '', value: '', ...extra })
const PAGES = {
  [`${PORTAL}/invoices`]: [el('b1', 'link', '사업자 123-45-67890', { href: `${PORTAL}/biz/1` }), el('b2', 'link', '사업자 987-65-43210', { href: `${PORTAL}/biz/2` }), el('s1', 'button', '발행 제출')],
  [`${PORTAL}/biz/2`]: [el('d2', 'link', '이번 달 세금계산서 다운로드', { href: `${PORTAL}/download/2.pdf` })],
  [`${PORTAL}/biz/1`]: [el('d1', 'link', '이번 달 세금계산서 다운로드', { href: `${PORTAL}/download/1.pdf` })],
  [`${PORTAL}/download/2.pdf`]: [], [`${PORTAL}/download/1.pdf`]: [],
}

// The scripted subjective model's fill for a briefing guide: slot data only, taken from the materials it was handed (never invented).
const clip = (text, max) => (text.length > max ? text.slice(0, max - 1) + '…' : text)
export function fillFromGuide(prompt) {
  const guide = JSON.parse(/Design guide \(decided; do not change it\):\n(.*)\n\nMaterials:/s.exec(prompt)[1]), mats = JSON.parse(/Materials:\n(.*)\n\nRules:/s.exec(prompt)[1])
  const M = Object.fromEntries(mats.map(m => [m.alias, m]))
  const value = (slot, item, k = 0) => (slot.type === 'material' ? item.materials[Math.min(k, item.materials.length - 1)]
    : slot.type === 'list' ? item.materials.slice(0, slot.max).map((alias, i) => Object.fromEntries(slot.of.map(field => [field.name, field.type === 'material' ? alias : clip(field.name === 'label' || field.name === 'aspect' ? `${i + 1}` : M[alias]?.title ?? '', field.max ?? 60)])))
      : clip(slot.name === 'title' ? M[item.materials[0]]?.title ?? '' : item.materials.map(alias => M[alias]?.text ?? '').join(' '), slot.max ?? 200))
  const items = Object.fromEntries(guide.items.map(item => { let materialSlots = 0
    return [item.id, { text: clip(`${item.materials.map(alias => M[alias]?.title ?? alias).join(', ')}의 내용입니다.`, 240), fallback: clip(`${M[item.materials[0]]?.title ?? ''} 카드를 열어 보세요.`, 400),
      slots: Object.fromEntries(item.slots.map(slot => [slot.name, value(slot, item, slot.type === 'material' ? materialSlots++ : 0)])) }] }))
  return '```json\n' + JSON.stringify({ title: 'A사 견적 정리', items }) + '\n```'
}

const wireChoice = (name, q, value, p = 0.95) => { const other = q.choices.map(c => c.value).find(v => v !== value); return { name, type: 'choice', choice: value, confidence: p, probabilities: [{ value, probability: p + 0.01 }, ...(other === undefined ? [] : [{ value: other, probability: 0.02 }])] } }
const MEMORY_Q = /^(pg_|st_|op_|tn_|tw_|speech_)/

/** Which feature a Decisions request belongs to, from its question names and cache key only. */
export function featureOf(names, cacheKey = '') {
  if (names.some(n => n.includes('__'))) return 'heartbeat'
  if (names.some(n => /^tw_/.test(n))) return 'memory_write'
  if (names.some(n => /^tn_/.test(n))) return names.includes('browser_entry') ? 'memory_triage+browser_entry' : 'memory_triage'
  if (names.some(n => /^(pg_|st_|op_)/.test(n))) return 'memory_fetch'
  if (names.some(n => /^speech_/.test(n))) return 'speech'
  if (names.includes('browser_entry')) return 'browser_entry'
  if (names.includes('task_resume')) return 'browser_resume'
  if (names.includes('next_step')) return 'browser_step'
  if (names.some(n => /^(claim_|present_)/.test(n)) || cacheKey === 'draft-check') return 'draft_check'
  if (names.includes('place') || names.includes('attention')) return cacheKey === 'work-placement' ? 'work_placement' : 'briefing'
  if (names.includes('answer_type') || names.includes('time_intent') || names.some(n => /^rel_/.test(n))) return 'turn_context'
  if (names.includes('terminal_state')) return 'command_judge'
  if (cacheKey) return cacheKey
  return `other:${names.slice(0, 3).join(',')}`
}

/**
 * allOnWorld(t, { on }) → the world. on:true = every feature on; on:false = the bridge's default (every flag unset, Decisions mode off);
 * on:null = a runtime with no decisionContext at all (a bridge before any of these features).
 */
export function allOnWorld(t, { on = true, policy = {} } = {}) {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'egd-all-on-')); chmodSync(dir, 0o700)
  const cwd = path.join(dir, 'workspace'); mkdirSync(cwd)
  const store = openChatStore({ dataDir: path.join(dir, 'chat'), ownerScope: 'synthetic-all-on' })
  t.after(() => { try { store.close() } catch {} rmSync(dir, { recursive: true, force: true }) })
  const settingsDir = path.join(dir, 'settings')
  const settings = openBridgeSettings({ dataDir: settingsDir, log() {} })
  const calibrationLog = openCalibrationLog({ dataDir: settingsDir, log() {} })
  const ENV = on === true
    ? { EGDESK_DRAFT_CHECK: 'on', EGDESK_CONVERSATION_FLOW: 'on', EGDESK_PRESENCE: 'on', EGDESK_BROWSER_ENTRY: 'on', EGDESK_COMMAND_JUDGE: 'advisory', EGDESK_TERMINAL_GATE: 'advisory',
      EGDESK_WORKING_MEMORY: 'on', EGDESK_WORK_PLACEMENT: 'advisory', EGDESK_BRIEFING_FLOW: 'on' }
    : {}
  let clock = Date.parse("2026-11-25T01:00:00Z"), step = 'setup'
  const timers = [], events = [], native = [], decisions = [], forkPrompts = [], acts = [], steers = [], replies = [], anomalies = []
  const judge = mockJudge()
  const state = { cur: { url: `${PORTAL}/invoices`, documentId: 'doc1', revision: 1 }, docSeq: 1, threads: 0, forks: 0, turns: 0, turnsOf: new Map(), thread: DM, lastOf: new Map(), sends: 0, mode: on === true ? 'on' : 'off', fill: fillFromGuide, wording: {} }
  Object.defineProperty(state, 'last', { get: () => state.lastOf.get(state.thread) ?? null })
  const snap = () => ({ cardId: 'card', documentId: state.cur.documentId, revision: state.cur.revision, url: state.cur.url, readyState: 'complete', text: ['합성 포털'],
    viewport: { width: 300, height: 200, devicePixelRatio: 1 }, interactiveElements: PAGES[state.cur.url] })

  // ---- ONE Decisions provider for every feature: it records each request under its feature and the journey step ----
  const answer = wire => {
    const flat = content => (typeof content === 'string' ? content : Array.isArray(content) ? content.map(part => (typeof part?.text === 'string' ? part.text : JSON.stringify(part))).join('\n') : JSON.stringify(content))
    const names = wire.questions.map(q => q.name), text = (Array.isArray(wire.input) ? wire.input.map(m => flat(m.content)) : [String(wire.input)]).join('\n\n')
    const entry = q => wireChoice('browser_entry', q, /세금계산서/.test(/(?:User message: |Message:\n)(.*)/.exec(text)?.[1] ?? '') ? q.choices.find(c => c.value.includes('[C1]'))?.value ?? 'not_browser_task' : 'not_browser_task')
    if (names.some(n => n.includes('__'))) {
      // L3 c15: the message judgment is yes/no questions (message__pointer / __ask / __note / __stalled); code derives the kind. The mock keeps
      // its policy over the kinds those questions stand for and answers yes to the picked kind's question only.
      const KIND = { message__pointer: 'pointer', message__ask: 'ask_missing', message__note: 'explain_wait', message__stalled: 'stalled' }
      const kinds = ['none', ...['message__pointer', 'message__ask', 'message__note', 'message__stalled'].filter(name => names.includes(name)).map(name => KIND[name])]
      const num = name => Number(new RegExp(`${name}: (\\d+)`).exec(text)?.[1] ?? 0)
      const picked = typeof policy.message === 'function' ? policy.message(kinds, text) : kinds.includes('pointer') ? 'pointer' : kinds.includes('stalled') ? 'stalled' : kinds.includes('ask_missing') ? 'ask_missing'
        : kinds.includes('explain_wait') && (num('tool_steps_done') + num('tool_steps_running') > 0 || /The assistant is running a command/.test(text)) ? 'explain_wait' : 'none'
      return wire.questions.map(q => { if (q.type === 'predicate') return { name: q.name, type: 'predicate', probability: KIND[q.name] === picked && picked !== 'none' ? 0.97 : 0.03 }
        const values = q.choices.map(c => c.value)
        return wireChoice(q.name, q, typeof policy[q.name] === 'function' ? policy[q.name](q, text) : values.includes('none') ? 'none' : values[0]) })
    }
    if (names.some(n => MEMORY_Q.test(n))) { // the lexical stand-in of the memory lane, plus the entry question when it rides the triage request
      return judge.decide({ input: wire.input, questions: wire.questions.filter(q => q.name !== 'browser_entry') }).then(out => [
        ...Object.entries(out.answers).map(([name, a]) => ({ name, ...a })), ...wire.questions.filter(q => q.name === 'browser_entry').map(entry)])
    }
    if (names[0] === 'browser_entry') return [entry(wire.questions[0])]
    if (names[0] === 'task_resume') return [wireChoice('task_resume', wire.questions[0], /취소/.test(/User message: (.*)/.exec(text)?.[1] ?? '') ? 'cancel_task' : 'resume_task')]
    if (names.includes('next_step')) {
      const q0 = wire.questions[0], evidence = wire.input[1].content
      const url = /URL: (\S+)/.exec(evidence)?.[1], ctx = /Context the user gave in the chat \(not page text\):\n([\s\S]*?)\n\n/.exec(evidence)?.[1] ?? ''
      const starts = textPart => q0.choices.find(c => c.value.includes(textPart))?.value
      const listed = /it is listed now as (\[L\d+\] [^\n]*?)\.(?:\n|$)/.exec(evidence)
      let next, goalMet = 0
      if (/\/download\//.test(url)) { next = 'goal_met'; goalMet = 0.95 }
      else if (/\/invoices/.test(url)) next = listed ? listed[1].trim() : /두 번째/.test(ctx) ? starts('987-65') : 'needs_user_context'
      else next = starts('다운로드') ?? 'blocked'
      const a = { name: 'next_step', type: 'choice', choice: next, confidence: 0.95, probabilities: [{ value: next, probability: 0.95 }] }
      if (next === 'needs_user_context') a.probabilities.push(...q0.choices.filter(c => /^\[L\d+\]/.test(c.value)).slice(0, 2).map(c => ({ value: c.value, probability: 0.02 })))
      return [a, { name: 'page_state', type: 'choice', choice: 'content', confidence: 0.95, probabilities: [{ value: 'content', probability: 0.95 }] }, { name: 'goal_met', type: 'predicate', probability: goalMet }]
    }
    // Turn-context selection (the earlier Decision feature): a catalog item is needed when it is about the thing the message names.
    const topic = names.includes('answer_type') ? text.slice(text.lastIndexOf('Message:\n') + 9) : ''
    const topicKey = /A사/.test(topic) ? /A사/ : /PostgreSQL|마이그레이션/.test(topic) ? /PostgreSQL|마이그레이션/ : null
    return wire.questions.map(q => {
      if (typeof policy[q.name] === 'function') return wireChoice(q.name, q, policy[q.name](q, text))
      if (/^rel_\d+$/.test(q.name) && names.includes('answer_type')) { const line = new RegExp(`^#${q.name.slice(4)}\\b[^\\n]*`, 'm').exec(text)?.[0] ?? ''; return { name: q.name, type: 'predicate', probability: topicKey && topicKey.test(line) ? 0.95 : 0.03 } }
      if (q.type !== 'choice') return { name: q.name, type: 'predicate', probability: 0.03 }
      const values = q.choices.map(c => c.value)
      if (q.name === 'place' && values.includes('board')) return wireChoice(q.name, q, 'board')
      // work placement, attention: tell the member where the card is (the option described in those closed words)
      if (q.name === 'attention') return wireChoice(q.name, q, q.choices.find(c => /tell the member/.test(c.description ?? ''))?.value ?? values[0])
      if (/^retrieve_/.test(q.name) && values.includes('keep')) return wireChoice(q.name, q, 'keep')
      if (/^rechoose_/.test(q.name) && values.includes('drop')) return wireChoice(q.name, q, 'drop')
      if (q.name === 'next') return wireChoice(q.name, q, values.find(v => /^P\d+$/.test(v)) ?? values[0])
      return wireChoice(q.name, q, /^claim_/.test(q.name) && values.includes('supported') ? 'supported' : values[0])
    })
  }
  const provider = async (_endpoint, init, tag = null) => {
    const wire = JSON.parse(init.body), names = wire.questions.map(q => q.name)
    const row = { step, feature: tag ?? featureOf(names, wire.prompt_cache_key), names, bytes: Buffer.byteLength(init.body), at: clock, raw: init.body }
    decisions.push(row)
    const answers = await answer(wire)
    return { ok: true, status: 200, text: async () => JSON.stringify({ answers, usage: { input_tokens: 10 } }) }
  }
  const budget = createDecisionBudget({ monthlyInputTokenCap: 5_000_000 })
  const client = createDecisionClient({ recipientForKey: (value, endpoint, model) => decisionTopicRecipient(value, 1, endpoint, model), getApiKey: async () => KEY, fetchImpl: provider, budget })

  // ---- browser card double ----
  const transport = { runs: new Map(), hasClient: id => id === 'ui',
    bindRun: (id, thread, transportId) => { if (transport.runs.has(id)) throw new Error('already bound'); transport.runs.set(id, { clientThreadId: thread, transportId, ownerKey: OWNER }) },
    unbindRun: id => transport.runs.delete(id),
    async sendToUi(request) {
      const reply = { requestId: request.requestId }
      if (request.kind === 'bind') return { ...reply, status: 'bound', binding: { cardId: 'card', cardEpoch: 'epoch', profileId: 'fixture', accountId: '', userContextId: 0, url: `${PORTAL}/invoices`, engineAccountKey: OWNER, authorityEpoch: 1 } }
      if (request.kind === 'observe') { const wait = request.options?.wait; return { ...reply, status: 'observed', snapshot: wait ? { ...snap(), wait: { for: wait.for, outcome: 'met', elapsedMs: 1 } } : snap() } }
      if (request.kind === 'act') { const a = request.action; acts.push({ step, type: a.type, url: a.url ?? null, ref: a.ref ?? null })
        if (a.type === 'navigate') state.cur = { url: a.url, documentId: `doc${++state.docSeq}`, revision: 1 }
        return { ...reply, status: 'acted', receipt: { after: snap(), observation: {}, dispatchReceipt: { actor: 'JSWindowActor', eventDispatched: true, documentStillCurrent: true, inputRoute: 'chrome-load-uri' } } } }
      if (request.kind === 'cancel') return { ...reply, status: 'cancelled' }
      return { ...reply, status: 'rejected' }
    } }
  const browserProvider = createCodexBrowserToolProvider({ transport, getOwnerKey: () => OWNER, decision: { mode: () => state.mode, configured: () => true, client,
    recipient: () => decisionTopicRecipient(KEY, 1, undefined, client.model), generation: () => 0 } })

  // ---- the bridge's own wiring, flag by flag (see codex-bridge-server.mjs) ----
  let wikiAdapter = null
  const turnMemoryConfig = createTurnMemoryConfig({ settings, ontologyStore: { readGraph: async () => GRAPH },
    getAdapter: () => wikiAdapter ??= createWikiAdapter({ writes: openWikiWrites({ dataDir: settingsDir, log() {} }) }) })
  const browserEntryConfig = createBrowserEntryConfig({ now: () => clock, flag: () => ENV.EGDESK_BROWSER_ENTRY, getAdapter: () => turnMemoryConfig.getAdapter(), wiki: args => turnMemoryConfig.wiki(args) })
  const presenceMirror = createPresenceMirror({ now: () => clock })
  let workPlacement = null
  const contexts = new ContextRuntime({ store: new ImmutableContextStore({ dataDir: path.join(dir, 'context'), allowedRoots: [cwd] }), getOwnerKey: () => OWNER })
  const decisionContext = on === null ? undefined : {
    settingsGeneration: () => 0, mode: () => state.mode, configured: () => on === true, client, calibrationLog, budgetMs: 800,
    turnMemory: turnMemoryConfig, browserEntry: browserEntryConfig,
    ...(['advisory', 'on'].includes(ENV.EGDESK_DRAFT_CHECK) ? { draftCheck: { mode: () => ENV.EGDESK_DRAFT_CHECK } } : {}),
    ...(ENV.EGDESK_CONVERSATION_FLOW === 'on' ? { conversationFlow: { mode: () => 'on', ...(ENV.EGDESK_PRESENCE === 'on' ? { presence: presenceMirror } : {}),
      attentionPosted: ({ key, provider: name }) => { if (name === 'work_placement') workPlacement.acknowledgePointer(key) } } } : {}),
    ...(ENV.EGDESK_COMMAND_JUDGE === 'advisory' ? { commandJudge: { mode: () => 'advisory' } } : {}),
    ...(['advisory', 'on'].includes(ENV.EGDESK_TERMINAL_GATE) ? { terminalGate: { mode: () => ENV.EGDESK_TERMINAL_GATE, inspect: async () => null } } : {}),
    ...(['advisory', 'on'].includes(ENV.EGDESK_WORKING_MEMORY) ? { workingMemory: { mode: () => ENV.EGDESK_WORKING_MEMORY } } : {}),
    topicRecipient: () => decisionTopicRecipient(KEY, 1, undefined, client.model), recipientForChatChoice: () => decisionTopicRecipient(KEY, 1, undefined, client.model),
    // The bridge's own collector over the same stores (here: the ontology graph only; no Board, no selected source).
    collect: async ({ body, context }) => (await collectDecisionCandidates({ body, clientThreadId: context.clientThreadId, excludeMessageId: context.localMessageId, chatStore: store, deskStore: null,
      ontologyStore: { readGraph: async () => GRAPH } })).candidates,
  }
  let chat = null
  const notify = (method, params) => chat.handleNotification({ method, params })
  // The scripted subjective engine on a PRIVATE fork: it words one short message, or fills the briefing guide it was handed.
  const forkText = prompt => {
    forkPrompts.push({ step, prompt })
    if (/Design guide \(decided/.test(prompt)) return typeof state.fill === 'function' ? state.fill(prompt) : null
    if (/^Here is your draft answer/.test(prompt)) return state.wording.revise ?? '앞에서 확인한 내용 기준으로, A사 견적은 요청을 받은 뒤 첫 견적서를 보냈고 수정본은 팀장 승인 뒤 보낼 예정입니다.'
    if (/on the desk/.test(prompt)) return state.wording.pointer ?? '결과는 지금 보고 계신 곳 왼쪽 작업 영역에 있습니다. 확인이 필요합니다.'
    if (/ask the person|need one piece of information/.test(prompt)) return state.wording.ask ?? null
    if (/unusually long/.test(prompt)) return state.wording.stalled ?? null
    return state.wording.wait ?? '확인하는 데 시간이 조금 걸리고 있어요. 곧 이어서 말씀드릴게요.'
  }
  chat = new CodexChatRuntime({
    store, requireStore: true, contexts, getOwnerKey: () => OWNER, toolProviders: [browserProvider], verifyFile: async () => null, resolveProjectWorkspace: async () => null,
    profiles: { runProfile: (profileId, revision) => ({ binding: { profileId, revision: revision ?? 1, hash: 'h' }, developerInstructions: 'x', toolCeiling: null, model: null }) },
    now: () => clock, monotonicNow: () => clock,
    setTimer: (fn, ms) => { const timer = { fn, at: clock + Math.max(0, Math.ceil(ms)) }; timers.push(timer); return timer },
    clearTimer: timer => { const i = timers.indexOf(timer); if (i >= 0) timers.splice(i, 1) },
    getBoardPeerContract: () => 'c'.repeat(64),
    respond: (id, result, error) => replies.push({ id, result, error }), emit: e => events.push({ ...e, step }), emitLegacy() {},
    request: async (method, params) => {
      native.push({ step, method, params })
      if (method === 'experimentalFeature/list') return { data: ['browser_use', 'browser_use_external', 'computer_use'].map(name => ({ name, enabled: false, stage: 'stable' })), nextCursor: null }
      if (method === 'mcpServerStatus/list') return { data: [], nextCursor: null }
      if (method === 'config/read') return { config: { developer_instructions: 'Ordinary instructions' }, layers: [] }
      if (method === 'thread/start') return { thread: { id: `thread-${++state.threads}` }, cwd, model: 'configured-model', sandbox: { type: 'readOnly', networkAccess: false }, approvalPolicy: 'never' }
      if (method === 'thread/resume') return { thread: { id: params.threadId, turns: [] }, cwd, sandbox: { type: 'readOnly', networkAccess: false }, approvalPolicy: 'never' }
      if (method === 'thread/unsubscribe') return { status: 'unsubscribed' }
      if (method === 'thread/fork') return { thread: { id: `fork-${++state.forks}`, forkedFromId: params.threadId } }
      if (method === 'turn/steer') { steers.push(params); return { turnId: params.expectedTurnId } }
      if (method === 'turn/start' && String(params.threadId).startsWith('fork-')) {
        const text = forkText(params.input[0].text), turnId = `fturn-${state.forks}-${forkPrompts.length}`
        setTimeout(async () => {
          if (text != null) await notify('item/completed', { threadId: params.threadId, turnId, item: { id: 'f1', type: 'agentMessage', phase: 'final_answer', text } })
          await notify('turn/completed', { threadId: params.threadId, turn: { id: turnId, status: text == null ? 'failed' : 'completed', items: [] } })
        }, 1)
        return { turn: { id: turnId, status: 'inProgress', items: [] } }
      }
      if (method === 'turn/start') { const id = `turn-${++state.turns}`; if (!state.turnsOf.has(params.threadId)) state.turnsOf.set(params.threadId, []); state.turnsOf.get(params.threadId).push(id); return { turn: { id, status: 'inProgress', items: [] } } }
      if (method === 'turn/interrupt') return {}
      throw new Error(`Unexpected native method: ${method}`)
    },
    ...(decisionContext ? { decisionContext } : {}),
  })
  chat.setConnection(true)
  workPlacement = createWorkPlacement({ client, mode: () => state.mode, enabled: () => ENV.EGDESK_WORK_PLACEMENT === 'advisory', calibrationLog, now: () => clock })
  const chatHttp = createChatHttpHandler(chat, async () => {})
  const placementHttp = createWorkPlacementHttpHandler({ placement: workPlacement, heartbeatFor: key => chat.heartbeatFor(key) })
  // The Board/Decisions handler with the briefing flow, as the bridge mounts it (same key, same budget, same calibration log, same provider).
  const board = createBoardPresentationHttpHandler({ credentials: { status: 'configured', writable: true, getApiKey: () => KEY, savedAt: () => 17, hint: () => null }, getMode: () => state.mode, budget, calibrationLog,
    fetchImpl: async (endpoint, init) => { const out = await provider(endpoint, init, 'briefing'); return Response.json(JSON.parse(await out.text())) },
    briefing: briefingDeps({ chat, contexts, enabled: ENV.EGDESK_BRIEFING_FLOW === 'on', order: 'skeleton' }) })
  const http = async (method, p, body) => {
    const req = Object.assign(Readable.from(body === undefined ? [] : [Buffer.from(JSON.stringify(body))]), { url: p, method, socket: { remoteAddress: '127.0.0.1' }, headers: { host: '127.0.0.1:39218', origin: 'chrome://browser', 'content-type': 'application/json' } })
    const res = Object.assign(new EventEmitter(), { setHeader() {}, writeHead(s) { this.status = s }, end(j) { this.body = j ? JSON.parse(j) : null; this.writableEnded = true } })
    const url = new URL(p, 'http://127.0.0.1:39218')
    assert.equal(await placementHttp(req, res, url) || await board(req, res, url) || await chatHttp(req, res, url), true, p)
    return { status: res.status, body: res.body }
  }

  // Settle without waiting on work that waits for virtual time.
  const settle = async () => {
    let quiet = 0, last = -1
    for (let i = 0; i < 120 && quiet < 6; i++) {
      await new Promise(r => setTimeout(r, 2))
      const mark = native.length + events.length + decisions.length + acts.length
      quiet = mark === last ? quiet + 1 : 0; last = mark
    }
  }
  const source = n => ({ id: 'selected-source', kind: 'browser', selectedByUser: true, browserToolPermission: 'interact',
    sourceRef: { viewId: 'card', profileId: 'fixture', accountId: '', uri: `${PORTAL}/invoices` },
    browserToolIdentity: { cardEpoch: 'epoch', userContextId: 0, engineAccountKey: OWNER, authorityEpoch: 1 }, browserToolSelection: { token: `token-${n}`, threadId: state.thread } })
  const w = { clock: () => clock, dir, cwd, chat, store, contexts, client, budget, calibrationLog, settings, turnMemoryConfig, presenceMirror, workPlacement, http, settle, notify,
    events, native, decisions, forkPrompts, acts, steers, replies, anomalies, state, ENV,
    step(name) { step = name }, at: () => clock,
    async advance(ms) {
      const end = clock + ms
      for (;;) { timers.sort((a, b) => a.at - b.at); const next = timers[0]; if (!next || next.at > end) break; timers.shift(); clock = next.at; next.fn(); await settle() }
      clock = end; await settle()
    },
    // Sent the way the composer sends an ordinary DM message (the same body whether or not a reply is open).
    async send(message, extra = {}) {
      const n = ++state.sends
      const out = await chat.send({ message, requestId: `req-${n}`, clientThreadId: state.thread, profileId: AGENT, replyDestination: 'direct', cwd, contextCapabilities: { read: true, reader: true, publishBriefing: true },
        ...(state.last ? { conversationId: state.last.conversationId } : {}), ...extra })
      if (!out.inRun) state.lastOf.set(state.thread, out)
      await settle()
      return out
    },
    browserExtra: () => ({ executionPolicy: { mode: 'browserBounded' }, selectedSources: [source(state.sends + 1)], browserTransportId: 'ui' }),
    // Which local chat the next send / engine notification belongs to (one world can hold several conversations).
    use(thread) { state.thread = thread },
    timing: () => ({ threadId: state.last.conversationId, turnId: state.turnsOf.get(state.last.conversationId).at(-1) }),
    turnStarts: () => native.filter(c => c.method === 'turn/start' && !String(c.params.threadId).startsWith('fork-')),
    // The scripted subjective engine: it streams its final answer the way a real turn does, then the turn ends.
    async answer(text, { end = true, id = null } = {}) {
      const timing = w.timing(), itemId = id ?? `ans-${timing.turnId}`
      await notify('item/started', { ...timing, item: { id: itemId, type: 'agentMessage', phase: 'final_answer', text: '' } })
      for (const part of [text.slice(0, 6), text.slice(6)]) await notify('item/agentMessage/delta', { ...timing, itemId, delta: part })
      await notify('item/completed', { ...timing, item: { id: itemId, type: 'agentMessage', phase: 'final_answer', text } })
      if (end) await w.endTurn()
    },
    async endTurn(status = 'completed') { const timing = w.timing(); await notify('turn/completed', { threadId: timing.threadId, turn: { id: timing.turnId, status, items: [] } }); await w.idle() },
    async idle() { for (let i = 0; i < 6; i++) { await chat.draftCheckIdle?.(); await chat.turnMemoryIdle?.(); await chat.browserRunIdle?.(); await chat.commandJudgeIdle?.(); await workPlacement.idle(); await settle() } },
    note() { const value = w.turnStarts().at(-1)?.params.additionalContext?.egdesk_browser_task?.value; return value ? JSON.parse(value).egdesk_browser_task : null },
    history: (thread = state.thread) => store.listMessages(thread).messages.map(m => [m.role, m.text]),
    runs: () => (state.last ? chat.snapshot(state.last.conversationId).runs : []),
    // Per-step ledgers.
    decisionsIn: name => decisions.filter(d => d.step === name),
    byFeature: name => decisions.filter(d => d.step === name).reduce((m, d) => (m[d.feature] = (m[d.feature] || 0) + 1, m), {}),
    subjectiveTurnsIn: name => ({ main: native.filter(c => c.step === name && c.method === 'turn/start' && !String(c.params.threadId).startsWith('fork-')).length,
      fork: native.filter(c => c.step === name && c.method === 'turn/start' && String(c.params.threadId).startsWith('fork-')).length, steer: native.filter(c => c.step === name && c.method === 'turn/steer').length }),
    activityRowsIn: name => events.filter(e => e.step === name && e.event === 'activity.completed').map(e => { const a = e.details?.activity ?? e.details; return `${a?.kind}:${a?.title ?? ''}` }),
    eventsIn: name => events.filter(e => e.step === name).map(e => e.event),
  }
  return w
}

// ---- screen side: the production reducer (EGDeskChatState) and the Surface's run projection, in a vm --------------------------------
const surface = readFileSync(new URL('../overlay/JS/eg-desk-surface.uc.js', import.meta.url), 'utf8')
function section(from, to) {
  const a = surface.indexOf(from), b = surface.indexOf(to, a + from.length)
  assert.ok(a >= 0 && b > a, 'Surface section: ' + from)
  return surface.slice(a, b)
}
/**
 * screen(w, thread) -> a chat room on the screen side, fed by the world's chat.event stream through the product's reducer path
 * (canAdmitChatEvent -> reduceChatEvent -> syncProtocolRun), or filled from the local store through the real history routes (restore()).
 * bubbles() lists what the render loop draws (it skips only an empty streaming assistant row).
 */
export function screen(w, thread = DM) {
  const protocol = ChatState.createChatProtocolState()
  const room = { id: thread, type: 'dm', title: '방', engineId: 'codex', profileEnabled: true, agentProfileId: AGENT, messages: [], unreadCount: 0, conversationId: null, bindingState: 'fresh', bindingAccountKey: null }
  const state = { codex: { threads: [room], activeThreadId: thread, hudView: 'conversation', authStatus: { isLoggedIn: true, authMode: 'chatgpt', accountId: 'verified-account' }, connected: true, threadDrafts: {}, threadDraftRevisions: {},
    draft: '', liveRevision: 0, chatProtocol: protocol, messageThreadMap: {}, channelContextSupported: true, activityRoomGeneration: 0, chatCapabilities: ['send', 'stream'], isSending: false, replyOpen: false }, contextSuggest: { byThread: {} } }
  const sandbox = { Date: { now: () => w.clock() }, state, protocol, ChatState, console, cloneJson: value => JSON.parse(JSON.stringify(value)), SELF_MEMBER: '나',
    findThreadIndexById: id => state.codex.threads.findIndex(row => row.id === id), memoReadWatches: new Map(), observeMemoReadWatch() {}, markUserMessagesReadBy() {}, attachMemoRepliesFromRun() {},
    memoAskSendReservations: new Map(), clearMemoManualSendNotice: () => false, showMemoManualSendNotice() {}, watchMemoRead: () => ({ current: () => true, release() {} }), scheduleDeskSessionSave() {},
    boardNotice() {}, codexThreadRuntimeConfig: row => ({ threadId: row.id, profileId: AGENT, profileRevision: 1 }), fetchJson: async () => { throw new Error('no network on the screen side') }, emit() {} }
  const mounted = vm.runInNewContext([
    section('  function getCodexThreadById(', '  function withCodexThread('),
    section('  function codexRuns(', '  // Chat status view model'),
    section('  function createCodexMessage(', '  function installCodexBridge('),
    section('    const updateThreadById = (threadId, updater) => {', '    const resetThreadConversations ='),
    section('    function threadBusy(', '    async function requireClaudeContext('),
    '({ threadBusy, syncProtocolRun, updateThreadById, appendMessageToThread, createCodexMessage, codexCurrentRun })',
  ].join('\n'), sandbox, { filename: 'eg-desk-surface.uc.js (run projection)' })
  const room0 = () => state.codex.threads[0]
  let cursor = 0
  const api = { state, protocol, mounted, thread: room0, frames: [],
    bubbles: () => [...room0().messages].filter(m => !(m.role === 'assistant' && m.status === 'streaming' && !m.content)).map(m => [m.role, m.status, m.content]),
    working: () => ChatState.agentWorkingView(mounted.codexCurrentRun(room0()), { connected: true }),
    busy: () => mounted.threadBusy(room0()),
    // The person's own bubble, as the composer appends it before the request leaves; accepted with the bridge's send result.
    sent(text, requestId, out) {
      ChatState.registerChatRequest(protocol, { requestId, clientThreadId: thread, localThreadId: thread, conversationId: room0().conversationId ?? null, authorName: 'Agent' }, state.codex.authStatus, 'codex')
      mounted.appendMessageToThread(thread, mounted.createCodexMessage('user', text, 'submitting', { requestId }), { countUnread: false })
      mounted.syncProtocolRun(ChatState.acceptChatRequest(protocol, { ...out, requestId }, requestId))
    },
    pump() {
      for (; cursor < w.events.length; cursor++) {
        const event = w.events[cursor]
        if (!ChatState.canAdmitChatEvent(protocol, state.codex.threads, event)) continue
        const run = ChatState.reduceChatEvent(protocol, event, ['codex'])
        if (run) mounted.syncProtocolRun(run)
        api.frames.push({ event: event.event, step: event.step, bubbles: api.bubbles(), working: api.working()?.state ?? null, busy: api.busy() })
      }
    },
    async restore() {
      const summaries = (await w.http('GET', '/chat/history/threads?limit=50')).body
      const summary = summaries.threads.find(row => row.clientThreadId === thread)
      assert.ok(summary, 'the room is listed')
      // The product's loader (loadLocalHistoryThread): 100 events a page, each page hydrated into the room, until the store has no more.
      for (let afterSeq = 0, pages = 0; pages < 50; pages++) {
        const page = (await w.http('GET', `/chat/history?clientThreadId=${thread}&afterSeq=${afterSeq}&limit=100`)).body
        const normalized = ChatState.normalizeLocalHistoryPage({ ...page, thread: { ...summary, ...(page.thread || {}) } }, thread)
        assert.ok(normalized && !normalized.knownGap)
        mounted.updateThreadById(thread, current => ChatState.hydrateLocalChatThread(current, normalized, { liveFenceRevision: state.codex.liveRevision }))
        if (!normalized.hasMore) return pages + 1
        assert.ok(Number(normalized.nextCursor) > afterSeq, 'the cursor moves')
        afterSeq = Number(normalized.nextCursor)
      }
      assert.fail('history did not end')
    } }
  return api
}
