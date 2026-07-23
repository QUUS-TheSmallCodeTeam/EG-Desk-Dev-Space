#!/usr/bin/env node

import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';

const MCP_PACKAGE = process.env.EGDESK_FIREFOX_MCP_PACKAGE || '@mozilla/firefox-devtools-mcp-moz@latest';
const MCP_BIN = process.env.EGDESK_FIREFOX_MCP_BIN || '';
const MARIONETTE_PORT = process.env.EGDESK_MARIONETTE_PORT || '2828';
const OUT_PREFIX = process.argv[2] || '/tmp/egdesk-ontology-v2';
const jsSourcePath = fileURLToPath(new URL('../overlay/JS/eg-desk-surface.uc.js', import.meta.url));
const cssSourcePath = fileURLToPath(new URL('../overlay/CSS/eg-desk-surface.uc.css', import.meta.url));
const graphSourcePath = fileURLToPath(new URL('../overlay/resources/ontology/graph.json', import.meta.url));
const jsSourceUrl = pathToFileURL(jsSourcePath).href;
const expectedGraph = JSON.parse(readFileSync(graphSourcePath, 'utf8'));

const proc = MCP_BIN
  ? spawn(MCP_BIN, ['--connectExisting', '--marionettePort', MARIONETTE_PORT, '--enablePrivilegedContext', '--enableScript'], { stdio: ['pipe', 'pipe', 'pipe'] })
  : spawn('npx', ['-y', MCP_PACKAGE, '--connectExisting', '--marionettePort', MARIONETTE_PORT, '--enablePrivilegedContext', '--enableScript'], { stdio: ['pipe', 'pipe', 'pipe'] });

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
    if (!message.id || !pending.has(message.id)) continue;
    const { resolve, reject } = pending.get(message.id);
    pending.delete(message.id);
    if (message.error) reject(new Error(JSON.stringify(message.error)));
    else resolve(message.result);
  }
});
proc.stderr.on('data', (chunk) => { stderrBuffer += chunk.toString(); });
proc.on('exit', (code, signal) => {
  for (const { reject } of pending.values()) reject(new Error(`MCP server exited code=${code} signal=${signal}`));
  pending.clear();
});

function request(method, params = {}, timeoutMs = 15000) {
  const id = nextId++;
  proc.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error(`Timeout waiting for ${method}`));
    }, timeoutMs);
    pending.set(id, {
      resolve: (value) => { clearTimeout(timer); resolve(value); },
      reject: (error) => { clearTimeout(timer); reject(error); },
    });
  });
}

function notify(method, params = {}) {
  proc.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method, params })}\n`);
}

function resultText(result) {
  return (result.content || []).map((item) => item.text || '').join('\n');
}

function parseToolJson(text) {
  const trimmed = String(text || '').trim();
  if (trimmed.startsWith('Error:')) throw new Error(trimmed);
  const fenced = trimmed.match(/```json\s*\n([\s\S]*?)\n```/);
  if (fenced) return JSON.parse(fenced[1]);
  return JSON.parse(trimmed.startsWith('Result:') ? trimmed.slice('Result:'.length).trim() : trimmed);
}

async function callTool(name, args = {}, timeoutMs = 15000) {
  let toolArgs = args;
  if (name === 'evaluate_privileged_script' && typeof toolArgs.expression === 'string') {
    toolArgs = { function: `() => (\n${toolArgs.expression}\n)` };
  }
  return request('tools/call', { name, arguments: toolArgs }, timeoutMs);
}

async function evaluate(expression) {
  return parseToolJson(resultText(await callTool('evaluate_privileged_script', { expression }, 30000)));
}

async function screenshot(path) {
  await callTool('screenshot_page', { saveTo: path }, 30000);
}

async function main() {
  await request('initialize', {
    protocolVersion: '2024-11-05',
    capabilities: {},
    clientInfo: { name: 'egdesk-ontology-v2-interactions', version: '0.2.0' },
  }, 60000);
  notify('notifications/initialized');

  const contexts = await callTool('list_privileged_contexts', {}, 60000);
  const contextMatch = resultText(contexts).match(/\s([0-9a-f-]{36}): chrome:\/\/browser\/content\/browser\.xhtml/);
  if (!contextMatch) throw new Error('Firefox chrome context not found');
  await callTool('select_privileged_context', { contextId: contextMatch[1] }, 30000);

  if (process.env.EGDESK_INSPECT_LIVE === '1') {
    const live = await evaluate(`(() => {
      const card = document.querySelector('.egd-ontology-card');
      return {
        connected: !!card?.isConnected,
        selectedRefId: card?._ontologyState?.selectedRefId || null,
        activePane: card?._ontologyState?.activePane || null,
        activeLayer: card?._ontologyState?.activeLayer || null,
        cameraByCell: card?._ontologyState?.cameraByCell || null,
      };
    })()`);
    console.log(JSON.stringify({ ok: true, live }, null, 2));
    return;
  }

  const setup = await evaluate(`(async () => {
    const cleanup = (node) => { try { node._cleanup?.(); } catch {} node.remove(); };
    document.querySelectorAll('.egd-canvas-card, .egd-canvas-shape').forEach(cleanup);
    ['#egd-desk-rail','#egd-dock','#egd-preset-bag','#egd-hud','#egd-canvas-viewport','#egd-selection-marquee','#egd-zoom-indicator','#egd-input-helper-status','#egd-desk-minimap']
      .forEach((selector) => document.querySelectorAll(selector).forEach((node) => node.remove()));
    let style = document.getElementById('egd-ontology-live-style');
    if (!style) {
      style = document.createElementNS('http://www.w3.org/1999/xhtml', 'style');
      style.id = 'egd-ontology-live-style';
      document.documentElement.appendChild(style);
    }
    style.textContent = await IOUtils.readUTF8(${JSON.stringify(cssSourcePath)});
    window.__egdesk = undefined;
    const ServicesRef = globalThis.Services || ChromeUtils.importESModule('resource://gre/modules/Services.sys.mjs').Services;
    ServicesRef.scriptloader.loadSubScript(${JSON.stringify(jsSourceUrl)}, window, 'UTF-8');
    const card = window.__egdesk.cardRuntime.openOntologyMapCard({
      selectedRefId: 'present.server', activePane: 'present', activeLayer: 'virtual'
    });
    await new Promise((resolve) => setTimeout(resolve, 900));
    const initialVirtual = card.querySelector('.egd-ontology-time-coordinate-active .egd-ontology-v2-layer-surface-virtual')?.getBBox();
    const initialPhysical = card.querySelector('.egd-ontology-time-coordinate-active .egd-ontology-v2-layer-surface-physical')?.getBBox();
    return {
      hasApi: !!window.__egdesk?.cardRuntime?.openOntologyMapCard,
      cardId: card.id,
      graphVersion: card._ontologyGraph?.schemaVersion,
      sourceHash: card._ontologyGraph?.sourceHash,
      selectedRefId: card._ontologyState?.selectedRefId,
      activePane: card._ontologyState?.activePane,
      activeLayer: card._ontologyState?.activeLayer,
      layerPovShiftV: Number(card.dataset.layerPovShiftV),
      initialVirtualTop: initialVirtual?.y ?? null,
      initialPhysicalTop: initialPhysical?.y ?? null,
    };
  })()`);
  if (!setup.hasApi || setup.graphVersion !== 3 || setup.sourceHash !== expectedGraph.sourceHash) {
    throw new Error(`setup failed: ${JSON.stringify(setup, null, 2)}`);
  }
  await screenshot(`${OUT_PREFIX}-01-present.png`);

  const childFocus = await evaluate(`(async () => {
    const card = document.querySelector('.egd-ontology-card');
    card.querySelector('.egd-ontology-v2-box[data-ref-id="present.server.computer"]')
      ?.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, button: 0 }));
    await new Promise((resolve) => setTimeout(resolve, 80));
    return {
      selectedRefId: card._ontologyState.selectedRefId,
      activePane: card._ontologyState.activePane,
      activeLayer: card._ontologyState.activeLayer,
      breadcrumbRef: card.querySelector('.egd-ontology-v2-breadcrumb')?.dataset.refId || null,
      directChildren: card.querySelectorAll('.egd-ontology-v2-box[data-phase="present"]:not(.egd-ontology-v2-box-root):not(.egd-ontology-v2-box-side):not(.egd-ontology-v2-box-context):not(.egd-ontology-v2-box-overview)').length,
      pipCount: card.querySelectorAll('.egd-ontology-v2-box:not(.egd-ontology-v2-box-overview) .egd-ontology-v2-pip').length,
      pipHasNumbers: [...card.querySelectorAll('.egd-ontology-v2-box:not(.egd-ontology-v2-box-overview) .egd-ontology-v2-pip')].some((node) => /\\d/.test(node.textContent || '')),
      pipAspectRatios: [...card.querySelectorAll('.egd-ontology-v2-box:not(.egd-ontology-v2-box-overview) .egd-ontology-v2-pip')].map((node) => {
        const rect = node.getBoundingClientRect();
        return rect.height > 0 ? rect.width / rect.height : 0;
      }),
    };
  })()`);
  await screenshot(`${OUT_PREFIX}-02-child-focus.png`);

  const macbookFocus = await evaluate(`(async () => {
    const card = document.querySelector('.egd-ontology-card');
    card.querySelector('.egd-ontology-v2-box[data-ref-id="present.server.computer.macbook"]')
      ?.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, button: 0 }));
    await new Promise((resolve) => setTimeout(resolve, 80));
    const macos = card.querySelector('.egd-ontology-v2-box[data-ref-id="present.server.computer.macbook.macos"]');
    const macosEdge = card.querySelector('.egd-ontology-v2-edge-layer[data-source-ref="present.server.computer.macbook"][data-target-ref="present.server.computer.macbook.macos"]');
    return {
      selectedRefId: card._ontologyState.selectedRefId,
      activePane: card._ontologyState.activePane,
      activeLayer: card._ontologyState.activeLayer,
      breadcrumbRef: card.querySelector('.egd-ontology-v2-breadcrumb')?.dataset.refId || null,
      directChildRefs: [...card.querySelectorAll('.egd-ontology-v2-box[data-phase="present"]:not(.egd-ontology-v2-box-root):not(.egd-ontology-v2-box-side):not(.egd-ontology-v2-box-context):not(.egd-ontology-v2-box-overview)')]
        .map((node) => node.dataset.refId).sort(),
      macosVisible: !!macos,
      macosIsContext: !!macos?.classList.contains('egd-ontology-v2-box-context'),
      macosIsOverview: !!macos?.classList.contains('egd-ontology-v2-box-overview'),
      macosIsBehind: !!macos?.classList.contains('egd-ontology-v2-box-behind'),
      macosOpacity: Number(getComputedStyle(macos || card).opacity),
      frontOcclusionCount: card.querySelectorAll('.egd-ontology-v2-layer-occlusion').length,
      macosParentRef: card._ontologyGraph.occurrences.find((occurrence) => occurrence.refId === 'present.server.computer.macbook.macos')?.parentRef || null,
      macosDepthEdge: {
        sourceAnchor: macosEdge?.dataset.sourceAnchor || '',
        targetAnchor: macosEdge?.dataset.targetAnchor || '',
        dx: Number(macosEdge?.dataset.depthDx),
        dy: Number(macosEdge?.dataset.depthDy),
      },
      rootLabelAnchor: card.querySelector('.egd-ontology-v2-box-root .egd-ontology-v2-label-root')?.getAttribute('text-anchor') || '',
      rootLegendGapCount: card.querySelectorAll('.egd-ontology-v2-box-root .egd-ontology-v2-legend-gap').length,
      edgeLabelCount: card.querySelectorAll('.egd-ontology-v2-edge-label').length,
      relationLabelCount: card.querySelectorAll('.egd-ontology-v2-relation-label').length,
    };
  })()`);
  await screenshot(`${OUT_PREFIX}-02b-macbook-macos.png`);

  const breadcrumbBack = await evaluate(`(async () => {
    const card = document.querySelector('.egd-ontology-card');
    card.querySelector('.egd-ontology-v2-breadcrumb')
      ?.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, button: 0 }));
    await new Promise((resolve) => setTimeout(resolve, 60));
    const firstParentRef = card._ontologyState.selectedRefId;
    card.querySelector('.egd-ontology-v2-breadcrumb')
      ?.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, button: 0 }));
    await new Promise((resolve) => setTimeout(resolve, 60));
    return {
      firstParentRef,
      selectedRefId: card._ontologyState.selectedRefId,
      activeLayer: card._ontologyState.activeLayer,
      breadcrumbCount: card.querySelectorAll('.egd-ontology-v2-breadcrumb').length,
    };
  })()`);

  const panAndWheel = await evaluate(`(async () => {
    const card = document.querySelector('.egd-ontology-card');
    const stage = card.querySelector('.egd-ontology-stage');
    const quadrilateralFor = (node) => {
      const values = (node?.getAttribute('d')?.match(/-?\\d+(?:\\.\\d+)?/g) || []).map(Number);
      return values.length >= 8 ? [0, 1, 2, 3].map((index) => ({ x: values[index * 2], y: values[index * 2 + 1] })) : null;
    };
    const lineIntersection = (a, b, c, d) => {
      if (!a || !b || !c || !d) return null;
      const rx = b.x - a.x;
      const ry = b.y - a.y;
      const sx = d.x - c.x;
      const sy = d.y - c.y;
      const determinant = rx * sy - ry * sx;
      if (Math.abs(determinant) < 0.000001) return null;
      const t = ((c.x - a.x) * sy - (c.y - a.y) * sx) / determinant;
      return { x: a.x + t * rx, y: a.y + t * ry };
    };
    const verticalVanishingPoint = (points) => points
      ? lineIntersection(points[0], points[3], points[1], points[2])
      : null;
    const depthVectorFor = (pathValue) => {
      const values = (pathValue?.match(/-?\\d+(?:\\.\\d+)?/g) || []).map(Number);
      return values.length >= 4 ? { x: values[2] - values[0], y: values[3] - values[1] } : null;
    };
    const firstPointFor = (pathValue) => {
      const values = (pathValue?.match(/-?\\d+(?:\\.\\d+)?/g) || []).map(Number);
      return values.length >= 2 ? { x: values[0], y: values[1] } : null;
    };
    const motionFor = (beforePath, afterPath) => {
      const beforePoint = firstPointFor(beforePath);
      const afterPoint = firstPointFor(afterPath);
      return beforePoint && afterPoint
        ? { x: afterPoint.x - beforePoint.x, y: afterPoint.y - beforePoint.y }
        : null;
    };
    const surfaceGeometryBefore = [...card.querySelectorAll('.egd-ontology-v2-surfaces path')].map((node) => node.getAttribute('d'));
    const contextGeometryBefore = card.querySelector('.egd-ontology-v2-box-context .egd-ontology-v2-box-path')?.getAttribute('d') || null;
    const gesturePathBefore = card.querySelector('.egd-ontology-v2-box-root .egd-ontology-v2-box-path')?.getAttribute('d') || null;
    const temporalCoupledSelector = '.egd-ontology-v2-box-side[data-ref-id="future.server"] .egd-ontology-v2-box-path';
    const temporalCoupledBefore = card.querySelector(temporalCoupledSelector)?.getAttribute('d') || null;
    const temporalEdgeSelector = '.egd-ontology-v2-edge-temporal[data-source-ref="present.server"][data-target-ref="future.server"]';
    const temporalEdgeBefore = card.querySelector(temporalEdgeSelector)?.getAttribute('d') || null;
    const depthEdgeSelector = '.egd-ontology-v2-edge-layer[data-source-ref="present.server"][data-target-ref="present.server.computer"]';
    const depthEdgeBefore = card.querySelector(depthEdgeSelector)?.getAttribute('d') || null;
    const gesturePanBefore = JSON.stringify(card._ontologyState.cameraByCell);
    const surface = card.querySelector('.egd-ontology-time-coordinate-active .egd-ontology-v2-layer-surface-active');
    surface?.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true, button: 0, buttons: 1, clientX: 320, clientY: 360 }));
    document.dispatchEvent(new MouseEvent('mousemove', { bubbles: true, cancelable: true, buttons: 1, clientX: 382, clientY: 401 }));
    document.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, cancelable: true, button: 0, clientX: 382, clientY: 401 }));
    await new Promise((resolve) => setTimeout(resolve, 40));
    const gesturePathAfter = card.querySelector('.egd-ontology-v2-box-root .egd-ontology-v2-box-path')?.getAttribute('d') || null;
    const contextGeometryAfter = card.querySelector('.egd-ontology-v2-box-context .egd-ontology-v2-box-path')?.getAttribute('d') || null;
    const temporalCoupledAfter = card.querySelector(temporalCoupledSelector)?.getAttribute('d') || null;
    const temporalEdgeAfter = card.querySelector(temporalEdgeSelector)?.getAttribute('d') || null;
    const depthEdgeAfter = card.querySelector(depthEdgeSelector)?.getAttribute('d') || null;
    const rootMotion = motionFor(gesturePathBefore, gesturePathAfter);
    const contextMotion = motionFor(contextGeometryBefore, contextGeometryAfter);
    const temporalCoupledMotion = motionFor(temporalCoupledBefore, temporalCoupledAfter);
    const depthBeforeVector = depthVectorFor(depthEdgeBefore);
    const depthAfterVector = depthVectorFor(depthEdgeAfter);
    const gesturePanAfter = JSON.stringify(card._ontologyState.cameraByCell);
    const before = { pane: card._ontologyState.activePane, layer: card._ontologyState.activeLayer, ...card._ontologyApplyWheelDelta(0, 0) };
    card._ontologyPanBy(64, -42);
    const afterDrag = card._ontologyApplyWheelDelta(0, 0);
    const afterWheel = card._ontologyApplyWheelDelta(90, 70);
    const afterZoom = card._ontologyApplyWheelDelta(0, -120, { ctrlKey: true });
    const surfaceVanishingPoint = verticalVanishingPoint(quadrilateralFor(
      card.querySelector('.egd-ontology-time-coordinate-active .egd-ontology-v2-layer-surface-active'),
    ));
    const conceptVanishingPoint = verticalVanishingPoint(quadrilateralFor(
      card.querySelector('.egd-ontology-v2-box-root .egd-ontology-v2-box-path'),
    ));
    const perspectiveVanishingPointDelta = surfaceVanishingPoint && conceptVanishingPoint
      ? Math.hypot(surfaceVanishingPoint.x - conceptVanishingPoint.x, surfaceVanishingPoint.y - conceptVanishingPoint.y)
      : null;
    const cameraGroup = card.querySelector('.egd-ontology-v2-camera');
    return {
      before,
      afterDrag,
      afterWheel,
      afterZoom,
      activePane: card._ontologyState.activePane,
      activeLayer: card._ontologyState.activeLayer,
      minimapViewport: card.querySelector('.egd-ontology-minimap-viewport')?.getAttribute('d') || null,
      pointerGestureChangedCamera: gesturePanBefore !== gesturePanAfter,
      pointerGestureMovedConcepts: gesturePathBefore !== gesturePathAfter,
      hasPanHook: typeof card._ontologyPanBy === 'function',
      surfaceGeometryFixed: JSON.stringify(surfaceGeometryBefore) === JSON.stringify([...card.querySelectorAll('.egd-ontology-v2-surfaces path')].map((node) => node.getAttribute('d'))),
      cameraContainsSurfaces: cameraGroup?.contains(card.querySelector('.egd-ontology-v2-surfaces')) || false,
      cameraSpace: cameraGroup?.dataset.cameraSpace || null,
      cameraScreenTransformAbsent: !cameraGroup?.hasAttribute('transform'),
      perspectiveVanishingPointDelta,
      contextGeometryMoved: contextGeometryBefore !== contextGeometryAfter,
      depthEdgeMoved: depthEdgeBefore !== depthEdgeAfter,
      temporalCoupledConceptMoved: temporalCoupledBefore !== temporalCoupledAfter,
      temporalEdgeMoved: temporalEdgeBefore !== temporalEdgeAfter,
      temporalCoupledMotionDelta: rootMotion && temporalCoupledMotion
        ? Math.hypot(rootMotion.x - temporalCoupledMotion.x, rootMotion.y - temporalCoupledMotion.y)
        : null,
      temporalCoupledClipPath: card.querySelector('.egd-ontology-v2-box-side[data-ref-id="future.server"]')?.getAttribute('clip-path') || '',
      temporalCoupledMode: card.querySelector('.egd-ontology-v2-box-side[data-ref-id="future.server"]')?.dataset.cameraCoupled || '',
      coupledConceptMotionDelta: rootMotion && contextMotion
        ? Math.hypot(rootMotion.x - contextMotion.x, rootMotion.y - contextMotion.y)
        : null,
      coupledDepthAligned: !!depthBeforeVector && !!depthAfterVector
        && Math.abs(depthBeforeVector.y) > 8
        && Math.abs(depthAfterVector.y) > 8
        && Math.abs(depthBeforeVector.x) <= 1
        && Math.abs(depthAfterVector.x) <= 1,
      cameraClipPathCount: card.querySelectorAll('clipPath[id^="egd-ontology-v2-camera-clip-"] path').length,
      coupledCameraKeys: Object.keys(card._ontologyState.cameraByCell || {}),
    };
  })()`);
  await screenshot(`${OUT_PREFIX}-03-pan.png`);

  const farLeftClip = await evaluate(`(async () => {
    const card = document.querySelector('.egd-ontology-card');
    const camera = card._ontologyState.cameraByCell['present:coupled-layers'];
    camera.x = -1400;
    camera.y = 0;
    camera.zoom = 1;
    card._ontologyRender();
    await new Promise((resolve) => setTimeout(resolve, 40));
    const cameraClipPath = card.querySelector('.egd-ontology-v2-camera')?.getAttribute('clip-path') || '';
    const depthEdgeClipPath = card.querySelector('.egd-ontology-v2-depth-edges')?.getAttribute('clip-path') || '';
    return {
      cameraClipPath,
      depthEdgeClipPath,
      sharedClip: !!cameraClipPath && cameraClipPath === depthEdgeClipPath,
      pastPanePresent: !!card.querySelector('.egd-ontology-time-coordinate-past .egd-ontology-v2-layer-pane'),
      depthEdgePresent: !!card.querySelector('.egd-ontology-v2-edge-layer'),
    };
  })()`);
  await screenshot(`${OUT_PREFIX}-03b-far-left-clip.png`);
  await evaluate(`(() => {
    const card = document.querySelector('.egd-ontology-card');
    const camera = card._ontologyState.cameraByCell['present:coupled-layers'];
    camera.x = 0;
    camera.y = 0;
    camera.zoom = 1;
    card._ontologyRender();
    return true;
  })()`);

  const farDepthClip = await evaluate(`(async () => {
    const card = document.querySelector('.egd-ontology-card');
    const camera = card._ontologyState.cameraByCell['present:coupled-layers'];
    camera.x = 0;
    camera.y = 620;
    camera.zoom = 1;
    card._ontologyRender();
    await new Promise((resolve) => setTimeout(resolve, 40));
    const activeNodes = card.querySelector('.egd-ontology-v2-active-nodes');
    const trailingNodes = card.querySelector('.egd-ontology-v2-coupled-behind-nodes');
    const overlays = card.querySelector('.egd-ontology-v2-camera-overlays');
    return {
      activeLayer: card._ontologyState.activeLayer,
      activeClipLayer: activeNodes?.dataset.clipLayer || '',
      activeClipPath: activeNodes?.getAttribute('clip-path') || '',
      trailingClipLayer: trailingNodes?.dataset.clipLayer || '',
      trailingClipPath: trailingNodes?.getAttribute('clip-path') || '',
      overlayClipPath: overlays?.getAttribute('clip-path') || '',
    };
  })()`);
  await screenshot(`${OUT_PREFIX}-03c-layer-isolation.png`);
  await evaluate(`(() => {
    const card = document.querySelector('.egd-ontology-card');
    const camera = card._ontologyState.cameraByCell['present:coupled-layers'];
    camera.x = 0;
    camera.y = 0;
    camera.zoom = 1;
    card._ontologyRender();
    return true;
  })()`);

  const futurePane = await evaluate(`(async () => {
    const card = document.querySelector('.egd-ontology-card');
    card.querySelector('.egd-ontology-time-coordinate-future .egd-ontology-v2-side-layer-virtual')
      ?.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, button: 0 }));
    await new Promise((resolve) => setTimeout(resolve, 60));
    const currentSnapshot = card._ontologyGraph.snapshots.find((snapshot) => snapshot.snapshotId === 'company-server@present');
    const futureSnapshot = card._ontologyGraph.snapshots.find((snapshot) => snapshot.snapshotId === 'company-server@future');
    const points = (node) => {
      const values = (node?.getAttribute('d')?.match(/-?\\d+(?:\\.\\d+)?/g) || []).map(Number);
      return values.length >= 8 ? [0, 1, 2, 3].map((index) => ({ x: values[index * 2], y: values[index * 2 + 1] })) : null;
    };
    const tilt = (node) => {
      const shape = points(node);
      return shape ? { topDy: shape[1].y - shape[0].y, bottomDy: shape[2].y - shape[3].y } : null;
    };
    const stageRect = card.querySelector('.egd-ontology-stage')?.getBoundingClientRect();
    const activeSurface = card.querySelector('.egd-ontology-time-coordinate-future .egd-ontology-v2-layer-surface-virtual');
    const activeRect = activeSurface?.getBoundingClientRect();
    return {
      activePane: card._ontologyState.activePane,
      activeLayer: card._ontologyState.activeLayer,
      selectedRefId: card._ontologyState.selectedRefId,
      activeVirtualTop: card.querySelector('.egd-ontology-time-coordinate-active .egd-ontology-v2-layer-surface-virtual')?.getBBox()?.y ?? null,
      sameSubject: currentSnapshot?.subjectId === futureSnapshot?.subjectId,
      distinctSnapshots: currentSnapshot?.snapshotId !== futureSnapshot?.snapshotId,
      activeCenterDelta: stageRect && activeRect
        ? Math.abs((activeRect.left + activeRect.width / 2) - (stageRect.left + stageRect.width / 2)) / stageRect.width
        : Infinity,
      activeTilt: tilt(activeSurface),
      previousTilt: tilt(card.querySelector('.egd-ontology-time-coordinate-present .egd-ontology-v2-side-layer-virtual')),
      sideNodeCounts: Object.fromEntries(['past','present'].map((phase) => [phase, card.querySelectorAll('.egd-ontology-v2-box-side[data-phase="' + phase + '"]').length])),
    };
  })()`);

  const futureLayerIsolation = await evaluate(`(async () => {
    const card = document.querySelector('.egd-ontology-card');
    const camera = card._ontologyState.cameraByCell['future:coupled-layers'];
    camera.x = 0;
    camera.y = 620;
    camera.zoom = 1;
    card._ontologyRender();
    await new Promise((resolve) => setTimeout(resolve, 40));
    const activeNodes = card.querySelector('.egd-ontology-v2-active-nodes');
    const trailingNodes = card.querySelector('.egd-ontology-v2-coupled-behind-nodes');
    return {
      activePane: card._ontologyState.activePane,
      activeLayer: card._ontologyState.activeLayer,
      activeClipLayer: activeNodes?.dataset.clipLayer || '',
      activeClipPath: activeNodes?.getAttribute('clip-path') || '',
      trailingClipLayer: trailingNodes?.dataset.clipLayer || '',
      trailingClipPath: trailingNodes?.getAttribute('clip-path') || '',
    };
  })()`);
  await screenshot(`${OUT_PREFIX}-03d-future-layer-isolation.png`);
  await evaluate(`(() => {
    const card = document.querySelector('.egd-ontology-card');
    const camera = card._ontologyState.cameraByCell['future:coupled-layers'];
    camera.x = 0;
    camera.y = 0;
    camera.zoom = 1;
    card._ontologyRender();
    return true;
  })()`);

  const physicalLayer = await evaluate(`(async () => {
    const card = document.querySelector('.egd-ontology-card');
    const physicalStripControl = card.querySelector('.egd-ontology-v2-layer-switch-hit-physical');
    const stripRect = physicalStripControl?.getBoundingClientRect();
    const stripHit = stripRect
      ? document.elementFromPoint(stripRect.left + stripRect.width / 2, stripRect.top + stripRect.height / 2)
      : null;
    const stripHitLayer = stripHit?.closest?.('.egd-ontology-v2-layer-switch-hit')?.dataset.layer || null;
    const physicalLabelControl = card.querySelector('.egd-ontology-v2-layer-label-control-physical[data-phase="future"]');
    const labelRect = physicalLabelControl?.getBoundingClientRect();
    const labelHit = labelRect
      ? document.elementFromPoint(labelRect.left + labelRect.width / 2, labelRect.top + labelRect.height / 2)
      : null;
    const hitControl = labelHit?.closest?.('.egd-ontology-v2-layer-label-control');
    const hitPhysicalLabel = hitControl?.dataset.layer === 'physical';
    const hitDiagnostics = {
      stripPoint: stripRect ? { x: stripRect.left + stripRect.width / 2, y: stripRect.top + stripRect.height / 2 } : null,
      stripHitTag: stripHit?.tagName || null,
      stripHitClass: stripHit?.getAttribute?.('class') || null,
      labelRect: labelRect ? { left: labelRect.left, top: labelRect.top, width: labelRect.width, height: labelRect.height } : null,
      labelHitTag: labelHit?.tagName || null,
      labelHitClass: labelHit?.getAttribute?.('class') || null,
    };
    if (labelHit) {
      const eventInit = {
        bubbles: true,
        cancelable: true,
        button: 0,
        clientX: labelRect.left + labelRect.width / 2,
        clientY: labelRect.top + labelRect.height / 2,
        view: window,
      };
      labelHit.dispatchEvent(new MouseEvent('mousedown', eventInit));
      labelHit.dispatchEvent(new MouseEvent('mouseup', eventInit));
      labelHit.dispatchEvent(new MouseEvent('click', eventInit));
    }
    await new Promise((resolve) => setTimeout(resolve, 60));
    const physicalSurface = card.querySelector('.egd-ontology-time-coordinate-active .egd-ontology-v2-layer-surface-physical');
    const virtualSurface = card.querySelector('.egd-ontology-time-coordinate-active .egd-ontology-v2-layer-surface-virtual');
    const physical = physicalSurface?.getBBox();
    const virtual = virtualSurface?.getBBox();
    const surfaceDepthOffset = !!physical && !!virtual
      ? { x: physical.x - virtual.x, y: physical.y - virtual.y }
      : { x: NaN, y: NaN };
    const surfaceOverlap = !!physical && !!virtual
      ? {
        width: Math.max(0, Math.min(physical.x + physical.width, virtual.x + virtual.width) - Math.max(physical.x, virtual.x)),
        height: Math.max(0, Math.min(physical.y + physical.height, virtual.y + virtual.height) - Math.max(physical.y, virtual.y)),
      }
      : { width: 0, height: 0 };
    const pathPoints = (node) => {
      const values = (node?.getAttribute('d')?.match(/-?\\d+(?:\\.\\d+)?/g) || []).map(Number);
      return values.length >= 8 ? [0, 1, 2, 3].map((index) => ({ x: values[index * 2], y: values[index * 2 + 1] })) : null;
    };
    const leftEdgeAngle = (points) => points ? Math.atan2(points[3].y - points[0].y, points[3].x - points[0].x) : NaN;
    const virtualPoints = pathPoints(virtualSurface);
    const physicalPoints = pathPoints(physicalSurface);
    const parallelAngleDelta = Number.isFinite(leftEdgeAngle(virtualPoints)) && Number.isFinite(leftEdgeAngle(physicalPoints))
      ? Math.abs(leftEdgeAngle(virtualPoints) - leftEdgeAngle(physicalPoints))
      : NaN;
    const sideLabel = card.querySelector('.egd-ontology-v2-box-side[data-phase="present"] .egd-ontology-v2-label');
    const activeLayerEdgeViolations = [...card.querySelectorAll('.egd-ontology-v2-edge-layer')].filter((edge) => (
      Math.abs(Number(edge.dataset.depthDy)) <= 8
      || Math.abs(Number(edge.dataset.depthDx)) > 1
    )).length;
    return {
      activePane: card._ontologyState.activePane,
      activeLayer: card._ontologyState.activeLayer,
      selectedRefId: card._ontologyState.selectedRefId,
      stripHitLayer,
      hitPhysicalLabel,
      minimapContext: card.querySelector('.egd-ontology-minimap-context-title')?.textContent?.trim() || '',
      minimapCoordinate: card.querySelector('.egd-ontology-minimap-context-coordinate')?.textContent?.trim() || '',
      hitDiagnostics,
      physicalIsMain: physicalSurface?.dataset.planeRole === 'main',
      layerPovShiftV: Number(card.dataset.layerPovShiftV),
      virtualTop: virtual?.y ?? null,
      physicalTop: physical?.y ?? null,
      surfaceDepthOffset,
      surfaceOverlap,
      physicalMainHeight: physical?.height || 0,
      exposedTrailingHeight: virtual ? virtual.height - surfaceOverlap.height : 0,
      activeLayerStrutCount: card.querySelectorAll('.egd-ontology-time-coordinate-active .egd-ontology-v2-layer-strut').length,
      activeShadowCount: card.querySelectorAll('.egd-ontology-v2-layer-shadow-active').length,
      behindSurfaceCount: card.querySelectorAll('.egd-ontology-v2-layer-surface-behind, .egd-ontology-v2-side-layer-behind').length,
      parallelAngleDelta,
      coupledCameraKeys: Object.keys(card._ontologyState.cameraByCell || {}),
      activeLayerEdgeViolations,
      sideLabelOnPlane: !!sideLabel?.textContent?.trim(),
      bundleLabels: [...card.querySelectorAll('.egd-ontology-v2-bundle-label')].map((node) => node.textContent.trim()),
    };
  })()`);
  await screenshot(`${OUT_PREFIX}-04-future-physical.png`);

  const futurePhysicalIsolation = await evaluate(`(async () => {
    const card = document.querySelector('.egd-ontology-card');
    const camera = card._ontologyState.cameraByCell['future:coupled-layers'];
    camera.x = 0;
    camera.y = -620;
    camera.zoom = 1;
    card._ontologyRender();
    await new Promise((resolve) => setTimeout(resolve, 40));
    const activeNodes = card.querySelector('.egd-ontology-v2-active-nodes');
    const trailingNodes = card.querySelector('.egd-ontology-v2-coupled-behind-nodes');
    return {
      activePane: card._ontologyState.activePane,
      activeLayer: card._ontologyState.activeLayer,
      activeClipLayer: activeNodes?.dataset.clipLayer || '',
      activeClipPath: activeNodes?.getAttribute('clip-path') || '',
      trailingClipLayer: trailingNodes?.dataset.clipLayer || '',
      trailingClipPath: trailingNodes?.getAttribute('clip-path') || '',
    };
  })()`);
  await screenshot(`${OUT_PREFIX}-04b-future-physical-isolation.png`);
  await evaluate(`(() => {
    const card = document.querySelector('.egd-ontology-card');
    const camera = card._ontologyState.cameraByCell['future:coupled-layers'];
    camera.x = 0;
    camera.y = 0;
    camera.zoom = 1;
    card._ontologyRender();
    return true;
  })()`);

  const emptyPast = await evaluate(`(async () => {
    const card = document.querySelector('.egd-ontology-card');
    card.querySelector('.egd-ontology-v2-pane-hit-past')
      ?.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, button: 0 }));
    await new Promise((resolve) => setTimeout(resolve, 60));
    const byRef = new Map((card._ontologyGraph?.occurrences || []).map((occurrence) => [occurrence.refId, occurrence]));
    const edgesTouchingPast = [...card.querySelectorAll('.egd-ontology-v2-reference-edges .egd-ontology-v2-edge[data-source-ref]')]
      .filter((edge) => byRef.get(edge.dataset.sourceRef)?.timeSlice === 'past' || byRef.get(edge.dataset.targetRef)?.timeSlice === 'past').length;
    const points = (node) => {
      const values = (node?.getAttribute('d')?.match(/-?\\d+(?:\\.\\d+)?/g) || []).map(Number);
      return values.length >= 8 ? [0, 1, 2, 3].map((index) => ({ x: values[index * 2], y: values[index * 2 + 1] })) : null;
    };
    const tilt = (node) => {
      const shape = points(node);
      return shape ? { topDy: shape[1].y - shape[0].y, bottomDy: shape[2].y - shape[3].y } : null;
    };
    const stageRect = card.querySelector('.egd-ontology-stage')?.getBoundingClientRect();
    const activeSurface = card.querySelector('.egd-ontology-time-coordinate-past .egd-ontology-v2-layer-surface-physical');
    const activeRect = activeSurface?.getBoundingClientRect();
    return {
      activePane: card._ontologyState.activePane,
      selectedRefId: card._ontologyState.selectedRefId,
      selectedConceptId: card._ontologyState.selectedConceptId,
      pastConceptCount: card.querySelectorAll('.egd-ontology-v2-box[data-phase="past"]').length,
      syntheticEmptyCount: card.querySelectorAll('.egd-ontology-v2-box[data-ref-id^="empty."]').length,
      emptyStateCount: card.querySelectorAll('.egd-ontology-v2-empty-state[data-phase="past"]').length,
      emptyStateText: card.querySelector('.egd-ontology-v2-empty-state[data-phase="past"]')?.textContent?.trim() || '',
      edgesTouchingPast,
      activeCenterDelta: stageRect && activeRect
        ? Math.abs((activeRect.left + activeRect.width / 2) - (stageRect.left + stageRect.width / 2)) / stageRect.width
        : Infinity,
      activeTilt: tilt(activeSurface),
      nextTilt: tilt(card.querySelector('.egd-ontology-time-coordinate-present .egd-ontology-v2-side-layer-physical')),
    };
  })()`);
  await screenshot(`${OUT_PREFIX}-05-empty-past.png`);

  const lifecycle = await evaluate(`(async () => {
    let card = document.querySelector('.egd-ontology-card');
    const header = card.querySelector('.egd-ontology-header');
    const beforeLeft = card.offsetLeft;
    const beforeTop = card.offsetTop;
    const beforeCamera = JSON.stringify(card._ontologyState.cameraByCell);
    const rect = header.getBoundingClientRect();
    header.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true, button: 0, clientX: rect.left + rect.width * 0.55, clientY: rect.top + rect.height * 0.5 }));
    document.dispatchEvent(new MouseEvent('mousemove', { bubbles: true, cancelable: true, buttons: 1, clientX: rect.left + rect.width * 0.55 + 46, clientY: rect.top + rect.height * 0.5 + 34 }));
    document.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, cancelable: true, button: 0 }));
    const headerMovedCard = card.offsetLeft !== beforeLeft || card.offsetTop !== beforeTop;
    const headerKeptCamera = JSON.stringify(card._ontologyState.cameraByCell) === beforeCamera;
    card.querySelector('.egd-card-dot-close')?.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, button: 0 }));
    await new Promise((resolve) => setTimeout(resolve, 40));
    const deskVisibleAfterClose = ['#egd-desk-rail','#egd-dock'].every((selector) => {
      const node = document.querySelector(selector);
      return node && getComputedStyle(node).display !== 'none';
    });
    const focusClassAbsent = !document.documentElement.classList.contains('egd-ontology-focus-active');
    card = window.__egdesk.cardRuntime.openOntologyMapCard({ selectedRefId: 'present.server', activePane: 'present', activeLayer: 'virtual' });
    await new Promise((resolve) => setTimeout(resolve, 200));
    return {
      headerMovedCard,
      headerKeptCamera,
      closedCardCount: document.querySelectorAll('.egd-ontology-card').length,
      deskVisibleAfterClose,
      focusClassAbsent,
      reopenedConnected: !!card?.isConnected,
      reopenedSelected: card?._ontologyState?.selectedRefId || null,
    };
  })()`);

  const failures = [];
  if (childFocus.selectedRefId !== 'present.server.computer' || childFocus.activeLayer !== 'physical') failures.push('child focus');
  if (childFocus.breadcrumbRef !== 'present.server') failures.push('breadcrumb creation');
  if (childFocus.directChildren !== 1 || childFocus.pipCount !== 4 || childFocus.pipHasNumbers) failures.push('direct children and literal square pips');
  if (childFocus.pipAspectRatios.some((ratio) => ratio < 0.78 || ratio > 1.28)) failures.push('projected square pips');
  if (macbookFocus.selectedRefId !== 'present.server.computer.macbook' || macbookFocus.activeLayer !== 'physical' || macbookFocus.breadcrumbRef !== 'present.server.computer') failures.push('macbook focus ancestry');
  if (!macbookFocus.macosVisible || !macbookFocus.macosIsContext || macbookFocus.macosIsOverview || !macbookFocus.macosIsBehind || macbookFocus.macosParentRef !== 'present.server.computer.macbook') failures.push('macos nested cross-layer child');
  if (
    macbookFocus.macosDepthEdge.sourceAnchor !== 'depth'
    || macbookFocus.macosDepthEdge.targetAnchor !== 'depth'
    || Math.abs(macbookFocus.macosDepthEdge.dy) <= 8
    || Math.abs(macbookFocus.macosDepthEdge.dx) > 1
  ) failures.push('perpendicular macos depth edge');
  if (macbookFocus.macosOpacity < 0.95 || macbookFocus.frontOcclusionCount !== 1) failures.push('spatial-only macos rear-plane occlusion');
  if (macbookFocus.rootLabelAnchor !== 'start' || macbookFocus.rootLegendGapCount !== 1) failures.push('expanded selected box border label');
  if (macbookFocus.edgeLabelCount || macbookFocus.relationLabelCount) failures.push('connection and rectangle relation labels');
  if (macbookFocus.directChildRefs.join('|') !== [
    'present.server.computer.macbook.cpu',
    'present.server.computer.macbook.disk',
    'present.server.computer.macbook.ram',
  ].join('|')) failures.push('macbook physical children');
  if (breadcrumbBack.firstParentRef !== 'present.server.computer' || breadcrumbBack.selectedRefId !== 'present.server' || breadcrumbBack.activeLayer !== 'virtual' || breadcrumbBack.breadcrumbCount !== 0) failures.push('breadcrumb back');
  if (panAndWheel.before.pane !== panAndWheel.activePane || panAndWheel.before.layer !== panAndWheel.activeLayer) failures.push('wheel changed semantic lens');
  if (!panAndWheel.pointerGestureChangedCamera || !panAndWheel.pointerGestureMovedConcepts) failures.push('real background pointer drag');
  if (panAndWheel.afterDrag.pan.x === panAndWheel.before.pan.x && panAndWheel.afterDrag.pan.y === panAndWheel.before.pan.y) failures.push('background drag pan');
  if (panAndWheel.afterWheel.pan.x === panAndWheel.afterDrag.pan.x && panAndWheel.afterWheel.pan.y === panAndWheel.afterDrag.pan.y) failures.push('wheel pan');
  if (panAndWheel.afterZoom.zoom <= panAndWheel.afterWheel.zoom) failures.push('ctrl wheel zoom');
  if (!panAndWheel.surfaceGeometryFixed || panAndWheel.cameraContainsSurfaces) failures.push('pane geometry moved with camera');
  if (panAndWheel.cameraSpace !== 'plane' || !panAndWheel.cameraScreenTransformAbsent || !(panAndWheel.perspectiveVanishingPointDelta < 120)) failures.push('plane perspective camera');
  if (
    !panAndWheel.contextGeometryMoved
    || !panAndWheel.depthEdgeMoved
    || !(panAndWheel.coupledConceptMotionDelta < 12)
    || !panAndWheel.coupledDepthAligned
    || panAndWheel.cameraClipPathCount !== 2
    || panAndWheel.coupledCameraKeys.some((key) => !key.endsWith(':coupled-layers'))
  ) failures.push('coupled cross-layer camera');
  if (
    !panAndWheel.temporalCoupledConceptMoved
    || !panAndWheel.temporalEdgeMoved
    || !(panAndWheel.temporalCoupledMotionDelta < 12)
    || panAndWheel.temporalCoupledMode !== 'temporal'
    || !panAndWheel.temporalCoupledClipPath.includes('egd-ontology-v2-layer-clip-')
  ) failures.push('coupled temporal occurrence camera');
  if (!farLeftClip.sharedClip || !farLeftClip.pastPanePresent || !farLeftClip.depthEdgePresent) failures.push('far-left cross-layer clipping');
  if (
    farDepthClip.activeLayer !== 'virtual'
    || farDepthClip.activeClipLayer !== 'virtual'
    || !farDepthClip.activeClipPath.includes('-present-virtual')
    || farDepthClip.trailingClipLayer !== 'physical'
    || !farDepthClip.trailingClipPath.includes('-present-physical')
    || farDepthClip.overlayClipPath !== farDepthClip.activeClipPath
  ) failures.push('active/trailing layer isolation');
  if (futurePane.activePane !== 'future' || futurePane.selectedRefId !== 'future.server' || futurePane.activeLayer !== 'virtual') failures.push('future layer pane click');
  if (!futurePane.sameSubject || !futurePane.distinctSnapshots) failures.push('time snapshot identity');
  if (
    futurePane.activeCenterDelta > 0.04
    || Math.abs(futurePane.activeTilt?.topDy) > 1
    || Math.abs(futurePane.activeTilt?.bottomDy) > 1
    || !(futurePane.previousTilt?.topDy > 20)
    || !(futurePane.previousTilt?.bottomDy > 20)
  ) failures.push('future centered \\_ time geometry');
  if (Object.values(futurePane.sideNodeCounts).some((count) => count > 5)) failures.push('side pane cap');
  if (
    futureLayerIsolation.activePane !== 'future'
    || futureLayerIsolation.activeLayer !== 'virtual'
    || futureLayerIsolation.activeClipLayer !== 'virtual'
    || !futureLayerIsolation.activeClipPath.includes('-future-virtual')
    || futureLayerIsolation.trailingClipLayer !== 'physical'
    || !futureLayerIsolation.trailingClipPath.includes('-future-physical')
  ) failures.push('future active/trailing layer isolation');
  if (
    physicalLayer.activeLayer !== 'physical'
    || physicalLayer.selectedRefId !== 'future.server.computer'
    || physicalLayer.stripHitLayer !== 'physical'
    || !physicalLayer.hitPhysicalLabel
    || physicalLayer.minimapContext !== '컴퓨터 / PC 주변'
    || physicalLayer.minimapCoordinate !== '미래 · 물리'
    || !physicalLayer.physicalIsMain
    || setup.layerPovShiftV !== 0
    || Math.abs(physicalLayer.layerPovShiftV + 0.17) > 0.001
    || physicalLayer.surfaceDepthOffset.y < 85
    || physicalLayer.surfaceDepthOffset.y > 115
    || Math.abs(physicalLayer.physicalTop - futurePane.activeVirtualTop) > 2
    || !(physicalLayer.virtualTop < futurePane.activeVirtualTop - 85)
    || physicalLayer.surfaceOverlap.width < 600
    || physicalLayer.physicalMainHeight < 350
    || physicalLayer.exposedTrailingHeight < 85
    || physicalLayer.exposedTrailingHeight > 115
    || physicalLayer.activeLayerStrutCount !== 2
    || physicalLayer.activeShadowCount !== 1
    || physicalLayer.behindSurfaceCount !== 3
    || !(physicalLayer.parallelAngleDelta < 0.05)
  ) failures.push('partial physical main view');
  if (physicalLayer.coupledCameraKeys.some((key) => !key.endsWith(':coupled-layers'))) failures.push('physical layer camera coupling');
  if (physicalLayer.activeLayerEdgeViolations) failures.push('physical perpendicular depth edges');
  if (!physicalLayer.sideLabelOnPlane) failures.push('side plane occurrence');
  if (
    futurePhysicalIsolation.activePane !== 'future'
    || futurePhysicalIsolation.activeLayer !== 'physical'
    || futurePhysicalIsolation.activeClipLayer !== 'physical'
    || !futurePhysicalIsolation.activeClipPath.includes('-future-physical')
    || futurePhysicalIsolation.trailingClipLayer !== 'virtual'
    || !futurePhysicalIsolation.trailingClipPath.includes('-future-virtual')
  ) failures.push('future physical/trailing layer isolation');
  if (emptyPast.activePane !== 'past' || emptyPast.selectedRefId !== null || emptyPast.selectedConceptId !== null || emptyPast.pastConceptCount || emptyPast.syntheticEmptyCount || emptyPast.emptyStateCount !== 1 || !/snapshot/.test(emptyPast.emptyStateText) || emptyPast.edgesTouchingPast) failures.push('empty snapshot semantics');
  if (
    emptyPast.activeCenterDelta > 0.04
    || Math.abs(emptyPast.activeTilt?.topDy) > 1
    || Math.abs(emptyPast.activeTilt?.bottomDy) > 1
    || !(emptyPast.nextTilt?.topDy < -20)
    || !(emptyPast.nextTilt?.bottomDy < -20)
  ) failures.push('past centered _/ time geometry');
  if (!lifecycle.headerMovedCard || !lifecycle.headerKeptCamera) failures.push('header drag separation');
  if (!lifecycle.deskVisibleAfterClose || !lifecycle.focusClassAbsent || !lifecycle.reopenedConnected || lifecycle.reopenedSelected !== 'present.server') failures.push('close and reopen lifecycle');
  if (failures.length) {
    throw new Error(`Ontology v2 interaction verification failed (${failures.join(', ')}): ${JSON.stringify({ setup, childFocus, macbookFocus, breadcrumbBack, panAndWheel, farLeftClip, farDepthClip, futurePane, futureLayerIsolation, physicalLayer, futurePhysicalIsolation, emptyPast, lifecycle }, null, 2)}`);
  }

  console.log(JSON.stringify({
    ok: true,
    contextId: contextMatch[1],
    screenshots: [
      `${OUT_PREFIX}-01-present.png`,
      `${OUT_PREFIX}-02-child-focus.png`,
      `${OUT_PREFIX}-02b-macbook-macos.png`,
      `${OUT_PREFIX}-03-pan.png`,
      `${OUT_PREFIX}-03b-far-left-clip.png`,
      `${OUT_PREFIX}-03c-layer-isolation.png`,
      `${OUT_PREFIX}-03d-future-layer-isolation.png`,
      `${OUT_PREFIX}-04-future-physical.png`,
      `${OUT_PREFIX}-04b-future-physical-isolation.png`,
      `${OUT_PREFIX}-05-empty-past.png`,
    ],
    checks: { setup, childFocus, macbookFocus, breadcrumbBack, panAndWheel, farLeftClip, farDepthClip, futurePane, futureLayerIsolation, physicalLayer, futurePhysicalIsolation, emptyPast, lifecycle },
  }, null, 2));
}

main().catch((error) => {
  console.error(error);
  if (stderrBuffer.trim()) console.error(`\n[MCP stderr]\n${stderrBuffer.trim()}`);
  process.exitCode = 1;
}).finally(() => {
  try { proc.stdin.end(); } catch {}
  setTimeout(() => { try { proc.kill('SIGTERM'); } catch {} }, 100);
});
