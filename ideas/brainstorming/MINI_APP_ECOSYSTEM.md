# Mini-App Ecosystem (초안)

**작성일**: 2026-04-17
**상태**: Brainstorming — skeleton
**관련**: [ADR-007](../../.claude/docs/decisions/007-firefox-shell-over-electron.md), [`FIREFOX_SHELL_STRATEGY.md`](../confirmed/FIREFOX_SHELL_STRATEGY.md) Layer 4, 기존 [`APP_RUNTIME_ARCHITECTURE.md`](APP_RUNTIME_ARCHITECTURE.md) (Electron 전제, 재작성 예정)

---

## 목적

**사용자 / 3rd party 가 자신의 앱을 EG-Desk 안에 설치/실행** 하는 플랫폼. 각 mini-app = 독립 npm/node/bun 프로세스, localhost HTTP/WS 로 UI 제공, canvas card 에서 렌더.

Electron 의 "플러그인" 이나 VS Code 의 "확장" 과 유사하나 더 느슨한 격리 (별 프로세스). Deta Surf / Raycast / Obsidian plugin 계열 모델.

## Manifest — `egdesk.json`

```json
{
  "$schema": "https://egdesk.dev/schemas/mini-app.v1.json",
  "id": "com.example.kanban",
  "name": "Kanban Board",
  "version": "1.2.0",
  "description": "Trello-like kanban with agent integration",
  "icon": "icon.png",
  "category": "productivity",
  "runtime": {
    "type": "bun",       // "bun" | "node" | "deno" | "static"
    "versionReq": ">=1.1.0"
  },
  "install": {
    "command": "bun install",
    "outputs": ["node_modules", ".bun"]
  },
  "start": {
    "command": "bun run start",
    "env": { "NODE_ENV": "production" },
    "ready": {
      "method": "http",    // helper 가 감지할 ready signal
      "path": "/healthz",
      "timeoutMs": 10000
    }
  },
  "http": {
    "port": "auto",        // "auto" | 숫자
    "mountPath": "/"
  },
  "permissions": {
    "fs": ["~/documents/kanban/"],
    "network": ["https://api.trello.com"],
    "agent": {
      "canReadViewport": true,
      "canExecuteCommands": ["card.create", "card.update"]
    }
  },
  "agent": {
    "tools": "./agent-tools.json",    // agent 가 호출 가능한 함수 스키마
    "contextAdapters": {
      "packing": "./pack.mjs",         // Preset Bag Pack 시 snapshot 생성
      "unpacking": "./unpack.mjs"       // Unpack 시 복원
    }
  }
}
```

## 라이프사이클

```
[Install]
  사용자가 .tar.gz 다운로드 또는 git clone
  → chrome JS 가 manifest 검증
  → IOUtils 로 ~/egdesk/apps/<id>/ 에 압축 해제
  → install.command 를 Subprocess 로 실행
  → 완료 시 registry 에 등록

[Start]
  사용자가 Dock Shelf 에서 앱 클릭, 또는 Preset Bag 에서 Unpack, 또는 agent 요청
  → chrome JS 가 Subprocess 로 start.command 실행
  → PORT 할당 (auto 인 경우 OS 가 결정, 프로세스가 stdout 에 출력)
  → ready probe 성공 대기 (http GET /healthz)
  → Canvas card 스폰 (XUL <browser src="http://127.0.0.1:PORT">)

[Pack] (Preset Bag)
  → contextAdapters.packing 이 있으면 호출 → 앱 상태 snapshot
  → 아니면 URL + 뷰포트 위치만 저장

[Unpack]
  → Pack 데이터를 contextAdapters.unpacking 으로 복원
  → 필요시 앱 재시작

[Stop]
  → 카드 닫거나 사용자가 종료
  → Subprocess SIGTERM → 5초 대기 → SIGKILL
  → PORT 해제

[Uninstall]
  → ~/egdesk/apps/<id>/ 제거
  → registry 에서 삭제
```

## 통신 경로

```
Canvas card (XUL <browser>)
  │ localhost HTTP / WebSocket
  ▼
Mini-app (bun/node)
  │ (자체 로직)
  ▼
Mini-app 자체의 npm 의존성 / 파일시스템 / 네트워크

---

Chrome JS (agent layer)
  │ localhost HTTP (agent API)
  ▼
Mini-app 의 agent endpoint (manifest.agent.tools 스키마 기반)
  → 호출 결과를 agent context 에 합산
```

## 보안 모델

- **Subprocess 격리** — mini-app 크래시/오작동이 EG-Desk 본체에 영향 없음
- **Permissions** — manifest.permissions 가 선언적. 실제 enforcement:
  - `fs`: mini-app 시작 시 환경변수로 경로 전달, mini-app SDK 가 검증 (최초 버전은 trust-based)
  - `network`: mini-app 이 자체 enforcement, 향후 helper 가 firewall rule 로 강화 검토
  - `agent`: chrome JS 가 agent 호출 시 화이트리스트 검증
- **Sandboxing** — 추후 OS 레벨 sandbox (bubblewrap/Linux, sandbox-exec/macOS, AppContainer/Windows) 검토
- **Signing** — 배포 앱은 서명 필수 검토 (최초 버전 생략 가능)

## 번들 런타임

- **bun** — 기본 런타임. 빠른 시동, npm 호환, TypeScript 네이티브 실행
- **node** — 특정 native addon 필요 시 fallback
- **deno** — 보안 모델 선호 사용자용 (추후)
- **static** — 정적 HTML/CSS/JS 만, 런타임 불필요. Chrome JS 가 직접 serve

EG-Desk 앱 번들에 bun 바이너리 포함 (~90MB). Mini-app 은 자체 런타임 설치 요구 안 함.

## 마켓플레이스 (추후)

- 공식 registry: `https://apps.egdesk.dev/`
- 사용자 설치: `egdesk install <id>` 또는 UI
- 무료 / 유료 / 검증 마크
- 버전 관리, 자동 업데이트
- 초기엔 git URL 직접 설치만 지원 (`egdesk install git://github.com/user/kanban`)

## Agent 통합

Mini-app 이 agent 와 협력하려면 `manifest.agent.tools` 에 호출 가능 함수 스키마 선언:

```json
{
  "tools": [
    {
      "name": "kanban.createCard",
      "description": "Create a new card in a column",
      "parameters": {
        "type": "object",
        "properties": {
          "column": { "type": "string" },
          "title": { "type": "string" },
          "description": { "type": "string" }
        },
        "required": ["column", "title"]
      }
    }
  ]
}
```

EG-Desk agent 는 이 스키마를 읽고 LLM tool calling 으로 노출. 사용자가 "kanban 에 todo 만들어" → agent 가 mini-app HTTP endpoint 호출.

## 초기 번들 앱 (alpha)

Path 2 Alpha 출시 시 기본 탑재 후보:

1. **browser** — Dock Browser 아이콘 = 실질 mini-app 아님, 내장 XUL browser card
2. **terminal** — helper 기반 PTY (아직 mini-app 아님, helper 제공)
3. **kanban** — 예시 productivity 앱 (bun + SQLite + 심플 UI)
4. **notes** — markdown 노트, Preset Bag 과 통합
5. **file-preview** — PDF / 이미지 / text preview 범용

각각 별개 repo 로 개발 후 EG-Desk 에 번들.

## 오픈 이슈

- [ ] Mini-app 간 통신 (앱 A 가 앱 B 호출)? 권장/금지?
- [ ] PORT 충돌 관리 (2 인스턴스 동시?)
- [ ] Bun vs Node 런타임 분리 (Node 전용 앱을 위한 secondary runtime 번들?)
- [ ] 업데이트 전략 (manifest.version semver, breaking change 처리)
- [ ] 오프라인 사용 (기본 가정) vs 네트워크 의존 앱 (명시 권한)
- [ ] Mini-app 설정 UI (egdesk.json 외부에서 설정 가능?)
- [ ] Agent 가 mini-app 의 "상태" 를 읽는 방법 (HTTP GET vs WebSocket subscription)

## 다음 단계

1. Schema v1 확정 (`egdesk.json`)
2. Mini-app SDK 초안 (JS/TS helper 라이브러리)
3. `egdesk install` CLI
4. 첫 실제 mini-app (kanban 또는 notes) PoC
5. Manifest 가 agent tool 로 자동 등록되는 파이프라인
