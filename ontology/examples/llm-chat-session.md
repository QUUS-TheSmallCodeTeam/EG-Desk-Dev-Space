---
id: entity.llm_chat_session
type: canonical_entity
layer: runtime
summary: Reusable concept identity for an LLM chat session across many reference occurrences.
relations:
  uses:
    - ontology.canonical_concept
  represented_by:
    - projection.llm_chat_session.space.chat_card
    - projection.llm_chat_session.topology.runtime
    - projection.llm_chat_session.storage.session_file
    - projection.llm_chat_session.time.memory_trace
    - projection.llm_chat_session.intent.context_binding
    - projection.llm_chat_session.action.message_send
  binds:
    - entity.desktop_runtime
    - entity.chat_memory
---

# LLM Chat Session

This is a reusable concept handle, not one fixed drawable node.

A chat session can be referenced below a Desk card, a runtime, a stored trace,
or a future goal. Each use is a distinct `ref_id` pointing at the same concept.
The viewer expands one local rectangle composition at a time and uses reference
edges to connect the other occurrences.

Time-specific state should be authored as separate composite snapshot files
that share a stable real-world `subject_id` when they describe one continuing
session.
