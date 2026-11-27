# L6c a2: DuckDuckGo 첫 화면에서 결정 모델 루프의 fill이 not-editable로 두 번 거절된 문제

- 브랜치 `lane/a2-claude-fill`(기준 int/c14 `c277af7`), 작업 사본 `$L/wt-l6c-a2`, 커밋 **`db3f7a7`**. 새 화면 문구·플래그·도구 이름 없음.
- 실창(EG-Desk, Firefox, Marionette)은 건드리지 않음. 채팅 저장소는 임시 폴더 사본에서 시각·도구 이름·코드·닫힌 낱말만 읽고 사본은 지움.
- Main이 준 실제 관찰 파일 두 개(`keyboard-exp/ddg-home-real.json`, `ddg-observe-now.json`)는 재생 입력으로만 썼음. 출력·커밋하지 않았고, 시험 픽스처에도 옮기지 않았음(픽스처는 duckduckgo.com이 내준 공개 첫 화면 마크업으로 따로 만듦).

## 1. 원인

### 확인
1. **루프 후보 규칙이 검색 랜드마크 `<form role="search">`를 입력칸으로 읽었다.**
   - 첫 화면 마크업(19:3x에 받음): `<form id="searchbox_homepage" role="search" aria-label="DuckDuckGo로 웹 검색" action="/" method="GET">` 안에 진짜 칸 `<textarea name="q" role="combobox" aria-label="DuckDuckGo로 검색">`이 있음.
   - Firefox 자식은 `[role]`이 붙은 요소를 모두 후보로 관찰함(INTERACTIVE_SELECTOR). 그래서 폼이 role `search`, tag `form`으로 스냅숏에 실림.
   - 루프의 `FIELD_ROLES`(egdesk-browser-reflex.mjs 112행)에 `search`가 있음. 자식 `roleFor`가 `<input type="search">`에 붙이는 이름이라 넣은 것인데, 명시 role=search(ARIA 랜드마크)도 같은 낱말이라 폼이 입력칸이 됨.
   - Main의 실제 첫 화면 관찰(ddg-home-real.json)에 수정 전 규칙을 돌리면 입력칸이 둘: `[F1]` el_7 role=search tag=form, `[F2]` el_8 combobox textarea. 수정 후에는 `[F1]` el_8 하나.
   - 액터 `isFillableControl`은 form에 false → `[not-editable]`.
2. **19:27 기록과 맞음.**
   - 저장소: 10:27:32.760Z 관찰 → 33.123 fill 거절(STALE, target, not-editable) → 33.164 관찰 → 33.564 fill 거절(같은 낱말) → 작업 끝 → Claude가 card_read → card_type(fill 성공, dom-value-setter) → card_press(navigate).
   - calls.json(19:27:29 턴): 결정 호출 2건, 둘 다 입력 1502토큰(327ms, 392ms). 같은 페이지에 같은 질문이라 같은 답([F1] 폼)이 두 번 나옴. L6의 같은 문서 1회 재결정이 같은 요소를 다시 고른 이유.
   - Claude의 card_type이 통과한 이유: 페이지 도구 `isFieldElement`는 role textbox·searchbox·combobox·textarea 또는 tag input·textarea만 칸으로 침. 그래서 폼에는 칠 수 없고, Claude는 진짜 칸(textarea)에 침.
3. **Claude 경로와 Codex 경로의 fill 요청 길은 같다(코드).**
   - 두 엔진 모두 같은 페이지 도구 공급자의 작업 도구를 받음(Claude는 MCP 목록, Codex는 동적 도구). 그 뒤 길은 하나: Browser 공급자 `runDirectTask` → `runBrowserReflex`(textComboboxes on, valuesFirst) → `buildReflexCandidates` → 값 매핑 또는 단계 선택 → `reflexActionArgs`(관찰의 ref, expectedTargetOf) → 공급자 dispatch → 서비스 가드 → 카드 → 액터 assertGuard.
   - 엔진별로 다른 것은 callId 이름뿐. actor 'decision' 표시는 카드 기록용.
   - 루프와 Claude 자기 card_type의 차이는 **누가 대상을 고르느냐**: 루프는 결정 모델이 후보 규칙의 칸 중 하나를 고르고, Claude는 페이지 도구의 칸 규칙(폼 제외) 안에서 고름.
4. **17:18 Codex "성공"은 fill이 아니었다(저장소).**
   - 08:19:01Z 작업 도구 호출 안에 브라우저 동작은 관찰 1회뿐(fill·navigate 없음). 카드는 17:17 Claude 검색 뒤의 결과 페이지였음 → goal_met → done(원장의 "단계 수 1"과 같음).
   - 19:31 Codex 실패는 Main 말대로 input-authority(QA 스크립트). 경로 차이의 근거가 못 됨.

### 추정
- 17:16(ca85945) Claude 실패(staleBy target, targetBy 기록 전)도 같은 원인으로 보임. 그 빌드에서도 첫 화면의 칸은 폼과 textarea(u7 textComboboxes) 둘이었음. 다만 그때 카드가 첫 화면이었다는 직접 기록은 없음.

### 같은 흐름의 두 번째 막힘(Main 19:45 4번, 확인)
- 실제 첫 화면에는 같은 이름의 링크 둘("Mac용 DuckDuckGo 다운로드")이 있음. 그래서 c16 "같은 모양 요소 중 무엇" 질문이 다음 두 단계를 가로챔:
  - (a) 단계 1순위가 needs_free_text(0.43)인 입력 단계. `typing` 판정이 1순위가 칸 선택지일 때만 참이었기 때문.
  - (b) 입력한 뒤 1순위가 방금 친 글의 읽기 전용 GET 검색(0.74, 바 아래)인 단계. L8b의 typed_search 규칙은 'uncertain'만 보는데, 그 전에 c16이 user_context로 바꿈.
- 재생에서 두 경우 모두 needs_guidance(choice_needed: 다운로드 링크 둘)로 끝남.

## 2. 수정(`helper/egdesk-browser-reflex.mjs`, `helper/codex-browser-tool-provider.mjs`)
1. **원인 수정**(`elementKind`): role `search`는 tag가 `input`일 때만 입력칸. form·div의 검색 랜드마크는 칸도 컨트롤도 아님.
   - tag가 없는 스냅숏(옛 픽스처)은 예전처럼 읽음.
   - `<input type="search">`는 그대로 칸.
2. **안전장치**: fill이 `targetBy=not-editable`로 거절되면 그 요소(문서 + ref 키)를 이번 작업의 입력칸 후보에서 뺌. 그 뒤 L6 규칙대로 새 관찰에서 값의 자리를 다시 고름.
   - 값당 1회 재결정은 그대로. 또 거절되면 지금처럼 끝냄.
   - 다른 target 낱말(value 등)은 예전과 같음: 같은 칸을 다시 고를 수 있음.
   - 뺀 목록은 루프 state의 `notEditable`에 실림(있을 때만 키가 생김). 그래서 작업 도구의 다음 구간과 이어가기에서도 유지됨. 다른 문서에서는 다시 후보가 됨(자식의 ref는 문서마다 새로 매겨짐).
   - 공급자 `reflexStepError`가 `targetBy`도 오류에 실음. 이전에는 staleBy만 실렸음.
3. **입력 단계는 같은 모양 질문으로 바꾸지 않음**: needs_free_text가 1순위이고 페이지에 칸이 있으면 L8b의 칸 1순위 예외와 똑같이 uncertain으로 둠. 그 뒤 작업 도구가 칸 구조(undecidedField·soleField)로 진행.
   - 칸이 없는 페이지는 예전처럼 묻는다(시험 고정).
4. **입력한 글의 검색(typed_search)**: c16이 '같은 모양 질문'으로 바꾼 미결 단계에도 적용함.
   - 조건은 L8b와 같음: 이번 실행에서 친 글, 1순위가 증명된 GET 검색, 그 파라미터에 그 글이 그대로 있을 것.
   - 모델이 직접 needs_user_context를 고른 경우와 확정된 단계에는 적용하지 않음.
   - L8b 규칙을 넓힌 것이라 L8b·L8 검토가 필요함.
- 런타임, overlay, 액터, 페이지 도구는 건드리지 않음. 바뀐 파일은 helper 두 개와 시험 하나.

## 3. 시험: `helper/egdesk-browser-task-search-landmark.test.mjs`(새 파일, 6개)
- 재생은 실제 런타임·Claude 어댑터·MCP·Browser 공급자·페이지 도구·작업 도구(L8 `taskDecide`)에 L6 `cardSites: 'window'`를 씀.
  - 첫 화면 요소와 카드의 fill 거절은 **실제 Firefox 자식의 규칙**(roleFor, labelFor, isFillableControl, navigationFacts)을 첫 화면 폼 마크업의 가짜 DOM에 돌려서 만듦.
  - 결정 모델 대본은 실창처럼 값 매핑에서 첫 칸을 고르고, 단계에서는 Main 실측 순위(needs_free_text 0.43 / 첫 칸 0.35 / 둘째 칸 0.12), 입력 뒤 검색 0.74를 냄.
1. 랜드마크는 칸이 아니고 textarea가 유일한 칸. `<input type=search>`와 tag 없는 스냅숏은 여전히 칸, `<div role=search>`는 아님.
2. **Claude 경로 재생(19:27, values 줌)**: fill 1회(el_8, 거절 없음) → GET 검색(`?ia=web&origin=funnel_home_website&q=…`) → done. 값 매핑에 랜드마크가 한 번도 안 나옴. 같은 run에서 card_read도 동작.
3. 재생(values 없음, needs_free_text 1순위): 같은 모양 질문 없이 구간 1회 → fill 1회 → done.
4. 안전장치 재생: 칸 앞에 readonly input이 있는 페이지. 첫 fill 거절(not-editable) → 두 번째 매핑에 그 칸이 없음 → 진짜 칸에 1회 입력 → done. 기록에 staleBy target, targetBy not-editable.
5. 루프 단독: 뺀 칸이 state에 남음, 이어가기에서도 빠짐, 다른 문서에서는 다시 나옴. value 거절은 예전과 같음(같은 칸 재시도, 키 없음).
6. decideReflexStep: 칸이 있으면 uncertain, 칸이 없으면 예전처럼 다운로드 링크 둘을 묻는 user_context.
- **수정 전 코드로 같은 시험을 돌리면 6개 모두 실패하고 실창과 같은 결과가 남**(`evidence/l6c-a2/replay-before-fix.tap`):
  - 2번: `cannot / tool_failed / BROWSER_OBSERVATION_STALE`, fill 두 번 다 "DuckDuckGo로 웹 검색"(폼) ok:false.
  - 3번: needs_guidance(다운로드 링크 둘).
- 관련 시험 33개 파일(step-candidates, first-act, reflex, task-tool, entry, page-tools, codex-browser-reflex, stale-reason, claude-browser, live, decision): 296/296 통과.

## 4. 게이트
- `"$L/gate.sh" $L/wt-l6c-a2 l6ca2`(db3f7a7): **`files=545 rc=0 secs=167`**, `# tests 8351 # pass 8312 # fail 0 # cancelled 0 # skipped 38`. 새 시험 파일이 목록에 들어 있음(`evidence/l6c-a2/gate-run.txt`, `evidence/gate-l6ca2/full.tap`). 재실행이 필요한 실패는 없었음.

## 5. 남은 문제
1. **실제 첫 화면에서 입력 뒤 검색 버튼**: 빈 첫 화면 관찰에는 submit 버튼(`<button type=submit aria-label=검색>`)이 없음. 재생은 "글이 들어가면 버튼이 보인다"고 가정했음.
   - 19:27 Claude가 card_type 뒤 card_press로 이동한 기록으로 보면 버튼이 나타나는 것으로 보임(추정).
   - 안 나타나면 루프는 검색을 못 누르고 멈춤(Enter 경로 없음). 실창 1회로 확인 필요.
2. Google 실제 첫 화면도 `<form role="search">`라서 수정 전에는 폼이 칸 후보였을 것(추정, 실제 관찰 없음). 이번 수정으로 같이 빠짐. L8의 합성 구글 페이지에는 폼이 없어서 측정 바이트는 그대로.
3. typed_search를 c16 전환에도 적용한 것(2절 4)은 L8b 규칙의 확장임. 소유자 확인 필요.
4. 페이지 도구 card_read 구조 모드에서 랜드마크 폼 표시가 auto에서 approval(unproven)로 바뀜. 칸이 아니어서 card_type은 예전에도 거절(PAGE_NOT_A_FIELD)했고 누르기도 결과가 같음. 표시만 달라짐.
5. 범위 밖이라 안 고친 것:
   - 카드 navigate가 `<browser>` src와 같은 주소면 무시되는 버그(Main 말대로 다른 레인).
   - 19:31 input-authority.
   - 단계 줄에 거절된 fill이 '실패'로 남는 표시(L6 a1b 때부터 소유자 결정 사항).

## 6. Main 실창 확인 절차
1. int에 `lane/a2-claude-fill`(db3f7a7) 병합 후 브리지(헬퍼)만 다시 시작. helper .mjs만 바뀌었으므로 Firefox 재시작은 필요 없음.
2. DuckDuckGo 카드를 **실제 첫 화면**(주소에 q= 없음)으로 둠. src 버그가 있으니 주소창에서 확인.
3. 새 Claude DM: "덕덕고 카드에서 장화 신은 고양이 검색해줘".
   - 기대: egdesk_browser_task 한 번에 관찰 → fill 1회(성공) → 검색(navigate, form-result-observed) → done.
   - `browser.tool.failed`에 not-editable 없음. Claude가 card_type을 쓰지 않음. 작업 도구 시간 1~2초.
4. 같은 요청을 Codex DM에서 반복(첫 화면으로 되돌린 뒤). 기대는 같음.
5. 만약 not-editable이 다시 나오면, 같은 작업 안에서 두 번째 fill이 **다른 칸**으로 가서 성공해야 함(안전장치). 저장소의 두 fill 시각과 결과로 확인.
6. 입력 뒤 멈춘다면 남은 문제 1번(버튼 미표시)일 가능성이 큼. 그때 관찰의 버튼 유무를 봐 주면 됨.
