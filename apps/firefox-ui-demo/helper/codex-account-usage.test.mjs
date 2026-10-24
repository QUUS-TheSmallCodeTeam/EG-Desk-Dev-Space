import test from 'node:test'
import assert from 'node:assert/strict'
import {
  applyRateLimitsUpdate, MAIN_LIMIT_ID, normalizeRateLimits, publicEpochMs, RATE_LIMIT_REACHED_TYPES,
  USAGE_STALE_AFTER_MS, usageDisplay,
} from './codex-account-usage.mjs'

// Local-clock fixtures keep the Korean reset label independent of the host TZ.
const now = new Date(2026, 9, 24, 13, 0, 0).getTime()
const at = (h, m, day = 24) => new Date(2026, 9, day, h, m, 0).getTime()
const sec = ms => Math.floor(ms / 1000)

// Shape of codex 0.162.1 GetAccountRateLimitsResponse.
const readResult = (snapshot, extra = {}) => ({ rateLimits: snapshot, ...extra })
const window = (usedPercent, windowDurationMins, resetsAt) => ({ usedPercent, windowDurationMins, resetsAt })

test('normalizeRateLimits keeps only public window fields and converts epoch seconds to ms', () => {
  const limits = normalizeRateLimits(readResult({
    primary: window(42, 300, sec(at(15, 20))),
    secondary: window(10, 10080, sec(at(9, 0, 30))),
    rateLimitReachedType: null,
    planType: 'pro', limitId: 'codex', limitName: 'Codex', credits: { hasCredits: true, unlimited: false, balance: '12' },
    individualLimit: { limit: '1', used: '1', remainingPercent: 0, resetsAt: 1 }, opaquePrivatePayload: 'DO_NOT_COPY',
  }, {
    accountId: 'backend-account-DO_NOT_COPY', ordinaryUsageAllowed: true,
    rateLimitsByLimitId: { codex: { primary: window(99, 300, 1) } }, rateLimitUpsell: { banner: 'DO_NOT_COPY' },
    rateLimitResetCredits: { availableCount: 1, credits: [{ id: 'DO_NOT_COPY' }] },
  }), now)
  assert.deepEqual(limits, {
    primary: { usedPercent: 42, windowMinutes: 300, resetsAt: at(15, 20) },
    secondary: { usedPercent: 10, windowMinutes: 10080, resetsAt: at(9, 0, 30) },
    reachedType: null,
    usageAllowed: true,
    observedAt: now,
  })
  assert.ok(!JSON.stringify(limits).includes('DO_NOT_COPY'))
})

test('unreported usage stays null and is never invented as 0%', () => {
  assert.equal(normalizeRateLimits(null, now), null)
  assert.equal(normalizeRateLimits({}, now), null)
  assert.equal(normalizeRateLimits({ rateLimits: null }, now), null)
  assert.equal(normalizeRateLimits({ rateLimits: [] }, now), null)
  const empty = normalizeRateLimits(readResult({}), now)
  assert.deepEqual(empty, { primary: null, secondary: null, reachedType: null, usageAllowed: null, observedAt: now })
  // usedPercent is the schema's only required window field.
  const missing = normalizeRateLimits(readResult({ primary: { windowDurationMins: 300, resetsAt: sec(at(15, 0)) }, secondary: null }), now)
  assert.equal(missing.primary, null)
  assert.equal(missing.secondary, null)
  for (const usedPercent of ['42', null, undefined, NaN, Infinity, {}, true]) {
    assert.equal(normalizeRateLimits(readResult({ primary: { usedPercent } }), now).primary, null)
  }
  const sparse = normalizeRateLimits(readResult({ primary: { usedPercent: 5 } }), now).primary
  assert.deepEqual(sparse, { usedPercent: 5, windowMinutes: null, resetsAt: null })
  const display = usageDisplay(empty, now)
  assert.equal(display.level, 'unknown')
  assert.equal(display.percentLabel, null)
})

test('usedPercent is clamped to 0..100 and decimals are preserved', () => {
  const pct = usedPercent => normalizeRateLimits(readResult({ primary: { usedPercent } }), now).primary.usedPercent
  assert.equal(pct(-5), 0)
  assert.equal(pct(0), 0)
  assert.equal(pct(42.5), 42.5)
  assert.equal(pct(100), 100)
  assert.equal(pct(140), 100)
})

test('window minutes and reset times reject malformed values', () => {
  const first = primary => normalizeRateLimits(readResult({ primary }), now).primary
  for (const windowDurationMins of [0, -300, 1.5, '300', 600000, null]) assert.equal(first({ usedPercent: 1, windowDurationMins }).windowMinutes, null)
  for (const resetsAt of [0, -1, 5, '1761300000', 'tomorrow', '2026-10-24', NaN, 1e17, {}]) assert.equal(first({ usedPercent: 1, resetsAt }).resetsAt, null)
})

test('publicEpochMs accepts epoch seconds, epoch ms and ISO, and returns integer ms', () => {
  const ms = Date.UTC(2026, 9, 24, 6, 20, 0)
  assert.equal(publicEpochMs(ms / 1000), ms)
  assert.equal(publicEpochMs(ms), ms)
  assert.equal(publicEpochMs(ms + 0.4), ms)
  assert.equal(publicEpochMs('2026-10-24T06:20:00Z'), ms)
  assert.equal(publicEpochMs('2026-10-24T15:20:00+09:00'), ms)
  assert.equal(publicEpochMs('2026-10-24T06:20:00'), null)
  assert.equal(publicEpochMs(null), null)
})

test('reachedType passes only as a schema enum value', () => {
  assert.deepEqual([...RATE_LIMIT_REACHED_TYPES].sort(), ['rate_limit_reached', 'workspace_member_credits_depleted',
    'workspace_member_usage_limit_reached', 'workspace_owner_credits_depleted', 'workspace_owner_usage_limit_reached'])
  for (const reachedType of RATE_LIMIT_REACHED_TYPES) {
    assert.equal(normalizeRateLimits(readResult({ rateLimitReachedType: reachedType }), now).reachedType, reachedType)
  }
  for (const reachedType of ['RATE_LIMIT_REACHED', 'rateLimitReached', 'quota', '', 1, {}]) {
    assert.equal(normalizeRateLimits(readResult({ rateLimitReachedType: reachedType }), now).reachedType, null)
  }
  for (const ordinaryUsageAllowed of ['false', 0, null, undefined]) {
    assert.equal(normalizeRateLimits(readResult({}, { ordinaryUsageAllowed }), now).usageAllowed, null)
  }
  assert.equal(normalizeRateLimits(readResult({}, { ordinaryUsageAllowed: false }), now).usageAllowed, false)
})

test('applyRateLimitsUpdate merges a sparse rolling update without clearing observed values', () => {
  const prev = normalizeRateLimits(readResult({
    primary: window(42, 300, sec(at(15, 20))), secondary: window(10, 10080, sec(at(9, 0, 30))), rateLimitReachedType: 'rate_limit_reached',
  }, { ordinaryUsageAllowed: false }), now)
  const later = now + 60_000
  const message = { method: 'account/rateLimits/updated', params: { rateLimits: { primary: { usedPercent: 47, windowDurationMins: null, resetsAt: null }, secondary: null, rateLimitReachedType: null, planType: null } } }
  const next = applyRateLimitsUpdate(prev, message, later)
  assert.deepEqual(next, {
    primary: { usedPercent: 47, windowMinutes: 300, resetsAt: at(15, 20) },
    secondary: { usedPercent: 10, windowMinutes: 10080, resetsAt: at(9, 0, 30) },
    // Null reachedType in a rolling update is "unavailable", not recovery.
    reachedType: 'rate_limit_reached',
    usageAllowed: false,
    observedAt: later,
  })
  // Params form is accepted too.
  assert.deepEqual(applyRateLimitsUpdate(prev, message.params, later), next)
  assert.equal(prev.primary.usedPercent, 42)
})

test('applyRateLimitsUpdate takes new values, drops elapsed resets, and ignores invalid notifications', () => {
  const prev = normalizeRateLimits(readResult({ primary: window(90, 300, sec(at(12, 0))) }), now)
  const replaced = applyRateLimitsUpdate(prev, { rateLimits: { primary: window(3, 300, sec(at(17, 0))), rateLimitReachedType: 'workspace_owner_credits_depleted' } }, now)
  assert.deepEqual(replaced.primary, { usedPercent: 3, windowMinutes: 300, resetsAt: at(17, 0) })
  assert.equal(replaced.reachedType, 'workspace_owner_credits_depleted')
  // prev reset (12:00) is already past at 13:00, so it is not carried over.
  const elapsed = applyRateLimitsUpdate(prev, { rateLimits: { primary: { usedPercent: 1 } } }, now)
  assert.deepEqual(elapsed.primary, { usedPercent: 1, windowMinutes: 300, resetsAt: null })
  assert.equal(applyRateLimitsUpdate(prev, null, now), prev)
  assert.equal(applyRateLimitsUpdate(prev, { params: {} }, now), prev)
  assert.equal(applyRateLimitsUpdate(null, { rateLimits: 'x' }, now), null)
  const fromNothing = applyRateLimitsUpdate(null, { rateLimits: { secondary: window(55, 10080, null), rateLimitReachedType: 'bogus' } }, now)
  assert.deepEqual(fromNothing, { primary: null, secondary: { usedPercent: 55, windowMinutes: 10080, resetsAt: null }, reachedType: null, usageAllowed: null, observedAt: now })
})

test('usageDisplay shows level, percent, window and an absolute Korean reset time', () => {
  const limits = normalizeRateLimits(readResult({ primary: window(42, 300, sec(at(15, 20))), secondary: window(10, 10080, sec(at(9, 0, 30))) }), now)
  assert.deepEqual(usageDisplay(limits, now), {
    level: 'ok', percentLabel: '42% 사용', windowLabel: '5시간 한도', resetLabel: '오후 3:20에 초기화', resetsAt: at(15, 20), stale: false,
  })
  const warn = normalizeRateLimits(readResult({ primary: window(80.9, 300, sec(at(9, 5))) }), at(8, 0))
  assert.deepEqual(usageDisplay(warn, at(8, 0)), {
    level: 'warn', percentLabel: '80% 사용', windowLabel: '5시간 한도', resetLabel: '오전 9:05에 초기화', resetsAt: at(9, 5), stale: false,
  })
  assert.equal(usageDisplay(normalizeRateLimits(readResult({ primary: window(79.9, 300, null) }), now), now).level, 'ok')
})

test('Korean reset labels use 12-hour clock and add the date on another day', () => {
  const label = (h, m, day = 24) => usageDisplay(normalizeRateLimits(readResult({ primary: window(1, 60, sec(at(h, m, day))) }), now), now).resetLabel
  assert.equal(label(15, 20), '오후 3:20에 초기화')
  assert.equal(label(12, 5, 25), '10월 25일 오후 12:05에 초기화')
  assert.equal(label(0, 7, 25), '10월 25일 오전 12:07에 초기화')
  assert.equal(label(23, 59), '오후 11:59에 초기화')
  const nextYear = new Date(2027, 0, 2, 10, 30).getTime()
  assert.equal(usageDisplay(normalizeRateLimits(readResult({ primary: window(1, 60, nextYear) }), now), now).resetLabel, '2027년 1월 2일 오전 10:30에 초기화')
})

test('usageDisplay shows the most-used window, so a full weekly window is a limit', () => {
  const limits = normalizeRateLimits(readResult({ primary: window(20, 300, sec(at(15, 0))), secondary: window(100, 10080, sec(at(9, 0, 27))) }), now)
  assert.deepEqual(usageDisplay(limits, now), {
    level: 'limit', percentLabel: '한도 도달', windowLabel: '주간 한도', resetLabel: '10월 27일 오전 9:00에 초기화', resetsAt: at(9, 0, 27), stale: false,
  })
  assert.equal(usageDisplay(normalizeRateLimits(readResult({ primary: window(5, 1440, null) }), now), now).windowLabel, '1일 한도')
  assert.equal(usageDisplay(normalizeRateLimits(readResult({ primary: window(5, 90, null) }), now), now).windowLabel, '90분 한도')
})

test('reached limits and blocked usage are limits; credit/workspace limits show no window reset', () => {
  const reached = type => usageDisplay(normalizeRateLimits(readResult({ primary: window(60, 300, sec(at(15, 20))), rateLimitReachedType: type }), now), now)
  assert.equal(reached('rate_limit_reached').level, 'limit')
  assert.equal(reached('rate_limit_reached').resetLabel, '오후 3:20에 초기화')
  for (const type of ['workspace_owner_credits_depleted', 'workspace_member_credits_depleted', 'workspace_owner_usage_limit_reached', 'workspace_member_usage_limit_reached']) {
    assert.equal(reached(type).level, 'limit')
    assert.equal(reached(type).percentLabel, '한도 도달')
    assert.equal(reached(type).resetLabel, null)
    assert.equal(reached(type).resetsAt, null)
  }
  const blocked = usageDisplay(normalizeRateLimits(readResult({}, { ordinaryUsageAllowed: false }), now), now)
  assert.equal(blocked.level, 'limit')
  assert.equal(blocked.windowLabel, null)
  assert.equal(blocked.resetLabel, null)
})

test('stale after 15 minutes of no observation, or once the shown window has reset', () => {
  const limits = normalizeRateLimits(readResult({ primary: window(42, 300, sec(at(18, 0))) }), now)
  assert.equal(usageDisplay(limits, now + USAGE_STALE_AFTER_MS).stale, false)
  assert.equal(usageDisplay(limits, now + USAGE_STALE_AFTER_MS + 1).stale, true)
  const elapsed = usageDisplay(limits, at(18, 0))
  assert.equal(elapsed.stale, true)
  assert.equal(elapsed.resetLabel, null)
  assert.equal(elapsed.resetsAt, null)
  // An elapsed window does not turn a limit into recovery.
  const full = normalizeRateLimits(readResult({ primary: window(100, 300, sec(at(13, 30))) }), now)
  assert.equal(usageDisplay(full, at(14, 0)).level, 'limit')
  assert.equal(usageDisplay({ primary: { usedPercent: 3, windowMinutes: null, resetsAt: null }, secondary: null }, now).stale, true)
})

test('usageDisplay is unknown without limits and tolerates malformed input', () => {
  for (const limits of [null, undefined, 'x', 5]) {
    assert.deepEqual(usageDisplay(limits, now), { level: 'unknown', percentLabel: null, windowLabel: null, resetLabel: null, resetsAt: null, stale: false })
  }
  const odd = usageDisplay({ primary: { usedPercent: -20, windowMinutes: 'x', resetsAt: 'soon' }, secondary: 7, reachedType: 'bogus', observedAt: now }, now)
  assert.deepEqual(odd, { level: 'ok', percentLabel: '0% 사용', windowLabel: null, resetLabel: null, resetsAt: null, stale: false })
})

// SUB-03/14: a model-specific bucket (limitId other than 'codex') must never
// replace the main 5-hour/weekly rows (t3code codexUsageLimits.ts:69, :173).
test('a model-specific bucket never replaces the main allowance, on a read or a sparse update', () => {
  assert.equal(MAIN_LIMIT_ID, 'codex')
  const main = normalizeRateLimits(readResult({ limitId: 'codex', planType: 'pro', primary: window(30, 300, sec(at(15, 0))), secondary: window(12, 10080, sec(at(9, 0, 30))) }), now)
  const spark = { method: 'account/rateLimits/updated', params: { rateLimits: { limitId: 'codex_spark', limitName: 'Spark', planType: 'pro', primary: window(97, 300, sec(at(14, 0))), secondary: window(99, 10080, null), rateLimitReachedType: 'rate_limit_reached' } } }
  assert.equal(applyRateLimitsUpdate(main, spark, now + 1000), main, 'the other bucket changes nothing, not even observedAt')
  assert.equal(applyRateLimitsUpdate(null, spark, now), null)
  assert.equal(usageDisplay(applyRateLimitsUpdate(main, spark, now), now).percentLabel, '30% 사용')
  // Unlabelled (older CLI) and explicitly 'codex' updates still merge.
  assert.equal(applyRateLimitsUpdate(main, { rateLimits: { primary: { usedPercent: 41 } } }, now).primary.usedPercent, 41)
  assert.equal(applyRateLimitsUpdate(main, { rateLimits: { limitId: null, primary: { usedPercent: 42 } } }, now).primary.usedPercent, 42)
  assert.equal(applyRateLimitsUpdate(main, { rateLimits: { limitId: 'codex', primary: { usedPercent: 43 } } }, now).primary.usedPercent, 43)
  // A read whose single view is another bucket falls back to the keyed main bucket.
  const fallback = normalizeRateLimits(readResult({ limitId: 'codex_spark', primary: window(97, 300, null) }, {
    ordinaryUsageAllowed: true, rateLimitsByLimitId: { codex_spark: { limitId: 'codex_spark', primary: window(97, 300, null) }, codex: { limitId: 'codex', primary: window(25, 300, sec(at(16, 0))) } },
  }), now)
  assert.deepEqual(fallback, { primary: { usedPercent: 25, windowMinutes: 300, resetsAt: at(16, 0) }, secondary: null, reachedType: null, usageAllowed: true, observedAt: now })
  // Only another bucket reported: nothing is shown rather than the wrong allowance.
  assert.equal(normalizeRateLimits(readResult({ limitId: 'codex_spark', primary: window(97, 300, null) }), now), null)
  assert.equal(normalizeRateLimits(readResult({ limitId: 'codex_spark', primary: window(97, 300, null) }, { rateLimitsByLimitId: { codex: { limitId: 'other', primary: window(1, 300, null) } } }), now), null)
  for (const keyed of [null, [], 'codex', { codex: [] }, { codex: 'x' }]) {
    assert.equal(normalizeRateLimits(readResult({ limitId: 'codex_spark' }, { rateLimitsByLimitId: keyed }), now), null)
  }
  assert.ok(!JSON.stringify(fallback).includes('codex'), 'limit IDs never enter public state')
})

test('a missing window length comes from the plan: 5-hour and weekly when paid, 30 days on Free/Go, unknown otherwise', () => {
  const sparse = planType => normalizeRateLimits(readResult({ planType, primary: { usedPercent: 10 }, secondary: { usedPercent: 4 } }), now)
  assert.deepEqual([sparse('plus').primary.windowMinutes, sparse('plus').secondary.windowMinutes], [300, 10080])
  assert.deepEqual([sparse('pro').primary.windowMinutes, sparse('team').secondary.windowMinutes], [300, 10080])
  assert.deepEqual([sparse('free').primary.windowMinutes, sparse('go').primary.windowMinutes], [43200, 43200])
  assert.equal(usageDisplay(sparse('free'), now).windowLabel, '30일 한도')
  assert.equal(usageDisplay(sparse('plus'), now).windowLabel, '5시간 한도')
  for (const planType of [undefined, null, 'unknown', 'PLUS', 'premium', 7]) {
    assert.deepEqual([sparse(planType).primary.windowMinutes, sparse(planType).secondary.windowMinutes], [null, null], String(planType))
  }
  // A reported length always wins over the plan default.
  assert.equal(normalizeRateLimits(readResult({ planType: 'free', primary: window(1, 300, null) }), now).primary.windowMinutes, 300)
  // Sparse update: an observed length is kept; the plan fills only a still-unknown one.
  const prev = normalizeRateLimits(readResult({ primary: window(5, 1440, null) }), now)
  assert.equal(applyRateLimitsUpdate(prev, { rateLimits: { planType: 'plus', primary: { usedPercent: 6 } } }, now).primary.windowMinutes, 1440)
  const fresh = applyRateLimitsUpdate(null, { rateLimits: { planType: 'plus', primary: { usedPercent: 6 }, secondary: { usedPercent: 2 } } }, now)
  assert.deepEqual([fresh.primary.windowMinutes, fresh.secondary.windowMinutes], [300, 10080])
  assert.equal(applyRateLimitsUpdate(null, { rateLimits: { primary: { usedPercent: 6 } } }, now).primary.windowMinutes, null)
})
