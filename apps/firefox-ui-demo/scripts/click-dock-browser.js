const btn = document.querySelector('[data-dock-id="browser"]') || document.querySelector('.egd-dock-btn');
btn ? (btn.click(), 'clicked: ' + (btn.dataset.dockId || btn.textContent)) : 'button not found, available: ' + Array.from(document.querySelectorAll('[data-dock-id]')).map(b => b.dataset.dockId).join(', ')
