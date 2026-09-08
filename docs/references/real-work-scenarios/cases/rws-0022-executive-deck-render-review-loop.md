<a id="rws-0022"></a>
# RWS-0022 — 업무 발표자료의 렌더·사용자 교정 루프

- **record_status**: `ACTIVE`
- **evidence_state**: `MIXED / SEE CLAIMS`
- **as_of**: `2026-07`
- **business_owner**: Taehwatrans 경영 커뮤니케이션
- **source_owner**: 발표자료 작성·렌더·리뷰 기록
- **action_authority**: reviewer Agent는 QA만 수행하고 사용자·경영진 승인권은 없음

## 요약

발표자료가 독립 reviewer의 PASS를 받았지만 사용자가 서사 비약·레이아웃·시각 오독을
계속 발견했다. 파일 생성·렌더·수정·구조검사는 확인됐지만 최종 사용자 수용, 실제 사용된
revision과 경영진 채택은 알 수 없다.

## SourceRef

| SourceRef | source kind | access_class | permission-safe locator | as-of | 지원 claim | resolution |
|---|---|---|---|---|---|---|
| `RWS-0022-SR-01` | Codex user thread | `LOCAL-RESTRICTED` | `019f5e15-3cdc-7fe2-b6bc-155c58cb6fce`, turns 3–62 | 2026-07 | `RWS-0022-C01`–`RWS-0022-C06` | `RESOLVED` |
| `RWS-0022-SR-02` | Codex user thread | `LOCAL-RESTRICTED` | `019f6839-0208-75d0-be92-b318ad556c32`, turns 1–11 | 2026-07 | `RWS-0022-C02`–`RWS-0022-C05` | `RESOLVED` |

### Claims

- [VERIFIED-AS-OF] `RWS-0022-C01`: 업무 발표자료 파일이 생성되고 여러 차례 렌더됐다.
- [OBSERVED] `RWS-0022-C02`: 내부 reviewer PASS 뒤에도 사용자가 서사·레이아웃·시각 오독을 발견했다.
- [VERIFIED-AS-OF] `RWS-0022-C03`: 한글·화살표·layout 결함이 수정되고 구조검사가 반복됐다.
- [INFERRED] `RWS-0022-C04`: 파일 생성과 reviewer PASS만으로 실제 청중 수용을 증명할 수 없다.
- [OBSERVED] `RWS-0022-C05`: 사용자는 미팅이 있었다고 말했지만 해당 deck의 사용·승인을 증명하지는 않는다.
- [UNKNOWN] `RWS-0022-C06`: 최종 수용, 실제 사용 revision, 배포·경영진 채택은 확인되지 않았다.

## 실제 업무 흐름

1. 청중·목적에 맞는 발표자료를 작성했다.
2. 렌더와 독립 reviewer 검사를 수행했다.
3. reviewer PASS 뒤 사용자가 서사 비약과 시각 오독을 지적했다.
4. 구조·텍스트·layout을 반복 수정하고 재렌더했다.
5. 내부 검사는 통과했지만 최종 수용 readback은 닫히지 않았다.

## 증거 경계

| 확인됨 | 확인되지 않음 |
|---|---|
| 파일 생성·렌더 | 실제 발표 사용 |
| 구조·시각 결함 수정 | 사용자 최종 수용 |
| reviewer QA | 경영진 승인·채택 |

## EG-Desk 목표 시나리오

```text
audience·purpose 고정 → draft artifact → renderer별 preview
→ structural/visual critic → 사용자 readback → revision loop
→ QA PASS·owner acceptance·actual delivery를 별도 상태로 표시
```

## Multi-agent technique opportunity

| 항목 | 판단 |
|---|---|
| 후보 기법 | content critic + visual renderer critic + owner readback |
| trigger | 발표·보고 산출물이 여러 renderer를 거칠 때 |
| 위험 | critic PASS를 실제 사용자 승인으로 오인 |
| acceptance | artifact revision, render proof, owner statement |

## Candidate product implications

- artifact 생성·렌더 QA·owner 수용·실사용을 분리한다.
- reviewer Agent의 권한을 QA로 제한한다.
- Chat feedback과 Canvas render target을 같은 revision에 연결한다.

## 정본 연결 후보

- [Atlas AI-04](../../../../ideas/confirmed/EGDESK_PRODUCT_INTERACTION_TRACE_ATLAS.md#atlas-ai-04)
- [Atlas AI-05](../../../../ideas/confirmed/EGDESK_PRODUCT_INTERACTION_TRACE_ATLAS.md#atlas-ai-05)
- [Contract failure boundaries](../../../../ideas/confirmed/EGDESK_INTERACTION_AND_ORCHESTRATION_CONTRACT.md#tech-failure-boundaries)

## 열린 질문

- reviewer PASS와 owner acceptance를 어떤 UI로 구분하는가?
- 여러 renderer의 동일 artifact revision을 어떻게 증명하는가?
- 실제 발표·배포 receipt를 사례와 어떻게 연결하는가?

## Privacy

슬라이드 원문, 사내 업무내용, 인물·화면과 절대경로는 복제하지 않았다. artifact·render
상태와 permission-safe SourceRef만 보존한다.
