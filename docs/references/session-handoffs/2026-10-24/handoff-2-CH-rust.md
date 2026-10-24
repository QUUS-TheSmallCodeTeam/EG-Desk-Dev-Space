[화면 연결·bridge 작업자] codex-bridge-server.mjs에 붙이는 방법:
```js
import { createHostAgent, resolveHostAgentExecutable } from './egdesk-host-agent.mjs'
import { createHostActivity, HOST_ACTIVITY_SSE_EVENT } from './egdesk-host-activity.mjs' // 'host.activity'
const activity = createHostActivity()
let agent = null
try { agent = createHostAgent({ executable: resolveHostAgentExecutable(), onEvent: e => { const row = activity.noteHostEvent(e); if (row) sse(HOST_ACTIVITY_SSE_EVENT, row) } }) } catch {} // HOST_AGENT_UNSUPPORTED/EXECUTABLE면 기능 끔
agent?.start().catch(() => {}) // stop이나 'failed'일 때만 reject됨
// runtime이 'computer.used'를 내보낼 때: const row = activity.noteComputerUse(details); if (row) sse('host.activity', row)
// GET /host/activity → { rows: activity.list({ sinceAt, limit }), summary: activity.summary(), agent: agent?.status() ?? { state: 'off' } }
// bridge 종료 시 await agent?.stop()
// lease를 쓴다면: const lease = createHostLease({ guardAlive: agent.guardAlive }); agent.attachLease(lease) → lease는 reasons ['monitor']로 'unavailable' 유지
```
행 모양: front-app `{seq, at, kind, app:{bundleId,name,pid}, previous, duringCodex, returnedAfterMs?}` / service `{kind:'service', bundleId:'com.openai.sky.CUAService', running, pidCount}` / codex-computer `{kind, runId, calls, active}`. summary: `{controller:'codex-computer-use'|'none', frontApp, service:{running,since}, codex:{active,runId,calls,lastAt}}`. 화면 문구(예: "현재 제어자: Codex 컴퓨터 조작(OpenAI)")는 화면 쪽에서 정합니다. status().stderrTail은 진단용이고 화면에 내보내지 않습니다.

[다음 단계: .app 번들·서명]
- 'EG-Desk Host Agent.app'의 Info.plist: CFBundleIdentifier(고정 값, 예: com.egdesk.hostagent — 정해야 함), CFBundleName·CFBundleDisplayName, CFBundleExecutable(egdesk-helper 사본), CFBundlePackageType=APPL, CFBundleShortVersionString·CFBundleVersion, LSUIElement=true(Dock에 안 보임), LSMinimumSystemVersion, NSHighResolutionCapable. 손쉬운 사용·화면 기록·입력 모니터링은 시스템 설정에서 허락하는 방식이라 Info.plist 사용 설명 문자열이 필수는 아닌 것으로 [의견] 보고 있으며 확인이 필요합니다. Apple Events는 쓰지 않으므로 NSAppleEventsUsageDescription과 그 entitlement는 넣지 않습니다.
- 서명: 개발용 ad-hoc(`codesign -s -`)은 빌드마다 cdhash가 바뀌어 TCC 허락이 풀릴 수 있습니다(U11 확인 필요). Apple Development 또는 Developer ID 인증서로 `codesign --force --options runtime --timestamp --sign "<identity>" "EG-Desk Host Agent.app"`을 쓰고, 외부 배포 시 `xcrun notarytool submit --wait` 뒤 `xcrun stapler staple`. Hardened runtime에 추가 entitlement는 필요 없는 것으로 [의견] 보고 있습니다(sandbox 없음).
- 실행: TCC 권한 주체를 이 앱으로 만들려면 LaunchServices로 띄웁니다(`/usr/bin/open -g -n -a <app> --args host-observe --socket <p> --nonce-from env --parent-liveness none`; 문서 8장 추정). 이때는 stdin이 없어 heartbeat만으로 생존을 판단합니다. nonce를 env(`open --env`)로 넘기면 open 프로세스 argv에 잠깐 보이므로 `--nonce-file <0700 디렉터리 안 0600 파일, 읽고 삭제>` 옵션 추가를 권합니다(미구현). 부모 pid 감시(kqueue NOTE_EXIT)도 이 경로에서 같이 넣으면 좋습니다.

[Main 개발자] 커밋할 파일은 files_changed입니다. 작업 트리에는 다른 작업자가 바꾼 helper/*.mjs가 많으니 섞지 마세요. 제가 바꾸지 않은 파일: egdesk-host-lease.mjs, egdesk-computer-adapter.mjs, terminal-rust-process.mjs, terminal-worker/*.

[참고·부작용] 처음에 레퍼런스 폴더(scratchpad/refs/cua) 안에서 `cargo --version`을 한 번 실행했습니다. 그 폴더의 rust-toolchain.toml 때문에 rustup이 toolchain 1.97.1을 ~/.rustup에 내려받았습니다. 빌드에는 쓰지 않았고(helper-rust는 stable 1.95.0), 지울지는 대표님 판단입니다.