(() => {
  const hud = document.querySelector('#egd-hud');
  if (!hud) return 'HUD #egd-hud not found';
  const children = Array.from(hud.children).map(c => {
    return c.tagName + '#' + c.id + '.' + (c.className||'').split(' ')[0] + '[' + c.children.length + ']';
  });
  return 'HUD children(' + hud.children.length + '): ' + children.join(' | ');
})()
