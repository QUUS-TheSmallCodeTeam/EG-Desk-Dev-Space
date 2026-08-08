---
id: egdesk.agenda
type: product_concept
layer: runtime
summary: EG-Desk work boundary pairing a task or objective with the execution environment needed to do it.
aliases:
  - Agenda
  - agenda thread
relations:
  operates_inside:
    - egdesk.desk
  contains:
    - egdesk.card
    - egdesk.run_bubble
    - egdesk.run_playback
  uses:
    - source.ref
  updates:
    - time.present
---

# Agenda

Agenda is an EG-Desk product concept, not a generic todo list or folder.

An Agenda is the work boundary that pairs a task, objective, or project slice with the execution environment needed to do it.

An Agenda can include:

- browser cards
- file cards
- chat cards
- terminal cards
- agent/context bindings
- account/profile bindings
- result cards
- run bubbles and run playback

Agenda nesting is a work decomposition graph, not a folder tree. Deep structure can exist in data, while the Desk UI shows the active slice.

An Agenda is explicitly retained reusable work state. Automatically recovered
Desk layout, transient grouping, and open views may be associated with an
Agenda without becoming part of its saved revision.

## Stable Definition

```text
Agenda = work + execution environment pairing
```
