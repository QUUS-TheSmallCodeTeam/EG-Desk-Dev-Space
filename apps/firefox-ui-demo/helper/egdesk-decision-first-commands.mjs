// c32 (owner direction U13, "끼릭끼릭 탁탁"): the decision model takes over what it can; the engine only writes. The COMMAND path, a prototype behind EGDESK_DECISION_FIRST=on (default off):
// when the person asks to run something ("테스트 돌려줘", "빌드해 봐", "git 상태 봐줘"), CODE builds the options from the folder (package.json script names, a test folder, git), the Decision
// model picks one with one choice question (a "none of these" value is part of it: a request to write or change something, or a question, is the engine's), and below the choice threshold
// the engine is called exactly as today. EG-Desk's own runner then executes the picked command under the existing approval rules (rule floor first; the gate inside the executor again),
// and the run-conditions arbiter reads the result. A healthy result ends the turn with no engine call; a failure, a command that needs the person, or a result nobody can read goes to the
// engine WITH the result as context, so it explains or fixes without a tool call.
// Only fixed command forms are ever offered (never a command the person typed, never a script body): npm test / npm run <name>, node --test, git status, git diff --stat, git log --oneline -n 10,
// and (c35) git merge <branch> for an existing local branch the person's message names (the executor's gate still decides whether the person must approve it first).
import path from 'node:path'
import fs from 'node:fs'
import { choiceQuestion, decisionThresholds, readChoice } from './egdesk-decision-questions.mjs'

export const DECISION_FIRST_PICK = 'df_pick'
export const DECISION_FIRST_LIMITS = Object.freeze({ options: 12, merges: 4, branches: 64, messageChars: 600, timeoutMs: 2500, scriptNameChars: 40 })
// script names that are a finite check or build (never a server or a watcher: those do not end)
const SAFE_SCRIPTS = Object.freeze(['test', 'build', 'lint', 'typecheck', 'check', 'format:check', 'test:unit', 'test:ci', 'compile'])
const SCRIPT_NAME = /^[a-z][a-z0-9:_-]{0,39}$/

// c35: a branch name is offered in a command only in the plain form git itself uses for most branches (no leading dash, no "..", no spaces or shell characters)
const BRANCH_NAME = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,60}$/
const safeBranch = name => BRANCH_NAME.test(name) && !name.includes('..') && !name.includes('//') && !name.endsWith('/') && !name.endsWith('.lock') && !name.endsWith('.')

/** The repo state from the files only (no process): { branch (current or null), branches (local, sorted), merging (a merge is in progress) } or null when the folder has no plain .git directory (a worktree's .git file is not read). */
export function readGitState(root, { fsApi = fs } = {}) {
  const git = path.join(root, '.git')
  try { if (!fsApi.statSync(git).isDirectory()) return null } catch { return null }
  const read = p => { try { return fsApi.readFileSync(path.join(git, p), 'utf8') } catch { return null } }
  const head = (read('HEAD') ?? '').trim(), branch = head.startsWith('ref: refs/heads/') ? head.slice('ref: refs/heads/'.length) : null
  const names = new Set(), walk = (rel, depth) => {
    let entries = []
    try { entries = fsApi.readdirSync(path.join(git, rel), { withFileTypes: true }) } catch { return }
    for (const e of entries) {
      if (names.size >= DECISION_FIRST_LIMITS.branches) return
      if (e.isDirectory()) { if (depth < 3) walk(path.join(rel, e.name), depth + 1) } else if (e.isFile() && !e.name.endsWith('.lock')) names.add(path.join(rel, e.name).slice('refs/heads/'.length).split(path.sep).join('/'))
    }
  }
  walk(path.join('refs', 'heads'), 0)
  for (const line of (read('packed-refs') ?? '').split('\n')) { const m = /^[0-9a-f]{40,64} refs\/heads\/(.+)$/.exec(line.trim()); if (m && names.size < DECISION_FIRST_LIMITS.branches) names.add(m[1]) }
  const branches = [...names].filter(safeBranch).sort()
  let merging = false; try { fsApi.statSync(path.join(git, 'MERGE_HEAD')); merging = true } catch { merging = false }
  return { branch: branch && safeBranch(branch) ? branch : null, branches, merging }
}

/** Does the person's message name this branch? The name stands alone (not inside a longer word of the same characters); a Korean particle after it is fine. */
export function namesBranch(message, name) {
  const text = String(message ?? '').toLowerCase(), needle = String(name).toLowerCase(), word = /[a-z0-9._/-]/
  for (let at = text.indexOf(needle); at !== -1; at = text.indexOf(needle, at + 1)) {
    if ((at === 0 || !word.test(text[at - 1])) && (at + needle.length >= text.length || !word.test(text[at + needle.length]))) return true
  }
  return false
}

/**
 * The options for a folder, from files only (no process): [{ id, kind, command, what }]; `what` is a closed English description for the Decision model.
 * c35: with a git repo, `git merge <branch>` is offered for the existing LOCAL branches (not the current one) that the person's message names, never while a merge is already in progress.
 */
export function buildCommandOptions(root, { fsApi = fs, message = '' } = {}) {
  const options = [], add = (kind, command, what) => { if (kind === 'git-merge' || options.length < DECISION_FIRST_LIMITS.options) options.push({ id: `o${options.length + 1}`, kind, command, what }) }
  const read = p => { try { return fsApi.readFileSync(path.join(root, p), 'utf8') } catch { return null } }
  const exists = p => { try { fsApi.statSync(path.join(root, p)); return true } catch { return false } }
  let scripts = {}
  try { const pkg = JSON.parse(read('package.json') ?? 'null'); if (pkg && typeof pkg.scripts === 'object' && !Array.isArray(pkg.scripts)) scripts = pkg.scripts } catch { /* no package.json */ }
  const names = SAFE_SCRIPTS.filter(n => Object.hasOwn(scripts, n) && typeof scripts[n] === 'string' && SCRIPT_NAME.test(n))
  for (const name of names) add('script', name === 'test' ? 'npm test' : `npm run ${name}`, name === 'test' ? 'run the project\'s tests (npm test)' : `run the project's "${name}" script (npm run ${name})`)
  if (!names.includes('test') && (exists('test') || exists('tests'))) add('test', 'node --test', 'run the tests of the project (node --test)')
  if (exists('.git')) {
    add('git', 'git status', 'show the git status of the project (git status)'); add('git', 'git diff --stat', 'show which files changed, with line counts (git diff --stat)'); add('git', 'git log --oneline -n 10', 'show the last ten commits (git log)')
    const state = readGitState(root, { fsApi })
    if (state && !state.merging) for (const name of state.branches.filter(b => b !== state.branch && namesBranch(message, b)).slice(0, DECISION_FIRST_LIMITS.merges)) add('git-merge', `git merge ${name}`, `merge the local branch "${name}" into the current branch${state.branch ? ` "${state.branch}"` : ''} (git merge ${name})`)
  }
  return options
}

const RULES = 'You choose which of a short list of fixed actions a person asked an assistant to run now. Answer from the person\'s message only. Choose "none" when the message asks for anything else: to write, change, fix, explain or plan something, a question about whether or how to do an action, a request about something not on the list, or when it is unclear. A listed action may change the repository (a merge): choose it only when the person asks for exactly that action to be done now.'
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
    else if (/^\s*git\s/.test(String(command ?? '')) && (worktree?.state === 'clean' || worktree?.state === 'uncommitted_work')) lines.push(worktree.state === 'clean' ? 'Git status after the command: the working tree is clean.' : `Git status after the command: ${Number.isSafeInteger(worktree.uncommitted) ? worktree.uncommitted : 'some'} changed tracked files, ${Number.isSafeInteger(worktree.untracked) ? worktree.untracked : 'some'} untracked files.`)
    const t = String(tail ?? '').replace(/\r/g, '').trimEnd()
    if (t) lines.push('Last lines of its output:', t.length > 1200 ? `…${t.slice(-1200)}` : t)
  }
  return lines.join('\n')
}
