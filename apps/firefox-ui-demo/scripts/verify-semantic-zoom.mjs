#!/usr/bin/env node
// Attach-only QA for a NEW dedicated Firefox profile on 2828. Main starts and
// stops Firefox. This script never sends a provider turn or visits a network URL.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { FirefoxMcpChatHarness, assertQaEvidenceDirectory, resolveQaMarionettePort,
  waitUntil } from './firefox-mcp-chat-harness.mjs';
import { assertQaProfile } from './egdesk-chat-qa-profile.mjs';

const USAGE = 'Usage: node verify-semantic-zoom.mjs --profile /canonical/egdesk-chat-test-* --port 2828 --output-dir /canonical/egdesk-chat-evidence-*';
function required(name) {
  const args = process.argv.slice(2);
  const index = args.indexOf(name);
  if (index < 0 || index === args.length - 1 || args.indexOf(name, index + 1) >= 0) throw new Error(USAGE);
  return args[index + 1];
}
function localOutput(directory, name) {
  const target = path.join(assertQaEvidenceDirectory(directory), name);
  if (fs.existsSync(target)) throw new Error(`Refusing to overwrite QA evidence: ${target}`);
  return target;
}
function saveJson(directory, name, value) {
  const target = localOutput(directory, name);
  fs.writeFileSync(target, `${JSON.stringify(value, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
  return target;
}
async function screenshotInto(harness, directory, name) {
  const source = await harness.screenshot(name);
  const target = localOutput(directory, `${name}.png`);
  fs.copyFileSync(source, target, fs.constants.COPYFILE_EXCL);
  return target;
}

// This is executed in the actual Firefox browser-chrome document through the
// profile-bound MCP transport, not against an HTML replica of the Desk.
export const OBSERVE = `() => {
  const api = window.__egdesk;
  const qa = window.__egdeskSemanticQa;
  if (!api?.semantic?.snapshot || !qa?.ids) throw new Error('Real semantic overlay or owned fixture registry is missing');
  const state = api.state;
  const semantic = api.semantic.snapshot();
  const saved = api.deskSession.serialize();
  const savedById = new Map((saved?.cards || []).map(card => [card.id, card]));
  const tabStopSelector = 'a[href], area[href], button, input, select, textarea, iframe, browser, [tabindex], [contenteditable="true"]';
  const rect = node => {
    if (!node) return null;
    const r = node.getBoundingClientRect();
    return { x: r.x, y: r.y, width: r.width, height: r.height, cx: r.x + r.width / 2, cy: r.y + r.height / 2 };
  };
  const visible = node => {
    if (!node || rect(node).width <= 0 || rect(node).height <= 0) return false;
    for (let ancestor = node; ancestor; ancestor = ancestor.parentElement) {
      const style = getComputedStyle(ancestor);
      if (style.display === 'none' || style.visibility === 'hidden' || style.visibility === 'collapse'
          || Number(style.opacity) === 0) return false;
    }
    return true;
  };
  const cards = qa.ids.map(id => {
    const card = document.getElementById(id);
    const original = qa.nodes.get(id);
    const browser = card?._xulBrowser || null;
    let scroll = null;
    let scrollError = null;
    if (browser) {
      try {
        const content = browser.contentWindow;
        if (Number.isFinite(content?.scrollX) && Number.isFinite(content?.scrollY)) {
          scroll = { x: content.scrollX, y: content.scrollY };
        } else scrollError = 'remote content scroll not exposed to chrome';
      } catch (error) { scrollError = error.message || String(error); }
    }
    const proxy = [...document.querySelectorAll('.egd-semantic-proxy[data-view-id]')]
      .find(node => node.dataset.viewId === id);
    const icon = proxy?.querySelector('.egd-semantic-icon');
    const label = proxy?.querySelector('.egd-semantic-label');
    const originalChildren = card ? [...card.children].filter(node => node !== proxy && !node.contains(proxy)) : [];
    const controls = originalChildren.flatMap(node => [
      ...(node.matches?.(tabStopSelector) ? [node] : []), ...node.querySelectorAll(tabStopSelector),
    ]);
    let proxyInheritedAriaHidden = false;
    for (let ancestor = proxy; ancestor; ancestor = ancestor.parentElement) {
      if (ancestor.getAttribute('aria-hidden') === 'true') proxyInheritedAriaHidden = true;
      if (ancestor === card) break;
    }
    return { id, ownedNodeIntact: card === original?.card,
      chatBodyIntact: original?.chatBody ? card?.querySelector('.egd-chat-card-body') === original.chatBody : null,
      kind: semantic.cards.find(item => item.id === id)?.kind || null,
      level: card?.dataset.egdSemanticLevel || null, semantic: semantic.cards.find(item => item.id === id) || null,
      worldStyle: card ? { x: card.style.left, y: card.style.top, width: card.style.width,
        height: card.style.height, zIndex: card.style.zIndex } : null,
      persisted: savedById.get(id) || null,
      accessibility: card ? { ariaHidden: card.getAttribute('aria-hidden'),
        originalChildAria: originalChildren.map(node => node.getAttribute('aria-hidden')),
        originalAxViolations: originalChildren.filter(node => node.getAttribute('aria-hidden') !== 'true').length,
        controlCount: controls.length,
        tabStopViolations: controls.filter(node => node.getAttribute('tabindex') !== '-1').length,
        proxyInheritedAriaHidden, proxyTabIndex: proxy?.tabIndex ?? null,
        addressTabIndex: card.querySelector('.egd-card-url')?.getAttribute('tabindex') ?? null,
        browserTabIndex: browser?.getAttribute('tabindex') ?? null,
        focusInsideOriginal: originalChildren.some(node => node === document.activeElement
          || node.contains(document.activeElement)),
        proxyFocused: proxy === document.activeElement } : null,
      browser: browser ? { sameNode: browser === original?.browser,
        browsingContextId: browser.browsingContext?.id || null,
        innerWindowId: browser.browsingContext?.currentWindowGlobal?.innerWindowId || null,
        uri: browser.currentURI?.spec || card._browserState?.uri || null,
        viewport: { clientWidth: browser.clientWidth, clientHeight: browser.clientHeight,
          styleWidth: browser.style.width, styleHeight: browser.style.height },
        scroll, scrollError,
        chrome: { titlebarHeight: card.querySelector('.egd-desk-window-titlebar')?.offsetHeight || 0,
          toolbarHeight: card.querySelector('.egd-desk-window-toolbar')?.offsetHeight || 0,
          addressPresent: !!card.querySelector('.egd-card-url'),
          navPresent: !!card.querySelector('.egd-card-nav') } } : null,
      proxy: proxy ? { visible: visible(proxy), hiddenAttribute: proxy.hidden,
        level: proxy.dataset.lod, kind: proxy.dataset.kind,
        ariaLabel: proxy.getAttribute('aria-label') || '', title: label?.textContent || '',
        rect: rect(proxy), iconRect: rect(icon), titleRect: rect(label) } : null };
  });
  const clusters = [...document.querySelectorAll('.egd-semantic-cluster')]
    .filter(visible).map(node => ({ memberIds: (node.dataset.memberIds || '').split(',').filter(Boolean),
      count: Number(node.dataset.count), text: node.textContent?.trim() || '',
      ariaLabel: node.getAttribute('aria-label') || '', rect: rect(node) }));
  const viewport = document.getElementById('egd-canvas-viewport');
  const texture = viewport ? getComputedStyle(viewport, '::before') : null;
  return { chromeUri: document.location.href, hasDock: !!document.getElementById('egd-dock'),
    camera: { zoom: state.zoom, zoomTarget: state.zoomTarget,
      pan: { ...state.pan }, panTarget: { ...state.panTarget }, activeEntityId: state.activeEntityId },
    viewport: { width: window.innerWidth, height: window.innerHeight },
    semantic, cards, clusters,
    wood: texture ? { backgroundImage: texture.backgroundImage, backgroundPosition: texture.backgroundPosition,
      opacity: Number(texture.opacity), panX: viewport.style.getPropertyValue('--egd-camera-pan-x').trim(),
      panY: viewport.style.getPropertyValue('--egd-camera-pan-y').trim(),
      zoom: viewport.style.getPropertyValue('--egd-camera-zoom').trim() } : null };
}`;

function owned(observation, id) {
  const card = observation.cards.find(item => item.id === id);
  assert.ok(card, `owned Card ${id} is missing`);
  return card;
}
function assertStable(observation, baseline, ids) {
  assert.equal(observation.chromeUri, 'chrome://browser/content/browser.xhtml');
  assert.equal(observation.hasDock, true);
  assert.deepEqual(observation.browserActor, baseline.browserActor,
    'same-URI reload or Browser document/input loss crossed a semantic zoom stage');
  for (const id of ids) {
    const card = owned(observation, id);
    const first = owned(baseline, id);
    assert.equal(card.ownedNodeIntact, true, `${id} Card node was remounted`);
    assert.deepEqual(card.worldStyle, first.worldStyle, `${id} world geometry changed at LOD`);
    assert.deepEqual(card.persisted, first.persisted, `${id} persisted record changed at LOD`);
    if (first.browser) {
      assert.equal(card.browser.sameNode, true, `${id} Browser node was remounted`);
      assert.equal(card.browser.browsingContextId, first.browser.browsingContextId, `${id} browsing context changed`);
      assert.equal(card.browser.innerWindowId, first.browser.innerWindowId,
        `${id} inner document was reloaded within the same browsing context`);
      assert.equal(card.browser.uri, first.browser.uri, `${id} URI changed`);
      assert.deepEqual(card.browser.viewport, first.browser.viewport, `${id} Browser viewport changed`);
      if (first.browser.scroll && card.browser.scroll) {
        assert.deepEqual(card.browser.scroll, first.browser.scroll, `${id} Browser scroll changed`);
      }
    }
    const screen = card.semantic?.screen;
    const world = card.semantic?.world;
    assert.ok(screen && world, `${id} semantic geometry missing`);
    assert.ok(Math.abs(screen.x - (observation.camera.pan.x + world.x * observation.camera.zoom)) < 1);
    assert.ok(Math.abs(screen.y - (observation.camera.pan.y + world.y * observation.camera.zoom)) < 1);
  }
}
function assertLevel(observation, ids, level) {
  for (const id of ids) {
    const card = owned(observation, id);
    assert.equal(card.level, level, `${id} should project as ${level}`);
    assert.equal(card.semantic.level, level);
    assert.ok(card.proxy, `${id} proxy record missing`);
    assert.equal(card.proxy.level, level);
    assert.equal(card.proxy.kind, card.kind);
    assert.ok(card.proxy.ariaLabel.includes(card.kind) && card.proxy.ariaLabel.includes(card.proxy.title),
      `${id} proxy lost title/type accessibility`);
    if (level === 'detail') assert.equal(card.proxy.visible, false);
    else {
      assert.notEqual(card.accessibility.ariaHidden, 'true', `${id} proxy is hidden by its Card wrapper`);
      assert.equal(card.accessibility.originalAxViolations, 0, `${id} invisible original controls are exposed to AX`);
      assert.equal(card.accessibility.tabStopViolations, 0, `${id} invisible original retains keyboard tab stops`);
      assert.equal(card.accessibility.focusInsideOriginal, false, `${id} focus remained in invisible original`);
      assert.equal(card.accessibility.proxyInheritedAriaHidden, false, `${id} proxy is hidden from AX`);
      assert.ok(card.accessibility.proxyTabIndex >= 0, `${id} proxy is not keyboard reachable`);
    }
  }
}
function assertCenteredIcon(card) {
  const { rect, iconRect } = card.proxy || {};
  assert.ok(rect && iconRect, `${card.id} icon geometry missing`);
  assert.ok(Math.abs(rect.cx - iconRect.cx) <= 2, `${card.id} icon not horizontally centered`);
  assert.ok(Math.abs(rect.cy - iconRect.cy) <= 2, `${card.id} icon not vertically centered`);
}
function assertNonoverlap(a, b) {
  const x = Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x);
  const y = Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y);
  assert.ok(x <= 0 || y <= 0, 'independent visible marker/count controls overlap');
}

async function main() {
  if (process.argv.includes('--help')) { process.stdout.write(`${USAGE}\n`); return; }
  const profile = assertQaProfile(required('--profile'));
  const port = resolveQaMarionettePort(required('--port'));
  if (port !== 2828) throw new Error('Semantic QA attaches only to the explicitly selected new 2828 target; 2829 is reserved');
  const outputDir = assertQaEvidenceDirectory(required('--output-dir'));
  localOutput(outputDir, 'semantic-zoom-result.json');
  const result = { kind: 'real-firefox-semantic-zoom', profile, marionettePort: port,
    evidenceClass: 'profile-bound-live-chrome-and-screenshots', bridgeReadiness: 'not-tested',
    providerTurns: 'none', stages: [], unverified: [], ok: false };
  let harness;
  let baseline;
  let ids = [];
  let dataBrowserId = null;
  const capture = async name => {
    const observation = await harness.evaluateChrome(OBSERVE);
    if (dataBrowserId) {
      observation.browserActor = await harness.evaluateChrome(`async () => {
        const snapshot = await window.__egdesk.browserRuntime.agentSnapshot(${JSON.stringify(dataBrowserId)},
          { textLimit: 24, elementLimit: 24 });
        const input = (snapshot?.interactiveElements || []).find(item => item.tag === 'input' && item.label === 'QA field');
        return { source: snapshot?.inaccessible ? 'inaccessible' : 'browser-actor',
          url: snapshot?.url || null, inputValue: input?.value ?? null };
      }`);
    }
    const screenshot = await screenshotInto(harness, outputDir, name);
    result.stages.push({ name, observation, screenshot });
    return observation;
  };
  const setCamera = async zoom => harness.evaluateChrome(`() => {
    const state = window.__egdesk.state;
    const anchor = { x: window.innerWidth * .42, y: window.innerHeight * .46 };
    state.setCanvasViewportTarget({ zoom: ${zoom},
      pan: { x: anchor.x - 6000 * ${zoom}, y: anchor.y - 3000 * ${zoom} } }, { immediate: true });
    return { zoom: state.zoom, pan: state.pan };
  }`);
  try {
    harness = new FirefoxMcpChatHarness({ profile, marionettePort: port });
    await harness.connect();
    await waitUntil(() => harness.evaluateChrome(`() => ({ ready: !!window.__egdesk?.semantic?.snapshot,
      dock: !!document.getElementById('egd-dock') })`), value => value.ready && value.dock);
    const created = await harness.evaluateChrome(`() => {
      const api = window.__egdesk;
      if (window.__egdeskSemanticQa) throw new Error('Existing semantic QA fixture registry; refusing reuse');
      api.surface.enterDesk();
      if (api.state.surface.initialBrowserFocus || api.state.cardFullscreen) {
        throw new Error('QA requires the new profile Desk, not an unresolved fullscreen Card');
      }
      const existing = [...document.querySelectorAll('.egd-canvas-card')];
      if (existing.length > 1 || existing.some(card => {
        const uri = card._browserState?.uri || '';
        return !card.classList.contains('egd-browser-card')
          || (!uri.startsWith('chrome://userchrome/') && uri !== 'about:blank');
      })) {
        throw new Error('QA refuses a non-fresh profile with existing Canvas work');
      }
      const qa = { ids: [], nodes: new Map(), initialIds: existing.map(node => node.id) };
      window.__egdeskSemanticQa = qa;
      const pages = [
        'about:blank',
        'data:text/html;charset=utf-8,' + encodeURIComponent('<!doctype html><title>EGD semantic QA</title><body style="height:5000px"><label>QA field <input id="qa-input" aria-label="QA field"></label><p>Local Browser QA fixture</p></body>'),
        'about:blank',
      ];
      const coords = [[6000, 3000], [6750, 3000], [11000, 3000]];
      const ids = pages.map((uri, index) => {
        const card = api.cardRuntime.openBrowserCard(uri);
        card.style.left = coords[index][0] + 'px';
        card.style.top = coords[index][1] + 'px';
        qa.ids.push(card.id);
        qa.nodes.set(card.id, { card, browser: card._xulBrowser });
        return card.id;
      });
      return { ids, initialIds: qa.initialIds };
    }`);
    ids = created.ids;
    assert.equal(ids.length, 3);
    dataBrowserId = ids[1];
    // This invokes only the local Chat Card dock action, never its send control.
    await harness.click('#egd-dock .egd-dock-btn[data-id="chat"]');
    const chat = await harness.evaluateChrome(`() => {
      const qa = window.__egdeskSemanticQa;
      const card = document.getElementById(window.__egdesk.state.codex.chatCardEntityId);
      if (!card || qa.initialIds.includes(card.id) || qa.ids.includes(card.id)) throw new Error('Owned Chat Card was not created');
      card.style.left = '7500px';
      card.style.top = '3000px';
      qa.ids.push(card.id);
      qa.nodes.set(card.id, { card, browser: null, chatBody: card.querySelector('.egd-chat-card-body') });
      window.__egdesk.agenda.markDirty('semantic-qa-position', card);
      return card.id;
    }`);
    ids.push(chat);
    assert.ok(ids.every(id => /^[a-z0-9-]+$/i.test(id)), 'fixture IDs must be CSS-selector safe');
    const readyDocument = await waitUntil(() => harness.evaluateChrome(`async () => {
      const snapshot = await window.__egdesk.browserRuntime.agentSnapshot(${JSON.stringify(dataBrowserId)},
        { textLimit: 24, elementLimit: 24 });
      const browser = document.getElementById(${JSON.stringify(dataBrowserId)})?._xulBrowser;
      return { url: snapshot?.url || null, readyState: snapshot?.readyState || null,
        innerWindowId: browser?.browsingContext?.currentWindowGlobal?.innerWindowId || null,
        inputPresent: (snapshot?.interactiveElements || []).some(item => item.tag === 'input' && item.label === 'QA field') };
    }`), value => value.url?.startsWith('data:') && value.readyState === 'complete'
      && Number.isSafeInteger(value.innerWindowId)
      && value.innerWindowId > 0 && value.inputPresent,
    { timeoutMs: 15000, intervalMs: 150 });
    result.fixtureDocument = readyDocument;
    const fill = await harness.evaluateChrome(`async () => {
      const result = await window.__egdesk.browserRuntime.agentAct(${JSON.stringify(dataBrowserId)},
        { type: 'fill', selector: '#qa-input', value: 'semantic-input-preserved' },
        { record: false, settleMs: 0 });
      return { ok: result?.ok === true, error: result?.error || null };
    }`);
    assert.equal(fill.ok, true, fill.error || 'controlled Browser input fill failed');
    const scrolled = await harness.evaluateChrome(`async () => {
      const result = await window.__egdesk.browserRuntime.agentAct(${JSON.stringify(dataBrowserId)},
        { type: 'scroll', dy: 320 }, { record: false, settleMs: 0 });
      return { ok: result?.ok === true, error: result?.error || null };
    }`);
    assert.equal(scrolled.ok, true, scrolled.error || 'controlled Browser scroll failed');
    await setCamera(1);
    baseline = await waitUntil(() => harness.evaluateChrome(OBSERVE), value =>
      value.cards.length === 4 && value.cards.every(card => card.level === 'detail' && card.persisted),
    { timeoutMs: 15000, intervalMs: 100 });
    baseline = await capture('semantic-full-initial');
    assert.equal(baseline.browserActor?.source, 'browser-actor');
    assert.equal(baseline.browserActor?.url, readyDocument.url);
    assert.ok(Number.isSafeInteger(owned(baseline, dataBrowserId).browser.innerWindowId)
      && owned(baseline, dataBrowserId).browser.innerWindowId > 0,
    'Browser inner document identity must be a positive integer');
    assert.equal(owned(baseline, dataBrowserId).browser.innerWindowId, readyDocument.innerWindowId,
      'fixture inner document changed before baseline');
    assert.equal(baseline.browserActor?.inputValue, 'semantic-input-preserved');
    assertLevel(baseline, ids, 'detail');
    for (const id of ids) assert.notEqual(owned(baseline, id).accessibility.ariaHidden, 'true');
    for (const card of baseline.cards.filter(item => item.browser)) {
      assert.ok(card.browser.chrome.addressPresent && card.browser.chrome.navPresent);
      assert.ok(card.browser.chrome.titlebarHeight >= 27 && card.browser.chrome.titlebarHeight <= 31);
      assert.ok(card.browser.chrome.toolbarHeight >= 33 && card.browser.chrome.toolbarHeight <= 37);
    }
    await setCamera(.3);
    const outline = await capture('semantic-outline');
    assertStable(outline, baseline, ids);
    assertLevel(outline, ids, 'outline');
    for (const card of outline.cards.filter(item => item.proxy.visible)) {
      assertCenteredIcon(card);
      assert.ok(card.proxy.titleRect.y < card.proxy.rect.y + card.proxy.rect.height / 3,
        `${card.id} outline title is not near the upper edge`);
    }
    await setCamera(.08);
    const marker = await capture('semantic-marker');
    assertStable(marker, baseline, ids);
    assertLevel(marker, ids, 'marker');
    assert.equal(marker.clusters.filter(group => group.memberIds.some(id => ids.includes(id))).length, 0,
      'separate markers should not show an all-canvas count');
    const visibleMarkers = marker.cards.filter(item => item.proxy.visible);
    for (const card of visibleMarkers) assertCenteredIcon(card);
    for (let left = 0; left < visibleMarkers.length; left += 1) {
      for (let right = left + 1; right < visibleMarkers.length; right += 1) {
        assertNonoverlap(visibleMarkers[left].proxy.rect, visibleMarkers[right].proxy.rect);
      }
    }
    await harness.evaluateChrome(`() => {
      const card = window.__egdeskSemanticQa.nodes.get(${JSON.stringify(ids[1])}).card;
      card.style.display = 'none';
      window.__egdesk.semantic.refresh();
      return true;
    }`);
    const hiddenCard = await waitUntil(() => harness.evaluateChrome(OBSERVE), value =>
      value.cards.find(card => card.id === ids[1])?.proxy?.visible === false,
    { timeoutMs: 5000, intervalMs: 80 });
    assert.equal(owned(hiddenCard, ids[1]).proxy.visible, false,
      'a product-hidden original Card must not be resurrected as a proxy');
    await capture('semantic-hidden-original');
    await harness.evaluateChrome(`() => {
      const card = window.__egdeskSemanticQa.nodes.get(${JSON.stringify(ids[1])}).card;
      card.style.display = '';
      window.__egdesk.semantic.refresh();
      return true;
    }`);
    await waitUntil(() => harness.evaluateChrome(OBSERVE), value =>
      value.cards.find(card => card.id === ids[1])?.proxy?.visible === true,
    { timeoutMs: 5000, intervalMs: 80 });
    await setCamera(.04);
    const cluster = await capture('semantic-cluster');
    assertStable(cluster, baseline, ids);
    assertLevel(cluster, ids, 'marker');
    const near = [ids[0], ids[1], chat];
    const group = cluster.clusters.find(item => near.every(id => item.memberIds.includes(id)));
    assert.ok(group, 'nearby marker region did not form a cluster');
    assert.deepEqual([...group.memberIds].sort(), [...near].sort(), 'cluster included an unrelated Canvas Card');
    assert.equal(group.count, 3);
    assert.ok(group.ariaLabel.includes('3개') && group.text.includes('3개'));
    assert.equal(owned(cluster, ids[2]).proxy.visible, true, 'far Card must stay independently visible');
    for (const id of near) assert.equal(owned(cluster, id).proxy.visible, false, 'cluster member proxy should be hidden');
    assertNonoverlap(group.rect, owned(cluster, ids[2]).proxy.rect);
    assert.ok(baseline.wood.backgroundImage.includes('egdesk-desk-woodgrain.jpg'), 'wood asset CSS absent');
    assert.ok(baseline.wood.opacity > cluster.wood.opacity && cluster.wood.opacity > 0,
      'wood fade must respond to camera zoom');
    assert.equal(cluster.wood.panX, `${cluster.camera.pan.x}px`);
    assert.equal(cluster.wood.panY, `${cluster.camera.pan.y}px`);
    assert.equal(cluster.wood.zoom, String(cluster.camera.zoom));
    const woodAnchor = cluster.wood.backgroundPosition.split(',').at(-1)?.trim()
      .match(/^(-?[\d.]+)px\s+(-?[\d.]+)px$/);
    assert.ok(woodAnchor, 'wood texture position is not tied to Canvas pan');
    assert.ok(Math.abs(Number(woodAnchor[1]) - cluster.camera.pan.x) < 1);
    assert.ok(Math.abs(Number(woodAnchor[2]) - cluster.camera.pan.y) < 1);
    const loadedWood = await harness.evaluateChrome(`async () => {
      const value = getComputedStyle(document.getElementById('egd-canvas-viewport'), '::before').backgroundImage;
      const token = value.split('url(').at(-1)?.split(')')[0]?.trim();
      const url = token?.startsWith('"') || token?.startsWith("'") ? token.slice(1, -1) : token;
      if (!url || !/^(chrome|resource|file):/.test(url)) throw new Error('Wood URL is not a local Firefox resource');
      const img = new Image();
      img.src = url;
      await img.decode();
      return { url, width: img.naturalWidth, height: img.naturalHeight };
    }`);
    assert.ok(loadedWood.width > 0 && loadedWood.height > 0);
    result.woodAsset = loadedWood;
    await harness.evaluateChrome(`() => {
      const state = window.__egdesk.state;
      state.setCanvasPanTarget({ x: state.pan.x + 60, y: state.pan.y + 35 }, { immediate: true });
      return { ...state.pan };
    }`);
    const panned = await capture('semantic-panned-wood');
    assertStable(panned, baseline, ids);
    assert.equal(panned.camera.zoom, cluster.camera.zoom);
    assert.equal(panned.camera.pan.x, cluster.camera.pan.x + 60);
    assert.equal(panned.camera.pan.y, cluster.camera.pan.y + 35);
    assert.equal(panned.wood.panX, `${panned.camera.pan.x}px`);
    assert.equal(panned.wood.panY, `${panned.camera.pan.y}px`);
    const pannedWoodAnchor = panned.wood.backgroundPosition.split(',').at(-1)?.trim()
      .match(/^(-?[\d.]+)px\s+(-?[\d.]+)px$/);
    assert.ok(pannedWoodAnchor);
    assert.ok(Math.abs(Number(pannedWoodAnchor[1]) - panned.camera.pan.x) < 1);
    assert.ok(Math.abs(Number(pannedWoodAnchor[2]) - panned.camera.pan.y) < 1);
    assert.deepEqual(panned.clusters.find(item => item.memberIds.includes(ids[0]))?.memberIds.sort(),
      [...near].sort(), 'panning changed region membership');
    await setCamera(1);
    const restored = await capture('semantic-full-restored');
    assertStable(restored, baseline, ids);
    assertLevel(restored, ids, 'detail');
    for (const id of ids) {
      assert.equal(owned(restored, id).accessibility.ariaHidden,
        owned(baseline, id).accessibility.ariaHidden, `${id} AX state was not restored`);
      assert.deepEqual(owned(restored, id).accessibility.originalChildAria,
        owned(baseline, id).accessibility.originalChildAria, `${id} original child AX state was not restored`);
      assert.equal(owned(restored, id).accessibility.addressTabIndex,
        owned(baseline, id).accessibility.addressTabIndex, `${id} address tab stop was not restored`);
      assert.equal(owned(restored, id).accessibility.browserTabIndex,
        owned(baseline, id).accessibility.browserTabIndex, `${id} Browser tab stop was not restored`);
    }
    // Actual chrome buttons should refocus the same Views, not instantiate new ones.
    await setCamera(.04);
    await harness.click('.egd-semantic-cluster[data-count="3"]');
    await waitUntil(() => harness.evaluateChrome(`() => window.__egdesk.state.zoom`), zoom => zoom > .05,
      { timeoutMs: 10000, intervalMs: 80 });
    const clusterClick = await capture('semantic-cluster-click');
    assert.ok(clusterClick.camera.zoom > .04, 'cluster click did not focus its member region');
    assertStable(clusterClick, baseline, ids);
    await setCamera(.08);
    await harness.click(`.egd-semantic-proxy[data-view-id="${ids[0]}"]`);
    await waitUntil(() => harness.evaluateChrome(OBSERVE), value =>
      value.camera.zoom >= .75 && value.cards.find(card => card.id === ids[0])?.level === 'detail',
    { timeoutMs: 10000, intervalMs: 80 });
    const proxyClick = await capture('semantic-proxy-click');
    assert.ok(proxyClick.camera.zoom >= .75, 'single proxy did not restore readable View');
    assert.equal(proxyClick.camera.activeEntityId, ids[0]);
    for (const id of ids) assert.equal(owned(proxyClick, id).ownedNodeIntact, true);
    assert.deepEqual(owned(proxyClick, ids[0]).accessibility.originalChildAria,
      owned(baseline, ids[0]).accessibility.originalChildAria,
      'focused proxy did not restore original controls to AX');
    assert.equal(owned(proxyClick, ids[0]).accessibility.addressTabIndex,
      owned(baseline, ids[0]).accessibility.addressTabIndex);
    assert.deepEqual(proxyClick.browserActor, baseline.browserActor,
      'proxy focus changed the live inner document or edited input');
    for (const id of ids.filter(value => owned(baseline, value).browser)) {
      const before = owned(baseline, id).browser;
      const after = owned(proxyClick, id).browser;
      const originalWorld = owned(baseline, id).semantic.world;
      const focusedWorld = owned(proxyClick, id).semantic.world;
      assert.equal(after.sameNode, true);
      assert.equal(after.browsingContextId, before.browsingContextId);
      assert.equal(after.innerWindowId, before.innerWindowId);
      assert.equal(after.uri, before.uri);
      assert.deepEqual(after.viewport, before.viewport);
      assert.deepEqual(focusedWorld, originalWorld, `${id} world geometry changed on proxy focus`);
    }
    await harness.click(`#${ids[0]} .egd-card-url`);
    await harness.press('Control+-');
    await waitUntil(() => harness.evaluateChrome(`() => window.__egdesk.state.zoomTarget`),
      zoom => zoom < proxyClick.camera.zoomTarget - .01, { timeoutMs: 10000, intervalMs: 80 });
    const keyboardZoom = await capture('semantic-keyboard-zoom');
    assert.deepEqual(keyboardZoom.browserActor, baseline.browserActor,
      'focused URL keyboard zoom changed the live Browser document');
    assert.equal(owned(keyboardZoom, ids[0]).browser.sameNode, true);
    assert.equal(owned(keyboardZoom, dataBrowserId).browser.innerWindowId,
      owned(baseline, dataBrowserId).browser.innerWindowId);
    // Synthetic wheel routing probes the real chrome handlers; native touchpad
    // fidelity remains a Main visual/manual QA item, not a claim of this test.
    const wheel = await harness.evaluateChrome(`() => {
      const api = window.__egdesk, state = api.state, qa = window.__egdeskSemanticQa;
      const chat = qa.nodes.get(${JSON.stringify(chat)}).card;
      const browser = qa.nodes.get(${JSON.stringify(ids[0])}).card;
      const target = chat.querySelector('.egd-chat-card-body');
      const original = { zoom: state.zoom, pan: { ...state.pan } };
      const probe = active => {
        api.cardRuntime.focusCard(active ? chat : browser);
        state.resetWheelSession();
        const before = { ...state.panTarget };
        const event = new WheelEvent('wheel', { bubbles: true, cancelable: true, deltaY: 80 });
        target.dispatchEvent(event);
        const after = { ...state.panTarget };
        state.setCanvasViewportTarget(original, { immediate: true });
        return { defaultPrevented: event.defaultPrevented, moved: after.x !== before.x || after.y !== before.y };
      };
      return { inactive: probe(false), active: probe(true) };
    }`);
    assert.deepEqual(wheel.inactive, { defaultPrevented: true, moved: true });
    assert.deepEqual(wheel.active, { defaultPrevented: false, moved: false });
    result.syntheticWheelRouting = wheel;
    await harness.evaluateChrome(`() => {
      const api = window.__egdesk, qa = window.__egdeskSemanticQa;
      const front = qa.nodes.get(${JSON.stringify(ids[1])}).card;
      const back = qa.nodes.get(${JSON.stringify(chat)}).card;
      front.style.zIndex = '90000';
      back.style.left = '6850px';
      back.style.top = '3100px';
      back.style.width = '200px';
      back.style.height = '140px';
      back.style.zIndex = '40000';
      api.state.setCanvasViewportTarget({ zoom: 1,
        pan: { x: window.innerWidth * .25 - 6750, y: window.innerHeight * .25 - 3000 } },
      { immediate: true });
      return { frontId: front.id, backId: back.id };
    }`);
    await waitUntil(() => harness.evaluateChrome(OBSERVE), value =>
      value.cards.find(card => card.id === ids[1])?.level === 'detail'
        && value.cards.find(card => card.id === chat)?.level === 'outline',
    { timeoutMs: 5000, intervalMs: 80 });
    const mixedLod = await capture('semantic-mixed-lod-overlap');
    assert.equal(owned(mixedLod, ids[1]).browser.sameNode, true);
    assert.equal(owned(mixedLod, chat).chatBodyIntact, true,
      'background Chat runtime body was replaced during mixed LOD');
    assert.deepEqual(mixedLod.browserActor, baseline.browserActor,
      'foreground Browser inner document changed during mixed LOD');
    assert.equal(owned(mixedLod, dataBrowserId).browser.innerWindowId,
      owned(baseline, dataBrowserId).browser.innerWindowId);
    const overlap = await harness.evaluateChrome(`() => {
      const qa = window.__egdeskSemanticQa;
      const front = qa.nodes.get(${JSON.stringify(ids[1])}).card;
      const back = qa.nodes.get(${JSON.stringify(chat)}).card;
      const proxy = [...document.querySelectorAll('.egd-semantic-proxy[data-view-id]')]
        .find(node => node.dataset.viewId === back.id);
      if (!proxy) throw new Error('Background compact proxy is absent');
      const frontRect = front.getBoundingClientRect();
      const proxyRect = proxy.getBoundingClientRect();
      const x = proxyRect.left + proxyRect.width / 2;
      const y = proxyRect.top + proxyRect.height / 2;
      const hit = document.elementFromPoint(x, y);
      return { frontLevel: front.dataset.egdSemanticLevel, backLevel: back.dataset.egdSemanticLevel,
        frontZ: Number(front.style.zIndex), backZ: Number(back.style.zIndex),
        proxyCenterInFront: x >= frontRect.left && x <= frontRect.right
          && y >= frontRect.top && y <= frontRect.bottom,
        hitsFront: !!hit && front.contains(hit), hitsBack: !!hit && back.contains(hit),
        hitTag: hit?.localName || null, hitClass: typeof hit?.className === 'string' ? hit.className : null,
        proxyTabIndex: proxy.tabIndex, proxyAriaLabel: proxy.getAttribute('aria-label'),
        chatBodySameNode: back.querySelector('.egd-chat-card-body') === qa.nodes.get(back.id).chatBody };
    }`);
    assert.equal(overlap.frontLevel, 'detail');
    assert.equal(overlap.backLevel, 'outline');
    assert.ok(overlap.frontZ > overlap.backZ);
    assert.equal(overlap.proxyCenterInFront, true, 'mixed-LOD fixture failed to overlap');
    assert.equal(overlap.hitsFront, true, 'background compact proxy intercepted foreground Detail Browser');
    assert.equal(overlap.hitsBack, false);
    assert.equal(overlap.chatBodySameNode, true);
    assert.ok(overlap.proxyTabIndex >= 0 && overlap.proxyAriaLabel,
      'background proxy lost keyboard/AX affordance');
    const proxyCanFocus = await harness.evaluateChrome(`() => {
      const proxy = [...document.querySelectorAll('.egd-semantic-proxy[data-view-id]')]
        .find(node => node.dataset.viewId === ${JSON.stringify(chat)});
      proxy.focus({ preventScroll: true });
      return document.activeElement === proxy && proxy.tabIndex >= 0;
    }`);
    assert.equal(proxyCanFocus, true, 'compact background proxy cannot receive keyboard focus');
    result.mixedLodOverlap = overlap;
    result.unverified.push('Native touchpad wheel ownership and remote Browser content scroll require Main live/manual confirmation.');
    if (baseline.cards.some(card => card.browser && !card.browser.scroll)) {
      result.unverified.push('Remote Browser scroll offset was not exposed to privileged chrome; URI, browsing context and internal viewport were asserted.');
    }
    result.ok = true;
  } catch (error) {
    result.error = { message: error.message, stack: error.stack || '' };
    if (harness) {
      // A partial setup can have created safe Cards before its Chrome call
      // failed. Recover only the IDs in this run's in-memory registry.
      try {
        const recovered = await harness.evaluateChrome(`() => {
          const qa = window.__egdeskSemanticQa;
          if (!qa) return [];
          const chatId = window.__egdesk?.state?.codex?.chatCardEntityId;
          if (chatId && !qa.initialIds.includes(chatId) && !qa.ids.includes(chatId)) {
            const card = document.getElementById(chatId);
            if (card?.classList.contains('egd-chat-card')) {
              qa.ids.push(chatId);
              qa.nodes.set(chatId, { card, browser: null, chatBody: card.querySelector('.egd-chat-card-body') });
            }
          }
          return [...qa.ids];
        }`);
        if (recovered.length) ids = recovered;
      } catch (registryError) { result.registryError = registryError.message; }
    }
    if (harness && ids.length) {
      try { await capture('semantic-failure'); } catch (captureError) {
        result.captureError = captureError.message;
      }
    } else if (harness) {
      try { result.failureScreenshot = await screenshotInto(harness, outputDir, 'semantic-failure'); }
      catch (captureError) { result.captureError = captureError.message; }
    }
    process.exitCode = 1;
  } finally {
    // Save the full failure state and screenshots BEFORE touching any fixture.
    try {
      result.evidenceFile = saveJson(outputDir, 'semantic-zoom-result.json', result);
    } catch (error) {
      result.evidenceWriteError = error.message;
      process.exitCode = 1;
    }
    if (harness && ids.length && result.evidenceFile) {
      try {
        result.cleanup = await harness.evaluateChrome(`async () => {
          const qa = window.__egdeskSemanticQa;
          if (!qa) throw new Error('No owned fixture registry; cleanup refused');
          const removed = [];
          for (const id of [...qa.ids].reverse()) {
            const original = qa.nodes.get(id)?.card;
            if (!original || document.getElementById(id) !== original || qa.initialIds.includes(id)) {
              throw new Error('Cleanup refused a missing, replaced, or pre-existing Card: ' + id);
            }
            const closed = await window.__egdesk.cardRuntime.closeCard(original);
            if (closed !== true) throw new Error('Owned Card close was not confirmed: ' + id);
            removed.push(id);
          }
          delete window.__egdeskSemanticQa;
          return { removed };
        }`);
      } catch (error) {
        result.cleanupError = error.message;
        process.exitCode = 1;
      }
      try {
        saveJson(outputDir, 'semantic-zoom-cleanup.json', {
          cleanup: result.cleanup || null, error: result.cleanupError || null,
          evidenceFile: result.evidenceFile,
        });
      } catch (error) {
        result.cleanupEvidenceError = error.message;
        process.exitCode = 1;
      }
    } else if (ids.length && !result.evidenceFile) {
      result.cleanupSkipped = 'Evidence write failed; owned fixture Cards were left for Main to inspect.';
    }
    try { await harness?.close(); } catch (error) {
      result.mcpCloseError = error.message;
      process.exitCode = 1;
    }
    process.stdout.write(`${JSON.stringify({ ok: result.ok && !result.evidenceWriteError && !result.cleanupError
        && !result.cleanupEvidenceError && !result.mcpCloseError,
      evidenceFile: result.evidenceFile, outputDir, stages: result.stages.map(stage => stage.name),
      error: result.error?.message || result.evidenceWriteError || result.cleanupError
        || result.cleanupEvidenceError || result.mcpCloseError || null,
      cleanupSkipped: result.cleanupSkipped || null,
      unverified: result.unverified })}\n`);
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => { console.error(error.stack || error.message); process.exitCode = 1; });
}
