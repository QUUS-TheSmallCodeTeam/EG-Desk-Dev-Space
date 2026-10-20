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
    enqueue(data) {
      if (typeof data !== 'string') return Promise.reject(new TypeError('Terminal input must be text'));
      const id = sessionId, revision = generation;
      if (!id || !data) return Promise.resolve({ ok: false, skipped: true, code: 'TERMINAL_INPUT_INACTIVE' });
      const pending = tail.then(async () => {
        if (!current(id, revision)) return { ok: false, skipped: true, code: 'TERMINAL_INPUT_STALE' };
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
