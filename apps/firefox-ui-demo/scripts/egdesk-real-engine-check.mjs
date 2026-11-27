#!/usr/bin/env node
// c22: the real-engine check (helper/egdesk-real-engine-check.mjs). DRY by default: it prints what would run and starts nothing.
// --run starts one Codex app-server per conversation from --codex-bin (the person's Codex login through --person-home, or a home given by
// --codex-home) and drives EG-Desk's real chat runtime with own tools on, ephemeral threads only. Exit: 0 all checks passed, 1 a check
// failed or a conversation aborted, 2 usage or preflight problem.
// c24: --persisted-with-cleanup (persisted threads, each deleted with thread/delete and verified gone; refuses to start when that cannot be guaranteed)
// and --cleanup-leftovers (removes what a killed earlier run left, from <out>/created-threads.jsonl).
import { stallLine } from '../helper/egdesk-engine-stall.mjs'
import { HELP, LEDGER_FILE, cleanupLeftovers, createLedger, formatPlan, leftoverThreads, loadScripts, parseArgs, planRun, preflight, runCheck } from '../helper/egdesk-real-engine-check.mjs'

async function main(argv) {
  let options
  try { options = parseArgs(argv, process.env) } catch (error) { console.error(`${error.message}\n\n${HELP}`); return 2 }
  if (options.help) { console.log(HELP); return 0 }
  if (options.cleanupLeftovers) {
    const ledger = createLedger(options.out), left = leftoverThreads(ledger.read())
    if (options.mode !== 'run') { console.log(`DRY: ${left.length} persisted thread(s) in ${ledger.file} are not verified gone${left.length ? `: ${left.join(', ')}` : ''}. Add --run to delete them.`); return 0 }
    const result = await cleanupLeftovers(options)
    console.log(options.json ? JSON.stringify(result, null, 2) : `leftovers ${result.leftovers}: deleted ${result.deleted}, already gone ${result.alreadyGone ?? 0}, verified gone ${result.verifiedGone}${result.failures.length ? `, FAILED ${result.failures.map(f => `${f.id} (${f.step}: ${f.error})`).join('; ')}` : ''}`)
    return result.failures.length ? 1 : 0
  }
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
  let result
  try { result = await runCheck(options, scripts) } catch (error) {
    if (error?.code === 'cleanup_not_guaranteed' || error?.code === 'agent_room_needs_persisted') { console.error(`not started: ${error.message}`); return 2 }
    throw error
  }
  const lines = result.summary.conversations.map(c => `${c.ok ? 'ok  ' : 'FAIL'} ${c.set}/${c.id}  turns=${c.turns}  ${c.aborted ? `aborted=${c.aborted}  ` : ''}${c.failedChecks.length ? `failed=${c.failedChecks.join(',')}  ` : ''}${c.cleanup ? `cleanup=${c.cleanup.verifiedGone}/${c.cleanup.persisted} gone${c.cleanup.failures ? ` (${c.cleanup.failures} FAILED)` : ''}  ` : ''}${c.totalMs} ms`)
  if (options.engine === 'claude' && !options.json) {
    const sm = result.summary
    if (sm.notApplicable?.length) lines.push(`not applicable (skipped, not failed): ${sm.notApplicable.map(n => `${n.set}/${n.id} (${n.features.join('; ')})`).join(', ')}`)
    lines.push(sm.stoppedBy ? `STOPPED: ${sm.stoppedBy.reason}${sm.stoppedBy.before ? ` before ${sm.stoppedBy.before}` : sm.stoppedBy.inside ? ` inside ${sm.stoppedBy.inside}` : ''} (conversations run: ${sm.usageGuard.ran})` : `conversations run: ${sm.usageGuard.ran}, guard stop at ${sm.usageGuard.stopAtPercent}%: not reached`)
  }
  const dirty = options.engine === 'claude' ? [] : leftoverThreads(createLedger(options.out).read())
  console.log(options.json ? JSON.stringify(result.summary, null, 2) : [`records: ${options.out}/records`, ...lines, ...(options.stallWatchdogMs || result.summary.stalls?.stalls ? [stallLine(result.summary.stalls)] : [])].join('\n'))
  if (options.persisted && dirty.length) console.error(`CLEANUP FAILED: ${dirty.length} persisted thread(s) are not verified gone (${dirty.join(', ')}); listed in ${options.out}/${LEDGER_FILE}. Run again with --cleanup-leftovers --run before anything else.`)
  return result.ok ? 0 : 1
}

process.exitCode = await main(process.argv.slice(2))
