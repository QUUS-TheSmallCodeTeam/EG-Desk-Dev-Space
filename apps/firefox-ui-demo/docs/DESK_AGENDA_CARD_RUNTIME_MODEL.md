<a id="desk-agenda-and-desk-window-runtime-model"></a>
# Desk, Board, and Desk Window Runtime Model

**Date**: 2026-05-18
**Updated**: 2026-10-31
**Status**: Product/runtime architecture decision note
**Scope**: EG-Desk Firefox shell, Desk canvas, Board state, Desk Window lifecycle, search, local index, input ownership

**Approved visual reference (2026-10-20):** [desktop screenshot](./egdesk-approved-desktop-style.jpg)
and [interactive HTML proposal](./egdesk-approved-desktop-style.html). They
establish the warm wood Desk, off-white window material, compact corners,
quiet separators, and two attached Browser chrome rows. The proposal's
example messages, resources, and window coordinates are not runtime data or
new domain rules. Runtime token owner:
`overlay/CSS/eg-desk-surface.uc.css` (`--egd-*`); this document mirrors intent,
not a separate token implementation. Current user-approved style supersedes
older blue/frosted visual values below where they conflict, but the Desk
Window lifecycle and adapter boundaries still govern behavior.

---

## Core Vocabulary

EG-Desk should not expose Codex-style "project = folder" as the primary user concept.

```text
Library = long-term searchable catalog
Desk    = computer-level live work surface
Board   = work + execution environment pairing
Desk Window = movable/resizable interactive work surface on the Desk
Card        = compact result, summary, snapshot, or collapsed representation
```

`Desk Window` is the product and design-system term for Browser, Ontology,
Terminal, Settings, and comparable live work surfaces. The current runtime,
persistence schema, DOM classes, and verifiers still use compatibility names
such as `CardState`, `spawnBrowserCard`, and `.egd-canvas-card`. Browser and
Ontology now mount through the shared Desk Window Shell; the compatibility
names remain during the incremental persistence/API migration and do not
redefine the product concept as a card.

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

<a id="agenda-model"></a>
## Board Model

Board is not a todo list and not a folder. It is the work boundary that pairs a task with the execution environment needed to do it.

```text
Board
  browser cards
  file cards
  chat cards
  terminal cards
  agent/context bindings
  account/profile bindings
  result cards
```

Board can be nested, but the product should treat this as a work decomposition graph, not a folder tree. Deep nesting can exist in the data model, while the Desk UI shows the active slice.

On an infinite canvas, a Board is distinguished by:

```text
Board Header Card
Board Region
Member Cards
Focus Mode
Collapse/Expand to a Board Card
```

---

<a id="saved-agenda-automatic-desk-session-and-live-runtime"></a>
## Saved Board, Automatic Desk Session, and Live Runtime

The Desk and the Board library are related but separate product surfaces.

```text
actual Desk surface
  automatic Desk session projection
  + currently mounted views
  + each view's live or reconstructed runtime state

Sidebar Board section
  separately listed saved Boards
  + explicit open/create/update actions
```

The automatic Desk session restores what the user left open even when the user
never saved a Board. Persisting that session for restart recovery does not
commit it to a Board. Normal startup should feel like browser session restore:
the Desk opens directly and prior views reappear without a mandatory recovery
mode, origin badge, or keep/discard wizard.

An unsaved Board indicator applies only when the user has a Board open and
has changed the state that will be retained by that Board. It must not label
every automatically restored Desk view as an unsaved Board change.

```text
automatic Desk-session change
  opening, closing, moving, or resizing a Desk view
  -> recorded for local session continuity according to the decided restore scope

Board change
  adding/removing a member, changing a Board binding, or updating saved layout
  -> marked unsaved until the Board update action is performed
```

Board membership is edited from the View bar (CNV-03; decisions D-V1 to D-V4
of 2026-10-24). The View bar states only the recorded owner and never infers
one from the active Board or the View's position:

```text
View bar
  recorded owner       -> Board name + chevron; menu '○○에서 빼기', '△△에 넣기'
  no recorded owner    -> '소속 없음' + chevron; menu '△△에 넣기' per open Board
  conflicting records  -> no name is guessed; the menu still offers every Board

rules
  D-V1 one View belongs to one Board at most; joining another leaves the current one
  D-V2 a new View is never added on its own: opened inside a Board region, or
  D-V3 dropped into one, it gets '○○에 넣을까요? [넣기] [아니요]' under its View bar
  D-V4 a new Board saved from open Views binds those Views where they are (no copy)
  every membership edit marks the Board unsaved ('저장 안 됨') until it is saved

runtime
  rules   overlay/resources/EGDeskBoardMembership.sys.mjs (pure, unit-tested)
  edits   EGDeskCanvasLayout addProjectionMember / removeProjectionMember
  screen  eg-desk-surface.uc.js addViewToBoard / removeViewFromBoard /
          offerBoardMembershipSuggestion / bindSavedBoardInPlace
```

When a Board with unsaved Board changes is closed or switched, the product
may require an explicit guard:

```text
save changes
discard changes
continue editing
```

This guard is not part of ordinary application startup. Exact visible labels
and gestures remain a UI contract and must not be replaced by abstract
“keep/discard” language in a use-case trace.

Current implementation drift:

- startup restores the stored active Board snapshot, not an independent
  automatic Desk session;
- general canvas changes feed one `state.agenda.dirty` flag;
- the current selector, still labeled `Agenda`, is a top rail/popover, while
  the latest product direction places saved Boards in a Sidebar area.

These are implementation gaps, not evidence that the product lifecycles should
be merged.

Reference patterns, not implementation proof:

- [Firefox Session Restore](https://support.mozilla.org/kb/restore-previous-session)
  can reopen prior tabs and windows automatically at startup; its exceptional
  recovery page is not the normal startup model.
- [Chrome saved tab groups](https://support.google.com/chrome/answer/2391819)
  remain separately reopenable after a group is closed, illustrating the
  difference between a saved work grouping and the currently open tab session.
- [VS Code Hot Exit](https://code.visualstudio.com/docs/editing/codebasics#_hot-exit)
  restores unsaved editor/window state across restarts without turning that
  recovery record into the user's saved project structure.

---

## Desk, Viewport, and Card State

Desk state below is an auto-recovery record for the work surface. It is not a
Board revision merely because it is serialized.

```ts
type DeskState = {
  pan: { x: number; y: number };
  zoom: number;
  activeAgendaId?: string;
  activeCardId?: string;
  openCards: CardState[];
};
```

Board stores committed work state. The model sketches retain identifiers
containing `agenda` for compatibility; Board is the product name.

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
  type: "agenda" | "browser" | "file" | "chat" | "terminal" | "ppt" | "excel" | "notes" | "ontology";
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
  Board membership
  accepted annotations

do not save as layout:
  transient zoom animation target
  Desk Window maximize/fullscreen presentation state
  in-progress drag/resize state
  viewport-pixel annotation geometry
```

---

## Desk Window Shell and Adapter Contract

Browser, Ontology, Terminal, Settings, and later work surfaces should use one
Desk Window Shell. The shell is the EG-Desk window grammar; it is not a browser
runtime and does not determine how window content is rendered.

**Implementation status (2026-07-19):** `spawnDeskWindowShell()` is the live
shared shell for Browser and Ontology. It owns their common frame, 32 px
titlebar, controls, focus, titlebar drag, eight-way resize, maximize/restore,
`sourceRef`, dirty-state hooks, resize notifications, and once-only cleanup
registry. Browser mounts its toolbar/progress/XUL content as `native-content`;
Ontology mounts its privileged renderer as `adapter-owned`. Terminal, Settings,
and the compatibility persistence/API vocabulary have not yet migrated.

```text
Desk Window Shell
  frame
    titlebar
      window controls
      identity: icon / title / status
      window-level actions
    adapter toolbar slot (optional)
    adapter progress slot (optional)
    content viewport
      adapter mount slot
      adapter overlay slot (optional)
    eight resize hit zones
```

The Browser Window and Ontology Window must therefore look and behave like members
of the same window system without pretending that Ontology is a website:

```text
Browser Adapter
  -> browser toolbar + omnibox
  -> logical content wrapper / inactive-window activation capture
  -> remote XUL browser and browsing-context actors

Ontology Adapter
  -> privileged chrome-DOM stage
  -> graph loading and composite renderer
  -> time/layer selection and coupled camera
```

### Shared visual grammar

The common geometry is more important than making every Desk Window use the same
content color.

| Part | Target contract |
|---|---|
| outer frame | 9 px radius, 1 px `#DEDFD8` neutral border, clipped body corners |
| titlebar | 32 px shared default; the approved Browser variant is 29 px over its own 35 px toolbar, with controls retained on the shared alignment grid |
| window controls | 10 px dots, 8 px gap, fixed left inset |
| adapter toolbar | optional row below titlebar; Browser's accepted thin row is 35 px and does not rebuild the live page on camera movement |
| content viewport | fills remaining window space; no shell padding by default |
| resize targets | the same eight edge/corner hit zones on every resizable Desk Window |
| inactive state | quiet border and low `0 4px 16px rgba(29,44,55,.12)` elevation |
| active state | shared subtle `0 7px 21px rgba(29,44,55,.15)` elevation, independent of adapter theme |
| maximized state | same safe-area fit, restore geometry, and hidden resize targets |

The approved visual parity pass uses one local outline-icon renderer for the
floating rail, full Dock, topbar actions, Desk Window type identity, Browser
navigation/security, and semantic outline proxy. Its simple SVG geometry is
authored in the Firefox surface JS; it does not fetch a third-party icon
library or copy proposal fixtures. A small visual grip precedes the type icon
and title in the shared Desk Window titlebar; the existing close/minimize/
maximize controls and titlebar drag region retain their behavior. Browser
continues to have its own 29px title row and attached 35px navigation row.
The outline proxy shows title/source from the live View only, while its click
focuses that same View and leaves Browser page and world geometry intact.

An adapter may choose a neutral or dark surface palette, but it must not move
the window controls or replace the active and maximized state grammar. The
Browser's documented 29 + 35 px variant is intentional; it does not force a
Browser toolbar onto Ontology or Terminal. Terminal can remain dark and
Ontology warm and light while sharing the shell lifecycle affordances.

The target titlebar profiles are concrete:

```text
Browser
  titlebar identity -> page title + compact loading/security status
  toolbar slot      -> back/forward/reload/home + omnibox + browser actions
  progress slot     -> page-load progress

Ontology
  titlebar identity -> Ontology + active time/layer status
  toolbar slot      -> absent
  content slot      -> time axis and the full ontology stage begin immediately

Terminal
  titlebar identity -> Terminal + connection/session status
  toolbar slot      -> absent unless session controls are introduced

Settings
  titlebar identity -> Settings
  content slot      -> settings navigation and forms
```

Ontology's time axis remains inside the adapter content because it changes the
ontology coordinate system; it is not generic window chrome. Likewise, the
Browser omnibox remains in the Browser Adapter because it controls a browsing
runtime rather than the Desk Window frame.

Window controls are capability-driven:

```text
close
  -> required unless the Desk Window is explicitly non-dismissible

minimize
  -> collapse to the Desk's minimized-card surface when that lifecycle exists
  -> until then, do not present an enabled no-op control

maximize
  -> toggle Desk Window Maximized presentation
  -> the current runtime may retain the internal cardFullscreen name during migration
```

### Shell ownership

The shell owns behavior that must be identical across Desk Window kinds:

- frame, titlebar, window controls, body slot, and resize hit zones;
- initial Desk placement and world-coordinate geometry;
- focus, active state, z-order, header drag, resize, and safe-area maximize;
- `sourceRef` registration and removal;
- Board dirty-state marking for create, move, resize, and close;
- shell-state serialization and restore;
- a cleanup registry that executes each registered cleanup exactly once;
- window identity updates such as title, status, and loading/error state;
- focus fallback and viewport/HUD synchronization after close.

The shell must be the only code that removes the Desk Window root. Adapters request a
close through the shell and release their resources through the cleanup
registry; they do not independently unregister the source, clear global focus,
or mutate Board state.

### Adapter ownership

An adapter owns only the content/runtime semantics that differ by Desk Window kind:

- mount its toolbar and content into the supplied slots;
- serialize and restore adapter runtime state;
- react to viewport resize when its renderer needs reflow;
- declare its input policy;
- register observers, timers, message listeners, and runtime teardown;
- expose optional window actions and title/status updates through shell context.

The initial registry should cover Browser and Ontology. Terminal, Settings, and
Chat migrate only after Browser/Ontology parity is proven.

```ts
type DeskWindowAdapter = {
  kind: CardState["type"];
  inputPolicy: "native-content" | "adapter-owned" | "document-ui";
  mount(ctx: DeskWindowContext): void | Promise<void>;
  serializeRuntime?(ctx: DeskWindowContext): Record<string, unknown>;
  restoreRuntime?(state: Record<string, unknown>, ctx: DeskWindowContext): void | Promise<void>;
  onResize?(rect: Rect, ctx: DeskWindowContext): void;
  beforeClose?(reason: "close" | "replace" | "restore", ctx: DeskWindowContext): void | Promise<void>;
};

type DeskWindowContext = {
  root: HTMLElement;
  slots: {
    titlebarIdentity: HTMLElement;
    titlebarActions: HTMLElement;
    toolbar: HTMLElement;
    progress: HTMLElement;
    content: HTMLElement;
    overlay: HTMLElement;
  };
  sourceRef: SourceRef;
  setIdentity(value: { title?: string; status?: string; loading?: boolean; error?: string }): void;
  requestFocus(): void;
  requestClose(reason?: "close" | "replace" | "restore"): void;
  registerCleanup(dispose: () => void): void;
};
```

The concrete constructor may be named `spawnDeskWindow(adapter, options)`. Its
important property is the ownership boundary, not the final function name.

### Input policies

All policies share these shell rules:

```text
titlebar drag
  -> move the Desk Window

resize hit drag
  -> resize the Desk Window

titlebar double-click / maximize control
  -> toggle Desk Window Maximized presentation

Desk Window body
  -> never moves the Desk Window
```

Adapter-specific body behavior:

| Policy | Initial adapters | Body ownership |
|---|---|---|
| `native-content` | Browser, Terminal | content document owns text, scroll, click, and key input; shell may use an inactive-window activation gate |
| `adapter-owned` | Ontology | stage owns background pan, wheel pan, modifier zoom, and semantic click targets |
| `document-ui` | Settings | chrome DOM controls own ordinary form and scroll interaction |

The shell must not convert Ontology wheel gestures into Desk zoom or convert a
Browser page drag into Desk Window movement. The adapter must not intercept titlebar
drag or resize handles.

### Persistence boundary

Persist shell and adapter state separately:

```ts
type PersistedDeskWindow = {
  shell: {
    id: string;
    kind: CardState["type"];
    x: number;
    y: number;
    width: number;
    height: number;
    zIndex: number;
    sourceRef?: SourceRef;
  };
  runtimeState?: Record<string, unknown>;
};
```

This is the target logical boundary. The physical snapshot may remain in the
current flat `CardState` form during migration as long as shell fields and
adapter runtime state retain the same ownership.

Shell state persists world geometry, kind, z-order, and source identity.
Adapter state persists only reconstructable semantic state:

```text
Browser
  -> URI and reconstructable navigation metadata

Ontology
  -> selected reference/concept, active time/layer, cameraByCell, pan, zoom
```

Do not serialize DOM/XUL nodes, `browsingContext`, actor objects, observers,
timers, pointer sessions, loading animations, fullscreen restore rectangles, or
the loaded Ontology graph object. Browser restore currently creates a new XUL
browser; shell unification does not imply preservation of a live browsing
context. Ontology reloads its generated graph resource and then reapplies its
semantic state.

Restore order is fixed:

```text
1. resolve adapter from persisted kind
2. create shell without marking Board dirty
3. restore shell geometry and sourceRef
4. mount adapter into shell slots
5. restore adapter runtime state
6. attach resize/input observers
7. restore active-window state after all Desk Windows exist
```

### Lifecycle sequence

Creation:

```text
create shell -> bind sourceRef -> append to canvas -> mount adapter
-> install shared interactions -> focus -> mark dirty
```

Close:

```text
request close -> exit Desk Window presentation mode -> adapter beforeClose
-> run cleanup registry once -> unregister sourceRef -> remove Desk Window root
-> select focus fallback -> sync viewport presentation -> mark dirty
```

Adapter mount failure must leave a usable shell-level error surface with Retry
and Close. It must not remove or blank the Desk.

### Migration and acceptance

Migration is behavior-preserving before it is visual-polishing:

1. Freeze Browser, Ontology, sourceRef, persistence, and viewport verification
   as the baseline.
2. Extract titlebar controls, slots, resize handles, shared interactions, and
   cleanup registry in the current chrome JS file.
3. Move Ontology to the shell first while retaining `.egd-ontology-*` selectors.
4. Move Browser while retaining its XUL browser, wrapper/capture, actor, and
   `.egd-browser-card` / `.egd-card-*` contracts.
5. Replace manual restore branching with the adapter registry only after both
   adapters pass parity checks.
6. Normalize Browser and Ontology titlebar metrics and shared visual tokens
   after structural parity is proven.
7. Migrate Terminal, Settings, and Chat in separate follow-up phases.

Acceptance requires:

- Browser and Ontology expose the same shell anatomy and eight resize targets;
- drag, resize, focus, z-order, maximize, restore, and close behave identically;
- adapter cleanup executes exactly once and a closed Ontology Window never blanks
  the Desk;
- Browser navigation, browsing-context actors, and page input remain intact;
- Ontology pan/zoom, time/layer clicks, minimap, and resize rerender remain
  intact;
- Board serialization restores shell geometry and each adapter's semantic
  state without marking the restored Board dirty;
- existing adapter-specific CSS classes remain valid during the first migration.

The implementation verification set should include Browser controls and agent
observation, the current Ontology `*-card` and interaction checks, `sourceRef`,
Board persistence, and viewport-layout checks. Add one cross-window shell verifier for
shared anatomy, eight resize handles, cleanup-once behavior, input-policy
separation, and shell-plus-adapter restore.

---

## Card View and Runtime Lifecycle

A Card is the visible work surface. Some cards also own or attach to a runtime process/session.

Default close should keep the user's mental model simple:

```text
close card
  -> remove visible card from canvas
  -> terminate its runtime unless the runtime is explicitly pinned, awaited, or detached
  -> leave snapshot/provenance when useful
```

This means `close` is still destructive by default. Long-lived background work should use an explicit runtime state, not silently change the meaning of close.

Runtime lifecycle categories:

```text
foreground
  visible card is attached to a live runtime

background-live
  runtime remains alive in a hidden host or helper registry
  no visible card is attached
  immediate foreground attach is possible

suspended
  live runtime is stopped or frozen
  sourceRef, history, snapshot, and recoverable state remain
  foreground attach requires restore, not direct reattachment

snapshot-only
  no live runtime
  provenance and last visual/state snapshot remain

closed
  no runtime and no active canvas card
```

### Terminal Runtime Attach

Terminal is an agent execution substrate and an optional expert/debug Desk
Window. It is not the required primary coding UX. Project/folder navigation,
file viewing/editing, diff, and run/test/review results may be presented through
more suitable user-facing Desk Windows while agents use a terminal runtime
behind them.

Terminal should follow a terminal-multiplexer style split:

```text
TerminalRuntime
  sessionId
  process / tmux session / PTY backend
  append-only output ring
  client cursors
  lifecycle state

TerminalCard
  visible xterm client
  attached sessionId
  geometry and focus state
```

Required behavior:

```text
spawn terminal runtime
  -> create sessionId
  -> create foreground TerminalCard client

detach terminal card
  -> remove visible card
  -> keep a detachable session in background-live
  -> pin/await prevents ordinary background-runtime reclamation

reattach terminal runtime
  -> open TerminalCard for sessionId
  -> replay output from ring buffer using client cursor

kill terminal runtime
  -> use a separate explicit process-termination action
  -> show the target and impact before terminating PTY/tmux
  -> keep final output as a read-only snapshot with exit/termination evidence
  -> close that snapshot only through a separate view action
```

Terminal continuity terminology is evidence-sensitive:

```text
reattach
  -> the same verified sessionId and process/session owner still exist

revive / relaunch
  -> a new shell/process is created from recorded cwd, permitted environment,
     shell startup context, and prior output snapshot
  -> an arbitrary prior foreground command is not automatically rerun

snapshot-only restore
  -> prior output/provenance is shown but no live process exists
```

Closing the visible TerminalCard must not silently terminate a runtime that is
defined as detachable. Resuming a declared idempotent task after restart is a
scheduler decision with its own evidence and policy; it is not Terminal view
restoration.

The product must never call a newly spawned PTY a reconnect. This distinction
follows the patterns documented by
[VS Code persistent terminal sessions](https://code.visualstudio.com/docs/terminal/advanced#_persistent-sessions),
which separates process reconnection from process revive, and
[tmux](https://github.com/tmux/tmux/wiki/Getting-Started#attaching-and-detaching),
which keeps the background session and its programs separate from attachable
clients.

The helper must not destructively drain terminal output for a single reader. Multi-attach and reconnect require per-client cursors or a replayable snapshot stream.

For persistence across helper restarts, a tmux-style backend is preferred over a raw in-process PTY. A raw `node-pty` session is sufficient for same-helper background-live attach, but the helper owns that lifetime.

### Browser Runtime Attach

Browser attach is possible but more constrained than terminal attach. A Browser Card should not be the browser runtime itself.

```text
BrowserRuntime
  runtimeId
  XUL <browser> element or equivalent browser context
  browsingContext / WindowGlobal / actor bindings
  profile/container/account binding
  URL/history/title/security state
  lifecycle state

BrowserCard
  visible viewport/chrome for one BrowserRuntime
  omnibox, controls, geometry, focus state
```

For Firefox shell, background-live BrowserRuntime means the `<xul:browser>` stays connected in a hidden runtime host. Foreground attach should move or project that same runtime into a BrowserCard without destroying its `browsingContext` or actor bindings.

Required proof before treating browser attach as stable:

```text
create BrowserRuntime in hidden host
load page and mutate DOM/form state
attach to foreground BrowserCard
verify URL, DOM state, browsingContext id, and agent actor
detach back to hidden host
reattach and verify state again
```

Background-live browser runtimes are not a resource-saving substitute for suspension. They keep most live-tab costs: DOM, JS, network, storage, workers, and content-process memory. They may reduce visible paint/compositor work, but they need a resource budget.

Browser runtime budget policy:

```text
foreground: no special limit beyond visible cards
background-live: small capped pool for awaited or recently detached work
suspended: preferred for idle browser work
snapshot-only: default after explicit close/terminate
```

Headless browser mode should not be treated as the model for EG-Desk background-live cards. Headless mode primarily removes GUI/display requirements for automation; it does not make live browser runtimes cheap enough to keep without limits.

---

## Card Creation and Placement

Default creation should search for empty space in the current viewport, then place the card on top of the active Board region as a dirty overlay change.

```text
create card
  -> inspect current viewport
  -> find empty space
  -> prefer active Board region
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

Card types can extend this as needed. Browser runtime/view identity must not be
URL-only because the same URL can be open through different profiles,
containers, accounts, and permission contexts. This does not imply that
verified identical content becomes a different fact.

This shape is provisional and carries several dimensions that the product must
keep semantically distinct:

```text
source/evidence reference
content identity or revision
resource identity/locator
account/profile permission and execution context
visible view/runtime instance
```

The same verified content can support the same claim across accounts, even when
the accounts provide different hidden data or available actions. Content or
canonical-resource deduplication must therefore be separate from action
authorization and audit identity. `accountId` and `profileId` constrain how a
resource is opened and acted on; they do not by themselves make identical
content a different fact.

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
current Board
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

For a future local search/index store, SQLite is the proposed first choice.
The following lists planned logical collections; it is not existing DDL or an
implemented storage API.

```text
egdesk_index.sqlite
  files
  browser_history
  codex_threads
  chat_messages
  boards
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
  -> card-owned command when the active card declares one; otherwise canvas command
```

Card fullscreen mode:

```text
wheel
  -> card scroll/native interaction

cmd + wheel
  -> card-owned command when the fullscreen card declares one; otherwise canvas zoom
```

Drag:

```text
card header start
  -> card move

card resize handle start
  -> card resize

card body start
  -> card native interaction / text selection / page drag

ontology stage start
  -> ontology camera pan; child/time/layer targets keep click semantics

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

Card fullscreen is temporary viewport presentation state. It should not overwrite the committed Board/Card world layout.

Viewport chrome behavior, safe area, maximize semantics, HUD hiding/peek/pinned behavior, and the top bar's Board-in-viewport role are specified in [`VIEWPORT_LAYOUT_INTERACTION_MODEL.md`](./VIEWPORT_LAYOUT_INTERACTION_MODEL.md).
