---
id: time.present
type: representative
layer: time
summary: Current executable state of the EG-Desk world.
relations:
  receives_from:
    - reality.base
    - architecture.runtime
    - time.past
    - time.future
  drives:
    - action.execution
    - output.structured
  represented_by:
    - egdesk.desk
---

# Present Representative

Present is the current executable state.

It includes:

- visible Desk, Agenda, and Card state
- open browser profiles and pages
- active terminal processes
- current files and repo state
- running helper services
- current user intent and selected context
- available actors, tools, permissions, and runtime bindings

Present answers:

```text
What is live right now?
What can be acted on right now?
What changed since the last observed state?
```

The Present Representative is where EG-Desk differs from a passive knowledge base. It binds ontology to executable surfaces.
