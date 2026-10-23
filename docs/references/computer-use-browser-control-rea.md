# ChatGPT 데스크톱 Computer Use·Browser Control 조사

작성·공개 자료 확인: **2026-10-23**. 대상 독자: EG-Desk 개발자.
상태: **검토완료·미확인항목 포함**. 기존 설치본 분석·통제 실험과 10월 23일 추가 정적 검토를 합친 연구 참고 문서다.
제품 기능 명세나 모든 앱에서의 동작 보증이 아니며, 새 기능 결정을 요구하지 않는다.

- **직접 확인:** 설치 코드에서 브라우저 CDP 입력·DOM 표시 커서와 네이티브 PID 입력·포커스 복원을 구분했다. 제한된 과거 A/B 시험에서는 A→B→A 복귀와 A의 입력 수신을 확인했다. 현행 브라우저 서비스는 REA 정적 분석, 현행 네이티브의 선택된 경계는 LLVM 정적 부분 대응까지 확인했으며 현행 네이티브 실행을 재검증한 것은 아니다.
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

**B-04 — RPC 응답 대응은 입력 효과의 식별자가 아니다.** 현행 설치 JS는 요청에 `session_id/turn_id/session_context`를 합치고,
인스턴스별 증가형 JSON-RPC ID·pending map으로 응답을 대응시킨다. socket 직렬화·native pipe 위임과 확장의 수신 ID 그대로 응답도 확인했다.
cached 세션은 기존 세션·활성 turn이 필요하고, 숫자 `target.tabId` 경로에는 소유권·attached 검사가 있다. 모든 target 형태의 소유권 검증을 입증한 것은 아니다.
앱의 `session_id`와 CDP `target.sessionId`는 별개다. CDP 전송에는 target/method/commandParams를 쓰며 바깥 RPC ID를 입력 효과 ID로 넘기지 않는다.
native pipe/host 내부의 ID 재작성 여부와 전체 경로의 실제 ID·효과 대응은 **UNKNOWN**이다. 소스 확인과 REA의 제한된 호출 연결은 부록에서 구분한다. [C9, C10]

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

**N-04 — 현행 네이티브는 LLVM 정적 부분 대응까지 확인했다.** 새 심볼·디스어셈블리에서 복원 후보의 수신 객체·BOOL/PID 검사와
virtualCursor 관련 `postToPid` 경로를 대응시켰다. 선택된 경계에서 의미 있는 구조 변화는 발견하지 않았지만 전체 동등성이나 실제 입력 전달을 입증하지 않는다.
현행 Ghidra 초기화는 완료되지 않아 **REA 함수 dossier는 없다**. 이 결과는 LLVM 정적 분석이며 일반 소스 읽기·REA 분석 완료·runtime 검증과 구별한다. [N7, N8]

이 결과는 독립적인 OS 포커스 두 개, 영구적인 전역 커서 무이동, 모든 앱의 동시 조작 또는 Stop 후 무입력을 보장하지 않는다.

## 3. P1: timeout은 효과 없음이나 취소 완료가 아니다

**T-01 — 3,000→2,998ms는 잔여 예산 계산이지 지연 원인이 아니다.** 과거 서비스 `We`는 기본 3,000ms를 정하고,
`clickPoint`가 절대 deadline을 만들며 `Rf`가 남은 시간을 전달한다.
소스 기반 모의 시계에서 `3000−2=2998`을 재현했다는 분석 보고가 있다.
당시 내부 전송 순간에 정확히 2ms가 경과했거나 그 함수가 hit됐다는 런타임 기록은 아니다. [B1, H340]

**T-02 — 현행 서비스에도 예산/클릭 구조는 확인됐지만 전체가 동일하지 않다.** 2026-10-23 추가
REA 6.7.0 정적 분석은 새 서비스의 `$e`, `Ev`, `ig.clickPoint`에서 기본 예산·잔여 예산·move/down/up 구조를 확인했다.
attachment 경로는 `waitForTabAttachment(tabId, options)`를 거치며, attached이면서 initializing인 탭의 일반 호출은 공유 promise를 기다린다.
초기화 handler가 같은 탭의 표식을 넘기면 이 대기와 재시도는 우회한다. **자기 대기를 피하려는 구조라는 설명은 해석**이다. [C1–C8]
최상위 일반 탭 대상의 debugger-unattached 오류에는 options·deadline을 재사용해 최대 1회 재시도한다. timeout 자체는 재시도 조건이 아니다.
대기 시간은 원래 deadline에서 소비되어 이후 CDP 잔여 예산에 반영된다. deadline이 없으면 이 대기의 deadline 타이머도 없다.
내부 attach에는 절대 deadline 대신 계산된 timeout 값이 전달되므로, 외부 대기 timeout 뒤 늦은 attach 완료와 focus emulation이 가능한 **정적 경로**가 남는다.
이는 실제 발생이나 원래 클릭의 late effect를 증명하지 않는다. 오류·함수 위치·분석 범위는 부록 B에 구분했다. [C5–C8]

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

**N-05 — 현행 Stop/대기열의 정적 경로는 부분 확인됐다.** N7과 같은 helper의 LLVM·파일 메타데이터에서 Stop IPC의 정지 표식,
Stop 정리·PerformAction의 앱별 serialExecutor 필드/tail 공유, 앞선 Task 결과 대기 후 action 전 취소·intervention reason 검사를 확인했다.
관측된 `Task.cancel`의 대상은 `userInterruptionDebounceTaskByTargetIdentifier`이며 **입력 큐 취소가 아니다**. deactivate 및 오류 시 정지 표식 해제도 정리 경로이지 취소 완료 증거가 아니다.
이는 직접 LLVM 정적 분석으로, 현행 REA 함수 dossier나 실행 증거가 아니다. UI Stop→IPC 연결과 마지막 guard 이후 `postToPid`까지의 취소·ACK·late effect는 **UNKNOWN**이다. [N9]

네이티브 Stop/cancel과 queued input을 연결할 적합한 기존 런타임 trace는 확인되지 않았다. 현재 상태는 **UNKNOWN**이며,
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
| EG-06 | 실제 EG-Desk 소유 fixture의 headless 경계 검증 | 2026-10-23 `42db7c0`의 browser-negative에서 **11개 거부 + guarded fill/click 양성 대조 2개 + 카메라 격리 사례 통과**. 실제 headless UI 실행이지만 test-only synthetic B-service·owned UI 범위이며 native-model/provider 검증은 아니다. [EGQ1] |
| EG-07 | 실제 소유 fixture의 top-document reload 경계 검증 | 2026-10-23 UTC headless QA에서 **UI reload로 문서 교체 → 오래된 action 거부 → 명시적 재선택·fresh observe 후 DOM 클릭 1회 통과**. EG-Desk test-only 소유 UI 근거이며 설치 OpenAI REA·native-model/provider 검증이 아니다. [EGQ2] |

EG-05의 관련 위치는 변경 시 라인이 이동할 수 있으므로 테스트 의미와 함께 확인한다.

- [helper/egdesk-browser-tool-runtime.test.mjs:178](../../apps/firefox-ui-demo/helper/egdesk-browser-tool-runtime.test.mjs#L178): timeout 뒤 action unknown, 새 call ID에도 자동 재시도 없이 `actionCalls=1`.
- [helper/codex-browser-tool-transport.test.mjs:72](../../apps/firefox-ui-demo/helper/codex-browser-tool-transport.test.mjs#L72): 절대 deadline 뒤 늦은 응답을 stale로 처리.
- [scripts/egdesk-browser-tool-transport.test.mjs:592](../../apps/firefox-ui-demo/scripts/egdesk-browser-tool-transport.test.mjs#L592): HTTP await 이전 Stop lease 무효화.
- [scripts/egdesk-browser-agent-guard.test.mjs:425](../../apps/firefox-ui-demo/scripts/egdesk-browser-agent-guard.test.mjs#L425): parent approval await 뒤 상태 재검사.
- [scripts/egdesk-browser-tool-transport.test.mjs:526](../../apps/firefox-ui-demo/scripts/egdesk-browser-tool-transport.test.mjs#L526): 진행 중 approval 취소 시 DOM dispatch 0.

EG-05 실행 출력은 당시 대화에 보관되어 있으며 별도 저장소 보고서가 아니다. 이 개발 테스트의 통과는 독립 구현 검토나
네이티브 입력 실험의 성공을 뜻하지 않는다. 이 문서의 OpenAI 제어 재현을 위한 앱·입력·Stop 실험은 다시 실행하지 않았으며, 별도로 진행되는 EG-Desk headless QA와 구분한다.

EG-06의 카메라 사례는 **카드 보임 → Canvas pan/zoom으로 화면 밖 이동 → fresh observe → guarded DOM click 1회 → finally 카메라·선택 복원**이다.
Card·browsing context·document·content viewport가 같고, actor perform 1회와 클릭 count **0→1**, `documentStillCurrent`·후조건 관찰을 확인했다.
실행 전후 sends/authWrites/runs/providerTurns는 모두 0이다. `dom-click-no-pointerdown` 경로이며 좌표 입력·OS 포커스·native-model/provider 실행 증거가 아니다.
`gfxInfoIsHeadless=true`; screenshot은 unsupported·`visualPass=null`로 남겨 DOM/probe 검증과 시각 검증을 분리한다. [EGQ1]

EG-07은 reload 버튼의 **idle(`loading=false`, `busy=false`)·활성 상태와 9개 hit-test 지점**을 확인한 뒤 실제 하네스 UI 클릭으로 수행했다.
같은 소유 Card·프로필·browsing context·URL·대상 bounds에서 Firefox `innerWindowId`와 actor document ID가 바뀌었다. 오래된 action은 `BROWSER_ACTION_UNVERIFIED`로 거부됐고 새 문서 perform은 0이었다.
cancel 후 소유 카드 메뉴의 명시적 재선택·fresh observe를 거쳐 guarded DOM click 1회, perform/count **0→1**·후조건 관찰을 확인했다. finally 정리 후 카메라·선택 상태도 복원됐다.
전후 sends/authWrites/runs/providerTurns는 0, 실제 headless는 true이며 screenshot은 unsupported·`visualPass=null`이다. 클릭 경로는 `dom-click-no-pointerdown`으로, 좌표 입력·native-model/provider·OS 포커스 증거가 아니다. [EGQ2]

<a id="remaining-analysis"></a>
## 7. 남은 분석: 필요한 이유와 최소 확인 범위

아래는 **미확인 항목 목록이지 실행 일정이나 실험 승인 요청이 아니다.** 현재 승인된 소유 fixture의 background 일반 QA는 기존 승인 범위에서 수행할 수 있다. 실제 OS 전면 전환이나 새 권한이 필요한 경우에는 실행 전에 알리고 승인 범위를 확인한다.

| ID / 항목 | EG-Desk에 필요한 이유 | 다음 최소 확인 | OS 전면 필요 여부 / 현재 상태 |
|---|---|---|---|
| R-01 / P1 timeout 뒤 효과 | 결과 미확정 요청의 중복 입력을 막기 위해 | 소유 fixture에서 command ID·move 수신·dispatch·timeout을 같은 시계로 연결한다. | 배경 시험 자체는 OS 전면 불필요; 전환 재현에는 통제된 전면 전환 필요 / 기존 로그로 late effect **UNKNOWN** |
| R-02 / P2 native Stop | 새 dispatch 차단과 이미 보낸 입력의 수신을 구별하기 위해 | N-05의 정적 경계를 기준으로, 승인된 시험에서 `enqueue/dispatch/Stop ACK/receive`에 command ID·순서·PID를 붙여 ACK 전후를 구분한다. | 통제된 A/B 전면 전환·입력 필요 / Stop 표식·대기열·guard의 LLVM 부분 확인. UI Stop→IPC 및 마지막 guard 이후 취소·ACK·late effect는 런타임 trace가 없어 **UNKNOWN** |
| R-03 / 현행 native 버전 변화 | 과거 offset·복원 결과를 새 helper에 잘못 적용하지 않기 위해 | N7의 정적 부분 대응을 기준으로, 실행 동등성이 제품 판단에 필요할 때 승인 범위를 확인한 제한 시험을 한다. | 정적 대응은 OS 전면 불필요; 실행 재검증은 별도 / **LLVM 정적 부분 대응 완료**, REA dossier 없음·runtime 동등성 **UNVERIFIED** |
| R-04 / Gecko frame·zoom·배경 좌표 조합 | Chromium의 관찰/입력 좌표 계약을 Firefox로 오인하지 않기 위해 | 소유 페이지에서 frame·확대율·화면 배율·배경/최소화 조합별 fresh snapshot 좌표와 실제 수신 대상을 대조한다. | 좌표 단위 검증은 OS 전면 불필요; 배경/최소화 실측은 통제 전환 필요 / EG-06/07은 Canvas 카메라·top-document 교체와 DOM 클릭의 제한된 부분 검증. frame·page zoom·DPR·좌표 입력 및 조합별 실행은 **UNVERIFIED** |
| R-05 / 불투명 host 연결 — 낮은 우선순위 | 대상·세션 경계의 누락을 확인하되 구현을 추측해 복제하지 않기 위해 | B-04의 송수신 JS·세션/숫자 탭 검사 부분 확인을 기준으로, 필요할 때 native pipe/host 내부의 ID 전달·재작성 연결만 보완한다. | 정적 검토는 OS 전면 불필요 / 내부 ID 재작성·E2E runtime 대응은 **UNKNOWN**. 모든 target 소유권 검증 아님; 제품 변경의 선행 조건으로 삼지 않음 |

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
과거 native UUID는 `6AD9DE94-5466-38A4-B2E0-F81DFBC620DB`, 현행은 `374107F0-B948-3F44-A251-E9E7D5FEBC70`다. 현행 식별값은 N7에서 재확인했다.

## 부록 B. 주장별 함수·증거 위치

브라우저 byte 범위는 UTF-8의 반개구간 `[start,end)`, line은 1-based다.
네이티브 VA는 해당 버전의 image base `0x100000000` 기준이며 실제 로드 주소와 구별한다. 아래 native 함수 위치는 현행으로 명시한 N-04·N-05 행을 제외하면 과거 버전이다.
C5는 Babel로 위치·원문 slice를 추출한 자료다. C6–C8은 그 원문 함수 slice에 클래스 포장만 추가한 파생 파일을 대상으로 한 **실제 REA 6.7.0 정적 분석**이다.
파생 slice SHA-256은 `f5286c94b34c4c3abb8b7a30b0d921cfd818661fa66a78f304a8cc003b2f926c`다. 분석은 partial이며 출력 잘림은 없지만 동적 `this`·외부 helper 전체 연결이나 실행을 증명하지 않는다.
C9의 설치 JS 원문 slice·클래스 포장 파생물에 C10의 REA 6.7.0을 실행했다. 출력 잘림 없이 partial이며, `$o.create → ob → Xue`, `Kw → Ia` 연결만 해소했다. 나머지 B-04 동작은 일반 소스 확인이며 동적 전체 그래프·runtime 검증이 아니다.

| 주장 | 식별점 | 증거·수준 |
|---|---|---|
| B-01/B-02 | 확장 `focusTab`, `executeCdp`, `Ia`, `Kw` L38; overlay `pointer-events:none` | B2의 정적 함수 + H340의 설치 코드 검토 보고. overlay/IAB 원본은 이번 문서 작업에서 재열람하지 않음 |
| B-02 | 과거 ASAR `.vite/build/main-CLu1A25j.js` L993/L1003; `executeCdpForBrowserUse`, `sendDebuggerCommand` | H340 설치 코드 보고. 현행 IAB 동등성은 UNVERIFIED |
| B-04 — service 요청/응답 | `Jc.sendSessionRequest` `[1438154,1439676)` L4324; `Qn.sendRequest` `[117690,117933)`, `handleIncomingMessage` `[117933,118213)` L851 | C9 소스. session/turn/context 결합, 인스턴스별 증가 ID와 pending map 응답 대응 |
| B-04 — transport 경계 | `as.sendMessage` `[1406391,1406536)`, `Xue` `[1410092,1410206)`, `ob` `[1410336,1410455)` L4323; 확장 `iS.connect` `[393624,394572)` L38 | C9 소스: JSON→socket, `nodeRepl.nativePipe.createConnection` 위임, native port 수신 callback. 내부 host 구현 미조사; C10은 위의 제한된 호출 연결만 확인 |
| B-04 — 확장 응답/입력 | `Ko.handleIncomingRequest` `[12913,13480)` L1; `Ia` `[390164,390451)` L38 | C9 소스. 받은 RPC ID로 응답; `Ia`의 CDP 전송은 바깥 RPC ID를 입력 효과 ID로 사용하지 않음 |
| B-04 — 세션/숫자 탭 | `Aw.resolveSession` `[371721,372093)`, `Ou.executeCdp` `[373699,374151)`, `requireSessionTab` `[380602,381202)`, `requireOwnedTab` `[381202,381366)`; L38 | C9 소스. cached 기존 세션·활성 turn 확인; 숫자 탭 소유권·attached 검사. 다른 target 형태로 일반화하지 않음 |
| T-01 | `We` `[252876,252986)` L844; `Rf` `[779186,779324)` L1121; `clickPoint` `[1169262,1170705)` L4263 | B1 정적 소스 추출. 모의 시계 결과는 H340 보고이며 실제 타임라인 아님 |
| T-02 | `$e` `[367466,367576)` L875; `Ev` `[905463,905601)` L1152; `ig.clickPoint` `[1296183,1297626)` L4294 | C1–C4의 **REA 6.7.0 정적 검증**. 일반 소스 읽기와 구별 |
| T-02 | `Oh.executeTargetCdp` `[882176,883844)` L1152; `Ya → Ev → request.timeoutMs → api.executeCdp` | C1/C2/C5–C8. 최상위 일반 탭·`options[Xa] !== tabId`에서 debugger-unattached 1회 재시도, 같은 options·deadline 재사용. timeout은 별도 오류 처리이며 재시도 조건 아님 |
| T-02 | `Oh.waitForTabAttachment` `[891859,892203)`, `ensureAttachedTab` `[892203,892785)`, `runTabAttachHandlers` `[891431,891644)`; 모두 L1152 | C5/C6. attached+initializing 일반 호출은 공유 promise 대기; handler의 `{[Xa]:tabId}` 전달로 같은 탭 초기화의 대기/재시도 우회. 자기 대기 회피는 구조에 대한 해석 |
| T-02 | `Tv` `[905653,905925)`, `Ev` `[905463,905601)`; L1152 | C5–C8. `Tv`는 원 deadline으로 대기하고 `Ev`는 이후 잔여 예산을 계산. `deadlineMs`가 없으면 `Tv` 타이머 없음. 대기 오류 `CDP operation exceeded its deadline before command dispatch`는 과거 `Input.*` 2,998ms timeout과 다른 경계 |
| T-02 | `Oh.attachTab` `[892785,893214)`, `enableFocusEmulation` `[893214,893410)`; L1152 | C5/C6. 내부 attach에는 계산된 `timeoutMs`와 초기화 표식만 전달, `deadlineMs` 미전달. 외부 대기 timeout 뒤 늦은 attach→focus emulation 가능 경로; 실제 발생·원 클릭 효과는 UNKNOWN |
| T-02 | 과거 `kf.attachTab` `[766515,766944)` L1121 ↔ 현행 `Oh.attachTab` | C5에서 원문 byte 동일; 함수 SHA-256 `cd4170a61895b1b274329eb49f6baea7f1bf1db805a40c191cda6ae694d9820f`. 호출자·외부 상태까지 동등하다는 뜻은 아님 |
| T-03 | `Ia` `[390164,390451)`, `Kw` `[390451,390654)`, 바깥 `executeCdp` `[373699,374151)` | B2. 직접 취소 호출 없음은 조사한 함수 범위에 한정 |
| N-01 | `FUN_100705dc0`, call `0x100705f00 → postToPid 0x10025ec14 → 0x10025ec20` | N2/N3: LLVM 본문 + 기존 REA 심볼/래퍼 증거. 최종 간접 target 및 실제 분기 실행 UNKNOWN |
| N-02 | `FUN_10074a96c`; call `0x10074ac44`, return `0x10074ac48`; 이전 앱 `activateWithOptions:0` | N1의 LLVM 대조, N4 L9339 부근 `NSRunningApplication → SLSSetFrontProcessWithInfo` 샘플 |
| N-02/N-03 | A 로그 L31 `keyDown`, L32 `textDidChange`; B 로그 L47 관찰 종료 | N5/N6 계측. `ㅌ`과 사용자 직접 입력은 H337의 당시 관찰 보고 |
| N-04 — 현행 복원 후보 | 새 심볼 `safelyEnforceActiveState` `0x10074ab10 → continuation 0x10074abd8`; 최초 call `0x10074b4d8`, 반복 continuation `0x10074d1d4`의 call `0x10074d4ac` | N7 LLVM. receiver는 context `+0x1d8`, `activateWithOptions:0` 후보·BOOL/PID 비교·50ms/2s 형태 유지. 실제 복원 실행·대기시간 실측 아님 |
| N-04 — 현행 virtualCursor 경계 | 현행 descriptor 대조 후 continuation `0x100708628`; call `0x100708768 → postToPid 0x100261478` | N7 LLVM·심볼·과거 명령열 비교. event/PID 전달 형태 유지; 최종 OS 전달·실제 분기 실행은 UNKNOWN |
| N-04 — 현행 간접 전송 | `postToPid 0x100261478 → wrapper 0x100261484 → indirect branch 0x1002614c4`; slot `0x1014e3140` | N7의 정적 경계. slot의 최종 runtime target은 UNKNOWN; N8은 REA 분석 시도 기록이지 현행 함수 dossier가 아님 |
| N-05 — 현행 Stop IPC | handle `0x10015c30c → descriptor 0x10110d520 → 0x100176be0 / 0x100176c3c`; call `0x100176cb0 → 정지 표식 0x1000adc50` | N9 `stopDescriptors2`, `stopIpcSelectedBody`. UI Stop에서 이 IPC로 진입하는 연결은 UNKNOWN |
| N-05 — 현행 직렬 대기열 | Stop·PerformAction(`0x10015d9d0`)의 serialExecutor 필드 offset global `0x1015493b0`; 특수화 `0x1000ab8e4 / 0x1000ac0c4`, 공통 tail `+0x70` | N9 `stopEntryInitial`, `stopPerformActionEntry`, `stopQueueSpecialized`, `stopActionSerialSpecialization`. 같은 필드/slot의 정적 사용이며 실제 실행 순서·큐 취소 증거 아님 |
| N-05 — 현행 action guard | worker `0x1000ac794`: 앞선 Task가 있으면 `.result` 대기 → `0x1000ac910`의 `Task.checkCancellation`; action의 call `0x10015e020 → 0x10015cccc`; stopped 오류 `0x10015d0ac–0x10015d0b0`, `appStoppedByUser` tag 2 | N9 `stopActionWorkerGate`, `stopInputQueuedGuards`, `stopActionValidation`, `stopStateAndErrorFieldMetadata`. intervention reason 검사 확인; N7의 입력 call `0x100708768`까지 취소가 원자적으로 보장된다는 뜻은 아님 |
| N-05 — 현행 정리 경로 | Stop cleanup `0x1000ab728`, call `0x1000ab770 → deactivate 0x100072480`; 오류 경로 `0x100176fac → clearStoppedByUser 0x1000adde8` | N9 `stopBody0`, `stopIpcSelectedBody`, `stopExactNamesNmOutput`. 정리/표식 해제를 입력 역전·Stop ACK 완료로 해석하지 않음 |
| N-05 — 현행 cancel 대상 | `0x1000add6c → Task.cancel`; `userInterruptionDebounceTaskByTargetIdentifier` | N9 `stopSetMarker`, `stopTaskRecordGetSet`, `stopTaskBindingsLLVM`, `stopStateAndErrorFieldMetadata`. 사용자 개입 debounce Task 대상이며 입력 큐·이미 보낸 OS 이벤트 취소가 아님 |

N5 L31/L32에서 foreground는 A, `sawActualBForeground`·`sawActualAReturn`은 true다.
A의 key count는 1, text change는 0→1, cursor change는 0이다.
N6 L47의 B key/text/cursor count는 0이며 foreground A라는 원시 로그 확인을 반영한다.
L48 `willTerminate`는 관찰 종료 뒤 정리 시점이다. 그때 foreground B인 것을 복귀 실패로 해석하지 않는다.

## 부록 C. 원본 보관 매핑

상대 경로 기준은 보관 실험 **`run-Qvnin2q5/`**다. EGQ1/EGQ2는 별도 EG-Desk QA 보관 디렉터리이며 이 REA 실험에 속하지 않는다. 원본은 이 저장소에 포함하지 않는다.
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
| C5 | `browser/timeout-origin-ZGb896/attachment-boundary-functions.json` | `2026-10-23T13:25:53.250Z`; 현행/과거 함수 원문 위치·source/slice SHA·대응표. source SHA는 부록 A |
| C6 | `browser/timeout-origin-ZGb896/rea-attachment-boundary.json` | REA `ev_03bb870d7fe041d6e7854384d624563bf49cffe43b94db4265ab6854be835f5b`; 원문 파생 slice 분석 |
| C7 | `browser/timeout-origin-ZGb896/rea-attachment-boundary-Tv-callers.json` | REA `ev_e26b958de58f84aaa8be195253eb58cdbf7307e787dd0e5fc8b2f42840feeec9`; 정적 의미 추적, coverage partial |
| C8 | `browser/timeout-origin-ZGb896/rea-attachment-boundary-Ev-callers.json` | REA `ev_2237e5c919b44a7105504b839fcf45505578cb5358459fc0aaafe288b7174382`; 정적 의미 추적, coverage partial |
| C9 | `browser/timeout-origin-ZGb896/request-correlation-functions.json` | `2026-10-23T14:22:01.133Z`; 설치 JS 위치·원문 slice. service/확장 source SHA는 부록 A의 현행 값과 동일 |
| C10 | `browser/timeout-origin-ZGb896/rea-request-correlation.json` | REA `ev_8c96c7b4d8d4322d7a3889102052c876f560034635cec6c8151d4c29d1e699f6`; 원문 slice·클래스 포장 파생물의 제한된 정적 연결, partial·출력 잘림 없음 |
| N1 | `native/focus-restore-6yqdDW/42-sampled-continuation-llvm-raw.json` | LLVM 정적 continuation와 샘플 주소의 대응 자료 |
| N2 | `native/focus-restore-6yqdDW/43-native-e2e-bounded-raw.json` | 바이너리 식별·LLVM/기존 REA 분석. 이름의 e2e를 실제 입력 E2E 완료로 읽지 않음 |
| N3 | `native/focus-restore-6yqdDW/45-virtual-cursor-dispatch-side-effect-raw.json` | `2026-10-21T14:46:48Z–14:47:46Z`; `postToPid` 호출 및 기존 REA `ev_4fb12a65679e8e6dc98d8b025318a722a28aef5f18ce18b969f398911dfcf26b` |
| N4 | `native/activation-cause-F5T7Wz/bound-explicit-source/induced/helper-78131-20s.sample.txt` | 과거 실행 샘플; A87904/B87917 입력 실험과는 다른 관찰 자료 |
| N5 | 같은 induced 디렉터리의 `A-87904.events.jsonl` L31/L32 | 원시 로그에서 입력 수신·텍스트 변경·물리 출처 false 재확인 |
| N6 | 같은 induced 디렉터리의 `B-87917.events.jsonl` L47 | 원시 로그의 관찰 종료 경계 확인; 뒤의 L48 정리 시점과 구별 |
| N7 | `native/focus-restore-6yqdDW/46-current-native-llvm-raw.json` | 2026-10-23 현행 helper 식별·새 심볼·LLVM 함수/명령열 최소 대응. `direct-LLVM-static-not-REA-function-dossier` |
| N8 | `native/focus-restore-6yqdDW/47-current-native-rea-attempt-raw.json` | 2026-10-23 REA/Ghidra 초기화 미완료·세션 종료 기록. 현행 REA 함수 dossier 미확보; runtime 증거 아님 |
| N9 | `native/focus-restore-6yqdDW/48-current-native-stop-queue-llvm-raw.json` | `2026-10-23T14:57:14Z`; N7과 같은 helper 26.1015.1001540·SHA·UUID. `raw_results`의 지정 함수 출력·파일 메타데이터를 대조한 직접 LLVM 정적 근거이며 REA 함수 dossier가 아님. 대상 실행·UI 입력·프로세스 메모리·runtime 관측 없음 |
| EGQ1 | 별도 QA 보관: `egdesk-chat-evidence-CJTqA3/result.json` | 2026-10-23, `42db7c0` 실행 보고. result의 거부/양성 대조·cameraSurfaceIsolation·headless·backend 전후 카운터만 대조; 설치 OpenAI 제어 재현 실험이 아님 |
| EGQ2 | 별도 QA 보관: `egdesk-chat-evidence-Abaf75/result.json` | reload 관찰 `2026-10-23T15:10:39.320Z`. 실행 runtime `7aeb22a`; 실행한 QA runner의 후속 커밋 `86c7156`(main 통합 `283f472`). `browserDocumentReplacement`·headless·backend 전후 카운터 대조 |

EGQ2의 소유 Card 5·context 17에서 `innerWindowId`는 `27917287425 → 27917287426`, actor document는 `3a895710-1afb-4bce-b941-c5452eb3c338 → 2322f46e-f6df-4a21-a867-59900c55d2c1`로 바뀌었다. 프로필·URL·대상 bounds의 동일성은 관찰값 비교이며 좌표 입력 성공을 뜻하지 않는다.

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
| C5 / C6 | `de638f8298abdab5eb2420c073b82010d3ef7e95bbda22081cdaaf61fab75cac` / `1948fd51d882bad666cb05f0ac754c8bbee1a8f3d7709f181ced28f90c6b5423` |
| C7 / C8 | `df4afd7b55c60c6ff4dfb781d69287e07cac5592af39df796ba6fb5dd1b7b4b0` / `12c60877f7550c4ec2a7f7dab008dac31344317e96f69b6b59a6c99811315ea9` |
| C9 / C10 | `7a00f3cfbb5a60761e844461312efa7e654bbcb43b303b8a2f5bb36bb95d90ae` / `c41d0db51e394e41dc1c10d57c0b93aa7a383f7ad663e357f9626ea38e2c5369` |
| N1 / N2 | `2848bf3c8252f9c290f812765c0e0b4b69e429f65ee2cc0359ec663210e53a30` / `9acafdd29d2dd6de945b58743724aeba0d7332cdc8c794d773812b209fde8b45` |
| N3 / N4 | `13c52f8ece74cb2421c5aa71afdc38eb55ed3651347516cfb3e325b7dc5a256d` / `3c7e9d496dc60a6aebd60a7c6337da1a18b17e8dcd8fd62f965ca6550885921e` |
| N5 / N6 | `f8b6cda86acd2051708ae573a9b46a89f56a5f6c94be018755157ccc5d55033b` / `68edc62bc53dd20ccbe9f1d8684d031a9c942e68480a0bd195f50bcf39ce8c8f` |
| N7 / N8 | `e4e71047cb008961d3726d9b79463c5b010d450f74b75bc91647362dabe48827` / `0bd1e57738753986492adc4de022d7db0ebf1aa75abfa2a5e61612936a537dd0` |
| N9 | `a3ffcb1328a8344ca202d63025182f268b5a387d04b4d1d364c3c31bcb7aa1bd` |
| EGQ1 | `a07a9f5aa10ca0e2ff20c9252711ab8f63ef81a9b9fc42555e65ade90e929908` |
| EGQ2 | `a67fd11a570b7ba2feb9189c5b0381ead74cecb964c8363db42a09d157a5890a` |

현행 C1–C10 및 N7–N9 artifact SHA-256은 2026-10-23 UTC 보관 파일에서 산출했다. 설치 service/helper SHA·함수 위치·해당하는 REA evidence ID와 함께 조회한다.
자료의 해시가 맞아도 전체 호출 그래프·현재 설치 동작·취소 보장을 증명하는 것은 아니다.
