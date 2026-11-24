#!/usr/bin/env node
// L4 cycle 28: find the person's real briefing requests in lane L3's conversation examples and pair them with loop material of the same window, BY CODE.
// Reads read-only; writes the result OUTSIDE the repository. Sends nothing.
//   node scripts/egdesk-briefing-real-requests.mjs --examples <conversation-examples dir> --pages <pages.json> --out <dir> [--area egdesk]
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { briefingRequestKind, replayable, sameWindowPairs } from '../helper/egdesk-briefing-real-requests.mjs'

export function main(argv = process.argv.slice(2)) {
  const arg = name => { const i = argv.indexOf(`--${name}`); return i >= 0 ? argv[i + 1] : undefined }
  const examples = arg('examples'), pagesFile = arg('pages'), out = arg('out'), area = arg('area') ?? 'egdesk'
  if (!examples || !pagesFile || !out) throw new Error('usage: --examples <dir> --pages <pages.json> --out <dir> [--area egdesk]')
  const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..')
  if (path.resolve(out).startsWith(repo + path.sep)) throw new Error('refused: real conversation text stays outside the repository')
  const rows = readFileSync(path.join(examples, 'examples', `${area}.jsonl`), 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l)).filter(r => r.privacy === 'owner-approved')
  const pages = JSON.parse(readFileSync(pagesFile, 'utf8'))
  const found = rows.map(r => ({ id: r.id, at: r.at, kind: briefingRequestKind(r.user?.text), text: r.user?.text ?? '' })).filter(r => r.kind)
  const pairs = sameWindowPairs(found, pages)
  const dated = [...new Set(pages.map(p => p.time?.at).filter(Boolean))].sort()
  const result = { examples: rows.length, found: { summary: found.filter(r => r.kind === 'summary').length, one_fact: found.filter(r => r.kind === 'one_fact').length },
    materialDays: dated, sameWindow: pairs.filter(p => !p.dropped).length,
    requests: pairs.map(p => ({ id: p.request.id, at: p.request.at, kind: p.request.kind, replayable: replayable(p.request.text), sameWindowPages: p.pages.length, dropped: p.dropped, text: p.request.text })) }
  mkdirSync(out, { recursive: true, mode: 0o700 })
  writeFileSync(path.join(out, 'real-requests.json'), JSON.stringify(result, null, 1), { mode: 0o600 })
  return result
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { const r = main(); console.log(JSON.stringify({ ...r, requests: r.requests.map(({ text, ...rest }) => rest) })) } catch (error) { console.error(error.message); process.exit(2) }
}
