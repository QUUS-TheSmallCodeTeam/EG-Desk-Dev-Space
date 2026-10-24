// ChatGPT subscription usage from codex 0.162.1 app-server:
// account/rateLimits/read (GetAccountRateLimitsResponse) and the sparse
// account/rateLimits/updated notification. The main Codex allowance is read:
// the single-bucket `rateLimits` view while it belongs to it, else the
// `rateLimitsByLimitId.codex` bucket. A model-specific bucket (limitId other
// than 'codex') never replaces the main 5-hour/weekly rows (SUB-03/14).
// Limit IDs, credits, upsell banners and backend account IDs never enter
// public state. Unreported usage stays null — it is never shown as 0%.
//
// Main-bucket filter and plan-based window defaults follow the pattern of
// t3code apps/server/src/provider/codexUsageLimits.ts:59-74, :131, :167-173
// (MIT, Copyright (c) 2026 T3 Tools Inc.); the code here is our own.
import { publicPlanType } from './codex-auth-state.mjs'

// RateLimitReachedType enum of the same schema.
export const RATE_LIMIT_REACHED_TYPES = new Set([
  'rate_limit_reached',
  'workspace_owner_credits_depleted',
  'workspace_member_credits_depleted',
  'workspace_owner_usage_limit_reached',
  'workspace_member_usage_limit_reached',
])

export const USAGE_STALE_AFTER_MS = 15 * 60 * 1000
export const USAGE_WARN_PERCENT = 80

const MAX_WINDOW_MINUTES = 366 * 24 * 60
const MIN_EPOCH_MS = 946684800000 // 2000-01-01T00:00:00Z
const MAX_EPOCH_MS = 253402300799999 // 9999-12-31T23:59:59.999Z
const SECONDS_BELOW = 1e12 // smaller epoch values are seconds (1e12 ms is 2001)

// int64 epoch → ms. The schema leaves resetsAt's unit undocumented; every
// documented app-server timestamp is Unix seconds, so small values are
// seconds and values already in ms pass through. ISO strings are accepted.
export function publicEpochMs(value) {
  let ms = null
  if (typeof value === 'number' && Number.isFinite(value) && value > 0) ms = value < SECONDS_BELOW ? value * 1000 : value
  else if (typeof value === 'string' && value.length <= 40 && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,9})?)?(?:Z|[+-]\d{2}:\d{2})$/.test(value)) ms = Date.parse(value)
  return Number.isFinite(ms) && ms >= MIN_EPOCH_MS && ms <= MAX_EPOCH_MS ? Math.round(ms) : null
}

function publicPercent(value) {
  if (typeof value !== 'number' || !Number.isFinite(value)) return null
  return Math.min(100, Math.max(0, value))
}

function publicWindowMinutes(value) {
  return Number.isInteger(value) && value > 0 && value <= MAX_WINDOW_MINUTES ? value : null
}

// RateLimitWindow: usedPercent is required, so a window without it is absent.
function publicWindow(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const usedPercent = publicPercent(value.usedPercent)
  if (usedPercent === null) return null
  return { usedPercent, windowMinutes: publicWindowMinutes(value.windowDurationMins), resetsAt: publicEpochMs(value.resetsAt) }
}

function publicReachedType(value) {
  return typeof value === 'string' && RATE_LIMIT_REACHED_TYPES.has(value) ? value : null
}

export const MAIN_LIMIT_ID = 'codex'
const SESSION_MINUTES = 5 * 60
const WEEK_MINUTES = 7 * 24 * 60
const MONTH_MINUTES = 30 * 24 * 60
// Free and Go plans have one monthly allowance; paid plans the 5-hour and weekly pair.
const MONTHLY_PLANS = new Set(['free', 'go'])

const plainObject = value => value && typeof value === 'object' && !Array.isArray(value) ? value : null

// An absent or null limitId is the main allowance (older CLIs omit it).
function isMainBucket(snapshot) {
  return snapshot.limitId == null || snapshot.limitId === MAIN_LIMIT_ID
}

function snapshotOf(value) {
  return plainObject(value?.rateLimits)
}

// Full read: the single-bucket view when it is the main allowance, else the
// keyed main bucket; a model-specific view alone reports nothing.
function mainSnapshotOf(nativeResult) {
  const single = snapshotOf(nativeResult)
  if (single && isMainBucket(single)) return single
  const keyed = plainObject(plainObject(nativeResult?.rateLimitsByLimitId)?.[MAIN_LIMIT_ID])
  return keyed && isMainBucket(keyed) ? keyed : null
}

// primary/secondary are positions, not durations. Without a reported length
// the plan decides it; an unknown plan leaves it unknown (never guessed).
function defaultWindowMinutes(position, planType) {
  const plan = publicPlanType(planType)
  if (!plan || plan === 'unknown') return null
  if (position === 'secondary') return WEEK_MINUTES
  return MONTHLY_PLANS.has(plan) ? MONTH_MINUTES : SESSION_MINUTES
}

function withDefaultWindow(window, position, planType) {
  if (!window || window.windowMinutes !== null) return window
  const windowMinutes = defaultWindowMinutes(position, planType)
  return windowMinutes === null ? window : { ...window, windowMinutes }
}

function observedNow(now) {
  return Number.isFinite(now) && now > 0 ? Math.round(now) : Date.now()
}

// Full read result → public limits, or null when nothing was reported.
// usageAllowed mirrors ordinaryUsageAllowed (null = unavailable).
export function normalizeRateLimits(nativeResult, now = Date.now()) {
  const snapshot = mainSnapshotOf(nativeResult)
  if (!snapshot) return null
  return {
    primary: withDefaultWindow(publicWindow(snapshot.primary), 'primary', snapshot.planType),
    secondary: withDefaultWindow(publicWindow(snapshot.secondary), 'secondary', snapshot.planType),
    reachedType: publicReachedType(snapshot.rateLimitReachedType),
    usageAllowed: typeof nativeResult.ordinaryUsageAllowed === 'boolean' ? nativeResult.ordinaryUsageAllowed : null,
    observedAt: observedNow(now),
  }
}

function mergeWindow(prev, next, now) {
  if (!next) return prev
  if (!prev) return next
  // A rolling update's null metadata does not clear an observed value, but a
  // reset time already in the past belongs to an elapsed window.
  const keptReset = prev.resetsAt !== null && prev.resetsAt > now ? prev.resetsAt : null
  return { usedPercent: next.usedPercent, windowMinutes: next.windowMinutes ?? prev.windowMinutes, resetsAt: next.resetsAt ?? keptReset }
}

// Sparse account/rateLimits/updated merge (JSON-RPC message or its params).
// Nulls never clear prior values, so a reached limit only clears on a full
// account/rateLimits/read; recovery is not inferred from percentages. An
// update for another bucket (e.g. a model-specific allowance) changes nothing.
export function applyRateLimitsUpdate(prev, notification, now = Date.now()) {
  const snapshot = snapshotOf(notification?.params ?? notification)
  if (!snapshot || !isMainBucket(snapshot)) return prev || null
  const at = observedNow(now)
  const base = prev && typeof prev === 'object' ? prev : { primary: null, secondary: null, reachedType: null, usageAllowed: null }
  return {
    primary: withDefaultWindow(mergeWindow(base.primary || null, publicWindow(snapshot.primary), at), 'primary', snapshot.planType),
    secondary: withDefaultWindow(mergeWindow(base.secondary || null, publicWindow(snapshot.secondary), at), 'secondary', snapshot.planType),
    reachedType: publicReachedType(snapshot.rateLimitReachedType) ?? publicReachedType(base.reachedType),
    usageAllowed: typeof base.usageAllowed === 'boolean' ? base.usageAllowed : null,
    observedAt: at,
  }
}

function windowLabel(minutes) {
  if (minutes === null) return null
  if (minutes === 7 * 24 * 60) return '주간 한도'
  if (minutes % (24 * 60) === 0) return `${minutes / (24 * 60)}일 한도`
  if (minutes % 60 === 0) return `${minutes / 60}시간 한도`
  return `${minutes}분 한도`
}

// Absolute local clock time, e.g. '오후 3:20에 초기화'; another day adds the date.
function resetLabel(resetsAt, now) {
  const at = new Date(resetsAt)
  const today = new Date(now)
  const hours = at.getHours()
  const clock = `${hours < 12 ? '오전' : '오후'} ${hours % 12 || 12}:${String(at.getMinutes()).padStart(2, '0')}`
  const sameDay = at.getFullYear() === today.getFullYear() && at.getMonth() === today.getMonth() && at.getDate() === today.getDate()
  const year = at.getFullYear() === today.getFullYear() ? '' : `${at.getFullYear()}년 `
  return `${sameDay ? '' : `${year}${at.getMonth() + 1}월 ${at.getDate()}일 `}${clock}에 초기화`
}

const unknownDisplay = { level: 'unknown', percentLabel: null, windowLabel: null, resetLabel: null, resetsAt: null, stale: false }

// Screen values for the Chat header/Settings. The most-used window is shown
// (a full weekly window blocks even when the 5-hour one is low). Credits or
// workspace limits do not recover at the window reset, so no reset is shown.
export function usageDisplay(limits, now = Date.now()) {
  if (!limits || typeof limits !== 'object') return { ...unknownDisplay }
  const windows = [limits.primary, limits.secondary]
    .map(window => window && typeof window === 'object' ? { ...window, usedPercent: publicPercent(window.usedPercent) } : null)
    .filter(window => window && window.usedPercent !== null)
  const shown = windows.reduce((max, window) => (!max || window.usedPercent > max.usedPercent ? window : max), null)
  const reached = publicReachedType(limits.reachedType)
  const level = reached || limits.usageAllowed === false || shown?.usedPercent >= 100 ? 'limit'
    : !shown ? 'unknown'
      : shown.usedPercent >= USAGE_WARN_PERCENT ? 'warn' : 'ok'
  const resetsAt = shown && (!reached || reached === 'rate_limit_reached') ? publicEpochMs(shown.resetsAt) : null
  const resetPassed = resetsAt !== null && resetsAt <= now
  const observedAt = Number.isFinite(limits.observedAt) ? limits.observedAt : 0
  return {
    level,
    percentLabel: level === 'limit' ? '한도 도달' : shown ? `${Math.floor(shown.usedPercent)}% 사용` : null,
    windowLabel: shown ? windowLabel(publicWindowMinutes(shown.windowMinutes)) : null,
    resetLabel: resetsAt !== null && !resetPassed ? resetLabel(resetsAt, now) : null,
    resetsAt: resetPassed ? null : resetsAt,
    // Old observation, or the shown percentage belongs to an elapsed window.
    stale: now - observedAt > USAGE_STALE_AFTER_MS || resetPassed,
  }
}
