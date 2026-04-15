---
name: shelf scope filter — 이름만 보고 out-of-scope 판정 금지
description: references/ 선반 feasibility 에서 clone 을 out-of-scope 로 분류할 때 이름 휴리스틱 대신 1-level ls 로 구조 신호를 먼저 읽으라는 규칙
type: feedback
---

**Rule**: references/ 선반의 clone 을 "out-of-scope" 로 분류하기 전에 반드시 `ls references/{clone}/` 을 실행해서 최상위 구조를 확인한다. clone 이름만 보고 판정 금지 (특히 generic 이름: `gstack`, `lemonade`, `koreancode`, `mirofish`, `neuronfs` 등).

**Positive signals (이름이 generic 이어도 반드시 드릴다운해야 하는 증거)**:
- `AGENTS.md`, `CLAUDE.md`, `SKILL.md`, `SKILL.md.tmpl`, `ETHOS.md` — agent framework 일 가능성
- `agents/`, `skills/`, `commands/`, `hooks/`, `templates/`, `output-styles/`, `skill-creator/`, `plugins/`, `subagents/` 디렉토리
- `AGENTS_GUIDE.md`, `SYSTEM_PROMPT.md` 류 prompt engineering 파일
- `design-*`, `review-*`, `consultation-*`, `plan-*` 접두사 하위 디렉토리

**Why**:
2026-04-10 feasibility (designer prompt 조사 task) 에서 `gstack` 을 "generic toolkit stack 이름이겠지" 라며 out-of-scope 리스트에 넣었다. 유저가 직접 지적해 확인해보니 실제로는:
- `references/gstack/design-consultation/SKILL.md` — designer consultation agent
- `references/gstack/design-review/SKILL.md` — designer review agent
- `plan-design-review`, `plan-ceo-review`, `plan-eng-review`, `retro`, `review`, `autoplan`, `careful` 등 풀 에이전트 프레임워크
- 최상위에 `AGENTS.md + ETHOS.md + SKILL.md + CLAUDE.md + SKILL.md.tmpl` → 이 조합 자체가 "agent framework" 신호였는데 놓침

또 `bkit-claude-code` 의 경우 `agents/` 만 드릴다운하고 `skills/`, `skill-creator/`, `output-styles/`, `templates/`, `commands/`, `hooks/` 등 designer-adjacent 리소스를 누락했다. **Drilldown 이 `agents/` 한 곳에 그치면 안 되고, 신호가 있는 모든 최상위 디렉토리까지 가야 한다.**

결과: explore-agent-4 를 긴급 spawn 해서 gstack + bkit 확장 scope 를 복구해야 했다. Task 비용 증가 + phase 지연. 이 miss 가 없었으면 explore-agent-1 scope 에 처음부터 포함됐을 것.

**How to apply**:
1. Feasibility 에서 clone 분류 시 **모든 clone 에 대해 `ls references/{name}/` 는 기본**. Skip 금지.
2. Out-of-scope 후보는 추가로 다음 체크:
   - `AGENTS.md` / `SKILL.md` / `CLAUDE.md` / `ETHOS.md` 있나?
   - `agents/` / `skills/` 디렉토리 있나?
   - 최상위 하위 디렉토리 이름에 `design`, `review`, `plan`, `consultation`, `retro`, `agent`, `prompt` 같은 단어 있나?
   - 하나라도 YES → out-of-scope 제외, 드릴다운 필요
3. Primary candidates 드릴다운 시 `agents/` 한 곳에 그치지 말고 `skills/`, `templates/`, `output-styles/`, `commands/` 등 인접 리소스도 스캔.
4. 시간이 부족해서 전수 드릴다운 불가하면 feasibility JSON 의 `notes` 에 **"이름만 보고 필터함 — 확인 안 된 clones"** 리스트를 명시해서 team-lead 가 위험 인지하게 한다. 조용히 out-of-scope 에 넣는 것보다 명시적 caveat 이 낫다.
5. `ls` 출력이 terminal 에서 잘려있으면 (`... (truncated)` 또는 `head` 사용) **반드시 full listing 재확인**. 내가 첫 `ls references/gstack` 에서 `codex` 에서 잘렸고, 그 뒤 `design-consultation`, `design-review` 가 있었는데 그걸 못 봤다. `head -40` 같은 limit 은 무관하게 처음부터 `ls -1 | sort` 로 전체 확인 가능.

6. **Mirror / fork clone 탐지** (2026-04-10 추가): 같은 프로젝트가 서로 다른 경로에 clone 된 경우 feasibility 단계에서 **반드시 교차검증** 필수. 단순 이름 비교로 "duplicate 이겠지" 단정 금지 — 실제로는 **drift 가 있는 fork/snapshot** 일 수 있음.

   **실제 사례 (2026-04-10, Task #6 v2 iteration 준비 중 sprint-leader 발견)**:
   - `references/omc-scan/` (top-level, clone: 2026-03-26) 과 `references/agent-orchestration/oh-my-claudecode/` (nested, clone: 2026-04-04) 이 같은 upstream repo
   - Sprint-leader 가 "byte-identical mirror" 로 보고 → WM 검증 결과 **40+ 파일 content drift**:
     - `oh-my-claudecode` 에 `SECURITY.md`, `dist/__tests__/ast-tools-path-restriction.*`, `background-cleanup-directory.*` 등 신규 파일 추가됨
     - `omc-scan` 에만 `.eslintignore` 존재
     - `CLAUDE.md` (+16 bytes), `CHANGELOG.md` (+2191 bytes, ~2주 업데이트 포함), README 번역 13개, `bridge/*.{cjs,py,js}` 전부 diff
   - 결과: Same upstream ✓, byte-identical ✗, **~1주~2주 drift 존재**. `oh-my-claudecode` 가 newer.
   - **Lesson**: Explorer 2개가 각자 같은 upstream 을 조사하면 작업 duplicate + stale snapshot 사용 위험 동반 발생. feasibility 단계에서 mirror 감지 필수.

   **탐지 규칙**:
   - **Top-level scan**: `ls references/` 돌릴 때 이름 hint (`omc-*`, `oh-my-*`, `claude-code-*` 등 자주 fork 되는 이름) 목록화
   - **Nested scan**: subdirectory 선반 (`references/agent-*/`, `references/*/tools/`) 도 top-level 과 교차검증
   - **Diff check**: 후보 페어가 나오면 `diff -rq --exclude=.git A/ B/ | head -20` 으로 content-level 확인 (file list 비교만으로는 부족 — drift 감지 필요)
   - **Upstream 확인**: `.git/config` 또는 `git remote get-url origin` 로 upstream URL 비교 가능 (근본 증거)

   **처리 규칙**:
   - Byte-identical 확인 시 → 둘 중 하나만 primary, 다른 건 feasibility notes 에 "mirror of X — skipped" 명시
   - Drift 있는 mirror 시 → **newer clone 을 primary** (더 최근 정보 반영), older 는 "older snapshot of X — skipped, newer at Y" 명시
   - 어느 쪽이 newer 인지 판별: clone timestamp (`ls -la`) 또는 `git log -1 --format=%ci` 비교

   **Feasibility JSON 에 `mirror_map` 섹션 추가 고려**: `{"omc-scan": "mirror_of:oh-my-claudecode (newer)", ...}` 같은 형태로 team-lead 가 위험 인지 가능하게 함.
