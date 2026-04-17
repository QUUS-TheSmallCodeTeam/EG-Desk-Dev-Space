# Electron Main Process Observability via Node Inspector CDP

> **Status**: ~~Brainstorming — 지금 당장 구현 안 함~~ → **Historical (2026-04-17, ADR-007 Firefox shell pivot)**
> **Created**: 2026-04-10
> **Trigger condition**: Main process에 로직이 쌓이기 시작하는 시점 (아래 "발동 시점" 참조)

> ## 🟡 Firefox Shell 에서의 등가물 (2026-04-17, ADR-007)
>
> Firefox chrome JS 는 "main process" 개념 대응이 다름:
> - **Browser Console** (Ctrl+Shift+J) — chrome JS 와 content log 통합. `devtools.chrome.enabled = true` 필요
> - **Browser Toolbox** (Ctrl+Alt+Shift+I) — chrome DOM + JS debugger. privileged context 전체 관찰
> - **`about:processes`** — 각 content process CPU/메모리
> - **`about:performance`** — tab 별 성능 프로파일
> - **`Services.console.registerListener(listener)`** — 프로그래매틱 콘솔 메시지 구독
> - **Chrome JS 는 단일 프로세스** (Electron main 과 달리 별 Node 없음) 라 Node Inspector CDP 자체는 불필요. Content process 관찰은 `nsIWebProgressListener` / JSActor 로
>
> **관련**: [`FIREFOX_CHROME_JS_PATTERNS.md`](FIREFOX_CHROME_JS_PATTERNS.md) §8 (디버깅)

본 문서는 Electron 시절 observability 계획으로 역사적 가치 보존. Firefox shell 에선 위의 등가물 사용.

## 문제

Playwright MCP로 Electron 앱 리뷰할 때, attach 모드(`--cdp-endpoint http://localhost:9222`)를 쓰면 build 불필요 + HMR 유지 + 동일 인스턴스라는 이상적 상태가 된다. 하지만 이 방식은 **renderer (Chromium) 접근만 제공**하고 main process (Node.js) 로직은 관찰 불가.

반대로 `_electron.launch()` 기반 MCP (예: `@hotnsoursoup/playwright-mcp-electron`)는 main process evaluate 가능하지만 매번 build 필요 + 별개 인스턴스.

즉 "attach 모드 + main process 접근" 조합은 Playwright upstream이 지원 안 함 (microsoft/playwright#10369, P3-collecting-feedback, Microsoft 입장: "Electron is not a priority").

## 우회 아이디어

**Electron main process는 Node.js**라는 사실을 활용. Node.js에는 별도 디버깅 포트(`--inspect=9229`)가 있고, 이게 **Chrome DevTools Protocol 서버**로 동작한다. Chromium CDP(renderer, 9222)와 **프로토콜은 같지만 target이 다른** 별도 채널.

### 아키텍처

```
Electron 프로세스
├─ Main (Node.js)     → --inspect=9229          → Node CDP (ws://localhost:9229)
└─ Renderer (Chromium) → --remote-debugging-port=9222 → Chromium CDP (http://localhost:9222)

MCP Fork
├─ Renderer tools    → connectOverCDP(9222)                 ← 기존 playwright-mcp-advanced 재사용
└─ electron_evaluate → WebSocket(9229) + Runtime.evaluate    ← 신규 추가
```

### 수정 범위 (예상)

| 작업 | 규모 |
|---|---|
| CLI에 `--node-inspect-endpoint` 플래그 | 10줄 |
| Node CDP WebSocket 연결 모듈 (chrome-remote-interface 또는 ws 직접) | 50줄 |
| `electron_evaluate` 툴 등록 | 50줄 |
| (선택) Main window 목록/이벤트 관찰 툴 | 50줄 |
| 테스트/문서 | 50줄 |
| **합계** | **~200줄** |

기존 `playwright-mcp-advanced` 또는 공식 `@playwright/mcp`에 patch로 얹을 수 있는 규모.

## Electron 측 준비

`src/main/index.ts`는 `app.commandLine.appendSwitch('remote-debugging-port', '9222')`로 renderer CDP 열 수 있지만, Node `--inspect`는 **Node 프로세스 시작 플래그**라 Electron 시작 시 args로 전달해야 함. `electron-vite` dev 커맨드에 `--inspect=9229` 전달 방법 확인 필요 (package.json scripts 또는 electron.vite.config.ts).

## 대안 (Fork 안 하는 경우)

### Alt-A: 독립 MCP server 별도 작성

- `scripts/electron-main-mcp/`에 ~150줄짜리 독립 MCP 서버
- Node CDP만 담당, renderer는 기존 MCP가 담당
- MCP 2개 병행 관리
- 장점: fork 업데이트 따라가기 쉬움, 책임 분리

### Alt-B: MCP 없이 script 직접 호출

- `scripts/eval-main.ts`가 필요할 때 Node CDP 찔러서 결과 출력
- Bash로 `node scripts/eval-main.ts "app.getPath('userData')"` 호출
- 가장 가벼움, MCP 툴 UX 아님

## 발동 시점 (지금은 불필요)

현재 Desk Home v1은 순수 UI (main은 BrowserWindow 생성 + 기본 이벤트만). main process 로직 리뷰 대상 없음.

**다음 조건 중 하나가 생기면 재검토**:

- IPC 기반 통신 로직 추가
- 파일시스템/DB 접근 로직 main에 추가
- Rust/Native addon 백엔드 통합
- 설정/상태 관리를 main에 위임

## 참고 자료

- microsoft/playwright#10369 — Attaching playwright to existing electron window (P3, open)
- viktor-silakov/playwright-mcp-advanced — Electron attach 지원 fork
- Playwright 1.59.1 `types.d.ts:19917` — `Electron` interface에 `launch()`만 있음
