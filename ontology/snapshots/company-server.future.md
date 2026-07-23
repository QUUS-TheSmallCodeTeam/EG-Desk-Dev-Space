---
id: snapshot.company_server.future
type: composite_snapshot
layer: runtime
summary: Planned future composition of the same company-server subject.
subject_id: company-server
snapshot_id: company-server@future
time_slice: future
status: planned
continues_from: company-server@present
root_ref: future.server
occurrences:
  - ref_id: future.server
    concept_id: server
    layer: virtual
    label: 회사 서버
    order: 10
  - ref_id: future.server.computer
    concept_id: computer
    parent_ref: future.server
    relation: runs_on
    layer: physical
    label: 컴퓨터 / PC
    order: 20
  - ref_id: future.server.computer.rack
    concept_id: server-rack
    parent_ref: future.server.computer
    relation: instance_of
    layer: physical
    label: 서버랙
    order: 30
  - ref_id: future.server.computer.rack.windows
    concept_id: windows-os
    parent_ref: future.server.computer.rack
    relation: runs
    layer: virtual
    label: Windows OS
    order: 40
  - ref_id: future.server.computer.rack.cpu
    concept_id: cpu
    parent_ref: future.server.computer.rack
    relation: composed_of
    layer: physical
    label: CPU
    order: 50
  - ref_id: future.server.computer.rack.ram
    concept_id: ram
    parent_ref: future.server.computer.rack
    relation: composed_of
    layer: physical
    label: RAM
    order: 60
  - ref_id: future.server.computer.rack.disk
    concept_id: disk
    parent_ref: future.server.computer.rack
    relation: composed_of
    layer: physical
    label: Disk
    order: 70
reference_edges:
  - source_ref: future.server
    relation: implemented_by
    target_ref: future.server.computer
  - source_ref: future.server.computer
    relation: refers_to
    target_ref: future.server.computer.rack
  - source_ref: present.server
    relation: continues_as
    target_ref: future.server
  - source_ref: present.server.computer
    relation: reconfigured_as
    target_ref: future.server.computer
  - source_ref: present.server.computer.macbook
    relation: replaced_by
    target_ref: future.server.computer.rack
  - source_ref: present.server.computer.macbook.macos
    relation: migrates_to
    target_ref: future.server.computer.rack.windows
---

# 회사 서버 · 미래

The real subject remains `company-server`, while this planned snapshot has a different document and composite identity.
