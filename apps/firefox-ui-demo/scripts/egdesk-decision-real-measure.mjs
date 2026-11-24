#!/usr/bin/env node
import { main } from '../helper/egdesk-decision-real-runner.mjs'

// Generic real-measurement runner for one declarative Decisions plan (see helper/egdesk-decision-real-runner.mjs for the format and rules).
//   node scripts/egdesk-decision-real-measure.mjs <plan.json>                                   # dry run: validates and prints, sends nothing
//   OPENAI_API_KEY=... node scripts/egdesk-decision-real-measure.mjs <plan.json> --send --out results.json   # real, after approval
// Exit codes: 0 done, 2 the plan was refused (nothing sent), 3 no key (nothing sent), 4 the run stopped (failure or token ceiling).
// The key is read from OPENAI_API_KEY only and is never printed or written. No retries; the first failure stops the run.
process.exitCode = await main(process.argv.slice(2), { env: process.env })
