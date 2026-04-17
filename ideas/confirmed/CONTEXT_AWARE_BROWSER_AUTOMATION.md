# Context-Aware Browser Automation

> ## 🟡 UPDATED for Firefox Shell (2026-04-17, ADR-007)
>
> **개념 (Website Roadmap, 사전 정의 컨텍스트, 80-20 문제 해결) 은 유효**. 구현 경로만 Firefox chrome JS 로 교체.
>
> **변경 매핑**:
> - ~~CDP / Playwright wrapper~~ → **chrome JS 의 `gBrowser`, `browsingContext`, JSActor, `nsIWebProgressListener` 직접 사용**
> - ~~Electron `webContents.executeJavaScript`~~ → **JSActor `sendQuery` / `sendAsyncMessage` 패턴**
> - ~~Electron IPC 브릿지~~ → **chrome JS 가 이미 privileged context 라서 IPC 최소화**
> - **Roadmap 정의 포맷, agent 로직, Phase 1~N 목표 구조는 그대로 유지**
>
> 각 구현 섹션의 "CDP", "Playwright", "webContents" 레퍼런스는 Firefox 등가물로 읽어야 함. 세부 패턴은 [`ideas/brainstorming/FIREFOX_CHROME_JS_PATTERNS.md`](../brainstorming/FIREFOX_CHROME_JS_PATTERNS.md) (작성 예정) 참조.
>
> **승계 문서**:
> - [`FIREFOX_SHELL_STRATEGY.md`](FIREFOX_SHELL_STRATEGY.md)
> - [`ADR-007`](../../.claude/docs/decisions/007-firefox-shell-over-electron.md)

---

## PRD Metadata

**Created**: 2026-01-23
**Status**: Approved (Phase 1 POC) — **구현 경로 update 2026-04-17 (ADR-007)**
**Author**: egdesk-pm-agent
**Related PRD**: ~~`UNIFIED_BROWSER_AUTOMATION_API.md`~~ (Superseded) → `FIREFOX_SHELL_STRATEGY.md`
**Consultation Report**: `subagent_reports/20260123_context-aware-chrome-automation-pm-consultation.md`

---

## Overview

Context-Aware Browser Automation enhances EG-DESK's browser automation capabilities by introducing **pre-defined website context (Website Roadmaps)** that enable the AI agent to execute tasks with prior knowledge of site structure, eliminating exploratory navigation overhead.

### The Problem

Current browser automation approaches (including Claude Code's native browser control) suffer from the "80-20 problem":
- 80% of execution time is spent on exploratory navigation (screenshot -> analyze -> decide -> act)
- Each action requires: Screenshot (~200-500ms) + Vision analysis (~1-3s) + Planning (~500ms-1s)
- Result: 2-5 seconds per step, compounded across complex workflows

### The Solution

Pre-defined Website Roadmaps provide AI with structural understanding before execution:
- Known paths execute via direct CDP actions (~50-100ms per action)
- Vision analysis reserved for verification/exceptions only
- **Improvement: 5-10x faster for known sites**

### Differentiation vs Claude Code

| Aspect | Claude Code | EG-DESK with Context |
|--------|-------------|----------------------|
| Knowledge | None (explores from scratch) | Pre-defined roadmap |
| Per-action latency | 2-5 seconds | 50-100ms (known paths) |
| Complete workflow | 2-5 minutes | 15-30 seconds |
| Fallback | N/A (always exploratory) | Native mode for unknown |

---

## Vision Alignment

This feature strongly aligns with core EG-DESK principles:

### 1. Observation Learning (Whitepaper Section 3)
> "한 번 하면 AI가 자동화로 변환"

Website Roadmaps are the **prerequisite enabler** for observation learning:
- Roadmap = structural understanding
- Observation = user's specific workflow
- Combined = contextual automation (not mechanical replay)

### 2. Oneshot Execution (Production Whitepaper)
> "일반 LLM으로는 여러 번의 시행착오가 필요한 작업이 EG-DESK에서는 첫 시도에 성공하는 oneshot execution"

Pre-defined context eliminates 80% exploratory overhead, enabling true oneshot execution.

### 3. Ontology System Expansion
Current Ontology stores task-specific patterns (login flow, auth flow). Website Roadmaps expand this to **site-wide structural understanding**.

### 4. Ambient AI Philosophy
> "보이지 않지만 항상 인식하고, 필요할 때만 나타나는 AI"

Pre-defined context = AI that already understands the environment without visible "learning" phase.

---

## Technical Approach

### Website Roadmap Schema

```yaml
# Website Roadmap Schema (v1)
site:
  domain: "example.go.kr"
  last_updated: "2026-01-23T10:00:00Z"
  version: 1

authentication:
  type: "공동인증서"  # or "ID/PW", "OAuth", etc.
  login_page: "/member/login.do"
  login_button: "#loginBtn"
  certificate_flow:
    - step: "click_cert_tab"
      selector: "#certLogin"
    - step: "select_certificate"
      description: "Native dialog appears"

navigation:
  main_menu:
    - name: "메뉴1"
      path: "/menu1/main.do"
      sub_items:
        - name: "서브메뉴"
          path: "/menu1/sub.do"

key_elements:
  - purpose: "검색"
    page: "/inquiry/search.do"
    elements:
      - id: "searchBtn"
        type: "button"
        action: "triggers_search"
      - id: "resultTable"
        type: "table"
        action: "contains_results"

known_issues:
  - description: "특정 시간대 서버 느림"
    workaround: "wait_extended"
  - description: "호환 모드 필요"
    workaround: "set_user_agent"
```

### Roadmap Generation Mechanisms

**Option A: Pre-analysis (Proactive)**
- Trigger: User adds website to workspace
- Process: Background crawler extracts structure
- Pros: Fast execution, no user wait
- Cons: May become stale

**Option B: On-demand (Reactive)**
- Trigger: First automation request for domain
- Process: Quick structural scan (5-10 seconds)
- Pros: Always fresh
- Cons: First-time delay

**Option C: Hybrid (Recommended)**
- Pre-analysis for known/frequent domains
- On-demand for new domains
- Background refresh for stale data (>30 days)

### Integration with Existing Architecture

Current (UNIFIED_BROWSER_AUTOMATION_API.md):
```
WebContentsView (Infinite Canvas)
    |
    v
CDP Bridge Service
    |
    v
Unified Playwright/Puppeteer API
    |
    v
AI Agent System
```

Enhanced with Context Layer:
```
WebContentsView (Infinite Canvas)
    |
    v
CDP Bridge Service
    |
    +--> [Context Layer] <-- NEW
    |         |
    |         v
    |    [Ontology: Website Roadmaps]
    |         |
    v         v
Unified Playwright/Puppeteer API
    |
    v
AI Agent System (now with context)
```

### Key Integration Points

1. **Context Injection into AI Prompts**
   - Before LLM call, load relevant roadmap
   - Include in system prompt: "You are operating on [site]. Structure: [roadmap excerpt]"

2. **Selector Resolution Enhancement**
   - Current: LLM generates selectors from vision
   - Enhanced: Roadmap provides known selectors, LLM uses/adapts them

3. **Handoff Protocol Enhancement**
   - When AI takes control, it knows site structure immediately
   - Reduces handoff latency significantly

### Implementation Details

#### HTML Parsing Strategy

**Core Principle**: Focus on **interactive elements only** (업무 중심)

People performing tasks only look at buttons/inputs, not informational text. The same applies to AI automation.

**Parsing Approach**:
```javascript
async function parseInteractiveElements(page) {
  await page.waitForLoadState('networkidle');

  const elements = await page.evaluate(() => {
    // 1. Select only interactive elements
    const interactive = document.querySelectorAll(
      'button, a, input, select, textarea, [role="button"], [onclick]'
    );

    // 2. Filter visible elements only
    return Array.from(interactive)
      .filter(el => {
        const rect = el.getBoundingClientRect();
        const style = window.getComputedStyle(el);
        return rect.width > 0 &&
               rect.height > 0 &&
               style.display !== 'none' &&
               style.visibility !== 'hidden';
      })
      // 3. Extract essential information only
      .map((el, idx) => ({
        id: `elem-${idx}`,
        type: el.tagName.toLowerCase(),
        text: el.textContent?.trim().slice(0, 50) ||
              el.placeholder ||
              el.value ||
              el.getAttribute('aria-label') ||
              '',
        selector: generateSelector(el)
      }));
  });

  return elements;
}
```

**What to Extract**:
- ✅ Buttons, links, inputs, selects, textareas
- ✅ Elements with `role="button"` or `onclick`
- ✅ Visible elements only (filter hidden/display:none)

**What to Exclude**:
- ❌ Text content (`<p>`, `<div>`, `<h1>` without interaction)
- ❌ Images (unless clickable)
- ❌ Informational elements
- ❌ Footer/copyright text

**Advantages**:
- Fast parsing (0.01s vs 0.5-1s for full DOM)
- Compact storage (5-20KB vs 100-500KB)
- Reduced LLM tokens (50-100 vs 1000+)
- Lower noise = higher accuracy

#### Roadmap JSON Format

**Parsed Output Structure**:
```json
{
  "domain": "hometax.go.kr",
  "url": "/main",
  "timestamp": "2026-01-23T15:30:00Z",
  "elements": [
    {
      "id": "elem-0",
      "type": "button",
      "text": "로그인",
      "selector": "#login-btn",
      "zone": "header"
    },
    {
      "id": "elem-1",
      "type": "link",
      "text": "세금신고",
      "selector": ".nav-item:nth-child(1)",
      "zone": "nav",
      "href": "/tax/report"
    },
    {
      "id": "elem-2",
      "type": "input",
      "text": "검색어를 입력하세요",
      "selector": "#search-input",
      "zone": "main",
      "placeholder": "검색어를 입력하세요"
    }
  ]
}
```

**Element Properties**:
- `id`: Unique identifier (elem-0, elem-1, ...)
- `type`: Element type (button, link, input, etc.)
- `text`: User-visible text or placeholder
- `selector`: CSS selector for execution
- `zone`: Page zone (header, nav, main, sidebar, footer)
- `href` (optional): Link destination
- `placeholder` (optional): Input placeholder

**Storage**:
```
ontology/
  roadmaps/
    hometax.go.kr/
      main.json              ← Homepage elements
      tax-inquiry.json       ← Tax inquiry page elements
      tax-report.json        ← Tax report page elements
```

#### LLM Context Format

**Compressed Format for Token Efficiency**:
```
Page: hometax.go.kr/main
Last updated: 2026-01-23T15:30:00Z

Available Interactive Elements:

[HEADER]
  elem-0: "로그인" (button)
  elem-1: "회원가입" (link)

[NAV]
  elem-2: "세금신고" (link)
  elem-3: "세금조회" (link)
  elem-4: "마이페이지" (link)

[MAIN]
  elem-5: 검색 입력창 (input)
  elem-6: "검색" (button)
  elem-7: "종합소득세 신고" (button)
  elem-8: "부가가치세 신고" (button)

Total: 9 interactive elements
```

**LLM Instruction Template**:
```
You are controlling a browser on behalf of the user.
Above is the current page structure (auto-generated from HTML).

User request: "[user's task]"

Select the appropriate element by elem-id and specify the action.
Format: {action: "click"|"type", target: "elem-N", value: "text" (for type)}
```

**Example Interaction**:
```
User: "세금 조회해줘"

LLM: {
  "action": "click",
  "target": "elem-3",
  "reason": "elem-3 is '세금조회' link in NAV zone"
}

System: Executing click on selector: .nav-item:nth-child(2)
```

#### Unified Control Layer (Event Normalization)

**Challenge**: AI-triggered actions and user-triggered actions produce different outputs.

**Solution**: Unified Control Layer normalizes all events to the same format.

**Architecture**:
```
┌─────────────────────────────────────┐
│   User Input   │   AI Commands      │
│   (마우스/키보드)  │  (elem-3 클릭)    │
└────────┬────────┴──────────┬─────────┘
         │                   │
         ▼                   ▼
    ┌────────────────────────────┐
    │  Unified Control Layer     │  ← Normalizes events
    │  (Event Normalization)     │
    └────────────┬───────────────┘
                 │
                 ▼
    ┌────────────────────────────┐
    │  Normalized Event:         │
    │  {                         │
    │    source: "user" | "ai",  │
    │    action: "click",        │
    │    target: "elem-3",       │
    │    selector: ".nav-inquiry"│
    │  }                         │
    └────────────┬───────────────┘
                 │
                 ▼
         ┌───────────────┐
         │  CDP/Browser  │
         └───────────────┘
```

**Implementation**:
```javascript
class UnifiedBrowserController {
  // AI action execution
  async executeAIAction(elemId, actionType = 'click') {
    const element = this.roadmap.elements.find(e => e.id === elemId);

    const normalizedEvent = {
      source: 'ai',
      action: actionType,
      target: elemId,
      selector: element.selector,
      text: element.text,
      timestamp: Date.now()
    };

    await this.page.click(element.selector);
    this.emit('action', normalizedEvent);

    return normalizedEvent;
  }

  // User action detection
  setupUserActionListener() {
    this.page.evaluate(() => {
      document.addEventListener('click', (event) => {
        const element = event.target;
        window.__egdesk_userAction = {
          selector: generateSelector(element),
          text: element.textContent?.trim(),
          type: element.tagName.toLowerCase()
        };
      }, true);
    });

    // Poll for user actions
    setInterval(async () => {
      const userAction = await this.page.evaluate(() => {
        const action = window.__egdesk_userAction;
        window.__egdesk_userAction = null;
        return action;
      });

      if (userAction) {
        const matchedElem = this.findElementBySelector(userAction.selector);

        const normalizedEvent = {
          source: 'user',
          action: 'click',
          target: matchedElem?.id || 'unknown',
          selector: userAction.selector,
          text: userAction.text,
          timestamp: Date.now()
        };

        this.emit('action', normalizedEvent);
      }
    }, 100);
  }

  // Unified event handler
  on(eventType, handler) {
    // Both AI and User actions trigger the same handler
  }
}
```

**Unified Event Handler Example**:
```javascript
controller.on('action', async (event) => {
  // event = {source: 'ai'|'user', action, target, selector, text}

  // 1. Learning: Record user actions for workflow learning
  if (event.source === 'user') {
    await learningSystem.recordUserAction(event);
  }

  // 2. Context update: Parse new page after navigation
  await waitForNavigation();
  const newRoadmap = await parseCurrentPage();

  // 3. Update LLM context
  llmContext.updateRoadmap(newRoadmap);

  // 4. Suggest next action (if user-driven)
  if (event.source === 'user') {
    const suggestion = await llm.suggestNextAction(newRoadmap);
    ui.showSuggestion(suggestion);
  }
});
```

**Benefits**:
- **Seamless Handoff**: AI → User → AI transitions are natural
- **Unified Learning**: System learns from both AI and user actions
- **Consistent Logging**: All actions logged in same format
- **Workflow Recording**: Complete workflow captured regardless of source

#### Execution Flow

**Complete Flow (User Request → Execution)**:
```
1. User Request: "세금 조회해줘"
   ↓
2. Load Roadmap: ontology/roadmaps/hometax.go.kr/main.json
   ↓
3. Format for LLM: Compressed text format (50-100 tokens)
   ↓
4. LLM Decision: {action: "click", target: "elem-3"}
   ↓
5. Execute: controller.executeAIAction('elem-3')
   ↓
6. Normalized Event: {source: 'ai', target: 'elem-3', selector: '.nav-inquiry'}
   ↓
7. CDP Execution: page.click('.nav-inquiry')
   ↓
8. Navigation: Wait for new page load
   ↓
9. Re-parse: Generate new roadmap for /tax/inquiry
   ↓
10. Update Context: Load new roadmap for next action
```

**Speed Comparison**:
```
Claude Code (No Roadmap):
  Screenshot (500ms) → Vision (2s) → Decide (1s) → Click (100ms) = 3.6s per action

EG-DESK (With Roadmap):
  Load roadmap (10ms) → LLM (500ms) → Click (100ms) = 0.61s per action

Improvement: 5-6x faster
```

**Fallback on Error**:
```javascript
async function executeWithFallback(action, roadmap, page) {
  try {
    // Attempt roadmap-based execution
    const element = roadmap.elements.find(e => e.id === action.target);
    await page.click(element.selector);

  } catch (error) {
    // Fallback to native mode (vision + exploration)
    console.log('Roadmap failed, using vision...');

    const screenshot = await page.screenshot();
    const visionResponse = await callVisionLLM(screenshot, action);
    await page.click(visionResponse.x, visionResponse.y);

    // Mark roadmap as stale
    await ontology.markStale(roadmap.domain, roadmap.url);
  }
}
```

---

## Target Domains

**To Be Determined by User**

Priority recommendations based on vision alignment:

| Priority | Use Case | Rationale |
|----------|----------|-----------|
| **P0** | Government portals (홈택스, 정부24) | High-value, stable structure, explicit Ontology target |
| **P0** | Banking/Finance | High-value, security-sensitive, needs reliability |
| **P1** | Enterprise SaaS (ERP, CRM) | Complex, repetitive workflows |
| **P1** | E-commerce operations | Order management, inventory updates |
| **P2** | Social media management | Content scheduling, analytics |
| **P2** | General web navigation | Catch-all fallback |

**Phase 1 POC**: Select 2-3 high-value domains for initial validation.

---

## Success Metrics

### Phase 1 POC Metrics

| Metric | Target | Measurement Method |
|--------|--------|-------------------|
| Speed improvement (known path) | 5x faster vs no-context | Time to complete workflow |
| Action success rate | >95% | First-attempt success on known selectors |
| Roadmap accuracy | >90% | Selector validity after 1 week |
| Fallback reliability | 100% | Graceful degradation to native mode |

### Long-term Metrics

| Metric | Target | Measurement Method |
|--------|--------|-------------------|
| Domain coverage | 50+ roadmaps | Ontology entries |
| User workflow adoption | 80% use roadmap-enhanced | Usage analytics |
| Roadmap staleness detection | <5% stale at any time | Validation checks |

---

## Implementation Phases

### Phase 1: Proof of Concept (2-4 weeks)

**Goal**: Validate the core concept with hand-authored roadmaps.

**Scope**:
- Select 2-3 high-value domains (TBD by user)
- Create manual website roadmaps (hand-authored YAML)
- Integrate with existing CDP API
- Measure speed improvement

**Deliverables**:
- [ ] Roadmap schema v1 (YAML format)
- [ ] 2-3 hand-authored roadmaps
- [ ] Context injection into AI prompts
- [ ] Speed comparison benchmark
- [ ] Fallback mechanism (roadmap fail -> native mode)

### Phase 2: Semi-Automated Roadmap Generation (4-6 weeks)

**Goal**: Reduce manual effort in roadmap creation.

**Scope**:
- Build crawler that extracts site structure
- Create roadmap schema and storage in Ontology
- Implement context injection into LLM prompts
- Test with 10+ domains

**Deliverables**:
- [ ] Site structure crawler
- [ ] Ontology integration for roadmap storage
- [ ] Roadmap editor UI (optional)
- [ ] 10+ domain roadmaps

### Phase 3: Production Integration (4-6 weeks)

**Goal**: Seamless user experience with automatic roadmap handling.

**Scope**:
- Integrate with Infinite Canvas (auto-analyze on add)
- Implement staleness detection and refresh
- Add user-facing "사이트 학습해줘" command
- Create mini-app template using roadmaps

**Deliverables**:
- [ ] Auto-analyze on WebContentsView add
- [ ] Staleness detection (>30 days)
- [ ] Background refresh mechanism
- [ ] "사이트 학습" user command
- [ ] Mini-app template

### Phase 4: Learning Loop (Ongoing)

**Goal**: Continuous improvement through usage.

**Scope**:
- Record successful workflows -> auto-enhance roadmaps
- Detect site changes -> mark roadmap stale
- (Future) Share anonymized roadmaps across users

**Deliverables**:
- [ ] Workflow-to-roadmap enhancement
- [ ] Site change detection
- [ ] Roadmap versioning
- [ ] (Future) Anonymized sharing infrastructure

---

## Critical Considerations

### 1. Site Change Detection
Websites change. Roadmaps must include:
- Last updated timestamp
- Validation mechanism (periodic selector checks)
- Staleness threshold (default: 30 days)
- Auto-refresh triggers

### 2. Roadmap Granularity
Start coarse (navigation + key elements), refine based on usage:
- Level 1: Site structure and main navigation
- Level 2: Key form elements and buttons
- Level 3: Detailed selectors and edge cases

### 3. Graceful Fallback
If roadmap is wrong/outdated:
- Detect failure (selector not found, unexpected page)
- Fall back to native mode (vision + exploration)
- Log issue for roadmap update
- Never hard-fail

### 4. Privacy
Roadmaps must NOT contain:
- User credentials
- Personal data
- Session-specific information
Only structural information (selectors, navigation paths).

### 5. Legal Considerations
Some sites may have ToS against automated analysis:
- Government/public sites: Generally permissible
- Enterprise: Check customer agreement
- Consumer sites: Review ToS carefully

---

## Technical Dependencies

### Required (Existing)
- `UNIFIED_BROWSER_AUTOMATION_API.md` - CDP Bridge Service
- Playwright/Puppeteer stack (production)
- Electron WebContentsView
- Ontology storage system

### Required (New)
- Roadmap schema definition
- Context injection service
- Roadmap storage in Ontology
- Staleness detection service

### Optional (Phase 2+)
- Site structure crawler
- Roadmap editor UI
- Workflow-to-roadmap enhancer

---

## References

### Internal Documents
- `ideas/confirmed/UNIFIED_BROWSER_AUTOMATION_API.md` - Base browser automation PRD
- `ideas/confirmed/technology-stack.md` - Technology stack registry
- Vision Whitepaper (Observation Learning, Ambient AI)
- Production Whitepaper (Oneshot Execution, Ontology)

### Consultation Report
- `subagent_reports/20260123_context-aware-chrome-automation-pm-consultation.md` - Full strategic analysis

---

## Changelog

### 2026-01-23
- Initial PRD creation
- Phase 1 POC approved by user
- Target domains TBD
- **Added Implementation Details section**:
  - HTML Parsing Strategy (interactive elements only)
  - Roadmap JSON Format specification
  - LLM Context Format (compressed, token-efficient)
  - Unified Control Layer (event normalization for AI/User actions)
  - Complete execution flow documentation

