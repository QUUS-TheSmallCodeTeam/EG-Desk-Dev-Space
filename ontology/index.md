---
id: egdesk.ontology.index
type: index
layer: ontology
summary: Entry point for the EG-Desk ontology source of truth.
relations:
  defines:
    - egdesk.world
    - ontology.canonical_concept
    - ontology.facet
    - ontology.projection
    - ontology.cross_facet_binding
    - ontology.binding_type
    - axis.space
    - axis.time
    - axis.virtual
    - view.projection
    - view.identity_rail
    - view.time_sliced_spatial_pane
    - view.time_sliced_flat_deck
    - facet.space
    - facet.topology
    - facet.time
    - facet.storage
    - facet.intent
    - facet.action
    - reality.base
    - architecture.runtime
    - compute
    - cpu
    - ram
    - disk
    - desktop
    - terminal
    - time.past
    - time.present
    - time.future
    - time.multiverse
    - operation.layer
    - actor.runtime
    - output.structured
    - egdesk.desk
    - egdesk.agenda
    - egdesk.card
    - egdesk.run_bubble
    - egdesk.run_playback
    - entity.llm_chat_session
    - entity.desktop_runtime
    - entity.chat_memory
    - map.local_runtime_inventory
    - map.llm_chat_runtime_assembly
    - view.egdesk.faceted_concept_model
---

# EG-Desk Ontology

This folder is the source-of-truth seed for EG-Desk's ontology-aware operating world.

The ontology should be readable as Markdown, linkable like Obsidian, and parseable by a local web UI. The web UI can render graphs, timelines, and detail panels, but it should not become the source of truth.

## Core Sentence

EG-Desk is an ontology-aware operating desk that projects reality, compute architecture, and time-axis representatives into a live work surface.

```text
Reality
+ Hardware and software architecture
+ Time-axis representatives
  - Past
  - Present
  - Future
  - Multiverse
= EG-Desk virtual operating world
```

## Primary Load Order

For the current composite-lens v2 viewer, load this contract first:

1. [[schema.md]]
2. the selected file under `snapshots/`
3. [[concepts/time-sliced-spatial-pane.md]]
4. [[views/time-sliced-flat-deck.md]]
5. [[canvas-rendering-plan.md]]

The snapshot occurrence tree and reference edges control the visible viewer.
The broader faceted model below remains authoring metadata and future explorer
material; it does not add a third runtime stratum or a right-side rail to v2.

## Broader Ontology Load Order

For an LLM or parser, start here:

1. [[concepts/egdesk-world.md]]
2. [[schema.md]]
3. [[concepts/canonical-concept.md]]
4. [[concepts/time-sliced-spatial-pane.md]]
5. [[views/time-sliced-flat-deck.md]]
6. [[canvas-rendering-plan.md]]
7. [[concepts/facet.md]]
8. [[concepts/axes/axis-space.md]]
9. [[concepts/axes/axis-time.md]]
10. [[concepts/axes/axis-virtual.md]]
11. [[concepts/binding-type.md]]
12. [[concepts/projection.md]]
13. [[concepts/cross-facet-binding.md]]
14. [[concepts/view-projection.md]]
15. [[concepts/facets/facet-space.md]]
16. [[concepts/facets/facet-topology.md]]
17. [[concepts/facets/facet-time.md]]
18. [[concepts/facets/facet-storage.md]]
19. [[concepts/facets/facet-intent.md]]
20. [[concepts/facets/facet-action.md]]
21. [[concepts/reality.md]]
22. [[concepts/architecture-runtime.md]]
23. [[concepts/time-past.md]]
24. [[concepts/time-present.md]]
25. [[concepts/time-future.md]]
26. [[concepts/time-multiverse.md]]
27. [[concepts/operation-layer.md]]
28. [[concepts/actor-runtime.md]]
29. [[concepts/source-ref.md]]
30. [[concepts/structured-output.md]]
31. [[concepts/egdesk-desk.md]]
32. [[concepts/egdesk-agenda.md]]
33. [[concepts/egdesk-card.md]]
34. [[concepts/egdesk-run-bubble.md]]
35. [[concepts/egdesk-run-playback.md]]

For concrete assembly examples, load:

1. [[examples/llm-chat-session.md]]
2. [[examples/desktop-runtime.md]]
3. [[examples/chat-memory.md]]

For custom relation maps, load:

1. [[maps/local-runtime-inventory.md]]
2. [[maps/llm-chat-runtime-assembly.md]]

For visual overviews, open:

1. [[views/egdesk-world-graph.md]]
2. [[views/faceted-concept-model.md]]
3. [[views/time-sliced-flat-deck.md]]

For the canvas-native rendering path, the first six documents above are the
normative contract. [[concepts/identity-rail.md]] is deferred and must not be
treated as part of the current Ontology Card layout.

## Boundary

Subagents, tools, browser controllers, and human collaborators are runtime actors inside the EG-Desk world. They are not the root ontology.

The root ontology is:

```text
canonical concepts
  -> three primary axes
      -> Space
      -> Time
      -> Virtual
  -> binding types
      -> storage / topology / intent / action
  -> world topology
      -> reality
      -> architecture
      -> time representatives
      -> operation layer
      -> actors and actions
```

The flat-deck viewer reads separate past/present/future composite snapshots through two runtime strata, `virtual` and `physical`. It renders the selected reference and its direct children as a local rectangle composition; reused, cyclic, cross-layer, and temporal relationships remain reference edges. Information and meaning are virtual concept attributes, not an additional runtime stratum.

## Concept Definition Boundary

Use different document weights for different concept classes:

```text
generic object handles
  -> thin page
  -> aliases / abbreviations / source identity hints
  -> relation maps declare context-specific assembly

EG-Desk product concepts
  -> short real definition
  -> boundaries against generic meanings
  -> stable product relations
  -> relation maps only for specific runtime assembly
```

Examples:

- `desktop` is a generic object handle for the visible operating plane.
- `egdesk.desk` is the EG-Desk product concept for a computer-level live work surface.
- `terminal`, `cpu`, `ram`, and `disk` stay thin handles.
- `egdesk.agenda`, `egdesk.card`, `egdesk.run_bubble`, and `egdesk.run_playback` keep product definitions because their meaning is custom to EG-Desk.

## Existing Project Anchors

This ontology wraps existing EG-Desk product/runtime decisions rather than replacing them:

- `Desk / Agenda / Card`: `apps/firefox-ui-demo/docs/DESK_AGENDA_CARD_RUNTIME_MODEL.md`
- `Chat / Canvas / Agent layer`: `apps/firefox-ui-demo/docs/CHAT_CANVAS_AGENT_LAYER_MODEL.md`
- `Run Playback`: `apps/firefox-ui-demo/docs/CANVAS_RUN_PLAYBACK_MODEL.md`
- `Browser Agent Observation`: `apps/firefox-ui-demo/docs/BROWSER_AGENT_OBSERVATION_RUNTIME.md`
- `Ontology Bridge`: `docs/vision/ontology-bridge.md`
