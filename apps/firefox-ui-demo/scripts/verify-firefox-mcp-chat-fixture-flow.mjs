#!/usr/bin/env node
// Real rendered UI driven by an explicitly selected test HTTP/SSE transport.
// Main owns both fixture-server and Firefox startup/shutdown.
import { createHmac, randomUUID } from 'node:crypto';
import assert from 'node:assert/strict';
import { assertFreshAccountRoom, assertOrdinarySend, assertPlainRenderedMessage, assertQaFixtureArtifact } from './egdesk-chat-qa-contract.sys.mjs';
import { assertQaFixtureManifest } from './egdesk-chat-qa-profile.mjs';
import { attributeSelector, chatIdentity, chrome, loopbackJson, newQaThread, openChat,
  replaceComposerText, replaceFieldText, runUiFlow, sendFromComposer, visible, waitUntil } from './egdesk-qa-ui-flow.mjs';

const token = process.env.EGDESK_QA_FIXTURE_TOKEN || '';
if (process.env.EGDESK_QA_FIXTURE_TRANSPORT !== '1' || token.length < 16) {
  throw new Error('Rendered fixture test requires explicit fixture transport opt-in and its token');
}

async function canvasState(harness) {
  return chrome(harness, () => ({ cards: [...document.querySelectorAll('.egd-canvas-card')].map((node) => node.id).sort(),
    pan: { ...window.__egdesk.state.panTarget }, zoom: window.__egdesk.state.zoomTarget }));
}

function createChatNavigationReadiness(expectedThreadId = null) {
  let prior = null, samples = 0;
  return value => {
    const target = value?.target, rect = target?.rect, camera = value?.camera;
    const ready = value?.count === 1 && (!expectedThreadId || value.threadId === expectedThreadId) &&
      !!value.rootId && target?.visible === true && target.disabled === false && target.hitCount === 9 &&
      target.inside === true && target.clipped === false && rect &&
      [rect.left, rect.top, rect.right, rect.bottom, camera?.x, camera?.y, camera?.zoom,
        camera?.targetX, camera?.targetY, camera?.targetZoom].every(Number.isFinite) &&
      Math.abs(camera.x - camera.targetX) < 0.25 && Math.abs(camera.y - camera.targetY) < 0.25 &&
      Math.abs(camera.zoom - camera.targetZoom) < 0.0001;
    if (!ready) { prior = null; samples = 0; return false; }
    const geometry = [rect.left, rect.top, rect.right, rect.bottom, camera.x, camera.y, camera.zoom];
    const identity = JSON.stringify([value.threadId, value.rootId, value.selector]);
    if (prior?.identity === identity && geometry.every((n, i) => Math.abs(n - prior.geometry[i]) <= 0.25)) samples++;
    else { prior = { identity, geometry }; samples = 1; }
    return samples >= 3;
  };
}

async function observeChatNavigation(harness, selector) {
  return chrome(harness, selector => {
    const matches = [...document.querySelectorAll(selector)], node = matches.length === 1 ? matches[0] : null;
    const r = node?.getBoundingClientRect(), style = node && getComputedStyle(node), state = window.__egdesk?.state;
    let clipped = false;
    for (let parent = node?.parentElement; parent && r; parent = parent.parentElement) {
      const css = getComputedStyle(parent), b = parent.getBoundingClientRect();
      if ((/(auto|scroll|hidden|clip)/.test(css.overflowX) && (r.left < b.left || r.right > b.right)) ||
          (/(auto|scroll|hidden|clip)/.test(css.overflowY) && (r.top < b.top || r.bottom > b.bottom))) clipped = true;
    }
    let hitCount = 0;
    if (r) for (const y of [0.2, 0.5, 0.8]) for (const x of [0.2, 0.5, 0.8]) {
      const hit = document.elementFromPoint(r.left + r.width * x, r.top + r.height * y);
      if (hit && (node === hit || node.contains(hit))) hitCount++;
    }
    return { selector, count: matches.length, threadId: state?.codex?.activeThreadId || null,
      rootId: node?.closest('#egd-hud, .egd-chat-card')?.id || null,
      target: node && { visible: !node.closest('[hidden],[inert],[aria-hidden="true"],.egd-hud-hidden') &&
        style.display !== 'none' && style.visibility !== 'hidden' && Number(style.opacity) > 0 && r.width > 0 && r.height > 0,
        disabled: !!node.disabled, hitCount, clipped,
        inside: r.left >= 0 && r.top >= 0 && r.right <= innerWidth && r.bottom <= innerHeight,
        rect: { left: r.left, top: r.top, right: r.right, bottom: r.bottom } },
      camera: { x: state?.pan?.x, y: state?.pan?.y, zoom: state?.zoom,
        targetX: state?.panTarget?.x, targetY: state?.panTarget?.y, targetZoom: state?.zoomTarget } };
  }, selector);
}

async function returnFromArtifactRoomToHome(harness, result, threadId) {
  // Opening the artifact may pan away; one native Dock reveal precedes passive
  // stabilization of the ORIGINAL Back control. Never retry a dispatched Back.
  await openChat(harness);
  const trace = result.postArtifactBack = { observations: [], clicked: false };
  const observe = async selector => {
    const value = await observeChatNavigation(harness, selector);
    trace.observations.push(value); if (trace.observations.length > 16) trace.observations.shift();
    return value;
  };
  const back = '.egd-codex-conversation-back';
  trace.before = await waitUntil(() => observe(back), createChatNavigationReadiness(threadId),
    { timeoutMs: 15000, intervalMs: 120 });
  await harness.click(back);
  trace.clicked = true;
  trace.after = await waitUntil(() => observe('.egd-codex-thread-home-new'), createChatNavigationReadiness(),
    { timeoutMs: 10000, intervalMs: 120 });
}

// Local to this verifier: long room lists need the existing native search,
// not a click at an offscreen row's stale coordinates. Common helpers stay put.
function qaThreadSelectionCandidate(thread, observed) {
  const model = observed.threads.filter(item => item.title === thread.title);
  assert.ok(model.length === 1 && model[0].id === thread.id, 'Requested room label is not unique for its local ID');
  if (observed.searchCount !== 1 || observed.searchValue !== thread.title || observed.query !== thread.title) return null;
  return observed.rows.find(row => row.title === thread.title && row.focusKey === `room-${thread.id}` &&
    row.count === 1 && row.target?.visible === true && row.target.disabled === false &&
    row.target.inside === true && row.target.clipped === false && row.target.hitCount === 9) || null;
}

function createQaThreadSelectionReadiness(thread) {
  const stable = createChatNavigationReadiness();
  return observed => stable(qaThreadSelectionCandidate(thread, observed));
}

async function observeQaThreadSelection(harness) {
  return chrome(harness, () => {
    const state = window.__egdesk.state, searches = [...document.querySelectorAll('.egd-codex-thread-search')];
    const selectorFor = node => {
      const root = node.closest('#egd-hud, .egd-chat-card');
      if (!root?.id) throw new Error('Chat row has no owned surface root');
      const parts = [];
      for (let current = node; current !== root; current = current.parentElement) {
        parts.unshift(`${current.localName}:nth-child(${[...current.parentElement.children].indexOf(current) + 1})`);
      }
      return { rootId: root.id, selector: `#${CSS.escape(root.id)} > ${parts.join(' > ')}` };
    };
    return { query: state.codex.threadQuery, searchCount: searches.length, searchValue: searches[0]?.value,
      threads: state.codex.threads.map(item => ({ id: item.id, title: item.title })),
      rows: [...document.querySelectorAll('.egd-codex-thread-item')].map(node => {
        const { selector, rootId } = selectorFor(node), r = node.getBoundingClientRect(), style = getComputedStyle(node);
        let clipped = false, hitCount = 0;
        for (let parent = node.parentElement; parent; parent = parent.parentElement) {
          const css = getComputedStyle(parent), box = parent.getBoundingClientRect();
          if (/(auto|scroll|hidden|clip)/.test(css.overflowX) && (r.left < box.left || r.right > box.right) ||
              /(auto|scroll|hidden|clip)/.test(css.overflowY) && (r.top < box.top || r.bottom > box.bottom)) clipped = true;
        }
        for (const y of [0.2, 0.5, 0.8]) for (const x of [0.2, 0.5, 0.8]) {
          const hit = document.elementFromPoint(r.left + r.width * x, r.top + r.height * y);
          if (hit && (hit === node || node.contains(hit))) hitCount++;
        }
        return { selector, rootId, count: document.querySelectorAll(selector).length,
          threadId: state.codex.activeThreadId, title: node.querySelector('.egd-codex-thread-title')?.textContent?.trim() || '',
          focusKey: node.dataset.focusKey,
          target: { visible: !node.closest('[hidden],[inert],[aria-hidden="true"],.egd-hud-hidden') &&
            style.display !== 'none' && style.visibility !== 'hidden' && Number(style.opacity) > 0 && r.width > 0 && r.height > 0,
            disabled: !!node.disabled || node.getAttribute('aria-disabled') === 'true', clipped, hitCount,
            inside: r.left >= 0 && r.top >= 0 && r.right <= innerWidth && r.bottom <= innerHeight,
            rect: { left: r.left, top: r.top, right: r.right, bottom: r.bottom } },
          camera: { x: state.pan?.x, y: state.pan?.y, zoom: state.zoom,
            targetX: state.panTarget?.x, targetY: state.panTarget?.y, targetZoom: state.zoomTarget } };
      }) };
  });
}

async function selectQaThread(harness, thread) {
  assert.ok(typeof thread?.id === 'string' && thread.id && typeof thread.title === 'string' && thread.title.trim(), 'Exact QA room ID and title required');
  await openChat(harness);
  const back = '.egd-codex-conversation-back', search = '.egd-codex-thread-search';
  if ((await harness.inspect(back)).some(node => node.visible)) {
    await waitUntil(() => observeChatNavigation(harness, back), createChatNavigationReadiness(), { timeoutMs: 10000, intervalMs: 120 });
    await harness.click(back);
  }
  await waitUntil(() => observeChatNavigation(harness, search), createChatNavigationReadiness(), { timeoutMs: 10000, intervalMs: 120 });
  // Native focus/select-all/type emits the actual input event and lets the
  // product filter/re-render. No threadQuery/value/scroll/DOM writes here.
  await replaceFieldText(harness, search, thread.title);
  const ready = createQaThreadSelectionReadiness(thread);
  const observed = await waitUntil(() => observeQaThreadSelection(harness), ready, { timeoutMs: 10000, intervalMs: 120 });
  const row = qaThreadSelectionCandidate(thread, observed);
  const fresh = await observeQaThreadSelection(harness), current = qaThreadSelectionCandidate(thread, fresh);
  assert.ok(ready(fresh) && current?.selector === row.selector, 'Requested room changed or became clipped before its native click');
  await harness.click(current.selector);
  await visible(harness, '[data-testid="chat-composer"]');
  assert.equal((await chatIdentity(harness)).threadId, thread.id, 'UI selected a different Chat thread');
}

async function messages(harness) {
  return chrome(harness, () => {
    const codex = window.__egdesk.state.codex;
    const thread = codex.threads.find(item => item.id === codex.activeThreadId);
    return [...document.querySelectorAll('[data-testid="chat-message"]')].map((node) => ({
    id: node.dataset.messageId, role: node.dataset.role, runId: node.dataset.runId,
    rawText: thread?.messages.find(item => item.id === node.dataset.messageId)?.content ?? null,
    text: node.querySelector('.egd-codex-bubble-content')?.innerText || '',
    rowRight: node.getBoundingClientRect().right,
    bubbleRight: node.querySelector('.egd-codex-bubble')?.getBoundingClientRect().right,
    }));
  });
}

// A native End key can return while smooth scrolling is still in flight.
// Three consecutive, unclipped, hit-tested samples must agree before ONE click.
function createArtifactClickReadiness() {
  let anchor = null, consecutive = 0;
  const validBox = rect => !!rect && ['left', 'top', 'right', 'bottom', 'width', 'height'].every(key => Number.isFinite(rect[key]))
    && rect.width > 0 && rect.height > 0 && rect.right > rect.left && rect.bottom > rect.top;
  return observed => {
    const rect = observed?.rect, log = observed?.logRect, view = observed?.viewport;
    const clips = observed?.clippingAncestors;
    const contained = (outer, x = true, y = true) => validBox(outer)
      && (!x || rect.left >= outer.left && rect.right <= outer.right)
      && (!y || rect.top >= outer.top && rect.bottom <= outer.bottom);
    const ready = observed?.matchCount === 1 && observed.artifactId && observed.visible === true && observed.disabled === false
      && observed.hittable === true && validBox(rect) && Number.isFinite(observed.scrollTop)
      && contained(log) && contained(view) && Array.isArray(clips)
      && clips.every(clip => contained(clip.rect, clip.x, clip.y));
    if (!ready) { anchor = null; consecutive = 0; return false; }
    const identity = JSON.stringify([observed.artifactId, observed.runId, observed.answerId]);
    const geometry = [rect.left, rect.top, rect.right, rect.bottom, log.left, log.top, log.right, log.bottom, observed.scrollTop,
      view.width, view.height, ...clips.flatMap(clip => [clip.rect.left, clip.rect.top, clip.rect.right, clip.rect.bottom])];
    if (anchor?.identity === identity && anchor.geometry.length === geometry.length
        && geometry.every((value, index) => Math.abs(value - anchor.geometry[index]) <= 0.25)) consecutive++;
    else { anchor = { identity, geometry }; consecutive = 1; }
    return consecutive >= 3;
  };
}

async function observeArtifactClickTarget(harness, selector) {
  return chrome(harness, selector => {
    const box = node => {
      const rect = node?.getBoundingClientRect();
      return rect ? { left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom, width: rect.width, height: rect.height } : null;
    };
    const matches = [...document.querySelectorAll(selector)], chip = matches.length === 1 ? matches[0] : null;
    const rect = box(chip), log = chip?.closest('.egd-codex-messages'), style = chip && getComputedStyle(chip);
    const hit = rect && document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2);
    const clippingAncestors = [];
    for (let node = chip?.parentElement; node; node = node.parentElement) {
      const css = getComputedStyle(node), x = /^(auto|scroll|hidden|clip)$/.test(css.overflowX), y = /^(auto|scroll|hidden|clip)$/.test(css.overflowY);
      if (x || y) clippingAncestors.push({ rect: box(node), x, y });
    }
    return { matchCount: matches.length, artifactId: chip?.dataset.artifactId, runId: chip?.dataset.runId, answerId: chip?.dataset.answerId,
      rect, logRect: box(log), scrollTop: log?.scrollTop, clippingAncestors,
      viewport: { left: 0, top: 0, right: window.innerWidth, bottom: window.innerHeight, width: window.innerWidth, height: window.innerHeight },
      visible: !!chip && style.display !== 'none' && style.visibility !== 'hidden' && Number(style.opacity) > 0,
      disabled: chip?.disabled, hittable: !!chip && !!hit && (chip === hit || chip.contains(hit)) };
  }, selector);
}

// Passive, bounded diagnostics for the existing single native artifact click.
// No dispatch, focus, scroll, DOM/style changes, or replacement product APIs.
async function beginArtifactClickDiagnostics(harness, key, selector) {
  return chrome(harness, ({ key, selector }) => {
    if (Object.hasOwn(window, key)) throw new Error('Artifact diagnostic key already exists');
    const brief = value => { try { return String(value ?? '').slice(0, 2000); } catch { return '<unreadable>'; } };
    const describe = node => ({ node: node === window ? 'window' : node?.nodeName || null,
      id: node?.id || null, testid: node?.getAttribute?.('data-testid') || null,
      artifactId: node?.getAttribute?.('data-artifact-id') || null,
      class: brief(node?.getAttribute?.('class')) });
    const box = node => {
      const rect = node?.getBoundingClientRect?.();
      return rect ? { x: rect.x, y: rect.y, width: rect.width, height: rect.height,
        top: rect.top, right: rect.right, bottom: rect.bottom, left: rect.left } : null;
    };
    const observe = () => {
      const matches = [...document.querySelectorAll(selector)], chip = matches.length === 1 ? matches[0] : null;
      const rect = box(chip), center = rect && { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
      return { at: Date.now(), matchingArtifacts: matches.length, rect, center,
        elementsFromPoint: center ? document.elementsFromPoint(center.x, center.y).slice(0, 12).map(node => ({
          ...describe(node), withinArtifact: node === chip || chip.contains(node) })) : [],
        cards: [...document.querySelectorAll('.egd-browser-card')].slice(0, 32).map(card => ({ id: card.id,
          uri: brief(card._browserState?.uri || card._sourceRef?.uri || ''), sourceKey: brief(card.dataset.sourceKey), rect: box(card) })),
        notice: brief(document.getElementById('egd-board-notice')?.textContent) || null };
    };
    const data = { before: observe(), mouseEvents: [], windowErrors: [], unhandledRejections: [],
      dropped: { mouseEvents: 0, windowErrors: 0, unhandledRejections: 0 }, firstClickAt: null,
      afterDispatch: null, afterOneSecond: null, listenersRemoved: false };
    const append = (name, value, limit) => {
      if (data[name].length < limit) data[name].push(value); else data.dropped[name]++;
    };
    let sampleTimer = null, dispatchTimer = null, samplePromise = null;
    const removeListeners = () => {
      for (const name of ['mousedown', 'mouseup', 'click']) window.removeEventListener(name, onMouse, true);
      window.removeEventListener('error', onError, true);
      window.removeEventListener('unhandledrejection', onRejection, true);
      data.listenersRemoved = true;
    };
    const sampleAfterOneSecond = basis => {
      if (samplePromise) return samplePromise;
      samplePromise = new Promise(resolve => {
        const startedAt = Date.now();
        sampleTimer = window.setTimeout(() => {
          try { data.afterOneSecond = { basis, elapsedMs: Date.now() - startedAt, ...observe() }; }
          catch (error) { data.sampleError = brief(error?.message || error); }
          finally { removeListeners(); resolve(); }
        }, 1000);
      });
      return samplePromise;
    };
    function onMouse(event) {
      append('mouseEvents', { type: event.type, at: Date.now(), isTrusted: event.isTrusted,
        button: event.button, buttons: event.buttons, clientX: event.clientX, clientY: event.clientY,
        screenX: event.screenX, screenY: event.screenY, defaultPreventedAtCapture: event.defaultPrevented,
        target: describe(event.target), path: event.composedPath().slice(0, 16).map(describe) }, 32);
      if (event.type === 'click' && data.firstClickAt === null) {
        data.firstClickAt = Date.now();
        dispatchTimer = window.setTimeout(() => {
          try { data.afterDispatch = observe(); } catch (error) { data.dispatchObservationError = brief(error?.message || error); }
        }, 0);
        void sampleAfterOneSecond('first-observed-click');
      }
    }
    function onError(event) {
      append('windowErrors', { at: Date.now(), message: brief(event.message), filename: brief(event.filename),
        line: event.lineno, column: event.colno, stack: brief(event.error?.stack) }, 8);
    }
    function onRejection(event) {
      append('unhandledRejections', { at: Date.now(), reason: brief(event.reason?.message || event.reason),
        stack: brief(event.reason?.stack) }, 8);
    }
    window[key] = { data, async finish() {
      try { await sampleAfterOneSecond('no-click-observed; measured-from-diagnostic-finalization'); return data; }
      finally {
        window.clearTimeout(sampleTimer); window.clearTimeout(dispatchTimer);
        removeListeners(); delete window[key];
      }
    } };
    try {
      for (const name of ['mousedown', 'mouseup', 'click']) window.addEventListener(name, onMouse, { capture: true, passive: true });
      window.addEventListener('error', onError, { capture: true, passive: true });
      window.addEventListener('unhandledrejection', onRejection, { capture: true, passive: true });
    } catch (error) { removeListeners(); delete window[key]; throw error; }
    return data.before;
  }, { key, selector });
}

async function finishArtifactClickDiagnostics(harness, key) {
  return chrome(harness, async key => {
    const collection = window[key];
    if (!collection) return { unavailable: true, reason: 'Diagnostic collection absent' };
    return collection.finish();
  }, key);
}

// Span boundaries in rendered text carry no meaning; compare without whitespace.
const shows = (text, ...needles) => typeof text === 'string' && needles.every(needle => text.replace(/\s+/g, '').includes(String(needle).replace(/\s+/g, '')));

// Read-only control/state observation. Typed values never cross back: only whether a field is filled.
async function questionCard(harness) {
  return chrome(harness, () => {
    const cards = [...document.querySelectorAll('[data-testid="chat-user-input"]')];
    const card = cards[0];
    if (!card) return { count: 0 };
    const field = node => ({ type: node.type, disabled: node.disabled, filled: (node.value || '').length > 0,
      autocomplete: node.getAttribute('autocomplete'), spellcheck: node.spellcheck });
    const button = node => ({ disabled: node.disabled, text: node.textContent.trim() });
    return { count: cards.length, content: card.textContent.replace(/\s+/g, ' ').trim(),
      alerts: card.querySelectorAll('[role="alert"]').length + (card.getAttribute('role') === 'alert' ? 1 : 0),
      radios: [...card.querySelectorAll('[data-testid="chat-user-input-option"]')].map(node => ({ type: node.type, disabled: node.disabled, checked: node.checked })),
      other: [...card.querySelectorAll('[data-testid="chat-user-input-other"]')].map(field),
      freeText: [...card.querySelectorAll('[data-testid="chat-user-input-text"]')].map(field),
      submit: [...card.querySelectorAll('[data-testid="chat-user-input-submit"]')].map(button),
      skip: [...card.querySelectorAll('[data-testid="chat-user-input-skip"]')].map(button) };
  });
}

// Native clicks need one exact element; derive it from the radio's own label and attributes.
async function questionOptionSelector(harness, label) {
  const selector = await chrome(harness, (label) => {
    const base = '[data-testid="chat-user-input-option"]';
    const labelOf = node => [[...(node.labels || [])].map(item => item.textContent).join(' '), node.getAttribute('aria-label'),
      node.dataset.label, node.closest('label')?.textContent].find(text => text && text.trim()) || '';
    const matches = [...document.querySelectorAll(`[data-testid="chat-user-input"] ${base}`)].filter(node => labelOf(node).includes(label));
    if (matches.length !== 1) return null;
    // CSS.escape, not JSON: CSS reads JSON's backslash-n as a plain "n". Control-character values are skipped.
    const exact = base + [...matches[0].attributes]
      .filter(attr => !['class', 'style', 'checked', 'data-testid'].includes(attr.name) && !/[\u0000-\u001f]/.test(attr.value))
      .map(attr => `[${CSS.escape(attr.name)}="${CSS.escape(attr.value)}"]`).join('');
    return document.querySelectorAll(exact).length === 1 ? exact : null;
  }, label);
  if (!selector) throw new Error(`Question option "${label}" needs its own label and a distinguishing attribute for a native click`);
  return selector;
}

// Where a private test answer could linger: state graph, attributes, text, live fields, web storage.
async function privateAnswerTrace(harness, needle) {
  return chrome(harness, (needle) => {
    const seen = new WeakSet();
    const stack = [window.__egdesk?.state];
    let state = false;
    for (let budget = 400000; stack.length && budget > 0 && !state; budget--) {
      const value = stack.pop();
      if (typeof value === 'string') { state = value.includes(needle); continue; }
      if (!value || typeof value !== 'object' || seen.has(value) || value === window
          || (typeof Node === 'function' && value instanceof Node) || (typeof Window === 'function' && value instanceof Window)) continue;
      seen.add(value);
      try {
        if (value instanceof Map) for (const [key, item] of value) stack.push(key, item);
        else if (value instanceof Set) for (const item of value) stack.push(item);
        else for (const key of Object.keys(value)) { stack.push(key); try { stack.push(value[key]); } catch {} }
      } catch {}
    }
    let storage = false;
    for (const area of ['localStorage', 'sessionStorage']) {
      try {
        const store = window[area];
        for (let index = 0; index < store.length; index++) {
          const key = store.key(index);
          if (key.includes(needle) || (store.getItem(key) || '').includes(needle)) storage = true;
        }
      } catch {}
    }
    return { state, storage, text: document.documentElement.textContent.includes(needle),
      attributes: [...document.querySelectorAll('*')].some(node => [...node.attributes].some(attr => attr.value.includes(needle))),
      fields: [...document.querySelectorAll('input, textarea')].filter(node => (node.value || '').includes(needle))
        .map(node => node.getAttribute('data-testid') || node.localName) };
  }, needle);
}

async function subAgentView(harness, activityIds) {
  return chrome(harness, ({ collabId, gatherId }) => {
    const sections = [...document.querySelectorAll('[data-testid="chat-subagents"]')];
    const gather = document.querySelector(`.egd-codex-activity-row[data-activity-id="${CSS.escape(gatherId)}"]`);
    return { sections: sections.map(section => ({ text: section.textContent.replace(/\s+/g, ' ').trim(),
      alerts: section.querySelectorAll('[role="alert"]').length + (section.getAttribute('role') === 'alert' ? 1 : 0),
      beforeActivity: !!gather && !!(section.compareDocumentPosition(gather) & Node.DOCUMENT_POSITION_FOLLOWING),
      rows: [...section.querySelectorAll('[data-testid="chat-subagent"]')].map(row => ({ threadId: row.dataset.agentThreadId,
        status: row.dataset.status, text: row.textContent.replace(/\s+/g, ' ').trim() })) })),
    collabRows: document.querySelectorAll(`.egd-codex-activity-row[data-activity-id="${CSS.escape(collabId)}"]`).length,
    gatherRow: !!gather };
  }, activityIds);
}

await runUiFlow('rendered-ui-fixture-transport', async ({ harness, check, capture, result, defer }) => {
  result.providerTurn = 'fixture-only';
  assertQaFixtureManifest(harness.profile);
  const fixtureState = async () => {
    const state = await loopbackJson('/__qa/state', { token });
    if (state.fixture !== true || state.profile !== harness.profile) throw new Error('Fixture server is not bound to this Firefox test profile');
    return state;
  };
  const control = async (route, body) => {
    await fixtureState();
    return loopbackJson(route, { method: 'POST', token, body });
  };
  await waitUntil(fixtureState, (state) => state.clients > 0);
  const initialFixture = await fixtureState();
  check('fixture server has no prior sends from another test', initialFixture.observed.sends.length === 0);
  await chrome(harness, () => { window.__egdeskQaTransportIdentity = { fetch: window.fetch, EventSource: window.EventSource }; return true; });
  // A headless Chrome window opens without a usable viewport. Size only the
  // owned headless window; a visible window keeps its own size.
  await chrome(harness, ({ width, height }) => {
    const gfx = Cc['@mozilla.org/gfx/info;1'].getService(Ci.nsIGfxInfo);
    if (gfx.isHeadless !== true || document.documentURI !== 'chrome://browser/content/browser.xhtml') return false;
    window.resizeTo(width + window.outerWidth - window.innerWidth, height + window.outerHeight - window.innerHeight);
    return true;
  }, { width: 1440, height: 900 });
  // A fresh profile opens on the first-use Browser with the Desk shell hidden;
  // zoom out once natively to reveal the Dock, as the headless regression does.
  const dockVisible = () => chrome(harness, () => {
    const node = document.querySelector('#egd-dock .egd-dock-btn[data-id="chat"]');
    const rect = node?.getBoundingClientRect();
    return !!rect && rect.width > 0 && rect.height > 0 && getComputedStyle(node).visibility !== 'hidden';
  });
  if (!await dockVisible()) {
    await harness.press('meta+-');
    await waitUntil(dockVisible, Boolean);
  }
  defer(async () => {
    const untouched = await chrome(harness, () => {
      const original = window.__egdeskQaTransportIdentity;
      const same = !!original && original.fetch === window.fetch && original.EventSource === window.EventSource;
      delete window.__egdeskQaTransportIdentity;
      return same;
    });
    check('fixture flow leaves the original fetch and EventSource intact', untouched);
  });
  const nonce = Date.now().toString(36);
  const threadA = await newQaThread(harness, `QA A ${nonce}`);
  const before = await canvasState(harness);
  const completePrompt = `EGDESK_QA_COMPLETE ${nonce}`;
  await sendFromComposer(harness, completePrompt);
  let fixture = await waitUntil(fixtureState, (state) => state.runs.some((run) => run.fixtureStage === 'streaming-visible'));
  const completeRun = fixture.runs.find((run) => run.clientThreadId === threadA.wireClientThreadId);
  check('early SSE is associated with the originating UI thread', !!completeRun);
  const sendA = fixture.observed.sends.find((send) => send.runId === completeRun.runId);
  assertOrdinarySend(sendA);
  check('ordinary UI send carries explicit profileEnabled false', sendA.profileEnabled === false);
  check('native UI submits exactly once with reflected request/thread correlation IDs', fixture.observed.sends.length === 1 && !!sendA.requestId && sendA.clientThreadId === threadA.wireClientThreadId);
  const early = fixture.observed.events.find((event) => event.runId === completeRun.runId && event.event === 'run.started');
  check('SSE was emitted while a subscriber existed and before POST completed', initialFixture.clients > 0 && early.ts < sendA.respondedAt);
  await visible(harness, '[data-testid="chat-stop"]');
  check('streaming text reaches rendered assistant bubble', (await messages(harness)).some((message) => message.role === 'assistant' && message.text.includes('Fixture reply begins.')));
  await control('/__qa/delta', { runId: completeRun.runId, delta: 'QA-LIVE-INCREMENT\n' });
  await waitUntil(() => messages(harness), rows => rows.some(row => row.role === 'assistant' && row.text.includes('QA-LIVE-INCREMENT')));
  check('a new transport delta updates the same rendered assistant item',
    (await messages(harness)).filter(row => row.role === 'assistant').length === 1 &&
    (await messages(harness)).find(row => row.role === 'assistant').text.split('QA-LIVE-INCREMENT').length === 2);
  const rawAfterDelta = (await fixtureState()).runs.find(run => run.runId === completeRun.runId).messages.find(message => message.role === 'assistant');
  const renderedAfterDelta = (await messages(harness)).find(message => message.id === rawAfterDelta.id);
  assertPlainRenderedMessage(rawAfterDelta.text, renderedAfterDelta.rawText, renderedAfterDelta.text);
  check('native/UI raw text is exact and every rendered line is preserved', true);
  await harness.click('[data-testid="chat-activity-open"]');
  const activities = await visible(harness, '.egd-codex-activity-row');
  check('activity is rendered while the run is active', activities.some((node) => node.dataset.status === 'inProgress'));
  await capture('fixture-streaming-activity');
  await harness.click('[aria-label="활동 기록 닫기"]');
  const scroll = await harness.scrollWithKey('.egd-codex-messages', 'auto');
  check('native key scroll moves the focused overflowing message log in a direction with room', scroll.overflow && scroll.focused && scroll.moved, scroll);
  await harness.scrollWithKey('.egd-codex-messages', 'End');

  await control('/__qa/release', { runId: completeRun.runId, phase: 'message' });
  await visible(harness, '[data-testid="chat-artifact"]');
  const statusAfterMessage = (await harness.inspect('[data-testid="chat-run-status"]'))[0];
  check('message.completed keeps the run active until its own completion event', statusAfterMessage.dataset.status !== 'completed' && statusAfterMessage.dataset.stopConfirmed !== 'true');
  const afterEvents = await canvasState(harness);
  check('stream/activity/artifact events create no background cards and do not move the camera', JSON.stringify(before) === JSON.stringify(afterEvents));
  await control('/__qa/release', { runId: completeRun.runId, phase: 'run' });
  await waitUntil(() => harness.inspect('[data-testid="chat-run-status"]'), (nodes) => nodes[0]?.dataset.status === 'completed');
  fixture = await fixtureState();
  const artifact = fixture.runs.find((run) => run.runId === completeRun.runId).artifacts[0];
  assertQaFixtureArtifact(harness.profile, artifact);
  await control('/__qa/replay', {});
  const beforeReconnect = await fixtureState();
  await control('/__qa/reconnect', {});
  // Since bc47de6 a stream reconnect only re-subscribes; the native conversation
  // is resumed by an explicit room selection or send, never implicitly.
  await waitUntil(fixtureState, (state) => state.clients > 0);
  await new Promise(resolve => setTimeout(resolve, 600));
  check('stream reconnect re-subscribes without resuming the native conversation by itself',
    (await fixtureState()).observed.resumes.length === beforeReconnect.observed.resumes.length);
  await waitUntil(() => messages(harness), (rows) => rows.some((row) => row.role === 'assistant'));
  const hydrated = await messages(harness);
  const userRows = hydrated.filter((row) => row.role === 'user' && row.rawText === completePrompt);
  check('native user plus local optimistic user hydrate into one rendered user message', userRows.length === 1);
  check('user bubble remains right aligned', Math.abs(userRows[0].rowRight - userRows[0].bubbleRight) <= 2);
  check('event replay does not duplicate the assistant item or streamed text',
    hydrated.filter((row) => row.role === 'assistant').length === 1 &&
    hydrated.find((row) => row.role === 'assistant').text.split('Fixture reply begins.').length === 2);
  const hydratedAssistant = hydrated.find(row => row.id === rawAfterDelta.id);
  assertPlainRenderedMessage(rawAfterDelta.text, hydratedAssistant.rawText, hydratedAssistant.text);
  check('hydration preserves the complete raw and visible assistant message', true);
  // Hydration redraws the log; the chip sits at its end. Bring it into view with
  // the native End key before the native click, and keep the geometry for a failure.
  const artifactChip = `[data-testid="chat-artifact"]${attributeSelector('data-artifact-id', artifact.id)}`;
  await harness.scrollWithKey('.egd-codex-messages', 'End');
  const readiness = result.artifactClickReadiness = { observations: 0, samples: [] };
  const clickReady = createArtifactClickReadiness();
  await waitUntil(async () => {
    const observed = await observeArtifactClickTarget(harness, artifactChip);
    readiness.observations++;
    readiness.samples.push(observed);
    if (readiness.samples.length > 12) readiness.samples.shift();
    return observed;
  }, clickReady, { timeoutMs: 10000, intervalMs: 100 });
  const chipGeometry = { chip: (await harness.inspect(artifactChip))[0]?.rect, log: (await harness.inspect('.egd-codex-messages'))[0]?.rect };
  const diagnosticKey = `__egdeskQaArtifactClick_${randomUUID().replaceAll('-', '')}`;
  const diagnostics = result.artifactClickDiagnostics = { selector: artifactChip, artifactId: artifact.id, filePath: artifact.target.path, chipGeometry };
  let diagnosticsCollected = false, diagnosticsInstalled = false;
  const collectDiagnostics = async () => {
    if (diagnosticsCollected) return;
    if (!diagnosticsInstalled) { diagnosticsCollected = true; return; }
    try {
      Object.assign(diagnostics, await finishArtifactClickDiagnostics(harness, diagnosticKey));
      diagnosticsCollected = true;
    } catch (error) { diagnostics.collectionError = error.message; }
  };
  // If a transport call fails, the ordinary flow cleanup gets one last chance
  // to collect/remove only our listeners; it never retries the artifact action.
  defer(collectDiagnostics);
  try {
    diagnostics.before = await beginArtifactClickDiagnostics(harness, diagnosticKey, artifactChip);
    diagnosticsInstalled = true;
  }
  catch (error) { diagnostics.installError = error.message; }
  try {
  await harness.click(artifactChip);
  // The card is created by the click handler; wait for it and keep what was seen
  // (cards, any board notice) so a failure explains itself.
  const openedFile = await waitUntil(() => chrome(harness, (filePath) => {
    const cards = [...document.querySelectorAll('.egd-browser-card')].map(card => card._browserState?.uri || card._sourceRef?.uri || '');
    return { opened: cards.some(uri => { try { return decodeURIComponent(new URL(uri).pathname) === filePath; } catch { return false; } }),
      cards, notice: document.getElementById('egd-board-notice')?.textContent || null };
  }, artifact.target.path), value => value.opened);
  check('explicit artifact click opens the verified temporary file on Canvas', openedFile.opened, chipGeometry);
  await waitUntil(() => chrome(harness, async (filePath) => {
    const card = [...document.querySelectorAll('.egd-browser-card')].find(card => {
      try { return decodeURIComponent(new URL(card._browserState?.uri || card._sourceRef?.uri || '').pathname) === filePath; } catch { return false; }
    });
    if (!card) return false;
    try { return JSON.stringify(await window.__egdesk.browserAgent.snapshot(card.id)).includes('EG-Desk deterministic QA fixture reference only.'); }
    catch { return false; }
  }, artifact.target.path), Boolean);
  check('fixture artifact contents are rendered in its Canvas Browser view', true);
  await capture('fixture-artifact-open');
  } finally { await collectDiagnostics(); }

  await returnFromArtifactRoomToHome(harness, result, threadA.id);
  const threadB = await newQaThread(harness, `QA B ${nonce}`);
  // The artifact Browser took the camera away from Chat; opening Chat again must leave its input on screen.
  check('Chat input is on screen and clear of the Dock after a Browser opened beside it', await chrome(harness, () => {
    const input = document.querySelector('.egd-codex-input')?.getBoundingClientRect();
    const dock = document.getElementById('egd-dock')?.getBoundingClientRect();
    return !!input && input.width > 0 && input.top >= 0 && input.left >= 0 && input.right <= window.innerWidth && input.bottom <= window.innerHeight &&
      (!dock || !(dock.width > 0) || input.bottom <= dock.top || input.right <= dock.left || input.left >= dock.right);
  }));
  const ordinaryPrompt = `EGDESK_QA_TEXT_ONLY ${nonce}`;
  await sendFromComposer(harness, ordinaryPrompt);
  fixture = await waitUntil(fixtureState, (state) => state.runs.some((run) => run.clientThreadId === threadB.wireClientThreadId && run.status === 'completed'));
  const ordinaryRun = fixture.runs.find((run) => run.clientThreadId === threadB.wireClientThreadId);
  await waitUntil(() => harness.inspect('[data-testid="chat-run-status"]'), (nodes) => nodes[0]?.dataset.status === 'completed');
  check('ordinary text produces no structured artifact or rendered artifact chip', ordinaryRun.artifacts.length === 0 && (await harness.inspect('[data-testid="chat-artifact"]')).length === 0);
  await selectQaThread(harness, threadA);
  check('thread A retains only its own user message', (await messages(harness)).some((row) => row.rawText === completePrompt) && !(await messages(harness)).some((row) => row.rawText === ordinaryPrompt));
  await selectQaThread(harness, threadB);
  check('thread B retains only its own user message', (await messages(harness)).some((row) => row.rawText === ordinaryPrompt) && !(await messages(harness)).some((row) => row.rawText === completePrompt));

  await sendFromComposer(harness, `EGDESK_QA_REJECT ${nonce}`);
  await waitUntil(() => chatIdentity(harness), identity => !!identity.sendError);
  await replaceComposerText(harness, 'QA unsent draft after definite rejection');
  check('definite 503 rejection leaves the composer able to send a later request', !(await harness.inspect('[data-testid="chat-send"]'))[0].disabled);
  await sendFromComposer(harness, `EGDESK_QA_AMBIGUOUS ${nonce}`);
  await visible(harness, '[data-testid="chat-reconcile"]');
  await replaceComposerText(harness, 'QA unsent draft during reconciliation');
  check('ambiguous transport failure stays blocked pending explicit reconciliation', (await harness.inspect('[data-testid="chat-send"]'))[0].disabled);
  await harness.click('[data-testid="chat-reconcile"]');
  await waitUntil(() => harness.inspect('[data-testid="chat-send"]'), nodes => nodes[0] && !nodes[0].disabled);
  await replaceComposerText(harness, '');
  await capture('fixture-rejection-reconcile');

  await sendFromComposer(harness, `EGDESK_QA_STOP ${nonce}`);
  fixture = await waitUntil(fixtureState, (state) => state.runs.some((run) => run.clientThreadId === threadB.wireClientThreadId && run.status === 'running'));
  const stopRun = fixture.runs.findLast((run) => run.clientThreadId === threadB.wireClientThreadId);
  await control('/__qa/history', { partial: true });
  await harness.click('[data-testid="chat-activity-open"]');
  await harness.click('[aria-label="활동 상태 다시 확인"]');
  await visible(harness, '[data-testid="chat-history-status"][data-complete="false"]');
  await control('/__qa/delta', { runId: stopRun.runId, delta: ' QA-RESUMED-DELTA' });
  await waitUntil(() => messages(harness), rows => rows.some(row => row.runId === stopRun.runId && row.text.includes('QA-RESUMED-DELTA')));
  check('resumed active message accepts later deltas without duplication',
    (await messages(harness)).filter(row => row.role === 'assistant' && row.runId === stopRun.runId).length === 1);
  const rawResumed = (await fixtureState()).runs.find(run => run.runId === stopRun.runId).messages.find(message => message.role === 'assistant');
  const renderedResumed = (await messages(harness)).find(row => row.id === rawResumed.id);
  assertPlainRenderedMessage(rawResumed.text, renderedResumed.rawText, renderedResumed.text);
  await capture('fixture-partial-history-active-delta');
  await harness.click('[aria-label="활동 기록 닫기"]');
  await control('/__qa/history', { partial: false });
  await control('/__qa/auth-refresh', { fail: true });
  await control('/__qa/reconnect', {});
  await waitUntil(fixtureState, (state) => state.clients > 0);
  await visible(harness, '[data-testid="chat-stop"]');
  await harness.click('[data-testid="chat-stop"]');
  await waitUntil(fixtureState, (state) => state.runs.find((run) => run.runId === stopRun.runId)?.stopRequested);
  const stopping = (await harness.inspect('[data-testid="chat-run-status"]'))[0];
  const stopButton = (await harness.inspect('[data-testid="chat-stop"]'))[0];
  check('stop acknowledgement disables the button without claiming interrupted', stopButton.disabled && stopping.dataset.stopConfirmed === 'false' && stopping.dataset.status !== 'interrupted');
  await capture('fixture-stop-requested');
  await control('/__qa/release', { runId: stopRun.runId, phase: 'run' });
  await waitUntil(() => harness.inspect('[data-testid="chat-run-status"]'), (nodes) => nodes[0]?.dataset.stopConfirmed === 'true');
  check('one explicit stop targets the active conversation and run', (await fixtureState()).observed.interrupts.length === 1);
  await control('/__qa/auth-refresh', { fail: false });

  await sendFromComposer(harness, `EGDESK_QA_APPROVAL ${nonce}`);
  fixture = await waitUntil(fixtureState, (state) => state.runs.some((run) => run.pendingApprovals.length));
  const approvalRun = fixture.runs.find((run) => run.pendingApprovals.length);
  const approval = approvalRun.pendingApprovals[0];
  await harness.click('[data-testid="chat-activity-open"]');
  await visible(harness, '[data-testid="chat-approval"]');
  check('approval is not answered automatically and proposed paths are not artifacts', fixture.observed.approvals.length === 0 && (await harness.inspect('[data-testid="chat-artifact"]')).length === 0);
  const choices = await harness.inspect('[data-testid="chat-approval-choice"]');
  check('rendered choices are exactly those offered by the pending approval', JSON.stringify(choices.map((node) => node.dataset.decision).sort()) === JSON.stringify([...approval.choices].sort()));
  await harness.click(`[data-testid="chat-approval-choice"][data-decision="decline"]${attributeSelector('data-approval-id', approval.approvalId)}`);
  await waitUntil(() => harness.inspect('[data-testid="chat-approval"]'), (nodes) => nodes[0]?.dataset.status === 'replySent');
  check('replySent disables every approval choice while the run stays active',
    (await harness.inspect('[data-testid="chat-approval-choice"]')).every((node) => node.disabled) &&
    (await fixtureState()).runs.find((run) => run.runId === approvalRun.runId).status === 'running');
  await capture('fixture-approval-reply-sent');
  await control('/__qa/release', { runId: approvalRun.runId, phase: 'approval' });
  await waitUntil(() => harness.inspect('[data-testid="chat-approval"]'), (nodes) => nodes.length === 0);
  await control('/__qa/release', { runId: approvalRun.runId, phase: 'run' });
  await harness.click('[aria-label="활동 기록 닫기"]');
  await waitUntil(() => harness.inspect('[data-testid="chat-run-status"]'), (nodes) => nodes[0]?.dataset.status === 'completed');

  // Agent question: shown in the activity record, answered only by explicit native input.
  const threadQ = await newQaThread(harness, `QA question ${nonce}`);
  const privateAnswer = `QA-PRIVATE-${nonce}-${randomUUID().slice(0, 8)}`;
  const sendsBeforeQuestion = (await fixtureState()).observed.sends.length;
  await sendFromComposer(harness, `EGDESK_QA_USER_INPUT ${nonce}`);
  fixture = await waitUntil(fixtureState, (state) => state.runs.some((run) => run.clientThreadId === threadQ.wireClientThreadId && run.pendingUserInputs?.length));
  const questionRun = fixture.runs.find((run) => run.clientThreadId === threadQ.wireClientThreadId);
  const pendingQuestion = questionRun.pendingUserInputs[0];
  const [choiceQuestion, privateQuestion] = pendingQuestion.questions;
  check('fixture question uses the public two-question contract', pendingQuestion.status === 'pending' && pendingQuestion.isBlocking &&
    choiceQuestion.options?.length === 2 && choiceQuestion.allowsOther && privateQuestion.options === null && privateQuestion.isSecret);
  await waitUntil(() => harness.inspect('[data-testid="chat-run-status"]'), (nodes) => shows(nodes[0]?.text, '답변 대기'));
  check('parent run status reads waiting for an answer', true);
  check('activity button counts the pending question', shows((await harness.inspect('[data-testid="chat-activity-open"]'))[0]?.text, '질문 1건'));
  await harness.click('[data-testid="chat-activity-open"]');
  await visible(harness, '[data-testid="chat-user-input"]');
  await new Promise(resolve => setTimeout(resolve, 500));
  let card = await questionCard(harness);
  check('question is not answered or skipped automatically', (await fixtureState()).observed.userInputs.length === 0 && card.count === 1);
  check('question card shows the blocking notice, every header, question, option and description',
    ['Agent 질문', '답변할 때까지 작업이 멈춰 있습니다.', '기타(직접 입력)', choiceQuestion.header, choiceQuestion.question,
      privateQuestion.header, privateQuestion.question, ...choiceQuestion.options.flatMap(item => [item.label, item.description])]
      .every(text => shows(card.content, text)));
  check('choice question renders radios and its other-text stays disabled until chosen',
    card.radios.length >= choiceQuestion.options.length && card.radios.every(item => item.type === 'radio') &&
    card.other.length === 1 && card.other[0].disabled);
  check('private free-text answer is a password field without autocomplete or spellcheck',
    card.freeText.length === 1 && card.freeText[0].type === 'password' && card.freeText[0].autocomplete === 'off' &&
    card.freeText[0].spellcheck === false && !card.freeText[0].disabled);
  check('send stays disabled until every question has an answer while skip is offered',
    card.submit.length === 1 && shows(card.submit[0].text, '답변 보내기') && card.submit[0].disabled &&
    card.skip.length === 1 && shows(card.skip[0].text, '건너뛰기') && !card.skip[0].disabled && card.alerts === 0);
  const chosenOption = choiceQuestion.options[1];
  const optionSelector = await questionOptionSelector(harness, chosenOption.label);
  await harness.click(optionSelector);
  await waitUntil(() => chrome(harness, (selector) => document.querySelector(selector)?.checked === true, optionSelector), Boolean);
  check('one chosen option alone does not enable send', (await questionCard(harness)).submit[0].disabled);
  await harness.fill('[data-testid="chat-user-input-text"]', privateAnswer);
  card = await waitUntil(() => questionCard(harness), (value) => value.submit?.[0] && !value.submit[0].disabled);
  check('answering every question enables send without submitting', (await fixtureState()).observed.userInputs.length === 0 && card.other[0].disabled);
  const draftTrace = await privateAnswerTrace(harness, privateAnswer);
  check('private draft lives only in its field, not in app state, attributes, text or storage',
    !draftTrace.state && !draftTrace.attributes && !draftTrace.text && !draftTrace.storage &&
    JSON.stringify(draftTrace.fields) === JSON.stringify(['chat-user-input-text']));
  await harness.click('[data-testid="chat-user-input-submit"]');
  fixture = await waitUntil(fixtureState, (state) => state.observed.userInputs.length === 1);
  const reply = fixture.observed.userInputs[0];
  check('one explicit submit sends the chosen option and the exact private text once',
    reply.action === 'submit' && reply.userInputId === pendingQuestion.userInputId && reply.runId === questionRun.runId &&
    reply.answers.length === 2 && reply.answers[0].questionId === choiceQuestion.questionId && reply.answers[0].optionIndex === 1 &&
    reply.answers[1].questionId === privateQuestion.questionId &&
    reply.answers[1].textDigest === createHmac('sha256', token).update(privateAnswer).digest('hex'));
  card = await waitUntil(() => questionCard(harness), (value) => value.count === 1 && shows(value.content, '답변 전달됨 · 작업 상태 확인 중'));
  check('replySent disables every control and marks the private answer as delivered without echoing it',
    shows(card.content, '비공개 답변 전달됨') && card.radios.every(item => item.disabled) &&
    [...card.other, ...card.freeText].every(item => item.disabled && !item.filled) &&
    [...card.submit, ...card.skip].every(item => item.disabled) &&
    (await fixtureState()).runs.find((run) => run.runId === questionRun.runId).status === 'running');
  const sentTrace = await privateAnswerTrace(harness, privateAnswer);
  check('submitted private answer is cleared from fields, state, attributes, text and storage',
    !sentTrace.state && !sentTrace.attributes && !sentTrace.text && !sentTrace.storage && sentTrace.fields.length === 0);
  const questionSnapshot = await loopbackJson(`/chat/state?conversationId=${encodeURIComponent(questionRun.conversationId)}`);
  check('fixture records and snapshots never contain the private answer',
    !JSON.stringify(await fixtureState()).includes(privateAnswer) && !JSON.stringify(questionSnapshot).includes(privateAnswer));
  await capture('fixture-user-input-reply-sent');
  await control('/__qa/release', { runId: questionRun.runId, phase: 'userInput' });
  await waitUntil(() => harness.inspect('[data-testid="chat-user-input"]'), (nodes) => nodes.length === 0);
  await waitUntil(() => harness.inspect('[data-testid="chat-run-status"]'), (nodes) => nodes[0] && !shows(nodes[0].text, '답변 대기'));
  check('resolved question disappears while the same run keeps working',
    (await fixtureState()).runs.find((run) => run.runId === questionRun.runId).status === 'running' &&
    !shows((await harness.inspect('[data-testid="chat-activity-open"]'))[0]?.text ?? '질문', '질문'));
  await control('/__qa/release', { runId: questionRun.runId, phase: 'run' });
  await waitUntil(() => harness.inspect('[data-testid="chat-run-status"]'), (nodes) => nodes[0]?.dataset.status === 'completed');
  fixture = await fixtureState();
  const finalTrace = await privateAnswerTrace(harness, privateAnswer);
  check('the answered run completes as the same run with one reply and no extra send',
    fixture.observed.userInputs.length === 1 && fixture.observed.sends.length === sendsBeforeQuestion + 1 &&
    fixture.runs.find((run) => run.runId === questionRun.runId).status === 'completed' &&
    !finalTrace.state && !finalTrace.attributes && !finalTrace.text && !finalTrace.storage && finalTrace.fields.length === 0);
  await harness.click('[aria-label="활동 기록 닫기"]');

  // Sub-agents: quiet rows inside the same activity record, blocked ones called out.
  await sendFromComposer(harness, `EGDESK_QA_SUBAGENT ${nonce}`);
  fixture = await waitUntil(fixtureState, (state) => state.runs.some((run) => run.clientThreadId === threadQ.wireClientThreadId && run.fixtureStage === 'subagents-visible'));
  const subAgentRun = fixture.runs.find((run) => run.clientThreadId === threadQ.wireClientThreadId && run.fixtureStage === 'subagents-visible');
  const [agentDone, agentErrored, agentWaiting] = subAgentRun.subAgents;
  check('fixture sub-agents are running, errored and approval-blocked',
    subAgentRun.subAgents.length === 3 && agentDone.state === 'running' && !agentDone.blocked &&
    agentErrored.blocked?.reason === 'errored' && agentErrored.label === null && agentWaiting.blocked?.reason === 'approvalRequested');
  const subAgentActivities = { collabId: `${subAgentRun.runId}-collab`, gatherId: `${subAgentRun.runId}-activity` };
  await waitUntil(() => harness.inspect('[data-testid="chat-activity-open"]'), (nodes) => shows(nodes[0]?.text, '막힘 2건'));
  check('activity button counts blocked sub-agents', true);
  await harness.click('[data-testid="chat-activity-open"]');
  await visible(harness, '[data-testid="chat-subagent"]');
  let agents = await waitUntil(() => subAgentView(harness, subAgentActivities), (value) => value.sections.length === 1 && value.sections[0].rows.length === 3);
  const agentRow = (view, agent) => view.sections[0].rows.find(row => row.threadId === agent.threadId);
  check('sub-agent section lists exactly the three child threads under one heading with the blocked count',
    shows(agents.sections[0].text, '하위 Agent · 3', '막힘 2') &&
    subAgentRun.subAgents.every(agent => agentRow(agents, agent)));
  check('running sub-agent shows its name, progress and task preview', agentRow(agents, agentDone).status === 'active' &&
    shows(agentRow(agents, agentDone).text, 'researcher', '진행 중', agentDone.taskPreview));
  check('errored sub-agent is blocked under its short fallback name with its reason',
    agentRow(agents, agentErrored).status === 'blocked' &&
    shows(agentRow(agents, agentErrored).text, `하위 Agent ${agentErrored.threadId.slice(0, 8)}`, '오류로 멈춤', agentErrored.message));
  check('approval request from a sub-agent is shown as blocked, never granted',
    agentRow(agents, agentWaiting).status === 'blocked' &&
    shows(agentRow(agents, agentWaiting).text, 'reviewer', '승인 요청으로 멈춤') &&
    (await harness.inspect('[data-testid="chat-approval"]')).length === 0);
  check('sub-agent rows stay quiet and replace the raw collaboration activity row',
    agents.sections[0].alerts === 0 && agents.collabRows === 0 && agents.gatherRow && agents.sections[0].beforeActivity);
  check('sub-agent status creates no chat message', !(await messages(harness)).some(row => row.runId === subAgentRun.runId && row.role === 'assistant'));
  await capture('fixture-subagent-blocked');
  await control('/__qa/release', { runId: subAgentRun.runId, phase: 'subagent' });
  agents = await waitUntil(() => subAgentView(harness, subAgentActivities), (value) => value.sections[0] && agentRow(value, agentDone)?.status === 'done');
  check('finished sub-agent turns done while blocked ones stay blocked',
    shows(agentRow(agents, agentDone).text, '완료') && shows(agents.sections[0].text, '막힘 2') &&
    agentRow(agents, agentErrored).status === 'blocked' && agentRow(agents, agentWaiting).status === 'blocked');
  await control('/__qa/release', { runId: subAgentRun.runId, phase: 'run' });
  await waitUntil(() => harness.inspect('[data-testid="chat-run-status"]'), (nodes) => nodes[0]?.dataset.status === 'completed' && nodes[0].dataset.runId === subAgentRun.runId);
  check('sub-agent run completes without any reply or extra send',
    (await fixtureState()).observed.userInputs.length === 1 && (await fixtureState()).observed.sends.length === sendsBeforeQuestion + 2);
  await harness.click('[aria-label="활동 기록 닫기"]');

  const threadC = await newQaThread(harness, `QA retry ${nonce}`);
  const retryPrompt = `EGDESK_QA_START_FAIL ${nonce}`;
  await sendFromComposer(harness, retryPrompt);
  fixture = await waitUntil(fixtureState, (state) => state.observed.sends.some((send) => send.clientThreadId === threadC.wireClientThreadId && send.outcome === 'turn-start-rejected'));
  await visible(harness, '.egd-codex-error');
  const failedSend = fixture.observed.sends.find((send) => send.clientThreadId === threadC.wireClientThreadId);
  const failedIdentity = await chatIdentity(harness);
  check('failed first send retains the native conversation in the same UI Chat', failedIdentity.conversationId === failedSend.createdConversationId && failedIdentity.threadId === threadC.id);
  await sendFromComposer(harness, retryPrompt);
  fixture = await waitUntil(fixtureState, (state) => state.runs.some((run) => run.clientThreadId === threadC.wireClientThreadId && run.status === 'completed'));
  const attempts = fixture.observed.sends.filter((send) => send.clientThreadId === threadC.wireClientThreadId);
  check('explicit retry uses the returned native conversation and creates no unrelated conversation',
    attempts.length === 2 && attempts[1].conversationId === failedSend.createdConversationId);
  await capture('fixture-first-send-retry');

  await sendFromComposer(harness, `EGDESK_QA_LOST ${nonce}`);
  const lost = await waitUntil(() => harness.inspect('[data-testid="chat-run-status"]'), (nodes) => nodes[0]?.dataset.status === 'failed');
  const identity = await chatIdentity(harness);
  const terminal = await loopbackJson(`/chat/state?conversationId=${encodeURIComponent(identity.conversationId)}`);
  check('runtime loss is offline/failed with RUNTIME_LOST and never a confirmed stop',
    terminal.connection === 'offline' && terminal.runs.some((run) => run.error?.code === 'RUNTIME_LOST') && lost[0].dataset.stopConfirmed === 'false');
  await capture('fixture-runtime-lost');

  await control('/__qa/runtime-ready', {});
  const accountThread = await newQaThread(harness, `QA same-provider account ${nonce}`);
  await sendFromComposer(harness, `EGDESK_QA_STOP account-a-${nonce}`);
  const accountA = await waitUntil(fixtureState, state => state.runs.some(run => run.clientThreadId === accountThread.wireClientThreadId && run.status === 'running'));
  const accountARun = accountA.runs.find(run => run.clientThreadId === accountThread.wireClientThreadId);
  await control('/__qa/account-change', { variant: 'b' });
  const rotated = await waitUntil(() => chrome(harness, ({ id, previousBinding }) => {
    const api = window.__egdesk;
    const thread = api.state.codex.threads.find(item => item.id === id);
    const module = ChromeUtils.importESModule('chrome://userchrome/content/EGDeskChatState.sys.mjs');
    const reflected = thread && module.buildChatRequest(thread, 'QA reflection; not sent', 'qa-account-reflection', api.codexBridge.threadRuntimeConfig(id));
    const protocol = api.state.codex.chatProtocol;
    return { localId: thread?.id, binding: reflected?.clientThreadId, conversationId: thread?.conversationId || null,
      genericIdUnchanged: api.state.codex.authStatus.accountId === 'chatgpt',
      syntheticEmailB: api.state.codex.authStatus.accountEmail === 'qa-account-b@egdesk.invalid',
      bindingRotated: !!reflected?.clientThreadId && reflected.clientThreadId !== previousBinding,
      runs: Object.keys(protocol.runs).length, requests: Object.keys(protocol.requests).length,
      previousRunUnconfirmed: protocol.unobservedPreviousRun === true };
  }, { id: accountThread.id, previousBinding: accountThread.wireClientThreadId }),
  value => value.syntheticEmailB && value.bindingRotated && value.runs === 0 && value.requests === 0);
  check('email A to B resets the same-provider account despite generic accountId chatgpt',
    rotated.genericIdUnchanged && rotated.localId === accountThread.id && !rotated.conversationId && rotated.previousRunUnconfirmed);
  await selectQaThread(harness, accountThread);
  await visible(harness, '[data-testid="chat-binding-held"]');
  const retained = await chrome(harness, (id) => {
    const thread = window.__egdesk.state.codex.threads.find(item => item.id === id);
    return { reference: thread.retainedNativeBinding,
      rawMessages: thread.messages.map(message => message.content) };
  }, accountThread.id);
  check('held account-A room retains its transcript and old native reference',
    retained.reference?.conversationId === accountARun.conversationId &&
    retained.reference?.clientThreadId === accountThread.wireClientThreadId &&
    retained.rawMessages.includes(`EGDESK_QA_STOP account-a-${nonce}`));
  await harness.fill('[data-testid="chat-composer"]', 'QA unsent draft in retained account-A room');
  check('held transcript cannot submit under account B', (await harness.inspect('[data-testid="chat-send"]'))[0].disabled);
  await harness.click('[data-testid="chat-new-unbound-room"]');
  await visible(harness, '[data-testid="chat-composer"]');
  const accountBRoom = await chrome(harness, () => {
    const api = window.__egdesk;
    const thread = api.state.codex.threads.find(item => item.id === api.state.codex.activeThreadId);
    const module = ChromeUtils.importESModule('chrome://userchrome/content/EGDeskChatState.sys.mjs');
    const reflected = module.buildChatRequest(thread, 'QA reflection; not sent', 'qa-new-account-reflection', api.codexBridge.threadRuntimeConfig(thread.id));
    return { localThreadId: thread.id, wireClientThreadId: reflected.clientThreadId,
      conversationId: thread.conversationId || null, messageCount: thread.messages.length,
      bindingHeld: module.nativeBindingHeld(thread), profileEnabled: reflected.profileEnabled };
  });
  assertFreshAccountRoom({ localThreadId: accountThread.id, wireClientThreadId: accountThread.wireClientThreadId }, accountBRoom);
  check('explicit New Codex conversation creates an empty unbound account-B room', true);
  await sendFromComposer(harness, `EGDESK_QA_TEXT_ONLY account-b-${nonce}`);
  const accountB = await waitUntil(fixtureState, state => state.runs.some(run => run.clientThreadId === accountBRoom.wireClientThreadId && run.status === 'completed'));
  const accountBRun = accountB.runs.find(run => run.clientThreadId === accountBRoom.wireClientThreadId);
  check('new-room UI send uses a fresh account binding and conversation',
    accountBRun.conversationId !== accountARun.conversationId && accountBRun.clientThreadId !== accountThread.wireClientThreadId);
  check('account-change fixture required no logout request', accountB.observed.authWrites.length === 0);
  await capture('fixture-same-id-email-account-change');

  const authThread = await newQaThread(harness, `QA auth reset ${nonce}`);
  await sendFromComposer(harness, `EGDESK_QA_STOP auth-reset-${nonce}`);
  await waitUntil(fixtureState, state => state.runs.some(run => run.clientThreadId === authThread.wireClientThreadId && run.status === 'running'));
  // The activity refresh button is read-only (/chat/state) since bc47de6; reopening
  // the room is the explicit action that resumes its native conversation. Do it
  // while the room list still has its full height, before diagnostics take space.
  await control('/__qa/hold-resume', { hold: true });
  const heldBefore = (await fixtureState()).observed.heldResumes;
  await selectQaThread(harness, authThread);
  await waitUntil(fixtureState, state => state.observed.heldResumes > heldBefore);
  await control('/__qa/auth-diagnostics', {});
  await visible(harness, '.egd-codex-diagnostics-toggle');
  if (!(await harness.inspect('.egd-codex-diagnostics')).some(node => node.visible)) await harness.click('.egd-codex-diagnostics-toggle');
  const signoutSelector = '.egd-codex-diagnostics-actions button:last-child';
  check('fixture logout control is the actual rendered logout button', (await harness.inspect(signoutSelector))[0]?.text === '로그아웃');
  await fixtureState(); // Recheck exact fixture/profile binding immediately before logout.
  await harness.click(signoutSelector);
  const cacheState = () => chrome(harness, () => {
    const codex = window.__egdesk.state.codex;
    const protocol = codex.chatProtocol;
    return { loggedIn: codex.authStatus.isLoggedIn, runs: Object.keys(protocol.runs).length,
      requests: Object.keys(protocol.requests).length, streams: Object.keys(protocol.streams).length,
      conversations: codex.threads.filter(thread => thread.conversationId).length,
      previousRunUnconfirmed: protocol.unobservedPreviousRun === true };
  });
  const reset = await waitUntil(cacheState, state => !state.loggedIn && state.runs === 0 && state.requests === 0 && state.streams === 0);
  check('fixture logout clears protocol identities without claiming prior work stopped', reset.conversations === 0 && reset.previousRunUnconfirmed);
  await control('/__qa/release-resume', {});
  await new Promise(resolve => setTimeout(resolve, 350));
  const late = await cacheState();
  check('late pre-logout refresh cannot repopulate the cleared account cache', !late.loggedIn && late.runs === 0 && late.requests === 0 && late.streams === 0 && late.conversations === 0);
  check('only the fixture server received logout', (await fixtureState()).observed.authWrites.length === 1);
  await capture('fixture-auth-reset-late-refresh');
});
