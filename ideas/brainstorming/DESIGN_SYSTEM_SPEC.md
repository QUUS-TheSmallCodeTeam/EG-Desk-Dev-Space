# EG-Desk Design System Specification

**작성일**: 2026-04-09
**상태**: brainstorming (디자인 시스템 정의 진행 중. Edge별 확정 상태는 Section 7 참조)
**용도**: design-agent가 모든 화면 생성 시 참조하는 디자인 시스템 정의
**디자인 도구**: Figma MCP (2026-04-09~). Stitch는 레거시 (삭제 불가/중복 오염 문제로 전환)

---

## 1. 디자인 시스템 이름

**EG-Desk Surface** (고정 — Stitch에서 이 이름으로 유지)

---

## 2. 색상 체계

### Mode: LIGHT (확정, 변경 불가)

| 역할 | 색상 | 용도 |
|------|------|------|
| **Surface (배경)** | #F5F3EF (warm off-white) | 캔버스/책상 표면. 종이 질감 느낌 |
| **Surface Elevated** | #FFFFFF | 카드, 패널, HUD 배경 |
| **Primary** | #2D5A7B (deep blue-teal) | 주요 액션, 선택 상태, 링크 |
| **Primary Container** | #E3EEF5 | Primary의 연한 배경 (선택된 카드 테두리 등) |
| **Secondary** | #6B7B8D (muted blue-gray) | 보조 텍스트, 비활성 상태 |
| **Outline** | #D4D0CA (warm gray) | 카드 테두리, 구분선 |
| **Outline Variant** | #E8E4DE | 약한 구분선, hover 상태 |
| **On Surface** | #1A1A1A | 본문 텍스트 |
| **On Surface Variant** | #5A5A5A | 보조 텍스트, 캡션 |
| **Error** | #C62828 | 에러 상태 |
| **Success** | #2E7D32 | 완료/성공 상태 |

### 금지 색상
- 순수 검정(#000000) 배경 금지
- 네온/형광 색상 금지
- 그래디언트 배경 금지 (단, 미세한 그림자는 허용)
- Aurora/글래스모피즘 효과 금지

---

## 3. 타이포그래피

| 역할 | 폰트 | 크기 | 무게 |
|------|------|------|------|
| **Headline** | Inter | 20-24px | 600 (SemiBold) |
| **Subheadline** | Inter | 16-18px | 500 (Medium) |
| **Body** | Inter | 14px | 400 (Regular) |
| **Caption** | Inter | 12px | 400 |
| **Monospace** | JetBrains Mono | 13px | 400 |

---

## 4. 형태 (Shape)

| 요소 | Border Radius |
|------|---------------|
| 카드 (Covered 객체) | 8px |
| 패널 (Spread 뷰어) | 12px |
| 버튼 | 8px |
| 칩/배지 | 16px (pill) |
| HUD 바 | 24px (capsule) |
| 아바타 | 50% (원형) |

### 절대 금지
- **카드 기울임(tilt/rotation) 금지** — 모든 카드는 rotation: 0deg
- 3D transform 금지 (perspective, rotateX/Y)
- 과도한 그림자 금지 (box-shadow는 최대 2 layer)

---

## 5. 간격 (Spacing)

| 단위 | 값 | 용도 |
|------|-----|------|
| xs | 4px | 아이콘과 텍스트 사이 |
| sm | 8px | 카드 내부 패딩 |
| md | 16px | 카드 간 최소 간격 |
| lg | 24px | 섹션 간 간격 |
| xl | 32px | HUD와 캔버스 콘텐츠 간 |

---

## 6. 카드 (객체) 스펙

### 공통
- 그림자: `0 1px 3px rgba(0,0,0,0.08), 0 1px 2px rgba(0,0,0,0.06)`
- 호버: 그림자 강화 + 1px 떠오름
- 테두리: 1px solid #D4D0CA (Outline 색상)
- 배경: #FFFFFF

### 객체별 Covered 크기 (DESK_BEHAVIORS_BY_OBJECT.md 기준)

> **디자인 시안 참고**: Stitch에서는 카드 내용이 알아볼 수 있도록 2-3배 확대하여 표현.
> 예: 브라우저 탭 120x80px → 시안에서 280-320px 너비로 렌더링.
> 아래 크기는 구현 시 기준이며, 시안에서는 콘텐츠 가독성을 우선한다.

| 객체 | 크기 | 비율 | 특징 |
|------|------|------|------|
| 브라우저 탭 | 120x80px | 가로 | 웹페이지 스크린샷이 카드 전체를 채움 + 상단 Favicon+Domain 캡슐 오버레이 |
| PDF | 100x130px | 세로 (A4) | 첫 페이지 + "PDF" 배지 + 두께감 |
| Excel | 130x100px | 가로 | 셀 격자 + "XLS" 배지 + 시트 탭 |
| PPT | 130x75px | 가로 (16:9) | 슬라이드 + "PPT" 배지 |
| Word | 100x130px | 세로 (A4) | 텍스트 미리보기 + "DOC" 배지 |
| 메모 | 120x120px | 정사각 | 포스트잇 색상 (6종) |
| ~~채팅/에이전트~~ | ~~100x80px~~ | ~~가로~~ | **캔버스 아님 → HUD 채팅으로 이동** |
| ~~에이전트 아바타~~ | ~~50x50px~~ | ~~원형~~ | **캔버스 아님 → HUD 채팅에서 접근** |
| 타이머/알람 gadget | 80x80px | 정사각 | 원형 다이얼 + 남은 시간. 캔버스 위 독립 객체 |

**핵심**: 카드는 아이콘이 아니라 **콘텐츠 미리보기**. 내용물이 보여야 한다.

---

## 7. Edge System (4-Edge Framework)

캔버스를 둘러싸는 4변(상/하/좌/우)에 시스템 UI를 배치한다.
각 Edge는 auto-hide 가능하며, 사용자 설정으로 per-edge visibility를 조절한다 (항상 표시 / 자동 숨김 / 숨김).

**확정 상태**: 4면 모두 확정.

| Edge | 이름 | 상태 |
|------|------|------|
| Top | Desk Rail | 확정 |
| Bottom | Dock | 확정 |
| Right | Contextual HUD Panel | 확정 |
| Left | Preset Bag | 확정 |

### Edge Reveal UX
- 커서가 뷰포트 가장자리 3px 이내에 0.3초 머물면 해당 Edge slide-in
- Edge 밖으로 커서가 벗어나면 0.5초 후 slide-out
- per-edge 설정: 항상 표시 (always) / 자동 숨김 (auto-hide) / 숨김 (hidden)
- 디자인 시안에서는 **항상 표시** 모드로 그린다

### Edge 정렬/너비 정책 (v2, ADR-004 보강)

**가로 Edge (Top/Bottom) — 수평 중앙 anchor 통일**:
- **DeskRail (Top)**: 수평 중앙 정렬 (`left: 50%, translateX(-50%)`). 너비는 **content-clamp + 3단 breakpoint**: `calc(min(100vw - 176px, N))` — N = base 900 / xl 1100 / 2xl 1344. 176px 버퍼 (좌 88 + 우 88) 로 macOS Traffic Lights 공간 대칭 보호. 내부는 Search bar flex-grow 로 유동.
- **Dock (Bottom)**: 수평 중앙 정렬 (ADR-004). 너비는 **content-aware** (아이콘 개수 자동 대응, `width: auto`, max `min(95vw, 960px)`).
- **공통 근거**: 가로 Edge 는 **뷰포트 수평 축의 주 조망선** 역할. 좌/우 anchor 는 한쪽 쏠림 → 비대칭 시각 부담. 중앙 anchor + content-aware/clamp 조합으로 요소 변화 자연 대응. 두 Edge 모두 `left-1/2 -translate-x-1/2` 로 **수평 중심축 공유** → 시각적 대칭.

**세로 Edge (Left/Right) — 변측 anchor 유지**:
- **PresetBag (Left)**: 좌측 가장자리 anchor (고정). 2-state 너비 (48-56px / 280px). 세로축은 이미 뷰포트 높이 70-80% 로 **큰 비중 차지** → 수직 중앙 정렬 의미 없음.
- **ContextualHUD (Right)**: 우측 가장자리 anchor (고정). 320-400px 앱별 유동. 세로축 근거 동일.
- **공통 근거**: 세로 Edge 의 "변측 anchor" 는 **도킹 metaphor** 의 핵심. 캔버스 사이드바 역할상 변 경계에 붙어 있어야 캔버스 영역이 직사각형 유지.

**Content-aware 예외 범위**:
- **Dock 한정**: 복합 축 호스팅 (객체 + 메타) 이라 아이콘 변화 폭이 크다 → content-aware 만 빈 공간/잘림 양 극단 방지.
- **다른 Edge 는 제외**: DeskRail 은 요소 개수 고정 (6) + flex-responsive 만으로 대응 가능, PresetBag/ContextualHUD 는 세로 단일 축 호스팅 + anchor 고정이라 content-aware 불필요.
- **일반화 보류**: 향후 Edge 에 내용 변화 요구 발생 시 개별 ADR 로 재검토 (예: DeskRail 에 plugin 아이콘 추가 요구 시).

### 7-1. Top Edge = Desk Rail (확정)

**Ontology**: 방 벽면에 걸린 시계, 안내판, 문패. 책상이 아닌 "방" 수준의 메타 정보.
**역할**: Desk 전역 상태, 식별, 검색, 알림. 가장 높은 추상 수준.

#### 위치 및 크기 (v2 — 수평 중앙 anchor + traffic lights clamp, ADR-004 보강 2026-04-13)
- position: fixed, 상단에서 16px 띄움 (`top: 16px`)
- **수평 정렬: 뷰포트 중앙** (`left: 50%, translateX(-50%)`)
- 높이: 48px
- **너비 정책 (content-clamp + 3단 breakpoint)**:
  - 공식: `width = calc(min(100vw - 176px, N))` — **viewport-based 산식** 과 **상한 N** 중 작은 값.
  - **N (breakpoint 상한)**:
    - base: **900px**
    - xl (≥1280px): **1100px**
    - 2xl (≥1536px): **1344px**
  - **176px 버퍼 (대칭 설계)**: 좌측 88px (macOS traffic lights 회피 78px + 여유) + 우측 88px (좌우 대칭) = 176px. 뷰포트 확장 시 항상 traffic lights 공간 보호, 축소 시 산식이 선행하여 오버플로 방지.
- **flex-responsive 내부**: Search bar 가 중앙 `flex-grow` 로 유동. 요소 개수는 6개 고정.
- 캔버스 위에 떠 있음 (z-index 최상위, L3 레이어)

**반응형 동작 (실측, 1440×900 기준)**:
- 1920px 뷰포트: `min(1744, 900)` = 900px (base) / xl: `min(1744, 1100)` = 1100px / 2xl: `min(1744, 1344)` = 1344px
- 1440px 뷰포트: `min(1264, 900)` = **900px** — 좌우 마진 270px/270px 대칭
- 800px 뷰포트: `min(624, 900)` = **624px** — 산식이 선행, 176px 버퍼 유지

**설계 원칙 (ADR-004)**: DeskRail 은 **수평 중앙 anchor + flex-responsive** 를 채택한다. 근거:
1. **뷰포트 수평축 주 조망선**: 가로 Edge 는 좌/우 한쪽 쏠림 시 비대칭 시각 부담 → 중앙 anchor 로 안정감.
2. **Dock 과 일관된 가로 Edge 정책**: Bottom Edge (Dock) 도 수평 중앙 (ADR-004). 가로 Edge 2 개 모두 중앙으로 통일하면 유저 멘탈 모델 단순화.
3. **Content-aware 는 채택 안 함**: 요소 6개 고정 + Search flex-grow 만으로 대응 충분. Dock 처럼 아이콘 개수 변화 가능성 낮음 (→ §7 Edge 정렬/너비 정책 참조).

#### 유리 질감 (Frosted Glass)
- 배경: `rgba(255, 255, 255, 0.6)` (반투명 흰색)
- `backdrop-filter: blur(20px) saturate(180%)`
- 이중 그림자: `0 4px 6px rgba(0,0,0,0.02), 0 20px 40px rgba(0,0,0,0.08)`
- 테두리: `1px solid rgba(255,255,255,0.4)` (얇은 흰색)
- border-radius: 24px (캡슐)
- 캔버스 콘텐츠가 Desk Rail을 통해 흐릿하게 비쳐 보여야 함

#### 요소 배치

```
[●●● Traffic Lights] [Desk Name / Switcher] ── [⌘K Search] ── [Minimap] [Bell] [Profile]
  좌측 끝                 좌-중앙                  중앙           우측              우측 끝
```

| 위치 | 요소 | 설명 |
|------|------|------|
| 좌측 끝 | macOS Traffic Lights | 빨/노/초 윈도우 컨트롤 |
| 좌-중앙 | Workspace / Desk Switcher | 현재 Desk 이름 + 전환 드롭다운 |
| 중앙 | Cmd+K 검색 트리거 | 돋보기 + "Search or ask AI..." 힌트. 클릭/Cmd+K → Spotlight 팝업 |
| 우측 | Canvas Minimap | 지도 아이콘. 클릭 → 미니맵 팝업 (전체 캔버스 축소 + 현재 뷰포트 사각형 표시. 뷰포트 사각형 드래그로 캔버스 위치 이동) |
| 우측 | Notifications Bell | 알림 벨 + 미읽은 수 배지. Desk 전역 상태값 |
| 우측 끝 | Profile Avatar | 원형 32px. v1에서는 시각적 표시만 |

#### Cmd+K Spotlight (검색 팝업)
- Desk Rail과 별개의 독립 모달. 화면 정중앙에 팝업
- 배경 딤: `rgba(0,0,0,0.3)` + `backdrop-filter: blur(8px)`
- 검색 바: 너비 560px, 높이 56px, border-radius 16px, 흰색 배경
- 아래에 AI 제안/최근 항목 드롭다운
- ESC로 닫기

### 7-2. Bottom Edge = Dock (확정)

**Ontology**: macOS Dock과 유사. 자주 쓰는 앱/가젯/도구를 꽂아두는 곳.
**역할**: 자주 쓰는 도구 빠른 접근. Chat/Agent 진입점.

#### 위치 및 크기 (v2 — content-aware width, ADR-004 보강 2026-04-13)
- position: fixed, 하단에서 12-16px 띄움, 수평 중앙 (`left: 50%, translateX(-50%)`)
- **너비: content-aware (아이콘 개수에 자동 대응)**
  - `width: auto` 기반, 내부 아이콘 + divider + gap 합산으로 자연 결정
  - **min-width**: 좌측 1 + 중앙 0 + 우측 1 = 2 icon 최소 상태에서도 "bar" 로 인식 가능한 수준 (약 140-160px) 권장
  - **max-width**: `min(95vw, 960px)` — 뷰포트 폭의 95% 또는 960px 중 작은 값. 과도 확장 방지
  - 현재 v2 9-icon 구성 (4 + 4 + 1) 에서 실측 ~514px (1440×900 뷰포트 기준)
  - 유저/프로젝트가 Dock 에 아이콘 추가/제거 시 width 자동 재계산 (기존 고정 `50-60vw` 정책 폐기)
- 높이: 48-56px (고정)
- z-index: L3 레이어 (Desk Rail과 동일)

#### 내부 간격 명세 (v2 — content-aware width 기반)
- **컨테이너 padding**: `px-5` (좌우 20px)
- **그룹 간 gap**: **16px** (컨테이너 level, `gap-4`). divider 양옆에 각 16px 숨결 공간
- **그룹 내 아이콘 간 gap**: **8px** (각 그룹 컨테이너 level, `gap-2`). 타이트하게 묶임
- **divider**: `w-px h-8 bg-[var(--outline-variant)]` (1px 세로선, 높이 32px)
- **아이콘 버튼**: 40×40px (36-48px 범위 허용)
- **간격 해제 금지**: `justify-between` 사용 금지 (그룹 사이 빈 공간 유발 → 아이콘 개수 변화 시 불규칙). 반드시 `gap-*` 기반 균등 간격 유지

**설계 원칙**: Dock 은 **content-aware** 를 채택한다. 이는 다음 2 이유에 근거:
1. **복합 축 호스팅 (ADR-004)**: Dock 은 객체축(좌/우 그룹, 유저 커스텀 앱/가젯 추가 가능) + 메타축(중앙 Canvas tools, v2+ 확장 가능) 을 함께 담는 유일한 Edge. 고정 비율(`50-60vw`) 은 아이콘 과소 시 **빈 공간** / 과다 시 **잘림** 을 유발. content-aware 만 양쪽 극단 방지.
2. **Dock 전용 예외**: §7 Element 한도 예외 (Dock max 12) 와 **동일한 범위** 의 예외 처리. 다른 Edge (DeskRail / PresetBag / ContextualHUD) 는 단일 축 호스팅이라 content-aware 불필요, 각 Edge 의 고유 너비 정책 유지.

#### 유리 질감
- Desk Rail과 동일한 frosted glass 스타일
- border-radius: 16px (Desk Rail보다 약간 각진 rounded bar)

#### 요소 배치 (v2 — 3-그룹 구조, ADR-004 반영; IDE 추가 2026-04-13 Phase 0)

```
[Chat/Agent] [Shelf] [Browser] [IDE] [+Create] ── [Pencil] [Hand] [Square] [Arrow] ── [Trash]
             좌측 5개 (앱/가젯)                    중앙 4개 (Canvas tools)         우측 1개
```

좌측/중앙/우측 3 그룹. 그룹 간 divider (`h-8 w-px bg-[var(--outline-variant)]`) 로 시각적 구분.

| 그룹 | 위치 | 요소 | 설명 |
|------|------|------|------|
| 좌측 | 1 | Chat/Agent | 말풍선 아이콘 + 미읽은 배지. 클릭 → Right Edge HUD 패널. 캔버스에 드래그드롭 → Entity 카드 생성 |
| 좌측 | 2 | Shelf (Library) | 선반/서재 아이콘. 클릭 → 좌측으로 패널 펼침 또는 상단 팝업 |
| 좌측 | 3 | Browser | 브라우저 아이콘. 클릭 → 브라우저 탭 HUD 또는 Entity 카드 (ADR-006 구현 대기) |
| 좌측 | 4 | IDE (`<>`) | 코드 에디터 아이콘. 클릭 → IDE HUD 또는 Entity 카드 (ADR-006 구현 대기). **현재 Phase 0 UI shell only** |
| 좌측 | 5 | Quick Create (+) | 새 객체 생성 메뉴 (메모, 탭, 문서 업로드 등). "add tool" semantic — Canvas tools 그룹과 인접 |
| 중앙 | 1 | Pencil | 캔버스 자유 드로잉. state-toggle |
| 중앙 | 2 | Hand / Pan | 캔버스 pan 도구. state-toggle |
| 중앙 | 3 | Square | 도형 (사각형) 삽입. state-toggle |
| 중앙 | 4 | Arrow / Pointer | 화살표/포인터 도구. state-toggle (기본 active) |
| 우측 | 1 | Trash | 휴지통. 드래그&드롭 대상. 클릭 → 최근 삭제 목록 |

> **좌측 그룹 5/5 한도 도달** (§7 L316 v2): IDE 추가로 좌측 그룹은 per-group max 5 제한에 도달. 추가 앱/가젯 도입 시 **ADR trigger** (한도 재검토 or alternative grouping 설계) 필요.

> **Canvas 도구 그룹 포함 (v2, ADR-004)**: Canvas 조작 도구 (Pencil/Hand/Square/Arrow) 는 **Dock 중앙 그룹**에 통합한다. 별도 floating Canvas Toolbar layer 는 **Superseded** (§9-1 v1 참조). Dock 은 객체축(좌측/우측 앱/가젯) 과 메타축(중앙 Canvas tools) 을 **복합** 축으로 호스팅한다. 좌측/우측 그룹은 클릭→Right HUD / 드래그→Canvas Entity **듀얼 모드** 적용, 중앙 그룹은 **state-toggle 전용** (드래그 불가). 동시 활성 Canvas tool 은 1개 (Figma 패턴).

> **드래그드롭 → Entity 생성 API (ADR-006)**: 좌측/우측 그룹 아이콘 드래그 → Canvas drop 시 `EntityFactory.createFromDockApp(appType, dropPosition, initialProps?)` 호출 → `CanvasEntity<T>` 생성 (lifecycle: `hydrated`). 상세는 §9-3 v1 명세 참조.

#### 채팅/에이전트 패턴 (HUD/Entity 이중 모드)

채팅은 **HUD 모드**와 **Entity 모드** 두 가지로 접근 가능.

**HUD 모드 (Dock 클릭 → Right Edge)**:
- Dock 채팅 아이콘 클릭 → Right Edge에 채팅 HUD 패널 렌더링
- Agent config(system prompt)만 로드. 경량.
- 추가 맥락 필요 시 agent가 desk entity를 filesystem으로 수동 조회
- 전체화면 전환 가능 (Full: 좌 채팅 목록, 중 대화, 우 공유 자료)

**Entity 모드 (Dock → Canvas 드래그드롭)**:
- Dock 채팅 아이콘을 캔버스에 드래그드롭 → 채팅 Covered 카드 생성
- 현재 뷰포트 내 entity의 context가 자동 파싱되어 로드. 무거움.
- 3-State: Covered (카드) → Spread (450x600px 패널) → Full (viewport)

**Context Toss (자료 전달)**: 캔버스 위 객체를 Dock 채팅 아이콘 위로 드래그 → Right Edge 채팅 패널 자동 열림 → 자료 공유.

### 7-3. Left Edge = Preset Bag (확정)

**Ontology**: 가방. 여러 물건을 한 가방에 담아서 책상에 쏟아놓는 동작. "출근해서 가방 열어서 책상에 쫙 펼치는" UX.
**역할**: 파일 + 브라우저탭 + 폴더 + 앱 등 다양한 entity 조합을 프리셋으로 저장하고, 한꺼번에 캔버스에 배치.

#### 위치 및 크기
- position: fixed, 좌측 가장자리에서 12px 띄움
- 너비: 48-56px (접힌 상태, 아이콘만) / 280px (펼쳐진 상태)
- 높이: 뷰포트 높이의 70-80% (상하 Edge와 겹치지 않도록)
- z-index: L3 레이어

#### 유리 질감
- Desk Rail / Dock과 동일한 frosted glass 스타일
- border-radius: 12px

#### 프리셋 구조

각 프리셋 = 이름 + entity 조합 (파일, 탭, 앱, 가젯 등의 목록 + 배치 위치)

| 요소 | 설명 |
|------|------|
| 프리셋 목록 | 저장된 조합 프리셋 리스트. **아이콘 디자인 통일 (Primary chip + initials, v2 ADR-005)**. Hover 200ms → mini-map popover 미리보기 |
| 프리셋 내용 | 해당 프리셋에 포함된 entity 목록 (파일, 탭 URL, 앱 등). 우클릭 context menu 로 빠른 참조 (v2) |
| (+) 새 프리셋 | 빈 프리셋 생성. 또는 캔버스에서 다중 선택 후 가방으로 드래그드롭(Pack)으로도 생성 가능 |

#### 프리셋 아이콘 인터랙션 (v2, ADR-005)

| 인터랙션 | 동작 | Status |
|----------|------|--------|
| Hover 200ms | 아이콘 오른쪽 popover (static screenshot, 240-280×120-160px, frosted glass frame) | 확정 |
| 좌클릭 | **미결정** — Preset edit 정책 (draft mode vs immediate update) 결정 후 확정 | 보류 |
| 우클릭 | Element 목록 context menu (빠른 참조, 액션 없음) | 확정 |
| 드래그 to 캔버스 | Unpack (아래 참조) | 확정 |
| 드래그 from 캔버스 | Pack (아래 참조) | 확정 |

**아이콘 디자인**: 모든 preset 아이콘 = 동일 chip shape + Primary color background + initials/number. 식별은 이름(tooltip) + mini-map 으로 수행. 이유: preset 은 동적 entity 조합, 개별 시각 identifier 불필요.

**Mini-map Popover**: 아이콘 right +8px vertical center, static screenshot (Pack 시점 캡처), 캡션 = preset 이름 + entity 개수, z-index L3.

#### 핵심 인터랙션 — 양방향 드래그드롭

| 방향 | 동작 | 이름 | 설명 |
|------|------|------|------|
| 캔버스 → 가방 | **Pack (싸기)** | 캔버스에서 드래그로 다중 선택 → 선택된 entity들을 Left Edge 가방으로 드래그드롭 → 프리셋으로 저장 |
| 가방 → 캔버스 | **Unpack (풀기)** | 가방에서 프리셋을 캔버스로 드래그드롭 → 저장된 entity 조합이 캔버스에 한꺼번에 렌더링 |

- **Pack**: 캔버스에서 드래그 to select (다중 선택) → 선택된 entity 묶음을 Left Edge로 드래그드롭 → 프리셋 이름 입력 → 저장 완료
- **Unpack**: 프리셋 항목을 캔버스에 드래그드롭 → 포함된 entity들이 저장된 배치 그대로 캔버스에 렌더링
- **프리셋 편집**: 프리셋 내 entity 추가/제거/순서 변경

#### 사용 예시

- "React 개발" 프리셋: VSCode 탭 + React 공식문서 탭 + GitHub PR 탭 + 터미널 + API 스펙 PDF
- "회의 준비" 프리셋: 발표 PPT + 회의록 Word + 참석자 채팅 + 타이머 가젯
- 출근 시 "React 개발" 프리셋을 캔버스에 드롭 → 모든 작업 환경이 한번에 세팅

### 7-4. Right Edge = Contextual HUD Panel (확정)

**Ontology**: 책상 옆 보조 작업대. Dock 앱의 확장 패널이 여기에 열린다.
**역할**: Dock 앱 클릭 시 상세 UI를 렌더링하는 보조 패널. 앱 종류에 따라 내용이 동적으로 변경.

#### 위치 및 크기
- position: fixed, 우측 가장자리에서 12px 띄움
- 너비: 320-400px (앱에 따라 유동)
- 높이: 뷰포트 높이의 70-80% (상하 Edge와 겹치지 않도록)
- z-index: L3 레이어

#### 유리 질감
- Desk Rail / Dock과 동일한 frosted glass 스타일
- border-radius: 12px

#### Dock → Right HUD 연동

Dock 앱 아이콘을 **클릭하면** Right Edge에 HUD 패널로 렌더링된다.
같은 앱을 **캔버스에 드래그드롭하면** Canvas Entity (Covered 카드)로 생성된다.

| 앱 | Right HUD 내용 | Canvas Entity |
|----|---------------|---------------|
| Chat/Agent | 채팅 패널 (대화 내역, 입력 바) | 채팅 카드 (대화 미리보기) |
| Browser | 개발자 콘솔 / 탭 관리 | 브라우저 탭 카드 |
| IDE | 파일 트리 / 에디터 HUD (경량 코드 뷰) | 코드 에디터 Entity (full editor, 추후 ADR-007+ 로 구현) |
| File | 파일 정보 / 속성 패널 | 파일 Covered 카드 |

#### HUD vs Entity 이중 모드 (핵심 구조)

| 모드 | 트리거 | 렌더링 위치 | Context 로딩 |
|------|--------|------------|-------------|
| **HUD 모드** | Dock 앱 클릭 | Right Edge 패널 | 가벼움: agent config(system prompt)만 로드. 추가 맥락은 desk entity를 filesystem으로 수동 조회 |
| **Entity 모드** | Dock 앱을 캔버스에 드래그드롭 | Canvas 위 카드 | 무거움: 뷰포트에 충분히 들어와 있는 entity의 context만 자동 파싱 로드 (proximity = relevance) |

> **Entity 모드 구현**: Drag-drop 시 `EntityFactory.createFromDockApp(type, dropPosition)` 호출 → lifecycle: `hydrated` 로 생성. 상세 규격은 §9-3 v1 명세 / ADR-006 Canvas Entity Foundation 참조.

#### Entity 모드 Context 범위 규칙 (proximity = relevance)

"유저가 지금 보고 있는 것 = 관련 있는 것"

- **포함**: 뷰포트 안에 충분한 비율로 들어와 있는 entity
- **제외**: 뷰포트 완전히 밖에 있는 entity
- **제외**: 뷰포트에 일정 비율 이하로만 걸쳐 있는 entity (모서리만 살짝 보이는 경우)
- **범위**: 캔버스 전체가 아닌 **현재 뷰포트 영역**만이 context 경계

**Chat/Agent 예시**:
- HUD 모드 (클릭): Right에 채팅 패널. Agent는 system prompt만 로드, 경량. "파일 찾아줘" → agent가 desk 내 entity를 fs로 수동 조회
- Entity 모드 (드래그드롭): 캔버스에 채팅 카드 생성. 뷰포트에 보이는 entity context만 자동 로드. "이 PDF 요약해줘" → 뷰포트 안 PDF는 이미 context에 있음. 뷰포트 밖 PDF는 포함 안 됨

### Edge 금지 사항
- Settings를 Edge에 넣지 않음 (별도 접근)
- "Documents", "Files" 같은 모호한 카테고리 금지
- **Element 한도 (v2, ADR-004)**:
  - **Dock**: 3 그룹 구조에서 **그룹당 최대 5, 총 최대 12** 허용 (좌측 앱/가젯 그룹 + 중앙 Canvas tools 그룹 + 우측 기능 그룹)
  - **Dock 외 Edge (DeskRail / PresetBag / ContextualHUD)**: 기존 **5 초과 금지** 유지 (cluttered toolbar 방지)
  - Dock 예외는 복합 축 호스팅(객체축 + 메타축) 에 한정. 다른 Edge 는 단일 축이므로 5 한도 유지

---

## 8. 시각적 위계 (Visual Hierarchy)

4단계 레이어로 시각적 깊이를 표현한다. 각 단계는 그림자, 질감, 불투명도로 구분.

| 레이어 | 이름 | 역할 | 시각적 처리 |
|--------|------|------|------------|
| **L3 (제어)** | Edge System (Desk Rail / Dock / Right HUD) | 상시 제어 도구 | 강한 blur + frosted glass + floating bar/panel + 이중 그림자 |
| **L2 (포커스)** | Spread/Full 카드 | 현재 작업 중인 문서/뷰어 | 강조 border (Primary color) + 약간 강한 그림자 + glow 효과 |
| **L1 (작업물)** | Covered 카드 | 책상 위 놓인 썸네일 | 평면(flat) 질감 + 약한 그림자 + 1px outline |
| **L0 (공간)** | 캔버스 Surface | 바닥/책상 표면 | 미세 noise/종이 텍스처 + 가장 낮은 레이어 |

**그림자 강도 순서**: L3(Edge System) >> L2(Spread) > L1(Covered) > L0(Surface 없음)

---

## 9. 캔버스 규칙

### Zone Model
- **Focus Zone**: 뷰포트 중심 60% — 현재 작업 중인 객체
- **Peripheral Zone**: 뷰포트 가장자리 40% — 참조/대기 객체
- **Nearby**: 뷰포트 밖 1 화면 거리 — 곧 필요할 객체
- **Away**: 그 이상 — 보관 중인 객체

### Surface
- 배경: #F5F3EF (따뜻한 오프화이트)
- 미세한 종이/천 텍스처 가능 (눈에 거의 안 보이는 수준)
- 격자(grid) 표시 안 함 (깨끗한 책상)

### 9-1. 캔버스 도구 (Canvas Toolbar) — **SUPERSEDED (v1)**

> **Status**: **Superseded by ADR-004** (`.claude/docs/decisions/004-canvas-tools-integration-into-dock.md`) — 2026-04-13
>
> **사유**: 유저 지시에 따라 Canvas tools (Pencil/Hand/Square/Arrow) 를 **Dock 중앙 그룹**으로 통합. 별도 floating toolbar layer 폐기. 아래 v1 본문은 배경 보존용이며 **구현 대상 아님**. 현 구현은 §7-2 Dock 3-그룹 layout을 따른다.
>
> v2 결정 요지: Dock = 객체축(앱/가젯) + 메타축(Canvas tools) 복합 축. 3축 → 2축 ontology 축소 (PresetBag 장소축은 유지).

<details>
<summary>🗄️ v1 본문 펼치기 (Superseded — 배경 보존용)</summary>

캔버스 위 객체를 직접 조작하거나 주석을 다는 **state-toggle 도구 모음**. Dock(앱 launcher)과는 별도 레이어.

#### 가이드 원칙

1. **Dock ontology 보호**: Dock은 앱/가젯 launcher, Canvas Toolbar는 캔버스 조작 도구. 두 역할 혼재 금지.
2. **Ontology 축 분리**: Dock = 사물/가젯(객체 축), PresetBag = 조합/공간(장소 축), **Canvas Toolbar = 캔버스 자체 조작(메타 축)**. 세 축이 겹치지 않음.
3. **Ambient 원칙 준수**: 도구는 캔버스 조작이 필요한 순간에만 유의미. v2+에서 state-dependent visibility 검토.
4. **Infinite canvas 레퍼런스 일관성**: Figma/Excalidraw/Muse 등 공통 패턴(캔버스 floating toolbar) 따름.

#### 위치 및 크기

- position: fixed, **하단 중앙, Dock 위쪽으로 24px 띄움** (Dock과 명확히 분리)
- 좌우 정렬: viewport 중앙 (`left: 50%, translateX(-50%)`)
- 너비: 내용에 맞게 유동 (도구 4개 기준 약 200-240px)
- 높이: 44-48px
- Dock(h 48-56px + bottom 12-16px)과의 관계: Dock 상단 엣지 기준 24px 위. 1440×900 기준 Canvas Toolbar 하단 y ≈ 828 - 24 = 804px, Dock 상단 y ≈ 828px. 시각적 gap 24px 유지.

#### 시각적 위계 (L2 레이어)

Canvas Toolbar는 **L2 레이어**에 배치:
- L3 Edge System보다 얕음 (도구는 "제어"가 아닌 "작업 중인 것")
- L1 Covered 카드보다는 강조 (상시 접근 가능한 도구 특성)
- 캔버스 콘텐츠 계열이므로 Edge와 시각적으로 구별되어야 함

#### 유리 질감 (Edge와 구분)

**frosted glass는 사용하지 않는다**. Edge System과 혼동 금지.

- 배경: `var(--surface-elevated)` (#FFFFFF) — 흰색 elevated
- 그림자: `var(--shadow-card)` (L1/L2 수준)
- 테두리: 1px solid `var(--outline-variant)` (#E8E4DE)
- border-radius: 12px (Dock 16px, PresetBag 12px와 구분되는 rounded bar)

#### 초기 도구 세트 (4개)

v1은 **4개 도구**로 시작. 5-element 제약(Edge 전용)에는 해당 없으나, 과도한 도구 배치 지양.

```
[ 선택 ] [ 연필 ] [ 주석 ] [ 지우개 ]
Select   Pencil   Comment  Eraser
```

| # | 도구 | 아이콘 | 기능 | State toggle |
|---|------|--------|------|-------------|
| 1 | 선택 (Select) | 화살표/커서 | 기본 모드. 객체 선택/이동/크기 조절 | 기본 active |
| 2 | 연필 (Pencil) | 연필 | 캔버스 자유 드로잉. 색상/두께는 v2+에서 옵션 추가 | toggle |
| 3 | 주석 (Comment) | 말풍선 | 캔버스 위치에 주석 핀 부착 | toggle |
| 4 | 지우개 (Eraser) | 지우개 | 드로잉/주석 삭제 | toggle |

- **Active state**: 현재 선택된 도구 하나에 `bg-[var(--primary-container)]` + `text-[var(--primary)]` 적용. 나머지는 `text-[var(--on-surface-variant)]`.
- 동시 활성 도구는 1개만 허용 (Figma 패턴).

#### 가시성

**v1: 기본 상시 표시** (Figma 패턴 따름).
- 캔버스 비어있음/객체 있음과 무관하게 표시
- 단, Dock/PresetBag auto-hide 설정과 독립적 (Canvas Toolbar 자체 visibility는 유저 설정)

**v2+ 검토 항목**:
- state-dependent visibility ("선택 모드 외 도구 사용 중일 때만 활성화")
- 유저 설정으로 "도구 숨김" 옵션 제공
- 사이드바 접기(collapsed state)

#### 인터랙션

- **도구 전환**: 클릭 = 해당 도구 active. 다른 도구 클릭 시 이전 도구 deactivate
- **키보드 shortcut (v1 기본)**:
  - `V` — Select (Figma 관례)
  - `P` — Pencil
  - `C` — Comment
  - `E` — Eraser
  - `Esc` — Select 모드로 복귀
- **우클릭 컨텍스트 메뉴 (v1 보조)**: 캔버스 빈 공간 우클릭 → 동일 도구 목록 팝업 (discoverability 보강)
- **Cmd+K 통합 (v1 보조)**: Spotlight에서 "pencil", "comment" 등 자연어로 도구 활성화 가능

#### Dock과의 관계

**명시적으로 Dock과 별도**:
- Canvas Toolbar는 Dock에 포함되지 않는다 (5-element 제약/듀얼 모드 적용 안 됨)
- Canvas Toolbar의 도구는 "캔버스 상태 수정자"이며, Dock의 "앱/가젯 launcher"와 개념적으로 구별
- Dock 아이콘은 드래그드롭으로 Canvas Entity 생성 가능. Canvas Toolbar 도구는 **드래그 불가** (state toggle 전용)

#### 빈 상태 UX와의 관계

§9 "빈 상태 UX (Empty State)"의 3-Cue 힌트와 Canvas Toolbar는 **동시에 표시 가능**:
- 빈 캔버스 → 3-Cue 힌트 (Cmd+K / Preset / Chat) + Canvas Toolbar(하단 중앙 위쪽) 동시 렌더
- Toolbar는 "캔버스 조작 준비 완료" 시그널, 3-Cue는 "entity 추가 진입점" 시그널. 충돌 없음

#### 금지 사항

- **Dock 내부 배치 금지** — Canvas Toolbar 도구를 Dock에 추가하면 안 됨 (§7-2 ontology 위반)
- **Frosted glass 금지** — Edge System과 시각적 혼동 유발. shadow-card + white elevated 고정
- **5개 초과 도구 금지 (v1)** — v2+에서 확장 검토. v1은 4개 유지
- **모션/애니메이션 강조 금지** — 도구 전환 시 강한 transition 금지. 200ms opacity 또는 background 정도만
- **툴팁 외 레이블 금지** — 아이콘만 표시. hover 시 title tooltip만 (HUD/패널로 이어지지 않음)

#### 구현 노트 (v1)

- 컴포넌트: `src/renderer/src/components/CanvasToolbar.tsx` (예정)
- DeskHome에서 상시 렌더 (v1은 entity 시스템 도입 전 → 모든 도구 hardcoded state)
- z-index: canvas-surface(L0) 위, Edge System(z-40) 아래 → `z-20` 권장 (3-Cue 힌트 z-10보다 위, Edge z-40보다 아래)
- pointer-events: `auto` (클릭 가능. 3-Cue와 달리 인터랙티브 UI)
- i18n: 아이콘만 사용. 텍스트는 title 속성에 영문(designMd 기준) 또는 추후 i18n 대응

#### 미결정 사항 (v1 → v2+ 이월)

- 도구별 옵션 패널 (색상, 두께 등): v1에서는 기본값 고정, v2+에서 확장
- 5번째 도구 후보: Shape(도형), Text(텍스트), Highlighter(형광펜) 중 유저 피드백 반영 결정
- 전문 모드 vs 간소 모드 전환: 초보자용 4개 vs 전문가용 8-10개 분기 가능성
- Canvas Toolbar 위치 유저 커스터마이징 (상단/좌측/우측 이동 허용 여부)

</details>

---

### 9-3. 캔버스 엔티티 좌표계 (Canvas Entity Coordinate System) — v1 (ADR-006)

> **상태**: v1 확정 (2026-04-13, ADR-006 Decided). 이전 Placeholder는 본 섹션으로 교체됨.

Canvas에 entity(브라우저 탭, IDE 세션, 채팅, 파일 프리뷰, 가젯, 노트 등)를 배치할 때 **viewport transform + 4-state lifecycle + screenshot fallback** 규격. Chrome tab discard 패턴 차용 — 메모리 상한을 걸지 않고 viewport 기준으로 lifecycle 전이.

상세 근거/대안 평가: [`.claude/docs/decisions/006-canvas-entity-foundation.md`](../../.claude/docs/decisions/006-canvas-entity-foundation.md).

#### 9-3-1. 렌더 구조 (ViewportPortal 패턴)

```
<Canvas>                              ← viewport container (d3-zoom target, L0 surface)
  <ViewportContainer                  ← CSS transform: translate(x, y) scale(s)
    style={{ transform: `translate(${x}px, ${y}px) scale(${scale})` }}>
    <EntityLayer>                     ← lifecycle supervisor
      <Entity ... />                  ← canvas-space position
      <Entity ... />
    </EntityLayer>
    <OverlayLayer />                  ← 선택 박스, snap guides (추후)
  </ViewportContainer>
</Canvas>
```

- **Canvas-space coordinate**: Entity `position` 은 canvas 고정 좌표 (viewport transform 무관)
- **ViewportContainer**: CSS transform 1회로 pan/zoom 적용 (GPU 가속)
- **xyflow ViewportPortal + XYPanZoom 개념 차용** (ADR-001 기조, 의존성 없이 자체 구현)

#### 9-3-2. Entity State Model

```typescript
type EntityType = 'browser' | 'ide' | 'chat' | 'file-preview' | 'note' | 'gadget'
type EntityLifecycle = 'hydrated' | 'suspended' | 'static' | 'discarded'
type EntityDisplayState = 'covered' | 'spread' | 'full'

interface CanvasEntity<T extends EntityType = EntityType> {
  id: string
  type: T
  position: { x: number; y: number }     // canvas-space
  size: { w: number; h: number }
  zIndex: number
  lifecycle: EntityLifecycle
  displayState: EntityDisplayState
  snapshot?: string                       // screenshot data URL
  createdAt: number
  lastActiveAt: number
  typeProps: EntityTypePropsMap[T]        // type-specific extension
}
```

- Type-safe discriminated union (`EntityType`)
- Serializable (persistence 용이)
- `lifecycle` (메모리 상태) vs `displayState` (§7-4 시각 크기) 분리

#### 9-3-3. 4-State Lifecycle

| State | DOM | Memory | UI |
|-------|-----|--------|-----|
| **hydrated** | Live WebContentsView / Monaco / 실 컴포넌트 | 높음 | 정상 interactive |
| **suspended** | DOM teardown 중 + screenshot 캡처 중 | 감소 중 | pending screenshot |
| **static** | DOM 없음, `<img>` 만 표시 | image bytes only | 정적 이미지, click → reload |
| **discarded** | 완전 삭제 | 0 | 표시 안 함 |

**Transitions**:
1. create → hydrated (eager load, Chrome new tab 과 동일)
2. hydrated → suspended (중심점이 viewport 밖 + 3초 dwell)
3. suspended → static (screenshot 캡처 + DOM teardown 완료)
4. **static → hydrated: click/focus 만** (viewport in 만으로는 자동 hydrate 안 함)
5. any → discarded (Trash / 명시적 delete)

#### 9-3-4. Viewport Out 판정 (중심점 기준)

**핵심**: Entity 중심점이 viewport rect 밖 = "out". 부분 겹침 / 가장자리 판정 없음.

```typescript
// 1. 중심점 계산 (canvas space)
const entityCenter = {
  x: entity.position.x + entity.size.w / 2,
  y: entity.position.y + entity.size.h / 2
}
// 2. Canvas transform 적용 → screen coord
const screenCoord = {
  x: entityCenter.x * viewport.scale + viewport.translateX,
  y: entityCenter.y * viewport.scale + viewport.translateY
}
// 3. Viewport rect 밖 판정
const isOut =
  screenCoord.x < 0 || screenCoord.x > viewport.width ||
  screenCoord.y < 0 || screenCoord.y > viewport.height
// 4. 3초 이상 out 유지 → suspend trigger
// 5. Hysteresis: 3초 경과 전 재진입 시 timer 취소
// 6. Suspend 후 재진입은 static 유지 (click 필수)
```

- **IntersectionObserver 미사용** — canvas transform 직접 계산 (O(1), threshold 튜닝 불필요)
- EntityLayer supervisor 가 `requestAnimationFrame` 또는 viewport state 변경 시 전체 entity 재계산

#### 9-3-5. Screenshot Capture

| Entity Type | Capture Method |
|-------------|----------------|
| `browser` | `webContents.capturePage()` (Electron API) |
| `ide` (Monaco) | Monaco DOM → `html-to-image` |
| `chat`, `note`, `file-preview` | DOM → `html-to-image` |
| `gadget` | Gadget 자체 API or DOM capture |

- **타이밍**: `hydrated → suspended` 전환 직전
- **Storage (v1)**: in-memory Blob / base64 data URL (entity state `snapshot` 필드)
- **Storage (v2)**: FS cache (`userData/snapshots/${entityId}.jpg`, JPG q=0.7, max 1280px width, 평균 30-80KB)
- **공유 인프라**: PresetBag mini-map (ADR-005) 도 동일 capture hook 재사용

#### 9-3-6. Performance Policy (v1)

**Viewport-based, hard cap 없음**. 유저 원문 (2026-04-13): "viewport 안에 있는거는 살려야지"

| 상황 | lifecycle |
|------|-----------|
| Viewport 안 | hydrated (전부 live, 개수 제한 없음) |
| Viewport 밖 + 3초 dwell | suspended → static |
| Static 상태에서 viewport 재진입 | static 유지 (자동 hydrate X) |
| Static → hydrated 전환 | **Click/focus 만** |

- Hard cap / LRU forced suspend 없음
- Dev-mode memory warning: hydrated count > 20 시 console warning (v1)
- Tuning roadmap (v2): system RAM 감지 + zoom-out density threshold

#### 9-3-7. Entity Adapter Registry

각 entity type = thin adapter:

```typescript
interface EntityAdapter<T extends EntityType> {
  type: T
  hydrate: (entity: CanvasEntity<T>) => HydratedInstance
  suspend: (instance: HydratedInstance) => Promise<string>  // screenshot
  render: (entity: CanvasEntity<T>, instance?: HydratedInstance) => JSX.Element
  captureSnapshot: (instance: HydratedInstance) => Promise<string>
}

const entityAdapters: { [K in EntityType]: EntityAdapter<K> } = {
  browser: BrowserAdapter,
  ide: IDEAdapter,
  chat: ChatAdapter,
  // ...
}
```

- 각 type 은 별도 ADR (ADR-007+) 로 구체화

#### 9-3-8. Dock 드래그드롭 → Entity 생성

```typescript
interface EntityFactory<T extends EntityType> {
  createFromDockApp(
    appType: T,
    dropPosition: { x: number; y: number },  // canvas-space
    initialProps?: Partial<EntityTypePropsMap[T]>
  ): Promise<CanvasEntity<T>>
}
```

- §7-2 Dock 좌측 그룹 (Chat/Shelf/Browser/IDE/+) drag → Canvas drop → `EntityFactory.createFromDockApp(type, position)`
- Dock 중앙 그룹 (Canvas tools) 드래그 불가
- Click vs Drag (§7-2 L264): Click → Right HUD, Drag → Canvas Entity

---

### 빈 상태 UX (Empty State)

캔버스에 entity가 하나도 없을 때 표시하는 **passive hint layer**.
전용 컴포넌트/카드 형태가 아니라, 캔버스 위에 얕게 떠 있는 **4-Edge 참조 마커**.

#### 가이드 원칙

1. **Ambient 유지**: 힌트는 UI가 아니라 **종이 위에 연필로 얇게 그어둔 가이드선**.
   - opacity 0.35~0.4, L0 레이어 위 L0.5 정도 깊이
   - 첫 entity 배치 시 fade-out 400ms
2. **지시하지 않음**: "Click here to start" 같은 CTA 금지. 유저 선택지 3개를 평등하게 제시.
3. **Edge 참조만**: 힌트는 **이미 있는 Edge**를 가리키기만 함. 새로운 인터랙션 지점 생성 금지.

#### 구조 (3-Cue Layout)

뷰포트 중앙 정렬. 3개의 평등한 단서가 삼각 배치:

```
         ↑
     [Cue 1: Cmd+K]
     "Search or ask AI"

  ←                   ↓
[Cue 2: Preset]   [Cue 3: Chat]
"Drag from bag"   "Open from dock"
```

| Cue | 위치 | 방향 표시 | 메시지 | Edge 참조 |
|-----|------|-----------|--------|----------|
| 1 | 중앙 상단 (viewport center, y: 30%) | ↑ | `⌘K Search or ask AI` | Top Rail의 Search 영역 |
| 2 | 중앙 좌측 (viewport center, x: 30%) | ← | `Drag a preset to unpack` | Left PresetBag |
| 3 | 중앙 하단 (viewport center, y: 70%) | ↓ | `Open chat from dock` | Bottom Dock Chat |

**Right Edge 단서 금지** — HUD는 "invoked only" 원칙. 빈 상태에서 Right를 가리키는 건 모순.

#### 시각 스펙

| 요소 | 값 |
|------|-----|
| 텍스트 | Inter 12px, weight 400, color `var(--on-surface-variant)` (#5A5A5A) |
| opacity | 0.4 (기본), hover 0.6 |
| 방향 표시 | 12px 화살표 SVG, stroke-width 1px, 같은 opacity |
| 단서 간 라인 | **없음** (점선 금지 — 너무 주장적) |
| 배경 | 없음 (투명, paper-surface 그대로 비침) |
| 애니메이션 | 로드 시 400ms fade-in, 첫 entity 생성 시 400ms fade-out |

#### 인터랙션

- **클릭 가능 여부**: 단서 자체는 **클릭 안 됨** (decoration only).
  - "Cmd+K Search"를 읽은 유저가 **실제 ⌘K를 누르면** 작동.
  - "Drag preset"을 읽은 유저가 **실제 PresetBag을 드래그**하면 작동.
  - = 힌트는 교육용 레이블, 액션 포인트는 Edge 자체.
- **재등장 조건**: 모든 entity가 삭제되어 캔버스가 다시 비면 재등장 (400ms fade-in).
- **숨김 유저 설정**: v1은 자동만. v2+에서 "힌트 끄기" 유저 설정 검토.

#### 금지 사항

- **Modal/팝업 금지** — 빈 상태는 Modal로 덮지 않음. 배경에 얕게 그어두기만.
- **CTA 버튼 금지** — "Start" / "Create" / "Get started" 같은 버튼 만들지 않음.
- **애니메이션/모션 강조 금지** — 화살표 pulse, 글자 깜빡임, 스케일 전환 등 주의 환기 모션 금지.
- **이모지/일러스트 금지** — 🎨 같은 이모지, 캐릭터 삽화, 배경 그림 전부 금지.
- **환영 메시지 금지** — "Welcome to EG-Desk!" 류 온보딩 헤드라인 금지 (Ontology Bridge 철학 위반).
- **진행률 indicator 금지** — "0/3 단서 완료" 같은 게이미피케이션 금지.

#### 구현 노트 (v1)

- 컴포넌트: `src/renderer/src/components/EmptyCanvasHints.tsx` (예정)
- DeskHome에서 `entities.length === 0` 조건으로 렌더
- v1에서는 entity state가 아직 없음 → **항상 표시**로 시작 (`isEmpty={true}` 하드코딩). entity 시스템 도입 시 조건 추가.
- z-index: canvas-surface(L0) 위, Edge System(z-40) 아래 → `z-10` 권장
- pointer-events: `none` (캔버스 스크롤/팬 방해 안 함)
- i18n: 텍스트는 영문 유지 (designMd 기준). 추후 i18n 대응 가능하게 문자열 상수화 권장.

### 시점
- **Mission Impossible 시점**: 위에서 아래로 내려다봄 (overhead)
- 모든 객체가 평면에 놓인 것처럼 보여야 함
- 원근감 없음, isometric 아님, 순수 top-down

---

## 10. Design Spec (디자인 도구용 시스템 명세)

### 10-1. Figma MCP 워크플로우 (현행)

**도구**: Figma MCP (`https://mcp.figma.com/mcp`)
**역할 분리**:
- PM: 무엇을 만들지 지시 + 결과 리뷰 (Gemini CLI 등)
- design-agent: Figma MCP를 통한 실제 화면 생성/수정

**Figma 프로젝트 구성**:
- 프로젝트명: EG-Desk Surface
- 페이지 구성: design-agent가 관리 (Naming: `[UI] Layer N: 화면명 vN`)
- 디자인 시스템: 아래 Section 10-2의 designMd를 Figma 컴포넌트/스타일로 반영

### 10-2. designMd (디자인 도구에 전달할 시스템 명세)

> 아래 내용은 도구에 무관하게 유지되는 디자인 시스템 정의입니다.
> Figma, Stitch, 또는 기타 도구에 전달할 때 이 텍스트를 기준으로 합니다.

```
EG-Desk Surface Design System

CONCEPT: Ambient AI workspace — a physical desk seen from above (Mission Impossible overhead perspective). Objects are placed on an infinite spatial canvas. AI is invisible until invoked.

MODE: LIGHT only. Warm off-white surface (#F5F3EF) with subtle paper/noise texture. White elevated cards (#FFFFFF).

VISUAL HIERARCHY (4 layers):
- L3 (Control): Edge System (Desk Rail + Dock + Preset Bag + Right HUD) — frosted glass bars/panels, strongest shadow, floating 12-24px from edges
- L2 (Focus): Spread/Full cards — glow border, medium shadow, active work
- L1 (Objects): Covered cards — flat thumbnails, subtle shadow, desk items
- L0 (Space): Canvas surface — paper texture, no shadow, ground plane

SURFACE: Clean, calm, paper-like with very subtle noise texture for "floor" feel. No grid, no dark backgrounds. Minimal chrome. The desk surface is the protagonist.

CARDS: Every object is a content-preview card (NOT an icon). Browser tabs show full webpage screenshots filling the entire card (NOT icons or text labels). PDFs show first page, Excel shows cell grid, etc. All cards have 8px border-radius, subtle shadow, NO tilt/rotation (rotation: 0deg always). In design mockups, render cards at 280-320px width for content legibility.

EDGE SYSTEM (4-Edge Framework — all 4 edges confirmed):

TOP = DESK RAIL: Frosted glass capsule floating 16-24px from top (NOT touching screen edge). Background: rgba(255,255,255,0.6) + backdrop-filter: blur(20px) saturate(180%). Double shadow: 0 4px 6px rgba(0,0,0,0.02), 0 20px 40px rgba(0,0,0,0.08). Border: 1px solid rgba(255,255,255,0.4). Width 60-70% viewport, height 48px, border-radius 24px. Left: macOS traffic lights + Desk name/switcher. Center: Cmd+K search trigger. Right: canvas minimap icon + notifications bell + profile avatar. Minimap click = popup showing full canvas overview + draggable viewport rectangle for navigation (StarCraft minimap style). Cmd+K opens a separate Spotlight popup at screen center (not inline). Desk Rail = desk-level meta, highest abstraction.

BOTTOM = DOCK: Frosted glass bar floating 12-16px from bottom, horizontally centered. Same glass treatment as Desk Rail. Width is CONTENT-AWARE (auto-sized by icon count, capped at `min(95vw, 960px)`, min ~140-160px) — Dock is the only Edge that adapts to content because it hosts a mix of object-axis (apps/gadgets, user-customizable) and meta-axis (canvas tools) icons. Height 48-56px, border-radius 16px. Three groups separated by thin dividers. LEFT GROUP (4 icons): Chat/Agent + Shelf/Library + Browser + Quick Create (+). CENTER GROUP (4 icons, v2 per ADR-004): Canvas tools — Pencil, Hand/Pan, Square, Arrow/Pointer (state-toggle, one active at a time, Figma-style). RIGHT GROUP (1 icon): Trash. Left/Right group icons have DUAL MODE: click = opens Right Edge HUD panel (lightweight, agent config only), drag-to-canvas = creates Canvas Entity card (heavy context — auto-parses entities sufficiently visible in current viewport only, NOT entire canvas; proximity = relevance). Center group icons are state-toggle only (no drag). Dock hosts two ontology axes: object-axis (apps/gadgets in left/right) + meta-axis (canvas tools in center). No time widget in Dock — timer/alarm is a separate canvas gadget.

LEFT = PRESET BAG: Frosted glass panel floating 12px from left edge. Width 48-56px collapsed (icons only), 280px expanded. Height 70-80% viewport, border-radius 12px. Contains saved entity combination presets (files + tabs + apps + gadgets). Bidirectional drag-drop: PACK (canvas multi-select → drag to bag = save as preset) and UNPACK (drag preset to canvas = deploy all entities at once). Metaphor: packing your bag before leaving, unpacking it when you arrive at your desk.

RIGHT = CONTEXTUAL HUD PANEL: Frosted glass panel floating 12px from right edge. Width 320-400px, height 70-80% viewport, border-radius 12px. Content changes based on which Dock app was clicked. Chat/Agent click = chat panel with agent config only (lightweight). Browser click = dev console. File click = file properties. This is NOT a permanent toolbar — it appears when a Dock app is clicked and dismisses when another area is focused.

TYPOGRAPHY: Inter for all text. Clean, technical, high readability. No decorative fonts.

COLOR: Primary #2D5A7B (deep blue-teal). Outline #D4D0CA (warm gray borders). On-Surface #1A1A1A (text). No neon, no gradients, no aurora effects.

SHAPE: Rounded but not playful — 8px cards, 12px panels, 24px Desk Rail, 16px Dock. No 3D transforms, no perspective effects.

TONE: Professional, calm, organized. Like a well-kept architect's desk — everything has its place. Minimalist but not sterile. Warm but not casual.

FORBIDDEN: Dark mode, card tilt/rotation, 3D effects, gradients, neon colors, decorative fonts, persistent chat windows, cluttered toolbars, Edge bars touching screen edge, more than 5 elements per Edge (EXCEPTION: Dock allows up to 12 total in 3-group structure per ADR-004 — 5 per group max), separate floating Canvas Toolbar layer (Superseded v1 per ADR-004 — canvas tools now live in Dock center group), time widget in Dock (timer/alarm is a canvas gadget).
```

### 10-3. Stitch 레거시 참고 (더 이상 사용하지 않음)

> **전환 사유 (2026-04-09)**:
> 1. 화면 삭제 불가 — 프로젝트에 불필요한 화면이 영구 누적
> 2. 디자인 시스템 삭제 불가 — 자동 생성된 디자인 시스템이 원본과 충돌
> 3. `edit_screens`가 수정이 아닌 복사본 생성 — 타임아웃 재시도 시 영구 중복 오염
> 4. Stitch 내부 Gemini가 design-agent template 규칙(designMd, Reference Screen Protocol 등)을 무시
>
> **Stitch 프로젝트 정보 (레거시)**:
> - Project ID: `10841290246103418659`
> - Design system "EG-Desk Surface" asset ID: `14309079358425296415`
> - 마지막 화면: v13 (`cd53ad80e5394afb91e531726f764fda`), v14 (`1ab3a1fe06464da5a466ee4f884d8c17`)

---

## 11. 변경 이력

| 날짜 | 변경 | 사유 |
|------|------|------|
| 2026-04-09 | 초기 작성 | v4-v6 피드백 종합. LIGHT 확정, tilt 금지, HUD 구조 |
| 2026-04-09 | HUD 중앙 시간 위젯 제거 | 시간 위젯 → 타이머/알람 gadget (캔버스 위 독립 객체) |
| 2026-04-09 | 채팅/에이전트 HUD 이동 | 채팅/에이전트는 캔버스 객체가 아닌 HUD 상시 도구. 말풍선 아이콘 → 패널 → 전체화면 3-State. 캔버스에서 에이전트 아바타 제거 |
| 2026-04-09 | Visual Hierarchy L0-L3 추가 + HUD frosted glass 스펙 | Gemini 피드백 반영. HUD: rgba(0.6)+blur(20px)+saturate(180%), 상단 16-24px 띄움. Cmd+K → Spotlight 분리. Covered 카드 시안 기준 280-320px |
| 2026-04-09 | HUD → 4-Edge Framework (Edge System) 전환 | 유저 피드백: 상단에 너무 몰림. Gemini+Codex 브레인스토밍 → Top=Desk Rail(meta), Bottom=Dock(도구+Chat). Left/Right 보류. Library/Shelf/Explorer 계층 정리. Bell을 Top으로 이동. Chat을 Bottom Dock으로 이동 |
| 2026-04-09 | Right Edge = Contextual HUD Panel 확정 + HUD/Entity 이중 모드 | Dock 앱 클릭→Right HUD(경량), 캔버스 드래그드롭→Entity(중량). Chat/Agent의 context 로딩 차이: HUD=system prompt only, Entity=viewport entity auto-parse. 문서 상태 brainstorming으로 수정 |
| 2026-04-09 | Left Edge = Preset Bag 확정. 4면 모두 확정 | 가방 메타포. entity 조합 프리셋 저장 → 캔버스에 드래그드롭으로 한꺼번에 배치. Top=Desk Rail, Bottom=Dock, Left=Preset Bag, Right=Contextual HUD |
| 2026-04-09 | 디자인 도구 Stitch → Figma MCP 전환 | Stitch 한계: 화면/디자인시스템 삭제 불가, edit_screens 복사본 생성, 타임아웃 시 영구 중복 오염, 내부 Gemini가 template 규칙 무시. Figma MCP로 전환하여 수정/삭제 자유도 확보 |
| 2026-04-12 | §9에 "빈 상태 UX" 섹션 추가 | 3자 리뷰(opus+Gemini+Codex) P1 피드백 "빈 캔버스 어포던스 부족". 3-Cue passive hint 패턴으로 정의. Ambient 원칙/Ontology Bridge 준수 |
| 2026-04-12 | §9-1 "캔버스 도구 (Canvas Toolbar)" 신규 섹션 추가 + §7-2 Dock 보강 + §10-2 FORBIDDEN 업데이트 | 유저 관찰 "연필 등 캔버스 도구는 Dock에?" 질의에 대한 PM 분석 결과. Option B(캔버스 floating toolbar) 채택. 근거: Dock ontology(앱 launcher) 보호, Ambient 원칙 강화, infinite canvas 레퍼런스(Figma/Excalidraw) 일관성, Ontology 3축 분리(객체/장소/메타). v1 4개 도구(선택/연필/주석/지우개), L2 레이어, Dock 위쪽 24px floating |
