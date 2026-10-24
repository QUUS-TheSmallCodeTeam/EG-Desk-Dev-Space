// Read-only git review for a connected File root (CODE-05, CODE-03; bundle 1-G).
//
// Portions adapted from pingdotgg/t3code (MIT License, Copyright (c) 2026 T3 Tools Inc.):
//   porcelain v2 fields before the path (apps/server/src/vcs/GitVcsDriverCore.ts:214-229),
//   NUL-separated numstat records with rename pairs (GitVcsDriverCore.ts:195-212,
//   apps/server/src/checkpointing/Diffs.ts:8-36), plumbing diff-index instead of
//   porcelain diff (GitVcsDriverCore.ts:2123-2128), review diff flags and the 1 MiB
//   per-file patch cap (GitVcsDriverCore.ts:64-82), hardened config
//   (apps/server/src/vcs/GitVcsDriver.ts:427-432), GIT_OPTIONAL_LOCKS=0
//   (GitVcsDriverCore.ts:979-987) and safe.bareRepository=explicit
//   (apps/server/src/vcs/VcsProcess.ts:131-139).
//
// Every command runs through execFile with an argument array: no shell, no
// renderer-supplied path. Callers pass the verified real root path from the
// file service. stderr and absolute paths never leave this module.
import { execFile as nodeExecFile } from 'node:child_process'
import { constants } from 'node:fs'
import * as fs from 'node:fs/promises'
import path from 'node:path'

export const EGDESK_GIT_REVIEW_LIMITS = Object.freeze({
  timeoutMs: 5000,
  grepTimeoutMs: 1500,
  metadataMaxBytes: 16 * 1024 * 1024,
  patchMaxBytes: 1024 * 1024,
  grepMaxBytes: 4 * 1024 * 1024,
  maxEntries: 5000,
  maxListedFiles: 50_000,
  grepMatchesPerFile: 100,
  maxConcurrent: 4,
})

// Command-scope config is "protected" config, so a repository cannot undo it.
const HARDENED_ARGS = Object.freeze([
  '--literal-pathspecs',
  '-c', 'core.fsmonitor=false',
  '-c', 'core.untrackedCache=false',
  '-c', 'safe.bareRepository=explicit',
  '-c', 'core.quotePath=false',
])
// Inherited variables that would point git at another repository or change
// how pathspecs and diffs are interpreted.
const STRIPPED_ENV = ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE', 'GIT_OBJECT_DIRECTORY', 'GIT_ALTERNATE_OBJECT_DIRECTORIES',
  'GIT_COMMON_DIR', 'GIT_NAMESPACE', 'GIT_PREFIX', 'GIT_LITERAL_PATHSPECS', 'GIT_GLOB_PATHSPECS', 'GIT_NOGLOB_PATHSPECS',
  'GIT_ICASE_PATHSPECS', 'GIT_EXTERNAL_DIFF', 'GIT_DIFF_OPTS', 'GIT_PAGER', 'PAGER']
const PORCELAIN_V2_FIELDS_BEFORE_PATH = Object.freeze({ 1: 8, 2: 9, u: 10, '?': 1, '!': 1 })
const decoder = new TextDecoder('utf-8')
const decode = bytes => decoder.decode(bytes || new Uint8Array())

export class GitReviewError extends Error {
  constructor(code, message) {
    super(message)
    this.name = 'GitReviewError'
    this.code = code
  }
}
const fail = (code, message) => { throw new GitReviewError(code, message) }

export function egdeskGitEnv(base = process.env) {
  const env = { ...base }
  for (const key of STRIPPED_ENV) delete env[key]
  // Status refreshes run beside the user's own git; never take index.lock.
  return { ...env, GIT_OPTIONAL_LOCKS: '0', GIT_TERMINAL_PROMPT: '0', GIT_NO_LAZY_FETCH: '1' }
}

function checkedRelative(value) {
  if (typeof value !== 'string' || !value || value.length > 4096 || value.includes('\0') || value.includes('\\') || value.startsWith('/')) fail('INVALID_PATH', 'A root-relative path is required')
  if (value.split('/').some(part => part === '' || part === '.' || part === '..')) fail('INVALID_PATH', 'A root-relative path is required')
  return value
}
const stripPrefix = (repoPath, prefix) => !prefix ? repoPath : repoPath.startsWith(prefix) ? repoPath.slice(prefix.length) : null

function stateFor(kind, xy) {
  if (kind === '?') return 'untracked'
  if (kind === '!') return 'ignored'
  if (kind === 'u') return 'conflicted'
  const [x, y] = xy
  if (kind === '2') return x === 'C' || y === 'C' ? 'added' : 'renamed'
  if (x === 'D' || y === 'D') return 'deleted'
  if (x === 'A') return 'added'
  return 'modified'
}

/**
 * `git status --porcelain=2 --branch -z` records → root-relative entries.
 * `prefix` is `git rev-parse --show-prefix` for the connected root; records
 * outside it are dropped. Directory records (untracked folders) keep
 * `directory: true` without the trailing slash.
 */
export function parsePorcelainV2Status(text, prefix = '', { maxEntries = EGDESK_GIT_REVIEW_LIMITS.maxEntries, partial = false } = {}) {
  const records = String(text).split('\0')
  if (partial) records.pop()
  const entries = []
  let branch = null
  let truncated = partial
  for (let index = 0; index < records.length; index++) {
    const record = records[index]
    if (!record) continue
    if (record.startsWith('# branch.head ')) {
      const value = record.slice('# branch.head '.length).trim()
      branch = value.startsWith('(') ? null : value
      continue
    }
    const kind = record[0]
    const before = PORCELAIN_V2_FIELDS_BEFORE_PATH[kind]
    if (before === undefined || record[1] !== ' ') continue
    const parts = record.split(' ')
    const repoPath = parts.slice(before).join(' ')
    const originalPath = kind === '2' ? records[++index] ?? null : null
    if (!repoPath) continue
    let relativePath = stripPrefix(repoPath, prefix)
    if (relativePath == null) continue
    const directory = relativePath.endsWith('/')
    if (directory) relativePath = relativePath.slice(0, -1)
    if (!relativePath) continue
    const xy = kind === '?' || kind === '!' ? `${kind}${kind}` : parts[1] || '..'
    if (entries.length >= maxEntries) { truncated = true; break }
    const previous = originalPath ? stripPrefix(originalPath, prefix) : null
    entries.push({
      relativePath, previousPath: previous || null, state: stateFor(kind, xy),
      staged: kind !== '?' && kind !== '!' && xy[0] !== '.', unstaged: kind === '?' || (kind !== '!' && xy[1] !== '.'), directory,
    })
  }
  return { branch, entries, truncated }
}

/** NUL numstat (`--numstat -z`) → Map(path → {additions, deletions, binary, previousPath}). */
export function parseNumstat(text) {
  const fields = String(text).split('\0')
  const files = new Map()
  for (let index = 0; index < fields.length; index++) {
    const match = /^(\d+|-)\t(\d+|-)\t([\s\S]*)$/.exec(fields[index])
    if (!match) continue
    const previousPath = match[3] === '' ? fields[++index] ?? null : null
    const filePath = previousPath !== null ? fields[++index] ?? '' : match[3]
    if (!filePath) continue
    const binary = match[1] === '-' && match[2] === '-'
    files.set(filePath, { additions: binary ? null : Number(match[1]), deletions: binary ? null : Number(match[2]), binary, previousPath })
  }
  return files
}

/**
 * Unified patch → the File view's lineDiff shape: one entry per contiguous run
 * of removed/added lines, `{baseStartLine, baseLines, currentStartLine,
 * currentLines}` with 1-based line numbers. Context lines are dropped. Hunk
 * bodies are consumed by their @@ counts, so content lines that look like
 * `--- ` headers are not misread.
 */
export function unifiedPatchToHunks(patch) {
  const lines = String(patch).split('\n')
  const hunks = []
  let block = null
  const flush = () => { if (block) hunks.push(block); block = null }
  for (let index = 0; index < lines.length; index++) {
    const header = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(lines[index])
    if (!header) continue
    const baseCount = header[2] === undefined ? 1 : Number(header[2])
    const currentCount = header[4] === undefined ? 1 : Number(header[4])
    let baseLine = baseCount === 0 ? Number(header[1]) + 1 : Number(header[1])
    let currentLine = currentCount === 0 ? Number(header[3]) + 1 : Number(header[3])
    let baseLeft = baseCount
    let currentLeft = currentCount
    while ((baseLeft > 0 || currentLeft > 0) && index + 1 < lines.length) {
      const line = lines[++index]
      const marker = line[0]
      if (marker === '\\') continue
      if (marker === '-' && baseLeft > 0) {
        block ||= { baseStartLine: baseLine, baseLines: [], currentStartLine: currentLine, currentLines: [] }
        block.baseLines.push(line.slice(1)); baseLine++; baseLeft--
      } else if (marker === '+' && currentLeft > 0) {
        block ||= { baseStartLine: baseLine, baseLines: [], currentStartLine: currentLine, currentLines: [] }
        block.currentLines.push(line.slice(1)); currentLine++; currentLeft--
      } else if ((marker === ' ' || line === '') && baseLeft > 0 && currentLeft > 0) {
        flush(); baseLine++; currentLine++; baseLeft--; currentLeft--
      } else { index--; break }
    }
    flush()
  }
  return hunks
}

/** Patch text for a file git does not track yet (shown like `git diff` would). */
export function newFilePatch(relativePath, text) {
  const name = checkedRelative(relativePath)
  const body = String(text)
  const lines = body === '' ? [] : body.split('\n')
  const endsWithNewline = body.endsWith('\n')
  if (endsWithNewline) lines.pop()
  const head = `diff --git a/${name} b/${name}\nnew file mode 100644\n--- /dev/null\n+++ b/${name}\n`
  if (!lines.length) return { patch: head, hunks: [] }
  const patch = `${head}@@ -0,0 +1${lines.length === 1 ? '' : `,${lines.length}`} @@\n${lines.map(line => `+${line}`).join('\n')}\n${endsWithNewline ? '' : '\\ No newline at end of file\n'}`
  return { patch, hunks: [{ baseStartLine: 1, baseLines: [], currentStartLine: 1, currentLines: lines }] }
}

const escapeRegExp = value => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
/** Fixed-string match ranges in UTF-16 indexes (the content search contract). */
export function contentMatchRanges(line, query, caseSensitive = false) {
  if (!query) return []
  const pattern = new RegExp(escapeRegExp(query), caseSensitive ? 'gu' : 'giu')
  const ranges = []
  for (const match of String(line).matchAll(pattern)) {
    if (!match[0]) break
    ranges.push({ start: match.index, end: match.index + match[0].length })
    if (ranges.length >= 50) break
  }
  return ranges
}

/** Keep long (minified) lines bounded around the first match. */
export function contentSnippet(line, ranges, maxLength = 400) {
  const text = String(line)
  const column = ranges.length ? ranges[0].start : null
  if (text.length <= maxLength) return { lineContent: text, matchRanges: ranges, column, lineTruncated: false }
  const start = Math.max(0, Math.min((column ?? 0) - 100, text.length - maxLength))
  const end = start + maxLength
  const matchRanges = ranges.filter(range => range.end > start && range.start < end)
    .map(range => ({ start: Math.max(range.start, start) - start, end: Math.min(range.end, end) - start }))
  return { lineContent: text.slice(start, end), matchRanges, column, lineTruncated: true, snippetStart: start }
}

/** `git grep -n -z` records (`path\0line\0content\n`). */
export function parseGitGrep(text, { partial = false } = {}) {
  const records = String(text).split('\n')
  if (partial || records.at(-1) === '') records.pop()
  const matches = []
  for (const record of records) {
    const first = record.indexOf('\0')
    const second = first < 0 ? -1 : record.indexOf('\0', first + 1)
    if (first <= 0 || second < 0) continue
    const lineNumber = Number(record.slice(first + 1, second))
    if (!Number.isSafeInteger(lineNumber) || lineNumber < 1) continue
    matches.push({ relativePath: record.slice(0, first), lineNumber, lineContent: record.slice(second + 1).replace(/\r$/, '') })
  }
  return matches
}

async function findOnPath(env, platform) {
  const names = platform === 'win32' ? ['git.exe'] : ['git']
  for (const directory of String(env.PATH || env.Path || '').split(path.delimiter)) {
    if (!directory || !path.isAbsolute(directory)) continue
    for (const name of names) {
      const candidate = path.join(directory, name)
      try {
        await fs.access(candidate, constants.X_OK)
        if ((await fs.stat(candidate)).isFile()) return candidate
      } catch {}
    }
  }
  return null
}

/**
 * createEGDeskGitReview({ execFile?, gitExecutable?, env?, platform?, limits? })
 *   status(rootPath, {untracked: 'normal'|'all'}) → {isRepo, branch, entries, truncated}
 *   changes(rootPath) → {isRepo, branch, files:[{relativePath, previousPath, status, additions, deletions, binary}], truncated, countsAvailable}
 *   fileDiff(rootPath, {relativePath, previousPath}) → {patch, hunks, binary, truncated}
 *   grep(rootPath, {query, caseSensitive, limit}) → {matches, truncated} | null (not a repo or git error)
 *   listFiles(rootPath) → {paths, truncated} | null
 * Throws GitReviewError GIT_UNAVAILABLE | GIT_TIMEOUT | GIT_FAILED | INVALID_PATH.
 */
export function createEGDeskGitReview({ execFile = nodeExecFile, gitExecutable = null, env = process.env, platform = process.platform, limits = {} } = {}) {
  const bounds = { ...EGDESK_GIT_REVIEW_LIMITS, ...limits }
  const spawnEnv = egdeskGitEnv(env)
  let executable = null
  let active = 0
  const waiting = []

  // On macOS /usr/bin/git is a shim that opens the Command Line Tools installer
  // when they are missing; a file card must never pop that dialog.
  async function resolveExecutable() {
    if (gitExecutable) return gitExecutable
    executable ||= (async () => {
      const found = await findOnPath(env, platform)
      if (!found || platform !== 'darwin' || found !== '/usr/bin/git') return found
      const developer = await new Promise(resolve => {
        execFile('/usr/bin/xcode-select', ['-p'], { timeout: 2000, windowsHide: true, encoding: 'utf8' }, (error, stdout) => resolve(error ? null : String(stdout).trim()))
      })
      if (!developer || !path.isAbsolute(developer)) return null
      try { await fs.access(path.join(developer, 'usr', 'bin', 'git'), constants.X_OK); return found }
      catch { return null }
    })()
    return executable
  }

  async function limited(work) {
    if (active >= bounds.maxConcurrent) await new Promise(resolve => waiting.push(resolve))
    active++
    try { return await work() }
    finally { active--; waiting.shift()?.() }
  }

  async function run(cwd, args, { timeoutMs = bounds.timeoutMs, maxBytes = bounds.metadataMaxBytes } = {}) {
    const file = await resolveExecutable()
    if (!file) fail('GIT_UNAVAILABLE', 'git is not available')
    return limited(() => new Promise((resolve, reject) => {
      execFile(file, [...HARDENED_ARGS, ...args], { cwd, env: spawnEnv, timeout: timeoutMs, maxBuffer: maxBytes, encoding: 'buffer', windowsHide: true, killSignal: 'SIGKILL' }, (error, stdout) => {
        const output = Buffer.isBuffer(stdout) ? stdout : Buffer.from(stdout || '')
        if (!error) return resolve({ code: 0, stdout: output, truncated: false, timedOut: false })
        if (error.code === 'ENOENT' || error.code === 'EACCES') return reject(new GitReviewError('GIT_UNAVAILABLE', 'git is not available'))
        if (error.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER') return resolve({ code: null, stdout: output, truncated: true, timedOut: false })
        if (error.killed || error.signal) return resolve({ code: null, stdout: output, truncated: false, timedOut: true })
        if (Number.isInteger(error.code)) return resolve({ code: error.code, stdout: output, truncated: false, timedOut: false })
        reject(new GitReviewError('GIT_FAILED', 'git could not be started'))
      })
    }))
  }

  async function repository(rootPath) {
    if (typeof rootPath !== 'string' || !path.isAbsolute(rootPath)) fail('INVALID_PATH', 'An absolute verified root is required')
    const result = await run(rootPath, ['rev-parse', '--show-prefix'], { maxBytes: 64 * 1024 })
    if (result.timedOut) fail('GIT_TIMEOUT', 'git did not answer in time')
    if (result.code !== 0) return { isRepo: false, prefix: '' }
    return { isRepo: true, prefix: decode(result.stdout).replace(/\r?\n$/, '') }
  }

  // An unborn branch has no HEAD; compare against the empty tree instead.
  async function baseTree(rootPath) {
    const head = await run(rootPath, ['rev-parse', '--verify', '--quiet', 'HEAD^{commit}'], { maxBytes: 64 * 1024 })
    if (head.code === 0) return 'HEAD'
    const empty = await run(rootPath, ['hash-object', '-t', 'tree', platform === 'win32' ? 'NUL' : '/dev/null'], { maxBytes: 64 * 1024 })
    if (empty.code !== 0) fail('GIT_FAILED', 'git could not read the empty tree')
    return decode(empty.stdout).trim()
  }

  async function readStatus(rootPath, prefix, untracked) {
    const result = await run(rootPath, ['status', '--porcelain=2', '--branch', '--no-ahead-behind', '-z', `--untracked-files=${untracked}`, '--', '.'])
    if (result.code !== 0 && !result.truncated && !result.timedOut) fail('GIT_FAILED', 'git status failed')
    if (result.timedOut && !result.stdout.length) fail('GIT_TIMEOUT', 'git status did not finish in time')
    return parsePorcelainV2Status(decode(result.stdout), prefix, { maxEntries: bounds.maxEntries, partial: result.truncated || result.timedOut })
  }

  async function status(rootPath, { untracked = 'normal' } = {}) {
    if (!['normal', 'all', 'no'].includes(untracked)) fail('INVALID_OPTION', 'Unsupported untracked mode')
    const repo = await repository(rootPath)
    if (!repo.isRepo) return { isRepo: false, branch: null, entries: [], truncated: false }
    return { isRepo: true, ...await readStatus(rootPath, repo.prefix, untracked) }
  }

  async function changes(rootPath) {
    const repo = await repository(rootPath)
    if (!repo.isRepo) return { isRepo: false, branch: null, files: [], truncated: false, countsAvailable: false }
    const [state, base] = await Promise.all([readStatus(rootPath, repo.prefix, 'all'), baseTree(rootPath)])
    // Status is the source of truth for which paths changed (it re-checks
    // content for touched files in memory); plumbing numstat adds the counts.
    const counted = await run(rootPath, ['diff-index', '-M', '--numstat', '-z', '--relative', base, '--', '.'])
    const counts = counted.code === 0 ? parseNumstat(decode(counted.stdout)) : new Map()
    const files = state.entries.filter(entry => entry.state !== 'ignored' && !entry.directory).map(entry => {
      const count = counts.get(entry.relativePath)
      return {
        relativePath: entry.relativePath, previousPath: entry.previousPath, status: entry.state,
        additions: count ? count.additions : null, deletions: count ? count.deletions : null, binary: count?.binary === true,
      }
    })
    return { isRepo: true, branch: state.branch, files, truncated: state.truncated, countsAvailable: counted.code === 0 }
  }

  async function fileDiff(rootPath, { relativePath, previousPath = null } = {}) {
    const target = checkedRelative(relativePath)
    const previous = previousPath == null ? null : checkedRelative(previousPath)
    const repo = await repository(rootPath)
    if (!repo.isRepo) fail('NOT_A_REPOSITORY', 'The connected folder is not inside a git repository')
    const base = await baseTree(rootPath)
    const result = await run(rootPath, ['diff-index', '-p', '-M', '--no-ext-diff', '--no-textconv', '--no-color', '--src-prefix=a/', '--dst-prefix=b/', '--relative', base, '--', target, ...(previous && previous !== target ? [previous] : [])], { maxBytes: bounds.patchMaxBytes })
    if (result.timedOut) fail('GIT_TIMEOUT', 'git diff did not finish in time')
    if (result.code !== 0 && !result.truncated) fail('GIT_FAILED', 'git diff failed')
    let patch = decode(result.stdout)
    if (result.truncated) patch = patch.slice(0, patch.lastIndexOf('\n') + 1)
    const binary = /^(?:Binary files .* differ|GIT binary patch)$/m.test(patch)
    return { patch, hunks: binary ? [] : unifiedPatchToHunks(patch), binary, truncated: result.truncated }
  }

  async function grep(rootPath, { query, caseSensitive = false, limit = 50 } = {}) {
    if (typeof query !== 'string' || !query || query.length > 256 || /[\0\r\n]/.test(query)) fail('INVALID_QUERY', 'A single-line query is required')
    const repo = await repository(rootPath)
    if (!repo.isRepo) return null
    const result = await run(rootPath, ['grep', '-n', '-z', '-I', '-F', '--no-color', '--untracked', `--max-count=${bounds.grepMatchesPerFile}`,
      ...(caseSensitive ? [] : ['-i']), '-e', query, '--', '.'], { timeoutMs: bounds.grepTimeoutMs, maxBytes: bounds.grepMaxBytes })
    const partial = result.truncated || result.timedOut
    if (result.code === 1 && !partial) return { matches: [], truncated: false }
    if (result.code !== 0 && !partial) return null
    const matches = parseGitGrep(decode(result.stdout), { partial })
    return { matches: matches.slice(0, limit), truncated: partial || matches.length > limit }
  }

  async function listFiles(rootPath) {
    const repo = await repository(rootPath)
    if (!repo.isRepo) return null
    const result = await run(rootPath, ['ls-files', '--cached', '--others', '--exclude-standard', '-z', '--', '.'])
    if (result.code !== 0 && !result.truncated) return null
    const paths = decode(result.stdout).split('\0')
    if (result.truncated || result.timedOut || paths.at(-1) === '') paths.pop()
    const unique = [...new Set(paths.filter(Boolean))]
    return { paths: unique.slice(0, bounds.maxListedFiles), truncated: result.truncated || result.timedOut || unique.length > bounds.maxListedFiles }
  }

  return { status, changes, fileDiff, grep, listFiles, newFilePatch }
}
