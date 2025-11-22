# External References Setup Guide

This folder contains reference materials for EG-DESK development.

## Setup Instructions

After cloning the main repository, you need to clone the external reference repositories:

```bash
cd references

# Clone Theia (shallow clone for reference)
git clone --depth 1 https://github.com/eclipse-theia/theia.git theia

# Clone Playwright
git clone --depth 1 https://github.com/microsoft/playwright.git playwright

# Clone Puppeteer
git clone --depth 1 https://github.com/puppeteer/puppeteer.git puppeteer

# Clone Google Gemini CLI
git clone --depth 1 https://github.com/google-gemini/gemini-cli.git gemini-cli

# Clone Deta Surf
git clone --depth 1 https://github.com/deta/surf.git surf

# Clone Infinite Canvas
mkdir -p infinite-canvas
cd infinite-canvas
git clone --depth 1 https://github.com/emilefokkema/infinite-canvas.git infinite-canvas-master
cd ..
```

**Or simply run the setup script from the root directory:**
```bash
# Linux/Mac
./setup.sh

# Windows
setup.bat
```

## Folder Structure

```
references/
├── README.md                 # Original reference docs
├── SETUP.md                  # This file - setup instructions
├── claude-agent-sdk/        # Claude agent development resources ✅ (in git)
├── light-system/            # LIGHT system reference materials ✅ (in git)
├── theia/                   # Eclipse Theia source ❌ (clone separately)
│   └── theia/
├── playwright/              # Playwright source ❌ (clone separately)
│   └── playwright/
├── puppeteer/               # Puppeteer source ❌ (clone separately)
│   └── puppeteer/
├── gemini-cli/              # Google Gemini CLI ❌ (clone separately)
│   └── gemini-cli/
├── surf/                    # Deta Surf browser ❌ (clone separately)
│   └── surf/
└── infinite-canvas/         # Infinite Canvas library ❌ (clone separately)
    └── infinite-canvas/
```

## Why Not Included in Main Git Repository?

External repositories (Theia, Playwright, Puppeteer, Gemini CLI, Deta Surf) are:
- **Large in size** (~300MB+ total)
- **Publicly available** (no need to duplicate)
- **Frequently updated** (easier to pull latest separately)
- **Git repositories themselves** (nested .git folders cause conflicts)

By cloning them separately:
- ✅ Main repository stays small (~10MB)
- ✅ Easy to update external references independently
- ✅ No git submodule complexity
- ✅ No nested .git folder conflicts
- ✅ Faster clone time for the main repo

## What's Included in Main Git?

The following folders **are** included in the main repository:
- `claude-agent-sdk/` - Essential agent development resources
- `light-system/` - LIGHT system reference materials and brainstorming
- Project-specific documentation files

These are small, project-specific, and not available elsewhere.

## Update Mechanism (setup.bat)

### How Updates Work

When you re-run `setup.bat`, it follows a **delete-and-reclone** strategy to ensure clean `depth 1` shallow clones:

1. **Checks parent directory** (e.g., `references/theia/`)
2. **Preserves user files** like `online_references.md`
3. **Deletes git repository** (e.g., `theia/theia/`) completely
4. **Re-clones fresh** with `git clone --depth 1`

### Why Delete-and-Reclone?

**Problem with `git pull --depth 1`:**
- Shallow clones have limited history
- `git pull` can fail with `fatal: refusing to merge unrelated histories`
- Doesn't guarantee depth 1 after updates

**Solution:**
```batch
if exist "repo" rmdir /s /q "repo"
git clone --depth 1 <url> repo
```

**Benefits:**
- ✅ Always ensures exactly depth 1 (1 commit only)
- ✅ Clean, predictable state
- ✅ No merge conflicts or history issues
- ✅ Preserves `online_references.md` and other files

### Folder Structure Protected

Each reference folder has this structure:
```
references/
└── theia/
    ├── online_references.md   ✅ Preserved during update (optional)
    └── theia/                 ❌ Deleted and re-cloned
        └── (git repository)
```

Only the **inner git repository folder** is deleted and re-cloned. User-created files in the parent folder remain intact.

## Creating online_references.md

You can optionally create an `online_references.md` file in any reference folder to store:
- Links to official documentation
- Useful blog posts and articles
- Community resources
- Technical notes

Example:
```
references/surf/online_references.md  ← Your research notes about Deta Surf
references/surf/surf/                 ← Actual cloned repository
```
