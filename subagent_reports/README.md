# subagent_reports/

**Purpose**: Temporary working files for subagent communication

## About This Folder

This folder contains reports created by subagents during task execution. These reports enable stateless communication between Main Thread and specialized agents.

### Why File-Based Reports?

Agents are **stateless** - they have NO conversation history. Reports are the ONLY communication medium.

**Like a company:**
- Boss assigns work → Employee writes report
- Boss reads report, adds comments
- Employee updates report addressing comments
- Repeat until work complete
- Boss archives or discards report

## File Lifecycle

```
1. Subagent creates report → YYYYMMDD_HHMM_[topic]-[agent].md
2. Main Thread reads report
3. Multi-turn communication (comments, updates)
4. DELETE when user issue resolved
```

## Naming Convention

`YYYYMMDD_HHMM_[topic]-[agent-type].md`

**Examples:**
- `20251122_1430_ag-ui-research-general.md`
- `20251122_1500_docker-integration-pm.md`
- `20251122_1530_theme-system-theia.md`

## Multi-turn Communication

Agents have no memory. Use inline comments for follow-up:

```markdown
<!-- MT (2025-11-22 15:45): Can you add performance benchmarks? -->
```

Then re-invoke agent with same report path to get updates.

**Example workflow:**
1. Agent creates initial report
2. MT reads, finds missing info, adds comment
3. MT re-invokes agent: "UPDATE REPORT FILE: [same path], address MT comments"
4. Agent updates report addressing comments
5. MT re-reads updated report
6. Repeat until complete

## When to Delete Reports

**DELETE when:**
- ✅ User's question fully answered
- ✅ Implementation complete and tested
- ✅ No more follow-up expected
- ✅ User issue/discussion resolved

**Do NOT delete:**
- ❌ After single read (might need follow-up)
- ❌ While waiting for agent updates
- ❌ During multi-turn discussions
- ❌ User might ask more questions

## Permanent Storage

If report contains valuable long-term knowledge:

1. **Extract** content to permanent location:
   - `references/[project]/online_references.md` - External tech docs
   - `ideas/confirmed/[FEATURE_NAME].md` - Approved PRDs
   - `ideas/brainstorming/[TOPIC].md` - Exploratory ideas

2. **Then DELETE** the report (NEVER `mv` directly)

## Folder Hygiene

**This folder should be mostly empty in committed code.**

Active reports exist only during development sessions.

- Delete reports when user issues resolved
- Run `/codebase-check` to find stale reports (>7 days old)
- Clean up before commits

---

**Remember**: Reports are temporary working files, not permanent documentation.
