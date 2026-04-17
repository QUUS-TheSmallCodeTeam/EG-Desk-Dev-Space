# Firefox UI 커스터마이징 경로 조사 (2026-04-17)

## 배경

EG-Desk의 `browser-in-canvas` POC (Electron OSR + shared texture)는 근본적인 한계에 부딪혔다:

- 브라우저 popup / context menu 를 캔버스 안에 그리는 방법 없음
- IME (한글) 가 OSR surface 에서 작동하지 않음
- `file chooser`, `<input type="file">` 이 호스트 윈도우에 뜨지 않음
- focus ring, DevTools, 크래시 복구 같은 "진짜 브라우저 기능"이 OSR 렌더에서 결여

Codex와 상의한 결과: **"Firefox는 JS로 UI를 조작하면서도 full browser capabilities를 유지한다"**. 이 주장의 정체를 규명한 리서치 결과.

## 경로별 상태

| 경로 | 2026 상태 | 데모 가능 |
|------|-----------|-----------|
| autoconfig (`mozilla.cfg` + `local-settings.js`) | ✅ 공식 지원, Mozilla 2026-01-21 문서 업데이트 | ✅ |
| userChrome.js 로더 (fx-autoconfig) | ✅ **MrOtherGuy/fx-autoconfig** v0.10.0 active | ✅ |
| userChrome.js 로더 (xiaoxiaoflood) | ⚠️ semi-active (Firefox 131 beta 까지 테스트) | ✅ |
| userChrome.js 로더 (alice0775) | ❌ Firefox 72/73에서 멈춤 (2020) | ❌ |
| `browser.xhtml` 파일 자체 교체 | ❌ `omni.ja` 내부 — runtime 교체 불가 | ❌ |
| `firefox --chrome chrome://...` 커맨드라인 | ❌ XULRunner 유물, 공식 문서에서 빠짐 | ❌ |
| Firefox fork (Zen / Floorp) | ✅ patch-and-rebuild, 정석 | ⚠️ 복잡 |
| GeckoView 데스크톱 | ❌ Android 전용, 데스크톱 빌드 없음 | ❌ |
| Positron (Gecko-as-Electron) | ❌ 2017-03 discontinued | ❌ |
| Servo embedding | ⚠️ 실험적, 2020 이후 Linux Foundation 이관 | ❌ |
| Gecko embedding 공식 경로 | ❌ 존재하지 않음 | ❌ |

## 선택한 경로: fx-autoconfig

**이유**:
- Zero-build, 5분 안에 데모 가능
- 파일 8개 정도 배치하면 끝
- `ChromeUtils`, `Services` 전체 API 접근 가능
- Firefox 업데이트 따라 로더가 작동 (MrOtherGuy 활발히 관리)
- Gecko 코어는 건드리지 않으므로 brower capabilities 모두 유지

**제약**:
- Firefox 인스톨 디렉터리에 쓰기 필요 (관리자 권한)
- Firefox 업데이트 시 인스톨 디렉터리 파일 덮어쓰일 수 있음 → 업데이트 후 재설치
- Firefox 140 ESR 에서 `XPCOMUtils.defineLazyGetter` 제거 — 일부 로더 코드에서 이슈 가능
- 구조적 UX (새 윈도우 타입, 새 chrome process) 는 runtime injection 으로 한계. Zen 처럼 fork 필요

## Zen Browser 구조 요약

Zen (`zen-browser/desktop`) 은 이 데모가 보여주는 것보다 훨씬 큰 UX 변경을 했다. 구조:

```
zen-browser/desktop/
├── src/
│   ├── zen/                              신규 모듈 (workspaces, tabs, glance, compact, split)
│   │   ├── spaces/                       workspaces 구현
│   │   ├── tabs/                         수직 탭
│   │   └── zen.globals.mjs               300+ global 등록
│   └── browser/base/content/
│       ├── browser-xhtml.patch           ← Firefox browser.xhtml 패치
│       ├── browser-js.patch              ← browser.js 패치
│       └── zen-*.inc.xhtml               삽입되는 fragment
└── surfer.json                           빌드 툴 설정
```

**빌드 툴**: [Surfer](https://github.com/zen-browser/surfer) — Firefox 소스 자동 다운로드, `.patch` 적용, `npm run export` 로 수정 파일을 patch 로 뽑아냄. Dot Browser 의 Melon 에서 파생.

**언어 비율**: JS 35%, Fluent 28.9%, C++ 27.7%, CSS 4.8% — 대부분 JS/CSS 이지만 C++ hook 도 있음.

**현재 베이스**: Firefox 149.0.2 기반 (2026-04 시점 추정).

## 의사결정용 정리

| 목표 | 추천 경로 |
|------|----------|
| POC / 데모 | **fx-autoconfig** (이 앱) |
| 상용 배포 + 깊은 UX | **Zen 방식 fork (Surfer)** |
| Electron 대체로 "HTML 앱만 돌리기" | **경로 없음** — Electron 유지하거나 Tauri |

## 검증된 것

- 우리의 `eg-desk-sidebar.uc.js` 가 실제 Firefox 에서 DOM 에 접근 가능
- `#TabsToolbar` 를 숨기고 사이드바를 그리는 수준의 재구성 가능
- `gBrowser.addTab(url)` / `gBrowser.selectedTab` 같은 내부 API 호출로 실제 탭 제어 가능
- 우클릭 / IME / 파일업로드 / 확장 / DevTools / WebRTC — 전부 유지

## 검증 안 된 것 (후속 조사 필요)

- Firefox 140+ ESR 에서 fx-autoconfig 호환성 (`XPCOMUtils.defineLazyGetter` 이슈)
- Firefox 업데이트 후 인스톨 디렉터리 파일이 덮어쓰여지는 주기 / 실패 모드
- 수직 탭 + workspaces UX 를 runtime injection 만으로 Zen 수준까지 구현 가능한 한계

## 소스

- [Mozilla Support - AutoConfig (2026-01-21)](https://support.mozilla.org/en-US/kb/customizing-firefox-using-autoconfig)
- [MrOtherGuy/fx-autoconfig](https://github.com/MrOtherGuy/fx-autoconfig)
- [xiaoxiaoflood/firefox-scripts](https://github.com/xiaoxiaoflood/firefox-scripts)
- [aminomancer/uc.css.js](https://github.com/aminomancer/uc.css.js)
- [userchrome.org](https://www.userchrome.org/what-is-userchrome-js.html)
- [Zen Browser - Code Structure](https://docs.zen-browser.app/contribute/desktop/code-structure-and-prefs)
- [zen-browser/desktop](https://github.com/zen-browser/desktop)
- [zen-browser/surfer](https://github.com/zen-browser/surfer)
- [Floorp-Projects/Floorp](https://github.com/Floorp-Projects/Floorp)
- [GeckoView](https://mozilla.github.io/geckoview/)
- [Mykzilla - Positron Discontinued](https://mykzilla.org/2017/03/08/positron-discontinued/)
- [Mozilla Wiki - CommandLineOptions](https://wiki.mozilla.org/Firefox/CommandLineOptions)
- [ghacks - Firefox 140 ESR](https://www.ghacks.net/2025/06/24/firefox-140-ships-with-unload-tab-feature-and-new-esr-base/)
