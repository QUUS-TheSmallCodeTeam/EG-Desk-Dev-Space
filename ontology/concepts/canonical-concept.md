---
id: ontology.canonical_concept
type: meta_model
layer: ontology
summary: Stable identity for a thing before it is projected into a specific lens or view.
relations:
  contains:
    - ontology.facet
    - ontology.projection
    - ontology.cross_facet_binding
  constrains:
    - view.projection
---

# Canonical Concept

A canonical concept is the reusable semantic identity of a thing in the
EG-Desk world. In schema v3 this is the `concept_id`.

It is not the same as one occurrence drawn on screen. The same concept may be
referenced many times through distinct `ref_id` values in different snapshots
or local composites.

## Rule

```text
concept_id
  -> ref_id A in one composite
  -> ref_id B in another composite
  -> ref_id C in another time snapshot
```

The same canonical concept can appear differently depending on lens:

```text
entity.llm_chat_session
  space projection    -> Chat Card on Desk
  topology projection -> runtime session using CPU/RAM
  storage projection  -> session JSONL on Disk
  time projection     -> Past memory trace
  intent projection   -> active context/goal binding
  action projection   -> message-send / file-read / context-assemble
```

This lets a concept such as `computer` participate in several relationship
webs without duplicating its canonical definition.

## Visual Rule

The composite-lens renderer selects an occurrence, not a global concept node.
It keeps canonical identity available through `concept_id` while navigation
changes `selectedRefId`.

```text
Select ref_id
  -> show that occurrence and its direct children
  -> keep concept_id as reusable semantic identity
  -> connect other occurrences through typed reference edges
```
