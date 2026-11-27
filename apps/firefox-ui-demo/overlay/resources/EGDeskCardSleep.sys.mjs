// L42 (round d, temporary name; flag egdesk.perf.sleepHiddenCards, default off).
// A Browser card whose page is off the screen or shown very small is put to sleep: Firefox treats an inactive
// <browser> like a background tab (timers throttled, requestAnimationFrame and painting stopped). Nothing here
// draws UI or text. The decision is pure so it can be tested without Firefox.

export const SLEEP_BELOW = Object.freeze({ width: 560, height: 350 }); // visible part on screen, in CSS px
export const WAKE_AT = Object.freeze({ width: 640, height: 400 });     // larger than SLEEP_BELOW: hysteresis
export const SLEEP_DELAY_MS = 2000;
export const WAKE_DELAY_MS = 300;
export const TICK_MS = 500;
export const TOOL_GRACE_MS = 10000;

export function visibleSize(rect, viewport) {
  if (!rect || !viewport) return { width: 0, height: 0 };
  const width = Math.min(rect.right, viewport.width) - Math.max(rect.left, 0);
  const height = Math.min(rect.bottom, viewport.height) - Math.max(rect.top, 0);
  return { width: Math.max(0, width), height: Math.max(0, height) };
}

// 'sleep' | 'wake' | 'keep': what the card's size/position asks for, given whether it sleeps now.
export function sleepVerdict({ rect, viewport, asleep }) {
  const v = visibleSize(rect, viewport);
  if (asleep) return v.width >= WAKE_AT.width && v.height >= WAKE_AT.height ? 'wake' : 'keep';
  return v.width < SLEEP_BELOW.width || v.height < SLEEP_BELOW.height ? 'sleep' : 'keep';
}

// Firefox switches: docShellIsActive (BrowsingContext.isActive: timers/rAF/visibility) and renderLayers (painting).
export function setBrowserAwake(browser, awake) {
  if (!browser || typeof browser.docShellIsActive !== 'boolean') return false;
  try {
    if (awake) { browser.renderLayers = true; browser.docShellIsActive = true; }
    else { browser.docShellIsActive = false; browser.renderLayers = false; }
    return true;
  } catch { return false; }
}

// cards(): [{ id, rect, excluded(): boolean, setAwake(boolean) }]
export function createCardSleeper({ cards, viewport, now = () => Date.now() }) {
  const known = new Map(); // id -> { asleep, since, verdict }
  const wake = (id, entry, card) => { if (entry.asleep) { entry.asleep = false; try { card.setAwake(true); } catch {} } entry.since = 0; entry.verdict = 'keep'; };
  return {
    tick() {
      const list = cards() || [], t = now(), vp = viewport();
      const live = new Set();
      for (const card of list) {
        live.add(card.id);
        const entry = known.get(card.id) || { asleep: false, since: 0, verdict: 'keep' };
        known.set(card.id, entry);
        if (card.excluded()) { wake(card.id, entry, card); continue; }
        const verdict = sleepVerdict({ rect: card.rect(), viewport: vp, asleep: entry.asleep });
        if (verdict === 'keep') { entry.since = 0; entry.verdict = 'keep'; continue; }
        if (entry.verdict !== verdict) { entry.verdict = verdict; entry.since = t; }
        const need = verdict === 'sleep' ? SLEEP_DELAY_MS : WAKE_DELAY_MS;
        if (t - entry.since < need) continue;
        if (verdict === 'sleep') { entry.asleep = true; try { card.setAwake(false); } catch {} }
        else wake(card.id, entry, card);
        entry.since = 0; entry.verdict = 'keep';
      }
      for (const id of [...known.keys()]) if (!live.has(id)) known.delete(id);
    },
    wakeNow(card) { const entry = known.get(card.id); if (entry) wake(card.id, entry, card); },
    isAsleep: (id) => known.get(id)?.asleep === true,
  };
}
