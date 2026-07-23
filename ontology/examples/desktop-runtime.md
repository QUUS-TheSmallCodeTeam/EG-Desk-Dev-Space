---
id: entity.desktop_runtime
type: canonical_entity
layer: architecture
summary: Canonical identity for the local desktop runtime across visible space, system topology, storage, and actions.
relations:
  uses:
    - ontology.canonical_concept
    - architecture.runtime
  represented_by:
    - projection.desktop_runtime.space.desktop_plane
    - projection.desktop_runtime.topology.hardware_os
    - projection.desktop_runtime.storage.local_disk
    - projection.desktop_runtime.action.app_execution
  binds:
    - entity.llm_chat_session
  operates_inside:
    - egdesk.world
---

# Desktop Runtime

Desktop runtime is both a visible workspace and an execution substrate.

Those are not the same projection.

## Facet Projections

| Facet | Projection | Valid Reading |
|---|---|---|
| Space | `projection.desktop_runtime.space.desktop_plane` | The visible desktop/canvas plane that contains cards and panes. |
| Topology | `projection.desktop_runtime.topology.hardware_os` | The Mac/Windows/Linux runtime composed of CPU, RAM, Disk, GPU, OS, browser, terminal, helper services, and network. |
| Storage | `projection.desktop_runtime.storage.local_disk` | Local filesystem and app state that can persist sessions, source files, logs, and caches. |
| Action | `projection.desktop_runtime.action.app_execution` | App execution, shell commands, browser operations, file IO, and automation steps. |

## Relation Map Rule

The chat card can be visibly inside the desktop plane while the chat runtime uses topology resources and writes storage traces. Those statements should be authored in relation maps, not as universal definitions of desktop, terminal, disk, CPU, or RAM.

```text
Space:
  Desktop plane contains Chat Card

Topology:
  Chat Runtime depends on Desktop Runtime

Storage:
  Chat Session File is stored on Disk
```

These are three different statements. The renderer must keep their facet labels visible or inferable.

For the current EG-Desk LLM chat context, see `map.llm_chat_runtime_assembly`.
