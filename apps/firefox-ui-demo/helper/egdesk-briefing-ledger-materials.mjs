// L4 cycle 24: briefing materials built BY CODE from the decision loop's own record (its ledger and the lane reports), for measuring the briefing on real,
// dated, non-synthetic material. Pure: text in, pages out; no file access here (the script reads, read-only, and writes the pages OUTSIDE the repository).
// Rules (never invent): a date only where the text states one (a ledger line "- MM-DD HH:MM ..."; the year is NOT in those lines, so it is applied only when the
// caller declares it with its basis, else the date stays unknown); a status only where the text states it (merged / assigned or started / received), else
// unknown; links only from what the text names (the same lane and cycle, the next cycle of a lane, an event naming a lane's cycle). Secrets are always masked.
// The rows have lane L7's memory-row shape (title, excerpt, time.at, status, links [{ type, toAlias }]), so the briefing skeleton takes them as they are.

/** Keys, tokens, emails, credentials and home paths, masked. Commit ids and lane/agent ids are kept (they are identifiers, not secrets). */
const SECRET_RULES = Object.freeze([
  [/\bsk-(?:proj-|ant-|live-|test-)?[A-Za-z0-9_-]{16,}/g, '[masked:key]'],
  [/\begd-synthetic-not-a-key-\d+\b/g, '[masked:key]'],
  [/\b(?:gh[pousr]_|github_pat_)[A-Za-z0-9_]{20,}/g, '[masked:token]'],
  [/\bxox[abprs]-[A-Za-z0-9-]{10,}/g, '[masked:token]'],
  [/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g, '[masked:token]'],
  [/\bBearer\s+[A-Za-z0-9._~+/=-]{12,}/gi, 'Bearer [masked:token]'],
  [/\b(api[_-]?key|access[_-]?token|token|secret|password|passwd)(\s*[:=]\s*)(?!\[masked)[^\s,;)]+/gi, '$1$2[masked]'],
  [/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, '[masked:email]'],
  [/\/Users\/[^/\s]+\//g, '~/'],
])
export function maskSecrets(text) {
  let out = String(text ?? '')
  for (const [re, to] of SECRET_RULES) out = out.replace(re, to)
  return out
}
const LIMITS = Object.freeze({ title: 80, excerpt: 400 })
const flat = t => String(t ?? '').replace(/\s*\|\s*/g, ' ').replace(/`+/g, '').replace(/\*\*|__/g, '').replace(/^#+\s*/gm, '').replace(/\[([^\]]*)\]\([^)]*\)/g, '$1').replace(/\s+/g, ' ').trim()
const cut = (t, max) => (t.length <= max ? t : `${t.slice(0, max - 1).trimEnd()}…`)
// "L4 c19", "L4c19", "L4 c19(…)", "lane L4 cycle 19"
const LANE_CYCLE = /\bL([1-9])\s?c(\d{1,3})\b/g
export const laneCyclesIn = text => [...new Set([...String(text).matchAll(LANE_CYCLE)].map(m => `l${m[1]}-c${Number(m[2])}`))]

/** The lane-cycles a ledger line states were MERGED: named with their commit id ("L4 c19(7571661)") in a line that says 병합/merged, and not followed by a
 *  conflict, hold or exclusion ("L1 c12(49be194)는 충돌 2파일 → L1 c13에서 재병합" merges nothing for L1 c12). */
export function mergedLaneCycles(text) {
  const t = String(text)
  if (!/병합|merged/i.test(t)) return []
  return [...new Set([...t.matchAll(/\bL([1-9])\s?c(\d{1,3})\(([0-9a-f]{7,40})[^)]*\)(?=([^,;]{0,24}))/g)].filter(m => !/충돌|보류|제외|않|실패|conflict|held|excluded/i.test(m[4])).map(m => `l${m[1]}-c${Number(m[2])}`))]
}
/** The status a ledger line states, by its words; anything else is unknown. merged -> done; assigned / started -> plan; a lane's report received -> reported_by_other. */
export function statedStatus(text) {
  const t = String(text)
  if (/병합|merged/i.test(t)) return 'done'
  if (/배정|착수|assigned/i.test(t)) return 'plan'
  if (/수신|received/i.test(t)) return 'reported_by_other'
  return 'unknown'
}
const declaredYear = year => (Number.isSafeInteger(year) && year >= 2000 && year <= 2100 ? year : null)
const pad = n => String(n).padStart(2, '0')
function dated(year, month, day) {
  const y = declaredYear(year)
  if (!y || month < 1 || month > 12 || day < 1 || day > 31) return null
  const d = new Date(Date.UTC(y, month - 1, day))
  return d.getUTCMonth() === month - 1 ? `${y}-${pad(month)}-${pad(day)}` : null
}

/**
 * parseLedger(text, { year }) -> events [{ id, at, clock, lanes, status, title, excerpt }]: one per dated line "- MM-DD HH:MM text".
 * year: the caller's declared year for these lines (they do not state one); without it every `at` is null (the month-day stays in the title).
 */
export function parseLedger(text, { year = null } = {}) {
  const events = [], seen = new Map()
  for (const line of String(text ?? '').split('\n')) {
    const m = /^- (\d{1,2})-(\d{1,2}) (\d{1,2}):(\d{2}) (.+)$/.exec(line.trim())
    if (!m) continue
    const [month, day, hh, mm] = [Number(m[1]), Number(m[2]), Number(m[3]), Number(m[4])]
    const body = flat(maskSecrets(m[5]))
    const stamp = `${pad(month)}-${pad(day)} ${pad(hh)}:${pad(mm)}`
    const n = (seen.get(stamp) ?? 0) + 1; seen.set(stamp, n)
    const head = body.split(/(?<=[.:)])\s|\s—\s|→/)[0]
    events.push({ id: `ledger-${pad(month)}${pad(day)}-${pad(hh)}${pad(mm)}-${n}`, at: dated(year, month, day), clock: `${pad(hh)}:${pad(mm)}`, lanes: laneCyclesIn(body), merged: mergedLaneCycles(body),
      status: statedStatus(body), title: cut(`${stamp} ${head}`, LIMITS.title), excerpt: cut(`${stamp} ${body}`, LIMITS.excerpt) })
  }
  return events
}

/** parseReport(fileName, text) -> { id, lane, cycle, title, excerpt, at } | null. The report's own H1 is its title; the excerpt is its opening prose; a date only if stated. */
export function parseReport(fileName, text) {
  const f = /^l([1-9])-c(\d{1,3})\.md$/.exec(String(fileName))
  if (!f) return null
  const lines = maskSecrets(text).split('\n')
  const h1 = lines.find(l => /^#\s+\S/.test(l))
  if (!h1) return null
  const title = cut(flat(h1), LIMITS.title)
  // the opening prose: the lines after the title up to the first second-level heading, minus branch / commit / gate / evidence bookkeeping lines
  const start = lines.indexOf(h1) + 1, end = lines.findIndex((l, i) => i >= start && /^##\s/.test(l))
  const bookkeeping = l => /^\s*[-*]?\s*(?:브랜치|branch|커밋|commit|게이트|gate|증거|evidence)(?=[\s:：(]|$)/i.test(flat(l)) || /^\s*[-*]?\s*`?[0-9a-f]{7,40}`?\s*[:：]/.test(l)
  // then the first section's own lines (what the cycle did), so a report that opens with bookkeeping still says something
  const next = end < 0 ? -1 : lines.findIndex((l, i) => i > end && /^##\s/.test(l))
  const prose = [...lines.slice(start, end < 0 ? undefined : end), ...(end < 0 ? [] : lines.slice(end + 1, next < 0 ? undefined : next))].filter(l => l.trim() && !/^#/.test(l.trim()) && !/^\s*\|?[\s:|-]+\|?\s*$/.test(l) && !bookkeeping(l))
  const stated = /\b(20\d{2})-(\d{2})-(\d{2})\b/.exec(prose.join(' '))
  return { id: `report-l${f[1]}-c${Number(f[2])}`, lane: `l${f[1]}`, cycle: Number(f[2]), title, excerpt: cut(flat(prose.join(' ')) || title, LIMITS.excerpt),
    at: stated ? dated(Number(stated[1]), Number(stated[2]), Number(stated[3])) : null }
}

/**
 * buildLoopPages({ ledger, reports, year }) -> rows in lane L7's memory-row shape. reports: [{ fileName, text }].
 * A report page takes the date and "done" of the ledger line that states its lane-cycle was merged (that is the recorded event about it); without one it is a
 * report received (reported_by_other) with its own stated date or none. Links: a report follows from the previous cycle's report of its lane; a ledger line refers to
 * the reports of the lane-cycles it names; ledger lines naming the same lane-cycle are the same task.
 */
export function buildLoopPages({ ledger = '', reports = [], year = null } = {}) {
  const events = parseLedger(ledger, { year })
  const parsed = reports.map(r => parseReport(r.fileName, r.text)).filter(Boolean)
  const reportOf = new Map(parsed.map(r => [`${r.lane}-c${r.cycle}`, r]))
  const mergedBy = new Map()
  for (const e of events) for (const lc of e.merged) if (!mergedBy.has(lc)) mergedBy.set(lc, e)
  const rows = []
  for (const r of parsed) {
    const lc = `${r.lane}-c${r.cycle}`, merged = mergedBy.get(lc), prev = reportOf.get(`${r.lane}-c${r.cycle - 1}`)
    rows.push({ id: r.id, kind: 'page', title: r.title, excerpt: r.excerpt, time: { at: merged?.at ?? r.at ?? null }, status: merged ? 'done' : 'reported_by_other',
      links: [...(prev ? [{ type: 'follows_from', toAlias: prev.id }] : []), ...(merged ? [{ type: 'refers_to', toAlias: merged.id }] : [])], held: false, lane: r.lane, cycle: r.cycle, source: 'report' })
  }
  for (const e of events) {
    const refers = e.lanes.filter(lc => reportOf.has(lc)).map(lc => ({ type: 'refers_to', toAlias: reportOf.get(lc).id }))
    const same = events.filter(o => o !== e && o.lanes.some(lc => e.lanes.includes(lc))).slice(0, 4).map(o => ({ type: 'same_task', toAlias: o.id }))
    rows.push({ id: e.id, kind: 'page', title: e.title, excerpt: e.excerpt, time: { at: e.at }, status: e.status, links: [...refers, ...same], held: false, lanes: e.lanes, clock: e.clock, source: 'ledger' })
  }
  return rows
}
