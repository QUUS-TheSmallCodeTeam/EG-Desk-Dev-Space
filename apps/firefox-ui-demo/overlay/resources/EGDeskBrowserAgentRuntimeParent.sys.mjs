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
    if (diagnostics.inputRoute !== "dom-scroll-api" || !["document", "into-view"].includes(diagnostics.mode)) return {};
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

function authorizerFor(browser, context) {
  const registration = browserAuthorizers.get(context?.id);
  if (!registration || !registeredChromeBrowser(registration.browser, registration.ownerWindow) ||
      !sameNativeNode(registration.browser, browser) ||
      browser?.browsingContext?.id !== registration.contextId) return null;
  return registration.authorize;
}

export class EGDeskBrowserAgentRuntimeParent extends JSWindowActorParent {
  receiveMessage(message) {
    if (message.name !== "authorizeAct") throw new Error("Unsupported Browser actor parent message");
    const context = this.browsingContext || this.manager?.browsingContext;
    if (!context) return { authorized: false, reason: "missing-browsing-context" };
    const browser = context?.top?.embedderElement || context?.embedderElement;
    if (!browser) return { authorized: false, reason: "missing-embedder" };
    const authorize = authorizerFor(browser, context);
    if (!authorize) return { authorized: false, reason: "missing-authorizer" };
    try {
      const authorized = authorize({ ...message.data, browser,
        browsingContext: context, windowGlobal: this.manager }) === true;
      return { authorized, reason: authorized ? "approved" : "ui-denied" };
    } catch { return { authorized: false, reason: "parent-callback-error" }; }
  }
}
