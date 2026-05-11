(() => {
  // toggleHUD checks: if (appId === 'chat' && state.codexBridge)
  // If codexBridge is null/undefined, it falls through to the placeholder branch
  // Let's check what happens by looking at the console for errors
  
  // First, let's check if there's an error in the browser console
  // We can't access state directly, but we can check if mountCodexHUD was called
  // by looking at what's in the body after the click
  
  const body = document.querySelector('#egd-hud-body');
  const hud = document.querySelector('#egd-hud');
  
  // body is empty (0 children) and app=chat, hidden=false
  // This means toggleHUD was called, it set app='chat', showed the HUD
  // BUT body.textContent = '' was called, and then:
  // Either: state.codexBridge is falsy (so it falls through to placeholder)
  // Or: mountCodexHUD was called but render() produced empty output
  
  // The placeholder branch would add content, so if body is empty,
  // it means state.codexBridge IS truthy, mountCodexHUD WAS called,
  // but the render function produced nothing.
  
  // Let's verify by checking if any egd-codex elements exist anywhere
  const codexEls = document.querySelectorAll('[class*="egd-codex"]');
  const info = Array.from(codexEls).map(e => e.tagName + '.' + e.className.split(' ')[0]).join(', ');
  
  return 'codex_elements:' + codexEls.length + ' | ' + info.substring(0, 200);
})()
