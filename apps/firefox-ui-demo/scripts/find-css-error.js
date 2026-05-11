(() => {
  // The error is "CSSStyleProperties doesn't have an indexed property"
  // This typically happens when trying to set style[index] or iterate style incorrectly
  // Let's find where in the render function this happens by wrapping the render call
  
  const body = document.querySelector('#egd-hud-body');
  const hud = document.querySelector('#egd-hud');
  
  // Close HUD first
  if (hud && !hud.classList.contains('egd-hud-hidden')) {
    const btns = document.querySelectorAll('.egd-dock-btn');
    const chatBtn = Array.from(btns).find(b => b.title === '채팅');
    chatBtn.click();
  }
  
  // Now try to open and catch the full error with stack
  try {
    const btns = document.querySelectorAll('.egd-dock-btn');
    const chatBtn = Array.from(btns).find(b => b.title === '채팅');
    
    // Monkey-patch console.warn to get the full stack
    let fullStack = '';
    const origWarn = console.warn;
    console.warn = function() {
      const args = Array.from(arguments);
      if (args[2] && args[2] instanceof Error) {
        fullStack = args[2].stack || args[2].message;
      }
      origWarn.apply(console, arguments);
    };
    
    chatBtn.click();
    
    console.warn = origWarn;
    return 'stack:' + fullStack.substring(0, 400);
  } catch(e) {
    return 'caught:' + e.message + ' stack:' + (e.stack || '').substring(0, 300);
  }
})()
