---
id: view.egdesk.faceted_concept_model
type: view
layer: ontology
summary: Deferred authoring view of canonical concepts, facets, projections, and occurrence references.
relations:
  visualizes:
    - ontology.canonical_concept
    - ontology.facet
    - ontology.projection
    - ontology.cross_facet_binding
    - entity.llm_chat_session
---

# Faceted Concept Model (Authoring / Deferred Explorer)

This is an ontology-authoring overview, not the current Ontology Card layout.
Composite-lens v2 does not mount an identity rail. It draws selected `ref_id`
occurrences from snapshot documents and preserves shared identity through
`concept_id`.

```mermaid
flowchart LR
    Canonical["Canonical Concept<br/>stable identity"]

    subgraph Facets["Facet Lenses"]
        Space["Space<br/>visible card / pane / canvas"]
        Topology["Topology<br/>runtime dependency"]
        Storage["Storage<br/>file / repo / DB / SourceRef"]
        Time["Time<br/>past / present / future / multiverse"]
        Intent["Intent<br/>goal / plan / task / blocker"]
        Action["Action<br/>read / write / click / run"]
    end

    subgraph Example["entity.llm_chat_session"]
        ChatCard["Chat Card<br/>space projection"]
        Runtime["Chat Runtime<br/>topology projection"]
        SessionFile["Session File<br/>storage projection"]
        MemoryTrace["Memory Trace<br/>time projection"]
        ContextBinding["Context Binding<br/>intent projection"]
        MessageEvents["Message / Tool Events<br/>action projection"]
    end

    Occurrence["Reference Occurrences<br/>distinct ref_id values"]
    Binding["Reference Edges<br/>identity, sourceRef, causality"]

    Canonical --> Space
    Canonical --> Topology
    Canonical --> Storage
    Canonical --> Time
    Canonical --> Intent
    Canonical --> Action

    Space --> ChatCard
    Topology --> Runtime
    Storage --> SessionFile
    Time --> MemoryTrace
    Intent --> ContextBinding
    Action --> MessageEvents

    ChatCard -. referenced as .-> Occurrence
    Runtime -. referenced as .-> Occurrence
    SessionFile -. referenced as .-> Occurrence
    MemoryTrace -. referenced as .-> Occurrence
    ContextBinding -. referenced as .-> Occurrence
    MessageEvents -. referenced as .-> Occurrence

    Occurrence --> Binding
    Binding -. selected only .-> ChatCard
    Binding -. selected only .-> Runtime
    Binding -. selected only .-> SessionFile
    Binding -. selected only .-> MemoryTrace
    Binding -. selected only .-> ContextBinding
    Binding -. selected only .-> MessageEvents
```

## Reading Rule

The diagram should be read as:

```text
one identity
  many facet projections
  many contextual occurrences
  selected-reference edges
```

It should not be read as one global containment tree, nor as a requirement to
show all facets at once. The v2 viewer chooses one occurrence and expands only
its direct children.
