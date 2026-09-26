// Production close loop, with injected transport and clock for deterministic tests.
export function terminalExitEvidence(result) {
  if (!result || result.exited !== true || result.unknown === true || result.status === 'unknown') return null;
  if (!result.error) return 'native-exit';
  return null;
}

export function createTerminalCloseController({ requestKill, readStatus, onState = () => {}, onOutput = () => {}, wait = ms => new Promise(resolve => setTimeout(resolve, ms)), intervalMs = 150, maxAttempts = 20, maxFailures = 3 }) {
  let state = { phase: 'idle', sessionId: null, killAccepted: false, evidence: null, attempts: 0, error: null };
  let pending = null;
  const publish = patch => { state = { ...state, ...patch }; onState({ ...state }); };
  const close = sessionId => {
    if (!sessionId) return Promise.resolve(false);
    if (pending) return pending;
    if (state.sessionId === sessionId && state.phase === 'confirmed') return Promise.resolve(true);
    if (state.sessionId !== sessionId) state = { phase: 'idle', sessionId, killAccepted: false, evidence: null, attempts: 0, error: null };
    pending = (async () => {
      publish({ phase: 'closing', attempts: 0, error: null });
      if (!state.killAccepted) {
        try {
          const result = await requestKill(sessionId);
          publish({ killAccepted: result?.ok === true });
        } catch (error) { publish({ error: error.message }); }
      }
      let failures = 0;
      for (let attempt = 1; attempt <= maxAttempts; attempt++) {
        try {
          const result = await readStatus(sessionId);
          if (result?.data) onOutput(result.data);
          const evidence = terminalExitEvidence(result);
          if (evidence) { publish({ phase: 'confirmed', evidence, attempts: attempt, error: null }); return true; }
          if (result?.error === 'Session not found' || result?.unknown === true || result?.status === 'unknown') {
            publish({ phase: 'unknown', attempts: attempt, error: '세션이 조회되지 않지만 실행 종료는 확인되지 않았습니다.' });
            return false;
          }
          if (result?.error) throw new Error(result.error);
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
