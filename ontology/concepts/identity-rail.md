---
id: view.identity_rail
type: view_model
layer: ontology
summary: Deferred optional UI for listing projections or occurrences of a selected canonical concept.
relations:
  visualizes:
    - ontology.cross_facet_binding
  uses:
    - ontology.projection
    - ontology.facet
---

# Identity Rail (Deferred)

The identity rail is an optional future UI for listing projections or reused
occurrences of a selected canonical concept.

For example:

```text
Selected: entity.llm_chat_session

Space     -> Chat Card on Desk
Topology  -> runtime session using CPU/RAM
Storage   -> session JSONL on Disk
Time      -> Past memory trace
Intent    -> active context/goal binding
Action    -> message-send / file-read / context-assemble
```

The current composite-lens v2 does not mount or reserve space for this rail.
Canonical identity is carried by `concept_id`; the selected visual instance is
carried by `ref_id`; nearby reuse is shown through relevant reference edges.
