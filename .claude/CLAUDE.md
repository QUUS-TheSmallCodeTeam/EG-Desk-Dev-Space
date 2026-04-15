# EG-DESK

## Folder Structure

```
.claude/
├── agents/            # Project-specific agent templates
├── commands/          # Project-specific commands (codebase-check)
├── docs/              # Project context — WM/PM reads this (human-curated)
└── wm/                # WM storage — auto-maintained, git-tracked

references/            # External references (git clones + docs)
├── [project-name]/    # Each with online_references.md
└── ...

ideas/
├── confirmed/         # Approved PRDs (SCREAMING_SNAKE_CASE.md)
└── brainstorming/     # Exploratory ideas

docs/                  # General project documentation
```

## Conventions

- PRD naming: `ideas/confirmed/SCREAMING_SNAKE_CASE.md`
- Reference projects: `references/[project-name]/` with `online_references.md`
- Setup scripts: `setup.sh` / `setup.bat` for reference repo cloning