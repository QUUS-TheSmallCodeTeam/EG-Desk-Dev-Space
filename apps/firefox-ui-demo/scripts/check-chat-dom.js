(() => {
  const r = [];
  const s1 = document.querySelectorAll('[id*="codex"]');
  r.push('codex_id:' + s1.length);
  const s2 = document.querySelectorAll('[class*="codex"]');
  r.push('codex_class:' + s2.length);
  const s3 = document.querySelectorAll('[class*="egd"]');
  r.push('egd_class:' + s3.length);
  const s4 = document.querySelectorAll('[id*="egd"]');
  r.push('egd_id:' + s4.length);
  // find the chat panel header text
  const all = document.querySelectorAll('*');
  let found = '';
  for (const el of all) {
    const t = el.textContent || '';
    if (t.includes('\ucf54\ub371\uc2a4 \ucc44\ud305') && el.children.length < 5) {
      found = el.tagName + '#' + el.id + '.' + el.className;
      break;
    }
  }
  r.push('chat_header:' + found);
  return r.join(' | ');
})()
