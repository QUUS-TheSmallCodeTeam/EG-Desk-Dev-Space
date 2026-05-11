(() => {
  const body = document.querySelector('#egd-hud-body');
  if (!body) return 'no body';
  
  // Check for message elements, timestamps, input area
  const messages = body.querySelectorAll('[class*="message"]');
  const timestamps = body.querySelectorAll('[class*="time"], [class*="timestamp"]');
  const inputArea = body.querySelector('input, textarea, [contenteditable]');
  const bubbles = body.querySelectorAll('[class*="bubble"]');
  
  // Get the conversation view structure
  const shell = body.firstElementChild;
  const childClasses = shell ? Array.from(shell.children).map(c => c.className.split(' ')[0]).join(', ') : 'none';
  
  // Check for the message list area
  const msgList = body.querySelector('[class*="msg-list"], [class*="message-list"], [class*="conversation"]');
  
  // Get innerHTML snippet of the conversation area
  const htmlSnippet = body.innerHTML.substring(0, 500);
  
  return JSON.stringify({
    messages: messages.length,
    timestamps: timestamps.length,
    hasInput: !!inputArea,
    bubbles: bubbles.length,
    childClasses: childClasses,
    msgList: msgList ? msgList.className : 'none',
    snippet: htmlSnippet
  });
})()
