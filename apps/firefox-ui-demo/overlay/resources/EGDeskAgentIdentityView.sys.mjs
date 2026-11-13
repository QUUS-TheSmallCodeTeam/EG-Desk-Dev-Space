// AGENT-05: what the Chat and the Canvas show about *which* Agent is speaking,
// working, or acting on a Card — the author face beside an answer, one
// '[···] Agent 작업 중' bubble per busy run, and the Agent chip on a Card
// header. Pure display models: no DOM, no fetch. eg-desk-surface.uc.js draws
// what these return.
import { agentWorkingView, displayProfileAvatar, isRunBusy, profileAvatarView } from './EGDeskChatState.sys.mjs';

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
    if (!working || (runId && seen.has(runId))) continue;
    if (runId) seen.add(runId);
    rows.push({ runId, name: authorName(run, roomName), avatar: displayProfileAvatar(run.authorAvatar) || displayProfileAvatar(roomAvatar),
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
