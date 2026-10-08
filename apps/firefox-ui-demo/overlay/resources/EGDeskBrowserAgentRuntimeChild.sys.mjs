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
    const style = this.contentWindow.getComputedStyle(node);
    return style.display !== "none" && style.visibility !== "hidden" && Number(style.opacity) !== 0;
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

  labelFor(node) {
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
        || node.value
        || "",
      120,
    );
  }

  valueFor(node) {
    const tag = String(node.tagName || "").toLowerCase();
    if (tag === "input" && String(node.type || "").toLowerCase() === "password") return "";
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
        if (!parent || !this.isVisible(parent)) return filter.FILTER_REJECT;
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
    if (action.type === "fill" && (live.tag === "input" && String(target.type || "").toLowerCase() === "password")) {
      throw new Error("Password fields require the native user path");
    }
  }

  clickTarget(target, { avoidFocus = false } = {}) {
    if (!avoidFocus) target.focus?.();
    const rect = target.getBoundingClientRect();
    const hit = this.document.elementFromPoint?.(rect.left + rect.width / 2, rect.top + rect.height / 2);
    if (avoidFocus && (!hit || (hit !== target && !target.contains?.(hit)))) {
      throw new Error("Browser target became obscured before click; observe again");
    }
    const x = Math.round(rect.left + rect.width / 2);
    const y = Math.round(rect.top + rect.height / 2);
    const utils = this.contentWindow.windowUtils;
    const eventResults = [];
    if (utils?.sendMouseEvent) {
      utils.sendMouseEvent("mousemove", x, y, 0, 0, 0);
      utils.sendMouseEvent("mousedown", x, y, 0, 1, 0);
      utils.sendMouseEvent("mouseup", x, y, 0, 1, 0);
      return { usedWindowUtils: true, x, y };
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
    return { usedWindowUtils: false, x, y, eventResults };
  }

  perform(action = {}, options = {}) {
    const type = action.type || action.action || "snapshot";
    if (type === "navigate") {
      this.contentWindow.location.href = String(action.url || action.value || this.contentWindow.location.href);
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
