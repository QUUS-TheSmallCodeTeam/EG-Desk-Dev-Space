// Regression diff of two all-on journey runs (lane L6 c22; analysis only, nothing here is read by the product and nothing is sent).
// Why: a journey that passed (v6) and then failed (v7) took a person hours to diagnose by hand. This module answers, per step and in minutes:
//   - which checks newly failed / newly passed (and which are new in the plan),
//   - which Decision request bodies changed, as the CHANGED LINES of the bodies (not whole bodies), with the question names that came or went,
//   - which Decision answers moved by 0.2 or more (a predicate's probability; a choice's value or confidence),
//   - how many messages the person was shown (agent messages, flow messages),
//   - and, for every body family whose bodies changed, the commits between the two int SHAs that touched that family's builder files, plus the
//     commits that added or removed the very text that appears in a changed line (git's pickaxe on the line's own words).
// A journey results file keeps only each request's sha256, byte count and question names; the bodies come from replaying the results against the
// code of each SHA (scripts/egdesk-journey-replay-driver.mjs). A body is "reproduced" when its sha256 is the recorded one.
export const ANSWER_MOVE = 0.2
export const SCORE_LINES = 4 // changed lines shown per side of a hunk
export const HUNKS_SHOWN = 3
export const COMMITS_SHOWN = 8

/**
 * Where each body family is built: the files whose change can change those bodies, and question-name fragments that must appear in them (the
 * test pins this map to the current code: a renamed question or a moved builder fails it instead of silently pointing at nothing).
 * 'wiring' files assemble the material a builder quotes (candidates, held pages, evidence catalog, draft text).
 */
export const FAMILY_FILES = Object.freeze({
  turn_context: { builder: ['helper/egdesk-context-setup.mjs'], wiring: ['helper/codex-chat-runtime.mjs', 'helper/egdesk-context-pruning.mjs', 'helper/egdesk-context-resolver.mjs', 'helper/egdesk-previous-reply.mjs', 'helper/egdesk-decision-questions.mjs'], probes: ['rel_', 'answer_type'] },
  memory_triage: { builder: ['helper/egdesk-turn-memory.mjs'], wiring: ['helper/codex-chat-runtime.mjs', 'helper/egdesk-turn-memory-wiring.mjs', 'helper/egdesk-wiki-adapter.mjs', 'helper/egdesk-previous-reply.mjs', 'helper/egdesk-wiki-reconstruction.mjs'], probes: ['tn_need'] },
  memory_fetch: { builder: ['helper/egdesk-wiki-reconstruction.mjs'], wiring: ['helper/egdesk-turn-memory.mjs', 'helper/egdesk-turn-memory-wiring.mjs', 'helper/egdesk-wiki-adapter.mjs', 'helper/codex-chat-runtime.mjs'], probes: ['pg_'] },
  memory_write: { builder: ['helper/egdesk-turn-memory.mjs'], wiring: ['helper/egdesk-speech-grounding.mjs', 'helper/egdesk-turn-memory-wiring.mjs', 'helper/codex-chat-runtime.mjs'], probes: ['tw_status', 'speech_'] },
  draft_check: { builder: ['helper/egdesk-draft-check.mjs'], wiring: ['helper/codex-chat-runtime.mjs', 'helper/egdesk-decision-questions.mjs'], probes: ['tense_', 'sup_'] },
  briefing: { builder: ['helper/egdesk-briefing-skeleton.mjs'], wiring: ['helper/egdesk-briefing-flow.mjs', 'helper/egdesk-briefing-engine.mjs', 'helper/egdesk-board-presentation-http.mjs', 'helper/egdesk-briefing-catalog.mjs', 'helper/egdesk-briefing-bindings.mjs', 'overlay/resources/EGDeskBriefingHost.sys.mjs'], probes: ['combines', 'onboard_'] },
  command_judge: { builder: ['helper/egdesk-terminal-judge.mjs'], wiring: ['helper/egdesk-engine-command-watch.mjs'], probes: ['terminal_state'] },
  heartbeat: { builder: ['helper/egdesk-heartbeat-judge.mjs'], wiring: ['helper/egdesk-conversation-flow.mjs', 'helper/egdesk-heartbeat-providers.mjs', 'helper/egdesk-heartbeat.mjs'], probes: ['person_status', '__${raw.name}'] },
  work_placement: { builder: ['helper/egdesk-work-placement.mjs'], wiring: ['overlay/resources/EGDeskWorkPlacement.sys.mjs'], probes: ['owner_action'] },
  browser_entry: { builder: ['helper/egdesk-browser-task.mjs'], wiring: ['helper/egdesk-browser-task-memory.mjs'], probes: ['browser_entry'] },
  browser_step: { builder: ['helper/egdesk-browser-reflex.mjs'], wiring: ['helper/egdesk-browser-task.mjs'], probes: ['next_step'] },
  browser_resume: { builder: ['helper/egdesk-browser-task.mjs'], wiring: ['helper/egdesk-browser-task-memory.mjs'], probes: ['task_resume'] },
})
/**
 * The functions that decide what a family's bodies hold. A file such as codex-chat-runtime.mjs changes in most commits, so the commits that touched
 * the FILE are a long list; the commits that changed one of these FUNCTIONS (git log -L on its definition) are the short list that matters.
 * The test pins every entry to a definition line of the current code.
 */
export const FAMILY_SYMBOLS = Object.freeze({
  turn_context: [['helper/codex-chat-runtime.mjs', 'prepareDecisionContext'], ['helper/codex-chat-runtime.mjs', 'turnPosition'], ['helper/codex-chat-runtime.mjs', 'previousReplyFor'], ['helper/egdesk-context-setup.mjs', 'prepareTurnContext']],
  memory_triage: [['helper/codex-chat-runtime.mjs', 'turnPosition'], ['helper/codex-chat-runtime.mjs', 'directEvidenceReader'], ['helper/egdesk-turn-memory.mjs', 'triageTurn']],
  memory_fetch: [['helper/egdesk-wiki-reconstruction.mjs', 'reconstructMemory'], ['helper/codex-chat-runtime.mjs', 'directEvidenceReader']],
  memory_write: [['helper/egdesk-turn-memory.mjs', 'judgeTurnWrite']],
  draft_check: [['helper/egdesk-draft-check.mjs', 'checkDraft'], ['helper/egdesk-draft-check.mjs', 'judge']],
  briefing: [['helper/egdesk-briefing-skeleton.mjs', 'runSkeletonFlow']],
  command_judge: [['helper/egdesk-terminal-judge.mjs', 'judgeTerminalState']],
  heartbeat: [['helper/egdesk-conversation-flow.mjs', 'flowPredicates'], ['helper/egdesk-conversation-flow.mjs', 'deriveFlowKind'], ['helper/egdesk-heartbeat-judge.mjs', 'createBeatJudge']],
  work_placement: [['helper/egdesk-work-placement.mjs', 'createWorkPlacement']],
  browser_entry: [['helper/egdesk-browser-task.mjs', 'decideBrowserEntry']],
  browser_step: [['helper/egdesk-browser-reflex.mjs', 'decideReflexStep']],
  browser_resume: [['helper/egdesk-browser-task.mjs', 'decideResume']],
})
/** The definition line of a function in a source text (a function, method or exported function), or null. */
export const definitionRegex = name => new RegExp(`^[ \\t]*(?:export[ \\t]+)?(?:async[ \\t]+)?(?:function[ \\t]+)?${name}[ \\t]*\\(`)
export const familyFiles = family => (Object.hasOwn(FAMILY_FILES, family) ? [...FAMILY_FILES[family].builder, ...FAMILY_FILES[family].wiring] : null)

// ---- bodies as lines ----
/** A request body as one comparable line per text line: every JSON string is split at its newlines and each line is prefixed with its path. (The top-level prompt_cache_key is left out: it is a hash of the content.) */
export function flattenBody(body) {
  let value = body
  if (typeof body === 'string') { try { value = JSON.parse(body) } catch { return body.split('\n') } }
  const out = []
  const walk = (v, p) => {
    if (typeof v === 'string') { for (const line of v.split('\n')) out.push(`${p} | ${line}`) }
    else if (Array.isArray(v)) v.forEach((x, i) => walk(x, `${p}[${x && typeof x === 'object' && (x.name ?? x.role ?? x.type) ? (x.name ?? x.role ?? x.type) : i}]`))
    else if (v && typeof v === 'object') for (const [k, x] of Object.entries(v)) { if (k === 'prompt_cache_key' && !p) continue; walk(x, p ? `${p}.${k}` : k) } // the cache key is derived from the content: noise
    else out.push(`${p} = ${JSON.stringify(v)}`)
  }
  walk(value, '')
  return out
}
/** Line diff (longest common subsequence). -> hunks: [{ removed: [...], added: [...], after }] in order, and the number of changed lines. */
export function diffLines(a, b) {
  const n = a.length, m = b.length
  if (n * m > 4_000_000) return { hunks: [{ removed: a, added: b, after: null }], changed: n + m, truncated: true }
  const d = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1))
  for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) d[i][j] = a[i] === b[j] ? d[i + 1][j + 1] + 1 : Math.max(d[i + 1][j], d[i][j + 1])
  const hunks = []
  let i = 0, j = 0, cur = null, changed = 0, lastCommon = null
  const flush = () => { if (cur) { hunks.push(cur); cur = null } }
  while (i < n || j < m) {
    if (i < n && j < m && a[i] === b[j]) { flush(); lastCommon = a[i]; i++; j++; continue }
    cur ??= { removed: [], added: [], after: lastCommon } // after: the unchanged line right before the hunk (what section it sits in)
    if (j >= m || (i < n && d[i + 1][j] >= d[i][j + 1])) cur.removed.push(a[i++])
    else cur.added.push(b[j++])
    changed++
  }
  flush()
  return { hunks, changed }
}

/** What a body diff means in words, from its hunks (heuristics: they name a thing to look at, they do not decide). */
export function hintsOf(entry) {
  const hints = []
  const wording = new Set()
  for (const h of entry.hunks) for (const line of [...h.removed, ...h.added]) { const m = /^questions\[([^\]]+)\]\.instructions \|/.exec(line); if (m) wording.add(m[1]) }
  if (wording.size) hints.push(`wording of ${[...wording].join(', ')} changed`)
  if (entry.nameChanges && (entry.nameChanges.added.length || entry.nameChanges.removed.length)) hints.push(`question set changed (${entry.names.old.length} -> ${entry.names.new.length})`)
  for (const h of entry.hunks) {
    const gone = h.removed.filter(l => !/^questions\[/.test(l))
    if (gone.length >= 3 && (!h.added.length || h.added.every(l => /\(nothing\)|\(none\)|\(empty\)/.test(l)))) hints.push(`a section of ${gone.length} lines is gone${h.added.length ? ' and reads (nothing)' : ''}${h.after ? `, after "${clip(String(h.after).replace(/^[^|]*\|\s?/, ''), 60)}"` : ''}`)
  }
  const heldGone = entry.hunks.some(h => h.removed.some(l => /\b(held|already delivered|already sent)\b/i.test(l)) && !h.added.some(l => /\b(held|already delivered|already sent)\b/i.test(l)))
  if (heldGone) hints.push('lines about held (already delivered) pages are gone')
  return hints
}
/** Hunks in the order worth reading: question wording first, then removed sections, then the biggest. */
const hunkRank = h => (h.removed.concat(h.added).some(l => /^questions\[[^\]]+\]\.instructions \|/.test(l)) ? 0 : h.removed.length >= 3 && (!h.added.length || h.added.every(l => /\(nothing\)|\(none\)|\(empty\)/.test(l))) ? 1 : 2)

// ---- pairing ----
const groupBy = (list, keyOf) => { const m = new Map(); for (const x of list) { const k = keyOf(x); if (!m.has(k)) m.set(k, []); m.get(k).push(x) } return m }
const stepKey = (step, family) => `${step}\u0000${family}`
const rowsOf = results => (results?.steps ?? []).flatMap(step => (step.requests ?? []).map(row => ({ step: step.id, ...row })))
const hardOf = results => { const h = results?.scorecard?.hard; return h ? `${h.passed}/${h.passed + (h.failed?.length ?? 0) + (h.notRun ?? 0)}` : null }
const softOf = results => { const s = results?.scorecard?.soft; return s ? `${s.passed}/${s.passed + (s.missed?.length ?? 0) + (s.notRun ?? 0)}` : null }
const agentMessages = step => (step?.seen?.newMessages ?? []).filter(m => m?.by === 'agent').length
const flowMessages = step => (Array.isArray(step?.seen?.flows) ? step.seen.flows.length : 0)
const answerOf = a => (!a ? null : a.type === 'predicate' ? { p: a.probability } : a.type === 'choice' ? { v: a.choice, c: a.confidence } : { other: a.type ?? 'missing' })
export const answerWord = a => (!a ? '-' : a.p !== undefined ? String(Math.round(a.p * 100) / 100) : a.v !== undefined ? `${a.v}@${Math.round((a.c ?? 0) * 100) / 100}` : String(a.other))
const moved = (a, b) => (!a || !b ? true : a.p !== undefined && b.p !== undefined ? Math.abs(a.p - b.p) >= ANSWER_MOVE - 1e-9
  : a.v !== undefined && b.v !== undefined ? a.v !== b.v || Math.abs((a.c ?? 0) - (b.c ?? 0)) >= ANSWER_MOVE - 1e-9 : JSON.stringify(a) !== JSON.stringify(b))

/** Text of a changed line worth searching the source for: the words after the path, long enough and not data-like. */
export function pickaxeText(line) {
  const whole = String(line).replace(/^[^|=]*[|=]\s?/, '').trim()
  if (/^[#\-\[\]"'`{}]/.test(whole)) return null
  // a number or an id (S1, #7, E3) is probably filled in by the code: search the longest stretch without one
  const text = whole.split(/\b[A-Za-z]?\d+\b/).map(x => x.trim()).sort((p, q) => q.length - p.length)[0] ?? ''
  if (text.length < 28 || (text.match(/[A-Za-z]/g) ?? []).length < 12) return null
  return text.slice(0, 80)
}

/**
 * buildDiffReport({ old, new, commitsFor, pickaxe }) -> the report (see formatReport).
 *   old / new: { label, sha, results, bodies, replay: { built, reproduced, recorded } }   bodies: the replay driver's bodies ({ step, family, names, body, sha256 })
 *   commitsFor(files) -> [{ sha, author, subject }]   the commits between the two SHAs that touched any of the files
 *   pickaxe(text, files) -> [{ sha, author, subject }]   the commits between the two SHAs whose diff adds or removes this text in those files
 *   symbolCommits(file, name) -> [{ sha, author, subject }]   the commits between the two SHAs that changed the function `name` defined in `file`
 */
export function buildDiffReport({ old: a, new: b, commitsFor = () => [], pickaxe = () => [], symbolCommits = () => [] }) {
  const recordedShas = side => new Set(rowsOf(side.results).map(r => r.sha256))
  const reproducedOld = recordedShas(a), reproducedNew = recordedShas(b)
  const side = (s, recorded) => ({ label: s.label ?? null, sha: s.sha ?? null, at: s.results?.at ?? null, hard: hardOf(s.results), soft: softOf(s.results), plan: s.results?.plan?.sha256?.slice(0, 12) ?? null,
    world: s.results?.world ?? null, replay: { built: s.bodies.length, reproduced: s.bodies.filter(x => recorded.has(x.sha256)).length, recorded: rowsOf(s.results).length,
      notReproduced: s.bodies.filter(x => !recorded.has(x.sha256)).map(x => ({ step: x.step, family: x.family, names: x.names })) } })
  const stepsOld = new Map((a.results?.steps ?? []).map(s => [s.id, s])), stepsNew = new Map((b.results?.steps ?? []).map(s => [s.id, s]))
  const ids = [...new Set([...(b.results?.steps ?? []).map(s => s.id), ...(a.results?.steps ?? []).map(s => s.id)])]
  const bodiesOld = groupBy(a.bodies, x => stepKey(x.step, x.family)), bodiesNew = groupBy(b.bodies, x => stepKey(x.step, x.family))
  const rowsOldBy = groupBy(rowsOf(a.results), r => stepKey(r.step, r.family)), rowsNewBy = groupBy(rowsOf(b.results), r => stepKey(r.step, r.family))
  const changedFamilies = new Map()
  const steps = ids.map(id => {
    const so = stepsOld.get(id) ?? null, sn = stepsNew.get(id) ?? null
    const out = { id, presence: !so ? 'new step' : !sn ? 'removed step' : null, title: (sn ?? so)?.title ?? null,
      checks: { newlyFailed: [], newlyPassed: [], newFailing: [], newPassing: [], removed: [] }, posted: null, requests: null, bodies: [], answers: [] }
    // checks, by id
    const co = new Map((so?.checks ?? []).map(c => [c.id, c])), cn = new Map((sn?.checks ?? []).map(c => [c.id, c]))
    for (const [cid, c] of cn) {
      const p = co.get(cid), info = { id: cid, severity: c.severity, owner: c.owner ?? null, text: c.text ?? null, observed: c.observed ?? null, predicted: c.predicted ?? null }
      if (!p) (c.pass ? out.checks.newPassing : out.checks.newFailing).push(info)
      else if (p.pass && !c.pass) out.checks.newlyFailed.push(info)
      else if (!p.pass && c.pass) out.checks.newlyPassed.push(info)
    }
    for (const [cid, c] of co) if (!cn.has(cid)) out.checks.removed.push({ id: cid, severity: c.severity })
    out.posted = { oldAgent: so ? agentMessages(so) : null, newAgent: sn ? agentMessages(sn) : null, oldFlows: so ? flowMessages(so) : null, newFlows: sn ? flowMessages(sn) : null }
    const count = list => (list ?? []).reduce((m, r) => (m[r.family] = (m[r.family] ?? 0) + 1, m), {})
    out.requests = { old: count(so?.requests), new: count(sn?.requests) }
    // bodies and answers, paired by (step, family, order)
    for (const family of new Set([...(sn?.requests ?? []), ...(so?.requests ?? [])].map(r => r.family))) {
      const key = stepKey(id, family), bo = bodiesOld.get(key) ?? [], bn = bodiesNew.get(key) ?? [], ro = rowsOldBy.get(key) ?? [], rn = rowsNewBy.get(key) ?? []
      for (let i = 0; i < Math.max(bo.length, bn.length); i++) {
        const x = bo[i], y = bn[i]
        if (x && y && x.sha256 === y.sha256) continue
        const entry = { family, ordinal: i + 1, status: !x ? 'added' : !y ? 'removed' : 'changed', names: { old: x?.names ?? null, new: y?.names ?? null },
          bytes: { old: x ? Buffer.byteLength(x.body) : null, new: y ? Buffer.byteLength(y.body) : null }, reproduced: { old: x ? reproducedOld.has(x.sha256) : null, new: y ? reproducedNew.has(y.sha256) : null }, hunks: [], changedLines: 0, nameChanges: null, pickaxe: [] }
        if (x && y) {
          const d = diffLines(flattenBody(x.body), flattenBody(y.body))
          entry.hunks = d.hunks.sort((p, q) => hunkRank(p) - hunkRank(q) || (q.removed.length + q.added.length) - (p.removed.length + p.added.length)); entry.changedLines = d.changed
          const so2 = new Set(x.names), sn2 = new Set(y.names)
          entry.nameChanges = { added: y.names.filter(n => !so2.has(n)), removed: x.names.filter(n => !sn2.has(n)) }
          // the commits that added or removed the words of the changed lines (a few lines per body, the largest hunks first)
          const files = familyFiles(family) ?? []
          const seen = new Set()
          for (const line of entry.hunks.flatMap(h => [...h.removed, ...h.added])) {
            const text = pickaxeText(line)
            if (!text || seen.has(text) || seen.size >= 4) continue
            seen.add(text)
            const found = pickaxe(text, files)
            if (found.length) entry.pickaxe.push({ text, commits: found })
          }
        }
        entry.hints = hintsOf(entry)
        out.bodies.push(entry)
        changedFamilies.set(family, (changedFamilies.get(family) ?? 0) + 1)
      }
      for (let i = 0; i < Math.min(ro.length, rn.length); i++) {
        const mo = new Map((ro[i].answers ?? []).map(x => [x.name, answerOf(x)])), mn = new Map((rn[i].answers ?? []).map(x => [x.name, answerOf(x)]))
        for (const name of new Set([...mo.keys(), ...mn.keys()])) if (mo.has(name) && mn.has(name) && moved(mo.get(name), mn.get(name))) out.answers.push({ family, ordinal: i + 1, name, old: mo.get(name), new: mn.get(name) })
      }
    }
    return out
  })
  const families = [...changedFamilies].map(([family, bodies]) => {
    const spec = Object.hasOwn(FAMILY_FILES, family) ? FAMILY_FILES[family] : null
    const builderCommits = spec ? commitsFor(spec.builder) : []
    const builderShas = new Set(builderCommits.map(c => c.sha))
    const wiringCommits = spec ? commitsFor(spec.wiring).filter(c => !builderShas.has(c.sha)) : []
    const symbols = (FAMILY_SYMBOLS[family] ?? []).map(([file, name]) => ({ file, name, commits: symbolCommits(file, name) }))
    return { family, changedBodies: bodies, builder: spec?.builder ?? null, wiring: spec?.wiring ?? null, mapped: spec !== null, builderCommits, wiringCommits, symbols }
  })
  return { old: side(a, reproducedOld), new: side(b, reproducedNew), steps, families }
}

// ---- text ----
const clip = (text, n = 150) => (text.length > n ? `${text.slice(0, n - 1)}…` : text)
const num = n => (n === null || n === undefined ? '-' : n.toLocaleString('en-US'))
const names = list => (list ? list.join(',') : '-')
const short = list => { const t = names(list); return t.length > 60 ? `${t.slice(0, 59)}…` : t }
/** The report as lines of text. */
export function formatReport(report, { full = false } = {}) {
  const L = []
  const head = s => `${s.label ?? '?'} @ ${s.sha ? s.sha.slice(0, 7) : '?'}${s.at ? ` (${s.at.slice(0, 16)}Z)` : ''}: hard ${s.hard ?? '?'}, soft ${s.soft ?? '?'}`
  L.push(`journey diff: ${head(report.old)}  ->  ${head(report.new)}`)
  for (const [name, s] of [['old', report.old], ['new', report.new]]) {
    L.push(`replay ${name}: ${s.replay.reproduced}/${s.replay.built} bodies rebuilt exactly (${s.replay.recorded} requests recorded)${s.replay.notReproduced.length ? `; NOT rebuilt exactly: ${s.replay.notReproduced.map(x => `${x.step} ${x.family}`).join(', ')} (a diff against them shows the code's body, not the sent one)` : ''}`)
  }
  const failed = report.steps.flatMap(s => s.checks.newlyFailed.map(c => `${c.id}`)), fixed = report.steps.flatMap(s => s.checks.newlyPassed.map(c => c.id))
  L.push(`checks: newly failed ${failed.length}${failed.length ? ` (${failed.join(', ')})` : ''}; newly passed ${fixed.length}${fixed.length ? ` (${fixed.join(', ')})` : ''}; new in the plan ${report.steps.reduce((t, s) => t + s.checks.newFailing.length + s.checks.newPassing.length, 0)} (failing ${report.steps.reduce((t, s) => t + s.checks.newFailing.length, 0)})`)
  for (const s of report.steps) {
    const c = s.checks, posted = s.posted
    const messageChange = posted.oldAgent !== posted.newAgent || posted.oldFlows !== posted.newFlows
    const quiet = !s.presence && !c.newlyFailed.length && !c.newlyPassed.length && !c.newFailing.length && !s.bodies.length && !s.answers.length && !messageChange
    if (quiet) continue
    L.push('', `== ${s.id}${s.presence ? ` (${s.presence})` : ''}`)
    for (const x of c.newlyFailed) L.push(`  FAILED   ${x.id} (${x.severity}${x.owner ? `, ${x.owner}` : ''}): ${clip(x.text ?? '', 110)}${x.observed ? `   observed ${clip(JSON.stringify(x.observed), 90)}` : ''}`)
    for (const x of c.newlyPassed) L.push(`  PASSED   ${x.id} (${x.severity}${x.owner ? `, ${x.owner}` : ''})`)
    for (const x of c.newFailing) L.push(`  new check, failing: ${x.id} (${x.severity}${x.owner ? `, ${x.owner}` : ''})${x.predicted ? '   (the plan predicted it)' : ''}`)
    if (messageChange) L.push(`  posted   agent messages ${num(posted.oldAgent)} -> ${num(posted.newAgent)}; flow messages ${num(posted.oldFlows)} -> ${num(posted.newFlows)}`)
    const fo = s.requests.old, fn = s.requests.new, fams = [...new Set([...Object.keys(fo), ...Object.keys(fn)])].filter(f => (fo[f] ?? 0) !== (fn[f] ?? 0))
    if (fams.length) L.push(`  requests ${fams.map(f => `${f} ${fo[f] ?? 0} -> ${fn[f] ?? 0}`).join(', ')}`)
    for (const body of s.bodies) {
      L.push(`  body     ${body.family} #${body.ordinal} ${body.status}${body.status === 'changed' ? `: ${num(body.bytes.old)} -> ${num(body.bytes.new)} bytes, ${body.changedLines} changed lines` : `: ${num(body.bytes.old ?? body.bytes.new)} bytes`}`
        + `${body.reproduced.new === false ? '  [new body not rebuilt exactly]' : ''}${body.reproduced.old === false ? '  [old body not rebuilt exactly]' : ''}`)
      if (body.nameChanges && (body.nameChanges.added.length || body.nameChanges.removed.length)) L.push(`           questions ${body.names.old.length} -> ${body.names.new.length}: +${short(body.nameChanges.added) || '-'} -${short(body.nameChanges.removed) || '-'}`)
      for (const hint of body.hints ?? []) L.push(`           hint: ${hint}`)
      for (const h of body.hunks.slice(0, full ? body.hunks.length : HUNKS_SHOWN)) {
        const kind = !h.added.length ? 'removed' : !h.removed.length ? 'added' : 'replaced'
        L.push(`           ${kind} ${h.removed.length}${h.added.length ? `/+${h.added.length}` : ''} lines${h.after ? `   (after: ${clip(String(h.after), 90)})` : ''}`)
        for (const line of h.removed.slice(0, full ? h.removed.length : SCORE_LINES)) L.push(`             - ${clip(line)}`)
        if (!full && h.removed.length > SCORE_LINES) L.push(`             - … ${h.removed.length - SCORE_LINES} more removed`)
        for (const line of h.added.slice(0, full ? h.added.length : SCORE_LINES)) L.push(`             + ${clip(line)}`)
        if (!full && h.added.length > SCORE_LINES) L.push(`             + … ${h.added.length - SCORE_LINES} more added`)
      }
      if (!full && body.hunks.length > HUNKS_SHOWN) L.push(`           … ${body.hunks.length - HUNKS_SHOWN} more hunks`)
      for (const px of body.pickaxe) L.push(`           text "${clip(px.text, 60)}" added/removed by: ${px.commits.slice(0, 3).map(c => `${c.sha} ${clip(c.subject, 70)}`).join(' | ')}`)
    }
    for (const x of s.answers) L.push(`  answer   ${x.family} #${x.ordinal} ${x.name}: ${answerWord(x.old)} -> ${answerWord(x.new)}`)
  }
  if (report.families.length) {
    L.push('', `== commits between ${report.old.sha?.slice(0, 7) ?? '?'} and ${report.new.sha?.slice(0, 7) ?? '?'} that touched the files that build the bodies of a family that changed`)
    const listed = new Set()
    const list = (commits, label) => {
      const fresh = commits.filter(c => !listed.has(c.sha)), again = commits.length - fresh.length
      for (const c of fresh.slice(0, full ? fresh.length : COMMITS_SHOWN)) { listed.add(c.sha); L.push(`    ${label}${c.sha} ${c.author ? `${c.author}: ` : ''}${clip(c.subject, 120)}`) }
      for (const c of fresh.slice(full ? fresh.length : COMMITS_SHOWN)) listed.add(c.sha)
      if (!full && fresh.length > COMMITS_SHOWN) L.push(`    … ${fresh.length - COMMITS_SHOWN} more (--full, or --json)`)
      if (again) L.push(`    (${again} listed under an earlier family)`)
    }
    for (const f of report.families) {
      if (!f.mapped) { L.push(`  ${f.family} (${f.changedBodies} changed): no file map for this family: add it to FAMILY_FILES`); continue }
      L.push(`  ${f.family} (${f.changedBodies} changed ${f.changedBodies === 1 ? 'body' : 'bodies'}): builder ${f.builder.join(', ')}: ${f.builderCommits.length} commit${f.builderCommits.length === 1 ? '' : 's'}`)
      list(f.builderCommits, '')
      for (const sym of f.symbols ?? []) if (sym.commits.length) L.push(`    function ${sym.name} (${sym.file.replace(/^(helper|overlay\/resources)\//, '')}) changed by: ${sym.commits.map(c => `${c.sha} ${clip(c.subject, 60)}`).join(' | ')}`)
      L.push(`    wiring ${f.wiring.map(w => w.replace(/^(helper|overlay\/resources)\//, '')).join(', ')}: ${f.wiringCommits.length} commit${f.wiringCommits.length === 1 ? '' : 's'}`)
      list(f.wiringCommits, '  ')
    }
  }
  return L
}
