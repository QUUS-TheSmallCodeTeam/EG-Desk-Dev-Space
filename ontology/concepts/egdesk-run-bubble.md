---
id: egdesk.run_bubble
type: product_concept
layer: runtime
summary: Inspectable EG-Desk record of the plan, action, context, evidence, and provenance for one AI or automation run.
aliases:
  - Run Bubble
  - Plan Bubble
relations:
  operates_inside:
    - egdesk.agenda
  records:
    - action.execution
    - output.structured
  provides_evidence_for:
    - time.past
    - egdesk.run_playback
---

# Run Bubble

Run Bubble is an EG-Desk product concept.

It is the inspectable record for one run: plan, action, context, evidence, intermediate artifacts, and provenance. It is not hidden model reasoning. It is the user-facing, checkable trace EG-Desk can preserve.

## Stable Definition

```text
Run Bubble = inspectable plan/action/context record for one run
```

