#!/usr/bin/env node
// L1 cycle 27: write / compare the collaboration conversation script for lane L5's real-engine check. Sends nothing, starts nothing.
//   node scripts/egdesk-collab-real-engine-script.mjs           # compare with the committed file
//   node scripts/egdesk-collab-real-engine-script.mjs --write   # write scripts/real-engine/scripts/real-engine-collab-v1.json
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { COLLAB_SET, buildCollabScript } from '../helper/egdesk-collab-real-engine-script.mjs'

export const SCRIPT_FILE = path.join(path.dirname(fileURLToPath(import.meta.url)), 'real-engine', 'scripts', `${COLLAB_SET}.json`)
export const scriptBytes = () => Buffer.from(`${JSON.stringify(buildCollabScript(), null, 2)}\n`)
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv.includes('--write')) { mkdirSync(path.dirname(SCRIPT_FILE), { recursive: true }); writeFileSync(SCRIPT_FILE, scriptBytes()); console.log(`written ${path.basename(SCRIPT_FILE)}`); process.exit(0) }
  let same = false
  try { same = readFileSync(SCRIPT_FILE).equals(scriptBytes()) } catch { same = false }
  console.log(same ? `matches ${path.basename(SCRIPT_FILE)}` : `DIFFERS ${path.basename(SCRIPT_FILE)}: run with --write`)
  process.exit(same ? 0 : 1)
}
