---
name: paste.md is intentional clipboard scratch
description: paste.md in project root is a user's persistent clipboard scratch file — do not flag as stray/untracked on delta sync
type: project
---

`paste.md` (프로젝트 루트)는 유저가 clipboard 임시 보관용으로 상시 사용하는 의도된 파일.

**Why:** 2026-04-05에 team-lead 경유로 유저가 확인. WM이 delta sync에서 신규 파일로 감지하고 "정리 필요?"로 flag했으나, 의도된 용도이며 정리 대상 아님.

**How to apply:**
- delta sync에서 `paste.md` 변경 감지 시 → 통상 변경처럼 file-map 업데이트만. "신규/의심 파일"로 보고하지 말 것.
- 내용은 수시로 바뀌므로 hash 불일치의 흔한 원인이 될 수 있음 — paste.md 단독 변경이면 team-lead 보고 시 축약하거나 생략.
- file-map.json의 `paste.md` entry에는 이미 "INTENTIONAL clipboard scratch" 마킹 유지.
