const MARKER = /^[A-Za-z0-9_-]{20,80}$/
const PATH = /^\/egdesk-qa\/[A-Za-z0-9_-]{20,80}\/?$/

// A fixture is available only in a deliberately opted-in local bridge process.
// The URL is an exact, non-redirecting test target, not a general origin grant.
export function fixtureBrowserQaFromEnv(env = process.env) {
  if (env.EGDESK_BROWSER_FIXTURE_QA !== '1') return null
  const rawUrl = env.EGDESK_BROWSER_FIXTURE_QA_URL
  const marker = env.EGDESK_BROWSER_FIXTURE_QA_MARKER
  let url
  try { url = new URL(rawUrl) } catch { return null }
  if (url.protocol !== 'http:' || !['127.0.0.1', '[::1]'].includes(url.hostname) ||
      !url.port || Number(url.port) < 1024 || Number(url.port) > 65535 ||
      url.username || url.password || url.search || url.hash || !PATH.test(url.pathname) ||
      rawUrl !== url.href || typeof marker !== 'string' || !MARKER.test(marker)) return null
  return Object.freeze({ url: url.href, marker })
}

export function fixtureSnapshotMatches(snapshot, fixture) {
  return Boolean(fixture && snapshot?.url === fixture.url && Array.isArray(snapshot.text) &&
    snapshot.text.some(text => text === fixture.marker))
}

// BRW-06 / BRW-08 / BRW-12 behaviour fixtures for the owned headless harness.
// Each scenario is one page served at the same exact /egdesk-qa/<path marker>
// URL (one scenario per run), with the DOM marker the harness already checks.
// Scenarios follow nanobrowser fixtures/pages (Apache-2.0, Copyright the
// nanobrowser authors: d-clickables, d-scrolling-frame, shadow-closed,
// c-cookie-banner, d-late, c-dialogs); the markup here is EG-Desk's own.
// Pages make no request except delayed-fetch, which fetches its own URL.
export const BROWSER_BEHAVIOR_SCENARIOS = Object.freeze([
  Object.freeze({ id: 'pointer-div', gap: 'BRW-08', expect: 'Observe lists the div cards as clickable and the hidden-radio label as radio; a guarded click on either changes qa-state.' }),
  Object.freeze({ id: 'inner-scroll', gap: 'BRW-08', expect: 'Observe lists the list box as scrollable with a scrollContainers entry; scroll with its ref and direction down moves only the list and reveals Row 40.' }),
  Object.freeze({ id: 'closed-shadow', gap: 'BRW-08', expect: 'Observe lists the button inside the closed shadow root; a guarded click changes qa-state.' }),
  Object.freeze({ id: 'cookie-banner', gap: 'BRW-08', expect: 'A click on Accept terms is refused before input, obscured by div#cookie-consent role=dialog; after Dismiss the same click works.' }),
  Object.freeze({ id: 'delayed-fetch', gap: 'BRW-06', expect: 'A click on Update cart settles past the 300 ms fetch: the receipt settle lists the page path and the after-snapshot shows Cart updated.' }),
  Object.freeze({ id: 'dialogs', gap: 'BRW-12', expect: 'Alert and Confirm hold the click inside a page dialog: the reconcile answer is entered with performing true until a person closes it.' }),
])

const BEHAVIOR_BODIES = {
  'pointer-div': `<style>.card{cursor:pointer;border:1px solid #888;padding:12px;margin:8px;width:220px}.card span{font-weight:600}
.choice input{display:none}.choice{display:inline-block;border:1px solid #888;padding:8px;margin:8px}</style>
<div class="card" id="plan-card"><span>Open plan</span> details</div>
<div id="legacy-card" onclick="document.getElementById('qa-state').textContent='Legacy card opened'">Legacy card</div>
<label class="choice"><input type="radio" name="billing" value="monthly"> Monthly</label>
<script>document.getElementById('plan-card').addEventListener('click',()=>{document.getElementById('qa-state').textContent='Plan card opened'});
document.querySelector('.choice input').addEventListener('change',()=>{document.getElementById('qa-state').textContent='Monthly selected'});</script>`,
  'inner-scroll': `<style>#rows{height:200px;overflow:auto;border:1px solid #888;width:260px}#rows div{padding:6px}</style>
<div id="rows" role="listbox" aria-label="Rows"></div>
<script>const rows=document.getElementById('rows');for(let i=1;i<=40;i++){const row=document.createElement('div');row.textContent='Row '+i;rows.appendChild(row)}
rows.addEventListener('scroll',()=>{document.getElementById('qa-state').textContent='List scrolled to '+Math.round(rows.scrollTop)})</script>`,
  'closed-shadow': `<x-vault id="vault"></x-vault>
<script>customElements.define('x-vault',class extends HTMLElement{constructor(){super();const root=this.attachShadow({mode:'closed'});
const button=document.createElement('button');button.type='button';button.textContent='Open vault';
button.addEventListener('click',()=>{document.getElementById('qa-state').textContent='Vault opened'});root.appendChild(button)}})</script>`,
  'cookie-banner': `<style>#target{margin-top:90px}#cookie-consent{position:fixed;left:0;right:0;top:0;height:200px;background:#fef3c7;padding:16px}</style>
<button type="button" id="target">Accept terms</button>
<div id="cookie-consent" class="banner fixed" role="dialog" aria-label="Cookie preferences">This page uses cookies.
<button type="button" id="dismiss">Dismiss</button></div>
<script>let clicks=0;document.getElementById('target').addEventListener('click',()=>{document.getElementById('qa-state').textContent='Terms clicks: '+(++clicks)});
document.getElementById('dismiss').addEventListener('click',()=>document.getElementById('cookie-consent').remove())</script>`,
  'delayed-fetch': `<button type="button" id="update">Update cart</button><section id="cart"></section>
<script>document.getElementById('update').addEventListener('click',()=>{document.getElementById('qa-state').textContent='Updating cart';
fetch(location.href,{cache:'no-store'}).then(()=>new Promise(resolve=>setTimeout(resolve,300))).then(()=>{
const node=document.createElement('p');node.textContent='Cart updated';document.getElementById('cart').appendChild(node);
document.getElementById('qa-state').textContent='Cart ready'})})</script>`,
  'dialogs': `<button type="button" id="alert">Show alert</button><button type="button" id="confirm">Ask to confirm</button>
<script>document.getElementById('alert').addEventListener('click',()=>{alert('EG-Desk QA alert');document.getElementById('qa-state').textContent='Alert closed'});
document.getElementById('confirm').addEventListener('click',()=>{const ok=confirm('EG-Desk QA confirm');document.getElementById('qa-state').textContent=ok?'Confirmed':'Cancelled'})</script>`,
}

export function browserBehaviorFixtureHtml(scenario, marker) {
  if (!Object.hasOwn(BEHAVIOR_BODIES, scenario)) throw new TypeError('Unknown Browser behaviour fixture scenario')
  if (typeof marker !== 'string' || !MARKER.test(marker)) throw new TypeError('Browser DOM fixture marker is invalid')
  const connect = scenario === 'delayed-fetch' ? "'self'" : "'none'"
  return `<!doctype html><html><head><meta charset="utf-8"><title>EG-Desk Browser behaviour QA: ${scenario}</title>
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src ${connect}; form-action 'none'; base-uri 'none'">
<style>body{font:16px system-ui;padding:24px}button{font:inherit;padding:8px;margin:8px}</style></head>
<body><main><h1>EG-Desk Browser behaviour QA</h1><p id="fixture-marker">${marker}</p>
<p id="qa-state">Waiting for QA action</p>
${BEHAVIOR_BODIES[scenario]}
</main></body></html>`
}
