import { execFile } from 'node:child_process'
import { readFile, readdir, statfs } from 'node:fs/promises'
import os from 'node:os'
import { performance } from 'node:perf_hooks'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)
// Requests drive sampling; there is no background timer. This limit coalesces
// clients without making a one-second UI poll reuse the previous measurement.
const SAMPLE_INTERVAL_MS = 750
const STORAGE_INTERVAL_MS = 30_000
const MAX_COUNTER_GAP_MS = 30_000
const MIN_COUNTER_INTERVAL_MS = 250
const DISK_TIMEOUT_MS = 1_000
const COUNTER_TIMEOUT_MS = 900
const MAX_PENDING_DISK_READS = 2
const MAX_SAFE_BIGINT = BigInt(Number.MAX_SAFE_INTEGER)
const CPU_TIME_KEYS = ['user', 'nice', 'sys', 'idle', 'irq']

const percent = (part, whole) => Math.round(part / whole * 1_000) / 10
const emptyCpu = status => ({ status, percent: null, basis: 'all-logical-cores', intervalMs: null })
const emptyMemory = status => ({ status, usedBytes: null, totalBytes: null, percent: null, basis: 'total-minus-os-free' })
const emptyDisk = status => ({ status, usedBytes: null, totalBytes: null, percent: null, target: 'profile-volume', basis: 'volume-blocks-minus-free-blocks' })
const emptyDiskIo = status => ({ status, readBytesPerSecond: null, writeBytesPerSecond: null, intervalMs: null, basis: 'reported-whole-block-devices' })
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

// L38: the default route changes rarely, so route(8) runs at most every ROUTE_CACHE_MS and netstat reads only that interface (-I) instead of
// the whole table. A failed or empty -I read re-resolves the route once.
const ROUTE_CACHE_MS = 15_000
let macRouteCache = null
async function readMacNetworkCounters({ signal } = {}) {
  const netstat = args => execFileAsync('/usr/sbin/netstat', args, {
    encoding: 'utf8', timeout: COUNTER_TIMEOUT_MS, maxBuffer: 256 * 1024, signal, windowsHide: true,
  })
  const resolveRoute = async () => {
    const routeResult = await execFileAsync('/sbin/route', ['-n', 'get', 'default'], {
      encoding: 'utf8', timeout: COUNTER_TIMEOUT_MS, maxBuffer: 16 * 1024, signal, windowsHide: true,
    })
    const name = parseMacDefaultInterface(routeResult.stdout)
    macRouteCache = name ? { name, at: Date.now() } : null
    return name
  }
  if (macRouteCache && Date.now() - macRouteCache.at < ROUTE_CACHE_MS) {
    try {
      const counters = parseMacNetworkCounters((await netstat(['-ibn', '-I', macRouteCache.name])).stdout, macRouteCache.name)
      if (counters) return counters
    } catch (error) { if (signal?.aborted) throw error }
    macRouteCache = null
  }
  const interfaceName = await resolveRoute()
  if (!interfaceName) return null
  return parseMacNetworkCounters((await netstat(['-ibn'])).stdout, interfaceName)
}

// IOKit reports cumulative byte counts per block-storage driver. Registry IDs
// remain internal and let us reject a sample if devices appear or disappear.
export function parseMacDiskCounters(output) {
  if (typeof output !== 'string') return null
  const devices = []
  let id = null
  for (const line of output.split(/\r?\n/)) {
    const header = /^\s*\+-o .*<class IOBlockStorageDriver, id (0x[0-9a-f]+),/i.exec(line)
    if (header) {
      if (id) return null // A reported driver without byte counters is not zero.
      id = header[1]
      continue
    }
    if (!id || !/^\s*"Statistics"\s*=/.test(line)) continue
    const read = /"Bytes \(Read\)"=(\d+)/.exec(line)
    const write = /"Bytes \(Write\)"=(\d+)/.exec(line)
    if (!read || !write || devices.some(device => device.id === id)) return null
    devices.push({ id, readBytes: BigInt(read[1]), writeBytes: BigInt(write[1]) })
    id = null
  }
  return devices.length && !id ? devices : null
}

async function readMacDiskCounters({ signal } = {}) {
  const { stdout } = await execFileAsync('/usr/sbin/ioreg', ['-r', '-c', 'IOBlockStorageDriver', '-d', '1', '-w', '0'], {
    encoding: 'utf8', timeout: COUNTER_TIMEOUT_MS, maxBuffer: 512 * 1024, signal, windowsHide: true,
  })
  return parseMacDiskCounters(stdout)
}

export function parseLinuxDefaultInterface(output) {
  if (typeof output !== 'string') return null
  let best = null
  for (const line of output.split(/\r?\n/)) {
    const fields = line.trim().split(/\s+/)
    if (fields.length < 8 || !/^[a-zA-Z0-9_.-]+$/.test(fields[0]) || fields[1] !== '00000000' || fields[7] !== '00000000' || !/^[0-9a-f]+$/i.test(fields[3]) || !/^\d+$/.test(fields[6])) continue
    const flags = parseInt(fields[3], 16), metric = Number(fields[6])
    if ((flags & 1) && Number.isSafeInteger(metric) && (!best || metric < best.metric)) best = { interface: fields[0], metric }
  }
  return best?.interface ?? null
}

export function parseLinuxNetworkCounters(output, interfaceName) {
  if (typeof output !== 'string' || !/^[a-zA-Z0-9_.-]+$/.test(interfaceName || '')) return null
  for (const line of output.split(/\r?\n/)) {
    const separator = line.lastIndexOf(':')
    if (separator < 0 || line.slice(0, separator).trim() !== interfaceName) continue
    const fields = line.slice(separator + 1).trim().split(/\s+/)
    if (fields.length < 16 || !/^\d+$/.test(fields[0]) || !/^\d+$/.test(fields[8])) return null
    return { interface: interfaceName, rxBytes: BigInt(fields[0]), txBytes: BigInt(fields[8]) }
  }
  return null
}

async function readLinuxNetworkCounters({ signal } = {}) {
  const [route, counters] = await Promise.all([
    readFile('/proc/net/route', { encoding: 'utf8', signal }),
    readFile('/proc/net/dev', { encoding: 'utf8', signal }),
  ])
  return parseLinuxNetworkCounters(counters, parseLinuxDefaultInterface(route))
}

// Include whole disks only, excluding partitions, loop devices and stacked
// dm/md devices so their backing disks are not counted twice. Linux reports
// sectors in fixed 512-byte units, irrespective of device block size.
export function parseLinuxDiskCounters(output, blockNames) {
  if (typeof output !== 'string' || !Array.isArray(blockNames)) return null
  const allowed = new Set(blockNames.filter(name => /^(?:sd[a-z]+|vd[a-z]+|xvd[a-z]+|hd[a-z]+|dasd[a-z]+|nvme\d+n\d+|mmcblk\d+)$/.test(name)))
  if (!allowed.size) return null
  const devices = []
  for (const line of output.split(/\r?\n/)) {
    const fields = line.trim().split(/\s+/)
    if (!allowed.has(fields[2])) continue
    if (fields.length < 10 || !/^\d+$/.test(fields[5]) || !/^\d+$/.test(fields[9]) || devices.some(device => device.id === fields[2])) return null
    devices.push({ id: fields[2], readBytes: BigInt(fields[5]) * 512n, writeBytes: BigInt(fields[9]) * 512n })
  }
  return devices.length === allowed.size ? devices : null
}

async function readLinuxDiskCounters({ signal } = {}) {
  const [stats, names] = await Promise.all([
    readFile('/proc/diskstats', { encoding: 'utf8', signal }),
    readdir('/sys/block'),
  ])
  return parseLinuxDiskCounters(stats, names)
}

// Windows (CNV-08). One PowerShell call per counter kind; byte counts are
// emitted as strings so 64-bit totals keep full precision through JSON, and
// ConvertTo-Json output does not depend on the display language (unlike
// `netstat -e`). Real Windows measurement has not been run yet; any failure
// or timeout falls back to 'unavailable' like the other platforms.
// PowerShell starts slower than route/netstat, so Windows reads get longer.
const WINDOWS_COUNTER_TIMEOUT_MS = 3_000
export const WINDOWS_NETWORK_SCRIPT = [
  "$r = @(Get-NetRoute -DestinationPrefix '0.0.0.0/0' -ErrorAction SilentlyContinue | Select-Object InterfaceAlias, @{n='Metric';e={[string]($_.RouteMetric + $_.InterfaceMetric)}})",
  "$s = @(Get-NetAdapterStatistics -ErrorAction SilentlyContinue | Select-Object Name, @{n='ReceivedBytes';e={[string]$_.ReceivedBytes}}, @{n='SentBytes';e={[string]$_.SentBytes}})",
  '@{ routes = $r; stats = $s } | ConvertTo-Json -Compress -Depth 3',
].join('; ')
export const WINDOWS_DISK_SCRIPT = [
  "@(Get-CimInstance Win32_PerfRawData_PerfDisk_PhysicalDisk -ErrorAction Stop | Where-Object { $_.Name -ne '_Total' } |",
  "Select-Object Name, @{n='ReadBytes';e={[string]$_.DiskReadBytesPersec}}, @{n='WriteBytes';e={[string]$_.DiskWriteBytesPersec}}) | ConvertTo-Json -Compress",
].join(' ')

const asList = value => value == null ? [] : Array.isArray(value) ? value : [value]
const parseJson = text => { try { return JSON.parse(text) } catch { return undefined } }
const countText = value => typeof value === 'string' && /^\d{1,20}$/.test(value) ? BigInt(value) : null

// The lowest route+interface metric wins, like the route the system would use.
export function parseWindowsNetworkCounters(output) {
  if (typeof output !== 'string') return null
  const data = parseJson(output.trim())
  if (!data || typeof data !== 'object') return null
  let best = null
  for (const route of asList(data.routes)) {
    const alias = route?.InterfaceAlias, metric = Number(route?.Metric)
    if (typeof alias !== 'string' || !alias || !Number.isSafeInteger(metric) || metric < 0) continue
    if (!best || metric < best.metric) best = { alias, metric }
  }
  if (!best) return null
  const row = asList(data.stats).find(item => item?.Name === best.alias)
  const rxBytes = countText(row?.ReceivedBytes), txBytes = countText(row?.SentBytes)
  return rxBytes === null || txBytes === null ? null : { interface: best.alias, rxBytes, txBytes }
}

// Raw PhysicalDisk counters are cumulative byte totals per disk ("0 C:").
// _Total is excluded so no disk is counted twice; one unreadable row fails all.
export function parseWindowsDiskCounters(output) {
  if (typeof output !== 'string') return null
  const rows = asList(parseJson(output.trim()))
  const devices = []
  for (const row of rows) {
    const id = row?.Name
    if (typeof id !== 'string' || !id || id === '_Total') return null
    const readBytes = countText(row.ReadBytes), writeBytes = countText(row.WriteBytes)
    if (readBytes === null || writeBytes === null || devices.some(device => device.id === id)) return null
    devices.push({ id, readBytes, writeBytes })
  }
  return devices.length ? devices : null
}

async function runWindowsScript(script, signal) {
  const { stdout } = await execFileAsync('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script], {
    encoding: 'utf8', timeout: WINDOWS_COUNTER_TIMEOUT_MS, maxBuffer: 256 * 1024, signal, windowsHide: true,
  })
  return stdout
}
const readWindowsNetworkCounters = async ({ signal } = {}) => parseWindowsNetworkCounters(await runWindowsScript(WINDOWS_NETWORK_SCRIPT, signal))
const readWindowsDiskCounters = async ({ signal } = {}) => parseWindowsDiskCounters(await runWindowsScript(WINDOWS_DISK_SCRIPT, signal))

const DEFAULT_NETWORK_READERS = { darwin: readMacNetworkCounters, linux: readLinuxNetworkCounters, win32: readWindowsNetworkCounters }
const DEFAULT_DISK_IO_READERS = { darwin: readMacDiskCounters, linux: readLinuxDiskCounters, win32: readWindowsDiskCounters }

// Scope (CNV-08, inferred default 2026-11-17): every figure is for the whole
// PC ('host', shown as 전체 자원). There is no EG-Desk-only section yet; app
// values (Firefox and helper processes) wait for the owner's scope decision.

export function createSystemResourceMonitor({
  profilePath,
  platform = process.platform,
  readCpus = () => os.cpus(),
  readTotalMemory = () => os.totalmem(),
  readFreeMemory = () => os.freemem(),
  readDisk = path => statfs(path, { bigint: true }),
  readNetwork = DEFAULT_NETWORK_READERS[platform] ?? readLinuxNetworkCounters,
  readDiskIo = DEFAULT_DISK_IO_READERS[platform] ?? readLinuxDiskCounters,
  now = () => Date.now(),
  monotonicNow = () => performance.now(),
  minIntervalMs = SAMPLE_INTERVAL_MS,
  maxCounterGapMs = MAX_COUNTER_GAP_MS,
  diskTimeoutMs = DISK_TIMEOUT_MS,
} = {}) {
  if (typeof profilePath !== 'string' || !profilePath) throw new TypeError('profilePath is required')
  if (!Number.isSafeInteger(diskTimeoutMs) || diskTimeoutMs < 1 || diskTimeoutMs > 10_000) throw new TypeError('diskTimeoutMs must be between 1 and 10000')

  let previousCpu = null, previousNetwork = null, previousDiskIo = null
  let cpuReading = null
  let cached = null, cachedAt = -Infinity, inFlight = null, closed = false
  let cachedDisk = null, cachedDiskAt = -Infinity
  let pendingDiskReads = 0
  const abort = new AbortController()
  const countersSupported = platform === 'darwin' || platform === 'linux' || platform === 'win32'
  const counterTimeoutMs = platform === 'win32' ? WINDOWS_COUNTER_TIMEOUT_MS : COUNTER_TIMEOUT_MS

  // A timed-out or non-cooperative reader cannot accumulate concurrent work.
  // The timestamp belongs to the counter read, not a slower storage statfs.
  function boundedCounterReader(reader) {
    let pending = false
    return () => {
      if (closed || pending) return Promise.resolve(null)
      pending = true
      const controller = new AbortController()
      const onClose = () => controller.abort()
      abort.signal.addEventListener('abort', onClose, { once: true })
      return new Promise(resolve => {
        let finished = false
        const finish = value => {
          if (finished) return
          finished = true
          clearTimeout(timer)
          resolve(value)
        }
        const timer = setTimeout(() => { controller.abort(); finish(null) }, counterTimeoutMs)
        Promise.resolve().then(() => closed ? null : reader({ signal: controller.signal })).then(
          counters => {
            pending = false
            abort.signal.removeEventListener('abort', onClose)
            finish(counters === null ? null : { counters, at: monotonicNow() })
          },
          () => { pending = false; abort.signal.removeEventListener('abort', onClose); finish(null) },
        )
      })
    }
  }
  const sampleNetwork = boundedCounterReader(readNetwork)
  const sampleDiskIo = boundedCounterReader(readDiskIo)

  function sampleDisk() {
    if (cachedDisk && monotonicNow() - cachedDiskAt < STORAGE_INTERVAL_MS) return Promise.resolve(cachedDisk)
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
        if (value.status === 'ok') value = { ...value, sampledAt: new Date(now()).toISOString() }
        if (value.status === 'ok' && !closed) { cachedDisk = value; cachedDiskAt = monotonicNow() }
        resolve(value)
      }
      const timer = setTimeout(() => finish(emptyDisk('unavailable')), diskTimeoutMs)
      Promise.resolve().then(() => closed ? null : readDisk(profilePath)).then(
        stats => { pendingDiskReads--; if (!finished) finish(stats === null ? emptyDisk('unavailable') : diskSnapshot(stats)) },
        () => { pendingDiskReads--; finish(emptyDisk('unavailable')) },
      )
    })
  }

  // CPU-only in-process consumer: same counters/windows and cache as the
  // diagnostics sample, without polling disk, network or memory.
  function sampleCpu() {
    if (closed) return null
    const at = monotonicNow()
    if (cpuReading && at >= cpuReading.at && at - cpuReading.at < minIntervalMs) return cpuReading
    let cpu = emptyCpu('unavailable')
    try {
      const counters = cpuTotals(readCpus())
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

    cpuReading = Object.freeze({ host: 'local-computer', scope: 'host', at, cpu: Object.freeze(cpu) })
    return cpuReading
  }

  async function collect() {
    const { cpu } = sampleCpu()
    let memory = emptyMemory('unavailable')
    try { memory = memorySnapshot(readTotalMemory(), readFreeMemory()) } catch {}

    const diskPromise = sampleDisk()
    const networkPromise = countersSupported ? sampleNetwork() : Promise.resolve(null)
    const diskIoPromise = countersSupported ? sampleDiskIo() : Promise.resolve(null)
    const [disk, networkReading, diskIoReading] = await Promise.all([diskPromise, networkPromise, diskIoPromise])

    let network = emptyNetwork(countersSupported ? 'unavailable' : 'unsupported')
    if (countersSupported) {
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

    let diskIo = emptyDiskIo(countersSupported ? 'unavailable' : 'unsupported')
    if (countersSupported) {
      try {
        const devices = diskIoReading?.counters
        const at = diskIoReading?.at
        if (Array.isArray(devices) && devices.length && Number.isFinite(at)) {
          const current = new Map()
          for (const device of devices) {
            if (typeof device.id !== 'string' || !device.id || current.has(device.id) ||
                typeof device.readBytes !== 'bigint' || typeof device.writeBytes !== 'bigint' ||
                device.readBytes < 0n || device.writeBytes < 0n) throw new Error('invalid counters')
            current.set(device.id, device)
          }
          diskIo = emptyDiskIo('warming')
          if (previousDiskIo && previousDiskIo.devices.size === current.size &&
              [...current.keys()].every(id => previousDiskIo.devices.has(id))) {
            const intervalMs = at - previousDiskIo.at
            let readDelta = 0n, writeDelta = 0n, valid = true
            for (const [id, device] of current) {
              const previous = previousDiskIo.devices.get(id)
              const read = device.readBytes - previous.readBytes
              const write = device.writeBytes - previous.writeBytes
              if (read < 0n || write < 0n) valid = false
              readDelta += read; writeDelta += write
            }
            if (valid && intervalMs >= MIN_COUNTER_INTERVAL_MS && intervalMs <= maxCounterGapMs &&
                readDelta <= MAX_SAFE_BIGINT && writeDelta <= MAX_SAFE_BIGINT) {
              const readBytesPerSecond = Math.round(Number(readDelta) * 1_000 / intervalMs)
              const writeBytesPerSecond = Math.round(Number(writeDelta) * 1_000 / intervalMs)
              if (Number.isSafeInteger(readBytesPerSecond) && Number.isSafeInteger(writeBytesPerSecond)) diskIo = {
                status: 'ok', readBytesPerSecond, writeBytesPerSecond,
                intervalMs: Math.round(intervalMs), basis: 'reported-whole-block-devices',
              }
            }
          }
          previousDiskIo = { devices: current, at }
        } else previousDiskIo = null
      } catch { previousDiskIo = null }
    }

    return { version: 1, sampledAt: new Date(now()).toISOString(), host: 'local-computer', scope: 'host', cpu, memory, disk, diskIo, network }
  }

  return {
    sampleCpu,
    sample() {
      if (closed) return Promise.reject(new Error('System resource monitor is closed'))
      if (cached && monotonicNow() - cachedAt < minIntervalMs) return Promise.resolve(cached)
      if (inFlight) return inFlight
      inFlight = collect().then(value => {
        if (!closed) { cached = value; cachedAt = monotonicNow() }
        return value
      }).finally(() => { inFlight = null })
      return inFlight
    },
    close() {
      closed = true
      abort.abort()
      cached = null
      cachedDisk = null
      cpuReading = null
      previousCpu = null
      previousNetwork = null
      previousDiskIo = null
    },
  }
}
