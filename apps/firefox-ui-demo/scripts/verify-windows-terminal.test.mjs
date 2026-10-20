import test from 'node:test';
import assert from 'node:assert/strict';
import { runGate, TerminalTranscript, outputCommand, assertConpty, assertConfirmedExit } from './verify-windows-terminal.mjs';

test('default/help is inert and live shell processes require exact --run', () => {
  assert.equal(runGate([]), false); assert.equal(runGate(['--help']), false); assert.equal(runGate(['--run']), true);
  for (const args of [['--run', 'whoami'], ['--command', 'anything'], ['--run', '--run']]) assert.throws(() => runGate(args));
});

test('a constructed bare line is evidence; echoed command text or a prompt is not', () => {
  const key = '0123456789abcdef', expected = `EGD_ROUNDTRIP_${key}_POWERSHELL`;
  const command = outputCommand('powershell', 'ROUNDTRIP', key);
  assert.equal(command.includes(expected), false);
  const transcript = new TerminalTranscript(120, 24);
  transcript.feed(`PS> ${command}\r\n`); assert.equal(transcript.hasBareLine(expected), false);
  transcript.feed(`\x1b[?25l${expected}\r\n\x1b[?25hPS> `);
  assert.equal(transcript.hasBareLine(expected), true);
  const echoOnly = new TerminalTranscript(120, 24); echoOnly.feed(`PS> ${expected}\r\n`);
  assert.equal(echoOnly.hasBareLine(expected), false);
  assert.throws(() => outputCommand('powershell', 'A;evil', key));
  assert.throws(() => outputCommand('cmd', 'MARKER', 'unsafe&text'));
});

test('VT chunks, carriage-return erase, backspace and Korean output retain exact complete lines', () => {
  const transcript = new TerminalTranscript(120, 24);
  transcript.feed('old text\r\x1b['); transcript.feed('2K한글\b\b글\r\n');
  assert.equal(transcript.hasBareLine('한글'), true);
  transcript.feed('\x1b]0;private-title\x07VALUE|103x31\r\n');
  assert.equal(transcript.findLine('VALUE|'), 'VALUE|103x31');
  assert.equal(transcript.hasBareLine('private-title'), false);
});

test('a pipe fallback and unknown/native-unobserved exit can never pass', () => {
  const state = { ok: true, shellId: 'powershell', usePty: true, transport: 'conpty', degraded: false,
    resizeSupported: true, status: 'RUNNING', outputTruncated: false };
  assert.doesNotThrow(() => assertConpty(state, 'powershell'));
  for (const changed of [{ usePty: false }, { transport: 'pipe' }, { degraded: true }, { status: 'UNKNOWN' }])
    assert.throws(() => assertConpty({ ...state, ...changed }, 'powershell'));
  const exited = { status: 'EXITED', exited: true, exitConfirmed: true, exitSource: 'conpty-worker.native-onExit',
    nativeExitConfirmed: true, workerCloseConfirmed: true, workerExitCode: 0, workerExitSignal: null,
    exitCode: 0, exitedAt: 100, stopRequested: false };
  assert.equal(assertConfirmedExit(exited, { stopped: false }).exitConfirmed, true);
  for (const changed of [{ status: 'STOP_REQUESTED' }, { exitConfirmed: false }, { exitSource: 'process.exit' },
    { nativeExitConfirmed: false }, { workerCloseConfirmed: false }, { workerExitCode: 1 }, { workerExitSignal: 'SIGTERM' },
    { exitSource: 'pty.onExit' }, { status: 'UNKNOWN', exited: null }])
    assert.throws(() => assertConfirmedExit({ ...exited, ...changed }, { stopped: false }));
});
