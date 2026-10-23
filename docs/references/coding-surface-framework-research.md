# EG-Desk 코딩 화면 프레임워크 선택 (CODE-01)

- 작성: 2026-10-24 · 기준 시점: 2026-10 · 상태: 조사 완료, EG-Desk 안에서 실행해 확인한 것은 아직 없음
- 읽을 사람: 다음 구현을 지휘할 Main 개발자, 결정이 필요한 부분은 대표님
- 관련 원장 항목: CODE-01~07, CTX-04 (`ideas/confirmed/EGDESK_VISION_GAP_LEDGER.md`)
- 표기: **[공식]** 라이브러리·Firefox·Codex의 공식 문서나 소스 / **[외부 측정]** 제3자 도구가 잰 수치 / **[제안]** 이 문서가 권하는 설계(구현·검증 전) / **(추정)** 근거가 간접적인 판단. EG-Desk에서 실제로 돌려 본 **[런타임]** 근거는 아직 없다(RAM 제약으로 Firefox를 띄우지 않았다).

---

## 1. 결론과 권고

**1순위: CodeMirror 6 + `@codemirror/merge`로 편집기와 변경 비교를 만든다. Codex가 보내는 unified diff는 `diff`(jsdiff)로 읽고 적용한다. 파일 트리는 지금 있는 자체 트리를 계속 쓴다.**

이유 다섯 가지.

1. **Firefox가 자기 화면에서 같은 방식으로 쓰고 있다.** Firefox DevTools의 Debugger 편집기는 CodeMirror 6이다. 묶음 파일 하나를 `ChromeUtils.importESModule(..., { global: "current" })`로 privileged 문서에 올린다. EG-Desk의 overlay도 같은 privileged chrome이라 같은 길을 그대로 쓸 수 있다. [공식] (출처는 2.1)
2. **가볍다.** 언어 5종을 넣은 Firefox의 CodeMirror 6 묶음은 588KB(압축 시 196KB)다. Monaco는 편집기 본체 묶음 하나만 2.47MB이고, 여기에 CSS 391KB와 worker 276KB가 더 붙는다. RAM 16GB 기기에서 메모리 압박이 큰 EG-Desk에는 이 차이가 크다. [공식·외부 측정]
3. **라이선스가 깨끗하다.** CodeMirror와 `@codemirror/merge`는 MIT, jsdiff는 BSD-3-Clause다. ADR-002 기준 Green이라 별도 승인 없이 넣을 수 있다. 저작권 표기만 남기면 된다. [공식]
4. **EG-Desk 캔버스와 맞는다.** 카드가 CSS `scale()`로 줌되는데, CodeMirror는 6.18(2023-09)부터 CSS 배율 조정을 공식 지원한다. 2026-09에도 Firefox 한글 조합 입력 관련 수정이 들어갔다. [공식]
5. **Codex 데이터와 바로 이어진다.** Codex app-server는 파일 변경을 unified diff 텍스트로 보낸다. jsdiff `applyPatch`로 "고치기 전/고친 후" 두 본문을 만들면 `@codemirror/merge`가 그대로 받는다. 승인 전에 보여 주고(읽기 전용), 나중에 덩어리별 수락/거절로 넓히는 길도 API에 이미 있다. [공식]

**Monaco는 보류한다(2순위).** VS Code급 자동완성과 TypeScript 언어 서비스가 꼭 필요해질 때만 다시 검토한다. 보류하는 이유는 세 가지다.
- 0.53부터 AMD 빌드가 지원 중단되었다. ESM은 번들러 사용이 전제다.
- diff 계산 등을 web worker에서 돌린다. Firefox chrome CSP(`script-src chrome: moz-src: resource:`) 아래에서 worker를 띄울 수 있는지 아직 확인되지 않았다.
- 크기가 CodeMirror의 4~6배다.

**넣는 방식 [제안]:**
- vendor 폴더에 단일 ES module 묶음을 둔다.
- 창(window) 전역으로 불러온다. Firefox DevTools와 같은 방식이다.
- 파일 창(File Card) 코드에는 "편집기 만들기" 함수를 주입한다. 지금 `document`·`service`를 주입하는 방식을 그대로 따른다.

**순서 [제안]:**

| 단계 | 내용 | 원장 항목 |
|---|---|---|
| 0 | 묶음 만들기·로드 확인 | CODE-01 마무리 |
| 1 | 읽기 전용 변경 비교 | CODE-05 |
| 2 | 편집기 교체 | CODE-04, CODE-03 일부 |
| 3 | 테스트·리뷰 결과 카드와 IDE 진입 | CODE-06, CODE-07 |

---

## 2. 대표님 결정이 필요한 것

| # | 결정할 것 | 권고 | 결정이 없으면 |
|---|---|---|---|
| D1 | 확정 문서 CONTRACT의 텍스트 편집기 기준선을 **Monaco ESM에서 CodeMirror 6으로** 바꾼다. 해당 위치는 `EGDESK_INTERACTION_AND_ORCHESTRATION_CONTRACT.md` L2119 "선택 기준선은 텍스트 Monaco ESM…"과 L2409 "Monaco의 screen-reader 모드…"다. 이 문장들은 원래 "실제 설치·성능·지원의 증거가 아니다"라고 단서를 단 기준선이다. | **승인.** Monaco는 "LSP급 기능 필요 시 재검토"로 남긴다. | 0단계(묶음·로드 확인)는 결정 없이 진행할 수 있다. 1단계부터는 확정 문서와 구현이 어긋난다. |
| D2 | 에이전트가 고친 **변경 내용(diff)을 대화 기록에 남길지**. 지금 코드는 diff와 명령 출력을 의도적으로 기록·전송에서 뺀다(`helper/codex-chat-runtime.mjs` L42-43 주석). | **기본값: 남기지 않는다.** 대화 기록에는 지금처럼 파일 목록만 남긴다. 내용은 화면에서 볼 때만 상한을 두고 가져온다. 이의가 없으면 이 기본값으로 진행한다. | 기본값으로 진행한다. |

이 선택과 이어진, 원장에 이미 올라 있는 결정도 있다. 2단계를 시작하기 전에 필요하다.
- **CODE-04**: EG-Desk가 원본 파일을 덮어써도 되는가(안 됨 / 사용자가 저장할 때만 / 에이전트 승인으로도). 외부에서 파일이 바뀐 경우의 충돌 규칙.
- **CODE-02**: 프로젝트 폴더를 Board에 붙이는가, 채팅방에 붙이는가, 둘 다인가.

참고(결정 아님): CodeMirror 홈페이지는 "상업적으로 쓰면 유지보수 후원을 기대한다(법적 의무 아님)"고 적고 있다. [공식] <https://codemirror.net/>

---

## 3. 근거

### 3.1 Firefox privileged chrome에서 돌아가는가

| 확인한 것 | 내용 | 출처 |
|---|---|---|
| Firefox 자체 사용 | DevTools 공용 편집기가 CodeMirror 6 묶음을 `this.#win.ChromeUtils.importESModule("resource://devtools/client/shared/sourceeditor/codemirror6/codemirror6.bundle.mjs", { global: "current" })`로 불러온다. [공식] | [editor.js L795-797](https://searchfox.org/firefox-main/source/devtools/client/shared/sourceeditor/editor.js) |
| Debugger 기본값 | Debugger 본 편집기를 `createEditor({ cm6: true })`로 만든다. [공식] | [debugger/src/utils/editor/index.js L18](https://searchfox.org/firefox-main/source/devtools/client/debugger/src/utils/editor/index.js) |
| 묶음 만드는 법 | rollup으로 단일 `.mjs`를 만든다. 진입 파일에서 필요한 패키지를 다시 export하는 구조다. [공식] | [sourceeditor/README](https://searchfox.org/firefox-main/source/devtools/client/shared/sourceeditor/README) |
| 묶음 크기 | Firefox main의 `codemirror6.bundle.mjs`(언어 5종 + 자동완성 + 검색): 588,617 bytes, gzip 196,404 bytes. 내려받아 직접 쟀다. 같은 파일에서 `eval(`·`new Function`은 0건이다. | 같은 폴더 |
| browser.xhtml CSP | `script-src chrome: moz-src: resource:; frame-src chrome:; object-src 'none';` 스크립트는 chrome:/resource: 출처만 허용되고 eval과 inline script는 막힌다. `style-src` 제한은 없어서 CodeMirror의 동적 스타일 주입(`adoptedStyleSheets`·`<style>`)은 막히지 않는다. [공식] | [browser.xhtml L25](https://searchfox.org/firefox-main/source/browser/base/content/browser.xhtml) |
| `global: "current"` 옵션 | 모듈을 공유 system 전역이 아니라 **호출한 창의 전역**에 올린다. CodeMirror는 `document`·`navigator` 같은 창 전역을 쓴다(묶음 안에 `document.` 62회). 그래서 지금 `.sys.mjs`처럼 기본(공유 전역)으로 불러오면 위험하다. [공식] | [JS Loader APIs](https://firefox-source-docs.mozilla.org/jsloader/jsloader-api.html), [System Modules](https://firefox-source-docs.mozilla.org/jsloader/system-modules.html) |
| innerHTML 정화 | privileged 문서에서 `innerHTML`은 Firefox 내장 sanitizer를 거친다. HTML 문자열을 만들어 넣는 diff 렌더러(diff2html)는 이 경로를 탄다. CodeMirror는 DOM을 직접 만든다. [공식] | [Mozilla 보안 블로그 2019](https://blog.mozilla.org/attack-and-defense/2019/12/02/help-test-firefoxs-built-in-html-sanitizer-to-protect-against-uxss-bugs/) |
| eval 예외 | userChromeJS를 쓰는 환경에서는 browser.xhtml의 eval을 허용하는 예외가 있다(Bug 1958232, Fx139). 예외 동작이라 의존하지 않는다. eval이 없는 라이브러리를 고르는 편이 안전하다. [공식] | [Bug 1958232](https://bugzilla.mozilla.org/show_bug.cgi?id=1958232) |

EG-Desk의 현재 구조 [공식: 저장소 코드]:
- overlay 파일은 `chrome://userchrome/content/`로 서비스된다. 여기에는 `.sys.mjs`와 `vendor/xterm.min.js`가 포함된다.
- `EGDeskFileView.sys.mjs`는 기본(공유 전역)으로 import되고 `document`를 주입받는다(`overlay/JS/eg-desk-surface.uc.js` L9968 부근).
- 터미널은 키 입력을 격리하려고 chrome:// iframe 안에서 xterm을 돌린다(같은 파일 L13078).
- 캔버스 레이어는 `translate(...) scale(zoom)`으로 줌된다(L13967).
- vendor 폴더에는 xterm 5.5.0(jsDelivr에서 받음)만 있고, 라이선스 표기나 버전 기록은 없다.

**Monaco를 같은 자리에 넣을 때의 걸림돌** (추정, 실측 없음):
- 0.53부터 AMD 빌드가 지원 중단되어 ESM과 번들러가 필요하다. [공식] [Monaco CHANGELOG](https://github.com/microsoft/monaco-editor/blob/main/CHANGELOG.md)
- Monaco는 diff 계산 등을 `editor.worker`에서 한다. CSP에 `worker-src`가 없으면 `script-src`를 따르므로 blob: worker는 막힌다. chrome:// URL worker가 이 문서에서 Monaco 방식대로 동작하는지는 확인하지 못했다.
- 0.53에서 추가된 EditContext 지원에 대해 MDN은 "Limited availability, Experimental"이라고 적는다. Firefox가 이 API를 지원하는지는 확인하지 못했다. 지원하지 않으면 예전 입력 경로를 쓰게 된다. [MDN EditContext](https://developer.mozilla.org/en-US/docs/Web/API/EditContext_API)
- CSS 배율 조정 안에서 클릭 위치가 어긋났다는 보고가 있다. 다만 오래된 0.9.0 버전 기준이고 현재 상태는 확인하지 못했다. [Lightrun 사본](https://lightrun.com/answers/microsoft-monaco-editor-problem-with-scale3d)

### 3.2 크기와 메모리 (RAM 16GB, 압박 큼)

| 묶음 | 압축 전(minified) | gzip | 출처 |
|---|---|---|---|
| CodeMirror `codemirror` 6.0.2 (기본 세트: view·state·language·commands·search·autocomplete·lint) | 373KB | 119KB | [외부 측정] [bundlephobia](https://bundlephobia.com/package/codemirror@6.0.2) |
| `@codemirror/merge` 6.12.3 (view·state·language 포함) | 292KB | 94KB | [외부 측정] bundlephobia |
| Firefox DevTools CM6 묶음 (언어 5종) | 589KB | 196KB | 직접 측정(위 3.1) |
| Monaco 0.57.0 편집기 본체 묶음 `min/vs/editor-*.js` | 2,472KB | — | [공식] jsDelivr 파일 목록 |
| Monaco CSS `editor.main.css` / `editor.worker` | 391KB / 276KB | — | 같음 |
| Monaco `min/` 전체 (151개 파일, TS·CSS·HTML 언어 worker 포함) | 25.6MB | — | 같음 |
| jsdiff `diff` 9.0.0 | 22.6KB | 7.9KB | [외부 측정] bundlephobia |
| diff2html 3.4.56 | 44.7KB | 12.7KB | [외부 측정] bundlephobia |

- 로컬 chrome:// 파일이므로 다운로드 크기보다 **파싱 비용과 상주 메모리**가 중요하다. CodeMirror는 화면에 보이는 줄만 DOM으로 그린다. 공식 예제는 수백만 줄 문서도 다룬다. [공식] [Huge Document 예제](https://codemirror.net/examples/million/)
- EG-Desk 묶음 크기 예상(추정): 기본 세트 + merge + 언어 5~6종 + jsdiff로 약 0.6~0.8MB(gzip 200~260KB). Monaco 최소 구성(본체·CSS·worker)은 3MB 이상이다.
- **메모리 실측은 아직 없다.** 0단계에서 파일 창 1개만 열고 `about:memory`로 잰다. 2026년 기준 두 편집기의 메모리를 비교한 믿을 만한 공개 벤치마크는 찾지 못했다. 참고로 Sourcegraph는 Monaco에서 CodeMirror로 옮긴 뒤 페이지 JS 다운로드가 43% 줄었다고 보고했다. 업체 블로그이고 편집기 단독 수치는 아니다. [Sourcegraph](https://sourcegraph.com/blog/migrating-monaco-codemirror)

### 3.3 라이선스 (ADR-002: Green만 코드·의존성 자유)

| 대상 | 라이선스 | ADR-002 | 메모 |
|---|---|---|---|
| CodeMirror 6 전 패키지, `@codemirror/merge`, `@lezer/*` | MIT | Green | [공식] npm registry |
| jsdiff `diff` | BSD-3-Clause | Green | [공식] npm registry |
| Monaco Editor | MIT | Green | 라이선스 문제는 없고 크기·worker 문제다. |
| diff2html, `@git-diff-view/core`, `@headless-tree/core`, react-arborist | MIT | Green | 아래 비교표에서 다른 이유로 탈락 |
| `@pierre/diffs` | Apache-2.0 | Green | Shiki 의존으로 무겁다(unpacked 11MB). |
| Theia (`references/theia`) | EPL-2.0 + GPL-2.0 w/ Classpath | **Red** | 개념 참고만 한다. Monaco 기반 전체 IDE에 Node 백엔드가 전제다. |
| Firefox DevTools의 `codemirror6/index.mjs`(진입 파일) | **MPL-2.0** | **Red** | **복사 금지.** 몇 줄짜리 re-export 파일이니 우리 진입 파일을 새로 쓴다. 안에 묶인 CodeMirror 코드 자체는 MIT다. |

필요한 조치(ADR-002 운영 규칙 1·2) [제안]:
- `overlay/resources/vendor/VENDOR.md` 하나에 패키지명·버전·받은 곳·라이선스·sha256을 적는다. xterm 5.5.0도 이번에 함께 적는다.
- 각 라이선스 원문(`LICENSE-codemirror.txt`, `LICENSE-diff.txt`)을 vendor 폴더에 둔다.

### 3.4 접근성·한글 입력(IME)

- **CodeMirror** [공식]
  - 홈페이지: "Works well with screen readers and keyboard-only users."
  - contenteditable 기반이다. 화면 읽기 프로그램용 안내 함수 `EditorView.announce`가 있다.
  - 2026년에도 조합 입력 수정이 계속 들어간다:
    - 6.43.12 (2026-09-15): "Work around an issue on Firefox where a composition might be started outside of a line container."
    - 같은 시기 VoiceOver 안내 누락 수정.
  - [CHANGELOG](https://code.haverbeke.berlin/codemirror/view/raw/branch/main/CHANGELOG.md)
- **Monaco** [공식]: screen-reader 모드가 있다. Firefox에서 한글 IME를 쓸 때의 상태는 확인한 공개 자료가 없다.
- **두 편집기 모두**, Firefox 158 + Windows MS 한글 IME / macOS 2벌식 조합은 **EG-Desk에서 직접 확인해야 한다**. 0단계 확인 항목에 넣었다.
- 지금 파일 창에는 조합 중 저장을 막는 처리가 들어 있다(`EGDeskFileView.sys.mjs` L401 부근 compositionstart/compositionend, keydown의 `isComposing || keyCode === 229` 가드). CodeMirror로 바꿔도 같은 규칙을 `view.composing`/`view.compositionStarted`로 이어 간다.

### 3.5 유지보수 활성도 (2026-10 기준, [공식] npm registry)

| 패키지 | 최신 | 날짜 | 2026년 릴리스 |
|---|---|---|---|
| `@codemirror/view` | 6.43.15 | 2026-10-19 | 30회 |
| `@codemirror/merge` | 6.12.3 | 2026-10-19 | 4회 |
| `@codemirror/state` / `language` / `search` | 6.7.6 / 6.13.1 / 6.7.2 | 2026-09-22 / 10-07 / 08-31 | — |
| `monaco-editor` | 0.57.0 | 2026-09-24 | 0.56.0(07-20), 0.57.0 |
| `diff` (jsdiff) | 9.0.0 | 2026-04-13 | — |
| `diff2html` | 3.4.56 | 2026-01-31 | — |

주의 [공식]: CodeMirror 저장소는 **2026-04-15에 GitHub에서 보관(archived) 처리되고 `code.haverbeke.berlin`으로 옮겨졌다.** npm 패키지의 repository 필드도 새 주소다. 개발이 멈춘 것이 아니라 호스팅만 옮긴 것이다(위 릴리스 기록 참고). 이슈와 변경 기록은 새 주소에서 본다. [GitHub codemirror/dev](https://github.com/codemirror/dev), [codemirror.net](https://codemirror.net/)

### 3.6 Codex app-server 데이터와 맞추기

| Codex가 주는 것 | 형태 | 출처 |
|---|---|---|
| `fileChange` 항목 | `{id, changes, status}`. `changes[]` = `FileUpdateChange { path, kind, diff }`, `kind` = `add` / `delete` / `update { move_path }` | [공식] [app-server 문서](https://learn.chatgpt.com/docs/app-server), [v2/item.rs](https://github.com/openai/codex/blob/main/codex-rs/app-server-protocol/src/protocol/v2/item.rs) |
| `diff` 내용 | **update면 unified diff 텍스트**다. 이동(move)이면 끝에 `"\n\nMoved to: <경로>"`가 붙는다. **add/delete면 파일 전체 본문**이다. | [공식] [item_builders.rs `format_file_change_diff`](https://github.com/openai/codex/blob/main/codex-rs/app-server-protocol/src/protocol/item_builders.rs) |
| `turn/diff/updated` | `{ threadId, turnId, diff }`. 한 회차의 모든 파일 변경을 합친 최신 unified diff | [공식] 문서, [v2/turn.rs](https://github.com/openai/codex/blob/main/codex-rs/app-server-protocol/src/protocol/v2/turn.rs) |
| 승인 순서 | `item/started`(제안된 changes, `inProgress`) → `item/fileChange/requestApproval` → 사용자 결정(accept / acceptForSession / decline / cancel) → `item/completed`. **승인 전에는 디스크에 원본이 그대로 있다.** | [공식] 문서 |
| 명령 출력 | `commandExecution.aggregatedOutput?` 그리고 `item/commandExecution/outputDelta { threadId, turnId, itemId, delta }` | [공식] 문서·item.rs |
| 파일 감시 | `fs/watch { watchId, path }` → `fs/changed { watchId, changedPaths }` (RT-06·CODE-03에 쓸 수 있음) | [공식] [v2/fs.rs](https://github.com/openai/codex/blob/main/codex-rs/app-server-protocol/src/protocol/v2/fs.rs) |

맞추는 방법 [제안]:
- **승인 전 보기(1단계):**
  - 원본 = 파일 서비스로 읽은 현재 디스크 본문
  - 제안본 = `applyPatch(원본, diff)` (jsdiff)
  - 이 두 본문으로 `unifiedMergeView({ original: 원본 })`를 읽기 전용으로 띄운다.
  - `applyPatch`가 실패하면(그 사이 파일이 바뀐 경우) 편집기 없이 hunk 목록만 보여 준다(`parsePatch` 결과).
- **완료 후 보기:**
  - 고친 후 = 디스크 본문
  - 원본 = `applyPatch(디스크 본문, reversePatch(parsePatch(diff)))`
- **add/delete:** diff 문자열이 전체 본문이므로 한쪽을 빈 문서로 둔다.
- **move:** 끝의 `Moved to:` 줄을 떼고 파싱한다.
- **turn 전체 diff:** `parsePatch`가 여러 파일을 배열로 돌려준다. 파일별 접이식 목록을 만든다.
- **확인 못 한 것:**
  - Codex의 update diff에 `---`/`+++` 머리줄이 있는지, `@@` hunk만 있는지 확인하지 못했다. jsdiff가 hunk만 있는 문자열을 받아들이는지도 0단계에서 fixture로 확인한다.
  - 위 소스는 openai/codex main(2026-10-24) 기준이다. 로컬 CLI는 `codex-cli 0.162.1`이다. 0단계에서 `codex app-server generate-json-schema --out <임시폴더>`로 설치된 버전의 실제 스키마와 맞춰 본다(모델 호출 없는 정적 생성).

---

## 4. 대안 비교

| 후보 | 맡을 일 | 라이선스 | 최근 릴리스 | 크기 | Firefox chrome 적합성 | IME·접근성 | Codex diff 연결 | 판정 |
|---|---|---|---|---|---|---|---|---|
| **CodeMirror 6 + `@codemirror/merge`** | 편집기, 읽기 전용 뷰어, 변경 비교(통합·좌우), 덩어리별 수락/거절 | MIT | view 6.43.15, merge 6.12.3 (둘 다 2026-10-19) | 기본 세트 373KB, Firefox 묶음 589KB | **Firefox DevTools가 같은 방식으로 사용**, eval 0, CSS 배율 조정 지원 | 화면 읽기 지원 명시, Firefox 조합 입력 수정 지속 | 두 본문 필요 → jsdiff로 생성 | **1순위 채택** |
| jsdiff (`diff`) | unified diff 해석·적용·역적용(`parsePatch`, `applyPatch`, `reversePatch`, `structuredPatch`) | BSD-3-Clause | 9.0.0 (2026-04-13) | 22.6KB | 순수 JS, DOM 없음 | 해당 없음 | **바로 맞음** | **보조 채택** |
| Monaco Editor (diff editor 포함) | 편집기, 좌우·인라인 diff, TS 언어 서비스·LSP | MIT | 0.57.0 (2026-09-24) | 본체 2.47MB + CSS 391KB + worker 276KB | AMD 중단·ESM 번들러 필요, worker 동작 미확인 | screen-reader 모드, Firefox 한글 IME 미확인 | 두 본문 필요(같음) | **보류**(LSP급 기능 필요 시 재검토). CONTRACT 현 기준선 |
| diff2html | unified diff → HTML(줄 단위·좌우) | MIT | 3.4.56 (2026-01-31) | 44.7KB (+hogan) | HTML 문자열을 `innerHTML`로 넣는 방식 → privileged 문서 sanitizer 경로, 편집 불가 | 자체 a11y 정보 없음 | unified diff 직접 입력 | **탈락**. 같은 일을 jsdiff + 자체 DOM으로 함 |
| `@git-diff-view/core` | diff 뷰 코어 | MIT | 0.1.8 (2026-10-15) | highlight.js·lowlight 의존 | 0.x, 프레임워크 패키지 중심 | — | 가능 | **탈락**(0.x, 하이라이터 이중화) |
| `@pierre/diffs` | diff 렌더러 | Apache-2.0 | 1.6.1 (2026-10-21) | unpacked 11MB, Shiki 의존 | 무거움 | — | 가능 | **탈락**(메모리) |
| Theia | 전체 IDE 프레임워크 | EPL/GPL (**Red**) | — | 매우 큼, Node 백엔드 | 부적합 | — | — | **탈락**(개념 참고만) |
| 자체 파일 트리 (현행) | 트리·이름 검색 | 우리 코드 | — | 0 | 이미 동작(`role="tree"`, 키보드) | 이미 반영 | 해당 없음 | **유지**·확장 |
| `@headless-tree/core` | 헤드리스 트리(가상 스크롤, 다중 선택, 끌어 놓기) | MIT | 1.8.0 (2026-10-15) | — | README가 "into React" 통합 중심. 바닐라 연결은 직접 해야 함 | aria 자동 | 해당 없음 | **보류**(다중 선택·끌어 놓기가 필요해지면) |
| react-arborist | React 트리 | MIT | 4.0.1 (2026-10-11) | — | overlay에 React 없음 | — | — | **탈락** |

테스트 결과 형식 [공식]: Node 내장 `node:test`의 reporter는 `spec`·`tap`·`dot`·`junit`·`lcov`이고, 기본값은 `spec`이다(v23부터 TTY 여부와 무관). EG-Desk 자체 테스트도 `node --test`다. 결과 카드의 첫 해석기는 **JUnit XML**(여러 러너가 공통으로 낼 수 있음, 러너별 지원은 개별 확인 필요)과 **TAP** 두 가지로 시작한다. [Node test reporters](https://nodejs.org/api/test.html#test-reporters)

---

## 5. EG-Desk에 넣는 구조 [제안]

```text
apps/firefox-ui-demo/
├── vendor-src/codemirror/          ← 새로: 묶음 원본(커밋 대상)
│   ├── package.json / package-lock.json   CodeMirror·merge·언어·diff 버전 고정
│   ├── entry.mjs                   우리가 새로 쓰는 re-export 진입 파일 (Firefox 것 복사 금지)
│   └── build.mjs                   rollup 또는 esbuild로 단일 파일 출력 (루트 node_modules에 이미 둘 다 있음)
└── overlay/resources/
    ├── vendor/
    │   ├── codemirror/egdesk-codemirror.bundle.mjs   ← 빌드 결과(단일 ES module, 동적 import 없음)
    │   ├── LICENSE-codemirror.txt, LICENSE-diff.txt
    │   └── VENDOR.md               패키지·버전·출처·라이선스·sha256 (xterm 5.5.0 포함)
    ├── EGDeskCodeEditor.mjs        ← 새로: 창 전역용 어댑터 (.sys.mjs 아님)
    │                                  createCodeEditor({ parent, text, language, readOnly, onChange })
    │                                  createDiffView({ parent, original, modified, mode, readOnly })
    │                                  parseUnifiedDiff(text) / buildProposed(original, diff)
    ├── EGDeskFileView.sys.mjs      ← 수정: textarea 대신 주입받은 codeEditor 사용 (DOM 주입 방식 유지)
    └── EGDeskDiffView.sys.mjs      ← 새로(선택): 승인 카드용 hunk 목록 DOM. 편집기 없이도 동작
```

불러오기:

```js
// eg-desk-surface.uc.js — 파일 창이나 변경 비교를 처음 열 때 한 번만 (지연 로드)
const CodeEditor = ChromeUtils.importESModule(
  'chrome://userchrome/content/EGDeskCodeEditor.mjs', { global: 'current' });
view = fileModule.createEGDeskFileView({ document, service, codeEditor: CodeEditor, ... });
```

규칙:
- **창 전역으로만 불러온다.** CodeMirror를 `.sys.mjs` 안에서 정적 import하면 공유 system 전역에 올라가 `document`·`navigator`가 없다. `EGDeskFileView.sys.mjs`는 지금처럼 DOM과 함수를 주입받는 순수 모듈로 남긴다. 그러면 기존 node 테스트 방식(가짜 document 주입)도 유지된다.
- **iframe은 쓰지 않는다.** 터미널은 xterm 키보드 처리 때문에 iframe을 썼다. CodeMirror는 일반 contenteditable이고, 지금 파일 창의 textarea처럼 같은 문서에서 Ctrl+S 등을 처리한다. 0단계에서 브라우저 단축키 충돌(Ctrl+F, Ctrl+L 등)이 확인되면 그때 terminal.html 방식의 chrome:// iframe으로 옮긴다.
- **카드 수명:**
  - 파일 창을 닫을 때 `view.destroy()`.
  - Board를 멀리서 볼 때(상세가 아닌 semantic level)는 편집기를 띄우지 않고 텍스트 미리보기만 둔다. 메모리를 아끼려는 조치다.
  - 모듈은 창마다 한 번만 올라간다.
- **크기 상한:**
  - 변경 비교의 `diffConfig`에 `timeout`과 `scanLimit`(merge 기본 500)을 둔다.
  - 일정 크기를 넘는 파일(예: 1MB, 수치는 0단계 측정 후 확정)은 hunk 목록만 보여 준다.
- **다른 화면과 공유:** 같은 읽기 전용 뷰어를 CTX-04의 "이번에 에이전트가 볼 자료" 파일 미리보기와 첨부 스냅샷 보기에도 쓴다. 의존성은 추가되지 않는다.

---

## 6. 단계별 계획 [제안]

### 0단계 — 묶음 만들기와 로드 확인 (CODE-01 마무리, 크기 S)

- **할 일:**
  - `vendor-src/codemirror` 만들기.
  - 묶음 빌드.
  - `VENDOR.md`·라이선스 파일 추가.
  - `EGDeskCodeEditor.mjs`에 최소 기능만 둔다(읽기 전용 뷰어 1개, 통합 변경 비교 1개).
  - 개발용 확인 버튼이나 QA 경로 하나로 띄워 본다.
- **확인 기준** (사람이 한 번, 다른 Firefox 없이):
  1. 콘솔 오류 0. CSP 위반 0.
  2. Windows MS 한글 IME와 macOS 2벌식에서 "한글 입력 → 조합 중 Enter/Backspace → 저장"할 때 글자가 빠지거나 중복되지 않는다.
  3. 캔버스 줌 50%·150%에서 클릭 위치와 선택이 맞는다.
  4. `about:memory`로 파일 창 1개 열기 전후의 증가량을 기록한다.
  5. Ctrl+S, Ctrl+F, Ctrl+Z가 편집기 안에서 편집기 동작으로 처리된다.
  6. NVDA 또는 VoiceOver로 줄 읽기가 된다.
  7. jsdiff가 Codex fixture diff(hunk만 있는 경우, move 접미사 포함)를 해석·적용한다.
  8. `codex app-server generate-json-schema`로 설치 버전 스키마의 `FileUpdateChange`를 확인한다.
- **결과 기록:** 이 문서 아래나 원장 CODE-01 진행 기록에 적는다.
- **기존 코드:** 손대지 않는다(새 파일만).

### 1단계 — 읽기 전용 변경 비교 (CODE-05, 첫 화면)

- **대표님 화면:** 에이전트가 파일을 고치겠다고 승인을 물으면, 승인 카드에서 바로 "무엇이 바뀌는지"가 줄 단위로 보인다. "자세히"를 누르면 파일 창에서 전체 맥락과 함께 본다.
- **helper** (`helper/codex-chat-runtime.mjs`, 지금 다른 작업자가 수정 중이니 끝난 뒤 착수):
  - `fileChange.changes[].diff`와 `turn/diff/updated`의 diff를 **상한을 두고 필요할 때만** 돌려주는 경로를 추가한다. 예: 승인 상세나 run diff 조회. 파일당·회차당 바이트 상한은 0단계 측정 후 정한다.
  - D2 기본값에 따라 대화 기록(SQLite)과 SSE 상시 전송에는 넣지 않는다. 지금 L42-43 원칙을 유지한다.
  - 경로 검증은 기존 `verifyFile`을 재사용한다.
- **overlay:**
  - 승인 행과 활동 행에 hunk 목록을 넣는다(`EGDeskDiffView.sys.mjs`, 편집기 없이 DOM으로, 기존 `EGDeskFileView` review 마크업 재사용).
  - "자세히"는 파일 창의 "제안된 변경" 탭에서 `unifiedMergeView` 읽기 전용 + `collapseUnchanged`로 연다.
  - 원본은 파일 서비스로 읽고, 제안본은 `applyPatch`로 만든다.
- **완료 기준:**
  - 승인 전 카드에서 변경 줄이 보인다.
  - 파일 3개짜리 회차에서 파일별로 펼쳐진다.
  - 그 사이 파일이 바뀌면 "원본이 바뀌어 일부만 표시" 안내가 나온다.
  - 기존 승인 흐름의 회귀가 없다.

### 2단계 — 편집기 교체 (CODE-04, CODE-03 일부)

- **대표님 화면:** 파일 창에서 코드가 색과 줄번호로 보이고, 파일 안 검색과 줄 이동이 된다. 내 작업사본의 변경 비교도 같은 비교 화면으로 본다.
- **할 일:**
  - `EGDeskFileView.sys.mjs`의 textarea를 `codeEditor.createCodeEditor`로 바꾼다.
  - 다음 규칙은 **그대로 유지한다**: 250ms 지연 기록(`flush`/`updateDraft`), 조합 중 기록·저장·첨부 금지, `captureRef`의 stale 검사, 닫기 게이트.
  - `review()`를 hunk `<pre>`에서 `unifiedMergeView({ original: draft.baseText })`로 바꾼다.
  - 언어는 확장자로 고른다: js/ts, json, css, html, markdown, python. 실제로 넣을 목록은 0단계 크기를 보고 정한다.
- **원본 파일 저장:** CODE-04 결정(원본 덮어쓰기 범위·충돌 규칙)이 난 뒤 `egdesk-file-service.saveDraft`에 원본 저장 방식을 붙인다(sourceHash 조건부 쓰기). 결정 전에는 지금처럼 작업사본과 다른 이름 저장만 둔다.
- **CODE-03 일부:**
  - 내용 검색 결과를 누르면 해당 줄로 이동한다(`EditorView.scrollIntoView`).
  - 트리 자동 새로고침은 RT-06(파일 감시)에 맡긴다. Codex `fs/watch`도 후보다.

### 3단계 — 테스트·리뷰 결과 카드, IDE 진입 (CODE-06, CODE-07)

- **대표님 화면:**
  - 에이전트가 테스트나 빌드를 돌리면 결과 카드에 통과/실패 수와 실패 위치가 먼저 나온다.
  - 실패 위치를 누르면 파일 창이 그 줄로 열린다.
  - Dock의 IDE 버튼은 프로젝트 파일 창, 결과 카드, (선택) 터미널을 한 번에 연다.
- **helper:** `commandExecution.aggregatedOutput`과 `outputDelta`를 상한을 두고 필요할 때만 가져온다(D2와 같은 원칙).
- **overlay:**
  - 결과 카드 유형을 추가한다. 요약을 먼저 보이고, 원문 출력은 펼치면 읽기 전용 CodeMirror 뷰어로 보인다.
  - 해석기는 JUnit XML과 TAP부터 만든다. 실패 항목의 `file:line`은 파일 참조로 바꾼다.
  - 파일 창의 '검사' 버튼(`runCheck`, 지금은 연결이 없어 늘 비활성)을 사용자가 고른 테스트 명령에 잇는다.
- **IDE 진입:** `eg-desk-surface.uc.js` Dock 클릭 처리에 `ide` 분기를 넣는다(현재 `{ id: 'ide' }`는 L69에 선언만 되어 있다). CODE-02(프로젝트 폴더) 결정이 선행 조건이다.
- **리뷰 결과:** Codex의 리뷰 모드(`review/start`) 결과를 같은 결과 카드 형식으로 보여 주는 것은 3단계 후반에 붙인다. 리뷰 출력 구조는 착수할 때 스키마로 확인한다.

---

## 7. 확인하지 못한 것과 위험

| 항목 | 상태 | 대응 |
|---|---|---|
| EG-Desk(Firefox 158 + fx-autoconfig)에서 `importESModule(..., { global: 'current' })`로 vendor 묶음 로드 | 미확인. Firefox DevTools 소스에서 같은 패턴을 확인했을 뿐이다. | 0단계 기준 1 |
| 한글 IME 실사용 | 미확인 | 0단계 기준 2 |
| 메모리 증가량 | 미측정. 크기 수치로만 추정했다. | 0단계 기준 4 |
| 브라우저 단축키와 편집기 키 충돌 | 미확인 | 0단계 기준 5. 충돌하면 chrome:// iframe으로 옮긴다. |
| Codex update diff의 머리줄 유무, jsdiff 해석 | 미확인 | 0단계 기준 7·8 |
| Monaco worker의 chrome:// 동작, Monaco 한글 IME | 미확인 | Monaco를 다시 검토할 때만 확인한다. |
| CONTRACT 기준선(Monaco)과 구현의 불일치 | 결정 대기(D1) | 승인 시 CONTRACT L2119·L2409 문구를 갱신한다. |
| 동시 작업 | `codex-chat-runtime.mjs`, `codex-bridge-server.mjs`, `eg-desk-surface.uc.js`는 다른 작업자가 수정 중이다. | 0단계는 새 파일만 만들어 충돌이 없다. 1단계부터는 그 작업이 합쳐진 뒤 시작한다. |

---

## 8. 출처

Firefox / Mozilla
- DevTools CodeMirror 6 로딩 — <https://searchfox.org/firefox-main/source/devtools/client/shared/sourceeditor/editor.js> (L795-797), README — <https://searchfox.org/firefox-main/source/devtools/client/shared/sourceeditor/README>
- Debugger 편집기 생성 — <https://searchfox.org/firefox-main/source/devtools/client/debugger/src/utils/editor/index.js>
- browser.xhtml CSP — <https://searchfox.org/firefox-main/source/browser/base/content/browser.xhtml>
- JS Loader APIs(`global` 옵션) — <https://firefox-source-docs.mozilla.org/jsloader/jsloader-api.html>
- privileged 문서 innerHTML sanitizer — <https://blog.mozilla.org/attack-and-defense/2019/12/02/help-test-firefoxs-built-in-html-sanitizer-to-protect-against-uxss-bugs/>
- browser.xhtml eval 예외 Bug 1958232 — <https://bugzilla.mozilla.org/show_bug.cgi?id=1958232>
- DevTools CM6 이전 경과 — <https://blog.nightly.mozilla.org/2024/06/18/css-rules-in-your-firefox-devtools-these-weeks-in-firefox-issue-163/>, <https://fxdx.dev/firefox-devtools-newsletter-124/>

CodeMirror
- 홈페이지(접근성·MIT·후원 기대·새 저장소) — <https://codemirror.net/>
- API 참조(merge: `unifiedMergeView`, `MergeView`, `acceptChunk`, `rejectChunk`, `DiffConfig`) — <https://codemirror.net/docs/ref/#merge>
- view CHANGELOG(6.18 CSS 배율 조정, 6.43.12 Firefox 조합 입력) — <https://code.haverbeke.berlin/codemirror/view/raw/branch/main/CHANGELOG.md>
- GitHub 보관·이전 공지 — <https://github.com/codemirror/dev>, <https://github.com/codemirror/merge>
- 번들 예제 — <https://codemirror.net/examples/bundle/>, 대용량 문서 — <https://codemirror.net/examples/million/>

Monaco
- CHANGELOG(0.53 AMD 중단, 0.56 ESM 진입점 재구성, 0.57) — <https://github.com/microsoft/monaco-editor/blob/main/CHANGELOG.md>
- 파일 크기(jsDelivr 목록) — <https://data.jsdelivr.com/v1/packages/npm/monaco-editor@0.57.0?structure=flat>
- Sourcegraph 이전 사례 — <https://sourcegraph.com/blog/migrating-monaco-codemirror>
- MDN EditContext — <https://developer.mozilla.org/en-US/docs/Web/API/EditContext_API>

diff·트리
- jsdiff README(`parsePatch`, `applyPatch`, `reversePatch`) — <https://github.com/kpdecker/jsdiff>
- diff2html — <https://www.npmjs.com/package/diff2html>
- `@git-diff-view/core` — <https://www.npmjs.com/package/@git-diff-view/core>
- `@pierre/diffs` — <https://www.npmjs.com/package/@pierre/diffs>
- Headless Tree — <https://headless-tree.lukasbach.com/>
- 크기 측정 — <https://bundlephobia.com/>
- 버전·날짜·라이선스 — npm registry(`https://registry.npmjs.org/<패키지>`), 2026-10-24 조회

Codex
- app-server 문서 — <https://learn.chatgpt.com/docs/app-server> (구 developers.openai.com/codex/app-server)
- 프로토콜 소스 — <https://github.com/openai/codex/tree/main/codex-rs/app-server-protocol/src/protocol> (`v2/item.rs`, `v2/turn.rs`, `v2/fs.rs`, `item_builders.rs`)

Node
- `node:test` reporters — <https://nodejs.org/api/test.html#test-reporters>

EG-Desk 저장소
- `ideas/confirmed/EGDESK_VISION_GAP_LEDGER.md` CODE-01~07, CTX-04
- `ideas/confirmed/EGDESK_PRODUCT_VISION_AND_DEV_TODO.md` Coding Surface 절
- `ideas/confirmed/EGDESK_INTERACTION_AND_ORCHESTRATION_CONTRACT.md` §6, L2119, L2409
- `.claude/docs/decisions/002-external-reference-license-policy.md`
- `apps/firefox-ui-demo/overlay/resources/EGDeskFileView.sys.mjs`(L115 트리, L135 textarea, L401 조합 처리, L406 `review()`, L462 `check()`), `EGDeskFileCardState.sys.mjs`
- `apps/firefox-ui-demo/helper/codex-chat-runtime.mjs` L42-67(diff·출력 제외 원칙, fileChange는 경로·종류만)
- `apps/firefox-ui-demo/overlay/JS/eg-desk-surface.uc.js` L69(IDE Dock 선언), L9968 부근(파일 창 import), L13078(터미널 iframe), L13967(캔버스 줌)
- `apps/firefox-ui-demo/overlay/resources/vendor/`(xterm 5.5.0만 있음), `references/manifest.tsv`(코딩 화면 관련 레퍼런스는 theia뿐)
