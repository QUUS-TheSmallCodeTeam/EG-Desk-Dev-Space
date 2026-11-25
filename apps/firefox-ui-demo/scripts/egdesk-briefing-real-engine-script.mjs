#!/usr/bin/env node
// L4 cycle 30: write / compare the conversation script for lane L5's real-engine check. Sends nothing, starts nothing.
//   node scripts/egdesk-briefing-real-engine-script.mjs           # compare with the committed files (v1: the answer; v2: the board-design turn)
//   node scripts/egdesk-briefing-real-engine-script.mjs --write   # write scripts/real-engine/scripts/real-engine-briefing-progress-v1.json and -v2.json
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { BOARD_SET, LOOP_HANDED_SET, LOOP_SET, PROGRESS_SET, buildBoardScript, buildLoopHandedScript, buildLoopScript, buildProgressScript } from '../helper/egdesk-briefing-real-engine-script.mjs'

const dir = path.join(path.dirname(fileURLToPath(import.meta.url)), 'real-engine', 'scripts')
export const SCRIPT_FILE = path.join(dir, `${PROGRESS_SET}.json`), BOARD_FILE = path.join(dir, `${BOARD_SET}.json`), LOOP_FILE = path.join(dir, `${LOOP_SET}.json`), LOOP_HANDED_FILE = path.join(dir, `${LOOP_HANDED_SET}.json`)
const bytes = script => Buffer.from(`${JSON.stringify(script, null, 2)}\n`)
export const scriptBytes = () => bytes(buildProgressScript()), boardScriptBytes = () => bytes(buildBoardScript()), loopScriptBytes = () => bytes(buildLoopScript()), loopHandedScriptBytes = () => bytes(buildLoopHandedScript())
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  let differs = 0
  for (const [file, make] of [[SCRIPT_FILE, scriptBytes], [BOARD_FILE, boardScriptBytes], [LOOP_FILE, loopScriptBytes], [LOOP_HANDED_FILE, loopHandedScriptBytes]]) {
    if (process.argv.includes('--write')) { mkdirSync(path.dirname(file), { recursive: true }); writeFileSync(file, make()); console.log(`written ${path.basename(file)}`) }
    else { let same = false; try { same = readFileSync(file).equals(make()) } catch { same = false } if (!same) differs++; console.log(same ? `matches ${path.basename(file)}` : `DIFFERS ${path.basename(file)}`) }
  }
  process.exit(differs ? 1 : 0)
}
