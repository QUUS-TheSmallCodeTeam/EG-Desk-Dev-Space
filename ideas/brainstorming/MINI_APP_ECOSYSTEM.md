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

<a id="npx-sharing"></a>
## `npx`로 실행하고 사람끼리 공유할 수 있는가?

**가능하다. 단, 어디에서 코드를 실행할지와 어떤 데이터를 같이 쓸지는 따로 설계한다.** [npm의 npx](https://docs.npmjs.com/cli/v11/commands/npx/)는 로컬 또는 원격 npm 패키지의 실행 파일을 구동한다. 미설치 패키지를 캐시로 가져올 수 있지만 사용자 계정, 공유 DB, 권한 회수, 프로세스 격리를 제공하는 협업 서비스는 아니다.

| 공유할 것 | 서윤이 보낼 것 | 민재가 얻는 것 | 데이터 기준점 |
|---|---|---|---|
| **같은 앱을 설치하는 방법** | 검토된 패키지의 이름·정확한 버전·무결성 식별자 | 자기 기기에서 별도로 시작할 선택지. 설치를 수락해야 하며 개인 데이터도 별도 | 각 기기. 앱에 별도 동기화가 없으면 업무 데이터는 합쳐지지 않는다 |
| **같은 업무 객체** (첫 제품 추천) | 동작 중인 인스턴스·업무 항목에 대한 수신자 전용 초대 | 자기 Firefox에서 같은 `SH-42`를 읽거나, 허용된 상태 변경만 수행 | 운영자/팀 호스트의 앱 한 곳. 호스트 한 번 실행, 이용자는 npm 불필요 |
| **특정 시점의 결과만** | 공유 가능한 결과의 승인된 발췌·버전 | 실행 중인 앱에도, 다음 버전에도 접근하지 않는 자료 한 장 | 전달 시점 사본. 라이브 결과로 표시하지 않음 |

**권장 흐름(제안):** 운영자가 검토된 앱 버전을 팀 호스트에서 명시적으로 시작한다. 앱은 일반 웹 콘텐츠로 렌더링하며 Firefox chrome 권한을 갖지 않는다. 서윤이 `배송 앱 → SH-42 → 민재 → 상태 변경 가능`을 고른다. 민재는 Board 카드에서 각자 인증하고 **그 업무 건**을 연다. 초대나 패키지 문자열을 받았다고 `npx`를 실행시키지 않는다. `localhost`는 보는 사람 자신의 기기다. 다른 기기는 인증된 HTTPS 게이트웨이를 통해 인스턴스에 도달해야 하며 URL이나 호스트 포트만으로는 권한이 되지 않는다.

게이트웨이는 요청마다 **사람·Board 참여/카드 단독 공개·앱 인스턴스·객체·동작**을 재확인하고, 해당 앱에는 그 요청에만 쓸 제한된 권한을 준다. 인스턴스 소유자의 범용 키, 브라우저 쿠키, 프로젝트 디렉터리, Agent/Decision 자격증명을 넘기지 않는다. 앱도 읽기/변경을 구분한다. 권한 철회는 다음 읽기·쓰기와 새 연결에 적용하고 연결된 창을 내린다. 이미 전달한 사본이나 이미 확정된 업무 변경을 되감았다고 하지 않는다. 호스트가 꺼지면 연결 불가를 표시하고 상대 PC에서 같은 앱을 몰래 재실행하지 않는다.

**배포 전 필요한 것:** 운영자가 승인한 레지스트리·정확한 버전뿐 아니라 의존성 잠금과 배포 산출물 해시를 확인한다. `latest`/자유 입력 명령/패키지 설치 스크립트를 초대에서 받지 않는다. 별도 프로세스만으로는 샌드박스가 아니다. 전용 실행 사용자나 격리 환경, 최소 파일·네트워크·자원 권한, 승인된 업데이트/중지, 데이터 백업·업그레이드·삭제 계획이 필요하다. 카드 열기와 설치·승격·업데이트·다른 사용자에게 재공개는 별도 결정이다. Decision Model은 허가된 **표시 후보**를 고를 수 있을 뿐 설치할 패키지나 실행 명령, 사용자 권한을 결정하지 않는다.

**실험한 범위:** [자체 패키지로 실행하는 오프라인 npx 증명](../../apps/firefox-ui-demo/proofs/joint-board-offline/verify-npx.mjs). 의존성 없는 테스트 앱을 임시 폴더에서 pack하고 빈 npm 캐시로 로컬 tarball을 `npx --offline`으로 한 번 실행한다. 두 합성 클라이언트가 동일 인스턴스·`SH-42`의 변경을 다시 읽고, 읽기 전용 쓰기는 `403`, 미인증 조회는 `401`인지 대조한다. 레지스트리 다운로드, 외부 공개, 개인 계정, 일반 앱 자동 설치는 없다. [Firefox 공용 Board](../../apps/firefox-ui-demo/docs/JOINT_BOARD_RUNTIME.md)는 현재 텍스트 카드용이다. 이는 최초 증명의 범위다. 이후 격리된 Firefox 기능 브랜치에서 배송·검수 두 가지 항목을 팀 서버에 연결했다. [운영자 실행과 사람별 편집 권한](../../apps/firefox-ui-demo/docs/JOINT_BOARD_RUNTIME.md#검토된-팀-앱-두-종류). 일반 패키지 관리기·OS 샌드박스·운영 게이트웨이는 별도다.
