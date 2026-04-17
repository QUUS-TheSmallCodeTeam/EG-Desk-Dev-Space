# EG-DESK Spatial Canvas UX 종합 솔루션

*Last Updated: 2025-10-04 · Firefox shell note added 2026-04-17*

> ## 🟢 MOSTLY VALID under Firefox Shell (2026-04-17, ADR-007)
>
> 본 문서는 **UX 솔루션 중심** 이라 Firefox shell pivot 후에도 **대부분 유효**. 구현 세부만 교체:
> - Canvas = chrome JS + 우리 overlay (Electron renderer 대신)
> - Browser entity = XUL `<browser>` card (WebContentsView 대신)
> - IPC = JSActor + WebSocket (helper) + Subprocess (`child_process` 대신)
>
> 각 섹션의 "Electron / WebContentsView / IPC" 언급은 Firefox shell 등가물로 읽을 것. UX 의사결정 로직 (3-state 카드, Edge Framework, Zone Model, proximity=relevance) 은 그대로.
>
> **참조**: [`FIREFOX_SHELL_STRATEGY.md`](FIREFOX_SHELL_STRATEGY.md), [`ADR-007`](../../.claude/docs/decisions/007-firefox-shell-over-electron.md)

## 개요

이 문서는 EG-DESK의 무한 캔버스 기반 Ambient AI 워크스페이스 구현 시 발생하는 8가지 핵심 UX/기술 문제에 대한 종합 솔루션을 제시합니다.

---

## 문제 #1 & #8: 거리가 먼 요소 선택 및 클러스터 간 이동

### 문제 정의

**문제**: 멀리 떨어진 두 요소를 묶거나 클러스터 간 이동 시 pan/zoom이 불편함

**연구 발견사항**:
- **Figma**: 네이티브 minimap 없음 (커뮤니티 요청 많음), 검색-투-프레임 기능 없음
- **Miro**: 키보드 네비게이션 (화살표로 pan, Cmd+/- zoom), 50+ 단축키
- **Figma Minimap 플러그인**: 클릭 한번에 캔버스 위치 점프

### 솔루션 제안

#### 1. Command Palette 확장 - Quick Jump

```
Cmd+K → "Jump to [검색어]"
- 요소 이름, 태그, 클러스터명 검색
- 퍼지 매칭으로 빠른 접근
- 최근 방문 요소 히스토리
```

#### 2. Minimap (우측 하단)

```
Canvas 전체 축소 뷰
- 현재 viewport 박스 표시
- 클러스터 영역 하이라이트
- 클릭으로 즉시 이동
- 토글 단축키: Cmd+M
```

#### 3. Multi-Select Across Distance (Lasso+)

```
Shift+드래그: 전통적 영역 선택
Cmd+클릭: 개별 요소 추가 선택 (거리 무관)
Cmd+Shift+드래그: 거리 무관 "매직 라쏘"
  → 선택된 요소들 사이 연결선 자동 생성
  → "이 요소들을 컨텍스트로 AI 호출" 버튼 표시
```

#### 4. 북마크/앵커 시스템

```
우클릭 → "Create Bookmark Here"
Cmd+1~9: 북마크 저장/점프
사이드바에 북마크 리스트
클러스터 중심에 자동 앵커 생성
```

---

## 문제 #2: Multi-Viewport 렌더링 기술적 가능성

### 문제 정의

**문제**: 하나의 브라우저 엔진만 실행, 여러 곳에서 시각적 렌더링 가능한가?

**연구 발견사항**:
- **Electron WebContentsView (v30+)**: BrowserView 대체, 여러 뷰 타일링 가능
- **Offscreen Rendering**: `paint` 이벤트로 bitmap/GPU texture 추출 가능
- **React Portals**: 멀티 윈도우 앱 구조, CSS 동기화 복잡
- 각 BrowserWindow = 별도 renderer process (완전 격리)

### 솔루션 제안

#### 방안 A: Offscreen Rendering + Canvas Clone (추천)

```typescript
// 메인 WebContentsView (실제 브라우저 인스턴스)
const mainView = new WebContentsView({
  webPreferences: {
    offscreenRendering: true,
    useSharedTexture: true  // GPU 가속
  }
});

// Paint 이벤트로 프레임 캡처
mainView.webContents.on('paint', (event, dirty, image) => {
  // image.toBitmap() 또는 event.texture 사용
  const frame = image.toPNG();

  // 캔버스의 "미러 요소"들에 브로드캐스트
  mirrorElements.forEach(el => {
    el.updateFrame(frame);  // <canvas> 또는 <img> 업데이트
  });
});
```

**특징**:
- ✅ 진짜 하나의 브라우저 인스턴스 (메모리 효율)
- ✅ 여러 캔버스 위치에 동일 렌더링 표시
- ✅ 미러는 "읽기 전용" 스냅샷 (클릭하면 메인으로 포커스 이동)
- ⚠️ 60fps 동기화 시 성능 고려 필요 (requestAnimationFrame 최적화)

#### 방안 B: Multiple WebContentsView (독립 인스턴스)

```typescript
// 각 캔버스 위치마다 별도 WebContentsView
const view1 = new WebContentsView({ /* ... */ });
const view2 = new WebContentsView({ /* ... */ });

// 같은 URL 로드
view1.webContents.loadURL('https://example.com');
view2.webContents.loadURL('https://example.com');
```

**특징**:
- ✅ 각 뷰가 독립적으로 스크롤/인터랙션 가능
- ❌ 메모리 2배 소비 (별도 renderer process)
- ❌ 상태 동기화 어려움 (로그인, 스크롤 위치 등)

#### 방안 C: 하이브리드 - "Reference Card"

```typescript
interface CanvasElement {
  type: 'primary' | 'reference';
  sourceViewId?: string;  // reference인 경우 원본 참조
}

// Primary: 실제 WebContentsView
// Reference: 주기적 스크린샷 + "Open Primary" 버튼
```

**사용 시나리오**:
1. 사용자가 브라우저를 캔버스에 배치 (Primary)
2. 사용자가 Cmd+D로 "Reference 복사" 생성
3. Reference는 5초마다 스크린샷 업데이트 (또는 수동)
4. Reference 클릭 → Primary로 viewport 이동

---

## 문제 #3 & #4: Context 관리 - 성능 vs UI

### 문제 정의

**문제**:
- UI에서는 대화내역 신경 안쓰지만, 성능/비용 관점에서는 compartmentalized context 관리 필수
- 프로젝트별, 시간대별 분류하여 context 공급해야 cost 절감 + 성능 향상
- Expert user를 위한 관리 UI 필요, 또는 AI의 자동 관리 시스템

**연구 발견사항**:
- **Context Engineering (2025)**: 공식 학문 분야로 등장
- **Hierarchical Memory**: Working memory (context window) + Long-term (RAG/vector DB)
- **MemGPT 접근**: Orchestrator가 working memory에 무엇을 올릴지 결정
- **성능 한계**: 32K 토큰 초과 시 정확도 급격히 하락 (2M 토큰 한계 표기와 무관)

### 솔루션: 3-Tier Context Hierarchy

#### 아키텍처

```typescript
interface ContextTier {
  // Tier 1: Active Working Memory (항상 로드)
  activeContext: {
    currentViewport: Element[];       // 화면에 보이는 요소들
    selectedElements: Element[];      // 유저가 선택한 요소들
    recentConversation: Message[];    // 최근 10개 메시지
    workflowState: WorkflowMetadata;  // 현재 워크플로우 상태
  };

  // Tier 2: Project Memory (요청 시 로드)
  projectContext: {
    clusterID: string;
    projectMetadata: ProjectInfo;
    conversationHistory: Message[];   // 이 프로젝트의 전체 대화
    relatedElements: Element[];       // 클러스터 내 모든 요소
    embeddedVectors: VectorIndex;     // RAG용 벡터 DB
  }[];

  // Tier 3: Archive (검색으로만 접근)
  archivedContext: {
    timestamp: Date;
    projectID: string;
    conversationSnapshot: Message[];
    canvasSnapshot: Image;
    vectorIndex: VectorIndex;
  }[];
}
```

#### AI Orchestrator - 자동 Context 관리

```typescript
class ContextOrchestrator {
  async prepareContext(userPrompt: string): Promise<ContextPayload> {
    // 1. Active Context (항상 포함)
    const activeCtx = this.getActiveContext();

    // 2. Relevance Score 계산
    const projectScores = this.projects.map(p => ({
      project: p,
      score: this.calculateRelevance(userPrompt, p)
    }));

    // 3. Top-K Projects만 로드 (K=3)
    const relevantProjects = projectScores
      .sort((a, b) => b.score - a.score)
      .slice(0, 3)
      .map(p => p.project.context);

    // 4. Token Budget 계산
    const totalTokens = this.estimateTokens(activeCtx)
                      + this.estimateTokens(relevantProjects);

    if (totalTokens > 30000) {
      // 5. Compression: 요약 또는 일부 제외
      return this.compressContext(activeCtx, relevantProjects);
    }

    return { activeCtx, relevantProjects };
  }

  calculateRelevance(prompt: string, project: Project): number {
    // Embedding 유사도 + Spatial proximity + Recency
    const embedding = this.embedPrompt(prompt);
    const similarity = cosineSimilarity(embedding, project.embedding);
    const spatial = project.elements.some(el =>
      this.viewport.contains(el)
    ) ? 0.3 : 0;
    const recency = this.getRecencyScore(project.lastAccessed);

    return similarity * 0.5 + spatial * 0.3 + recency * 0.2;
  }
}
```

#### Expert User Management UI

**패널 구조** (좌측 사이드바 확장):

```
┌─ Context Manager ─────────────┐
│ [Active] 🟢                   │
│  └─ Current Viewport (2.3K)   │
│  └─ Selected Elements (1.5K)  │
│  └─ Recent Messages (5.2K)    │
│  └─ Total: 9K tokens          │
│                               │
│ [Projects] 📁                 │
│  ├─ Tax Report Q4 (15K) ⭐    │  ← 현재 활성
│  ├─ Marketing Campaign (8K)   │
│  └─ Client Onboarding (12K)   │
│                               │
│ [Archives] 📦                 │
│  ├─ 2025-09-15 ~ 2025-09-30   │
│  └─ 2025-08-01 ~ 2025-08-31   │
│                               │
│ [AI Auto-Manage] 🤖           │
│  └─ "프로젝트 자동 분류"       │
│  └─ "오래된 대화 자동 압축"    │
└───────────────────────────────┘
```

**기능**:
- **Drag-and-drop**: 메시지를 프로젝트 간 이동
- **Manual Archive**: 프로젝트를 Archive로 수동 이동
- **Token Budget Alert**: 30K 초과 시 경고 + 압축 제안
- **Context Preview**: 각 프로젝트 클릭 시 "어떤 정보가 포함되는지" 미리보기

#### AI 자동 관리 시스템

```typescript
class AutoContextManager {
  // 규칙 1: 시간 기반 자동 아카이빙
  async autoArchive() {
    const oldProjects = this.projects.filter(p =>
      p.lastAccessed < Date.now() - 30 * 24 * 60 * 60 * 1000  // 30일
    );

    for (const project of oldProjects) {
      await this.archiveProject(project);
      this.notify(`"${project.name}" 아카이빙됨 (30일 미사용)`);
    }
  }

  // 규칙 2: 공간 기반 자동 클러스터링
  async autoCluster() {
    const unassignedElements = this.canvas.elements.filter(el =>
      !el.projectID
    );

    // DBSCAN 클러스터링 (proximity 기반)
    const clusters = this.dbscan(unassignedElements, {
      eps: 200,  // 200px 이내면 같은 클러스터
      minPts: 2
    });

    clusters.forEach((cluster, idx) => {
      const projectName = this.generateProjectName(cluster);  // AI 생성
      this.createProject(projectName, cluster);
    });
  }

  // 규칙 3: Conversation 요약 (긴 히스토리)
  async summarizeConversation(project: Project) {
    if (project.messages.length > 50) {
      const summary = await this.llm.summarize(project.messages);
      project.conversationSummary = summary;
      project.messages = project.messages.slice(-10);  // 최근 10개만 유지
    }
  }
}
```

---

## 문제 #5: Spatial Proximity Model 개선

### 유저 피드백

- ❌ 왼쪽→오른쪽 배치 아님
- ✅ 동서남북 방향으로 proximity
- ✅ 화살표 방향은 굿
- ✅ 클러스터 형성 → 개별 프로젝트 분류
- **핵심**: 현재 viewport에 보이는 요소들 = 하나의 전체 context (안보이면 우선도 낮음)

### 업데이트된 Spatial Context 엔진

```typescript
interface SpatialContextEngine {
  // Viewport-First 접근
  calculateContext(userFocus: Element): ContextMap {
    const viewport = this.getCurrentViewport();

    // 1. Viewport 내부 요소 = Primary Context
    const visibleElements = this.canvas.elements.filter(el =>
      viewport.intersects(el.bounds)
    );

    // 2. Omni-directional Proximity (동서남북)
    const proximityMap = visibleElements.map(el => ({
      element: el,
      distance: this.calculateDistance(userFocus, el),
      direction: this.getDirection(userFocus, el),  // N, NE, E, SE, S, SW, W, NW
      relevance: this.calculateRelevance(userFocus, el, viewport)
    }));

    // 3. Out-of-viewport elements = Secondary Context (낮은 우선도)
    const hiddenElements = this.canvas.elements.filter(el =>
      !viewport.intersects(el.bounds)
    ).map(el => ({
      element: el,
      relevance: 0.1,  // 매우 낮은 기본 relevance
      reason: 'out-of-viewport'
    }));

    return {
      primary: proximityMap.sort((a, b) => b.relevance - a.relevance),
      secondary: hiddenElements
    };
  }

  calculateRelevance(focus: Element, target: Element, viewport: Viewport): number {
    const distance = this.calculateDistance(focus, target);
    const inViewport = viewport.intersects(target.bounds) ? 1.0 : 0.1;

    // Gestalt Proximity: 거리 역제곱 법칙
    const proximityScore = Math.max(0, 1 - (distance / 500) ** 2);

    // Arrow connection boost
    const hasArrow = this.canvas.arrows.some(a =>
      (a.from === focus.id && a.to === target.id) ||
      (a.from === target.id && a.to === focus.id)
    );
    const arrowBoost = hasArrow ? 0.3 : 0;

    // Cluster membership boost
    const sameCluster = focus.clusterID === target.clusterID;
    const clusterBoost = sameCluster ? 0.2 : 0;

    return (proximityScore * 0.5 + arrowBoost + clusterBoost) * inViewport;
  }

  getDirection(from: Element, to: Element): Direction {
    const dx = to.position.x - from.position.x;
    const dy = to.position.y - from.position.y;
    const angle = Math.atan2(dy, dx) * 180 / Math.PI;

    // 8방향 분류
    if (angle >= -22.5 && angle < 22.5) return 'E';
    if (angle >= 22.5 && angle < 67.5) return 'SE';
    if (angle >= 67.5 && angle < 112.5) return 'S';
    if (angle >= 112.5 && angle < 157.5) return 'SW';
    // ... (나머지 방향)
  }
}
```

### Viewport Context 시각화

```
현재 Viewport:
┌─────────────────────────────────┐
│  [Excel]     →    [Browser]     │  ← 보임 (Relevance 1.0)
│    ↓                             │
│  [Email Draft]                   │  ← 보임 (Relevance 0.85)
└─────────────────────────────────┘

Viewport 밖:
      [Slack]  ← 안보임 (Relevance 0.1)
```

### AI Prompt 구성

```
당신의 현재 작업 컨텍스트:

[Primary - Viewport 내부]
1. Excel 스프레드시트 (중심, 100% relevance)
2. Browser - HomeTax (50px 동쪽, 95% relevance, 화살표 연결)
3. Email Draft (70px 남쪽, 85% relevance)

[Secondary - Viewport 외부]
4. Slack 대화 (500px 서쪽, 10% relevance, 현재 화면 밖)

사용자 요청: "VAT 데이터 추출해줘"
→ AI는 Browser(HomeTax)와 Excel에 집중, Slack은 무시
```

---

## 문제 #6: Context Feeding 전략 명확화

### 유저의 해결책

> "유저가 캔버스 위의 요소를 여러개 선택할 수 있는데 그렇게 하면 안의 내용이 prompt에 첨부되고, 화면에 보이는 요소는 reference만 보여지는거지. 그다음에는 ai가 알아서 tool calling하는거고."

### 최종 Context Feeding 아키텍처

```typescript
interface ContextFeedingStrategy {
  // 1. User-Selected Elements → Full Content Attachment
  selectedElements: {
    element: Element;
    fullContent: string | Buffer;  // 전체 내용 첨부
    attachmentType: 'text' | 'image' | 'pdf' | 'webpage';
  }[];

  // 2. Visible (Non-Selected) Elements → Reference Only
  visibleReferences: {
    element: Element;
    metadata: {
      type: string;
      title: string;
      preview: string;  // 100자 미리보기
      url?: string;
    };
  }[];

  // 3. AI Tool Calling for Additional Data
  availableTools: Tool[];
}

class PromptBuilder {
  buildPrompt(userInput: string, context: ContextFeedingStrategy): string {
    let prompt = `# 사용자 입력\n${userInput}\n\n`;

    // User-selected: Full content
    if (context.selectedElements.length > 0) {
      prompt += `# 첨부된 자료 (사용자가 선택함)\n`;
      context.selectedElements.forEach((sel, i) => {
        prompt += `\n## 자료 ${i+1}: ${sel.element.title}\n`;
        prompt += sel.fullContent + '\n';
      });
    }

    // Visible: Reference only
    if (context.visibleReferences.length > 0) {
      prompt += `\n# 참조 가능한 자료 (화면에 보임, 필요시 tool로 접근)\n`;
      context.visibleReferences.forEach(ref => {
        prompt += `- ${ref.metadata.type}: "${ref.metadata.title}"\n`;
        prompt += `  Preview: ${ref.metadata.preview}\n`;
      });
    }

    // Tool instructions
    prompt += `\n# 사용 가능한 도구\n`;
    prompt += `- readElement(elementId): 특정 요소의 전체 내용 읽기\n`;
    prompt += `- searchCanvas(query): 캔버스에서 관련 요소 검색\n`;
    prompt += `- navigateWeb(elementId, action): 브라우저 요소 제어\n`;

    return prompt;
  }
}
```

### 사용 예시

#### 시나리오 1: 파일 병합 요청

```
유저 행동:
1. Cmd+클릭으로 [A파일], [B파일] 선택
2. Cmd+K → "이 두 파일 병합해줘"

AI가 받는 Prompt:
─────────────────────
# 사용자 입력
이 두 파일 병합해줘

# 첨부된 자료 (사용자가 선택함)
## 자료 1: quarterly_report.xlsx
[전체 엑셀 데이터...]

## 자료 2: sales_data.csv
[전체 CSV 데이터...]

# 참조 가능한 자료 (화면에 보임)
- Email Draft: "Q4 Report Final"
  Preview: "Dear team, Please find attached..."
─────────────────────

→ AI는 A, B 파일 전체 내용을 직접 받음
→ Email Draft는 reference만, 필요하면 readElement() 호출
```

#### 시나리오 2: 요소 미선택 시

```
유저 행동:
1. 아무것도 선택 안함
2. Cmd+K → "HomeTax에서 VAT 데이터 가져와줘"

AI가 받는 Prompt:
─────────────────────
# 사용자 입력
HomeTax에서 VAT 데이터 가져와줘

# 참조 가능한 자료 (화면에 보임)
- Browser: "HomeTax 부가세 신고"
  Preview: "국세청 홈택스 - 부가가치세 신고..."
- Excel: "Q4_VAT_Report.xlsx"
  Preview: "Sheet1: 날짜, 공급가액, 세액..."

# 사용 가능한 도구
- readElement(elementId): 특정 요소의 전체 내용 읽기
─────────────────────

AI 실행:
1. "HomeTax" 언급 감지
2. readElement('browser-hometax-id') 호출
3. 브라우저 DOM 스크래핑 or screenshot 분석
4. Excel 파일에 데이터 입력
```

---

## 문제 #7: AI 실행 과정 및 결과를 캔버스에 시각화

### 유저 아이디어

> "ai가 '계획을 세웠습니다. 컨펌받기 위해 제 설명을 따라와주세요' 하고 채팅창에 버튼이 생기는데 그거 누르면 해당 캔버스 요소로 화면이 이동하고 다음다음 눌러서 다음 단계에 해당하는 요소로 이동하는거지. 계획 설명도 요소 옆에 커멘트로 보여주고. 결과 리포트도 마찬가지."

### 솔루션: Canvas-Integrated Workflow Visualization

#### 1. AI 계획 단계 - "Guided Tour" 모드

```typescript
interface WorkflowPlan {
  steps: WorkflowStep[];
  status: 'draft' | 'approved' | 'executing' | 'completed';
}

interface WorkflowStep {
  id: string;
  targetElement: Element;
  action: string;
  description: string;
  position: { x: number, y: number };  // 캔버스 좌표
  status: 'pending' | 'current' | 'completed' | 'error';
}

class WorkflowVisualizer {
  async showPlan(plan: WorkflowPlan) {
    // Command Palette에 계획 카드 표시
    const planCard = `
      📋 AI가 계획을 세웠습니다 (${plan.steps.length}단계)

      [미리보기 🔍] [실행 ✅] [수정 ✏️]
    `;

    this.commandPalette.show(planCard);
  }

  async startGuidedTour(plan: WorkflowPlan) {
    for (let i = 0; i < plan.steps.length; i++) {
      const step = plan.steps[i];

      // 1. 해당 요소로 viewport 이동 (애니메이션)
      await this.canvas.panTo(step.targetElement, {
        duration: 500,
        zoom: 1.2  // 약간 확대
      });

      // 2. 요소 옆에 Comment Bubble 표시
      this.showComment(step.targetElement, {
        title: `Step ${i+1}/${plan.steps.length}`,
        description: step.description,
        action: step.action
      });

      // 3. Navigation UI 표시 (우측 하단)
      this.showNavigationControl({
        current: i + 1,
        total: plan.steps.length,
        onNext: () => this.nextStep(),
        onPrev: () => this.prevStep(),
        onApprove: () => this.executePlan(plan),
        onReject: () => this.cancelPlan()
      });

      // 4. 사용자 액션 대기
      await this.waitForUserAction();
    }
  }

  showComment(element: Element, comment: StepComment) {
    const bubble = `
    ┌─ AI Comment ──────────────────┐
    │ ${comment.title}              │
    │                               │
    │ ${comment.description}        │
    │                               │
    │ 수행할 작업:                   │
    │ ${comment.action}             │
    └───────────────────────────────┘
          ↓
      [Element]
    `;

    this.canvas.addOverlay(bubble, {
      anchorTo: element,
      position: 'top-left',
      style: 'speech-bubble'
    });
  }
}
```

**UI 예시**:

```
Canvas View:
┌─────────────────────────────────────────┐
│                                         │
│  ┌─ Step 2/5 ─────────────┐            │
│  │ HomeTax에서 VAT 데이터  │            │
│  │ 추출하기                │            │
│  │                         │            │
│  │ 작업: 테이블 스크래핑    │            │
│  └─────────────────────────┘            │
│             ↓                           │
│      [🌐 HomeTax Browser]               │
│                                         │
│                                         │
│               [◀ 이전]  [승인 ✅]  [다음 ▶] │
└─────────────────────────────────────────┘
```

#### 2. AI 실행 단계 - Live Progress Visualization

```typescript
class ExecutionVisualizer {
  async executeWithVisualization(plan: WorkflowPlan) {
    for (const step of plan.steps) {
      step.status = 'current';

      // 1. Step에 Progress Indicator 표시
      this.showProgressIndicator(step.targetElement, {
        type: 'spinner',
        message: step.action
      });

      // 2. 실제 작업 수행
      try {
        const result = await this.executor.execute(step);

        // 3. 성공 시 체크마크
        step.status = 'completed';
        this.showSuccess(step.targetElement);

        // 4. 결과물이 새 요소면 캔버스에 추가
        if (result.newElement) {
          const newEl = await this.canvas.addElement(result.newElement, {
            position: this.calculatePosition(step.targetElement),
            animation: 'fade-in'
          });

          // 5. 원본 요소와 화살표 연결
          this.canvas.addArrow(step.targetElement, newEl, {
            label: step.action,
            style: 'dashed'  // 프로세스 흐름 표시
          });
        }

      } catch (error) {
        // 6. 실패 시 에러 표시
        step.status = 'error';
        this.showError(step.targetElement, error.message);
      }
    }
  }

  calculatePosition(sourceElement: Element): Position {
    // 원본 요소 오른쪽에 배치
    return {
      x: sourceElement.position.x + sourceElement.width + 100,
      y: sourceElement.position.y
    };
  }
}
```

**실행 중 시각화**:

```
Before:
[HomeTax] → [Excel]

During Execution:
[HomeTax] ─⏳ 테이블 스크래핑 중...→ [Excel]

After Execution:
[HomeTax] ──✅ 테이블 스크래핑 완료──→ [Excel (데이터 삽입됨)]
                                        ↓
                                  [📄 VAT_Report.pdf]  ← 새로 생성
```

#### 3. 결과 리포트 - Canvas Element로 렌더링

```typescript
interface ExecutionReport {
  summary: string;
  steps: StepResult[];
  artifacts: Artifact[];  // 생성된 파일, 스크린샷 등
  duration: number;
}

class ReportRenderer {
  async renderReport(report: ExecutionReport) {
    // 1. 리포트 카드를 캔버스에 추가
    const reportElement = await this.canvas.addElement({
      type: 'report-card',
      title: '🎉 작업 완료',
      content: this.formatReport(report),
      position: this.findEmptySpace(),  // 빈 공간 찾기
      width: 400,
      height: 'auto'
    });

    // 2. Artifacts를 개별 요소로 배치
    const artifactElements = await Promise.all(
      report.artifacts.map(artifact =>
        this.canvas.addElement({
          type: artifact.type,
          title: artifact.name,
          content: artifact.data,
          position: this.calculatePosition(reportElement),
          animation: 'slide-in'
        })
      )
    );

    // 3. 리포트와 artifacts 연결
    artifactElements.forEach(el => {
      this.canvas.addArrow(reportElement, el, {
        label: '생성됨',
        style: 'solid'
      });
    });

    // 4. Viewport를 리포트로 이동
    await this.canvas.panTo(reportElement, {
      duration: 800,
      zoom: 1.0
    });

    // 5. Command Palette에 요약 표시
    this.commandPalette.show(`
      ✅ 작업 완료!

      ${report.summary}

      생성된 파일: ${report.artifacts.length}개
      소요 시간: ${report.duration}초

      [캔버스에서 보기 📍]
    `);
  }

  formatReport(report: ExecutionReport): string {
    return `
      ## 실행 결과

      ${report.summary}

      ### 단계별 결과
      ${report.steps.map((step, i) => `
        ${i+1}. ${step.description}
           ${step.status === 'completed' ? '✅' : '❌'} ${step.message}
      `).join('\n')}

      ### 생성된 자료
      ${report.artifacts.map(a => `- ${a.name}`).join('\n')}

      Total: ${report.duration}초
    `;
  }
}
```

**최종 캔버스 상태**:

```
Workflow Completed View:

[HomeTax] ──✅──→ [Excel] ──✅──→ [Email Draft]
                    ↓
              [📊 VAT_Report.pdf]
                    ↓
          ┌─ 🎉 작업 완료 ─────────┐
          │                        │
          │ VAT 데이터 추출 및      │
          │ 리포트 생성 완료        │
          │                        │
          │ 단계별 결과:            │
          │ 1. ✅ 테이블 스크래핑   │
          │ 2. ✅ 데이터 정제       │
          │ 3. ✅ PDF 생성         │
          │                        │
          │ 소요 시간: 8.3초        │
          └────────────────────────┘
```

#### 4. Interactive Navigation Controls

```typescript
// 우측 하단 고정 UI
<NavigationPanel>
  <StepIndicator>
    Step {currentStep} / {totalSteps}
  </StepIndicator>

  <ProgressBar value={currentStep / totalSteps} />

  <ButtonGroup>
    <Button onClick={previousStep} disabled={currentStep === 1}>
      ◀ 이전
    </Button>

    <Button onClick={approveAndExecute} variant="primary">
      승인 및 실행 ✅
    </Button>

    <Button onClick={nextStep} disabled={currentStep === totalSteps}>
      다음 ▶
    </Button>
  </ButtonGroup>

  <Button onClick={cancelTour} variant="secondary">
    투어 종료
  </Button>
</NavigationPanel>
```

---

## 종합 요약 및 구현 우선순위

### 핵심 해결책 요약

| 문제 | 솔루션 | 기술적 접근 | 구현 난이도 |
|------|--------|------------|------------|
| **#1, #8** 거리가 먼 요소 선택/이동 | • Command Palette Quick Jump<br>• Minimap (우측하단)<br>• Magic Lasso (Cmd+Shift+드래그)<br>• 북마크 시스템 (Cmd+1~9) | • 검색 인덱싱<br>• Canvas 축소뷰 렌더링<br>• Multi-select state 관리 | ⭐⭐ 중간 |
| **#2** Multi-viewport 렌더링 | • **추천**: Offscreen Rendering + Canvas Clone<br>• 대안: 하이브리드 Reference Card | • Electron paint 이벤트<br>• GPU texture 공유<br>• 60fps 동기화 최적화 | ⭐⭐⭐ 높음 |
| **#3, #4** Context 관리 | • 3-Tier Hierarchy (Active/Project/Archive)<br>• AI Orchestrator 자동 관리<br>• Expert User Panel (토큰 budget 표시) | • Vector DB (RAG)<br>• Embedding 유사도<br>• Context compression<br>• DBSCAN 클러스터링 | ⭐⭐⭐ 높음 |
| **#5** Spatial Proximity 개선 | • Viewport-first 접근<br>• Omni-directional proximity (8방향)<br>• 화면 밖 = 낮은 우선도 (0.1) | • Viewport intersection 계산<br>• 동적 relevance scoring<br>• Arrow/Cluster boost | ⭐⭐ 중간 |
| **#6** Context Feeding 전략 | • Selected = Full Content<br>• Visible = Reference Only<br>• AI Tool Calling for More | • Prompt builder<br>• Tool calling framework<br>• Content extraction | ⭐⭐ 중간 |
| **#7** AI 실행 시각화 | • Guided Tour 모드<br>• Live Progress Indicator<br>• Canvas-integrated Report<br>• Navigation Controls | • Viewport animation<br>• Speech bubble overlay<br>• Dynamic element creation<br>• Arrow workflow viz | ⭐⭐⭐ 높음 |

### 구현 우선순위 (Phase별)

#### Phase 1: Foundation (MVP) 🎯

1. **#5 Spatial Proximity Model** - Core 엔진, 모든 기능의 기반
2. **#6 Context Feeding Strategy** - AI와의 상호작용 기본
3. **#1/#8 Basic Navigation** - Minimap + Quick Jump (북마크는 Phase 2)

#### Phase 2: Context Intelligence 🧠

4. **#3 3-Tier Context Hierarchy** - 성능/비용 최적화 필수
5. **#4 Expert User Panel** - Context 관리 UI (자동 관리는 Phase 3)
6. **#1/#8 Advanced Selection** - Magic Lasso, 북마크 시스템

#### Phase 3: Advanced UX ✨

7. **#7 Workflow Visualization** - Guided Tour, Live Progress
8. **#2 Multi-viewport Rendering** - Reference Card부터 시작, Offscreen은 추후
9. **#4 AI Auto-Manage** - Context 자동 클러스터링/아카이빙

### 기술 스택 고려사항

```typescript
// 권장 라이브러리
{
  "canvas": "konva.js or fabric.js",  // 무한 캔버스
  "viewport": "react-zoom-pan-pinch",  // 확대/이동
  "vector-db": "chromadb or weaviate",  // RAG
  "embedding": "@anthropic/sdk (voyage-3)",  // Vector 생성
  "offscreen": "Electron WebContentsView",  // 브라우저 렌더링
  "animation": "framer-motion",  // Viewport transition
  "minimap": "custom canvas layer"  // 축소뷰
}
```

### 성능 최적화 포인트

1. **Viewport Culling**: 화면 밖 요소는 렌더링 skip (virtual scrolling)
2. **Context Caching**: 동일 viewport는 30초간 context 재사용
3. **Lazy Loading**: Archive context는 검색 시에만 로드
4. **Debouncing**: Pan/Zoom 중에는 proximity 계산 300ms debounce
5. **Web Worker**: Embedding, proximity 계산은 별도 스레드

---

## 최종 UX Flow 예시

### 사용자 시나리오: "세금 보고서 작성"

```
1. 캔버스 초기 상태
   [HomeTax] [Excel] [Email]  ← 사용자가 배치

2. AI 호출 (Cmd+K)
   User: "HomeTax에서 VAT 데이터 가져와서 보고서 만들어줘"

3. Context 분석 (자동)
   - Viewport: HomeTax (0.95), Excel (0.90), Email (0.85)
   - Selected: 없음
   - AI가 readElement(HomeTax) tool call

4. AI 계획 제시
   ┌─ 계획 (3단계) ──────┐
   │ 1. HomeTax 스크래핑 │
   │ 2. Excel 데이터 입력 │
   │ 3. PDF 리포트 생성   │
   │ [미리보기] [실행]    │
   └─────────────────────┘

5. Guided Tour 시작
   → HomeTax로 viewport 이동
   → Speech bubble: "이 테이블을 스크래핑합니다"
   → [◀ 이전] [승인 ✅] [다음 ▶]

6. 실행 중
   [HomeTax] ─⏳ 스크래핑 중...→ [Excel]

7. 결과 시각화
   [HomeTax] ──✅──→ [Excel] ──✅──→ [📄 VAT_Report.pdf]
                                      ↓
                             ┌─ 🎉 작업 완료 ────┐
                             │ 3단계 모두 성공    │
                             │ 8.3초 소요        │
                             └──────────────────┘
```

---

## 결론

EG-DESK의 Spatial Canvas UX는 8가지 핵심 문제를 해결함으로써 진정한 Ambient AI 워크스페이스를 구현할 수 있습니다:

1. **Navigation**: 거리와 관계없이 빠른 요소 접근
2. **Multi-viewport**: 효율적인 리소스 사용으로 동일 콘텐츠 다중 표시
3. **Context 관리**: 지능형 3-Tier 시스템으로 성능과 비용 최적화
4. **Spatial Model**: Viewport 중심의 동적 relevance 계산
5. **Context Feeding**: 명시적 선택과 암묵적 참조의 하이브리드
6. **Workflow Viz**: 캔버스 통합 시각화로 자연스러운 프로세스 이해

구현 시 Phase 1(Foundation) → Phase 2(Context Intelligence) → Phase 3(Advanced UX) 순서로 진행하여 점진적으로 사용자 경험을 향상시킬 수 있습니다.
