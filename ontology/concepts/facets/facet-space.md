---
id: facet.space
type: facet
layer: ontology
summary: Lens for visible spatial placement, overlap, panes, cards, and canvas geography.
relations:
  uses:
    - ontology.facet
    - ontology.projection
  visualizes:
    - architecture.runtime
    - egdesk.desk
  constrains:
    - view.projection
---

# Space Facet

The space facet describes where a concept appears in the visible EG-Desk canvas.

It is the facet for:

- desktop panes
- cards
- panels
- 2D/2.5D canvas placement
- visible overlap
- camera position, pan, zoom, and tilt

## Containment Rule

Spatial containment means visible containment only.

```text
Desktop pane
  contains Browser Card
  contains Chat Card
  contains Ontology Map Card
```

It does not automatically mean runtime ownership, file storage, memory, or intent ownership.

## Example

For `entity.llm_chat_session`, the space projection may be:

```text
projection.llm_chat_session.space.chat_card
  label: Chat Card
  parent plane: Desktop
  readable as: the user-facing place where the conversation is visible
```
