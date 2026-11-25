// c32 (owner direction U13, "끼릭끼릭 탁탁"): the decision model takes over what it can; the engine only writes. The COMMAND path, a prototype behind EGDESK_DECISION_FIRST=on (default off):
// when the person asks to run something ("테스트 돌려줘", "빌드해 봐", "git 상태 봐줘"), CODE builds the options from the folder (package.json script names, a test folder, git), the Decision
// model picks one with one choice question (a "none of these" value is part of it: a request to write or change something, or a question, is the engine's), and below the choice threshold
// the engine is called exactly as today. EG-Desk's own runner then executes the picked command under the existing approval rules (rule floor first; the gate inside the executor again),
// and the run-conditions arbiter reads the result. A healthy result ends the turn with no engine call; a failure, a command that needs the person, or a result nobody can read goes to the
// engine WITH the result as context, so it explains or fixes without a tool call.
// Only fixed command forms are ever offered (never a command the person typed, never a script body): npm test / npm run <name>, node --test, git status, git diff --stat, git log --oneline -n 10.
import path from 'node:path'
import fs from 'node:fs'
import { choiceQuestion, decisionThresholds, readChoice } from './egdesk-decision-questions.mjs'

export const DECISION_FIRST_PICK = 'df_pick'
export const DECISION_FIRST_LIMITS = Object.freeze({ options: 8, messageChars: 600, timeoutMs: 2500, scriptNameChars: 40 })
// script names that are a finite check or build (never a server or a watcher: those do not end)
const SAFE_SCRIPTS = Object.freeze(['test', 'build', 'lint', 'typecheck', 'check', 'format:check', 'test:unit', 'test:ci', 'compile'])
const SCRIPT_NAME = /^[a-z][a-z0-9:_-]{0,39}$/

/** The options for a folder, from files only (no process): [{ id, kind, command, what }]; `what` is a closed English description for the Decision model. */
export function buildCommandOptions(root, { fsApi = fs } = {}) {
  const options = [], add = (kind, command, what) => { if (options.length < DECISION_FIRST_LIMITS.options) options.push({ id: `o${options.length + 1}`, kind, command, what }) }
  const read = p => { try { return fsApi.readFileSync(path.join(root, p), 'utf8') } catch { return null } }
  const exists = p => { try { fsApi.statSync(path.join(root, p)); return true } catch { return false } }
  let scripts = {}
  try { const pkg = JSON.parse(read('package.json') ?? 'null'); if (pkg && typeof pkg.scripts === 'object' && !Array.isArray(pkg.scripts)) scripts = pkg.scripts } catch { /* no package.json */ }
  const names = SAFE_SCRIPTS.filter(n => Object.hasOwn(scripts, n) && typeof scripts[n] === 'string' && SCRIPT_NAME.test(n))
  for (const name of names) add('script', name === 'test' ? 'npm test' : `npm run ${name}`, name === 'test' ? 'run the project\'s tests (npm test)' : `run the project's "${name}" script (npm run ${name})`)
  if (!names.includes('test') && (exists('test') || exists('tests'))) add('test', 'node --test', 'run the tests of the project (node --test)')
  if (exists('.git')) {
    add('git', 'git status', 'show the git status of the project (git status)'); add('git', 'git diff --stat', 'show which files changed, with line counts (git diff --stat)'); add('git', 'git log --oneline -n 10', 'show the last ten commits (git log)')
  }
  return options
}

const RULES = 'You choose which of a short list of fixed actions a person asked an assistant to run now. Answer from the person\'s message only. Choose "none" when the message asks for anything else: to write, change, fix, explain or plan something, a question, a request about something not on the list, or when it is unclear.'
/** The request for the Decision model: one choice question over the options and "none". */
export function pickRequest(message, options) {
  const text = String(message ?? '').replace(/\s+/g, ' ').trim().slice(0, DECISION_FIRST_LIMITS.messageChars)
  const choices = [...options.map(o => ({ value: o.id, description: o.what })), { value: 'none', description: 'the person does not ask to run any of the listed actions now' }]
  return { input: [{ role: 'developer', content: RULES }, { role: 'user', content: `The person wrote:\n"""\n${text}\n"""` }],
    questions: [choiceQuestion(DECISION_FIRST_PICK, 'Which action does the person ask to run now?', choices)] }
}

/** → { status: 'picked', option, confidence, margin } | { status: 'engine', reason: 'no_options' | 'unreachable' | 'none' | 'below_threshold' } */
export async function decidePick({ client, message, options, thresholds, timeoutMs = DECISION_FIRST_LIMITS.timeoutMs, signal } = {}) {
  if (!Array.isArray(options) || !options.length) return { status: 'engine', reason: 'no_options' }
  if (!client || typeof client.decide !== 'function' || typeof message !== 'string' || !message.trim()) return { status: 'engine', reason: 'unreachable' }
  const t = decisionThresholds(thresholds)
  let result
  try { result = await client.decide({ ...pickRequest(message, options), timeoutMs, signal, promptCacheKey: 'decision-first-commands' }) } catch { return { status: 'engine', reason: 'unreachable' } }
  const read = readChoice(result?.answers, DECISION_FIRST_PICK, { minConfidence: t.choice, minMargin: t.margin })
  if (read.state !== 'accepted') return { status: 'engine', reason: 'below_threshold', confidence: read.confidence, margin: read.margin }
  if (read.value === 'none') return { status: 'engine', reason: 'none', confidence: read.confidence, margin: read.margin }
  const option = options.find(o => o.id === read.value)
  return option ? { status: 'picked', option, confidence: read.confidence, margin: read.margin } : { status: 'engine', reason: 'below_threshold' }
}

/** The result as context for the engine when it must explain or fix (facts only, no instruction beyond what it needs to know). */
export const COMMAND_RESULT_KEY = 'egdesk_command_result'
export function commandResultBlock({ command, status, exitCode = null, durationMs = null, health = null, tests = null, worktree = null, tail = '' } = {}) {
  const lines = ['EG-Desk already ran this command for the person\'s message, with its own runner, before your turn; its result is below, so you need no tool call to see it.', `Command: \`${String(command ?? '').slice(0, 300)}\``]
  if (status === 'needs_person') lines.push('It was NOT run: it needs the person\'s approval first.')
  else if (status === 'stopped') lines.push('It was stopped before it finished.')
  else {
    lines.push(`It finished${Number.isFinite(durationMs) ? ` in ${(durationMs / 1000).toFixed(1)} s` : ''} with exit code ${exitCode ?? 'unknown'}${health ? `; EG-Desk's reading of the result: ${health}` : ''}.`)
    if (tests) lines.push(`Its test runner counted ${tests.passed} passed, ${tests.failed} failed${Number.isSafeInteger(tests.total) ? `, ${tests.total} in total` : ''}.`)
    if (worktree?.state === 'conflict') lines.push(`Git status reports files in conflict${worktree.files?.length ? `: ${worktree.files.join(', ')}` : ''}.`)
    const t = String(tail ?? '').replace(/\r/g, '').trimEnd()
    if (t) lines.push('Last lines of its output:', t.length > 1200 ? `…${t.slice(-1200)}` : t)
  }
  return lines.join('\n')
}
