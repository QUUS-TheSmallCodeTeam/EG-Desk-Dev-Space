# ChatGPT 데스크톱 Computer Use·Browser Control 조사

작성·공개 자료 확인: **2026-10-23**. 대상 독자: EG-Desk 개발자.
상태: **검토완료·미확인항목 포함**. 기존 설치본 분석·통제 실험과 10월 23일 추가 정적 검토를 합친 연구 참고 문서다.
제품 기능 명세나 모든 앱에서의 동작 보증이 아니며, 새 기능 결정을 요구하지 않는다.

- **직접 확인:** 설치 코드에서 브라우저 CDP 입력·DOM 표시 커서와 네이티브 PID 입력·포커스 복원을 구분했다. 제한된 과거 A/B 시험에서는 A→B→A 복귀와 A의 입력 수신을 확인했다. 현행 서비스의 예산/클릭 구조는 추가 정적 분석으로 확인했지만 현행 네이티브 동작까지 재검증한 것은 아니다.
- **공개 자료:** 특정 버전의 제3자 실제 역분석, 독립 대체 구현, 공식 지원 설명은 서로 다른 근거다. 어느 것도 우리 현행 설치본의 전체 동작을 대신 증명하지 않는다.
- **미확인:** timeout 뒤 최종 효과, native Stop 뒤 queued input, 현행 네이티브 버전의 동등성, Gecko 좌표 조합은 남아 있다. [남은 분석 표](#remaining-analysis)에 필요한 이유와 승인 후 최소 확인 범위를 정리했다.

## 1. 읽는 기준: 직접 확인 / 공개 자료 / 미확인

조사 대상은 **설치된 ChatGPT 데스크톱 앱과 그 Browser Use·네이티브 서비스**다.
내부에 남아 있는 `Codex`, `com.openai.codex`, `codex-*` 이름은 Codex CLI를 조사했다는 뜻이 아니다.
이 문서는 독점 코드·디스어셈블리 본문·사용자 프로필 경로·원시 캐시 payload를 재배포하지 않는다.

| 구분 | 이 문서에서 뜻하는 것 | 확대하면 안 되는 주장 |
|---|---|---|
| 직접 확인 — 설치 코드 정적 분석 | 지정 버전·해시의 JS를 읽거나 REA로 구문/호출 관계를 조사하고, 네이티브 코드를 LLVM·기존 REA 결과와 대조 | 해당 함수가 실제 요청에서 실행됐다는 증명 |
| 직접 확인 — 통제된 실행 | 소유한 시험 페이지·A/B 앱의 로그, 제한된 호출 결과, 특정 시점의 스택 샘플 | 모든 앱·사이트·최소화·중단 상황의 보장 |
| 공개 자료 — 제3자 실제 역분석 | 작성자가 특정 설치 앱·번들·런타임을 조사한 자료 | 우리 설치본의 직접 검증이나 공식 계약 |
| 공개 자료 — 대체 구현 / 공식 설명 | 독립 구현의 설계 / 공급자가 문서화한 지원 범위 | 대체 구현이 원본 코드라는 주장 / 내부 호출의 실측 |
| 미확인·추론 | 증거가 끊긴 연결, 다른 버전에의 일반화, 가능한 설명 | 확인된 구현으로 서술 |

정적 REA 결과, 일반 소스 읽기, LLVM 디스어셈블리, 런타임 관찰은 서로 대체하지 않는다.
아래 주장 ID는 부록의 증거 ID·버전·함수 위치와 연결한다. 원본이 없거나 미검증인 연결은 **UNKNOWN/UNVERIFIED**로 남긴다.

## 2. 연결 구조와 실무상 차이

다음은 최소 연결도다. 점선은 완결된 호출 연결을 확보하지 못한 구간이다.

```text
Browser API → browser-client → browser-service
  ├─ Chrome: native-pipe 경계 … native host … 확장 세션/탭 검사
  │                                      → chrome.debugger.sendCommand → 탭 CDP 입력
  │           별도 표시 경로: moveMouse → content DOM 커서 오버레이
  └─ IAB: 앱의 세션/페이지 소유권 검사 → webContents.debugger.sendCommand

Native CUA 진입 … IPC/대상 선택 … SkyComputerUseService
  → PID를 받는 입력 경로 → postToPid 래퍼 → 간접 전송 함수 [최종 runtime target UNKNOWN]
  ├─ 선택적 virtualCursor 작업에도 postToPid 호출 존재 [정적]
  └─ focusEnforcer 복원 분기 → 이전 앱 activateWithOptions:0 [과거 분석/샘플]
```

### Browser: 표시 커서와 입력 전달을 구분한다

**B-01 — Chrome의 표시 커서는 OS 입력 그 자체가 아니다.** 과거 설치본에서 확장 `moveMouse`는
커서 상태를 게시하고 content script는 `pointer-events:none` DOM 오버레이를 표시한다.
실제 클릭·키 입력은 세션에 속한 탭을 검사한 뒤 별도의 CDP 명령으로 전달된다.
따라서 커서 표시·도착만으로 클릭의 입력 수신이나 결과를 확인할 수 없다. [H340, B1, B2]

**B-02 — focus emulation과 전면 전환은 별개다.** Chrome 확장의 `focusTab`은 탭 활성화와 창 포커스를
요청하는 별도 경로다. IAB의 과거 설치 번들에는 현재 페이지/세션 검사 후 `Input.*` 앞에서
focus emulation을 켜고 `webContents.debugger.sendCommand`로 넘기는 경로가 보고됐다.
IAB에서 이 전체 경로를 실행 추적한 증거는 확보하지 않았다. [H340, B2]

**B-03 — 관찰 좌표·수명도 입력 계약의 일부다.** 과거 서비스 분석에서는 요소를
`frameId:loaderId:localRef`에 연결하고 stale 참조·클릭 직전 프레임 변경을 검사했다.
탭 캡처는 `Page.captureScreenshot` 경로다. 이는 OS 전체 화면 캡처와 다르며,
배경/최소화, HiDPI, 확대율, OOPIF 조합에서 캡처·입력 좌표가 항상 일치한다는 실행 증거는 아니다. [H340]

### Native: PID 입력 경로와 포커스 복원을 구분한다

**N-01 — 네이티브 virtualCursor를 표시 전용으로 분류할 수 없다.** 과거 바이너리의
가상 커서 관련 continuation 내부에서 `postToPid` 호출을 확인했다.
이는 정적 부수효과 경로의 존재를 뜻한다. 실제 시험이 이 분기를 탔는지, 최종 OS 전달이 성공했는지는
그 함수 본문만으로 증명되지 않는다. 상위 AX 동작/좌표 입력 선택 조건도 미확인이다. [N2, N3]

**N-02 — A→B→A 복귀와 복귀 후 입력 수신은 제한된 시험에서 확인됐다.** 과거 설치본의 복원 분기와
샘플 스택은 이전 앱 활성화 경로를 뒷받침한다. 별도 A/B 시험에서는 A 복귀 후 A의 `keyDown` 1회와
텍스트 변경 1회, 관찰 종료 경계에서 B의 키·텍스트 변경 0회가 기록됐다. [N1, N4, N5, N6]

**N-03 — 물리 입력의 출처는 다른 증거다.** 당시 사용자 입력·사람 관찰 보고는 직접 누른 `ㅌ`이
A에 들어갔다고 기록한다. 그러나 fixture 로그는 문자 `ㅌ` 자체를 저장하지 않으며
`inputPhysicalOriginVerifiedByFixture=false`다. 따라서 **사람 관찰 보고와 계측된 수신/변경을 합쳐 설명하되,
fixture가 물리적 입력 출처를 검증했다고 쓰지 않는다.** [H337, N5, N6]

이 결과는 독립적인 OS 포커스 두 개, 영구적인 전역 커서 무이동, 모든 앱의 동시 조작 또는 Stop 후 무입력을 보장하지 않는다.

## 3. P1: timeout은 효과 없음이나 취소 완료가 아니다

**T-01 — 3,000→2,998ms는 잔여 예산 계산이지 지연 원인이 아니다.** 과거 서비스 `We`는 기본 3,000ms를 정하고,
`clickPoint`가 절대 deadline을 만들며 `Rf`가 남은 시간을 전달한다.
소스 기반 모의 시계에서 `3000−2=2998`을 재현했다는 분석 보고가 있다.
당시 내부 전송 순간에 정확히 2ms가 경과했거나 그 함수가 hit됐다는 런타임 기록은 아니다. [B1, H340]

**T-02 — 현행 서비스에도 예산/클릭 구조는 확인됐지만 전체가 동일하지 않다.** 2026-10-23 추가
REA 6.7.0 정적 분석은 새 서비스의 `$e`, `Ev`, `ig.clickPoint`에서 기본 예산·잔여 예산·move/down/up 구조를 확인했다.
반면 attachment 경로는 `ensureAttachedTab`에서 `waitForTabAttachment(tabId, options)`로,
초기화 재시도 조건은 `initializingTabIds`에서 `options[Xa] !== tabId`로 바뀌었다.
새 helper 내부를 확장 분석하지 않았으므로 구 구현과 완전 동등하다고 결론내리지 않는다. [C1–C4]

**T-03 — 타임아웃 응답과 이미 보낸 명령의 취소는 다르다.** 확장 `Ia`가 CDP 명령을 보내고
`Kw`는 명령 promise와 타이머를 경쟁시킨다. `clearTimeout`은 타이머 정리이며 CDP 명령 취소 호출이 아니다.
바깥 경로의 조건부 debugger detach가 Chromium 내 명령을 중단시키는지는 미확인이다.
raw CDP의 debugger 보존 옵션도 구분해야 한다. [B1, B2]

`clickPoint`의 abort/finally mouse-up은 **입력 상태 정리를 위한 보상 동작**이지, 앞선 입력의 취소·역전이 아니다.
`onDispatch`도 CDP 응답보다 앞선다. 해당 콜백을 성공·수신 완료 영수증으로 쓰지 않는다. [B1, C1, C2]

**T-04 — 기존 실행 로그로 late effect를 판별할 수 없다.** 수동으로 emulation을 끄고 B→A 전환을 유도한
조건의 raw `mouseMoved`는 3,000ms 프로토콜 예산으로 timeout을 반환했고, 외부 호출 관측 경과는 **3,022ms**였다.
명시적으로 emulation을 켠 뒤 보낸 **다음 새 명령**은 17ms에 성공했다. 이는 앞선 명령의 회복/완료 시간이 아니다. [B3]

해당 fixture는 command ID와 `mousemove`/`pointermove`를 기록하지 않았다. 기록된 `window.focus`는
DOM 상태이며 OS 전면 앱 복귀 증거가 아니다. 후속 클릭은 명시적 재시도 구간에서 관측됐으나, 개별 명령과 효과의 대응은 미확인이다.
앞선 timeout 명령의 late effect로 귀속할 수도 없다.
Chromium 내부 지연 지점·ACK·실제 detach 순서·timeout 후 최종 효과는 **UNKNOWN**이다.
따라서 P1은 “효과 후 timeout이 입증됐다”가 아니라, **결과 미확정 상태에서 중복 입력을 만들지 않도록 하는 검증 과제**다.

## 4. P2: native Stop 경계는 아직 미확인

**S-01 — 관찰 종료는 작업 취소가 아니다.** 기존 `observationStoppedAtDeadline`은 30초 관찰기와 모니터의
종료 경계다. 네이티브 명령 취소, 큐 배수, Stop 이후 입력 0회를 증명하지 않는다. [N5, N6, 추가 검토 보고]

네이티브 Stop/cancel과 queued input을 연결할 적합한 기존 trace는 확인되지 않았다. 현재 상태는 **UNKNOWN**이며,
이를 채우기 위한 신규 네이티브 실행·REA·앱 권한 확대를 이 문서 작업에서 수행하지 않는다.
후속 EG-Desk 소유 fixture를 승인받는다면 같은 시계로 `enqueue → dispatch → Stop ACK → receive`를 기록하고
`commandId / sequence / PID`를 연결해야 한다. “ACK 전 dispatch, ACK 후 수신”과 “ACK 후 새 dispatch”를 구별해야 한다.

## 5. 공개 자료의 정확한 지위

| ID | 자료와 확인일 | 사용할 수 있는 근거 / 한계 |
|---|---|---|
| P-01 | [IAB Architecture — 커밋 고정](https://github.com/iFurySt/open-browser-use/blob/b136cac71a3c497b5696aefd871dd15cba7d7559/docs/wiki/browser-client/runtime/iab-architecture.md), 2026-10-23 | 제3자가 실제 `app.asar`, native pipe, session registry를 조사한 **직접 역분석 자료**다. 공개 문서의 대상은 ChatGPT **26.1007.30912 / build 20156 / Chromium 155.0.8059.40**이며 우리 현행 설치본과 다르다. 단순 추측으로 낮추지도, 우리 직접 검증으로 올리지도 않는다. |
| P-02 | [open-computer-use README — 커밋 고정](https://github.com/iFurySt/open-computer-use/blob/43eb4b53de7a15b3f99ec2c9922bedeb95602266/README.md), 2026-10-23 | Codex Computer Use에서 영감을 받은 **독립 대체 구현**임을 명시한다. MCP/Accessibility 접근을 비교할 자료이지 OpenAI 원본 구현의 증거가 아니다. |
| P-03 | [공식 Computer Use·application approvals](https://learn.chatgpt.com/docs/enterprise/chatgpt-work-local-security#computer-use-and-application-approvals), 2026-10-23 | 지원되는 macOS 작업의 백그라운드 실행, Screen Recording·Accessibility 및 앱 승인 필요, Windows의 활성·보이는 데스크톱 조건을 설명한다. 모든 앱의 지원이나 내부 큐 취소 보장은 아니다. |

공식 문서의 “사용자가 작업을 중지할 수 있다”는 설명과 이미 전송한 입력의 취소/역전 보장은 구별한다.
P-01의 고정 커밋 일자는 2026-10-15, P-02는 2026-10-19다. 이는 문서 내 모든 실험의 수행일을 뜻하지 않는다.
P-02의 [고정 LICENSE](https://github.com/iFurySt/open-computer-use/blob/43eb4b53de7a15b3f99ec2c9922bedeb95602266/LICENSE)는 MIT로 표시된다.
그 사실을 OpenAI 설치 코드, 다른 저장소, 포함된 자산·의존성의 재사용 허가로 전이하지 않는다. 이 문서는 코드를 복사하지 않았다.

## 6. EG-Desk/Firefox에 적용할 때

아래는 조사에서 얻은 **설계·검증 시사점**이다. Chromium/macOS 구현이 Firefox에 이미 이식됐다는 주장이 아니다.
기존 [Browser Agent 관찰 런타임](../../apps/firefox-ui-demo/docs/BROWSER_AGENT_OBSERVATION_RUNTIME.md)과 따로 대조한다.

| ID | 적용 관점 | 확인할 경계 |
|---|---|---|
| EG-01 | 결과 미확정과 실패를 구분 | timeout 직후 자동 재클릭 대신 새 관찰·후조건·동일 요청 중복 방지를 확인한다. |
| EG-02 | 대상과 좌표를 입력 직전 재확인 | Card·문서·프레임·viewport·권한 수명을 묶고 Canvas 화면 밖, 확대·축소, 화면 배율은 Gecko에서 별도 검증한다. |
| EG-03 | 표시와 효과를 별도로 검증 | 커서 애니메이션, dispatch 시작, 실제 대상 수신, 후조건 충족을 하나의 성공 신호로 합치지 않는다. |
| EG-04 | Stop의 층위를 분리 | 상위 실행 중지, lease 무효화, 새 dispatch 차단, 이미 보낸 OS 입력의 최종 수신은 다른 검증이다. |
| EG-05 | 기존 단위 테스트 활용 | 아래 항목은 2026-10-23 중앙 검증에서 통과를 확인한 단위 테스트다(`79b3566`). **unit-test verified**이며 OpenAI REA 결과나 물리 OS 취소 보장으로 합산하지 않는다. |

EG-05의 관련 위치는 변경 시 라인이 이동할 수 있으므로 테스트 의미와 함께 확인한다.

- [helper/egdesk-browser-tool-runtime.test.mjs:178](../../apps/firefox-ui-demo/helper/egdesk-browser-tool-runtime.test.mjs#L178): timeout 뒤 action unknown, 새 call ID에도 자동 재시도 없이 `actionCalls=1`.
- [helper/codex-browser-tool-transport.test.mjs:72](../../apps/firefox-ui-demo/helper/codex-browser-tool-transport.test.mjs#L72): 절대 deadline 뒤 늦은 응답을 stale로 처리.
- [scripts/egdesk-browser-tool-transport.test.mjs:592](../../apps/firefox-ui-demo/scripts/egdesk-browser-tool-transport.test.mjs#L592): HTTP await 이전 Stop lease 무효화.
- [scripts/egdesk-browser-agent-guard.test.mjs:425](../../apps/firefox-ui-demo/scripts/egdesk-browser-agent-guard.test.mjs#L425): parent approval await 뒤 상태 재검사.
- [scripts/egdesk-browser-tool-transport.test.mjs:526](../../apps/firefox-ui-demo/scripts/egdesk-browser-tool-transport.test.mjs#L526): 진행 중 approval 취소 시 DOM dispatch 0.

실행 출력은 당시 대화에 보관되어 있으며 별도 저장소 보고서가 아니다. 이 개발 테스트의 통과는 독립 구현 검토나
네이티브 입력 실험의 성공을 뜻하지 않는다. 이 문서 작성 과정에서 앱·입력·Stop 시나리오를 다시 실행하지 않았다.

<a id="remaining-analysis"></a>
## 7. 남은 분석: 필요한 이유와 최소 확인 범위

아래는 **미확인 항목 목록이지 실행 일정이나 실험 승인 요청이 아니다.** 현재 승인된 소유 fixture의 background 일반 QA는 기존 승인 범위에서 수행할 수 있다. 실제 OS 전면 전환이나 새 권한이 필요한 경우에는 실행 전에 알리고 승인 범위를 확인한다.

| ID / 항목 | EG-Desk에 필요한 이유 | 다음 최소 확인 | OS 전면 필요 여부 / 현재 상태 |
|---|---|---|---|
| R-01 / P1 timeout 뒤 효과 | 결과 미확정 요청의 중복 입력을 막기 위해 | 소유 fixture에서 command ID·move 수신·dispatch·timeout을 같은 시계로 연결한다. | 배경 시험 자체는 OS 전면 불필요; 전환 재현에는 통제된 전면 전환 필요 / 기존 로그로 late effect **UNKNOWN** |
| R-02 / P2 native Stop | 새 dispatch 차단과 이미 보낸 입력의 수신을 구별하기 위해 | `enqueue/dispatch/Stop ACK/receive`에 command ID·순서·PID를 붙여 ACK 전후를 구분한다. | 통제된 A/B 전면 전환·입력 필요 / 적합한 기존 trace 없음, **UNKNOWN** |
| R-03 / 현행 native 버전 변화 | 과거 offset·복원 결과를 새 helper에 잘못 적용하지 않기 위해 | 현행 해시 기준으로 관련 함수만 대응시킨 뒤, 실행 동등성이 필요할 때 별도 승인된 제한 시험을 한다. | 정적 대응은 OS 전면 불필요; 실행 재검증은 별도 / 해시 변경 확인, 동등성 **UNVERIFIED** |
| R-04 / Gecko frame·zoom·배경 좌표 조합 | Chromium의 관찰/입력 좌표 계약을 Firefox로 오인하지 않기 위해 | 소유 페이지에서 frame·확대율·화면 배율·배경/최소화 조합별 fresh snapshot 좌표와 실제 수신 대상을 대조한다. | 좌표 단위 검증은 OS 전면 불필요; 배경/최소화 실측은 통제 전환 필요 / 조합별 실행 **UNVERIFIED** |
| R-05 / 불투명 host 연결 — 낮은 우선순위 | 대상·세션 경계의 누락을 확인하되 구현을 추측해 복제하지 않기 위해 | 기존 정적 자료에서 client→host→extension/target 식별자 연결만 보완한다. | 정적 검토는 OS 전면 불필요 / 연결 일부 **UNKNOWN**, 제품 변경의 선행 조건으로 삼지 않음 |

## 부록 A. 버전·해시와 드리프트

과거 실행 결과는 **2026-10-21 당시 설치본**에 한정한다. 10월 23일 현재 앱/CUA와 native helper는 교체됐다.
확장 `background.js`는 해시가 같지만 이것만으로 전체 경로가 동일하다고 할 수 없다.

| 대상 | 과거 분석본 | 2026-10-23 추가 확인 |
|---|---|---|
| ChatGPT 앱 | `app.asar` SHA-256 `5ddc4e48259aa6f979e04529b1a5a4ae54b0f5c4ad6db5c6e004924c10916ddb`; 정확한 앱 버전은 H340에서 미기록 | 추가 설치 식별 확인: **26.1016.62342 / build 21477**, `@oai/cua` **0.2.6** |
| CUA client | `fe7bd7ff410acbe429ef2b2faa9945f920c7f56f68c28bef96918f43980361ad` | `821e2b689eba8d95f3ad0ff328d68ac8692baec955d993ecd21d2cdb9ba31760` |
| CUA service | `cf71f3412b13b56acf2b90370f9baba52283f3b045df3de38255f3518046ffea` | `0924ce1c8694292a6d80f544a7a168833c73e9b3981791860638a20a6f3b8b2d` |
| Chrome 확장 | **1.26.1015.10801**, background `b61ee9b05ff9adfecdde4efdc4ec1fd326fe585268d6676eceec5d6cedffeac6` | 추가 설치 식별 확인: background 해시 동일 |
| SkyComputerUseService | **26.1013.1001501 (1001501)**; `f21c31c0ee5df419dbd165bf76ebd65c64d864c6fec5b6c6c3a23c42ff3d2e13` | 추가 설치 식별 확인: **26.1015.1001540**; `ef4f4dc20e64ee29027bf178f553c0c39b9cfa517a4cd39734510259f23c058a` |

현행 버전/해시는 추가 검토 보고를 반영했다. 현행 네이티브 바이너리를 과거 offset으로 해석하지 않는다.
과거 native UUID는 `6AD9DE94-5466-38A4-B2E0-F81DFBC620DB`다.

## 부록 B. 주장별 함수·증거 위치

브라우저 byte 범위는 UTF-8의 반개구간 `[start,end)`, line은 1-based다.
네이티브 VA는 과거 image base `0x100000000` 기준이며 실제 로드 주소와 구별한다.

| 주장 | 식별점 | 증거·수준 |
|---|---|---|
| B-01/B-02 | 확장 `focusTab`, `executeCdp`, `Ia`, `Kw` L38; overlay `pointer-events:none` | B2의 정적 함수 + H340의 설치 코드 검토 보고. overlay/IAB 원본은 이번 문서 작업에서 재열람하지 않음 |
| B-02 | 과거 ASAR `.vite/build/main-CLu1A25j.js` L993/L1003; `executeCdpForBrowserUse`, `sendDebuggerCommand` | H340 설치 코드 보고. 현행 IAB 동등성은 UNVERIFIED |
| T-01 | `We` `[252876,252986)` L844; `Rf` `[779186,779324)` L1121; `clickPoint` `[1169262,1170705)` L4263 | B1 정적 소스 추출. 모의 시계 결과는 H340 보고이며 실제 타임라인 아님 |
| T-02 | `$e` `[367466,367576)` L875; `Ev` `[905463,905601)` L1152; `ig.clickPoint` `[1296183,1297626)` L4294 | C1–C4의 **REA 6.7.0 정적 검증**. 일반 소스 읽기와 구별 |
| T-02 | `Oh.executeTargetCdp` `[882176,883844)` L1152; `Ya → Ev → request.timeoutMs → api.executeCdp` | C1/C2. attachment helper 내부 미확장, REA 결과 partial(외부 helper 미해결; 출력 잘림 아님) |
| T-03 | `Ia` `[390164,390451)`, `Kw` `[390451,390654)`, 바깥 `executeCdp` `[373699,374151)` | B2. 직접 취소 호출 없음은 조사한 함수 범위에 한정 |
| N-01 | `FUN_100705dc0`, call `0x100705f00 → postToPid 0x10025ec14 → 0x10025ec20` | N2/N3: LLVM 본문 + 기존 REA 심볼/래퍼 증거. 최종 간접 target 및 실제 분기 실행 UNKNOWN |
| N-02 | `FUN_10074a96c`; call `0x10074ac44`, return `0x10074ac48`; 이전 앱 `activateWithOptions:0` | N1의 LLVM 대조, N4 L9339 부근 `NSRunningApplication → SLSSetFrontProcessWithInfo` 샘플 |
| N-02/N-03 | A 로그 L31 `keyDown`, L32 `textDidChange`; B 로그 L47 관찰 종료 | N5/N6 계측. `ㅌ`과 사용자 직접 입력은 H337의 당시 관찰 보고 |

N5 L31/L32에서 foreground는 A, `sawActualBForeground`·`sawActualAReturn`은 true다.
A의 key count는 1, text change는 0→1, cursor change는 0이다.
N6 L47의 B key/text/cursor count는 0이며 foreground A라는 원시 로그 확인을 반영한다.
L48 `willTerminate`는 관찰 종료 뒤 정리 시점이다. 그때 foreground B인 것을 복귀 실패로 해석하지 않는다.

## 부록 C. 원본 보관 매핑

상대 경로 기준은 보관 실험 **`run-Qvnin2q5/`**다. 원본은 이 저장소에 포함하지 않는다.
개인별 캐시 루트 대신 증거 ID·상대 경로·해시로 보관자에게 조회한다. 저장소 clone만으로 원본 실행을 재현할 수는 없다.

| ID | 상대 경로 또는 기록 ID | 확인 범위 |
|---|---|---|
| H337 | 세션 `019f8d42-4886-7041-8421-c5e343d465e0`, turn 337, `2026-10-21T14:26:11Z–14:27:33Z` | 당시 사람 관찰 보고. 입력 출처의 기계 검증 아님 |
| H340 | 같은 세션 turn 340, `2026-10-21T14:35:57Z–14:49:48Z` | 설치 분석·공개 자료·미확인 연결을 종합한 보고 |
| B1 | `browser/timeout-origin-ZGb896/selected-functions.json` | 직접 읽은 정적 추출; source SHA는 부록 A의 과거 service |
| B2 | `browser/transition-timeout-TlUXuG/functions.json`, `installed-identity.json` | 직접 읽은 확장 함수/식별값; REA `ev_8efe553e7778160713694c03bcba0c84d746230ee659d0a881fe5ab92b71ddd2` |
| B3 | `browser/timeout-origin-ZGb896/live-raw-move-windows.json` | `2026-10-21T12:07:20.731Z` 채집. fixture 관찰 + 호출 경계 보고; 내부 ACK trace 아님 |
| C1 | `browser/timeout-origin-ZGb896/current-boundary-functions.json` | 2026-10-23 추가 정적 분석의 현행 source SHA·함수 범위; artifact SHA는 아래 표 |
| C2 | `browser/timeout-origin-ZGb896/current-boundary-comparison.json` | 현행/과거 대응 비교; 동일한 부분과 attachment 변경을 분리 |
| C3 | `browser/timeout-origin-ZGb896/rea-current-boundary-slice.json` | REA `ev_2f161ddd82938d19f4db82a6db89ace11401e30a88fcaf2af16a5a3d2e79044d` |
| C4 | `browser/timeout-origin-ZGb896/rea-current-remaining-callers.json` | REA `ev_c3a3c025db170d1d728123d08af965178ac9586f083a08bb1bacf92b0943eb5d` |
| N1 | `native/focus-restore-6yqdDW/42-sampled-continuation-llvm-raw.json` | LLVM 정적 continuation와 샘플 주소의 대응 자료 |
| N2 | `native/focus-restore-6yqdDW/43-native-e2e-bounded-raw.json` | 바이너리 식별·LLVM/기존 REA 분석. 이름의 e2e를 실제 입력 E2E 완료로 읽지 않음 |
| N3 | `native/focus-restore-6yqdDW/45-virtual-cursor-dispatch-side-effect-raw.json` | `2026-10-21T14:46:48Z–14:47:46Z`; `postToPid` 호출 및 기존 REA `ev_4fb12a65679e8e6dc98d8b025318a722a28aef5f18ce18b969f398911dfcf26b` |
| N4 | `native/activation-cause-F5T7Wz/bound-explicit-source/induced/helper-78131-20s.sample.txt` | 과거 실행 샘플; A87904/B87917 입력 실험과는 다른 관찰 자료 |
| N5 | 같은 induced 디렉터리의 `A-87904.events.jsonl` L31/L32 | 원시 로그에서 입력 수신·텍스트 변경·물리 출처 false 재확인 |
| N6 | 같은 induced 디렉터리의 `B-87917.events.jsonl` L47 | 원시 로그의 관찰 종료 경계 확인; 뒤의 L48 정리 시점과 구별 |

원본 교체를 감지할 최소 artifact SHA-256은 다음과 같다. 설치 실행 파일 해시와 JSON/로그 파일 해시는 다른 값이다.

| 증거 | artifact SHA-256 |
|---|---|
| B1 | `9e096bb41b291ac70fddcba8d9fbf1aaa28468000abe71a5ec442747b5a29450` |
| B2 functions / identity | `14d502a8d134f5d5903d38fddaaf199e60c91ccca12dd4a36cf56e5d33004a16` / `0a2f1f0541ca575c3dded0bdddfe6a563fe43edee0721264c74dc8e53eaa80d4` |
| B3 | `d0c8b8fa6c2e70c532aff996a596b0693fdacfd97a1097faad7a29740de62851` |
| C1 | `f3d0d9eb8a1edd4fb9d8f2038cd12385861da08aaddb6512e7a224e5ac8e0cb5` |
| C2 | `0a63e9272877f866acac7e12bd55e7434cfc8fd5a5e9b1248d5df1a067f1ea2a` |
| C3 | `61e5bfef93d62bb336430bb14050fea3f41e4d4e07fedf85b8ace237887cd731` |
| C4 | `0d933afe4b19d630edfabf8ebaa1d93ba0fadf990a769a2ee9039eea0653d4f3` |
| N1 / N2 | `2848bf3c8252f9c290f812765c0e0b4b69e429f65ee2cc0359ec663210e53a30` / `9acafdd29d2dd6de945b58743724aeba0d7332cdc8c794d773812b209fde8b45` |
| N3 / N4 | `13c52f8ece74cb2421c5aa71afdc38eb55ed3651347516cfb3e325b7dc5a256d` / `3c7e9d496dc60a6aebd60a7c6337da1a18b17e8dcd8fd62f965ca6550885921e` |
| N5 / N6 | `f8b6cda86acd2051708ae573a9b46a89f56a5f6c94be018755157ccc5d55033b` / `68edc62bc53dd20ccbe9f1d8684d031a9c942e68480a0bd195f50bcf39ce8c8f` |

현행 C1–C4 artifact SHA-256은 2026-10-23 보관 파일에서 산출했다. 설치 service SHA·함수 위치·REA evidence ID와 함께 조회한다.
자료의 해시가 맞아도 전체 호출 그래프·현재 설치 동작·취소 보장을 증명하는 것은 아니다.
