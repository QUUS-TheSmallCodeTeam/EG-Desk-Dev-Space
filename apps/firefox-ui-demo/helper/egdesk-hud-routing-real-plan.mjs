import { createHash } from 'node:crypto'
import { mkdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { DECISION_MODEL } from './egdesk-decision-client.mjs'
import { independentEstimate } from './egdesk-decision-real-runner.mjs'
import { hudRoutingQuestions, normalizeHudRouting } from './egdesk-hud-routing.mjs'
import * as HR from '../overlay/resources/EGDeskHudRouting.sys.mjs'

// PREPARED, NOT SENT (L1 c20). Real measure of Desk HUD routing: typical things typed into the Desk's search field, on one synthetic desk
// (two published result cards whose words may leave, the web row, the "ask an Agent" row). Every body is built by the PRODUCT's functions
// (explicitRoute -> routingCandidates -> normalizeHudRouting -> hudRoutingQuestions): what the product would send, byte for byte.
// Code-routed inputs (an address, a command line, an exact card name) make NO request in the product; they are listed with 0 requests.
// One diagnostic request sends the command line anyway (the product never does) to see what the predicates would say, for the owner's
// decision on command routing; it is record-only and never counted.
// Pre-registered: HARD 0 wrong highlights by the product's reading (analyzeHudRouting: rankRoute at HUD_ROUTING_BARS .8/.2 must give the
// expected row or nothing); SOFT each expected route is actually highlighted (coverage).
export const HUD_SET = 'hud-routing-v1'
export const HUD_DIR = 'proofs/decision-real-measure/hud-routing'
export const HUD_CEILING = 10000
const DESK = [
  { id: 'res-v1', title: 'A사 견적서 v1 단가표', text: '단가 12,000원 · 납기 3주 · 수량 500개' },
  { id: 'res-lunch', title: '점심 메뉴 투표 결과', text: '김치찌개 5표 · 비빔밥 3표' },
]
const nav = q => /^[a-z][a-z0-9+.-]*:/i.test(q) || /^[\w-]+(\.[\w-]+)+([/:?#].*)?$/i.test(q) // the field's own test (railSearchLooksLikeNavigation)
const rowsFor = query => {
  const cards = DESK.map(c => ({ key: `card:${c.id}`, type: 'card', title: c.title, record: c }))
  const web = { key: 'web', type: 'web', title: query }, ask = { key: 'ask', type: 'ask', title: query }
  return nav(query) ? [web, ...cards, ask] : [...cards, web, ask]
}
const quoteOf = row => (row.record ? { label: row.record.title, excerpt: row.record.text } : null)
// expected: the row keys the product may highlight (null = keep today's highlight); a highlight outside the set is a wrong highlight
export const HUD_INPUTS = Object.freeze([
  { id: 'address', text: 'github.com/egdesk/desk/pull/12', role: 'code', expectRule: 'address' },
  { id: 'command', text: 'git status --short', role: 'code', expectRule: 'command' },
  { id: 'exact-name', text: '점심 메뉴 투표 결과', role: 'code', expectRule: 'name' },
  { id: 'question', text: 'v1이랑 v2 견적 단가 차이가 얼마야?', role: 'route', expected: ['ask', null], want: 'ask' },
  { id: 'open-card', text: 'A사 견적서 v1 열어줘', role: 'route', expected: ['card:res-v1', null], want: 'card:res-v1' },
  { id: 'open-card-2', text: '점심 투표 결과 다시 보여줘', role: 'route', expected: ['card:res-lunch', null], want: 'card:res-lunch' },
  { id: 'web-search', text: 'firefox userChrome css 선택자 문법', role: 'route', expected: ['web', null], want: 'web' },
  { id: 'ambiguous', text: '견적', role: 'route', expected: ['card:res-v1', null], want: null },
  { id: 'ambiguous-2', text: '다음 주 회의', role: 'route', expected: [null], want: null },
  { id: 'command-diagnostic', text: 'git status --short', role: 'diagnostic' },
])
const sha = bytes => createHash('sha256').update(bytes).digest('hex')

export function buildHudPlan() {
  const rows = [], codeRouted = []
  for (const input of HUD_INPUTS) {
    const list = rowsFor(input.text)
    const explicit = HR.explicitRoute(input.text, list, { looksLikeNavigation: nav })
    if (input.role === 'code') {
      if (explicit?.rule !== input.expectRule) throw new Error(`${input.id}: the product does not route this by rule (${explicit?.rule})`)
      codeRouted.push({ id: input.id, text: input.text, rule: explicit.rule, requests: 0 }); continue
    }
    if (input.role === 'route' && explicit) throw new Error(`${input.id}: routed by rule; not a model request`)
    const candidates = HR.routingCandidates(list, { quoteOf })
    const wireBody = normalizeHudRouting({ query: input.text, candidates: candidates.wire })
    const { kinds, ...request } = hudRoutingQuestions(wireBody)
    const body = { model: DECISION_MODEL, input: request.input, questions: request.questions }
    const bytes = Buffer.from(JSON.stringify(body), 'utf8')
    const name = c => (c.kind === 'item' ? `goes_to_${c.alias}` : c.kind === 'web' ? 'web_search' : 'assistant_request')
    const want = input.want ?? null
    // SOFT coverage per predicate: the wanted row yes, every other candidate no (the product's two bars)
    const expect = input.role === 'diagnostic' ? [] : candidates.wire.map(c => {
      const isWant = want !== null && candidates.keyOf.get(c.kind === 'item' ? c.alias : c.kind) === want
      return isWant ? { name: name(c), kind: 'predicate', min: HR.HUD_ROUTING_BARS.yes, severity: 'soft', note: 'the wanted row: yes at the product bar' }
        : { name: name(c), kind: 'predicate', max: HR.HUD_ROUTING_BARS.no, severity: 'soft', note: 'not this row: no at the product bar' }
    })
    rows.push({ id: input.id, text: input.text, role: input.role, file: `requests/${input.id}.json`, bytes, sha256: sha(bytes), kinds,
      keyOf: Object.fromEntries(candidates.keyOf), expected: input.expected ?? null, want,
      estInputTokens: independentEstimate(0, request.questions.length, bytes.length), expect })
  }
  const est = rows.reduce((n, r) => n + r.estInputTokens, 0)
  if (est > HUD_CEILING) throw new Error(`${est} over ${HUD_CEILING}`)
  const plan = { set: HUD_SET, tokenCeiling: HUD_CEILING,
    productBars: { '*predicate': { yes: HR.HUD_ROUTING_BARS.yes, no: HR.HUD_ROUTING_BARS.no, source: 'overlay/resources/EGDeskHudRouting.sys.mjs HUD_ROUTING_BARS (.8 / .2), read by rankRoute' } },
    passRule: 'HARD: 0 wrong highlights by the product reading (helper/egdesk-hud-routing-real-plan.mjs analyzeHudRouting: rankRoute at .8/.2 gives a row in the request\'s expected set, null meaning today\'s highlight). ' +
      'SOFT: per request the wanted row yes and the others no at the product bars; the wanted route highlighted (coverage). The diagnostic request is record-only. ' +
      `Code-routed with no request: ${codeRouted.map(c => `${c.id} (${c.rule})`).join(', ')}.`,
    codeRouted,
    requests: rows.map(r => ({ id: r.id, file: r.file, sha256: r.sha256, estInputTokens: r.estInputTokens, role: r.role, keyOf: r.keyOf, expected: r.expected, want: r.want,
      ...(r.role === 'diagnostic' ? { recordOnly: true, diagnostic: true } : {}), expect: r.expect })) }
  return { rows, codeRouted, est, plan, planBytes: Buffer.from(JSON.stringify(plan, null, 2) + '\n'), files: rows.map(r => ({ file: r.file, bytes: r.bytes })) }
}

/** results: { [requestId]: { status, answers } } (answers: [{ name, type, probability }] or { name: { probability } }) -> the product's reading per request. */
export function analyzeHudRouting(results, plan) {
  const out = []
  for (const r of plan.requests.filter(x => x.role === 'route')) {
    const got = results?.[r.id]
    const list = Array.isArray(got?.answers) ? got.answers : Object.entries(got?.answers ?? {}).map(([name, a]) => ({ name, ...a }))
    const answers = Object.fromEntries(list.filter(a => a?.type === 'predicate' || typeof a?.probability === 'number').map(a => [a.name, a.probability]))
    const wire = Object.keys(r.keyOf).map(k => (k === 'web' || k === 'ask' ? { kind: k } : { kind: 'item', alias: k }))
    const picked = got?.status === 200 || got?.status === 'ok' || list.length ? HR.rankRoute({ wire, keyOf: new Map(Object.entries(r.keyOf)) }, answers)?.key ?? null : null
    out.push({ id: r.id, picked, wrong: !r.expected.includes(picked), covered: picked === r.want })
  }
  return { rows: out, wrong: out.filter(x => x.wrong).length, covered: out.filter(x => x.covered).length, total: out.length }
}

const here = path.dirname(fileURLToPath(import.meta.url))
export const HUD_ROOT = path.resolve(here, '..', HUD_DIR)
if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  const built = buildHudPlan()
  if (process.argv.includes('--write')) {
    mkdirSync(path.join(HUD_ROOT, 'requests'), { recursive: true })
    for (const f of built.files) writeFileSync(path.join(HUD_ROOT, f.file), f.bytes)
    writeFileSync(path.join(HUD_ROOT, 'plan.json'), built.planBytes)
  }
  console.log(JSON.stringify({ set: HUD_SET, requests: built.rows.length, est: built.est, ceiling: HUD_CEILING, codeRouted: built.codeRouted, dir: HUD_DIR, written: process.argv.includes('--write') }))
}
