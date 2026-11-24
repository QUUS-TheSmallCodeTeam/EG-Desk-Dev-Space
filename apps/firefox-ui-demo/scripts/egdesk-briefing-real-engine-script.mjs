#!/usr/bin/env node
// L4 cycle 30: write / compare the conversation script for lane L5's real-engine check. Sends nothing, starts nothing.
//   node scripts/egdesk-briefing-real-engine-script.mjs           # compare with the committed file
//   node scripts/egdesk-briefing-real-engine-script.mjs --write   # write scripts/real-engine/scripts/real-engine-briefing-progress-v1.json
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { PROGRESS_SET, buildProgressScript } from '../helper/egdesk-briefing-real-engine-script.mjs'

export const SCRIPT_FILE = path.join(path.dirname(fileURLToPath(import.meta.url)), 'real-engine', 'scripts', `${PROGRESS_SET}.json`)
export const scriptBytes = () => Buffer.from(`${JSON.stringify(buildProgressScript(), null, 2)}\n`)
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const bytes = scriptBytes()
  if (process.argv.includes('--write')) { mkdirSync(path.dirname(SCRIPT_FILE), { recursive: true }); writeFileSync(SCRIPT_FILE, bytes); console.log(`written ${path.basename(SCRIPT_FILE)}`) }
  else { let same = false; try { same = readFileSync(SCRIPT_FILE).equals(bytes) } catch { same = false } console.log(same ? `matches ${path.basename(SCRIPT_FILE)}` : `DIFFERS ${path.basename(SCRIPT_FILE)}`); process.exit(same ? 0 : 1) }
}
