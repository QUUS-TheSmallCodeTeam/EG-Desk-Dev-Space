---
id: architecture.runtime
type: architecture
layer: architecture
summary: Hardware and software topology that makes the EG-Desk world executable.
relations:
  receives_from:
    - reality.base
  drives:
    - time.present
---

# Architecture Runtime

Architecture runtime is the handle for the executable hardware/software environment EG-Desk is attached to.

It can include many objects:

- hardware: CPU, RAM, disk, GPU, sensors, power state
- OS and desktop: windows, files, apps, permissions, input devices
- execution surfaces: browser, terminal, editor, local app, cloud API, backend, DB
- code surfaces: repo, branch, worktree, test runner, build system
- EG-Desk surfaces: [[egdesk-desk.md]], [[egdesk-agenda.md]], [[egdesk-card.md]], [[egdesk-run-bubble.md]], [[egdesk-run-playback.md]]

Which of those objects are grouped together is a relation-map decision, not a universal definition of architecture.

## Existing Runtime Anchor

The current Firefox direction treats:

```text
egdesk.desk    = computer-level live work surface
egdesk.agenda  = work + execution environment pairing
egdesk.card    = view/runtime surface on the Desk
```

This ontology treats those as projections of architecture into the present work surface.
