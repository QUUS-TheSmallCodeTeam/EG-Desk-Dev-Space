# Viewport Layout and Interaction Model

**Date**: 2026-05-19
**Status**: Product/runtime architecture decision note
**Scope**: EG-Desk Firefox shell, viewport chrome, safe area, HUD visibility, card presentation modes, runtime diagnostics

> **Terminology correction (2026-08-05):** `runPlayback` and `Run Playback`
> below are legacy implementation labels. Current product meaning is Answer
> Briefing under Contract §8 and Atlas `OBJ-038` / `AI-05`; viewport guidance is
> retained only where it implements the selected Briefing Step's Focus Scope.

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

The top bar should not primarily display "Desk".

The Desk is the computer-level work surface. It is too broad for the top viewport bar.

The top bar should display the Board or Board slice currently in the viewport.

Preferred product model:

```text
Top bar = Viewport Board Rail
```

It answers:

```text
"What work room / Board am I currently looking at?"
```

Not:

```text
"Which computer/Desk is this?"
```

The Desk identity can exist in a lower-priority menu, settings surface, profile, or environment switcher. It should not be the first large label in the active working viewport.

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

Clicking the label should open a Board switcher, not a Desk selector by default.

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
```

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
- Card presentation state does not overwrite saved CardState world geometry.
- Run Playback can guide the viewport without flooding the canvas.
