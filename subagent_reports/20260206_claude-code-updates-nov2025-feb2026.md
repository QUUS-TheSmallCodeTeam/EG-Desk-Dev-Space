# Claude Code Updates Analysis (Nov 2025 - Feb 2026)

**Agent**: claude-code-guide (team research) | **Created**: 2026-01-22 | **Updated**: 2026-02-06

## Task

2025년 11월 이후 Claude Code의 모든 업데이트 내용을 조사하여 EG-DESK 개발에 활용 가능한 인사이트를 제공합니다.

## Summary (Concise)

Claude Code는 11월부터 2월까지 대규모 업데이트를 출시했으며, 핵심 변경사항:
- **Claude Opus 4.6** (2/5) - 새 플래그십 모델, 1M 컨텍스트, adaptive thinking, SWE-bench 81.42%
- **Agent Teams** (v2.1.32, 2/5) - 다중 에이전트 협업 시스템 (research preview)
- **Auto Memory** (v2.1.32) - 자동 메모리 저장/로드
- **MCP Apps** (1/26) - 인터랙티브 UI 컴포넌트
- **Structured Outputs GA** (1/29) - 베타 종료, 정식 출시
- Agent SDK 성숙화, MCP 동적 tool loading, Chrome 브라우저 자동화 안정화, Hooks 확장

---

## Findings (Fully Detailed)

### EXECUTIVE SUMMARY

Claude Code shipped **176 updates in 2025** with accelerated development pace from November onwards, and continued rapid iteration into February 2026 (v2.1.20~v2.1.33). Key developments include:

- **Claude Opus 4.6** (Feb 5) - New flagship model with 1M context, adaptive thinking
- **Agent Teams** (Feb 5, research preview) - Multi-agent collaboration with TeamCreate, SendMessage, shared task lists
- **Auto Memory** (Feb 5) - Persistent memory system across sessions
- **MCP Apps** (Jan 26) - Interactive UI components in MCP tools
- **Structured Outputs GA** (Jan 29) - No more beta header needed
- **Version 2.0+** released with major UI/UX consolidation
- **Agent SDK** maturation with expanded subagent capabilities
- **Browser automation** (Chrome integration) entering beta/stable
- **MCP (Model Context Protocol)** deep integration with dynamic tool loading
- **Hooks system** expanded with new lifecycle events including TeammateIdle, TaskCompleted
- **IDE integrations** strengthened across VS Code, JetBrains, and Cursor

---

### 1. CLAUDE CODE VERSION UPDATES & MAJOR FEATURES

#### Version 2.1.0+ (January 2026)

**Release Date**: January 7, 2026

**Major Changes**:
- **Merged slash commands and skills** - Unified mental model combining `/commands` and skills into single `.claude/skills/` directory
  - Both `.claude/commands/review.md` and `.claude/skills/review/SKILL.md` now create `/review` command
  - No behavioral changes, purely structural consolidation
  - Existing commands and skills continue to work

- **Release channel toggle** - Users can now select between `stable` or `latest` versions via `/config`

- **Permission warnings** - Improved detection of unreachable permission rules with warnings in `/doctor` output

- **Plan persistence fix** - Fixed issue where plan files persisted across `/clear` commands

- **Subagent model correction** - Fixed incorrect model usage in subagent execution

- **Task count improvements** - Enhanced accuracy of background task counting

**Follow-up releases** (v2.1.1-v2.1.9):
- 109+ CLI refinements shipped immediately after 2.1.0
- Version 2.1.9 represents stable baseline for January 2026

#### Version 2.1.20-2.1.33 (January 26 - February 6, 2026) -- NEW

| Version | Date | Highlights |
|---------|------|------------|
| v2.1.20 | Jan 26 | TaskUpdate `status="deleted"`, arrow key vim nav, PR review status indicators |
| v2.1.21 | Jan 27-28 | TaskCreate new fields (`category`, `checklist`, `parentId`), Japanese IME support |
| v2.1.22 | Jan 28 | Fixed structured outputs for non-interactive (-p) mode, Task UI virtualization |
| v2.1.23 | Jan 29 | Customizable `spinnerVerbs` setting, mTLS/proxy fixes |
| v2.1.25 | Jan 29 | Fixed beta header validation for Bedrock/Vertex gateway users |
| v2.1.27 | Jan 30 | `--from-pr` flag, PR auto-linking, Claude in Chrome integration (VSCode) |
| v2.1.29 | Jan 31 | Fixed startup performance for sessions with `saved_hook_context` |
| v2.1.30 | Feb 3 | PDF `pages` parameter, OAuth client credentials for MCP, `/debug` command |
| v2.1.31 | Feb 4 | Session resume hints, PDF lockup fix, improved system prompts |
| v2.1.32 | Feb 5 | **Claude Opus 4.6**, **Agent Teams** (experimental), **Auto Memory**, partial summarization |
| v2.1.33 | Feb 6 | `TeammateIdle`/`TaskCompleted` hooks, agent `memory` frontmatter, tmux teammate fixes |

**v2.1.32 Major Features**:

1. **Agent Teams (Research Preview)**: Multi-agent collaboration system
   - Enable: `CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1`
   - TeamCreate/SendMessage/TaskCreate for coordinated work
   - Shared task list with dependency tracking (blocks/blockedBy)
   - Display modes: in-process (Shift+Up/Down) or split-pane (tmux/iTerm2)
   - Delegate mode (Shift+Tab): restrict lead to coordination-only tools
   - Plan approval workflow for teammates
   - See **Section 15** for full details

2. **Auto Memory System**: Persistent learning across sessions
   - Memory directory at `~/.claude/projects/[project]/memory/`
   - `MEMORY.md` loaded into system prompt (first 200 lines)
   - Separate topic files for detailed notes
   - Records insights, strategies, lessons learned

3. **Claude Opus 4.6**: New flagship model (see **Section 8**)

**v2.1.33 Key Additions**:
- `TeammateIdle` hook event: fires when teammate becomes idle
- `TaskCompleted` hook event: fires when task completes
- Agent `memory` frontmatter: persistent memory with scopes (user/project/local)
- Sub-agent spawning restrictions via `Task(agent_type)` in tools frontmatter
- VSCode: Remote session support, git branch in session picker

**v2.1.30 Notable Features**:
- PDF `pages` parameter: Read specific page ranges (e.g., `pages: "1-5"`)
- `/debug` command: Troubleshoot current session
- OAuth client credentials: `--client-id` and `--client-secret` with `claude mcp add`
- Task tool metrics: token count, tool uses, duration

**v2.1.27 Notable Features**:
- `--from-pr` flag: Resume sessions linked to specific GitHub PR
- Sessions auto-linked to PRs when created via `gh pr create`
- VSCode: Claude in Chrome integration enabled

#### Version 2.0.x Highlights (November-December 2025)

**Enhanced External CLAUDE.md Imports**:
- Approval dialog now shows which files are being imported and their source paths
- Improved transparency for project memory configuration

**Task Management**:
- `/tasks` dialog now navigates directly to task details when single background task running
- Better UX for managing parallel work

**Environment Configuration**:
- `CLAUDE_CODE_TMPDIR` - Override internal temp directory location
- `CLAUDE_CODE_DISABLE_BACKGROUND_TASKS` - Disable all background task functionality (set to `1`)

**Windows Support**:
- Windows Package Manager (winget) installation support added
- Native Windows installation improved

**UI/UX Improvements**:
- **Shift+Tab** keyboard shortcut in plan mode
- Source path metadata added to dragged images
- Clickable hyperlinks for file paths in tool output
- Improved terminal rendering on various platforms

---

### 2. CLAUDE AGENT SDK UPDATES

#### Official Rename & Maturation
- **claude-code-sdk** → **claude-agent-sdk** (PyPI package renamed)
- Old package deprecated; users must migrate to new `claude-agent-sdk`

#### Subagent Capabilities Expanded

**Parallel Execution**:
- Multiple subagents can now work simultaneously with isolated context windows
- Only relevant data returned to orchestrator (main thread)
- Example: `subagent_spawning_live.exs` demonstrates parallel orchestration

**Subagent Lifecycle Hooks** (6 supported hooks added):
1. `PreToolUse` - Runs before tool invocation
2. `PostToolUse` - Runs after tool completes
3. `UserPromptSubmit` - Handles user input submission
4. `Stop` - Subagent completion
5. `SubagentStop` - Main thread tracking of subagent completion
6. `PreCompact` - Context compaction lifecycle

**Tool Access Control**:
- Fine-grained permission modes for subagents: `default`, `acceptEdits`, `dontAsk`, `bypassPermissions`, `plan`
- `tools` field (allowlist) and `disallowedTools` field (denylist)

**Model Selection**:
- Subagents can use different models: `sonnet`, `opus`, `haiku`, or `inherit`
- Cost optimization by routing to Haiku for high-volume tasks

**Context Management**:
- Auto-compaction at ~95% capacity (configurable via `CLAUDE_AUTOCOMPACT_PCT_OVERRIDE`)
- Independent subagent transcript persistence
- Transcripts survive main conversation compaction
- 30-day cleanup cycle (configurable)

**Built-in Subagents**:
- **Explore** (Haiku, read-only) - Fast codebase exploration
- **Plan** (inherited model, read-only) - Planning phase research
- **general-purpose** (inherited model, all tools) - Complex multi-step tasks
- **Bash**, **statusline-setup**, **Claude Code Guide** - Specialized helper agents

#### SDK Code Samples

**Subagent Creation via CLI**:
```bash
claude --agents '{
  "code-reviewer": {
    "description": "Expert code reviewer. Use proactively after code changes.",
    "prompt": "You are a senior code reviewer...",
    "tools": ["Read", "Grep", "Glob", "Bash"],
    "model": "sonnet"
  }
}'
```

**Parallel Research Pattern**:
```
Use the code-reviewer to find quality issues,
then use the optimizer to fix them,
running both in parallel
```

---

### 3. MCP (MODEL CONTEXT PROTOCOL) INTEGRATION

#### Dynamic Tool Loading

**Tool Search Feature** (November 2024, refined through 2025):
- Automatically enables when MCP tool descriptions exceed 10% of context window
- Tools load on-demand instead of preloading all
- Significantly reduces context consumption

**Configuration Scopes**:
- **Local scope**: Project `.mcp.json`
- **Project scope**: `.mcp.json` in project root
- **User scope**: `~/.claude/.mcp.json`
- **Hierarchy**: Session flags > Project > User scope

#### MCP Apps (January 26, 2026) -- NEW

**First-ever official MCP extension** enabling interactive UI components:
- Tools can return dashboards, forms, visualizations, multi-step workflows
- Renders directly in conversation
- Supported by: Claude, ChatGPT, Goose, VS Code
- Security: iframe sandboxing, pre-declared templates, auditable messages, user consent
- Built on MCP-UI and OpenAI Apps SDK as shared open standard
- Production-ready

#### MCP Tool Search Optimization -- NEW

- Dynamically loads tools on-demand instead of preloading all
- **46.9% reduction** in total agent tokens (51K down to 8.5K)

#### MCP Resources & References

**Resource Access**:
- Type `@` in prompt to see available MCP resources
- Resources appear alongside file autocomplete
- Similar to file and directory references

**MCP Prompts as Commands**:
- MCP servers expose prompts as `/mcp__servername__promptname` commands
- Type `/` to discover all available commands
- Seamless integration with Claude Code command system

#### Output Management

**Token Limits**:
- Warning triggers at 10,000 tokens for single MCP tool output
- Configurable via `MAX_MCP_OUTPUT_TOKENS` environment variable
- Default maximum: 25,000 tokens

**Popular MCP Servers**:
- Sentry (error monitoring)
- GitHub (code reviews, PR management)
- PostgreSQL (database queries)
- Custom business systems via HTTP/SSE/stdio

#### Configuration Example

```json
{
  "mcp": {
    "servers": [
      {
        "name": "postgres",
        "type": "stdio",
        "command": "python3",
        "args": ["-m", "mcp_server_postgres"],
        "env": {
          "DATABASE_URL": "postgresql://..."
        }
      },
      {
        "name": "github",
        "type": "sse",
        "url": "https://github-mcp.example.com/sse"
      }
    ]
  }
}
```

---

### 4. HOOKS SYSTEM ENHANCEMENTS

#### New Hook Events (2026 Updates)

**Expanded Hook Support**:

1. **PreToolUse** (v2.0.10+)
   - Can now return `additionalContext` to model
   - Enables transparent sandboxing
   - Automatic security enforcement (dry-run flags, secret redaction)
   - Tool input modification support
   - Hook execution timeout: **60 seconds → 10 minutes** (January 2026)

2. **PostToolUse**
   - Runs after tool completes successfully
   - Common use: automatic code formatting, linting, test runs

3. **PermissionRequest**
   - Intercepts permission dialogs
   - Can auto-allow or auto-deny operations
   - Reduces permission friction

4. **UserPromptSubmit**
   - Validates/modifies user input before processing
   - Can inject dynamic context
   - Useful for prompt enrichment

5. **Stop** / **SubagentStop**
   - Stop: Main agent completion
   - SubagentStop: Subagent completion tracking
   - Cleanup operations

6. **SessionStart** / **SessionEnd**
   - Environment variable persistence capability
   - Lifecycle hooks for session management

7. **TeammateIdle** (v2.1.33) -- NEW
   - Fires when an agent teammate becomes idle
   - For multi-agent workflow automation

8. **TaskCompleted** (v2.1.33) -- NEW
   - Fires when a task completes
   - For multi-agent workflow orchestration

#### Practical Hook Examples

**Code Formatting with PostToolUse**:
```yaml
hooks:
  PostToolUse:
    - matcher: "Edit|Write"
      hooks:
        - type: command
          command: "prettier --write $EDITED_FILE"
```

**Read-Only Database Access with PreToolUse**:
```yaml
hooks:
  PreToolUse:
    - matcher: "Bash"
      hooks:
        - type: command
          command: "./scripts/validate-readonly-query.sh"
```

**Subagent Lifecycle Hooks**:
```yaml
---
name: db-agent
description: Database operations
hooks:
  PreToolUse:
    - matcher: "Bash"
      hooks:
        - type: command
          command: "./scripts/validate-command.sh"
---
```

---

### 5. BROWSER AUTOMATION & CHROME INTEGRATION

#### Chrome Integration Status

**Release Timeline**:
- October 2025: Beta announcement
- December 2025: "AI that actually does things" focus
- January 2026: Stable with refinements

**Key Capabilities**:
- Page navigation and DOM interaction
- Click and type automation
- Form filling and submission
- Multi-tab management
- Console log and network request reading
- Window resizing and scrolling
- GIF recording for demo/documentation

**Setup Process**:
```bash
# 1. Update Claude Code
claude update

# 2. Install Chrome extension (from Chrome Web Store)

# 3. Start Claude Code with Chrome
claude --chrome
```

**Supported Browsers**:
- ✅ Google Chrome
- ✅ Chromium (experimental)
- ❌ Brave, Arc, other Chromium variants (not yet)
- ❌ WSL (Windows Subsystem for Linux)

**Example Workflows**:
1. **Test local web application** - Automated testing with console debugging
2. **Debug with console logs** - Real-time debugging integration
3. **Automate form filling** - Data entry automation
4. **Draft content in Google Docs** - Collaborative document creation
5. **Extract data from web pages** - Web scraping and data collection
6. **Multi-site workflows** - Complex browser interactions across multiple domains

**Technical Details**:
- Uses Chrome's Native Messaging API
- Extension receives commands from Claude Code CLI
- Real-time feedback loop for iterative development

---

### 6. SKILLS & SLASH COMMANDS CONSOLIDATION

#### Unified Skills/Commands System (v2.1.0)

**Before**: Separate `/commands` and Skills systems
**After**: Single unified `.claude/skills/` directory

**File Locations**:
```
.claude/skills/
├── review/
│   ├── SKILL.md          # Creates /review command
│   ├── script.sh
│   └── context.md
├── refactor/
│   └── SKILL.md          # Creates /refactor command
└── analyze/
    └── SKILL.md          # Creates /analyze command
```

**No Behavioral Changes**:
- All existing commands and skills work identically
- Triggers remain the same
- Tool access unchanged
- Just structural consolidation for cleaner mental model

**CLAUDE.md Integration**:
- Skills can be defined in `CLAUDE.md` with frontmatter
- Supported fields:
  - `name` (required)
  - `description` (required)
  - `tools` (optional - allowlist)
  - `disallowedTools` (optional - denylist)
  - `model` (optional - `sonnet`, `opus`, `haiku`, `inherit`)
  - `context` - Define scope (main conversation vs subagent)

**Frontmatter Example**:
```markdown
---
name: api-reviewer
description: Review API implementations for standards compliance
tools: Read, Grep, Bash
model: sonnet
---

You are an API design expert...
```

**Dynamic Context Injection**:
- String substitutions available: `${CLAUDE_WORKING_DIR}`, `${CLAUDE_PROJECT_NAME}`, `${CLAUDE_SESSION_ID}` (new Jan 2026)
- Enables skills to adapt to runtime environment

---

### 7. IDE INTEGRATIONS

#### VS Code Extension

**Status**: Recommended way to use Claude Code in VS Code

**Installation**:
- Search "Claude Code" in Extensions view
- Works in VS Code, Cursor, and Cursor-based IDEs

**Features**:
- Native graphical extension panel
- Inline code edits with preview
- IDE-style diff review
- Session persistence and resumption
- Git integration (commit/PR creation)
- File and folder references

**Configuration**:
- Extension Settings in VS Code preferences
- Model selection
- Permission modes
- Hook configuration support

#### JetBrains Plugin

**Status**: Beta (actively developed)

**Installation**:
- JetBrains Marketplace: Search "Claude Code"
- Requires Claude Code CLI installed separately
- Supports: IntelliJ IDEA, PyCharm, WebStorm, etc.

**How It Works**:
- Orchestrates Claude Code CLI from IDE terminal
- Displays proposed changes in IDE diff viewer
- Supports all CLI flags and features

**Configuration**:
- Plugin Settings > Claude Code
- General Settings (model, permissions)
- ESC key configuration for integration
- Remote Development support
- WSL Configuration support

#### Remote Development Support

**JetBrains Remote Development**:
- SSH connections to remote IDEs
- Proper path resolution for local vs remote execution

**Windows Subsystem for Linux (WSL)**:
- WSL2 configuration support
- Networking mode considerations for IDE detection

---

### 8. CLAUDE API & MODEL UPDATES (Supporting Infrastructure)

#### Claude Opus 4.6 Launch (February 5, 2026) -- NEW / MAJOR

**Model ID**: `claude-opus-4-6`
**Pricing**: $5/$25 per million tokens (input/output) -- same as Opus 4.5
**Long Context Premium**: $10/$37.50 for prompts exceeding 200K tokens
**Context Window**: 1M tokens (beta for Opus-class -- first time Opus gets 1M)
**Max Output**: 128K tokens
**Availability**: Claude API, AWS Bedrock, Google Vertex AI, Microsoft Foundry, GitHub Copilot

**Key Improvements over Opus 4.5**:
- Plans more carefully, sustains agentic tasks longer
- Operates more reliably in larger codebases
- Better code review and debugging (catches its own mistakes)
- GDPval-AA: Outperforms GPT-5.2 by ~144 Elo, beats Opus 4.5 by 190 Elo
- Terminal-Bench 2.0: Highest agentic coding score
- SWE-bench Verified: 81.42%
- MRCR v2 (8-needle, 1M): 76% accuracy vs Sonnet 4.5's 18.5%

**Important API Changes**:
- Recommends adaptive thinking (`thinking: {type: "adaptive"}`)
- Manual thinking (`type: "enabled"` with `budget_tokens`) is DEPRECATED
- Does NOT support prefilling assistant messages

**New API Features with Opus 4.6**:
- **Adaptive Thinking**: Model autonomously determines when extended thinking helps
- **Effort Parameter GA**: No beta header required, four levels (low/medium/high/max)
- **Compaction API (Beta)**: Server-side context summarization for infinite conversations
- **Data Residency Controls**: `inference_geo` parameter for US-only inference (1.1x pricing)
- **Fine-grained Tool Streaming GA**: No beta header required

#### Structured Outputs -- Now GA (January 29, 2026) -- NEW

- Available for Sonnet 4.5, Opus 4.5, Haiku 4.5
- No beta header required
- `output_format` parameter moved to `output_config.format`
- Still in public beta on Amazon Bedrock and Microsoft Foundry

#### Claude Opus 4.5 Launch (November 24, 2025)

**Status**: Most intelligent model combining maximum capability with practical performance

**Key Features**:
- Step-change improvements in vision, coding, computer use
- More accessible pricing than previous Opus models
- Ideal for complex specialized tasks, professional software engineering, advanced agents

**Extended Context**:
- 1M token context window available
- Prompt caching support (5-minute and 1-hour)
- Better performance for long-context tasks

#### Claude Sonnet 4.5 (September 29, 2025)

**Status**: Best model for complex agents and coding

**Features**:
- Highest intelligence across most tasks
- Strong coding capabilities
- Agent coordination excellence

#### Claude Haiku 4.5 (October 15, 2025)

**Status**: Fastest and most intelligent Haiku model

**Use Cases**:
- Real-time applications requiring low latency
- High-volume processing
- Cost-sensitive deployments

**Features**:
- Near-frontier performance
- Strong reasoning capabilities
- Structured outputs support (December 2025)

#### Advanced Claude API Features

**Structured Outputs** (November 14, 2025)
- Guaranteed schema conformance
- JSON outputs with validation
- Strict tool use with validated inputs
- Available for Claude Sonnet 4.5 and Opus 4.1
- Beta header: `structured-outputs-2025-11-13`

**Programmatic Tool Calling** (November 24, 2025)
- Claude calls tools from within code execution
- Reduces latency and token usage in multi-tool workflows
- Public beta available

**Tool Search Tool** (November 24, 2025)
- Dynamic tool discovery from large catalogs
- Enables on-demand tool loading
- Reduces tool description overhead

**Effort Parameter** (November 24, 2025)
- Trade-off between response thoroughness and efficiency
- Token usage control for Claude Opus 4.5
- Public beta

**Files API** (May 22, 2025 → Refined through 2025)
- Upload and reference files in Messages API
- PDF support with text and visual analysis
- Long-context use case optimization

**Code Execution Tool v2** (September 2, 2025)
- Replaces Python-only original tool
- Bash command execution
- Direct file manipulation capabilities
- Write code in multiple languages

**Web Fetch Tool** (September 10, 2025)
- Retrieve full content from specified web pages
- PDF document support
- Full document analysis in one call

**Web Search Tool** (May 7, 2025 → Mature)
- Access up-to-date information from web
- Natural citations for RAG applications
- Search result content blocks with source attribution

---

### 9. BREAKING CHANGES & DEPRECATIONS

#### Model Deprecations

**January 5, 2026**:
- ❌ Claude Opus 3 (`claude-3-opus-20240229`) - Retired
- Recommendations: Upgrade to Claude Opus 4.5 (1/3 the cost with better intelligence)

**December 19, 2025**:
- ⚠️ Claude Haiku 3.5 - Deprecation announced

**October 28, 2025**:
- ❌ Claude Sonnet 3.5 models (`claude-3-5-sonnet-20240620`, `claude-3-5-sonnet-20241022`) - Retired
- Recommendation: Migrate to Claude Sonnet 4.5

**July 21, 2025**:
- ❌ Claude 2.0, 2.1, Sonnet 3 - Retired

#### API Changes

**Cache Control Placement** (May 1, 2025):
- Must be specified in parent `content` block of `tool_result` and `document.source`
- Breaking change for manual cache control specification

**Top-P Default Change** (May 22, 2025):
- Changed from `0.999` to `0.99` for all models
- Improves answer quality and reduces tool errors
- Revert by explicitly setting `top_p: 0.999`

**Tool Use Parameter** (February 27, 2025):
- `tool_choice: "none"` now prevents Claude from calling any tools
- Tools no longer required when using `tool_result` blocks

#### Hook Timeout Change (January 2026)

**Hook Execution Timeout**:
- **Before**: 60 seconds
- **After**: 10 minutes
- Allows longer-running validation scripts

---

### 10. INFRASTRUCTURE & DEPLOYMENT UPDATES

#### Documentation Platform Consolidation

**November 19, 2025**:
- New platform at `platform.claude.com/docs`
- Unified developer experience (docs + console colocated)
- `docs.claude.com` redirects to new location

**January 12, 2026**:
- `console.anthropic.com` → `platform.claude.com`
- Full brand consolidation to "Claude"
- Automatic redirect until January 12, 2026

#### Microsoft Foundry Integration

**November 18, 2025**:
- Claude models now available in Azure
- Azure billing and OAuth authentication
- Full Messages API access including extended thinking
- Prompt caching, PDF support, Files API, Agent Skills, tool use

#### Amazon Bedrock Updates

**Search Results** (November 21, 2025):
- Now generally available on Amazon Bedrock
- Proper source attribution for RAG applications

#### Google Vertex AI Support

**1M Token Context** (August 26, 2025):
- Now available on Google Cloud Vertex AI
- Matches Claude API capabilities

#### Network Configuration

**Proxy Support**:
- Custom CA certificates
- mTLS authentication
- Environment variable configuration
- Basic authentication support

---

### 11. COST TRACKING & MONITORING

#### Claude Code Analytics API (September 10, 2025)

**Capabilities**:
- Programmatic access to daily aggregated metrics
- Productivity metrics
- Tool usage statistics
- Cost data tracking

**Use Cases**:
- Organization-wide usage monitoring
- Team productivity measurement
- Cost allocation and reporting

#### Usage & Cost API (August 18, 2025)

**Features**:
- Monitor organization usage programmatically
- Retrieve detailed cost data
- API key usage tracking
- Workspace-level cost tracking

#### Cost Reduction Strategies

**Context Management**:
- Manage context proactively to reduce token usage
- Use subagents for verbose operations
- Offload processing to hooks and skills

**Model Selection**:
- Route to Haiku for high-volume tasks
- Use Sonnet 4.5 for complex coding
- Opus 4.5 for specialized reasoning

**Advanced Techniques**:
- Prompt caching (up to 90% cost reduction)
- Batch processing API (50% cost reduction)
- Extended thinking optimization
- MCP server overhead reduction

---

### 12. SECURITY & GOVERNANCE

#### Prompt Injection Protection

**Core Protections**:
- File-based isolation
- Permission-based architecture
- Input validation

**Enhanced Controls**:
- Managed MCP configuration
- Allowlists and denylists for MCP servers
- Tool-specific permission rules

#### Sandboxing

**Features** (Ongoing development):
- Filesystem isolation
- Network isolation
- OS-level enforcement
- Prompt injection prevention
- Reduced attack surface

#### Permission System

**Granular Control**:
- Permission modes: default, acceptEdits, dontAsk, bypassPermissions, plan
- Tool-specific restrictions with regex patterns
- Workspace-level managed settings

---

### 13. PERFORMANCE & OPTIMIZATION

#### Client-Side Compaction

**SDK Feature** (November 24, 2025):
- Python and TypeScript SDK support
- Automatic context management through summarization
- `tool_runner` integration

#### Prompt Caching Improvements

**January 15, 2025**:
- Automatic longest prefix reading
- Easier-to-use cache breakpoint API
- Up to 80% latency reduction
- Up to 90% cost reduction

**Extended Duration**:
- 1-hour cache duration now generally available
- Improved cache hit rates
- Minute and hour-level granularity tracking

---

### 14. TESTING & QUALITY ASSURANCE

#### Built-in Testing Features

**Console Workbench** (October 2024 → Refined):
- Automatic test case generation for prompts
- Side-by-side output comparison
- Prompt optimization assistance

#### CI/CD Integration

**GitHub Actions** (Mature in 2025):
- Claude Code GitHub Action available
- Automation for PR comments, issue handling
- Works with AWS Bedrock and Google Vertex AI

**GitLab CI/CD**:
- Same capabilities as GitHub Actions
- OIDC authentication support
- Workload Identity Federation

---

### 15. AGENT TEAMS (v2.1.32, Research Preview) -- NEW

#### Architecture

| Component | Role |
|-----------|------|
| **Team Lead** | Main session that creates team, spawns teammates, coordinates |
| **Teammates** | Separate Claude instances with independent context windows |
| **Task List** | Shared work items with dependency tracking |
| **Mailbox** | Inter-agent messaging system |

**File Structure**:
```
~/.claude/
├── teams/{team-name}/
│   ├── config.json              # Team config (members, colors, models)
│   └── inboxes/{agent}.json     # Per-agent message inbox
└── tasks/{team-name}/
    └── N.json                   # Individual task files
```

#### SendMessage Tool - 5 Message Types

1. `message` - Direct message to specific teammate
2. `broadcast` - Send to ALL teammates (expensive, use sparingly)
3. `shutdown_request` - Request teammate to exit
4. `shutdown_response` - Approve/reject shutdown
5. `plan_approval_response` - Approve/reject teammate's plan

#### Task Coordination

- `TaskCreate` / `TaskList` / `TaskGet` / `TaskUpdate`
- Status workflow: `pending → in_progress → completed` (or `deleted`)
- Dependencies: `addBlockedBy` / `addBlocks`
- File locking prevents race conditions on task claiming
- Teammates self-claim unassigned, unblocked tasks

#### Display Modes

- **In-process** (default): All in main terminal, Shift+Up/Down to navigate
- **Split-pane**: tmux or iTerm2, each teammate gets own pane
- **Delegate mode** (Shift+Tab): Restrict lead to coordination-only tools

#### Orchestration Patterns

1. **Parallel Specialists**: Multiple reviewers (security, performance, tests)
2. **Pipeline**: Sequential tasks with dependency blocking
3. **Swarm**: Self-organizing workers claiming available tasks
4. **Research + Implement**: Two-phase research then implementation
5. **Plan Approval**: Require leader validation before execution
6. **Competing Hypotheses**: Multiple teammates test different theories

#### Agent Teams vs Subagents

| Feature | Subagents | Agent Teams |
|---------|-----------|-------------|
| **Context** | Results return to caller | Fully independent |
| **Communication** | Report to main agent only | Teammates message each other |
| **Coordination** | Main agent manages all | Shared task list, self-coordination |
| **Best for** | Focused tasks | Complex collaborative work |
| **Token cost** | Lower (summarized) | Higher (separate instances) |

#### Agent Memory System (v2.1.33)

```yaml
---
name: code-reviewer
memory: user    # or "project" or "local"
---
```

| Scope | Location | Use When |
|-------|----------|----------|
| `user` | `~/.claude/agent-memory/<name>/` | Cross-project memory |
| `project` | `.claude/agent-memory/<name>/` | Project-specific, VCS shareable |
| `local` | `.claude/agent-memory-local/<name>/` | Project-specific, NOT for VCS |

#### Known Limitations

1. No session resumption for in-process teammates
2. Task status can lag (teammates forget to mark complete)
3. One team per session, no nested teams
4. Fixed leadership (cannot transfer)
5. Split panes require tmux/iTerm2
6. Crashed teammates auto-timeout after 5 minutes

---

### Important Considerations

**EG-DESK 활용 시사점**:

1. **Agent SDK 패턴 참고**:
   - Claude Code의 parallel subagent 패턴은 Theia의 ContributionProvider 패턴과 유사
   - Tool allowlist/denylist는 Theia의 ToolProvider 구조에 적용 가능

2. **MCP 동적 tool loading**:
   - Theia에서도 tool 수가 많을 때 context 낭비 문제 존재
   - Dynamic loading 패턴 참고 가능
   - 현재 Theia는 모든 tool을 LLM에 전달 (agentic search)

3. **Hooks 시스템**:
   - Claude Code의 10분 timeout은 validation script 실행 가능
   - Theia에도 lifecycle hook 구현 시 참고

4. **Chrome 자동화**:
   - Theia에서 Puppeteer/CDP 통합 시 Native Messaging API 패턴 참고
   - GIF 녹화 기능은 EG-DESK 데모/문서화에 유용

5. **Model routing**:
   - Haiku for volume, Sonnet for complex, Opus for specialized
   - Theia LanguageModelRegistry에서 purpose별 모델 선택 패턴과 유사

6. **Agent Teams 패턴 참고** (NEW):
   - Multi-agent 협업 시스템의 Task 조율 패턴
   - Shared task list + dependency tracking → EG-DESK 미니앱 오케스트레이션에 적용 가능
   - SendMessage/broadcast 패턴 → IPC 메시징 설계 참고
   - Delegate mode → 역할 분리 패턴

7. **MCP Apps** (NEW):
   - 인터랙티브 UI 컴포넌트를 MCP 도구에서 반환
   - EG-DESK에서 AI 도구 결과를 시각적으로 렌더링하는 데 참고
   - iframe sandboxing 보안 모델 참고

8. **Auto Memory 시스템** (NEW):
   - 세션 간 학습 지속성
   - 프로젝트별/유저별 메모리 스코프
   - EG-DESK AI 에이전트의 사용자 선호도 학습에 적용 가능

9. **Compaction API** (NEW):
   - 서버사이드 컨텍스트 요약으로 무한 대화 가능
   - 장시간 실행되는 AI 작업에 적용 가능

---

## Recommendation (Actionable)

### For EG-DESK Implementation

1. **MCP 패턴 참고**:
   - Theia의 ToolInvocationRegistry에 dynamic loading 추가
   - Tool description 기반 필터링 구현
   - Context window 최적화

2. **Prompt 내 Function Reference 활용**:
   - Theia처럼 `~{functionId}` 프롬프트 내 참조 방식 사용
   - Agent별로 필요한 tool만 프롬프트에 명시
   - Universal agent에 tool 추가 시 프롬프트 수정 필요

3. **Chrome 자동화 통합**:
   - Native Messaging API 패턴 연구
   - Electron IPC와 통합 방안 검토
   - GIF 녹화 기능 참고

4. **Lifecycle Hooks 설계**:
   - Theia FrontendApplicationContribution 패턴과 통합
   - PreToolUse/PostToolUse hook 구현
   - 10분 timeout 참고

5. **Cost 최적화**:
   - Model routing 전략 수립
   - Prompt caching 활용
   - Subagent context 격리

---

## References for Main Thread

**Claude Code Features**:
- Version 2.1.32+ - Agent Teams, Auto Memory, Opus 4.6
- Version 2.1.0+ - Commands/Skills 통합, Hook timeout 10분
- Agent SDK - Parallel execution, 8+ lifecycle hooks, model routing
- MCP - Dynamic tool loading, MCP Apps (interactive UI), resource references
- Chrome - Stable automation, Native Messaging API
- API - Opus 4.6, Adaptive Thinking, Structured Outputs GA, Compaction API

**EG-DESK 적용 가능 패턴**:
- Dynamic tool loading → Theia ToolInvocationRegistry 최적화
- Agent Teams → Multi-agent orchestration, shared task coordination
- MCP Apps → Interactive UI components in AI tool results
- Auto Memory → Cross-session user preference learning
- Compaction API → Infinite conversation for long-running tasks
- Prompt-based function reference (`~{functionId}`) → Theia 기존 패턴 활용
- Lifecycle hooks → Theia ContributionProvider 통합
- Browser automation → Electron + Puppeteer/CDP 설계 참고
- Model routing → LanguageModelRegistry purpose 확장

**Documentation Links**:
- [Claude Code Agent Teams](https://code.claude.com/docs/en/agent-teams)
- [Claude Code Subagents](https://code.claude.com/docs/en/sub-agents)
- [MCP Integration](https://code.claude.com/docs/en/mcp)
- [Hooks Guide](https://code.claude.com/docs/en/hooks-guide)
- [Chrome Integration](https://code.claude.com/docs/en/chrome)
- [Agent Skills API](https://platform.claude.com/docs/en/agents-and-tools/agent-skills/overview)
- [Claude Opus 4.6 Announcement](https://www.anthropic.com/news/claude-opus-4-6)
- [Claude Code Changelog](https://github.com/anthropics/claude-code/blob/main/CHANGELOG.md)

---

<!-- MT (2026-02-06): 2026-02-06 Team agent 리서치로 업데이트 완료. Opus 4.6, Agent Teams, Auto Memory, MCP Apps 추가. -->
