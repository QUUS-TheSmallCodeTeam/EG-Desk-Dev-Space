---
id: egdesk.card
type: product_concept
layer: runtime
summary: EG-Desk visible work/runtime surface on the Desk, optionally attached to a live runtime or source reference.
aliases:
  - Card
  - canvas card
relations:
  operates_inside:
    - egdesk.desk
  used_by:
    - egdesk.agenda
  binds:
    - source.ref
  represented_by:
    - projection.llm_chat_session.space.chat_card
---

# Card

Card is an EG-Desk product concept, not a generic rectangular UI element.

A Card is a visible work surface on the Desk. Some cards also own or attach to a runtime process, browser context, file view, chat session, terminal session, or generated artifact.

Card state is stored in Desk/world coordinates, not viewport pixels.

## Stable Definition

```text
Card = view/runtime surface on the Desk
```

The card concept covers a family of specific card types, such as browser card, file card, chat card, terminal card, result card, and ontology map card.

