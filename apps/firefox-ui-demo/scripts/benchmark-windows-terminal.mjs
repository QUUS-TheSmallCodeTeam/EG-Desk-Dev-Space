#!/usr/bin/env node
// Experimental direct-adapter comparison, not production HTTP/UI performance.
// Import/default/help is inert. Only reviewed --run creates owned processes.
import assert from 'node:assert/strict';
import { spawn, fork } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { createRequire } from 'node:module';
import { readFile, writeFile, mkdir, mkdtemp, realpath } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { stripVTControlCharacters } from 'node:util';
import { TerminalTranscript, outputCommand } from './verify-windows-terminal.mjs';

const GEOMETRY = { cols: 120, rows: 30 }, BULK_LINES = 16384, BULK_LINE_BYTES = 64;
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const OUTPUT_ROOT = path.join(ROOT, '.tmp', 'windows-terminal-benchmarks', 'outputs');
const now = () => process.hrtime.bigint();
const milliseconds = (end, start) => Number(end - start) / 1e6;
const nonce = () => randomBytes(8).toString('hex');
const ps = value => `'${String(value).replaceAll("'", "''")}'`;
const mark = (phase, key, shell) => `EGD_${phase}_${key}_${shell.toUpperCase()}`;
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

export function parseBenchmarkOptions(args) {
  if (!args.length || (args.length === 1 && args[0] === '--help')) return { run: false };
  assert.equal(args[0], '--run', 'live benchmark requires explicit --run');
  const values = new Map();
  for (let i = 1; i < args.length; i += 2) {
    const name = args[i], value = args[i + 1];
    assert.ok(['--rust', '--samples', '--output', '--workload'].includes(name) && value && !values.has(name), 'unknown, duplicate or incomplete benchmark option');
    values.set(name, value);
  }
  const executable = values.get('--rust');
  assert.ok(typeof executable === 'string' && path.win32.isAbsolute(executable) && /\.exe$/i.test(executable), '--rust requires an absolute Windows executable');
  const samples = Number(values.get('--samples') || 5);
  assert.ok(Number.isInteger(samples) && samples >= 1 && samples <= 5, '--samples must be an integer from 1 through 5');
  const output = values.get('--output') || null;
  if (output) assert.ok(path.win32.isAbsolute(output) && /\.json$/i.test(output), '--output requires an absolute JSON path');
  const workload = values.get('--workload') || 'lines';
  assert.ok(['lines', 'burst'].includes(workload), '--workload must be lines or burst');
  return { run: true, executable, samples, output, workload };
}

export function bulkGenerator(key, workload = 'lines') {
  assert.match(key, /^[a-f0-9]{16}$/);
  assert.ok(['lines', 'burst'].includes(workload));
  const padding = BULK_LINE_BYTES - `EGD_${key}_000000_`.length;
  const header = `$p='EGD_'+'${key}'+'_';$z='x'*${padding};`;
  const begin = `[Console]::WriteLine(('EGD_BULK_BEGIN_'+'${key}'));`;
  const end = `[Console]::WriteLine(('EGD_BULK_END_'+'${key}'))`;
  if (workload === 'burst') return header
    + `$sb=New-Object System.Text.StringBuilder;for($i=0;$i -lt ${BULK_LINES};$i++){[void]$sb.AppendLine($p+$i.ToString('D6')+'_'+$z)};$body=$sb.ToString();`
    + begin + '[Console]::Write($body);' + end;
  return header + begin
    + `for($i=0;$i -lt ${BULK_LINES};$i++){[Console]::WriteLine($p+$i.ToString('D6')+'_'+$z)};` + end;
}

export function balancedOrder(samples, shellId) {
  assert.ok(Number.isInteger(samples) && samples >= 1 && samples <= 5);
  assert.ok(['powershell', 'cmd'].includes(shellId));
  return Array.from({ length: samples }, (_, repetition) => {
    const reverse = (repetition + (shellId === 'cmd' ? 1 : 0)) % 2;
    return (reverse ? ['rust', 'node'] : ['node', 'rust']).map(backend => ({ backend, shellId, repetition }));
  }).flat();
}

export function distribution(values) {
  assert.ok(values.length && values.every(value => Number.isFinite(value) && value >= 0), 'invalid measurement distribution');
  const sorted = [...values].sort((a, b) => a - b);
  const q = fraction => { const x = (sorted.length - 1) * fraction, lo = Math.floor(x); return sorted[lo] + (sorted[Math.ceil(x)] - sorted[lo]) * (x - lo); };
  return { count: sorted.length, min: sorted[0], p50: q(0.5), p95: q(0.95), max: sorted.at(-1) };
}

export function assertDriverExit(backend, receipt, normal = true) {
  assert.ok(Number.isInteger(receipt?.exitCode), 'native shell exit was not observed');
  if (normal) assert.equal(receipt.exitCode, 0, 'native shell did not exit successfully');
  if (backend === 'node') {
    assert.equal(receipt.exitSource, 'conpty-worker.native-onExit');
    assert.equal(receipt.nativeExitConfirmed, true); assert.equal(receipt.workerCloseConfirmed, true);
    assert.equal(receipt.workerExitCode, 0); assert.equal(receipt.workerExitSignal, null);
  } else {
    assert.equal(backend, 'rust'); assert.equal(receipt.exitSource, 'conpty-rust.native-wait');
    assert.equal(receipt.nativeWaitConfirmed, true); assert.equal(receipt.driverCloseConfirmed, true);
    assert.equal(receipt.driverExitCode, 0); assert.equal(receipt.driverExitSignal, null);
  }
  return { ...receipt };
}

export function verifyBulkPayload(raw, key, count = BULK_LINES) {
  assert.match(key, /^[a-f0-9]{16}$/); assert.ok(Number.isInteger(count) && count > 0 && count <= BULK_LINES);
  class CompleteTranscript extends TerminalTranscript {
    constructor() { super(GEOMETRY.cols, GEOMETRY.rows); this.lines = new Set(); }
    remember() { this.lines.add(this.line()); super.remember(); }
  }
  const transcript = new CompleteTranscript(); transcript.feed(raw);
  for (const row of transcript.grid.keys()) transcript.lines.add(transcript.line(row));
  const prefix = `EGD_${key}_`;
  const actual = [...transcript.lines].filter(line => line.startsWith(prefix));
  assert.equal(actual.length, count, 'bulk output has missing/extra unique indexed lines');
  const observedHash = createHash('sha256'), expectedHash = createHash('sha256');
  for (let i = 0; i < count; i++) {
    const head = prefix + String(i).padStart(6, '0') + '_';
    const expected = head + 'x'.repeat(BULK_LINE_BYTES - head.length);
    assert.equal(actual[i], expected, `bulk payload is corrupt or out of order at index ${i}`);
    observedHash.update(actual[i] + '\n'); expectedHash.update(expected + '\n');
  }
  const actualSha256 = observedHash.digest('hex'), expectedSha256 = expectedHash.digest('hex');
  assert.equal(actualSha256, expectedSha256);
  assert.ok(transcript.lines.has(`EGD_BULK_BEGIN_${key}`) && transcript.lines.has(`EGD_BULK_END_${key}`), 'bulk boundaries were not observed as native bare lines');
  return { verifiedPayloadBytes: count * BULK_LINE_BYTES, verifiedUniqueLines: count,
    payloadNonce: key, actualSha256, expectedSha256,
    capturedConptyUtf8Bytes: Buffer.byteLength(raw, 'utf8'), canonicalLineBytes: BULK_LINE_BYTES,
    payloadExcludesCrLfAndVt: true, hashVerified: true };
}

function bounded(promise, deadline, label) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${label} deadline reached`)), Math.max(1, deadline - Date.now()));
    promise.then(value => { clearTimeout(timer); resolve(value); }, error => { clearTimeout(timer); reject(error); });
  });
}

class ObservedSession {
  constructor(api, backend, shellId, key, deadline) {
    Object.assign(this, { api, backend, shellId, key, deadline, transcript: new TerminalTranscript(GEOMETRY.cols, GEOMETRY.rows),
      recent: '', waiters: [], receipt: null, error: null, bulk: null, dsrTail: '', dsrReplies: 0 });
    this.exited = new Promise(resolve => { this.resolveExit = resolve; });
    this.subscriptions = [api.onData(data => this.data(data)), api.onExit(receipt => {
      this.receipt = receipt; this.resolveExit(receipt); this.flush();
    }), api.onError?.(error => { this.error = error; this.flush(); })];
  }
  flush() {
    for (const waiter of [...this.waiters]) {
      try {
        if (this.error) throw this.error;
        const value = waiter.predicate();
        if (value) { this.waiters.splice(this.waiters.indexOf(waiter), 1); clearTimeout(waiter.timer); waiter.resolve({ value, at: now() }); }
        else if (this.receipt) throw new Error('native shell exited before expected evidence');
      } catch (error) { this.waiters.splice(this.waiters.indexOf(waiter), 1); clearTimeout(waiter.timer); waiter.reject(error); }
    }
  }
  arm(predicate, label, limitMs = 10000) {
    return new Promise((resolve, reject) => {
      const waiter = { predicate, resolve, reject };
      waiter.timer = setTimeout(() => { this.waiters = this.waiters.filter(item => item !== waiter); reject(new Error(`${label} deadline reached`)); },
        Math.max(1, Math.min(limitMs, this.deadline - Date.now())));
      this.waiters.push(waiter); this.flush();
    });
  }
  data(data) {
    if (typeof data !== 'string') { this.error = new Error('driver output was not UTF-8 text'); this.flush(); return; }
    const dsr = this.dsrTail + data, queries = (dsr.match(/\x1b\[6n/g) || []).length;
    this.dsrTail = dsr.slice(-3);
    if (queries) {
      this.dsrReplies += queries;
      if (this.dsrReplies > 32) this.error = new Error('cursor-query budget exceeded');
      else void this.api.write('\x1b[1;1R'.repeat(queries)).catch(error => { this.error = error; this.flush(); });
    }
    if (this.bulk) {
      const capture = this.bulk; capture.chunks.push(data); capture.bytes += Buffer.byteLength(data);
      if (capture.bytes > 8 * 1024 * 1024) this.error = new Error('bulk output budget exceeded');
      const tail = stripVTControlCharacters(capture.tail + data);
      if (!capture.beginAt && tail.includes(capture.begin)) capture.beginAt = now();
      if (!capture.endAt && tail.includes(capture.end)) { capture.endAt = now(); capture.resolve(); }
      capture.tail = tail.slice(-256);
    } else {
      this.transcript.feed(data);
      this.recent = stripVTControlCharacters((this.recent + data).slice(-65536));
    }
    this.flush();
  }
  write(data) { return bounded(Promise.resolve().then(() => this.api.write(data)), this.deadline, 'native write acknowledgement'); }
  async query(command, expected, limitMs = 7000) {
    const seen = this.arm(() => this.transcript.hasBareLine(expected), 'native bare output', limitMs);
    const sent = now(); await Promise.all([this.write(command + '\r'), seen]);
    return milliseconds((await seen).at, sent);
  }
  async dimensions(systemPowerShell, phase) {
    const prefix = mark(phase, this.key, this.shellId) + '|';
    const expression = `[Console]::WriteLine(('EGD_${phase}_'+'${this.key}'+'_${this.shellId.toUpperCase()}|'+[Console]::WindowWidth+'x'+[Console]::WindowHeight))`;
    const command = this.shellId === 'powershell' ? expression : `"${systemPowerShell}" -NoLogo -NoProfile -NonInteractive -Command "${expression}"`;
    const seen = this.arm(() => this.transcript.findLine(prefix)?.match(/\|(\d+)x(\d+)$/), 'native Console dimensions');
    await this.write(command + '\r'); const match = (await seen).value; return [Number(match[1]), Number(match[2])];
  }
  async finish(normal = true) {
    assert.equal(this.receipt, null, 'shell exited before the requested completion');
    let requestAcknowledged = true, requestAckCode = null;
    try {
      if (normal) await this.write('exit 0\r');
      else await bounded(Promise.resolve().then(() => this.api.kill()), this.deadline, 'kill acknowledgement');
    } catch (error) {
      // A final native receipt can race a last write/kill ACK. Only the
      // independent native+driver-close proof below can confirm completion.
      if (!['TERMINAL_DRIVER_CLOSED', 'TERMINAL_RUST_DRIVER_CLOSED'].includes(error?.code)) throw error;
      requestAcknowledged = false; requestAckCode = error?.code || 'ACK_UNCONFIRMED';
    }
    const receipt = assertDriverExit(this.backend, await bounded(this.exited, this.deadline, 'native exit and driver close'), normal);
    this.subscriptions.forEach(subscription => subscription?.dispose?.());
    return { ...receipt, requestAcknowledged, requestAckCode };
  }
}

const memoryScript = (rootPid, ownerPid, earliestMs, detailed) => `
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
$ErrorActionPreference='Stop'; $samples=@()
for($sample=0;$sample -lt 3;$sample++) {
  $all=@(Get-CimInstance -Query 'SELECT ProcessId, ParentProcessId, Name, CreationDate FROM Win32_Process')
  $root=$all | Where-Object ProcessId -eq ${rootPid}
  if(-not $root -or $root.ParentProcessId -ne ${ownerPid}) { throw 'Owned helper identity not found' }
  $ids=New-Object 'System.Collections.Generic.HashSet[int]'; [void]$ids.Add(${rootPid})
  for($depth=0;$depth -lt 12;$depth++) { $changed=$false; foreach($p in $all) {
    if($ids.Contains([int]$p.ParentProcessId) -and $p.CreationDate -ge $root.CreationDate) { if($ids.Add([int]$p.ProcessId)) {$changed=$true} }
  }; if(-not $changed){break} }
  $nodes=@(); foreach($p in $all) { if(-not $ids.Contains([int]$p.ProcessId)){continue}
    $proc=[System.Diagnostics.Process]::GetProcessById([int]$p.ProcessId); $proc.Refresh()
    $birth=$proc.StartTime.ToUniversalTime(); $birthMs=([DateTimeOffset]$birth).ToUnixTimeMilliseconds()
    if($p.ProcessId -eq ${rootPid} -and $birthMs -lt ${earliestMs - 1000}) {throw 'Owned helper PID was reused'}
    $file=$null;$version=$null
    if(${detailed ? '$true' : '$false'}) {try {$file=$proc.MainModule.FileName;$version=$proc.MainModule.FileVersionInfo.FileVersion}catch{}}
    $nodes+=[pscustomobject]@{pid=[int]$p.ProcessId;parentPid=[int]$p.ParentProcessId;name=$p.Name;
      createdTicks=$birth.Ticks.ToString();privateBytes=[long]$proc.PrivateMemorySize64;workingSetBytes=[long]$proc.WorkingSet64;
      executable=$file;fileVersion=$version}
  }
  $samples+=,[pscustomobject]@{nodes=@($nodes)}; if($sample -lt 2){Start-Sleep -Milliseconds 100}
}; ConvertTo-Json -InputObject @($samples) -Depth 5 -Compress`;

export function validateMemory(samples, rootPid, priorIdentity = null) {
  assert.ok(Array.isArray(samples) && samples.length === 3, 'three independent memory snapshots are required');
  const identities = new Map(typeof priorIdentity === 'string' ? [[rootPid, priorIdentity]]
    : Object.entries(priorIdentity || {}).map(([pid, birth]) => [Number(pid), birth]));
  for (const sample of samples) {
    assert.ok(Array.isArray(sample.nodes));
    const ids = new Set(sample.nodes.map(node => node.pid)); assert.equal(ids.size, sample.nodes.length, 'owned PID memory was double-counted');
    const root = sample.nodes.find(node => node.pid === rootPid); assert.ok(root, 'owned helper memory is missing');
    const nodes = new Map(sample.nodes.map(node => [node.pid, node]));
    for (const node of sample.nodes) {
      assert.ok(Number.isSafeInteger(node.pid) && node.pid > 0 && /^\d+$/.test(node.createdTicks), 'process birth identity is unavailable');
      if (identities.has(node.pid)) assert.equal(node.createdTicks, identities.get(node.pid), 'owned PID identity changed between memory samples');
      identities.set(node.pid, node.createdTicks);
      assert.ok(Number.isSafeInteger(node.privateBytes) && node.privateBytes >= 0 && Number.isSafeInteger(node.workingSetBytes) && node.workingSetBytes >= 0);
      const visited = new Set(); let cursor = node.pid;
      while (cursor !== rootPid) {
        assert.ok(nodes.has(cursor) && !visited.has(cursor), 'memory sample contains a non-owned or cyclic ancestry');
        visited.add(cursor); cursor = nodes.get(cursor).parentPid;
      }
    }
    sample.treePrivateBytes = sample.nodes.reduce((sum, node) => sum + node.privateBytes, 0);
  }
  return { rootPid, createdTicks: identities.get(rootPid), processIdentities: Object.fromEntries(identities),
    helperPrivateBytes: distribution(samples.map(sample => sample.nodes.find(node => node.pid === rootPid).privateBytes)),
    helperWorkingSetBytes: distribution(samples.map(sample => sample.nodes.find(node => node.pid === rootPid).workingSetBytes)),
    ownedTreePrivateBytes: distribution(samples.map(sample => sample.treePrivateBytes)),
    treeWorkingSetSummed: false, scope: 'unique owned helper descendants; common runner and memory observer excluded', samples };
}

export async function runBenchmark(options) {
  assert.equal(process.platform, 'win32'); assert.equal(Number(process.versions.node.split('.')[0]), 24);
  const startWall = Date.now(), globalDeadline = startWall + 340000, cleanupDeadline = startWall + 360000;
  const rustExecutable = await realpath(options.executable);
  assert.equal(path.extname(rustExecutable).toLowerCase(), '.exe');
  const rustSha256 = createHash('sha256').update(await readFile(rustExecutable)).digest('hex');
  const resolveHelper = createRequire(new URL('../helper/terminal-platform.mjs', import.meta.url));
  const nodePtyPackagePath = resolveHelper.resolve('node-pty/package.json');
  const nodePtyVersion = JSON.parse(await readFile(nodePtyPackagePath, 'utf8')).version;
  assert.equal(nodePtyVersion, '1.1.0', 'Node PTY baseline changed; review native flags/provenance before measuring');
  await mkdir(OUTPUT_ROOT, { recursive: true });
  const canonicalOutput = await realpath(OUTPUT_ROOT);
  const output = options.output ? path.resolve(options.output) : path.join(canonicalOutput, `terminal-${new Date().toISOString().replaceAll(/[:.]/g, '-')}-${nonce()}.json`);
  assert.equal(path.dirname(output).toLowerCase(), canonicalOutput.toLowerCase(), 'benchmark output must be directly inside its approved output directory');
  const temporary = await realpath(await mkdtemp(path.join(os.tmpdir(), 'egdesk-terminal-benchmark-')));
  const roaming = path.join(temporary, 'roaming'), local = path.join(temporary, 'local'); await mkdir(roaming); await mkdir(local);
  const { terminalEnvironment, resolveTerminalShell } = await import('../helper/terminal-platform.mjs');
  const { createWindowsPtyProcess } = await import('../helper/terminal-windows-process.mjs');
  const { createRustWindowsPtyProcess } = await import('../helper/terminal-rust-process.mjs');
  const env = terminalEnvironment({ ...process.env, HOME: temporary, USERPROFILE: temporary, APPDATA: roaming, LOCALAPPDATA: local, POWERSHELL_TELEMETRY_OPTOUT: '1' }, 'win32');
  const systemPowerShell = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  const samplerEnv = { ...Object.fromEntries(Object.entries(process.env).filter(([key]) => key.toLowerCase() !== 'psmodulepath')),
    PSModulePath: path.join(path.dirname(systemPowerShell), 'Modules'), POWERSHELL_TELEMETRY_OPTOUT: '1' };
  const result = { kind: 'windows-terminal-driver-benchmark', ok: false, scope: 'direct adapters; HTTP, UI and model excluded',
    bulkWorkload: options.workload === 'burst' ? 'precomputed-console-write-burst-v1' : 'per-line-console-write-loop-v1',
    samplesPerDriverShell: options.samples, latencyQueriesPerSession: 20, payloadBytes: BULK_LINES * BULK_LINE_BYTES,
    quantileMethod: 'linear interpolation on sorted observations; session is the replication unit',
    commonRunnerMemoryExcluded: true, cacheMode: 'OS-cache-warm; correctness and separate kill sessions are excluded for each driver and shell',
    nativeReaderEofParityClaimed: false, physicalKeyboardImeVerified: false, preflight: [], rows: [],
    provenance: { osRelease: os.release(), node: process.version, nodePty: nodePtyVersion, nodePtyPackagePath, rustExecutable, rustSha256,
      rustOutputReadBytes: 8192, nodeOutputMaxUtf16UnitsPerIpcFrame: 16384, framingEquivalent: false,
      conptyFlags: { node: { useConptyDll: false, conptyInheritCursor: false, creationFlags: 0 },
        rust: ['INHERIT_CURSOR', 'RESIZE_QUIRK', 'WIN32_INPUT_MODE'] }, conptyFlagsEquivalent: false,
      attribution: 'ConPTY implementation output-path workload; not a pure-language or HTTP/UI speed comparison',
      timingClock: 'common Node process.hrtime.bigint', nativeHostMetadata: [] } };
  const children = new Set(), sessions = new Set();
  const descendantCleanup = [];
  const track = (child, role) => { const item = { child, role, closed: false }; children.add(item); child.once('close', () => { item.closed = true; }); return child; };
  const progress = value => process.stdout.write(JSON.stringify({ kind: 'terminal-benchmark-progress', ...value }) + '\n');
  const observer = async (script, deadline) => {
    const child = track(spawn(systemPowerShell, ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', script],
      { env: samplerEnv, cwd: temporary, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] }), 'memory-observer');
    let text = ''; child.stdout.setEncoding('utf8'); child.stdout.on('data', chunk => { text += chunk; if (text.length > 512 * 1024) child.kill(); });
    child.stderr.resume();
    try {
      await bounded(new Promise((resolve, reject) => { child.once('error', reject); child.once('close', code => code === 0 ? resolve() : reject(new Error('owned read-only process sampler failed'))); }), deadline, 'memory sampler');
      return JSON.parse(text.replace(/^\uFEFF/, ''));
    } catch (error) { if (child.exitCode === null) child.kill(); throw error; }
  };
  const snapshotMemory = async (session, detailed) => {
    assert.equal(session.receipt, null, 'helper exited before memory observation');
    const samples = await observer(memoryScript(session.api.pid, process.pid, session.startWall, detailed), Math.min(session.deadline, Date.now() + 8000));
    assert.equal(session.receipt, null, 'helper exited during memory observation');
    const proof = validateMemory(samples, session.api.pid, session.memoryIdentity); session.memoryIdentity = proof.processIdentities;
    const choice = resolveTerminalShell({ shellId: session.shellId }, { env, platform: 'win32' });
    if (detailed) {
      const nodes = proof.samples[0].nodes;
      const shell = nodes.find(node => path.win32.basename(node.executable || '').toLowerCase() === path.win32.basename(choice.executable).toLowerCase());
      assert.ok(shell && path.win32.normalize(shell.executable).toLowerCase() === path.win32.normalize(choice.executable).toLowerCase(), 'native shell executable differs between benchmark paths');
      result.provenance.nativeHostMetadata.push({ backend: session.backend, shellId: session.shellId,
        shell: { executable: shell.executable, fileVersion: shell.fileVersion },
        hosts: nodes.filter(node => /^(?:conhost|openconsole)\.exe$/i.test(node.name)).map(node => ({ executable: node.executable, fileVersion: node.fileVersion })),
        ownedHostCoverage: nodes.some(node => /^(?:conhost|openconsole)\.exe$/i.test(node.name)) ? 'confirmed-descendant' : 'not-observed-do-not-assume' });
    }
    return proof;
  };
  const newSession = async (backend, shellId) => {
    assert.ok(Date.now() < globalDeadline, 'overall benchmark deadline reached');
    const deadline = Math.min(globalDeadline, Date.now() + 30000), key = nonce(), history = path.join(temporary, `history-${key}.txt`);
    const historyMarker = mark('HISTORY_PRIVATE', key, shellId), failureMarker = mark('BOOTSTRAP_FAILED', key, shellId);
    const initialization = `try { Import-Module PSReadLine -ErrorAction Stop; Set-PSReadLineOption -HistorySaveStyle SaveNothing -HistorySavePath ${ps(history)} -ErrorAction Stop; $egdBenchHistory=Get-PSReadLineOption; if($egdBenchHistory.HistorySaveStyle -ne 'SaveNothing' -or $egdBenchHistory.HistorySavePath -ne ${ps(history)}){throw 'Private benchmark history not confirmed'}; [Console]::WriteLine(('EGD_HISTORY_PRIVATE_'+'${key}'+'_POWERSHELL')) } catch {[Console]::WriteLine(('EGD_BOOTSTRAP_FAILED_'+'${key}'+'_POWERSHELL'));throw}`;
    const started = now(), wall = Date.now();
    const common = { shellId, cwd: temporary, ...GEOMETRY, env, powerShellInitialization: initialization,
      startupTimeoutMs: Math.min(10000, deadline - Date.now()), requestTimeoutMs: 5000 };
    const api = backend === 'node'
      ? await bounded(createWindowsPtyProcess({ ...common, spawnWorker: (...args) => track(fork(...args), 'node-driver') }), deadline, 'Node driver ready')
      : await bounded(createRustWindowsPtyProcess({ ...common, executable: rustExecutable,
        spawnDriver: (...args) => track(spawn(...args), 'rust-driver') }), deadline, 'Rust driver ready');
    const ready = now(), session = new ObservedSession(api, backend, shellId, key, deadline); sessions.add(session);
    session.startWall = wall; session.driverReadyMs = milliseconds(ready, started);
    if (backend === 'rust') {
      assert.equal(api.driverInfo?.debugAssertions, false, 'Rust helper is not confirmed as a non-debug build');
      const choice = resolveTerminalShell({ shellId }, { env, platform: 'win32' });
      assert.equal(path.win32.normalize(api.driverInfo.shell).toLowerCase(), path.win32.normalize(choice.executable).toLowerCase(), 'Rust selected another shell binary');
      const expectedArgs = shellId === 'powershell' ? ['-NoLogo', '-NoProfile', '-NoExit', '-Command', initialization] : choice.args;
      assert.deepEqual(api.driverInfo.args, expectedArgs, 'Rust shell argv differs from the reviewed Node worker');
      result.provenance.rustImplementation = api.driverInfo.implementation; result.provenance.rustHelperPackageVersion = api.driverInfo.version;
    }
    if (shellId === 'powershell') await session.arm(() => { if (session.transcript.hasBareLine(failureMarker)) throw new Error('private PowerShell bootstrap failed'); return session.transcript.hasBareLine(historyMarker); }, 'private startup history');
    else await session.write(`set "EGD_QA_NONCE=${key}"\r`);
    const first = session.arm(() => session.transcript.hasBareLine(mark('READY', key, shellId)), 'first real shell command');
    await session.write(outputCommand(shellId, 'READY', key) + '\r'); session.shellReadyMs = milliseconds((await first).at, started);
    return session;
  };
  const confirmDescendantsGone = async session => {
    assert.ok(session.memoryIdentity && Object.keys(session.memoryIdentity).length, 'owned process identities were not observed before exit');
    const wanted = Object.entries(session.memoryIdentity).map(([pid, birth]) => ({ pid: Number(pid), birth }));
    const script = `$ErrorActionPreference='Stop';$wanted=ConvertFrom-Json ${ps(JSON.stringify(wanted))};$alive=@();foreach($w in $wanted){$p=Get-Process -Id $w.pid -ErrorAction SilentlyContinue;if($null -ne $p){$birth=$p.StartTime.ToUniversalTime().Ticks.ToString();if($birth -eq $w.birth){$alive+=,[pscustomobject]@{pid=[int]$w.pid;birth=$birth}}}};ConvertTo-Json -InputObject @($alive) -Compress`;
    const deadline = Math.min(session.deadline, Date.now() + 5000); let alive;
    do {
      alive = await observer(script, deadline);
      assert.ok(Array.isArray(alive), 'owned process cleanup observer returned another shape');
      if (!alive.length) { const proof = { confirmed: true, observedIdentities: wanted.length }; descendantCleanup.push(proof); return proof; }
      await delay(80);
    } while (Date.now() < deadline);
    throw new Error('an observed owned helper/shell/ConHost process remained after confirmed driver closure');
  };
  const closeSession = async (session, normal) => {
    const receipt = await session.finish(normal);
    const ownedDescendantsGone = await confirmDescendantsGone(session);
    sessions.delete(session); return { ...receipt, ownedDescendantsGone };
  };
  const correctness = async (backend, shellId) => {
    progress({ phase: 'excluded-functional-warmup', backend, shellId });
    const s = await newSession(backend, shellId), key = s.key;
    const unicode = mark('UTF8', key, shellId) + '_한글';
    await s.query(shellId === 'powershell' ? `Write-Output ('EGD_UTF8_'+'${key}'+'_POWERSHELL_한글')` : 'echo EGD_UTF8_%EGD_QA_NONCE%_CMD_한글', unicode);
    const edited = shellId === 'powershell' ? `Write-Output ('EGD_DEL_'+'${key}'+'_POWERSHELLX\x7f')` : 'echo EGD_DEL_%EGD_QA_NONCE%_CMDX\x7f';
    await s.query(edited, mark('DEL', key, shellId));
    assert.deepEqual(await s.dimensions(systemPowerShell, 'SIZE_BEFORE'), [GEOMETRY.cols, GEOMETRY.rows]);
    await bounded(Promise.resolve(s.api.resize(141, 37)), s.deadline, 'native resize acknowledgement'); s.transcript.resize(141, 37);
    assert.deepEqual(await s.dimensions(systemPowerShell, 'SIZE_AFTER'), [141, 37]);
    const sleep = `[Console]::WriteLine(('EGD_SLEEP_'+'${key}'+'_${shellId.toUpperCase()}'));Start-Sleep -Seconds 30`;
    await s.query(shellId === 'powershell' ? sleep : `"${systemPowerShell}" -NoLogo -NoProfile -NonInteractive -Command "${sleep}"`, mark('SLEEP', key, shellId));
    s.recent = ''; const interrupted = now(); await s.write('\x03');
    if (shellId === 'cmd') await s.arm(() => s.recent.includes(temporary + '>'), 'fresh CMD prompt after interrupt', 3000); else await delay(120);
    await s.query(outputCommand(shellId, 'AFTER_CTRL_C', key), mark('AFTER_CTRL_C', key, shellId), 4500);
    assert.ok(milliseconds(now(), interrupted) <= 5000, 'Ctrl-C did not release the same shell within five seconds');
    await snapshotMemory(s, false);
    const nativeExit = await closeSession(s, true);
    const kill = await newSession(backend, shellId); await snapshotMemory(kill, false);
    const killExit = await closeSession(kill, false);
    return { backend, shellId, warmupExcluded: true, utf8: true, del127: true, nativeResize: true,
      ctrlCSameSession: true, nativeExit, killExit, valid: true };
  };
  const measure = async (spec, preflight) => {
    progress({ phase: 'measurement', ...spec });
    const s = await newSession(spec.backend, spec.shellId), rtt = [];
    for (let i = 0; i < 20; i++) rtt.push(await s.query(outputCommand(s.shellId, `RTT_${i}`, s.key), mark(`RTT_${i}`, s.key, s.shellId)));
    const detailed = !result.provenance.nativeHostMetadata.some(item => item.backend === s.backend && item.shellId === s.shellId);
    const memoryWarm = await snapshotMemory(s, detailed);
    const key = nonce(), generator = bulkGenerator(key, options.workload);
    const command = s.shellId === 'powershell'
      ? `& ${ps(systemPowerShell)} -NoLogo -NoProfile -NonInteractive -Command ${ps(generator)}`
      : `"${systemPowerShell}" -NoLogo -NoProfile -NonInteractive -Command "${generator}"`;
    const capture = { chunks: [], bytes: 0, tail: '', begin: `EGD_BULK_BEGIN_${key}`, end: `EGD_BULK_END_${key}`, beginAt: null, endAt: null };
    const complete = new Promise(resolve => { capture.resolve = resolve; }); s.bulk = capture;
    const sent = now(); await Promise.all([s.write(command + '\r'), bounded(complete, s.deadline, 'bulk END arrival')]); s.bulk = null;
    assert.ok(capture.beginAt && capture.endAt && capture.endAt > capture.beginAt, 'bulk transfer boundaries were not independently observed');
    // END arrival is timestamped above. Heavy VT, unique-index and hash checks
    // below are outside the reported payload transfer interval on both paths.
    const raw = capture.chunks.join(''), integrity = verifyBulkPayload(raw, key); s.transcript.feed(raw);
    await s.query(outputCommand(s.shellId, 'AFTER_BULK', s.key), mark('AFTER_BULK', s.key, s.shellId));
    const memoryAfter = await snapshotMemory(s, false), transferMs = milliseconds(capture.endAt, capture.beginAt);
    const exit = await closeSession(s, true);
    return { ...spec, valid: preflight.valid === true, preflightRef: `${spec.backend}/${spec.shellId}`,
      driverReadyMs: s.driverReadyMs, shellReadyMs: s.shellReadyMs, roundtripMs: rtt, roundtrip: distribution(rtt),
      bulk: { ...integrity, workload: result.bulkWorkload, commandToEndMs: milliseconds(capture.endAt, sent), beginToEndMs: transferMs,
        verifiedPayloadMiBPerSecond: integrity.verifiedPayloadBytes / 1048576 / (transferMs / 1000),
        nativeConsoleGeneratorSameBinaryAndScript: true, protocolWireByteRateClaimed: false },
      memoryWarm, memoryAfterBulk: memoryAfter, nativeExitAndDriverClose: exit, driverPid: s.api.pid };
  };
  try {
    for (const shellId of ['powershell', 'cmd']) {
      const warmupOrder = shellId === 'cmd' ? ['rust', 'node'] : ['node', 'rust'];
      for (const backend of warmupOrder) result.preflight.push(await correctness(backend, shellId));
    }
    // All four independent correctness gates precede measured comparisons.
    for (const shellId of ['powershell', 'cmd']) {
      for (const spec of balancedOrder(options.samples, shellId)) {
        const proof = result.preflight.find(item => item.backend === spec.backend && item.shellId === shellId);
        result.rows.push(await measure(spec, proof));
      }
    }
    result.ok = result.rows.length === options.samples * 4 && result.rows.every(row => row.valid);
  } catch (error) { result.error = String(error?.message || error).slice(0, 500); }
  finally {
    let forced = 0;
    for (const session of sessions) {
      try { if (!session.receipt) await bounded(Promise.resolve(session.api.kill()), Math.min(cleanupDeadline, Date.now() + 3000), 'owned cleanup kill');
        assertDriverExit(session.backend, await bounded(session.exited, Math.min(cleanupDeadline, Date.now() + 5000), 'owned cleanup exit'), false); }
      catch { result.ok = false; }
      session.subscriptions.forEach(subscription => subscription?.dispose?.());
    }
    for (const item of children) if (!item.closed) { forced++; try { item.child.kill(); } catch {} }
    while ([...children].some(item => !item.closed) && Date.now() < cleanupDeadline) await delay(40);
    result.cleanup = { allOwnedChildHandlesClosed: [...children].every(item => item.closed), forcedOwnedProcessStops: forced,
      allObservedOwnedDescendantsGone: descendantCleanup.length === result.preflight.length * 2 + result.rows.length
        && descendantCleanup.every(proof => proof.confirmed === true),
      noGlobalProcessKill: true, temporaryDirectoryRetained: temporary };
    if (forced || !result.cleanup.allOwnedChildHandlesClosed || !result.cleanup.allObservedOwnedDescendantsGone) result.ok = false;
    result.elapsedMs = Date.now() - startWall; if (result.elapsedMs > 360000) result.ok = false;
    if (result.ok) result.summary = ['powershell', 'cmd'].flatMap(shellId => ['node', 'rust'].map(backend => {
      const rows = result.rows.filter(row => row.shellId === shellId && row.backend === backend);
      return { backend, shellId, sessions: rows.length, driverReadyMs: distribution(rows.map(row => row.driverReadyMs)),
        shellReadyMs: distribution(rows.map(row => row.shellReadyMs)), pooledRoundtripMs: distribution(rows.flatMap(row => row.roundtripMs)),
        sessionMedianRoundtripMs: distribution(rows.map(row => row.roundtrip.p50)),
        verifiedPayloadMiBPerSecond: distribution(rows.map(row => row.bulk.verifiedPayloadMiBPerSecond)),
        helperPrivateBytesWarm: distribution(rows.map(row => row.memoryWarm.helperPrivateBytes.p50)),
        treePrivateBytesWarm: distribution(rows.map(row => row.memoryWarm.ownedTreePrivateBytes.p50)) };
    }));
    result.output = output; await writeFile(output, JSON.stringify(result, null, 2) + '\n', { flag: 'wx' });
  }
  return result;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const options = parseBenchmarkOptions(process.argv.slice(2));
    if (!options.run) process.stdout.write('Direct Windows terminal benchmark: --run --rust <absolute release .exe> [--samples 1..5] [--workload lines|burst] [--output <absolute approved-output.json>]. No HTTP/UI/model benchmark.\n');
    else { const result = await runBenchmark(options); process.stdout.write(JSON.stringify({ kind: result.kind, ok: result.ok,
      scope: result.scope, rows: result.rows.length, output: result.output, summary: result.summary || null, error: result.error || null }) + '\n'); if (!result.ok) process.exitCode = 1; }
  } catch (error) { process.stdout.write(JSON.stringify({ kind: 'windows-terminal-driver-benchmark', ok: false, error: String(error?.message || error) }) + '\n'); process.exitCode = 1; }
}
