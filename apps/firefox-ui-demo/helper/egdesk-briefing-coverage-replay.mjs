// Lane L4 cycle 48: the coverage re-measure of Main's c59 run of the layer replay. layer-coverage failed three hard checks (onboard_F2 .53, F3 .69, F4 .67; F1 .95, F5 .93, F6 .58). The question is whether the
// table answer of check-25br really shows those facts (the judge misses them) or the recorded board does not (the expectation was wrong). The recorded board's rows are 76-90 characters: every ledger
// entry's ids and figures are there, the prose of the row (what each merge did, the conflict notes) is mostly not, and the product's question asks for EVERY value of the row. This plan keeps the
// recorded request byte for byte and adds two controls built from it by code (the board JSON edited, the question and its wording unchanged), so the judge is measured against known boards:
//   cov-compressed  the recorded request again (same bytes as layer-coverage): the judge's repeatability on the board the engine wrote
//   cov-full        the same board with every row of the integration card replaced by the fact's own cells (the judge must see them: yes)
//   cov-absent      the same board with the 15:29 row (F3's entry) left out (the judge must notice: decided no, which is what starts the product's re-design)
// The product bars are not changed: a fact is missing only on a decided no (p <= .3); undecided does not block (egdesk-briefing-skeleton.mjs, coverage).
import { createHash } from 'node:crypto'
import { SKELETON_BARS } from './egdesk-briefing-skeleton.mjs'
import { DECISION_MODEL } from './egdesk-decision-client.mjs'
import { estimateBodyTokens } from './egdesk-decision-real-runner.mjs'
import { LOOP_ENTRIES } from './egdesk-briefing-real-engine-script.mjs'
import { boardIn, buildLayerReplayPlan, factsOf, layerProductBars } from './egdesk-briefing-layer-replay.mjs'

export const COVERAGE_REPLAY_SET = 'l4-briefing-coverage-replay'
export const COVERAGE_REPLAY_DIR = 'proofs/decision-real-measure/briefing-coverage-replay'
export const COVERAGE_REPLAY_CEILING = 15000
const MARKER = 'The board, its parts quoted in order as JSON: '
const sha = bytes => createHash('sha256').update(bytes).digest('hex')

/** The same request with another board: the board JSON is the only thing edited (re-serialised exactly as the product does, which is checked). */
export function withBoard(wire, edit) {
  const body = JSON.parse(wire), content = body.input[1].content, at = content.indexOf(MARKER)
  if (at < 0) throw new Error('coverage replay: no board in the request')
  const head = content.slice(0, at + MARKER.length), board = JSON.parse(content.slice(at + MARKER.length))
  if (JSON.stringify(board) !== content.slice(at + MARKER.length)) throw new Error('coverage replay: the board is not serialised the way the product writes it')
  const edited = edit(structuredClone(board))
  body.input[1] = { ...body.input[1], content: head + JSON.stringify(edited) }
  return JSON.stringify(body)
}
/** The values of a fact (the cells after its timestamp, cut at the marks the rows use) that are not on the board, whitespace ignored. Evidence for the report; the judge decides nothing from it. */
export function absentValues(fact, board) {
  const flat = JSON.stringify(board).replace(/\s+/g, '')
  return fact.split(' · ').slice(1).flatMap(cell => cell.split(/[;,]|\.\s|\.$|\(|\)|\s\+\s|\s=\s|→|:/)).map(x => x.trim()).filter(x => x.length >= 3 && !flat.includes(x.replace(/\s+/g, '')))
}

/** -> { plan, planBytes, files, requests, totals, evidence } — deterministic; sends nothing. */
export async function buildCoverageReplayPlan() {
  const layer = await buildLayerReplayPlan()
  const recorded = layer.files.find(f => f.file === 'requests/layer-coverage.json').bytes.toString('utf8')
  const facts = factsOf(recorded), board = boardIn(recorded)
  const rows = new Map(facts.map(f => [f.name, f.fact]))
  const integration = board.find(part => part.shown?.some(s => s.lines?.some(l => /9aeed73/.test(l.text))))
  if (!integration || integration.shown[0].lines.length !== 6) throw new Error('coverage replay: the integration card of the recorded board is not found')
  const f3Key = LOOP_ENTRIES.find(e => e.fact === '5930건')
  const full = withBoard(recorded, b => { const part = b.find(p => p.text === integration.text); part.shown[0].lines = [...rows.values()].map(fact => { const [stamp, ...cells] = fact.split(' · '); return { heading: `2026-${stamp.slice(0, 5)}`, text: cells.join(' · ') } }); return b })
  const absent = withBoard(recorded, b => { const part = b.find(p => p.text === integration.text); part.shown[0].lines = part.shown[0].lines.filter(l => !l.text.includes('5930건')); if (part.shown[0].lines.length !== 5 || !f3Key) throw new Error('coverage replay: the 15:29 row'); return b })
  if (JSON.stringify(boardIn(absent)).includes('5930건') || !JSON.stringify(boardIn(full)).includes('보정 어휘 충돌 합집합 해소')) throw new Error('coverage replay: the controls are not what they say')

  const YES = { min: SKELETON_BARS.yes }, NO = { max: SKELETON_BARS.no }
  const mk = (severity, name, rest, note) => ({ name, kind: 'predicate', ...rest, severity, note })
  const notNo = (name, note) => ({ name, kind: 'predicate', notDecidedNo: true, severity: 'hard', note })
  const names = facts.map(f => f.name)
  const specs = [
    ['cov-compressed', recorded, names.flatMap(n => [notNo(n, 'the recorded board carries this entry\'s ids and figures: the product acts only on a decided no (p <= .3). Same bytes as layer-coverage; c59 saw F1 .95 F2 .53 F3 .69 F4 .67 F5 .93 F6 .58'),
      mk('soft', n, YES, `shown in full: the row's prose cells that are not on the board: ${absentValues(rows.get(n), board).length}`)])],
    ['cov-full', full, names.map(n => mk('hard', n, YES, 'control: the integration card shows every cell of the fact (the judge must see a fully shown row)'))],
    ['cov-absent', absent, names.map(n => (n === 'onboard_F3' ? mk('hard', n, NO, 'control: the 15:29 row is not on the board (5930건 nowhere): a decided no is what starts the product\'s one re-design')
      : mk('soft', n, YES, 'the other rows are as recorded; recorded, not a pass condition')))],
  ]
  const files = [], requests = []
  for (const [id, wire, expect] of specs) {
    const bytes = Buffer.from(wire, 'utf8'), body = JSON.parse(wire)
    if (body.model !== DECISION_MODEL || Object.keys(body).some(k => !['model', 'input', 'questions', 'prompt_cache_key'].includes(k)) || body.questions.some(q => q.type !== 'predicate')) throw new Error(`${id}: not a plain predicate body`)
    files.push({ file: `requests/${id}.json`, bytes }); requests.push({ id, file: `requests/${id}.json`, sha256: sha(bytes), estInputTokens: estimateBodyTokens(wire), expect })
  }
  if (requests[0].sha256 !== layer.requests.find(r => r.id === 'layer-coverage').sha256) throw new Error('coverage replay: cov-compressed is not the recorded request')
  const plan = { set: COVERAGE_REPLAY_SET, tokenCeiling: COVERAGE_REPLAY_CEILING, productBars: layerProductBars(),
    passRule: 'PASS when every hard check passes at the product bar: on the recorded board no fact is judged decided-not-shown (p > .3, the product acts only on a decided no); on the control board that shows every cell of every row the judge says yes (>= .7) for all six facts; on the control board without the 15:29 row it decides no (<= .3) for that entry. The yes >= .7 of the recorded board is soft (recorded).',
    requests }
  const totals = { requests: requests.length, questions: specs.reduce((sum, [, w]) => sum + JSON.parse(w).questions.length, 0), bytes: files.reduce((sum, f) => sum + f.bytes.length, 0), estInputTokens: requests.reduce((sum, r) => sum + r.estInputTokens, 0) }
  if (totals.estInputTokens > COVERAGE_REPLAY_CEILING) throw new Error(`coverage replay over the ceiling: ${totals.estInputTokens}`)
  return { plan, planBytes: Buffer.from(JSON.stringify(plan, null, 2) + '\n'), files, requests, totals,
    evidence: names.map(n => ({ fact: n, absentValues: absentValues(rows.get(n), board) })) }
}
