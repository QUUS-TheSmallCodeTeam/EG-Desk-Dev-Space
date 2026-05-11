(() => {
  const btns = document.querySelectorAll('.egd-dock-btn');
  const chatBtn = Array.from(btns).find(b => b.title === '채팅');
  if (!chatBtn) return 'chat btn not found';
  
  const hud = document.querySelector('#egd-hud');
  const body = document.querySelector('#egd-hud-body');
  
  // If HUD is hidden, click to open
  if (hud.classList.contains('egd-hud-hidden')) {
    chatBtn.click();
  }
  
  // Now check body content
  const after = body ? body.innerHTML.length : -1;
  const childCount = body ? body.children.length : 0;
  const firstChild = body && body.firstElementChild ? body.firstElementChild.className : 'none';
  const hudApp = hud ? hud.dataset.app : 'none';
  const hidden = hud ? hud.classList.contains('egd-hud-hidden') : true;
  
  return 'body_len:' + after + ' children:' + childCount + ' first:' + firstChild + ' app:' + hudApp + ' hidden:' + hidden;
})()
