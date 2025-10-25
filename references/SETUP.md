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
├── infinite-canvas/         # Infinite canvas library reference ✅ (in git)
├── eg-desk ideas/           # EG-DESK specific ideas and notes ✅ (in git)
├── theia/                   # Eclipse Theia source ❌ (clone separately)
├── playwright/              # Playwright source ❌ (clone separately)
├── puppeteer/               # Puppeteer source ❌ (clone separately)
├── gemini-cli/              # Google Gemini CLI ❌ (clone separately)
└── infinite-canvas/         # Infinite Canvas library ❌ (clone separately)
    └── infinite-canvas-master/
```

## Why Not Included in Main Git Repository?

External repositories (Theia, Playwright, Puppeteer, Gemini CLI) are:
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
- `infinite-canvas/` - Core canvas library reference
- `eg-desk ideas/` - Project-specific ideas and documentation

These are small, project-specific, and not available elsewhere.
