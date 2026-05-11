(() => {
  const body = document.querySelector('#egd-hud-body');
  if (!body) return 'body not found';
  const childCount = body.children.length;
  const firstChild = body.firstElementChild;
  if (!firstChild) return 'no children';
  
  const info = {
    children: childCount,
    firstClass: firstChild.className,
    firstTag: firstChild.tagName,
    grandchildren: firstChild.children.length,
    hasAvatar: body.querySelector('.egd-codex-thread-avatar') ? true : false,
    hasTime: body.querySelector('.egd-codex-thread-time') ? true : false,
    hasChrome: body.querySelector('.egd-codex-chrome-row') ? true : false,
    hasThreadItem: body.querySelector('.egd-codex-thread-item') ? true : false,
    bodyHTML_len: body.innerHTML.length
  };
  return JSON.stringify(info);
})()
