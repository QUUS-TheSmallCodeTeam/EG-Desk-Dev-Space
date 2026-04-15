# 005. PresetBag Interaction Pattern — Mini-map Preview + Click Semantics

**Status**: Decided
**Date**: Decided 2026-04-13 — 유저 승인 (좌클릭 placeholder 유지 — 별도 후속 결정)
**Deciders**: egdesk-pm-agent, Session Lead, User
**Related SPEC**: `ideas/brainstorming/DESIGN_SYSTEM_SPEC.md` §7-3 (Left Edge — Preset Bag, v2 확장)
**Related ADR**: ADR-006 (Canvas Entity Foundation — "최근 unpack 위치" state 저장 인프라 의존 가능성)

---

## Context

EG-Desk Preset Bag (§7-3)은 **여러 entity 조합(파일+탭+앱+가젯)을 프리셋으로 저장**하고, 한꺼번에 캔버스에 쏟는 "출근 가방" 은유를 구현한다. 기존 SPEC은 아래 인터랙션만 정의했다:

- **Pack** (캔버스 → 가방): 드래그 다중 선택 → Left Edge 드롭 → 프리셋 저장 (§7-3 L312)
- **Unpack** (가방 → 캔버스): 프리셋 드래그 → 캔버스 드롭 → 저장 배치대로 렌더 (§7-3 L313)
- **클릭**: "프리셋 내용 미리보기" (§7-3 L304, **모호함**)

2026-04-13 유저 지시 요점:

> "presetbag 은 아이콘이 모양새는 다 동일해야 함. hover 하면 그 preset 에 대한 mini map 이 마우스 위치에 나타나서 어떤 식으로 배치된 entity 들인지 알 수 있어야 함."

추가 결정사항:
- Mini-map 위치: **아이콘 오른쪽 popover 고정** (옵션 B)
- Mini-map 스타일: **static image (screenshot)** (옵션 C)
- Hover delay: **200ms**
- 우클릭: **element 목록 context menu**
- 좌클릭: **보류** — preset edit 정책 (draft vs immediate update) 결정 의존

본 ADR 은 위 지시들을 공식화하고, 좌클릭 의미는 placeholder 로 남긴다.

---

## Options Considered

각 옵션은 ① mini-map hover 모델, ② 좌클릭 의미 두 축으로 나뉜다.

### 축 1 — Mini-map Hover 위치 (결정됨)

#### Option 1A — Cursor-follow (마우스 위치 popover)

**설명**: Popover 가 마우스 커서를 따라 이동.

**Pros**:
- 시선 이동 최소화 (hover 한 곳 ≈ 미리보기 위치)

**Cons**:
- Preset Bag 접힌 상태(48-56px) 좌측 edge 와 겹쳐 시각적 혼란
- 아이콘 hit target 이동 시 popover 깜빡임
- 위치가 유동적이라 포인터-to-preview 관계 파악 어려움

**Verdict**: **Rejected** — 유저 선택 B.

#### Option 1B — 아이콘 오른쪽 popover 고정 ✅ **Selected**

**설명**: Preset icon 의 right 기준 +8px offset, vertical center 정렬. Popover 너비 약 240-280px, height 120-160px. Tailwind: `absolute left-full ml-2 top-1/2 -translate-y-1/2`.

**Pros**:
- Preset Bag 접힌 상태에서 캔버스 영역에 자연스럽게 진입
- 복수 preset hover 시 popover 위치 예측 가능
- Edge ontology 유지 (Left Edge 부속처럼 보임)

**Cons**:
- Mini-map 이 캔버스 상단 카드와 겹칠 가능성 → z-index L3 확정 필요

**Verdict**: **Selected** — 유저 확정. 시각적 안정성 최우선.

#### Option 1C — Preset Bag 중앙 panel

**설명**: Preset Bag 내부 상단/하단에 공용 preview panel.

**Pros**:
- 위치 고정, 시선 혼란 없음

**Cons**:
- 공용 슬롯이라 여러 preset 비교 불가
- Preset Bag 높이 압박

**Verdict**: **Rejected**.

### 축 2 — Mini-map 시각 스타일 (결정됨)

#### Option 2A — Canvas snapshot (runtime rendered)

**설명**: Hover 시점에 entity 실제 배치를 canvas 로 렌더 (mini-scale).

**Pros**: 최신 상태 반영. Cons: 렌더 비용 (특히 suspended entity 는 snapshot 없으면 불가).
**Verdict**: **Rejected** — ADR-006 lifecycle 상 suspended 시 이미 screenshot 있으므로, runtime render 불필요.

#### Option 2B — Layout grid (wireframe)

**설명**: 단순 박스 레이아웃만 표시 (proportional rectangles).

**Pros**: 가볍다. Cons: 시각적 구분 약함.
**Verdict**: **Rejected** — screenshot 보다 정보량 적음.

#### Option 2C — Static image (saved screenshot) ✅ **Selected**

**설명**: Preset 저장 시점에 entity 레이아웃 screenshot 캡처 → Preset 메타에 저장 (PNG or compressed JPG, max 640×400). Hover 시 즉시 표시.

**Pros**:
- 즉시 렌더 (비용 없음)
- ADR-006 screenshot capture 인프라 재사용 가능
- Preset 식별성 높음 (실제 배치 모습)

**Cons**:
- Pack 시점 이후 entity 내용이 변해도 mini-map 은 반영 안 됨 (draft/immediate update 정책에 따라 재캡처 타이밍 다름)
- 저장 공간 (preset 당 ~30-80KB)

**Verdict**: **Selected** — 유저 확정. 성능+식별성 최우선.

### 축 3 — 좌클릭 의미 (보류)

#### Option 3A — Spread to Right HUD

**설명**: 좌클릭 → Right HUD 패널에 대형 preview + element 목록 + Unpack 버튼.

**Pros**:
- Dock click → Right HUD 패턴 (§7-4 L351-356) 과 일관
- HUD 에서 액션 가능 (unpack/edit/delete)
- Mini-map hover (quick glance) vs HUD (액션 가능) 역할 분리 명확

**Cons**:
- Mini-map 이미 preview 제공 → HUD 정보 중복 우려
- Preset edit 정책 미정이면 "HUD 에서 편집" 동작 구체화 불가

**SPEC 정합**: §7-4 HUD 패턴 준수.

#### Option 3B — Goto + Spread fallback

**설명**: 해당 preset 이 "최근 unpack 위치" 에 있으면 viewport 이동(goto), 없으면 3A 동작.

**Pros**:
- 유저 직관 부합 ("bag 이 렌더된 곳으로 이동?")
- Preset 을 "현재 작업 중" / "보관 중" 으로 암시적 구분

**Cons**:
- "Preset 최근 unpack 위치" state 추적 필요 (ADR-006 의존 가능성)
- Unpack 후 entity 가 흩어지면 "묶음 중심" 개념 모호

**SPEC 정합**: §7-3 확장 필요.

#### Option 3C — Immediate unpack shortcut

**설명**: 좌클릭 = viewport 중앙에 즉시 unpack (드래그드롭 대체).

**Pros**: 빠른 실행. **Cons**: 드래그드롭 우연성 충돌, "미끄러져 unpack" 위험.
**Verdict**: **Rejected**.

#### Option 3D — Preset Bag 전체 expand toggle

**설명**: 좌클릭 = Preset Bag 접힌 48-56px → 펼친 280px 전환.

**Pros**: §7-3 L290 "펼친 상태" 정합. **Cons**: 개별 preset 액션이 아닌 bag 전체 상태 변경 → 아이콘별 의미 희석.
**Verdict**: **Rejected** — 전체 expand 는 별도 trigger (Bag 상단 토글 버튼 등) 권장.

#### Verdict (축 3): **보류**

좌클릭 의미는 **Preset Edit 정책** 결정 후 확정. 구체적으로:

- **Draft mode 채택 시**: 좌클릭 = "편집 세션 진입" (3A 의 variant — HUD 에 편집 UI + Save/Discard)
- **Immediate update 채택 시**: 좌클릭 = 3A (Spread to HUD) or 3B (Goto) — draft 상태 없으므로 단순 preview
- **현재 단계**: placeholder 로 §7-3 에 "미결정" 명시

---

## Decision

### 확정 사항 (유저 승인)

1. **Preset 아이콘 디자인 통일** (§7-3 v2)
   - 모든 preset 아이콘은 동일 chip 모양 (Primary color background + initials or number badge)
   - 식별은 **이름 tooltip + mini-map preview** 로 수행
   - 이유: preset 내용은 동적 조합, 개별 시각 identifier 불필요

2. **Hover → Mini-map popover** (축 1B + 축 2C)
   - 위치: 아이콘 right +8px, vertical center (`absolute left-full ml-2 top-1/2 -translate-y-1/2`)
   - 스타일: Static image (저장된 screenshot, max 640×400, compressed JPG)
   - Delay: **200ms** (의도 없는 mouseover 필터링)
   - z-index: L3 (Edge System 레이어)
   - Popover frame: frosted glass 동일 스타일 + 1px outline + 12px border-radius
   - Mini-map 상단 캡션: preset 이름 + entity 개수 ("예: 'React 개발' · 5 items")

3. **우클릭 → Element list context menu**
   - Menu 내용: 포함된 entity 목록 (아이콘 + 이름), 빠른 참조 전용 (액션 X)
   - 액션(편집/삭제/rename)은 Spread HUD 또는 별도 편집 트리거에서

4. **Screenshot 생성 시점**
   - **Pack 시점**: 선택된 entity 들이 캔버스 상 배치된 bounding box 영역을 screenshot
   - **Re-pack / Update**: preset edit 정책 확정 후 타이밍 결정

### 보류 사항 (user 확정 대기)

5. **좌클릭 의미** — `TODO(ADR-005 v2 or 신규 ADR)`
   - 종속 결정: Preset Edit 정책 (draft mode vs immediate update)
   - 유력 후보: Option 3A (Spread to HUD) 또는 3B (Goto + 3A fallback)
   - §7-3 v2 SPEC 에 "미결정 — draft vs immediate update 정책 결정 후 확정" 명시

---

## Consequences

### Positive

1. **인터랙션 계층 분리**: Hover(미리보기) / 좌클릭(액션 진입) / 우클릭(빠른 참조) / 드래그(Pack/Unpack) 4 축 명확히 구분.
2. **아이콘 통일**: 시각 디자인 단순화. design-agent 가 개별 아이콘 파일 관리 부담 없음.
3. **Screenshot 재사용**: ADR-006 suspended entity screenshot 인프라와 같은 capture 메커니즘 공유 가능.
4. **§7-4 HUD 패턴 일관성**: 좌클릭 확정 시 Dock click → HUD 와 동일 행위 패턴 가능.

### Negative

1. **좌클릭 미결**: Preset 주 액션(어떻게 "쓸까") 이 확정 안 됨 → 유저가 preset 을 활용하려면 드래그드롭만 사용 가능 (v1 한계).
2. **Screenshot 동기화 부담**: Entity 내용 변경 시 preset mini-map 과 실제 내용 괴리 가능. Re-capture 정책 미확정.
3. **Preset edit 정책 블로커**: 좌클릭 확정 위해서는 별도 결정 사이클 필요.

### Neutral

4. **ADR-006 의존 가능성**: Screenshot capture 메커니즘이 ADR-006 lifecycle screenshot 과 통합되면 중복 제거. ADR-006 초안에 해당 hook 포함 예정.

---

## Implementation Phases

### Phase 1 — 확정 사항 구현 (즉시 가능)

1. **Preset 아이콘 통일** (design-agent)
   - 기존 개별 아이콘 제거 → Primary chip + initials/number 통일 컴포넌트
   - **참고**: 2026-04-13 design-agent 이미 구현 완료 (Task #22)

2. **Mini-map popover hover** (coding-agent)
   - `Preset.tsx` 에 hover 200ms delay + popover 렌더
   - Popover = screenshot `<img>` + 이름 + entity 개수 캡션
   - z-index L3, frosted glass frame

3. **Pack 시 screenshot capture** (coding-agent)
   - Pack 완료 직후 선택 entity bounding box 영역 screenshot (html-to-image / canvas API)
   - Preset data model 에 `previewSnapshot: Blob | string (data URL)` field 추가
   - 저장: preset JSON + base64 data URL or file path

4. **우클릭 context menu** (coding-agent)
   - 네이티브 `contextmenu` event → custom menu 컴포넌트 (frosted glass)
   - Menu 항목: entity list (아이콘 + 이름, read-only)

### Phase 2 — 좌클릭 확정 후

5. 좌클릭 확정 (user + PM + design-agent 재검토)
6. Option 3A or 3B 구현

---

## SPEC Update Plan (§7-3 v2)

### §7-3 Preset Bag — 프리셋 구조 테이블 업데이트

```markdown
| 요소 | 설명 |
|------|------|
| 프리셋 목록 | 저장된 조합 프리셋 리스트. **모든 프리셋 아이콘 디자인 통일 (Primary chip + initials, v2)**. |
| 프리셋 내용 | 해당 프리셋에 포함된 entity 목록. Hover mini-map popover 로 시각 확인 (v2). |
| (+) 새 프리셋 | 빈 프리셋 생성 또는 Pack 으로 생성 |
```

### §7-3 신규 섹션: 프리셋 아이콘 인터랙션 (v2)

```markdown
#### 프리셋 아이콘 인터랙션 (v2, ADR-005)

| 인터랙션 | 동작 | Status |
|----------|------|--------|
| Hover 200ms | 아이콘 오른쪽 popover (static screenshot, 240-280×120-160px) | 확정 |
| 좌클릭 | **미결정** — draft vs immediate update 정책 결정 후 확정 | 보류 |
| 우클릭 | Element 목록 context menu (빠른 참조, 액션 없음) | 확정 |
| 드래그 to 캔버스 | Unpack (기존) | 확정 |
| 드래그 from 캔버스 | Pack (기존) | 확정 |

#### 아이콘 디자인 (v2)

- 모든 preset 아이콘 = 동일 chip shape + Primary color background + initials/number
- 이유: preset 은 동적 entity 조합, 개별 시각 identifier 불필요
- 구분: 이름 (tooltip + mini-map 캡션) + mini-map preview

#### Mini-map Popover

- 위치: 아이콘 right +8px, vertical center
- 스타일: static screenshot (Pack 시점 캡처) + frosted glass frame + 1px outline + 12px radius
- 크기: 240-280×120-160px
- z-index: L3
- 캡션: preset 이름 + entity 개수
```

---

## References

- `DESIGN_SYSTEM_SPEC.md` §7-3 (Preset Bag), §7-4 (Right HUD 패턴 참조), §8 (카드 3-state)
- ADR-004 (Canvas Tools Integration into Dock — Dock/HUD 인터랙션 패턴 선례)
- ADR-006 (Canvas Entity Foundation — screenshot capture 인프라 공유)
- 유저 지시 원문 (2026-04-13):
  > "presetbag 은 아이콘이 모양새는 다 동일해야 함. hover 하면 그 preset 에 대한 mini map 이 마우스 위치에 나타나서 어떤 식으로 배치된 entity 들인지 알 수 있어야 함."
  > "preset bag 을 canvas 에 드래그드롭 후 추가 element 수정/삭제 시 draft 모드 vs 즉시 업데이트 결정이 안 됐음. 좌클릭 의미는 그 결정에 의존."
