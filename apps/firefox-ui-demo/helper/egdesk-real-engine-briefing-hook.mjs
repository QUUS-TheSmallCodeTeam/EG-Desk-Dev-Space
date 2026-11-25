// L4 cycle 31: the briefing flow inside lane L5's real-engine check (helper/egdesk-real-engine-check.mjs), as a HOOK in its own module. The check's composition did not
// reproduce the briefing (EGDESK_BRIEFING_FLOW was listed as not reproduced: no Board presentation route, no chrome). This hook adds exactly what the briefing needs and
// nothing else, and only for a conversation whose script sets EGDESK_BRIEFING_FLOW=on (the check refuses that without --decisions: the briefing runs on Decision calls):
//   - the same capabilities the chrome sends for a Codex room: contextCapabilities { read, reader, publishBriefing } (sendExtra), so a briefing may be proposed;
//   - for a scripted turn whose `expect` has a `briefing` entry, AFTER the answer is posted (the moment the chrome observes it): the product's own request builder
//     (EGDeskBriefingHost.observeRequest) and the production Board/Decisions handler (createBoardPresentationHttpHandler, route /decision/briefing-observe) with the
//     REAL engine's private fork turn as the subjective model (briefingDeps over the check's own CodexChatRuntime), and the Decision model through the check's fetch;
//   - a record of what happened, and the checks of that `expect.briefing` entry (by code, on the record).
// What stays out: the canvas (no cards on a board, so candidates are []), the chrome's timers, the person's own Board. Materials: the runtime's own memory rows when it
// has any for the turn (lane L7's seeding fills them), else the conversation's own folder notes read by code (folderMaterials: a note named MM-DD.md is a dated page; the
// year is a declared constant of this check, the notes state month-day only).
import { createBoardPresentationHttpHandler } from './egdesk-board-presentation-http.mjs'
import { briefingDeps } from './egdesk-briefing-engine.mjs'
import { createDecisionBudget } from './egdesk-decision-client.mjs'
import { statedStatus } from './egdesk-briefing-ledger-materials.mjs'
import * as BriefingHost from '../overlay/resources/EGDeskBriefingHost.sys.mjs'
import { EventEmitter } from 'node:events'
import { Readable } from 'node:stream'

export const BRIEFING_FLAGS = Object.freeze(['EGDESK_BRIEFING_FLOW', 'EGDESK_BRIEFING_OUTPUT_SCHEMA', 'EGDESK_BRIEFING_HAND_MATERIALS'])
export const BRIEFING_LIMITS = Object.freeze({ timeoutMs: 150_000, year: 2026, viewport: Object.freeze({ x: 0, y: 0, width: 2400, height: 1400 }), tokenCap: 5_000_000, strings: 16, stringChars: 400, replyChars: 6000, inputChars: 6000 })
export const BRIEFING_OUTCOMES = Object.freeze(['presented', 'fallback-chat', 'bubble'])
const clip = (text, n) => String(text ?? '').slice(0, n)

// ---- the `expect.briefing` entry of a script turn: its shape (validator + JSON schema) and its checks ----
export const BRIEFING_EXPECT_KEYS = Object.freeze(['outcome', 'reason', 'schemaSent', 'schemaInvalid', 'factsOnBoard', 'factsInCards', 'inOrder'])
export const BRIEFING_EXPECT_SCHEMA = Object.freeze({
  type: 'object', additionalProperties: false,
  properties: {
    outcome: { enum: [...BRIEFING_OUTCOMES] },
    reason: { type: 'string', pattern: '^[a-z][a-z0-9-]{0,40}$' },
    schemaSent: { type: 'boolean' },
    schemaInvalid: { type: ['integer', 'null'], minimum: 0, maximum: 20 },
    factsOnBoard: { type: 'array', maxItems: BRIEFING_LIMITS.strings, items: { type: 'string', minLength: 1, maxLength: BRIEFING_LIMITS.stringChars } },
    // c37: strings that must be in the text of the published CARDS (not the step explanations), and lists of strings that must appear in the cards in that order
    factsInCards: { type: 'array', maxItems: BRIEFING_LIMITS.strings, items: { type: 'string', minLength: 1, maxLength: BRIEFING_LIMITS.stringChars } },
    inOrder: { type: 'array', maxItems: 4, items: { type: 'array', minItems: 2, maxItems: BRIEFING_LIMITS.strings, items: { type: 'string', minLength: 1, maxLength: BRIEFING_LIMITS.stringChars } } },
  },
})
/** [] when the entry is well formed, else the problems as short texts. */
export function validateBriefingExpect(e) {
  const out = []
  if (!e || typeof e !== 'object' || Array.isArray(e)) return ['an object']
  for (const k of Object.keys(e)) if (!BRIEFING_EXPECT_KEYS.includes(k)) out.push(`${k}: unknown key`)
  if (e.outcome !== undefined && !BRIEFING_OUTCOMES.includes(e.outcome)) out.push(`outcome: one of ${BRIEFING_OUTCOMES.join(' / ')}`)
  if (e.reason !== undefined && !(typeof e.reason === 'string' && /^[a-z][a-z0-9-]{0,40}$/.test(e.reason))) out.push('reason: a closed word')
  if (e.schemaSent !== undefined && typeof e.schemaSent !== 'boolean') out.push('schemaSent: a boolean')
  if (e.schemaInvalid !== undefined && e.schemaInvalid !== null && !(Number.isInteger(e.schemaInvalid) && e.schemaInvalid >= 0 && e.schemaInvalid <= 20)) out.push('schemaInvalid: an integer 0-20 or null')
  if (e.factsOnBoard !== undefined && (!Array.isArray(e.factsOnBoard) || e.factsOnBoard.length > BRIEFING_LIMITS.strings || e.factsOnBoard.some(s => typeof s !== 'string' || !s || s.length > BRIEFING_LIMITS.stringChars))) out.push('factsOnBoard: up to 16 strings')
  const strings = v => Array.isArray(v) && v.length <= BRIEFING_LIMITS.strings && v.every(s => typeof s === 'string' && s && s.length <= BRIEFING_LIMITS.stringChars)
  if (e.factsInCards !== undefined && !strings(e.factsInCards)) out.push('factsInCards: up to 16 strings')
  if (e.inOrder !== undefined && !(Array.isArray(e.inOrder) && e.inOrder.length <= 4 && e.inOrder.every(l => strings(l) && l.length >= 2))) out.push('inOrder: up to 4 lists of 2 to 16 strings')
  if (e.outcome !== undefined && e.outcome !== 'presented' && (e.factsOnBoard?.length || e.factsInCards?.length || e.inOrder?.length)) out.push('factsOnBoard / factsInCards / inOrder: only for an outcome presented')
  return out
}
/** The text of the board the briefing made: every card it published and every step it proposed. */
/** The text of the cards the briefing published (what a reader sees on the board's cards, not the step explanations). */
export const cardsText = rec => (rec?.published ?? []).map(p => `${p.title}\n${p.markdown}`).join('\n')
export const boardText = rec => [...(rec?.published ?? []).map(p => `${p.title}\n${p.markdown}`), ...(rec?.steps ?? []).map(s => s.text)].join('\n')
/** checkBriefingExpect(expect, record) -> [{ check, ok, detail }] (names are "briefing.<key>"); a missing record fails every check. */
export function checkBriefingExpect(expect, rec) {
  const out = [], put = (check, ok, detail) => out.push({ check: `briefing.${check}`, ok: ok === true, detail })
  if (!rec) return [{ check: 'briefing.ran', ok: false, detail: { why: 'the briefing hook did not run for this turn (flag off, no answer, or the hook is not attached)' } }]
  // 'presented' is the flow's word; the board counts as proposed only when the runtime also took a proposal with steps
  // the detail carries the WHY (c32): the reason, the stages the flow ran, the fork requests that failed, so a failed outcome never hides its cause
  if (expect.outcome !== undefined) put('outcome', rec.outcome === expect.outcome && (expect.outcome !== 'presented' || (rec.steps ?? []).length > 0), { outcome: rec.outcome, reason: rec.reason ?? null, steps: (rec.steps ?? []).length, stages: rec.flow?.stages ?? null, forkErrors: rec.forkErrors ?? null })
  if (expect.reason !== undefined) put('reason', rec.reason === expect.reason, { reason: rec.reason ?? null })
  if (expect.schemaSent !== undefined) put('schemaSent', expect.schemaSent ? rec.forkTurns > 0 && rec.forkSchemaTurns === rec.forkTurns : rec.forkSchemaTurns === 0, { forkTurns: rec.forkTurns, withSchema: rec.forkSchemaTurns })
  if (expect.schemaInvalid !== undefined) put('schemaInvalid', rec.schemaInvalid === expect.schemaInvalid, { schemaInvalid: rec.schemaInvalid ?? null })
  if (expect.factsInCards) { const text = cardsText(rec), missing = expect.factsInCards.filter(f => !text.includes(f)); put('factsInCards', rec.outcome === 'presented' && missing.length === 0, { missing, cardChars: text.length }) }
  if (expect.inOrder) {
    const text = cardsText(rec), lists = expect.inOrder.map(list => { let from = -1, bad = null; for (const f of list) { const at = text.indexOf(f); if (at < 0) { bad = { missing: f }; break } if (at <= from) { bad = { outOfOrder: f }; break } from = at } return bad })
    put('inOrder', rec.outcome === 'presented' && lists.every(b => b === null), { problems: lists.map((b, i) => (b ? { list: i, ...b } : null)).filter(Boolean) })
  }
  if (expect.factsOnBoard) { const text = boardText(rec), missing = expect.factsOnBoard.filter(f => !text.includes(f)); put('factsOnBoard', rec.outcome === 'presented' && missing.length === 0, { missing, boardChars: text.length }) }
  return out
}

// ---- materials: the conversation's own folder notes, by code ----
/** folderMaterials(folder, { year }) -> rows in lane L7's memory-row shape. A file named MM-DD.md (any directory) is a page dated year-MM-DD, linked follows_from to the previous date; its title is the first
 *  line that is not a heading; its status is read from its words (merged -> done, started / open -> plan) or stays unknown. Nothing else is read. */
export function folderMaterials(folder = {}, { year = BRIEFING_LIMITS.year } = {}) {
  const rows = []
  for (const [file, text] of Object.entries(folder)) {
    // MM-DD.md, or MM-DD-HHMM-topic.md (c37: several entries a day, and entries of more than one topic in one folder)
    const m = /(?:^|\/)(\d{2})-(\d{2})(?:-(\d{4}))?(?:-([a-z][a-z0-9_]*))?\.md$/.exec(file)
    if (!m || !(Number(m[1]) >= 1 && Number(m[1]) <= 12 && Number(m[2]) >= 1 && Number(m[2]) <= 31)) continue
    const lines = String(text).split('\n').map(l => l.replace(/^\s*[-*]\s*/, '').trim()).filter(l => l && !/^#/.test(l)), at = `${year}-${m[1]}-${m[2]}`
    rows.push({ alias: `note-${m[1]}${m[2]}${m[3] ? `-${m[3]}` : ''}${m[4] ? `-${m[4]}` : ''}`, topic: m[4] ?? '', sortKey: `${at}-${m[3] ?? '0000'}-${file}`, kind: 'page', time: { slice: 'past', at }, provenance: { kind: 'document', by: null, basis: 'record_based' }, status: statedStatus(lines.join(' ')),
      title: clip(lines[0] ?? file, 80), excerpt: clip(lines.join(' '), 400), links: [], held: false })
  }
  rows.sort((a, b) => a.sortKey.localeCompare(b.sortKey))
  // c33: the dated notes of one folder are ONE log: each follows the one before it (the product's own ledger materials link consecutive records the same way,
  // helper/egdesk-briefing-ledger-materials.mjs). Without a link the flow reads every note as its own matter (materialGroups) and designs one card per note, never a sequence.
  // c37: one chain per topic (two topics interleaved in time are two matters, each a sequence), and the sort key and topic are the hook's own, not row fields
  const last = new Map()
  for (const row of rows) { const before = last.get(row.topic); if (before) row.links = [{ type: 'follows_from', toAlias: before.alias }]; last.set(row.topic, row) }
  return rows.map(({ topic: _t, sortKey: _k, ...row }) => row)
}

// ---- the hook ----
const localRequest = (method, p, body) => Object.assign(Readable.from(body === undefined ? [] : [Buffer.from(JSON.stringify(body))]), { url: p, method, headers: { host: '127.0.0.1:39218', origin: 'chrome://browser', 'content-type': 'application/json' } })
const localResponse = () => Object.assign(new EventEmitter(), { setHeader() {}, writeHead(s) { this.status = s }, end(j) { this.body = JSON.parse(j); this.writableEnded = true } })

/**
 * The check's registration entry (helper/egdesk-real-engine-hooks.mjs lists it).
 *   active(FLAG)        the hook is attached to a conversation whose flags say EGDESK_BRIEFING_FLOW=on
 *   decisionDependent   flags that need --decisions (the check's preflight refuses them otherwise)
 *   attach(deps)        deps: { chat, contexts, FLAG, conversation, fetchImpl, key, calibrationLog } -> { name, sendExtra(), afterTurn({ run, say, answer, turnIndex }) -> record }
 */
export const briefingHook = Object.freeze({
  name: 'briefing',
  flags: BRIEFING_FLAGS,
  decisionDependent: Object.freeze(['EGDESK_BRIEFING_FLOW']),
  active: FLAG => FLAG?.EGDESK_BRIEFING_FLOW === 'on',
  attach({ chat, contexts, FLAG, conversation, fetchImpl, key, calibrationLog, requestLog = [], limits = {} } = {}) {
    limits ??= {}
    const L = { ...BRIEFING_LIMITS, ...limits }
    const schema = FLAG.EGDESK_BRIEFING_OUTPUT_SCHEMA === 'on'
    const forkCalls = [], published = [], engines = [], proposed = [], decisions = []
    let materialsFrom = null, materialCount = 0
    // what the product's flow calls on the runtime and on the context runtime, recorded on the way through (nothing is changed)
    const recChat = { canInternalTurn: run => chat.canInternalTurn(run), runFor: ids => chat.runFor(ids),
      // the private turn's reply is kept (bounded; the content is the synthetic notes' own): a chat-only outcome shows what the model actually wrote
      internalText: async (run, text, options) => { const call = { schema: Boolean(options?.outputSchema), preamble: options?.preamble !== false, promptChars: String(text).length, reply: null }; forkCalls.push(call); const reply = await chat.internalText(run, text, options); call.reply = reply === null || reply === undefined ? null : clip(reply, L.replyChars); return reply },
      memoryMaterialsFor: run => {
        let rows = []; try { rows = chat.memoryMaterialsFor?.(run) ?? [] } catch { rows = [] }
        if (Array.isArray(rows) && rows.length) { materialsFrom = 'memory'; materialCount = rows.length; return rows }
        const notes = folderMaterials(conversation?.folder ?? {}, { year: L.year }); materialsFrom = notes.length ? 'folder' : 'none'; materialCount = notes.length; return notes
      } }
    const recContexts = { publishOutput: async (run, args) => { published.push({ title: clip(args.title, 200), markdown: clip(args.markdown, 8000) }); return contexts.publishOutput(run, args) },
      proposeBriefing: async (run, args) => { const out = await contexts.proposeBriefing(run, args); proposed.push({ id: out?.id ?? null, steps: (out?.steps ?? []).map(s => ({ id: s.id, text: clip(s.text, 600) })) }); return out } }
    const deps = briefingDeps({ chat: recChat, contexts: recContexts, enabled: true, ...(L.engine ? { limits: L.engine } : {}), outputSchema: schema ? 'on' : 'off',
      order: FLAG.EGDESK_BRIEFING_ORDER === 'design-first' ? 'design-first' : 'skeleton', fillCheck: FLAG.EGDESK_BRIEFING_FILL_CHECK === 'facts' ? 'facts' : 'all', coverage: FLAG.EGDESK_BRIEFING_COVERAGE === 'board' ? 'board' : 'facts' })
    const engineFor = deps.engineFor, engineCalls = []
    // each request of the engine, with why it gave nothing (the engine's lastFailure: timeout | no-reply | refused | unusable) and what it asked (kind, only, cover)
    deps.engineFor = (run, options) => {
      const engine = engineFor(run, options)
      if (!engine) return engine
      const wrapped = async request => { const started = Date.now(), out = await engine(request); engineCalls.push({ kind: String(request?.kind ?? '').slice(0, 40), only: Array.isArray(request?.only) ? request.only.slice(0, 8) : null, cover: Array.isArray(request?.cover) ? request.cover.slice(0, 12) : null, ok: out !== null && out !== undefined, ms: Date.now() - started, failure: engine.lastFailure?.() ?? null }); return out }
      wrapped.stats = engine.stats; wrapped.lastFailure = engine.lastFailure
      engines.push(wrapped); return wrapped
    }
    // what each private turn did inside the runtime (c34): its time, how it ended (an error code, or via fork | fresh), the kinds of item the engine produced, the last token usage;
    // c35: the model and the effort it ran at and where they came from (explicit | request | agent | egdesk | engine), and the prompt size
    const trace = []
    let live = null
    const internal = chat.internalTurns
    if (internal && typeof internal.run === 'function' && typeof internal.feed === 'function') {
      const run0 = internal.run.bind(internal), feed0 = internal.feed.bind(internal)
      internal.feed = message => {
        const handled = feed0(message)
        if (handled && live) {
          const now = Date.now() - live.startedAt; live.firstMs ??= now; live.lastMs = now; live.notifications++
          if (message.method === 'item/completed') { const type = String(message.params?.item?.type ?? '?').slice(0, 40); live.items[type] = (live.items[type] ?? 0) + 1 }
          else if (message.method === 'thread/tokenUsage/updated') { const u = message.params?.tokenUsage?.last; if (u) live.usage = { input: u.inputTokens ?? null, output: u.outputTokens ?? null, reasoning: u.reasoningOutputTokens ?? null } }
          else if (message.method === 'error') live.error = clip(message.params?.error?.message, 200)
          else if (message.method === 'turn/completed') live.status = String(message.params?.turn?.status ?? '?').slice(0, 20)
        }
        return handled
      }
      internal.run = async args => {
        const entry = { schema: Boolean(args?.outputSchema), timeoutMs: args?.timeoutMs ?? null, startedAt: Date.now(), ms: null, via: null, model: null, effort: null, source: null, promptChars: String(args?.text ?? '').length, code: null, status: null, firstMs: null, lastMs: null, notifications: 0, items: {}, usage: null }
        live = entry; trace.push(entry)
        try { const out = await run0(args); entry.via = out?.via ?? null; entry.model = out?.model ?? null; entry.effort = out?.effort ?? null; entry.source = out?.source ?? null; return out } catch (error) { entry.code = String(error?.code ?? error?.name ?? 'error').slice(0, 40); throw error } finally { entry.ms = Date.now() - entry.startedAt; delete entry.startedAt; if (live === entry) live = null }
      }
    }
    const decisionFetch = async (url, init) => {
      const started = Date.now(); let names = []
      try { names = (JSON.parse(String(init?.body ?? '{}')).questions ?? []).map(q => q.name) } catch {}
      const response = await fetchImpl(url, init)
      // what the Decision model answered, as numbers and closed words only (the check's own row has the same shape)
      const p = {}
      try { const body = JSON.parse(await response.clone().text()); for (const a of body.answers ?? []) p[String(a.name ?? '?').slice(0, 60)] = a.type === 'predicate' ? Math.round(a.probability * 100) / 100 : a.type === 'choice' ? String(a.choice ?? '?').slice(0, 40) : String(a.type ?? '?').slice(0, 20) } catch {}
      // the coverage packet (the question per fact of the answer and the board as the Decision model saw it) is kept: it says what the board lacked
      let input = null
      if (names.some(n => String(n).startsWith('onboard_'))) { try { input = clip(JSON.stringify(JSON.parse(String(init?.body ?? '{}')).input), L.inputChars) } catch {} }
      decisions.push({ names, ms: Date.now() - started, status: response?.status ?? null, p, ...(input ? { input } : {}) })
      return response
    }
    const budget = createDecisionBudget({ monthlyInputTokenCap: L.tokenCap })
    const board = createBoardPresentationHttpHandler({ credentials: { getApiKey: () => key, savedAt: () => 1 }, getMode: () => 'on', budget, fetchImpl: decisionFetch, calibrationLog, briefing: deps })
    return {
      name: 'briefing',
      // the same capabilities the chrome sends for a Codex room (EGDeskChatState.sys.mjs contextCapabilitiesForRequest)
      // Cycle 42 (owner direction U13, audit reports/l6-c29-u13-audit.md): EGDESK_BRIEFING_HAND_MATERIALS=on (default OFF) hands the folder's notes to the answering turn, as the product's turn
      // memory hands the pages the Decision model picked (additionalContext): the engine then needs no tool round to read them. Here the "pick" is all of the conversation's notes; the person's
      // message is followed by them, the briefing's own request text is still the person's message alone.
      sendExtra: ({ text } = {}) => ({ contextCapabilities: { read: true, reader: true, publishBriefing: true },
        ...(FLAG.EGDESK_BRIEFING_HAND_MATERIALS === 'on' && typeof text === 'string' && Object.keys(conversation?.folder ?? {}).length
          ? { message: `${text}\n\n${Object.entries(conversation.folder).map(([file, body]) => `--- ${file}\n${String(body).trim()}`).join('\n\n')}` } : {}) }),
      async afterTurn({ run, say, answer, turnIndex = 0 }) {
        const started = Date.now()
        const mark = { trace: trace.length, calls: engineCalls.length, requests: requestLog.length, forks: forkCalls.length, published: published.length, proposed: proposed.length, engines: engines.length, decisions: decisions.length }
        const base = { turnIndex, request: clip(say, 200), schemaFlag: schema, year: L.year, viewport: L.viewport, materialsFrom: null, materials: 0, outcome: null, reason: null }
        const none = reason => ({ ...base, outcome: 'skipped', reason, forkRequests: [], forkErrors: [], forkReplies: [], forkTrace: [], engineCalls: [], flow: null, forkTurns: 0, forkSchemaTurns: 0, schemaInvalid: null, published: [], steps: [], decisions: [], wallMs: 0 })
        if (typeof answer !== 'string' || !answer.trim()) return none('no-answer')
        const body = BriefingHost.observeRequest({ mode: 'on', report: answer, answerId: run.answerId ?? null, conversationId: run.conversationId ?? null, runId: run.runId ?? null, candidates: [], request: say, viewport: L.viewport })
        if (!body) return none('nothing-to-observe')
        let summary = null, error = null, timer
        const call = (async () => { const req = localRequest('POST', '/decision/briefing-observe', body), res = localResponse(); await board(req, res, new URL('/decision/briefing-observe', 'http://127.0.0.1:39218')); return res.body })()
        try { summary = await Promise.race([call, new Promise((_, reject) => { timer = setTimeout(() => reject(Object.assign(new Error('briefing timeout'), { code: 'timeout' })), L.timeoutMs) })]) } catch (e) { error = String(e?.code ?? e?.name ?? 'error').slice(0, 40) } finally { clearTimeout(timer) }
        // the app-server requests this turn's briefing made (the check logs every request with its error code): a refused thread/fork shows here
        const requests = requestLog.slice(mark.requests).filter(r => /^thread\/(?:fork|start)$|^turn\/start$/.test(r.method)).map(r => ({ method: r.method, ms: r.ms, ...(r.error ? { error: String(r.error).slice(0, 40) } : {}) }))
        const engine = engines.at(-1), stats = engines.length > mark.engines && engine ? engine.stats() : null, forks = forkCalls.slice(mark.forks)
        return { ...base, materialsFrom, materials: materialCount,
          // the observe summary: outcome presented | fallback-chat | bubble (the handler's own words), or a skipped answer
          outcome: summary?.outcome ?? (summary?.status === 'skipped' ? 'skipped' : error ? 'error' : null), reason: summary?.reason ?? error ?? null,
          flow: summary ? { status: summary.status ?? null, stages: summary.stages ?? [], judgeRequests: summary.judgeRequests ?? 0, fillTurns: summary.fillTurns ?? 0 } : null,
          // forkRequests: every thread/fork, thread/start and turn/start the briefing's private turns sent, with the error code of a refusal
          forkRequests: requests, forkErrors: requests.filter(r => r.error).map(r => `${r.method}:${r.error}`),
          // forkTrace: per private turn, its time and ending (c34: a null reply says whether it timed out), the kinds of item it produced and its last token usage;
          // engineCalls: per engine request, what it asked (kind, only, cover) and why it gave nothing
          forkTrace: trace.slice(mark.trace), engineCalls: engineCalls.slice(mark.calls),
          // forkReplies: what each private turn answered (null = nothing usable), the board-design model's own words
          forkReplies: forks.map(f => f.reply),
          forkTurns: forks.length, forkSchemaTurns: forks.filter(f => f.schema).length, engineStats: stats ? { turns: stats.turns, refused: stats.refused, elapsedMs: stats.elapsedMs } : null,
          // null when the schema flag is off (the engine does not count it then); an integer when on
          schemaInvalid: schema ? (stats?.schemaInvalid ?? 0) : null,
          published: published.slice(mark.published), steps: proposed.slice(mark.proposed).flatMap(p => p.steps), decisions: decisions.slice(mark.decisions), wallMs: Date.now() - started }
      },
    }
  },
})
