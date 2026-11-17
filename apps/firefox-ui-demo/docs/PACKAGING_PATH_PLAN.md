# EGDesk 패키징 경로 계획 (RT-02 · D-R4~R6)

작성: 2026-11-18, 브랜치 `claude/vision-packaging-plan-20261118` (base `0b66e1b`).
범위: 문서만. 코드·네트워크·앱 실행 없이 저장소 파일만 읽고 썼다.

표기:
- **[확인]** 이 저장소 파일에서 직접 읽은 사실.
- **[미확인]** 외부 사실(라이선스·인증서 가격·OS 정책 등)이나 실행해 보지 않은 동작. 네트워크를 쓰지 않았으므로 결정 전에 1차 출처로 다시 확인해야 한다.
- **[권고]** 이 문서의 추천. 대표님 결정이 아니다.

관련 원장 항목: `ideas/confirmed/EGDESK_VISION_GAP_LEDGER.md`의 RT-01(155, 1510, 1598행), RT-02(1519, 1693행), RT-04(160, 1518, 1683행), 결정 행 D-R4~R6(417, 441, 444행: "패키징 경로·업데이트 방식·터미널/Node 동봉·트레이", 모두 '남음').

---

## 1. 현재 상태

### 1.1 설치·실행 방식 (Path 1.5)

| 항목 | 현재 | 근거 |
|---|---|---|
| Firefox | 사용자가 이미 설치한 Firefox를 그대로 쓴다. 번들 Firefox 없음 | [확인] `scripts/run-egdesk-windows.mjs:2` "Normal Windows launcher for the existing dedicated EG-Desk profile", 462행 `%ProgramFiles%\Mozilla Firefox\firefox.exe`, 528행 `-profile <전용 프로필> --no-remote --purgecaches` |
| chrome 로더 | fx-autoconfig를 커밋 `dfdab56`(2026-07-23)으로 고정, 8개 파일 SHA-256 확인 후에만 Firefox 설치 폴더(`program/config.js`, `program/defaults/pref/config-prefs.js`)와 프로필(`chrome/utils/*`)에 복사 | [확인] `scripts/install.sh:34-40`, `scripts/verify-clean-profile-boot.mjs`의 `FX_AUTOCONFIG_PIN`(MPL-2.0), `docs/PATH_1_5_STABILIZATION.md:421, 474-480` |
| UI 코드 | `overlay/JS/*.uc.js` + CSS를 프로필에 넣는 방식 | [확인] `ideas/confirmed/FIREFOX_SHELL_ROADMAP.md` Path 2 표 "Chrome JS baseline" |
| Node 런타임 | 브리지에 Node 24.22.1 고정. `install-egdesk-node.mjs`가 nodejs.org 배포본을 내려받고 6개 배포본(darwin/linux/win × x64/arm64) SHA-256을 대조해 앱 폴더에 설치. 런처는 고정 Node가 아니면 그 Node로 다시 실행 | [확인] `.node-version` = `24.22.1`, `scripts/install-egdesk-node.mjs:11-20`, `run-egdesk-windows.mjs`의 `shouldRelaunchWithPinnedNode`, `assertPatchedSqliteRuntime`(node:sqlite 필요) |
| 브리지 | `helper/codex-bridge-server.mjs`, `127.0.0.1:39218`; Codex app-server는 `39219` 별도 | [확인] `run-egdesk-windows.mjs:19`, `PATH_1_5_STABILIZATION.md:137-146` |
| 터미널 | 제품 경로는 Node HTTP + `node-pty` 1.1.0(Windows ConPTY). Rust/WebSocket `39300` 경로는 "historical candidate" | [확인] `PATH_1_5_STABILIZATION.md:138-145, 375` |
| 첫 실행 점검 (RT-01) | `verify-clean-profile-boot.mjs`: 임시 프로필 → 격리 브리지 → Firefox → Desk 확인 → 종료 → 포트 해제 → 영수증. 가짜 프로세스 단위 시험만 있음 | [확인] 원장 155행. 실제 Firefox로 돌린 기록은 [미확인] |
| 패키징 산출물 | 없음. `apps/firefox-ui-demo/packaging/` 폴더도 없음. `helper/egdesk-portable-bundle.mjs`는 데이터 내보내기 형식이지 앱 패키지가 아님 | [확인] 원장 RT-02 근거, `ls` 결과 |

### 1.2 네이티브 코드 (RT-04)

| 구성 | 현재 | 근거 |
|---|---|---|
| `helper-rust/` (`egdesk-helper` 0.1.0) | 하위 명령 없음 = WebSocket PTY(portable-pty 0.8), `host-observe` = macOS 관찰 전용(앞 앱·실행 앱·창·권한 미리보기, 입력·캡처 없음). `src/main.rs` 558줄, `src/auth.rs`, `src/host/{macos,protocol,server}.rs`. release 프로필 `opt-level="z"`, `lto`, `strip` | [확인] `helper-rust/Cargo.toml`, `src/main.rs:21-41`, 원장 160행 |
| `helper-rust/terminal-worker` | 실험용 Windows ConPTY 드라이버 (`egdesk-terminal-worker`) | [확인] Cargo.toml, `helper/terminal-rust-process.mjs` "Experimental only"(원장 RT-04) |
| 그 밖의 네이티브 | `helper/macos-gesture-helper`(Swift/ObjC), `helper/posix-file-helper`(C+Rust) 별도 | [확인] `ls helper` |
| tray·전역 단축키·file-watch | 구현 없음 | [확인] 원장 RT-04 |
| 결정됨 | D-C1: Mac 조작(관찰) 도우미는 이 Rust 도우미에 합친다. 권한은 별도 도우미 .app만 받는다(REA 9) | [확인] 원장 430행 |

### 1.3 Path 2 진입 조건

[확인] `PATH_1_5_STABILIZATION.md:168-184`: ROADMAP Path 1.5 체크리스트 80% 이상, 남은 틈을 `packaging blocker`/`deferred`로 분류, "Path 2 packaging start"는 아직 보류 목록. `FIREFOX_SHELL_ROADMAP.md` Path 2 산출물: win64 exe / mac-arm64 dmg / linux AppImage, Firefox Stable 또는 ESR 재패키징 + `config.js` + `defaults/pref/`, 브랜딩 교체, Bun 런타임(~90MB), Rust helper(PTY+tray+hotkey+file-watch), 자체 updater. Gating 체크박스 9개 모두 미체크.

주의(개념 구분): "Firefox 재패키징"(Mozilla가 빌드한 바이너리에 파일을 더해 다시 묶음)과 "Firefox 포크 빌드"(mozilla-central을 직접 빌드)는 비용·서명·업데이트가 완전히 다르다. 아래 D-R4 선택지는 이 구분을 기준으로 나눴다. 또 ROADMAP의 "Bun 런타임"(mini-app용)과 현재 브리지의 "Node 24 런타임"은 서로 다른 것이다. 현재 코드가 실제로 요구하는 것은 Node(node:sqlite)다.

---

## 2. 대표님 결정과 선택지

### D-R4 — 패키징 경로

| 안 | 내용 | 비고 |
|---|---|---|
| **R4-A 재패키징** | Mozilla 공식 Firefox(ESR 또는 Stable) 바이너리를 받아 `config.js`·`defaults/pref/`·고정 fx-autoconfig·overlay 프로필을 넣고, 전용 `-profile`로 띄우는 런처 + 설치 프로그램으로 감싼다 | ROADMAP Path 2 구상과 같음. 지금 `install.sh`가 하는 일을 "사용자 Firefox"가 아닌 "동봉 Firefox"에 하는 것 |
| **R4-B 포크 빌드** | mozilla-central(또는 ESR 브랜치)을 직접 빌드, `browser/branding/` 교체, 필요시 패치 | 브랜딩·업데이트(AUS) 완전 제어. 빌드 인프라 비용이 가장 큼 |
| **R4-C 지금 방식 유지 + 설치 도우미** | 사용자 Firefox 설치는 그대로 두고, 전용 프로필·로더·Node·helper를 한 번에 까는 설치 도우미만 제공 | RT-02 목표("Firefox를 따로 깔지 않고")는 충족 못 함. 개인 사용(D-S6)이면 충분할 수 있음 |

### D-R5 — 업데이트 방식

| 안 | 내용 |
|---|---|
| **R5-A 자체 updater** | 서명된 manifest(버전·SHA-256)를 확인 → 앱 묶음(overlay·helper·Node, 필요시 Firefox) 내려받기 → 원자적 교체 → 재시작. Firefox 자체 업데이트는 policy로 끄고 EGDesk 릴리스에 묶음 |
| **R5-B Firefox는 Mozilla 채널, EGDesk 층만 자체 갱신** | Firefox는 Mozilla 업데이트로 계속 올라가고, EG-Desk overlay·helper만 별도 갱신. 단 `config.js`가 Firefox 설치 폴더에 있어 Firefox 업데이트가 이를 지우거나 overlay와 호환이 깨질 수 있음 [미확인: 업데이트 시 `config.js` 유지 여부] |
| **R5-C 수동 재설치(설치 파일 교체)** | 자동 갱신 없음. 새 설치 파일을 받아 덮어씀. 초기 알파·소수 테스터용 |

(참고: R4-B를 고르면 Firefox AUS/MAR 방식 자체 서버도 선택지가 된다. ROADMAP도 "Firefox AUS 프로토콜 또는 자체 구현"으로 적어 둠.)

### D-R6 — Rust 통합 범위 (터미널/Node 동봉·트레이)

| 안 | 내용 | Node 동봉 |
|---|---|---|
| **R6-A 최소** | 터미널은 Node `node-pty` 유지. Rust helper는 이미 정한 Mac 관찰(host-observe)만, 나중에 tray·단축키 추가 | 필요(브리지 + node-pty 네이티브 모듈) |
| **R6-B 중간** | 터미널(PTY)을 Rust helper로 옮기고(Windows ConPTY는 terminal-worker, Mac/Linux는 portable-pty), tray·전역 단축키도 helper에. 브리지(채팅 저장소·SQLite 등)는 Node 유지 | 여전히 필요(브리지). 단 node-pty 네이티브 빌드 부담은 사라짐 |
| **R6-C 전면** | 브리지까지 Rust로 옮겨 Node 런타임 동봉을 없앰. gesture·file helper도 하위 명령으로 흡수 | 불필요. 대신 `helper/*.mjs` 상당 부분 재작성 (XL 이상) |

---

## 3. 트레이드오프

| 축 | 내용 |
|---|---|
| **빌드 비용** | R4-A: 공식 바이너리 + 파일 추가라 빌드 서버 부담 작음. 단 OS별 설치 파일 도구(NSIS/WiX/MSIX, dmg, AppImage 중 택)는 필요 [미확인: 도구 미선정]. R4-B: Firefox 전체 빌드는 OS마다 강한 빌드 머신·CI와 수 시간 단위 빌드가 필요하다고 알려져 있음 [미확인: 시간·비용 수치]. R6-B/C는 Rust 교차 빌드(Windows MSVC, macOS arm64/x64, Linux)가 추가됨. R6-A는 `node-pty`를 OS·아키텍처별로 미리 빌드해 동봉해야 함 |
| **서명·공증** | 세 안 모두 배포형이면 Windows Authenticode, macOS Developer ID 서명 + 공증이 사실상 필요(SmartScreen·Gatekeeper). Mac은 Firefox.app 안에 파일(`config.js` 등)을 넣는 순간 Mozilla 서명이 깨지므로 R4-A도 **앱 전체를 우리 인증서로 다시 서명**해야 함 [미확인: 재서명 시 Firefox 하위 바이너리·entitlement 처리]. 별도 helper .app 권한 분리(REA 9)는 helper도 독립 서명이 필요함을 뜻함. 인증서·계정 비용 [미확인] |
| **Firefox ESR 번들·라이선스** | Firefox 소스는 MPL-2.0, fx-autoconfig도 MPL-2.0 [확인: `FX_AUTOCONFIG_PIN.license`]. 수정 파일 소스 공개 의무 범위는 [미확인]. "Firefox" 이름·로고는 Mozilla 상표 정책 대상이라, 수정본을 "Firefox"로 부르거나 공식 로고를 쓰는 것이 제한될 수 있음 [미확인: 현행 정책 문구]. ROADMAP은 "EGDesk 단독명 + Built on Mozilla Firefox 고지"와 trademark audit 1회를 게이트로 둠 [확인]. ESR은 주기가 길어 overlay(`*.uc.js`)가 내부 API 변경에 덜 깨짐; Stable은 최신 기능·보안이지만 4주 정도 주기로 overlay 회귀 위험 [미확인: 현재 주기]. 현재 검증 기록은 Firefox 158.0/158.0.1(Stable)뿐 [확인: `PATH_1_5_STABILIZATION.md:325, 480`] → ESR에서 overlay가 도는지 **미검증** |
| **업데이트 방식** | R5-A: 버전 조합(Firefox×overlay×helper×Node)을 우리가 고정하므로 호환 보장이 쉬움, 대신 Firefox 보안 패치를 우리가 따라가야 함. R5-B: 보안 패치는 자동이지만 overlay 호환·`config.js` 유지가 우리 통제 밖. R5-C: 구현 0, 사용자 부담 큼. 업데이트 파일 자체도 서명 검증 필요 |
| **OS 범위** | 현재 런처는 Windows 전용(`run-egdesk-windows.mjs`), 터미널 제품 경로 검증도 Windows [확인]. Mac은 host-observe·gesture helper·현재 개발 프로필이 있음 [확인: 원장 160행, `PATH_1_5_STABILIZATION.md:480`]. Linux는 Node 배포본 checksum만 있고 실행 검증 기록 없음 [확인: 기록 없음]. OS 하나 추가마다 서명·설치 파일·CI가 하나씩 늘어남 |

---

## 4. 권고 기본값

- **[권고] D-R4 = R4-A (Firefox ESR 재패키징), Windows 먼저.** 이유: 현재 `install.sh`/`install.bat`·고정 로더·전용 프로필 런처를 그대로 옮기면 되고, 포크 빌드 인프라가 필요 없음. ESR은 overlay 회귀 위험을 줄임. 단 ESR에서 overlay가 도는지 먼저 RT-01 점검으로 확인하고, 깨지면 Stable 고정 버전으로 대체. 개인 사용만 할 거라면 R4-C로 충분하다는 것도 같이 확인 필요(D-S6과 연결).
- **[권고] D-R5 = 처음엔 R5-C(수동 재설치), 테스터 배포 시점에 R5-A(자체 updater, Firefox 업데이트는 policy로 끔).** 이유: 버전 조합을 고정해야 RT-01 점검 결과가 의미가 있음. R5-B는 `config.js` 유지·overlay 호환이 보장되지 않아 비권장.
- **[권고] D-R6 = R6-B (PTY·tray·단축키를 Rust helper로, 브리지는 Node 유지 → Node 24.22.1 동봉).** 이유: Node 동봉은 이미 `install-egdesk-node.mjs`로 checksum 고정 설치가 되어 있어 위험이 작고, node-pty 네이티브 모듈 OS별 빌드는 없앨 수 있음. 브리지 Rust 전면 이전(R6-C)은 범위가 너무 큼. 단 터미널 이전은 `scripts/benchmark-windows-terminal.mjs` 결과를 기록한 뒤에만(원장 RT-04 구현 스케치). 결과 전까지는 R6-A로 동작.

---

## 5. 순서별 단계

표기: **[로컬]** 이 PC에서 계정·인증서 없이 확인 가능 / **[계정]** 인증서·개발자 계정·외부 서비스 필요 / **[실기]** 깨끗한 실제 기기·VM 필요.

1. **[로컬]** RT-01 점검을 실제 Firefox로 1회 실행해 영수증 확보 (`verify-clean-profile-boot.mjs --fetch-pinned-loader`). Path 2 진입 게이트의 전제.
2. **[로컬]** ROADMAP Path 1.5 체크리스트 달성률 계산, 남은 틈을 `packaging blocker`/`deferred`로 분류 (`PATH_1_5_STABILIZATION.md` Gate To Path 2).
3. **[로컬]** 대표님 결정 D-R4~R6 기록(원장은 별도 작업에서 갱신).
4. **[로컬]** Firefox ESR 바이너리로 같은 RT-01 점검 실행 → overlay 호환 확인. 실패하면 Stable 고정 버전으로 대체.
5. **[로컬]** `apps/firefox-ui-demo/packaging/` 시작: Windows용 재패키징 스크립트(ESR 압축 해제 → `config.js`·`defaults/pref/` → 번들 프로필 → Node 24.22.1 → helper 바이너리), 출력은 서명 안 한 폴더. 단위 시험은 파일 목록·해시 대조.
6. **[로컬]** 런처를 "동봉 Firefox + 동봉 Node" 경로로 바꾸는 변형 추가(`run-egdesk-windows.mjs`의 `%ProgramFiles%` 고정 경로를 설정 가능하게). 미서명 폴더로 RT-01 점검.
7. **[로컬/Windows 실기]** `scripts/benchmark-windows-terminal.mjs` 결과 기록 → D-R6 터미널 이전 여부 확정. 이전 시 terminal-worker 규약을 `egdesk-helper`로 합치고 tray·단축키 추가.
8. **[로컬]** Firefox 자체 업데이트 끄는 policy와 수동 재설치(R5-C) 절차 문서화.
9. **[계정]** 상표 검토: 앱 이름·아이콘·"Built on Mozilla Firefox" 문구를 Mozilla 정책 원문과 대조(외부 확인, 필요시 문의).
10. **[계정]** Windows Authenticode 인증서 확보 → 설치 파일·exe·helper 서명.
11. **[실기]** 깨끗한 Windows 기기(또는 VM)에서 설치 → 첫 실행 → RT-01 점검 → 제거.
12. **[계정]** macOS: Apple Developer 계정 → Firefox.app 재서명 + helper .app 별도 서명 + 공증 → dmg. **[실기]** 깨끗한 Mac에서 Gatekeeper 통과 확인.
13. **[계정]** 자체 updater(R5-A): 서명 키 관리, manifest 배포 위치(호스팅) 결정, 업데이트 파일 서명.
14. **[계정/실기]** CI 빌드(OS별 러너), Linux AppImage는 그 다음. ROADMAP Path 2 gating(8시간 연속·메모리 <2GB·시작 <5초) 측정.

---

## 6. 미확인 목록

- Firefox ESR에서 현재 overlay·fx-autoconfig `dfdab56` 동작 여부.
- Mozilla 상표 정책·MPL-2.0 소스 공개 의무의 구체 범위.
- Authenticode·Apple Developer 비용과 macOS에서 수정된 Firefox.app 재서명·공증 절차의 세부.
- Firefox 업데이트가 설치 폴더의 `config.js`를 보존하는지.
- `verify-clean-profile-boot.mjs`의 실제 Firefox 실행 결과(현재 단위 시험만).
- Rust 터미널 벤치마크 결과(기록 없음), Linux 실행 검증(기록 없음).
