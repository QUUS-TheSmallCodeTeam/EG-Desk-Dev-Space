import { enumerateCanvasChecks, checkRequestDto, sceneFromDesk } from './EGDeskCanvasDesignCheck.sys.mjs';
// Hand-off half of the canvas design check. The Decision model only judges (closed items, aliases, probabilities). What it found goes to the
// SUBJECTIVE model (Codex/Claude) as structured data without raw text; the subjective model proposes the redesign (new positions of the listed
// cards); this module validates that proposal against the live canvas and turns it into one preview plan for the existing apply / undo / Cmd+Z
// path on the user's own screen. Nothing here writes: the shared Board is never touched and a rejected proposal changes nothing.

export const REDESIGN_MIN = Object.freeze({ width: 160, height: 96 });
const right = r => r.x + r.width, bottom = r => r.y + r.height;
const overlaps = (a, b, pad = 0) => a.x < right(b) + pad && right(a) + pad > b.x && a.y < bottom(b) + pad && bottom(a) + pad > b.y;
const worldBounds = d => ({ x: (d.viewport.x - d.camera.x) / d.camera.zoom, y: (d.viewport.y - d.camera.y) / d.camera.zoom, width: d.viewport.width / d.camera.zoom, height: d.viewport.height / d.camera.zoom });
const cardRect = c => ({ x: c.rect.x, y: c.rect.y, width: c.rect.width, height: c.rect.height });

/** The structured request for the subjective model. Closed names, aliases, probabilities and card numbers; no title, text, id or file path. */
export function buildRedesignRequest(result, enumeration, desk) {
  if (result?.status === 'inconclusive') {
    return { kind: 'canvas_design_inconclusive', understandable: result.understandable,
      note: 'The system judge could not decide whether this canvas needs improvement. Make no layout change.' };
  }
  const named = new Set((result?.findings || []).flatMap(f => f.aliases));
  return { kind: 'canvas_design_findings', understandable: result.understandable,
    findings: result.findings.map(f => ({ item: f.item, aliases: [...f.aliases], p: f.p })), where: result.where ? { ...result.where } : null,
    cards: enumeration.cards.filter(c => named.has(c.alias)).map(c => ({ alias: c.alias, kind: c.kind, rect: { ...c.rect }, movable: c.movable })),
    bounds: worldBounds(desk), min: { ...REDESIGN_MIN },
    reply: 'Return { targets: [{ alias, rect: { x, y, width, height } }] } for movable listed cards only, inside bounds, without overlap. Proposals that collide with anything else on the canvas are discarded.' };
}

/** validateRedesignProposal(proposal, { enumeration, desk }) → { ok:true, targets:[{ id, rect }] } | { ok:false, reason } (closed reason words). */
export function validateRedesignProposal(proposal, { enumeration, desk } = {}) {
  const fail = reason => ({ ok: false, reason });
  const list = proposal?.targets;
  if (!Array.isArray(list) || !list.length || list.length > enumeration.cards.length) return fail('no-targets');
  const bounds = worldBounds(desk), byAlias = new Map(enumeration.cards.map(c => [c.alias, c])), seen = new Set(), out = [];
  for (const t of list) {
    const c = byAlias.get(t?.alias);
    if (!c) return fail('unknown-alias');
    if (seen.has(c.alias)) return fail('duplicate');
    seen.add(c.alias);
    const live = desk.cards.find(x => x.id === c.id);
    if (!c.movable || !live || live.pinned || live.movable !== true) return fail('immovable');
    const r = t.rect;
    if (!r || ![r.x, r.y, r.width, r.height].every(Number.isFinite)) return fail('bad-rect');
    const rect = { x: Math.round(r.x), y: Math.round(r.y), width: Math.round(r.width), height: Math.round(r.height) };
    if (rect.width < Math.max(REDESIGN_MIN.width, live.minWidth || 0) || rect.height < Math.max(REDESIGN_MIN.height, live.minHeight || 0)) return fail('too-small');
    if (rect.x < bounds.x || rect.y < bounds.y || right(rect) > right(bounds) || bottom(rect) > bottom(bounds)) return fail('out-of-bounds');
    out.push({ id: c.id, rect });
  }
  const ids = new Set(out.map(t => t.id));
  const blockers = [...desk.cards.filter(c => !ids.has(c.id)).map(cardRect), ...(desk.obstacles || [])];
  for (let i = 0; i < out.length; i++) {
    if (blockers.some(b => overlaps(out[i].rect, b, 2))) return fail('collision');
    for (let j = i + 1; j < out.length; j++) if (overlaps(out[i].rect, out[j].rect, 2)) return fail('collision');
  }
  if (out.every(t => { const l = desk.cards.find(x => x.id === t.id).rect; return l.x === t.rect.x && l.y === t.rect.y && l.width === t.rect.width && l.height === t.rect.height; })) return fail('no-change');
  return { ok: true, targets: out };
}

/**
 * runCanvasDesignCheck({ desk, extras, purpose, decide, engine, review }) → { status, ... }
 *   desk: controller.designScene(key); extras: { groups, important, refs, labels, capabilities } from the host;
 *   decide: { prepare(dto), run(ticket), cancel(ticket) } (the bridge routes); review(preview) → true when the user has seen the exact packet and agreed;
 *   engine(request) → proposal | null (the subjective model).
 * status: clean (nothing enumerated: no request at all) | no-purpose | disabled | declined | advisory-only | ok | inconclusive | preview | proposal-rejected | manual.
 * Only 'findings' reaches the engine with a redesign job; 'inconclusive' tells it so and applies nothing; 'ok'/'advisory-only' never contact it.
 */
export async function runCanvasDesignCheck({ desk, extras = {}, purpose, decide, engine, review }) {
  const enumeration = enumerateCanvasChecks(sceneFromDesk(desk, extras));
  if (!enumeration.items.length) return { status: 'clean', requested: false };
  const dto = checkRequestDto(enumeration, { purpose });
  if (!dto) return { status: 'no-purpose', requested: false };
  const prepared = await decide.prepare(dto);
  if (prepared?.status !== 'prepared') return { status: 'disabled', reason: prepared?.reason ?? null, requested: false };
  if (!(await review(prepared.preview))) { await decide.cancel(prepared.ticket); return { status: 'declined', requested: false }; }
  const reply = await decide.run(prepared.ticket);
  if (reply?.status === 'advisory-only') return { status: 'advisory-only', verdict: reply.verdict, requested: true };
  if (reply?.status === 'ok') return { status: 'ok', requested: true };
  if (reply?.status === 'inconclusive') { await engine(buildRedesignRequest(reply, enumeration, desk)); return { status: 'inconclusive', told: true, requested: true }; }
  if (reply?.status !== 'findings') return { status: 'manual', reason: reply?.reason ?? null, requested: true };
  const request = buildRedesignRequest(reply, enumeration, desk);
  const verdict = validateRedesignProposal(await engine(request), { enumeration, desk });
  if (!verdict.ok) return { status: 'proposal-rejected', reason: verdict.reason, request, requested: true };
  return { status: 'preview', plan: { option: 'redesign', camera: null, framing: null, targets: verdict.targets }, request, findings: reply.findings, requested: true };
}
