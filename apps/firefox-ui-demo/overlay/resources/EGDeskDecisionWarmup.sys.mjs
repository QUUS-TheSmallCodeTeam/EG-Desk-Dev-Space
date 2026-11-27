// Idle warm-up of the Decisions endpoint, window half (L6 c18; pref egdesk.decisionWarmup "advisory" | "on", default off: nothing here runs).
// The bridge decides everything (egdesk-decision-warmup.mjs: whether a long idle has passed, whether a key is saved, what to send). This half
// only tells the bridge, at most once a minute, that the person has started typing in a chat composer, so that a warm-up request can land
// during the typing time instead of during the turn. The post carries a closed word and nothing else: no text, no thread, no card.
export const DECISION_WARMUP_PREF = 'egdesk.decisionWarmup';
export const DECISION_WARMUP_LIMITS = Object.freeze({ minGapMs: 60_000, waitMs: 2000 });
export const decisionWarmupMode = value => (value === 'advisory' || value === 'on' ? value : 'off');

/**
 * createComposerWarmup({ mode, post, now?, minGapMs? }) -> { note(hasText) }
 *   mode(): the pref value; post(path, body): resolves or rejects, never awaited here
 * note() is called from the composer's input listener. It posts only when the pref is not off, the composer holds text, and the last post
 * was at least minGapMs ago. It never throws and never delays typing.
 */
export function createComposerWarmup({ mode, post, now = () => Date.now(), minGapMs = DECISION_WARMUP_LIMITS.minGapMs } = {}) {
  let last = null;
  return Object.freeze({
    note(hasText = true) {
      try {
        if (hasText !== true || decisionWarmupMode(mode()) === 'off') return false;
        const t = now();
        if (last !== null && t - last < minGapMs) return false;
        last = t;
        Promise.resolve(post('/decision/warmup', { reason: 'composer' })).catch(() => {});
        return true;
      } catch { return false; }
    },
  });
}
