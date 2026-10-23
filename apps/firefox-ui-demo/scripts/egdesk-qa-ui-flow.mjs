import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { FirefoxMcpChatHarness, waitUntil } from './firefox-mcp-chat-harness.mjs';
import { qaProfileSourceFingerprints } from './egdesk-chat-qa-profile.mjs';

export function option(name, fallback = null) {
  const index = process.argv.indexOf(name);
  if (index < 0) return fallback;
  if (!process.argv[index + 1] || process.argv[index + 1].startsWith('--')) throw new Error(`${name} requires a value`);
  return process.argv[index + 1];
}

export const selectorForId = (id) => `[id=${JSON.stringify(id)}]`;
export const attributeSelector = (name, value) => `[${name}=${JSON.stringify(value)}]`;
export const chrome = (harness, fn, arg = null) =>
  harness.evaluateChrome(`async () => await (${fn.toString()})(${JSON.stringify(arg)})`);

export async function loopbackJson(route, { method = 'GET', body, token, includeHttpStatus = false } = {}) {
  if (typeof route !== 'string' || !route.startsWith('/') || route.startsWith('//')) throw new Error('Expected local bridge route');
  const response = await fetch(`http://127.0.0.1:39218${route}`, {
    method, redirect: 'error', signal: AbortSignal.timeout(10000),
    headers: { ...(body ? { 'Content-Type': 'application/json' } : {}), ...(token ? { 'X-EGDESK-QA-Token': token } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const value = await response.json();
  if (!response.ok) throw new Error(`${route.split('?')[0]} failed (${response.status}): ${value.code || value.error?.code || value.error || 'request failed'}`);
  return includeHttpStatus ? { httpStatus: response.status, body: value } : value;
}

export async function visible(harness, selector, timeoutMs = 15000) {
  try {
    return await waitUntil(() => harness.inspect(selector),
      (nodes) => nodes.length > 0 && nodes.some((node) => node.visible), { timeoutMs });
  } catch (error) {
    throw new Error(`${selector} did not become visible: ${error.message}`);
  }
}

export async function runUiFlow(kind, callback) {
  const profile = option('--profile', process.env.EGDESK_FIREFOX_PROFILE);
  assert.ok(profile, '--profile is required');
  let harness;
  const cleanup = [];
  const result = { kind, automatedAssertionsPassed: false, visualReview: 'pending',
    checks: [], screenshots: [], providerTurn: 'not-run' };
  try {
    harness = new FirefoxMcpChatHarness({ profile });
    result.profileSources = qaProfileSourceFingerprints(profile);
    await harness.connect();
    const context = {
      harness, result,
      defer(fn) { cleanup.push(fn); },
      check(label, condition, details = undefined) {
        result.checks.push({ label, passed: Boolean(condition), ...(details === undefined ? {} : { details }) });
        assert.ok(condition, label);
      },
      // Headless Gecko rejects BiDi page screenshots; the harness then draws the
      // owned headless Chrome window only, within an explicit deadline.
      async capture(name) {
        const screenshot = await harness.screenshot(name, { allowHeadlessChromeFallback: true, deadlineMs: Date.now() + 90000 });
        result.screenshots.push(screenshot);
        return screenshot;
      },
    };
    await callback(context);
    result.automatedAssertionsPassed = true;
  } catch (error) {
    result.error = error.message;
    if (harness) {
      try { result.screenshots.push(await harness.screenshot('failure', { allowHeadlessChromeFallback: true, deadlineMs: Date.now() + 90000 })); } catch {}
    }
    process.exitCode = 1;
  } finally {
    for (const fn of cleanup.reverse()) {
      try { await fn(); } catch (error) { result.automatedAssertionsPassed = false; result.cleanupError = error.message; process.exitCode = 1; }
    }
    try { await harness?.close(); }
    catch (error) { result.automatedAssertionsPassed = false; result.cleanupError = error.message; process.exitCode = 1; }
    if (harness?.evidenceDir) {
      result.evidenceFile = path.join(harness.evidenceDir, 'result.json');
      fs.writeFileSync(result.evidenceFile, `${JSON.stringify(result, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
    }
    process.stdout.write(`${JSON.stringify(result)}\n`);
  }
}

export async function chatIdentity(harness) {
  return chrome(harness, () => {
    const codex = window.__egdesk?.state?.codex;
    if (!codex) throw new Error('Chat state is unavailable');
    const thread = codex.threads.find((item) => item.id === codex.activeThreadId);
    return { threadId: thread?.id || null, conversationId: thread?.conversationId || null,
      sendError: thread?.sendError || null,
      runs: (window.__egdesk.codexBridge.runState?.(thread?.id) || [])
        .map((run) => ({ runId: run.runId, conversationId: run.conversationId, status: run.status, stopRequested: run.stopRequested })) };
  });
}

export async function observeChatEvents(clientThreadId) {
  const controller = new AbortController();
  const response = await fetch('http://127.0.0.1:39218/events?chatProtocol=2', { signal: controller.signal, redirect: 'error' });
  if (!response.ok || !response.body) throw new Error(`Chat event observation failed (${response.status})`);
  const events = [];
  let failure = null;
  const reading = (async () => {
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true }).replace(/\r\n/g, '\n');
        let end;
        while ((end = buffer.indexOf('\n\n')) >= 0) {
          const frame = buffer.slice(0, end);
          buffer = buffer.slice(end + 2);
          const data = frame.split('\n').filter(line => line.startsWith('data:')).map(line => line.slice(5).trimStart()).join('\n');
          if (!data) continue;
          let event;
          try { event = JSON.parse(data); } catch { continue; }
          if (event.type === 'chat.event' && event.v === 2 && event.provider === 'codex' && event.clientThreadId === clientThreadId) events.push(event);
        }
      }
    } catch (error) { if (!controller.signal.aborted) failure = error; }
    finally { reader.releaseLock(); }
  })();
  return { events, get failure() { return failure; }, async close() { controller.abort(); await reading; } };
}

// "Open" means usable: wholly inside the window and clear of the Dock. A Chat the
// camera left behind (a Browser opened beside it) still has a size, so size alone
// says nothing; its composer can sit below the window or behind the Dock.
export function chatShellUsable(shell, dock, view) {
  if (!shell || !(shell.width > 0 && shell.height > 0) || !(view?.width > 0 && view?.height > 0)) return false;
  const inside = shell.left >= -0.5 && shell.top >= -0.5 && shell.right <= view.width + 0.5 && shell.bottom <= view.height + 0.5;
  const underDock = !!dock && dock.width > 0 && dock.height > 0 &&
    shell.left < dock.right && shell.right > dock.left && shell.top < dock.bottom && shell.bottom > dock.top;
  return inside && !underDock;
}

const chatUsableNow = (harness) => chrome(harness, () => {
  const box = (node) => {
    const rect = node?.getBoundingClientRect();
    return rect ? { left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom, width: rect.width, height: rect.height } : null;
  };
  return { shell: box(document.querySelector('.egd-codex-chat-shell')), dock: box(document.getElementById('egd-dock')),
    view: { width: window.innerWidth, height: window.innerHeight } };
});

// A person brings a left-behind Chat back with the Dock's Chat button, which
// moves the camera so the Chat is readable again.
export async function openChat(harness) {
  const usable = async () => { const { shell, dock, view } = await chatUsableNow(harness); return chatShellUsable(shell, dock, view); };
  if (await usable()) return;
  await harness.click('.egd-dock-btn[data-id="chat"]');
  await waitUntil(usable, Boolean, { timeoutMs: 10000, intervalMs: 100 });
}

export function composerIsReady(input, button, message, threadId) {
  return !!input?.visible && !!button?.visible && button.disabled === false &&
    input.value === message && input.dataset?.threadId === threadId;
}

// The composer redraws from the app's stored draft, and only an input event
// updates that draft. MCP fill resets the value without one, so text left by an
// earlier rejection comes back and the new text is appended to it. Replace
// existing text the way a person does: focus, select all, then type or delete.
export async function replaceComposerText(harness, text, selector = '.egd-codex-input') {
  return replaceFieldText(harness, selector, text);
}

export async function replaceFieldText(harness, selector, text) {
  await harness.click(selector);
  await harness.press(process.platform === 'darwin' ? 'meta+a' : 'Control+a', selector);
  if (text) await harness.typeText(text);
  else await harness.press('Backspace', selector);
  await waitUntil(() => harness.inspect(selector), (nodes) => nodes[0]?.value === text, { timeoutMs: 5000, intervalMs: 50 });
}

export async function sendFromComposer(harness, message) {
  const composer = '.egd-codex-input';
  await visible(harness, composer);
  const { threadId } = await chatIdentity(harness);
  if ((await harness.inspect(composer))[0]?.value) await replaceComposerText(harness, '', composer);
  await harness.fill(composer, message);
  let stableSamples = 0;
  // Sample both controls in the same profile-bound evaluation. Two separate
  // MCP/ACL round trips can exceed the old five-second budget on Windows.
  await waitUntil(() => chrome(harness, () => {
    const input = document.querySelector('.egd-codex-input');
    const button = document.querySelector('.egd-codex-send');
    const shown = node => {
      if (!node) return false;
      const rect = node.getBoundingClientRect(), style = getComputedStyle(node);
      return rect.width > 0 && rect.height > 0 && style.display !== 'none' && style.visibility !== 'hidden';
    };
    return { input: input && { visible: shown(input), value: input.value, dataset: { threadId: input.dataset.threadId } },
      button: button && { visible: shown(button), disabled: button.disabled } };
  }),
    ({ input, button }) => {
      stableSamples = composerIsReady(input, button, message, threadId) ? stableSamples + 1 : 0;
      return stableSamples >= 2;
    }, { timeoutMs: 20000, intervalMs: 50 });
  await harness.click('.egd-codex-send');
}

export async function newQaThread(harness, label) {
  await openChat(harness);
  if ((await harness.inspect('.egd-codex-conversation-back')).some((node) => node.visible)) {
    await harness.click('.egd-codex-conversation-back');
  }
  await harness.click('.egd-codex-thread-home-new');
  await visible(harness, '[data-testid="chat-composer"]');
  return chrome(harness, (title) => {
    const codex = window.__egdesk.state.codex;
    const thread = codex.threads.find((item) => item.id === codex.activeThreadId);
    if (!thread || thread.conversationId || thread.messages.length || thread.profileEnabled === true) {
      throw new Error('New QA thread is not an empty ordinary Codex conversation');
    }
    // Test fixture metadata only; creation and selection use rendered controls.
    thread.title = title;
    const module = ChromeUtils.importESModule('chrome://userchrome/content/EGDeskChatState.sys.mjs');
    const reflected = module.buildChatRequest(thread, 'QA identity reflection; not sent', 'qa-reflection-not-sent', window.__egdesk.codexBridge.threadRuntimeConfig(thread.id));
    return { id: thread.id, title, wireClientThreadId: reflected.clientThreadId };
  }, label);
}

export function chooseQaThreadRow(thread, modelThreads, rows) {
  const modelMatches = modelThreads.filter(item => item.title === thread.title);
  assert.ok(modelMatches.length === 1 && modelMatches[0].id === thread.id, 'Requested room label is not unique for its local ID');
  const labelled = rows.filter(row => row.visible && row.title === thread.title);
  assert.ok(labelled.length > 0, `Requested room is not rendered: ${thread.title}`);
  const matches = labelled.filter(row => row.hittable !== false);
  assert.ok(matches.length > 0, `Requested room is clipped by its list, so a native click would land on another control: ${thread.title}`);
  // A room may appear in more than one list section. Each exact-label row maps
  // to the same uniquely verified local ID; the post-click identity is checked.
  return matches[0];
}

export async function selectQaThread(harness, thread) {
  await openChat(harness);
  if ((await harness.inspect('.egd-codex-conversation-back')).some((node) => node.visible)) {
    await harness.click('.egd-codex-conversation-back');
  }
  // The search box keeps text in app state that only an input event updates.
  if ((await harness.inspect('.egd-codex-thread-search'))[0]?.value) await replaceFieldText(harness, '.egd-codex-thread-search', '');
  const observed = await chrome(harness, () => {
    const selectorFor = node => {
      const root = node.closest('#egd-hud, .egd-chat-card');
      if (!root?.id) throw new Error('Chat row has no owned surface root');
      const parts = [];
      for (let current = node; current !== root; current = current.parentElement) {
        parts.unshift(`${current.localName}:nth-child(${[...current.parentElement.children].indexOf(current) + 1})`);
      }
      return `#${CSS.escape(root.id)} > ${parts.join(' > ')}`;
    };
    return {
      threads: window.__egdesk.state.codex.threads.map(item => ({ id: item.id, title: item.title })),
      rows: [...document.querySelectorAll('.egd-codex-thread-item')].map(node => {
        const rect = node.getBoundingClientRect();
        const style = getComputedStyle(node);
        return { title: node.querySelector('.egd-codex-thread-title')?.textContent?.trim() || '',
          visible: rect.width > 0 && rect.height > 0 && style.display !== 'none' && style.visibility !== 'hidden',
          // The list scrolls inside its card: past its edge, a native click at the row's
          // centre lands on whatever is drawn there (diagnostics bar, Dock).
          hittable: document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2)?.closest('.egd-codex-thread-item') === node,
          selector: selectorFor(node) };
      }),
    };
  });
  const row = chooseQaThreadRow(thread, observed.threads, observed.rows);
  await harness.click(row.selector);
  await visible(harness, '[data-testid="chat-composer"]');
  assert.equal((await chatIdentity(harness)).threadId, thread.id, 'UI selected a different Chat thread');
}

export { waitUntil };
