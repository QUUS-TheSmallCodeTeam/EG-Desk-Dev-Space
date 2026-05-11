(() => {
  const body = document.querySelector('#egd-hud-body');
  if (!body) return 'body not found';
  const info = {
    innerHTML_len: body.innerHTML.length,
    innerHTML_preview: body.innerHTML.substring(0, 200),
    display: getComputedStyle(body).display,
    visibility: getComputedStyle(body).visibility,
    height: getComputedStyle(body).height,
    overflow: getComputedStyle(body).overflow
  };
  return JSON.stringify(info);
})()
