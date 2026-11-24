#!/usr/bin/env node
// c22: the real-engine check (helper/egdesk-real-engine-check.mjs). DRY by default: it prints what would run and starts nothing.
// --run starts one Codex app-server per conversation from --codex-bin (the person's Codex login through --person-home, or a home given by
// --codex-home) and drives EG-Desk's real chat runtime with own tools on, ephemeral threads only. Exit: 0 all checks passed, 1 a check
// failed or a conversation aborted, 2 usage or preflight problem.
import { HELP, formatPlan, loadScripts, parseArgs, planRun, preflight, runCheck } from '../helper/egdesk-real-engine-check.mjs'

async function main(argv) {
  let options
  try { options = parseArgs(argv, process.env) } catch (error) { console.error(`${error.message}\n\n${HELP}`); return 2 }
  if (options.help) { console.log(HELP); return 0 }
  let scripts
  try { scripts = loadScripts(options.scripts) } catch (error) { console.error(error.message); return 2 }
  const problems = preflight(options, scripts)
  const plan = planRun(options, scripts)
  if (options.mode === 'dry') {
    console.log(options.json ? JSON.stringify({ plan, warnings: problems }, null, 2) : formatPlan(plan, problems))
    return 0
  }
  if (problems.length) { console.error(`not started:\n  ${problems.join('\n  ')}`); return 2 }
  if (!options.json) console.log(formatPlan(plan))
  const result = await runCheck(options, scripts)
  console.log(options.json ? JSON.stringify(result.summary, null, 2) : [`records: ${options.out}/records`, ...result.summary.conversations.map(c => `${c.ok ? 'ok  ' : 'FAIL'} ${c.set}/${c.id}  turns=${c.turns}  ${c.aborted ? `aborted=${c.aborted}  ` : ''}${c.failedChecks.length ? `failed=${c.failedChecks.join(',')}  ` : ''}${c.totalMs} ms`)].join('\n'))
  return result.ok ? 0 : 1
}

process.exitCode = await main(process.argv.slice(2))
