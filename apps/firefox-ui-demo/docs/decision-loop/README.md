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

- `ledger.md`: Main의 진행 기록 전문(재개 지점, 결정, 정정 포함)
- `results/round-b-results.md`: 라운드 b 최종 측정 요약표, `results/round-b-matrix.jsonl`: 원본 기록
- 실창 QA 도구: `../../scripts/real-window-qa/`

## 보관 브랜치 (GitHub `archive/decision-loop/…`)
병합하지 않은 시험·보류 작업을 원래 이름 앞에 `archive/decision-loop/`를 붙여 보관했다. 예전 사이클 브랜치 14개(`int/c14-l2c17-trial`, `int/c2-with-l3c4`, `keep/c26-first-try`, `lane/c11-browser-on-e2e`, `lane/c12-browser-rebased`, `lane/c15-evidence-v6`, `lane/c31-memory-fast-answer`, `lane/c34-note-switch`, `lane/c36-check-watchdog`, `lane/c36-wip-rc-parked-not-for-merge`, `lane/c4-mode-semantics`, `lane/c6-chat-surface`, `lane/c6-memory-gate-wiring`, `lane/c7-browser-history`)와 커밋하지 않았던 작업 2곳(`lane/a1-browser-task-wip`: L8이 맥락 한도로 끊기기 전 작업, `lane/a2-step-candidates-wip`: 붐비는 단계 나눠 묻기 제거 시도).

## 소유자 확인이 필요한 결정 (라운드 b)
- 사람이 지정한 폼 radio·checkbox·단일 select를 승인 없이 고르기(L19·L28)
- 사람이 이름을 댄 일반 버튼 1회 누르기(L21·L28)
- 다른 언어·표현이라도 같은 뜻이면 사람이 지정한 것으로 인정(`choice_requested`, Main 720b374)
