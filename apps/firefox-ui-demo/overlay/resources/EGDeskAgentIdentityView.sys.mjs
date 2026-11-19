// AGENT-05: what the Chat and the Canvas show about *which* Agent is speaking,
// working, or acting on a Card — the author face beside an answer, one
// '[···] Agent 작업 중' bubble per busy run, and the Agent chip on a Card
// header. Pure display models: no DOM, no fetch. eg-desk-surface.uc.js draws
// what these return.
import { agentWorkingView, displayRunKey, displayProfileAvatar, isRunBusy, profileAvatarView } from './EGDeskChatState.sys.mjs';

export const AVATAR_ASSET_ID = /^img-[0-9a-f]{64}$/;
// D-A3: the profile store keeps PNG, JPEG and WebP photos of 512KB at most.
export const AVATAR_IMAGE_MEDIA_TYPES = Object.freeze(['image/png', 'image/jpeg', 'image/webp']);
export const AVATAR_IMAGE_MAX_BYTES = 512 * 1024;
const BASE64 = /^[A-Za-z0-9+/]+={0,2}$/;

export const isAvatarAssetId = value => typeof value === 'string' && AVATAR_ASSET_ID.test(value);

/** The face for an author: the saved emoji/initial/photo-initial on its tone; `assetId` names the photo to read. */
export function agentAvatarView(avatar, name = '') {
  const view = profileAvatarView(avatar, name);
  return { kind: view.kind, text: view.text, tone: view.tone, saved: view.saved, assetId: isAvatarAssetId(view.assetId) ? view.assetId : null };
}

/** A data: URL for one GET /profiles/avatar-images/:id reply, or null when it is not the photo asked for. */
export function agentAvatarImageSource(payload, assetId) {
  if (!payload || typeof payload !== 'object' || !isAvatarAssetId(assetId) || payload.assetId !== assetId) return null;
  const mediaType = typeof payload.mediaType === 'string' ? payload.mediaType.trim().toLowerCase() : '';
  if (!AVATAR_IMAGE_MEDIA_TYPES.includes(mediaType)) return null;
  const base64 = typeof payload.imageBase64 === 'string' ? payload.imageBase64.replace(/\s+/g, '') : '';
  if (!base64 || base64.length % 4 !== 0 || !BASE64.test(base64)) return null;
  const padding = base64.endsWith('==') ? 2 : base64.endsWith('=') ? 1 : 0;
  const bytes = base64.length / 4 * 3 - padding;
  if (bytes <= 0 || bytes > AVATAR_IMAGE_MAX_BYTES) return null;
  return `data:${mediaType};base64,${base64}`;
}

// AGENT-05: a photo that could not be read (the bridge was not up yet, a
// dropped connection) is asked for again after these waits, then left alone.
export const AVATAR_RETRY_DELAYS_MS = Object.freeze([2000, 8000, 30000]);

/**
 * Agent photos by asset id for one session. `get` answers the data: URL once
 * the photo has been read and null until then (the letter face stands in).
 * `load(assetId)` resolves the GET /profiles/avatar-images/:id reply; a read
 * that fails or is not the photo asked for is tried again after each wait in
 * `retryDelays`, and `onChange` runs when a photo arrives.
 */
export function createAvatarImageCache({ load, onChange, setTimer = (run, delay) => globalThis.setTimeout(run, delay), retryDelays = AVATAR_RETRY_DELAYS_MS } = {}) {
  const sources = new Map();
  const failures = new Map();
  const read = (assetId) => {
    Promise.resolve().then(() => load(assetId)).then((payload) => {
      const source = agentAvatarImageSource(payload, assetId);
      if (!source) throw new Error('The photo could not be read');
      sources.set(assetId, source);
      failures.delete(assetId);
      onChange?.();
    }).catch(() => {
      const failed = failures.get(assetId) || 0;
      if (failed >= retryDelays.length) return;
      failures.set(assetId, failed + 1);
      setTimer(() => { if (!sources.get(assetId)) read(assetId); }, retryDelays[failed]);
    });
  };
  return {
    get(assetId) {
      if (!isAvatarAssetId(assetId)) return null;
      if (sources.has(assetId)) return sources.get(assetId);
      sources.set(assetId, null);
      read(assetId);
      return null;
    },
  };
}

/** The avatar an answer shows: the one captured at send; older answers borrow the room Agent's while the name still matches. */
export function messageAuthorAvatar(message, author, roomProfile = null) {
  if (message?.role !== 'assistant') return null;
  const captured = displayProfileAvatar(message.authorAvatar);
  if (captured) return captured;
  return roomProfile?.avatar && roomProfile.name === author ? displayProfileAvatar(roomProfile.avatar) : null;
}

const authorName = (run, fallback) => typeof run?.authorName === 'string' && run.authorName.trim() ? run.authorName.trim() : fallback;

/**
 * One '[···] Agent 작업 중' row per busy run, in run order, each as the Agent
 * that run speaks as (captured at send), else the room Agent. Nothing while
 * 대표님 holds the native binding or the bridge cannot say. When several
 * Agents are at work in one room (or the room is a Board Thread), each row
 * also names its Agent above the bubble.
 */
export function agentWorkingRows(runs, { connected = true, held = false, roomName = 'Codex', roomAvatar = null, group = false } = {}) {
  if (held || !Array.isArray(runs)) return [];
  const rows = [];
  const seen = new Set();
  for (const run of runs) {
    if (!isRunBusy(run)) continue;
    const working = agentWorkingView(run, { connected });
    const runId = typeof run.runId === 'string' ? run.runId : '';
    const key = displayRunKey(run);
    if (!working || (key && seen.has(key))) continue;
    if (key) seen.add(key);
    rows.push({ runId, conversationId: run.conversationId || null, name: authorName(run, roomName), avatar: displayProfileAvatar(run.authorAvatar) || displayProfileAvatar(roomAvatar),
      state: working.state, text: working.text });
  }
  const showName = group || new Set(rows.map(row => row.name)).size > 1;
  return rows.map(row => ({ ...row, showName }));
}

/**
 * The Agent to name on a Card header, from the BRW-13 run bindings that hold
 * the Card: a run allowed to act wins over one only reading; the run's own
 * author (captured at send) wins over the room Agent. Null when no live run
 * holds the Card or its Chat cannot be found.
 */
export function resolveCardAgentIdentity(entries, { threadFor, runsFor, roomProfileFor } = {}) {
  const ranked = (Array.isArray(entries) ? entries : []).filter(entry => entry && typeof entry.clientThreadId === 'string' && entry.clientThreadId)
    .sort((a, b) => Number(b.permission === 'interact') - Number(a.permission === 'interact'));
  for (const entry of ranked) {
    const thread = threadFor?.(entry.clientThreadId) || null;
    if (!thread) continue;
    const run = (runsFor?.(thread) || []).find(candidate => candidate?.runId === entry.runId) || null;
    const room = roomProfileFor?.(thread) || null;
    return { name: authorName(run, typeof room?.name === 'string' && room.name.trim() ? room.name.trim() : 'Codex'),
      avatar: displayProfileAvatar(run?.authorAvatar) || displayProfileAvatar(room?.avatar),
      runId: typeof entry.runId === 'string' ? entry.runId : '', threadId: typeof thread.id === 'string' ? thread.id : '',
      permission: entry.permission === 'interact' ? 'interact' : 'observe' };
  }
  return null;
}

/**
 * The chip beside the BRW-13 badge: the Agent's face and name while it works
 * on the Card, kept through '최근 … 활동 N건', gone when 대표님 holds the Card
 * or the badge is hidden. `remembered` is the identity shown while operating;
 * `remember` is what to keep for the next refresh.
 */
export function cardAgentIdentityView(badge, identity = null, remembered = null) {
  const mode = badge?.mode;
  if (mode !== 'operating' && mode !== 'recent') return { shown: false, name: '', avatar: null, remember: null };
  const current = identity || (mode === 'recent' ? remembered : null);
  if (!current) return { shown: false, name: '', avatar: null, remember: mode === 'recent' ? remembered : null };
  return { shown: true, name: current.name, avatar: current.avatar || null, remember: current };
}

// ── AGENT-05: the Agent badge on a File card ──
// A run's file changes name absolute paths; a File card connected to a
// verified project knows its root's absolute path. A card shows the Agent of
// a run only when that run ran in the same project (projectId and rootId) and
// one of its paths lies inside the card's root. A card opened on a picked
// folder, another project, or a root that needs reconnecting shows nothing:
// the badge never tells a run about cards outside its own project.
const MAX_TOUCHED_PATHS = 200;
const absolutePath = value => {
  if (typeof value !== 'string' || value.length > 4096 || !value.startsWith('/') || /[\u0000-\u001f\u007f\\]/.test(value)) return null;
  const parts = value.split('/').slice(1);
  if (value.endsWith('/') && value !== '/') parts.pop();
  if (parts.some(part => !part || part === '.' || part === '..')) return null;
  return `/${parts.join('/')}`.normalize('NFC');
};
const idText = value => typeof value === 'string' && value.length > 0 && value.length <= 512 && !value.includes('\0');

/** Absolute paths a run's file changes name: fileChange activity details and verified file refs, deduplicated. */
export function runTouchedPaths(run) {
  const paths = [];
  const add = value => { const path = absolutePath(value); if (path && !paths.includes(path) && paths.length < MAX_TOUCHED_PATHS) paths.push(path); };
  for (const activity of Array.isArray(run?.activities) ? run.activities : []) {
    if (activity?.kind !== 'fileChange') continue;
    for (const change of Array.isArray(activity.detail?.changes) ? activity.detail.changes : []) add(change?.path);
    for (const ref of Array.isArray(activity.sourceRefs) ? activity.sourceRefs : []) if (ref?.type === 'file') add(ref.target?.path);
  }
  return paths;
}

/** The path below `root`, or null when it is not inside it (segment-wise; the root itself is not a file inside). */
export function pathInsideRoot(root, path) {
  const base = absolutePath(root), target = absolutePath(path);
  if (!base || !target) return null;
  const prefix = base === '/' ? '/' : `${base}/`;
  return target.startsWith(prefix) && target.length > prefix.length ? target.slice(prefix.length) : null;
}

/**
 * One badge per File card. runs: [{ runId, name, avatar, busy, project: { projectId, rootId } | null, paths }]
 * (paths from runTouchedPaths); cards: [{ cardId, scope: { projectId, rootId, rootPath } | null }].
 * A busy run wins over a finished one, then the run listed first. `files`
 * names up to three touched files below the root; `count` counts them all.
 */
export function fileCardAgentBadges(runs, cards) {
  const badges = [];
  for (const card of Array.isArray(cards) ? cards : []) {
    const scope = card?.scope;
    if (!idText(card?.cardId) || !idText(scope?.projectId) || !idText(scope?.rootId) || !absolutePath(scope?.rootPath)) continue;
    let best = null;
    for (const run of Array.isArray(runs) ? runs : []) {
      if (!run || run.project?.projectId !== scope.projectId || run.project?.rootId !== scope.rootId) continue;
      const inside = (Array.isArray(run.paths) ? run.paths : []).map(path => pathInsideRoot(scope.rootPath, path)).filter(Boolean);
      if (!inside.length) continue;
      const candidate = { run, inside, busy: run.busy === true };
      if (!best || (candidate.busy && !best.busy)) best = candidate;
    }
    if (!best) continue;
    const name = typeof best.run.name === 'string' && best.run.name.trim() ? best.run.name.trim() : 'Codex';
    badges.push({ cardId: card.cardId, runId: typeof best.run.runId === 'string' ? best.run.runId : '', name,
      avatar: displayProfileAvatar(best.run.avatar), busy: best.busy, count: best.inside.length, files: best.inside.slice(0, 3),
      text: `${name} · 파일 ${best.inside.length}개 ${best.busy ? '작업 중' : '작업함'}` });
  }
  return badges;
}
