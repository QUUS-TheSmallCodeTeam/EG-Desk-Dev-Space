---
id: operation.layer
type: operation
layer: operation
summary: The LLM-aware layer that maps reality, architecture, and time representatives into action.
relations:
  observes:
    - reality.base
    - architecture.runtime
    - time.present
  acts_on:
    - architecture.runtime
  updates:
    - time.past
    - time.present
    - time.future
    - time.multiverse
  uses:
    - source.ref
    - actor.runtime
---

# Operation Layer

The Operation Layer is where LLMs, tools, automation, and human decisions interact with the EG-Desk world.

It does four things:

1. Recognizes real-world objects and places behind digital resources.
2. Binds those objects to executable surfaces through source refs.
3. Performs actions through runtime actors and tools.
4. Emits structured outputs that update Past, Present, Future, or Multiverse.

The Operation Layer is not identical to a single model or subagent. It is the mapping and execution layer that lets many actor types work inside the same ontology.

