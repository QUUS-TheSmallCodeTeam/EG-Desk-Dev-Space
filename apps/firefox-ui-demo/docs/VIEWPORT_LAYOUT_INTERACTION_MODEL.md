# Viewport Layout and Interaction Model

**Date**: 2026-05-19
**Status**: Product/runtime architecture decision note
**Scope**: EG-Desk Firefox shell, viewport chrome, safe area, HUD visibility, card presentation modes, runtime diagnostics

> **Terminology correction (2026-08-05):** `runPlayback` and `Run Playback`
> below are legacy implementation labels. Current product meaning is Answer
> Briefing under Contract §8 and Atlas `OBJ-038` / `AI-05`; viewport guidance is
> retained only where it implements the selected Briefing Step's Focus Scope.

**Approved desktop style (2026-10-20):** [screenshot](./egdesk-approved-desktop-style.jpg)
and [interactive HTML proposal](./egdesk-approved-desktop-style.html).
Preserve its *style* and recognisable shell roles, not its example content as
product truth. The Firefox runtime CSS owns the accepted `--egd-*` colors and
surfaces: wood `#E8E2D7` with restrained photographic grain, topbar
`#F9F8F4`, opaque window `#FFFEFA`, text `#252A26`/`#646A61`, sage
`#49634F`, fine borders `#DEDFD8`/`#EAEAE4`. Avoid mechanical HUD grids,
floating bottom content tabs, and always-on metric numbers.

---

## Core Sentence

```text
Canvas is the infinite work world.
Viewport is the user's current camera into that world.
Board is the active work region visible through the viewport.
Cards and annotations are canvas entities.
HUD, rail, dock, and bag are viewport chrome.
```

The viewport layer decides what the user sees now, what controls are allowed to overlap work, and who owns input.

It must not rewrite the saved canvas layout unless the user explicitly commits a layout change.

---

## Top Bar Meaning

The approved shell keeps a flush, full-width 52 px topbar: macOS window
controls and a compact EG-Desk/Board entry at left, working search in the
center, and account plus a tiny four-mark resource gadget at right. The Board
entry answers which work region is selected; the brand is not a profile hero
or a replacement for Board context. This newer visual decision supersedes the
older suggestion to make the entire topbar a large Board heading.

The resource gadget is viewport chrome, so Canvas pan/zoom never moves it or
changes focus when detail opens. Its real protected bridge values are scoped:
CPU across logical cores, memory as total minus OS-free **including reclaimable
cache**, disk storage of the EG-Desk data volume, and network receive/transmit
rates of the reported interface. No network percentage, no fabricated zero
while unavailable, and no login requirement for local host metrics. Details
appear on demand below the four quiet rings and close on Escape/outside
interaction. A sample older than 15 seconds is unmeasured, not a held value.

The left preset rail stays a narrow floating 64px surface over the Desk, with
line icon over 11px label and a distinct current Desk/file hierarchy. It is
not a fixed full-height sidebar. Preserve the actual preset entries and their
current behaviors; the proposal's smaller list is not a replacement catalog.
The bottom Dock retains **all** real tool groups and actions, but its icons
share one restrained outline grammar with the rail, topbar, and window headers.
The lower-left camera control is a 35px `− / percent / + / fit` group. Buttons
use the existing Canvas camera math, native keyboard activation, and do not
start a Canvas pan gesture. Fit only changes the camera to encompass current
visible Desk Windows; it does not rewrite their saved world coordinates.

---

<a id="viewport-agenda-detection"></a>
## Viewport Board Detection

When the viewport overlaps one or more Board regions, the top bar should resolve the visible Board context.

Default ranking:

```text
1. activeAgendaId if it is visible in the viewport
2. Board region with largest viewport intersection
3. Board containing the active card
4. most recently focused Board
5. Desk-level fallback
```

Display examples:

```text
EG-Desk Board
태화 5월 리포트
UI 리뷰 / 채팅 HUD
3 Boards in view
No active Board
```

If multiple Boards are visible, the top bar should show the primary one plus a compact indicator:

```text
태화 5월 리포트 · +2
```

Clicking the compact Board entry should open a Board switcher, not a Desk
selector by default. Selecting a Board changes the viewport camera into the
same Desk world; it does not remove other Boards or Chat views.

---

## Viewport Chrome

Viewport chrome is everything fixed to the screen rather than the canvas world:

```text
Viewport Board Rail   // top bar
Desk Minimap          // map of the wider canvas/Desk
Dock                  // bottom command surface
Preset Bag            // left quick-access surface
HUD                   // right contextual panel
Modal / Drawer        // temporary viewport overlays
Zoom indicator        // debug/product status depending on mode
Diagnostics panel     // developer/runtime inspection
```

Chrome is presentation state. It should be independent from committed Card/Board layout.

---

## Desk Minimap

The minimap is the user's map of the wider Desk/canvas.

The Viewport Board Rail answers:

```text
"What Board am I looking at right now?"
```

The Desk Minimap answers:

```text
"Where am I in the larger Desk?"
```

The minimap should show:

- current viewport rectangle
- Board regions
- card clusters
- active card
- maximized/focused card indicator
- offscreen result/playback targets when relevant

It should not be a second HUD. It should be a compact navigation affordance that can expand on demand.

Default states:

```ts
type MinimapMode =
  | "hidden"
  | "compact"
  | "expanded"
  | "focusTarget";
```

Policy:

```text
normal viewport
  -> compact minimap button or small minimap affordance

large canvas navigation / zoomed out work
  -> expanded minimap allowed

maximized card
  -> compact/off by default, but active maximized card/window is indicated in rail

focus fullscreen
  -> hidden, with temporary edge/shortcut reveal only if needed

run playback
  -> minimap can show the next/previous offscreen step target
```

Minimap interaction:

```text
click minimap button
  -> open compact/expanded minimap

click a Board region
  -> pan/zoom to that Board

drag viewport rectangle
  -> pan canvas

click active card marker
  -> focus active card

type a name in the minimap search
  -> open Boards and Views whose name matches, off screen included
  -> each row names its kind (Board / 브라우저 / 대화 / 파일 / 터미널 …) and,
     for a View, the open Board it belongs to
  -> choosing a row pans the camera only (no zoom, Board or run target change)

several targets under one press
  -> '이 위치의 N개' list, rows named the same way
```

Rail search Canvas results follow the same rule: a chosen card is activated and,
when it sits off screen, the camera pans to reveal it; its subtitle names the
open Board it belongs to.

The minimap should use Desk/canvas world coordinates and should not change saved card geometry.

---

## Safe Area

Safe area is the part of the viewport available for focused work.

```text
viewport bounds
- top Board Rail
- bottom Dock
- left Preset Bag
- visible HUD, if pinned
- modal/drawer exclusions
- margins
= safe work area
```

Safe area is used for:

- new card placement
- card focus
- maximize
- run playback focus steps
- empty-space search
- guided annotation focus

The minimap is viewport chrome, but compact minimap affordances should be excluded from safe-area subtraction unless expanded. A tiny minimap button should not shrink maximized cards.

Safe area should not be used to automatically move ordinary cards every time chrome changes. It is a placement and presentation policy, not a background layout mutator.

---

## Runtime Health Surface

Raw helper status should not be shown as always-visible product UI.

Bad product surface:

```text
헬퍼: 재연결 중
```

Reason:

- `helper` is an implementation detail.
- Always-visible reconnect text makes the product feel broken.
- Some helpers are optional or have graceful fallbacks.

Default policy:

```text
Global product UI
  -> hide helper/bridge/MCP implementation status

Affected card or tool
  -> show user-readable unavailable/retry state only when the feature is blocked

Diagnostics panel
  -> show detailed helper/bridge/MCP state for development and troubleshooting
```

Examples:

```text
Terminal helper down
  -> terminal card says "터미널 연결 중" or "터미널을 시작할 수 없습니다"

Codex bridge down
  -> chat composer says "AI 연결 재시도 중"

Gesture helper down
  -> no visible product status; fallback interaction remains active

Firefox MCP disconnected
  -> diagnostics only; never normal product UI
```

The always-visible helper reconnect pill should move behind diagnostics or be hidden outside development mode.

---

## Card Presentation Modes

Card presentation is viewport state, not saved card layout.

At semantic outline size, a live View remains mounted at the same world
geometry. Its screen-space proxy uses a centered type glyph plus a modest
readable title and source when known; clicking still focuses the original live
View. This visual treatment does not change the detail/outline/marker thresholds.

```ts
type CardPresentationMode =
  | "normal"
  | "maximized"
  | "focusFullscreen";
```

### Normal

```text
Card uses saved canvas/world geometry.
Viewport chrome remains visible.
HUD can open normally.
```

### Maximized

Maximized means the card uses the viewport's safe area while preserving restore geometry.

Policy:

```text
enter maximize
  -> save restoreRect and zIndex
  -> hide HUD by default
  -> keep Board Rail / Dock / Preset Bag visible
  -> fit card into safe area without HUD
  -> do not overwrite saved CardState geometry

exit maximize
  -> restore card rect and zIndex
  -> restore prior HUD state only if user explicitly had it open
```

HUD should be hidden, not minified. Minified HUD still takes visual attention and obstructs the intent of maximize.

Maximized state still needs a clear window/card indicator. Since the HUD is hidden, the user must be able to tell which card is currently maximized and how to exit or inspect it.

Preferred behavior:

```text
Viewport Board Rail
  -> shows active Board
  -> also shows maximized card title/type badge
  -> includes a compact "Maximized" state badge

Maximized card header
  -> may remain visible if it does not fight the content
  -> should expose restore/exit affordance

Focus fullscreen
  -> uses a minimal temporary indicator only on pointer move, shortcut, or edge hover
```

The indicator should identify the active card/window without becoming another HUD. It should be small, stable, and tied to viewport chrome.

Example:

```text
태화 5월 리포트 / Report Card · Maximized
EG-Desk Board / Terminal · Maximized
```

### Focus Fullscreen

Focus fullscreen means the card becomes the whole working screen.

Policy:

```text
enter focus fullscreen
  -> save restoreRect and zIndex
  -> hide HUD / Board Rail / Dock / Preset Bag
  -> card covers full viewport
  -> show only essential escape affordance if needed

exit focus fullscreen
  -> restore previous presentation mode
  -> restore viewport chrome
```

This is stronger than maximize and should be used for distraction-free work.

---

## HUD Visibility While Maximized

HUD should be hidden by default during maximize.

```ts
type HudPresentationMode =
  | "normal"
  | "hiddenForMaximize"
  | "peek"
  | "pinned";
```

### Hidden For Maximize

Default maximized state.

```text
HUD is absent from the visible viewport.
Card uses safe area as if HUD is closed.
```

### Peek

Temporary overlay.

Triggers:

- right edge hover
- agent/avatar/run chip click
- inspect shortcut
- notification click

Policy:

```text
HUD overlays the card
card is not resized
outside click / mouse leave / Esc hides HUD again
```

### Pinned

Explicit user choice.

Policy:

```text
HUD remains open
maximized card safe area is recalculated
restoreRect remains unchanged
```

Pinned HUD during maximize is allowed, but it must be explicit.

---

## Chrome Mode

```ts
type ViewportChromeMode =
  | "normal"
  | "maximizedCard"
  | "focusFullscreen"
  | "runPlayback";
```

Mode effects:

| Mode | Board Rail | Minimap | Dock | Preset Bag | HUD |
|---|---|---|---|---|---|
| `normal` | visible | compact | visible | visible | user state |
| `maximizedCard` | visible | compact/off | visible | visible | hidden by default |
| `focusFullscreen` | hidden | hidden | hidden | hidden | hidden |
| `runPlayback` | visible or compact | focus target | visible or compact | optional | hidden unless step needs it |

Run Playback may temporarily adjust chrome to keep the step target readable.

When `ViewportChromeMode` is `maximizedCard`, the viewport should expose the active maximized card/window identity through a compact indicator in the Board Rail or an equivalent edge affordance.

---

## Auto Layout Policy

Automatic layout should be conservative.

Do auto-place/reflow for:

- new cards
- focus existing card
- maximize / focus fullscreen
- Run Playback step focus
- annotation walkthrough focus
- pinned HUD while a card is maximized

Do not auto-move:

- ordinary user-placed cards
- accepted Board layout
- cards outside the active interaction
- saved geometry just because HUD opens/closes

This distinction prevents EG-Desk from feeling like it is fighting the user's spatial memory.

---

## Placement Operations

UX-05 (decision D-V5). Placement is the one layout mutation the user commits
explicitly; these operations make it precise and reversible without the
Canvas ever rearranging Views on its own.

```text
snap while dragging or resizing
  -> 24px grid, and the edges/centres of other Views and Board regions
  -> reach is 8 screen px (so 16 world px at 50%, 4 at 200%)
  -> a side-by-side neighbour docks 24px away instead of stacking
  -> Option/Alt held: no snap, for as long as it is held
  -> guide lines show on the snapped axis and fade right after release

layout undo
  -> one gesture (drag, resize, arrange, group) = one step, 50 steps kept
  -> ⌘/Ctrl+Z undoes, ⌘/Ctrl+Shift+Z redoes, only while the View bar
     (a card's title row), the Canvas or nothing has focus
  -> text inputs, Terminal and Browser content keep their own ⌘/Ctrl+Z
  -> a step whose Views moved, resized or closed since is dropped, not applied

[선택 N개 겹침 없이 정리]
  -> the selected Views keep their sizes and reading order and pack in rows
     24px apart inside the safe area; a group moves as one block
  -> Views not selected and other Boards' regions are obstacles

[그룹으로 묶기] / [그룹 해제]
  -> a visual bundle that moves and selects together (dashed frame)
  -> separate from Board membership; saved with the Desk, not with a Board
  -> closing a View drops it from its group; a group of one dissolves

[이동…] / [크기…]
  -> x, y or width, height typed in Canvas px, applied as typed (no snap)
  -> a group moves with the View; sizes never go below the View's minimum
```

The placement menu opens on right-click on a View bar, or on the empty
Canvas while something is selected.

Implementation anchors:

```text
EGDeskCanvasLayout.sys.mjs
  -> snapCanvasRect, snapGuideScreenBoxes, createLayoutHistory,
     arrangeWithoutOverlap, arrangeInVisibleArea, createCanvasGroup,
     dissolveCanvasGroups, canvasGroupFrames, parsePlacementInput (pure)

installCanvasPlacementOps()  (eg-desk-surface.uc.js, after installCanvasPanZoom)
  -> one layer over every card type's own titlebar/resize listeners:
     watches the dragged card's style during the pointer gesture and
     rewrites the raw rect to the snapped one before paint, moves the rest
     of the group, records the step; owns the menu, the dialog and ⌘/Ctrl+Z

serializeDeskSnapshot().groups / restoreDeskSession()
  -> groups travel with the Desk record (ids remapped on restore)
```

---

## Board Membership of Shapes and Keyboard Placement

CNV-03 (D-V1~V3, inferred default while the owner has not ruled on shapes):

```text
Board members      -> windows only (Browser, File, Chat, Terminal, memo, …):
                      one window, one Board; shown on its title row;
                      '○○에 넣기 / 빼기' and the drop suggestion apply
Canvas shapes      -> never Board members: no title-row Board label, no
                      넣기/빼기, no drop suggestion, not taken by
                      [선택한 화면 N개 저장]
a shape inside a Board area
                   -> seen there because of where it lies (position only);
                      it is saved with the Desk record (snapshot.shapes) and
                      moves only when the user moves it
older Board records with shape members (kind 'shape')
                   -> still restore as before; nothing new is written that way
```

UX-05 keyboard placement (D-V5), from a focused window title row (Tab
reaches the row; its buttons are the next Tab stop, arrows move between them):

```text
←↑→↓               -> one 24px grid cell (an off-grid window first lands on
                      the grid line ahead); [맞춤] off: plain 24px steps
Shift + arrow      -> five cells (120px)
Option/Alt + arrow -> 1px, no grid (the same release as dragging)
Shift + Space      -> add this window to the selection or take it out
                      (the keyboard path of Shift+click)
each press         -> one layout undo step; ⌘/Ctrl+Z on the row undoes it
```

Windows a Briefing is reading, then windows an Agent is working in, keep
their own off-screen edge dot before the nearest others fold into '+N'.

Rules: `overlay/resources/surface/EGDeskSurfaceKeys.mjs` (pure).

---

## Interaction Ownership

Input ownership is determined by gesture start, current viewport mode, and the
active Desk Window adapter policy. The common Desk Window Shell owns only titlebar,
window-control, resize-handle, focus, and presentation gestures. It does not
reinterpret an adapter's content gestures.

```text
card body
  -> card owns scroll/text/native interaction

card header
  -> card move / presentation toggle

canvas empty space
  -> canvas pan, zoom, marquee, or shape draw

HUD
  -> HUD scroll/click/input

Dock / Rail / Bag
  -> viewport chrome commands

Run Playback overlay
  -> previous/next/comment/add-to-next-Chat/exit controls
```

Wheel policy:

```text
wheel on native-content / document-ui card
  -> adapter content scroll

wheel outside card
  -> canvas pan/zoom policy

cmd + wheel
  -> active card command when explicitly owned; otherwise canvas-level command

wheel inside ontology stage
  -> ontology active-cell pan

cmd/ctrl + wheel inside ontology stage
  -> ontology active-cell zoom

time and layer changes
  -> click targets only

HUD peek overlay
  -> HUD owns wheel while pointer is inside HUD
```

Desk Window adapter policies:

| Policy | Windows | Viewport interaction rule |
|---|---|---|
| `native-content` | Browser, Terminal | content owns pointer, wheel, selection, and keys after card activation |
| `adapter-owned` | Ontology | stage owns its camera and semantic navigation gestures |
| `document-ui` | Settings | chrome-DOM controls own ordinary form and scroll input |

Shared conflict rules:

```text
gesture starts on titlebar
  -> shell move; adapter does not receive the drag

gesture starts on resize target
  -> shell resize; adapter receives only the resulting size notification

gesture starts in Desk Window body
  -> adapter policy wins; the Desk Window never moves

pan modifier starts on shell or permitted activation overlay
  -> Desk camera may claim the gesture

fullscreen/maximized Desk Window
  -> same ownership rules; presentation mode does not rewrite adapter input
```

Keyboard policy:

```text
focused input/terminal/card
  -> focused surface owns ordinary keys

global command shortcut
  -> viewport command layer

Esc
  -> closes topmost temporary state:
     HUD peek
     modal
     run playback overlay
     focus fullscreen
```

---

## Implementation Notes

Current implementation anchors:

```text
spawnDeskWindowShell()
  -> live shared Browser/Ontology window frame and lifecycle
  -> owns titlebar drag, eight-way resize, maximize/restore, sourceRef, and cleanup

safeViewportRect()
  -> should become the shared safe-area resolver

card fullscreen functions
  -> should split into maximized vs focusFullscreen semantics

installNativeGestureHelperBridge()
  -> should stop creating always-visible helper status in product mode

buildDeskRail()
  -> should become Viewport Board Rail
  -> should indicate active maximized card/window when CardPresentationMode is maximized
  -> existing minimap button should open the Desk Minimap, not a generic panel
```

The existing label `메인 데스크` should be treated as a temporary placeholder. The target behavior is Board-in-viewport display.

---

## Acceptance Checks

The model is aligned only if:

- The top bar tells the user which Board they are looking at, not merely which Desk exists.
- The minimap lets the user understand where the current viewport sits in the larger Desk.
- Helper/bridge/MCP internals are hidden unless a feature is blocked or diagnostics are open.
- Maximized cards hide HUD by default.
- Maximized card/window identity is still visible through a compact indicator.
- HUD peek overlays without reflow; HUD pinned reflows only the maximized card.
- Focus fullscreen hides all viewport chrome.
- Safe area is used for placement and presentation, not for arbitrary movement of user-placed cards.
- Snapping, arrange and groups change geometry only inside a user gesture or menu action, and every such change can be undone from the View bar.
- Card presentation state does not overwrite saved CardState world geometry.
- Run Playback can guide the viewport without flooding the canvas.
