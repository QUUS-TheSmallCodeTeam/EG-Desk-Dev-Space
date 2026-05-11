(() => {
  // Click on the first thread item to enter conversation view
  const threadItem = document.querySelector('.egd-codex-thread-item');
  if (!threadItem) return 'no thread item found';
  
  threadItem.click();
  
  // Wait a tick and check what's rendered
  const body = document.querySelector('#egd-hud-body');
  const shell = body ? body.firstElementChild : null;
  
  const info = {
    shellClass: shell ? shell.className : 'none',
    children: shell ? shell.children.length : 0,
    hasInput: body ? !!body.querySelector('input, textarea, [contenteditable]') : false,
    hasMessages: body ? !!body.querySelector('.egd-codex-message, [class*="message"]') : false,
    bodyHTML_len: body ? body.innerHTML.length : 0
  };
  
  return JSON.stringify(info);
})()
