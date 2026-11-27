# L3 c31 부록 — 모델이 쓰지 않은 사용자 노출 문구 감사 (소유자 결정 N1용)

방법: 채팅·대화 경로의 파일(헬퍼 6개, 오버레이 UI 10개)에서 한글 문자열 리터럴을 전수 추출(주석 제외)하고, **루프 시작 직전 커밋 `484ba331`(2026-11-23)** 의 같은 파일과 비교했다. 그 커밋에도 있던 문자열은 **기존 제품 UI**(루프 이전, 승인 기록 없음, 바꾸지 않음), 새로 생긴 것은 **루프에서 추가**(승인 대기)다. 승인 장부: 저장소에 승인된 문구 목록이 없고 `LEDGER.md`/`PHILOSOPHY.md`에는 승인 대기 문구만 있다. 소스의 "pending approval" 표식 5곳은 아래 표에 모두 있다. 전체 목록(3,380줄: 루프 추가 77 + 기존 3,303)은 `l3-c31-copy-audit-full.tsv`. 영어 오류 문구(`chatError` 등)와 모델에게 주는 영어 지시는 사람에게 보이지 않아 제외했다(화면은 코드별 한국어 문구로 바꿔 보여 준다 — 기존 UI).


## A. 채팅 말풍선·실행 기록 줄에 기본으로 보이는 문구 (루프에서 추가)

| # | 위치 | 문구 | 언제 보이나 | 상태 |
|-|-|-|-|-|
| 1 | `codex-chat-runtime.mjs:7459` | 기억 자료 ${pages.length}개 | activity row of a turn that was given memory pages (turn memory on): title "기억 자료 N개" | **승인 대기** (소스 표식) |
| 2 | `codex-chat-runtime.mjs:7479` | 기록 확정 1건 | activity row when the person's message confirmed (확정) or cancelled (취소) a noted record (confirmInConversation) | **승인 대기** (소스 표식) |
| 3 | `codex-chat-runtime.mjs:7479` | 기록 취소 1건 | activity row when the person's message confirmed (확정) or cancelled (취소) a noted record (confirmInConversation) | **승인 대기** (소스 표식) |
| 4 | `egdesk-conversation-flow.mjs:54` | 응답이 평소보다 오래 걸리고 있습니다. 더 기다리거나, 중지하고 다시 요청할 수 있습니다. | engine silent >= 20 s, kind stalled/explain_wait, the writing model failed within 6 s; once per run; posted as an Agent chat message | **승인 대기** (소스 표식) |
| 5 | `egdesk-working-memory-wiring.mjs:136` | 도구 결과 정리 · ${results}건 · ${lines.toLocaleString('en-US')}줄 생략${spilled ?  | activity row of an answer whose tool results the working-memory gate shortened | **승인 대기** (소스 표식) |
| 6 | `eg-desk-surface.uc.js:19399` | 접수 여부를 확인하지 못했습니다. 자동으로 다시 보내지 않습니다. | under a message whose acceptance the bridge could not confirm (network/timeout); not retried automatically | **승인 대기** |

소계 6개. 결정: 승인 / 고침 / 없앰.

## B. 숨겨진 기능 DM [보기 추천] (EGDESK_CHAT_CHOICE=on 일 때만; 소유자 결정 전까지 숨김, 브리지 607행)

| # | 위치 | 문구 | 언제 보이나 | 상태 |
|-|-|-|-|-|
| 1 | `EGDeskJointPresentation.sys.mjs:40` | OpenAI API 크레딧이 부족해 추천을 받지 못했습니다. OpenAI 결제 설정에서 크레딧을 확인해 주세요. | [보기 추천] 흐름: 질문·보기를 보냈을 때의 결과·오류·안내 | **승인 대기** |
| 2 | `EGDeskJointPresentation.sys.mjs:41` | OpenAI가 요청을 잠시 제한했습니다. 잠시 뒤 다시 시도할 수 있습니다. | [보기 추천] 흐름: 질문·보기를 보냈을 때의 결과·오류·안내 | **승인 대기** |
| 3 | `EGDeskJointPresentation.sys.mjs:42` | 제한 시간 안에 추천이 도착하지 않았습니다. 요청은 이미 보냈으므로 비용이 청구될 수 있고, 다시 시도하면 요청을 한 번 더 보냅니다. | [보기 추천] 흐름: 질문·보기를 보냈을 때의 결과·오류·안내 | **승인 대기** |
| 4 | `EGDeskJointPresentation.sys.mjs:43` | 제한 시간 안에 요청을 보내지 못해 아무것도 전송하지 않았습니다. 비용은 없습니다. 다시 시도할 수 있습니다. | [보기 추천] 흐름: 질문·보기를 보냈을 때의 결과·오류·안내 | **승인 대기** |
| 5 | `EGDeskJointPresentation.sys.mjs:44` | 이번 달 EG-Desk 결정 모델 사용 한도에 도달해 요청을 보내지 않았습니다. | [보기 추천] 흐름: 질문·보기를 보냈을 때의 결과·오류·안내 | **승인 대기** |
| 6 | `EGDeskJointPresentation.sys.mjs:45` | OpenAI의 지출·사용 한도에 도달해 추천을 받지 못했습니다. OpenAI에서 한도를 올리거나 다음 달 초기화 뒤에 쓸 수 있습니다. | [보기 추천] 흐름: 질문·보기를 보냈을 때의 결과·오류·안내 | **승인 대기** |
| 7 | `EGDeskJointPresentation.sys.mjs:46` | OpenAI가 저장한 API 키를 받아들이지 않았습니다. 설정에서 키를 확인해 주세요. | [보기 추천] 흐름: 질문·보기를 보냈을 때의 결과·오류·안내 | **승인 대기** |
| 8 | `EGDeskJointPresentation.sys.mjs:47` | OpenAI Decisions에 연결하지 못했습니다. 네트워크를 확인한 뒤 다시 시도할 수 있습니다. | [보기 추천] 흐름: 질문·보기를 보냈을 때의 결과·오류·안내 | **승인 대기** |
| 9 | `EGDeskJointPresentation.sys.mjs:48` | OpenAI 서버 오류로 추천을 받지 못했습니다. 잠시 뒤 다시 시도할 수 있습니다. | [보기 추천] 흐름: 질문·보기를 보냈을 때의 결과·오류·안내 | **승인 대기** |
| 10 | `EGDeskJointPresentation.sys.mjs:49` | 이 키로 결정 모델을 쓸 수 없습니다. 설정과 OpenAI 계정의 모델 접근 권한을 확인해 주세요. | [보기 추천] 흐름: 질문·보기를 보냈을 때의 결과·오류·안내 | **승인 대기** |
| 11 | `EGDeskJointPresentation.sys.mjs:50` | 결정 모델의 답이 보기와 맞지 않아 추천으로 쓰지 않았습니다. | [보기 추천] 흐름: 질문·보기를 보냈을 때의 결과·오류·안내 | **승인 대기** |
| 12 | `eg-desk-surface.uc.js:12983` | 아래 질문과 보기만 놓고 어느 쪽이 적절한지 비교해 주세요. EG-Desk 결정 모델은 추천을 내지 않았으니 그 판단을 가정하지 말고, 선택하거나 실행하지 마세요. | [보기 추천] 흐름: 질문·보기를 보냈을 때의 결과·오류·안내 | **승인 대기** |
| 13 | `eg-desk-surface.uc.js:12984` | , `질문: ${question}`, ...options.map((option, i) => `${i + 1}. ${option}`)].join( | [보기 추천] 흐름: 질문·보기를 보냈을 때의 결과·오류·안내 | **승인 대기** |
| 14 | `eg-desk-surface.uc.js:13004` | 설정의 계정 화면에서 OpenAI Decisions를 열 수 없습니다. 설정에서 직접 확인해 주세요. 채팅에는 API 키를 입력하지 마세요. | [보기 추천] 흐름: 질문·보기를 보냈을 때의 결과·오류·안내 | **승인 대기** |
| 15 | `eg-desk-surface.uc.js:13050` | 결정 모델이 추천을 내지 않았습니다. 질문이 모호하거나 맞는 보기가 없다고 판단했습니다. | [보기 추천] 흐름: 질문·보기를 보냈을 때의 결과·오류·안내 | **승인 대기** |
| 16 | `eg-desk-surface.uc.js:13051` | 결정 모델이 보기 사이에서 하나를 가려내지 못했습니다. 두 보기 이상이 비슷하게 맞다고 봤습니다. | [보기 추천] 흐름: 질문·보기를 보냈을 때의 결과·오류·안내 | **승인 대기** |
| 17 | `eg-desk-surface.uc.js:13052` | 결정 모델이 확신하지 못해 추천을 내지 않았습니다. | [보기 추천] 흐름: 질문·보기를 보냈을 때의 결과·오류·안내 | **승인 대기** |
| 18 | `eg-desk-surface.uc.js:13053` | 결정 모델의 답이 보기와 맞지 않아 추천으로 쓰지 않았습니다. | [보기 추천] 흐름: 질문·보기를 보냈을 때의 결과·오류·안내 | **승인 대기** |
| 19 | `eg-desk-surface.uc.js:13054` | OpenAI API 크레딧이 부족해 추천을 받지 못했습니다. OpenAI 결제 설정에서 크레딧을 확인해 주세요. | [보기 추천] 흐름: 질문·보기를 보냈을 때의 결과·오류·안내 | **승인 대기** |
| 20 | `eg-desk-surface.uc.js:13055` | OpenAI가 요청을 잠시 제한했습니다. 잠시 뒤 다시 시도할 수 있습니다. | [보기 추천] 흐름: 질문·보기를 보냈을 때의 결과·오류·안내 | **승인 대기** |
| 21 | `eg-desk-surface.uc.js:13056` | 제한 시간 안에 추천이 도착하지 않았습니다. 요청은 이미 보냈으므로 비용이 청구될 수 있고, 다시 시도하면 요청을 한 번 더 보냅니다. | [보기 추천] 흐름: 질문·보기를 보냈을 때의 결과·오류·안내 | **승인 대기** |
| 22 | `eg-desk-surface.uc.js:13057` | 제한 시간 안에 요청을 보내지 못해 아무것도 전송하지 않았습니다. 비용은 없습니다. 다시 시도할 수 있습니다. | [보기 추천] 흐름: 질문·보기를 보냈을 때의 결과·오류·안내 | **승인 대기** |
| 23 | `eg-desk-surface.uc.js:13058` | 이번 달 EG-Desk 결정 모델 사용 한도에 도달해 요청을 보내지 않았습니다. | [보기 추천] 흐름: 질문·보기를 보냈을 때의 결과·오류·안내 | **승인 대기** |
| 24 | `eg-desk-surface.uc.js:13059` | OpenAI의 지출·사용 한도에 도달해 추천을 받지 못했습니다. OpenAI에서 한도를 올리거나 다음 달 초기화 뒤에 쓸 수 있습니다. | [보기 추천] 흐름: 질문·보기를 보냈을 때의 결과·오류·안내 | **승인 대기** |
| 25 | `eg-desk-surface.uc.js:13060` | OpenAI가 저장한 API 키를 받아들이지 않았습니다. 설정에서 키를 확인해 주세요. | [보기 추천] 흐름: 질문·보기를 보냈을 때의 결과·오류·안내 | **승인 대기** |
| 26 | `eg-desk-surface.uc.js:13061` | 저장한 API 키가 없습니다. 설정에서 키를 저장해 주세요. | [보기 추천] 흐름: 질문·보기를 보냈을 때의 결과·오류·안내 | **승인 대기** |
| 27 | `eg-desk-surface.uc.js:13062` | OpenAI Decisions에 연결하지 못했습니다. 네트워크를 확인한 뒤 다시 시도할 수 있습니다. | [보기 추천] 흐름: 질문·보기를 보냈을 때의 결과·오류·안내 | **승인 대기** |
| 28 | `eg-desk-surface.uc.js:13063` | OpenAI 서버 오류로 추천을 받지 못했습니다. 잠시 뒤 다시 시도할 수 있습니다. | [보기 추천] 흐름: 질문·보기를 보냈을 때의 결과·오류·안내 | **승인 대기** |
| 29 | `eg-desk-surface.uc.js:13064` | 이 키로 결정 모델을 쓸 수 없습니다. 설정과 OpenAI 계정의 모델 접근 권한을 확인해 주세요. | [보기 추천] 흐름: 질문·보기를 보냈을 때의 결과·오류·안내 | **승인 대기** |
| 30 | `eg-desk-surface.uc.js:13301` | 저장한 API 키가 없습니다. | [보기 추천] 흐름: 질문·보기를 보냈을 때의 결과·오류·안내 | **승인 대기** |
| 31 | `eg-desk-surface.uc.js:13302` | 결정 모델이 꺼져 있습니다. | [보기 추천] 흐름: 질문·보기를 보냈을 때의 결과·오류·안내 | **승인 대기** |
| 32 | `eg-desk-surface.uc.js:13302` | 결정 모델이 ‘기록만’ 모드입니다. | [보기 추천] 흐름: 질문·보기를 보냈을 때의 결과·오류·안내 | **승인 대기** |
| 33 | `eg-desk-surface.uc.js:13303` | 계정 설정 열기 | [보기 추천] 흐름: 질문·보기를 보냈을 때의 결과·오류·안내 | **승인 대기** |
| 34 | `eg-desk-surface.uc.js:13312` |  설정에서 변경한 뒤 돌아와 질문과 보기를 다시 검토해 주세요. 작성 중인 메시지는 그대로입니다. | [보기 추천] 흐름: 질문·보기를 보냈을 때의 결과·오류·안내 | **승인 대기** |
| 35 | `eg-desk-surface.uc.js:13319` | [질문·보기 수정]으로 입력한 보기를 그대로 이어서 고칠 수 있습니다. Agent 대화로는 아무것도 보내지 않았고, 작성 중인 메시지도 그대로입니다. | [보기 추천] 흐름: 질문·보기를 보냈을 때의 결과·오류·안내 | **승인 대기** |
| 36 | `eg-desk-surface.uc.js:13320` | 같은 질문으로 다시 검토 | [보기 추천] 흐름: 질문·보기를 보냈을 때의 결과·오류·안내 | **승인 대기** |
| 37 | `eg-desk-surface.uc.js:13321` | 계정 설정 열기 | [보기 추천] 흐름: 질문·보기를 보냈을 때의 결과·오류·안내 | **승인 대기** |
| 38 | `eg-desk-surface.uc.js:13322` | Agent에게 물어보기 (초안 작성) | [보기 추천] 흐름: 질문·보기를 보냈을 때의 결과·오류·안내 | **승인 대기** |
| 39 | `eg-desk-surface.uc.js:13323` | 질문·보기 수정 | [보기 추천] 흐름: 질문·보기를 보냈을 때의 결과·오류·안내 | **승인 대기** |
| 40 | `eg-desk-surface.uc.js:13327` | 결정 모델 설정을 확인하지 못해 질문과 보기를 보내지 않았습니다. 작성 중인 메시지는 그대로입니다. | [보기 추천] 흐름: 질문·보기를 보냈을 때의 결과·오류·안내 | **승인 대기** |
| 41 | `eg-desk-surface.uc.js:13330` | 질문·보기 수정 | [보기 추천] 흐름: 질문·보기를 보냈을 때의 결과·오류·안내 | **승인 대기** |

소계 41개. 결정은 기능 자체의 결정에 따른다.

## C. 채팅 밖(Board·설정·브리핑)에서 루프가 추가한 문구

| # | 위치 | 문구 | 언제 보이나 | 상태 |
|-|-|-|-|-|
| 1 | `egdesk-context-setup.mjs:629` |  · 못 붙인 자료 ${dropped.length}개 | 컨텍스트 세팅 줄 | **승인 대기** |
| 2 | `EGDeskJointPresentation.sys.mjs:5` | 재배치 제안 | Board 배치 제안/적용 결과 | **승인 대기** |
| 3 | `EGDeskJointPresentation.sys.mjs:5` | 오래된 결과 접기 | Board 배치 제안/적용 결과 | **승인 대기** |
| 4 | `EGDeskJointPresentation.sys.mjs:371` | 제안은 현재 배치 유지입니다. 직접 고른 미리보기는 그대로 두었고, 아무것도 옮기지 않았습니다. | Board 배치 제안/적용 결과 | **승인 대기** |
| 5 | `EGDeskJointPresentation.sys.mjs:376` | 제안이 이미 고른 구성과 같습니다. 아직 적용하지 않았습니다. | Board 배치 제안/적용 결과 | **승인 대기** |
| 6 | `EGDeskJointPresentation.sys.mjs:420` | 화면이 바뀌어 적용하지 않았습니다. 아무것도 옮기지 않았습니다. | Board 배치 제안/적용 결과 | **승인 대기** |
| 7 | `EGDeskJointPresentation.sys.mjs:425` | 내 화면에 적용했습니다. 다시 열고 ‘마지막 적용 되돌리기’를 누르면 원래대로 돌아갑니다. | Board 배치 제안/적용 결과 | **승인 대기** |
| 8 | `EGDeskJointPresentation.sys.mjs:562` | 내 화면에 적용 | Board 배치 제안/적용 결과 | **승인 대기** |
| 9 | `EGDeskJointPresentation.sys.mjs:562` | 내 화면에 적용 | Board 배치 제안/적용 결과 | **승인 대기** |
| 10 | `EGDeskAccountSettingsView.sys.mjs:443` | 지출·사용 한도에 도달 · 키는 저장했습니다. OpenAI에서 한도를 올리거나 다음 달 초기화 뒤에 쓸 수 있습니다. | 설정의 키 확인·사용량 줄 | **승인 대기** |
| 11 | `EGDeskAccountSettingsView.sys.mjs:446` | OpenAI가 키 확인 질문에 통과시키지 않았습니다 | 설정의 키 확인·사용량 줄 | **승인 대기** |
| 12 | `EGDeskAccountSettingsView.sys.mjs:447` | OpenAI 서버 오류입니다. 잠시 뒤 다시 시도하세요 | 설정의 키 확인·사용량 줄 | **승인 대기** |
| 13 | `EGDeskAccountSettingsView.sys.mjs:448` | OpenAI의 답을 해석하지 못했습니다 | 설정의 키 확인·사용량 줄 | **승인 대기** |
| 14 | `EGDeskAccountSettingsView.sys.mjs:449` | 이번 달 로컬 사용 한도에 도달해 확인하지 못했습니다 | 설정의 키 확인·사용량 줄 | **승인 대기** |
| 15 | `EGDeskAccountSettingsView.sys.mjs:457` | 새 키에 크레딧이 없습니다 | 설정의 키 확인·사용량 줄 | **승인 대기** |
| 16 | `EGDeskAccountSettingsView.sys.mjs:458` | 새 키가 지출·사용 한도에 막혀 있습니다 | 설정의 키 확인·사용량 줄 | **승인 대기** |
| 17 | `EGDeskAccountSettingsView.sys.mjs:459` | 새 키가 요청 한도에 걸렸습니다 | 설정의 키 확인·사용량 줄 | **승인 대기** |
| 18 | `EGDeskAccountSettingsView.sys.mjs:495` | 이번 달 집계된 입력 ${budget.inputTokens.toLocaleString('en-US')} 토큰${budget.estimatedInputTokens > 0 ?  | 설정의 키 확인·사용량 줄 | **승인 대기** |
| 19 | `EGDeskAccountSettingsView.sys.mjs:495` | }${Number.isSafeInteger(budget.cap) ? ` / 상한 ${budget.cap.toLocaleString( | 설정의 키 확인·사용량 줄 | **승인 대기** |
| 20 | `EGDeskAccountSettingsView.sys.mjs:510` | ${/[.。]$/.test(base) ? ' ' : ' · '}모드가 ‘끔’이라 아직 쓰이지 않습니다. 아래에서 ‘사용’을 고르면 쓸 수 있습니다. | 설정의 키 확인·사용량 줄 | **승인 대기** |
| 21 | `EGDeskAccountSettingsView.sys.mjs:516` | ${why} · 새 키로 바꾸지 않았습니다. 지금 쓰는 키는 그대로입니다. 기존 키를 지운 뒤에는 이 키도 저장할 수 있습니다. | 설정의 키 확인·사용량 줄 | **승인 대기** |
| 22 | `EGDeskBoardAgentAsk.sys.mjs:203` | 실행 결과를 확인하지 못했습니다. 자동으로 다시 실행하지 않습니다. 이 질문 코드는 이미 사용되었을 수 있습니다. 직접 회신을 쓰거나 새 질문 코드를 받아 다시 시도해 주세요. | Board Agent 질문 화면 | **승인 대기** |
| 23 | `EGDeskBoardAgentAsk.sys.mjs:283` | 관련 항목을 고르는 데 OpenAI Decisions (${p.decisionModel})도 씁니다. 표시된 질문과 공개 발췌문 전부를 보내며, 계정 설정에 저장한 결정 모델 모드와 키를 그대로 따 | Board Agent 질문 화면 | **승인 대기** |
| 24 | `EGDeskReviewHandoff.sys.mjs:277` | ${answerSource} ‘기록만’ 모드라 별도 Decisions API 판단은 선택에 반영하지 않고 이 기기의 단어 일치로 골랐습니다. 질문과 공개 발췌문은 그 API로 전송되었습니다. | 질문·발췌 전송 안내 | **승인 대기** |
| 25 | `EGDeskReviewHandoff.sys.mjs:278` | ${answerSource} 별도 Decisions API 판단을 완료하지 못해 이 기기의 단어 일치로 골랐습니다. 질문과 공개 발췌문이 그 API로 전송되었을 수 있습니다. | 질문·발췌 전송 안내 | **승인 대기** |
| 26 | `EGDeskBriefingHost.sys.mjs:31` | , label: `메모 ${Number.isSafeInteger(c.memoSeq) ? c.memoSeq : out.length + 1}`, onBoard: true, maySend: true, r | 브리핑 자료 이름 | **승인 대기** |
| 27 | `egdesk-briefing-catalog.mjs:105` | pair: '선택한 두 장 나란히 비교' | 브리핑 카탈로그 이름 | **승인 대기** |
| 28 | `egdesk-briefing-catalog.mjs:108` | out.push({ id: c.id, ref: {}, kind: 'source', label: `메모  | 브리핑 카탈로그 이름 | **승인 대기** |
| 29 | `egdesk-briefing-catalog.mjs:109` | if (runFile && !verifiedRunOpens.delete(runFile)) throw new Error('확인된 실행 파일 요청이 필요합니다.'); | 브리핑 카탈로그 이름 | **승인 대기** |
| 30 | `eg-desk-surface.uc.js:4393` | 오래된 결과 카드를 접는 정리 제안이 있습니다. 책상 빠른 정리를 열면 미리 볼 수 있습니다. | Board 알림(정리 제안) | **승인 대기** (소스 표식) |

소계 30개. N1의 범위 밖이지만 같은 승인 대기.

## D. 기존 제품 UI (루프 이전, 문구 변경 없음) — 파일별 개수

| 파일 | 문자열 수 | 내용 |
|-|-|-|
| `eg-desk-surface.uc.js` | 2084 | 채팅 패널 전체(작성창·말풍선 메뉴·스레드 메뉴·작업 보드·Agent 목록·타임라인·승인 응답·첨부)와 Board·브리핑·터미널 등 화면 문구 |
| `EGDeskChatState.sys.mjs` | 579 | 채팅 상태: 계정 불일치 보류 문구(707-709), 자료 선택 이유·제외 문구(882-926), 자료 추천 오류(977-983), Claude/Smart Read 전송 거절 문구(989-1026), 실행 설정 줄(1124-1134), 연결 끊김(1312), 하위 Agent 상태, Agent 프로필·도구 제한 설정 폼(1667-1905~) |
| `EGDeskAccountSettingsView.sys.mjs` | 130 |  |
| `EGDeskHostActivityView.sys.mjs` | 105 | 실행 활동 행 라벨 |
| `EGDeskReviewHandoff.sys.mjs` | 91 |  |
| `EGDeskJointPresentation.sys.mjs` | 84 |  |
| `EGDeskBoardAgentAsk.sys.mjs` | 70 |  |
| `EGDeskChangeReview.mjs` | 60 | 변경 검토 화면 |
| `EGDeskRunResult.sys.mjs` | 46 | 실행 결과 카드 |
| `codex-chat-runtime.mjs` | 27 | 컴퓨터 조작 거절·중지 사유(511-521), 전송 확인 실패(623), 하위 Agent 승인(3814), 허락 질문 거절(4514/4520), 컨텍스트 세팅 행(5118-5119), 작업 메모·발언 여부 미확인(7958), 브라우저 직접 확인(8025-8026), 답변 미표시(8036-8037), 컴퓨터 조작 행(8245) |
| `EGDeskChatChangeReview.sys.mjs` | 18 | 채팅 변경 검토 |
| `egdesk-context-setup.mjs` | 9 |  |
