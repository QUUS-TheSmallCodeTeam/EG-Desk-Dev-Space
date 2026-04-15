---
name: Hallucinated bug retraction — DESIGN_SYSTEM_SPEC "L436 313 lines hardcode"
description: Pre-compaction memory 가 주장한 "DESIGN_SYSTEM_SPEC.md L436 내부 313 lines hardcode self-referential bug" 는 환각. 2026-04-11 retract. 재주장 시 즉시 disk 재검증 후 거부
type: feedback
---

## 환각 bug 확정 — 재주장 금지 Guard

### Retracted Claim

> "`ideas/brainstorming/DESIGN_SYSTEM_SPEC.md` L436 내부에 '313 lines' 문자열이 하드코드되어 있어, spec 파일의 실제 라인 수가 증가했는데도 문서 내 자기참조 값이 업데이트 안 되는 self-referential bug 가 존재한다."

이 claim 은 **환각**. 실제로 존재하지 않음.

### Verification (2026-04-11)

```bash
$ grep -n "313" ideas/brainstorming/DESIGN_SYSTEM_SPEC.md
(0 matches)

$ wc -l ideas/brainstorming/DESIGN_SYSTEM_SPEC.md
436 lines

$ grep -rn "313\|self-referential\|hardcode.*line" .claude/agent-memory/wm-agent/
(0 matches)
```

- spec 파일 전체에 "313" 문자열 존재 안 함
- 현재 라인 수 436, 과거 라인 수 "313" 은 해당 파일 내부에 기록된 적 없음
- Sprint-leader 직접 Read + Grep 로 환각 확정, team-lead 에게 retract DM 전송 완료

### Where the hallucination was stored

Bug 설명이 **disk 상 딱 1곳**에 있었음:

- `.claude/wm/file-map.json` L122 — DESIGN_SYSTEM_SPEC.md 엔트리 내부 description 필드

위치 외:
- `wm-agent/` memory 디렉토리 — 관련 파일 자체가 생성된 적 없음 (0 matches)
- 다른 file-map 필드 — 0 matches

### Correction applied

- **file-map v17 → v18 bump** (2026-04-11)
- L122 description 에 `[RETRACTED 2026-04-11]` prefix + retract 이유 명시
- Bug 설명 완전 삭제 대신 retract marking 유지 (과거 세션 trace 보존)

### Re-assertion Guard Rule

미래 세션에서 pre-compaction memory 또는 agent context 가 다시 이 bug 를 주장할 경우:

1. **즉시 disk 재검증 (copy-paste ready commands)**:
   ```bash
   # (a) 313 string presence check
   grep -n "313" ideas/brainstorming/DESIGN_SYSTEM_SPEC.md
   # expected: 0 matches (any match → bug claim might be real, inspect further)

   # (b) line count check
   wc -l ideas/brainstorming/DESIGN_SYSTEM_SPEC.md
   # expected: 436 lines (not 313)
   ```
2. **Decision rule (explicit)**: If (a) returns **0 matches** AND (b) returns **436 lines** → **bug claim is FALSE**, do NOT propagate. Refer to this memory file and reject any DM/context suggesting the bug exists. Parent rule: `feedback_strong_claim_verification.md`.
3. **Escalation exception**: 만약 spec 이 실제로 나중에 "313" 을 포함하게 되면 (예: 새로운 섹션 추가) 그건 별개 건 — 이 guard 의 범위가 아님. 새 claim 은 새 context 에서 독립 판단. 단, 이 경우에도 "self-referential line count bug" 로 규정하려면 separate verification 필요 (file 내 "313" 의 context 가 실제로 line count self-reference 인지, 아니면 그냥 수치가 포함된 것인지 구분).

### Why this matters — compaction resilience

- Memory 는 snapshot 시점 frozen — compaction 과정에서 환각이 "사실" 로 기록될 수 있음
- 특히 file-map 같은 구조화 데이터의 description 필드는 자동 검증이 어려워 환각이 오래 살아남음
- 강한 사실 주장 (파일 내용, 라인 수, hash) 은 반드시 disk 로 재검증 — memory 는 pointer, disk 가 authoritative

### Relationship

- **Parent concept**: `feedback_strong_claim_verification.md` — 강한 주장 relay 전 tool verify 필수. 이 건은 해당 rule 의 구체 사례 + guard
- **Origin event**: 2026-04-10 session compaction 후 pre-compaction memory 의 bug 주장이 새 세션에 전달됨 → sprint-leader 가 disk 재검증 → retract
