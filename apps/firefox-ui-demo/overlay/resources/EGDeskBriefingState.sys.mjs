// Presentation state only. No provider requests, inferred steps or automatic
// transitions; callers invoke navigation only in response to a user action.
//
// briefingStagePath adapts the rounded cutout path of driver.js
// (MIT License, Copyright (c) Kamran Ahmed — packages/driver/src/stage.ts
// generateStageSvgPathString) from one cutout to several. Unlike driver.js,
// the dim layer drawn from it must never take pointer input.
import { usableArtifact } from './EGDeskChatState.sys.mjs';
import { inputEvidenceKey } from './EGDeskInputContext.sys.mjs';
const copy = value => JSON.parse(JSON.stringify(value));

export const BRIEFING_MAX_TARGETS = 6;
export const BRIEFING_COMMENT_MAX = 2000;
export const BRIEFING_EMPHASIS = Object.freeze(['spotlight', 'outline']);

const isTarget = target => !!target && typeof target === 'object' && !Array.isArray(target);
const finiteRect = rect => !!rect && ['x', 'y', 'width', 'height'].every(key => Number.isFinite(rect[key])) && rect.width > 0 && rect.height > 0;
const round = value => Math.round(value * 100) / 100;

// A step published with egdesk_publish_briefing_multi has targets[] (1–6, the
// first is also kept as target); an older step has a single target.
export function briefingStepTargets(step) {
  if (Array.isArray(step?.targets) && step.targets.length) return step.targets.filter(isTarget).slice(0, BRIEFING_MAX_TARGETS);
  return isTarget(step?.target) ? [step.target] : [];
}
export const briefingEmphasis = step => step?.emphasis === 'outline' ? 'outline' : 'spotlight';

function validStepTargets(step) {
  if (step.targets !== undefined) {
    return Array.isArray(step.targets) && step.targets.length > 0 && step.targets.length <= BRIEFING_MAX_TARGETS && step.targets.every(isTarget);
  }
  return isTarget(step.target);
}

export function validBriefing(briefing) {
  return typeof briefing?.id === 'string' && !!briefing.id && (briefing.title === undefined || typeof briefing.title === 'string')
    && Array.isArray(briefing.steps) && briefing.steps.length > 0
    && new Set(briefing.steps.map(step => step.id)).size === briefing.steps.length
    && briefing.steps.every(step => typeof step.id === 'string' && step.id
      && typeof step.text === 'string' && validStepTargets(step)
      && (step.fallback === undefined || typeof step.fallback === 'string')
      && (step.emphasis === undefined || BRIEFING_EMPHASIS.includes(step.emphasis)));
}

export function beginBriefing(briefing, viewport) {
  if (!validBriefing(briefing)) throw new Error('검증 가능한 브리핑 단계가 없습니다.');
  return { briefing: copy(briefing), index: 0, previousView: copy(viewport) };
}
export function selectBriefingStep(session, index) {
  if (!Number.isInteger(index) || index < 0 || index >= session.briefing.steps.length) return session;
  return { ...session, index };
}
export const currentBriefingStep = session => session?.briefing.steps[session.index] || null;

// CNV-07: while a briefing is open the screen switches to its own chrome mode
// (smaller Dock and rail, step numbers on the minimap).
export const briefingChromeMode = session => session?.briefing ? 'briefing' : null;

export function resolveBriefingTargets(step, { references = [], artifacts = [], views = [], identity = {} } = {}) {
  return briefingStepTargets(step).map(target => {
    if (target.sourceId) {
      const reference = references.find(item => item.sourceId === target.sourceId);
      if (!reference) return { target, status: 'missing', reason: '이 답변에 연결된 입력을 확인할 수 없습니다.' };
      if (target.hash && target.hash !== reference.hash) return { target, reference, status: 'stale', reason: '브리핑이 지정한 고정 원문 hash와 일치하지 않습니다.' };
      let evidenceKey;
      try { evidenceKey = inputEvidenceKey({ ...reference, presentationRange: target.range }); }
      catch (error) { return { target, reference, status: 'unsupported', reason: error.message }; }
      // Canvas evidence views bind the immutable sourceId/hash. The original
      // browser viewId is only a Live-link hint, never a substitute for evidence.
      const view = views.find(item => item.evidenceKey === evidenceKey && item.sourceId === reference.sourceId && item.hash === reference.hash);
      if (!view) return { target, reference, status: 'missing', reason: '당시 입력을 기록에서 확인하거나 Canvas 근거로 열 수 있습니다.' };
      if (!view.sourceMatches || !view.revisionMatches) return { target, reference, status: 'stale', reason: '현재 보기와 당시 입력의 일치를 확인할 수 없습니다.' };
      return { target, reference, view, status: 'available' };
    }
    if (target.artifactId) {
      const artifact = artifacts.find(item => item.id === target.artifactId && usableArtifact(item)
        && item.answerId === identity.answerId && item.runId === identity.runId && item.conversationId === identity.conversationId);
      const view = artifact && views.find(item => item.artifactId === artifact.id && item.sourceMatches && item.revisionMatches);
      return artifact && view ? { target, artifact, view, status: 'available' }
        : { target, artifact, status: 'missing', reason: '검증된 산출물의 현재 보기를 확인할 수 없습니다.' };
    }
    return { target, status: 'unsupported', reason: '지원되는 명시적 대상 참조가 없습니다.' };
  });
}

export function briefingBounds(resolved) {
  const rects = (resolved || []).filter(item => item.status === 'available').map(item => item.view.geometry).filter(finiteRect);
  if (!rects.length) return null;
  const x = Math.min(...rects.map(rect => rect.x)), y = Math.min(...rects.map(rect => rect.y));
  return { x, y, width: Math.max(...rects.map(rect => rect.x + rect.width)) - x,
    height: Math.max(...rects.map(rect => rect.y + rect.height)) - y };
}

// Canvas geometry → viewport pixels for the camera the layer is drawn with
// (translate(pan) scale(zoom), origin 0 0). Only available targets count.
export function briefingScreenRects(resolved, camera) {
  const zoom = camera?.zoom, pan = camera?.pan;
  if (!Number.isFinite(zoom) || zoom <= 0 || !Number.isFinite(pan?.x) || !Number.isFinite(pan?.y)) return [];
  return (resolved || []).filter(item => item.status === 'available' && finiteRect(item.view?.geometry)).map(item => {
    const rect = item.view.geometry;
    return { x: rect.x * zoom + pan.x, y: rect.y * zoom + pan.y, width: rect.width * zoom, height: rect.height * zoom };
  });
}

function clipToViewport(rect, view) {
  const x = Math.max(rect.x, view.x), y = Math.max(rect.y, view.y);
  const right = Math.min(rect.x + rect.width, view.x + view.width), bottom = Math.min(rect.y + rect.height, view.y + view.height);
  return right > x && bottom > y ? { x, y, width: right - x, height: bottom - y } : null;
}
const overlaps = (a, b) => a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;
const union = (a, b) => {
  const x = Math.min(a.x, b.x), y = Math.min(a.y, b.y);
  return { x, y, width: Math.max(a.x + a.width, b.x + b.width) - x, height: Math.max(a.y + a.height, b.y + b.height) - y };
};
const viewportRect = viewport => ({ x: viewport?.x ?? 0, y: viewport?.y ?? 0, width: viewport?.width, height: viewport?.height });

// The cutouts of the dim layer for one step, in viewport pixels: padded,
// clipped to the viewport, and merged where they overlap, because two
// overlapping cutouts would cancel each other under the evenodd fill rule.
export function briefingStageHoles(rects, viewport, { padding = 8 } = {}) {
  const view = viewportRect(viewport);
  if (!finiteRect(view)) return [];
  const pad = Number.isFinite(padding) && padding > 0 ? padding : 0;
  const holes = (rects || []).filter(finiteRect)
    .map(rect => clipToViewport({ x: rect.x - pad, y: rect.y - pad, width: rect.width + pad * 2, height: rect.height + pad * 2 }, view))
    .filter(Boolean);
  for (let merged = true; merged;) {
    merged = false;
    for (let i = 0; i < holes.length && !merged; i++) for (let j = i + 1; j < holes.length; j++) {
      if (!overlaps(holes[i], holes[j])) continue;
      holes[i] = union(holes[i], holes[j]);
      holes.splice(j, 1);
      merged = true;
      break;
    }
  }
  return holes.sort((a, b) => a.y - b.y || a.x - b.x);
}

// One SVG path (fill-rule evenodd): the whole viewport with a rounded cutout
// per merged target. null when nothing is visible, so the screen never dims
// everything. Draw it with pointer-events: none — it only shows, never blocks.
export function briefingStagePath(rects, viewport, { padding = 8, radius = 8 } = {}) {
  const holes = briefingStageHoles(rects, viewport, { padding });
  if (!holes.length) return null;
  const view = viewportRect(viewport);
  let path = `M${round(view.x + view.width)},${round(view.y)}L${round(view.x)},${round(view.y)}L${round(view.x)},${round(view.y + view.height)}L${round(view.x + view.width)},${round(view.y + view.height)}Z`;
  for (const hole of holes) {
    const r = Math.floor(Math.max(Math.min(Number.isFinite(radius) ? radius : 0, hole.width / 2, hole.height / 2), 0));
    const width = round(hole.width - r * 2), height = round(hole.height - r * 2);
    path += r
      ? `M${round(hole.x + r)},${round(hole.y)}h${width}a${r},${r} 0 0 1 ${r},${r}v${height}a${r},${r} 0 0 1 -${r},${r}h-${width}a${r},${r} 0 0 1 -${r},-${r}v-${height}a${r},${r} 0 0 1 ${r},-${r}z`
      : `M${round(hole.x)},${round(hole.y)}h${width}v${height}h-${width}z`;
  }
  return path;
}

// One list for both the main view and the minimap (step number, where, and
// whether its evidence is on the Canvas). resolvedSteps[i] is
// resolveBriefingTargets(steps[i]); bounds are Canvas coordinates.
export function briefingStepMarks(session, resolvedSteps = []) {
  return (session?.briefing?.steps || []).map((step, index) => {
    const resolved = Array.isArray(resolvedSteps[index]) ? resolvedSteps[index] : [];
    const targetCount = briefingStepTargets(step).length;
    const availableCount = resolved.filter(item => item.status === 'available').length;
    return {
      stepId: step.id, number: index + 1, current: index === session.index, emphasis: briefingEmphasis(step),
      targetCount, availableCount, bounds: briefingBounds(resolved),
      status: targetCount && availableCount >= targetCount ? 'available' : availableCount ? 'partial' : 'missing',
    };
  });
}

// CHAT-05: the comment itself is saved first (POST /context/briefings/:id/comments
// with this body); the helper attaches the step's own evidence.
export function briefingCommentRequest(session, comment) {
  const step = currentBriefingStep(session);
  const text = String(comment ?? '').trim();
  if (!step || !text) throw new Error('단계 의견을 입력해 주세요.');
  if (text.length > BRIEFING_COMMENT_MAX) throw new Error(`단계 의견은 ${BRIEFING_COMMENT_MAX}자까지 남길 수 있습니다.`);
  return { briefingId: session.briefing.id, body: { stepId: step.id, text } };
}

const savedCommentFor = (saved, session, step) => saved && typeof saved.id === 'string' && !!saved.id
  && saved.briefingId === session.briefing.id && saved.stepId === step.id
  && Number.isSafeInteger(saved.seq) && saved.seq > 0 && typeof saved.text === 'string';

// With a saved comment the draft points at that record by number instead of
// copying the step text; without one it keeps the older inline form.
export function briefingCommentDraft(session, comment, resolved, saved = null) {
  const step = currentBriefingStep(session);
  if (!step || !String(comment).trim()) throw new Error('단계 의견을 입력해 주세요.');
  const title = session.briefing.title || '답변 브리핑';
  const contextSnapshotIds = [...new Set((resolved || []).filter(item => item.reference).map(item => item.reference.sourceId))];
  if (saved) {
    if (!savedCommentFor(saved, session, step)) throw new Error('저장된 단계 의견을 확인할 수 없습니다.');
    return {
      briefingId: session.briefing.id, stepId: step.id, commentId: saved.id, commentSeq: saved.seq,
      text: `[${title} · ${session.index + 1}단계 · 의견 #${saved.seq}]\n의견: ${saved.text}`,
      contextSnapshotIds,
    };
  }
  return {
    briefingId: session.briefing.id, stepId: step.id,
    text: `[${title} · ${session.index + 1}단계 · ${session.briefing.id}/${step.id}]\n${step.text}\n\n의견: ${String(comment).trim()}`,
    contextSnapshotIds,
  };
}

// A draft refers to each saved comment once, however often it is attached.
export function addBriefingCommentRef(refs = [], draft) {
  const list = (Array.isArray(refs) ? refs : []).map(copy);
  if (typeof draft?.commentId !== 'string' || list.some(ref => ref.commentId === draft.commentId)) return list;
  return [...list, { commentId: draft.commentId, commentSeq: draft.commentSeq, briefingId: draft.briefingId, stepId: draft.stepId }];
}

// GET /context/briefings/:id/comments → comments of this briefing in number order.
export function normalizeBriefingComments(value, briefingId) {
  const list = Array.isArray(value?.comments) ? value.comments : Array.isArray(value) ? value : [];
  const seen = new Set();
  return list.filter(item => item && typeof item.id === 'string' && !seen.has(item.id) && item.briefingId === briefingId
      && typeof item.stepId === 'string' && Number.isSafeInteger(item.seq) && item.seq > 0
      && typeof item.text === 'string' && typeof item.resolved === 'boolean' && seen.add(item.id))
    .map(copy).sort((a, b) => a.seq - b.seq);
}

// Badges per step (open / resolved counts) as a list, never keyed by a step ID.
export function briefingCommentSummary(session, comments = []) {
  return (session?.briefing?.steps || []).map((step, index) => {
    const own = (comments || []).filter(item => item.stepId === step.id);
    return {
      stepId: step.id, number: index + 1,
      open: own.filter(item => !item.resolved).length, resolved: own.filter(item => item.resolved).length,
      latestSeq: own.length ? Math.max(...own.map(item => item.seq)) : null,
    };
  });
}
