---
id: egdesk.agenda
type: product_concept
layer: runtime
summary: EG-Desk work boundary pairing a task or objective with the execution environment needed to do it.
aliases:
  - Board
  - board thread
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

<a id="agenda"></a>

# Board

Board is an EG-Desk product concept, not a generic todo list or folder.

A Board is the work boundary that pairs a task, objective, or project slice with the execution environment needed to do it. On one Desk/Canvas, it composes materials, tools, conversations, groups, layout, and bindings; it does not create another Desk or workspace.

A Board can include:

- browser cards
- file cards
- chat cards
- terminal cards
- agent/context bindings
- account/profile bindings
- result cards
- run bubbles and run playback

Board nesting is a work decomposition graph, not a folder tree. Deep structure can exist in data, while the Desk UI shows the active slice.

A Saved Board is explicitly retained reusable work state. Automatically recovered
Desk layout, transient grouping, and open views may be associated with a
Board without becoming part of its saved revision.

## Stable Definition

```text
Board = work + execution environment pairing
```
