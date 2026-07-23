---
id: ontology.binding_type
type: meta_model
layer: ontology
summary: Intertwining pattern between Space, Time, and Virtual axes.
relations:
  uses:
    - axis.space
    - axis.time
    - axis.virtual
  contains:
    - binding.storage
    - binding.topology
    - binding.intent
    - binding.action
---

# Binding Type

Binding types explain how the three primary axes intertwine.

They are not primary axes.

## Core Binding Types

```text
storage
  = Space address/object
  + Virtual identity/source meaning
  + Time revision/history/snapshot

topology
  = Space compute resources
  + Virtual dependency/runtime identity
  + Time current executable state

intent
  = Virtual objective
  + Time commitment
  + Space artifact/surface

action
  = Time transition
  + Space target
  + Virtual operation meaning
```

Binding types remain typed data. In the composite-lens v2 they may be compacted
into the same nested-rectangle grammar used by other local relations. When a
binding crosses time, runtime stratum, reused occurrences, or a cycle, the
renderer exposes it as a reference edge. Strips, chips, and intersection bands
are optional future view treatments, not required shapes.
