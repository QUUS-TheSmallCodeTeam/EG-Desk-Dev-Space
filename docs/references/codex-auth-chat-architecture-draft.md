# Codex Auth Chat Architecture Draft

**Status**: Draft  
**Scope**: Design only, no implementation  
**Date**: 2026-04-13

## 1. Goal

EG-Desk에서 `Codex auth`로 chat 기능을 사용할 수 있게 하는 아키텍처 초안이다.

이 문서의 목적은 다음 세 가지다.

1. Codex 계정 인증을 renderer가 아닌 `main/preload`에 가둬서 보안 경계를 분명히 한다.
2. 현재 존재하는 HUD/chat shell, canvas entity 모델, IPC seam을 기준으로 구현 방향을 정리한다.
3. backend auth와 frontend/chat UX의 참고 레퍼런스를 분리해서 이후 구현 작업이 섞이지 않도록 한다.

## 2. Why Main/Preload

Codex auth는 renderer에 두면 안 된다. 이유는 단순하다.

- `~/.codex/auth.json`에는 토큰 원문이 들어 있다.
- renderer는 디버거, devtools, DOM inspection, 일반 상태관리 로그를 통해 노출면이 넓다.
- chat UI는 사용자 입력과 스트리밍 응답을 다루는 곳이지, 인증 비밀을 보관하는 곳이 아니다.

따라서 auth source of truth는 `~/.codex/auth.json`이고, renderer에는 토큰 원문을 절대 넘기지 않는다.

권장 경계는 아래와 같다.

- `main`: auth 파일 접근, refresh, signout, provider session orchestration
- `preload`: 최소 IPC bridge, 안전한 데이터 shape 변환
- `renderer`: session status를 받아 UI 상태만 표현, 메시지 작성/표시만 담당

이렇게 해야 인증이 UI 상태와 분리되고, 추후 provider가 바뀌어도 renderer 구조를 크게 건드리지 않는다.

## 3. Auth Source Of Truth

`~/.codex/auth.json`을 단일 source of truth로 본다.

Renderer에 전달 가능한 것:

- signed-in / signed-out 상태
- account id 또는 display label
- token refresh 결과의 성공/실패
- signout 결과

Renderer에 금지되는 것:

- access token 원문
- refresh token 원문
- id token 원문
- auth file 경로 외부로의 raw dump
- 디버그 로그에 포함된 토큰 문자열

## 4. Proposed IPC Contract

아래 계약은 초안이다. 구현 전 다시 조정할 수 있다.

| IPC | Direction | Purpose | Notes |
|---|---|---|---|
| `status` | renderer -> main | 현재 로그인/세션 상태 조회 | renderer는 이 결과만으로 UI를 그린다 |
| `refresh` | renderer -> main | 토큰 갱신 트리거 | 성공 시 최신 session summary 반환 |
| `signout` | renderer -> main | 로컬 auth 상태 제거 | 토큰 원문이 renderer로 내려오면 안 된다 |
| `sendMessage` | renderer -> main | Codex chat 요청 전송 | main이 provider bridge를 소유한다 |
| `subscribeStream` | renderer -> main | 스트리밍 응답 구독 | unsubscribe 가능한 형태가 필요하다 |

권장 응답 shape는 다음처럼 최소화한다.

- `status`: `{ authenticated, accountLabel, lastRefreshAt, provider }`
- `refresh`: `{ ok, authenticated, accountLabel, lastRefreshAt }`
- `signout`: `{ ok }`
- `sendMessage`: `{ conversationId, messageId, accepted }`
- `subscribeStream`: `{ streamId, unsubscribe }`

## 5. Renderer Structure

Renderer는 chat client shell 역할만 수행한다.

권장 구조는 다음과 같다.

- HUD chat shell: `ContextualHUD` 또는 그 후속 컴포넌트가 진입점이 된다.
- local state: composer text, optimistic message list, pending/error state, current conversation state를 renderer에서 관리한다.
- message list: 스트림 응답을 순차적으로 append/patch 한다.
- composer: submit, cancel, retry 같은 사용자 입력을 관리한다.

Renderer는 다음을 하지 않는다.

- token refresh 로직 직접 처리
- auth file 직접 읽기
- provider SDK를 직접 소유하는 일
- raw stream protocol의 최종 책임을 갖는 일

즉 renderer는 UI와 사용자 interaction만 담당하고, 네트워크/인증/세션의 민감한 책임은 main에 남긴다.

## 6. Canvas Structure

EG-Desk canvas는 chat을 하나의 entity로 다룬다.

기존 모델 기준으로 `chat` entity는 이미 존재하고 `conversationId`와 `agentConfig`를 담을 수 있다.

권장 연결 방식은 다음과 같다.

- `chat entity`: 캔버스 상의 독립 작업 단위
- `conversationId`: backend session 또는 provider conversation key와 연결
- `ChatAdapter`: hydrate/render/suspend 패턴을 구현하는 entity adapter

이 구조의 의도는 다음과 같다.

- HUD에서 시작한 chat 세션이 canvas entity로 승격될 수 있어야 한다.
- canvas entity는 chat session의 lifecycle과 화면 상태를 같이 관리해야 한다.
- 나중에 browser/ide/file-preview와 같은 다른 entity와 같은 방식으로 다룰 수 있어야 한다.

## 7. Reference Split

참고 자료는 backend auth와 frontend UX로 명확히 나눈다.

### 7.1 Backend Auth References

`oh-my-opencode`와 `opencode-openai-codex-auth`를 backend/reference로 본다.

- `oh-my-opencode`: subscription 기반 계정 로그인 흐름과 Codex/OpenCode 결합 패턴 참고
- `opencode-openai-codex-auth`: ChatGPT OAuth, Codex backend, OpenCode wiring 참고

여기서 가져올 것은 다음이다.

- auth gate
- session bootstrap
- refresh/signout orchestration
- provider bridge abstraction

가져오지 말아야 할 것은 다음이다.

- CLI-first UX 자체
- 단순한 shell wrapper 구조
- frontend에 맞지 않는 command dispatch 방식

### 7.2 Frontend References

frontend와 UX는 다른 repo를 더 우선적으로 본다.

- Theia: 앱형 chat/session/navigation abstraction 참고
- `cc-wf-studio`: panel형 chat, message list, composer, cancel/retry, tool progress 참고
- `claudecodeui`: auth-gated UI, provider switch, chat composer state 분리 참고

여기서 가져올 것은 다음이다.

- chat shell 구조
- message/composer state machine
- session persistence UX
- side panel interaction

가져오지 말아야 할 것은 다음이다.

- provider-specific auth model을 그대로 복제하는 것
- repo 고유의 디자인 시스템을 무리하게 이식하는 것

## 8. Security

이 기능에서의 핵심 보안 원칙은 단순하다.

1. 토큰 원문은 renderer에 전달하지 않는다.
2. auth 상태는 최소 shape만 전달한다.
3. IPC는 allowlist 기반으로만 열어둔다.
4. stream payload에도 비밀값을 섞지 않는다.
5. 로그, crash report, debug overlay에 auth payload를 남기지 않는다.

추가로 고려할 점:

- refresh 실패 시 자동 재시도 루프가 토큰 노출 경로를 만들지 않도록 해야 한다.
- signout은 로컬 파일 정리와 session state reset을 함께 수행해야 한다.
- multi-window 환경에서 동일 세션을 공유할지 분리할지 정책이 필요하다.

## 9. Risks

주요 리스크는 다음과 같다.

- `~/.codex/auth.json` 포맷이 변하면 loader가 쉽게 깨질 수 있다.
- `sendMessage`와 `subscribeStream`의 ownership 경계가 애매하면 renderer/main 책임이 다시 섞인다.
- canvas entity와 HUD shell이 둘 다 chat state를 만지면 상태 중복이 생길 수 있다.
- provider SDK를 main에 직접 붙이면 이후 provider 교체 비용이 커질 수 있다.
- subscription 기반 auth는 refresh expiry와 signout semantics를 명확히 하지 않으면 flaky 해지기 쉽다.

## 10. Open Questions

구현 전에 답이 필요한 질문들이다.

1. `conversationId`는 provider가 주는 원본 id를 그대로 쓸지, EG-Desk 내부 id로 감쌀지 결정해야 한다.
2. `ChatAdapter`가 snapshot/suspend를 담당할지, 아니면 단순 render/hydrate만 담당할지 정해야 한다.
3. `subscribeStream`을 event emitter 스타일로 둘지, async iterator 스타일로 둘지 결정해야 한다.
4. 하나의 Codex account로 여러 window/board가 동시에 chat을 열 수 있는지 정해야 한다.
5. auth refresh를 사용자가 명시적으로 누르게 할지, foreground session에서 자동화할지 정해야 한다.
6. 실패한 sendMessage를 renderer local queue에 재시도할지, main이 durability를 담당할지 정해야 한다.

## 11. Next Step

이 문서는 설계 초안이다.

다음 작업은 구현이 아니라, 위 IPC 계약과 state ownership을 기준으로 작은 skeleton을 나누는 것이다:

- main/preload bridge definition
- renderer HUD chat shell state model
- canvas `ChatAdapter` skeleton
- auth loading/refresh/signout policy

