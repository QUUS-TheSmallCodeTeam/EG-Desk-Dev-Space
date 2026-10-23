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

export class EGDeskBrowserAgentRuntimeChild extends JSWindowActorChild {
  constructor() {
    super();
    this.refByNode = new WeakMap();
    this.nodeByRef = new Map();
    this.refSeq = 0;
    this.documentId = globalThis.crypto?.randomUUID?.() || `${Date.now()}-${Math.random()}`;
    this.revision = 1;
    this.observedDocument = null;
    this.observer = null;
    this.lastViewport = null;
    // Entry into the side-effecting dispatcher, not physical input events.
    this.actorPerformCalls = 0;
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
    if (message.name === "act") return this.act(data.action || {}, data.options || {});
    throw new Error(`Unsupported browser agent actor message: ${message.name}`);
  }

  compact(value, max = 180) {
    const text = String(value || "").replace(/\s+/g, " ").trim();
    return text.length > max ? `${text.slice(0, max - 3).trimEnd()}...` : text;
  }

  elementRef(node) {
    const existing = this.refByNode.get(node);
    if (existing) return existing;
    const ref = `el_${++this.refSeq}`;
    this.refByNode.set(node, ref);
    this.nodeByRef.set(ref, node);
    return ref;
  }

  nodeForRef(ref) {
    const node = this.nodeByRef.get(ref);
    return node && node.isConnected ? node : null;
  }

  isVisible(node) {
    if (!node || !node.getBoundingClientRect) return false;
    const rect = node.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return false;
    for (let current = node; current; current = this.composedParent(current)) {
      if (current.hidden || current.inert || current.getAttribute?.("aria-hidden") === "true") return false;
      const style = this.contentWindow.getComputedStyle(current);
      if (style.display === "none" || ["hidden", "collapse"].includes(style.visibility) || Number(style.opacity) === 0) return false;
    }
    return true;
  }

  isDisabled(node) {
    if (node?.disabled === true) return true;
    try { if (node?.matches?.(":disabled")) return true; } catch {}
    for (let current = node; current; current = this.composedParent(current)) {
      if (current.getAttribute?.("aria-disabled") === "true") return true;
    }
    return false;
  }

  isFillableControl(node) {
    if (!node || node.readOnly || node.getAttribute?.("aria-readonly") === "true") return false;
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

  isSensitiveControl(node) {
    if (!node) return false;
    if (node.isContentEditable) return true;
    const tag = String(node.tagName || "").toLowerCase();
    if (!["input", "textarea", "select"].includes(tag)) return false;
    const type = String(node.type || node.getAttribute?.("type") || "").toLowerCase();
    if (["password", "hidden"].includes(type)) return true;
    const sensitiveFlag = node.getAttribute?.("data-sensitive");
    const privateFlag = node.getAttribute?.("data-private");
    if ((sensitiveFlag != null && sensitiveFlag !== "false") || (privateFlag != null && privateFlag !== "false")) return true;
    const hints = ["autocomplete", "name", "id", "aria-label", "placeholder"].map(key =>
      String(node.getAttribute?.(key) || (key === "id" ? node.id : "") || "")
        .replace(/([a-z0-9])([A-Z])/g, "$1 $2").toLowerCase()).join(" ");
    if (/password|passwd|passphrase|secret|token|otp|cvv|cvc/.test(hints)) return true;
    return /(?:^|[\s_-])(?:password|passwd|pwd|passphrase|secret|token|otp|pin|ssn|pan|social[\s_-]?security(?:[\s_-]?number)?|primary[\s_-]?account[\s_-]?number|api[\s_-]?key|access[\s_-]?key|private[\s_-]?key|client[\s_-]?secret|one[\s_-]?time|verification[\s_-]?code|auth[\s_-]?code|security[\s_-]?answer|cc[\s_-]?(?:number|csc|exp)|credit[\s_-]?card(?:[\s_-]?number)?|card[\s_-]?number|cvv|cvc)(?:$|[\s_-])/.test(hints);
  }

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
    const doc = node.ownerDocument;
    const labelledBy = node.getAttribute?.("aria-labelledby");
    if (labelledBy) {
      const labelled = labelledBy.split(/\s+/).map((id) => doc.getElementById(id)?.textContent || "").join(" ");
      if (labelled.trim()) return this.compact(labelled, 120);
    }
    if (node.id) {
      const label = doc.querySelector(`label[for="${CSS.escape(node.id)}"]`);
      if (label?.textContent?.trim()) return this.compact(label.textContent, 120);
    }
    return this.compact(
      node.getAttribute?.("aria-label")
        || node.getAttribute?.("alt")
        || node.getAttribute?.("title")
        || node.getAttribute?.("placeholder")
        || node.innerText
        || node.textContent
        || node.getAttribute?.("name")
        || node.getAttribute?.("id")
        || "",
      120,
    );
  }

  valueFor(node) {
    if (this.isSensitiveControl(node)) return "";
    const tag = String(node.tagName || "").toLowerCase();
    if (tag === "select") return this.compact(node.selectedOptions?.[0]?.textContent || node.value || "", 120);
    if (tag === "textarea" || tag === "input") return this.compact(node.value || "", 120);
    if (node.isContentEditable) return this.compact(node.innerText || node.textContent || "", 120);
    return "";
  }

  signature(item) {
    return [item.role || "", item.label || "", item.href || "", item.value || ""].join("|");
  }

  textSegments(doc, limit = 80) {
    const root = doc.body || doc.documentElement;
    if (!root) return [];
    const filter = this.contentWindow.NodeFilter;
    const walker = doc.createTreeWalker(root, filter.SHOW_TEXT, {
      acceptNode: (node) => {
        const text = this.compact(node.nodeValue, 180);
        if (!text || text.length < 2) return filter.FILTER_REJECT;
        const parent = node.parentElement;
        if (!parent || !this.isVisible(parent) || this.isSensitiveText(node)) return filter.FILTER_REJECT;
        return filter.FILTER_ACCEPT;
      },
    });
    const seen = new Set();
    const segments = [];
    let node = walker.nextNode();
    while (node && segments.length < limit) {
      const text = this.compact(node.nodeValue, 180);
      if (text && !seen.has(text)) {
        seen.add(text);
        segments.push(text);
      }
      node = walker.nextNode();
    }
    return segments;
  }

  interactiveElements(doc, limit = 80) {
    const selector = ["a[href]", "button", "input", "textarea", "select", "[role]", "[tabindex]", "[contenteditable=\"true\"]"].join(",");
    return Array.from(doc.querySelectorAll(selector)).filter((node) => this.isVisible(node)).slice(0, limit).map((node) => {
      const rect = node.getBoundingClientRect();
      return {
        ref: this.elementRef(node),
        role: this.roleFor(node),
        label: this.labelFor(node),
        tag: String(node.tagName || "").toLowerCase(),
        href: node.href || node.getAttribute?.("href") || "",
        value: this.valueFor(node),
        disabled: this.isDisabled(node),
        bounds: {
          x: Math.round(rect.left),
          y: Math.round(rect.top),
          width: Math.round(rect.width),
          height: Math.round(rect.height),
        },
      };
    });
  }

  focusedElement(doc) {
    const active = doc.activeElement;
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
      this.revision++;
      if (doc?.documentElement && this.contentWindow.MutationObserver) {
        this.observer = new this.contentWindow.MutationObserver(() => { this.revision++; });
        this.observer.observe(doc.documentElement, {
          subtree: true, childList: true, attributes: true, characterData: true,
        });
      }
    }
    if (this.observer?.takeRecords().length) this.revision++;
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
    return {
      ...this.observationState(),
      ...this.qaPerformDiagnostics(options),
      url: this.contentWindow.location.href,
      title: doc.title || "",
      readyState: doc.readyState || "",
      text: this.textSegments(doc, options.textLimit || 80),
      interactiveElements: this.interactiveElements(doc, options.elementLimit || 80),
      focusedElement: this.focusedElement(doc),
      scroll: this.scrollState(),
      inaccessible: false,
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
        spec.documentId !== this.observationState().documentId)) {
      throw new Error("Browser wait target is stale; observe again");
    }
    const started = this.nowMs();
    let lastRevision = null, quietSince = started;
    const met = () => {
      const state = this.observationState();
      if (typeof spec.notDocumentId === "string" && state.documentId === spec.notDocumentId) return false;
      if (condition === "selector-visible") {
        if (state.documentId !== spec.documentId) throw new Error("Browser wait target is stale; observe again");
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
    node.dispatchEvent(new this.contentWindow.Event("input", { bubbles: true, cancelable: true }));
    node.dispatchEvent(new this.contentWindow.Event("change", { bubbles: true, cancelable: true }));
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
    const target = this.nodeForRef(action.ref);
    if (!target || !this.isVisible(target) || this.isDisabled(target)) {
      throw new Error("Browser target is unavailable; observe again");
    }
    if (this.isSensitiveControl(target)) throw new Error("Sensitive fields require the native user path");
    if (action.type === "fill" && !this.isFillableControl(target)) {
      throw new Error("Browser target is not an editable field; observe again");
    }
    if (("value" in target && String(target.value || "").length > 120) ||
        (target.isContentEditable && String(target.textContent || "").length > 120)) {
      throw new Error("Browser target value exceeds the bounded observation; use the native user path");
    }
    const live = this.interactiveElements(this.document, 500).find(item => item.ref === action.ref);
    if (!live || ["role", "label", "href", "value", "tag"].some(key => live[key] !== guard.target[key])) {
      throw new Error("Browser target changed; observe again");
    }
    if (action.type === "press") this.assertKeyTarget(action, guard, target);
    if (action.type === "click") {
      const rect = target.getBoundingClientRect();
      const hit = this.document.elementFromPoint?.(rect.left + rect.width / 2, rect.top + rect.height / 2);
      if (!hit || (hit !== target && !target.contains?.(hit))) {
        throw new Error("Browser target is obscured; observe again");
      }
    }
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
    const target = this.nodeForRef(action.ref);
    if (!target || !this.isVisible(target)) throw new Error("Browser target is unavailable; observe again");
    const live = this.interactiveElements(this.document, 500).find(item => item.ref === action.ref);
    if (!live || ["role", "label", "href", "value", "tag"].some(key => live[key] !== guard.target[key])) {
      throw new Error("Browser target changed; observe again");
    }
  }

  // Key input never moves focus: the target is the focused element, or the
  // field the previous guarded action filled in this same document.
  assertKeyTarget(action, guard, target) {
    if (typeof action.key !== "string" || !Object.hasOwn(GUARDED_KEYS, action.key)) {
      throw new Error("Browser key is outside the guarded key set");
    }
    if (guard.pressPolicy === "already-focused") {
      if (this.document.activeElement !== target) throw new Error("Browser key target is not focused; EG-Desk never moves focus");
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
      target.scrollIntoView?.({ block: "center", inline: "nearest", behavior: "instant" });
      const rect = target.getBoundingClientRect?.();
      const targetInView = !!rect && rect.width > 0 && rect.height > 0 && rect.top < win.innerHeight &&
        rect.top + rect.height > 0 && rect.left < win.innerWidth && rect.left + rect.width > 0;
      const after = this.scrollState();
      return { ok: true, dispatchDiagnostics: { inputRoute: "dom-scroll-api", mode: "into-view",
        scrollBefore: { x: before.x, y: before.y }, scrollAfter: { x: after.x, y: after.y }, targetInView } };
    }
    const height = Math.max(0, Math.round(Number(win.innerHeight) || 0));
    const step = Math.round(height * (action.amount === "half" ? 0.5 : 0.9));
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
    const KeyboardEvent = this.contentWindow.KeyboardEvent;
    if (typeof KeyboardEvent !== "function") throw new Error("Browser key events are unavailable; use the native user path");
    const init = { key: keySpec.key, code: keySpec.code, keyCode: keySpec.keyCode, which: keySpec.keyCode,
      bubbles: true, cancelable: true, composed: true, view: this.contentWindow };
    let targetKeyObserved = false;
    const onKey = () => { targetKeyObserved = true; };
    target.addEventListener?.("keydown", onKey, true);
    let keydownNotCanceled;
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

  clickTarget(target, { avoidFocus = false } = {}) {
    const rect = target.getBoundingClientRect();
    const hit = this.document.elementFromPoint?.(rect.left + rect.width / 2, rect.top + rect.height / 2);
    if (avoidFocus && (!hit || (hit !== target && !target.contains?.(hit)))) {
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
      if (options.guard && type === "fill") this.lastGuardedFill = { ref: action.ref, node: target };
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
    if (options.guard) this.assertGuard(action, options.guard);
    const before = this.snapshot(options.snapshot || {});
    if (options.guard) {
      const lease = options.lease;
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
    const result = this.perform(action, options);
    const settleMs = Number.isFinite(options.settleMs) ? options.settleMs : 250;
    await new Promise((resolve) => this.contentWindow.setTimeout(resolve, Math.max(0, settleMs)));
    const after = this.snapshot(options.snapshot || {});
    return {
      ok: true,
      action,
      result,
      before,
      after,
      observation: this.diff(before, after),
    };
  }
}
