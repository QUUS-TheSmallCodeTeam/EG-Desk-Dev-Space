// The real answer and the real fill of Main's check-11 (schema-on conversation, Codex 0.171, briefing v2), kept as data: lane L4's c36 test and the c21 coverage plan (c37) both
// replay them. The answer begins with two sentences ABOUT the answer itself and ends with a table; the fill is what the engine wrote for the design the notes gave.
const TABLE = '| 날짜 | 진행 상황 | 커밋 ID | 테스트 |\n|---|---|---|---|\n| [11-20](/x/devlog/11-20.md) | 로그인 화면 병합 완료 | `a1b2c3d` | 120건 통과 |\n| [11-22](/x/devlog/11-22.md) | 결제 모듈 병합 완료. 알림 설정 화면은 시안만 확정 | `e4f5a6b` | 98건 통과 |\n| [11-24](/x/devlog/11-24.md) | 검색 화면 착수 | 기록 없음 | 기록 없음 |\n\n기록된 테스트 통과 건수의 합계는 **218건**입니다. 최신 기록 기준 남은 작업은 **알림 설정 구현, 검색 성능 점검, 배포 체크리스트 작성**입니다.\n'
const PREFIX = 'devlog 기록을 날짜순으로 정리했습니다. 파일은 변경하지 않았습니다.\n\n'
export const CHECK11_ANSWER = PREFIX + TABLE
// the whole fill the real engine wrote (check-11, schema-on, reply 0): a sequence card whose lines are all null (copied by code) and an open-items card it wrote itself
export const CHECK11_FILL = { title: '작업 진행 경과와 남은 일', items: { P1: { text: '작업 진행 흐름을 시간순으로 정리', slots: { title: '진행 경과', lines: [{ label: null, text: null, from: 'M1' }, { label: null, text: null, from: 'M2' }, { label: null, text: null, from: 'M3' }] } },
  P2: { text: '후속 작업으로 남은 항목을 정리', slots: { title: '남은 일', lines: [{ label: '구현', text: '알림 설정 구현', from: 'M3' }, { label: '점검', text: '검색 성능 점검', from: 'M3' }, { label: '작성', text: '배포 체크리스트 작성', from: 'M3' }] } } }, unfillable: [] }
