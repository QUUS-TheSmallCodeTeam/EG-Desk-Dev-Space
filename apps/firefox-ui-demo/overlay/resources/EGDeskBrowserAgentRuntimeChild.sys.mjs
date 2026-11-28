import { captureDocumentText } from './EGDeskInputContext.sys.mjs';
import { isSensitiveAutocomplete } from './EGDeskScreenshotMask.sys.mjs';
import { POINTER_MIN_REMAINING_MS, planPointerPress } from './EGDeskBrowserPointer.sys.mjs';

// Guarded key set. Events are synthetic (untrusted): Gecko runs no default
// action for them, so only Enter's implicit form submission is emulated.
const GUARDED_KEYS = Object.freeze({
  Enter: { key: "Enter", code: "Enter", keyCode: 13, charCode: 13 },
  Escape: { key: "Escape", code: "Escape", keyCode: 27 },
  Tab: { key: "Tab", code: "Tab", keyCode: 9 },
  ArrowUp: { key: "ArrowUp", code: "ArrowUp", keyCode: 38 },
  ArrowDown: { key: "ArrowDown", code: "ArrowDown", keyCode: 40 },
  ArrowLeft: { key: "ArrowLeft", code: "ArrowLeft", keyCode: 37 },
  ArrowRight: { key: "ArrowRight", code: "ArrowRight", keyCode: 39 },
  Backspace: { key: "Backspace", code: "Backspace", keyCode: 8 },
  Space: { key: " ", code: "Space", keyCode: 32, charCode: 32 },
});
// Input types that take part in HTML implicit submission.
const IMPLICIT_SUBMIT_TYPES = ["text", "search", "email", "url", "tel", "password", "date", "month",
  "week", "time", "datetime-local", "number"];
const MAX_WAIT_MS = 10000;
// Longest guarded fill text, and longest current value a guard can compare.
const MAX_FILL_TEXT = 8000;
// L57: the options of a list a snapshot carries (was 32: a time or year list lost its tail, choice.truncated says so). The helper offers the same number (MAX_SELECT_OFFERS).
const MAX_SELECT_OPTIONS = 64;
// Values up to this length are observed as text; longer field values as a
// prefix plus length and fingerprint, editor text only as length and
// fingerprint. helper/egdesk-browser-tool-runtime.mjs boundedFieldValue
// mirrors compact, fingerprint and boundedValue exactly.
const OBSERVED_VALUE_MAX = 120;
const MAX_FRAME_DEPTH = 4;
const MAX_SHADOW_DEPTH = 16;
const MAX_SCAN_ELEMENTS = 20000;
const MAX_EDITOR_NODES = 20000;
const MAX_INACCESSIBLE_FRAMES = 20;
// BRW-09 screenshot cover pass: form controls and editors (sensitive ones
// are covered), and embedded documents the observation did not read.
const MASK_SELECTOR = ["input", "textarea", "select", "iframe", "frame", "object", "embed",
  '[contenteditable=""]', '[contenteditable="true" i]', '[contenteditable="plaintext-only" i]'].join(",");
const INTERACTIVE_SELECTOR = ["a[href]", "button", "input", "textarea", "select", "[role]", "[tabindex]",
  '[contenteditable=""]', '[contenteditable="true" i]', '[contenteditable="plaintext-only" i]'].join(",");
const MUTATION_OPTIONS = Object.freeze({ subtree: true, childList: true, attributes: true, characterData: true });
// Settle never spends the reply budget: min(requested, lease deadline - margin) (REA 웹8 c).
const SETTLE_RESPONSE_MARGIN_MS = 500;
// The only dispatch phases a guarded refusal may claim (helper contract B).
const DISPATCH_PHASES = new Set(["not-dispatched", "dispatched", "unknown"]);
// BRW-10 (REA 웹1·웹2, D-B4): the separate "press / type like a person" routes.
const TRUSTED_INPUT_ACTIONS = new Set(["pointer-click", "type-text"]);
// BRW-06/08 extra candidates beyond INTERACTIVE_SELECTOR, as in agent-browser
// cli/src/native/snapshot.rs find_cursor_interactive_elements (Apache-2.0):
// cursor:pointer or onclick elements, labels that wrap a hidden radio or
// checkbox, and overflow scroll containers (browser-use dom/serializer
// serializer.py, MIT). Computed-style reads are budgeted per observation.
const NATIVE_INTERACTIVE_TAGS = new Set(["A", "BUTTON", "INPUT", "SELECT", "TEXTAREA", "DETAILS", "SUMMARY",
  "OPTION", "IFRAME", "FRAME"]);
const NON_CONTENT_TAGS = new Set(["HTML", "HEAD", "BODY", "SCRIPT", "STYLE", "TEMPLATE", "NOSCRIPT", "LINK", "META",
  "TITLE", "BR", "SLOT"]);
const MAX_STYLE_CHECKS = 3000;
const MAX_POINTER_CANDIDATES = 60;
const MAX_SCROLL_CONTAINERS = 12;
// Settle after a guarded action (nanobrowser core/interaction/evidence.ts,
// Apache-2.0: poll 100 ms, quiet 500 ms, cap 1.5 s), never past the lease.
const SETTLE_POLL_MS = 100;
const SETTLE_QUIET_MS = 500;
const SETTLE_CAP_MS = 1500;
const MAX_SETTLE_REQUESTS = 3;
const REQUEST_INITIATORS = new Set(["fetch", "xmlhttprequest", "beacon"]);
// BRW-12 reconcile: which guarded requests entered perform, and which were
// answered "never entered" (fenced so they can never enter later).
const MAX_PERFORM_RECORDS = 128;
const MAX_FENCES = 256;
const MAX_ACT_BUDGET_MS = 60000;
// egdesk_browser_wait_text: visible text only, bounded scan and match count.
const MAX_WAIT_TEXT = 200;
const MAX_TEXT_MATCH_NODES = 20000;
const MAX_TEXT_MATCHES = 50;
const TEXT_EXCLUDED_PARENTS = new Set(["SCRIPT", "STYLE", "TEMPLATE", "NOSCRIPT", "TEXTAREA", "SELECT", "OPTION",
  "INPUT"]);

export class EGDeskBrowserAgentRuntimeChild extends JSWindowActorChild {
  constructor() {
    super();
    this.refByNode = new WeakMap();
    // ref -> WeakRef(node) (firefox-devtools-mcp uidRegistry.ts, MIT): old
    // refs never keep detached DOM alive. The latest observation's refs are
    // also held strongly in liveRefs until the next observation.
    this.nodeByRef = new Map();
    this.liveRefs = new Map();
    this.refSeq = 0;
    // Same-origin frame generations: one key per (frame element, document).
    // A ref inside a frame carries the key path, e.g. "f2/f5/el_9".
    this.frameSeq = 0;
    this.frameByKey = new Map();
    this.frameByDocument = new WeakMap();
    this.watchedRoots = new WeakSet();
    this.documentId = globalThis.crypto?.randomUUID?.() || `${Date.now()}-${Math.random()}`;
    this.revision = 1;
    this.observedDocument = null;
    this.observer = null;
    this.lastViewport = null;
    // Entry into the side-effecting dispatcher, not physical input events.
    this.actorPerformCalls = 0;
    // Same-clock record of the guarded action in flight; perform's DOM event
    // points stamp firstEventAtMs into it.
    this.performTiming = null;
    // The one field the last guarded action filled; key input may follow it.
    this.lastGuardedFill = null;
    this.waitPollMs = 100;
    this.idleQuietMs = 500;
    this.settlePollMs = SETTLE_POLL_MS;
    this.settleQuietMs = SETTLE_QUIET_MS;
    // Guarded requests that entered perform, keyed "call:<callId>" and
    // "request:<lease requestId>", and keys answered "never entered".
    this.performRecords = new Map();
    this.performRecordsEvicted = false;
    this.fences = new Set();
  }

  async receiveMessage(message) {
    // System presentation signal: no request options, observation, or action authority.
    if (message.name === "presentationMetrics") return this.presentationMetrics();
    const data = message.data || {};
    if (message.name === "snapshot") {
      // A screenshot rides on the observe request (surface passes options
      // through); the parent captures, this actor only measures (BRW-09).
      if (data.options?.screenshot && typeof data.options.screenshot === "object") return this.screenshotThenSnapshot(data.options);
      return data.options?.wait ? this.waitThenSnapshot(data.options) : this.snapshot(data.options || {});
    }
    // Read-only cover boxes for the parent's capture (BRW-09, D-B6).
    if (message.name === "screenshotMask") return this.screenshotMask();
    if (message.name === "captureInput") return captureDocumentText(this.document, data.options || {});
    // Read-only question about one earlier guarded request (BRW-12).
    if (message.name === "reconcile") return this.reconcile(data);
    if (message.name === "act") {
      if (!data.options?.guard) return this.act(data.action || {}, data.options || {});
      // A guarded refusal answers as data, not as a thrown Error: a cloned
      // Error keeps only its message, and the chrome side needs the phase and
      // perform counts to tell "never sent" from "unknown" (REA 웹8 a).
      try { return await this.act(data.action || {}, data.options); }
      catch (error) { return this.guardedRefusal(error); }
    }
    throw new Error(`Unsupported browser agent actor message: ${message.name}`);
  }

  compact(value, max = 180) {
    const text = String(value || "").replace(/\s+/g, " ").trim();
    return text.length > max ? `${text.slice(0, max - 3).trimEnd()}...` : text;
  }

  // Non-cryptographic 53-bit fingerprint (cyrb53). It only notices that a
  // long or hidden value changed; it is not a security hash.
  fingerprint(text) {
    let h1 = 0xdeadbeef, h2 = 0x41c6ce57;
    for (let index = 0; index < text.length; index++) {
      const code = text.charCodeAt(index);
      h1 = Math.imul(h1 ^ code, 2654435761);
      h2 = Math.imul(h2 ^ code, 1597334677);
    }
    h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
    h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
    return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(16).padStart(14, "0");
  }

  boundedValue(raw, { editor = false } = {}) {
    const text = String(raw ?? "");
    const size = text.length > MAX_FILL_TEXT ? `over ${MAX_FILL_TEXT} chars`
      : `${text.length} chars, #${this.fingerprint(text)}`;
    if (editor) return text ? `[editor text hidden: ${size}]` : "[editor text hidden: empty]";
    return text.length <= OBSERVED_VALUE_MAX ? this.compact(text, OBSERVED_VALUE_MAX)
      : `${this.compact(text, 96)} [${size}]`;
  }

  elementRef(node) {
    let ref = this.refByNode.get(node);
    if (!ref) {
      const frame = this.frameByDocument.get(node?.ownerDocument);
      ref = `${frame ? `${frame.path}/` : ""}el_${++this.refSeq}`;
      this.refByNode.set(node, ref);
    }
    // A pruned or collected handle is re-registered while the node lives.
    if (this.refTarget(ref) !== node) this.nodeByRef.set(ref, this.weakHandle(node));
    return ref;
  }

  weakHandle(node) {
    return typeof WeakRef === "function" ? new WeakRef(node) : { deref: () => node };
  }

  refTarget(ref) {
    try { return this.nodeByRef.get(ref)?.deref?.() || null; } catch { return null; }
  }

  // The refs the latest observation handed out stay strongly reachable until
  // the next observation; collected handles are dropped.
  retainLiveRefs(refs) {
    const live = new Map();
    for (const ref of refs) {
      const node = typeof ref === "string" ? this.refTarget(ref) : null;
      if (node) live.set(ref, node);
    }
    this.liveRefs = live;
    for (const [ref, handle] of this.nodeByRef) {
      let node = null;
      try { node = handle?.deref?.() || null; } catch {}
      if (!node) this.nodeByRef.delete(ref);
    }
  }

  // Closed shadow roots are read through Gecko's privileged
  // openOrClosedShadowRoot (Playwright injectedScript expectHitTarget walks
  // closed roots bottom-up the same way). UA widget roots (media controls,
  // date fields) are browser internals, not page content, and stay unread.
  shadowRootOf(element) {
    let root = null;
    try { root = element?.openOrClosedShadowRoot ?? null; } catch {}
    if (!root) { try { root = element?.shadowRoot ?? null; } catch {} }
    if (!root) return null;
    try {
      if (root.isUAWidget === true || (typeof root.isUAWidget === "function" && root.isUAWidget() === true)) return null;
    } catch { return null; }
    return root;
  }

  // Stale like remote/shared/DOM.sys.mjs:552 isStale: disconnected, or its
  // document is no longer the active document of its browsing context.
  nodeForRef(ref) {
    const node = this.refTarget(ref);
    if (!node || !node.isConnected || !this.documentActive(node.ownerDocument)) return null;
    const frame = this.frameForRef(ref);
    return frame === undefined || (frame && node.ownerDocument !== frame.document) ? null : node;
  }

  // null for a top-document ref, the live frame record for a frame ref, and
  // undefined when that frame generation ended (navigated, removed, or no
  // longer same-origin): such a ref is stale even if its old node is alive.
  frameForRef(ref) {
    const cut = typeof ref === "string" ? ref.lastIndexOf("/") : -1;
    if (cut < 0) return null;
    const path = ref.slice(0, cut);
    const record = this.frameByKey.get(path.slice(path.lastIndexOf("/") + 1));
    return record && record.path === path && this.frameRecordLive(record) ? record : undefined;
  }

  frameRecordFor(frameElement, doc, parent) {
    const existing = this.frameByDocument.get(doc);
    if (existing && existing.frameElement === frameElement && existing.parent === parent &&
        this.frameByKey.get(existing.key) === existing) return existing;
    const key = `f${++this.frameSeq}`;
    const record = { key, path: parent ? `${parent.path}/${key}` : key, frameElement, document: doc, parent };
    this.frameByKey.set(key, record);
    this.frameByDocument.set(doc, record);
    return record;
  }

  frameRecordLive(record) {
    for (let current = record; current; current = current.parent) {
      let doc = null;
      try { doc = current.frameElement.contentDocument; } catch {}
      if (this.frameByKey.get(current.key) !== current || !current.frameElement.isConnected ||
          current.frameElement.ownerDocument !== (current.parent?.document || this.document) ||
          doc !== current.document || !this.documentActive(doc) || !this.sameOriginDocument(doc)) return false;
    }
    return true;
  }

  // Document.isActive() is ChromeOnly Gecko API; a harness without it is
  // judged by the other checks alone.
  documentActive(doc) {
    if (typeof doc?.isActive !== "function") return true;
    try { return doc.isActive() === true; } catch { return false; }
  }

  // Same origin as the top document by Gecko document principal (sandboxed
  // frames have their own). Harnesses without principals compare serialized
  // origins, and an opaque origin never matches.
  sameOriginDocument(doc) {
    if (!doc) return false;
    const top = this.document?.nodePrincipal, inner = doc.nodePrincipal;
    if (top || inner) {
      try { return !!top && !!inner && top.equals(inner) === true; } catch { return false; }
    }
    const originOf = href => { try { return new URL(href).origin; } catch { return "null"; } };
    const topOrigin = originOf(this.contentWindow?.location?.href);
    return topOrigin !== "null" && topOrigin === originOf(doc.location?.href ?? doc.URL);
  }

  windowFor(node) {
    const view = node?.ownerDocument?.defaultView;
    return view && typeof view === "object" ? view : this.contentWindow;
  }

  styleFor(node) {
    const view = this.windowFor(node);
    return (typeof view.getComputedStyle === "function" ? view : this.contentWindow).getComputedStyle(node);
  }

  // Frame content box offset (border and padding) in its parent document.
  // CSS transforms on a frame are not modeled.
  frameContentOffset(frameElement) {
    const rect = frameElement.getBoundingClientRect();
    const style = this.styleFor(frameElement);
    return { x: rect.left + (Number(frameElement.clientLeft) || 0) + (parseFloat(style?.paddingLeft) || 0),
      y: rect.top + (Number(frameElement.clientTop) || 0) + (parseFloat(style?.paddingTop) || 0) };
  }

  // Element rect in top-document viewport coordinates.
  viewportRect(node) {
    const rect = node.getBoundingClientRect();
    let left = rect.left, top = rect.top;
    for (let frame = this.frameByDocument.get(node.ownerDocument); frame; frame = frame.parent) {
      const offset = this.frameContentOffset(frame.frameElement);
      left += offset.x;
      top += offset.y;
    }
    return { left, top, width: rect.width, height: rect.height };
  }

  roundedBounds(rect) {
    return { x: Math.round(rect.left), y: Math.round(rect.top),
      width: Math.round(rect.width), height: Math.round(rect.height) };
  }

  isVisible(node) {
    if (!node || !node.getBoundingClientRect) return false;
    const rect = node.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return false;
    for (let current = node; current; current = this.composedParent(current)) {
      if (current.hidden || current.inert || current.getAttribute?.("aria-hidden") === "true") return false;
      const style = this.styleFor(current);
      if (style.display === "none" || ["hidden", "collapse"].includes(style.visibility) || Number(style.opacity) === 0) return false;
    }
    // A node in a same-origin frame is visible only if its frame element is.
    const frame = this.frameByDocument.get(node.ownerDocument);
    return !frame || this.isVisible(frame.frameElement);
  }

  isDisabled(node) {
    if (node?.disabled === true) return true;
    try { if (node?.matches?.(":disabled")) return true; } catch {}
    for (let current = node; current; current = this.composedParent(current)) {
      if (current.getAttribute?.("aria-disabled") === "true") return true;
    }
    return false;
  }

  // An editing host: contenteditable itself, not nested in another editable.
  isEditingHost(node) {
    return node?.isContentEditable === true && this.composedParent(node)?.isContentEditable !== true;
  }

  isFillableControl(node) {
    if (!node || node.readOnly || node.getAttribute?.("aria-readonly") === "true") return false;
    if (this.isEditingHost(node)) return true;
    const tag = String(node.tagName || "").toLowerCase();
    if (tag === "textarea" || tag === "select") return true;
    if (tag !== "input") return false;
    const type = String(node.type || node.getAttribute?.("type") || "text").toLowerCase();
    return ["text", "search", "email", "url", "tel", "number", "date", "time",
      "datetime-local", "month", "week"].includes(type);
  }

  roleFor(node) {
    const explicit = node.getAttribute?.("role");
    if (explicit) return explicit;
    const tag = String(node.tagName || "").toLowerCase();
    if (tag === "a") return "link";
    if (tag === "button") return "button";
    if (tag === "select") return "combobox";
    if (tag === "textarea") return "textbox";
    if (tag === "input") {
      const type = String(node.getAttribute("type") || "text").toLowerCase();
      if (["button", "submit", "reset"].includes(type)) return "button";
      if (["checkbox", "radio", "range", "search", "email", "password", "number", "date", "time"].includes(type)) return type;
      return "textbox";
    }
    if (node.isContentEditable) return "textbox";
    const pointer = this.pointerSignals(node);
    const choice = (tag === "label" || pointer) ? this.hiddenChoiceInput(node) : null;
    if (choice) return choice.type;
    if (this.scrollContainerState(node)) return "scrollable";
    if (pointer) return "clickable";
    return tag || "element";
  }

  // cursor:pointer that is not just inherited, or an onclick handler.
  pointerSignals(node, style = null) {
    let onclick = false;
    try { onclick = node.getAttribute?.("onclick") != null || typeof node.onclick === "function"; } catch {}
    if (onclick) return true;
    let own = style;
    try { own ||= this.styleFor(node); } catch { return false; }
    if (own?.cursor !== "pointer") return false;
    const parent = this.composedParent(node);
    if (!parent || parent.nodeType === 9) return true;
    try { return this.styleFor(parent)?.cursor !== "pointer"; } catch { return true; }
  }

  // A wrapper (a label, or a pointer element) around a radio or checkbox the
  // page hid to draw its own: the wrapper stands in for the control.
  hiddenChoiceInput(node) {
    let input = null;
    try { input = node.querySelector?.('input[type="radio" i], input[type="checkbox" i]') || null; } catch {}
    if (!input) return null;
    let hidden = input.hidden === true;
    if (!hidden) {
      try {
        const style = this.styleFor(input);
        hidden = style?.display === "none" || ["hidden", "collapse"].includes(style?.visibility);
      } catch { return null; }
    }
    if (!hidden) return null;
    const type = String(input.type || input.getAttribute?.("type") || "").toLowerCase();
    if (!["radio", "checkbox"].includes(type)) return null;
    return { type, state: input.indeterminate === true ? "mixed" : input.checked === true ? "checked" : "unchecked" };
  }

  // Scroll position of an element that scrolls its own overflow (not the
  // document), or null. Only auto/scroll overflow counts: a hidden overflow
  // is not something a person could scroll either.
  scrollContainerState(node, style = null) {
    const tag = String(node?.tagName || "").toUpperCase();
    if (!node || tag === "HTML" || tag === "BODY" || NATIVE_INTERACTIVE_TAGS.has(tag)) return null;
    let own = style;
    try { own ||= this.styleFor(node); } catch { return null; }
    const scrolls = value => ["auto", "scroll"].includes(value);
    if (!scrolls(own?.overflowY) && !scrolls(own?.overflowX) && !scrolls(own?.overflow)) return null;
    const int = value => Number.isFinite(Number(value)) ? Math.max(0, Math.round(Number(value))) : 0;
    const maxY = Math.max(0, int(node.scrollHeight) - int(node.clientHeight));
    const maxX = Math.max(0, int(node.scrollWidth) - int(node.clientWidth));
    if (maxY <= 1 && maxX <= 1) return null;
    return { x: int(node.scrollLeft), y: int(node.scrollTop), maxY };
  }

  // Which extra candidate an element is, within the observation's budget.
  extraCandidateKind(element, budget = null) {
    const tag = String(element?.tagName || "").toUpperCase();
    if (!tag || NATIVE_INTERACTIVE_TAGS.has(tag) || NON_CONTENT_TAGS.has(tag)) return null;
    const allowPointer = !budget || budget.pointer < MAX_POINTER_CANDIDATES;
    const allowScroll = !budget || budget.scroll < MAX_SCROLL_CONTAINERS;
    if (!allowPointer && !allowScroll) return null;
    if (tag === "LABEL" && allowPointer && this.hiddenChoiceInput(element)) {
      if (budget) budget.pointer++;
      return "choice";
    }
    if (budget) {
      if (budget.styleChecks >= MAX_STYLE_CHECKS) return null;
      budget.styleChecks++;
    }
    let style;
    try { style = this.styleFor(element); } catch { return null; }
    if (allowPointer && this.pointerSignals(element, style)) {
      if (budget) budget.pointer++;
      return "pointer";
    }
    if (allowScroll && this.scrollContainerState(element, style)) {
      if (budget) budget.scroll++;
      return "scroll";
    }
    return null;
  }

  isCandidate(node) {
    if (typeof node?.matches !== "function") return true;
    try { if (node.matches(INTERACTIVE_SELECTOR) === true) return true; } catch {}
    return !!this.extraCandidateKind(node);
  }

  privateMarked(node) {
    const flag = name => { const value = node?.getAttribute?.(name); return value != null && value !== "false"; };
    return flag("data-sensitive") || flag("data-private");
  }

  // Editors go through the same hints as fields; their text itself is never
  // observed (see valueFor/labelFor/isSensitiveText).
  // allowHidden (u8, D19): the form-submission proof asks whether a field is sensitive by what it IS (password, private mark, a name or label that says secret); a type=hidden field is masked from
  // reading (the default, unchanged) but is not by itself a reason to call a form sensitive: Google's search form carries six (ei, hl, source, ...). A hidden field named like a secret still is.
  isSensitiveControl(node, { allowHidden = false } = {}) {
    if (!node) return false;
    const tag = String(node.tagName || "").toLowerCase();
    if (!node.isContentEditable && !["input", "textarea", "select"].includes(tag)) return false;
    const type = String(node.type || node.getAttribute?.("type") || "").toLowerCase();
    if (type === "password" || (type === "hidden" && !allowHidden)) return true;
    if (this.privateMarked(node)) return true;
    const hints = ["autocomplete", "name", "id", "aria-label", "placeholder"].map(key =>
      String(node.getAttribute?.(key) || (key === "id" ? node.id : "") || "")
        .replace(/([a-z0-9])([A-Z])/g, "$1 $2").toLowerCase()).join(" ");
    if (/password|passwd|passphrase|secret|token|otp|cvv|cvc/.test(hints)) return true;
    return /(?:^|[\s_-])(?:password|passwd|pwd|passphrase|secret|token|otp|pin|ssn|pan|social[\s_-]?security(?:[\s_-]?number)?|primary[\s_-]?account[\s_-]?number|api[\s_-]?key|access[\s_-]?key|private[\s_-]?key|client[\s_-]?secret|one[\s_-]?time|verification[\s_-]?code|auth[\s_-]?code|security[\s_-]?answer|cc[\s_-]?(?:number|csc|exp)|credit[\s_-]?card(?:[\s_-]?number)?|card[\s_-]?number|cvv|cvc)(?:$|[\s_-])/.test(hints);
  }

  // Editor text is never page text: an editor shows only as its element.
  isSensitiveText(node) {
    for (let parent = this.composedParent(node); parent; parent = this.composedParent(parent)) {
      if (parent.isContentEditable || this.isSensitiveControl(parent)) return true;
    }
    return false;
  }

  composedParent(node) {
    return node?.parentElement || node?.getRootNode?.()?.host || null;
  }

  safeNavigationUrl(value) {
    if (typeof value !== "string" || !value || value.length > 2048 || /[\u0000-\u0020\u007f]/.test(value)) return null;
    try {
      const parsed = new URL(value);
      return ["http:", "https:"].includes(parsed.protocol) && !parsed.username && !parsed.password ? parsed.href : null;
    } catch { return null; }
  }

  nowMs() { return Date.now(); }

  // Monotonic milliseconds on this page's performance clock: settle, waits and
  // the relative act budget are measured here, never on the wall clock.
  monoNow() {
    for (const perf of [this.contentWindow?.performance, globalThis.performance]) {
      try {
        const value = perf.now();
        if (Number.isFinite(value) && value >= 0) return value;
      } catch {}
    }
    return Date.now();
  }

  sleep(ms) {
    return new Promise(resolve => this.contentWindow.setTimeout(resolve, Math.max(0, ms)));
  }

  // Relative budget from the request (helper budgetMs, less what the UI
  // already spent) turned into a deadline on the monotonic clock at receipt.
  budgetDeadline(budgetMs) {
    return Number.isSafeInteger(budgetMs) && budgetMs > 0 && budgetMs <= MAX_ACT_BUDGET_MS
      ? this.monoNow() + budgetMs : Infinity;
  }

  remainingMs(lease, budgetDeadline) {
    const wall = Number.isSafeInteger(lease?.deadlineMs) ? lease.deadlineMs - this.nowMs() : Infinity;
    const mono = Number.isFinite(budgetDeadline) ? budgetDeadline - this.monoNow() : Infinity;
    return Math.min(wall, mono);
  }

  // Same-clock stamp (helper contract C): this page global's
  // performance.timeOrigin + performance.now(), the clock an owned fixture
  // page records its own events with.
  clockMs() {
    for (const perf of [this.contentWindow?.performance, globalThis.performance]) {
      try {
        const value = perf.timeOrigin + perf.now();
        if (Number.isFinite(value) && value >= 0) return value;
      } catch {}
    }
    return Date.now();
  }

  markFirstEvent() {
    if (this.performTiming && this.performTiming.firstEventAtMs == null) this.performTiming.firstEventAtMs = this.clockMs();
  }

  // Gecko identities of this document (REA 웹4): the WindowGlobalChild's
  // innerWindowId and its BrowsingContext id. Absent where unavailable.
  documentIdentity() {
    const identity = {};
    try {
      const innerWindowId = this.manager?.innerWindowId;
      if (Number.isSafeInteger(innerWindowId) && innerWindowId > 0) identity.innerWindowId = innerWindowId;
    } catch {}
    try {
      const browsingContextId = this.browsingContext?.id;
      if (Number.isSafeInteger(browsingContextId) && browsingContextId > 0) identity.browsingContextId = browsingContextId;
    } catch {}
    return identity;
  }

  // Page full zoom of this tab (BrowsingContext.fullZoom), when readable. A
  // pointer press compares it with the observed value (BRW-10); absent means
  // unreadable, and devicePixelRatio (which carries full zoom) still decides.
  zoomState() {
    try {
      const zoom = (this.browsingContext?.top || this.browsingContext)?.fullZoom;
      if (typeof zoom === "number" && Number.isFinite(zoom) && zoom > 0) return { zoom: Math.round(zoom * 1000) / 1000 };
    } catch {}
    return {};
  }

  // Registrable domain from Gecko's Public Suffix List; null for IP,
  // single-label or unavailable data, which limits scope to the exact origin.
  siteForHost(host) {
    const eTLD = globalThis.Services?.eTLD;
    if (typeof eTLD?.getBaseDomainFromHost !== "function") return null;
    try { return eTLD.getBaseDomainFromHost(host) || null; } catch { return null; }
  }

  sameSiteNavigation(fromUrl, toUrl) {
    let from, to;
    try { from = new URL(fromUrl); to = new URL(toUrl); } catch { return false; }
    if (![from, to].every(url => ["http:", "https:"].includes(url.protocol))) return false;
    if (from.protocol === "https:" && to.protocol === "http:") return false;
    const fromSite = this.siteForHost(from.hostname);
    const toSite = this.siteForHost(to.hostname);
    if (!fromSite || !toSite) return from.origin === to.origin;
    return fromSite === toSite;
  }

  scrollState() {
    const win = this.contentWindow;
    const doc = this.document;
    const int = value => Number.isFinite(Number(value)) ? Math.max(0, Math.round(Number(value))) : 0;
    const x = int(win?.scrollX ?? win?.pageXOffset);
    const y = int(win?.scrollY ?? win?.pageYOffset);
    const maxY = Number.isFinite(win?.scrollMaxY) ? int(win.scrollMaxY)
      : Math.max(0, Math.max(int(doc?.documentElement?.scrollHeight), int(doc?.body?.scrollHeight)) - int(win?.innerHeight));
    return { x, y, maxY };
  }

  presentationMetricNowMs() { return globalThis.performance?.now?.() ?? Date.now(); }

  presentationMetrics() {
    const win = this.contentWindow;
    const width = win?.innerWidth;
    const height = win?.innerHeight;
    const validViewport = Number.isSafeInteger(width) && Number.isSafeInteger(height) &&
      width > 0 && height > 0 && width <= 100000 && height <= 100000;
    const viewportWidth = validViewport ? width : 0;
    const viewportHeight = validViewport ? height : 0;
    let sampleCount = 0;
    const unavailable = () => ({ version: 1, fontPx: null, viewportWidth, viewportHeight,
      sampleCount, complete: false });
    if (!validViewport) return unavailable();

    const started = this.presentationMetricNowMs();
    const withinBudget = () => {
      const now = this.presentationMetricNowMs();
      return Number.isFinite(started) && Number.isFinite(now) &&
        now >= started && now - started < 8;
    };
    const validRect = rect => rect && [rect.left, rect.top, rect.width, rect.height]
      .every(Number.isFinite) && rect.width >= 0 && rect.height >= 0 &&
      Number.isFinite(rect.left + rect.width) && Number.isFinite(rect.top + rect.height);
    const intersects = (rect, clip) => clip.left < clip.right && clip.top < clip.bottom &&
      rect.width > 0 && rect.height > 0 &&
      rect.left < clip.right && rect.left + rect.width > clip.left &&
      rect.top < clip.bottom && rect.top + rect.height > clip.top;
    const unsupportedScale = style =>
      (style.transform && style.transform !== "none") ||
      (style.scale && style.scale !== "none" && style.scale !== "1") ||
      (style.rotate && style.rotate !== "none" && style.rotate !== "0deg") ||
      (style.translate && style.translate !== "none" && style.translate !== "0px") ||
      (style.zoom && style.zoom !== "normal" && style.zoom !== "100%" &&
        Number(style.zoom) !== 1);
    const hidden = (node, style) => node.hidden || node.inert ||
      node.getAttribute?.("aria-hidden") === "true" ||
      node.getAttribute?.("data-sensitive") != null ||
      node.getAttribute?.("data-private") != null || node.isContentEditable ||
      style.display === "none" || style.contentVisibility === "hidden" ||
      Number(style.opacity) === 0;
    const excludedTag = tag => ["SCRIPT", "STYLE", "TEMPLATE", "NOSCRIPT", "INPUT",
      "TEXTAREA", "SELECT", "OPTION"].includes(tag);
    const opaqueContentTag = tag => ["IFRAME", "FRAME", "OBJECT", "EMBED", "CANVAS"].includes(tag);

    try {
      const doc = this.document;
      const root = doc?.documentElement;
      if (!root || !withinBudget()) return unavailable();
      const range = doc.createRange?.();
      if (!range?.selectNodeContents || !range?.getClientRects || !withinBudget()) return unavailable();
      const stateByNode = new WeakMap();
      const viewport = { left: 0, top: 0, right: width, bottom: height };
      const nextNode = (current, descend) => {
        if (descend && current.firstChild) return current.firstChild;
        while (current !== root) {
          if (current.nextSibling) return current.nextSibling;
          current = current.parentNode || current.parentElement;
          if (!current) return null;
        }
        return null;
      };
      let node = root, visited = 0, minFont = Infinity;
      while (node) {
        if (!withinBudget() || ++visited > 256) return unavailable();
        let descend = true;
        if (node.nodeType === 1) {
          const tag = String(node.tagName || "").toUpperCase();
          if (excludedTag(tag) || node.hidden || node.inert ||
              node.getAttribute?.("aria-hidden") === "true" ||
              node.getAttribute?.("data-sensitive") != null ||
              node.getAttribute?.("data-private") != null || node.isContentEditable) {
            descend = false;
          } else {
            const style = this.contentWindow.getComputedStyle(node);
            if (!style || !withinBudget()) return unavailable();
            if (hidden(node, style)) {
              descend = false;
            } else {
              if (!["visible", "hidden", "collapse"].includes(style.visibility)) return unavailable();
              // Firefox exposes both open and closed author roots to privileged
              // callers. If this getter is unavailable here, absence of a
              // shadowRoot cannot prove that the light DOM is complete.
              if (!("openOrClosedShadowRoot" in node) ||
                  node.openOrClosedShadowRoot !== null) return unavailable();
              const parent = node === root ? null : (node.parentNode || node.parentElement);
              const inherited = parent ? stateByNode.get(parent) : viewport;
              if (!inherited) return unavailable();
              // Positioned descendants may escape an ancestor's overflow clip.
              // Keep traversing even an empty clip, but do not claim a metric
              // for a positioned descendant whose visibility is ambiguous.
              if (inherited.hasOverflowClip && !["static", "relative"].includes(style.position)) {
                return unavailable();
              }
              if (opaqueContentTag(tag)) {
                const rect = node.getBoundingClientRect?.();
                if (!validRect(rect) || !withinBudget()) return unavailable();
                if (intersects(rect, inherited)) return unavailable();
                descend = false;
              }
              const clipsX = ["hidden", "clip", "scroll", "auto"].includes(style.overflowX);
              const clipsY = ["hidden", "clip", "scroll", "auto"].includes(style.overflowY);
              const clip = { ...inherited, fontSize: style.fontSize,
                visible: style.visibility === "visible",
                unsupportedScale: !!(inherited.unsupportedScale || unsupportedScale(style)),
                hasOverflowClip: !!(inherited.hasOverflowClip || clipsX || clipsY) };
              if (clipsX || clipsY) {
                const rect = node.getBoundingClientRect?.();
                if (!validRect(rect) || !withinBudget()) return unavailable();
                if (clipsX) {
                  clip.left = Math.max(clip.left, rect.left);
                  clip.right = Math.min(clip.right, rect.left + rect.width);
                }
                if (clipsY) {
                  clip.top = Math.max(clip.top, rect.top);
                  clip.bottom = Math.min(clip.bottom, rect.top + rect.height);
                }
              }
              stateByNode.set(node, clip);
            }
          }
        } else if (node.nodeType === 3 && /\S/.test(node.nodeValue || "")) {
          const parent = node.parentNode || node.parentElement;
          const state = stateByNode.get(parent);
          if (!state) return unavailable();
          if (!state.visible) {
            node = nextNode(node, false);
            continue;
          }
          range.selectNodeContents(node);
          const rects = range.getClientRects();
          if (!rects || !Number.isSafeInteger(rects.length) || rects.length > 64 ||
              !withinBudget()) return unavailable();
          let onScreen = false;
          for (const rect of rects) {
            if (!validRect(rect) || !withinBudget()) return unavailable();
            if (intersects(rect, state)) onScreen = true;
          }
          if (onScreen) {
            if (state.unsupportedScale) return unavailable();
            if (sampleCount >= 64) return unavailable();
            const match = /^(?:\d+(?:\.\d+)?|\.\d+)px$/.exec(state.fontSize || "");
            const font = match ? Number(match[0].slice(0, -2)) : NaN;
            if (!Number.isFinite(font) || font <= 0 || font > 4096) return unavailable();
            sampleCount++;
            minFont = Math.min(minFont, font);
          }
        }
        node = nextNode(node, descend);
      }
      if (!withinBudget() || !sampleCount || this.document !== doc ||
          this.contentWindow !== win || win.innerWidth !== width ||
          win.innerHeight !== height) return unavailable();
      return { version: 1, fontPx: minFont, viewportWidth, viewportHeight,
        sampleCount, complete: true };
    } catch {
      return unavailable();
    }
  }

  labelFor(node) {
    if (this.isSensitiveControl(node)) return "Sensitive field";
    // IDs are scoped to the node's own tree (document or shadow root).
    const root = node.getRootNode?.();
    const doc = typeof root?.getElementById === "function" ? root : node.ownerDocument;
    const labelledBy = node.getAttribute?.("aria-labelledby");
    if (labelledBy) {
      const labelled = labelledBy.split(/\s+/).map((id) => doc.getElementById(id)?.textContent || "").join(" ");
      if (labelled.trim()) return this.compact(labelled, 120);
    }
    const associated = node.labels?.[0];
    if (associated) {
      const label = associated.cloneNode(true);
      for (const field of label.querySelectorAll('input,select,textarea,button,script,style')) field.remove();
      if (label.textContent?.trim()) return this.compact(label.textContent, 120);
    }
    if (!associated && node.id) {
      const label = doc.querySelector(`label[for="${CSS.escape(node.id)}"]`);
      if (label?.textContent?.trim()) return this.compact(label.textContent, 120);
    }
    const editor = node.isContentEditable === true;
    return this.compact(
      node.getAttribute?.("aria-label")
        || node.getAttribute?.("alt")
        || node.getAttribute?.("title")
        || node.getAttribute?.("placeholder")
        || node.getAttribute?.("aria-placeholder")
        || (editor || /^(select|textarea)$/i.test(node.tagName) ? "" : node.innerText || node.textContent)
        || node.getAttribute?.("name")
        || node.getAttribute?.("id")
        || (editor ? "Editable text" : ""),
      120,
    );
  }

  valueFor(node) {
    if (this.isSensitiveControl(node)) return "";
    const tag = String(node.tagName || "").toLowerCase();
    if (tag === "select") return this.boundedValue(node.value || "");
    if (tag === "input" && ['checkbox','radio'].includes(node.type)) return node.indeterminate ? 'mixed' : node.checked ? 'checked' : 'unchecked';
    if (tag === "textarea" || tag === "input") return this.boundedValue(node.value || "");
    if (node.isContentEditable) return this.boundedValue(this.editorText(node), { editor: true });
    if (tag === "label" || this.pointerSignals(node)) return this.hiddenChoiceInput(node)?.state || "";
    return "";
  }

  // Editor text as EG-Desk writes it: text nodes, with <br> as a line break.
  // Paragraphs an editor builds itself are not inferred, so a multi-line value
  // the page restructured reads back as different (unverified), never equal.
  // Past the node or length bound it reads as over the bound.
  editorText(host) {
    if (!host?.childNodes) return String(host?.textContent || "").slice(0, MAX_FILL_TEXT + 1);
    let text = "", visited = 0, overflow = false;
    const walk = node => {
      for (const child of Array.from(node.childNodes || [])) {
        if (++visited > MAX_EDITOR_NODES || text.length > MAX_FILL_TEXT) { overflow = true; return; }
        if (child.nodeType === 3) text += child.nodeValue || "";
        else if (child.nodeType === 1) {
          if (String(child.tagName || "").toUpperCase() === "BR") text += "\n";
          else walk(child);
        }
      }
    };
    walk(host);
    return (overflow ? text.padEnd(MAX_FILL_TEXT + 1, "\u0000") : text).slice(0, MAX_FILL_TEXT + 1);
  }

  writeEditorText(host, text) {
    const doc = host.ownerDocument;
    const nodes = [];
    text.split("\n").forEach((line, index) => {
      if (index) nodes.push(doc.createElement("br"));
      if (line) nodes.push(doc.createTextNode(line));
    });
    host.replaceChildren(...nodes);
  }

  currentValueLength(node) {
    if (node.isContentEditable) return this.editorText(node).length;
    return "value" in node ? String(node.value || "").length : 0;
  }

  signature(item) {
    return [item.role || "", item.label || "", item.href || "", item.value || ""].join("|");
  }

  watchRoot(root) {
    if (!this.observer || this.watchedRoots.has(root)) return;
    const target = root.nodeType === 9 ? root.documentElement : root;
    try {
      if (target) { this.observer.observe(target, MUTATION_OPTIONS); this.watchedRoots.add(root); }
    } catch {}
  }

  frameLabel(frame) {
    return this.compact(frame.getAttribute?.("title") || frame.getAttribute?.("aria-label") ||
      frame.getAttribute?.("name") || "Embedded frame", 120);
  }

  // One pass over the top document, open and closed shadow roots and
  // same-origin frames, in document order. Cross-origin, private and too-deep
  // frames are only listed as inaccessible; nothing is read through them.
  // Shadow roots and frame documents join the mutation watch. With classify,
  // pointer/choice/scroll candidates join the selector matches (budgeted).
  scanRoots(doc, { classify = true } = {}) {
    const roots = [], candidates = [], inaccessibleFrames = [];
    const budget = { styleChecks: 0, pointer: 0, scroll: 0 };
    let scanned = 0;
    const visit = (root, frame, shadowDepth) => {
      roots.push(root);
      this.watchRoot(root);
      let matchedList, elements;
      try {
        matchedList = Array.from(root.querySelectorAll(INTERACTIVE_SELECTOR));
        elements = root.querySelectorAll("*");
      } catch { return; }
      const matched = new Set(matchedList), pushed = new Set();
      for (let index = 0; index < elements.length && scanned < MAX_SCAN_ELEMENTS; index++, scanned++) {
        const element = elements[index];
        if (matched.has(element)) { candidates.push(element); pushed.add(element); }
        else if (classify && this.extraCandidateKind(element, budget)) { candidates.push(element); pushed.add(element); }
        const tag = String(element.tagName || "").toUpperCase();
        if (tag === "IFRAME" || tag === "FRAME") { this.scanFrame(element, frame, visit, inaccessibleFrames); continue; }
        const shadow = shadowDepth < MAX_SHADOW_DEPTH ? this.shadowRootOf(element) : null;
        if (shadow) visit(shadow, frame, shadowDepth + 1);
      }
      // Past the scan budget the remaining interactive elements still count,
      // in document order; only their shadow roots and frames go unread.
      for (const element of matchedList) if (!pushed.has(element)) candidates.push(element);
    };
    visit(doc, null, 0);
    // truncated: the element budget ran out, so some shadow roots or frames
    // went unread (the screenshot cover pass then refuses to send).
    return { roots, candidates, inaccessibleFrames, truncated: scanned >= MAX_SCAN_ELEMENTS };
  }

  scanFrame(frameElement, parent, visit, inaccessibleFrames) {
    if (!this.isVisible(frameElement)) return;
    let doc = null;
    try { doc = frameElement.contentDocument || null; } catch {}
    const depth = parent ? parent.path.split("/").length : 0;
    const reason = this.privateMarked(frameElement) ? "private" : !doc ? "unreadable"
      : !this.sameOriginDocument(doc) ? "cross-origin" : depth >= MAX_FRAME_DEPTH ? "depth-limit" : null;
    if (!reason) return visit(doc, this.frameRecordFor(frameElement, doc, parent), 0);
    if (inaccessibleFrames.length < MAX_INACCESSIBLE_FRAMES) inaccessibleFrames.push({ label: this.frameLabel(frameElement),
      reason, bounds: this.roundedBounds(this.viewportRect(frameElement)) });
  }

  textSegments(doc, limit = 80, scan = this.scanRoots(doc)) {
    const filter = this.contentWindow.NodeFilter;
    const seen = new Set();
    const segments = [];
    for (const root of scan.roots) {
      if (segments.length >= limit) break;
      const isDocument = root === doc || root.nodeType === 9;
      const walkRoot = isDocument ? root.body || root.documentElement : root;
      const owner = isDocument ? root : root.ownerDocument;
      if (!walkRoot || typeof owner?.createTreeWalker !== "function") continue;
      const walker = owner.createTreeWalker(walkRoot, filter.SHOW_TEXT, {
        acceptNode: (node) => {
          const text = this.compact(node.nodeValue, 180);
          if (!text || text.length < 2) return filter.FILTER_REJECT;
          const parent = node.parentElement || node.parentNode?.host;
          if (!parent || !this.isVisible(parent) || this.isSensitiveText(node)) return filter.FILTER_REJECT;
          return filter.FILTER_ACCEPT;
        },
      });
      let node = walker.nextNode();
      while (node && segments.length < limit) {
        const text = this.compact(node.nodeValue, 180);
        if (text && !seen.has(text)) {
          seen.add(text);
          segments.push(text);
        }
        node = walker.nextNode();
      }
    }
    return segments;
  }

  elementItem(node) {
    return {
      ref: this.elementRef(node),
      role: this.roleFor(node),
      label: this.labelFor(node),
      tag: String(node.tagName || "").toLowerCase(),
      href: node.href || node.getAttribute?.("href") || "",
      value: this.valueFor(node),
      // Only the observed, visible, non-private control can release a short value to the local step UI.
      ...(['input', 'select', 'textarea'].includes(String(node.tagName || '').toLowerCase()) &&
        node.type !== 'hidden' && !node.hidden && !node.closest?.('[hidden],[aria-hidden="true"],[data-private],[data-sensitive]') &&
        !this.screenshotSensitiveReason(node) ? { displayValueSafe: true } : {}),
      ...this.choiceFacts(node),
      disabled: this.isDisabled(node),
      bounds: this.roundedBounds(this.viewportRect(node)),
      ...(this.navigationFacts(node) ? { nav: this.navigationFacts(node) } : {}),
    };
  }

  choiceFacts(node) {
    const tag = String(node.tagName || '').toLowerCase();
    const toggle = tag === 'input' && ['checkbox','radio'].includes(node.type);
    if ((!toggle && tag !== 'select' && !(tag === 'input' && ['date','time','number'].includes(node.type))) || this.isSensitiveControl(node)) return {};
    const labels = [];
    for (let p = node.parentElement; p; p = p.parentElement) {
      if (p.matches?.('fieldset,section,form,[role=region],[role=dialog]')) labels.push(p.getAttribute('aria-label') || p.querySelector(':scope > legend,:scope > h1,:scope > h2,:scope > h3')?.textContent || '');
    }
    const choice = { inForm: !!node.form, sensitiveRegion: !!node.closest?.('[data-sensitive],[data-private]'), regionLabels: labels.map(s => this.compact(s, 120)),
      immediate: ['onchange','onclick','oninput','aria-checked'].some(a => node.hasAttribute?.(a)) };
    if (toggle) return { choice, checked: !!node.checked, choiceValue: this.boundedValue(node.value || '') };
    if (tag !== 'select') return { choice };
    choice.multiple = !!node.multiple;
    choice.truncated = (node.options?.length ?? 0) > MAX_SELECT_OPTIONS;
    const options = [];
    for (let i = 0; i < Math.min(MAX_SELECT_OPTIONS, node.options?.length ?? 0); i++) {
      const o = node.options[i];
      options.push({ label: this.compact(o.label, 100), value: String(o.value).slice(0, 120), disabled: !!o.disabled || o.parentElement?.disabled === true || o.value.length > 120 });
    }
    return { choice, options, selectedLabel: this.compact(node.selectedOptions?.[0]?.label || '', 100) };
  }

  // L8 c20: facts the helper's read-only-navigation proof reads for a button (the helper presses one only when they prove a same-site GET
  // form submission or a client-side view change). Facts only, never a decision; null for anything that is not a button.
  //   type: the button's type; sensitiveRegion: inside [data-sensitive]/[data-private]; regionLabel: the nearest region's label;
  //   form: { method, fields: field kinds, sensitive, submitUrl: the GET URL with parameters, or the same-origin native POST destination without field values } (a form submitter only);
  //   controls: { text } of the panel it controls (aria-controls), for a button outside any form.
  navigationFacts(node) {
    try {
      const tag = String(node.tagName || "").toLowerCase();
      const inputType = String(node.getAttribute?.("type") || "").toLowerCase();
      const role = this.roleFor(node);
      const isButton = tag === "button" || (tag === "input" && ["submit", "button", "image"].includes(inputType)) || role === "button" || role === "tab";
      if (!isButton) return null;
      const type = tag === "button" ? (inputType || "submit") : tag === "input" ? inputType : null;
      const sensitiveRegion = Boolean(node.closest?.("[data-sensitive],[data-private]"));
      const region = node.closest?.("fieldset,section,form,[role=region],[role=dialog],[aria-label]");
      const regionLabel = this.compact(region ? (region.getAttribute?.("aria-label") || region.querySelector?.("legend,h1,h2,h3,h4")?.textContent || "") : "", 60);
      const facts = { type, sensitiveRegion, regionLabel, form: null, controls: null };
      const form = tag === "button" || tag === "input" ? node.form || null : null;
      // Only native, unassociated buttons outside anchors/forms qualify for the named-button path.
      if (tag === "button" && !form && node.closest && !node.closest("a,form,[data-sensitive],[data-private]") && node.hasAttribute && !node.hasAttribute("form") && !node.hasAttribute("formaction") && node.getRootNode?.() === node.ownerDocument && node.ownerDocument === this.document) {
        // An inner label must not hide a sensitive outer section. Only offer complete, bounded ancestry.
        const labels = [];
        let p = node.parentElement;
        for (let depth = 0; p && depth < 48; depth++, p = p.parentElement) {
          if (!p.matches?.("fieldset,section,form,[role=region],[role=dialog],[aria-label],[aria-labelledby]")) continue;
          if (p.hasAttribute("aria-labelledby")) break;
          const label = p.getAttribute("aria-label") || p.querySelector("legend,h1,h2,h3,h4")?.textContent || "";
          if (label.length > 100 || labels.length >= 8) break;
          if (label) labels.push(label);
        }
        if (!p) { facts.standalone = true; facts.regionLabels = labels; }
      }
      if (form && type !== "button") {
        const method = String(node.getAttribute?.("formmethod") || form.getAttribute?.("method") || "get").toLowerCase();
        const fields = [], params = [];
        let sensitive = false;
        for (const field of Array.from(form.elements || []).slice(0, 40)) {
          const ftag = String(field.tagName || "").toLowerCase();
          const ftype = ftag === "input" ? String(field.getAttribute?.("type") || "text").toLowerCase() : ftag;
          // u8 (D19): a file input with no name, or a disabled one, is never part of a submission (Google's search form carries an unnamed hidden one for image search); it is neither a field kind nor a reason to call the form sensitive. A NAMED file input still is both.
          if (ftype === "file" && (!field.getAttribute?.("name") || field.disabled)) continue;
          if (ftype === "password" || ftype === "file" || this.isSensitiveControl(field, { allowHidden: true }) || isSensitiveAutocomplete(field.getAttribute?.("autocomplete"))) sensitive = true;
          fields.push(ftype);
          if (method !== "get") continue; // POST observation never reads or serializes field values.
          const name = field.getAttribute?.("name");
          if (!name || field.disabled || ["submit", "button", "image", "reset", "file"].includes(ftype)) continue;
          if ((ftype === "checkbox" || ftype === "radio") && !field.checked) continue;
          params.push([name, String(field.value ?? "")]);
        }
        const own = node.getAttribute?.("name");
        if (method === "get" && own) params.push([own, String(node.value ?? "")]);
        let submitUrl = null;
        if (method === "get" && !sensitive) {
          const doc = node.ownerDocument;
          const url = new URL(node.getAttribute?.("formaction") || form.getAttribute?.("action") || doc?.URL || "", doc?.baseURI || doc?.URL);
          url.search = new URLSearchParams(params).toString();
          url.hash = "";
          submitUrl = url.href;
        }
        // Provisional: for a complete native POST form expose its destination, never field values.
        // Hidden and unknown controls are not evidence for an unattended write.
        if (method === 'post' && !sensitive && !sensitiveRegion && form.elements?.length <= 40 && !fields.includes('hidden') &&
            typeof node.getAttribute === 'function' && node.getAttribute('formtarget') === null &&
            typeof form.getAttribute === 'function' && !form.getAttribute('target') &&
            typeof form.closest === 'function' && !form.closest('[data-private],[data-sensitive]')) {
          const doc = node.ownerDocument;
          try {
            const url = new URL(node.getAttribute('formaction') || form.getAttribute('action') || doc?.URL, doc?.baseURI || doc?.URL);
            if (['http:', 'https:'].includes(url.protocol) && url.origin === new URL(doc.URL).origin && !url.username && !url.password) submitUrl = url.href;
          } catch { /* No verified destination; retain the other form facts. */ }
        }
        facts.form = { method, fields, sensitive, submitUrl };
      } else if (!form) {
        const id = node.getAttribute?.("aria-controls");
        const panel = id ? node.ownerDocument?.getElementById?.(id) : null;
        if (panel && !panel.closest?.("[data-sensitive],[data-private]")) {
          const text = this.compact(panel.querySelector?.("h1,h2,h3,h4,legend,label,p,li")?.textContent || panel.textContent || "", 60);
          if (text) facts.controls = { text };
        }
      }
      return facts;
    } catch {
      return null;
    }
  }

  interactiveElements(doc, limit = 80, scan = this.scanRoots(doc)) {
    const items = [];
    for (const node of scan.candidates) {
      if (items.length >= limit) break;
      if (this.isVisible(node)) items.push(this.elementItem(node));
    }
    return items;
  }

  // Scroll positions of the listed elements that scroll their own overflow,
  // so a container scroll can be guarded like the document scroll.
  scrollContainersFor(items) {
    const containers = [];
    for (const item of items) {
      if (containers.length >= MAX_SCROLL_CONTAINERS) break;
      const node = this.refTarget(item.ref);
      const state = node ? this.scrollContainerState(node) : null;
      if (state) containers.push({ ref: item.ref, ...state });
    }
    return containers;
  }

  // Focus through open and closed shadow roots and live same-origin frames;
  // it stops at a frame element whose document this actor has not observed.
  deepActiveElement(doc) {
    let active = doc.activeElement;
    for (let depth = 0; active && depth < 32; depth++) {
      const shadowActive = this.shadowRootOf(active)?.activeElement;
      if (shadowActive) { active = shadowActive; continue; }
      const tag = String(active.tagName || "").toUpperCase();
      if (tag !== "IFRAME" && tag !== "FRAME") break;
      let frameDoc = null;
      try { frameDoc = active.contentDocument; } catch {}
      const frame = frameDoc && this.frameByDocument.get(frameDoc);
      if (!frame || frame.frameElement !== active || !this.frameRecordLive(frame)) break;
      const inner = frameDoc.activeElement;
      if (!inner || inner === frameDoc.body || inner === frameDoc.documentElement) break;
      active = inner;
    }
    return active;
  }

  focusedElement(doc) {
    const active = this.deepActiveElement(doc);
    if (!active || active === doc.body || active === doc.documentElement || !this.isVisible(active)) return null;
    return {
      ref: this.elementRef(active),
      role: this.roleFor(active),
      label: this.labelFor(active),
      value: this.valueFor(active),
    };
  }

  observationState() {
    const doc = this.document;
    if (doc !== this.observedDocument) {
      if (this.observedDocument) this.documentId = globalThis.crypto?.randomUUID?.() || `${Date.now()}-${Math.random()}`;
      this.observer?.disconnect?.();
      this.observedDocument = doc;
      this.observer = null;
      this.frameByKey.clear();
      this.frameByDocument = new WeakMap();
      this.watchedRoots = new WeakSet();
      this.revision++;
      if (doc?.documentElement && this.contentWindow.MutationObserver) {
        this.observer = new this.contentWindow.MutationObserver(() => { this.revision++; });
        this.observer.observe(doc.documentElement, MUTATION_OPTIONS);
        this.watchedRoots.add(doc);
      }
    }
    if (this.observer?.takeRecords().length) this.revision++;
    // A same-origin frame that navigated, left the page or changed origin
    // ends its generation: its refs become stale and the revision moves.
    for (const record of [...this.frameByKey.values()]) {
      if (!this.frameRecordLive(record)) { this.frameByKey.delete(record.key); this.revision++; }
    }
    const viewport = {
      width: Math.round(this.contentWindow.innerWidth || 0),
      height: Math.round(this.contentWindow.innerHeight || 0),
      devicePixelRatio: Math.round((this.contentWindow.devicePixelRatio || 1) * 1000) / 1000,
    };
    if (this.lastViewport && (viewport.width !== this.lastViewport.width || viewport.height !== this.lastViewport.height ||
        viewport.devicePixelRatio !== this.lastViewport.devicePixelRatio)) this.revision++;
    this.lastViewport = viewport;
    return { documentId: this.documentId, revision: this.revision, viewport,
      coordinateSpace: "browser-viewport-local" };
  }

  qaPerformDiagnostics(options = {}) {
    const expected = options.qaDiagnostics;
    if (!expected || typeof expected !== "object" ||
        typeof expected.fixtureUrl !== "string" ||
        !/^[A-Za-z0-9_-]{20,80}$/.test(expected.fixtureMarker || "")) return {};
    const actualUrl = this.contentWindow.location.href;
    let parsed;
    try { parsed = new URL(actualUrl); } catch { return {}; }
    if (actualUrl !== expected.fixtureUrl || actualUrl !== parsed.href ||
        parsed.protocol !== "http:" || parsed.hostname !== "127.0.0.1" ||
        Number(parsed.port) < 1024 || Number(parsed.port) > 65535 ||
        !parsed.port || parsed.username || parsed.password || parsed.search || parsed.hash ||
        !/^\/egdesk-qa\/[A-Za-z0-9_-]{20,80}$/.test(parsed.pathname) ||
        this.document.getElementById?.("fixture-marker")?.textContent !== expected.fixtureMarker) return {};
    return { qaDiagnostics: { kind: "actor-perform-entry",
      actorDocumentId: this.documentId, performCalls: this.actorPerformCalls } };
  }

  snapshot(options = {}) {
    const doc = this.document;
    const state = this.observationState();
    const scan = this.scanRoots(doc);
    const interactiveElements = this.interactiveElements(doc, options.elementLimit || 80, scan);
    const focusedElement = this.focusedElement(doc);
    this.retainLiveRefs([...interactiveElements.map(item => item.ref), focusedElement?.ref]);
    return {
      ...state,
      ...this.documentIdentity(),
      ...this.zoomState(),
      ...this.qaPerformDiagnostics(options),
      url: this.contentWindow.location.href,
      title: doc.title || "",
      readyState: doc.readyState || "",
      text: this.textSegments(doc, options.textLimit || 80, scan),
      interactiveElements,
      focusedElement,
      scroll: this.scrollState(),
      scrollContainers: this.scrollContainersFor(interactiveElements),
      inaccessible: false,
      inaccessibleFrames: scan.inaccessibleFrames,
    };
  }

  // Whether a node paints pixels: a box, and no ancestor hides it by style.
  // Unlike isVisible this ignores aria-hidden and inert, which still paint.
  // null when the box cannot be measured (unknown, so never "does not paint").
  paints(node) {
    if (!node?.getBoundingClientRect) return null;
    const rect = node.getBoundingClientRect();
    if (!Number.isFinite(rect?.width) || !Number.isFinite(rect?.height)) return null;
    if (!(rect.width > 0) || !(rect.height > 0)) return false;
    for (let current = node; current; current = this.composedParent(current)) {
      const style = this.styleFor(current);
      if (style.display === "none" || ["hidden", "collapse"].includes(style.visibility) || Number(style.opacity) === 0) return false;
    }
    const frame = this.frameByDocument.get(node.ownerDocument);
    return !frame || this.paints(frame.frameElement);
  }

  // Sensitive for the screenshot: the observation's sensitive control rule
  // plus every cc-* or one-time-code autocomplete token (D-B6).
  screenshotSensitiveReason(node) {
    const type = String(node.type || node.getAttribute?.("type") || "").toLowerCase();
    if (type === "password") return "password";
    if (isSensitiveAutocomplete(node.getAttribute?.("autocomplete"))) return "sensitive-autocomplete";
    return this.isSensitiveControl(node) ? "sensitive-hint" : null;
  }

  // Cover boxes for a capture of the current viewport, in top-viewport CSS
  // pixels: sensitive fields, embedded documents the observation did not
  // read (other-site, unreadable, private, too deep, past the scan budget)
  // and plugin/object embeds. complete:false means a box could not be
  // trusted, and the parent then sends nothing (REA 웹6, decision 3).
  screenshotMask() {
    const state = this.observationState();
    const scan = this.scanRoots(this.document, { classify: false });
    const scanned = new Set(scan.roots);
    const regions = [];
    let incompleteReason = scan.truncated ? "scan-budget" : null;
    const coverRect = node => {
      // Frame offsets are composed without CSS transforms (viewportRect), so
      // a transformed frame on the path makes the box untrustworthy.
      for (let frame = this.frameByDocument.get(node.ownerDocument); frame; frame = frame.parent) {
        const transform = this.styleFor(frame.frameElement)?.transform;
        if (transform && transform !== "none") return { error: "frame-transform" };
      }
      const rect = this.viewportRect(node);
      return [rect.left, rect.top, rect.width, rect.height].every(Number.isFinite) ? { rect } : { error: "rect-unavailable" };
    };
    // A node that does not paint needs no cover; one whose box cannot be
    // measured makes the whole report untrustworthy.
    const push = (node, kind, reason) => {
      let painted, box;
      try { painted = this.paints(node); } catch { painted = null; }
      if (painted === false) return;
      try { box = painted === null ? { error: "rect-unavailable" } : coverRect(node); } catch { box = { error: "rect-unavailable" }; }
      if (box.error) { incompleteReason ||= box.error; return; }
      regions.push({ kind, reason, rect: box.rect });
    };
    for (const root of scanned) {
      let nodes;
      try { nodes = Array.from(root.querySelectorAll(MASK_SELECTOR)); } catch { incompleteReason ||= "scan-failed"; continue; }
      for (const node of nodes) {
        const tag = String(node.tagName || "").toUpperCase();
        if (tag === "IFRAME" || tag === "FRAME") {
          let doc = null;
          try { doc = node.contentDocument || null; } catch {}
          // A frame whose document this scan read is covered by its own fields.
          if (doc && scanned.has(doc)) continue;
          const reason = this.privateMarked(node) ? "private" : !doc ? "unreadable"
            : !this.sameOriginDocument(doc) ? "cross-origin"
            : (this.frameByDocument.get(node.ownerDocument)?.path.split("/").length || 0) >= MAX_FRAME_DEPTH ? "depth-limit" : "unscanned";
          push(node, "frame", reason);
        } else if (tag === "OBJECT" || tag === "EMBED") {
          push(node, "embedded-object", "embedded-object");
        } else {
          const reason = this.screenshotSensitiveReason(node);
          if (reason) push(node, "sensitive-field", reason);
        }
      }
    }
    return { ...state, ...this.documentIdentity(), complete: incompleteReason === null, incompleteReason,
      regions, regionCount: regions.length };
  }

  // The observe request that carries options.screenshot: a light snapshot
  // of the same document plus the parent's masked capture, or the reason
  // none was sent. The parent holds the one-time ticket it minted on the
  // chrome side's query; this actor only forwards it.
  async screenshotThenSnapshot(options = {}) {
    const { screenshot: spec, wait: _wait, ...snapshotOptions } = options;
    const snapshot = this.snapshot(snapshotOptions);
    let capture;
    if (typeof this.sendQuery !== "function") capture = { send: false, reason: "parent-unavailable" };
    else {
      try {
        capture = await this.sendQuery("captureScreenshot", { ticket: spec.ticket, maxEdge: spec.maxEdge,
          budgetChars: spec.budgetChars, format: spec.format, quality: spec.quality });
      } catch { capture = { send: false, reason: "capture-failed" }; }
    }
    const screenshot = capture && typeof capture === "object" && capture.send === true
      ? capture : { send: false, reason: typeof capture?.reason === "string" ? capture.reason.slice(0, 80) : "capture-failed" };
    return { ...snapshot, screenshot };
  }

  // Visible page text nodes that contain needle (whitespace collapsed,
  // case-sensitive), across the same roots an observation reads. Field
  // values, editors, sensitive controls and hidden text never match.
  visibleTextMatches(doc, needle) {
    const filter = this.contentWindow.NodeFilter;
    let visited = 0, matches = 0;
    for (const root of this.scanRoots(doc, { classify: false }).roots) {
      const isDocument = root === doc || root.nodeType === 9;
      const walkRoot = isDocument ? root.body || root.documentElement : root;
      const owner = isDocument ? root : root.ownerDocument;
      if (!walkRoot || typeof owner?.createTreeWalker !== "function") continue;
      const walker = owner.createTreeWalker(walkRoot, filter.SHOW_TEXT, {
        acceptNode: (node) => {
          if (++visited > MAX_TEXT_MATCH_NODES) return filter.FILTER_REJECT;
          const text = String(node.nodeValue || "").slice(0, 10000).replace(/\s+/g, " ").trim();
          if (!text.includes(needle)) return filter.FILTER_REJECT;
          const parent = node.parentElement || node.parentNode?.host;
          if (!parent || TEXT_EXCLUDED_PARENTS.has(String(parent.tagName || "").toUpperCase()) ||
              !this.isVisible(parent) || this.isSensitiveText(node)) return filter.FILTER_REJECT;
          return filter.FILTER_ACCEPT;
        },
      });
      while (walker.nextNode()) {
        if (++matches >= MAX_TEXT_MATCHES) return matches;
      }
      if (visited > MAX_TEXT_MATCH_NODES) break;
    }
    return matches;
  }

  // Read-only wait inside this document. It never enters perform or takes a
  // lease; a replaced document destroys this actor, so the caller sees no
  // answer (unknown) rather than a claim about the new page.
  async waitThenSnapshot(options = {}) {
    const spec = options.wait;
    const condition = spec?.for;
    if (!["load", "idle", "selector-visible", "text", "text-gone"].includes(condition) ||
        !Number.isSafeInteger(spec.timeoutMs) ||
        spec.timeoutMs < 0 || spec.timeoutMs > MAX_WAIT_MS) throw new Error("Browser wait requires a bounded condition");
    const textCondition = condition === "text" || condition === "text-gone";
    const needle = textCondition && typeof spec.text === "string" ? spec.text.replace(/\s+/g, " ").trim() : "";
    if (textCondition && (!needle || needle.length > MAX_WAIT_TEXT)) {
      throw new Error("Browser text wait requires 1-200 characters of text");
    }
    const doc = this.document;
    if (condition === "selector-visible" && (typeof spec.ref !== "string" || !this.nodeByRef.has(spec.ref) ||
        spec.documentId !== this.observationState().documentId || this.frameForRef(spec.ref) === undefined)) {
      throw new Error("Browser wait target is stale; observe again");
    }
    const started = this.monoNow();
    let lastRevision = null, quietSince = started, matchCount = null, matchRevision = null, polls = 0;
    const met = () => {
      const state = this.observationState();
      if (typeof spec.notDocumentId === "string" && state.documentId === spec.notDocumentId) return false;
      if (condition === "selector-visible") {
        if (state.documentId !== spec.documentId || this.frameForRef(spec.ref) === undefined) {
          throw new Error("Browser wait target is stale; observe again");
        }
        const node = this.nodeForRef(spec.ref);
        return !!node && this.isVisible(node);
      }
      if (textCondition) {
        // Rescan on a DOM change, and every fifth poll for style-only changes.
        if (matchCount === null || state.revision !== matchRevision || polls % 5 === 0) {
          matchCount = this.visibleTextMatches(doc, needle);
          matchRevision = state.revision;
        }
        return condition === "text" ? matchCount > 0 : matchCount === 0;
      }
      if (doc.readyState !== "complete") { lastRevision = null; return false; }
      if (condition === "load") return true;
      const now = this.monoNow();
      if (state.revision !== lastRevision) { lastRevision = state.revision; quietSince = now; }
      return now - quietSince >= this.idleQuietMs;
    };
    let outcome = "timeout";
    for (;; polls++) {
      if (this.document !== doc) throw new Error("Browser document changed during wait; outcome is unknown");
      if (met()) { outcome = "met"; break; }
      if (this.monoNow() - started >= spec.timeoutMs) break;
      await this.sleep(this.waitPollMs);
    }
    if (this.document !== doc) throw new Error("Browser document changed during wait; outcome is unknown");
    const { wait: _wait, ...snapshotOptions } = options;
    // The text itself is never echoed: only whether and how often it matched.
    return { ...this.snapshot(snapshotOptions),
      wait: { for: condition, outcome, elapsedMs: Math.max(0, Math.round(this.monoNow() - started)),
        ...(textCondition ? { matchCount: Math.min(matchCount ?? 0, MAX_TEXT_MATCHES) } : {}) } };
  }

  diffLists(beforeList, afterList, keyFn, limit = 20) {
    const beforeKeys = new Set((beforeList || []).map(keyFn));
    return (afterList || []).filter((item) => !beforeKeys.has(keyFn(item))).slice(0, limit);
  }

  diff(before, after) {
    const newVisibleText = this.diffLists(before?.text, after?.text, (item) => item, 20);
    const removedVisibleText = this.diffLists(after?.text, before?.text, (item) => item, 20);
    const newInteractiveElements = this.diffLists(before?.interactiveElements, after?.interactiveElements, (item) => this.signature(item), 20);
    const removedInteractiveElements = this.diffLists(after?.interactiveElements, before?.interactiveElements, (item) => this.signature(item), 20);
    return {
      urlChanged: before?.url !== after?.url,
      titleChanged: before?.title !== after?.title,
      url: after?.url || "",
      title: after?.title || "",
      newVisibleText,
      removedVisibleText,
      focusedElementChanged: (before?.focusedElement?.ref || null) !== (after?.focusedElement?.ref || null),
      focusedElement: after?.focusedElement || null,
      newInteractiveElements,
      removedInteractiveElements,
      visibleTextChanged: newVisibleText.length > 0 || removedVisibleText.length > 0,
      interactiveChanged: newInteractiveElements.length > 0 || removedInteractiveElements.length > 0,
    };
  }

  dispatchInputEvents(node) {
    const view = this.windowFor(node);
    node.dispatchEvent(new view.Event("input", { bubbles: true, cancelable: true }));
    node.dispatchEvent(new view.Event("change", { bubbles: true, cancelable: true }));
  }

  targetFor(action) {
    if (action.ref) return this.nodeForRef(action.ref);
    if (action.selector) return this.document.querySelector(action.selector);
    return null;
  }

  assertGuard(action, guard) {
    if (!guard || typeof guard !== "object") throw new Error("Guarded Browser action requires observed state");
    const current = this.observationState();
    // L6 a1 (D25): the same checks; the refusal names the fact that moved in one closed word, for the helper's staleBy. The viewport is named before the
    // revision because a viewport change also moves the revision (observationState), and the cause is what the record needs.
    const moved = guard.documentId !== current.documentId ? "document"
      : guard.viewport?.width !== current.viewport.width || guard.viewport?.height !== current.viewport.height
        || guard.viewport?.devicePixelRatio !== current.viewport.devicePixelRatio ? "viewport"
      : guard.revision !== current.revision ? "revision"
      : guard.focusedRef !== (this.focusedElement(this.document)?.ref || null) ? "focus"
      : guard.url !== this.contentWindow.location.href ? "url" : null;
    if (moved) throw new Error(`Browser observation is stale [${moved}]; observe the current page again`);
    // An observed Gecko document identity must still be this actor's.
    const identity = this.documentIdentity();
    for (const key of ["innerWindowId", "browsingContextId"]) {
      if (Object.hasOwn(guard, key) && guard[key] !== identity[key]) {
        throw new Error("Browser observation is stale [identity]; the document changed");
      }
    }
    if (action.type === "navigate") {
      // Guarded model navigation stays on the current document's site.
      if (!this.sameSiteNavigation(this.contentWindow.location.href, action.url)) {
        throw new Error("Browser navigation is limited to the current document site");
      }
      return;
    }
    if (action.type === "scroll") return this.assertScrollGuard(action, guard);
    // L6 a1b: each refusal of the observed element names, in one closed word, which of these same checks refused it (the helper's targetBy).
    if (!action.ref || action.selector || !guard.target || guard.target.ref !== action.ref) {
      throw new Error("Browser action requires an observed element reference [reference]");
    }
    const target = this.guardTarget(action.ref);
    if (!this.isVisible(target) || this.isDisabled(target)) {
      throw new Error(`Browser target is unavailable [${this.isVisible(target) ? "disabled" : "hidden"}]; observe again`);
    }
    if (this.isSensitiveControl(target)) throw new Error("Sensitive fields require the native user path");
    if (action.type === "fill" && !this.isFillableControl(target)) {
      throw new Error("Browser target is not an editable field [not-editable]; observe again");
    }
    if (action.type === "fill" && (typeof action.text !== "string" || action.text.length > MAX_FILL_TEXT)) {
      throw new Error("Browser fill text exceeds the bounded input; use the native user path");
    }
    // Long current values are compared by length and fingerprint (valueFor),
    // so an edit past the first 120 characters still makes the target stale.
    if (this.currentValueLength(target) > MAX_FILL_TEXT) {
      throw new Error("Browser target value exceeds the bounded observation; use the native user path");
    }
    this.assertSameTarget(target, action.ref, guard.target);
    if (action.type === "press") this.assertKeyTarget(action, guard, target);
    if (action.type === "click") this.assertTopmost(target, "Browser target is obscured");
    if (action.type === "pointer-click") this.pointerPlanFor(target, guard);
    if (action.type === "type-text") this.assertTypeTarget(action, guard, target);
  }

  // BRW-10 (REA 웹1): the point a guarded pointer press uses, from the
  // observed bounds only, while the observed frame (document, revision,
  // viewport, DPR, zoom, top scroll) still holds; then the same hit test as a
  // click, at that point. Throws before any input otherwise.
  pointerPlanFor(target, guard) {
    if (!guard.target?.bounds) throw new Error("Browser pointer input refused [target-bounds-unreadable]; observe again");
    const frames = [];
    for (let frame = this.frameByDocument.get(target.ownerDocument); frame; frame = frame.parent) {
      frames.unshift(this.frameContentOffset(frame.frameElement));
    }
    const live = { ...this.observationState(), ...this.zoomState(), scroll: this.scrollState() };
    const observed = { documentId: guard.documentId, revision: guard.revision, viewport: guard.viewport,
      ...(guard.pointer?.zoom !== undefined ? { zoom: guard.pointer.zoom } : {}), scroll: guard.pointer?.scroll };
    const plan = planPointerPress({ observed, live, bounds: guard.target.bounds,
      liveRect: this.viewportRect(target), frameOffsets: frames });
    if (!plan.ok) throw new Error(`Browser pointer input refused [${plan.reason}]; observe again`);
    const hit = this.hitTest(target, plan.inputPoint);
    if (!hit.topmost) {
      const blocker = hit.blocker ? this.describeNode(hit.blocker) : "";
      throw Object.assign(new Error(`Browser target is obscured${blocker ? ` by ${blocker}` : ""}; observe again`),
        blocker ? { obscuredBy: blocker } : {});
    }
    if (!this.pointerSender(this.windowFor(target))) {
      throw new Error("Browser pointer input is unavailable in this Firefox; use egdesk_browser_click or the native user path");
    }
    return plan;
  }

  // BRW-10 (REA 웹2): typing goes to the element that already has the focus
  // in its own document; EG-Desk never moves focus to make it so.
  assertTypeTarget(action, guard, target) {
    const tag = String(target.tagName || "").toLowerCase();
    if (!this.isFillableControl(target) || tag === "select") {
      throw new Error("Browser target is not a text field or editor; observe again");
    }
    if (typeof action.text !== "string" || action.text.length > MAX_FILL_TEXT) {
      throw new Error("Browser typed text exceeds the bounded input; use the native user path");
    }
    if (action.key != null && !Object.hasOwn(GUARDED_KEYS, action.key)) throw new Error("Browser key is outside the guarded key set");
    if (!action.text && action.key == null) throw new Error("Browser typing needs text or a key");
    if (guard.focusedRef !== action.ref || this.deepActiveElement(this.document) !== target) {
      throw new Error("Browser key target is not focused; EG-Desk never moves focus");
    }
    if (!this.createTextInputProcessor()) {
      throw new Error("Browser text input is unavailable in this Firefox; use the native user path");
    }
  }

  // Refuses a click that would land on something else, and says what: a short
  // structural description (tag, id, two classes, role, its ref if observed),
  // never the blocker's text. The receipt carries it as obscuredBy.
  assertTopmost(target, prefix) {
    const hit = this.hitTest(target);
    if (hit.topmost) return;
    // Nothing covers it: scroll it into view first (scroll with its ref).
    if (hit.reason === "outside-viewport") throw new Error(`${prefix}: it is outside the viewport; observe again`);
    const blocker = hit.blocker ? this.describeNode(hit.blocker) : "";
    throw Object.assign(new Error(`${prefix}${blocker ? ` by ${blocker}` : ""}; observe again`),
      blocker ? { obscuredBy: blocker } : {});
  }

  safeIdent(value) {
    const text = String(value || "");
    return /^[A-Za-z][A-Za-z0-9_-]{0,31}$/.test(text) && !/[0-9a-f]{12,}|\d{6,}/i.test(text) ? text : "";
  }

  describeNode(node) {
    const tag = this.safeIdent(String(node?.tagName || "").toLowerCase()) || "element";
    let text = tag;
    const id = this.safeIdent(node.id || node.getAttribute?.("id"));
    if (id) text += `#${id}`;
    else {
      let className = "";
      try { className = typeof node.className === "string" ? node.className : node.getAttribute?.("class") || ""; } catch {}
      const classes = String(className).split(/\s+/).map(name => this.safeIdent(name)).filter(Boolean).slice(0, 2);
      if (classes.length) text += `.${classes.join(".")}`;
      for (let parent = this.composedParent(node), depth = 0; parent && depth < 8; parent = this.composedParent(parent), depth++) {
        const parentId = this.safeIdent(parent.id || parent.getAttribute?.("id"));
        if (parentId) { text += ` inside ${this.safeIdent(String(parent.tagName || "").toLowerCase()) || "element"}#${parentId}`; break; }
      }
    }
    const role = this.safeIdent(node.getAttribute?.("role"));
    if (role) text += ` role=${role}`;
    const ref = this.refByNode.get(node);
    if (typeof ref === "string" && this.refTarget(ref) === node) text += ` ref=${ref}`;
    return text.slice(0, 160);
  }

  // Frame generation first, then the node: a ref from a replaced frame
  // document is stale even while its old node object is still alive.
  guardTarget(ref) {
    if (this.frameForRef(ref) === undefined) throw new Error("Browser frame is stale; observe the current page again");
    const target = this.nodeForRef(ref);
    if (!target) throw new Error("Browser target is unavailable [gone]; observe again");
    return target;
  }

  assertSameTarget(target, ref, expected) {
    const live = this.isCandidate(target) ? this.elementItem(target) : null;
    const moved = !live ? "candidate" : live.ref !== ref ? "reference" : ["role", "label", "href", "value", "tag"].find(key => live[key] !== expected[key]);
    if (moved) throw new Error(`Browser target changed [${moved}]; observe again`);
  }

  // Point a click would use: the centre of the part of the element inside its
  // own viewport (firefox-devtools-mcp src/firefox/dom.ts
  // scrollAndGetInViewCenterPoint, MIT), or null when none of it is inside.
  inViewCenter(rect, view) {
    const width = Number(view?.innerWidth), height = Number(view?.innerHeight);
    if (!(width > 0) || !(height > 0)) return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
    const left = Math.min(Math.max(rect.left, 0), width), right = Math.min(Math.max(rect.left + rect.width, 0), width);
    const top = Math.min(Math.max(rect.top, 0), height), bottom = Math.min(Math.max(rect.top + rect.height, 0), height);
    if (right <= left || bottom <= top) return null;
    return { x: (left + right) / 2, y: (top + bottom) / 2 };
  }

  // The hit counts as the target when it is the node, inside it, or tied to it
  // through a label (agent-browser cli/src/native/element.rs BLOCKER_AT_JS,
  // Apache-2.0: a styled sibling inside the same label stands for the control).
  hitReachesTarget(hit, node) {
    if (hit === node || node.contains?.(hit)) return true;
    try {
      const hitLabel = hit.closest?.("label");
      if (hitLabel && (hitLabel.control === node || hitLabel.contains?.(node))) return true;
      const nodeLabel = node.closest?.("label");
      if (nodeLabel && nodeLabel.contains?.(hit)) return true;
    } catch {}
    return false;
  }

  // Hit test through open and closed shadow roots and same-origin frames,
  // bottom-up like Playwright injectedScript.ts expectHitTarget (Apache-2.0):
  // the target is topmost in its own tree, each shadow host in its tree, and
  // each frame element in its parent document at the translated point.
  hitTest(target, startPoint = null) {
    const point = startPoint || this.inViewCenter(target.getBoundingClientRect(), this.windowFor(target));
    if (!point) return { topmost: false, blocker: null, reason: "outside-viewport" };
    let { x, y } = point, node = target;
    for (let depth = 0; depth < 32; depth++) {
      const root = node.getRootNode?.() || null;
      const ownDocument = this.frameByDocument.get(node.ownerDocument)?.document || this.document;
      const scope = typeof root?.elementFromPoint === "function" ? root : ownDocument;
      const hit = scope.elementFromPoint?.(x, y);
      if (!hit || !this.hitReachesTarget(hit, node)) return { topmost: false, blocker: hit || null };
      if (root?.host) { node = root.host; continue; }
      const frame = this.frameByDocument.get(scope);
      if (!frame) return { topmost: true, blocker: null };
      const offset = this.frameContentOffset(frame.frameElement);
      x += offset.x;
      y += offset.y;
      node = frame.frameElement;
    }
    return { topmost: false, blocker: null };
  }

  targetIsTopmost(target) { return this.hitTest(target).topmost; }

  // Scroll guard: same document/revision (checked above) plus the observed
  // scroll offset, so a human scroll in between makes the request stale.
  assertScrollGuard(action, guard) {
    const scroll = this.scrollState();
    if (!guard.scroll || guard.scroll.x !== scroll.x || guard.scroll.y !== scroll.y) {
      throw new Error("Browser observation is stale [scroll]; the scroll position changed");
    }
    if (action.selector) throw new Error("Browser action requires an observed element reference");
    const boundedDirection = ["up", "down", "top", "bottom"].includes(action.direction) && ["page", "half"].includes(action.amount);
    if (!action.ref) {
      if (guard.target || !boundedDirection) throw new Error("Browser scroll requires a bounded direction");
      return;
    }
    // ref alone scrolls that element into view; ref with a direction scrolls
    // inside that observed scroll container.
    const container = action.direction != null;
    if ((container && !boundedDirection) || (!container && action.amount != null) ||
        !guard.target || guard.target.ref !== action.ref) {
      throw new Error("Browser action requires an observed element reference [reference]");
    }
    const target = this.guardTarget(action.ref);
    if (!this.isVisible(target)) throw new Error("Browser target is unavailable [hidden]; observe again");
    this.assertSameTarget(target, action.ref, guard.target);
    if (!container) return;
    const state = this.scrollContainerState(target);
    if (!state) throw new Error("Browser target is not a scrollable container; observe again");
    if (!guard.containerScroll || guard.containerScroll.x !== state.x || guard.containerScroll.y !== state.y) {
      throw new Error("Browser observation is stale [scroll]; the container scroll position changed");
    }
  }

  // Key input never moves focus: the target is the focused element, or the
  // field the previous guarded action filled in this same document.
  assertKeyTarget(action, guard, target) {
    if (typeof action.key !== "string" || !Object.hasOwn(GUARDED_KEYS, action.key)) {
      throw new Error("Browser key is outside the guarded key set");
    }
    if (guard.pressPolicy === "already-focused") {
      if (this.deepActiveElement(this.document) !== target) throw new Error("Browser key target is not focused; EG-Desk never moves focus");
      return;
    }
    if (guard.pressPolicy === "after-fill") {
      if (this.lastGuardedFill?.ref !== action.ref || this.lastGuardedFill.node !== target ||
          !this.isFillableControl(target)) throw new Error("Browser key target is not the field just filled; observe the focused element");
      return;
    }
    throw new Error("Browser key input requires a focus policy");
  }

  guardedScroll(action) {
    const win = this.contentWindow;
    const before = this.scrollState();
    if (action.ref && action.direction != null) {
      const target = this.nodeForRef(action.ref);
      const from = target && this.scrollContainerState(target);
      if (!from) throw new Error(`Browser scroll container not found: ${action.ref}`);
      const height = Math.max(0, Math.round(Number(target.clientHeight) || 0));
      const step = Math.round(height * (action.amount === "half" ? 0.5 : 0.9));
      this.markFirstEvent();
      if (action.direction === "top") target.scrollTo?.({ left: from.x, top: 0, behavior: "instant" });
      else if (action.direction === "bottom") target.scrollTo?.({ left: from.x, top: from.maxY, behavior: "instant" });
      else target.scrollBy?.({ left: 0, top: action.direction === "down" ? step : -step, behavior: "instant" });
      const to = this.scrollContainerState(target) || { x: from.x, y: from.y, maxY: from.maxY };
      return { ok: true, dispatchDiagnostics: { inputRoute: "dom-scroll-api", mode: "container",
        containerBefore: from, containerAfter: to } };
    }
    if (action.ref) {
      const target = this.nodeForRef(action.ref);
      if (!target) throw new Error(`Browser agent target not found: ${action.ref}`);
      this.markFirstEvent();
      target.scrollIntoView?.({ block: "center", inline: "nearest", behavior: "instant" });
      const rect = target.getBoundingClientRect ? this.viewportRect(target) : null;
      const targetInView = !!rect && rect.width > 0 && rect.height > 0 && rect.top < win.innerHeight &&
        rect.top + rect.height > 0 && rect.left < win.innerWidth && rect.left + rect.width > 0;
      const after = this.scrollState();
      return { ok: true, dispatchDiagnostics: { inputRoute: "dom-scroll-api", mode: "into-view",
        scrollBefore: { x: before.x, y: before.y }, scrollAfter: { x: after.x, y: after.y }, targetInView } };
    }
    const height = Math.max(0, Math.round(Number(win.innerHeight) || 0));
    const step = Math.round(height * (action.amount === "half" ? 0.5 : 0.9));
    this.markFirstEvent();
    if (action.direction === "top") win.scrollTo({ left: before.x, top: 0, behavior: "instant" });
    else if (action.direction === "bottom") win.scrollTo({ left: before.x, top: before.maxY, behavior: "instant" });
    else win.scrollBy({ left: 0, top: action.direction === "down" ? step : -step, behavior: "instant" });
    const after = this.scrollState();
    return { ok: true, dispatchDiagnostics: { inputRoute: "dom-scroll-api", mode: "document",
      scrollBefore: { x: before.x, y: before.y }, scrollAfter: { x: after.x, y: after.y }, maxScrollY: after.maxY } };
  }

  // HTML implicit submission: click the form's default button, or submit a
  // form with a single blocking field; otherwise there is no default action.
  implicitSubmission(target) {
    const typeOf = node => String(node?.type || node?.getAttribute?.("type") || "text").toLowerCase();
    const tagOf = node => String(node?.tagName || "").toLowerCase();
    if (tagOf(target) !== "input" || !IMPLICIT_SUBMIT_TYPES.includes(typeOf(target))) return null;
    const form = target.form;
    if (!form || typeof form.requestSubmit !== "function") return null;
    const elements = Array.from(form.elements || []);
    const submitter = elements.find(node => (tagOf(node) === "button" && typeOf(node) === "submit") ||
      (tagOf(node) === "input" && ["submit", "image"].includes(typeOf(node))));
    if (submitter) return this.isDisabled(submitter) || typeof submitter.click !== "function" ? null : { form, submitter };
    const blocking = elements.filter(node => tagOf(node) === "input" && IMPLICIT_SUBMIT_TYPES.includes(typeOf(node)));
    return blocking.length > 1 ? null : { form, submitter: null };
  }

  guardedPress(target, action, guard) {
    this.assertKeyTarget(action, guard, target);
    const keySpec = GUARDED_KEYS[action.key];
    const view = this.windowFor(target);
    const KeyboardEvent = view.KeyboardEvent;
    if (typeof KeyboardEvent !== "function") throw new Error("Browser key events are unavailable; use the native user path");
    const init = { key: keySpec.key, code: keySpec.code, keyCode: keySpec.keyCode, which: keySpec.keyCode,
      bubbles: true, cancelable: true, composed: true, view };
    let targetKeyObserved = false;
    const onKey = () => { targetKeyObserved = true; };
    target.addEventListener?.("keydown", onKey, true);
    let keydownNotCanceled;
    this.markFirstEvent();
    try { keydownNotCanceled = target.dispatchEvent(new KeyboardEvent("keydown", init)); }
    finally { target.removeEventListener?.("keydown", onKey, true); }
    let keypressNotCanceled = keydownNotCanceled;
    if (keySpec.charCode && keydownNotCanceled) {
      keypressNotCanceled = target.dispatchEvent(new KeyboardEvent("keypress", { ...init, charCode: keySpec.charCode }));
    }
    let defaultActionEmulated = null;
    if (action.key === "Enter" && keydownNotCanceled && keypressNotCanceled && target.isConnected) {
      const submission = this.implicitSubmission(target);
      // The default button gets the same focus-free DOM click as guarded clicks.
      if (submission?.submitter) { submission.submitter.click(); defaultActionEmulated = "default-button-click"; }
      else if (submission) { submission.form.requestSubmit(); defaultActionEmulated = "form-request-submit"; }
    }
    target.dispatchEvent(new KeyboardEvent("keyup", init));
    return { ok: true, ref: action.ref, key: action.key, dispatchDiagnostics: { inputRoute: "dom-keyboard-event",
      key: action.key, trustedInput: false, targetKeyObserved, keydownDefaultPrevented: !keydownNotCanceled,
      defaultActionEmulated, focusPolicy: guard.pressPolicy } };
  }

  // Guarded fill never calls focus or the Selection API. A field gets the
  // value setter (which moves that field's own caret to the end, as any
  // script assignment does) then input and change. An editor gets a
  // cancelable beforeinput; if the page does not cancel it, EG-Desk replaces
  // the editor text and dispatches input, otherwise the page decides alone.
  // The receipt states that order; only the after-snapshot proves the value.
  guardedFill(target, ref, text) {
    if (this.isEditingHost(target)) {
      const InputEvent = this.windowFor(target).InputEvent;
      if (typeof InputEvent !== "function") throw new Error("Browser input events are unavailable; use the native user path");
      const init = { bubbles: true, cancelable: true, composed: true, inputType: "insertReplacementText", data: text };
      this.markFirstEvent();
      const beforeInputNotCanceled = target.dispatchEvent(new InputEvent("beforeinput", init));
      const eventOrder = ["beforeinput"];
      let egdeskWroteContent = false;
      if (beforeInputNotCanceled && target.isConnected) {
        this.writeEditorText(target, text);
        egdeskWroteContent = true;
        target.dispatchEvent(new InputEvent("input", { ...init, cancelable: false }));
        eventOrder.push("input");
      }
      return { ok: true, ref, dispatchDiagnostics: { inputRoute: "dom-editor-replace", trustedInput: false,
        focusApi: "not-called", selectionApi: "not-called", eventOrder, beforeInputCanceled: !beforeInputNotCanceled,
        egdeskWroteContent, readbackMatches: this.editorText(target) === text } };
    }
    if (!("value" in target)) throw new Error(`Browser agent target is not editable: ${ref}`);
    this.markFirstEvent();
    target.value = text;
    this.dispatchInputEvents(target);
    return { ok: true, ref, dispatchDiagnostics: { inputRoute: "dom-value-setter", trustedInput: false,
      focusApi: "not-called", selectionApi: "not-called", eventOrder: ["input", "change"], beforeInputCanceled: null,
      egdeskWroteContent: true, readbackMatches: String(target.value ?? "") === text } };
  }

  clickTarget(target, { avoidFocus = false } = {}) {
    const rect = target.getBoundingClientRect();
    if (avoidFocus) this.assertTopmost(target, "Browser target became obscured before click");
    if (avoidFocus) {
      if (typeof target.click !== "function") {
        throw new Error("Browser target has no focus-safe DOM click; use the native user path");
      }
      // A DOM click has activation behavior without Gecko's mousedown focus
      // default. A site click handler may still focus another element itself.
      let targetClickObserved = false;
      const onClick = () => { targetClickObserved = true; };
      target.addEventListener?.("click", onClick, true);
      this.markFirstEvent();
      try { target.click(); }
      finally { target.removeEventListener?.("click", onClick, true); }
      return { usedWindowUtils: false, dispatchScope: "dom-click-no-pointerdown", targetClickObserved };
    }
    target.focus?.();
    const x = Math.round(rect.left + rect.width / 2);
    const y = Math.round(rect.top + rect.height / 2);
    const utils = this.contentWindow.windowUtils;
    const eventResults = [];
    // The legacy unguarded path stays inside this Browser document too;
    // guarded model clicks above never send a mousedown at all.
    if (typeof utils?.sendMouseEventToWindow === "function") {
      utils.sendMouseEventToWindow("mousemove", x, y, 0, 0, 0);
      utils.sendMouseEventToWindow("mousedown", x, y, 0, 1, 0);
      utils.sendMouseEventToWindow("mouseup", x, y, 0, 1, 0);
      return { usedWindowUtils: true, dispatchScope: "document-window", x, y };
    }
    for (const eventName of ["pointerdown", "mousedown", "pointerup", "mouseup"]) {
      const Ctor = eventName.startsWith("pointer") && this.contentWindow.PointerEvent
        ? this.contentWindow.PointerEvent
        : this.contentWindow.MouseEvent;
      eventResults.push({
        eventName,
        notCanceled: target.dispatchEvent(new Ctor(eventName, {
          bubbles: true,
          cancelable: true,
          view: this.contentWindow,
          button: 0,
          buttons: eventName.endsWith("down") ? 1 : 0,
        })),
      });
    }
    // HTMLElement.click supplies the single click event; dispatching a second
    // synthetic click here can duplicate form submission or other effects.
    target.click?.();
    return { usedWindowUtils: false, dispatchScope: "dom-fallback", x, y, eventResults };
  }

  // Which Gecko chrome API turns CSS px in this window into trusted mouse
  // input, by feature detection: Window.synthesizeMouseEvent [ChromeOnly]
  // (Firefox 153 ESR / 159), nsIDOMWindowUtils.sendMouseEvent, then
  // sendMouseEventToWindow (ESR 140). Gecko maps the point with the pres
  // context, so page zoom and DPR are applied there. null when none exists.
  // Not run in this repository's tests against a real Gecko (REA §7).
  pointerSender(view) {
    if (typeof view?.synthesizeMouseEvent === "function") {
      return { route: "synthesizeMouseEvent", send: (type, x, y, buttons) => view.synthesizeMouseEvent(type, x, y,
        { button: 0, buttons, clickCount: type === "mousemove" ? 0 : 1 }, { toWindow: true }) };
    }
    let utils = null;
    try { utils = view?.windowUtils || null; } catch {}
    if (typeof utils?.sendMouseEvent === "function") {
      return { route: "sendMouseEvent", send: (type, x, y) => utils.sendMouseEvent(type, x, y, 0, type === "mousemove" ? 0 : 1, 0) };
    }
    if (typeof utils?.sendMouseEventToWindow === "function") {
      return { route: "sendMouseEventToWindow",
        send: (type, x, y) => utils.sendMouseEventToWindow(type, x, y, 0, type === "mousemove" ? 0 : 1, 0) };
    }
    return null;
  }

  // Target-side listeners for a trusted input receipt: which events reached
  // the target (or inside it) and whether every one was trusted. Capture-only,
  // never cancel, removed in finally.
  watchTargetEvents(target, names) {
    const seen = Object.fromEntries(names.map(name => [name, false]));
    let trusted = null;
    const listener = event => {
      seen[event?.type] = true;
      trusted = (trusted ?? true) && event?.isTrusted === true;
    };
    for (const name of names) target.addEventListener?.(name, listener, true);
    return { seen, get trusted() { return trusted; },
      stop() { for (const name of names) target.removeEventListener?.(name, listener, true); } };
  }

  // BRW-10 (REA 웹1): one move -> down -> up at the planned point. If the
  // down was sent and the up was not, one up is sent in finally (a release,
  // not a cancel). Never retried; never a fallback for a DOM click (EG-01).
  guardedPointerClick(target, action, guard) {
    const plan = this.pointerPlanFor(target, guard);
    const sender = this.pointerSender(this.windowFor(target));
    const { x, y } = plan.inputPoint;
    const watch = this.watchTargetEvents(target, ["pointerdown", "mousedown", "mouseup", "click"]);
    let moveDispatched = false, downAttempted = false, downDispatched = false, upDispatched = false, compensatedUp = false;
    this.markFirstEvent();
    try {
      sender.send("mousemove", x, y, 0);
      moveDispatched = true;
      downAttempted = true;
      sender.send("mousedown", x, y, 1);
      downDispatched = true;
      sender.send("mouseup", x, y, 0);
      upDispatched = true;
    } finally {
      if (downAttempted && !upDispatched) {
        try { sender.send("mouseup", x, y, 0); compensatedUp = true; } catch {}
      }
      watch.stop();
    }
    return { ok: true, ref: action.ref, dispatchDiagnostics: { inputRoute: "trusted-pointer", apiRoute: sender.route,
      trustedInput: true, point: plan.inputPoint, displayPoint: plan.displayPoint, moveDispatched, downDispatched,
      upDispatched, compensatedUp, targetPointerObserved: watch.seen.pointerdown || watch.seen.mousedown,
      targetClickObserved: watch.seen.click, eventsTrusted: watch.trusted } };
  }

  // nsITextInputProcessor for one window, or null where unavailable.
  createTextInputProcessor() {
    try {
      const Cc = globalThis.Cc ?? globalThis.Components?.classes, Ci = globalThis.Ci ?? globalThis.Components?.interfaces;
      if (!Cc || !Ci?.nsITextInputProcessor) return null;
      return Cc["@mozilla.org/text-input-processor;1"]?.createInstance(Ci.nsITextInputProcessor) || null;
    } catch { return null; }
  }

  // BRW-10 (REA 웹2): text through the focused element's own text input
  // path (commitCompositionWith, so editors receive real beforeinput/input),
  // then at most one guarded key (TIP keydown/keyup; the browser runs its
  // default action, e.g. Enter submits). No Enter emulation, no focus move.
  // A busy transaction (the person composing with an IME) sends nothing.
  guardedType(target, action, guard) {
    const view = this.windowFor(target);
    const tip = this.createTextInputProcessor();
    if (!tip) throw new Error("Browser text input is unavailable in this Firefox; use the native user path");
    const text = String(action.text ?? "");
    const watch = this.watchTargetEvents(target, ["beforeinput", "input", "keydown"]);
    let textCommitted = false, keydownConsumed = null, keyDispatched = false;
    try {
      if (!tip.beginInputTransaction(view, () => true)) {
        throw new Error("Browser text input is busy (an input method is composing); observe again");
      }
      this.markFirstEvent();
      if (text) textCommitted = tip.commitCompositionWith(text) !== false;
      if (action.key != null) {
        const spec = GUARDED_KEYS[action.key];
        const event = new view.KeyboardEvent("", { key: spec.key, code: spec.code, keyCode: spec.keyCode });
        const flags = Number(tip.keydown(event)) || 0;
        keyDispatched = true;
        keydownConsumed = (flags & (tip.KEYDOWN_IS_CONSUMED ?? 1)) !== 0;
        tip.keyup(event);
      }
    } finally { watch.stop(); }
    let documentHasFocus = null;
    try { documentHasFocus = target.ownerDocument?.hasFocus?.() ?? null; } catch {}
    return { ok: true, ref: action.ref, dispatchDiagnostics: { inputRoute: "trusted-text-input", trustedInput: true,
      textCommitted, textLength: text.length, key: action.key ?? null, keyDispatched, keydownConsumed,
      targetInputObserved: watch.seen.input || watch.seen.beforeinput, targetKeyObserved: watch.seen.keydown,
      eventsTrusted: watch.trusted, documentHasFocus: typeof documentHasFocus === "boolean" ? documentHasFocus : null,
      focusPolicy: guard.focusedRef === action.ref ? "already-focused" : null } };
  }

  perform(action = {}, options = {}) {
    const type = action.type || action.action || "snapshot";
    // Any other guarded action ends the "just filled" key-input eligibility.
    if (options.guard && !(type === "press" && action.ref === this.lastGuardedFill?.ref)) this.lastGuardedFill = null;
    if (type === "navigate") {
      const url = this.safeNavigationUrl(action.url || action.value);
      if (!url) throw new Error("Browser navigation requires an absolute http(s) URL without credentials");
      this.markFirstEvent();
      this.contentWindow.location.href = url;
      return { ok: true };
    }
    if (type === "scroll") {
      if (options.guard) return this.guardedScroll(action);
      this.contentWindow.scrollBy({ left: action.dx || 0, top: action.dy || action.deltaY || 0, behavior: "instant" });
      return { ok: true };
    }
    if (type === "snapshot") return { ok: true };

    const target = this.targetFor(action);
    if (!target) throw new Error(`Browser agent target not found: ${action.ref || action.selector || ""}`);
    if (type === "press" && options.guard) return this.guardedPress(target, action, options.guard);
    // BRW-10: guarded only, and never scrolled first (the observed point must hold).
    if (type === "pointer-click" || type === "type-text") {
      if (!options.guard) throw new Error(`Unsupported browser agent action: ${type}`);
      return type === "pointer-click" ? this.guardedPointerClick(target, action, options.guard)
        : this.guardedType(target, action, options.guard);
    }
    target.scrollIntoView?.({ block: "center", inline: "center" });

    if (type === "click") {
      return {
        ok: true,
        ref: action.ref || this.elementRef(target),
        clickDiagnostics: this.clickTarget(target, { avoidFocus: !!options.guard }),
      };
    }

    if (type === "fill" && options.guard) {
      const result = this.guardedFill(target, action.ref, String(action.text));
      this.lastGuardedFill = { ref: action.ref, node: target };
      return result;
    }

    if (type === "fill" || type === "type") {
      if (!options.guard) target.focus?.();
      const value = String(action.text ?? action.value ?? "");
      if ("value" in target) {
        target.value = type === "type" ? String(target.value || "") + value : value;
      } else if (target.isContentEditable) {
        target.textContent = type === "type" ? String(target.textContent || "") + value : value;
      } else {
        throw new Error(`Browser agent target is not editable: ${action.ref || action.selector || ""}`);
      }
      this.dispatchInputEvents(target);
      return { ok: true, ref: action.ref || this.elementRef(target) };
    }

    if (type === "press") {
      target.focus?.();
      const key = String(action.key || "Enter");
      const eventInit = { key, bubbles: true, cancelable: true, view: this.contentWindow };
      target.dispatchEvent(new this.contentWindow.KeyboardEvent("keydown", eventInit));
      target.dispatchEvent(new this.contentWindow.KeyboardEvent("keyup", eventInit));
      return { ok: true, ref: action.ref || this.elementRef(target), key };
    }

    throw new Error(`Unsupported browser agent action: ${type}`);
  }

  async act(action = {}, options = {}) {
    // Timing and phase are recorded for guarded actions only (REA 웹8 a, 웹10).
    const timing = { performCallsBefore: this.actorPerformCalls };
    const guarded = !!options.guard;
    // Hop record: when this actor received the request, on the shared clock.
    if (guarded) timing.actorReceivedAtMs = this.clockMs();
    const budgetDeadline = guarded ? this.budgetDeadline(options.budgetMs) : Infinity;
    const keys = guarded ? this.performKeys(options) : [];
    let entered = false;
    try {
      if (guarded) this.assertGuard(action, options.guard);
      const before = this.snapshot(options.snapshot || {});
      const lease = options.lease;
      if (guarded) {
        if (!lease || typeof lease.leaseId !== "string" || !lease.leaseId ||
            typeof lease.requestId !== "string" || !lease.requestId ||
            !Number.isSafeInteger(lease.deadlineMs) || this.remainingMs(lease, budgetDeadline) <= 0 ||
            typeof this.sendQuery !== "function") throw new Error("Browser action lease is missing or expired");
        if (this.isFenced(keys)) throw new Error("Browser action was reconciled as never sent; observe again");
        const authorization = await this.sendQuery("authorizeAct", {
          leaseId: lease.leaseId, requestId: lease.requestId, deadlineMs: lease.deadlineMs,
          actionType: action.type, actionRef: action.ref || null, actionUrl: action.url || null,
        });
        if (authorization?.authorized !== true || this.remainingMs(lease, budgetDeadline) <= 0) {
          const reason = this.remainingMs(lease, budgetDeadline) <= 0 ? "deadline-expired-after-approval" :
            /^(?:missing-browsing-context|missing-embedder|missing-authorizer|ui-denied|parent-callback-error)$/.test(authorization?.reason)
              ? authorization.reason : "unknown";
          throw new Error(`Browser action authority was revoked before input [${reason}]`);
        }
        // The parent checked the current run/Card/account authority after the
        // asynchronous actor hop. Recheck live page state immediately before I/O.
        this.assertGuard(action, options.guard);
        // A reconcile answered while approval was pending fenced this request.
        if (this.isFenced(keys)) throw new Error("Browser action was reconciled as never sent; observe again");
        // REA 웹8 (b): a multi-step trusted input starts only if it can finish
        // inside the budget; refused here, before perform, it was never sent.
        if (TRUSTED_INPUT_ACTIONS.has(action.type) && this.remainingMs(lease, budgetDeadline) < POINTER_MIN_REMAINING_MS) {
          throw new Error("Browser input budget is too short for a trusted input sequence; observe again");
        }
      }
      const navigation = guarded ? this.watchNavigation() : null;
      try {
        // Failed perform calls also count. An unchanged count proves this actor
        // never entered perform; it does not count physical events or successes.
        this.actorPerformCalls++;
        entered = true;
        timing.performEnterMs = this.clockMs();
        const performStartedMono = this.monoNow();
        const record = guarded ? this.recordPerformEntry(keys, timing.performEnterMs) : null;
        let result;
        this.performTiming = guarded ? timing : null;
        try { result = this.perform(action, options); }
        finally {
          this.performTiming = null;
          timing.performExitMs = this.clockMs();
          if (record) record.exitMs = timing.performExitMs;
        }
        const settle = guarded
          ? await this.settleAfterPerform({ action, lease, budgetDeadline, navigation, since: performStartedMono,
            limits: options.settle })
          : await this.sleep(Number.isFinite(options.settleMs) ? options.settleMs : 250).then(() => null);
        const after = this.snapshot(options.snapshot || {});
        timing.performCallsAfter = this.actorPerformCalls;
        const observation = this.diff(before, after);
        if (settle) observation.settle = settle;
        return {
          ok: true,
          action,
          result,
          before,
          after,
          observation,
          ...(guarded ? { timing: this.timingRecord(timing) } : {}),
        };
      } finally { navigation?.stop(); }
    } catch (error) {
      if (guarded && error && typeof error === "object") {
        timing.performCallsAfter = this.actorPerformCalls;
        // "not-dispatched" only when this call never entered perform and the
        // perform-entry count did not move meanwhile.
        error.dispatchPhase = entered ? "dispatched"
          : timing.performCallsAfter === timing.performCallsBefore ? "not-dispatched" : "unknown";
        error.timing = this.timingRecord(timing);
      }
      throw error;
    }
  }

  // Settle after a guarded action: watch every pollMs until neither the DOM
  // nor the page's fetch/XHR list changed for quietMs, a navigation starts,
  // or the cap. The cap never spends the reply budget (REA 웹8 c): it is
  // min(1500 ms, what the lease or relative budget leaves - 500 ms). The
  // receipt keeps request paths only; a query shows as "?…".
  // Pattern: nanobrowser core/interaction/evidence.ts (Apache-2.0),
  // chrome-devtools-mcp WaitForHelper.ts (Apache-2.0), Playwright
  // tools/backend/utils.ts waitForCompletion (Apache-2.0).
  async settleAfterPerform({ action, lease, budgetDeadline, navigation, since, limits }) {
    const started = this.monoNow();
    const bounded = (value, fallback, max) => Number.isFinite(value) ? Math.max(0, Math.min(value, max)) : fallback;
    const requestedCap = bounded(limits?.maxMs, SETTLE_CAP_MS, SETTLE_CAP_MS);
    const quietMs = bounded(limits?.quietMs, this.settleQuietMs, SETTLE_CAP_MS);
    const pollMs = Math.max(1, bounded(limits?.pollMs, this.settlePollMs, 250));
    const cap = Math.max(0, Math.min(requestedCap, this.remainingMs(lease, budgetDeadline) - SETTLE_RESPONSE_MARGIN_MS));
    const doc = this.document;
    let revision = this.observationState().revision, requests = this.settleRequests(since), domChanges = 0;
    let quietSince = started;
    // A navigate action has nothing to settle in this document.
    let endedBy = action.type === "navigate" ? "navigation-requested" : null;
    while (!endedBy) {
      if (navigation?.started) { endedBy = "navigation-started"; break; }
      const elapsed = this.monoNow() - started;
      if (elapsed >= cap) { endedBy = cap < requestedCap ? "deadline" : "cap"; break; }
      await this.sleep(Math.min(pollMs, cap - elapsed));
      if (this.document !== doc) { endedBy = "document-changed"; break; }
      if (navigation?.started) { endedBy = "navigation-started"; break; }
      const now = this.monoNow();
      const nextRevision = this.observationState().revision;
      const nextRequests = this.settleRequests(since);
      if (nextRevision !== revision || nextRequests.count !== requests.count) {
        if (nextRevision !== revision) domChanges++;
        revision = nextRevision;
        requests = nextRequests;
        quietSince = now;
      } else if (now - quietSince >= quietMs) endedBy = "quiet";
    }
    return { waitedMs: Math.max(0, Math.round(this.monoNow() - started)), endedBy, domChanges,
      requests: requests.paths,
      ...(requests.count > requests.paths.length ? { moreRequests: requests.count - requests.paths.length } : {}) };
  }

  // fetch/XHR/beacon requests this page finished since the action started
  // (Resource Timing: an entry appears when its response ends).
  settleRequests(sinceMono) {
    let entries = [];
    try { entries = Array.from(this.contentWindow?.performance?.getEntriesByType?.("resource") || []); } catch {}
    const base = this.contentWindow?.location?.href;
    const seen = entries.filter(entry => Number(entry?.startTime) >= sinceMono &&
      REQUEST_INITIATORS.has(String(entry?.initiatorType)));
    return { count: seen.length, paths: seen.slice(0, MAX_SETTLE_REQUESTS).map(entry =>
      ({ path: this.requestPath(entry.name, base), type: String(entry.initiatorType) })) };
  }

  // A request URL as a receipt prints it: its path, its origin only when that
  // differs from the page's, never user info, query or fragment ("?…" marks a
  // query), and only the scheme of a non-http(s) URL. Same rule as nanobrowser
  // evidence.ts requestUrl (Apache-2.0), written for EG-Desk.
  requestPath(url, base) {
    try {
      const parsed = new URL(String(url));
      if (!["http:", "https:"].includes(parsed.protocol)) return `${parsed.protocol}…`;
      let sameOrigin = false;
      try { sameOrigin = parsed.origin === new URL(base).origin; } catch {}
      const where = sameOrigin ? "" : `${parsed.protocol}//${parsed.host}`;
      return `${where}${parsed.pathname}${parsed.search ? "?…" : ""}`.slice(0, 200);
    } catch { return "(unreadable URL)"; }
  }

  // Watches for this document starting to unload while a guarded action
  // settles, so the receipt returns before the actor goes away. Listeners are
  // capture-only, never cancel anything and are removed when settle ends.
  watchNavigation() {
    const state = { started: false, stop() {} };
    const win = this.contentWindow;
    if (typeof win?.addEventListener !== "function") return state;
    const onUnload = () => { state.started = true; };
    try {
      win.addEventListener("beforeunload", onUnload, true);
      win.addEventListener("pagehide", onUnload, true);
      state.stop = () => {
        try { win.removeEventListener("beforeunload", onUnload, true); } catch {}
        try { win.removeEventListener("pagehide", onUnload, true); } catch {}
      };
    } catch {}
    return state;
  }

  performKeys(options = {}) {
    const keys = [];
    const valid = value => typeof value === "string" && value.length > 0 && value.length <= 160;
    if (valid(options.callId)) keys.push(`call:${options.callId}`);
    if (valid(options.lease?.requestId)) keys.push(`request:${options.lease.requestId}`);
    return keys;
  }

  isFenced(keys) { return keys.some(key => this.fences.has(key)); }

  recordPerformEntry(keys, enterMs) {
    const record = { enterMs, exitMs: null, documentId: this.documentId };
    for (const key of keys) {
      this.performRecords.delete(key);
      this.performRecords.set(key, record);
    }
    while (this.performRecords.size > MAX_PERFORM_RECORDS) {
      this.performRecords.delete(this.performRecords.keys().next().value);
      this.performRecordsEvicted = true;
    }
    return record;
  }

  // BRW-12: did an earlier guarded request (by call ID or lease request ID)
  // enter perform in this document? true when recorded (performing while
  // perform has not returned, e.g. a page dialog holds it); false only for
  // this same observed document with no record, and that key is then fenced
  // so the request can never enter later; otherwise "unknown". Read-only.
  reconcile(data = {}) {
    const valid = value => typeof value === "string" && value.length > 0 && value.length <= 160;
    const keys = [...(valid(data.callId) ? [`call:${data.callId}`] : []),
      ...(valid(data.requestId) ? [`request:${data.requestId}`] : [])];
    if (!keys.length) throw new Error("Browser reconcile requires a call or request ID");
    const answer = { version: 1, ...(valid(data.callId) ? { callId: data.callId } : {}),
      ...(valid(data.requestId) ? { requestId: data.requestId } : {}), documentId: this.documentId };
    const record = keys.map(key => this.performRecords.get(key)).find(Boolean);
    if (record) {
      return { ...answer, entered: true, performing: record.exitMs == null,
        timing: this.timingRecord({ performEnterMs: record.enterMs, performExitMs: record.exitMs }) };
    }
    if (data.documentId !== this.documentId) return { ...answer, entered: "unknown", reason: "other-document" };
    if (this.performRecordsEvicted) return { ...answer, entered: "unknown", reason: "record-evicted" };
    for (const key of keys) this.fences.add(key);
    while (this.fences.size > MAX_FENCES) this.fences.delete(this.fences.values().next().value);
    return { ...answer, entered: false, fenced: true };
  }

  // Only finite, non-negative stamps and safe-integer counts leave the actor.
  timingRecord(timing) {
    const record = {};
    for (const key of ["actorReceivedAtMs", "performEnterMs", "performExitMs", "firstEventAtMs"]) {
      if (Number.isFinite(timing[key]) && timing[key] >= 0) record[key] = timing[key];
    }
    for (const key of ["performCallsBefore", "performCallsAfter"]) {
      if (Number.isSafeInteger(timing[key]) && timing[key] >= 0) record[key] = timing[key];
    }
    return record;
  }

  // Structured answer for a refused guarded act. The phase is the actor's own
  // claim; the chrome side still decides with the lease it holds.
  guardedRefusal(error) {
    const phase = DISPATCH_PHASES.has(error?.dispatchPhase) ? error.dispatchPhase : "unknown";
    const timing = error?.timing && typeof error.timing === "object" ? this.timingRecord(error.timing) : {};
    if (phase === "not-dispatched") {
      for (const key of ["performEnterMs", "performExitMs", "firstEventAtMs"]) delete timing[key];
    }
    const obscuredBy = typeof error?.obscuredBy === "string" && error.obscuredBy ? { obscuredBy: error.obscuredBy.slice(0, 160) } : {};
    return { ok: false, refused: true, error: String(error?.message || error || "Browser action was refused").slice(0, 500),
      dispatchPhase: phase, timing, ...obscuredBy };
  }
}
