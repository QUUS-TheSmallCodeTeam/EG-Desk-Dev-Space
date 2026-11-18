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
