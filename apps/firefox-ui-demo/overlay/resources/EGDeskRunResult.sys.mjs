// EGDeskRunResult — the '테스트·빌드 결과 카드' part (CODE-06).
//
// Reads what a command printed and turns it into one result card model:
// what kind of command it was (테스트/빌드/코드 검사/타입 검사 …), a headline
// such as '12 통과 · 1 실패', the failing tests with the first project file
// location to jump to, and a short tail of the output. renderRunResultCard()
// draws that model as plain DOM (textContent only) for the activity row.
//
// References (read and followed):
// - Output tail with a short command (t3code apps/server/src/orchestration-v2/
//   Adapters/CodexAdapterV2.ts codexBackgroundCommandDetail, MIT — pattern only).
// - Result model run → tests with passed/failed/skipped and an error location,
//   and "first stack frame that is a project file, skipping internal/ and
//   node_modules" (dorny/test-reporter src/test-results.ts and
//   src/utils/node-utils.ts getExceptionSource, MIT — pattern only).
// - eslint "stylish" two-line problem format (microsoft/vscode
//   src/vs/workbench/contrib/tasks/common/problemMatcher.ts 'eslint-stylish',
//   MIT — the two regular expressions are reused).
// - file:line[:col] detection: microsoft/vscode terminalLinkParsing.ts, ported
//   below in its own section with the original MIT header kept.
// - Codex commandExecution item {command, cwd, exitCode, durationMs,
//   aggregatedOutput, commandActions[{type: read|listFiles|search|unknown}]}
//   (codex app-server-protocol v2 schema).
//
// Input output may be a string or the chat runtime's bounded capture
// {head, tail, omittedBytes|truncated}. Nothing here logs, stores or sends the
// text; secrets that look like tokens are masked in what the card shows.
// Model or user strings are never used as object keys.

export const RUN_RESULT_LIMITS = Object.freeze({
  maxScanChars: 256 * 1024,
  keepHeadChars: 16 * 1024,
  maxLineChars: 2000,
  maxFailures: 20,
  failureBlockLines: 60,
  maxMessageChars: 200,
  tailLines: 20,
  tailChars: 2000,
  commandDisplayChars: 200,
})

export const RUN_KINDS = Object.freeze(['test', 'typecheck', 'lint', 'build', 'install', 'run', 'git', 'search', 'read', 'list', 'other'])
const KIND_LABELS = Object.freeze({
  test: '테스트', typecheck: '타입 검사', lint: '코드 검사', build: '빌드', install: '설치', run: '실행',
  git: 'git', search: '검색', read: '파일 읽기', list: '목록 보기', other: '명령',
})
const KIND_PRIORITY = Object.freeze({ test: 9, typecheck: 8, lint: 7, build: 6, install: 5, run: 4, git: 3, search: 2, read: 2, list: 2, other: 0 })

/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// Ported from microsoft/vscode
//   src/vs/workbench/contrib/terminalContrib/links/browser/terminalLinkParsing.ts
//   at commit da20a6d0ddd819136575cd284741993a9e724c2f (last change 2026-07-20).
// The full MIT License text of microsoft/vscode is in vendor/VENDOR.md.
// Changes from the original: TypeScript types removed, Lazy<RegExp> replaced by
// a memoized getter, the OperatingSystem enum replaced by the string 'windows'
// (anything else is treated as a POSIX system). Logic and regular expressions
// are unchanged.

function lazyRegExp(factory) {
  let value
  return { get value() { return value ??= factory() } }
}

const linkSuffixRegexEol = lazyRegExp(() => generateLinkSuffixRegex(true))
const linkSuffixRegex = lazyRegExp(() => generateLinkSuffixRegex(false))

function generateLinkSuffixRegex(eolOnly) {
  let ri = 0
  let ci = 0
  let rei = 0
  let cei = 0
  function r() {
    return `(?<row${ri++}>\\d+)`
  }
  function c() {
    return `(?<col${ci++}>\\d+)`
  }
  function re() {
    return `(?<rowEnd${rei++}>\\d+)`
  }
  function ce() {
    return `(?<colEnd${cei++}>\\d+)`
  }

  const eolSuffix = eolOnly ? '$' : ''

  // foo:339 · foo:339:12 · foo:339:12-789 · foo:339:12-341.789 · foo:339.12 · foo 339 ·
  // foo 339:12 · foo 339.12 · foo#339 · foo#339:12 · foo#339.12 · foo, 339 · "foo",339 ·
  // "foo",339:12 · "foo",339.12 · "foo",339.12-789 · "foo",339.12-341.789
  // "foo", line 339[, col 12] · "foo":line 339 · "foo": line 339 · "foo" on line 339 ·
  // "foo" line 339 column 12 · "foo", line 339, character 12 · "foo", lines 339-341
  // foo(339) · foo(339,12) · foo(339, 12) · foo (339) · foo: (339) · foo(339:12) — () and [] interchangeable
  const lineAndColumnRegexClauses = [
    `(?::|#| |['"],|, )${r()}([:.]${c()}(?:-(?:${re()}\\.)?${ce()})?)?` + eolSuffix,
    `['"]?(?:,? |: ?| on )lines? ${r()}(?:-${re()})?(?:,? (?:col(?:umn)?|characters?) ${c()}(?:-${ce()})?)?` + eolSuffix,
    `:? ?[\\[\\(]${r()}(?:(?:, ?|:)${c()})?[\\]\\)]` + eolSuffix,
  ]

  const suffixClause = lineAndColumnRegexClauses
    // Join all clauses together
    .join('|')
    // Convert spaces to allow the non-breaking space char (ascii 160)
    .replace(/ /g, `[${'\u00A0'} ]`)

  return new RegExp(`(${suffixClause})`, eolOnly ? undefined : 'g')
}

export function removeLinkSuffix(link) {
  const suffix = getLinkSuffix(link)?.suffix
  if (!suffix) {
    return link
  }
  return link.substring(0, suffix.index)
}

export function removeLinkQueryString(link) {
  // Skip ? in UNC paths
  const start = link.startsWith('\\\\?\\') ? 4 : 0
  const index = link.indexOf('?', start)
  if (index === -1) {
    return link
  }
  return link.substring(0, index)
}

export function detectLinkSuffixes(line) {
  // Find all suffixes on the line. Since the regex global flag is used, lastIndex will be updated
  // in place such that there are no overlapping matches.
  let match
  const results = []
  linkSuffixRegex.value.lastIndex = 0
  while ((match = linkSuffixRegex.value.exec(line)) !== null) {
    const suffix = toLinkSuffix(match)
    if (suffix === null) {
      break
    }
    results.push(suffix)
  }
  return results
}

export function getLinkSuffix(link) {
  return toLinkSuffix(linkSuffixRegexEol.value.exec(link))
}

export function toLinkSuffix(match) {
  const groups = match?.groups
  if (!groups || match.length < 1) {
    return null
  }
  return {
    row: parseIntOptional(groups.row0 || groups.row1 || groups.row2),
    col: parseIntOptional(groups.col0 || groups.col1 || groups.col2),
    rowEnd: parseIntOptional(groups.rowEnd0 || groups.rowEnd1 || groups.rowEnd2),
    colEnd: parseIntOptional(groups.colEnd0 || groups.colEnd1 || groups.colEnd2),
    suffix: { index: match.index, text: match[0] },
  }
}

function parseIntOptional(value) {
  if (value === undefined) {
    return value
  }
  return parseInt(value)
}

// This defines valid path characters for a link with a suffix, the first `[]` of the regex includes
// characters the path is not allowed to _start_ with, the second `[]` includes characters not
// allowed at all in the path. If the characters show up in both regexes the link will stop at that
// character, otherwise it will stop at a space character.
const linkWithSuffixPathCharacters = /(?<path>(?:file:\/\/\/)?[^\s\|<>\[\({][^\s\|<>]*)$/

export function detectLinks(line, os) {
  // 1: Detect all links on line via suffixes first
  const results = detectLinksViaSuffix(line)

  // 2: Detect all links without suffixes and merge non-conflicting ranges into the results
  const noSuffixPaths = detectPathsNoSuffix(line, os)
  binaryInsertList(results, noSuffixPaths)

  return results
}

function binaryInsertList(list, newItems) {
  if (list.length === 0) {
    list.push(...newItems)
  }
  for (const item of newItems) {
    binaryInsert(list, item, 0, list.length)
  }
}

function binaryInsert(list, newItem, low, high) {
  if (list.length === 0) {
    list.push(newItem)
    return
  }
  if (low > high) {
    return
  }
  // Find the index where the newItem would be inserted
  const mid = Math.floor((low + high) / 2)
  if (
    mid >= list.length ||
    (newItem.path.index < list[mid].path.index && (mid === 0 || newItem.path.index > list[mid - 1].path.index))
  ) {
    // Check if it conflicts with an existing link before adding
    if (
      mid >= list.length ||
      (newItem.path.index + newItem.path.text.length < list[mid].path.index && (mid === 0 || newItem.path.index > list[mid - 1].path.index + list[mid - 1].path.text.length))
    ) {
      list.splice(mid, 0, newItem)
    }
    return
  }
  if (newItem.path.index > list[mid].path.index) {
    binaryInsert(list, newItem, mid + 1, high)
  } else {
    binaryInsert(list, newItem, low, mid - 1)
  }
}

function detectLinksViaSuffix(line) {
  const results = []

  // 1: Detect link suffixes on the line
  const suffixes = detectLinkSuffixes(line)
  for (const suffix of suffixes) {
    // Ignore suffixes followed by `/` so numeric Git diff prefixes such as `1/` are parsed as paths.
    const suffixEndIndex = suffix.suffix.index + suffix.suffix.text.length
    if (line[suffixEndIndex] === '/') {
      continue
    }
    const beforeSuffix = line.substring(0, suffix.suffix.index)
    const possiblePathMatch = beforeSuffix.match(linkWithSuffixPathCharacters)
    if (possiblePathMatch && possiblePathMatch.index !== undefined && possiblePathMatch.groups?.path) {
      let linkStartIndex = possiblePathMatch.index
      let path = possiblePathMatch.groups.path
      // Extract a path prefix if it exists (not part of the path, but part of the underlined
      // section)
      let prefix = undefined
      const prefixMatch = path.match(/^(?<prefix>['"]+)/)
      if (prefixMatch?.groups?.prefix) {
        prefix = {
          index: linkStartIndex,
          text: prefixMatch.groups.prefix,
        }
        path = path.substring(prefix.text.length)

        // Don't allow suffix links to be returned when the link itself is the empty string
        if (path.trim().length === 0) {
          continue
        }

        // If there are multiple characters in the prefix, trim the prefix if the _first_
        // suffix character is the same as the last prefix character. For example, for the
        // text `echo "'foo' on line 1"`:
        //
        // - Prefix='
        // - Path=foo
        // - Suffix=' on line 1
        //
        // If this fails on a multi-character prefix, just keep the original.
        if (prefixMatch.groups.prefix.length > 1) {
          if (suffix.suffix.text[0].match(/['"]/) && prefixMatch.groups.prefix[prefixMatch.groups.prefix.length - 1] === suffix.suffix.text[0]) {
            const trimPrefixAmount = prefixMatch.groups.prefix.length - 1
            prefix.index += trimPrefixAmount
            prefix.text = prefixMatch.groups.prefix[prefixMatch.groups.prefix.length - 1]
            linkStartIndex += trimPrefixAmount
          }
        }
      }
      results.push({
        path: {
          index: linkStartIndex + (prefix?.text.length || 0),
          text: path,
        },
        prefix,
        suffix,
      })

      // If the path contains an opening bracket, provide the path starting immediately after
      // the opening bracket as an additional result
      const openingBracketMatch = path.matchAll(/(?<bracket>[\[\(])(?![\]\)])/g)
      for (const match of openingBracketMatch) {
        const bracket = match.groups?.bracket
        if (bracket) {
          results.push({
            path: {
              index: linkStartIndex + (prefix?.text.length || 0) + match.index + 1,
              text: path.substring(match.index + bracket.length),
            },
            prefix,
            suffix,
          })
        }
      }
    }
  }

  return results
}

const RegexPathConstants = Object.freeze({
  PathPrefix: '(?:\\.\\.?|\\~|file:\/\/)',
  PathSeparatorClause: '\\/',
  // '":; are allowed in paths but they are often separators so ignore them
  // Also disallow \\ to prevent a catastropic backtracking case #24795
  ExcludedPathCharactersClause: '[^\\0<>\\?\\s!`&*()\'":;\\\\]',
  ExcludedStartPathCharactersClause: '[^\\0<>\\?\\s!`&*()\\[\\]\'":;\\\\]',

  WinOtherPathPrefix: '\\.\\.?|\\~',
  WinPathSeparatorClause: '(?:\\\\|\\/)',
  WinExcludedPathCharactersClause: '[^\\0<>\\?\\|\\/\\s!`&*()\'":;]',
  WinExcludedStartPathCharactersClause: '[^\\0<>\\?\\|\\/\\s!`&*()\\[\\]\'":;]',
})

// A regex that matches non-Windows paths, such as `/foo`, `~/foo`, `./foo`, `../foo` and `foo/bar`.
const unixLocalLinkClause = '(?:(?:' + RegexPathConstants.PathPrefix + '|(?:' + RegexPathConstants.ExcludedStartPathCharactersClause + RegexPathConstants.ExcludedPathCharactersClause + '*))?(?:' + RegexPathConstants.PathSeparatorClause + '(?:' + RegexPathConstants.ExcludedPathCharactersClause + ')+)+)'

// A regex clause that matches the start of an absolute path on Windows, such as: `C:`, `c:`,
// `file:///c:` (uri) and `\\?\C:` (UNC path).
export const winDrivePrefix = '(?:\\\\\\\\\\?\\\\|file:\\/\\/\\/)?[a-zA-Z]:'

// A regex that matches Windows paths, such as `\\?\c:\foo`, `c:\foo`, `~\foo`, `.\foo`, `..\foo`
// and `foo\bar`.
const winLocalLinkClause = '(?:(?:' + `(?:${winDrivePrefix}|${RegexPathConstants.WinOtherPathPrefix})` + '|(?:' + RegexPathConstants.WinExcludedStartPathCharactersClause + RegexPathConstants.WinExcludedPathCharactersClause + '*))?(?:' + RegexPathConstants.WinPathSeparatorClause + '(?:' + RegexPathConstants.WinExcludedPathCharactersClause + ')+)+)'

// A regex clause that matches the known single-character prefixes used in git diffs.
// When diff.mnemonicPrefix is enabled, Git uses mnemonic letter prefixes and uses 1/ and 2/
// for `git diff --no-index`.
const diffFilePrefix = '[abciow12]\\/'

// A regex that matches git diff lines with filenames, such as `--- a/foo`, `+++ b/foo`.
const gitDiffLineRegex = lazyRegExp(() => new RegExp(`^[-+]{3} ${diffFilePrefix}`))
// A regex that matches filenames in lines like `diff --git a/foo b/foo` without the prefix.
const gitDiffTextRegex = lazyRegExp(() => new RegExp(`^${diffFilePrefix}`))

function detectPathsNoSuffix(line, os) {
  const results = []

  const regex = new RegExp(os === 'windows' ? winLocalLinkClause : unixLocalLinkClause, 'g')
  let match
  while ((match = regex.exec(line)) !== null) {
    let text = match[0]
    let index = match.index
    if (!text) {
      // Something matched but does not comply with the given match index, since this would
      // most likely a bug the regex itself we simply do nothing here
      break
    }

    // Adjust the link range to exclude a known Git diff prefix
    if (
      // --- a/foo/bar
      // +++ b/foo/bar
      (gitDiffLineRegex.value.test(line) && index === 4) ||
      // diff --git a/foo/bar b/foo/bar
      (line.startsWith('diff --git') && gitDiffTextRegex.value.test(text))
    ) {
      text = text.substring(2)
      index += 2
    }

    results.push({
      path: {
        index,
        text,
      },
      prefix: undefined,
      suffix: undefined,
    })
  }

  return results
}
// ---- end of the microsoft/vscode terminalLinkParsing.ts port (MIT) ----

// ---- output text ----

const ANSI_PATTERN = /\u001b\[[0-?]*[ -/]*[@-~]|\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)|\u001b[@-Z\\-_]/g

export function stripAnsi(text) {
  return typeof text === 'string' ? text.replace(ANSI_PATTERN, '') : ''
}

// Masks strings that look like credentials before the card shows them.
const SECRET_PATTERNS = [
  [/\b(sk-(?:ant-|proj-)?[A-Za-z0-9_-]{16,})/g, '•••'],
  [/\bgh[pousr]_[A-Za-z0-9]{20,}/g, '•••'],
  [/\bgithub_pat_[A-Za-z0-9_]{20,}/g, '•••'],
  [/\bxox[abprs]-[A-Za-z0-9-]{10,}/g, '•••'],
  [/\bAKIA[0-9A-Z]{16}\b/g, '•••'],
  [/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g, '•••'],
  [/(authorization\s*[:=]\s*(?:bearer|basic|token)\s+)[^\s"'`]+/gi, '$1•••'],
  [/((?:api[_-]?key|access[_-]?token|auth[_-]?token|secret|password|passwd)\s*[=:]\s*)(?:"[^"]*"|'[^']*'|\S+)/gi, '$1•••'],
]

export function maskSecrets(text) {
  let out = typeof text === 'string' ? text : ''
  for (const [pattern, replacement] of SECRET_PATTERNS) out = out.replace(pattern, replacement)
  return out
}

// string | {head, tail, omittedBytes, truncated} | {text} → {text, lines, truncated}
// The chat runtime's GET /chat/command-output capture keeps the first 8 KB in
// head and the last 64 KB in tail; with omittedBytes 0 the two are contiguous.
export function normalizeRunOutput(output) {
  let head = ''
  let tail = ''
  let truncated = false
  if (typeof output === 'string') tail = output
  else if (output && typeof output === 'object') {
    head = typeof output.head === 'string' ? output.head : ''
    tail = typeof output.tail === 'string' ? output.tail : typeof output.text === 'string' ? output.text : ''
    truncated = Boolean(output.truncated) || Number(output.omittedBytes) > 0
  }
  let text = head && tail ? `${head}${truncated ? '\n' : ''}${tail}` : head || tail
  const { maxScanChars, keepHeadChars } = RUN_RESULT_LIMITS
  if (text.length > maxScanChars) {
    text = `${text.slice(0, keepHeadChars)}\n${text.slice(-(maxScanChars - keepHeadChars))}`
    truncated = true
  }
  const lines = stripAnsi(text).replace(/\r\n/g, '\n').split('\n').map(line => {
    const carriage = line.lastIndexOf('\r')
    const visible = carriage >= 0 ? line.slice(carriage + 1) : line
    return visible.length > RUN_RESULT_LIMITS.maxLineChars ? visible.slice(0, RUN_RESULT_LIMITS.maxLineChars) : visible
  })
  return { text: lines.join('\n'), lines, truncated }
}

// ---- command ----

function unquoteShellWord(word) {
  // 'it'\''s' and 'it'"'"'s' are both how shells spell a quote inside quotes.
  if (word.length >= 2 && word[0] === "'" && word.at(-1) === "'") return word.slice(1, -1).replace(/'\\''/g, "'").replace(/'"'"'/g, "'")
  if (word.length >= 2 && word[0] === '"' && word.at(-1) === '"') return word.slice(1, -1).replace(/\\(["\\$`])/g, '$1')
  return word
}

// '/bin/zsh -lc "cd app && npm test"' → 'cd app && npm test'
export function unwrapShellCommand(command) {
  let text = typeof command === 'string' ? command.trim() : ''
  for (let depth = 0; depth < 3; depth++) {
    const match = text.match(/^(?:\S*\/)?(?:ba|z|da|k|fi)?sh\s+-[a-zA-Z]*c[a-zA-Z]*\s+([\s\S]+)$/)
    if (!match) break
    text = unquoteShellWord(match[1].trim())
  }
  return text
}

// Splits on && || ; | and newlines outside quotes.
export function splitShellSegments(command) {
  const text = typeof command === 'string' ? command : ''
  const segments = []
  let current = ''
  let quote = null
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]
    if (quote) {
      current += ch
      if (ch === quote) quote = null
      else if (ch === '\\' && quote === '"' && i + 1 < text.length) current += text[++i]
      continue
    }
    if (ch === "'" || ch === '"') { quote = ch; current += ch; continue }
    if (ch === '\\' && i + 1 < text.length) { current += ch + text[++i]; continue }
    const pair = text.slice(i, i + 2)
    if (pair === '&&' || pair === '||') { segments.push(current); current = ''; i++; continue }
    if (ch === ';' || ch === '|' || ch === '\n') { segments.push(current); current = ''; continue }
    current += ch
  }
  segments.push(current)
  return segments.map(segment => segment.trim()).filter(Boolean)
}

function shellWords(segment) {
  return (segment.match(/'[^']*'|"(?:\\.|[^"\\])*"|\S+/g) || []).map(unquoteShellWord)
}

const WRAPPERS = new Set(['time', 'env', 'nice', 'command', 'exec', 'npx', 'bunx', 'pnpx', 'stdbuf', 'timeout', 'gtimeout'])

function programWords(segment) {
  let words = shellWords(segment)
  for (let guard = 0; guard < 6 && words.length; guard++) {
    const first = words[0]
    if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(first)) { words = words.slice(1); continue }
    const name = first.replace(/^.*[\\/]/, '')
    if (WRAPPERS.has(name)) {
      words = words.slice(1)
      // timeout 60 cmd · env -i cmd · npx -y cmd
      while (words.length && (/^-/.test(words[0]) || /^\d+[smhd]?$/.test(words[0]))) words = words.slice(1)
      continue
    }
    if (['pnpm', 'yarn', 'npm'].includes(name) && ['exec', 'dlx'].includes(words[1])) { words = words.slice(2).filter((word, index) => index > 0 || word !== '--'); continue }
    if (['uv', 'poetry', 'pipenv', 'pdm'].includes(name) && words[1] === 'run') { words = words.slice(2); continue }
    if (/^python(?:\d+(?:\.\d+)?)?$/.test(name) && words[1] === '-m' && words[2]) { words = [words[2], ...words.slice(3)]; continue }
    break
  }
  return words.map((word, index) => index === 0 ? word.replace(/^.*[\\/]/, '').replace(/\.(?:cmd|exe|bat)$/i, '') : word)
}

function scriptKind(script) {
  const name = String(script || '').toLowerCase()
  if (!name) return null
  if (/(^|[:_-])(?:type-?check|check-?types|types|tsc)($|[:_-])/.test(name)) return { kind: 'typecheck', runner: null }
  if (/(^|[:_-])(?:test|spec|e2e)|^t$/.test(name)) return { kind: 'test', runner: null }
  if (/lint|stylelint|format:check|fmt:check|prettier/.test(name)) return { kind: 'lint', runner: null }
  if (/build|compile|bundle|dist|package/.test(name)) return { kind: 'build', runner: null }
  if (/^(?:dev|start|serve|preview|watch)/.test(name)) return { kind: 'run', runner: null }
  return { kind: 'other', runner: null }
}

function classifySegment(segment) {
  const words = programWords(segment)
  const [program = '', sub = ''] = words
  const has = flag => words.includes(flag)
  switch (program) {
    case '': case 'cd': case 'pushd': case 'popd': case 'export': case 'set': case 'source': case '.': case 'echo': case 'true':
      return null
    case 'node': return words.some(word => /^--test(?:$|[-=])/.test(word)) ? { kind: 'test', runner: 'node-test' } : { kind: 'run', runner: null }
    case 'deno': return sub === 'test' ? { kind: 'test', runner: 'deno-test' } : sub === 'lint' ? { kind: 'lint', runner: null } : sub === 'check' ? { kind: 'typecheck', runner: null } : { kind: 'run', runner: null }
    case 'jest': return { kind: 'test', runner: 'jest' }
    case 'vitest': return { kind: 'test', runner: 'vitest' }
    case 'mocha': case '_mocha': return { kind: 'test', runner: 'mocha' }
    case 'ava': case 'tap': case 'jasmine': case 'karma': return { kind: 'test', runner: null }
    case 'playwright': return sub === 'test' ? { kind: 'test', runner: 'playwright' } : { kind: 'run', runner: null }
    case 'cypress': return sub === 'run' ? { kind: 'test', runner: null } : { kind: 'run', runner: null }
    case 'pytest': case 'py.test': return { kind: 'test', runner: 'pytest' }
    case 'unittest': case 'nose2': case 'tox': case 'nox': return { kind: 'test', runner: null }
    case 'mypy': case 'pyright': case 'vue-tsc': return { kind: 'typecheck', runner: program === 'vue-tsc' ? 'tsc' : null }
    case 'tsc': return has('-b') || has('--build') ? { kind: 'build', runner: 'tsc' } : { kind: 'typecheck', runner: 'tsc' }
    case 'eslint': return { kind: 'lint', runner: 'eslint' }
    case 'ruff': case 'flake8': case 'pylint': case 'stylelint': case 'golangci-lint': case 'shellcheck': case 'biome': case 'oxlint': case 'swiftlint': case 'rubocop':
      return { kind: 'lint', runner: null }
    case 'prettier': return has('--check') || has('-c') ? { kind: 'lint', runner: null } : { kind: 'other', runner: null }
    case 'cargo':
      if (sub === 'test' || sub === 'nextest') return { kind: 'test', runner: sub === 'test' ? 'cargo-test' : null }
      if (sub === 'clippy' || (sub === 'fmt' && has('--check'))) return { kind: 'lint', runner: null }
      if (sub === 'build' || sub === 'check') return { kind: 'build', runner: null }
      if (sub === 'run') return { kind: 'run', runner: null }
      if (sub === 'add' || sub === 'install' || sub === 'fetch') return { kind: 'install', runner: null }
      return { kind: 'other', runner: null }
    case 'go':
      if (sub === 'test') return { kind: 'test', runner: 'go-test' }
      if (sub === 'build') return { kind: 'build', runner: null }
      if (sub === 'vet') return { kind: 'lint', runner: null }
      if (sub === 'run') return { kind: 'run', runner: null }
      if (sub === 'get' || sub === 'mod') return { kind: 'install', runner: null }
      return { kind: 'other', runner: null }
    case 'bun':
      if (sub === 'test') return { kind: 'test', runner: 'bun-test' }
      if (['install', 'i', 'add'].includes(sub)) return { kind: 'install', runner: null }
      return scriptKind(sub === 'run' ? words[2] : sub) || { kind: 'run', runner: null }
    case 'npm':
      if (['test', 't', 'tst'].includes(sub)) return { kind: 'test', runner: null }
      if (['install', 'i', 'ci', 'add', 'update'].includes(sub)) return { kind: 'install', runner: null }
      if (sub === 'run' || sub === 'run-script') return scriptKind(words[2]) || { kind: 'other', runner: null }
      if (sub === 'start') return { kind: 'run', runner: null }
      return { kind: 'other', runner: null }
    case 'pnpm': case 'yarn':
      if (!sub && program === 'yarn') return { kind: 'install', runner: null }
      if (['test', 't'].includes(sub)) return { kind: 'test', runner: null }
      if (['install', 'i', 'add', 'update', 'up'].includes(sub)) return { kind: 'install', runner: null }
      return scriptKind(sub === 'run' ? words[2] : sub) || { kind: 'other', runner: null }
    case 'vite': case 'next': case 'nuxt': case 'astro': case 'parcel':
      return sub === 'build' ? { kind: 'build', runner: null } : { kind: 'run', runner: null }
    case 'webpack': case 'rollup': case 'esbuild': case 'tsup': case 'swc': case 'babel':
      return { kind: 'build', runner: null }
    case 'make': case 'just':
      return /test|check/.test(sub) ? { kind: 'test', runner: null } : /lint/.test(sub) ? { kind: 'lint', runner: null } : { kind: 'build', runner: null }
    case 'gradle': case 'gradlew': case 'mvn': case 'mvnw': case 'dotnet': case 'swift': case 'xcodebuild': case 'flutter':
      if (words.some(word => /^(?:test|check|verify)$/.test(word))) return { kind: 'test', runner: null }
      if (words.some(word => /^(?:build|package|assemble|install|compile)$/.test(word))) return { kind: 'build', runner: null }
      return { kind: 'other', runner: null }
    case 'pip': case 'pip3': case 'brew': case 'apt': case 'apt-get': case 'gem': case 'bundle': case 'composer': case 'conda':
      return ['install', 'add', 'update', 'upgrade', 'sync'].includes(sub) || program === 'bundle' ? { kind: 'install', runner: null } : { kind: 'other', runner: null }
    case 'uv': return ['sync', 'add', 'pip'].includes(sub) ? { kind: 'install', runner: null } : { kind: 'other', runner: null }
    case 'poetry': return sub === 'install' || sub === 'add' ? { kind: 'install', runner: null } : { kind: 'other', runner: null }
    case 'git': case 'gh': return { kind: 'git', runner: null }
    case 'rg': case 'grep': case 'egrep': case 'ag': case 'ack': case 'fd': return { kind: 'search', runner: null }
    case 'ls': case 'tree': case 'find': return { kind: 'list', runner: null }
    case 'cat': case 'head': case 'tail': case 'sed': case 'nl': case 'less': case 'more': case 'bat': case 'wc': case 'awk':
      return { kind: 'read', runner: null }
    default: return { kind: 'other', runner: null }
  }
}

const ACTION_KINDS = Object.freeze({ read: 'read', listFiles: 'list', search: 'search' })

// → {kind, runner, label}. runner is null when the command only names a
// package script (npm test); detectRunner() then reads it from the output.
export function classifyCommand(command, { commandActions } = {}) {
  const inner = unwrapShellCommand(command)
  let best = null
  for (const segment of splitShellSegments(inner)) {
    const result = classifySegment(segment)
    if (!result) continue
    if (!best || KIND_PRIORITY[result.kind] > KIND_PRIORITY[best.kind] || (result.kind === best.kind && !best.runner && result.runner)) best = result
  }
  if ((!best || best.kind === 'other') && Array.isArray(commandActions) && commandActions.length) {
    const kinds = new Set(commandActions.map(action => ACTION_KINDS[action?.type]).filter(Boolean))
    if (kinds.size === 1 && commandActions.every(action => ACTION_KINDS[action?.type])) best = { kind: [...kinds][0], runner: null }
  }
  const kind = best?.kind || 'other'
  return { kind, runner: best?.runner || null, label: KIND_LABELS[kind] }
}

// Short display form: shell wrapper and leading `cd …` removed, ≤ 200 chars
// (t3code BACKGROUND_COMMAND_DETAIL_COMMAND_MAX_LENGTH).
export function commandDisplay(command) {
  const inner = unwrapShellCommand(command).replace(/^(?:cd\s+(?:'[^']*'|"[^"]*"|\S+)\s*&&\s*)+/, '').replace(/\s+/g, ' ').trim()
  const masked = maskSecrets(inner)
  const max = RUN_RESULT_LIMITS.commandDisplayChars
  return masked.length > max ? `${masked.slice(0, max)}…` : masked
}

// ---- runner detection and counts ----

export function detectRunner(text) {
  const out = typeof text === 'string' ? text : ''
  if (/^\s*ℹ tests \d+\s*$/m.test(out) || (/^# tests \d+\s*$/m.test(out) && /^# pass \d+\s*$/m.test(out))) return 'node-test'
  if (/^Tests:\s+.*\d+ total\s*$/m.test(out)) return 'jest'
  if (/^\s*Tests\s+.*\(\d+\)\s*$/m.test(out) || /^\s*Test Files\s+.*\(\d+\)\s*$/m.test(out)) return 'vitest'
  if (/^test result: (?:ok|FAILED)\. \d+ passed;/m.test(out)) return 'cargo-test'
  if (/^=+ .*\b(?:passed|failed|error|errors|skipped|no tests ran)\b.* in [\d.]+s(?: \([^)]*\))? =+\s*$/m.test(out)) return 'pytest'
  if (/^\s+\d+ passing \(/m.test(out)) return 'mocha'
  if (/^\s+\d+ (?:passed|failed|flaky) \([\d.]+m?s\)\s*$/m.test(out)) return 'playwright'
  if (/^\s*\d+ pass\s*$/m.test(out) && /^Ran \d+ tests? across/m.test(out)) return 'bun-test'
  if (/^(?:ok|FAILED) \| \d+ passed/m.test(out)) return 'deno-test'
  if (/^\s*--- (?:PASS|FAIL|SKIP): /m.test(out) || /^(?:ok|FAIL)\s+\S+\s+[\d.]+s\s*$/m.test(out)) return 'go-test'
  if (/\berror TS\d+:/.test(out) || /^Found \d+ errors?\b/m.test(out)) return 'tsc'
  if (/^\s*✖ \d+ problems? \(\d+ errors?, \d+ warnings?\)/m.test(out)) return 'eslint'
  return null
}

function lastMatch(text, pattern) {
  const flags = pattern.flags.includes('g') ? pattern.flags : `${pattern.flags}g`
  let found = null
  for (const match of text.matchAll(new RegExp(pattern.source, flags))) found = match
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

function finishCounts(counts, unit = 'test') {
  if (!counts) return null
  const total = counts.total ?? counts.passed + counts.failed + counts.skipped + counts.todo
  return { passed: counts.passed, failed: counts.failed, skipped: counts.skipped, todo: counts.todo, total, unit }
}

// → {passed, failed, skipped, todo, total, unit:'test'|'package'} | null
export function parseRunnerCounts(text, runner) {
  const out = typeof text === 'string' ? text : ''
  switch (runner) {
    case 'node-test': {
      const read = name => {
        const match = lastMatch(out, new RegExp(`^\\s*(?:ℹ|#) ${name} (\\d+)\\s*$`, 'm'))
        return match ? Number(match[1]) : null
      }
      const tests = read('tests')
      if (tests === null) return null
      return finishCounts({ passed: read('pass') ?? 0, failed: (read('fail') ?? 0) + (read('cancelled') ?? 0), skipped: read('skipped') ?? 0, todo: read('todo') ?? 0, total: tests })
    }
    case 'jest': {
      const line = lastMatch(out, /^Tests:\s+(.+)$/m)
      return line ? finishCounts(countsFromPairs(line[1], { passed: 'passed', failed: 'failed', skipped: 'skipped', todo: 'todo', total: 'total' })) : null
    }
    case 'vitest': {
      const line = lastMatch(out, /^\s*Tests\s+(.+)$/m)
      if (!line) return null
      const counts = countsFromPairs(line[1], { passed: 'passed', failed: 'failed', skipped: 'skipped', todo: 'todo' })
      const total = line[1].match(/\((\d+)\)\s*$/)
      if (counts && total) counts.total = Number(total[1])
      return finishCounts(counts)
    }
    case 'mocha': {
      const passing = lastMatch(out, /^\s+(\d+) passing\b/m)
      if (!passing) return null
      const failing = lastMatch(out, /^\s+(\d+) failing\b/m)
      const pending = lastMatch(out, /^\s+(\d+) pending\b/m)
      return finishCounts({ passed: Number(passing[1]), failed: failing ? Number(failing[1]) : 0, skipped: pending ? Number(pending[1]) : 0, todo: 0, total: null })
    }
    case 'playwright': {
      const read = word => { const match = lastMatch(out, new RegExp(`^\\s+(\\d+) ${word}\\b`, 'm')); return match ? Number(match[1]) : 0 }
      const counts = { passed: read('passed') + read('flaky'), failed: read('failed'), skipped: read('skipped') + read('did not run'), todo: 0, total: null }
      return counts.passed + counts.failed + counts.skipped ? finishCounts(counts) : null
    }
    case 'pytest': {
      const line = lastMatch(out, /^=+ (.+?) in [\d.]+s(?: \([^)]*\))? =+\s*$/m)
      if (!line) return null
      if (/no tests ran/.test(line[1])) return finishCounts({ passed: 0, failed: 0, skipped: 0, todo: 0, total: 0 })
      return finishCounts(countsFromPairs(line[1], { passed: 'passed', failed: 'failed', error: 'failed', errors: 'failed', skipped: 'skipped', xfailed: 'skipped', xpassed: 'passed' }))
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
    case 'go-test': {
      const count = word => [...out.matchAll(new RegExp(`^\\s*--- ${word}: `, 'gm'))].length
      const tests = { passed: count('PASS'), failed: count('FAIL'), skipped: count('SKIP'), todo: 0, total: null }
      if (tests.passed + tests.failed + tests.skipped) return finishCounts(tests)
      const okPackages = [...out.matchAll(/^ok\s+\S+/gm)].length
      const failedPackages = [...out.matchAll(/^FAIL\s+\S+\s+[\d.]+s\s*$/gm)].length
      return okPackages + failedPackages ? finishCounts({ passed: okPackages, failed: failedPackages, skipped: 0, todo: 0, total: null }, 'package') : null
    }
    case 'bun-test': {
      const read = word => { const match = lastMatch(out, new RegExp(`^\\s*(\\d+) ${word}\\s*$`, 'm')); return match ? Number(match[1]) : null }
      const passed = read('pass')
      if (passed === null) return null
      return finishCounts({ passed, failed: read('fail') ?? 0, skipped: read('skip') ?? 0, todo: read('todo') ?? 0, total: null })
    }
    case 'deno-test': {
      const line = lastMatch(out, /^(?:ok|FAILED) \| (\d+) passed(?: \(\d+ steps?\))? \| (\d+) failed(?: \(\d+ steps?\))?(?: \| (\d+) ignored)?/m)
      return line ? finishCounts({ passed: Number(line[1]), failed: Number(line[2]), skipped: Number(line[3] || 0), todo: 0, total: null }) : null
    }
    default: return null
  }
}

// tsc / eslint problem counts → {errors, warnings, files} | null
export function parseProblemCounts(text, runner) {
  const out = typeof text === 'string' ? text : ''
  if (runner === 'tsc') {
    const found = lastMatch(out, /^Found (\d+) errors?(?: in (\d+) files?| in [^\n]+)?\.?\s*$/m)
    if (found) return { errors: Number(found[1]), warnings: 0, files: found[2] ? Number(found[2]) : found[0].includes(' in ') ? 1 : null }
    const lines = [...out.matchAll(/\berror TS\d+:/g)].length
    return lines ? { errors: lines, warnings: 0, files: null } : null
  }
  if (runner === 'eslint') {
    const summary = lastMatch(out, /^\s*✖ (\d+) problems? \((\d+) errors?, (\d+) warnings?\)/m)
    return summary ? { errors: Number(summary[2]), warnings: Number(summary[3]), files: null } : null
  }
  return null
}

// ---- locations ----

function isWindowsPath(value) {
  return typeof value === 'string' && (/^[A-Za-z]:[\\/]/.test(value) || value.startsWith('\\\\'))
}

function guessOs(ctx) {
  if (ctx?.os === 'windows' || ctx?.os === 1) return 'windows'
  if (ctx?.os) return 'posix'
  return isWindowsPath(ctx?.projectRoot) || isWindowsPath(ctx?.cwd) ? 'windows' : 'posix'
}

function normalizeSlashes(value) {
  return value.replace(/\\/g, '/')
}

// Lexical join + '.'/'..' folding; never touches the filesystem.
function joinPath(base, relative) {
  const windows = isWindowsPath(base)
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

const NON_PROJECT_PATH = /^(?:node:|internal[\\/]|<anonymous>|\[eval|evalmachine)|(?:^|[\\/])node_modules[\\/]|(?:^|[\\/])\.pnpm[\\/]|(?:^|[\\/])site-packages[\\/]|(?:^|[\\/])\.cargo[\\/]registry[\\/]|^\/rustc\//

function sourceLike(path) {
  if (!path || path.length > 1024 || /^\d+$/.test(path)) return false
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(path)) return false
  return /[\\/]/.test(path) || /\.[A-Za-z][A-Za-z0-9]{0,9}$/.test(path)
}

// A raw path from output → {path, relativePath, line, column, label, inProject} | null
export function resolveOutputLocation(rawPath, line, column, ctx = {}) {
  if (typeof rawPath !== 'string' || !Number.isInteger(line) || line < 1) return null
  let path = rawPath.trim().replace(/[),:;.]+$/, '')
  if (/^file:\/\//i.test(path)) {
    path = path.replace(/^file:\/\/(?:localhost)?/i, '')
    try { path = decodeURIComponent(path) } catch {}
    if (/^\/[A-Za-z]:\//.test(path)) path = path.slice(1)
  }
  if (!sourceLike(path) || NON_PROJECT_PATH.test(path)) return null
  const root = typeof ctx.projectRoot === 'string' && ctx.projectRoot ? ctx.projectRoot : null
  const cwd = typeof ctx.cwd === 'string' && ctx.cwd ? ctx.cwd : root
  const absolute = path.startsWith('/') || isWindowsPath(path)
  const home = path.startsWith('~')
  const absolutePath = absolute ? path : cwd && !home ? joinPath(cwd, path) : null
  let relativePath = null
  let inProject = !home
  if (root) {
    const base = normalizeSlashes(root).replace(/\/+$/, '')
    const target = absolutePath ? normalizeSlashes(absolutePath) : null
    const caseFold = isWindowsPath(root)
    const same = (a, b) => caseFold ? a.toLowerCase() === b.toLowerCase() : a === b
    if (target && target.length > base.length + 1 && same(target.slice(0, base.length + 1), `${base}/`)) {
      relativePath = target.slice(base.length + 1)
      inProject = true
    } else inProject = false
  } else if (!absolute && !home) relativePath = normalizeSlashes(path).replace(/^\.\//, '')
  const shown = relativePath || path
  const col = Number.isInteger(column) && column > 0 ? column : null
  return { path: absolutePath || path, relativePath, line, column: col, label: col ? `${shown}:${line}:${col}` : `${shown}:${line}`, inProject }
}

function locationsInLine(line, ctx, os) {
  const found = []
  for (const link of detectLinks(line, os)) {
    if (!link.suffix?.row) continue
    const location = resolveOutputLocation(link.path.text, link.suffix.row, link.suffix.col, ctx)
    if (location) found.push(location)
  }
  return found
}

const STACK_LINE = /^\s*(?:at\s|File\s"|❯\s|→\s|\d+:\s+0x)/

const PYTHON_TRACEBACK = /Traceback \(most recent call last\)/

// First stack frame that is a project file (test-reporter getExceptionSource
// pattern: skip internal/ and node_modules; keep only project files). A Python
// traceback lists the innermost call last, so it is read bottom-up.
export function firstProjectFrame(stack, ctx = {}) {
  const lines = Array.isArray(stack) ? stack : typeof stack === 'string' ? stack.split(/\r?\n/) : []
  const os = guessOs(ctx)
  const ordered = lines.some(line => PYTHON_TRACEBACK.test(line)) ? [...lines].reverse() : lines
  for (const line of ordered) {
    if (!STACK_LINE.test(line)) continue
    const hit = locationsInLine(line.slice(0, RUN_RESULT_LIMITS.maxLineChars), ctx, os).find(location => location.inProject)
    if (hit) return hit
  }
  return null
}

// First project location in a block: stack frames first, then any line.
export function firstProjectLocation(lines, ctx = {}) {
  const frame = firstProjectFrame(lines, ctx)
  if (frame) return frame
  const os = guessOs(ctx)
  for (const line of lines) {
    const hit = locationsInLine(line, ctx, os).find(location => location.inProject)
    if (hit) return hit
  }
  return null
}

// ---- failures ----

function shortMessage(text) {
  const trimmed = maskSecrets(String(text || '').trim())
  const max = RUN_RESULT_LIMITS.maxMessageChars
  return trimmed.length > max ? `${trimmed.slice(0, max)}…` : trimmed
}

function messageAfter(lines, start, end) {
  // TAP (node --test-reporter=tap) keeps the message in a YAML 'error:' field.
  for (let i = start; i < end; i++) {
    const tap = lines[i].match(/^\s+error:\s*(.*)$/)
    if (!tap) continue
    if (!/^[|>][-+]?$/.test(tap[1].trim())) return shortMessage(tap[1].trim().replace(/^'(.*)'$/, '$1'))
    const next = lines.slice(i + 1, end).find(line => line.trim())
    if (next) return shortMessage(next)
  }
  for (let i = start; i < end; i++) {
    const line = lines[i]?.trim()
    if (!line || STACK_LINE.test(lines[i]) || /^[-─=~^]+$/.test(line) || /^\d+\s*\|/.test(line) || /^>\s*\d+\s*\|/.test(line)) continue
    return shortMessage(line)
  }
  return null
}

// Per runner, marker patterns in priority order: the first pattern that finds
// any failure is used alone (vitest prints each failure as '×' and again as
// 'FAIL file > name'; node prints spec '✖' or TAP 'not ok', never both).
const FAILURE_MARKERS = Object.freeze({
  'node-test': [/^\s*✖ (.+?)(?: \([\d.]+m?s\))?\s*$/, /^\s*not ok \d+ - (.+?)\s*(?:#.*)?$/],
  jest: [/^\s*● (.+?)\s*$/],
  vitest: [/^\s*FAIL\s+(.+?)\s*$/, /^\s*[×✗] (.+?)(?: \d+m?s)?\s*$/],
  mocha: [/^\s+\d+\) (.+?)\s*$/],
  playwright: [/^\s+\d+\) (.+?)\s*─*\s*$/],
  pytest: [/^(?:FAILED|ERROR) (\S+?)(?: - (.*))?$/],
  'cargo-test': [/^---- (\S+) stdout ----$/],
  'go-test': [/^\s*--- FAIL: (\S+)/],
  'bun-test': [/^\(fail\) (.+?)(?: \[[\d.]+m?s\])?\s*$/],
  'deno-test': [/^(.+?) => \S+:\d+:\d+\s*$/],
})

// Runners that print a failure's error *before* its marker line (bun; go
// test -v prints t.Errorf output before '--- FAIL'). The lines read back stop
// at the previous test's own line.
const BEFORE_MARKER_BOUNDARY = Object.freeze({
  'go-test': /^\s*(?:=== (?:RUN|CONT|PAUSE)|--- (?:PASS|FAIL|SKIP):)/,
  'bun-test': /^(?:\((?:pass|fail|skip|todo)\)|[✓✗×]) |^\S.*:\s*$/,
})

function markerStart(lines, runner) {
  // node's spec reporter prints '✖ name' inline without details and repeats
  // it with the error and stack under '✖ failing tests:' (node 24 output).
  if (runner === 'node-test') return Math.max(0, lines.findIndex(line => /^\s*✖ failing tests:?\s*$/.test(line)))
  // mocha lists failure details after 'N failing'.
  if (runner === 'mocha') return Math.max(0, lines.findIndex(line => /^\s+\d+ failing\b/.test(line)))
  if (runner === 'deno-test') return Math.max(0, lines.findIndex(line => /^\s*ERRORS\s*$/.test(line)))
  return 0
}

function findMarks(lines, runner, start) {
  for (const pattern of FAILURE_MARKERS[runner] || []) {
    const marks = []
    for (let i = start; i < lines.length; i++) {
      const match = lines[i].match(pattern)
      if (!match) continue
      let name = match[1].trim()
      if (runner === 'node-test' && /^failing tests:?$/.test(name)) continue
      let skip = 0
      // mocha: '  1) suite' then '       test name:'
      if (runner === 'mocha' && i + 1 < lines.length && /^\s{4,}\S.*:\s*$/.test(lines[i + 1])) {
        name = `${name} › ${lines[i + 1].trim().replace(/:$/, '')}`
        skip = 1
      }
      marks.push({ index: i, name, skip, inlineMessage: match[2] || null })
    }
    if (marks.length) return marks
  }
  return []
}

function errorLineIn(block) {
  const line = block.find(text => ERRORISH.test(text) && !STACK_LINE.test(text))
  return line ? shortMessage(line) : null
}

function markerFailures(lines, runner, ctx) {
  if (!FAILURE_MARKERS[runner]) return []
  const marks = findMarks(lines, runner, markerStart(lines, runner))
  const seen = new Set()
  const failures = []
  marks.forEach((mark, n) => {
    if (seen.has(mark.name) || failures.length >= RUN_RESULT_LIMITS.maxFailures) return
    seen.add(mark.name)
    const end = Math.min(marks[n + 1]?.index ?? lines.length, mark.index + RUN_RESULT_LIMITS.failureBlockLines)
    const block = lines.slice(mark.index, end)
    let location = firstProjectLocation(block, ctx)
    let message = mark.inlineMessage ? shortMessage(mark.inlineMessage) : messageAfter(lines, mark.index + 1 + mark.skip, end)
    const boundary = BEFORE_MARKER_BOUNDARY[runner]
    if (boundary) {
      const floor = Math.max(n > 0 ? marks[n - 1].index + 1 : 0, mark.index - RUN_RESULT_LIMITS.failureBlockLines)
      let from = mark.index - 1
      while (from >= floor && !boundary.test(lines[from])) from--
      const before = lines.slice(Math.max(from + 1, floor), mark.index)
      if (!location) location = firstProjectLocation(before, ctx)
      if (runner === 'go-test') {
        // t.Errorf lines are indented: after '--- FAIL' normally, before it with -v.
        const indented = line => /^\s{2,}\S/.test(line)
        const text = lines.slice(mark.index + 1, end).find(indented) ?? before.find(indented)
        if (text) message = shortMessage(text)
      } else message = errorLineIn(before) || message
    }
    if (!location && runner === 'pytest') {
      const file = mark.name.split('::')[0]
      const hit = lines.find(line => line.startsWith(`${file}:`) && /^\S+:\d+: /.test(line))
      const lineNo = hit ? Number(hit.slice(file.length + 1).match(/^(\d+)/)?.[1]) : null
      location = lineNo ? resolveOutputLocation(file, lineNo, null, ctx) : null
    }
    failures.push({ name: shortMessage(mark.name), message, location })
  })
  return failures
}

// tsc: 'src/a.ts(3,5): error TS2322: …' and 'src/a.ts:3:5 - error TS2322: …'
function tscFailures(lines, ctx) {
  const failures = []
  for (const line of lines) {
    const match = line.match(/^(.+?)(?:\((\d+),(\d+)\)|:(\d+):(\d+))\s*(?::|-)\s*error\s+(TS\d+)\s*:\s*(.*)$/)
    if (!match) continue
    const row = Number(match[2] || match[4])
    const col = Number(match[3] || match[5])
    failures.push({ name: match[6], message: shortMessage(match[7]), location: resolveOutputLocation(match[1], row, col, ctx) })
    if (failures.length >= RUN_RESULT_LIMITS.maxFailures) break
  }
  return failures
}

// eslint stylish (vscode problemMatcher 'eslint-stylish' regular expressions).
const ESLINT_FILE = /^((?:[a-zA-Z]:)*[./\\]+.*?)$/
const ESLINT_PROBLEM = /^\s+(\d+):(\d+)\s+(error|warning|info)\s+(.+?)(?:\s\s+(.*))?$/

function eslintFailures(lines, ctx) {
  const failures = []
  let file = null
  for (const line of lines) {
    const problem = line.match(ESLINT_PROBLEM)
    if (problem && file) {
      if (problem[3] !== 'error') continue
      failures.push({ name: problem[5] || 'eslint', message: shortMessage(problem[4]), location: resolveOutputLocation(file, Number(problem[1]), Number(problem[2]), ctx) })
      if (failures.length >= RUN_RESULT_LIMITS.maxFailures) break
      continue
    }
    const header = line.match(ESLINT_FILE)
    if (header) file = header[1].trim()
    else if (!line.trim()) file = null
  }
  return failures
}

const ERRORISH = /\b(?:error|Error|ERROR|failed|FAILED|FAIL|panic(?:ked)?|Exception|Traceback)\b/

function genericFailure(lines, ctx) {
  const start = lines.findIndex(line => ERRORISH.test(line))
  if (start < 0) return []
  const block = lines.slice(start, start + RUN_RESULT_LIMITS.failureBlockLines)
  const location = firstProjectLocation(block, ctx)
  // A Python traceback ends with the exception line ('ValueError: …').
  const message = PYTHON_TRACEBACK.test(lines[start])
    ? block.slice(1).filter(line => line.trim() && !/^\s/.test(line)).at(0) ?? lines[start]
    : lines[start]
  return [{ name: null, message: shortMessage(message), location }]
}

export function extractFailures(lines, runner, ctx = {}) {
  const list = Array.isArray(lines) ? lines : normalizeRunOutput(lines).lines
  if (runner === 'tsc') return tscFailures(list, ctx)
  if (runner === 'eslint') return eslintFailures(list, ctx)
  const marked = markerFailures(list, runner, ctx)
  return marked.length ? marked : genericFailure(list, ctx)
}

// ---- card ----

export function durationLabel(ms) {
  if (!Number.isFinite(ms) || ms < 0) return ''
  if (ms < 60000) return `${(ms / 1000).toFixed(1)}초`
  const minutes = Math.floor(ms / 60000)
  const seconds = Math.round((ms % 60000) / 1000)
  return seconds ? `${minutes}분 ${seconds}초` : `${minutes}분`
}

function outputTail(lines) {
  const trimmed = [...lines]
  while (trimmed.length && !trimmed.at(-1).trim()) trimmed.pop()
  let tail = trimmed.slice(-RUN_RESULT_LIMITS.tailLines).join('\n')
  if (tail.length > RUN_RESULT_LIMITS.tailChars) tail = `…${tail.slice(-RUN_RESULT_LIMITS.tailChars)}`
  return maskSecrets(tail)
}

function decideOutcome({ status, exitCode, counts, problems }) {
  if (status === 'declined') return 'declined'
  if (status === 'inProgress') return 'running'
  if (counts?.failed > 0 || problems?.errors > 0) return 'failed'
  if (exitCode === 0) return 'passed'
  if (Number.isInteger(exitCode)) return 'failed'
  if (status === 'failed') return 'failed'
  if (status === 'completed' && (counts || problems)) return 'passed'
  return 'unknown'
}

function headlineFor({ kind, outcome, counts, problems, exitCode }) {
  if (outcome === 'running') return '실행 중'
  if (outcome === 'declined') return '실행하지 않음 · 거절됨'
  const exit = Number.isInteger(exitCode) && exitCode !== 0 ? `종료 코드 ${exitCode}` : null
  if (counts) {
    const unit = counts.unit === 'package' ? '패키지 ' : ''
    const parts = [`${unit}${counts.passed} 통과`]
    if (counts.failed > 0) parts.push(`${counts.failed} 실패`)
    if (counts.skipped > 0) parts.push(`${counts.skipped} 건너뜀`)
    if (counts.todo > 0) parts.push(`${counts.todo} 할 일`)
    if (outcome === 'failed' && counts.failed === 0 && exit) parts.push(exit)
    return parts.join(' · ')
  }
  if (problems && kind === 'typecheck') {
    if (problems.errors > 0) return `타입 오류 ${problems.errors}개${problems.files ? ` · 파일 ${problems.files}개` : ''}`
    if (outcome === 'passed') return '타입 오류 없음'
  }
  if (problems && kind === 'lint') {
    const total = problems.errors + problems.warnings
    if (total > 0) return `문제 ${total}개 · 오류 ${problems.errors} · 경고 ${problems.warnings}`
    if (outcome === 'passed') return '문제 없음'
  }
  const passedWords = { test: '테스트 통과', typecheck: '타입 오류 없음', lint: '문제 없음', build: '빌드 성공', install: '설치 완료' }
  const failedWords = { test: '테스트 실패', typecheck: '타입 검사 실패', lint: '코드 검사 실패', build: '빌드 실패', install: '설치 실패' }
  if (outcome === 'passed') return passedWords[kind] || '완료'
  if (outcome === 'failed') return [failedWords[kind] || '실패', exit].filter(Boolean).join(' · ')
  return '요약 없음 · 원문 보기'
}

// input: {command, exitCode, status, durationMs, output, cwd, projectRoot, commandActions, os}
export function summarizeRunResult(input = {}) {
  const ctx = { cwd: input.cwd || null, projectRoot: input.projectRoot || null, os: input.os || null }
  const classified = classifyCommand(input.command, { commandActions: input.commandActions })
  const { lines, truncated } = normalizeRunOutput(input.output)
  const text = lines.join('\n')
  const runner = classified.runner || detectRunner(text)
  const kind = classified.kind === 'other' && runner ? (runner === 'tsc' ? 'typecheck' : runner === 'eslint' ? 'lint' : 'test') : classified.kind
  const counts = runner ? parseRunnerCounts(text, runner) : null
  const problems = runner ? parseProblemCounts(text, runner) : null
  const exitCode = Number.isInteger(input.exitCode) ? input.exitCode : null
  const status = ['inProgress', 'completed', 'failed', 'declined'].includes(input.status) ? input.status : null
  const outcome = decideOutcome({ status, exitCode, counts, problems })
  const failures = outcome === 'failed' ? extractFailures(lines, runner, ctx) : []
  const firstLocation = failures.find(failure => failure.location)?.location || null
  const durationMs = Number.isFinite(input.durationMs) ? input.durationMs : null
  return {
    kind, runner, label: KIND_LABELS[kind],
    command: commandDisplay(input.command),
    outcome,
    headline: headlineFor({ kind, outcome, counts, problems, exitCode }),
    counts, problems, failures, firstLocation,
    exitCode, durationMs, durationLabel: durationLabel(durationMs ?? NaN),
    tail: outputTail(lines),
    // No counts, problems or exit code to read: the card says so and shows the output.
    summaryless: outcome === 'unknown' && !counts && !problems,
    outputTruncated: truncated,
  }
}

// A Codex commandExecution item (aggregatedOutput) or the runtime's captured
// output for it ({head, tail, omittedBytes}) → card.
export function runResultFromCodexItem(item, { output, projectRoot, os } = {}) {
  return summarizeRunResult({
    command: item?.command, exitCode: item?.exitCode, status: item?.status, durationMs: item?.durationMs,
    cwd: item?.cwd, commandActions: item?.commandActions, output: output ?? item?.aggregatedOutput ?? '', projectRoot, os,
  })
}

export function runResultTitle(result) {
  return result?.command ? `${result.label} · ${result.command}` : result?.label || KIND_LABELS.other
}

export function runResultAriaLabel(result) {
  const where = result?.firstLocation ? `, 첫 실패 위치 ${result.firstLocation.relativePath || result.firstLocation.path} ${result.firstLocation.line}행` : ''
  return `${result?.label || KIND_LABELS.other} 결과: ${result?.headline || ''}${where}`
}

// Plain DOM for the result card. Class names are the contract with the surface
// CSS (egdesk-run-result-*). onOpenLocation(location) — optional; turns each
// failure location into a button that opens the file at that line.
export function renderRunResultCard({ document, result, onOpenLocation, maxFailures = 5 } = {}) {
  if (!document?.createElement) throw new TypeError('renderRunResultCard requires a document')
  if (!result) throw new TypeError('renderRunResultCard requires a result')
  const el = (tag, className, text) => {
    const node = document.createElement(tag)
    if (className) node.className = className
    if (text != null) node.textContent = text
    return node
  }
  const card = el('section', 'egdesk-run-result')
  card.setAttribute('data-outcome', result.outcome)
  card.setAttribute('data-kind', result.kind)
  card.setAttribute('aria-label', runResultAriaLabel(result))
  const header = el('div', 'egdesk-run-result-header')
  header.append(el('span', 'egdesk-run-result-kind', result.label), el('strong', 'egdesk-run-result-headline', result.headline))
  card.append(header)
  const meta = el('p', 'egdesk-run-result-meta')
  if (result.command) meta.append(el('code', 'egdesk-run-result-command', result.command))
  if (result.durationLabel) meta.append(el('span', 'egdesk-run-result-duration', result.durationLabel))
  if (Number.isInteger(result.exitCode)) meta.append(el('span', 'egdesk-run-result-exit', `종료 코드 ${result.exitCode}`))
  card.append(meta)
  const shown = result.failures.slice(0, maxFailures)
  if (shown.length) {
    const list = el('ul', 'egdesk-run-result-failures')
    list.setAttribute('aria-label', '실패 목록')
    for (const failure of shown) {
      const item = el('li', 'egdesk-run-result-failure')
      if (failure.name) item.append(el('span', 'egdesk-run-result-failure-name', failure.name))
      if (failure.location) {
        if (typeof onOpenLocation === 'function') {
          const button = el('button', 'egdesk-run-result-location', failure.location.label)
          button.type = 'button'
          button.setAttribute('aria-label', `${failure.location.label} 열기`)
          const location = failure.location
          button.addEventListener('click', () => onOpenLocation(location))
          item.append(button)
        } else item.append(el('span', 'egdesk-run-result-location', failure.location.label))
      }
      if (failure.message) item.append(el('p', 'egdesk-run-result-failure-message', failure.message))
      list.append(item)
    }
    card.append(list)
    if (result.failures.length > shown.length) card.append(el('p', 'egdesk-run-result-more', `그 밖에 실패 ${result.failures.length - shown.length}개`))
  }
  if (result.tail) {
    const details = el('details', 'egdesk-run-result-output')
    if (result.summaryless) details.open = true
    details.append(el('summary', 'egdesk-run-result-output-summary', result.outputTruncated ? '출력 끝부분 (앞부분 일부 생략됨)' : '출력 끝부분'))
    details.append(el('pre', 'egdesk-run-result-tail', result.tail))
    card.append(details)
  }
  return card
}
