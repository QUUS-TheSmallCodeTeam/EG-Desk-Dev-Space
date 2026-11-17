# overlay/resources/vendor — 외부 코드 기록

이 폴더의 파일은 npm 설치 없이 정확한 버전의 배포본을 그대로 넣은 것이다. 파일은 고치지 않는다. 버전을 바꿀 때는 새 배포본으로 통째로 바꾸고 이 표(버전·출처·해시)를 함께 고친다. `scripts/egdesk-diff-run-result.test.mjs`가 jsdiff 파일 해시를 이 표와 대조한다.

Firefox에서는 `chrome://userchrome/content/vendor/…`로 읽힌다(설치 스크립트가 `overlay/resources/`를 하위 폴더까지 그대로 복사).

## 들어 있는 것

| 묶음 | 버전 | 라이선스 | 출처 | 쓰는 곳 |
|---|---|---|---|---|
| jsdiff (npm `diff`) | 9.0.0 | BSD-3-Clause | npm 배포본 `libesm/` | `EGDeskDiffView.sys.mjs` |
| xterm.js (`@xterm/xterm`) | 5.5.0 | MIT | jsDelivr `/npm/@xterm/xterm@5.5.0/lib/xterm.js`, `/css/xterm.css` (파일 머리말 기준) | `terminal.html` |
| `@xterm/addon-fit` | 0.10.0 | MIT | jsDelivr `/npm/@xterm/addon-fit@0.10.0/lib/addon-fit.js` | `terminal.html` |
| `@xterm/addon-web-links` | 0.11.0 | MIT | jsDelivr `/npm/@xterm/addon-web-links@0.11.0/lib/addon-web-links.js` | `terminal.html` |
| CodeMirror 6 (`codemirror` 묶음) | 6.0.2 (아래 표의 개별 버전) | MIT | npm 배포본 12개를 esbuild로 한 파일로 묶음 | `EGDeskCodeEditor.sys.mjs`(File view 편집기) |

## jsdiff 9.0.0 (`vendor/jsdiff/`)

- 배포본: https://registry.npmjs.org/diff/-/diff-9.0.0.tgz
- npm integrity: `sha512-svtcdpS8CgJyqAjEQIXdb3OjhFVVYjzGAPO8WGCmRbrml64SPw/jJD4GoE98aR7r25A0XcgrK3F02yw9R/vhQw==` (받은 tgz의 sha512와 일치 확인, 2026-10-24)
- npm 게시 2026-04-13, gitHead `db0b12ace208da7fd741cf96d97f009347a9eaa8`, 저장소 https://github.com/kpdecker/jsdiff
- 넣은 파일: 배포본 `package/libesm/` 아래의 `*.js` 전부와 `libesm/package.json`(`{"type":"module"}`), 그리고 `package/LICENSE` → `jsdiff/LICENSE`. 타입 선언(`*.d.ts`, `*.d.ts.map`)은 넣지 않았다. 내용은 한 글자도 바꾸지 않았다.
- 라이선스 전문: `jsdiff/LICENSE` (BSD 3-Clause, Copyright (c) 2009-2015, Kevin Decker).
- Firefox 시스템 모듈에서 쓰이는 전역: `parsePatch`의 C 스타일 따옴표 파일 이름 해석에 `TextDecoder`, 비동기 모드(callback)에서만 `setTimeout`. EG-Desk는 동기 호출만 한다.

| 파일 | sha256 |
|---|---|
| `jsdiff/LICENSE` | `eda81a415869e67809f6a9f3fd6056062cb83a462118e07eec5e92b2e0c40ce9` |
| `jsdiff/convert/dmp.js` | `05bad2211249703a43f2d4250fb0e0831511a32aed763cd21890c1b5ee7032c4` |
| `jsdiff/convert/xml.js` | `c9dfceeb2ab8248f6dee37f0ce253317939fe1302ffb4483ccf777400a3ac552` |
| `jsdiff/diff/array.js` | `5bcc1320c7ee74e565421a556d81ed3fdd82ff2f366e6151beebac6b425f528f` |
| `jsdiff/diff/base.js` | `faa81734df6ea7f8034efc5572ad1bbf19c50b300fdd183baf0d7813c5eec3b2` |
| `jsdiff/diff/character.js` | `75677c2b3c5990099675493b415ce59f92f5de4709de59fa481b9fb563168deb` |
| `jsdiff/diff/css.js` | `db85fa43d4e4d4bbe3707d9e575de338589deb9a4cc8243c7f15fa5e2c87724d` |
| `jsdiff/diff/json.js` | `c97ec8c04a7c4fc37a605d5863018ead1cac1c19128a7333bcb19d33fa6771b7` |
| `jsdiff/diff/line.js` | `e3ef2d8c8c3a56f6b9fb04609f545b2aae2f84a02c31c5de3201aef1b0545f90` |
| `jsdiff/diff/sentence.js` | `dad3b5952b2d8f29d8a01618580661c1757ed0bcce5e2af969b17eff613ca93b` |
| `jsdiff/diff/word.js` | `c1d6a6c52ef517e4ea9df6d71465fa520ce677d1b4e127425e3c2d8cf14f7a22` |
| `jsdiff/index.js` | `b1f400fd24da44377867ede7ab847a34940423f8bbf3fc5475d8c7647759a2aa` |
| `jsdiff/package.json` | `5e433a0d28d7f422b2c6fbc3058b931d19d29bdc49c154b312099680e992e3f5` |
| `jsdiff/patch/apply.js` | `f8096efdfda914e9b85a8cb270dfb1a57f0d483656368327c89b80098955589e` |
| `jsdiff/patch/create.js` | `f29a276d2b036858b2f6a509b1e6e147efa572d4820317ee7285d6fe4f2888de` |
| `jsdiff/patch/line-endings.js` | `65af590b9426800782d692a7b1923ad1d6d6bbc1c74e9863053c6cfe1d97f3f4` |
| `jsdiff/patch/parse.js` | `0d8c9a406b8ee41be2e1e6d32f7ccece5c04f6995e6f1f71d4bf4485a5c1bce9` |
| `jsdiff/patch/reverse.js` | `8d4e2d14cff3632a9c9a6d42d52aca16593d97812efe8c185e39094ceb7badf2` |
| `jsdiff/types.js` | `8e609bb71c20b858c77f0e9f90bb1319db8477b13f9f965f1a1e18524bf50881` |
| `jsdiff/util/array.js` | `8bbc0246a6d709eb776531a7a2062066a77916643364945c1a713a00eca33e46` |
| `jsdiff/util/distance-iterator.js` | `41e12ebbedb76278e3bd37ede510e009a5952897a3e748e9673b4e5c8ae660e5` |
| `jsdiff/util/params.js` | `bb76a1c299071b6f8314bb7195ad701af06f092c629aed8b4fef4a7474ab3759` |
| `jsdiff/util/string.js` | `0836eacdebdb30c8aba0e898f9c7a45e236d036848ccfb058f56745f5ff020d3` |

## xterm.js 5.5.0 · addon-fit 0.10.0 · addon-web-links 0.11.0

이전 커밋(caef646)에서 jsDelivr 배포본을 넣었다. 버전은 각 파일 머리말의 `Original file:` 줄, 라이선스는 npm 메타데이터(`license: MIT`)로 확인했다(2026-10-24). 축소본에는 저작권 고지가 없어서 MIT 조건에 따라 아래에 전문을 둔다(xterm.js 저장소 `LICENSE`, 태그 5.5.0 = `9ba6c00a195c95fcf8292a2b9084d91450e5daae`).

| 파일 | sha256 |
|---|---|
| `xterm.min.js` | `4196e242ef1cf4c2adead8d97f4a772a69576076f70b095e004b4abbb049e7bf` |
| `xterm.min.css` | `f7f724aea2bb620a6482bfb8e4bdecfae1152b0c7facef55fbda61f3b6cfedb2` |
| `addon-fit.min.js` | `a6a7bbb33569f16aa3e18d71425e34d035fc89a0b7e8cba084f8855f91aa38f1` |
| `addon-web-links.min.js` | `aad032d7f5ad1038c7b5295617cf84f6e8ebdb1218efaa427218302ce0d2ae3b` |

```
Copyright (c) 2017-2019, The xterm.js authors (https://github.com/xtermjs/xterm.js)
Copyright (c) 2014-2016, SourceLair Private Company (https://www.sourcelair.com)
Copyright (c) 2012-2013, Christopher Jeffrey (https://github.com/chjj/)

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in
all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN
THE SOFTWARE.
```

## vendor 폴더 밖으로 옮겨 온 코드

| 우리 파일 | 옮긴 것 | 원본 | 라이선스 |
|---|---|---|---|
| `EGDeskRunResult.sys.mjs` (MIT 머리말이 붙은 구간) | `terminalLinkParsing.ts` 전체 논리와 정규식(파일:줄:열 찾기) | microsoft/vscode `src/vs/workbench/contrib/terminalContrib/links/browser/terminalLinkParsing.ts`, 커밋 `da20a6d0ddd819136575cd284741993a9e724c2f` | MIT |
| `EGDeskRunResult.sys.mjs` (`ESLINT_FILE`, `ESLINT_PROBLEM`) | eslint stylish 두 줄 형식 정규식 2개 | microsoft/vscode `src/vs/workbench/contrib/tasks/common/problemMatcher.ts` `'eslint-stylish'` | MIT |
| `scripts/egdesk-diff-run-result.test.mjs` (표시한 구간) | 위 링크 해석기의 시험 사례 일부 | microsoft/vscode `src/vs/workbench/contrib/terminalContrib/links/test/browser/terminalLinkParsing.test.ts` | MIT |

microsoft/vscode `LICENSE.txt` 전문:

```
MIT License

Copyright (c) 2015 - present Microsoft Corporation

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

## CodeMirror 6 (`vendor/codemirror/`)

D-X5(편집기 기준)는 아직 대표 결정 전이다. 조사 문서(coding-surface-framework-research.md) 권고와 xterm·jsdiff 선례에 따라 **추론으로** CodeMirror 6을 넣었다(2026-11-17).

- 넣은 파일: `codemirror/codemirror.bundle.mjs`(축소 ESM 한 파일, 외부 import 없음), `codemirror/build-entry.mjs`(묶을 때 쓴 입구 파일, Firefox에서는 읽지 않음), `codemirror/LICENSE`(묶음에 든 패키지 26개의 라이선스 전문, 모두 MIT, Copyright (C) Marijn Haverbeke and others).
- 묶음 파일은 고치지 않는다. 버전을 바꿀 때는 아래 명령으로 다시 묶어 통째로 바꾸고 이 표를 함께 고친다. `scripts/egdesk-code-editor.test.mjs`가 해시를 이 표와 대조한다.
- Firefox에서는 창 전역으로 읽는다: `ChromeUtils.importESModule('chrome://userchrome/content/vendor/codemirror/codemirror.bundle.mjs', { global: 'current' })`. CodeMirror는 `document`·`window`·`requestAnimationFrame`을 쓰므로 공유 시스템 전역으로 읽으면 안 된다. 읽기에 실패하면 File view는 기존 textarea로 동작한다.
- esbuild 0.21.5(저장소 루트 `node_modules/.bin/esbuild`), `--target=firefox115 --minify --legal-comments=none`. 크기 605,082바이트.

직접 고정한 패키지(`npm install --save-exact`):

| 패키지 | 버전 | 라이선스 |
|---|---|---|
| `codemirror` | 6.0.2 | MIT |
| `@codemirror/state` | 6.7.6 | MIT |
| `@codemirror/view` | 6.43.15 | MIT |
| `@codemirror/commands` | 6.11.1 | MIT |
| `@codemirror/language` | 6.13.1 | MIT |
| `@codemirror/search` | 6.7.2 | MIT |
| `@codemirror/lang-javascript` | 6.2.5 | MIT |
| `@codemirror/lang-json` | 6.0.2 | MIT |
| `@codemirror/lang-css` | 6.3.1 | MIT |
| `@codemirror/lang-html` | 6.4.12 | MIT |
| `@codemirror/lang-markdown` | 6.5.2 | MIT |
| `@codemirror/lang-python` | 6.2.1 | MIT |

함께 묶인 하위 패키지(npm이 고른 버전, 모두 MIT): `@codemirror/autocomplete` 6.20.4, `@codemirror/lint` 6.9.8, `@lezer/common` 1.5.5, `@lezer/lr` 1.4.12, `@lezer/highlight` 1.2.5, `@lezer/javascript` 1.5.6, `@lezer/json` 1.0.3, `@lezer/css` 1.3.9, `@lezer/html` 1.3.13, `@lezer/markdown` 1.8.1, `@lezer/python` 1.1.19, `style-mod` 4.1.5, `w3c-keyname` 2.2.8, `crelt` 1.0.7, `@marijn/find-cluster-break` 1.0.4.

| 파일 | sha256 |
|---|---|
| `codemirror/codemirror.bundle.mjs` | `f47286d31353f7dd6e6764f249d0ef45e9c278fe5a1f24daad547d6a7fe409c0` |
| `codemirror/build-entry.mjs` | `4d9aea418ad7bd05030c443f6418fd5766adf24a38d35fee6dc57b8b21f5ff8b` |
| `codemirror/LICENSE` | `6370c13ed220bd6c0dc3191ab5919e826e39088c5e9a2320ff92964444bd959b` |

다시 묶는 명령(저장소 밖 임시 폴더, 저장소 package.json은 건드리지 않음):

```sh
mkdir -p /tmp/egdw-codemirror/build && cd /tmp/egdw-codemirror/build
echo '{"name":"egd-cm-build","private":true,"type":"module"}' > package.json
npm install --ignore-scripts --no-audit --no-fund --save-exact \
  codemirror@6.0.2 @codemirror/state@6.7.6 @codemirror/view@6.43.15 @codemirror/commands@6.11.1 \
  @codemirror/language@6.13.1 @codemirror/search@6.7.2 @codemirror/lang-javascript@6.2.5 \
  @codemirror/lang-json@6.0.2 @codemirror/lang-css@6.3.1 @codemirror/lang-html@6.4.12 \
  @codemirror/lang-markdown@6.5.2 @codemirror/lang-python@6.2.1
cp <repo>/apps/firefox-ui-demo/overlay/resources/vendor/codemirror/build-entry.mjs entry.mjs
<repo>/node_modules/.bin/esbuild entry.mjs --bundle --format=esm --minify --legal-comments=none \
  --target=firefox115 --outfile=codemirror.bundle.mjs
shasum -a 256 codemirror.bundle.mjs
```

하위 패키지 버전이 위 목록과 다르면 해시가 달라진다. 같은 해시가 필요하면 위 하위 패키지 버전도 `npm install`에 함께 고정한다.

## 패턴만 따른 것 (코드 복사 없음, 추적용)

| 우리 파일 | 따른 패턴 | 원본 | 라이선스 |
|---|---|---|---|
| `EGDeskDiffView.sys.mjs` | 1MB·100ms 상한, 같은 머리·꼬리 줄을 빼고 비교한 뒤 hunk 시작 줄 보정 | agentclientprotocol/claude-agent-acp `src/diff.ts` | Apache-2.0 |
| `EGDeskDiffView.sys.mjs` | update는 머리줄 없는 hunk, 이동은 `Moved to:` 꼬리, add/delete는 파일 전체 | openai/codex `apply-patch/src/file_update.rs`, `app-server-protocol/src/protocol/item_builders.rs`, `core/src/turn_diff_tracker.rs` | Apache-2.0 |
| `EGDeskRunResult.sys.mjs` | 짧은 명령 + 출력 꼬리 | pingdotgg/t3code `CodexAdapterV2.ts` `codexBackgroundCommandDetail` | MIT |
| `EGDeskRunResult.sys.mjs` | 통과·실패·건너뜀 결과 모델, 내부·node_modules를 건너뛴 첫 프로젝트 스택 줄 | dorny/test-reporter `src/test-results.ts`, `src/utils/node-utils.ts` | MIT |
