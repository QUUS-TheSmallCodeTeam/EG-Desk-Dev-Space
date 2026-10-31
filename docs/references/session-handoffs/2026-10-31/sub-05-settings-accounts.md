# SUB-05 + SUB-01 (session sub-05-settings-accounts) — 계획 03:55 KST

## 현황 (문서·코드 리뷰 결과)
- Settings '계정' 탭은 이미 state.codex.authStatus(실제 ChatGPT email/planType/usage)와 ChatState.claudeSettingsView(engines)를 그린다 (ce20398, 32bb53a). 가짜 상수 0개 (egdesk-surface-state.test.mjs가 source 검사).
- 빠진 것: (1) 브리지 끊김 시 '확인 중/연결 끊김' 구분 없음(connected=false 하나). (2) 로그아웃 버튼이 확인 없이 bridge().signOut() 직행, '다른 계정으로 로그인' 없음, 진행 중 Run 경고 없음. (3) Claude는 '인증됨/인증 안 됨'만 — 구독/API 키/계정/요금제(profiles[0].auth.method/account/planType) 미표시.

## 건드릴 파일
- NEW overlay/resources/EGDeskAccountSettingsView.sys.mjs — settingsConnectionView, claudeAccountView, busyRunSummary, accountActionConfirm, accountMenuItems (순수).
- NEW scripts/egdesk-account-settings-view.test.mjs.
- overlay/JS/eg-desk-surface.uc.js — Settings 구역만: 섹션 머리 lazy importESModule, spawnSettingsCard 안 renderAccountTab(ChatGPT 카드 상태·계정 메뉴·확인 블록·Claude 카드), onCodexChange signature에 bridgeFailures/error 추가.
- overlay/CSS/eg-desk-surface.uc.css — '/* --- 계정 --- */' 블록 옆.

## 범위 밖 (안 건드림)
- helper/* 전부(SUB-14), mountCodexHUD(8318-9796) chip, codexBridge 클라이언트 객체(새 메서드 없음; Claude '다시 확인'은 refreshAuthStatus → /v1/state 재조회, 강제 /engines/claude/refresh는 미배선), Terminal 카드에서 claude auth login 실행(터미널 spawn API 밖), SUB-11 다중 계정.

## 결과 (11:08 KST, 커밋 87d253b, 브랜치 claude/sub-05-settings-accounts-ea6524)
- 한 일: Settings '계정' 탭 — ChatGPT 카드가 '연결 확인 중'(첫 접속·조용한 재연결)과 '연결이 끊겼습니다'(재연결 소진, [다시 연결])를 구분. 로그인된 카드에 '계정 메뉴'(상태 새로고침 / 다른 계정으로 로그인 / 로그아웃) 추가 — 두 계정 동작은 확인 블록(계정 이메일·터미널 codex 공유 로그인 경고·진행 중 Run 수와 대화방 이름)을 먼저 보여 주고, 확인 시 bridge().signOut() → (전환이면) startLogin() → refreshAuthStatus()로 다시 읽어 결과 문구 표시. Claude 카드: 구독 라벨+이메일 / Anthropic API 키 / 외부 제공자 / 미로그인(터미널 claude auth login 안내) / 미설치 / 확인 안 됨 / 연결 안 됨 + [다시 확인].
- 파일: NEW overlay/resources/EGDeskAccountSettingsView.sys.mjs(순수), NEW scripts/egdesk-account-settings-view.test.mjs(9 pass); uc.js Settings 구역(섹션 머리 lazy import, renderAccountTab, onCodexChange signature); CSS '/* --- 계정 --- */' 블록 뒤; scripts/egdesk-surface-state.test.mjs(Settings 하네스 6곳에 AccountSettingsView·codexBridgeNotice 주입, production 카드 테스트를 메뉴→확인→로그아웃 경로로 갱신; 943 pass / 0 fail).
- 병합 주의: uc.js 변경은 L13828-14110·L14943 한 줄뿐(다른 구역 미접촉). scripts/egdesk-surface-state.test.mjs는 공유 파일 — 하네스 param/args 끝에 두 인자 추가(6곳) + import 1줄 + settingsBridgeNotice 1줄 + production 테스트 본문. SUB-14가 같은 테스트 파일의 다른 부분을 고쳤다면 충돌은 자동 병합될 가능성이 높으나 확인 필요.
- 못 한 일: Claude 강제 재확인(POST /engines/claude/refresh)은 bridge 클라이언트 메서드가 없어 미배선(현재 '다시 확인'은 /v1/state 재조회 → 브리지가 최대 1분 간격으로 재검사). Terminal 카드에서 `claude auth login` 자동 실행 미구현(힌트 문구만). HUD 상단 chip에서 계정 메뉴 열기는 SUB-14 구역이라 미배선 — 설정 카드 '계정' 탭이 계정 메뉴의 자리.
