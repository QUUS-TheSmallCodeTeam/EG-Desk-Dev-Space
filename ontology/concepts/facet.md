---
id: ontology.facet
type: meta_model
layer: ontology
summary: Secondary lens or binding view over the three primary axes.
relations:
  contains:
    - axis.space
    - axis.time
    - axis.virtual
    - facet.space
    - facet.topology
    - facet.time
    - facet.storage
    - facet.intent
    - facet.action
  constrains:
    - ontology.projection
---

# Facet

A facet is a lens over the EG-Desk world.

Primary axes are not the same as facets.

```text
Primary axes:
  Space
  Time
  Virtual

Binding / secondary facets:
  storage
  topology
  intent
  action
```

Facets answer:

```text
Which aspect of this canonical concept are we looking at?
Which containment rules are valid in this view?
Which edges should be visible by default?
```

## Primary Axes

- [[axes/axis-space.md]]
- [[axes/axis-time.md]]
- [[axes/axis-virtual.md]]

## Secondary Facets / Binding Views

- [[facets/facet-space.md]]
- [[facets/facet-topology.md]]
- [[facets/facet-time.md]]
- [[facets/facet-storage.md]]
- [[facets/facet-intent.md]]
- [[facets/facet-action.md]]

## Composite Rule

The visual grammar does not require a different shape for each relation type.
An authored snapshot may compact containment, assembly, classification, or
runtime dependency into nested rectangles when that local composition is the
useful explanation.

```text
Server
  -> Computer
      -> MacBook

Session
  -> Computer reference
```

The exact typed relation remains in data even when the visual shape is a
rectangle. Reused concepts, cycles, time continuity, and layer crossings that
cannot be expressed by finite nesting use reference occurrences and typed
reference edges.
