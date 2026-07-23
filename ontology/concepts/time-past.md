---
id: time.past
type: representative
layer: time
summary: Evidence-bearing representative of prior states, actions, and artifacts.
relations:
  represents:
    - logs.execution
    - history.chat
    - history.tool
    - history.git
    - revisions.file
  records:
    - action.execution
  provides_evidence_for:
    - time.present
    - output.structured
---

# Past Representative

Past is not just memory. It is the evidence-bearing representative of prior world states.

Examples:

- chat history
- tool history
- execution logs
- git history
- file revisions
- browser history
- screenshots and snapshots
- run playback records
- source references and provenance notes

Past answers:

```text
What happened?
What did we know?
What changed?
What can be replayed, cited, compared, or rolled back?
```

Past provides evidence to [[time-present.md]] and [[structured-output.md]]. It should be compactly indexable so an LLM can load only the relevant traces.

