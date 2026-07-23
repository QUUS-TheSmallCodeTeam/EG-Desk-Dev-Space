---
id: ontology.cross_facet_binding
type: meta_model
layer: ontology
summary: Typed reference edge between occurrences, including reused concepts or different facets.
relations:
  binds:
    - ontology.canonical_concept
    - ontology.projection
  visualized_by:
    - view.identity_rail
---

# Cross-Facet Binding

Cross-facet binding connects occurrences without duplicating their canonical
concept identity or forcing the complete relationship web into one rectangle
tree.

Example:

```text
entity.llm_chat_session
  Space projection: Chat Card
  Storage projection: session JSONL file
  Time projection: Past memory trace
```

These projections can share one `concept_id` while using different `ref_id`
values. A local composite may nest the occurrence that matters in its current
context; other occurrences remain linked by typed reference edges.

## Visual Rule

Show cross-facet bindings only when relevant to the current selected reference:

- visible cross-layer bridge
- visible time transition
- reused-reference or cycle route
- optional future search/inspector result

Do not show all cross-facet bindings by default.
