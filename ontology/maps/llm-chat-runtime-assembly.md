---
id: map.llm_chat_runtime_assembly
type: relation_map
layer: architecture
summary: Custom runtime assembly for reading an LLM chat session inside EG-Desk.
relations:
  organizes:
    - entity.llm_chat_session
  uses:
    - desktop
    - terminal
    - cpu
    - ram
    - disk
    - egdesk.agenda
    - egdesk.card
    - goal
    - plan
    - task
    - output.structured
relation_edges:
  - source: desktop
    relation: contains
    target: terminal
  - source: terminal
    relation: uses
    target: cpu
  - source: terminal
    relation: uses
    target: ram
  - source: terminal
    relation: uses
    target: disk
  - source: projection.llm_chat_session.space.chat_card
    relation: projects_into
    target: desktop
  - source: projection.llm_chat_session.topology.runtime
    relation: uses
    target: terminal
  - source: projection.llm_chat_session.storage.session_file
    relation: stored_in
    target: disk
  - source: projection.llm_chat_session.intent.context_binding
    relation: drives
    target: projection.llm_chat_session.action.message_send
  - source: projection.llm_chat_session.action.message_send
    relation: acts_on
    target: terminal
  - source: entity.chat_memory
    relation: provides_evidence_for
    target: projection.llm_chat_session.intent.context_binding
  - source: projection.chat_memory.storage.trace_file
    relation: provides_evidence_for
    target: projection.llm_chat_session.storage.session_file
  - source: projection.llm_chat_session.intent.context_binding
    relation: drives
    target: goal
  - source: projection.llm_chat_session.action.message_send
    relation: drives
    target: output.structured
  - source: goal
    relation: contains
    target: plan
  - source: plan
    relation: contains
    target: task
view_cells:
  - node: projection.llm_chat_session.time.memory_trace
    view: view.time_sliced_flat_deck
    time_slice: past
    runtime_stratum: virtual
    x: 0.28
    y: 0.18
    order: 10
  - node: entity.chat_memory
    view: view.time_sliced_flat_deck
    time_slice: past
    runtime_stratum: virtual
    role: identity_anchor
    x: 0.70
    y: 0.40
    order: 20
  - node: projection.chat_memory.storage.trace_file
    view: view.time_sliced_flat_deck
    time_slice: past
    runtime_stratum: virtual
    x: 0.68
    y: 0.82
    order: 30
  - node: entity.llm_chat_session
    view: view.time_sliced_flat_deck
    time_slice: present
    runtime_stratum: virtual
    role: identity_anchor
    x: 0.15
    y: 0.16
    order: 10
  - node: projection.llm_chat_session.intent.context_binding
    view: view.time_sliced_flat_deck
    time_slice: present
    runtime_stratum: virtual
    x: 0.40
    y: 0.34
    order: 20
  - node: egdesk.agenda
    view: view.time_sliced_flat_deck
    time_slice: present
    runtime_stratum: virtual
    x: 0.62
    y: 0.16
    order: 30
  - node: egdesk.card
    view: view.time_sliced_flat_deck
    time_slice: present
    runtime_stratum: virtual
    x: 0.84
    y: 0.18
    order: 40
  - node: projection.llm_chat_session.space.chat_card
    view: view.time_sliced_flat_deck
    time_slice: present
    runtime_stratum: virtual
    x: 0.18
    y: 0.46
    order: 50
  - node: projection.llm_chat_session.action.message_send
    view: view.time_sliced_flat_deck
    time_slice: present
    runtime_stratum: virtual
    x: 0.38
    y: 0.48
    order: 60
  - node: projection.llm_chat_session.topology.runtime
    view: view.time_sliced_flat_deck
    time_slice: present
    runtime_stratum: virtual
    x: 0.58
    y: 0.46
    order: 70
  - node: projection.llm_chat_session.storage.session_file
    view: view.time_sliced_flat_deck
    time_slice: present
    runtime_stratum: virtual
    x: 0.82
    y: 0.46
    order: 80
  - node: desktop
    view: view.time_sliced_flat_deck
    time_slice: present
    runtime_stratum: virtual
    x: 0.18
    y: 0.66
    order: 90
  - node: terminal
    view: view.time_sliced_flat_deck
    time_slice: present
    runtime_stratum: virtual
    x: 0.58
    y: 0.66
    order: 100
  - node: cpu
    view: view.time_sliced_flat_deck
    time_slice: present
    runtime_stratum: physical
    x: 0.31
    y: 0.70
    order: 110
  - node: ram
    view: view.time_sliced_flat_deck
    time_slice: present
    runtime_stratum: physical
    x: 0.50
    y: 0.70
    order: 120
  - node: disk
    view: view.time_sliced_flat_deck
    time_slice: present
    runtime_stratum: physical
    x: 0.69
    y: 0.70
    order: 130
  - node: goal
    view: view.time_sliced_flat_deck
    time_slice: future
    runtime_stratum: virtual
    x: 0.48
    y: 0.22
    order: 10
  - node: plan
    view: view.time_sliced_flat_deck
    time_slice: future
    runtime_stratum: virtual
    x: 0.34
    y: 0.48
    order: 20
  - node: task
    view: view.time_sliced_flat_deck
    time_slice: future
    runtime_stratum: virtual
    x: 0.64
    y: 0.62
    order: 30
  - node: output.structured
    view: view.time_sliced_flat_deck
    time_slice: future
    runtime_stratum: virtual
    x: 0.50
    y: 0.82
    order: 40
---

# LLM Chat Runtime Assembly

This note is not a generic definition of terminal, CPU, RAM, or disk.

It declares one useful way to assemble those objects for the EG-Desk LLM chat context.

```text
desktop
  -> terminal
      -> cpu
      -> ram
      -> disk

LLM chat session
  -> chat card projected into the desktop
  -> runtime through terminal
  -> session file on disk
  -> past evidence becomes present context
  -> present intent and action drive future goals and outputs
```

`view_cells` is a legacy curated projection for this relation map. It gives a
node one authored home cell for the older map view, but it is not the source of
truth for the composite lens.

The current flat-deck viewer reads `composite_snapshot` documents and selects
occurrences by `ref_id`. It derives the active rectangle composition from
`parent_ref`, and derives cross-time/layer/reuse routes from `reference_edges`.
This map remains useful as a typed relation-web example and compatibility
fixture; it must not be interpreted as the inventory of every visible node.

If the domain changes, create another relation map instead of rewriting the base object pages.
