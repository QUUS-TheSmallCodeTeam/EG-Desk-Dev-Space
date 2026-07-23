---
id: view.time_sliced_spatial_pane
type: view_model
layer: ontology
summary: A time-axis coordinate that partitions continuous virtual and physical 2.5D planes for one composite snapshot.
relations:
  uses:
    - axis.time
    - axis.virtual
  implemented_by:
    - view.time_sliced_flat_deck
---

# Time-Sliced Spatial Coordinate

One time coordinate selects one composite snapshot. Time itself is shown only
on the top axis. The coordinate cuts across two depth-stacked planes.

```text
LayerPane = TimeSlice × Layer × selected ref_id

TimeSlice = past | present | future
Layer     = virtual | physical
```

The active layer pane displays the selected occurrence and its same-layer direct
children. A cross-layer child stays faintly visible on the rear layer and
connects along the shared projected depth vector. The view does not expand an
unlimited hierarchy. Selecting a
child replaces the focus root; the previous parent becomes a breadcrumb.

Inactive time coordinates remain projected side context with at most five
connected occurrences across their virtual and physical panes. Their labels and
boxes follow coordinate-local geometry.

The virtual and physical planes are viewed from roughly 45 degrees above and
extend beyond the viewport. They use paired local coordinates and equal-sized
frames separated by about one quarter of a frame in projected depth, leaving
roughly three quarters overlapped and a narrow strip exposed. Rear concepts sit
below a translucent front-plane veil, and paired cross-layer connectors drop
vertically on screen. Background drag and wheel pan one time-coordinate camera
shared by both layers; plane geometry stays fixed and coupled content is clipped
to the union of the two surfaces. Time and layer never change from wheel
direction.

Virtual remains above physical in world coordinates. Activating physical
translates the shared viewpoint down one depth step instead of exchanging the
two pane frames.
