# ADR-004 — Canvas Tools Integration into Dock

**Status**: Decided
**Date**: 2026-04-13 (보강 2026-04-13 — content-aware Dock width 정책 추가; 재보강 2026-04-13 — DeskRail 수평 중앙 anchor + 가로 Edge 정렬 통일; Decided 2026-04-13 — 유저 승인)
**Related SPEC**: `ideas/brainstorming/DESIGN_SYSTEM_SPEC.md` §7 Edge 정렬/너비 정책 (v2), §7-1 (v2, 수평 중앙 anchor + traffic lights 버퍼), §7-2 (v2, content-aware width), §7 L316 (v2), §9-1 (Superseded v1), §10-2 designMd (v2)
**Supersedes**: `DESIGN_SYSTEM_SPEC.md §9-1 v1` (Canvas Toolbar as separate floating L2 layer)

---

## Context

EG-Desk Dock 은 §7-2 에서 **앱/가젯 launcher** 역할로 정의됐고, Canvas 조작 도구 (Pencil / Hand / Square / Arrow 등) 는 §9-1 에서 **별도 floating L2 layer** (Canvas Toolbar) 로 분리 설계됐다. 분리 근거:

- **3축 ontology 분리** (§9-1 v1 L354-355): Dock = 객체축, PresetBag = 장소축, Canvas Toolbar = 메타축
- **Ambient 원칙**: 도구는 캔버스 조작이 필요한 순간에만 유의미, 상시 노출 지양
- **Cluttered toolbar 방지** (§7 L316): Edge당 최대 5 요소

2026-04-13, 유저가 직접 다음 지시를 내림:

> "브라우저를 채팅 쪽으로 옮기고 중앙 칸에 pencil/hand/square/arrow 4개 넣자. 자리 넓잖아."

이 지시는:
1. **§7-2 L206 "Canvas 조작 도구 제외"** 조항을 무효화
2. **§9-1 L440 "Dock 내부 배치 금지"** 조항을 무효화
3. **§7 L316 "5-element 한도"** 를 9개로 명시적 초과
4. **§10-2 L614 designMd FORBIDDEN** 중 "canvas drawing tools in Dock" 항목을 무효화

design-agent 가 유저 지시를 Dock.tsx 에 구현 완료 (Flag 2건 보고). PM 은 SPEC/ADR 정합화 경로를 결정한다.

**유저 quote 중 "자리 넓잖아"** 는 유저가 5-element 제약과 기존 빈 공간 상태를 인지한 채로 결정했음을 보여준다. 이는 Option D (유저 재확인) 를 불필요하게 만들고, SPEC 을 유저 결정에 맞게 조정하는 방향을 확정한다.

---

## Options Considered

### Option A — §9-1 v1 유지 + Dock 은 잘못된 구현 (rollback)

**Verdict**: REJECT

- **Pros**:
  - 3축 ontology 보존
  - Ambient 원칙 유지
- **Cons**:
  - **유저 직접 지시에 반하는 rollback** — 조직적/UX 원칙 이유로 사용자 결정을 번복하는 것은 PM 권한 밖
  - 유저가 "자리 넓잖아" 맥락에서 공간 활용을 명시적 요구 → 빈 중앙을 유지하는 것이 역으로 부자연스러움

### Option B — §7 5-element rule 예외 조항만 추가, §9-1 유지 (두 surface 공존)

**Verdict**: REJECT

- **Pros**:
  - SPEC 수정 최소화
- **Cons**:
  - 동일 도구 (Pencil/Hand/Square/Arrow) 가 **Dock 과 Canvas Toolbar 2개 surface 에 중복** 노출 → 멘탈 모델 혼란
  - "어디서 클릭해야 맞는가" 의사결정 부담을 유저에게 떠넘김
  - §9-1 L440 "Dock 내부 배치 금지" 와 모순 상태 유지

### Option C — §9-1 v1 Superseded + §7-2 / §7 L316 / §10-2 designMd 일괄 재작성 (하이브리드)

**Verdict**: **ACCEPT**

- **Pros**:
  - 유저 결정 수용
  - SPEC 전체 **정합성 회복**: 충돌 조항들 일괄 해소
  - Dock 이 "객체축(앱/가젯) + 메타축(Canvas tools)" 복합 축으로 재정의 → 명확한 single source of truth
  - 향후 Canvas tools 확장 시 Dock 그룹 내에서 처리 가능
- **Cons**:
  - 3축 → 2축 ontology 축소 (메타축 소멸)
  - Ambient 원칙 일부 약화 (Canvas tools 상시 노출 → "캔버스 조작이 필요한 순간에만" 원칙 부분 위반)
  - §9-1 v1 작업 (Task #11) 롤백 비용
  - SPEC 수정 범위 광범위 (§7-2, §7, §9-1, §10-2, ADR-001 Consequences)

### Option D — 유저에게 §9-1 결정 재확인 (push back)

**Verdict**: REJECT

- **Pros**:
  - 결정 비용 최소화 (유저가 뒤집으면 SPEC 작업 불필요)
- **Cons**:
  - 유저 quote "자리 넓잖아" 가 **제약 인지 상태에서의 결정임을 명시** → 재확인 불필요
  - design-agent 구현 완료 + hot reload 체감 긍정 → 유저 재확인은 이미 암묵적으로 진행됨
  - Push back 은 유저 피로 누적 (최근 Task #11 로 §9-1 v1 확정 직후 뒤집는 상황 → 중복 질문은 역효과)

---

## Decision

**Option C — §9-1 v1 완전 Superseded 처리, SPEC 일괄 재작성.**

### 구체 실행 (10곳 수정)

| # | 경로 | 작업 | Status |
|---|------|------|--------|
| 1 | `DESIGN_SYSTEM_SPEC.md` §9-1 | v1 전체 `<details>` 블록으로 접기 + Superseded 헤더 + ADR-004 참조 | 완료 |
| 2 | 같은 파일 §7-2 L194 | Layout 재작성 (+ ↔ Browser swap 반영): `[Chat][Shelf][Browser][+] ─ [Pencil/Hand/Square/Arrow] ─ [Trash]` | 완료 |
| 3 | 같은 파일 §7-2 L206 | "Canvas 조작 도구 제외" 문구 삭제, "Canvas 도구 그룹 포함" 재작성 | 완료 |
| 4 | 같은 파일 §7 L316 | "5 element 한도" → "그룹당 max 5, Dock 전체 max 12 허용" | 완료 |
| 5 | 같은 파일 §10-2 L614 designMd | "canvas drawing tools in Dock" 삭제, "more than 5 elements per Edge" → "more than 12 in Dock / 5 in other Edges" | 완료 |
| 6 | `ADR-001` Consequences | NodeToolbar reject 논리 reframe ("Dock icon 패턴으로 수렴"), §9-1 v1 참조를 ADR-004로 갱신 | 완료 |
| 7 | `ADR-004` (이 파일) | 신규 Proposed | 완료 |
| 8 | `INDEX.md` | ADR-004 추가 + ADR-001 Related SPEC 갱신 | 완료 |
| 9 | 같은 파일 §7-2 L181-183 + §7 신규 "Edge 너비 정책 (v2)" + §10-2 designMd Dock 설명 | **Content-aware width 보강** (보강 2026-04-13): Dock 만 `width: auto`, `max-w: min(95vw, 960px)`, min ~140-160px 명시. 다른 Edge는 기존 고정값 정책 유지 | 완료 |
| 10 | 같은 파일 §7-1 위치 및 크기 + §7 "Edge 정렬/너비 정책" 확장 | **DeskRail 수평 중앙 anchor + 가로 Edge 정렬 통일 재보강** (재보강 2026-04-13): DeskRail 좌측 anchor → 수평 중앙 정렬 (`left: 50%, translateX(-50%)`) + traffic lights 최소 176px 버퍼. flex-responsive 채택 (content-aware 는 제외). §7 정책을 "가로 Edge = 중앙 anchor / 세로 Edge = 변측 anchor" 로 일반화 | 완료 |

### Flag 별 PM 선택 (design-agent 보고 기반)

**Flag 1 (§7 5-element)**: **"그룹당 max 5, Dock 전체 max 12"**
- 단순 한도 제거 대신 그룹 카운트 채택 → "cluttered toolbar 방지" 원래 의도 부분 보존
- 현재 구현 3그룹 (4/4/1) 수용 + 향후 확장 여지 (최대 5/5/2 = 12)

**Flag 2 (§9-1 중복)**: **"§9-1 v1 완전 Superseded"**
- 2 surface 중복 노출 회피
- Dock 중앙 그룹이 Canvas tools 의 **유일한 진입점**
- v2+ 에서 floating toolbar mode 필요성 발생 시 신규 ADR로 재검토

---

## Consequences

### 긍정

1. **SPEC 정합성 회복**: 6개 명시적 FORBIDDEN 조항 해소
2. **유저 의도 수용**: Dock 공간 활용도 증가, Canvas tools 접근 동선 단축
3. **구현 복잡도 감소**: Canvas Toolbar 별도 component (`CanvasToolbar.tsx`) 구현 불필요 → DeskHome 구조 단순화
4. **단일 진입점**: Canvas tools 멘탈 모델 명확 (Dock 중앙 그룹 = 유일 진입점)
5. **Content-aware 적응성 (v2 보강)**: Dock 아이콘 수 변화 (v1 9개 → 향후 Text/Highlighter 추가 등) 에 width 자동 대응. 빈 공간 (justify-between 사용 시) / 아이콘 잘림 (고정 max-width 초과 시) 양 극단 모두 방지. `min(95vw, 960px)` 상한으로 매우 큰 화면 폭주도 차단
6. **가로 Edge 정렬 통일 (재보강)**: DeskRail + Dock 둘 다 수평 중앙 anchor 로 통일. 유저 멘탈 모델 단순화 ("가로 Edge = 중앙") + 비대칭 시각 부담 해소. Traffic Lights 176px 버퍼 명시로 macOS 환경 구현 안전성 확보

### 부정 / Trade-off

1. **3축 → 2축 ontology 축소**: Dock 이 "객체축 + 메타축" 복합 축으로 확장되면서 개념적 순도 감소. "Dock 이란 무엇인가" 정의가 넓어짐
2. **Ambient 원칙 약화**: Canvas tools 상시 노출 → "조작이 필요한 순간에만" 원칙 부분 위반. 유저가 캔버스 사용하지 않는 동안에도 중앙 그룹 visible
3. **5-element rule 완화의 연쇄 리스크**: Dock 예외를 만들었으므로 향후 다른 Edge (PresetBag, Right HUD) 도 유사 요구 시 일관된 거절 근거 약화 → §7 L316 v2 에서 **"Dock에 한해서만 예외, 다른 Edge는 5 유지"** 명시 필요
4. **Canvas tools 확장성 한계**: v1 4개 → v2 에서 Text, Highlighter, Shape variants 등 추가 시 Dock 중앙 그룹 max 5 도달 후 별도 처리 필요 (sub-menu 또는 신규 ADR)
5. **§9-1 v1 작업 매몰 비용**: Task #11 로 확정된 §9-1 전체 무효화. Canvas Toolbar 전용 3-Cue 힌트 공존 규칙 등 부수 설계도 함께 폐기
6. **Edge 너비 정책 이원화 (v2 보강)**: Dock 만 content-aware 예외 → "모든 Edge 는 동일 원칙을 따른다" 는 §7 일관성 훼손. 향후 다른 Edge (PresetBag 등) 가 content-aware 요구 시 Dock 예외 근거 재활용 우려. §7 신규 "Edge 너비 정책" 서브섹션에서 **"Dock 에 한정된 예외, 다른 Edge 는 고정값 유지"** 명시로 완화
7. **정렬 정책 축 구분 부담 (재보강)**: 가로 Edge (중앙 anchor) vs 세로 Edge (변측 anchor) 로 정책이 갈라짐 → "Edge 는 이렇게 정렬한다" 단일 규칙 소멸. "축 방향별 정책" 으로 일반화했으나 **축 → 규칙 매핑** 을 설계자/구현자가 추가 학습 필요. §7 신규 섹션 내 근거 서술 (뷰포트 수평축 주 조망선 / 세로 Edge 도킹 metaphor) 로 일관성 확보 시도, 장기 체감 후 재검토 필요

### 후속 의사결정 (v2 체감 후 재검토 후보)

- Canvas tools active state 유지 방식 (mode-based drawing vs click-to-draw one-shot)
- Canvas tools Dock 내 위치 (중앙 고정 vs 유저 이동 허용)
- Pan 도구 (Hand) 와 Immersion Mode (Task #13) 의 상호작용 정의
- 확장 시 Dock max 12 한도 도달 시 처리 전략 (overflow menu vs group rotation)

---

## References

- **Superseded**: `DESIGN_SYSTEM_SPEC.md §9-1 v1` (`ideas/brainstorming/DESIGN_SYSTEM_SPEC.md` L348-459, `<details>` 블록으로 보존)
- **Related SPEC v2**: §7-2 L194-206 (Layout), §7 L316 (element rule), §10-2 L614 (designMd FORBIDDEN)
- **Related ADR**: ADR-001 (Canvas Library Reference) — Consequences 섹션에서 NodeToolbar reject 근거 reframe
- **유저 지시 원문**: "브라우저를 채팅 쪽으로 옮기고 중앙 칸에 pencil/hand/square/arrow 4개 넣자. 자리 넓잖아." (2026-04-13, team-lead 경유 전달)
- **구현 파일**: `src/renderer/src/components/edges/Dock.tsx` (design-agent 작업), `src/renderer/src/components/icons.tsx` (Pencil/Hand/Square/Arrow 4 아이콘 신규)
- **design-agent 보고 Flag**: Flag 1 (§7 5-element 초과), Flag 2 (§9-1 Canvas Toolbar 중복) — 본 ADR Decision 섹션에서 각각 해소
