# WASM_COMPONENT_MODEL_INTEGRATION

WebAssembly Component Model을 활용한 EG-DESK 성능 최적화 및 네이티브 모듈 대체 전략.

**출처**: [Making WebAssembly a First-Class Language on the Web - Mozilla Hacks (2026.02)](https://hacks.mozilla.org/2026/02/making-webassembly-a-first-class-language-on-the-web/)

> ## 🟢 본 문서는 **장기 비전** (Component Model). 현재 실용 stack 은 [`EGDESK_WASM_LAYER.md`](EGDESK_WASM_LAYER.md) — wasm-bindgen 기반.
>
> Firefox shell pivot (ADR-007) 에서 WASM 은 **Layer 2 in-process native** 역할로 채택. 현재 (2026) 는 wasm-bindgen + raw WASM 사용. Component Model 안정화 시 본 문서로 upgrade.
>
> **관련**: [`FIREFOX_SHELL_STRATEGY.md`](../confirmed/FIREFOX_SHELL_STRATEGY.md) Layer 2, [`EGDESK_WASM_LAYER.md`](EGDESK_WASM_LAYER.md)

---

## 배경: WebAssembly의 현재 문제

WebAssembly는 웹에서 **2급 언어**. 모든 Web API 호출이 JS 글루 코드를 경유해야 함.

```
현재:  Wasm → JavaScript 글루 코드 → Web API
목표:  Wasm Component → Web API (직접)
```

### 글루 코드의 비용

- TodoMVC 벤치마크: 글루 코드 제거 시 **45% 성능 향상** (Mozilla Dodrio 실험, 2020)
- 메모리 버퍼 관리, 타입 변환, 직렬화/역직렬화 오버헤드
- node-gyp 빌드 체인의 크로스 플랫폼 고통

### Component Model이란?

2021년부터 개발 중인 W3C 표준 제안. 핵심:

1. WIT(WebAssembly Interface Types)로 인터페이스 정의
2. 여러 언어(Rust, C++, Go 등)에서 Component 생성 가능
3. JS 글루 코드 없이 Web API 직접 접근
4. `<script type="module" src="component.wasm">` 으로 로드

```wit
// WIT 인터페이스 정의 예시
component {
  import std:web/console;
}
```

```rust
// Rust에서 바로 웹 API 사용
use std::web::console;
fn main() {
    console::log("hello, world");
}
```

```html
<!-- JS 글루 코드 없이 로드 -->
<script type="module" src="component.wasm"></script>
```

---

## EG-DESK 적용 영역

### 1. node-gyp 네이티브 모듈 대체 (가장 직접적 이득)

현재 Electron에서 네이티브 모듈(SQLite 등) 사용 시:

```
C++ → node-gyp → OS별 빌드 → electron-rebuild → 배포
```

Component Model 성숙 시:

```
Rust/C++ → wasm component → 모든 OS에서 그냥 동작
```

**이점**: 빌드 지옥 제거, 크로스 플랫폼 배포 단순화, CI/CD 파이프라인 간소화

### 2. 성능 크리티컬 모듈 Wasm 전환

| 현재 (JS/TS) | Wasm Component 전환 시 이점 |
|---|---|
| **AES-256 암호화** | Rust 구현 → 네이티브급 속도 (JS crypto 대비 수배) |
| **SQLite 바인딩** | node-gyp 제거 + 크로스 플랫폼 |
| **Canvas 연산** (Infinite Canvas) | 좌표 변환, hit detection, viewport 계산 오프로드 |
| **데이터 파싱** (Data Irrigation) | 대용량 텍스트/바이너리 파싱 |
| **Playwright 셀렉터 매칭** | DOM 파싱, 패턴 매칭 반복 연산 |

### 3. 온프레미스 LLM 추론

- llama.cpp가 이미 Wasm 빌드 지원
- Component Model 적용 시 GPU 없는 환경에서 **앱 내 임베디드 CPU 추론** 가능
- 현재: 별도 프로세스로 LLM 서버 실행 → 미래: Theia 내 직접 실행
- 단, GPU 가속 필요 시에는 여전히 네이티브 실행이 유리

### 4. APP_RUNTIME_ARCHITECTURE와의 시너지

`ideas/brainstorming/APP_RUNTIME_ARCHITECTURE.md`에서 이미 사용자 앱 레이어에 WASM을 언급:

```
EG-DESK (Electron)
  ├─ UI Layer: Electron (Chromium)
  ├─ User App Layer: Node.js/WASM ← Component Model로 강화
  └─ System Layer: Rust → Wasm Component로 전환 가능
```

Component Model이 성숙하면:
- 사용자 앱을 Wasm Component로 패키징 → **언어 무관 플러그인 시스템**
- Rust/C++/Go로 작성된 고성능 앱도 EG-DESK 내에서 네이티브급 실행
- 보안 샌드박스 내장 (Wasm의 메모리 격리)

---

## 현재 표준 진행 상태

| 항목 | 상태 | 비고 |
|------|------|------|
| Component Model 표준 | 설계 중 (2021~) | W3C WebAssembly CG |
| WIT (Interface Types) | 안정화 단계 | 여러 언어 도구체인 지원 |
| 브라우저 네이티브 지원 | 아직 없음 | 폴리필(Jco)로 시험 가능 |
| ESM Integration | 제안 단계 | `<script src="x.wasm">` |
| Electron 지원 | 미정 | Chromium 따라감 |
| Mozilla 참여 | 설계 참여 중 | 적극적 |
| Google 참여 | 평가 단계 | |

### 시험 가능 도구

- **Jco**: Component Model 폴리필 (브라우저에서 시험)
- **Wasmtime**: 서버사이드 Wasm 런타임 (Bytecode Alliance)
- **wit-bindgen**: WIT에서 언어별 바인딩 생성
- **cargo-component**: Rust → Wasm Component 빌드 도구

---

## 권장 액션

### 단기 (지금)

- 표준 진행 상황 추적 (WebAssembly CG 미팅 노트, Mozilla Hacks 블로그)
- Jco 폴리필로 간단한 PoC 시험 (예: Rust로 AES-256 → Wasm Component → Electron에서 로드)

### 중기 (브라우저 지원 시)

- SQLite Wasm Component 전환 → node-gyp 제거 검증
- Canvas 연산 모듈 Wasm 전환 벤치마크
- APP_RUNTIME_ARCHITECTURE의 Wasm 레이어 구체화

### 장기 (생태계 성숙 시)

- EG-DESK 플러그인 시스템을 Wasm Component 기반으로 설계
- 온프레미스 LLM 추론 Wasm 임베딩 검토
- 사용자 앱 Wasm Component 패키징 표준화

---

## 참고 자료

- [Making WebAssembly a First-Class Language on the Web - Mozilla Hacks](https://hacks.mozilla.org/2026/02/making-webassembly-a-first-class-language-on-the-web/)
- [WebAssembly Component Model - GitHub](https://github.com/WebAssembly/component-model)
- [Jco - Bytecode Alliance](https://github.com/bytecodealliance/jco)
- [Wasmtime](https://wasmtime.dev/)
- [wit-bindgen](https://github.com/bytecodealliance/wit-bindgen)
