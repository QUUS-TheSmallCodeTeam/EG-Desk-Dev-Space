(() => {
  // This runs in Firefox chrome context - the window is already Firefox
  // Just return current state
  const body = document.querySelector('#egd-hud-body');
  const hud = document.querySelector('#egd-hud');
  const hidden = hud ? hud.classList.contains('egd-hud-hidden') : true;
  return 'hidden:' + hidden + ' body_children:' + (body ? body.children.length : -1);
})()
