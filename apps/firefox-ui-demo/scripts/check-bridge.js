(() => {
  // The state is in a closure, we can't access it directly.
  // But we can check if the HUD body gets populated when we click chat button.
  // Let's try to find the chat button and simulate a click
  const btns = document.querySelectorAll('.egd-dock-btn');
  const chatBtn = Array.from(btns).find(b => b.title === '채팅');
  if (!chatBtn) return 'chat btn not found';
  
  // Check current HUD state
  const hud = document.querySelector('#egd-hud');
  const body = document.querySelector('#egd-hud-body');
  const before = body ? body.innerHTML.length : -1;
  
  // Click the chat button
  chatBtn.click();
  
  // Check after click
  const after = body ? body.innerHTML.length : -1;
  const hudClass = hud ? hud.className : 'no hud';
  const hudHidden = hud ? hud.classList.contains('egd-hud-hidden') : true;
  const hudApp = hud ? hud.dataset.app : 'none';
  
  return 'before:' + before + ' after:' + after + ' hidden:' + hudHidden + ' app:' + hudApp + ' class:' + hudClass.substring(0, 60);
})()
