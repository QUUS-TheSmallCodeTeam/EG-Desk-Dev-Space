import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { runInNewContext } from 'node:vm'
import { createSystemResourceMonitor, parseMacDefaultInterface, parseMacNetworkCounters,
  parseMacDiskCounters, parseLinuxDefaultInterface, parseLinuxNetworkCounters, parseLinuxDiskCounters } from './system-resource-monitor.mjs'

test('macOS parsers select only the default interface link counters, not repeated protocol rows', () => {
  assert.equal(parseMacDefaultInterface('route to: default\n  interface: en0\n flags: <UP>\n'), 'en0')
  assert.equal(parseMacDefaultInterface('route to: default\n flags: <UP>\n'), null)
  const netstat = [
    'Name Mtu Network Address Ipkts Ierrs Ibytes Opkts Oerrs Obytes Coll',
    'lo0 16384 <Link#1> 1 0 999 1 0 999 0',
    'en0 1500 <Link#2> 10 0 1000 20 0 2000 0',
    'en0 1500 192.0.2 192.0.2.1 10 - 1000 20 - 2000 -',
  ].join('\n')
  assert.deepEqual(parseMacNetworkCounters(netstat, 'en0'), { interface: 'en0', rxBytes: 1000n, txBytes: 2000n })
  assert.equal(parseMacNetworkCounters(netstat, 'en9'), null)
  assert.equal(parseMacNetworkCounters('en0 1500 <Link#2> 10 0 bad 20 0 2000 0', 'en0'), null)
})

test('macOS disk parser uses every reported driver and rejects missing counters', () => {
  const header = id => `+-o IOBlockStorageDriver <class IOBlockStorageDriver, id ${id}, registered>`
  const stats = (read, write) => `  "Statistics" = {"Bytes (Read)"=${read},"Bytes (Write)"=${write}}`
  const output = [header('0x1'), stats('100', '200'), header('0x2'), stats('300', '400')].join('\n')
  assert.deepEqual(parseMacDiskCounters(output), [
    { id: '0x1', readBytes: 100n, writeBytes: 200n }, { id: '0x2', readBytes: 300n, writeBytes: 400n },
  ])
  assert.equal(parseMacDiskCounters([header('0x1'), stats('1', '2'), header('0x2')].join('\n')), null)
  assert.equal(parseMacDiskCounters([header('0x1'), '  "Statistics" = {"Bytes (Read)"=1}'].join('\n')), null)
})

test('Linux parsers choose the lowest-metric default route and whole non-stacked disks', () => {
  const route = ['Iface Destination Gateway Flags RefCnt Use Metric Mask',
    'eth0 00000000 00000000 0001 0 0 100 00000000',
    'wlan0 00000000 00000000 0001 0 0 20 00000000',
    'down0 00000000 00000000 0000 0 0 1 00000000'].join('\n')
  assert.equal(parseLinuxDefaultInterface(route), 'wlan0')
  assert.deepEqual(parseLinuxNetworkCounters('wlan0: 100 0 0 0 0 0 0 0 200 0 0 0 0 0 0 0', 'wlan0'),
    { interface: 'wlan0', rxBytes: 100n, txBytes: 200n })
  assert.equal(parseLinuxNetworkCounters('wlan0: bad', 'wlan0'), null)
  const diskstats = ['8 0 sda 1 0 2 0 3 0 4 0', '8 1 sda1 1 0 200 0 3 0 400 0',
    '253 0 dm-0 1 0 200 0 3 0 400 0', '7 0 loop0 1 0 200 0 3 0 400 0'].join('\n')
  assert.deepEqual(parseLinuxDiskCounters(diskstats, ['sda', 'dm-0', 'loop0']),
    [{ id: 'sda', readBytes: 1024n, writeBytes: 2048n }])
  assert.equal(parseLinuxDiskCounters(diskstats, ['sda', 'sdb']), null)
  assert.equal(parseLinuxDiskCounters(diskstats, ['dm-0', 'loop0']), null)
})

test('disk I/O rejects per-device resets, topology changes, gaps and failed reads', async () => {
  let tick = 0
  let devices = [{ id: 'a', readBytes: 100n, writeBytes: 100n }, { id: 'b', readBytes: 200n, writeBytes: 200n }]
  const monitor = createSystemResourceMonitor({
    profilePath: '/not-opened-in-test', platform: 'linux', minIntervalMs: 0,
    monotonicNow: () => tick, readCpus: () => [], readTotalMemory: () => 100, readFreeMemory: () => 50,
    readDisk: async () => ({ bsize: 1n, blocks: 100n, bfree: 50n }),
    readNetwork: async () => null, readDiskIo: async () => devices,
  })
  assert.equal((await monitor.sample()).diskIo.status, 'warming')
  tick = 1_000
  devices = [{ id: 'a', readBytes: 400n, writeBytes: 200n }, { id: 'b', readBytes: 900n, writeBytes: 400n }]
  const measured = await monitor.sample()
  assert.deepEqual([measured.diskIo.readBytesPerSecond, measured.diskIo.writeBytesPerSecond], [1_000, 300])
  // A device reset cannot be hidden by a larger increase on another device.
  tick = 2_000
  devices = [{ id: 'a', readBytes: 10n, writeBytes: 10n }, { id: 'b', readBytes: 2_000n, writeBytes: 2_000n }]
  assert.equal((await monitor.sample()).diskIo.status, 'warming')
  tick = 3_000
  const idle = await monitor.sample()
  assert.deepEqual([idle.diskIo.status, idle.diskIo.readBytesPerSecond, idle.diskIo.writeBytesPerSecond], ['ok', 0, 0])
  tick = 4_000; devices = [...devices, { id: 'c', readBytes: 1n, writeBytes: 1n }]
  assert.equal((await monitor.sample()).diskIo.status, 'warming')
  tick = 5_000; const restored = devices; devices = null
  assert.equal((await monitor.sample()).diskIo.status, 'unavailable')
  tick = 6_000; devices = restored
  assert.equal((await monitor.sample()).diskIo.status, 'warming')
  tick = 40_000
  assert.equal((await monitor.sample()).diskIo.status, 'warming')
  monitor.close()
})

test('stuck counter readers time out and cannot accumulate parallel work', { timeout: 3_000 }, async () => {
  let networkReads = 0, diskIoReads = 0, aborted = 0, tick = 0
  const never = new Promise(() => {})
  const stuck = kind => ({ signal }) => {
    if (kind === 'network') networkReads++; else diskIoReads++
    signal.addEventListener('abort', () => aborted++)
    return never
  }
  const monitor = createSystemResourceMonitor({
    profilePath: '/not-opened-in-test', platform: 'linux', minIntervalMs: 0,
    monotonicNow: () => tick, readCpus: () => [], readTotalMemory: () => 100, readFreeMemory: () => 50,
    readDisk: async () => ({ bsize: 1n, blocks: 100n, bfree: 50n }),
    readNetwork: stuck('network'), readDiskIo: stuck('disk'),
  })
  const first = await monitor.sample()
  assert.deepEqual([first.network.status, first.diskIo.status, aborted], ['unavailable', 'unavailable', 2])
  tick = 1_000
  const second = await monitor.sample()
  assert.deepEqual([second.network.status, second.diskIo.status, networkReads, diskIoReads], ['unavailable', 'unavailable', 1, 1])
  monitor.close()
})

test('gadget renders measured read/write rates and retains storage detail when I/O is unavailable', async () => {
  const source = await readFile(new URL('../overlay/JS/eg-desk-surface.uc.js', import.meta.url), 'utf8')
  const start = source.indexOf('  // Four compact host-resource readouts')
  const end = source.indexOf('  // ============ Top: Viewport Agenda Rail', start)
  assert.ok(start >= 0 && end > start)
  class Element {
    constructor(tag, attrs = {}, ...children) {
      this.tag = tag; this.attrs = { ...attrs }; this.children = children.filter(Boolean); this.textContent = ''
      this.hidden = Boolean(attrs.hidden); this.onclick = attrs.onclick
      this.toggles = {}; this.classList = { toggle: (name, value) => { this.toggles[name] = value } }
      this.style = { setProperty() {} }
    }
    appendChild(child) { this.children.push(child) }
    replaceChildren(...children) { this.children = children }
    setAttribute(name, value) { this.attrs[name] = value }
    querySelector(selector) { return selector === '.egd-resource-ring' ? this.children[0] : null }
    contains() { return false }
    focus() {}
  }
  let clock = 0, nextTimer = 0, calls = 0, waitForAbort = false
  const timers = new Map()
  const listeners = new Map()
  const window = {
    setTimeout: (fn, delay) => { const id = ++nextTimer; timers.set(id, { fn, delay }); return id },
    clearTimeout: id => timers.delete(id), addEventListener() {}, removeEventListener() {},
  }
  const document = { hidden: false,
    addEventListener: (name, listener) => listeners.set(name, listener),
    removeEventListener: name => listeners.delete(name),
  }
  const payload = {
    version: 1, scope: 'host', sampledAt: new Date().toISOString(),
    cpu: { status: 'ok', percent: 25 }, memory: { status: 'ok', percent: 60 },
    disk: { status: 'ok', usedBytes: 1024, totalBytes: 2048, percent: 50, target: 'profile-volume', sampledAt: new Date().toISOString() },
    diskIo: { status: 'ok', readBytesPerSecond: 1024, writeBytesPerSecond: 2048, intervalMs: 1000 },
    network: { status: 'ok', rxBytesPerSecond: 3072, txBytesPerSecond: 4096 },
  }
  const context = { document, window, performance: { now: () => clock }, AbortController,
    el: (tag, attrs, ...children) => new Element(tag, attrs, ...children),
    fetch: async (_url, { signal }) => {
      calls++
      if (waitForAbort) await new Promise((resolve, reject) => {
        signal.addEventListener('abort', () => reject(new Error('paused')))
      })
      return { ok: true, json: async () => payload }
    },
  }
  runInNewContext(`${source.slice(start, end)}\nglobalThis.makeGadget = buildResourceGadget`, context)
  const gadget = context.makeGadget()
  await new Promise(resolve => setImmediate(resolve))
  const [cpu, , disk, network, detail] = gadget.children
  assert.equal(cpu.children[1].children[0].textContent, 'CPU 25%')
  assert.equal(disk.children[1].children[0].textContent, 'R 1K/s')
  assert.equal(disk.children[1].children[1].textContent, 'W 2K/s')
  assert.equal(disk.children[0].toggles['egd-resource-unmeasured'], true) // No made-up disk utilization arc.
  assert.match(disk.attrs['aria-label'], /읽기 1 KiB\/s, 쓰기 2 KiB\/s/)
  assert.equal(network.children[1].children[0].textContent, '↓ 3K/s')
  assert.deepEqual([...timers.values()].map(timer => timer.delay), [1000])
  disk.onclick({ stopPropagation() {} })
  const textOf = node => [node.textContent, ...node.children.flatMap(child => typeof child === 'string' ? [child] : textOf(child))]
  assert.ok(textOf(detail).includes('1 KiB / 2 KiB'))
  payload.diskIo = { status: 'unsupported', readBytesPerSecond: null, writeBytesPerSecond: null }
  payload.network = { status: 'unsupported', rxBytesPerSecond: null, txBytesPerSecond: null }
  clock = 1000
  const [timerId, timer] = [...timers.entries()][0]; timers.delete(timerId); timer.fn()
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(calls, 2)
  assert.equal(disk.children[1].children[0].textContent, 'R —')
  assert.match(disk.attrs['aria-label'], /이 환경에서는 지원하지 않음/)
  assert.match(network.attrs['aria-label'], /이 환경에서는 지원하지 않음/)
  assert.ok(textOf(detail).includes('이 환경에서는 지원하지 않음'))
  assert.ok(textOf(detail).includes('1 KiB / 2 KiB'))
  payload.diskIo.status = 'unavailable'; payload.network.status = 'unavailable'; clock = 2000
  const [nextId, next] = [...timers.entries()][0]; timers.delete(nextId); next.fn()
  await new Promise(resolve => setImmediate(resolve))
  assert.match(disk.attrs['aria-label'], /측정할 수 없음/)
  assert.match(network.attrs['aria-label'], /측정할 수 없음/)
  assert.ok(textOf(detail).includes('측정할 수 없음'))
  waitForAbort = true; clock = 3000
  const [pendingId, pendingTimer] = [...timers.entries()][0]; timers.delete(pendingId); pendingTimer.fn()
  await new Promise(resolve => setImmediate(resolve))
  document.hidden = true; listeners.get('visibilitychange')()
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(cpu.children[1].children[0].textContent, 'CPU 25%')
  assert.equal(timers.size, 0) // No hidden polling and no false failure on abort.
  document.hidden = false; waitForAbort = false; payload.diskIo.status = 'ok'
  payload.diskIo.readBytesPerSecond = 512; payload.diskIo.writeBytesPerSecond = 1024
  listeners.get('visibilitychange')()
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(calls, 5)
  assert.equal(disk.children[1].children[0].textContent, 'R 512B/s')
})

test('one-second samples re-read CPU, network and disk I/O, while storage capacity is cached', async () => {
  let tick = 0, cpuBusy = 100, cpuIdle = 100, rx = 1_000n, tx = 2_000n, read = 5_000n, write = 6_000n
  let cpuReads = 0, networkReads = 0, diskIoReads = 0, storageReads = 0
  const monitor = createSystemResourceMonitor({
    profilePath: '/not-opened-in-test', platform: 'darwin',
    monotonicNow: () => tick, now: () => Date.UTC(2026, 9, 20, 0, 0, 0),
    readCpus: () => { cpuReads++; return [{ times: { user: cpuBusy, nice: 0, sys: 0, idle: cpuIdle, irq: 0 } }] },
    readTotalMemory: () => 1_000, readFreeMemory: () => 250,
    readDisk: async () => { storageReads++; return { bsize: 1n, blocks: 2_000n, bfree: 500n } },
    readNetwork: async () => { networkReads++; return { interface: 'en0', rxBytes: rx, txBytes: tx } },
    readDiskIo: async () => { diskIoReads++; return [{ id: 'disk1', readBytes: read, writeBytes: write }] },
  })

  const first = await monitor.sample()
  assert.equal(first.version, 1)
  assert.equal(first.sampledAt, '2026-10-20T00:00:00.000Z')
  assert.equal(first.host, 'local-computer')
  assert.equal(first.scope, 'host')
  assert.deepEqual([first.cpu.status, first.cpu.percent, first.network.status, first.network.rxBytesPerSecond, first.diskIo.status], ['warming', null, 'warming', null, 'warming'])
  assert.deepEqual([first.memory.usedBytes, first.memory.totalBytes, first.memory.percent], [750, 1_000, 75])
  assert.deepEqual([first.disk.usedBytes, first.disk.totalBytes, first.disk.percent, first.disk.target], [1_500, 2_000, 75, 'profile-volume'])
  assert.equal(await monitor.sample(), first)
  tick = 749
  assert.equal(await monitor.sample(), first)
  assert.deepEqual([cpuReads, networkReads, diskIoReads, storageReads], [1, 1, 1, 1])

  tick = 1_000; cpuBusy += 75; cpuIdle += 25; rx += 1_000n; tx += 500n; read += 3_000n; write += 4_000n
  const second = await monitor.sample()
  assert.deepEqual([second.cpu.status, second.cpu.percent, second.cpu.intervalMs], ['ok', 75, 1_000])
  assert.deepEqual([second.network.status, second.network.interface, second.network.rxBytesPerSecond, second.network.txBytesPerSecond, second.network.intervalMs], ['ok', 'en0', 1_000, 500, 1_000])
  assert.deepEqual([second.diskIo.status, second.diskIo.readBytesPerSecond, second.diskIo.writeBytesPerSecond, second.diskIo.intervalMs], ['ok', 3_000, 4_000, 1_000])
  assert.deepEqual([cpuReads, networkReads, diskIoReads, storageReads], [2, 2, 2, 1])
  assert.equal(Object.hasOwn(second.network, 'percent'), false)
  monitor.close()
  await assert.rejects(monitor.sample(), /closed/)
})

test('interface switch, counter reset and sleep gap never produce false or negative rates', async () => {
  let tick = 0, iface = 'en0', rx = 1_000n, tx = 2_000n, user = 100, idle = 100
  const monitor = createSystemResourceMonitor({
    profilePath: '/not-opened-in-test', platform: 'darwin', minIntervalMs: 0,
    monotonicNow: () => tick,
    readCpus: () => [{ times: { user, nice: 0, sys: 0, idle, irq: 0 } }],
    readTotalMemory: () => 100, readFreeMemory: () => 50,
    readDisk: async () => ({ bsize: 1n, blocks: 100n, bfree: 50n }),
    readNetwork: async () => ({ interface: iface, rxBytes: rx, txBytes: tx }),
    readDiskIo: async () => null,
  })
  await monitor.sample()
  tick = 5_000; iface = 'utun0'; rx = 10n; tx = 20n; user += 50; idle += 50
  assert.deepEqual([ (await monitor.sample()).network.status ], ['warming'])
  tick = 10_000; rx = 1n; tx = 2n; user += 50; idle += 50
  const reset = await monitor.sample()
  assert.deepEqual([reset.network.status, reset.network.rxBytesPerSecond, reset.network.txBytesPerSecond], ['warming', null, null])
  tick = 50_000; rx += 100n; tx += 200n; user += 50; idle += 50
  const wake = await monitor.sample()
  assert.deepEqual([wake.cpu.status, wake.cpu.percent, wake.network.status, wake.network.rxBytesPerSecond], ['warming', null, 'warming', null])
  monitor.close()
})

test('a disappeared interface warms again when the same name returns', async () => {
  let tick = 0, counters = { interface: 'en0', rxBytes: 1_000n, txBytes: 2_000n }
  const monitor = createSystemResourceMonitor({
    profilePath: '/not-opened-in-test', platform: 'darwin', minIntervalMs: 0,
    monotonicNow: () => tick,
    readCpus: () => [], readTotalMemory: () => 100, readFreeMemory: () => 50,
    readDisk: async () => ({ bsize: 1n, blocks: 100n, bfree: 50n }),
    readNetwork: async () => counters,
    readDiskIo: async () => null,
  })
  assert.equal((await monitor.sample()).network.status, 'warming')
  tick = 5_000; counters = null
  assert.equal((await monitor.sample()).network.status, 'unavailable')
  tick = 10_000; counters = { interface: 'en0', rxBytes: 6_000n, txBytes: 7_000n }
  const returned = await monitor.sample()
  assert.deepEqual([returned.network.status, returned.network.rxBytesPerSecond, returned.network.txBytesPerSecond], ['warming', null, null])
  tick = 15_000; counters = { interface: 'en0', rxBytes: 7_000n, txBytes: 9_000n }
  const measured = await monitor.sample()
  assert.deepEqual([measured.network.status, measured.network.rxBytesPerSecond, measured.network.txBytesPerSecond], ['ok', 200, 400])
  monitor.close()
})

for (const resetField of ['user', 'nice', 'sys', 'idle', 'irq']) {
  test(`a reset of one core's ${resetField} counter cannot masquerade as valid aggregate CPU activity`, async () => {
    let tick = 0
    const initial = { user: 100, nice: 100, sys: 100, idle: 100, irq: 100 }
    let coreTimes = [{ ...initial }, { ...initial }]
    const monitor = createSystemResourceMonitor({
      profilePath: '/not-opened-in-test', platform: 'win32', minIntervalMs: 0,
      monotonicNow: () => tick,
      readCpus: () => coreTimes.map(times => ({ times })),
      readTotalMemory: () => 100, readFreeMemory: () => 50,
      readDisk: async () => ({ bsize: 1n, blocks: 100n, bfree: 50n }),
    })
    assert.equal((await monitor.sample()).cpu.status, 'warming')
    tick = 5_000
    coreTimes = [
      { ...initial, [resetField]: 10 },
      { ...initial, user: 300, idle: resetField === 'idle' ? 300 : 130 },
    ]
    const reset = await monitor.sample()
    assert.deepEqual([reset.cpu.status, reset.cpu.percent], ['warming', null])
    tick = 10_000
    coreTimes = coreTimes.map(times => Object.fromEntries(
      Object.entries(times).map(([field, value]) => [field, value + 10])))
    const recovered = await monitor.sample()
    assert.deepEqual([recovered.cpu.status, recovered.cpu.percent], ['ok', 80])
    monitor.close()
  })
}

test('a slow disk read cannot dilute network rates measured before it completes', async () => {
  let tick = 0, diskReads = 0, rx = 1_000n, tx = 2_000n, resolveSecondDisk, networkReadStarted
  const stats = { bsize: 1n, blocks: 100n, bfree: 50n }
  const secondDisk = new Promise(resolve => { resolveSecondDisk = resolve })
  const networkStarted = new Promise(resolve => { networkReadStarted = resolve })
  const monitor = createSystemResourceMonitor({
    profilePath: '/not-opened-in-test', platform: 'darwin', minIntervalMs: 0,
    monotonicNow: () => tick,
    readCpus: () => [], readTotalMemory: () => 100, readFreeMemory: () => 50,
    readDisk: () => ++diskReads === 2 ? secondDisk : Promise.resolve(stats),
    readNetwork: async () => {
      if (diskReads === 2) networkReadStarted()
      return { interface: 'en0', rxBytes: rx, txBytes: tx }
    },
    readDiskIo: async () => null,
  })
  assert.equal((await monitor.sample()).network.status, 'warming')
  tick = 30_000; rx += 30_000n; tx += 6_000n
  const pending = monitor.sample()
  await networkStarted
  await new Promise(resolve => setImmediate(resolve))
  tick = 34_000
  resolveSecondDisk(stats)
  const measured = await pending
  assert.deepEqual([measured.network.status, measured.network.intervalMs, measured.network.rxBytesPerSecond, measured.network.txBytesPerSecond], ['ok', 30_000, 1_000, 200])
  monitor.close()
})

test('closing before queued work starts does not initiate disk or network reads', async () => {
  let diskReads = 0, networkReads = 0
  const monitor = createSystemResourceMonitor({
    profilePath: '/not-opened-in-test', platform: 'darwin',
    readCpus: () => [], readTotalMemory: () => 100, readFreeMemory: () => 50,
    readDisk: async () => { diskReads++; return { bsize: 1n, blocks: 100n, bfree: 50n } },
    readNetwork: async () => { networkReads++; return { interface: 'en0', rxBytes: 1n, txBytes: 1n } },
    readDiskIo: async () => null,
  })
  const pending = monitor.sample()
  monitor.close()
  const stopped = await pending
  assert.equal(diskReads, 0)
  assert.equal(networkReads, 0)
  assert.equal(stopped.disk.status, 'unavailable')
  assert.equal(stopped.network.status, 'unavailable')
  await assert.rejects(monitor.sample(), /closed/)
})

test('closing after reads begin aborts the network signal without starting another read', { timeout: 2_000 }, async () => {
  let diskReads = 0, networkReads = 0, abortEvents = 0
  let resolveDisk, resolveNetwork, signal, markDiskStarted, markNetworkStarted
  const delayedDisk = new Promise(resolve => { resolveDisk = resolve })
  const delayedNetwork = new Promise(resolve => { resolveNetwork = resolve })
  const diskStarted = new Promise(resolve => { markDiskStarted = resolve })
  const networkStarted = new Promise(resolve => { markNetworkStarted = resolve })
  const monitor = createSystemResourceMonitor({
    profilePath: '/not-opened-in-test', platform: 'darwin', diskTimeoutMs: 10_000,
    readCpus: () => [], readTotalMemory: () => 100, readFreeMemory: () => 50,
    readDisk: () => { diskReads++; markDiskStarted(); return delayedDisk },
    readNetwork: ({ signal: activeSignal }) => {
      networkReads++
      signal = activeSignal
      signal.addEventListener('abort', () => { abortEvents++ })
      markNetworkStarted()
      return delayedNetwork
    },
    readDiskIo: async () => null,
  })
  const pending = monitor.sample()
  const concurrent = monitor.sample()
  assert.equal(concurrent, pending)
  await Promise.all([diskStarted, networkStarted])
  assert.equal(signal.aborted, false)
  assert.deepEqual([diskReads, networkReads], [1, 1])

  monitor.close()
  assert.equal(signal.aborted, true)
  assert.equal(abortEvents, 1)
  resolveNetwork({ interface: 'en0', rxBytes: 1n, txBytes: 2n })
  resolveDisk({ bsize: 1n, blocks: 100n, bfree: 50n })
  const completed = await pending
  assert.equal(await concurrent, completed)
  assert.equal(completed.disk.status, 'ok') // An already-started statfs read cannot be cancelled.
  await assert.rejects(monitor.sample(), /closed/)
  assert.deepEqual([diskReads, networkReads], [1, 1])
})

test('failed or unsupported reads are null with status and do not disclose diagnostic text', async () => {
  const secret = 'private-local-path-or-address'
  const mac = createSystemResourceMonitor({
    profilePath: '/not-opened-in-test', platform: 'darwin',
    readCpus: () => { throw new Error(secret) },
    readTotalMemory: () => { throw new Error(secret) },
    readDisk: async () => { throw new Error(secret) },
    readNetwork: async () => { throw new Error(secret) },
    readDiskIo: async () => { throw new Error(secret) },
  })
  const failed = await mac.sample()
  assert.deepEqual([failed.cpu.status, failed.memory.status, failed.disk.status, failed.network.status, failed.diskIo.status], ['unavailable', 'unavailable', 'unavailable', 'unavailable', 'unavailable'])
  assert.deepEqual([failed.cpu.percent, failed.memory.percent, failed.disk.percent, failed.network.rxBytesPerSecond, failed.diskIo.readBytesPerSecond], [null, null, null, null, null])
  assert.equal(JSON.stringify(failed).includes(secret), false)
  mac.close()

  let called = false
  const other = createSystemResourceMonitor({
    profilePath: '/not-opened-in-test', platform: 'win32',
    readCpus: () => [], readTotalMemory: () => 100, readFreeMemory: () => 50,
    readDisk: async () => { throw new Error('unsupported') },
    readNetwork: async () => { called = true },
    readDiskIo: async () => { called = true },
  })
  const crossPlatform = await other.sample()
  assert.equal(crossPlatform.network.status, 'unsupported')
  assert.equal(crossPlatform.diskIo.status, 'unsupported')
  assert.equal(crossPlatform.disk.status, 'unavailable')
  assert.equal(called, false)
  other.close()
})

test('timed-out disk read cannot poison the next sample or overwrite a recovered value when it resolves late', { timeout: 2_000 }, async () => {
  let tick = 0, reads = 0, resolveLate
  const lateRead = new Promise(resolve => { resolveLate = resolve })
  const monitor = createSystemResourceMonitor({
    profilePath: '/not-opened-in-test', platform: 'win32', diskTimeoutMs: 15,
    monotonicNow: () => tick,
    readCpus: () => [], readTotalMemory: () => 100, readFreeMemory: () => 50,
    readDisk: () => ++reads === 1 ? lateRead : Promise.resolve({ bsize: 1n, blocks: 100n, bfree: 20n }),
  })

  const timedOut = await monitor.sample()
  assert.deepEqual([timedOut.disk.status, timedOut.disk.percent, timedOut.memory.status], ['unavailable', null, 'ok'])
  tick = 10_000
  const recovered = await monitor.sample()
  assert.deepEqual([recovered.disk.status, recovered.disk.usedBytes, recovered.disk.percent, reads], ['ok', 80, 80, 2])

  resolveLate({ bsize: 1n, blocks: 100n, bfree: 99n })
  await Promise.resolve()
  assert.equal(await monitor.sample(), recovered)
  assert.equal(recovered.disk.usedBytes, 80)
  monitor.close()
})

test('a never-resolving readDisk cannot hold inFlight forever or accumulate unlimited reads', { timeout: 2_000 }, async () => {
  let tick = 0, reads = 0
  const never = new Promise(() => {})
  const monitor = createSystemResourceMonitor({
    profilePath: '/not-opened-in-test', platform: 'win32', diskTimeoutMs: 15, minIntervalMs: 0,
    monotonicNow: () => tick,
    readCpus: () => [], readTotalMemory: () => 100, readFreeMemory: () => 50,
    readDisk: () => { reads++; return never },
  })

  for (let index = 0; index < 3; index++) {
    const sample = await monitor.sample()
    assert.deepEqual([sample.disk.status, sample.disk.usedBytes, sample.memory.status], ['unavailable', null, 'ok'])
    tick += 10_000
  }
  assert.equal(reads, 2)
  monitor.close()
})
