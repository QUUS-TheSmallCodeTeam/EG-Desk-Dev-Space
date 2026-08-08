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

SourceRef exists because URL, file path, repo path, account, browser profile,
and runtime session are not interchangeable reference coordinates, even when
some of them resolve to identical content.

Examples:

- same URL under different browser profiles
- same file path in different worktrees
- same Gmail thread under different account visibility
- same Codex thread as chat history, session JSONL, and current UI card

SourceRef lets EG-Desk preserve those distinctions.

Preserving the distinctions does not mean they are one identity dimension.
EG-Desk separates:

```text
source/evidence reference
content identity and revision
resource identity/locator
account/profile permission and execution context
view/runtime instance
```

If two accounts expose verified identical content, that content can support the
same claim. The account/profile still matters for hidden data, available
actions, authorization, and audit identity. Read/evidence deduplication and
action authorization therefore use different comparisons even if one
extensible SourceRef record currently carries fields for both.
