#!/usr/bin/env node
// Dry by default (prints the plan). --run starts one app-server per arm with --codex-bin (an absolute path; this repo never ships or starts one). See helper/egdesk-pure-engine-probe.mjs.
//   node scripts/egdesk-pure-engine-probe.mjs --codex-bin <abs> --person-home --out <abs dir> [--arms baseline,current,names,candidates] [--ask] [--names] [--model m] [--effort e] [--run]
import { PROBE_ARMS, parseProbeArgs, planProbe, runProbe } from '../helper/egdesk-pure-engine-probe.mjs'

const { options, problems } = parseProbeArgs(process.argv.slice(2), process.env)
if (problems.length) { console.error(problems.join('\n')); console.error(`arms: ${PROBE_ARMS.join(', ')}`); process.exit(2) }
const plan = planProbe(options)
console.log(JSON.stringify(plan, null, 2))
if (options.mode !== 'run') { console.log('dry run: add --run to start the app-servers'); process.exit(0) }
const out = await runProbe(options)
for (const row of out.summary) console.log(JSON.stringify(row))
console.log(`records: ${options.out}/pure-engine-probe.json`)
process.exit(out.summary.every(r => r.ok) ? 0 : 1)
