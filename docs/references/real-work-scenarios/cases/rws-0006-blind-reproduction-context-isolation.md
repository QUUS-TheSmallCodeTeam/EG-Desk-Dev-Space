<a id="rws-0006"></a>
# RWS-0006 — 결과 일치와 업무지식 재현을 구분한 blind context isolation

- **record_status**: `ACTIVE`
- **evidence_state**: `MIXED / SEE CLAIMS`
- **as_of**: `2026-08-25`
- **business_owner**: 총무회계·급여 업무
- **source_owner**: 급여 원천자료·ERP 역사적 화면·해당 Codex thread
- **action_authority**: 실제 급여·ERP·이체·신고는 업무 소유자, Worker는 격리 작업본만 소유

## 요약

급여 workflow를 다른 Agent가 독립적으로 재현할 수 있는지 시험하면서 최종 숫자를 보지
않는 context isolation을 사용했다. 첫 Worker는 일부 최종값을 맞췄지만 보험 계보, 수식과
기간별 예외를 놓쳤다. 보강한 실행도 한 직원의 역사적 예외가 빠져 일반규칙 fallback을
잘못 적용했다. 성공 판정을 철회하고 `예외 근거가 없으면 일반규칙으로 대체하지 말고
확인 필요로 정지`하는 규칙을 추가한 뒤 표적 회귀를 다시 수행했다.

## SourceRef

| SourceRef | source kind | access_class | permission-safe locator | as-of | 지원 claim | resolution |
|---|---|---|---|---|---|---|
| `RWS-0006-SR-01` | Codex user thread | `LOCAL-RESTRICTED` | `01a02d74-cd22-7b01-9067-b5e470e220af`; turn IDs `01a02d75-48d6-73d2-b57d-9b8d70b6e63b`, `01a02e94-e66c-7610-b75a-ec242e6e9af9`, `01a02ef2-1216-75e0-9499-0e2f19e41bcd`, `01a036f1-8f62-72f1-8399-f2a54a1f44ef`, `01a036f5-bae2-73b2-8f64-b0eab2732215`, `01a0370b-afa2-7f53-af51-c81d683ba5ee`, `01a037e9-ad37-7cd0-8457-7ad4a64a486b` | 2026-08 | `RWS-0006-C01`–`RWS-0006-C06` | `RESOLVED` |

### Claims

- [VERIFIED-AS-OF] `RWS-0006-C01`: 최종 숫자가 일치해도 업무 규칙·원천 계보·예외 처리 재현에 실패할 수 있다.
- [INFERRED] `RWS-0006-C02`: context isolation은 정답·완성본이 Worker에게 새지 않을 때만 blind test가 된다.
- [INFERRED] `RWS-0006-C03`: 원천자료가 없거나 예외가 불명확하면 일반규칙 fallback보다
  `확인 필요`가 올바른 결과일 수 있다.
- [PROPOSED] `RWS-0006-C04`: 같은 업무의 재현 시험은 immutable input snapshot과 실행별 lineage를
  가져야 한다.
- [PROPOSED] `RWS-0006-C05`: 실제 ERP readback은 Worker 사전계산 뒤 별도 critic evidence로 사용해야 한다.
- [PROPOSED] `RWS-0006-C06`: role-playing 사용자의 모의 답변은 기록된 사실만 제공할 수 있고 실제
  업무 소유자의 새 판단을 만들어서는 안 된다.

## 실제 업무 흐름

1. 실제 급여 처리 방향이 로컬 선계산인지 ERP 선계산인지부터 화면과 공식 파일로 확인했다.
2. `로컬 조정 → ERP 계산·마감 → 결과 내보내기 → 회사 정본·이체표`의 왕복 구조를
   관찰했다.
3. Worker에게 최종 ERP 결과를 숨기고 당시 이용 가능했던 원천과 업무지식만 전달했다.
4. 첫 재현은 일부 최종 숫자를 맞췄지만 원천 계보와 수식·개인정보가 섞인 과거 시트를
   안전하게 설명하지 못했다.
5. 더 구조화한 입력으로 두 번째 재현을 수행했지만 일부 원천이 독립 검증되지 않아
   조건부 성공으로 남겼다.
6. prospective test에서 기간별 예외가 누락되자 Worker가 일반규칙을 적용해 잘못된 결과를
   만들었다.
7. “결과값 일치” 성공 판정을 철회하고 “업무지식 재현 실패”로 재분류했다.
8. 예외가 필요한 기간인데 근거가 없으면 자동 fallback하지 않고 사용자 확인을 요청하도록
   규칙을 수정했다.
9. ERP 결과를 보기 전 input snapshot을 고정하고 새 blind run을 수행했다.
10. 표적 회귀는 통과했지만 다른 기간·원천을 포함한 전체 재현은 조건부로 남겼다.

## 결정·실패·교정

- 최종 파일의 숫자 비교만으로 workflow 학습 성공을 선언하지 않았다.
- 정답을 맞춘 이유가 올바른 규칙인지 우연한 fallback인지 검사했다.
- 개인정보가 섞인 과거 workbook을 통째로 Worker context에 넣지 않았다.
- 같은 worker에게 수정된 규칙을 주고 재시도할 때도 새 attempt와 snapshot을 만들었다.
- 실제 업무 owner만 새로운 예외와 지급·신고 결정을 승인할 수 있도록 유지했다.

## 증거 경계

| 주장 | 당시 증거 | 이 사례가 주장하지 않는 것 |
|---|---|---|
| ERP workflow 구조 | 공식 UI·파일·내보내기 관찰 | 현재 ERP 화면·정책이 동일함 |
| blind Worker 결과 | child input/output와 frozen snapshot | 독립 전문가의 법적·회계 승인 |
| 표적 회귀 통과 | 수정 규칙으로 특정 기간 재현 | 모든 직원·모든 월의 완전 재현 |
| 결과값 일치 | 산출물 비교 | 업무지식·원천 계보의 정확성 |
| context isolation | 정답·일부 원천 비공개와 별도 child | 민감정보가 전혀 전달되지 않았다는 보편 증명 |

## Browser tool-call fracture

| 흐름 | 단절 | fault layer | EG-Desk 개선 |
|---|---|---|---|
| ERP menu 탐색 → popup → 기간 입력 → 표 readback | 중복·숨은 input과 popup locator가 작은 DOM 호출로 분절 | site DOM·renderer | `erp.payroll.read(period)` semantic adapter와 조회조건·행수·합계 receipt |
| report → 도움창 → 전체선택 → export | icon·confirm no-match와 script syntax 오류 뒤 다른 경로 사용 | wrapper·site UI | atomic report-export와 파일·조건·hash 묶음 |
| 사원명부 virtual grid → screenshot·좌표 scroll | 행·열이 DOM에 충분히 노출되지 않아 completeness 불명 | virtualized renderer | schema-aware table extractor와 page/row completeness check |

## EG-Desk 목표 시나리오

```text
급여 Board
  -> 실제 업무 owner가 대상 기간·원천·권한 확정
  -> System이 최소화한 immutable input snapshot 생성
  -> Worker: ERP 정답 없이 사전계산·근거·확인 필요 반환
  -> integration 기능: completeness·PII·lineage 검사
  -> 실제 ERP readback
  -> independent Critic: 숫자뿐 아니라 규칙·원천·예외 비교
  -> 불일치 disposition
  -> 실제 사용자 판단
  -> 정본 후보
  -> 외부 이체·신고·마감은 별도 승인과 receipt
```

supervision projection 후보는 Worker별 입력 snapshot, 공개되지 않은 정보 범주, 출력 근거,
fallback 사용, `unknown/needs-human`, ERP 비교 시점과 attempt lineage를 보여준다.

## Multi-agent technique opportunity

| 항목 | 판단 |
|---|---|
| 관찰된 문제 | 기존 결과를 아는 Main이 업무지식 재현을 스스로 평가하면 정답 누설·확증편향 위험 |
| 실제 기법 | context-isolated Worker, manager-worker, role simulation, 반복 attempt, Main verification |
| 적용 trigger | 업무 규칙을 다른 사람·Agent·PC가 독립 재현해야 하고 정답 산출물이 이미 존재할 때 |
| 기대 효과 | 숨은 예외·암묵지·원천 누락과 기억 의존 발견 |
| 비용·위험 | 자료 재요청, 큰 token·latency, 개인정보 복제, manager의 정답 누설, 가짜 사용자 응답 |
| acceptance evidence | frozen input hash, 정답 비공개, source coverage, unknown 정지, prospective case, ERP 후행 비교 |
| 증거 상태 | 실제 사용됐고 표적 회귀는 통과했으나 전체 재현은 조건부 |

Role simulation은 Worker가 필요한 자료를 요청하는 handoff를 시험하는 데 유효했지만,
관리자가 실제 사용자처럼 새 숫자나 사실을 만들어 응답하면 blind test가 무효가 된다.
단순 월 1건 계산이나 원천이 불완전한 상태에서 Worker 수를 늘리면 같은 누락을 병렬로
증폭하므로 비추천이다.

## Candidate product implications

- Agent Run에는 input snapshot, 공개·비공개 범주, source coverage와 정답 접근 여부가 필요하다.
- acceptance는 결과값, 업무규칙, 원천 계보, 예외·unknown 처리의 네 축으로 나눠야 한다.
- 일반규칙 fallback은 예외 부재가 검증된 경우에만 허용한다.
- blind run과 ERP readback을 시간·권한상 분리해야 한다.
- child attempt마다 parent verification과 remaining risk를 기록한다.
- 민감 업무의 context isolation은 개인정보 최소화와 함께 설계해야 한다.

## 정본 연결 후보

- [Atlas AI-06](../../../../ideas/confirmed/EGDESK_PRODUCT_INTERACTION_TRACE_ATLAS.md#atlas-ai-06)
- [Contract §9 dependency orchestration](../../../../ideas/confirmed/EGDESK_INTERACTION_AND_ORCHESTRATION_CONTRACT.md#tech-dependency-orchestration)
- [Contract §11 parallel Agents](../../../../ideas/confirmed/EGDESK_INTERACTION_AND_ORCHESTRATION_CONTRACT.md#tech-parallel-agents)
- [HUM-ORCH-001](../../../codex/egdesk-product-interaction-trace-atlas-editorial-ledger.md#hum-orch-001)

## 열린 질문

- input snapshot에서 개인정보와 업무상 필요한 식별성을 어떻게 함께 최소화하는가?
- Worker가 `unknown`으로 멈춰야 할 trigger를 일반화할 수 있는가?
- 정답·ERP 결과가 child context에 유출되지 않았음을 어떻게 감사하는가?
- 표적 회귀를 전체 업무 acceptance로 승격할 최소 case coverage는 무엇인가?
- 실제 업무 owner의 새로운 예외 판단을 어느 UI에서 기록·버전 관리하는가?

## Privacy

직원명, 급여·보험·계좌·세금 값, workbook 경로, ERP 화면과 child raw output은 복제하지
않았다. Worker에게는 업무에 필요한 최소 field와 익명화된 식별자만 전달하고, 외부 write와
공식 정본 수정 권한을 부여하지 않는다.
