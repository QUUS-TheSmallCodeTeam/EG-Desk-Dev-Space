---
id: egdesk.desk
type: product_concept
layer: runtime
summary: EG-Desk's computer-level live work surface that projects OS, browser, file, process, account, and agent resources into one canvas.
aliases:
  - Desk
  - EG-Desk Desk
relations:
  represented_by:
    - desktop
  contains:
    - egdesk.agenda
    - egdesk.card
  receives_from:
    - architecture.runtime
    - time.present
  uses:
    - source.ref
---

# Desk

Desk is an EG-Desk product concept, not a generic desktop definition.

In EG-Desk, a Desk is the computer-level live work surface. It should feel like using "my computer as a desk", while internally projecting OS, browser, process, file, account, and agent resources into a canvas.

Desk is not the same as:

- a browser profile
- a project folder
- a static canvas document
- the generic `desktop` object handle

The generic `desktop` handle can represent the visible operating plane. `egdesk.desk` is the product-level concept that gives that plane EG-Desk behavior, state, source refs, Board membership, and runtime attachment rules.

## Stable Definition

```text
Desk = computer-level live work surface
```

Desk contains Boards and Cards. Its concrete runtime grouping may still be declared by relation maps.

