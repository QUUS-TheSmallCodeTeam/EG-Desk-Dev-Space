import { MASK_COLOR, SCREENSHOT_DEFAULTS, encodeAttempts, fitsBudget, scaleMasks, screenshotDecision } from "./EGDeskScreenshotMask.sys.mjs";

// System modules are per-process singletons. The chrome overlay explicitly
// registers only its own Browser Card elements; content cannot mint a handler.
const browserAuthorizers = new Map();

function sameNativeNode(left, right) {
  if (!left || !right) return false;
  if (left === right) return true;
  try { return left.isSameNode?.(right) === true && right.isSameNode?.(left) === true; }
  catch { return false; }
}

function registeredChromeBrowser(browser, ownerWindow) {
  const document = browser?.ownerDocument;
  const chromeWindow = document?.defaultView;
  const card = browser?.closest?.('.egd-browser-card');
  return browser?.localName === 'browser' && browser.isConnected && card?.isConnected &&
    document?.nodePrincipal?.isSystemPrincipal === true &&
    chromeWindow?.document?.nodePrincipal?.isSystemPrincipal === true &&
    ownerWindow?.document?.nodePrincipal?.isSystemPrincipal === true &&
    sameNativeNode(document, chromeWindow.document) &&
    sameNativeNode(document, ownerWindow.document) &&
    Number.isSafeInteger(browser.browsingContext?.id) && browser.browsingContext.id > 0;
}

export function registerBrowserActionAuthorizer(browser, ownerWindow, authorize) {
  if (typeof authorize !== 'function' || !registeredChromeBrowser(browser, ownerWindow)) {
    throw new TypeError('Browser authorizer requires one connected chrome-owned Browser Card');
  }
  const contextId = browser.browsingContext.id;
  const existing = browserAuthorizers.get(contextId);
  if (existing && existing.browser.isConnected) throw new Error('Browser authorizer is already registered');
  if (existing) existing.dispose();
  const registration = { browser, ownerWindow, authorize, contextId, dispose: null };
  const dispose = () => {
    if (browserAuthorizers.get(contextId) === registration) browserAuthorizers.delete(contextId);
    try { ownerWindow.removeEventListener('unload', dispose); } catch {}
  };
  registration.dispose = dispose;
  browserAuthorizers.set(contextId, registration);
  try { ownerWindow.addEventListener('unload', dispose, { once: true }); }
  catch { dispose(); throw new TypeError('Browser authorizer owner window is unavailable'); }
  return dispose;
}

// Pure receipt filter for the chrome toolAct path: copies only the fixed,
// non-content route fields a guarded scroll/press/fill actor reports. Anything
// unexpected yields no route, so the helper reports the action unverified.
// Fill fields describe the event order only; the value is proven by readback.
const RECEIPT_KEYS = new Set(["Enter", "Escape", "Tab", "ArrowUp", "ArrowDown", "ArrowLeft",
  "ArrowRight", "Backspace", "Space"]);
const FILL_ROUTES = new Set(["dom-value-setter", "dom-editor-replace"]);
const FILL_EVENTS = new Set(["beforeinput", "input", "change"]);
export function browserToolDispatchReceiptFields(actionType, diagnostics) {
  if (!diagnostics || typeof diagnostics !== "object" || Array.isArray(diagnostics)) return {};
  if (actionType === "fill") {
    const order = diagnostics.eventOrder;
    if (!FILL_ROUTES.has(diagnostics.inputRoute) || diagnostics.trustedInput !== false ||
        !Array.isArray(order) || order.length > 3 || !order.every(name => FILL_EVENTS.has(name))) return {};
    return { inputRoute: diagnostics.inputRoute, trustedInput: false, eventOrder: [...order],
      beforeInputCanceled: typeof diagnostics.beforeInputCanceled === "boolean" ? diagnostics.beforeInputCanceled : null,
      egdeskWroteContent: diagnostics.egdeskWroteContent === true,
      readbackMatches: diagnostics.readbackMatches === true };
  }
  if (actionType === "scroll") {
    if (diagnostics.inputRoute !== "dom-scroll-api" || !["document", "into-view", "container"].includes(diagnostics.mode)) return {};
    if (diagnostics.mode === "container") {
      // Integer offsets of the observed scroll container, before and after.
      const position = value => value && typeof value === "object" && !Array.isArray(value) &&
        ["x", "y", "maxY"].every(key => Number.isSafeInteger(value[key]) && value[key] >= 0)
        ? { x: value.x, y: value.y, maxY: value.maxY } : null;
      const before = position(diagnostics.containerBefore), after = position(diagnostics.containerAfter);
      if (!before || !after) return {};
      return { inputRoute: "dom-scroll-api", scrollMode: "container", containerScroll: { before, after } };
    }
    return { inputRoute: "dom-scroll-api", scrollMode: diagnostics.mode,
      ...(diagnostics.mode === "into-view" ? { targetInView: diagnostics.targetInView === true } : {}) };
  }
  if (actionType === "press") {
    if (diagnostics.inputRoute !== "dom-keyboard-event" || diagnostics.trustedInput !== false ||
        !RECEIPT_KEYS.has(diagnostics.key) ||
        !["already-focused", "after-fill"].includes(diagnostics.focusPolicy)) return {};
    return { inputRoute: "dom-keyboard-event", key: diagnostics.key, trustedInput: false,
      targetKeyObserved: diagnostics.targetKeyObserved === true,
      keydownDefaultPrevented: diagnostics.keydownDefaultPrevented === true,
      defaultActionEmulated: ["default-button-click", "form-request-submit"].includes(diagnostics.defaultActionEmulated)
        ? diagnostics.defaultActionEmulated : null,
      focusPolicy: diagnostics.focusPolicy };
  }
  return {};
}

// BRW-09 screenshot tickets: the chrome side asks for a screenshot only
// through this actor's own query (options.screenshot on a snapshot query),
// so the parent mints a one-time ticket there and the child must hand it
// back. A content process cannot start a capture on its own.
const SCREENSHOT_TICKET_MS = 60000;
// Covered boxes listed in a result; the count is always complete. Keeps the
// UI response inside the transport bound beside a 150000-character image.
const MAX_LISTED_MASKS = 60;
const XHTML_NS = "http://www.w3.org/1999/xhtml";
function screenshotFormat(value) { return value === "png" ? { mime: "image/png", format: "png" } : { mime: "image/jpeg", format: "jpeg" }; }

function authorizerFor(browser, context) {
  const registration = browserAuthorizers.get(context?.id);
  if (!registration || !registeredChromeBrowser(registration.browser, registration.ownerWindow) ||
      !sameNativeNode(registration.browser, browser) ||
      browser?.browsingContext?.id !== registration.contextId) return null;
  return registration.authorize;
}

export class EGDeskBrowserAgentRuntimeParent extends JSWindowActorParent {
  // Chrome queries pass through here; a snapshot query that carries
  // options.screenshot gets a one-time ticket the child must return.
  sendQuery(name, data) {
    const send = super.sendQuery;
    if (typeof send !== "function") throw new TypeError("JSWindowActorParent.sendQuery is unavailable");
    return send.call(this, name, this.ticketedQuery(name, data));
  }

  ticketedQuery(name, data) {
    const spec = data?.options?.screenshot;
    if (name !== "snapshot" || !spec || typeof spec !== "object" || Array.isArray(spec)) return data;
    const ticket = globalThis.crypto?.randomUUID?.() || `${Date.now()}-${Math.random()}`;
    this.screenshotTickets ||= new Map();
    const now = Date.now();
    for (const [key, expiresAt] of this.screenshotTickets) if (expiresAt <= now) this.screenshotTickets.delete(key);
    this.screenshotTickets.set(ticket, now + SCREENSHOT_TICKET_MS);
    return { ...data, options: { ...data.options, screenshot: { ...spec, ticket } } };
  }

  takeScreenshotTicket(ticket) {
    const expiresAt = typeof ticket === "string" ? this.screenshotTickets?.get(ticket) : undefined;
    if (expiresAt === undefined) return false;
    this.screenshotTickets.delete(ticket);
    return expiresAt > Date.now();
  }

  // Captures the visible viewport of this top document, covers what the
  // child reports as sensitive or unread, and encodes within the budget.
  // Gecko API (parent process only; dom/chrome-webidl/WindowGlobalActors.webidl):
  //   WindowGlobalParent.drawSnapshot(DOMRect? rect, double scale,
  //     UTF8String backgroundColor, optional boolean resetScrollPosition)
  //     -> Promise<ImageBitmap>; rect null = the currently visible viewport,
  //     in CSS pixels times scale; works with local and remote frames.
  //   Reference use: toolkit/components/extensions/parent/ext-tabs-base.js
  //   (tabs.captureTab) and remote/shared/Capture.sys.mjs. Not run here
  //   (headless QA cannot capture; a real Firefox window is required).
  async captureScreenshot(data = {}) {
    if (!this.takeScreenshotTicket(data.ticket)) return { send: false, reason: "unauthorized" };
    const windowGlobal = this.manager;
    const context = this.browsingContext || windowGlobal?.browsingContext;
    if (!windowGlobal || typeof windowGlobal.drawSnapshot !== "function") return { send: false, reason: "capture-unsupported" };
    if (!context || (context.top && context.top !== context)) return { send: false, reason: "not-top-document" };
    const browser = context.top?.embedderElement || context.embedderElement;
    const ownerDocument = browser?.ownerDocument;
    if (!registeredChromeBrowser(browser, ownerDocument?.defaultView)) return { send: false, reason: "missing-embedder" };
    if (windowGlobal.isClosed === true || windowGlobal.isCurrentGlobal === false) return { send: false, reason: "document-changed" };
    const budgetChars = Number.isSafeInteger(data.budgetChars) && data.budgetChars > 0
      ? Math.min(data.budgetChars, SCREENSHOT_DEFAULTS.budgetChars) : SCREENSHOT_DEFAULTS.budgetChars;
    const maxEdge = Number.isSafeInteger(data.maxEdge) && data.maxEdge > 0
      ? Math.min(data.maxEdge, SCREENSHOT_DEFAULTS.maxEdge) : SCREENSHOT_DEFAULTS.maxEdge;
    const { mime, format } = screenshotFormat(data.format);
    let before;
    try { before = await this.sendQuery("screenshotMask", {}); } catch { return { send: false, reason: "mask-unavailable" }; }
    if (Number.isSafeInteger(before?.innerWindowId) && Number.isSafeInteger(windowGlobal.innerWindowId) &&
        before.innerWindowId !== windowGlobal.innerWindowId) return { send: false, reason: "document-changed" };
    let image;
    // Scale 1: one capture pixel per CSS pixel, so the child's boxes map
    // directly; the decision re-measures the mapping from the bitmap size.
    try { image = await windowGlobal.drawSnapshot(null, 1, "white"); } catch { return { send: false, reason: "capture-failed" }; }
    try {
      if (windowGlobal.isClosed === true || windowGlobal.isCurrentGlobal === false) return { send: false, reason: "document-changed" };
      let after;
      try { after = await this.sendQuery("screenshotMask", {}); } catch { return { send: false, reason: "mask-unavailable" }; }
      const capture = { width: image.width, height: image.height };
      const decision = screenshotDecision({ before, after, image: capture });
      if (!decision.send) return { send: false, reason: decision.reason };
      const canvas = ownerDocument.createElementNS(XHTML_NS, "canvas");
      for (const attempt of encodeAttempts({ ...capture, maxEdge, quality: data.quality })) {
        const masks = scaleMasks(decision.masks, capture, attempt);
        if (!masks) return { send: false, reason: "mask-unavailable" };
        canvas.width = attempt.width;
        canvas.height = attempt.height;
        const ctx = canvas.getContext("2d", { alpha: false });
        if (!ctx) return { send: false, reason: "capture-unsupported" };
        ctx.drawImage(image, 0, 0, attempt.width, attempt.height);
        ctx.fillStyle = MASK_COLOR;
        for (const mask of masks) ctx.fillRect(mask.x, mask.y, mask.width, mask.height);
        const dataUrl = canvas.toDataURL(mime, attempt.quality);
        if (!fitsBudget(dataUrl, budgetChars)) continue;
        return { send: true, imageUrl: dataUrl, format, width: attempt.width, height: attempt.height,
          // CSS pixel = image pixel / imageScale. Pixels are never input coordinates.
          imageScale: Math.round(decision.imageScale * attempt.factor * 1000) / 1000,
          maskedRegions: decision.maskedRegions.slice(0, MAX_LISTED_MASKS), maskCount: decision.maskedRegions.length,
          ...(decision.maskedRegions.length > MAX_LISTED_MASKS ? { maskedRegionsTruncated: true } : {}),
          documentId: decision.documentId, revision: decision.revision,
          ...(Object.hasOwn(decision, "innerWindowId") ? { innerWindowId: decision.innerWindowId } : {}) };
      }
      return { send: false, reason: "image-too-large" };
    } finally { try { image.close?.(); } catch {} }
  }

  receiveMessage(message) {
    if (message.name === "captureScreenshot") return this.captureScreenshot(message.data || {});
    if (message.name !== "authorizeAct") throw new Error("Unsupported Browser actor parent message");
    const context = this.browsingContext || this.manager?.browsingContext;
    if (!context) return { authorized: false, reason: "missing-browsing-context" };
    const browser = context?.top?.embedderElement || context?.embedderElement;
    if (!browser) return { authorized: false, reason: "missing-embedder" };
    const authorize = authorizerFor(browser, context);
    if (!authorize) return { authorized: false, reason: "missing-authorizer" };
    try {
      // Native Gecko document identities go last so child data cannot
      // replace them; the UI compares them with the observed guard (REA 웹4).
      const authorized = authorize({ ...message.data, browser,
        browsingContext: context, windowGlobal: this.manager,
        innerWindowId: this.manager?.innerWindowId ?? null, browsingContextId: context.id ?? null }) === true;
      return { authorized, reason: authorized ? "approved" : "ui-denied" };
    } catch { return { authorized: false, reason: "parent-callback-error" }; }
  }
}
