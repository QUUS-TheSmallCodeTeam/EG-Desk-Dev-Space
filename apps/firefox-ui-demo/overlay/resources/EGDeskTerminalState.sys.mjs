// Production close loop, with injected transport and clock for deterministic tests.
export const terminalResponsePacket = (body, httpStatus) => ({ ...body, httpStatus });
export function terminalExitEvidence(result, sessionId) {
  if (typeof sessionId !== 'string' || !sessionId || !result || result.httpStatus !== 200
      || result.sessionId !== sessionId || result.status !== 'EXITED'
      || result.exitConfirmed !== true || result.exited !== true || result.error) return null;
  const workerFields = ['nativeExitConfirmed', 'workerCloseConfirmed', 'workerExitCode', 'workerExitSignal'];
  const workerReceipt = String(result.exitSource || '').startsWith('conpty-worker')
    || workerFields.some(field => Object.hasOwn(result, field));
  if (workerReceipt && (result.exitSource !== 'conpty-worker.native-onExit'
      || result.nativeExitConfirmed !== true || result.workerCloseConfirmed !== true
      || result.workerExitCode !== 0 || result.workerExitSignal !== null)) return null;
  return 'native-exit';
}
const responseFields = result => { const { data, ...fields } = result || {}; return fields; };
const isUnknown = result => result?.status === 'UNKNOWN' || result?.code === 'UNKNOWN_SESSION' || result?.error === 'Session not found';

export function createTerminalCloseController({ requestKill, readStatus, onState = () => {}, onOutput = () => {}, wait = ms => new Promise(resolve => setTimeout(resolve, ms)), intervalMs = 150, maxAttempts = 20, maxFailures = 3 }) {
  let state = { phase: 'idle', sessionId: null, killAccepted: false, evidence: null, attempts: 0, error: null };
  let pending = null;
  const publish = patch => { state = { ...state, ...patch }; onState({ ...state }); };
  const close = sessionId => {
    if (!sessionId) return Promise.resolve(false);
    if (pending) return state.sessionId === sessionId ? pending : Promise.resolve(false);
    if (state.sessionId === sessionId && state.phase === 'confirmed') return Promise.resolve(true);
    if (state.sessionId !== sessionId) state = { phase: 'idle', sessionId, killAccepted: false, evidence: null, attempts: 0, error: null };
    pending = (async () => {
      publish({ phase: 'closing', attempts: 0, error: null });
      if (!state.killAccepted) {
        try {
          const result = await requestKill(sessionId);
          publish({ lastKillResponse: responseFields(result) });
          const evidence = terminalExitEvidence(result, sessionId);
          if (evidence) { publish({ phase: 'confirmed', evidence, receipt: responseFields(result), error: null }); return true; }
          if (isUnknown(result)) { publish({ phase: 'unknown', error: '세션이 조회되지 않지만 실행 종료는 확인되지 않았습니다.' }); return false; }
          publish({ killAccepted: result?.httpStatus === 200 && result?.ok === true && result?.status === 'STOP_REQUESTED' && result?.stopRequested === true });
        } catch (error) { publish({ error: error.message }); }
      }
      let failures = 0;
      for (let attempt = 1; attempt <= maxAttempts; attempt++) {
        try {
          const result = await readStatus(sessionId);
          publish({ lastResponse: responseFields(result) });
          if (result?.data) onOutput(result.data);
          const evidence = terminalExitEvidence(result, sessionId);
          if (evidence) { publish({ phase: 'confirmed', evidence, receipt: responseFields(result), attempts: attempt, error: null }); return true; }
          if (isUnknown(result)) {
            publish({ phase: 'unknown', attempts: attempt, error: '세션이 조회되지 않지만 실행 종료는 확인되지 않았습니다.' });
            return false;
          }
          if (result?.httpStatus !== 200 || result?.error) throw new Error(result?.error || result?.code || `HTTP ${result?.httpStatus ?? 'unknown'}`);
          failures = 0;
          publish({ attempts: attempt, error: null });
        } catch (error) {
          failures++;
          publish({ attempts: attempt, error: error.message });
          if (failures >= maxFailures) { publish({ phase: 'offline' }); return false; }
        }
        if (attempt < maxAttempts) await wait(intervalMs);
      }
      publish({ phase: 'timeout' });
      return false;
    })().finally(() => { pending = null; });
    return pending;
  };
  return { close, retry: () => close(state.sessionId), snapshot: () => ({ ...state }) };
}

// Serialize writes once and fence queued input at every session/lifecycle change.
// A rejected write remains visible to its caller; only the internal ordering tail
// is recovered so it cannot become an unhandled rejection or replay old input.
export function createTerminalWriteQueue({ write, onError = () => {} }) {
  let tail = Promise.resolve(), sessionId = null, generation = 0;
  const current = (id, revision) => sessionId === id && generation === revision;
  return {
    bind(id) {
      if (typeof id !== 'string' || !id) throw new Error('A terminal session is required');
      sessionId = id; generation++;
    },
    invalidate() { sessionId = null; generation++; },
    snapshot: () => ({ sessionId, generation }),
    enqueue(data, { isCurrent = () => true, beforeWrite = null } = {}) {
      if (typeof data !== 'string') return Promise.reject(new TypeError('Terminal input must be text'));
      const id = sessionId, revision = generation;
      if (!id || !data) return Promise.resolve({ ok: false, skipped: true, code: 'TERMINAL_INPUT_INACTIVE' });
      const pending = tail.then(async () => {
        const active = () => current(id, revision) && isCurrent();
        if (!active()) return { ok: false, skipped: true, code: 'TERMINAL_INPUT_STALE' };
        if (beforeWrite) {
          const permission = await beforeWrite();
          if (permission?.ok === false) return { ...permission, skipped: true };
        }
        if (!active()) return { ok: false, skipped: true, code: 'TERMINAL_INPUT_STALE' };
        try {
          const result = await write(id, data);
          if (result?.ok === false || result?.error) throw new Error(result.error || 'Terminal input was rejected');
          return result;
        } catch (error) {
          if (current(id, revision)) {
            sessionId = null; generation++;
            onError(error, id);
          }
          throw error;
        }
      });
      tail = pending.then(() => undefined, () => undefined);
      return pending;
    },
  };
}

// xterm owns native composition. The fallback retains the privileged-frame
// compatibility path only when that composition produced no onData at all.
// Tokens expire at real input boundaries or a session change; equal text in a
// later composition or paste is a new action, never a global deduplication key.
export function createTerminalCompositionGate({
  send, sessionKey, onFallback = () => {}, onError = () => {},
  schedule = (fn, ms) => setTimeout(fn, ms), cancel = id => clearTimeout(id), delayMs = 40,
}) {
  let token = null, sequence = 0;
  const valid = item => item && token === item && item.key === sessionKey();
  const stopTimer = item => { if (item?.timer != null) { cancel(item.timer); item.timer = null; } };
  const fallback = item => {
    if (!valid(item) || !item.text || item.nativeSeen || item.fallbackSent) return;
    item.fallbackSent = true;
    Promise.resolve(send(item.text)).catch(onError);
    onFallback(item.text);
  };
  const invalidate = () => { stopTimer(token); token = null; };
  const boundary = () => {
    const previous = token;
    stopTimer(previous);
    fallback(previous); // Commit precedes the following Enter, paste, or key.
    token = null;
  };
  return {
    start() {
      boundary();
      token = { sequence: ++sequence, key: sessionKey(), text: '', nativeSeen: false,
        fallbackSent: false, duplicateSuppressed: false, timer: null };
    },
    end(text) {
      if (!token) this.start();
      const item = token;
      item.text = typeof text === 'string' ? text : '';
      stopTimer(item);
      if (!item.text || item.nativeSeen || !valid(item)) return;
      item.timer = schedule(() => { item.timer = null; fallback(item); }, delayMs);
    },
    data(data) {
      const item = token;
      if (valid(item) && item.fallbackSent && !item.duplicateSuppressed && data === item.text) {
        item.duplicateSuppressed = true;
        return Promise.resolve({ ok: true, suppressedDuplicate: true });
      }
      // VT status/device replies and control keys are not composed text.
      // They still pass through unchanged but cannot disable the IME fallback.
      const controlsOnly = /^(?:\x1b\[[0-?]*[ -/]*[@-~]|[\x00-\x1f\x7f])+$/.test(data);
      if (valid(item) && !item.fallbackSent && !controlsOnly) {
        item.nativeSeen = true;
        stopTimer(item);
      }
      return send(data);
    },
    boundary, invalidate,
  };
}

// ---- 2-X (D-X6): a project command run in the user's own terminal ----
// The File view's '검사' runs a command the user typed for the project (never
// a package.json suggestion by itself). The line is typed into the visible
// terminal, so the user sees exactly what runs. After the command, the shell
// prints an end marker carrying this run's nonce and exit status; the
// collector keeps a bounded copy of the output until that marker (first 8 KiB
// + last 64 KiB, the chat runtime's {head, tail, omittedBytes} capture shape
// that EGDeskRunResult reads). The echoed command line cannot match the
// marker: it holds a format string or an expression, not the digits.
export const TERMINAL_RUN_LIMITS = Object.freeze({ headChars: 8 * 1024, tailChars: 64 * 1024, timeoutMs: 10 * 60_000, maxCommandChars: 1000 });
const RUN_NONCE = /^[a-z0-9]{8,32}$/;
const COMMAND_BAD = /[\u0000-\u001f\u007f\u2028\u2029]/;

export function quotePosixShell(value) {
  return `'${String(value).replace(/'/g, `'\\''`)}'`;
}

export function quotePowerShell(value) {
  return `'${String(value).replace(/'/g, "''")}'`;
}

export function terminalRunNonce(random = () => Math.random()) {
  let nonce = '';
  while (nonce.length < 16) nonce += Math.floor(random() * 36).toString(36);
  return nonce.slice(0, 16);
}

// {command, cwd, nonce, shell: 'posix'|'powershell'} → the line to type,
// ending in '\r' (Enter). cwd is the project folder the File view shows.
export function terminalScriptLine({ command, cwd, nonce, shell = 'posix' } = {}) {
  if (typeof command !== 'string' || !command.trim() || command.length > TERMINAL_RUN_LIMITS.maxCommandChars || COMMAND_BAD.test(command)) {
    throw Object.assign(new Error('The project command must be one line'), { code: 'TERMINAL_RUN_COMMAND' });
  }
  if (typeof nonce !== 'string' || !RUN_NONCE.test(nonce)) throw Object.assign(new Error('A run nonce is required'), { code: 'TERMINAL_RUN_NONCE' });
  if (cwd != null && (typeof cwd !== 'string' || !cwd || COMMAND_BAD.test(cwd))) throw Object.assign(new Error('Invalid project folder'), { code: 'TERMINAL_RUN_CWD' });
  const text = command.trim();
  if (shell === 'posix') {
    const enter = cwd ? `cd -- ${quotePosixShell(cwd)} && ` : '';
    // The complete user command is gated on cd, including semicolon-separated
    // commands and comments. A subshell also keeps its cd/exit from escaping.
    return `( ${enter}eval ${quotePosixShell(text)} ); printf '\\n[egdesk-run:%s:exit=%d]\\n' ${nonce} "$?"\r`;
  }
  if (shell === 'powershell') {
    const enter = cwd ? `Set-Location -LiteralPath ${quotePowerShell(cwd)} -ErrorAction Stop; ` : '';
    return `& { $egdeskExit = 1; $egdeskLocation = Get-Location; try { ${enter}$global:LASTEXITCODE = $null; & ([scriptblock]::Create(${quotePowerShell(text)})); $egdeskOk = $?; $egdeskExit = if ($null -ne $global:LASTEXITCODE) { $global:LASTEXITCODE } elseif ($egdeskOk) { 0 } else { 1 } } catch { Write-Output $_; $egdeskExit = 1 } finally { Set-Location -LiteralPath $egdeskLocation.Path -ErrorAction SilentlyContinue }; Write-Output ("\`n[egdesk-run:${nonce}:exit=" + $egdeskExit + "]") }\r`;
  }
  throw Object.assign(new Error('This terminal shell is not supported for project commands'), { code: 'TERMINAL_RUN_SHELL' });
}

// Bounded output collector. push(data) returns null until the end marker for
// this nonce arrives, then {exitCode, output: {head, tail, omittedBytes}}.
export function createTerminalRunCollector({ nonce, headChars = TERMINAL_RUN_LIMITS.headChars, tailChars = TERMINAL_RUN_LIMITS.tailChars } = {}) {
  if (typeof nonce !== 'string' || !RUN_NONCE.test(nonce)) throw Object.assign(new Error('A run nonce is required'), { code: 'TERMINAL_RUN_NONCE' });
  if (![headChars, tailChars].every(size => Number.isInteger(size) && size >= 0 && size <= TERMINAL_RUN_LIMITS.tailChars)) throw new RangeError('Invalid terminal output bound');
  const marker = new RegExp(`\\[egdesk-run:${nonce}:exit=(-?\\d{1,10})\\]`);
  let head = '';
  let tail = '';
  let omitted = 0;
  let window = '';
  let result = null;
  const keep = text => {
    if (head.length < headChars) {
      const take = text.slice(0, headChars - head.length);
      head += take;
      text = text.slice(take.length);
    }
    if (!text) return;
    tail += text;
    if (tail.length > tailChars) { omitted += tail.length - tailChars; tail = tailChars ? tail.slice(-tailChars) : ''; }
  };
  // The echoed command line (it contains 'egdesk-run:' but not the digits)
  // is dropped from what the card shows.
  const clean = text => text.split(/(?<=\n)/).filter(line => !line.includes('egdesk-run:')).join('');
  return {
    push(data) {
      if (result || typeof data !== 'string' || !data) return result;
      window += data;
      const found = marker.exec(window);
      if (!found) {
        // Pass on whole lines only, so the echoed command line is judged as a
        // whole and a marker split across chunks is still found.
        const cut = window.lastIndexOf('\n');
        if (cut >= 0) { keep(clean(window.slice(0, cut + 1))); window = window.slice(cut + 1); }
        else if (window.length > tailChars) { keep(window.slice(0, -256)); window = window.slice(-256); }
        return null;
      }
      keep(clean(window.slice(0, found.index)));
      window = '';
      result = Object.freeze({ exitCode: Number(found[1]), output: Object.freeze({ head, tail, omittedBytes: omitted }) });
      return result;
    },
    get done() { return result !== null; },
    output() {
      if (window) { keep(clean(window)); window = ''; }
      return Object.freeze({ head, tail, omittedBytes: omitted });
    },
    snapshot: () => ({ done: result !== null, headChars: head.length, tailChars: tail.length, omittedBytes: omitted }),
  };
}

// One project command: types the line through `write` (the terminal write
// queue's enqueue), feeds terminal output to onData, and resolves with
// {command, exitCode, output, durationMs, status}. A run that never prints
// its marker resolves with status 'unknown' (not a failure, EG-01) and no
// exit code; nothing is retried.
export function createTerminalScriptRun({ write, command, cwd = null, shell = 'posix', nonce = terminalRunNonce(), now = () => Date.now(), schedule = (fn, ms) => setTimeout(fn, ms), cancel = id => clearTimeout(id), timeoutMs = TERMINAL_RUN_LIMITS.timeoutMs } = {}) {
  if (typeof write !== 'function') throw new TypeError('A terminal write callback is required');
  const line = terminalScriptLine({ command, cwd, nonce, shell });
  const collector = createTerminalRunCollector({ nonce });
  let settle = null;
  let timer = null;
  let startedAt = null;
  const finished = new Promise(resolve => { settle = resolve; });
  const finish = value => {
    if (!settle) return;
    if (timer != null) { cancel(timer); timer = null; }
    const resolve = settle;
    settle = null;
    resolve(Object.freeze({ command: command.trim(), durationMs: startedAt == null ? null : now() - startedAt, ...value }));
  };
  return {
    line,
    nonce,
    start() {
      if (startedAt != null || !settle) return finished;
      startedAt = now();
      timer = schedule(() => finish({ exitCode: null, output: collector.output(), status: 'unknown' }), timeoutMs);
      if (!settle) return finished;
      try {
        // A lost write acknowledgement must not hold the result hostage after
        // the collector timed out, was cancelled, or received an exit marker.
        Promise.resolve(write(line)).then(written => {
          if (written?.ok === false) finish({ exitCode: null, output: null, status: 'not-started', code: written.code || 'TERMINAL_INPUT_REJECTED' });
        }, error => finish({ exitCode: null, output: collector.output(), status: 'unknown', code: error?.code || 'TERMINAL_INPUT_UNCONFIRMED' }));
      } catch (error) {
        finish({ exitCode: null, output: collector.output(), status: 'unknown', code: error?.code || 'TERMINAL_INPUT_UNCONFIRMED' });
      }
      return finished;
    },
    onData(data) {
      if (startedAt == null || !settle) return false;
      const result = collector.push(data);
      if (result) finish({ exitCode: result.exitCode, output: result.output, status: result.exitCode === 0 ? 'completed' : 'failed' });
      return !!result;
    },
    cancel() { finish({ exitCode: null, output: collector.output(), status: 'unknown' }); },
    get active() { return startedAt != null && !!settle; },
    result: finished,
  };
}
