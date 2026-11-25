// The real answer and the real fill of Main's check-11 (schema-on conversation, Codex 0.171, briefing v2), kept as data: lane L4's c36 test and the c21 coverage plan (c37) both
// replay them. The answer begins with two sentences ABOUT the answer itself and ends with a table; the fill is what the engine wrote for the design the notes gave.
const TABLE = '| 날짜 | 진행 상황 | 커밋 ID | 테스트 |\n|---|---|---|---|\n| [11-20](/x/devlog/11-20.md) | 로그인 화면 병합 완료 | `a1b2c3d` | 120건 통과 |\n| [11-22](/x/devlog/11-22.md) | 결제 모듈 병합 완료. 알림 설정 화면은 시안만 확정 | `e4f5a6b` | 98건 통과 |\n| [11-24](/x/devlog/11-24.md) | 검색 화면 착수 | 기록 없음 | 기록 없음 |\n\n기록된 테스트 통과 건수의 합계는 **218건**입니다. 최신 기록 기준 남은 작업은 **알림 설정 구현, 검색 성능 점검, 배포 체크리스트 작성**입니다.\n'
const PREFIX = 'devlog 기록을 날짜순으로 정리했습니다. 파일은 변경하지 않았습니다.\n\n'
export const CHECK11_ANSWER = PREFIX + TABLE
// the whole fill the real engine wrote (check-11, schema-on, reply 0): a sequence card whose lines are all null (copied by code) and an open-items card it wrote itself
export const CHECK11_FILL = { title: '작업 진행 경과와 남은 일', items: { P1: { text: '작업 진행 흐름을 시간순으로 정리', slots: { title: '진행 경과', lines: [{ label: null, text: null, from: 'M1' }, { label: null, text: null, from: 'M2' }, { label: null, text: null, from: 'M3' }] } },
  P2: { text: '후속 작업으로 남은 항목을 정리', slots: { title: '남은 일', lines: [{ label: '구현', text: '알림 설정 구현', from: 'M3' }, { label: '점검', text: '검색 성능 점검', from: 'M3' }, { label: '작성', text: '배포 체크리스트 작성', from: 'M3' }] } } }, unfillable: [] }

// ---- Main's check-17b (the realistic script, 12 ledger entries, two topics): what the real engine wrote for the fill. It filled 2 of 6 rows of the first card and 1 of 6 of the second
// (schema on, reply 0), and in the rewrite round (reply 2 of the schema-off run) it reported the list "unfillable": all ids and figures of six materials do not fit 6 rows of 90 characters.
export const CHECK17B_WHOLE_FILL = { title: '통합 수정 검증과 대기·브라우저 안정성 측정', items: {
  P2: { text: '예열 조건별 응답 지연과 반복 실행의 일관성을 보여준다.', slots: { title: '대기 측정과 브라우저 안정성', lines: [{ label: null, text: 'C1(예열 10초 뒤)269ms·A2(예열 없음,10분 쉼)561ms. 브라우저 안정성 2회차=1회차: 모든 판정 값 동일.', from: 'M11' }] } },
  P1: { text: '통합 과정에서 발생한 충돌의 조치와 검증 결과를 보여준다.', slots: { title: '통합 수정 9aeed73', lines: [{ label: null, text: '9aeed73: L3 c3·Board 상한 100 충돌→시험 고정값만 상향(제품 동작 불변). 게이트 2256건: 통과2254·건너뜀2·실패0.', from: 'M1' }] } } }, unfillable: [] }
export const CHECK17B_UNFILLABLE = { title: '실호출 검증과 예열 측정', items: { P2: { text: '승인된 실호출부터 예열 측정까지의 검증 경과', slots: { title: '실호출·브라우저 안정성·예열 측정' } } },
  unfillable: [{ item: 'P2', slot: 'lines', reason: 'M3·M6·M8·M9·M11·M12의 모든 id·수치·날짜·이름·조건을 보존하려면 최대 6행, 행마다 label 24자·text 90자 제한을 초과합니다.' }] }
