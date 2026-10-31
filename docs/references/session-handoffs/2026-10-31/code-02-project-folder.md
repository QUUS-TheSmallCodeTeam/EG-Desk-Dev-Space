# CODE-02 — 프로젝트 폴더를 코딩 작업 단위로 (세션 code-02-project-folder, 2026-10-31)

브랜치 `claude/code-02-project-folder-6bbbfc`, 커밋 4개(push 없음): `1f37cae` → `bacb4ff` → `1b558e4` → `e6ea9f5`.

## 바뀐 동작
- Board 헤더 [⋯] 메뉴에 '프로젝트 폴더…'(선택/바꾸기)와 '프로젝트 폴더 해제'가 생겼다. 폴더는 기존 네이티브 picker → `/v1/files/projects/attach` 경로로만 붙는다(경로 문자열 전달 없음).
- Board 헤더에 프로젝트 칩(`.egd-board-region-project`, testid `board-project`)이 보인다: 연결됨 → 폴더명, 재시작 뒤 dev/ino가 다르거나 폴더가 없으면 '프로젝트 폴더를 다시 선택'(클릭 → picker), 브리지 미응답 → '이름 · 확인 필요'(클릭 → 재조회).
- 저장된 Board(`agenda.project = {projectId, title}`)가 프로젝트 참조를 함께 저장한다. 경로·identity는 bridge의 project store에만 있다. 참조만으로 폴더를 자동 연결하지 않는다(D-X3).
- 채팅방 상속·Agent cwd·File root는 기존 경로 그대로(project store `effective()` → `resolveProjectWorkspace` → overrides.cwd; File `openProject`). Board 폴더 변경 시 방 기본값 캐시 무효화(`invalidateRoomProjectDefaults`).

## 이미 있던 것 (이번에 안 건드림)
project store(dev/ino), `connectProject` 자동 재연결, 채팅방 상속/방 전용/요청별 선택 UI, File view '보드 프로젝트 연결', `INVALID_CWD` 거부.

## 다른 세션에 알릴 것
- **CNV-03**: `EGDeskSurfaceState.sys.mjs` `boardProjectReference()` 추가, `planBoardProjection`/`snapshotBoardProjection`에 `project` 필드(있을 때만). uc.js `refreshBoardRegion`에 칩 1줄 + `syncBoardRegionProject` 1줄, `toggleBoardRegionMenu` items에 `...boardProjectMenuItems(projection, item)` 1줄. `scripts/egdesk-surface-state.test.mjs`의 두 Board 하네스에 stub 추가(L9222, L10198, L10256, L17068 부근).
- **CODE-05/07**: File 카드는 Board 폴더 변경을 자동 반영하지 않음(기존처럼 카드의 '보드 프로젝트 연결'/openProject 재검증 경로).

## 검증
- `node --test helper/egdesk-project-identity.test.mjs` 3/3.
- `node --test helper/egdesk-file-http.test.mjs` 77 pass / 1 fail / 2 skip — 실패 1건은 `EGDESK_SQLITE_RUNTIME_UNSAFE`(이 머신 Node 24.11.1의 SQLite가 고정 런타임 조건 미달; 변경 전부터 환경 의존, 내 변경과 무관).
- `node --test scripts/egdesk-surface-state.test.mjs` 943 pass / 0 fail / 1 skip. `scripts/egdesk-canvas-layout.test.mjs` 33/33.
- 실제 Firefox 창·브리지 왕복은 미검증(금지 범위).
