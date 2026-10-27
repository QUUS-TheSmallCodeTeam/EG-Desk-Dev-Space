# Ontology SQLite Storage

## Canonical boundary

After a Firefox profile's first successful import, its SQLite ontology store
is the operational source of truth. `ontology/**/*.md` and the generated
`overlay/resources/ontology/graph.json` remain preserved authoring/migration
seeds; they are not a live mirror of that database.

Editing Markdown, rebuilding the graph, reinstalling the overlay, and
restarting the bridge do **not** authorize replacing an initialized store.
There is no automatic seed-to-DB refresh or DB-to-Markdown synchronization.
The original seed archive is recovery evidence, not the current-state reader.

Storage does not change the rendering model: two runtime strata (`virtual`
and `physical`), separate time coordinates, stable concept/subject/snapshot/
occurrence identities, nested selected-reference/direct-child rectangles,
and typed reference edges. See [the rendering contract](./ONTOLOGY_CANVAS_RENDERING.md)
and [seed schema](../../../ontology/schema.md).

## Runtime and profile scope

The project pins Node in `apps/firefox-ui-demo/.node-version`; the current pin
is **24.22.1**. The launcher uses the project-local runtime, not an arbitrary
Node on `PATH`. `assertPatchedSqliteRuntime()` measures the actual SQLite
library using an in-memory database before a persistent ontology store opens.
The guard checks Node 24+ and the fixed SQLite branches, not Node's version
alone. See [SQLite's WAL-reset advisory](https://sqlite.org/wal.html).

The installation utility is `scripts/install-egdesk-node.mjs`. It verifies
the pinned distribution's SHA-256 before extraction and refuses to replace an
existing invalid runtime. Runtime installation is a separate operator action;
it does not migrate user databases.

`ontologyStoragePaths({ dataDir, profileId })` resolves:

```text
<app-data>/ontology/profiles/<profile-id>/
  legacy-graph.json    preserved first profile seed
  ontology.sqlite     operational store
```

The profile ID is derived from the launcher-validated Firefox profile path
passed through `EGDESK_FIREFOX_PROFILE`, not a ChatGPT account.
`prepareOntologyProfileBinding()` must run before overlay replacement to
preserve the profile's installed graph; a profile without a graph uses the
bundled seed. The macOS and Windows launchers call this preparation step before
overlay synchronization. Passing the profile environment variable alone does
not create the binding or baseline; custom launch paths must perform that
preparation before first use.
The profile binding marker contains a local access token. Do not print, copy
into reports, or place that token in URLs. Renaming or moving a profile changes
its path-derived identity; it is not an automatic database-transfer operation.

## Import, preservation, and failure behavior

The implementation entry points are:

- `readOntologySeed({ graphPath, ontologyRoot, sourceLabel })`: reads a graph
  and all Markdown files under the source root without editing them; rejects
  a mismatched source hash before opening a database.
- `migrateOntologyGraph({ dbPath, graphPath, ontologyRoot, sourceLabel })`:
  explicitly opens a store and attempts the one-time import; this is a
  mutating operation, not a health check.
- `openOntologyStore({ dbPath })`: checks runtime, file scope, database
  application/schema version, and integrity. Opening a new path can create a
  database; do not use this as a read-only probe against an unknown live path.
- Store methods: `importGraph`, `readGraph`, `status`, `integrity`,
  `exportArchive`, and `close`.

Store schema version **1** is separate from graph schema version **3**.
Concepts, edges, snapshots, occurrences, and reference edges have indexed
identity/relationship columns plus lossless JSON payloads and original order.
`readGraph()` reconstructs the current rows; it does not return the archived
seed as a substitute. Unknown JSON properties and Markdown bodies are retained.
In status, `graphHash` describes the reconstructed current graph;
`import.graphHash` and `import.rawGraphHash` describe the original import.
The graph's `sourceHash` retains its authored-source provenance and is not a
promise that the current checkout still matches the operational database.

One import transaction records the graph rows, original graph bytes and
SHA-256 hashes, supplied source document paths/bytes/hashes, and import provenance.
Validation includes duplicate identities, missing references, parent cycles,
foreign keys, and agreement between indexed columns and JSON payloads.
A failed import rolls back. Unsupported/future database versions, corrupt
stores, and unsafe file scopes are refused, not deleted or reset.

Reimporting the same archived input is a no-op. A changed seed is refused with
`ONTOLOGY_ALREADY_INITIALIZED`; it cannot overwrite current rows. Normal
bridge startup does not reread the seed once the store is initialized.
`exportArchive()` returns original import data to the caller without writing
files. It is not a backup of later operational changes.

There are two distinct import paths:

- Normal profile startup (`openBoundOntologyStore`) imports the preserved raw
  graph with `sourceDocuments: []`. Its graph bodies are retained, but it does
  not claim that the currently checked-out Markdown matches that older graph.
  Protected `/ontology/health` reports `baseline.sourceMode: "graph-only"`.
- Explicit migration (`migrateOntologyGraph`) also archives the original
  Markdown files after `readOntologySeed()` verifies their combined
  `sourceHash`. Protected `/ontology/health` reports
  `baseline.sourceMode: "graph-and-archived-documents"`
  when documents were supplied. This must be performed before automatic first
  initialization if that profile's DB must include the source-document archive;
  reimport is not an archive-enrichment or replacement command.

The graph and Markdown for explicit migration must come from the same frozen
source generation. Documentation-only edits under `ontology/` also change
generated bodies and `sourceHash`. The helper rejects this mismatch with
`ONTOLOGY_STALE_SEED`; it never regenerates the graph itself. Preserve the
original graph **and** original Markdown before edits; coordinate first import
and any later seed regeneration explicitly. For migration of the preserved
original, use its matching archived Markdown, not newly edited source files.
Rebuilding a later seed does not refresh an already initialized profile DB.

## Read-only API and verification

The bridge exposes `GET /ontology/graph` and `GET /ontology/health` with no
query parameters. Both require the bound profile header
`x-egdesk-ontology-profile` and local token header `x-egdesk-ontology-token`.
They do not use provider login. Wrong profiles/tokens and unavailable stores
are refused; a missing store is not permission to fall back to a bundled graph.

The general `GET /health` response exposes only `profileId`, `ready`, and
`sqlite` in its sanitized `ontology` summary; it does not include `baseline`.
This command checks readiness and runtime support without printing graph
bodies or the profile token:

```sh
curl -fsS http://127.0.0.1:39218/health | jq '{ontology: (.ontology | {ready, sqlite})}'
```

Check `ontology.ready` and `ontology.sqlite.supported` in the general response.
A missing `ontology` field can mean an older bridge.

For initialization, integrity, and provenance details, use protected
`GET /ontology/health` with both existing profile/token headers described above.
Its response includes `baseline`: check `baseline.initialized`,
`baseline.integrity.ok`, `baseline.sourceMode`, document count, and import/source
hashes there, not at `/health`. Keep the binding token private; do not print it
or include it in diagnostic output. Zero source documents is expected for
graph-only initialization, not proof of Markdown loss.

A successful health response is not evidence
that the visible window has loaded the correct profile graph: also verify the
existing time/layer/nested-selection behavior without making a provider call.

From `apps/firefox-ui-demo`, inspect the runtime without opening a user DB:

```sh
EGDESK_ONTOLOGY_NODE="$(node --input-type=module -e 'import { pinnedNodeExecutable } from "./helper/egdesk-node-runtime.mjs"; process.stdout.write(pinnedNodeExecutable())')"
"$EGDESK_ONTOLOGY_NODE" --input-type=module -e 'import { assertPatchedSqliteRuntime } from "./helper/egdesk-sqlite-runtime.mjs"; console.log(JSON.stringify(assertPatchedSqliteRuntime()))'
```

Before production changes, the operator must identify the exact profile and
stores, preserve a consistent SQLite backup (including committed WAL data),
and verify it. A bare copy of a live `.sqlite` file is not a sufficient WAL
backup. Coordinate shutdown with active Terminal PTYs and other work; do not
delete journals, reset a DB, replay Chat messages, or install an older database
version to make a check pass. On failure, retain the original files and report
the bounded error code/integrity result before deciding on recovery.
