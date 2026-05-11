(() => {
  // The render function is re-called by the subscribe mechanism, overwriting our DOM changes.
  // We need to modify the actual state.codex data so the render function produces messages.
  // 
  // Strategy: Add a debug hook to the uc.js that exposes state.
  // For now, let's use a different approach:
  // The codexBridge.subscribe callback receives state.codex.
  // We can intercept it by adding our own listener that modifies the data before render.
  //
  // Actually, the simplest approach: temporarily mock authStatus.isLoggedIn = true
  // and add messages to the active thread. We can do this by:
  // 1. Finding the body._codexCleanup (which proves mountCodexHUD ran)
  // 2. The render is called via listeners - we can't easily intercept
  //
  // Best approach: Add window.__egdesk_state reference in the uc.js file
  // But that requires a restart.
  //
  // Alternative: Use the RDP to evaluate code in the same scope as the uc.js
  // Unfortunately, RDP evaluates in the global scope, not the uc.js closure.
  //
  // Practical solution: Modify the uc.js to expose a debug API on window,
  // restart Firefox, then use it.
  
  return 'Need to add debug hook to uc.js - state is in closure, cannot access from RDP global scope';
})()
