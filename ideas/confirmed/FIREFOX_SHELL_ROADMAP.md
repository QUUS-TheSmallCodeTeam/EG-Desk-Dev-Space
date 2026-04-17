# Firefox Shell Roadmap

**작성일**: 2026-04-17
**상태**: Confirmed — 전략 PRD 에 따른 실행 계획
**관련**: [ADR-007](../../.claude/docs/decisions/007-firefox-shell-over-electron.md), [`FIREFOX_SHELL_STRATEGY.md`](FIREFOX_SHELL_STRATEGY.md)

---

## Overview

Firefox chrome JS shell 전환의 단계적 실행 계획. 각 phase 는 이전 산출물을 compound 하고 `Gate` (다음 phase 진입 조건) 로 제어.

```
Path 1 (완료)     Path 2            Path 2+WASM        Path 3 (선택)
POC runtime   ─→  Portable pkg  ─→  연산 레이어 추가  ─→ Firefox fork
inject            Alpha 배포         (점진)              Beta/GA
2026-04-17        ~3주               모듈당 1주 × N      2~3주 + CI
```

---

## Path 1 — Runtime Injection POC (✅ 완료, 2026-04-17)

### 산출물

- `apps/firefox-ui-demo/` — 완전한 POC
- 4-Edge Framework (Desk Rail / Dock / Preset Bag / Contextual HUD)
- Canvas pan/zoom + Browser entity 카드 + popup capture
- fx-autoconfig runtime injection 증명
- 설치 스크립트 (Windows / macOS / Linux)
- ADR-007 + Strategy PRD

### 검증된 기술 가정

- ✅ Firefox chrome JS 로 완전한 UI 재구성 가능
- ✅ XUL `<browser>` 로 실제 웹페이지 canvas 카드 렌더
- ✅ `window.browserDOMWindow` override 로 popup 라우팅
- ✅ `Subprocess.sys.mjs` 로 임의 바이너리 spawn 가능
- ✅ `IOUtils` 가 Node `fs` 의 ~90% 커버

### Gate → Path 2 진입 조건

- [x] Session Lead + 유저 승인 (ADR-007 Decided)
- [x] 기존 confirmed 문서 supersede/update 완료 (Phase B)
- [x] 새 설계 문서 skeleton 완료 (Phase C)

---

## Path 2 — Portable 재패키징 (Alpha 배포)

### 목표

사용자 PC 의 기존 Firefox 없이도 실행되는 **단일 앱 `EGDesk`**. 초기 테스터 ~100명 규모.

### Deliverables

| 영역 | 산출물 | 비고 |
|------|-------|------|
| **패키지 빌드** | `EGDesk-1.0.0-win64.exe`, `EGDesk-1.0.0-mac-arm64.dmg`, `EGDesk-1.0.0-linux.AppImage` | 각 OS 별 인스톨러 |
| **Firefox 번들** | Firefox Stable 또는 ESR 바이너리 재패키징 + 우리 `config.js` + `defaults/pref/` | `browser/branding/` 에셋 교체 |
| **Chrome JS baseline** | `apps/firefox-ui-demo/overlay/JS/*.uc.js` + CSS → 번들 프로필에 포함 | Path 1 산출물 재사용 |
| **Bun 런타임 번들** | `runtime/bun.exe` (각 OS 버전) ~90MB | mini-app 런타임 |
| **egdesk-helper** | Rust 바이너리 (PTY + tray + hotkey + file-watch) | `EGDESK_HELPER_BINARY_SPEC.md` |
| **자체 updater** | 새 버전 감지 → 다운로드 → 재시작. Firefox AUS 프로토콜 또는 자체 구현 | |
| **브랜딩** | 앱 아이콘 / 인스톨러 배너 / 첫 실행 스플래시. "EGDesk" 단독명, "Built on Mozilla Firefox" 고지 | Mozilla trademark 준수 |
| **Mini-app 인프라** | `egdesk.json` manifest parser, install/start/stop 라이프사이클, 초기 3 개 번들 앱 (browser, notes, kanban placeholder) | `MINI_APP_ECOSYSTEM.md` |

### Gating 체크리스트

- [ ] 단일 설치 파일로 기존 Firefox 없이 실행
- [ ] 앱명 `EGDesk` 리브랜딩, trademark audit 1회 통과
- [ ] Path 1 UI 기능 전부 동등 작동 (4-Edge / canvas / card / popup capture)
- [ ] 최소 3 개 번들 mini-app 동작
- [ ] 터미널 카드 (helper PTY) + 전역 단축키 + tray 작동
- [ ] 크래시 없이 8 시간 연속 사용 (stress test)
- [ ] 메모리 <2GB (기본 + 카드 5)
- [ ] 시작 <5 초
- [ ] 자체 updater 가 patch 배포 성공
- [ ] Windows / macOS / Linux 셋 다 CI 빌드

### 예상 기간

**2~3 주** (1 인 풀타임 기준)

| 주 | 작업 |
|----|------|
| 1 | Firefox 재패키징 PoC (Windows), 브랜딩 에셋 교체, `config.js` 번들 |
| 2 | egdesk-helper MVP (PTY + tray), bun 번들, mini-app 라이프사이클 |
| 3 | 인스톨러 (NSIS/pkg/AppImage), 자체 updater, macOS/Linux 포팅, CI |

병렬화 가능 (helper + packaging 별 개발자) 시 1.5~2 주.

### 리스크

| 리스크 | 완화 |
|--------|------|
| Mozilla trademark 위반 판단 | 초안 브랜드로 내부 alpha 먼저, 외부 배포 전 법무 리뷰 |
| 크로스플랫폼 패키징 복잡도 | Windows 먼저 안정화 후 macOS/Linux 순차 확장 |
| Helper PTY 가 예상보다 복잡 | 초기엔 최소 기능 (input/output) 만, agent-aware 이벤트는 Path 2+WASM 에 |
| Firefox 업데이트 주기 | ESR 채널 사용 (월 릴리즈 대신 분기) |

### Gate → Path 2+WASM 진입 조건

- [ ] Alpha 배포 실제 사용자 피드백 최소 2 주 수집
- [ ] 실질 latency 병목 1 개 이상 식별 (예: vector search, 실시간 파싱)

---

## Path 2 + WASM — 연산 레이어 추가 (점진)

### 목표

Latency 민감 기능을 **in-process WASM 모듈** 로 이식해 WebSocket IPC 회피. Alpha 사용자 피드백 기반 우선순위.

### 예상 모듈 (우선순위 후보)

| 모듈 | 근거 | 예상 기간 |
|------|------|----------|
| `tokenizer` | Agent context 길이 계산 (Node `tiktoken` 대응) | 1 주 |
| `fuzzy-search` | Cmd+K Spotlight 실시간 매칭 | 1 주 |
| `markdown-renderer` | Notes / Preset 렌더 | 1 주 |
| `vector-search` | Agent RAG, 타이핑 중 관련 문서 surface | 2 주 |
| `tree-sitter` | Code editor 카드 실시간 파싱 | 2~3 주 (grammar 별 별도) |

### Deliverables (per 모듈)

- Rust crate → `wasm32-unknown-unknown` 컴파일 파이프라인
- `wasm-bindgen` glue 코드
- Chrome JS 로더 + API wrapper
- 단위 테스트 + 벤치마크 (JS ↔ WASM 오버헤드)
- `EGDESK_WASM_LAYER.md` 에 문서화

### Gating

- 각 모듈: 해당 UX 개선이 blind A/B test 로 식별 가능 (지연 감소 측정)
- 빌드 파이프라인 CI 통합

### Gate → Path 3 진입 조건 (optional)

- [ ] Runtime injection 으로 못 하는 구조적 UX 요구 3 개 이상 누적, **또는**
- [ ] 완전 독립 브랜드 필요성 (Mozilla 명시 없이 배포), **또는**
- [ ] Gecko patch 가 필요한 agent-native 기능 요청 (예: ABP 급 settled boundary 재이식)

**Path 3 은 의무 아님**. Path 2+WASM 이 장기 정착지일 수 있음.

---

## Path 3 — Firefox Fork (Beta/GA, 선택적)

### 목표

Surfer 기반 Firefox fork. 구조적 UX 변경 + 완전 독립 브랜드 + 자체 업데이트 인프라.

### Deliverables

| 영역 | 산출물 | 비고 |
|------|-------|------|
| **빌드 인프라** | Mozilla build env setup, Surfer project 초기화 | 1~2 일 |
| **패치 워크플로** | `src/browser/base/content/browser-xhtml.patch` 등 | Zen Browser 구조 참고 |
| **브랜딩 완전 교체** | `browser/branding/egdesk/` 전체 새 에셋 + `app.name` 완전 독립 | |
| **Gecko 패치** (선택) | agent-native 기능 (ABP 급 settled boundary 재이식 등) | 필요시만 |
| **자체 업데이트 서버** | AUS 프로토콜 구현 + balrog-like service | |
| **Cross-platform CI** | Windows / macOS (arm64+x64) / Linux 자동 빌드 | GitHub Actions |
| **서명 / Notarization** | Windows Authenticode, macOS notarization | 비용 발생 |

### Gating 체크리스트

- [ ] Surfer 기반 build 반복 가능
- [ ] 첫 Firefox 업데이트 rebase 성공 (patch conflict 수동 해결 1회)
- [ ] CI 에서 3 OS 모두 성공 빌드
- [ ] 자체 업데이트 서버 production 배포
- [ ] 서명/notarization 완료
- [ ] 앞서 식별된 "Path 3 필요 UX" 최소 1 개 실구현 증명

### 예상 기간

**2~3 주 초기 + 지속 유지비**

| 주 | 작업 |
|----|------|
| 1 | Surfer setup, 첫 빌드, Zen repo 구조 복제, 패치 3~5 개 이식 |
| 2 | 브랜드 완전 교체, 자체 업데이트 서버, Cross-platform CI |
| 3 | Gecko patch 1 개 (agent-native 기능), 서명, Beta 릴리즈 |
| 이후 | Mozilla 월 릴리즈마다 rebase (0.5~1 일/회), 기능 추가 |

### 리스크

| 리스크 | 완화 |
|--------|------|
| Patch conflict 지옥 | Zen Browser commit history 에서 선례 학습, 작은 patch 여러 개 |
| Gecko 내부 API 변경 | ESR 베이스 사용 시 주기 길어 rebase 적음 |
| 서명 인프라 비용 | Apple Developer 프로그램 (~$99/년), Windows 코드서명 (~$200/년) |
| 업데이트 서버 유지비 | Cloud storage + CDN 비용, 사용자 수 비례 |

---

## 비선형 경로 — 중단/철회 시나리오

현 계획이 잘못됐다고 판단되는 시점에 되돌릴 수 있는 지점:

### Exit 1 — Path 2 Alpha 결과 실패 (사용자 반응 저조)

- **증상**: 사용자 retention 낮음, "그냥 다른 브라우저 쓰면 되잖아" 피드백
- **대응**: Electron 복귀 고려. Path 1 chrome JS 코드 자산 (4-Edge / canvas 로직) 을 Electron renderer 로 포팅 가능 (React 재작성 필요)

### Exit 2 — Mozilla trademark 이슈로 배포 불가

- **증상**: Mozilla 법무 통보
- **대응**: 즉시 앱명 변경, 고지 강화. 최악의 경우 Path 3 으로 가속 (완전 독립 브랜드)

### Exit 3 — Firefox chrome API 대규모 변경

- **증상**: Firefox 버전 X 에서 chrome JS 전반적으로 깨짐
- **대응**: ESR 채널로 fallback + X+1 버전 대응 paused until stabilization

### Exit 4 — WASM 으로 해결 안 되는 근본 성능 병목

- **증상**: 특정 UX 가 WebSocket IPC 도 WASM 도 부족
- **대응**: Path 3 fork + Gecko patch (in-process C++ 확장). 또는 해당 기능을 별도 Electron companion app 으로 분리 (hybrid)

---

## 장기 비전 (Path 3 이후)

Path 3 정착 후 고려 사항들:

- **ABP 개념 Gecko 로 이식** — settled boundary, composited hit testing, action-level screenshots 등을 EG-Desk Gecko fork 에 patch
- **Servo embed** — Servo 가 embedding API 성숙 시 대체 엔진 옵션 탐색
- **Agent-native engine features** — EG-Desk 전용 Gecko 익스텐션 (custom JSActor, built-in agent primitives)
- **Marketplace** — mini-app 공개 마켓, revenue share
- **Sync / 멀티 디바이스** — Firefox Sync 프로토콜 활용 또는 자체
- **엔터프라이즈 배포** — B2B 판매, 관리 콘솔, SSO

이 부분은 현 시점 plan 이 아니라 **long-term parking lot**.

---

## 의사결정 로그

| 날짜 | 결정 | 근거 |
|------|------|------|
| 2026-04-15 | Electron OSR POC 완료, 한계 인식 | `docs/browser-canvas-osr-poc-2026-04-15.md` |
| 2026-04-17 | Firefox shell pivot 확정 | ADR-007, apps/firefox-ui-demo POC |
| TBD | Path 2 착수 시점 | 현재 미정 — 사용자 결정 |
| TBD | Path 3 진입 여부 | Path 2+WASM 후 reassess |

---

## 다음 액션

**즉시 (이번 주)**:
1. 이 문서 검토 / 피드백
2. Phase C 세부 설계 문서 리뷰 (`EGDESK_HELPER_BINARY_SPEC`, `MINI_APP_ECOSYSTEM`, `FIREFOX_CHROME_JS_PATTERNS`, `EGDESK_WASM_LAYER`)
3. Path 2 착수 시점 + 담당자 결정

**Path 2 착수 시**:
1. Firefox Stable vs ESR 채널 선택 (ESR 권장)
2. 브랜드 에셋 발주 (아이콘 / 스플래시 / 인스톨러 배너)
3. egdesk-helper PoC (PTY only) 으로 스켈레톤 구축
4. 패키징 CI 파이프라인 (Windows 먼저)
5. 첫 alpha 빌드 (1주 내 내부 테스트)
