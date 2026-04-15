# 001. Canvas Library Reference

**Status**: Decided
**Date**: 2026-04-13 (Decided 2026-04-13 — 유저 승인)
**Deciders**: egdesk-pm-agent, Session Lead, User
**Related SPEC**: `DESIGN_SYSTEM_SPEC.md` §9-1 (Superseded v1, Canvas Toolbar integrated into Dock per ADR-004), §9-3 (placeholder — Canvas Entity Coordinate System)
**Related ADR**: ADR-004 (Canvas Tools Integration into Dock) — reframes NodeToolbar pattern reception

## Context

EG-Desk는 **Infinite Canvas 기반 ambient workspace**를 구축한다 (`docs/vision/ontology-bridge.md` §2.3 "책상(Desk) = Canvas + WebContentsView"). 구현에 필요한 핵심 메커니즘:

1. **Pan / Zoom** — 무한 캔버스 이동 및 확대/축소
2. **Viewport transform** — entity 좌표계와 화면 좌표계 동기화 (proximity=relevance 규칙, SPEC §7-4 L300-306)
3. **Canvas Toolbar** — ~~§9-1 별도 floating 도구모음~~ → **Dock 중앙 그룹으로 통합** (ADR-004 per 2026-04-13 유저 지시). 4 도구: Pencil / Hand / Square / Arrow. 별도 floating layer 폐기
4. **빈 캔버스 배경** — 종이 질감 (`paper-surface` noise, grid 금지 §9 L346)
5. **Canvas entity rendering** — 향후 entity 시스템 도입 시 viewport 내 DOM 포털

질문: 이 메커니즘들을 **외부 라이브러리로 import**할지, **개념만 차용하고 자체 구현**할지, **scratch부터**할지 결정 필요.

근거 조사:
- `references/xyflow/` (MIT) 1라운드 리뷰 (shelf-review-agent, 2026-04-13)
- `references/anytype/` (ASAL 1.0) 1라운드 리뷰 (동일)

## Options Considered

### Option A — `@xyflow/react` 전체 import

- **Pros**:
  - Pan/Zoom 즉시 작동 (d3-zoom wrapper 검증됨)
  - ViewportPortal, Panel, Background, NodeToolbar 패턴 모두 포함
  - MIT 라이선스 (상업적 사용 가능, ADR-002 참조)
  - 활발한 유지보수 (2026-03-27 최근 커밋, PR #5731)
- **Cons**:
  - **node-graph 전제**: ConnectionLine, EdgeWrapper, Handle 등 **EG-Desk에 불필요한 의존성** 대량 포함
  - EG-Desk는 "node 간 edge 연결" 패러다임이 아님 (객체/장소 2축, edge 개념 없음)
  - Panel position system(top/bottom + center 6 variant)이 **4-Edge Framework와 철학 충돌** (SPEC §7 확정)
  - Background grid 3 variant (Dots/Lines/Cross) 모두 **"격자 금지" 원칙 위반** (SPEC §9 L346)
  - bundle size 증가 (node-graph 로직 dead code)
- **License**: MIT — 코드 직접 포팅 허용
- **Verdict**: ❌ Rejected — 철학적으로 맞지 않는 부분이 과반. node-graph 제거 후 사용 시 유지보수 비용이 자체 구현보다 큼.

### Option B — xyflow **개념 차용** + 자체 구현

- **Pros**:
  - 필요한 4 패턴만 취사선택: **Pan/Zoom wrapper**, **ViewportPortal**, **Background(grid 없이 paper-surface)**, **NodeToolbar(Canvas Toolbar)**
  - 불필요한 node-graph 코드 제거
  - EG-Desk 4-Edge Framework + Ontology Bridge 철학에 맞춰 자체 API 설계
  - MIT 라이선스라 **코드 참고 1줄 복사도 허용** (ADR-002)
- **Cons**:
  - 초기 구현 비용 (d3-zoom wrapper만 ~300 LOC 수준)
  - xyflow 업스트림 개선 자동 반영 불가 (수동 추적)
- **License**: MIT (code reference allowed)
- **Verdict**: ✅ **Accepted** — 아키텍처 통제권 유지 + 철학 정합성 + 라이선스 안전

### Option C — `infinite-canvas` 라이브러리 (별도 평가 필요)

- **Pros**: 베어 캔버스 구현만 제공, node-graph 의존 없음
- **Cons**: shelf-review-agent 미분석. API/활성도/라이선스 미확인
- **License**: 미확인
- **Verdict**: ⏳ **Deferred** — 차기 세션에서 shelf-review-agent 분석 후 재검토. 현재 Option B가 우세하므로 이 평가는 낮은 우선순위.

### Option D — Scratch (d3-zoom 직접 사용)

- **Pros**: 최대 flexibility, 의존성 최소
- **Cons**: d3-zoom 통합 패턴을 처음부터 설계해야 함. xyflow가 이미 검증한 패턴 무시
- **Verdict**: ❌ Rejected — Option B (xyflow 패턴 차용)이 d3-zoom 사용 방식을 이미 검증했으므로 scratch는 불필요한 reinvent.

## Decision

**xyflow의 4 패턴을 개념 차용하여 자체 구현한다. `@xyflow/react` 의존성은 추가하지 않는다.**

채택 범위:
| 패턴 | 채택 시점 | 출처 파일 (개념 참고) |
|------|----------|---------------------|
| **d3-zoom wrapper** (Pan/Zoom) | v1 Canvas 진입 시 | `references/xyflow/packages/system/src/xypanzoom/XYPanZoom.ts` |
| **ViewportPortal** | Canvas entity 시스템 도입 시 | `references/xyflow/packages/react/src/components/ViewportPortal/index.tsx` |
| **Dock center-group icon 패턴** (xyflow NodeToolbar 패턴 reframe per ADR-004) | ✅ **구현됨 (2026-04-13)** — `Dock.tsx` 중앙 그룹 4 state-toggle 아이콘 (Pencil/Hand/Square/Arrow). NodeToolbar 의 "floating per-node toolbar" 컨셉 대신 "Dock 내부 상시 상주 state-toggle" 로 수렴 | `references/xyflow/packages/react/src/additional-components/NodeToolbar/` (개념 참고만, Canvas Toolbar 별도 layer 채택 안 함) |
| **Background (paper-surface 기반)** | 이미 구현됨 | `src/renderer/src/styles/globals.css L79-83` — **xyflow Background.tsx는 차용 안 함** (grid 금지) |

영구 비채택 (Anti-patterns):
- `Handle`, `EdgeWrapper`, `ConnectionLine`, `MarkerDefinitions` — **node-graph 전제**: EG-Desk는 객체/장소 2축 ontology라 "node 간 edge 연결" 패러다임 부재 (`docs/vision/ontology-bridge.md` §2.2 L218-233)
- `Panel` position system (6 variant: top-left/top-center/top-right/bottom-*) — **4-Edge Framework 확정 상태와 철학 충돌** (SPEC §7 DeskRail/Dock/PresetBag/ContextualHUD 4방향 고정 의미론). xyflow Panel을 사용하면 의미론 중복 + 시각 간섭 발생
- `Background` Dots/Lines/Cross variant — **"격자 금지" 원칙 위반** (SPEC §9 L346 "격자 표시 안 함", §10-2 L597 FORBIDDEN). 또한 `.paper-surface` fractalNoise 텍스처(globals.css L79-83)와 시각적 충돌
- 전체 `@xyflow/react` npm 의존성 — node-graph 로직 dead code + 철학 충돌 코드 bundle 포함 불가

## Consequences

**즉시 (v1)**:
- ~~Canvas Toolbar 별도 component (`CanvasToolbar.tsx`) 구현~~ — **ADR-004로 무효화**. Canvas tools (Pencil/Hand/Square/Arrow) 는 `Dock.tsx` 중앙 그룹에 state-toggle 아이콘으로 직접 구현 (design-agent 완료 2026-04-13). xyflow NodeToolbar 패턴은 "아이콘 상시 상주 + active state toggle" 컨셉 차원에서만 참고
- **SPEC §9-3 "Canvas Entity Coordinate System" placeholder 작성 완료** (Task #15 스코프): ViewportPortal 개념 스텁 + 본 ADR-001 참조 링크. 엔티티 시스템 실구현은 후속 단계
- `package.json`에 `@xyflow/react` 추가 금지 (coding-agent 주의)
- Panel/Background variant 사용 의도 발견 시 coding-agent가 PM에게 flag

**Canvas entity 시스템 도입 시**:
- ViewportPortal 패턴 구현 필요 (`createPortal` + viewport transform 동기화)
- d3-zoom wrapper 구현 (xyflow `XYPanZoom.ts` 참고)

**Trade-offs**:
- (+) 아키텍처 통제, 철학 정합성, bundle 크기 최소화
- (-) xyflow 업스트림 개선 수동 추적 필요

**후속 ADR 예정**:
- Canvas entity 시스템 아키텍처 확정 시 ADR-NNN "Canvas Entity Model"
- infinite-canvas 라이브러리 평가 완료 시 ADR-NNN "Alternative Canvas Library Evaluation"

## References

- `references/xyflow/LICENSE` (MIT, "Copyright (c) 2019-2025 webkid GmbH")
- `references/xyflow/packages/react/src/components/ViewportPortal/index.tsx:L34-42`
- `references/xyflow/packages/system/src/xypanzoom/XYPanZoom.ts:L36-72`
- `ideas/brainstorming/DESIGN_SYSTEM_SPEC.md` §9-1 v1 (L348-461, **Superseded by ADR-004**), §7-2 v2 Dock layout (Canvas tools in center group), §9 L346 (격자 금지)
- `.claude/docs/decisions/004-canvas-tools-integration-into-dock.md` (ADR-004, Canvas tools Dock 통합 결정)
- `docs/vision/ontology-bridge.md` §2.2 (L218-233) 객체/장소 2축
- shelf-review-agent 1라운드 xyflow 리뷰 (2026-04-13 세션)
- ADR-002 (라이선스 정책)
