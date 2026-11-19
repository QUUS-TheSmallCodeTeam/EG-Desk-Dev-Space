# 결정 모델 컨텍스트 세팅·브라우저 반사 (구현 준비)

**작성**: 2026-11-17 · **상태**: 기반 모듈 구현·단위 시험 완료, 실행 경로 미연결(기본 꺼짐)
**관련**: [`ideas/brainstorming/JEV_INTEGRATION_SUGGESTIONS.md`](../../../ideas/brainstorming/JEV_INTEGRATION_SUGGESTIONS.md)(Jev 초안, 미채택) · [`BROWSER_AGENT_OBSERVATION_RUNTIME.md`](BROWSER_AGENT_OBSERVATION_RUNTIME.md)

## 1. 목적과 원칙

객관식 판단은 결정 모델이 맡고, 추론 모델은 주관식이 필요할 때만 부른다.

| 판단 | 담당 |
|---|---|
| 이번 턴에 어떤 자료가 필요한가, 어느 시점(과거·현재·계획·가정) 얘기인가, 답 유형은 무엇인가 | 결정 모델 |
| 브라우저에서 다음에 무엇을 누를까, 페이지 상태는 어떤가, 목표에 도달했나 | 결정 모델 |
| 계획이 완료·취소됐다는 보고인가, 가정 분기를 어디서 시작하나 | 결정 모델 |
| 답변 문장, 시뮬레이션 서술, 검색어·입력 문장, 버튼을 누른 뒤 기대 효과(postcondition) | 추론 모델(Codex/Claude) |

- 결정 모델: OpenAI Decisions API(`POST /v1/decisions`, `gpt-6-luna` 전용). predicate·choice·score만 반환하고 문장·인자를 만들지 않는다.
- 확률은 실행 권한이 아니다. 실행 가능 여부는 기존 `classifyAction`·URL 정책·카드 권한·revision 검사가 정한다.
- 결정 호출이 실패하면 지금 방식(추론 모델이 직접 도구 호출)으로 돌아간다.
- 키·크레딧(2026-11 기준): ChatGPT Pro($100/$200/$500)·Business 좌석의 API 크레딧이 연결한 API 조직의 project key에 적용된다. Plus는 대상 아님. API 키로 쓰는 Codex는 크레딧 대상 아님.

## 2. 구현된 모듈

아래는 초기 구현 목록이다. 일반 채팅은 현재 `codex-chat-runtime.mjs`의 `prepareDecisionContext`에 연결되어 있다. 기본은 `off`다. `advisory`는 판단만 기록하고, `on`만 선택한 자료를 추론 입력에 넣는다. 일반 채팅에서 추론 호출 자체를 건너뛰는 기능은 아니다.

| 파일 | 역할 | 시험 |
|---|---|---|
| `helper/egdesk-decision-client.mjs` | Decisions API 클라이언트. 요청 한도 검증(문항 1~400, 선택지 2~255, 등급 2~10, cache key ≤64), 답 정규화(거절·누락·형식 오류 = 불명), 오류 분류(401·429 크레딧 소진/한도·403/404·5xx·시간 초과·취소), 재시도 없음, 월 입력 토큰 로컬 상한 | `egdesk-decision-client.test.mjs` 9 |
| `helper/egdesk-decision-credential.mjs` | 키 저장(0700 디렉터리·0600 파일, 원자적 쓰기, 심볼릭 링크·느슨한 권한 거부, 손상 파일 격리). 키는 `getApiKey()`로만 나감 | `egdesk-decision-credential.test.mjs` 6 |
| `helper/egdesk-decision-questions.mjs` | 선택지 고유 라벨, 질문 생성, 확률·신뢰도·차이 기준 판독, 임계값(보정 전 임시값) | `egdesk-decision-questions.test.mjs` 4 |
| `helper/egdesk-context-setup.mjs` | 턴 전 컨텍스트 세팅(`prepareTurnContext`), 가정 분기(`planBranchContext`·`judgeBranchSave`), 시간선 전이 제안(`planTimelineTransition`), 활동 행(`decisionContextActivity`), 온톨로지 그래프 후보 변환 | `egdesk-context-setup.test.mjs` 10 |
| `helper/egdesk-browser-reflex.mjs` | 브라우저 반사 루프(`runBrowserReflex`)와 추가 도구 `egdesk_browser_reflex` 명세 | `egdesk-browser-reflex.test.mjs` 8 |
| `helper/egdesk-decision-http.mjs` | `GET /decision/status`, `POST`·`DELETE /decision/credential` | `egdesk-decision-http.test.mjs` 3 |

## 3. 흐름

### 3.1 턴 전 컨텍스트 세팅
1. 후보 수집(코드): 선택 자료, Board 자료, 최근 대화, 시간선 스냅샷·문서. 제목·요약·시점만.
2. 결정 요청 1회: `answer_type` choice + `time_intent` choice + 후보마다 `rel_i` predicate(최대 398개). 카탈로그는 명시 cache breakpoint 뒤 30분 캐시, 메시지는 그 뒤.
3. 선택(코드): 필수·메시지에 이름이 나온 자료는 점수와 무관하게 포함. 나머지는 임계값 이상. 현재 시점 질문에서 계획·가정 자료는 더 높은 기준(0.8). 거절은 불명.
4. 원문 로드 → 자료마다 `[item id=… kind=… time=… status=… source=…]` 머리말 → `extraContext.egdesk_decision_context` 문자열.
5. 추론 턴: 자료로 답하고 모자랄 때만 도구 사용.

### 3.2 가정 분기와 시간선 전이
- 분기: 기준 상태 choice → (의존) 그 기준에 속한 사실 predicate → 기준·사실·가정(사용자 원문)을 묶어 추론 1회.
- 전이: 열린 계획 항목 choice + 전이 종류 choice. 완료·취소는 고정 문구로 확인 제안(추론 없음), 변경은 추론 필요.

### 3.3 브라우저 반사 (`egdesk_browser_reflex`)
- 추론 모델이 자기 run 안에서 한 번 부르는 추가 도구. 매 단계는 기존 `egdesk_browser_*` 도구를 그대로 거쳐 카드 권한·행동 분류·같은 사이트 정책·revision·receipt가 모두 적용된다. run 밖 helper 단독 루프는 카드 binding이 없어 지원하지 않는다.
- 스스로 하는 것: 같은 사이트 링크 이동(url postcondition), 스크롤, 받은 값으로 입력(target-value postcondition), 로딩 대기, 목표 도달 시 종료.
- 돌려주는 것: `needs_free_text`(쓸 문장 필요), `escalated`(버튼·탭은 기대 효과를 모델이 정해야 함, 불확실, 차단), `handoff`(로그인·2단계·봇 검사), `fallback`(결정 모델 불가).
- 결제·권한·삭제·제출 요소는 후보에 들어가지 않는다. 비밀번호 역할 입력칸과 민감 라벨 입력칸도 제외.

## 4. 연결 지점 (다음 단계)

| 연결 | 위치 | 비고 |
|---|---|---|
| 턴 전 세팅 | `helper/codex-chat-runtime.mjs` `startTurn`, provider `prepare` 루프(≈1955행) 뒤·`extraContext` 병합(≈1965행) 앞 | 결과를 `context.extraContext.egdesk_decision_context`로. bounded 정책은 extraContext를 버리므로 건너뜀. AbortSignal이 없어 `requestId` 기준 AbortController를 직접 둠. `RUN_IN_PROGRESS` 검사(≈2130행) 전에 끝나야 함 |
| 활동 표시 | `ensureRun`(≈2175행) 뒤 `activity.completed`로 `decisionContextActivity` 행 emit | 기존 활동 기록 렌더링 재사용(`EGDeskChatState.sys.mjs` `reduceChatEvent`). 시점 칩은 새 렌더 필요 |
| 반사 도구 | 브라우저 도구 provider(`helper/codex-browser-tool-provider.mjs`)에 추가 도구로 노출, 각 단계는 `service.dispatch(run, { tool, arguments, callId })` | 기존 `BROWSER_TOOL_SPECS` 스키마는 thread manifest 해시에 들어가므로 수정하지 않고 뒤에 추가 |
| 키 경로 | `helper/codex-bridge-server.mjs` 핸들러 생성부(≈357~364행)·호출 순서(≈1025~1029행)에 `createDecisionHttpHandler` 추가, `openDecisionCredentialStore({ dataDir: <브리지 설정과 같은 디렉터리> })` | 키 파일은 `.egdesk` 내보내기 대상 저장소와 분리 |
| 설정 화면 | `overlay/resources/EGDeskAccountSettingsView.sys.mjs`에 '결정 모델 · OpenAI Decisions' 구역(엔진 카드와 분리) | 입력 후 즉시 비우고 힌트(…끝 4자)만 표시 |
| 후보 출처 | 대화: `openChatStore().listMessages`, Board: `openDeskStore().current()/searchBoards`, 온톨로지: `OntologyStore.readGraph()` → `candidatesFromOntologyGraph`, 선택 자료: 컨텍스트 capture manifest | 열린 Browser 카드 목록은 helper에 없음(overlay 보유) |

## 5. Owner 결정이 필요한 것

1. 외부 provider·키 추가와 외부 전송 범위(대화·자료 텍스트, 페이지 텍스트, 마스킹 스크린샷)의 Board·사이트별 허용.
2. 자동 실행 범위. 이 준비안은 같은 사이트 링크·스크롤·받은 값 입력까지. 제출·결제·권한·삭제는 사람.
3. 임계값 보정: 먼저 advisory 모드(판단만 기록, 실행은 추론 모델)로 로그를 모은 뒤 라벨로 정한다. 현재 값은 임시.
4. 로컬 월 토큰 상한 기본값.

## 6. 검증 상태

- 단위 시험 40건 통과(가짜 API·실제 파일 시스템). 실제 OpenAI 호출, 실제 Firefox·계정·외부 사이트 검증은 실행하지 않았다(NOT-RUN).
- 한국어 판정 정확도, 서울 왕복 지연, `gpt-6-luna`의 토큰 context 한도는 실측 필요.

## Board의 일회 질문은 일반 채팅과 다르다

Board 소유자가 활성 Agent 버전, 공개 발췌, 공개할 답변 작성 지침을 따로 지정한다. 상대는 Profile 파일이나 로그인 세션을 받지 않는다. 요청 파일은 질문 코드를 담을 때 반드시 암호화한다. 파일을 열면 내용을 볼 뿐 코드나 모델 사용량을 소모하지 않는다. 현재 Board에서 소유자가 공개 범위를 확인하고 실행해야 질문 코드를 소비한다. 초안은 파일에 자동으로 쓰거나 전송하지 않는다.

- **로컬 발췌**: 허용된 문장에서만 질문과 관련 있는 발췌를 고른다. 적절한 발췌가 없으면 빈 답으로 남긴다. 외부 호출은 기본값이 아니다.
- **외부 선별**: 소유자가 이번 요청에 별도로 동의하면 Decisions에 질문과 화면에 표시한 후보 발췌만 보낼 수 있다. 비공개 Agent 지침, 요청자 파일의 부가 설명, 실제 Board/사용자 ID는 보내지 않는다. `advisory`에서는 외부 판단이 로컬 선택을 바꾸지 않는다.
- **서술형 초안**: 요청마다 별도 승인한다. 전용 OpenAI Responses 경로에 질문, 선택된 발췌, 공개 작성 지침, 제한된 말투만 보낸다. 개인 대화·파일·도구·이전 응답은 연결하지 않는다. 조건에 맞는 발췌나 전용 설정이 없으면 일반 Chat이나 구독 계정으로 대체하지 않는다. 특정 엔진/계정에 연결된 Agent도 다른 비용 주체로 바꾸지 않는다.

초안 서비스는 기본 꺼짐이다. 운영자가 명시적으로 사용하기로 한 경우에만 `<앱 데이터 디렉터리>/settings/board-agent-draft-service.json`에 `version`(숫자 `1`), `provider`(`openai`), `apiKey`(별도 발급), `model`(허용된 정확한 모델 ID) 네 필드를 설정한다. 본 경로에서 허용한 모델은 `gpt-4.1-mini-2025-04-14`, `gpt-4.1-nano-2025-04-14`다. POSIX에서는 본인 소유의 `0700` 설정 폴더와 `0600` 파일을 사용한다. Windows에서는 같은 사용자와 시스템/관리자 외의 주체가 접근할 수 없도록 기존 보안 정책을 적용한다. 키는 환경변수·대화·Board·검토 파일에 넣지 않는다. 설정이 유효해 보인다는 표시는 실제 계정의 모델 사용권, 결제 주체 또는 연결 성공을 검증한 것이 아니다.

## 장부 행에서 원본까지: 일반 Agent DM의 선택 근거

`MemoryEvidenceStore`는 선택한 **장부 한 줄**을 같은 대화에서 캡처한 원본의 정확한 버전과 줄에 연결한다. `counted`는 ‘실사로 연결한 기록’이라는 뜻이지 시스템이 현물을 직접 보았다는 보증이 아니다. `posted`(처리 완료)와 `scheduled`(예정)는 다른 관계다. `copied`는 독립된 관측이 아니다. `present`는 질문의 현재 범위에 해당한다는 뜻이며 실측 여부와 독립적이다.

**신뢰된 로컬 호출자용 API.** `scope`는 실제 대상 계정·Agent·DM을 확인하고, 소유자가 해당 범위의 원본 재사용을 허용한 뒤 만드는 `{ownerKey, agentId, clientThreadId}`다. HTTP/body/문서 안의 필드에서 만들면 안 된다. 일반 Agent DM의 **기억 근거** 화면은 인증된 `/memory-evidence/` 관리 경로를 사용한다. 열린 파일 전체를 검색하거나 다른 대화의 캡처를 가져오지 않는다. `dataDir`는 앱 전용 디렉터리이고, `captures`는 기존 `ImmutableContextStore` 인스턴스다.

```js
const evidence = new MemoryEvidenceStore({ dataDir, captures })
const line = (capture, n) => ({ sourceId: capture.sourceId, revision: capture.revision, startLine: n, endLine: n })
const id = await evidence.bind(scope, {
  ledger: line(ledgerCapture, 4),
  sources: [{ relation: 'counted', ...line(stocktakeCapture, 12) },
            { relation: 'posted', ...line(dispatchCapture, 2) },
            { relation: 'coverage', ...line(movementWindowCapture, 1) }],
  discovery: { label: 'A창고 재고', terms: ['재고', '몇 개'] }, // 생략하면 자동 조회하지 않는다.
  expiresAt, // 생략하면 명시적으로 해제할 때까지. 날짜를 모른다는 뜻이 아니다.
})
// 기존 selectedSources에 { id, kind: 'memory-evidence', label: '장부 행' }로 명시 선택한다.
const trace = await evidence.read(scope, id) // 같은 권한으로 원본 줄·sourceId·revision을 확인. 불가하면 null.
evidence.revoke(scope, id)                  // 영속 철회. 다시 동의할 땐 별도 bind로 새 ID를 발행한다.
evidence.close()
```

선택은 권한이 아니다. `on`인 확인된 일반 DM에서만 원문을 늦게 로드한다. 판정 모델에는 일반 제목만 주고, 답변 모델에는 허용한 줄과 관계만 준다. 패킷이 잘리거나 원본이 없거나 철회됐다면 일부만 붙이지 않는다. 네이티브 턴에 넘기기 직전에도 권한을 검사한다. 파일명이 같은 새 캡처로 대체하지 않는다. Board나 과거 채널을 확인할 수 없는 대화에는 붙이지 않는다. 철회는 **향후 원본 읽기·새 전달**을 막는다. 이미 상대 엔진에 보낸 값이나 공개한 답변을 소급 지우지는 않는다. 기존 네이티브 대화의 히스토리는 이 원본 연결 권한과 별개다. 비공개 근거를 전달할 때 기존 DM의 네이티브 대화를 계정·Agent·로컬 대화에 영속 귀속한다. 다른 Agent·Board·검증되지 않은 세션 재개·분기로 같은 과거 입력을 상속하지 않는다. 이전 버전에서 이미 전달된 입력을 소급 봉인하지는 않는다.

**제품에서 사용하기.** 한 번 이상 답변을 주고받아 Agent와 계정이 확인된 일반 DM에서 자료를 먼저 캡처한다. ‘기억 근거’를 열고 장부 한 줄, 실사 등 원본 줄, 관계, 이름과 호출할 표현을 골라 동의한다. 컨텍스트 설정이 `on`일 때 다음 메시지부터 별도 선택 없이 조회한다. 동점이면 어느 장부도 선택하지 않고, ‘왜?’ 같은 짧은 후속 질문은 같은 대화에서 바로 앞에 공개된 답변의 실행 ID에 연결된 활성 원본만 사용한다. 후속 조회 기록은 입력을 보냈다는 표시이지 모델이 이를 읽거나 사용했다는 증명이 아니다. 모호한 수량만으로 출처를 찾지 않으며, 작업 노트나 전체 파일을 숨은 근거로 가져오지 않는다. 관리 화면에서 ‘직전 답에 전달된 근거’를 누르면 같은 이름이나 수량으로 찾아내지 않고, 그 실행에 실제 전달한 원본을 연다. 유일한 활성 연결이 없으면 버튼을 표시하지 않는다. 원본 보기와 철회는 채팅 발언을 만들지 않는다. 이전 버전의 수동 연결은 마이그레이션 후에도 자동 등록되지 않는다.

로컬 재현(프로젝트가 지원하는 Node 환경):

```sh
node --test apps/firefox-ui-demo/helper/egdesk-memory*.test.mjs
```

### 질문의 시각과 검증의 경계

“장부에 몇 개라고 적혀 있어?”는 해당 행으로 답할 수 있다. “지금 몇 개야?”는 실사 시각부터 질문 시각까지 **완료된 변동과 그 기록이 덮는 기간**도 봐야 한다. 예를 들어 9시 실사 30개, 이후 출고 완료 2개, 10시까지 다른 변동이 없다는 근거가 있으면 “지금 28개예요.”라고 답한다. 예정 출고는 빼지 않는다. 그 기간의 기록이 빠졌다면 마지막으로 확인된 값과 지금 값을 구분한다. 이유를 물었을 때만 계산 근거를 풀어서 설명한다.

호스트가 확인한 것은 **허용한 캡처 버전의 해당 줄이 일치한다는 것**이다. 답변 모델에는 실사 보고·장부 기재·추론·복사·예정을 구분해 전달한다. 캡처 시각을 실사 시각으로 대체하지 않는다. ‘과거지만 정확한 날짜는 모름’, ‘현재 유효하고 종료 기한은 정하지 않음’, ‘언제의 일인지 모름’도 서로 다르다. 이는 모델에 전달하는 해석 기준이지, 모든 발언을 자동 분류하거나 현물을 독립 검증한다는 뜻이 아니다.

새 격리 Firefox의 실제 DM과 Board 화면, 채팅 런타임·저장소에서 등록, 자동 조회, 직전 답에 전달된 원본, 철회와 브리지 재시작, Board 미전달을 확인했다. 이때 답변 공급자와 판정 모델은 합성이었다. 검증 대상은 **어느 원본이 누구에게 전달되는가**와 그 결과가 화면에 표시되는 경로다. 실제 모델이 항상 같은 수량을 계산하는지, 운영 자료가 실제 재고와 일치하는지는 이 검증으로 알 수 없다.

**이름:** `MemBrain`은 작업명이다. `Membrain`이라는 영업 CRM이 이미 있어 공개 제품명으로는 혼동 소지가 있다. 상표권은 조사하지 않았다.

## MemBrain에 파일과 기억 조각을 넣는 규약

**파일은 판단의 원본이고, 기억 조각은 다음 판단에 재사용할 주장·교훈 하나다.** 업로드, 의미 해석, 저장 허용, 사용 허용은 서로 다른 일이다. 아래 공통 규약은 설계 계약이다. 모든 단계를 제공하는 범용 HTTP/MCP 쓰기 도구가 이미 있다는 뜻이 아니다.

1. **원본 접수.** 파일은 허용된 파일/캡처의 `sourceId + revision + startLine/endLine`으로, 발언은 해당 대화에서 호스트가 실제 접수한 사용자 메시지나 완료된 Agent 최종 발언의 ID·이벤트 순번·원문 해시·문자 범위로 고정한다. 파일 경로·이름·검색어·다른 문서의 요약은 원본 ID가 아니다. 원본 없이 사람이 직접 알려준 것도 ‘그 사람이 그렇게 말했다’는 발언을 원본으로 삼을 수 있다. 출처 없는 주장을 관측 사실로 등록하지 않는다.
2. **조각 제안.** 사람 또는 허용된 Agent가 한 조각에 한 주장·결정·교훈과 근거 참조를 제안한다. 발언자와 그 발언에서 인용한 사람은 분리한다. 관측 **보고**, 전언, 기록, 계산·추론을 구분하고, 예정·조건·질문을 완료 사실과 구분한다. 혼합 문장을 믿을 만하게 나눌 수 없으면 해당 축을 미상으로 남긴다. 디지털 기록 확인은 현물 확인이 아니다.
3. **시점·권한 검사.** 접수·캡처 시각, 발언 시각, 사건·계획의 시점 또는 유효 기간은 별도 값이다. ‘금요일’은 원래 발언 시각·당시 시차와 연결하고, 정확한 시각이 없으면 만들지 않는다. 재사용 시 ‘현재’의 범위는 질문자가 정한다. 호스트가 계정·Agent·방·동의·원본 버전·범위를 확인한다. 모델은 분류할 수 있지만 자신의 쓰기/공유 권한을 발급하지 못한다.
4. **등록 또는 보류.** 제안된 범용 쓰기 계약에서는 `operationId + 대상 범위 + 입력 지문`이 같은 재시도는 기존 `fragmentId/revision` 영수증을 돌려준다. 같은 요청 ID에 다른 내용은 충돌이다. 허용되지 않은 원본은 거부한다. 사실 여부가 미확인이어도 발언을 전언으로 보존할 수 있다. 새로 확인되거나 정정된 내용은 별도 리비전/조각으로 추가하고 `supports`, `contradicts`, `supersedes` 또는 `refines`로 잇는다. 같은 원본의 복사본은 독립 근거로 세지 않는다. 접수 영수증은 저장 결과이지 내용이 참이라는 증명이 아니다.
5. **승격은 별개.** 같은 방의 최근 발언이 개인 장기 기억이나 Board 공개 기억이 되는 건 아니다. 경험에서 교훈을 뽑는다면 원래 사건에 대한 인용이 아니라 별도의 **추론**, 적용 조건·예외·근거 링크를 갖는 제안이다. 장기 보존이나 다른 수신자에게의 공유는 별도 허용을 받으며, 재사용 직전에도 권한을 다시 확인한다. 철회는 이후의 읽기·전달을 막지만 이미 보낸 답변을 지우지는 않는다.

**예시:** 회의록 7행에 “금요일 출고 예정”이 있으면 조각 A는 ‘예정’이다. 나중에 전표 2행에 출고 처리가 기록되면 B는 ‘처리 기록’이고 A의 계획과 연결된다. 전표를 인용한 메일을 또 넣어도 현물 관측이 하나 더 생기지 않는다. 약속이나 전표만으로 수취 완료까지 주장할 수 없다.

### 현재 제품에서 넣는 방법

- **파일:** 인증된 로컬 `POST /context/captures`로 원본 버전을 고정한다. 일반 Agent DM에서 `기억 근거`를 열어 장부 한 줄과 근거 1~6개의 줄·관계를 미리 확인하고 허용하면 `POST /memory-evidence/bind`가 `memrow:…`를 반환한다. `read`·`revoke`는 같은 권한을 요구한다. **현재의 `bind`는 호출마다 새 ID를 만들며 범용 중복방지 영수증이 아니다.** 임의 파일 업로드나 일반 텍스트를 장기 기억으로 승격하는 API도 아니다.
- **일반 대화:** 컨텍스트 설정이 `on`인 검증된 Agent DM에서 `기억 근거 → 이 DM의 다음 발언부터 허용`을 선택한다. `/memory-evidence/speech-enable`과 `/speech-disable`(같은 `/memory-evidence` 경로 아래)은 현재 Agent·방을 확인하고 동의를 열고 닫는다. 이전 대화는 소급하지 않는다. 파일 행의 동의로는 켜지지 않는다. 현재 메시지만 기존 판정 호출에서 문장별 의미를 제안받는다. 비공개 동의 저장소에는 원문 대신 로컬 메시지 ID·검증용 해시·발언 시각과 시차·해석 범위가 있는 최근 12개 참조만 유지한다. Agent 자신의 답변은 ‘이 Agent가 이렇게 말했다’일 뿐 독립 증인이 아니다.
- **다음 턴:** 선별 모델에는 과거 발언의 본문·발췌가 없는 목록만 준다. 이전 대화가 필요하다고 선택된 경우에만 실제 답변 Agent가 같은 DM의 원본과 확인된 인용 범위를 받는다. 이 발췌는 해당 기간에 일어난 모든 사건의 완전한 기록이 아니다. 작업 메모·가져온 대화·다른 Agent·Board는 대상이 아니다. 끈 뒤 다시 켜면 새 동의이며 예전 참조는 되살리지 않는다. 시스템이 확인하는 것은 발언 원문과 그 수신 범위이지 그 사람이 말한 사건의 진위가 아니다.
- **아직 설계:** 파일·발언을 임의의 의미 조각으로 **범용 등록**하는 API, 교훈 자동 승격, 공통 중복방지 영수증과 정정 관계 그래프. 위 필드는 제안 규격이지 현재 HTTP 요청에 임의로 넣어도 된다는 뜻이 아니다.

### 읽기/쓰기가 아니라 선택/생성이 모델의 경계다

- **호출:** 호스트가 허용된 근거 후보를 열거하고 판정 모델은 관련 후보, 시점, 응답 유형 또는 ‘해당 없음’을 고른다. 이미 있는 근거를 고르는 데 별도 생성 작업자는 필요 없다. 후보 목록이 비었는데 모델이 새로운 원본을 만들어낼 수는 없다. 새 자료 찾기나 최종 자연어 답변은 후보 선택과 다른 일이다.
- **입력:** 원본 캡처·버전 고정, 정형 행의 필드 매핑은 코드만으로도 된다. 원문에서 고정된 구간을 선택하고 `예정/관측 보고/추론` 등 등록 스키마의 항목을 고르는 작업은 입력이어도 객관식이다. 사용자가 완성된 조각과 근거를 제시했다면 생성 작업자를 거칠 이유도 없다. 보기가 모자라면 억지로 분류하지 않는다.
- **새 조각 제안(설계):** 원문에 그대로 있지 않은 명제·적용 조건·재사용할 교훈을 여러 자료에서 작성해야 할 때만 생성형 추론 작업자가 필요하다. 대화 응답을 늦추지 않도록 허용된 범위에서 비동기로 초안을 만들 수 있다. 백그라운드라는 것은 실행 시점이지 저장 권한이 아니다. 작업자는 근거 참조와 함께 제안할 뿐이며, 호스트만 최신 동의·원본 버전·범위 및 중복을 검사하고 저장/보류한다. Decision Model의 동의·높은 점수는 사실 증명이나 쓰기 권한이 아니다. 현재 제품에는 이 범용 백그라운드 작업자/큐가 없다.
