---
id: source.ref
type: primitive
layer: evidence
summary: Stable reference primitive binding ontology concepts to real runtime resources.
relations:
  binds:
    - reality.base
    - architecture.runtime
    - time.past
    - time.present
  used_by:
    - operation.layer
    - output.structured
---

# SourceRef

SourceRef binds ontology concepts to real resources.

It should remain small and extensible:

```ts
type SourceRef = {
  kind: string;
  uri?: string;
  path?: string;
  id?: string;
  scope?: string;
  accountId?: string;
  profileId?: string;
  openMode?: string;
};
```

SourceRef exists because URL, file path, repo path, account, browser profile, and runtime session are not interchangeable identities.

Examples:

- same URL under different browser profiles
- same file path in different worktrees
- same Gmail thread under different account visibility
- same Codex thread as chat history, session JSONL, and current UI card

SourceRef lets EG-Desk preserve those distinctions.

