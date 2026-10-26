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
export function briefingCommentRequest(session, comment, clientRequestId) {
  const step = currentBriefingStep(session);
  const text = String(comment ?? '').trim();
  if (!step || !text) throw new Error('단계 의견을 입력해 주세요.');
  if (text.length > BRIEFING_COMMENT_MAX) throw new Error(`단계 의견은 ${BRIEFING_COMMENT_MAX}자까지 남길 수 있습니다.`);
  if (!commentUuid(clientRequestId)) throw new Error('의견 저장 요청 ID를 확인하지 못했습니다.');
  return { briefingId: session.briefing.id, body: { stepId: step.id, text, clientRequestId } };
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

const commentUuid = value => typeof value === 'string' && /^[\da-f]{8}(?:-[\da-f]{4}){3}-[\da-f]{12}$/i.test(value);
const commentSources = step => [...new Set(briefingStepTargets(step).map(target => target.sourceId).filter(Boolean))];
const sameSources = (a, b) => a.length === b.length && a.every(id => b.includes(id));
const commentFailure = () => new Error('저장된 의견의 원래 단계·대화 연결을 확인하지 못했습니다.');

// HTTP receipts are stricter than the legacy presentation-only normalizer.
// In particular an unavailable/malformed GET is never an empty comment list.
export function verifiedBriefingComment(value, session, request = null) {
  const briefing = session?.briefing;
  const index = briefing?.steps?.findIndex(step => step.id === value?.stepId);
  const step = index >= 0 ? briefing.steps[index] : null;
  if (!step || !commentUuid(value.id) || value.briefingId !== briefing.id || value.stepIndex !== index
      || !Number.isSafeInteger(value.seq) || value.seq < 1 || typeof value.text !== 'string' || !value.text.trim()
      || value.text.length > BRIEFING_COMMENT_MAX || typeof value.resolved !== 'boolean'
      || ['conversationId', 'runId', 'answerId'].some(key => !briefing[key] || value[key] !== briefing[key])
      || !Array.isArray(value.sourceIds) || new Set(value.sourceIds).size !== value.sourceIds.length
      || value.sourceIds.some(id => typeof id !== 'string' || !commentSources(step).includes(id))
      || value.clientRequestId !== undefined && !commentUuid(value.clientRequestId)) throw commentFailure();
  if (request && (value.clientRequestId !== request.clientRequestId || value.stepId !== request.stepId
      || !sameSources(value.sourceIds, request.sourceIds || commentSources(step)))) throw commentFailure();
  return copy(value);
}

export function verifiedBriefingComments(value, session) {
  if (value?.briefingId !== session?.briefing?.id || !Array.isArray(value.comments)) throw commentFailure();
  const ids = new Set(), numbers = new Set(), requests = new Set();
  return value.comments.map(item => {
    const row = verifiedBriefingComment(item, session);
    if (ids.has(row.id) || numbers.has(row.seq) || row.clientRequestId && requests.has(row.clientRequestId)) throw commentFailure();
    ids.add(row.id); numbers.add(row.seq); if (row.clientRequestId) requests.add(row.clientRequestId);
    return row;
  }).sort((a, b) => a.seq - b.seq);
}

// One record is retained by the bridge for this owner/conversation/step across
// presentation close/reopen. Late callbacks never edit it; a new GET reconciles
// the original request UUID. No text-based save recovery and no automatic POST retry.
export function createBriefingComments({ session, record, request, current, include, included, makeId, changed = () => {} }) {
  const origin = { briefing: copy(session.briefing), index: session.index }, step = currentBriefingStep(origin);
  const anchor = JSON.stringify([origin.briefing.id, origin.briefing.conversationId, origin.briefing.runId, origin.briefing.answerId, origin.index, step]);
  const unknownMessage = '이전 의견의 저장 여부를 확인하지 못했습니다. 같은 의견으로 저장을 다시 시도할 수 있습니다.';
  let disposed = false, reading = null, listState = 'idle', phase = record.attempt?.phase || 'idle';
  let message = phase === 'unknown' ? record.attempt.anchor === anchor ? unknownMessage : '이전 의견의 원래 단계·근거 연결을 확인하지 못해 다시 저장할 수 없습니다.'
    : phase === 'saved' ? `의견 #${record.attempt.receipt.seq}이 저장되어 있습니다.`
    : phase === 'failed' ? '이전 의견을 저장하지 못했습니다. 입력과 연결을 확인해 주세요.' : '';
  const live = () => !disposed && current();
  const notify = () => { if (live()) changed(view()); };
  const merge = rows => {
    const combined = new Map((record.comments || []).map(row => [row.id, row]));
    for (const row of rows) {
      const prior = combined.get(row.id);
      if (prior && (['seq', 'stepId', 'text', 'clientRequestId'].some(key => prior[key] !== row[key])
          || !sameSources(prior.sourceIds, row.sourceIds))) throw commentFailure();
      combined.set(row.id, row);
    }
    record.comments = verifiedBriefingComments({ briefingId: origin.briefing.id, comments: [...combined.values()] }, origin);
  };
  const view = () => ({ phase, message, listState, clientRequestId: record.attempt?.body.clientRequestId || '', pending: record.attempt?.phase === 'saving',
    unconfirmed: record.attempt?.phase === 'unknown', text: record.text || '',
    originalText: record.attempt?.recoveryVisible && !record.attempt.receipt ? record.attempt.body.text : null,
    canRetry: record.attempt?.phase === 'unknown' && !record.attempt.retryBlocked && record.attempt.anchor === anchor,
    comments: (record.comments || []).filter(row => row.stepId === step.id).map(row => ({ ...copy(row),
      included: included(row), draftError: record.draftErrors?.[row.id] || null })) });
  const attach = id => {
    if (!live()) return false;
    const row = record.comments?.find(item => item.id === id && item.stepId === step.id);
    if (!row) return false;
    try {
      verifiedBriefingComment(row, origin);
      if (!included(row)) include(row, origin);
      record.draftErrors ||= {}; delete record.draftErrors[id];
      phase = record.attempt?.phase === 'unknown' ? 'unknown' : 'included';
      message = `의견 #${row.seq}을 Chat 초안에 포함했습니다. 아직 전송하지 않았습니다.`
        + (phase === 'unknown' ? ' 별도 저장 요청의 저장 여부는 아직 미확정입니다.' : '');
      notify(); return true;
    } catch (error) {
      if (!live()) return false;
      record.draftErrors ||= {}; record.draftErrors[id] = `#${row.seq} 저장됐지만 초안에 넣지 못함`;
      phase = record.attempt?.phase === 'unknown' ? 'unknown' : 'saved';
      message = `${record.draftErrors[id]}. ${error.message}` + (phase === 'unknown' ? ' 별도 저장 요청의 저장 여부는 아직 미확정입니다.' : '');
      notify(); return false;
    }
  };
  const refresh = () => {
    if (!live()) return Promise.resolve(false);
    if (reading) return reading;
    listState = 'loading'; notify();
    reading = (async () => {
      try {
        const response = await request('GET');
        if (!live()) return false;
        const rows = verifiedBriefingComments(response, origin);
        const attempt = record.attempt;
        const saved = attempt && rows.find(row => row.clientRequestId === attempt.body.clientRequestId);
        if (saved) verifiedBriefingComment(saved, origin, attempt.body);
        merge(rows); listState = 'ready';
        if (saved && attempt.phase === 'unknown') {
          attempt.phase = 'saved'; attempt.receipt = saved; attempt.recovered = true;
          phase = 'saved'; message = `의견 #${saved.seq} 저장을 확인했습니다. 아래에서 Chat 초안에 포함할 수 있습니다.`;
        } else if (attempt?.phase === 'unknown') {
          phase = 'unknown'; message = unknownMessage;
        }
        notify(); return true;
      } catch (error) {
        if (!live()) return false;
        listState = 'failed'; notify(); return false;
      } finally { reading = null; }
    })();
    return reading;
  };
  const postAttempt = async (attempt, recoveryOnly) => {
    // Replay the captured wire body, including absence of optional sourceIds.
    // Never rebuild it from the edited input, current target, or a new UUID.
    const body = copy(attempt.body);
    attempt.phase = 'saving'; phase = 'saving';
    message = recoveryOnly ? '이전 의견의 저장을 다시 시도하고 있습니다.' : '의견을 저장하고 있습니다.'; notify();
    try {
      const response = await request('POST', body);
      if (!live()) return false;
      const saved = verifiedBriefingComment(response?.comment, origin, body);
      merge([saved]); attempt.receipt = saved; attempt.phase = 'saved';
      if (recoveryOnly) {
        attempt.recovered = true; phase = 'saved';
        message = `의견 #${saved.seq} 저장을 확인했습니다. 아래 의견 행에서 Chat 초안에 포함할 수 있습니다.`;
        notify(); return true;
      }
      return attach(saved.id);
    } catch (error) {
      if (!live()) return false;
      // A rejected validation/authority request did not save; a lost response,
      // timeout, 5xx or invalid success receipt may have committed already.
      const rejected = [400, 401, 404, 405, 413].includes(error.status)
        || ['INVALID_BRIEFING_COMMENT', 'BRIEFING_STEP_UNKNOWN', 'BRIEFING_COMMENT_LIMIT', 'BRIEFING_COMMENT_CONFLICT',
          'CONTEXT_THREAD_REQUIRED', 'CONTEXT_THREAD_MISMATCH', 'CONTEXT_TOOL_UNSUPPORTED', 'NATIVE_BINDING_MISMATCH', 'NATIVE_ACCOUNT_MISMATCH',
          'NATIVE_ACCOUNT_UNVERIFIED', 'ENGINE_PROFILE_MISMATCH', 'IDENTITY_REQUIRED'].includes(error.code);
      attempt.phase = rejected ? 'failed' : 'unknown'; phase = attempt.phase;
      if (!rejected) attempt.recoveryVisible = true;
      // A conflicting/unauthorized original operation cannot be retried under
      // a fresh key by this action, nor silently reinterpreted as a new save.
      attempt.retryBlocked = rejected;
      message = rejected ? `의견 저장 요청이 거절되었습니다. ${error.message}` : unknownMessage;
      notify();
      if (!rejected) await refresh();
      return false;
    }
  };
  const retry = async () => {
    if (!live()) return false;
    const attempt = record.attempt;
    if (!attempt || attempt.phase !== 'unknown' || attempt.retryBlocked) return false;
    if (attempt.anchor !== anchor) {
      phase = 'unknown'; message = '이전 의견의 원래 단계·근거 연결을 확인하지 못해 다시 저장하지 않았습니다.'; notify(); return false;
    }
    return postAttempt(attempt, true);
  };
  const submit = async text => {
    if (!live()) return false;
    if (record.attempt?.phase === 'saving') return false;
    if (record.attempt?.phase === 'unknown') { await refresh(); return false; }
    let body;
    const prior = record.attempt;
    const cleaned = String(text ?? '').trim();
    const sameAttempt = prior?.body.text === cleaned && prior.editRevision === (record.editRevision || 0);
    if (sameAttempt && (prior.recovered || prior.retryBlocked)) {
      phase = prior.phase;
      message = prior.receipt ? `의견 #${prior.receipt.seq}은 저장되어 있습니다. 아래 의견 행에서 Chat 초안에 포함해 주세요.`
        : '이전 저장 요청은 거절되었습니다. 입력과 원래 대화 연결을 확인해 주세요.';
      notify(); return false;
    }
    try { body = briefingCommentRequest(origin, text, sameAttempt ? prior.body.clientRequestId : cleaned && cleaned.length <= BRIEFING_COMMENT_MAX ? makeId() : null).body; }
    catch (error) { phase = 'failed'; message = error.message; notify(); return false; }
    if (sameAttempt && prior.receipt) return attach(prior.receipt.id);
    const attempt = record.attempt = { body: copy(body), anchor, editRevision: record.editRevision || 0, phase: 'saving' };
    return postAttempt(attempt, false);
  };
  return { view, refresh, submit, retry, include: attach, notify,
    edit(text) { if (live() && record.text !== String(text)) { record.text = String(text); record.editRevision = (record.editRevision || 0) + 1; } },
    dispose() { if (disposed) return; disposed = true; if (record.attempt?.phase === 'saving') { record.attempt.phase = 'unknown'; record.attempt.recoveryVisible = true; } },
  };
}
