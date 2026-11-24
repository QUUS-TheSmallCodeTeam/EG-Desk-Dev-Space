import path from 'node:path'
import { decisionThresholds, scoreQuestion } from './egdesk-decision-questions.mjs'

// Contextual safety gate for a command, before it runs (JEV Pillar 3).
//   1. Rules (the floor) are deterministic and always win: a rule that requires approval requires it whatever the model says.
//   2. Only a command with a destructive verb and no rule-required approval is scored by the Decision model, from context the
//      RUNTIME supplies (cwd, what each target is in git, the stated intent). Plain commands make zero Decision requests.
//   3. The score can only ADD an approval. It never removes one a rule required, and it never replaces the engine's own approval
//      policy (that policy still runs for whatever this gate lets through).
//   Mode off, a failed call, no budget, or no consent for the context text: the floor alone decides (today's behaviour).
export const COMMAND_GATE_REASONS = Object.freeze(['unresolved_target', 'protected_target', 'outside_cwd', 'tracked_files', 'dirty_worktree',
  'remote_irreversible', 'privileged', 'remote_script', 'risk_score', 'risk_unsure'])
export const RISK_LEVELS = Object.freeze([
  { label: 'negligible', description: 'Easily regenerated or disposable data only (build output, dependency folders, caches).' },
  { label: 'low', description: 'Small, local, recoverable effect.' },
  { label: 'moderate', description: 'Could lose some work that is recoverable with effort.' },
  { label: 'high', description: 'Likely to destroy source files, uncommitted work, or data that is hard to recover.' },
  { label: 'critical', description: 'Irreversible loss of important data or system damage.' },
])
export const COMMAND_GATE_TIMEOUT_MS = 4000
const RISK_BAR = 2.5 // on the 0..4 level scale: between moderate and high

function tokenize(command) {
  const segments = [[]]
  let token = '', quote = null, has = false
  const push = () => { if (has) segments.at(-1).push(token); token = ''; has = false }
  for (let i = 0; i < command.length; i++) {
    const c = command[i]
    if (quote) { if (c === quote) quote = null; else token += c; continue }
    if (c === '"' || c === "'") { quote = c; has = true; continue }
    if (/\s/.test(c)) { push(); continue }
    if (c === ';' || c === '|' || c === '&') { push(); if (command[i + 1] === c) i++; segments.push([]); continue }
    token += c; has = true
  }
  push()
  return segments.filter(s => s.length)
}

const isFlag = t => /^-[^-]/.test(t) || t.startsWith('--')
const dynamic = t => /[$`]|\$\(/.test(t)

/** The floor + the destructive-verb classification. Pure. `ctx.inspect(absPath)` is the runtime's view of a target. */
export function classifyCommand(command, { cwd, home = '/home/user', inspect = () => ({ exists: true, trackedFiles: 0, ignored: false }), git = { dirty: false } } = {}) {
  const reasons = new Set(), targets = []
  let destructive = false
  const text = String(command ?? '')
  if (/\b(?:curl|wget)\b[^|;&]*\|\s*(?:sudo\s+)?(?:ba|z)?sh\b/.test(text)) reasons.add('remote_script')
  for (const raw of tokenize(text)) {
    const words = [...raw]
    if (words[0] === 'sudo' || words[0] === 'doas') { reasons.add('privileged'); words.shift() }
    const cmd = path.posix.basename(words[0] || ''), args = words.slice(1)
    const rest = args.filter(a => !isFlag(a) || a === '--')
    if (cmd === 'rm' || cmd === 'rmdir' || cmd === 'shred' || cmd === 'unlink') {
      destructive = true
      const recursive = args.some(a => /^-[a-zA-Z]*[rR]/.test(a) || a === '--recursive')
      for (const arg of rest.filter(a => a !== '--')) {
        if (dynamic(arg)) { reasons.add('unresolved_target'); continue }
        const expanded = arg === '~' || arg.startsWith('~/') ? path.posix.join(home, arg.slice(1)) : arg
        const abs = path.posix.resolve(cwd, expanded)
        const globbed = /[*?[]/.test(arg)
        if (globbed && /^(?:\.\/|\/|~\/?)?\*+$/.test(arg)) reasons.add('protected_target')
        const base = globbed ? path.posix.dirname(abs) : abs
        const root = abs === '/' || abs === home || base === '/' || path.posix.dirname(base) === '/' || cwd.startsWith(base + '/') || base === cwd && !globbed
        if (recursive && root) reasons.add('protected_target')
        const inside = base === cwd || base.startsWith(cwd + '/')
        if (!inside) reasons.add('outside_cwd')
        const info = globbed ? { exists: true, trackedFiles: 0, ignored: false, glob: true } : inspect(abs)
        if ((info?.trackedFiles ?? 0) > 0) reasons.add('tracked_files')
        targets.push({ path: inside ? path.posix.relative(cwd, abs) || '.' : '(outside cwd)', exists: info?.exists !== false, kind: info?.kind ?? null,
          trackedFiles: Math.min(info?.trackedFiles ?? 0, 9999), ignored: info?.ignored === true, glob: globbed, insideCwd: inside })
      }
    } else if (cmd === 'git') {
      const sub = args.find(a => !isFlag(a))
      const flags = args.filter(isFlag)
      if (sub === 'reset' && flags.includes('--hard') || sub === 'clean' && flags.some(f => /^-[a-z]*f/.test(f)) || sub === 'checkout' && args.includes('--') || sub === 'restore' && !flags.includes('--staged') || sub === 'branch' && flags.includes('-D')) {
        destructive = true
        if (git.dirty && sub !== 'branch') reasons.add('dirty_worktree')
      }
      if (sub === 'push' && flags.some(f => f === '--force' || f === '-f' || f.startsWith('--force-with-lease') || f === '--delete')) { destructive = true; reasons.add('remote_irreversible') }
    } else if (['dd', 'mkfs', 'truncate', 'kill', 'killall', 'pkill', 'chmod', 'chown'].includes(cmd) || cmd.startsWith('mkfs.')) {
      destructive = true
      if (cmd === 'dd' && args.some(a => a.startsWith('of=/dev/')) || cmd.startsWith('mkfs')) reasons.add('protected_target')
      if ((cmd === 'chmod' || cmd === 'chown') && !args.some(a => /^-[a-zA-Z]*R/.test(a))) destructive = false
    } else if (cmd === 'find' && args.includes('-delete')) { destructive = true; reasons.add('unresolved_target') }
  }
  return { destructive, floor: [...reasons], targets }
}

/**
 * assessCommand({ command, cwd, intent, mode, client, inspect, git, home, thresholds?, timeoutMs?, signal?, calibration?, consent? })
 *  → { approval: boolean, reasons: string[], source: 'rules'|'decision'|'fallback', requests, score? }
 */
export async function assessCommand({ command, cwd, intent = '', mode = 'off', client = null, inspect, git, home, thresholds, timeoutMs = COMMAND_GATE_TIMEOUT_MS,
  signal, calibration = null, consent = () => false } = {}) {
  const { destructive, floor, targets } = classifyCommand(command, { cwd, inspect, git, home })
  if (floor.length) return { approval: true, reasons: floor, source: 'rules', requests: 0 }
  if (!destructive) return { approval: false, reasons: [], source: 'rules', requests: 0 }
  if ((mode !== 'advisory' && mode !== 'on') || !client?.decide || consent() !== true) return { approval: false, reasons: [], source: 'fallback', requests: 0 }
  const th = decisionThresholds(thresholds)
  let answer
  try {
    answer = await client.decide({
      input: [{ role: 'user', content: [{ type: 'input_json', data: { command: String(command).slice(0, 600), working_directory: path.posix.basename(cwd) || '/',
        stated_intent: String(intent).slice(0, 240), targets, git_dirty: git?.dirty === true } }] }],
      questions: [scoreQuestion('terminal_risk', 'How destructive or irreversible is running this command here, given the targets and the stated intent?', RISK_LEVELS)],
      timeoutMs, signal })
  } catch (error) {
    try { calibration?.record?.({ feature: 'terminal_gate', mode, judgments: [], fallback: typeof error?.code === 'string' ? error.code : 'unreachable' }) } catch { /* ignore */ }
    return { approval: false, reasons: [], source: 'fallback', requests: 1 }
  }
  const a = answer.answers.terminal_risk
  const known = a?.type === 'score'
  const high = known && a.score >= RISK_BAR
  const unsure = !known || !(a.confidence >= th.choice)
  try { calibration?.record?.({ feature: 'terminal_gate', mode, judgments: [{ q: 'terminal_risk', would: high || unsure ? 'hold' : 'act', confidence: known ? a.confidence : undefined, threshold: th.choice, options: RISK_LEVELS.length }] }) } catch { /* ignore */ }
  if (mode === 'advisory') return { approval: false, reasons: [], source: 'fallback', requests: 1, shadow: high || unsure }
  const reasons = high ? ['risk_score'] : unsure ? ['risk_unsure'] : []
  return { approval: reasons.length > 0, reasons, source: 'decision', requests: 1, ...(known ? { score: Math.round(a.score * 100) / 100 } : {}) }
}
