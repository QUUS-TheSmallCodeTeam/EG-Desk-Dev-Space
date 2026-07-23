---
id: egdesk.world
type: world
layer: ontology
summary: The virtual operating world formed by reality, architecture, and time representatives.
relations:
  contains:
    - reality.base
    - architecture.runtime
    - time.past
    - time.present
    - time.future
    - time.multiverse
    - operation.layer
  projects_into:
    - egdesk.desk
  constrains:
    - actor.runtime
---

# EG-Desk World

EG-Desk is not primarily a chat UI, a task runner, or a swarm manager.

It is a virtual operating world layered over reality and compute architecture. It lets the user see and manipulate work through time-aware representatives:

- [[reality.md]]: real companies, people, machines, files, services, customers, and accounts.
- [[architecture-runtime.md]]: hardware, OS, browser, terminal, app, cloud, repo, and database surfaces.
- [[time-past.md]]: evidence, logs, prior messages, git history, file revisions, and execution traces.
- [[time-present.md]]: current executable state and active work surface.
- [[time-future.md]]: vision, goals, plans, and tasks.
- [[time-multiverse.md]]: alternate branches, simulations, hypothetical states, and candidate futures.

Runtime actors such as humans, Codex, subagents, tools, browser controllers, and automation jobs operate inside this world. They should be assigned coordinates in the ontology rather than treated as the ontology itself.

## Design Implication

Swarm design comes after world design.

```text
EG-Desk World
  -> defines surfaces, evidence, time, permissions, and source refs
Runtime Actors
  -> operate inside those definitions
Swarm
  -> coordinated actor pattern, not the root model
```

The world is also faceted. One global containment tree is not enough, but a
selected occurrence can still be explained as a bounded local rectangle
composition.

```text
Canonical Concept
  -> Space projection
  -> Topology projection
  -> Time projection
  -> Storage projection
  -> Intent projection
  -> Action projection
```

In the current viewer, `concept_id` preserves reusable identity and `ref_id`
identifies each contextual occurrence. The selected occurrence and its direct
children form the local rectangle composition. Reuse, cycles, layer crossings,
and time continuity use typed [[cross-facet-binding.md|reference edges]]. The
[[identity-rail.md]] is deferred and is not part of the v2 card.

Space, Time, and Virtual above are ontology-authoring axes. They must not be
confused with the viewer's two runtime strata, `virtual` and `physical`.
