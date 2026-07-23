---
id: facet.action
type: facet
layer: ontology
summary: Lens for verbs, events, operations, side effects, and executable transitions.
relations:
  uses:
    - ontology.facet
    - ontology.projection
  visualizes:
    - operation.layer
    - action.execution
  constrains:
    - view.projection
---

# Action Facet

The action facet describes what happens.

It is the facet for:

- read
- write
- click
- type
- message send
- tool call
- file edit
- command execution
- deployment
- state transition

## Containment Rule

Action containment means sequence, transaction, or suboperation.

```text
Implement feature
  contains read files
  contains edit files
  contains run verification
  contains report result
```

An action projection may touch storage, topology, time, and space, but it should remain a verb/event rather than being flattened into an object hierarchy.

## Example

For `entity.llm_chat_session`, action projections may be:

```text
projection.llm_chat_session.action.message_send
projection.llm_chat_session.action.file_read
projection.llm_chat_session.action.context_assemble
projection.llm_chat_session.action.tool_call
```

