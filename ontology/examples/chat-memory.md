---
id: entity.chat_memory
type: canonical_entity
layer: evidence
summary: Canonical identity for chat memory as temporal evidence, stored trace, context input, and read action.
relations:
  uses:
    - ontology.canonical_concept
    - source.ref
  represented_by:
    - projection.chat_memory.time.past_evidence
    - projection.chat_memory.storage.trace_file
    - projection.chat_memory.intent.context_input
    - projection.chat_memory.action.file_read
  derived_from:
    - entity.llm_chat_session
  provides_evidence_for:
    - time.present
---

# Chat Memory

Chat memory is a useful stress test because it can be understood as an object or a verb.

As an object, it may be a stored trace.

As a temporal representative, it is Past evidence.

As a runtime operation, it is read, summarized, selected, or ignored.

## Facet Projections

| Facet | Projection | Valid Reading |
|---|---|---|
| Time | `projection.chat_memory.time.past_evidence` | Prior messages, tool calls, and decisions are Past evidence. |
| Storage | `projection.chat_memory.storage.trace_file` | The memory has a durable source reference such as a log, file, index, or database row. |
| Intent | `projection.chat_memory.intent.context_input` | The memory is selected because it helps the current objective. |
| Action | `projection.chat_memory.action.file_read` | Loading memory is a verb: read, retrieve, summarize, and bind to present context. |

## Modeling Rule

Do not force chat memory into only one of these:

```text
file object
past state
context source
read action
```

It is a canonical concept with facet projections.

