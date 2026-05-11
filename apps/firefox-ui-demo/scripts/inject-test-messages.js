(() => {
  const body = document.querySelector('#egd-hud-body');
  if (!body) return 'no body';
  const shell = body.firstElementChild;
  if (!shell) return 'no shell';

  const now = Date.now();
  const testMessages = [
    { role: 'user', content: 'Hello Codex!', createdAt: now - 300000 },
    { role: 'assistant', content: 'Hi! How can I help?', createdAt: now - 295000 },
    { role: 'user', content: 'What is the weather today?', createdAt: now - 120000 },
    { role: 'user', content: 'In Seoul please', createdAt: now - 100000 },
    { role: 'assistant', content: 'Seoul is currently sunny, 22C with 45% humidity.', createdAt: now - 90000 },
    { role: 'assistant', content: 'Some clouds expected in the afternoon.', createdAt: now - 50000 },
    { role: 'user', content: 'Thanks!', createdAt: now - 10000 },
  ];

  const messagesContainer = document.createElement('div');
  messagesContainer.className = 'egd-codex-messages';

  let prevRole = null;
  let prevTime = 0;

  const formatTime = (ts) => {
    const d = new Date(ts);
    const h = d.getHours();
    const m = String(d.getMinutes()).padStart(2, '0');
    const period = h < 12 ? 'AM' : 'PM';
    const hour12 = h % 12 || 12;
    return period + ' ' + hour12 + ':' + m;
  };

  const roleLabel = (role) => role === 'user' ? 'Me' : 'Codex Assistant';

  for (let i = 0; i < testMessages.length; i++) {
    const msg = testMessages[i];
    const nextMsg = testMessages[i + 1];
    const sameRoleAsPrev = msg.role === prevRole;
    const sameRoleAsNext = nextMsg && nextMsg.role === msg.role;
    const timeDiff = msg.createdAt - prevTime;
    const isGrouped = sameRoleAsPrev && timeDiff < 60000;

    const bubble = document.createElement('div');
    bubble.className = 'egd-codex-bubble egd-codex-bubble-' + msg.role + (isGrouped ? ' egd-codex-bubble-grouped' : '');

    if (!isGrouped) {
      const roleEl = document.createElement('div');
      roleEl.className = 'egd-codex-bubble-role';
      roleEl.textContent = roleLabel(msg.role);
      bubble.appendChild(roleEl);
    }

    const content = document.createElement('div');
    content.className = 'egd-codex-bubble-content egd-codex-richtext';
    content.textContent = msg.content;
    bubble.appendChild(content);

    const showTime = !sameRoleAsNext || (nextMsg && (nextMsg.createdAt - msg.createdAt) >= 60000);
    if (showTime && msg.createdAt) {
      const timeEl = document.createElement('div');
      timeEl.className = 'egd-codex-bubble-time';
      timeEl.textContent = formatTime(msg.createdAt);
      bubble.appendChild(timeEl);
    }

    const row = document.createElement('div');
    row.className = 'egd-codex-message-row egd-codex-message-row-' + msg.role + (isGrouped ? ' egd-codex-message-row-grouped' : '');
    row.appendChild(bubble);
    messagesContainer.appendChild(row);

    prevRole = msg.role;
    prevTime = msg.createdAt;
  }

  // Replace conversation pane content
  const convPane = shell.querySelector('.egd-codex-conversation-pane');
  if (convPane) {
    const existingMessages = convPane.querySelector('.egd-codex-messages');
    const emptyState = convPane.querySelector('.egd-codex-empty-state');
    if (existingMessages) {
      existingMessages.replaceWith(messagesContainer);
    } else if (emptyState) {
      emptyState.replaceWith(messagesContainer);
    } else {
      convPane.appendChild(messagesContainer);
    }
  } else {
    const mainEl = shell.querySelector('.egd-codex-chat-main') || shell;
    mainEl.appendChild(messagesContainer);
  }

  // Add footer with input
  const existingFooter = shell.querySelector('.egd-codex-footer');
  if (!existingFooter) {
    const footer = document.createElement('div');
    footer.className = 'egd-codex-footer';
    const inputRow = document.createElement('div');
    inputRow.className = 'egd-codex-input-row';
    const input = document.createElement('input');
    input.className = 'egd-codex-input';
    input.placeholder = 'Send a message...';
    const sendBtn = document.createElement('button');
    sendBtn.className = 'egd-codex-send';
    sendBtn.textContent = 'Send';
    inputRow.appendChild(input);
    inputRow.appendChild(sendBtn);
    const hint = document.createElement('div');
    hint.className = 'egd-codex-input-hint';
    hint.textContent = 'Press Enter to send';
    footer.appendChild(inputRow);
    footer.appendChild(hint);
    const mainEl = shell.querySelector('.egd-codex-chat-main') || shell;
    mainEl.appendChild(footer);
  }

  return 'injected ' + testMessages.length + ' messages';
})()
