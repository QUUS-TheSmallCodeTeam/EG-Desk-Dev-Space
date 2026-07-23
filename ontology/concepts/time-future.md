---
id: time.future
type: representative
layer: time
summary: Intent-bearing representative of desired states and planned work.
relations:
  contains:
    - vision
    - goal
    - plan
    - task
  drives:
    - action.execution
  receives_from:
    - output.structured
    - time.multiverse
---

# Future Representative

Future is the intent-bearing representative.

It includes:

- Vision: durable direction and product/business intent
- Goals: active objectives
- Plans: human-readable work structure
- Tasks: executable work units

Future answers:

```text
Where are we trying to go?
Why does the next action matter?
What sequence should turn possible state into real state?
```

Future should be connected to Present through executable tasks, not left as a static roadmap.

