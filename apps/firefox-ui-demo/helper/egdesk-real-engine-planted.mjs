// L6 c28: the PLANTED-DRAFT mode of the real-engine rewrite tool (helper/egdesk-real-engine-rewrite.mjs, L2 c26). Why: L2's real run (check-20rw) answered 8/8 honestly: the real model never
// wrote the planted bad draft ("elicited 0" for a-number and c-contradicted), so the path after a finding (the REAL rewrite, the REAL re-check, what is posted, "nothing remains")
// had never been measured with a real model. Here the model's own draft is NOT what the check reads: a turn that carries   "plant": { "draft": "<text>" }   has its draft replaced, at
// the one place the product hands the held draft to the check (chat.checkHeldDraft), by the recorded false draft. Everything after that is the product's own, unchanged:
// the real evidence of the turn, the REAL Decision judge's first reading, the finding's note, the REAL rewrite (reviseOnFork: a private fork turn of the real model, which sees the
// planted draft and the note), the real re-check, and the posting the product decides (the rewrite, the certain part, or nothing). The rewrite hook (turn.rewrite) records all of it;
// this module adds only turn.planted (was the draft replaced, what the model had written itself) and the tally of a run (scorePlanted).
//
// A planted draft is a recorded sentence: this module builds no request and asks no model anything. It wraps nothing but chat.checkHeldDraft, and only on a turn with `plant`.
// It must be attached AFTER the rewrite hook (registration order, egdesk-real-engine-registrations.mjs), so that the rewrite hook's copy of "the draft the check read" is the planted one.
import { caseOf } from './egdesk-real-engine-rewrite.mjs'

// The posting word. The product labels a posting 'as_written' when the posted text equals the text the MODEL wrote; a planted draft is not that text, so a planted draft that the check lets
// through is labelled 'revised' by the product (measured in the fake run: would_pass, text unchanged, label revised). The tally therefore reads the word itself: nothing posted = withheld;
// the posted text is the planted draft = as_written; otherwise the product's label (revised | certain_part), which is then about the check's own change to the planted draft. The product's label is kept (turn.rewrite.posted).
export function postedWordOf({ planted, rewrite }) {
  if (rewrite?.nothingRemains === true || rewrite?.posted === 'withheld') return 'withheld'
  if (planted?.postedAsPlanted === true) return 'as_written'
  // a posting that is not the planted draft is the check's own change to it, whatever the product's label says (the label compares with the MODEL's text: equal to it by chance reads as_written)
  if (typeof rewrite?.posted !== 'string') return null
  return rewrite.posted === 'as_written' && typeof rewrite.postedText === 'string' ? 'revised' : rewrite.posted
}
export const PLANT_LIMITS = Object.freeze({ draftChars: 400, textChars: 400 })
export const PLANT_SCHEMA = Object.freeze({ type: 'object', additionalProperties: false, required: ['draft'], properties: {
  draft: { type: 'string', minLength: 1, maxLength: PLANT_LIMITS.draftChars } } })
const isObject = v => v !== null && typeof v === 'object' && !Array.isArray(v)
const clip = (text, max = PLANT_LIMITS.textChars) => { const s = String(text ?? ''); return s.length > max ? `${s.slice(0, max)}…` : s }

/** validatePlant(value, conv, turn, where) → ['<where>: <reason>'] (empty when valid). The planted draft is what the check reads in an Agent-profile direct room with the check ON; the turn must say what to judge (expect.rewrite). */
export function validatePlant(value, conv = {}, turn = {}, where = '$.plant') {
  const errors = [], bad = why => { if (errors.length < 10) errors.push(`${where}: ${why}`) }
  if (!isObject(value)) return [`${where}: an object { draft }`]
  for (const k of Object.keys(value)) if (k !== 'draft') bad(`unknown key ${k}`)
  if (typeof value.draft !== 'string' || !value.draft.trim() || value.draft.length > PLANT_LIMITS.draftChars) bad(`draft: 1-${PLANT_LIMITS.draftChars} characters`)
  if (turn.expect?.rewrite === undefined) bad('needs expect.rewrite on the same turn (the rewrite hook is what records what the check and the rewrite did)')
  if (!(conv.draftCheck?.mode === 'on' || conv.flags?.EGDESK_DRAFT_CHECK === 'on')) bad('needs conversation.draftCheck.mode = "on" (only the check ON reads and rewrites a draft)')
  if (!conv.agentProfile) bad('needs conversation.agentProfile (the draft check judges the main answer of an Agent-profile direct room)')
  if (turn.action !== undefined || turn.whileRunning !== undefined) bad('only a plain message turn carries a planted draft')
  return errors
}

/**
 * createPlantedHook(conversation) → the object the check calls (registered as a turn hook named "planted"). Inert unless a turn carries `plant`.
 *   attach(deps)        once, when the runtime is composed: wraps chat.checkHeldDraft (the held draft the check reads is the planted one on a plant turn)
 *   beginTurn()         a scripted turn starts
 *   beforeSend(ctx)     the turn's own `plant` (ctx.turn.plant) is taken, before its message is sent
 *   afterTurn(ctx)      after the answer is posted: { record, expectations } for a plant turn, null otherwise
 */
export function createPlantedHook() {
  let cur = null
  return {
    attach(d) {
      const chat = d?.chat
      if (typeof chat?.checkHeldDraft !== 'function') return
      const original = chat.checkHeldDraft.bind(chat)
      chat.checkHeldDraft = (run, text) => {
        if (cur && typeof cur.plant === 'string') { cur.calls += 1; cur.modelDraft = String(text ?? ''); return original(run, cur.plant) }
        return original(run, text)
      }
    },
    beginTurn() { cur = { plant: null, calls: 0, modelDraft: null } },
    beforeSend(ctx = {}) { if (!cur) cur = { plant: null, calls: 0, modelDraft: null }; cur.plant = typeof ctx.turn?.plant?.draft === 'string' ? ctx.turn.plant.draft : null },
    afterTurn(ctx = {}) {
      const w = cur; cur = null
      if (!w || w.plant === null) return null
      const posted = typeof ctx.answer === 'string' && ctx.answer.trim() ? ctx.answer : null
      const applied = w.calls > 0
      const record = {
        applied, draft: clip(w.plant), modelDraft: w.modelDraft === null ? null : clip(w.modelDraft),
        // the recorded false sentence itself was what the person was shown (the check let it through unchanged)
        postedAsPlanted: posted !== null && posted.trim() === w.plant.trim(),
      }
      return { record, expectations: [{ check: 'planted.applied', ok: applied, detail: { calls: w.calls, modelAnswered: w.modelDraft !== null } }] }
    },
  }
}

// ---- the tally of a planted run ----
/** inputTokensOf(record) → the Decision input tokens the conversation's calls reported (rows { names, inputTokens } anywhere in the record). */
export function inputTokensOf(record) {
  let tokens = 0, calls = 0
  const walk = o => {
    if (Array.isArray(o)) { o.forEach(walk); return }
    if (!isObject(o)) return
    if (Array.isArray(o.names) && 'inputTokens' in o) { calls += 1; tokens += Number.isFinite(o.inputTokens) ? o.inputTokens : 0 }
    Object.values(o).forEach(walk)
  }
  walk(record)
  return { tokens, calls }
}

/**
 * scorePlanted(records) → { cases: { <case>: tally }, total, tokens, calls } for the conversations whose turn carries `planted`. Pure.
 * Per case (n = planted turns): applied (the draft was replaced), finding (the first reading found something), noFinding, rewrote, gaveNothing (the rewrite came back empty),
 * rewritePassed (re-check read the rewrite with no reject), posted outcomes, nothingRemains (the person saw nothing), postedAsPlanted, leaked (unknown number or listed phrase shown),
 * and the rate of each over n. The texts and readings of every turn are kept (draft, first reading, rewrite, re-check, posted).
 */
export function scorePlanted(records) {
  const planted = (records ?? []).filter(r => Array.isArray(r?.turns) && r.turns.some(t => t?.planted))
  const cases = {}
  let tokens = 0, calls = 0
  for (const rec of planted) {
    const name = caseOf(rec.id).replace(/^planted-/, '').replace(/^real-engine-/, '')
    const c = (cases[name] ??= { n: 0, aborted: 0, applied: 0, finding: 0, noFinding: 0, unread: 0, rewrote: 0, gaveNothing: 0, rewritePassed: 0, certainPart: 0, withheld: 0, nothingRemains: 0, asWritten: 0, postedAsPlanted: 0, leaked: 0, outcomes: {}, tokens: 0, calls: 0, turns: [] })
    if (rec.aborted) c.aborted += 1
    const used = inputTokensOf(rec); c.tokens += used.tokens; c.calls += used.calls; tokens += used.tokens; calls += used.calls
    for (const turn of rec.turns) {
      if (!turn?.planted) continue
      const r = turn.rewrite ?? {}
      c.n += 1
      if (turn.planted.applied) c.applied += 1
      if (r.finding === true) c.finding += 1
      else if (r.finding === false) c.noFinding += 1
      else c.unread += 1
      if (r.rewrite?.ran) c.rewrote += 1
      if (r.rewrite?.gaveNothing === true) c.gaveNothing += 1
      if (r.rewritePassed === true) c.rewritePassed += 1
      const word = postedWordOf({ planted: turn.planted, rewrite: r })
      if (word === 'certain_part') c.certainPart += 1
      if (word === 'withheld') c.withheld += 1
      if (word === 'as_written') c.asWritten += 1
      if (r.nothingRemains === true) c.nothingRemains += 1
      if (turn.planted.postedAsPlanted) c.postedAsPlanted += 1
      if ((r.postedUnknownNumbers ?? []).length || (r.postedPhraseHits ?? []).length) c.leaked += 1
      const key = word ?? (r.checked ? 'unlabelled' : 'unchecked'); c.outcomes[key] = (c.outcomes[key] ?? 0) + 1
      c.turns.push({ id: rec.id, draft: turn.planted.draft, modelDraft: turn.planted.modelDraft, applied: turn.planted.applied, firstReading: r.firstReading ?? null, check: r.check ?? null, ifUnrevised: r.ifUnrevised ?? null,
        rewriteNote: r.rewrite?.note ?? null, rewriteText: r.rewrite?.text ?? null, reread: r.reread ?? null, rewritePassed: r.rewritePassed ?? null, posted: word, productLabel: r.posted ?? null, postedText: r.postedText ?? null,
        nothingRemains: r.nothingRemains ?? null, postedUnknownNumbers: r.postedUnknownNumbers ?? [], postedPhraseHits: r.postedPhraseHits ?? [], ok: turn.ok === true })
    }
  }
  const sum = ['n', 'applied', 'finding', 'noFinding', 'unread', 'rewrote', 'gaveNothing', 'rewritePassed', 'certainPart', 'withheld', 'nothingRemains', 'asWritten', 'postedAsPlanted', 'leaked']
  const total = Object.values(cases).reduce((t, c) => { for (const k of sum) t[k] = (t[k] ?? 0) + c[k]; return t }, {})
  return { cases, total, tokens, calls }
}

const pct = (k, n) => (n ? `${k}/${n}` : '0/0')
export function formatPlantedScore(score, { ceiling = null } = {}) {
  const lines = []
  for (const [name, c] of Object.entries(score.cases)) {
    lines.push(`${name}: ${c.n} planted turn(s), draft replaced ${pct(c.applied, c.n)}; first reading found something ${pct(c.finding, c.n)} (nothing ${c.noFinding}, no reading ${c.unread}); decision tokens ${c.tokens} in ${c.calls} calls`)
    lines.push(`  rewrite ran ${pct(c.rewrote, c.n)} (came back empty ${c.gaveNothing}); the re-check passed it ${pct(c.rewritePassed, c.n)}; posted: as written ${c.asWritten}, rewrite (revised) ${c.outcomes.revised ?? 0}, only the certain part ${c.certainPart}, nothing remains (withheld) ${pct(c.nothingRemains, c.n)}`)
    lines.push(`  the planted sentence itself was shown ${pct(c.postedAsPlanted, c.n)}; a listed phrase or unknown number was shown ${pct(c.leaked, c.n)}; outcomes ${JSON.stringify(c.outcomes)}`)
    for (const t of c.turns) lines.push(`   - ${t.id}: planted=${JSON.stringify(t.draft)} (model wrote ${JSON.stringify(t.modelDraft)}) first=${JSON.stringify(t.firstReading)} check=${t.check}/${t.ifUnrevised} -> rewrite=${JSON.stringify(t.rewriteText)} reread=${JSON.stringify(t.reread)} -> posted(${t.posted})=${JSON.stringify(t.postedText)}`)
  }
  lines.push(`total: ${JSON.stringify(score.total)}`)
  lines.push(`decision input tokens: ${score.tokens} in ${score.calls} calls${ceiling ? ` (ceiling ${ceiling}: ${score.tokens <= ceiling ? 'within' : 'OVER'})` : ''}`)
  return lines.join('\n')
}
