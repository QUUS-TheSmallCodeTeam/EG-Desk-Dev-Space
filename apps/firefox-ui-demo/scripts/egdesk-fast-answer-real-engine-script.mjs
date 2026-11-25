#!/usr/bin/env node
// L1 c31: write / compare the fast-answer conversation script for lane L5's real-engine check. Sends nothing, starts nothing.
//   node scripts/egdesk-fast-answer-real-engine-script.mjs           # compare with the committed file
//   node scripts/egdesk-fast-answer-real-engine-script.mjs --write   # write scripts/real-engine/scripts/real-engine-memory-fast-answer-v1.json
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { FAST_ANSWER_SET, buildFastAnswerScript } from '../helper/egdesk-fast-answer-real-engine-script.mjs'

const dir = path.join(path.dirname(fileURLToPath(import.meta.url)), 'real-engine', 'scripts')
export const SCRIPT_FILE = path.join(dir, `${FAST_ANSWER_SET}.json`)
export const scriptBytes = () => Buffer.from(`${JSON.stringify(buildFastAnswerScript(), null, 2)}\n`)
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv.includes('--write')) { mkdirSync(dir, { recursive: true }); writeFileSync(SCRIPT_FILE, scriptBytes()); console.log(`written ${path.basename(SCRIPT_FILE)}`); process.exit(0) }
  let same = false
  try { same = readFileSync(SCRIPT_FILE).equals(scriptBytes()) } catch { same = false }
  console.log(same ? `matches ${path.basename(SCRIPT_FILE)}` : `DIFFERS ${path.basename(SCRIPT_FILE)}: run with --write`)
  process.exit(same ? 0 : 1)
}
