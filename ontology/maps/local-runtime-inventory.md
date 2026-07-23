---
id: map.local_runtime_inventory
type: relation_map
layer: architecture
summary: EG-Desk local runtime inventory map for the current product-building context.
relations:
  organizes:
    - architecture.runtime
  uses:
    - compute
    - cpu
    - ram
    - disk
    - desktop
    - terminal
    - egdesk.desk
relation_edges:
  - source: architecture.runtime
    relation: contains
    target: compute
  - source: architecture.runtime
    relation: contains
    target: desktop
  - source: architecture.runtime
    relation: contains
    target: terminal
  - source: architecture.runtime
    relation: contains
    target: surface.browser
  - source: architecture.runtime
    relation: contains
    target: surface.files
  - source: architecture.runtime
    relation: contains
    target: surface.cloud
  - source: architecture.runtime
    relation: contains
    target: repo.code
  - source: architecture.runtime
    relation: contains
    target: egdesk.desk
  - source: compute
    relation: contains
    target: cpu
  - source: compute
    relation: contains
    target: ram
  - source: compute
    relation: contains
    target: disk
---

# Local Runtime Inventory

This is a custom inventory map for EG-Desk product work.

It is not a universal definition of computers. It declares the object grouping that is useful for reading the current local development/runtime context.

If the work changes, create another relation map instead of expanding object pages into generic encyclopedia entries.
