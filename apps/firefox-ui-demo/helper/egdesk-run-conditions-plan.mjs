import { createHash } from 'node:crypto'
import { DECISION_MODEL, createDecisionClient } from './egdesk-decision-client.mjs'
import { independentEstimate } from './egdesk-decision-real-runner.mjs'
import { CONDITION_NO, CONDITION_YES, conditionRequest } from './egdesk-run-conditions.mjs'

// Real-measurement plan for the condition arbiter's AUXILIARY predicates (c21), on realistic output tails. Builds the exact bodies the
// product sends (conditionRequest through the Decision client, captured at its fetch); nothing is sent from here and no key is read.
// The product asks one condition per request and only when the structured fact is missing (exit 0 without a test summary; no port to
// probe; no git status), so each request here carries one question. Hard checks sit at the product bars (yes .8 / no .2): a miss on
// a hard "yes" means a reported problem would not lower health (or a conflict/listening hint would be missed); a miss on a hard "no"
// means a clean output would be marked unconfirmed (friction, never a false success: a predicate cannot declare success).
// Synthetic data only: invented project and file names, the reserved example.test domain.
export const RUN_CONDITIONS_PLAN_SET = 'run-conditions-v1'
export const RUN_CONDITIONS_PLAN_TOKEN_CEILING = 8_000
const SYNTHETIC_KEY = 'egd-synthetic-not-a-key-c21-plan'
const sha256 = text => createHash('sha256').update(text).digest('hex')
const bar = (name, kind, value, severity, note) => ({ name, kind: 'predicate', [kind]: value, severity, note })
const yes = (name, note) => bar(name, 'min', CONDITION_YES, 'hard', note)
const no = (name, note) => bar(name, 'max', CONDITION_NO, 'hard', note)
const softNo = (name, note) => bar(name, 'max', CONDITION_NO, 'soft', note)

export const RUN_CONDITION_CASES = Object.freeze([
  { id: 'problem-lint-errors-exit0', question: 'output_reports_problem', command: 'npm run lint || true',
    output: '> demo-app@1.0.0 lint\n> eslint src\n\n/work/demo-app/src/merge.js\n  12:7  error  \'unused\' is assigned a value but never used  no-unused-vars\n  30:1  error  Expected indentation of 2 spaces  indent\n\n/work/demo-app/src/format.js\n   4:10 error  \'x\' is not defined  no-undef\n\n✖ 3 problems (3 errors, 0 warnings)\n',
    expect: [yes('output_reports_problem', 'Lint errors with exit 0 (the script swallowed the status). If this is not a yes, exit 0 would stand as healthy over real errors.')] },
  { id: 'problem-tsc-errors-exit0', question: 'output_reports_problem', command: 'npx tsc --noEmit; echo done',
    output: "src/merge.ts(41,9): error TS2345: Argument of type 'string' is not assignable to parameter of type 'number'.\n\nFound 1 error in src/merge.ts:41\n\ndone\n",
    expect: [yes('output_reports_problem', 'A type error, exit 0 from the trailing echo. A miss lets a type error pass as healthy.')] },
  { id: 'problem-build-clean', question: 'output_reports_problem', command: 'npm run build',
    output: '> demo-app@1.0.0 build\n> vite build\n\nvite v5.4.2 building for production...\n✓ 34 modules transformed.\ndist/index.html                  0.46 kB │ gzip:  0.30 kB\ndist/assets/index-4f2a1c.js     142.10 kB │ gzip: 45.80 kB\n✓ built in 812ms\n',
    expect: [no('output_reports_problem', 'A clean build. A miss marks a good build as unconfirmed (friction, not a false success).')] },
  { id: 'problem-build-chunk-warning', question: 'output_reports_problem', command: 'npm run build',
    output: 'vite v5.4.2 building for production...\n✓ 412 modules transformed.\ndist/assets/index-9b8c7d.js   812.40 kB │ gzip: 260.10 kB\n\n(!) Some chunks are larger than 500 kB after minification. Consider:\n- Using dynamic import() to code-split the application\n✓ built in 2.41s\n',
    expect: [softNo('output_reports_problem', 'An advisory size warning on a finished build: observed (a yes is defensible, it only lowers to unconfirmed).')] },
  { id: 'problem-install-deprecated', question: 'output_reports_problem', command: 'npm install',
    output: 'npm WARN deprecated inflight@1.0.6: This module is not supported, and leaks memory.\nnpm WARN deprecated glob@7.2.3: Glob versions prior to v9 are no longer supported\n\nadded 312 packages, and audited 313 packages in 9s\n\nfound 0 vulnerabilities\n',
    expect: [softNo('output_reports_problem', 'Deprecation notices on a finished install: observed.')] },
  { id: 'listening-vite-ready', question: 'output_says_listening', command: 'npm run dev',
    output: '> demo-app@1.0.0 dev\n> vite\n\n\n  VITE v5.4.2  ready in 312 ms\n\n  ➜  Local:   http://localhost:5173/\n  ➜  Network: use --host to expose\n  ➜  press h + enter to show help\n',
    expect: [yes('output_says_listening', 'The usual ready banner. Only a hint (the port probe decides); a miss just loses the hint.')] },
  { id: 'listening-eaddrinuse', question: 'output_says_listening', command: 'npm run start',
    output: "> demo-api@1.0.0 start\n> node server.js\n\nnode:events:497\n      throw er; // Unhandled 'error' event\n      ^\n\nError: listen EADDRINUSE: address already in use :::3000\n    at Server.setupListenHandle [as _listen2] (node:net:1872:16)\n",
    expect: [no('output_says_listening', 'The server failed to bind. A yes here would be a wrong hint (the probe still decides).')] },
  { id: 'conflict-merge', question: 'output_reports_conflict', command: 'git merge topic/search',
    output: 'Auto-merging src/search.js\nCONFLICT (content): Merge conflict in src/search.js\nAutomatic merge failed; fix conflicts and then commit the result.\n',
    expect: [yes('output_reports_conflict', 'The textbook conflict message. Only a hint when git status is unavailable.')] },
  { id: 'conflict-rebase', question: 'output_reports_conflict', command: 'git rebase main',
    output: 'Auto-merging src/format.js\nCONFLICT (content): Merge conflict in src/format.js\nerror: could not apply 1a2b3c4... Format dates in the list\nhint: Resolve all conflicts manually, mark them as resolved with\nhint: "git add/rm <conflicted_files>", then run "git rebase --continue".\n',
    expect: [yes('output_reports_conflict', 'A rebase stopped on a conflict.')] },
  { id: 'conflict-fast-forward', question: 'output_reports_conflict', command: 'git pull --ff-only',
    output: 'Updating 1a2b3c4..5d6e7f8\nFast-forward\n src/search.js | 2 +-\n 1 file changed, 1 insertion(+), 1 deletion(-)\n',
    expect: [no('output_reports_conflict', 'A clean fast-forward. A yes would be a wrong conflict hint.')] },
])

function captureClient(sink) {
  return createDecisionClient({ getApiKey: () => SYNTHETIC_KEY, recipientForKey: () => 'a'.repeat(64),
    fetchImpl: async (url, init) => { sink.push(init.body); return Response.json({ answers: JSON.parse(init.body).questions.map(q => ({ name: q.name, type: 'predicate', probability: 0.5 })), usage: { input_tokens: 1 } }) } })
}

export async function buildRunConditionsPlan() {
  const requests = [], files = {}
  for (const entry of RUN_CONDITION_CASES) {
    const sink = []
    await captureClient(sink).decide(conditionRequest([entry.question], { command: entry.command, output: entry.output }))
    const body = sink[0], parsed = JSON.parse(body)
    if (parsed.model !== DECISION_MODEL) throw new Error(`${entry.id}: unexpected model`)
    files[`requests/${entry.id}.json`] = body
    requests.push({ id: entry.id, file: `requests/${entry.id}.json`, sha256: sha256(body), estInputTokens: independentEstimate(0, parsed.questions.length, Buffer.byteLength(body)), expect: entry.expect })
  }
  if (/egd-synthetic/.test(Object.values(files).join('\n'))) throw new Error('a key is in a request body')
  const total = requests.reduce((sum, r) => sum + r.estInputTokens, 0)
  if (total > RUN_CONDITIONS_PLAN_TOKEN_CEILING) throw new Error(`the plan estimates ${total} input tokens, over ${RUN_CONDITIONS_PLAN_TOKEN_CEILING}`)
  const source = 'helper/egdesk-run-conditions.mjs CONDITION_YES / CONDITION_NO (a yes lowers health or adds a hint; a no keeps the structured result)'
  const plan = { set: RUN_CONDITIONS_PLAN_SET, tokenCeiling: RUN_CONDITIONS_PLAN_TOKEN_CEILING,
    passRule: 'A request passes when no hard check fails. Each request asks one auxiliary predicate, as the product does when the structured fact is missing. Hard checks are at the product bars; soft checks are observations.',
    productBars: { output_reports_problem: { yes: CONDITION_YES, no: CONDITION_NO, source }, output_says_listening: { yes: CONDITION_YES, no: CONDITION_NO, source },
      output_reports_conflict: { yes: CONDITION_YES, no: CONDITION_NO, source } },
    requests }
  files['plan.json'] = JSON.stringify(plan, null, 2) + '\n'
  return { plan, files, totals: { requests: requests.length, estInputTokens: total, bytes: Object.entries(files).filter(([k]) => k.startsWith('requests/')).reduce((s, [, v]) => s + Buffer.byteLength(v), 0) } }
}
