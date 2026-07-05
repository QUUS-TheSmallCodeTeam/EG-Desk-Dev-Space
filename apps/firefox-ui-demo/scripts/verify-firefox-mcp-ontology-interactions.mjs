#!/usr/bin/env node

import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';

const MCP_PACKAGE = process.env.EGDESK_FIREFOX_MCP_PACKAGE || '@mozilla/firefox-devtools-mcp-moz@latest';
const MCP_BIN = process.env.EGDESK_FIREFOX_MCP_BIN || '';
const MARIONETTE_PORT = process.env.EGDESK_MARIONETTE_PORT || '2828';
const OUT_PREFIX = process.argv[2] || '/tmp/egdesk-ontology-interaction';
const jsSourcePath = fileURLToPath(new URL('../overlay/JS/eg-desk-surface.uc.js', import.meta.url));
const cssSourcePath = fileURLToPath(new URL('../overlay/CSS/eg-desk-surface.uc.css', import.meta.url));
const jsSourceUrl = pathToFileURL(jsSourcePath).href;
const cssText = readFileSync(cssSourcePath, 'utf8');

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
    if (!message.id || !pending.has(message.id)) continue;
    const { resolve, reject } = pending.get(message.id);
    pending.delete(message.id);
    if (message.error) reject(new Error(JSON.stringify(message.error)));
    else resolve(message.result);
  }
});

proc.stderr.on('data', (chunk) => {
  stderrBuffer += chunk.toString();
});

proc.on('exit', (code, signal) => {
  for (const { reject } of pending.values()) reject(new Error(`MCP server exited code=${code} signal=${signal}`));
  pending.clear();
});

function request(method, params = {}, timeoutMs = 15000) {
  const id = nextId++;
  proc.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error(`Timeout waiting for ${method}\nMCP stderr:\n${stderrBuffer.slice(-4000) || '(empty)'}`));
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
  // firefox-devtools-mcp >= 0.7: result JSON is wrapped in a ```json fence
  const fenced = trimmed.match(/```json\s*\n([\s\S]*?)\n```/);
  if (fenced) return JSON.parse(fenced[1]);
  const jsonText = trimmed.startsWith('Result:') ? trimmed.slice('Result:'.length).trim() : trimmed;
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

async function evalChrome(expression, timeoutMs = 30000) {
  const result = await callTool('evaluate_privileged_script', { expression }, timeoutMs);
  return parseToolJson(resultText(result));
}

async function screenshot(name) {
  const path = `${OUT_PREFIX}-${name}.png`;
  await callTool('screenshot_page', { saveTo: path }, 30000);
  return path;
}

const visibleStateExpression = (cardId) => `(() => {
  const card = document.getElementById(${JSON.stringify(cardId)});
  const norm = (text) => String(text || '').replace(/\\s+/g, ' ').trim();
  const rectFor = (node) => {
    const rect = node.getBoundingClientRect();
    return {
      id: node.dataset?.id || node.closest?.('[data-phase]')?.dataset?.phase || norm(node.textContent) || node.className?.baseVal || node.className || 'node',
      left: rect.left,
      right: rect.right,
      top: rect.top,
      bottom: rect.bottom,
      width: rect.width,
      height: rect.height,
    };
  };
  const opacityFor = (node) => {
    let opacity = 1;
    let current = node;
    while (current && current !== card) {
      const styleOpacity = globalThis.getComputedStyle ? Number(globalThis.getComputedStyle(current).opacity) : 1;
      if (Number.isFinite(styleOpacity)) opacity *= styleOpacity;
      const attrOpacity = current.getAttribute?.('opacity');
      if (attrOpacity !== null && attrOpacity !== undefined && attrOpacity !== '') {
        const value = Number(attrOpacity);
        if (Number.isFinite(value)) opacity *= value;
      }
      current = current.parentNode;
    }
    return opacity;
  };
  const overlapArea = (a, b) => {
    const width = Math.min(a.right, b.right) - Math.max(a.left, b.left);
    const height = Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top);
    return width > 0 && height > 0 ? width * height : 0;
  };
  const pairOverlaps = (items, threshold = 12) => {
    const pairs = [];
    for (let i = 0; i < items.length; i += 1) {
      for (let j = i + 1; j < items.length; j += 1) {
        if (items[i].phase && items[j].phase && items[i].phase !== items[j].phase) continue;
        const area = overlapArea(items[i].rect, items[j].rect);
        if (area > threshold) pairs.push({ a: items[i].id, b: items[j].id, area: Math.round(area) });
      }
    }
    return pairs;
  };
  const activeGrammar = [...card.querySelectorAll('.egd-ontology-guide-grammar-chip-active')]
    .map((node) => node.dataset.label || norm(node.textContent))
    .filter(Boolean);
  const guideLabels = [...card.querySelectorAll('.egd-ontology-novice-guide text')]
    .map((node) => norm(node.textContent))
    .filter(Boolean);
  const conceptBoxes = [
    ...[...card.querySelectorAll('.egd-ontology-node .egd-ontology-node-box')]
      .map((box) => {
        const node = box.closest('.egd-ontology-node');
        return {
          id: node?.dataset?.id || norm(node?.textContent),
          node: box,
          phase: node?.dataset?.phase || node?.closest?.('.egd-ontology-pane-content')?.dataset?.phase || '',
        };
      }),
    ...[...card.querySelectorAll('.egd-ontology-reference-node rect')]
      .map((box) => {
        const node = box.closest('.egd-ontology-reference-node');
        return { id: 'ref:' + norm(node?.textContent), node: box };
      }),
  ];
  const visibleConceptBoxes = conceptBoxes
    .filter((item) => opacityFor(item.node) > 0.05)
    .map((item) => ({ id: item.id, phase: item.phase || '', rect: rectFor(item.node) }))
    .filter((item) => item.rect.width > 8 && item.rect.height > 8);
  const visibleDeckNodes = [...card.querySelectorAll('.egd-ontology-deck-node')]
    .filter((node) => opacityFor(node) > 0.05)
    .map((node) => ({
      id: node.dataset?.id || norm(node.textContent),
      phase: node.dataset?.phase || '',
      depth: node.dataset?.depth || ['virtual', 'information', 'physical'].find((depth) => node.classList.contains('egd-ontology-depth-' + depth)) || '',
      stroke: node.querySelector('.egd-ontology-node-box')?.getAttribute('stroke') || '',
    }))
    .filter((item) => item.depth);
  const visibleDeckDepths = [...new Set(visibleDeckNodes.map((item) => item.depth))].sort();
  const panes = ['past', 'present', 'future']
    .map((phase) => {
      const hit = card.querySelector(\`.egd-ontology-time-pane-\${phase} .egd-ontology-pane-hit\`);
      return hit ? { id: phase, rect: rectFor(hit) } : null;
    })
    .filter(Boolean);
  const lowerPhysicalSurface = card.querySelector('.egd-ontology-deck-reference-lower-physical');
  const deckRightLift = (selector) => {
    const numbers = (card.querySelector(selector)?.getAttribute('d') || '')
      .match(/-?\\d+(?:\\.\\d+)?/g)
      ?.map(Number) || [];
    if (numbers.length < 8) return null;
    return {
      top: Math.round((numbers[3] - numbers[1]) * 10) / 10,
      bottom: Math.round((numbers[5] - numbers[7]) * 10) / 10,
    };
  };
  const keyLabels = ['현재', '미래', '과거', '개념', 'egdesk', '데스크톱 조립체', '목표'];
  const forbiddenLabels = ['초점', '가상', '물리', '시간 안', '시간 간', '현재 pane 내부', '시간 pane 간', '포함', '선택 경로'];
  return {
    activePane: card._ontologyState?.activePane,
    activeDepth: card._ontologyState?.activeDepth,
    focusTarget: card._ontologyState?.focusTarget,
    selectedId: card._ontologyState?.selectedId,
    detailTitle: norm(card.querySelector('.egd-ontology-detail-title')?.textContent),
    visibleDeckDepths,
    visibleDeckNodes,
    activeGrammar,
    hasInteractionHud: Boolean(card.querySelector('.egd-ontology-nav-hud')),
    hasHeaderModeButtons: Boolean(card.querySelector('.egd-ontology-mode-btn[data-mode], .egd-ontology-depth-btn, .egd-ontology-tilt')),
    hasUpperReferenceSurface: Boolean(card.querySelector('.egd-ontology-deck-reference-upper-world')),
    hasMultiversePaneSurface: Boolean(card.querySelector('.egd-ontology-time-pane-multiverse .egd-ontology-pane-hit')),
    hasDeckBoundaryGates: Boolean(card.querySelector('.egd-ontology-deck-gate, .egd-ontology-deck-gate-line, .egd-ontology-deck-gate-port')),
    visibleTimePaneCount: panes.length,
    lowerPhysicalSurfaceOpacity: lowerPhysicalSurface ? opacityFor(lowerPhysicalSurface) : 0,
    presentDeckRightLift: deckRightLift('.egd-ontology-deck-pane-present .egd-ontology-deck-surface'),
    lowerPhysicalRightLift: deckRightLift('.egd-ontology-deck-reference-lower-physical'),
    visibleKeyLabels: keyLabels.filter((label) => guideLabels.includes(label)),
    forbiddenVisibleLabels: forbiddenLabels.filter((label) => guideLabels.includes(label)),
    layout: {
      nodeOverlapPairs: pairOverlaps(visibleConceptBoxes, 4),
      paneOverlapPairs: pairOverlaps(panes, 1),
    },
  };
})()`;

async function main() {
  await request('initialize', {
    protocolVersion: '2024-11-05',
    capabilities: {},
    clientInfo: { name: 'egdesk-ontology-interaction-review', version: '0.1.0' },
  }, 60000);
  notify('notifications/initialized');

  const contexts = await callTool('list_privileged_contexts');
  const contextText = resultText(contexts);
  const contextMatch = contextText.match(/\s([0-9a-f-]{36}): chrome:\/\/browser\/content\/browser\.xhtml/);
  if (!contextMatch) throw new Error(`Firefox chrome context not found.\n${contextText}`);
  await callTool('select_privileged_context', { contextId: contextMatch[1] });

  const remount = await evalChrome(`(async () => {
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
  })()`);
  if (!remount.hasApi || !remount.hasRail) {
    throw new Error(`Overlay remount failed: ${JSON.stringify(remount, null, 2)}`);
  }

  const setup = await evalChrome(`(() => {
    const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
    const api = window.__egdesk;
    if (!api?.cardRuntime?.openOntologyMapCard) return { hasApi: false };
    const card = api.cardRuntime.openOntologyMapCard({
      mode: 'focus',
      selectedId: 'entity.llm_chat_session',
      focusTarget: 'pane',
      activePane: 'present',
      activeDepth: 'virtual',
    });
    return wait(900).then(() => {
      if (card._ontologyState) {
        card._ontologyState.selectedId = 'entity.llm_chat_session';
        card._ontologyState.focusTarget = 'pane';
        card._ontologyState.activePane = 'present';
        card._ontologyState.activeDepth = 'virtual';
      }
      if (typeof card._ontologyRender === 'function') card._ontologyRender();
      return wait(300).then(() => ({
        hasApi: true,
        cardId: card.id,
        mode: card._ontologyState?.mode,
        focusTarget: card._ontologyState?.focusTarget,
        activePane: card._ontologyState?.activePane,
        activeDepth: card._ontologyState?.activeDepth,
      }));
    });
  })()`);
  if (!setup.hasApi) throw new Error('missing ontology card API');

  const states = [];
  states.push({
    name: '01-present',
    path: await screenshot('01-present'),
    state: {
      ...setup,
      visible: await evalChrome(visibleStateExpression(setup.cardId)),
    },
  });

  const steps = [
    ['02-past-click', `(() => {
      const card = document.getElementById(${JSON.stringify(setup.cardId)});
      card.querySelector('.egd-ontology-time-pane-past .egd-ontology-pane-hit')?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      return new Promise((resolve) => setTimeout(() => resolve({
        activePane: card._ontologyState?.activePane,
        activeDepth: card._ontologyState?.activeDepth,
        detailTitle: card.querySelector('.egd-ontology-detail-title')?.textContent || '',
      }), 250));
    })()`],
    ['03-future-click', `(() => {
      const card = document.getElementById(${JSON.stringify(setup.cardId)});
      card.querySelector('.egd-ontology-time-pane-future .egd-ontology-pane-hit')?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      return new Promise((resolve) => setTimeout(() => resolve({
        activePane: card._ontologyState?.activePane,
        activeDepth: card._ontologyState?.activeDepth,
        detailTitle: card.querySelector('.egd-ontology-detail-title')?.textContent || '',
      }), 250));
    })()`],
    ['04-horizontal-scroll', `(() => {
      const card = document.getElementById(${JSON.stringify(setup.cardId)});
      card.querySelector('.egd-ontology-time-pane-present .egd-ontology-pane-hit')?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      if (card._ontologyState) card._ontologyState.lastWheelNavAt = 0;
      card._ontologyApplyWheelDelta?.(180, 0);
      return new Promise((resolve) => setTimeout(() => resolve({
        activePane: card._ontologyState?.activePane,
        activeDepth: card._ontologyState?.activeDepth,
        detailTitle: card.querySelector('.egd-ontology-detail-title')?.textContent || '',
      }), 250));
    })()`],
    ['05-vertical-depth', `(() => {
      const card = document.getElementById(${JSON.stringify(setup.cardId)});
      card.querySelector('.egd-ontology-time-pane-present .egd-ontology-pane-hit')?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      if (card._ontologyState) card._ontologyState.lastWheelNavAt = 0;
      card._ontologyApplyWheelDelta?.(0, 120);
      return new Promise((resolve) => setTimeout(() => resolve({
        activePane: card._ontologyState?.activePane,
        activeDepth: card._ontologyState?.activeDepth,
        detailTitle: card.querySelector('.egd-ontology-detail-title')?.textContent || '',
      }), 250));
    })()`],
    ['06-layer-band-click', `(() => {
      const card = document.getElementById(${JSON.stringify(setup.cardId)});
      card.querySelector('.egd-ontology-time-pane-present .egd-ontology-pane-hit')?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      if (card._ontologyState) card._ontologyState.activeDepth = 'virtual';
      const layerHit = card.querySelector('.egd-ontology-depth-hit-present.egd-ontology-depth-hit-information');
      layerHit?.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
      return new Promise((resolve) => setTimeout(() => resolve({
        activePane: card._ontologyState?.activePane,
        activeDepth: card._ontologyState?.activeDepth,
        detailTitle: card.querySelector('.egd-ontology-detail-title')?.textContent || '',
        layerHitFound: Boolean(layerHit),
        informationNodesVisible: ['terminal', 'projection.llm_chat_session.storage.session_file'].every((id) => Boolean(card.querySelector('[data-id="' + id + '"][data-depth="information"]'))),
      }), 250));
    })()`],
    ['06b-physical-layer-click', `(() => {
      const card = document.getElementById(${JSON.stringify(setup.cardId)});
      card.querySelector('.egd-ontology-time-pane-present .egd-ontology-pane-hit')?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      const layerHit = card.querySelector('.egd-ontology-depth-hit-present.egd-ontology-depth-hit-physical');
      layerHit?.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
      return new Promise((resolve) => setTimeout(() => resolve({
        activePane: card._ontologyState?.activePane,
        activeDepth: card._ontologyState?.activeDepth,
        detailTitle: card.querySelector('.egd-ontology-detail-title')?.textContent || '',
        layerHitFound: Boolean(layerHit),
        physicalNodeOnPhysicalPane: (() => {
          const pane = card.querySelector('.egd-ontology-deck-reference-lower-physical');
          if (!pane) return false;
          const paneRect = pane.getBoundingClientRect();
          return ['cpu', 'ram', 'disk'].every((id) => {
            const node = card.querySelector('[data-id="' + id + '"][data-depth="physical"] .egd-ontology-node-box');
            if (!node) return false;
            const nodeRect = node.getBoundingClientRect();
            return nodeRect.top >= paneRect.top - 8 && nodeRect.bottom <= paneRect.bottom + 8;
          });
        })(),
      }), 250));
    })()`],
    ['07-relation-click', `(() => {
      const card = document.getElementById(${JSON.stringify(setup.cardId)});
      card.querySelector('.egd-ontology-time-pane-present .egd-ontology-pane-hit')?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      if (card._ontologyState) {
        card._ontologyState.activeDepth = 'virtual';
        if (typeof card._ontologyRender === 'function') card._ontologyRender();
      }
      const relation = card.querySelector('.egd-ontology-clickable-relation');
      relation?.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
      return new Promise((resolve) => setTimeout(() => resolve({
        relationCount: card.querySelectorAll('.egd-ontology-clickable-relation').length,
        focusTarget: card._ontologyState?.focusTarget,
        detailTitle: card.querySelector('.egd-ontology-detail-title')?.textContent || '',
        selectedRelation: card._ontologyState?.selectedRelation || null,
      }), 250));
    })()`],
    ['08-goal-select', `(() => {
      const card = document.getElementById(${JSON.stringify(setup.cardId)});
      card.querySelector('.egd-ontology-time-pane-future .egd-ontology-pane-hit')?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      return new Promise((resolve) => setTimeout(() => resolve({
        beforeClickPane: card._ontologyState?.activePane,
        goalFound: Boolean(card.querySelector('[data-id="goal"]')),
      }), 150));
    })()`],
    ['09-goal-lens', `(() => {
      const card = document.getElementById(${JSON.stringify(setup.cardId)});
      card.querySelector('[data-id="goal"]')?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      return new Promise((resolve) => setTimeout(() => resolve({
        focusTarget: card._ontologyState?.focusTarget,
        selectedId: card._ontologyState?.selectedId,
        detailTitle: card.querySelector('.egd-ontology-detail-title')?.textContent || '',
        guideGoalGateCount: card.querySelectorAll('.egd-ontology-guide-goal-gate').length,
        guideGoalGatePortCount: card.querySelectorAll('.egd-ontology-guide-goal-gate-port').length,
        guideGoalBridgeCount: card.querySelectorAll('.egd-ontology-guide-goal-bridge').length,
        guideGoalEndpointCount: card.querySelectorAll('.egd-ontology-guide-goal-endpoint').length,
      }), 250));
    })()`],
    ['10-control-cleanup', `(() => {
      const card = document.getElementById(${JSON.stringify(setup.cardId)});
      return new Promise((resolve) => setTimeout(() => resolve({
        hasModeButtons: Boolean(card.querySelector('.egd-ontology-mode-btn[data-mode]')),
        hasDepthButtons: Boolean(card.querySelector('.egd-ontology-depth-btn')),
        hasTilt: Boolean(card.querySelector('.egd-ontology-tilt')),
        hasNavHud: Boolean(card.querySelector('.egd-ontology-nav-hud')),
      }), 250));
    })()`],
    ['11-pane-drag-slide', `(() => {
      const card = document.getElementById(${JSON.stringify(setup.cardId)});
      const normRect = (node) => {
        const rect = node.getBoundingClientRect();
        return { left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom };
      };
      if (card._ontologyState) {
        card._ontologyState.selectedId = 'entity.llm_chat_session';
        card._ontologyState.focusTarget = 'pane';
        card._ontologyState.activePane = 'present';
        card._ontologyState.activeDepth = 'virtual';
        card._ontologyState.paneSlides = {};
        if (typeof card._ontologyRender === 'function') card._ontologyRender();
      }
      const stage = card.querySelector('.egd-ontology-stage');
      const paneHit = card.querySelector('.egd-ontology-time-pane-present .egd-ontology-pane-hit');
      const node = card.querySelector('[data-id="entity.llm_chat_session"] .egd-ontology-node-box');
      const beforePane = paneHit ? normRect(paneHit) : null;
      const beforeNode = node ? normRect(node) : null;
      stage?.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true, button: 0, clientX: 720, clientY: 430 }));
      document.dispatchEvent(new MouseEvent('mousemove', { bubbles: true, cancelable: true, clientX: 940, clientY: 510 }));
      document.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, cancelable: true, clientX: 940, clientY: 510 }));
      return new Promise((resolve) => setTimeout(() => {
        const afterPaneHit = card.querySelector('.egd-ontology-time-pane-present .egd-ontology-pane-hit');
        const afterPane = afterPaneHit ? normRect(afterPaneHit) : null;
        const afterNode = card.querySelector('[data-id="entity.llm_chat_session"] .egd-ontology-node-box');
        const afterNodeRect = afterNode ? normRect(afterNode) : null;
        resolve({
          activePane: card._ontologyState?.activePane,
          activeDepth: card._ontologyState?.activeDepth,
          paneSlide: card._ontologyState?.paneSlides?.['present:virtual'] || null,
          paneDelta: beforePane && afterPane ? {
            x: Math.round(afterPane.left - beforePane.left),
            y: Math.round(afterPane.top - beforePane.top),
          } : null,
          nodeDelta: beforeNode && afterNodeRect ? {
            x: Math.round(afterNodeRect.left - beforeNode.left),
            y: Math.round(afterNodeRect.top - beforeNode.top),
          } : null,
        });
      }, 250));
    })()`],
  ];

  for (const [name, expression] of steps) {
    const state = await evalChrome(expression);
    states.push({
      name,
      path: await screenshot(name),
      state: {
        ...state,
        visible: await evalChrome(visibleStateExpression(setup.cardId)),
      },
    });
  }

  const failures = [];
  const byName = new Map(states.map((entry) => [entry.name, entry.state]));
  if (byName.get('02-past-click')?.detailTitle !== '과거 시간대') failures.push('past pane click');
  if (byName.get('03-future-click')?.detailTitle !== '미래 시간대') failures.push('future pane click');
  if (byName.get('04-horizontal-scroll')?.activePane !== 'future' || byName.get('04-horizontal-scroll')?.activeDepth !== 'virtual') failures.push('horizontal wheel changed pane/depth');
  if (byName.get('05-vertical-depth')?.activePane !== 'present' || byName.get('05-vertical-depth')?.activeDepth !== 'information') failures.push('vertical wheel changed depth');
  if (!byName.get('06-layer-band-click')?.layerHitFound || byName.get('06-layer-band-click')?.activeDepth !== 'information') failures.push('information layer band click');
  if (!byName.get('06-layer-band-click')?.informationNodesVisible) failures.push('information nodes not on information layer');
  if (!byName.get('06b-physical-layer-click')?.layerHitFound || byName.get('06b-physical-layer-click')?.activeDepth !== 'physical') failures.push('physical layer band click');
  if (!byName.get('06b-physical-layer-click')?.physicalNodeOnPhysicalPane) failures.push('physical nodes not on physical pane');
  if (byName.get('07-relation-click')?.relationCount < 1 || byName.get('07-relation-click')?.focusTarget !== 'relation' || byName.get('07-relation-click')?.detailTitle !== '관계') failures.push('relation click detail');
  if (byName.get('08-goal-select')?.beforeClickPane !== 'future' || !byName.get('08-goal-select')?.goalFound) failures.push('goal visible in future pane');
  const goalState = byName.get('09-goal-lens') || {};
  if (goalState.selectedId !== 'goal' || goalState.detailTitle !== '목표') failures.push('goal selection');
  if (goalState.guideGoalGateCount !== 2) failures.push('goal pane gates');
  if (goalState.guideGoalGatePortCount !== 2) failures.push('goal gate ports');
  if (goalState.guideGoalBridgeCount !== 1) failures.push('goal bridge');
  if (goalState.guideGoalEndpointCount !== 2) failures.push('goal endpoints');
  const cleanup = byName.get('10-control-cleanup') || {};
  if (cleanup.hasModeButtons || cleanup.hasDepthButtons || cleanup.hasTilt || cleanup.hasNavHud) failures.push('legacy control cleanup');
  const dragSlide = byName.get('11-pane-drag-slide') || {};
  if (Math.abs(dragSlide.paneDelta?.x || 0) > 2 || Math.abs(dragSlide.paneDelta?.y || 0) > 2) failures.push('pane drag moved frame');
  if (Math.abs(dragSlide.nodeDelta?.x || 0) < 12 && Math.abs(dragSlide.nodeDelta?.y || 0) < 8) failures.push('pane drag did not slide objects');
  if (Math.abs(dragSlide.paneSlide?.u || 0) <= 0.16 || Math.abs(dragSlide.paneSlide?.v || 0) <= 0.10) failures.push('pane drag still finite');
  {
    const nodeX = Math.abs(dragSlide.nodeDelta?.x || 0);
    const nodeY = Math.abs(dragSlide.nodeDelta?.y || 0);
    if (nodeX > 1 && nodeY > 1 && Math.abs(nodeX - nodeY) / Math.max(nodeX, nodeY) < 0.18) {
      failures.push('pane drag is literal 45-degree screen snap');
    }
  }
  if (byName.get('01-present')?.visible?.hasHeaderModeButtons || byName.get('01-present')?.visible?.hasInteractionHud) failures.push('legacy interaction controls visible');
  if (byName.get('01-present')?.visible?.hasUpperReferenceSurface) failures.push('upper world pane still visible');
  if (byName.get('01-present')?.visible?.hasMultiversePaneSurface) failures.push('multiverse pane still visible');
  if (byName.get('01-present')?.visible?.hasDeckBoundaryGates) failures.push('present pane boundary gates still visible');
  if (byName.get('01-present')?.visible?.visibleTimePaneCount !== 3) failures.push('expected past/present/future panes only');
  if ((byName.get('01-present')?.visible?.lowerPhysicalSurfaceOpacity || 0) < 0.25) failures.push('physical pane not visible in default shape');
  const presentRightLift = byName.get('01-present')?.visible?.presentDeckRightLift;
  if (!presentRightLift || Math.abs(presentRightLift.top) > 1.5 || Math.abs(presentRightLift.bottom) > 1.5) failures.push('present pane right edge visually lifted');
  const lowerPhysicalRightLift = byName.get('01-present')?.visible?.lowerPhysicalRightLift;
  if (!lowerPhysicalRightLift || Math.abs(lowerPhysicalRightLift.top) > 1.5 || Math.abs(lowerPhysicalRightLift.bottom) > 1.5) failures.push('physical pane right edge visually lifted');
  for (const entry of states) {
    if (entry.state?.visible?.forbiddenVisibleLabels?.length) {
      failures.push(`forbidden canvas labels in ${entry.name}: ${entry.state.visible.forbiddenVisibleLabels.join(', ')}`);
    }
    if (entry.state?.visible?.layout?.paneOverlapPairs?.length) {
      failures.push(`pane overlaps in ${entry.name}: ${JSON.stringify(entry.state.visible.layout.paneOverlapPairs)}`);
    }
    if (entry.state?.visible?.layout?.nodeOverlapPairs?.length) {
      failures.push(`node overlaps in ${entry.name}: ${JSON.stringify(entry.state.visible.layout.nodeOverlapPairs)}`);
    }
    const activeDepth = entry.state?.visible?.activeDepth;
    const visibleDeckDepths = entry.state?.visible?.visibleDeckDepths || [];
    if (visibleDeckDepths.some((depth) => depth !== activeDepth)) {
      failures.push(`mixed concept depths in ${entry.name}: active=${activeDepth} visible=${visibleDeckDepths.join(', ')}`);
    }
    const visibleStrokes = [...new Set((entry.state?.visible?.visibleDeckNodes || []).map((node) => node.stroke).filter(Boolean))];
    if (visibleStrokes.length > 1) {
      failures.push(`mixed concept colors in ${entry.name}: ${visibleStrokes.join(', ')}`);
    }
  }
  if (failures.length) {
    throw new Error(`Ontology interaction verification failed (${failures.join(', ')}): ${JSON.stringify(states, null, 2)}`);
  }

  console.log(JSON.stringify({
    ok: true,
    contextId: contextMatch[1],
    states,
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
