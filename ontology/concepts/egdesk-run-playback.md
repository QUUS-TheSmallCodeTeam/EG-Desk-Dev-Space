---
id: egdesk.run_playback
type: product_concept
layer: runtime
summary: Canvas-native guided playback that lets the user inspect how a result was derived across cards, evidence, and steps.
aliases:
  - Run Playback
  - Canvas Run Playback
relations:
  operates_inside:
    - egdesk.agenda
  derived_from:
    - egdesk.run_bubble
  visualizes:
    - output.structured
    - time.past
---

# Run Playback

Run Playback is an EG-Desk product concept.

It is the Prezi-like, guided temporal/spatial canvas walkthrough for a result.
It lets the user follow what evidence was used, which Desk Windows mattered,
what changed, and how the final output emerged. The user can anchor comments to
a step and insert selected comments into the next Chat message.

Run Playback is related to Run Bubble, but they are not the same:

- Run Bubble stores the inspectable record.
- Run Playback presents a guided temporal/spatial walkthrough.

Playback comments are annotations linked back to conversation. They do not
automatically branch or fork a run.

## Stable Definition

```text
Run Playback = guided canvas replay for one run
```
