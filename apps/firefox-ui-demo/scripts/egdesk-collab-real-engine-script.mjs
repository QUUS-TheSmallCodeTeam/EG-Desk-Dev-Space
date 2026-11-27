#!/usr/bin/env node
// L1 cycles 27 and 29: write / compare the collaboration conversation scripts for lane L5's real-engine check. Sends nothing, starts nothing.
//   node scripts/egdesk-collab-real-engine-script.mjs           # compare with the committed files (collab-v1: one room; collab-restart-v1: the same room across a restart)
//   node scripts/egdesk-collab-real-engine-script.mjs --write   # write scripts/real-engine/scripts/real-engine-collab-v1.json and real-engine-collab-restart-v1.json
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { COLLAB_RESTART_SET, COLLAB_SET, COLLAB_TWO_RUNS_SET, buildCollabRestartScript, buildCollabScript, buildCollabTwoRunsScript } from '../helper/egdesk-collab-real-engine-script.mjs'

const dir = path.join(path.dirname(fileURLToPath(import.meta.url)), 'real-engine', 'scripts')
export const SCRIPT_FILE = path.join(dir, `${COLLAB_SET}.json`), RESTART_FILE = path.join(dir, `${COLLAB_RESTART_SET}.json`), TWO_RUNS_FILE = path.join(dir, `${COLLAB_TWO_RUNS_SET}.json`)
const bytes = script => Buffer.from(`${JSON.stringify(script, null, 2)}\n`)
export const scriptBytes = () => bytes(buildCollabScript()), restartScriptBytes = () => bytes(buildCollabRestartScript()), twoRunsScriptBytes = () => bytes(buildCollabTwoRunsScript())
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  let differs = 0
  for (const [file, make] of [[SCRIPT_FILE, scriptBytes], [RESTART_FILE, restartScriptBytes], [TWO_RUNS_FILE, twoRunsScriptBytes]]) {
    if (process.argv.includes('--write')) { mkdirSync(dir, { recursive: true }); writeFileSync(file, make()); console.log(`written ${path.basename(file)}`); continue }
    let same = false
    try { same = readFileSync(file).equals(make()) } catch { same = false }
    if (!same) differs++
    console.log(same ? `matches ${path.basename(file)}` : `DIFFERS ${path.basename(file)}: run with --write`)
  }
  process.exit(differs ? 1 : 0)
}
