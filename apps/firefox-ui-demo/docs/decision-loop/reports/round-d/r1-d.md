# R1 d: 병합·검토 (브랜치 review/d-authority)

## 충돌 해소 (int/d 병합, fc8ef5ac)
- codex-chat-runtime preRun: requestId 유지 + `if (this.store) preRun.entrySteps = {...}` 추가(L34·L36 둘 다).
- reflex choice_requested: L31 조건(`!lists.includes(o)`) + L34 문구(사람 요청 goal 인용) 합침. 상세 줄 660의 목록 처리와 짝이 맞음.
- step-candidates.test: L31의 순번 result_ 술어 흐름을 채택하고 L34의 choice_requested 응답 줄도 유지. L31 신규 시험(순번 오분류, select 인용)은 그대로.
- task-tool.test: L36의 pageText 기본 켜짐에 맞춰 pageText:false 고정 사례에 L34 messageOf를 같이 달고, 마지막 사례는 receipt.searchedFor 검증 유지.
- 병합 후 L36 시험 1건("thrown tool call releases the same card")이 L34 권한 도입으로 근거 없는 goal 'x'를 거절해 실패 → messageOf를 달아 의도(예외 시 카드 해제) 그대로 검증. 시험을 약화하지 않음.

## 검토 결과 (결함 없음, 코드 수정 없음)
(a) 권한은 conversationAuthority(run, 사람 원문)만 만듦(harness 소유). 도구 인자·페이지·모델 응답에서 만들 길 없음. 도구 goal은 원문과 다르면 사람 말을 인용한 술어(0.95)로 확인, 실패·불확실·scope 없음이면 needs_guidance(choice_needed)로 대화에 돌려보냄. 이후 행동 술어는 goal이 아니라 사람 원문을 인용.
(b) POST: 동일 출처·비민감·hidden 없음·허용 URL·분류기 통과 폼만 후보, 제출은 별도 술어 후 dispatch 전에 messageId를 spentPost에 넣어 메시지당 1회(재시도·다른 작업 포함). 'Submit order' 예외는 httpbin 고정 URL뿐.
(c) 외부 링크: 사람 요청 술어가 yes일 때만 Symbol 증거(JSON 불가)가 request_site에 붙고, runtime이 observation id·revision·ref·href·outside-site를 검증, 아니면 기존 질문. 모델이 고른 이동은 증거 없음 → 질문 유지.
(d) 로그인·인증코드·결제·봇 확인 경로 변경 없음(비밀번호 폼은 POST 후보에서 제외).
(e) 근거 칸은 { layer:'conversation', messageId, quote }, layer가 conversation이 아니면 거부(agent 자리는 있되 미허용).
(f) QA 15(/post 응답 custname), 9·18(person 허용 제거), 16 그대로: 맞음.

## 시험·게이트
- 단독: step-candidates 25/25, task-tool 20/20, reflex 33/33.
- 전체 게이트 R1-d-1: 551파일, 179초, rc=0, tests 8450, pass 8411, fail 0, cancelled 0, skipped 38. flake 없음.

## 남은 위험
- spentPost는 helper 프로세스 메모리(재시작 시 초기화), 한 메시지 500자 초과는 권한 없음(보수적).
- 사이트 허용은 conversationRequested 시 대화 스레드 사이트 집합에 추가(기존 수명과 동일). 실창 검증(QA 9·15·18)은 Main 몫.
- 페이지 지시 공격은 합성 표본 검증뿐, 실창 공격시험 아님.
