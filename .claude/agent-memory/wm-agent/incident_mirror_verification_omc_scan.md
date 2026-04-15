---
name: Mirror clone verification incident — omc-scan ↔ oh-my-claudecode
description: 2026-04-10 Phase 2a 조사에서 sprint-leader 가 "byte-identical mirror clone" 단정, WM 이 diff -rq 로 정정 → 40+ drift 발견. agents/designer.md 만 byte-identical. Incident evidence 보존
type: project
---

## Incident 개요

**When**: 2026-04-10 (Task #6 design-agent v2 iteration Phase 2a)

**Who**:
- **Claim originator**: sprint-leader — `references/omc-scan/` 탐색 중 `references/agent-orchestration/oh-my-claudecode/` 과의 file tree overlap 을 관찰
- **Claim relayer**: team-lead — sprint-leader 의 관찰을 "byte-identical mirror clone" 이라는 강한 수식어로 WM 에 전달
- **Verifier**: WM — `diff -rq --exclude=.git` 1회 실행으로 정정

**Why**: File tree 구조가 동일해 보이는 상황에서 "빠른 요약" 을 위해 "byte-identical" 이라는 단정어 사용. 실제 diff 호출 없이 관찰만으로 단정.

## 실측 결과 (2026-04-10 WM 검증)

### Broader repo drift

```bash
$ diff -rq --exclude=.git references/omc-scan references/agent-orchestration/oh-my-claudecode
```

발견: **40+ 파일 drift**
- `CLAUDE.md`: +16 bytes
- `CHANGELOG.md`: +2191 bytes
- `README*.md` (13개 언어 번역): 각각 drift
- `bridge/*` (7 파일): drift
- `dist/__tests__/*.js` (여러 파일): drift
- `SECURITY.md`: oh-my-claudecode 에만 존재 (신규)
- `dist/__tests__/ast-tools-path-restriction.*`: oh-my-claudecode 에만 존재
- `dist/__tests__/background-cleanup-directory.*`: oh-my-claudecode 에만 존재
- `.eslintignore`: omc-scan 에만 존재

### Specific file check (agents/designer.md)

```bash
$ diff -u omc-scan/agents/designer.md oh-my-claudecode/agents/designer.md
(no output — exit 0)

$ shasum both files
cafcd65f6069baf0c7a2fb49463c9f246f758f04  omc-scan/agents/designer.md
cafcd65f6069baf0c7a2fb49463c9f246f758f04  oh-my-claudecode/agents/designer.md

$ ls -la both files
-rw-r--r-- 5768 Apr  4 14:21 oh-my-claudecode/agents/designer.md
-rw-r--r-- 5768 Mar 26 21:59 omc-scan/agents/designer.md
```

**Outcome**: `agents/designer.md` 는 **BYTE-IDENTICAL** (SHA1 `cafcd65f6069baf0c7a2fb49463c9f246f758f04`, 5768 bytes, 104 lines). 타임스탬프만 다름 (Mar 26 ↔ Apr 4), 이는 clone 시점 차이.

## Meta observation — "Stable zones in drifted forks"

두 repo 는 전체 drift fork 지만 **agents/\*.md 는 stable** (동일).

**해석**: agents/\*.md 가 이 fork lineage 의 "frozen contract" 위치일 가능성. 활발히 개선되는 건 translations, bridges, dist/tests 이고, agent templates 는 stable. **OMC 계열 agent templates 를 base 로 삼는 건 drift 위험 낮음.**

### 확장된 mirror_map 스키마 (sprint-leader 승인 2026-04-11)

```json
"mirror_map": {
  "omc-scan ↔ oh-my-claudecode": {
    "status": "drifted_fork",
    "primary": "oh-my-claudecode",
    "stable_zones": ["agents/*.md"],
    "drifted_zones": ["CLAUDE.md", "bridge/*", "dist/__tests__/*", "README*.md", "CHANGELOG.md", "SECURITY.md"],
    "verified": "2026-04-11",
    "caveat": "stable_zones 은 verification 시점 스냅샷 — 두 repo 가 이후 divergent commit 받으면 stable 이 아닐 수 있음"
  }
}
```

**Sprint-leader 추가 caveat (승인)**: `stable_zones` 은 현재 시점 스냅샷. 재검증 필요 시 `shasum` 재실행.

## Impact

### 정정 cost

- WM 정정 DM 2통 (sprint-leader + team-lead)
- Team-lead reconciliation block 발생 (sprint-leader 의 "5번째 discrepancy" 로 추가)
- `references/omc-scan/` vs `references/agent-orchestration/oh-my-claudecode/` 의 primary 결정 재검토 (→ oh-my-claudecode primary 로 확정)

### V2 draft 영향 (최종)

- **영향 없음** — v2 가 차용한 `agents/designer.md` 부분은 양 repo identical
- v2 의 11-section XML skeleton, Inter slop 분석 (L22/L33/L85) 모두 "1 source" 유지
- Pretendard 결정 불변 (원래도 context mismatch 기반, source count 기반 아님)

## Related guards

- **Rule parent**: `feedback_strong_claim_verification.md` — 강한 주장 relay 전 tool verify 필수 (본 사건이 이 rule 의 origin case)
- **Shelf scope**: `feedback_shelf_scope_filter.md` Rule #6 — Mirror/fork clone detection 절차
- **Retract companion**: `feedback_hallucination_retraction_313_bug.md` — 동일 시기의 다른 환각 claim retract (서로 독립)

## Why preserve this incident

- **Compaction resilience**: 이 사건의 fact trail (SHA1, byte count, diff output) 이 frozen state 로 보존됨 → 미래 세션이 "omc-scan 은 oh-my-claudecode 의 byte-identical mirror" 주장을 다시 하면 이 파일 참조해서 즉시 retract
- **Pattern learning**: file tree overlap ≠ byte-identical 이라는 교훈. 미래 다른 mirror 탐지 시 동일 실수 방지
- **Evidence preservation**: WM 이 tool verify 했다는 기록. "누가 언제 어떻게 발견했는지" trace 가능
