# APP_RUNTIME_ARCHITECTURE

사용자가 웹서버 코드를 다운받아 EG-DESK 안에서 앱처럼 실행하는 UX 구현 전략.
사용자 정의 앱 포함.

---

## 핵심 구조

```
EG-DESK (Electron)
  ├─ UI Layer: Electron (Chromium) - 렌더링 전용
  ├─ User App Layer: Node.js/WASM - 사용자 앱 실행
  └─ System Layer: Rust (선택) - 고성능 시스템 기능
```

---

## 앱 매니페스트 (egdesk.json)

```json
{
  "name": "My App",
  "version": "1.0.0",
  "runtime": {
    "type": "node",
    "version": ">=18 <22"
  },
  "install": "npm install",
  "start": "npm run start",
  "port": 3001,
  "icon": "./icon.png",
  "window": {
    "width": 800,
    "height": 600
  }
}
```

- EG-DESK가 `egdesk.json` 감지 → 설치 → 실행 → WebContentsView로 렌더링
- 기존 사례: Deta Surf의 Surflet (`surflet.yaml`), Docker (`docker-compose.yml`), VS Code (`devcontainer.json`)

---

## 앱 실행 전략 (단계적)

### Phase 1: Node.js (즉시 가능)

- Electron 내장 Node.js 활용 → 추가 설치 0
- `child_process.spawn`으로 앱 실행
- 앱별 디렉토리 격리: `~/egdesk/apps/{app-name}/`
- WebContentsView로 `localhost:{port}` 렌더링

**장점:**
- ✅ 완전한 Node.js 생태계 지원
- ✅ native addon 완벽 작동
- ✅ npm 전체 패키지 사용 가능
- ✅ 실제 네트워크 포트 리스닝

**단점:**
- ⚠️ Electron 업데이트 시 Node.js 버전 변경 → 앱 호환성 문제
- ⚠️ 보안 격리 약함 (OS 프로세스 격리만)

### Phase 2: WASM 런타임 (독립 서버 인스턴스급)

**핵심 발견 (2026)**: WASM + File System Access API = 사실상 독립된 서버 인스턴스가 브라우저에서 실행

#### 2가지 실행 환경

**Phase 2A: Browser WASM (Chromium 내장)**
- Isolated Web Apps (IWA) + Direct Sockets API
- localhost TCP server 실행 가능 (127.0.0.1:PORT)
- Zero-install, 크로스 플랫폼 (Chrome/Edge)
- 제약: 브라우저 닫으면 종료, 0.0.0.0 바인딩 불가

**Phase 2B: Electron WASM (Wasmtime/Wasmer)**
- Main process에서 WASM runtime 직접 실행
- 완전한 네트워크 능력 (0.0.0.0 바인딩 가능)
- Persistent daemon (OS 종료까지)
- Native 성능, 제약 거의 없음

#### 실제 가능한 것들

```
브라우저 (Chromium) 내부에서:
├─ Node.js/Python/PHP/Ruby 서버 완전 실행
├─ 다중 런타임 동시 실행 (npm + Pyodide 같은 페이지)
├─ localhost TCP server (IWA Direct Sockets)
├─ 로컬 파일시스템 투명 접근 (/Users/me/Documents → /workspace)
├─ SQLite 데이터베이스
├─ CPU 계산 (네이티브 ~90% 성능)
├─ npm/pip 패키지 관리 (micropip, WebContainers)
├─ 가상 네트워킹 (브라우저 내부) + Private 양방향 통신
└─ WebContentsView로 렌더링

Electron Main Process에서:
├─ Wasmtime/Wasmer WASM runtime
├─ 완전한 네트워크 (0.0.0.0:PORT 바인딩)
├─ IPC로 Renderer와 통신
├─ Persistent background server
├─ Full file system access
└─ Near-native performance
```

#### 다중 WASM 런타임 동시 실행 (2026)

**핵심 발견**: npm(Node.js)와 Pyodide(Python)를 같은 브라우저 페이지/탭에서 동시 실행 가능!

```
브라우저 페이지 내부:
├─ WASM Instance 1: Node.js (WebContainers)
│  └─ 독립 메모리 공간, npm 패키지
│           ↕ JavaScript Bridge (2-3% 오버헤드)
├─ WASM Instance 2: Pyodide (Python)
│  └─ 독립 메모리 공간, pip 패키지
└─ JavaScript Orchestration Layer
   └─ 두 런타임 간 데이터 전달 (JSON serialization)
```

**실용적 패턴**:
```javascript
// 같은 페이지에서 npm + Pyodide 동시 실행
import { loadPyodide } from 'pyodide';
import { WebContainer } from '@webcontainer/api';

// 두 런타임 병렬 로드
const [pyodide, webcontainer] = await Promise.all([
  loadPyodide(),
  WebContainer.boot()
]);

// Python에서 데이터 분석
const pyResult = await pyodide.runPythonAsync(`
import pandas as pd
df = pd.read_csv('/data.csv')
df['processed'] = df['value'] * 2
df.to_json()
`);

// 결과를 Node.js로 전달
await webcontainer.fs.writeFile('/output.json', pyResult);
await webcontainer.spawn('node', ['process.js']);
```

**성능 특성**:
- **메모리**: Pyodide (~30-50MB) + WebContainers (~20-40MB) = 50-90MB
- **시작 시간**: Parallel load 1-3초 (sequential 1.5-5초)
- **통신 오버헤드**: 2-3% (WasmGC), 15× faster serialization (2026 최적화)
- **JSPI (2026)**: Chrome 137+, Firefox 139+에서 async 통신 개선

**프로덕션 사례**: StackBlitz WebContainers (Node.js + Python experimental support)

#### 네트워크 독립성 (OS급 Spinoff)

**Phase 2A: Browser IWA + Direct Sockets API**

Chrome의 Isolated Web Apps는 **실제 TCP/UDP 서버** 실행 가능:

```javascript
// Browser 안에서 localhost TCP server!
const server = new TCPServerSocket("127.0.0.1", 8080);
const { readable, writable } = await server.opened;

// Incoming connections 받기
for await (const connection of readable) {
  handleConnection(connection);
}
```

**가능한 것**:
- ✅ localhost 바인딩 (127.0.0.1:PORT)
- ✅ Private 양방향 통신 (window ↔ WASM server)
- ✅ WebSocket server 직접 구현
- ✅ LAN 접근 (권한 필요)
- ✅ Shared Worker로 cross-tab 통신

**제약**:
- ❌ 0.0.0.0 바인딩 불가 (보안 정책)
- ⚠️ 브라우저 닫으면 종료 (완전 persistent 아님)
- ⚠️ IWA 설치 필요 (일반 웹페이지 불가)
- ⚠️ Chrome/Chromium only (2026)

**Phase 2B: Electron + Wasmtime/Wasmer**

Electron main process에서 WASM runtime 직접 실행 → **완전한 네트워크 능력**:

```javascript
// Main Process (Node.js)
const { Wasmtime } = require('@bytecodealliance/wasmtime');
const http = require('http');

// WASM backend 로드
const engine = new Wasmtime.Engine();
const module = Wasmtime.Module.fromFile(engine, 'backend.wasm');
const instance = module.instantiate();

// ✅ 0.0.0.0 바인딩 가능 (LAN/WAN)
const server = http.createServer((req, res) => {
  const result = instance.exports.handleRequest(req.url, req.body);
  res.end(result);
});

server.listen(3000, '0.0.0.0'); // 모든 인터페이스
```

**가능한 것**:
- ✅ 0.0.0.0 바인딩 (방화벽 허용 시)
- ✅ Persistent daemon (OS 종료까지)
- ✅ WASI Preview3 sockets (2026년 2월)
- ✅ IPC로 Renderer와 통신
- ✅ Worker threads로 멀티코어 활용
- ✅ Convex backend self-host 가능 (Rust WASM)

**아키텍처**:
```
Electron App
├─ Main Process (Node.js)
│  ├─ Wasmtime Engine
│  │  └─ Backend.wasm (Convex-like)
│  └─ HTTP Server (0.0.0.0:3000)
└─ Renderer (Chromium)
   └─ React UI → localhost:3000
```

**실제 사례**:
- VS Code: `@vscode/wasm-wasi-lsp` (WASM language servers)
- Docker Desktop: Electron frontend + backend services

#### 프로덕션 사례

| 프로젝트 | 구현 내용 |
|---------|----------|
| **StackBlitz WebContainers** | Node.js + Python 동시 실행, 가상 네트워킹, File System Access API |
| **vscode.dev** | WASM 확장 + 로컬 폴더 마운트, 파일 편집 즉시 저장 |
| **WordPress Playground** | PHP + SQLite 브라우저 실행, 완전한 WordPress 인스턴스 |
| **Photoshop web** | OPFS 사용 (대용량 PSD 파일 처리) |
| **Notion** | SharedWorker + WASM SQLite로 cross-tab persistence |
| **Docker Desktop** | Electron frontend + backend services (IPC 통신) |

#### File System Access API 통합

**투명한 로컬 파일 접근**:

```javascript
// 사용자가 폴더 선택
const dirHandle = await showDirectoryPicker();
const nativefs = await pyodide.mountNativeFS("/workspace", dirHandle);

// Python 코드는 일반 파일처럼 접근
pyodide.runPython(`
import pandas as pd

# 로컬 Excel 파일 읽기
df = pd.read_excel('/workspace/data.xlsx')
df['new_col'] = df['old_col'] * 2

# 로컬 파일에 쓰기
df.to_excel('/workspace/output.xlsx')
`);

// 변경사항 로컬 파일시스템에 저장
await nativefs.syncfs();
```

**Python/Node.js/PHP 입장에서는 완전히 투명** - 일반 파일처럼 보임!

#### WASM 기능 상세

**✅ 가능한 것:**
- CPU 연산 (네이티브 ~90% 성능, py2wasm은 3x 인터프리터 대비)
- 가상 FS (WASI) + 로컬 파일 투명 마운트 (File System Access API)
- HTTP fetch (REST API 호출)
- SQLite 내장 (wa-sqlite, PGlite)
- Rust/C/C++/Go/Python(Pyodide)/Ruby/PHP 지원
- npm/pip 패키지 설치 (WebContainers, micropip)
- 가상 네트워킹 (브라우저 내부 localhost)

**⚠️ 제한:**
- native addon (node-gyp 바인딩) 직접 실행 불가
  - 해결: Electron이 proxy로 제공 또는 WASM 대체재 사용 (sharp → squoosh 등)
- 외부 네트워크 포트 리스닝 불가 (외부에서 접근 불가)
  - 해결: Electron이 proxy 또는 가상 네트워킹 (WebContainers 패턴)
- PostgreSQL/MySQL 직접 TCP 연결 불가
  - 해결: SQLite 사용 또는 Electron DB proxy 레이어 (Prisma Data Proxy 패턴)
- Threading/multiprocessing 제약
  - 해결: Web Workers 또는 서버사이드 처리
- 브라우저 제약: Chromium only (File System Access API)
  - Firefox/Safari: 파일 업로드 → OPFS → 다운로드 fallback

**🔧 WASM 런타임 옵션:**

| 런타임 | 위치 | 특징 | 권장 |
|--------|------|------|-----|
| **V8 (Chromium)** | Electron 내장, 추가 비용 없음 | File System Access API 지원, Pyodide 0.29.3 | ✅ Phase 2 기본 |
| **WebContainers** | StackBlitz 기술, Node.js 특화 | npm 완전 지원, 가상 네트워킹 | ✅ Node.js 앱 |
| **Wasmtime/Wasmer** | Rust에서 독립 실행 | WASI 풀 지원, 브라우저 제약 없음 | Phase 2.5 고급 |

#### 사용자 경험 (설치 제로)

```
사용자가 Laravel 앱 다운로드
→ 브라우저가 폴더 선택 요청 (File System Access API)
→ PHP WASM 런타임 자동 로드 (WordPress Playground 패턴)
→ 로컬 파일 마운트 (/Users/me/projects/laravel → /workspace)
→ 브라우저에서 즉시 실행!

설치 불필요:
❌ PHP 설치 불필요
❌ MySQL 설치 불필요 (SQLite로 대체)
❌ Docker 불필요
❌ 재시작 불필요

사용자 입장: "그냥 앱이 로컬에서 돌아가는 것처럼 보임"
```

#### 성능 데이터

**파일 크기별 처리 성능**:
- 작은 파일 (<10MB): 우수 (<100ms)
- 중간 파일 (10-100MB): 양호 (100-500ms)
- 큰 파일 (>100MB): 스트리밍 필요, 메모리 이슈 가능

**저장소 성능 비교**:
- OPFS (private): ~1ms/write (가장 빠름)
- File System Access API: ~1.5ms/write (사용자 파일)
- IndexedDB: ~3ms/write (가장 느림)

**서버 시작 시간**:
- Native Node.js: 수 초
- WASM (WebContainers): 수백 ms

**메모리 오버헤드**:
- Native: 50-200MB
- WASM: 10-50MB

#### 세션/상태 저장소 (브라우저 Storage)

**핵심 제약**: WASM 메모리는 휘발성 - 브라우저 storage에 명시적으로 저장 필요

```
❌ WASM 메모리 자체: 휘발성
   - 페이지 새로고침/닫기 시 완전히 날아감
   - JavaScript ArrayBuffer로 구현됨
                     ↓
     (JavaScript bridge를 통해 저장)
                     ↓
✅ 브라우저 Storage APIs:
   ├─ IndexedDB (가장 일반적) - Express 세션, 로그인 상태, 앱 상태
   ├─ OPFS (Origin Private File System) - SQLite/DuckDB 파일
   ├─ Service Workers - 인증 토큰, HTTP 캐시
   └─ localStorage (작은 데이터만) - 세션 ID 등
```

**저장 위치별 특징**:

| Storage | 용도 | 용량 | Eviction 정책 |
|---------|------|------|---------------|
| **IndexedDB** | 세션 데이터, 사용자 상태, 설정 | Chrome: 디스크 60%<br>Firefox: 10GB | Best-effort (삭제 가능) |
| **OPFS** | SQLite 파일, 대용량 데이터 | IndexedDB와 동일 | Best-effort |
| **Service Worker** | 인증 토큰, HTTP 캐시 | IndexedDB와 동일 | Best-effort |
| **localStorage** | 세션 ID, 작은 설정 | 5-10MB | 마지막에 삭제 (상대적 안전) |
| **Safari 모두** | (모든 storage) | 무제한 | **7일 후 자동 삭제** |

**Express 세션 예시** (WASM 서버에서):

```javascript
// Express 서버가 WASM으로 브라우저에서 실행
import { IndexedDBStore } from 'connect-indexeddb';

app.use(session({
  store: new IndexedDBStore({
    dbName: 'ExpressSessionDB',
    storeName: 'sessions',
    expirationMs: 3600000 // 1시간
  }),
  secret: 'browser-session-secret',
  resave: false
}));

// 사용자 로그인 시
app.post('/login', (req, res) => {
  req.session.userId = '123';
  req.session.loginTime = Date.now();
  // ↑ 자동으로 IndexedDB에 저장됨:
  // {
  //   sessionId: 'sess-abc123',
  //   data: { userId: '123', loginTime: ... },
  //   expires: Date.now() + 3600000
  // }
});
```

**라이프사이클**:

```
1. 페이지 새로고침 (F5):
   - ❌ WASM 메모리: 완전히 초기화
   - ✅ IndexedDB/OPFS/Service Worker: 그대로 유지
   - ✅ 복원 가능: 페이지 로드 시 storage에서 재로드

2. 브라우저 닫기 → 나중에 다시 열기:
   - ✅ 모든 storage 유지
   - ⚠️ Safari: 7일 후 자동 삭제
   - ✅ 복원 가능: 세션 만료 체크 후 재로드

3. Eviction (삭제):
   - ⚠️ 디스크 부족 시 브라우저가 삭제 가능 (best-effort)
   - ⚠️ 사용자가 "브라우저 데이터 삭제" 실행 시
   - ✅ 해결: 중요 데이터는 클라우드 sync 병행
```

**복원 패턴**:

```javascript
// 페이지 로드 시 세션 복원
window.addEventListener('DOMContentLoaded', async () => {
  // 1. WASM 서버 재시작
  const wasmServer = await loadWasmServer();

  // 2. IndexedDB에서 세션 복원
  const sessionId = getCookie('connect.sid');
  if (sessionId) {
    const session = await indexedDB.get('sessions', sessionId);

    if (session && session.expires > Date.now()) {
      // 3. WASM 서버에 세션 주입
      wasmServer.restoreSession(session);
      console.log('세션 복원 완료:', session.userId);
    } else {
      console.log('세션 만료, 로그인 필요');
    }
  }
});
```

**주기적 저장 (beforeunload 신뢰 불가)**:

```javascript
// 30초마다 자동 저장 (브라우저 닫기 이벤트는 불안정)
setInterval(async () => {
  const sessionSnapshot = wasmRuntime.getSessionSnapshot();
  await saveToIndexedDB(sessionSnapshot);
}, 30000);

// 사용자에게 상태 표시
showAutoSaveIndicator('자동 저장됨 (로컬 브라우저)');
```

**프로덕션 사례**:

- **StackBlitz WebContainers**: Service Workers + IndexedDB로 Node.js 런타임 상태 유지
- **vscode.dev**: SQLite (IndexedDB backend)로 workspace 상태 저장
- **Pyodide**: IDBFS로 Python 파일시스템 영속화

**EG-DESK 권장 전략**:

```
Phase 2 WASM 앱 세션 관리:
├─ 소규모 세션 (<5MB): localStorage (빠름)
├─ 일반 세션 데이터: IndexedDB (유연함)
├─ 데이터베이스 파일: OPFS (동기 I/O, 빠름)
├─ 인증 토큰: Service Workers (네트워크 요청 인터셉트)
├─ 자동 저장: 30초 주기
├─ 복원: 페이지 로드 시 자동
└─ 사용자 통지: "세션이 로컬 브라우저에 저장됨"
```

#### Real-time Backend (Convex 통합)

**Convex**: TypeScript 실시간 데이터베이스 + BaaS (Backend-as-a-Service)

**Phase별 지원 현황**:

| 구분 | Phase 1 (Native) | Phase 2A (Browser WASM) | Phase 2B (Electron WASM) |
|-----|-----------------|------------------------|-------------------------|
| **Convex Client** | ✅ | ✅ | ✅ |
| **Convex Backend Self-host** | ✅ (npm) | ❌ 불가능 | ✅ (Wasmtime) |

**Phase 2A (Browser)에서 Backend Self-host가 불가능한 이유**:

Convex backend는 **Rust 네이티브 바이너리**로 구현되어 있으며, 5가지 blocking issues:

1. **Native C 라이브러리 의존성** (jemalloc):
   - 30,000줄 C 코드, OS 레벨 메모리 관리
   - WASM 타겟 컴파일 불가

2. **AWS SDK + TLS**:
   - `aws-lc-rs`: AWS LibCrypto (네이티브 암호화)
   - `tls-native-roots`: OS 인증서 저장소 접근 필요

3. **서버 아키텍처** (Listening Sockets):
   - 클라이언트 연결을 **받아야 함** (port listen)
   - 브라우저에서 listening port 불가 (보안 정책)

4. **데이터베이스 연결**:
   - PostgreSQL/MySQL over TCP (브라우저 미지원)
   - SQLite만으로는 백엔드 기능 부족

5. **프로세스 관리**:
   - `function_runner` crate: 사용자 함수 격리 실행
   - OS 레벨 process spawning 필요

**권장 아키텍처**:

```
Phase 2A: Browser WASM
┌─────────────────────┐
│  Convex Client      │ ← React hooks (useQuery, useMutation)
│  (WASM에서 실행)    │
└──────────┬──────────┘
           │ WebSocket/HTTPS
           ↓
┌─────────────────────┐
│  Convex Cloud       │ ← Backend 외부 호스팅 (무료 tier)
└─────────────────────┘

Phase 2B: Electron WASM (Self-host 가능!)
┌─────────────────────────────┐
│  Electron Main Process      │
│  ├─ Wasmtime Engine         │
│  │  └─ Convex Backend.wasm  │ ← Rust WASM (재컴파일 필요)
│  └─ HTTP Server (0.0.0.0)   │
└──────────┬──────────────────┘
           │ IPC or localhost
┌──────────▼──────────────────┐
│  Renderer (Chromium)        │
│  └─ Convex Client           │
└─────────────────────────────┘
```

**Convex Client 사용 예시** (모든 Phase 공통):

```javascript
// Phase 2A/2B: Browser/Electron Renderer
import { ConvexProvider, useQuery, useMutation } from "convex/react";
import { ConvexReactClient } from "convex/react";

// Phase 2A: 외부 Convex Cloud
const convex = new ConvexReactClient("https://your-app.convex.cloud");

// Phase 2B: Electron localhost
const convex = new ConvexReactClient("http://localhost:3000");

function App() {
  const tasks = useQuery(api.tasks.list);      // ✅ 실시간 구독
  const addTask = useMutation(api.tasks.create); // ✅ 뮤테이션

  return <div>...</div>;
}
```

**결론**:
- Phase 2A: Convex **client만** 사용 (backend는 Convex Cloud)
- Phase 2B: Convex **전체 self-host 가능** (backend를 WASM으로 재컴파일 시)

#### Python 버저닝 (conda-like 환경 관리)

**핵심 제약**: Pyodide 버전 = Python 버전 고정

| Pyodide 버전 | Python 버전 | 출시일 |
|-------------|------------|--------|
| 0.29.3 | 3.13.2 | 2026 |
| 0.28.0 | 3.13.0 | 2025 |
| 0.27.x | 3.12.7 | 2025 |
| 0.26.x | 3.12 | 2024 |

**conda 대안**:

1. **emscripten-forge + mambajs** (2025-2026):
   ```javascript
   // conda 스타일 패키지 관리 (WASM)
   import { mambajs } from '@emscripten-forge/mambajs';

   await mambajs.install('numpy', 'scipy', 'matplotlib');
   // → conda 패키지의 WASM 빌드 사용
   ```

2. **micropip** (Pyodide 기본):
   ```python
   import micropip
   await micropip.install('pandas>=2.0,<3.0')
   await micropip.install('backports.zoneinfo ; python_version < "3.9"')
   ```

**패키지 생태계**:
- ✅ Pure Python: PyPI에서 자동 설치
- ✅ Scientific: NumPy, Pandas, Matplotlib (WASM 빌드 제공)
- ❌ C extension: WASM 빌드 없으면 설치 불가

**버전 전환 패턴**:

**Pattern A: Web Worker 격리** (동시 다중 버전)

```javascript
// EG-DESK에서 사용할 패턴
class PyodideVersionManager {
  workers = new Map();

  async runPython(version, code) {
    // version: '3.13' or '3.12'
    const pyodideVersion = version === '3.13' ? '0.29.3' : '0.27.0';

    if (!this.workers.has(version)) {
      const worker = new Worker(`pyodide-${version}-worker.js`);
      this.workers.set(version, worker);
    }

    const worker = this.workers.get(version);
    return await executeInWorker(worker, code);
  }

  cleanup(version) {
    this.workers.get(version)?.terminate(); // 메모리 해제
    this.workers.delete(version);
  }
}

// 사용자가 Python 버전 선택
const manager = new PyodideVersionManager();
await manager.runPython('3.13', 'import pandas'); // Pyodide 0.29.3
await manager.runPython('3.12', 'legacy_code()'); // Pyodide 0.27.0
```

**메모리**:
- Python 3.13: ~50MB
- Python 3.12: ~50MB
- 합계: ~100MB (두 버전 동시)

**Pattern B: URL 파라미터** (단일 버전, 리로드)

```javascript
// URL로 버전 선택: ?python=3.12
const params = new URLSearchParams(window.location.search);
const pythonVersion = params.get('python') || '3.13';

const versionMap = {
  '3.13': '0.29.3',
  '3.12': '0.27.0'
};

loadPyodide(versionMap[pythonVersion]);

// 버전 전환 = 페이지 리로드
function switchToPython312() {
  window.location.href = '?python=3.12';
}
```

**Electron에서 더 유연**:

```javascript
// Electron Main Process
const { Worker } = require('worker_threads');

// Python 버전별 persistent workers
const pythonWorkers = {
  '3.13': new Worker('pyodide-313.js'),
  '3.12': new Worker('pyodide-312.js'),
};

// IPC로 버전 선택
ipcMain.handle('run-python', async (event, {version, code}) => {
  const worker = pythonWorkers[version];
  return await worker.execute(code);
});
```

**Conda vs WASM 비교**:

| 기능 | Conda | WASM (Phase 2A) | WASM (Phase 2B/Electron) |
|-----|-------|-----------------|--------------------------|
| **버전 전환** | ✅ `conda activate env` | ⚠️ Worker or reload | ✅ Worker threads |
| **여러 환경 동시** | ✅ 무제한 | ⚠️ Worker로만 | ✅ Worker threads |
| **환경 격리** | ✅ 완전 | ⚠️ Worker만 | ✅ Thread 격리 |
| **패키지 관리** | ✅ conda/pip | ⚠️ micropip + mambajs | ✅ micropip + mambajs |
| **메모리 효율** | ✅ OS 관리 | ❌ ~50MB per version | ⚠️ 개선 (Worker reuse) |
| **Cleanup** | ✅ `conda remove` | ⚠️ `terminate()` | ✅ `terminate()` |

**EG-DESK 권장 전략**:

```
기본 전략:
├─ Phase 2A: Python 3.13 단일 버전 (Pyodide 0.29.3)
│  └─ 대부분 앱은 최신 버전으로 충분
│
고급 전략 (Legacy 지원):
├─ Phase 2A: Worker 격리로 3.13 + 3.12 동시 실행
│  └─ 메모리 여유 있을 때만 (100MB+)
│
Phase 2B/Electron:
└─ Worker threads로 여러 Python 버전 persistent 실행
   └─ 메모리 재사용, 더 효율적
```

**PyScript처럼 대안 제공**:
- **Pyodide**: Full CPython (numpy, pandas 등)
- **MicroPython**: 경량 (170KB, 빠른 로딩)
- 사용자 선택 가능하게


### 실행 흐름

```
앱 실행 요청
  ↓
egdesk.json 의 runtime 확인
  ↓
Node.js 앱?
  ├─ WASM 호환 체크 (native addon 없음?)
  │   ├─ Yes → Phase 2A: WebContainers로 브라우저 실행
  │   │         (설치 0, 밀리초 시작, File System Access API)
  │   └─ No → Phase 1: Electron 내장 Node.js로 실행
  └─ 다른 언어 (Python/PHP/Ruby)?
      ├─ Pyodide/WASM 런타임 있음?
      │   ├─ Yes → Phase 2A: WASM으로 즉시 실행
      │   │         (File System Access API로 로컬 파일 투명 접근)
      │   └─ No → Phase 2B: Electron WASM (Wasmtime)으로 실행
      │             또는 Phase 1 (Native)로 fallback
```

---

## Phase 비교표

| | Phase 1: Native Node.js | Phase 2A: Browser WASM | Phase 2B: Electron WASM |
|--|------------|------|--------|
| **설치** | Electron 내장 | 없음 (내장) | Electron 내장 |
| **시작 시간** | 수 초 | 밀리초 | 마이크로초 (Wasmtime) |
| **런타임 오버헤드** | 50-200MB | 50-90MB (다중 런타임) | 10-50MB |
| **격리 수준** | 약함 (OS 프로세스) | 높음 (WASM 샌드박스) | 중간 (WASM + Node.js) |
| **로컬 파일 접근** | ✅ 완전 | ✅ File System Access API (투명) | ✅ 완전 (Native FS) |
| **native addon** | ✅ 완전 지원 | ❌ proxy 필요 | ✅ 완전 지원 |
| **네트워크 포트** | ✅ 실제 localhost | ✅ localhost (Direct Sockets) | ✅ 0.0.0.0 가능 |
| **데이터베이스** | ✅ 모든 DB | ⚠️ SQLite만 | ✅ 모든 DB (WASI sockets) |
| **다중 런타임** | ❌ Node.js only | ✅ npm + Pyodide 동시 | ✅ Wasmtime + 다중 모듈 |
| **npm/pip** | ✅ 완전 | ✅ WebContainers/micropip | ✅ 완전 |
| **언어 지원** | Node.js only | 모든 WASM 컴파일 가능 언어 | 모든 WASM + Node.js |
| **Excel 핸들링** | ✅ xlwings (COM API) | ✅ openpyxl/pandas (File API) | ✅ xlwings + WASM |
| **세션 저장소** | OS 파일시스템 | IndexedDB + OPFS + Service Workers | Node.js + WASM storage |
| **세션 영속성** | 완전 영속 | Best-effort (7일 Safari 정책) | 완전 영속 |
| **Convex Backend** | ✅ npm install | ❌ 불가능 (Rust native deps) | ✅ Wasmtime (재컴파일) |
| **Private 양방향 통신** | ✅ IPC | ✅ Direct Sockets (127.0.0.1) | ✅ IPC + localhost |
| **브라우저 제약** | N/A | Chromium only (IWA) | N/A |
| **권장 유스케이스** | Native addon 필요 앱 | 순수 웹앱, 설치 제로 경험 | Backend self-host, 고급 기능 |

---

## Electron 업데이트 시 앱 호환성

문제: Electron 업데이트 → Node.js 버전 변경 → 앱 깨질 수 있음

해결: 매니페스트에 런타임 버전 범위 선언
```json
{ "runtime": { "node": ">=18 <22" } }
```

```
EG-DESK 업데이트 시:
  앱별 호환성 체크 (runtime 범위 vs 새 Node 버전)
  ├─ 호환 → 그대로 실행
  ├─ 비호환 → Phase 2 (WASM) 시도 (더 나은 격리)
  └─ WASM 불가능 → Phase 2B (Wasmtime) 또는 Node 버전 다운로드
```

---

## 보안 고려사항

### Phase 1 (Native Node.js)
- ⚠️ OS 프로세스 수준 격리만 제공
- 앱이 전체 파일시스템 접근 가능 (위험)
- 권장: 신뢰된 앱만

### Phase 2 (WASM)
- ✅ WASM 샌드박스 격리 (강력)
- ✅ File System Access API: 사용자가 명시적으로 선택한 폴더만 접근
- ✅ 브라우저 보안 정책 적용
- ✅ 권한 프롬프트 (읽기/쓰기 별도)
- ✅ 권한 자동 만료 (탭 닫으면 revoke)
- 권장: 사용자 정의 앱, 신뢰도 낮은 앱

---

## 참고 프로젝트

| 프로젝트 | 관련성 | Phase |
|----------|--------|-------|
| **StackBlitz WebContainers** | 브라우저에서 Node.js + Python 동시 실행, npm, 가상 네트워킹 | Phase 2A |
| **vscode.dev** | WASM + File System Access API로 로컬 폴더 편집, `@vscode/wasm-wasi-lsp` | Phase 2A/2B |
| **WordPress Playground** | PHP를 WASM으로 실행, SQLite, File System Access API | Phase 2A |
| **Photoshop web** | OPFS로 대용량 PSD 파일 처리 | Phase 2A |
| **Notion** | SharedWorker + WASM SQLite로 cross-tab persistence | Phase 2A |
| **Pyodide** | Python을 WASM으로 실행, pandas/numpy 지원, Chromium/Node.js 환경 | Phase 2A/2B |
| **PGlite** | PostgreSQL을 WASM으로 실행 | Phase 2A |
| **Direct Sockets HTTP/WS Server** | IWA + Direct Sockets로 브라우저에서 TCP server | Phase 2A |
| **Docker Desktop** | Electron frontend + backend services (IPC/socket 통신) | Phase 2B |
| **Deta Surf Surflet** | Electron + 앱 매니페스트 패턴 | Phase 1 |
| **Convex** | Real-time database + BaaS, client는 모든 phase, backend는 2B만 | Phase 2A (client), 2B (backend) |

---

## Rust 역할 (Surf 패턴 참고)

Surf의 Rust 백엔드 구성:
- AI: LLM 클라이언트, 스트리밍, agent state machine, tool calling
- Store: SQLite DB 전체
- Worker: 스레드 오케스트레이션
- Embeddings: FastEmbed + USearch 벡터 검색
- OCR: `ocrs` + `rten`

EG-DESK에서 Rust 적용 후보:
- 고성능 시스템 기능 (파일 인덱싱, 검색)
- AI 스트리밍/토큰 처리
- 벡터 임베딩/검색
- Neon FFI로 Electron과 연결
- WASM proxy 레이어 (native addon → IPC → Rust → 결과 반환)

---

## 구현 로드맵

### Milestone 1: Phase 1 MVP
- [ ] egdesk.json 파서
- [ ] Node.js 앱 spawn + 포트 관리
- [ ] WebContentsView 통합
- [ ] 기본 앱 목록 UI

### Milestone 2: Phase 2 (WASM + File System Access API)
- [ ] File System Access API 권한 관리
- [ ] Pyodide 통합 (Python 앱)
- [ ] WebContainers 통합 (Node.js 앱)
- [ ] 가상 네트워킹 proxy
- [ ] syncfs() 자동화 (blur/beforeunload)

### Milestone 3: Phase 2 고급
- [ ] PHP WASM (WordPress Playground 패턴)
- [ ] SQLite 통합 (wa-sqlite)
- [ ] WASM 대체재 매핑 (sharp → squoosh 등)
- [ ] DB proxy 레이어 (Prisma Data Proxy 패턴)
- [ ] Phase 2B: Electron + Wasmtime 통합
- [ ] WASI Preview3 sockets 지원

---

## External References

**WASM + File System Access API**:
- Research: `/Users/minsoocha/Projects/EG-Desk-Dev-Space/subagent_reports/20260202_file-system-access-api-wasm-research-general.md`
- Key findings:
  - Pyodide + mountNativeFS() = 투명한 로컬 파일 접근
  - vscode.dev 패턴: 폴더 선택 → 권한 → 마운트 → WASM 접근
  - Performance: ~1.5ms/write (File System Access API)
  - Chromium only (Chrome 86+, Edge 86+)

**xlwings WASM**:
- Key findings:
  - xlwings WASM (production-ready, Office Store)
  - Office.js API (not COM API)
  - openpyxl + pandas로 로컬 Excel 파일 읽기/쓰기 가능

**WASM Session Storage**:
- WASM 메모리는 휘발성 (페이지 새로고침 시 초기화)
- 세션은 IndexedDB/OPFS/Service Workers에 저장 (브라우저 캐시와 유사)
- Express 세션: IndexedDBStore 사용
- SQLite/DuckDB: OPFS에 파일 저장 (동기 I/O, ~1ms/write)
- 복원 가능: 페이지 로드 시 storage에서 자동 재로드
- Safari 7일 eviction 정책 주의
- 프로덕션 검증: StackBlitz, vscode.dev, WordPress Playground

**다중 WASM 런타임 (npm + Pyodide)**:
- 같은 페이지/탭에서 동시 실행 가능 (별도 메모리 공간)
- JavaScript bridge 통신 (2-3% 오버헤드)
- JSPI (Chrome 137+, Firefox 139+)로 async 통신 개선
- Combined 메모리: 50-90MB, 병렬 로드 1-3초
- 프로덕션: StackBlitz (Node.js + Python experimental)

**네트워크 독립성 (OS급 Spinoff)**:
- **Browser IWA**: Direct Sockets API로 localhost TCP server (127.0.0.1:PORT)
- **Electron**: Wasmtime으로 0.0.0.0 바인딩 가능, persistent daemon
- Private 양방향 통신: Window ↔ WASM server 완전 가능
- Shared Worker로 cross-tab persistence (Notion 패턴)
- 실제 사례: direct-sockets-http-ws-server (GitHub)

**Convex Backend Self-host**:
- Browser WASM: 불가능 (Rust native deps, listening sockets, DB connections)
- Electron WASM: 가능 (Wasmtime + WASI Preview3, 재컴파일 필요)
- Client: 모든 phase에서 사용 가능
- 프로덕션: Convex Cloud (무료 tier) 권장

**WASI Preview3 (2026년 2월)**:
- TCP/UDP sockets 완전 지원
- Async I/O with JSPI
- 브라우저: 여전히 listening port 불가 (보안)
- Server-side (Wasmtime): 모든 기능 사용 가능

---

**Status**: Brainstorming (Confirmed → 격하됨)
**Created**: 2026-01-31
**Updated**: 2026-02-02
**Moved to Brainstorming**: 2026-02-02

**격하 이유**:
- **WASM 제약사항 명확화**: Native addon 불가, PostgreSQL/MySQL 직접 연결 불가
- **Proxy Layer 복잡도**: 프로덕션급 구현에 6-12개월 + 지속적 유지보수 필요
- **Native addon 버전 충돌**: Phase 1에서 해결 방법 불명확 (앱별 설치 vs 버전 캐시)
- **StackBlitz 수준 제약**: SaaS 백엔드 개발에 한계 (PostgreSQL, FFmpeg 등)
- **Phase 2A 실효성**: 완전한 격리는 맞지만, 실용성 재검토 필요
- **미니앱 배포 전략 부재**: Git clone, npm, marketplace 등 배포 메커니즘 미정
- **Electron 업데이트 호환성**: Node.js 버전 변경 시 앱 깨짐 해결 방법 불완전

**재검토 필요 사항**:
1. Phase 1 (Native Node.js)만으로 MVP 가능성 검토
2. Proxy Layer 최소 구현 범위 정의
3. 미니앱 배포/설치 메커니즘 구체화
4. 버전 충돌 해결 전략 확정
