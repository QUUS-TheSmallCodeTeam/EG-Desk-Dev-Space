# Firefox Shell Path 1.5 Stabilization

**Date**: 2026-05-18
**현황 갱신**: 2026-09-27 (KST; 검증 시작 2026-09-26)
**Status**: 선정한 Firefox Shell 로컬 기반 구현·검증 완료; 제품 전체·Gecko 배포는 범위 밖
**Scope**: `apps/firefox-ui-demo/`

---

## Goal

Path 1 proved that Firefox chrome JS can host the EG-Desk surface. Path 1.5 turns that proof into a repeatable local POC before packaging starts.

This phase is not for expanding the product surface. It is for making the current surface reliable enough that Path 2 is mostly packaging, branding, updater, and distribution work.

---

## Source Anchors

| Area | Source |
|------|--------|
| Firefox chrome runtime | `overlay/JS/eg-desk-surface.uc.js` |
| Surface styles | `overlay/CSS/eg-desk-surface.uc.css` |
| Codex bridge | `helper/codex-bridge-server.mjs` |
| Terminal iframe | `overlay/resources/terminal.html` |
| Rust helper candidate (not the active terminal route) | `helper-rust/` |
| Repeatable scripts | `scripts/` |
| Chat/canvas/agent UX model | `docs/CHAT_CANVAS_AGENT_LAYER_MODEL.md` |

---

## 구현·검증 현황 — 2026-09-27

로컬 브랜치 `codex/local-product-foundation`의 체크포인트는 `217482b`이다.
최종 런타임 코드 기준은 `f88eeb5`이며 Markdown 표시 보정과 문자열
`Origin: null` 거부를 포함한다. Node 통합 검사 184/184와 최종 완료 응답
재표시 16/16을 포함해 선정한 로컬 기반의 구현·검증이 완료됐다.
원격 push는 없었다. 완료 범위는 Firefox Shell 프로토타입의 선정한 로컬
기반이며 제품 전체와 Gecko 독립 배포·패키징은 포함하지 않는다.

구현된 로컬 경로는 브라우저 우선 진입, 독립 Board 투영·저장, 일반 Codex
app-server의 Chat 스트림·유형별 활동·중지·수동 승인·`artifactRefs`이다.
일반 런타임의 작업 디렉터리 컨텍스트 전달과, 잘못된 경로에 대한 네이티브
RPC 이전 `400 INVALID_CWD` 응답도 코드에 반영됐다.
Terminal 카드는 `127.0.0.1:39218`의 Node HTTP helper를 사용하며
`node-pty`를 우선하고 불가하면 `child_process` pipe로 대체한다. Codex
app-server는 별도 loopback `127.0.0.1:39219`에서 동작한다.
Terminal 초기화는 CSP가 허용하는 외부 chrome 리소스
`overlay/resources/egdesk-terminal-init.js`로 옮겼다. Helper는 전달된
Fetch Metadata 값의 허용 목록 검사를 보강했다. 후속 `6f6162c`는 문자열
`Origin: null`을 모든 경우에 거부하며, 헤더가 없는 정상 요청은 계속 허용한다.
Markdown 표시 보정 `f88eeb5`도 반영됐다. CSP·CORS·principal 보안 경계의
완화는 없다.

검증은 2026-09-26~27(KST)에 진행됐다. Terminal 결과 JSON은 11개 검사
통과와 동일 세션의 네이티브 종료를 확인하며, 실행 메타데이터의 소스 지문
11개는 `16e4c0b`의 파일과 모두 일치한다. 최종 재표시 결과 JSON은 16개
검사 통과를 확인하고 실행 메타데이터의 소스 지문 13개는 `f88eeb5`와 모두
일치한다. 기존 artifact 파일의 실제 해시도 이전 실행·최종 재표시 기록과
같다. 핵심 UI·복구 실행 기록과 최종 화면 검토가 완료됐으며, 검증 유형과
적용 범위는 다음과 같다.

| 검증 구분 | 기준과 확인 결과 | 범위·제한 |
|---|---|---|
| 정적 검토 | 알려진 P1/P2 항목 종료. 최종 Markdown 원본 `77007a7`와 Origin 보강 원본 `d15b274`의 검토도 P1/P2 지적 없이 통과했으며 통합 기준은 `f88eeb5`다. QA 스크립트·pre-commit 범위의 검토도 통과했다. | 정적 검토 결과다. 아래 자동 검사·실제 UI 결과와 구분한다. |
| 통합 로직·인프라 검사 | 통합 HEAD `f88eeb5`와 QA 스크립트 기준 184/184 통과: UI 73, production helper 79, Firefox profile guard 9, QA 인프라 23. | QA 인프라 23건은 테스트 도구 검사다. 아래 실제 UI 수용 결과와 별도로 집계한다. |
| 실제 Firefox 첫 사용 | 8/8 통과. 첫 화면에서 sidebar/dock이 숨겨지고 Desk 진입 뒤 표시되며, 논리 Browser 크기 `1440×817`과 동일 Browser 인스턴스가 유지됐다. | 전용 QA profile의 첫 사용·Desk 전환 검증이다. |
| 실제 Firefox Board | 이전 `UI301`에서 열기·재열기·resource ID 충돌 저장·닫기 4개 흐름 통과. | 이후 수정 전체의 재검증 결과로 간주하지 않는다. |
| 실제 Firefox Chat fixture | 새 전체 실행 43/43 통과. 스트림 원문·표시 줄, 사용자 말풍선 정렬, 네이티브 스크롤, 활동 표시, hydration/replay 중복 방지, 명시적 artifact 열기와 일반 텍스트의 artifact 미생성을 포함한다. | 격리된 stub 전송으로 실제 UI를 검사했다. 실제 계정 로그아웃·새 OAuth는 실행하지 않았다. |
| 실제 Chat UI artifact | 기존 ChatGPT 인증으로 16/16 통과. UI 클릭 전 manifest의 작업 디렉터리가 반영됐고, 실제 네이티브 run 1개가 완료되어 고유 TXT 파일 1개가 생성됐다. 같은 응답의 구조화된 참조, 새로고침 후 사용자 메시지 중복 방지, chip 클릭 전 카드·카메라 변화 없음, 클릭 후 Canvas의 실제 파일 내용 표시를 확인했다. | 승인·재전송·인증 변경은 필요하지 않았다. 실제 provider 실행과 TXT 파일 검증 근거다. |
| 최종 완료 응답 재표시 | `f88eeb5`에서 제어된 이어검사 16/16 통과. 코드의 언더스코어가 원문 그대로 표시되고 로컬 파일 링크는 읽을 수 있는 이름으로 나타났다. 같은 응답의 artifact 활성화와 원문 보존을 확인했다. 신뢰된 HTTP/SSE는 200, 문자열 `Origin: null`은 403이었다. | MCP 응답 확인 timeout 당시 동작은 이미 반영돼 있었으며 이를 반복하지 않고 기존 완료 이력의 검사를 이어갔다. `POST /chat/send` 0회, 새 네이티브 run 0개였으며 기존 run 1개와 artifact 파일 해시가 유지됐다. |
| 손상된 Desk 복구 | 제어된 이어가기 5/5, 같은 profile 재시작 4/4 통과. | 손상 원본과 새 작업이 보존됐다. 검증 범위는 제어된 이어가기와 재시작이다. |
| 부분 Desk 복구 | 최초 복구 5/5, 같은 profile 재시작 4/4 통과. | 원본과 새 작업이 재시작 후에도 보존됐다. |
| 실제 Terminal / PTY | 통합 HEAD `16e4c0b`에서 11/11 통과. UI의 명시적 새 세션 요청으로 HTTP spawn 1회가 200을 반환했고 `Origin`·`Sec-Fetch-Site` 헤더는 없었다. `printf` nonce 출력 후 Board 닫기에서 동일 session ID의 종료 영수증(`status: EXITED`, `exitConfirmed: true`, `exitSource: pty.onExit`)을 확인했다. | 실제 네이티브 node-pty 종료 결과다. 네트워크 기록의 JSON `null`은 헤더 부재를 뜻하며 문자열 `Origin: null`이 아니다. |
| 실제 Codex backend | 이전 backend `2b`에서 기존 ChatGPT 인증(`ready`, `chatgpt`)으로 Sol/max 무도구 턴이 `EGDESK_BRIDGE_OK`를 반환하며 완료됐다. | 최근 Chat UI 전체와 새 OAuth, 실제 사용자 로그아웃을 검증한 것은 아니다. |

선정한 로컬 기반의 구현·검증은 완료됐다. 승인·계정 로그아웃 검사는 격리
fixture에 한정했고 실제 사용자 계정 로그아웃과 새 OAuth는 실행하지 않았다.
전체 제품 기능과 Gecko 배포·패키징은 별도 과제로 남는다. Owner의 15개
질문은 열려 있고 Jev 초안은 채택되지 않았다. API 키·네트워크 인프라·개인
프로필 데이터 변경은 없었다.

검증 전용 런타임 정리는 완료됐으며 2829·6001·39218·39219 포트에
리스너가 없음을 확인했다. 검증 프로필·증거·기존 artifact 파일은 보존됐다.

저장소 루트에서 실행하는 반복 검사 명령:

```sh
node --test apps/firefox-ui-demo/scripts/test-firefox-profile-guard.mjs
node --test apps/firefox-ui-demo/helper/*.test.mjs
node --test apps/firefox-ui-demo/scripts/egdesk-surface-state.test.mjs
node --test apps/firefox-ui-demo/scripts/egdesk-chat-fixture-transport.test.mjs apps/firefox-ui-demo/scripts/egdesk-chat-qa-contract.test.mjs apps/firefox-ui-demo/scripts/firefox-mcp-chat-harness.test.mjs
```

실제 Firefox 재현 진입점은
`scripts/verify-firefox-mcp-first-use-board.mjs`,
`scripts/verify-firefox-mcp-chat-baseline.mjs`,
`scripts/verify-firefox-mcp-chat-fixture-flow.mjs`,
`scripts/verify-firefox-mcp-chat-real-turn.mjs`이다. 실행 대상은 별도로
기동한 전용 QA profile이어야 한다. Board·복구 사례는 명시적
`EGDESK_QA_STATE_FIXTURES=1` 설정이, Chat fixture 전송은 별도 선택한
`EGDESK_QA_FIXTURE_TRANSPORT=1`과 fixture token이 필요하다. QA runtime
lease의 자동 fixture 생명주기 처리는 표시된 전용 profile과 stub server에만
한정된다. 실제 Chat UI 검사는 `EGDESK_QA_REAL_TURN=1`과 fixture 전송
비활성화가 필요하다. 기존 인증을 사용하며 실제 계정 로그아웃·새 OAuth는
검사 범위에 포함하지 않는다.

---

## P0 Order

### 1. Codex HUD Runtime Contract

Stabilize the Codex path before multi-provider work.

Acceptance criteria:
- `/v1/state`, `/auth/status`, `/auth/start`, `/auth/cancel`, `/auth/signout`, `/chat/send` return stable shapes.
- Duplicate login attempts do not create stuck UI states.
- `conversationId` is owned by the active thread and survives HUD-to-canvas moves.
- Send failure shows a product error state, not raw transport leakage.
- Diagnostics remain available but are not the primary UX.

### 2. Browser Entity / Popup / Gesture

Stabilize the real browser card because it is the core EG-Desk execution surface.

Acceptance criteria:
- Browser card create, close, move, resize, back, forward, reload, and URL entry work repeatedly.
- `window.open` / OAuth-like popup routes to a browser card.
- Active card scroll and desk pan/zoom do not switch owner mid-gesture.
- Failure to create a XUL `<browser>` is visible as a blocker, not silently treated as equivalent to the iframe fallback.

### 3. Terminal / Helper Path

The current local POC route is `terminal.html` through the Node bridge HTTP
endpoints on `127.0.0.1:39218`, using `node-pty` when available and a
`child_process` pipe fallback otherwise. The Rust/WebSocket `39300` route is
historical candidate material, not an equal active product route. The Codex
app-server on `127.0.0.1:39219` is a separate loopback dependency.

Acceptance criteria:
- Spawn, write, read/output, resize, and kill pass from the UI card.
- Helper/bridge unavailable state is shown inside the terminal card.
- Closing the card cleans up the PTY session.

### 4. Repeatable Smoke Scripts

Move from one-off probes to scripts that can be rerun before each packaging attempt.

Minimum scripts:
- bridge health/auth state smoke
- HUD send/resume smoke
- browser card spawn/popup smoke
- terminal spawn/write/kill smoke
- console error capture smoke

All repeatable scripts should live under `apps/firefox-ui-demo/scripts/`.

---

## Gate To Path 2

Path 2 starts only when:

- 80% or more of the Path 1.5 checklist in `ideas/confirmed/FIREFOX_SHELL_ROADMAP.md` is satisfied.
- Remaining gaps are explicitly classified as `packaging blocker` or `deferred`.
- The active implementation path is still `apps/firefox-ui-demo/`.
- No root-level probe scripts are required to validate the POC.

---

## Deferred For Later Discussion

These are intentionally out of Path 1.5:

- First real execution workflow demo
- Path 2 packaging start
- Multi-provider expansion beyond Codex
- Mini-app marketplace
- WASM acceleration
