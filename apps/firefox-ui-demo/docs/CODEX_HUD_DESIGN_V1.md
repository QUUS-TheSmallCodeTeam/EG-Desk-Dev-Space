# Codex Chat HUD Design v1

**작성일**: 2026-04-18  
**상태**: Draft for implementation lock  
**범위**: `apps/firefox-ui-demo/overlay/` 기준 Firefox shell Path 1 / Path 2 alpha 공용 UX  
**관련**:
- [`README.md`](../README.md)
- [`RESEARCH.md`](./RESEARCH.md)
- [`FIREFOX_SHELL_STRATEGY.md`](../../../ideas/confirmed/FIREFOX_SHELL_STRATEGY.md)
- [`FIREFOX_SHELL_ROADMAP.md`](../../../ideas/confirmed/FIREFOX_SHELL_ROADMAP.md)

---

## 1. 목적

Codex Chat HUD 는 단순한 "CLI output viewer" 가 아니라, EG-Desk 안에서 agent 와 상호작용하는 **주요 제어 surface** 다.

따라서 이 HUD 는 다음을 동시에 만족해야 한다.

1. **채팅 인터페이스**여야 한다.
   단순 로그 창이 아니라 대화, 진행 상태, 오류, 재시도, 히스토리 맥락이 보여야 한다.
2. **운영 콘솔**이어야 한다.
   bridge 연결 상태, auth 진행 상태, 현재 conversation 상태가 보여야 한다.
3. **문제 해결 surface**여야 한다.
   device auth 링크 클릭, 로그 복사, 에러 해석, 선택/복사가 즉시 가능해야 한다.
4. **캔버스와 연결된 surface**여야 한다.
   HUD 의 대화는 추후 canvas entity 로 pin, detach, resume 할 수 있어야 한다.

현재 구현은 transport spike 이므로, 이 문서가 앞으로의 **source of truth** 가 된다.

---

## 2. 비목표

이번 v1 설계에서 하지 않는 것:

- 멀티 agent orchestration UI
- thread tree / branch UI
- tool call visualization 상세 diff UI
- 음성 입력 / 음성 출력
- 파일 첨부 / drag-drop upload
- 완전한 Slack/Discord 수준 채팅 클라이언트

즉 v1 은 **Codex CLI 기반 desktop agent chat HUD** 에 집중한다.

---

## 3. 제품 원칙

### 3.1 CLI 를 숨기지 말고, 직접 노출하지도 말 것

Codex CLI 는 내부 transport 이다.  
유저는 "CLI 가 도는 중" 을 알 수는 있어야 하지만, 기본 화면이 raw terminal dump 가 되어서는 안 된다.

원칙:

- 기본 surface = structured chat
- raw log = diagnostics drawer / expandable panel
- auth 중에는 예외적으로 진행 로그를 보여줄 수 있음

### 3.2 상태는 항상 설명 가능해야 함

버튼이 disabled 이면 이유가 보여야 한다.  
연결이 끊겼으면 재연결 중인지, 실패인지, bridge 가 없는지 구분돼야 한다.

금지:

- 이유 없는 disabled 버튼
- 텍스트만 있고 현재 상태가 무엇인지 알 수 없는 화면
- "already running" 같은 내부 오류를 최종 UX 문구로 그대로 노출

### 3.3 텍스트는 선택 가능해야 함

agent output, auth log, error, 링크, conversation id 는 전부 drag-select 와 copy 가 가능해야 한다.

### 3.4 링크는 actionable 해야 함

로그 안 URL 은 항상 클릭 가능해야 하고, 클릭 시 어디에 열리는지가 예측 가능해야 한다.

v1 원칙:

- auth URL 클릭 → 새 브라우저 카드로 열기
- 일반 URL 클릭 → 새 브라우저 카드로 열기

---

## 4. 정보 구조

HUD 는 세 구역으로 나눈다.

1. **Header**
   현재 모드, auth 상태, bridge 상태, close
2. **Conversation Pane**
   실제 메시지 흐름, system/status line, streaming response
3. **Composer + Diagnostics**
   입력창, send, auth actions, expandable diagnostics

### 4.1 Header

Header 에 항상 보여야 하는 정보:

- 타이틀: `Codex Chat`
- auth summary:
  - `Signed out`
  - `Signing in…`
  - `Signed in as {email}`
- bridge summary:
  - `Bridge online`
  - `Bridge reconnecting…`
  - `Bridge offline`
- optional latency chip:
  - `Bridge 12ms`

Header action:

- `Close`

Header 에 넣지 않는 것:

- Refresh / Sign in / Sign out
- Pin to canvas
- verbose login output

이건 body 또는 footer action row 로 내려간다.

### 4.2 Conversation Pane

Conversation pane 이 기본 surface 다.

메시지 타입:

- `user`
- `assistant`
- `system-status`
- `error`

보여줘야 하는 요소:

- role 구분
- streaming 중 indicator
- retry 가능한 에러일 때 재시도 action
- 링크 파싱
- 전체 drag-select 가능

금지:

- auth 중 raw log 가 대화 pane 전체를 밀어내는 것
- bridge 상태 메시지가 conversation 흐름과 섞여 의미를 해치는 것

### 4.3 Diagnostics

진단 정보는 기본적으로 접혀 있어야 한다.

Diagnostics 영역 포함 항목:

- device auth output
- bridge raw error
- latest CLI stderr
- conversation id
- internal status snapshot

기본 정책:

- 문제 없을 때는 collapse
- auth 진행 중 / 에러 발생 시 자동 펼침 가능

---

## 5. 주요 화면 상태

### 5.1 Signed Out / Idle

보여줄 것:

- 빈 상태 일러스트 또는 간단한 intro
- `Sign in`
- `Refresh`
- 입력창 disabled
- disabled 이유 문구: `Sign in to start chatting`

### 5.2 Signing In / Waiting Device Auth

보여줄 것:

- 상단 상태: `Signing in…`
- `Sign in` 버튼은 `Signing in…` disabled 상태
- auth link card
- auth code card
- `Open link` / `Copy code`
- diagnostics drawer 안에 raw auth output

핵심:

- 유저가 raw log 속 링크를 찾아야 하는 구조 금지
- 링크와 코드는 structured surface 로 추출해 보여줘야 함

### 5.3 Signed In / Empty Conversation

보여줄 것:

- `Signed in as ...`
- 입력 가능
- conversation pane 에 onboarding hint
- `Sign out`

### 5.4 Sending

보여줄 것:

- user message 즉시 optimistic append
- send 버튼 disabled
- assistant placeholder bubble 생성
- 입력창은 유지 가능하되, v1 에선 disable 여부 선택 가능

권장:

- v1 은 send 중에도 다음 draft 작성은 허용
- 단, 실제 전송은 현재 streaming 종료 후 가능

### 5.5 Streaming

보여줄 것:

- assistant bubble 내용이 점진적으로 증가
- bubble 하단 작은 `Streaming…`
- 스크롤이 맨 아래에 있으면 autoscroll
- 유저가 위로 스크롤했으면 autoscroll 해제

### 5.6 Error

에러는 세 종류로 구분:

1. `auth-required`
2. `bridge-offline`
3. `execution-failed`

각 에러는 문구가 달라야 한다.

예:

- `Sign in is required before sending messages.`
- `Codex bridge is offline. Restart local bridge and retry.`
- `Codex returned an execution error. Review diagnostics and retry.`

---

## 6. 상태 머신

### 6.1 Auth State

```text
signed_out
  -> starting_login
starting_login
  -> waiting_device_auth
waiting_device_auth
  -> signed_in
waiting_device_auth
  -> auth_failed
auth_failed
  -> starting_login
signed_in
  -> signed_out
```

### 6.2 Chat State

```text
idle
  -> sending
sending
  -> streaming
streaming
  -> complete
streaming
  -> error
complete
  -> sending
error
  -> sending
```

### 6.3 Bridge State

```text
offline
  -> connecting
connecting
  -> online
connecting
  -> offline
online
  -> reconnecting
reconnecting
  -> online
reconnecting
  -> offline
```

중요:

- HUD UI 는 이 세 상태를 따로 가지고 렌더해야 한다.
- 하나의 `statusText` 문자열로 다 해결하려고 하면 안 된다.

---

## 7. 인터랙션 규칙

### 7.1 텍스트 선택

다음 영역은 모두 drag-select 가능:

- assistant message
- user message
- error message
- diagnostics log
- auth code
- conversation id

금지:

- 선택하려다가 canvas pan 이 시작되는 것
- 링크 드래그 시 selection 자체가 막히는 것

### 7.2 링크 클릭

링크 클릭 동작:

- 클릭 → 새 브라우저 카드 spawn
- HUD 는 닫지 않음
- 새 카드가 active/highlight 됨

추가 액션:

- context menu: `Copy link`

### 7.3 Device Auth 구조화

device auth output 에서 반드시 구조화 추출할 것:

- verification URL
- user code
- optional expiry / note

UI:

- `Open verification page`
- `Copy code`

Raw log 는 diagnostics 로 내려간다.

### 7.4 Scroll behavior

- conversation pane: 자체 스크롤
- diagnostics pane: 자체 스크롤
- HUD 내부에서 시작한 two-finger scroll 은 canvas pan 금지

### 7.5 Focus behavior

- HUD open 시 input autofocus 가능
- auth 진행 중이면 input autofocus 금지
- 링크 클릭 후에도 HUD focus 유지

---

## 8. 컴포넌트 구조

### 8.1 Header Row

- icon
- title
- auth badge
- bridge badge
- close button

### 8.2 Action Row

- `Refresh`
- `Sign in` or `Sign out`
- `Pin to canvas` (v1.1)

### 8.3 Auth Card

조건:

- `waiting_device_auth` 일 때만 표시

내용:

- title: `Complete sign-in`
- CTA: `Open verification page`
- code block
- secondary action: `Copy code`

### 8.4 Message List

- virtualized 까지는 필요 없음
- role-based bubble
- system status row
- streaming row

### 8.5 Diagnostics Drawer

- collapsed by default
- toggle: `Show diagnostics` / `Hide diagnostics`
- raw log selectable
- urls clickable

### 8.6 Composer

- multiline input 아님, v1 에선 single-line
- `Enter` = send
- `Shift+Enter` 미지원
- send button

---

## 9. 데이터 계약

현재 bridge 계약은 임시다. v1 에서 아래 shape 로 고정하는 것이 목표다.

### 9.1 `/auth/status`

```json
{
  "isLoggedIn": false,
  "authMode": null,
  "accountId": null,
  "accountEmail": null,
  "lastRefresh": null,
  "source": "none",
  "statusText": "Login required",
  "loginInProgress": false,
  "verificationUrl": null,
  "userCode": null
}
```

### 9.2 `codex` SSE event

```json
{ "type": "auth-status", "status": { ... } }
{ "type": "login-started" }
{ "type": "login-output", "chunk": "..." }
{ "type": "login-finished", "success": true, "status": { ... } }
{ "type": "assistant-start", "conversationId": "...", "message": { ... } }
{ "type": "assistant-delta", "conversationId": "...", "messageId": "...", "delta": "..." }
{ "type": "assistant-complete", "conversationId": "...", "messageId": "..." }
{ "type": "assistant-error", "conversationId": "...", "messageId": "...", "error": "..." }
```

### 9.3 Missing contract in current spike

현재 spike 에 없는 것:

- login output 에서 `verificationUrl`, `userCode` 구조화 추출
- cancel login
- retry semantics
- bridge version / protocol version
- pin-to-canvas conversation snapshot

---

## 10. 구현 우선순위

### Phase A — UX skeleton lock

- [ ] Header / Action Row / Conversation / Diagnostics / Composer 레이아웃 고정
- [ ] 상태 배지와 empty/auth/error surface 정리

### Phase B — Auth UX

- [ ] device auth structured card
- [ ] open link / copy code
- [ ] already-running 상태를 friendly wording 으로 치환

### Phase C — Chat UX

- [ ] streaming bubble
- [ ] scroll anchoring
- [ ] assistant/user bubble refinement

### Phase D — Robustness

- [ ] bridge reconnect
- [ ] cancel / retry
- [ ] persisted conversation resume

---

## 11. 현재 구현에 대한 판단

현재 구현은 다음 이유로 **source of truth 가 될 수 없다**.

- raw login log 의존
- auth 링크/코드 구조화 없음
- 상태 머신 부재
- diagnostics 와 conversation 분리 미흡
- disabled 이유 표기 부족
- 버튼 행동과 화면 상태가 느슨하게 연결됨

따라서 현재 코드는 **throwaway spike** 로 취급한다.

앞으로의 구현 원칙:

- 문서에 없는 임시 버튼/행동 추가 금지
- 상태 문자열 하나로 UX를 때우는 방식 금지
- raw CLI output 를 기본 surface 로 노출하는 방식 금지

---

## 12. 승인 질문

이 문서 기준으로 다음 확인이 필요하다.

1. device auth 링크 클릭 시 새 브라우저 카드로 여는 방향이 맞는가
2. raw diagnostics 는 기본 접힘이 맞는가
3. composer 는 v1 에서 single-line 로 유지할지
4. `Pin to canvas` 를 v1 에 넣을지 v1.1 로 미룰지

이 네 가지가 정리되면 그 다음 구현은 문서 기준으로 진행한다.
