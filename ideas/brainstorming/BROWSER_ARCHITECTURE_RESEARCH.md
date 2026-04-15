# Browser Entity Architecture Research

**Research Date**: 2026-04-14
**Investigator**: Session Lead (direct WebSearch/WebFetch in conversation)
**Context**: EG-Desk 무한 캔버스 위에 웹 엔티티(Browser)를 올리는 방법 — 렌더링 경로 + 풀 브라우저 한계 조사
**Status**: 2026-04-15 기준 방향 확정 — EG-Desk는 workspace app, browser는 내부 capability. 아키텍처는 Electron shell + BrowserOS/ABP 계열 엔진 통합 방향.

---

## 조사 동기

EG-Desk는 무한 캔버스(ADR-006) 위에 다양한 엔티티를 올린다. 그중 **Browser 엔티티**는 실제 웹 페이지를 살아있는 상태로 표시해야 함:
- 네이버 블로그 자동화 (agent가 form 조작)
- AI 서비스 대화창 (Claude/ChatGPT/Gemini를 entity로)
- 일반 웹 브라우징 (문서, 참고 자료, 소셜)

질문은 세 가지:
1. **렌더링 경로**: 어떻게 웹 페이지를 캔버스 위에 올리나?
2. **한계**: 어디까지 "진짜 브라우저"처럼 작동시킬 수 있나?
3. **유지보수 비용**: 팀 규모로 감당 가능한가?

---

## 2026-04-15 결정 업데이트

오늘 기준으로 제품 포지셔닝은 확정:

- EG-Desk는 **standalone browser app**이 아니라 **AI automation + infinite canvas 기반 workspace app**이다.
- Browser는 제품 자체가 아니라 workspace 내부의 **entity / tool / runtime capability**다.
- 따라서 "Chrome 대체품을 독립 제품으로 완성할 것인가"는 1차 목표가 아니다. 브라우저 엔진 선택은 workspace 경험을 강화하는 수단으로 판단한다.

이 결정에 따라 현재 아키텍처 방향은 다음과 같이 고정:

- **App shell**: Electron 유지
- **Spatial/UI shell**: Infinite Canvas + Theia/AI 시스템 유지
- **Browser subsystem**: stock Electron에만 머무르지 않고 **BrowserOS 또는 ABP 계열 엔진**을 붙이는 방향 우선 검토
- **통합 단계**: 단기에는 sidecar/bridge 허용, 중장기에는 Electron 내부 엔진 통합 지향

즉, 이 문서의 Option A / B는 더 이상 "workspace app vs browser app" 제품 포지셔닝 비교가 아니다.

- **Option A**: 단기 bootstrap / POC 경로
- **Option B**: standalone 브라우저 제품 경로가 아니라, workspace app 내부 브라우저 엔진을 고도화하는 경로로 재해석

실제 의사결정 축은 이제 `Electron shell을 버릴 것인가`가 아니라, **어떤 브라우저 엔진을 어떤 단계로 EG-Desk workspace 안에 통합할 것인가**다.

---

## Option A — Electron + WebContentsView (+ CDP/Playwright 자동화)

### 개요

Electron의 현대 API. `BaseWindow`에 여러 `WebContentsView`를 붙여서 **네이티브 합성**으로 웹 페이지를 렌더링. 자동화는 CDP(Chrome DevTools Protocol) 9222 포트 또는 Playwright/Puppeteer 연결.

### 구조

```
BaseWindow
 ├── WebContentsView (renderer UI — React + 무한 캔버스)
 ├── WebContentsView (browser entity #1 — naver.com)
 ├── WebContentsView (browser entity #2 — chatgpt.com)
 └── WebContentsView (browser entity #3 — blog.naver.com)
      └── CDP 연결 (9222) ← Playwright/agent
```

### 렌더링 파생 경로 — OSR (Offscreen Rendering)

**Option A의 변형**. WebContentsView 대신 `webPreferences.offscreen: true`로 숨긴 `BrowserWindow`를 만들고 `paint` 이벤트로 NativeImage 프레임 수신 → `<canvas>`에 합성.

**POC 결과** (2026-04-13):
- naver.com 30fps 렌더링 성공
- CPU bitmap 모드: PNG encode(main) → IPC → `createImageBitmap` → `drawImage` 파이프
- 60fps는 `setFrameRate(60)` 한 줄이지만 CPU 부담 큼
- `useSharedTexture: true` GPU 경로는 네이티브 애드온 필요 (아래 한계 참조)
- 메모리: browser 1개당 renderer 프로세스 ~100MB
- **display-only** — interaction 자동 안 됨

### GPU Shared Texture 최소 사양 (useSharedTexture)

| 플랫폼 | 요구사항 |
|--------|----------|
| Windows | D3D11 지원 GPU (DirectX 11 = 2009년 이후 거의 모든 GPU) |
| macOS | Metal + IOSurface (10.14 Mojave 이후 — Apple Silicon 포함) |
| Linux | 문서 불명확 — 사실상 미지원 |

제약:
- 하드웨어 가속 필수
- `texture.release()` 수동 호출 (미호출 시 메모리 누수)
- 연속 프레임 소비 (pool 고갈 방지)
- Popup/select dropdown 자동 합성 안 됨
- 네이티브 애드온 필수 (GPU handle을 자체 렌더 파이프라인에 꽂아야 함)
- CVE-2026-34764 (use-after-free in release callback) 존재

### 자동화 옵션

| 프로토콜 | 설명 | 성숙도 |
|----------|------|--------|
| CDP (9222) | Chrome DevTools Protocol, Electron에서 `remote-debugging-port` 스위치로 활성화 | 안정 |
| Playwright | CDP 기반 고수준 API (locator, wait, network intercept) | 안정 |
| Puppeteer | CDP 기반, Playwright보다 단순 | 안정 |
| `webContents.executeJavaScript` | Electron 내장 API, 가장 직접적 | 안정 |
| `webContents.debugger` | CDP를 Electron API 래핑으로 노출 | 안정 |

### Pros

- **무한 캔버스 통합 자유도 최상** — React/HTML 레이어에 WebContentsView를 자유롭게 배치, z-index/position/resize/transform 전부 수동 제어
- 네이티브 합성 → IME(한국어 입력), 비디오, 스크롤, 포커스, 클립보드 전부 기본 동작
- 자동화 프로토콜 성숙 (CDP/Playwright)
- 개발 속도 빠름 (수개월 단위)
- 유지보수 부담 낮음 — Electron 팀이 Chromium rebase 담당
- 팀 규모 1~2명 가능

### Cons — 기술적/라이선스적 불가 (돈·시간으로 해결 안 됨)

| 항목 | 이유 |
|------|------|
| **Widevine DRM (스톡 Electron)** | Google이 Widevine CDM 라이선스를 Electron에 허가하지 않음. **castlabs/ECS fork**만 해결책 (Electron 공식에서 떠남) — Netflix/Disney+/Apple TV+ 재생 불가 |
| **FairPlay DRM** | macOS Safari 전용 CDM |
| **PlayReady DRM** | Microsoft Edge 전용 |
| **Google 계정 Sync** | Google 독점 서비스. Chrome 외 클라이언트 차단 — 북마크/히스토리/비밀번호 동기화 |
| **Chrome Web Store 직접 설치** | Chrome 정체성 검증. Electron은 스토어 설치 불가 — 수동 unpacked 로드만 |
| **Chrome Extensions MV3 (service worker 기반)** | Electron이 service worker 컨텍스트에 JS inject 불가 — MV3 대다수 확장 깨짐 |
| **시스템 브라우저 세션 cookie 가져오기 (OAuth 외)** | OS 샌드박스. 브라우저 쿠키 jar 격리 — **네이버/다음 폼 로그인**을 시스템 브라우저에서 이어받기 불가 |
| **Chrome Security team 즉시 패치** | Electron 릴리스 사이클(~3-4주) 구조적 지연 — Chrome zero-day 대응 속도 못 따라감 |
| **Chromium 독점 기능** | Origin Trial 일부, Idle Detection 일부 — Google 서비스용으로만 활성화한 기능 |

### Cons — 직접 구현하면 되는 것 (effort 문제)

| 항목 | 구현 방식 | 난이도 |
|------|-----------|--------|
| Chrome Extensions (MV2) | `electron-chrome-extensions` 라이브러리 or 수동 unpacked load | 중 |
| 우클릭 컨텍스트 메뉴 | `context-menu` 이벤트 → 자체 React 메뉴 | 하 |
| Download 관리 | `will-download` 이벤트 → 자체 UI | 하 |
| Autofill (주소/카드) | `safeStorage` + form inject 스크립트 | 중 |
| PDF viewer 확장 | pdf.js 번들 or Chromium 기본 PDF 플러그인 활성화 | 하 |
| 번역 bar | OpenAI/DeepL API 연동 자체 UI | 중 |
| Web Push notifications | FCM/APNs 직접 통합 + 서비스 워커 | 중상 |
| Print preview 확장 | 기본 제공 + 옵션 UI | 하 |
| WebAuthn/Passkeys | Electron 28+ 기본 지원, 플랫폼별 quirks 처리 | 중 |
| Native popup 합성 (OSR 케이스) | popup widget 직접 composite | 상 |
| IME (OSR 케이스만) | composition event bridge | 상 |

WebContentsView 모드에서는 IME/popup이 기본 작동. OSR 모드로 가면 상급 작업 추가.

---

## Option B — Chromium/Firefox Fork (BrowserOS, Zen, Arc 경로)

### 개요

Chromium 소스 자체를 fork해서 EG-Desk 브라우저를 만드는 경로. Brave, Arc, Opera, Vivaldi, BrowserOS가 이 방식.

### 후보

| 베이스 | 예시 | 특성 |
|--------|------|------|
| Chromium fork | Brave, Arc, Opera, Vivaldi, BrowserOS | 풀 Chrome 호환 (DRM 제외), 업스트림 rebase 부담 |
| Firefox fork | Zen, LibreWolf, Floorp | XUL/CSS 커스텀 용이, 확장 생태계 좁음 |
| 기존 fork 위 얹기 | BrowserOS base + EG-Desk UI 레이어 | fork 선택이 운명 — 그 프로젝트 죽으면 같이 죽음 |

### 구조

```
[Chromium source fork]
 ├── C++ UI shell 레이어 (Views 프레임워크) ← 여기를 수정해야 무한 캔버스 가능
 ├── 렌더러 (Blink, V8) — upstream 그대로
 ├── 네트워크 스택 — upstream 그대로
 └── 확장 런타임 (MV2 + MV3 full) — upstream 그대로
```

### Pros

- **Full browser capability 100%** — DRM, MV3 확장, Chrome sync, 프로필 import 전부 네이티브
- Chrome Web Store 호환 (Chromium fork 기준)
- 크롬 프로필 데이터 네이티브 import — Brave/Arc는 import UI 탑재, Chromium 공통 포맷 그대로 읽음
- 보안 패치 fast track (upstream 따라가면)

### Cons

- **무한 캔버스 통합 난이도 최상** — Chromium UI 레이어는 C++ Views 프레임워크. HTML canvas가 아닌 네이티브 UI
  - 캔버스 위에 탭 합성하려면 Chromium 소스 수정 or WebUI 내부 페이지로 우회
  - Arc도 이거 때문에 자체 C++ shell 레이어 별도 구축
- **유지보수 지옥**:
  - Upstream Chromium은 6주마다 메이저 릴리스 → 매번 rebase + conflict 해결
  - 보안 패치 follow 못 하면 CVE 누적 → 유저 노출
  - 크로스플랫폼 빌드 파이프라인 자체 운영 (Windows/macOS/Linux)
  - 서명/배포 인증서 (특히 Apple notarization)
- **팀 규모**: 최소 전담 2~3명 + 인프라 비용 연 수천만 원대 시작
- **개발 속도**: 1~2년+ 단위
- **Firefox fork 특수 제약**: XUL은 비교적 유연하나 확장 생태계가 Chrome보다 훨씬 좁음. 크롬 확장 호환 불가

---

## 파생 토픽

### 1. OAuth + Session 공유

**시스템 브라우저 OAuth → Electron 세션 이어받기**: 가능하나 쿠키 자체는 공유 불가.

메커니즘:
```
1. Electron에서 shell.openExternal('https://auth.provider.com/...')
   → 시스템 브라우저 OAuth 페이지 오픈
2. 유저가 시스템 브라우저에서 로그인 (쿠키는 시스템 브라우저에만 존재)
3. Provider가 custom protocol로 redirect (egdesk://oauth/callback?code=abc)
4. Electron이 deep link 수신:
   - macOS: app.on('open-url')
   - Windows/Linux: second-instance 이벤트
5. Electron이 code → backend token exchange (OAuth 2.0 Authorization Code flow)
6. access_token을:
   - keychain/safeStorage에 저장 (persistent auth)
   - 또는 session.fromPartition('persist:user')에 Cookie로 주입
7. 이후 WebContentsView는 같은 partition으로 열면 로그인 상태 공유
```

**시나리오별 가능성**:

| 시나리오 | 가능? |
|----------|-------|
| Google/GitHub/Notion OAuth | ✅ code → token 교환 경로 |
| **네이버/다음 폼 로그인** | ❌ 시스템 브라우저 세션 못 가져옴 — Electron 내부에서 직접 로그인 |
| 이미 로그인된 시스템 브라우저 쿠키 그대로 쓰기 | ❌ OS가 막음 |
| SSO (회사 IdP) 로그인 | ⚠️ OAuth/SAML이면 가능, 쿠키 기반이면 불가 |

### 2. Chrome 프로필 Import 가능성

Chrome 프로필 위치:
- macOS: `~/Library/Application Support/Google/Chrome/Default/`
- Windows: `%LocalAppData%\Google\Chrome\User Data\Default\`

| 데이터 | 파일 | Import 가능 (Electron) | 난이도 |
|--------|------|----------------------|--------|
| Bookmarks | `Bookmarks` (JSON) | ✅ | 하 — 파싱 후 자체 UI |
| History | `History` (SQLite) | ✅ Chrome 종료 상태 | 하 — `better-sqlite3` |
| Cookies | `Cookies` (SQLite, AES 암호화) | ✅ 조건부 | 중 — macOS Keychain / Windows DPAPI에서 master key 추출 |
| 저장된 비밀번호 | `Login Data` (OS-encrypted) | ⚠️ 기술적 가능, 윤리/신뢰 이슈 | 중상 |
| Autofill (주소/카드) | `Web Data` | ✅ | 중 |
| Preferences | `Preferences` (JSON) | ✅ 파싱 OK, 매핑할 Electron 설정 없음 | — |
| Extensions | `Extensions/` 폴더 | ⚠️ 복잡 (아래 참조) | 상 |
| Google 계정 Sync 상태 | 서버 측 | ❌ 절대 불가 | — |
| Chrome Sync Passphrase | 서버 측 | ❌ 절대 불가 | — |
| Google Pay 연동 카드 | Google 서버 | ❌ 절대 불가 | — |

### 3. Extensions MV2/MV3 호환성

Electron 현재 지원:
- `session.extensions.loadExtension(path)` — unpacked 폴더만 (.crx 불가)
- MV2 subset: devtools, simple background page, content scripts 일부
- 라이브러리: `electron-chrome-extensions` (Polypane fork, ramboxapp fork 활발)

**Chrome 확장 가져왔을 때 작동 여부**:

| 확장 유형 | 작동? | 비고 |
|-----------|------|------|
| DevTools 확장 (React DevTools, Redux DevTools) | ✅ | 기본 지원 |
| 간단한 UI 확장 (Dark Reader MV2) | ✅ 대부분 | MV2 존재 시 OK |
| **uBlock Origin** | ⚠️ | MV2 EOL, MV3 Lite는 service worker 필요 → Electron 미지원 |
| **1Password/Bitwarden** | ⚠️ | Native messaging 필요 + MV3 기반 |
| **Grammarly, ChatGPT 확장 등** | ❌ 대부분 | MV3 service worker + Chrome 내부 API 의존 |
| MV3 전용 확장 (2024 이후 신규) | ❌ | Electron service worker inject 불가 |

**2024-2025 흐름**: Chrome Web Store MV2 EOL 강제 이행으로 최신 확장은 거의 MV3. **Chrome 확장 호환성은 시간이 갈수록 더 떨어지는 방향**.

---

## 비교 매트릭스

> 2026-04-15 메모: 아래 표는 제품 포지셔닝 비교가 아니라 **브라우저 엔진 레이어 연구 비교표**로 읽어야 한다. EG-Desk의 제품 정체성은 이미 workspace app으로 확정되었다.

| 축 | Option A (Electron + WebContentsView) | Option B (Chromium/Firefox fork) |
|----|---------------------------------------|----------------------------------|
| 무한 캔버스 UI 자유도 | **최상** (HTML 레이어 자유) | 네이티브 UI 레이어와 싸워야 함 |
| 렌더링 충실도 | 네이티브 합성 — 동일 | 네이티브 합성 — 동일 |
| IME / 비디오 / 스크롤 | ✅ 기본 | ✅ 기본 |
| Widevine DRM (넷플릭스 등) | ❌ | ✅ |
| Chrome Extensions MV3 full | ❌ | ✅ |
| Chrome Extensions MV2 | ⚠️ 부분 (loadExtension) | ✅ |
| Chrome Web Store 설치 | ❌ | ✅ |
| Google 계정 Sync | ❌ | ✅ |
| Chrome 프로필 import | ⚠️ 부분 (bookmarks/history/cookies) | ✅ 네이티브 |
| 자동화 (CDP/Playwright) | ✅ | ✅ |
| OAuth + deep link | ✅ | ✅ |
| 보안 패치 속도 | ~3-4주 delay | upstream 따라가면 즉시 |
| 개발 속도 (MVP) | 수개월 | 1~2년+ |
| 유지보수 부담 | Electron 팀이 Chromium rebase | **자체 upstream rebase** |
| 팀 규모 | 1~2명 가능 | 최소 전담 2~3명 |
| 인프라 비용 | 낮음 | 연 수천만 원대 시작 |

---

## 결정 반영 후 남은 쟁점

> 2026-04-15 기준 **B1 포지셔닝은 해소됨**. 아래는 제품 정체성 논쟁이 아니라, workspace app 내부 브라우저 서브시스템 구현을 위해 남아있는 쟁점만 기록한다.

### B1. 포지셔닝 결정 완료

EG-Desk는 **"AI 에이전트 + automation + 무한 캔버스 워크스페이스"**로 간다. 브라우저는 독립 앱이 아니라 workspace 내부 capability다.

따라서 이제 묻는 질문은:
- "브라우저 앱을 새로 만들까?"가 아니라
- "**Electron workspace shell 안에 어떤 브라우저 엔진을 어떤 단계로 붙일까?**"다.

### B2. 엔진 후보 선택 — BrowserOS vs ABP

현재 남은 핵심 선택은 제품 포지셔닝이 아니라 **엔진 후보 비교**다.

- **ABP**: agent-native automation, settled boundary, action history, MCP 내장 강점
- **BrowserOS**: 브라우저 제품으로서의 넓은 운영 선례와 custom browser subsystem 참고값
- **stock Electron bridge**: 빠른 bootstrap/PoC 용도는 가능하지만 최종 목표로는 약함

즉, Option B의 실질적 의미는 이제 **"Chromium fork 계열 엔진을 EG-Desk 내부에 도입할지"**다.

### B3. 통합 단계 — sidecar vs embedded

엔진을 고른 뒤에도 통합 방식이 갈린다:

- **Sidecar**: Electron은 host/workspace shell, BrowserOS/ABP는 별도 프로세스
- **Embedded / engine replacement**: Electron shell은 유지하되 browser engine만 더 깊게 통합

단기엔 sidecar가 현실적이고, 중장기 목표는 embedded 쪽이다.

### B4. 호환성 목표 재정의 — extensions / profile / DRM

이제 이 항목들은 제품 정체성을 결정하는 블로커가 아니라 **workspace use case 우선순위** 문제다.

- **Extensions**: 1Password, uBlock, Grammarly 등이 workspace 핵심 업무에 얼마나 필수인지
- **Profile import**: bookmarks/history/cookies 정도면 충분한지, extensions/sync까지 필요한지
- **DRM**: 일반 소비자 브라우저 기능이 아니라면 우선순위 하향 가능

즉, "Chrome과 얼마나 닮아야 하냐"보다 **workspace 작업 흐름에 무엇이 실제로 필요한가**를 기준으로 잡아야 한다.

### B5. 유지보수/보안 패치 운영 모델

Chromium fork를 붙이는 방향으로 가더라도, 그것이 곧바로 "독립 브라우저 회사를 운영한다"는 뜻은 아니다. 다만 아래는 여전히 설계가 필요:

- upstream 보안 패치 추적 주기
- Electron host와 custom engine 간 버전 결합 방식
- BrowserOS/ABP 중 어느 쪽이 더 patch surface가 좁은지
- 팀 1인 체제에서 가능한 자동화 수준

### B6. 렌더링 경로 — WebContentsView vs OSR vs 하이브리드

workspace app으로 방향이 확정되어도 renderer 층 선택은 남아 있다:

- **WebContentsView**: interaction 기본 제공, spatial transform 수동 계산
- **OSR**: canvas 합성 자연스러움, interaction 별도 구현
- **하이브리드**: zoomed-out preview = OSR, focused/live interaction = WebContentsView

이건 엔진 선택(B2)과 독립적이지 않으므로, sidecar/embedded 방향(B3)과 같이 묶어서 판단해야 한다.

### B7. Agent 자동화 API 표준

최종적으로 agent가 브라우저 entity를 제어하는 표준을 정해야 한다:

- **ABP native API / MCP**
- **BrowserOS 계열 custom protocol / custom CDP**
- **CDP compatibility layer** (`webContents.debugger`, Playwright wrapper)

현 시점에서는 **native agent protocol 우선, CDP compatibility layer는 후방 호환**이 더 맞는 방향이다.

관련 기존 PRD:
- `ideas/confirmed/UNIFIED_BROWSER_AUTOMATION_API.md`
- `ideas/confirmed/AGENT_BROWSER_PROTOCOL_INTEGRATION.md`
- `ideas/confirmed/CONTEXT_AWARE_BROWSER_AUTOMATION.md`

### 의존성 그래프

```
B1 (workspace app 확정)
 ├── B2 (BrowserOS vs ABP)
 ├── B3 (sidecar vs embedded)
 ├── B4 (workspace 기준 호환성 목표)
 └── B5 (보안/유지보수 운영 모델)
      └── browser subsystem implementation
           ├── B6 (렌더링 경로)
           └── B7 (agent 자동화 API)
```

이제는 **포지셔닝 논쟁 때문에 멈춘 상태가 아니라**, browser subsystem 구현 순서를 정하면 바로 다음 단계로 들어갈 수 있는 상태다.

---

## 관련 기존 문서

| 문서 | 관계 |
|------|------|
| `.claude/docs/decisions/006-canvas-entity-foundation.md` | 직접 블로커 — Entity lifecycle/state 모델 정의 |
| `docs/vision/ontology-bridge.md §2.3` | "책상(Desk) = Canvas + WebContentsView" 비전 명시 |
| `ideas/confirmed/INFINITE_CANVAS_BROWSER_INTEGRATION.md` | PRD 관점 (기능 명세) — 중복 아님 |
| `ideas/confirmed/CONTEXT_AWARE_BROWSER_AUTOMATION.md` | PRD 관점 |
| `ideas/confirmed/UNIFIED_BROWSER_AUTOMATION_API.md` | PRD 관점 |
| `ideas/confirmed/AGENT_BROWSER_PROTOCOL_INTEGRATION.md` | PRD 관점 |
| `ideas/brainstorming/BROWSER_UI_LIBRARIES_RESEARCH.md` | 단기 Electron bootstrap 참고 (최종 엔진 결정과는 분리) |

이 문서는 **아키텍처 선택 관점**. 위 문서들은 **기능 명세 관점**. 직교 관계.

---

## POC 결과 (2026-04-13)

Option A의 OSR 경로 실증:

- **구현**: `src/main/index.ts`에 OSR BrowserWindow 생성, `paint` 이벤트로 `image.toPNG()` 버퍼를 IPC로 renderer 전달. `src/renderer/src/canvas/adapters/BrowserAdapter.ts`에서 `<canvas>` + `createImageBitmap` + `drawImage`로 합성
- **결과**: naver.com 30fps 렌더링 성공, 실시간 콘텐츠 반영 (배너 롤링, 비디오 재생)
- **메모리**: 총 ~635MB (main 172MB + 렌더러 2개 + GPU helper 257MB), browser entity 1개당 ~100MB
- **한계 확인**:
  - `<img src>` + Blob URL/dataURL은 contextIsolation 모드에서 작동 안 함 (X박스 브로큰 이미지) — `<canvas>` + ImageBitmap만 작동
  - React StrictMode double-effect 레이스 — `creating` 플래그로 mitigate
  - HMR 시 instance Map 리셋 → 중복 OSR 윈도우 생성
  - CPU 부담 (PNG encode + drawImage 30fps)
  - display-only — interaction은 별도 구현 필요

관련 코드: `src/main/index.ts`, `src/preload/index.cts`, `src/renderer/src/canvas/adapters/BrowserAdapter.ts`, `src/shared/browser.ts`

---

## 참고 자료 (Web Sources)

### Electron 공식
- [Offscreen Rendering Docs](https://www.electronjs.org/docs/latest/tutorial/offscreen-rendering)
- [WebContentsView API](https://www.electronjs.org/docs/latest/api/web-contents-view)
- [Migrating from BrowserView to WebContentsView](https://www.electronjs.org/blog/migrate-to-webcontentsview)
- [Session API](https://www.electronjs.org/docs/latest/api/session)
- [Chrome Extension Support](https://www.electronjs.org/docs/latest/api/extensions)
- [Deep Links tutorial](https://www.electronjs.org/docs/latest/tutorial/launch-app-from-url-in-another-app)

### GPU Shared Texture
- [PR #42953 — GPU shared texture OSR](https://github.com/electron/electron/pull/42953)
- [Issue #45428 — useSharedTexture macOS tracking](https://github.com/electron/electron/issues/45428)
- [CVE-2026-34764 shared texture release use-after-free](https://advisories.gitlab.com/pkg/npm/electron/CVE-2026-34764/)

### 선례 프로젝트
- [Stack Browser — Building a Browser in Electron](https://www.ika.im/posts/building-a-browser-in-electron)
- [Figma — Introducing BrowserView for Electron](https://www.figma.com/blog/introducing-browserview-for-electron/)
- [Meridian — Arc-like Electron Browser](https://github.com/Muvels/Meridian)
- [OrbBrowser — Electron + Widevine + Extensions](https://github.com/solarcosmic/OrbBrowser)
- [WorkOS Electron OAuth Deep Link Example](https://github.com/workos/electron-authkit-example)

### 확장 / 프로필 import
- [electron-chrome-extensions (Polypane fork)](https://github.com/Polypane/electron-chrome-extensions)
- [MV3 support issue in electron-browser-shell](https://github.com/samuelmaddock/electron-browser-shell/issues/38)
- [BrowserOS Importing Chrome Data](https://deepwiki.com/browseros-ai/BrowserOS/2.3-importing-chrome-data)
- [Arc Extension Import Guide](https://resources.arc.net/hc/en-us/articles/19434259167767-Extensions-in-Arc-How-to-Import-Add-Open)
- [Brave Chrome Profile Import Issue](https://github.com/brave/brave-browser/issues/44945)

### DRM
- [castlabs Electron for Content Security (Widevine fork)](https://github.com/castlabs/electron-releases)
- [Widevine DRM not working in Electron #38959](https://github.com/electron/electron/issues/38959)

### OAuth
- [Auth0 — Securing Electron with OIDC/OAuth](https://auth0.com/blog/securing-electron-applications-with-openid-connect-and-oauth-2/)
- [OAuth flow in Electron Apps](https://pradyothkukkapalli.com/tech/electron-oauth/)
- [Custom Protocols and Deep Linking](https://blog.bloomca.me/2025/07/20/electron-apps-custom-protocols.html)

---

**상태**: 조사 완료. 2026-04-15 기준 workspace app 포지셔닝 결정 반영 완료. 다음 결정 축은 BrowserOS vs ABP, sidecar vs embedded, WebContentsView vs OSR.
