---
id: axis.space
type: primary_axis
layer: ontology
summary: Physical, spatial, and compute-object axis for real objects, hardware, files, surfaces, cards, and runtime resources.
relations:
  constrains:
    - ontology.projection
  represented_by:
    - facet.space
  intertwines_with:
    - axis.time
    - axis.virtual
---

# Space Axis

The space axis is for physical, spatial, and compute-object reality.

It includes:

- people, companies, places, and devices
- CPU, RAM, disk, GPU, OS, browser, terminal, backend, database
- files, folders, repos, Drive documents, source refs as addressable objects
- visible panes, cards, canvas placement, and screen surfaces

## Rule

Space is not just visual layout. It is the object/surface/resource axis.

```text
Space
  -> physical object
  -> compute object
  -> file/storage object
  -> visible surface
```

Storage and topology are not separate primary axes. They are binding patterns inside or across Space, Time, and Virtual.

