# 003. Electron Sidebar Drag-Resize UX Reference

**Status**: Decided
**Date**: 2026-04-13 (Decided 2026-04-13 — 유저 승인, anytype 차용 거절 확정)
**Deciders**: egdesk-pm-agent, Session Lead, User
**Related SPEC**: `ideas/brainstorming/DESIGN_SYSTEM_SPEC.md` §7-3 (PresetBag, Left Edge)

## Context

EG-Desk는 4-Edge Framework(SPEC §7)로 **고정 폭 Edge bar**를 사용한다:
- DeskRail (top): 고정 h-12
- Dock (bottom): 고정 h-14
- **PresetBag (left): collapsed 48-56px ↔ expanded 280px 2-state toggle** (L228-265)
- ContextualHUD (right): 고정 w 320-400px, h 70-80% viewport

`references/anytype/src/ts/component/sidebar/left.tsx:L89-205`는 고급 사이드바 UX를 제공한다:
- 드래그 핸들로 연속 리사이즈
- `closeWidth = min * 0.75` 이하로 드래그하면 **자동 close**
- sub-page (중첩 사이드바) 지원
- RAF 기반 smooth resize

질문: **anytype sidebar UX를 EG-Desk PresetBag(또는 향후 DeskRail/HUD)에 차용할지** 결정 필요.

선행 고려사항:
- anytype은 ASAL 1.0 (🔴 Red, ADR-002) → **코드 포팅 금지, 개념 차용만 가능**
- EG-Desk는 "invisible until invoked" ambient 철학 (`docs/EG-DESK_Whitepaper.md`)
- 이미 Pan Immersion Mode v1 (Task #13)이 "Space/Cmd hold → 3 Edge 숨김"으로 **Edge visibility 제어** 일부 커버

## Options Considered

### Option A — anytype 방식 차용: 드래그 리사이즈 + auto-close

- **Pros**:
  - 연속 리사이즈로 user가 원하는 폭 정확히 조절 가능
  - auto-close (width < closeWidth) UX는 "invisible until invoked" 철학과 정합
  - 검증된 패턴 (anytype 프로덕션 사용 중)
- **Cons**:
  - SPEC §7-3 현행 "2-state toggle (48-56 ↔ 280)"과 **철학 충돌**: toggle은 binary, drag는 analog
  - Ambient 철학 저해 가능성: "드래그로 크기 조절하는 순간 user가 UI를 **다루고 있다**" → ambient 실패
  - 구현 비용: RAF resize loop + closeWidth 계산 + state 관리
  - Pan Immersion Mode v1과 역할 중복: Edge 숨김은 이미 Space/Cmd hold로 가능
- **License**: anytype ASAL 1.0 🔴 — 코드 복사 금지. 개념만 차용 가능 (ADR-002)
- **Verdict**: ❌ Rejected (v1 기준) — 철학 불일치 + 역할 중복

### Option B — 현행 유지: 2-state toggle (48-56 ↔ 280)

- **Pros**:
  - Ambient 원칙 준수: 한 번의 클릭/hover로 binary 전환, "다루지 않고 전환됨"
  - 구현 단순, 상태 관리 간결
  - Pan Immersion Mode와 역할 분리 명확: PresetBag = 용도별 toggle, Pan Immersion = 전체 Edge hide
  - SPEC §7-3 이미 확정 상태
- **Cons**:
  - user가 "중간 크기"를 원할 경우 불가능 (다만 ambient 철학상 중간 크기는 설계 목표가 아님)
- **Verdict**: ✅ **Accepted** (v1)

### Option C — 하이브리드: toggle 기본 + user 커스텀 폭 설정

- **Pros**: v2에서 고급 user를 위한 option
- **Cons**: 지금 결정하면 premature. Pan Immersion v1 체감 + 유저 요청 evidence 후 재검토 가능
- **Verdict**: ⏳ **Deferred** — v2 이후, 실제 user feedback으로 "폭 조절 필요"가 나올 경우 재오픈

### Option D — anytype 차용하되 auto-close 개념만 (드래그 리사이즈 없이)

- **Pros**: "작은 위협으로 자동 숨김" UX 개념만 차용
- **Cons**: Pan Immersion Mode v1이 이미 **explicit trigger (Space/Cmd hold)**로 숨김 커버. implicit auto-close 추가는 user 혼란 가능성
- **Verdict**: ❌ Rejected — 기능 중복

## Decision

**Option B 채택: PresetBag의 2-state toggle 현행 유지. anytype sidebar UX 패턴 차용하지 않음.**

근거 요약:
1. Ambient 철학 ("invisible until invoked") → binary toggle이 analog drag보다 적합
2. Pan Immersion Mode v1이 이미 Edge 숨김 기능 커버 → 기능 중복 방지
3. SPEC §7-3 이미 확정 상태 (L228-265)
4. user feedback evidence 없음 → premature optimization 회피

**anytype의 참고 가치는 "Electron에서 sidebar 상태 관리" 아키텍처 수준으로 제한**. 구체 UX 패턴은 EG-Desk 고유 설계 유지.

## Consequences

**즉시**:
- SPEC §7-3 변경 없음 (현행 유지)
- `src/renderer/src/components/edges/PresetBag.tsx` 구조 변경 없음
- Pan Immersion Mode v1 체감 평가 시 PresetBag 동작 그대로 유지

**재검토 조건 (Option C 활성화 트리거)**:
- user가 v1/v2 사용 후 "중간 폭 조절 필요" 명시적 요청
- 또는: 다수 entity 관리 시 2-state만으로 부족하다는 사용성 데이터 확보
- → ADR-003의 Status: Superseded, 후속 ADR 신규

**Trade-offs**:
- (+) Ambient 철학 일관성, 구현 단순, Pan Immersion과 역할 분리 명확
- (-) power user 커스터마이징 한계 (다만 설계 목표가 "누구나 바로 쓰는 ambient"이므로 trade-off 허용)

## References

- `references/anytype/src/ts/component/sidebar/left.tsx:L89-205`
- `ideas/brainstorming/DESIGN_SYSTEM_SPEC.md` §7-3 (L228-265 PresetBag)
- `src/renderer/src/components/edges/PresetBag.tsx` (현행 구현)
- Pan Immersion Mode v1 — Task #13 (2026-04-13)
- ADR-002 (anytype 🔴 Red 분류 근거)
- shelf-review-agent 1라운드 anytype 리뷰 Pattern 2 (2026-04-13)
