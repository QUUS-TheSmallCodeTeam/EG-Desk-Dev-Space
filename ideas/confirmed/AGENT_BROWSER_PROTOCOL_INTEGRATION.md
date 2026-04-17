# Agent Browser Protocol (ABP) Integration

> ## 🔴 SUPERSEDED by ADR-007 (2026-04-17)
>
> EG-Desk 는 **Firefox chrome JS shell 로 platform pivot** (ADR-007). ABP = Chromium fork 라서 엔진 불일치로 직접 도입 불가.
>
> **현 상태**:
> - 본 문서의 **ABP 철학 (agent-aware engine, settled boundary, composited hit test 등) 은 장기 가치** 로 in-place 보존
> - **직접 도입은 보류**. 향후 Path 3 (Firefox fork + Gecko patch) 에서 일부 개념 이식 가능
> - **기존 "CDP wrapper 대체" 주장은 무효화** — Firefox chrome JS 는 `gBrowser`, `browsingContext`, `nsIWebProgressListener`, JSActor 로 네이티브 equivalent 를 **HTTP 서버 층 없이** 제공
>
> **승계 경로**:
> - 전략: [`FIREFOX_SHELL_STRATEGY.md`](FIREFOX_SHELL_STRATEGY.md)
> - ADR: [`.claude/docs/decisions/007-firefox-shell-over-electron.md`](../../.claude/docs/decisions/007-firefox-shell-over-electron.md)
> - POC: [`apps/firefox-ui-demo/`](../../apps/firefox-ui-demo/)
>
> 이 문서는 히스토리 + 추후 Gecko patch 참고 자료로 보존.

---

## AI 에이전트를 위해 브라우저 엔진 자체를 재설계한 Chromium 포크를 EG-DESK workspace app의 브라우저 서브시스템으로 도입

**작성일**: 2026-03-14
**상태**: ~~Confirmed — 도입 결정~~ → **Superseded 2026-04-17 (ADR-007)**
**관련 문서**:
- `UNIFIED_BROWSER_AUTOMATION_API.md` — 기존 CDP 기반 자동화 계획 (ABP가 엔진 레벨에서 대체) ← 이것도 Superseded
- `CONTEXT_AWARE_BROWSER_AUTOMATION.md` — 컨텍스트 인식 자동화 ← Firefox 경로로 update 예정
- `references/agent-browser-protocol/` — ABP 소스 코드 (보존, Path 3 참고용)

---

## 개요

**Agent Browser Protocol (ABP)**은 Chromium을 포크하여 AI 에이전트 전용 HTTP 서버를 브라우저 엔진 내부에 직접 내장한 프로젝트.

기존 접근(Playwright/Puppeteer → CDP → 브라우저)이 외부에서 브라우저를 제어하는 방식이라면, ABP는 **브라우저 자체가 에이전트 친화적으로 재설계**된 것.

**2026-04-15 포지셔닝 업데이트**:

- EG-Desk는 **standalone browser product**가 아니라 **Electron 기반 workspace app**으로 간다.
- 따라서 ABP 도입 목적도 "Chrome 대체 브라우저 출시"가 아니라, **EG-Desk 내부 browser entity / browser automation runtime을 강화**하는 것이다.
- Host shell은 Electron이 유지하고, ABP는 그 안의 browser subsystem 자리에 들어간다.
- BrowserOS를 택하더라도 host/engine 분리 구조는 동일하다. 이 문서는 그중 **ABP 후보안**을 구체화한 문서다.

```
기존:   AI Agent → Playwright/Puppeteer → CDP WebSocket → 브라우저
ABP:    AI Agent → REST API → AbpHttpServer(엔진 내장) → 브라우저
```

**벤치마크**: Mind2Web 온라인 90.53% 달성

### 왜 ABP인가?

EG-DESK의 핵심 비전: **"사용자가 보는 바로 그 브라우저를 AI가 함께 제어한다"**

이 비전을 `UNIFIED_BROWSER_AUTOMATION_API.md`에서는 CDP + Playwright/Puppeteer wrapper로 구현하려 했으나, ABP는 이를 **엔진 레벨에서 네이티브로 해결**.

---

## 기존 계획 대비 ABP의 이점

### UNIFIED_BROWSER_AUTOMATION_API.md가 해결하려 했던 문제 → ABP의 해법

| 기존 계획의 과제 | 기존 접근 (CDP wrapper) | ABP |
|---|---|---|
| **결정론적 실행** | Auto-wait 직접 구현 (Phase 2, 3~5일) | **엔진 레벨 settled 경계** — 구현 불필요 |
| **스크린샷** | 수동 호출 | **액션마다 전/후 자동 캡처** |
| **다이얼로그 처리** | CDP 이벤트 수동 구독 | **이벤트 스트림 내장 + 전용 API** |
| **네이티브 입력** | CDP 합성 이벤트 (감지 가능) | **RenderWidgetHost 네이티브 입력** |
| **요소 분석** | DOM 파싱 직접 구현 | **clickable/typeable/scrollable 마크업 내장** |
| **세션 기록** | WorkflowHistory 직접 구현 (Phase 8, 1~2주) | **SQLite 자동 기록 내장** |
| **JS 실행 제어** | CDP 디버거 레벨 | **엔진 레벨 완전 정지** (타이머, Date.now() 동결) |
| **히트 테스트** | 미지원 | **컴포지터 레벨 히트 테스트** |
| **가상 커서** | CSS overlay 직접 구현 | **컴포지터 레이어 커서 내장** |
| **MCP 통합** | 별도 래핑 필요 | **MCP 서버 내장** |

**결론**: 기존 계획의 Phase 1~8 (약 6~10주)의 상당 부분이 ABP에 이미 내장.

### 기존 계획에서 유지할 것

| 컴포넌트 | 유지/폐기 | 이유 |
|----------|----------|------|
| **제어권 핸드오프 프로토콜** | 유지 | ABP 위에서 User ↔ AI 전환 로직 필요 |
| **Visual Feedback System** | 부분 유지 | ABP 가상 커서와 병행, guided tour 모드용 |
| **Unified API 인터페이스** | ABP REST API로 대체 | ABP가 더 깔끔한 API 제공 |
| **CDP Connection Manager** | 폐기 | ABP가 HTTP 서버로 대체 |
| **Playwright/Puppeteer wrapper** | 폐기 | ABP REST API가 대체 |
| **Auto-wait 직접 구현** | 폐기 | ABP settled 경계가 대체 |

---

## 아키텍처

### EG-DESK + ABP 통합 구조

```
┌─────────────────────────────────────────────────────────┐
│                    EG-DESK Application                   │
├─────────────────────────────────────────────────────────┤
│                                                           │
│  ┌─────────────────────────────────────────────────┐   │
│  │       Infinite Canvas (Spatial UI)               │   │
│  │                                                   │   │
│  │  ┌──────────────┐  ┌──────────────┐             │   │
│  │  │ WebContents  │  │ WebContents  │  ...        │   │
│  │  │   View #1    │  │   View #2    │             │   │
│  │  │  (Gmail)     │  │  (GitHub)    │             │   │
│  │  │ [USER 제어]  │  │ [AI 제어]    │             │   │
│  │  └──────┬───────┘  └──────┬───────┘             │   │
│  │         │                  │                      │   │
│  └─────────┼──────────────────┼──────────────────────┘   │
│            │                  │                           │
│            │     ABP Engine (Chromium 내장)               │
│            │     ┌──────────────────────┐                │
│            └────→│  AbpHttpServer (IO)  │←───────────────┤
│                  │  localhost:8222      │                │
│                  └────────┬─────────────┘                │
│                           │                              │
│                  ┌────────┴─────────────┐                │
│                  │  AbpController (UI)  │                │
│                  │  - Input Dispatcher  │                │
│                  │  - Event Observer    │                │
│                  │  - History DB        │                │
│                  └──────────────────────┘                │
│                                                           │
│  ┌─────────────────────────────────────────────────┐   │
│  │  Theia AI System                                 │   │
│  │  ├─ ai-mcp ←→ ABP MCP Server (내장)             │   │
│  │  ├─ Handoff Coordinator (User ↔ AI 전환)        │   │
│  │  └─ Workflow Manager (ABP SQLite 연동)          │   │
│  └─────────────────────────────────────────────────┘   │
│                                                           │
└─────────────────────────────────────────────────────────┘
```

### 통합 방식 2가지

#### Option A: Workspace sidecar engine (단기 — 즉시 가능)

```
EG-Desk (Electron)
    │
    ├─ child_process.spawn('abp-browser', ['--abp-port=8222'])
    │
    └─ REST API 호출 ──→ localhost:8222
```

- Electron host/workspace shell은 그대로 유지
- ABP를 별도 브라우저 프로세스로 실행하되 EG-Desk가 lifecycle과 orchestration을 소유
- EG-Desk에서 REST API로 제어
- **장점**: workspace app 방향을 유지한 채 즉시 도입 가능, 리스크 낮음
- **단점**: 같은 workspace surface 안의 완전한 live entity가 아니라 bridge 단계에 가깝다

#### Option B: Workspace-integrated engine replacement (중장기 — 핵심 목표)

```
EG-Desk (Electron + ABP Chromium 포크)
    │
    └─ ABP가 Electron의 Chromium을 대체
       → 사용자 브라우징 = AI 자동화 = 같은 엔진
```

- Electron shell은 유지하고, browser engine만 ABP 포크 기반으로 더 깊게 통합
- 사용자가 보는 browser entity = AI가 제어하는 automation target = 동일 엔진
- **장점**: workspace app 내부에서 완벽한 live browser entity 통합 가능
- **단점**: Chromium 보안 패치 유지보수 필요

---

## Chromium 보안 패치 유지 전략

EG-Desk는 사용자가 직접 웹서핑하는 브라우저이므로 보안 패치 필수.

### 업계 선례

| Chromium 포크 | 팀 규모 | 업데이트 주기 | 비고 |
|---|---|---|---|
| Brave | ~200명 | 1~2주 | 자체 광고 차단 등 대규모 패치 |
| Vivaldi | ~50명 | 2~4주 | UI 전면 커스텀 |
| Arc | ~100명 | 2~4주 | 탭 관리 재설계 |
| **ABP** | 소규모 | 추적 필요 | 패치가 `chrome/browser/abp/`에 집중 |

### ABP 패치의 특성 — 유지보수 용이

ABP의 Chromium 수정 범위가 **한 디렉토리에 집중**:

```
chrome/browser/abp/           ← ABP 전용 코드 (여기만 추가)
  ├── abp_http_server.cc/h     # HTTP 서버
  ├── abp_controller.cc/h       # 요청 처리
  ├── abp_action_context.cc/h   # 액션 생명주기
  ├── abp_input_dispatcher.cc/h # 네이티브 입력
  ├── abp_event_observer.cc/h   # 이벤트 감시
  ├── abp_mcp_handler.cc/h      # MCP 서버
  └── abp_history_database.cc/h # SQLite 저장
```

- Chromium 코어 수정 최소화 → upstream rebase 시 **충돌 가능성 낮음**
- Brave/Vivaldi처럼 대규모 UI 수정이 아니라 **기능 추가 수준**
- 보안 패치는 주로 렌더러/네트워크 스택에 적용 → ABP 패치와 겹칠 가능성 극히 낮음

### 유지보수 파이프라인

```
1. Chromium 보안 릴리스 모니터링 (자동)
   → https://chromereleases.googleblog.com/

2. ABP 포크에 cherry-pick
   → git cherry-pick <security-patch-commits>

3. ABP 패치 rebase 확인
   → chrome/browser/abp/ 충돌 여부 체크

4. CI/CD 빌드 + 자동 테스트

5. EG-Desk 릴리스에 포함
```

### 리스크 대응

| 리스크 | 심각도 | 대응 |
|--------|--------|------|
| ABP 프로젝트 중단 | 중간 | BSD 라이선스 → 포크 유지 가능. 패치 코드 규모 작음 |
| Chromium 보안 패치 지연 | 높음 | 패치 집중도 낮아 rebase 용이. 자동화 파이프라인 구축 |
| Electron 호환성 | 중간 | Electron도 Chromium 포크 → 패치 전략 참고 가능 |

---

## ABP 핵심 API

### REST API (MCP 없이 직접 사용)

| 엔드포인트 | 설명 |
|-----------|------|
| `GET /api/v1/tabs` | 활성 탭 목록 |
| `POST /api/v1/tabs/{id}/navigate` | URL 탐색 |
| `POST /api/v1/tabs/{id}/click` | 클릭 (x, y 좌표) |
| `POST /api/v1/tabs/{id}/type` | 텍스트 입력 |
| `POST /api/v1/tabs/{id}/scroll` | 스크롤 |
| `POST /api/v1/tabs/{id}/execution` | JS 일시정지/재개 |
| `POST /api/v1/tabs/{id}/dialog/accept` | 다이얼로그 처리 |

### 액션 응답 구조

한 번의 액션 요청에 모든 컨텍스트가 반환:

```json
{
  "result": {"status": "clicked"},
  "screenshot_before": {"data": "base64-webp...", "width": 1920},
  "screenshot_after": {"data": "base64-webp...", "height": 1080},
  "scroll": {"scrollX": 0, "scrollY": 150},
  "events": [
    {"type": "navigation", "data": {}},
    {"type": "dialog", "data": {"dialog_type": "confirm", "message": "Delete?"}},
    {"type": "file_chooser", "data": {}}
  ],
  "cursor": {"x": 450, "y": 320, "cursor_type": "pointer"}
}
```

### 요소 마크업

```bash
curl -X POST http://localhost:8222/api/v1/tabs/{id}/click \
  -d '{"x": 450, "y": 320, "screenshot": {"markup": ["clickable", "typeable"]}}'
```

스크린샷에 인터랙티브 요소가 자동 표시 → AI 에이전트의 시각적 이해도 향상.

---

## EG-DESK 시나리오 매핑

### 시나리오 1: User ↔ AI Handoff (기존 계획 강화)

```
1. 사용자가 Gmail에서 이메일 작성 (ABP 브라우저에서 직접)

2. "AI, 나머지 받는 사람들한테도 보내줘"
   → ABP REST API로 같은 탭 제어
   → 네이티브 입력 (RenderWidgetHost) → 사이트가 봇으로 감지 불가
   → 액션마다 before/after 스크린샷 자동

3. AI 작업 완료 → 사용자가 바로 이어서 사용
   → 세션, 쿠키, 로그인 상태 모두 유지
```

### 시나리오 2: AI 학습 (Learning from Observation)

```
1. 사용자가 작업 수행 → ABP가 모든 액션 SQLite에 자동 기록
   - 클릭 좌표, 타이핑 내용, 네비게이션
   - 전/후 스크린샷, 타이밍, 이벤트

2. 기록된 데이터 → AI 학습/파인튜닝 데이터셋으로 직접 활용
   - 온프레미스 LLM (llama.cpp) 파인튜닝
   - 워크플로우 자동 생성

3. "AI, 아까 한 거 5번 반복해줘"
   → 기록된 액션 시퀀스 재실행
```

### 시나리오 3: MCP 통합 (Theia ai-mcp)

```
EG-DESK Theia
  └─ ai-mcp 패키지
       └─ ABP MCP Server (내장)
            └─ 13개 브라우저 제어 도구 자동 노출
               - navigate, click, type, scroll, screenshot...
```

별도 MCP 래핑 불필요. ABP가 MCP 서버로 직접 동작.

---

## 도입 로드맵

### Phase 1: 검증 (1주)

- [ ] ABP npm 패키지로 PoC 실행 (`npx -y agent-browser-protocol`)
- [ ] REST API 기본 동작 검증 (navigate, click, type)
- [ ] MCP 연결 테스트 (Theia ai-mcp와 연동)
- [ ] 성능 벤치마크 (액션당 레이턴시, 스크린샷 품질)

### Phase 2: 사이드카 통합 (2주)

- [ ] EG-Desk에서 ABP를 child_process로 실행
- [ ] ABP REST API wrapper 작성 (TypeScript)
- [ ] 기존 Playwright 자동화 코드를 ABP API로 전환
- [ ] Handoff Coordinator를 ABP 위에서 재구현

### Phase 3: Electron Chromium 교체 검토 (3~4주)

- [ ] ABP Chromium 빌드 환경 구축
- [ ] Electron의 libchromiumcontent를 ABP 포크로 교체 시도
- [ ] WebContentsView + ABP API 통합 테스트
- [ ] 보안 패치 rebase 파이프라인 구축

### Phase 4: 프로덕션 통합 (4~6주)

- [ ] Chromium 보안 패치 자동화 파이프라인
- [ ] ABP SQLite ↔ EG-Desk 워크플로우 시스템 연동
- [ ] 사용자 브라우징 + AI 자동화 통합 UX
- [ ] 온프레미스 LLM 훈련 데이터 파이프라인 (ABP 세션 기록 활용)

---

## 기술 상세

### 라이선스

- **BSD 3-Clause** — 수정, 재배포, 상업적 사용 모두 허용
- 저작권 고지 유지만 필요

### 시스템 요구사항

- macOS, Linux, Windows 빌드 지원
- npm 패키지로 즉시 실행 가능: `npx -y agent-browser-protocol`
- 기본 포트: 8222 (`--abp-port`로 변경 가능)

### 성능

- 액션당 오버헤드: ~100ms (스크린샷 포함)
- 병목: 브라우저가 아닌 LLM
- 병렬 탭/세션 지원

### 보안

- localhost에서만 실행 (기본)
- 시스템 입력 기본 차단 (`--allow-system-inputs`로 오버라이드)
- MCP 또는 REST를 통한 통제된 접근

---

## 참고 자료

- **ABP GitHub**: https://github.com/theredsix/agent-browser-protocol
- **ABP npm SDK**: https://github.com/theredsix/abp-npm
- **npm 패키지**: `agent-browser-protocol`
- **REST API 문서**: `references/agent-browser-protocol/docs/REST-API.md`
- **컴파일 가이드**: `references/agent-browser-protocol/COMPILE.md`
- **훈련 파이프라인**: `references/agent-browser-protocol/TRAINING.md`
- **Electron + Custom Chromium**: https://www.jochendelabie.com/2021/10/29/electron-with-custom-chromium-build/
- **Electron Chromium as Library**: https://www.electronjs.org/blog/electron-internals-building-chromium-as-a-library
