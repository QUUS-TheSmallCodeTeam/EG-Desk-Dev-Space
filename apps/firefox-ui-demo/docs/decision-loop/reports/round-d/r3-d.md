# R3-d 검토 보고 (브랜치 review/d-ui-analyzer, 끝 커밋 68b6c4c4)

## 확인한 것 (결함 없음)
- (a) 영구 저장 경로: displayValue는 live 프레임(SSE, 메모리)에만 있음. 작업 도구 sink는 displayValue를 떼고 넣고, 진입 닫힌 기록은 허용 목록 필드만 저장. 채팅 SQLite·로그로 가는 길 없음.
- (b) 값 자르기는 코드포인트 기준(39자+…). 비밀번호·OTP·카드 번호·인증 코드·Sensitive field·hidden·예전 관찰·실패는 ●●●.
- (c) 'Agent 작업 중': finally로 stop, 일시중지 시 정리, SSE 오류·재연결 시 revoke로 정리, 작업별 키라 겹침에서 서로 지우지 않음. 중첩 호출 없음.
- (d) 새 문구 없음(기존 'Agent 작업 중', 일시중지).
- (e) 분석기 parseRange 자정 경계 4경우 손으로 확인, ISO +09:00 정상, end는 횟수·시간에서 제외.

## 결함과 수정
1. 이름 없는 칸이 displayValueSafe만 있으면 값이 그대로 보임 → label이 비면 ●●●.
2. radio/checkbox 줄에 내부 상태어 'checked/unchecked'가 보임(소유자 결정은 대상 이름) → 대상 이름만 표시, 중복 target 제거.
3. 진입 닫힌 기록 허용 목록에 select가 없어 select 단계가 기록·집계에서 빠짐 → 'select' 추가.
시험: task-tool 시험 보강, entry-record 시험 신설.

## 시험·게이트
관련 8개 파일 전부 fail 0. 전체 게이트 R3-d-1: files=551 rc=0, 8446 중 pass 8407, fail 0, skipped 38.

## 남은 위험
- 사람이 직접 조작 중(hold)에 시작한 작업은 hold 해제 뒤에도 배지를 안 켬(안 남는 쪽 오류).
- 실창 확인은 Main 몫.
