(() => {
  const d = window.__egdesk;
  if (!d) return 'no debug hook';
  
  const state = d.state;
  const bridge = d.codexBridge;
  
  // Mock auth status as logged in
  state.codex.authStatus = { isLoggedIn: true, loginInProgress: false };
  state.codex.connected = true;
  state.codex.error = null;
  
  // Add test messages to the first thread
  const now = Date.now();
  if (state.codex.threads.length > 0) {
    state.codex.threads[0].messages = [
      { id: 'm1', role: 'user', content: 'Hello Codex!', createdAt: now - 300000, status: 'done' },
      { id: 'm2', role: 'assistant', content: 'Hi! How can I help you today?', createdAt: now - 295000, status: 'done' },
      { id: 'm3', role: 'user', content: 'What is the weather like today?', createdAt: now - 120000, status: 'done' },
      { id: 'm4', role: 'user', content: 'In Seoul, please', createdAt: now - 100000, status: 'done' },
      { id: 'm5', role: 'assistant', content: 'Seoul is currently sunny with clear skies. Temperature is 22C with 45% humidity.', createdAt: now - 90000, status: 'done' },
      { id: 'm6', role: 'assistant', content: 'Some clouds are expected in the afternoon, but no rain forecast.', createdAt: now - 50000, status: 'done' },
      { id: 'm7', role: 'user', content: 'Thanks!', createdAt: now - 10000, status: 'done' },
    ];
    state.codex.threads[0].conversationId = 'test-conv-1';
    state.codex.activeThreadId = state.codex.threads[0].id;
  }
  
  // Set HUD view to conversation
  state.codex.hudView = 'conversation';
  
  // Use the dock button click to trigger toggleHUD properly
  // First close if open
  const hud = document.getElementById('egd-hud');
  if (hud && !hud.classList.contains('egd-hud-hidden')) {
    // Close it
    const btns = document.querySelectorAll('.egd-dock-btn');
    const chatBtn = Array.from(btns).find(b => b.title === '채팅');
    if (chatBtn) chatBtn.click();
  }
  
  // Now open it - this will call toggleHUD('chat') which calls mountCodexHUD
  const btns = document.querySelectorAll('.egd-dock-btn');
  const chatBtn = Array.from(btns).find(b => b.title === '채팅');
  if (chatBtn) chatBtn.click();
  
  // Check result
  const body = document.getElementById('egd-hud-body');
  const rows = document.querySelectorAll('.egd-codex-message-row');
  const times = document.querySelectorAll('.egd-codex-bubble-time');
  const grouped = document.querySelectorAll('.egd-codex-bubble-grouped');
  const roles = document.querySelectorAll('.egd-codex-bubble-role');
  
  return 'rows:' + rows.length + ' times:' + times.length + ' grouped:' + grouped.length + ' roles:' + roles.length + ' body_children:' + (body ? body.children.length : 0);
})()
