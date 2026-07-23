#!/usr/bin/env node

import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';

const MCP_PACKAGE = process.env.EGDESK_FIREFOX_MCP_PACKAGE || '@mozilla/firefox-devtools-mcp-moz@latest';
const MCP_BIN = process.env.EGDESK_FIREFOX_MCP_BIN || '';
const MARIONETTE_PORT = process.env.EGDESK_MARIONETTE_PORT || '2828';
const SCREENSHOT_PATH = process.argv[2] || '/tmp/egdesk-ontology-card-verify.png';
const jsSourcePath = fileURLToPath(new URL('../overlay/JS/eg-desk-surface.uc.js', import.meta.url));
const cssSourcePath = fileURLToPath(new URL('../overlay/CSS/eg-desk-surface.uc.css', import.meta.url));
const graphSourcePath = fileURLToPath(new URL('../overlay/resources/ontology/graph.json', import.meta.url));
const jsSourceUrl = pathToFileURL(jsSourcePath).href;
const cssText = readFileSync(cssSourcePath, 'utf8');
const expectedGraph = JSON.parse(readFileSync(graphSourcePath, 'utf8'));

const proc = MCP_BIN
  ? spawn(MCP_BIN, [
  '--connectExisting',
  '--marionettePort',
  MARIONETTE_PORT,
  '--enablePrivilegedContext',
  '--enableScript',
], { stdio: ['pipe', 'pipe', 'pipe'] })
  : spawn('npx', [
  '-y',
  MCP_PACKAGE,
  '--connectExisting',
  '--marionettePort',
  MARIONETTE_PORT,
  '--enablePrivilegedContext',
  '--enableScript',
], { stdio: ['pipe', 'pipe', 'pipe'] });

let nextId = 1;
let stdoutBuffer = '';
let stderrBuffer = '';
const pending = new Map();

proc.stdout.on('data', (chunk) => {
  stdoutBuffer += chunk.toString();
  let index;
  while ((index = stdoutBuffer.indexOf('\n')) >= 0) {
    const line = stdoutBuffer.slice(0, index).trim();
    stdoutBuffer = stdoutBuffer.slice(index + 1);
    if (!line.startsWith('{')) continue;

    const message = JSON.parse(line);
    if (message.id && pending.has(message.id)) {
      const { resolve, reject } = pending.get(message.id);
      pending.delete(message.id);
      if (message.error) reject(new Error(JSON.stringify(message.error)));
      else resolve(message.result);
    }
  }
});

proc.stderr.on('data', (chunk) => {
  stderrBuffer += chunk.toString();
});

proc.on('exit', (code, signal) => {
  for (const { reject } of pending.values()) {
    reject(new Error(`MCP server exited code=${code} signal=${signal}`));
  }
  pending.clear();
});

function request(method, params = {}, timeoutMs = 15000) {
  const id = nextId++;
  proc.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');

  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error(`Timeout waiting for ${method}`));
    }, timeoutMs);

    pending.set(id, {
      resolve: (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      reject: (error) => {
        clearTimeout(timer);
        reject(error);
      },
    });
  });
}

function notify(method, params = {}) {
  proc.stdin.write(JSON.stringify({ jsonrpc: '2.0', method, params }) + '\n');
}

function resultText(result) {
  return (result.content || []).map((item) => item.text || '').join('\n');
}

function parseToolJson(text) {
  const trimmed = String(text || '').trim();
  if (trimmed.startsWith('Error:')) throw new Error(trimmed);
  // firefox-devtools-mcp >= 0.7: result JSON is wrapped in a ```json fence
  const fenced = trimmed.match(/```json\s*\n([\s\S]*?)\n```/);
  if (fenced) return JSON.parse(fenced[1]);
  const jsonText = trimmed.startsWith('Result:')
    ? trimmed.slice('Result:'.length).trim()
    : trimmed;
  return JSON.parse(jsonText);
}

async function callTool(name, args = {}, timeoutMs = 15000) {
  let toolArgs = args;
  // firefox-devtools-mcp >= 0.7: evaluate_privileged_script takes `function`
  // (callable string) instead of `expression`. Wrap legacy IIFE expressions.
  if (name === 'evaluate_privileged_script' && typeof toolArgs.expression === 'string') {
    toolArgs = { function: `() => (\n${toolArgs.expression}\n)` };
  }
  return request('tools/call', { name, arguments: toolArgs }, timeoutMs);
}

async function main() {
  await request('initialize', {
    protocolVersion: '2024-11-05',
    capabilities: {},
    clientInfo: { name: 'egdesk-firefox-mcp-ontology-card-verify', version: '0.1.0' },
  }, 60000);
  notify('notifications/initialized');

  const contexts = await callTool('list_privileged_contexts', {}, 60000);
  const contextText = resultText(contexts);
  const contextMatch = contextText.match(/\s([0-9a-f-]{36}): chrome:\/\/browser\/content\/browser\.xhtml/);
  if (!contextMatch) {
    throw new Error(`Firefox chrome context not found.\n${contextText}`);
  }

  await callTool('select_privileged_context', { contextId: contextMatch[1] }, 30000);

  const remountText = resultText(await callTool('evaluate_privileged_script', {
    expression: `(async () => {
      const cleanupEntity = (node) => {
        try { if (typeof node._cleanup === 'function') node._cleanup(); } catch {}
        node.remove();
      };
      document.querySelectorAll('.egd-canvas-card, .egd-canvas-shape').forEach(cleanupEntity);
      [
        '#egd-desk-rail',
        '#egd-dock',
        '#egd-preset-bag',
        '#egd-hud',
        '#egd-canvas-viewport',
        '#egd-selection-marquee',
        '#egd-zoom-indicator',
        '#egd-input-helper-status',
        '#egd-desk-minimap',
      ].forEach((selector) => document.querySelectorAll(selector).forEach((node) => node.remove()));

      let style = document.getElementById('egd-ontology-live-style');
      if (!style) {
        style = document.createElementNS('http://www.w3.org/1999/xhtml', 'style');
        style.id = 'egd-ontology-live-style';
        document.documentElement.appendChild(style);
      }
      // firefox-devtools-mcp >= 0.7: 함수 문자열 16KB 상한 — CSS는 privileged
    // context에서 직접 로드 (IOUtils — sync XHR은 file://에 NetworkError)
    style.textContent = await IOUtils.readUTF8(${JSON.stringify(cssSourcePath)});

      window.__egdesk = undefined;
      const ServicesRef = globalThis.Services || ChromeUtils.importESModule('resource://gre/modules/Services.sys.mjs').Services;
      ServicesRef.scriptloader.loadSubScript(${JSON.stringify(jsSourceUrl)}, window, 'UTF-8');

      return {
        hasApi: !!window.__egdesk?.cardRuntime?.openOntologyMapCard,
        hasRail: !!document.getElementById('egd-desk-rail'),
      };
    })()`,
  }, 30000));
  const remount = parseToolJson(remountText);
  if (!remount.hasApi || !remount.hasRail) {
    throw new Error(`Overlay remount failed: ${JSON.stringify(remount, null, 2)}`);
  }

  const checkText = resultText(await callTool('evaluate_privileged_script', {
    expression: `(async () => {
      const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
      const api = window.__egdesk;
      if (!api?.cardRuntime?.openOntologyMapCard) {
        return { hasApi: false };
      }
      const card = api.cardRuntime.openOntologyMapCard({
        selectedRefId: 'present.server',
        activePane: 'present',
        activeLayer: 'virtual',
      });
      await wait(1000);
      const visualMetricsFor = (node) => {
        if (!node?.isConnected) return { visible: false, opacity: 0, rect: null };
        let opacity = 1;
        let hidden = false;
        let current = node;
        while (current?.nodeType === Node.ELEMENT_NODE) {
          const style = getComputedStyle(current);
          if (style.display === 'none' || style.visibility === 'hidden' || style.visibility === 'collapse') hidden = true;
          const ownOpacity = Number.parseFloat(style.opacity);
          if (Number.isFinite(ownOpacity)) opacity *= ownOpacity;
          if (current === card) break;
          current = current.parentElement;
        }
        const rect = node.getBoundingClientRect();
        const viewport = card.querySelector('.egd-ontology-stage')?.getBoundingClientRect();
        const inViewport = !viewport || !(rect.right < viewport.left || rect.left > viewport.right || rect.bottom < viewport.top || rect.top > viewport.bottom);
        return { visible: !hidden && opacity > 0.05 && inViewport, opacity, rect };
      };
      const isVisibleNode = (node) => {
        const metrics = visualMetricsFor(node);
        return metrics.visible && metrics.rect.width > 8 && metrics.rect.height > 8;
      };
      const isVisibleStroke = (node) => {
        const metrics = visualMetricsFor(node);
        const style = getComputedStyle(node);
        const colorAlpha = (color) => {
          const value = String(color || '').trim().toLowerCase();
          if (!value || value === 'none' || value === 'transparent') return 0;
          const slash = value.match(/\\/\\s*([\\d.]+)%?\\s*\\)$/);
          if (slash) return slash[0].includes('%') ? Number(slash[1]) / 100 : Number(slash[1]);
          const rgba = value.match(/^rgba\\([^,]+,[^,]+,[^,]+,\\s*([\\d.]+)\\s*\\)$/);
          return rgba ? Number(rgba[1]) : 1;
        };
        const strokeOpacity = Number.parseFloat(style.strokeOpacity);
        let length = 0;
        try { length = node.getTotalLength(); } catch {}
        return metrics.visible
          && Number.parseFloat(style.strokeWidth) > 0
          && metrics.opacity * (Number.isFinite(strokeOpacity) ? strokeOpacity : 1) * colorAlpha(style.stroke) > 0.05
          && length > 1;
      };
      const visibleCount = (selector, predicate) => [...card.querySelectorAll(selector)].filter(predicate).length;
      const visibleEndpoint = (sourceId, targetId) => [...card.querySelectorAll('[data-source-id][data-target-id]')]
        .some((path) => path.dataset.sourceId === sourceId && path.dataset.targetId === targetId && isVisibleStroke(path));
      const detailText = card.querySelector('.egd-ontology-detail')?.textContent || '';
      const sceneMap = card._ontologyGraph?.nodes?.find((node) => node.id === card._ontologyState?.sceneMapId);
      const homeNodeIds = new Set((sceneMap?.viewCells || []).map((cell) => cell.node));
      const visibleDeckNodeElements = [...card.querySelectorAll('.egd-ontology-deck-node')].filter(isVisibleNode);
      const semanticRoutes = [...card.querySelectorAll('.egd-ontology-depth-connector, .egd-ontology-inventory-relation, .egd-ontology-temporal-object-link')]
        .filter(isVisibleStroke);
      const minimap = card.querySelector('.egd-ontology-minimap');
      const minimapTools = [...card.querySelectorAll('.egd-ontology-stage-mini-tool')];
      const layerDepthFor = (id) => Number(card.querySelector('.egd-ontology-deck-node[data-id="' + id + '"]')?.dataset.layerDepth);
      const stageRect = card.querySelector('.egd-ontology-stage')?.getBoundingClientRect();
      const activePaneRect = card.querySelector('.egd-ontology-time-coordinate-active')?.getBoundingClientRect();
      const selectedRef = card._ontologyState?.selectedRefId;
      const graphOccurrences = card._ontologyGraph?.occurrences || [];
      const directChildren = graphOccurrences.filter((occurrence) => occurrence.parentRef === selectedRef);
      const activeLayer = card._ontologyState?.activeLayer;
      const mainDirectChildren = directChildren.filter((occurrence) => occurrence.layer === activeLayer);
      const expectedPips = directChildren.reduce((sum, child) => (
        sum + graphOccurrences.filter((occurrence) => occurrence.parentRef === child.refId).length
      ), 0);
      const byRef = new Map(graphOccurrences.map((occurrence) => [occurrence.refId, occurrence]));
      const activePlaneRoots = graphOccurrences.filter((occurrence) => {
        if (occurrence.timeSlice !== card._ontologyState?.activePane) return false;
        const parent = occurrence.parentRef ? byRef.get(occurrence.parentRef) : null;
        return !parent || parent.timeSlice !== occurrence.timeSlice || parent.snapshotId !== occurrence.snapshotId;
      });
      const expectedOverviewRoots = activePlaneRoots.filter((occurrence) => occurrence.refId !== selectedRef);
      const expectedOverviewPips = expectedOverviewRoots.reduce((sum, occurrence) => (
        sum + graphOccurrences.filter((candidate) => candidate.parentRef === occurrence.refId).length
      ), 0);
      const sidePaneCounts = Object.fromEntries(['past', 'future'].map((phase) => [
        phase,
        card.querySelectorAll('.egd-ontology-v2-box-side[data-phase="' + phase + '"]').length,
      ]));
      const sideLabel = card.querySelector('.egd-ontology-v2-box-side[data-phase="future"] .egd-ontology-v2-label');
      const activeLayerSurface = card.querySelector('.egd-ontology-time-coordinate-active .egd-ontology-v2-layer-surface-active');
      const activeLayerFill = activeLayerSurface ? getComputedStyle(activeLayerSurface).fill : '';
      const referenceEdgeKeys = new Set((card._ontologyGraph?.referenceEdges || []).map((edge) => edge.sourceRef + '|' + edge.relation + '|' + edge.targetRef));
      const renderedEdges = [...card.querySelectorAll('.egd-ontology-v2-reference-edges .egd-ontology-v2-edge[data-source-ref]')];
      const liveStyle = document.getElementById('egd-ontology-live-style');
      const cssRules = liveStyle?.sheet ? [...liveStyle.sheet.cssRules] : [];
      return {
        hasApi: true,
        cardId: card.id,
        graphSchemaVersion: card._ontologyGraph?.schemaVersion || 0,
        graphSourceHash: card._ontologyGraph?.sourceHash || '',
        nodeCount: card._ontologyGraph?.nodes?.length || 0,
        edgeCount: card._ontologyGraph?.edges?.length || 0,
        visibleNodeCount: visibleCount('.egd-ontology-node', isVisibleNode),
        timeCoordinateCount: card.querySelectorAll('.egd-ontology-time-coordinate').length,
        outerTimeDeckCount: card.querySelectorAll('.egd-ontology-v2-deck-surface').length,
        deckPaneCount: card.querySelectorAll('.egd-ontology-deck-pane').length,
        physicalPaneCount: card.querySelectorAll('.egd-ontology-physical-pane').length,
        timeAxisArrowCount: card.querySelectorAll('.egd-ontology-time-axis-arrow').length,
        paneInventoryNodeCount: visibleCount('.egd-ontology-pane-inventory-node', isVisibleNode),
        depthHitCount: card.querySelectorAll('.egd-ontology-depth-hit').length,
        stratumRailCount: card.querySelectorAll('.egd-ontology-stratum-rail-dot').length,
        depthConnectorCount: visibleCount('.egd-ontology-depth-connector', isVisibleStroke),
        inventoryRelationCount: visibleCount('.egd-ontology-inventory-relation', isVisibleStroke),
        temporalObjectLinkCount: visibleCount('.egd-ontology-temporal-object-link', isVisibleStroke),
        terminalCpu: visibleEndpoint('terminal', 'cpu'),
        terminalRam: visibleEndpoint('terminal', 'ram'),
        terminalDisk: visibleEndpoint('terminal', 'disk'),
        contextMessage: visibleEndpoint('projection.llm_chat_session.intent.context_binding', 'projection.llm_chat_session.action.message_send'),
        sessionFileDisk: visibleEndpoint('projection.llm_chat_session.storage.session_file', 'disk'),
        allVisibleNodesHaveHomeCell: visibleDeckNodeElements.every((node) => homeNodeIds.has(node.dataset.id)),
        canonicalNodesAreIdentityAnchors: visibleDeckNodeElements
          .filter((node) => card._ontologyGraph?.nodes?.find((graphNode) => graphNode.id === node.dataset.id)?.type === 'canonical_entity')
          .every((node) => node.dataset.viewRole === 'identity_anchor'),
        derivedLayerDepths: {
          desktop: layerDepthFor('desktop'),
          terminal: layerDepthFor('terminal'),
        },
        allSemanticRoutesBackedByGraph: semanticRoutes.every((route) => (
          route.dataset.edgeId
          && card._ontologyGraph?.edges?.some((edge) => edge.id === route.dataset.edgeId)
        )),
        minimap: {
          count: card.querySelectorAll('.egd-ontology-minimap').length,
          activePane: minimap?.dataset.activePane || '',
          activeStratum: minimap?.dataset.activeStratum || '',
          zoom: Number(minimap?.dataset.zoom),
          zoomLabel: card.querySelector('.egd-ontology-stage-zoom-label')?.textContent?.trim() || '',
          layerPaneCount: card.querySelectorAll('.egd-ontology-minimap-layer-pane').length,
          activeTimeCount: card.querySelectorAll('.egd-ontology-minimap-time-active').length,
          activeLayerCount: card.querySelectorAll('.egd-ontology-minimap-layer-pane-active').length,
          bandHitCount: card.querySelectorAll('.egd-ontology-minimap-band-hit').length,
          nodeCount: card.querySelectorAll('.egd-ontology-minimap-node').length,
          expectedNodeCount: homeNodeIds.size,
          selectedNodeCount: card.querySelectorAll('.egd-ontology-minimap-node-selected').length,
          toolCount: minimapTools.length,
          toolsInteractive: minimapTools.every((tool) => !tool.disabled && getComputedStyle(tool).pointerEvents !== 'none'),
        },
        focusTarget: card._ontologyState?.focusTarget || null,
        activePane: card._ontologyState?.activePane || null,
        activeStratum: card._ontologyState?.activeStratum || card._ontologyState?.activeDepth || null,
        hasKoreanLabels: /현재/.test(card.querySelector('.egd-ontology-stage')?.textContent || '')
          && /채팅 세션/.test(card.querySelector('.egd-ontology-stage')?.textContent || '')
          && /현재 시간대/.test(detailText)
          && /정보/.test(detailText),
        hasGraphDerivedPanel: /실제 연결 경로/.test(detailText) && /객체 수/.test(detailText) && /관계 수/.test(detailText),
        hasDetailTitle: !!card.querySelector('.egd-ontology-detail-title')?.textContent?.trim(),
        mode: card._ontologyState?.mode,
        selectedId: card._ontologyState?.selectedId || null,
        hasSourceRef: card._sourceRef?.kind === 'ontology-map',
        dirty: api.state.agenda.dirty,
        snapshotCount: card._ontologyGraph?.snapshots?.length || 0,
        occurrenceCount: card._ontologyGraph?.occurrences?.length || 0,
        referenceEdgeCount: card._ontologyGraph?.referenceEdges?.length || 0,
        selectedRefId: selectedRef || null,
        selectedConceptId: card._ontologyState?.selectedConceptId || null,
        activeLayer: card._ontologyState?.activeLayer || null,
        layerPaneCount: card.querySelectorAll('.egd-ontology-v2-layer-pane').length,
        activeCoordinateLayerPaneCount: card.querySelectorAll('.egd-ontology-time-coordinate-active .egd-ontology-v2-layer-surface').length,
        rootCompositeCount: card.querySelectorAll('.egd-ontology-v2-box-root').length,
        rootLabelAnchor: card.querySelector('.egd-ontology-v2-box-root .egd-ontology-v2-label-root')?.getAttribute('text-anchor') || '',
        rootLegendGapCount: card.querySelectorAll('.egd-ontology-v2-box-root .egd-ontology-v2-legend-gap').length,
        directChildCount: card.querySelectorAll('.egd-ontology-v2-box[data-phase="present"]:not(.egd-ontology-v2-box-root):not(.egd-ontology-v2-box-context):not(.egd-ontology-v2-box-side):not(.egd-ontology-v2-box-overview)').length,
        expectedDirectChildCount: mainDirectChildren.length,
        crossLayerContextRefs: [...card.querySelectorAll('.egd-ontology-v2-box-context[data-phase="present"]')]
          .map((node) => node.dataset.refId),
        pipCount: card.querySelectorAll('.egd-ontology-v2-box:not(.egd-ontology-v2-box-overview) .egd-ontology-v2-pip').length,
        expectedPipCount: expectedPips,
        overviewCount: card.querySelectorAll('.egd-ontology-v2-box-overview[data-phase="present"]').length,
        expectedOverviewCount: expectedOverviewRoots.length,
        overviewPipCount: card.querySelectorAll('.egd-ontology-v2-box-overview .egd-ontology-v2-pip').length,
        expectedOverviewPipCount: expectedOverviewPips,
        emptyPastBoxCount: card.querySelectorAll('.egd-ontology-v2-box[data-phase="past"]').length,
        syntheticEmptyBoxCount: card.querySelectorAll('.egd-ontology-v2-box[data-ref-id^="empty."]').length,
        planeShadowCount: card.querySelectorAll('.egd-ontology-v2-layer-shadow').length,
        behindSurfaceCount: card.querySelectorAll('.egd-ontology-v2-layer-surface-behind, .egd-ontology-v2-side-layer-behind').length,
        behindContextCount: card.querySelectorAll('.egd-ontology-v2-box-context.egd-ontology-v2-box-behind').length,
        behindContextOpacity: Number(getComputedStyle(card.querySelector('.egd-ontology-v2-box-context.egd-ontology-v2-box-behind') || card).opacity),
        frontOcclusionCount: card.querySelectorAll('.egd-ontology-v2-layer-occlusion').length,
        frontOcclusionFill: getComputedStyle(card.querySelector('.egd-ontology-v2-layer-occlusion') || card).fill,
        coupledCameraKeys: Object.keys(card._ontologyState?.cameraByCell || {}),
        temporalEdgeAnchorViolations: [...card.querySelectorAll('.egd-ontology-v2-edge-temporal')].filter((edge) => !(
          edge.dataset.paneClipped === 'true'
          && ((edge.dataset.sourceAnchor === 'right' && edge.dataset.targetAnchor === 'left')
            || (edge.dataset.sourceAnchor === 'left' && edge.dataset.targetAnchor === 'right'))
        )).length,
        layerEdgeAnchorViolations: [...card.querySelectorAll('.egd-ontology-v2-edge-layer')].filter((edge) => !(
          edge.dataset.sourceAnchor === 'depth'
          && edge.dataset.targetAnchor === 'depth'
          && edge.getAttribute('stroke-dasharray')
          && Math.abs(Number(edge.dataset.depthDy)) > 8
          && Math.abs(Number(edge.dataset.depthDx)) <= 1
        )).length,
        unknownRenderedEdgeCount: renderedEdges.filter((edge) => !referenceEdgeKeys.has(edge.dataset.sourceRef + '|' + edge.dataset.relation + '|' + edge.dataset.targetRef)).length,
        edgeLabelCount: card.querySelectorAll('.egd-ontology-v2-edge-label').length,
        sidePaneCounts,
        bundleLabels: [...card.querySelectorAll('.egd-ontology-v2-bundle-label')].map((node) => node.textContent.trim()),
        v2TimeArrowCount: card.querySelectorAll('.egd-ontology-v2-time-axis-arrow').length,
        sideLabelPresent: !!sideLabel?.textContent?.trim(),
        activeCoordinateWidthRatio: stageRect?.width ? activePaneRect.width / stageRect.width : 0,
        activeLayerFill,
        liveStyleLength: liveStyle?.textContent?.length || 0,
        liveStyleRuleCount: cssRules.length,
        hasV2CssRule: cssRules.some((rule) => rule.selectorText?.includes('.egd-ontology-v2-layer-pane')),
        hasSearch: !!card.querySelector('.egd-ontology-search-shell'),
        hasInspector: !!card.querySelector('.egd-ontology-detail'),
        deskChromeVisible: ['#egd-desk-rail', '#egd-dock'].every((selector) => {
          const node = document.querySelector(selector);
          return node && getComputedStyle(node).display !== 'none';
        }),
        globalFocusClassAbsent: !document.documentElement.classList.contains('egd-ontology-focus-active'),
        v2MinimapLayerPaneCount: card.querySelectorAll('.egd-ontology-minimap-layer-pane').length,
        v2MinimapViewportCount: card.querySelectorAll('.egd-ontology-minimap-viewport').length,
      };
    })()`,
  }, 30000));

  const check = parseToolJson(checkText);
  const shellCheck = parseToolJson(resultText(await callTool('evaluate_privileged_script', {
    expression: `(() => {
      const card = document.querySelector('.egd-ontology-card');
      return {
        mounted: card.classList.contains('egd-desk-window') && card._deskWindowShell?.root === card,
        kind: card.dataset.deskWindowKind || '',
        inputPolicy: card.dataset.deskWindowInputPolicy || '',
        titlebarCount: card.querySelectorAll('.egd-desk-window-titlebar').length,
        identityCount: card.querySelectorAll('.egd-desk-window-identity').length,
        toolbarCount: card.querySelectorAll('.egd-desk-window-toolbar').length,
        progressCount: card.querySelectorAll('.egd-desk-window-progress').length,
        resizeHandleCount: card.querySelectorAll('.egd-card-resize-hit').length,
        minimizeDisabled: card.querySelector('.egd-card-dot-min')?.getAttribute('aria-disabled') === 'true',
        maximizeInteractive: card.querySelector('.egd-card-dot-max')?.getAttribute('role') === 'button',
        titlebarHeight: card.querySelector('.egd-desk-window-titlebar')?.getBoundingClientRect().height || 0,
        cardRect: (() => { const rect = card.getBoundingClientRect(); return { top: rect.top, bottom: rect.bottom, width: rect.width, height: rect.height }; })(),
        stageRect: (() => { const rect = card.querySelector('.egd-ontology-stage')?.getBoundingClientRect(); return rect ? { top: rect.top, bottom: rect.bottom, height: rect.height } : null; })(),
        dockTop: document.getElementById('egd-dock')?.getBoundingClientRect().top || null,
      };
    })()`,
  }, 30000)));
  const boundaryCheck = parseToolJson(resultText(await callTool('evaluate_privileged_script', {
    expression: `(() => {
      const card = document.querySelector('.egd-ontology-card');
      const points = (node) => {
        const values = (node?.getAttribute('d')?.match(/-?\\d+(?:\\.\\d+)?/g) || []).map(Number);
        return Array.from({ length: Math.floor(values.length / 2) }, (_, index) => ({ x: values[index * 2], y: values[index * 2 + 1] }));
      };
      const distance = (point, start, end) => {
        const dx = end.x - start.x;
        const dy = end.y - start.y;
        const length = Math.hypot(dx, dy);
        return length > 0.001
          ? Math.abs(dy * point.x - dx * point.y + end.x * start.y - end.y * start.x) / length
          : Infinity;
      };
      const routes = [...card.querySelectorAll('.egd-ontology-v2-edge-temporal')].map((edge) => {
        const [leftPhase, rightPhase, layer] = String(edge.dataset.temporalBoundaryKey || '').split('|');
        const surface = leftPhase && layer
          ? card.querySelector('.egd-ontology-time-coordinate-' + leftPhase + ' .egd-ontology-v2-layer-pane[data-layer="' + layer + '"]')
          : null;
        const boundary = points(surface);
        const route = points(edge);
        const entryDistance = boundary.length >= 4 && route.length === 4 ? distance(route[1], boundary[1], boundary[2]) : Infinity;
        const exitDistance = boundary.length >= 4 && route.length === 4 ? distance(route[2], boundary[1], boundary[2]) : Infinity;
        return {
          key: edge.dataset.temporalBoundaryKey || '',
          leftPhase,
          rightPhase,
          layer,
          aligned: edge.dataset.temporalBoundaryAligned === 'true',
          pointCount: route.length,
          entryDistance,
          exitDistance,
          followsSlantedBoundary: route.length === 4 && Math.abs(route[1].x - route[2].x) > 0.5,
        };
      });
      return {
        count: routes.length,
        violations: routes.filter((route) => !route.aligned || route.pointCount !== 4 || route.entryDistance > 1.5 || route.exitDistance > 1.5).length,
        routes,
      };
    })()`,
  }, 30000)));
  const minimapLegendCheck = parseToolJson(resultText(await callTool('evaluate_privileged_script', {
    expression: `(() => {
      const card = document.querySelector('.egd-ontology-card');
      const context = card.querySelector('.egd-ontology-minimap-context');
      const legend = card.querySelector('.egd-ontology-minimap-legend');
      const map = card.querySelector('.egd-ontology-minimap-map');
      const panes = [...card.querySelectorAll('.egd-ontology-minimap-layer-pane')];
      const nodes = [...card.querySelectorAll('.egd-ontology-minimap-node')];
      const viewBox = map?.viewBox?.baseVal;
      const paneBoxes = panes.map((pane) => pane.getBBox());
      const union = paneBoxes.length ? paneBoxes.reduce((bounds, box) => ({
        x: Math.min(bounds.x, box.x),
        y: Math.min(bounds.y, box.y),
        right: Math.max(bounds.right, box.x + box.width),
        bottom: Math.max(bounds.bottom, box.y + box.height),
      }), { x: Infinity, y: Infinity, right: -Infinity, bottom: -Infinity }) : null;
      return {
        contextTitle: card.querySelector('.egd-ontology-minimap-context-title')?.textContent?.trim() || '',
        contextCoordinate: card.querySelector('.egd-ontology-minimap-context-coordinate')?.textContent?.trim() || '',
        legendText: [...(legend?.querySelectorAll('.egd-ontology-minimap-legend-item') || [])].map((node) => node.textContent.trim()).join('|'),
        legendSwatchCount: card.querySelectorAll('.egd-ontology-minimap-legend-swatch').length,
        overlaysPassClicks: [context, legend].every((node) => node && getComputedStyle(node).pointerEvents === 'none'),
        scope: map?.dataset.scope || '',
        phase: map?.dataset.phase || '',
        panePhases: [...new Set(panes.map((pane) => pane.dataset.phase))],
        nodePhases: [...new Set(nodes.map((node) => node.dataset.phase))],
        plotCoverage: union && viewBox ? {
          width: (union.right - union.x) / viewBox.width,
          height: (union.bottom - union.y) / viewBox.height,
        } : { width: 0, height: 0 },
      };
    })()`,
  }, 30000)));
  const stackCheckText = resultText(await callTool('evaluate_privileged_script', {
    expression: `(() => {
      const card = document.querySelector('.egd-ontology-card');
      const virtualSurface = card.querySelector('.egd-ontology-time-coordinate-active .egd-ontology-v2-layer-surface-virtual');
      const physicalSurface = card.querySelector('.egd-ontology-time-coordinate-active .egd-ontology-v2-layer-surface-physical');
      const virtualBox = virtualSurface?.getBBox();
      const physicalBox = physicalSurface?.getBBox();
      const physicalRect = physicalSurface?.getBoundingClientRect();
      const dockRect = document.getElementById('egd-dock')?.getBoundingClientRect();
      const trailingContextBox = card.querySelector('.egd-ontology-v2-box-context .egd-ontology-v2-box-path')?.getBBox();
      const depthOffset = virtualBox && physicalBox
        ? { x: physicalBox.x - virtualBox.x, y: physicalBox.y - virtualBox.y }
        : { x: NaN, y: NaN };
      const overlap = virtualBox && physicalBox ? {
        width: Math.max(0, Math.min(virtualBox.x + virtualBox.width, physicalBox.x + physicalBox.width) - Math.max(virtualBox.x, physicalBox.x)),
        height: Math.max(0, Math.min(virtualBox.y + virtualBox.height, physicalBox.y + physicalBox.height) - Math.max(virtualBox.y, physicalBox.y)),
      } : { width: 0, height: 0 };
      const points = (phase) => {
        const d = card.querySelector('.egd-ontology-time-coordinate-' + phase + ' .egd-ontology-v2-side-layer-virtual')?.getAttribute('d') || '';
        const values = (d.match(/-?\\d+(?:\\.\\d+)?/g) || []).map(Number);
        return values.length >= 8 ? [0, 1, 2, 3].map((i) => ({ x: values[i * 2], y: values[i * 2 + 1] })) : null;
      };
      const slant = (phase) => {
        const p = points(phase);
        return p ? Math.abs((p[2].x + p[3].x - p[0].x - p[1].x) / 2) : NaN;
      };
      const timePlaneTilt = (phase) => {
        const p = points(phase);
        if (!p) return null;
        return {
          topDy: p[1].y - p[0].y,
          bottomDy: p[2].y - p[3].y,
        };
      };
      return {
        depthOffset,
        cameraClipPath: card.querySelector('.egd-ontology-v2-camera')?.getAttribute('clip-path') || '',
        depthEdgeClipPath: card.querySelector('.egd-ontology-v2-depth-edges')?.getAttribute('clip-path') || '',
        activeNodeClipPath: card.querySelector('.egd-ontology-v2-active-nodes')?.getAttribute('clip-path') || '',
        activeNodeClipLayer: card.querySelector('.egd-ontology-v2-active-nodes')?.dataset.clipLayer || '',
        trailingNodeClipPath: card.querySelector('.egd-ontology-v2-coupled-behind-nodes')?.getAttribute('clip-path') || '',
        trailingNodeClipLayer: card.querySelector('.egd-ontology-v2-coupled-behind-nodes')?.dataset.clipLayer || '',
        cameraOverlayClipPath: card.querySelector('.egd-ontology-v2-camera-overlays')?.getAttribute('clip-path') || '',
        sideLayerClipViolations: [...card.querySelectorAll('.egd-ontology-v2-box-side')].filter((node) => (
          node.dataset.clipLayer !== node.dataset.layer
          || !String(node.getAttribute('clip-path') || '').includes('-' + node.dataset.phase + '-' + node.dataset.layer)
        )).length,
        overlap,
        virtualSize: virtualBox ? { width: virtualBox.width, height: virtualBox.height } : null,
        physicalSize: physicalBox ? { width: physicalBox.width, height: physicalBox.height } : null,
        layerHeightRatio: virtualBox && physicalBox ? physicalBox.height / virtualBox.height : null,
        exposedPhysicalHeight: physicalBox ? physicalBox.height - overlap.height : 0,
        dockClearance: physicalRect && dockRect ? dockRect.top - physicalRect.bottom : null,
        trailingContextHeight: trailingContextBox?.height || 0,
        layerStrutCount: card.querySelectorAll('.egd-ontology-v2-layer-strut').length,
        pastSlant: slant('past'),
        futureSlant: slant('future'),
        pastTimePlaneTilt: timePlaneTilt('past'),
        futureTimePlaneTilt: timePlaneTilt('future'),
      };
    })()`,
  }, 30000));
  const stackCheck = parseToolJson(stackCheckText);
  const polishCheckText = resultText(await callTool('evaluate_privileged_script', {
    expression: `(() => {
      const card = document.querySelector('.egd-ontology-card');
      const stageRect = card.querySelector('.egd-ontology-stage')?.getBoundingClientRect();
      const pipAspectRatios = [...card.querySelectorAll('.egd-ontology-v2-pip')].map((pip) => {
        const rect = pip.getBoundingClientRect();
        return rect.height > 0 ? rect.width / rect.height : 0;
      });
      const sideBoxesInsideStage = [...card.querySelectorAll('.egd-ontology-v2-box-side')].every((box) => {
        if (!stageRect) return false;
        const rect = box.getBoundingClientRect();
        return rect.left >= stageRect.left - 1
          && rect.right <= stageRect.right + 1
          && rect.top >= stageRect.top - 1
          && rect.bottom <= stageRect.bottom + 1;
      });
      return {
        pipAspectRatios,
        sideBoxesInsideStage,
        hasInteractionHint: !!card.querySelector('.egd-ontology-stage-hint')?.textContent?.trim(),
      };
    })()`,
  }, 30000));
  const polishCheck = parseToolJson(polishCheckText);
  const failures = [];
  if (!check.hasApi) failures.push('missing ontology card API');
  if (
    !shellCheck?.mounted
    || shellCheck.kind !== 'ontology'
    || shellCheck.inputPolicy !== 'adapter-owned'
    || shellCheck.titlebarCount !== 1
    || shellCheck.identityCount !== 1
    || shellCheck.toolbarCount !== 0
    || shellCheck.progressCount !== 0
    || shellCheck.resizeHandleCount !== 8
    || !shellCheck.minimizeDisabled
    || !shellCheck.maximizeInteractive
    || Math.abs(shellCheck.titlebarHeight - 32) > 0.75
  ) failures.push('Ontology Desk Window Shell');
  if (check.graphSchemaVersion !== 3 || check.graphSourceHash !== expectedGraph.sourceHash) failures.push('stale profile graph');
  if (check.snapshotCount !== 2 || check.occurrenceCount !== 14 || check.referenceEdgeCount !== 8) failures.push('snapshot occurrence graph');
  if (check.timeCoordinateCount !== 3 || check.outerTimeDeckCount !== 0) failures.push('time axis coordinates');
  if (check.v2TimeArrowCount !== 2) failures.push('time axis direction');
  if (check.activePane !== 'present' || check.activeLayer !== 'virtual') failures.push('initial lens state');
  if (check.selectedRefId !== 'present.server' || check.selectedConceptId !== 'server') failures.push('initial reference selection');
  if (check.layerPaneCount !== 6 || check.activeCoordinateLayerPaneCount !== 2) failures.push('six time-indexed layer panes');
  if (check.rootCompositeCount !== 1) failures.push('selected root composite');
  if (check.rootLabelAnchor !== 'middle' || check.rootLegendGapCount !== 0) failures.push('empty selected box centered label');
  if (check.directChildCount !== check.expectedDirectChildCount || check.directChildCount !== 0) failures.push('same-layer direct-child projection');
  if (check.crossLayerContextRefs.length !== 1 || check.crossLayerContextRefs[0] !== 'present.server.computer') failures.push('cross-layer direct child context');
  if (check.pipCount !== check.expectedPipCount || check.pipCount !== 1) failures.push('expanded child square pip count');
  if (polishCheck.pipAspectRatios.some((ratio) => ratio < 0.78 || ratio > 1.28)) failures.push('projected child pip aspect');
  if (check.overviewCount !== check.expectedOverviewCount || check.overviewCount !== 0) failures.push('snapshot-root-only overview');
  if (check.overviewPipCount !== check.expectedOverviewPipCount || check.overviewPipCount !== 0) failures.push('snapshot-root-only overview pips');
  if (check.emptyPastBoxCount !== 0 || check.syntheticEmptyBoxCount !== 0) failures.push('empty snapshot rendered concept');
  if (
    stackCheck.depthOffset.y < 85
    || stackCheck.depthOffset.y > 115
    || stackCheck.overlap.width < 600
    || stackCheck.overlap.height < 245
    || stackCheck.overlap.height > 285
    || !(stackCheck.layerHeightRatio > 0.98 && stackCheck.layerHeightRatio < 1.02)
    || stackCheck.virtualSize?.height < 350
    || stackCheck.physicalSize?.height < 350
    || stackCheck.exposedPhysicalHeight < 85
    || stackCheck.exposedPhysicalHeight > 115
    || !(stackCheck.dockClearance > 24)
    || stackCheck.trailingContextHeight < 20
    || stackCheck.layerStrutCount !== 6
  ) failures.push('partial layer depth');
  if (
    check.planeShadowCount !== 6
    || check.behindSurfaceCount !== 3
    || check.behindContextCount !== 1
    || check.behindContextOpacity < 0.95
    || check.frontOcclusionCount !== 1
    || !check.frontOcclusionFill
    || check.frontOcclusionFill === 'none'
  ) failures.push('layer shading and behind context');
  if (!stackCheck.cameraClipPath || stackCheck.depthEdgeClipPath !== stackCheck.cameraClipPath) failures.push('cross-layer edge active-pane clipping');
  if (
    stackCheck.activeNodeClipLayer !== 'virtual'
    || !stackCheck.activeNodeClipPath.includes('-present-virtual')
    || stackCheck.trailingNodeClipLayer !== 'physical'
    || !stackCheck.trailingNodeClipPath.includes('-present-physical')
    || stackCheck.cameraOverlayClipPath !== stackCheck.activeNodeClipPath
  ) failures.push('per-layer occurrence clipping');
  if (check.coupledCameraKeys.some((key) => !key.endsWith(':coupled-layers'))) failures.push('coupled layer camera');
  if (
    !(stackCheck.pastSlant > 30)
    || !(stackCheck.futureSlant > 30)
    || !(stackCheck.pastTimePlaneTilt?.topDy > 30)
    || !(stackCheck.pastTimePlaneTilt?.bottomDy > 30)
    || !(stackCheck.futureTimePlaneTilt?.topDy < -30)
    || !(stackCheck.futureTimePlaneTilt?.bottomDy < -30)
  ) failures.push('past \\ present _ future / time-plane tilt');
  if (check.temporalEdgeAnchorViolations || boundaryCheck.count < 1 || boundaryCheck.violations || check.layerEdgeAnchorViolations || check.unknownRenderedEdgeCount || check.edgeLabelCount) failures.push('boundary-aligned unlabeled edge grammar');
  if (Object.values(check.sidePaneCounts || {}).some((count) => count > 5)) failures.push('side pane five item cap');
  if (stackCheck.sideLayerClipViolations) failures.push('side occurrence per-layer clipping');
  if (!polishCheck.sideBoxesInsideStage) failures.push('side pane concept clipping');
  if (!check.sideLabelPresent) failures.push('side plane labels');
  if (check.activeCoordinateWidthRatio < 0.52) failures.push('active time-coordinate space use');
  if (!check.activeLayerFill || check.activeLayerFill === 'rgb(0, 0, 0)') failures.push('layer pane styling');
  if (check.hasSearch || check.hasInspector) failures.push('deferred search or inspector still mounted');
  if (!check.deskChromeVisible || !check.globalFocusClassAbsent) failures.push('ontology escaped Desk surface');
  if (check.minimap?.count !== 1 || check.minimap?.layerPaneCount !== 2 || check.minimap?.activeTimeCount !== 2 || check.minimap?.activeLayerCount !== 1 || check.minimap?.nodeCount < 1 || check.minimap?.selectedNodeCount !== 1 || check.v2MinimapLayerPaneCount !== 2 || check.v2MinimapViewportCount !== 1) failures.push('active-pane minimap structure');
  if (check.minimap?.toolCount !== 3 || !check.minimap?.toolsInteractive) failures.push('graph minimap controls');
  if (check.minimap?.zoomLabel !== '100%') failures.push('minimap zoom label');
  if (
    minimapLegendCheck.contextTitle !== '회사 서버 주변'
    || minimapLegendCheck.contextCoordinate !== '현재 · 가상'
    || minimapLegendCheck.legendText !== '가상|물리|선택|화면'
    || minimapLegendCheck.legendSwatchCount !== 4
    || !minimapLegendCheck.overlaysPassClicks
    || minimapLegendCheck.scope !== 'active-pane'
    || minimapLegendCheck.phase !== 'present'
    || minimapLegendCheck.panePhases.join('|') !== 'present'
    || minimapLegendCheck.nodePhases.join('|') !== 'present'
    || minimapLegendCheck.plotCoverage.width < 0.90
    || minimapLegendCheck.plotCoverage.height < 0.90
  ) failures.push('active-pane distribution minimap');
  if (!polishCheck.hasInteractionHint) failures.push('interaction affordance hint');
  if (check.mode !== 'composite') failures.push('composite mode');
  if (!check.hasSourceRef) failures.push('source ref');
  if (!check.dirty) failures.push('agenda dirty');
  if (failures.length) {
    throw new Error(`Ontology card verification failed (${failures.join(', ')}): ${JSON.stringify({ check, shellCheck, boundaryCheck, minimapLegendCheck, stackCheck, polishCheck }, null, 2)}`);
  }

  const screenshot = resultText(await callTool('screenshot_page', { saveTo: SCREENSHOT_PATH }, 30000));

  console.log(JSON.stringify({
    ok: true,
    contextId: contextMatch[1],
    screenshot: SCREENSHOT_PATH,
    check,
    shellCheck,
    boundaryCheck,
    minimapLegendCheck,
    stackCheck,
    polishCheck,
    screenshotResult: screenshot,
  }, null, 2));
}

main().catch((error) => {
  console.error(error.stack || error.message || String(error));
  if (stderrBuffer.trim()) {
    console.error('\n[MCP stderr]');
    console.error(stderrBuffer.trim());
  }
  process.exitCode = 1;
}).finally(() => {
  proc.stdin.end();
  setTimeout(() => proc.kill('SIGTERM'), 500);
});
