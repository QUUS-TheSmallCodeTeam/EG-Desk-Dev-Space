// Production close loop, with injected transport and clock for deterministic tests.
export const terminalResponsePacket = (body, httpStatus) => ({ ...body, httpStatus });
export function terminalExitEvidence(result, sessionId) {
  if (typeof sessionId !== 'string' || !sessionId || !result || result.httpStatus !== 200
      || result.sessionId !== sessionId || result.status !== 'EXITED'
      || result.exitConfirmed !== true || result.exited !== true || result.error) return null;
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
