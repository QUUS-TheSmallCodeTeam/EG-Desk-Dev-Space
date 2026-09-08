# 002. External Reference License Policy

**Status**: Decided (v2 — 2-tier)
**Date**: 2026-04-13 (v2 업데이트, shelf-review-agent 2라운드 반영; Decided 2026-04-13 — 유저 승인)
**Deciders**: egdesk-pm-agent, Session Lead, User
**Related SPEC**: `ideas/confirmed/technology-stack.md` §9 (External Reference License Policy)

> **v2 변경점** (2026-04-13): 기존 3-tier(Green/Yellow/Red)를 **2-tier(Green/Red)로 단순화**. MPL-2.0 / EPL-2.0 / LGPL 등 파일 단위 copyleft는 상업 프로덕트에서 viral risk가 여전하고, 파일 단위 포팅 시 유지보수 오버헤드가 개념 재구현 비용을 초과한다는 판단. Yellow tier는 Red로 merge.

## Context

EG-Desk는 `references/` 아래에 **외부 repo를 git clone하여 참고**한다 (EG-Library / Shelf 시스템, `~/.claude/CLAUDE.md`).

현재 clone된 레퍼런스:
- `references/xyflow/` — MIT
- `references/anytype/` — **Any Source Available License 1.0 (ASAL)**
- `references/zen-browser/` — MPL 2.0 (추정, clone 실패로 미확인)
- `references/surf/` — 미확인 (다음 세션)
- 기타: `claude-agent-sdk`, `electron`, `gemini-cli`, `infinite-canvas`, `light-system`, `playwright`, `puppeteer`, `theia`

**문제**: coding-agent가 레퍼런스를 참고하여 코드를 작성할 때, **라이선스 분류 없이 코드 복사**하면 다음 위험 발생:

1. **ASAL/AGPL/SSPL 코드 포팅** → EG-Desk 전체 프로젝트가 동일 라이선스로 viral 전염
2. **Non-Commercial-only 코드 포팅** → 당시 [영문 백서의 사업 모델 전제](#whitepaper-git-sources)와 충돌
3. **MPL 2.0 파일 copyleft** → 수정 파일 공개 의무 트리거

EG-Desk는 **상업화 전제 프로덕트**임이 문서로 확정됨:
- 당시 [영문 백서](#whitepaper-git-sources) §10.1 "Monetization Strategies" (L766-775)
- 당시 [Vision v1 백서](#whitepaper-git-sources) L663 "수익", L669 "마켓플레이스 수수료 10%"
- 당시 Production v7의 "미니앱 수익화" (L1467). 구버전 파일은 2026-09-06 정리했으며, 당시 원문은 Git blob `dad1e58ac45ca5e8420145022a8e9bbe75e9d7cf`에 보존된다. 현재 백서는 [Production v8](../../../docs/production/EG-DESK%20백서%20-%20Production_v8_한글.md)을 참조한다.

→ 라이선스 분류를 **명시적 정책으로 확립**하고, agent template에 rule로 반영 필요.

## Options Considered

### Option A — 모든 레퍼런스를 **inspiration-only**로 처리 (코드 복사 전면 금지)

- **Pros**: 라이선스 위험 zero. 단순 명료
- **Cons**: MIT/BSD/Apache 레퍼런스 (xyflow 등)의 코드 참고 편의성 상실. 과도하게 보수적
- **Verdict**: ❌ Rejected — MIT 라이선스는 표기 조건만으로 포팅 가능하므로 굳이 제약할 이유 없음

### Option B — 라이선스 3단계 분류 (Green / Yellow / Red)

3단계 분류. **파일 단위 포팅**을 허용하는 Yellow tier(MPL/EPL/LGPL) 별도 운영.

- **Pros**:
  - 라이선스 특성에 맞는 차별적 정책
  - MPL/EPL 파일 하나만 필요할 때 유연성 확보
- **Cons**:
  - **Yellow tier 운영 오버헤드**: 파일 단위 포팅 → 수정 파일 공개 의무 → 추적용 NOTICE 관리, PR 때마다 공개 파일 리스트 갱신
  - **Viral risk 잔존**: MPL/EPL 파일을 **수정 없이 그대로** 쓰더라도, 후속 agent가 "동일 파일인 줄 모르고 EG-Desk 고유 로직을 섞어 넣으면" 파일 전체가 공개 대상. Agent 실수 방지 비용 > 유지보수 이득
  - **상업 프로덕트 리스크**: 투자/M&A 실사 시 "MPL 파일 하나라도 있으면 전체 라이선스 재조사" 비용
  - **대안 존재**: MPL/EPL 코드가 필요한 경우 대부분 MIT/Apache 대체재 존재 (React ecosystem 특성상)
- **Verdict**: ❌ Rejected (v2 전환) — 상업 프로덕트에서 "파일 단위 copyleft"조차 비용이 이득을 초과

### Option C — 레거시 라이선스별 세부 규칙 (7+ 카테고리)

- **Pros**: 최대 정확도
- **Cons**: agent가 기억/준수하기 어려움. 운영 비용 과다
- **Verdict**: ❌ Rejected — 실용성 낮음

### Option D — **2단계 분류 (Green / Red)** — permissive OK / copyleft 전면 금지

2단계로 단순화. copyleft 계열(AGPL/GPL/SSPL/ASAL 기존 Red 범위에 **MPL/EPL/LGPL 추가 편입**).

- **Pros**:
  - **단순 명료**: agent 분류 실수 가능성 최소화. "permissive 아니면 개념 참고만" 단일 규칙
  - **상업 리스크 zero**: 모든 copyleft가 Red → 실사/M&A 시 공개 의무 파일 0개 보장
  - **유지보수 부담 zero**: NOTICE.md가 훨씬 단순해짐 (copyright 표기만)
  - **대부분 React ecosystem은 MIT/Apache로 대체 가능** → 실무 불편 낮음
- **Cons**:
  - Theia(EPL 2.0 + GPL 2 w/ Classpath) 등 유용한 MPL/EPL 코드를 **개념 참고만** 해야 함 → 추가 구현 비용 일부 발생. 다만 EG-Desk는 Theia를 npm dep(binary)로 쓸 뿐 코드 포팅 대상 아님
  - Yellow tier에서 기대했던 "작은 파일 하나만 복사" 유연성 상실. 다만 해당 use case 실제 빈도는 낮음
- **Verdict**: ✅ **Accepted (v2)** — Green/Red 2-tier가 상업 프로덕트 운영에 최적

## Decision

**Option D 채택: 라이선스 2단계 분류 (Green / Red). MPL-2.0 / EPL-2.0 / LGPL 등 파일 단위 copyleft도 Red에 편입하여 코드 포팅 금지.**

### 분류 기준

| 카테고리 | 라이선스 | EG-Desk 사용 허용 범위 |
|----------|---------|---------------------|
| **Green** 🟢 (permissive) | MIT, BSD-2-Clause, BSD-3-Clause, Apache-2.0, ISC, 0BSD, Unlicense | **코드 포팅 허용**. 라이선스 표기 의무 (각 파일 상단 주석 또는 `NOTICE.md` 집중 기록). npm 의존성 자유 추가. |
| **Red** 🔴 (copyleft + non-commercial + proprietary) | **MPL-2.0, EPL-2.0, LGPL**(v2 신규 편입), CDDL, ASAL 1.0, AGPL-3.0, SSPL, GPL-2/3, Non-Commercial (CC-BY-NC 등), Source-Available (Elastic 등), Proprietary | **코드 포팅 금지** (단 한 줄도). 개념/아키텍처 참고만 허용. npm dep 추가 시 개별 ADR로 유저 승인 필요. |

### 현재 레퍼런스 분류 (v2 — 2-tier 재분류)

| 레퍼런스 | 라이선스 | 카테고리 (v1) | 카테고리 (v2) |
|---------|---------|---------------|---------------|
| xyflow | MIT | 🟢 Green | 🟢 Green |
| anytype | ASAL 1.0 | 🔴 Red | 🔴 Red |
| zen-browser | MPL 2.0 (추정) | 🟡 Yellow | 🔴 **Red (승격)** |
| surf | Apache 2.0 (verified 2026-04-13) | ⏳ TBD | 🟢 Green |
| electron | MIT | 🟢 Green | 🟢 Green |
| playwright | Apache 2.0 | 🟢 Green | 🟢 Green |
| puppeteer | Apache 2.0 | 🟢 Green | 🟢 Green |
| theia | EPL 2.0 + GPL 2 w/ Classpath | 🟡 Yellow | 🔴 **Red (승격)** — 코드 포팅 금지. npm binary 의존은 기존 사용 유지(이미 기술 스택 등록). |
| claude-agent-sdk / gemini-cli / infinite-canvas / light-system | 미확인 | ⏳ TBD | ⏳ TBD |

> ⏳ TBD는 다음 세션에서 `references/[name]/LICENSE*` 확인 후 갱신. 확인 시 본 ADR이 Decided이면 즉시 반영, Proposed면 user 승인 패키지에 포함.

### 운영 규칙

1. **LICENSE_CATEGORY.md 생성**: setup.sh가 repo clone 후 `references/[name]/LICENSE_CATEGORY.md`를 자동 또는 수동 생성. **2-tier 표기만** (🟢 Green / 🔴 Red) + 원본 라이선스 파일 경로 링크.
2. **Agent template rule** (coding-agent, design-agent 등 Write 권한):
   > "코드 작성 중 `references/[name]/` 코드 복사/포팅 시 `references/[name]/LICENSE_CATEGORY.md`를 선행 확인. 🔴 Red 카테고리는 **개념 참고만, 단 한 줄도 복사 금지**. 🟢 Green은 표기 조건 준수 (파일 상단 주석 또는 NOTICE.md)."
3. **PM 책임**: 신규 reference 추가 시 egdesk-pm-agent가 라이선스 확인 → Green/Red 분류. 모호한 dual-license / custom license는 ADR 개별 평가.
4. **SPEC addendum**: `ideas/confirmed/technology-stack.md` §9에 본 ADR 요약 반영 (v2 2-tier 스키마 동기화).
5. **npm 의존성 정책**: Red tier 라이브러리를 `package.json`에 추가하려면 **개별 ADR로 유저 승인**. Binary로 링크만 하는 MPL/EPL 라이브러리도 동일 (예: Theia는 기존 사용 유지하되 신규 Red 의존성 추가는 ADR 필요).

## Consequences

**즉시 (v2 전환 기준)**:
- `ideas/confirmed/technology-stack.md` §9에 2-tier 분류 반영 (Task #15)
- `references/anytype/`, `references/zen-browser/`, `references/theia/`에 🔴 Red 분류 표기 (zen-browser/theia는 v1 Yellow → v2 Red 승격)
- 기존 coding-agent / design-agent template에 라이선스 확인 rule 추가 (2-tier 문구)

**후속 작업**:
- ⏳ TBD 레퍼런스 4개 라이선스 확인 (claude-agent-sdk, gemini-cli, infinite-canvas, light-system) — 다음 세션
- setup.sh에 LICENSE_CATEGORY.md 자동 생성 로직 추가 (선택적, 수동도 가능)
- Theia를 활용하는 코드가 **패키지 binary 수준 인터페이스 사용인지** vs **소스 포팅인지** 구분: 전자는 기존 사용 유지, 후자는 즉시 중단

**Trade-offs**:
- (+) 상업 프로덕트 법적 안전성 **강화** (copyleft 파일 단위 침투 리스크 zero)
- (+) agent 분류 실수 가능성 최소화 (tier 수 3→2)
- (+) NOTICE 관리 단순화
- (-) MPL/EPL 라이브러리 코드 포팅 금지로 인한 구현 비용 일부 발생 (다만 React ecosystem 특성상 대체재 풍부)
- (-) v1 초안 Yellow 항목(zen-browser, theia) 재분류 필요 → 본 문서 + technology-stack.md 동시 갱신

**연관 결정**:
- ADR-001 Canvas Library Reference — xyflow(🟢) 코드 참고 허용, anytype(🔴) 개념만 참고 근거
- ADR-003 Electron Sidebar Drag-Resize UX — anytype 개념 차용의 정당성 근거
- **후속 ADR 예정**: shelf-review-agent 2라운드 결과 중 Overlay 별도 BrowserWindow / Edge position customization은 별도 ADR 대상이면 ADR-004+로 분리

## References

<a id="whitepaper-git-sources"></a>

2026-09-06 백서 정리 후 현행 문서는 [Production v8](../../../docs/production/EG-DESK%20백서%20-%20Production_v8_한글.md)이다.
아래 삭제 전 원문은 Git 이력에 남으며, 예를 들어 `git show <blob ID>`로 확인할 수 있다.
과거 판단의 인용을 현행 백서에 대한 인용으로 소급 변경하지 않는다.

- `references/anytype/LICENSE.md:L1-9` (ASAL 1.0 원문)
- `references/xyflow/LICENSE` (MIT)
- 구 영문 백서 §10 "Business Model Considerations" — Git blob `e1ab95b9e62609d4b12d41b079a4bb32e6a4858c`
- 구 Vision v1 백서 L663 "수익" — Git blob `8248b68b8ef9469285e562d6f82fef79b8cd4c0a`
- 구 Production v7 백서 L1467 "미니앱 수익화" — Git blob `dad1e58ac45ca5e8420145022a8e9bbe75e9d7cf`
- `~/.claude/CLAUDE.md` "EG-Library (Reference Management)" 섹션
- shelf-review-agent 1라운드 anytype 리뷰 (2026-04-13 세션)
- [SPDX License List](https://spdx.org/licenses/) — 외부 참조용
