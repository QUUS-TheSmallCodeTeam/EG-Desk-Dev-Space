---
id: ontology.projection
type: meta_model
layer: ontology
summary: The representation of a canonical concept inside one facet.
relations:
  derived_from:
    - ontology.canonical_concept
  uses:
    - ontology.facet
  binds:
    - ontology.cross_facet_binding
---

# Projection

A projection is how a canonical concept appears inside a specific facet or
view. It is optional modeling metadata, not the only drawable unit.

```text
canonical concept + facet + view rules = projection node
```

## Projection Shape

```yaml
canonical_id: entity.llm_chat_session
facet: facet.storage
projection_id: projection.llm_chat_session.storage.file
shape: file
label: Session JSONL
source_ref: ~/.codex/sessions/...
```

## Renderer Rule

The current composite-lens renderer draws snapshot occurrences keyed by
`ref_id`. An occurrence may refer directly to a canonical concept or to a
projection concept. The renderer does not require an `identity_anchor`, detail
panel, or identity rail.

Projection metadata can be exposed later by search, an optional inspector, or
an alternate faceted view without changing the v2 rectangle grammar.
