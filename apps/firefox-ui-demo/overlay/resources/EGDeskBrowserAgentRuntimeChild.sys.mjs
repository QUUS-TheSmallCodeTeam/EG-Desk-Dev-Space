import { captureDocumentText } from './EGDeskInputContext.sys.mjs';

export class EGDeskBrowserAgentRuntimeChild extends JSWindowActorChild {
  constructor() {
    super();
    this.refByNode = new WeakMap();
    this.nodeByRef = new Map();
    this.refSeq = 0;
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

  snapshot(options = {}) {
    const doc = this.document;
    return {
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

  clickTarget(target) {
    target.focus?.();
    const rect = target.getBoundingClientRect();
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
    for (const eventName of ["pointerdown", "mousedown", "pointerup", "mouseup", "click"]) {
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
    target.click?.();
    return { usedWindowUtils: false, x, y, eventResults };
  }

  perform(action = {}) {
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
        clickDiagnostics: this.clickTarget(target),
      };
    }

    if (type === "fill" || type === "type") {
      target.focus?.();
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
    const before = this.snapshot(options.snapshot || {});
    const result = this.perform(action);
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
