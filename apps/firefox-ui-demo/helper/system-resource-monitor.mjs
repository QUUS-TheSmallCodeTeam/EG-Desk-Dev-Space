import { execFile } from 'node:child_process'
import { statfs } from 'node:fs/promises'
import os from 'node:os'
import { performance } from 'node:perf_hooks'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)
const SAMPLE_INTERVAL_MS = 5_000
const MAX_COUNTER_GAP_MS = 30_000
const MIN_COUNTER_INTERVAL_MS = 250
const DISK_TIMEOUT_MS = 1_000
const MAX_PENDING_DISK_READS = 2
const MAX_SAFE_BIGINT = BigInt(Number.MAX_SAFE_INTEGER)
const CPU_TIME_KEYS = ['user', 'nice', 'sys', 'idle', 'irq']

const percent = (part, whole) => Math.round(part / whole * 1_000) / 10
const emptyCpu = status => ({ status, percent: null, basis: 'all-logical-cores', intervalMs: null })
const emptyMemory = status => ({ status, usedBytes: null, totalBytes: null, percent: null, basis: 'total-minus-os-free' })
const emptyDisk = status => ({ status, usedBytes: null, totalBytes: null, percent: null, target: 'profile-volume', basis: 'volume-blocks-minus-free-blocks' })
const emptyNetwork = (status, interfaceName = null) => ({ status, interface: interfaceName, rxBytesPerSecond: null, txBytesPerSecond: null, intervalMs: null })

function cpuTotals(entries) {
  if (!Array.isArray(entries) || entries.length === 0) return null
  let total = 0, idle = 0
  const perCore = []
  for (const entry of entries) {
    const times = entry?.times
    if (!times) return null
    const core = []
    for (const key of CPU_TIME_KEYS) {
      if (!Number.isFinite(times[key]) || times[key] < 0) return null
      total += times[key]
      core.push(times[key])
    }
    perCore.push(core)
    idle += times.idle
  }
  return Number.isSafeInteger(total) && Number.isSafeInteger(idle) ? { total, idle, cores: entries.length, perCore } : null
}

function memorySnapshot(total, free) {
  // os.freemem() excludes reclaimable cache on macOS. This is occupied RAM,
  // including cache, not Activity Monitor's Memory Pressure or app-only load.
  if (!Number.isSafeInteger(total) || total <= 0 || !Number.isSafeInteger(free) || free < 0 || free > total) return emptyMemory('unavailable')
  const usedBytes = total - free
  return { status: 'ok', usedBytes, totalBytes: total, percent: percent(usedBytes, total), basis: 'total-minus-os-free' }
}

function diskSnapshot(stats) {
  try {
    const blockSize = BigInt(stats.bsize)
    const total = BigInt(stats.blocks) * blockSize
    const free = BigInt(stats.bfree) * blockSize
    if (blockSize <= 0n || total <= 0n || total > MAX_SAFE_BIGINT || free < 0n || free > total) return emptyDisk('unavailable')
    const totalBytes = Number(total), usedBytes = Number(total - free)
    return { status: 'ok', usedBytes, totalBytes, percent: percent(usedBytes, totalBytes), target: 'profile-volume', basis: 'volume-blocks-minus-free-blocks' }
  } catch { return emptyDisk('unavailable') }
}

// Only the default route's link-layer row is used. Protocol rows repeat the
// same counters, and neither addresses nor the route gateway leave this module.
export function parseMacDefaultInterface(output) {
  return /^[ \t]*interface:[ \t]*([a-zA-Z0-9_.-]+)[ \t]*$/m.exec(output)?.[1] ?? null
}

export function parseMacNetworkCounters(output, interfaceName) {
  if (typeof output !== 'string' || !/^[a-zA-Z0-9_.-]+$/.test(interfaceName || '')) return null
  for (const line of output.split(/\r?\n/)) {
    const fields = line.trim().split(/\s+/)
    if (fields[0] !== interfaceName || !/^<Link#\d+>$/.test(fields[2] || '') || fields.length < 10) continue
    const counters = fields.slice(-7)
    if (counters.length !== 7 || !/^\d+$/.test(counters[2]) || !/^\d+$/.test(counters[5])) return null
    return { interface: interfaceName, rxBytes: BigInt(counters[2]), txBytes: BigInt(counters[5]) }
  }
  return null
}

async function readMacNetworkCounters({ signal } = {}) {
  const { stdout: route } = await execFileAsync('/sbin/route', ['-n', 'get', 'default'], {
    encoding: 'utf8', timeout: 1_500, maxBuffer: 16 * 1024, signal, windowsHide: true,
  })
  const interfaceName = parseMacDefaultInterface(route)
  if (!interfaceName) return null
  const { stdout: counters } = await execFileAsync('/usr/sbin/netstat', ['-ibn'], {
    encoding: 'utf8', timeout: 1_500, maxBuffer: 256 * 1024, signal, windowsHide: true,
  })
  return parseMacNetworkCounters(counters, interfaceName)
}

export function createSystemResourceMonitor({
  profilePath,
  platform = process.platform,
  readCpus = () => os.cpus(),
  readTotalMemory = () => os.totalmem(),
  readFreeMemory = () => os.freemem(),
  readDisk = path => statfs(path, { bigint: true }),
  readNetwork = readMacNetworkCounters,
  now = () => Date.now(),
  monotonicNow = () => performance.now(),
  minIntervalMs = SAMPLE_INTERVAL_MS,
  maxCounterGapMs = MAX_COUNTER_GAP_MS,
  diskTimeoutMs = DISK_TIMEOUT_MS,
} = {}) {
  if (typeof profilePath !== 'string' || !profilePath) throw new TypeError('profilePath is required')
  if (!Number.isSafeInteger(diskTimeoutMs) || diskTimeoutMs < 1 || diskTimeoutMs > 10_000) throw new TypeError('diskTimeoutMs must be between 1 and 10000')

  let previousCpu = null, previousNetwork = null
  let cached = null, cachedAt = -Infinity, inFlight = null, closed = false
  let pendingDiskReads = 0
  const abort = new AbortController()

  function sampleDisk() {
    // statfs has no cancellation API. Time out the response, but keep at most
    // two underlying reads: one stuck read cannot prevent the next recovery
    // attempt, while repeated stalls cannot grow without bound.
    if (pendingDiskReads >= MAX_PENDING_DISK_READS) return Promise.resolve(emptyDisk('unavailable'))
    pendingDiskReads++
    return new Promise(resolve => {
      let finished = false
      const finish = value => {
        if (finished) return // A result arriving after timeout never changes a sample.
        finished = true
        clearTimeout(timer)
        resolve(value)
      }
      const timer = setTimeout(() => finish(emptyDisk('unavailable')), diskTimeoutMs)
      Promise.resolve().then(() => closed ? null : readDisk(profilePath)).then(
        stats => { pendingDiskReads--; if (!finished) finish(stats === null ? emptyDisk('unavailable') : diskSnapshot(stats)) },
        () => { pendingDiskReads--; finish(emptyDisk('unavailable')) },
      )
    })
  }

  async function collect() {
    let cpu = emptyCpu('unavailable')
    try {
      const counters = cpuTotals(readCpus())
      const at = monotonicNow()
      if (counters) {
        if (previousCpu && previousCpu.cores === counters.cores) {
          const intervalMs = at - previousCpu.at
          const totalDelta = counters.total - previousCpu.total
          const idleDelta = counters.idle - previousCpu.idle
          const coresMonotonic = counters.perCore.every((core, index) =>
            core.every((value, field) => value >= previousCpu.perCore[index][field]))
          if (coresMonotonic && intervalMs >= MIN_COUNTER_INTERVAL_MS && intervalMs <= maxCounterGapMs && totalDelta > 0 && idleDelta >= 0 && idleDelta <= totalDelta) {
            cpu = { status: 'ok', percent: percent(totalDelta - idleDelta, totalDelta), basis: 'all-logical-cores', intervalMs: Math.round(intervalMs) }
          } else cpu = emptyCpu('warming')
        } else cpu = emptyCpu('warming')
        previousCpu = { ...counters, at }
      } else previousCpu = null
    } catch { previousCpu = null }

    let memory = emptyMemory('unavailable')
    try { memory = memorySnapshot(readTotalMemory(), readFreeMemory()) } catch {}

    const diskPromise = sampleDisk()
    const networkPromise = platform === 'darwin'
      ? Promise.resolve().then(() => closed ? null : readNetwork({ signal: abort.signal }))
        .then(counters => ({ counters, at: monotonicNow() })).catch(() => null)
      : Promise.resolve(null)
    const [disk, networkReading] = await Promise.all([diskPromise, networkPromise])

    let network = emptyNetwork(platform === 'darwin' ? 'unavailable' : 'unsupported')
    if (platform === 'darwin') {
      try {
        const counters = networkReading?.counters
        const at = networkReading?.at
        if (counters && typeof counters.interface === 'string' && typeof counters.rxBytes === 'bigint' && typeof counters.txBytes === 'bigint' && counters.rxBytes >= 0n && counters.txBytes >= 0n) {
          network = emptyNetwork('warming', counters.interface)
          if (previousNetwork && previousNetwork.interface === counters.interface) {
            const intervalMs = at - previousNetwork.at
            const rxDelta = counters.rxBytes - previousNetwork.rxBytes
            const txDelta = counters.txBytes - previousNetwork.txBytes
            if (intervalMs >= MIN_COUNTER_INTERVAL_MS && intervalMs <= maxCounterGapMs && rxDelta >= 0n && txDelta >= 0n && rxDelta <= MAX_SAFE_BIGINT && txDelta <= MAX_SAFE_BIGINT) {
              const seconds = intervalMs / 1_000
              const rxBytesPerSecond = Math.round(Number(rxDelta) / seconds)
              const txBytesPerSecond = Math.round(Number(txDelta) / seconds)
              if (Number.isSafeInteger(rxBytesPerSecond) && Number.isSafeInteger(txBytesPerSecond)) network = {
                status: 'ok', interface: counters.interface,
                rxBytesPerSecond, txBytesPerSecond,
                intervalMs: Math.round(intervalMs),
              }
            }
          }
          previousNetwork = { ...counters, at }
        } else previousNetwork = null
      } catch { previousNetwork = null }
    }

    return { version: 1, sampledAt: new Date(now()).toISOString(), host: 'local-computer', scope: 'host', cpu, memory, disk, network }
  }

  return {
    sample() {
      if (closed) return Promise.reject(new Error('System resource monitor is closed'))
      if (cached && monotonicNow() - cachedAt < minIntervalMs) return Promise.resolve(cached)
      if (inFlight) return inFlight
      inFlight = collect().then(value => {
        cached = value
        cachedAt = monotonicNow()
        return value
      }).finally(() => { inFlight = null })
      return inFlight
    },
    close() {
      closed = true
      abort.abort()
      cached = null
      previousCpu = null
      previousNetwork = null
    },
  }
}
