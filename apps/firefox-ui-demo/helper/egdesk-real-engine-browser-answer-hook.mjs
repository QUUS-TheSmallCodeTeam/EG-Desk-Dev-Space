// L8 c31: the browser-answer hook of the real-engine check (registered in helper/egdesk-real-engine-registrations.mjs, slot L8).
//
// What it is for: the browser task's last step is the model that WRITES the reply. The product hands it a closed note (egdesk_browser_task: status, code, the control labels
// a task named, what the page said) in the turn's additionalContext. Everything before that is measured against the Decision model; this is the one place where the REAL
// answering model reads the note, so the check feeds it the note and checks the reply, by code:
//   - "다음 결제일이 언제야?" -> the reply states the date of the page and does not invent an amount;
//   - a delivery status -> the right order's status, not another order's;
//   - a handed-over task -> the reply tells the person what is theirs (names the control) and does not claim it was done.
//
// A scripted turn gets `browserTask` (the facts of a finished or handed-over task); the hook builds the note with the PRODUCT's own functions (subjectiveNote, finishedPageFacts:
// the same code the direct entry uses, so what the model reads is what the product would put there), and puts it into the turn exactly where the runtime puts a task note:
// additionalContext.egdesk_browser_task = { kind: 'application', value: <note> }. The runtime's own internal-blocks seam does it (send(body, { blocks })); the hook only supplies the
// block for the turn that asks for it. Nothing else of the turn changes. `expect.browserAnswer` is checked by code on the posted reply and on what reached the engine.
import { createHash } from 'node:crypto'
import { finishedPageFacts, subjectiveNote } from './egdesk-browser-task.mjs'
import { identifiersOf } from './egdesk-browser-task-memory.mjs'

export const NOTE_KEY = 'egdesk_browser_task'
export const BROWSER_STATUSES = Object.freeze(['done', 'cannot_proceed', 'need_context'])
const str = (max, extra = {}) => ({ type: 'string', minLength: 1, maxLength: max, ...extra })
const lines = { type: 'array', maxItems: 16, items: str(400) }
export const BROWSER_TASK_SCHEMA = Object.freeze({ type: 'object', additionalProperties: false, required: ['status'], properties: {
  status: { enum: [...BROWSER_STATUSES] },
  code: str(40, { pattern: '^[a-z][a-z0-9_]{0,39}$' }),
  candidates: { type: 'array', maxItems: 3, items: str(100) },
  // a finished task: the page the task ended on (its visible text segments, as the Firefox child reports them) and the identifiers the task is about
  pageText: lines,
  identifiers: { type: 'array', maxItems: 4, items: str(40) },
  steps: { type: 'integer', minimum: 0, maximum: 12 },
  actions: { type: 'object', additionalProperties: false, properties: { fill: { type: 'integer', minimum: 0, maximum: 12 }, navigate: { type: 'integer', minimum: 0, maximum: 12 }, scroll: { type: 'integer', minimum: 0, maximum: 12 } } },
} })
export const BROWSER_ANSWER_EXPECT_SCHEMA = Object.freeze({ type: 'object', additionalProperties: false, properties: {
  mentionsDates: { type: 'array', maxItems: 4, items: str(10, { pattern: '^\\d{4}-\\d{2}-\\d{2}$' }) },
  noInventedDates: { const: true },
  noInventedAmounts: { const: true },
  namesAnyOf: { type: 'array', minItems: 1, maxItems: 6, items: str(100) },
  namesAllOf: { type: 'array', minItems: 1, maxItems: 6, items: str(100) },
} })

const isObject = v => v !== null && typeof v === 'object' && !Array.isArray(v)
const textList = (value, max, maxChars) => Array.isArray(value) && value.length <= max && value.every(x => typeof x === 'string' && x.length >= 1 && x.length <= maxChars)
const count = v => Number.isInteger(v) && v >= 0 && v <= 12
// the validator of a registered field is the check's own (the schema documents it): closed keys, types and bounds are enforced here
export function validateBrowserTask(value, path = 'browserTask') {
  const bad = []
  if (!isObject(value)) return [`${path}: must be an object`]
  for (const key of Object.keys(value)) if (!['status', 'code', 'candidates', 'pageText', 'identifiers', 'steps', 'actions'].includes(key)) bad.push(`${path}.${key}: not a field of a task`)
  if (!BROWSER_STATUSES.includes(value.status)) bad.push(`${path}.status: one of ${BROWSER_STATUSES.join(', ')}`)
  if (value.code !== undefined && !(typeof value.code === 'string' && /^[a-z][a-z0-9_]{0,39}$/.test(value.code))) bad.push(`${path}.code: a closed code (lower case and underscores)`)
  if (value.candidates !== undefined && !(textList(value.candidates, 3, 100))) bad.push(`${path}.candidates: at most 3 labels of at most 100 characters`)
  if (value.pageText !== undefined && !textList(value.pageText, 16, 400)) bad.push(`${path}.pageText: at most 16 lines of at most 400 characters`)
  if (value.identifiers !== undefined && !textList(value.identifiers, 4, 40)) bad.push(`${path}.identifiers: at most 4 of at most 40 characters`)
  if (value.steps !== undefined && !count(value.steps)) bad.push(`${path}.steps: an integer 0..12`)
  if (value.actions !== undefined && !(isObject(value.actions) && Object.entries(value.actions).every(([k, v]) => ['fill', 'navigate', 'scroll'].includes(k) && count(v)))) bad.push(`${path}.actions: fill, navigate, scroll counts 0..12`)
  if (value.status === 'done' && !Array.isArray(value.pageText)) bad.push(`${path}.pageText: a finished task carries the page it ended on`)
  if (value.status !== 'done' && (value.pageText !== undefined || value.identifiers !== undefined)) bad.push(`${path}: only a finished task carries pageText and identifiers`)
  if (value.status === 'cannot_proceed' && typeof value.code !== 'string') bad.push(`${path}.code: a handed-over task names its code`)
  if (value.status === 'done' && (value.code !== undefined || value.candidates !== undefined)) bad.push(`${path}: a finished task has no code or candidates`)
  return bad
}
export function validateBrowserAnswerExpect(value, turn, path = 'expect.browserAnswer') {
  const bad = []
  if (!isObject(value)) return [`${path}: must be an object`]
  for (const key of Object.keys(value)) if (!['mentionsDates', 'noInventedDates', 'noInventedAmounts', 'namesAnyOf', 'namesAllOf'].includes(key)) bad.push(`${path}.${key}: not a check`)
  if (turn?.browserTask === undefined) bad.push(`${path}: needs browserTask on the same turn`)
  if (Object.keys(value).length === 0) bad.push(`${path}: names no check`)
  if (value.mentionsDates !== undefined && !(Array.isArray(value.mentionsDates) && value.mentionsDates.length <= 4 && value.mentionsDates.every(d => /^\d{4}-\d{2}-\d{2}$/.test(d)))) bad.push(`${path}.mentionsDates: up to 4 dates, YYYY-MM-DD`)
  for (const key of ['noInventedDates', 'noInventedAmounts']) if (value[key] !== undefined && value[key] !== true) bad.push(`${path}.${key}: true`)
  for (const key of ['namesAnyOf', 'namesAllOf']) if (value[key] !== undefined && !(textList(value[key], 6, 100) && value[key].length >= 1)) bad.push(`${path}.${key}: 1 to 6 names`)
  return bad
}

/** The closed note for a scripted `browserTask`, built with the product's own functions. -> { note: string (the JSON line), parsed } */
export function buildTaskNote(spec) {
  const id = `bt_${createHash('sha256').update(JSON.stringify(spec)).digest('hex').slice(0, 12)}`
  const task = { taskId: id, steps: spec.steps ?? 1, actions: { fill: 0, navigate: 0, scroll: 0, ...(spec.actions ?? {}) } }
  // the product's own identifier form (digits, dates excluded)
  const facts = spec.status === 'done' ? finishedPageFacts(spec.pageText, (spec.identifiers ?? []).flatMap(identifiersOf)) : { found: [], page: [] }
  const note = subjectiveNote(task, { status: spec.status, ...(spec.code ? { code: spec.code } : {}), candidates: spec.candidates ?? [], found: facts.found, page: facts.page })
  return { note, parsed: JSON.parse(note)[NOTE_KEY] }
}

// ---- reading the reply, by code ----
const DATE_ISO = /(\d{4})\s*[-./]\s*(\d{1,2})\s*[-./]\s*(\d{1,2})/g
const DATE_KO = /(?:(\d{4})\s*년\s*)?(\d{1,2})\s*월\s*(\d{1,2})\s*일/g
/** Dates written in the text: [{ y: number|null, m, d }]. ISO, 2026.12.14, 2026년 12월 14일 and 12월 14일 are the same date. */
export function datesIn(text) {
  const out = []
  for (const m of String(text ?? '').matchAll(DATE_ISO)) out.push({ y: Number(m[1]), m: Number(m[2]), d: Number(m[3]) })
  for (const m of String(text ?? '').matchAll(DATE_KO)) out.push({ y: m[1] ? Number(m[1]) : null, m: Number(m[2]), d: Number(m[3]) })
  return out
}
const sameDate = (a, b) => a.m === b.m && a.d === b.d && (a.y === null || b.y === null || a.y === b.y)
/** Money amounts written in the text, as won values: 14,900원, 1만 4천원 is not parsed (a value in digits only), 3만원. */
export function amountsIn(text) {
  const out = []
  for (const m of String(text ?? '').matchAll(/(\d[\d,]*(?:\.\d+)?)\s*(만)?\s*원/g)) { const v = Number(m[1].replace(/,/g, '')); if (Number.isFinite(v)) out.push(m[2] ? v * 10000 : v) }
  return out
}

/** The checks of one turn: -> [{ check, ok, detail }] (the record: what the engine got, the note, the reply). */
export function checkBrowserAnswer(expect, record) {
  const out = []
  const add = (check, ok, detail) => out.push({ check: `browserAnswer.${check}`, ok: Boolean(ok), detail })
  const reply = typeof record.reply === 'string' ? record.reply : ''
  add('note_delivered', record.delivered === true, record.delivered === true ? 'the note reached the engine as application context' : `delivered=${JSON.stringify(record.delivered)} (${record.deliveredWhy ?? 'no turn/start with the note'})`)
  add('reply_present', reply.trim().length > 0, reply.trim().length ? `${reply.length} characters` : 'no posted reply')
  const noteDates = datesIn(`${record.note} ${record.say}`), noteAmounts = amountsIn(`${record.note} ${record.say}`)
  for (const date of expect.mentionsDates ?? []) {
    const [y, m, d] = date.split('-').map(Number)
    add(`mentions_date_${date}`, datesIn(reply).some(r => sameDate(r, { y, m, d })), `reply dates: ${JSON.stringify(datesIn(reply))}`)
  }
  if (expect.noInventedDates) {
    const invented = datesIn(reply).filter(r => !noteDates.some(n => sameDate(r, n)))
    add('no_invented_dates', invented.length === 0, invented.length ? `not in the note or the message: ${JSON.stringify(invented)}` : 'every date of the reply is in the note or the message')
  }
  if (expect.noInventedAmounts) {
    const invented = amountsIn(reply).filter(v => !noteAmounts.includes(v))
    add('no_invented_amounts', invented.length === 0, invented.length ? `not in the note or the message: ${JSON.stringify(invented)}` : 'every amount of the reply is in the note or the message')
  }
  if (expect.namesAnyOf) add('names_any_of', expect.namesAnyOf.some(name => reply.includes(name)), `names: ${JSON.stringify(expect.namesAnyOf.filter(name => reply.includes(name)))} of ${JSON.stringify(expect.namesAnyOf)}`)
  if (expect.namesAllOf) add('names_all_of', expect.namesAllOf.every(name => reply.includes(name)), `missing: ${JSON.stringify(expect.namesAllOf.filter(name => !reply.includes(name)))}`)
  return out
}

/** The per-conversation hook (registered with registerTurnHooks). */
export function createBrowserAnswerHook() {
  let pending = null // { note, parsed } for the turn being sent
  let seen = null // what the engine was sent for this turn: { delivered, deliveredWhy }
  const state = { sent: 0 }
  return {
    attach({ chat } = {}) {
      if (typeof chat?.send !== 'function') return // composed without a runtime (a probe): nothing to wrap
      const send = chat.send.bind(chat)
      // the runtime's own internal-blocks seam (send(body, { blocks: { key: text } }) -> additionalContext[key] = { kind: 'application', value: text }) carries the note; only the
      // turn that asked for it gets a block, every other send is passed through untouched
      chat.send = (body, internal) => (pending && !internal ? (state.sent++, send(body, { blocks: { [NOTE_KEY]: pending.note } })) : send(body, internal))
    },
    beforeSend({ turn }) {
      pending = turn?.browserTask ? buildTaskNote(turn.browserTask) : null
      seen = pending ? { delivered: false, deliveredWhy: null } : null
    },
    observe(method, params) {
      if (!pending || !seen || method !== 'turn/start' || seen.delivered) return
      const block = params?.additionalContext?.[NOTE_KEY]
      if (!block) { seen.deliveredWhy = 'turn/start without the note'; return }
      if (block.kind !== 'application') { seen.deliveredWhy = `kind ${JSON.stringify(block.kind)}`; return }
      if (block.value !== pending.note) { seen.deliveredWhy = 'the value differs from the built note'; return }
      seen.delivered = true; seen.deliveredWhy = null
    },
    async afterTurn({ answer, say, expect: turnExpect }) {
      const spec = turnExpect?.browserAnswer
      if (!pending || !seen) return null
      const record = { ...seen, say, note: pending.note, noteParsed: pending.parsed, reply: typeof answer === 'string' ? answer : null }
      const expectations = checkBrowserAnswer(spec ?? {}, record)
      pending = null
      return { record, expectations }
    },
  }
}
