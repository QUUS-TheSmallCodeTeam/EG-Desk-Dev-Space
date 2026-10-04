// Presentation state only. No provider requests, inferred steps or automatic
// transitions; callers invoke navigation only in response to a user action.
import { usableArtifact } from './EGDeskChatState.sys.mjs';
import { inputEvidenceKey } from './EGDeskInputContext.sys.mjs';
const copy = value => JSON.parse(JSON.stringify(value));

export function validBriefing(briefing) {
  return typeof briefing?.id === 'string' && !!briefing.id && (briefing.title === undefined || typeof briefing.title === 'string')
    && Array.isArray(briefing.steps) && briefing.steps.length > 0
    && new Set(briefing.steps.map(step => step.id)).size === briefing.steps.length
    && briefing.steps.every(step => typeof step.id === 'string' && step.id
      && typeof step.text === 'string' && step.target && typeof step.target === 'object'
      && (step.fallback === undefined || typeof step.fallback === 'string'));
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

export function resolveBriefingTargets(step, { references = [], artifacts = [], views = [], identity = {} } = {}) {
  return (step?.target ? [step.target] : []).map(target => {
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
  const rects = (resolved || []).filter(item => item.status === 'available').map(item => item.view.geometry)
    .filter(rect => rect && ['x', 'y', 'width', 'height'].every(key => Number.isFinite(rect[key])) && rect.width > 0 && rect.height > 0);
  if (!rects.length) return null;
  const x = Math.min(...rects.map(rect => rect.x)), y = Math.min(...rects.map(rect => rect.y));
  return { x, y, width: Math.max(...rects.map(rect => rect.x + rect.width)) - x,
    height: Math.max(...rects.map(rect => rect.y + rect.height)) - y };
}

export function briefingCommentDraft(session, comment, resolved) {
  const step = currentBriefingStep(session);
  if (!step || !String(comment).trim()) throw new Error('단계 의견을 입력해 주세요.');
  return {
    briefingId: session.briefing.id, stepId: step.id,
    text: `[${session.briefing.title || '답변 브리핑'} · ${session.index + 1}단계 · ${session.briefing.id}/${step.id}]\n${step.text}\n\n의견: ${String(comment).trim()}`,
    contextSnapshotIds: [...new Set((resolved || []).filter(item => item.reference).map(item => item.reference.sourceId))],
  };
}
