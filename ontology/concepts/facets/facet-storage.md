---
id: facet.storage
type: facet
layer: ontology
summary: Lens for durable storage identity, file paths, repos, databases, and source references.
relations:
  uses:
    - ontology.facet
    - ontology.projection
    - source.ref
  visualizes:
    - source.ref
    - architecture.runtime
  constrains:
    - view.projection
---

# Storage Facet

The storage facet describes where durable bytes and references live.

It is the facet for:

- local files
- session logs
- Git repos
- databases
- Drive documents
- caches
- source references

## Containment Rule

Storage containment means resource address containment.

```text
Disk
  contains folder
  contains file

Repo
  contains tracked source file

Database
  contains table
  contains row
```

A storage node can represent the same canonical concept as a space or time node, but it should not be merged into those hierarchies.

## Example

For `entity.llm_chat_session`, the storage projection may be:

```text
projection.llm_chat_session.storage.session_file
  label: Session File
  address: local session log or database row
  source_ref: stable pointer used for reload
```

