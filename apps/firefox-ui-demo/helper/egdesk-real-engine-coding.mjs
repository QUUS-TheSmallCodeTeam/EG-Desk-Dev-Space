// c29: a realistic coding task on EG-Desk's own tools, judged by code (registered in helper/egdesk-real-engine-registrations.mjs, slot L5). A small scratch project (two source
// files, a node --test file with one failing test), the person asks "테스트 실패 고쳐 주고 다시 돌려 줘"; the engine reads, edits with preview and undo records, runs the tests
// through EG-Desk's runner; the run-conditions arbiter (egdesk-run-conditions.mjs) reads the test summary line; the draft check judges the answer's "all passed" against it.
//
// turn.expect.coding {
//   changed: [paths]            exactly these project files differ from the script's folder afterwards; none added, none removed (the fix lands in the right file and nowhere else)
//   lastTests: { health?, failed?, minFailed?, minPassed? }   the arbiter's reading of the LAST command EG-Desk ran in the turn: health healthy | unhealthy | unknown, the runner's counts
//   earlierFailure: true        a command before the last one saw a failing test (the engine looked at the failure before it fixed)
//   answerEvidence: true        what the draft check of the answer is offered (the run's own commands) holds the last command's runner counts; with --decisions the check's own
//                               verdict is in draftCheck.rows (and expect.draftCheck)
//   nothingOutside: true        the engine's own folder is still empty, the scratch folder has no link, and the scratch folder's neighbours are what they were
// }
import fs from 'node:fs'
import path from 'node:path'

export const CODING_KEYS = Object.freeze(['changed', 'lastTests', 'earlierFailure', 'answerEvidence', 'nothingOutside'])
const HEALTHS = ['healthy', 'unhealthy', 'unknown']
const LIMITS = Object.freeze({ files: 200, fileBytes: 256 * 1024, paths: 20 })
const isObject = v => v !== null && typeof v === 'object' && !Array.isArray(v)

export const CODING_EXPECT_SCHEMA = Object.freeze({ type: 'object', additionalProperties: false, minProperties: 1, properties: {
  changed: { type: 'array', maxItems: LIMITS.paths, items: { type: 'string', minLength: 1, maxLength: 200 } },
  lastTests: { type: 'object', additionalProperties: false, minProperties: 1, properties: { health: { enum: HEALTHS }, failed: { type: 'integer', minimum: 0 }, minFailed: { type: 'integer', minimum: 1 }, minPassed: { type: 'integer', minimum: 1 } } },
  earlierFailure: { const: true }, answerEvidence: { const: true }, nothingOutside: { const: true } } })

export function validateCodingExpect(value, conv, turn, where = '$.expect.coding') {
  const errors = []
  if (!isObject(value) || !Object.keys(value).length) return [`${where}: an object with at least one of ${CODING_KEYS.join(', ')}`]
  for (const key of Object.keys(value)) if (!CODING_KEYS.includes(key)) errors.push(`${where}.${key}: unknown key`)
  if (turn.action !== undefined) errors.push(`${where}: only on a message turn`)
  if (value.changed !== undefined) {
    if (!Array.isArray(value.changed) || value.changed.length > LIMITS.paths || value.changed.some(p => typeof p !== 'string' || !p || p.startsWith('/') || p.split('/').includes('..'))) errors.push(`${where}.changed: relative paths inside the folder`)
    else for (const p of value.changed) if (!Object.hasOwn(conv.folder ?? {}, p)) errors.push(`${where}.changed: ${p} is not a file of the conversation's folder`)
  }
  if (value.lastTests !== undefined) {
    const t = value.lastTests
    if (!isObject(t) || !Object.keys(t).length) errors.push(`${where}.lastTests: an object { health?, failed?, minFailed?, minPassed? }`)
    else {
      for (const key of Object.keys(t)) if (!['health', 'failed', 'minFailed', 'minPassed'].includes(key)) errors.push(`${where}.lastTests.${key}: unknown key`)
      if (t.health !== undefined && !HEALTHS.includes(t.health)) errors.push(`${where}.lastTests.health: ${HEALTHS.join(' / ')}`)
      for (const key of ['failed', 'minFailed', 'minPassed']) if (t[key] !== undefined && !(Number.isInteger(t[key]) && t[key] >= (key === 'failed' ? 0 : 1))) errors.push(`${where}.lastTests.${key}: an integer`)
      if (t.failed !== undefined && t.minFailed !== undefined) errors.push(`${where}.lastTests: failed and minFailed contradict`)
    }
  }
  for (const key of ['earlierFailure', 'answerEvidence', 'nothingOutside']) if (value[key] !== undefined && value[key] !== true) errors.push(`${where}.${key}: true`)
  return errors
}

/** The text files under a folder, bounded: { relative path: content }; links and what is too big or not text are skipped and counted. */
export function readTree(root) {
  const files = {}, skipped = { links: 0, big: 0 }
  const walk = dir => {
    let entries = []
    try { entries = fs.readdirSync(dir, { withFileTypes: true }) } catch { return }
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      if (Object.keys(files).length >= LIMITS.files) return
      const full = path.join(dir, entry.name), rel = path.relative(root, full).split(path.sep).join('/')
      if (entry.isSymbolicLink()) { skipped.links++; continue }
      if (entry.isDirectory()) { if (!['.git', 'node_modules', '.egdesk'].includes(entry.name)) walk(full); continue }
      if (!entry.isFile()) continue
      try { if (fs.statSync(full).size > LIMITS.fileBytes) { skipped.big++; continue }; files[rel] = fs.readFileSync(full, 'utf8') } catch { /* unreadable */ }
    }
  }
  walk(root)
  return { files, skipped }
}

export function diffTrees(original, now) {
  const changed = [], added = [], removed = []
  for (const [p, content] of Object.entries(now)) { if (!Object.hasOwn(original, p)) added.push(p); else if (original[p] !== content) changed.push(p) }
  for (const p of Object.keys(original)) if (!Object.hasOwn(now, p)) removed.push(p)
  return { changed: changed.sort(), added: added.sort(), removed: removed.sort() }
}

const sameSet = (a, b) => a.length === b.length && [...a].sort().every((v, i) => v === [...b].sort()[i])

/** The judgement from one record (see below for how it is built); each check carries the facts it read. */
export function checkCoding(expect, record) {
  const out = [], put = (check, ok, detail) => out.push({ check: `coding.${check}`, ok: ok === true, detail })
  const commands = record?.commands ?? [], last = commands.at(-1) ?? null, tree = record?.tree ?? {}
  if (expect.changed) put('changed', sameSet(expect.changed, tree.changed ?? []) && (tree.added ?? []).length === 0 && (tree.removed ?? []).length === 0, { wanted: expect.changed, changed: tree.changed ?? null, added: tree.added ?? null, removed: tree.removed ?? null })
  if (expect.lastTests) {
    const t = expect.lastTests, s = last?.summary ?? null
    const ok = !!last && (t.health === undefined || last.health === t.health) && (t.failed === undefined || (s && s.failed === t.failed)) && (t.minFailed === undefined || (s && s.failed >= t.minFailed)) && (t.minPassed === undefined || (s && s.passed >= t.minPassed))
    put('lastTests', ok, { commands: commands.length, health: last?.health ?? null, exitCode: last?.exitCode ?? null, summary: s ? { passed: s.passed, failed: s.failed, total: s.total } : null, wanted: t })
  }
  if (expect.earlierFailure) { const before = commands.slice(0, -1).filter(c => c.summary && c.summary.failed >= 1); put('earlierFailure', before.length > 0, { earlier: commands.slice(0, -1).map(c => c.summary ? { passed: c.summary.passed, failed: c.summary.failed } : null) }) }
  if (expect.answerEvidence) {
    const s = last?.summary ?? null, items = record?.evidence ?? []
    put('answerEvidence', !!s && items.length >= commands.length && items.some(text => text.includes(`${s.passed} passed, ${s.failed} failed`)), { items: items.length, commands: commands.length, lastCounts: s ? `${s.passed} passed, ${s.failed} failed` : null, opaqueTools: record?.opaqueTools ?? null })
  }
  if (expect.nothingOutside) {
    const o = record?.outside ?? {}
    put('nothingOutside', o.engineFolder?.length === 0 && o.links === 0 && o.neighboursBefore && sameSet(o.neighboursBefore, o.neighboursAfter ?? []) && (tree.added ?? []).every(p => !p.startsWith('..')), { engineFolder: o.engineFolder ?? null, links: o.links ?? null, neighboursBefore: o.neighboursBefore ?? null, neighboursAfter: o.neighboursAfter ?? null })
  }
  return out
}

/** The registered turn hook: remembers the folder as the script gave it and the scratch neighbours; after a turn with expect.coding it reads what the turn did. */
export function createCodingHook(conversation) {
  let deps = null, neighboursBefore = null
  const names = dir => { try { return fs.readdirSync(dir).sort() } catch { return null } }
  return {
    attach(d) { deps = d; if (d.scratch) neighboursBefore = names(path.dirname(d.scratch)) },
    async afterTurn(ctx) {
      if (!ctx.expect?.coding || !deps?.scratch) return null
      const run = deps.chat.runFor(ctx.run), now = readTree(deps.scratch), tree = diffTrees(conversation.folder ?? {}, now.files)
      const entries = Array.isArray(run?.ownCommands) ? run.ownCommands : []
      const commands = entries.map(c => ({ command: c.command, exitCode: c.exitCode, stopped: c.stopped, health: c.health, healthReasons: c.healthReasons, summary: c.summary ? { runner: c.summary.runner, passed: c.summary.passed, failed: c.summary.failed, total: c.summary.total, line: c.summary.line } : null }))
      let evidence = [], opaqueTools = null
      try { const items = deps.chat.answerFactsEvidence(run); evidence = items.filter(i => /^own\d/.test(i.id)).map(i => i.text); opaqueTools = items.filter(i => i.opaque === true && i.source === 'tool:dynamicToolCall').length } catch { /* recorded as empty */ } // opaqueTools: the engine's other own tool steps (reads, edits) stay content-free references
      const record = { tree, commands, evidence, opaqueTools, outside: { engineFolder: deps.engineFolder ? (names(deps.engineFolder) ?? []) : null, links: now.skipped.links, neighboursBefore, neighboursAfter: deps.scratch ? names(path.dirname(deps.scratch)) : null } }
      return { record: { tree, commands, evidenceItems: evidence.length, opaqueTools, outside: record.outside }, expectations: checkCoding(ctx.expect.coding, record) }
    },
  }
}
