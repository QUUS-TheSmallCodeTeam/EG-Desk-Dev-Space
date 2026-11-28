// L55 (round f, owner: "그런 것들도 decision model이 보고 결정하게끔 해줘"): a page that keeps changing (a clock, a ticker, a rotating banner, a chat widget) moves the
// observation `revision` between the step's observation and its act, so the page actor refuses the act as BROWSER_OBSERVATION_STALE although the target itself did not change.
// A refusal that did not send anything on the SAME document is not the end of the step: the loop looks again, tells the decision model WHAT changed (a closed summary built here by
// code, never page text beyond the target's own label) and lets the model decide whether the decided action still applies (same target), applies to another target, waits for the
// page to settle, or is not the loop's to continue. This file holds the code parts: the change summary, its evidence lines, the question, the bound and the eligibility rules.

export const CHANGE_REDECISIONS = 3 // fresh looks (and at most this many decision requests) per refused act; then an honest hand-off, never a loop
// the page actor's / helper's refusal reasons that mean "nothing was sent, same document, the observation moved" (staleBy of the helper's error)
export const CHANGE_SAME_DOCUMENT = new Set(['revision', 'viewport', 'focus', 'observation', 'target'])
// ... and the ones that mean the document itself was replaced (the new page is decided anew; a person-only page state is asked again there)
export const CHANGE_REPLACED_DOCUMENT = new Set(['document', 'url', 'identity', 'frame'])
export const CHANGE_WAIT_QUESTION = 'The page changed after the action above was decided. Is the area around the target still changing so that the action should wait for the page to settle before it is acted on? No if the target looks the same and the changes are elsewhere.'

const record = value => value !== null && typeof value === 'object' && !Array.isArray(value)
const text = value => String(value ?? '')
const boundsOf = element => {
  const b = element?.bounds
  return record(b) && ['x', 'y', 'width', 'height'].every(key => Number.isFinite(b[key])) ? b : null
}
const overlaps = (a, b) => !!a && !!b && a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height
const elementsOf = snapshot => (Array.isArray(snapshot?.interactiveElements) ? snapshot.interactiveElements : []).filter(item => record(item) && typeof item.ref === 'string')
const DIALOG_ROLES = new Set(['dialog', 'alertdialog'])

/** The identity of a target for "is it the element that was decided": role, name, address, tag, enabled state (and the value unless the step types into it). Position is not identity. */
export function targetKey(element, { value = true } = {}) {
  if (!record(element)) return null
  return JSON.stringify([text(element.ref), text(element.role), text(element.label), text(element.href), text(element.tag), element.disabled === true, value ? text(element.value) : ''])
}

/**
 * summarizeChange(before, after, ref) -> a closed description of what moved between two observations of the same document (every field a word, a count or a flag):
 *   target: 'same' | 'changed' | 'moved' | 'gone'  (the decided element by its ref: 'changed' = role, name, address, value or enabled state differ; 'moved' = only its position or size)
 *   targetFields: which of 'role' 'label' 'href' 'value' 'enabled' 'position' differ
 *   changedElements / addedElements / removedElements: counts of listed controls (by ref) that differ, appeared, disappeared
 *   overlapsTarget: a changed, added or removed control sits on the target's box (null when a box is unknown)
 *   dialogAppeared: a dialog control is listed now that was not before
 *   textLines: how many visible text lines are new (a ticking clock is 1); viewport/url flags
 */
export function summarizeChange(before, after, ref) {
  const was = new Map(elementsOf(before).map(item => [item.ref, item])), now = new Map(elementsOf(after).map(item => [item.ref, item]))
  const targetBefore = was.get(ref) ?? null, targetAfter = now.get(ref) ?? null
  const targetFields = []
  let target = 'same'
  if (!targetAfter) target = 'gone'
  else if (targetBefore) {
    if (text(targetBefore.role) !== text(targetAfter.role)) targetFields.push('role')
    if (text(targetBefore.label) !== text(targetAfter.label)) targetFields.push('label')
    if (text(targetBefore.href) !== text(targetAfter.href)) targetFields.push('href')
    if (text(targetBefore.value) !== text(targetAfter.value)) targetFields.push('value')
    if ((targetBefore.disabled === true) !== (targetAfter.disabled === true)) targetFields.push('enabled')
    if (targetFields.length) target = 'changed'
    const a = boundsOf(targetBefore), b = boundsOf(targetAfter)
    if (a && b && (a.x !== b.x || a.y !== b.y || a.width !== b.width || a.height !== b.height)) { targetFields.push('position'); if (target === 'same') target = 'moved' }
  }
  const box = boundsOf(targetAfter) ?? boundsOf(targetBefore)
  let changed = 0, added = 0, removed = 0, onTarget = false, unknownBox = false, dialogAppeared = false
  const touch = element => { const b = boundsOf(element); if (!b || !box) unknownBox = true; else if (overlaps(b, box)) onTarget = true }
  for (const [key, item] of now) {
    const old = was.get(key)
    if (!old) { added++; touch(item); if (DIALOG_ROLES.has(text(item.role))) dialogAppeared = true; continue }
    if (key === ref) continue
    const b = boundsOf(old), c = boundsOf(item)
    const moved = (!b !== !c) || (b && c && (b.x !== c.x || b.y !== c.y || b.width !== c.width || b.height !== c.height))
    if (targetKey(old) !== targetKey(item) || moved) { changed++; touch(item) }
  }
  for (const [key, item] of was) if (!now.has(key)) { removed++; touch(item) }
  const seen = new Set((Array.isArray(before?.text) ? before.text : []).map(String))
  const textLines = (Array.isArray(after?.text) ? after.text : []).filter(line => !seen.has(String(line))).length
  return { target, targetFields, changedElements: changed, addedElements: added, removedElements: removed,
    overlapsTarget: onTarget ? true : unknownBox && (changed + added + removed) > 0 ? null : false, dialogAppeared, textLines,
    viewport: !before?.viewport || !after?.viewport ? false : ['width', 'height', 'devicePixelRatio'].some(key => before.viewport[key] !== after.viewport[key]),
    scrolled: record(before?.scroll) && record(after?.scroll) ? (before.scroll.x !== after.scroll.x || before.scroll.y !== after.scroll.y) : false }
}

/** The evidence lines for the decision request (closed words and counts; the target's own name is the only page text, compacted by the caller). */
export function changeEvidence(summary, { intended, round, total }) {
  const part = (label, value) => `${label}: ${value}`
  return [
    `Page change check (${round}/${total}): the page changed after this action was decided, so nothing was sent. Decided action: ${intended}.`,
    [part('target', summary.target === 'same' ? 'unchanged' : summary.target === 'moved' ? 'moved or resized, otherwise unchanged' : summary.target === 'gone' ? 'no longer on the page' : 'changed (' + summary.targetFields.join(', ') + ')'),
      part('listed controls changed', summary.changedElements), part('appeared', summary.addedElements), part('disappeared', summary.removedElements),
      part('changes on the target area', summary.overlapsTarget === null ? 'unknown' : summary.overlapsTarget ? 'yes' : 'no'),
      part('dialog appeared', summary.dialogAppeared ? 'yes' : 'no'), part('new text lines', summary.textLines)].join('; '),
    'The options below are the controls of the current page. Choose the option that now moves toward the goal: the same one if the action still applies, another if the target changed, or answer that it should wait.',
  ].join('\n')
}

/** In-place re-act is only for options whose normal path has no extra gate of its own (a POST submit and a site request keep theirs: they are decided anew by the loop). */
export function changeEligible(option) {
  const item = option?.item
  return !!item && !item.postUrl && !item.askSite
}
/** A different target may take the act in place only when it is the same kind of step; anything else goes back to the loop's own decision on a fresh observation. */
export function changeRetargetable(from, to) {
  return changeEligible(to) && to.item.kind === from.item.kind && to.item.kind !== 'navigate' && !!to.item.named === !!from.item.named &&
    to.item.readOnly?.kind === from.item.readOnly?.kind && to.item.readOnly?.kind !== 'get_form'
}
