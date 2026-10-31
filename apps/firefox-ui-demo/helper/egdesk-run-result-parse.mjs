// EGDesk run-result parse (CODE-06): what a test or build command the person
// typed printed → one result model: counts (통과/실패/건너뜀), the failing tests
// with a file:line target and first message line, duration, headline. Pure:
// no filesystem, network, timers or logging. Nothing here runs a command
// (D-X6: only output of commands the person entered is read).
//
// Readers, patterns only: node --test spec and TAP reporters, jest and vitest
// summaries, cargo test 'test result:' lines, and the generic path:line[:col]
// / path(line,col) shape (microsoft/vscode terminalLinkParsing suffixes, MIT —
// pattern only). The screen renders with EGDeskRunResult.sys.mjs; this module
// lets the bridge tell from a PTY stream, without a command boundary, that a
// run has finished (runSummaryEnd) and what it said (summarizeCommandOutput).

export const RUN_RESULT_PARSE_LIMITS = Object.freeze({
  scanChars: 256 * 1024,
  maxLineChars: 2000,
  maxFailures: 20,
  failureBlockLines: 60,
  messageChars: 200,
  commandChars: 200,
})

export const RUN_RESULT_RUNNERS = Object.freeze(['node-test', 'jest', 'vitest', 'cargo-test'])

const ANSI = /\u001b\[[0-?]*[ -/]*[@-~]|\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)|\u001b[@-Z\\-_]/g
const CONTROL = /[\u0000-\u0008\u000b-\u001f\u007f]/g

export function stripAnsi(text) {
  return typeof text === 'string' ? text.replace(ANSI, '') : ''
}

// Bounded lines of the output: ANSI removed, only the last scanChars kept,
// each line cut at maxLineChars. PTY output ends lines with \r\n.
export function outputLines(text) {
  let clean = stripAnsi(text)
  const truncated = clean.length > RUN_RESULT_PARSE_LIMITS.scanChars
  if (truncated) clean = clean.slice(-RUN_RESULT_PARSE_LIMITS.scanChars)
  const max = RUN_RESULT_PARSE_LIMITS.maxLineChars
  const lines = clean.split(/\r\n|\r|\n/).map(line => (line.length > max ? line.slice(0, max) : line))
  return { lines, truncated }
}

// ---- runner detection and the end of a run's summary ----

const SUMMARY_DETECT = Object.freeze({
  'node-test': text => /^\s*(?:ℹ|#) tests \d+\s*$/m.test(text) && /^\s*(?:ℹ|#) pass \d+\s*$/m.test(text),
  jest: text => /^Tests:\s+.*\b\d+ total\s*$/m.test(text),
  vitest: text => /^\s*Tests\s+.*\(\d+\)\s*$/m.test(text),
  'cargo-test': text => /^test result: (?:ok|FAILED)\. \d+ passed;/m.test(text),
})

// The line that closes a runner's summary. node prints its failing-tests
// details after this line, so a stream reader keeps reading until the next
// read; see egdesk-terminal-run-watch.mjs.
const SUMMARY_END = Object.freeze({
  'node-test': /^\s*(?:ℹ|#) duration_ms [\d.]+\s*$/,
  jest: /^(?:Ran all test suites\b|Time:\s+[\d.]+\s*m?s\b)/,
  vitest: /^\s*Duration\s+[\d.]+\s*m?s\b/,
  'cargo-test': /^test result: (?:ok|FAILED)\. \d+ passed; \d+ failed; \d+ ignored;/,
})

export function detectRunner(text) {
  const clean = stripAnsi(text)
  for (const runner of RUN_RESULT_RUNNERS) if (SUMMARY_DETECT[runner](clean)) return runner
  return null
}

// The last complete (newline-terminated) summary-closing line in text whose
// runner summary appears before it → {runner, end} with end the offset just
// after that line in the ANSI-stripped text; null while no run has finished.
export function runSummaryEnd(text) {
  const clean = stripAnsi(text)
  if (!clean) return null
  const lines = []
  const breaks = /\r\n|\r|\n/g
  let start = 0
  let match
  while ((match = breaks.exec(clean)) !== null) {
    lines.push({ start, stop: match.index, end: match.index + match[0].length })
    start = match.index + match[0].length
  }
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = clean.slice(lines[i].start, Math.min(lines[i].stop, lines[i].start + RUN_RESULT_PARSE_LIMITS.maxLineChars))
    for (const runner of RUN_RESULT_RUNNERS) {
      if (!SUMMARY_END[runner].test(line)) continue
      if (SUMMARY_DETECT[runner](clean.slice(0, lines[i].end))) return { runner, end: lines[i].end }
    }
  }
  return null
}

// ---- counts and duration ----

function lastMatch(text, pattern) {
  let found = null
  for (const match of text.matchAll(pattern)) found = match
  return found
}

function countsFromPairs(text, words) {
  const counts = { passed: 0, failed: 0, skipped: 0, todo: 0, total: null }
  let seen = false
  for (const match of text.matchAll(/(\d+) ([a-z]+)/g)) {
    const field = words[match[2]]
    if (!field) continue
    seen = true
    if (field === 'total') counts.total = Number(match[1])
    else counts[field] += Number(match[1])
  }
  return seen ? counts : null
}

function finishCounts(counts) {
  if (!counts) return null
  const total = counts.total ?? counts.passed + counts.failed + counts.skipped + counts.todo
  return { passed: counts.passed, failed: counts.failed, skipped: counts.skipped, todo: counts.todo, total }
}

// → {passed, failed, skipped, todo, total} | null
export function parseCounts(text, runner) {
  const out = stripAnsi(text)
  switch (runner) {
    case 'node-test': {
      const read = name => {
        const match = lastMatch(out, new RegExp(`^\\s*(?:ℹ|#) ${name} (\\d+)\\s*$`, 'gm'))
        return match ? Number(match[1]) : null
      }
      const tests = read('tests')
      if (tests === null) return null
      return finishCounts({ passed: read('pass') ?? 0, failed: (read('fail') ?? 0) + (read('cancelled') ?? 0), skipped: read('skipped') ?? 0, todo: read('todo') ?? 0, total: tests })
    }
    case 'jest': {
      const line = lastMatch(out, /^Tests:\s+(.+)$/gm)
      return line ? finishCounts(countsFromPairs(line[1], { passed: 'passed', failed: 'failed', skipped: 'skipped', todo: 'todo', total: 'total' })) : null
    }
    case 'vitest': {
      const line = lastMatch(out, /^\s*Tests\s+(.+)$/gm)
      if (!line) return null
      const counts = countsFromPairs(line[1], { passed: 'passed', failed: 'failed', skipped: 'skipped', todo: 'todo' })
      const total = line[1].match(/\((\d+)\)\s*$/)
      if (counts && total) counts.total = Number(total[1])
      return finishCounts(counts)
    }
    case 'cargo-test': {
      const counts = { passed: 0, failed: 0, skipped: 0, todo: 0, total: null }
      let seen = false
      for (const match of out.matchAll(/^test result: (?:ok|FAILED)\. (\d+) passed; (\d+) failed; (\d+) ignored;/gm)) {
        seen = true
        counts.passed += Number(match[1]); counts.failed += Number(match[2]); counts.skipped += Number(match[3])
      }
      return seen ? finishCounts(counts) : null
    }
    default:
      return null
  }
}

// Milliseconds the runner reported, or null.
export function parseDuration(text, runner) {
  const out = stripAnsi(text)
  const seconds = match => (match ? Math.round(Number(match[1]) * (match[2] === 'ms' ? 1 : 1000)) : null)
  switch (runner) {
    case 'node-test': {
      const match = lastMatch(out, /^\s*(?:ℹ|#) duration_ms ([\d.]+)\s*$/gm)
      return match ? Math.round(Number(match[1])) : null
    }
    case 'jest': return seconds(lastMatch(out, /^Time:\s+([\d.]+)\s*(m?s)\b/gm))
    case 'vitest': return seconds(lastMatch(out, /^\s*Duration\s+([\d.]+)\s*(m?s)\b/gm))
    case 'cargo-test': {
      let total = 0
      let seen = false
      for (const match of out.matchAll(/finished in ([\d.]+)s/g)) { seen = true; total += Number(match[1]) * 1000 }
      return seen ? Math.round(total) : null
    }
    default:
      return null
  }
}

// ---- locations ----

const NON_PROJECT_PATH = /^(?:node:|internal[\\/]|<anonymous>|\[eval|evalmachine)|(?:^|[\\/])node_modules[\\/]|(?:^|[\\/])\.pnpm[\\/]|(?:^|[\\/])site-packages[\\/]|(?:^|[\\/])\.cargo[\\/]registry[\\/]|^\/rustc\//
// path:line[:col] · path(line[,col]) — a path has an extension; the optional
// prefix admits a Windows drive, ./ ../ / and ~/.
const LOCATION = /((?:[A-Za-z]:[\\/]|\.{0,2}[\\/]|~[\\/]|file:\/\/\/?)?[^\s:()'"`<>|]+\.[A-Za-z0-9]{1,10})(?::(\d+)(?::(\d+))?\b|\((\d+)(?:,\s?(\d+))?\))/g
const STACK_LINE = /^\s*(?:at\s|❯\s|→\s|File\s"|thread '.*' panicked at|test at\s)/

const isAbsolute = value => value.startsWith('/') || /^[A-Za-z]:[\\/]/.test(value) || value.startsWith('\\\\')
const normalizeSlashes = value => value.replace(/\\/g, '/')

// Lexical join with '.'/'..' folding; never touches the filesystem.
function joinPath(base, relative) {
  const windows = /^[A-Za-z]:/.test(base)
  const parts = normalizeSlashes(`${base}/${relative}`).split('/')
  const prefix = windows ? parts.shift() : ''
  const stack = []
  for (const part of parts) {
    if (!part || part === '.') continue
    if (part === '..') stack.pop()
    else stack.push(part)
  }
  return windows ? `${prefix}\\${stack.join('\\')}` : `/${stack.join('/')}`
}

// A printed path → {path, relativePath, line, column, label, inProject} | null.
// inProject is true/false against cwd when given, else null (unknown) for a
// relative path and true for an absolute one. '~/…' is never a project file.
export function resolveLocation(rawPath, line, column, { cwd = null } = {}) {
  if (typeof rawPath !== 'string' || !Number.isInteger(line) || line < 1) return null
  let path = rawPath.trim().replace(/[),:;.]+$/, '')
  if (/^file:\/\//i.test(path)) {
    path = path.replace(/^file:\/\/(?:localhost)?/i, '')
    try { path = decodeURIComponent(path) } catch {}
    if (/^\/[A-Za-z]:\//.test(path)) path = path.slice(1)
  }
  if (!path || path.length > 1024 || /^\d+$/.test(path) || NON_PROJECT_PATH.test(path)) return null
  const absolute = isAbsolute(path)
  const home = path.startsWith('~')
  const root = typeof cwd === 'string' && isAbsolute(cwd) ? cwd.replace(/[\\/]+$/, '') : null
  const fullPath = absolute ? path : root && !home ? joinPath(root, path) : null
  let relativePath = null
  let inProject = home ? false : absolute ? true : null
  if (root) {
    const base = normalizeSlashes(root)
    const target = fullPath ? normalizeSlashes(fullPath) : null
    const caseFold = /^[A-Za-z]:/.test(root)
    const same = (a, b) => (caseFold ? a.toLowerCase() === b.toLowerCase() : a === b)
    if (target && target.length > base.length + 1 && same(target.slice(0, base.length + 1), `${base}/`)) {
      relativePath = target.slice(base.length + 1)
      inProject = true
    } else inProject = false
  } else if (!absolute && !home) relativePath = normalizeSlashes(path).replace(/^\.\//, '')
  const col = Number.isInteger(column) && column > 0 ? column : null
  const shown = relativePath || path
  return { path: fullPath || path, relativePath, line, column: col, label: col ? `${shown}:${line}:${col}` : `${shown}:${line}`, inProject }
}

// Every path:line[:col] on one line, resolved.
export function locationsInLine(line, ctx = {}) {
  const found = []
  if (typeof line !== 'string') return found
  for (const match of line.matchAll(LOCATION)) {
    const location = resolveLocation(match[1], Number(match[2] ?? match[4]), match[3] ?? match[5] ? Number(match[3] ?? match[5]) : null, ctx)
    if (location) found.push(location)
  }
  return found
}

// First location in a block that may be a project file: stack frames first
// (test-reporter's "first project frame" pattern), then any line.
export function firstLocation(lines, ctx = {}) {
  const candidate = location => location.inProject !== false
  for (const line of lines) {
    if (!STACK_LINE.test(line)) continue
    const hit = locationsInLine(line, ctx).find(candidate)
    if (hit) return hit
  }
  for (const line of lines) {
    const hit = locationsInLine(line, ctx).find(candidate)
    if (hit) return hit
  }
  return null
}

// ---- failures ----

function shortText(text, max = RUN_RESULT_PARSE_LIMITS.messageChars) {
  const clean = String(text ?? '').replace(CONTROL, '').trim()
  return clean.length > max ? `${clean.slice(0, max)}…` : clean
}

const ERRORISH = /\b(?:error|Error|ERROR|failed|FAILED|FAIL|panic(?:ked)?|Exception|Traceback)\b/
const RULE_LINE = /^[-─=~^_]+$/
const CODE_FRAME = /^\s*>?\s*\d+\s*\|/

// The first message line after a marker: a TAP 'error:' field, a cargo panic
// message, else the first line that is not a frame, rule or code frame.
function messageAfter(lines, start, end) {
  for (let i = start; i < end; i++) {
    const tap = lines[i].match(/^\s+error:\s*(.*)$/)
    if (!tap) continue
    if (!/^[|>][-+]?$/.test(tap[1].trim())) return shortText(tap[1].trim().replace(/^'(.*)'$/, '$1'))
    const next = lines.slice(i + 1, end).find(line => line.trim())
    return next ? shortText(next) : null
  }
  for (let i = start; i < end; i++) {
    const old = lines[i].match(/panicked at '(.+)', \S+:\d+:\d+/)
    if (old) return shortText(old[1])
    if (/panicked at \S+:\d+:\d+:?\s*$/.test(lines[i])) {
      const next = lines.slice(i + 1, end).find(line => line.trim())
      return next ? shortText(next) : null
    }
  }
  for (let i = start; i < end; i++) {
    const line = lines[i]?.trim()
    if (!line || STACK_LINE.test(lines[i]) || RULE_LINE.test(line) || CODE_FRAME.test(lines[i])) continue
    return shortText(line)
  }
  return null
}

// Per runner, marker patterns in priority order; the first pattern that finds
// any failure is used alone (vitest prints each failure as '×' and again as
// 'FAIL file > name'; node prints spec '✖' or TAP 'not ok', never both).
const FAILURE_MARKERS = Object.freeze({
  'node-test': [/^\s*✖ (.+?)(?: \([\d.]+m?s\))?\s*$/, /^\s*not ok \d+ - (.+?)\s*(?:#.*)?$/],
  jest: [/^\s*● (.+?)\s*$/],
  vitest: [/^\s*FAIL\s+(.+?)\s*$/, /^\s*[×✗] (.+?)(?: \d+m?s)?\s*$/],
  'cargo-test': [/^---- (\S+) stdout ----$/],
})

function markerStart(lines, runner) {
  // node's spec reporter lists '✖ name' inline and repeats it with the error
  // under '✖ failing tests:'; only the repeat carries the location.
  if (runner === 'node-test') return Math.max(0, lines.findIndex(line => /^\s*✖ failing tests:?\s*$/.test(line)))
  return 0
}

function findMarks(lines, runner, start) {
  for (const pattern of FAILURE_MARKERS[runner] || []) {
    const marks = []
    for (let i = start; i < lines.length; i++) {
      const match = lines[i].match(pattern)
      if (!match) continue
      const name = match[1].trim()
      if (runner === 'node-test' && /^failing tests:?$/.test(name)) continue
      marks.push({ index: i, name })
    }
    if (marks.length) return marks
  }
  return []
}

// → [{name, message, location}] — name null for a generic (no runner) failure.
export function parseFailures(input, runner, ctx = {}) {
  const lines = Array.isArray(input) ? input : outputLines(input).lines
  const marks = findMarks(lines, runner, markerStart(lines, runner))
  const failures = []
  const seen = new Set()
  marks.forEach((mark, n) => {
    if (seen.has(mark.name) || failures.length >= RUN_RESULT_PARSE_LIMITS.maxFailures) return
    seen.add(mark.name)
    const end = Math.min(marks[n + 1]?.index ?? lines.length, mark.index + RUN_RESULT_PARSE_LIMITS.failureBlockLines)
    const block = lines.slice(mark.index, end)
    failures.push({ name: shortText(mark.name), message: messageAfter(lines, mark.index + 1, end), location: firstLocation(block, ctx) })
  })
  if (failures.length) return failures
  const start = lines.findIndex(line => ERRORISH.test(line))
  if (start < 0) return []
  const block = lines.slice(start, start + RUN_RESULT_PARSE_LIMITS.failureBlockLines)
  return [{ name: null, message: shortText(lines[start]), location: firstLocation(block, ctx) }]
}

// ---- model ----

export function commandDisplay(command) {
  if (typeof command !== 'string') return null
  const clean = stripAnsi(command).replace(CONTROL, '').replace(/\s+/g, ' ').trim()
  if (!clean) return null
  const max = RUN_RESULT_PARSE_LIMITS.commandChars
  return clean.length > max ? `${clean.slice(0, max)}…` : clean
}

function headlineFor({ outcome, counts, exitCode }) {
  const exit = Number.isInteger(exitCode) && exitCode !== 0 ? `종료 코드 ${exitCode}` : null
  if (counts) {
    const parts = [`${counts.passed} 통과`]
    if (counts.failed > 0) parts.push(`${counts.failed} 실패`)
    if (counts.skipped > 0) parts.push(`${counts.skipped} 건너뜀`)
    if (counts.todo > 0) parts.push(`${counts.todo} 할 일`)
    if (outcome === 'failed' && counts.failed === 0 && exit) parts.push(exit)
    return parts.join(' · ')
  }
  if (outcome === 'passed') return '완료'
  if (outcome === 'failed') return ['실패', exit].filter(Boolean).join(' · ')
  return '요약 없음 · 원문 보기'
}

/**
 * {command?, output, exitCode?, durationMs?, cwd?} → result model
 * {parsed, runner, kind, outcome, command, counts, failures, firstLocation,
 *  durationMs, exitCode, headline, outputTruncated}.
 * parsed is false when no runner summary was read; the headline then falls
 * back to the exit code, or to '요약 없음 · 원문 보기' when there is none.
 */
export function summarizeCommandOutput({ command = null, output = '', exitCode = null, durationMs = null, cwd = null } = {}) {
  const { lines, truncated } = outputLines(typeof output === 'string' ? output : '')
  const text = lines.join('\n')
  const runner = detectRunner(text)
  const counts = runner ? parseCounts(text, runner) : null
  const exit = Number.isInteger(exitCode) ? exitCode : null
  const outcome = counts
    ? counts.failed > 0 || (exit !== null && exit !== 0) ? 'failed' : 'passed'
    : exit === 0 ? 'passed' : exit !== null ? 'failed' : 'unknown'
  const ctx = { cwd: typeof cwd === 'string' ? cwd : null }
  const failures = outcome === 'failed' ? parseFailures(lines, runner, ctx) : []
  const duration = Number.isFinite(durationMs) && durationMs >= 0 ? Math.round(durationMs) : parseDuration(text, runner)
  return {
    parsed: !!counts,
    runner,
    kind: runner ? 'test' : 'other',
    outcome,
    command: commandDisplay(command),
    counts,
    failures,
    firstLocation: failures.find(failure => failure.location)?.location || null,
    durationMs: duration,
    exitCode: exit,
    headline: headlineFor({ outcome, counts, exitCode: exit }),
    outputTruncated: truncated,
  }
}
