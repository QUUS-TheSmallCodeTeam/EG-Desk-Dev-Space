# Ontology Visual Design Spec

**Updated**: 2026-07-19  
**Status**: live Firefox polish baseline

This file constrains the current composite-lens renderer.

## Scene

- Keep past/present/future as a top time axis, not as three outer pane surfaces.
- Render two time-continuous, depth-stacked planes: virtual and physical.
  Past/present/future
  boundaries create six addressable regions without turning them into six
  floating cards.
- The active time coordinate should occupy at least half of the stage width and
  most of its usable height, and its projected center must stay at the stage
  center. Keep all three time coordinates visible: future selection renders
  `\\_`, present selection `\_/`, and past selection `_//`; the two inactive
  coordinates share the available side width instead of being dropped or moved
  off-stage.
- Keep Desk chrome visible around the Ontology Card.
- Keep the trailing plane's full lower edge above the Dock and card boundary.
- Do not reserve header search or right-inspector space in v2.

## Layers

- virtual accent: muted violet.
- physical accent: muted steel blue.
- The selected and trailing layers use the same plane dimensions. Selection
  changes the shared viewpoint and emphasis, never their size or relative
  world-space order.
- The layer change is geometric, not opacity-only.
- View both planes from roughly 45 degrees above. Extend their outer edges past
  the viewport so they read as infinite work surfaces.
- Give both layers paired plane-local coordinates and equal-sized frames.
  Translate the trailing frame by only about one quarter of its projected
  height so roughly three quarters overlaps and a narrow depth strip remains
  exposed; do not shrink it into a shelf or collapse both frames into
  coincident sheets. Add surface shading and separation struts.
- Dim a trailing plane and its concepts only where the active front plane
  actually overlaps them. The exposed depth strip retains normal contrast;
  spatial occlusion comes from the front-pane veil, never a whole-object
  opacity or blur. Promoting physical brings physical forward and leaves
  virtual as rear context without swapping the two frames: the shared POV
  descends while virtual remains above physical.
- Pan/zoom remaps composite content through one time-coordinate camera shared by
  both layers before perspective projection. Pane and layer surfaces stay fixed,
  every occurrence and overlay is clipped to its own layer surface, and every
  concept rectangle keeps the same vanishing points as its surface. Only a
  cross-layer connector may use the two-layer union clip.
- Explicitly connected occurrences in adjacent time coordinates inherit a
  render-only projection of the active camera, so the concept and its temporal
  connector move together. Each derived occurrence remains clipped to its own
  time/layer region; unrelated side inventory remains fixed but is still
  clipped to its own layer region.

## Composite boxes

- Scatter every snapshot-root occurrence across its time/layer region. Only an
  empty `parent_ref` creates a root; changing layer does not break ancestry.
- Selected reference: centered fieldset-like rectangle sized to its visible
  contents. A collapsed reference stays compact instead of becoming a large
  empty container; an expanded reference grows only enough to hold one direct
  child level.
- Inset the selected reference from the plane's rear edge so its paired
  cross-layer occurrence lands clearly inside the trailing plane, not on the
  seam.
- Pair a front-layer concept and its rear-layer context at the same screen x
  coordinate; their dashed layer connector drops vertically between them.
- Selected label: centered while no child box is rendered inside it; upper-left
  border break only when same-layer child boxes are visibly nested inside.
- Direct children: centered labels inside nested projected rectangles.
- Trailing-plane and side-context boxes need a larger plane-local minimum height
  than main-plane boxes so perspective does not flatten them into line-like
  quadrilaterals.
- Hidden next layer: one small square for every direct child, laid out as a
  compact square row/grid. Correct width and height after perspective
  projection so each mark still reads as a square. Do not replace squares with
  a number.
- Parent: compact `← parent` breadcrumb tab directly above the selected box.
- All relation types use this rectangle grammar. Typed relation names remain in
  graph data and are not repeated as microtext inside child rectangles.
- A time coordinate without a snapshot renders no concept placeholder and no
  connection endpoint. It may show a quiet non-concept status annotation that
  directs the user back to the time axis.

## Side time coordinates

- Render at most five connected occurrence boxes across the coordinate's two
  plane regions.
- Place each occurrence in the region matching its `virtual` or `physical` layer.
- Project every corner and hit target through coordinate-local geometry.
- Keep past and future surfaces and occurrence boxes visibly slanted; only the
  active time coordinate receives the broad frontal reading area.
- Keep every displayed side occurrence and its label inside the stage. Bias
  past items toward their inner-right edge and future items toward their
  inner-left edge instead of allowing projected outer edges to clip them.
- Align labels to the projected plane axes. Horizontal labels are correct when
  the plane's time direction is horizontal; do not add arbitrary card rotation.
- Put the overflow count on a bundled connecting line as `+N`.

## Lines

- Time routes attach to the right/left midpoint of occurrence boxes.
- Their two elbows lie on the actual shared projected time-pane boundary, and
  the segment between those elbows follows that boundary instead of an
  arbitrary midpoint bus.
- Virtual/physical routes use paired local coordinates and a dashed line along
  the perspective-derived layer-separation direction, visually perpendicular
  to the two planes.
- Use thin orthogonal routes for remaining same-plane references.
- Do not draw a same-layer reference line when direct parent-child nesting
  already expresses the same local relationship.
- External routes attach to visible boxes or the nearest visible aggregate.
- Do not render relation-name labels on connection lines.
- Do not render an unrestricted global spider web.

## Interaction affordances

- Blank plane/background: grab cursor and pan both coupled layer occurrence
  fields.
- Child and breadcrumb: pointer cursor.
- Top time coordinate: click to activate time.
- Side plane region: click to activate both time and layer.
- Layer surface: click to promote.
- Header remains the only card-position drag handle.
- Keep a quiet stage hint visible for background drag, wheel pan, and modifier
  zoom until those gestures are otherwise self-evident.

## Minimap

- Keep it in the lower-left.
- Scope the plot to the active time pane only. Show that pane's two equal-sized
  planes, their depth displacement and overlap, and use the full plot area for
  the current occurrence distribution rather than shrinking three time panes
  into one thumbnail.
- Show rendered occurrence positions and a distinct selected marker; these are
  derived only from active-pane live placement state, not decorative hard-coded
  blocks. Time navigation remains on the main time axis.
- Keep a compact, non-interactive legend inside the existing minimap footprint:
  the selected concept scope and active time/layer coordinate at the top, then
  virtual, physical, selected-reference, and viewport keys at the bottom.
- The legend must pass pointer input through to the map and must update from the
  same live selection and active-cell state as the stage.
- Layer regions and occurrence markers are keyboard- and pointer-navigable.
- Viewport and percentage must follow the active camera.
- Do not use decorative hard-coded node blocks or a hard-coded `100%` state.
