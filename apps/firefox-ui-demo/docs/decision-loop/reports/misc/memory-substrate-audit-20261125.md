# 기억 기반(온톨로지·llm-wiki) 점검 — 2026-11-25 23:2x KST

질문(사용자): "온톨로지/llm-wiki 기능이 완벽한가? 시나리오 세팅 가능할 정도로?"
점검: code_explorer 서브에이전트(t1PcwAGCDHsa8fBN), int/c14 728a616 기준, 읽기 전용. 경로는 apps/firefox-ui-demo/ 기준.

## 결론
8개 장면(쿠스 1~6, 태화 7~8)을 그대로 깔 수 있을 만큼 완성되지 않음. 기억 쓰기는 전부 채팅(또는 채팅에서 시작한 브라우저 과제)에서만 시작. 일반 등록 API·백그라운드 작업자·정정 관리·승격은 설계 문서에만 있음(docs/DECISION_MODEL_CONTEXT_SETUP.md:230, ideas/confirmed/EGDESK_PRODUCT_VISION_AND_DEV_TODO.md:199, ideas/confirmed/EGDESK_INTERACTION_AND_ORCHESTRATION_CONTRACT.md:2103).

## 항목별
- A 저장: ontology.sqlite = 프로필당 1회 가져오기(재가져오기 ONTOLOGY_ALREADY_INITIALIZED, helper/egdesk-ontology-store.mjs:154-169, 284-300), 쓰기 API 없음. 실행 중 쓸 수 있는 기억은 egdesk-wiki-writes.json 하나(0600, pages/readings 각 200개·256KB 한도, helper/egdesk-wiki-adapter.mjs:102-135). 페이지 필드: id, title, body|ref, revision, time{slice,at}, provenance{kind,by,basis}, status(plan|done|unknown), scope, spokenAt, links≤16. workflow.sqlite는 작업·게이트 기록(기억 아님).
- B 분류: JEV 4-Type(asset/knowledge/log/hypothetical) 코드에 없음(미채택). 있는 것: time.slice(past/present/planned/hypothetical/unknown), provenance.kind(own_record/document/agent_note/utterance/reported_by_other), status(plan/done/superseded/reported_by_other/unknown) (helper/egdesk-wiki-reconstruction.mjs:17,25,28). 판독 pending→accepted는 사람 확인으로만(helper/egdesk-turn-memory.mjs:459).
- C 관계: 닫힌 집합 same_task, follows_from, decided_in, supersedes, refers_to (wiki-reconstruction.mjs:18-24). supersededBy()는 대체 페이지가 과거·현재+done일 때만(:97-99). 사본·백업 관계 없음. 같은 건 묶기는 읽기 시점 예/아니오(tw_link → same_task, turn-memory.mjs:331-337), 합치기·중복 제거 없음.
- D 범위: scope는 자유 문자열이지만 실제 값은 dm:<id>, board:<id>, null뿐(wiki-adapter.mjs:32,225). 현재 DM 외 범위 페이지는 스냅숏에서 버려짐(:243) → board:/personal/조직/가족 범위로 깔면 안 보임. personal은 시험 시드에만. 조직·가족·Agent 범위는 설계만(계약 문서 :2129).
- E 파일 참조: ref 페이지는 본문이 저장되지 않고(wiki-adapter.mjs:115) ref가 채팅 메시지일 때만 보임(:245). 파일 위치는 맥락 저장소의 수집 출처(rootId+relativePath)이고 파일 변경 시 stale 표시만(helper/egdesk-context-runtime.mjs:373-390). 경로 갱신 없음. Google Drive 연동 없음.
- F 시간: 페이지는 time.at 하나뿐, 마감·만료·놓침 없음. 열린 항목 6종(approval, question, browser_task, run, memory, proposal)에 마감 필드 없음, 레지스트리는 프로세스 메모리(helper/egdesk-open-items.mjs:13). expiresAt는 작업 그래프 게이트에만(최대 7일, helper/egdesk-task-graph.mjs:215). 정리·공고화 데몬 없음. 현재·계획 구분은 잘 됨(온톨로지 스냅숏 future/planned vs present/observed + continuesFrom, overlay/resources/ontology/graph.json; 패킷 머리말 "계획은 현재 사실 아님"). planned→done은 planTimelineTransition(helper/egdesk-context-setup.mjs:579) 제안만, 호출처 없음.
- G 쓰기 경로: 채팅만(helper/codex-chat-runtime.mjs:7579,8115, turnMemory 기본 off: helper/egdesk-bridge-settings.mjs:44, 발언 동의 필요, 본문은 본인 메시지 ≤2000자: turn-memory.mjs:382,430). 비채팅 작성자는 브라우저 과제 결과(agent_note, DM 범위 필요: helper/egdesk-browser-entry-wiring.mjs:36) 하나. 사건 버스: terminal.exit, file.changed, browser.navigated/loaded, auth.changed, user.action(helper/egdesk-event-bus.mjs:20-24) — 내용 없음(터미널 종료는 sessionId·exitCode만), file.changed는 연결된 파일 카드 루트만, "Board에 파일 추가" 사건 없음, 구독자는 게이트·출처 stale 훅뿐. HTTP: /ontology/* GET만(helper/egdesk-ontology-http.mjs:291), /memory-evidence/*는 DM·동의 종속, /v1/boards·/v1/desk/import는 Board 본문만. 시드는 프로세스 내 JS(openWikiWrites(...).apply, helper/egdesk-real-engine-delete.mjs:75) 또는 JSON 직접 작성.
- H 읽기 경로: prepareTurnMemory / wiki snapshot / reconstructMemory(helper/egdesk-turn-memory-wiring.mjs). 턴당 상한: 온톨로지 120쪽, 후보 40, 발언 12, 주제 24, 최근 쓴 것 100(wiki-adapter.mjs:17,260). Board는 머리글 한 덩어리만 후보(파일 아님, helper/egdesk-decision-candidates.mjs:70). 결정 모델 키 필요.
- I 시험: 실제 저장 시험 있음(ontology-store/http/migration, wiki-adapter, turn-memory-on/bridge). 재구성·작업기억은 합성. 실모델 증거는 helper/fixtures/memory-e2e-real-20261124.json 1건. 8개 장면·조직/가족 범위·마감·사본 관계·사건 쓰기를 다루는 시험 없음.

## 막히는 지점(중요도 순)
1. 사건 기반 기억 작성자 없음 + 사건에 내용 없음 → 4, 5, 6, Board·터미널 사건 전부.
2. 조직·가족(·Agent) 범위 모델 없음 → 3. DM 외 범위는 걸러짐(null만 전역 노출).
3. 마감·만료·놓침 상태 없음, 열린 항목 비영속 → 4의 열린 항목, 6.
4. 파일 경로 참조·이동 추적 없음 → 5, 2의 연결.
5. 사본·백업 관계, 같은 건 합치기 없음 → 2, 7.
6. 쓰기 제약: pending은 사람 확인 필요, 본문은 채팅 원문, 200쪽 한도에서 오래된 것부터 밀림 → 1의 "잊지 않음"과 충돌.
7. 페이지 가져오기 HTTP 없음, 온톨로지 재가져오기 불가(사용자 프로필 A는 10/27에 이미 가져옴: 개념 102·관계 383·스냅숏 2·원문 58).

## 재사용 가능
egdesk-wiki-writes.json 직접 시드(시간 구간·상태·출처·관계, 범위 null=전역) → 1번 수정본 대체 체인 가능. 새 프로필은 현재·미래 스냅숏 graph.json으로 시작 가능(8번에 가장 맞음, 단 프로필 A는 재가져오기 불가). time_intent 라우팅, "계획은 현재 아님" 규칙, supersededBy(), pending→확인/거절 흐름, 브라우저 과제 결과 페이지, 대화별 forgetters, 사건 버스·파일 감시(향후 작성자 기반), registerOpenItemProvider, 시드·측정 장치(real-engine-delete, memory-journey).

## 함께 확인된 사실(Main)
- 사용자 프로필 A 저장소(23:0x): 대화 4·메시지 8, Board 1, 작업 흐름·브리핑 비어 있음, 온톨로지 위와 같음, 위키 쓰기 파일 없음.
- 결정 모델 키: 23:16 설정 화면에서 저장(확인 161토큰), 브리지·EG-Desk 재시작 뒤에도 configured, 모드 '끔'.
- 비용: Decisions API gpt-6-luna 입력 $0.10/1M(출력 무료) → 사용자 상한 $200 = 입력 약 20억 토큰.
