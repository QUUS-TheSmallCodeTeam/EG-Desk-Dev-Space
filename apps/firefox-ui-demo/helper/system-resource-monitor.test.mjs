import test from 'node:test'
import assert from 'node:assert/strict'
import { createSystemResourceMonitor, parseMacDefaultInterface, parseMacNetworkCounters } from './system-resource-monitor.mjs'

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

test('first sample warms counters; later sample reports host CPU and directional rates without a network percent', async () => {
  let tick = 0, cpuBusy = 100, cpuIdle = 100, rx = 1_000n, tx = 2_000n
  let cpuReads = 0, networkReads = 0
  const monitor = createSystemResourceMonitor({
    profilePath: '/not-opened-in-test', platform: 'darwin',
    monotonicNow: () => tick, now: () => Date.UTC(2026, 9, 20, 0, 0, 0),
    readCpus: () => { cpuReads++; return [{ times: { user: cpuBusy, nice: 0, sys: 0, idle: cpuIdle, irq: 0 } }] },
    readTotalMemory: () => 1_000, readFreeMemory: () => 250,
    readDisk: async () => ({ bsize: 1n, blocks: 2_000n, bfree: 500n }),
    readNetwork: async () => { networkReads++; return { interface: 'en0', rxBytes: rx, txBytes: tx } },
  })

  const first = await monitor.sample()
  assert.equal(first.version, 1)
  assert.equal(first.sampledAt, '2026-10-20T00:00:00.000Z')
  assert.equal(first.host, 'local-computer')
  assert.equal(first.scope, 'host')
  assert.deepEqual([first.cpu.status, first.cpu.percent, first.network.status, first.network.rxBytesPerSecond], ['warming', null, 'warming', null])
  assert.deepEqual([first.memory.usedBytes, first.memory.totalBytes, first.memory.percent], [750, 1_000, 75])
  assert.deepEqual([first.disk.usedBytes, first.disk.totalBytes, first.disk.percent, first.disk.target], [1_500, 2_000, 75, 'profile-volume'])
  assert.equal(await monitor.sample(), first)
  assert.deepEqual([cpuReads, networkReads], [1, 1])

  tick = 10_000; cpuBusy += 75; cpuIdle += 25; rx += 10_000n; tx += 5_000n
  const second = await monitor.sample()
  assert.deepEqual([second.cpu.status, second.cpu.percent, second.cpu.intervalMs], ['ok', 75, 10_000])
  assert.deepEqual([second.network.status, second.network.interface, second.network.rxBytesPerSecond, second.network.txBytesPerSecond, second.network.intervalMs], ['ok', 'en0', 1_000, 500, 10_000])
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

test('failed or unsupported reads are null with status and do not disclose diagnostic text', async () => {
  const secret = 'private-local-path-or-address'
  const mac = createSystemResourceMonitor({
    profilePath: '/not-opened-in-test', platform: 'darwin',
    readCpus: () => { throw new Error(secret) },
    readTotalMemory: () => { throw new Error(secret) },
    readDisk: async () => { throw new Error(secret) },
    readNetwork: async () => { throw new Error(secret) },
  })
  const failed = await mac.sample()
  assert.deepEqual([failed.cpu.status, failed.memory.status, failed.disk.status, failed.network.status], ['unavailable', 'unavailable', 'unavailable', 'unavailable'])
  assert.deepEqual([failed.cpu.percent, failed.memory.percent, failed.disk.percent, failed.network.rxBytesPerSecond], [null, null, null, null])
  assert.equal(JSON.stringify(failed).includes(secret), false)
  mac.close()

  let called = false
  const other = createSystemResourceMonitor({
    profilePath: '/not-opened-in-test', platform: 'win32',
    readCpus: () => [], readTotalMemory: () => 100, readFreeMemory: () => 50,
    readDisk: async () => { throw new Error('unsupported') },
    readNetwork: async () => { called = true },
  })
  const crossPlatform = await other.sample()
  assert.equal(crossPlatform.network.status, 'unsupported')
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
