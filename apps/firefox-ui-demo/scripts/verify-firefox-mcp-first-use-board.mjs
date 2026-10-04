#!/usr/bin/env node
// Main boots the selected profile. This script never remounts or restarts it.
import { assertQaFixtureManifest } from './egdesk-chat-qa-profile.mjs';
import { assertNativeTerminalExit, recoveryMarkerMatches } from './egdesk-chat-qa-contract.sys.mjs';
import { attributeSelector, chrome, loopbackJson, option, runUiFlow, selectorForId, visible, waitUntil } from './egdesk-qa-ui-flow.mjs';

const scenario = option('--case', 'first-use');
const known = ['first-use', 'first-use-zoomout', 'board-open', 'board-reopen', 'board-close', 'board-collision', 'supported-views',
  'terminal-real-exit', 'terminal-unknown', 'recovery', 'recovery-restored'];
if (!known.includes(scenario)) throw new Error(`--case must be one of: ${known.join(', ')}`);
if (!['first-use', 'first-use-zoomout'].includes(scenario) && process.env.EGDESK_QA_STATE_FIXTURES !== '1') {
  throw new Error('Board/recovery fixtures require EGDESK_QA_STATE_FIXTURES=1');
}
if (scenario === 'terminal-real-exit' && process.env.EGDESK_QA_REAL_TERMINAL !== '1') {
  throw new Error('Native Terminal test requires EGDESK_QA_REAL_TERMINAL=1');
}

async function openBoard(harness, board) {
  if (!(await harness.inspect('#egd-agenda-switcher')).some((node) => node.visible)) {
    await harness.click('[aria-label="Board 목록"]');
  }
  await harness.fill('.egd-agenda-switch-search-input', board.title);
  await harness.click(`[data-testid="board-open"]${attributeSelector('data-board-id', board.id)}`);
  await visible(harness, `[data-testid="board-projection"]${attributeSelector('data-board-id', board.id)}`);
}

async function seedBoard(harness, supported = false) {
  return chrome(harness, ({ supported }) => {
    const api = window.__egdesk;
    if (api.surface.snapshot().mode !== 'desk') throw new Error('Enter Desk through its UI before Board fixtures');
    const id = `qa-board-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
    const title = `QA ${supported ? 'supported views' : 'Board'} ${id}`;
    const previous = [...document.querySelectorAll('.egd-canvas-card')].map((node) => ({ node, browser: node._xulBrowser }));
    const h = window.__egdeskBoardQa = { id, title, previous };
    if (supported) {
      const store = api.agenda.readStore();
      const cards = ['settings', 'terminal'].map((type, index) => ({ id: `${id}-${type}`, type,
        geometry: { x: 50 + index * 450, y: 110, width: 420, height: 350 }, sourceRef: {}, runtimeState: {} }));
      store.agendas[id] = { version: 1, savedAt: 1700000000000,
        agenda: { id, title, memberCardIds: cards.map((card) => card.id), contextBindings: [] }, cards, shapes: [] };
      store.meta[id] = { id, title, createdAt: 1700000000000, updatedAt: 1700000000000 };
      const services = globalThis.Services || ChromeUtils.importESModule('resource://gre/modules/Services.sys.mjs').Services;
      services.prefs.setStringPref(api.agenda.storagePref, JSON.stringify(store));
      h.sourceIds = cards.map((card) => card.id);
    } else {
      const a = api.cardRuntime.openBrowserCard('about:blank', { openMode: 'new' });
      const b = api.cardRuntime.openBrowserCard('about:blank', { openMode: 'new' });
      h.previous.push({ node: a, browser: a._xulBrowser }, { node: b, browser: b._xulBrowser });
      h.sourceIds = [a.id, b.id];
      api.agenda.save({ agendaId: id, title, memberIds: h.sourceIds, contextBindings: [] });
    }
    h.savedBefore = JSON.stringify(api.agenda.readStore().agendas[id]);
    return { id, title, sourceIds: h.sourceIds };
  }, { supported });
}

async function boardObservation(harness, boardId) {
  return chrome(harness, (id) => {
    const api = window.__egdesk;
    const h = window.__egdeskBoardQa;
    const projections = Object.values(api.boards.projections().projections).filter((item) => item.boardId === id);
    const projection = projections[0];
    return { projection, projectionCount: projections.length,
      previousIntact: h.previous.every(({ node, browser }) => node.isConnected && document.getElementById(node.id) === node && node._xulBrowser === browser),
      savedUnchanged: JSON.stringify(api.agenda.readStore().agendas[id]) === h.savedBefore,
      members: (projection?.members || []).map((member) => {
        const node = document.getElementById(member.viewId);
        return { ...member, exists: !!node, className: node?.className || '', width: node?.style.width || '',
          missing: node?.dataset.testid === 'board-missing-member' };
      }) };
  }, boardId);
}

await runUiFlow(`rendered-ui-${scenario}`, async ({ harness, check, capture, result }) => {
  const manifest = assertQaFixtureManifest(harness.profile);
  result.fixtureMode = ['first-use', 'first-use-zoomout'].includes(scenario) ? 'fresh-profile' : 'explicit-temp-state';
  if (scenario === 'recovery' || scenario === 'recovery-restored') {
    check('bootstrap contains an intentional recovery fixture', !!manifest.deskRecovery);
    const marker = `qa-recovery-new-${manifest.deskRecovery.kind}`;
    const observeRecovery = async () => {
      const observed = await chrome(harness, ({ prefName, raw }) => {
      const api = window.__egdesk;
      const services = globalThis.Services || ChromeUtils.importESModule('resource://gre/modules/Services.sys.mjs').Services;
      const backups = services.prefs.getChildList('egdesk.deskRecovery.v1.').map(key => {
        try { return { key, ...JSON.parse(services.prefs.getStringPref(key)) }; } catch { return null; }
      }).filter(record => record?.raw === raw);
      let current = null;
      try { current = JSON.parse(services.prefs.getStringPref(prefName, '')); } catch {}
      const source = value => ({ kind: value?.kind, scope: value?.scope, uri: value?.uri });
      const views = [...document.querySelectorAll('.egd-canvas-card')];
      return { backups: backups.map(record => ({ key: record.key, exact: record.raw === raw })),
        savedSources: (current?.cards || []).map(card => source(card.sourceRef)),
        mode: api.surface.snapshot().mode, views: views.map(node => ({ id: node.id, sourceRef: source(node._sourceRef) })),
        recoveryProtected: api.surface.snapshot().recoveryProtected === true,
        firstUse: !!document.querySelector('[data-testid="first-use-root"]') };
      }, manifest.deskRecovery);
      const { savedSources, views, ...state } = observed;
      return { ...state, currentHasNewWork: savedSources.some(source => recoveryMarkerMatches(source, marker)),
        views: views.filter(view => recoveryMarkerMatches(view.sourceRef, marker)).map(view => view.id) };
    };
    const initial = await observeRecovery();
    check('the exact damaged Desk bytes are retained in a recovery record', initial.backups.length >= 1 && initial.backups.every(item => item.exact));
    check('returning user remains on Desk', initial.mode === 'desk' && !initial.firstUse);
    if (scenario === 'recovery-restored') {
      check('new work survives Main-controlled restart', initial.currentHasNewWork && initial.views.length === 1 && !initial.recoveryProtected);
      await capture(`recovery-${manifest.deskRecovery.kind}-after-restart`);
      return;
    }
    await visible(harness, '[data-testid="desk-recovery"]');
    await chrome(harness, (scope) => {
      const api = window.__egdesk;
      const card = api.cardRuntime.openBrowserCard('about:blank', { openMode: 'new',
        sourceRef: { kind: 'browser-url', scope, uri: 'about:blank' } });
      window.__egdeskRecoveryQa = { card, browser: card._xulBrowser };
      return card.id;
    }, marker);
    await waitUntil(observeRecovery, state => state.currentHasNewWork);
    await harness.click('[data-testid="recovery-retry"]');
    const identity = await chrome(harness, () => {
      const fixture = window.__egdeskRecoveryQa;
      return fixture.card.isConnected && document.getElementById(fixture.card.id) === fixture.card && fixture.card._xulBrowser === fixture.browser;
    });
    check('retry preserves the new work and its Browser object', identity);
    await harness.click('[data-testid="recovery-continue"]');
    await waitUntil(() => harness.inspect('[data-testid="desk-recovery"]'), nodes => nodes.length === 0);
    const continued = await waitUntil(observeRecovery, state => state.currentHasNewWork && !state.recoveryProtected);
    check('continue keeps the original backup key and saves new work', initial.backups.every(original => continued.backups.some(saved => saved.key === original.key && saved.exact)) && continued.views.length === 1);
    result.restartVerification = 'Main may restart this same profile, then run --case recovery-restored';
    await capture(`recovery-${manifest.deskRecovery.kind}`);
    await chrome(harness, () => { delete window.__egdeskRecoveryQa; return true; });
    return;
  }
  check('profile has no recovery fixture for normal UI cases', !manifest.deskRecovery);

  if (scenario === 'first-use' || scenario === 'first-use-zoomout') {
    const observe = () => chrome(harness, () => {
      const api = window.__egdesk;
      const snapshot = api.surface.snapshot();
      const card = document.getElementById(snapshot.browserCardId) || document.querySelector('.egd-browser-card');
      const browser = card?._xulBrowser;
      const rect = card?.getBoundingClientRect();
      const viewport = document.getElementById('egd-canvas-viewport')?.getBoundingClientRect();
      const identity = window.__egdeskFirstUseQa;
      const visible = node => {
        if (!node) return false;
        const bounds = node.getBoundingClientRect(), style = getComputedStyle(node);
        return bounds.width > 0 && bounds.height > 0 && style.display !== 'none' && style.visibility !== 'hidden';
      };
      return { mode: snapshot.mode, cardId: card?.id || null, browser: !!browser,
        sameCardNode: identity ? card === identity.card : null,
        sameBrowserObject: identity ? browser === identity.browser : null,
        uri: card && (api.browserRuntime.state(card.id)?.uri || browser?.currentURI?.spec || null),
        logicalWidth: browser?.clientWidth || 0, logicalHeight: browser?.clientHeight || 0,
        fixedLogicalHeight: card?._fixedLogicalHeight ?? null,
        zoom: api.state.zoomTarget, activeEntityId: api.state.activeEntityId,
        focusedCardId: api.state.cardFullscreen?.cardId || api.state.activeEntityId || null,
        cardRect: rect && { left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom,
          width: rect.width, height: rect.height },
        viewportRect: viewport && { left: viewport.left, top: viewport.top, width: viewport.width, height: viewport.height },
        windowSize: { width: window.innerWidth, height: window.innerHeight },
        canvasVisible: !!viewport && viewport.width > 0 && viewport.height > 0,
        shellVisible: ['egd-desk-rail', 'egd-preset-bag', 'egd-dock'].map(id => visible(document.getElementById(id))),
        separateFirstUse: !!document.querySelector('[data-testid="first-use-root"]'),
        mandatoryDeskEntry: !!document.getElementById('egd-desk-entry') };
    });
    if (scenario === 'first-use') {
      await visible(harness, '#egd-canvas-viewport');
      const initial = await waitUntil(observe, value => value.mode === 'desk' && value.browser
        && value.logicalWidth > 0 && value.logicalHeight > 0 && !!value.uri);
      check('first launch is the actual live Desk Canvas, not a separate start screen',
        initial.canvasVisible && !initial.separateFirstUse && !initial.mandatoryDeskEntry);
      check('one Browser card starts in an immersive focus, not a crowded Desk overview',
        !!initial.cardId && initial.focusedCardId === initial.cardId
          && initial.cardRect.left >= -12 && initial.cardRect.left <= initial.windowSize.width * 0.03
          && initial.cardRect.top >= -12 && initial.cardRect.top <= initial.windowSize.height * 0.03
          && initial.cardRect.right >= initial.windowSize.width * 0.97
          && initial.cardRect.right <= initial.windowSize.width + 12
          && initial.cardRect.bottom >= initial.windowSize.height * 0.97
          && initial.cardRect.bottom <= initial.windowSize.height + 12
          && initial.shellVisible.every(value => !value),
        { card: initial.cardRect, window: initial.windowSize,
          focusedCardId: initial.focusedCardId, shellVisible: initial.shellVisible });
      await chrome(harness, () => {
        const api = window.__egdesk;
        const card = document.getElementById(api.surface.snapshot().browserCardId) || document.querySelector('.egd-browser-card');
        window.__egdeskFirstUseQa = { card, browser: card._xulBrowser,
          uri: api.browserRuntime.state(card.id)?.uri || card._xulBrowser?.currentURI?.spec || null,
          logicalWidth: card._xulBrowser?.clientWidth, logicalHeight: card._xulBrowser?.clientHeight,
          fixedLogicalHeight: card._fixedLogicalHeight ?? null,
          cardWidth: card.getBoundingClientRect().width, zoom: api.state.zoomTarget };
      });
      result.nextStep = 'Main performs a normal native Ctrl+wheel/pinch zoom-out without restarting Firefox, then runs --case first-use-zoomout.';
      await capture('first-use-live-browser-focused');
      return;
    }
    const after = await observe();
    const before = await chrome(harness, () => {
      const identity = window.__egdeskFirstUseQa;
      return identity && { cardId: identity.card?.id, uri: identity.uri,
        logicalWidth: identity.logicalWidth, logicalHeight: identity.logicalHeight,
        fixedLogicalHeight: identity.fixedLogicalHeight, cardWidth: identity.cardWidth, zoom: identity.zoom };
    });
    check('the same first-use Browser session is still held in this Firefox window', !!before);
    check('normal Desk zoom-out reveals surrounding Canvas without a mode transition',
      after.mode === 'desk' && after.canvasVisible && !after.separateFirstUse && !after.mandatoryDeskEntry
        && after.shellVisible.every(Boolean)
        && after.zoom < before.zoom - 0.001
        && after.cardRect.width < before.cardWidth - 80
        && after.cardRect.height < after.windowSize.height - 80,
      { before: { zoom: before.zoom, cardWidth: before.cardWidth },
        after: { zoom: after.zoom, card: after.cardRect, shellVisible: after.shellVisible } });
    check('zoom-out retains the exact Browser card, browsing object, URL and logical viewport',
      after.cardId === before.cardId && after.sameCardNode && after.sameBrowserObject
        && after.uri === before.uri && after.logicalWidth === before.logicalWidth
        && after.logicalHeight === before.logicalHeight && after.fixedLogicalHeight === before.fixedLogicalHeight,
      { before, after });
    await capture('first-use-same-browser-after-zoomout');
    await chrome(harness, () => { delete window.__egdeskFirstUseQa; return true; });
    return;
  }

  if (scenario === 'terminal-real-exit') {
    const health = await loopbackJson('/health');
    check('native Terminal case is connected to a real helper', health.ok === true && health.fixture !== true);
  }
  if (scenario === 'terminal-unknown') {
    const token = process.env.EGDESK_QA_FIXTURE_TOKEN;
    if (process.env.EGDESK_QA_FIXTURE_TRANSPORT !== '1' || !token) throw new Error('Unknown-exit case requires the explicit fixture server');
    const state = await loopbackJson('/__qa/state', { token });
    check('unknown-exit transport is bound to this test profile', state.fixture === true && state.profile === harness.profile);
    await loopbackJson('/__qa/terminal-mode', { method: 'POST', token, body: { mode: 'unknown' } });
  }
  const terminalCase = ['supported-views', 'terminal-real-exit', 'terminal-unknown'].includes(scenario);
  const board = await seedBoard(harness, terminalCase);
  await openBoard(harness, board);
  const opened = await boardObservation(harness, board.id);
  check('Board opening preserves Saved Board bytes and all pre-existing views', opened.savedUnchanged && opened.previousIntact);
  check('Board opens one projection with the requested members', opened.projectionCount === 1 && opened.members.length === 2);
  const projectionId = opened.projection.id;

  if (scenario === 'board-reopen') {
    const [closedMember, survivor] = opened.members;
    await chrome(harness, (id) => {
      const h = window.__egdeskBoardQa;
      const node = document.getElementById(id);
      node.style.width = `${parseFloat(node.style.width) + 23}px`;
      window.__egdesk.agenda.markDirty('qa-controlled-unsaved-geometry', node);
      h.survivor = { node, browser: node._xulBrowser, width: node.style.width };
      return true;
    }, survivor.viewId);
    await harness.click(`${selectorForId(closedMember.viewId)} .egd-card-dot-close`);
    check('member close action removed the requested view', (await harness.inspect(selectorForId(closedMember.viewId))).length === 0);
    await openBoard(harness, board);
    const reopened = await boardObservation(harness, board.id);
    const identity = await chrome(harness, () => {
      const saved = window.__egdeskBoardQa.survivor;
      const current = document.getElementById(saved.node.id);
      return { sameNode: current === saved.node, sameBrowser: current?._xulBrowser === saved.browser, sameWidth: current?.style.width === saved.width };
    });
    check('explicit reopen recovers the absent member without duplicating the projection',
      reopened.projectionCount === 1 && reopened.projection.id === projectionId && reopened.members.every((member) => member.exists));
    check('surviving unsaved view and Browser object are preserved', identity.sameNode && identity.sameBrowser && identity.sameWidth);
    check('reopen preserves Saved Board bytes', reopened.savedUnchanged);
  } else if (scenario === 'board-close') {
    await harness.click(`[data-testid="board-close"]${attributeSelector('data-projection-id', projectionId)}`);
    const closed = await waitUntil(() => boardObservation(harness, board.id), (state) => state.projectionCount === 0);
    check('normal clean Board close removes only its projection and owned views',
      closed.projectionCount === 0 && (await harness.inspect(attributeSelector('data-projection-id', projectionId))).length === 0);
    check('Saved Board and unrelated live views survive close', closed.savedUnchanged && closed.previousIntact);
  } else if (scenario === 'board-collision') {
    const member = opened.members[0];
    await chrome(harness, ({ projectionId, member }) => {
      const api = window.__egdesk;
      const projection = api.state.boards.projections[projectionId];
      projection.bindings = [{ viewId: member.viewId, resourceId: member.viewId,
        url: `file:///qa/${member.viewId}`, text: member.viewId, [member.viewId]: 'external-object-key' }];
      api.agenda.markDirty('qa-controlled-reference-collision', document.getElementById(member.viewId));
      return true;
    }, { projectionId, member });
    await harness.click(`[data-testid="board-save"]${attributeSelector('data-projection-id', projectionId)}`);
    const binding = await chrome(harness, (id) => window.__egdesk.agenda.readStore().agendas[id].agenda.contextBindings[0], board.id);
    check('only the schema view reference is mapped back to the source member', binding.viewId === member.sourceId);
    check('colliding external resource ID, URL, text and object key survive save',
      binding.resourceId === member.viewId && binding.text === member.viewId &&
      binding.url === `file:///qa/${member.viewId}` && binding[member.viewId] === 'external-object-key');
  } else if (terminalCase) {
    const settings = opened.members.find((member) => member.record.type === 'settings');
    const terminal = opened.members.find((member) => member.record.type === 'terminal');
    check('saved Settings view restores actual Settings UI', !!settings && settings.className.includes('egd-settings-card') && !settings.missing);
    const terminalRoot = selectorForId(terminal.viewId);
    await visible(harness, `${terminalRoot} [data-testid="board-new-terminal"]`);
    const dormant = await chrome(harness, (id) => {
      const node = document.getElementById(id);
      return { live: !!node?.querySelector('iframe')?.contentWindow?.terminalAPI?.isConnected?.() };
    }, terminal.viewId);
    check('restored Terminal does not claim a past PTY is alive', !dormant.live);
    if (scenario === 'supported-views') {
      result.terminalAcceptance = 'Restored GUI and explicit new-session action only; no PTY spawned. Use terminal-real-exit for full acceptance.';
      await capture('supported-views-dormant-terminal');
      await chrome(harness, () => { delete window.__egdeskBoardQa; return true; });
      return;
    }
    await harness.click(`${terminalRoot} [data-testid="board-new-terminal"]`);
    const live = await waitUntil(() => chrome(harness, (id) => {
      const api = document.getElementById(id)?.querySelector('iframe')?.contentWindow?.terminalAPI;
      return { connected: !!api?.isConnected?.(), ptyId: api?.ptyId || null };
    }, terminal.viewId), (state) => state.connected && !!state.ptyId);
    check('explicit new-session click creates a working Terminal', live.connected && !!live.ptyId);
    await chrome(harness, (id) => {
      window.__egdeskBoardQa.terminalApi = document.getElementById(id).querySelector('iframe').contentWindow.terminalAPI;
      return true;
    }, terminal.viewId);
    if (scenario === 'terminal-real-exit') {
      const marker = `EGDESK_QA_TTY_${Date.now().toString(36)}`;
      const escaped = [...Buffer.from(`${marker}\n`)].map(byte => `\\${byte.toString(8).padStart(3, '0')}`).join('');
      await harness.click(`${terminalRoot} iframe`);
      await harness.typeText(`printf '${escaped}'`, { submitKey: 'Enter' });
      const output = await waitUntil(() => chrome(harness, (needle) => {
        const api = window.__egdeskBoardQa.terminalApi;
        return { count: api.bufferText().split(needle).length - 1, inputEvents: api.dataEventCount() };
      }, marker), state => state.count > 0);
      check('one native printf command produces exactly one marker', output.count === 1 && output.inputEvents > 0);
      await capture('terminal-printf');
    }
    {
      await harness.click(`[data-testid="board-close"]${attributeSelector('data-projection-id', projectionId)}`);
      if ((await harness.inspect('#egd-agenda-close-guard')).some(node => node.visible)) {
        await harness.click('#egd-agenda-close-guard [data-action="discard"]');
      }
      if (scenario === 'terminal-unknown') {
        const state = await waitUntil(() => chrome(harness, () => window.__egdeskBoardQa.terminalApi.closeState()),
          value => ['unknown', 'offline', 'timeout'].includes(value.phase), { timeoutMs: 15000 });
        check('unknown exit leaves the Terminal card and Board visible', state.phase !== 'confirmed' &&
          (await harness.inspect(terminalRoot)).some(node => node.visible) && (await boardObservation(harness, board.id)).projectionCount === 1);
      } else {
        await waitUntil(() => boardObservation(harness, board.id), value => value.projectionCount === 0, { timeoutMs: 20000 });
        const response = await loopbackJson('/terminal/read', { method: 'POST', body: { sessionId: live.ptyId }, includeHttpStatus: true });
        check('native exit read returned HTTP 200', response.httpStatus === 200);
        const receipt = response.body;
        assertNativeTerminalExit(receipt, live.ptyId);
        check('Board close has an independent native PTY exit receipt', receipt.exitSource === 'pty.onExit');
        result.nativeExit = { httpStatus: response.httpStatus, status: receipt.status,
          sessionId: receipt.sessionId, exitConfirmed: receipt.exitConfirmed, exitSource: receipt.exitSource,
          exitedAt: receipt.exitedAt, exitCode: receipt.exitCode, signal: receipt.signal };
        const closed = await boardObservation(harness, board.id);
        check('Terminal Board close retains Saved Board and unrelated views', closed.savedUnchanged && closed.previousIntact);
      }
    }
  }
  await capture(scenario);
  await chrome(harness, () => { delete window.__egdeskBoardQa; return true; });
});
