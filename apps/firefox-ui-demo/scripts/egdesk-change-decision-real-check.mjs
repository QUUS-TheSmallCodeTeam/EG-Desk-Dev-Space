// L55: real decision-model check of the change decision (a refused act on a page that keeps changing). Sends at most MAX_CALLS requests.
// Usage (from apps/firefox-ui-demo): EGDESK_DECISION_PROVIDER=gemini node scripts/egdesk-change-decision-real-check.mjs [scenario...]
// Reads the Gemini key (GEMINI_API_KEY=... line) from EGDESK_GEMINI_DECISION_KEY_FILE or the EG-Desk settings folder, read-only; the key is never printed.
// No Marionette, no bridge, no profile: the page is the in-process fixture of helper/egdesk-browser-change.fixture.mjs.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createDecisionClient, decisionProviderFromEnv, decisionTopicRecipient } from '../helper/egdesk-decision-client.mjs'
import { runBrowserReflex } from '../helper/egdesk-browser-reflex.mjs'
import { NEXT, el, plain, world } from '../helper/egdesk-browser-change.fixture.mjs'

const MAX_CALLS = Number(process.env.L55_MAX_CALLS || 40)
const provider = decisionProviderFromEnv(process.env)
const keyFile = process.env.EGDESK_GEMINI_DECISION_KEY_FILE || path.join(os.homedir(), 'Library/Application Support/EG-Desk/settings/gemini-decision-key.txt')
const key = provider === 'gemini' ? fs.readFileSync(keyFile, 'utf8').split('\n').find(line => line.startsWith('GEMINI_API_KEY='))?.slice('GEMINI_API_KEY='.length).trim() : null
if (!key) { console.error('this check needs EGDESK_DECISION_PROVIDER=gemini and a saved Gemini key'); process.exit(2) }
let calls = 0
const real = createDecisionClient({ provider, getApiKey: async () => key, recipientForKey: (v, e, m) => decisionTopicRecipient(v, 1, e, m), timeoutMs: 15000 })
const limited = { async decide(request, options) { if (++calls > MAX_CALLS) throw new Error('call limit reached'); return real.decide(request, options) } }
const login = live => [el('u_1', 'textbox', 'Email'), el('p_1', 'password', 'Password'), el('s_1', 'button', 'Sign in')]
const SCENARIOS = {
  ticking: { goal: 'Type the name Kim into the Name field, then open the Next link', values: { '[F1] Name': 'Kim' }, build: () => world({ shape: plain, realClient: limited }) },
  replaced: { goal: 'Type the name Kim into the Name field', values: { '[F1] Name': 'Kim' }, build: () => world({ shape: live => (live.revision < 4 ? [el('f_1', 'textbox', 'Name')] : [el('f_9', 'textbox', 'Name')]), realClient: limited }) },
  moved: { goal: 'Type the name Kim into the Name field', values: { '[F1] Name': 'Kim' }, build: () => world({ shape: live => [el('f_1', 'textbox', 'Name', { bounds: { x: 10, y: 100 + live.revision * 3, width: 200, height: 24 } })], realClient: limited }) },
  loginwall: { goal: 'Type the name Kim into the Name field', values: { '[F1] Name': 'Kim' }, build: () => world({ shape: live => (live.revision < 3 ? plain(live) : login(live)), text: live => (live.revision < 3 ? ['Form', `clock ${live.revision}`] : ['Sign in to continue', 'Enter your email and password']), realClient: limited }) },
}
for (const name of process.argv.slice(2).length ? process.argv.slice(2) : Object.keys(SCENARIOS)) {
  const scenario = SCENARIOS[name]
  const w = scenario.build()
  const before = calls
  const result = await runBrowserReflex({ cardId: 'c', goal: scenario.goal, values: scenario.values, callTool: w.callTool, client: w.client, maxSteps: 6, thresholds: undefined })
  const rounds = result.steps.flatMap(step => step.change?.rounds ?? [])
  console.log(JSON.stringify({ scenario: name, provider, outcome: result.outcome, reason: result.reason ?? null, pageState: result.pageState ?? null, unsettled: result.unsettled ?? null, filled: w.live.filled, opened: w.live.opened,
    acts: w.live.acts.length, refused: w.live.refused, requests: calls - before, rounds: rounds.map(r => [r.round ?? null, r.target ?? null, r.decided ?? null, r.acted ?? null]) }))
}
console.log('total requests', calls)
