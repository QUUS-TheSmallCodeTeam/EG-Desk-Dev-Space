# 006. Canvas Entity Foundation v1 — Entity-Agnostic Infrastructure (BLOCKER)

**Status**: Decided
**Date**: Decided 2026-04-13 — 유저 승인 (v2: viewport-based + 중심점 기준 반영)
**Deciders**: egdesk-pm-agent, Session Lead, User
**Related SPEC**: `ideas/brainstorming/DESIGN_SYSTEM_SPEC.md` §9-3 (Placeholder → v1 명세), §7-4 (HUD/Entity 이중 모드), §8 (카드 3-state L0-L3), §7-2 (Dock 드래그드롭 trigger)
**Related ADR**: ADR-001 (xyflow 개념 차용 근거), ADR-004 (Dock 객체축 호스팅), ADR-005 (screenshot capture 공유 인프라)
**Blocker for**: ADR-007+ (Browser Entity, IDE Entity, Chat Entity, File Preview Entity, etc.)

---

## Context

EG-Desk는 **Infinite Canvas + ambient entity** 모델 (`docs/vision/ontology-bridge.md` §2.3 "책상(Desk) = Canvas + WebContentsView") 을 지향한다. Canvas 위에 놓이는 모든 것 — 브라우저 탭, IDE 세션, 채팅 카드, 파일 프리뷰, 가젯 — 은 **entity** 로 통칭된다.

현재 상태:
- SPEC **§9-3 Canvas Entity Coordinate System** = Placeholder (L549-562). 설계 기조만 기록, 구체 API/state model/lifecycle 미정.
- §7-4 **HUD/Entity 이중 모드** (L351-356) 는 인터랙션 정의됐으나 **Entity 모드 구현 불가** (인프라 부재).
- Dock 좌측 그룹의 [Chat][Shelf][Browser][+] 는 **UI shell 만 있음** (click handler 없음, `Dock.tsx` L47). 드래그드롭 → Entity 생성 동작 불가.
- ADR-001 (Canvas Library Reference) 는 xyflow **ViewportPortal + d3-zoom 패턴 개념 차용** 결정했으나, 실제 entity rendering infrastructure 미구현.

2026-04-13 유저 지시 (Browser tab lifecycle 재활성 패턴):

> "새로 생성 시 바로 만들어야지. 대신 active 한 탭은 현재 뷰포트 기준으로만 액티브하게 하고 바깥으로 나간 애는 static image (screenshot) 으로 대체. 바깥에 나갔다가 다시 들어온 애도 바로 렌더링이 아니라 클릭하여 active 할 때 리로딩. Chrome 탭 재로딩 방식."

이 지시는 **Browser 전용 기능이 아닌 entity-agnostic lifecycle** 로 일반화되어야 한다 (Monaco IDE instance, PDF renderer 등 모두 메모리 무거움, 동일 패턴 이득).

본 ADR 은:
1. §9-3 Placeholder 를 v1 명세로 승격
2. Entity state model + lifecycle 규격화
3. Viewport intersection / screenshot capture / click-to-reload 메커니즘 확정
4. Dock → Canvas 드래그드롭 → entity 생성 API
5. §7-4 HUD/Entity 이중모드 구현 가능 상태로 전환

→ **본 ADR 은 Browser/IDE/Chat/File Entity 등 모든 entity type 의 블로커**. 승인되면 ADR-007+ 에서 type 별 구현 풀림.

---

## Options Considered

### 축 1 — Canvas 렌더 모델

#### Option 1A — xyflow ViewportPortal 패턴 차용 (self-implemented) ✅ Selected

**설명**: xyflow `packages/react/src/components/ViewportPortal/index.tsx` 참고. `createPortal` + viewport transform (translateX/Y/scale) 을 CSS transform 으로 일괄 적용하는 container 를 자체 구현. 각 entity 는 **canvas-space coordinate** 로 position 받고, viewport container 가 transform 동기화.

**Pros**:
- ADR-001 과 정합 (MIT 라이선스 개념 차용)
- xyflow 와 직접 의존성 없음 (portable, 유지보수 자율)
- Pan/zoom 시 entity 개별 recalculate 불필요 (container CSS transform 1회)
- WebContentsView / Monaco 등 **복합 iframe-like DOM** 도 통합 가능

**Cons**:
- `createPortal` 을 viewport container 에 걸면 React reconciliation 상 parent 와 분리 → context 전달 주의
- Safari transform-3d hardware acceleration 버그 histórico — CSS `will-change: transform` + `transform: translate3d` 조합 필요

**Verdict**: **Selected** — ADR-001 결정 연장, 구현 fidelity 높음.

#### Option 1B — xyflow 패키지 직접 import

**설명**: `@xyflow/react` 의존성 추가, ReactFlow 컴포넌트 사용.

**Pros**: 즉시 사용 가능, pan/zoom + minimap 무료. **Cons**:
- 번들 크기 증가 (ReactFlow 전체, edges/handles 등 불필요한 기능 포함)
- ReactFlow 의 node 모델 (id/data/type) 이 EG-Desk entity 모델과 불일치 가능성
- 커스터마이징 한계 (Edge System L3 overlay 와 충돌)

**Verdict**: **Rejected** — ADR-001 "개념 차용, 의존성 불가" 결정과 충돌.

#### Option 1C — Absolute positioning + manual transform

**설명**: 각 entity 가 자체 `position: absolute` + JS 로 pan/zoom 계산.

**Pros**: 단순. **Cons**: 수십 entity 시 recalculate 비용, transform 동기화 버그 가능성 높음.

**Verdict**: **Rejected** — 확장성 제약.

### 축 2 — Entity State Model

#### Option 2A — Discriminated union (flat type) ✅ Selected

```typescript
type EntityType = 'browser' | 'ide' | 'chat' | 'file-preview' | 'note' | 'gadget'
type EntityLifecycle = 'hydrated' | 'suspended' | 'static' | 'discarded'
type EntityDisplayState = 'covered' | 'spread' | 'full'

interface CanvasEntity<T extends EntityType = EntityType> {
  id: string                       // uuid
  type: T
  position: { x: number; y: number }   // canvas-space
  size: { w: number; h: number }
  zIndex: number                   // stacking within canvas
  lifecycle: EntityLifecycle
  displayState: EntityDisplayState
  snapshot?: string                 // screenshot data URL (suspended/static 시 필수)
  createdAt: number
  lastActiveAt: number
  typeProps: EntityTypePropsMap[T]  // type-specific extension point
}

interface EntityTypePropsMap {
  browser: { url: string; webContentsViewId?: string; title?: string; favicon?: string }
  ide: { sessionId: string; openFiles: string[]; language?: string }
  chat: { conversationId: string; agentConfig?: object }
  'file-preview': { filePath: string; mime: string; pageIndex?: number }
  note: { content: string; format: 'plaintext' | 'markdown' }
  gadget: { gadgetId: string; config: object }
}
```

**Pros**:
- Type-safe (TypeScript discriminated union)
- Entity-agnostic 핵심 필드 + type-specific props 분리
- Serializable (persistence 용이)
- New type 추가 = `EntityType` union + `EntityTypePropsMap` 확장만

**Cons**:
- Type 확장 시 union 수정 필요 (type-erased plugin 모델은 아님)
- `typeProps` 은 type 마다 다르므로 reducer 분기 필요

**Verdict**: **Selected** — TypeScript 강점 + 명시성 > 플러그인 유연성.

#### Option 2B — Class hierarchy (OOP)

```typescript
abstract class Entity { abstract render(): JSX.Element }
class BrowserEntity extends Entity { ... }
```

**Pros**: 객체지향 친숙. **Cons**: React functional 모델과 충돌, serialization 복잡, hot-reload 약함.

**Verdict**: **Rejected**.

#### Option 2C — Bag of properties (untyped)

**설명**: `{ type: string, props: any }`.

**Pros**: 유연. **Cons**: Type safety 소실, 유지보수 어려움.

**Verdict**: **Rejected**.

### 축 3 — Lifecycle 관리 위치

#### Option 3A — Central supervisor (EntityLayer level) ✅ Selected

**설명**: Canvas 컴포넌트 하위 `EntityLayer` 컴포넌트가 모든 entity 의 lifecycle 을 supervise. Viewport intersection 계산 + hydration 결정 + screenshot capture 트리거.

**Pros**:
- 전역 정책 (memory budget, max hydrated count) enforce 용이
- Entity 는 자체 lifecycle 몰라도 됨 (dumb component)
- Testability (supervisor unit test 가능)

**Cons**:
- Supervisor 가 grow over time → 복잡도 집중

**Verdict**: **Selected** — 전역 정책 필수, 개별 entity 에 로직 분산 시 예측 불가.

#### Option 3B — Entity self-managed

**설명**: 각 Entity 컴포넌트가 자체 intersection observer + lifecycle 관리.

**Pros**: 독립성. **Cons**: 전역 memory budget 적용 불가, 동일 로직 중복.

**Verdict**: **Rejected**.

### 축 4 — Pan/Zoom 구현

#### Option 4A — d3-zoom wrapper pattern (xyflow XYPanZoom.ts 차용) ✅ Selected

**설명**: d3-zoom 으로 pan/zoom gesture 처리 + viewport state (x, y, scale) 관리. xyflow `XYPanZoom.ts` 패턴 참고 (MIT 개념 차용).

**Pros**:
- Trackpad pan/pinch-zoom / mouse wheel / touch gesture 검증된 로직
- Bounds/constraints/minZoom/maxZoom 지원
- xyflow 의존성 없이 d3-zoom (^3) 직접 사용 가능

**Cons**: d3-zoom 자체는 MIT 이나 bundle 추가 (~20KB gzipped).

**Verdict**: **Selected** — 바닥부터 구현 시 gesture edge case 많음. d3-zoom 은 검증된 표준.

#### Option 4B — 자체 pointer event 구현

**Pros**: 의존성 0. **Cons**: Trackpad pinch / momentum scroll 구현 부담.

**Verdict**: **Rejected** — 투자 대비 효용 낮음.

### 축 5 — Performance Budget 정책

#### Option 5A — Viewport-based (단일 룰, cap 없음) ✅ Selected

**설명**: Viewport intersection 이 lifecycle 을 결정하는 유일한 기준. Viewport 안 = hydrated 전부, viewport 밖 + dwell = suspended/static, static → hydrated 는 click 만. Hard cap 없음.

**Pros**:
- 유저 멘털 모델과 일치 — "보이는 건 live, 안 보이는 건 이미지, 쓰려면 클릭". 1-line rule 로 설명 가능.
- 유저 명시 확정 (2026-04-13): "viewport 안에 있는거는 살려야지"
- Chrome tab discard UX 와 동일 → 유저 사전 학습된 패턴
- Forced suspend 로 인한 "의도치 않게 kill 당함" 불만 제거

**Cons**:
- 극한 zoom-out (scale 매우 작음) + 수백 entity viewport 동시 진입 시 메모리 급증 가능. → v2 density threshold 로 완화 예정.
- Hydrated count 를 알고리즘적으로 bound 불가 → monitoring 필요.

**Verdict**: **Selected** — 유저 피드백 반영 (v1 scope 내 예측 가능성 > 방어적 hard cap).

#### Option 5B — Max hydrated cap + LRU forced suspend (Rejected)

**설명**: 동시 hydrated 개수 제한 (예: 4) + 초과 시 LRU 로 강제 suspend.

**Pros**: Memory usage 상한 보장, 저사양 기기 안전.

**Cons**:
- **유저 rejection 원문**: "viewport 안에 있는거는 살려야지" (2026-04-13)
- Viewport 안에 5+ entity 보일 때 일부가 정적 이미지로 바뀜 = 멘털 모델 파괴
- "가장 오래 안 쓴 거" 기준이 유저 관점에서 불투명 (예측 불가)

**Verdict**: **Rejected** — 유저 피드백으로 거부.

#### Option 5C — Entity-type 별 budget (Deferred)

**설명**: Browser 는 max N, IDE 는 max M 식으로 type 별 cap.

**Pros**: 세밀한 제어. **Cons**: 정책 복잡성 폭증, v1 scope 초과.

**Verdict**: **Deferred to v2/v3** (type-specific ADR 에서 재검토).

---

## Decision

### 5.1 렌더 모델 (축 1A)

Canvas structure:

```
<Canvas>                             ← viewport container (d3-zoom target)
  <ViewportContainer                 ← CSS transform: translate(x, y) scale(s)
    style={{ transform: `translate(${x}px, ${y}px) scale(${scale})` }}>
    <EntityLayer>                    ← Option 3A supervisor
      <Entity ... />                 ← canvas-space position
      <Entity ... />
      ...
    </EntityLayer>
    <OverlayLayer />                 ← 선택 박스, snap guides 등 (추후)
  </ViewportContainer>
</Canvas>
```

- Canvas = L0 surface (`paper-surface` 배경)
- ViewportContainer = pan/zoom 적용 단일 layer (GPU-accelerated)
- EntityLayer = supervisor, viewport intersection 계산
- Entity = individual render (canvas-space position)

### 5.2 Entity State Model (축 2A)

§ Options 2A 코드 블록 참조. 핵심 불변식:
- **Canvas-space coordinate**: Entity `position` 은 canvas 고정 좌표 (viewport transform 무관)
- **Serializable**: 모든 필드 JSON 직렬화 가능 (persistence)
- **Lifecycle vs DisplayState 분리**:
  - `lifecycle` = 메모리 상 상태 (hydrated/suspended/static/discarded)
  - `displayState` = 시각 크기 상태 (covered/spread/full, §7-4 L351)

### 5.3 4-State Lifecycle

```
                     ┌─────────────────────────┐
                     ▼                         │
[create] → hydrated ─┤                         │
                     │                         │
     (viewport out + dwell timer N초 경과)     │
                     │                         │
                     ▼                         │
                 suspended ──(screenshot 저장)─┤
                     │                         │
                     ▼                         │
                 static (screenshot 표시)      │
                     │                         │
                (viewport in 만으로는 hydrate 안함)
                     │                         │
                (click or focus trigger)       │
                     │                         │
                     └─ hydrated ──────────────┘
                     
[delete] → discarded (메모리/screenshot 모두 해제)
```

**State 정의**:

| State | DOM 상태 | Memory 비용 | UI 표시 |
|-------|---------|------------|--------|
| **hydrated** | Live WebContentsView / Monaco instance / 실제 컴포넌트 | 높음 (fully loaded) | 정상 interactive |
| **suspended** | 중간 상태 — WebContentsView destroy 중 screenshot 캡처 | 감소 중 | screenshot (pending) |
| **static** | DOM 없음. screenshot `<img>` 만 표시 | 최소 (image bytes only) | 정적 이미지, click → reload |
| **discarded** | 완전 삭제 (Trash / 유저 명시적 제거) | 0 | 표시 안 함 |

**Transitions (규칙)**:

1. **create → hydrated**: 항상 eager load (Chrome new tab 과 동일)
2. **hydrated → suspended**: Entity 중심점이 viewport rect 밖 + N초 dwell (기본 N=3). 즉시 suspend 하지 않음 (pan-through flicker 방지). 상세 판정 규칙 §5.4 참조.
3. **suspended → static**: Screenshot 캡처 완료 + DOM teardown 완료 자동 전환
4. **static → hydrated**: Click/focus 시에만 (viewport in 만으로 자동 hydrate X). Chrome discarded tab 재활성 패턴.
5. **hydrated → static** (skip suspended): 수동 "sleep" 액션 시 (추후 v2 기능)
6. **any → discarded**: Trash drop / 명시적 delete

**이유**: viewport in 자동 hydration 은 pan 중 모든 entity 가 순간 load → 성능 저하. 유저 의도 (click) 만 trigger.

### 5.4 Viewport Intersection Detection — 중심점 기준 (확정)

**핵심 원칙**: Entity 의 **중심점** 이 viewport rect 밖에 있으면 "out". 부분 겹침 / 가장자리 판정 없음 — 중심이 유일 기준.

**판정 6단계 규칙**:

```typescript
// 1. 중심점 계산 (canvas space)
const entityCenter = {
  x: entity.position.x + entity.size.w / 2,
  y: entity.position.y + entity.size.h / 2
}

// 2. Canvas transform matrix 적용 → screen coord
const screenCoord = {
  x: entityCenter.x * viewport.scale + viewport.translateX,
  y: entityCenter.y * viewport.scale + viewport.translateY
}

// 3. Viewport rect 밖 = "out" 판정
const isOut =
  screenCoord.x < 0 ||
  screenCoord.x > viewport.width ||
  screenCoord.y < 0 ||
  screenCoord.y > viewport.height

// 4. Dwell timer: 3초 이상 "out" 유지 시 suspend 트리거
if (isOut && now - outStartedAt >= 3000) triggerSuspend(entity)

// 5. Hysteresis: 3초 경과 전 다시 "in" 되면 suspend 취소
if (!isOut) clearOutTimer(entity)

// 6. Suspend 후 재진입 시 static 유지 (click 필수)
// → 이 규칙은 §5.3 lifecycle transition 4 에서 enforce
```

**상태 변수 (entity 별)**:

```typescript
interface ViewportTrackingState {
  entityId: string
  isOut: boolean               // 현재 순간 viewport 밖인가
  outStartedAt: number | null  // "out" 진입 timestamp (null = in)
  lastInAt: number             // 마지막으로 "in" 이었던 timestamp
}
```

**구현 방식**:
- EntityLayer supervisor 가 매 animation frame (`requestAnimationFrame`) 혹은 viewport state 변경 시 모든 entity 중심점 재계산 → `isOut` 갱신 → dwell timer 관리
- **IntersectionObserver 미사용**. Canvas transform-aware 계산이 더 정확 (transform matrix 직접 적용), 의존성 적음, threshold 튜닝 불필요.

**근거**:
- **중심점 기준**: 직관적 ("entity 가 시야 한가운데에서 벗어났다") + O(1) 계산. 경계/부분겹침은 유저 관점에서 "이게 out 이야 in 이야?" 애매 → 중심만 따지면 명료.
- **3초 dwell**: Pan-through (빠르게 지나가는 경우) flicker 방지. 짧으면 자연스러운 pan 중 suspend 남발, 길면 메모리 해제 느림.
- **Hysteresis**: Dwell 경과 전 재진입 시 timer 취소 → 자연스러운 hover-over / micro-pan 경험.
- **재진입 시 static 유지**: Viewport in 만으로 자동 hydrate 안 함 → Chrome tab discard 패턴 일관 (§5.3 transition 4).

**Tuning (v2 후보)**:
- Dwell 시간 동적 조정 (system RAM / entity count 기반)
- 중심점 → 경계 margin 조정 (예: "viewport + 20% 여유 밖" = 더 보수적 suspend)

### 5.5 Screenshot Capture Hook

**타이밍**: `hydrated → suspended` 전환 직전.

**Methods** (entity type 별):

| Entity Type | Capture Method |
|-------------|----------------|
| `browser` | `webContents.capturePage()` (Electron API) |
| `ide` (Monaco) | Monaco DOM → `html-to-image` lib or canvas drawImage |
| `chat`, `note`, `file-preview` | DOM → `html-to-image` |
| `gadget` | Gadget 자체 API or DOM capture |

**Storage**:
- v1: in-memory `Blob` or base64 data URL (entity state `snapshot` 필드)
- v2: File system cache (`userData/snapshots/${entityId}.jpg`, compressed)

**Compression**: JPG quality 0.7, max width 1280px. 평균 30-80KB/entity.

**ADR-005 integration**: PresetBag mini-map screenshot 은 **같은 capture hook** 재사용 (Pack 시점 = entity bounding box 영역 일괄 캡처).

### 5.6 Click-to-Reload (static → hydrated)

**Trigger**: Static entity 를 click / focus / keyboard Enter.

**Behavior**:
1. Screenshot 즉시 dim (opacity 0.7) + spinner overlay
2. Entity type 에 맞는 hydrate procedure 실행 (WebContentsView recreate, Monaco init 등)
3. Hydrate 완료 → screenshot overlay fade-out 200ms
4. `lifecycle = 'hydrated'` 전환

**UX**: Chrome discarded tab re-activation 과 동일 느낌. 유저가 "뭔가 로딩 중" 인지 명확히.

### 5.7 Dock 드래그드롭 → Entity 생성 API

**Entry point**:

```typescript
interface EntityFactory<T extends EntityType> {
  createFromDockApp(
    appType: T,
    dropPosition: { x: number; y: number },  // canvas-space
    initialProps?: Partial<EntityTypePropsMap[T]>
  ): Promise<CanvasEntity<T>>
}
```

**Flow**:
1. User drags Dock icon (HTML5 drag-and-drop)
2. Canvas 가 drop event 수신 → screen → canvas-space 좌표 변환
3. `EntityFactory.createFromDockApp(type, position)` 호출
4. 해당 type 의 default state 로 Entity 생성 (lifecycle: 'hydrated')
5. EntityLayer state 에 append → re-render

**Reverse (§7-2 L264)**: Click → Right HUD (Entity 생성 X), Drag → Canvas Entity. Dock 중앙 그룹 (Canvas tools) 은 드래그 불가.

### 5.8 Display State (Covered / Spread / Full)

§7-4 L351 이중 모드 + §8 L402-403 레이어와 정합:

| DisplayState | Size | Layer | Trigger |
|--------------|------|-------|---------|
| **covered** | Thumbnail (~280-320px width, §10 card) | L1 | 기본 상태 |
| **spread** | Medium (~450×600px) | L2 | Click on covered |
| **full** | Viewport 점유 | L2+ | Double-click or expand button |

**Transition**: smooth (transform scale animation, 250ms ease-out).

### 5.9 Performance Budget — Viewport-Based (단일 룰)

**정책**: Viewport intersection 이 **유일한 lifecycle 기준**. 하드 cap / LRU forced suspend 없음.

**규칙**:

| 상황 | lifecycle |
|------|-----------|
| Viewport 안에 들어와 있음 | **hydrated** (전부 live, 개수 제한 없음) |
| Viewport 밖 + dwell 3초 경과 | **suspended** → **static** (screenshot) |
| Static 상태에서 viewport 재진입 | **static 유지** (자동 hydrate 안 함) |
| Static → hydrated 전환 | **Click/focus 만** (유저 명시 의도) |

**유저 확정 원문 (2026-04-13)**: "viewport 안에 있는거는 살려야지"

**근거**:
- Viewport = 유저가 "지금 본다" 는 신호. 보이는 entity 를 인위적으로 kill 하면 멘털 모델 어긋남.
- LRU forced suspend (유저 입장에선: 안 건드린 지 오래된 entity 가 자기 멋대로 정적 이미지가 됨) = 예측 불가한 UX.
- Static → 재진입 시 static 유지 + click 으로만 hydrate = 유저가 "쓰겠다" 고 선언할 때만 메모리 점유. Chrome tab discard 재활성 모델 일관.

**메모리 관리 전략** (hard cap 없음, soft signal 기반):

1. **Zoom-out density threshold** (v2 tuning): 극한 zoom-out 상태 (예: scale < 0.2) 에서 viewport 에 동시에 100+ entity 가 들어오면 viewport 판정 보수화 검토. v1 은 미구현.
2. **Dev-mode memory warning**: Hydrated count > 20 시 dev console warning (유저 개입 없음, telemetry 용). v1 구현.
3. **OS-level fallback 의존**: Electron Chromium 은 메모리 압박 시 자체 throttle. 본 ADR 은 application 레벨 cap 을 걸지 않음.

**Tuning 로드맵**:
- **v1 (ADR-006)**: 하드 cap 없음. dwell 3초 고정.
- **v2 (ADR 필요 시)**: System RAM 감지 → dwell 시간 동적 조정 (low RAM: 1초, high RAM: 5초). Zoom-out density threshold 도입 여부 검토.
- **v3**: Entity type 별 cost profiling 기반 개별 dwell tuning.

**유저 선호 반영 히스토리**:
- 초안 (2026-04-13 오전): Max hydrated 4 + LRU forced suspend 제안
- 유저 rejection: "viewport 안에 있는거는 살려야지" → viewport 를 단일 기준으로 승격
- 최종: 하드 cap 제거, viewport intersection + dwell + manual click 이 lifecycle 을 결정하는 유일한 rule

### 5.10 Entity-specific Extension Points

각 entity type 은 **thin adapter** 를 구현:

```typescript
interface EntityAdapter<T extends EntityType> {
  type: T
  hydrate: (entity: CanvasEntity<T>) => HydratedInstance  // live DOM/WebView
  suspend: (instance: HydratedInstance) => Promise<string>  // screenshot data URL
  render: (entity: CanvasEntity<T>, instance?: HydratedInstance) => JSX.Element
  captureSnapshot: (instance: HydratedInstance) => Promise<string>  // screenshot
}
```

**Registry**:
```typescript
const entityAdapters: { [K in EntityType]: EntityAdapter<K> } = {
  browser: BrowserAdapter,
  ide: IDEAdapter,
  chat: ChatAdapter,
  // ...
}
```

**각 adapter 는 별도 ADR 로 구체화** (ADR-007+). 추가 순서는 §5.11 FIFO 정책 참조.

### 5.11 Entity Type Addition Policy (2026-04-13 확정)

**FIFO (lazy addition) — pre-priority 결정 없음**

- Phase 1 MVP (Note entity infra) 완료 후, 구체 entity type (Browser / IDE / Chat / File / etc.) 은 **유저 요청 순서대로** 별도 ADR (007+) + adapter 구현으로 추가
- Pre-prioritization 불필요 (Adapter pattern 으로 type 들이 isolated 되어 있어 순서 무관)
- 각 type 추가 시점:
  - 유저가 명시적으로 "X entity 필요" 요청 시
  - 또는 특정 워크플로우에서 해당 type 없이 진행 불가해진 시점
- 각 entity type 의 복잡한 결정 (구현 방식 / 라이선스 / 의존성) 은 그 type ADR 시점에 결정

**근거**: Pre-priority 결정은 미사용 entity type 에 대한 의사결정 부담. Adapter pattern 덕분에 지연 가능. "필요할 때 만든다" 원칙.

**유저 결정 맥락 (2026-04-13)**: Phase 2 entity type 우선순위 질문 ("Browser / IDE / Chat / File 중 무엇부터?") 에 대해 pre-prioritize 하지 않고 FIFO 로 지연하기로 확정. Phase 1 MVP 는 type-agnostic infra 검증이라 type 선택 없이도 착수 가능.

---

## Consequences

### Positive

1. **모든 entity type 블로커 해제**: Browser / IDE / Chat / File preview / Gadget 모두 ADR-006 기반으로 구현 가능.
2. **§7-4 HUD/Entity 이중모드 구현 가능**: 드래그드롭 → Entity 생성 API 확정.
3. **§9-3 Placeholder → v1 승격**: 구체 좌표계/렌더 규격.
4. **유저 멘털 모델 정합**: "보이는 = 쓸 수 있음" 단일 룰. Forced suspend 의 예측 불가성 제거.
5. **Chrome tab discard 패턴**: 수십/수백 entity 저장 가능 (static 은 image bytes only).
6. **Screenshot 인프라 공유**: ADR-005 PresetBag mini-map + ADR-006 suspended snapshot 동일 capture hook 사용.
7. **Type-safe**: TypeScript discriminated union 으로 entity-specific props 안전.
8. **Testability**: Supervisor 분리로 lifecycle 단위 테스트 가능.
9. **Lifecycle 설명 간결**: viewport intersection + dwell + click 세 가지로 요약 가능 → 문서/교육 비용 낮음.

### Negative

1. **구현 분량 큼**: Supervisor + adapter pattern + lifecycle + screenshot capture + d3-zoom 통합 → v1 MVP 도 최소 1-2 스프린트.
2. **Electron main-process 의존성 증가**: WebContentsView / capturePage API → main/preload 왕복 필요 (HMR 전략 영향).
3. **Memory 하한 보장 없음**: Hard cap 제거로 극한 zoom-out + 수백 entity viewport 동시 진입 시 메모리 급증 가능. v1 은 dev console warning 만, v2 density threshold 필요.
4. **Screenshot 저장 비용**: in-memory blob → 수백 entity 시 메모리 부담 가능. v2 에 FS cache 필요.
5. **Suspended → static 순간 flicker 위험**: Screenshot 캡처 타이밍 실패 시 빈 카드 보일 수 있음 → placeholder 이미지 fallback 필수.
6. **저사양 기기 리스크**: Hard cap 없으므로 저사양 기기에서 수십 entity 동시 hydrated 시 slowdown 가능. v2 system RAM 감지 tuning 필요.
7. **Safari 3D transform 이슈 리스크**: Electron Chromium 기반이라 주 관심사 아니나, 향후 web build 시 검증 필요.
8. **Adapter 없는 entity type = 렌더 불가**: 새 type 추가 시 adapter 의무. (but 의도된 제약)

### Neutral

7. **ADR-001 과의 관계**: ADR-001 이 "xyflow 개념 차용" 기조 결정, ADR-006 이 구체 구현 표준. ADR-001 은 유효성 유지.
8. **ADR-002 라이선스**: d3-zoom = MIT (Green tier), html-to-image = MIT (Green tier). 추가 의존성 문제없음.

---

## Implementation Phases

### Phase 1 Kickoff (2026-04-13)

**Status**: Phase 1 MVP implemented (2026-04-13) — DONE_WITH_CONCERNS
**Owner**: coding-agent
**승인 맥락**: ADR-006 v2 Decided 승격 (2026-04-13) 과 함께 Phase 1 착수 확정. Type 우선순위 (§5.11 FIFO) 결정 없이도 착수 가능 (type-agnostic infra).

**Implementation 결과 (2026-04-13)**:
- **파일**: `src/renderer/src/canvas/` 10 파일, 936 라인
  - `Canvas.tsx`, `ViewportContainer.tsx`, `EntityLayer.tsx`, `Entity.tsx`
  - `store.tsx` (Zustand canvas store, 신규)
  - `types.ts`
  - `hooks/useCanvasTransform.ts`, `useViewportIntersection.ts`, `useScreenshotCapture.ts`
  - `adapters/NoteAdapter.ts`
- **의존성 (Green tier, ADR-002)**:
  - `d3-zoom` (MIT) — pan/zoom wrapper
  - `d3-selection` (MIT) — d3-zoom peer dep
  - `html-to-image` (MIT) — screenshot capture
- **Exit criteria 검증**:
  - typecheck: PASS
  - build: PASS
  - GUI 런타임 검증: pending (유저 수동 smoke test 필요)
- **미구현 / 이슈**: 아래 "Phase 1 Concerns" 섹션 참조.

**Phase 1 Concerns (기록 2026-04-13)**:

1. **§5.7 Dock 드래그드롭 미구현** — Dock → Canvas entity 생성 API (`EntityFactory.createFromDockApp`) 는 Phase 2 로 이월. Phase 1 MVP 에서는 entity 수동 생성으로 lifecycle 검증만 수행.
2. **Pan trigger activator key 분열** — 아래 §5.4.1 Pan Activator Key Policy 참조. d3-zoom API 제약으로 Space 키는 "edge fade" 전용, pan 은 Cmd/Ctrl/Shift 로 트리거. v2 에서 통합 재검토 예정.
3. **`src/CODEBASE_STRUCTURE.md` outdated** — Phase 1 canvas/ 디렉토리 구조 반영 안 됨. 별도 WM/docs 작업으로 최신화 필요.

### 5.4.1 Pan Activator Key Policy (Phase 1 잠정 결정, 2026-04-13)

**결정**: Canvas pan 트리거는 **Cmd/Ctrl/Shift 조합키 only**. **Space 키는 edge fade UX 전용** (향후 §7 Edge 시스템 연계).

**근거 (d3-zoom API 제약)**:
- d3-zoom 의 `.filter()` 콜백은 mousedown 시점 modifier key 만 감지 가능
- Space 키는 keydown/keyup 별도 이벤트 — d3-zoom filter 에서 감지 불가
- Hold-Space-to-pan 패턴 구현 시 d3-zoom wrapper 외부에 별도 key-state store 필요 (복잡도 증가)
- Phase 1 MVP 범위에서는 표준 modifier key 조합으로 시작, Space = edge-only

**트레이드오프**:
- 장점: d3-zoom 표준 API 준수, 구현 단순, 대부분 canvas 툴 (Figma 등) 의 modifier key 관례와 일치
- 단점: "Space = pan" 에 익숙한 유저 (Photoshop 등) 와 mental model 분열. Space 가 edge UX 에만 쓰이는 이유 설명 필요.

**v2 재검토 항목**:
- d3-zoom 대체 (react-zoom-pan-pinch 등) 또는 직접 wrapper 재구현 여부
- Space + pan 통합 시 Space-for-edge 와 충돌 해소 (long-press vs tap 구분 등)
- UX 사용성 테스트 후 최종 결정

**Status**: Phase 1 잠정. v2 ADR (ADR-00X-canvas-pan-activator) 로 승격 후 확정 예정.

### Phase 1 — Core Infrastructure (MVP)

**목표**: 빈 Canvas 에 Note entity 하나 drag-drop + pan/zoom + suspend/hydrate cycle 동작.

1. `Canvas.tsx` + `ViewportContainer` + d3-zoom wrapper (축 1A, 4A)
2. `EntityLayer.tsx` supervisor (축 3A)
3. `CanvasEntity` TypeScript interface + state management (Zustand or existing store)
4. `EntityAdapter` interface + `NoteAdapter` (간단한 test entity)
5. Dock drag-drop → entity 생성 (§7-2 기존 아이콘 중 [+Create] 로 Note 생성)
6. Viewport intersection (중심점 기준 §5.4) + dwell timer → lifecycle transitions
7. Screenshot capture (Note 기준, html-to-image)
8. Static entity click → hydrate

**Exit criteria**:
- Note 10개 생성 후 pan-out → 3초 dwell → suspended → static 전환 확인
- Static 상태에서 viewport 재진입 → static 유지 (자동 hydrate X) 확인
- Click on static → re-hydrate 정상
- Memory 계측 (Chrome DevTools): viewport 내 hydrated entity 개수 제한 없이 live, viewport 밖 static 은 image bytes only 검증
- Dev console memory warning (hydrated > 20) 작동 확인

### Phase 2+ — Entity Type Addition (FIFO, §5.11 정책)

Phase 1 완료 후, 구체 entity type 은 **유저 요청 순서대로** 추가 (pre-priority 결정 없음). 각 type = 별도 ADR + adapter 구현.

**후보 pool** (순서 unordered, 우선순위 없음):
- Browser Entity (ADR-007-browser)
- IDE Entity (ADR-007-ide, Monaco embed)
- Chat Entity (ADR-007-chat, 기존 ChatDock 포팅)
- File Preview Entity (ADR-007-file, PDF/image)
- Gadget Entity (ADR-007-gadget)

각 type 의 구현 방식 / 라이선스 / 의존성 결정은 해당 ADR 시점에 수행. 이전 type 의 결정이 다음 type 을 bind 하지 않음 (Adapter pattern isolation).

### Phase 3 — Display State (Covered/Spread/Full)

- DisplayState transitions + animations
- Spread/Full layer 승격 (L1 → L2)
- Full mode exit (ESC or expand button)

### Phase 4 — Persistence

- Entity state FS persistence (`userData/canvas-state.json`)
- Screenshot FS cache
- Session restore (last hydrated → re-static from snapshot)

### Phase 5 — Performance Tuning

- Dynamic hydrated budget (system RAM 기반)
- Screenshot compression v2 (WebP, lazy load)
- Canvas virtualization (수천 entity 시)

---

## SPEC Update Plan

### §9-3 Placeholder → v1 명세 (L549-562 교체)

기존 placeholder 블록을 v1 본문으로 교체. 핵심 내용:
- ViewportContainer + transform 모델
- Canvas-space coordinate
- 4-state lifecycle (hydrated/suspended/static/discarded) 표 + 전이 규칙
- IntersectionObserver + dwell timer 3초 기본값
- Screenshot capture hook + method per entity type
- Click-to-reload (static → hydrated) UX 규칙
- **Performance policy (v1)**: Viewport-based (hard cap 없음). Viewport 안 = hydrated 전부, viewport 밖 + dwell = suspended → static, static → hydrated 는 click 만. Dev console warning (hydrated > 20). v2 density threshold + system RAM tuning 예정.
- Adapter registry pattern
- 상세는 `ADR-006 Canvas Entity Foundation` 인용

### §7-4 HUD/Entity 이중모드 보강 (L351-356)

"Entity 모드" 행에 구현 기반 링크 추가:
- "Canvas Entity (Covered 카드)로 생성된다" → "ADR-006 Entity Factory 로 생성 (lifecycle: hydrated)"

### §7-2 Dock 드래그드롭 규칙 (L264)

"캔버스에 드래그드롭하면 Canvas Entity (Covered 카드) 생성" 에 ADR-006 `EntityFactory.createFromDockApp` API 호출 명시.

---

## References

### 외부 레퍼런스 (ADR-001 차용 기조)
- `references/xyflow/packages/react/src/components/ViewportPortal/index.tsx` — ViewportPortal pattern
- `references/xyflow/packages/system/src/xypanzoom/XYPanZoom.ts` — d3-zoom wrapper
- `references/xyflow/packages/system/src/xypanzoom/eventhandler.ts` — pan/zoom event handling

### 내부 문서
- `DESIGN_SYSTEM_SPEC.md` §7-2, §7-4, §8, §9-3
- ADR-001 (Canvas Library Reference — 개념 차용 기조)
- ADR-004 (Canvas Tools Dock 통합 — Dock 객체축 호스팅)
- ADR-005 (PresetBag Interaction Pattern — screenshot capture 인프라 공유)

### 라이브러리
- `d3-zoom` ^3.x (MIT, Green tier per ADR-002)
- `html-to-image` ^1.x (MIT, Green tier per ADR-002)
- Electron `webContents.capturePage()` (내장)

### 유저 지시 원문 (2026-04-13)
> "새로 생성 시 바로 만들어야지. 대신 active 한 탭은 현재 뷰포트 기준으로만 액티브하게 하고 바깥으로 나간 애는 static image (screenshot) 으로 대체. 바깥에 나갔다가 다시 들어온 애도 바로 렌더링이 아니라 클릭하여 active 할 때 리로딩. Chrome 탭 재로딩 방식."
