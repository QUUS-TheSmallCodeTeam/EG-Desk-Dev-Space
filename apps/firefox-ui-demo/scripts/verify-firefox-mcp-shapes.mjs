#!/usr/bin/env node

import { spawn } from 'node:child_process';

const MCP_PACKAGE = process.env.EGDESK_FIREFOX_MCP_PACKAGE || '@mozilla/firefox-devtools-mcp-moz@latest';
const MARIONETTE_PORT = process.env.EGDESK_MARIONETTE_PORT || '2828';
const SCREENSHOT_PATH = process.argv[2] || '/tmp/egdesk-shape-drawing-final.png';

const proc = spawn('npx', [
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
  // firefox-devtools-mcp >= 0.7: result JSON is wrapped in a ```json fence
  const fenced = trimmed.match(/```json\s*\n([\s\S]*?)\n```/);
  if (fenced) return JSON.parse(fenced[1]);
  const jsonText = trimmed.startsWith('Result:')
    ? trimmed.slice('Result:'.length).trim()
    : trimmed;
  return JSON.parse(jsonText);
}

async function callTool(name, args = {}) {
  let toolArgs = args;
  // firefox-devtools-mcp >= 0.7: evaluate_privileged_script takes `function`
  // (callable string) instead of `expression`. Wrap legacy IIFE expressions.
  if (name === 'evaluate_privileged_script' && typeof toolArgs.expression === 'string') {
    toolArgs = { function: `() => (
${toolArgs.expression}
)` };
  }
  return request('tools/call', { name, arguments: toolArgs });
}

async function main() {
  await request('initialize', {
    protocolVersion: '2024-11-05',
    capabilities: {},
    clientInfo: { name: 'egdesk-firefox-mcp-shape-verify', version: '0.1.0' },
  });
  notify('notifications/initialized');

  const contexts = await callTool('list_privileged_contexts');
  const contextText = resultText(contexts);
  const contextMatch = contextText.match(/\s([0-9a-f-]{36}): chrome:\/\/browser\/content\/browser\.xhtml/);
  if (!contextMatch) {
    throw new Error(`Firefox chrome context not found.\n${contextText}`);
  }

  await callTool('select_privileged_context', { contextId: contextMatch[1] });

  const result = resultText(await callTool('evaluate_privileged_script', {
    expression: `(() => {
      const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
      const mouse = (target, type, x, y) => {
        const event = new MouseEvent(type, {
          bubbles: true,
          cancelable: true,
          clientX: x,
          clientY: y,
          button: 0,
          buttons: type === 'mouseup' ? 0 : 1,
          view: window,
        });
        target.dispatchEvent(event);
      };
      const clickTool = (id) => {
        const button = Array.from(document.querySelectorAll('.egd-dock-btn')).find((node) => node.dataset.id === id);
        if (!button) throw new Error('missing dock tool: ' + id);
        button.click();
      };
      const draw = (tool, startX, startY, endX, endY) => {
        const viewport = document.getElementById('egd-canvas-viewport');
        if (!viewport) throw new Error('missing canvas viewport');
        clickTool(tool);
        mouse(viewport, 'mousedown', startX, startY);
        mouse(window, 'mousemove', endX, endY);
        mouse(window, 'mouseup', endX, endY);
      };
      const dragShape = (shape, dx, dy) => {
        const rect = shape.getBoundingClientRect();
        const x = Math.round(rect.left + rect.width / 2);
        const y = Math.round(rect.top + rect.height / 2);
        mouse(shape, 'mousedown', x, y);
        mouse(window, 'mousemove', x + dx, y + dy);
        mouse(window, 'mouseup', x + dx, y + dy);
      };

      let dragMoved = false;
      let deleteSelectedWorked = false;

      return wait(200).then(() => {
        document.querySelectorAll('.egd-canvas-shape').forEach((shape) => {
          if (typeof shape._cleanup === 'function') shape._cleanup();
          shape.remove();
        });
        draw('square', 620, 260, 790, 380);
        draw('ellipse', 830, 260, 960, 390);
        draw('line', 680, 430, 960, 520);
        const rectShape = document.querySelector('.egd-canvas-shape-rect');
        const rectBefore = rectShape ? {
          left: parseFloat(rectShape.style.left) || 0,
          top: parseFloat(rectShape.style.top) || 0,
        } : null;
        if (rectShape) dragShape(rectShape, 24, 16);
        const rectAfter = rectShape ? {
          left: parseFloat(rectShape.style.left) || 0,
          top: parseFloat(rectShape.style.top) || 0,
        } : null;
        dragMoved = !!rectBefore && !!rectAfter
          && rectAfter.left > rectBefore.left
          && rectAfter.top > rectBefore.top;
        const lineBeforeDelete = document.querySelector('.egd-canvas-shape-line');
        if (lineBeforeDelete) {
          lineBeforeDelete.dispatchEvent(new MouseEvent('mousedown', {
            bubbles: true,
            cancelable: true,
            clientX: Math.round(lineBeforeDelete.getBoundingClientRect().left + 8),
            clientY: Math.round(lineBeforeDelete.getBoundingClientRect().top + 8),
            button: 0,
            buttons: 1,
            view: window,
          }));
          mouse(window, 'mouseup', Math.round(lineBeforeDelete.getBoundingClientRect().left + 8), Math.round(lineBeforeDelete.getBoundingClientRect().top + 8));
        }
        clickTool('trash');
        deleteSelectedWorked = document.querySelectorAll('.egd-canvas-shape').length === 2
          && !document.querySelector('.egd-canvas-shape-line');
        draw('line', 680, 430, 960, 520);
        clickTool('arrow');
        return wait(100);
      }).then(() => {
        const shapes = Array.from(document.querySelectorAll('.egd-canvas-shape')).map((shape) => {
          const rect = shape.getBoundingClientRect();
          return {
            id: shape.id,
            type: shape.dataset.shapeType,
            className: shape.className,
            left: Math.round(rect.left),
            top: Math.round(rect.top),
            width: Math.round(rect.width),
            height: Math.round(rect.height),
            selected: shape.classList.contains('egd-entity-selected'),
            active: shape.classList.contains('egd-entity-active'),
          };
        });
        return {
          activeTool: window.__egdesk?.state?.activeTool,
          rootTool: document.documentElement.dataset.egdActiveTool,
          shapeCount: shapes.length,
          dragMoved,
          deleteSelectedWorked,
          types: shapes.map((shape) => shape.type),
          shapes,
        };
      });
    })()`,
  }));

  const parsed = parseToolJson(result);
  const expectedTypes = ['rect', 'ellipse', 'line'];
  const typeSet = new Set(parsed.types);
  const missing = expectedTypes.filter((type) => !typeSet.has(type));
  const invalidSize = parsed.shapes.filter((shape) => shape.width < 12 || shape.height < 12);
  if (parsed.shapeCount !== 3 || missing.length || invalidSize.length || !parsed.dragMoved || !parsed.deleteSelectedWorked) {
    throw new Error(`Shape verification failed: ${JSON.stringify({ parsed, missing, invalidSize }, null, 2)}`);
  }

  const screenshot = resultText(await callTool('screenshot_page', { saveTo: SCREENSHOT_PATH }));

  console.log(JSON.stringify({
    ok: true,
    screenshot: SCREENSHOT_PATH,
    result: parsed,
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
