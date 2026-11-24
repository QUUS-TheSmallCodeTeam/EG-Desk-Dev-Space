#!/usr/bin/env node
import { mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { BOARD_REPLY_PLAN_DIR, buildBoardReplyPlan } from '../helper/egdesk-board-reply-real-plan.mjs'
import { PLACEMENT_PLAN_DIR, buildPlacementPlan } from '../helper/egdesk-work-placement-real-plan.mjs'

// Lane L1's real-measurement plans (declarative format of scripts/egdesk-decision-real-measure.mjs): Board reply screening and work placement.
// Sends nothing, reads no key.
//   node scripts/egdesk-board-reply-real-plan.mjs            # rebuild both with the product code and compare with the committed files
//   node scripts/egdesk-board-reply-real-plan.mjs --write    # write plan.json and requests/<id>.json (stale request files are removed)
// Exit codes: 0 the committed plans are what the product builds today (or they were written), 1 they differ.
const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..')
const write = process.argv.includes('--write')
let differs = 0
for (const [dirName, build] of [[BOARD_REPLY_PLAN_DIR, buildBoardReplyPlan], [PLACEMENT_PLAN_DIR, buildPlacementPlan]]) {
  const dir = path.join(root, dirName), built = await build()
  const files = [['plan.json', built.planBytes], ...built.requests.map(r => [r.file, r.bytes])]
  if (write) { rmSync(path.join(dir, 'requests'), { recursive: true, force: true }); for (const [name, bytes] of files) { mkdirSync(path.dirname(path.join(dir, name)), { recursive: true }); writeFileSync(path.join(dir, name), bytes) } }
  else {
    for (const [name, bytes] of files) { let same = false; try { same = readFileSync(path.join(dir, name)).equals(bytes) } catch { same = false } if (!same) { differs++; console.log(`differs: ${dirName}/${name}`) } }
    let extra = []; try { extra = readdirSync(path.join(dir, 'requests')).filter(f => !built.requests.some(r => r.file === `requests/${f}`)) } catch { extra = [] }
    for (const f of extra) { differs++; console.log(`stale: ${dirName}/requests/${f}`) }
  }
  for (const [n, r] of built.requests.entries()) console.log(`${built.plan.set}  ${r.id}  bytes=${r.bytes.length}  predicates=${r.body.questions.length}  est=${built.plan.requests[n].estInputTokens}  sha256=${built.plan.requests[n].sha256.slice(0, 12)}  hard=${built.plan.requests[n].expect.filter(e => e.severity === 'hard').length}  soft=${built.plan.requests[n].expect.filter(e => e.severity === 'soft').length}`)
  console.log(`${built.plan.set}: ${write ? 'written' : differs ? 'DIFFERS' : 'matches'}: ${files.length} files, est input tokens ${built.plan.requests.reduce((sum, r) => sum + r.estInputTokens, 0)} of ceiling ${built.plan.tokenCeiling}; nothing was sent`)
}
process.exitCode = differs ? 1 : 0
