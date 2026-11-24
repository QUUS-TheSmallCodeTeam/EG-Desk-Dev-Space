#!/usr/bin/env node
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { BOARD_REPLY_PLAN_DIR, buildBoardReplyPlan } from '../helper/egdesk-board-reply-real-plan.mjs'

// The Board reply screening measurement plan (declarative format of scripts/egdesk-decision-real-measure.mjs). Sends nothing, reads no key.
//   node scripts/egdesk-board-reply-real-plan.mjs            # rebuild with the product code and compare with the committed files
//   node scripts/egdesk-board-reply-real-plan.mjs --write    # write plan.json and requests/<id>.json
// Exit codes: 0 the committed plan is what the product builds today (or it was written), 1 it differs.
const dir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', BOARD_REPLY_PLAN_DIR)
const write = process.argv.includes('--write')
const built = await buildBoardReplyPlan()
const files = [['plan.json', built.planBytes], ...built.requests.map(r => [r.file, r.bytes])]
let differs = 0
for (const [name, bytes] of files) {
  const target = path.join(dir, name)
  if (write) { mkdirSync(path.dirname(target), { recursive: true }); writeFileSync(target, bytes) }
  else { let same = false; try { same = readFileSync(target).equals(bytes) } catch { same = false } if (!same) { differs++; console.log(`differs: ${name}`) } }
}
for (const [n, r] of built.requests.entries()) console.log(`${r.id}  bytes=${r.bytes.length}  predicates=${r.body.questions.length}  est=${built.plan.requests[n].estInputTokens}  sha256=${built.plan.requests[n].sha256.slice(0, 12)}  local=[${r.localSelection}]  ifAsExpected=[${r.forcedSelection}]`)
console.log(`${write ? 'written' : differs ? 'DIFFERS' : 'matches'}: ${files.length} files, est input tokens ${built.plan.requests.reduce((sum, r) => sum + r.estInputTokens, 0)} of ceiling ${built.plan.tokenCeiling}; nothing was sent`)
process.exitCode = differs ? 1 : 0
