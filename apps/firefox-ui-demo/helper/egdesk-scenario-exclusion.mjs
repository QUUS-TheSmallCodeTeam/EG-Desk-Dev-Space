// Owner exclusion for the simulation scenarios (cycle 43). The owner: conversations of projects under a private folder, and examples that mention them, are never used in simulation scenarios.
// What is excluded lives in a LOCAL file OUTSIDE the repository (default: <loop dir>/evidence/conversation-examples/local/exclude.json under the home folder; EGDESK_SCENARIO_EXCLUDE or an
// explicit file names another):
//   { "excludeCwdPrefixes": ["/absolute/or/~/folder", ...], "excludeTerms": ["a name or phrase", ...] }
// A session whose working folder is at or under a prefix is dropped whole; a Claude project folder whose encoded name is that prefix (or under it) is not read at all; an example whose text, project or
// file contains a term (NFKC, case-insensitive) is dropped. Nothing about the excluded material is written anywhere: the extractor counts (manifest.excludedByOwner), the seed guard refuses
// with a text that does not repeat the term. NO name from that file belongs in a tracked file, a test or a report (tests use synthetic names). A missing file means nothing is excluded; a file that is
// there but cannot be read or has the wrong shape is an error (fail closed, the content is never printed).
import { existsSync, readFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

export const EXCLUDE_ENV = 'EGDESK_SCENARIO_EXCLUDE'
export const defaultExcludeFile = (home = os.homedir()) => path.join(home, '.aside', 'u', '0', 'sessions', '2026-11-15_5yGDgeI9gUvBBXY9', 'tmp', 'decision-loop', 'evidence', 'conversation-examples', 'local', 'exclude.json')
const fold = text => String(text ?? '').normalize('NFKC').toLowerCase()
const expand = (p, home) => (p === '~' ? home : p.startsWith('~/') ? path.join(home, p.slice(2)) : p)
// Claude Code names a project folder for its path with every character that is not a letter or digit turned into "-"
const encode = text => fold(text).replace(/[^a-z0-9]/g, '-')

/** createOwnerExclusions({ excludeCwdPrefixes, excludeTerms }, home) -> { active, counts, cwdExcluded(cwd), projectDirExcluded(name), textExcluded(text) } */
export function createOwnerExclusions({ excludeCwdPrefixes = [], excludeTerms = [] } = {}, home = os.homedir()) {
  const prefixes = excludeCwdPrefixes.map(p => fold(path.resolve(expand(p, home)))), terms = excludeTerms.map(fold)
  const dirs = prefixes.map(encode), termDirs = terms.map(encode).filter(t => t.replace(/-/g, '').length >= 2)
  return Object.freeze({
    active: prefixes.length + terms.length > 0, counts: { cwdPrefixes: prefixes.length, terms: terms.length },
    cwdExcluded: cwd => typeof cwd === 'string' && cwd !== '' && (c => prefixes.some(p => c === p || c.startsWith(p.endsWith(path.sep) ? p : p + path.sep)))(fold(path.resolve(cwd))),
    projectDirExcluded: name => (n => dirs.some(d => n === d || n.startsWith(d + '-')) || termDirs.some(t => n.includes(t)))(encode(name)),
    textExcluded: text => (t => terms.some(x => t.includes(x)))(fold(text)),
  })
}
export const noExclusions = createOwnerExclusions()

/** loadOwnerExclusions({ env, file, home }) -> the exclusions of the local file (none when it does not exist). Throws a message without content when it is unreadable or malformed. */
export function loadOwnerExclusions({ env = process.env, file = null, home = os.homedir() } = {}) {
  const target = file ?? (env?.[EXCLUDE_ENV] ? env[EXCLUDE_ENV] : defaultExcludeFile(home))
  if (!existsSync(target)) return noExclusions
  let raw
  try { raw = JSON.parse(readFileSync(target, 'utf8')) } catch { throw new Error('the owner exclusion file is unreadable') }
  const strings = (v, min) => v === undefined || (Array.isArray(v) && v.length <= 200 && v.every(x => typeof x === 'string' && x.trim().length >= min))
  if (!raw || typeof raw !== 'object' || Array.isArray(raw) || Object.keys(raw).some(k => !['excludeCwdPrefixes', 'excludeTerms'].includes(k)) || !strings(raw.excludeCwdPrefixes, 1) || !strings(raw.excludeTerms, 2))
    throw new Error('the owner exclusion file has the wrong shape (excludeCwdPrefixes, excludeTerms: lists of strings; a term has at least 2 characters)')
  return createOwnerExclusions({ excludeCwdPrefixes: raw.excludeCwdPrefixes ?? [], excludeTerms: raw.excludeTerms ?? [] }, home)
}
