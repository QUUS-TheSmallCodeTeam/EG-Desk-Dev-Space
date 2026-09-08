# EGDesk Chat UIUX Reference Notes (2026-04-19)

## 목적
- Codex 기반(향후 Gemini/Claude/OpenCode/OpenRouter 확장) 채팅 HUD의 시각/인터랙션 품질을 레퍼런스 기반으로 끌어올리기 위한 기준 메모.
- 순서: 선반 -> 서재 -> 웹 조사.

## 1) 선반 (repo references)

1. `references/agent-orchestration/paperclip/doc/plans/2026-03-11-agent-chat-ui-and-issue-backed-conversations.md`
- chat surface를 "두 번째 제품"으로 분리하지 않고 기존 워크플로우 object에 정합시키는 접근.
- UI 킷 선택보다 상태 소유권과 동선 정리가 우선이라는 점을 명시.

2. `references/agent-tools/cc-wf-studio/src/webview/src/components/chat/MessageList.tsx`
3. `references/agent-tools/cc-wf-studio/src/webview/src/components/chat/MessageInput.tsx`
4. `references/agent-tools/cc-wf-studio/src/webview/src/styles/main.css`
- 메시지 영역/컴포저/상태 바를 분리하고, 스크롤 영역과 입력 영역 경계를 명확히 두는 패턴 참고.

## 2) 서재 (internal docs)

1. `apps/firefox-ui-demo/docs/CODEX_HUD_DESIGN_V1.md`
- Structured chat 우선, diagnostics 기본 접힘, 링크/텍스트 선택 가능, disabled 사유 노출 원칙.

2. `apps/firefox-ui-demo/docs/MULTI_CLI_CHAT_UIUX_IMPLEMENTATION_PLAN_V1.md`
- HUD vs Canvas 이중 구조, provider-agnostic status chip, auth/bridge 분리 상태 표기 원칙.

3. `docs/references/codex-auth-chat-architecture-draft.md`
- renderer는 인증 비밀을 소유하지 않고 UI 상태만 표현해야 한다는 경계.

4. 당시 영문 백서 — 2026-09-06 삭제, 원문은 Git blob `e1ab95b9e62609d4b12d41b079a4bb32e6a4858c`로 보존
- 고정형 채팅 UI의 과밀 문제 지적, 대화 패널은 맥락 도구로 최소 노이즈화해야 한다는 제품 방향.
- 위 내용은 2026-04-19 당시 참고 맥락이다. 현재 대화의 제품 기준은 [Atlas CHAT-01](../../../ideas/confirmed/EGDESK_PRODUCT_INTERACTION_TRACE_ATLAS.md#atlas-chat-01)을 따른다.

## 3) 웹 조사

1. OpenCode Web docs
- https://opencode.ai/docs/web/
- 참고 이미지:
  - https://mintlify.s3.us-west-1.amazonaws.com/opencode/images/new-session.png
  - https://mintlify.s3.us-west-1.amazonaws.com/opencode/images/opencode-dev.png
- 관찰: 좌측 세션 리스트 + 우측 대화 본문 분리, 본문 하단 composer 고정, 상단 상태/액션 밀도 절제.

2. assistant-ui docs
- https://www.assistant-ui.com/docs/components/conversation
- https://www.assistant-ui.com/docs/runtimes/ai-sdk/use-chat
- 관찰: 메시지 스트림/오토스크롤/컴포저 동선이 일관되고, 상태/오류는 보조 레이어로 분리.

3. Vercel AI Elements
- https://elements.ai-sdk.dev/components/conversation
- 관찰: 대화 본문/입력/보조 액션의 시각적 우선순위가 명확함.

4. KakaoTalk service reference (DM + group/folder UX 단서)
- https://www.kakaocorp.com/page/service/service/KakaoTalk
- 참고 이미지:
  - https://t1.kakaocdn.net/kakaocorp/service/KakaoTalk/screen-img-pc-1x-v3-0.webp
- 관찰: 대화방 분류(폴더/카테고리), 개인 DM/그룹을 빠르게 전환하는 UX가 핵심.

## 4) 추출된 적용 규칙

1. 채팅방 목록과 대화 본문은 구조적으로 분리(2-pane)하고, 스크롤 책임도 분리한다.
2. 상단은 "현재 컨텍스트 + 상태 chip" 위주로 얇게 유지하고, 조작 버튼은 과밀 배치하지 않는다.
3. 컴포저는 하단에 고정된 1차 행동 영역으로 유지한다.
4. 진단 로그는 기본 접힘으로 두고, 오류/인증 시에만 전면화한다.
5. DM/Group 분류는 탭/필터로 즉시 전환 가능해야 한다.
