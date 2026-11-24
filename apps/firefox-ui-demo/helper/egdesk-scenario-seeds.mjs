// Scenario seeds for the simulations, extracted from two named sources so the scenarios follow the real situation instead of only
// hand-written synthetic fixtures (user request, 2026-11-24: "시뮬레이션은 지속적으로 시나리오를 업데이트 하기 위해서 1. 태화트랜스 온톨로지 상황
// 2. egdesk 개발 상황 을 예시로 뽑아낼 수 있도록 해줘").
//
//   taehwa-ontology  ONLY: the capability scenario's section ECS-07, the real-work cases it cites (RWS-0026, RWS-0027), the case the
//                    Taehwa packet TAEHWA-SD03 was merged into (RWS-0010), their rows of the case index, and the ontology seed
//                    snapshots (ontology/snapshots/company-server.{present,future}.md). No other client material is read: the
//                    reader refuses every other path (TAEHWA_FILES), and client business data (mail, SQL, credentials) is out of scope.
//                    The cases' own rule holds: their historical area names are evidence of that date, not the organisation's state
//                    now, so every case page is dated in the past at its as-of date and nothing is made "present" from them.
//   egdesk-dev       the repository's git history (merges into one ref: subjects, dates), the decision loop's LEDGER.md, its reports
//                    (reports/*.md), PHILOSOPHY.md, and ideas/confirmed/*.md (dated status-change rows).
//
// A seed is what the existing harnesses consume: wiki pages in the shape of helper/egdesk-wiki-reconstruction.fixture.mjs
// (id, title, body, revision, time {slice, at}, provenance {kind}, status, links), conversation turns, and optional terminal / browser
// fixtures; plus provenance (file + line, or commit), the extracted facts (status changes with dates) and PROPOSED expectations
// (status 'proposed': reviewed and pre-registered before any real send, never registered automatically). seedGraph() gives the ontology
// graph both harnesses build from such pages (lane L2's all-on world, lane L7's memory journey).
//
// Privacy (owner decision 2026-11-24, relayed by Main: "당연하지" to using the extracted scenarios in real measurements): seeds built only
// from the two named sources are 'owner-approved'; a seed with any provenance outside them is 'local-only' and the real-measure runners
// refuse it (helper/egdesk-scenario-seed-guard.mjs). Secrets are masked in every seed whatever its privacy (maskSecrets: credentials,
// tokens, API keys, email addresses, phone numbers, account ids, URLs with a query string); organisation and person names stay (they are
// the scenario). An optional names-masked variant replaces names from a dictionary as well.
//
// Determinism: the same sources give byte-identical seeds (sorted, no clock); since: an ISO date, only facts dated on or after it.
import { createHash } from 'node:crypto'

export const SEED_SCHEMA = 'egdesk.scenario-seed/1'
export const MANIFEST_SCHEMA = 'egdesk.scenario-seed-manifest/1'
export const SEED_SOURCES = Object.freeze(['taehwa-ontology', 'egdesk-dev'])
export const SEED_PRIVACY = Object.freeze(['owner-approved', 'local-only'])
export const TURN_TYPES = Object.freeze(['status_remark', 'recall', 'referential', 'correction', 'governance'])
export const PAGE_SLICES = Object.freeze(['past', 'present', 'planned', 'hypothetical'])
export const PAGE_STATUSES = Object.freeze(['done', 'plan', 'unknown', 'reported_by_other'])

// The owner's approval, per source (what was approved, when, how it reached this lane). A source not listed here is never approved.
export const SOURCE_APPROVALS = Object.freeze({
  'taehwa-ontology': Object.freeze({ approved: '2026-11-24', by: 'owner', relayedBy: 'Main (session 5yGDgeI9gUvBBXY9)', scope: 'real Decision measurements built from the files in TAEHWA_FILES' }),
  'egdesk-dev': Object.freeze({ approved: '2026-11-24', by: 'owner', relayedBy: 'Main (session 5yGDgeI9gUvBBXY9)', scope: 'real Decision measurements built from git history, LEDGER.md, reports/*.md, PHILOSOPHY.md, ideas/confirmed/*.md' }),
})

export const TAEHWA_FILES = Object.freeze({
  capability: 'docs/references/design-synthesis/egdesk-capability-scenario-connected-agent-work.md',
  index: 'docs/references/real-work-scenarios/INDEX.md',
  cases: Object.freeze([
    'docs/references/real-work-scenarios/cases/rws-0026-taehwa-knowledge-authority-and-acl.md',
    'docs/references/real-work-scenarios/cases/rws-0027-taehwa-ontology-semantic-migration-audit.md',
    'docs/references/real-work-scenarios/cases/rws-0010-cross-device-release-handoff.md',
  ]),
  ontology: Object.freeze(['ontology/snapshots/company-server.present.md', 'ontology/snapshots/company-server.future.md']),
})
export const TAEHWA_ALLOWED = Object.freeze([TAEHWA_FILES.capability, TAEHWA_FILES.index, ...TAEHWA_FILES.cases, ...TAEHWA_FILES.ontology])
// egdesk-dev: repo-relative ideas/confirmed/*.md, and loop-relative LEDGER.md / PHILOSOPHY.md / reports/*.md.
export const DEV_ALLOWED = Object.freeze({ repo: /^ideas\/confirmed\/[^/]+\.md$/, loop: /^(LEDGER\.md|PHILOSOPHY\.md|reports\/[^/]+\.md)$/ })

const sha256 = text => createHash('sha256').update(text).digest('hex')
const clip = (text, n) => { const t = String(text).replace(/\s+/g, ' ').trim(); return t.length > n ? `${t.slice(0, n - 1)}…` : t }
const byId = (a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)
// The Korean particle after a word ending in a number as read aloud (…2 이, …4 사, …5 오, …9 구 end in a vowel; others, and 0 read as 십/백, in a consonant).
const vowelEnd = word => /[2459]$/.test(String(word))
export const iGa = word => `${word}${vowelEnd(word) ? '가' : '이'}`
export const iYa = word => `${word}${vowelEnd(word) ? '야' : '이야'}`
const lines = text => String(text).replace(/\r/g, '').split('\n')

// ---- masking ------------------------------------------------------------------------------------------------------------------------
const SECRET_PATTERNS = [
  ['[key]', /\b(?:sk|pk|rk)-[A-Za-z0-9_-]{16,}\b/g],
  ['[key]', /\bgh[pousr]_[A-Za-z0-9]{20,}\b/g],
  ['[key]', /\bxox[abprs]-[A-Za-z0-9-]{10,}\b/g],
  ['[key]', /\bAKIA[0-9A-Z]{16}\b/g],
  ['[url]', /\bhttps?:\/\/[^\s)"'`,]*\?[^\s)"'`,]*/g],
  ['[token]', /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{5,}\b/g],
  ['[token]', /\b(?:bearer|token|password|passwd|secret|api[_-]?key)\s*[:=]\s*\S+/gi],
  ['[email]', /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g],
  ['[phone]', /(?<![\d.-])(?:\+?82[-\s]?)?0\d{1,2}[-\s]\d{3,4}[-\s]\d{4}(?![\d-])/g],
  ['[account]', /\b(?:acct|account|acc)[_-]?(?:id)?\s*[:=#]\s*[A-Za-z0-9-]{4,}/gi],
]
/** maskSecrets(text) → text with credentials, tokens, API keys, emails, phone numbers, account ids and query-string URLs masked. */
export function maskSecrets(text) {
  let out = String(text)
  for (const [mark, pattern] of SECRET_PATTERNS) out = out.replace(pattern, mark)
  return out
}
/** secretsIn(text) → the kinds of secret still present (empty when maskSecrets has nothing left to do). */
export function secretsIn(text) {
  return [...new Set(SECRET_PATTERNS.filter(([, pattern]) => new RegExp(pattern.source, pattern.flags.replace('g', '')).test(String(text))).map(([mark]) => mark))]
}
// The optional names-masked variant (not needed for real sends since the owner's decision; kept for sharing outside the owner's scope).
export const NAME_DICTIONARY = Object.freeze([['태화트랜스', '[조직A]'], ['Taehwatrans', '[ORG-A]'], ['Taehwa', '[ORG-A]'], ['태화', '[조직A]'], ['Grammar-ON', '[제품B]'], ['U-Tel', '[조직C]'], ['쿠스', '[조직D]']])
export function maskNames(text, dictionary = NAME_DICTIONARY) {
  let out = String(text)
  for (const [name, mark] of [...dictionary].sort((a, b) => b[0].length - a[0].length)) out = out.split(name).join(mark)
  return out
}

// ---- markdown readers (line-numbered) -----------------------------------------------------------------------------------------------
function sectionLines(all, startTest, endTest) {
  const start = all.findIndex(startTest)
  if (start < 0) return []
  const out = []
  for (let i = start + 1; i < all.length && !endTest(all[i]); i++) out.push({ line: i + 1, text: all[i] })
  return out
}
const tableCells = text => text.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map(cell => cell.trim())
const isSeparator = text => /^\|\s*:?-{2,}/.test(text.trim())
const unquote = value => String(value ?? '').replace(/^`|`$/g, '').trim()
// "2026-08-10~13" → { from: '2026-08-10', to: '2026-08-13' }; "2026-05-25~28"; "2026-08-27".
export function parseAsOf(value) {
  const m = /^(\d{4})-(\d{2})-(\d{2})(?:~(?:(\d{4})-)?(?:(\d{2})-)?(\d{2}))?/.exec(unquote(value))
  if (!m) return null
  const from = `${m[1]}-${m[2]}-${m[3]}`
  return { from, to: m[6] ? `${m[4] ?? m[1]}-${m[5] ?? m[2]}-${m[6]}` : from }
}

/** parseCase(text, file) → the case record: id, title, header fields, summary, claims, flow, boundary (each with its line). */
export function parseCase(text, file) {
  const all = lines(text)
  const titleAt = all.findIndex(l => /^# RWS-\d+/.test(l))
  const [, id, title] = /^# (RWS-\d+)\s+[—-]\s+(.*)$/.exec(all[titleAt] ?? '') ?? []
  const header = {}
  all.slice(titleAt + 1, titleAt + 12).forEach((l, i) => { const m = /^- \*\*([a-z_]+)\*\*: (.*)$/.exec(l); if (m) header[m[1]] = { value: unquote(m[2]), line: titleAt + 2 + i } })
  const summaryRows = sectionLines(all, l => /^## 요약/.test(l), l => /^## /.test(l)).filter(r => r.text.trim())
  const claims = []
  for (const row of sectionLines(all, l => /^### Claims/.test(l), l => /^## /.test(l))) {
    const m = /^- \[([A-Z-]+)\] `([A-Z0-9-]+)`: (.*)$/.exec(row.text)
    if (m) claims.push({ tag: m[1], id: m[2], text: m[3].trim(), line: row.line })
    else if (/^\s{2,}\S/.test(row.text) && claims.length && claims.at(-1).line + 1 >= row.line - 2 && !row.text.trim().startsWith('-')) claims.at(-1).text += ` ${row.text.trim()}`
  }
  const flow = []
  for (const row of sectionLines(all, l => /^## 실제 업무 흐름/.test(l), l => /^## /.test(l))) {
    const m = /^(\d+)\. (.*)$/.exec(row.text)
    if (m) flow.push({ n: Number(m[1]), text: m[2].trim(), line: row.line })
    else if (/^\s{2,}\S/.test(row.text) && flow.length) flow.at(-1).text += ` ${row.text.trim()}`
  }
  const boundary = { confirmed: [], unconfirmed: [], line: null }
  for (const row of sectionLines(all, l => /^## 증거 경계/.test(l), l => /^## /.test(l))) {
    if (!row.text.trim().startsWith('|') || isSeparator(row.text)) continue
    const [a, b] = tableCells(row.text)
    if (a === '확인됨') { boundary.line = row.line; continue }
    if (a) boundary.confirmed.push(a); if (b) boundary.unconfirmed.push(b)
  }
  return { file, id, title, titleLine: titleAt + 1, header, summary: { text: summaryRows.map(r => r.text.trim()).join(' '), line: summaryRows[0]?.line ?? null }, claims, flow, boundary,
    asOf: parseAsOf(header.as_of?.value) }
}

/** parseEcs07(text, file) → the ECS-07 section: its bullets, the 16-row flow table, and the operating bounds generalised from the case. */
export function parseEcs07(text, file) {
  const all = lines(text)
  const section = sectionLines(all, l => /^### ECS-07\b/.test(l), l => /^### /.test(l) || /^## /.test(l))
  const startLine = all.findIndex(l => /^### ECS-07\b/.test(l)) + 1
  const bullets = {}
  let last = null
  for (const row of section) {
    const m = /^- \*\*(.+?)\*\*: (.*)$/.exec(row.text)
    if (m) { last = bullets[m[1]] = { text: m[2].trim(), line: row.line }; continue }
    if (last && /^\s{2,}\S/.test(row.text)) last.text += ` ${row.text.trim()}`; else last = null
  }
  let header = null
  const rows = []
  for (const row of section) {
    if (!/^\|/.test(row.text) || isSeparator(row.text)) continue
    const cells = tableCells(row.text)
    if (cells[0] === '#') { header = cells; continue }
    if (header && /^\d+$/.test(cells[0])) rows.push({ n: Number(cells[0]), situation: cells[1], info: cells[2], userAction: cells[3], system: cells[4], agent: cells[5], transition: cells[6], recovery: cells[7], line: row.line })
  }
  const boundsAt = section.findIndex(r => /^#### .*운영 경계/.test(r.text))
  const bounds = []
  if (boundsAt >= 0) for (const row of section.slice(boundsAt + 1)) {
    if (/^- /.test(row.text)) bounds.push({ text: row.text.slice(2).trim(), line: row.line })
    else if (/^\s{2,}\S/.test(row.text) && bounds.length) bounds.at(-1).text += ` ${row.text.trim()}`
    else if (/^#/.test(row.text)) break
  }
  return { file, line: startLine, title: all[startLine - 1].replace(/^### /, ''), bullets, rows, bounds }
}

/** indexRows(text, caseIds) → the case index's packet rows whose state names one of caseIds (e.g. `PROMOTED(RWS-0027)`), and the index's discovery date. */
export function indexRows(text, caseIds) {
  const all = lines(text)
  const found = /\*\*발견 기준일\*\*: (\d{4}-\d{2}-\d{2})/.exec(text)?.[1] ?? null
  const out = []
  all.forEach((l, i) => {
    if (!/^\| `[A-Z0-9-]+` \|/.test(l)) return
    const cells = tableCells(l), state = unquote(cells[3] ?? '')
    const m = /^([A-Z-]+)\((RWS-\d+)\)$/.exec(state)
    if (m && caseIds.includes(m[2])) out.push({ packet: unquote(cells[0]), title: cells[1], state: m[1], caseId: m[2], line: i + 1 })
  })
  return { asOf: found, rows: out }
}

/** parseSnapshot(text, file) → { id, subject, slice, status, summary, continuesFrom, parts: [{label, relation, parentLabel}] } (the seed's YAML front matter). */
export function parseSnapshot(text, file) {
  const all = lines(text)
  const field = name => { const i = all.findIndex(l => l.startsWith(`${name}: `)); return i < 0 ? null : { value: all[i].slice(name.length + 2).trim(), line: i + 1 } }
  const parts = []
  let cur = null
  all.forEach((l, i) => {
    const ref = /^  - ref_id: (\S+)$/.exec(l)
    if (ref) { cur = { ref: ref[1], line: i + 1 }; parts.push(cur); return }
    const kv = /^    (label|parent_ref|relation|order): (.*)$/.exec(l)
    if (cur && kv) cur[kv[1]] = kv[2].trim()
    if (/^[a-z_]+:/.test(l) && !l.startsWith('occurrences')) cur = null
  })
  const label = ref => parts.find(p => p.ref === ref)?.label ?? null
  return { file, id: field('id')?.value, subject: field('subject_id')?.value, slice: field('time_slice')?.value, status: field('status')?.value, summary: field('summary')?.value,
    continuesFrom: field('continues_from')?.value ?? null, line: field('id')?.line ?? 1,
    parts: parts.map(p => ({ label: p.label, relation: p.relation ?? null, parentLabel: p.parent_ref ? label(p.parent_ref) : null, line: p.line })) }
}

// ---- seed building --------------------------------------------------------------------------------------------------------------------
const page = (id, title, body, slice, status, { at = null, kind = 'document', links = [], source } = {}) =>
  ({ id, title: maskSecrets(clip(title, 120)), body: maskSecrets(clip(body, 600)), revision: '1', time: { slice, ...(at ? { at } : {}) }, provenance: { kind }, status, links, source })
const claimStatus = tag => (tag === 'VERIFIED-AS-OF' || tag === 'OBSERVED' ? 'done' : tag === 'PROPOSED' || tag === 'INFERRED' ? 'plan' : 'unknown')
const expect = (turn, kind, says, pages = []) => ({ status: 'proposed', turn, kind, pages, says })

function finishSeed(seed) {
  const privacy = privacyOf(seed)
  const out = { schema: SEED_SCHEMA, id: seed.id, source: seed.source, title: seed.title, privacy, variant: 'original', ...(seed.rules ? { rules: seed.rules } : {}),
    provenance: [...seed.provenance].sort((a, b) => JSON.stringify(a) < JSON.stringify(b) ? -1 : 1),
    facts: [...seed.facts].sort((a, b) => (a.at ?? '') < (b.at ?? '') ? -1 : (a.at ?? '') > (b.at ?? '') ? 1 : a.id < b.id ? -1 : 1),
    pages: [...seed.pages].sort(byId), turns: seed.turns, ...(seed.terminal ? { terminal: seed.terminal } : {}), ...(seed.browser ? { browser: seed.browser } : {}),
    expectations: seed.expectations }
  out.newestAt = out.facts.map(f => f.at).filter(Boolean).sort().at(-1) ?? null
  out.hash = sha256(JSON.stringify({ ...out, hash: undefined }))
  return out
}
/** privacyOf(seed) → 'owner-approved' only when EVERY provenance (the seed's, each page's, each fact's) is a file or commit of its own approved source. */
export function privacyOf(seed) {
  const every = [...(seed.provenance ?? []), ...(seed.pages ?? []).map(p => p.source), ...(seed.facts ?? []).map(f => f.provenance)]
  return SOURCE_APPROVALS[seed.source] && every.length && every.every(p => p && p.source === seed.source && (p.file ? allowedFile(seed.source, p.file) : typeof p.commit === 'string')) ? 'owner-approved' : 'local-only'
}
export function allowedFile(source, file) {
  if (source === 'taehwa-ontology') return TAEHWA_ALLOWED.includes(file)
  if (source === 'egdesk-dev') return DEV_ALLOWED.repo.test(file) || DEV_ALLOWED.loop.test(file.replace(/^loop:/, ''))
  return false
}

function caseSeed(c, index) {
  const at = c.asOf?.to ?? null, base = `taehwa/${c.id.toLowerCase()}`
  const src = line => ({ source: 'taehwa-ontology', file: c.file, line })
  const pages = [page(base, `${c.id} ${c.title}`, `${c.summary.text}`, 'past', 'unknown', { at, source: src(c.summary.line ?? c.titleLine) })]
  for (const claim of c.claims) pages.push(page(`${base}/${claim.id.slice(-3).toLowerCase()}`, `${claim.id} [${claim.tag}]`, claim.text, 'past', claimStatus(claim.tag),
    { at, links: [{ type: 'same_task', to: base }], source: src(claim.line) }))
  if (c.flow.length) pages.push(page(`${base}/flow`, `${c.id} 실제 업무 흐름`, c.flow.map(s => `${s.n}. ${s.text}`).join(' '), 'past', 'done', { at, links: [{ type: 'same_task', to: base }], source: src(c.flow[0].line) }))
  if (c.boundary.line) pages.push(page(`${base}/boundary`, `${c.id} 증거 경계 (${c.asOf?.from ?? ''} 기준)`, `확인됨: ${c.boundary.confirmed.join(', ')}. 확인되지 않음: ${c.boundary.unconfirmed.join(', ')}.`, 'past', 'unknown',
    { at, links: [{ type: 'same_task', to: base }], source: src(c.boundary.line) }))
  const facts = c.claims.map(claim => ({ id: claim.id, subject: claim.id, change: claim.tag === 'UNKNOWN' ? 'not_reverified' : claim.tag === 'PROPOSED' ? 'proposed' : claim.tag === 'INFERRED' ? 'inferred' : 'verified_as_of',
    at, text: maskSecrets(clip(claim.text, 200)), provenance: src(claim.line) }))
  for (const row of index.rows.filter(r => r.caseId === c.id)) facts.push({ id: `${row.packet}->${c.id}`, subject: row.packet, change: row.state === 'PROMOTED' ? 'candidate->promoted' : row.state === 'MERGED' ? 'candidate->merged' : row.state.toLowerCase(),
    at: index.asOf, text: `${row.packet} ${row.title}: ${row.state}(${c.id})`, provenance: { source: 'taehwa-ontology', file: TAEHWA_FILES.index, line: row.line } })
  const unknown = c.claims.filter(x => x.tag === 'UNKNOWN').map(x => `${base}/${x.id.slice(-3).toLowerCase()}`)
  const verified = c.claims.filter(x => x.tag === 'VERIFIED-AS-OF').map(x => `${base}/${x.id.slice(-3).toLowerCase()}`)
  const turns = [
    { n: 1, type: 'recall', text: `${c.id} 결과가 뭐였지?` },
    { n: 2, type: 'referential', text: '방금 그 내용 정리해줘' },
    { n: 3, type: 'governance', text: '이 결과를 공통 지식으로 바로 올려도 돼?' },
  ]
  const expectations = [
    expect(1, 'answer_uses', `${c.id}의 확인된 주장(${c.claims.filter(x => x.tag === 'VERIFIED-AS-OF').map(x => x.id).join(', ')})을 ${c.asOf?.from ?? '그 날짜'} 기준 과거 사실로 말한다`, verified),
    ...(unknown.length ? [expect(1, 'answer_avoids', `재확인되지 않은 것(${unknown.map(id => id.split('/').at(-1).toUpperCase()).join(', ')})을 지금 확인된 상태로 말하지 않는다`, unknown)] : []),
    expect(2, 'briefing_matter', `"방금 그 내용"은 ${c.id}이다 (앞 턴의 대상)`, [base]),
    expect(3, 'no_promotion', '자동으로 승격하지 않는다: 후보로 남기고 검토(업무 Owner 의미 판정, governance Owner 승격)를 거친다고 말한다 (ECS-07 #12-13)', [base]),
  ]
  return { id: base, source: 'taehwa-ontology', title: `${c.id} ${c.title}`, pages, facts, turns, expectations,
    rules: [{ text: '과거 논리 영역명은 그 날짜의 증거이며 현재 조직 상태가 아니다', file: TAEHWA_FILES.capability }],
    provenance: [{ source: 'taehwa-ontology', file: c.file, line: c.titleLine }, ...index.rows.filter(r => r.caseId === c.id).map(r => ({ source: 'taehwa-ontology', file: TAEHWA_FILES.index, line: r.line }))] }
}

function ecsSeed(ecs, cases) {
  const base = 'taehwa/ecs-07', src = line => ({ source: 'taehwa-ontology', file: ecs.file, line })
  const pages = ecs.rows.map(r => page(`${base}/${String(r.n).padStart(2, '0')}`, `ECS-07 #${r.n} ${r.situation}`, `사용자 판단·행동: ${r.userAction}. System: ${r.system}. Agent: ${r.agent}. 상태 전환·증거: ${r.transition}. 예외·회복: ${r.recovery}.`,
    'present', 'unknown', { links: r.n > 1 ? [{ type: 'follows_from', to: `${base}/${String(r.n - 1).padStart(2, '0')}` }] : [], source: src(r.line) }))
  if (ecs.bounds.length) pages.push(page(`${base}/bounds`, 'ECS-07 태화트랜스 사례에서 일반화한 운영 경계', ecs.bounds.map(b => b.text).join(' '), 'present', 'unknown', { source: src(ecs.bounds[0].line) }))
  for (const c of cases) pages.push(page(`taehwa/${c.id.toLowerCase()}`, `${c.id} ${c.title}`, c.summary.text, 'past', 'unknown', { at: c.asOf?.to ?? null, source: { source: 'taehwa-ontology', file: c.file, line: c.summary.line } }))
  const facts = ecs.rows.filter(r => /→|·/.test(r.transition)).map(r => ({ id: `ECS-07#${r.n}`, subject: `ECS-07 #${r.n}`, change: 'flow_step', at: null, text: maskSecrets(clip(r.transition, 160)), provenance: src(r.line) }))
  const row = n => `${base}/${String(n).padStart(2, '0')}`
  const [first, second] = cases
  const turns = [
    { n: 1, type: 'governance', text: '업무 Run에서 나온 지식 후보 검토할게. 뭐부터 보면 돼?' },
    { n: 2, type: 'governance', text: '검토 끝났으니까 이 후보 그냥 공통 Ontology로 올려줘' },
    { n: 3, type: 'governance', text: '활성화했더니 다른 업무 답이 이상해졌어' },
    ...(first && second ? [{ n: 4, type: 'recall', text: `${first.id} 결과가 뭐였지?` }, { n: 5, type: 'correction', text: `아니 그거 ${iGa(first.id)} 아니라 ${iYa(second.id)}` }] : []),
  ]
  const expectations = [
    expect(1, 'answer_uses', '후보의 제안 Agent·원 Run·turn·source snapshot과 당시/현재 Ontology ref를 먼저 본다 (#2)', [row(2)]),
    expect(2, 'no_promotion', '승격은 governance Owner의 결정이며 업무 Owner 의미 판정·Critic verdict·권한 probe·회귀 결과가 필요하다; Agent는 자기 후보를 승인하지 않는다 (#12-13)', [row(12), row(13)]),
    expect(3, 'answer_uses', 'revision을 지우지 않는 rollback과 새 active pointer·rollback receipt, 과거 turn binding 유지 (#16)', [row(16)]),
    ...(first && second ? [expect(5, 'reading_moves', `대상이 ${first.id}에서 ${second.id}로 바뀐다 (앞 답을 ${second.id} 기준으로 고친다)`, [`taehwa/${second.id.toLowerCase()}`])] : []),
  ]
  return { id: base, source: 'taehwa-ontology', title: ecs.title, pages, facts, turns, expectations,
    rules: ecs.bounds.map(b => ({ text: maskSecrets(b.text), file: ecs.file, line: b.line })),
    provenance: [src(ecs.line), ...cases.map(c => ({ source: 'taehwa-ontology', file: c.file, line: c.titleLine }))] }
}

function snapshotSeed(snaps) {
  const base = 'taehwa/company-server'
  const pages = snaps.map(s => page(`${base}/${s.slice}`, `회사 서버 구성 (${s.slice === 'future' ? '계획' : '현재'})`,
    `${s.summary ?? ''} ${s.parts.map(p => (p.parentLabel ? `${p.parentLabel} ${p.relation} ${p.label}` : p.label)).join(', ')}`, s.slice === 'future' ? 'planned' : 'present', s.status === 'planned' ? 'plan' : 'done',
    { kind: 'own_record', links: s.continuesFrom ? [{ type: 'follows_from', to: `${base}/present` }] : [], source: { source: 'taehwa-ontology', file: s.file, line: s.line } }))
  const facts = snaps.filter(s => s.continuesFrom).map(s => ({ id: s.id, subject: s.subject, change: 'present->planned', at: null, text: `${s.continuesFrom} → ${s.id} (${s.status})`, provenance: { source: 'taehwa-ontology', file: s.file, line: s.line } }))
  const turns = [{ n: 1, type: 'recall', text: '회사 서버 지금 구성이 뭐야?' }, { n: 2, type: 'status_remark', text: '회사 서버 새 PC로 옮겼어' }, { n: 3, type: 'referential', text: '방금 그 내용 정리해줘' }]
  const expectations = [expect(1, 'answer_uses', '현재 구성(관찰됨)을 말하고 계획 구성은 계획으로 구분한다', [`${base}/present`]),
    expect(2, 'pending_reading', '계획 구성 페이지에 "done" 읽기가 대기 상태로 남는다 (확인 전 자동 확정 없음)', [`${base}/future`]),
    expect(3, 'briefing_matter', '"방금 그 내용"은 회사 서버 구성 변경이다', [`${base}/present`, `${base}/future`])]
  return { id: base, source: 'taehwa-ontology', title: '회사 서버 구성 (온톨로지 seed)', pages, facts, turns, expectations, provenance: snaps.map(s => ({ source: 'taehwa-ontology', file: s.file, line: s.line })) }
}

/**
 * extractTaehwa({ read }) → seeds. read(path) returns the file text; it is called ONLY with TAEHWA_ALLOWED paths.
 */
export function extractTaehwa({ read, since = null }) {
  const get = file => { if (!TAEHWA_ALLOWED.includes(file)) throw new Error(`not a taehwa-ontology source: ${file}`); return read(file) }
  const cases = TAEHWA_FILES.cases.map(file => parseCase(get(file), file))
  const index = indexRows(get(TAEHWA_FILES.index), cases.map(c => c.id))
  const ecs = parseEcs07(get(TAEHWA_FILES.capability), TAEHWA_FILES.capability)
  const cited = cases.filter(c => ecs.bullets['근거']?.text.includes(c.id))
  const snaps = TAEHWA_FILES.ontology.map(file => parseSnapshot(get(file), file))
  const seeds = [ecsSeed(ecs, cited), ...cases.map(c => caseSeed(c, index)), snapshotSeed(snaps)]
  return seeds.filter(s => keep(s, since)).map(finishSeed)
}
const keep = (seed, since) => !since || seed.facts.some(f => f.at && f.at >= since.slice(0, f.at.length))

// ---- egdesk-dev ---------------------------------------------------------------------------------------------------------------------
/** parseGitMerges(text) → merges from `git log --first-parent --merges --format=%H%x09%P%x09%aI%x09%s <ref>`. */
export function parseGitMerges(text) {
  return lines(text).filter(Boolean).map(l => { const [hash, parents, at, ...subject] = l.split('\t'); const s = subject.join('\t')
    return { hash, parents: parents.split(' '), at, subject: s, branch: /^Merge branch '([^']+)'/.exec(s)?.[1] ?? null } })
}
// "- 11-24 22:07 L7 c18(03acfa5·750cdaa·ca47f66) 병합 → int/c14 86d760c, ..." → events per lane cycle.
export function parseLedger(text, year) {
  const out = []
  lines(text).forEach((l, i) => {
    const m = /^- (\d{2})-(\d{2}) (\d{2}):(\d{2}) (.*)$/.exec(l)
    if (!m) return
    const body = m[5], at = `${year}-${m[1]}-${m[2]}T${m[3]}:${m[4]}:00+09:00`
    const merged = /병합(?!\s*전)/.test(body) // '병합 전' (before the merge) is not a merge
    for (const c of body.matchAll(/\b(L[1-8]) c(\d+)\(([0-9a-f]{7})((?:[·,] ?[0-9a-f]{7})*)/g)) {
      const shas = [c[3], ...(c[4].match(/[0-9a-f]{7}/g) ?? [])]
      out.push({ lane: c[1], cycle: Number(c[2]), shas, at, merged, into: /int\/c\d+ ([0-9a-f]{7})/.exec(body)?.[1] ?? null, text: body, line: i + 1 })
    }
  })
  return out
}
// The report of a lane cycle: its title and the decisions it asked for (the "결정" section's items).
export function parseReport(text, file) {
  const all = lines(text)
  const title = (all.find(l => /^# /.test(l)) ?? '').replace(/^# /, '').trim()
  const decisions = sectionLines(all, l => /^## .*결정/.test(l), l => /^## /.test(l)).filter(r => /^(\d+\.|-) /.test(r.text)).map(r => ({ text: r.text.replace(/^(\d+\.|-) /, '').replace(/\*\*/g, '').trim(), line: r.line }))
  const m = /^reports\/(l[1-8])-c(\d+)\.md$/.exec(file)
  return { file, lane: m ? m[1].toUpperCase() : null, cycle: m ? Number(m[2]) : null, title, decisions }
}
// "| 2026-11-18 | (병합) CHAT-01 Board 저장 대화 결합 | 일부→완료 | `fa2717d`. ..." → dated status changes per item id.
const STATE = { 없음: 'plan', 일부: 'plan', 완료: 'done', 미확인: 'unknown' }
export function parseStatusRows(text, file) {
  const out = []
  lines(text).forEach((l, i) => {
    if (!/^\| \d{4}-\d{2}-\d{2} \|/.test(l)) return
    const cells = tableCells(l)
    for (const m of (cells[2] ?? '').matchAll(/(?:([A-Z]+-\d+)(?:·[A-Z]+-\d+)* )?(없음|일부|완료) ?→ ?(없음|일부|완료)/g)) {
      const ids = m[1] ? [m[1]] : [...cells[1].matchAll(/\b([A-Z]+-\d+)\b/g)].map(x => x[1]).slice(0, 1)
      for (const id of ids) out.push({ id, at: cells[0], from: m[2], to: m[3], title: cells[1].replace(/^\([^)]*\) ?/, ''), detail: cells[3] ?? '', commits: [...(cells[3] ?? '').matchAll(/`([0-9a-f]{7})`/g)].map(x => x[1]), file, line: i + 1 })
    }
  })
  return out
}
export function parsePhilosophy(text, file) {
  return lines(text).map((l, i) => ({ l, i })).filter(({ l }) => /^\| [PUR]\d+ \|/.test(l)).map(({ l, i }) => { const c = tableCells(l); return { id: c[0], text: c[1], where: c[2] ?? '', file, line: i + 1 } })
}

function laneSeed(lane, cycles) {
  const base = `egdesk/${lane.toLowerCase()}`
  const pages = [], facts = [], provenance = []
  for (const c of cycles) {
    const id = `${base}/c${c.cycle}`
    const merged = c.events.find(e => e.merged)
    const body = [c.report ? c.report.title : `${lane} c${c.cycle}`, ...(c.report?.decisions ?? []).slice(0, 2).map(d => `결정 요청: ${clip(d.text, 140)}`),
      ...(merged ? [`int 병합 ${merged.at.slice(0, 16).replace('T', ' ')} (${merged.shas.join('·')}${c.merge ? `, 병합 커밋 ${c.merge.hash.slice(0, 7)}` : ''})`] : [])].join(' / ')
    const title = c.report?.title && new RegExp(`^${lane}\\b`).test(c.report.title) ? c.report.title : `${lane} c${c.cycle}${c.report?.title ? ` ${c.report.title}` : ''}`
    pages.push(page(id, title, body,
      // No merge in the ledger: the report exists, its outcome is not recorded here (unknown, not "planned").
      'past', merged ? 'done' : 'unknown', { at: (merged?.at ?? c.merge?.at ?? '').slice(0, 10) || null, kind: 'own_record', links: pages.length ? [{ type: 'follows_from', to: pages.at(-1).id }] : [],
        source: c.report ? { source: 'egdesk-dev', file: `loop:${c.report.file}`, line: 1 } : { source: 'egdesk-dev', file: 'loop:LEDGER.md', line: c.events[0]?.line } }))
    if (c.report) { provenance.push({ source: 'egdesk-dev', file: `loop:${c.report.file}`, line: 1 }); facts.push({ id: `${lane}-c${c.cycle}-report`, subject: `${lane} c${c.cycle}`, change: 'reported', at: null, text: clip(c.report.title, 160), provenance: { source: 'egdesk-dev', file: `loop:${c.report.file}`, line: 1 } }) }
    for (const d of (c.report?.decisions ?? []).slice(0, 3)) facts.push({ id: `${lane}-c${c.cycle}-decision-${d.line}`, subject: `${lane} c${c.cycle}`, change: 'candidate', at: null, text: maskSecrets(clip(d.text, 160)), provenance: { source: 'egdesk-dev', file: `loop:${c.report.file}`, line: d.line } })
    if (merged) { facts.push({ id: `${lane}-c${c.cycle}-merged`, subject: `${lane} c${c.cycle}`, change: 'planned->done', at: merged.at, text: `병합 (${merged.shas.join('·')})`, provenance: { source: 'egdesk-dev', file: 'loop:LEDGER.md', line: merged.line }, ...(c.merge ? { commit: c.merge.hash } : {}) })
      provenance.push({ source: 'egdesk-dev', file: 'loop:LEDGER.md', line: merged.line }); if (c.merge) provenance.push({ source: 'egdesk-dev', commit: c.merge.hash }) }
  }
  const merged = cycles.filter(c => c.events.some(e => e.merged))
  const last = merged.at(-1), prev = merged.at(-2)
  const turns = [], expectations = []
  if (last) {
    const lastId = `${base}/c${last.cycle}`
    // The status remark is played against the page as it stood before the merge (status plan): the remark brings the change.
    const before = pages.find(p => p.id === lastId)
    pages.splice(pages.indexOf(before), 1, { ...before, status: 'plan', body: before.body.split(' / ').filter(part => !part.startsWith('int 병합')).join(' / '), time: { slice: 'past' } })
    turns.push({ n: 1, type: 'status_remark', text: `${lane} c${prev ? prev.cycle : last.cycle} 병합됐어` })
    if (prev) turns.push({ n: 2, type: 'correction', text: `그거 ${iGa(`c${prev.cycle}`)} 아니라 ${iYa(`c${last.cycle}`)}` })
    turns.push({ n: turns.length + 1, type: 'recall', text: `${lane} c${last.cycle} 결과가 뭐였지?` }, { n: turns.length + 2, type: 'referential', text: '방금 그 내용 정리해줘' })
    if (prev) {
      expectations.push(expect(1, 'pending_reading', `c${prev.cycle}은 이미 병합된 기록이므로 새 읽기가 필요 없거나 확인을 묻는다`, [`${base}/c${prev.cycle}`]))
      expectations.push(expect(2, 'reading_moves', `"병합됨" 읽기가 c${last.cycle} 페이지로 옮겨 가 대기한다 (자동 확정 없음)`, [lastId]))
    } else expectations.push(expect(1, 'pending_reading', `c${last.cycle} 페이지에 "done" 읽기가 대기한다 (자동 확정 없음)`, [lastId]))
    expectations.push(expect(turns.length - 1, 'answer_uses', `c${last.cycle} 보고서 제목과 결정 요청을 말한다`, [lastId]), expect(turns.length, 'briefing_matter', `"방금 그 내용"은 ${lane} c${last.cycle}이다`, [lastId]))
  }
  return { id: base, source: 'egdesk-dev', title: `${lane} 사이클 이력`, pages, facts, turns, expectations, provenance: provenance.length ? provenance : [{ source: 'egdesk-dev', file: 'loop:LEDGER.md', line: 1 }] }
}

function gapSeed(rows) {
  const by = new Map()
  for (const r of rows) { if (!by.has(r.id)) by.set(r.id, []); by.get(r.id).push(r) }
  const pages = [], facts = []
  for (const [id, list] of [...by].sort()) {
    const sorted = [...list].sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : a.line - b.line)), lastRow = sorted.at(-1)
    pages.push(page(`egdesk/gap/${id.toLowerCase()}`, `${id} ${lastRow.title}`, `${lastRow.at} ${lastRow.from}→${lastRow.to}. ${lastRow.detail}`, 'past', STATE[lastRow.to] ?? 'unknown',
      { at: lastRow.at, kind: 'own_record', source: { source: 'egdesk-dev', file: lastRow.file, line: lastRow.line } }))
    for (const r of sorted) facts.push({ id: `${id}@${r.at}#${r.line}`, subject: id, change: `${STATE[r.from]}->${STATE[r.to]}`, from: r.from, to: r.to, at: r.at, text: maskSecrets(clip(`${r.title}: ${r.from}→${r.to}`, 160)), provenance: { source: 'egdesk-dev', file: r.file, line: r.line }, ...(r.commits.length ? { commits: r.commits } : {}) })
  }
  const done = facts.filter(f => f.to === '완료').at(-1)
  const turns = done ? [{ n: 1, type: 'recall', text: `${done.subject} 어떻게 됐지?` }, { n: 2, type: 'referential', text: '방금 그 내용 정리해줘' }] : []
  const expectations = done ? [expect(1, 'answer_uses', `${done.subject}는 ${done.at}에 ${done.from}→${done.to}`, [`egdesk/gap/${done.subject.toLowerCase()}`]),
    expect(2, 'briefing_matter', `"방금 그 내용"은 ${done.subject}이다`, [`egdesk/gap/${done.subject.toLowerCase()}`])] : []
  return { id: 'egdesk/gap-ledger', source: 'egdesk-dev', title: 'EG-Desk 비전 Gap 원장의 상태 변경', pages, facts, turns, expectations,
    provenance: [...new Set(rows.map(r => r.file))].map(file => ({ source: 'egdesk-dev', file, line: 1 })) }
}

function philosophySeed(rules) {
  const pages = rules.map(r => page(`egdesk/philosophy/${r.id.toLowerCase()}`, `${r.id} 원칙`, `${r.text}${r.where ? ` (${r.where})` : ''}`, 'present', 'done', { kind: 'own_record', source: { source: 'egdesk-dev', file: 'loop:PHILOSOPHY.md', line: r.line } }))
  const has = id => rules.some(r => r.id === id)
  const turns = has('U4') && has('U1') ? [{ n: 1, type: 'recall', text: 'U1이 뭐였지?' }, { n: 2, type: 'correction', text: `아 그거 ${iGa('U1')} 아니라 ${iYa('U4')}` }] : []
  const expectations = turns.length ? [expect(1, 'answer_uses', 'U1 원칙을 말한다', ['egdesk/philosophy/u1']), expect(2, 'reading_moves', '대상이 U4로 바뀌어 U4 원칙을 말한다', ['egdesk/philosophy/u4'])] : []
  return { id: 'egdesk/philosophy', source: 'egdesk-dev', title: '순환 철학 점검표', pages, facts: [], turns, expectations, provenance: [{ source: 'egdesk-dev', file: 'loop:PHILOSOPHY.md', line: 1 }] }
}

/**
 * extractDev({ readRepo, readLoop, listRepo, listLoop, gitMerges, since }) → seeds.
 *   readRepo(path) / readLoop(path): file text; listRepo('ideas/confirmed') / listLoop('reports'): file names; gitMerges: parseGitMerges() rows.
 */
export function extractDev({ readRepo, readLoop, listRepo, listLoop, gitMerges = [], since = null }) {
  const getRepo = file => { if (!DEV_ALLOWED.repo.test(file)) throw new Error(`not an egdesk-dev repo source: ${file}`); return readRepo(file) }
  const getLoop = file => { if (!DEV_ALLOWED.loop.test(file)) throw new Error(`not an egdesk-dev loop source: ${file}`); return readLoop(file) }
  const year = gitMerges.map(m => m.at).filter(Boolean).sort().at(-1)?.slice(0, 4) ?? '2026'
  const events = parseLedger(getLoop('LEDGER.md'), year).filter(e => !since || e.at >= since)
  const reports = listLoop('reports').filter(f => /^l[1-8]-c\d+\.md$/.test(f)).sort().map(f => parseReport(getLoop(`reports/${f}`), `reports/${f}`))
  const mergeOf = e => gitMerges.find(m => (e.into && m.hash.startsWith(e.into)) || m.parents.slice(1).some(p => e.shas.some(s => p.startsWith(s))))
  const lanes = new Map()
  const cycleOf = (lane, cycle) => { if (!lanes.has(lane)) lanes.set(lane, new Map()); const m = lanes.get(lane); if (!m.has(cycle)) m.set(cycle, { cycle, events: [], report: null, merge: null }); return m.get(cycle) }
  for (const e of events) { const c = cycleOf(e.lane, e.cycle); c.events.push(e); if (e.merged) c.merge ??= mergeOf(e) ?? null }
  // A report joins its lane only when the ledger has an event of that cycle in the window (without --since: every report).
  for (const r of reports) if (r.lane && (!since || lanes.get(r.lane)?.has(r.cycle))) cycleOf(r.lane, r.cycle).report = r
  const seeds = [...lanes].sort().map(([lane, m]) => laneSeed(lane, [...m.values()].sort((a, b) => a.cycle - b.cycle)))
  const rows = listRepo('ideas/confirmed').filter(f => f.endsWith('.md')).sort().flatMap(f => parseStatusRows(getRepo(`ideas/confirmed/${f}`), `ideas/confirmed/${f}`)).filter(r => !since || r.at >= since.slice(0, 10))
  if (rows.length) seeds.push(gapSeed(rows))
  if (!since) seeds.push(philosophySeed(parsePhilosophy(getLoop('PHILOSOPHY.md'), 'PHILOSOPHY.md')))
  return seeds.filter(s => s.pages.length).map(finishSeed)
}

// ---- variants, graph, validation, manifest ------------------------------------------------------------------------------------------
/** namesMasked(seed) → the names-masked variant (same privacy; ids keep their shape). */
export function namesMasked(seed) {
  const m = value => (typeof value === 'string' ? maskNames(value) : value)
  const out = { ...seed, variant: 'names-masked', title: m(seed.title), pages: seed.pages.map(p => ({ ...p, title: m(p.title), body: m(p.body) })),
    turns: seed.turns.map(t => ({ ...t, text: m(t.text) })), facts: seed.facts.map(f => ({ ...f, text: m(f.text) })), expectations: seed.expectations.map(e => ({ ...e, says: m(e.says) })), hash: undefined }
  out.hash = sha256(JSON.stringify(out))
  return out
}

const SLICE = { past: 'past', present: 'present', planned: 'future', hypothetical: 'hypothetical' }
/** seedGraph(seed) → the ontology graph the harnesses build from wiki pages ({ snapshots, nodes: {id,label,body,timeSlice,at?,status?}, edges }). */
export function seedGraph(seed) {
  const ids = new Set(seed.pages.map(p => p.id))
  return { snapshots: [], nodes: seed.pages.map(p => ({ id: p.id, label: p.title, body: p.body, timeSlice: SLICE[p.time.slice] ?? 'present', ...(p.time.at ? { at: p.time.at } : {}), ...(typeof p.status === 'string' ? { status: p.status } : {}) })),
    edges: seed.pages.flatMap(p => p.links.filter(l => ids.has(l.to)).map(l => ({ source: p.id, target: l.to, relation: l.type }))) }
}

/** validateSeed(seed) → problems (empty when the seed follows helper/egdesk-scenario-seed.schema.json). */
export function validateSeed(seed) {
  const bad = []
  if (seed?.schema !== SEED_SCHEMA) bad.push('schema')
  if (!SEED_SOURCES.includes(seed?.source)) bad.push('source')
  if (!SEED_PRIVACY.includes(seed?.privacy)) bad.push('privacy')
  if (!Array.isArray(seed?.pages) || !seed.pages.length) bad.push('pages')
  for (const p of seed?.pages ?? []) {
    if (typeof p.id !== 'string' || typeof p.title !== 'string' || typeof p.body !== 'string') bad.push(`page ${p.id}: id/title/body`)
    if (!PAGE_SLICES.includes(p.time?.slice)) bad.push(`page ${p.id}: time.slice`)
    if (p.time?.at && !/^\d{4}-\d{2}-\d{2}/.test(p.time.at)) bad.push(`page ${p.id}: time.at`)
    if (!PAGE_STATUSES.includes(p.status)) bad.push(`page ${p.id}: status`)
    if (!p.source?.file && !p.source?.commit) bad.push(`page ${p.id}: provenance`)
    if (secretsIn(`${p.title}\n${p.body}`).length) bad.push(`page ${p.id}: unmasked secret`)
  }
  for (const t of seed?.turns ?? []) if (!TURN_TYPES.includes(t.type) || typeof t.text !== 'string') bad.push(`turn ${t.n}`)
  for (const e of seed?.expectations ?? []) if (e.status !== 'proposed') bad.push(`expectation ${e.turn}: status must be proposed`)
  for (const f of seed?.facts ?? []) if (!f.provenance?.file && !f.provenance?.commit) bad.push(`fact ${f.id}: provenance`)
  return bad
}

const sourceOfFile = f => (TAEHWA_ALLOWED.includes(f) ? 'taehwa-ontology' : 'egdesk-dev')
export const seedFileOf = seed => `${seed.id}${seed.variant === 'names-masked' ? '.names-masked' : ''}.json`
/** buildManifest({ seeds, sources, previous }) → { manifest, changes } (deterministic; previous: an earlier manifest or null). */
export function buildManifest({ seeds, sources, previous = null, since = null, only = null }) {
  const rows = seeds.map(s => ({ id: s.id, variant: s.variant, file: seedFileOf(s), hash: s.hash, source: s.source, privacy: s.privacy, newestAt: s.newestAt, pages: s.pages.length, turns: s.turns.length, facts: s.facts.length }))
  const key = r => `${r.id}|${r.variant}`
  const prior = new Map((previous?.seeds ?? []).map(r => [key(r), r]))
  // With --since only seeds with new facts are rebuilt; the others keep their earlier entry.
  // With only (one source extracted), the other sources' seeds keep their earlier entry too.
  const carried = [...prior.values()].filter(r => !rows.some(x => key(x) === key(r)) && (since || (only && r.source !== only)))
  const all = [...rows, ...carried].sort((a, b) => (key(a) < key(b) ? -1 : 1))
  // Source hashes are kept per source (a one-source run keeps the other's).
  const mergedSources = only && previous?.sources ? { ...previous.sources, files: { ...Object.fromEntries(Object.entries(previous.sources.files ?? {}).filter(([f]) => sourceOfFile(f) !== only)), ...sources.files },
    ...(sources.git ? { git: sources.git } : {}) } : sources
  const manifest = { schema: MANIFEST_SCHEMA, ...(since ? { since } : {}), approvals: Object.fromEntries(SEED_SOURCES.map(s => [s, SOURCE_APPROVALS[s] ?? null])),
    sources: { ...mergedSources, files: Object.fromEntries(Object.entries(mergedSources.files ?? {}).sort()) }, seeds: all }
  const changes = { new: rows.filter(r => !prior.has(key(r))).map(key), changed: rows.filter(r => prior.has(key(r)) && prior.get(key(r)).hash !== r.hash).map(key),
    removed: since ? [] : [...prior.values()].filter(r => (!only || r.source === only) && !rows.some(x => key(x) === key(r))).map(key), unchanged: rows.filter(r => prior.get(key(r))?.hash === r.hash).length, carried: carried.length }
  return { manifest, changes }
}
