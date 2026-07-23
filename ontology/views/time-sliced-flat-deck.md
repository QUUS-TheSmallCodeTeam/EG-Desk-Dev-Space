---
id: view.time_sliced_flat_deck
type: view_model
layer: ontology
summary: Two-layer, time-sliced composite lens for reference-occurrence snapshots.
relations:
  visualizes:
    - snapshot.company_server.present
    - snapshot.company_server.future
  constrains:
    - egdesk.ontology.canvas_rendering_plan
---

# Time-Sliced Flat Deck

The flat deck is a shallow 2.5D reading aid over time-specific composite
snapshots.

```text
Lens = active TimeSlice
     + active Layer
     + selected ref_id
     + camera
```

```text
TimeSlice = past | present | future
Layer     = virtual | physical
```

Time is represented by separate snapshot documents. One real subject can keep
the same `subject_id` while its snapshot document, root reference, and recursive
composition change.

## Local projection

Time is an axis of three coordinates, not a set of container panes. A
time-continuous virtual plane and time-continuous physical plane are partitioned
by the three time coordinates. Virtual and physical use paired plane-local
coordinates and equal-sized projected frames. The trailing frame moves in depth
without changing size. Roughly three quarters of the frames overlap and only a
narrow depth strip remains exposed. The inactive layer is shaded, its concepts
sit below a translucent active-layer veil, and paired cross-layer connectors
drop vertically on screen. This yields six addressable regions without six
floating cards.

Virtual remains above physical in world coordinates. Selecting physical moves
the shared POV down one depth step and brings physical into the main reading
area; the two plane frames do not exchange positions.

Each time coordinate first renders its snapshot-root occurrences scattered in
the surface region matching their layer. A snapshot root has an empty
`parent_ref`. Crossing from a physical parent to a virtual child does not create
a new root or break composite ancestry. Selecting one root expands only that
occurrence and its immediate same-layer children; a cross-layer direct child is
shown on the other plane and remains attached to the same ancestry.

The active layer pane renders the selected occurrence and its same-layer direct
children. Cross-layer direct children remain faintly visible on the rear layer
and move through the same time-coordinate camera.
Selecting a child makes it the next root. Its parent becomes a breadcrumb.
Further children are represented by literal square pips, one per direct child.

The local nesting does not claim that every relation is physical containment.
It is a visual expansion of a typed reference occurrence. Relation type remains
in data.

## Reference web

Lines connect visible occurrences when nesting alone is insufficient:

- same subject across snapshots;
- same concept referenced in several composites;
- virtual/physical realization;
- replacement or migration;
- cyclic or peer relationships.

Hidden endpoints resolve to the nearest visible selected/direct-child boundary.
Time links use right/left box midpoints. Cross-layer links use paired local
coordinates and a dashed line along the perspective-derived layer-separation
direction, visually perpendicular to the planes. Connection lines do not render
relation-name labels. Both endpoints share one camera, so pan and zoom move them
as a coupled pair.

A time coordinate without a snapshot is strictly empty: it has no synthetic
occurrence, placeholder composite, or connection endpoint.

## Side context

Inactive time coordinates show up to five related occurrences across their two
plane regions. Remaining occurrences are bundled into a line count. Each box is
placed in the region matching its layer, and boxes and labels use projected
geometry. Past and future boxes remain slanted with their side coordinate.

## Navigation

- time and layer changes are click-only semantic operations.
- ordinary wheel and blank/background drag pan both coupled layer occurrence
  fields.
- Cmd/Ctrl + wheel or pinch zooms.
- plane surfaces remain fixed; coupled virtual and physical content moves.
- active content is clipped to its layer region, while the other plane remains
  context.
- no node-layout editing exists in this viewer.
