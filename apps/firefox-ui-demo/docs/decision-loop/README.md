# 결정 모델 교대 루프 개발 기록 (decision-loop)

결정 모델(OpenAI Decisions, gpt-6-luna)이 브라우저 카드의 단계를 고르고, 대화 모델(Claude·Codex)은 값·판단·답이 필요할 때만 나서는 교대 구조의 개발 기록이다. 작업은 세션 작업 저장소의 통합 브랜치 `int/c14`에서 했고, 2026-11-27 이 저장소 `claude/vision-gap-20261024`에 병합했다(병합 커밋 `52875b5`, `int/c14` 끝 `9da038f`). 병합 결과 전체 게이트: 550파일, 8434개 중 8395 통과, 실패 0.

## 흐름
| 묶음 | 폴더 | 내용 |
|---|---|---|
| c 사이클(c1~c49) | `reports/c-cycles/` | 결정 모델 질문·루프·진입·기록의 기초 사이클 |
| '위' 라운드(u1~) | `reports/round-u/` | 2026-11-26 새벽~오전 라운드 |
| 라운드 a '교대' | `reports/round-a/` | 2026-11-26 16:00~20:51. 진입(alternate)·작업 도구 egdesk_browser_task·단계 줄, 실창 교대(S1·S3·S4) |
| 라운드 b '브라우저 조작 케이스' | `reports/round-b/`, `results/` | 2026-11-26 21:05~11-27 00:05. 케이스 20개(입력·선택·이동·읽기·안전·흐름), 레인 L16~L30 |
| 기타 | `reports/misc/` | 감사·결정·초안 문서 |
| 라운드 d '결정 모델 우선' | `reports/round-d/`, `results/round-d-*` | 2026-11-27 22:4x~11-28 03:00. 대화가 권한(대화 ← 행동 층), 본문 전송·브라우저 턴 판단, 단계 줄 실제 값·카드 'Agent 작업 중', Desk 기록 1MB 한도 수정, EG-Desk 창만 녹화(ScreenCaptureKit), Gemini 결정 제공자, 성능 측정 |

- `ledger.md`: Main의 진행 기록 전문(재개 지점, 결정, 정정 포함)
- `results/round-b-results.md`: 라운드 b 최종 측정 요약표, `results/round-b-matrix.jsonl`: 원본 기록
- 실창 QA 도구: `../../scripts/real-window-qa/`

## 보관 브랜치 (GitHub `archive/decision-loop/…`)
병합하지 않은 시험·보류 작업을 원래 이름 앞에 `archive/decision-loop/`를 붙여 보관했다. 예전 사이클 브랜치 14개(`int/c14-l2c17-trial`, `int/c2-with-l3c4`, `keep/c26-first-try`, `lane/c11-browser-on-e2e`, `lane/c12-browser-rebased`, `lane/c15-evidence-v6`, `lane/c31-memory-fast-answer`, `lane/c34-note-switch`, `lane/c36-check-watchdog`, `lane/c36-wip-rc-parked-not-for-merge`, `lane/c4-mode-semantics`, `lane/c6-chat-surface`, `lane/c6-memory-gate-wiring`, `lane/c7-browser-history`)와 커밋하지 않았던 작업 2곳(`lane/a1-browser-task-wip`: L8이 맥락 한도로 끊기기 전 작업, `lane/a2-step-candidates-wip`: 붐비는 단계 나눠 묻기 제거 시도).

## 소유자 확인이 필요한 결정 (라운드 b)
- 사람이 지정한 폼 radio·checkbox·단일 select를 승인 없이 고르기(L19·L28)
- 사람이 이름을 댄 일반 버튼 1회 누르기(L21·L28)
- 다른 언어·표현이라도 같은 뜻이면 사람이 지정한 것으로 인정(`choice_requested`, Main 720b374)

## 라운드 d 소유자 결정 (2026-11-27)
- 라운드 b 넓힘 3개 진행. 가드레일 '대화가 권한': 사람이 이번 대화에서 시킨 건 쓰기 제출·다른 사이트 열기까지 묻지 않고 실행, 사람 몫은 비밀번호·인증 코드·로그인과 결제.
- 프롬프트 주입은 별도 규칙이 아니라 층 분리로 막는다(사회 ← 인격 ← 행동 + 생각, 브라우저는 대화 ← 행동). 행동 층의 목표·권한은 사람의 말에서만, 페이지 글은 자료.
- 페이지 본문을 결정 모델에 보낸다(U3·U9), 브라우저 대화에도 턴 판단을 켠다. 단계 줄은 칸 이름 대신 실제 값(P9·U8), 민감 칸은 가림. 사람이 페이지를 누르는 걸 감지하는 대신 카드에 'Agent 작업 중' 표시.
- 라이선스 MPL-2.0. 하위 에이전트 모델은 Sonnet(라운드 a·b·d 레인의 Astra 사용은 Main 임의 결정이었음).
- 새 요청: 화면 녹화(EG-Desk 창만), 완료한 브라우저 단계를 저장·재사용·개선하는 절차 기억(설계 제안 `../BROWSER_TASK_PROCEDURE_MEMORY.md`), 성능 최적화, Gemini 결정 모델 키.
