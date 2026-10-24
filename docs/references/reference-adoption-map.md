# EG-Desk 레퍼런스 채택 지도

기준일 2026-10-24 · 근거: 영역별 레퍼런스 조사 11건(조사 작업자 11명의 자기 보고) · 이 문서의 채택안은 모두 [제안]이다. 실행 검증은 0건이다.

이 문서는 EG-Desk의 남은 비전 gap마다 "어느 레퍼런스의 어느 코드를 보고, 우리 어느 파일을 어떻게 바꿀지"를 한곳에 모은 지도다. 대표님은 1장(한눈에 보기)과 5장(결정이 필요한 것)을 보면 되고, Main 개발자는 4장(구현 묶음)대로 작업자를 나눠 띄우면 된다. gap 번호와 상태의 정본은 `ideas/confirmed/EGDESK_VISION_GAP_LEDGER.md`(원장)이고, 안전 원칙의 정본은 `docs/references/computer-use-browser-control-rea.md`(REA)다.

---

## 0. 레퍼런스 사용 원칙

1. **찾는 순서**: 선반(`references/`) → 서재(`~/.claude/eg-library.tsv`) → GitHub 인기·최근 활동. 선반 사본이 낡았으면 원본 최신본을 따로 받아 읽는다. stars·license·마지막 push는 `gh api repos/OWNER/NAME`으로 확인한다(이 문서의 수치는 2026-10-24 조사 작업자 보고값).
2. **코드 근거**: README나 소개 글이 아니라 실제 코드 파일:줄을 근거로 삼는다. 레퍼런스 줄 번호는 2026-10-22~24 HEAD 기준이다. 우리 파일 줄 번호는 작업 트리 기준이라 계속 밀린다(`eg-desk-surface.uc.js`는 조사 중에도 17,483 → 18,002줄). 구현할 때는 함수 이름으로 다시 찾는다.
3. **라이선스 규칙**

   | 라이선스 | 해당 레퍼런스(예) | 쓰는 방법 |
   |---|---|---|
   | MIT · Apache-2.0 · BSD | agent-browser, nanobrowser, Playwright, opencove, excalidraw, t3code, jsdiff, VS Code | 코드를 옮길 수 있다. 옮기면 원 저작권 고지(Apache는 NOTICE 포함)와 출처 주석을 남긴다. 패턴만 쓰면 의무 없음 |
   | MPL-2.0 (파일 단위 copyleft) | Firefox 소스, Zen, Floorp, fx-autoconfig, Penpot, multi-account-containers, web-ext | 기본은 패턴만. 코드를 옮긴 파일은 MPL 고지를 유지하고 공개한다 |
   | GPL · AGPL · FSL · ELv2 · tldraw license · LobeHub Community License | driftwm, Zed action_log, BrowserOS, cua-spacesd, Collaborator, Tart, context-mode, tldraw, LobeHub, 선반 claude-mem 사본 | 패턴만. 코드 복사 금지 |
   | 독점 바이너리 | OpenAI SkyComputerUseClient(Codex Computer Use) | 개인 설치본 실행만. 재배포 금지 |

4. **REA는 안전 원칙의 근거로만 쓴다**(기능 근거로 쓰지 않는다). 이번 채택안이 지키는 원칙: EG-01 결과 미확정과 실패를 구분하고 자동 재시도하지 않음, EG-02 입력 직전 재확인, EG-03 표시와 효과 분리, EG-04 중지 층위 분리, EG-08·B-05 표시층은 입력을 가로채지 않고 표시 좌표를 입력 좌표로 다시 쓰지 않음, N-01·N-02 대상 프로세스 지정 입력과 포커스 복원. 그래서 browser-use처럼 "가려지면 JS 클릭으로 자동 전환"하는 방식은 따르지 않는다.
5. **표기**: [공식] 문서화된 기능, [런타임] 직접 실행해 확인, [제안] 미구현·미검증. 근거가 약하거나 코드만 읽고 내린 판단은 **확인 필요**로 표시한다(7장에 모음).

---

## 1. 한눈에 보기

### 1.1 영역별 요약

| 영역 | 결정 없이 바로 시작 | 대표님 결정 뒤 | 묶음 |
|---|---|---|---|
| Agent 브라우저 조작 | Agent가 보는 페이지 목록이 정확해짐(div 버튼·내부 스크롤·닫힌 웹 컴포넌트·무엇이 가렸는지), 행동 뒤 알맞게 기다림, 시간 초과 뒤 "실제로 눌렸는지" 확인, 확인 창 감지 | 스크린샷, 진짜(trusted) 클릭, 허용 밖 사이트로 새지 않게 막기, 대화 단위 조작 허락, 여러 카드, 결제·로그인 iframe | 1-A, 1-X, S1 → 2-BH, S6 |
| Browser 카드·로그인·계정 | 로그인 팝업 창에서 Desk가 다시 뜨지 않게 막기, 팝업 차단 표시, 툴바 키보드·이름, 팝업 회귀 시험, 팝업에서 끝난 로그인이 원래 카드 대기를 풂 | 팝업 카드, 카드별 계정(Firefox 컨테이너), 사이트별 계정 기억, 실제 사이트 검증 범위 | 1-B, S1 → S6 |
| 컴퓨터 사용 | 입력권·도구 계약 부품, 컴퓨터 조작 기록 메타데이터, Desk 안 '컴퓨터 조작' 창 1단계, 물려받은 도구 분류 보강 | cua-driver 채택, A'(Codex Computer Use 동작 단위 호출), 앱 허락 카드, 앱 범위, 긴급 중지 키 | 1-H, 1-R, S2 → 2-CH, 2-R, S9 |
| Codex + Claude 구독 | Claude 로그인 상태 감지, 코드 입력 로그인, 계정 칩·로그아웃 경고, 어느 한도인지 표시, Agent 모델이 실제로 쓰임, 버전 범위 안내, Claude 연결 준비 부품 | Claude 연결 방식(D1), 설정 상속 범위, EG-Desk 전용 로그인 저장소, API 키 프로필, 한도 뒤 자동 이어가기 | 1-E, 1-C, 1-R, S2 → 2-E, S9 |
| Agent 캐릭터 | 얼굴에 작업 상태, Browser 배지에 Agent 이름, 복제해서 새로 만들기, 예시 대화·하지 말 것 | Agent 파일 가져오기·내보내기, 도구 범위 프리셋, 사진 아바타, 설명으로 초안 만들기, 예시 Agent 교체 | 1-P, S1, S2 → 2-P, 2-R, S9 |
| Board 대화방의 여러 Agent | 하위 Agent의 실제 이름·역할·막힘(승인 기다림/답 기다림/오류)·최근 활동 | 막힌 하위 Agent에 손쓰기, 누가 답할지(@·Lead), 개인 대화에서 메시지 보내기, 동시 실행 상한 | 1-R, S1 → 2-R, 2-RT, 2-M, S8 |
| Chat → Canvas 결과·브리핑 | Agent가 긴 보고서를 'Canvas 결과'로 내보냄, 브리핑 근거 여러 개 강조, 단계 의견이 남음, 브리핑 중 화면 정리, 결과 줄 정리, AI 표식·메모 상태 모듈 | AI 표식이 처음 보이는 방식, 상단 검색 'AI에게 요청' 수신자, 메모 답글 자동 여부 | 1-O, 1-N, S3 → 2-BH, S7 |
| Canvas · Board · 미니맵 | 미니맵 검색·화면 밖 대상 표시·그리기 비용, Esc가 위에서부터 닫음, 창 접기, 모든 창 집중 보기, 채팅 옆에 붙여 열기, Board 제목줄 끌기 | Board 소속 규칙, 새 Board 저장 동작, 격자·안내선 맞춤 범위, 채팅 엿보기 방식 | 1-L, S4 → S7 |
| 디자인 · 접근성 | 툴바·라디오·탭·Dock 키보드 이동, 키보드 툴팁, 아바타 대비, 고대비·대비 증가 대응, 포커스·비활성 통일, 상태 문구 한국어, 화면 모드 검증 스위치 | 기본 글자 크기, 화면 모드 직접 선택, 토큰 생성 방식 | 1-F, 1-Q, S1, S5 → S10 |
| 코딩 화면 | 승인 전 바뀌는 줄 보기, '변경' 탭, 이름·내용 검색, 트리의 git 표시·자동 갱신, 테스트 결과 카드 | 원본 저장 범위, 덩어리별 검토, 프로젝트 폴더, CodeMirror 채택, git checkpoint | 1-D, 1-G, 1-R → 2-X, S10 |
| 런타임·맥락·저장·묶음 | 작업 기록 SQLite, 선택지 대기, 깨끗한 첫 실행 점검, 로더 고정, (실행 중 작업 뒤) 스키마 이전·JSON Canvas·Board 검색·카드 단위 병합 | 자동 저장 묶기 간격, 추천 기본 방식·제외 목록, 첨부 포함 기본값, 패키징·업데이트·트레이 | 1-W, 1-Q → 2-RT, 2-CTX, 2-M, 2-PK, S10 |

### 1.2 조사에서 새로 드러난 사실 (대표님 화면 기준)

1. **로그인 팝업이 끝까지 못 간다.** '구글로 로그인'처럼 크기를 지정한 팝업은 우리 팝업 가로채기를 거치지 않고 Firefox 기본값(`browser.link.open_newwindow.restriction=2`)대로 새 창으로 열린다. fx-autoconfig의 `@include main`은 그 창에도 EG-Desk 화면을 주입하므로 Desk가 팝업 창 안에서 다시 그려질 수 있다. 크기 지정 없는 팝업은 카드로 열리지만 opener가 끊기고 `window.close()`도 효과가 없다. (코드로만 판단, **확인 필요**)
2. **Codex가 이미 보내는 신호를 우리가 버리고 있다.** 하위 Agent의 상태(`thread/status/changed`: 승인 기다림·답 기다림·오류)와 별명·역할(`agentNickname`/`agentRole`), 파일 변경 본문(diff), 명령 출력. helper 전체에서 `thread/status`를 grep하면 0건이다.
3. **Agent에 정해 둔 모델이 실행에 쓰이지 않는다.** Profile에는 저장되지만 런타임이 버린다(`codex-chat-runtime.mjs` resolveProfile). '선호 도구' 칸도 실행에 아무 효과가 없다.
4. **cua-driver(MIT, 30.8k★)가 직접 만들려던 macOS 조작 부품(XL)을 대신할 수 있다.** Mac 앱을 내 화면을 빼앗지 않고 뒤에서 조작하며, Hermes(25.6만★)가 기본 드라이버로 쓴다. 대신 권한은 'CuaDriver' 앱이 받고 macOS 비공개 API를 쓴다. → 2026-10-24 대표님은 자체 Rust 도우미를 선택했다(5.2 D-C1). cua-driver는 참고·이식 대상이다.
5. **Codex 컴퓨터 조작을 켜 두어도 첫 앱 허락 질문에서 대화가 끊길 수 있다.** 지금 EG-Desk는 MCP elicitation 요청을 받으면 대화를 `UNSUPPORTED_INTERACTION`으로 끝낸다(`codex-chat-runtime.mjs:1963-1966`). (추정, **확인 필요**)
6. **Claude는 설치된 claude를 고치지 않고 공식 SDK와 같은 통로로 연결할 수 있다.** 공식 Agent SDK도 CLI를 `--permission-prompt-tool stdio`로 띄워 같은 stdin/stdout 제어 메시지로 승인·질문·중지·도구 제공을 한다. 다만 이 통로는 CLI 공개 문서의 계약은 아니다.
7. **ChatGPT 사용량 표시가 모델별 버킷에 덮일 수 있다.** 우리 병합은 `limitId`를 보지 않는다(`codex-account-usage.mjs:56-104`).
8. **아바타 글자 대비가 밝은 화면에서도 미달이다.** tone-2 3.42:1(밝게)·3.39:1(다크), tone-3 4.00:1·2.91:1. Windows 고대비·macOS '대비 증가' 대응은 0건이고, Firefox chrome 스타일시트는 고대비에서도 색이 강제되지 않는다 [공식].
9. **'새 Board로 저장' 뒤 목록에서 다시 열면 같은 창이 두 벌 생긴다.** 저장한 창 둘레에 Board 영역도 생기지 않는다. (코드로만 판단, **확인 필요**)
10. **작업 기록이 쌓일수록 저장이 무거워진다.** 작업 기록 JSON 4개가 이벤트 하나마다 전체를 다시 쓴다.
11. **원장 상태 정정이 필요하다**: CHAT-04는 원장에 '없음'이지만 커밋 8dc695d에서 이미 만들었다. CHAT-11은 UX-03(163a60e)에서 사실상 끝났다. CODE-03의 "200개 넘으면 페이지 없음"은 사실과 다르다('더 보기' 페이지가 이미 있다). 원장은 지금 다른 작업으로 수정 중이라 이 문서에서는 고치지 않았다. → 2026-10-24 원장에 반영했다.

### 1.3 지금 바로 띄울 작업자 (추천 순서)

- **바로 시작(실행 중 작업과 파일이 겹치지 않음)**: 1-X, 1-H, 1-C, 1-P, 1-W, 1-L, 1-N, 1-F, 1-Q, 1-D — 10개 중 6~10개를 고른다.
- **실행 중 작업자에게 확인 후 시작**: 1-A(overlay/resources의 Browser actor), 1-B(popup-test.html), 1-O(EGDeskBriefingState), 1-G(EGDeskFileView). 작업 지시상 overlay/*가 수정 중이지만, 이 문서를 쓴 시점(2026-10-24)의 `git status` 기준 실제로 수정 중인 overlay 파일은 `eg-desk-surface.uc.js`, `eg-desk-surface.uc.css`, `EGDeskChatState.sys.mjs`, `EGDeskPortableState.sys.mjs`, `EGDeskRecoveryState.sys.mjs`(+ `scripts/egdesk-surface-state.test.mjs`)다. 위 네 묶음의 파일은 여기에 없다.
- **실행 중 작업이 머지된 뒤 시작**: 1-R(codex-chat-runtime.mjs), 1-E(codex-bridge-server.mjs), S1(화면 파일).
- 대표님 목표 순서(브라우저 → 컴퓨터 → 구독 → Agent → 나머지)로 보면 1-A, 1-X, 1-B, 1-H, 1-R, 1-E, 1-C, 1-P, S1이 앞이다.

---

## 2. 영역별 채택 표

각 영역에서 위 표는 레퍼런스 목록, 아래 표는 gap별 채택안이다. `REFS` = `/private/tmp/claude-501/-Users-minsoocha-Projects-EG-Desk-Dev-Space/dac7ff27-92ee-4567-9d7f-546e39ec2742/scratchpad/refs` (조사 때 받은 임시 사본. 세션이 끝나면 사라질 수 있으니 6장대로 서재·선반에 옮긴다). 우리 파일은 `apps/firefox-ui-demo/` 기준이다.

### 2.1 Agent 브라우저 조작 (BRW-05 ~ BRW-13)

| 레퍼런스 | URL | 라이선스 | stars(최근 push) | 읽은 곳 |
|---|---|---|---|---|
| vercel-labs/agent-browser | https://github.com/vercel-labs/agent-browser | Apache-2.0 | 44,494 (2026-10-23) | REFS/vercel-labs_agent-browser |
| microsoft/playwright (MCP backend + injected) | https://github.com/microsoft/playwright | Apache-2.0 | 98,387 / MCP 38,562 | REFS/microsoft_playwright-latest, microsoft_playwright-mcp |
| ChromeDevTools/chrome-devtools-mcp | https://github.com/ChromeDevTools/chrome-devtools-mcp | Apache-2.0 | 54,050 (2026-10-23) | REFS/ChromeDevTools_chrome-devtools-mcp |
| browserbase/stagehand | https://github.com/browserbase/stagehand | MIT | 25,791 (2026-10-23) | REFS/browserbase__stagehand |
| nanobrowser/nanobrowser (2026 재작성판) | https://github.com/nanobrowser/nanobrowser | Apache-2.0 | 14,162 (2026-10-15) | REFS/nanobrowser_nanobrowser |
| mozilla/firefox-devtools-mcp | https://github.com/mozilla/firefox-devtools-mcp | MIT OR Apache-2.0 | 519 (2026-10-23) | REFS/mozilla_firefox-devtools-mcp |
| Firefox remote agent · EventUtils | https://github.com/mozilla-firefox/firefox/tree/main/remote | MPL-2.0 | 13,567 (미러, 2026-10-24) | REFS/mozilla_firefox-remote (파일만) |
| browser-use (최신) | https://github.com/browser-use/browser-use | MIT | 118,987 (2026-10-24) | REFS/browser-use_browser-use-latest (선반 d9a3065는 1,525커밋 뒤처짐) |
| theredsix/agent-browser-protocol (선반) | https://github.com/theredsix/agent-browser-protocol | BSD-3-Clause | 490 (2026-06-06 이후 정체) | references/browser/browser-automation/agent-browser-protocol |
| browseros-ai/BrowserOS (선반) | https://github.com/browseros-ai/BrowserOS | AGPL-3.0, 패턴만 | 14,080 | references/agent-research/browseros (1,862커밋 뒤처짐) |
| openai/codex (스키마 확인) | https://github.com/openai/codex | Apache-2.0 | 130,7xx | REFS/codex (git show로 스키마만) |

| gap · 대표님이 보게 될 변화 | 가져올 패턴 (근거 파일:줄) | 우리 파일 (현재) | 크기 · 결정 |
|---|---|---|---|
| **BRW-06·08** Agent가 보는 페이지 목록이 정확해진다: div 버튼, 내부 스크롤 영역, 닫힌 웹 컴포넌트도 잡고, 가린 버튼은 무엇에 가렸는지 말한다 | cursor:pointer·onclick 후보와 가린 요소 설명(agent-browser `cli/src/native/snapshot.rs:772-860`, `:60-100`, `element.rs:612-685`, `:992-1035`), 스크롤 컨테이너를 상호작용 요소로(browser-use `tools/service.py:1383-1420`, `dom/serializer/serializer.py:715-747`), 닫힌 shadow·slot hit 경로(Playwright `packages/injected/src/injectedScript.ts:1038-1110`), WeakRef ref 보관(firefox-devtools-mcp `src/firefox/snapshot/injected/uidRegistry.ts:1-60`) | `overlay/resources/EGDeskBrowserAgentRuntimeChild.sys.mjs:32-33`(선택자 후보만), `:603`(열린 shadowRoot만), `:40`(강한 Map), `:903-947`('obscured'만), `:1002-1006`(문서 스크롤만), `helper/egdesk-browser-tool-runtime.mjs:173-181` | M · 없음 |
| **BRW-06** 행동 뒤 고정 0.25초 대신 페이지가 다 반응할 때까지 기다리고, 아직 없는 문구가 나타나기를 기다릴 수 있다 | 행동 중 시작된 요청 추적 settle(Playwright `packages/playwright-core/src/tools/backend/utils.ts:20-57`), 이동 시작 100ms 감지·DOM 조용함 대기(chrome-devtools-mcp `src/utils/WaitForHelper.ts:40-41`, `:53-110`, `:263-299`), 100ms 폴링·1.5초 상한·쿼리 '?…' 처리(nanobrowser `src/browser-control/core/interaction/evidence.ts:14-24`, `:52-60`), text/textGone(playwright-mcp `README.md:1142-1150`) | Child `:1232-1233`(고정 250ms), wait `:785-824`, runtime `:388-426` | M · 없음 |
| **BRW-12** 시간 초과돼도 실제로 눌렸는지 확인해 알려 주고, 확인 전에는 다시 누르지 않는다. 확인 창이 뜨면 바로 알린다 | 탭별 action epoch·큐 상한·dialog 이벤트(ABP `chrome/browser/abp/abp_controller.h:934-1000`, `abp_action_context.h:20-55`, `abp_event_collector.cc:94-170`), 입력 1회·결과 unknown(nanobrowser `core/interaction/pointer.ts:1-60`, `core/lock.ts:1-26`), 행동 중 대화상자 감지(chrome-devtools-mcp `WaitForHelper.ts:124-165`), 남은 예산 전달(REA `:105-137`, `:268`) | runtime `:270-271`(절대 시각 마감), Child `:1212`, `:1218`, 대화상자 처리 grep 0건. 중복 방지는 이미 있음(runtime `:447`, `:473`, `:485-493`, `:561-583`, uc.js `:13620-13637`) | M · 없음 |
| **BRW-09** Agent가 카드 화면을 사진으로 보고 그림·차트도 판단한다(비밀 칸·읽지 못한 창은 가린 채) | `drawSnapshot` 후 축소·`close()`(Firefox `remote/shared/Capture.sys.mjs:89-219`), 가림 박스·사라지면 거부·라벨은 이미지 위에만(nanobrowser `core/tools/observe.ts:223-330`, `core/perception/masking.ts:10-40`), "스크린샷으로 행동하지 말라"(Playwright `tools/backend/screenshot.ts:47-60`), Codex 결과의 `inputImage{imageUrl}`(codex `DynamicToolCallResponse.json`). 반례: agent-browser는 라벨을 페이지 DOM에 주입(`screenshot.rs:387-450`) | 캡처 도구 없음(runtime `:40-60`), 결과는 inputText 1개(provider `:159`), 응답 상한 3곳(bridge-server `:690`, transport `:111`, runtime `:276`) | M · D-B6 |
| **BRW-10·06** 일반 클릭이 안 먹는 사이트에서 사람이 누른 것과 같은 클릭을 딱 한 번, 엉뚱한 곳이면 페이지에 닿기 전에 취소 | `window.synthesizeMouseEvent`·TIP 키(Firefox `testing/mochitest/tests/SimpleTest/EventUtils.js:730-800`, `:2484-2502`, `remote/webdriver-bidi/modules/windowglobal/input.sys.mjs:211-285`), 착지 가드·stable 2 rAF(Playwright `injectedScript.ts:718-768`, `:1154-1220`, `:1503-1511`; nanobrowser `src/browser-control/probe/source.ts:388-410`, `:907-965`), 뷰포트 교집합 중심(firefox-devtools-mcp `src/firefox/dom.ts:194-215`). 반례: browser-use `watchdogs/default_action_watchdog.py:876-902` | Child `:1091-1107`(target.click만), `:1109-1121`(비보호 legacy 좌표 입력) | L · D-B4 |
| **BRW-07** Agent가 링크를 새 카드로 열어 나란히 비교하고, 다 쓰면 자기가 연 카드만 닫는다 | tabs 한 도구(Playwright `tools/backend/tabs.ts:21-63`), 사람이 연 탭이 Agent 탭을 빼앗지 않음(agent-browser `browser.rs:2170-2265`, `tab_binding.rs:1-40`), openedPages(chrome-devtools-mcp `WaitForHelper.ts:170-177`, `:302-312`), opener 이벤트(ABP `abp_event_collector.cc:180-186`), 원래 탭 보호(BrowserOS 시험, 패턴만) | provider `:47-49`(카드 정확히 1개), uc.js installPopupCapture(opener 기록 없음) | L · D-B2 |
| **BRW-05** 클릭·리디렉트로도 허용 밖 사이트로 새지 않고, 막히면 다음 결과에 보인다 | 4층 이동 정책(nanobrowser `core/navigation-guard.ts:1-118`, `core/url-policy.ts:33-80`, `:104-112`), 정확 일치·'*.'·차단 우선(stagehand `packages/extension/understudy/domainPolicy.ts:163-233`, agent-browser `network.rs:79-125`) | runtime `:97-107`, `:456-458`, Child `:309-318`, `:874-879`(navigate 도구만 검사) | M · D-B1 |
| **BRW-11** 한 번 허락하면 같은 대화에서 이어서 조작한다. 결제·권한 부여는 늘 대표님, 제출·삭제는 먼저 묻는다 | 결정적 분류기 pay/delete/submit/grant(nanobrowser `core/interaction/classify.ts:1-120`), 확인 게이트·재검증·늦은 답 무효(`gate.ts:1-60`, `:179-240`, `ports.ts:140-186`), allow/deny/confirm 정책(agent-browser `policy.rs:1-140`) | uc.js registerBrowserToolSelection `:13148-13175`, `:13186`, `:13503-13519`(Run 1회용), Child `:1012-1056`(implicit submission 기록만) | M · D-B3 |
| **BRW-08** 결제·로그인처럼 다른 사이트에서 끼워 넣은 창 안도 보고, 설정에 따라 누를 수 있다 | browsingContext 단위 노드 참조(Firefox `remote/shared/webdriver/NodeCache.sys.mjs`), 프레임 ref 접두어(Playwright `injectedScript.ts:330-337`), 세션별 offset 합산(agent-browser `element.rs:542-610`), 프레임 인코딩 id(stagehand `a11y/snapshot/capture.ts:28-45`) | uc.js `:36`(actor `allFrames:false`), Child `:613-623`(inaccessibleFrames 보고만) | L · D-B5 |

### 2.2 Browser 카드 · 팝업 로그인 · 계정 분리 (BRW-01 ~ BRW-04, BRW-14)

| 레퍼런스 | URL | 라이선스 | stars | 읽은 곳 |
|---|---|---|---|---|
| Firefox 소스(GitHub 미러) | https://github.com/mozilla-firefox/firefox | MPL-2.0 | 13,567 | REFS/brw_firefox-web (파일만) |
| zen-browser/desktop | https://github.com/zen-browser/desktop | MPL-2.0 | 45,203 | REFS/brw_zen-browser (서재 등록, 선반 미clone) |
| Floorp | https://github.com/Floorp-Projects/Floorp | MPL-2.0 | 8,457 | REFS/brw_floorp (서재 등록, 선반 없음) |
| mozilla/multi-account-containers | https://github.com/mozilla/multi-account-containers | MPL-2.0 | 3,162 | REFS/brw_multi-account-containers |
| ferdium/ferdium-app | https://github.com/ferdium/ferdium-app | Apache-2.0 | 4,745 | REFS/brw_ferdium |
| deta/surf (선반) | https://github.com/deta/surf | Apache-2.0 | 3,609 | references/browser/surf (2026-02-22, 원본 2026-08-24) |
| MrOtherGuy/fx-autoconfig | https://github.com/MrOtherGuy/fx-autoconfig | MPL-2.0 | 495 (2026-07-23) | REFS/brw_fx-autoconfig |
| Playwright MCP backend | https://github.com/microsoft/playwright-mcp | Apache-2.0 | 38,562 | REFS/brw_playwright-web |
| vercel-labs/agent-browser | https://github.com/vercel-labs/agent-browser | Apache-2.0 | 44,494 | REFS/vercel-labs_agent-browser |
| OSU-NLP-Group/Online-Mind2Web | https://github.com/OSU-NLP-Group/Online-Mind2Web | MIT | 208 | REFS/brw_online-mind2web |

| gap · 변화 | 가져올 패턴 (근거) | 우리 파일 | 크기 · 결정 |
|---|---|---|---|
| **BRW-03** 로그인 팝업 창에서 EG-Desk 화면이 다시 뜨지 않게 막기(안전망) | 크기 지정 팝업은 새 창(`nsWindowWatcher.cpp` GetWindowOpenLocation, `dom_ipc_ContentParent.cpp:5432-5506`, `firefox.js:1086-1096`), 팝업 창은 `window.toolbar.visible`로 구분(`BrowserDOMWindow.sys.mjs:108-111`), `@include main`은 모든 browser.xhtml 창에 주입(fx-autoconfig `profile/chrome/utils/boot.sys.mjs:116`, `:520-530`) | uc.js L5 `@include main`, boot()에 팝업 창 판별 없음, `overlay/resources/popup-test.html`(크기 지정 없는 팝업만 시험) | S · 없음 |
| **BRW-03** 팝업을 원래 카드와 이어진 '팝업 카드'로 열고 로그인이 끝나면 저절로 닫기 | openWindowInfo·openerBrowser·opener 컨테이너로 browser 생성, skipLoad, BrowsingContext 반환(`BrowserDOMWindow.sys.mjs:375-400`, `:454-535`, `Tabbrowser.sys.mjs:3158-3270`, `GeckoViewUtils.sys.mjs:504-531`, `nsIBrowserDOMWindow.idl`), DOMWindowClose로 닫기(`BrowserElementParent.sys.mjs:10-30`, `Tabbrowser.sys.mjs:9891-9931`), 부모 컨테이너 상속·부모와 함께 닫힘(Zen `src/zen/glance/ZenGlanceManager.mjs:96-112`, `:364-375`, `:1603-1607`; Ferdium `src/index.ts:352-392`; Surf `app/src/main/mainWindow.ts:469-495`) | uc.js installPopupCapture(L16198~): aOpenWindowInfo를 버리고 spawnBrowserCard(url), contentWindow 반환(IDL 불일치), DOMWindowClose 처리 없음 | L · D-B7 |
| **BRW-03** 팝업 로그인 흐름 자동 회귀 시험 | 우리 headless 하네스(`scripts/verify-firefox-mcp-browser-agent-observation.mjs:17-70`, `:218-240`), 새 페이지 목록 추적(Playwright `context.ts:364-381`) | 자동 시험 0개 | M · 없음 |
| **BRW-03** 팝업이 차단되면 카드에 '팝업 차단됨 · 허용' | `DOMUpdateBlockedPopups`·`unblockAllPopups`(`PopupAndRedirectBlockingParent.sys.mjs:106`, `:164-216`, `:274-310`, `ActorManagerParent.sys.mjs:516-533`) | 표시 없음(카드에서 Firefox 알림줄이 숨겨짐, 추론) | S · 없음 (**확인 필요**: popupAndRedirectBlocker 속성의 존재·동작) |
| **BRW-04** 팝업 카드에서 로그인을 마쳐도 원래 카드에 걸린 대기 조건이 풀린다 | openerBrowser 전달(`nsIBrowserDOMWindow.idl` nsIOpenURIInFrameParams), 부모 탭 등록(Zen `ZenGlanceManager.mjs:351`, `:402`) | `helper/egdesk-await-router.mjs:54-56`(cardId 정확 비교), `helper/egdesk-event-bus.mjs:88-95`, `:242`, `EGDeskSurfaceState.sys.mjs:665` | S · 없음 |
| **BRW-04** 로그인 팝업이 스스로 닫히면 '로그인 끝남'으로 보고 멈춘 작업 이어 가기 | 스크립트 window.close만 DOMWindowClose(`BrowserElementChild.sys.mjs:5-13`), 이름·크기 지정 팝업=인증(Surf `mainWindow.ts:471-476`), URL glob 대기(agent-browser `skill-data/core/references/authentication.md:279-322`) | 완료 신호는 콜백 URL 도착뿐(SurfaceState oauthGateMatches L654) | M · D-B11 |
| **BRW-02** 같은 사이트를 다른 계정으로 열 때 엉뚱한 카드로 가지 않는다 | 컨테이너별 열린 탭 맵(`UrlbarProviderOpenTabs.sys.mjs:26-28`, `:186-210`) | uc.js sourceRefKey L2106, findOpenCardBySourceRef L2174(단일 키) | M · D-B9 |
| **BRW-02** 카드마다 계정(Firefox 컨테이너)을 고르고 머리에 계정 이름·색 — 이미 만든 EGDeskBrowserIdentity 연결 | usercontextid로 browser 생성·전환은 browser 교체(Zen `space-routing/ZenSpaceRoutingManager.sys.mjs:350-372`, Floorp `website-panel-window-child.ts:33-56`), `privacy.userContext.enabled=true`(`firefox.js:2847`) | `overlay/resources/EGDeskBrowserIdentity.sys.mjs`(configureBrowser L46, switchCardContext L263 — 구현됐지만 import 0건), duplicateBrowser L15348 | L · D-B8 |
| **BRW-02** '이 사이트는 항상 이 계정으로' 기억 | hostname 키·확인 페이지·다시 묻지 않기(multi-account-containers `src/js/background/assignManager.js:12-21`, `:233-360`, `:806-833`) | 없음 | M · D-B10 |
| **BRW-01** 툴바: 모든 버튼 이름, Tab 한 번에 들어가 화살표로 이동, 단축키 | 묶음별 탭 정지점·화살표·비활성 건너뛰기(`browser-toolbarKeyNav.js:5-25`, `:54-100`, `:284-322`) — 2.9의 APG·Base UI 근거와 합침 | uc.js L10207(role 없음), L14026-14070(aria-label 없음) | M · 없음 |
| **BRW-01** 카드 안 동영상 전체화면·포인터 잠금·사이트 아이콘·DRM이 일반 Firefox처럼 | `messagemanagergroup="browsers"`(`Tabbrowser.sys.mjs:3175-3185`, `DesktopActorRegistry.sys.mjs` DOMFullscreen L582·EncryptedMedia L597·LinkHandler L729·PointerLock L832, Zen `:103-108`, Floorp `web-site-browser.tsx:20`) | uc.js L14112-14118(속성 없음) | S · 없음 (**확인 필요**: BrowserTab 등 액터 오류) |
| **BRW-14** 실제 웹사이트 Agent 조작 검증을 공개 벤치마크 과제·형식으로 기록 | 실사이트 300과제·궤적 v2 형식(Online-Mind2Web `README.md:34`, `:41-48`, `:100-111`), 탭 변화 목록(Playwright `response.ts:288-299`) | 소유 로컬 fixture(Windows)만 성공 기록 | M · D-B12 |

### 2.3 컴퓨터 사용 (CU-01 ~ CU-06, CU-09)

| 레퍼런스 | URL | 라이선스 | stars(최근 push) | 읽은 곳 |
|---|---|---|---|---|
| trycua/cua (cua-driver, lume, cua-spacesd) | https://github.com/trycua/cua | MIT (cua-spacesd는 FSL 패턴만, cua-perception 확장은 AGPL — 설치 금지) | 30,816 (2026-10-24) | REFS/cua |
| openclaw/Peekaboo | https://github.com/openclaw/Peekaboo | MIT | 5,379 (2026-10-23) | REFS/Peekaboo |
| CursorTouch/Windows-MCP | https://github.com/CursorTouch/Windows-MCP | MIT | 10,154 (2026-10-24) | REFS/Windows-MCP |
| tmustier/codex-computer-use-mcp | https://github.com/tmustier/codex-computer-use-mcp | MIT (비공식, OpenAI 서명 바이너리 의존) | 35 (2026-10-21) | REFS/codex-computer-use-mcp |
| bytedance/UI-TARS-desktop | https://github.com/bytedance/UI-TARS-desktop | Apache-2.0 | 39,372 (2026-10-09) | REFS/UI-TARS-desktop |
| NousResearch/hermes-agent (현재 원격) | https://github.com/NousResearch/hermes-agent | MIT | 256,554 (2026-10-24) | REFS/hermes-cu (선반 2026-04-03 사본에는 computer_use 없음) |
| openai/openai-cua-sample-app | https://github.com/openai/openai-cua-sample-app | MIT | 1,907 | REFS/openai-cua-sample-app |
| anthropics/claude-quickstarts | https://github.com/anthropics/claude-quickstarts | MIT | 18,972 | REFS/claude-quickstarts |
| microsoft/UFO | https://github.com/microsoft/UFO | MIT | 10,067 | REFS/UFO |
| e2b-dev/desktop | https://github.com/e2b-dev/desktop | Apache-2.0 | 1,539 | REFS/desktop |
| Claude Code computer use 공식 문서 | https://code.claude.com/docs/en/computer-use | 공식 문서 | - | web |

| gap · 변화 | 가져올 패턴 (근거) | 우리 파일 | 크기 · 결정 |
|---|---|---|---|
| **CU-06·01** Codex가 앱을 써도 되는지 물으면 대화가 끊기지 않고 '컴퓨터 조작 허락' 카드가 뜬다 | elicitation을 화면으로 넘겨 accept/decline/cancel, 모르는 모드는 cancel(codex-computer-use-mcp `src/direct-broker.ts:710-725`, `src/mcp-elicitation.ts:18-54`) | `helper/codex-chat-runtime.mjs:1963-1966`(-32601로 거절하고 Run 종료) | M · D-C3 |
| **CU-01** 다른 앱을 조작하는 동안 Desk 안 '컴퓨터 조작' 창에서 누가·어느 앱을·무엇을 했는지 보고 [중지] | 늘 보이는 표시 + Stop(cua `libs/cua-driver/docs/driver-permission-modes-and-consent-plan.md:506-532`, `rust/crates/platform-macos/src/pip/mod.rs:1-40`), 클릭 통과·캡처 제외 표시(UI-TARS `apps/ui-tars/src/main/window/ScreenMarker.ts:40-67`, `:150-170`, `:240-241`; Windows-MCP `control_overlay.py:31`, `:71`), 트레이 클릭=중지(UI-TARS `tray.ts:33-50`), 메타데이터만 기록(codex-computer-use-mcp `src/audit.ts:6-23`) | runtime `:2216-2227`(배지), `:2341-2380`(run.computerUse, SSE computer.used), uc.js `:12362-12411`(설정 줄) | L(1단계 M) · 없음 |
| **CU-02** 사람이 마우스·키보드를 쓰는 중이면 Agent 입력이 시작되지 않고, 사람이 움직이면 다음 동작 전에 멈춘다 | 사람/Agent/대기/불가 상태기계·동작마다 checkpoint·15초 유지·분류표(Windows-MCP `src/windows_mcp/desktop/control.py:230-344`, `:540-560`, `control_hooks.py:26`, `:64`, `tools/control_policy.py:7-52`), epoch 분리(cua-spacesd `docs/architecture.md:63-125`, FSL 패턴만) | Desk 밖 입력권 없음(Browser lease만 uc.js `:13077`) | L · D-C7 (순수 로직은 결정 없이) |
| **CU-03·09** Mac 앱을 Codex든 Claude든 같은 EG-Desk 도구로, 내 화면을 빼앗지 않고 조작(cua-driver 위에) | 권한 모드·결과 계약 effect/route/evidence(cua `libs/cua-driver/README.md`, `docs/action-result-contract.md:13-60`, `docs/sdk-first-runtime-north-star.md:151-170`), 텔레메트리 기본 켜짐(`rust/crates/cua-driver/src/telemetry.rs:1-12`, `:44`), 제품 통합·준비 상태 카드(hermes-cu `tools_computer_use_permissions.py:1-119`, `tools_computer_use_backend.py:60-140`), Claude용 화면 축소(claude-quickstarts `computer-use-best-practices/computer_use/image.py:1-75`) | 데스크톱 조작 수단 없음(`helper/macos-gesture-helper`는 트랙패드 수신 전용) | L · D-C1 (인터페이스·가짜 provider는 결정 없이) |
| **CU-06·03** (선택지 A') 설치된 Codex Computer Use를 동작 하나씩 직접 불러 동작마다 입력권·허용 앱·중지를 확인 | 격리 무모델 app-server + `mcpServer/tool/call` 10개 동작·서명 TeamID 확인·turn-ended 정리(codex-computer-use-mcp `direct-broker.ts:140-148`, `:306-331`, `:599-637`, `:688-692`, `:736-738`, `:754-799`; `src/tools.ts:13-24`) | `helper/codex-computer-control.mjs:16-19`(cua_repl 물려받음) | M · D-C2, D-C4 |
| **CU-04** 기본은 '뒤에서만', 앱을 앞으로 가져오거나 화면 전체를 쓰려면 매번 허락 | 새 세션은 백그라운드 전용(Peekaboo `docs/security.md:38-46`), 세션 상한(cua-spacesd `:83-92`), 앱별 허락·앱 종류별 단계(Claude Code 문서), VM은 Lume(`libs/lume/README.md:1-25`) | 없음 | L · D-C5, D-C8 |
| **CU-05** 단축키 한 번으로 모든 Agent 입력이 멈추고, 감시 프로세스가 죽으면 Agent 입력도 막힌다 | 주입 입력 제외·물리 chord만·시스템이 먹음·감시 heartbeat(Windows-MCP `control_hooks.py:26`, `:64`, `:84-97`, `control_worker.py:37-86`, `control_ledger.py:15-82`), 중지 뒤 key-up·마우스 up 해제(openai-cua-sample-app `python-app/app/desktop/release_inputs.py:9-75`, `runtime.py:185-197`) | 전역 단축키·event tap 없음 | L · D-C6 |
| **CU-09** Windows에서도 같은 도구·창·중지 키 | cua-driver Windows, Windows-MCP `control.py:37-120`, UFO `documents/docs/ufo2/core_features/hybrid_actions.md:1-60` | Terminal·Browser만 | XL · macOS 뒤 |

> **메모 (2026-10-24)**: 대표님은 cua-driver 채택 대신 **EG-Desk 자체 Rust 도우미**를 선택했다(5.2 D-C1, RT-04 Rust helper와 합침). 위 표의 cua-driver는 참고·이식 대상이다(MIT, 출처 표기). 권한은 별도 도우미 .app이 받는다. 실제 화면 시험은 관찰 전용부터 하고 OS 입력은 보내지 않는다(D-C4). A'(D-C2)는 지금 쓰지 않는다.

### 2.4 Codex + Claude 구독 · 엔진 연결 (SUB-*, AGENT-08)

| 레퍼런스 | URL | 라이선스 | stars | 읽은 곳 |
|---|---|---|---|---|
| pingdotgg/t3code | https://github.com/pingdotgg/t3code | MIT | 29,676 | REFS/t3code (26c3625f, 2026-10-23) |
| agentclientprotocol/claude-agent-acp | https://github.com/agentclientprotocol/claude-agent-acp | Apache-2.0 | 2,685 | REFS/claude-agent-acp |
| anthropics/claude-agent-sdk-python | https://github.com/anthropics/claude-agent-sdk-python | MIT | 8,340 | REFS/claude-agent-sdk-python-files (gh api) |
| BloopAI/vibe-kanban | https://github.com/BloopAI/vibe-kanban | Apache-2.0 | 28,440 | REFS/vibe-kanban |
| agentclientprotocol/codex-acp | https://github.com/agentclientprotocol/codex-acp | Apache-2.0 (GitHub 표시 NOASSERTION) | 483 | scratchpad/codexacp-CodexAcpClient.ts |
| openai/codex (app-server-protocol) | https://github.com/openai/codex | Apache-2.0 | 130,701 | gh api 스키마 |
| agentclientprotocol/agent-client-protocol | https://github.com/agentclientprotocol/agent-client-protocol | Apache-2.0 | 4,492 | gh api RFD |
| steipete/CodexBar | https://github.com/steipete/CodexBar | MIT | 22,766 | REFS/CodexBar (CLI 경로만 참고) |
| anomalyco/opencode | https://github.com/anomalyco/opencode | MIT | 220,667 | gh api |
| ccusage/ccusage | https://github.com/ccusage/ccusage | MIT (NOASSERTION 표시) | 19,153 | gh api |
| slopus/happy | https://github.com/slopus/happy | MIT | 24,288 | REFS/happy |
| 선반 gemini-cli · agent-deck · oh-my-claudecode | (서재 등록) | Apache-2.0 / MIT / MIT | 107,564 / 1,152 / 40,214 | references/… (2026-03~04 사본, 갱신 필요) |

| gap · 변화 | 가져올 패턴 (근거) | 우리 파일 | 크기 · 결정 |
|---|---|---|---|
| **SUB-08·05** 설정과 Chat 머리에 'Claude · Max · 이메일' 또는 '로그인 안 됨'이 실제대로(EG-Desk는 토큰을 읽지 않음) | `claude auth status --json` 5초 제한·exit 1에도 stdout 파싱·API 키 우선(claude-agent-acp `src/auth-status.ts:90-99`, `:192-231`, `:233-280`; CodexBar `ClaudeCLIAuthStatusProbe.swift:48-86`), HOME 대신 CLAUDE_CONFIG_DIR만(t3code `apps/server/src/provider/Drivers/ClaudeHome.ts:30-47`), 공식 cli-reference | `helper/engine-registry.mjs:68-75`(고정 'decisionPending') | M · 없음 |
| **SUB-08·12** 로그인이 안 돼 있으면 Terminal 카드에서 공식 로그인(구독 또는 Console 종량) | 터미널 로그인(claude-agent-acp `src/acp-agent.ts:2864-2940`, ACP `docs/rfds/auth-methods.mdx`) | 없음 | S · D-S1 |
| **SUB-09·12** Claude도 Codex와 같은 실시간 답변·승인·질문·중지 카드로 일한다(설치된 claude를 고치지 않음) | `--permission-prompt-tool stdio` 제어 통로(claude-agent-sdk-python `types.py:2281-2303`, `_internal/query.py:340-363`, `:586-640`, `:720-745`, `:794`, `transport/subprocess_cli.py:574`, `:631-634`), npm SDK 없이 직접 실행(vibe-kanban `crates/executors/src/executors/claude.rs:157-193`, `:221-252`, `claude/protocol.rs:198-218`) | `helper/claude-stream-translate.mjs`(번역만) | L · D-S1 |
| **SUB-09** Claude 질문에 고르거나 쓰거나 건너뛰고, 건너뛰어도 멈추지 않는다. '이번 대화 동안 허용' | answers 형식·건너뛰기=allow+빈 answers·취소=deny+interrupt(claude-agent-acp `src/elicitation.ts:20-33`, `:260-330`; t3code `ClaudeAdapterV2.ts:2901-2945`, `:3710-3722`) | 설계 §5.3은 건너뛰기를 deny로 계획 | S · 없음(순수 함수) |
| **SUB-10** Claude 대화에서도 Browser·자료 도구를 같은 허락 절차로(포트·추가 프로세스 없음) | 'sdk' 타입 MCP + `mcp_message` 제어 요청(claude-agent-sdk-python `query.py:656-675`, `subprocess_cli.py:664-702`) | 설계 §9는 loopback HTTP MCP 계획 | M · 없음(모듈), 연결은 D-S1 뒤 |
| **SUB-04** 브라우저가 돌아오지 못해도 '코드 입력' 방식으로 ChatGPT 로그인 | `chatgptDeviceCode` 흐름(codex-acp `src/CodexAcpClient.ts:284-345`, `:1341-1385`, `src/CodexAuthMethod.ts:36-80`, codex `LoginAccountParams.ts`) | `helper/codex-bridge-server.mjs:594-615`, `:765-800`(type 'chatgpt'만) | S · 없음 |
| **SUB-01** Chat 상단 계정 칩에서 바로 로그아웃·다른 계정 로그인, 터미널 codex도 끊긴다는 경고 | account/read refreshToken(codex-acp `:284-299`), 계정별 인증 서비스(t3code `ProviderAuthService.ts:27-70`) | uc.js `:7183`, `:12594`(경고 없음) | S · 없음 |
| **SUB-11·02** 회사·개인 계정을 나란히 연결하고 대화마다 고른다(기록·설정 공유, 로그인만 분리) | 그림자 CODEX_HOME(auth.json만 실제 파일, 나머지 symlink)(t3code `CodexHomeLayout.ts:11-70`, `:321-400`, `CodexManagedHome.ts:6-20`), CLAUDE_CONFIG_DIR(`ClaudeHome.ts:67-75`, agent-deck `internal/profile/detect.go:11-45`) | 기본 폴더 공유, 프로필 1개(`codex-engine-adapter.mjs:7-9`) | L · D-S3 |
| **SUB-15** 구독이 없거나 한도가 끝나면 본인 API 키로 이어 쓰고 '종량 과금' 배지(키는 EG-Desk가 보관하지 않음) | 구독 실행 env에서 키 제거·apiKeySource 경고(vibe-kanban `claude.rs:644-647`, `:911-925`), Console 로그인은 CLI 보관(공식 cli-reference) | Anthropic 키 경로 없음, apiKeySource 미사용(`claude-stream-translate.mjs:171`) | M · D-S4 |
| **SUB-14·03** '5시간 한도 · 오후 3:10 초기화'처럼 어느 한도인지 보이고 '초기화되면 이어서/다른 계정' 선택 | rateLimitType 창 병합(t3code `claudeUsageLimits.ts:22-27`, `:165-230`), limitId가 'codex' 아니면 무시(`codexUsageLimits.ts:59-100`, `:69`), 자동 재개 상태(oh-my-claudecode `src/features/rate-limit-wait/types.ts:10-40`) | `codex-account-usage.mjs:56-104`(limitId 미검사), `claude-stream-translate.mjs:452`(rateLimitType 버림), runtime `:188-206`(egdesk/* 버림) | M · 자동 이어가기만 D-S5 |
| **AGENT-08** Agent마다 정한 엔진·모델·추론 강도로 대화가 돈다 | `{instanceId, model, options}`(t3code `packages/contracts/src/modelSelection.ts:17-50`, vibe-kanban `profile.rs:63-100`) | `egdesk-profile-store.mjs:106-113`, `:514-524`(저장됨), runtime `:818-821`, `:1045-1053`(미사용) | S · D-A4 확인 |
| **SUB-09** EG-Desk의 Claude는 대표님 hooks·개인 MCP를 몰래 실행하지 않는다 | `disableAllHooks`·`--strict-mcp-config`·`ENABLE_CLAUDEAI_MCP_SERVERS=false`(t3code `ClaudeProvider.ts:206-240`, `ClaudeHome.ts:49-65`, CodexBar `ClaudeCLISession.swift:405-412`, 공식 headless) | 설계 §11 D2 후보만 | S · D-S2 |
| **SUB-13** codex·claude가 자동 업데이트돼도 채팅은 계속되고 '검증된 버전/검증 안 된 버전' 표시 | semver 범위 정책·차단 아닌 안내(t3code `providerCompatibility.ts:1-80`) | `egdesk-native-capabilities.mjs:13-14`(정확한 버전 집합만, PATH codex 0.162.1은 false) | S · 없음 |
| **SUB-13** (외부 배포 시) OpenAI 'Sign in with ChatGPT' 경로 참고 구현 확보 | t3code `CodexChatGptAuth.ts:34-37`, `:523`, `CodexManagedRuntime.ts:26`, `:121` | app-server 내장 로그인 | L · D-S6 (지금은 기록만) |

### 2.5 Agent 캐릭터 · 정체성 · 권한 (AGENT-02/04/05/06, CHAT-07, CHAT-01)

| 레퍼런스 | URL | 라이선스 | stars | 읽은 곳 |
|---|---|---|---|---|
| openclaw/openclaw | https://github.com/openclaw/openclaw | MIT | 392,889 (2026-10-24) | REFS/openclaw |
| msitarzewski/agency-agents | https://github.com/msitarzewski/agency-agents | MIT | 163,532 | REFS/agency-agents |
| NousResearch/hermes-agent | https://github.com/NousResearch/hermes-agent | MIT | 256,554 | REFS/hermes-agent (선반은 2026-04-03) |
| paperclipai/paperclip | https://github.com/paperclipai/paperclip | MIT | 106,626 | REFS/paperclip (선반은 2026-04-03) |
| openai/codex (agent-roles) | https://github.com/openai/codex | Apache-2.0 | 130,703 | REFS/codex + 공식 subagents 문서 |
| letta-ai/letta-code | https://github.com/letta-ai/letta-code | Apache-2.0 | 3,697 | REFS/letta-code (구 letta-ai/letta는 은퇴) |
| kwaroran/character-card-spec-v3 | https://github.com/kwaroran/character-card-spec-v3 | MIT | 114 (2024-07 이후 멈춤) | REFS/character-card-spec-v3 |
| openai/openai-agents-python | https://github.com/openai/openai-agents-python | MIT | 30,248 | REFS/openai-agents-python |
| mergisi/awesome-openclaw-agents (선반) | https://github.com/mergisi/awesome-openclaw-agents | MIT | 4,022 | references/agent-tools/awesome-openclaw-agents |

| gap · 변화 | 가져올 패턴 (근거) | 우리 파일 | 크기 · 결정 |
|---|---|---|---|
| **AGENT-05** Agent 목록·대화방 목록·메시지 얼굴에서 지금 일하는지·답을 기다리는지·새 답이 왔는지 바로 보인다 | Agent별 상태 묶음 '답·승인 대기 > 작업 중 > 안 읽음'(hermes `apps/desktop/src/store/profile-dot-state.ts:1-63`), 명단 카드(openclaw `ui/src/lib/agents/roster-activity.ts:15-71`), 상태 얼굴(paperclip `packages/shared/src/agent-appearance.ts:11`, `:47-52`) | uc.js `:12614-12625`, `EGDeskChatState.sys.mjs:1252`(대화 안 버블만) | M · 없음 |
| **AGENT-05** Browser 카드 'Agent 조작 중' 배지가 '코드 리뷰어 조작 중'처럼 실제 Agent 얼굴·이름으로 (Board 조사 A9와 같은 일) | 이름 접두·이모지 재사용(openclaw `src/agents/identity.ts:18-43`), 이미지 실패 시 이니셜(paperclip `ui/src/components/AgentAvatar.tsx:23-35`), 이벤트마다 subagentRunId 귀속(ag-ui `generated_schemas.ts:27-32`) | `EGDeskSurfaceState.sys.mjs:738-749`(고정 문구), uc.js `:15240-15243` | S · 없음 |
| **CHAT-01** 앱을 껐다 켜거나 기록에서 방을 되살려도 그 방에서 고른 Agent가 남는다 | 대화 저장소 열로 Agent 저장(codex `state/migrations/0013_threads_agent_nickname.sql`, `Thread.ts:89-92`) | `helper/egdesk-chat-store.mjs:159-163`(열 없음), uc.js `:7738-7745`(늘 기본 방으로 복원) | M · 없음 (실행 중 작업과 충돌 → 2-RT) |
| **AGENT-02·04** Agent 하나를 파일로 내보내고, 남이 만든 Agent 파일(.md·Codex 에이전트 파일)을 초안으로 받는다 | Markdown+YAML 머리말(agency-agents `engineering/engineering-code-reviewer.md:1-7`, `scripts/lint-agents.sh:39`), 형식 변환(`scripts/convert.sh:216-236`, `:360-470`), Codex TOML 키(codex `codex-rs/agent-roles/src/agent_role_config.rs:20-27`), extensions 보존·source 덧붙이기(character-card-spec-v3 `SPEC_V3.md:75-110`, `:151-159`), 비밀값 비우기(letta agent-file `README.md:199-201`) | 없음(묶음 안 Profile만) | L · D-A2 |
| **AGENT-02** 예시나 내 Agent를 '복제해서 새로 만들기', 어디서 왔는지 남음 | 원본 유지 clone(openai-agents-python `src/agents/agent.py:571-590`), 출처 태그(letta-code `src/agent/personality-presets.ts:21-29`, `:82-104`) | 예시 편집이 예시 자체에 쌓임(`egdesk-profile-store.mjs:212-291`, `:467-488`) | S · 없음 |
| **AGENT-04·CHAT-07** 도구 범위를 '읽기만·리서치·문서 작업·코딩·제한 없음'에서 고르고, 얼굴을 누르면 '지금 이 대화에서 실제로 할 수 있는 것과 이유' | 이름 붙은 도구 프로필·금지 우선(openclaw `src/agents/tool-catalog.ts:338-384`, `:58-70`), 실제 적용값 설명(openclaw `docs/gateway/sandbox-vs-tool-policy-vs-elevated.md:13-30`, `:66-74`), 만들 때만 기본값 저장(paperclip `server/src/lib/agent-permissions.ts:60-76`) | 프리셋 1개(`EGDeskChatState.sys.mjs:1082-1084`), 미리보기는 저장값만(`:1265-1290`) | M · D-A1 |
| **AGENT-02·06** '이렇게 말한다' 예시 대화와 '하지 말 것'을 적으면 답변 지침에 들어간다 | 예시 대화·금지 규칙 별도 칸(character-card-spec-v3 `SPEC_V3.md:85-91`, awesome-openclaw-agents `agents/productivity/orion/SOUL.md:28-70`, agency-agents `engineering-code-reviewer.md:9-30`) | `egdesk-profile-store.mjs:95-105`, composeDeveloperInstructions `:164-178` | M · 없음 |
| **AGENT-02** Agent마다 정한 Codex 모델·추론 강도가 실제로 쓰인다 (2.4 AGENT-08과 같은 일) | model·model_reasoning_effort 덮어쓰기(codex `core/src/agent/role.rs:69-90`, 공식 subagents 문서) | runtime `:1030-1043`, `:1045-1060` | M · D-A4 확인 |
| **AGENT-02** '코드 리뷰를 꼼꼼하게 해 주는 담당자' 한 줄로 Agent 초안 채우기 | 대화로 Agent 정의 초안(Claude Code sub-agents 문서 v2.1.198~, dot-studio `README.md:178`, letta-code `:21-29`) | 수동 폼뿐 | M · D-A6 |

### 2.6 Board 대화방의 여러 Agent (CHAT-03, CHAT-10, CHAT-13, AGENT-05)

| 레퍼런스 | URL | 라이선스 | stars | 읽은 곳 |
|---|---|---|---|---|
| openai/codex (TUI agent center, app-server v2) | https://github.com/openai/codex | Apache-2.0 | 130,701 | REFS/codex (sparse) |
| lobehub/lobehub | https://github.com/lobehub/lobehub | LobeHub Community License — 패턴만 | 83,454 | REFS/lobehub |
| paperclipai/paperclip | https://github.com/paperclipai/paperclip | MIT | 106,626 | 선반 + REFS/paperclip-latest |
| ag-ui-protocol/ag-ui | https://github.com/ag-ui-protocol/ag-ui | MIT | 16,788 | REFS/ag-ui |
| a2aproject/A2A | https://github.com/a2aproject/A2A | Apache-2.0 | 26,274 | REFS/a2a |
| zulip/zulip | https://github.com/zulip/zulip | Apache-2.0 | 26,101 | REFS/zulip (파일만) |
| openai/openai-agents-js | https://github.com/openai/openai-agents-js | MIT | 3,938 | REFS/openai-agents-js |
| asheshgoplani/agent-deck (선반) | https://github.com/asheshgoplani/agent-deck | MIT | 1,152 | references/agent-tools/agent-deck |

| gap · 변화 | 가져올 패턴 (근거) | 우리 파일 | 크기 · 결정 |
|---|---|---|---|
| **CHAT-13·10** 하위 Agent마다 실제 이름·역할과 '승인 기다림/답 기다림/오류'가 Codex 신호대로 보인다 | `thread/status/changed` 플래그 → 도움 필요/작업 중/대기/쉬는 중, 도움 필요 먼저(codex `codex-rs/tui/src/app/agents_overview_view.rs:69-98`, `:428-437`, `agent_center/mod.rs:12-18`, `app-server-protocol/schema/typescript/v2/ThreadStatus.ts`, `ThreadActiveFlag.ts`, `Thread.ts:24-26`, `:89-92`) | runtime `:188-200`(허용 안 함, grep 0), `:1850`, `:2059-2063`(거절된 승인으로 추정), ChatState `:937`(id 8자 이름) | M · 없음 |
| **CHAT-13** 하위 Agent 줄 아래에 지금 하는 일 한 줄(최근 3개) | 최근 6개를 종류별 한 줄로 요약, 3줄 표시(codex `tui/src/app/agent_status_feed.rs:17-19`, `:81-113`, `:141-208`) | child item 알림은 run을 못 찾아 버려짐(runtime `:1846` 부근, **확인 필요**) | S · 없음 |
| **CHAT-13·10** 막힌 하위 Agent에 손쓰기(다시 시키기 또는 부모 권한 안에서 승인) | child 쓰레드로 들어가 승인(codex `agent_navigation.rs:1-55`), 하위 Agent별 Interrupt→ResumeEntry(ag-ui `generated_schemas.ts:707-717`, `:776-801`, `:1066-1080`), input-required=중단 상태(a2a `a2a.proto:200-207`) | runtime `:1846-1850`(무조건 거절) | M · D-M1 |
| **CHAT-10** Board 대화방 멤버가 실제 Agent가 되고 '막힘/작업 중/대기/쉬는 중' 칩으로 보인다 | 참여자 객체·역할(lobehub `packages/types/src/agentGroup/index.ts:68-88`, `packages/prompts/src/prompts/agentGroup/groupContext.ts`), 상태 어휘(paperclip `constants.ts:17-25`, a2a `a2a.proto:186-208`) | uc.js `:450-488`(이름 문자열), `:6525-6581` | L · 없음 (chat-store는 실행 중 작업 뒤) |
| **CHAT-10** '@디자인 리뷰어'라고 쓰면 그 Agent가 자기 대화로 받아 답하고 그 얼굴로 뜬다 | `[@이름](agent://id)` 토큰·부른 Agent만 깨움·자기 호출 제외(paperclip `server/src/services/issues.ts:1910-1930`, `server/src/routes/issues.ts:1762-1795`, `project-mentions.ts:96-125`, `:212-222`), 참여자 맥락 템플릿(lobehub groupContext) | 작성기 @ 없음, 대화방당 native 대화 1개 | L · D-M2 |
| **CHAT-10** Lead가 계획을 내면 단계마다 맡을 Agent가 정해지고 끝나면 Lead가 정리 | speak/broadcast/delegate/execute/finish + maxRounds(lobehub `packages/agent-runtime/src/groupOrchestration/GroupOrchestrationSupervisor.ts:21-37`, `:48-175`, `types.ts:53-66`, `:84-111`) | `helper/egdesk-task-plans.mjs:12-60`(담당 필드 없음) | L · D-M2, D-M4 |
| **CHAT-03** 개인 대화에서 고른 메시지만 Board 대화로 보내고 양쪽에 '보냄/가져옴' 줄과 링크 | 이동 안내 줄(zulip `zerver/actions/message_edit.py:337-380`, `:1462-1530`), 넘기는 기록 고르기(openai-agents-js `handoff.ts:21-44`), 우리 Contract `:1592`, `:728-735` | 메시지 메뉴엔 '분기'만(uc.js `:6327-6338`), boardRefs는 만드는 코드 없음(chat-store `:61`, `:129`) | L · D-M3 |
| **CHAT-03** Agent가 대표님을 태그하면 방 목록에 '나를 불렀어요', 열어 보면 꺼진다 | `user://` 태그(paperclip-latest `project-mentions.ts:3`, `:126-147`, `:224-235`), 확인 처리(agent-deck `internal/ui/home.go:4829-4833`, `:5493-5532`) | 없음 | M · 없음 (참여자 모델 뒤) |

### 2.7 Chat 답변 → Canvas 결과 · 브리핑

| 레퍼런스 | URL | 라이선스 | stars | 읽은 곳 |
|---|---|---|---|---|
| tldraw/agent-template | https://github.com/tldraw/agent-template | MIT (tldraw SDK 본체는 tldraw license — SDK는 안 씀) | 40 (본체 51k) | REFS/tldraw-agent-template |
| LibreChat | https://github.com/LibreChat-AI/LibreChat | MIT | 46,226 | REFS/librechat |
| vercel/chatbot | https://github.com/vercel/chatbot | Apache-2.0 (GitHub 표시 NOASSERTION, LICENSE 본문 확인) | 21,005 | REFS/vercel-chatbot |
| driver.js | https://github.com/nilbuild/driver.js | MIT | 26,947 | REFS/driverjs |
| excalidraw | https://github.com/excalidraw/excalidraw | MIT | 134,441 | REFS/excalidraw |
| Penpot | https://github.com/penpot/penpot | MPL-2.0, 패턴만 | 61,555 | REFS/penpot (파일 2개) |
| Firefox urlbar | https://github.com/mozilla-firefox/firefox/tree/main/browser/components/urlbar | MPL-2.0, 패턴만 | - | REFS/firefox-urlbar |
| CopilotKit (서재) | https://github.com/CopilotKit/CopilotKit | MIT | 38,196 | REFS/copilotkit (선반 clone 없음) |
| open-canvas (보관됨) | https://github.com/langchain-ai/open-canvas | MIT | 5,478 | REFS/open-canvas |
| JSON Canvas | https://github.com/obsidianmd/jsoncanvas | MIT | 3,736 | gh api |

| gap · 변화 | 가져올 패턴 (근거) | 우리 파일 | 크기 · 결정 |
|---|---|---|---|
| **CHAT-08** Agent가 긴 보고서를 스스로 'Canvas 결과'로 내보내고 Chat에는 짧은 설명과 '카드로 열기' 줄만 | createDocument 도구·"언제 쓰고 언제 쓰지 말지"·"본문을 Chat에 반복하지 말 것"(vercel-chatbot `lib/ai/tools/create-document.ts:22-89`, `lib/ai/prompts.ts:4-45`), identifier 키·버전(LibreChat `client/src/components/Artifacts/Artifact.tsx:71-90`, open-canvas `packages/shared/src/types.ts:121-124`) | `helper/egdesk-context-runtime.mjs:12-17`(게시 도구 없음), Profile 지침은 'canvas 카드로'를 요구(uc.js `:117`, `:133`, `:148`) | M · 자동 열기만 D-K4 |
| **CHAT-05·CNV-07** 브리핑 한 단계에서 근거 여러 개가 함께 밝게, 나머지는 흐리게 | 전체 덮개 + evenodd 구멍 여러 개(driver.js `packages/driver/src/stage.ts:18-39`, `overlay.ts:8-28`, `:113-148`, `events.ts:53-63`), 대상 여러 개 오버레이(tldraw-agent-template `client/overlays/AgentHighlightOverlayUtil.ts:64-128`) | `EGDeskBriefingState.sys.mjs:26`(대상 1개), context-runtime `:16`, `:217-229`, uc.js `:1394` | M · 없음 |
| **CHAT-05** 브리핑 단계 의견이 닫아도 남고, 초안에는 그 의견을 가리키는 표시로 | 위치에 고정된 스레드·번호·해결 상태(penpot `backend/src/app/rpc/commands/comments.clj:445-455`, `:494-525`, `:573-584`) | uc.js `:1490-1500`, `:8694-8706`(메모리에만, 닫으면 사라짐) | M · 없음 |
| **CNV-07** 브리핑 중 Dock·레일이 작아지고 미니맵에 단계 번호 | 같은 데이터를 본 화면과 미니맵에(tldraw-agent-template `AgentHighlightOverlayUtil.ts:64-93`, `:130-160`, `:376-378`) | uc.js `:4755` renderDeskMinimapWorld | M · 없음 |
| **CNV-05** Canvas 카드 위 AI 표식이 '제안'으로 올라오고 받아들이기·옮기기·지우기, Board와 저장 | 구조화 도형 데이터·note·대상 id 화살표(`shared/format/FocusedShape.ts:56-65`, `:92-105`), pending/accepted/rejected 묶음(`shared/types/ChatHistoryItem.ts:27-33`, `client/agent/managers/AgentActionManager.ts:90-125`, `ChatHistoryGroupWithDiff.tsx:16-56`), 0~1 비율 좌표(excalidraw `types.ts:320-333`), 우리 초안 `docs/AI_CANVAS_ANNOTATION_LAYER.md` | 도형 7종은 자유 좌표만(uc.js `:10125`, `:2418`), Browser 대상 마커는 백분율·aria-hidden(`:13320-13353`) | L · D-K1 (계산 모듈은 결정 없이) |
| **CNV-05** '로그인 버튼 찾아 표시해줘' → 실제 요소에 상자·이름표 제안(화면 캡처 없이) | id로 대상 지정(`shared/types/ContextItem.ts:5-29`, `AgentActionSchemas.ts:100-107`, `:138-152`), 응답 버튼은 실행 중일 때만(CopilotKit `use-human-in-the-loop.tsx:33-58`, `:78-105`), 우리 관찰이 이미 ref·bounds·documentId·revision을 줌(Child `:657-668`, `:734-742`) | 게시 도구는 브리핑뿐 | L · D-K1 |
| **CNV-06** Canvas에 메모를 붙이고 [Rio에게 묻기], Agent 답은 메모 안 답글로 | 본문과 작성자별 답글 분리·frame 고정(penpot `comments.clj:494-525`, `frontend/.../comments.cljs:155-192`), sticky note(excalidraw `types.ts:96-104`), JSON Canvas edge | `--egd-note` 토큰만 | L · 1단계 없음, 답글 자동은 D-K5 |
| **UX-04** 상단 검색에 할 일을 쓰면 'Codex에게 요청: "…"' 줄, Enter는 초안으로 | 입력 중 보조 동작 행·대상 이름·Tab 안내(firefox-urlbar `ActionsProvider.sys.mjs:29-51`, `ActionsProviderContextualSearch.sys.mjs:81-125`, `UrlbarProviderGlobalActions.sys.mjs:81-125`, `:195-222`) | uc.js `:5300`(자리표시만), `:3700-3714`, `:3830-3877`(Tab은 Browser 카드 focus) | S · D-K2 |
| **CHAT-08·04** 답변 아래 결과·파일·카드 버튼이 '종류 배지 + 제목' 한 줄씩으로 | 칩 묶음을 줄로 바꾼 이유와 구조(LibreChat `Chat/Messages/Content/Parts/ArtifactRow.tsx:45-65`, `:81-136`) | uc.js `:835-853`, `:6749-6758` | S · 없음 |

### 2.8 Canvas · Board · 미니맵 · 배치 (CNV-01~04, UX-01·02·05·06)

| 레퍼런스 | URL | 라이선스 | stars | 읽은 곳 |
|---|---|---|---|---|
| DeadWaveWave/opencove | https://github.com/DeadWaveWave/opencove | MIT | 1,634 (2026-10-17) | REFS/opencove/repo (sparse) |
| excalidraw | https://github.com/excalidraw/excalidraw | MIT | 134,441 | REFS/excalidraw |
| tldraw | https://github.com/tldraw/tldraw | tldraw license — 패턴만 | 51,059 | REFS/tldraw |
| malbiruk/driftwm | https://github.com/malbiruk/driftwm | GPL-3.0 — 패턴만 | 1,839 (2026-10-23) | REFS/driftwm |
| collabs-inc/collab-public | https://github.com/collabs-inc/collab-public | FSL-1.1-ALv2 — 패턴만 | 3,075 | REFS/collab-public |
| xyflow (선반) | https://github.com/xyflow/xyflow | MIT (helper lines 예제는 지금 xyflow Pro License라 사용 불가) | 38,761 | references/xyflow (2026-03-27, 7개월 뒤처짐) |
| zen-browser/desktop | https://github.com/zen-browser/desktop | MPL-2.0 | 45,203 | REFS/brw_zen-browser |
| quickdrawjs/quickdraw | https://github.com/quickdrawjs/quickdraw | MIT | 568 | REFS/quickdraw |
| dot-studio (현 apm-studio, 선반) | https://github.com/apm-studio/apm-studio | MIT | 437 (2026-06-03 이후 멈춤) | references/agent-orchestration/dot-studio |

| gap · 변화 | 가져올 패턴 (근거) | 우리 파일 | 크기 · 결정 |
|---|---|---|---|
| **UX-05** 창을 끌면 24px 격자와 옆 창 가장자리·중앙에 붙고, Option/Alt 동안은 자유 | 격자+가장자리 맞춤 순수 함수(opencove `src/contexts/workspace/presentation/renderer/utils/workspaceSnap.ts:26`, `:207-308`, `useNodeDragSession.ts:279-325`, `workspaceArrange.shared.ts:6-8`), 임계값 8/zoom(excalidraw `snapping.ts:41-49`, `:162-192`), 후보는 화면 안 형제만(tldraw `SnapManager.ts:60-100`, 패턴만), gap만큼 띄워 붙이기(driftwm `src/layout/snap.rs:127-183`, 패턴만) | 끌기 처리 6벌(uc.js spawnDeskWindowShell, Chat 카드 9878, 설정 13252, Terminal 16106, 도형 10548, 크기 조절 2벌) | L · D-V5 |
| **UX-05** 실수로 옮긴 창을 ⌘/Ctrl+Z로 되돌림(창 머리·Canvas 포커스일 때만) | 현재 rect가 '이후 rect'와 같을 때만 되돌림(opencove `canvasCollapseArrange.snapshot.ts:121-140`), 제스처 묶음(tldraw `HistoryManager.ts:260-312`) | 이전 rect를 남기지 않음(uc.js `:4432`) | M · D-V5 |
| **UX-05** 여러 창을 고르고 [겹침 없이 정리] | flow packing(opencove `workspaceArrange.flowPacking.ts:14-37`, `:63-104`) | 정리 명령 없음 | M · D-V5 |
| **UX-05 (2차)** 묶어 한 번에 옮기기·숫자 입력·방향키 | groupIds(excalidraw `groups.ts:20-135`), 다음 맞춤 지점 이동(driftwm `snap.rs:239-290`) | 없음 | L+M · D-V5 |
| **CNV-03·01** 선택한 창으로 새 Board를 저장하면 그 자리에서 Board 영역이 생기고 다시 열어도 두 벌이 안 생긴다 | 선택을 제자리에서 프레임으로 감싸기(excalidraw `actionFrame.ts:210-271`, `frame.ts:570-661`) | planBoardProjection(SurfaceState `:963`), uc.js showBoardScopeChooser 4244, openBoardSnapshot 2964, mountBoardMember 2519(openMode 'new') | M · D-V4 |
| **CNV-03** 창 [⋯]에서 'Board에 추가/제외', 창 머리에 소속 Board 이름 | frameId 하나(excalidraw `frame.ts:570-700`, `:723-771`), 한 창 한 Space(opencove `useSpaceOwnership.drop.helpers.ts:60-108`, `workspaceLayoutPolicy.ts:7-17`) | 소속은 dataset.projectionId 하나 | M · D-V1 |
| **CNV-03** 창을 Board 영역 안에 놓으면 '[이름]에 추가' 제안, 누를 때만 바뀜 | 끌기 중 소속 재계산 간격(tldraw `DragAndDropManager.ts:14-15`, `:86-125`), 가장 안쪽 Space(opencove `src/contexts/space/application/spaceContainment.ts:52-86`) | Board 영역은 배치 장애물로만 | M · D-V3 |
| **CNV-01** Board 제목줄을 끌면 그 Board 창들이 함께 움직임 | opencove `useSpaceDrag.ts:62-140`, `:196-304`; tldraw `frames.ts:99-137` | 제목 버튼·메뉴만(uc.js refreshBoardRegion 2609) | M · 없음 |
| **UX-02** 미니맵 목록에서 이름을 치면 걸러지고 ↑↓로 고르면 카메라 이동 | Board 먼저·보이는 첫 일치·scale-down 맞춤(excalidraw `SearchMenu.tsx:194-255`, `:792-887`) | buildDeskMinimapEntityRows 5132(처음 8개만) | M · 없음 |
| **UX-02** 화면 밖 Briefing 대상·Agent 작업 창이 화면 가장자리 점으로 | collab `collab-electron/src/windows/shell/src/edge-indicators.js:8-60`, `:71-110`(FSL 패턴만) | 없음 | M · 없음 |
| **UX-02** 카메라를 움직여도 미니맵을 매 프레임 다시 그리지 않음 | 월드 좌표 SVG·마스크만 갱신(xyflow `MiniMap.tsx:78-90`, `:155-185`), dirty+rAF(collab `canvas-minimap.js:184-195`) | apply()마다 refreshDeskMinimap이 DOM 재구성(uc.js 16927 → 5158 → 5008, 실측 안 함) | M · 없음 |
| **UX-06** 창을 크게 띄운 채 오른쪽 가장자리에 마우스를 대면 채팅이 겹쳐 보이고 [고정]하면 옆으로 | hover 지연·나갈 때 유예·메뉴 열리면 유지(Zen `src/zen/compact-mode/ZenCompactMode.mjs:75-78`, `:615-632`, `:662-725`, `:747-800`) | enterCardFullscreen 9991(HUD 숨기기만) | M · D-V6 |
| **UX-06** Esc를 누르면 맨 위에 열린 것부터 하나씩 닫힘 | 층 레지스트리(opencove `src/app/renderer/components/ui/overlayLayerRegistry.ts:1-58`, `DismissableLayer.tsx:1-90`) | Esc 처리 16곳 제각각, 최대화는 Esc로 안 닫힘 | M · 없음 (**확인 필요**: 이 파일은 scratchpad sparse 사본에 없음 — gh api로 다시 받는다) |
| **UX-06** 노란 점(최소화)으로 창이 접힌 타일이 되고 다시 누르면 원래대로 | 접힌 목록·표시 크기만 변경(opencove `collapsedNodeGeometry.ts:1-4`, `canvasCollapse.ts:1-90`) | 최소화 버튼 aria-disabled(uc.js 10173) | M · 없음 |
| **UX-06** 파일·Terminal·결과 창도 전체 화면 집중 보기 | 진입 전 상태 저장·복원(dot-studio `src/lib/focus-utils.ts:5-14`, `:81-136`) | Browser만 Desk 도구 숨김 | S · 없음 |
| **CNV-02** 채팅에서 연 결과·브라우저 창이 채팅 바로 옆에 24px 띄워 열림 | 포커스 창 무리 옆에 붙이기(driftwm `src/layout/auto_placement.rs:79-200`, 패턴만) | placeCanvasView(SurfaceState `:448-463`, opener 미사용) | S · 없음 |

### 2.9 디자인 토큰 · 접근성 · Firefox 껍데기 UI (DSN-01~04, BRW-01, UX-03)

| 레퍼런스 | URL | 라이선스 | stars | 읽은 곳 |
|---|---|---|---|---|
| Firefox design-system 토큰 | https://github.com/mozilla-firefox/firefox/tree/main/toolkit/themes/shared/design-system | MPL-2.0 | - | REFS/firefox-design-system |
| zen-browser/desktop (테마) | https://github.com/zen-browser/desktop | MPL-2.0 | 45,203 | REFS/brw_zen-browser |
| radix-ui/colors · radix-ui/themes | https://github.com/radix-ui/colors | MIT | 1,719 / 8,787 | REFS/radix-colors + gh api |
| w3c/aria-practices (APG) | https://github.com/w3c/aria-practices | W3C Software and Document License | 1,359 | REFS/aria-practices |
| mui/base-ui | https://github.com/mui/base-ui | MIT | 11,220 | REFS/base-ui |
| adobe/react-spectrum (React Aria) | https://github.com/adobe/react-spectrum | Apache-2.0 | 15,978 | REFS/react-spectrum |
| primer/primitives | https://github.com/primer/primitives | MIT | 415 | REFS/primer-primitives |
| MrOtherGuy/fx-autoconfig · firefox-csshacks | https://github.com/MrOtherGuy/firefox-csshacks | MPL-2.0 | 495 / 4,557 | REFS/brw_fx-autoconfig + gh api |
| Floorp (참고가 덜 됨) | https://github.com/Floorp-Projects/Floorp | MPL-2.0 | 8,457 | REFS/brw_floorp |

| gap · 변화 | 가져올 패턴 (근거) | 우리 파일 | 크기 · 결정 |
|---|---|---|---|
| **BRW-01** Browser 카드 툴바를 Tab 한 번에 들어가 화살표로 오가고, 뒤로 가기가 끝나도 포커스가 사라지지 않는다 | role=toolbar·화살표·Home/End(APG `content/patterns/toolbar/examples/js/FormatToolbar.js:307-345`, `toolbar-pattern.html:55-101`), 비활성 버튼은 aria-disabled로 포커스 유지(APG `keyboard-interface-practice.html:391-405`, base-ui `packages/react/src/utils/useFocusableWhenDisabled.ts:15-47`, `toolbar/button/ToolbarButton.tsx:23-51`), 입력칸 커서 경계(base-ui `internals/composite/root/useCompositeRoot.ts:228-246`), Tab 이탈·마지막 버튼 복원(react-aria `toolbar/useToolbar.ts:90-148`) | uc.js `:14026-14100`(aria-label 없음, role=toolbar 0건), `:15193-15194`(native disabled), uc.css `1342-1350` | M · 없음 |
| **DSN-04** AI 엔진·모델·추론 강도, 설정 탭, 하단 Dock을 Tab 한 번 + 화살표로 | APG `radio/examples/js/radio.js:26-51`, `tabs/examples/js/tabs-automatic.js:26-60`, `:94-109`, react-aria `useToolbar.ts:143` | uc.js `:6452-6520`, `:13155-13168`, `:5620-5627`(18개 버튼 각각 Tab) | M · 없음 |
| **DSN-04** Agent 아바타 글자가 밝은·다크 모두 4.5:1 이상 | 색마다 고정 글자색·soft 변형(radix themes `avatar.css:122-143`, `sage.css:7`, `amber.css:7`), [최소대비, 글자, 배경] 검사표(primer `scripts/colorContrast.config.ts:20-60`) | uc.css `6539-6546`(tone-2 3.42/3.39, tone-3 4.00/2.91 — 조사 작업자 계산) | S · 방식 D-G2 확인 |
| **DSN-04** Windows 고대비·macOS '대비 증가'에서 테두리·포커스·선택이 시스템 색으로 | 토큰을 prefers-contrast·forced-colors에서 한 번 재정의(Firefox `dist/tokens-shared.css:573-642`, `:644+`, `src/tokens/base/focus.tokens.json`, 공식 HCM 문서 https://firefox-source-docs.mozilla.org/accessible/HCMMediaQueries.html) | grep 0건, 테두리 1.33:1·포커스 테두리 2.11:1 | M · 없음 |
| **DSN-03·04** 키보드 포커스와 비활성 모양이 어디서나 같고 검색칸 포커스도 또렷 | 포커스 토큰 한 묶음·비활성 투명도 하나(Firefox `tokens-shared.css:367-372`, `:130`, `:510`, `:520`, `:634`) | :focus-visible 49개 offset 제각각, 비활성 34개 투명도 8가지, 검색칸 2279·3246 약함 | M · 없음 |
| **BRW-01** 키보드 포커스에서도 이름·단축키 툴팁, Esc로 닫힘 | 1500ms warmup·500ms cooldown·focus-visible에서 열기(react-stately `useTooltipTriggerState.ts:53-54`, `:76-78`, react-aria `useTooltipTrigger.ts:67`, `:118-123`, `:149`), 이름과 툴팁 분리(moz-button `moz-button.mjs:221-224`, `:381-384`) | native title만(28곳) | M · 없음 |
| **UX-03** Browser 카드 상단 상태가 '불러오는 중/보안 연결'처럼 한국어로 | 표시 문구와 종류 키 분리 | uc.js `:2070-2087`, `:13992`, `:15187`, 시험 `egdesk-surface-state.test.mjs:1728-1735` | S · 없음 |
| **DSN-02** Chat 방 목록 아바타가 레거시 파랑·자주가 아니라 그 방 Agent의 아바타로 | 정체성 색은 토큰 단계로만(radix avatar.css) | uc.js `:6661-6665`(인라인 8색, #2D5A7B 포함), 시험 `5865-5869`(CSS만 검사) | S · 없음 |
| **DSN-03** 글자 크기·모서리·움직임이 정해진 단계로 | 단계 토큰·JSON 원본·생성물 'DO NOT EDIT'(Firefox `tokens-shared.css:5-6`, `:29-33`, `:372-382`, `:481-485`, `tokens-platform.css:39-42`, package.json style-dictionary ^5.5.1), DTCG 2025.10 | 크기 토큰 0건, 글자 20가지·모서리 12가지 리터럴 | L(1단계 S) · D-G1, D-G5 |
| **DSN-01·04** 다크·동작 줄이기·고대비 화면 검증을 명령 한 줄로 | pref로 흉내(Zen 시험 `ui.systemUsesDarkTheme`, `ui.prefersReducedMotion`) | `scripts/run-firefox-mcp-target.mjs:51-69`(화면 모드 pref 없음) | S · 없음 (**확인 필요**: `ui.useAccessibilityTheme`는 검색 결과로만 확인) |
| **DSN-01** 설정에서 화면 모드 '시스템·밝게·어둡게' 직접 선택 | light-dark() 한 줄 토큰·`-moz-pref` 미디어쿼리(Zen `src/zen/common/styles/zen-theme.css:19-62`, `:309-357`, csshacks `chrome/menupopup_forced_color_schemes.css`) | 시스템만 따름(uc.css `11-86`, `92-127`) | M · D-G4 |

### 2.10 코딩 화면 (CODE-02 ~ CODE-07)

| 레퍼런스 | URL | 라이선스 | stars | 읽은 곳 |
|---|---|---|---|---|
| pingdotgg/t3code | https://github.com/pingdotgg/t3code | MIT | 29,678 | REFS/t3code |
| openai/codex | https://github.com/openai/codex | Apache-2.0 | 130,704 | gh api(item_builders.rs, file_update.rs, turn_diff_tracker.rs, fuzzy_file_search.rs) → scratchpad 파일 |
| Zed (action_log, agent_ui) | https://github.com/zed-industries/zed | GPL-3.0-or-later — 패턴만 | 92,111 | scratchpad/zed_action_log.rs, zed_agent_diff.rs |
| @codemirror/merge | https://code.haverbeke.berlin/codemirror/merge | MIT | (GitHub 미러 보관) | scratchpad/cm_unified.ts, npm 6.12.3 |
| jsdiff | https://github.com/kpdecker/jsdiff | BSD-3-Clause | 9,213 | REFS/code_jsdiff/jsdiff (9.0.0) |
| microsoft/vscode | https://github.com/microsoft/vscode | MIT | 194,254 | scratchpad/vscode_*.ts |
| dorny/test-reporter | https://github.com/dorny/test-reporter | MIT | 1,183 | gh api |
| BloopAI/vibe-kanban | https://github.com/BloopAI/vibe-kanban | Apache-2.0 | 28,440 | REFS/vibe-kanban |
| agentclientprotocol/claude-agent-acp · ACP 명세 | (2.4와 같음) | Apache-2.0 | - | REFS/claude-agent-acp/src/diff.ts |
| Theia (선반) | https://github.com/eclipse-theia/theia | EPL-2.0 + GPL-2.0 w/ CPE — 패턴만 | 21,717 | references/theia (2026-03-20) |
| pierre (@pierre/trees, diffs) | https://github.com/pierrecomputer/pierre | Apache-2.0 | 6,356 | README·package.json만 |

| gap · 변화 | 가져올 패턴 (근거) | 우리 파일 | 크기 · 결정 |
|---|---|---|---|
| **CODE-05** 에이전트가 파일을 고치겠다고 물을 때 승인 카드에서 바뀌는 줄(+/−)을 본다 | update는 머리줄 없는 hunk-only diff(codex `apply-patch/src/file_update.rs:176-198`, `app-server-protocol/src/protocol/item_builders.rs:365-380`), 회차 diff는 git 형식·100ms 상한(`core/src/turn_diff_tracker.rs:14-17`, `:335-365`), jsdiff는 hunk-only를 받음(`src/patch/parse.ts:1-15`), 1MB·100ms 상한(claude-agent-acp `src/diff.ts:18-34`) | runtime `:97-103`(diff 버림), `:2203-2214`, uc.js `:1863-1870`(경로만) | L · 없음 |
| **CODE-05·07** 파일 창 '변경' 탭에서 '이번 회차/커밋 안 한 변경'의 바뀐 파일 목록과 내용 | 범위 선택·파일 트리(t3code `apps/web/src/components/DiffPanel.tsx:258-330`, `diffs/diffFileTree.logic.ts:17-45`), diff-index plumbing(`apps/server/src/checkpointing/Diffs.ts:8-36`, `vcs/GitVcsDriverCore.ts:2123-2128`) | `EGDeskFileView.sys.mjs:406-429`(파일 1개 비교) | M · 없음 |
| **CODE-05** 이미 고친 파일을 덩어리별 '유지/되돌리기' | 적용 후 검토·새 파일은 손대지 않았을 때만 삭제·되돌리기 취소(zed `crates/action_log/src/action_log.rs:641-980`, 패턴만), acceptChunk/rejectChunk(codemirror merge `src/unified.ts:221-250`), 상태 계산(theia `packages/ai-chat/src/browser/change-set-file-element.ts:149-178`) | Codex 승인은 묶음 전체만 | L · D-X2 |
| **CODE-04** 파일 창에서 고친 내용을 원래 파일에 저장, 그 사이 바뀌었으면 비교·선택 | 더러운 쓰기 방지·내용 같으면 허용(vscode `src/vs/platform/files/common/fileService.ts:502-536`), 반례(t3code `WorkspaceFileSystem.ts:541-582`) | `egdesk-file-service.mjs:299-304`(작업사본만), `:330-353` | L · D-X1 |
| **CODE-04·03** 코드가 색·줄번호로 보이고 파일 안 검색·줄 이동 (CodeMirror 6) | `docs/references/coding-surface-framework-research.md` 0·2단계, merge 옵션(`unified.ts:60-90`) | textarea(`EGDeskFileView.sys.mjs:134-138`) | L · D-X5 |
| **CODE-02** Board마다 프로젝트 폴더를 정하면 에이전트 작업 위치와 파일 창이 같아짐, Chat 머리에 프로젝트 이름 | 작업 폴더 한 줄 규칙(t3code `apps/server/src/project/threadWorkspaceRoot.ts:9-18`, `packages/contracts/src/project.ts:154`, `:187`), turn/start cwd는 이후 회차까지(codex `TurnStartParams.ts`) | uc.js `:365`(설정하는 곳 없음), bridge-server `:485`, `:538`, `:172` | L · D-X3 |
| **CODE-03** 이름은 오타가 있어도 찾고(.gitignore 제외), 내용으로 찾아 누르면 그 줄로 | app-server `fuzzyFileSearch`(codex `app-server/src/fuzzy_file_search.rs:18-60`), 시간·결과 상한(t3code `WorkspaceSearchIndex.ts:36-42`), gitignore 색인(vibe-kanban `crates/services/src/services/file_search.rs:20-60`) | `egdesk-file-service.mjs:180-215`(이름 부분일치 BFS, node_modules까지) | M · 없음 |
| **CODE-03** 트리에 수정·새 파일·삭제 표시, 다른 프로그램이 만든 파일이 저절로 나타남 | porcelain v2 경로 자르기(t3code `GitVcsDriverCore.ts:214-229`, `:2036-2060`), 바뀐 경로만 재계산(vibe-kanban `diff_stream.rs:379-420`, `:599`) | file.changed가 overlay까지 안 감(`egdesk-file-watch.mjs:39`) | M · 없음 |
| **CODE-06** 테스트·빌드 결과 카드에 '12 통과 · 1 실패'와 실패 위치, 누르면 그 줄 | outputDelta(codex `CommandExecutionOutputDeltaNotification.ts`), 출력 꼬리 요약(t3code `CodexAdapterV2.ts:428-447`), file:line 해석기(vscode `terminalContrib/links/browser/terminalLinkParsing.ts:44-120`, MIT 포팅 가능), 결과 모델·스택 첫 프로젝트 프레임(test-reporter `src/test-results.ts`, `src/utils/node-utils.ts`) | runtime `:91-96`(출력 미보관), uc.js `:1847-1851`('key: value' 줄) | L · 없음 |
| **CODE-06** 프로젝트 '테스트·빌드' 명령을 정해 두면 파일 창 '검사'가 터미널에서 돌리고 결과 카드 | 프로젝트 스크립트(t3code `packages/contracts/src/project.ts:22-41`) | '검사' 버튼 늘 비활성(`EGDeskFileView.sys.mjs:164-171`) | M · D-X6 (프로젝트 D-X3 뒤) |
| **CODE-07** Dock의 IDE 버튼이 파일 창·터미널·최근 결과 카드를 한 번에 | t3code 작업 화면 구성 | Dock 'ide'에 처리 없음(uc.js `:69`, `:5647-5668`) | S · 프로젝트 뒤 |
| **CODE-05** Codex·Claude 공통 변경 모양, 셸로 고친 파일도 회차 변경에 | ACP `{path, oldText, newText}`(`docs/protocol/v1/tool-calls.mdx:272-294`), Claude Edit/Write → patch(claude-agent-acp `diff.ts:99-160`), turn diff 한계(codex `turn_diff_tracker.rs:47-49`), git checkpoint(t3code `GitVcsDriver.ts:809-1170`, `CodexAdapterV2.ts:232-236`) | 없음 | L · D-X4 |

### 2.11 런타임 · 맥락 · 저장 · 묶음 · 패키징 (RT-01~04·07, CTX-01~04, CHAT-06)

| 레퍼런스 | URL | 라이선스 | stars | 읽은 곳 |
|---|---|---|---|---|
| langchain-ai/langgraphjs | https://github.com/langchain-ai/langgraphjs | MIT | 3,370 (2026-10-24) | REFS/langgraphjs |
| vercel/workflow | https://github.com/vercel/workflow | Apache-2.0 | 2,471 | REFS/workflow |
| mastra-ai/mastra | https://github.com/mastra-ai/mastra | Apache-2.0 (ee/ 제외) | 29,040 | gh api step.ts |
| tldraw | https://github.com/tldraw/tldraw | tldraw license — 패턴만 | 51,059 | REFS/rt_tldraw |
| excalidraw | https://github.com/excalidraw/excalidraw | MIT | 134,441 | REFS/rt_excalidraw |
| obsidianmd/jsoncanvas | https://github.com/obsidianmd/jsoncanvas | MIT | 3,736 | REFS/rt_jsoncanvas |
| microsoft/vscode | https://github.com/microsoft/vscode | MIT | 194,254 | REFS/rt_vscode_files |
| cline/cline | https://github.com/cline/cline | Apache-2.0 | 70,786 | REFS/rt_cline |
| mozilla/web-ext | https://github.com/mozilla/web-ext | MPL-2.0 | 3,147 | REFS/rt_webext |
| zen-browser/desktop (빌드) | https://github.com/zen-browser/desktop | MPL-2.0 | 45,203 | REFS/rt_zen |
| fx-autoconfig | https://github.com/MrOtherGuy/fx-autoconfig | MPL-2.0 | 495 | REFS/rt_fxac |
| Node.js SEA 문서 | https://nodejs.org/api/single-executable-applications.html | MIT | - | web |
| tauri-apps tray-icon · global-hotkey · plugins-workspace | https://github.com/tauri-apps/tray-icon | MIT OR Apache-2.0 / Apache-2.0 | 412 / 266 / 1,834 | gh api |
| blackboardsh/electrobun (서재) | https://github.com/blackboardsh/electrobun | MIT | 12,951 | gh api Updater.ts |
| wezterm (portable-pty) | https://github.com/wezterm/wezterm | MIT | 29,329 | gh api pty/src/lib.rs |
| 선반 deer-flow · deepagentsjs · context-mode · claude-mem | (서재 등록) | MIT / MIT / ELv2(패턴만) / 선반 사본 AGPL(원본은 Apache-2.0) | - | references/… (2026-03~04에서 멈춤) |

| gap · 변화 | 가져올 패턴 (근거) | 우리 파일 | 크기 · 결정 |
|---|---|---|---|
| **RT-07·CHAT-06** 작업 목록·계획 기록이 오래 쌓여도 느려지거나 깨지지 않음 | 추가만 하는 이벤트 행·체크포인트 행(langgraphjs `libs/checkpoint-sqlite/src/index.ts:186-207`, vercel/workflow `packages/world/src/events.ts:22-42`) | 이벤트마다 JSON 전체 다시 쓰기 4곳(`egdesk-task-store.mjs:82-86`, `egdesk-task-plans.mjs:101-105`, `egdesk-task-sources.mjs:67-71`, `egdesk-task-native-store.mjs:173-177`) | M · 없음 |
| **RT-07·CTX-02** 복구 기록에 대화 전문이 매번 복사되지 않음 | 문서와 세션 상태 분리(tldraw `TLSessionStateSnapshot.ts:83-130`, 패턴만) | uc.js `:2463-2476`(Desk snapshot에 chat.threads 전문), `EGDeskRecoveryState.sys.mjs:307-316` | S · 없음 (**확인 필요**: 복원 경로가 snapshot의 chat 본문에 기대는지) |
| **CTX-02** 카드를 여러 번 옮겨도 복구 목록이 한 줄씩 늘지 않음 | mergeWindow(vscode `workingCopyHistoryService.ts:122-140`) | `egdesk-desk-store.mjs:286`, `:268` | S · D-R1 |
| **CTX-01** 두 창에서 같은 Board를 고쳐도 다른 카드면 자동으로 합쳐짐 | 요소별 version/versionNonce(excalidraw `packages/excalidraw/data/reconcile.ts:23-39`, `:73`) | Board 전체 단위 409(`egdesk-desk-store.mjs:319`), 화면은 '내 것을 새 버전으로'만(`EGDeskRecoveryState.sys.mjs:411-435`) | M · 없음 |
| **RT-03·07** 예전 버전 .egdesk도 열리고 더 새 버전 파일은 '새 버전에서 만든 파일'로 안내 | 형식 버전+스키마 이전 순서(tldraw `tldr/file.ts:57-68`, `:150-190`, `store/src/lib/migrate.ts:55-106`, 패턴만), restore(excalidraw `data/restore.ts:956`, `:1264`) | `egdesk-portable-service.mjs:462`(v≠1이면 손상) | M · 없음 |
| **RT-03** 원하면 첨부 자료·캡처도 같이 담겨 다른 PC에서 빈 카드가 안 됨 | 참조된 자산만(excalidraw `data/json.ts:28-70`, tldraw `file.ts:191-245`) | body 하나만(`egdesk-portable-service.mjs:346-366`, `:456-457`) | L · D-R3 |
| **RT-03** Board를 Obsidian 등에서 열리는 .canvas로 내보내기·가져오기 | JSON Canvas 1.0(`spec/1.0.md:5-100`) | .egdesk만 | M · 없음 |
| **CTX-03** 은행·메일처럼 지정한 사이트·폴더는 '이것도 붙일까요?'에 안 나오고, 추천 방식을 '항상·첫 메시지만·끔'으로 | 모드 설정·무시 목록·꺼진 칩(vscode `chatImplicitContext.ts:56`, `:310-312`, `:395-440`, `implicitContextAttachment.ts:44`, `:144-197`) | `egdesk-context-resolver.mjs:12`, `:186-191`(제외 목록 없음) | M · D-R2 |
| **CTX-04** 보낸 뒤 첨부 자료가 바뀌면 칩에 '바뀜', 다음 메시지에 알려짐 | active/stale 추적(cline `ContextTrackerTypes.ts:2-9`, `FileContextTracker.ts:84-160`) | 스냅샷 불변, 버스와 미연결 | M · 없음 |
| **CTX-03** 지금 쓰는 말과 관련된 저장된 Board도 후보로(한국어 부분 일치) | FTS5 trigram·bm25 가중(context-mode `src/store.ts:333-346`, `:394-412`, ELv2 패턴만), node:sqlite v24.11.1 FTS5 trigram [런타임 — 조사 작업자가 직접 실행] | bestBoard는 활성·초점·면적만(`egdesk-context-resolver.mjs:131-147`) | M · 없음 |
| **CHAT-06** Agent가 '어느 쪽으로 할까요?' 선택지를 내고 기다리며 고른 답이 다음 단계로 | response_schema 재개(langgraphjs `libs/langgraph-core/src/interrupt.ts:36`, `:127-166`), suspendSchema/resumeSchema(mastra `step.ts:42-55`) | userAction은 확인만(`egdesk-plan-tool-provider.mjs:25-26`, `egdesk-await-resume.mjs:56-57`) | M · 없음 |
| **RT-01** 배포 전 '새 PC 첫 실행' 점검이 명령 하나로 | 임시 프로필·no-remote·조용한 pref(web-ext `src/firefox/index.js:23-80`, `:307-315`, `preferences.js:16-98`) | 부품만(bootstrapQaProfile, launchQaFirefox) | M · 없음 |
| **RT-01·02** 설치마다 다른 로더가 깔리지 않게 고정 | fx-autoconfig `program/config.js:1-14`, `config-prefs.js:1-4`, `readme.md:15-31` | `scripts/install.sh`(HEAD를 고정 없이 clone) | S · 없음 |
| **RT-02** Firefox 따로 안 깔고 EG-Desk 설치 파일 하나로(1단계 개인·내부용) | 자체 빌드 비용(Zen `surfer.json`, `.github/workflows/macos-release-build.yml:49-169`), 재포장+policies, Node 동봉(SEA는 ESM·addon 제약) | 없음 | XL · D-R4 |
| **RT-02** 업데이트는 서명 확인 뒤에만, 실패하면 전체 받기 | 서명 manifest(tauri `plugins/updater/src/updater.rs:17`, `:86`, `:134`), 채널·hash·전체 받기(electrobun `Updater.ts:56-117`) | 없음 | L · D-R5 |
| **RT-04** 트레이·전역 단축키·터미널이 도우미 하나에서 | tray-icon `src/lib.rs:17-21`, global-hotkey `src/lib.rs:135-154`, portable-pty `pty/src/lib.rs:90-167` | helper-rust는 PTY 실험판, 기본은 node-pty | L · D-R6 |

---

## 3. 이미 만든 기능 대조 (keep / adjust / replace)

판정 기준: 레퍼런스와 같은 수준 이상이면 keep, 방향은 맞지만 빈 곳이 있으면 adjust, 방식 자체를 바꿔야 하면 replace.

### 3.1 바꿔야 하는 것 (replace)

| 영역 | 기능 | 이유 | 이어지는 채택 |
|---|---|---|---|
| Browser 카드 | 팝업 가로채기(installPopupCapture) | opener가 끊겨 postMessage로 끝나는 OAuth 실패, window.close 무효, 컨테이너 미상속, IDL과 반환형 불일치. 크기 지정 팝업은 아예 이 경로를 안 탐 | 2.2 BRW-03 안전망 + 팝업 카드 |
| Browser 카드 | 팝업 수동 시험 페이지 | 크기 지정·opener 메시지·스스로 닫힘·noopener·컨테이너 상속을 모두 빠뜨림 | 2.2 BRW-03 자동 시험 |
| 구독 | Claude 승인 통로 설계(MCP permission-prompt-tool) | 공식 SDK가 쓰는 stdio 통로로 AskUserQuestion도 같은 경로로 옴. MCP prompt tool은 '사용자 상호작용 필요' MCP 도구를 승인 못 함(공식 cli-reference) | 2.4 SUB-09 |
| 구독 | EG-Desk 도구를 Claude에 주는 설계(loopback HTTP MCP + Run 토큰) | 'sdk' MCP로 같은 파이프에서 처리, 포트·토큰·프로세스 불필요 | 2.4 SUB-10 |
| Agent | '선호 도구(표시용)' 칸 | 실행 효과 0건, 혼란만 줌. 폼에서 숨기고 필드는 호환용으로 저장소에 남김 | S2 |
| Board | 대화방 참여자 = 이름 문자열 | Profile·실행·상태와 연결 불가. 멤버 객체가 CHAT-10의 선행 조건 | 2.6 CHAT-10 |
| Canvas | 끌기·크기 조절 처리 6벌 | 맞춤·실행 취소·Board로 끌어 넣기·그룹 이동을 6곳에 각각 넣을 수 없음. 공통 helper 하나로 | 2.8 UX-05 |
| 코딩 | 줄 비교 lineDiff(`egdesk-file-service.mjs:88-99`) | 떨어진 두 곳을 고치면 사이 전체가 한 덩어리, 덩어리별 동작 불가. 반환 모양은 유지 | 2.10 CODE-05 |
| 코딩 | 활동 행의 명령 표시('command: …' pre 줄) | 개발용 키 이름이 화면에 그대로. 결과 카드·문장으로 | 2.10 CODE-06 |

### 3.2 고쳐 쓰는 것 (adjust)

| 영역 | 기능 | 고칠 점 |
|---|---|---|
| 브라우저 조작 | navigate 같은 사이트 제한 | 도구 검사는 Firefox 실제 PSL로 재확인해 레퍼런스보다 엄격. 클릭·리디렉트·팝업 경로만 이동 가드로 보강 |
| 브라우저 조작 | guarded fill / press(Enter implicit submission) | 기본값 유지. 리치 에디터는 BRW-10 2단계 trusted 입력 자리, Enter 제출은 BRW-11 제출 확인 게이트를 거치게 |
| 브라우저 조작 | scroll(문서 단위) | 스키마 그대로 두고 검증 규칙만 완화해 내부 스크롤 컨테이너 지원 |
| 브라우저 조작 | wait(load/idle/selector) | 리스 없음·met/not-met/unknown 구분은 레퍼런스보다 나음. wait_text와 settle 루프 추가 |
| 브라우저 조작 | 같은 출처 frame·열린 shadow·contenteditable | 닫힌 shadow root, WeakRef, cross-origin frame만 보강 |
| 브라우저 조작 | 민감 칸 탐지 | 이름 기반 규칙에 Luhn 카드번호 값 검사 추가, 스크린샷도 같은 규칙 |
| 브라우저 조작 | UI 전송(SSE·wire ID·deadline·180KB 상한) | 이미지는 별도 route, 마감은 남은 예산 방식 |
| 브라우저 조작 | 소유 fixture QA | nanobrowser 60여 개 시나리오(가림·대화상자·지연·결제 iframe·마스킹)를 참고해 fixture 추가(Apache-2.0, 출처 표기) |
| Browser 카드 | popupContextOptions | Gecko가 주는 openerOriginAttributes를 1순위 입력으로 |
| Browser 카드 | 카드 찾기 키(sourceRefKey) | 페이지 키와 계정 키 분리 |
| Browser 카드 | 로그인 완료 감지(URL 도착 + 라우터) | openerCardId 추가, 필요 시 스스로 닫힘 신호 |
| Browser 카드 | 툴바 상태 동기화·더보기 메뉴 | 툴바 role·aria-label·화살표·단축키·상태 시험 추가 |
| Browser 카드 | 카드 복제 | sourceRef와 userContextId 유지 |
| 컴퓨터 사용 | 물려받은 MCP 분류(NAME_RULES·TOOL_RULES) | `get_app_state|get_window_state|perform_secondary_action|select_text`, 설치 표식 `@oai/sky|com.trycua.driver|cua-driver` 추가 |
| 컴퓨터 사용 | 알 수 없는 상호작용 요청 거절 | computer 서버 elicitation만 허락 카드로, 나머지는 지금처럼 |
| 컴퓨터 사용 | options 문서 권고 순서 D→A→B(자체 adapter XL) | B를 'cua-driver 위에 입력권·표시·중지'(L)로, A' 선택지 추가(대표님 결정 뒤 문서 수정) |
| 구독 | Claude 엔진 행(고정 decisionPending) | 무해한 정적 조회(버전·로그인 상태)는 지금 표시, 연결 상태만 decisionPending |
| 구독 | Claude 출력 번역 | rateLimitType 보존, thread/started·egdesk/*는 어댑터가 startThread 결과·엔진 usage로 전달, control_* 줄은 전송 모듈이 먼저 소비 |
| 구독 | ChatGPT 사용 한도 정규화 | limitId가 'codex'가 아니면 무시, 창 길이 기본값을 planType으로 |
| 구독 | 설계: Claude 질문 건너뛰기 = deny | allow + 빈 answers로 |
| 구독 | codex 지원 버전 게이트 | 실험 스키마 기능은 정확한 집합 유지, 일반 채팅은 범위 정책(supported/untested/unsupported) |
| 구독·Agent | Profile 엔진·모델 저장 | 실행 우선순위에 넣기만 하면 됨 |
| Agent | 아바타(이모지·이니셜·6색) | 상태 표정은 상태 테두리로, 사진은 결정 대기(허용 시 512KB·재인코딩·자산 id 저장) |
| Agent | 예시 Agent 6종 | 원본 유지 + 복제해서 시작, 내용 교체는 결정 |
| Agent | 프로필 미리보기 | 저장값이 아니라 '지금 이 대화에서 실제로 가능한 것과 이유' |
| Agent | 묶음(.egdesk) 가져오기 때 Agent 처리 | 가져오자마자 activate(`egdesk-portable-service.mjs:632`) → 초안으로 넣고 '지침 확인 필요' 표시(실행 중 RT-03 작업과 조율) |
| Board | CHAT-13 하위 Agent 행 | thread/status/changed·별명·역할·최근 활동 받기 |
| Chat→Canvas | 결과 칩 묶음 | 줄 형식으로 |
| Chat→Canvas | 브리핑 단계 의견 → 초안 글자 | 의견을 기록으로, 초안에는 번호로 참조 |
| Canvas | Board 영역 표시 | 영역 통째로 옮기기, 새 Board 저장 시 제자리 묶기 |
| Canvas | 새 창 빈자리 배치 | opener 옆 단계를 앞에, 격자가 들어오면 24px 격자에 맞춤 |
| Canvas | 미니맵 Board 영역·겹친 지점 | 그리기 비용, 8개 제한·검색 없음 해결 |
| Canvas | 카드 최대화 | 엿보기/고정, 모든 유형 집중 보기, Esc 층, 접기 |
| Canvas | Board 열기 구조(projection 사본) | 지금 열린 창으로 만들 때·소속 바꿀 때는 기존 창 id 그대로(bindExisting) |
| 디자인 | DSN-02 팔레트 정리 | JS 인라인 레거시 8색이 시험 밖, 시험이 uc.js도 검사하게 |
| 디자인 | UX-03 한국어 문구 | Browser 카드 'Loading/Secure/Not secure/Local' 남음 |
| 디자인 | BRW-01 툴바 | role=toolbar·화살표·aria-disabled·aria-label·키보드 툴팁·상태 시험 |
| 디자인 | :focus-visible 49개 | 토큰 하나로 묶고 약한 검색칸 포커스(42%·50%) 올림 |
| 디자인 | Dock·라디오·탭 | ARIA 역할은 있는데 약속된 키보드 동작이 없음 |
| 코딩 | 파일 이름 검색 | app-server fuzzyFileSearch, BFS는 대체 경로 |
| 코딩 | review() 비교 화면 | CodeMirror 전엔 EGDeskDiffView, 뒤엔 unifiedMergeView |
| 코딩 | '검사' 버튼 | 프로젝트 스크립트·터미널·결과 카드에 연결 |
| 코딩 | 에이전트 파일 변경 표시(경로만) | 기록·SSE엔 넣지 않고 화면이 요청할 때만 상한을 두고 diff |
| 코딩 | 승인 카드 | '변경 보기' 펼침, 덩어리별은 적용 후 검토로 |
| 코딩 | 활동·결과의 파일 열기(file:// Browser 카드) | 프로젝트 안이면 파일 창 해당 줄로 |
| 런타임 | 작업 기록 저장 방식 | SQLite 하나로 |
| 런타임 | 사용자 행동 대기(userAction) | 선택지·짧은 답 |
| 런타임 | Desk 복구 세대 | 짧은 간격 자동 저장 묶기, 대화 전문 중복 제거 |
| 런타임 | Board 불변 버전·충돌 | 카드 단위 3방향 병합 |
| 런타임 | '왜 붙었나' 기록 | 보낸 뒤 바뀐 자료 알림 |
| 런타임 | 설치 스크립트 로더 받기 | 커밋 dfdab56(2026-07-23) 고정 |
| 런타임 | 깨끗한 프로필 점검 부품 | 생성→실행→확인→종료→기록을 잇는 명령 하나 |

### 3.3 그대로 두는 것 (keep, 요약)

- **브라우저 조작**: 관찰 1회당 행동 1회·callId 지문·결과 미확정이면 카드 잠금(레퍼런스 중 가장 엄격한 쪽과 같은 수준, REA EG-01과 일치), 카드별 행동 리스, guarded click=target.click(Desk 조건에서 맞음, 효과 없을 때만 BRW-10 2단계), Agent 활동 배지·타임라인·일시중지(입력값 비노출).
- **Browser 카드**: 계정 전환 어댑터 EGDeskBrowserIdentity.switchCardContext(레퍼런스와 같은 교체 방식, 폼 보호까지 — 연결만 안 됨), 최상위 위치 변화 감지.
- **컴퓨터 사용**: 끄기 스위치와 readback, 활동 배지·사용 횟수(원문 미기록), 설정 영속화(0600·원자적 교체), Browser 카드 lease와 행동 직전 재확인(host-lease에 그대로 옮김).
- **구독**: 실행 엔진 계층(EngineAdapter + Registry, 내부 기준=Codex app-server 어휘), Codex 어댑터 pass-through, Claude 오류 분류(공식 api_retry 목록과 일치), ChatGPT 계정 정규화(토큰 미접근), 엔진 칩·대화별 엔진 잠금.
- **Agent**: Profile 저장소(불변 revision·해시 binding — 참고 대상 중 유일), developerInstructions 합성(남은 일은 비전 문서·CHAT_AGENT_PROFILE_RUNTIME.md의 'envelope' 설명 갱신뿐), 5축 도구 상한 집행과 시작 뒤 readback, Agent 관리 탭, '[···] Agent 작업 중' 버블.
- **Board**: 하위 Agent 권한 경계(저절로 넓어지지 않음), 작업 버블, 프로필 미리보기 진입점, 작업 그래프 상태·기다림 조건(A2A와 맞먹음), 활동 기록 버튼 '막힘 N건'.
- **Chat→Canvas**: '카드로 보기' 결과 카드, 긴 답변 접기, Answer Briefing 핵심(사람 주도 이동), 도형 7종, Browser 대상 마커, CHAT-11 Board 표기(원장만 '일부'로 남음).
- **Canvas**: 화면에 보이는 Board 감지(순위 규칙), 도형·펜(펜 품질은 quickdraw freehand.js 선택지), 화면에 보이는 영역 판정 함수(새로 만들지 않고 재사용).
- **디자인**: 다크 토큰, color-scheme 범위 지정, 동작 줄이기(CSS·카메라), 글자 확대 시 높이 증가, 아이콘 SVG aria-hidden, Firefox chrome 변수 비의존(--egd-*만 — Firefox 152의 변수 이름 대거 변경에도 안전), Agent 표시층 aria-hidden.
- **코딩**: 파일 트리(opaque id·접근성), 작업사본·조건부 기록·한글 조합 보호, 파일 감시(helper), cwd 배관, 이전 조사 결론(CodeMirror 6 + merge + jsdiff).
- **런타임**: 작업 그래프·대기 조건·자동 시작, bridge 재시작 뒤 사람이 이어가기 누름(Codex 턴은 재실행 결과가 달라지므로), 같은 대화 재개 큐(enqueue), 메모리 이벤트 버스, 자료 후보 해석기, .egdesk 형식(무결성·암호), 내보내기 정리(계정·비밀 제거), 파일 감시, 터미널 PTY(결정 전 현행 유지).

---

## 4. 구현 묶음

### 4.1 나누는 규칙

- **1차(17개)는 서로 파일이 겹치지 않는다.** 바로 동시에 띄울 수 있다. 각 묶음은 자기 소유 파일만 고친다.
- **화면 파일은 '화면 차례' 한 줄로만 고친다.** `overlay/JS/eg-desk-surface.uc.js`(18,002줄), `overlay/CSS/eg-desk-surface.uc.css`, `EGDeskChatState.sys.mjs`, `EGDeskSurfaceState.sys.mjs`, `scripts/egdesk-surface-state.test.mjs`는 S1 → S2 → … → S10 순서로 한 번에 한 묶음만 소유한다. 다른 묶음은 화면에 넣을 내용을 **새 모듈**(`overlay/resources/EGDesk*.sys.mjs`)이나 **helper 계약**으로 만들어 넘기고, 화면 차례 묶음이 연결한다.
- **2차(helper 10개)는 대표님 결정과 1차 머지 뒤에 시작한다.** 2차끼리도 파일이 겹치지 않는다. 1차의 같은 파일 묶음이 머지된 뒤 시작한다(표의 '선행').
- **실행 중 작업과 겹치는 파일**: overlay/*, `scripts/egdesk-surface-state.test.mjs`, `helper/egdesk-chat-store.mjs`·`egdesk-desk-store.mjs`(Board 맥락 후보 화면), `helper/codex-bridge-server.mjs`·`egdesk-portable-*.mjs`(휴대용 묶음), `helper/codex-chat-runtime.mjs`·`codex-computer-control*.mjs`(컴퓨터 조작 사용 기록).
- **공통 규칙**: 기존 Browser 도구 inputSchema는 바꾸지 않고 새 도구를 추가한다(새 도구는 새 대화부터 보임). 응답 크기 상한 3곳(bridge-server `:690` 190000B, transport `:111`, runtime `:276` 180000자)은 늘리지 않는다. Firefox·headless·전체 테스트 실행은 Main 허락이 있을 때만(RAM). 입력값·화면·토큰 원문은 기록하지 않는다. 레퍼런스 코드를 옮기면 0장 라이선스 규칙대로 고지를 남긴다. 시험 명령은 `cd /Users/minsoocha/Projects/EG-Desk-Dev-Space && node --test <파일>`.

### 4.2 1차 묶음 (결정 없이 지금)

| 묶음 | 대표님이 보게 될 결과 | gap | 소유 파일(요약) | 크기 | 실행 중 작업과 충돌 |
|---|---|---|---|---|---|
| **1-A** 브라우저 조작 정확도·대기·시간 초과 확인 | Agent가 div 버튼·내부 스크롤·웹 컴포넌트를 잡고, 무엇이 가렸는지 말하고, 행동 뒤 알맞게 기다리고, 시간 초과돼도 다시 누르기 전에 확인 | BRW-06, 08(관찰), 12 | Browser actor Child·Parent, egdesk-browser-tool-runtime, codex-browser-tool-provider·transport, fixture-qa, guard 시험 | L | overlay/resources(Child·Parent) — git 상태상 수정 중 아님, Main 확인 |
| **1-X** 브라우저 이동 정책·위험 행동 분류 모듈 | (결정 뒤) 허용 밖 사이트 차단·결제/제출 확인의 두뇌가 미리 준비됨 | BRW-05, 11 준비 | 새 egdesk-browser-url-policy, egdesk-browser-action-classifier | M | 없음 |
| **1-B** 팝업 로그인 이어 가기 helper·팝업 회귀 시험 | 팝업에서 끝난 로그인이 원래 카드의 대기를 풂, 팝업 흐름을 자동 시험 | BRW-04, 03(시험) | egdesk-event-bus, egdesk-await-router, 새 verify-firefox-mcp-browser-popups, popup-test.html | M | popup-test.html(overlay/*) |
| **1-H** 컴퓨터 사용 기반 부품 | (다음 단계에서) 사람이 쓰는 중이면 Agent가 기다리는 규칙과 Mac 앱 조작 도구 계약이 준비됨, 물려받은 컴퓨터 도구 분류 보강 | CU-02, 03, 06 | 새 egdesk-host-lease, egdesk-computer-adapter, codex-inherited-mcp | M | 없음 |
| **1-R** Codex 런타임 신호 받기 | 하위 Agent 실제 이름·막힘, Agent 모델이 쓰임, 바뀐 줄·명령 출력을 화면이 요청할 수 있음, 컴퓨터 조작 기록, 파일 바뀜 알림이 화면까지 옴 | CHAT-13, AGENT-08·02, CODE-05·06·03, CU-01 | codex-chat-runtime, codex-bridge-http, codex-chat-tool-ceiling, codex-bridge-sse | L | codex-chat-runtime.mjs |
| **1-E** 로그인·엔진 상태 helper | Claude 로그인 상태 감지, 코드 입력 로그인, 버전 범위, 한도 표시가 모델별 버킷에 덮이지 않음 | SUB-08, 04, 13, 03·14 | codex-bridge-server, engine-registry, 새 claude-engine-auth, native-capabilities, codex-engine-adapter, codex-account-usage | M | codex-bridge-server.mjs |
| **1-C** Claude 연결 준비 부품 | (D1 뒤 바로 연결) 질문·승인 변환, EG-Desk 도구 제공, 5시간/주간 한도 구분 | SUB-09, 10, 14 | 새 claude-engine-permissions, egdesk-claude-mcp, claude-stream-translate, engine-adapter-design.md | M | 없음 |
| **1-P** Agent 정의 저장소 보강 | 복제해서 새로 만들기·출처, 예시 대화·하지 말 것이 지침에 들어감 | AGENT-02, 06 | egdesk-profile-store, egdesk-profile-http | M | 없음 |
| **1-O** 결과 게시·브리핑 helper | Agent가 'Canvas 결과'로 내보내는 도구, 브리핑 근거 여러 개, 단계 의견 저장 | CHAT-08, 05, CNV-07 | egdesk-context-runtime·store·http, EGDeskBriefingState, 새 briefing 시험 | L | EGDeskBriefingState(overlay/*) — Main 확인 |
| **1-L** Canvas 배치·미니맵·Esc 계산 모듈 | (화면 연결 뒤) 맞춤·실행 취소·정리·미니맵 검색·가장자리 점·Esc 순서·접기의 계산 | UX-05, 02, 06, CNV-02, 03 | 새 EGDeskCanvasLayout, EGDeskLayerStack + 시험 | M | 없음(새 파일) |
| **1-N** AI 표식·메모 상태 모듈 | (화면 연결 뒤) 카드 위 표식 제안·받기·저장, 메모와 답글의 데이터 | CNV-05, 06 | 새 EGDeskAnnotationState, EGDeskMemoState + 시험, AI_CANVAS_ANNOTATION_LAYER.md | M | 없음(새 파일) |
| **1-F** 키보드 이동·툴팁 모듈과 대비 검사 | (화면 연결 뒤) 툴바·라디오·탭 화살표 이동, 키보드 툴팁, 색 대비 자동 검사 | BRW-01, DSN-04, 03 | 새 EGDeskFocusNavigation, egdesk-design-tokens + 시험 | M | 없음 |
| **1-Q** QA 실행 스위치·첫 실행 점검·로더 고정 | 다크·동작 줄이기·고대비 검증을 명령 한 줄로, 새 PC 첫 실행 점검, 설치 결과 고정 | RT-01, DSN-01·04 | run-firefox-mcp-target, headless 회귀, 새 verify-clean-profile-boot, install.sh·bat, PATH_1_5 문서 | M | 없음 |
| **1-D** 바뀐 줄 보기·실행 결과 해석 부품 | (화면 연결 뒤) −/+ 줄 비교, '12 통과 · 1 실패'와 실패 위치 | CODE-05, 06 | 새 EGDeskDiffView, EGDeskRunResult, vendor/jsdiff, VENDOR.md + 시험 | M | 없음(새 파일) |
| **1-G** git 변경·검색·상태와 파일 창 '변경' 탭 | 파일 창에서 '커밋 안 한 변경' 목록과 내용, 이름·내용 검색 전환(결과를 누르면 그 줄), 트리에 수정·새 파일·삭제 표시 | CODE-05, 03 | 새 egdesk-git-review, egdesk-file-service, egdesk-file-http, EGDeskFileView(모듈) | M | EGDeskFileView(overlay/*) — git 상태상 수정 중 아님 |
| **1-W** 작업 기록 SQLite·선택지 대기 | 기록이 쌓여도 느려지지 않음, Agent가 선택지로 묻고 고른 답이 다음 단계로 | RT-07, CHAT-06 | 새 egdesk-workflow-store, task-store·plans·sources·native-store, workflow-runtime, task-graph, plan-tool-provider, await-resume, task-http | M | 없음 |
| **S1** 화면 1차: Browser 카드와 Agent 얼굴 | 팝업 창 안전망, 팝업 차단 표시, 툴바 키보드·이름·한국어 상태, 시간 초과 확인·확인 창 감지 화면, Browser 배지에 Agent 이름, Agent 상태 묶음, 하위 Agent 행, 방 목록 아바타·대비 | BRW-01·03·04·12, AGENT-05, CHAT-13, DSN-02·04, UX-03 | 화면 파일 5개 + 관련 시험 3개 | L | overlay/*, egdesk-surface-state.test.mjs |

### 4.3 화면 차례 (S2 ~ S10)

| 묶음 | 결과 | 선행 | 결정 |
|---|---|---|---|
| **S2** Agent 만들기·계정·로그인·컴퓨터 조작 창 | 복제·예시 대화·하지 말 것 입력, 선호 도구 숨김, 계정 칩 popover·로그아웃 경고, 코드 입력 로그인, Claude 상태 줄·버전 표시, '컴퓨터 조작' 창 1단계 | S1, 1-P, 1-E, 1-R | 없음 |
| **S3** Chat 결과·브리핑·변경 보기 화면 | 결과 줄, Agent가 게시한 결과 칩·버전, 다중 근거 강조·흐리게, 의견 저장·배지, 브리핑 화면 정리·미니맵 단계, 승인 카드·활동 행 '변경 보기', 테스트·빌드 결과 카드, 파일 창 자동 갱신 연결, 선택지 대기 버튼 | S2, 1-O, 1-D, 1-R, 1-W | 없음 |
| **S4** Canvas 미니맵·Esc·접기·집중 보기 | 미니맵 SVG·검색·가장자리 점, Esc 층, 접기, 모든 유형 집중 보기, opener 옆 배치, Board 제목줄 끌기 | S3, 1-L | 없음 |
| **S5** 디자인 토큰 CSS·키보드·툴팁 | 포커스·비활성 토큰, 고대비·대비 증가, 검색칸 포커스, Dock·라디오·탭 화살표, 키보드 툴팁 | S4, 1-F | 없음 |
| **S6** 브라우저 결정 반영 화면 | 대화 단위 조작 허락 배지·확인 카드, 다중 카드, 팝업 카드, 카드별 계정, 사이트 계정 기억, 캡처 dispatch, 이동 가드 설치, iframe actor | S5, 2-BH | D-B1~B12 |
| **S7** Canvas·Board 결정 반영 화면 | Board 소속·제자리 묶기·끌어 넣기 제안, 맞춤·실행 취소·정리, 채팅 엿보기, AI 표식 레이어·메모 카드, 상단 검색 요청 | S6, 1-L, 1-N | D-V1~V6, D-K1·K2·K5 |
| **S8** Board 대화방 화면 | 멤버 칩·상태 요약, @ 자동완성·라우팅, Lead 계획 담당 표시, 메시지 보내기·안내 줄, '나를 불렀어요', 하위 Agent 개입 버튼 | S7, 2-R, 2-RT, 2-M | D-M1~M4 |
| **S9** 컴퓨터·엔진·Agent 결정 반영 화면 | 컴퓨터 허락 카드·범위 카드·긴급 중지 버튼, Claude 엔진 화면·로그인 버튼·종량 배지·한도 버튼, Agent 프리셋·'지금 할 수 있는 것'·파일 가져오기·사진 | S8, 2-CH, 2-E, 2-P, 2-R | D-C*, D-S*, D-A* |
| **S10** 코딩·저장·디자인 결정 반영 화면 | 프로젝트 칩·'변경' 탭 연결·IDE Dock·결과 카드·원본 저장, 방별 Agent 복원, 묶음 패널, Board 병합 화면, 대화 전문 빼기, 화면 모드·크기 토큰 | S9, 2-X, 2-RT | D-X*, D-R*, D-G* |

S2~S5는 결정이 필요 없으므로 Main이 순서를 바꿔도 된다. 화면 차례가 길어지는 것이 전체 속도의 병목이다. Main이 판단할 선택지로, 1차가 끝난 뒤 `eg-desk-surface.uc.js`의 Browser 카드 구역과 Chat 활동 구역을 별도 모듈로 떼는 정리 작업을 하면 화면 차례를 두 줄로 나눌 수 있다(실행 중 작업이 끝난 뒤에만).

### 4.4 2차 helper 묶음 (결정 뒤)

| 묶음 | 결과 | 선행 | 결정 |
|---|---|---|---|
| **2-BH** 브라우저 2차 helper·actor | 스크린샷(가림·거부), trusted 클릭(착지 가드), 이동 가드 모듈, 대화 권한 게이트·확인 단계, 다중 카드 runtime, iframe 관찰·조작, Agent 표식 제안 도구 | 1-A, 1-X | D-B1~B6, D-K1 |
| **2-CH** 컴퓨터 사용 2차 | cua-driver provider, A' 브로커, 컴퓨터 동적 도구, 앱 범위, Swift 감시 프로세스·긴급 중지(Node 쪽) — 2026-10-24 결정 반영: cua-driver provider 대신 자체 Rust 도우미 provider(D-C1), A' 브로커는 D-C2 미결정이라 보류, 감시 프로세스는 REA 결정 8 (나)에 따라 Rust 도우미 쪽 | 1-H | D-C1, C2, C4~C8 |
| **2-R** 런타임 2차 | 컴퓨터 허락 질문 연결, 입력권 checkpoint, 컴퓨터 도구 등록, 방별 Agent 기록 호출, 실제 허용 설명, Board 멤버 대화, 하위 Agent 개입, 공유 메시지 블록, 설명으로 초안 | 1-R | D-C3, D-M1~M3, D-A1, D-A6 |
| **2-E** 엔진 2차 | Claude 실행 연결(전송·어댑터), 격리 플래그, 로그인 버튼 helper, 계정별 저장소, API 키 프로필, 한도 복구, bridge 등록 줄(이미지 route·컴퓨터 provider·프로젝트 폴더) | 1-E, 1-C | D-S1~S6 |
| **2-P** Agent 2차 | Agent 파일 가져오기·내보내기, 새 Agent 기본 도구 범위 저장, 사진 아바타 | 1-P | D-A1~A3 |
| **2-X** 코딩 2차 | 프로젝트 폴더, 원본 저장, CodeMirror, 덩어리별 검토, 프로젝트 명령, 엔진 공통 변경 모양, git checkpoint | 1-D, 1-G | D-X1~X6 |
| **2-RT** 저장·묶음·Board 검색 | 스키마 이전, JSON Canvas, 자동 저장 묶기, Board 검색 색인, 가져온 Agent 초안, chat-store v3(방별 Agent + Board 참여자), 자산 포함, 카드 단위 병합·대화 전문 빼기 순수 로직 | 실행 중 작업 머지 | D-R1, D-R3(일부) |
| **2-CTX** 자료 맥락 2차 | 보낸 뒤 바뀐 자료 표시, 추천 제외 목록·모드, 관련 Board 후보 | 1-O, 1-W | D-R2(제외·모드만) |
| **2-M** 작업 흐름 2차 | Lead 계획 단계 담당 Agent·종합, 팝업 닫힘으로 로그인 끝남, 한도 초기화 대기 조건, 트레이 단축키 이벤트 | 1-W, 1-B | D-M2, D-M4, D-B11, D-S5 |
| **2-PK** 패키징·업데이트·트레이 | 설치 파일 하나(재포장 시험판), 서명 업데이트, 트레이·전역 단축키 | 1-Q | D-R4~R6 |

### 4.5 묶음별 요약 (작업자 지시의 뼈대)

작업자에게 넘길 전체 지시문(참고 레퍼런스 경로·파일:줄, 우리 파일, 바꿀 것, 시험 명령, 라이선스 주의)은 Main이 가진 batches 목록에 같은 내용으로 있다. 여기서는 사람이 읽기 위한 요약만 둔다.

- **1-A**: Child에 cursor:pointer·onclick 후보(예산 안), 내부 스크롤 컨테이너 role 'scrollable'과 컨테이너 scrollBy, openOrClosedShadowRoot 우선, nodeByRef를 WeakRef로, 가린 요소 설명과 label↔control 동치, 뷰포트 교집합 중심. 고정 250ms를 settle 루프(100ms 관찰, 500ms 조용하면 끝, 상한 1500ms)로, receipt에 settle(경로만, 쿼리 '?…'). 새 도구 `egdesk_browser_wait_text`(읽기 전용, 리스 없음). transport·runtime이 budgetMs 전달, 'reconcile' 요청 kind와 `dispatched: true|false|'unknown'`. 런타임이 가져다 쓸 수 있게 도구 분류 목록을 내보낸다(1-R과 계약). 화면 쪽(reconcile 응답, hop 기록, 대화상자 감지)은 계약만 정해 S1에 넘긴다.
- **1-X**: nanobrowser url-policy·navigation-guard와 stagehand domainPolicy 패턴으로 `evaluateNavigation(url, policy)`(정확 일치·'*.'·차단 우선·위험 스킴 차단·판단 실패 시 차단), nanobrowser classify 패턴으로 `classifyAction({label, role, form, implicitSubmission})` → pay/grant/delete/submit/none(한국어 어휘 포함, 오탐 쪽으로 기울임). 둘 다 순수 함수, 기본값은 지금 동작(같은 사이트).
- **1-B**: event-bus·HTTP 검증이 `openerCardId`(선택)를 허용, await-router는 gate.cardId가 payload.cardId 또는 openerCardId와 같으면 일치. 팝업 회귀 시험 스크립트(127.0.0.1 사이트 + localhost 가짜 로그인 제공자, 5개 시나리오), popup-test.html에 크기 지정 팝업 버튼.
- **1-H**: `createHostLease({now, lockPath, userIdleSeconds, guardAlive})` 상태기계(ready|user|ai|unavailable), begin·checkpoint·end·revoke, epoch, 기기 잠금 파일 stale 판정, DIRECT/POSSIBLE/OTHER 분류(모르는 도구는 DIRECT) — 가짜 시계 단위 시험. `egdesk-computer-adapter.mjs` provider 인터페이스(capture·click·typeText·key·scroll·drag·listApps·listWindows → effect/route/delivery/evidence/summary)와 가짜 provider. 분류 보강 정규식.
- **1-R**: `thread/status/changed` 허용 → subAgents 행 갱신(waiting approval/question/systemError), 처음 보는 child는 `thread/read`로 agentNickname·agentRole, child item 요약 최근 3개. resolveProfile이 model 반환, threadOverrides 우선순위(요청 > 방 > Agent > 기본). fileChange diff·turn diff 보관(메모리, 파일당 256KB·회차당 1MB)과 명령 출력 링버퍼(앞 8KB + 끝 64KB), 화면이 요청하는 `/chat/run-changes`·`/chat/command-output`. `computer.action` SSE(메타데이터만). Browser 도구 목록을 1-A가 내보낸 목록에서 가져오게 바꿈. error origin을 엔진 id로.
- **1-E**: `/auth/start {mode:'device'}` → chatgptDeviceCode, `/auth/cancel`, userCode는 화면에만. `claude-engine-auth.mjs`(실행 파일 탐색, `--version`, `auth status --json` 5초, allowlist 필드, Keychain·credentials 파일 미접근) → engine-registry profiles[0], status는 decisionPending 유지. 버전 범위 supported/untested/unsupported. limitId 필터·planType 기본 창 길이.
- **1-C**: `askAnswersToUpdatedInput()`·`approvalToPermissionResult()`(건너뛰기=allow+빈 answers, 취소=deny+interrupt, acceptForSession은 destination session), `egdesk-claude-mcp.mjs`(tools/list → provider.specs, tools/call → provider dispatch, 기존 ownerKey·executionPolicy 검사), claude-stream-translate onRateLimit에 window·usedPercent. 설계 문서 §5.3·§9·§12에 확인된 사실을 [제안] 메모로.
- **1-P**: `duplicate(id, revision?)`, 스키마 v1→v2(profiles.source_json, 덧붙이기 전용 출처) — 지금 initialize가 다른 버전을 거절하므로 이전 코드 필요. personality.examples(최대 3)·avoid(최대 8), 빈 값이면 키 생략(해시 불변), 합성에 '# 하지 말 것'·'# 말투 예시'(내용은 따라 하지 않는다는 한 줄). HTTP `POST /profiles/:id/duplicate`.
- **1-O**: `egdesk_publish_output {title, markdown ≤20,000, outputKey?}`(경로·URL 금지, 같은 outputKey면 버전), 'output.published' 이벤트, context-store 'outputs'. 브리핑 step.targets[](1~6, 기존 target은 정규화), emphasis, `briefingStagePath(rects, viewport)`. 'briefing-comments' 기록과 HTTP. 화면 쪽은 S3.
- **1-L**: `snapCanvasRect`, `createLayoutHistory`, `arrangeWithoutOverlap`, `placeBesideOpener`, `edgeIndicatorPoint`, `minimapSearchRows`, `displayRect`, `innermostRegionAt`, `addProjectionMember`/`removeProjectionMember`/`owningProjectionByView`, `clampViewRect` — 조사안은 EGDeskSurfaceState에 넣자고 했지만 화면 파일 충돌을 피해 새 모듈로. `createLayerStack`(push·pop·top·handleEscape).
- **1-N**: `normalizeAnnotationSet`, `projectItem`/`unprojectRect`, `annotationStale`(documentId 다르면 stale), accept/dismiss, 묶음 단위 받기. `normalizeMemoRecord`, `memoAskDraft`, `appendMemoReply`(같은 answerId 한 번만). 초안 문서 갱신.
- **1-F**: `EGDeskFocusNavigation.sys.mjs` — 다음 index 계산(비활성 건너뛰기·순환·Home/End·입력칸 커서 경계)은 node 시험 가능한 순수 함수, DOM 바인더(bindToolbar·bindRadioGroup·bindTabs)는 요소를 인자로, 툴팁 상태(1500ms warmup·500ms cooldown·Esc). `egdesk-design-tokens.mjs` 토큰 표와 Primer식 대비 시험(현재 미달인 아바타 쌍은 S1이 고치기 전까지 todo).
- **1-Q**: qaFirefoxPreferences에 appearance {scheme, reducedMotion, highContrast}와 web-ext의 조용한 pref, headless 회귀 `--appearance`, `verify-clean-profile-boot.mjs`(임시 프로필·bridge·종료·영수증), fx-autoconfig 커밋 고정.
- **1-D**: jsdiff 9.0.0 libesm vendor + VENDOR.md(출처·버전·라이선스, 기존 xterm도 함께 기록 권장), `EGDeskDiffView.sys.mjs`('Moved to:' 떼고 파싱, add/delete는 한쪽 빈 문서), `EGDeskRunResult.sys.mjs`(명령 분류, 러너별 요약 수, VS Code terminalLinkParsing 포팅 — MIT 머리말 유지, 스택 첫 프로젝트 프레임), 러너 출력 fixture.
- **1-G**: `egdesk-git-review.mjs`(execFile, shell 없음, `GIT_OPTIONAL_LOCKS=0`, `-c core.fsmonitor=false`, diff-index plumbing, porcelain v2 status). search 개선(기본 무시 목록, app-server fuzzy는 2-E 연결 뒤), `searchContents`(git grep 또는 1MB 이하 텍스트), HTTP 라우트. EGDeskFileView 모듈에 '변경' 탭(범위 칩: '커밋 안 한 변경', 1-R 뒤 '이번 회차'), 이름/내용 검색 전환과 결과 줄 이동, 트리 상태 글자, `onFileChanged(event)` 진입점(250ms 모아 해당 폴더만 다시 목록) — uc.js 쪽 이벤트 연결은 S3.
- **1-R 추가 항목**: 파일 감시가 버스에 내는 `file.changed {rootId, relativePath, change}`를 소유 범위 확인 뒤 chat SSE로 중계(버스 구독 지점이 codex-bridge-server.mjs에 있으면 1-E와 한 줄 조율).
- **1-W**: `egdesk-workflow-store.mjs`(node:sqlite, WAL·FULL·quick_check·user_version, task_events는 UPDATE·DELETE 금지 트리거), openTaskStore 인터페이스 유지, 기존 JSON 4개 1회 가져오기(원본 보존). 게이트 response {choice 최대 6 | text ≤500}, `/tasks/continue`가 answer 검증(비밀처럼 보이면 거절), await-resume 문구.
- **S1**: boot() 맨 앞 팝업 창 판별(`window.toolbar.visible === false` 또는 chromehidden에 'toolbar')이면 overlay를 만들지 않음, DOMUpdateBlockedPopups 표시, 툴바 role·aria-label·aria-disabled(+1-F 바인더), 'Loading/Secure' 한국어화(종류 키 분리), messagemanagergroup(직접 확인 후 문제 있으면 되돌림), reconcile·hop·대화상자 화면 쪽, Browser 배지에 Agent 이름·얼굴, `agentPresenceRollup`과 얼굴 테두리, 하위 Agent 행 역할·막힘·최근 활동, reporter.location openerCardId, 방 목록 아바타 Agent 팔레트, 아바타 tone-2·3 대비 교정.

---

## 5. 결정이 필요한 것

권고안을 먼저 적었다. 결정 전에도 진행할 수 있는 부분은 '결정 전 가능'으로 표시했다.

**2026-10-24 대표님 결정**: 권고안을 모두 채택했다. 다만 D-S1(Claude 연결), D-C1(Mac 앱 조작: 자체 Rust 도우미), D-C4(실제 화면 시험: 관찰 전용부터)는 따로 정했다. 각 행 권고 칸 끝에 '결정: …(2026-10-24)'로 표시했다. 아직 정하지 않은 것: D-B10, D-B11, D-C2, D-A1, D-A5, D-A6, D-K2, D-K3, D-G4, D-X5, D-R2, D-R4~R6, D-L2. 같은 결정이 원장 '대표님 결정이 필요한 것' 표, rea-mechanism-adoption 6장, computer-use-options 5장에도 있다.

### 5.1 브라우저 제어

| ID | 질문 | 선택지 | 권고 | 막히는 묶음 |
|---|---|---|---|---|
| D-B1 | BRW-05 Agent가 맡은 카드에서 갈 수 있는 사이트 범위 | (가) 같은 사이트만 (나) 대화마다 대표님이 허용 사이트 추가 (다) 모든 http(s)에 차단 목록만 | (가) 기본 + (나)로 넓힘. 링크 클릭·리디렉트에도 같은 규칙 적용 여부도 함께 → **결정: 권고대로 (가) 같은 사이트 기본 + 대화마다 (나) 허용 사이트 추가, 링크 클릭·리디렉트에도 같은 규칙(2026-10-24)** | 2-BH, S6 (1-X는 결정 전 가능) |
| D-B2 | BRW-07 Agent가 직접 연 새 카드의 조작 권한 | (가) 허용 사이트 안이면 같은 Run 권한 자동 승계 (나) 매번 사람이 허용 | (가). 페이지가 연 팝업은 보고만, 사람이 연 카드에는 자동으로 안 줌(카드 조사 결정 7과 같음) → **결정: (가). 페이지가 연 팝업은 보기만, 사람이 연 카드에는 자동 부여 없음(2026-10-24)** | 2-BH, S6 |
| D-B3 | BRW-11 조작 허락의 수명 | (가) Run 단위(현재) (나) 같은 대화 동안 | (나). 카드·계정·사이트 변경, 일시중지·철회·유휴 시 만료. 결제·권한 부여(OAuth 동의)는 늘 대표님, 제출·삭제는 확인 후 → **결정: (나) 같은 대화 동안. 만료·결제·OAuth 동의·제출·삭제 조건은 권고대로(2026-10-24)** | 2-BH, S6 |
| D-B4 | BRW-10 사람이 누른 것과 같은 진짜 클릭 허용 | (가) 허용 안 함 (나) 일반 클릭이 효과 없을 때만 새로 관찰한 뒤 1회, 착지 가드 | (나). 페이지 포커스가 움직일 수 있음. 키보드 trusted 입력은 2단계로 따로 → **결정: (나) 일반 클릭이 효과 없을 때만 새로 관찰 뒤 1회 + 착지 가드, 별도 도구. 키보드 trusted 입력은 2단계(2026-10-24)** | 2-BH |
| D-B5 | BRW-08 다른 사이트 iframe(결제·로그인) 안 조작 범위 | (가) 보기만 (나) 보기+클릭 (다) 비밀 아닌 칸 입력까지 | (나). 비밀 칸은 어느 경우든 대표님 단계 → **결정: (나) 보기+클릭. 비밀 칸은 늘 대표님(2026-10-24)** | 2-BH, S6 |
| D-B6 | BRW-09 카드 스크린샷을 모델 제공자(OpenAI, 앞으로 Anthropic)에 보내는 범위 | (가) 조작 허용 카드만 (나) 관찰 허용 카드도 (다) 매번 확인 | (나). 비밀 칸·읽지 못한 창은 가리고, 가리기에 실패하면 보내지 않음 → **결정: (나) 관찰 허용 카드도 전송. 비밀·민감 칸, 다른 사이트 iframe(REA 결정 3), 읽지 못한 창은 가림, 가리기 실패면 보내지 않음(2026-10-24)** | 2-BH, S6 |
| D-B7 | BRW-03 로그인 팝업을 어떻게 보여 줄까 | (가) Desk 안 '팝업 카드'(원래 카드 옆, 끝나면 저절로 닫힘, L) (나) 작은 Firefox 팝업 창(S, 호환성 최고, Desk 밖) | (나)의 안전망을 먼저(S1, 어느 쪽이든 필요), 그다음 (가) → **결정: (나)의 안전망 먼저, 그다음 (가) 팝업 카드(2026-10-24)** | S6 |
| D-B8 | BRW-02 계정을 나누는 단위를 Firefox 컨테이너로 확정 | 컨테이너(카드마다 지정 가능) / 별도 프로필(프로세스 단위라 카드별 불가) | 컨테이너 → **결정: 컨테이너(2026-10-24)** | S6 |
| D-B9 | BRW-02 같은 페이지가 다른 계정 카드에만 열려 있을 때 | 같은 계정이면 그 카드로, 다른 계정이면 '이동 / 이 계정으로 새로 열기' 묻기 | Firefox 방식 → **결정: Firefox 방식(2026-10-24)** | S6 |
| D-B10 | BRW-02 '이 사이트는 항상 이 계정으로' 기억 위치와 기본값 | 개인(이 PC) / Desk 공유, 처음 기본값 '묻기' 여부 | - → **아직 정하지 않음(2026-10-24 기준)** | S6 |
| D-B11 | BRW-04 로그인 팝업이 스스로 닫히면 로그인 끝남으로 보고 이어 갈까 | 이어 감 / 콜백 URL 도착만 인정 | - (로그인 실패로 닫혀도 이어 갈 수 있다는 단점) → **아직 정하지 않음(2026-10-24 기준)** | 2-M |
| D-B12 | BRW-14 실제 사이트 검증 범위 | 사이트·계정 범위 | 로그인 불필요·읽기 전용 공개 사이트 5~10개(Online-Mind2Web에서 구매·CAPTCHA 제외) → **결정: 공개·로그인 불필요 사이트 5~10개(2026-10-24)** | S6 |

### 5.2 컴퓨터 사용

| ID | 질문 | 권고 | 막히는 묶음 |
|---|---|---|---|
| D-C1 | Q3 장기 방향: Mac 앱 조작 부품을 직접 만들까(XL, 권한을 EG-Desk가 받음), cua-driver(MIT)를 EG-Desk 안에서 띄울까(L) | cua-driver. 대신 권한은 'CuaDriver' 앱에, 제3자 바이너리라 버전 고정, macOS 비공개 API라 업데이트 때 깨질 수 있음, 사용 통계 전송은 끔. 설치 자체도 대표님 승인 필요 → **결정: cua-driver가 아니라 EG-Desk 자체 도우미를 Rust로(RT-04 Rust helper와 합침). cua-driver(MIT) Rust 코드는 참고·이식(출처 표기). 권한은 별도 도우미 .app이 받음(2026-10-24)** | 2-CH (인터페이스·가짜 provider는 1-H에서 결정 전 가능) |
| D-C2 | 새 선택지 A'(설치된 Codex Computer Use를 동작 하나씩 직접 호출)를 쓸까 | 비공식·OpenAI 미승인·실험적 API라 개인용으로만 → **아직 정하지 않음(2026-10-24 기준)** — 지금은 쓰지 않음 | 2-CH |
| D-C3 | Codex가 '이 앱을 써도 될까요'를 물을 때 대화를 끝낼까, 허락 카드를 띄울까 | 카드([이번만 허락]/[거절], 자동 수락 없음) → **결정: 카드([이번만 허락]/[거절], 자동 수락 없음)(2026-10-24)** | 2-R, S9 |
| D-C4 | Q2 시험 1회(대표님이 지켜보는 상태, TextEdit 하나)의 대상 | 관찰 전용부터: A'(list_apps·get_app_state) 또는 cua-driver → **결정: 관찰 전용부터(앱 목록·창 상태 읽기), OS 입력은 보내지 않음. 어느 도구로 읽을지는 따로 정하지 않음(D-C1은 자체 Rust 도우미, D-C2 A'는 쓰지 않음)(2026-10-24)** | 2-CH |
| D-C5 | 앱 범위 기본값 | 브라우저 보기만(웹은 Browser 카드), 터미널·IDE 금지, EG-Desk 자신·ChatGPT·Codex·Claude 앱·암호·시스템 설정 금지, Finder 경고 후 허락, 앞으로 가져오기는 작업마다 허락하고 저장 안 함 → **결정: 권고대로(2026-10-24)** | 2-CH, S9 |
| D-C6 | 긴급 중지 키 | 계약의 Ctrl+Alt+Shift+. 유지 / Esc. 어느 쪽이든 입력 모니터링 권한이 새로 필요, 실제 키 시험은 OS 입력 보류가 풀려야 할 수 있음 → **결정: Ctrl+Alt+Shift+. 유지(계약)(2026-10-24)** | 2-CH, S9 |
| D-C7 | HUM-COLLAB-001 기본값 | 사람 입력 뒤 기다림 10초, Agent 입력권 유지 15초, 두 대화 동시 사용 막는 기기 잠금 둠 → **결정: 권고대로 10초·15초·기기 잠금(2026-10-24)** | 2-CH (값은 1-H에서 매개변수로) |
| D-C8 | Q4 격리 VM을 하게 되면 기준 | Lume(MIT). Tart는 이제 OpenAI 저작권·FSL이라 비권장 → **결정: VM을 하게 되면 Lume. VM을 쓸지(computer-use-options Q4)는 아직 정하지 않음(2026-10-24)** | 2-CH |

### 5.3 Codex + Claude 구독

| ID | 질문 | 권고 | 막히는 묶음 |
|---|---|---|---|
| D-S1 | D1·SUB-12 Claude 연결 방식: (b) 설치된 무수정 claude를 직접 실행 + 공식 SDK와 같은 stdio 제어 통로 / (b') npm Agent SDK / (c) API 키만 | (b). (b)와 (b')는 같은 통로라 기능 차이 없음. 공식 문서 문장상 (b)가 '무수정 바이너리에 본인 구독으로 로그인'에 가장 가까움. 다만 Agent SDK 문구와의 긴장이 남고 stdio 통로는 CLI 공개 계약이 아님 → 최소 버전·`init.capabilities` 게이트, 외부 배포 전 Anthropic 문의 → **결정: (b) 설치된 무수정 claude를 하위 프로세스로 실행 + 공식 SDK와 같은 stdio 제어 통로. 외부 배포 전 Anthropic 문의(2026-10-24)** | 2-E, S9 |
| D-S2 | D2 EG-Desk의 Claude가 ~/.claude 설정 중 무엇을 물려받을까 | hooks와 개인·claude.ai MCP는 끔, 로그인은 공유. CLAUDE.md·skills 상속 여부만 정하면 됨 → **결정: hooks·개인/claude.ai MCP 끔, 로그인 공유, CLAUDE.md·skills는 기본 끔(선택지로 켬)(2026-10-24)** | 2-E |
| D-S3 | D5·SUB-11 EG-Desk 전용 로그인 저장소 | 계정 여러 개가 필요하면 전용(처음 1회 재로그인, EG-Desk 로그아웃이 터미널을 끊지 않음) / 공유(지금) → **결정: 지금은 공유 저장소. 계정 여러 개가 필요해지면 전용(2026-10-24)** | 2-E |
| D-S4 | SUB-15 API 키(종량) 프로필 포함 여부, 구독 대화에서 키가 감지되면 | 포함하되 키는 EG-Desk가 받지 않고 CLI 공식 로그인에 맡김. 감지 시 '시작 전 멈추고 확인' → **결정: 포함. 키는 EG-Desk가 받지 않고 CLI 공식 로그인. 구독 대화에서 키 감지 시 시작 전 멈추고 확인(2026-10-24)** | 2-E, S9 |
| D-S5 | SUB-14 한도 초기화 뒤 자동 이어가기 | 기본 꺼짐, 대화마다 사용자가 켬 → **결정: 기본 끔(2026-10-24)** | 2-M, 2-E |
| D-S6 | SUB-13 외부 배포 시 OpenAI SIWC(client ID) 신청 | 개인 사용이면 지금 방식 유지 → **결정: 개인 사용이면 지금 방식 유지(2026-10-24)** | 2-E(기록만) |

### 5.4 Agent 캐릭터

| ID | 질문 | 권고 | 막히는 묶음 |
|---|---|---|---|
| D-A1 | 새로 만드는 Agent의 기본 도구 범위 | '제한 없음(지금)' / '리서치(보기·읽기만)' / '코딩(파일 쓰기, 터미널은 매번 물음)' 중 하나. 이미 만든 Agent는 안 바꿈(만들 때만 저장) → **아직 정하지 않음(2026-10-24 기준)** — 지금 '제한 없음' 유지, 프리셋은 선택지로만 | 2-P, 2-R, S9 |
| D-A2 | Agent 파일 가져오기·내보내기 범위 | (가) agency-agents·Claude Code와 같은 머리말 .md 먼저 (나) Codex 에이전트 파일(.toml) 내보내기까지. 가져온 Agent는 늘 초안 — 권고: 예 → **결정: (가)+(나). 가져온 Agent는 늘 초안(2026-10-24)** | 2-P, S9 |
| D-A3 | 얼굴 사진 올리기(Q-AGENT-01) | 허용 시 PNG·JPEG·WebP 512KB 이하, 내보내는 파일에는 사진 제외 → **결정: 허용. PNG·JPEG·WebP 512KB 이하, 재인코딩, 내보내기에서 제외(2026-10-24)** | 2-P, S9 |
| D-A4 | 모델 우선순위 | 방에서 따로 고르지 않았을 때만 Agent 모델(1-R은 이 권고로 진행하고 확인을 받는다) → **결정: 권고대로(2026-10-24)** | 1-R(확인만) |
| D-A5 | 예시 Agent 6종(Q-AGENT-02) | 한국어 업무형으로 교체 / 예시로 유지 / 공개 모음(agency-agents 등)에서 골라 가져오는 목록 → **아직 정하지 않음(2026-10-24 기준)** | S9 |
| D-A6 | '설명 한 줄로 Agent 초안 만들기' 도입(초안마다 Codex 사용량 조금) | - → **아직 정하지 않음(2026-10-24 기준)** | 2-R, S9 |

### 5.5 Board 대화방의 여러 Agent

| ID | 질문 | 권고 | 막히는 묶음 |
|---|---|---|---|
| D-M1 | 하위 Agent가 승인 요청으로 멈췄을 때 | (가) 지금처럼 거절 + '부모 Agent에게 다시 맡기기' 버튼 — 권고 / (나) 부모 권한 상한 안에서 대표님이 직접 승인(하위 Agent가 사실상 권한을 얻음) → **결정: (가)(2026-10-24)** | 2-R, S8 |
| D-M2 | Board 대화방에서 누가 답하나(Q-AI-12) | (가) @로 부른 Agent만, 안 부르면 Lead만 — 권고, 사용량 예측 가능 / (나) Lead가 나눠 맡김(최대 왕복 수 상한) → **결정: (가)(2026-10-24)** | 2-R, 2-M, S8 |
| D-M3 | 개인 대화 → Board로 보낼 때(HUM-CONV-001) | 고른 메시지 복사본 + 원래 대화 링크, 받는 Agent에는 다음 turn에 블록으로 첨부 → **결정: 권고대로(2026-10-24)** | 2-R, S8 |
| D-M4 | Board 대화방 동시 실행 상한 | 지금 작업 그래프 maxConcurrency=2를 그대로 → **결정: 2(2026-10-24)** | 2-M |
| D-M5 | Codex 실험 기능 'agent message board'를 바탕으로 쓸까 | 0.164 이상 + 기능 플래그 + 2026-10-21에 막 들어옴 → 지금은 관찰만 → **결정: 관찰만(2026-10-24)** | - |

### 5.6 Chat → Canvas · Canvas · Board

| ID | 질문 | 권고 | 막히는 묶음 |
|---|---|---|---|
| D-K1 | CNV-05 AI 표식이 처음 나타나는 방식 | (가) 대상 카드가 Canvas에 있으면 그 위에 점선 '제안'으로 바로(카메라 안 움직임) — 권고 / (나) Chat의 '표식 N개 · 보기'를 눌러야 → **결정: (가)(2026-10-24)** | 2-BH, S7 (1-N은 결정 전 가능) |
| D-K2 | UX-04 상단 검색 요청의 수신자, Tab 키 | 항상 정해 둔 기본 Agent(처음엔 Codex 새 대화, 줄에 이름 표시). Tab은 지금처럼 Browser 카드로 둘지 '다른 Agent 고르기'로 바꿀지 → **아직 정하지 않음(2026-10-24 기준)** | S7 |
| D-K3 | CHAT-04 결과 카드 저장 방식 확인 | 지금 Board 안 메모 사본으로 구현됨 → 확정할지, '파일로 저장' 버튼을 나중에 더할지 → **아직 정하지 않음(2026-10-24 기준)** | - |
| D-K4 | CHAT-08 Agent가 게시한 결과 | 칩으로만 열기(저절로 Canvas에 안 띄움) — 권고. 같은 결과를 고치면 버전 2로 쌓을지 → **결정: 칩으로만(자동 열기 없음), 같은 결과 수정은 버전 2(2026-10-24)** | S3(기본값으로 진행 가능) |
| D-K5 | CNV-06 메모에서 물어본 질문의 답 | 메모에 답글로 저절로 붙음 — 권고 → **결정: 메모 답글로 자동(2026-10-24)** | S7 |
| D-V1 | CNV-03 한 창의 여러 Board 소속 | (가) 한 창은 한 Board에만 — 권고, 바로 구현 가능 / (나) 여러 Board 공유 '+1'(소속 저장 방식부터 변경) → **결정: (가)(2026-10-24)** | S7 |
| D-V2 | 새로 연 창의 기본 소속 | 자동으로 넣지 않고 Board 영역 안에서 열거나 놓았을 때만 제안 — 권고 → **결정: 권고대로(2026-10-24)** | S7 |
| D-V3 | 창을 Board 영역 안으로 끌어다 놓을 때 | 제안 칩, 누를 때만 추가 — 권고 → **결정: 권고대로(2026-10-24)** | S7 |
| D-V4 | 새 Board 저장 동작 | 선택한 창을 그 자리에서 Board 영역으로 묶어 사본이 안 생김 — 권고 → **결정: 권고대로(2026-10-24)** | S7 |
| D-V5 | UX-05 1차 범위 | 격자·안내선 맞춤 + 배치 실행 취소 + 겹침 없이 정리 — 권고, 그룹·숫자 입력은 2차 → **결정: 권고대로(2026-10-24)** | S7 |
| D-V6 | UX-06 채팅 엿보기를 여는 방법 | 화면 오른쪽 가장자리에 마우스 대기(Zen 방식) — 권고 / 단축키만 / 버튼만 → **결정: 오른쪽 가장자리 대기(Zen 방식)(2026-10-24)** | S7 |

### 5.7 디자인 · 코딩 · 런타임

| ID | 질문 | 권고 | 막히는 묶음 |
|---|---|---|---|
| D-G1 | DSN-03 기본 본문 글자 크기 | 13px(승인 스타일·Firefox chrome과 같은 계열)을 기준 토큰으로, 바꿀 때 한 곳만 → **결정: 13px(2026-10-24)** | S10 (토큰 표·대비 시험은 결정 전 가능) |
| D-G2 | 아바타 교정 방식 | (가) 나무결·회색을 승인 색에서 섞어 옅게 + 진한 잉크 글자 — 권고 / (나) 진하게 + 흰 글자. 둘 다 5~6.5:1 → **결정: (가)(2026-10-24)** | S1(권고로 진행, 확인) |
| D-G3 | 입력칸 테두리 대비(지금 1.33:1) | (가) 대비 증가·고대비에서만 진하게 — 권고 / (나) 기본에서도 나무결 선 색(3.42:1) → **결정: (가)(2026-10-24)** | S5 |
| D-G4 | 화면 모드 '시스템·밝게·어둡게' 직접 선택 | 추가하면 토큰을 light-dark() 한 줄로 → **아직 정하지 않음(2026-10-24 기준)** | S10 |
| D-G5 | 디자인 토큰 생성 단계 | (가) CSS 원본·토큰 표는 시험 기준만 — 권고 / (나) JSON(DTCG) → style-dictionary 생성 → **결정: (가)(2026-10-24)** | S10 |
| D-X1 | CODE-04 원래 프로젝트 파일 덮어쓰기 범위 | 사용자 저장과 검토 중 되돌리기만, 열 때와 해시 다르면 비교 화면, 내용이 같으면 통과 → **결정: 권고대로(2026-10-24)** | 2-X, S10 |
| D-X2 | CODE-05 덩어리별 수락/거절 | 1단계 승인 전 '변경 보기' + 전체 허용/거절, 2단계 적용 후 덩어리별 되돌리기(원본 쓰기 전제) → **결정: 권고대로(2026-10-24)** | 2-X, S10 |
| D-X3 | CODE-02 프로젝트 폴더를 어디에 붙이고 재시작 뒤 유지할지 | Board에 붙이고 채팅방은 상속(개별 지정 가능), 진행 중 회차는 시작 폴더 유지, 재시작 뒤엔 같은 폴더(dev/ino 동일)일 때만 자동 재연결 — 폴더 권한을 재시작 너머로 저장하게 됨 → **결정: 권고대로(2026-10-24)** | 2-X, S10 |
| D-X4 | (선택) 회차별 git checkpoint를 사용자 저장소 `.git`에 기록 | 기본 끔, Codex turn diff 사용, Claude 연결 때 재판단 → **결정: 기본 끔(2026-10-24)** | 2-X |
| D-X5 | D1(이전 조사) 편집기 기준을 Monaco ESM → CodeMirror 6으로, vendor 묶음 설치 허락 | - → **아직 정하지 않음(2026-10-24 기준)** | 2-X |
| D-X6 | '검사' 버튼·IDE 화면이 프로젝트에 저장한 명령을 터미널에서 실행 | 사용자가 직접 입력한 명령만, package.json 후보는 보여 주기만 → **결정: 권고대로(2026-10-24)** | 2-X |
| D-R1 | 자동 저장 묶음 간격과 복구 기록 보존 | 묶음 60초, 보존은 현재 임시값(최근 200개 + 하루 1개 30일, 512MiB) → **결정: 묶음 60초, 보존은 현재 임시값(2026-10-24)** | 2-RT |
| D-R2 | 자료 추천 기본 방식과 '절대 추천 안 함' 기본 목록 | 항상 / 첫 메시지만 / 끔 중 기본값, 은행·메일 기본 목록 여부(원장의 '제안만 vs 자동 첨부'를 사용자 설정으로) → **아직 정하지 않음(2026-10-24 기준)** | 2-CTX |
| D-R3 | Board 내보내기에 첨부·캡처 포함 기본값 | 끔(개인정보) → **결정: 끔(2026-10-24)** | 2-RT |
| D-R4 | RT-02 패키징 경로 | (가) 공식 Firefox 재포장(개인·내부용, 빠름) / (나) Zen식 자체 빌드(외부 배포·브랜드, 8vCPU·PGO CI 비용). Stable vs ESR, macOS 재서명·공증과 Windows 서명 인증서 비용, Mozilla 상표·재배포 검토(근거 미확보) → **아직 정하지 않음(2026-10-24 기준)** | 2-PK |
| D-R5 | 업데이트 방식 | 자체 서명 manifest(Tauri) vs Mozilla MAR(Zen), 서명 키 보관자, 업로드 위치 → **아직 정하지 않음(2026-10-24 기준)** | 2-PK |
| D-R6 | RT-04 터미널·Node 동봉·트레이 | node-pty 유지 vs Rust portable-pty, Node 폴더째 동봉 vs SEA, 트레이·전역 단축키 필요 여부 → **아직 정하지 않음(2026-10-24 기준)** | 2-PK |

### 5.8 레퍼런스 운영

| ID | 질문 | 권고 |
|---|---|---|
| D-L1 | 레퍼런스 코드 이식 범위 | MIT·Apache·BSD는 출처 표기 후 이식 허용(opencove 맞춤·층 스택, VS Code 링크 해석기, jsdiff 등), MPL은 패턴만(필요 시 파일 단위 MPL), GPL·AGPL·FSL·ELv2·tldraw·LobeHub은 패턴만 → **결정: 권고대로(2026-10-24)** |
| D-L2 | 6장의 서재 등록·선반 정리 승인 | 서재(`~/.claude/eg-library.tsv`)는 user level이라 대표님 확인 뒤 Main이 등록 → **아직 정하지 않음(2026-10-24 기준)** — 대표님 메모: 확장 등록은 하지 않고 조사만 |

---

## 6. 레퍼런스 목록 확장안

대표님 말씀대로 지금 레퍼런스 목록은 2026년 3~4월 기준에 멈춰 있다. 이번 조사 11건이 읽은 선반 밖 최신 프로젝트를 서재에 올리고, 낡은 선반 항목을 정리한다.

### 6.1 선반에서 낡거나 멈춘 항목

| 선반 항목 | 상태(조사 보고) | 권고 |
|---|---|---|
| browser/browser-automation/browser-use | 선반 d9a3065, 원본보다 1,525커밋 뒤처짐 | `setup.sh update` |
| browser/browser-automation/playwright | 선반 f3ceaac, MCP 코드가 `packages/playwright-core/src/tools`로 이동한 뒤의 차이 | 갱신 |
| browser/browser-automation/puppeteer-in-electron | 2021-10 이후 멈춤, Firefox 기반 EG-Desk와 무관 | 선반에서 제외 |
| browser/browser-automation/puppeteer | Chromium/CDP 전용, 이번 영역에서 제외 | 유지하되 우선순위 낮음 |
| browser/browser-automation/agent-browser-protocol | 원본도 2026-06-06 이후 정체 | 유지(정체 표시) |
| browser/surf | clone 2026-02-22, 원본 2026-08-24. 캔버스는 제거돼 legacy 타입만(Canvas 조사) | 갱신 |
| browser/brave-browser | Chromium 기반이라 Gecko 근거가 안 됨(열람 안 함) | 우선순위 낮음 |
| zen-browser | project-refs에 있지만 clone 없음 | `src/zen`만 sparse로 clone |
| (서재) floorp | 서재엔 있으나 선반 없음 | browser/에 sparse 추가(또는 참고 낮음으로 보류) |
| (서재) browser-operator | 2026-03-19 이후 멈춤 | 서재에 정체 표시 |
| theia | clone 2026-03-20(7개월). ai-codex 변경 묶음 코드가 주석 처리된 상태 | 갱신 |
| xyflow | clone 2026-03-27, 원본 2026-10-22. helper lines 예제는 지금 xyflow Pro License | 갱신, 예제는 사용 금지 표시 |
| infinite-canvas · anytype | Canvas2D 라이브러리 / 그래프 뷰뿐 — 이번 영역 참고 가치 낮음 | 유지하되 낮음 표시 |
| claude-code | 선반 CHANGELOG 2.1.81(2026-03-20), 이 Mac은 2.1.300. plugins만 있고 소스 없음 | 갱신 또는 공식 문서 링크로 대체 |
| claude-agent-sdk | 빈 폴더 | `claude-agent-sdk-python`으로 교체 |
| gemini-cli · agent-tools/agent-deck · agent-orchestration/oh-my-claudecode | 2026-03~04 사본, 원본은 2026-10-24에도 활발 | `setup.sh update` |
| agent-research/hermes-agent | 2026-04-03(34308e4). 지금 원본엔 computer_use 플러그인·데스크톱 앱이 있음 | 갱신 |
| agent-orchestration/paperclip | 2026-04-03, 원본 매일 갱신(user:// 태그 등 신규) | 갱신 |
| agent-tools/awesome-openclaw-agents | 선반 2026-03-23, 원본 2026-09-26 | 갱신 |
| agent-orchestration/dot-studio | apm-studio/apm-studio로 이름 변경, 2026-06-03 이후 멈춤 | 서재 URL 갱신 |
| agent-orchestration/clawteam | 2026-05-09 이후 멈춤 | 정체 표시 |
| agent-orchestration/724-office | 이번 영역과 관련 적음 | 낮음 표시 |
| agent-orchestration/agent-orchestrator | OrchestratorInc/agent-orchestrator로 이동 | 서재 URL 갱신 |
| agent-research/copilotkit | 서재엔 있으나 선반 clone 없음 | sparse clone(`packages/react-core`) |
| agent-research/browseros | 1,862커밋 뒤처짐, AGPL | 갱신(패턴만) |
| agent-tools/nvidia-nemoclaw · agent-research/openjarvis | 컴퓨터 사용(데스크톱 GUI)과 무관 | 영역 메모만 |
| agent-orchestration/deer-flow · deepagentsjs, agent-research/context-mode, claude-mem | 2026-03~04에서 멈춤. claude-mem 선반 사본은 AGPL인데 원본은 지금 Apache-2.0. context-mode는 ELv2(패턴만) | 갱신, 라이선스 메모 갱신 |
| memori | MemoriLabs로 이동 | 서재 URL 갱신 |
| neuronfs | 원격 저장소 404 | 선반·서재에서 제거(또는 사라짐 표시) |
| (선반 밖) letta-ai/letta | main이 랜딩 페이지로 은퇴, 현행은 letta-code | letta-code 등록 |
| project-refs.txt 머리말 | `~/.claude/reference-registry.tsv`를 가리키지만 실제 서재는 `~/.claude/eg-library.tsv` | 머리말 문구 수정 |

### 6.2 새로 등록할 항목

선반 그룹은 `references/project-refs.txt`의 기존 그룹을 먼저 쓰고, 맞는 그룹이 없으면 새 그룹을 제안한다(표의 '(새)'). clone 칸: ○ = 선반에 clone(작업자가 코드를 읽음), △ = sparse clone, × = clone 안 함(gh api로 파일만 또는 문서).

**브라우저** — `browser/browser-automation/`, `browser/`

| 이름 | URL | 이유 | stars | license | 최근 활동 | 선반 그룹 | clone |
|---|---|---|---|---|---|---|---|
| agent-browser | https://github.com/vercel-labs/agent-browser | 가장 빠르게 성장한 AI 브라우저 CLI. durable ref·가림 설명·pin-tab·도메인·정책 파일, 로그인 URL 대기 | 44,494 | Apache-2.0 | 2026-10-23 | browser/browser-automation/ | ○ |
| playwright-mcp | https://github.com/microsoft/playwright-mcp | 공식 MCP(실제 소스는 playwright 모노레포 tools/backend — 선반 playwright 갱신과 함께) | 38,562 | Apache-2.0 | 2026-10 | browser/browser-automation/ | ○ |
| chrome-devtools-mcp | https://github.com/ChromeDevTools/chrome-devtools-mcp | 행동 뒤 이동 감지·DOM 안정 대기·팝업·대화상자 보고 | 54,050 | Apache-2.0 | 2026-10-23 | browser/browser-automation/ | ○ |
| stagehand | https://github.com/browserbase/stagehand | 도메인 정책·프레임 인코딩 id(핵심이 packages/extension으로 이동) | 25,791 | MIT | 2026-10-23 | browser/browser-automation/ | △ |
| nanobrowser | https://github.com/nanobrowser/nanobrowser | EG-Desk 안전 원칙과 가장 가까운 2026 재작성 browser-control 계층, 60여 개 fixture | 14,162 | Apache-2.0 | 2026-10-15 | browser/browser-automation/ | ○ |
| firefox-devtools-mcp | https://github.com/mozilla/firefox-devtools-mcp | Mozilla 공식 Firefox 에이전트 도구(BiDi trusted 입력, WeakRef uid) | 519 | MIT OR Apache-2.0 | 2026-10-23 | browser/browser-automation/ | ○ |
| online-mind2web | https://github.com/OSU-NLP-Group/Online-Mind2Web | 실제 사이트 300과제·궤적 v2(BRW-14) | 208 | MIT | - | browser/browser-automation/ | △ |
| firefox-source | https://github.com/mozilla-firefox/firefox | 우리 엔진의 정본. 조사 4건이 파일 단위로 읽음(remote agent, BrowserDOMWindow·Tabbrowser, toolbarKeyNav, design-system 토큰, urlbar Actions, EventUtils). 전체 clone 금지 | 13,567(미러) | MPL-2.0 | 2026-10-24 | browser/ | × (gh api·sparse) |
| multi-account-containers | https://github.com/mozilla/multi-account-containers | 사이트→컨테이너 기억·다시 열기 | 3,162 | MPL-2.0 | - | browser/ | ○ |
| fx-autoconfig | https://github.com/MrOtherGuy/fx-autoconfig | EG-Desk overlay 로더의 원본(install이 쓰지만 서재 미등록), 고정 대상 | 495 | MPL-2.0 | 2026-07-23 | browser/ | ○ |
| firefox-csshacks | https://github.com/MrOtherGuy/firefox-csshacks | -moz-pref 미디어쿼리 색 체계 강제, 테마 변수 목록 | 4,557 | MPL-2.0 | 2026-10 | browser/ | ○ |
| ferdium | https://github.com/ferdium/ferdium-app | 계정별 세션 + OAuth 팝업 opener 유지 | 4,745 | Apache-2.0 | - | browser/ | △ |
| web-ext | https://github.com/mozilla/web-ext | 깨끗한 임시 프로필·조용한 pref(RT-01) | 3,147 | MPL-2.0 | - | browser/ | ○ |

**컴퓨터 사용** — `computer-use/` (새, AI & Agents 아래)

| 이름 | URL | 이유 | stars | license | 최근 활동 | clone |
|---|---|---|---|---|---|---|
| cua | https://github.com/trycua/cua | cua-driver(MIT, 백그라운드 조작·TCC 정체성·권한 모드·결과 계약), Lume VM. cua-spacesd는 FSL 패턴만, cua-perception은 AGPL 설치 금지 | 30,816 | MIT(일부 FSL·AGPL) | 2026-10-24 | △ (libs/cua-driver, libs/lume) |
| peekaboo | https://github.com/openclaw/Peekaboo | 자체 Swift adapter 교본(SCK 캡처, AX 먼저, postToPid, 결과 미확정 오류형) | 5,379 | MIT | 2026-10-23 | ○ |
| windows-mcp | https://github.com/CursorTouch/Windows-MCP | 입력권 상태기계·긴급 인계·캡처 제외 표시의 실제 구현 | 10,154 | MIT | 2026-10-24 | ○ |
| codex-computer-use-mcp | https://github.com/tmustier/codex-computer-use-mcp | Codex Computer Use 동작 단위 호출(A'), 비공식 | 35 | MIT | 2026-10-21 | ○ |
| ui-tars-desktop | https://github.com/bytedance/UI-TARS-desktop | Agent 조작 표시 패턴(테두리 빛·캡처 제외·트레이 중지) | 39,372 | Apache-2.0 | 2026-10-09 | △ (apps/ui-tars) |
| microsoft-ufo | https://github.com/microsoft/UFO | Windows UIA + Office COM hybrid action | 10,067 | MIT | 2026-10-23 | △ |
| openai-cua-sample-app | https://github.com/openai/openai-cua-sample-app | 중지 뒤 입력 해제 helper | 1,907 | MIT | 2026-10-19 | ○ |
| claude-quickstarts | https://github.com/anthropics/claude-quickstarts | Claude 화면 축소 규칙·VM 권고 | 18,972 | MIT | 2026-10-23 | △ (computer-use-*) |
| e2b-desktop | https://github.com/e2b-dev/desktop | 클라우드 격리 데스크톱(Xvfb+noVNC) | 1,539 | Apache-2.0 | 2026-10-24 | △ |
| agent-s | https://github.com/simular-ai/Agent-S | 오픈소스 컴퓨터 조작 Agent(이번 조사 코드 미열람) | 약 12.7k | Apache-2.0 | 2026-10 | × |
| tart | https://github.com/openai/tart | Lume 비교용(OpenAI 저작권, FSL — 패턴만) | - | FSL-1.1-ALv2 | - | × |

**엔진 연결(Codex·Claude)** — `agent-engines/` (새, AI & Agents 아래)

| 이름 | URL | 이유 | stars | license | 최근 활동 | clone |
|---|---|---|---|---|---|---|
| openai-codex | https://github.com/openai/codex | 우리 런타임의 정본(app-server 스키마, TUI agent center, agent-roles, turn diff, fuzzy 검색) | 130,704 | Apache-2.0 | 2026-10-23 | △ (codex-rs/app-server-protocol, tui/src/app, agent-roles, app-server/README.md) |
| claude-agent-sdk-python | https://github.com/anthropics/claude-agent-sdk-python | stdio 제어 프로토콜 원본, 빈 선반 claude-agent-sdk 대체 | 8,340 | MIT | - | ○ |
| claude-agent-acp | https://github.com/agentclientprotocol/claude-agent-acp | auth status·터미널 로그인·질문 형식·Edit/Write → patch(구 zed-industries/claude-code-acp) | 2,685 | Apache-2.0 | 2026-10-23 | ○ |
| codex-acp | https://github.com/agentclientprotocol/codex-acp | device code 로그인(구 zed-industries/codex-acp는 2026-07 보관) | 483 | Apache-2.0 | - | ○ |
| agent-client-protocol | https://github.com/agentclientprotocol/agent-client-protocol | 에디터↔에이전트 표준·RFD(terminal auth, usage_update, diff 모양) | 4,492 | Apache-2.0 | - | ○ |
| t3code | https://github.com/pingdotgg/t3code | Codex+Claude GUI. 계정별 CODEX_HOME, 사용 한도, 프로젝트→작업 폴더, 회차 git checkpoint, SIWC | 29,678 | MIT | 2026-10-23 | ○ |
| vibe-kanban | https://github.com/BloopAI/vibe-kanban | 사용자 claude를 stdio로 직접 실행·과금 경고, worktree diff 증분 | 28,440 | Apache-2.0 | 2026-09 | ○ |
| codexbar | https://github.com/steipete/CodexBar | 사용량 표시·다계정 결정 문서(CLI 경로만 참고, OAuth·쿠키 경로 금지) | 22,766 | MIT | - | ○ |
| opencode | https://github.com/anomalyco/opencode | 계정 여러 개·활성 계정 전환(구 sst/opencode) | 220,667 | MIT | - | △ |
| ccusage | https://github.com/ccusage/ccusage | 토큰 없이 로컬 JSONL로 비용 추정(구 ryoppippi/ccusage) | 19,153 | MIT | - | △ |
| happy | https://github.com/slopus/happy | 구독 재사용 원격 앱(자체 프로토콜 동결 사례) | 24,288 | MIT | - | △ |

**Agent 캐릭터·여러 Agent** — `agent-research/`, `agent-tools/`, `agent-orchestration/`, `agent-messaging/`

| 이름 | URL | 이유 | stars | license | 최근 활동 | 선반 그룹 | clone |
|---|---|---|---|---|---|---|---|
| openclaw | https://github.com/openclaw/openclaw | IDENTITY.md 정체성, 도구 프로필·금지 우선, sandbox explain, 명단 활동 카드 | 392,889 | MIT | 2026-10-24 | agent-research/ | △ |
| openai-agents-python | https://github.com/openai/openai-agents-python | handoff_description·clone() | 30,248 | MIT | 2026-10-22 | agent-research/ | ○ |
| openai-agents-js | https://github.com/openai/openai-agents-js | handoff inputFilter(넘길 기록 고르기) | 3,938 | MIT | - | agent-research/ | ○ |
| letta-code | https://github.com/letta-ai/letta-code | Letta 현행 소스, 성격 프리셋·출처 태그 | 3,697 | Apache-2.0 | 2026-10-24 | agent-research/ | ○ |
| lobehub | https://github.com/lobehub/lobehub | 한 대화방 여러 Agent(supervisor 결정·maxRounds·참여자 맥락) | 83,454 | LobeHub Community License(패턴만) | - | agent-orchestration/ | △ (packages/agent-runtime) |
| crewai | https://github.com/crewAIInc/crewAI | role·goal·backstory 교차 확인용 | 약 60k | MIT | - | agent-orchestration/ | × |
| apm-studio | https://github.com/apm-studio/apm-studio | 선반 dot-studio의 새 이름(신규 등록이 아니라 URL 갱신) | 437 | MIT | 2026-06-03 | agent-orchestration/ | (기존) |
| agency-agents | https://github.com/msitarzewski/agency-agents | Agent 파일 사실상 표준(머리말)과 15개 형식 변환기 | 163,532 | MIT | 2026-10-19 | agent-tools/ | ○ |
| awesome-claude-code-subagents | https://github.com/VoltAgent/awesome-claude-code-subagents | 예시 Agent 갤러리 후보(코드 미열람) | 약 2.6만 | MIT | - | agent-tools/ | × |
| wshobson-agents | https://github.com/wshobson/agents | 갤러리 후보(미열람) | 약 4.2만 | MIT | 매일 | agent-tools/ | × |
| ag-ui | https://github.com/ag-ui-protocol/ag-ui | SUBAGENT_* 이벤트·subagentRunId·Interrupt/ResumeEntry 표준 | 16,788 | MIT | - | agent-messaging/ | ○ |
| a2a | https://github.com/a2aproject/A2A | TaskState 업계 어휘(input-required·auth-required) | 26,274 | Apache-2.0 | - | agent-messaging/ | △ (specification) |
| character-card-spec-v3 | https://github.com/kwaroran/character-card-spec-v3 | 캐릭터 정의 표준(예시 대화·extensions·source), 2024 이후 멈춤 — 형식 참고용 | 114 | MIT | 2024-07 | (Docs & Research 평면) | ○ |

**Canvas·Chat UI·디자인·코딩·런타임** — 새 그룹 `canvas/`, `chat-ui/`, `design-a11y/`, `coding/`, `runtime/` (IDE & Desktop 아래, 기존 infinite-canvas·xyflow·theia 옆)

| 이름 | URL | 이유 | stars | license | 최근 활동 | 선반 그룹 | clone |
|---|---|---|---|---|---|---|---|
| excalidraw | https://github.com/excalidraw/excalidraw | 프레임 소속·검색·맞춤·그룹·reconcile·restore | 134,441 | MIT | 2026-10-23 | canvas/ | △ |
| opencove | https://github.com/DeadWaveWave/opencove | Agent용 무한 캔버스 작업 공간 — Space 소속·24px 맞춤·접기·Esc 층(EG-Desk와 가장 비슷) | 1,634 | MIT | 2026-10-17 | canvas/ | ○ |
| tldraw | https://github.com/tldraw/tldraw | 맞춤 후보·끌기 소속·실행 취소·파일 형식 이전(패턴만) | 51,059 | tldraw license | - | canvas/ | △ |
| tldraw-agent-template | https://github.com/tldraw/agent-template | AI 캔버스 action·diff 수락/거절·강조 오버레이 | 40 | MIT | 2026-10-02 | canvas/ | ○ |
| quickdraw | https://github.com/quickdrawjs/quickdraw | tldraw 대체 MIT SDK, 의존성 없는 freehand.js | 568 | MIT | 2026 | canvas/ | ○ |
| perfect-freehand | https://github.com/steveruizok/perfect-freehand | 펜 획 라이브러리 | 약 5.7k | MIT | - | canvas/ | ○ |
| jsoncanvas | https://github.com/obsidianmd/jsoncanvas | 공개 캔버스 파일 형식(RT-03 내보내기) | 3,736 | MIT | - | canvas/ | ○ |
| driftwm | https://github.com/malbiruk/driftwm | 무한 캔버스 창 관리자 배치·Dock 맞춤(패턴만) | 1,839 | GPL-3.0 | 2026-10-23 | canvas/ | ○ |
| collab-public | https://github.com/collabs-inc/collab-public | 화면 밖 타일 가장자리 표시·dirty 미니맵(패턴만) | 3,075 | FSL-1.1-ALv2 | - | canvas/ | △ |
| penpot | https://github.com/penpot/penpot | 위치 고정 댓글 스레드(패턴만) | 61,555 | MPL-2.0 | 2026-10-23 | canvas/ | × (파일만) |
| librechat | https://github.com/LibreChat-AI/LibreChat | Artifact 지시문·버전·Chat 쪽 한 줄 트리거 | 46,226 | MIT | 2026-10-24 | chat-ui/ | △ |
| vercel-chatbot | https://github.com/vercel/chatbot | createDocument 도구와 when/when-not 지침 | 21,005 | Apache-2.0 | 2026-07 | chat-ui/ | △ |
| open-canvas | https://github.com/langchain-ai/open-canvas | Artifact 버전 구조(2026-02 보관 — 패턴만) | 5,478 | MIT | 보관 | chat-ui/ | △ |
| zulip | https://github.com/zulip/zulip | 메시지 이동 양쪽 안내 줄 | 26,101 | Apache-2.0 | - | chat-ui/ | × (파일만) |
| driverjs | https://github.com/nilbuild/driver.js | 단계별 강조 evenodd 구멍(구 kamranahmedse/driver.js) | 26,947 | MIT | 2026-10-18 | design-a11y/ | ○ |
| aria-practices | https://github.com/w3c/aria-practices | toolbar·tabs·radio 공식 예제 | 1,359 | W3C License | 2026-10-14 | design-a11y/ | △ |
| base-ui | https://github.com/mui/base-ui | 비활성 포커스 유지·Composite 커서 경계 | 11,220 | MIT | 2026-10-24 | design-a11y/ | △ |
| react-spectrum | https://github.com/adobe/react-spectrum | useToolbar·키보드 툴팁 | 15,978 | Apache-2.0 | 2026-10-23 | design-a11y/ | △ |
| radix-colors / radix-themes | https://github.com/radix-ui/colors · https://github.com/radix-ui/themes | 12단계 색·고정 대비 글자색·아바타 soft | 1,719 / 8,787 | MIT | 2025-12 / 2026-04 | design-a11y/ | ○ |
| primer-primitives | https://github.com/primer/primitives | 테마별 대비 검사표 | 415 | MIT | 2026-10-22 | design-a11y/ | ○ |
| style-dictionary | https://github.com/style-dictionary/style-dictionary | Firefox가 쓰는 토큰 생성기(코드 미열람) | - | Apache-2.0 | - | design-a11y/ | × |
| dtcg-format | https://www.designtokens.org/ | Design Tokens 형식 2025.10 첫 안정판 | - | W3C CG 보고서 | 2025-10-28 | design-a11y/ | × (docs) |
| vscode | https://github.com/microsoft/vscode | 터미널 링크 해석·문제 해석·더러운 쓰기 방지·implicit context·Local History | 194,254 | MIT | - | coding/ | × (파일 단위) |
| zed | https://github.com/zed-industries/zed | 에이전트 변경 덩어리별 Keep/Reject(GPL 패턴만) | 92,111 | GPL-3.0-or-later(해당 crate) | - | coding/ | × |
| jsdiff | https://github.com/kpdecker/jsdiff | hunk-only 패치 해석·적용·역적용, libesm vendor 가능 | 9,213 | BSD-3-Clause | - | coding/ | ○ |
| codemirror-merge | https://code.haverbeke.berlin/codemirror/merge | unifiedMergeView acceptChunk/rejectChunk(GitHub 미러는 2026-04 보관) | - | MIT | 2026-10-19(6.12.3) | coding/ | ○ |
| test-reporter | https://github.com/dorny/test-reporter | 테스트 결과 공통 모델 | 1,183 | MIT | - | coding/ | ○ |
| pierre | https://github.com/pierrecomputer/pierre | 경로 기반 파일 트리(beta)·diff 렌더러(무거움) | 6,356 | Apache-2.0 | - | coding/ | △ |
| fff | https://github.com/dmtrKovalenko/fff | 빠른 파일·내용 검색(네이티브 의존성이라 보류) | - | MIT | - | coding/ | × |
| langgraphjs | https://github.com/langchain-ai/langgraphjs | SQLite 체크포인트·interrupt 재개 | 3,370 | MIT | 2026-10-24 | runtime/ | ○ |
| vercel-workflow | https://github.com/vercel/workflow | run·step·hook·wait 이벤트 로그 | 2,471 | Apache-2.0 | 2026-10-24 | runtime/ | ○ |
| mastra | https://github.com/mastra-ai/mastra | suspendSchema/resumeSchema(ee/ 제외) | 29,040 | Apache-2.0 | - | runtime/ | △ |
| cline | https://github.com/cline/cline | 맥락 파일 active/stale 추적 | 70,786 | Apache-2.0 | - | runtime/ | △ |
| tray-icon | https://github.com/tauri-apps/tray-icon | Tauri 없이 쓰는 트레이 crate | 412 | MIT OR Apache-2.0 | - | runtime/ | ○ |
| global-hotkey | https://github.com/tauri-apps/global-hotkey | 전역 단축키 crate | 266 | Apache-2.0 | - | runtime/ | ○ |
| tauri-plugins-workspace | https://github.com/tauri-apps/plugins-workspace | updater 서명 manifest | 1,834 | Apache-2.0 | - | runtime/ | △ (plugins/updater) |
| wezterm | https://github.com/wezterm/wezterm | portable-pty(이미 terminal-worker가 사용) | 29,329 | MIT | - | runtime/ | △ (pty/) |
| node-sea-docs | https://nodejs.org/api/single-executable-applications.html | SEA 제약(ESM·addon) | - | MIT | v26.8.2 문서 | runtime/ | × (docs) |

### 6.3 이름 정리 (조사 보고 사이의 중복)

- 조사마다 다르게 부른 같은 저장소는 하나로 등록한다: `codex`/`openai-codex` → **openai-codex**, `firefox-source`/`firefox-remote-agent`/`firefox-design-system`/`firefox-urlbar` → **firefox-source** 하나(docs, sparse 경로 목록을 설명에 기록), agent-browser·playwright-mcp·t3code·claude-agent-acp·excalidraw·tldraw·fx-autoconfig·jsoncanvas·vscode는 여러 조사에서 중복 제안됨 → 1건씩.
- 서재 등록과 선반 clone은 Main 담당이며, 서재는 user level이라 대표님 확인 뒤에 한다(D-L2).

---

## 7. 확인 필요 목록 (근거가 약하거나 코드만 읽고 내린 판단)

| 항목 | 지금 근거 | 확인 방법 |
|---|---|---|
| 크기 지정 팝업 창에서 EG-Desk overlay가 다시 부팅됨 | nsWindowWatcher·fx-autoconfig 코드 읽기 | S1 안전망 넣기 전 headless로 재현(Main 허락 시) |
| `popupAndRedirectBlocker` 속성 존재·동작, `messagemanagergroup` 추가 시 액터 오류 | Parent 코드가 참조하는 것만 확인 | 소유 fixture로 직접 확인 |
| Gecko API: `window.synthesizeMouseEvent`, `drawSnapshot`의 headless 동작, 대화상자 이벤트 이름(`DOMWillOpenModalDialog`, `common-dialog-loaded`/`tabmodal-dialog-loaded`), `http-on-modify-request`에서 `loadInfo.browsingContext.top.embedderElement`로 카드 식별 | Firefox main(2026-10-24) 코드 기준, 우리 Firefox 버전 미확인 | 2-BH 첫 단계에서 소유 fixture로 확인. REA §6.1 'headless 스크린샷 미지원'은 우리 하네스 원인일 수 있음 |
| Codex 모델이 동적 도구 결과의 `inputImage`를 시각 입력으로 실제 쓰는지 | 스키마로만 확인 | 2-BH 소형 시험 |
| Codex elicitation 요청이 오면 대화가 끊김 | tmustier 코드 구조에서 추론 | Q2 시험 1회 때 관찰 |
| macOS 물리·합성 입력 구분(`kCGEventSourceUnixProcessID`), `CGEventSourceSecondsSinceLastEventType`의 권한 필요 여부 | 공식 문서 미확인(추정) | 2-CH 착수 전 Apple 문서 확인 |
| `rate_limit_event.rateLimitType` 필드 이름, `seven_day_oauth_apps` 의미 | t3code가 쓰는 SDK 타입에서만 확인 / 추정 | 실제 stream-json 출력 캡처 |
| codex keyring 저장 모드에서 CODEX_HOME마다 자격증명이 분리되는지 | 미확인 | 2-E 첫 단계 |
| stdio 제어 통로가 claude 2.1.300에서 실제로 왕복되는지 | SDK 소스·vibe-kanban 실사용 근거, 실행 0회 | 2-E 첫 단계(D1 뒤) |
| 설치된 codex-cli 0.162.1에 `thread/status/changed`·`agentNickname`·`thread/inject_items`·`fuzzyFileSearch`·turn/start cwd가 있는지 | openai/codex main(2026-10-23) 소스 기준 | 1-R·1-G 착수 시 app-server 스키마 생성물로 확인 |
| child 쓰레드 item 알림이 우리 런타임에서 버려짐 | 코드상 run 조회 실패로 추론(runtime `:1846`) | 1-R 단위 시험 |
| '새 Board 저장' 뒤 다시 열면 사본 창 생성, 미니맵 매 프레임 DOM 재구성 | 코드 경로만 따라감(실측 없음) | S4·S7 전에 재현 |
| Desk 세대에서 채팅 본문을 빼도 복원이 안전한지 | 복원 경로를 끝까지 읽지 않음 | 2-RT 착수 시 restoreDesk 계열 확인 |
| opencove `overlayLayerRegistry.ts:1-58` | 조사 보고에 인용됐지만 scratchpad sparse 사본에는 파일이 없음 | gh api로 다시 받아 확인 |
| native title 툴팁이 키보드 포커스에 안 뜸, 포커스된 버튼이 disabled가 되면 포커스를 잃음 | 일반 동작·APG 안내 근거, Firefox chrome 미실측 | S1·S5에서 확인 |
| `ui.useAccessibilityTheme` + `browser.display.document_color_use`로 고대비 흉내 | Firefox devtools 시험 검색 결과로만 확인 | 1-Q 스위치로 확인 |
| Codex apply_patch가 파일을 제자리에 쓰는지(inode 유지) | 미확인 — 바뀌면 opaque handle이 RESOURCE_CHANGED | 2-X 첫 단계 |
| 내보낸 Codex 에이전트 TOML이 실제 codex에서 읽히는지 | 미확인 | 2-P |
| Node SEA로 node-pty 묶기, 재포장 Firefox의 macOS 재서명 필요 | 문서 기준·일반 지식([의견]) | 2-PK |
| Mozilla 상표·재배포 정책 | 근거 미확보(검색 결과가 2009년 정책 페이지뿐) | 2-PK 전 별도 검토 |
| 라이선스 표시 불일치: vercel/chatbot·codex-acp·ccusage는 GitHub 표시 NOASSERTION, Zen MPL-2.0은 gh api 메타데이터 기준 | LICENSE 본문 확인(vercel/chatbot은 Apache-2.0 확인) | 이식 전 LICENSE 원문 재확인 |
| stars·최근 활동 수치 | 조사 작업자 보고(gh api, 2026-10-24) | 등록 시 재조회 |

---

## 8. 부록: 조사 사본 위치

- scratchpad 사본 루트: `/private/tmp/claude-501/-Users-minsoocha-Projects-EG-Desk-Dev-Space/dac7ff27-92ee-4567-9d7f-546e39ec2742/scratchpad/refs/` — 임시 위치다. 6장 등록 뒤 선반으로 옮긴다.
- gh api로 받은 단일 파일: 같은 scratchpad 루트의 `turn_diff_tracker.rs`, `item_builders.rs`, `codex-fs.rs`, `zed_action_log.rs`, `zed_agent_diff.rs`, `cm_unified.ts`, `vscode_terminalLinkParsing.ts`, `vscode_problemMatcher.ts`, `vscode_fileService.ts`, `vscode_chatEditingEntry.ts`, `codexacp-CodexAcpClient.ts`, `codex-app-server-README.md`.
- 선반에서 읽은 것: `references/browser/surf`, `references/browser/browser-automation/agent-browser-protocol`, `references/agent-research/browseros`, `references/agent-orchestration/{paperclip,dot-studio,deer-flow,deepagentsjs,oh-my-claudecode}`, `references/agent-tools/{agent-deck,awesome-openclaw-agents,nvidia-nemoclaw}`, `references/agent-research/context-mode`, `references/claude-mem`, `references/gemini-cli`, `references/theia`, `references/xyflow`, `references/infinite-canvas`.
- 관련 우리 문서: `docs/references/computer-use-browser-control-rea.md`(REA), `docs/references/computer-use-options.md`, `docs/references/engine-adapter-design.md`, `docs/references/coding-surface-framework-research.md`, `docs/references/design-synthesis/egdesk-ux-realization-proposals.md`, `apps/firefox-ui-demo/docs/AI_CANVAS_ANNOTATION_LAYER.md`.
