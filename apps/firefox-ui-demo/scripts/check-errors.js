(() => {
  // Check if EGDesk global object exists
  const checks = [];
  checks.push('EGDesk:' + (typeof EGDesk));
  checks.push('egDeskState:' + (typeof egDeskState));
  checks.push('window.EGDesk:' + (typeof window.EGDesk));
  
  // Check for renderChatView or similar functions
  if (typeof EGDesk !== 'undefined') {
    checks.push('EGDesk.keys:' + Object.keys(EGDesk).slice(0,10).join(','));
  }
  
  // Check if there's a global state or chat-related function
  const globals = Object.keys(window).filter(k => k.toLowerCase().includes('egd') || k.toLowerCase().includes('chat') || k.toLowerCase().includes('codex'));
  checks.push('globals:' + globals.slice(0,10).join(','));
  
  return checks.join(' | ');
})()
