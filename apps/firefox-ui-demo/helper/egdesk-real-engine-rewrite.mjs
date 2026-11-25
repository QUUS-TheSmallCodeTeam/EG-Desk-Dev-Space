// L2 c26: the real-engine tool for the draft check's REWRITE. In an Agent-profile direct room with the draft check ON, the REAL answering model writes a draft, the
// product's draft check reads it with the REAL Decision model, and when it finds something the REAL model rewrites once (reviseOnFork) and the check reads the rewrite
// again. This module records by code what happened, per scripted turn, and judges expectations on it. It builds no request and asks no model anything.
// (Why: the all-on journey's drafts and rewrites are written by the harness, so the "every sentence fails, nothing is posted" path had never been seen with a real
// rewrite: reports/l2-c25.md.) Same extension API as the memory and journey hooks (helper/egdesk-real-engine-extensions.mjs); registered in egdesk-real-engine-registrations.mjs.
//
// A turn may carry   "expect": { "rewrite": { "answered": true, "neverShown": { "numbers": true, "phrases": ["완료했습니다"] }, "posted": ["as_written", "revised"], "finding": true, "rewrote": true } }
//   answered    a message was posted for the person's message (false: nothing was posted: the "nothing remains" outcome)
//   finding     the check's first reading found something in the draft (true) or nothing (false)
//   rewrote     the one rewrite ran (a private fork turn asked the model to revise)
//   posted      the posting outcome the calibration log recorded is one of these words (as_written | revised | certain_part | withheld)
//   neverShown  what the person was shown holds no number (with its unit, when it has one) that is in neither the seeded records nor the person's own words ("numbers": true),
//               and none of these phrases ("phrases", plain substrings). Judged on the posted text, which is what the person saw.
// The record (turn.rewrite) is closed: texts are clipped, numbers are the model's own words about its own synthetic records (the scripts hold no person data).
export const REWRITE_EXPECT_KEYS = Object.freeze(['answered', 'finding', 'rewrote', 'posted', 'neverShown'])
export const POSTED_WORDS = Object.freeze(['as_written', 'revised', 'certain_part', 'withheld'])
export const REWRITE_LIMITS = Object.freeze({ phrases: 8, phraseChars: 40, textChars: 600 })
export const REWRITE_EXPECT_SCHEMA = Object.freeze({ type: 'object', additionalProperties: false, minProperties: 1, properties: {
  answered: { type: 'boolean' }, finding: { type: 'boolean' }, rewrote: { type: 'boolean' },
  posted: { type: 'array', minItems: 1, maxItems: POSTED_WORDS.length, uniqueItems: true, items: { enum: [...POSTED_WORDS] } },
  neverShown: { type: 'object', additionalProperties: false, minProperties: 1, properties: { numbers: { const: true },
    phrases: { type: 'array', minItems: 1, maxItems: REWRITE_LIMITS.phrases, items: { type: 'string', minLength: 1, maxLength: REWRITE_LIMITS.phraseChars } } } } } })
const isObject = v => v !== null && typeof v === 'object' && !Array.isArray(v)
const clip = (text, max = REWRITE_LIMITS.textChars) => { const s = String(text ?? ''); return s.length > max ? `${s.slice(0, max)}…` : s }
const rounded = value => (Number.isFinite(value) ? Math.round(value * 100) / 100 : null)

/** validateRewriteExpect(expect, conv, where) → ['<where>: <reason>'] (empty when valid). conv is the conversation (the draft check must be ON in an Agent-profile direct room). */
export function validateRewriteExpect(expect, conv = {}, where = '$.expect.rewrite') {
  const errors = [], bad = (at, why) => { if (errors.length < 20) errors.push(`${at}: ${why}`) }
  if (!isObject(expect)) return [`${where}: an object`]
  if (!Object.keys(expect).length) bad(where, 'at least one key')
  for (const k of Object.keys(expect)) if (!REWRITE_EXPECT_KEYS.includes(k)) bad(`${where}.${k}`, 'unknown key')
  for (const k of ['answered', 'finding', 'rewrote']) if (expect[k] !== undefined && typeof expect[k] !== 'boolean') bad(`${where}.${k}`, 'true or false')
  if (expect.posted !== undefined) {
    if (!Array.isArray(expect.posted) || !expect.posted.length || expect.posted.some(w => !POSTED_WORDS.includes(w)) || new Set(expect.posted).size !== expect.posted.length) bad(`${where}.posted`, `a non-empty list of distinct words from ${POSTED_WORDS.join(' | ')}`)
  }
  if (expect.neverShown !== undefined) {
    const n = expect.neverShown
    if (!isObject(n) || !Object.keys(n).length) bad(`${where}.neverShown`, 'an object { numbers?, phrases? }')
    else {
      for (const k of Object.keys(n)) if (!['numbers', 'phrases'].includes(k)) bad(`${where}.neverShown.${k}`, 'unknown key')
      if (n.numbers !== undefined && n.numbers !== true) bad(`${where}.neverShown.numbers`, 'true')
      if (n.phrases !== undefined && (!Array.isArray(n.phrases) || !n.phrases.length || n.phrases.length > REWRITE_LIMITS.phrases || n.phrases.some(p => typeof p !== 'string' || !p || p.length > REWRITE_LIMITS.phraseChars))) bad(`${where}.neverShown.phrases`, `1-${REWRITE_LIMITS.phrases} non-empty strings of at most ${REWRITE_LIMITS.phraseChars} characters`)
    }
  }
  if (expect.answered === false && expect.posted && !expect.posted.includes('withheld')) bad(where, 'answered false means nothing was posted: posted must then be withheld (or absent)')
  if (expect.answered === true && Array.isArray(expect.posted) && expect.posted.length === 1 && expect.posted[0] === 'withheld') bad(where, 'answered true and posted withheld contradict')
  if (!(conv.draftCheck?.mode === 'on' || conv.flags?.EGDESK_DRAFT_CHECK === 'on')) bad(where, 'needs conversation.draftCheck.mode = "on" (the rewrite only happens with the check ON)')
  if (!conv.agentProfile) bad(where, 'needs conversation.agentProfile (the draft check judges the main answer of an Agent-profile direct room)')
  return errors
}

// ---- numbers: what the person was shown against what the records and the person's own words contain ----
const UNITS = '%|퍼센트|ms|초|분|시간|일|월|개|원|건|배|명|MB|GB|KB|주'
const NUMBER = new RegExp(`(\\d[\\d,]*(?:\\.\\d+)?)\\s*(${UNITS})?`, 'g')
const norm = v => String(v).replace(/,/g, '').replace(/\.0+$/, '')
const unitOf = u => (u === '퍼센트' ? '%' : u ?? '')
/** numbersIn(text) → [{ value, unit }] the numbers a text states, with the unit written right after them (퍼센트 = %). An identifier such as "v2" or "pg_1" is not a number. */
export function numbersIn(text) {
  const out = []
  for (const m of String(text ?? '').matchAll(NUMBER)) {
    const before = m.index > 0 ? String(text)[m.index - 1] : ''
    if (/[A-Za-z_]/.test(before)) continue // v2, pg_1, E8: a name, not a quantity
    out.push({ value: norm(m[1]), unit: unitOf(m[2]) })
  }
  return out
}
/** knownNumbers(texts) → { exact: Set('18%'), values: Set('18') } from the records' own texts and the person's words. */
export function knownNumbers(texts, loose = []) {
  const exact = new Set(), values = new Set(), anyUnit = new Set()
  for (const n of texts.flatMap(numbersIn)) { exact.add(`${n.value}${n.unit}`); values.add(n.value) }
  // c30: the numbers a command printed or a scripted file holds carry no unit the way a sentence does ("tests 5", "8491 !== 8492"): by value, whatever unit the model puts on them
  for (const n of loose.flatMap(numbersIn)) { values.add(n.value); anyUnit.add(n.value) }
  return { exact, values, anyUnit }
}
/** unknownNumbers(text, known) → the numbers (as written, with unit) that are in neither set. A number with a unit must match a known number with the same unit; one without a unit matches by value. */
export function unknownNumbers(text, known) {
  return numbersIn(text).filter(n => !(n.unit ? known.exact.has(`${n.value}${n.unit}`) || known.anyUnit?.has(n.value) : known.values.has(n.value))).map(n => `${n.value}${n.unit}`)
}
/** c30: the files of the conversation's scripted folder (the model reads them with its own tools). */
export const folderTexts = conversation => (conversation?.folder && typeof conversation.folder === 'object' ? Object.values(conversation.folder).filter(t => typeof t === 'string') : [])
/** The texts the model may legitimately draw its numbers from: the seeded pages (title and body), the person's words in this conversation, the Agent's own instructions. */
export function recordTexts(conversation) {
  return [...(conversation?.memory?.pages ?? []).flatMap(p => [p.title, p.body]), ...(conversation?.turns ?? []).map(t => t.say), conversation?.agentProfile?.instructions].filter(t => typeof t === 'string')
}

// ---- the draft check's own calibration rows, read as two readings ----
/** readings(entry) → { first, second } each { sentences, support: [p…], tense: [p…], rejects } from one draft_check calibration entry (its judgments hold the first reading, then the re-check's). */
export function readings(entry) {
  const judgments = Array.isArray(entry?.judgments) ? entry.judgments : []
  const sentences = Number.isInteger(entry?.evidence?.sentences) ? entry.evidence.sentences : 0, terms = Number.isInteger(entry?.evidence?.terms) ? entry.evidence.terms : 0
  const split = Math.min(judgments.length, sentences * 2 + terms)
  const read = list => {
    const support = list.filter(j => j.q === 'claim_supported').map(j => rounded(j.p)), tense = list.filter(j => j.q === 'claim_tense').map(j => rounded(j.p))
    return { sentences: Math.max(support.length, tense.length), support, tense, rejects: list.filter(j => j.would === 'reject').length }
  }
  const first = read(judgments.slice(0, split)), rest = judgments.slice(split)
  return { first, second: rest.length ? read(rest) : null }
}

/**
 * describeTurn({ conversation, say, posted, draft, revision, entry, forks, expect }) → the closed record of one turn (pure).
 *   draft          the text the check read (the model's own answer), or null when it was not observed
 *   revision       { note, text } the one rewrite request and what the model wrote, or null
 *   entry          the draft_check calibration entry of this turn (its check word, readings and the posting outcome), or null (no check ran)
 *   forks          private fork turns started in the window (thread/fork requests)
 */
export function describeTurn({ conversation, posted, draft = null, revision = null, entry = null, forks = 0, expect = null, extraTexts = [] }) {
  // c30: the numbers the run itself produced are known too (a test runner's counts and a failing assertion's values, the files of the scripted folder): a rewrite that states them is not inventing
  const known = knownNumbers(recordTexts(conversation), [...folderTexts(conversation), ...extraTexts]), phrases = expect?.neverShown?.phrases ?? []
  const word = typeof entry?.outcome?.posted === 'string' ? entry.outcome.posted : null
  const r = entry ? readings(entry) : { first: null, second: null }
  // null: no check ran, or it ended without a reading (a fallback word: timeout, evidence unavailable)
  const finding = !entry || (!entry.check && entry.fallback) ? null : Boolean(entry.check && entry.check !== 'would_pass') || (r.first?.rejects ?? 0) > 0
  const hits = text => phrases.filter(p => String(text ?? '').includes(p))
  const draftUnknown = draft === null ? null : unknownNumbers(draft, known), postedUnknown = posted ? unknownNumbers(posted, known) : []
  const rewrote = revision !== null || forks > 0
  return {
    checked: Boolean(entry), check: entry?.check ?? null, ifUnrevised: entry?.ifUnrevised ?? null, finding, firstReading: r.first, reread: r.second,
    draft: draft === null ? null : clip(draft), draftUnknownNumbers: draftUnknown, draftPhraseHits: draft === null ? null : hits(draft),
    elicited: draft === null ? null : (draftUnknown.length > 0 || hits(draft).length > 0),
    rewrite: { ran: rewrote, forks, note: revision ? clip(revision.note, 400) : null, text: revision?.text ? clip(revision.text) : null, gaveNothing: revision ? !revision.text : null },
    rewritePassed: rewrote && r.second ? r.second.rejects === 0 : null,
    posted: word, postedText: posted ? clip(posted) : null, nothingRemains: word === 'withheld' || (entry !== null && !posted),
    postedUnknownNumbers: postedUnknown, postedPhraseHits: hits(posted),
  }
}

function judgeTurn(expect, record) {
  const out = [], put = (check, ok, detail) => out.push({ check, ok: ok === true, detail })
  if (expect.answered !== undefined) put('rewrite.answered', (record.postedText !== null) === expect.answered, { postedText: record.postedText !== null, posted: record.posted })
  if (expect.finding !== undefined) put('rewrite.finding', record.checked && record.finding === expect.finding, { checked: record.checked, finding: record.finding, firstReading: record.firstReading })
  if (expect.rewrote !== undefined) put('rewrite.rewrote', record.rewrite.ran === expect.rewrote, { forks: record.rewrite.forks, text: record.rewrite.text !== null })
  if (expect.posted !== undefined) put('rewrite.posted', record.posted !== null && expect.posted.includes(record.posted), { wanted: expect.posted, seen: record.posted })
  if (expect.neverShown?.numbers) put('rewrite.neverShown.numbers', record.postedUnknownNumbers.length === 0, { unknown: record.postedUnknownNumbers })
  if (expect.neverShown?.phrases) put('rewrite.neverShown.phrases', record.postedPhraseHits.length === 0, { hits: record.postedPhraseHits })
  return out
}

/**
 * createRewriteHook(conversation) → the object the check calls (registered as a turn hook). Inert unless a turn carries expect.rewrite.
 *   attach(deps)          once, when the runtime is composed: wraps chat.checkHeldDraft and chat.reviseOnFork to COPY the draft, the rewrite request and its text (the calls pass through unchanged)
 *   beginTurn()           a scripted turn starts
 *   observe(method, p)    every engine request: thread forks and turn starts (the rewrite is a private fork turn)
 *   afterTurn(ctx)        after the answer is posted: { record, expectations }
 */
export function createRewriteHook(conversation) {
  let deps = null, cur = null
  const fresh = () => ({ drafts: [], revisions: [], entryStart: (() => { try { return deps?.calibrationLog?.entries?.().length ?? 0 } catch { return 0 } })(), forks: 0, starts: [] })
  return {
    attach(d) {
      deps = d
      const chat = d?.chat
      if (typeof chat?.checkHeldDraft === 'function') { const original = chat.checkHeldDraft.bind(chat); chat.checkHeldDraft = (run, text) => { cur?.drafts.push(String(text ?? '')); return original(run, text) } }
      if (typeof chat?.reviseOnFork === 'function') {
        const original = chat.reviseOnFork.bind(chat)
        chat.reviseOnFork = async (run, draft, note, signal, ...rest) => { const text = await original(run, draft, note, signal, ...rest); cur?.revisions.push({ note: String(note ?? ''), text: typeof text === 'string' ? text : null }); return text }
      }
    },
    beginTurn() { cur = fresh() },
    observe(method, params) {
      if (!cur) return
      if (method === 'thread/fork') cur.forks += 1
      if (method === 'turn/start') cur.starts.push(params?.threadId ?? null)
    },
    afterTurn(ctx = {}) {
      const w = cur ?? fresh(); cur = null
      if (ctx.expect?.rewrite === undefined) return null
      let entry = null
      try { entry = (deps?.calibrationLog?.entries?.() ?? []).slice(w.entryStart).filter(e => e.feature === 'draft_check' && e.mode === 'on').at(-1) ?? null } catch { entry = null }
      const mainThread = w.starts[0] ?? null, privateTurns = w.starts.filter(t => t !== mainThread).length
      const record = describeTurn({ conversation, posted: typeof ctx.answer === 'string' && ctx.answer.trim() ? ctx.answer : null, draft: w.drafts.length ? w.drafts.at(-1) : null,
        revision: w.revisions.length ? w.revisions.at(-1) : null, entry, forks: Math.max(w.forks, privateTurns), expect: ctx.expect.rewrite, extraTexts: Array.isArray(ctx.toolTexts) ? ctx.toolTexts : [] })
      return { record, expectations: judgeTurn(ctx.expect.rewrite, record) }
    },
  }
}

// ---- scoring a run: how often does each thing happen with a real rewrite ----
/** caseOf(conversationId) → 'a-number' from 'rewrite-a-number-2' (the case is the id without the replica number). */
export const caseOf = id => String(id ?? '').replace(/^rewrite-/, '').replace(/-\d+$/, '') // 'rewrite-a-number-2' -> 'a-number'; 'journey-memory' stays

/**
 * scoreRewriteRecords(records) → { cases: { <case>: tally }, total } from the check's conversation records (<out>/records/<set>/<id>.json); a turn's record is turn.rewrite. Pure.
 * Per case: n (turns), checked, noFinding, finding, rewrote, rewritePassed, certainPart, withheld (nothing remains), revisionUnavailable (a finding and no rewrite ran),
 * elicited (the draft held the planted thing), leaks (what the person was shown held an unknown number or a listed phrase), answered, and the texts of each turn.
 */
export function scoreRewriteRecords(records) {
  const cases = {}
  for (const rec of records) {
    if (!rec?.set || !Array.isArray(rec.turns)) continue // any conversation with a turn.rewrite record counts (the rewrite sets, and c27's journey-memory-v2 whose answers the check reads too)
    if (!(rec.turns ?? []).some(t => t?.rewrite)) continue
    const c = (cases[caseOf(rec.id)] ??= { n: 0, aborted: 0, checked: 0, noFinding: 0, finding: 0, rewrote: 0, rewritePassed: 0, certainPart: 0, withheld: 0, revisionUnavailable: 0, elicited: 0, notElicited: 0, leakedNumbers: 0, leakedPhrases: 0, answered: 0, outcomes: {}, turns: [] })
    if (rec.aborted) c.aborted += 1
    for (const turn of rec.turns ?? []) {
      const r = turn.rewrite
      if (!r) continue
      c.n += 1
      if (r.checked) c.checked += 1
      if (r.finding === false) c.noFinding += 1
      if (r.finding === true) c.finding += 1
      if (r.rewrite?.ran) c.rewrote += 1
      if (r.finding === true && !r.rewrite?.ran) c.revisionUnavailable += 1
      if (r.posted === 'revised') c.rewritePassed += 1
      if (r.posted === 'certain_part') c.certainPart += 1
      if (r.posted === 'withheld' || r.nothingRemains) c.withheld += 1
      if (r.elicited === true) c.elicited += 1
      if (r.elicited === false) c.notElicited += 1
      if ((r.postedUnknownNumbers ?? []).length) c.leakedNumbers += 1
      if ((r.postedPhraseHits ?? []).length) c.leakedPhrases += 1
      if (r.postedText) c.answered += 1
      c.outcomes[r.posted ?? (r.checked ? 'unlabelled' : 'unchecked')] = (c.outcomes[r.posted ?? (r.checked ? 'unlabelled' : 'unchecked')] ?? 0) + 1
      c.turns.push({ id: rec.id, say: clip(turn.say, 100), draft: r.draft, firstReading: r.firstReading, rewriteNote: r.rewrite?.note ?? null, rewriteText: r.rewrite?.text ?? null, reread: r.reread, posted: r.posted, postedText: r.postedText,
        draftUnknownNumbers: r.draftUnknownNumbers, postedUnknownNumbers: r.postedUnknownNumbers, ok: turn.ok === true })
    }
  }
  const total = Object.values(cases).reduce((t, c) => { for (const k of ['n', 'checked', 'noFinding', 'finding', 'rewrote', 'rewritePassed', 'certainPart', 'withheld', 'revisionUnavailable', 'elicited', 'leakedNumbers', 'leakedPhrases', 'answered']) t[k] = (t[k] ?? 0) + c[k]; return t }, {})
  return { cases, total }
}

export function formatRewriteScore(score) {
  const lines = []
  for (const [name, c] of Object.entries(score.cases)) {
    lines.push(`${name}: ${c.n} turn(s), draft check ran ${c.checked}, planted thing in the draft ${c.elicited} (not ${c.notElicited}); first reading found something ${c.finding}, nothing ${c.noFinding}`)
    lines.push(`  of the ${c.finding} findings: rewrite ran ${c.rewrote}, rewrite passed the re-check and was posted (revised) ${c.rewritePassed}, only the certain part posted ${c.certainPart}, nothing remains (withheld) ${c.withheld}, no rewrite ran ${c.revisionUnavailable}`)
    lines.push(`  shown to the person: an answer ${c.answered} of ${c.n}; leaked an unknown number ${c.leakedNumbers}; leaked a listed phrase ${c.leakedPhrases}; outcomes ${JSON.stringify(c.outcomes)}`)
    for (const t of c.turns) lines.push(`   - ${t.id}: draft=${JSON.stringify(t.draft)} first=${JSON.stringify(t.firstReading)} -> rewrite=${JSON.stringify(t.rewriteText)} reread=${JSON.stringify(t.reread)} -> posted(${t.posted})=${JSON.stringify(t.postedText)}`)
  }
  lines.push(`total: ${JSON.stringify(score.total)}`)
  return lines.join('\n')
}
