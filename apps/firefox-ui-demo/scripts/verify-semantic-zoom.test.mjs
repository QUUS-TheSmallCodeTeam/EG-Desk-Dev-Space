import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { compileFunction } from 'node:vm';
import { readSurfaceSource } from './egdesk-surface-source.mjs';
import * as SurfaceState from '../overlay/resources/EGDeskSurfaceState.sys.mjs';
import * as BriefingState from '../overlay/resources/EGDeskBriefingState.sys.mjs';
import * as InputContext from '../overlay/resources/EGDeskInputContext.sys.mjs';
import * as ChatState from '../overlay/resources/EGDeskChatState.sys.mjs';
import { OBSERVE } from './verify-semantic-zoom.mjs';

const overlay = readSurfaceSource();
const functionSource = name => overlay.match(new RegExp(`  (?:async )?function ${name}\\([^]*?\\n  }`))?.[0];
const production = (name, dependencies = {}) => {
  const source = functionSource(name);
  assert.ok(source, `production ${name} exists`);
  return compileFunction(`${source}; return ${name};`, Object.keys(dependencies))(...Object.values(dependencies));
};

function renderedLevel({ width = 1150.4, zoom = .8, previous = 'outline', metrics,
  cardWidth = 1440, cardHeight = 640, projectedFont, bodyFontPx = 11 } = {}) {
  const start = overlay.indexOf('        const projectedFont =', overlay.indexOf('    const render = () => {', overlay.indexOf('function installSemanticZoom')));
  const end = overlay.indexOf('        if (level !== entry.level)', start);
  assert.ok(start > 0 && end > start);
  return compileFunction(`${overlay.slice(start, end)}\nreturn level;`,
    ['entry', 'card', 'rect', 'zoom', 'SurfaceState', 'isCardFullscreen', 'detailWidth', 'detailHeight'])(
    { kind: 'browser', bodyFontPx, level: previous },
    { _browserPresentation: { font: () => projectedFont === undefined
      ? production('browserPresentationFont')(metrics, width) : projectedFont } },
    { width: cardWidth * zoom, height: cardHeight * zoom }, zoom, SurfaceState, () => false, 240, 180);
}
const metric = Object.freeze({ version: 1, complete: true, fontPx: 16,
  viewportWidth: 1440, viewportHeight: 573, sampleCount: 8 });

// HUM-BRIEF-002: the measured six-View world layout at 720x600 / 4.6717%.
// Only a DOM/observer adapter is synthetic; resolution, rendering, proxies,
// navigation and close use the production functions. No Firefox or provider.
function briefingSemanticHarness({ width = 720, height = 600, zoom = .04671717171717172,
  pan = { x: 368.1666666666667, y: 98.78030303030303 }, realComments = false, bodyFontPx = 14, onCardFocus = null, immediateCamera = false } = {}) {
  const frames = new Map(), focus = [], fits = [], pending = [], observers = new Set(), resizeObservers = new Set(), windowListeners = new Map(), mediaQueries = [];
  const comments = { mounts: 0, disposals: 0, notifications: 0 };
  let nextFrame = 0, nonce = 0, failResolution = false, deferred = false, failedPreparation = null, useActualFit = false, actualFit;
  const document = { activeElement: null, addEventListener() {}, removeEventListener() {} };
  const walk = (root, match) => root.children.flatMap(child => child.nodeType === 1 ? [...(match(child) ? [child] : []), ...walk(child, match)] : []);
  const matches = (node, selector) => selector.split(',').some(part => {
    const last = part.trim().split(/\s+/).at(-1);
    if (last.startsWith('.')) return node.className.split(/\s+/).includes(last.slice(1));
    if (last.startsWith('#')) return node.id === last.slice(1);
    if (last.startsWith('[')) {
      const attribute = last.match(/^\[([^=\]]+)(?:=["']?([^"'\]]+)["']?)?\]$/);
      return !!attribute && node.hasAttribute(attribute[1]) && (attribute[2] === undefined || node.getAttribute(attribute[1]) === attribute[2]);
    }
    return node.tagName === last.split('[')[0].toUpperCase();
  });
  class Element {
    constructor(tag) { Object.assign(this, { nodeType: 1, tagName: tag.toUpperCase(), children: [], attributes: {}, dataset: {}, style: {},
      className: '', hidden: false, isConnected: false, listeners: new Map(), ownText: '', scrollTop: 0, scrollLeft: 0 });
      const style = this.style, priorities = new Map(), key = name => name.replace(/-([a-z])/g, (_all, letter) => letter.toUpperCase());
      const cssName = name => name.replace(/[A-Z]/g, letter => `-${letter.toLowerCase()}`);
      Object.defineProperties(style, {
        length: { get: () => Object.keys(style).filter(name => style[name] !== '').length },
        cssText: { get: () => Object.keys(style).filter(name => style[name] !== '').map(name => `${cssName(name)}: ${style[name]}${priorities.get(cssName(name)) ? ' !important' : ''};`).join(' ') },
        getPropertyValue: { value: name => style[key(name)] || '' },
        getPropertyPriority: { value: name => priorities.get(name) || '' },
        setProperty: { value: (name, value, priority = '') => { style[key(name)] = String(value); priorities.set(name, priority); this.attributes.style = style.cssText; } },
        removeProperty: { value: name => { const previous = style[key(name)] || ''; delete style[key(name)]; priorities.delete(name); this.attributes.style = style.cssText; return previous; } },
      });
    }
    get id() { return this.attributes.id || ''; } set id(value) { this.attributes.id = value; }
    get inert() { return this.hasAttribute('inert'); } set inert(value) { if (value) this.setAttribute('inert', ''); else this.removeAttribute('inert'); }
    get classList() { return { contains: name => this.className.split(/\s+/).includes(name) }; }
    get firstChild() { return this.children[0] || null; } get lastElementChild() { return this.children.filter(child => child.nodeType === 1).at(-1) || null; }
    get textContent() { return this.ownText + this.children.map(child => child.textContent).join(''); }
    set textContent(value) { this.children = []; this.ownText = String(value); }
    replaceChildren(...children) { for (const child of [...this.children]) child.remove?.(); this.children = []; this.ownText = ''; children.forEach(child => this.appendChild(child)); }
    connect(value) { this.isConnected = value; for (const child of this.children) child.connect?.(value); }
    append(...children) { children.forEach(child => this.appendChild(child)); }
    appendChild(child) { child.remove?.(); this.children.push(child); child.parentNode = this; child.connect?.(this.isConnected); return child; }
    insertBefore(child, next) { child.remove?.(); this.children.splice(this.children.indexOf(next), 0, child); child.parentNode = this; child.connect?.(this.isConnected); return child; }
    remove() { if (this.parentNode) this.parentNode.children = this.parentNode.children.filter(child => child !== this); this.parentNode = null; this.connect(false); }
    contains(node) { return this === node || this.children.some(child => child === node || child.contains?.(node)); }
    querySelectorAll(selector) { return walk(this, node => matches(node, selector)); }
    querySelector(selector) { return this.querySelectorAll(selector)[0] || null; }
    setAttribute(key, value) { this.attributes[key] = String(value); if (key === 'hidden') this.hidden = true; }
    getAttribute(key) { return this.attributes[key] ?? null; } hasAttribute(key) { return Object.hasOwn(this.attributes, key); }
    removeAttribute(key) { delete this.attributes[key]; }
    getClientRects() { return this.isConnected ? [{}] : []; }
    getBoundingClientRect() {
      if (this.id === 'egd-answer-briefing' && this.dataset.compact === 'true') {
        const left = Number.parseFloat(this.style.left), bottom = window.innerHeight - Number.parseFloat(this.style.bottom);
        const width = Number.parseFloat(this.style.width), height = this.dataset.expanded === 'true' ? 280 : 64;
        return { left, right: left + width, bottom, top: bottom - height, width, height };
      }
      return { left: 90, top: 180, right: 690, bottom: 550, width: 600, height: 370 };
    }
    addEventListener(type, fn) { const list = this.listeners.get(type) || []; list.push(fn); this.listeners.set(type, list); }
    removeEventListener(type, fn) { this.listeners.set(type, (this.listeners.get(type) || []).filter(item => item !== fn)); }
    fire(type, extra = {}) {
      let stopped = false;
      const event = { type, target: this, detail: 1, stopPropagation() { stopped = true; }, preventDefault() {}, ...extra };
      for (let node = this; node; node = stopped ? null : node.parentNode) {
        event.currentTarget = node; for (const fn of node.listeners?.get(type) || []) fn(event);
      }
    }
    focus() { document.activeElement = this; }
    setSelectionRange(start, end, direction = 'none') { this.selectionStart = start; this.selectionEnd = end; this.selectionDirection = direction; }
    closest(selector) { return matches(this, selector) ? this : this.parentNode?.closest?.(selector) || null; }
  }
  document.createElement = tag => new Element(tag);
  document.createTextNode = text => ({ nodeType: 3, textContent: String(text) });
  document.documentElement = new Element('html'); document.documentElement.connect(true);
  document.getElementById = id => walk(document.documentElement, node => node.id === id)[0] || null;
  document.querySelectorAll = selector => document.documentElement.querySelectorAll(selector);
  document.querySelector = selector => selector === '#egd-answer-briefing nav'
    ? document.getElementById('egd-answer-briefing')?.querySelector('nav') : document.documentElement.querySelector(selector);
  const window = { innerWidth: width, innerHeight: height, matchMedia: query => {
    const listeners = new Set(), media = { get matches() { return query === '(max-width: 56rem)' && window.innerWidth <= 56 * 16; },
      addEventListener: (_type, fn) => listeners.add(fn), removeEventListener: (_type, fn) => listeners.delete(fn), listeners };
    mediaQueries.push(media); return media;
  },
    getComputedStyle: node => ({ display: node.hidden ? 'none' : 'block', visibility: 'visible', opacity: '1', rowGap: '8px',
      fontSize: `${node.classList.contains('egd-input-evidence-card') || node.classList.contains('egd-card-body') ? bodyFontPx : 14}px`, boxSizing: 'border-box' }),
    requestAnimationFrame: fn => { frames.set(++nextFrame, fn); return nextFrame; }, cancelAnimationFrame: id => frames.delete(id),
    addEventListener: (type, fn) => { if (!windowListeners.has(type)) windowListeners.set(type, new Set()); windowListeners.get(type).add(fn); },
    removeEventListener: (type, fn) => windowListeners.get(type)?.delete(fn) };
  class MutationObserver {
    constructor(callback) { this.callback = callback; }
    observe(root, options) { this.root = root; this.options = options; observers.add(this); }
    disconnect() { observers.delete(this); }
  }
  window.ResizeObserver = class {
    constructor(callback) { this.callback = callback; this.nodes = new Set(); }
    observe(node) { this.nodes.add(node); resizeObservers.add(this); }
    disconnect() { this.nodes.clear(); resizeObservers.delete(this); }
  };
  const el = production('el', { document });
  const viewport = el('div'), layer = el('div'); viewport.appendChild(layer); document.documentElement.appendChild(viewport); viewport.focus();
  const state = { zoom, zoomTarget: zoom, pan: { ...pan }, panTarget: { ...pan }, codex: { activeThreadId: 'room-a' },
    setCanvasViewportTarget: camera => {
      fits.push(camera);
      if (immediateCamera) {
        state.zoom = state.zoomTarget = camera.zoom; state.pan = { ...camera.pan }; state.panTarget = { ...camera.pan };
        state.renderSemanticProjections?.();
      }
    }, activeEntityId: 'existing-selection' };
  const geometry = card => Object.fromEntries(['x', 'y', 'width', 'height'].map((key, index) =>
    [key, Number.parseFloat(card.style[['left', 'top', 'width', 'height'][index]])]));
  const createCard = (id, kind, rect) => {
    const card = el('div', { id, class: `egd-canvas-card ${kind === 'input-evidence' ? 'egd-input-evidence-card' : 'egd-chat-card'}`,
      data: { deskWindowKind: kind }, style: { left: `${rect.x}px`, top: `${rect.y}px`, width: `${rect.width}px`, height: `${rect.height}px` } },
    el('strong', {}, '같은 제목'));
    card.resource = Object.freeze({ id: `original-resource-${id}` }); layer.appendChild(card); return card;
  };
  const positions = [[352, -402], [352, 724], [-288, -402], [992, -402], [-480, 80], [1184, 80]];
  const identity = { conversationId: 'conversation-a', runId: 'run-a', answerId: ChatState.runKey('conversation-a', 'run-a') };
  const auth = { isLoggedIn: true, accountEmail: 'focus-owner@example.test', authMode: 'chatgpt', identityStatus: 'known', access: { state: 'ok' } };
  const accountKey = ChatState.codexAccountKey(auth);
  Object.assign(state.codex, { authStatus: auth, codexAccountKey: accountKey, connected: true });
  const thread = { id: 'room-a', engineId: 'codex', engineProfileId: 'fixture-codex', conversationId: identity.conversationId,
    clientBindingId: 'fixture-binding', bindingState: 'verified', bindingAccountKey: accountKey, messages: [], briefingInputs: [] };
  state.codex.threads = [thread];
  const firstSendScope = ChatState.chatContextRequestScope({ ...thread, conversationId: null }, state.codex);
  const captures = positions.map((_point, index) => {
    const source = { id: `selection-${index}`, kind: 'browser', label: '같은 제목', sourceRef: { viewId: `synthetic-view-${index}` } };
    const capture = { id: source.id, sourceId: `source-${index}`, snapshotId: `source-${index}`, hash: `hash-${index}`,
      sourceRef: source.sourceRef, clientThreadId: firstSendScope.clientThreadId,
      engine: { engineId: firstSendScope.engineId, engineProfileId: firstSendScope.engineProfileId } };
    return { source, capture, bindings: [{ bindingId: `synthetic-binding-${index}`, ...identity }] };
  });
  const references = captures.map(({ source, capture }) => InputContext.capturedInputReference(source, capture, firstSendScope));
  const cards = positions.map(([x, y], index) => {
    const card = createCard(`evidence-${index}`, 'input-evidence', { x, y, width: 616, height: 458 });
    card._inputReference = { ...references[index] }; card._inputEvidenceLoaded = true; return card;
  });
  const chat = createCard('ordinary-chat', 'chat', { x: 160, y: 80, width: 1000, height: 458 });
  const target = index => ({ sourceId: references[index].sourceId, hash: references[index].hash });
  const briefing = { id: 'brief-a', ...identity, steps: [
    { id: 'six', text: '여섯 근거', targets: cards.map((_card, index) => target(index)) },
    { id: 'single', text: '한 근거', target: target(0) }, { id: 'three', text: '세 근거', targets: [3, 4, 5].map(target) }] };
  const protocol = state.codex.chatProtocol = ChatState.createChatProtocolState(), requestId = 'fixture-first-request';
  ChatState.registerChatRequest(protocol, { requestId, clientThreadId: firstSendScope.clientThreadId, localThreadId: thread.id }, auth);
  const accepted = { accepted: true, durable: true, requestId, clientThreadId: firstSendScope.clientThreadId,
    localMessageId: 'fixture-user-receipt', localConversationId: 'fixture-local-conversation', localRunId: 'fixture-local-run',
    engineId: firstSendScope.engineId, engineProfileId: firstSendScope.engineProfileId, ...identity };
  const run = ChatState.acceptChatRequest(protocol, accepted, requestId);
  assert.ok(run, 'the synthetic first send has a real accepted protocol run');
  thread.messages.push({ id: 'fixture-user', role: 'user', requestId, localMessageId: accepted.localMessageId,
    ...identity, inputReferences: references });
  thread.messages.push({ id: 'fixture-answer', role: 'assistant', ...identity, briefing,
    contextCaptures: captures.map(({ capture }) => capture) });
  const rememberReceipt = production('rememberAcceptedInputReceipt', { state, ChatState });
  assert.equal(rememberReceipt(thread, accepted, requestId, run), true, 'only a verified accepted user receipt seeds the fixture');
  const briefingRangeIssue = production('briefingRangeIssue', { InputContext });
  const getCodexThreadById = production('getCodexThreadById');
  const cloneJson = value => value == null ? value : JSON.parse(JSON.stringify(value));
  const guardNames = ['acceptedInputReceipt', 'visibleInputAnswer', 'historyReadReferenceCurrent', 'briefingInputReferences',
    'briefingReadReferenceCurrent', 'rememberBriefingMinimapEvidence', 'briefingResolvedTargets'];
  const guardDeps = { state, document, BriefingState, InputContext, ChatState, briefingRangeIssue,
    persistentEntityGeometry: geometry, getCodexThreadById, cloneJson };
  const guards = compileFunction(`${guardNames.map(functionSource).join('\n')}\nreturn { ${guardNames.join(', ')} };`,
    Object.keys(guardDeps))(...Object.values(guardDeps));
  const resolve = guards.briefingResolvedTargets;
  const briefingResolvedTargets = (...args) => {
    if (failResolution === true || failResolution === args[1]?.id) throw new Error('synthetic resolution failure');
    return resolve(...args);
  };
  const deps = { document, window, state, el, SurfaceState, BriefingState, InputContext, ChatState, ...guards,
    getCodexThreadById, briefingRangeIssue, briefingResolvedTargets,
    ZOOM_MIN: .01, ZOOM_MAX: 4, CHAT_ZOOM_GAP: 10, MutationObserver, Node: { ELEMENT_NODE: 1 },
    parsePxNumber: (value, fallback = 0) => Number.parseFloat(value) || fallback,
    safeViewportRect: production('safeViewportRect', { window, document }),
    deskIcon: () => el('i'), isCardFullscreen: () => false, visibleChatZoomRect: () => null,
    focusCanvasCard: card => { focus.push(card); onCardFocus?.({ card, document, viewport }); }, setActiveEntity: node => state.onSelectionRestore?.(node),
    fitCodexChatCardToReadableViewport: () => false, browserPresentationMayNeedMetrics: () => false, browserDisplayHost: () => '',
    markAgendaDirty: () => assert.fail('presentation cannot move or save a View'),
    fitBriefingTargets: resolved => useActualFit ? actualFit(resolved) : fits.push(resolved),
    mountBriefingComments: (_session, panel) => {
      comments.mounts++;
      let editor;
      if (realComments) editor = production('mountBriefingComments', deps)(_session, panel);
      else panel.appendChild(el('textarea', { data: { testid: 'briefing-comment' } }));
      return { dispose() { comments.disposals++; editor?.dispose(); }, notify() { comments.notifications++; editor?.notify(); } };
    },
    chatBindingNonce: () => `presentation-${++nonce}`, boardNotice: () => {},
  };
  const code = ['installSemanticOutlineDrag', 'installSemanticZoom', 'renderAnswerBriefing', 'closeAnswerBriefing', 'openAnswerBriefing'].map(functionSource);
  assert.ok(code.every(Boolean));
  const api = compileFunction(`${code.join('\n')}\nreturn { installSemanticZoom, renderAnswerBriefing, closeAnswerBriefing, openAnswerBriefing };`,
    Object.keys(deps))(...Object.values(deps));
  actualFit = production('fitBriefingTargets', { ...deps, briefingFitCamera: production('briefingFitCamera', deps) });
  const semantic = api.installSemanticZoom(viewport, layer);
  const listeners = new Set(), epochScope = ChatState.createChatEpochScope();
  const scopeStart = overlay.indexOf('      createBriefingPreparationScope(');
  const scopeEnd = overlay.indexOf('\n      },', scopeStart);
  assert.ok(scopeStart >= 0 && scopeEnd > scopeStart, 'production preparation scope exists');
  const createBriefingPreparationScope = compileFunction(`return { ${overlay.slice(scopeStart, scopeEnd + 8)}\n };`,
    ['state', 'ChatState', 'getCodexThreadById', 'epochScope'])(state, ChatState, getCodexThreadById, epochScope).createBriefingPreparationScope;
  // Only the source transport is synthetic. A fixture read must still match
  // the captured source and the real room/receipt/presentation guards before
  // the real production function records a per-presentation verified card.
  const verifySyntheticRead = (card, reference = card?._inputReference) => {
    const shown = state.codex.briefingSession;
    if (!card?._inputEvidenceLoaded || !shown?.preparationScope?.current()
        || !guards.briefingReadReferenceCurrent(shown.threadId, reference, shown.preparationScope)) return false;
    const stored = captures.find(({ capture }) => capture.sourceId === reference.sourceId && capture.hash === reference.hash);
    if (!stored || stored.capture.snapshotId !== reference.snapshotId || stored.capture.clientThreadId !== reference.clientThreadId
        || stored.capture.engine.engineId !== reference.engine?.engineId || stored.capture.engine.engineProfileId !== reference.engine?.engineProfileId
        || !stored.bindings.some(binding => binding.bindingId && ['conversationId', 'runId', 'answerId'].every(key => binding[key] === shown.identity[key]))) return false;
    try {
      if (InputContext.inputEvidenceKey(card._inputReference) !== InputContext.inputEvidenceKey(reference)) return false;
      return guards.rememberBriefingMinimapEvidence(shown, reference, card, true);
    } catch { return false; }
  };
  state.codexBridge = {
    subscribe: listener => { listeners.add(listener); listener(state.codex); return () => listeners.delete(listener); },
    createBriefingComments: (_session, paint) => {
      const view = { phase: 'editing', message: '', text: '', originalText: null, canRetry: false,
        pending: false, unconfirmed: false, listState: 'ready', comments: [] };
      return { view: () => view, edit: text => { view.text = comments.text = text; }, dispose() {},
        notify: () => paint(view), refresh: () => paint(view), submit: () => assert.fail('folding cannot submit a comment'),
        captureClosingText: text => { comments.closedText = text; } };
    },
    createBriefingPreparationScope,
    openInputEvidence: (_threadId, reference, options) => {
      if (reference.sourceId === failedPreparation) return Promise.reject(new Error('synthetic preparation failure'));
      const complete = () => {
        const shown = state.codex.briefingSession;
        if (!options.isCurrent() || shown?.preparationScope !== options.briefingScope
            || !guards.briefingReadReferenceCurrent(_threadId, reference, options.briefingScope)) return null;
        const key = InputContext.inputEvidenceKey(reference);
        const card = document.querySelectorAll('.egd-input-evidence-card').find(item => {
          try { return InputContext.inputEvidenceKey(item._inputReference) === key; } catch { return false; }
        });
        if (!card) return null;
        card._inputEvidenceLoaded = true;
        return verifySyntheticRead(card, reference) ? card : null;
      };
      if (!deferred) return Promise.resolve(complete());
      return new Promise(resolve => pending.push(() => resolve(complete())));
    },
  };
  state.codex.briefingSession = { ...BriefingState.beginBriefing(briefing, { zoom, pan, activeEntityId: 'existing-selection' }),
    identity, references: guards.briefingInputReferences(thread, thread.messages[1]), artifacts: [], threadId: thread.id,
    presentationId: 'initial', interaction: { revision: 0 }, _minimapVerifiedEvidence: new Map() };
  state.codex.briefingSession.preparationScope = state.codexBridge.createBriefingPreparationScope(thread.id);
  for (const card of cards) assert.equal(verifySyntheticRead(card), true, 'initial evidence has an exact, scoped synthetic read');
  const render = () => state.renderSemanticProjections();
  const flush = () => { for (const [id, fn] of [...frames]) { frames.delete(id); fn(); } };
  const click = id => { const button = walk(document.documentElement, node => node.dataset.testid === id)[0]; assert.ok(button, id); button.fire('click'); flush(); };
  const proxies = () => cards.map(card => card.querySelector('.egd-semantic-proxy'));
  const mutation = record => { for (const observer of [...observers]) {
    if (!observer.root.contains(record.target) || (record.type === 'attributes'
      && observer.options.attributeFilter && !observer.options.attributeFilter.includes(record.attributeName))) continue;
    observer.callback([{ addedNodes: [], removedNodes: [], ...record }]);
  } };
  const resize = (nextWidth, nextHeight) => {
    window.innerWidth = nextWidth; window.innerHeight = nextHeight;
    mediaQueries.forEach(media => media.listeners.forEach(fn => fn({ matches: media.matches })));
    windowListeners.get('resize')?.forEach(fn => fn());
  };
  const applyCamera = () => {
    const camera = fits.at(-1); assert.ok(camera?.pan && Number.isFinite(camera.zoom));
    state.zoom = state.zoomTarget = camera.zoom; state.pan = { ...camera.pan }; state.panTarget = { ...camera.pan }; render();
  };
  const notifyResize = node => { for (const observer of [...resizeObservers]) if (observer.nodes.has(node)) observer.callback([{ target: node }]); };
  return { state, cards, chat, semantic, focus, fits, pending, frames, render, flush, click, proxies, geometry, createCard, el, document, viewport, mutation, comments, windowListeners, resize, applyCamera, notifyResize, resizeObservers,
    verifySyntheticRead, guards, fixtureCaptures: captures, emit: () => [...listeners].forEach(listener => listener(state.codex)),
    useActualFit: () => { useActualFit = true; },
    mount: () => api.renderAnswerBriefing(), close: (options = { restore: false }) => api.closeAnswerBriefing(options),
    open: (nextBriefing, options = {}) => {
      const current = getCodexThreadById(state.codex, 'room-a'), answer = current.messages.find(row => row.role === 'assistant' && row.answerId === identity.answerId);
      answer.briefing = nextBriefing || briefing;
      return api.openAnswerBriefing(current, answer, options);
    }, briefing,
    failResolution: value => { failResolution = value; }, failPreparation: value => { failedPreparation = value; },
    defer: value => { deferred = value; } };
}

// Only the receiving Chat and a document event adapter are fixtures here.
// Open/step/Exit/ESC/close and their async preparation are production code.
function briefingReturnFocusHarness() {
  const h = briefingSemanticHarness(), document = h.document, handlers = new Map(); h.close();
  document.addEventListener = (type, fn) => { if (!handlers.has(type)) handlers.set(type, new Set()); handlers.get(type).add(fn); };
  document.removeEventListener = (type, fn) => handlers.get(type)?.delete(fn);
  document.body = h.el('body'); document.documentElement.appendChild(document.body);
  const create = document.createElement;
  document.createElement = tag => {
    const node = create(tag), remove = node.remove.bind(node);
    node.remove = () => { const held = node.contains(document.activeElement); remove(); if (held && !node.isConnected) document.body.focus(); };
    return node;
  };
  const surface = h.el('section', { class: 'egd-chat-card', 'aria-label': '원래 대화' });
  const opener = h.el('button', { data: { testid: 'briefing-open', answerId: h.briefing.answerId } }, '브리핑 보기');
  const composer = h.el('textarea', { class: 'egd-codex-input', data: { testid: 'chat-composer', threadId: 'room-a' } });
  surface.append(opener, composer); document.body.appendChild(surface);
  const key = (target, key = 'Escape', extra = {}) => {
    const event = { type: 'keydown', key, target, currentTarget: document, defaultPrevented: false,
      preventDefault() { this.defaultPrevented = true; }, stopPropagation() {}, ...extra };
    for (const fn of [...(handlers.get('keydown') || [])]) fn(event);
    return event;
  };
  return { ...h, surface, opener, composer, key, handlers,
    enter: async (element = opener, options = {}) => { element.focus(); await h.open(undefined, { opener: element, trustedZeroDetail: true, ...options }); h.flush(); },
    exit: () => h.click('briefing-exit') };
}

test('HUM-BRIEF-002 authority: only the exact accepted receipt, room and current preparation protect an evidence View', async t => {
  const valid = briefingSemanticHarness(), shown = valid.state.codex.briefingSession, card = valid.cards[0];
  const receipt = valid.guards.acceptedInputReceipt(valid.state.codex.threads[0], shown.identity);
  assert.equal(receipt?.localMessageId, 'fixture-user-receipt');
  assert.equal(Object.hasOwn(card._inputReference.contextScope, 'conversationId'), false, 'the synthetic first-send origin stays unchanged');
  assert.equal(valid.guards.briefingReadReferenceCurrent('room-a', card._inputReference, shown.preparationScope), true);
  assert.equal(shown._minimapVerifiedEvidence.get(InputContext.inputEvidenceKey(card._inputReference)), card);
  valid.render(); assert.equal(valid.proxies()[0].hidden, false);

  for (const mode of ['missing-receipt', 'wrong-user', 'unaccepted', 'account', 'client', 'profile', 'room', 'disconnected', 'permission', 'scope', 'answer', 'hash']) {
    await t.test(mode, () => {
      const h = briefingSemanticHarness(), session = h.state.codex.briefingSession, target = h.cards[0];
      const room = h.state.codex.threads[0], request = h.state.codex.chatProtocol.requests['fixture-first-request'];
      if (mode === 'missing-receipt') delete request.acceptedInputMessageId;
      else if (mode === 'wrong-user') room.messages[0].localMessageId = 'different-user';
      else if (mode === 'unaccepted') request.status = 'unconfirmed';
      else if (mode === 'account') h.state.codex.authStatus = { ...h.state.codex.authStatus, accountEmail: 'other@example.test' };
      else if (mode === 'client') room.clientBindingId = 'different-client';
      else if (mode === 'profile') room.engineProfileId = 'different-profile';
      else if (mode === 'room') h.state.codex.activeThreadId = 'room-b';
      else if (mode === 'disconnected') h.state.codex.connected = false;
      else if (mode === 'permission') h.state.codex.authStatus = { ...h.state.codex.authStatus, access: { state: 'permissionDenied' } };
      else if (mode === 'scope') session.preparationScope.dispose();
      else if (mode === 'answer') room.messages[1].answerId = 'different-answer';
      else if (mode === 'hash') target._inputReference.hash = 'different-hash';
      assert.equal(h.guards.briefingReadReferenceCurrent('room-a', target._inputReference, session.preparationScope), false, mode);
      assert.equal(h.verifySyntheticRead(target), false, `${mode}: fixture read cannot reauthorize the target`);
      h.render(); assert.equal(h.proxies()[0].hidden, true, `${mode}: the View is not protected`);
    });
  }
  await t.test('a 200-like source response without this answer binding does not prove a read', () => {
    const h = briefingSemanticHarness(), session = h.state.codex.briefingSession, target = h.cards[0];
    session._minimapVerifiedEvidence.delete(InputContext.inputEvidenceKey(target._inputReference));
    h.fixtureCaptures[0].bindings.splice(0);
    assert.equal(h.guards.briefingReadReferenceCurrent('room-a', target._inputReference, session.preparationScope), true,
      'a valid local receipt does not replace the server binding check');
    assert.equal(h.verifySyntheticRead(target), false);
    h.render(); assert.equal(h.proxies()[0].hidden, true);
  });
  await t.test('same-key card without a verified read', () => {
    const h = briefingSemanticHarness(), session = h.state.codex.briefingSession;
    const imposter = h.createCard('unverified-same-key', 'input-evidence', h.geometry(h.cards[0]));
    imposter._inputReference = { ...h.cards[0]._inputReference }; imposter._inputEvidenceLoaded = true;
    assert.equal(h.guards.rememberBriefingMinimapEvidence(session, imposter._inputReference, imposter), false);
    assert.equal(session._minimapVerifiedEvidence.get(InputContext.inputEvidenceKey(imposter._inputReference)), h.cards[0]);
  });
});

test('HUM-BRIEF-002 return: explicit Exit after real step/overview/viewport transitions returns to the first receiving element', async () => {
  const h = briefingReturnFocusHarness(); await h.enter();
  h.click('briefing-next'); h.click('briefing-overview'); h.resize(1280, 800); h.click('briefing-next'); h.resize(720, 600);
  const exit = h.document.getElementById('egd-answer-briefing').querySelectorAll('button').find(node => node.dataset.testid === 'briefing-exit');
  exit.focus(); h.exit();
  assert.equal(h.document.activeElement, h.opener); assert.equal(h.state.codex.briefingSession, null);
  assert.equal(h.document.getElementById('egd-answer-briefing'), null);
  assert.equal(h.handlers.get('keydown').size, 0, 'return and entry-intent listeners have the same presentation lifetime');
});

test('HUM-BRIEF-002 return: scoped ESC restores its receiving button; IME, prevented events and another input do not close or steal focus', async () => {
  const h = briefingReturnFocusHarness(); await h.enter();
  const nav = h.document.getElementById('egd-answer-briefing').querySelector('nav'); nav.focus();
  h.key(nav, 'Escape', { isComposing: true }); assert.ok(h.state.codex.briefingSession);
  h.key(nav, 'Escape', { defaultPrevented: true }); assert.ok(h.state.codex.briefingSession);
  const other = h.el('textarea'); h.document.body.appendChild(other); other.focus(); other.value = '다른 입력';
  h.key(other); assert.ok(h.state.codex.briefingSession); assert.equal(h.document.activeElement, other);
  nav.focus(); h.key(nav); assert.equal(h.state.codex.briefingSession, null); assert.equal(h.document.activeElement, h.opener);
  assert.equal(other.value, '다른 입력');
});

test('HUM-BRIEF-002 return: auto-close, account/room/profile loss, programmatic restore and another focused input never return focus', async () => {
  for (const mode of ['restore-false', 'programmatic', 'room', 'account', 'profile', 'other-input', 'evidence-input']) {
    const h = briefingReturnFocusHarness(); await h.enter();
    const other = h.el('textarea'); (mode === 'evidence-input' ? h.cards[0] : h.document.body).appendChild(other); other.focus(); other.value = '보존';
    if (mode === 'restore-false') h.close({ restore: false });
    else if (mode === 'programmatic') h.close({ restore: true });
    else if (mode === 'room') { h.state.codex.activeThreadId = 'room-b'; h.emit(); }
    else if (mode === 'account') { h.state.codex.authStatus = { ...h.state.codex.authStatus, accountEmail: 'other@example.test' }; h.emit(); }
    else if (mode === 'profile') { h.state.codex.threads[0].engineProfileId = 'another-profile'; h.emit(); }
    else h.exit();
    assert.equal(h.document.activeElement, other, mode); assert.equal(other.value, '보존'); assert.equal(h.state.codex.briefingSession, null, mode);
  }
});

test('HUM-BRIEF-002 return: fallback stays in the original surface and never guesses another same-title button or destructive control', async () => {
  for (const mode of ['replaced-button', 'composer', 'hidden', 'disabled', 'surface-gone']) {
    const h = briefingReturnFocusHarness(); await h.enter();
    const wrong = h.el('button', { data: { testid: 'briefing-open', answerId: 'other-answer' } }, '브리핑 보기'); h.surface.appendChild(wrong);
    let expected = h.composer;
    if (mode === 'replaced-button') {
      h.opener.remove(); expected = h.el('button', { data: { testid: 'briefing-open', answerId: h.briefing.answerId } }, '브리핑 보기'); h.surface.appendChild(expected);
    } else if (mode === 'composer') h.opener.remove();
    else if (mode === 'hidden') h.opener.setAttribute('hidden', '');
    else if (mode === 'disabled') h.opener.setAttribute('disabled', '');
    else { h.surface.remove(); expected = h.document.body; }
    const exit = h.document.getElementById('egd-answer-briefing').querySelectorAll('button').find(node => node.dataset.testid === 'briefing-exit');
    exit.focus(); h.exit(); assert.equal(h.document.activeElement, expected, mode); assert.notEqual(h.document.activeElement, wrong);
  }
});

test('HUM-BRIEF-002 return: stale old-step/old-presentation Exit and delayed preparation cannot close or refocus a newer presentation', async () => {
  const h = briefingReturnFocusHarness(); await h.enter();
  const old = h.document.getElementById('egd-answer-briefing').querySelectorAll('button').find(node => node.dataset.testid === 'briefing-exit');
  h.click('briefing-next'); const samePresentation = h.state.codex.briefingSession; old.fire('click');
  assert.equal(h.state.codex.briefingSession, samePresentation);
  const newOpener = h.el('button', { data: { testid: 'briefing-open', answerId: h.briefing.answerId } }, '새 진입'); h.surface.appendChild(newOpener);
  await h.enter(newOpener); const newer = h.state.codex.briefingSession; old.fire('click'); assert.equal(h.state.codex.briefingSession, newer);
  h.document.getElementById('egd-answer-briefing').querySelector('nav').focus(); h.exit(); assert.equal(h.document.activeElement, newOpener);
  h.defer(true); const opening = h.enter(); await Promise.resolve();
  h.document.getElementById('egd-answer-briefing').querySelector('nav').focus(); h.exit();
  const other = h.el('textarea'); h.document.body.appendChild(other); other.focus();
  h.pending.at(-1)(); await opening; h.flush(); assert.equal(h.document.activeElement, other); assert.equal(h.state.codex.briefingSession, null);
});

test('HUM-BRIEF-002 return: focus/connection changed by teardown or selection restoration is not overwritten', async () => {
  for (const mode of ['new-focus', 'account', 'room-aba', 'new-session', 'selection-new-focus', 'selection-room-aba']) {
    const h = briefingReturnFocusHarness(); await h.enter();
    const other = h.el('textarea'); h.document.body.appendChild(other);
    const session = h.state.codex.briefingSession, dispose = session.commentEditor.dispose;
    session.commentEditor.dispose = () => {
      dispose();
      if (mode === 'new-focus') other.focus();
      else if (mode === 'account') h.state.codex.authStatus = { ...h.state.codex.authStatus, accountEmail: 'other@example.test' };
      else if (mode === 'room-aba') { h.state.codex.activeThreadId = 'room-b'; h.emit(); h.state.codex.activeThreadId = 'room-a'; }
      else if (mode === 'new-session') h.state.codex.briefingSession = { ...session, presentationId: 'newer-presentation' };
    };
    h.state.onSelectionRestore = () => {
      if (mode === 'selection-new-focus') other.focus();
      else if (mode === 'selection-room-aba') { h.state.codex.activeThreadId = 'room-b'; h.emit(); h.state.codex.activeThreadId = 'room-a'; }
    };
    h.document.getElementById('egd-answer-briefing').querySelector('nav').focus(); h.exit();
    assert.notEqual(h.document.activeElement, h.opener, mode);
    if (mode === 'new-focus' || mode === 'selection-new-focus') assert.equal(h.document.activeElement, other);
    if (mode === 'new-session') assert.equal(h.state.codex.briefingSession?.presentationId, 'newer-presentation');
  }
});

test('HUM-BRIEF-002: measured 720x600 keeps all six verified targets at their own semantic proxy positions', () => {
  const h = briefingSemanticHarness(), before = h.cards.map(card => ({ style: { ...card.style }, resource: card.resource }));
  h.render();
  assert.equal(h.proxies().filter(proxy => !proxy.hidden).length, 6);
  assert.deepEqual(h.semantic.snapshot().clusters, [], 'ordinary Chat cannot absorb the six protected targets');
  for (const [index, proxy] of h.proxies().entries()) {
    const card = h.cards[index], rect = h.geometry(card), inverse = 1 / h.state.zoom;
    assert.equal(proxy.dataset.viewId, card.id);
    assert.equal(proxy.dataset.lod, 'marker');
    assert.ok(Math.abs(Number.parseFloat(proxy.style.left) - (rect.width / 2 - 18 * inverse)) < 1e-9);
    assert.ok(Math.abs(Number.parseFloat(proxy.style.top) - (rect.height / 2 - 18 * inverse)) < 1e-9);
    assert.deepEqual(card.style, before[index].style);
    assert.equal(card.resource, before[index].resource);
  }
  assert.equal(h.state.zoom, .04671717171717172, 'no zoom floor, fit or permanent layout change');
});

test('HUM-BRIEF-002: the normal 1280x800 projection is unchanged by the Briefing exception', () => {
  const h = briefingSemanticHarness({ width: 1280, height: 800, zoom: .2824561403508772,
    pan: { x: 743.578947368421, y: 286.8421052631579 } });
  const session = h.state.codex.briefingSession;
  h.state.codex.briefingSession = null; h.render();
  const normal = h.semantic.snapshot(), styles = h.proxies().map(proxy => ({ ...proxy.style }));
  h.state.codex.briefingSession = session; h.render();
  assert.deepEqual(h.semantic.snapshot(), normal);
  assert.deepEqual(h.proxies().map(proxy => ({ ...proxy.style })), styles);
  assert.deepEqual(normal.clusters, []);
});

test('HUM-BRIEF-002: actual step/overview/exit controls replace and discard the temporary exclusions', () => {
  const h = briefingSemanticHarness(); h.mount(); h.render();
  h.click('briefing-next'); h.render();
  assert.equal(h.proxies().filter(proxy => !proxy.hidden).length, 1);
  assert.equal(h.proxies()[0].hidden, false);
  h.click('briefing-overview'); h.render();
  assert.equal(h.proxies().filter(proxy => !proxy.hidden).length, 6);
  h.click('briefing-next'); h.render();
  for (const index of [3, 4, 5]) assert.equal(h.proxies()[index].hidden, false);
  assert.ok(h.semantic.snapshot().clusters.every(cluster => cluster.memberIds.every(id => !['evidence-3', 'evidence-4', 'evidence-5'].includes(id))));
  h.click('briefing-exit'); h.render();
  assert.equal(h.state.codex.briefingSession, null);
  assert.equal(h.semantic.snapshot().clusters[0].count, 7, 'normal clustering returns after exit');
});

test('HUM-BRIEF-002: stale/hash/range failures and room loss never protect an unverified same-title View', () => {
  const h = briefingSemanticHarness();
  const assertFirstUnprotected = () => {
    h.render(); assert.equal(h.proxies()[0].hidden, true);
    assert.ok(h.semantic.snapshot().clusters.some(cluster => cluster.memberIds.includes('evidence-0') && cluster.memberIds.includes('ordinary-chat')));
  };
  h.cards[0]._inputEvidenceLoaded = false; assertFirstUnprotected();
  h.cards[0]._inputEvidenceLoaded = true; h.cards[0]._inputReference.hash = 'wrong'; assertFirstUnprotected();
  h.cards[0]._inputReference.hash = 'hash-0';
  h.state.codex.briefingSession.briefing.steps[0].targets[0].range = { startLine: null }; assertFirstUnprotected();
  delete h.state.codex.briefingSession.briefing.steps[0].targets[0].range;
  h.render(); assert.equal(h.proxies().filter(proxy => !proxy.hidden).length, 6);
  h.failResolution(true); h.render(); assert.equal(h.semantic.snapshot().clusters[0].count, 7);
  h.failResolution(false); h.mount(); h.click('briefing-overview');
  h.failResolution('single'); h.render();
  assert.equal(h.semantic.snapshot().clusters[0].count, 7, 'overview resolution failure discards even the earlier verified step ids');
  h.failResolution(false); h.state.codex.activeThreadId = 'another-room'; h.render();
  assert.equal(h.semantic.snapshot().clusters[0].count, 7);
  h.state.codex.briefingSession.preparationScope.dispose(); h.state.codex.activeThreadId = 'room-a'; h.render();
  assert.equal(h.semantic.snapshot().clusters[0].count, 7, 'returning to the room cannot revive a disposed presentation');
});

test('HUM-BRIEF-002: ordinary Chat clusters and existing pointer/keyboard focus remain intact', () => {
  const h = briefingSemanticHarness(); h.createCard('second-chat', 'chat', { x: 175, y: 80, width: 1000, height: 458 }); h.render();
  assert.deepEqual(h.semantic.snapshot().clusters.map(cluster => cluster.memberIds.sort()), [['ordinary-chat', 'second-chat']]);
  h.proxies()[0].fire('click'); assert.equal(h.focus.at(-1), h.cards[0]);
  h.render(); h.proxies()[1].fire('click', { detail: 0 }); assert.equal(h.focus.at(-1), h.cards[1]);
  h.close(); h.render(); assert.equal(h.semantic.snapshot().clusters[0].count, 8);
});

test('HUM-BRIEF-002: late preparation cannot restore exclusions after close or overwrite a new presentation', async () => {
  const h = briefingSemanticHarness(); h.close(); h.cards.forEach(card => { card._inputEvidenceLoaded = false; }); h.defer(true);
  const old = h.open(); assert.equal(h.pending.length, 1); h.close();
  h.defer(false);
  const next = { ...h.briefing, id: 'brief-next', steps: [{ id: 'new-target', text: '새 대상', target: { sourceId: 'source-5', hash: 'hash-5' } }] };
  await h.open(next); h.render();
  assert.equal(h.proxies()[5].hidden, false);
  const presentation = h.state.codex.briefingSession;
  h.pending[0](); await old; h.flush(); h.render();
  assert.equal(h.state.codex.briefingSession, presentation);
  assert.equal(h.proxies()[5].hidden, false);
  assert.ok(h.semantic.snapshot().clusters.every(cluster => !cluster.memberIds.includes('evidence-5')));
  assert.equal(h.cards[0]._inputEvidenceLoaded, false, 'old preparation has no authority to make its target available');
});

test('HUM-BRIEF-002: a preparation failure protects only available targets and a current refresh can recover', async () => {
  const h = briefingSemanticHarness(); h.close(); h.cards.forEach(card => { card._inputEvidenceLoaded = false; });
  h.failPreparation('source-0'); await h.open(); h.flush(); h.render();
  assert.equal(h.cards[0]._inputEvidenceLoaded, false);
  assert.equal(h.proxies()[0].hidden, true);
  assert.equal(h.proxies().filter(proxy => !proxy.hidden).length, 5);
  assert.ok(h.semantic.snapshot().clusters.some(cluster => cluster.memberIds.includes('evidence-0')));
  h.cards[0]._inputEvidenceLoaded = true;
  assert.equal(h.verifySyntheticRead(h.cards[0]), true, 'a current successful read reauthorizes the recovered target');
  h.mount();
  assert.ok(h.frames.size, 'current preparation/evidence refresh schedules a semantic update');
  h.flush(); assert.equal(h.proxies().filter(proxy => !proxy.hidden).length, 6);
});

test('HUM-BRIEF-002 identity: six visible numbers pair actual View IDs with panel rows and named ranges, never same-title Chat or another range', () => {
  const h = briefingSemanticHarness(), targets = h.state.codex.briefingSession.briefing.steps[0].targets;
  targets[0].range = { startLine: 1, endLine: 4 };
  targets[1] = { ...targets[0], range: { startLine: 5, endLine: 8 } };
  h.cards[0]._inputReference.presentationRange = targets[0].range;
  h.cards[1]._inputReference = { ...h.cards[0]._inputReference, presentationRange: targets[1].range };
  assert.equal(h.verifySyntheticRead(h.cards[0]), true, 'first requested range is verified');
  assert.equal(h.verifySyntheticRead(h.cards[1]), true, 'second requested range is verified separately');
  const other = h.createCard('same-name-other-range', 'input-evidence', { x: 352, y: -402, width: 616, height: 458 });
  other._inputReference = { ...h.cards[0]._inputReference, presentationRange: { startLine: 9, endLine: 12 } }; other._inputEvidenceLoaded = true;
  const before = h.cards.map(h.geometry), resources = h.cards.map(card => card.resource);
  h.mount(); h.render();
  const rows = h.document.getElementById('egd-answer-briefing').querySelectorAll('.egd-briefing-evidence-row');
  for (const [index, proxy] of h.proxies().entries()) {
    const range = index === 0 ? '1–4행' : index === 1 ? '5–8행' : '범위 미지정';
    assert.equal(proxy.querySelector('.egd-semantic-icon').textContent, String(index + 1), 'visible marker number, not six identical file glyphs');
    assert.equal(rows[index].querySelector('.egd-briefing-evidence-name').textContent, `${index + 1}. 같은 제목`);
    const identity = `근거 ${index + 1} · 같은 제목 · ${range}`;
    assert.ok(proxy.getAttribute('aria-label').startsWith(identity));
    assert.ok(rows[index].getAttribute('aria-label').startsWith(identity));
    assert.equal(proxy.dataset.viewId, h.cards[index].id);
  }
  for (const card of [other, h.chat]) {
    assert.doesNotMatch(card.querySelector('.egd-semantic-proxy').getAttribute('aria-label'), /^근거 \d/);
    assert.doesNotMatch(card.querySelector('.egd-semantic-icon').textContent, /^\d+$/);
  }
  assert.deepEqual(h.cards.map(h.geometry), before); assert.deepEqual(h.cards.map(card => card.resource), resources);
  assert.equal(h.state.zoom, .04671717171717172); assert.equal(h.focus.length, 0, 'labelling cannot focus, move or fit a card');
});

test('HUM-BRIEF-002 identity: actual step/overview/exit controls discard old labels and keep panel/proxy numbers paired', () => {
  const h = briefingSemanticHarness(); h.mount();
  const glyphs = h.proxies().map(proxy => proxy.querySelector('.egd-semantic-icon').firstChild);
  h.render();
  const oldRow = h.document.getElementById('egd-answer-briefing').querySelector('.egd-briefing-evidence-name');
  h.click('briefing-next'); h.render();
  assert.equal(oldRow.textContent, '같은 제목', 'detached previous panel is restored');
  assert.equal(h.proxies()[0].querySelector('.egd-semantic-icon').textContent, '1');
  assert.ok(h.proxies().slice(1).every(proxy => !/^\d+$/.test(proxy.querySelector('.egd-semantic-icon').textContent)));
  h.click('briefing-next'); h.render();
  for (const [index, proxy] of h.proxies().slice(3).entries()) assert.equal(proxy.querySelector('.egd-semantic-icon').textContent, String(index + 1));
  h.click('briefing-overview'); h.render();
  const row = h.document.getElementById('egd-answer-briefing').querySelector('.egd-briefing-evidence-name');
  assert.equal(row.textContent, '1. 같은 제목');
  assert.equal(h.proxies()[3].querySelector('.egd-semantic-icon').textContent, '1', 'overview keeps current-step correspondence');
  assert.equal(new Set(h.proxies().map(proxy => proxy.querySelector('.egd-semantic-icon').textContent)).size, 6);
  h.click('briefing-exit'); h.render();
  assert.equal(row.textContent, '같은 제목');
  assert.ok(h.proxies().every(proxy => !/^\d+$/.test(proxy.querySelector('.egd-semantic-icon').textContent)));
  h.proxies().forEach((proxy, index) => assert.equal(proxy.querySelector('.egd-semantic-icon').firstChild, glyphs[index], 'restore the original glyph node, not a cloned card or replacement'));
});

test('HUM-BRIEF-002 identity: failed/missing/late targets and room loss clear labels, while an active wide Briefing keeps its correspondence', () => {
  const h = briefingSemanticHarness(); h.cards[0]._inputEvidenceLoaded = false; h.mount(); h.render();
  const panel = h.document.getElementById('egd-answer-briefing'), firstName = panel.querySelector('.egd-briefing-evidence-name');
  const firstRow = panel.querySelector('.egd-briefing-evidence-row');
  const retry = panel.querySelectorAll('button').find(node => node.dataset.testid === 'briefing-show-evidence');
  const exposed = node => [node.textContent, JSON.stringify(node.attributes || {}), JSON.stringify(node.dataset || {}),
    ...(node.children || []).flatMap(exposed)];
  assert.equal(firstName.textContent, '근거 1', 'an unverified source must use the non-disclosing fallback');
  assert.doesNotMatch(exposed(firstRow).join('\n'), /같은 제목/, 'the unavailable row text, attributes and descendants do not disclose the name');
  assert.ok(retry, 'an unavailable source can still be retried');
  assert.doesNotMatch(exposed(retry).join('\n'), /같은 제목/, 'the retry text and attributes must also be non-disclosing');
  assert.equal(panel.querySelectorAll('.egd-briefing-evidence-name')[1].textContent, '2. 같은 제목',
    'a different verified row with the same original title still keeps its own name');
  assert.equal(h.proxies()[1].querySelector('.egd-semantic-icon').textContent, '2', 'unavailable rows keep their reserved position');
  h.cards[0]._inputEvidenceLoaded = true; h.mount(); h.flush();
  assert.equal(firstName.textContent, '1. 같은 제목');
  h.cards[0].remove(); h.render(); assert.equal(firstName.textContent, '같은 제목');
  h.failResolution(true); h.render();
  assert.ok(panel.querySelectorAll('.egd-briefing-evidence-name').every(name => name.textContent === '같은 제목'));
  h.failResolution(false); h.render(); h.state.codex.activeThreadId = 'another-room'; h.render();
  assert.ok(h.proxies().slice(1).every(proxy => !/^\d+$/.test(proxy.querySelector('.egd-semantic-icon').textContent)));
  const normal = briefingSemanticHarness({ width: 1280, height: 800, zoom: .2824561403508772,
    pan: { x: 743.578947368421, y: 286.8421052631579 } });
  normal.mount(); normal.render();
  assert.deepEqual(normal.document.querySelectorAll('.egd-briefing-evidence-name').map(name => name.textContent),
    [1, 2, 3, 4, 5, 6].map(number => `${number}. 같은 제목`));
  assert.deepEqual(normal.proxies().map(proxy => proxy.querySelector('.egd-semantic-icon').textContent), ['1', '2', '3', '4', '5', '6']);
  normal.close(); normal.render();
  assert.ok(normal.proxies().every(proxy => !/^\d+$/.test(proxy.querySelector('.egd-semantic-icon').textContent)));
});

test('HUM-BRIEF-002 identity: a verified retry restores its original name without overriding later focus or camera', async () => {
  const h = briefingReturnFocusHarness(); await h.enter();
  const panel = h.document.getElementById('egd-answer-briefing'), session = h.state.codex.briefingSession, card = h.cards[0];
  const name = panel.querySelector('.egd-briefing-evidence-name'), key = InputContext.inputEvidenceKey(card._inputReference);
  assert.equal(h.guards.briefingReadReferenceCurrent('room-a', card._inputReference, session.preparationScope), true);
  assert.equal(session._minimapVerifiedEvidence.get(key), card, 'the original name is backed by the exact successful read');
  assert.equal(name.textContent, '1. 같은 제목');

  card._inputEvidenceLoaded = false; session._minimapVerifiedEvidence.delete(key); h.mount(); h.flush();
  assert.equal(name.textContent, '근거 1');
  const retry = panel.querySelectorAll('button').find(node => node.dataset.testid === 'briefing-show-evidence');
  assert.ok(retry); h.defer(true);
  const beforeFits = h.fits.length, beforeCamera = { zoom: h.state.zoom, zoomTarget: h.state.zoomTarget,
    pan: { ...h.state.pan }, panTarget: { ...h.state.panTarget } };
  retry.fire('click'); assert.equal(h.pending.length, 1, 'the explicit retry requests the source again');
  const editor = h.el('textarea'); h.document.body.appendChild(editor); editor.value = '보존'; editor.focus();
  h.pending[0](); await new Promise(resolve => setImmediate(resolve)); h.flush(); h.render();

  assert.equal(session._minimapVerifiedEvidence.get(key), card, 'the successful retry passes the same scoped read guard');
  assert.equal(name.textContent, '1. 같은 제목', 'a verified source keeps its original name');
  assert.equal(h.document.activeElement, editor); assert.equal(editor.value, '보존');
  assert.equal(h.fits.length, beforeFits, 'a late retry cannot refit after the user changes focus');
  assert.deepEqual({ zoom: h.state.zoom, zoomTarget: h.state.zoomTarget, pan: h.state.pan, panTarget: h.state.panTarget }, beforeCamera);
  assert.equal(panel.querySelectorAll('button').some(node => node.dataset.testid === 'briefing-show-evidence'), false);
});

test('HUM-BRIEF-002 identity: a newly available live View rebinds its row on semantic refresh without relying on cached IDs', () => {
  const h = briefingSemanticHarness(); h.mount(); h.render();
  const row = h.document.getElementById('egd-answer-briefing').querySelector('.egd-briefing-evidence-row');
  const original = h.cards[0], card = h.createCard('reopened-evidence-0', 'input-evidence', h.geometry(original));
  original.remove(); card._inputReference = { ...original._inputReference }; card._inputEvidenceLoaded = false;
  h.render(); assert.equal(row.querySelector('.egd-briefing-evidence-name').textContent, '같은 제목');
  card._inputEvidenceLoaded = true;
  assert.equal(h.verifySyntheticRead(card), true, 'the reopened View requires its own current successful read');
  h.render();
  assert.equal(card.querySelector('.egd-semantic-proxy').querySelector('.egd-semantic-icon').textContent, '1');
  assert.equal(row.querySelector('.egd-briefing-evidence-name').textContent, '1. 같은 제목');
  assert.equal(row.getAttribute('aria-label').split(' · ').slice(0, 3).join(' · '), '근거 1 · 같은 제목 · 범위 미지정');
});

test('HUM-BRIEF-002 keyboard: native summary and nested original controls are barred only while replaced, with exact inert/tabindex restoration', () => {
  const h = briefingSemanticHarness(), previousInert = [null, '', 'preserve-value', null, '', 'other-value'];
  const originals = h.cards.map((card, index) => {
    const summary = h.el('summary', {}, '원본 요약'), button = h.el('button', { tabindex: '2' }, '원본 작업');
    const link = h.el('a', { href: '#synthetic', tabindex: '0' }, '원본 링크');
    const details = h.el('details', { 'aria-hidden': 'false' }, summary, button, link);
    if (previousInert[index] !== null) details.setAttribute('inert', previousInert[index]);
    card.appendChild(details); return { details, summary, button, link };
  });
  const outsideFocus = h.document.activeElement; h.mount(); h.render();
  for (const { details, summary, button, link } of originals) {
    assert.equal(details.inert, true, 'all hidden original subtrees are inert, not just aria-hidden');
    assert.equal(summary.getAttribute('tabindex'), '-1', 'native summary must not remain a 0.75px Tab destination');
    assert.equal(button.getAttribute('tabindex'), '-1'); assert.equal(link.getAttribute('tabindex'), '-1');
  }
  assert.ok(h.proxies().every(proxy => !proxy.closest('[inert]')), 'replacement buttons remain keyboard candidates');
  assert.ok(h.proxies().every(proxy => !proxy.hidden && proxy.getAttribute('tabindex') !== '-1'));
  assert.equal(h.document.activeElement, outsideFocus, 'no focus is stolen while changing the representations');
  h.close(); h.state.zoom = 1; h.render();
  for (const [index, { details, summary, button, link }] of originals.entries()) {
    assert.equal(details.getAttribute('inert'), previousInert[index]);
    assert.equal(details.getAttribute('aria-hidden'), 'false');
    assert.equal(summary.getAttribute('tabindex'), null); assert.equal(button.getAttribute('tabindex'), '2'); assert.equal(link.getAttribute('tabindex'), '0');
  }
  h.state.zoom = .04671717171717172; h.render(); h.cards[0].remove(); h.render();
  assert.equal(originals[0].details.getAttribute('inert'), null);
  assert.equal(originals[0].summary.getAttribute('tabindex'), null, 'removing a compact card releases the original Tab environment');
  assert.equal(originals[0].button.getAttribute('tabindex'), '2');
});

test('HUM-BRIEF-002 keyboard: late original children and author changes are restored without changing global keys or focus', () => {
  const h = briefingSemanticHarness(); h.mount(); h.render();
  const child = h.el('details', {}, h.el('summary', {}, '나중 요약'), h.el('button', { tabindex: '3' }, '나중 작업'));
  h.cards[0].appendChild(child); h.mutation({ type: 'childList', target: h.cards[0], addedNodes: [child] }); h.flush();
  assert.equal(child.inert, true); assert.equal(child.firstChild.getAttribute('tabindex'), '-1');
  const button = child.querySelector('button'); button.setAttribute('tabindex', '4');
  h.mutation({ type: 'attributes', target: button, attributeName: 'tabindex' });
  child.setAttribute('inert', 'author-value'); h.mutation({ type: 'attributes', target: child, attributeName: 'inert' }); h.flush();
  assert.equal(button.getAttribute('tabindex'), '-1');
  h.close(); h.state.zoom = 1; h.render();
  assert.equal(button.getAttribute('tabindex'), '4'); assert.equal(child.getAttribute('inert'), 'author-value');
  assert.equal(child.firstChild.getAttribute('tabindex'), null);
  assert.equal(h.focus.length, 0);
});

test('HUM-BRIEF-002 fold: narrow viewport starts with only its existing title/navigation row, above actual dock and zoom bounds', () => {
  for (const [width, height, zoomTop] of [[720, 600, 480], [390, 680, 551], [820, 540, 402]]) {
    const h = briefingSemanticHarness({ width, height });
    for (const [id, top, bottom] of [['egd-dock', height - 66, height - 12], ['egd-zoom-indicator', zoomTop, zoomTop + 39]]) {
      const node = h.el('div', { id }); node.getBoundingClientRect = () => ({ left: 88, right: width - 12, top, bottom, width: width - 100, height: bottom - top });
      h.document.documentElement.appendChild(node);
    }
    h.mount(); h.render();
    const panel = h.document.getElementById('egd-answer-briefing'), body = panel.querySelector('.egd-briefing-body');
    assert.equal(panel.dataset.compact, 'true'); assert.equal(panel.dataset.expanded, 'false');
    assert.ok(body?.hidden, 'explanation, ranges and comment editor begin folded, not a central occluder');
    const header = panel.querySelector('.egd-briefing-header'); assert.ok(header);
    for (const id of ['briefing-previous', 'briefing-next', 'briefing-overview', 'briefing-exit', 'briefing-toggle'])
      assert.ok(header.querySelectorAll('button').some(node => node.dataset.testid === id), id);
    assert.match(header.textContent, /답변 브리핑/); assert.match(header.textContent, /1 \/ 3/);
    assert.ok(panel.getBoundingClientRect().bottom < zoomTop && panel.getBoundingClientRect().bottom < height - 66);
    if (width >= 720) assert.equal(h.proxies().filter(proxy => !proxy.hidden).length, 6);
    assert.deepEqual(h.proxies().map(proxy => proxy.querySelector('.egd-semantic-icon').textContent), ['1', '2', '3', '4', '5', '6']);
    assert.equal(h.fits.length, 0, 'fold initialization is not a camera action');
  }
});

test('HUM-BRIEF-002 fold: toggling preserves the same comment DOM, draft, cursor, editor and internal scroll without fitting the camera', () => {
  const h = briefingSemanticHarness({ realComments: true }); h.mount(); h.render();
  const panel = h.document.getElementById('egd-answer-briefing'), editor = h.state.codex.briefingSession.commentEditor;
  const before = JSON.stringify([h.state.zoom, h.state.pan, h.state.activeEntityId, h.cards.map(h.geometry)]);
  const toggle = panel.querySelectorAll('button').find(node => node.dataset.testid === 'briefing-toggle'); assert.ok(toggle);
  h.click('briefing-toggle');
  const body = panel.querySelector('.egd-briefing-body'), input = body.querySelector('textarea');
  input.value = '저장하지 않은 한글 의견'; input.fire('input'); input.setSelectionRange(2, 6, 'backward'); input.scrollTop = 11; body.scrollTop = 97;
  h.click('briefing-toggle'); assert.equal(body.hidden, true);
  h.click('briefing-toggle'); assert.equal(body.hidden, false);
  assert.equal(h.document.getElementById('egd-answer-briefing'), panel); assert.equal(body.querySelector('textarea'), input);
  assert.equal(h.state.codex.briefingSession.commentEditor, editor); assert.equal(h.comments.mounts, 1); assert.equal(h.comments.disposals, 0);
  assert.equal(h.comments.text, '저장하지 않은 한글 의견');
  assert.deepEqual([input.value, input.selectionStart, input.selectionEnd, input.selectionDirection, input.scrollTop, body.scrollTop],
    ['저장하지 않은 한글 의견', 2, 6, 'backward', 11, 97]);
  assert.equal(toggle.getAttribute('aria-controls'), body.id); assert.equal(toggle.getAttribute('aria-expanded'), 'true');
  assert.equal(h.fits.length, 0); assert.equal(h.focus.length, 0);
  assert.equal(JSON.stringify([h.state.zoom, h.state.pan, h.state.activeEntityId, h.cards.map(h.geometry)]), before);
});

test('HUM-BRIEF-002 fold: collapse waits for live IME and focus to leave the editor instead of hiding or replacing it', () => {
  const h = briefingSemanticHarness({ realComments: true }); h.mount(); h.click('briefing-toggle');
  const panel = h.document.getElementById('egd-answer-briefing'), body = panel.querySelector('.egd-briefing-body'), input = body.querySelector('textarea');
  input.focus(); input.value = '아직 조합 중'; input.setSelectionRange(3, 5); input.fire('compositionstart');
  let prevented = false;
  const toggle = panel.querySelectorAll('button').find(node => node.dataset.testid === 'briefing-toggle');
  toggle.fire('mousedown', { button: 0, preventDefault() { prevented = true; } }); toggle.fire('click');
  assert.equal(prevented, true); assert.equal(body.hidden, false); assert.equal(h.document.activeElement, input);
  input.fire('compositionend'); assert.equal(body.hidden, false, 'compositionend must not race its final input event');
  input.value += ' 최종'; input.fire('input'); h.viewport.focus(); input.fire('focusout', { relatedTarget: h.viewport });
  assert.equal(body.hidden, true); h.click('briefing-toggle');
  assert.equal(body.querySelector('textarea'), input); assert.equal(input.value, '아직 조합 중 최종');
  assert.deepEqual([input.selectionStart, input.selectionEnd], [3, 5]); assert.equal(h.comments.disposals, 0);
  assert.equal(h.fits.length, 0);
});

test('HUM-BRIEF-002 fold: late preparation after a fold interaction keeps the same panel/editor and cannot refit the camera', async () => {
  const h = briefingSemanticHarness({ realComments: true }); h.close(); h.cards.forEach(card => { card._inputEvidenceLoaded = false; }); h.defer(true);
  const opening = h.open(), panel = h.document.getElementById('egd-answer-briefing');
  h.click('briefing-toggle');
  const input = panel.querySelector('textarea'), editor = h.state.codex.briefingSession.commentEditor;
  input.value = '준비 중 보존할 초안'; input.fire('input'); input.setSelectionRange(1, 5, 'backward');
  h.defer(false); h.pending[0](); await opening; h.flush();
  assert.equal(h.document.getElementById('egd-answer-briefing'), panel); assert.equal(panel.querySelector('textarea'), input);
  assert.equal(h.state.codex.briefingSession.commentEditor, editor);
  assert.equal(panel.dataset.expanded, 'true'); assert.equal(input.value, '준비 중 보존할 초안');
  assert.deepEqual([input.selectionStart, input.selectionEnd, input.selectionDirection], [1, 5, 'backward']);
  assert.equal(h.fits.length, 0, 'the existing preparation intent guard observes the fold action');
});

test('HUM-BRIEF-002 fold: explicit overview/step fitting measures the real folded panel, while resize/toggle does not fit', () => {
  const h = briefingSemanticHarness(); h.mount(); h.render(); h.useActualFit(); h.click('briefing-toggle');
  const before = h.cards.map(h.geometry), zoom = h.state.zoom;
  h.document.getElementById('egd-answer-briefing').querySelector('.egd-briefing-body').querySelector('button').focus();
  h.click('briefing-overview');
  const panel = h.document.getElementById('egd-answer-briefing'); assert.equal(panel.dataset.expanded, 'false');
  const rect = panel.getBoundingClientRect(), camera = h.fits.at(-1); assert.ok(camera?.pan);
  for (const card of h.cards) {
    const world = h.geometry(card), left = world.x * camera.zoom + camera.pan.x, top = world.y * camera.zoom + camera.pan.y;
    assert.ok(left + world.width * camera.zoom <= rect.left || left >= rect.right
      || top + world.height * camera.zoom <= rect.top || top >= rect.bottom, 'each target remains outside the measured folded panel');
  }
  assert.equal(h.fits.length, 1); h.resize(700, 640); assert.equal(h.fits.length, 1);
  h.click('briefing-next'); assert.equal(h.fits.length, 2);
  assert.equal(h.state.zoom, zoom, 'the shared target setter, not global zoom or world coordinates, owns explicit camera changes');
  assert.deepEqual(h.cards.map(h.geometry), before);
});

test('HUM-BRIEF-002 fold: wide layout stays open and resize/step/exit dispose old layout listeners without losing the live editor', () => {
  const h = briefingSemanticHarness({ width: 1280, height: 800 });
  const initial = h.windowListeners.get('resize')?.size || 0; h.mount();
  const panel = h.document.getElementById('egd-answer-briefing'), body = panel.querySelector('.egd-briefing-body'); assert.ok(body);
  const input = body.querySelector('textarea'); input.value = '크기 변경 중 의견'; input.setSelectionRange(1, 4);
  assert.equal(panel.dataset.compact, 'false'); assert.equal(body.hidden, false);
  assert.equal(panel.querySelectorAll('button').find(node => node.dataset.testid === 'briefing-toggle').hidden, true);
  assert.ok(!panel.style.left && !panel.style.bottom && !panel.style.width, 'desktop CSS keeps its original placement');
  h.resize(720, 600); assert.equal(body.hidden, true); h.click('briefing-toggle');
  h.resize(1280, 800); assert.equal(body.hidden, false); assert.ok(!panel.style.left && !panel.style.bottom);
  h.resize(720, 600); assert.equal(body.hidden, false, 'remember the explicit expand choice within this panel');
  assert.equal(body.querySelector('textarea'), input); assert.equal(input.value, '크기 변경 중 의견');
  assert.deepEqual([input.selectionStart, input.selectionEnd], [1, 4]); assert.equal(h.comments.mounts, 1);
  assert.equal(h.windowListeners.get('resize').size, initial + 1);
  h.click('briefing-next'); assert.equal(h.windowListeners.get('resize').size, initial + 1);
  h.close(); assert.equal(h.windowListeners.get('resize').size, initial);
});

test('HUM-BRIEF-002 fold: scoped responsive CSS keeps desktop geometry and existing dark/high-contrast focus tokens', () => {
  const css = readFileSync(new URL('../overlay/CSS/eg-desk-surface.uc.css', import.meta.url), 'utf8');
  assert.match(css, /#egd-answer-briefing\s*\{[^}]*bottom:\s*108px;\s*left:\s*118px/s);
  assert.match(css, /@media\s*\(max-width:\s*56rem\)[\s\S]*#egd-answer-briefing\[data-compact="true"\]/);
  assert.match(css, /\.egd-briefing-body\s*\{[^}]*order:\s*-1[^}]*overflow-y:\s*auto/s);
  assert.match(css, /#egd-answer-briefing :is\(button, textarea\):focus-visible[^}]*var\(--egd-focus-outline\)/s);
  assert.match(css, /\.egd-briefing-header[^}]*flex-wrap:\s*wrap/s);
});

test('HUM-BRIEF-002 entry: verified row/card identity survives marker, measured outline and wide detail LOD without matching Chat titles', () => {
  const h = briefingSemanticHarness({ width: 1280, height: 800, pan: { x: 743.578947368421, y: 286.8421052631579 } });
  h.mount();
  const before = h.cards.map(h.geometry);
  const rows = h.document.getElementById('egd-answer-briefing').querySelectorAll('.egd-briefing-evidence-row');
  for (const [zoom, level] of [[.04671717171717172, 'marker'], [.21148989898989898, 'outline'], [.2824561403508772, 'detail']]) {
    h.state.zoom = zoom; h.render();
    for (const [index, proxy] of h.proxies().entries()) {
      assert.equal(proxy.dataset.lod, level);
      assert.equal(proxy.querySelector('.egd-semantic-icon').textContent, String(index + 1));
      assert.ok(proxy.querySelector('.egd-semantic-label').textContent.includes('같은 제목'));
      assert.equal(rows[index].querySelector('.egd-briefing-evidence-name').textContent, `${index + 1}. 같은 제목`);
      assert.ok(proxy.getAttribute('aria-label').startsWith(`근거 ${index + 1} · 같은 제목 · 범위 미지정`));
    }
    assert.doesNotMatch(h.chat.querySelector('.egd-semantic-proxy').getAttribute('aria-label'), /^근거 \d/);
  }
  assert.deepEqual(h.cards.map(h.geometry), before);
  h.close(); h.render();
  assert.ok(h.proxies().every(proxy => !/^\d+$/.test(proxy.querySelector('.egd-semantic-icon').textContent)));
});

test('HUM-BRIEF-002 entry: wide detail Tab enters a visible card-sized gate, Enter reads safely, and original close/control behavior returns', () => {
  const h = briefingSemanticHarness({ width: 1280, height: 800, zoom: .2824561403508772,
    pan: { x: 743.578947368421, y: 286.8421052631579 } });
  let closes = 0;
  const originals = h.cards.map(card => {
    card.offsetWidth = h.geometry(card).width + 2; card.offsetHeight = h.geometry(card).height + 2;
    const close = h.el('span', { role: 'button', tabindex: '0', onclick: () => { closes++; } }, '닫기');
    const header = h.el('div', { class: 'egd-card-header' }, close);
    const body = h.el('div', { class: 'egd-card-body' }, h.el('details', {}, h.el('summary', {}, '출처 및 캡처 정보')));
    const proxy = card.querySelector('.egd-semantic-proxy'); card.insertBefore(header, proxy); card.insertBefore(body, proxy);
    return { close, header, body };
  });
  h.mount(); h.render();
  for (const [index, proxy] of h.proxies().entries()) {
    assert.equal(proxy.hidden, false, 'detail retains an unscaled card-level keyboard entry');
    assert.equal(proxy.dataset.briefingMode, 'navigation');
    assert.ok(Number.parseFloat(proxy.style.width) > 100 && Number.parseFloat(proxy.style.height) > 75);
    assert.equal(Number.parseFloat(proxy.style.width), h.cards[index].offsetWidth * h.state.zoom);
    assert.equal(originals[index].close.getAttribute('tabindex'), '-1'); assert.equal(originals[index].header.inert, true);
  }
  const proxy = h.proxies()[0]; proxy.focus(); proxy.fire('click', { detail: 0 });
  assert.equal(closes, 0, 'Enter on the card unit must never invoke the first close control');
  h.applyCamera();
  assert.equal(h.document.activeElement, originals[0].body, 'explicit entry focuses reading content, not a destructive header control');
  assert.equal(proxy.dataset.briefingMode, 'reading'); assert.equal(originals[0].header.inert, false);
  assert.equal(originals[0].close.getAttribute('tabindex'), '0');
  originals[0].close.fire('click'); assert.equal(closes, 1, 'close remains available after explicit entry');
  originals[0].body.fire('keydown', { key: 'Escape' }); h.flush();
  assert.equal(h.document.activeElement, proxy); assert.equal(proxy.dataset.briefingMode, 'navigation');
  assert.equal(originals[0].body.getAttribute('tabindex'), null);
  h.close(); h.state.zoom = 1; h.render();
  for (const { close, header, body } of originals) {
    assert.equal(close.getAttribute('tabindex'), '0'); assert.equal(header.inert, false); assert.equal(body.getAttribute('tabindex'), null);
  }
});

test('HUM-BRIEF-002 entry: safe reading fits measured free space at unchanged readable zoom when the actual bounds permit it', () => {
  const h = briefingSemanticHarness({ width: 1000, height: 900, zoom: .21148989898989898 }); h.mount(); h.render();
  const panel = h.document.getElementById('egd-answer-briefing');
  panel.getBoundingClientRect = () => ({ left: 8, top: 580, right: 992, bottom: 628, width: 984, height: 48 });
  const zoomChrome = h.el('div', { id: 'egd-zoom-indicator' });
  zoomChrome.getBoundingClientRect = () => ({ left: 88, top: 760, right: 240, bottom: 800, width: 152, height: 40 }); h.document.documentElement.appendChild(zoomChrome);
  const before = h.cards.map(h.geometry), proxy = h.proxies()[0]; proxy.focus(); proxy.fire('click', { detail: 0 });
  const camera = h.fits.at(-1), card = h.geometry(h.cards[0]), safe = production('safeViewportRect', { document: h.document,
    window: { innerWidth: 1000, innerHeight: 900 } })();
  const originalZoom = Math.min(4, Math.max(.76, 10.6 / 14, 241 / card.width, 181 / card.height,
    SurfaceState.fitSurfaceCamera(card, safe, .85).zoom));
  assert.equal(camera.zoom, originalZoom, 'free-space placement may not silently reduce the reading policy');
  assert.ok(card.y * camera.zoom + camera.pan.y + card.height * camera.zoom < 580, 'readable outer bounds avoid the measured panel when room exists');
  h.applyCamera(); assert.equal(proxy.dataset.briefingExposure, 'bounds-fit');
  h.resize(720, 600);
  panel.getBoundingClientRect = () => ({ left: 86, top: 435, right: 712, bottom: 483, width: 626, height: 48 });
  zoomChrome.getBoundingClientRect = () => ({ left: 88, top: 491, right: 240, bottom: 531, width: 152, height: 40 });
  h.state.zoom = .21148989898989898; h.render(); proxy.focus(); proxy.fire('click', { detail: 0 }); h.applyCamera();
  assert.ok(h.fits.at(-1).zoom >= .76 && h.fits.at(-1).zoom * 14 >= 10.6);
  assert.equal(proxy.dataset.briefingExposure, 'bounds-fit', JSON.stringify({ camera: h.fits.at(-1), panel: panel.getBoundingClientRect(), zoom: zoomChrome.getBoundingClientRect() }));
  assert.ok(card.y * h.fits.at(-1).zoom + h.fits.at(-1).pan.y + card.height * h.fits.at(-1).zoom < 435);
  assert.deepEqual(h.cards.map(h.geometry), before);
});

test('HUM-BRIEF-002 entry: a delayed readable transition cannot take focus from newer typing or revive after a step/room/exit', () => {
  const h = briefingSemanticHarness({ zoom: .2824561403508772 });
  const body = h.el('div', { class: 'egd-card-body' }, h.el('summary', {}, '원문')); h.cards[0].appendChild(body);
  h.mount(); h.render(); const proxy = h.proxies()[0]; proxy.focus(); proxy.fire('click', { detail: 0 });
  const other = h.el('textarea'); h.document.documentElement.appendChild(other); other.focus(); other.value = '새 입력';
  h.applyCamera(); assert.equal(h.document.activeElement, other); assert.equal(other.value, '새 입력');
  assert.notEqual(proxy.dataset.briefingMode, 'reading');
  h.click('briefing-next'); h.render(); assert.equal(body.getAttribute('tabindex'), null);
  h.state.codex.activeThreadId = 'other-room'; h.render(); assert.ok(!proxy.dataset.briefingActive);
  h.close(); h.render(); assert.equal(body.getAttribute('aria-label'), null);
  const sameField = briefingSemanticHarness({ zoom: .21148989898989898 }); sameField.mount(); sameField.render();
  const continuing = sameField.el('textarea'); sameField.document.documentElement.appendChild(continuing); continuing.focus();
  sameField.proxies()[0].fire('click', { detail: 0 });
  continuing.value = '같은 필드에서 시작한 새 입력'; sameField.state.codex.briefingSession.interaction.revision++;
  sameField.applyCamera();
  assert.equal(sameField.document.activeElement, continuing, 'input intent in the same focused field is not a licence for late focus takeover');
  assert.notEqual(sameField.proxies()[0].dataset.briefingMode, 'reading');
  const detached = briefingSemanticHarness({ zoom: .21148989898989898 }); detached.mount(); detached.render();
  const detachedProxy = detached.proxies()[0]; detachedProxy.focus(); detachedProxy.fire('click', { detail: 0 });
  detached.document.getElementById('egd-answer-briefing').remove(); detached.applyCamera();
  assert.ok(!detachedProxy.dataset.briefingActive); assert.equal(detached.cards[0].getAttribute('role'), null);
  assert.notEqual(detachedProxy.dataset.briefingMode, 'reading', 'a lost panel cannot retain or complete an old reading request');
});

test('HUM-BRIEF-002 entry: own synchronous card-selection blur does not cancel explicit reading, but later external focus still does', () => {
  const h = briefingSemanticHarness({ zoom: .21148989898989898, onCardFocus: ({ viewport }) => viewport.focus() });
  const body = h.el('div', { class: 'egd-card-body' }, '원문'); h.cards[0].insertBefore(body, h.proxies()[0]); h.mount(); h.render();
  const previous = h.el('textarea'); h.document.documentElement.appendChild(previous); previous.focus(); previous.value = '기존 다른 초안';
  h.proxies()[0].fire('click'); h.applyCamera();
  assert.equal(h.document.activeElement, body); assert.equal(previous.value, '기존 다른 초안');
  assert.equal(h.proxies()[0].dataset.briefingMode, 'reading');
});

test('HUM-BRIEF-002 entry: immediate/reduced-motion camera application enters the same safe content without waiting for another activation', () => {
  const h = briefingSemanticHarness({ zoom: .21148989898989898, immediateCamera: true });
  const body = h.el('div', { class: 'egd-card-body' }, '원문'); h.cards[0].insertBefore(body, h.proxies()[0]); h.mount(); h.render();
  const proxy = h.proxies()[0]; proxy.focus(); proxy.fire('click', { detail: 0 });
  assert.equal(proxy.dataset.briefingMode, 'reading'); assert.equal(h.document.activeElement, body);
});

test('HUM-BRIEF-002 entry: measured 720 chrome retains the 10.6px reading target and exposes the physically impossible remainder as partial', () => {
  const h = briefingSemanticHarness({ bodyFontPx: 11, zoom: .21148989898989898 });
  const rects = {
    'egd-desk-rail': { left: 0, top: 0, right: 720, bottom: 51 },
    'egd-preset-bag': { left: 14, top: 80, right: 78, bottom: 473 },
    'egd-dock': { left: 18, top: 543, right: 702, bottom: 588 },
    'egd-zoom-indicator': { left: 88, top: 491, right: 239, bottom: 531 },
  };
  for (const [id, rect] of Object.entries(rects)) {
    const chrome = h.el('div', { id }); chrome.getBoundingClientRect = () => ({ ...rect, width: rect.right - rect.left, height: rect.bottom - rect.top });
    h.document.documentElement.appendChild(chrome);
  }
  h.mount(); h.render();
  const panel = h.document.getElementById('egd-answer-briefing');
  panel.getBoundingClientRect = () => ({ left: 86, top: 435, right: 712, bottom: 483, width: 626, height: 48 });
  const proxy = h.proxies()[0]; proxy.focus(); proxy.fire('click', { detail: 0 });
  const camera = h.fits.at(-1); assert.equal(camera.zoom, 10.6 / 11);
  h.applyCamera(); assert.equal(proxy.dataset.briefingMode, 'reading'); assert.equal(proxy.dataset.briefingExposure, 'partial');
  assert.match(proxy.getAttribute('aria-label'), /일부 영역은 이동해 확인/);
  const world = h.geometry(h.cards[0]);
  assert.ok(world.y * camera.zoom + camera.pan.y >= 75, 'the source begins below the measured rail, not above the viewport to fake a fit');
  assert.ok(world.y * camera.zoom + camera.pan.y + Number.parseFloat(proxy.style.top) * camera.zoom >= 51,
    'the identity badge uses the existing chrome gap rather than covering the source or rail');
});

test('HUM-BRIEF-002 entry: local reading attrs restore exactly on Escape, zoom-out and removal without trapping normal input Escape', () => {
  const h = briefingSemanticHarness({ zoom: .2824561403508772 });
  const body = h.el('div', { class: 'egd-card-body', tabindex: '3', role: 'article', 'aria-label': '원래 영역' }, h.el('input', {}));
  h.cards[0].appendChild(body); h.mount(); h.render(); const proxy = h.proxies()[0];
  const enter = () => { proxy.focus(); proxy.fire('click', { detail: 0 }); h.applyCamera(); };
  const assertRestored = () => assert.deepEqual([body.getAttribute('tabindex'), body.getAttribute('role'), body.getAttribute('aria-label')], ['3', 'article', '원래 영역']);
  enter(); enter();
  const input = body.querySelector('input'); input.focus(); input.fire('keydown', { key: 'Escape' }); h.flush();
  assert.equal(proxy.dataset.briefingMode, 'reading', 'input/menu Escape is not a global navigation shortcut');
  body.focus(); body.fire('keydown', { key: 'Escape' }); h.flush();
  assert.equal(body.getAttribute('role'), 'article'); assert.equal(body.getAttribute('aria-label'), '원래 영역');
  enter(); h.state.zoom = .04671717171717172; h.render();
  assert.equal(proxy.dataset.briefingMode, 'navigation'); assert.equal(body.getAttribute('role'), 'article');
  h.close(); h.state.zoom = 1; h.render(); assertRestored();
  const removed = briefingSemanticHarness({ zoom: .2824561403508772 });
  const removedBody = removed.el('div', { class: 'egd-card-body', tabindex: '3', role: 'article', 'aria-label': '원래 영역' });
  removed.cards[0].insertBefore(removedBody, removed.proxies()[0]); removed.mount(); removed.render();
  const removedProxy = removed.proxies()[0]; removedProxy.focus(); removedProxy.fire('click', { detail: 0 }); removed.applyCamera();
  assert.equal(removedProxy.dataset.briefingMode, 'reading'); removed.cards[0].remove(); removed.render();
  assert.deepEqual([removedBody.getAttribute('tabindex'), removedBody.getAttribute('role'), removedBody.getAttribute('aria-label')], ['3', 'article', '원래 영역']);
});

function briefingReadingScrollHarness({ width = 720, authoredMax = '', authoredPriority = '' } = {}) {
  const h = briefingSemanticHarness({ width, height: width > 896 ? 800 : 600, bodyFontPx: 11, zoom: .21148989898989898 });
  const source = Array.from({ length: 100 }, (_value, index) => `QA-LONG ${String(index + 1).padStart(3, '0')} | immutable synthetic source line${index === 99 ? ' FINAL' : ''}`).join('\n');
  const body = h.el('div', { class: 'egd-card-body' }, h.el('pre', {}, source));
  let top = 0;
  Object.defineProperties(body, {
    clientHeight: { get: () => Math.min(424, body.style.maxHeight ? Math.max(0, Number.parseFloat(body.style.maxHeight) - 1) : 424) },
    offsetHeight: { get: () => body.clientHeight + 1 },
    scrollHeight: { get: () => 1544 },
    scrollTop: { get: () => top = Math.min(top, body.scrollHeight - body.clientHeight), set: value => { top = Math.max(0, Math.min(value, body.scrollHeight - body.clientHeight)); } },
  });
  if (authoredMax) body.style.setProperty('max-height', authoredMax, authoredPriority);
  h.cards[0].offsetWidth = 618; h.cards[0].offsetHeight = 460;
  h.cards[0].insertBefore(body, h.proxies()[0]);
  body.getBoundingClientRect = () => {
    const world = h.geometry(h.cards[0]), left = (world.x + 1) * h.state.zoom + h.state.pan.x;
    const y = (world.y + 35) * h.state.zoom + h.state.pan.y;
    return { left, right: left + 616 * h.state.zoom, top: y, bottom: y + body.offsetHeight * h.state.zoom,
      width: 616 * h.state.zoom, height: body.offsetHeight * h.state.zoom };
  };
  const chrome = {}, rects = {
    'egd-desk-rail': { left: 0, top: 0, right: width, bottom: 51 },
    'egd-preset-bag': { left: 14, top: 80, right: 78, bottom: 473 },
    'egd-dock': { left: 18, top: width > 896 ? 743 : 543, right: width - 18, bottom: width > 896 ? 788 : 588 },
    'egd-zoom-indicator': { left: 88, top: 491, right: 239, bottom: 531 },
  };
  for (const [id, rect] of Object.entries(rects)) {
    const node = h.el('div', { id }); node.getBoundingClientRect = () => ({ ...rects[id], width: rects[id].right - rects[id].left, height: rects[id].bottom - rects[id].top });
    h.document.documentElement.appendChild(node); chrome[id] = node;
  }
  h.mount(); const panel = h.document.getElementById('egd-answer-briefing');
  let panelRect = width > 896 ? { left: 118, top: 278, right: 586, bottom: 692 } : { left: 86, top: 435, right: 712, bottom: 483 };
  panel.getBoundingClientRect = () => ({ ...panelRect, width: panelRect.right - panelRect.left, height: panelRect.bottom - panelRect.top });
  h.state.codex.threadDrafts = { 'room-a': 'Chat draft canary' }; h.render();
  const enter = () => { h.proxies()[0].focus(); h.proxies()[0].fire('click', { detail: 0 }); h.applyCamera(); };
  const line = () => { const bottom = body.getBoundingClientRect().top + (1504 - body.scrollTop) * h.state.zoom; return { top: bottom - 14 * h.state.zoom, bottom }; };
  return { ...h, body, panel, chrome, rects, source, enter, line, end: () => { body.scrollTop = body.scrollHeight; },
    setPanel: rect => { panelRect = { ...panelRect, ...rect }; h.notifyResize(panel); h.flush(); } };
}

test('HUM-BRIEF-002 scroll: 100th line is naturally reachable at End above measured 720 occlusion without padding, zoom or world changes', () => {
  const h = briefingReadingScrollHarness(), geometry = h.cards.map(h.geometry), ids = h.cards.map(card => card.id); h.enter();
  const camera = JSON.stringify([h.state.zoom, h.state.pan, h.state.zoomTarget, h.state.panTarget]);
  h.end();
  assert.ok(h.line().bottom < h.panel.getBoundingClientRect().top, 'terminal line cannot stay behind the panel at genuine scroll end');
  assert.ok(h.body.clientHeight < 424); assert.ok(h.body.scrollTop > 1120, 'real scroll viewport, not a fake End state or blank padding');
  assert.equal(h.body.scrollHeight, 1544); assert.equal(h.body.textContent, h.source);
  assert.equal(h.state.zoom, 10.6 / 11); assert.equal(JSON.stringify([h.state.zoom, h.state.pan, h.state.zoomTarget, h.state.panTarget]), camera);
  assert.deepEqual(h.cards.map(h.geometry), geometry); assert.deepEqual(h.cards.map(card => card.id), ids);
  assert.equal(h.state.codex.threadDrafts['room-a'], 'Chat draft canary');
  assert.equal(h.proxies()[0].dataset.briefingMode, 'reading'); assert.equal(h.proxies()[0].querySelector('.egd-semantic-icon').textContent, '1');
});

test('HUM-BRIEF-002 scroll: measured panel/zoom geometry, fold and resize update the viewport while preserving End and user progress', () => {
  const h = briefingReadingScrollHarness(); h.enter(); h.end();
  const camera = JSON.stringify([h.state.zoom, h.state.pan]);
  h.setPanel({ top: 400 }); assert.ok(h.line().bottom < 400); assert.equal(h.body.scrollTop, h.body.scrollHeight - h.body.clientHeight);
  const small = h.body.clientHeight; h.setPanel({ top: 480 }); assert.ok(h.body.clientHeight > small);
  h.rects['egd-zoom-indicator'].top = 350; h.rects['egd-zoom-indicator'].bottom = 390;
  h.notifyResize(h.chrome['egd-zoom-indicator']); h.flush(); assert.ok(h.line().bottom < 350, 'zoom is a real occluder, not only panel height');
  h.rects['egd-zoom-indicator'].top = 491; h.rects['egd-zoom-indicator'].bottom = 531;
  h.click('briefing-toggle'); h.setPanel({ top: 50 });
  assert.equal(h.body.style.maxHeight || '', '', 'no fake one-pixel viewport when expanded chrome leaves no reading aperture');
  h.click('briefing-toggle'); h.setPanel({ top: 435 }); assert.ok(h.line().bottom < 435);
  h.body.scrollTop = 500; h.setPanel({ top: 400 }); assert.equal(h.body.scrollTop, 500, 'nonterminal user scroll position is not reset');
  h.resize(1280, 800); h.flush(); assert.equal(h.body.style.maxHeight || '', ''); assert.equal(h.body.hasAttribute('data-egd-briefing-scroll-viewport'), false);
  h.resize(720, 600); h.flush(); h.end(); assert.ok(h.line().bottom < 400);
  assert.equal(JSON.stringify([h.state.zoom, h.state.pan]), camera);
});

test('HUM-BRIEF-002 scroll: temporary viewport attrs/styles restore on Escape, step, room loss, LOD, removal and exit without leaking to Chat', () => {
  for (const mode of ['escape', 'step', 'room', 'lod', 'remove', 'exit']) {
    const h = briefingReadingScrollHarness({ authoredMax: '480px', authoredPriority: 'important' });
    const otherBody = h.el('div', { class: 'egd-chat-card-body' }, 'ordinary Chat'); h.chat.appendChild(otherBody);
    h.enter(); assert.equal(h.body.getAttribute('data-egd-briefing-scroll-viewport'), 'true');
    h.body.style.setProperty('color', 'blue');
    if (mode === 'escape') { h.body.fire('keydown', { key: 'Escape' }); h.flush(); }
    else if (mode === 'step') h.click('briefing-next');
    else if (mode === 'room') { h.state.codex.activeThreadId = 'other-room'; h.render(); }
    else if (mode === 'lod') { h.state.zoom = .04671717171717172; h.render(); }
    else if (mode === 'remove') { h.cards[0].remove(); h.render(); }
    else { h.close(); h.render(); }
    assert.equal(h.body.getAttribute('data-egd-briefing-scroll-viewport'), null, mode);
    assert.equal(h.body.style.maxHeight, '480px', mode); assert.equal(h.body.style.getPropertyPriority('max-height'), 'important', mode);
    assert.equal(h.body.style.color, 'blue', mode); assert.equal(otherBody.getAttribute('data-egd-briefing-scroll-viewport'), null);
    assert.ok([...h.resizeObservers].every(observer => !observer.nodes.has(h.body)), 'no observer holds a released reader');
  }
});

test('HUM-BRIEF-002 scroll: wide and non-reading documents keep original viewport, and repeated render/scroll does not churn own layout', () => {
  const wide = briefingReadingScrollHarness({ width: 1280 }); wide.enter();
  assert.equal(wide.body.clientHeight, 424); assert.equal(wide.body.getAttribute('data-egd-briefing-scroll-viewport'), null);
  const h = briefingReadingScrollHarness(); assert.equal(h.body.clientHeight, 424); h.enter();
  const style = h.body.getAttribute('style'), height = h.body.clientHeight;
  for (let index = 0; index < 8; index++) { h.body.scrollTop = index * 50; h.render(); }
  assert.equal(h.body.getAttribute('style'), style); assert.equal(h.body.clientHeight, height);
  h.close(); h.render(); assert.equal(h.body.getAttribute('style'), null, 'no empty inline-style artifact after the temporary max-height');
});

test('HUM-BRIEF-002 scroll: viewport CSS is scoped to the active original evidence body, not global documents or Chat', () => {
  const css = readFileSync(new URL('../overlay/CSS/eg-desk-surface.uc.css', import.meta.url), 'utf8');
  assert.match(css, /\.egd-input-evidence-card \.egd-card-body\[data-egd-briefing-scroll-viewport="true"\][^}]*overflow:\s*auto/s);
});

test('HUM-BRIEF-002 entry: card navigation/focus and reading identity CSS is unscaled and token-based, not a global LOD threshold override', () => {
  const css = readFileSync(new URL('../overlay/CSS/eg-desk-surface.uc.css', import.meta.url), 'utf8');
  assert.match(css, /\.egd-semantic-proxy\[data-briefing-active="true"\]\[data-lod="detail"\]/);
  assert.match(css, /\[data-briefing-mode="reading"\][^}]*\{[^}]*border-radius/s);
  assert.match(css, /\.egd-semantic-proxy:focus-visible[^}]*var\(--egd-focus-outline\)/s);
  assert.match(css, /\.egd-canvas-card:focus-within > \.egd-semantic-proxy\[data-briefing-mode="reading"\][^}]*var\(--egd-focus-outline\)/s);
});

function outlineDragHarness({ zoom = .25, pan = { x: 110, y: -65 }, level = 'outline', blurOnActivate = false } = {}) {
  const target = () => {
    const listeners = new Map();
    const captures = new Map();
    let captured = null;
    return { listeners,
      get captured() { return captured; },
      setPointerCapture(id) { captured = id; },
      hasPointerCapture(id) { return captured === id; },
      releasePointerCapture(id) { assert.equal(captured, id); captured = null; },
      addEventListener(type, fn, capture = false) { listeners.set(type, fn); captures.set(type, capture); },
      removeEventListener(type, fn, capture = false) {
        if (listeners.get(type) !== fn) return;
        assert.equal(capture, captures.get(type), `${type} removal must match registration capture`);
        listeners.delete(type); captures.delete(type);
      },
      fire(type, data = {}) {
        const ev = { type, target: this, button: 0, buttons: 1, isPrimary: true, pointerId: type === 'blur' ? undefined : 7, detail: 1,
          clientX: 150, clientY: -20, preventDefault() { this.prevented = true; },
          stopPropagation() { this.stopped = true; }, ...data };
        listeners.get(type)?.(ev); return ev;
      } };
  };
  const window = target(), proxy = target();
  const state = { zoom, pan: { ...pan }, zoomTarget: zoom, panTarget: { ...pan }, panModifier: false };
  const resource = Object.freeze({ uri: 'https://example.test/', context: 12, fullZoom: 1 });
  const card = { isConnected: true, style: { left: '80px', top: '120px', width: '448px', height: '343px' }, _browser: resource };
  const entry = { card, proxy, level };
  let focused = 0, activated = 0, saved = 0, rendered = 0;
  const dispose = production('installSemanticOutlineDrag', { state, window,
    parsePxNumber: (value, fallback) => Number.parseFloat(value) || fallback || 0,
    isCardFullscreen: () => false, focusCanvasCard: () => {
      activated++;
      if (blurOnActivate) window.fire('blur', { target: proxy });
    },
    markAgendaDirty(reason, node) { assert.equal(reason, 'move-outline-card'); assert.equal(node, card); saved++; },
  })(entry, { focusProjection: item => { assert.equal(item, entry); focused++; }, request: () => { rendered++; } });
  return { window, proxy, state, card, entry, resource, dispose,
    get focused() { return focused; }, get activated() { return activated; },
    get saved() { return saved; }, get rendered() { return rendered; } };
}

test('outline proxy is wired to direct dragging and releases its listeners on removal', () => {
  assert.match(overlay, /entry\.disposeOutlineDrag = installSemanticOutlineDrag\(entry, \{ focusProjection, request \}\)/);
  assert.match(overlay, /const remove = card => \{[^]*?entry\.disposeOutlineDrag\(\)/);
  const h = outlineDragHarness();
  h.proxy.fire('pointerdown'); h.dispose();
  assert.equal(h.window.listeners.size, 0); assert.equal(h.proxy.listeners.size, 0);
  assert.equal(h.saved, 0);
});

test('outline drag uses a 4px screen threshold and inverse camera transform, never readable focus', () => {
  for (const zoom of [.2, .25, .5]) {
    const h = outlineDragHarness({ zoom });
    const before = JSON.stringify(h.state), dimensions = [h.card.style.width, h.card.style.height];
    h.proxy.fire('pointerdown');
    assert.equal(h.proxy.captured, 7);
    h.window.fire('pointermove', { clientX: 153.99 });
    assert.equal(h.card.style.left, '80px', 'sub-threshold motion does not move the Card');
    h.window.fire('pointermove', { clientX: 154 });
    assert.equal(Number.parseFloat(h.card.style.left), 80 + 4 / zoom);
    h.window.fire('pointermove', { clientX: 174, clientY: -10 });
    assert.ok(Math.abs(Number.parseFloat(h.card.style.left) - (80 + 24 / zoom)) < 1e-9);
    assert.ok(Math.abs(Number.parseFloat(h.card.style.top) - (120 + 10 / zoom)) < 1e-9);
    h.window.fire('mouseup'); // compatibility release must terminate the pointer path too
    assert.equal(h.proxy.captured, null);
    assert.equal(h.proxy.fire('click').prevented, true, 'post-drag click cannot zoom');
    const position = JSON.stringify(h.card.style);
    h.window.fire('pointermove', { clientX: 600 });
    assert.equal(JSON.stringify(h.card.style), position);
    assert.equal(h.window.listeners.size, 0);
    assert.equal(h.saved, 1); assert.equal(h.activated, 1); assert.equal(h.focused, 0);
    assert.equal(JSON.stringify(h.state), before, 'no pan, zoom, target or camera history change');
    assert.deepEqual([h.card.style.width, h.card.style.height], dimensions);
    assert.equal(h.entry.level, 'outline', 'drag never resets semantic hysteresis');
    assert.equal(h.card._browser, h.resource);
  }
});

test('outline click jitter and keyboard activation still focus, while pointercancel suppresses click and cleans up', () => {
  const h = outlineDragHarness();
  h.proxy.fire('pointerdown'); h.window.fire('pointermove', { clientX: 152, clientY: -18 });
  h.window.fire('pointerup'); h.proxy.fire('click');
  assert.equal(h.focused, 1); assert.equal(h.saved, 0);
  h.proxy.fire('pointerdown'); h.window.fire('pointermove', { clientX: 180 });
  h.window.fire('pointercancel', { pointerId: 8 });
  assert.ok(h.window.listeners.size, 'unrelated pointer cancellation does not steal the gesture');
  h.window.fire('pointercancel'); h.proxy.fire('click'); h.window.fire('mouseup');
  assert.equal(h.focused, 1); assert.equal(h.saved, 1); assert.equal(h.window.listeners.size, 0);
  h.proxy.fire('click', { detail: 0 });
  assert.equal(h.focused, 2, 'keyboard activation is not swallowed after a cancelled drag');
  h.proxy.fire('pointerdown'); h.window.fire('mouseup'); h.proxy.fire('click');
  assert.equal(h.focused, 3, 'next ordinary click is not stale-suppressed');
});

test('outline first drag survives internal proxy/input blur, including synchronous activation blur', () => {
  for (const kind of ['proxy', 'input', 'activation']) {
    const h = outlineDragHarness({ blurOnActivate: kind === 'activation' });
    const camera = JSON.stringify(h.state);
    h.proxy.fire('pointerdown');
    if (kind !== 'activation') h.window.fire('blur', { target: kind === 'proxy' ? h.proxy : { tagName: 'TEXTAREA' } });
    assert.equal(h.proxy.captured, 7, 'internal focus movement must keep pending capture');
    assert.ok(h.window.listeners.has('pointermove'));
    h.window.fire('pointermove', { clientX: 210, clientY: 16 });
    assert.equal(Number.parseFloat(h.card.style.left) - 80, 240, 'first drag, no retry');
    assert.equal(Number.parseFloat(h.card.style.top) - 120, 144);
    assert.equal(h.proxy.captured, 7);
    h.window.fire('mouseup'); h.proxy.fire('click');
    assert.equal(h.saved, 1); assert.equal(h.focused, 0);
    assert.equal(h.proxy.captured, null); assert.equal(h.window.listeners.size, 0);
    assert.equal(JSON.stringify(h.state), camera);
    assert.equal(h.card._browser, h.resource);
  }
});

test('outline actual window blur cancels before or after movement and releases matching listeners', () => {
  for (const moved of [false, true]) {
    const h = outlineDragHarness(); h.proxy.fire('pointerdown');
    if (moved) h.window.fire('pointermove', { clientX: 160 });
    const position = JSON.stringify(h.card.style);
    h.window.fire('blur', { target: h.window });
    assert.equal(h.window.listeners.size, 0); assert.equal(h.proxy.captured, null);
    h.window.fire('pointermove', { clientX: 210 }); h.window.fire('mouseup'); h.proxy.fire('click');
    assert.equal(JSON.stringify(h.card.style), position);
    assert.equal(h.saved, moved ? 1 : 0); assert.equal(h.focused, 0);
  }
});

test('outline drag cancels on lost buttons/capture, blur, LOD change or removal and preserves marker behavior', () => {
  for (const stop of ['buttons', 'capture', 'blur', 'lod', 'removed']) {
    const h = outlineDragHarness(); h.proxy.fire('pointerdown');
    h.window.fire('pointermove', { clientX: 160 });
    const before = JSON.stringify(h.card.style);
    if (stop === 'lod') h.entry.level = 'marker';
    if (stop === 'removed') h.card.isConnected = false;
    if (stop === 'capture') h.proxy.fire('lostpointercapture');
    else if (stop === 'blur') h.window.fire('blur');
    else h.window.fire('pointermove', { clientX: 190, buttons: stop === 'buttons' ? 0 : 1 });
    h.proxy.fire('click');
    assert.equal(h.focused, 0, stop); assert.equal(h.window.listeners.size, 0, stop);
    assert.equal(JSON.stringify(h.card.style), before, stop);
  }
  for (const changed of [{ level: 'marker' }, { level: 'detail' }, { pan: true }, { button: 2 }, { isPrimary: false }]) {
    const h = outlineDragHarness({ level: changed.level || 'outline' });
    h.state.panModifier = !!changed.pan; h.proxy.fire('pointerdown', changed);
    assert.equal(h.window.listeners.size, 0);
    assert.equal(h.card.style.left, '80px');
    if (changed.level === 'marker') { h.proxy.fire('click'); assert.equal(h.focused, 1); }
  }
});

test('outline dragging keeps the original grab point even if the camera transform changes externally', () => {
  const h = outlineDragHarness();
  h.proxy.fire('pointerdown');
  const grab = { x: (150 - 110) / .25 - 80, y: (-20 + 65) / .25 - 120 };
  h.state.zoom = .3; h.state.pan = { x: 120, y: -40 };
  h.window.fire('pointermove', { clientX: 170, clientY: -5 });
  assert.ok(Math.abs((Number.parseFloat(h.card.style.left) + grab.x) * .3 + 120 - 170) < 1e-9);
  assert.ok(Math.abs((Number.parseFloat(h.card.style.top) + grab.y) * .3 - 40 + 5) < 1e-9);
  assert.equal(h.state.zoom, .3); assert.deepEqual(h.state.pan, { x: 120, y: -40 });
  h.window.fire('pointerup');
});

test('actual Browser render delays semantic zoom with measured or fallback fonts', () => {
  assert.equal(renderedLevel({ metrics: metric }), 'detail');
  assert.equal(renderedLevel({ width: 1078.5, zoom: .75, metrics: metric }), 'detail');
  assert.equal(renderedLevel({ width: 1440 * .69, zoom: .69, previous: 'outline', metrics: metric }), 'detail');
  assert.equal(renderedLevel({ width: 1440 * .5, zoom: .5, previous: 'outline', metrics: metric }), 'detail');
  assert.equal(renderedLevel({ width: 1440 * .5 * .9, zoom: .5, previous: 'outline', metrics: { ...metric, fontPx: 12 } }), 'detail',
    '12px content fitted to 90% still appears at 50% Desk zoom');
  assert.equal(renderedLevel({ width: 766.4, previous: 'detail', metrics: metric }), 'detail');
  assert.equal(renderedLevel({ width: 431.4, zoom: .3, metrics: metric }), 'detail');
  assert.equal(renderedLevel({ width: 1440 * .2, zoom: .2, metrics: metric }), 'outline');
  for (const zoom of [.69, .5, .35, .3]) {
    assert.equal(renderedLevel({ width: 1440 * zoom, zoom, previous: 'outline' }), 'detail',
      `the fallback font also retains ordinary Browser detail at ${zoom}`);
  }
});

test('Browser content metric validates evidence and applies the actual width ratio exactly once', () => {
  const font = production('browserPresentationFont');
  assert.equal(font(metric, 1150.4), 16 * 1150.4 / 1440);
  assert.equal(font(metric, 766.4), 16 * 766.4 / 1440);
  for (const changed of [{ complete: false }, { version: 2 }, { fontPx: null }, { fontPx: '16' },
    { fontPx: NaN }, { fontPx: Infinity }, { fontPx: 0 }, { sampleCount: 0 }, { sampleCount: 65 },
    { viewportWidth: 0 }, { viewportHeight: Infinity }]) {
    assert.equal(font({ ...metric, ...changed }, 1150.4), null, JSON.stringify(changed));
  }
  assert.equal(font(null, 1150.4), null, 'no fabricated body font');
  assert.equal(font(metric, 0), null);
});

test('native 448x343 Browser retains detail despite tiny text from its fixed 1440px page fit', () => {
  const card = { cardWidth: 448, cardHeight: 343 };
  for (const previous of ['outline', 'detail']) {
    for (const zoom of [1, .69, .5, .35, .3]) {
      assert.equal(renderedLevel({ ...card, zoom, previous, projectedFont: 4.02594 * zoom }), 'detail',
        `native small card at ${zoom} from ${previous}`);
    }
    assert.equal(renderedLevel({ ...card, zoom: .25, previous, projectedFont: 4.02594 * .25 }), 'outline',
      `deep zoom still abstracts from ${previous}`);
    assert.equal(renderedLevel({ ...card, zoom: .1, previous, projectedFont: 4.02594 * .1 }), 'marker');
    assert.equal(renderedLevel({ ...card, zoom: .17, previous, projectedFont: 20 }), 'marker',
      'large page text cannot bypass the original small projected geometry');
  }
});

test('Browser semantic font floor retains common hysteresis below nominal readability', () => {
  assert.equal(renderedLevel({ zoom: .28, projectedFont: 3.1, previous: 'detail' }), 'detail');
  assert.equal(renderedLevel({ zoom: .28, projectedFont: 3.1, previous: 'outline' }), 'outline');
  assert.equal(renderedLevel({ zoom: .28, projectedFont: 3.4, previous: 'outline' }), 'detail',
    'larger measured text can still supply detail above the nominal floor');
  assert.equal(renderedLevel({ zoom: .26, projectedFont: 2.8, previous: 'detail' }), 'outline',
    'the common exit font floor still applies even with ample projected geometry');
});

test('Browser LOD rejects invalid projected font evidence and retains invalid geometry guards', () => {
  for (const projectedFont of [null, NaN, Infinity, -Infinity, 0, -1, '16']) {
    assert.equal(renderedLevel({ zoom: .5, projectedFont }), 'detail', 'nominal fallback at ordinary zoom');
    assert.equal(renderedLevel({ zoom: .25, projectedFont }), 'outline', 'fallback still scales with the camera');
  }
  for (const invalid of [NaN, Infinity, 0, -1]) {
    assert.equal(renderedLevel({ cardWidth: invalid, projectedFont: 20 }), 'marker');
    assert.equal(renderedLevel({ cardHeight: invalid, projectedFont: 20 }), 'marker');
  }
});

test('explicit Browser focus keeps raw measured page font instead of the LOD-only nominal floor', () => {
  const start = overlay.indexOf('      const zoomFor = region => {', overlay.indexOf('    const focusProjection ='));
  const end = overlay.indexOf('      let zoom = zoomFor(safe);', start);
  assert.ok(start > 0 && end > start, 'production focus-to-readable zoom calculation');
  const zoomFor = compileFunction(`${overlay.slice(start, end)}\nreturn zoomFor;`,
    ['SurfaceState', 'world', 'entry', 'state', 'ZOOM_MAX', 'detailWidth', 'detailHeight', 'focusWidth']);
  const world = { x: 0, y: 0, width: 448, height: 343 };
  const region = { left: 0, top: 0, width: 1200, height: 800 };
  for (const zoom of [1, .69, .5]) {
    const measured = 4.02594 * zoom;
    const card = { _browserPresentation: { font: () => measured } };
    const focus = zoomFor(SurfaceState, world, { kind: 'browser', card, bodyFontPx: 11 }, { zoom }, 4, 240, 180, world.width);
    assert.ok(Math.abs(focus(region) - 10.6 / 4.02594) < 1e-9, `raw page font at ${zoom}`);
    assert.equal(card._browserPresentation.font(), measured, 'the LOD floor does not replace cached evidence');
  }
  for (const measured of [null, NaN, Infinity, 0, -1, '4']) {
    const card = { _browserPresentation: { font: () => measured } };
    const focus = zoomFor(SurfaceState, world, { kind: 'browser', card, bodyFontPx: 11 }, { zoom: .5 }, 4, 240, 180, world.width);
    assert.equal(focus(region), 10.6 / 11, 'invalid evidence retains the existing nominal focus fallback');
  }
});

test('native small Browser focus at 35% uses uninflated fit, keeps toolbar reachable, and preserves the View', () => {
  const fitStart = overlay.indexOf('    let logicalHeight = 0, lastCardSize');
  const fitEnd = overlay.indexOf('    deskWindow.onResize(updateFitScale);', fitStart);
  const focusSource = overlay.match(/    const focusProjection = \(entry, \{ revealHeader = false \} = \{\}\) => \{([^]*?)\n    \};/)?.[1];
  assert.ok(fitStart > 0 && fitEnd > fitStart && focusSource, 'compile the actual layout and complete focus function');
  let zoom = 1, inverse = 1, target = null, focused = null;
  let evidence = { ...metric, fontPx: 13, viewportHeight: 888 };
  const world = { x: 155, y: 130, width: 448, height: 343 };
  const style = { left: '155px', top: '130px', width: '448px', height: '343px' };
  const browser = Object.freeze({ context: 15, innerWindowId: 17179869185, fullZoom: 1, textZoom: 1 });
  const card = { isConnected: true, style, clientWidth: 448, clientHeight: 343, offsetWidth: 450, offsetHeight: 345,
    setAttribute() {}, _browser: browser };
  const header = { get offsetHeight() { return 67 * inverse; }, style: {
    setProperty(key, value) { assert.equal(key, '--egd-browser-ui-scale'); inverse = Number(value); },
  } };
  const body = { clientWidth: 448, get clientHeight() { return card.clientHeight - header.offsetHeight - 1; } };
  const wrap = { style: {} };
  const presentation = { read: () => evidence, invalidate() {}, font: () => .773680665757921 };
  card._browserPresentation = presentation;
  const update = compileFunction(`${overlay.slice(fitStart, fitEnd)}; return updateFitScale;`,
    ['body', 'card', 'header', 'wrap', 'options', 'presentation', 'agentProjection', 'CARD_LOGICAL_W', 'canvasZoom', 'browserPresentationFit', 'browserPresentationFont',
      'syncBrowserBoardCollision', 'deskWindow', 'pageTitle', 'agentBadge', 'agentHandButton'])(
    body, card, header, wrap, {}, presentation, { invalidate() {} }, 1440, () => zoom,
    production('browserPresentationFit'), production('browserPresentationFont'),
    () => {}, { slots: { topbar: {} }, boardMetadata: {} }, {}, {}, {});
  update();
  assert.equal(wrap.style.height, '888px', 'the existing real-size layout establishes the logical page height');
  const nominal = presentation.nominalWorldFont();
  assert.ok(Math.abs(nominal - 4.02594) < .001, '13px page font at the uninflated real Card fit');
  zoom = .35; update();
  assert.equal(presentation.nominalWorldFont(), nominal, 'compact toolbar fit cannot shrink the focus font');
  const snapshot = JSON.stringify({ style, wrap: wrap.style, browser });
  const state = { zoom, pan: { x: 390, y: 227.5 }, setCanvasViewportTarget(value) { target = value; } };
  // 1280x820 native viewport: allow the flush topbar, floating rail, dock and margins.
  let safe = { left: 102, top: 76, right: 1256, bottom: 738, width: 1154, height: 662 };
  const focus = compileFunction(`return (entry, { revealHeader = false } = {}) => {${focusSource}\n};`,
    ['state', 'authorVisible', 'screenRect', 'safeViewportRect', 'SurfaceState', 'ZOOM_MAX', 'detailWidth', 'detailHeight',
      'focusCanvasCard', 'visibleChatZoomRect', 'window', 'parsePxNumber', 'CHAT_ZOOM_GAP'])(
    state, () => true, () => ({ visualWorld: world }), () => safe, SurfaceState, 4, 240, 180,
    value => { focused = value; }, () => null, { getComputedStyle: () => ({ boxSizing: 'border-box' }) }, () => 0, 10);
  const entry = { card, kind: 'browser', bodyFontPx: 11 };
  focus(entry);
  assert.equal(focused, card, 'same View receives focus');
  assert.equal(card._browser, browser, 'same mounted browser/context');
  assert.equal(JSON.stringify({ style, wrap: wrap.style, browser }), snapshot,
    'focus does not write world geometry, logical viewport, fit, page zoom or browser identity');
  assert.equal(target.zoom, safe.width / card.offsetWidth);
  assert.ok(target.zoom > 2 && target.zoom < 3, 'sensible reading zoom, not the observed 400%');
  const left = world.x * target.zoom + target.pan.x;
  const top = world.y * target.zoom + target.pan.y;
  assert.equal(left, safe.left, 'height-cropped Browser anchors its left content');
  assert.equal(top, safe.top, 'height-cropped Browser anchors its header');
  assert.ok(left + card.offsetWidth * target.zoom <= safe.right + 1e-9, 'right toolbar edge remains accessible');
  assert.ok(top + 67 * target.zoom <= safe.bottom, 'both header/navigation rows remain accessible');
  assert.ok(nominal * target.zoom < 10.6, 'width-limited focus does not falsely promise the reading target');
  assert.ok(nominal * target.zoom > 10, 'record the actual approximately 10.32px projection');
  safe = { left: 0, top: 0, right: 1280, bottom: 820, width: 1280, height: 820 };
  focus(entry);
  assert.ok(Math.abs(target.zoom - 10.6 / nominal) < 1e-9, 'real page font reaches the reading target when width permits');
  assert.ok(target.pan.x + world.x * target.zoom >= safe.left);
  assert.ok(target.pan.x + (world.x + card.offsetWidth) * target.zoom <= safe.right);
  for (const kind of ['file', 'chat']) {
    focus({ ...entry, kind });
    assert.equal(target.zoom, 10.6 / 11, `${kind} keeps its existing reading policy`);
    assert.ok(target.pan.y + world.y * target.zoom > safe.top, `${kind} keeps its existing centered placement`);
  }
  evidence = null;
  assert.equal(presentation.nominalWorldFont(), null, 'missing or stale cache cannot fabricate a nominal page font');
});

test('Browser font metrics are requested throughout the common detail geometry band', () => {
  const mayNeedMetrics = production('browserPresentationMayNeedMetrics', { SurfaceState });
  const boundary = { width: 240 * .42 * .88, height: 180 * .42 * .88, detailWidth: 240, detailHeight: 180 };
  assert.equal(mayNeedMetrics(boundary), true);
  assert.equal(mayNeedMetrics({ ...boundary, width: boundary.width - .01 }), false);
  assert.equal(mayNeedMetrics({ ...boundary, height: boundary.height - .01 }), false);
  assert.equal(mayNeedMetrics({ ...boundary, width: NaN }), false);
});

function cacheHarness() {
  let time = 0, next = 0, changed = 0, calls = 0, width = 1150.4;
  const timers = new Map(), replies = [];
  const card = { isConnected: true };
  const browser = { isConnected: true, fullZoom: 1,
    browsingContext: { currentWindowGlobal: {} }, getBoundingClientRect: () => ({ width }) };
  const create = production('createBrowserPresentationCache', { browserPresentationFont: production('browserPresentationFont') });
  const cache = create({ card, browser, now: () => time,
    setTimer(fn, ms) { const id = ++next; timers.set(id, { fn, at: time + ms }); return id; },
    clearTimer(id) { timers.delete(id); }, changed: () => { changed += 1; },
    query: () => { calls += 1; return new Promise((resolve, reject) => replies.push({ resolve, reject })); },
  });
  const flush = async () => { for (let i = 0; i < 8; i++) await Promise.resolve(); };
  return { card, browser, cache, replies, timers, flush,
    get calls() { return calls; }, get changed() { return changed; },
    setWidth(value) { width = value; },
    elapseWithoutTimers(ms) { time += ms; },
    async advance(ms) {
      time += ms;
      for (const [id, timer] of [...timers]) if (timer.at <= time) { timers.delete(id); timer.fn(); }
      await flush();
    },
  };
}

test('presentation cache coalesces and reuses measured fonts for ordinary Desk camera frames', async () => {
  const h = cacheHarness();
  for (let i = 0; i < 120; i++) h.cache.ensure();
  assert.equal(h.timers.size, 1);
  await h.advance(80);
  assert.equal(h.calls, 1);
  h.replies[0].resolve(metric); await h.flush();
  assert.equal(h.cache.font(), 16 * 1150.4 / 1440);
  h.setWidth(1078.5);
  for (let i = 0; i < 120; i++) h.cache.ensure();
  assert.equal(h.cache.font(), 16 * 1078.5 / 1440);
  assert.equal(h.calls, 1, 'camera zoom does not resample the document');
  assert.equal(h.timers.size, 0);
  await h.advance(30001);
  assert.equal(h.cache.font(), null, 'stale evidence is not used indefinitely');
  assert.equal(h.calls, 1, 'no background polling when no candidate asks');
  h.cache.ensure(); await h.advance(80);
  assert.equal(h.calls, 2);
});

test('incomplete, rejected and timed-out metrics never create an outline/detail retry loop', async () => {
  for (const failure of ['incomplete', 'reject', 'timeout']) {
    const h = cacheHarness();
    h.cache.ensure(); await h.advance(80);
    if (failure === 'incomplete') h.replies[0].resolve({ ...metric, complete: false, fontPx: null });
    if (failure === 'reject') h.replies[0].reject(new Error('unavailable'));
    if (failure === 'timeout') await h.advance(1200);
    await h.flush();
    for (let i = 0; i < 120; i++) h.cache.ensure();
    assert.equal(h.cache.font(), null);
    assert.equal(h.calls, 1);
    assert.equal(h.changed, 1);
    if (failure === 'timeout') {
      h.replies[0].resolve(metric); await h.flush();
      assert.equal(h.cache.font(), null, 'late success cannot resurrect expired evidence');
      assert.equal(h.changed, 1);
    }
    h.cache.dispose();
    assert.equal(h.timers.size, 0);
  }
});

test('unsettled timeout releases its slot so a new document recovers before the old reply', async () => {
  const h = cacheHarness();
  h.cache.ensure(); await h.advance(80);
  await h.advance(1200);
  assert.equal(h.cache.diagnostics().pending, false, 'timeout releases the active slot even without a reply');
  h.browser.browsingContext.currentWindowGlobal = {};
  h.cache.invalidate();
  h.cache.ensure(); await h.advance(80);
  assert.equal(h.calls, 2, 'new document does not wait forever on the previous document');
  h.replies[0].resolve(metric); await h.flush();
  assert.equal(h.cache.font(), null, 'expired reply cannot populate the new document cache');
  assert.equal(h.cache.diagnostics().pending, true, 'old finally cannot clear the new flight');
  h.replies[1].resolve({ ...metric, fontPx: 12 }); await h.flush();
  assert.equal(h.cache.font(), 12 * 1150.4 / 1440);
  assert.equal(h.cache.diagnostics().pending, false);
  h.cache.dispose();
  assert.equal(h.timers.size, 0);
});

test('same-document timeout retries only after cooldown and ignores the older reply after success', async () => {
  const h = cacheHarness();
  h.cache.ensure(); await h.advance(80);
  await h.advance(1200);
  for (let i = 0; i < 120; i++) h.cache.ensure();
  assert.equal(h.calls, 1);
  await h.advance(30001);
  h.cache.ensure(); await h.advance(80);
  assert.equal(h.calls, 2);
  h.replies[1].resolve({ ...metric, fontPx: 12 }); await h.flush();
  const settledChanges = h.changed;
  h.replies[0].resolve(metric); await h.flush();
  assert.equal(h.cache.font(), 12 * 1150.4 / 1440);
  assert.equal(h.changed, settledChanges);
  h.cache.dispose();
});

test('a late reply cannot beat a delayed timeout callback and claim fresh presentation evidence', async () => {
  const h = cacheHarness();
  h.cache.ensure(); await h.advance(80);
  h.elapseWithoutTimers(1200);
  h.replies[0].resolve(metric); await h.flush();
  assert.equal(h.cache.font(), null);
  assert.equal(h.cache.diagnostics().pending, false);
  assert.equal(h.changed, 1);
  assert.equal(h.timers.size, 0);
  h.cache.dispose();
});

test('document, page zoom, invalidation and disconnected Card discard stale numeric replies', async () => {
  for (const mutate of [h => { h.browser.browsingContext.currentWindowGlobal = {}; },
    h => { h.browser.browsingContext = { currentWindowGlobal: {} }; },
    h => { h.browser.fullZoom = 1.2; }, h => h.cache.invalidate(),
    h => { h.card.isConnected = false; }, h => h.cache.dispose()]) {
    const h = cacheHarness();
    h.cache.ensure(); await h.advance(80);
    mutate(h);
    h.replies[0].resolve(metric); await h.flush();
    assert.equal(h.cache.font(), null);
    h.cache.dispose();
    assert.equal(h.timers.size, 0);
  }
  const h = cacheHarness();
  h.cache.ensure(); await h.advance(80);
  h.replies[0].resolve(metric); await h.flush();
  h.browser.fullZoom = 1.25;
  assert.equal(h.cache.font(), null);
  h.cache.ensure(); await h.advance(80);
  assert.equal(h.calls, 2, 'real page zoom invalidates immediately, unlike Desk zoom');
  h.cache.dispose();
});

test('Browser fit keeps the same logical viewport below screen-readable controls', () => {
  const fit = production('browserPresentationFit');
  for (const zoom of [1, .8, .75, .83, .3, .01, 1]) {
    const logical = { logicalWidth: 1440, logicalHeight: 573 };
    const height = Math.max(0, 640 - 67 * Math.max(1, 1 / zoom));
    const result = fit({ width: 1440, height, ...logical });
    assert.ok(result.scale >= 0);
    assert.ok(1440 * result.scale <= 1438 + 1e-9);
    assert.ok(573 * result.scale <= height + 1e-9);
    assert.deepEqual(logical, { logicalWidth: 1440, logicalHeight: 573 });
    if (zoom === .8 || zoom === .75) assert.ok(16 * result.scale * zoom >= 10.5);
  }
});

test('production fit/layout preserves page viewport through all camera levels and resizes only with the Card', () => {
  const start = overlay.indexOf('    let logicalHeight = 0, lastCardSize');
  const end = overlay.indexOf('    deskWindow.onResize(updateFitScale);', start);
  assert.ok(start > 0 && end > start);
  let zoom = 1, inverse = 1, invalidations = 0, targetInvalidations = 0;
  const world = { left: '0px', top: '0px', width: '1440px', height: '640px' };
  const card = { clientWidth: 1440, clientHeight: 640, style: world, setAttribute() {} };
  const header = { get offsetHeight() { return 67 * inverse; }, style: {
    setProperty(key, value) { assert.equal(key, '--egd-browser-ui-scale'); inverse = Number(value); },
  } };
  const body = { get clientWidth() { return card.clientWidth; },
    get clientHeight() { return Math.max(0, card.clientHeight - header.offsetHeight); } };
  const wrap = { style: {} };
  const presentation = { invalidate() { invalidations += 1; } };
  const agentProjection = { invalidate() { targetInvalidations += 1; } };
  const update = compileFunction(`${overlay.slice(start, end)}; return updateFitScale;`,
    ['body', 'card', 'header', 'wrap', 'options', 'presentation', 'agentProjection', 'CARD_LOGICAL_W', 'canvasZoom', 'browserPresentationFit',
      'syncBrowserBoardCollision', 'deskWindow', 'pageTitle', 'agentBadge', 'agentHandButton'])(
    body, card, header, wrap, {}, presentation, agentProjection, 1440, () => zoom, production('browserPresentationFit'),
    () => {}, { slots: { topbar: {} }, boardMetadata: {} }, {}, {}, {});
  update();
  assert.equal(targetInvalidations, 1, 'initial Card layout invalidates old target display');
  const initialViewport = wrap.style.height;
  assert.equal(initialViewport, '574px');
  for (const next of [.8, .75, .83, .3, .01, 4, 1]) {
    zoom = next; update();
    assert.equal(wrap.style.height, initialViewport, `page viewport preserved at ${zoom}`);
    assert.equal(invalidations, 1, 'no font IPC invalidation for camera-only changes');
    assert.equal(targetInvalidations, 1, 'camera-only changes preserve the approved target projection');
    assert.ok(Number.parseFloat(wrap.style.transform.slice(6)) >= 0);
    assert.deepEqual(world, { left: '0px', top: '0px', width: '1440px', height: '640px' });
    if (zoom >= .75 && zoom <= 1) {
      assert.equal(32 * inverse * zoom, 32, 'both rows retain 32 screen px controls');
      assert.equal(11 * inverse * zoom, 11, 'title font retains screen size');
    }
  }
  assert.ok(Number.parseFloat(wrap.style.transform.slice(6)) > .9, 'recovers after a zero-height compact body');
  card.clientWidth = 960;
  update();
  assert.notEqual(wrap.style.height, initialViewport, 'real Card resize retains responsive page behavior');
  assert.equal(invalidations, 2);
  assert.equal(targetInvalidations, 2, 'real Card width resize invalidates target display');
  card.clientHeight += 80;
  update();
  assert.equal(targetInvalidations, 3, 'real Card height resize invalidates target display');
  zoom = .3;
  update();
  assert.equal(targetInvalidations, 3, 'camera zoom after resize still does not invalidate target display');
});

test('Browser-only readable chrome CSS keeps two rows and 32px controls without changing other Card types', () => {
  const css = readFileSync(new URL('../overlay/CSS/eg-desk-surface.uc.css', import.meta.url), 'utf8');
  const start = css.indexOf('/* Cancel Desk shrink only');
  const end = css.indexOf('\n.egd-card-progress {', start);
  const rules = css.slice(start, end);
  assert.ok(start > 0 && end > start);
  for (const selector of rules.matchAll(/([^{}]+)\{/g)) {
    const clean = selector[1].replace(/\/\*[^]*?\*\//g, '').trim();
    for (const part of clean.split(',')) assert.match(part.trim(), /^\.egd-browser-card\[data-egd-browser-presentation\]/);
  }
  assert.match(rules, /height: calc\(32px \* var\(--egd-browser-ui-scale\)\)/);
  assert.match(rules, /font-size: calc\(11px \* var\(--egd-browser-ui-scale\)\)/);
  assert.match(rules, /font-size: calc\(12px \* var\(--egd-browser-ui-scale\)\)/);
  assert.doesNotMatch(rules, /position:\s*fixed|z-index:|\.egd-chat|\.egd-terminal/);
});

test('Browser north resize strip preserves its thickness without masking any 32px control grid point', () => {
  const css = readFileSync(new URL('../overlay/CSS/eg-desk-surface.uc.css', import.meta.url), 'utf8');
  const base = css.match(/^\.egd-card-resize-hit-n\s*\{([^}]+)\}/m)[1];
  const override = css.match(/\.egd-browser-card\[data-egd-browser-presentation\]\s*>\s*\.egd-card-resize-hit-n\s*\{([^}]+)\}/)?.[1] || '';
  const px = (rule, key) => Number(rule.match(new RegExp(`(?:^|;)\\s*${key}:\\s*(-?[\\d.]+)px`))?.[1]);
  const baseTop = px(base, 'top'), height = px(base, 'height');
  const top = /top:/.test(override) ? px(override, 'top') : baseTop;
  const hits = (left, stripTop) => {
    let count = 0;
    for (const fy of [.2, .5, .8]) for (const fx of [.2, .5, .8]) {
      // Main's actual 1800x1000 observation: card padding origin 181,97;
      // close [190,96.5,32,32], maximize [256,96.5,32,32].
      const x = left + 32 * fx, y = 96.5 + 32 * fy;
      const masked = x >= 181 + 16 && x < 181 + 1440 - 16 &&
        y >= 97 + stripTop && y < 97 + stripTop + height;
      if (!masked) count++;
    }
    return count;
  };
  assert.equal(hits(190, baseTop), 7, 'reproduces Main close 7/9');
  assert.equal(hits(256, baseTop), 6, 'reproduces Main maximize 6/9');
  assert.equal(height, 10, 'resize affordance thickness is retained');
  assert.equal(hits(190, top), 9);
  assert.equal(hits(256, top), 9);
  assert.ok(top + height <= 0, 'north resize stays outside the attached header');
});

// Test the cooked strings sent to evaluateChrome, not merely the outer .mjs.
// The first live failure was a regex whose slash escapes vanished while its
// enclosing template literal was evaluated.
test('every emitted privileged function parses before Firefox is contacted', () => {
  const source = readFileSync(new URL('./verify-semantic-zoom.mjs', import.meta.url), 'utf8');
  const calls = [...source.matchAll(/harness\.evaluateChrome\(/g)];
  assert.ok(calls.length >= 15, 'expected to cover the complete live QA flow');
  for (const call of calls) {
    const line = source.slice(0, call.index).split('\n').length;
    let start = call.index + call[0].length;
    while (/\s/.test(source[start])) start += 1;
    let emitted;
    if (source.startsWith('OBSERVE', start)) {
      emitted = OBSERVE;
    } else {
      assert.equal(source[start], '`', `uncovered evaluateChrome argument at line ${line}`);
      let end = start + 1;
      while (end < source.length) {
        if (source[end] === '`' && source[end - 1] !== '\\') break;
        end += 1;
      }
      assert.ok(end < source.length, `unterminated Chrome template at line ${line}`);
      const literal = source.slice(start, end + 1);
      emitted = Function('ids', 'chat', 'dataBrowserId', 'zoom', `return ${literal}`)(
        ['qa-browser-a', 'qa-browser-b', 'qa-browser-far'], 'qa-chat', 'qa-browser-b', 0.3,
      );
    }
    assert.match(emitted, /^\s*(?:async\s*)?\(\s*\)\s*=>/s, `not a callable Chrome function at line ${line}`);
    assert.doesNotThrow(() => Function(`return (${emitted})`), `invalid emitted Chrome function at line ${line}`);
    assert.ok(Buffer.byteLength(emitted, 'utf8') < 15 * 1024, `Chrome function too large at line ${line}`);
  }
});
