---
id: egdesk.ontology.canvas_rendering_plan
type: implementation_plan
layer: ontology
summary: Implemented plan for a Desk-native time-snapshot composite lens.
relations:
  uses:
    - egdesk.ontology.schema
    - view.time_sliced_flat_deck
---

# Canvas-Native Ontology Rendering Plan

## Implemented v2

- Ontology renders as a movable/resizable card inside the existing Desk.
- Markdown graph generation uses schema version 3.
- `subject_id`, `snapshot_id`, `ref_id`, recursive occurrences, and reference
  edges are parsed and validated.
- Runtime strata are `virtual` and `physical` only.
- Present and future company-server snapshots demonstrate one continuing subject
  with different Markdown documents and composites.
- Time is a top axis with three coordinates across two time-continuous,
  infinite-feel virtual/physical planes. The planes use paired local coordinates
  and equal-sized projected frames with roughly three-quarter-frame overlap.
  Virtual stays above physical; layer selection shifts one shared POV instead
  of exchanging their frame positions;
  their time boundaries create six addressable regions with no outer time surface
  or six-card layout.
- Snapshot roots with an empty `parent_ref` are scattered as the overview.
  Layer changes never promote descendants into roots. Selecting a root expands
  it with same-layer direct children; a time coordinate without a snapshot
  stays concept- and edge-free.
- The active layer pane renders the selected reference plus same-layer direct
  children only; cross-layer children stay faintly visible on the rear pane and
  move through the same time-coordinate camera below a translucent front-pane
  veil. Their paired layer connectors remain vertical on screen.
- Parent breadcrumb and literal square child indicators are implemented.
- Side time coordinates use projected geometry, a five-item cap across their
  two plane regions, and `+N` edge bundles.
- Temporal edges use right/left anchors; cross-layer edges use dashed paired
  depth anchors aligned vertically between the overlapping layers. Lines
  have no relation labels.
- Time and layer navigation are click-only semantic changes; blank/background
  drag pans both coupled layer occurrence fields.
- Pan, wheel pan, zoom, minimap, header drag, fullscreen, close, and reopen paths
  are independently verified.
- Search and right-side inspector are not mounted.

## Runtime files

```text
ontology/schema.md
ontology/snapshots/*.md
apps/firefox-ui-demo/scripts/generate-ontology-graph.mjs
apps/firefox-ui-demo/overlay/resources/ontology/graph.json
apps/firefox-ui-demo/overlay/JS/eg-desk-surface.uc.js
apps/firefox-ui-demo/overlay/CSS/eg-desk-surface.uc.css
```

## Deferred

- search and automatic ancestor-path opening;
- optional details inspector;
- ontology editing and node repositioning;
- future branching/multiverse authoring;
- larger-domain performance and lazy occurrence loading.
