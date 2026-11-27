# L7 c40: 기억 층 어휘 대응표 (loop 값/축 대 정본의 JEV 4-Type·온톨로지 시간축 어휘)

문서 전용. 코드, 정본, 설정을 바꾸지 않았고 아무것도 보내지 않았습니다. 출발점은 WM 보고 `wm-20261125.md` §3 항목 9 ("loop 기록 상태 5값과 JEV §5·§6 어휘가 다르다, 통합 매핑표가 필요하다"). 제안(§6)은 소유자 결정 전의 후보이며, 새 이름과 문구는 승인 전까지 정본에도 제품 문구에도 넣지 않습니다.

## 0. 결론 (먼저)
1. 정본에는 기억을 말하는 어휘가 **서로 다른 차원의 세 벌**로 있고 (§2), loop의 어휘는 그 세 벌의 일부를 **한 필드에 섞어** 쓰고 있어서 1:1 대응표가 나오지 않습니다. 정본이 앞선 설계이거나 병행 어휘인지는, 차원별로 나누면 정리됩니다: 시간 위치는 정본(`past/present/future/multiverse`)이 이미 정의했고, loop의 `planned`/`hypothetical`은 그것의 부분 집합과 별칭입니다. 4-Type(`asset/knowledge/log/hypothetical`)은 파일/기억의 **성격**이라 loop에 대응하는 필드가 아직 없습니다.
2. 가장 큰 불일치는 **상태 5값(`done/plan/superseded/reported_by_other/unknown`)이 네 가지를 섞은 것**입니다: 생명주기(`plan`, `done`), 관계에서 나오는 상태(`superseded`), 출처(`reported_by_other`), 모름(`unknown`). 정본은 이 넷을 각각 다른 곳에 둡니다 (§4 N1).
3. 같은 낱말이 다른 층을 가리키는 **동음이의 1건**: `hypothetical`. loop에서는 시간 슬라이스 값(정본의 `multiverse`에 해당), 정본 JEV에서는 4-Type 값(미확정 구상). 둘은 다른 개념입니다 (N3).
4. **의미가 갈리는 곳 1건**: "배포 끝났어"를 정본(JEV §6.2 ④)은 `future → present` 승격(결과 상태가 현재가 됨)으로, loop(`SLICE_OF_STATUS`)는 `done` = `past`(끝난 사건)로 읽습니다 (N2). 이것은 단순한 이름 차이가 아니라 소유자가 정할 일입니다.
5. 코드가 정본 값을 loop 값으로 바꾸는 자리에서 **구멍 2건**: 정본 `multiverse`와 snapshot status `historical`이 둘 다 `unknown`으로 떨어집니다 (§5). 이번에 고치지 않았습니다.
6. 권고 표기(§6): 기록 하나를 **독립된 속성 넷**으로 기술 (시간 위치, 상태, 근거, 확인 상태) + 4-Type은 별도 선택 속성. 값은 가능한 한 정본의 기존 낱말(`past/present/future/multiverse`, `planned/observed/historical`)을 쓰고, loop 전용 값 3개(`superseded`, `reported_by_other`, `unknown`)를 상태 값에서 빼서 각자 맞는 자리로 옮깁니다.

## 1. 기준과 근거 (대응을 이 순서로 만들었습니다)
기준 (먼저 못 박음):
1. **같은 차원끼리만** 대응시킨다 (시간 위치끼리, 상태끼리, 근거끼리). 낱말이 같다고 대응시키지 않는다.
2. 대응 종류를 넷으로 표시한다: **동일**(정의까지 같음), **부분**(한쪽이 더 넓거나 좁음), **병행**(같은 개념을 다른 층에서), **없음**(상대에 해당 개념 자체가 없음).
3. 정본 인용은 파일과 절로, loop 인용은 파일과 줄로 단다. 인용 못 하면 대응을 만들지 않는다.

정본 근거 (경로는 `/Users/minsoocha/Projects/EG-Desk-Dev-Space/` 기준):
- C1 `ideas/brainstorming/JEV_INTEGRATION_SUGGESTIONS.md` §5.1 (4-Type 자동 태깅: `asset/knowledge/log/hypothetical`, 383~394줄), §6.2 (시제 슬라이싱 4단계: `TimeIntent` 선택지, 메타 헤더 `[ONTOLOGY: time=…, status=hypothetical|archived_log|live_asset]`, ④ 대화 기반 상태 전이 `future → present`, 473~510줄).
- C2 `ideas/brainstorming/COGNITIVE_ARCHITECTURE_ANALOGY.md` §8 "4-type 인지 태깅 시스템"(309~376줄: 네 값의 정의, `knowledge`=WHAT I know / `log`=WHEN·HOW I did), "생명주기와 승격/강등"(378~401줄: `hypothetical → asset` 승격, `log → knowledge` 공고화, `asset → hypothetical` 강등), §8.C "출처 모니터링 이론"(536~546줄: 직접 봤나, 들었나, 상상했나).
- C3 `ontology/concepts/axes/axis-time.md` (시간축: 과거/현재/미래/multiverse), `ontology/concepts/time-past.md`, `time-present.md`, `time-future.md`, `time-multiverse.md` (대표 개념 네 개의 정의), `ontology/concepts/facets/facet-time.md`.
- C4 `ontology/schema.md` 156~157줄 (snapshot 규칙: `time_slice`는 `past/present/future`, `status`는 `historical/observed/planned`), 224~255줄 (관계 표: `derived_from`, `updates`, `informs`, `implements`, `branches_into/from`, `same_identity_as` 등; `supersedes`는 없음).
- C5 `ontology/concepts/source-ref.md` (SourceRef = 자원 좌표 `kind/uri/path/id/scope/accountId/profileId/openMode`; 발화의 근거와는 다른 개념).
- C6 `ontology/concepts/axes/axis-virtual.md` ("Intent는 별도 주축이 아니다: Virtual 목표 + Time 약속 + Space 산출물"과 같은 합성 규칙 문형).

loop 근거 (`apps/firefox-ui-demo/helper/` 기준):
- L1 `egdesk-wiki-reconstruction.mjs`: `TIME_SLICES` 17줄, `LINK_TYPES` 18~24줄, `PROVENANCE_KINDS` 25줄, `PROVENANCE_BASES` 27줄, `RECORD_STATUSES` 28~34줄.
- L2 `egdesk-turn-memory.mjs`: `SLICE_OF_STATUS`/`readingSlice` 147~148줄, `SLICE_OF`(발화 시간 라벨 → 슬라이스) 149줄, `recordFromLabels` 154~163줄, `READING_STATUS` 378줄 (읽기 상태 `plan/done/superseded`), `KINDS` 382줄, `MATERIAL_LINK_TYPES` 594줄 (`superseded_by` 파생 포함).
- L3 `egdesk-speech-grounding.mjs` 113~150줄: 발화 라벨 세 축 (`source`, `form`, `time`)의 값과 정의.
- L4 `egdesk-context-setup.mjs`: `TIME_INTENTS` 46~52줄, `TRANSITION_KINDS` 54~59줄, `ONTOLOGY_SLICES`(정본 그래프 → loop 슬라이스) 641줄, `linkTypeForRelation`(정본 관계 이름 → loop 링크) 647줄 이하, 시간 태그 정의문 127, 201, 467줄.
- L5 `egdesk-wiki-adapter.mjs` 24줄 `statusOfCandidate` (정본 status 문자열 → loop 상태).
- L6 읽기 상태(`pending`/`accepted`/`rejected`)와 승격 규칙은 `egdesk-turn-memory.mjs` `createWikiWriter` (`promote`는 사람 본인의 나중 확인으로만).
- 방향 근거: `PHILOSOPHY.md` U6 ("발언의 시제와 출처는 온톨로지 축이다").

## 2. 양쪽의 어휘 (차원별로 나눠 놓은 모습)
정본은 기억/시간을 말할 때 **세 벌의 어휘**를 씁니다. 같은 파일 §6.2 ③에서도 한 산출물에 `TimeSlice`, `CognitiveType`, `Layer`를 **따로** 줍니다 (`Choice(TimeSlice): future`, `Choice(CognitiveType): hypothetical`, `Choice(Layer): virtual`; C1 §6.2 ③), 즉 정본 자신이 이 셋을 독립 축으로 다룹니다.

| 정본 어휘 | 값 | 무엇을 말하나 (차원) | 근거 |
|---|---|---|---|
| 시간 위치 (axis.time) | `past`, `present`, `future`, `multiverse` | 그것이 언제의 것인가: 증거, 지금 실행 가능한 상태, 의도, 가능한 세계 | C3 |
| 스냅샷 상태 | `historical`, `observed`, `planned` | 스냅샷이 과거 기록인가, 관측된 현재인가, 계획인가 (시간 위치와 짝) | C4 156~157 |
| 4-Type | `asset`, `knowledge`, `log`, `hypothetical` | 기억/파일의 성격: 확정된 현실, 재사용 지식(WHAT), 일화 기록(WHEN/HOW), 비현실 구상 | C1 §5.1, C2 §8 |
| 수명주기 | 승격(`hypothetical→asset`), 공고화(`log→knowledge`), 강등(`asset→hypothetical`), 폐기 | 4-Type 사이의 이동 | C2 "생명주기와 승격/강등" |
| 질의 시제 | `PAST_EPISODIC`, `PRESENT_LIVE`, `FUTURE_PLANNED`, `CROSS_TEMPORAL_DIFF` | 사람이 어느 시간에 대해 묻는가 | C1 §6.2 ① |
| 출처 | "직접 봤나 / 들었나 / 상상했나"; frontmatter `consolidated_from`, `session`, `decision_context` | 기억의 출처 (파일 수준) | C2 §8.C |
| 관계 | `derived_from`, `updates`, `informs`, `implements`, `branches_into/from`, `provides_evidence_for` … | 노드 사이 | C4 224~255 |

loop의 어휘:

| loop 어휘 | 값 | 정의 (코드의 원문 요지) | 근거 |
|---|---|---|---|
| 기록 상태 `status` (5) | `plan`, `done`, `superseded`, `reported_by_other`, `unknown` | 의도/예정, 수행됐거나 확정된 상태, 나중 기록이 대체함, 남의 말을 전할 뿐, 알 수 없음 | L1 28~34 |
| 시간 슬라이스 `slice` (5) | `past`, `present`, `planned`, `hypothetical`, `unknown` | 과거, "지금 구간에 적용"(직접 관측일 필요 없음), 정해졌지만 안 됨, 가정(what-if), 태그 없음 | L1 17, L4 127 |
| 발화 라벨 `source` (6) | `self_reported_observation`, `attributed_report`, `inference`, `record_based`, `unspecified`, `unknown` | 화자가 어떤 근거를 대는가 | L3 |
| 발화 라벨 `form` (5) | `assertion`, `plan`, `conditional`, `question`, `unknown` | 화자가 어떻게 말하는가 | L3 |
| 발화 라벨 `time` (7) | `past_anchored`, `past_unspecified`, `at_utterance`, `ongoing_no_end`, `future_anchored`, `future_unspecified`, `unknown` | 발화 시점에 대한 사건 위치와 앵커 유무 | L3, L2 149 |
| 기록 출처 종류 `provenance.kind` (5) | `own_record`, `document`, `agent_note`, `utterance`, `reported_by_other` | 누가 만든 기록인가 | L1 25 |
| 근거 `provenance.basis` (5) | 위 `source` 값 중 `unknown` 제외 | 발화형 페이지의 근거 | L1 27 |
| 링크 (5 + 파생 1) | `same_task`, `follows_from`, `decided_in`, `supersedes`, `refers_to`; 파생 `superseded_by` | 기록 사이 | L1 18~24, L2 594 |
| 읽기 상태 (3) | `pending`, `accepted`, `rejected` | 말에서 읽은 상태 변경이 사람에게 확인됐는가 | L6 |
| 질의 시간 의도 (6) | `present`, `past`, `planned`, `what_if`, `cross_time`, `not_time_specific` | 질문이 묻는 시간 | L4 46~52 |
| 상태 전이 종류 (4) | `completed`, `cancelled`, `changed`, `none` | 말이 계획의 변화를 알리는가 | L4 54~59 |
| 불일치 표시 (c38, c39) | `conflict`(말 대 기록), `contradiction`(기록 대 기록) | 저장하지 않는 코드 표시와 엔진용 문장만 | `egdesk-record-settled.mjs` |

## 3. 대응표 (loop → 정본)
대응 종류: 동일 / 부분 / 병행 / 없음 (기준 2).

### 3.1 시간 위치
| loop `slice` | 정본 | 종류 | 설명 |
|---|---|---|---|
| `past` | `time.past`, `time_slice: past`, 상태 `historical` | 동일 | 과거 증거/기록. 정본이 "증거를 지닌 대표"로 더 풍부하게 정의 (C3 `time-past.md`) |
| `present` | `time.present`, `time_slice: present`, 상태 `observed` | **부분** | 정본의 present는 "지금 **실행 가능한** 현재 상태"(`time-present.md`)이고, loop는 "현재 구간에 적용, 직접 관측일 필요 없음"(L4 127). loop 쪽이 더 넓음 (N8) |
| `planned` | `time.future`, `time_slice: future`, 상태 `planned` | **부분(loop가 좁음)** | 정본 future는 vision, goal, plan, task 전부(`time-future.md`). loop `planned`는 "정해졌지만 안 됨". 결정 안 된 구상은 loop에서 `hypothetical`로 감 (N4) |
| `hypothetical` | `time.multiverse` (+ 4-Type `hypothetical`과는 **다른 개념**) | **부분 + 동음이의** | what-if, 시뮬레이션, 대안 가지. 정본 멀티버스에 대응하되 이름이 4-Type 값과 겹침 (N3) |
| `unknown` | (정본에 없음) | **없음** | 정본의 시간 값은 항상 정해져 있음. loop는 모델이 못 읽은 경우가 있어서 필요 (N7) |

### 3.2 상태 (`RECORD_STATUSES`)
| loop `status` | 정본 | 종류 | 설명 |
|---|---|---|---|
| `plan` | snapshot 상태 `planned`; 시간 위치 `future`(의도); 4-Type은 해당 없음 | 동일(상태), **병행**(4-Type) | 4-Type과는 직교: 확정된 PRD는 `asset`이면서 future, 브레인스토밍은 `hypothetical`이면서 future (C2 §8 위치 표) |
| `done` | 상태 `observed`(지금 그 상태) 또는 `historical`(끝난 사건); 시간 위치 `present` 또는 `past` | **부분 (둘로 갈림)** | loop `done`은 "수행됐거나 확정된 현재 상태"(L1 29). 정본은 사건(과거)과 결과 상태(현재)를 나눔 (N2) |
| `superseded` | 정본에 값 없음; 관계 `updates`가 비슷하나 의미가 다름; JEV §6.2 ④의 "기존 `present/…` → `past/archive/`로 동결" | **없음(전이로만 존재)** | 대체됨은 값이 아니라 두 기록 사이의 사건/관계 (N6) |
| `reported_by_other` | 4-Type에도 상태에도 없음; 출처 모니터링 "들었나" (C2 §8.C) | **병행(출처 차원)** | 상태가 아니라 근거. loop도 `provenance.kind`에 같은 값이 있어 **loop 안에서 중복** (N5) |
| `unknown` | 없음 | **없음** | N7 |

### 3.3 4-Type과 loop
4-Type은 파일/기억의 성격이고(C1 §5.1, C2 §8), loop의 기록(위키 페이지)은 이에 해당하는 필드가 **아직 없습니다**. 대응 후보:

| 4-Type | loop에서 가까운 것 | 종류 | 설명 |
|---|---|---|---|
| `asset` (확정된 현실) | `done` 상태로 승격 확정된 읽기(`accepted`), `own_record`, `document` | 부분 | 정본: "확정된 현실 → 신뢰하고 사용". loop의 `accepted`가 사람 확인을 거친 상태라 가장 가깝지만, loop는 이를 4-Type으로 쓰지 않음 |
| `knowledge` (WHAT I know) | (없음) | 없음 | loop 기억은 사건/상태 기록 중심이라 맥락 독립 지식 페이지 구분이 없음 |
| `log` (WHEN/HOW I did) | `agent_note`(브라우저 과제의 기록), 발화 페이지(`utterance`) | 부분 | 일화 기록, 맥락 종속. 발화 페이지는 그 시점에 말한 것의 기록 |
| `hypothetical` (비현실 구상) | 시간 슬라이스 `hypothetical`, 발화 `form: conditional` | **부분** | 4-Type은 "현실이 아님"을 표시하는 성격. loop는 이것을 시간 슬라이스와 발화 형식으로 따로 가짐 |
| 승격 `hypothetical → asset` | 읽기 `pending → accepted` (사람의 나중 확인으로만, `promote`) | 병행 | "자동 승격 없음, 명시적 승격만"이라는 규칙이 같음 (C2 "재사용: 승격 시에만"). 단 pending은 "상상"이 아니라 "아직 확인 안 된 보고"라 의미가 약간 다름 (N12) |

### 3.4 발화 라벨과 출처
| loop | 정본 | 종류 | 설명 |
|---|---|---|---|
| `source: self_reported_observation` | 출처 모니터링 "직접 봤나" (C2 §8.C) | **부분** | loop는 "직접 봤다고 **말하는** 것, 검증된 사실 아님"을 강조(L3). 정본은 기억의 실제 출처 |
| `source: attributed_report` | "들었나" | 동일에 가까움 | 남이 한 말 전달 |
| `source: record_based` | 파일 `consolidated_from`, `time.past provides_evidence_for` | 병행 | 기록/문서를 근거로 댐. 정본의 출처 추적은 파일 frontmatter |
| `source: inference` | (이름 없음; "상상했나"가 가장 가까우나 다름) | 없음/부분 | 추론은 상상(비현실 구성)과 다름. 정본에는 "추론" 칸이 없음 (N10) |
| `source: unspecified`, `unknown` | 없음 | 없음 | 정본은 출처를 항상 안다고 전제 |
| `form: assertion` | (없음) | 없음 | 정본에는 화행 어휘 없음 |
| `form: plan` | `time.future`의 plan/task | 부분 | 의도/약속 |
| `form: conditional` | `time.multiverse`, 4-Type `hypothetical` | 부분 | |
| `form: question` | (없음) | 없음 | 기록 대상이 아님(`recordable`) |
| `time: past_*` | `time.past` | 부분 | loop는 앵커 유무(`anchored`/`unspecified`)를 더 세분 |
| `time: at_utterance`, `ongoing_no_end` | `time.present` | 부분 | `SLICE_OF`(L2 149)가 `present`로 보냄 |
| `time: future_*` | `time.future` | 부분 | |
| 질의 `TIME_INTENTS` | JEV `TimeIntent` (`PAST_EPISODIC`, `PRESENT_LIVE`, `FUTURE_PLANNED`, `CROSS_TEMPORAL_DIFF`) | `present/past/planned/cross_time`은 동일, `what_if`, `not_time_specific`은 loop 추가 | `what_if`는 multiverse에 해당하는 질의. JEV에 이 선택지가 없음 |
| `TRANSITION_KINDS.completed` | JEV §6.2 ④ "future 계획의 실행 및 완료" → `future → present` | 병행 | N2와 같은 문제 |

### 3.5 링크
| loop | 정본 관계 (C4) | 종류 | 설명 |
|---|---|---|---|
| `follows_from` | `derived_from` | 부분 | loop는 "이어지거나 결과", 정본은 "다른 노드/증거에서 파생". 시간 순서와 파생은 같지 않음. 현재 `linkTypeForRelation`이 `derive/follow/next/after/result/implement`를 `follows_from`으로 보냄(L4) |
| `decided_in` | (직접 대응 없음; `implements`의 역방향이 가장 가까움) | 없음 | "이 계획은 저 기록에서 결정" |
| `supersedes` | (없음; `updates`는 "제자리에서 갱신") | **없음** | 새 기록이 옛 기록을 **대체**. 정본 관계 표에 없음 (N6) |
| `refers_to` | `informs` | 부분 | 약한 참조 |
| `same_task` | (없음; `part_of`는 구성, `same_identity_as`는 동일성) | 없음 | 같은 과제/사건 묶음 |

## 4. 1:1이 안 되는 곳과 이유
- **N1. 상태 5값은 네 차원을 섞었다.** `plan`/`done`은 생명주기, `superseded`는 두 기록 사이의 관계에서 나오는 결과(loop 자신도 파생 링크 `superseded_by`를 따로 계산: L2 594), `reported_by_other`는 출처, `unknown`은 인식 실패입니다. 모델에게 5지선다로 묻기엔 편했지만(`st_P*`), 정본처럼 차원을 나누면 값이 다섯이 아니라 "상태 2(+모름) × 대체됨 여부 × 근거 종류"입니다. 이게 대응표에서 한 값이 여러 칸으로 갈라지는 이유입니다.
- **N2. `done`의 의미 (소유자 결정 필요).** JEV §6.2 ④는 "배포 끝났어"를 **결과 상태가 현재가 되는 승격**으로 씁니다: `future/db-migration.md → present/db-schema.md`, 옛 `present/sqlite-schema.md → past/archive/`. loop는 읽기의 슬라이스를 `done → past`로 둡니다 (`SLICE_OF_STATUS`, L2 147; 근거는 c36 s9 실측: 시간 라벨이 약해도 "끝났다는 보고는 발화 이전 사건"). 둘 다 맞는 면이 있습니다: **사건**("배포했다")은 과거, **결과 상태**("지금 PostgreSQL이다")는 현재입니다. loop의 `done` 하나가 둘을 한 값으로 뭉갰습니다. 정본식으로 쓰려면 사건 기록(`log`, `past`)과 결과 상태(`asset`, `present`)를 나눠 말해야 합니다.
- **N3. `hypothetical` 동음이의.** loop `slice: hypothetical`은 시간 위치의 한 값(what-if 가지; 정본 `multiverse`와 같은 쪽), 정본의 `hypothetical`은 4-Type 값(미확정 구상, 현실이 아님; C2 §8). 정본 JEV §6.2 ③은 두 값을 한 산출물에 동시에 줍니다(`TimeSlice: future` + `CognitiveType: hypothetical`). 같은 말로 두면 정본 쪽 독자가 loop 값을 4-Type으로 읽습니다.
- **N4. `plan` ≠ `hypothetical` ≠ 정본 future.** 정본 future는 vision, goal, plan, task 전부를 담는 **의도의 대표**(`time-future.md`). loop는 "정해짐(`plan`/`planned`)"과 "가정(`hypothetical`)"을 나눕니다. 정본에서 이 구분은 시간 위치가 아니라 4-Type(`asset` 계획 문서 대 `hypothetical` 구상)이나 `multiverse` 대 `future`로 갈립니다. 즉 loop의 `planned`는 `future` ∧ 확정된 것, `hypothetical`은 `future` ∧ 미확정이거나 `multiverse`입니다.
- **N5. `reported_by_other`가 loop 안에서도 중복.** `RECORD_STATUSES.reported_by_other`(L1 28~34)와 `PROVENANCE_KINDS.reported_by_other`(L1 25)가 같은 말을 상태와 출처로 두 번 가집니다. 정본 어휘로는 상태가 아니라 출처(들었나)입니다.
- **N6. `superseded`/`supersedes`.** 정본 관계 표(C4 224~255)에 대체 관계가 없습니다. `updates`는 "노드를 변경/갱신"이라 제자리 수정이고, 대체는 **새 기록이 생기고 옛 것이 과거로 내려가는** 일입니다 (JEV §6.2 ④의 `past/archive/` 동결이 이 사건). loop는 값 `superseded`와 링크 `supersedes`, 파생 `superseded_by`, 읽기 상태 `superseded`(정정)를 모두 씁니다. 정본에는 관계 하나(`supersedes`)와 시간 이동(과거로 내려감)이면 충분합니다.
- **N7. `unknown`은 정본에 없다.** 정본 값은 전제상 결정돼 있습니다. loop는 모델이 못 읽는 경우가 실제로 있어서 값이 필요했고(c34~c36 실측: 라벨이 바 아래면 설치 안 함), 그 값이 속성의 한 값처럼 쓰입니다. 정본식으로는 "속성 없음(미태깅)"으로 두는 것이 맞아 보입니다. 다만 정본이 미태깅 상태를 값으로 정의한 곳은 찾지 못했습니다 (확인 필요).
- **N8. `present`의 정의.** 정본: "지금 실행 가능한 상태, 지금 살아 있는 것"(`time-present.md`). loop: "현재 구간에 적용, 직접 관측일 필요 없음"(L4 127), `at_utterance`/`ongoing_no_end`를 포함. 정본의 present는 관측된 현재(`observed`), loop는 현재에 유효한 모든 것입니다.
- **N9. 4-Type은 파일 수준, loop 기록은 발화/페이지 수준.** `knowledge`(맥락 독립 지식)와 `log`(맥락 종속 기록)의 구분은 파일을 어디에 두는가(`MEMORY.md` 대 `subagent_reports/`)에서 나왔고, loop의 기록은 이 구분을 쓰지 않습니다. 억지로 붙이면 `agent_note`와 `utterance` 페이지는 `log`, 사람 확인을 거친 것은 `asset`이 되지만, `knowledge`는 해당 없음입니다.
- **N10. 출처 축은 두 층.** 정본의 출처 모니터링(C2 §8.C)은 "직접 봤나/들었나/상상했나"로 **기억의 출처**를 추적합니다. loop의 `source`는 **화자가 근거로 대는 것**(관측, 전해 들음, 추론, 기록 인용, 무근거)입니다. 두 번째가 더 세밀하고, 상상은 loop에서 출처가 아니라 `form: conditional`로 갑니다. `inference`는 정본에 자리가 없습니다. 또 SourceRef(C5)는 자원의 좌표라서 이 축과 무관합니다 (이름만 비슷).
- **N11. 링크.** 정본 관계 표는 구조/실행/증거 중심이고, 기록 사이의 서사 관계(`same_task`, `decided_in`, `supersedes`)가 없습니다. 코드는 정본 관계 이름을 보수적으로 loop 링크로 바꿉니다 (`linkTypeForRelation`: 모르면 `refers_to`).
- **N12. 읽기 상태와 승격.** `pending → accepted/rejected`는 정본의 "승격(`hypothetical→asset`)"과 규칙이 같습니다(자동 승격 없음, 명시적 확인만). 그러나 의미가 한 칸 어긋납니다: 정본은 "현실이 아닌 구상을 현실로", loop는 "현실로 보고된 것(미확인)을 확인된 것으로"입니다. 전자는 상상 대 현실, 후자는 보고 대 확인.
- **N13. 불일치(conflict, contradiction).** c38, c39가 만든 코드 표시는 정본에 대응 개념이 없습니다. 가장 가까운 것은 C2의 "출처 모니터링 실패 → 거짓 기억"(§8.C)과 "catastrophic interference"(§8.A)지만 둘 다 위험 설명이지 어휘가 아닙니다.

## 5. 코드가 이미 하는 변환과 그 구멍 (보고만, 고치지 않음)
- 정본 snapshot `status` → loop 상태 (`egdesk-wiki-adapter.mjs` 24줄): `plan|draft|propos` → `plan`, `done|complete|observ|current|live` → `done`, 그 밖 → `unknown`. 정본 값은 `planned`(→`plan`), `observed`(→`done`)이고 **`historical`은 어느 쪽에도 안 걸려 `unknown`**이 됩니다. 정본의 과거 스냅샷이 loop에서는 상태를 모르는 기록이 됩니다.
- 정본 시간 → loop 슬라이스 (`ONTOLOGY_SLICES`, L4 641): `past`, `present`, `future → planned`, `planned`, `hypothetical`. 정본 4번째 대표 **`multiverse`는 목록에 없어 `unknown`**입니다 (`|| 'unknown'`). 정본이 말하는 가지/시뮬레이션이 loop에서는 시간 미상이 됩니다.
- 정본 관계 → loop 링크 (`linkTypeForRelation`, L4 647 이하): 정규식 기반 보수적 변환. `derived_from`은 `follows_from`, `implements`도 `follows_from`, `updates`/`informs`/`provides_evidence_for`는 `refers_to`로 감. 위 N6, N11의 이유로 대체나 같은 과제는 정본 관계에서 나오지 않습니다.
- 반대 방향(loop → 정본)의 변환은 없습니다. loop가 쓴 기록은 위키 저장소에만 있고 온톨로지로 되돌려 쓰지 않습니다.

## 6. 정본 표기 권고안 (소유자용 제안; 정본은 수정하지 않음)
정본의 문형을 그대로 따라, 기록 하나를 **독립된 속성 넷**의 합성으로 정의하는 것을 권합니다 (정본 `axis-virtual.md`/`axis-time.md`의 "X는 별도 주축이 아니다, X = …" 문형):

```text
Record (기억 층의 기록 하나)
  = Virtual claim        무엇에 대한 것인가 (개념/과제; 링크)
  + Time placement       time_slice ∈ {past, present, future, multiverse}  (+ 선택: 시점 앵커)
  + Evidence basis       누가 어떤 근거로 (출처 모니터링)
  + Confirmation state   확인 전 보고 / 확정   (사람의 명시적 확인으로만 승격)
  (+ 선택 속성)          Cognitive type ∈ {asset, knowledge, log, hypothetical}
```

속성별 권고 값. 정본에 이미 있는 낱말을 먼저 쓰고, loop 값은 별칭으로 남깁니다:

| 속성 | 권고 값 | loop의 현재 값 → 권고 |
|---|---|---|
| 시간 위치 | `past`, `present`, `future`, `multiverse`; **값이 없으면 속성 없음**(미태깅) | `past`→`past`, `present`→`present`, `planned`→`future`, `hypothetical`→`multiverse`, `unknown`→속성 없음 |
| 상태 (생명주기) | 정본 snapshot 값 그대로 `planned`, `observed`, `historical`; 없으면 속성 없음 | `plan`→`planned`, `done`→`observed`(지금의 결과 상태) 또는 `historical`(끝난 사건) *(N2: 소유자 결정)*, `unknown`→속성 없음 |
| 대체됨 | 상태 값이 아니라 **관계 `supersedes`** (정본 관계 표에 추가 제안) + "과거로 내려감" | `superseded`(상태)와 `superseded_by`(파생)는 이 관계에서 파생하는 표시로만 남김 |
| 근거 | `witnessed`(직접 함/봄), `told`(전해 들음), `read`(기록/문서를 읽음), `inferred`(추론), `unstated`(근거 없음); 모르면 속성 없음 | `self_reported_observation`→`witnessed`, `attributed_report`→`told`, `record_based`→`read`, `inference`→`inferred`, `unspecified`→`unstated`, `unknown`→속성 없음; **`reported_by_other`는 `told`로 흡수** (N5) |
| 확인 상태 | `unconfirmed report`(확인 전 보고) → `confirmed`; 거절 시 `withdrawn` | `pending`→`unconfirmed report`, `accepted`→`confirmed`, `rejected`→`withdrawn` (이미 엔진 문장이 "확인 전 보고"를 씀) |
| 4-Type (선택) | 정본 그대로 | loop에는 아직 없음. 쓰게 되면: 에이전트 기록과 발화 페이지 → `log`, 사람이 확인한 것 → `asset`, 구상 → `hypothetical` |
| 말의 형식 (발화 전용) | `assertion`, `plan`, `conditional`, `question` | 그대로 (정본에 화행 어휘가 없으니 Virtual의 의도 쪽에 신설 제안) |
| 링크 | 정본 관계를 그대로 쓰고 **`supersedes`만 추가 제안**; `follows_from`=`derived_from`, `refers_to`=`informs`로 별칭; `decided_in`, `same_task`는 loop 전용으로 유지 | |
| 불일치 | `conflict`(말 대 기록), `contradiction`(기록 대 기록): 저장하지 않는 표시 | 그대로 (정본에 대응 없음) |

이 권고의 이유 (기준과의 연결):
- 정본의 기존 낱말을 그대로 쓰면 정본 독자가 읽는 방식이 바뀌지 않습니다 (U6: 시제와 출처는 온톨로지 축).
- 상태에서 세 값(`superseded`, `reported_by_other`, `unknown`)을 빼면 모델에게 묻는 선택지(`st_P*`)가 `plan/done` + "해당 없음"으로 줄어드는데, 이는 **행동이 바뀌는 변경**이라 이 문서의 범위 밖입니다. 어휘만 먼저 정렬하고, 코드는 별칭(§6 표의 "loop 값 → 권고")으로 둔 채 그대로 두는 것이 안전합니다.
- 동음이의(N3)는 loop 쪽을 `multiverse`로 부르는 것으로 풀립니다. 반대로 하면 4-Type 값과 충돌합니다.

## 7. 소유자 결정이 필요한 것
1. **N2**: "끝났다" 보고의 시간 위치와 상태. (a) 사건은 `past`+`historical`, 결과 상태는 `present`+`observed`로 둘로 나눈다 (JEV §6.2 ④에 가깝고, 정확하지만 기록이 둘이 됨), (b) 한 기록으로 두고 `historical`(loop 현재 동작에 가까움), (c) 한 기록으로 두고 `observed`(정본 ④에 가까움). 지금 loop는 (b) 쪽입니다.
2. 정본 관계 표에 **`supersedes`를 추가**할지 (N6). 아니면 `updates` + 과거 이동으로 표현할지.
3. 4-Type을 loop 기록의 **선택 속성으로 도입**할지 (N9). 도입하지 않으면 정본의 4-Type은 파일 수준 어휘로만 남고 loop와 병행합니다.
4. `unknown`을 **값이 아니라 속성 없음**으로 정의할지 (N7). 코드 변경 영향이 있어 이 문서에서는 제안만.
5. 출처 축에 **`inferred`**를 정본이 받아들일지 (N10), `imagined`는 근거가 아니라 형식(`conditional`)으로 둘지.
6. §5의 코드 구멍 2건(`multiverse`→`unknown`, `historical`→`unknown`)을 별도 사이클에서 고칠지.

## 8. 하지 않은 것
- 정본(`ideas/`, `ontology/`, `docs/`)과 코드, 대본, 계획을 수정하지 않았습니다.
- 새 값의 이름(`witnessed` 등)은 **제안 표기**이며 제품 문구가 아닙니다. 승인 전에는 어디에도 쓰지 않습니다.
- loop의 질문 선택지나 임계값은 건드리지 않았습니다.
