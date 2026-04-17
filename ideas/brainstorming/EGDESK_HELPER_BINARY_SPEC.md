# egdesk-helper Binary Spec (초안)

**작성일**: 2026-04-17
**상태**: Brainstorming — 초안 skeleton. 구체화는 Path 2 착수 시점에 이어감
**관련**: [ADR-007](../../.claude/docs/decisions/007-firefox-shell-over-electron.md), [`FIREFOX_SHELL_STRATEGY.md`](../confirmed/FIREFOX_SHELL_STRATEGY.md) Layer 3

---

## 목적

Firefox chrome JS 가 못 하는 **OS-deep 기능** 을 단일 Rust 바이너리로 통합 제공. Chrome JS 가 `Subprocess.call` 로 spawn, WebSocket 으로 이벤트 교환.

## 담당 기능

| 기능 | 근거 Crate | 우선순위 |
|------|-----------|--------|
| **PTY** (터미널 카드) | `portable-pty`, `alacritty_terminal` | P1 (터미널 카드 = 초기 핵심 UX) |
| **System tray** | `tray-icon` | P2 |
| **Global hotkey** | `global-hotkey` | P2 |
| **File watcher** | `notify` | P2 |
| **Native dialog** (추가) | `rfd` (Rust File Dialog) | P3 — Firefox `nsIFilePicker` 로 대부분 커버 가능, 특수 케이스만 |
| **Screen capture** | `scrap` 또는 `xcap` | P3 — `getDisplayMedia()` 로 대부분 커버 |
| **Auto-start / 로그인 자동실행** | 자체 레지스트리/plist 조작 | P4 |

## 아키텍처

```
┌──────────────────────────────────────────────────┐
│ chrome JS                                         │
│ ├─ Subprocess.call({ command: "egdesk-helper" })  │
│ └─ WebSocket client (ws://127.0.0.1:PORT)         │
└──────────────────────────┬───────────────────────┘
                           │ bi-directional JSON-RPC over WebSocket
┌──────────────────────────▼───────────────────────┐
│ egdesk-helper (Rust, tokio)                       │
│ ├─ WebSocket server (tokio-tungstenite)           │
│ ├─ Message router → feature handlers              │
│ ├─ features/                                       │
│ │   ├─ pty.rs         (portable-pty)              │
│ │   ├─ tray.rs        (tray-icon)                 │
│ │   ├─ hotkey.rs      (global-hotkey)             │
│ │   ├─ fswatch.rs     (notify)                    │
│ │   └─ ...                                        │
│ └─ event bus → WebSocket broadcast                │
└──────────────────────────────────────────────────┘
```

## 통신 프로토콜 (초안)

JSON-RPC 2.0 over WebSocket.

**Client → Helper (request)**:
```json
{ "jsonrpc": "2.0", "id": 1, "method": "pty.spawn", "params": { "shell": "bash", "cwd": "/home/user", "cols": 80, "rows": 24 } }
```

**Helper → Client (response)**:
```json
{ "jsonrpc": "2.0", "id": 1, "result": { "ptyId": "pty-abc123" } }
```

**Helper → Client (event, notification)**:
```json
{ "jsonrpc": "2.0", "method": "pty.output", "params": { "ptyId": "pty-abc123", "data": "base64_or_utf8_chunk" } }
```

### Method 카탈로그 (초안)

| Namespace | Method | Params | Result |
|-----------|--------|--------|--------|
| `pty` | `spawn` | shell, cwd, cols, rows, env | ptyId |
| `pty` | `write` | ptyId, data | void |
| `pty` | `resize` | ptyId, cols, rows | void |
| `pty` | `kill` | ptyId | void |
| `pty.output` | (event) | ptyId, data | — |
| `pty.exit` | (event) | ptyId, code | — |
| `pty.commandStarted` | (event, agent-aware) | ptyId, traceId, cmd, at | — |
| `pty.commandExited` | (event, agent-aware) | ptyId, traceId, code, at | — |
| `tray` | `create` | icon, menu | trayId |
| `tray` | `update` | trayId, patch | void |
| `tray.click` | (event) | trayId, item | — |
| `hotkey` | `register` | id, accelerator | void |
| `hotkey` | `unregister` | id | void |
| `hotkey.triggered` | (event) | id | — |
| `fswatch` | `watch` | path, recursive | watcherId |
| `fswatch` | `unwatch` | watcherId | void |
| `fswatch.event` | (event) | watcherId, type, path | — |

## 기술 스택 선택 근거

- **Rust**: 크로스플랫폼 static linking, 작은 바이너리, 메모리 안전
- **tokio**: async 런타임 표준
- **tokio-tungstenite**: 가장 성숙한 Rust WebSocket
- **portable-pty**: WezTerm 프로젝트 공개 부분, Windows ConPTY + Unix forkpty 추상화 de-facto 표준
- **alacritty_terminal**: ECMA-48 완벽 구현, 터미널 state 파싱 (추후 agent-aware events 에 사용)

## 라이프사이클

1. EG-Desk 시작 → chrome JS boot → `Subprocess.call('egdesk-helper', ['--port', '0', '--token', RANDOM_TOKEN])` (포트 0 = OS 가 할당한 free port 사용, `--token` = auth)
2. Helper 가 stdout 으로 `{ "port": 54321, "ready": true }` 출력 → chrome JS 가 포트 파싱
3. Chrome JS 가 `ws://127.0.0.1:54321?token=...` 연결
4. 이후 JSON-RPC 교환
5. EG-Desk 종료 → chrome JS 가 WebSocket 닫음 → Helper 가 detected idle + graceful shutdown
6. Helper 크래시 시 chrome JS 가 재spawn (최대 N회)

## 보안

- WebSocket 은 localhost 전용 바인딩 (`127.0.0.1`)
- 랜덤 토큰 매 시작 생성, 쿼리 파라미터로 검증
- Helper → Client 이벤트에 pid/traceId 포함해 origin 식별
- Chrome JS 만이 helper 에 접근 (content process 는 접근 불가 — chrome JS 가 필요시 프록시)

## 테스트 전략

- 각 feature 별 integration test (실제 PTY 돌림, tray 아이콘 생성, 파일 watcher)
- 크로스플랫폼 CI: Windows / macOS / Linux 자동 테스트
- Smoke test: helper 바이너리 실행 + WebSocket 연결 + pty spawn + output 수신 < 1 초

## 오픈소스 공개 전략 (검토)

- EG-Desk 와 분리된 `egdesk-helper` repo
- MIT / Apache 2.0 듀얼
- 다른 agent-first dev tool 프로젝트 (Cursor, Zed, 자체 CLI 도구) 재사용 가능하도록 "범용 local agent OS bridge" 포지셔닝
- crates.io 에 크레이트 + `brew install egdesk-helper` / `winget install egdesk-helper` 배포

## 오픈 이슈

- [ ] PTY 리사이즈 timing 처리 (WebSocket 순서 보장)
- [ ] Windows 에서 hotkey + VK_ 코드 매핑 details
- [ ] macOS 서명 요구사항 (`codesign` 필요, notarization?)
- [ ] Linux Wayland 지원 (많은 crate 가 X11 가정)
- [ ] Helper 업데이트 방식 (EG-Desk 앱 업데이트에 포함? 별도 채널?)
- [ ] Agent-aware PTY 이벤트 파싱 정확도 (shell 별 prompt 감지 등)

## 다음 단계

1. PoC: `portable-pty` + `tokio-tungstenite` 로 PTY spawn + output broadcast 400 LOC 이내 구현
2. chrome JS 측 helper client 모듈 작성 (`overlay/JS/egdesk-helper-client.uc.js`)
3. 터미널 카드 integration (`eg-desk-surface.uc.js` 의 `spawnTerminalCard`)
4. tray + hotkey 추가
5. `alacritty_terminal` 로 agent-aware commandStarted/Exited 이벤트 emission
