---
id: snapshot.company_server.present
type: composite_snapshot
layer: runtime
summary: Observed present composition of the single company-server subject.
subject_id: company-server
snapshot_id: company-server@present
time_slice: present
status: observed
root_ref: present.server
occurrences:
  - ref_id: present.server
    concept_id: server
    layer: virtual
    label: 회사 서버
    order: 10
  - ref_id: present.server.computer
    concept_id: computer
    parent_ref: present.server
    relation: runs_on
    layer: physical
    label: 컴퓨터
    order: 20
  - ref_id: present.server.computer.macbook
    concept_id: macbook
    parent_ref: present.server.computer
    relation: instance_of
    layer: physical
    label: MacBook
    order: 30
  - ref_id: present.server.computer.macbook.macos
    concept_id: macos
    parent_ref: present.server.computer.macbook
    relation: runs
    layer: virtual
    label: macOS
    order: 40
  - ref_id: present.server.computer.macbook.cpu
    concept_id: cpu
    parent_ref: present.server.computer.macbook
    relation: composed_of
    layer: physical
    label: CPU
    order: 50
  - ref_id: present.server.computer.macbook.ram
    concept_id: ram
    parent_ref: present.server.computer.macbook
    relation: composed_of
    layer: physical
    label: RAM
    order: 60
  - ref_id: present.server.computer.macbook.disk
    concept_id: disk
    parent_ref: present.server.computer.macbook
    relation: composed_of
    layer: physical
    label: Disk
    order: 70
reference_edges:
  - source_ref: present.server
    relation: implemented_by
    target_ref: present.server.computer
  - source_ref: present.server.computer
    relation: refers_to
    target_ref: present.server.computer.macbook
---

# 회사 서버 · 현재

The real subject is `company-server`. This file is its observed present ontology snapshot.
