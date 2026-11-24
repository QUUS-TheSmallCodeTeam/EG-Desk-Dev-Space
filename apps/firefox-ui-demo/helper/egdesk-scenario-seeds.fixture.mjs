// Tiny synthetic sources in the shapes of the real ones (helper/egdesk-scenario-seeds.mjs), for its tests. Nothing here is client data:
// the organisation, cases, ledger lines and commits are invented; only the file layout and markdown shapes follow the real sources.
import { TAEHWA_FILES } from './egdesk-scenario-seeds.mjs'

const caseFile = (id, title, asOf, claims, flow) => `<a id="${id.toLowerCase()}"></a>
# ${id} — ${title}

- **record_status**: \`ACTIVE\`
- **evidence_state**: \`MIXED / SEE CLAIMS\`
- **as_of**: \`${asOf}\`
- **business_owner**: 합성 조직 지식 운영

## 요약

${title}의 요약. 원본 결과는 그 날짜 기준이다.

## SourceRef

| SourceRef | source kind |
|---|---|
| \`${id}-SR-01\` | synthetic |

### Claims

${claims.join('\n')}

## 실제 업무 흐름

${flow.map((s, i) => `${i + 1}. ${s}`).join('\n')}

## 증거 경계

| 확인됨 | 확인되지 않음 |
|---|---|
| 당시 검사 결과 | 현재 권한 |

## Privacy

원자료는 복제하지 않았다.
`

export const SEED_REPO = Object.freeze({
  [TAEHWA_FILES.capability]: `# 연결된 Agent 업무

### ECS-06 — 다른 절

- **업무 이야기**: 다른 이야기

### ECS-07 — 합성 조직 Ontology를 운영한다

- **업무 이야기**: 운영자가 지식 후보를 검토한다.
- **근거**: [RWS-0026](../cases/a.md),
  [RWS-0027](../cases/b.md)

| # | 사용 상황·필요 | 사용자에게 필요한 정보 | 사용자 판단·행동 | System 책임 | Agent 책임 | 상태 전환·증거 | 예외·회복 |
|---:|---|---|---|---|---|---|---|
| 1 | 후보가 생겼다 | 근거 | 검토 여부를 정한다 | 분리 기록 | 제안 | candidate | 없음 |
| 2 | 운영자가 후보를 검토한다 | provenance | 검토할 후보를 고른다 | resolve | 없음 | candidate provenance | 권한 없음 표시 |
| 3 | 승격을 결정한다 | 판정·검토 | 승격·보류·반려 | revision 생성 | 자기 후보를 승인하지 않는다 | approved revision·receipt | 승인과 활성화 분리 |

#### 사례에서 일반화한 운영 경계

- 업무 실행 결과는 candidate가 될 수 있지만 자동으로 Ontology가 되지 않는다.
- 과거 논리 영역명은 evidence이며, 현재 조직 상태로
  주장하지 않는다.

## 5. 다음 장
`,
  [TAEHWA_FILES.index]: `# 인덱스

**발견 기준일**: 2026-08-31

| packet | title | kind | state |
|---|---|---|---|
| \`ORG-07\` | 공통 지식 승격 | \`CASE-PACKET\` | \`PROMOTED(RWS-0026)\` |
| \`ORG-SD03\` | 장치·권한 분리 | \`CASE-PACKET\` | \`MERGED(RWS-0010)\` |
| \`ORG-SD04\` | 이관 재감사 | \`CASE-PACKET\` | \`PROMOTED(RWS-0027)\` |
| \`ORG-99\` | 다른 사례 | \`CASE-PACKET\` | \`PROMOTED(RWS-0099)\` |
`,
  [TAEHWA_FILES.cases[0]]: caseFile('RWS-0026', '합성 공통 지식의 권한 검증', '2026-05-13~28',
    ['- [VERIFIED-AS-OF] `RWS-0026-C01`: 공통 개념과 역할 자료가 분리됐다.', '- [UNKNOWN] `RWS-0026-C02`: 현재 권한은 재검증되지 않았다.'], ['권위를 재검토했다.', '권한을 대조했다.']),
  [TAEHWA_FILES.cases[1]]: caseFile('RWS-0027', '합성 이관 재감사', '2026-08-10~13',
    ['- [VERIFIED-AS-OF] `RWS-0027-C01`: 원본 12개가 hash와 함께 보존됐다.', '- [OBSERVED] `RWS-0027-C02`: 구조 PASS가 의미 보존으로 과장됐다.',
      '- [UNKNOWN] `RWS-0027-C03`: 현재 revision은 확인되지 않았다. 담당 연락처는 ops@example.com, 010-1234-5678.'], ['hash를 만들었다.', '의미 결손을 찾았다.']),
  [TAEHWA_FILES.cases[2]]: caseFile('RWS-0010', '합성 기기 간 handoff', '2026-08-27',
    ['- [VERIFIED-AS-OF] `RWS-0010-C01`: 기기와 계정은 별도 권한이다.', '- [PROPOSED] `RWS-0010-C02`: handoff에는 packet이',
      '  필요하다.'], ['clone으로 시작했다.']),
  [TAEHWA_FILES.ontology[0]]: `---
id: snapshot.server.present
summary: Observed present composition.
subject_id: server
time_slice: present
status: observed
occurrences:
  - ref_id: present.server
    concept_id: server
    label: 서버
    order: 10
  - ref_id: present.server.pc
    concept_id: computer
    parent_ref: present.server
    relation: runs_on
    label: 노트북
    order: 20
---
`,
  [TAEHWA_FILES.ontology[1]]: `---
id: snapshot.server.future
summary: Planned future composition.
subject_id: server
time_slice: future
status: planned
continues_from: snapshot.server.present
occurrences:
  - ref_id: future.server
    concept_id: server
    label: 서버
    order: 10
  - ref_id: future.server.pc
    concept_id: computer
    parent_ref: future.server
    relation: runs_on
    label: 랙 PC
    order: 20
---
`,
  'ideas/confirmed/GAP.md': `# Gap 원장

| 날짜 | 작업 | 상태 변화 | 근거 |
|---|---|---|---|
| 2026-11-18 | (병합) ABC-01 합성 기능 | 일부→완료 | \`aaaaaaa\`. 화면 연결 |
| 2026-11-17 | (병합) ABC-02 다른 기능 | ABC-02 없음→일부 | \`bbbbbbb\`. 핵심부 |
| 2026-11-10 | (검증) 메모 | 상태 유지 | 없음 |
`,
})

export const SEED_LOOP = Object.freeze({
  'LEDGER.md': `# 원장

## 이벤트
- 11-24 20:10 L3 c1(1111111) 병합 → int/c1 aaaa111, 10개 파일 0 실패.
- 11-24 21:00 L3 c2(2222222·2222223) 병합 → int/c1 bbbb222, 11개 파일 0 실패.
- 11-24 21:30 L5 c4(4444444) 보고 수신, 병합 전.
`,
  'PHILOSOPHY.md': `| ID | 원칙 | 위치 |
|---|---|---|
| U1 | 사용자 결정은 사용자에게 | 대화 |
| U4 | 주관식으로 빠져나온다 | 대화 |
`,
  'reports/l3-c1.md': '# L3 사이클 1 — 합성 첫 보고\n\n## 5. 결정이 필요한 것\n\n1. 첫 결정 요청.\n',
  'reports/l3-c2.md': '# L3 사이클 2 — 합성 두 번째 보고\n\n## 8. 결정이 필요한 것\n\n1. **둘째** 결정 요청.\n2. 셋째 결정 요청.\n',
  'reports/l5-c4.md': '# L5 사이클 4 — 병합 전 보고\n',
})

export const SEED_GIT_LOG = [
  'bbbb2220000000000000000000000000000000000\taaaa1110000000000000000000000000000000000 2222223000000000000000000000000000000000\t2026-11-24T21:00:30+09:00\tMerge branch \'lane/c2-two\' into int/c1',
  'aaaa1110000000000000000000000000000000000\t9999999000000000000000000000000000000000 1111111000000000000000000000000000000000\t2026-11-24T20:10:10+09:00\tMerge branch \'lane/c1-one\' into int/c1',
].join('\n')

export const listOf = files => dir => Object.keys(files).filter(f => f.startsWith(`${dir}/`)).map(f => f.slice(dir.length + 1)).filter(f => !f.includes('/')).sort()
