// Host side of the briefing flow, advisory first (cycle 8). Pure: no DOM, no network. The surface turns its open cards into plain descriptors, this module
// builds the closed observe request from them (with each card's provenance), and decides locally, before any request, whether there is anything to observe.
// Default OFF: briefingFlowMode() is 'off' unless the pref egdesk.briefingFlow is exactly "advisory" (ask the judge and record: never designs, publishes, moves, folds
// or deletes anything) or exactly "on" (the full flow: the bridge also needs the Decisions mode on, the subjective model and the briefing capability of that run;
// the result is a PROPOSED briefing through the existing tool path plus an optional fold proposal that only the user can apply, on their own screen).
export const BRIEFING_FLOW_PREF = 'egdesk.briefingFlow';
export const briefingFlowMode = value => value === 'advisory' ? 'advisory' : value === 'on' ? 'on' : 'off';
const clean = (text, max) => typeof text === 'string' ? text.replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max) : '';
const MAX = 12;

/**
 * canvasBriefingCandidates(cards) -> candidates for the flow. cards: [{ id, kind:'result'|'memo', rect, collapsed, inFrame, record?, memoSeq? }].
 * Provenance comes only from what was recorded when the card was created: a result card with a valid record.provenance is its creator's; a memo is the user's own;
 * a result card without provenance is unknown (the flow treats unknown as the user's and never retrieves it).
 */
export function canvasBriefingCandidates(cards = []) {
  const out = [];
  for (const c of cards) {
    if (out.length >= MAX || !c || typeof c.id !== 'string' || !c.id) continue;
    const rect = c.rect && [c.rect.x, c.rect.y, c.rect.width, c.rect.height].every(Number.isFinite) ? { x: c.rect.x, y: c.rect.y, width: c.rect.width, height: c.rect.height } : undefined;
    const visibility = c.collapsed ? 'collapsed' : c.inFrame === false ? 'offscreen' : 'visible';
    if (c.kind === 'result' && c.record) {
      const p = c.record.provenance && c.record.provenance.version === 1 ? c.record.provenance : null;
      const label = clean(c.record.title, 40);
      if (!label) continue;
      // A published result card is bound by the bridge from its own output store (outputId); anything else cannot be a briefing target.
      const ref = p?.outputId ? { outputId: p.outputId, viewId: c.id } : {};
      out.push({ id: c.id, ref, kind: 'output', label, gist: clean(c.record.text, 100) || undefined, onBoard: true, maySend: true, rect,
        owner: p ? p.creator : undefined, createdForAnswer: p ? p.answerId : null, superseded: !!p?.supersededBy, stale: false, visibility });
    } else if (c.kind === 'memo') {
      out.push({ id: c.id, ref: {}, kind: 'source', label: `메모 ${Number.isSafeInteger(c.memoSeq) ? c.memoSeq : out.length + 1}`, onBoard: true, maySend: true, rect, owner: 'user', createdForAnswer: null, superseded: false, stale: false, visibility });
    }
  }
  return out;
}
/** How many candidates the report names (a local, content-staying check; a card of fewer than 3 characters in its label never counts). */
export function referencedCandidates(report, candidates) {
  const text = String(report ?? '').toLowerCase();
  return candidates.filter(c => typeof c.label === 'string' && c.label.trim().length >= 3 && text.includes(c.label.trim().toLowerCase())).length;
}
/** observeRequest({ mode, report, answerId, candidates }) -> the body for POST /decision/briefing-observe, or null when there is nothing to observe (no request is made then). */
export function observeRequest({ mode, report, answerId = null, conversationId = null, runId = null, candidates = [] } = {}) {
  if (!['advisory', 'on'].includes(mode) || typeof report !== 'string' || !report.trim() || report.length > 20000 || referencedCandidates(report, candidates) < 2) return null;
  const body = { report, currentAnswerId: typeof answerId === 'string' && answerId ? answerId : null, candidates };
  return mode === 'on' ? { flow: 'on', conversationId, runId, ...body } : body;
}
