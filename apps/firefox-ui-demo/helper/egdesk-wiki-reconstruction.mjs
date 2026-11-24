import { choiceQuestion, compactText, predicateQuestion, readChoice, sha256Hex } from './egdesk-decision-questions.mjs'

// PROTOTYPE (not wired into the turn path): llm-wiki memory reconstruction for the subjective model.
//
// The Decision model is a system-level judge. It reads page CONTENT (not titles), picks the pages the message
// needs, picks which linked pages to open next (the links are the options), and reads each picked record's status.
// The host then assembles one reconstructed-memory packet for the answering (subjective) model.
// Division of labour:
//   code  : pages, metadata, typed links, scopes/permissions, budgets, delivered-fragment receipts, packet layout.
//   judge : relevance of a page to this message, whether a link is worth opening, the status a record's own content shows.
// Not here: calendar arithmetic (the judge sees the question clock and page times, it does not compute dates),
// writes (a status the judge reads is a fallible reading shown next to the stored metadata, never an update),
// and options the code did not produce (the judge cannot name a page that is not in the wiki).
// Every call is stateless: the request carries the message, the clock and an explicit state block; page aliases (P1..)
// are per call and only mapped back locally.

export const TIME_SLICES = Object.freeze(['past', 'present', 'planned', 'hypothetical', 'unknown'])
export const LINK_TYPES = Object.freeze({
  same_task: 'Both pages belong to the same task or case.',
  follows_from: 'This page continues, or is a consequence of, the linked page.',
  decided_in: 'This page\'s decision or plan was made in the linked page.',
  supersedes: 'This page replaces the linked page once it is done.',
  refers_to: 'This page mentions the linked page.',
})
export const PROVENANCE_KINDS = Object.freeze(['own_record', 'document', 'agent_note', 'utterance', 'reported_by_other'])
// How the speaker came to say it (the speech source label vocabulary). Only on utterance-type pages.
export const PROVENANCE_BASES = Object.freeze(['self_reported_observation', 'attributed_report', 'inference', 'record_based', 'unspecified'])
export const RECORD_STATUSES = Object.freeze({
  plan: 'The record says something is intended or scheduled, not done.',
  done: 'The record says it was carried out or is the settled state.',
  superseded: 'The record itself says a later record replaced it.',
  reported_by_other: 'The record only relays what someone else said; it is not the writer\'s own record.',
  unknown: 'The content does not show which of these applies, or it mixes them.',
})
const STATUS_KEYS = Object.keys(RECORD_STATUSES)
export const YES = 0.8, NO = 0.2 // predicate guide: yes >= 0.8, no <= 0.2, in between is undecided
export const DEFAULTS = Object.freeze({ maxCalls: 4, maxScanCalls: 2, maxCatalogChars: 9000, excerptChars: 600, maxPicks: 6, maxDepth: 1,
  maxOpenOptions: 12, maxPacketChars: 8000, pageChars: 2400, timeoutMs: 4000 })

export const record = value => value !== null && typeof value === 'object' && !Array.isArray(value)
const ID = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,119}$/
const REVISION = /^[A-Za-z0-9._-]{1,40}$/

/**
 * buildWiki(pages) → { pages, links(id), backlinks(id), supersededBy(id), warnings, add, addLink, patch }
 * page: { id, title, body, time: { slice, at? }, provenance: { kind, by? }, status?, revision, scope?, spokenAt?, links?: [{ type, to }], mayRead? }
 * Links are maintained by code and validated here: closed types, existing targets, no self-links, bounded per page.
 * An invalid page or link is dropped and counted, never repaired by guessing.
 * add / addLink / patch are the HOST's mutation API (used only by the write path in egdesk-turn-memory.mjs after its
 * permission and revision checks). They are never offered to the judge.
 */
export const READING_LIMIT = 8
const iso = value => (typeof value === 'string' && !Number.isNaN(Date.parse(value)) ? value : null)
function normalizePage(raw, maxBody) {
  const ok = record(raw) && typeof raw.id === 'string' && ID.test(raw.id) && typeof raw.title === 'string' && raw.title.trim() &&
    typeof raw.body === 'string' && raw.body.trim() && REVISION.test(String(raw.revision ?? '')) &&
    PROVENANCE_KINDS.includes(raw.provenance?.kind) && (raw.time === undefined || TIME_SLICES.includes(raw.time?.slice))
  if (!ok) return null
  return { id: raw.id, title: compactText(raw.title, 160), body: raw.body.slice(0, maxBody), revision: String(raw.revision),
    time: { slice: raw.time?.slice ?? 'unknown', ...(iso(raw.time?.at) ? { at: raw.time.at } : {}) },
    provenance: { kind: raw.provenance.kind, ...(typeof raw.provenance.by === 'string' ? { by: compactText(raw.provenance.by, 60) } : {}), ...(PROVENANCE_BASES.includes(raw.provenance.basis) ? { basis: raw.provenance.basis } : {}) },
    status: STATUS_KEYS.includes(raw.status) ? raw.status : 'unknown', scope: typeof raw.scope === 'string' ? raw.scope : null,
    // A stable reference into the store that already holds this content (shown to the answering model), and an optional
    // content key of that store (e.g. its own hash) so receipts do not depend on how the adapter renders the body.
    ...(typeof raw.ref === 'string' && raw.ref.trim() ? { ref: compactText(raw.ref, 300) } : {}),
    ...(typeof raw.contentKey === 'string' && /^[A-Za-z0-9._:+/=-]{1,120}$/.test(raw.contentKey) ? { contentKey: raw.contentKey } : {}),
    // When it was said / recorded. Never confused with the time of the event it describes (time.at).
    ...(iso(raw.spokenAt) ? { spokenAt: raw.spokenAt } : {}),
    // Fallible readings of a status change that the host has not (yet) accepted. Kept apart from `status`.
    statusReadings: Array.isArray(raw.statusReadings) ? raw.statusReadings.filter(r => record(r) && STATUS_KEYS.includes(r.status)).slice(-READING_LIMIT) : [],
    rawLinks: Array.isArray(raw.links) ? raw.links : [], mayRead: typeof raw.mayRead === 'function' ? raw.mayRead : null }
}
export function buildWiki(input, { maxPages = 400, maxLinks = 16, maxBody = 20000 } = {}) {
  const pages = new Map(), warnings = { droppedPages: 0, droppedLinks: 0 }
  const out = new Map(), back = new Map()
  for (const raw of Array.isArray(input) ? input.slice(0, maxPages) : []) {
    const page = normalizePage(raw, maxBody)
    if (!page || pages.has(page.id)) { warnings.droppedPages++; continue }
    pages.set(page.id, page)
  }
  const addLink = (from, type, to) => {
    const page = pages.get(from), list = out.get(from) ?? []
    if (!page || !Object.hasOwn(LINK_TYPES, type) || typeof to !== 'string' || to === from || !pages.has(to) || list.length >= maxLinks || list.some(l => l.type === type && l.to === to)) return false
    list.push({ type, to }); out.set(from, list)
    if (!back.has(to)) back.set(to, [])
    back.get(to).push({ type, from })
    return true
  }
  for (const page of pages.values()) {
    out.set(page.id, [])
    for (const link of page.rawLinks.slice(0, maxLinks * 2)) if (!record(link) || !addLink(page.id, link.type, link.to)) warnings.droppedLinks++
    delete page.rawLinks
  }
  // A replacement counts only when the replacing page is itself settled: a plan that "supersedes" is not yet a replacement.
  const settled = id => { const p = pages.get(id); return p && (p.time.slice === 'past' || p.time.slice === 'present') && p.status === 'done' }
  return { pages, warnings, links: id => out.get(id) ?? [], backlinks: id => back.get(id) ?? [],
    supersededBy: id => (back.get(id) ?? []).filter(l => l.type === 'supersedes' && settled(l.from)).map(l => l.from),
    add(raw) {
      const page = pages.size < maxPages ? normalizePage(raw, maxBody) : null
      if (!page || pages.has(page.id)) return null
      pages.set(page.id, page); out.set(page.id, [])
      const wanted = page.rawLinks; delete page.rawLinks
      for (const link of wanted.slice(0, maxLinks)) if (record(link)) addLink(page.id, link.type, link.to)
      return page
    },
    addLink,
    // Only these fields can change after creation, and only through the host's write path.
    patch(id, patch) {
      const page = pages.get(id)
      if (!page || !record(patch)) return false
      if (patch.status !== undefined) { if (!STATUS_KEYS.includes(patch.status)) return false; page.status = patch.status }
      if (patch.revision !== undefined) { if (!REVISION.test(String(patch.revision))) return false; page.revision = String(patch.revision) }
      if (patch.statusReadings !== undefined) page.statusReadings = patch.statusReadings.filter(r => record(r) && STATUS_KEYS.includes(r.status)).slice(-READING_LIMIT)
      return true
    } }
}

/** The one permission rule for reading a page: its own guard, then its scope against what this caller may read. */
export function allowsPage(page, scope) {
  try {
    if (page.mayRead && page.mayRead() !== true) return false
    if (!page.scope) return true
    if (typeof scope?.allows === 'function') return scope.allows(page) === true
    return Array.isArray(scope?.allowedScopes) && scope.allowedScopes.includes(page.scope)
  } catch { return false }
}
export const stableAlias = index => `P${index + 1}`
export function pageBlock(alias, page, chars, extra = '') {
  const text = page.body.length > chars ? `${page.body.slice(0, chars).trimEnd()} […]` : page.body
  return `${alias} | time=${page.time.slice}${page.time.at ? `@${page.time.at.slice(0, 10)}` : ''} | provenance=${page.provenance.kind}${page.provenance.by ? `:${page.provenance.by}` : ''} | rev=${page.revision}${extra} | ${page.title}\n${text}`
}
export const clockLine = asked => (Number.isSafeInteger(asked) ? `Question clock: ${new Date(asked).toISOString()} (UTC offset minutes ${-new Date(asked).getTimezoneOffset()}). Page times are as recorded; judge, do not compute dates.` : 'Question clock: unknown.')
export const JUDGE_RULES = [
  'You are a system judge that reconstructs memory for another model. Judge only from the page contents shown and the message.',
  'A page is needed when its content helps answer the message. A recorded plan is not a done fact; a relayed statement is attribution, not the writer\'s own record.',
  'Never invent a page. If the options do not fit, choose unknown.',
].join('\n')
export const ternary = answer => (answer?.type !== 'predicate' || !Number.isFinite(answer.probability) ? { state: 'unknown', p: null }
  : { state: answer.probability >= YES ? 'yes' : answer.probability <= NO ? 'no' : 'unknown', p: answer.probability })

function pack(items, maxChars, excerptChars, render) {
  const batches = []
  let current = [], used = 0
  for (const item of items) {
    const size = render(item, 'P00').length
    if (current.length && used + size > maxChars) { batches.push(current); current = []; used = 0 }
    current.push(item); used += size
  }
  if (current.length) batches.push(current)
  return batches
}

/**
 * reconstructMemory({ message, wiki, client, scope?, askedAt?, delivered?, budget?, signal?, now? })
 * scope: { allows(page) → boolean } or { allowedScopes: [...] } — code decides what may leave; unscoped pages are public.
 * delivered: { usable: boolean, pages: { [id]: { revision, hash } } } receipts of what this thread's subjective model already holds.
 * → { status: 'ready'|'empty'|'fallback', packet, picks, receipts, nextDelivered(), calls, usage }
 *   status 'ready' may still carry partial: true when a later round failed; the picks so far are kept.
 */
export const NEXT_RULES = [
  'You are a system judge. The answering model is MID-CONVERSATION: it already holds the pages listed as HELD and the live conversation. Do not reconstruct memory.',
  'Pick only the stored pages whose content it still needs to make the next judgment this message asks for, and that the held pages and the conversation do not already cover.',
  'A recorded plan is not a done fact; a relayed statement is attribution. Never invent a page. If the options do not fit, choose unknown.',
].join('\n')

/** mode 'first' (default): reconstruct memory for a session whose model holds nothing. mode 'next': fetch only what the next judgment needs; `live` is host-gated recent conversation text or null. */
export async function reconstructMemory({ message, wiki, client, scope = null, askedAt = null, delivered = null, budget: overrides = {}, signal, now = () => performance.now(), mode = 'first', live = null } = {}) {
  const budget = { ...DEFAULTS, ...overrides }
  const empty = (status, reason) => ({ status, reason, packet: null, picks: [], receipts: { calls: 0 }, nextDelivered: () => delivered, calls: 0, usage: { inputTokens: 0 } })
  if (!client || !wiki?.pages) return empty('fallback', 'not_configured')
  if (typeof message !== 'string' || !message.trim()) return empty('fallback', 'no_message')
  const started = now(), deadline = Number.isFinite(budget.deadlineMs) ? started + budget.deadlineMs : Infinity
  const receipts = { mode, calls: 0, rounds: [], withheld: 0, unscanned: [], skippedDelivered: [], uncertain: [], truncated: [] }
  const usage = { inputTokens: 0 }
  const allows = page => allowsPage(page, scope)
  const have = delivered?.usable === true ? delivered.pages ?? {} : {}
  const keyOf = page => page.contentKey ?? sha256Hex(page.body)
  const sameAsDelivered = page => have[page.id]?.revision === page.revision && have[page.id]?.hash === keyOf(page)
  const readable = [], alreadyDelivered = []
  for (const page of wiki.pages.values()) {
    if (!allows(page)) { receipts.withheld++; continue }
    ;(sameAsDelivered(page) ? alreadyDelivered : readable).push(page)
  }
  receipts.skippedDelivered = alreadyDelivered.map(p => p.id)
  const isNext = mode === 'next'
  const rules = isNext ? NEXT_RULES : JUDGE_RULES
  // Held pages are shown by header only: the judge knows what the model holds, the content is never re-sent.
  const heldMessage = isNext ? [{ role: 'user', content: `Held in the answering model's context (content not repeated):\n${alreadyDelivered.length ? alreadyDelivered.map(p => `- ${p.title} | time=${p.time.slice} | status=${p.status}`).join('\n') : '(nothing)'}` },
    ...(typeof live === 'string' && live.trim() ? [{ role: 'user', content: `Live conversation (recent turns, bounded):\n${live.slice(-3000)}` }] : [])] : []
  const canCall = () => receipts.calls < budget.maxCalls && now() < deadline && !signal?.aborted
  const decide = async (questions, input) => {
    receipts.calls++
    const remaining = Number.isFinite(deadline) ? Math.max(1, Math.floor(deadline - now())) : budget.timeoutMs
    const result = await client.decide({ input, questions, timeoutMs: Math.min(budget.timeoutMs, remaining), signal })
    usage.inputTokens += result?.usage?.inputTokens ?? 0
    return result
  }
  const picks = new Map() // id -> { id, p, via, statusRead, statusP }
  let partial = false, failure = null

  // Round 0: scan the content of readable pages, in as few parallel stateless batches as the budget allows.
  // Mid-session with budget.linksFirst, only the link neighbours of what the model holds are scanned first (structure orders the
  // work, the judge still decides from content); the rest is scanned only if that finds nothing, and is reported as unscanned otherwise.
  const render = (page, alias) => pageBlock(alias, page, budget.excerptChars)
  const second = []
  async function scan(list, label) {
    const batches = pack(list, budget.maxCatalogChars, budget.excerptChars, render)
    const room = Math.max(0, Math.min(budget.maxScanCalls, budget.maxCalls - receipts.calls))
    const scanned = batches.slice(0, room)
    for (const batch of batches.slice(room)) receipts.unscanned.push(...batch.map(p => p.id))
    if (!scanned.length || !canCall()) return
    const calls = scanned.map(async batch => {
      const questions = batch.map((_, i) => predicateQuestion(`pg_${i}`, isNext ? `Does the answering model still need the content of page ${stableAlias(i)} for its next judgment?` : `Does answering the message need the content of page ${stableAlias(i)}?`))
      const input = [{ role: 'developer', content: rules }, ...heldMessage,
        { role: 'user', content: `Pages:\n${batch.map((p, i) => render(p, stableAlias(i))).join('\n\n')}` },
        { role: 'user', content: `${clockLine(askedAt)}\nState: round=scan; picked=[]\nMessage:\n${message}` }]
      try { return { batch, result: await decide(questions, input) } } catch (error) { return { batch, error } }
    })
    for (const { batch, result, error } of await Promise.all(calls)) {
      if (error || !result) { failure ??= error?.code ?? 'unreachable'; continue }
      batch.forEach((page, i) => {
        const v = ternary(result.answers?.[`pg_${i}`])
        if (v.state === 'yes') picks.set(page.id, { id: page.id, p: v.p, via: 'scan' })
        else if (v.state === 'unknown' && v.p !== null) { second.push(page); receipts.uncertain.push({ id: page.id, p: v.p }) }
      })
    }
    receipts.rounds.push({ kind: 'scan', label, batches: scanned.length, pages: scanned.reduce((n, b) => n + b.length, 0) })
  }
  let scanSet = readable, rest = []
  if (isNext && budget.linksFirst === true) {
    const near = new Set()
    for (const h of alreadyDelivered) { for (const l of wiki.links(h.id)) near.add(l.to); for (const l of wiki.backlinks(h.id)) near.add(l.from) }
    scanSet = readable.filter(p => near.has(p.id)); rest = readable.filter(p => !near.has(p.id))
    receipts.linksFirst = { neighbours: scanSet.length, others: rest.length }
  }
  await scan(scanSet, 'first')
  if (failure && !picks.size) return { ...empty('fallback', failure), receipts: { ...receipts, calls: receipts.calls }, calls: receipts.calls, usage }
  if (rest.length && !picks.size && !failure && canCall()) { receipts.linksFirst.widened = true; await scan(rest, 'widened') }
  else if (rest.length) receipts.unscanned.push(...rest.map(p => p.id))
  if (failure && !picks.size) return { ...empty('fallback', failure), receipts: { ...receipts, calls: receipts.calls }, calls: receipts.calls, usage }
  if (failure) partial = true
  // Keep the strongest picks within the budget; the rest is reported, not dropped silently.
  const ranked = [...picks.values()].sort((a, b) => b.p - a.p)
  for (const extra of ranked.slice(budget.maxPicks)) { picks.delete(extra.id); receipts.truncated.push({ id: extra.id, reason: 'pick_limit' }) }

  // Expansion rounds: the options are the links of the frontier (plus an explicit second look at uncertain pages).
  // The same call classifies the status of every record picked so far that has not been classified yet.
  // Mid-session, the links of what the model already holds are options too: that is how "what comes next" is reached.
  let frontier = [...picks.keys(), ...(isNext ? alreadyDelivered.map(p => p.id) : [])], depth = 0
  const opened = new Set(picks.keys())
  const classified = new Set()
  while ((frontier.length || second.length) && canCall() && !failure) {
    const options = []
    const seenOption = new Set()
    if (depth < budget.maxDepth) {
      for (const id of frontier) for (const link of [...wiki.links(id).map(l => ({ type: l.type, page: l.to, from: id, dir: 'out' })),
        ...wiki.backlinks(id).map(l => ({ type: l.type, page: l.from, from: id, dir: 'in' }))]) {
        const page = wiki.pages.get(link.page)
        if (!page || opened.has(page.id) || seenOption.has(page.id) || !allows(page) || sameAsDelivered(page)) continue
        seenOption.add(page.id); options.push({ ...link, kind: 'link', target: page })
      }
    }
    if (depth === 0) for (const page of second) if (!seenOption.has(page.id)) { seenOption.add(page.id); options.push({ kind: 'second_look', target: page }) }
    const cut = options.slice(0, budget.maxOpenOptions)
    for (const o of options.slice(budget.maxOpenOptions)) receipts.truncated.push({ id: o.target.id, reason: 'option_limit' })
    const toClassify = [...picks.keys()].filter(id => !classified.has(id))
    if (!cut.length && !toClassify.length) break
    // Stateless explicit state: the picked pages are shown again with their contents, under fresh aliases.
    const blocks = [], aliasToId = new Map()
    let n = 0
    const alias = page => { const a = stableAlias(n++); aliasToId.set(a, page.id); return a }
    const pickedBlocks = toClassify.map(id => { const page = wiki.pages.get(id), a = alias(page)
      const sup = wiki.supersededBy(id); return { a, id, text: pageBlock(a, page, budget.excerptChars, sup.length ? ' | later-record-supersedes=yes' : '') } })
    const optionBlocks = cut.map(o => { const a = alias(o.target)
      return { a, o, text: `${pageBlock(a, o.target, budget.excerptChars)}\n(reached by link: ${o.kind === 'link' ? `${o.dir === 'out' ? 'from' : 'to'} a picked page, type ${o.type}` : 'second look: uncertain in the scan'})` } })
    const questions = [
      ...pickedBlocks.map(b => choiceQuestion(`st_${b.a}`, `What does the content of page ${b.a} show about the record itself (not about the message)?`,
        STATUS_KEYS.map(value => ({ value, description: RECORD_STATUSES[value] })))),
      ...optionBlocks.map(b => predicateQuestion(`op_${b.a}`, isNext ? `Does the answering model also still need the content of page ${b.a} for its next judgment?` : `Does answering the message also need the content of page ${b.a}?`)),
    ]
    const input = [{ role: 'developer', content: rules }, ...heldMessage,
      ...(pickedBlocks.length ? [{ role: 'user', content: `Picked pages:\n${pickedBlocks.map(b => b.text).join('\n\n')}` }] : []),
      ...(optionBlocks.length ? [{ role: 'user', content: `Linked pages you may open:\n${optionBlocks.map(b => b.text).join('\n\n')}` }] : []),
      { role: 'user', content: `${clockLine(askedAt)}\nState: round=expand depth=${depth}; picked=[${pickedBlocks.map(b => b.a).join(',')}]\nMessage:\n${message}` }]
    let result
    try { result = await decide(questions, input) } catch (error) { failure = error?.code ?? 'unreachable'; partial = true; break }
    for (const b of pickedBlocks) {
      classified.add(b.id)
      const read = readChoice(result.answers, `st_${b.a}`, { minConfidence: 0.75, minMargin: 0.2 })
      const pick = picks.get(b.id)
      if (read.state === 'accepted' && read.value !== 'unknown') { pick.statusRead = read.value; pick.statusP = read.confidence }
    }
    const next = []
    for (const b of optionBlocks) {
      const v = ternary(result.answers?.[`op_${b.a}`])
      if (v.state !== 'yes' || picks.size >= budget.maxPicks) { if (v.state === 'yes') receipts.truncated.push({ id: b.o.target.id, reason: 'pick_limit' }); continue }
      picks.set(b.o.target.id, { id: b.o.target.id, p: v.p, via: b.o.kind === 'link' ? `link:${b.o.type}` : 'second_look', ...(b.o.kind === 'link' ? { from: b.o.from } : {}) })
      opened.add(b.o.target.id); next.push(b.o.target.id)
    }
    receipts.rounds.push({ kind: 'expand', depth, options: cut.length, classified: pickedBlocks.length, opened: next.length })
    second.length = 0
    frontier = next; depth++
  }
  if (failure) partial = true

  // Packet for the subjective model. Unchanged pages the thread already holds are sent as receipts, not content.
  const order = [...picks.values()].sort((a, b) => (a.via === 'scan' ? 0 : 1) - (b.via === 'scan' ? 0 : 1) || b.p - a.p)
  const blocks = []
  let used = 0
  const nextPages = { ...(have) }
  for (const pick of order) {
    const page = wiki.pages.get(pick.id)
    if (!page || !allows(page)) { receipts.withheld++; continue } // authority is re-checked at assembly
    const sup = wiki.supersededBy(page.id)
    const header = `[page id=${page.id} time=${page.time.slice}${page.time.at ? `@${page.time.at.slice(0, 10)}` : ''} provenance=${page.provenance.kind}${page.provenance.by ? `:${page.provenance.by}` : ''} ` +
      `status-recorded=${page.status}${pick.statusRead ? ` status-read=${pick.statusRead}` : ''}${page.statusReadings?.some(r => r.state === 'pending') ? ` status-reported-pending=${page.statusReadings.filter(r => r.state === 'pending').at(-1).status}` : ''}${sup.length ? ` superseded-by=${sup.join('+')}` : ''} rev=${page.revision}${page.ref ? ` ref=${page.ref}` : ''} via=${pick.via}]`
    const body = page.body.length > budget.pageChars ? `${page.body.slice(0, budget.pageChars).trimEnd()}\n[…truncated]` : page.body
    if (page.body.length > budget.pageChars) receipts.truncated.push({ id: page.id, reason: 'page_chars' })
    const block = `${header}\n${body}`
    if (used + block.length > budget.maxPacketChars && blocks.length) { receipts.truncated.push({ id: page.id, reason: 'packet_chars' }); continue }
    used += block.length; blocks.push({ id: page.id, block })
    nextPages[page.id] = { revision: page.revision, hash: keyOf(page) }
  }
  // Links between pages the model now holds (this packet or earlier), by id only.
  const inPacket = new Set(blocks.map(b => b.id)), held = new Set([...inPacket, ...Object.keys(have)])
  const linkLines = []
  for (const id of held) for (const link of wiki.links(id)) if (held.has(link.to) && (inPacket.has(id) || inPacket.has(link.to))) linkLines.push(`${id} ${link.type} ${link.to}`)
  const pointers = alreadyDelivered.filter(p => blocks.some(b => wiki.links(b.id).some(l => l.to === p.id) || wiki.backlinks(b.id).some(l => l.from === p.id)))
    .map(p => `[page id=${p.id} rev=${p.revision} already delivered earlier in this thread, unchanged; content not re-sent]`)
  const head = [isNext ? 'EG-Desk fetched these stored pages for the judgment this message asks for. Pages you already hold from earlier in this conversation are not repeated.' : 'EG-Desk reconstructed memory for this turn: pages chosen by a judge that read their contents, plus pages reached through recorded links.',
    'Each page shows time (past/present/planned/hypothetical), provenance (who recorded it and how), the recorded status and, where present, the judge\'s fallible reading of that status.',
    'A planned or hypothetical page is not a current fact. reported_by_other is attribution, not the writer\'s own record and not independent evidence. A status reading or score is not proof and not permission to change any record.',
    clockLine(askedAt)].join('\n')
  const parts = blocks.length ? [head, ...blocks.map(b => b.block), ...(pointers.length ? [pointers.join('\n')] : []), ...(linkLines.length ? [`[links among held pages]\n${linkLines.join('\n')}`] : [])] : []
  receipts.picks = order.map(p => ({ id: p.id, via: p.via, p: p.p, statusRead: p.statusRead ?? null }))
  const delivery = Object.fromEntries(blocks.map(b => [b.id, true]))
  return { status: parts.length ? 'ready' : 'empty', ...(partial ? { partial: true, reason: failure } : {}), packet: parts.join('\n\n') || null,
    picks: order.map(p => ({ ...p })), receipts: { ...receipts, calls: receipts.calls }, calls: receipts.calls, usage,
    // The host commits this only after the turn really started with the packet; it is never applied here.
    nextDelivered: () => ({ usable: true, pages: nextPages }), delivered: delivery, elapsedMs: now() - started }
}
