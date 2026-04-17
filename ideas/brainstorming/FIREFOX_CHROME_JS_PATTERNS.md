# Firefox Chrome JS Patterns (개발자 handbook 초안)

**작성일**: 2026-04-17
**상태**: Brainstorming — living doc. 세션 반복하며 축적
**관련**: [ADR-007](../../.claude/docs/decisions/007-firefox-shell-over-electron.md), [`FIREFOX_SHELL_STRATEGY.md`](../confirmed/FIREFOX_SHELL_STRATEGY.md)

---

## 목적

EG-Desk 개발자가 Firefox chrome JS 로 작업할 때 자주 만나는 **재사용 가능한 패턴** 모음. Electron 개발 경험만 있는 사람의 러닝 커브 완화.

## 1. Chrome JS 기본 골격

모든 `.uc.js` 파일의 표준 wrapper:

```js
// ==UserScript==
// @name           My Feature
// @description    ...
// @include        main
// ==/UserScript==
(function myFeature() {
  'use strict';
  const TAG = '[my-feature]';

  function boot() {
    try {
      // 초기화
    } catch (err) {
      console.error(TAG, 'boot failed:', err);
    }
  }

  if (document.readyState === 'complete') boot();
  else window.addEventListener('load', boot, { once: true });
})();
```

## 2. Core APIs

### 2.1 파일 I/O — IOUtils

```js
import { IOUtils } from 'resource://gre/modules/IOUtils.sys.mjs';
import { PathUtils } from 'resource://gre/modules/PathUtils.sys.mjs';

const path = PathUtils.join(PathUtils.profileDir, 'mydata.json');
await IOUtils.writeJSON(path, { foo: 1 });
const data = await IOUtils.readJSON(path);
```

**Electron 매핑**: `fs.readFile/writeFile` → `IOUtils.read/write`. `fs.readJSON` → `IOUtils.readJSON`.

### 2.2 프로세스 spawn — Subprocess

```js
import { Subprocess } from 'resource://gre/modules/Subprocess.sys.mjs';

const proc = await Subprocess.call({
  command: await Subprocess.pathSearch('bun'),
  arguments: ['run', 'server.ts'],
  workdir: '/path/to/app',
  environment: { ...Subprocess.getEnvironment(), PORT: '3001' },
  environmentAppend: true,
  stderr: 'pipe',
});

// stdout 라인 단위 읽기
(async () => {
  let line;
  while ((line = await proc.stdout.readLine()) !== null) {
    console.log('mini-app stdout:', line);
  }
})();

// 종료
await proc.kill();
```

**Electron 매핑**: `child_process.spawn` → `Subprocess.call`. 리턴값이 Promise<Process> 라 async-friendly.

### 2.3 표준 디렉토리 — Services.dirsvc

```js
// 자주 쓰는 것들
const profileDir = Services.dirsvc.get('ProfD', Ci.nsIFile).path;     // ~/AppData/.../Profiles/xxx.default-release
const homeDir    = Services.dirsvc.get('Home', Ci.nsIFile).path;      // ~
const desktopDir = Services.dirsvc.get('Desk', Ci.nsIFile).path;      // ~/Desktop
const tempDir    = Services.dirsvc.get('TmpD', Ci.nsIFile).path;      // OS temp
```

**Electron 매핑**: `app.getPath('userData' | 'home' | 'desktop' | 'temp')` → `Services.dirsvc.get(KEY, Ci.nsIFile)`

### 2.4 Network — 표준 fetch

```js
// 웹 표준 fetch 가 chrome JS 에서도 그대로 작동
const resp = await fetch('https://api.example.com/data');
const data = await resp.json();
```

WebSocket, fetch, Blob, FormData 전부 표준.

### 2.5 XPCOM 파일 객체 (필요시)

```js
const file = Services.dirsvc.get('ProfD', Ci.nsIFile);
file.append('mydata.json');
if (file.exists()) {
  // file.path, file.leafName, file.parent
}
```

IOUtils 로 대부분 대체되지만 XPCOM 과 interop 필요 시.

## 3. Canvas DOM 조작

### 3.1 요소 생성 (XUL vs HTML)

**중요**: `browser.xhtml` 은 XHTML 이라 `document.createElement('div')` 로 만든 요소는 HTML 이고, `document.createXULElement('browser')` 는 XUL. 섞어 써도 됨.

```js
const div = document.createElement('div');   // HTML div
const xulBrowser = document.createXULElement('browser');  // XUL <browser>
```

### 3.2 유틸 헬퍼 (`eg-desk-surface.uc.js` 에 있는 `el()`)

```js
function el(tag, props = {}, ...children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (k === 'class') node.className = v;
    else if (k === 'style') Object.assign(node.style, v);
    else if (k.startsWith('on') && typeof v === 'function') node.addEventListener(k.slice(2).toLowerCase(), v);
    else if (k === 'data') for (const [dk, dv] of Object.entries(v)) node.dataset[dk] = dv;
    else node.setAttribute(k, v);
  }
  for (const c of children) {
    if (c == null) continue;
    node.appendChild(typeof c === 'string' ? document.createTextNode(c) : c);
  }
  return node;
}
```

## 4. Content ↔ Chrome 통신 — JSActor

Electron 의 `ipcMain/ipcRenderer` 에 대응. Content process (웹페이지) 와 chrome process 사이 통신.

### 4.1 JSActor 쌍 등록 (overview)

```js
// 1. Actor 클래스 정의 (parent side)
class EGDeskAutomationParent extends JSWindowActorParent {
  async receiveMessage(message) {
    switch (message.name) {
      case 'content-event': return this.handleContentEvent(message.data);
    }
  }
}

// 2. Content side
class EGDeskAutomationChild extends JSWindowActorChild {
  handleEvent(event) {
    this.sendAsyncMessage('content-event', { type: event.type });
  }
}

// 3. 등록 (one-time setup)
ChromeUtils.registerWindowActor('EGDeskAutomation', {
  parent: { esModuleURI: 'chrome://userchromejs/content/resources/EGDeskAutomationParent.sys.mjs' },
  child: {
    esModuleURI: 'chrome://userchromejs/content/resources/EGDeskAutomationChild.sys.mjs',
    events: { 'click': { capture: true } },
  },
  allFrames: true,
});
```

JSActor 는 Firefox 의 공식 content↔chrome IPC 메커니즘. 상세: https://firefox-source-docs.mozilla.org/dom/ipc/jsactors.html

### 4.2 Agent automation 의 JSActor 활용

- Agent 가 `browsingContext.currentWindowGlobal.getActor('EGDeskAutomation')` 으로 content 에 메시지
- Content side 는 DOM query/manipulate 후 결과 반환

## 5. 카드 (XUL `<browser>`) 관리

### 5.1 카드 스폰 (baseline)

`apps/firefox-ui-demo/overlay/JS/eg-desk-surface.uc.js::spawnBrowserCard()` 가 baseline. 주요 설정:

```js
const b = document.createXULElement('browser');
b.setAttribute('type', 'content');           // 웹 콘텐츠 (chrome type 아님)
b.setAttribute('remote', 'true');            // 별 content process
b.setAttribute('maychangeremoteness', 'true');
b.setAttribute('disableglobalhistory', 'true');
b.setAttribute('flex', '1');
container.appendChild(b);
b.setAttribute('src', url);                  // 마지막에 src — 먼저 DOM 삽입 후
```

### 5.2 카드 안의 웹페이지 자동화

```js
const browser = card._xulBrowser;

// 스냅샷
const image = await browser.browsingContext.currentWindowGlobal.drawSnapshot(
  new DOMRect(0, 0, 1024, 768), 1, 'rgb(255,255,255)'
);

// 네비게이션
browser.loadURI(
  Services.io.newURI(url),
  { triggeringPrincipal: Services.scriptSecurityManager.getSystemPrincipal() }
);

// 뒤/앞
browser.goBack();
browser.goForward();

// JS 평가 (JSActor 필요)
const result = await browser.browsingContext.currentWindowGlobal
  .getActor('EGDeskAutomation')
  .sendQuery('evaluate', { expr: 'document.title' });
```

### 5.3 Popup 라우팅 — window.browserDOMWindow

`apps/firefox-ui-demo/overlay/JS/eg-desk-surface.uc.js::installPopupCapture()` 참조. `window.browserDOMWindow` 를 교체하면 모든 `window.open` 을 카드로 라우팅.

## 6. Preferences

```js
// 읽기
Services.prefs.getBoolPref('my.pref.key', false);  // 두번째 = 기본값
Services.prefs.getStringPref('my.pref.key', 'default');
Services.prefs.getIntPref('my.pref.key', 0);

// 쓰기
Services.prefs.setBoolPref('my.pref.key', true);

// 관찰
Services.prefs.addObserver('my.pref.', {
  observe(subject, topic, data) {
    if (topic === 'nsPref:changed') {
      console.log('pref changed:', data);
    }
  }
});
```

**Electron 매핑**: `electron-store` → `Services.prefs`. 또는 `IOUtils.writeJSON` 으로 직접.

## 7. 로깅

```js
// Browser Console (Ctrl+Shift+J) 에 표시
console.log, console.warn, console.error

// 파일로 영구 로깅
import { Log } from 'resource://gre/modules/Log.sys.mjs';
const logger = Log.repository.getLogger('EGDesk');
logger.level = Log.Level.Info;
logger.addAppender(new Log.FileAppender('/path/to/egdesk.log', new Log.BasicFormatter()));
logger.info('message');
```

## 8. 디버깅

- **Browser Console** (Ctrl+Shift+J): chrome JS 와 content log 모두 보임. `devtools.chrome.enabled = true` 필요
- **Browser Toolbox** (Ctrl+Alt+Shift+I): 전체 chrome DOM inspector + debugger. `devtools.debugger.remote-enabled` + `devtools.chrome.enabled` 필요
- **DevTools** (Ctrl+Shift+I): content process 전용 (카드 안의 웹페이지)

## 9. Anti-patterns (하지 말 것)

- ❌ Main thread 에서 sync I/O (`file.readString()` 같은 blocking)
- ❌ `<browser>` 엘리먼트 src 를 DOM 삽입 **전에** 설정 (frame loader 초기화 안 됨)
- ❌ Content process 에서 `Services.*` / `ChromeUtils.*` 호출 (권한 없음)
- ❌ 무분별한 `document.documentElement.innerHTML = ...` — chrome DOM 에 bound 된 event handler 깨짐
- ❌ `setTimeout(..., 0)` 으로 race condition 해결 (JSActor 또는 Promise 사용)

## 10. 테스팅

- 현재 수동 테스트 (Firefox 실행, 눈으로 확인)
- 추후: `playwright-electron` 유사한 automation — 가능한 후보:
  - Firefox 자체 `Marionette` 프로토콜 (chrome context 접근)
  - Puppeteer with Firefox (chrome 접근 제한)
  - 자체 테스트 harness (chrome JS 안에서 assertion)

## 11. 오픈 이슈

- [ ] JSActor 등록 파이프라인 표준화 (현재 수동 등록 장황)
- [ ] Chrome JS 에서 TypeScript 사용 방법 (esbuild → chrome-friendly js 빌드?)
- [ ] Source map 지원 (디버깅 시)
- [ ] Hot reload (현재 재시작 필요)

## 자료

- [Firefox source docs](https://firefox-source-docs.mozilla.org/)
- [Searchfox (소스 전체 검색)](https://searchfox.org/mozilla-central/)
- [MrOtherGuy/fx-autoconfig](https://github.com/MrOtherGuy/fx-autoconfig)
- [aminomancer/uc.css.js](https://github.com/aminomancer/uc.css.js) (대규모 chrome 재작성 예시)
- [zen-browser/desktop](https://github.com/zen-browser/desktop) (fork 방식 레퍼런스)
- [apps/firefox-ui-demo/overlay/JS/eg-desk-surface.uc.js](../../apps/firefox-ui-demo/overlay/JS/eg-desk-surface.uc.js) (우리 baseline)
