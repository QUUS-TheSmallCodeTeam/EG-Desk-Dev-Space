// c22: the conversation script format of the real-engine check (scripts/egdesk-real-engine-check.mjs), its JSON schema (committed as
// scripts/real-engine/real-engine-script.schema.json), a dependency-free validator, and the expectation checks. Expectations are
// checked by code only, on the turn record the check wrote: nothing here asks a model whether a turn went well.
//
// { "set": "real-engine-<name>-v1", "conversations": [ { "id", "folder": { "<relative path>": "<content>" }, "flags": { "EGDESK_…": "on" },
//   "turns": [ { "say": "…", "approve": ["yes"|"no"], "expect": { … } } ] } ] }
//
// approve: the scripted approver's answers, in order, to the approval questions EG-Desk's own tools raise in that turn. Each answer is
// one more message from the person in the same scripted turn (APPROVER_TEXT); the expectations cover the whole scripted turn.
// Every conversation runs with EGDESK_OWN_TOOLS=on (the check sets it; a script cannot turn it off).
// memory { mode?, pages }: (optional, on a conversation) seeded memory pages and expect.memory { attached, notAttached, noResends } on a turn: both belong to
//   helper/egdesk-real-engine-memory.mjs (L7 c26), which validates them and checks them.
// whileRunning { afterMs }: (optional, on a turn) this turn's `say` is typed into the PREVIOUS turn's working run, afterMs after that turn
//   started (not after it ended), as chat.send({ inRunMessageTo: <that run's runId> }); the run's own turn keeps going. Both turns are then
//   awaited. Needs conversation.flags.EGDESK_INRUN_MESSAGES = "on", cannot be the first turn, cannot follow another whileRunning turn, takes no
//   approve. Its expectations cover what happened after it was sent (messages posted after it, tool calls and commands after it); the previous
//   turn's own expectations cover the whole window of both. A message the run no longer takes (it ended before afterMs) fails the turn's
//   implicit check "sent_while_running".
import { MEMORY_EXPECT_SCHEMA, MEMORY_SCHEMA, validateMemory, validateMemoryExpect } from './egdesk-real-engine-memory.mjs'
// action turns (c23, agreed with lane L3): { action: "interrupt" | "steer" | "delete", afterMs?, say?, expect? } instead of a message.
//   interrupt  the person presses stop on the PREVIOUS turn's run, afterMs after that turn started (chat.interrupt). Give the previous turn
//              expect.turnStatus "interrupted" (and posted false: only completed agent messages are posted).
//   steer      a plain turn/steer of `say` into the previous turn's working run, through the product's engine adapter with the steer contract
//              of the binary (refused with no_steer_contract when it has none). Not the person-message path; use whileRunning for that.
//   delete     the person deletes the conversation after the previous turn ended (chat.forgetConversation); expect.conversationGone. A later
//              message turn starts a NEW conversation (new thread, nothing remembered).
//   interrupt and steer follow a plain message turn (not a whileRunning or action turn); a message turn takes at most one follow-up. An action turn
//   cannot be first, takes no approve and no whileRunning; steer needs say; interrupt and delete take no say; afterMs (0..120000) only for
//   interrupt and steer. Implicit check "action_taken" on interrupt and steer turns.
export const SCRIPT_SET = /^real-engine-[a-z0-9][a-z0-9-]{0,40}-v\d{1,3}$/
export const CONVERSATION_ID = /^[a-z0-9][a-z0-9-]{0,39}$/
export const FLAG_NAME = /^EGDESK_[A-Z0-9_]{1,48}$/
export const FLAG_VALUE = /^[a-z0-9_-]{1,24}$/
// launch-level settings belong to the check's own flags (--codex-bin, --model, --effort, …), never to a script
export const RESERVED_FLAGS = Object.freeze(['EGDESK_CODEX_BIN', 'EGDESK_DATA_DIR', 'EGDESK_CODEX_MODEL', 'EGDESK_CODEX_EFFORT', 'EGDESK_CODEX_DISABLE_MEMORIES', 'EGDESK_CLAUDE_BIN'])
export const PROTECTED_SEGMENTS = Object.freeze(['.git', '.codex', '.agents', '.egdesk'])
export const IN_RUN_FLAG = 'EGDESK_INRUN_MESSAGES'
export const LIMITS = Object.freeze({ whileRunningMs: 120_000, conversations: 8, turns: 12, files: 32, pathChars: 200, contentBytes: 64 * 1024, sayChars: 4000, approvals: 4, strings: 16, stringChars: 400 })
// the scripted person's answers (test input, never product copy)
export const APPROVER_TEXT = Object.freeze({ yes: '응, 그 명령 실행해 줘', no: '아니, 그건 실행하지 마' })
export const EXPECT_KEYS = Object.freeze(['toolCalls', 'noToolCalls', 'posted', 'answerIncludes', 'answerExcludes', 'noNativeTools', 'asked', 'commandsRan', 'files', 'undoRecords', 'turnStatus', 'compacted', 'conversationGone', 'memory', 'briefing', 'draftCheck', 'resumes', 'unsubscribes', 'commandsRanIncludes', 'commandsRanExcludes'])
export const ACTIONS = Object.freeze(['interrupt', 'steer', 'delete'])
// c25: conversation.agentProfile makes the conversation an Agent-profile DIRECT room (the room the product's draft check judges and the Agent turn's detach + resume belongs to):
// a synthetic Agent, created in the check's isolated profile store (no person data), every send names it with replyDestination "direct". A direct room is not one-time, so it
// needs --persisted-with-cleanup (the preflight says so). { name, role?, instructions, tone?, expertise? }
export const AGENT_TONES = Object.freeze(['plain', 'warm', 'concise', 'formal', 'playful'])
export const AGENT_LIMITS = Object.freeze({ name: 40, role: 80, instructions: 2000, expertise: 4, expertiseChars: 80 })

// `expect.briefing` belongs to the briefing hook (helper/egdesk-real-engine-briefing-hook.mjs): its shape and its checks live there (registered in helper/egdesk-real-engine-hooks.mjs)
import { BRIEFING_EXPECT_SCHEMA, checkBriefingExpect, validateBriefingExpect } from './egdesk-real-engine-briefing-hook.mjs'
const str = (max, extra = {}) => ({ type: 'string', minLength: 1, maxLength: max, ...extra })
const strings = { type: 'array', maxItems: LIMITS.strings, items: str(LIMITS.stringChars) }
export const REAL_ENGINE_SCRIPT_SCHEMA = Object.freeze({
  $schema: 'http://json-schema.org/draft-07/schema#',
  $id: 'egdesk/real-engine-script.schema.json',
  title: 'EG-Desk real-engine check conversation script',
  type: 'object', additionalProperties: false, required: ['set', 'conversations'],
  properties: {
    set: { type: 'string', pattern: SCRIPT_SET.source },
    description: str(2000),
    conversations: { type: 'array', minItems: 1, maxItems: LIMITS.conversations, items: {
      type: 'object', additionalProperties: false, required: ['id', 'turns'],
      properties: {
        id: { type: 'string', pattern: CONVERSATION_ID.source },
        draftCheck: { type: 'object', additionalProperties: false, required: ['mode'], properties: { mode: { enum: ['advisory', 'on'] }, design: { enum: ['predicates', 'choice'] } } },
        agentProfile: { type: 'object', additionalProperties: false, required: ['name', 'instructions'], properties: { name: str(AGENT_LIMITS.name), role: str(AGENT_LIMITS.role), instructions: str(AGENT_LIMITS.instructions), tone: { enum: [...AGENT_TONES] },
          expertise: { type: 'array', maxItems: AGENT_LIMITS.expertise, items: str(AGENT_LIMITS.expertiseChars) } } },
        folder: { type: 'object', maxProperties: LIMITS.files, propertyNames: { maxLength: LIMITS.pathChars }, additionalProperties: { type: 'string', maxLength: LIMITS.contentBytes } },
        flags: { type: 'object', propertyNames: { pattern: FLAG_NAME.source, not: { enum: [...RESERVED_FLAGS] } }, additionalProperties: { type: 'string', pattern: FLAG_VALUE.source } },
        memory: MEMORY_SCHEMA,
        turns: { type: 'array', minItems: 1, maxItems: LIMITS.turns, items: {
          type: 'object', additionalProperties: false, anyOf: [{ required: ['say'] }, { required: ['action'] }],
          properties: {
            say: str(LIMITS.sayChars),
            action: { enum: [...ACTIONS] },
            afterMs: { type: 'integer', minimum: 0, maximum: LIMITS.whileRunningMs },
            approve: { type: 'array', maxItems: LIMITS.approvals, items: { enum: ['yes', 'no'] } },
            whileRunning: { type: 'object', additionalProperties: false, required: ['afterMs'], properties: { afterMs: { type: 'integer', minimum: 0, maximum: LIMITS.whileRunningMs } } },
            expect: { type: 'object', additionalProperties: false, properties: {
              toolCalls: { type: 'array', maxItems: LIMITS.strings, items: { type: 'string', pattern: '^[a-z][a-z0-9_]{0,63}$' } },
              noToolCalls: { const: true },
              posted: { type: 'boolean' },
              answerIncludes: strings,
              answerExcludes: strings,
              noNativeTools: { const: true },
              asked: { type: 'integer', minimum: 0, maximum: LIMITS.approvals },
              commandsRan: { type: 'array', maxItems: LIMITS.strings, items: { type: 'string', minLength: 1, maxLength: 2000 } },
              commandsRanIncludes: strings,
              commandsRanExcludes: strings,
              files: { type: 'object', maxProperties: LIMITS.files, additionalProperties: { type: ['string', 'null'], maxLength: LIMITS.contentBytes } },
              undoRecords: { type: 'integer', minimum: 0, maximum: 50 },
              turnStatus: { enum: ['completed', 'failed', 'interrupted'] },
              compacted: { type: 'boolean' },
              conversationGone: { type: 'boolean' },
              draftCheck: { type: 'object', additionalProperties: false, required: ['ran'], properties: { ran: { type: 'boolean' }, rejects: { type: 'integer', minimum: 0, maximum: 50 } } },
              resumes: { type: 'integer', minimum: 0, maximum: 20 },
              unsubscribes: { type: 'integer', minimum: 0, maximum: 20 },
              memory: MEMORY_EXPECT_SCHEMA,
              briefing: BRIEFING_EXPECT_SCHEMA,
            } },
          } } },
      } } },
  },
})

const isObject = v => v !== null && typeof v === 'object' && !Array.isArray(v)
const bytes = s => Buffer.byteLength(s, 'utf8')

/** A relative, forward-slash path inside the scratch folder; no protected or empty segment. null when valid, else the reason. */
export function folderPathProblem(p) {
  if (typeof p !== 'string' || !p || p.length > LIMITS.pathChars) return 'length'
  if (p.startsWith('/') || /^[A-Za-z]:/.test(p) || p.includes('\\') || p.includes('\0')) return 'not_relative'
  const parts = p.split('/')
  if (parts.some(s => s === '' || s === '.' || s === '..')) return 'segment'
  if (parts.some(s => PROTECTED_SEGMENTS.includes(s))) return 'protected'
  return null
}

/** validateEngineScript(value) → { ok, errors: ['<json path>: <reason>'] } (the schema's rules plus path and uniqueness rules). */
export function validateEngineScript(value) {
  const errors = []
  const bad = (where, why) => { if (errors.length < 50) errors.push(`${where}: ${why}`) }
  const only = (obj, keys, where) => { for (const k of Object.keys(obj)) if (!keys.includes(k)) bad(`${where}.${k}`, 'unknown key') }
  const textList = (v, where, max = LIMITS.stringChars) => {
    if (!Array.isArray(v) || v.length > LIMITS.strings) return bad(where, `an array of at most ${LIMITS.strings}`)
    v.forEach((s, i) => { if (typeof s !== 'string' || !s || s.length > max) bad(`${where}[${i}]`, `a string of 1-${max} characters`) })
  }
  if (!isObject(value)) return { ok: false, errors: ['$: an object'] }
  only(value, ['set', 'description', 'conversations'], '$')
  if (typeof value.set !== 'string' || !SCRIPT_SET.test(value.set)) bad('$.set', `matches ${SCRIPT_SET.source}`)
  if (value.description !== undefined && (typeof value.description !== 'string' || !value.description || value.description.length > 2000)) bad('$.description', 'a string of 1-2000 characters')
  const convs = value.conversations
  if (!Array.isArray(convs) || convs.length < 1 || convs.length > LIMITS.conversations) bad('$.conversations', `1-${LIMITS.conversations} conversations`)
  const ids = new Set()
  for (const [ci, conv] of (Array.isArray(convs) ? convs : []).entries()) {
    const at = `$.conversations[${ci}]`
    if (!isObject(conv)) { bad(at, 'an object'); continue }
    only(conv, ['id', 'folder', 'flags', 'memory', 'draftCheck', 'agentProfile', 'turns'], at)
    if (conv.agentProfile !== undefined) {
      const a = conv.agentProfile, here = `${at}.agentProfile`
      if (!isObject(a)) bad(here, 'an object { name, instructions, role?, tone?, expertise? }')
      else {
        only(a, ['name', 'role', 'instructions', 'tone', 'expertise'], here)
        const text = (v, key, max, required) => { if (v === undefined && !required) return; if (typeof v !== 'string' || !v.trim() || v.length > max) bad(`${here}.${key}`, `a string of 1-${max} characters`) }
        text(a.name, 'name', AGENT_LIMITS.name, true); text(a.role, 'role', AGENT_LIMITS.role, false); text(a.instructions, 'instructions', AGENT_LIMITS.instructions, true)
        if (a.tone !== undefined && !AGENT_TONES.includes(a.tone)) bad(`${here}.tone`, `one of ${AGENT_TONES.join(', ')}`)
        if (a.expertise !== undefined) { if (!Array.isArray(a.expertise) || a.expertise.length > AGENT_LIMITS.expertise) bad(`${here}.expertise`, `an array of at most ${AGENT_LIMITS.expertise}`); else a.expertise.forEach((x, i) => text(x, `expertise[${i}]`, AGENT_LIMITS.expertiseChars, true)) }
      }
    }
    // c24: the draft check is a conversation's own opt-in (like memory): { mode: 'advisory' | 'on', design?: 'predicates' | 'choice' }; it costs Decision calls
    if (conv.draftCheck !== undefined) {
      const d = conv.draftCheck
      if (!isObject(d)) bad(`${at}.draftCheck`, 'an object { mode, design? }')
      else {
        only(d, ['mode', 'design'], `${at}.draftCheck`)
        if (!['advisory', 'on'].includes(d.mode)) bad(`${at}.draftCheck.mode`, 'advisory or on')
        if (d.design !== undefined && !['predicates', 'choice'].includes(d.design)) bad(`${at}.draftCheck.design`, 'predicates or choice')
        const own = conv.flags?.EGDESK_DRAFT_CHECK
        if (own !== undefined && own !== d.mode) bad(`${at}.flags.EGDESK_DRAFT_CHECK`, 'contradicts draftCheck.mode')
      }
    }
    if (conv.memory !== undefined) for (const why of validateMemory(conv.memory, `${at}.memory`)) bad(why.split(': ')[0], why.split(': ').slice(1).join(': '))
    if (typeof conv.id !== 'string' || !CONVERSATION_ID.test(conv.id)) bad(`${at}.id`, `matches ${CONVERSATION_ID.source}`)
    else if (ids.has(conv.id)) bad(`${at}.id`, 'unique'); else ids.add(conv.id)
    if (conv.folder !== undefined) {
      if (!isObject(conv.folder) || Object.keys(conv.folder).length > LIMITS.files) bad(`${at}.folder`, `an object of at most ${LIMITS.files} files`)
      else for (const [p, content] of Object.entries(conv.folder)) {
        const why = folderPathProblem(p)
        if (why) bad(`${at}.folder[${JSON.stringify(p)}]`, `path ${why}`)
        if (typeof content !== 'string' || bytes(content) > LIMITS.contentBytes) bad(`${at}.folder[${JSON.stringify(p)}]`, 'string content up to 64 KB')
      }
      // a file and a folder of the same name cannot both exist
      const names = Object.keys(isObject(conv.folder) ? conv.folder : {})
      for (const p of names) if (names.some(q => q.startsWith(`${p}/`))) bad(`${at}.folder[${JSON.stringify(p)}]`, 'is also a folder')
    }
    if (conv.flags !== undefined) {
      if (!isObject(conv.flags)) bad(`${at}.flags`, 'an object')
      else for (const [k, v] of Object.entries(conv.flags)) {
        if (!FLAG_NAME.test(k)) bad(`${at}.flags.${k}`, `name matches ${FLAG_NAME.source}`)
        else if (RESERVED_FLAGS.includes(k)) bad(`${at}.flags.${k}`, 'reserved for the check\'s own flags')
        if (typeof v !== 'string' || !FLAG_VALUE.test(v)) bad(`${at}.flags.${k}`, `value matches ${FLAG_VALUE.source}`)
        if (k === 'EGDESK_OWN_TOOLS' && v !== 'on') bad(`${at}.flags.${k}`, 'own tools are always on in this check')
      }
    }
    const turns = conv.turns
    if (!Array.isArray(turns) || turns.length < 1 || turns.length > LIMITS.turns) { bad(`${at}.turns`, `1-${LIMITS.turns} turns`); continue }
    for (const [ti, turn] of turns.entries()) {
      const tt = `${at}.turns[${ti}]`
      if (!isObject(turn)) { bad(tt, 'an object'); continue }
      only(turn, ['say', 'approve', 'whileRunning', 'action', 'afterMs', 'expect'], tt)
      const prev = turns[ti - 1]
      if (turn.action !== undefined) {
        if (!ACTIONS.includes(turn.action)) bad(`${tt}.action`, `one of ${ACTIONS.join(', ')}`)
        else {
          if (ti === 0) bad(`${tt}.action`, 'cannot be the first turn')
          if (turn.whileRunning !== undefined) bad(`${tt}.whileRunning`, 'an action turn is not also a whileRunning turn')
          if (turn.approve?.length) bad(`${tt}.approve`, 'an action turn takes no approve')
          if (turn.action === 'steer') { if (typeof turn.say !== 'string' || !turn.say.trim() || turn.say.length > LIMITS.sayChars) bad(`${tt}.say`, `steer needs a string of 1-${LIMITS.sayChars} characters`) }
          else if (turn.say !== undefined) bad(`${tt}.say`, `${turn.action} takes no say`)
          if (turn.action === 'delete') { if (turn.afterMs !== undefined) bad(`${tt}.afterMs`, 'delete takes no afterMs') }
          else {
            if (turn.afterMs !== undefined && !(Number.isInteger(turn.afterMs) && turn.afterMs >= 0 && turn.afterMs <= LIMITS.whileRunningMs)) bad(`${tt}.afterMs`, `an integer 0-${LIMITS.whileRunningMs}`)
            if (ti > 0 && (prev?.whileRunning !== undefined || prev?.action !== undefined)) bad(`${tt}.action`, `${turn.action} must follow a plain message turn (not a whileRunning or action turn)`)
          }
        }
      } else {
        if (turn.afterMs !== undefined) bad(`${tt}.afterMs`, 'only an interrupt or steer action takes afterMs')
        if (typeof turn.say !== 'string' || !turn.say.trim() || turn.say.length > LIMITS.sayChars) bad(`${tt}.say`, `a string of 1-${LIMITS.sayChars} characters`)
      }
      if (ti > 0 && (turn.whileRunning !== undefined) && prev?.action !== undefined) bad(`${tt}.whileRunning`, 'cannot follow an action turn')
      if (turn.whileRunning !== undefined) {
        const w = turn.whileRunning
        if (!isObject(w)) bad(`${tt}.whileRunning`, 'an object { afterMs }')
        else {
          only(w, ['afterMs'], `${tt}.whileRunning`)
          if (!(Number.isInteger(w.afterMs) && w.afterMs >= 0 && w.afterMs <= LIMITS.whileRunningMs)) bad(`${tt}.whileRunning.afterMs`, `an integer 0-${LIMITS.whileRunningMs}`)
        }
        if (ti === 0) bad(`${tt}.whileRunning`, 'cannot be the first turn (there is no running turn to message)')
        else if (turns[ti - 1]?.whileRunning !== undefined) bad(`${tt}.whileRunning`, 'cannot follow another whileRunning turn')
        if (turn.approve?.length) bad(`${tt}.approve`, 'a whileRunning turn takes no approve')
        if (!isObject(conv.flags) || conv.flags[IN_RUN_FLAG] !== 'on') bad(`${tt}.whileRunning`, `needs flags.${IN_RUN_FLAG} = "on" in this conversation`)
      }
      if (turn.approve !== undefined && (!Array.isArray(turn.approve) || turn.approve.length > LIMITS.approvals || turn.approve.some(a => a !== 'yes' && a !== 'no'))) bad(`${tt}.approve`, `at most ${LIMITS.approvals} of "yes" / "no"`)
      const e = turn.expect
      if (e === undefined) continue
      if (!isObject(e)) { bad(`${tt}.expect`, 'an object'); continue }
      only(e, EXPECT_KEYS, `${tt}.expect`)
      if (e.toolCalls !== undefined && (!Array.isArray(e.toolCalls) || e.toolCalls.length > LIMITS.strings || e.toolCalls.some(n => typeof n !== 'string' || !/^[a-z][a-z0-9_]{0,63}$/.test(n)))) bad(`${tt}.expect.toolCalls`, 'tool names')
      for (const k of ['noToolCalls', 'noNativeTools']) if (e[k] !== undefined && e[k] !== true) bad(`${tt}.expect.${k}`, 'true')
      for (const k of ['posted', 'compacted', 'conversationGone']) if (e[k] !== undefined && typeof e[k] !== 'boolean') bad(`${tt}.expect.${k}`, 'a boolean')
      for (const k of ['answerIncludes', 'answerExcludes']) if (e[k] !== undefined) textList(e[k], `${tt}.expect.${k}`)
      if (e.commandsRan !== undefined) textList(e.commandsRan, `${tt}.expect.commandsRan`, 2000)
      for (const k of ['commandsRanIncludes', 'commandsRanExcludes']) if (e[k] !== undefined) textList(e[k], `${tt}.expect.${k}`)
      if (e.asked !== undefined && !(Number.isInteger(e.asked) && e.asked >= 0 && e.asked <= LIMITS.approvals)) bad(`${tt}.expect.asked`, `an integer 0-${LIMITS.approvals}`)
      for (const k of ['resumes', 'unsubscribes']) if (e[k] !== undefined && !(Number.isInteger(e[k]) && e[k] >= 0 && e[k] <= 20)) bad(`${tt}.expect.${k}`, 'an integer 0-20')
      if (e.undoRecords !== undefined && !(Number.isInteger(e.undoRecords) && e.undoRecords >= 0 && e.undoRecords <= 50)) bad(`${tt}.expect.undoRecords`, 'an integer 0-50')
      if (e.turnStatus !== undefined && !['completed', 'failed', 'interrupted'].includes(e.turnStatus)) bad(`${tt}.expect.turnStatus`, 'completed / failed / interrupted')
      if (e.noToolCalls && e.toolCalls?.length) bad(`${tt}.expect`, 'noToolCalls and toolCalls contradict')
      if (e.memory !== undefined) {
        for (const why of validateMemoryExpect(e.memory, conv.memory, `${tt}.expect.memory`)) bad(why.split(': ')[0], why.split(': ').slice(1).join(': '))
        if (turn.whileRunning !== undefined) bad(`${tt}.expect.memory`, 'not checked on a whileRunning turn (the memory window is the scripted turn)')
      }
      if (e.draftCheck !== undefined) {
        if (!isObject(e.draftCheck) || Object.keys(e.draftCheck).some(k => !['ran', 'rejects'].includes(k)) || typeof e.draftCheck.ran !== 'boolean' || (e.draftCheck.rejects !== undefined && !(Number.isInteger(e.draftCheck.rejects) && e.draftCheck.rejects >= 0 && e.draftCheck.rejects <= 50))) bad(`${tt}.expect.draftCheck`, 'an object { ran: boolean, rejects?: integer }')
        else if (e.draftCheck.rejects !== undefined && e.draftCheck.ran !== true) bad(`${tt}.expect.draftCheck`, 'rejects counts the check\'s rejections: it needs ran: true')
        if (!conv.draftCheck && !['advisory', 'on'].includes(conv.flags?.EGDESK_DRAFT_CHECK)) bad(`${tt}.expect.draftCheck`, 'needs conversation.draftCheck (or flags.EGDESK_DRAFT_CHECK) in this conversation')
      }
      if (e.briefing !== undefined) {
        for (const why of validateBriefingExpect(e.briefing)) bad(`${tt}.expect.briefing`, why)
        if (conv.flags?.EGDESK_BRIEFING_FLOW !== 'on') bad(`${tt}.expect.briefing`, 'needs flags.EGDESK_BRIEFING_FLOW = "on" in this conversation')
      }
      if (e.files !== undefined) {
        if (!isObject(e.files) || Object.keys(e.files).length > LIMITS.files) bad(`${tt}.expect.files`, 'an object')
        else for (const [p, content] of Object.entries(e.files)) {
          const why = folderPathProblem(p)
          if (why) bad(`${tt}.expect.files[${JSON.stringify(p)}]`, `path ${why}`)
          if (content !== null && (typeof content !== 'string' || bytes(content) > LIMITS.contentBytes)) bad(`${tt}.expect.files[${JSON.stringify(p)}]`, 'string content or null (absent)')
        }
      }
      const asks = turn.approve?.length ?? 0
      if (e.asked !== undefined && asks > e.asked) bad(`${tt}.approve`, 'more answers than expected questions')
    }
  }
  return { ok: errors.length === 0, errors }
}

/** Is `wanted` an ordered subsequence of `seen`? */
const inOrder = (wanted, seen) => { let i = 0; for (const name of seen) if (name === wanted[i]) i++; return i === wanted.length }

/**
 * checkTurnExpectations(expect, record) → [{ check, ok, detail }] on the check's own turn record:
 *   record.toolCalls [{ tool }], record.native { commandExecution, fileChange, approvals }, record.posted [text], record.asked,
 *   record.commandsRan [command], record.files { path: content|null }, record.undoRecords, record.turnStatus, record.compacted.
 */
export function checkTurnExpectations(expect = {}, record = {}) {
  const out = [], put = (check, ok, detail) => out.push({ check, ok: ok === true, detail })
  const tools = (record.toolCalls ?? []).map(c => c.tool)
  const last = (record.posted ?? []).at(-1) ?? null
  if (expect.toolCalls) put('toolCalls', inOrder(expect.toolCalls, tools), { wanted: expect.toolCalls, seen: tools })
  if (expect.noToolCalls) put('noToolCalls', tools.length === 0, { seen: tools })
  if (expect.posted !== undefined) put('posted', (last !== null) === expect.posted, { posted: (record.posted ?? []).length })
  if (expect.answerIncludes) { const missing = expect.answerIncludes.filter(s => !(last ?? '').includes(s)); put('answerIncludes', last !== null && missing.length === 0, { missing }) }
  if (expect.answerExcludes) { const found = expect.answerExcludes.filter(s => (last ?? '').includes(s)); put('answerExcludes', found.length === 0, { found }) }
  if (expect.noNativeTools) {
    const n = record.native ?? {}
    put('noNativeTools', !(n.commandExecution > 0) && !(n.fileChange > 0) && !(n.approvals > 0), { commandExecution: n.commandExecution ?? 0, fileChange: n.fileChange ?? 0, approvals: n.approvals ?? 0 })
  }
  // substring rules for a model that may batch commands: every listed string occurs in some command that ran / none occurs in any
  if (expect.commandsRanIncludes) { const missing = expect.commandsRanIncludes.filter(x => !(record.commandsRan ?? []).some(c => c.includes(x))); put('commandsRanIncludes', missing.length === 0, { missing }) }
  if (expect.commandsRanExcludes) { const found = expect.commandsRanExcludes.filter(x => (record.commandsRan ?? []).some(c => c.includes(x))); put('commandsRanExcludes', found.length === 0, { found }) }
  if (expect.asked !== undefined) put('asked', record.asked === expect.asked, { asked: record.asked ?? null })
  if (expect.commandsRan) put('commandsRan', JSON.stringify(record.commandsRan ?? []) === JSON.stringify(expect.commandsRan), { ran: record.commandsRan ?? [] })
  if (expect.files) {
    const wrong = Object.entries(expect.files).filter(([p, content]) => (record.files?.[p] ?? null) !== content).map(([p]) => p)
    put('files', wrong.length === 0, { wrong })
  }
  if (expect.undoRecords !== undefined) put('undoRecords', Number.isInteger(record.undoRecords) && record.undoRecords >= expect.undoRecords, { undoRecords: record.undoRecords ?? null })
  if (expect.turnStatus) put('turnStatus', record.turnStatus === expect.turnStatus, { turnStatus: record.turnStatus ?? null })
  if (expect.conversationGone !== undefined) put('conversationGone', (record.conversationGone === true) === expect.conversationGone, { conversationGone: record.conversationGone === true })
  if (expect.compacted !== undefined) put('compacted', (record.compacted === true) === expect.compacted, { compacted: record.compacted === true })
  if (expect.draftCheck) put('draftCheck', ((record.draftCheckRows ?? 0) > 0) === expect.draftCheck.ran && (expect.draftCheck.rejects === undefined || record.draftCheckRejects === expect.draftCheck.rejects), { rows: record.draftCheckRows ?? 0, rejects: record.draftCheckRejects ?? 0 })
  // engine requests the runtime made in this scripted turn (an Agent-profile turn detaches and resumes its thread; EGDESK_AGENT_RELOAD_REUSE skips that when nothing changed)
  if (expect.resumes !== undefined) put('resumes', record.resumes === expect.resumes, { resumes: record.resumes ?? null })
  if (expect.unsubscribes !== undefined) put('unsubscribes', record.unsubscribes === expect.unsubscribes, { unsubscribes: record.unsubscribes ?? null })
  if (expect.briefing !== undefined) out.push(...checkBriefingExpect(expect.briefing, record.hooks?.briefing ?? null))
  return out
}
