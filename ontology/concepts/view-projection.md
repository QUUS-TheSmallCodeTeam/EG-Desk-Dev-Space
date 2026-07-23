---
id: view.projection
type: view_model
layer: ontology
summary: A user-facing assembled view made from one facet or a controlled combination of facets.
relations:
  uses:
    - ontology.canonical_concept
    - ontology.facet
    - ontology.projection
    - ontology.cross_facet_binding
---

# View Projection

A view projection is the assembled view the user sees.

It can be:

- single-facet view: `Space`, `Topology`, `Time`, `Storage`, `Intent`, `Action`
- controlled cross-facet view: selected object projected across several facets
- curated About/Vision view: a guided read-only explanation

## Renderer Rule

```text
Composite lens:
  select one occurrence by ref_id
  show that occurrence and its direct children
  keep concept_id stable across reused occurrences
  reveal only reference edges relevant to the visible focus
```

This keeps the canvas readable while preserving the larger relationship web.
An identity rail is an optional future view, not part of the v2 Ontology Card.
