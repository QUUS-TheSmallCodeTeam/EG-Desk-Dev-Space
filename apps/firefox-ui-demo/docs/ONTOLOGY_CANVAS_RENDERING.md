# Ontology Canvas Rendering

**Updated**: 2026-07-19  
**Status**: snapshot lens and shared Desk Window Shell implemented

## Product boundary

Ontology is an ordinary movable and resizable Desk Window inside the EG-Desk
canvas. Opening it must not hide the Desk rail, Dock, HUD, or other Desk
Windows. Closing the last Ontology Window must leave the Desk usable.

Ontology uses the shared Desk Window Shell for its frame, titlebar, window
controls, focus, move, resize, maximize, `sourceRef`, Board persistence, and
cleanup lifecycle. Its renderer remains an `adapter-owned` privileged
chrome-DOM surface mounted directly in the shell content slot. It is not loaded
as a website or appended into the Browser Adapter's remote XUL content
document. Browser and Ontology share the window system, not the content-process
boundary. The shell/adapter contract is defined in
[Desk/Board/Card runtime model](./DESK_AGENDA_CARD_RUNTIME_MODEL.md#desk-window-shell-and-adapter-contract).

The current implementation names `.egd-ontology-card`,
`spawnOntologyMapCard`, and card-oriented persistence helpers are compatibility
vocabulary during the remaining persistence/API migration; they are not the
product name. The rendered Ontology surface already mounts through
`spawnDeskWindowShell()`.

Markdown remains canonical. The Firefox resource is generated:

```text
ontology/**/*.md
  -> apps/firefox-ui-demo/scripts/generate-ontology-graph.mjs
  -> overlay/resources/ontology/graph.json (schemaVersion 3)
  -> Ontology Desk Window
```

The Firefox-hosted Ontology Window accepts schema version 3 and renders `snapshots`,
`occurrences`, and `referenceEdges` directly. The former generic node/edge
fallback renderer has been removed; a graph without composite snapshots now
shows an explicit empty state instead of silently switching visual grammars.
The `egd-ontology-v2-*` DOM class prefix remains only as a stable CSS and
verification contract.

## Model

The runtime has two strata only:

```text
virtual
physical
```

Information and meaning are attributes or types of virtual concepts, not
additional strata.

The renderer separates four identities:

- `concept_id`: reusable concept such as `computer`.
- `ref_id`: one occurrence of that concept in a composite.
- `subject_id`: continuing real-world subject such as `company-server`.
- `snapshot_id`: time-specific ontology document/composite identity.

One real subject may therefore have separate present and future Markdown files
with different occurrence trees.

## Rectangle-first composite

Every local relationship is rendered with the same nested-rectangle grammar.
`contains`, `runs_on`, `instance_of`, and `composed_of` remain typed in data,
but do not require different node shapes.

Every populated time coordinate first shows its snapshot roots: occurrences
whose `parent_ref` is empty. Roots are scattered in the region matching their
layer so the user can browse the snapshot before selecting one. Crossing from
virtual to physical never promotes a descendant into a new root.

The selected occurrence then expands in place and shows only:

```text
selected reference
  -> its direct children
```

Clicking a direct child replaces the selected root. The previous parent becomes
a compact breadcrumb tab above the selected rectangle. A child with further
children shows one literal square pip per direct child. Numeric pip badges are
not used. Pip dimensions are corrected after projection so they remain square
on screen. Typed relation names stay in graph data and are not repeated inside
the child rectangles.

If a time coordinate has no snapshot, it has no occurrence box, selected
placeholder, or edge endpoint. The viewer never invents a `snapshot 없음`
concept. A small non-concept status annotation may explain the empty coordinate
and point back to the time axis.

Reference lines are reserved for relationships that cannot be represented as a
finite local nesting: reused concepts, cycles, virtual/physical bridges, and
time transitions. Lines carry no relation-name labels; relation types remain in
the graph data.

## Time axis and layer panes

Past, present, and future are coordinates on the top time axis, not container
panes. Two continuous, effectively infinite planes sit under that axis and are
partitioned by time boundaries:

```text
virtual plane  -> past | present | future regions
physical plane -> past | present | future regions
```

- The active time coordinate uses most of the card stage.
- Inactive past and future coordinates remain as strongly slanted projected side
  context; their surfaces, concepts, and hit targets share that projection.
- In screen space the time regions read as `\ past`, `_ present`, `/ future`:
  present stays horizontal, the past wing falls toward the center, and the
  future wing rises away from the center. This is a per-time-pane tilt, not a
  trapezoid applied only to the combined outer boundary.
- Plane-region boxes, hit polygons, and labels use their time coordinate's
  projected geometry. Labels may rotate without full shear for readability.
- Each side time coordinate displays at most five related occurrences across
  its virtual and physical regions.
- Displayed side occurrences are inset toward the center of the stage so their
  projected boxes and labels are never clipped by the card edge.
- Additional related occurrences are summarized on the connecting line as
  `+N`.
- The active coordinate shows both virtual and physical panes. Clicking one
  moves the shared POV to that depth and keeps the other as context.
- The planes are viewed from roughly 45 degrees above, like infinite work
  surfaces laid across the Desk. Their outer edges extend beyond the viewport.
- Virtual and physical use paired plane-local coordinates and equal-sized
  projected frames. They are parallel surfaces, not a large plane plus a small
  shelf and not coincident sheets. The trailing frame is translated only far
  enough to expose a narrow depth strip: roughly three quarters of each frame
  overlaps, leaving about 100 px exposed from a roughly 367 px-tall frame in
  the current rendered viewport.
- Virtual always remains above physical in world coordinates. Clicking physical
  shifts the shared stack viewpoint down by one depth step so physical enters
  the main reading area; the pane frames never exchange relative positions.
- Shading, translucent fills, a visible rear rim, and two short struts
  communicate the separation between the partially overlapping planes.
- Rear-layer concepts render at normal contrast below a translucent active-plane
  veil. Only the geometrically overlapped portion is attenuated; the exposed
  depth strip remains clear.
- Fit the projected stack above the Desk Dock and the card's lower edge. The
  trailing plane must keep a visible bottom margin rather than being clipped by
  persistent Desk controls.
- Time coordinates remain aligned across both stacked planes.
- Recenter the selected time coordinate as the wide, flat middle reading plane
  without removing either sibling coordinate. Past/present/future therefore
  resolve to `_//`, `\_/`, and `\\_` respectively as the active coordinate
  changes.
- Time-axis coordinates and plane geometry stay fixed during camera navigation.
  Only the selected composite content moves, clipped to the two-layer stack.
- Store one coupled camera per time coordinate. Pan and zoom both layer concept
  fields together so a virtual occurrence and its connected physical occurrence
  move as a pair while their connector drops vertically between the paired
  screen positions. Clip each occurrence group to its own layer; reserve the
  two-layer union clip for the perpendicular connector. Apply that camera in
  plane-local coordinates before projection. Do not use a
  second screen-space transform for concept boxes: their projected edges must
  continue to share the active plane's vanishing points after navigation.
- Project explicit temporal-edge endpoints through the same active camera while
  clipping each connected side occurrence to its own time/layer region. This
  moves the temporal line and connected occurrence together without moving
  unrelated side inventory or mutating the side pane's stored camera.

## Interaction contract

- top time-axis coordinate click: activate that time coordinate.
- side plane-region click: activate its time coordinate and layer.
- side occurrence click: activate its time coordinate, layer, and occurrence.
- virtual/physical surface click: promote that layer.
- selected child click: replace the focus root.
- breadcrumb click: return to the parent reference.
- blank/background drag: pan the active plane's occurrence field. It does not
  reposition the Ontology Window or individual concepts.
- wheel/trackpad: pan only; it never changes time or layer.
- Cmd/Ctrl + wheel or pinch: zoom.
- window titlebar drag: move the Ontology Window in Desk coordinates.
- window maximize dot: use the shared Desk Window maximize behavior.
- a quiet stage hint exposes background drag, wheel pan, and modifier zoom.

Search and the right-side inspector are deferred and do not reserve space in
this version.

## Minimap

The lower-left minimap is a navigator for the active time pane's currently
rendered semantic neighborhood, not an all-102-concept global inventory or a
three-time-pane thumbnail. It fits the active pane's two equal-sized,
depth-separated planes to the full plot; dots are active-pane occurrences, the
emphasized dot is the selected reference, and the dashed outline is the current
camera viewport. Its
viewport follows the active-cell pan and zoom. The plus, fit, and minus controls
call the same camera state used by the stage. Its regions and markers support
pointer and keyboard navigation. A compact overlay names the selected concept
scope and active time/layer coordinate, and identifies the virtual, physical,
selected-reference, and viewport marks without intercepting map input.

## Verification

Run:

```bash
npm run ontology:graph:check
node apps/firefox-ui-demo/scripts/verify-firefox-mcp-ontology-card.mjs /tmp/egdesk-ontology-v2-card.png
node apps/firefox-ui-demo/scripts/verify-firefox-mcp-ontology-interactions.mjs /tmp/egdesk-ontology-v2
```
