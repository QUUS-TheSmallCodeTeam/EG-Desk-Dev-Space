import { performance } from 'node:perf_hooks'

// Beta default: two distinct CPU counter windows at >=95% aggregate utilization.
// Two windows at <=85% recover; the band between avoids threshold flapping.
// Memory's cache-inclusive usage is deliberately not a pressure input.
export const LOCAL_HOST_PRESSURE = 'local-host-pressure'
export const LOCAL_CAPACITY_POLL_MS = 1_000
export const LOCAL_CAPACITY_TTL_MS = 3_000
export const CPU_PRESSURE_PERCENT = 95
export const CPU_RECOVERY_PERCENT = 85
const REQUIRED_WINDOWS = 2
const MIN_WINDOW_MS = 500
const MAX_WINDOW_MS = 2_500
const MAX_UNOBSERVED_MS = 250

// The production caller closes over the monitor in this bridge process. No
// request, card, provider, or persisted data can set the source or clock.
// Unknown/unavailable/expired: retain the existing bounded scheduling policy,
// never treat it as zero CPU or a reason to hold a task indefinitely.
export function createLocalCapacity({ monitor, now = () => performance.now(),
  setPoll = setInterval, clearPoll = clearInterval } = {}) {
  let last = null, high = 0, low = 0, constrained = false, closed = false
  function reset() { last = null; high = 0; low = 0; constrained = false }
  function fresh(at, current) {
    return Number.isFinite(at) && Number.isFinite(current) && current >= at && current - at < LOCAL_CAPACITY_TTL_MS
  }
  function poll() {
    if (closed) return
    try {
      const sample = monitor.sampleCpu()
      const current = now()
      const { at, cpu } = sample ?? {}
      if (sample?.host !== 'local-computer' || sample.scope !== 'host' || !fresh(at, current) ||
          cpu?.status !== 'ok' || cpu.basis !== 'all-logical-cores' ||
          !Number.isFinite(cpu.percent) || cpu.percent < 0 || cpu.percent > 100 ||
          !Number.isFinite(cpu.intervalMs) || cpu.intervalMs < MIN_WINDOW_MS || cpu.intervalMs > MAX_WINDOW_MS) {
        reset(); return
      }
      if (at === last) return // Cached diagnostics never count twice.
      if (last !== null && (!fresh(last, at) || at - last - cpu.intervalMs > MAX_UNOBSERVED_MS)) {
        // A diagnostics-only measurement may have advanced the window while
        // the scheduler poll was late. Do not call disjoint windows sustained.
        high = 0; low = 0
        if (!fresh(last, at)) constrained = false
      }
      last = at
      high = cpu.percent >= CPU_PRESSURE_PERCENT ? high + 1 : 0
      low = cpu.percent <= CPU_RECOVERY_PERCENT ? low + 1 : 0
      if (high >= REQUIRED_WINDOWS) constrained = true
      if (low >= REQUIRED_WINDOWS) constrained = false
      high = Math.min(high, REQUIRED_WINDOWS)
      low = Math.min(low, REQUIRED_WINDOWS)
    } catch { reset() }
  }
  poll()
  const timer = setPoll(poll, LOCAL_CAPACITY_POLL_MS)
  timer?.unref?.()
  return {
    additionalLaunchReason() {
      return !closed && constrained && fresh(last, now()) ? LOCAL_HOST_PRESSURE : null
    },
    close() {
      if (closed) return
      closed = true
      clearPoll(timer)
      reset()
    },
  }
}
