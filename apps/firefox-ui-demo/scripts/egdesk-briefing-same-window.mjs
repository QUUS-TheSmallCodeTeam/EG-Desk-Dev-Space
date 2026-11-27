#!/usr/bin/env node
// L4 cycle 29: TRUE same-window briefing cases from the person's own EG-Desk conversations. For each real summary / compare / progress request (lane L3's
// examples), the same conversation is read again with L3's readers (message text only: the person's and the assistant's; no tool outputs), the preceding turns
// become the materials and the REAL completed answer the answer; code picks diverse cases and a real one-fact control. Expectations are set BY CODE from the
// materials (see expectationsFor). Writes OUTSIDE the repository: cases.json, pages.json (lane L7 row shape) and spec.json for the real-material plan builder.
//   node scripts/egdesk-briefing-same-window.mjs --examples <conversation-examples dir> --out <dir> [--home /Users/<name>] [--n 3]
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { streamTurns } from '../helper/egdesk-conversation-examples.mjs'
import { briefingRequestKind } from '../helper/egdesk-briefing-real-requests.mjs'
import { askKind, excluded, factPlacement, oneFactControl, pickDiverse, sameWindowCase } from '../helper/egdesk-briefing-same-window.mjs'
import { answerCited, answerFacts, factCites, normalizeMaterials } from '../helper/egdesk-briefing-skeleton.mjs'

/** Pre-registered BY CODE from the materials (never from a judge's answer). */
export function expectationsFor(c, { control = false } = {}) {
  if (control) return { place: [{ match: 'combines', severity: 'hard', yes: false, note: 'a real one-fact answer: the bubble at the product rule (combines not yes)' }] }
  const mats = normalizeMaterials(c.pages), facts = answerFacts(c.answer.text).facts, cited = answerCited(c.answer.text, mats)
  const board = facts.length >= 3 && cited.length >= 2
  // Cycle 30: shown = what the faithful fill copies (the first lineTextMax characters of a cited turn) carries ALL of the fact's distinctive content, verbatim. The c29 rule
  // (a cited turn holds one anchor somewhere in its excerpt) pre-registered facts the card never carried (compare F1/F2, summary F2/F6: judge 0, 0, .10, 0).
  // Code can only know two things: a verbatim carry (hard: the product does not block it) and a fact none of whose content is in the turns (soft: not shown). A paraphrase
  // or a partial carry is not decidable by code (the summary's F1, a paraphrased lead, was judged .97 while carrying 2 of 9 tokens): those are asked and RECORDED, not registered.
  const coverage = facts.flatMap((f, i) => {
    const place = factPlacement(f, c.pages), cites = factCites(f, mats), name = `onboard_F${i + 1}`
    if (place.inLine.length) return [{ match: name, severity: 'hard', notDecidedNo: true, note: `every distinctive token of the fact (${place.tokens}) is in the line the fill copies from ${place.inLine.join(',')}: on the board; the product does not block it` }]
    if (!place.found && !cites?.length) return [{ match: name, severity: 'soft', yes: false, note: 'nothing of the fact is in the preceding turns (it came from work outside the message text): not on the board' }]
    return []
  })
  return { place: [{ match: 'combines', severity: board ? 'hard' : 'soft', yes: true, note: board ? `${facts.length} facts, citing ${cited.length} preceding turns by code` : `recorded: ${facts.length} facts, citing ${cited.length} preceding turns by code (below the board pre-registration rule)` }],
    coverage }
}

export async function main(argv = process.argv.slice(2)) {
  const arg = name => { const i = argv.indexOf(`--${name}`); return i >= 0 ? argv[i + 1] : undefined }
  const examples = arg('examples'), out = arg('out'), home = arg('home') ?? process.env.HOME, n = Number(arg('n') ?? 3)
  if (!examples || !out) throw new Error('usage: --examples <dir> --out <dir> [--home <dir>] [--n 3]')
  const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..')
  if (path.resolve(out).startsWith(repo + path.sep)) throw new Error('refused: real conversation text stays outside the repository')
  const rows = readFileSync(path.join(examples, 'examples', 'egdesk.jsonl'), 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l))
    .filter(r => r.privacy === 'owner-approved' && r.area === 'egdesk' && briefingRequestKind(r.user?.text) === 'summary')
  const byFile = new Map()
  for (const r of rows) { const f = r.source.file.replace(/^~(?=\/)/, home); if (excluded(f)) continue; (byFile.get(f) ?? byFile.set(f, { kind: r.source.kind, rows: [] }).get(f)).rows.push(r) }
  const cases = [], turnsOf = new Map()
  for (const [file, { kind, rows: list }] of byFile) {
    const turns = []
    for await (const t of streamTurns(file, kind)) turns.push(t)
    turnsOf.set(file, turns)
    for (const r of list) cases.push({ example: r.id, file, kind, ask: askKind(r.user.text), ...sameWindowCase(turns, r.source.line) })
  }
  const picked = pickDiverse(cases, n)
  let control = null
  for (const c of picked) { const one = oneFactControl(turnsOf.get(c.file)); if (one) { const ctx = sameWindowCase(turnsOf.get(c.file), one.line, { minAnswer: 1 }); control = { ...one, file: c.file, pages: ctx.pages ?? [] }; break } }
  const pages = [...picked.flatMap(c => c.pages), ...(control?.pages ?? [])]
  const spec = { set: 'l4-briefing-same-window', tokenCeiling: 12000, seeds: [{ id: 'conversation-examples', privacy: 'owner-approved' }],
    passRule: "SAME WINDOW: the person's real requests from their EG-Desk conversations, the preceding message turns of the same conversation as materials (message text only, masked), the REAL completed answer that followed. PASS when every hard check passes at the product bar: an answer pre-registered as a board (three or more facts citing two or more preceding turns by code) is judged to combine several facts (combines >= .7); a fact that cites a preceding turn is not decided absent from the faithfully filled board (notDecidedNo: the product does not block it); the real one-fact answer is the bubble (combines < .7).",
    requests: [...picked.map(c => ({ id: `sw-${c.ask}-${c.example.slice(0, 6)}`, example: c.example, request: c.request.text, answer: c.answer.text, select: { rule: 'ids', ids: c.pages.map(p => p.id) }, expect: expectationsFor(c) })),
      ...(control ? [{ id: `sw-control-${control.line}`, request: control.request.text, answer: control.answer.text, select: { rule: 'ids', ids: control.pages.map(p => p.id) }, expect: expectationsFor(control, { control: true }) }] : [])] }
  mkdirSync(out, { recursive: true, mode: 0o700 })
  const summary = { summaryRequests: rows.length, cases: cases.map(c => ({ example: c.example, ask: c.ask, kind: c.kind, dropped: c.dropped ?? null, answerChars: c.answer?.text.length ?? 0, materials: c.pages?.length ?? 0 })),
    picked: picked.map(c => c.example), control: control ? { line: control.line, answer: control.answer.text.length } : null }
  writeFileSync(path.join(out, 'cases.json'), JSON.stringify({ summary, picked, control }, null, 1), { mode: 0o600 })
  writeFileSync(path.join(out, 'pages.json'), JSON.stringify(pages, null, 1), { mode: 0o600 })
  writeFileSync(path.join(out, 'spec.json'), JSON.stringify(spec, null, 1), { mode: 0o600 })
  return summary
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().then(r => console.log(JSON.stringify(r)), error => { console.error(error.message); process.exit(2) })
}
