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
import { CodexChatRuntime, TURN_CONTEXT_BUDGET_MS, TURN_CONTEXT_COLD_BUDGET_MS } from '../helper/codex-chat-runtime.mjs'
import { createChatHttpHandler } from '../helper/codex-bridge-http.mjs'
import { openChatStore } from '../helper/egdesk-chat-store.mjs'
import { ImmutableContextStore } from '../helper/egdesk-context-store.mjs'
import { ContextRuntime } from '../helper/egdesk-context-runtime.mjs'
import { createCodexBrowserToolProvider } from '../helper/codex-browser-tool-provider.mjs'
import { createDecisionBudget, createDecisionClient, decisionTopicRecipient } from '../helper/egdesk-decision-client.mjs'
import { openCalibrationLog } from '../helper/egdesk-decision-calibration-log.mjs'
import { openBridgeSettings } from '../helper/egdesk-bridge-settings.mjs'
import { createTurnMemoryConfig, turnMemoryFlagsFromEnv } from '../helper/egdesk-turn-memory-wiring.mjs'
import { createWikiAdapter, openWikiWrites } from '../helper/egdesk-wiki-adapter.mjs'
import { createBrowserEntryConfig } from '../helper/egdesk-browser-entry-wiring.mjs'
import { createPresenceMirror, createRunRequesters } from '../helper/egdesk-presence-mirror.mjs'
import { createWorkPlacement, createWorkPlacementHttpHandler } from '../helper/egdesk-work-placement.mjs'
import { createBoardPresentationHttpHandler } from '../helper/egdesk-board-presentation-http.mjs'
import { briefingDeps } from '../helper/egdesk-briefing-engine.mjs'
import { collectDecisionCandidates } from '../helper/egdesk-decision-candidates.mjs'
import { SYNTHETIC_PAGES, mockJudge } from '../helper/egdesk-wiki-reconstruction.fixture.mjs'
import { PS_NAMES } from '../helper/egdesk-browser-page-state.fixture.mjs'

export const KEY = 'egd-synthetic-not-a-key-0009'
export const OWNER = 'codex:fixture-owner'
export const DM = 'dm-all-on'
export const AGENT = 'sol'
export const PORTAL = 'https://portal.example.test'

// ---- the ontology graph the turn memory reads (public synthetic pages: the A사 quote and the PostgreSQL migration) ----
const SLICE = { past: 'past', present: 'present', planned: 'future', hypothetical: 'hypothetical' }
const GRAPH_PAGES = SYNTHETIC_PAGES.filter(p => /^(quote\/a-|db\/pg-|db\/sqlite)/.test(p.id) && !p.scope)
export const GRAPH = { snapshots: [],
  // the date and status each synthetic page records travel with its node, as an ontology node records them (at, status; L7 c17)
  nodes: GRAPH_PAGES.map(p => ({ id: p.id, label: p.title, body: p.body, timeSlice: SLICE[p.time.slice] ?? 'present', ...(p.time.at ? { at: p.time.at } : {}), ...(typeof p.status === 'string' ? { status: p.status } : {}) })),
  edges: GRAPH_PAGES.flatMap(p => (p.links || []).filter(l => GRAPH_PAGES.some(q => q.id === l.to)).map(l => ({ source: p.id, target: l.to, relation: l.type }))) }

// ---- the browser card double (the portal of the browser-task journeys) ----
const el = (ref, role, label, extra = {}) => ({ ref, role, label, tag: role === 'link' ? 'a' : 'button', href: '', value: '', ...extra })
const PAGES = {
  [`${PORTAL}/invoices`]: [el('b1', 'link', '사업자 123-45-67890', { href: `${PORTAL}/biz/1` }), el('b2', 'link', '사업자 987-65-43210', { href: `${PORTAL}/biz/2` }), el('s1', 'button', '발행 제출')],
  [`${PORTAL}/biz/2`]: [el('d2', 'link', '이번 달 세금계산서 다운로드', { href: `${PORTAL}/download/2.pdf` })],
  [`${PORTAL}/biz/1`]: [el('d1', 'link', '이번 달 세금계산서 다운로드', { href: `${PORTAL}/download/1.pdf` })],
  [`${PORTAL}/download/2.pdf`]: [], [`${PORTAL}/download/1.pdf`]: [],
}

// The scripted subjective model's fill for a briefing guide, written the way a careful model follows the fill rules (cycle 14): every line,
// value and explanation is taken from the material it cites, keeping its actors, qualifiers, amounts and dates (whole sentences of the
// material, or a value that the material states for the same aspect); nothing a material does not say. Before cycle 14 it wrote material
// titles as lines, the same title on both sides of a comparison row and "…의 내용입니다." as explanations; the first real run's fill check
// (c17) flagged exactly those, rightly. A redo prompt (rejected parts listed) drops what was rejected rather than repeating it.
const clip = (text, max) => (text.length > max ? text.slice(0, max - 1) + '…' : text)
const sentencesOf = text => String(text ?? '').split(/(?<=\.)\s+/).map(x => x.trim()).filter(Boolean)
// A whole sentence (never cut inside one): the first one that fits, else the text clipped.
const fitSentence = (list, max) => list.find(x => x.length <= max) ?? clip(list[0] ?? '', max)
const dayOf = at => (typeof at === 'string' && /^\d{4}-\d{2}-\d{2}/.test(at) ? `${Number(at.slice(5, 7))}월 ${Number(at.slice(8, 10))}일` : null)
const NOT_DONE = /아직|예정|않았|기다리|전이다|후 발송/
const ASPECTS = ['단가', '납기', '수량']
const aspectValue = (text, word) => new RegExp(`${word}\\s*(?:는|은|가|를)?\\s*([\\d,]+원|\\d+월 \\d+일|\\d+개)`).exec(text)?.[1] ?? null
const stateSentence = m => sentencesOf(m.text).find(x => (m.status === 'plan' ? NOT_DONE.test(x) : /했다|했음|함\.$/.test(x) && !NOT_DONE.test(x))) ?? null
const commonPrefix = titles => { const words = titles.map(t => t.split(' ')); const out = []; for (let i = 0; words.every(w => w[i] !== undefined && w[i] === words[0][i]); i++) out.push(words[0][i]); return out.join(' ') }
export function fillFromGuide(prompt) {
  const guide = JSON.parse(/Design guide \(decided; do not change it\):\n(.*)\n\nMaterials:/s.exec(prompt)[1]), mats = JSON.parse(/Materials:\n(.*)\n\nRules:/s.exec(prompt)[1])
  const M = Object.fromEntries(mats.map(m => [m.alias, m]))
  const only = /Fill only these items again: ([^\n]*?)\.\n/.exec(prompt)?.[1]?.split(/,\s*/) ?? null
  const rejected = (/previous data not supported by the material they cite: ([^\n]*?)\. Write them again/.exec(prompt)?.[1] ?? '').split(/;\s*/).filter(Boolean)
  const unfillable = []
  const items = {}
  for (const item of guide.items) {
    if (only && !only.includes(item.id)) continue
    const mine = item.materials.map(alias => M[alias]).filter(Boolean)
    const drop = rejected.filter(part => part.startsWith(`${item.id} `)).map(part => part.slice(item.id.length + 1))
    const slots = {}, slotOf = name => item.slots.find(slot => slot.name === name)
    let text = ''
    if (slotOf('lines')) {
      const spec = slotOf('lines'), field = name => spec.of.find(x => x.name === name)
      let lines = item.shows === 'open_items'
        ? mine.flatMap(m => sentencesOf(m.text).filter(x => NOT_DONE.test(x)).map(x => ({ label: clip(m.title, field('label')?.max ?? 24), text: fitSentence([x], field('text')?.max ?? 90), from: m.alias })))
        : mine.map(m => ({ label: clip(dayOf(m.at) ?? m.title, field('label')?.max ?? 24), text: fitSentence(sentencesOf(m.text), field('text')?.max ?? 90), from: m.alias }))
      lines = lines.filter((_, i) => !drop.includes(`line ${i + 1}`)).slice(0, spec.max ?? 6)
      if (lines.length < (spec.min ?? 1)) unfillable.push({ item: item.id, slot: 'lines', reason: 'the materials do not say it' })
      else slots.lines = lines
      // The explanation says only what the lines show: their dates for a sequence, the open line itself otherwise.
      const dated = (slots.lines ?? []).map(x => x.label).filter(label => /^\d+월 \d+일$/.test(label))
      text = item.shows === 'sequence' && dated.length >= 2 ? `${dated[0]}부터 ${dated.at(-1)}까지 ${dated.length}건의 기록입니다.` : (slots.lines?.[0]?.text ?? '')
    }
    if (slotOf('rows')) {
      const [older, newer] = mine, spec = slotOf('rows'), max = spec.of.find(x => x.name === 'left')?.max ?? 60
      let rows = []
      if (older && newer) {
        for (const word of ASPECTS) { const l = aspectValue(older.text, word), r = aspectValue(newer.text, word); if (l && r) rows.push({ aspect: word, left: l, right: r }) }
        const l = stateSentence(older), r = stateSentence(newer)
        if (l && r && l.length <= max && r.length <= max) rows.push({ aspect: '상태', left: l, right: r })
      }
      rows = rows.filter((_, i) => !drop.includes(`row ${i + 1} left`) && !drop.includes(`row ${i + 1} right`)).slice(0, spec.max ?? 6)
      if (rows.length < (spec.min ?? 1)) unfillable.push({ item: item.id, slot: 'rows', reason: 'the materials do not say it' })
      else slots.rows = rows
      if (slotOf('left')) slots.left = older?.alias
      if (slotOf('right')) slots.right = newer?.alias
      text = (slots.rows ?? []).map(row => `${row.aspect}: ${row.left} → ${row.right}`).join(' / ')
    }
    if (slotOf('body')) { slots.body = fitSentence([mine[0]?.text ?? ''], slotOf('body').max ?? 600); text = fitSentence(sentencesOf(mine[0]?.text), 240) }
    for (const slot of item.slots) if (slot.type === 'material' && slots[slot.name] === undefined) slots[slot.name] = item.materials[0]
    if (slotOf('title')) slots.title = clip(mine.length === 1 ? mine[0].title : commonPrefix(mine.map(m => m.title)) || mine[0]?.title || '', slotOf('title').max ?? 40)
    if (drop.includes('explanation')) text = slots.lines?.[0]?.text ?? slots.rows?.map(row => `${row.aspect}: ${row.left} → ${row.right}`).join(' / ') ?? text
    if (!text.trim()) text = fitSentence(sentencesOf(mine[0]?.text), 240) // never an empty explanation: the first sentence of its material
    items[item.id] = { text: clip(text, 240), fallback: clip(`${mine[0]?.title ?? ''} 카드를 열어 보세요.`, 400), slots }
  }
  const title = commonPrefix(mats.map(m => m.title)) || mats[0]?.title || ''
  return '```json\n' + JSON.stringify({ title: clip(`${title} 정리`.trim(), guide.titleMax ?? 120), items, ...(unfillable.length ? { unfillable } : {}) }) + '\n```'
}

const wireChoice = (name, q, value, p = 0.95) => { const other = q.choices.map(c => c.value).find(v => v !== value); return { name, type: 'choice', choice: value, confidence: p, probabilities: [{ value, probability: p + 0.01 }, ...(other === undefined ? [] : [{ value: other, probability: 0.02 }])] } }
const MEMORY_Q = /^(pg_|st_|op_|tn_|tw_|speech_)/

/**
 * callerOf(stack) -> { caller, origin }: who handed this body to the provider. caller is the first module below this file on the stack (the
 * product's Decision client for every request the product builds); origin lists the product modules on the stack, nearest first.
 * Used to label requests and, in the live measurement, to refuse any body that did not come from the product client.
 */
const deepStack = () => { const limit = Error.stackTraceLimit; Error.stackTraceLimit = 60; try { return new Error().stack } finally { Error.stackTraceLimit = limit } }
export function callerOf(stack) {
  const mods = [...String(stack).matchAll(/\/(helper|overlay\/resources|overlay\/JS|scripts)\/([A-Za-z0-9._-]+\.m?js)/g)].map(m => `${m[1]}/${m[2]}`)
  const self = mods.findIndex(m => m === 'scripts/egdesk-all-on.support.mjs')
  const below = (self >= 0 ? mods.slice(self) : mods).filter(m => m !== 'scripts/egdesk-all-on.support.mjs')
  return { caller: below[0] ?? null, origin: below.filter((m, i, list) => list.indexOf(m) === i && !m.startsWith('scripts/')).slice(0, 6) }
}

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
  if (names.some(n => /^(claim_|present_|sup_|tense_)/.test(n)) || cacheKey === 'draft-check') return 'draft_check'
  // work placement (L1 c12): yes/no content questions (same_matter_R#, owner_action) under its own cache key
  if (cacheKey === 'work-placement') return 'work_placement'
  if (names.includes('place') || names.includes('attention')) return cacheKey === 'work-placement' ? 'work_placement' : 'briefing'
  if (names.includes('answer_type') || names.includes('time_intent') || names.some(n => /^rel_/.test(n))) return 'turn_context'
  if (names.includes('terminal_state')) return 'command_judge'
  if (cacheKey) return cacheKey
  return `other:${names.slice(0, 3).join(',')}`
}

/**
 * scriptedDecisions({ policy }) -> { answer(wire) -> answers[] }: the scripted Decision model of these journeys (keyed by question names; the
 * memory questions go to the wiki fixture's lexical judge). It is used when no transport is given, and by tests as a mock provider behind the
 * network layer. policy: per-question overrides, policy.message(kinds, text) for the heartbeat's message judgment.
 */
export function scriptedDecisions({ policy = {} } = {}) {
  const judge = mockJudge()
  const answer = wire => {
    const flat = content => (typeof content === 'string' ? content : Array.isArray(content) ? content.map(part => (typeof part?.text === 'string' ? part.text : JSON.stringify(part))).join('\n') : JSON.stringify(content))
    const names = wire.questions.map(q => q.name), text = (Array.isArray(wire.input) ? wire.input.map(m => flat(m.content)) : [String(wire.input)]).join('\n\n')
    // L8 c20: the entry is yes/no predicates (browser_entry: is it a web task; browser_entry_card_N: on this card)
    const isTask = /세금계산서/.test(/(?:User message: |Message:\n)(.*)/.exec(text)?.[1] ?? '')
    const entry = q => ({ name: q.name, type: 'predicate', probability: q.name === 'browser_entry' ? (isTask ? 0.95 : 0.05) : q.name === 'browser_entry_card_0' && isTask ? 0.95 : 0.03 })
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
      return judge.decide({ input: wire.input, questions: wire.questions.filter(q => !/^browser_entry/.test(q.name)) }).then(out => [
        ...Object.entries(out.answers).map(([name, a]) => ({ name, ...a })), ...wire.questions.filter(q => /^browser_entry/.test(q.name)).map(entry)])
    }
    if (names[0] === 'browser_entry') return wire.questions.map(entry)
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
      // L8 c16: the product asks the page state as predicates; the double answers them as an ordinary page (all decided no)
      return [a, ...PS_NAMES.map(name => ({ name, type: 'predicate', probability: 0.02 })), { name: 'page_state', type: 'choice', choice: 'content', confidence: 0.95, probabilities: [{ value: 'content', probability: 0.95 }] }, { name: 'goal_met', type: 'predicate', probability: goalMet }]
    }
    // Turn-context selection (the earlier Decision feature): a catalog item is needed when it is about the thing the message names.
    const topic = names.includes('answer_type') ? text.slice(text.lastIndexOf('Message:\n') + 9) : ''
    const topicKey = /A사/.test(topic) ? /A사/ : /PostgreSQL|마이그레이션/.test(topic) ? /PostgreSQL|마이그레이션/ : null
    return wire.questions.map(q => {
      if (typeof policy[q.name] === 'function') return wireChoice(q.name, q, policy[q.name](q, text))
      if (/^rel_\d+$/.test(q.name) && names.includes('answer_type')) { const line = new RegExp(`^#${q.name.slice(4)}\\b[^\\n]*`, 'm').exec(text)?.[0] ?? ''; return { name: q.name, type: 'predicate', probability: topicKey && topicKey.test(line) ? 0.95 : 0.03 } }
      // briefing skeleton (L4 cycles 15-19: yes/no predicates only): several materials are needed together, the answer combines several facts, the board covers the request (cycle 21: each fact is on the board), the materials are what was asked
      // about, no unresolved pair is two versions (falls to the 0.03 default below), every content requirement holds, the tied pairs
      // keep the code's order, every filled piece is supported by its source
      if (q.type === 'predicate' && (q.name === 'several' || q.name === 'combines' || q.name === 'covers' || /^(?:about|aspect|happened|todo|fact|before|slot|step|onboard)_/.test(q.name))) return { name: q.name, type: 'predicate', probability: 0.96 }
      // the draft check's predicate design (L3 c18 default): a sound judge says supported (as claim_ answers 'supported' below); tense_ falls to 0.03
      if (q.type === 'predicate' && /^sup_\d+$/.test(q.name)) return { name: q.name, type: 'predicate', probability: 0.96 }
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
  return { answer }
}

/**
 * allOnWorld(t, { on, env, onePacket }) → the world. on:true = every feature on; on:false = the bridge's default (every flag unset,
 * Decisions mode off); on:null = a runtime with no decisionContext at all (a bridge before any of these features).
 * env: flag values that differ from "every feature on" (for example { EGDESK_WORK_PLACEMENT: 'advisory' }).
 * transport: async ({ body, wire, row }) -> { status, json } | throws. Where each Decisions request body goes (default: the scripted answers).
 *   body is the exact string the product's Decision client built. settleLimitMs: how long settle() waits for requests still on their way.
 * onePacket: shorthand for the bridge's developer flag EGDESK_TURN_MEMORY_ONE_PACKET=on (the turn-memory pages ride under the context
 *   selection's packet). The flag goes through turnMemoryFlagsFromEnv exactly as in codex-bridge-server.mjs; default off like the bridge.
 */
export function allOnWorld(t, { on = true, policy = {}, env = {}, onePacket = false, transport: decisionTransport = null, settleLimitMs = 60_000, budgets = 'single' } = {}) {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'egd-all-on-')); chmodSync(dir, 0o700)
  const cwd = path.join(dir, 'workspace'); mkdirSync(cwd)
  const store = openChatStore({ dataDir: path.join(dir, 'chat'), ownerScope: 'synthetic-all-on' })
  t.after(() => { try { store.close() } catch {} rmSync(dir, { recursive: true, force: true }) })
  const settingsDir = path.join(dir, 'settings')
  const settings = openBridgeSettings({ dataDir: settingsDir, log() {} })
  const calibrationLog = openCalibrationLog({ dataDir: settingsDir, log() {} })
  const ENV = on === true
    ? { EGDESK_DRAFT_CHECK: 'on', EGDESK_CONVERSATION_FLOW: 'on', EGDESK_PRESENCE: 'on', EGDESK_BROWSER_ENTRY: 'on', EGDESK_COMMAND_JUDGE: 'advisory', EGDESK_TERMINAL_GATE: 'advisory',
      EGDESK_WORKING_MEMORY: 'on', EGDESK_WORK_PLACEMENT: 'on', EGDESK_BRIEFING_FLOW: 'on', ...env, ...(onePacket === true ? { EGDESK_TURN_MEMORY_ONE_PACKET: 'on' } : {}) }
    : { ...(onePacket === true ? { EGDESK_TURN_MEMORY_ONE_PACKET: 'on' } : {}) }
  let clock = Date.parse("2026-11-25T01:00:00Z"), step = 'setup'
  const timers = [], events = [], native = [], decisions = [], forkPrompts = [], acts = [], steers = [], replies = [], anomalies = []
  const scripted = scriptedDecisions({ policy })
  const state = { cur: { url: `${PORTAL}/invoices`, documentId: 'doc1', revision: 1 }, docSeq: 1, threads: 0, forks: 0, turns: 0, turnsOf: new Map(), thread: DM, lastOf: new Map(), sends: 0, mode: on === true ? 'on' : 'off', fill: fillFromGuide, wording: {} }
  Object.defineProperty(state, 'last', { get: () => state.lastOf.get(state.thread) ?? null })
  const snap = () => ({ cardId: 'card', documentId: state.cur.documentId, revision: state.cur.revision, url: state.cur.url, readyState: 'complete', text: ['합성 포털'],
    viewport: { width: 300, height: 200, devicePixelRatio: 1 }, interactiveElements: PAGES[state.cur.url] })

  // ---- ONE Decisions provider for every feature: it records each request under its feature and the journey step ----
  // The body is the exact string the product's Decision client built; it goes to the transport unchanged (scripted answers unless one is given).
  // A request whose caller (the product client) gave up on it (its signal aborted) is answered with an AbortError at once; the transport's work
  // still runs to its end and is recorded (abandoned: true), and settle() waits for it.
  let inflight = 0
  const scriptedTransport = async ({ wire }) => ({ status: 200, json: { answers: await scripted.answer(wire), usage: { input_tokens: 10 } } })
  const provider = async (_endpoint, init, tag = null) => {
    const body = String(init.body), wire = JSON.parse(body), names = wire.questions.map(q => q.name)
    const row = { step, feature: tag ?? featureOf(names, wire.prompt_cache_key), names, bytes: Buffer.byteLength(body), at: clock, raw: body, ...callerOf(deepStack()) }
    decisions.push(row)
    inflight++
    const started = performance.now()
    const net = (async () => { try { return await (decisionTransport ?? scriptedTransport)({ body, wire, row }) } catch (error) { return { error: error?.code ?? error?.name ?? 'transport_failed' } } })()
      .then(out => { Object.assign(row, { elapsedMs: Math.round(performance.now() - started), ...(out.error ? { error: out.error } : { status: out.status, answers: out.json?.answers ?? null, usage: out.json?.usage ?? null }) }); return out })
      .finally(() => { inflight-- })
    const signal = init.signal, ABANDONED = Symbol('abandoned')
    const gaveUp = signal ? new Promise(resolve => (signal.aborted ? resolve(ABANDONED) : signal.addEventListener('abort', () => resolve(ABANDONED), { once: true }))) : new Promise(() => {})
    const first = await Promise.race([net, gaveUp])
    if (first === ABANDONED) { row.abandoned = true; throw Object.assign(new Error('aborted'), { name: 'AbortError' }) }
    if (first.error) throw Object.assign(new Error('the Decisions transport failed'), { name: 'TypeError' })
    return { ok: first.status === 200, status: first.status, headers: { get: () => null }, text: async () => JSON.stringify(first.json ?? {}) }
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
  const turnMemoryConfig = createTurnMemoryConfig({ settings, ...turnMemoryFlagsFromEnv(ENV), ontologyStore: { readGraph: async () => GRAPH },
    getAdapter: () => wikiAdapter ??= createWikiAdapter({ writes: openWikiWrites({ dataDir: settingsDir, log() {} }) }) })
  const browserEntryConfig = createBrowserEntryConfig({ now: () => clock, flag: () => ENV.EGDESK_BROWSER_ENTRY, getAdapter: () => turnMemoryConfig.getAdapter(), wiki: args => turnMemoryConfig.wiki(args) })
  const presenceMirror = createPresenceMirror({ now: () => clock })
  const runRequesters = createRunRequesters({ presence: presenceMirror, now: () => clock })
  let workPlacement = null
  const contexts = new ContextRuntime({ store: new ImmutableContextStore({ dataDir: path.join(dir, 'context'), allowedRoots: [cwd] }), getOwnerKey: () => OWNER })
  const decisionContext = on === null ? undefined : {
    settingsGeneration: () => 0, mode: () => state.mode, configured: () => on === true, client, calibrationLog,
    // budgets 'bridge' (cycle 15, opt-in): the bridge's turn_context budgets, warm 800 ms and cold 1,500 ms (first turn of a conversation, or
    // no warm Decisions socket; warm here once a Decisions request of this world has been answered). Default: one 800 ms budget, as before
    // (other lanes' tests reproduce runs made with it).
    budgetMs: TURN_CONTEXT_BUDGET_MS, ...(budgets === 'bridge' ? { coldBudgetMs: TURN_CONTEXT_COLD_BUDGET_MS, warm: () => decisions.some(row => row.status === 200) } : {}),
    turnMemory: turnMemoryConfig, browserEntry: browserEntryConfig,
    ...(['advisory', 'on'].includes(ENV.EGDESK_DRAFT_CHECK) ? { draftCheck: { mode: () => ENV.EGDESK_DRAFT_CHECK } } : {}),
    ...(ENV.EGDESK_CONTEXT_RELEVANCE === 'action' ? { relevanceRules: 'action' } : {}), // as the bridge: the selection's 'action' rule set (L7 c20), default off
    ...(ENV.EGDESK_CONVERSATION_FLOW === 'on' ? { conversationFlow: { mode: () => 'on', ...(ENV.EGDESK_PRESENCE === 'on' ? { presence: presenceMirror, audience: ({ run }) => runRequesters.audience({ run }) } : {}),
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
    if (/on the desk/.test(prompt)) { const pointer = typeof state.wording.pointer === 'function' ? state.wording.pointer(prompt) : state.wording.pointer; return pointer ?? '결과는 지금 보고 계신 곳 왼쪽 작업 영역에 있습니다. 확인이 필요합니다.' }
    if (/ask the person|need one piece of information/.test(prompt)) return state.wording.ask ?? null
    if (/unusually long/.test(prompt)) return state.wording.stalled ?? null
    // wording.wait may be a function of the prompt (a writer that words the note from the facts it was given).
    const wait = typeof state.wording.wait === 'function' ? state.wording.wait(prompt) : state.wording.wait
    return wait ?? '확인하는 데 시간이 조금 걸리고 있어요. 곧 이어서 말씀드릴게요.'
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
        forkPrompts.at(-1).text = text // what the scripted subjective model wrote on that fork (null: it wrote nothing)
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
  // as the bridge mounts it (codex-bridge-server.mjs), including the run's own request/answer and gate for the content questions (L1 c12)
  workPlacement = createWorkPlacement({ client, mode: () => state.mode, enabled: () => ['advisory', 'on'].includes(ENV.EGDESK_WORK_PLACEMENT), live: () => ENV.EGDESK_WORK_PLACEMENT === 'on', calibrationLog, now: () => clock,
    contextFor: (key, options) => chat.placementContextFor(key, options) })
  const chatHttp = createChatHttpHandler(chat, async () => {})
  const placementHttp = createWorkPlacementHttpHandler({ placement: workPlacement, heartbeatFor: key => chat.heartbeatFor(key) })
  // The Board/Decisions handler with the briefing flow, as the bridge mounts it (same key, same budget, same calibration log, same provider).
  const board = createBoardPresentationHttpHandler({ credentials: { status: 'configured', writable: true, getApiKey: () => KEY, savedAt: () => 17, hint: () => null }, getMode: () => state.mode, budget, calibrationLog,
    fetchImpl: async (endpoint, init) => { const out = await provider(endpoint, init, 'briefing'); return new Response(await out.text(), { status: out.status, headers: { 'content-type': 'application/json' } }) },
    briefing: briefingDeps({ chat, contexts, enabled: ENV.EGDESK_BRIEFING_FLOW === 'on', order: 'skeleton' }) })
  const http = async (method, p, body) => {
    const req = Object.assign(Readable.from(body === undefined ? [] : [Buffer.from(JSON.stringify(body))]), { url: p, method, socket: { remoteAddress: '127.0.0.1' }, headers: { host: '127.0.0.1:39218', origin: 'chrome://browser', 'content-type': 'application/json' } })
    const res = Object.assign(new EventEmitter(), { setHeader() {}, writeHead(s) { this.status = s }, end(j) { this.body = j ? JSON.parse(j) : null; this.writableEnded = true } })
    const url = new URL(p, 'http://127.0.0.1:39218')
    assert.equal(await placementHttp(req, res, url) || await board(req, res, url) || await chatHttp(req, res, url), true, p)
    return { status: res.status, body: res.body }
  }

  // Settle without waiting on work that waits for virtual time.
  // A Decision request still on its way counts as activity (a real provider answers in seconds), bounded by settleLimitMs of wall time.
  const settle = async () => {
    let quiet = 0, last = -1
    const until = performance.now() + settleLimitMs
    for (let i = 0; i < 120 && quiet < 6; i++) {
      await new Promise(r => setTimeout(r, 2))
      if (inflight > 0 && performance.now() < until) { quiet = 0; i--; continue }
      const mark = native.length + events.length + decisions.length + acts.length
      quiet = mark === last ? quiet + 1 : 0; last = mark
    }
  }
  const source = n => ({ id: 'selected-source', kind: 'browser', selectedByUser: true, browserToolPermission: 'interact',
    sourceRef: { viewId: 'card', profileId: 'fixture', accountId: '', uri: `${PORTAL}/invoices` },
    browserToolIdentity: { cardEpoch: 'epoch', userContextId: 0, engineAccountKey: OWNER, authorityEpoch: 1 }, browserToolSelection: { token: `token-${n}`, threadId: state.thread } })
  const w = { inflight: () => inflight, clock: () => clock, dir, cwd, chat, store, contexts, client, budget, calibrationLog, settings, turnMemoryConfig, presenceMirror, runRequesters, workPlacement, http, settle, notify,
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
// onEvent(event, run) (L1 c17): what the product's loop calls next for every admitted chat event (state.noteWorkChatEvent), e.g. a window's work functions
export function screen(w, thread = DM, { onEvent = null } = {}) {
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
        if (typeof onEvent === 'function') onEvent(event, run)
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
