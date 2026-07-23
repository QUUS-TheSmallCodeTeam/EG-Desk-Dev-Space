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

It is the guided, step-by-step canvas walkthrough for a result. It lets the user follow derivation spatially on the Desk: what evidence was used, which cards mattered, what changed, and how the final output emerged.

Run Playback is related to Run Bubble, but they are not the same:

- Run Bubble stores the inspectable record.
- Run Playback presents a guided temporal/spatial walkthrough.

## Stable Definition

```text
Run Playback = guided canvas replay for one run
```

