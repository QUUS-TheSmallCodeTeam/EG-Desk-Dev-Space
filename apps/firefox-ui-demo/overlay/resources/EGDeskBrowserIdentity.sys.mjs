// EG-Desk's browser authority context is not an Engine or site-account login.
// This module deliberately moves no cookies and makes no login claim.

const IDENTITY_TOPICS = [
  'contextual-identity-created',
  'contextual-identity-updated',
  'contextual-identity-deleted',
  'contextual-identity-reordered',
  'contextual-identity-service-load-finished',
];

function validUserContextId(value) {
  return Number.isSafeInteger(value) && value >= 0 && value < 0xffffffff;
}

function sameFrame(left, right) {
  return left && right && ['x', 'y', 'width', 'height'].every((key) =>
    Number.isFinite(left[key]) && left[key] === right[key]) &&
    left.width > 0 && left.height > 0;
}

function safeHttpUrl(value) {
  if (typeof value !== 'string' || /[\u0000-\u0020\u007f]/.test(value)) return false;
  try {
    const parsed = new URL(value);
    return ['http:', 'https:'].includes(parsed.protocol) && !parsed.username && !parsed.password;
  } catch {
    return false;
  }
}

function nativeParts() {
  try {
    if (typeof globalThis.ChromeUtils?.importESModule !== 'function') return {};
    return {
      identityService: globalThis.ChromeUtils.importESModule('resource://gre/modules/ContextualIdentityService.sys.mjs')
        .ContextualIdentityService,
      services: globalThis.Services,
    };
  } catch {
    return {};
  }
}

/** Set the container on a new XUL browser before it is appended to the DOM. */
export function configureBrowser(browser, userContextId) {
  if (!validUserContextId(userContextId) || !browser || browser.isConnected || browser.browsingContext ||
      typeof browser.setAttribute !== 'function' || typeof browser.removeAttribute !== 'function') {
    throw new TypeError('A detached browser and valid userContextId are required');
  }
  browser.setAttribute('type', 'content');
  if (userContextId === 0) browser.removeAttribute('usercontextid');
  else browser.setAttribute('usercontextid', String(userContextId));
  if (browserUserContextId(browser) !== userContextId) {
    throw new Error('Browser container attribute did not take effect');
  }
  return browser;
}

export function browserUserContextId(browser) {
  if (!browser || typeof browser.getAttribute !== 'function') return null;
  const raw = browser.getAttribute('usercontextid');
  if (raw !== null && raw !== '' && !/^\d+$/.test(raw)) return null;
  const attributeId = raw === null || raw === '' ? 0 : Number(raw);
  if (!validUserContextId(attributeId)) return null;
  const originId = browser.browsingContext?.originAttributes?.userContextId;
  if (originId !== undefined && originId !== attributeId) return null;
  return attributeId;
}

/** Pass this userContextId to openWebLinkIn or configureBrowser for native popups. */
export function popupContextOptions(openerBrowser) {
  const userContextId = browserUserContextId(openerBrowser);
  if (userContextId === null) throw new Error('Popup opener container is unverified');
  return { userContextId };
}

/**
 * lifecycle is supplied by the Card UI, not inferred from the selected tab:
 * snapshot(cardId) -> synchronous {cardId,browser,userContextId,frame,revision}.
 * revision must change on navigation/rebind/input changes observed by the UI.
 * inspectForm(browser) -> 'clean'|'entered'|'unknown' (no field values)
 * createCandidate(), mountCandidate(), watchCandidate(), replaceInner(),
 * restoreInner(), discardCandidate(), retireOriginal(), warnEnteredForm().
 * watchCandidate() installs its listener before load and returns {ready, dispose};
 * ready resolves true only for this candidate's successful native navigation.
 * replaceInner/restoreInner are synchronous compare-and-swap hooks. They must
 * preserve the outer Card/frame and keep original alive until retireOriginal.
 * switchCardContext({cardId, expectedBrowser, expectedRevision,
 *   targetUserContextId, explicitUserRequest:true, signal?}) never targets the
 * selected global tab. createCandidate returns a detached element; mountCandidate
 * stages it in the same private-window context without replacing original.
 * retireOriginal/discardCandidate destroy the owned old/staged browsing context;
 * retireOriginal resolves true after confirmed disposal. Await stop() on teardown
 * and inspect its status before removing the UI. Failed staged disposal remains
 * owned in cleanupState(); retryCleanup() retries only those owned candidates.
 * discardCandidate must finish destruction and detach the browser; rejection,
 * explicit false, or a still-connected candidate is not cleanup confirmation.
 * Native API reference (interface use only; no Mozilla implementation copied):
 * https://firefox-source-docs.mozilla.org/browser/components/tabbrowser/docs/opening-tabs.html
 */
export function createBrowserIdentityAdapter({ identityService, services, lifecycle } = {}) {
  const native = identityService === undefined && services === undefined ? nativeParts() : {};
  const service = identityService ?? native.identityService;
  const gecko = services ?? native.services;
  const mode = identityService !== undefined || services !== undefined ? 'injected' :
    service && gecko ? 'gecko-native' : 'unavailable';
  let onChange = null;
  let observing = false;
  let closed = false;
  let epoch = 0;
  const switches = new Map();
  const pendingSwitches = new Set();
  const pendingCleanup = new Map();
  let cleanupSequence = 0;

  function cleanupState() {
    return [...pendingCleanup.values()].map(({ id, cardId, attempts, error, pending }) => ({
      id, cardId, status: pending ? 'cleaning' : 'cleanup-required', attempts, error,
    }));
  }

  function discardOwnedCandidate(record) {
    if (record.pending) return record.pending;
    record.pending = Promise.resolve().then(async () => {
      try {
        const current = lifecycle.snapshot(record.cardId);
        if (current?.then || current?.browser === record.candidate) {
          throw new Error('Candidate may be active; restore its Card binding before cleanup');
        }
        record.attempts++;
        const receipt = await lifecycle.discardCandidate(record.candidate);
        if (receipt === false || record.candidate.isConnected !== false) {
          throw new Error('Candidate disposal is not confirmed');
        }
        pendingCleanup.delete(record.id);
        return true;
      } catch (error) {
        record.error = String(error?.message || error).slice(0, 500);
        return false;
      } finally { record.pending = null; }
    });
    return record.pending;
  }

  async function retryCleanup({ cleanupId, cardId } = {}) {
    const records = [...pendingCleanup.values()].filter(record =>
      (!cleanupId || record.id === cleanupId) && (!cardId || record.cardId === cardId));
    await Promise.all(records.map(discardOwnedCandidate));
    return { status: pendingCleanup.size ? 'cleanup-required' : 'cleaned', pendingCleanup: cleanupState() };
  }

  function supported() {
    try {
      return typeof service?.getPublicIdentities === 'function' &&
        typeof service?.create === 'function' &&
        gecko?.prefs?.getBoolPref('privacy.userContext.enabled', false) === true;
    } catch {
      return false;
    }
  }

  function listContainers() {
    if (!supported()) return { supported: false, mode, containers: [] };
    try {
      const publicIdentities = service.getPublicIdentities();
      if (!Array.isArray(publicIdentities)) throw new Error('Native identity list unavailable');
      const containers = [{ userContextId: 0, name: null, icon: null, color: null,
        kind: 'default' }];
      for (const identity of publicIdentities) {
        if (!identity?.public || !validUserContextId(identity.userContextId) ||
            identity.userContextId === 0) continue;
        containers.push({
          userContextId: identity.userContextId,
          name: typeof identity.name === 'string' ? identity.name :
            service.getUserContextLabel?.(identity.userContextId) ?? null,
          icon: typeof identity.icon === 'string' ? identity.icon : null,
          color: typeof identity.color === 'string' ? identity.color : null,
          kind: 'container',
        });
      }
      return { supported: true, mode, containers };
    } catch {
      return { supported: false, mode, containers: [] };
    }
  }

  function observe(subject, topic) {
    if (!observing || !IDENTITY_TOPICS.includes(topic)) return;
    // Do not retain the observer subject: it can carry profile-local details.
    try { onChange?.({ topic, ...listContainers() }); } catch { /* UI listener is isolated */ }
  }
  const observer = { observe };

  function start(listener = null) {
    if (listener !== null && typeof listener !== 'function') {
      throw new TypeError('Container listener must be a function');
    }
    closed = false;
    onChange = listener;
    if (supported() && !observing && gecko?.obs?.addObserver && gecko?.obs?.removeObserver) {
      const attached = [];
      try {
        for (const topic of IDENTITY_TOPICS) {
          gecko.obs.addObserver(observer, topic);
          attached.push(topic);
        }
        observing = true;
      } catch {
        for (const topic of attached) {
          try { gecko.obs.removeObserver(observer, topic); } catch { /* best effort */ }
        }
      }
    }
    return { ...listContainers(), observing };
  }

  function stop() {
    closed = true;
    epoch += 1;
    const pending = [...pendingSwitches];
    for (const token of pending) token.cancel();
    switches.clear();
    if (observing) {
      for (const topic of IDENTITY_TOPICS) {
        try { gecko.obs.removeObserver(observer, topic); } catch { /* observer may be gone */ }
      }
    }
    observing = false;
    onChange = null;
    return Promise.all(pending.map((token) => token.done)).then(() => ({
      status: pendingCleanup.size ? 'cleanup-required' : 'stopped', pendingCleanup: cleanupState(),
    }));
  }

  function createContainer({ name, icon, color, explicitUserRequest } = {}) {
    if (explicitUserRequest !== true) return { status: 'denied', reason: 'explicit-user-request-required' };
    if (closed) return { status: 'unavailable' };
    if (!supported()) return { status: 'unsupported' };
    const existing = listContainers().containers;
    const validIcon = typeof service.getContainerIconURL === 'function' ?
      service.getContainerIconURL(icon) != null : existing.some((item) => item.icon === icon);
    const validColor = typeof service.getContainerColorCode === 'function' ?
      service.getContainerColorCode(color) != null : existing.some((item) => item.color === color);
    if (typeof name !== 'string' || !name.trim() || name.length > 64 ||
        typeof icon !== 'string' || typeof color !== 'string' ||
        !validIcon || !validColor) {
      return { status: 'invalid-container' };
    }
    const created = service.create(name.trim(), icon, color);
    const listed = listContainers();
    const container = listed.containers.find((item) => item.userContextId === created?.userContextId);
    return container ? { status: 'created', container } : { status: 'unverified' };
  }

  function requiredLifecycle() {
    return ['snapshot', 'inspectForm', 'createCandidate', 'mountCandidate',
      'watchCandidate', 'replaceInner', 'restoreInner', 'discardCandidate',
      'retireOriginal', 'warnEnteredForm']
      .every((name) => typeof lifecycle?.[name] === 'function');
  }

  async function switchCardContext({ cardId, expectedBrowser, expectedRevision,
    targetUserContextId, explicitUserRequest, signal } = {}) {
    if (explicitUserRequest !== true) return { status: 'denied', reason: 'explicit-user-request-required' };
    const remainingCleanup = cleanupState().filter(record => record.cardId === cardId);
    if (remainingCleanup.length) return { status: 'cleanup-required', cardId, pendingCleanup: remainingCleanup };
    if (closed) return { status: 'unavailable' };
    if (!supported() || !requiredLifecycle() ||
        !listContainers().containers.some((item) => item.userContextId === targetUserContextId)) {
      return { status: 'unsupported' };
    }
    if (signal?.aborted) return { status: 'cancelled' };
    let cancelWait;
    let finish;
    const cancellation = new Promise((resolve) => { cancelWait = resolve; });
    const token = { cancel() { cancelWait(false); },
      done: new Promise((resolve) => { finish = resolve; }) };
    const switchEpoch = epoch;
    switches.get(cardId)?.cancel();
    switches.set(cardId, token);
    pendingSwitches.add(token);
    signal?.addEventListener('abort', token.cancel, { once: true });
    const cancelled = () => signal?.aborted || epoch !== switchEpoch || switches.get(cardId) !== token;
    try {
      const raw = lifecycle.snapshot(cardId);
      if (!raw || raw.then || raw.browser !== expectedBrowser || raw.revision !== expectedRevision) {
        return { status: 'stale-original' };
      }
      const before = { ...raw, frame: { ...raw.frame } };
      const original = before?.browser;
      const currentUrl = original?.currentURI?.spec;
      if (!before || before.cardId !== cardId || !original ||
          original.isConnected !== true || !original.browsingContext ||
          !['string', 'number'].includes(typeof before.revision) ||
          !validUserContextId(before.userContextId) ||
          browserUserContextId(original) !== before.userContextId ||
          !safeHttpUrl(currentUrl) || !sameFrame(before.frame, before.frame)) {
        return { status: 'unsupported' };
      }
      if (before.userContextId === targetUserContextId) return { status: 'unchanged' };
      const formState = await lifecycle.inspectForm(original);
      if (formState === 'entered') {
        await lifecycle.warnEnteredForm?.({ cardId });
        return { status: 'blocked', reason: 'entered-form' };
      }
      if (formState !== 'clean') return { status: 'blocked', reason: 'form-inspection-unavailable' };
      if (cancelled()) return { status: 'cancelled' };

      const securityManager = gecko?.scriptSecurityManager;
      if (typeof securityManager?.createNullPrincipal !== 'function' ||
          typeof gecko?.io?.newURI !== 'function') return { status: 'unsupported' };
      const privateBrowsingId = original.browsingContext?.originAttributes?.privateBrowsingId ?? 0;
      const triggeringPrincipal = securityManager.createNullPrincipal({
        userContextId: targetUserContextId, privateBrowsingId,
      });
      if (!triggeringPrincipal || triggeringPrincipal.isSystemPrincipal === true ||
          triggeringPrincipal.isNullPrincipal !== true ||
          securityManager.getSystemPrincipal?.() === triggeringPrincipal) {
        return { status: 'unsupported' };
      }
      const uri = gecko.io.newURI(currentUrl);
      if (uri?.spec !== currentUrl) return { status: 'unsupported' };

      function originalMatches() {
        const now = lifecycle.snapshot(cardId);
        return now && !now.then && now.cardId === cardId && now.browser === original &&
          now.revision === before.revision && sameFrame(before.frame, now.frame) &&
          original.currentURI?.spec === currentUrl &&
          browserUserContextId(original) === before.userContextId;
      }

      let candidate;
      let candidateOwned = false;
      let watcher;
      let committed = false;
      function restoreCandidate() {
        try {
          if (lifecycle.snapshot(cardId)?.browser !== candidate) return true;
          const restored = lifecycle.restoreInner({ cardId, original, candidate,
            expectedBrowser: candidate, frame: { ...before.frame } });
          if (restored?.then) return false;
          const state = lifecycle.snapshot(cardId);
          return state?.browser === original && sameFrame(before.frame, state.frame);
        } catch { return false; }
      }
      try {
        if (!originalMatches()) return { status: 'stale-original' };
        candidate = await lifecycle.createCandidate({ cardId });
        if (!candidate || candidate === original || candidate.isConnected !== false ||
            candidate.browsingContext || typeof candidate.loadURI !== 'function') {
          return { status: 'unsupported' };
        }
        candidateOwned = true;
        if (cancelled()) return { status: 'cancelled' };
        configureBrowser(candidate, targetUserContextId);
        await lifecycle.mountCandidate({ cardId, browser: candidate });
        if (cancelled()) return { status: 'cancelled' };
        if (!originalMatches()) return { status: 'stale-original' };
        if (!supported() || !listContainers().containers.some((item) => item.userContextId === targetUserContextId)) {
          return { status: 'unsupported' };
        }
        if (!candidate.browsingContext || browserUserContextId(candidate) !== targetUserContextId ||
            (candidate.browsingContext.originAttributes?.privateBrowsingId ?? 0) !== privateBrowsingId) {
          return { status: 'unsupported' };
        }
        watcher = lifecycle.watchCandidate({ cardId, browser: candidate, url: currentUrl, signal });
        if (!watcher?.ready?.then || typeof watcher.dispose !== 'function') return { status: 'unsupported' };
        // Attach a rejection handler before the load, including a synchronous load failure.
        const ready = Promise.resolve(watcher.ready).catch(() => false);
        // This is the exact current web URL, not a trusted chrome navigation or
        // a replay of an unknown POST/history entry.
        candidate.loadURI(uri, { triggeringPrincipal });
        const loaded = await Promise.race([ready, cancellation]);
        if (cancelled()) return { status: 'cancelled' };
        if (loaded !== true) return { status: 'unavailable' };
        if (!originalMatches()) return { status: 'stale-original' };
        const finalFormState = await lifecycle.inspectForm(original);
        if (finalFormState === 'entered') {
          await lifecycle.warnEnteredForm?.({ cardId });
          return { status: 'blocked', reason: 'entered-form' };
        }
        if (finalFormState !== 'clean') {
          return { status: 'blocked', reason: 'form-inspection-unavailable' };
        }
        if (cancelled()) return { status: 'cancelled' };
        if (!originalMatches()) return { status: 'stale-original' };
        if (!supported() || !listContainers().containers.some((item) => item.userContextId === targetUserContextId)) {
          return { status: 'unsupported' };
        }
        const swap = lifecycle.replaceInner({ cardId, expectedBrowser: original,
          candidate, expectedRevision: before.revision });
        if (swap?.then || swap !== true) {
          committed = !restoreCandidate();
          if (committed) return { status: 'recovery-required' };
          return { status: 'unavailable' };
        }
        committed = true;
        const after = lifecycle.snapshot(cardId);
        if (after?.cardId !== cardId || after.browser !== candidate ||
            !sameFrame(before.frame, after.frame) ||
            browserUserContextId(candidate) !== targetUserContextId) {
          committed = !restoreCandidate();
          return { status: committed ? 'recovery-required' : 'invariant-failed' };
        }
        let cleanup = 'confirmed';
        try {
          if (await lifecycle.retireOriginal(original) !== true) cleanup = 'unconfirmed';
        } catch { cleanup = 'unconfirmed'; }
        if (cleanup !== 'confirmed') return { status: 'switched-cleanup-required', cardId,
          fromUserContextId: before.userContextId, toUserContextId: targetUserContextId,
          siteAccount: 'unverified' };
        return { status: 'switched', cardId, fromUserContextId: before.userContextId,
          toUserContextId: targetUserContextId, siteAccount: 'unverified' };
      } catch {
        if (candidateOwned) committed = !restoreCandidate();
        if (committed) return { status: 'recovery-required' };
        return { status: 'unavailable' };
      } finally {
        try { watcher?.dispose(); } catch { /* disposal does not imply load success */ }
        if (candidateOwned && !committed) {
          const record = { id: `candidate-cleanup-${++cleanupSequence}`, cardId, candidate,
            attempts: 0, error: null, pending: null };
          pendingCleanup.set(record.id, record);
          if (!(await discardOwnedCandidate(record))) {
            // Override cancelled/unavailable: the hidden runtime is still owned
            // and must not disappear from tracking when this switch finishes.
            return { status: 'cleanup-required', cardId, cleanupId: record.id, pendingCleanup: cleanupState() };
          }
        }
      }
    } finally {
      signal?.removeEventListener('abort', token.cancel);
      if (switches.get(cardId) === token) switches.delete(cardId);
      pendingSwitches.delete(token);
      finish();
    }
  }

  return { mode, supported, start, stop, cleanupState, retryCleanup, listContainers, createContainer,
    switchCardContext, configureBrowser, popupContextOptions };
}
