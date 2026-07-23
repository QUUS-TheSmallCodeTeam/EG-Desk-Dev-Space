# Ontology Visual Diagnosis

**Updated**: 2026-07-19  
**Status**: live Firefox polish verified

This diagnosis supersedes the earlier three-stratum, right-inspector design.
The current review target is the Desk-native Ontology Card rendered from graph
schema v3.

## Current visual grammar

- Past, present, and future remain visible as coordinates on the top time axis.
- Two continuous virtual/physical planes are partitioned into six addressable
  time/layer regions; there is no outer time-pane surface or six-card layout.
- Runtime has two strata only: `virtual` and `physical`.
- The active layer pane shows one selected reference and its same-layer direct
  children. Cross-layer children stay in the other layer pane.
- Local relations use nested rectangles; typed relation semantics remain in
  graph data.
- Reuse, cycles, time continuity, and layer crossings use reference lines.
- The lower-left minimap follows the same pane, layer, pan, and zoom state.
- Search and the right-side inspector are deferred and reserve no card space.

## What works now

- The Ontology Card stays inside the Desk; opening or closing it does not hide
  the rail, Dock, HUD, or other cards.
- The active time coordinate occupies most of the usable stage instead of leaving a large
  decorative margin.
- Virtual and physical are both visible. Clicking a surface moves the shared
  POV to that layer while their virtual-above-physical order stays fixed.
- The two planes use paired local coordinates and equal-sized projected frames.
  Roughly three quarters of each frame overlaps and only a narrow depth strip
  remains exposed; neither layer becomes a smaller shelf. Shading, struts, a
  front-pane veil, and dim rear concepts make the separation legible while
  their outer boundaries still extend beyond the viewport.
- Past and future concepts, labels, and hit targets follow the projected plane
  and time-boundary geometry.
- Recursive composition stays bounded: only the selected reference and one
  direct child level are expanded.
- Collapsed references use a compact centered box. Expanded references use a
  real top-border break for the selected label, with the breadcrumb held above
  it instead of masking the border with a wide white band.
- Hidden next-level children use one literal square per direct child. No number
  is appended to the square indicator, and projection compensation keeps the
  marks square on screen.
- Side time coordinates cap visible connected occurrences at five across their
  two plane regions and put overflow on an orthogonal connecting route as `+N`.
  Displayed side occurrences remain fully inside the stage.
- Same-layer parent-child relations rely on rectangle nesting rather than
  drawing a duplicate internal line. Rectangle and connection-line relation
  labels remain hidden while their types stay available in graph data.
- Empty time coordinates show one quiet non-concept annotation while keeping
  occurrence and edge counts at zero.
- The minimap now shows derived occurrence markers and a distinct selected
  marker, and the stage exposes a compact pan/zoom interaction hint.

## Visual hierarchy

Read order should be:

1. selected reference;
2. its direct child rectangles;
3. active layer surface;
4. parent breadcrumb and square child indicators;
5. cross-layer and cross-time routes;
6. projected side-pane context;
7. minimap and camera controls.

Inactive time coordinates are context, not alternate dashboards. Their virtual
and physical panes should remain recognizable without competing with the active
composite.

## Material and color

- virtual: muted violet, semantic/software context;
- physical: muted steel blue, machine/resource context;
- selected reference: strongest border and label contrast;
- direct children: quieter filled rectangles;
- reference routes: thin, low-glow strokes with clear endpoints.

Information and meaning may be encoded in concept metadata or relation labels,
but they are not rendered as a third surface.

## Interaction diagnosis

Semantic navigation is click-only:

- top time-axis coordinate click changes time;
- side plane-region click changes time and layer together;
- layer surface click changes the main layer;
- child click changes the selected reference;
- breadcrumb click returns to the parent.

Camera navigation stays separate:

- background drag and ordinary wheel/trackpad pan the active cell;
- Cmd/Ctrl + wheel or pinch zooms;
- header drag moves the card in Desk coordinates.

The pane and both layer surfaces remain fixed. One time-coordinate camera moves
the active composite and its connected cross-layer context together, clipped to
the union of the two layer surfaces.

This separation prevents pan gestures from accidentally changing ontology
meaning.

## Remaining review risks

- Very large composites still need performance and lazy-loading tests.
- Automatic search and ancestor-path opening are intentionally deferred.
- The optional inspector/identity-rail concept is not part of v2 and must not
  reappear as reserved blank space.
- Automated Firefox chrome events cannot fully substitute for a trusted,
  hand-driven pointer-drag check; live visual review remains required.

## Success criteria

- The selected reference and active time/layer are identifiable within one
  second.
- The active time coordinate uses most of the card without erasing the 2.5D context.
- A nested rectangle, square indicator, breadcrumb, and reference line each
  communicate a distinct part of the grammar.
- Side-pane geometry and labels share the pane projection.
- Pan/zoom changes are reflected in the minimap.
- The screen reads as an ontology lens inside EG-Desk, not as a separate app or
  a generic graph editor.
