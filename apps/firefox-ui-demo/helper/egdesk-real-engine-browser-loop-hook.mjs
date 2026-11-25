// L8 c34: the whole browser loop on the REAL engine, with fixture pages (registered in helper/egdesk-real-engine-registrations.mjs, slot L8).
//
// One scripted turn = the person's message. BEFORE it is sent (the product does its entry before the native turn too) the hook runs the product's own turn-start entry
// (createDirectBrowserEntry): the entry judgement is asked of the REAL Decision model (the check's own client, `--decisions`), it picks the card, the product's objective loop
// runs its steps against recorded fixture page states (the synthetic worlds of the live measurement: no Firefox, no network, nothing real), and the closed note it ends with is
// put into the SAME engine turn (additionalContext.egdesk_browser_task, through the runtime's internal-blocks seam, as the earlier c31 hook does). The real reply is then checked, by code:
//   the entry decision (entered, which predicates), the step choices (what was opened, no action on a person-only control), the note (status, code, named controls, page lines),
//   what reached the engine (byte for byte) and the reply (facts stated, no invented date or amount, no claim that a hand-over was done).
// Fixtures only: the pages are the hold-out families' own synthetic pages; the Decision model sees what the product sends it, nothing of a person.
import { createBrowserTaskStore, createDirectBrowserEntry } from './egdesk-browser-task.mjs'
import { createCodexBrowserToolProvider } from './codex-browser-tool-provider.mjs'
import { decisionTopicRecipient } from './egdesk-decision-client.mjs'
import { OWNER, pageWorld } from './egdesk-browser-live-runner.mjs'
import { HARD_PAGES } from './egdesk-browser-live-hard.mjs'
import { NOTE_KEY, checkBrowserAnswer, runDates } from './egdesk-real-engine-browser-answer-hook.mjs'

export const BROWSER_LOOP_FLAG = 'EGDESK_BROWSER_LOOP'
export const LOOP_PAGES = Object.freeze(['membership', 'delivery', 'settings', 'library', 'ticket', 'room', 'queue', 'pension'])
const str = (max, extra = {}) => ({ type: 'string', minLength: 1, maxLength: max, ...extra })
export const BROWSER_LOOP_SCHEMA = Object.freeze({ type: 'object', additionalProperties: false, required: ['pages', 'host', 'start', 'title'], properties: {
  pages: { enum: [...LOOP_PAGES] }, host: str(80, { pattern: '^[a-z0-9.-]+\\.example\\.test$' }), start: str(80, { pattern: '^/' }), title: str(120),
  // c35: the live page changes under the loop (the first navigate or click is refused as stale and the page at `from` becomes the page kept at `to`)
  staleSwap: { type: 'object', additionalProperties: false, required: ['from', 'to'], properties: { from: str(80, { pattern: '^/' }), to: str(80, { pattern: '^/' }) } } } })
export const BROWSER_LOOP_EXPECT_SCHEMA = Object.freeze({ type: 'object', additionalProperties: false, properties: {
  entered: { const: true },
  navigatedTo: { type: 'array', maxItems: 4, items: str(120) },
  noActs: { const: true },
  noteStatus: { enum: ['done', 'cannot_proceed', 'need_context'] },
  noteCode: str(40),
  noteCandidates: { type: 'array', maxItems: 3, items: str(100) },
  noteIncludes: { type: 'array', maxItems: 4, items: str(200) },
  mentionsDates: { type: 'array', maxItems: 4, items: str(10, { pattern: '^\\d{4}-\\d{2}-\\d{2}$' }) },
  noInventedDates: { const: true }, noInventedAmounts: { const: true },
  // c35: the flows that are harder
  noFills: { const: true },
  clickedOnly: { type: 'array', maxItems: 4, items: str(40) },
  staleSeen: { const: true },
  afterStaleSees: { type: 'array', maxItems: 3, items: str(120) },
  noteExcludes: { type: 'array', maxItems: 4, items: str(120) },
  namesAnyOf: { type: 'array', minItems: 1, maxItems: 6, items: str(100) },
} })
const isObject = v => v !== null && typeof v === 'object' && !Array.isArray(v)
const textList = (v, max, chars) => Array.isArray(v) && v.length <= max && v.every(x => typeof x === 'string' && x.length >= 1 && x.length <= chars)
export function validateBrowserLoop(value, conv, path = 'browserLoop') {
  const bad = []
  if (!isObject(value)) return [`${path}: must be an object`]
  for (const key of Object.keys(value)) if (!['pages', 'host', 'start', 'title', 'staleSwap'].includes(key)) bad.push(`${path}.${key}: not a field`)
  if (value.staleSwap !== undefined && !(isObject(value.staleSwap) && Object.keys(value.staleSwap).sort().join() === 'from,to' && [value.staleSwap.from, value.staleSwap.to].every(p => typeof p === 'string' && p.startsWith('/') && p.length <= 80))) bad.push(`${path}.staleSwap: { from, to } paths of the fixture`)
  if (!LOOP_PAGES.includes(value.pages)) bad.push(`${path}.pages: one of ${LOOP_PAGES.join(', ')}`)
  if (!(typeof value.host === 'string' && /^[a-z0-9.-]+\.example\.test$/.test(value.host))) bad.push(`${path}.host: a synthetic *.example.test host`)
  if (!(typeof value.start === 'string' && value.start.startsWith('/') && value.start.length <= 80)) bad.push(`${path}.start: a path of the fixture`)
  if (!(typeof value.title === 'string' && value.title.length >= 1 && value.title.length <= 120)) bad.push(`${path}.title: the card's title`)
  if (conv?.flags?.[BROWSER_LOOP_FLAG] !== 'on') bad.push(`${path}: needs flags.${BROWSER_LOOP_FLAG} = "on" in this conversation (the entry is judged by the Decision model)`)
  return bad
}
export function validateBrowserLoopExpect(value, turn, path = 'expect.browserLoop') {
  const bad = []
  if (!isObject(value)) return [`${path}: must be an object`]
  const allowed = Object.keys(BROWSER_LOOP_EXPECT_SCHEMA.properties)
  for (const key of Object.keys(value)) if (!allowed.includes(key)) bad.push(`${path}.${key}: not a check`)
  if (turn?.browserLoop === undefined) bad.push(`${path}: needs browserLoop on the same turn`)
  if (!Object.keys(value).length) bad.push(`${path}: names no check`)
  for (const key of ['entered', 'noActs', 'noInventedDates', 'noInventedAmounts', 'noFills', 'staleSeen']) if (value[key] !== undefined && value[key] !== true) bad.push(`${path}.${key}: true`)
  for (const [key, max, chars] of [['navigatedTo', 4, 120], ['noteCandidates', 3, 100], ['noteIncludes', 4, 200], ['namesAnyOf', 6, 100], ['clickedOnly', 4, 40], ['afterStaleSees', 3, 120], ['noteExcludes', 4, 120]]) if (value[key] !== undefined && !textList(value[key], max, chars)) bad.push(`${path}.${key}: up to ${max} strings`)
  if (value.mentionsDates !== undefined && !(Array.isArray(value.mentionsDates) && value.mentionsDates.length <= 4 && value.mentionsDates.every(d => /^\d{4}-\d{2}-\d{2}$/.test(d)))) bad.push(`${path}.mentionsDates: YYYY-MM-DD`)
  if (value.noteStatus !== undefined && !['done', 'cannot_proceed', 'need_context'].includes(value.noteStatus)) bad.push(`${path}.noteStatus: done, cannot_proceed or need_context`)
  return bad
}

/** The checks of the loop (by code, on the record): the entry, the steps, the note, then the reply (checkBrowserAnswer). */
export function checkBrowserLoop(expect, record) {
  const out = []
  const add = (check, ok, detail) => out.push({ check: `browserLoop.${check}`, ok: Boolean(ok), detail })
  add('entered', record.entry?.handled === true, `handled=${record.entry?.handled} reason=${record.entry?.reason ?? ''} entry predicates ${JSON.stringify(record.entryAnswers)}`)
  const nav = (record.acts || []).filter(a => a.type === 'navigate').map(a => a.path)
  if (expect.navigatedTo) add('navigated_to', JSON.stringify(nav) === JSON.stringify(expect.navigatedTo), `navigations ${JSON.stringify(nav)}`)
  if (expect.noActs) add('no_acts', (record.acts || []).length === 0, `acts ${JSON.stringify(record.acts)}`)
  const note = record.noteParsed ?? null
  if (expect.noteStatus) add('note_status', note?.status === expect.noteStatus, `status ${note?.status}`)
  if (expect.noteCode) add('note_code', note?.code === expect.noteCode, `code ${note?.code}`)
  if (expect.noteCandidates) add('note_candidates', JSON.stringify(note?.candidates) === JSON.stringify(expect.noteCandidates), `candidates ${JSON.stringify(note?.candidates)}`)
  if (expect.noteIncludes) { const lines = [...(note?.found || []), ...(note?.page || [])]; add('note_includes', expect.noteIncludes.every(text => lines.some(line => line.includes(text))), `note lines ${JSON.stringify(lines)}`) }
  const accepted = (record.acts || []).filter(a => !a.rejected)
  if (expect.noFills) add('no_fills', (record.acts || []).every(a => a.type !== 'fill'), `acts ${JSON.stringify((record.acts || []).map(a => [a.type, a.ref]))}`)
  if (expect.clickedOnly) add('clicked_only', accepted.filter(a => a.type === 'click').every(a => expect.clickedOnly.includes(a.ref)), `clicks ${JSON.stringify(accepted.filter(a => a.type === 'click').map(a => a.ref))}`)
  if (expect.staleSeen) add('stale_seen', (record.acts || []).some(a => a.rejected), 'the live page changed and the action was refused as stale')
  if (expect.afterStaleSees) {
    const at = (record.acts || []).findIndex(a => a.rejected)
    const later = (record.decisionRows || []).filter(d => d.text && d.names.includes('next_step') !== undefined && at >= 0 && d.actsSoFar > at)
    add('after_stale_sees', later.length > 0 && later.some(d => expect.afterStaleSees.every(s => d.text.includes(s))), `${later.length} decision(s) after the refused action; the new lines ${later.some(d => expect.afterStaleSees.every(s => d.text.includes(s))) ? 'were in the evidence' : 'were NOT in the evidence: acted on old lines'}`)
  }
  if (expect.noteExcludes) { const lines = [...(note?.found || []), ...(note?.page || [])]; add('note_excludes', !expect.noteExcludes.some(text => lines.some(line => line.includes(text))), `note lines ${JSON.stringify(lines)}`) }
  const { entered, navigatedTo, noActs, noteStatus, noteCode, noteCandidates, noteIncludes, noFills, clickedOnly, staleSeen, afterStaleSees, noteExcludes, ...replyExpect } = expect
  out.push(...checkBrowserAnswer(replyExpect, record))
  return out
}

/** The per-conversation hook. `makeProvider` is injectable for tests; the default is the product's own browser tool provider over the fixture world. */
export function createBrowserLoopHook({ now = Date.now } = {}) {
  let deps = null, startedAt = null, pending = null, seen = null
  const state = { n: 0 }
  return {
    attach(d) {
      deps = d
      const chat = d?.chat
      if (typeof chat?.send !== 'function') return
      const send = chat.send.bind(chat)
      chat.send = (body, internal) => (pending?.note && !internal ? send(body, { blocks: { [NOTE_KEY]: pending.note } }) : send(body, internal))
    },
    async beforeSend({ turn }) {
      pending = null; seen = null
      if (!turn?.browserLoop || !deps) return
      startedAt = now()
      const spec = turn.browserLoop, decisions = []
      // the check's client is frozen: a wrapper that logs each request and passes it on unchanged (everything else, the model name included, is the client's own)
      const logged = Object.create(deps.client, { decide: { value: async request => { const result = await deps.client.decide(request); decisions.push({ names: request.questions.map(q => q.name), answers: result?.answers ?? null, text: typeof request.input?.[1]?.content === 'string' ? request.input[1].content : null, actsSoFar: world.state.acts.length }); return result } } })
      const world = pageWorld(spec.pages, spec.host, 'card', { ...(HARD_PAGES[spec.pages] ? { pages: HARD_PAGES[spec.pages] } : {}), ...(spec.staleSwap ? { staleSwap: spec.staleSwap } : {}) })
      world.go(spec.start)
      const provider = createCodexBrowserToolProvider({ transport: world.transport, getOwnerKey: () => OWNER, decision: { mode: () => 'on', configured: () => true, client: logged,
        recipient: () => decisionTopicRecipient(deps.key, 1, undefined, deps.client.model), generation: () => 0 } })
      provider.runtime = { emit: () => {} }
      const id = `loop-${++state.n}`
      const run = { answerId: id, runId: id, clientThreadId: 'loop-dm', status: 'inProgress', executionPolicy: { mode: 'browserBounded' } }
      const prepared = provider.prepare({ clientThreadId: 'loop-dm', effectiveExecutionPolicy: 'browserBounded', browserTransportId: 'ui', selectedSources: [{ id: 'source', kind: 'browser', selectedByUser: true, browserToolPermission: 'interact',
        browserToolSelection: { token: `token-${id}`, threadId: 'loop-dm' }, browserToolIdentity: { cardEpoch: 'epoch', userContextId: 0, engineAccountKey: OWNER, authorityEpoch: 1 },
        sourceRef: { viewId: 'card', profileId: 'synthetic', accountId: '', uri: `https://${spec.host}${spec.start}` } }] })
      await provider.bindRun(run, prepared)
      // the check's run may receive page text (the Decision model is given what the product gives it); the note carries the page's lines as the product does then
      const entry = createDirectBrowserEntry({ provider, store: createBrowserTaskStore(), now, pageTextInNote: () => true, cardTextInEntry: () => true })
      const out = await entry.handle({ run, conversationKey: id, message: turn.say, hosts: { card: spec.host }, titles: { card: spec.title } })
      try { await provider.cancelRun(run) } catch { /* the run is a fixture */ }
      const noteParsed = out?.note ? JSON.parse(out.note)[NOTE_KEY] : null
      const entryRequest = decisions.find(d => d.names.includes('browser_entry'))
      pending = { note: out?.note ?? null, noteParsed, entry: { handled: out?.handled === true, reason: out?.reason ?? null, status: out?.status ?? null }, acts: world.state.acts.map(a => ({ type: a.type, ref: a.ref, path: a.path, ...(a.rejected ? { rejected: true } : {}) })), observes: world.state.observes,
        decisions, entryAnswers: entryRequest ? Object.fromEntries(Object.entries(entryRequest.answers ?? {}).map(([k, a]) => [k, a?.probability ?? a?.choice ?? a?.type ?? null])) : null }
      seen = { delivered: false, deliveredWhy: pending.note ? null : 'the entry produced no note' }
    },
    observe(method, params) {
      if (!pending?.note || !seen || method !== 'turn/start' || seen.delivered) return
      const block = params?.additionalContext?.[NOTE_KEY]
      if (!block) { seen.deliveredWhy = 'turn/start without the note'; return }
      if (block.kind !== 'application' || block.value !== pending.note) { seen.deliveredWhy = 'the block differs from the note'; return }
      seen.delivered = true; seen.deliveredWhy = null
    },
    async afterTurn({ answer, say, expect: turnExpect }) {
      if (!pending || !seen) return null
      const spec = turnExpect?.browserLoop ?? {}
      const record = { ...seen, say, note: pending.note ?? '', noteParsed: pending.noteParsed, entry: pending.entry, entryAnswers: pending.entryAnswers, acts: pending.acts, observes: pending.observes, decisions: pending.decisions.map(d => d.names), decisionRows: pending.decisions,
        reply: typeof answer === 'string' ? answer : null, runDates: runDates([startedAt, now()]) }
      const expectations = checkBrowserLoop(spec, record)
      pending = null
      return { record, expectations }
    },
  }
}
