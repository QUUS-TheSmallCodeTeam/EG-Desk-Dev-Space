---
id: facet.topology
type: facet
layer: ontology
summary: Lens for runtime dependency, resource use, system architecture, and execution topology.
relations:
  uses:
    - ontology.facet
    - ontology.projection
  visualizes:
    - architecture.runtime
  constrains:
    - view.projection
---

# Topology Facet

The topology facet describes how runtime objects depend on each other.

It is the facet for:

- hardware and OS resources
- app, browser, terminal, helper, API, backend, and database paths
- resource dependency
- execution boundary
- local versus cloud placement

## Containment Rule

Topology containment means runtime composition or dependency, not visual overlap.

```text
Desktop runtime
  uses OS
  uses CPU
  uses RAM
  uses Disk

LLM chat session
  uses model runtime
  uses context window
  uses tool bridge
```

The topology facet can show that a chat session uses CPU/RAM while the space facet shows that the same session is a card on the desktop.

## Example

For `entity.llm_chat_session`, the topology projection may be:

```text
projection.llm_chat_session.topology.runtime
  label: Chat Runtime
  reads from: context window
  calls: tool bridge
  depends on: CPU/RAM/network/model endpoint
```

