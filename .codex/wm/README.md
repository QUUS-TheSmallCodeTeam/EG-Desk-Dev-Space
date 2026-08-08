# WM Operating Memory

This directory is the durable memory area for the project-scoped WM second-brain agent.

WM may create, update, and delete files here to maintain its own operating memory. These files are not product source, user-facing docs, or final deliverables. They are reusable working memory for source selection, file tracking, path context, negative results, unresolved decisions, and routing policy.

## Files
- `file-inventory.txt`: sorted snapshot of the Git-visible project surface: tracked files plus untracked non-ignored files. This is the deterministic baseline for drift checks.
- `file-inventory-hash`: SHA-256 hash of `file-inventory.txt`.
- `file-map.json`: sparse path map layered on top of the inventory. Use the `.claude/wm/file-map.json` shape: top-level `directories` and `key_files` maps with path strings as keys. Each value is a time-tagged semantic note, for example `[present] ...` or `[past][alt] ...`.
- `routing-policy.json`: reusable role/file routing policy. This is not a worker prompt bundle, context pack, or live communication channel.

## Inventory Generation
From the repository root, generate the inventory deterministically from Git's tracked and untracked non-ignored file surface, prefix every path with `./`, and sort bytewise:

```sh
git -c core.quotePath=false ls-files --cached --others --exclude-standard \
  | sed 's#^#./#' \
  | LC_ALL=C sort > .codex/wm/file-inventory.txt
shasum -a 256 .codex/wm/file-inventory.txt | awk '{print $1}' > .codex/wm/file-inventory-hash
```

## Rules
- Do not store secrets, credentials, tokens, browser profiles, or copied session data.
- Do not mirror `.claude/` or project docs wholesale. Link or summarize only what is needed for routing.
- Treat `file-inventory.txt` as an observed snapshot, not a semantic map.
- Do not enumerate ignored files or replace the Git-visible generation rule with a filesystem-wide scan. Ignored `node_modules/`, `target/`, reference checkout contents, and local artifacts remain outside the inventory even when present on disk.
- Keep `file-map.json` compact and contextual. It should annotate selected paths with time-tagged semantic notes, not copy the whole inventory into itself.
- Refresh `file-inventory.txt` and `file-inventory-hash` together.
- When the inventory hash changes, review whether `file-map.json` or `routing-policy.json` became stale.
- Prefer inline context transfer. Persist context only when it will be reused, relayed repeatedly, compared for drift, or resumed after interruption/compaction.
- Do not persist worker prompt bundles here by default. If a large or reusable context bundle must be persisted for a live mission, place it under `.tmp/codex-swarm/<mission-id>/`, not durable WM memory.
