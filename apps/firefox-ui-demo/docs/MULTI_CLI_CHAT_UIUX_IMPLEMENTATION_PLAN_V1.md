# EGDesk Multi-CLI Chat UIUX + Design Implementation Plan v1

**Date**: 2026-04-19  
**Scope**: EGDesk Firefox shell 기준, `Codex` 우선 구현 후 `Gemini CLI`, `Claude Code`, `OpenCode`, `OpenRouter` 확장  
**Goal**: 구독계정 기반 CLI를 EGDesk Chat surface에 통합할 때, 인증/세션/스트리밍/디버깅 UX를 일관된 제품 경험으로 제공

---

## 1) Product Target

### 1.1 핵심 목표
- 사용자는 "CLI마다 다른 로그인/세션/출력 형식"을 의식하지 않고, EGDesk의 단일 Chat UX로 작업한다.
- 인증은 보안 경계를 지키면서 빠르게 끝난다.
- 메시지 스트림은 provider별 차이를 숨기고 동일한 대화 경험을 제공한다.

### 1.2 범위
- 포함: 인증, 상태 표시, 메시지 스트림 렌더링, 세션 재개, 실패 복구, diagnostics
- 제외: 멀티에이전트 오케스트레이션 UI, 음성, 파일 업로드, branch/thread tree

---

## 2) UX North Star

### 2.1 Chat Surface 이중 구조
- **HUD Chat**: 빠른 질의/응답, 상태 확인, 로그인 진입
- **Pinned Chat Entity**: 장기 작업, 캔버스 맥락 유지, 세션 재개

### 2.2 상태 우선 UX
- 버튼 disabled 시 항상 이유를 노출한다.
- auth/bridge/session 상태를 헤더에서 분리 표시한다.
- raw 로그는 기본 접힘(diagnostics)으로 유지한다.

### 2.3 링크/텍스트 상호작용
- 모든 로그/응답 텍스트는 drag-select 가능
- auth URL/문서 URL은 클릭 시 브라우저 카드로 열기

---

## 3) Information Architecture

### 3.1 Header
- Title (`Chat`)
- Provider chip (`Codex`, `Gemini`, `Claude`, `OpenCode`, `OpenRouter`)
- Auth chip (`Signed out`, `Signing in`, `Signed in as ...`)
- Runtime chip (`Bridge online`, `Reconnecting`, `Offline`)

### 3.2 Body
- Conversation timeline (`user`, `assistant`, `thinking`, `tool_call`, `tool_result`, `system`, `error`)
- Inline retry/cancel
- 링크 파싱 렌더

### 3.3 Footer
- Composer
- Primary action (`Send`)
- Secondary actions (`Refresh`, `Sign in/out`, `Pin`, `Cancel run`)
- Diagnostics toggle

---

## 4) Provider-Agnostic Runtime Design

### 4.1 Main-process `AuthBroker` + `ProviderAdapter`
- Renderer는 토큰 원문 접근 금지
- Provider별 인증/세션/실행은 main-side adapter로 통합

```ts
type ProviderId = "codex" | "gemini" | "claude" | "opencode" | "openrouter";

interface ProviderAdapter {
  id: ProviderId;
  checkEnvironment(): Promise<EnvCheckResult>;
  getAuthStatus(): Promise<AuthStatus>;
  startAuth(opts?: StartAuthOpts): Promise<AuthStartResult>;
  cancelAuth?(authSessionId: string): Promise<void>;
  signOut(): Promise<void>;
  sendMessage(input: SendInput): Promise<RunHandle>;
  resumeSession(sessionId: string, input: SendInput): Promise<RunHandle>;
  listSessions?(scope: SessionScope): Promise<SessionSummary[]>;
}
```

### 4.2 Unified Event Envelope
- provider raw output은 renderer로 직접 전달하지 않는다.
- adapter가 `ChatEvent`로 정규화 후 브리지 송신

```ts
type ChatEventType =
  | "init" | "message" | "thinking"
  | "tool_call" | "tool_result"
  | "result" | "error" | "system";
```

### 4.3 Provider별 실행 전략
- `codex`: app-server auth 프로토콜 + `codex exec --json`
- `gemini`: `--output-format stream-json`
- `claude`: `--print - --output-format stream-json --verbose`
- `opencode`: `opencode run --format json`
- `openrouter`: OpenAI-compatible chat/completions endpoint(`https://openrouter.ai/api/v1`) + provider routing 옵션

### 4.4 CLI Provider vs Gateway Provider
- CLI Provider: `codex`, `gemini`, `claude`, `opencode`
- Gateway Provider: `openrouter`
- 공통점: renderer에는 동일한 `ChatEvent`만 노출
- 차이점:
  - CLI Provider는 로컬 프로세스 lifecycle(install/auth/session/resume) 관리가 핵심
  - Gateway Provider는 API key/OAuth credential, rate-limit, routing policy가 핵심
  - OpenRouter는 provider-native session ID가 고정적이지 않을 수 있어, EGDesk `conversationId`를 기준 세션으로 사용

---

## 5) Auth UX State Machine

```text
signed_out
  -> auth_starting
auth_starting
  -> auth_waiting_browser
auth_waiting_browser
  -> signed_in
auth_waiting_browser
  -> auth_failed
auth_failed
  -> auth_starting | signed_out
signed_in
  -> signing_out -> signed_out
```

### 5.1 UX 규칙
- `auth_waiting_browser`에서는 auth card를 최상단에 고정
- 동일 세션의 auth 브라우저 카드는 재사용(중복 생성 금지)
- stale auth(만료/취소/미스매치) 감지 시 명시적 재시작 CTA 표시

---

## 6) Conversation + Session UX

### 6.1 대화 흐름
- optimistic user bubble append
- assistant placeholder 생성 후 streaming patch
- turn 완료 시 usage/cost/latency summary 저장

### 6.2 세션 재개
- provider session ID + cwd/hash를 함께 저장
- cwd 불일치 시 자동 fresh-session fallback
- resume 실패(`unknown session`) 시 1회 자동 재시도 후 사용자 안내
- OpenRouter는 CLI resume 대신 EGDesk conversation transcript를 다음 요청 컨텍스트로 재구성

### 6.3 Canvas 연계
- `Pin to canvas`: HUD conversationId를 chat entity에 이관
- `Open in HUD`: entity를 다시 HUD로 승격

---

## 7) Visual Design Direction

### 7.1 톤
- Desk theme 토큰과 일치시키되, chat 가독성 우선
- provider chip 색상은 과채도 금지, status 대비만 유지

### 7.2 레이아웃 밀도
- 로그인 전: auth card 중심, conversation 축소
- 로그인 후: conversation 중심, auth action 축소
- diagnostics는 기본 접힘

### 7.3 모션
- streaming cursor/fade는 최소 적용
- reconnect/auth 전이 시 subtle transition만 사용

---

## 8) Security + Privacy Baseline

- 토큰/credential 원문은 renderer 미전달
- `auth.json`/credential store 경로 노출 최소화
- 로그/diagnostics에서 secret redaction
- IPC allowlist + payload schema validation

---

## 9) Implementation Roadmap

### P0 (1주): Runtime/Contract 안정화
- `ProviderAdapter` 인터페이스 도입
- Codex adapter를 기준 구현으로 고정
- renderer event schema 고정 + regression tests

### P1 (1~2주): UX 완성도
- auth card/session binding
- conversation/diagnostics 분리 UI
- resume/retry/cancel UX
- pinned entity 연동

### P2 (2주): Multi-provider 확장
- Gemini adapter
- Claude adapter
- OpenCode adapter
- OpenRouter adapter (gateway mode)
- provider switch UX + capability matrix

### P3 (지속): 품질
- E2E 시나리오 자동화
- 장애 재현 템플릿/진단 패널 강화
- 성능/latency 측정 대시보드

---

## 10) Acceptance Criteria (v1)

- 로그인/로그아웃/재로그인이 stuck 없이 완료된다.
- provider 1개(Codex) 기준 streaming, retry, resume가 안정 동작한다.
- HUD/Entity 간 세션 이관이 데이터 손실 없이 동작한다.
- diagnostics 없이도 일반 사용자가 auth/send 실패 원인을 이해할 수 있다.
- OpenRouter 경로에서 model routing 정책(`provider.order`, fallback)이 UI에서 명시적으로 확인된다.

---

## 11) References (요청 순서: 선반 -> 서재 -> 웹)

## 11.1 선반 (Shelf)

1. `references`의 선반 정의와 AI CLI 카테고리
   - `.claude/wm/project-profile.md`
   - `docs/vision/ontology-bridge.md`
   - `references/manifest.tsv`, `references/project-refs.txt`

2. Paperclip adapters (멀티-CLI 통합 패턴)
   - `references/agent-orchestration/paperclip/docs/adapters/codex-local.md`
   - `references/agent-orchestration/paperclip/docs/adapters/gemini-local.md`
   - `references/agent-orchestration/paperclip/docs/adapters/claude-local.md`
   - `references/agent-orchestration/paperclip/packages/adapters/opencode-local/src/index.ts`
   - `references/agent-orchestration/paperclip/packages/adapters/codex-local/src/ui/parse-stdout.ts`
   - `references/agent-orchestration/paperclip/packages/adapters/opencode-local/src/ui/parse-stdout.ts`
   - `references/agent-orchestration/paperclip/packages/adapters/gemini-local/src/server/test.ts`
   - `references/agent-orchestration/paperclip/packages/adapters/claude-local/src/server/test.ts`

## 11.2 서재 (Library)

1. 기존 EGDesk auth/chat 아키텍처 초안
   - `docs/references/codex-auth-chat-architecture-draft.md`

2. Firefox shell Chat HUD 설계 기준
   - `apps/firefox-ui-demo/docs/CODEX_HUD_DESIGN_V1.md`

3. Canvas entity 기반 확장성 근거
   - `.claude/docs/decisions/006-canvas-entity-foundation.md`

## 11.3 웹 조사 (Official docs 우선)

1. OpenAI Codex
   - Auth: https://developers.openai.com/codex/auth
   - App Server: https://developers.openai.com/codex/app-server
   - Non-interactive(JSONL): https://developers.openai.com/codex/noninteractive

2. Gemini CLI
   - Authentication: https://geminicli.com/docs/get-started/authentication/
   - Headless(JSON/streaming JSON): https://geminicli.com/docs/cli/headless/
   - Session management: https://geminicli.com/docs/cli/session-management/

3. Claude Code
   - CLI reference(auth/status/output-format/resume): https://code.claude.com/docs/en/cli-usage

4. OpenCode
   - CLI(auth/run/session/serve): https://opencode.ai/docs/cli/
   - Providers(auth storage/config): https://opencode.ai/docs/providers
   - Web mode(브라우저 + 세션 공유): https://opencode.ai/docs/web/

5. OpenRouter
   - API auth(API key/OAuth): https://openrouter.ai/docs/api/reference/authentication
   - OpenAI-compatible API overview: https://openrouter.ai/docs/api-reference/overview
   - Provider routing policy: https://openrouter.ai/docs/guides/routing/provider-selection

---

## 12) Decision Summary

- 기술 경계: renderer는 UI 상태만, 인증/실행은 main adapter
- UX 경계: 기본 surface는 structured chat, raw 로그는 diagnostics
- 확장 전략: Codex 우선 고정 후 Gemini/Claude/OpenCode/OpenRouter를 같은 계약으로 추가
- 검증 방법: provider별 auth/send/resume 실패 복구 시나리오를 동일 테스트 시트로 관리

---

## 13) Product Decisions Locked (2026-04-19)

아래 항목은 유저 협의로 고정된 v1 정책이다.

### 13.1 Provider 기본 선택
- 기본값은 `최근 사용 provider`로 한다.

### 13.2 오류 복구 정책 (자동재시도 vs 즉시 안내)
- 자동재시도 대상:
  - 네트워크 일시 오류
  - SSE/bridge 일시 단절
  - rate limit의 짧은 backoff 가능한 오류
- 즉시 사용자 안내 대상(재시도보다 액션 우선):
  - 인증 필요/만료 (`login required`, `auth expired`)
  - 설정 누락 (`API key missing`, `provider not configured`)
  - 권한/승인 정책 오류
  - 모델/라우팅 미지원
- UX 원칙:
  - 자동재시도 중에도 상태칩으로 진행 상황을 노출
  - 사용자 액션이 필요한 오류는 원인 + 해결 버튼(`Sign in`, `Set key`, `Switch model`)을 즉시 노출

### 13.3 Send 중 추가 입력 처리
- Send 중 사용자가 입력한 텍스트는 버리지 않고 유지한다.
- 현재 턴이 끝나면 `next tool call / next turn`에 inject 가능한 대기 draft로 처리한다.

### 13.4 Pin 정의와 동작
- `Pin`은 HUD 대화를 캔버스의 `Chat Entity`로 승격하는 동작이다.
- v1은 수동 Pin만 지원한다(자동 Pin 없음).
- Pin 이후에도 같은 conversationId를 유지하며 HUD로 복귀 가능해야 한다.

### 13.5 Provider 전환 시 컨텍스트
- provider 전환 시 기존 대화 내역을 보존하고 그대로 submit한다.
- 단, 전환 전에 경고를 표시한다:
  - 토큰 비용 증가 가능성
  - provider별 캐시 적중률 차이
  - 응답 스타일/도구 동작 차이
