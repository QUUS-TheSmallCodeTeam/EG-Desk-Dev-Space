# EG-DESK

**Spatial Canvas Platform for AI-Powered Workflow Management**

EG-DESK is an Electron-based desktop application featuring an infinite canvas interface where users can organize and interact with multiple content types: browser windows, native tools, AI-generated web applications, and code editors.

## Project Status

**Current Phase**: Research & Architecture Planning

This repository is in the research and planning phase. We are evaluating technologies, designing the architecture, and preparing for implementation.

## Architecture Overview

### Core Concept

EG-DESK = **Infinite Canvas** + **Window Management** + **AI Orchestration**

The platform allows users to:
- Place multiple browser windows (WebContent) on an infinite canvas
- Embed native EG-DESK tools (code editor, workflow diagram, settings)
- Display AI-generated web apps served on localhost as if they were local applications
- Seamlessly integrate with AI agents for automated workflows

### Key Components

1. **Infinite Canvas System**
   - Primary user interface
   - Spatial organization of windows and content
   - Pan, zoom, and arrange functionality

2. **Window Management**
   - BaseWindow with multiple WebContents (browser-like)
   - Native tool windows (code editor, diagrams, settings)
   - Dynamic window creation and placement

3. **Browser Control**
   - Full web browsing capabilities
   - Multiple simultaneous web pages
   - Web content automation

4. **AI Agent Orchestration**
   - AI agents for workflow automation
   - Integration with code tools and browsers
   - Automated task execution

5. **External Tool Integration**
   - Theia: Code editor and IDE capabilities (embeddable tool)
   - Other embeddable tools as needed

## Repository Structure

```
EG-Desk-Dev-Space/
├── src/                          # Development code (EG-DESK implementations)
│   └── CODEBASE_STRUCTURE.md    # Services & keybindings registry
├── docs/                         # External public documentation
│   ├── EG-DESK_Whitepaper.md
│   └── EG-DESK_백서_한글.md
├── ideas/                        # Feature ideation and planning
│   ├── brainstorming/           # Deferred or exploratory ideas
│   └── confirmed/               # Approved PRDs ready for implementation
├── references/                   # External reference materials
│   └── [project]/
│       ├── [project]/           # git clone (shallow, NOT git tracked)
│       └── online_references.md # Research notes (git tracked)
├── .claude/                      # AI Agent Swarm System
│   ├── agents/                  # Agent definitions
│   ├── commands/                # Slash commands
│   └── prompts/                 # Prompt templates
├── subagent_reports/            # Temporary agent communication (NOT git tracked)
└── (Root docs: CLAUDE.md, AGENT_SWARM_FLOW.md, etc.)
```

### Folder Rules (Managed by Swarm Team Agent)

#### src/
**Purpose**: Actual development code (EG-DESK custom implementations)
- **Required files**: `CODEBASE_STRUCTURE.md` (services/keybindings registry)
- **Allowed types**: `.ts`, `.tsx`, `.js`, `.jsx` (source code only)
- **Git tracked**: Yes
- **Validation**: No markdown documentation files (use `docs/` instead)

#### docs/
**Purpose**: External public documentation (whitepapers, design docs)
- **Target audience**: External stakeholders, contributors
- **Allowed types**: `.md`, `.pdf` (documentation only)
- **Examples**: `EG-DESK_Whitepaper.md`, `EG-DESK_백서_한글.md`
- **Git tracked**: Yes
- **Validation**: No code files (`.ts`, `.tsx`, `.js`)

#### ideas/
**Purpose**: Feature ideation and planning
- **Structure**:
  - `brainstorming/`: Deferred or exploratory ideas
  - `confirmed/`: Approved PRDs ready for implementation
- **Content**: Markdown files with structured headers
- **Git tracked**: Yes
- **Validation**: PRD files must have required sections (Summary, Problem Statement, Proposed Solution)

#### references/
**Purpose**: External reference materials (cloned projects, research notes)
- **Structure per project**:
  - `[project]/online_references.md` ← User research notes (**required**, git tracked)
  - `[project]/[project]/` ← git clone shallow (optional, **NOT** git tracked)
- **Setup**: Run `bash setup.sh` to clone external repositories
- **Git tracked**: Only `online_references.md` files (cloned repos excluded via `.gitignore`)
- **Validation**:
  - `online_references.md` must have `# [Project] References` header
  - If `[project]/` subfolder exists, `setup.sh` must have corresponding clone command

#### .claude/
**Purpose**: AI Agent Swarm System (agent definitions, commands, prompts)
- **Structure**:
  - `agents/`: Agent definition files (`.md` with YAML frontmatter)
  - `commands/`: Slash command implementations
  - `prompts/`: Reusable prompt templates
- **Git tracked**: Yes
- **Validation**: Agent files must have valid YAML frontmatter

#### subagent_reports/
**Purpose**: Temporary agent-to-agent communication (file-based reporting)
- **Content**: Agent work reports (created during tasks, deleted after completion)
- **Git tracked**: No (temporary workspace, excluded via `.gitignore`)
- **Lifecycle**: Created by agents → Read by Main Thread → Deleted when task complete

## Technology Stack (Planned)

- **Desktop Framework**: Electron
- **Canvas System**: Custom infinite canvas implementation
- **Window Management**: Electron BaseWindow + WebContents
- **Code Editor Integration**: Eclipse Theia (embeddable)
- **AI Integration**: Multiple LLM providers
- **Build System**: TBD (researching electron-vite, webpack)
- **UI Framework**: TBD (researching Svelte, React)

## Development Phases

### Phase 0: Research (Current)
- Architecture design
- Technology evaluation
- Reference material collection
- AI agent system setup

### Phase 1: Core Implementation (Planned)
- Infinite Canvas system
- Window management
- Browser control layer

### Phase 2: Tool Integration (Planned)
- Theia code editor integration
- Native tool development
- AI agent integration

### Phase 3: Advanced Features (Planned)
- AI-generated web app hosting
- Workflow automation
- Advanced canvas features

## AI Agent Swarm

This project uses a sophisticated AI agent system for development:
- **PM Agent**: Strategic planning and architecture decisions
- **Framework Analyzers**: Theia and Electron expertise
- **Coding Agents**: Implementation execution
- **UX Simulator**: Flow validation and error detection

See `AGENTS.md` and `AGENT_SWARM_FLOW.md` for details.

## Getting Started

### 1. Clone the Repository

```bash
git clone https://github.com/QUUS-TheSmallCodeTeam/EG-Desk-Dev-Space.git
cd EG-Desk-Dev-Space
```

### 2. Setup External References

Run the setup script to download external reference code (Theia, Playwright, Puppeteer, etc.):

```bash
# Linux/Mac
./setup.sh

# Windows
setup.bat
```

This will download ~186MB of external reference materials:
- Theia framework (~54MB)
- Playwright testing library (~100MB)
- Puppeteer automation (~20MB)
- Google Gemini CLI (~10MB)
- Infinite Canvas library (~2MB)

### 3. Explore the Codebase

**Note**: Implementation has not yet begun. This repository currently contains:
- Architecture planning documents
- Reference materials (external projects cloned via setup script)
- AI agent system configuration
- Research and analysis

## Contributing

This project is in early research phase. Contributions will be welcomed once implementation begins.

## License

TBD

## Contact

Project maintained by Taehwa Team

---

**Repository Created**: 2024-10-24
**Last Updated**: 2025-10-25
