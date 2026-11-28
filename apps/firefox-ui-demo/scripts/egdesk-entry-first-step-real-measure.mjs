// L51: real-model measurement of the entry's FIRST browser step on in-memory pages (httpbin order form: a checkbox and a time input; the-internet dynamic_loading/2:
// a button whose result appears late). No browser. usage: node scripts/egdesk-entry-first-step-real-measure.mjs <runs> <case: check|time|late|all> [--verbose]
// The key is read once from the stored attachment file and is never printed. A call counter stops the run at MAX_CALLS.
import fs from 'node:fs'
import { createDecisionClient, decisionTopicRecipient } from '../helper/egdesk-decision-client.mjs'
import { runBrowserReflex } from '../helper/egdesk-browser-reflex.mjs'
import { conversationAuthority } from '../helper/egdesk-browser-authority.mjs'
const key = fs.readFileSync('/Users/minsoocha/.aside/u/0/sessions/2026-11-15_5yGDgeI9gUvBBXY9/attachments/openai-api-key-20261122.txt', 'utf8').split('\n').find(l => l.startsWith('OPENAI_API_KEY=')).slice(15).trim()
const base = createDecisionClient({ getApiKey: async () => key, recipientForKey: (v, e, m) => decisionTopicRecipient(v, 1, e, m), timeoutMs: 15000 })
const MAX_CALLS = +process.env.MAX_CALLS || 40
let calls = 0
const verbose = process.argv.includes('--verbose')
const client = { ...base, decide: async args => {
  if (++calls > MAX_CALLS) throw new Error('call ceiling')
  const r = await base.decide(args)
  if (verbose) console.log('   call', JSON.stringify(r.usage), args.questions.map(q => q.name).join(','), JSON.stringify(Object.fromEntries(Object.entries(r.answers ?? {}).map(([k, v]) => [k, v?.probabilities ? Object.entries(v.probabilities).sort((a, b) => b[1] - a[1]).slice(0, 2).map(([a, b]) => a + ':' + (+b).toFixed(2)) : v?.probability ?? v?.confidence ?? v]))).slice(0, 600))
  return r
} }
import { formPage, latePage } from './egdesk-entry-first-step-pages.mjs'
const CASES = {
  check: { goal: '토핑은 베이컨이랑 양파로 체크해줘, 제출하지 마', page: formPage, init: () => ({ checked: {} }), want: st => st.checked.Bacon && st.checked.Onion && !st.checked['Extra Cheese'] && !st.checked.Mushroom },
  time: { goal: '배달 시간 저녁 7시 반으로 넣어줘, 제출하지 마', page: formPage, init: () => ({ checked: {} }), want: st => st.time === '19:30' },
  late: { goal: 'Start 누르고 나오는 글자 알려줘', page: latePage, init: () => ({ phase: 'idle' }), want: st => st.phase !== 'idle' && st.clicks === 1 },
}
async function one(c) {
  const st = { rev: 1, clicks: 0, fills: 0, posts: 0, ...c.init() }
  const callTool = async (name, a) => { if (verbose) console.log('   tool', name, JSON.stringify(a).slice(0,100)); try { return await callTool0(name, a) } catch (e) { console.log('   toolerr', e.message); throw e } }
  const callTool0 = async (name, a) => {
    if (name.endsWith('_observe')) { if (st.phase === 'loading' && ++st.polls >= 2) st.phase = 'done'; return { observationId: 'o' + st.rev, snapshot: c.page(st) } }
    if (name.endsWith('_fill')) { if (a.ref === 'tm') st.time = a.text; st.fills++; st.rev++; return { status: 'postcondition-observed' } }
    if (name.endsWith('_click')) {
      if (a.ref === 'sub') st.posts++
      else if (a.ref === 'b1') { st.clicks++; st.phase = 'loading'; st.polls = 0 }
      else { const l = { t0: 'Bacon', t1: 'Extra Cheese', t2: 'Onion', t3: 'Mushroom' }[a.ref]; if (l) st.checked[l] = !st.checked[l] }
      st.rev++; return { status: 'postcondition-observed', observationId: 'o' + st.rev, after: c.page(st) }
    }
    if (name.endsWith('_select') || name.endsWith('_check')) { st.rev++; return { status: 'postcondition-observed' } }
    if (name.endsWith('_wait')) { if (st.phase === 'loading') st.phase = 'done'; return { status: 'ok' } }
    if (verbose) console.log('   tool?', name, JSON.stringify(a).slice(0, 120))
    st.rev++; return { status: 'postcondition-observed' }
  }
  const id = 'm-' + Math.random().toString(36).slice(2), t0 = Date.now(), before = calls
  const r = await runBrowserReflex({ authority: conversationAuthority({ requestId: id, runId: 'r' }, c.goal), cardId: 'c', goal: c.goal, namedButtonRequest: c.goal, textComboboxes: true, valuesFirst: true, values: {}, firstFieldText: async () => null, callTool, client, isDecisionCurrent: () => true, maxSteps: 6 })
  if (verbose) console.log('   steps', JSON.stringify(r.steps.map(s => [JSON.stringify(s.decision?.ranked ?? null), s.rule, s.decision?.kind, s.decision?.next?.value, s.decision?.next?.confidence, s.decision?.top, s.decision?.second, s.actions.map(a => a.tool.replace('egdesk_browser_', ''))])))
  return { outcome: r.outcome, reason: r.reason ?? null, ok: !!c.want(st) && r.outcome === 'done', acted: !!c.want(st) || st.fills + st.clicks > 0, posts: st.posts, calls: calls - before, ms: Date.now() - t0 }
}
const n = +process.argv[2] || 3, which = process.argv[3] ?? 'all'
for (const [name, c] of Object.entries(CASES)) { if (which !== 'all' && which !== name) continue
  const rows = []; for (let i = 0; i < n; i++) { try { rows.push(await one(c)) } catch (e) { rows.push({ outcome: 'error:' + String(e.message).slice(0, 60), calls: 0 }) } }
  console.log(JSON.stringify({ case: name, n, entryDone: rows.filter(r => r.ok).length, outcomes: rows.map(r => r.outcome + (r.reason ? ':' + r.reason : '')), calls: rows.map(r => r.calls), posts: Math.max(...rows.map(r => r.posts ?? 0)) }))
}
console.log('total calls', calls)
