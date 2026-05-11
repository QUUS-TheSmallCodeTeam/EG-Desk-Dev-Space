(() => {
  // We need to add test messages to the active thread to verify timestamps and grouping
  // Since we can't access state directly, we'll use the codexBridge via the DOM
  // But actually, the codexBridge is in a closure. Let's try a different approach:
  // We can inject messages by finding the thread data and modifying it through the bridge's sendMessage
  
  // Actually, let's look at what's currently shown
  const body = document.querySelector('#egd-hud-body');
  const messages = body.querySelectorAll('[class*="egd-codex-message-row"]');
  const bubbles = body.querySelectorAll('[class*="egd-codex-bubble"]');
  const times = body.querySelectorAll('.egd-codex-bubble-time');
  const roles = body.querySelectorAll('.egd-codex-bubble-role');
  const grouped = body.querySelectorAll('.egd-codex-bubble-grouped');
  const emptyState = body.querySelector('.egd-codex-empty-state');
  const inputEl = body.querySelector('.egd-codex-input');
  const footer = body.querySelector('.egd-codex-footer');
  
  return JSON.stringify({
    messageRows: messages.length,
    bubbles: bubbles.length,
    timestamps: times.length,
    roleLabels: roles.length,
    groupedBubbles: grouped.length,
    emptyState: emptyState ? emptyState.textContent.substring(0, 50) : null,
    hasInput: !!inputEl,
    hasFooter: !!footer,
    inputPlaceholder: inputEl ? inputEl.placeholder : 'none'
  });
})()
