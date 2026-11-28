// L42 (round d, temporary name; flag egdesk.perf.sleepHiddenCards, default off).
// A Browser card whose page is off the screen or shown very small is put to sleep: Firefox treats an inactive
// <browser> like a background tab (timers throttled, requestAnimationFrame and painting stopped). Nothing here
// draws UI or text. The decision is pure so it can be tested without Firefox.

export const SLEEP_BELOW = Object.freeze({ width: 560, height: 350 }); // visible part on screen, in CSS px
export const WAKE_AT = Object.freeze({ width: 640, height: 400 });     // larger than SLEEP_BELOW: hysteresis
// L48: size alone trapped a card that dominates the screen (1070x398 stayed asleep: 2 px under WAKE_AT.height).
// Dominance is the visible area as a fraction of the viewport; wake limit > sleep limit keeps hysteresis.
export const SLEEP_AREA_BELOW = 0.2;   // small AND under 20% of the viewport -> sleep
export const WAKE_AREA_AT = 0.25;      // 25% of the viewport or more -> wake, whatever the aspect ratio
// `scale` is the CANVAS zoom (state.zoom), not the browser element's own ratio: the page is scaled again inside the card
// (about 0.53x), so element width / offsetWidth reads ~0.2 at canvas zoom 0.376 and ~0.53 at 1.0. Below 0.5 the page is
// unreadable, so the card sleeps with its last frame shown; wake needs 0.58 (a wide band, zoom animates through it).
export const SLEEP_SCALE_BELOW = 0.5;
export const WAKE_SCALE_AT = 0.58;
export const CAPTURE_GRACE_MS = 6000;   // a card whose first snapshot keeps failing (not painted yet) stays awake this long, then sleeps blank
export const SLEEP_DELAY_MS = 2000;
export const WAKE_DELAY_MS = 300;
export const TICK_MS = 500;
export const TOOL_GRACE_MS = 10000;
export const FRAME_MAX_PIXELS = 1500000;   // snapshot budget per sleeping card
export const FRAME_REMOVE_DELAY_MS = 150;  // keep the frame until the live page has repainted

export function visibleSize(rect, viewport) {
  if (!rect || !viewport) return { width: 0, height: 0 };
  const width = Math.min(rect.right, viewport.width) - Math.max(rect.left, 0);
  const height = Math.min(rect.bottom, viewport.height) - Math.max(rect.top, 0);
  return { width: Math.max(0, width), height: Math.max(0, height) };
}

// scale: canvas zoom, or null/undefined when unknown (then ignored).
export function sleepVerdict({ rect, viewport, asleep, scale = null }) {
  const v = visibleSize(rect, viewport);
  const area = viewport && viewport.width > 0 && viewport.height > 0 ? (v.width * v.height) / (viewport.width * viewport.height) : 0;
  const known = typeof scale === 'number' && Number.isFinite(scale) && scale > 0;
  if (asleep) {
    const readable = !known || scale >= WAKE_SCALE_AT;
    const big = (v.width >= WAKE_AT.width && v.height >= WAKE_AT.height) || area >= WAKE_AREA_AT;
    return readable && big ? 'wake' : 'keep';
  }
  if (known && scale < SLEEP_SCALE_BELOW) return 'sleep';
  const small = v.width < SLEEP_BELOW.width || v.height < SLEEP_BELOW.height;
  return small && area < SLEEP_AREA_BELOW ? 'sleep' : 'keep';
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

// ---- last-frame snapshot shown while a card sleeps (no text, no UI). All browser/DOM access is injected or duck-typed, so it is testable. ----
// Returns { bitmap, width, height } or { error: string } (then the card sleeps blank after CAPTURE_GRACE_MS of retries).
// rect null = the currently visible viewport of the top document, in CSS px times scale (Gecko WindowGlobalParent.drawSnapshot(DOMRect? ...)).
// DOMRect is an interface, not a dictionary: a plain {x,y,w,h} throws TypeError, so no rect is passed.
export async function captureSleepFrame(browser, { dpr = 1, maxPixels = FRAME_MAX_PIXELS } = {}) {
  try {
    const wgp = browser?.browsingContext?.currentWindowGlobal;
    const cw = browser?.clientWidth, ch = browser?.clientHeight; // layout px of the page area
    if (!wgp || typeof wgp.drawSnapshot !== 'function') return { error: 'no-window-global' };
    if (!(cw > 0) || !(ch > 0)) return { error: 'no-size' };
    if (browser.webProgress?.isLoadingDocument === true) return { error: 'loading' };
    const onScreen = browser.getBoundingClientRect();
    let scale = Math.min(1, (onScreen.width * dpr) / cw);
    scale = Math.min(scale, Math.sqrt(maxPixels / (cw * ch)));
    if (!(scale > 0.02)) return { error: 'scale-too-small' };
    const bitmap = await wgp.drawSnapshot(null, scale, 'white');
    if (!bitmap) return { error: 'empty-bitmap' };
    if (!(bitmap.width > 0) || !(bitmap.height > 0)) { try { bitmap.close?.(); } catch {} return { error: 'empty-bitmap' }; }
    return { bitmap, width: bitmap.width, height: bitmap.height };
  } catch (error) { return { error: String(error?.name || 'Error') + ': ' + String(error?.message || error).slice(0, 120) }; }
}

export function showSleepFrame(browser, frame) {
  try {
    const doc = browser.ownerDocument;
    removeSleepFrame(browser);
    const canvas = doc.createElementNS('http://www.w3.org/1999/xhtml', 'canvas');
    canvas.width = frame.width; canvas.height = frame.height;
    canvas.getContext('2d').drawImage(frame.bitmap, 0, 0);
    try { frame.bitmap.close?.(); } catch {}
    canvas.setAttribute('data-egd-sleep-frame', '');
    canvas.style.cssText = 'position:absolute;pointer-events:none;z-index:2;'
      + 'left:' + browser.offsetLeft + 'px;top:' + browser.offsetTop + 'px;width:' + browser.offsetWidth + 'px;height:' + browser.offsetHeight + 'px;';
    browser.parentNode.appendChild(canvas);
    browser._egdSleepFrame = canvas;
    return true;
  } catch (error) { try { frame.bitmap?.close?.(); } catch {} browser._egdSleepError = 'show: ' + String(error?.message || error).slice(0, 120); return false; }
}

export function removeSleepFrame(browser) {
  const canvas = browser?._egdSleepFrame;
  if (!canvas) return false;
  browser._egdSleepFrame = null;
  try { canvas.width = 0; canvas.height = 0; canvas.remove(); } catch {} // width 0 frees the backing store at once
  return true;
}

// Sleep = capture, show the frame, then deactivate. Wake = activate, then drop the frame after the page repainted.
export async function sleepBrowserWithFrame(browser, opts = {}) {
  const frame = await captureSleepFrame(browser, opts);
  if (frame.bitmap) {
    if (showSleepFrame(browser, frame)) { browser._egdSleepError = ''; return { framed: true }; }
    return { framed: false, error: browser._egdSleepError || 'show-failed' };
  }
  browser._egdSleepError = frame.error || 'unknown';
  return { framed: false, error: browser._egdSleepError };
}
export function wakeBrowserWithFrame(browser, { setTimer = (fn, ms) => setTimeout(fn, ms), delay = FRAME_REMOVE_DELAY_MS } = {}) {
  const canvas = browser?._egdSleepFrame;
  if (!canvas) return;
  try { setTimer(() => { if (browser._egdSleepFrame === canvas) removeSleepFrame(browser); }, delay); } catch { removeSleepFrame(browser); }
}

// cards(): [{ id, rect, scale?(), excluded(): boolean, setAwake(boolean), prepareSleep?(): Promise }]
// prepareSleep runs before the card is deactivated (snapshot); failure or a changed mind (woken/removed meanwhile) is handled here.
// onForget(id): a card that vanished while asleep (closed) -> release what was kept for it.
export function createCardSleeper({ cards, viewport, now = () => Date.now(), onForget = null }) {
  const known = new Map(); // id -> { asleep, since, verdict }
  const wake = (id, entry, card) => { entry.token = (entry.token || 0) + 1; entry.preparing = false; entry.failedAt = 0; if (entry.asleep) { entry.asleep = false; try { card.setAwake(true); } catch {} } entry.since = 0; entry.verdict = 'keep'; };
  return {
    tick() {
      const list = cards() || [], t = now(), vp = viewport();
      const live = new Set();
      for (const card of list) {
        live.add(card.id);
        const entry = known.get(card.id) || { asleep: false, since: 0, verdict: 'keep' };
        known.set(card.id, entry);
        if (card.excluded()) { wake(card.id, entry, card); continue; }
        const verdict = sleepVerdict({ rect: card.rect(), viewport: vp, asleep: entry.asleep, scale: card.scale ? card.scale() : null });
        if (entry.preparing) continue;
        if (verdict === 'keep') { entry.since = 0; entry.verdict = 'keep'; entry.failedAt = 0; continue; }
        if (entry.verdict !== verdict) { entry.verdict = verdict; entry.since = t; }
        const need = verdict === 'sleep' ? SLEEP_DELAY_MS : WAKE_DELAY_MS;
        if (t - entry.since < need) continue;
        if (verdict === 'sleep') {
          const doSleep = () => { entry.asleep = true; try { card.setAwake(false); } catch {} };
          if (typeof card.prepareSleep === 'function') {
            const token = entry.token = (entry.token || 0) + 1; entry.preparing = true;
            const finish = (r) => {
              if (entry.token !== token || known.get(card.id) !== entry) return;
              entry.preparing = false;
              if (r && r.framed === false) { // not painted yet or capture failed: stay awake and retry on the next tick, up to CAPTURE_GRACE_MS
                entry.failedAt = entry.failedAt || now();
                if (now() - entry.failedAt < CAPTURE_GRACE_MS) { entry.verdict = 'sleep'; entry.since = -Infinity; return; }
              }
              entry.failedAt = 0; doSleep();
            };
            let p; try { p = Promise.resolve(card.prepareSleep()); } catch { p = Promise.resolve(); }
            p.then(finish, finish);
          } else doSleep();
        }
        else wake(card.id, entry, card);
        entry.since = 0; entry.verdict = 'keep';
      }
      for (const id of [...known.keys()]) if (!live.has(id)) { known.delete(id); if (onForget) { try { onForget(id); } catch {} } }
    },
    wakeNow(card) { const entry = known.get(card.id); if (entry) wake(card.id, entry, card); },
    isAsleep: (id) => known.get(id)?.asleep === true,
    states: () => [...known.entries()].map(([id, e]) => ({ id, asleep: e.asleep === true, preparing: e.preparing === true })),
  };
}
