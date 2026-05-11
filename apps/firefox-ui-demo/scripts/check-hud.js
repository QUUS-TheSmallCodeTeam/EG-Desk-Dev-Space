(() => {
  const hud = document.querySelector('#egd-codex-hud');
  if (!hud) return 'HUD not found';
  const info = {
    display: hud.style.display,
    children: hud.children.length,
    innerHTML_len: hud.innerHTML.length,
    classes: hud.className,
    childTags: Array.from(hud.children).map(c => c.tagName + '.' + c.className.split(' ')[0]).join(', ')
  };
  return JSON.stringify(info);
})()
