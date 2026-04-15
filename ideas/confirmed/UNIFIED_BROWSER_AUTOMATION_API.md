# Unified Browser Automation API
## AI 에이전트가 캔버스 위 브라우저를 직접 제어하는 통합 자동화 API

**작성일**: 2025-10-10
**최종 수정**: 2025-12-04 (제어권 핸드오프 프로토콜 및 세션 최적화 추가)
**상태**: Technical Specification
**관련 문서**:
- `EG-DESK_Whitepaper.md` - Browser Control Subsystem (Lines 176-194)
- `INFINITE_CANVAS_BROWSER_INTEGRATION.md` - WebContentsView Architecture
- `EG-DESK_Spatial_Canvas_UX_Solutions.md` - Guided Tour Visualization

---

## 개요

EG-DESK의 무한 캔버스 위에 표시되는 WebContentsView 브라우저를 **Chrome DevTools Protocol (CDP) 기반 통합 API**를 통해 AI 에이전트가 직접 제어한다. Playwright와 Puppeteer 양쪽 스타일을 모두 지원하는 단일 wrapper로, **사용자가 보는 바로 그 브라우저**를 AI가 실시간으로 조작할 수 있게 하며, Playwright ↔ AI ↔ User 간의 **seamless handoff**를 가능하게 한다.

### 핵심 가치

1. **Learning from Observation**: AI가 사용자 시연을 **같은 브라우저**에서 관찰하고 학습
2. **Smooth Transition**: 사용자 → AI → 사용자 제어 전환이 끊김없이 자연스러움
3. **Organic Profiles**: 사람과 AI가 **동일한 브라우저 인스턴스**를 공유하여 자연스러운 사용 패턴 형성
4. **Spatial Context**: 무한 캔버스의 공간적 맥락 속에서 AI가 브라우저를 제어

### 기술 선택: Unified Playwright/Puppeteer API over CDP

**왜 통합 API인가?**

| 요구사항 | Playwright | Puppeteer | Unified Wrapper | 선택 이유 |
|---------|-----------|-----------|----------------|----------|
| **Auto-waiting** | ✅ Built-in | ❌ Manual | ✅ 구현 | 안정성 30-40% 향상 |
| **Locator API** | ✅ Modern | ❌ ElementHandle | ✅ 구현 | Stale element 방지 |
| **Runtime Inside App** | ❌ External only | ✅ puppeteer-in-electron | ✅ 직접 CDP | 내부 실행 필수 |
| **Script 호환** | Playwright scripts | Puppeteer scripts | ✅ 둘 다 | 사용자 선택의 자유 |
| **Trace Viewer** | ✅ Built-in | ❌ None | ⚠️ 부분 구현 | 디버깅 효율 5-10배 |
| **CDP 접근** | ✅ CDPSession | ✅ Direct | ✅ Direct | 고급 제어 |

**구현 전략**: CDP 기반 통합 Wrapper
- Playwright API (Auto-wait, Locator, Modern selectors)
- Puppeteer API (Alias 지원 - type, $, $$ 등)
- 직접 CDP 사용 (Electron webContents.debugger)
- puppeteer-in-electron 불필요 (직접 구현이 더 깔끔)

**참고 자료 활용**:
- `references/playwright/` - Auto-wait, Locator 구현 패턴 학습
- `references/puppeteer/` - CDP 사용 패턴 학습
- `references/puppeteer-in-electron/` - Runtime integration 참고
- 기존 ElectronCDP 기본 구현 확장

---

## 기술적 가능성

### Puppeteer-Core 수준의 제어 능력

WebContentsView에 Puppeteer-core를 연결하면 **CDP 기반의 모든 고수준 API**를 사용할 수 있다:

#### ✅ 사용 가능한 Puppeteer API

| 기능 | Puppeteer API | 설명 |
|------|---------------|------|
| **페이지 네비게이션** | `page.goto(url)` | URL 이동 |
| **엘리먼트 클릭** | `page.click(selector)` | CSS 셀렉터로 클릭 |
| **텍스트 입력** | `page.type(selector, text)` | 폼 입력 |
| **키보드 조작** | `page.keyboard.press('Enter')` | 키 입력 |
| **마우스 조작** | `page.mouse.click(x, y)` | 마우스 클릭 |
| **스크린샷** | `page.screenshot()` | 화면 캡처 |
| **자동 대기** | `page.waitForSelector(selector)` | 엘리먼트 로딩 대기 |
| **네트워크 감시** | `page.on('request', handler)` | HTTP 요청 모니터링 |
| **자바스크립트 실행** | `page.evaluate(fn)` | 페이지 컨텍스트에서 코드 실행 |
| **CDP 직접 접근** | `page.target().createCDPSession()` | 원시 CDP 명령 실행 |
| **쿠키 조작** | `page.cookies()` / `page.setCookie()` | 쿠키 읽기/쓰기 |
| **로컬스토리지** | `page.evaluate(() => localStorage)` | 로컬스토리지 접근 |

#### 📊 비교: Native Electron vs Puppeteer-Core

| 작업 | Native WebContents | Puppeteer-core 연결 |
|------|-------------------|---------------------|
| 버튼 클릭 | `sendInputEvent({x, y, type: 'mouseDown'})` 좌표 계산 필요 | `page.click('#submit-button')` 자동 위치 찾기 |
| 폼 입력 | `executeJavaScript('document.querySelector(...).value = "text"')` | `page.type('input[name="email"]', 'test@example.com')` |
| 대기 | 수동으로 타이밍 조절 | `page.waitForSelector('.result')` 자동 대기 |
| Raw CDP | `webContents.debugger.sendCommand()` | `cdpSession.send()` + Puppeteer 추상화 |
| 디버깅 | 수동 로깅 | Trace, 스크린샷, 네트워크 캡처 |

---

## 제어권 핸드오프 프로토콜

### 동일 브라우저 인스턴스 내 제어권 전환

**핵심**: Playwright script ↔ AI agent ↔ User가 **같은 WebContentsView**에서 제어권을 주고받을 수 있다.

#### CDP 멀티세션 지원

```
동일 WebContentsView
    ↓
CDP Session A (Playwright, sessionId: "playwright-001")
CDP Session B (AI Agent, sessionId: "ai-agent-001")
User (CDP 불필요, 직접 DOM 조작)
    ↓
모두 같은 브라우저 제어 가능 (순차적 또는 동시)
```

#### 제어 흐름 예시

```
1. Playwright script 실행 중
   page.goto('https://bank.com')
   page.fill('#username', 'user@example.com')

2. 에러 발생 또는 AI context 필요
   → HandoffCoordinator.handoffToAI()

3. AI agent 제어 (SAME 브라우저)
   → aiApi.analyzeError()
   → aiApi.click('.retry-button')

4. 또는 User 개입 필요
   → HandoffCoordinator.handoffToUser()
   → 오버레이 표시: "Please complete 2FA"
   → User가 직접 클릭/타이핑
   → User "완료" 버튼 클릭

5. Playwright 재개 (SAME 브라우저)
   → page.click('#transfer')
   → ...continues...
```

#### 핵심 특징

**CDP 투명성**:
- ✅ `debugger.attach()` 시 **DevTools 패널 안열림**
- ✅ **새 탭 안열림**
- ✅ 화면 변화 없음 (조용히 백그라운드 연결)
- ✅ 사용자는 일반 브라우저처럼 사용

**동작 가시성**:
- ✅ AI가 click() → 버튼 클릭 애니메이션 보임
- ✅ AI가 fill() → 텍스트 타이핑 보임
- ✅ AI가 goto() → 페이지 로딩 보임
- ✅ **모든 AI 액션이 시각화됨** (투명성)

**User는 CDP 불필요**:
- WebContentsView가 이미 화면에 보임
- 직접 마우스/키보드로 조작
- CDP 세션 0개 (메모리 오버헤드 없음)

### 세션 Lifecycle 최적화

#### 권장 전략: Hybrid (Pooling)

```
┌─ ALWAYS-ON: AI Primary Session
│  - Runtime 도메인만 활성화
│  - 메모리: ~5 MB 상수
│  - 레이턴시: 0 ms (즉시 응답)
│  - 목적: 즉각적 AI 개입
│
┌─ LAZY-ATTACH: Playwright Automation Session
│  - 자동화 시작 시 attach
│  - 전체 도메인 (Network, DOM, CSS, Input, Page)
│  - 메모리: ~15-20 MB (active)
│  - 레이턴시: ~50-200ms (attach 시)
│  - 30초 idle 후 자동 detach
│
└─ NO SESSION: User
   - CDP 불필요
   - 메모리: 0 MB
   - 레이턴시: 0 ms (네이티브)
```

**메모리 예산 (WebContentsView당)**:
- Idle: ~5 MB (AI session only)
- Active 자동화: ~25-30 MB (AI + Playwright)
- 자동화 후 30초: ~5 MB로 복귀

**CDP 비용**:
- Attach: ~50-100ms (worst ~200ms)
- Detach: ~20-40ms
- 메모리/세션: ~5-15 MB (기본), ~20-30 MB (전체 도메인)

**주의사항**:
- ⚠️ Memory Leak: Idle 연결에서 도메인 활성화 상태 유지 시 메모리 누수
- ⚠️ Request Blocking: `debugger.attach()` 시 일부 요청 pending 가능 (Electron #23035)
- ⚠️ Auto-Detach: DevTools 수동으로 열면 자동 detach됨

---

## Smooth Transition 아키텍처

### 핵심 개념: WebContentsView는 영구 브라우저

**중요:** EG-DESK의 WebContentsView는 **Electron이 관리하는 영구적인 브라우저 창**입니다.
- 사용자가 평소에 사용하는 그 브라우저
- Unified API는 **필요할 때만 일시적으로 연결**해서 제어
- 연결 해제해도 **브라우저는 계속 살아있음**
- **세션, 쿠키, 로그인 상태 모두 WebContentsView에 영구 보존**

### Unified API Architecture

```typescript
// 통합 API - Playwright와 Puppeteer 스타일 모두 지원
class UnifiedBrowserAPI {
  private cdp: Electron.Debugger;

  // Playwright API
  async goto(url: string) { /* CDP */ }
  async click(selector: string) { /* Auto-wait + CDP */ }
  async fill(selector: string, text: string) { /* CDP */ }
  locator(selector: string): Locator { /* Lazy eval */ }
  getByRole(role: string, options?: any): Locator { /* ARIA */ }
  getByText(text: string): Locator { /* Text search */ }

  // Puppeteer API (Alias)
  async type(selector: string, text: string) {
    return this.fill(selector, text);  // Redirect to fill
  }
  async $(selector: string) { /* querySelector */ }
  async $$(selector: string) { /* querySelectorAll */ }

  // 공통
  async waitForSelector(selector: string) { /* Polling */ }
  async evaluate(fn: Function, ...args: any[]) { /* Runtime.evaluate */ }
  async screenshot(options: any) { /* Page.captureScreenshot */ }
}
```

### 사용자 → AI Handoff 패턴

```typescript
// 1. 앱 시작시: CDP는 Electron 내장 (debugger API)
// remote-debugging-port 불필요 - webContents.debugger 사용

// 2. 사용자가 로그인하고 작업 중...
// WebContentsView는 평범한 브라우저처럼 동작
// 세션, 쿠키 모두 WebContentsView에 저장됨
user.navigate('https://gmail.com');
user.login();  // 수동 로그인

// 3. 사용자: "AI, 여기서부터 이어서 해줘"
async function handoffToAI(webContentsView: WebContentsView) {
  // Unified API를 기존 브라우저에 연결 (일시적)
  const api = new UnifiedBrowserAPI(webContentsView.webContents.debugger);
  await api.init();

  // ✅ 세션 자동 유지 (WebContentsView에 이미 있음)
  // ✅ 로그인 상태 유지 (WebContentsView에 이미 있음)
  // ✅ 페이지 리로드 없음
  // ✅ 쿠키 그대로 (WebContentsView에 이미 있음)
  // ✅ 세션 저장/복원 불필요!

  return api;
}

// 4. AI 작업 수행 (Playwright 또는 Puppeteer script)

// Playwright script 실행
await api.click('#send-email');  // Auto-wait 적용
await api.fill('textarea', 'AI generated content');  // Playwright API

// 또는 Puppeteer script 실행
await api.type('textarea', 'AI generated content');  // Puppeteer API (alias)

// 5. AI 작업 완료 → 사용자로 복귀
await api.detach();
// ↑ CDP 연결만 해제 (브라우저는 그대로!)
// ↓ 사용자가 바로 다시 이어서 작업 가능 (세션 유지됨)
```

### 시각화

```
┌─────────────────────────────────────────┐
│         Electron Application            │
│                                         │
│  ┌──────────────┐  ┌──────────────┐   │
│  │WebContents #1│  │WebContents #2│   │
│  │   (Gmail)    │  │  (GitHub)    │   │
│  │              │  │              │   │
│  │ ✅ 로그인됨  │  │ ✅ 로그인됨  │   │
│  │ ✅ 쿠키 보존 │  │ ✅ 쿠키 보존 │   │
│  │ ✅ 세션 유지 │  │ ✅ 세션 유지 │   │
│  │              │  │              │   │
│  │ 사용자가     │  │              │   │
│  │ 평소에 쓰는  │  │              │   │
│  │ 브라우저     │  │              │   │
│  └──────┬───────┘  └──────┬───────┘   │
│         │                  │           │
└─────────┼──────────────────┼───────────┘
          │                  │
          │ CDP 연결 (일시적)│ CDP 연결 (일시적)
          │ connect()        │ connect()
          │ disconnect()     │ disconnect()
          ▼                  ▼
    ┌─────────────────────────────┐
    │    Puppeteer Connection     │
    │   (필요할 때만 생성/해제)    │
    └─────────────────────────────┘
```

**핵심:**
- `connect()` = AI가 제어 시작 (브라우저는 그대로)
- `disconnect()` = AI가 제어 해제 (브라우저는 그대로)
- WebContentsView = 영구적 (Electron이 관리)
- Puppeteer 연결 = 일시적 (필요할 때만)

### 핵심: Unified API Architecture

```typescript
// Unified API - Playwright와 Puppeteer 스타일 모두 지원
const api = new UnifiedBrowserAPI(webContents.debugger);

// Playwright-style (권장)
await api.goto('https://example.com');
await api.click('#submit');  // Auto-wait 적용
await api.fill('#input', 'text');  // Playwright API
const locator = api.locator('#dynamic-element');  // Locator (lazy eval)
await locator.click();

// Puppeteer-style (호환)
await api.type('#input', 'text');  // type → fill로 redirect
const element = await api.$('#submit');  // querySelector

// Raw CDP (고급 제어)
await api.sendCDPCommand('Network.setUserAgentOverride', {
  userAgent: 'Custom-Agent'
});
```

**3-Layer 구현:**
```typescript
class UnifiedBrowserAPI {
  // Layer 1: CDP Core (Electron webContents.debugger)
  private async _cdp_sendCommand(method: string, params?: any) {
    return await this.debugger.sendCommand(method, params);
  }

  // Layer 2: Playwright-compatible API
  async click(selector: string) {
    await this.waitForActionable(selector);  // Auto-wait
    const coords = await this._cdp_getCoords(selector);
    await this._cdp_dispatchClick(coords);
  }

  // Layer 3: Puppeteer-compatible API (Alias)
  async type(selector: string, text: string) {
    return this.fill(selector, text);  // Redirect to Playwright fill
  }
}
```

---

## 시스템 구조

```
┌─────────────────────────────────────────────────────────┐
│                    EG-DESK Application                   │
├─────────────────────────────────────────────────────────┤
│                                                           │
│  ┌─────────────────────────────────────────────────┐   │
│  │       Infinite Canvas (Spatial UI)              │   │
│  │                                                   │   │
│  │  ┌──────────────┐  ┌──────────────┐            │   │
│  │  │ WebContents  │  │ WebContents  │  ...       │   │
│  │  │   View #1    │  │   View #2    │            │   │
│  │  │              │  │              │            │   │
│  │  │ example.com  │  │ github.com   │            │   │
│  │  │ [USER 제어]  │  │ [AI 제어]    │            │   │
│  │  └──────┬───────┘  └──────┬───────┘            │   │
│  │         │                  │                     │   │
│  └─────────┼──────────────────┼─────────────────────┘   │
│            │                  │                          │
│            │ CDP Protocol     │ CDP Protocol             │
│            │ (ws://...)       │ (ws://...)               │
└────────────┼──────────────────┼──────────────────────────┘
             │                  │
             │                  ▼
             │         ┌────────────────────────┐
             │         │ Puppeteer Connection   │
             │         │  (Runtime Attach)      │
             │         └──────────┬─────────────┘
             │                    │
             ▼                    ▼
    ┌────────────────────────────────────────┐
    │   CDP Bridge Service                   │
    │   (packages/browser-control)           │
    ├────────────────────────────────────────┤
    │                                         │
    │  • CDP Connection Manager              │
    │  • Target ID ↔ WebContentsView Mapper  │
    │  • Puppeteer Page Factory              │
    │  • Visual Feedback Overlay             │
    │  • Session Preservation Logic          │
    │                                         │
    └────────────────┬───────────────────────┘
                     │
                     ▼
         ┌───────────────────────┐
         │   AI Agent System     │
         │                       │
         │  • Workflow Executor  │
         │  • Action Recorder    │
         │  • Vision Interpreter │
         └───────────────────────┘
```

### Theia의 하이브리드 패턴 (참고)

Theia는 **Puppeteer + Playwright MCP** 조합 사용:
- **Puppeteer**: 브라우저 lifecycle 관리 (`launch`, `close`)
- **Playwright MCP**: AI 자동화 수행
- **통합점**: 둘 다 CDP로 같은 브라우저 제어

EG-DESK 적용:
- **Puppeteer-core**: 주력 (WebContentsView 제어)
- **Playwright**: 참고 자료 (API 디자인 학습)

---

## 핵심 컴포넌트

### 1. CDP Connection Manager

```typescript
// File: packages/browser-control/src/electron-main/cdp-connection-manager.ts

import { app, WebContentsView } from 'electron';
import puppeteer from 'puppeteer-core';
import type { Browser, Page } from 'puppeteer-core';

export class CDPConnectionManager {
  private debugPort = 9222;
  private connections = new Map<string, Page>();
  private browser?: Browser;

  initialize() {
    // Electron 시작시 remote debugging 활성화
    app.commandLine.appendSwitch('remote-debugging-port', String(this.debugPort));
    console.log(`CDP debugging enabled on port ${this.debugPort}`);
  }

  async getTargetId(view: WebContentsView): Promise<string> {
    const webContents = view.webContents;

    try {
      // Runtime에 debugger 연결해서 target ID 획득
      await webContents.debugger.attach('1.3');
      const { targetInfo } = await webContents.debugger.sendCommand('Target.getTargetInfo');
      await webContents.debugger.detach();

      return targetInfo.targetId;
    } catch (error) {
      console.error('Failed to get target ID:', error);
      throw error;
    }
  }

  async connectPuppeteer(view: WebContentsView): Promise<Page> {
    const targetId = await this.getTargetId(view);

    // 이미 연결되어 있으면 재사용
    if (this.connections.has(targetId)) {
      return this.connections.get(targetId)!;
    }

    // Puppeteer를 Electron에 연결 (기존 브라우저)
    if (!this.browser) {
      this.browser = await puppeteer.connect({
        browserWSEndpoint: `ws://localhost:${this.debugPort}`,
        defaultViewport: null  // 현재 뷰포트 유지
      });
    }

    // Target ID로 해당 페이지 찾기
    const pages = await this.browser.pages();
    for (const page of pages) {
      const target = page.target();
      const targetInfo = await target._targetInfo();

      if (targetInfo.targetId === targetId) {
        console.log(`Puppeteer connected to WebContentsView (${targetId})`);
        this.connections.set(targetId, page);
        return page;
      }
    }

    throw new Error(`Could not find page for target ID: ${targetId}`);
  }

  async disconnect(view: WebContentsView) {
    const targetId = await this.getTargetId(view);
    this.connections.delete(targetId);
    console.log(`Puppeteer disconnected from ${targetId}`);

    // 중요: 연결만 해제, WebContentsView는 그대로!
    // ✅ 브라우저 창 살아있음 (사용자가 계속 사용 가능)
    // ✅ 세션, 쿠키 모두 보존됨
    // ✅ 로그인 상태 유지됨
    // ✅ 세션 저장/복원 불필요!
  }

  async cleanup() {
    if (this.browser) {
      await this.browser.disconnect();
      this.browser = undefined;
    }
    this.connections.clear();
  }

  getActiveConnections() {
    return this.connections;
  }
}
```

### 2. Visual Feedback System

```typescript
// File: packages/browser-control/src/browser/visual-feedback.ts

import type { Page } from 'puppeteer-core';

export class VisualFeedbackSystem {
  constructor(private page: Page) {}

  async highlightElement(selector: string, duration: number = 1000) {
    await this.page.evaluate(
      ({ sel, dur }) => {
        const element = document.querySelector(sel);
        if (!element) return;

        const originalOutline = (element as HTMLElement).style.outline;
        const originalBoxShadow = (element as HTMLElement).style.boxShadow;

        // 하이라이트 효과
        (element as HTMLElement).style.outline = '3px solid #FF6B6B';
        (element as HTMLElement).style.boxShadow = '0 0 10px 3px rgba(255, 107, 107, 0.5)';
        (element as HTMLElement).style.transition = 'all 0.3s ease';

        setTimeout(() => {
          (element as HTMLElement).style.outline = originalOutline;
          (element as HTMLElement).style.boxShadow = originalBoxShadow;
        }, dur);
      },
      { sel: selector, dur: duration }
    );
  }

  async showClickAnimation(x: number, y: number) {
    await this.page.evaluate(
      ({ px, py }) => {
        const ripple = document.createElement('div');
        ripple.style.cssText = `
          position: fixed;
          left: ${px - 20}px;
          top: ${py - 20}px;
          width: 40px;
          height: 40px;
          border-radius: 50%;
          background: rgba(255, 107, 107, 0.3);
          border: 2px solid #FF6B6B;
          pointer-events: none;
          z-index: 999999;
          animation: ripple-animation 0.6s ease-out;
        `;

        const style = document.createElement('style');
        style.textContent = \`
          @keyframes ripple-animation {
            to {
              transform: scale(2);
              opacity: 0;
            }
          }
        \`;

        document.head.appendChild(style);
        document.body.appendChild(ripple);

        setTimeout(() => {
          ripple.remove();
          style.remove();
        }, 600);
      },
      { px: x, py: y }
    );
  }

  setFeedbackMode(mode: 'demonstration' | 'guided' | 'execution') {
    switch(mode) {
      case 'demonstration':
        this.feedbackIntensity = 0.3;  // 최소 피드백
        break;
      case 'guided':
        this.feedbackIntensity = 1.0;  // 최대 피드백
        break;
      case 'execution':
        this.feedbackIntensity = 0.1;  // 진행상황만
        break;
    }
  }

  private feedbackIntensity = 1.0;
}
```

### 3. AI Browser Control API

```typescript
// File: packages/browser-control/src/common/ai-control-api.ts

import type { Page } from 'puppeteer-core';
import { VisualFeedbackSystem } from '../browser/visual-feedback';

export interface WorkflowStep {
  type: 'navigate' | 'click' | 'type' | 'select' | 'wait';
  selector?: string;
  value?: string;
  url?: string;
  description: string;
  timestamp?: number;
}

export interface WorkflowScript {
  name: string;
  steps: WorkflowStep[];
  createdAt: Date;
}

export class AIBrowserControl {
  private page: Page;
  private feedback: VisualFeedbackSystem;
  private recording: WorkflowStep[] = [];
  private isRecording = false;

  constructor(page: Page) {
    this.page = page;
    this.feedback = new VisualFeedbackSystem(page);
  }

  // === 기본 제어 ===

  async navigate(url: string) {
    await this.page.goto(url, { waitUntil: 'domcontentloaded' });
  }

  async click(selector: string, options?: { visualize?: boolean; speed?: number }) {
    if (options?.visualize) {
      await this.feedback.highlightElement(selector, 500);

      const element = await this.page.$(selector);
      if (element) {
        const box = await element.boundingBox();
        if (box) {
          await this.feedback.showClickAnimation(
            box.x + box.width / 2,
            box.y + box.height / 2
          );
        }
      }
    }

    await this.page.click(selector);

    if (options?.speed && options.speed < 1) {
      await this.page.waitForTimeout(1000 * (1 - options.speed));
    }
  }

  async type(selector: string, text: string, options?: { speed?: number; visualize?: boolean }) {
    if (options?.visualize) {
      await this.feedback.highlightElement(selector);
    }

    const delay = options?.speed ? 100 / options.speed : 50;
    await this.page.type(selector, text, { delay });
  }

  // === Raw CDP 접근 (고급 기능용) ===

  async executeRawCDP(method: string, params?: any) {
    const cdpSession = await this.page.target().createCDPSession();
    const result = await cdpSession.send(method as any, params);
    await cdpSession.detach();
    return result;
  }

  // === 학습 모드 ===

  async startRecording() {
    this.isRecording = true;
    this.recording = [];

    await this.page.exposeFunction('__egdesk_recordAction', (action: WorkflowStep) => {
      if (this.isRecording) {
        this.recording.push(action);
      }
    });

    // 페이지에 이벤트 리스너 주입
    await this.page.evaluate(() => {
      document.addEventListener('click', (e) => {
        const target = e.target as HTMLElement;
        const selector = getSelector(target);
        (window as any).__egdesk_recordAction({
          type: 'click',
          selector,
          description: `Click on ${selector}`,
          timestamp: Date.now()
        });
      });

      document.addEventListener('input', (e) => {
        const target = e.target as HTMLInputElement;
        const selector = getSelector(target);
        (window as any).__egdesk_recordAction({
          type: 'type',
          selector,
          value: target.value,
          description: `Type "${target.value}" into ${selector}`,
          timestamp: Date.now()
        });
      });

      function getSelector(el: HTMLElement): string {
        if (el.id) return `#${el.id}`;
        if (el.className) return `.${el.className.split(' ')[0]}`;
        return el.tagName.toLowerCase();
      }
    });

    console.log('Recording started');
  }

  async stopRecording(): Promise<WorkflowScript> {
    this.isRecording = false;

    const workflow: WorkflowScript = {
      name: `Workflow_${Date.now()}`,
      steps: this.recording,
      createdAt: new Date()
    };

    console.log(`Recording stopped. Captured ${this.recording.length} steps`);
    return workflow;
  }

  // === 워크플로우 실행 ===

  async executeWorkflow(
    script: WorkflowScript,
    mode: 'demonstration' | 'guided' | 'execution',
    variables?: Record<string, string>
  ) {
    this.feedback.setFeedbackMode(mode);

    for (const step of script.steps) {
      const processedStep = this.replaceVariables(step, variables);

      switch (step.type) {
        case 'navigate':
          await this.navigate(processedStep.url!);
          break;

        case 'click':
          await this.click(processedStep.selector!, {
            visualize: mode === 'guided',
            speed: mode === 'guided' ? 0.5 : 1
          });
          break;

        case 'type':
          await this.type(processedStep.selector!, processedStep.value!, {
            visualize: mode === 'guided',
            speed: mode === 'guided' ? 0.5 : 1
          });
          break;

        case 'wait':
          await this.page.waitForSelector(processedStep.selector!);
          break;
      }

      if (mode === 'guided') {
        await this.page.waitForTimeout(1000);
      }
    }
  }

  private replaceVariables(step: WorkflowStep, variables?: Record<string, string>): WorkflowStep {
    if (!variables) return step;

    const replaced = { ...step };

    if (replaced.value) {
      Object.entries(variables).forEach(([key, value]) => {
        replaced.value = replaced.value!.replace(`{{${key}}}`, value);
      });
    }

    if (replaced.url) {
      Object.entries(variables).forEach(([key, value]) => {
        replaced.url = replaced.url!.replace(`{{${key}}}`, value);
      });
    }

    return replaced;
  }
}
```

---

## 사용 시나리오

### 시나리오 1: Smooth User → AI Handoff

**상황**: 사용자가 Gmail에서 이메일 작성 중, AI에게 나머지 작업 위임

```typescript
// 1. 사용자가 Gmail 로그인하고 이메일 작성 시작
// (캔버스 위 WebContentsView에서 자유롭게 작업)

// 2. 사용자: "AI, 나머지 받는 사람들한테도 같은 내용으로 보내줘"
const cdpManager = new CDPConnectionManager();
const page = await cdpManager.connectPuppeteer(gmailWebContentsView);

// ✅ 로그인 세션 유지
// ✅ 작성 중이던 이메일 그대로
// ✅ 페이지 리로드 없음

const aiControl = new AIBrowserControl(page);

// 3. AI가 작업 수행
const recipients = ['user1@example.com', 'user2@example.com', 'user3@example.com'];

for (const email of recipients) {
  await aiControl.click('[aria-label="새 메일"]');
  await aiControl.type('[aria-label="받는사람"]', email);
  await aiControl.type('[aria-label="제목"]', '안내 메일');
  await aiControl.type('[aria-label="메일 본문"]', '사전 작성된 내용...');
  await aiControl.click('[aria-label="보내기"]');
  await page.waitForTimeout(1000);
}

// 4. AI 작업 완료
await cdpManager.disconnect(gmailWebContentsView);

// 5. 사용자가 바로 다시 Gmail 사용 가능
// → 로그인 유지, 세션 유지, 끊김 없음
```

### 시나리오 2: AI 학습 (Learning from Observation)

**상황**: 사용자가 복잡한 작업을 시연하면 AI가 학습

```typescript
// 사용자: "AI, 내가 하는 거 봐봐. 다음번엔 네가 해줘"
const page = await cdpManager.connectPuppeteer(webContentsView);
const aiControl = new AIBrowserControl(page);

await aiControl.startRecording();

// 사용자가 작업 수행:
// 1. GitHub 로그인
// 2. New Repository 클릭
// 3. 이름 입력
// 4. README 체크
// 5. Create 클릭

const workflow = await aiControl.stopRecording();

// AI: "배웠습니다! 7단계 워크플로우로 저장했어요."
// 워크플로우 저장
await saveWorkflow(workflow, 'create-github-repo');

// 나중에 사용자: "AI, 아까 배운 거 5번 반복해줘"
for (let i = 0; i < 5; i++) {
  await aiControl.executeWorkflow(workflow, 'execution', {
    repoName: `project-${i + 1}`
  });
}
```

### 시나리오 3: Guided Tour (AI가 시연)

**상황**: AI가 작업 방법을 사용자에게 천천히 보여줌

```typescript
// 사용자: "AI, 이 작업 어떻게 할 건지 보여줘"
const page = await cdpManager.connectPuppeteer(webContentsView);
const aiControl = new AIBrowserControl(page);

await aiControl.executeWorkflow(savedWorkflow, 'guided');

// AI 실행 (내부):
// - 각 단계 전에 하이라이트 표시
// - 클릭 애니메이션
// - 느린 타이핑 (사용자가 볼 수 있게)
// - 단계 사이 1초 대기

// 사용자가 AI의 모든 행동을 실시간으로 관찰
// → 신뢰 구축, 학습 기회
```

### 시나리오 4: Vision + Browser Control

**상황**: AI가 화면을 보고 동적으로 판단

```typescript
const page = await cdpManager.connectPuppeteer(webContentsView);
const aiControl = new AIBrowserControl(page);

// AI: 화면 캡처
const screenshot = await page.screenshot({ encoding: 'base64' });

// AI Vision: 버튼 위치 파악
const visionResult = await aiVision.analyze(screenshot, {
  prompt: "Find the 'Submit' button and return its bounding box"
});

if (visionResult.found) {
  const { x, y, width, height } = visionResult.boundingBox;
  await page.mouse.click(x + width / 2, y + height / 2);
}
```

---

## 보안 고려사항

### Remote Debugging 보안

```typescript
// 조건부 활성화
if (process.env.NODE_ENV === 'development' || process.env.ENABLE_AI_CONTROL === 'true') {
  app.commandLine.appendSwitch('remote-debugging-port', '9222');
}

// 로컬호스트만 허용 (기본값)
// 외부 네트워크 노출 절대 금지
```

### Context Isolation 유지

```typescript
const view = new WebContentsView({
  webPreferences: {
    contextIsolation: true,
    nodeIntegration: false,
    sandbox: true
  }
});
```

### 인증 정보 보호

```typescript
// 워크플로우에 비밀번호 저장 금지
const workflow = {
  steps: [{
    type: 'type',
    selector: '#password',
    value: '{{PASSWORD}}'  // 변수 사용
  }]
};

// 실행시 안전하게 주입
await aiControl.executeWorkflow(workflow, 'execution', {
  PASSWORD: await secureStorage.get('user.password')
});
```

---

## 구현 로드맵

### Phase 1: Core CDP Wrapper (1주, 기본 구현 이미 존재)
- [ ] ElectronCDP 기본 클래스 (goto, click, fill, wait - 이미 작성됨)
- [ ] Electron webContents.debugger 연결
- [ ] 기본 CDP 명령 (Page, Runtime, Input domains)
- [ ] 기본 테스트

### Phase 2: Playwright API - Auto-Wait (3-5일)
- [ ] waitForActionable() 구현 (injectedScript.ts 참고)
- [ ] Actionability checks (visible, stable, enabled, not obscured)
- [ ] Polling mechanism with requestAnimationFrame
- [ ] Timeout 및 에러 처리

### Phase 3: Playwright API - Locator (2-3일)
- [ ] Locator 클래스 구현 (lazy evaluation)
- [ ] Strict mode (multiple match detection)
- [ ] Locator chaining
- [ ] Auto-retry on action

### Phase 4: Advanced Selectors (2-3일)
- [ ] getByRole() - ARIA role selector
- [ ] getByText() - Text content selector
- [ ] getByTestId() - Data-testid selector
- [ ] getByLabel() - Label association
- [ ] Selector combinations

### Phase 5: Puppeteer Compatibility (1일)
- [ ] type() → fill() alias
- [ ] $() querySelector alias
- [ ] $$() querySelectorAll alias
- [ ] API compatibility layer

### Phase 6: Visual Feedback (1주)
- [ ] Element Highlight
- [ ] Click Animation
- [ ] Feedback 모드별 강도 조절

### Phase 7: Script Execution Engine (2-3일)
- [ ] Playwright script 실행
- [ ] Puppeteer script 실행
- [ ] Flow JSON 실행
- [ ] Cloud-downloaded script 지원

### Phase 8: Recording & Workflow (1-2주)
- [ ] Recording 시스템
- [ ] Workflow 저장/불러오기
- [ ] Variable substitution
- [ ] Workflow validation

### Phase 9: Multi-Browser Management (1주)
- [ ] 여러 WebContentsView 동시 제어
- [ ] Session lifecycle 관리
- [ ] Resource cleanup

### Phase 10: Advanced Features (선택사항, 2-3주)
- [ ] Network Interception (Fetch domain)
- [ ] Trace-like logging
- [ ] Performance monitoring
- [ ] Error recovery

**Total Estimated Effort**:
- Core (Phase 1-5): **2-3주** (Playwright + Puppeteer 호환)
- Full Featured: **6-10주** (모든 고급 기능)

---

## 성능 최적화 & 메모리 관리

### 1. 메모리 누수 방지 (중요!)

**Puppeteer의 주요 메모리 누수 원인:**
- 이벤트 핸들러 누적 (가장 큰 원인)
- CDP 연결 장시간 유지
- Chrome 프로세스 좀비화

**EG-DESK 해결책: WebContentsView 특성 활용**

```typescript
class BrowserController {
  private eventHandlers = new Map<string, Function>();

  async connect(view: WebContentsView) {
    const page = await cdpManager.connectPuppeteer(view);

    // 이벤트 핸들러 한번만 등록
    const requestHandler = (req) => console.log(req.url());
    page.on('request', requestHandler);
    this.eventHandlers.set('request', requestHandler);

    return page;
  }

  async disconnect(view: WebContentsView) {
    const page = this.connections.get(targetId);

    // 모든 핸들러 명시적 제거
    for (const [event, handler] of this.eventHandlers) {
      page.off(event, handler);
    }
    this.eventHandlers.clear();

    // CDP 연결만 해제 (WebContentsView는 유지!)
    await cdpManager.disconnect(view);
    // ✅ 세션 저장/복원 불필요 (WebContentsView에 보존됨)
  }
}
```

### 2. 주기적 메모리 정리

```typescript
// 30분마다 CDP 연결 재설정 (간단!)
setInterval(async () => {
  console.log('Cleaning up CDP connections...');

  for (const view of activeViews) {
    // 연결만 끊고 재연결
    await browserController.disconnect(view);
    // WebContentsView는 그대로 살아있음!
    // 세션, 쿠키 모두 보존됨!
  }

  console.log('Memory cleaned. Sessions preserved.');
}, 30 * 60 * 1000);
```

### 3. 메모리 모니터링 (가벼움)

```typescript
// 백그라운드 모니터링 (오버헤드 <0.5ms)
setInterval(() => {
  const heapMB = process.memoryUsage().heapUsed / 1024 / 1024;

  if (heapMB > 500) {
    console.warn(`High memory: ${heapMB.toFixed(0)}MB`);
    triggerMemoryCleanup(); // 자동 정리
  }
}, 5 * 60 * 1000); // 5분마다

// 오버헤드: 0.5ms / 300,000ms = 0.00017% (무시 가능)
```

### 4. AI 히스토리 보존 (자동)

```typescript
// AI 작업 히스토리는 애플리케이션 레벨에 저장
class AIWorkflowHistory {
  private actions: WorkflowAction[] = [];

  async recordAction(action: WorkflowAction) {
    this.actions.push(action);
    await db.save('workflow_history', action); // DB에 영구 저장
  }
}

// CDP 재연결해도 히스토리는 그대로!
await browserController.disconnect(view); // 메모리 정리
await browserController.connect(view);    // 재연결

// ✅ AI는 여전히 이전 작업 기억함 (DB에 저장됨)
// ✅ 브라우저 세션도 유지됨 (WebContentsView에 보존됨)
// ✅ 사용자: "AI, 너가 아까 만든 repo 삭제해줘" → 동작함!
```

### 5. 연결 재사용 (선택사항)

```typescript
// 같은 view에 대한 중복 연결 방지
const connectionCache = new Map<string, Page>();

async function getOrCreateConnection(view: WebContentsView): Promise<Page> {
  const targetId = await getTargetId(view);

  if (connectionCache.has(targetId)) {
    return connectionCache.get(targetId)!; // 재사용
  }

  const page = await connectPuppeteer(view);
  connectionCache.set(targetId, page);
  return page;
}
```

### 6. Theia 패턴 참고 (DOM Size Limiting)

```typescript
// Theia에서 학습한 패턴
const MAX_DOM_LENGTH = 50000;

async function queryDOM(selector?: string): Promise<string> {
  const content = selector
    ? await page.$eval(selector, el => el.outerHTML)
    : await page.content();

  if (content.length > MAX_DOM_LENGTH) {
    return 'DOM too large. Please provide more specific selector.';
  }

  return content;
}
```

### 성능 우선순위

```
중요도 순서:

1. 🔴 이벤트 핸들러 정리 (메모리 누수 방지)
   → 명시적으로 off() 호출

2. 🟠 주기적 CDP 재연결 (30분마다)
   → WebContentsView는 유지됨

3. 🟡 메모리 모니터링 (5분마다)
   → 오버헤드 무시 가능

4. 🟢 Anti-detection 오버헤드
   → navigator.webdriver: <15ms
   → 체감 불가
```

---

## 결론

**Unified Playwright/Puppeteer API over CDP**는 EG-DESK의 핵심 비전인 **"AI가 사용자와 같은 인터페이스에서 seamless하게 협업한다"**를 실현하는 최적의 기술 스택이다.

### 핵심 가치 재확인

1. **Smooth Transition**: 사용자 → AI → 사용자 전환이 끊김없음
2. **투명성**: AI의 모든 행동을 실시간으로 시각화
3. **신뢰성**: 같은 브라우저, 같은 세션, 같은 UI
4. **학습성**: 사용자 시연을 관찰하고 재현
5. **유연성**: Playwright/Puppeteer script 모두 실행 가능

### 기술적 우위

**Playwright Features**:
- ✅ Auto-wait → 안정성 30-40% 향상
- ✅ Locator API → Stale element 방지
- ✅ Modern selectors → 가독성, 유지보수성

**Puppeteer Compatibility**:
- ✅ 기존 Puppeteer script 실행
- ✅ 커뮤니티 예제 활용
- ✅ 점진적 마이그레이션

**Direct CDP Access**:
- ✅ Electron 내장 (외부 의존성 없음)
- ✅ Full control (고급 기능)
- ✅ 가벼움 (puppeteer-in-electron 불필요)

### 참고 자료

- **Playwright**: `references/playwright/playwright/` (Auto-wait, Locator 구현 패턴)
  - `packages/playwright-core/src/server/injected/injectedScript.ts` (Auto-wait 핵심)
  - `packages/playwright-core/src/server/electron/electron.ts` (Electron 연결)
- **Puppeteer**: `references/puppeteer/puppeteer/` (CDP 사용 패턴)
- **puppeteer-in-electron**: `references/puppeteer-in-electron/` (Runtime integration 참고)
- **Electron-Playwright**: `references/electron-playwright-integration/` (통합 패턴)
- **기본 구현**: `subagent_reports/20251202_2200_playwright-to-cdp-conversion-research.md` (ElectronCDP 시작점)
- **Feature Gap**: `subagent_reports/20251202_2230_playwright-puppeteer-feature-gap-research.md` (왜 Playwright인가)

### 구현 전략

1. **기본 ElectronCDP 확장** (이미 존재하는 코드 활용)
2. **Playwright 소스 참고** (injectedScript.ts의 auto-wait 패턴)
3. **Puppeteer alias 추가** (type, $, $$ 등)
4. **점진적 구현** (Core → Advanced features)

이 문서는 **Playwright와 Puppeteer 양쪽 생태계의 장점을 결합**하여 EG-DESK에 최적화된 통합 자동화 API를 구축하는 계획이다.
