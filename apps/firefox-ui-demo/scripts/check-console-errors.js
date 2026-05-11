(() => {
  // Patch console.error temporarily to capture errors
  const errors = [];
  const origError = console.error;
  const origWarn = console.warn;
  console.error = function() { errors.push('ERR:' + Array.from(arguments).join(' ').substring(0, 100)); origError.apply(console, arguments); };
  console.warn = function() { errors.push('WARN:' + Array.from(arguments).join(' ').substring(0, 100)); origWarn.apply(console, arguments); };
  
  // Now click the chat button to trigger toggleHUD
  const btns = document.querySelectorAll('.egd-dock-btn');
  const chatBtn = Array.from(btns).find(b => b.title === '채팅');
  const hud = document.querySelector('#egd-hud');
  
  // Close first if open
  if (hud && !hud.classList.contains('egd-hud-hidden')) {
    chatBtn.click();
  }
  
  // Now open
  chatBtn.click();
  
  // Restore console
  console.error = origError;
  console.warn = origWarn;
  
  const body = document.querySelector('#egd-hud-body');
  return 'errors:' + errors.length + ' body_children:' + (body ? body.children.length : -1) + ' | ' + errors.slice(0, 5).join(' | ');
})()
