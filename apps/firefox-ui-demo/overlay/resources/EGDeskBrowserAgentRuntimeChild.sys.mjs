import { captureDocumentText } from './EGDeskInputContext.sys.mjs';

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
const INTERACTIVE_SELECTOR = ["a[href]", "button", "input", "textarea", "select", "[role]", "[tabindex]",
  '[contenteditable=""]', '[contenteditable="true" i]', '[contenteditable="plaintext-only" i]'].join(",");
const MUTATION_OPTIONS = Object.freeze({ subtree: true, childList: true, attributes: true, characterData: true });
// Settle never spends the reply budget: min(requested, lease deadline - margin) (REA 웹8 c).
const SETTLE_RESPONSE_MARGIN_MS = 500;
// The only dispatch phases a guarded refusal may claim (helper contract B).
const DISPATCH_PHASES = new Set(["not-dispatched", "dispatched", "unknown"]);

export class EGDeskBrowserAgentRuntimeChild extends JSWindowActorChild {
  constructor() {
    super();
    this.refByNode = new WeakMap();
    this.nodeByRef = new Map();
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
  }

  async receiveMessage(message) {
    // System presentation signal: no request options, observation, or action authority.
    if (message.name === "presentationMetrics") return this.presentationMetrics();
    const data = message.data || {};
    if (message.name === "snapshot") {
      return data.options?.wait ? this.waitThenSnapshot(data.options) : this.snapshot(data.options || {});
    }
    if (message.name === "captureInput") return captureDocumentText(this.document, data.options || {});
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
    const existing = this.refByNode.get(node);
    if (existing) return existing;
    const frame = this.frameByDocument.get(node?.ownerDocument);
    const ref = `${frame ? `${frame.path}/` : ""}el_${++this.refSeq}`;
    this.refByNode.set(node, ref);
    this.nodeByRef.set(ref, node);
    return ref;
  }

  // Stale like remote/shared/DOM.sys.mjs:552 isStale: disconnected, or its
  // document is no longer the active document of its browsing context.
  nodeForRef(ref) {
    const node = this.nodeByRef.get(ref);
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
    return tag || "element";
  }

  privateMarked(node) {
    const flag = name => { const value = node?.getAttribute?.(name); return value != null && value !== "false"; };
    return flag("data-sensitive") || flag("data-private");
  }

  // Editors go through the same hints as fields; their text itself is never
  // observed (see valueFor/labelFor/isSensitiveText).
  isSensitiveControl(node) {
    if (!node) return false;
    const tag = String(node.tagName || "").toLowerCase();
    if (!node.isContentEditable && !["input", "textarea", "select"].includes(tag)) return false;
    const type = String(node.type || node.getAttribute?.("type") || "").toLowerCase();
    if (["password", "hidden"].includes(type)) return true;
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
    if (node.id) {
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
        || (editor ? "" : node.innerText || node.textContent)
        || node.getAttribute?.("name")
        || node.getAttribute?.("id")
        || (editor ? "Editable text" : ""),
      120,
    );
  }

  valueFor(node) {
    if (this.isSensitiveControl(node)) return "";
    const tag = String(node.tagName || "").toLowerCase();
    if (tag === "select") return this.compact(node.selectedOptions?.[0]?.textContent || node.value || "", 120);
    if (tag === "textarea" || tag === "input") return this.boundedValue(node.value || "");
    if (node.isContentEditable) return this.boundedValue(this.editorText(node), { editor: true });
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

  // One pass over the top document, open shadow roots and same-origin frames,
  // in document order. Closed shadow roots stay unread. Cross-origin, private
  // and too-deep frames are only listed as inaccessible; nothing is read
  // through them. Shadow roots and frame documents join the mutation watch.
  scanRoots(doc) {
    const roots = [], candidates = [], inaccessibleFrames = [];
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
        const tag = String(element.tagName || "").toUpperCase();
        if (tag === "IFRAME" || tag === "FRAME") this.scanFrame(element, frame, visit, inaccessibleFrames);
        else if (element.shadowRoot && shadowDepth < MAX_SHADOW_DEPTH) visit(element.shadowRoot, frame, shadowDepth + 1);
      }
      // Past the scan budget the remaining interactive elements still count,
      // in document order; only their shadow roots and frames go unread.
      for (const element of matchedList) if (!pushed.has(element)) candidates.push(element);
    };
    visit(doc, null, 0);
    return { roots, candidates, inaccessibleFrames };
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
      disabled: this.isDisabled(node),
      bounds: this.roundedBounds(this.viewportRect(node)),
    };
  }

  interactiveElements(doc, limit = 80, scan = this.scanRoots(doc)) {
    const items = [];
    for (const node of scan.candidates) {
      if (items.length >= limit) break;
      if (this.isVisible(node)) items.push(this.elementItem(node));
    }
    return items;
  }

  // Focus through open shadow roots and live same-origin frames; it stops at
  // a frame element whose document this actor has not observed.
  deepActiveElement(doc) {
    let active = doc.activeElement;
    for (let depth = 0; active && depth < 32; depth++) {
      const shadowActive = active.shadowRoot?.activeElement;
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
    return {
      ...state,
      ...this.documentIdentity(),
      ...this.qaPerformDiagnostics(options),
      url: this.contentWindow.location.href,
      title: doc.title || "",
      readyState: doc.readyState || "",
      text: this.textSegments(doc, options.textLimit || 80, scan),
      interactiveElements: this.interactiveElements(doc, options.elementLimit || 80, scan),
      focusedElement: this.focusedElement(doc),
      scroll: this.scrollState(),
      inaccessible: false,
      inaccessibleFrames: scan.inaccessibleFrames,
    };
  }

  // Read-only wait inside this document. It never enters perform or takes a
  // lease; a replaced document destroys this actor, so the caller sees no
  // answer (unknown) rather than a claim about the new page.
  async waitThenSnapshot(options = {}) {
    const spec = options.wait;
    const condition = spec?.for;
    if (!["load", "idle", "selector-visible"].includes(condition) || !Number.isSafeInteger(spec.timeoutMs) ||
        spec.timeoutMs < 0 || spec.timeoutMs > MAX_WAIT_MS) throw new Error("Browser wait requires a bounded condition");
    const doc = this.document;
    if (condition === "selector-visible" && (typeof spec.ref !== "string" || !this.nodeByRef.has(spec.ref) ||
        spec.documentId !== this.observationState().documentId || this.frameForRef(spec.ref) === undefined)) {
      throw new Error("Browser wait target is stale; observe again");
    }
    const started = this.nowMs();
    let lastRevision = null, quietSince = started;
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
      if (doc.readyState !== "complete") { lastRevision = null; return false; }
      if (condition === "load") return true;
      const now = this.nowMs();
      if (state.revision !== lastRevision) { lastRevision = state.revision; quietSince = now; }
      return now - quietSince >= this.idleQuietMs;
    };
    let outcome = "timeout";
    for (;;) {
      if (this.document !== doc) throw new Error("Browser document changed during wait; outcome is unknown");
      if (met()) { outcome = "met"; break; }
      if (this.nowMs() - started >= spec.timeoutMs) break;
      await new Promise(resolve => this.contentWindow.setTimeout(resolve, this.waitPollMs));
    }
    if (this.document !== doc) throw new Error("Browser document changed during wait; outcome is unknown");
    const { wait: _wait, ...snapshotOptions } = options;
    return { ...this.snapshot(snapshotOptions),
      wait: { for: condition, outcome, elapsedMs: Math.max(0, Math.round(this.nowMs() - started)) } };
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
    if (guard.documentId !== current.documentId || guard.revision !== current.revision
        || guard.viewport?.width !== current.viewport.width || guard.viewport?.height !== current.viewport.height
        || guard.viewport?.devicePixelRatio !== current.viewport.devicePixelRatio
        || guard.focusedRef !== (this.focusedElement(this.document)?.ref || null)
        || guard.url !== this.contentWindow.location.href) {
      throw new Error("Browser observation is stale; observe the current page again");
    }
    // An observed Gecko document identity must still be this actor's.
    const identity = this.documentIdentity();
    for (const key of ["innerWindowId", "browsingContextId"]) {
      if (Object.hasOwn(guard, key) && guard[key] !== identity[key]) {
        throw new Error("Browser observation is stale; the document changed");
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
    if (!action.ref || action.selector || !guard.target || guard.target.ref !== action.ref) {
      throw new Error("Browser action requires an observed element reference");
    }
    const target = this.guardTarget(action.ref);
    if (!this.isVisible(target) || this.isDisabled(target)) {
      throw new Error("Browser target is unavailable; observe again");
    }
    if (this.isSensitiveControl(target)) throw new Error("Sensitive fields require the native user path");
    if (action.type === "fill" && !this.isFillableControl(target)) {
      throw new Error("Browser target is not an editable field; observe again");
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
    if (action.type === "click" && !this.targetIsTopmost(target)) {
      throw new Error("Browser target is obscured; observe again");
    }
  }

  // Frame generation first, then the node: a ref from a replaced frame
  // document is stale even while its old node object is still alive.
  guardTarget(ref) {
    if (this.frameForRef(ref) === undefined) throw new Error("Browser frame is stale; observe the current page again");
    const target = this.nodeForRef(ref);
    if (!target) throw new Error("Browser target is unavailable; observe again");
    return target;
  }

  assertSameTarget(target, ref, expected) {
    let candidate = typeof target.matches !== "function";
    if (!candidate) { try { candidate = target.matches(INTERACTIVE_SELECTOR) === true; } catch {} }
    const live = candidate ? this.elementItem(target) : null;
    if (!live || live.ref !== ref || ["role", "label", "href", "value", "tag"].some(key => live[key] !== expected[key])) {
      throw new Error("Browser target changed; observe again");
    }
  }

  // Hit test through open shadow roots and same-origin frames: the target is
  // topmost in its own tree, each shadow host in its tree, and each frame
  // element in its parent document at the translated point.
  targetIsTopmost(target) {
    const rect = target.getBoundingClientRect();
    let x = rect.left + rect.width / 2, y = rect.top + rect.height / 2, node = target;
    for (let depth = 0; depth < 32; depth++) {
      const root = node.getRootNode?.() || null;
      const ownDocument = this.frameByDocument.get(node.ownerDocument)?.document || this.document;
      const scope = typeof root?.elementFromPoint === "function" ? root : ownDocument;
      const hit = scope.elementFromPoint?.(x, y);
      if (!hit || (hit !== node && !node.contains?.(hit))) return false;
      if (root?.host) { node = root.host; continue; }
      const frame = this.frameByDocument.get(scope);
      if (!frame) return true;
      const offset = this.frameContentOffset(frame.frameElement);
      x += offset.x;
      y += offset.y;
      node = frame.frameElement;
    }
    return false;
  }

  // Scroll guard: same document/revision (checked above) plus the observed
  // scroll offset, so a human scroll in between makes the request stale.
  assertScrollGuard(action, guard) {
    const scroll = this.scrollState();
    if (!guard.scroll || guard.scroll.x !== scroll.x || guard.scroll.y !== scroll.y) {
      throw new Error("Browser observation is stale; the scroll position changed");
    }
    if (action.selector) throw new Error("Browser action requires an observed element reference");
    if (!action.ref) {
      if (guard.target || !["up", "down", "top", "bottom"].includes(action.direction) ||
          !["page", "half"].includes(action.amount)) throw new Error("Browser scroll requires a bounded direction");
      return;
    }
    if (action.direction || !guard.target || guard.target.ref !== action.ref) {
      throw new Error("Browser action requires an observed element reference");
    }
    const target = this.guardTarget(action.ref);
    if (!this.isVisible(target)) throw new Error("Browser target is unavailable; observe again");
    this.assertSameTarget(target, action.ref, guard.target);
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
    if (avoidFocus && !this.targetIsTopmost(target)) {
      throw new Error("Browser target became obscured before click; observe again");
    }
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
    let entered = false;
    try {
      if (options.guard) this.assertGuard(action, options.guard);
      const before = this.snapshot(options.snapshot || {});
      const lease = options.lease;
      if (options.guard) {
        if (!lease || typeof lease.leaseId !== "string" || !lease.leaseId ||
            typeof lease.requestId !== "string" || !lease.requestId ||
            !Number.isSafeInteger(lease.deadlineMs) || this.nowMs() >= lease.deadlineMs ||
            typeof this.sendQuery !== "function") throw new Error("Browser action lease is missing or expired");
        const authorization = await this.sendQuery("authorizeAct", {
          leaseId: lease.leaseId, requestId: lease.requestId, deadlineMs: lease.deadlineMs,
          actionType: action.type, actionRef: action.ref || null, actionUrl: action.url || null,
        });
        if (authorization?.authorized !== true || this.nowMs() >= lease.deadlineMs) {
          const reason = this.nowMs() >= lease.deadlineMs ? "deadline-expired-after-approval" :
            /^(?:missing-browsing-context|missing-embedder|missing-authorizer|ui-denied|parent-callback-error)$/.test(authorization?.reason)
              ? authorization.reason : "unknown";
          throw new Error(`Browser action authority was revoked before input [${reason}]`);
        }
        // The parent checked the current run/Card/account authority after the
        // asynchronous actor hop. Recheck live page state immediately before I/O.
        this.assertGuard(action, options.guard);
      }
      // Failed perform calls also count. An unchanged count proves this actor
      // never entered perform; it does not count physical events or successes.
      this.actorPerformCalls++;
      entered = true;
      timing.performEnterMs = this.clockMs();
      let result;
      this.performTiming = options.guard ? timing : null;
      try { result = this.perform(action, options); }
      finally { this.performTiming = null; timing.performExitMs = this.clockMs(); }
      // Settle is bounded by what is left of the lease (REA 웹8 c).
      const requested = Number.isFinite(options.settleMs) ? options.settleMs : 250;
      const remaining = options.guard && Number.isSafeInteger(lease?.deadlineMs)
        ? lease.deadlineMs - this.nowMs() - SETTLE_RESPONSE_MARGIN_MS : Infinity;
      const settleMs = Math.max(0, Math.min(requested, remaining));
      await new Promise((resolve) => this.contentWindow.setTimeout(resolve, settleMs));
      const after = this.snapshot(options.snapshot || {});
      timing.performCallsAfter = this.actorPerformCalls;
      return {
        ok: true,
        action,
        result,
        before,
        after,
        observation: this.diff(before, after),
        ...(options.guard ? { timing: this.timingRecord(timing) } : {}),
      };
    } catch (error) {
      if (options.guard && error && typeof error === "object") {
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

  // Only finite, non-negative stamps and safe-integer counts leave the actor.
  timingRecord(timing) {
    const record = {};
    for (const key of ["performEnterMs", "performExitMs", "firstEventAtMs"]) {
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
    return { ok: false, refused: true, error: String(error?.message || error || "Browser action was refused").slice(0, 500),
      dispatchPhase: phase, timing };
  }
}
