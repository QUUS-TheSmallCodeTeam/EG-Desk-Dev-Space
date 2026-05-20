# Desk, Agenda, and Card Runtime Model

**Date**: 2026-05-18
**Status**: Product/runtime architecture decision note
**Scope**: EG-Desk Firefox shell, Desk canvas, Agenda state, Card lifecycle, search, local index, input ownership

---

## Core Vocabulary

EG-Desk should not expose Codex-style "project = folder" as the primary user concept.

```text
Library = long-term searchable catalog
Desk    = computer-level live work surface
Agenda  = work + execution environment pairing
Card    = view/runtime surface on the Desk
```

Desk should feel like using "my computer as a desk", not a separate virtual universe. Internally, Desk is a projection over OS, browser, process, file, account, and agent resources.

Supported Desk backend kinds:

```text
local-computer
ssh-computer
remote-desktop-computer
sandbox-computer
```

A browser profile is not a Desk. Browser profile, container, and account are runtime bindings inside a Browser Card, so one Desk/canvas can contain multiple browser profiles or accounts at once.

---

## Agenda Model

Agenda is not a todo list and not a folder. It is the work boundary that pairs a task with the execution environment needed to do it.

```text
Agenda
  browser cards
  file cards
  chat cards
  terminal cards
  agent/context bindings
  account/profile bindings
  result cards
```

Agenda can be nested, but the product should treat this as a work decomposition graph, not a folder tree. Deep nesting can exist in the data model, while the Desk UI shows the active slice.

On an infinite canvas, an Agenda is distinguished by:

```text
Agenda Header Card
Agenda Region
Member Cards
Focus Mode
Collapse/Expand to an Agenda Card
```

---

## Saved State vs Dirty Overlay

The active Desk view is the composition of saved Agenda state plus unsaved canvas changes.

```text
Agenda saved state
+
Canvas dirty overlay
=
current work surface
```

Dirty overlay contains changes that are currently "on top of" the Agenda but not yet committed to it:

```text
new cards
moved cards
resized cards
temporary result cards
opened sourceRefs
```

When an Agenda is closed and dirty overlay exists, the user should be asked:

```text
save changes
discard changes
continue editing
```

---

## Desk, Viewport, and Card State

Desk stores persistent work-surface state.

```ts
type DeskState = {
  pan: { x: number; y: number };
  zoom: number;
  activeAgendaId?: string;
  activeCardId?: string;
  openCards: CardState[];
};
```

Agenda stores committed work state.

```ts
type AgendaState = {
  id: string;
  title: string;
  region?: Rect;
  memberCardIds: string[];
  contextBindings: ResourceBinding[];
};
```

Card stores world/canvas coordinates, not viewport coordinates.

```ts
type CardState = {
  id: string;
  type: "agenda" | "browser" | "file" | "chat" | "terminal" | "ppt" | "excel" | "notes";
  x: number;
  y: number;
  width: number;
  height: number;
  zIndex: number;
  sourceRef?: SourceRef;
  runtimeState?: Record<string, unknown>;
};
```

Canvas shapes and AI annotations should be modeled as work objects over the Desk, not as pixels baked into a card.

```ts
type CanvasPrimitive =
  | { type: "rect"; x: number; y: number; width: number; height: number }
  | { type: "ellipse"; x: number; y: number; width: number; height: number }
  | { type: "line"; from: { x: number; y: number }; to: { x: number; y: number } };

type AnnotationBinding = {
  id: string;
  targetCardId?: string;
  sourceRunId?: string;
  primitive: CanvasPrimitive;
  status: "proposed" | "accepted" | "edited" | "dismissed";
};
```

If an annotation targets a card, store its geometry in card-local normalized coordinates and reproject it into canvas coordinates at render time. See [`AI_CANVAS_ANNOTATION_LAYER.md`](./AI_CANVAS_ANNOTATION_LAYER.md).

Viewport state such as animation targets can exist at runtime but should not become the committed layout source of truth.

```text
save:
  desk pan/zoom
  card x/y/width/height/zIndex
  agenda membership
  accepted annotations

do not save as layout:
  transient zoom animation target
  card fullscreen presentation state
  in-progress drag/resize state
  viewport-pixel annotation geometry
```

---

## Card Lifecycle

Closing a card means it disappears from the canvas and its runtime is terminated.

```text
close card
  -> remove from canvas
  -> stop runtime/process/session
```

Browser Card is special:

```text
close Browser Card
  -> terminate live browser runtime
  -> leave snapshot/provenance only
```

The basic lifecycle categories are:

```text
live
snapshot
closed
```

Suspension may be added later for memory control, but it should not replace the user meaning of close.

---

## Card Creation and Placement

Default creation should search for empty space in the current viewport, then place the card on top of the active Agenda region as a dirty overlay change.

```text
create card
  -> inspect current viewport
  -> find empty space
  -> prefer active Agenda region
  -> create as dirty overlay
```

If a card with the same sourceRef is already open:

```text
Tab / focus action
  -> focus existing card

Enter / explicit open action
  -> create new card
```

This prevents accidental duplicates while preserving the user's ability to open another view of the same source.

---

## SourceRef Primitive

Use a small default primitive rather than overfitting source identity too early.

```ts
type SourceRef = {
  kind: string;
  uri?: string;
  path?: string;
  id?: string;
  scope?: string;
  accountId?: string;
  profileId?: string;
  openMode?: string;
};
```

Card types can extend this as needed. Browser identity must not be URL-only because the same URL can represent different sessions across profiles, containers, or accounts.

---

## Search Defaults

The global search box should default to three sources:

```text
file/folder names
internet history
chat history
```

Current canvas cards should also affect ranking and presentation, but do not need to be a fourth visible default category. A result can simply show "already open on Desk".

Default ranking:

```text
current Agenda
current Desk
recently used
whole Library
```

Opening search results should use Card primitives:

```text
file result      -> File/Preview/Editor Card
browser result   -> Browser Card
chat result      -> Chat Card / message focus / Run Bubble
Codex thread     -> Chat Card
```

---

## Local Index and Storage Direction

The first local search/index store should be SQLite.

```text
egdesk_index.sqlite
  files
  browser_history
  codex_threads
  chat_messages
  agendas
  cards
  FTS index
```

Codex local chat history is read as:

```text
~/.codex/state_5.sqlite       -> thread metadata and rollout_path
~/.codex/sessions/**/*.jsonl  -> actual turn/message/tool events
~/.codex/history.jsonl        -> input history helper
~/.codex/archived_sessions/*.jsonl -> archived threads
```

PocketBase and Convex are not phase-1 replacements for SQLite.

```text
SQLite     = local index and source of truth
PocketBase = possible local API/admin/realtime layer later
Convex     = possible cloud sync/collaboration layer later
```

---

## Runtime Stack

The current runtime direction:

```text
Firefox chrome JS/CSS/HTML
  -> EG-Desk surface, canvas, cards, browser integration

Node.js helper
  -> Codex bridge, terminal bridge, JSONL/SQLite adapters, local service glue

Rust helper
  -> PTY, file watcher, OS integration, performance-sensitive local operations
```

Memory pressure is expected to come more from live browser/profile/card lifecycle than from SQLite or a thin Node/Rust helper.

Memory control priorities:

```text
card lifecycle
browser/profile lifecycle
JSONL/index paging
helper lazy-start
snapshot vs live card distinction
```

---

## Viewport and Zoom Coordinates

Card position is determined in canvas/world coordinates. New-card placement can start from the current viewport but must convert viewport coordinates to canvas coordinates.

```text
viewport point
  -> apply pan/zoom inverse
  -> canvas/world point
  -> card x/y
```

Zooming in, creating a Browser Card, zooming out, then creating a Terminal Card should not break the coordinate system if both cards are placed in the same world coordinate system.

Overlap is a placement-policy issue, not a coordinate-system issue. Empty-space placement should reduce accidental overlap.

---

## Input Ownership

Input ownership is based on where the gesture starts and the current view mode.

Normal canvas mode:

```text
wheel on active card body
  -> card scroll/native interaction

wheel outside card
  -> canvas pan or zoom policy

cmd + wheel
  -> canvas pan / accelerated pan
```

Card fullscreen mode:

```text
wheel
  -> card scroll/native interaction

cmd + wheel
  -> canvas zoom immediately
```

Drag:

```text
card header start
  -> card move

card resize handle start
  -> card resize

card body start
  -> card native interaction / text selection / page drag

canvas empty-space start
  -> selection marquee or canvas pan
```

Keyboard:

```text
focused card/input/terminal/chat
  -> focused surface owns keys

no selection and global command
  -> Desk only handles cmd-based shortcuts

ordinary key input
  -> not captured globally
```

---

## Fullscreen Modes

There are two distinct fullscreen concepts.

```text
App Fullscreen
  Firefox/EG-Desk window is OS fullscreen
  Esc exits app fullscreen

Card Fullscreen
  one Card covers the EG-Desk viewport
  Esc does not exit card fullscreen
```

Card header double-click toggles Card Fullscreen.

```text
enter Card Fullscreen
  -> set card active
  -> save previous card rect and zIndex
  -> save previous HUD open state
  -> hide HUD
  -> card covers viewport
  -> move/resize handles hidden or disabled

exit Card Fullscreen
  -> restore previous rect and zIndex
  -> restore previous HUD state
  -> keep card active
```

Card fullscreen is temporary viewport presentation state. It should not overwrite the committed Agenda/Card world layout.

Viewport chrome behavior, safe area, maximize semantics, HUD hiding/peek/pinned behavior, and the top bar's Agenda-in-viewport role are specified in [`VIEWPORT_LAYOUT_INTERACTION_MODEL.md`](./VIEWPORT_LAYOUT_INTERACTION_MODEL.md).
