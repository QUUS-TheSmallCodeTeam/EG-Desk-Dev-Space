# Decision Archive (ADR)

EG-Desk 프로젝트의 아키텍처/기술/UX 결정 기록. 외부 레퍼런스, 라이브러리, 라이선스, UX 패턴, 기술 스택 선택에 대한 근거와 거절된 대안을 ADR 포맷으로 보관한다.

## 운영 원칙

- 별도 log 없음. 각 ADR의 `Options Considered` 섹션에 거절된 대안과 이유를 함께 기록한다.
- Status 변경 시 원 파일 수정 (append-only 아님). `Superseded` 전환 시 후속 ADR 번호를 명시.
- 네이밍: `NNN-kebab-case-title.md` (3자리 zero-padded)

## Status 정의

| Status | 의미 |
|--------|------|
| **Proposed** | 초안. PM이 작성, Session Lead/User 승인 전 |
| **Decided** | 유저 승인 완료. 구현/준수 대상 |
| **Superseded** | 후속 ADR로 대체됨. "Superseded by ADR-NNN" 명시 |
| **Deprecated** | 더 이상 유효하지 않음. 배경만 보존 |

## 작성 워크플로우

1. **번호 예약 먼저**: 새 ADR 작성 전에 INDEX.md의 Index 테이블에 항목을 **먼저 append** (Status: Proposed). 번호 충돌 방지 (병렬 작성 시 원자적 확보).
2. **본문 작성**: `NNN-kebab-case-title.md` 생성. 포맷 엄수 (Context / Options Considered / Decision / Consequences / References).
3. **Options Considered 의무**: 최소 2개 대안 + 각 Pros/Cons/License/Verdict. 거절된 대안 이유는 본 섹션에 기록 (별도 log 없음).
4. **Related SPEC 단방향 링크**: ADR → SPEC만 링크. SPEC 본문에 ADR 링크 역참조는 추가하지 않음.
5. **Status 전환**: Proposed → Decided 전환 시 유저 승인 필요. PM이 단독 결정 금지.
6. **Superseded 처리**: 후속 ADR 작성 후, 구 ADR의 Status를 `Superseded by ADR-NNN`으로 변경. 구 파일 삭제 금지 (배경 보존).

## Index

| # | Title | Status | Date | Related SPEC |
|---|-------|--------|------|--------------|
| 001 | [Canvas Library Reference](001-canvas-library-reference.md) | Decided | 2026-04-13 | §9-1 (Superseded v1), §9-3 (placeholder), ADR-004 |
| 002 | [External Reference License Policy](002-external-reference-license-policy.md) | Decided (v2 — 2-tier) | 2026-04-13 | technology-stack.md §9 |
| 003 | [Electron Sidebar Drag-Resize UX Reference](003-electron-sidebar-drag-resize-ux.md) | Decided | 2026-04-13 | §7-3 |
| 004 | [Canvas Tools Integration into Dock](004-canvas-tools-integration-into-dock.md) | Decided | 2026-04-13 | §7 Edge 정렬/너비 정책 (v2), §7-1 (v2, 중앙 anchor), §7-2 (v2, content-aware width), §7 L316 (v2), §9-1 (Superseded v1), §10-2 designMd (v2) |
| 005 | [PresetBag Interaction Pattern (Mini-map + Click Semantics)](005-presetbag-interaction-pattern.md) | Decided (좌클릭 TBD) | 2026-04-13 | §7-3 (v2 확장) |
| 006 | [Canvas Entity Foundation v1 (BLOCKER)](006-canvas-entity-foundation.md) | Decided (v2) · Phase 1 MVP implemented 2026-04-13 | 2026-04-13 | §7-4 HUD/Entity 이중모드, §9-3 (placeholder → v1 명세), §8 카드 3-state |

## 예정 (다음 세션)

- **Entity type ADRs (ADR-007+) — FIFO lazy addition** (ADR-006 §5.11). Browser / IDE / Chat / File Preview / Gadget 등 유저 요청 순서대로 개별 ADR + adapter 추가. Pre-priority 없음.
- **Overlay / Edge customization ADR (shelf-review-agent 2라운드 결과 기반)** — Surf `Overlay=별도 BrowserWindow` 채택 여부, Edge position 런타임 전환 여부
- **Immersion Levels Framework ADR (zen-browser 2라운드)** — L0 Ambient / L1 Pan / L2 Compact / L3 Full-screen 4단계 공식화
- **Glance Interaction Pattern ADR (zen-browser)** — modifier+click temporal preview vs persistent HUD 구분
- **WM Top 3 (electrobun / copilotkit / atomic) 리뷰 ADR** — 별도 세션
- **Canvas Tools Dock 통합 2라운드 ADR** — v2 체감 이후 mode 분리 필요성 재평가 (active drawing mode vs quick switch)
