#!/usr/bin/env node
// L4 cycle 24: the briefing on REAL material (the decision loop's own record, built by scripts/egdesk-briefing-loop-materials.mjs). For each request of a spec
// (kept outside the repository: it quotes the real material), the materials are selected BY CODE, the product's own skeleton flow runs through the production
// Board/Decisions handler with a local provider (nothing is sent), the subjective model's fill is FAITHFUL (copied from the materials), and the exact bodies the
// product sends are kept with pre-registered expectations at the product bars. Token estimate: TOKEN_MODEL (cycle 25, fitted on real usage).
//   node scripts/egdesk-briefing-real-material-plan.mjs --pages <pages.json> --spec <spec.json> --out <dir outside the repo>
import { createHash } from 'node:crypto'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { runSkeletonFlow, SKELETON_BARS, normalizeMaterials, answerFacts } from '../helper/egdesk-briefing-skeleton.mjs'
import { DECISION_MODEL } from '../helper/egdesk-decision-client.mjs'
import { rig } from './egdesk-briefing-rig.support.mjs'

const sha = bytes => createHash('sha256').update(bytes).digest('hex')
// Cycle 25: fitted by least squares on the 15 real briefing requests with bodies on disk (c18, c20, c21, c24; 22,020 real input tokens): per question, per ASCII
// character, per non-ASCII character (Korean text costs about 4.4x an ASCII character; the c24 byte model under-counted it and the real run hit its ceiling at
// 13,076 against an estimate of 11,989). Worst real/fit ratio 1.074, so the estimate carries a 1.10 margin.
export const TOKEN_MODEL = Object.freeze({ perQuestion: 132.18, perAscii: 0.2231, perNonAscii: 0.9838, margin: 1.10, fittedOn: 15, worstRatio: 1.074 })
export function estimateTokens(wire) {
  const body = JSON.parse(wire), text = String(wire)
  let ascii = 0
  for (const ch of text) if (ch.codePointAt(0) < 128) ascii++
  const nonAscii = [...text].length - ascii
  return Math.ceil(TOKEN_MODEL.margin * (TOKEN_MODEL.perQuestion * body.questions.length + TOKEN_MODEL.perAscii * ascii + TOKEN_MODEL.perNonAscii * nonAscii))
}
const est = estimateTokens
const byTime = (a, b) => `${a.time.at ?? ''} ${a.clock ?? ''}`.localeCompare(`${b.time.at ?? ''} ${b.clock ?? ''}`)

// ---- selection BY CODE (the memory loop that would choose in the product is not part of this measurement; the rule is named in the plan) ----
const selectors = pages => ({
  // the newest n dated ledger events, in time order
  'newest-ledger': ({ n = 8 }) => pages.filter(p => p.source === 'ledger' && p.time.at).sort(byTime).slice(-n),
  // a lane's report pages from a cycle on, the newest n (the skeleton takes at most 8 materials), in cycle order
  'lane-reports': ({ lane, from, n = 8 }) => pages.filter(p => p.source === 'report' && p.lane === lane && p.cycle >= from).sort((a, b) => a.cycle - b.cycle).slice(-n),
  // the ledger lines that name one lane-cycle (where its merge is recorded with its date), in time order
  naming: ({ laneCycle, n = 8 }) => pages.filter(p => p.source === 'ledger' && p.lanes.includes(laneCycle)).sort(byTime).slice(0, n),
  // named pages, in the given order (a diagnostic re-asks one item alone); `override` replaces named fields of a page for an A/B of one change
  ids: ({ ids, override = {} }) => ids.map(id => { const p = pages.find(x => x.id === id); if (!p) throw new Error(`no page ${id}`); return { ...p, ...(override[id] ?? {}) } }),
})

// ---- the faithful fill: every slot copied from the material it cites (as lane L2 did for s3) ----
const cut = (t, max) => (t.length <= max ? t : t.slice(0, max).replace(/\s+\S*$/, ''))
const sentences = t => String(t).split(/(?<=[.!?。])\s+|(?<=다\.)\s*/).map(x => x.trim()).filter(Boolean)
const mmdd = at => (at ? `${at.slice(5, 7)}/${at.slice(8, 10)}` : null)
function faithfulFill(asked, materials) {
  const mat = alias => materials[Number(alias.slice(1)) - 1]
  const items = {}
  for (const item of asked.guide.items) {
    const ms = item.materials.map(mat)
    const slots = {}
    for (const s of item.slots) {
      if (s.type === 'text') slots[s.name] = cut(s.name === 'title' ? ms[0].title : (ms[0].excerpt || ms[0].title), s.max)
      else if (s.type === 'material') slots[s.name] = item.materials[s.name === 'right' ? 1 : 0]
      else if (s.type === 'list') {
        const rows = item.materials.slice(0, s.max).map((alias, i) => {
          const m = ms[i], row = {}
          for (const f of s.of) {
            if (f.name === 'from') row.from = alias
            else if (f.name === 'label') row.label = item.shows === 'sequence' && mmdd(m.time.at) ? mmdd(m.time.at) : cut(m.title.replace(/^\d{2}-\d{2} \d{2}:\d{2}\s*/, ''), f.max)
            // what the card copies: a report page's change is its own title, cycle name included (its excerpt opens with bookkeeping); a ledger line is its own
            // text, its stamp included (the time is part of what it records)
            else if (f.name === 'text') row.text = cut(m.id.startsWith('report-') ? m.title : m.excerpt, f.max)
            else if (f.name === 'aspect') row.aspect = '내용'
            else if (f.name === 'left' || f.name === 'right') row[f.name] = cut(sentences(materials[Number(item.materials[f.name === 'right' ? 1 : 0].slice(1)) - 1].excerpt)[i] ?? '', f.max)
            else row[f.name] = cut(m.title, f.max ?? 60)
          }
          return row
        })
        // Cycle 25: an open-items card lists what is still to happen. A planned line that assigns several items ("배정: A / B / C") gives one copied line per
        // item, each headed by the line's own stamp (c24 put the whole line in one 90-character row: two of eight assignments, under a cut title -> F5 .60).
        const openLines = item.shows === 'open_items' && s.of.some(f => f.name === 'text') ? item.materials.flatMap((alias, i) => {
          const m = ms[i], at = m.excerpt.search(/배정|착수|assigned/i), stamp = /^\d{2}-\d{2} \d{2}:\d{2}/.exec(m.excerpt)?.[0]
          if (at < 0) return []
          const items = m.excerpt.slice(at).replace(/^(?:배정|착수|assigned)\s*[:：]?\s*/i, '').replace(/…$/, '').split(/\s+\/\s+/).map(x => x.trim()).filter(Boolean)
          return items.map(x => ({ label: cut(stamp ?? m.title, s.of.find(f => f.name === 'label').max), text: cut(x, s.of.find(f => f.name === 'text').max), from: alias }))
        }) : []
        slots[s.name] = openLines.length ? openLines.slice(0, s.max) : rows.slice(0, Math.max(s.min ?? 1, rows.length))
        // Cycle 26 (the fill rule of the product, egdesk-briefing-engine.mjs FILL_RULES): more items than rows -> the title carries the total, copied as the material
        // writes it ("8개 레인 동시 실행"); c25 listed six of eight with no total -> F5 .25
        if (openLines.length > s.max) {
          const titleSlot = item.slots.find(x => x.name === 'title'), m = ms[0], total = /\d+\s?개\s?[가-힣A-Za-z]+(?:\s[가-힣A-Za-z]+){0,2}/.exec(m.excerpt)
          const stamp = /^\d{2}-\d{2} \d{2}:\d{2}/.exec(m.excerpt)?.[0]
          if (titleSlot && total) slots.title = cut(`${stamp ? `${stamp} ` : ''}${total[0]}`, titleSlot.max)
        }
      }
    }
    const first = slots.lines?.[0]?.text ?? slots.rows?.[0]?.left ?? sentences(slots.body ?? ms[0].title)[0] ?? ms[0].title
    items[item.id] = { text: cut(first, 300), fallback: '카드를 열어 보세요.', slots }
  }
  return { title: cut(asked.guide.items[0] ? materials[Number(asked.guide.items[0].materials[0].slice(1)) - 1].title : '정리', 40), items }
}

async function flow({ request, answer, materials, script = () => undefined }) {
  const captured = [], cleanups = [], fills = []
  const provider = async (_url, init) => { const body = JSON.parse(init.body); captured.push({ wire: init.body, names: body.questions.map(q => q.name), stage: body.prompt_cache_key.replace('briefing-skeleton-', '') })
    return Response.json({ answers: body.questions.map(q => ({ name: q.name, type: 'predicate', probability: script(q) ?? (q.name.startsWith('same_') ? .03 : .95) })), usage: { input_tokens: 1 } }) }
  const R = rig({ after: fn => cleanups.push(fn) }, { mode: 'on', handlerOptions: { fetchImpl: provider } })
  const root = '/decision/briefing-skeleton'
  const judge = { prepare: async dto => (await R.http('POST', `${root}/prepare`, dto)).body, run: async ticket => (await R.http('POST', `${root}/run`, { ticket, confirm: true })).body, cancel: async ticket => (await R.http('POST', `${root}/cancel`, { ticket })).body }
  try {
    const out = await runSkeletonFlow({ request, answer, materials, candidates: [], currentAnswerId: 'ans-now', viewport: { x: 0, y: 0, width: 2400, height: 1400 }, judge,
      fill: async asked => { fills.push(asked); return faithfulFill(asked, materials) } })
    return { out, captured, fills }
  } finally { for (const fn of cleanups) fn() }
}

const YES = { min: SKELETON_BARS.yes }, NO = { max: SKELETON_BARS.no }, COMBINES_NOT_YES = Math.round((SKELETON_BARS.yes - 0.001) * 1000) / 1000 // the board decision's bubble side (see productBars.combines)
const check = (name, sev, bar, note) => ({ name, kind: 'predicate', ...bar, severity: sev, note })
/** main(argv) -> { plan, log, total } (writes the plan and the bodies under --out). Throws on a refusal or an over-ceiling plan. */
export async function main(argv = process.argv.slice(2)) {
const arg = name => { const i = argv.indexOf(`--${name}`); return i >= 0 ? argv[i + 1] : undefined }
const pagesFile = arg('pages'), specFile = arg('spec'), OUT = arg('out')
if (!pagesFile || !specFile || !OUT) throw new Error('usage: --pages <pages.json> --spec <spec.json> --out <dir>')
const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..')
if (path.resolve(OUT).startsWith(repo + path.sep)) throw new Error('refused: the plan quotes real material; it stays outside the repository')
const pages = JSON.parse(readFileSync(pagesFile, 'utf8')), spec = JSON.parse(readFileSync(specFile, 'utf8')), SELECT = selectors(pages)
mkdirSync(path.join(OUT, 'requests'), { recursive: true, mode: 0o700 })
const requests = [], log = []
for (const r of spec.requests) {
  const rows = SELECT[r.select.rule](r.select)
  const materials = rows.map(({ id, title, excerpt, time, status, links }) => ({ id, title, excerpt, time, status, links }))
  for (const m of materials) m.excerpt = m.excerpt.replace(/…$/, '') // the builder's cut mark is not material text
  const normalized = normalizeMaterials(materials)
  const f = await flow({ request: r.request, answer: r.answer, materials, script: r.script ? q => r.script[q.name] : undefined })
  log.push(`== ${r.id}: ${rows.length} pages (${r.select.rule}) -> ${f.out.status}${f.out.reason ? ` ${f.out.reason}` : ''}; stages ${f.captured.map(c => `${c.stage}[${c.names.length}]`).join(' ')}`)
  log.push(`   materials: ${normalized.map(m => `${m.alias} ${m.at ?? '-'} ${m.status} "${m.title.slice(0, 40)}"`).join(' | ')}`)
  if (f.out.guide) log.push(`   board: ${f.out.guide.items.map(i => `${i.id} ${i.shows}/${i.component}[${i.materials.join(',')}]`).join(' ')}`)
  if (r.answer) log.push(`   answer facts: ${JSON.stringify(answerFacts(r.answer).facts)}`)
  for (const c of f.captured) {
    const want = (r.expect?.[c.stage]) ?? null
    // a stage the spec does not register is kept as evidence only (never in the plan): its body depends on the scripted answers of the stages before it
    if (!want) { writeFileSync(path.join(OUT, 'requests', `${r.id}-${c.stage}.unsent.json`), c.wire, { mode: 0o600 }); continue }
    const id = `${r.id}-${c.stage}${f.captured.filter(x => x.stage === c.stage).indexOf(c) ? `-${f.captured.filter(x => x.stage === c.stage).indexOf(c) + 1}` : ''}`
    const expect = c.names.map(n => {
      const rule = want.find(w => new RegExp(`^${w.match}$`).test(n))
      return rule ? check(n, rule.severity, rule.yes ? YES : n === 'combines' ? { max: COMBINES_NOT_YES } : NO, rule.note) : null
    }).filter(Boolean)
    const bytes = Buffer.from(c.wire, 'utf8'), body = JSON.parse(c.wire)
    if (body.model !== DECISION_MODEL || body.questions.some(q => q.type !== 'predicate')) throw new Error(`${id}: not a plain predicate body`)
    writeFileSync(path.join(OUT, 'requests', `${id}.json`), bytes, { mode: 0o600 })
    requests.push({ id, file: `requests/${id}.json`, sha256: sha(bytes), estInputTokens: est(c.wire), ...(expect.length ? { expect } : { expect: [], recordOnly: true }) })
  }
  writeFileSync(path.join(OUT, `${r.id}-flow.json`), JSON.stringify({ selection: rows.map(x => x.id), status: f.out.status, reason: f.out.reason ?? null, guide: f.out.guide ?? null, coverage: f.out.coverage ?? null,
    fill: f.fills[0] ? faithfulFill(f.fills[0], materials) : null }, null, 1), { mode: 0o600 })
}
const families = ['combines', 'about_M#', 'same_M#_M#', 'aspect_P#', 'happened_M#', 'todo_M#', 'fact_M#', 'before_P#_P#', 'slot_P#_r#', 'slot_P#_r#_left', 'slot_P#_r#_right', 'step_P#', 'onboard_F#', 'several', 'one_sentence']
const plan = { set: spec.set, tokenCeiling: spec.tokenCeiling,
  productBars: { ...Object.fromEntries(families.map(f => [f, { yes: SKELETON_BARS.yes, no: SKELETON_BARS.no, source: 'egdesk-briefing-skeleton.mjs SKELETON_BARS { yes .7, no .3 }: isYes iff p >= .7, isNo iff p <= .3' }])),
    // Cycle 25: for the board decision the product's negative outcome is anything that is not a yes (decidePlace: a decided no -> judged-bubble, undecided -> placement-
    // undecided, both the bubble). A bubble check therefore holds combines below the yes bar; c24 held it at <= .3, stricter than the product (.43 was a bubble).
    combines: { yes: SKELETON_BARS.yes, no: COMBINES_NOT_YES, source: 'egdesk-briefing-skeleton.mjs decidePlace: board iff combines >= .7 (and two relevant materials); anything below .7 is the bubble' } },
  passRule: spec.passRule, requests }
writeFileSync(path.join(OUT, 'plan.json'), JSON.stringify(plan, null, 2) + '\n', { mode: 0o600 })
const total = requests.reduce((s, x) => s + x.estInputTokens, 0)
log.push(`== plan: ${requests.length} requests, est ${total} input tokens (ceiling ${spec.tokenCeiling}); hard ${requests.reduce((s, x) => s + x.expect.filter(e => e.severity === 'hard').length, 0)}, soft ${requests.reduce((s, x) => s + x.expect.filter(e => e.severity === 'soft').length, 0)}`)
for (const x of requests) log.push(`   ${x.id.padEnd(26)} ~${String(x.estInputTokens).padStart(5)} tok  ${x.recordOnly ? 'record only' : x.expect.map(e => `${e.name}:${e.severity[0]}${e.min !== undefined ? '>=' + e.min : '<=' + e.max}`).join(' ')}`)
if (total > spec.tokenCeiling) throw Object.assign(new Error(`over the ceiling\n${log.join('\n')}`), { log })
return { plan, log, total }
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().then(r => console.log(r.log.join('\n')), error => { console.error(error.message); process.exit(2) })
}
