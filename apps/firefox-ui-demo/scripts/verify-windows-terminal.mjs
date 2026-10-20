#!/usr/bin/env node
// Explicit --run only: owned loopback HTTP + product terminal factory/registry.
// No bridge startup, provider/model/auth, browser GUI, user profile or port 39218.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { randomBytes } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdtemp, mkdir, realpath, rmdir } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export function runGate(args) {
  if (!args.length || (args.length === 1 && args[0] === '--help')) return false;
  assert.deepEqual(args, ['--run'], 'Only --run or --help is supported; no arbitrary commands');
  return true;
}

export function assertConpty(state, shellId) {
  assert.equal(state?.ok, true, 'terminal API did not report success');
  assert.equal(state.shellId, shellId, 'terminal API selected another shell');
  assert.equal(state.usePty, true, 'terminal session fell back to pipes');
  assert.equal(state.transport, 'conpty', 'terminal transport is not actual ConPTY');
  assert.equal(state.degraded, false, 'terminal transport is degraded');
  assert.equal(state.resizeSupported, true, 'terminal transport cannot resize');
  assert.ok(['RUNNING', 'STOP_REQUESTED', 'EXITED'].includes(state.status), 'terminal state is unknown');
  assert.notEqual(state.outputTruncated, true, 'terminal output was truncated');
}

export function assertConfirmedExit(state, { stopped }) {
  assert.equal(state?.status, 'EXITED', 'stop acknowledgement is not an exit receipt');
  assert.equal(state.exited, true, 'terminal native exit was not observed');
  assert.equal(state.exitConfirmed, true, 'terminal native exit is unconfirmed');
  assert.equal(state.exitSource, 'conpty-worker.native-onExit', 'terminal exit did not come from the owned native ConPTY worker');
  assert.equal(state.nativeExitConfirmed, true, 'worker closure alone is not native terminal exit proof');
  assert.equal(state.workerCloseConfirmed, true, 'owned ConPTY worker did not close');
  assert.equal(state.workerExitCode, 0, 'owned ConPTY worker did not close cleanly');
  assert.equal(state.workerExitSignal, null, 'owned ConPTY worker closed through a signal');
  assert.equal(state.stopRequested, stopped, 'exit receipt has another stop-request history');
  assert.ok(Number.isFinite(state.exitedAt), 'terminal exit has no observation time');
  if (!stopped) assert.equal(state.exitCode, 0, 'normal shell exit was not successful');
  return { status: state.status, exitConfirmed: true, exitSource: state.exitSource,
    exitCode: state.exitCode, stopRequested: state.stopRequested,
    nativeExitConfirmed: state.nativeExitConfirmed, workerCloseConfirmed: state.workerCloseConfirmed,
    workerExitCode: state.workerExitCode, workerExitSignal: state.workerExitSignal };
}

// A bounded VT transcript for exact bare output lines. Markers are constructed
// by each shell from separate pieces, so echoed command text is not evidence.
// This is not an xterm renderer or a physical keyboard/IME test.
export class TerminalTranscript {
  constructor(cols = 80, rows = 24) {
    Object.assign(this, { cols, rows, row: 0, col: 0, pending: '', saved: [0, 0] });
    this.grid = new Map(); this.completed = new Set();
  }
  line(row = this.row) { return (this.grid.get(row) || []).join('').trimEnd(); }
  remember() {
    this.completed.add(this.line());
    if (this.completed.size > 2048) this.completed.delete(this.completed.values().next().value);
  }
  resize(cols, rows) { this.cols = cols; this.rows = rows; this.col = Math.min(this.col, cols - 1); this.row = Math.min(this.row, rows - 1); }
  newline() {
    this.remember();
    if (this.row < this.rows - 1) this.row++;
    else { for (let n = 0; n < this.rows - 1; n++) this.grid.set(n, this.grid.get(n + 1) || []); this.grid.delete(this.rows - 1); }
  }
  csi(parameters, final) {
    const p = parameters.replace(/^\?/, '').split(';').map(value => Number(value) || 0), n = p[0] || 1;
    if (final === 'A') this.row = Math.max(0, this.row - n);
    if (final === 'B') this.row = Math.min(this.rows - 1, this.row + n);
    if (final === 'C') this.col = Math.min(this.cols - 1, this.col + n);
    if (final === 'D') this.col = Math.max(0, this.col - n);
    if (final === 'E') { this.row = Math.min(this.rows - 1, this.row + n); this.col = 0; }
    if (final === 'F') { this.row = Math.max(0, this.row - n); this.col = 0; }
    if (final === 'G' || final === '`') this.col = Math.min(this.cols - 1, Math.max(0, n - 1));
    if (final === 'd') this.row = Math.min(this.rows - 1, Math.max(0, n - 1));
    if (final === 'H' || final === 'f') { this.row = Math.min(this.rows - 1, Math.max(0, (p[0] || 1) - 1)); this.col = Math.min(this.cols - 1, Math.max(0, (p[1] || 1) - 1)); }
    if (final === 'K') {
      const line = this.grid.get(this.row) || [];
      if (p[0] === 2) this.grid.set(this.row, []);
      else if (p[0] === 1) { for (let k = 0; k <= this.col; k++) line[k] = ' '; this.grid.set(this.row, line); }
      else { line.length = Math.min(line.length, this.col); this.grid.set(this.row, line); }
    }
    if (final === 'J' && (p[0] === 2 || p[0] === 3)) this.grid.clear();
    if (final === 's') this.saved = [this.row, this.col];
    if (final === 'u') [this.row, this.col] = this.saved;
  }
  feed(data) {
    let text = this.pending + data; this.pending = '';
    for (let i = 0; i < text.length;) {
      if (text[i] === '\x1b') {
        if (i + 1 >= text.length) { this.pending = text.slice(i); break; }
        if (text[i + 1] === '[') {
          const match = text.slice(i).match(/^\x1b\[([0-?]*)([ -/]*)([@-~])/);
          if (!match) { this.pending = text.slice(i); break; }
          this.csi(match[1], match[3]); i += match[0].length; continue;
        }
        if ([']', 'P', '^', '_'].includes(text[i + 1])) {
          const tail = text.slice(i + 2), end = tail.search(/\x07|\x1b\\/);
          if (end < 0) { this.pending = text.slice(i); break; }
          i += 2 + end + (tail[end] === '\x07' ? 1 : 2); continue;
        }
        if (text[i + 1] === '7') this.saved = [this.row, this.col];
        if (text[i + 1] === '8') [this.row, this.col] = this.saved;
        i += 2; continue;
      }
      const ch = String.fromCodePoint(text.codePointAt(i)); i += ch.length;
      if (ch === '\r') { this.col = 0; continue; }
      if (ch === '\n') { this.newline(); continue; }
      if (ch === '\b') { this.col = Math.max(0, this.col - 1); continue; }
      if (ch === '\t') { this.col = Math.min(this.cols - 1, (Math.floor(this.col / 8) + 1) * 8); continue; }
      if (ch.codePointAt(0) < 32 || ch === '\x7f') continue;
      if (this.col >= this.cols) { this.col = 0; this.newline(); }
      const line = this.grid.get(this.row) || [];
      while (line.length < this.col) line.push(' ');
      line[this.col++] = ch;
      if (/^[\u1100-\u115f\u2e80-\ua4cf\uac00-\ud7a3\uf900-\ufaff\uff01-\uff60]$/.test(ch)) line[this.col++] = '';
      this.grid.set(this.row, line);
    }
    assert.ok(this.pending.length < 8192, 'terminal escape sequence exceeded its bounded parser');
  }
  hasBareLine(line) { return this.completed.has(line) || [...this.grid.keys()].some(row => this.line(row) === line); }
  findLine(prefix) { return [...this.completed, ...[...this.grid.keys()].map(row => this.line(row))].find(line => line.startsWith(prefix)); }
}

const psLiteral = value => `'${String(value).replaceAll("'", "''")}'`;
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const nonce = () => randomBytes(8).toString('hex');
const marker = (phase, key, shellId) => `EGD_${phase}_${key}_${shellId.toUpperCase()}`;
const psOutput = (phase, key, shellId) => `Write-Output ('EGD_${phase}_'+'${key}'+'_${shellId.toUpperCase()}')`;
const cmdOutput = (phase, _key, shellId) => `echo EGD_${phase}_%EGD_QA_NONCE%_${shellId.toUpperCase()}`;

export function outputCommand(shellId, phase, key) {
  assert.ok(['powershell', 'cmd'].includes(shellId));
  assert.match(phase, /^[A-Z0-9_]{1,32}$/); assert.match(key, /^[a-f0-9]{16}$/);
  return shellId === 'powershell' ? psOutput(phase, key, shellId) : cmdOutput(phase, key, shellId);
}

export async function runWindowsTerminalProof() {
  assert.equal(process.platform, 'win32', 'live proof requires Windows');
  assert.equal(Number(process.versions.node.split('.')[0]), 24, 'live proof requires the reviewed Node.js 24 runtime');
  const start = Date.now(), workDeadline = start + 80000, hardDeadline = start + 90000;
  const result = { kind: 'windows-terminal-live-proof', ok: false, nodeMajor: 24,
    nativeModelUsed: false, physicalImeVerified: false, physicalClipboardVerified: false,
    defaultCodepageChanged: false, shellResults: [], cleanup: { allExitConfirmed: false } };
  const owned = new Set(), streams = new Map(); let registry, server, base, temporary, watchdog;
  const remaining = () => Math.max(1, workDeadline - Date.now());
  const api = async (route, body, status = 200, cleanup = false) => {
    const budget = (cleanup ? hardDeadline : workDeadline) - Date.now();
    assert.ok(budget > 0, 'owned terminal verification deadline reached');
    const response = await fetch(base + route, { method: body === undefined ? 'GET' : 'POST',
      ...(body === undefined ? {} : { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }),
      redirect: 'error', signal: AbortSignal.timeout(Math.min(3000, budget)) });
    assert.equal(response.status, status, `terminal API ${route} returned another HTTP status`);
    return response.json();
  };
  try {
    temporary = await realpath(await mkdtemp(path.join(os.tmpdir(), 'egdesk-terminal-live-')));
    const roaming = path.join(temporary, 'roaming'), local = path.join(temporary, 'local');
    await mkdir(roaming); await mkdir(local);
    const history = path.join(temporary, 'private-history.txt');
    const historyBootstrapKey = nonce();
    const historyReadyMarker = marker('HISTORY_PRIVATE', historyBootstrapKey, 'powershell');
    const historyFailedMarker = marker('BOOTSTRAP_FAILED', historyBootstrapKey, 'powershell');
    // This runs before the interactive reader. Verify the actual options and
    // emit a short native bare line; do not type a 350-character first query
    // while PowerShell/PSReadLine is still initializing or asking for DSR.
    const historyPrelude = `try { Import-Module PSReadLine -ErrorAction Stop; Set-PSReadLineOption -HistorySaveStyle SaveNothing -HistorySavePath ${psLiteral(history)} -ErrorAction Stop; $egdTerminalHistory = Get-PSReadLineOption -ErrorAction Stop; if ($egdTerminalHistory.HistorySaveStyle -ne 'SaveNothing' -or $egdTerminalHistory.HistorySavePath -ne ${psLiteral(history)}) { throw 'Owned terminal history bootstrap not verified' }; [Console]::WriteLine(('EGD_HISTORY_PRIVATE_'+'${historyBootstrapKey}'+'_POWERSHELL')) } catch { [Console]::WriteLine(('EGD_BOOTSTRAP_FAILED_'+'${historyBootstrapKey}'+'_POWERSHELL')); throw }`;
    const { TerminalSessionRegistry } = await import('../helper/terminal-sessions.mjs');
    const { createTerminalSessionFactory } = await import('../helper/terminal-platform.mjs');
    const { createTerminalHttpHandler } = await import('../helper/terminal-http.mjs');
    registry = new TerminalSessionRegistry();
    const factory = createTerminalSessionFactory({ registry, cwd: temporary,
      env: { ...process.env, HOME: temporary, USERPROFILE: temporary, APPDATA: roaming,
        LOCALAPPDATA: local, POWERSHELL_TELEMETRY_OPTOUT: '1' },
      // Fixed QA-only startup prelude runs before interactive history capture.
      // It is not an HTTP option and does not alter product shell defaults.
      windowsPowerShellInitialization: historyPrelude });
    const handler = createTerminalHttpHandler({ registry, factory, port: () => server.address().port });
    server = createServer(async (req, res) => {
      try {
        if (!await handler(req, res, new URL(req.url, base))) { res.writeHead(404); res.end(); }
      } catch { if (!res.headersSent) res.writeHead(500); res.end(); }
    });
    await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
    base = `http://127.0.0.1:${server.address().port}`;
    watchdog = setTimeout(() => {
      result.ok = false; result.error ||= 'Owned terminal fixture reached its ninety-second deadline';
      registry.requestStopAll(); server.closeAllConnections?.(); server.close();
    }, Math.max(1, hardDeadline - Date.now()));
    watchdog.unref?.();
    const catalog = await api('/terminal/shells');
    assert.equal(catalog.ok, true); assert.equal(catalog.platform, 'win32');
    assert.equal(catalog.transport, 'conpty'); assert.equal(catalog.ptyRequired, true);
    assert.equal(catalog.defaultShellId, 'powershell');
    for (const id of ['powershell', 'cmd']) assert.ok(catalog.shells.some(shell => shell.id === id && shell.available), `required shell ${id} is unavailable`);
    result.catalog = { defaultShellId: catalog.defaultShellId, available: catalog.shells.filter(shell => shell.available).map(shell => shell.id) };
    const unknown = await api('/terminal/read', { sessionId: `unknown-${nonce()}` }, 404);
    assert.equal(unknown.status, 'UNKNOWN'); assert.equal(unknown.exitConfirmed, false); assert.equal(unknown.exited, null);
    result.unknownNeverCountsAsExit = true;
    const systemPowerShell = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
    assert.ok(existsSync(systemPowerShell), 'fixed system PowerShell dimension-query executable is unavailable');
    const write = (id, data) => api('/terminal/write', { sessionId: id, data });
    const pump = async (id, cleanup = false) => {
      const state = await api('/terminal/read', { sessionId: id }, 200, cleanup);
      assertConpty(state, streams.get(id).shellId);
      const stream = streams.get(id), data = state.data || '';
      if (typeof stream.interruptOutput === 'string') stream.interruptOutput = (stream.interruptOutput + data).slice(-8192);
      stream.transcript.feed(data); stream.bytes += Buffer.byteLength(data);
      assert.ok(stream.bytes <= 1024 * 1024, 'owned terminal exceeded its bounded output budget');
      const scan = stream.dsrTail + data, dsrCount = (scan.match(/\x1b\[6n/g) || []).length;
      stream.dsrTail = scan.slice(-3);
      if (dsrCount) {
        stream.dsrReplies += dsrCount;
        assert.ok(stream.dsrReplies <= 16, 'owned shell exceeded its cursor-query budget');
        await write(id, '\x1b[1;1R'.repeat(dsrCount));
      }
      return state;
    };
    const wait = async (id, predicate, label, timeout = 7000, exited = false) => {
      const until = Date.now() + Math.min(timeout, remaining());
      do {
        const state = await pump(id);
        if (predicate(state, streams.get(id).transcript)) return state;
        assert.ok(exited || state.status === 'RUNNING', `${label}: shell ended before its output was observed`);
        await delay(40);
      } while (Date.now() < until);
      throw new Error(`${label}: owned terminal output deadline reached`);
    };
    const expectLine = async (id, line, label, timeout) => wait(id, (_state, transcript) => transcript.hasBareLine(line), label, timeout);
    const spawn = async shellId => {
      const state = await api('/terminal/spawn', { shellId, cols: 80, rows: 24 });
      assert.ok(typeof state.sessionId === 'string' && state.sessionId, 'spawn has no owned session ID');
      owned.add(state.sessionId); assertConpty(state, shellId); assert.equal(state.status, 'RUNNING');
      streams.set(state.sessionId, { shellId, transcript: new TerminalTranscript(), bytes: 0, dsrTail: '', dsrReplies: 0 });
      return state.sessionId;
    };
    const dimensions = async (id, shellId, phase, key) => {
      const prefix = marker(phase, key, shellId) + '|';
      const expression = `[Console]::WriteLine(('EGD_${phase}_'+'${key}'+'_${shellId.toUpperCase()}|'+[Console]::WindowWidth+'x'+[Console]::WindowHeight))`;
      await write(id, (shellId === 'powershell' ? expression
        : `"${systemPowerShell}" -NoLogo -NoProfile -NonInteractive -Command "${expression}"`) + '\r');
      await wait(id, (_state, transcript) => Boolean(transcript.findLine(prefix)?.match(/\|\d+x\d+$/)), 'native console dimensions');
      const line = streams.get(id).transcript.findLine(prefix), match = line.match(/\|(\d+)x(\d+)$/);
      return [Number(match[1]), Number(match[2])];
    };
    for (const shellId of ['powershell', 'cmd']) {
      const id = await spawn(shellId), key = nonce();
      const proof = { shellId, sessionId: id, transport: 'conpty', usePty: true,
        setupArgsDiffer: shellId === 'powershell', startupArgsDifferFromProductDefault: shellId === 'powershell' };
      result.shellResults.push(proof);
      if (shellId === 'powershell') {
        // Pump startup output and reply to any bounded cursor query before
        // sending the first interactive command. Failure never counts as ready.
        await wait(id, (_state, transcript) => {
          if (transcript.hasBareLine(historyFailedMarker)) {
            throw new Error('Owned PowerShell bootstrap failed before interactive history protection');
          }
          return transcript.hasBareLine(historyReadyMarker);
        }, 'private no-save PowerShell history bootstrap', 10000);
        proof.historyDisabledBeforeInteractiveInput = true; proof.historyPathOwned = true;
        proof.historyBootstrapMarkerVerified = true;
        proof.historyQuerySentInteractively = false;
      } else await write(id, `set "EGD_QA_NONCE=${key}"\r`);
      await write(id, outputCommand(shellId, 'ROUNDTRIP', key) + '\r');
      await expectLine(id, marker('ROUNDTRIP', key, shellId), 'bare native output marker');
      proof.nativeBareOutputVerified = true;
      const unicode = marker('UTF8', key, shellId) + '_한글';
      const unicodeCommand = shellId === 'powershell'
        ? `Write-Output ('EGD_UTF8_'+'${key}'+'_POWERSHELL_한글')`
        : 'echo EGD_UTF8_%EGD_QA_NONCE%_CMD_한글';
      await write(id, unicodeCommand + '\r'); await expectLine(id, unicode, 'default-codepage Korean UTF-8 round trip');
      proof.defaultEncodingKoreanRoundTripVerified = true;
      proof.backspace = {};
      for (const [name, byte] of [['DEL127', '\x7f'], ['BS8', '\b']]) {
        const phase = `BACKSPACE_${name}`, expected = marker(phase, key, shellId);
        const startLine = shellId === 'powershell'
          ? name === 'BS8'
            ? `Write-Output ('EGD_${phase}_'+'${key}'+'_POWERSHELL'+'DELETEWORD`
            : `Write-Output ('EGD_${phase}_'+'${key}'+'_POWERSHELLX`
          : name === 'BS8'
            ? `echo EGD_${phase}_%EGD_QA_NONCE%_CMD DELETEWORD`
            : `echo EGD_${phase}_%EGD_QA_NONCE%_CMDX`;
        await write(id, startLine + byte + (shellId === 'powershell' ? "')\r" : '\r'));
        await expectLine(id, expected, `${shellId} ${name} command-line editing`); proof.backspace[name] = true;
      }
      proof.backspace.BS8Semantics = 'native-previous-word';
      await write(id, outputCommand(shellId, 'PASTE_FIRST', key) + '\r' + outputCommand(shellId, 'PASTE_SECOND', key) + '\r');
      await expectLine(id, marker('PASTE_FIRST', key, shellId), 'first bulk multiline input');
      await expectLine(id, marker('PASTE_SECOND', key, shellId), 'second bulk multiline input');
      proof.multilineInputChunkVerified = true;
      const beforeSize = await dimensions(id, shellId, 'SIZE_BEFORE', key);
      const resized = await api('/terminal/resize', { sessionId: id, cols: 103, rows: 31 });
      assertConpty(resized, shellId); assert.equal(resized.resized, true, 'resize was not applied to native PTY');
      streams.get(id).transcript.resize(103, 31);
      const afterSize = await dimensions(id, shellId, 'SIZE_AFTER', key);
      assert.deepEqual(afterSize, [103, 31], 'native Console dimensions differ from the PTY resize');
      assert.notDeepEqual(afterSize, beforeSize, 'native Console dimensions never changed');
      proof.resize = { requested: [103, 31], before: beforeSize, independentlyObservedAfter: afterSize };
      const sleeping = marker('SLEEP_STARTED', key, shellId);
      const sleepExpression = `[Console]::WriteLine(('EGD_SLEEP_STARTED_'+'${key}'+'_${shellId.toUpperCase()}')); Start-Sleep -Seconds 30`;
      await write(id, (shellId === 'powershell' ? sleepExpression
        : `"${systemPowerShell}" -NoLogo -NoProfile -NonInteractive -Command "${sleepExpression}"`) + '\r');
      await expectLine(id, sleeping, 'owned bounded sleep began');
      const interruptedAt = Date.now();
      if (shellId === 'cmd') streams.get(id).interruptOutput = '';
      await write(id, '\x03');
      if (shellId === 'cmd') {
        // CMD can discard input while its interrupted child is unwinding.
        // Observe the new prompt, not an old screen row, before the next command.
        await wait(id, () => streams.get(id).interruptOutput.includes(temporary + '>'), 'fresh CMD prompt after Ctrl-C', 3000);
        delete streams.get(id).interruptOutput;
      } else await delay(120);
      await write(id, outputCommand(shellId, 'AFTER_CTRL_C', key) + '\r');
      const continued = await expectLine(id, marker('AFTER_CTRL_C', key, shellId), 'same shell resumed after Ctrl-C', 4500);
      assert.equal(continued.status, 'RUNNING'); assert.ok(Date.now() - interruptedAt <= 5000, 'Ctrl-C did not release the same shell within five seconds');
      proof.ctrlC = { sameSessionContinued: true, elapsedMs: Date.now() - interruptedAt, boundedSleepSeconds: 30 };
      // CMD preserves the interrupted child's ERRORLEVEL across echo. Request
      // the known exit code explicitly instead of assuming plain exit means 0.
      await write(id, 'exit 0\r');
      const normalExit = await wait(id, state => state.status === 'EXITED', 'native normal shell exit', 6000, true);
      proof.normalExit = assertConfirmedExit(normalExit, { stopped: false });
      const killId = await spawn(shellId); await api('/terminal/kill', { sessionId: killId });
      const killed = await wait(killId, state => state.status === 'EXITED', 'native explicit kill exit', 6000, true);
      proof.killExit = assertConfirmedExit(killed, { stopped: true });
      proof.cursorQueryReplies = streams.get(id).dsrReplies;
    }
    result.ok = true;
  } catch (error) {
    result.error = String(error?.message || error).slice(0, 500);
    result.fixtureScreens = [...streams.values()].map(stream => ({ shellId: stream.shellId,
      completed: [...stream.transcript.completed].slice(-36),
      lines: [...stream.transcript.grid.keys()].sort((a, b) => a - b).map(row => stream.transcript.line(row)).slice(-24),
      cursorQueryReplies: stream.dsrReplies }));
  }
  finally {
    if (registry) {
      for (const id of registry.active.keys()) owned.add(id);
      registry.requestStopAll();
      while (registry.active.size && Date.now() < hardDeadline) await delay(40);
      const states = [...owned].map(id => registry.snapshot(id));
      result.cleanup = { ownedSessions: states.length, allExitConfirmed: states.every(state => state.status === 'EXITED'
        && state.exited === true && state.exitConfirmed === true && state.exitSource === 'conpty-worker.native-onExit'
        && state.nativeExitConfirmed === true && state.workerCloseConfirmed === true && state.workerExitCode === 0
        && state.workerExitSignal === null),
      remainingOwnedSessions: registry.active.size };
      result.cleanup.driverCleanupConfirmed = result.cleanup.allExitConfirmed;
      if (!result.cleanup.allExitConfirmed) { result.ok = false; result.cleanup.error = 'Owned session exit remains unconfirmed'; }
      if (typeof registry.dispose === 'function') await registry.dispose();
    }
    if (server) { server.closeAllConnections?.(); await new Promise(resolve => server.close(resolve)); result.httpServerClosed = true; }
    clearTimeout(watchdog);
    if (temporary) {
      for (const dir of [path.join(temporary, 'roaming'), path.join(temporary, 'local'), temporary]) {
        try { await rmdir(dir); } catch { result.ownedTemporaryDirectoryRetained = true; }
      }
    }
    result.elapsedMs = Date.now() - start;
    if (result.elapsedMs > 90000) { result.ok = false; result.error ||= 'Owned terminal fixture exceeded ninety seconds'; }
  }
  return result;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    if (!runGate(process.argv.slice(2))) process.stdout.write('Windows terminal live proof: node verify-windows-terminal.mjs --run (Node 24, owned ConPTY sessions, <=90 seconds).\n');
    else {
      const result = await runWindowsTerminalProof();
      if (!result.ok) process.exitCode = 1;
      // No process.exit workaround: the Main-owned runner must also observe
      // this verifier exit naturally after product worker cleanup and HTTP close.
      process.stdout.write(JSON.stringify(result) + '\n');
    }
  } catch (error) {
    process.stdout.write(JSON.stringify({ kind: 'windows-terminal-live-proof', ok: false, error: String(error?.message || error) }) + '\n');
    process.exitCode = 1;
  }
}
