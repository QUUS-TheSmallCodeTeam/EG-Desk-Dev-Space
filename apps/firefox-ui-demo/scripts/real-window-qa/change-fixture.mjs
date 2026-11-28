// L55: a page whose DOM never stops changing, as a data: URL, for the real-window QA of the change decision (a refused act on a page that moved is decided by the model).
// - a clock (every 100 ms), a rotating banner (every 700 ms), a small form: a text field, two radios, and a "view" button (aria-controls, outside any form) that opens a note.
// - the page counts its own mutations in window.__ticks, so a check can prove the page really was changing while the Card worked.
// Case 21 is merged into cases.mjs (CASES_CHANGE). If the Card's own navigate() refuses data:, serve CHANGE_HTML with `python3 -m http.server` and use that http://127.0.0.1 address.
export const CHANGE_HTML = `<!doctype html><html lang="ko"><head><meta charset="utf-8"><title>변화 폼</title></head><body>
<div id="clock" aria-label="현재 시각">00:00:00.000</div>
<div id="banner" role="region" aria-label="광고 배너">이벤트 1</div>
<div id="panel">
  <label for="name">이름</label> <input id="name" name="name" type="text">
  <fieldset><legend>배송 방법</legend>
    <label><input type="radio" name="ship" value="fast"> 빠른배송</label>
    <label><input type="radio" name="ship" value="normal"> 일반배송</label>
  </fieldset>
  <button type="button" id="more" aria-controls="detail" aria-expanded="false">상세 보기</button>
  <div id="detail" hidden>상세 내용: 열림</div>
</div>
<script>
window.__ticks = 0;
const clock = document.getElementById('clock'), banner = document.getElementById('banner');
setInterval(() => { clock.textContent = new Date().toISOString().slice(11, 23); window.__ticks++; document.documentElement.dataset.ticks = window.__ticks; }, 100);
let n = 1; setInterval(() => { n = n % 5 + 1; banner.textContent = '이벤트 ' + n; window.__ticks++; document.documentElement.dataset.ticks = window.__ticks; }, 700);
document.getElementById('more').addEventListener('click', e => { const d = document.getElementById('detail'); d.hidden = false; e.target.setAttribute('aria-expanded', 'true'); });
</script></body></html>`
export const CHANGE_URL = 'data:text/html;charset=utf-8,' + encodeURIComponent(CHANGE_HTML)
const el = id => `document.getElementById("${id}")`
export const CASES_CHANGE = {
  21: { name: '계속 바뀌는 페이지에서 폼 조작 (L55)', card: 'egd-browser-card-13', url: CHANGE_URL, title: '변화 폼',
    msg: '이 카드에서 이름 칸에 차민수 쓰고, 빠른배송 고르고, 상세 보기 버튼 눌러줘',
    checks: [`${el('name')}.value === "차민수"`, 'document.querySelector("input[value=fast]").checked === true', '!document.querySelector("input[value=normal]").checked',
      `${el('detail')}.hidden === false`, '+document.documentElement.dataset.ticks > 30'] },
}
