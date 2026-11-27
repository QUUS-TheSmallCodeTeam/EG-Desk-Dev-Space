// c30b: what the draft check of a run's ANSWER may know about the file edits EG-Desk made for the run (egdesk_edit_file, egdesk_undo_edit). c29 gave it the commands; the edits were still
// content-free references, so a true "I fixed src/price.mjs" had nothing to be supported by (Main's check-20ct: a tense reject on the fix sentence, then a rewrite that hedged a true fact
// "현재 파일에 수정이 유지되어 있는지는 확인할 수 없습니다"), and a claim of an edit that was only previewed, undone or made to another file had nothing to be caught by.
// The facts are the file tool's own result, read from the response it returned (no second source): the path (relative to the project), what the call did (previewed / applied / undone /
// not applied), the kind of change, the line counts of its diff, the undo record id. NEVER a line of the file or of the diff.
const WRITE_TOOL = 'egdesk_edit_file', UNDO_TOOL = 'egdesk_undo_edit'
export const OWN_EDIT_LIMITS = Object.freeze({ edits: 16, pathChars: 200 })
export const EDIT_TOOL_NAMES = Object.freeze([WRITE_TOOL, UNDO_TOOL])
const word = (v, n = 24) => (typeof v === 'string' && /^[a-z_]{1,24}$/.test(v) ? v.slice(0, n) : null)
const count = diff => { let added = 0, removed = 0, hunks = 0; for (const line of String(diff ?? '').split('\n')) { if (line.startsWith('@@')) hunks++; else if (line.startsWith('+') && !line.startsWith('+++')) added++; else if (line.startsWith('-') && !line.startsWith('---')) removed++ } return { added, removed, hunks } }

/** The fact of one call of an edit tool from the response the tool returned (null when it is not an edit-tool call or the response is not the tool's own shape). */
export function ownEditFact(tool, response) {
  if (!EDIT_TOOL_NAMES.includes(tool) || !response || response.success !== true) return null
  let body = null
  try { body = JSON.parse(response.contentItems?.[0]?.text ?? '') } catch { return null }
  if (!body || typeof body !== 'object' || typeof body.status !== 'string') return null
  const path = typeof body.path === 'string' && body.path && body.path.length <= OWN_EDIT_LIMITS.pathChars && !body.path.includes('\n') ? body.path : null
  const status = word(body.status) ?? 'other'
  const state = tool === UNDO_TOOL ? (status === 'undone' ? 'undone' : 'not_undone') : status === 'preview' ? 'previewed' : status === 'edited' ? 'applied' : 'not_applied'
  const counts = count(body.diff)
  return Object.freeze({ tool, state, status, path, kind: word(body.kind), editId: typeof body.editId === 'string' && /^[\w.-]{1,40}$/.test(body.editId) ? body.editId : null,
    added: counts.added, removed: counts.removed, hunks: counts.hunks, restored: word(body.restored) })
}

const lines = n => `${n} line${n === 1 ? '' : 's'}`
/** One evidence item. `entries`: all facts of the run in order (an applied edit says whether a later undo took it back). Kind run_state: this run's own state, readable. */
export function ownEditEvidence(entry, index, entries = []) {
  const where = entry.path ? `\`${entry.path}\`` : 'a file'
  const change = entry.state === 'applied' || entry.state === 'previewed' ? ` (${entry.kind ?? 'update'}: ${lines(entry.added)} added, ${lines(entry.removed)} removed${entry.hunks ? `, ${entry.hunks} hunk${entry.hunks === 1 ? '' : 's'}` : ''})` : ''
  let text
  if (entry.state === 'applied') {
    const undone = entries.slice(index + 1).some(e => e.state === 'undone' && e.editId !== null && e.editId === entry.editId)
    text = `In this turn the assistant changed ${where} with EG-Desk's own edit tool${change}; the change was written to the file${entry.editId ? ` and an undo record (${entry.editId}) exists` : ''}${undone ? ', and a later undo in this turn took it back' : ', and it was not undone afterwards in this turn'}.`
  } else if (entry.state === 'previewed') text = `In this turn the assistant previewed a change to ${where} with the dryRun option${change}; a preview writes nothing: the file was not changed by this call.`
  else if (entry.state === 'undone') text = `In this turn the assistant undid the earlier edit${entry.editId ? ` ${entry.editId}` : ''} of ${where}; the file was restored to what it held before that edit.`
  else if (entry.state === 'not_undone') text = `In this turn the assistant tried to undo an edit${entry.path ? ` of ${where}` : ''} and it was not undone (${entry.status}).`
  else text = `In this turn the assistant tried to change ${where} and it was not applied (${entry.status}): the file was not changed by this call.`
  const facts = { kind: 'own_edit', tool: entry.tool, state: entry.state, path: entry.path, editId: entry.editId, added: entry.added, removed: entry.removed }
  return { id: `edit${index + 1}`, kind: 'run_state', time: 'present', source: 'run', pinned: true, facts, text }
}
