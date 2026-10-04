# Jev 기반 EG-Desk 시스템 고도화 제안서 (JEV Integration Suggestions)

**Date**: 2026-09-19  
**Status**: Brainstorming / Draft  
**Target Systems**: EG-Desk Firefox Shell (`apps/firefox-ui-demo`), Codex Bridge, Desk Windows (Browser, Terminal, HUD, Board, Ontology)  
**Core References**:
- [`ideas/brainstorming/COGNITIVE_ARCHITECTURE_ANALOGY.md`](file:///Users/minsoocha/Projects/EG-Desk-Dev-Space/ideas/brainstorming/COGNITIVE_ARCHITECTURE_ANALOGY.md) (신경계 대응 모델, 해마 파일 라이프사이클, 4-type 인지 태깅, 작업기억 스코프 관리)
- [`docs/vision/ontology-bridge.md`](file:///Users/minsoocha/Projects/EG-Desk-Dev-Space/docs/vision/ontology-bridge.md) (온톨로지 브릿지: 객체와 장소의 평탄화 극복, 서재-선반-책상-서랍 메타포)
- [`apps/firefox-ui-demo/docs/ONTOLOGY_VISUAL_DESIGN_SPEC.md`](file:///Users/minsoocha/Projects/EG-Desk-Dev-Space/apps/firefox-ui-demo/docs/ONTOLOGY_VISUAL_DESIGN_SPEC.md) (과거·현재·미래 시간축 및 가상·물리 레이어 복합 렌즈 명세)
- [`ontology/schema.md`](file:///Users/minsoocha/Projects/EG-Desk-Dev-Space/ontology/schema.md) (온톨로지 스키마, 스냅샷, 시간축 전이 관계 엣지)
- [`apps/firefox-ui-demo/docs/BROWSER_AGENT_OBSERVATION_RUNTIME.md`](file:///Users/minsoocha/Projects/EG-Desk-Dev-Space/apps/firefox-ui-demo/docs/BROWSER_AGENT_OBSERVATION_RUNTIME.md) (브라우저 에이전트 관측 런타임)
- [`apps/firefox-ui-demo/docs/HUMAN_IN_LOOP_WORKFLOW_AWAIT_MODEL.md`](file:///Users/minsoocha/Projects/EG-Desk-Dev-Space/apps/firefox-ui-demo/docs/HUMAN_IN_LOOP_WORKFLOW_AWAIT_MODEL.md) (Await 모델)
- [`apps/firefox-ui-demo/docs/CHAT_CANVAS_AGENT_LAYER_MODEL.md`](file:///Users/minsoocha/Projects/EG-Desk-Dev-Space/apps/firefox-ui-demo/docs/CHAT_CANVAS_AGENT_LAYER_MODEL.md) (챗-캔버스 레이어 모델)

---

## 1. 개요 (Overview)

### 1.1 Jev란 무엇인가?
Jev는 TypeSafe AI에서 개발한 **소프트웨어 자동화 전용 System 1(직관적·신속한 판단) AI 모델**이다.
- **비생성형(Non-Autoregressive)**: 문장을 단어 단위로 생성(text generation)하지 않고, 비정형 상태(DOM 트리, 로그, diff, JSON 등)를 입력받아 엄격한 타입의 결정(`Choice`, `Score`, `Noul/Boolean`)과 RLCD(Reinforcement Learning for Calibrated Decisions) 기반의 보정된 확률(Confidence)을 반환한다.
- **초저지연 & 초저비용**: 일반 프론티어 LLM(GPT-4o, Claude 등) 대비 **40~200배 빠르고(20ms~100ms)**, 비용은 **40~400배 저렴**하다.

### 1.2 EG-Desk와의 아키텍처적 시너지
EG-Desk는 브라우저(Firefox Shell), 터미널, 온톨로지, 코덱스 챗(Codex HUD), 보드(Board)가 단일 캔버스에 유기적으로 연결된 **컴퓨터 레벨 작업 환경(Live Work Surface)**이다.
기존 에이전트 시스템은 단순한 버튼 클릭, 쉘 프롬프트 대기, 로그 파싱 등 사소한 상태 체크에도 무거운 LLM(System 2, Codex)을 호출하여 **레이턴시 누적(매 액션마다 2~5초 대기)**, **토큰 비용 폭증**, **컨텍스트 오염**을 겪었다.

Jev를 **System 1(감각 및 반사신경, 센서, 가드레일)**으로 배치하고, Codex를 **System 2(고수준 계획, 추론, 최종 코드/답변 생성)**로 분리함으로써 EG-Desk의 실시간 반응성과 안정성을 비약적으로 향상시킬 수 있다.

---

## 2. 세부 제안 및 아키텍처 분석

---

### Pillar 1. [Browser Card] 초고속 DOM 액션 리플렉스 (System 1/2 하이브리드 제어)

#### 문제 의식 & 챌린지: 챗(Codex) ↔ 브라우저(Jev) 연동 및 싱크
브라우저 제어에서 Jev가 20ms 단위로 초고속 클릭/입력을 수행할 때, "상위 챗(Codex)과의 상태 동기화, 사용자 시각적 확인, 롤백/에스컬레이션"을 어떻게 처리할 것인가?

#### 해결 레퍼런스 및 아키텍처 모델
* **레퍼런스 프로젝트**: `jev-ultrafast`, BrowserGym/WorkArena의 Macro-Micro 계층형 에이전트 구조.
* **EG-Desk 접점**: `apps/firefox-ui-demo/docs/BROWSER_AGENT_OBSERVATION_RUNTIME.md`, `CANVAS_RUN_PLAYBACK_MODEL.md`.

```text
[User / Chat (Codex)] 
      │ 
      │ 1. Sub-goal 하달: "로그인 폼 채우고 대시보드로 이동"
      ▼
[EG-Desk Browser Window Shell]
      │ 
      ├─► [Jev Reflex Loop (Firefox Chrome 내부, sub-30ms)]
      │     ├─ DOM Snapshot + Sub-goal -> Choice(action)
      │     ├─ act(cardId, action) -> DOM diff 발생
      │     ├─ history.push(actionEntry)
      │     └─ 루프 반복 (Click -> Fill -> Submit)
      │
      ├─► [종료 조건 판정]
      │     ├─ Goal 달성 (Choice: COMPLETE, Confidence > 0.9)
      │     │    └─► Chat에 압축 완료 통보 ("로그인 후 대시보드 진입 완료")
      │     └─ 막힘/이상 감지 (Choice: ESCALATE, Confidence < 0.7)
      │          └─► Codex/User 개입 요청 ("2FA 인증 번호 입력 필요")
```

#### 핵심 구현 규칙
1. **Chat은 '채팅', Canvas는 '행동'**:
   - Jev의 미세 액션(클릭 1회, 포커스 1회)마다 챗창에 말풍선을 띄우지 않는다.
   - 미세 액션은 `browserAgent.history(cardId)` 및 브라우저 카드의 시각적 런 인스펙터(Run Playback/Briefing)에만 실시간 기록된다.
2. **에스컬레이션 트리거**:
   - 예상치 못한 팝업, 캡차, 신규 권한 요구 시 Jev가 `ESCALATE`를 즉시 반환하여 Codex에게 제어권을 넘긴다.

---

### Pillar 2. [Human-in-the-Loop & Engine] 시맨틱 상태 감지기 (Semantic Condition Arbiter)

#### 문제 의식
터미널이나 브라우저 자동화에서 조건 분기(`if ... else`)나 정규식 매칭은 매우 취약(brittle)하다. CLI 라이브러리 버전이나 웹사이트 UI가 조금만 바뀌어도 정규식이 깨져 워크플로가 멈추거나 무한 대기에 빠진다.

#### 해결 방식: Jev `Noul`(Boolean) & `Choice`로 컨디션 체크 대체

#### 구체적 적용 예시 목록

| 대상 영역 | 기존의 취약한 방식 | Jev 시맨틱 컨디션 체크 방식 | 반환 타입 |
| :--- | :--- | :--- | :--- |
| **OAuth / SSO 로그인** | 리디렉트 URL 정규식 검사 (특정 쿼리 파라미터 확인) | `Noul: "사용자가 인증을 마치고 최종 로그인 상태에 도달했는가?"` | Boolean |
| **개발 서버 준비 상태** | stdout에서 `/ready/i`, `/compiled/i` 정규식 파싱 | `Noul: "개발 서버가 에러 없이 포트를 열고 연결 가능한 상태인가?"` | Boolean |
| **CLI 페이저/입력 대기** | 프로세스가 안 끝났을 때 타임아웃 처리 | `Choice: ["running_output", "waiting_yn_input", "waiting_password", "stuck_in_pager", "completed"]` | Choice |
| **캡차/봇 차단 감지** | 특정 클래스명(`.recaptcha`) 존재 여부 DOM 쿼리 | `Noul: "Cloudflare, reCAPTCHA 등 봇 차단 화면이 노출되었는가?"` | Boolean |
| **빌드/테스트 성공 판정** | 종료 코드(exit code) 0 의존 (경고나 soft error 누락) | `Score(0-100, "Build/Test Health")` + 에러 존재 여부 판정 | Score / Noul |
| **Git 충돌/Unsaved 감지** | `git status` 파싱 및 파서 에러 | `Noul: "현재 워크트리에 사용자의 미커밋된 의도적 작업 파일이 충돌 상태인가?"` | Boolean |

---

### Pillar 3. [Terminal / Safety] 맥락 기반 사전 실행 안전 가드레일 (Contextual Safety Gate)

#### 문제 의식: `rm -rf`를 무조건 막는 룰베이스의 한계
- `rm -rf dist` 나 `rm -rf node_modules`는 개발자가 하루에도 수십 번 실행하는 정상적인 빌드 정리 명령어이다.
- 반면 `rm -rf src/`, `rm -rf /`, `rm -rf ~`, `rm -rf "$TARGET/*"`(TARGET 변수가 빈 경우)는 치명적인 재앙이다.
- 정규식 블랙리스트는 정상 작업의 피로도를 극대화하거나, 교묘한 우회(변수 치환 등)에 뚫린다.

#### Jev 기반 해결 모델: 맥락적 위험도 스코어링 (`Score`)
- **실행 전 검사(Pre-flight Gate)**: 터미널 PTY helper(`helper-rust`) 또는 Node Bridge가 명령어를 OS에 전달하기 직전 Jev를 호출 (지연시간 < 30ms).
- **입력 데이터**:
  ```json
  {
    "working_directory": "/Users/minsoocha/Projects/EG-Desk-Dev-Space/apps/firefox-ui-demo",
    "command": "rm -rf node_modules",
    "agent_intent": "Clean re-install dependencies",
    "git_tracked_status": "untracked / gitignored"
  }
  ```
- **Jev 질의**: `Score(0 ~ 100, "Destructive/Irreversible Risk")`
  - `rm -rf node_modules` -> **Score: 8** (무시하고 즉각 실행)
  - `rm -rf src/` -> **Score: 92** (즉각 인터럽트 -> `approval-required` 카드 띄움)
  - `git reset --hard HEAD~5` -> **Score: 85** (사용자 승인 모달 호출)
  - `kill -9 $(lsof -t -i:3000)` -> **Score: 18** (정상 통과)

---

### Pillar 4. [Desk HUD] 초고속 인텐트 라우팅 및 액션 랭킹

#### 주의: Jev는 텍스트를 '생성'하지 않는다
Jev는 자동완성 문장을 작문하는 모델이 아니다. 따라서 HUD에서의 역할은 **"입력 텍스트의 의도 분류(Classification)"**와 **"등록된 시스템 액션 후보의 랭킹(Action Ranking)"**이다.

#### 동작 방식
1. **타깃 윈도우/앱 즉시 라우팅 (`Choice`)**:
   - 사용자가 HUD에 타이핑할 때 20ms 이내에 다음 목적지 중 하나로 결정:
     - `Choice: ["BROWSER_NAVIGATE", "TERMINAL_EXEC", "ONTOLOGY_LOOKUP", "CODEX_CHAT", "SETTING_ACTION"]`
   - 효과: URL을 치면 브라우저 카드로, 명령어를 치면 터미널 카드로, 복잡한 질문을 치면 코덱스로 입력 포커스가 딜레이 없이 전환됨.
2. **사전 정의된 액션 팔레트 스코어링 (`Score`)**:
   - 현재 데스크 상태(예: 브라우저가 열려있고, 터미널이 에러로 종료됨) + 사용자 입력 문자열을 바탕으로 EG-Desk 내장 기능(예: `Inspect DOM`, `Restart Dev Server`, `Re-run Tests`, `Git Commit`)에 점수를 매겨 최적의 후보를 상단에 제안(Suggest).

---

<a id="pillar-5-agenda-memory-장기-세션-컨텍스트-압축기-compactor-메커니즘"></a>
### Pillar 5. [Board Memory] 장기 세션 컨텍스트 압축기 (Compactor) 메커니즘

#### 질문과 핵심 쟁점
> "압축 자체도 LLM이 하는 것 아닌가? LLM에게 제안 목록을 주는 건가, 아니면 직접 자르는(trim) 건가? 자르면 문맥의 단절(gap)이 생기지 않는가? Jev는 생성하지 못하고 참/거짓/선택만 하는데 어떻게 '툴 호출 blah blah -> 툴 호출 성공'으로 요약하는가?"

#### 해결 메커니즘: 결정론적 구조적 가지치기 + 템플릿 슬롯팅 (Structural Pruning & Template Slotting)

`fast-jev-compaction` 패턴은 LLM에게 비싼 돈을 주고 수만 토큰짜리 텍스트를 새로 요약하게 시키지 않는다. 

```text
[기존 무거운 LLM 요약 방식]
  80k 토큰 전체를 LLM(Claude/GPT)에 전달 -> 5~10초 대기 -> 
  "이전 작업들을 요약해줘" -> LLM이 긴 줄글로 요약 (환각 위험, 높은 비용)

[Jev 구조적 압축 방식]
  메시지/툴 블록 리스트 -> 각 블록을 Jev가 30ms 만에 분류/채점 -> 
  결정론적 템플릿으로 슬롯 치환 (0초 생성, 제로 환각, 90% 토큰 절감)
```

#### 구체적 압축 단계
1. **블록별 역할 및 수명 분류 (`Choice`)**:
   컨텍스트 창의 개별 블록에 대해 Jev가 판단:
   - `Choice: ["USER_GOAL", "CURRENT_ACTIVE_TASK", "STALE_INTERMEDIATE_LOG", "ERROR_TRACE_RESOLVED", "CRITICAL_FACT"]`
2. **템플릿 기반 치환 (Template Replacement - 생성 불필요)**:
   - 예를 들어 300줄짜리 `grep`이나 터미널 빌드 로그:
     - Jev가 `STALE_INTERMEDIATE_LOG`로 분류 (결과가 이미 다음 스텝에 반영됨).
     - 자의적인 텍스트 요약 대신, 시스템이 사전에 준비한 **고정 템플릿**으로 치환:
       ```text
       [System: 320 lines of build log omitted. Exit code: 0, Output verified]
       ```
   - 연속된 5번의 파일 읽기/실패 탐색 과정:
     - `[System: Inspected 5 files; active context preserved for path/to/target.ts]`
3. **단절(Gap)이 생기지 않는 이유**:
   - **앵커(Anchor) 보존**: 사용자의 최초 목표(Goal), 최종 수정된 파일 경로, 핵심 에러 메시지는 Jev 점수(`Criticality Score > 80`)에 의해 무조건 원본 그대로 유지된다.
   - 중간 탐색 과정(삽질했던 grep 결과, 이전 DOM 스냅샷 차분 5개 등)만 구조화된 템플릿 한 줄로 접히기(collapse) 때문에, Codex 입장에서 논리적 맥락은 100% 보존되면서 토큰만 극적으로 줄어든다.

---

## 3. Jev 오픈소스 대안 생태계 및 로컬 구현 모델 분석 (Open Source Reproductions & Alternatives)

### 3.1 배경 및 커뮤니티 동향 (Hugging Face Tracker)
TypeSafe AI의 Jev는 독점 클라우드 API(1.13.0, GPT-5.6 Terra급 결정 능력)로 최상의 정확도와 보정(Calibration)을 제공하지만, **로컬 오프라인 구동 불가**, **외부 네트워크 레이턴시(120~250ms)**, **API 호출 비용 및 벤더 종속성**이라는 구조적 한계가 존재한다.
특히 EG-Desk와 같이 Mac 로컬 환경(Apple Silicon)에서 상시 구동되는 워크스페이스 OS에서는 **밀리초(ms) 단위의 로컬 척수 반사(Spinal Reflex)**를 담당할 오픈소스 경량 엔진이 필수적이다.

2026년 9월 중순, Hugging Face 커뮤니티의 **`multimodalart/jev-reproductions-tracker`**를 중심으로 Jev의 의사결정 원리를 역공학하거나 재현하려는 수십 개의 오픈소스 프로젝트가 등장했다. 커뮤니티의 기술적 시도는 크게 **4대 패러다임**으로 분화되어 경쟁하고 있다.

---

### 3.2 오픈소스 대안의 4대 기술 패러다임

```text
                           [Jev 오픈소스 대안 생태계]
                                      │
    ┌──────────────────┬──────────────┴──────────────┬──────────────────┐
    ▼                  ▼                             ▼                  ▼
[패러다임 1]         [패러다임 2]                  [패러다임 3]         [패러다임 4]
병렬 제약 디코딩     디퓨전 LM 기반                전용 결정 헤드 / RLCD  전통적 양방향 인코더
(PCD / Logit 추출)   (Diffusion Language Model)    (Trained Head / RLCD) (Prior Art / NLI)
- 가중치 학습 불필요  - 1-Step Denoising            - 실제 가중치 파인튜닝 - 전통적 분류기
- 기존 LLM logit 읽기- vLLM PR #57250              - Choice/Score/Noul  - DeBERTa / GLiNER
- TheoLee, SGLang    - GitHub Next (LocalJev)      - NanoJev, Verdict   - KotobaLabs
```

#### ① 패러다임 1: 병렬 제약 디코딩 (Parallel Constrained Decoding / PCD, 무학습 로짓 추출)
* **메커니즘**: 별도의 가중치 학습 없이, 기존 오픈소스 LLM(Qwen, Gemma 등)의 KV 캐시를 공유한 채 `lm_head`의 로짓(Logit)에서 특정 후보 토큰의 확률만 병렬로 1-pass 추출.
* **주요 프로젝트**:
  * **`harshagundal/Qwen-2.5-1B-RLCD`**: JSON 스키마의 모든 필드 키를 일괄 배치화하여 카테고리 확률을 로짓에서 직접 추출. 일반 JSON 생성 대비 ~5배 빠름 (조회수 114만 회 돌파).
  * **`TheoLeeCJ/openjev` (openjev.com)**: Qwen3.5-4B 백본. 21개 결정을 1.02초에 처리 (일반 텍스트 생성 5.33초 대비 5배 이상 단축). CUDA 및 WebGPU 브라우저 데모 지원 (GitHub Star 1,400+).
  * **`ekzhang/openjev-sglang`**: Qwen3.6-35B-A3B(MoE) 백본. SGLang의 **Radix Cache**를 사용하여 공유 프리필(Prefill)을 상시 유지. 텍스트 생성을 완전히 배제하고 64개 의사결정 태스크를 1초 미만에 처리하는 `/v1/systemone` 호환 엔드포인트 제공.
  * **`Micha0827/snapjudge` & `zhengxuyu/LitJev`**: Apple Silicon(Mac MLX) 환경 최적화. Qwen3.8-27B를 구동하여 TypeSafe의 20개 공개 벤치마크(373개 결정) 테스트 결과 **Jev 대비 81.2% 일치율(Agreement)** 달성. (단, 신뢰도 스코어가 실제 에러율과 완벽히 비례하지 않는 캘리브레이션 한계 확인).
* **평가**: 기존 로컬에 설치된 LLM을 즉시 활용할 수 있어 개발 비용이 가장 낮으나, 확률 보정(Confidence Calibration)이 엄밀하지 않음.

#### ② 패러다임 2: 디퓨전 언어 모델 (Diffusion LMs in "Jev Mode")
* **메커니즘**: 좌에서 우로 한 토큰씩 순차 생성(Autoregressive)하지 않고, 전체 문맥 캔버스에서 레이블/슬롯 영역만 마스킹한 후 **단 1회의 디노이징(1-Step Denoise)** 과정으로 전체 후보 확률 분포를 병렬 추출.
* **주요 프로젝트**:
  * **Matt Mastracci (`vLLM PR #57250`)**: `DiffusionGemma`에 Jev 스타일의 구조화 결정 모드를 구현하여 vLLM 공식 PR 제출. 실측 벤치마크에서 Jev 정식 API와 대등한 속도 및 정확도를 기록 (roughly tied).
  * **`githubnext/localjev` (GitHub Next)**: GitHub Next 팀이 내부 개발자용으로 제작한 공식 브릿지. Bun + TypeScript 환경에서 oMLX `DiffusionGemma 26B-A4B`를 백엔드로 엮어 TypeSafe `/v1/systemone`과 100% 와이어 호환 서버 제공 (1,200회 요청 bake-off 테스트 포함).
  * **`razorback16/openjev` (`api.codiv.ai`)**: DiffusionGemma 26B-A4B NVFP4 양자화 모델을 호스팅하여 공개 API 엔드포인트 제공.
* **평가**: 비생성형 판단이라는 Jev의 본질에 구조적으로 가장 근접하며 정확도가 우수하지만, 모델 크기가 크고 전용 디퓨전 추론 런타임이 요구됨.

#### ③ 패러다임 3: 전용 결정 헤드 및 RLCD 파인튜닝 모델 (Trained Head / RLCD)
* **메커니즘**: 경량 트랜스포머 인코더나 LLM 백본 상단에 다중 후보 분류용 MLP/Scoring Head를 부착하고, 실제 의사결정 데이터셋으로 가중치를 파인튜닝.
* **주요 프로젝트**:
  * **`heman10x/rlcd-modernbert-151m` ("OpenJev Verdict")**:
    * 파라미터: **151M** (생태계 내 최소형).
    * 성능: 25개 후보 슬롯 판별 + 기권(Abstention) 지원, **지연시간 35ms 미만**.
    * 라이선스: Apache-2.0, WebGPU 지원으로 브라우저 내부 및 초경량 로컬 데몬 구동에 최적.
  * **`TianyuCodings/NanoJev`**:
    * 파라미터: **0.6B (Qwen3-0.6B 기반)**.
    * 성능: 2~255개 후보에 대한 Choice / Boolean / Score 단일 패스 판별, **25~40ms**.
    * 특징: 전체 E2E 훈련 파이프라인 오픈, Snake/Maze 탐색 데모 제공, 1GB 미만 VRAM 소모.
  * **`bespokelabs/Bespoke-Nimble-9B`**:
    * 파라미터: 9B (Qwen3.5-9B LoRA).
    * 성능: 사실 하나를 뒤집어 네거티브를 생성하는 대조적 데이터 큐레이션(Contrastive Data Curation) 기법 적용. **Jev 벤치마크 일치율 90.1% 달성** (기본 Qwen 66.4% 대비 압도적).
    * 오픈 레시피: 훈련 데이터 큐레이션 코드 및 가중치 전면 공개.
  * **`AlexWortega/openjev`**:
    * Qwen3.5-4B 백본 + NLI Cross-Encoder 형태의 전용 MLP 헤드. Doom 플레이 및 비전 제어 지원.
  * **`NandhaKishorM/laya` (주의 필요)**:
    * ModernBERT-large (421M) 기반. 단, 독립 벤치마크 팩트체크 결과 제로샷 정확도는 36.2%에 불과하며, 76.6% 수치는 동일 데이터셋 파인튜닝 스플릿 결과임. ECE(캘리브레이션 오차)가 0.466으로 높아 단독 신뢰 주의.
  * **`Mapika/decider-2b`**:
    * Qwen3.5-2B-Base를 64개 결정 데이터셋(94.2만 개 예제)으로 풀 파인튜닝한 모델.
* **평가**: 모델 크기 대비 가장 뛰어난 지연시간(<40ms)을 보여주며, 로컬 상주 데몬으로 가장 적합.

#### ④ 패러다임 4: 전통적 양방향 인코더 및 NLI 계열 (Prior Art & Foundation)
* **메커니즘**: 텍스트 생성을 배제한 순수 양방향 인코더(Bidirectional Encoder)를 사용하여 입력 상태와 가설(Hypothesis) 간의 함의(Entailment) 확률을 직접 연산.
* **주요 프로젝트**:
  * **`com-kotobalabs/open-jev-deberta-v3-large`**: DeBERTa-v3-large(435M) 기반. 단일 포워드 패스로 보정된 확률 분포를 출력하며 구조적 포맷 에러율 0%.
  * **`fastino/gliner25-models` (GLiNER 2.5)**: 호출자가 제공한 임의 라벨 세트에 대해 1-pass 제로샷 분류를 수행하는 경량 인코더.
* **평가**: 가장 검증된 안정성과 0%의 파싱 실패율을 보장하나, 복잡한 코드 문맥이나 다단계 논리 추론 능력은 생성형 백본 대비 제한적.

---

### 3.3 오픈소스 대안 모델 종합 비교표

| 분류 | 모델명 | 백본 / 파라미터 | VRAM | 지연시간 (단일/배치) | Jev 대비 일치율/정확도 | 라이선스 | EG-Desk 실용성 평가 |
| :--- | :--- | :--- | :--- | :--- | :--- | :--- | :--- |
| **초경량 로컬** | **Verdict (rlcd-151m)** | ModernBERT (151M) | <0.5 GB | **< 35 ms** | 중간 (경량 라우팅 특화) | Apache-2.0 | **최우수 (Spinal Reflex 상주)** |
| **초경량 로컬** | **NanoJev** | Qwen3 (0.6B) | ~1.2 GB | **25 ~ 40 ms** | 준수 (태스크 적합 시) | Apache-2.0 | **최우수 (도메인 파인튜닝)** |
| **인코더 NLI** | **open-jev-deberta** | DeBERTa-v3 (435M) | ~1.5 GB | 40 ~ 70 ms | 높음 (NLI/분류) | Apache-2.0 | 우수 (상태 감지기) |
| **PCD 추출** | **TheoLee openjev** | Qwen3.5 (4B) | ~3.5 GB | 50 ~ 100 ms | ~75% (로짓 추출) | MIT | 우수 (즉각 프로토타이핑) |
| **PCD (Mac)** | **snapjudge / LitJev** | Qwen3.8 (27B) | ~16 GB | 200 ~ 400 ms | **81.2%** | Apache-2.0 | 양호 (단, VRAM 점유 큼) |
| **LoRA 파인튜닝** | **Bespoke Nimble** | Qwen3.5 (9B LoRA) | ~6~8 GB | 80 ~ 120 ms | **90.1%** (최고 수준) | Apache-2.0 | **최우수 (고난도 온톨로지 전이)** |
| **디퓨전 LM** | **LocalJev (GitHub Next)** | DiffusionGemma (26B-A4B) | ~14 GB | 100 ~ 150 ms | Jev와 대등 (Roughly tied) | 오픈소스 | 우수 (독립 로컬 서버 운영 시) |
| **상용 클라우드** | **TypeSafe Jev** | 독점 MoE (추정) | Cloud | 120 ~ 250 ms | **기준점 (GPT-5.6 Terra)** | 상용 API | 벤치마크 및 고신뢰 백업 |

---

### 3.4 EG-Desk 환경 최적의 3-Tier 하이브리드 배치 전략

Apple Silicon(Mac) 기반의 로컬 데스크 환경인 EG-Desk에서는 **"단일 모델 만능주의"**를 버리고 태스크의 위험도와 속도 요구에 맞춰 **3단계 계층(3-Tier Cascade)**으로 역할을 분담한다:

```text
[사용자 입력 / 브라우저 DOM 이벤트 / 터미널 명령어]
                     │
                     ▼
┌─────────────────────────────────────────────────────────────┐
│  Tier 1: 초저지연 로컬 척수 반사 (Spinal Reflex, < 35ms)    │
│  - 엔진: Verdict (151M) 또는 NanoJev (0.6B) 로컬 데몬 상주  │
│  - 역할: 터미널 위험 명령어 차단, DOM 액션 즉시 클릭,       │
│         인지 파일 4-Type (.gitattributes) 자동 태깅        │
└──────────────────────────────┬──────────────────────────────┘
                               │ 모호함 감지 (Confidence < 0.8) 또는 고위험 작업
                               ▼
┌─────────────────────────────────────────────────────────────┐
│  Tier 2: 로컬 고정밀 의사결정 레이어 (High-Stakes, 80~120ms) │
│  - 엔진: Bespoke Nimble (9B) 또는 TheoLee openjev (4B)     │
│  - 역할: 챗 에이전트 질의 시제 슬라이싱 (Present/Past/Future)│
│         온톨로지 상태 전이 판정, 보드 컨텍스트 압축          │
└──────────────────────────────┬──────────────────────────────┘
                               │ 심층 텍스트 생성 / 고난도 아키텍처 설계
                               ▼
┌─────────────────────────────────────────────────────────────┐
│  Tier 3: 생성형 전두엽 코프로세서 (System 2, 2~5s)          │
│  - 엔진: Frontier LLM (Codex, Claude Opus 4.6, GPT)        │
│  - 역할: 코드 작성, PRD 기획서 줄글 서술, 사용자 대화 렌더링 │
└─────────────────────────────────────────────────────────────┘
```

1. **상시 상주 데몬 (Tier 1)**: `rlcd-modernbert-151m` 또는 `NanoJev`를 백그라운드 프로세스로 띄워 메모리 1GB 미만으로 20~30ms 내에 90%의 단순 상태 체크와 안전 검사를 끝낸다.
2. **복잡한 온톨로지 전이 (Tier 2)**: 챗 시제 분석이나 세션 압축 등 고도의 언어 이해가 필요한 결정은 `Bespoke Nimble 9B`나 `snapjudge (MLX)`가 로컬에서 안전하게 처리한다 (Jev 대비 90% 이상 정확도).
3. **비상 백업**: 로컬 리소스가 부족하거나 절대적 신뢰도가 필요한 결제/외부 배포 시에만 원본 TypeSafe Jev 클라우드 API를 폴백(Fallback)으로 호출한다.

---

## 4. 인지 아키텍처 관점의 대전환: Decision Making(Jev) vs Creative Generation(LLM)

### 4.1 "업무의 50%는 결정이고, 50%는 창작이다"
인간의 지식 노동을 분석하면 크게 두 단계로 양분된다:
1. **Decision Making (의사결정 - 약 50%)**:
   - "이 이메일에 답장할 것인가? (Yes/No)"
   - "누구에게 참조를 걸어야 하는가? (Choice: DevOps Lead, PM)"
   - "지금 배포를 진행해도 안전한가? (Score: Risk 85% -> Block)"
   - "이 버그를 고치기 위해 어떤 파일을 열어야 하는가? (Choice: `surface.uc.js`)"
   - "다음 단계로 터미널 명령을 칠 것인가, 브라우저를 볼 것인가? (Choice: Terminal)"
2. **Creative / Generative Activity (창작 및 합성 - 약 50%)**:
   - "사려 깊고 정중한 이메일 본문 작성"
   - "복잡한 알고리즘 로직 및 리팩토링 코드 작성"
   - "사용자 의도에 맞춘 기획서 줄글 서술"

### 4.2 기존 모놀리식 LLM 에이전트의 구조적 실패
지금까지의 AI 에이전트는 **이 두 가지를 모두 LLM(GPT-4, Claude, Codex) 하나에 몰아넣었다.**
* LLM에게 교통경찰(신호등, 라우팅, 판단, 폴링) 역할까지 맡기면서:
  * 단순한 1-bit 결정(`Yes/No`)을 위해 수초의 지연시간과 수만 개의 토큰을 태운다.
  * 컨텍스트가 길어지면 LLM이 길을 잃고 엉뚱한 결정을 내린다(Hallucination).
  * 뇌과학 비유: **글을 쓰는 전두엽(Cortex)에게 심장 박동 조절, 동공 반사, 서류 분류 작업까지 전부 시키고 있었던 셈이다.**

### 4.3 듀얼 코어 인지 모델 (Dual-Core Cognitive Model)
```text
┌─────────────────────────────────────────────────────────────┐
│  Jev (System 1 / Neuromorphic Decision Fabric)              │
│  - 초저지연 (20~50ms), 초저비용, RLCD 기반 확률 보정         │
│  - 역할: 라우터, 상태 센서, 세이프티 가드, 기억 게이트, 스케줄러  │
│  - 산출물: Typed Decision (Choice, Score, Noul/Boolean)     │
└──────────────────────────────┬──────────────────────────────┘
                               │ "지금 이 조건에서 본문을 작성하라" (Context Slice)
                               ▼
┌─────────────────────────────────────────────────────────────┐
│  LLM / Codex (System 2 / Generative Coprocessor)            │
│  - 심층 추론, 복잡한 코드/글 작성, 의미적 합성               │
│  - 역할: 순수 렌더러/창작 엔진 (어떤 툴을 쓸지 결정하지 않음)     │
│  - 산출물: 코드, 문서 초안, 사용자 대화 텍스트                │
└─────────────────────────────────────────────────────────────┘
```

#### 구체적 업무 흐름 비교: 이메일 작성 및 발송
* **기존 LLM 방식**:
  1. 이메일 도착 -> LLM 호출 ("답장할까?") -> 3초 대기
  2. 답장 결정 -> LLM 호출 ("누구한테 보낼까?") -> 3초 대기
  3. LLM 호출 ("본문 작성") -> 5초 대기
  4. LLM 호출 ("발송 툴 실행할까?") -> 3초 대기
  * 총 14초 소요, 매 단계마다 토큰 낭비 및 오작동 위험.
* **Jev + LLM 분리 방식**:
  1. 이메일 도착 -> **Jev**: `Noul: "긴급 답장 대상인가?"` -> 30ms (True)
  2. **Jev**: `Choice: "수신자 선택"` -> 30ms (DevOps Lead)
  3. **Jev**: `Choice: "답장 톤/템플릿 골격"` -> 30ms (Urgent Bug Fix Notice)
  4. **LLM**: "위 조건과 버그 로그를 바탕으로 본문 3문장 작성" -> 3초 만에 텍스트 생성
  5. **Jev**: `Score(0-100, "발송 안전성 검사")` -> 30ms (Score 95 -> 자동 발송 승인)
  * 총 3.1초 소요, 비용 80% 절감, 결정 과정의 엄격한 타입 보장!

---

## 5. 해마(Hippocampus)와 파일·메모리 시스템의 Jev 전면 전환 구상

> **참조**: [`ideas/brainstorming/COGNITIVE_ARCHITECTURE_ANALOGY.md`](file:///Users/minsoocha/Projects/EG-Desk-Dev-Space/ideas/brainstorming/COGNITIVE_ARCHITECTURE_ANALOGY.md) (해마, 4-type 인지 태깅, 기저핵, 작업기억 스코프)

`COGNITIVE_ARCHITECTURE_ANALOGY.md`에서 지적되었던 가장 큰 병목은 **"LLM은 전두엽일 뿐, 기억을 저장/정리/망각하는 해마(Hippocampus) 역할을 파일시스템 위에서 제대로 수행하지 못한다"**는 점이었다. 
Jev는 이 해마의 빈자리를 100% 채울 수 있는 최적의 아키텍처다.

```text
┌──────────────────┬──────────────────────┬──────────────────────────────────┐
│ 뇌 부위           │ 원래 인지적 역할      │ Jev 기반 시스템 구현              │
├──────────────────┼──────────────────────┼──────────────────────────────────┤
│ 해마 (망각/GC)    │ 맥락 종료 시 잔여 기억 │ **Jev Autonomic GC Daemon**      │
│                  │ 폐기 (Garbage Collect)│ 세션/에피소드 종료 시 임시 파일 정리│
├──────────────────┼──────────────────────┼──────────────────────────────────┤
│ 해마 (인지 태깅)  │ 일화/의미/현실/상상   │ **Jev 4-Type Tagging Classifier**│
│                  │ 기억의 종류 분리      │ 파일 생성 즉시 4-type 자동 분류   │
├──────────────────┼──────────────────────┼──────────────────────────────────┤
│ 해마 (공고화)     │ 일화 기억(log)에서    │ **Jev Consolidation Arbiter**    │
│                  │ 핵심 지식(knowledge)  │ 공고화 승격 타이밍 감지 및 트리거│
│                  │ 으로의 변환 타이밍    │                                  │
├──────────────────┼──────────────────────┼──────────────────────────────────┤
│ 중앙 집행기 게이트│ 작업 기억(WM) 오염    │ **Jev Working Memory Gatekeeper**│
│ (Baddeley Gating)│ 방지, 상세 결과 차단  │ 툴 결과의 주입/파일 스필/폐기 결정│
└──────────────────┴──────────────────────┴──────────────────────────────────┘
```

### 5.1 4-Type 인지 태깅 자동화 (`asset`, `knowledge`, `log`, `hypothetical`)
* **기존 난제**: 파일 생성 시 LLM에게 일일이 태그를 붙이라고 하면 프롬프트가 길어지고 자주 누락됨. 정적 룰은 파일 내용을 모름.
* **Jev 솔루션**:
  * `PreToolUse(Write)` 또는 파일 쓰기 훅에서 Jev가 생성 파일의 내용과 경로를 보고 30ms 만에 분류:
    `Choice: ["asset", "knowledge", "log", "hypothetical"]`
  * 분류 결과를 `.gitattributes`에 자동 등록하거나 파일 상단 YAML Frontmatter에 즉시 주입.
  * 결과:
    * `ideas/confirmed/`에 쓴 문서는 **asset** (현실/확정)
    * `MEMORY.md`나 분석 교훈은 **knowledge** (의미 기억)
    * `subagent_reports/`나 임시 덤프는 **log** (일화 기억, GC 대상)
    * `ideas/brainstorming/`은 **hypothetical** (가정/상상, 현실과 엄격히 격리)

### 5.2 해마의 망각(Forgetting)과 자율 GC (Background Daemon)
* **기존 난제**: LLM에게 "작업 끝나면 임시 파일 지워"라고 부탁하면 바빠서 안 지움. 시간 기반(7일 경과) 훅은 맥락을 모르고 지움.
* **Jev 솔루션**:
  * 세션 종료 또는 Idle 시점에 **Jev Background Hippocampus**가 백그라운드 구동:
  * 각 임시/작업 파일(`type: log`, `type: hypothetical`)에 대해 질의:
    `Choice: ["PRUNE_DISCARD", "CONSOLIDATE_NEEDED", "KEEP_ACTIVE"]`
    * 이미 상위 문서로 병합된 탐색 로그 $\rightarrow$ 즉각 삭제 (GC)
    * 새로운 중요 발견이 포함된 로그 $\rightarrow$ `CONSOLIDATE_NEEDED` 큐로 이관
    * 아직 진행 중인 작업 $\rightarrow$ 유지

### 5.3 공고화(Consolidation) 중재자 (Arbiter)
* **해마의 공고화**: 구체적인 일화(에피소드)에서 맥락 독립적인 일반 지식을 추출하여 신피질로 보냄.
* **동작 메커니즘**:
  1. Jev가 에피소드 진행 상황을 모니터링하다가 `Noul: "이 작업에서 재사용 가능한 핵심 지식/패턴이 도출되었는가?"`가 `true`가 되는 순간을 포착.
  2. Jev는 LLM(Codex)을 단 1회 호출하여 **"이 에피소드 로그에서 핵심 규칙 1줄을 뽑아 `MEMORY.md`에 추가하라"**고 지시.
  3. 공고화가 끝나면 원본 로그는 Jev가 삭제(망각) 처리.

### 5.4 작업 기억 스코프 게이팅 (Baddeley Working Memory Gatekeeper)
* **기존 난제 (`COGNITIVE_ARCHITECTURE_ANALOGY.md` Section 11)**:
  서브에이전트나 툴이 200줄의 장황한 출력을 뱉으면 메인 스레드 컨텍스트에 그대로 주입되어 작업 기억이 오염됨.
* **Jev 솔루션**:
  툴 출력이 반환되는 순간 Jev가 게이트키퍼로 가로챔:
  `Choice: ["INJECT_FULL_TO_CONTEXT", "COLLAPSE_TO_TEMPLATE", "SPILL_TO_SCRATCH_FILE"]`
  * 결정에 따라:
    * 중요한 2줄만 LLM 컨텍스트에 남김.
    * 200줄 전체는 `.claude/scratch/` 파일로 스필(spill).
    * LLM은 맑고 깨끗한 작업 기억(Working Memory)을 유지하며 추론에 집중.

---

---

---

## 6. 시간축 온톨로지·스마트 폴더 체계에서 챗 에이전트의 Jev 판단 보완 설계

> **참조**:  
> - [`docs/vision/ontology-bridge.md`](file:///Users/minsoocha/Projects/EG-Desk-Dev-Space/docs/vision/ontology-bridge.md) (온톨로지 브릿지: 객체와 장소의 평탄화 극복)  
> - [`apps/firefox-ui-demo/docs/ONTOLOGY_VISUAL_DESIGN_SPEC.md`](file:///Users/minsoocha/Projects/EG-Desk-Dev-Space/apps/firefox-ui-demo/docs/ONTOLOGY_VISUAL_DESIGN_SPEC.md) (과거·현재·미래 / 가상·물리 시공간 체계)  
> - [`ontology/schema.md`](file:///Users/minsoocha/Projects/EG-Desk-Dev-Space/ontology/schema.md) (온톨로지 복합 스냅샷 및 전이 엣지 모델)  
> - [`ideas/brainstorming/COGNITIVE_ARCHITECTURE_ANALOGY.md`](file:///Users/minsoocha/Projects/EG-Desk-Dev-Space/ideas/brainstorming/COGNITIVE_ARCHITECTURE_ANALOGY.md) (시제 감각 결함 및 정보 출처 인식)

### 6.1 문제 정의: 챗 에이전트의 "시제 맹시(Tense Blindness)"와 "폴더 탐색 부채"
EG-Desk 작업 공간에는 **과거(완료 로그, 이전 스냅샷)**, **현재(라이브 소스코드, 런타임 설정)**, **미래(기획서, PRD, what-if 아이디어)**가 물리 파일시스템 상에 공존한다.

기존 LLM 에이전트가 챗(Chat)에서 사용자와 대화하며 스스로 파일 검색/판단을 수행할 때 심각한 인지 결함이 발생한다:
1. **시제 왜곡 및 환각 (Temporal Hallucination)**:
   - 사용자가 "우리 결제 시스템 어떻게 되어 있어?"라고 물었을 때, LLM이 `grep`으로 `ideas/brainstorming/KAFKA_PAYMENT.md`를 읽고는 *"현재 Kafka 기반 이벤트 아키텍처로 운영 중입니다"*라고 답변함. (실제 운영 코드는 Redis 큐 기반이고 Kafka는 **미래 기획안(Future)**일 뿐인데, LLM이 시제를 구분하지 못함)
2. **과거 로그의 현재화 오류**:
   - 6개월 전 `subagent_reports/20260220_분석.md`의 해결된 에러 로그를 보고 *"42번 라인에 버그가 존재합니다"*라고 헛소리를 함.
3. **산출물 배치 방황 (Placement Debt)**:
   - "새 기능 아이디어 정리해줘"라고 했을 때, 이것이 가설(`future/hypothetical`)인지, 확정 자산(`asset`)인지 판단하지 못하고 임의의 경로에 파일을 생성하여 프로젝트를 오염시킴.
4. **상태 전이 누락**:
   - 사용자가 대화로 "아까 기획한 v2 배포 끝났어"라고 보고해도, 이전 설계 문서를 과거로 넘기고 새 기획을 현재로 승격하는 온톨로지 전이 작업을 전혀 수행하지 못함.

---

### 6.2 챗 에이전트의 4단계 Jev 판단 보완 파이프라인

챗 대화가 진행되는 동안 Jev는 에이전트의 뒤에서 **"시제·온톨로지 센서 및 라우터"**로 작동하며 LLM의 판단을 실시간으로 보완한다.

```text
[사용자 챗 입력] 
      │ 
      ├─► [1. Jev 질의 시제 분석 (Temporal Intent Slicing, 20ms)]
      │     └─► 판정: time=PRESENT, layer=VIRTUAL -> 스마트 폴더 타깃 범위 확정
      │
      ├─► [2. 스마트 폴더 기반 파일 인출 (Scaped Retrieval)]
      │     └─► Jev가 인출된 파일에 시제 태그 주입: [SOURCE: time=present, type=asset]
      │
      ├─► [3. LLM 답변/산출물 생성 (System 2)]
      │     ├─ [답변 시] Jev 시제 왜곡 검증 가드 (Anti-Hallucination Guard, 20ms)
      │     └─ [파일 생성 시] Jev 온톨로지 폴더 자동 배치 (Zero-Friction Placement)
      │
      └─► [4. 대화 기반 온톨로지 상태 전이 (Conversation-Driven State Promotion)]
            └─► "배포 끝났다" 감지 시: future 스냅샷 -> present로 자동 승격 집행
```

#### ① [Stage 1] 질의 시제 분석 및 온톨로지 타깃 슬라이싱 (Temporal Slicing)
* 사용자의 챗 입력을 받자마자 Jev가 20ms 만에 의도를 분류:
  * `Choice(TimeIntent): ["PAST_EPISODIC", "PRESENT_LIVE", "FUTURE_PLANNED", "CROSS_TEMPORAL_DIFF"]`
  * `Choice(LayerTarget): ["VIRTUAL_LOGIC", "PHYSICAL_INFRA", "COMPOSITE"]`
* **동작**:
  * "현재 서버 구조 어떻게 돼?" $\rightarrow$ `time=PRESENT` + `layer=PHYSICAL`  
    $\rightarrow$ 에이전트의 파일 검색 도구(grep/find)를 **`smart://present/physical/`** 범위로 강제 바인딩.
  * 에이전트는 수만 줄의 과거 로그나 미래 기획 문서를 아예 읽지 않으므로 **컨텍스트 오염과 환각이 원천 차단**됨.

#### ② [Stage 2] 정보 인출 시 시제 왜곡 차단 가드 (Anti-Hallucination Guard)
* 만약 복합 질문으로 인해 여러 시간대의 파일이 인출되더라도:
  * Jev가 파일 주입 시 메타 헤더를 강제 부착:
    * `[ONTOLOGY: time=future, status=hypothetical, path=ideas/brainstorming/...]`
    * `[ONTOLOGY: time=past, status=archived_log, path=subagent_reports/...]`
    * `[ONTOLOGY: time=present, status=live_asset, path=src/...]`
* **사전 검증(Pre-flight Check)**:
  * LLM이 답변 초안을 낼 때 Jev가 30ms 만에 검증:
    `Noul: "에이전트가 future(미래 가설)나 past(과거 로그)를 present(현재 사실)인 것처럼 단정 서술하고 있는가?"`
  * 적발 시 즉각 인터셉트하여 *"참조 문서는 아직 미래 기획안입니다"*라는 보정을 답변에 반영하도록 강제.

#### ③ [Stage 3] 에이전트 산출물의 스마트 폴더 자동 안착 (Zero-Friction Placement)
* 사용자가 챗으로 "이 기능 아키텍처 구상해봐"라고 요청하여 에이전트가 문서를 작성할 때:
  * 에이전트(LLM)는 저장 경로를 고민할 필요 없이 내용만 작성.
  * **Jev가 산출물의 온톨로지 위치를 즉시 결정**:
    * `Choice(TimeSlice): future`
    * `Choice(CognitiveType): hypothetical`
    * `Choice(Layer): virtual`
    * `Target: smart://future/virtual/architecture/` $\rightarrow$ 물리 경로 `ideas/brainstorming/FEATURE_V2.md` 자동 매핑 및 Frontmatter 주입.

#### ④ [Stage 4] 대화 맥락 기반 온톨로지 상태 전이 자동화 (Conversation-Driven State Promotion)
* 사용자: *"아까 말한 PostgreSQL 마이그레이션 배포 완료했어. 헬스체크 통과함."*
* 일반 에이전트: *"네, 배포가 성공했군요!"* (끝. 문서는 방치됨)
* **Jev 보완 에이전트**:
  1. Jev가 대화 턴에서 상태 전이 신호를 포착:
     `Noul: "사용자가 future 계획의 실행 및 완료를 확인했는가?"` $\rightarrow$ **True (Confidence 0.98)**
  2. Jev가 백그라운드에서 즉각 온톨로지 전이를 집행:
     * `future/db-migration.md` $\rightarrow$ `present/db-schema.md`로 승격
     * 기존 `present/sqlite-schema.md` $\rightarrow$ `past/archive/`로 동결 보존
     * 스마트 폴더의 `[현재 운영 DB]` 뷰 인덱스 갱신
  3. 에이전트의 챗 응답:
     *"PostgreSQL 배포 완료를 확인했습니다. 스마트 폴더와 온톨로지 상에서 해당 마이그레이션 문서를 '현재(Present)' 활성 자산으로 승격하고, 이전 설계를 '과거(Past)' 이력으로 보관했습니다."*

---

### 6.3 챗 실전 시나리오 비교

#### 시나리오 A: 아키텍처 질의 시 시제 왜곡 방지
* **유저 질의**: *"우리 지금 인증 시스템 토큰 만료 처리 어떻게 구현되어 있어?"*
* **기존 LLM 에이전트**:
  * 전체 검색 수행 $\rightarrow$ `ideas/brainstorming/JWT_REFRESH_V2.md` 발견
  * ❌ *"현재 Silent Refresh 패턴을 통해 백그라운드에서 토큰을 자동 갱신하도록 구현되어 있습니다."* (거짓말: 이건 지난주에 아이디어만 적어둔 미구현 문서)
* **Jev 보완 에이전트**:
  * Jev가 질의를 `time=present`로 슬라이싱하여 실제 소스코드 `src/auth/` 및 `company-server.present.md`만 제공.
  * ⭕ *"현재(Present)는 토큰 만료 시 사용자에게 팝업을 띄워 재로그인을 요구하는 단순 만료 방식으로 동작 중입니다. (참고: 미래 계획으로 Silent Refresh 기획안이 ideas/brainstorming에 보관되어 있습니다.)"*

#### 시나리오 B: 대화 기반의 무마찰 온톨로지 상태 승격
* **상황**: 에이전트와 대화하며 버그를 잡고 핫픽스를 적용한 직후.
* **유저 질의**: *"패치 커밋하고 서버에 반영 끝났어. 이제 문제없음."*
* **기존 LLM 에이전트**: *"수고하셨습니다. 추가로 도와드릴 일이 있으신가요?"* (디버그 보고서와 원인 분석 파일들이 작업공간에 너저분하게 방치됨)
* **Jev 보완 에이전트**:
  * Jev가 에피소드 종료를 감지하고 상태 전이 실행:
    1. 작업 로그(`subagent_reports/debug-0919.md`) $\rightarrow$ 자율 GC 데몬이 핵심 1줄 교훈만 `MEMORY.md`에 공고화하고 원본 로그 폐기(망각).
    2. 핫픽스 패치 내용 $\rightarrow$ `present/` 운영 온톨로지에 커밋 반영.
  * ⭕ *"핫픽스 반영을 확인했습니다. 현재(Present) 시스템 온톨로지를 최신 패치 상태로 갱신하고, 임시 디버깅 로그를 정리하여 핵심 교훈을 MEMORY에 공고화했습니다."*

---

## 7. 결론: EG-Desk Cognitive OS의 완성

Jev를 단순한 "빠른 모델"로 보는 것을 넘어, **인간 인지 체계의 무의식/자율신경/해마/시제 감각 레이어**로 정의하면 EG-Desk의 모든 구성 요소가 명쾌하게 제자리를 찾는다:

1. **Firefox Chrome Surface / Browser Window**: Jev의 20ms 리플렉스로 동작하는 초고속 감각-운동 기관.
2. **Terminal / OS Execution**: Jev 세이프티 게이트가 지키는 안전한 신체.
3. **Filesystem & Memory**: Jev 해마가 4-type으로 태깅하고, 불필요한 기억을 망각(GC)시키며, 장기 기억으로 공고화하는 자율 인지 저장소.
4. **Smart Folder & Temporal Ontology**: 챗 에이전트가 시제 왜곡(과거/현재/미래 혼동) 없이 정확한 지점에 접근하고 산출물을 배치하도록 돕는 시공간 나침반.
5. **Codex / Frontier LLM**: 결정을 내리거나 파일 위치를 고민하느라 지치지 않고, 정제된 시공간 작업 기억 위에서 고도의 창작과 설계에만 전념하는 순수 전두엽 코프로세서.

---

## 8. 단계별 실증 및 도입 로드맵 (Roadmap)

### Phase 1: 센서, 가드레일, 그리고 4-Type 인지 태깅 (Quick Win)
- **과제 1.1**: 초경량 Tier 1 엔진(`Verdict 151M` 또는 `NanoJev 0.6B`) 상주 데몬을 검증하고, `helper-rust` 또는 Node bridge에 터미널 맥락 기반 세이프티 가드(`Contextual Safety Gate`) 연동.
- **과제 1.2**: `HUMAN_IN_LOOP_WORKFLOW_AWAIT_MODEL`의 OAuth/SSO/개발서버 완료 판정 센서 도입.
- **과제 1.3**: 파일 생성 훅에 Jev/NanoJev를 연결하여 `asset / knowledge / log / hypothetical` 4-type 태깅 자동화 및 `.gitattributes` 바인딩.

### Phase 2: 브라우저 액션 리플렉스 & 작업 기억 게이트
- **과제 2.1**: `browserAgent.act()`에 Jev `Choice` 기반 초고속 DOM 클릭/입력 루프 연동. (단순 네비게이션 시 코덱스 호출 생략)
- **과제 2.2**: 툴 결과(200줄 이상) 반환 시 Jev가 스크래치 파일 스필 및 요약 템플릿 치환을 수행하는 Working Memory Gatekeeper 구축.

### Phase 3: 자율신경 해마 GC 및 공고화 자동화
- **과제 3.1**: 세션 종료/유휴 상태에서 동작하는 Jev Background Hippocampus 데몬 구현 (일화 로그 자동 GC 및 망각).
- **과제 3.2**: 에피소드 종료 시점 감지 및 LLM 1회 호출을 통한 `MEMORY.md` 지식 공고화 파이프라인 완성.

### Phase 4: 스마트 폴더 및 온톨로지 시간축 전이 엔진
- **과제 4.1**: 고정밀 Tier 2 엔진(`Bespoke Nimble 9B` 또는 `snapjudge/openjev PCD`)을 연동하여 스마트 폴더 소속 판정 및 챗 질의 시제 슬라이싱(`Present/Past/Future`) 구현.
- **과제 4.2**: 온톨로지 렌즈의 `Future -> Present -> Past` 자동 전이 중재기 및 `Virtual/Physical` 자동 분류기 연동.



---

<a id="jev-preparation-20260926"></a>
## 9. EG-Desk 전반 적용 후보와 문서 변경 준비 계획

**기준일**: 2026-09-26 · **상태**: 준비안 / Draft  
**수신자**: Main, 제품·기술 검토자와 후속 문서 편집 담당자  
**검증 상태**: 문헌·지정 설계 문서 대조만 수행. 구현, 제품 채택, 실제 Jev 평가, 사용자 시뮬레이션은 모두 **NOT-RUN**이다.  
**현재 편집 범위**: 이 문서의 §9만 추가한다. 기존 §1–8은 당시 초안으로 그대로 보존한다. §9의 재검토 표는 과거 본문을 현재 제품 보장으로 읽지 않기 위한 검토 결과다.

사용자의 요청은 “Jev로 적용할 수 있는 EG-Desk 전반을 검토하고 전체 문서 업데이트를 준비”하는 것이다. 후보 발굴은 정본 일괄 채택이나 새 서비스·비용·권한의 승인이 아니다. [현행 CAP 13개][cap-section]는 모두 `PM-PROPOSAL`이며 구현 증거가 아니다. 아래 입력도 계약이 요구하거나 확보할 것으로 예상하는 값이지, 실제 runtime에서 수집·전달됐음을 확인한 값은 아니다.

이 절은 브라우저·파일 10개, Chat·Agent·읽기·실행·산출물 12개, Canvas·Board·Ontology·협업 11개의 연구 입력을 통합한다. 현재 주장 검사 `C-ANS-01`과 당시 Snapshot 근거 검사는 [JEV-BF-10](#jev-bf-10)의 공통 판단으로 묶되 두 사용상황을 남겼다. 따라서 **32개 판단 후보가 33개 사용상황을 다룬다.** `JEV-*`는 이 준비안의 식별자이며 Atlas의 `CHAT-01`, `READ-01` 같은 제품 trace ID와 별개다.

**탐색**: [사용자 방향](#jev-prep-direction) · [공통 책임](#jev-prep-boundaries) · [브라우저·파일](#jev-browser-file-candidates) · [Chat·실행](#jev-chat-agent-candidates) · [Canvas·조직 지식](#jev-canvas-ontology-candidates) · [CAP/ECS coverage](#jev-capability-coverage) · [기존 초안 재검토](#jev-legacy-review) · [검증 계획](#jev-validation-plan) · [우선순위·정책](#jev-priority-approvals) · [문서 반영 matrix](#jev-document-matrix) · [공식 근거](#jev-official-sources).

<a id="jev-prep-direction"></a>
### 9.1 이번 사용자 방향과 남은 선택

| 이번 방향 | 준비할 동작·설명 | 유지할 경계·연결 |
|---|---|---|
| browser-first | Google Drive와 Microsoft 등 웹문서를 Browser에서 읽고 탐색하는 공통 경로를 먼저 검토한다. 공급자 API는 선택 가능한 보완 수단이다. | DOM은 문서 전체와 같지 않다. Canvas·가상화·미로드 영역은 별도 추출·탐색·인쇄/내보내기 경로와 coverage가 필요하다. [Browser][a-tool1]·[읽기][c-read]·[파일 지원][h-code] |
| 비로그인으로 연 카드에 계정 적용 후 같은 자리 재로드 | 단순 열람 중인 visible card의 자리·원 업무 연결을 유지한 채 지정한 browsing context로 다시 로드하는 흐름을 준비한다. 새 browsing context가 반드시 새 visible card를 뜻하지는 않는다. | 입력 중인 form·미저장 내용은 단순 열람과 구별한다. 현 [계정 UX][u-identity]의 form 보존·새 context 경로와 함께 검토하며, 비밀값·cookie·권한을 임의 복제하지 않는다. 실제 사이트 신원과 접근을 재검증한다. [HUM-ENGINE-001][h-engine]·[HUM-SURFACE-001][h-surface] |
| 같은 문서도 보드별 사용 부분이 다름 | 출처 문서 identity, 각 보드의 read intent·부분 anchor, 해당 보드가 이미 읽은 원문·관측 시각을 별도로 연결한다. | 문서 단위 변경 신호만으로 모든 보드에 업무 영향 경고를 만들지 않는다. 부분 대응이 불명확하면 재연결·검토 상태를 남긴다. [Context][c-context]·[Snapshot][c-storage] |
| 전 기능 적용 검토와 전체 문서 업데이트 준비 | 기술적으로 도움이 되는 의미 판단을 찾고 정본별 변경 이유·검증 조건을 제시한다. | 모든 사용자 수동 조작에 Jev 호출을 넣는 요구가 아니다. 정확 검색·의미 검색·규칙·상위 Agent의 비용과 품질을 비교해 호출 위치를 정한다. |

최신 원본을 기본 추종할지 과거 참조를 고정할지, Board 저장 범위, 추가 오프라인 원문·form 보관, 권한 철회 뒤 과거 사본, 삭제·가림 연동의 기존 질문은 이번 방향으로 답변된 것으로 처리하지 않는다. [HUM-AGENDA-001][h-board]·[HUM-SNAPSHOT-001][h-snapshot]·[HUM-EXPORT-001][h-export]를 따른다. 확인한 Owner 원장은 **OPEN 15개**를 유지한다. `HUM-READ-001`은 이미 `RESOLVED-BY-DESIGN`인 읽기 설계 참조이며 새 승인 질문으로 다시 열지 않는다.

<a id="jev-prep-boundaries"></a>
### 9.2 공통 입력·판단·실행 책임

현재 공식 모델은 `jev-1.13.0`이며 text-only다. 이미지·Canvas·스캔·오디오 등은 별도 extractor/OCR/허용된 vision 처리가 텍스트와 관측 범위를 만든 뒤에만 Jev 입력 후보가 된다. 한국어·CJK 정확도는 이 프로젝트에서 실증하지 않았다. 다른 모델이나 djev의 이미지 처리 가능성은 공식 Jev 기능에 포함하지 않는다. [모델][ts-models]·[State][ts-state].

| 층 | 책임과 보존할 값 |
|---|---|
| 관측·원문 확보 | System이 권한 있는 범위에서 원문을 확보하고 source identity·locator·revision/확인 불가·시각·추출기·관측 범위·오류를 기록한다. 원문 전체를 확보하지 않았으면 그 범위만 원문 관측으로 명명한다. |
| 텍스트 준비 | 원문 capture, OCR·정규화 text, Reader packet, 요약, 실제 Agent 전달 payload를 각 역할로 구분한다. 파생본은 원문과 연결하며 원문 byte·과거 전달 기록을 덮지 않는다. |
| Jev 질문 | 이미 확보한 자료와 허용 후보만 넣고 한 질문에 한 판단을 요구한다. 입력의 문서·행·구간 ID를 선택하게 하고 자유 생성한 문장을 원문 인용으로 사용하지 않는다. |
| 코드의 결과 적용 | 후보 ID·현재 revision·권한·명시 binding·위임·비용·전송·실행 한도를 검사하고 다음 읽기/제안/검토 경로를 선택한다. raw probability와 execution permission은 서로 다른 값이다. |
| 보존·완료 증거 | identity, ACL, credential 격리, lease, 조건부 저장, receipt, 실제 완료·coverage, retention·GC는 System 계약이다. Jev 확률은 이를 생성하거나 대체하지 않는다. |
| 장애·불확실 | 미확보·접근 거부·timeout·429·잘못된 응답·stale 입력·모델 불확실을 구분한다. 같은 의미의 질문·입력 revision을 확인해 결과를 재사용하고, 늦은 응답은 현재 상태에 재검증한다. 사용할 수 없는 판단은 정해진 코드 경로·상위 Agent·사용자 선택으로 돌아간다. |

`Choice`는 정의된 후보 중 선택과 분포를, `Noul`은 yes 확률을, `Score`는 구체적으로 설명한 순서형 수준의 위치와 분포를 반환한다. Noul에는 별도 confidence가 없다. Choice/Score confidence는 분포의 집중도를 나타내며 정확성·권한의 증거가 아니다. 후보가 맞지 않을 수 있으면 `없음/불명`을 두고, 검색 순위와 답 존재 여부를 나눠 검사한다. [Choice][ts-choice]·[Noul][ts-noul]·[Score][ts-score]·[Confidence][ts-confidence]·[semantic_find][ts-find].

비교 자료의 관계는 다음처럼 분리하는 준비안이다. 이는 확정 schema 필드명이 아니다.

```text
source identity + locator + 접근 context
  → 관측 revision/시각/범위 + immutable raw capture
  → 추출·정규화·Reader packet + 변환 관계
  → Board별 read intent + 부분 anchor + 이미 읽은 내용
  → Jev 질문·모델 version·raw 판단
  → 코드의 현재 권한/revision 검사 + 담당 Agent의 업무 판단
  → 필요한 보드/보고 항목의 안내 또는 후속 요청
```

브라우저 알림·공급자 version·HTTP validator·raw hash 변화는 재조회·비교의 신호다. 본문 의미 변화와 업무 영향은 각각 [JEV-BF-08](#jev-bf-08), [JEV-BF-09](#jev-bf-09)에서 검토한다. Snapshot 보존은 연속 감시 없이 관측 시점에도 가능하다. 과거 원문을 보존하지 않았다면 나중에 항상 복구할 수 있다고 약속하지 않는다. API webhook에는 공급자별 수신·인증·갱신 조건이 있고, Browser 재조회·폴링도 대안이다. 일반 Browser 파싱만으로 정확한 서버 revision, 미로드 전체, 화면을 열지 않는 push, 원자적 편집 조건을 보장하지 않는다. 웹 UI가 버전 기록·내보내기를 제공하는 경우까지 API 전용이라고 부르지 않는다. [Google 알림][g-push]·[변경 기록][g-changes]·[Docs revision][g-docs]·[HTTP][http-conditional]·[Word 웹][ms-word].

<a id="jev-browser-file-candidates"></a>
### 9.3 브라우저·파일·웹문서·Snapshot 후보 10개

이 표의 출처 자료는 실제 다음 행동이나 보드의 판단 근거를 선택하기 위해 사용한다. raw 관측을 보존하는 책임은 [Contract §15][c-storage]에 남긴다. 각 후보의 CAP/ECS 링크는 [전체 coverage](#jev-capability-coverage)에서 다시 이 후보로 돌아온다.

| 준비안 ID·실제 사용상황 | 확보할 입력 | Jev의 좁은 질문·출력형 | System·담당 Agent의 책임 | 불확실·공급자 장애 시 대안 | 검증할 실패 예·정본 연결 |
|---|---|---|---|---|---|
| <a id="jev-bf-01"></a>**JEV-BF-01** 카드에서 원하는 문서로 탐색 | 현재 관측 text·링크/버튼 ID·사용자 목적·target binding | 다음 읽기 대상은? `Choice(후보 ID/없음/불명)` | System이 context·lease·이동·reload·재관측을 집행. 담당 Agent는 허용 행동만 요청 | 직접 URL·명령 검색·수동 선택 | 동명 문서의 잘못된 링크, stale handle. [CAP-05](#jev-cap-05)·[ECS-03](#jev-ecs-03); [TOOL-01][a-tool1]·[BROWSER-01][a-b1]·[§14][c-binding]·[HUM-SURFACE][h-surface] |
| <a id="jev-bf-02"></a>**JEV-BF-02** 로드·접근 상태를 이해 | 표시 문구·로딩/차단 흔적·범위·현재 probe와 시각 | 로그인 화면/권한 오류/본문/불명 중 관측 상태는? `Choice` | System이 사이트 신원·권한·실제 접근을 검증. 보이는 제목만으로 로그인 성공을 만들지 않음 | 비교 불가 표시·현재 상태 재조회·필요한 인증만 사용자에게 연결 | 본문은 차단됐지만 제목만 보임; 미로드를 삭제로 처리. [CAP-05/06](#jev-cap-06)·[ECS-03/05](#jev-ecs-05); [BROWSER-02][a-b2]·[§2.4][c-recovery]·[§14.1][c-identity]·[HUM-ENGINE][h-engine] |
| <a id="jev-bf-03"></a>**JEV-BF-03** 여러 링크의 출처 후보 연결 | locator·리디렉션·제목·확보 구절·공급자 ID가 있으면 그 값 | 어느 기존 source 후보와 대응하는가? `Choice(+불명)` | System이 안정 identity·권한·View·내용 동등성의 각 증거를 관리. Jev는 병합 확정자가 아님 | 별도 자료로 유지·연결 후보 검토 | 같은 제목의 다른 문서, 내용 hash는 같지만 출처·계정은 다름. [CAP-05/08](#jev-cap-08)·[ECS-02/03](#jev-ecs-02); [TOOL-01][a-tool1]·[SourceRef][a-source-ref]·[§14.1][c-identity]·[HUM-SURFACE][h-surface] |
| <a id="jev-bf-04"></a>**JEV-BF-04** PDF·DOCX·저장 HTML에서 관련 파일/구간 탐색 | 파일 metadata·권한 필터 후 추출 text·구간 ID·OCR/판독 상태 | 관련 후보는? `Choice`; 확보 범위에 답이 있는가? `Noul` | System이 추출·OCR·전체/지정 범위·hash를 관리. 담당 Agent가 최종 비교를 소유 | 제목·정확 검색·FTS·다른 parser·허용된 수동 판독 | OCR 숫자 오독, 부록을 읽지 않고 전체 검토 완료. [CAP-02](#jev-cap-02)·[ECS-02](#jev-ecs-02); [TOOL-02][a-tool2]·[READ-01/03][a-r1]·[§2.1–2.4][c-read]·[HUM-CODE][h-code] |
| <a id="jev-bf-05"></a>**JEV-BF-05** 화면·인쇄본·다운로드 표현 대조 | 표현별 추출 구간·source/revision·추출 방식·coverage | 두 구간이 같은 내용을 나타내는가? `Noul` | System이 각 원본·변환 관계·누락 범위를 보존. 담당 Agent가 내용상 차이를 검토 | 각 표현을 따로 제시·대응 불명 표시 | 화면에 없는 주석·표가 인쇄본에 존재, Canvas text 누락. [CAP-02/08](#jev-cap-08)·[ECS-02](#jev-ecs-02); [BROWSER-03][a-b3]·[AI-04][a-ai4]·[§2.2][c-reader]·[§15][c-storage]·[HUM-CODE][h-code] |
| <a id="jev-bf-06"></a>**JEV-BF-06** 보드에서 처음 사용할 부분 선택 | Board 목적·read intent·허용 source·문맥을 포함한 구간 ID | 어느 구간이 조건에 답하는가? `Choice`+존재 `Noul` | System이 Board별 anchor·선택 이유·읽은 원문을 연결. 전체 문서 검토 요청은 전 범위 coverage 유지 | 정확 검색·구간 직접 선택·담당 Agent 추가 읽기 | 최고 순위 무관 구절을 정답 처리, 다른 보드의 anchor 덮기. [CAP-02/08](#jev-cap-02)·[ECS-02](#jev-ecs-02); [AI-02][a-ai2]·[READ-02][a-r2]·[§2][c-context]·[HUM-AGENDA][h-board] |
| <a id="jev-bf-07"></a>**JEV-BF-07** 편집 후 참조 부분 재찾기 | 이전 구절·주변 문맥·anchor·새 원문의 확보 후보·범위 | 이전 참조와 대응하는 부분은? `Choice(+없음/불명)` | System이 새 snapshot·coverage를 만들고 과거 참조를 보존. 불명확한 재연결은 검토 대상으로 둠 | 이전 근거 유지·후보 병렬 제시·재탐색 | 문단 이동·중복 구절·일부 삭제·미로드를 모두 같은 실패로 처리. [CAP-02/08](#jev-cap-08)·[ECS-01/02](#jev-ecs-01); [READ-03][a-r3]·[AI-04][a-ai4]·[§2.2][c-reader]·[§15][c-storage]·[HUM-SNAPSHOT][h-snapshot] |
| <a id="jev-bf-08"></a>**JEV-BF-08** 관측된 부분의 의미 변화 판단 | 이전/현재 원문·기계적 diff·추출 범위·확인 시각 | 내용상 변경/표현만 변경/불명인가? `Choice` | System이 raw diff·version·출처를 보존. 담당 Agent가 의미 결과를 해석 | 원문 diff 제공·재읽기·미검토 표시 | 부정어·금액 한 자리 변경을 사소한 표현으로 무시. [CAP-08](#jev-cap-08)·[ECS-02/06](#jev-ecs-06); [AI-04][a-ai4]·[§14][c-binding]·[답변 변경 UX][u-answer]·[HUM-ANSWER][h-answer] |
| <a id="jev-bf-09"></a>**JEV-BF-09** 파일 수정 전 연결 보드 확인·외부 수정 후 보드별 영향 | 원본을 사용하는 Board 연결 record·보드별 참조/목적·수정 예정 diff 또는 외부 수정 후 확보한 변경 구간 | 예정/관측된 변화가 이 보드의 사용 조건에 영향을 주는가? `Noul` | System은 EG-Desk가 수행할 파일 수정 전에 다른 보드 연결을 조회하고, 외부 앱 수정은 사후 변경 감지·재조회로 확인. 연결 record·변경 증거·기존 정책에 따른 원문 보존은 코드, Jev는 보드별 의미 영향만 제안 | 연결/영향 불명 표시·담당 Agent 검토·독립 업무 계속. 자동 과거 버전 보관·최신 추종 정책은 미확정 유지 | 연결 보드 확인 없이 원본부터 수정; 외부 수정을 사전에 막았다고 주장; 무관한 변경을 모든 보드의 실패로 확정. [CAP-08/02](#jev-cap-08)·[ECS-01/02/06](#jev-ecs-02); [AI-02/04][a-ai2]·[§2][c-context]·[§14][c-binding]·[HUM-AGENDA][h-board]·[HUM-ANSWER][h-answer] |
| <a id="jev-bf-10"></a>**JEV-BF-10** 당시 Snapshot 근거 확인 + 현재 답변의 주장·근거 검사 | 주장·적용 시점·당시 source 문맥·quote/span·현재 자료를 볼 경우 별도 revision | 이 근거가 주장을 지지/반박/언급하지 않음/판단 불충분인가? `Choice` | System이 인용 존재·원문·실제 전달 lineage를 확인. 담당 Agent가 주장 수정. 현재 자료로 과거 근거를 대체하지 않음 | 원문 재진입·작성자 검토·검증 한계 표시 | 접수증을 처리완료 증거로 사용; 현재 변경을 과거 오류로 단정. `C-ANS-01` 통합. [CAP-08/09](#jev-cap-08)·[ECS-01/02/06](#jev-ecs-06); [AI-04][a-ai4]·[DATA-01][a-data]·[§4.1][c-observation]·[§15][c-storage]·[HUM-SNAPSHOT][h-snapshot] |

<a id="jev-chat-agent-candidates"></a>
### 9.4 Chat·Agent·Smart Read·실행·산출물 후보 11개

원 연구의 `C-*`는 아래 `JEV-*`로 대응한다. `C-ANS-01`의 현재 주장 검사 상황은 [JEV-BF-10](#jev-bf-10)에 남겼다. 명시적인 Codex/사용자 선택 모델·계정 binding을 유지하며 기본 personality를 필수화하지 않는다.
별도 persona/Profile을 생성하기 전에도 기본 Codex 경험을 유지하며 Agent는 선택적이다.
Jev 판정·진행 로그가 사람 간 대화처럼 이어지는 Chat 타임라인을 채우지 않도록 한다.
필요할 때 기존 활동 상세에서 확인하는 방식은 검토 후보이며 새로운 UI 기본값·알림 정책을 확정하지 않는다.

| 준비안 ID·실제 사용상황 | 확보할 입력 | Jev의 좁은 질문·출력형 | System·담당 Agent의 책임 | 불확실·공급자 장애 시 대안 | 검증할 실패 예·정본 연결 |
|---|---|---|---|---|---|
| <a id="jev-chat-01"></a>**JEV-CHAT-01** “이것도 고쳐줘”의 업무 대상 확인 (`C-CHAT-01`) | 명시 targetRunId·후보 업무·최근 관련 지시·선택 대상 | 어느 업무/새 업무/확인 필요한가? `Choice` | 명시 binding 우선. System은 귀속을 기록하고 담당 Agent는 선택 범위만 처리 | 대상 선택 요청·독립 작업 계속 | Canvas를 바라봤다는 이유만으로 대상 업무 변경. [CAP-03/04](#jev-cap-04)·[ECS-02/06](#jev-ecs-06); [CHAT-01][a-chat]·[요청 계약][c-chat]·[HUM-CONV][h-conv] |
| <a id="jev-chat-02"></a>**JEV-CHAT-02** Memo에서 후속 대화가 필요한지 판단 (`C-CHAT-02`) | 질문·Memo revision·허용 근거·짧은 답 초안 | 짧은 답만으로는 의도 확인이 필요한가? `Noul` | System이 trigger·수신자·중복 알림·응답 권한을 적용. 담당 Agent가 답변/후속 초안 작성 | 담당 모델 검토·기존 Memo와 초안 유지 | 답글·위치 이동 때마다 반복 질문, proactive 기본값 임의 채택. [CAP-08](#jev-cap-08)·[ECS-02/06](#jev-ecs-02); [CANVAS-01][a-memo]·[Memo 계약][c-memo]·[HUM-CONV][h-conv] |
| <a id="jev-agent-01"></a>**JEV-AGENT-01** 허용 후보 안 담당·모델 추천 (`C-AGENT-01`) | 업무·역할·도구·입력 특성·허용된 후보 | 어느 후보가 적합한가? `Choice(+없음)` | System이 명시 pin·실제 계정·가용성·비용·자료 전송·위임 필터를 먼저 적용. 선택·fallback 이력 보존 | 기존 유효 binding 또는 명시 선택 | 점수로 고정 모델·계정·비용 제한 우회. [CAP-01/03](#jev-cap-01)·[ECS-01/02/06](#jev-ecs-01); [AGENT-01][a-agent]·[Profile 계약][c-profile]·[HUM-ENGINE][h-engine]·[HUM-RUN][h-run] |
| <a id="jev-ctx-01"></a>**JEV-CTX-01** 요청 Context의 관련도 순위 (`C-CTX-01`) | 요청·허용 descriptor·실제 확보 발췌·revision·포함 이유 | 무관/보조/직접 관련 중 어디인가? `Score` | System이 명시 첨부·필수 자료·권한·미확보 pending·admission을 유지. 점수는 선택 참고자료 순위에 사용 | 기존 resolver·명시 범위·정확 검색 | 제목만 보고 아직 읽지 않은 부록 영구 제외. [CAP-02](#jev-cap-02)·[ECS-01/02](#jev-ecs-02); [AI-02][a-ai2]·[§2][c-context]·[HUM-RUN][h-run] |
| <a id="jev-ctx-02"></a>**JEV-CTX-02** 기억의 이번 업무 적용성 (`C-CTX-02`) | 활성 Memory의 조건·출처·revision, 요청의 회사·역할·기간 | 이 기억은 이번 조건 안에 적용되는가? `Noul` | System이 ACL·동의·만료·재사용 중지·명시 지시를 검사. 모델은 기억을 활성화하거나 이동하지 않음 | 현재 지시로 진행·불명 기억 자동 주입 보류 | A사 규칙을 B사 업무에 적용; 만료 기억을 재활성화. [CAP-01/04/12](#jev-cap-12)·[ECS-01/07](#jev-ecs-07); [AGENT-02][a-agent2]·[Memory 계약][c-budget]·[HUM-RUN][h-run]·[HUM-GOV][h-gov] |
| <a id="jev-read-01"></a>**JEV-READ-01** Reader packet의 추가 읽기 신호 (`C-READ-01`) | read intent·요구 항목·packet·coverage·미확보 manifest | 각 요구를 판단할 근거가 packet에 있는가? 요구별 `Noul` | System이 요청 읽기 범위·미확보·전체 읽기의 전 partition coverage를 추적하고 담당 Agent가 추가 읽기를 소유. 별도 검사 Agent를 필수 제품 객체·항상 실행 절차로 두지 않으며 내부 구조는 이 보장 안에서 구현 재량 | 기존 위임 안 고정 원문 재진입·미확보 pending·독립 업무 유지. 일반 추가 읽기마다 사용자 승인·질문을 요구하지 않음 | 예외가 빠진 packet으로 전체 검토 완료; 점수로 미수집 범위 제외; 검사 Agent가 없다는 이유로 정상 읽기 차단. [CAP-02](#jev-cap-02)·[ECS-02/06](#jev-ecs-02); [READ-01/03][a-r1]·[§2.2–2.3][c-reader]·[HUM-READ][h-read] |
| <a id="jev-orch-01"></a>**JEV-ORCH-01** 담당·의존 작업 제안 검사 (`C-ORCH-01`) | 담당 모델이 제안한 Task·산출물·완료 조건·역할 후보 | 담당 후보 `Choice`; 이 선행 산출물이 필수인가? 별도 `Noul` | 담당 Agent가 계획 소유. System이 graph cycle·권한·write lease·실제 선행 완료 증거 검사 | 기존 계획 검토·종속 분기만 대기 | 높은 확률로 미완료 선행 작업을 통과시킴. [CAP-03](#jev-cap-03)·[ECS-06](#jev-ecs-06); [AI-06][a-ai6]·[§9][c-orch]·[HUM-ORCH][h-orch] |
| <a id="jev-orch-02"></a>**JEV-ORCH-02** 늦게 도착한 기여의 재사용 (`C-ORCH-02`) | old Task 기여·actual input revision·새 지시·근거 revision | 그대로/일부 재검토/재사용 불가/불명인가? `Choice` | 담당 Agent가 통합. System은 귀속·취소 이후 재개 차단·원 기여 보존·새 입력 연결 | 검토 대기·독립 기여 계속 | 취소된 작업 자동 재개, 과거 Answer 덮어쓰기. [CAP-03/04](#jev-cap-03)·[ECS-06](#jev-ecs-06); [AI-06][a-ai6]·[Run 계약][c-run]·[HUM-ORCH][h-orch]·[HUM-RUN][h-run] |
| <a id="jev-run-01"></a>**JEV-RUN-01** 비정형 오류의 다음 검사 선택 (`C-RUN-01`) | 오류 text·경계별 probe·확인 시각·허용 read-only 검사 후보 | 다음으로 유용한 검사는? `Choice(+없음)` | System이 검사 실행·실제 health 판정. 담당 Agent는 미확인 원인을 가설로 유지. 구조화 오류는 코드로 바로 처리 가능 | 정해진 probe·unknown 표시 | spinner 정지로 원인 단정·미확인 제출 재전송. [CAP-06](#jev-cap-06)·[ECS-05](#jev-ecs-05); [SYS-01][a-sys]·[§13][c-failure]·[HUM-RUN][h-run] |
| <a id="jev-brief-01"></a>**JEV-BRIEF-01** Briefing 설명과 대상 일치 (`C-BRIEF-01`); [준비·탐색 지연 검토](#jev-briefing-latency-review) | 고정 Answer·Step 목적·설명·권한 있는 target text | 설명 대상의 관련도는 무관/부분/직접인가? `Score` | 담당 Agent가 구성 제안. System이 target·권한·revision·탐색 처리. 게시된 단계 이동은 저장된 구성을 사용 | 초안 검토·기존 게시본 유지 | 비용 설명에 납기 카드 연결; 다음 버튼마다 재추론. [CAP-08](#jev-cap-08)·[ECS-06](#jev-ecs-06); [AI-05][a-ai5]·[§8][c-brief]·[HUM-BRIEF][h-brief] |
| <a id="jev-pov-01"></a>**JEV-POV-01** 화자·내부 지시 누출 검사 (`C-POV-01`) | 초안·화자·독자·목적·출력 위치·포함 허용 범위와 제약 | 내부 지시 누출/화자 불일치/persona 부적절 개입? 각각 `Noul` | System이 출력 상황을 전달. 작성 모델이 수정하며 검사 결과를 문서 본문으로 복사하지 않음 | 작성자 재검토·전달 초안 유지 | 고객 본문에 “사용자 요청대로 수정 예정”; 내부 검토 메모 노출. [CAP-04/08](#jev-cap-04)·[ECS-06](#jev-ecs-06); [Atlas §5.8][a-pov]·[§2.0][c-pov]·[HUM-ANSWER][h-answer] |

<a id="jev-canvas-ontology-candidates"></a>
### 9.5 Canvas·Board·Ontology·협업 후보 11개

원 연구의 `S-*-J01/J02/J03`을 아래 `JEV-*`로 대응한다. 명시 요청·현재 정책·허용 입력이 준비됐을 때의 후보이며, 일반 화면 조작이나 매 저장에 새 모델 호출·사용자 확인을 의무화하지 않는다.

| 준비안 ID·실제 사용상황 | 확보할 입력 | Jev의 좁은 질문·출력형 | System·담당 Agent의 책임 | 불확실·공급자 장애 시 대안 | 검증할 실패 예·정본 연결 |
|---|---|---|---|---|---|
| <a id="jev-disc-01"></a>**JEV-DISC-01** 의미로 자료·Board 찾기 (`S-DISC-J01`) | 명시 검색·ACL 필터 후 제목/본문·ID·revision | 후보 관련도 `Score`+답 존재 `Noul` | System이 검색 범위·권한·열기 재검증. 정확 검색과 의미 판단의 결합 방식은 비용·정확도로 비교 | 제목·정확 검색·FTS | 무관한 최고 순위를 정답 처리, 비공개 제목/count 노출. [CAP-09](#jev-cap-09)·[ECS-01](#jev-ecs-01); [V-03][a-v3]·[검색 계약][c-discovery]·[HUM-SURFACE][h-surface] |
| <a id="jev-board-01"></a>**JEV-BOARD-01** 저장 구성의 포함 후보 (`S-BOARD-J01`) | 업무 목적·선택 View·유형·참조 설명 | 이 항목이 재개에 유용한가? 항목별 `Noul` | System이 현재 저장 정책·확정 범위·revision·권한 집행. 점수만으로 범위를 넓히거나 매 저장에 확인을 추가하지 않음 | 기존 선택·저장 정책 유지 | 미선택 원문·credential·실행 소유권 자동 포함. [CAP-09](#jev-cap-09)·[ECS-01](#jev-ecs-01); [AG-03][a-ag3]·[Board 계약][c-board]·[HUM-AGENDA][h-board] |
| <a id="jev-canvas-01"></a>**JEV-CANVAS-01** 요청한 관계 그룹·배치 제안 (`S-CANVAS-J01`) | 정리 요청한 View 집합의 제목·유형·메모·관계 | 두 대상의 업무 관련도는? `Score` | System이 미리보기·좌표·충돌 회피·revision·undo를 처리. 담당 Agent는 grouping 제안 | 현재 배치 유지·수동 배치 | 미선택 View 이동·Board 소속 변경·포커스 강탈. [CAP-09](#jev-cap-09); [ECS-01 확장 제안](#jev-ecs-01); [V-02][a-v2]·[View 계약][c-view]·[HUM-SURFACE][h-surface] |
| <a id="jev-device-01"></a>**JEV-DEVICE-01** 인계 조건 누락 검사 (`S-DEVICE-J01`) | 인계 목적·제약·선택 manifest 설명·미완료 기록 | 각 조건이 인계 내용에 보존됐는가? 조건별 `Noul` | System이 참조 무결성·현재 권한·기기·실행 동일성 확인. 담당 Agent는 누락 보완 제안 | 확인 가능한 범위만 전달·누락 검토 | “검토만, 발송 금지” 누락; 준비를 전달·수락으로 표시. [CAP-10](#jev-cap-10)·[ECS-01](#jev-ecs-01); [DATA-01][a-data]·[§12][c-collab]·[반출 UX][u-portable]·[HUM-EXPORT][h-export] |
| <a id="jev-ont-01"></a>**JEV-ONT-01** Ontology 선택 참고자료 순위 (`S-ONT-J01`) | 요청·ACL 통과 unit ID·summary·관계·source revision·권위 manifest | 선택 참고자료의 관련도는? `Score` | System이 필수 seed·예외·dependency closure·권위 필터 유지. 정확 ID/용어/FTS와 비교하며 필수 자료는 점수로 제외하지 않음 | 명시 ID·정확 용어·FTS | 필수 예외를 낮은 점수로 삭제, archived 규칙을 현행으로 사용. [CAP-12](#jev-cap-12)·[ECS-07/01](#jev-ecs-07); [ONT-01][a-ont1]·[Ontology 계약][c-ontology]·[schema 읽기][schema-context]·[HUM-GOV][h-gov] |
| <a id="jev-ont-02"></a>**JEV-ONT-02** 분류·관계·위치 후보 (`S-ONT-J02`) | 후보 원문·기존 개념·허용 type/layer/facet·관계어휘·ID | 각 분류/관계 후보는 무엇인가? 차원별 `Choice(+미분류)` | System이 stable ID·schema·후보 저장·허용 위치 검사. 담당 Agent는 근거 제안, 원문 승격은 별도 정책 | 미분류 초안 유지 | 폴더명으로 정본 승격, canonical/projection identity 합침. [CAP-12](#jev-cap-12)·[ECS-07](#jev-ecs-07); [ONT-02][a-ont2]·[Ontology 계약][c-ontology]·[schema 필드][schema-fields]·[HUM-GOV][h-gov] |
| <a id="jev-ont-03"></a>**JEV-ONT-03** 규칙·예외 누락과 의미 관계 (`S-ONT-J03`) | source 구간·현재 규칙·candidate revision·조건·예외 | 예외 누락? `Noul`; source가 후보를 지지/모순/언급하지 않음? 별도 `Choice` | System이 원문 hash·권한·검사 revision·승격 정책 관리. 담당 Agent/위임된 검토자가 의미 finding 처리 | 미검증 상태·원문 재검토 | 구조·링크 PASS를 의미 보존 PASS로 확대. [CAP-12/13](#jev-cap-12)·[ECS-07](#jev-ecs-07); [ONT-02][a-ont2]·[Ontology 계약][c-ontology]·[HUM-GOV][h-gov] |
| <a id="jev-col-01"></a>**JEV-COL-01** 공동 편집의 의미 충돌 (`S-COL-J01`) | 기준본·현재본·두 변경안·작성자·revision | 양립/모순/판단 불가인가? `Choice` | System이 조건부 쓰기·병합·수락 권한 검사. 담당 Agent가 충돌 설명, 각 초안 보존 | diff와 각 초안 유지·권한 있는 작성자 선택 | “허용한다/허용하지 않는다” 자동 병합. [CAP-10](#jev-cap-10); 직접 ECS 없음, [ECS-01 확장](#jev-ecs-01); [COL-01][a-col]·[협업 계약][c-collab-detail]·[HUM-COLLAB][h-collab] |
| <a id="jev-share-01"></a>**JEV-SHARE-01** 허용된 반출 후보의 민감 위험 (`S-SHARE-J01`) | 처리 허용을 먼저 확인한 manifest·파생 text·명시 분류·수신 범위 | 지정 위험 유형이 포함됐는가? 유형별 `Noul` | System이 외부 처리 허용·identity·ACL·secret 제외·수신자·승인 검사. 낮은 위험값은 공유 허가가 아님 | 로컬 규칙·수동 검토·권한 불명 보류 | 민감정보 탐지를 위해 무단 외부 전송, 낮은 점수로 공개. [CAP-10](#jev-cap-10)·[ECS-07](#jev-ecs-07)·[ECS-01 인접 확장](#jev-ecs-01); [COL-01][a-col]·[반출 계약][c-portable-detail]·[HUM-EXPORT][h-export]·[HUM-COLLAB][h-collab] |
| <a id="jev-data-01"></a>**JEV-DATA-01** 보존 검토 순위 (`S-DATA-J01`) | 정책상 검토 가능한 미참조 항목 설명·출처·참조 상태 | 재사용 가치가 낮음/일부/명확함 중 어디인가? `Score` | System이 pin·retention·삭제 범위·GC 실행을 관리. 점수는 검토 순위이며 원문 삭제 명령이 아님 | 유지·검토 연기 | 고정 Snapshot·원본 로그를 점수만으로 삭제. [CAP-08/09](#jev-cap-09); 전용 ECS 없음, [ECS-01/06 인접](#jev-ecs-01); [DATA-01][a-data]·[§15][c-storage]·[HUM-SNAPSHOT][h-snapshot] |
| <a id="jev-ux-01"></a>**JEV-UX-01** 자연어 조작 도움 (`S-UX-J01`) | 명시 도움 요청·현재 허용 command ID·설명·상태 | 추천할 command는? `Choice(ID/없음)` | System이 실제 실행·명칭·키보드·focus·IME 처리. 추천 결과 수신은 실행 입력이 아님 | 명령 검색·기존 도움 경로 | 추천 도착 즉시 실행, 한글 조합 확정 Enter가 승인으로 연결. 전용 CAP/ECS 없음, [CAP-09](#jev-cap-09)·[ECS-01 재진입 보조](#jev-ecs-01); [UX-01][a-ux]·[§16][c-accessibility]·[HUM-A11Y][h-a11y] |

<a id="jev-capability-coverage"></a>
### 9.6 현행 CAP 13개·ECS 7개 적용 coverage

`적용 검토`는 기술 후보가 있다는 뜻이고 제품 채택·검증 완료가 아니다. `조건부`는 입력·권한·비용·효과가 확인될 때 유용성을 평가한다. `코드 전담`은 해당 보장을 Jev 판단에 맡기지 않는다는 뜻이다. 표에 직접 후보가 약한 부분도 그대로 남긴다. 전체 현황은 [후보 목록](#jev-browser-file-candidates)과 [검증 계획](#jev-validation-plan)으로 왕복한다.

| 현행 CAP | 후보·현재 판정 | 적용/보류/비적용 이유와 코드 전담 |
|---|---|---|
| <a id="jev-cap-01"></a>[CAP-01 Agent 설정·Engine·권한][cap-01] | 조건부: [JEV-AGENT-01](#jev-agent-01), [JEV-CTX-02](#jev-ctx-02) | 허용 후보의 적합성·기억 적용성 보조. 실제 계정·가용성·명시 pin·권한·실제 호출 binding은 코드 전담 |
| <a id="jev-cap-02"></a>[CAP-02 최소 Context·Reader][cap-02] | 적용 검토: [BF-04](#jev-bf-04)–[BF-07](#jev-bf-07), [BF-09](#jev-bf-09), [CTX-01](#jev-ctx-01), [READ-01](#jev-read-01) | 의미 검색·구간 선택·보드별 context 영향·추가 읽기 신호. 전체 읽기의 coverage와 지정 검색의 반환 계약·예산 계산은 System |
| <a id="jev-cap-03"></a>[CAP-03 Multi-Agent 감독][cap-03] | 조건부: [CHAT-01](#jev-chat-01), [AGENT-01](#jev-agent-01), [ORCH-01](#jev-orch-01)·[02](#jev-orch-02) | 담당·dependency·기여 재사용 검토. graph·lease·dispatch·완료 증거는 코드; 담당 Agent의 계획 책임 유지 |
| <a id="jev-cap-04"></a>[CAP-04 교정·clean-room][cap-04] | 적용 검토: [CHAT-01](#jev-chat-01), [CTX-02](#jev-ctx-02), [ORCH-02](#jev-orch-02), [POV-01](#jev-pov-01), [BF-10](#jev-bf-10) | 대상·조건·주장·화자 검사. source 격리·교정 이력·stale 연결·사용자 결정은 코드와 담당자 |
| <a id="jev-cap-05"></a>[CAP-05 Live identity·lease][cap-05] | 적용 검토: [BF-01](#jev-bf-01)–[BF-03](#jev-bf-03) | 후보 선택·관측 문구 분류. 권한·identity·focus·single-writer lease·인증 성공 확정에는 비적용 |
| <a id="jev-cap-06"></a>[CAP-06 경계별 복구][cap-06] | 조건부: [BF-02](#jev-bf-02), [RUN-01](#jev-run-01) | 코딩·Terminal의 비정형 오류 분류와 다음 read-only probe 선택에도 재사용. 구조화 오류·PTY 존속·입력 전달·권한·종료 상태·health·복구 receipt는 코드와 관측 증거. 모든 Terminal 호출 앞에 Jev를 필수화하지 않음 |
| <a id="jev-cap-07"></a>[CAP-07 외부 효과 승인·receipt][cap-07] | 핵심 보장 비적용; 보조: [BF-10](#jev-bf-10), [SHARE-01](#jev-share-01), [RUN-01](#jev-run-01) | 승인·idempotency·provider 접수·업무 완료를 확률로 통과시키지 않음. 근거 표현 검사·위험 신호·다음 조회 추천만 조건부 검토 |
| <a id="jev-cap-08"></a>[CAP-08 Answer·Snapshot·Live][cap-08] | 적용 검토: [BF-03](#jev-bf-03), [BF-05](#jev-bf-05)–[BF-10](#jev-bf-10), [CHAT-02](#jev-chat-02), [BRIEF-01](#jev-brief-01), [POV-01](#jev-pov-01), [DATA-01](#jev-data-01) | 출처 후보 연결·의미·업무 영향·설명 대상·주장 근거 판단. 원문·실제 전달·Answer identity·revision·보존은 코드 |
| <a id="jev-cap-09"></a>[CAP-09 Desk·Board·checkpoint][cap-09] | 조건부: [DISC-01](#jev-disc-01), [BOARD-01](#jev-board-01), [CANVAS-01](#jev-canvas-01), [DATA-01](#jev-data-01), [UX-01](#jev-ux-01), [BF-07](#jev-bf-07)·[10](#jev-bf-10) | 재개 자료 선택·배치·검토 순위 보조. 저장 범위 정책·복원 identity·checkpoint·실제 실행 복구는 코드 |
| <a id="jev-cap-10"></a>[CAP-10 기기·협업 인계][cap-10] | 조건부: [DEVICE-01](#jev-device-01), [COL-01](#jev-col-01), [SHARE-01](#jev-share-01) | 인계 조건·의미 충돌·반출 위험. grant·수신자·전송·접근·수락·동시 쓰기 검사는 코드; 실제 원격 실행은 승인 전 보류 |
| <a id="jev-cap-11"></a>[CAP-11 반복 업무·catch-up][cap-11] | 직접 전용 후보 보류; [BF-08](#jev-bf-08)·[09](#jev-bf-09), [RUN-01](#jev-run-01)을 조건부 재사용 | 반복 관측에서 판단 가치가 있을 때만. schedule·missed-run·dedupe·next due·전송 결과는 코드. 이 준비안이 상시 watcher나 반복비용을 생성하지 않음 |
| <a id="jev-cap-12"></a>[CAP-12 지식·Ontology][cap-12] | 적용 검토: [CTX-02](#jev-ctx-02), [ONT-01](#jev-ont-01)–[03](#jev-ont-03) | 선택 자료 순위·분류·예외 누락. 필수 closure·ACL·active binding·승격·활성화·rollback은 정책과 코드 |
| <a id="jev-cap-13"></a>[CAP-13 candidate→canonical][cap-13] | 부분 적용 검토: [BF-04](#jev-bf-04)·[05](#jev-bf-05)·[08](#jev-bf-08)·[09](#jev-bf-09)·[10](#jev-bf-10), [READ-01](#jev-read-01), [RUN-01](#jev-run-01), [POV-01](#jev-pov-01), [ONT-03](#jev-ont-03); 충돌은 [COL-01](#jev-col-01) 재사용 가능 | 파일·diff·코딩의 관련 파일 추천·변경 업무 영향·비정형 오류·결과 설명은 의미 판단 후보. 실제 파일 쓰기·조건부 저장·single writer·컴파일/테스트 판정·검사 revision·remote/deployment/current verification은 코드와 증거. 형식별 보기/편집 범위는 HUM-CODE 미결 유지 |

<a id="jev-scenario-coverage"></a>
| 현행 ECS | 적용 상황과 후보 | 남는 범위 |
|---|---|---|
| <a id="jev-ecs-01"></a>[ECS-01 업무 재개][ecs-01] | [DISC-01](#jev-disc-01)·[BOARD-01](#jev-board-01)·[DEVICE-01](#jev-device-01), [BF-07](#jev-bf-07)·[09](#jev-bf-09)·[10](#jev-bf-10), [AGENT-01](#jev-agent-01), [CTX-01](#jev-ctx-01)·[02](#jev-ctx-02), [ONT-01](#jev-ont-01); 인접 확장: [SHARE-01](#jev-share-01) | 현재 identity·권한·복구는 System. CANVAS/COL/UX와 반출 검토 SHARE 후보는 이 상황의 **확장 제안**이며 원 ECS에 이미 명시된 기능으로 주장하지 않음 |
| <a id="jev-ecs-02"></a>[ECS-02 자료 검토][ecs-02] | [BF-03](#jev-bf-03)–[BF-10](#jev-bf-10), [CHAT-01](#jev-chat-01)·[02](#jev-chat-02), [AGENT-01](#jev-agent-01), [CTX-01](#jev-ctx-01), [READ-01](#jev-read-01) | 원문 확보·coverage·읽기 범위·최종 Answer는 기존 책임 유지 |
| <a id="jev-ecs-03"></a>[ECS-03 Live 조작 관찰][ecs-03] | [BF-01](#jev-bf-01)–[BF-03](#jev-bf-03) | 실제 입력·secret·lease·사용자 양보·재관측은 코드. 직접 클릭 전부에 Jev를 끼우지 않음 |
| <a id="jev-ecs-04"></a>[ECS-04 새 권한·외부 효과][ecs-04] | 직접 자동 승인 후보 없음. [SHARE-01](#jev-share-01)·[BF-10](#jev-bf-10)의 보조 검토를 조건부 사용 | exact target·approval·receipt·query-before-replay는 코드. 기존 위임 안 행동마다 새 승인 요구 없음 |
| <a id="jev-ecs-05"></a>[ECS-05 단절 후 복구][ecs-05] | [BF-02](#jev-bf-02)·[RUN-01](#jev-run-01) | 경계 probe·복구 선택·checkpoint·중복 효과 방지는 코드. 미확인 원인 유지 |
| <a id="jev-ecs-06"></a>[ECS-06 분담·통합 결과 검토][ecs-06] | [ORCH-01](#jev-orch-01)·[02](#jev-orch-02), [CHAT-01](#jev-chat-01)·[02](#jev-chat-02), [AGENT-01](#jev-agent-01), [READ-01](#jev-read-01), [BF-08](#jev-bf-08)–[10](#jev-bf-10), [BRIEF-01](#jev-brief-01), [POV-01](#jev-pov-01) | 계획·통합·최종 답변은 담당 Agent; lifecycle·권한·판정 대상 revision은 System |
| <a id="jev-ecs-07"></a>[ECS-07 조직 Ontology 운영][ecs-07] | [ONT-01](#jev-ont-01)–[03](#jev-ont-03), [CTX-02](#jev-ctx-02), [SHARE-01](#jev-share-01) | 의미 판단 보조이며 업무 Owner·governance 권한·활성화 결정을 대신하지 않음 |

[JEV-DATA-01](#jev-data-01)은 보존 검토의 전용 ECS가 없고, [JEV-UX-01](#jev-ux-01)은 전용 CAP/ECS가 없다. 각각 인접 상황을 표시했으며 새 CAP/ECS를 만들어 coverage를 채우지 않았다.

<a id="jev-legacy-review"></a>
### 9.7 기존 §1–8 아이디어의 현재 재검토

아래 `채택 후보`는 실험 대상으로 남길 가치가 있다는 뜻이다. 실제 채택은 [검증 계획](#jev-validation-plan)과 [문서 반영 조건](#jev-document-matrix)을 거친다. 기존 수치·실행 예시는 측정 근거가 확인되기 전까지 **미검증**이며 본문을 소급 삭제·압축하지 않는다.

| 기존 절·아이디어 | 현재 분류 | 확인 근거·대체 경계 | 연결 후보/후속 |
|---|---|---|---|
| [§1.1][old-1] typed 판단 | 채택 후보 | Choice/Noul/Score의 현재 계약을 사용. Noul을 반환 Boolean이나 별도 confidence로 표기한 부분은 재검토. typed 출력은 정확성을 보장하지 않음. [공식 primitives][ts-choice] | §9.2와 전체 후보 |
| [§1.1–1.2][old-1] Non-Autoregressive·20–100ms·40–200배·40–400배 | 재검토 | 현재 읽은 공식 자료만으로 모델 내부 구조와 해당 비교 수치를 EG-Desk 보장으로 확정할 수 없음. 추출·네트워크·질문 수·fallback 포함 실측 필요 | [계측 계획](#jev-validation-plan) |
| [§2 Pillar 1][old-2] Firefox 내부 sub-30ms 직접 액션 | 재검토 | Jev는 텍스트 판단. Browser action·event wait·재관측은 코드. Canvas·가상화로 DOM 전체성 불명. [모델][ts-models]·[CAP-05][cap-05] | BF-01–03·05 |
| [§2 Pillar 2][old-2] 확률로 OAuth/SSO·서버 준비·성공 확정 | 해당 확정 방식 제외 후보 | UI 의미는 보조 신호. 실제 계정·권한·health·완료는 독립 검사. 구조화 결과가 있으면 코드 사용. [§14.1][c-identity]·[§13][c-failure] | BF-02, RUN-01 |
| [§2 Pillar 3][old-2] 위험 Score 하나로 명령 자동 통과 | 단독 안전 gate 제외 후보 | 낮은 위험 점수는 실행 권한이 아님. 정확 대상·sandbox·권한·비가역성·실행 조건은 코드. 언어적 위험 검토를 붙일지는 별도 측정 | CAP-07 코드 책임, SHARE-01 인접 보조 |
| [§2 Pillar 4][old-2] HUD 인텐트·액션 순위 | 채택 후보 | 명시 대상과 허용 command 우선. 추천 도착만으로 실행·focus 전환하지 않음 | CHAT-01, AGENT-01, UX-01 |
| [§2 Pillar 5][old-2] 제로 환각·90% 절감·문맥 100% 보존 | 보장 표현 제외 후보; 압축 보조 재검토 | raw 관측·정제 packet·실제 전달 범위·누락 정책을 보존. 요약으로 원문을 대체하지 않음. 전 범위 검토 여부는 manifest로 검사. [§2][c-read]·[§15][c-storage] | CTX-01, READ-01, BF-10 |
| [§3 전체][old-3] 로컬 대체 모델 표·정확도·속도·3-Tier | 재검토 | 원 초안의 프로젝트·모델·수치·라이선스는 이번 준비안에서 재현 검증하지 않음. TypeSafe 공식 Jev와 대체 구현을 별도로 평가. djev/vision 가능성을 Jev 1.13 기능으로 합치지 않음 | 공급자/엔진 선택 전 별도 검증 |
| [§4][old-4] 업무 50:50·80% 절감·LLM은 순수 생성만 | 수치·전면 역할 대체 재검토 | 업무 구성과 속도 이득은 측정 대상. 담당 Agent의 계획·판단·최종 Answer 소유권과 System 제어를 유지. [CAP-02/03][cap-02] | AGENT-01, ORCH-01/02 |
| [§5.1][old-5] 4-type 자동 태깅·경로로 분류 확정 | 분류 제안 채택 후보 | 문서 내용·schema·권위·현재 상태로 후보를 만들며 폴더명이나 점수로 정본 승격·metadata write를 확정하지 않음 | ONT-02 |
| [§5.2–5.3][old-5] 자율 GC·공고화 뒤 원문 즉시 삭제 | 무조건 자동 삭제/승격 제외 후보 | pin·참조·보존·권한·실제 사용자 정책을 System이 집행. Memory/Ontology 재사용은 별도 권한. [§15][c-storage]·[HUM-SNAPSHOT][h-snapshot]·[HUM-RUN][h-run] | DATA-01, CTX-02, ONT-03 |
| [§5.4][old-5] 툴 출력 스필·템플릿 치환 | 재검토 | 실제 읽기 결과와 정제 요약을 따로 명명하고 전달 lineage 유지. 길이만으로 잘라 정확 보존을 주장하지 않음 | CTX-01, READ-01 |
| [§6.1–6.2 Stage 1/2][old-6] 시제·출처 검사 | 채택 후보; 원천 차단 보장 재검토 | 시점·권위 metadata는 검증된 기록에 연결. 분류로 사실/계획 구분 오류를 완전히 막는다고 약속하지 않음 | CTX-02, BF-10, ONT-01 |
| [§6.2 Stage 3/4][old-6] 자동 폴더 배치·완료 발언으로 활성 자산 승격 | 위치 제안 재검토; 무검증 승격 제외 후보 | 사용자 보고·관측·추론·실제 적용 evidence를 구별. stable ID·허용 위치·승격/활성화 정책 확인. [ECS-07][ecs-07] | ONT-02/03, CAP-12 |
| [§6.3][old-6] 성공 예시 | 가정 기반 시연 후보 | 과거 상황을 새 기술로 다시 쓴 실행 증거로 사용하지 않음. 실제 수행은 NOT-RUN | [3관점 계획](#jev-validation-plan) |
| [§7][old-7] 전 시스템 완성·해마 100% 대체 | 전면 확정 해석 제외 후보 | 기능별 입력·실패·가치·권한·책임을 따로 평가. 원문 보존·저장·실행 책임은 코드에 남음 | [CAP coverage](#jev-capability-coverage) |
| [§8][old-8] 엔진·임계치·자동화 순서가 정해진 로드맵 | 재검토 | §9.9의 데이터 준비→읽기 보조→제안→조건부 자동화 순서로 비교. 고정 성능·임계치·자동 GC 채택 없음 | [우선순위](#jev-priority-approvals) |

<a id="jev-validation-plan"></a>
### 9.8 후보 시연·검증 계획 — 실제 실행 NOT-RUN

아래는 1인칭 mental walkthrough의 **계획**이다. 문장을 작성한 것을 사용성 시뮬레이션·실행 성공으로 기록하지 않는다. 실제 시뮬레이션 전에는 관련 RWS 원문을 좁혀 읽고 당시 사실과 새 제품 가정을 구분한다. [Governance 3관점 검토][gov-three].

| 계획 ID·후보 | 1인칭 사용자 행동 → 확인할 화면 결과 | System 처리 관점 | Agent 관측·요청 관점 |
|---|---|---|---|
| JEV-V01 · BF-01/02/03 | “비로그인으로 연 문서에 업무 계정을 적용한다.” → 같은 자리에서 지정 context로 reload, 실제 계정·접근/거부가 보임 | visible card와 browsing context를 구별, 미저장 form·secret·현재 target 검사 | 확보된 새 관측에서만 다음 탐색 요청; 로그인 성공을 추정하지 않음 |
| JEV-V02 · BF-04/05, READ-01 | “긴 한글 PDF와 웹문서를 전부 비교한다.” → 읽은/미확보/미판독 범위와 OCR 오류를 확인 | 요청 읽기 범위·누락·추출 실패·전 partition coverage 추적. 내부 검사 구성과 관계없이 전체 읽기 누락·허위 완료가 없는지 검사 | packet의 누락 요구를 찾아 기존 위임 안 원문 재진입; 별도 검사 Agent나 매번 사용자 답변을 필수화하지 않음 |
| JEV-V03 · BF-06/07/08/09 | “같은 원본을 A/B보드에서 쓰다가 수정한다.” → EG-Desk 수정 전 연결 보드 확인과 외부 앱 수정 후 변경 감지·재조회가 구분됨 | 코드의 연결 record 조회·수정 전 검사·외부 변경 관측·revision·기존 정책상 원문 보존을 대조. 자동 과거 버전 보관/최신 추종은 확정하지 않음 | 예정 diff와 관측 diff를 구분해 보드별 의미 영향만 제안; 연결 불명·미로드를 영향 없음/삭제로 단정하지 않음 |
| JEV-V04 · BF-10, BRIEF-01, POV-01 | “보고서의 당시 근거와 현재 자료를 비교하고 고객용 설명을 확인한다.” → 당시/현재·지지/불명·설명 대상이 구분됨 | 원문 인용 존재·당시 payload·Step target·권한 검증 | 주장 지원과 화자/내부 지시 누출을 각각 검사; 숨은 추론을 공개하지 않음 |
| JEV-V05 · CHAT-01/02, CTX-01 | “기본 Codex 또는 선택 Agent에서 두 업무 중 하나에 ‘이것도 고쳐줘’라고 쓴다.” → 대상·자료를 확인하고 다른 업무는 계속 | Profile 생성 전 기본 사용·명시 binding·Memo revision·trigger·수신자·중복 방지 확인. Jev 판정/로그로 대화가 혼잡해지는지 검사 | 모호성만 보정; 시선·View 이동으로 대상/응답 권한을 바꾸지 않음. 필요한 상세 확인 경로는 기존 정책 안의 후보로 검토 |
| JEV-V06 · AGENT-01, CTX-02 | “선택 모델로 B사 업무를 계속한다.” → 실제 계정·모델과 적용 기억을 확인 | pin·ACL·기억 조건·만료·비용·전송 범위 검사 | 허용 후보 추천·조건 내 기억 판단; A사 규칙을 재사용하지 않음 |
| JEV-V07 · ORCH-01/02, BF-08/09, READ-01, RUN-01, POV-01 | “코딩 분담 업무의 diff를 검토하고 Terminal 오류·끊긴 분기를 확인한다.” → 성공 기여·실제 검사 결과·취소/늦은 결과·unknown을 구별 | 실제 파일 쓰기·컴파일/테스트 판정·검사 revision·PTY 존속·입력 전달·권한·종료 증거, dependency·lease·취소 이후 실행 차단을 대조 | diff의 업무 영향·비정형 오류·늦은 기여·결과 설명을 검토. Terminal 호출마다 Jev를 요구하거나 미확인 외부 행동을 재전송하지 않음 |
| JEV-V08 · BF-04, DISC-01, BOARD-01, CANVAS-01, UX-01 | “편집·코딩에 관련된 파일과 업무 자료를 찾고 선택한 화면만 정리·저장한다.” → 관련 후보·배치 미리보기·실제 저장 범위 확인 | ACL·명시 선택·기존 저장 정책·좌표·undo·IME/focus 처리. 파일 추천·화면 저장을 실제 파일 쓰기 권한으로 해석하지 않음 | 의미 추천은 요청 범위 안에서; 매 클릭/저장/다음 버튼에 재추론을 강제하지 않음 |
| JEV-V09 · DEVICE-01, SHARE-01 | “검토만 허용한 자료를 다른 PC의 담당자에게 전달한다.” → 제외 자료·조건·전달/접근 상태 구분 | 외부 처리 허용을 선확인; identity·manifest·credential 제외·현재 권한 검사 | 허용 text에서 조건 누락·위험만 판단; 낮은 점수로 공유 허가하지 않음 |
| JEV-V10 · ONT-01/02/03 | “규칙 변경 후보를 검토한다.” → 원문·조건·예외·구조/의미 검사와 활성 상태 분리 | 필수 closure·stable ID·schema·source revision·승격 정책 집행 | 참고 순위·분류·예외 누락 finding; 구조 PASS를 의미 PASS로 확대하지 않음 |
| JEV-V11 · COL-01, DATA-01 | “상반된 두 수정안과 보존 후보를 검토한다.” → 각 초안과 pin/참조 상태 유지 | 조건부 쓰기·수락 권한·보존 정책·실제 삭제 결과 관리 | 충돌·검토 순위 제안; 모델 점수로 병합·삭제하지 않음 |
| JEV-V12 · 전 후보 | “같은 요청을 provider 장애·권한 철회·stale 상태에서도 이어간다.” → 가능한 결과와 막힌 범위만 보임 | timeout/429/스키마 오류·늦은 응답·authority epoch·input hash 검사, 독립 분기 유지 | 불확실을 명시하고 허용된 코드/상위 Agent 경로로 복귀 |

**비교 기준과 측정할 지표**

| 비교/측정 | 계획 |
|---|---|
| 기준선 | 같은 입력·권한·source revision에서 기존 코드/정확 검색/FTS·규칙, 기존 담당 Agent, Jev 보조 경로를 비교한다. 현행 구현 성능을 확인한 것으로 쓰지 않는다. |
| 정답·실패 분류 | 사람 검토 라벨과 근거 구간을 준비하고 누락 입력, 모델 오판, 코드 적용 오류, 서비스 실패를 분리한다. held-out 사례에서 검토하며 정답을 prompt로 재주입하지 않는다. |
| 의미 검색 | 후보 recall, 관련 구간 precision, no-match 오판, 중복/이동 anchor 정확도, 미확보 범위가 잘못 제외된 수를 측정한다. |
| 변경·영향·인용 | 의미 변경 누락/과잉 경고, 보드별 영향 precision/recall, 주장 지지 오판, 숫자·부정·조건·예외 오류를 측정한다. |
| 불확실 | Noul calibration, Choice/Score 분포와 실제 오류, abstention 비율, 자동 처리 범위별 오류와 검토 부담을 측정한다. cookbook의 0.8/0.9 등을 제품 임계치로 복사하지 않는다. |
| 한국어/CJK | 한글·영문 혼합, 띄어쓰기·OCR·약어·회사명·숫자·법인/역할 구분과 부정/예외 문장을 별도 층으로 평가한다. 영어 결과를 한국어 정확도로 환산하지 않는다. |
| 비용·시간 | 추출/OCR·상태 구성·네트워크·Jev·재시도·fallback 포함 p50/p95와 호출 수·입력 token·업무당 비용·사용자 대기 시간을 비교한다. 공급자 수치는 로컬 end-to-end 결과가 아니다. |
| 필수 불변조건 | 무권한 입력·실행·전송, 원문 덮어쓰기, credential 보존, 잘못된 identity 병합, 미완료 완료 표시, 취소된 작업 재개가 시험에서 발생하는지 검사한다. “0건 목표”는 달성 결과가 아니다. |
| 검증 결과 기록 | 모델 version·질문/후보 version·입력 hash·범위·코드 적용 결과·측정 시각을 연결한다. 실제 평가 전 값은 NOT-RUN으로 둔다. |

외부 평가 입력은 합성 자료 또는 별도로 외부 처리가 허용된 최소 자료부터 준비한다. 민감정보 탐지를 명분으로 원문을 먼저 전송하지 않는다. 실제 Jev 호출·실사용 데이터 전송·추가 비용은 이번 문서 편집에서 수행하지 않았다.

<a id="jev-priority-approvals"></a>
### 9.9 적용 준비 순서와 기존 정책 연결

| 순서 | 먼저 구체화할 범위 | 의존 조건·진행 기준 |
|---|---|---|
| P0 | 공통 관측·source/Board 부분·payload 역할·현재 권한·질문 기록 | 원문과 전달 요약의 구분, 명시 binding, bounded 입력, 기본 fallback을 설계한다. model 없이 확인할 값부터 식별 |
| P1 | BF-04/06/08/10, CTX-01, READ-01, POV-01, DISC-01 | 읽기·검색·검토 보조를 동일 사례의 코드/상위 Agent와 비교. 이득이 없는 호출은 채택하지 않음 |
| P2 | BF-01/02/03/05/07/09, CHAT-01/02, BRIEF-01, BOARD-01, CANVAS-01, UX-01 | 실제 source/target·부분 대응·사용자 관측·stale UI·입력 소유권과 같은 자리 reload를 확인 |
| P3 | AGENT-01, CTX-02, ORCH-01/02, RUN-01, DEVICE-01, ONT-01/02/03, COL-01, SHARE-01, DATA-01 | 실제 binding·동의·위임·동시성·보존/공유 정책과 비용이 준비된 범위에서만 평가. 보조 추천부터 시작 |
| 조건부 후속 | CAP-07 외부 효과, CAP-11 반복 감시 | 코드의 승인·receipt·schedule 보장을 먼저 유지하고 언어 판단의 추가 가치만 검토. 전수 적용을 목표로 삼지 않음 |

새 질문 원장을 만들지 않는다. 아래는 기존 HUM으로 연결할 **후보 영향**이며 이 표가 기존 상태를 변경하지 않는다. 일반 읽기·현재 위임 안 실행·저장마다 새로운 확인을 강제하지 않는다.

| 기존 결정 위치 | 이번 준비안이 연결할 질문/검사 |
|---|---|
| [HUM-ENGINE-001][h-engine]·[HUM-RUN-001][h-run] | 선택 모델·계정 pin, 허용 후보 추천, Jev provider·credential·추가 비용·전송 범위, 기억/자동 조정 사전 위임 |
| [HUM-SURFACE-001][h-surface]·[HUM-AGENDA-001][h-board] | 같은 자리 reload의 form/미저장 처리, live 재사용, 보드별 참조 부분과 기존 저장/복구 범위. 최신 추종/과거 고정 질문을 답변 완료로 처리하지 않음 |
| [HUM-CONV-001][h-conv] | Memo 후속 대화·proactive trigger·수신자·중복 알림·공유 범위 |
| [HUM-ANSWER-001][h-answer]·[HUM-BRIEF-001][h-brief] | 영향 제안 뒤 설명 갱신 방식, 수정본·Step·주석의 현재 정책 |
| [HUM-SNAPSHOT-001][h-snapshot]·[HUM-EXPORT-001][h-export] | 보존·권한 철회·가림·삭제 연동, 추가 원문/form 보관, 반출 포함 범위·암호화·복구 |
| [HUM-ORCH-001][h-orch] | 반복 업무가 필요할 때 기존 예약·닫기 정책과 연결. 단순 source 비교로 상시 감시를 생성하지 않음 |
| [HUM-CODE-001][h-code] | 형식별 보기·판독·편집·Snapshot 지원 범위와 OCR/Canvas/외부 편집 fallback은 미결 유지. 기존 BF/READ/RUN/POV 후보로 관련 파일 추천·diff 업무 영향·비정형 오류·설명을 검토하고, 실제 쓰기·컴파일/테스트 판정·PTY 존속·입력·권한·종료 증거는 코드 책임으로 유지 |
| [HUM-GOV-001][h-gov] | Ontology 후보·편집·의미 수락·승격·활성화 권한. 점수는 결정권이 아님 |
| [HUM-COLLAB-001][h-collab]·[HUM-REMOTE-001][h-remote] | 공유·삭제·동시 변경·제어 권한, 실제 서버·서비스·전송·동기화·보존·비용 |
| [HUM-A11Y-001][h-a11y] | 한국어/IME·키보드·비공간 도움 경로를 검증하고 최종 지원 약속과 연결 |

새 서비스/credential, 외부 자료 전송, 추가 반복비용·서버, 공유·삭제 권한 확대는 [기존 승인 registry][gov-approval]에 따라 정확한 대상·자료·비용을 제시할 별도 범위다. 로컬 문서 준비나 이미 위임된 읽기를 다시 승인받기 위한 새 gate로 사용하지 않는다.

<a id="jev-document-matrix"></a>
### 9.10 문서 반영 matrix

기술 선택이 사용자 경험·보장·책임을 바꾸는 곳만 수정 후보로 삼는다. 모든 문서에 Jev라는 단어를 삽입하는 작업이 아니다. 아래 링크는 현재 파일과 절을 확인한 상대 경로다. 이번 쓰기는 이 §9뿐이며, 대상 문서에서 §9로 돌아오는 역링크는 해당 문서 편집이 별도로 승인·채택될 때 같은 stable ID로 추가한다. 기존 ID·alias를 다시 번호 매기지 않는다.

| 문서·검토할 절 | 원문이 사용되는 이유 | 반영할 내용·조건 | 이번 상태 |
|---|---|---|---|
| [Jev 초안 §9](#jev-preparation-20260926) | 기술 후보·과거 아이디어 재검토의 통합 위치 | 32개 후보·33개 상황·coverage·검증·변경 계획. [기존 절 검토](#jev-legacy-review)와 후보를 연결 | **현재 유일한 편집 대상** |
| [Atlas 기능 색인][a-index]·[Browser][a-tool1]·[파일][a-tool2]·[읽기][a-r1]·[Answer][a-ai4] | 사람이 하는 UI 행동·화면 결과의 기준 | 채택 후 target 선택·수정 전 연결 보드 확인/외부 수정 후 감지·근거/영향·복귀를 각 trace에 반영. 파일·diff·코딩·Terminal의 적용/비적용 경계와 기본 Codex 대화 흐름도 확인. JEV 준비안 ID를 제품 객체로 승격하지 않음 | 후속 수정 후보 |
| [Contract §2][c-context]·[§14][c-binding]·[§15][c-storage]·[§17][c-details] | 입력·판단·실행권한·실패·보존 보장의 기준 | 요청 읽기 범위·미확보 추적과 내부 구조 재량, Jev 판정·authority·fallback·원문/packet lineage를 계약화. §6·7의 파일/코딩·Terminal에서는 실제 쓰기·컴파일/테스트 판정·PTY·입력 전달·종료 증거의 코드 책임을 유지 | 후속 수정 후보 |
| [ECS 7개][ecs-section]·[CAP 13개][cap-section] | 실제 사용 목적·전환·책임·실패 범위 | 기존 ID에서 도움 되는 좁은 판단과 미적용 보장을 설명. 전용 상황 없는 후보는 확장/인접으로 명시 | 후속 수정 후보 |
| [UX §3][u-reading]·[§4][u-policy]·[§6][u-observation] | 구체 반응·불확실·재연결·사용자 조작 | 같은 자리 reload·부분 대응·불명/미판독·영향 제안·기존 코드 fallback·비간섭을 필요한 화면에만 설명 | 후속 수정 후보 |
| [Owner 원장][h-top] | 실제 미결정과 결정 상태의 소유자 | 이번 영향은 기존 HUM에 연결. 사용자 답 없이 OPEN을 닫거나 새 확정값을 넣지 않음 | OPEN 15 유지 |
| [Governance][gov-top]·[3관점 검토][gov-three] | 문서 권위·화자·stable ID·검증 근거 관리 | source/모델/질문 revision·실측·문서 검사와 NOT-RUN을 구분. 기술 검토 문장을 사용자 매뉴얼/백서 발화로 복사하지 않음 | 후속 근거 동기화 후보 |
| [docs/README][docs-start] | 목적별 읽기 입구 | 채택된 준비안·정본의 읽기 경로만 동기화 | 채택 후 동기화 |
| [project-context의 source precedence][project-context] | 채택 범위·구현 상태와 정본 우선순위 | 준비/채택/구현/실증을 구별해 프로젝트 context에 반영 | 채택 후 동기화 |
| [Production_v8 백서의 근거 설명][whitepaper] | 업무 담당자·의사결정자에게 사용자 효과 설명 | 사용자 효과가 실제로 달라질 때만 영향 검토. Jev 브랜드·개발 메타·편집 지시를 삽입하지 않음 | 조건부 영향 검토 |
| [firefox-ui-demo README][app-readme] | 실제 데모·사용·검증 범위 안내 | 실제 채택·구현 뒤 사용 가능한 동작과 검증을 동기화 | 현 단계 변경 없음 |
| [Browser observation runtime][browser-runtime] | before/action/after/diff/notification 계약 | raw 관측과 의미 판단·부분 범위·stale·미로드·Jev 장애의 구분을 직접 수정 후보로 검토. 문서의 Implemented 표기를 새 Jev 구현 증거로 확대하지 않음 | 직접 수정 후보, 이번에는 읽기만 |
| [Human-in-the-loop Await][await-model] | 조건·대기·재개 책임 | 의미 신호와 실제 authority/완료 조건·checkpoint·재조회 경계를 직접 수정 후보로 검토 | 직접 수정 후보, 이번에는 읽기만 |
| [Chat/Canvas Agent layer][layer-model] | 대화·작업·생각 공간·관찰 투영 | 채택된 대상 선택·Memo·Briefing·원문/요약·화자 검사 부분의 영향만 검토 | 해당 부분 영향 검토 |
| [Desk/Board runtime][board-runtime]·[SourceRef][runtime-source] | 저장·view/runtime 수명·출처 참조 | 보드별 사용 부분·source identity와 수정 전 다른 보드 연결 조회/외부 수정 후 감지·재조회 관계를 검토. 연결·보존은 코드, 의미 영향은 Jev 보조로 구분하며 자동 과거 버전 보관·최신 추종은 기존 미결 정책 유지 | 해당 부분 영향 검토 |
| [Ontology schema 관계][schema-relations]·[읽기 규칙][schema-context] | 채택된 개념/관계·필수 읽기 경계 | 원본 Markdown/frontmatter의 관계 의미가 채택됐을 때만 schema·해당 원본 수정. Jev 점수만으로 원본을 이동·승격하지 않음 | 조건부 원본 수정 후보 |
| [ontology/index][ontology-index]·[generated graph][generated-graph] | 원본 선택 경로와 파생 표시 | 원본이 실제로 바뀔 때만 index·생성 graph 동기화. 생성 graph를 정본으로 편집하지 않음 | 원본 변경 전 동기화 없음 |
| [AGENTS.md][main-profile]·[egdesk-pm.toml][pm-profile] | 운영 역할·라우팅 지침 | 후보 기술 추가만으로 역할·권한·프로필을 바꿀 필요 없음 | **변경 불필요** |
| [기존 사례·원문 인용 경계][gov-top] | 과거 사실과 결정 근거 | 과거 사례를 Jev로 수행한 것처럼 역사 수정하지 않음. 필요한 경우 현재의 별도 적용 제안으로 연결 | 원문 보존 |

JSON/TOML 대상은 문서 section anchor가 없는 파일 링크다. Markdown은 확인한 명시 anchor 또는 현 heading anchor를 사용한다. 후보→CAP/ECS→후보, 후보→정본, 검토표→기존 초안, matrix→후보/검증 계획의 탐색 관계를 유지한다.

<a id="jev-official-sources"></a>
### 9.11 공식 근거와 확인 범위

확인일은 2026-09-26이다. 아래 자료는 지원 범위와 질문 분해의 근거이며 EG-Desk 구현·한국어 정확도·성능 결과가 아니다.

| 공식 자료 | 이번 준비안에 사용한 범위·한계 |
|---|---|
| [TypeSafe Models][ts-models]·[State][ts-state] | `jev-1.13.0`, text-only, CJK 정확도 주의, 확보한 text/구조 상태를 입력. 모델 alias 변화에 대비해 평가 version을 기록 |
| [Confidence][ts-confidence]·[Choice][ts-choice]·[Noul][ts-noul]·[Score][ts-score] | 타입·확률·confidence 의미와 uncertainty 경로. 타입/확신을 사실·권한·완료 보장으로 사용하지 않음 |
| [Use-case map][ts-usecases] | 검색·분류·순위·검사 등 후보 탐색의 출발점. 예시가 EG-Desk 채택이나 성능 검증을 뜻하지 않음 |
| [semantic_find][ts-find] | 구간 ID 선택과 답 존재 검사를 분리. 후보에 없는 자료를 찾을 수 있다고 주장하지 않음 |
| [citation_check][ts-citation] | 코드의 인용 존재 확인 뒤 문맥상 지지 검사. cookbook의 작은 예시·모델 version·임계치를 제품 결과로 복사하지 않음 |
| [Google Docs Canvas 발표][g-canvas] | HTML 구조 의존의 한계. 2021년 발표의 공식 번역본을 읽었으며 현재 모든 문서의 렌더/접근성 동작을 실측한 것은 아님 |
| [Word 웹 기능표][ms-word] | 브라우저 UI도 버전 기록·내보내기 등을 제공하므로 API만 가능한 기능으로 과장하지 않음 |
| [Drive 알림][g-push]·[변경 기록][g-changes]·[파일 metadata][g-files]·[Docs revision][g-docs] | 알림/metadata와 본문 diff 구별, 권한·사용자·현재 상태 범위, revision ID 한계. browser-first를 API 필수 설계로 바꾸지 않음 |
| [RFC 9110 조건부 요청][http-conditional] | ETag/Last-Modified는 선택된 응답의 재검증 수단. 특정 보드의 의미 변화나 업무 영향 증거는 별도 |

<a id="jev-edit-verification"></a>
### 9.12 편집 인계와 검증 상태

- 이번 산출물은 기존 파일 뒤에 추가한 §9다. 기존 48,121 bytes·572줄 prefix, 다른 dirty/untracked 자료와 Git index·HEAD·branch는 변경 대상이 아니다.
- 자체 점검은 §9의 상대 경로·fragment·명시 anchor 중복, 32개 후보/33개 상황, CAP 13개/ECS 7개, 공식 text-only/CJK·권한·보존 경계와 원 prefix 일치를 대상으로 한다. 최종 전체 QA와 제품 검토는 별도 담당자가 수행한다.
- 실제 Jev 평가·한국어 실측·앱 구현·사용자 시뮬레이션·실사용 데이터 전송은 **NOT-RUN**이다. 문서 링크/편집 검사를 이 결과와 혼동하지 않는다.
- 후속 문서 반영은 [matrix](#jev-document-matrix)의 해당 범위만 별도로 진행한다. 검토 결과가 추가되면 이 준비안의 후보 ID와 기존 stable ID를 유지해 수정한다.

<a id="jev-briefing-latency-review"></a>
### 9.13 Answer Briefing 준비·탐색 지연 검토 — JEV-BRIEF-01 확장

이 절은 기존 [JEV-BRIEF-01](#jev-brief-01)의 상세 검토다. **32개 후보·33개 사용상황의 수는 유지**한다.
[CAP-08](#jev-cap-08)·[ECS-06](#jev-ecs-06)의 단계별 설명에 연결하며, [Contract §8][c-brief]·[Atlas AI-05][a-ai5]를 따른다.
대상은 고정된 Canvas 자료·산출물을 Step의 focus 범위로 보여 주는 Answer Briefing이다.
새 제품 객체·기본 UX·편집/공유 정책은 확정하지 않으며 [HUM-BRIEF][h-brief]·[HUM-ANSWER][h-answer]의 남은 선택을 유지한다.
**현재 상태: 실제 API 평가·UI 시뮬레이션·Firefox 성능 측정 NOT-RUN. 아래는 비교할 설계 가설과 검증 계획이다.**

#### 여섯 지연 구간과 판단 역할

| 지연 구간 | 검토할 최적화 | 책임·한계 |
|---|---|---|
| 자료 선택 | 기존 tool 결과·고정 Snapshot·Answer reportItems를 후보로 재사용하고 코드로 범위를 좁힌 뒤 Jev가 설명 목적별 관련성을 평가 | System이 source·범위·권한을 확인. Jev는 확보된 text/검증된 구조 표현만 판단하며 이미지·차트의 보이지 않는 내용을 추측하지 않음 |
| 근거 연결 | 코드가 ID·revision·인용 위치·lineage를 검사하고, 필요한 주장–근거 후보쌍에만 Jev의 지지/반박/무관/불명 판단을 적용 | 실제 확보 근거와 의미 검토를 함께 확인. Jev 확신을 사실 인증·전체 판독 완료로 승격하지 않음 |
| 단계·순서 구성 | 제한된 비교/타임라인/요약+근거 표현형 중 적합한 후보를 Jev가 추천하고 코드가 지원 템플릿을 준비 | 해당 없음·기존 구성 유지도 가능. 담당 모델이 설명의 이야기 순서와 단계 연결을 구성하며 점수순 정렬로 발표 순서를 대체하지 않음 |
| 설명문 작성 | 선별된 자료와 근거를 담당 모델에 함께 전달하고, 변경된 단계의 설명만 필요한 범위에서 재작성 | 실제 한국어 문장·서사·조건/예외 설명은 담당 모델 소유. Jev는 설명 생성기를 대신하지 않음 |
| 레이아웃·렌더 | 코드 템플릿으로 target 배치·강조·framing을 계산하고 인접 Step의 필요한 렌더 자원을 선행 준비 | Firefox layout·GPU·이미지/문서 디코딩·viewer mount 비용은 별도 프로파일링. Jev 판단 속도로 해결됐다고 주장하지 않음 |
| 게시 후 탐색 | 고정 Step 설명·targetRefs·focus plan을 사용해 로컬에서 다음/이전/전체 보기 전환 | **Next/Previous 클릭마다 LLM/Jev 왕복하지 않음.** 권한·target 유효성 검사와 기존 오류/재연결 경로는 계속 적용 |

#### 후보 준비·독립 질문·점수 재사용

- 이미 읽은 tool 결과와 Answer에 연결된 자료를 우선 사용한다. 같은 내용을 선별하기 위해 원문을 다시 수집하지 않는다.
  누락·변경·접근 상태 때문에 추가 확보가 필요하면 기존 읽기 경로와 권한 범위에서 처리한다.
- 코드가 명시 source 관계·자료형·허용 범위·기존 Step 연결로 후보를 좁힌 뒤 필요한 쌍만 평가한다.
  후보 수 × Step 수 전체를 모델 호출로 펼치지 않고 후보 수·실제 평가쌍 수를 함께 기록한다.
- 입력은 고정 Answer/자료 revision, 설명 목적, 후보 ID와 실제 text, 지원 표현형 목록이다.
  Choice에는 해당 없음/판단 불가를 두고, 관련성·설명 적합성·중복 정도는 각각 좁은 질문으로 평가한다.
- [Fan-out](https://docs.typesafe.ai/patterns/fan-out)은 **같은 state를 보는 독립 질문을 한 request에서 병렬 평가**하는 데 적용한다.
  자료 선택 결과가 있어야 만들 수 있는 Step 질문이나 생성된 설명의 검사는 선행 결과를 받은 뒤 실행한다.
- [Composite scoring](https://docs.typesafe.ai/patterns/composite-scoring)에 따라 독립 점수와 분포를 보존한다.
  입력과 판단 기준이 같을 때 표시 우선순위의 가중치만 바꿔 재조합하면 재호출을 줄일 수 있다.
- 출처 유효성·현재 권한·필수 근거 충족은 별도의 하드 조건이다. 미감·관련성·설명 적합성 점수로 보상 통과시키지 않는다.
  의미상 지지가 불확실하면 담당 모델의 재검토 대상으로 남기고, 검사 완료처럼 표시하지 않는다.
- 필수 자료·미확보 pending을 낮은 점수로 제거하지 않는다. 전체 읽기 coverage는 기존 System 기록과 추가 읽기로 확인한다.
- Jev 단계 자체의 상태 구성·네트워크·재시도 시간이 추가된다. 선별·재검토 감소보다 크면 전체 준비가 느려질 수 있다.
  기존 경로와 비교해 이득이 없는 질문은 생략하며 모든 Step에 Jev 검사를 강제하지 않는다.

#### 캐시·프레이밍·자원 선행 준비

판단 캐시의 재사용 조건에는 다음 입력을 포함한다.

- source snapshot/hash·source revision·Answer revision;
- goal/read intent·설명 목적·독자/화자 등 판단에 영향을 주는 맥락;
- 질문·criteria/rubric version·Jev model version·후보 manifest와 평가 대상쌍;
- 평가에 사용한 자료 범위와 공개 조건. 권한은 캐시 적중과 별도로 전송·표시 직전에 재검사한다.

source/Answer revision, 질문이나 맥락이 바뀌면 영향받은 캐시를 재검증하고 필요한 판단만 다시 수행한다.
가중치 변경이 질문 의미·등급 기준까지 바꾸면 기존 점수의 단순 재조합으로 처리하지 않는다.
Step 설명·구성 캐시는 그 판단 입력과 실제 Step plan·담당 모델 구성을, 렌더 캐시는 target revision·자료형·layout 조건을 함께 확인한다.
권한 철회·가림·target 변경을 오래된 캐시로 우회하지 않으며 과거 Snapshot을 현재 Live로 대체하지 않는다.

카메라 pan·zoom·focus만 바뀌고 내용/layout이 같으면 의미 판단과 고정 자료를 재사용하고 framing만 계산한다.
실제 내용, target geometry, viewer layout 또는 Browser 내부 viewport가 바뀌면 좌표·선택 범위를 다시 검증한다.
의미 입력도 바뀐 경우에만 해당 판단·설명을 갱신한다. 프리패치를 위해 사용자의 Live Browser 크기나 입력 대상을 바꾸지 않는다.
코드는 현재·다음·이전 Step의 허용된 Snapshot preview·필요 렌더 자원을 메모리/IO 예산 안에서 선행 준비한다.
원문 재조회·Live 조작·모델 실행은 단순 탐색 프리패치에 암묵적으로 포함하지 않는다.

#### 최초 유용한 Step·시안·게시 경계

최초 유용한 화면은 **실자료와 그 자료를 설명하는 문장이 함께 있는 사용 가능한 Step**으로 측정한다.
spinner·빈 목차·준비 메시지만 나온 시점은 이 지표의 완료가 아니다.
준비 상태는 기존 활동 표시 또는 사용자가 직접 연 시안에서 살피는 선택 후보로 둔다.
Chat에 단계 목록·진행 로그를 자동 누적하는 기본 UX를 확정하지 않고 사람 간 대화처럼 이어지는 흐름을 유지한다.
미완 시안은 준비 중 범위와 확인되지 않은 부분을 드러내며 게시본·최종 판단과 구별한다.
참조·권한을 확인한 실제 자료만 시안에 표시하고, 불명 근거를 비슷한 자료나 다른 revision으로 채우지 않는다.
준비 완료나 백그라운드 렌더만으로 사용자 카메라·입력 focus를 이동하지 않는다.
사용자가 브리핑을 열거나 단계를 이동할 때 해당 presentation 전환을 적용한다.
target 유실·권한 변경에는 기존 정책이 허용하는 당시 자료 보기·재연결·제외/대체·오류 안내를 적용한다.
그 경로에서 필요한 명시적 요청과 검사를 유지하며, 이번 속도 검토로 새로운 일괄 복구 금지 정책을 만들지 않는다.
Jev 불확실·공급자 장애에는 담당 모델의 기존 경로로 복귀한다. 준비 실패에도 기존 Answer·게시본·초안을 보존한다.

#### 비교 평가 — NOT-RUN

같은 Answer/source revision·요청·권한·기기·Firefox 환경에서 아래 세 경로를 비교한다.
A는 기존 담당 LLM 경로, B는 **코드 템플릿·선별·사전계산만 추가**한 경로, C는 **B에 좁은 Jev 판단을 추가**한 경로다.
B/C에서도 실제 설명문은 같은 담당 모델이 작성하며 설명 생성 조건을 고정해 비교한다.

| 측정 축 | 기록할 값·실패 조건 |
|---|---|
| 최초 유용한 Step | 요청 수락부터 검증된 실자료·설명이 함께 사용 가능할 때까지의 시간; 빈 목차·spinner 제외 |
| 전체 준비 | 전체 Step·설명·필수 근거 검사·게시 완료까지의 시간; 시안 표시를 전체 완료로 집계하지 않음 |
| Next 전환 p95 | 사용자 입력부터 대상·설명이 안정적으로 표시될 때까지; cache hit/miss·자료형·기기 조건을 분리 |
| 호출·입력·후보량 | LLM/Jev 호출 수·입력 token·실제 후보/평가쌍 수·재시도·fallback·업무당 비용과 cache hit/miss |
| 근거·설명 품질 | 잘못된 근거 연결·조건/예외 누락, Step 간 설명 일관성, 한국어 자연스러움·부정/생략 해석 |
| 화면 품질·렌더 | 좁은 화면 혼잡·가독성·대상 식별·프리패치 메모리/IO, Firefox layout·GPU·디코딩·mount 구간별 시간 |
| 경계·회복 | 권한 철회·stale/유실 target·캐시 무효화·공급자 장애, 강제 카메라 이동·Next 모델 호출·미완 게시 오인 여부 |

이는 측정 항목 제안이며 속도 목표치·개선율·통과 실적을 부여하지 않는다. 실제 API/UI 시뮬레이션은 **NOT-RUN**이다.
외부 자료 전송·Jev credential·추가 비용·서버 도입은 [기존 승인 범위](#jev-priority-approvals)를 따르며 이 문서 보완으로 승인되지 않는다.

[ts-models]: https://docs.typesafe.ai/models
[ts-state]: https://docs.typesafe.ai/concepts/state
[ts-confidence]: https://docs.typesafe.ai/confidence
[ts-usecases]: https://docs.typesafe.ai/concepts/use-case-map
[ts-find]: https://docs.typesafe.ai/cookbooks/semantic_find
[ts-citation]: https://docs.typesafe.ai/cookbooks/citation_check
[ts-choice]: https://docs.typesafe.ai/primitives/choice
[ts-noul]: https://docs.typesafe.ai/primitives/noul
[ts-score]: https://docs.typesafe.ai/primitives/score
[g-canvas]: https://workspaceupdates-es.googleblog.com/2021/05/documentos-de-google-ahora-usara.html
[ms-word]: https://support.microsoft.com/en-us/word/word-features-comparison-word-for-the-web-vs-desktop
[g-push]: https://developers.google.com/workspace/drive/api/guides/push
[g-changes]: https://developers.google.com/workspace/drive/api/guides/about-changes
[g-files]: https://developers.google.com/workspace/drive/api/reference/rest/v3/files
[g-docs]: https://developers.google.com/workspace/docs/api/reference/rest/v1/documents
[http-conditional]: https://www.rfc-editor.org/rfc/rfc9110.html#section-13
[a-index]: ../confirmed/EGDESK_PRODUCT_INTERACTION_TRACE_ATLAS.md#7-기능별-사용-흐름-색인
[a-tool1]: ../confirmed/EGDESK_PRODUCT_INTERACTION_TRACE_ATLAS.md#atlas-tool-01
[a-tool2]: ../confirmed/EGDESK_PRODUCT_INTERACTION_TRACE_ATLAS.md#atlas-tool-02
[a-b1]: ../confirmed/EGDESK_PRODUCT_INTERACTION_TRACE_ATLAS.md#atlas-browser-01
[a-b2]: ../confirmed/EGDESK_PRODUCT_INTERACTION_TRACE_ATLAS.md#atlas-browser-02
[a-b3]: ../confirmed/EGDESK_PRODUCT_INTERACTION_TRACE_ATLAS.md#atlas-browser-03
[a-source-ref]: ../confirmed/EGDESK_PRODUCT_INTERACTION_TRACE_ATLAS.md#atlas-obj-015
[a-chat]: ../confirmed/EGDESK_PRODUCT_INTERACTION_TRACE_ATLAS.md#atlas-chat-01
[a-ai2]: ../confirmed/EGDESK_PRODUCT_INTERACTION_TRACE_ATLAS.md#atlas-ai-02
[a-ai4]: ../confirmed/EGDESK_PRODUCT_INTERACTION_TRACE_ATLAS.md#atlas-ai-04
[a-ai5]: ../confirmed/EGDESK_PRODUCT_INTERACTION_TRACE_ATLAS.md#atlas-ai-05
[a-ai6]: ../confirmed/EGDESK_PRODUCT_INTERACTION_TRACE_ATLAS.md#atlas-ai-06
[a-r1]: ../confirmed/EGDESK_PRODUCT_INTERACTION_TRACE_ATLAS.md#atlas-read-01
[a-r2]: ../confirmed/EGDESK_PRODUCT_INTERACTION_TRACE_ATLAS.md#atlas-read-02
[a-r3]: ../confirmed/EGDESK_PRODUCT_INTERACTION_TRACE_ATLAS.md#atlas-read-03
[a-agent]: ../confirmed/EGDESK_PRODUCT_INTERACTION_TRACE_ATLAS.md#atlas-agent-01
[a-agent2]: ../confirmed/EGDESK_PRODUCT_INTERACTION_TRACE_ATLAS.md#atlas-agent-02
[a-sys]: ../confirmed/EGDESK_PRODUCT_INTERACTION_TRACE_ATLAS.md#atlas-sys-01
[a-memo]: ../confirmed/EGDESK_PRODUCT_INTERACTION_TRACE_ATLAS.md#atlas-canvas-01
[a-pov]: ../confirmed/EGDESK_PRODUCT_INTERACTION_TRACE_ATLAS.md#58-작업-기록답변산출물의-화자와-표시
[a-data]: ../confirmed/EGDESK_PRODUCT_INTERACTION_TRACE_ATLAS.md#atlas-data-01
[a-v2]: ../confirmed/EGDESK_PRODUCT_INTERACTION_TRACE_ATLAS.md#atlas-v-02
[a-v3]: ../confirmed/EGDESK_PRODUCT_INTERACTION_TRACE_ATLAS.md#atlas-v-03
[a-ag3]: ../confirmed/EGDESK_PRODUCT_INTERACTION_TRACE_ATLAS.md#atlas-ag-03
[a-ont1]: ../confirmed/EGDESK_PRODUCT_INTERACTION_TRACE_ATLAS.md#atlas-ont-01
[a-ont2]: ../confirmed/EGDESK_PRODUCT_INTERACTION_TRACE_ATLAS.md#atlas-ont-02
[a-col]: ../confirmed/EGDESK_PRODUCT_INTERACTION_TRACE_ATLAS.md#atlas-col-01
[a-ux]: ../confirmed/EGDESK_PRODUCT_INTERACTION_TRACE_ATLAS.md#atlas-ux-01
[c-context]: ../confirmed/EGDESK_INTERACTION_AND_ORCHESTRATION_CONTRACT.md#tech-context-assembly
[c-read]: ../confirmed/EGDESK_INTERACTION_AND_ORCHESTRATION_CONTRACT.md#tech-smart-read
[c-reader]: ../confirmed/EGDESK_INTERACTION_AND_ORCHESTRATION_CONTRACT.md#tech-reader-session
[c-recovery]: ../confirmed/EGDESK_INTERACTION_AND_ORCHESTRATION_CONTRACT.md#tech-read-recovery
[c-identity]: ../confirmed/EGDESK_INTERACTION_AND_ORCHESTRATION_CONTRACT.md#tech-engine-profile
[c-binding]: ../confirmed/EGDESK_INTERACTION_AND_ORCHESTRATION_CONTRACT.md#tech-agent-run-binding
[c-storage]: ../confirmed/EGDESK_INTERACTION_AND_ORCHESTRATION_CONTRACT.md#tech-storage-export
[c-observation]: ../confirmed/EGDESK_INTERACTION_AND_ORCHESTRATION_CONTRACT.md#tech-observation-fidelity
[c-chat]: ../confirmed/EGDESK_INTERACTION_AND_ORCHESTRATION_CONTRACT.md#impl-chat-request
[c-memo]: ../confirmed/EGDESK_INTERACTION_AND_ORCHESTRATION_CONTRACT.md#impl-canvas-annotation
[c-profile]: ../confirmed/EGDESK_INTERACTION_AND_ORCHESTRATION_CONTRACT.md#impl-agent-profile
[c-budget]: ../confirmed/EGDESK_INTERACTION_AND_ORCHESTRATION_CONTRACT.md#impl-context-budget
[c-orch]: ../confirmed/EGDESK_INTERACTION_AND_ORCHESTRATION_CONTRACT.md#tech-dependency-orchestration
[c-run]: ../confirmed/EGDESK_INTERACTION_AND_ORCHESTRATION_CONTRACT.md#impl-run-orchestration
[c-failure]: ../confirmed/EGDESK_INTERACTION_AND_ORCHESTRATION_CONTRACT.md#tech-failure-boundaries
[c-brief]: ../confirmed/EGDESK_INTERACTION_AND_ORCHESTRATION_CONTRACT.md#tech-answer-briefing
[c-pov]: ../confirmed/EGDESK_INTERACTION_AND_ORCHESTRATION_CONTRACT.md#tech-output-situation
[c-discovery]: ../confirmed/EGDESK_INTERACTION_AND_ORCHESTRATION_CONTRACT.md#impl-discovery
[c-board]: ../confirmed/EGDESK_INTERACTION_AND_ORCHESTRATION_CONTRACT.md#impl-board
[c-view]: ../confirmed/EGDESK_INTERACTION_AND_ORCHESTRATION_CONTRACT.md#impl-view
[c-collab]: ../confirmed/EGDESK_INTERACTION_AND_ORCHESTRATION_CONTRACT.md#tech-collaboration-computer-use
[c-collab-detail]: ../confirmed/EGDESK_INTERACTION_AND_ORCHESTRATION_CONTRACT.md#impl-e24-collaboration-authority
[c-portable-detail]: ../confirmed/EGDESK_INTERACTION_AND_ORCHESTRATION_CONTRACT.md#impl-portable
[c-ontology]: ../confirmed/EGDESK_INTERACTION_AND_ORCHESTRATION_CONTRACT.md#impl-e24-ontology-resolution
[c-accessibility]: ../confirmed/EGDESK_INTERACTION_AND_ORCHESTRATION_CONTRACT.md#tech-accessibility
[c-details]: ../confirmed/EGDESK_INTERACTION_AND_ORCHESTRATION_CONTRACT.md#implementation-design-details
[u-identity]: ../../docs/references/design-synthesis/egdesk-ux-realization-proposals.md#ux-detail-identity
[u-reading]: ../../docs/references/design-synthesis/egdesk-ux-realization-proposals.md#flow-reading
[u-answer]: ../../docs/references/design-synthesis/egdesk-ux-realization-proposals.md#ux-detail-answer-revisions
[u-observation]: ../../docs/references/design-synthesis/egdesk-ux-realization-proposals.md#ux-detail-reader-observation
[u-portable]: ../../docs/references/design-synthesis/egdesk-ux-realization-proposals.md#flow-portable
[u-policy]: ../../docs/references/design-synthesis/egdesk-ux-realization-proposals.md#ux-policy-options
[h-top]: ../../docs/codex/egdesk-product-interaction-trace-atlas-editorial-ledger.md#gap-owner-queue
[h-board]: ../../docs/codex/egdesk-product-interaction-trace-atlas-editorial-ledger.md#hum-agenda-001
[h-surface]: ../../docs/codex/egdesk-product-interaction-trace-atlas-editorial-ledger.md#hum-surface-001
[h-engine]: ../../docs/codex/egdesk-product-interaction-trace-atlas-editorial-ledger.md#hum-engine-001
[h-code]: ../../docs/codex/egdesk-product-interaction-trace-atlas-editorial-ledger.md#hum-code-001
[h-snapshot]: ../../docs/codex/egdesk-product-interaction-trace-atlas-editorial-ledger.md#hum-snapshot-001
[h-answer]: ../../docs/codex/egdesk-product-interaction-trace-atlas-editorial-ledger.md#hum-answer-001
[h-conv]: ../../docs/codex/egdesk-product-interaction-trace-atlas-editorial-ledger.md#hum-conv-001
[h-run]: ../../docs/codex/egdesk-product-interaction-trace-atlas-editorial-ledger.md#hum-run-001
[h-gov]: ../../docs/codex/egdesk-product-interaction-trace-atlas-editorial-ledger.md#hum-gov-001
[h-read]: ../../docs/codex/egdesk-product-interaction-trace-atlas-editorial-ledger.md#hum-read-001
[h-orch]: ../../docs/codex/egdesk-product-interaction-trace-atlas-editorial-ledger.md#hum-orch-001
[h-brief]: ../../docs/codex/egdesk-product-interaction-trace-atlas-editorial-ledger.md#hum-brief-001
[h-export]: ../../docs/codex/egdesk-product-interaction-trace-atlas-editorial-ledger.md#hum-export-001
[h-collab]: ../../docs/codex/egdesk-product-interaction-trace-atlas-editorial-ledger.md#hum-collab-001
[h-remote]: ../../docs/codex/egdesk-product-interaction-trace-atlas-editorial-ledger.md#hum-remote-001
[h-a11y]: ../../docs/codex/egdesk-product-interaction-trace-atlas-editorial-ledger.md#hum-a11y-001
[gov-top]: ../../docs/codex/egdesk-product-documentation-governance.md#doc-governance-top
[gov-three]: ../../docs/codex/egdesk-product-documentation-governance.md#doc-sim-three-perspectives
[gov-approval]: ../../docs/codex/egdesk-product-documentation-governance.md#doc-approval-registry
[docs-start]: ../../docs/README.md#docs-start
[project-context]: ../../docs/codex/project-context.md#product-source-precedence
[whitepaper]: <../../docs/production/EG-DESK 백서 - Production_v8_한글.md#wp-evidence>
[app-readme]: ../../apps/firefox-ui-demo/README.md#데모에서-실제로-보는-것
[browser-runtime]: ../../apps/firefox-ui-demo/docs/BROWSER_AGENT_OBSERVATION_RUNTIME.md#runtime-contract
[await-model]: ../../apps/firefox-ui-demo/docs/HUMAN_IN_LOOP_WORKFLOW_AWAIT_MODEL.md#await-conditions
[layer-model]: ../../apps/firefox-ui-demo/docs/CHAT_CANVAS_AGENT_LAYER_MODEL.md#canvas-outcome
[board-runtime]: ../../apps/firefox-ui-demo/docs/DESK_AGENDA_CARD_RUNTIME_MODEL.md#saved-agenda-automatic-desk-session-and-live-runtime
[runtime-source]: ../../apps/firefox-ui-demo/docs/DESK_AGENDA_CARD_RUNTIME_MODEL.md#sourceref-primitive
[schema-context]: ../../ontology/schema.md#context-loading-rule
[schema-fields]: ../../ontology/schema.md#stable-fields
[schema-relations]: ../../ontology/schema.md#relation-vocabulary
[ontology-index]: ../../ontology/index.md#primary-load-order
[generated-graph]: ../../apps/firefox-ui-demo/overlay/resources/ontology/graph.json
[main-profile]: ../../AGENTS.md#operating-boundary
[pm-profile]: ../../.codex/agents/egdesk-pm.toml
[cap-section]: ../../docs/references/design-synthesis/egdesk-capability-scenario-connected-agent-work.md#5-기술-capability-13개
[ecs-section]: ../../docs/references/design-synthesis/egdesk-capability-scenario-connected-agent-work.md#4-연결된-업무-이야기-7개
[cap-01]: ../../docs/references/design-synthesis/egdesk-capability-scenario-connected-agent-work.md#cap-01--agent-설정engine권한을-run과-turn에-결합
[cap-02]: ../../docs/references/design-synthesis/egdesk-capability-scenario-connected-agent-work.md#cap-02--최소-context와-reader-session
[cap-03]: ../../docs/references/design-synthesis/egdesk-capability-scenario-connected-agent-work.md#cap-03--multi-agent-dependencyintegration-감독
[cap-04]: ../../docs/references/design-synthesis/egdesk-capability-scenario-connected-agent-work.md#cap-04--사용자-교정과-clean-room-context-escape
[cap-05]: ../../docs/references/design-synthesis/egdesk-capability-scenario-connected-agent-work.md#cap-05--live-surface-identityfocuscontrol-lease
[cap-06]: ../../docs/references/design-synthesis/egdesk-capability-scenario-connected-agent-work.md#cap-06--connectionruntime-경계-복구
[cap-07]: ../../docs/references/design-synthesis/egdesk-capability-scenario-connected-agent-work.md#cap-07--external-effect-approvalreceiptcurrent-state
[cap-08]: ../../docs/references/design-synthesis/egdesk-capability-scenario-connected-agent-work.md#cap-08--answersnapshotliveprovenance
[cap-09]: ../../docs/references/design-synthesis/egdesk-capability-scenario-connected-agent-work.md#cap-09--deskagendarun-checkpoint-재개
[cap-10]: ../../docs/references/design-synthesis/egdesk-capability-scenario-connected-agent-work.md#cap-10--cross-devicecollaborator-handoff
[cap-11]: ../../docs/references/design-synthesis/egdesk-capability-scenario-connected-agent-work.md#cap-11--repeating-workmissed-runcatch-up
[cap-12]: ../../docs/references/design-synthesis/egdesk-capability-scenario-connected-agent-work.md#cap-12--knowledgeontology-bindingpromotionevaluation
[cap-13]: ../../docs/references/design-synthesis/egdesk-capability-scenario-connected-agent-work.md#cap-13--candidate에서-canonicalremotedeployment까지
[ecs-01]: ../../docs/references/design-synthesis/egdesk-capability-scenario-connected-agent-work.md#ecs-01--새-기기나-새-세션에서-전날-업무를-재개한다
[ecs-02]: ../../docs/references/design-synthesis/egdesk-capability-scenario-connected-agent-work.md#ecs-02--자료-묶음을-담당-agent에게-검토-요청한다
[ecs-03]: ../../docs/references/design-synthesis/egdesk-capability-scenario-connected-agent-work.md#ecs-03--agent가-live-surface를-조작하고-사용자가-지켜본다
[ecs-04]: ../../docs/references/design-synthesis/egdesk-capability-scenario-connected-agent-work.md#ecs-04--작업-중-새-권한이나-외부-효과가-필요해진다
[ecs-05]: ../../docs/references/design-synthesis/egdesk-capability-scenario-connected-agent-work.md#ecs-05--연결-또는-agent-실행이-끊긴-뒤-다시-들어온다
[ecs-06]: ../../docs/references/design-synthesis/egdesk-capability-scenario-connected-agent-work.md#ecs-06--여러-agent가-나눠-일하고-사용자가-결과를-검토한다
[ecs-07]: ../../docs/references/design-synthesis/egdesk-capability-scenario-connected-agent-work.md#ecs-07--태화트랜스-사례로-조직-ontology를-운영한다
[old-1]: #1-개요-overview
[old-2]: #2-세부-제안-및-아키텍처-분석
[old-3]: #3-jev-오픈소스-대안-생태계-및-로컬-구현-모델-분석-open-source-reproductions--alternatives
[old-4]: #4-인지-아키텍처-관점의-대전환-decision-makingjev-vs-creative-generationllm
[old-5]: #5-해마hippocampus와-파일메모리-시스템의-jev-전면-전환-구상
[old-6]: #6-시간축-온톨로지스마트-폴더-체계에서-챗-에이전트의-jev-판단-보완-설계
[old-7]: #7-결론-eg-desk-cognitive-os의-완성
[old-8]: #8-단계별-실증-및-도입-로드맵-roadmap
