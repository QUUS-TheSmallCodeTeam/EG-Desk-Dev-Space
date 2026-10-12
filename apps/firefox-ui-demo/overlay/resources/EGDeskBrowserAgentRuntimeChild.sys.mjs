import { captureDocumentText } from './EGDeskInputContext.sys.mjs';

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
  }

  async receiveMessage(message) {
    const data = message.data || {};
    if (message.name === "snapshot") return this.snapshot(data.options || {});
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
        disabled: !!node.disabled || node.getAttribute?.("aria-disabled") === "true",
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

  snapshot(options = {}) {
    const doc = this.document;
    return {
      ...this.observationState(),
      url: this.contentWindow.location.href,
      title: doc.title || "",
      readyState: doc.readyState || "",
      text: this.textSegments(doc, options.textLimit || 80),
      interactiveElements: this.interactiveElements(doc, options.elementLimit || 80),
      focusedElement: this.focusedElement(doc),
      inaccessible: false,
    };
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
    if (action.type === "navigate") return;
    if (!action.ref || action.selector || !guard.target || guard.target.ref !== action.ref) {
      throw new Error("Browser action requires an observed element reference");
    }
    const target = this.nodeForRef(action.ref);
    if (!target || !this.isVisible(target) || target.disabled || target.getAttribute?.("aria-disabled") === "true") {
      throw new Error("Browser target is unavailable; observe again");
    }
    if (this.isSensitiveControl(target)) throw new Error("Sensitive fields require the native user path");
    if (("value" in target && String(target.value || "").length > 120) ||
        (target.isContentEditable && String(target.textContent || "").length > 120)) {
      throw new Error("Browser target value exceeds the bounded observation; use the native user path");
    }
    const live = this.interactiveElements(this.document, 500).find(item => item.ref === action.ref);
    if (!live || ["role", "label", "href", "value", "tag"].some(key => live[key] !== guard.target[key])) {
      throw new Error("Browser target changed; observe again");
    }
    if (action.type === "click") {
      const rect = target.getBoundingClientRect();
      const hit = this.document.elementFromPoint?.(rect.left + rect.width / 2, rect.top + rect.height / 2);
      if (!hit || (hit !== target && !target.contains?.(hit))) {
        throw new Error("Browser target is obscured; observe again");
      }
    }
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
    if (type === "navigate") {
      const url = this.safeNavigationUrl(action.url || action.value);
      if (!url) throw new Error("Browser navigation requires an absolute http(s) URL without credentials");
      this.contentWindow.location.href = url;
      return { ok: true };
    }
    if (type === "scroll") {
      this.contentWindow.scrollBy({ left: action.dx || 0, top: action.dy || action.deltaY || 0, behavior: "instant" });
      return { ok: true };
    }
    if (type === "snapshot") return { ok: true };

    const target = this.targetFor(action);
    if (!target) throw new Error(`Browser agent target not found: ${action.ref || action.selector || ""}`);
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
