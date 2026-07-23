---
id: reality.base
type: reality
layer: reality
summary: The external real world that EG-Desk represents, observes, and acts upon.
relations:
  projects_into:
    - architecture.runtime
    - operation.layer
  represented_by:
    - source.ref
    - time.past
    - time.present
---

# Reality

Reality is the external world EG-Desk is attached to.

Examples:

- people, companies, customers, departments
- physical computers and devices
- OS accounts and cloud accounts
- files, folders, repositories, databases
- browser sessions and authenticated websites
- business objects such as contracts, inquiries, reports, invoices, products

The ontology must not flatten these into file paths or chat messages only. EG-Desk should preserve the richer real-world categories and then bind them to digital resources through [[source-ref.md]].

## Relation To Existing Vision

The current EG-Desk Ontology Bridge frames this as a gap between physical objects/places and flattened digital objects/places. This concept keeps that direction, but expands it to include compute topology and time representatives.

