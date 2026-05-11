(() => {
  // Check if the uc.js script loaded - look for its artifacts
  const checks = [];
  
  // Check dock
  const dock = document.querySelector('.egd-dock');
  checks.push('dock:' + (dock ? 'found' : 'not found'));
  
  // Check if egd-hud header has "코덱스 채팅" text
  const header = document.querySelector('.egd-hud-header');
  checks.push('header:' + (header ? header.textContent.trim().substring(0, 30) : 'not found'));
  
  // Check what function handles dock button clicks
  const chatBtn = document.querySelector('.egd-dock-btn');
  checks.push('chatBtn_onclick:' + (chatBtn ? typeof chatBtn.onclick : 'no btn'));
  
  // Look for the renderCodexChat function in the scope
  // Since uc.js runs in a closure, let's check if there's a click handler
  const allBtns = document.querySelectorAll('.egd-dock-btn');
  const btnInfo = Array.from(allBtns).map(b => b.title + ':' + b.dataset.dockId).join(',');
  checks.push('btns:' + btnInfo);
  
  // Check if HUD body has any data attributes or state
  const body = document.querySelector('#egd-hud-body');
  checks.push('body_dataset:' + JSON.stringify(body ? body.dataset : {}));
  
  return checks.join(' | ');
})()
