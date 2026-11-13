'use strict';
// The start page says two things to the Desk window around it and reaches for
// nothing itself: "I am loaded" and "Desk 시작 was pressed". The Desk decides
// whether the button shows (data-desk-entry on <html>) and what a press does.
document.getElementById('start-desk').addEventListener('click', () => {
  document.dispatchEvent(new CustomEvent('egdesk-start-desk', { bubbles: true }));
});
document.dispatchEvent(new CustomEvent('egdesk-start-ready', { bubbles: true }));
