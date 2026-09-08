#!/usr/bin/env node

import fs from "node:fs";
import crypto from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";

const validatorPath = fileURLToPath(import.meta.url);
const scriptDir = path.dirname(validatorPath);
const root = path.resolve(scriptDir, "..");
const casebookDir = path.join(root, "docs/references/real-work-scenarios");
const casesDir = path.join(casebookDir, "cases");
const readmePath = path.join(casebookDir, "README.md");
const indexPath = path.join(casebookDir, "INDEX.md");
const manifestPath = path.join(casebookDir, "MANIFEST.sha256");
const analysisPaths = [
  "BROWSER_FRACTURE_ANALYSIS.md",
  "MULTI_AGENT_TECHNIQUE_ANALYSIS.md",
  "MULTI_DEVICE_HANDOFF_ANALYSIS.md",
].map((name) => path.join(casebookDir, name));

const failures = [];

function read(file) {
  if (!fs.existsSync(file)) {
    failures.push(`missing file: ${path.relative(root, file)}`);
    return "";
  }
  return fs.readFileSync(file, "utf8");
}

function ids(text, pattern) {
  return [...text.matchAll(pattern)].map((match) => match[1]);
}

function duplicates(values) {
  const seen = new Set();
  const repeated = new Set();
  for (const value of values) {
    if (seen.has(value)) repeated.add(value);
    seen.add(value);
  }
  return [...repeated].sort();
}

function slugifyHeading(text) {
  return text
    .trim()
    .toLowerCase()
    .replace(/[`*_~]/g, "")
    .replace(/[^\p{L}\p{N}\s-]/gu, "")
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
}

function anchors(text) {
  const result = new Set(ids(text, /<a id="([^"]+)"><\/a>/g));
  for (const match of text.matchAll(/^#{1,6}\s+(.+)$/gm)) {
    const anchor = slugifyHeading(match[1]);
    if (anchor) result.add(anchor);
  }
  return result;
}

function validateLinks(file, text) {
  for (const match of text.matchAll(/\[[^\]]*\]\(([^)]+)\)/g)) {
    const target = match[1].trim();
    if (!target || /^(https?:|mailto:|app:)/.test(target)) continue;
    const [rawPath, fragment] = target.split("#", 2);
    const resolved = rawPath
      ? path.resolve(path.dirname(file), decodeURIComponent(rawPath))
      : file;
    if (!fs.existsSync(resolved)) {
      failures.push(
        `${path.relative(root, file)}: unresolved link ${target}`,
      );
      continue;
    }
    if (fragment && fs.statSync(resolved).isFile()) {
      const targetText = fs.readFileSync(resolved, "utf8");
      if (!anchors(targetText).has(decodeURIComponent(fragment).toLowerCase())) {
        failures.push(
          `${path.relative(root, file)}: unresolved fragment ${target}`,
        );
      }
    }
  }
}

const forbidden = [
  ["absolute user path", /\/Users\//],
  ["file URI", /file:\/\//],
  ["email address", /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/i],
];

function validatePrivacy(file, text) {
  for (const [label, pattern] of forbidden) {
    if (pattern.test(text)) {
      failures.push(`${path.relative(root, file)}: contains ${label}`);
    }
  }
}

const readme = read(readmePath);
const index = read(indexPath);
const manifest = read(manifestPath);
const caseFiles = fs.existsSync(casesDir)
  ? fs
      .readdirSync(casesDir)
      .filter((name) => name.endsWith(".md"))
      .sort()
      .map((name) => path.join(casesDir, name))
  : [];

const markdownEntries = [
  [readmePath, readme],
  [indexPath, index],
  ...analysisPaths.map((file) => [file, read(file)]),
];

for (const [file, text] of markdownEntries) {
  validateLinks(file, text);
  validatePrivacy(file, text);
}

const caseIds = [];
const sourceRefIds = [];
const claimIds = [];
const claimStatusCounts = new Map();
const requiredHeadings = [
  "## SourceRef",
  "## 실제 업무 흐름",
  "## 증거 경계",
  "## EG-Desk 목표 시나리오",
  "## Multi-agent technique opportunity",
  "## Candidate product implications",
  "## 열린 질문",
  "## Privacy",
];

for (const file of caseFiles) {
  const text = read(file);
  validateLinks(file, text);
  validatePrivacy(file, text);

  const foundCaseIds = ids(text, /<a id="(rws-\d{4})"><\/a>/g).map((id) =>
    id.toUpperCase(),
  );
  if (foundCaseIds.length !== 1) {
    failures.push(
      `${path.relative(root, file)}: expected exactly one RWS anchor`,
    );
  }
  const caseId = foundCaseIds[0];
  if (caseId) {
    caseIds.push(caseId);
    const expectedPrefix = `${caseId.toLowerCase()}-`;
    if (!path.basename(file).startsWith(expectedPrefix)) {
      failures.push(
        `${path.relative(root, file)}: filename must start with ${expectedPrefix}`,
      );
    }
    if (!text.includes(`# ${caseId} —`)) {
      failures.push(`${path.relative(root, file)}: missing matching title`);
    }
  }

  for (const heading of requiredHeadings) {
    if (!text.includes(heading)) {
      failures.push(`${path.relative(root, file)}: missing ${heading}`);
    }
  }
  for (const field of ["record_status", "evidence_state", "as_of"] ) {
    if (!new RegExp(`^[-*] \\*\\*${field}\\*\\*:`, "m").test(text)) {
      failures.push(`${path.relative(root, file)}: missing ${field}`);
    }
  }

  const sourceRows = [
    ...text.matchAll(/^\|\s*`(RWS-\d{4}-SR-\d{2})`\s*\|(.+)$/gm),
  ];
  sourceRefIds.push(...sourceRows.map((match) => match[1]));
  if (!text.includes("| SourceRef | source kind | access_class |")) {
    failures.push(`${path.relative(root, file)}: missing SourceRef access_class`);
  }
  for (const row of sourceRows) {
    if (
      !/\|\s*`(?:PUBLIC|LOCAL-RESTRICTED|PROJECT-RESTRICTED|ARCHIVED-SESSION-RESTRICTED)`\s*\|/.test(
        row[0],
      )
    ) {
      failures.push(
        `${path.relative(root, file)}: ${row[1]} missing valid access_class`,
      );
    }
  }

  const allClaims = ids(
    text,
    /^-\s*(?:\[[^\]]+\]\s*)?`(RWS-\d{4}-C\d{2})`:/gm,
  );
  const statefulClaims = [
    ...text.matchAll(
      /^-\s*\[(OBSERVED|VERIFIED-AS-OF|INFERRED|PROPOSED|UNKNOWN)\]\s*`(RWS-\d{4}-C\d{2})`:/gm,
    ),
  ];
  if (allClaims.length !== statefulClaims.length) {
    failures.push(
      `${path.relative(root, file)}: every claim needs an evidence-state marker`,
    );
  }
  for (const match of statefulClaims) {
    const [, status, claimId] = match;
    claimIds.push(claimId);
    claimStatusCounts.set(status, (claimStatusCounts.get(status) ?? 0) + 1);
  }
}

for (const [label, values] of [
  ["case IDs", caseIds],
  ["SourceRef IDs", sourceRefIds],
  ["claim IDs", claimIds],
]) {
  const repeated = duplicates(values);
  if (repeated.length) failures.push(`duplicate ${label}: ${repeated.join(", ")}`);
}

const orderedCaseIds = [...caseIds].sort();
if (orderedCaseIds.length) {
  const maxCaseNumber = Math.max(
    ...orderedCaseIds.map((id) => Number(id.slice("RWS-".length))),
  );
  const expectedCaseIds = Array.from(
    { length: maxCaseNumber },
    (_, index) => `RWS-${String(index + 1).padStart(4, "0")}`,
  );
  if (JSON.stringify(orderedCaseIds) !== JSON.stringify(expectedCaseIds)) {
    failures.push(
      `case IDs must be continuous: expected ${expectedCaseIds.join(", ")}`,
    );
  }
}

const indexIds = ids(index, /\|\s*`(RWS-\d{4})`\s*\|/g);
const missingFromIndex = caseIds.filter((id) => !indexIds.includes(id));
const missingCaseFile = indexIds.filter((id) => !caseIds.includes(id));
if (missingFromIndex.length) {
  failures.push(`case files missing from INDEX: ${missingFromIndex.join(", ")}`);
}
if (missingCaseFile.length) {
  failures.push(`INDEX rows missing case files: ${missingCaseFile.join(", ")}`);
}

const dispositionValues = [
  ...index.matchAll(
    /\|\s*`(MERGED\(RWS-\d{4}\)|PROMOTED\(RWS-\d{4}\)|RESEARCH\/PROBE|DEFER-EVIDENCE)`\s*\|\s*$/gm,
  ),
].map((match) => match[1]);
const dispositionCounts = {
  PROMOTED: dispositionValues.filter((value) => value.startsWith("PROMOTED("))
    .length,
  MERGED: dispositionValues.filter((value) => value.startsWith("MERGED("))
    .length,
  "RESEARCH/PROBE": dispositionValues.filter(
    (value) => value === "RESEARCH/PROBE",
  ).length,
  "DEFER-EVIDENCE": dispositionValues.filter(
    (value) => value === "DEFER-EVIDENCE",
  ).length,
};
const dispositionSummary = index.match(
  /\*\*2차 wave disposition 합계\*\*: `PROMOTED (\d+) \/ MERGED (\d+) \/ RESEARCH\/PROBE (\d+) \/ DEFER-EVIDENCE (\d+) = (\d+)`/,
);
if (!dispositionSummary) {
  failures.push("INDEX missing second-wave disposition summary");
} else {
  const expectedDispositionCounts = {
    PROMOTED: Number(dispositionSummary[1]),
    MERGED: Number(dispositionSummary[2]),
    "RESEARCH/PROBE": Number(dispositionSummary[3]),
    "DEFER-EVIDENCE": Number(dispositionSummary[4]),
  };
  const expectedDispositionTotal = Number(dispositionSummary[5]);
  if (
    JSON.stringify(dispositionCounts) !==
    JSON.stringify(expectedDispositionCounts)
  ) {
    failures.push("INDEX disposition counts do not match summary");
  }
  if (dispositionValues.length !== expectedDispositionTotal) {
    failures.push(
      `INDEX disposition total mismatch: ${dispositionValues.length} != ${expectedDispositionTotal}`,
    );
  }
}
for (const value of dispositionValues) {
  const target = value.match(/RWS-\d{4}/)?.[0];
  if (target && !caseIds.includes(target)) {
    failures.push(`INDEX disposition targets missing case: ${target}`);
  }
}

const manifestRows = [];
for (const [index, line] of manifest.split(/\r?\n/).entries()) {
  if (!line.trim()) continue;
  const match = /^([a-f0-9]{64})  (.+)$/.exec(line);
  if (!match) {
    failures.push(`MANIFEST.sha256:${index + 1}: malformed entry`);
    continue;
  }
  manifestRows.push({ hash: match[1], relativePath: match[2] });
}

const expectedManifestFiles = [
  readmePath,
  indexPath,
  ...analysisPaths,
  ...caseFiles,
  validatorPath,
]
  .map((file) => path.relative(root, file))
  .sort();
const actualManifestFiles = manifestRows
  .map((row) => row.relativePath)
  .sort();
const duplicateManifestFiles = duplicates(actualManifestFiles);
if (duplicateManifestFiles.length) {
  failures.push(
    `duplicate manifest files: ${duplicateManifestFiles.join(", ")}`,
  );
}
const missingManifestFiles = expectedManifestFiles.filter(
  (file) => !actualManifestFiles.includes(file),
);
const extraManifestFiles = actualManifestFiles.filter(
  (file) => !expectedManifestFiles.includes(file),
);
if (missingManifestFiles.length) {
  failures.push(
    `manifest missing files: ${missingManifestFiles.join(", ")}`,
  );
}
if (extraManifestFiles.length) {
  failures.push(`manifest has extra files: ${extraManifestFiles.join(", ")}`);
}

for (const row of manifestRows) {
  const resolved = path.resolve(root, row.relativePath);
  if (!resolved.startsWith(`${root}${path.sep}`) || !fs.existsSync(resolved)) {
    failures.push(`manifest unresolved path: ${row.relativePath}`);
    continue;
  }
  const actualHash = crypto
    .createHash("sha256")
    .update(fs.readFileSync(resolved))
    .digest("hex");
  if (actualHash !== row.hash) {
    failures.push(`manifest hash mismatch: ${row.relativePath}`);
  }
}

const result = {
  case_count: caseIds.length,
  source_ref_count: sourceRefIds.length,
  claim_count: claimIds.length,
  claim_status_counts: Object.fromEntries(
    [...claimStatusCounts.entries()].sort(([a], [b]) => a.localeCompare(b)),
  ),
  manifest_file_count: manifestRows.length,
  disposition_counts: dispositionCounts,
  failures,
};

console.log(JSON.stringify(result, null, 2));
process.exitCode = failures.length ? 1 : 0;
