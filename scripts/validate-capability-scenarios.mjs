#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const documentPath = path.join(
  root,
  "docs/references/design-synthesis/egdesk-capability-scenario-connected-agent-work.md",
);
const failures = [];

if (!fs.existsSync(documentPath)) {
  failures.push(`missing file: ${path.relative(root, documentPath)}`);
}

const text = fs.existsSync(documentPath)
  ? fs.readFileSync(documentPath, "utf8")
  : "";

function duplicates(values) {
  const seen = new Set();
  const repeated = new Set();
  for (const value of values) {
    if (seen.has(value)) repeated.add(value);
    seen.add(value);
  }
  return [...repeated].sort();
}

function slugifyHeading(value) {
  return value
    .trim()
    .toLowerCase()
    .replace(/[`*_~]/g, "")
    .replace(/[^\p{L}\p{N}\s-]/gu, "")
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
}

function anchors(value) {
  const result = new Set(
    [...value.matchAll(/<a id="([^"]+)"><\/a>/g)].map((match) => match[1]),
  );
  for (const match of value.matchAll(/^#{1,6}\s+(.+)$/gm)) {
    const anchor = slugifyHeading(match[1]);
    if (anchor) result.add(anchor);
  }
  return result;
}

function validateLinks(file, value) {
  for (const match of value.matchAll(/\[[^\]]*\]\(([^)]+)\)/g)) {
    const target = match[1].trim();
    if (!target || /^(https?:|mailto:|app:)/.test(target)) continue;
    const [rawPath, fragment] = target.split("#", 2);
    const resolved = rawPath
      ? path.resolve(path.dirname(file), decodeURIComponent(rawPath))
      : file;
    if (!fs.existsSync(resolved)) {
      failures.push(`unresolved link: ${target}`);
      continue;
    }
    if (fragment && fs.statSync(resolved).isFile()) {
      const targetText = fs.readFileSync(resolved, "utf8");
      if (!anchors(targetText).has(decodeURIComponent(fragment).toLowerCase())) {
        failures.push(`unresolved fragment: ${target}`);
      }
    }
  }
}

const ecsIds = [...text.matchAll(/^###\s+(ECS-\d{2})\s+—/gm)].map(
  (match) => match[1],
);
const capIds = [...text.matchAll(/^###\s+(CAP-\d{2})\s+—/gm)].map(
  (match) => match[1],
);
const expectedEcs = Array.from(
  { length: 7 },
  (_, index) => `ECS-${String(index + 1).padStart(2, "0")}`,
);
const expectedCap = Array.from(
  { length: 13 },
  (_, index) => `CAP-${String(index + 1).padStart(2, "0")}`,
);

if (JSON.stringify(ecsIds) !== JSON.stringify(expectedEcs)) {
  failures.push(`ECS sequence mismatch: ${ecsIds.join(", ")}`);
}
if (JSON.stringify(capIds) !== JSON.stringify(expectedCap)) {
  failures.push(`CAP sequence mismatch: ${capIds.join(", ")}`);
}

const ecsSection = text.split("## 4. 연결된 업무 이야기 7개")[1]?.split("## 5.")[0] ?? "";
for (const [label, pattern] of [
  ["concrete Click label in ECS", /Click\s+\[/],
  ["keyboard command in ECS", /\bPress\b/],
  ["premature recommended UI label in ECS", /추천 기본안/],
  ["action-family UI table in ECS", /action family|pointer 행동|keyboard 행동/],
]) {
  if (pattern.test(ecsSection)) failures.push(label);
}

const uxNeutralHeader =
  "| # | 사용 상황·필요 | 사용자에게 필요한 정보 | 사용자 판단·행동 | System 책임 | Agent 책임 | 상태 전환·증거 | 예외·회복 |";
const uxNeutralHeaderCount = text.split(uxNeutralHeader).length - 1;
if (uxNeutralHeaderCount !== 7) {
  failures.push(`UX-neutral ECS table count mismatch: ${uxNeutralHeaderCount}`);
}

for (const marker of [
  "Ontology Resolution Receipt[n]",
  "Turn Context Revision[n]",
  "routine observation",
  "작업 사건 이력",
]) {
  if (!text.includes(marker)) failures.push(`missing adaptive-run marker: ${marker}`);
}

if (/사용자 UI 행동|Click\s+\[|\bPress\b/.test(text.split("## 5.")[1] ?? "")) {
  failures.push("CAP section contains premature concrete UI behavior");
}

const assignmentSection =
  text.split("## 6. 32개 RWS의 주 capability 배정")[1]?.split("## 7.")[0] ??
  "";
const assignedRws = [...assignmentSection.matchAll(/`(RWS-\d{4})`/g)].map(
  (match) => match[1],
);
const expectedRws = Array.from(
  { length: 32 },
  (_, index) => `RWS-${String(index + 1).padStart(4, "0")}`,
);
const missingRws = expectedRws.filter((id) => !assignedRws.includes(id));
const extraRws = assignedRws.filter((id) => !expectedRws.includes(id));
const duplicateRws = duplicates(assignedRws);
if (missingRws.length) failures.push(`primary RWS missing: ${missingRws.join(", ")}`);
if (extraRws.length) failures.push(`unknown primary RWS: ${extraRws.join(", ")}`);
if (duplicateRws.length) {
  failures.push(`duplicate primary RWS: ${duplicateRws.join(", ")}`);
}

for (const marker of [
  "document_authority**: `NON-CANONICAL REFERENCE`",
  "synthesis_status**: `DESIGN-SYNTHESIS / PM-PROPOSAL`",
  "implementation_status**: `NOT-VERIFIED`",
]) {
  if (!text.includes(marker)) failures.push(`missing authority marker: ${marker}`);
}

for (const [label, pattern] of [
  ["absolute user path", /\/Users\//],
  ["file URI", /file:\/\//],
  ["email address", /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/i],
]) {
  if (pattern.test(text)) failures.push(`contains ${label}`);
}

validateLinks(documentPath, text);

const result = {
  ecs_count: ecsIds.length,
  cap_count: capIds.length,
  primary_rws_count: assignedRws.length,
  failures,
};

console.log(JSON.stringify(result, null, 2));
process.exitCode = failures.length ? 1 : 0;
