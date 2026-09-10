#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const files = {
  governance: "docs/codex/egdesk-product-documentation-governance.md",
  owner: "docs/codex/egdesk-product-interaction-trace-atlas-editorial-ledger.md",
  ux: "docs/references/design-synthesis/egdesk-ux-realization-proposals.md",
  contract: "ideas/confirmed/EGDESK_INTERACTION_AND_ORCHESTRATION_CONTRACT.md",
  atlas: "ideas/confirmed/EGDESK_PRODUCT_INTERACTION_TRACE_ATLAS.md",
};
const allowIncomplete = process.argv.includes("--allow-incomplete");

function between(text, marker) {
  const start = `<!-- ${marker}:START -->`;
  const end = `<!-- ${marker}:END -->`;
  if (!text.includes(start) || !text.includes(end)) return "";
  return text.split(start, 2)[1].split(end, 1)[0];
}

function cells(line) {
  return line.trim().slice(1, -1).split("|").map((cell) => cell.trim());
}

function tableRows(text, idPattern) {
  return text.split(/\r?\n/)
    .filter((line) => line.startsWith("|") && line.endsWith("|"))
    .map(cells)
    .filter((row) => idPattern.test(row[0]));
}

function ids(text, pattern) {
  return [...text.matchAll(pattern)].map((match) => match[1]);
}

function repeats(values) {
  const seen = new Set();
  return [...new Set(values.filter((value) => {
    if (seen.has(value)) return true;
    seen.add(value);
    return false;
  }))];
}

function anchors(text) {
  const found = new Set(ids(text, /<a id="([^"]+)"><\/a>/g));
  const counts = new Map();
  for (const heading of ids(text, /^#{1,6}\s+(.+)$/gm)) {
    const slug = heading.replace(/<[^>]+>/g, "")
      .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
      .replace(/[`*_~]/g, "").toLowerCase()
      .replace(/[^\p{L}\p{N}_\s-]/gu, "")
      .replace(/[\s-]+/g, "-").replace(/^-|-$/g, "");
    if (!slug) continue;
    const count = counts.get(slug) ?? 0;
    found.add(count ? `${slug}-${count}` : slug);
    counts.set(slug, count + 1);
  }
  return found;
}

function localLinkErrors(file, text, cache) {
  const errors = [];
  for (const target of ids(text, /\[[^\]]*\]\(([^)]+)\)/g)) {
    const clean = target.trim().replace(/^<|>$/g, "");
    if (/^(?:https?:|mailto:|app:|plugin:)/.test(clean)) continue;
    const hash = clean.indexOf("#");
    const rawPath = hash < 0 ? clean : clean.slice(0, hash);
    const fragment = hash < 0 ? "" : decodeURIComponent(clean.slice(hash + 1));
    const resolved = rawPath
      ? path.resolve(path.dirname(file), decodeURIComponent(rawPath)) : file;
    if (!fs.existsSync(resolved)) {
      errors.push(`${path.relative(root, file)}: missing target ${target}`);
      continue;
    }
    if (fragment && fs.statSync(resolved).isFile()) {
      if (!cache.has(resolved)) cache.set(resolved, anchors(fs.readFileSync(resolved, "utf8")));
      if (!cache.get(resolved).has(fragment)) {
        errors.push(`${path.relative(root, file)}: missing anchor ${target}`);
      }
    }
  }
  return errors;
}

function validate() {
  const failures = [];
  const pending = [];
  const texts = Object.fromEntries(Object.entries(files).map(([key, file]) =>
    [key, fs.readFileSync(path.join(root, file), "utf8")],
  ));
  let currentTrace = "";
  let inActionTable = false;
  let actionCount = 0;
  let actionPlaceholderCount = 0;
  for (const line of texts.atlas.split(/\r?\n/)) {
    const heading = line.match(/^#### ([A-Z][A-Z0-9-]*-\d+)\./);
    if (heading) { currentTrace = heading[1]; inActionTable = false; continue; }
    if (currentTrace && line.startsWith("| ") && line.includes("제품 사용자 UI 행동")) { inActionTable = true; continue; }
    if (currentTrace && inActionTable && line.startsWith("| ")) {
      const row = cells(line);
      if (/^[-:]+$/.test(row[0])) continue;
      actionCount += 1;
      if (/\b(?:Q|HUM)-[A-Z0-9]+-\d+\b|정할 컨트롤|정의된 컨트롤/.test(row[1] ?? "")) {
        actionPlaceholderCount += 1;
        pending.push(`${currentTrace}/${row[0]}: action points to an unresolved control placeholder`);
      }
      continue;
    }
    if (inActionTable && line && !line.startsWith("|")) inActionTable = false;
    if (line.startsWith("## ")) currentTrace = "";
  }
  // ATL-ED-0028 splits V-03's Chat/Canvas interaction into four explicit actions (+3).
  if (actionCount !== 160) failures.push(`current manual must contain 160 action rows; found ${actionCount}`);
  const expected = ids(between(texts.governance, "QUESTION-ROUTING-REGISTRY"), /^\| `(Q-[A-Z]+-\d+)` \|/gm);
  const questions = ids(texts.governance, /<a id="atlas-q-[^"]+"><\/a>`(Q-[A-Z]+-\d+)`/g);
  const hums = new Set(ids(texts.owner, /^#### (HUM-[A-Z]+-\d+) —/gm));
  const ownerStatus = ids(texts.owner, /^- \*\*상태\*\*: `([^`]+)`/gm);
  const rows = tableRows(between(texts.governance, "DESIGN-CLOSURE-REGISTRY"), /^`Q-[A-Z]+-\d+`$/);
  const actual = rows.map((row) => row[0].replaceAll("`", ""));
  if (expected.length !== 175 || new Set(expected).size !== 175) failures.push("baseline must contain 175 unique Q IDs");
  if (repeats(actual).length) failures.push(`duplicate closure rows: ${repeats(actual).join(", ")}`);
  for (const q of expected) if (!actual.includes(q)) pending.push(`missing resolution: ${q}`);
  for (const q of actual) if (!expected.includes(q)) failures.push(`unknown resolution: ${q}`);
  if (expected.some((q) => !questions.includes(q)) || questions.some((q) => !expected.includes(q))) {
    failures.push("question body and routing registry differ");
  }

  const statusCounts = {};
  const referencedReviews = new Set();
  for (const row of rows) {
    const q = row[0].replaceAll("`", "");
    if (row.length !== 8) { failures.push(`${q}: expected 8 closure fields`); continue; }
    const [, statusCell, ux, technical, owner, research, verification, review] = row;
    const status = statusCell.replaceAll("`", "");
    statusCounts[status] = (statusCounts[status] ?? 0) + 1;
    if (!["GAP", "SPECIFIED", "REVIEWED-CLOSED"].includes(status)) failures.push(`${q}: invalid design status`);
    if (status !== "REVIEWED-CLOSED") pending.push(`${q}: ${status}`);
    if (!/egdesk-ux-realization-proposals\.md#/.test(ux)) failures.push(`${q}: missing concrete UX reference`);
    if (!/EGDESK_INTERACTION_AND_ORCHESTRATION_CONTRACT\.md#/.test(technical)) failures.push(`${q}: missing technical reference`);
    if (!/NOT-NEEDED|SUFFICIENT-FOR-DESIGN|OPEN-RESEARCH/.test(research)) failures.push(`${q}: invalid research disposition`);
    if (/OPEN-RESEARCH/.test(research)) pending.push(`${q}: research remains open`);
    if (/SUFFICIENT-FOR-DESIGN/.test(research) && !/\[[^\]]+\]\([^)]+\)/.test(research)) failures.push(`${q}: missing research source link`);
    if (!/PLANNED-NOT-RUN/.test(verification) || !/\[[^\]]+\]\([^)]+\)/.test(verification)) failures.push(`${q}: missing unexecuted verification plan`);
    const reviewIds = ids(review, /\[(REV-[A-Z0-9-]+)\]/g);
    if (!reviewIds.length) failures.push(`${q}: missing independent review record`);
    reviewIds.forEach((id) => referencedReviews.add(id));
    for (const hum of ids(owner, /(HUM-[A-Z]+-\d+)/g)) if (!hums.has(hum)) failures.push(`${q}: unknown owner dependency ${hum}`);
    if (status === "REVIEWED-CLOSED" && /TODO|TBD|추후 조사|추후 설계|미정 링크/.test(row.join(" "))) failures.push(`${q}: closed with placeholder`);
  }

  const reviewRows = tableRows(between(texts.governance, "DESIGN-REVIEWS"), /^`REV-[A-Z0-9-]+`$/);
  const reviewIds = reviewRows.map((row) => row[0].replaceAll("`", ""));
  const coverageByReview = new Map();
  const reviewCoverage = [];
  if (reviewRows.length !== 5 || repeats(reviewIds).length) failures.push("expected five unique independent review records");
  for (const id of referencedReviews) if (!reviewIds.includes(id)) pending.push(`missing review record: ${id}`);
  for (const row of reviewRows) {
    if (row.length !== 6) { failures.push(`${row[0]}: expected 6 review fields`); continue; }
    if (row[1] !== "`PASS`") pending.push(`${row[0]}: not passed`);
    if (!row[2] || !row[3] || row[2] === row[3]) failures.push(`${row[0]}: author/reviewer identity separation missing`);
    if (!row[4] || !row[5]) failures.push(`${row[0]}: review scope or disposition missing`);
    const covered = ids(row[4], /(Q-[A-Z]+-\d+)/g);
    coverageByReview.set(row[0].replaceAll("`", ""), new Set(covered));
    reviewCoverage.push(...covered);
    const people = (cell) => ids(cell, /([0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12})/g);
    if (people(row[2]).some((person) => people(row[3]).includes(person))) failures.push(`${row[0]}: reviewer also authored this scope`);
  }
  if (repeats(reviewCoverage).length) failures.push("independent review scopes overlap or repeat a question");
  for (const q of expected) if (!reviewCoverage.includes(q)) pending.push(`unreviewed question: ${q}`);
  for (const q of reviewCoverage) if (!expected.includes(q)) failures.push(`unknown reviewed question: ${q}`);
  for (const row of rows) {
    const q = row[0].replaceAll("`", "");
    const assigned = ids(row[7] ?? "", /\[(REV-[A-Z0-9-]+)\]/g);
    if (!assigned.some((id) => coverageByReview.get(id)?.has(q))) failures.push(`${q}: assigned review does not cover this question`);
  }

  const sourceRows = tableRows(between(texts.governance, "DESIGN-SOURCE-READS"), /^`RWS-\d{4}`$/);
  const sourceIds = sourceRows.map((row) => row[0].replaceAll("`", ""));
  const expectedSources = Array.from({ length: 32 }, (_, i) => `RWS-${String(i + 1).padStart(4, "0")}`);
  if (repeats(sourceIds).length) failures.push("duplicate RWS read receipts");
  for (const id of expectedSources) if (!sourceIds.includes(id)) pending.push(`missing source read: ${id}`);
  for (const row of sourceRows) {
    if (row.length !== 5) { failures.push(`${row[0]}: expected 5 source fields`); continue; }
    if (!expectedSources.includes(row[0].replaceAll("`", ""))) failures.push(`unknown source read: ${row[0]}`);
    if (row[2] !== "`READ-EVIDENCE`") pending.push(`${row[0]}: evidence not read`);
    if (!/\.md#rws-/.test(row[1]) || !row[3] || !row[4]) failures.push(`${row[0]}: incomplete source or use boundary`);
  }

  const cache = new Map();
  for (const [key, relative] of Object.entries(files)) failures.push(...localLinkErrors(path.join(root, relative), texts[key], cache));
  const fingerprintRows = tableRows(between(texts.governance, "DESIGN-REVIEW-FINGERPRINTS"), /^`(?:ATLAS|UX|CONTRACT)`$/);
  const fingerprintKeys = fingerprintRows.map((row) => row[0].replaceAll("`", "").toLowerCase());
  if (repeats(fingerprintKeys).length) failures.push("duplicate reviewed-document fingerprints");
  for (const key of ["atlas", "ux", "contract"]) {
    const row = fingerprintRows.find((item) => item[0] === `\`${key.toUpperCase()}\``);
    if (!row) { pending.push(`missing reviewed-document fingerprint: ${key}`); continue; }
    if (row.length !== 3) { failures.push(`${key}: expected three fingerprint fields`); continue; }
    const digest = row[2].replaceAll("`", "");
    if (!/^[0-9a-f]{64}$/.test(digest)) failures.push(`${key}: invalid SHA-256`);
    else if (digest !== createHash("sha256").update(texts[key]).digest("hex")) pending.push(`reviewed document changed: ${key}`);
  }
  if (!allowIncomplete) failures.push(...pending);
  return { design_complete: pending.length === 0 && failures.length === 0,
    question_count: expected.length, resolution_count: rows.length, status_counts: statusCounts,
    manual_action_count: actionCount, action_placeholder_count: actionPlaceholderCount,
    source_read_count: sourceRows.length, review_count: reviewRows.length, reviewed_document_count: fingerprintRows.length, implementation_evidence: "NOT-RUN",
    owner_open_topics: ownerStatus.filter((status) => status.startsWith("OPEN")).length,
    pending, failures };
}

try {
  const result = validate();
  console.log(JSON.stringify(result, null, 2));
  process.exitCode = result.failures.length ? 1 : 0;
} catch (error) {
  console.error(JSON.stringify({ failures: [String(error)] }));
  process.exitCode = 1;
}
