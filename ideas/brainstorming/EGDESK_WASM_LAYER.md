# EG-Desk WASM Native Layer (초안)

**작성일**: 2026-04-17
**상태**: Brainstorming — skeleton. 기존 [`WASM_COMPONENT_MODEL_INTEGRATION.md`](WASM_COMPONENT_MODEL_INTEGRATION.md) 과 후속 머지 여부 검토
**관련**: [ADR-007](../../.claude/docs/decisions/007-firefox-shell-over-electron.md), [`FIREFOX_SHELL_STRATEGY.md`](../confirmed/FIREFOX_SHELL_STRATEGY.md) Layer 2

---

## 목적

Firefox chrome JS 가 "helper subprocess + WebSocket IPC" 경로를 회피하고 **in-process near-native 속도** 로 연산 헤비 기능을 제공할 레이어.

SpiderMonkey 내장 WebAssembly 실행기를 사용. Rust → `wasm32-unknown-unknown` 컴파일 → chrome JS 에서 `WebAssembly.instantiateStreaming()` 로 로드 → JS ↔ WASM 함수 호출.

## 용도

| 기능 | 왜 WASM? | 대안 vs WASM |
|------|----------|-------------|
| Vector similarity search (agent memory RAG) | 키스트로크마다 실행, latency 민감 | WebSocket IPC 대비 ~10x 빠름 |
| Syntax parser (tree-sitter) | 타이핑 중 실시간 파싱 | node.js tree-sitter 대비 동등 속도, in-process |
| Image/audio DSP (filter, thumbnail) | 사용자 직접 체감 | native addon 대비 slightly 느리나 sandbox |
| Cryptography (특수 요구시) | 표준 Web Crypto 로 부족한 경우 | WASM 으로 커스텀 curve/algorithm |
| Compression (custom format) | in-memory 처리 | |
| Local LLM inference (llama.cpp) | 메모리 공유 가능 | ollama/subprocess 대비 tight integration |

## 용도 아님 (→ helper 또는 chrome API)

- OS syscall (파일/프로세스/네트워크) → WASM sandbox. `IOUtils`, `Subprocess` 가 직접
- OS GUI (tray, hotkey) → helper 바이너리
- 대용량 파일 streaming → 메모리 제약, helper 나 Subprocess

## 컴파일 파이프라인

```
src/wasm/vector-search/
├── Cargo.toml
├── src/lib.rs          #[no_mangle] pub extern "C" fn search(...)
└── build.rs

cargo build --target wasm32-unknown-unknown --release
wasm-bindgen target/wasm32-unknown-unknown/release/vector_search.wasm \
  --out-dir pkg --target web --no-typescript

# 산출물: pkg/vector_search_bg.wasm + pkg/vector_search.js (JS glue)
# 이걸 profile/chrome/resources/wasm/ 에 복사
```

Chrome JS 측:

```js
const wasmUrl = 'chrome://userchromejs/content/resources/wasm/vector_search_bg.wasm';
const { instance } = await WebAssembly.instantiateStreaming(fetch(wasmUrl), imports);
const result = instance.exports.search(queryPtr, queryLen);
```

## JS ↔ WASM 인터페이스 패턴

### 옵션 A: Raw exports (최소, 빠름)

```rust
#[no_mangle]
pub extern "C" fn add(a: i32, b: i32) -> i32 { a + b }
```

- JS 에서 직접 호출
- 복잡한 데이터 (문자열, 배열) 는 pointer + length 로 수동 관리
- 가장 빠름, 가장 수고스러움

### 옵션 B: wasm-bindgen (권장)

```rust
use wasm_bindgen::prelude::*;

#[wasm_bindgen]
pub struct VectorSearch { /* ... */ }

#[wasm_bindgen]
impl VectorSearch {
  #[wasm_bindgen(constructor)]
  pub fn new() -> Self { /* ... */ }

  pub fn search(&self, query: &[f32], k: usize) -> Vec<u32> { /* ... */ }
}
```

- 문자열, Vec, struct, Option 등 자동 변환
- 생성된 `.js` glue 가 low-level 호출 추상화
- 약간의 오버헤드 (호출당 μs 단위) 지만 DX 압도적

### 옵션 C: Component Model (미래)

[WASI Component Model](https://component-model.bytecodealliance.org/) 이 안정화되면 타입 안전 cross-language 인터페이스 가능. 현재는 preview 단계. 지속 모니터링 ([`WASM_COMPONENT_MODEL_INTEGRATION.md`](WASM_COMPONENT_MODEL_INTEGRATION.md)).

## 메모리 전략

WASM linear memory 는 독립. JS ↔ WASM 데이터 전달 시:

- **Small** (숫자, 짧은 문자열): wasm-bindgen 이 copy
- **Large** (대용량 배열, 이미지): `SharedArrayBuffer` 또는 `WebAssembly.Memory` 공유 후 view 전달 (복사 없음)

```js
const wasmMem = new Uint8Array(instance.exports.memory.buffer);
const input = new Float32Array(wasmMem.buffer, inputPtr, inputLen);  // zero-copy view
```

## 예상 모듈 카탈로그 (초안)

| 모듈 | 근거 crate | 크기 (wasm) | 용도 |
|------|-----------|-----------|------|
| `vector-search` | `hnsw_rs` 또는 `faer` | ~500KB | Agent memory RAG |
| `syntax-parser` | `tree-sitter` + grammar wasm | ~1MB + grammar 별 추가 | Code editor 카드 |
| `markdown` | `pulldown-cmark` | ~150KB | Notes 카드 |
| `image` | `image` crate (부분 feature) | ~400KB | Thumbnail, 리사이즈 |
| `audio-dsp` | `rubato`, `creek` | ~300KB | 음성 wake word 전처리 (helper 로 가도 됨) |
| `tokenizer` | `tiktoken-rs` | ~200KB | LLM 토큰 카운팅 |
| `fuzzy-search` | `nucleo`, `skim-matcher` | ~100KB | Cmd+K Spotlight 같은 UI |

## 초기 유스케이스 (Path 2+WASM 의 첫 모듈)

1. **tokenizer** — agent context 길이 계산용. Node `tiktoken` npm 패키지 대응. ~1주
2. **fuzzy-search** — Cmd+K Spotlight 에 실시간 fuzzy match. ~1주
3. **markdown renderer** — Preset Bag / Notes 카드 렌더. ~1주

가장 간단한 것부터 PoC 하며 툴체인 (cargo + wasm-bindgen + chrome JS 로드) 을 안정화.

## 빌드 & 패키징

```
repo/
├── src/renderer/            (기존 Electron, 이관 대상)
├── src/chrome/              (새 chrome JS layer)
├── src/wasm/                (Rust WASM 모듈들)
│   ├── tokenizer/
│   ├── fuzzy-search/
│   └── ...
├── src/helper/              (egdesk-helper Rust)
└── packaging/
    └── scripts/             (재패키징 자동화)
```

CI 에서:
```
cargo build --target wasm32-unknown-unknown --release
wasm-bindgen ...
cp pkg/*.wasm pkg/*.js → profile-chrome/chrome/resources/wasm/
```

## 기존 [`WASM_COMPONENT_MODEL_INTEGRATION.md`](WASM_COMPONENT_MODEL_INTEGRATION.md) 과 관계

기존 문서는 Component Model 중심으로 **장기 비전** 관점. 본 문서는 **현재 (2026) 실용 stack** — wasm-bindgen + raw WASM. 향후 Component Model 안정화 시 한 문서로 병합 또는 upgrade path 명시.

## 오픈 이슈

- [ ] Chrome JS 에서 WASM 로드 경로 (`chrome://` vs `resource://` vs 파일)
- [ ] CSP / integrity 체크 (서명된 WASM?)
- [ ] 모듈 버전 관리 + 업데이트
- [ ] JS ↔ WASM 호출 오버헤드 벤치마크 (실측 필요)
- [ ] Worker thread 로 분리 실행 (메인 UI freeze 방지)
- [ ] Source map / 디버깅 (Firefox WASM debugger)

## 다음 단계

1. PoC: `tokenizer` WASM 모듈 + chrome JS 에서 로드 + 호출 round-trip 확인
2. 벤치마크: JS ↔ WASM 호출 latency, 메모리 오버헤드
3. 빌드 스크립트 표준화 (repo wide cargo workspace)
4. 두 번째 모듈 (`fuzzy-search`) 로 파이프라인 재사용성 검증
