---
id: egdesk.ontology.schema
type: schema
layer: ontology
summary: Minimal Markdown/frontmatter schema for EG-Desk ontology concepts.
relations:
  constrains:
    - egdesk.ontology.index
    - egdesk.world
---

# Ontology Schema

Each ontology file is a graph node. Markdown body is for human reading. Frontmatter is for parsers and LLM context selection.

This is the preserved Markdown/graph **seed schema**. Once a profile is
initialized, its SQLite store is operational canonical; these files do not
automatically refresh or overwrite it. See
[Ontology SQLite Storage](../apps/firefox-ui-demo/docs/ONTOLOGY_SQLITE_STORAGE.md).

The ontology is not meant to become a Wikipedia clone. Basic object pages such as `terminal`, `cpu`, or `disk` can be thin handles. EG-Desk product concepts such as `egdesk.desk`, `egdesk.agenda`, or `egdesk.card` should keep short definitions because their meaning is custom to EG-Desk. The most important authored units for context-specific hierarchy are relation maps: notes that declare how objects are assembled for a specific work context.

## Required Frontmatter

```yaml
id: time.present
type: representative
layer: time
summary: Current executable state of the EG-Desk world.
relations:
  receives_from:
    - time.past
  drives:
    - action.execution
```

## Stable Fields

| Field | Purpose |
|---|---|
| `id` | Stable machine id. Prefer dotted ids. |
| `type` | Concept category such as `world`, `representative`, `surface`, `actor`, `primitive`. |
| `layer` | Coarse grouping such as `reality`, `architecture`, `time`, `operation`, `runtime`, `evidence`. |
| `summary` | One-line context summary for LLM preloading and graph labels. |
| `aliases` | Thin object-name variants, alternate spellings, or common labels. |
| `abbreviations` | Ambiguous short forms mapped to possible expansions. |
| `relations` | Typed edges to other concept ids. |
| `relation_edges` | Edges declared by a relation map between arbitrary source and target ids. |
| `view_cells` | Legacy view-specific home cells declared by a relation map. |
| `subject_id` | Stable real-world subject shared by time-specific snapshot documents. |
| `snapshot_id` | Unique ontology identity for one time-specific composite document. |
| `occurrences` | Reference occurrences that form the snapshot's recursive rectangle tree. |
| `reference_edges` | Typed links between occurrences, including time, layer, identity, and cyclic links. |

## Object Handle Metadata

Object pages should stay thin, but they can carry name-disambiguation metadata.

```yaml
id: moq
type: object_handle
layer: operation
summary: Object handle for an ambiguous MOQ token in a specific work context.
aliases:
  - MOQ
  - M.O.Q.
abbreviations:
  MOQ:
    - minimum order quantity
    - message-oriented queue
```

This does not define a universal concept. It only tells the parser and LLM what names may point at the same handle, and what ambiguity should be preserved.

## Product Concept Definitions

EG-Desk-specific concepts should have definitions because they are not generic world objects.

```yaml
id: egdesk.card
type: product_concept
layer: runtime
summary: EG-Desk visible work/runtime surface on the Desk.
aliases:
  - Card
relations:
  operates_inside:
    - egdesk.desk
  binds:
    - source.ref
```

Keep these definitions short. They should explain the EG-Desk meaning, the boundary against generic meanings, and stable product relations. Do not put every possible runtime composition into the product concept page; use relation maps for that.

## Relation Map Notes

Use relation map notes when the value is in the user's custom assembly, not in the generic definition of a concept.

```yaml
id: map.llm_chat_runtime_assembly
type: relation_map
layer: architecture
summary: Custom runtime assembly for understanding an LLM chat session inside EG-Desk.
relations:
  organizes:
    - entity.llm_chat_session
relation_edges:
  - source: desktop
    relation: contains
    target: terminal
  - source: terminal
    relation: uses
    target: cpu
```

This means:

```text
terminal.md says what object handle "terminal" refers to.
map.llm_chat_runtime_assembly.md says how terminal is assembled in this context.
```

The same object can participate in a different relation map for another domain.

## Composite Snapshot Notes

Time-specific composites are separate Markdown files even when they describe
one continuing real-world subject. `subject_id` stays stable; `snapshot_id` and
the occurrence tree may change.

```yaml
id: snapshot.company_server.present
type: composite_snapshot
subject_id: company-server
snapshot_id: company-server@present
time_slice: present
status: observed
root_ref: present.server
occurrences:
  - ref_id: present.server
    concept_id: server
    layer: virtual
  - ref_id: present.server.computer
    concept_id: computer
    parent_ref: present.server
    relation: runs_on
    layer: physical
reference_edges:
  - source_ref: present.server
    relation: implemented_by
    target_ref: present.server.computer
```

Snapshot rules:

- `time_slice` is `past`, `present`, or `future`.
- `status` is `historical`, `observed`, or `planned`.
- occurrence `layer` is only `virtual` or `physical`.
- `ref_id` is unique inside the complete generated graph.
- `root_ref` and every `parent_ref` must resolve.
- `parent_ref` must not form a cycle.
- the same `concept_id` may appear through many reference occurrences.
- containment, assembly, classification, and runtime relations use the same
  rectangle grammar; their typed `relation` values remain in data.
- reference lines represent reused concepts, cycles, layer crossings, and
  time transitions that cannot be expressed by finite nesting alone.

## Legacy View Cell Notes

Home placement is view- and map-specific, not a universal property of an
object. Declare it on the relation map that owns the curated projection:

```yaml
view_cells:
  - node: entity.llm_chat_session
    view: view.time_sliced_flat_deck
    time_slice: present
    runtime_stratum: virtual
    role: identity_anchor
    x: 0.15
    y: 0.16
    order: 10
```

`time_slice` must be `past`, `present`, or `future`.
`runtime_stratum` must be `virtual` or `physical`. Information and meaning are
attributes or types of virtual concepts, not a third runtime stratum.
The same node may have only one home cell inside one map/view pair. `x` and
`y` are optional normalized layout hints. Do not author `LayerDepth`; derive it
from same-stratum `contains` / `part_of` relations.

`role` defaults to `projection`. `identity_anchor` is retained only for legacy
authored views. The composite-lens renderer selects by `ref_id` and does not
require a separate canonical identity node on screen.

## Faceted Modeling Fields

These can appear in frontmatter for simple cases or in the Markdown body for richer examples. The current parser treats frontmatter as the graph edge source and Markdown as human/LLM context.

| Field | Purpose |
|---|---|
| `canonical_id` | Stable identity shared by projections of the same thing. |
| `facet` | Lens used by a projection, such as `facet.space` or `facet.time`. |
| `projection_id` | Stable id for a drawable projection node. |
| `view` | Intended view preset or rendering mode. |
| `source_ref` | Durable pointer to the file, repo, DB row, URL, or runtime state backing the concept. |
| `axis` | Primary axis for a projection: `axis.space`, `axis.time`, or `axis.virtual`. |
| `binding_type` | Intertwining pattern such as `storage`, `topology`, `intent`, or `action`. |

Projection ids should make the facet obvious:

```text
projection.<canonical>.<facet>.<local_name>
```

Example:

```text
projection.llm_chat_session.storage.session_file
```

## Relation Vocabulary

Start with a small relation set:

| Relation | Meaning |
|---|---|
| `contains` | Parent occurrence contains a child in the authored local composite. |
| `part_of` | Child occurrence belongs to an authored parent composite. |
| `implemented_by` | A virtual/product occurrence is realized through another occurrence, often on the physical stratum. |
| `runs_on` | A software/runtime occurrence executes on a physical substrate. |
| `stored_in` | An information-bearing concept or evidence is persisted in a storage substrate. |
| `represents` | Node represents a real, information, or virtual thing. |
| `projects_into` | Source is projected into a runtime/view layer. |
| `receives_from` | Node is updated by another node. |
| `drives` | Node drives another node or action. |
| `acts_on` | Actor/action acts on a target surface/object. |
| `observes` | Node observes target state without owning it. |
| `records` | Node records traces/evidence about target. |
| `branches_into` | Node can produce alternate branches or futures. |
| `branches_from` | Node branches from a current state, goal, or plan. |
| `binds` | Node binds a concept to a runtime resource. |
| `derived_from` | Node is derived from another node or evidence. |
| `represented_by` | Abstract concept is represented by concrete runtime/evidence nodes. |
| `provides_evidence_for` | Evidence-bearing node supports another node. |
| `updates` | Node mutates or refreshes another node. |
| `uses` | Node depends on a primitive, actor, or resource. |
| `informs` | Node influences another node without directly updating it. |
| `operates_inside` | Actor/process is scoped inside a world or surface. |
| `receives_constraints_from` | Node is governed by another node's constraints. |
| `constrains` | Node limits or governs another node. |
| `visualizes` | View node visualizes another concept or graph. |
| `visualized_by` | Concept is visualized by a view node. |
| `implements` | Plan or artifact implements a concept or decision. |
| `same_identity_as` | Projection shares canonical identity with another projection. |
| `projects_as` | Canonical concept projects into a specific projection node. |

## Reference-Web Modeling Rule

The default visual grammar is rectangle-first: the selected reference and its
direct children form one local composite. The data model still preserves the
typed relation carried by each occurrence.

```text
Concept
  -> referenced by many occurrences
  -> occurrences form local composite rectangles
  -> reference edges connect reused, cyclic, layer, and time contexts
```

The runtime strata are:

```text
Virtual
Physical
```

Time is represented by separate snapshot documents and time-axis reference
edges. Each time coordinate partitions continuous virtual and physical planes;
time is not itself a pane surface.
Storage, topology, intent, and action remain relation metadata rather than
additional strata.

## Context Loading Rule

An LLM should not load the whole ontology by default.

```text
index.md
  -> selected concept files
  -> selected relation neighbors
  -> source docs only when needed
```

## Web UI Rule

The web UI renders the profile-bound SQLite graph. Markdown frontmatter and
links define the preserved authoring seed, and generated graph files remain
secondary seed artifacts. Neither a changed seed nor a UI cache replaces an
initialized operational database automatically.

The current composite-lens renderer draws reference occurrences as its primary
screen objects. It preserves canonical identity through `concept_id`, while
selection and rectangle nesting use `ref_id`. A future inspector or alternate
faceted view may expose projection metadata, but neither is required by v2.
