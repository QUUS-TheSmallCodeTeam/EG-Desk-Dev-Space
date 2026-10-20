import test from 'node:test';
import assert from 'node:assert/strict';
import { parseBenchmarkOptions, balancedOrder, distribution, assertDriverExit, verifyBulkPayload, validateMemory, bulkGenerator } from './benchmark-windows-terminal.mjs';

test('benchmark is inert by default and accepts no arbitrary command or unbounded sample count', () => {
  assert.deepEqual(parseBenchmarkOptions([]), { run: false });
  assert.deepEqual(parseBenchmarkOptions(['--help']), { run: false });
  assert.equal(parseBenchmarkOptions(['--run', '--rust', 'C:\\owned\\release\\worker.exe', '--samples', '1']).samples, 1);
  assert.equal(parseBenchmarkOptions(['--run', '--rust', 'C:\\owned\\release\\worker.exe', '--workload', 'burst']).workload, 'burst');
  for (const args of [['--run'], ['--run', '--rust', 'worker.exe'], ['--run', '--rust', 'C:\\worker.exe', '--samples', '6'],
    ['--run', '--rust', 'C:\\worker.exe', '--command', 'anything']]) assert.throws(() => parseBenchmarkOptions(args));
});

test('burst payload construction precedes BEGIN while line workloads keep their producer loop inside timing', () => {
  const key = '0123456789abcdef', burst = bulkGenerator(key, 'burst'), lines = bulkGenerator(key, 'lines');
  assert.ok(burst.indexOf('$body=$sb.ToString()') < burst.indexOf('EGD_BULK_BEGIN_'));
  assert.ok(burst.indexOf('[Console]::Write($body)') > burst.indexOf('EGD_BULK_BEGIN_'));
  assert.ok(lines.indexOf('for($i=0;') > lines.indexOf('EGD_BULK_BEGIN_'));
  assert.throws(() => bulkGenerator(key, 'unreviewed'));
  assert.throws(() => bulkGenerator('injected', 'burst'));
});

test('paired trial order reverses by shell and preserves equal fresh-session counts', () => {
  const a = balancedOrder(5, 'powershell'), b = balancedOrder(5, 'cmd');
  assert.equal(a.map(row => row.backend[0]).join(''), 'nrrnnrrnnr');
  assert.equal(b.map(row => row.backend[0]).join(''), 'rnnrrnnrrn');
  for (const list of [a, b]) for (const backend of ['node', 'rust']) assert.equal(list.filter(row => row.backend === backend).length, 5);
  assert.deepEqual(distribution([1, 2, 3]), { count: 3, min: 1, p50: 2, p95: 2.9, max: 3 });
  assert.throws(() => distribution([NaN]));
});

test('native wait and native onExit remain distinct and a bare driver closure proves neither', () => {
  const node = { exitCode: 0, exitSource: 'conpty-worker.native-onExit', nativeExitConfirmed: true, workerCloseConfirmed: true, workerExitCode: 0, workerExitSignal: null };
  const rust = { exitCode: 0, exitSource: 'conpty-rust.native-wait', nativeWaitConfirmed: true, driverCloseConfirmed: true, driverExitCode: 0, driverExitSignal: null };
  assertDriverExit('node', node); assertDriverExit('rust', rust);
  assert.throws(() => assertDriverExit('rust', node)); assert.throws(() => assertDriverExit('node', rust));
  assert.throws(() => assertDriverExit('rust', { ...rust, nativeWaitConfirmed: false }));
  assert.throws(() => assertDriverExit('node', { ...node, workerCloseConfirmed: false }));
});

test('bulk proof verifies every unique indexed data line, not raw VT bytes or echoed commands', () => {
  const key = '0123456789abcdef', prefix = `EGD_${key}_`;
  const lines = Array.from({ length: 3 }, (_, index) => { const head = prefix + String(index).padStart(6, '0') + '_'; return head + 'x'.repeat(64 - head.length); });
  const raw = `EGD_BULK_BEGIN_${key}\r\n` + lines.join('\r\n') + `\r\nEGD_BULK_END_${key}\r\n`;
  assert.equal(verifyBulkPayload(raw, key, 3).verifiedPayloadBytes, 192);
  assert.throws(() => verifyBulkPayload(raw.replace(lines[1] + '\r\n', ''), key, 3));
  assert.throws(() => verifyBulkPayload(raw.replace(lines[1], lines[1].replace(/x$/, 'y')), key, 3));
  assert.throws(() => verifyBulkPayload(`PS> EGD_BULK_BEGIN_${key}\r\n`, key, 3));
  const many = Array.from({ length: 3000 }, (_, index) => { const head = prefix + String(index).padStart(6, '0') + '_'; return head + 'x'.repeat(64 - head.length); });
  assert.equal(verifyBulkPayload(`EGD_BULK_BEGIN_${key}\r\n` + many.join('\r\n') + `\r\nEGD_BULK_END_${key}\r\n`, key, 3000).verifiedUniqueLines, 3000);
});

test('memory aggregation uses unique owned PIDs/private bytes and guards PID reuse', () => {
  const root = { pid: 100, parentPid: 1, createdTicks: '1000000', privateBytes: 10, workingSetBytes: 30 };
  const shell = { pid: 200, parentPid: 100, createdTicks: '1000001', privateBytes: 20, workingSetBytes: 40 };
  const make = () => Array.from({ length: 3 }, () => ({ nodes: [{ ...root }, { ...shell }] }));
  const result = validateMemory(make(), 100); assert.equal(result.ownedTreePrivateBytes.p50, 30); assert.equal(result.treeWorkingSetSummed, false);
  const reused = make(); reused[1].nodes[0].createdTicks = '2000000'; assert.throws(() => validateMemory(reused, 100));
  const duplicate = make(); duplicate[0].nodes.push({ ...shell }); assert.throws(() => validateMemory(duplicate, 100));
  const foreign = make(); foreign[0].nodes[1].parentPid = 999; assert.throws(() => validateMemory(foreign, 100));
  const cyclic = make(); cyclic[0].nodes[1].parentPid = 201;
  cyclic[0].nodes.push({ pid: 201, parentPid: 200, createdTicks: '1000002', privateBytes: 1, workingSetBytes: 1 });
  assert.throws(() => validateMemory(cyclic, 100));
});
