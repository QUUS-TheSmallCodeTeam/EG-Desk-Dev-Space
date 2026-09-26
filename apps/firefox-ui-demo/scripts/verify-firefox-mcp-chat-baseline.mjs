#!/usr/bin/env node
// Attach-only baseline for Main's already-running, disposable Firefox.
// Does not remount, click, submit, change prefs, or start/stop a runtime.
import { FirefoxMcpChatHarness, QA_MARIONETTE_PORT,
  waitUntil } from './firefox-mcp-chat-harness.mjs';

function option(name) {
  const index = process.argv.indexOf(name);
  return index < 0 ? null : process.argv[index + 1];
}

const profile = option('--profile') || process.env.EGDESK_FIREFOX_PROFILE;
if (!profile || process.argv.includes('--help')) {
  console.error('Usage: EGDESK_MARIONETTE_PORT=2829 node verify-firefox-mcp-chat-baseline.mjs --profile /canonical/egdesk-chat-test-*');
  process.exitCode = 2;
} else {
  let harness;
  try {
    harness = new FirefoxMcpChatHarness({ profile });
    await harness.connect();
    const [dock] = await waitUntil(() => harness.inspect('#egd-dock'),
      (nodes) => nodes.length === 1 && nodes[0].visible && nodes[0].rect.width > 0);
    const [rail] = await harness.inspect('#egd-desk-rail');
    const [viewport] = await harness.inspect('#egd-canvas-viewport');
    const cards = await harness.inspect('.egd-canvas-card');
    const bridgeObservation = await harness.evaluateChrome(`() => {
      const codex = window.__egdesk?.state?.codex;
      const visible = node => {
        const rect = node.getBoundingClientRect();
        const style = getComputedStyle(node);
        return rect.width > 0 && rect.height > 0 && style.display !== 'none' && style.visibility !== 'hidden';
      };
      return { connected: typeof codex?.connected === 'boolean' ? codex.connected : null,
        chatSurfaceVisible: [...document.querySelectorAll('.egd-codex-chat-shell')].some(visible),
        visibleStatusText: [...document.querySelectorAll('#egd-hud [role="status"], .egd-chat-card [role="status"], .egd-codex-error')]
          .filter(visible).map(node => (node.textContent || '').trim().slice(0, 300)) };
    }`);
    const screenshot = await harness.screenshot('baseline-chrome-overlay');
    process.stdout.write(`${JSON.stringify({
      kind: 'rendered-ui-baseline', ok: true, profile: harness.profile,
      marionettePort: QA_MARIONETTE_PORT, screenshot,
      dock: { rect: dock.rect, visible: dock.visible },
      rail: rail ? { rect: rail.rect, visible: rail.visible } : null,
      viewport: viewport ? { rect: viewport.rect, visible: viewport.visible } : null,
      cards: cards.map((card) => ({ id: card.id, rect: card.rect, visible: card.visible })),
      bridgeObservation,
      evidenceClass: 'live-dom-and-captured-screenshot', visualReview: 'pending',
      chatEventHandling: 'not-tested', providerTurn: 'not-run',
      scope: 'Observed Firefox chrome DOM and screenshot only; no Chat request or product action was performed.',
    })}\n`);
  } catch (error) {
    console.error(JSON.stringify({ kind: 'rendered-ui-baseline', ok: false,
      error: error.message, mcpStderrTail: harness?.stderrTail.slice(-1500) || '' }));
    process.exitCode = 1;
  } finally {
    await harness?.close();
  }
}
