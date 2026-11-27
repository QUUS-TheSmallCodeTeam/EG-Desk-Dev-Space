# L1 c31b: 층(layer) 우선 감사 — 결정 모델이 대화 아래의 "정의된 층"을 먼저 확정하는 자리

브랜치 `lane/c31b-layer-audit` (base `int/c14` `6c4a861`). 코드 변경 없음. 읽기만 했고 아무것도 보내지 않았고 새 문구도 없다.
이전 R-D(기록 문장을 코드가 대신 게시)는 WIP로 `lane/c31-memory-fast-answer` (`753d0bd`, 기본 꺼짐, 병합 대상 아님)에 보관했다. 이유: 사용자 정정(11-25 17:3x) "이것들도 대화 layer쪽이고, decision model 은 그보다 아래인 memory, action 등 더 defined 된 걸 먼저 확인해줘야지".

## 0. 기준 (먼저 못 박는다)

층을 "대화 아래에서, 정의된(열거 가능한) 상태나 선택지를 가진 것"으로 본다. 한 결정이 이 층의 일인지는 아래 다섯 가지로 가른다.

1. **정의된 선택지가 있다**: 코드가 지금 이미 열거할 수 있거나 열거할 수 있어야 한다 (기록 목록, 상태 값, 대기 중 승인, 실행 중 run, 폴더의 명령 후보, 카드 목록).
2. **정답이 사람 말의 *해석*이다**: 대화체 문장을 만드는 일이 아니라 "이 말이 그 선택지 중 무엇을 가리키나"다 (R1: 실제 내용을 읽고 판단, R2: 예/아니오 또는 고정 선택지, R4: 질문 하나에 인용 하나).
3. **결과가 말 이전에 상태로 남는다** (기록 상태, 승인 결과, run 중단). 말은 그 위에 얹힌다.
4. **코드로 계산되는 것은 코드** (R3, R5): 권한, 위험 하한선, 링크로 계산되는 `superseded_by`, 시각 비교는 결정 모델에 묻지 않는다.
5. **주관식 모델(엔진)은 확정된 상태 위에서 말만 한다.** 확정이 불가능한 것(추론, 조합, 새 글쓰기)만 엔진 몫이다.

판정 단어: **D** = Decision 모델, **코드** = 정규식·규칙·등록부, **엔진** = 주관식 모델, **아무도** = 누구도 결정하지 않음(엔진 문장 속에 묻힘).

근거 두 가지를 분리해서 쓴다. (가) 코드 줄: `apps/firefox-ui-demo/helper/` 아래, int/c14 `6c4a861` 기준. (나) 오늘 실제 엔진 기록: `$L/evidence/main-real/real-engine/check-*/records/<set>/<id>.json` (Main이 돌린 것, 초와 도구 호출은 기록에서 그대로 읽음). 합성 시나리오이고 대화당 1~5턴이므로 "답 품질"은 이 자료로 말하지 못한다.

## 1. 오늘 한 턴이 지나가는 순서 (`codex-chat-runtime.mjs`)

| 순서 | 줄 | 누가 | 무엇 |
|---|---|---|---|
| 0 | 1825 `openEarlyQuestion` | 코드 | 열린 되묻기가 있으면 이 말은 그 run 안의 답 (등록부 조회, D 없음) |
| 1 | 2595 `beginTurnMemory`, 2597 `prepareDecisionContext` | D | 기억 분류(`tn_*`), 기록 고르기(`pg_*`, `op_*`), 상태 읽기(`st_P*`) / 자료 선택(`answer_type`, `rel_*`) |
| 2 | 2861 `awaitTurnMemory` | 코드 | 상한 안에 끝난 것만 쓴다 |
| 3 | 2943 `runBrowserEntryOn` | D (플래그) | 브라우저 일인지, 어느 카드인지 |
| 4 | 2978 `decisionFirstTry` | D (플래그 `EGDESK_DECISION_FIRST`, 자체 도구만) | "테스트 돌려줘" 한 종류: 폴더에서 명령 후보를 만들고 하나 고름 |
| 5 | 2981 `readGateHookReply` | D | 직전에 막힌 명령에 대한 사람 답 (`reply_runs_command`, `egdesk-gate-hook-broker.mjs:172`) |
| 6 | `engine.startTurn` | 엔진 | 나머지 전부 |
| 7 | 3094 `startConversationFlow`, 6024 `personPredicates` | 코드+D | 진행 중 말: 중단/상태/변경 |
| 8 | 8398 `startTurnMemoryWrite` | D | **답이 나간 뒤에야** 이 말을 기록할지 판단 (`judgeTurnWrite`, `egdesk-turn-memory.mjs:264`) |

발견 하나를 미리 적는다: 8번(기록 쓰기 판단)이 6번(엔진 답) **뒤**에 있다. 층 순서가 거꾸로다 (1.4절).

## 2. 기억 층

### 2.1 오늘의 결정 목록

| 결정 | 누가 | 근거 |
|---|---|---|
| 이 말이 인사/감사뿐인가, 새 자료가 필요한가, 회상 요청인가, 기록할 만한가 | D `tn_courtesy/need/recall/record` | `egdesk-turn-memory.mjs:103`, 건너뛰기 규칙은 코드 `:68` |
| 어떤 기록이 필요한가 | D `pg_*` (스캔), `op_*` (링크 옵션) | `egdesk-wiki-reconstruction.mjs:312, 378` |
| 기록의 상태 (done/plan/superseded/reported_by_other/unknown) | D `st_P*` (0.75/0.2 문턱) | `:376`, 읽기 `:388` |
| 기록 사이 링크 (`supersedes`, `follows_from`...) | 코드 (저장된 링크, 파생 `superseded_by`) | `:18`, `:47` |
| 시각 구분 (과거/현재/계획/가정), 권한 | 코드 | `allowsPage` `:121` |
| 이 말을 기록하나, 어느 기록에 붙이나, 상태는 | D `tw_target`, `tw_status` + 문장별 발화 라벨 | `egdesk-turn-memory.mjs:277-278`, `createWikiWriter :396` |
| 대기 중 기록을 사람이 확인/거절했나 | D `rc_stated_i`, `rc_confirms_i`, `rc_rejects_i` | `egdesk-record-confirmation.mjs:81` |
| 두 기록이 서로 모순인가 (링크 없는 경우) | **아무도** (엔진이 패킷에서 읽음) | 패킷 머리말 `:177`, `JUDGE_RULES :207` |
| "방금 그 내용" 같은 지시어가 무엇인가 | 부분 D (`tn_recall` + 직전 답 `previousReplyFor` :4623, 플래그) + 코드(직전 턴 기록) | |
| 기록된 상태를 말로 어떻게 전하나 | 엔진 (상태는 이미 D가 정함) | 패킷 머리말 |

### 2.2 이미 런타임이 만드는 정의된 선택지
기록 카탈로그 (`CATALOG_LIMIT 80`, 제목·상태·시각), 스캔 후보와 링크 옵션, 상태 5값 (`RECORD_STATUSES`), 기록 쓰기 후보 (최대 8, `writeCandidateOrder :246`), 대기 중 확인 목록(`noteEntries`), 직전 턴이 받은 기록 id (`turn.previous`).

### 2.3 엔진이 정의된 것을 결정하고 있는 곳 (시나리오와 오늘 기록)

**M1. 기록 확정보다 말이 먼저 (층 역전)** — `real-engine-memory-write-v3/own-confirm` (check-27mw): 사람 "아 그거 다음 주 화요일로 확정했어" (T2, 7.9 s) → 엔진이 먼저 "그럼 신제품 리뷰 회의는 다음 주 화요일로 확정됐군요."라고 *말하고*, 그 뒤 8398줄의 기록 판단이 돈다. 같은 방 T3 엔진 답 "기존 기록에는 아직 미정으로 남아 있고, 방금 말씀하신 '다음 주 화요일 확정'은 별도로 확인 대기 중이에요"는 엔진이 두 상태(기록=미정, 발화=확정)의 충돌을 문장 속에서 처리한 것이다. 기록 상태는 정의된 값(`plan` 대 사람이 말한 `done`)인데 답 시점에는 확정돼 있지 않다. `RECORDING_RULE`(`egdesk-turn-memory.mjs:189`)이 엔진에게 "답 뒤에 EG-Desk가 기록 여부를 정한다"고 말해 줄 뿐이고, 엔진이 쓴 "적어 둘게요"를 `rc_stated`가 *뒤에서 읽어* 확인한다 (D가 엔진의 문장을 사후 검증하는 거꾸로 된 구조).
**M2. 사람 확인 말 "응 맞아"** — 같은 기록 T4: 180 s 시간 초과, 답 없음 (`FAILED=posted,turnStatus`). 이 말은 `rc_confirms`(D)가 이미 읽을 수 있는 대기 기록 확인인데 (`confirmNotedRecords` `:7327`, 플래그 `EGDESK_TURN_MEMORY_CONFIRM`), 그 턴의 *답*은 여전히 엔진이 써야 해서 꼬리에 걸렸다. 상태 변경(기록 확정)과 말이 한 엔진 턴에 묶여 있다.
**M3. 지시어 "방금 그 내용 정리해줘"** — `real-engine-journey-memory-v2` T2 (check-20jm): 154 s (같은 대화 다른 턴은 9.8–16.5 s). 가리키는 것은 직전 답의 기록(`turn.previous`, 코드가 가진 정의된 집합)인데, 어느 기록인지를 D가 확정해서 엔진에 주는 단계는 없다 (`tn_recall` 하나뿐). 
**M4. 모순 판단** — 합성 기록 `quote/a-meeting`("팀장 말로는 11,900원, 확정 아님", provenance reported_by_other)와 `quote/a-v1`(12,800원): journey-memory T1 엔진 답은 이를 "v1 발송 완료, v2는 승인 후 발송 예정"으로 올바르게 나눴지만 (check-20jm), 이 판단은 엔진의 글 속에 있고 D가 "이 둘은 충돌한다"를 확정하지 않는다. 링크가 없는 모순은 계산되지도 않는다.
**M5. 단일 값 회상** — `memory-recall-v1` (check-2): 기록 고르기·상태는 D가 이미 했고 엔진은 문장만 쓴다 (9.97 s). 층 관점에서는 *이미 올바른 분업*이다. R-D가 줄이려던 것은 이 문장 쓰기라 대화 층 예시였다.

### 2.4 턴 시작 시 D가 먼저 확정할 것 (제안)

| 순서 | 확정할 것 | 정의된 선택지 | 오늘 | 갭 |
|---|---|---|---|---|
| M-a | 관련 기록 | 카탈로그 | 있음 | |
| M-b | 각 기록의 상태·시각 | 상태 5값 | 있음 (`st_P*`) | |
| M-c | **이 말이 기록 상태를 바꾸나**(새 사실/계획/정정/확인/거절)와 그 대상 | 후보 ≤8 + 대기 확인 목록 | 있음, 그러나 **답 뒤** (8398) | 답 앞으로 당기거나 최소한 병렬 시작해 결과를 `record_state`로 엔진에 전달 |
| M-d | **이 말과 기록의 충돌** (기록 "미정" 대 말 "확정") | (기록 문장, 말 문장) 쌍 | 없음 | 쌍마다 "충돌하나"(R4) |
| M-e | 지시어의 대상 | 직전 턴 기록 id 목록 | 부분 | 후보 목록을 D에게 주고 하나 고르기 |
| M-f | 기록만으로 답이 충분한가 (아니면 도구 필요) | 예/아니오 | `tn_need`가 가까움 | 엔진 도구 사용 여부 결정과 연결 안 됨 |

사람에게 보이는 새 요소나 문구는 없다. 전부 내부 상태다.

## 3. 행동 층

### 3.1 오늘의 결정 목록

| 결정 | 누가 | 근거 |
|---|---|---|
| 명령 위험 하한선 (되돌릴 수 없음, 원격 등) | 코드 (규칙) + D `terminal_risk` | `egdesk-terminal-command-gate.mjs:126 classify`, `:470` |
| 막힌 명령의 선택지 | 코드 `GATE_HOOK_OPTIONS = run/cancel/give_context` | `egdesk-gate-hook-broker.mjs:37, 146` |
| 사람 답이 그 명령의 승인/거절인가 | D `reply_runs_command`, `reply_declines_command` (단일 대기 `awaiting.get(conversationId)`, 한 번만) | `:172`, `awaitingReply :102` |
| 명령 결과가 건강한가 | D 조건 중재 `terminal_state` | `egdesk-terminal-judge.mjs:71` |
| "~돌려줘" 요청이 폴더의 어느 명령인가 | D `df_pick` (플래그, 고정 6형식) | `egdesk-decision-first-commands.mjs:19, 36` |
| 진행 중 말이 중단/상태/변경 중 무엇인가 | D `personPredicates` + 코드 `personDecision` | `codex-chat-runtime.mjs:6024, 6310` |
| 브라우저 단계, 목표 달성, 재개 | D `next_step`, `goal_met`, `task_resume` | `egdesk-browser-reflex.mjs:103, 157`, `egdesk-browser-task.mjs:289` |
| **어느 파일을 읽나/고치나** | **엔진** (`egdesk_read_file` 경로를 스스로 정함) | `egdesk-own-tools-wiring.mjs`, 아래 A2 |
| **어느 명령을 실행하나** (고정 6형식 밖) | **엔진** | 아래 A1 |
| **"응", "ㅇㅇ", "근데 ~는 빼고"가 가리키는 제안** | **엔진** (직전 자기 문장을 기억으로) | 아래 A4, A5 |
| 실행할 단계 부분집합 | **엔진** | 아래 A4 |

### 3.2 이미 런타임이 만드는 정의된 선택지
`run/cancel/give_context`, 폴더에서 만든 명령 후보(최대 8, `SAFE_SCRIPTS` 9개 이름), 대기 승인 하나 (`awaiting`), 열린 되묻기 하나 (`openEarlyQuestion`), 중단·상태·변경 3종, 브라우저 카드/열린 페이지 목록 (진입 판단의 카드 질문), `enumerateOptions` (아래 7절).

### 3.3 시나리오 (오늘 기록)

**A1. "테스트 돌려줘"** — `real-engine-decision-first-v1` (check-27df): 엔진 길 24.3 s, 도구 `pwd`, `rg --files -g AGENTS.md ...`, `read package.json`, `npm test` (4회, 정의된 정보: `package.json` scripts). 결정 우선 길 3.0 s, 엔진 턴 0. 실패 시 11 s (결과를 컨텍스트로 엔진에 1회). 오늘 *한 종류*(명령 6형식)만 층 우선이고, 같은 요청이 6형식 밖이면 엔진 몫이다.
**A2. "quotes 폴더의 A사 견적서 v2에서 납기만"** — `real-engine-collab-two-runs-v1` T1 (check-26tr): 15.8 s, 엔진이 `rg --files quotes` → `egdesk_list_context` → `find quotes -type f | wc -l` → `read quotes/a-v2.md` 순서로 *어느 파일인지를 찾았다*. 파일 이름 목록은 코드가 폴더에서 만들 수 있는 정의된 집합이다. 이 층(파일 후보 → D가 고름 → 코드가 읽음)은 오늘 **존재하지 않는다**. `collectDecisionCandidates` (`egdesk-decision-candidates.mjs:84`)의 후보는 채팅 메시지, 카드, 온톨로지 항목이고 폴더 파일이 아니다.
**A3. 되돌릴 수 없는 명령** — `approval-words-v1` (check-27aw): "git push --force origin main" 엔진이 명령을 호출 (11.4 s) → 코드 게이트가 막고 → 엔진이 질문 문장을 씀. "그냥 해" → D가 승인으로 읽음(`reply_runs_command`) 하지만 실행과 결과 설명은 다시 엔진 8.5 s. "아니 잠깐" 3.3 s. 선택지(run/cancel/give_context)는 코드, 읽기는 D인데, 질문 문장 쓰기·재호출·결과 설명이 엔진이라 사람이 보기에는 2~3번 "왱~"이다.
**A4. 조건부 승인** — `conditional-yes-v1` (check-6): T1 엔진이 `notes/steps.md`를 읽고 단계를 나열하며 되물음 (10.9 s). T2 "응 근데 테스트는 빼고" → 엔진이 단계 1·3만 `printf` 두 번으로 실행 (8.8 s). 대기 중 제안의 *단계 목록*과 사람 말의 "빼고"는 정의된 구조인데, 등록부가 없어 엔진 기억에만 있다.
**A5. 단순 승인** — `terse-yes-v1` (check-2b): "ㅇㅇ" → 엔진이 직전 제안(완료 항목 삭제)을 `egdesk_edit_file`로 실행 (11.1 s). 같은 문제: "대기 중 제안"이라는 상태가 코드에 없다. (기억 층의 `COURTESY_WITH_PREVIOUS`, `egdesk-turn-memory.mjs:98`은 '응'이 단순 인사인지만 가른다.)
**A6. 진행 중 말 (잘 된 예)** — `pause-v1`, `stopped-fact-v1` (check-14w, 14s): "아니 잠깐, 그거 하지 마"는 코드+D가 중단을 정하고 (`personPredicates`), "방금 하던 거 어떻게 됐어?"는 코드가 가진 사실로 2.8~2.9 s에 답한다. 층 우선의 모범이다.
**A7. 브라우저** — `browser-loop-v2` (check-26bl): "다음 연금 수령일 언제야?" 9.5 s, "회의실 대관 신청해줘" 16.0 s는 약관 동의 단계에서 *정해진 대로* 멈춤 (`confirm_needed`), 다만 기록 검사 `note_candidates`가 실패 (L8 영역). 진입 판단·단계는 D 플래그 경로 (`runBrowserEntryOn :2943`).
**A8. 방금 한 일의 지시어** — `delete-v1` (check-18d) T2 "둘째 줄은?" (6.5 s): 엔진이 직전에 읽은 `notes.txt`를 가리킨다고 해석해 `offset:2`로 다시 읽음. "마지막으로 다룬 파일/명령"은 코드가 도구 호출 기록에서 계산할 수 있는 정의된 값인데 사용되지 않는다.

### 3.4 턴 시작 시 D가 먼저 확정할 것 (제안)

| 순서 | 확정할 것 | 정의된 선택지 | 오늘 | 갭 |
|---|---|---|---|---|
| A-a | **이 말이 가리키는 열린 항목** | {대기 승인, 열린 되묻기, 진행 중 run, 멈춘 브라우저 과제, 직전 제안, 없음} | 코드가 항목별로 따로 (0번, 5번, 7번 줄), 직전 제안은 없음 | 한 질문(선택) 앞단으로 통합, 직전 제안 등록부 추가 |
| A-b | 요청 종류 | {명령 실행, 파일 읽기, 파일 변경, 브라우저, 질문} | 명령 실행 한 종류만 (플래그) | 나머지 선택지 |
| A-c | 명령 실행의 대상 | 폴더 명령 후보 | 6형식 | 후보 확장은 승인 필요 (아래 8절) |
| A-d | 파일 읽기의 대상 | 폴더 파일 이름 목록 | **없음** | 새 데이터 종류 (승인 필요) |
| A-e | 대기 제안의 수락/거절/부분 수락 | 제안의 단계 목록 | **없음** (엔진 기억) | 단계별 D 질문 (R4) |
| A-f | 지시어("둘째 줄", "그거") | 최근 도구 대상 | 없음 | 코드 계산 후보 + D 선택 |

## 4. 보드/캔버스 층

| 결정 | 누가 | 근거 |
|---|---|---|
| 일의 자리(캔버스 위치) | 코드 규칙, D는 내용 술어만 (`owner_action`, "같은 일인가") | `egdesk-work-placement.mjs:11` |
| 데스크 HUD 입력이 어시스턴트 요청인가 | D `assistant_request` | `egdesk-hud-routing.mjs:56` |
| 브리핑의 배치, 이해 가능성, 위치 | D `placement`, `understandable`, `where` | `egdesk-briefing-flow.mjs:77, 12, 249` |
| 어느 카드를 열거나 닫나 | **엔진** (`egdesk_browser_open_card` 도구) | `egdesk-browser-tool-runtime.mjs:96` |
| 브리핑 내용의 구조(카드 문구, 순서) | **엔진**이 쓰고 D가 사후 검사 | |

오늘 기록: `briefing-realistic-v1` (check-25br): 62 s / 143 s, `factsInCards`, `inOrder` 실패. 구조를 엔진이 쓰고 D가 뒤에서 검사하는 구조의 결과로 읽힌다 (원인 확정은 이 자료로 못 함). 층 우선이라면: 정의된 후보(런 결과의 사실, 카드 목록)를 코드가 먼저 만들고 D가 어느 사실이 어느 카드인지를 고른다. 이 층은 L4가 다루므로 여기서는 *자리*만 적는다.

## 5. 협업/요청자 층

요청자·프레즌스는 코드 등록부(브리지)가 정하고, D는 `owner_action` 하나 (`egdesk-work-placement.mjs:11`), 엔진은 신원을 모른다 (`real-engine-collab-v1`, `collab-two-runs-v1` 통과: check-17c, 26tr). 이미 층 우선이다. 갭: 승인 원장과 요청자 등록부가 메모리에만 있어 재시작 뒤 질문을 다시 한다 (c29 기록). 새 결정 모델 자리는 없다.

## 6. 일정/하트비트 층

`enumerateOptions` (`egdesk-conversation-flow.mjs:247`)가 코드로 선택지 `none/pointer/ask_missing/...`를 만들고, D가 종류를 고르고 (`deriveFlowKind :539`), 엔진이 한 문장을 쓴다. 고정 문구는 정지 때만 (`FLOW_COPY :53`). **"코드가 선택지를 만들고, D가 고르고, 엔진은 말만"의 원형이 이미 여기 있다.** 오늘 기록: `journey-nudges-v3` (check-21nj). 사람 말을 일정으로 등록하는 층은 코드에서 찾지 못했다 (`ls helper | grep sched|remind|cron|timer` 결과 없음, `확인 안 됨`: 앱 밖의 예약 기능과의 연결).

## 7. 층 간 공통 관찰

1. **원형이 이미 있다**: 하트비트(코드 선택지 → D → 엔진 말), 게이트(코드 선택지 → D 읽기), 결정 우선 명령(코드 후보 → D → 코드 실행). 새로 만들 것은 *종류*를 늘리는 일이지 구조가 아니다.
2. **빠진 자리는 "대기 상태 등록부"다**: 대기 승인은 있고, 대기 제안(A4, A5), 기록 확인 대기(M2), 최근 도구 대상(A8)은 엔진 기억에만 있다. 사람의 짧은 말("응", "그거", "~빼고")이 전부 여기서 엔진으로 샌다.
3. **순서 역전 하나**: 기록 쓰기 판단이 엔진 답 뒤 (M1).
4. **꼬리는 엔진 턴에서**: 180 s (M2), 154 s (M3), 58 s (git-conflict, check-25g) 모두 엔진 턴이었다. D 호출 시간은 0.3~0.5 s 단위로 안정적이다.

## 8. 제안 순서와 승인 필요

| 우선 | 항목 | 이유 |
|---|---|---|
| 1 | 턴 시작 **열린 항목 해소기** A-a (대기 승인, 되묻기, run, 브라우저 과제, 직전 제안 중 선택) | 기준 1·2·3. 이미 4개의 대기 상태가 흩어져 있고, 지시어 말이 전부 여기서 새다. |
| 2 | **기록 상태 변경 판단을 답 앞으로** M-c, 충돌 쌍 M-d | 기준 3. 층 역전. |
| 3 | 대기 제안 등록부 + 단계별 수락 질문 A-e | A4, A5 |
| 4 | 파일 후보 → D → 코드 읽기 A-d | A2. **새 데이터 종류** |
| 5 | 명령 후보 확대 A-c | A1 |

**승인 필요** (새 데이터나 새 사람 문구):
- A-d는 폴더 파일 이름(그리고 필요하면 앞부분)을 Decision 모델에 보내는 **새 송출 종류**다. 지금의 송출 종류표 (`egdesk-decision-egress.mjs`: terminal/browser/canvas/run/memory/speech/topic/board/thread)에 없다. 정책은 사용자 결정.
- A-c 확대: 지금은 고정 6형식 (`npm test`, `npm run <name>`, `node --test`, `git status`, `git diff --stat`, `git log`). 늘리는 형식은 하나하나 위험 하한선과 함께 승인.
- 사람에게 보이는 문구는 이 감사의 어느 항목에도 새로 넣지 않았다. 해소기가 "없음"이면 엔진이 그대로 말한다. 대기 제안을 사람에게 보여 주는 표시(예: 번호 매긴 단계)를 둘 경우만 새 요소다.

## 9. 못 한 것, 확인 안 됨

- 코드 줄은 int/c14 `6c4a861` 기준이고 L7의 `lane/c37-prefetch`(미병합)가 기억 층 앞부분을 바꿀 수 있다.
- M1의 "답 뒤에 쓴다"는 코드(8398)와 `RECORDING_RULE`로 읽은 것이다. 같은 턴에 병렬로 돌릴 수 있는지의 시간 여유(0.3~0.5 s)는 `check-27mw`의 `decisionCalls`와 턴 시간으로만 어림했다.
- A4, A5는 합성 시나리오 1건씩이다. 제안 단계 추출을 코드로 할 수 있는지(엔진 문장 형식에 의존)는 확인하지 않았다.
- 보드/캔버스 층의 원인 판단 (브리핑 실패)은 L4 자료 없이 단정하지 않았다.
