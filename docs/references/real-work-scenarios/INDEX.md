# EG-Desk 실업무 시나리오 인덱스

**발견 기준일**: 2026-08-31  
**포함된 물리 로그**: 94개  
**포함된 고유 사용자 thread**: 93개  
**추가 legacy top-level user 대화**: 10개  
**casebook source root 합계**: 103개  
**상태**: `SECOND-WAVE-VALIDATED / PRODUCT-PROMOTION-PENDING`

앞의 93개는 현재 casebook inclusion scope에서 `thread_source=user`로 식별된 수이고,
legacy metadata에는 source가 비어
있지만 실제 최상위 사용자 대화인 Taehwa 1개와 U-Tel 9개가 추가로 있다. 이 숫자는
사례 수가 아니라 현재 casebook inclusion scope에 남긴 source root 수다. 동일
thread ID가 두 rollout에 존재한 로그 1개는 중복 제거했다. 저장
경로는 source discovery에만 사용하며 최종 사례는 실제 업무 목표와 책임 기준으로
분류한다.

## 1. 발견 corpus

| discovery group | user thread | 현재 처리 | 비고 |
|---|---:|---|---|
| EG-Desk 제품 개발·Firefox 스크립트 | 42 | 1차 packet 완료 | 주 작업 기준 범위의 29개 episode와 직접 자식 lineage 9개를 분석; 별도 제품 연구·실행 기록은 후속 wave |
| KUUS | 15 | packet 완료 | 행정·재무·브라우저 포털 업무; 민감 데이터 비복제 |
| Taehwatrans | 28 | packet 완료 | 로컬 10개, 두 Drive corpus 18개 packet 완료; 교차 중복은 registry 승격 시 disposition |
| Grammar-ON | 3 | packet 완료 | 제품·콘텐츠·배포 workflow 8개 |
| Other-local 기업 PoC | 1 | packet 완료 | legacy U-Tel 대화 9개와 함께 6개 비식별 packet으로 통합 |
| Codex context·new-chat probes | 4 | 분류 완료 | PLATFORM-TEST 2개, low-priority real-work 2개 |
| **합계** | **93** |  |  |

## 2. 분석 상태

| 상태 | 뜻 |
|---|---|
| `DISCOVERED` | thread 존재와 기본 locator만 확인 |
| `SHAPE-INDEXED` | turn 수·기간·대략적 주제만 확인 |
| `EPISODE-SPLIT` | 비중첩 업무 episode 경계를 정함 |
| `CASE-DRAFTED` | SourceRef 기반 사례 초안을 만듦 |
| `PM-REVIEWED` | 중복·반례·제품 함의를 PM이 검토함 |
| `VERIFIED-AS-OF` | 필수 SourceRef와 claim 경계를 다시 확인함 |
| `MIXED` | 사례 안에서 claim별 증거 상태가 다르므로 각 marker를 확인해야 함 |
| `STALE` | 출처 또는 현재 상태가 바뀌어 재검토 필요 |
| `INACCESSIBLE` | 출처를 현재 권한·형식으로 확인할 수 없음 |

## 3. 활성 source corpus

| source corpus | 범위 | 상태 | 목적 |
|---|---|---|---|
| `SRC-EGDESK-MANUAL-THREAD` | thread `019f8d42-4886-7041-8421-c5e343d465e0`, 기준 범위 turns 1–106 | `CASE-DRAFTED` | 제품 개발·문서·Browser·Board·Chat·Git 운영 episode 29개 추출 |
| `SRC-EGDESK-SUBAGENT-LINEAGE` | 위 thread의 PM·WM·Worker·Explorer 자식 실행 | `CASE-DRAFTED` | 직접 자식·fresh session·child lifecycle·Main 보고 정확성 분석 완료 |
| `SRC-GRAMMARON-LOCAL` | Grammar-ON user threads 3개 | `CASE-DRAFTED` | 8개 workflow packet과 multi-agent technique 분석 완료 |
| `SRC-KUUS-LOCAL` | KUUS user threads 15개 | `CASE-DRAFTED` | 18개 workflow packet, Browser fracture와 technique 분석 완료 |
| `SRC-TAEHWA-LOCAL` | Taehwa_backup user threads 16개 | `CASE-DRAFTED` | 10개 business workflow packet과 lineage 분석 완료 |
| `SRC-TAEHWA-DRIVE` | Taehwatrans Drive user threads 13개 | `CASE-DRAFTED` | 두 Drive corpus에서 18개 packet 완료, 교차 중복 disposition 필요 |
| `SRC-UTEL-LEGACY` | U-Tel top-level conversations 10개 | `CASE-DRAFTED` | explicit 1개 + legacy source-missing 9개를 6개 packet으로 통합 |
| `SRC-CODEX-PROBES` | Codex probe user threads 4개 | `CASE-DRAFTED` | context probe 2개를 1 test로 통합, real-work 2개 분리 |
| `SRC-ALL-INCLUDED-THREADS` | 포함된 고유 user threads 93개 | `SHAPE-INDEXED` | 93개 전수 shape; 91개 식별, ID 충돌 2개 `NEEDS-REVIEW` |

### 3.1 현재 EG-Desk 주 작업의 episode packet

아래 항목은 SourceRef 분석이 끝난 원 episode packet이다. PM 중복 검토와 정본 경계
대조를 거쳐 기존 사례 병합·신규 승격·연구 유지·근거 보류를 확정했다. 한 turn 안에서
목표가 바뀐 경우 범위가 겹칠 수 있다.

**2차 wave disposition 합계**: `PROMOTED 34 / MERGED 29 / RESEARCH/PROBE 16 / DEFER-EVIDENCE 22 = 101`

| turn 범위 | episode | packet 상태 | 2차 wave disposition |
|---|---|---|---|
| 1–6 | 로컬 체크포인트를 푸시 전 자산 검토로 재작성 | `CASE-PACKET` | `MERGED(RWS-0001)` |
| 7–14 | Worker worktree와 단일 Integration 검증 책임 | `CASE-PACKET` | `MERGED(RWS-0002)` |
| 15–19 | 자동개발 기준선과 Main·PM·WM 운영모델 | `CASE-PACKET` | `DEFER-EVIDENCE` |
| 20–21 | Codex-native PM 구축과 fresh-session 활성화 증명 | `CASE-PACKET` | `PROMOTED(RWS-0011)` |
| 22–24 | 대량 유스케이스 실패와 Contract·Trace Atlas 전환 | `CASE-PACKET` | `MERGED(RWS-0004)` |
| 25–29 | Atlas 정밀화와 성급한 완료 판정 철회 | `CASE-PACKET` | `MERGED(RWS-0004)` |
| 30–33 | 구현 가능한 미세 상호작용 완결 감사 | `CASE-PACKET` | `MERGED(RWS-0004)` |
| 34–39 | 정의되지 않은 `Workspace` 용어의 전파와 철회 | `CASE-PACKET` | `MERGED(RWS-0004)` |
| 39–41 | 오염된 권위를 제거한 clean-room Atlas 재작성 | `CASE-PACKET` | `MERGED(RWS-0004)` |
| 42–43 | 장문 한국어 정본의 의미 보존·독립 감사 | `CASE-PACKET` | `MERGED(RWS-0003)` |
| 44–48 | 제품 독자용 문서와 provenance 운영 원장 분리 | `CASE-PACKET` | `PROMOTED(RWS-0012)` |
| 49 | Playback을 Answer Briefing으로 재정의 | `CASE-PACKET` | `DEFER-EVIDENCE` |
| 50 | 최초 Chat과 Agent Activity Projection 구체화 | `CASE-PACKET` | `DEFER-EVIDENCE` |
| 51–53 | Snapshot/Live fidelity와 질문 오독 되돌림 | `CASE-PACKET` | `DEFER-EVIDENCE` |
| 54–57 | Smart Read를 지능형 file-read로 한정 | `CASE-PACKET` | `RESEARCH/PROBE` |
| 58–61 | Atlas·Contract·HUM 원장의 양방향 weave | `CASE-PACKET` | `PROMOTED(RWS-0012)` |
| 62–63 | PM/WM 운영과 제품 문서의 분리 커밋 | `CASE-PACKET` | `MERGED(RWS-0001)` |
| 64–65 | 제품 문서 화자와 Documentation Governance 분리 | `CASE-PACKET` | `PROMOTED(RWS-0012)` |
| 67–69 | 제품 소유자용 최소 독서 경로 | `CASE-PACKET` | `PROMOTED(RWS-0012)` |
| 71–77 | Canvas 밖 Browser focus·stale action | `CASE-PACKET` | `MERGED(RWS-0007)` |
| 78–79 | Focus presentation·zoom·파일 권한 UX | `CASE-PACKET` | `MERGED(RWS-0007)` |
| 80–82 | 제품 문서 열기와 HUM/Q 책임 구분 | `CASE-PACKET` | `PROMOTED(RWS-0012)` |
| 83–86 | 하나의 Desk·여러 Board·View/Runtime 수명주기 | `CASE-PACKET` | `PROMOTED(RWS-0013)` |
| 86–88 | 담당 Agent 방·Canvas Memo·업무 감독 모델 | `CASE-PACKET` | `PROMOTED(RWS-0013)` |
| 89–95 | 참고조사 없는 Chat 시안 폐기와 Agent Room 재설계 | `CASE-PACKET` | `DEFER-EVIDENCE` |
| 96, 104–105 | UI보다 먼저 시나리오를 세우고 SourceRef로 재개 | `CASE-PACKET` | `DEFER-EVIDENCE` |
| 97–98 | 확정 결정과 논의 중 결정을 분리해 정본 반영 | `CASE-PACKET` | `PROMOTED(RWS-0013)` |
| 99–103 | 문서 변경의 Git 체크포인트·원격 공개·로컬 전용 경계 | `CASE-PACKET` | `MERGED(RWS-0001)` |
| 106 | 가상 시나리오에서 실작업 기반 casebook으로 전환 | `CASE-PACKET` | `DEFER-EVIDENCE` |

### 3.2 Grammar-ON episode packet

| packet | episode | packet 상태 | 2차 wave disposition |
|---|---|---|---|
| `GO-01` | 신규 작업 PC의 프로젝트·권한·로컬 실행 준비 | `CASE-PACKET + TECHNIQUE-AUDIT` | `MERGED(RWS-0010)` |
| `GO-02` | 학생 화면 성능장애 진단과 Production 판정 교정 | `CASE-PACKET + TECHNIQUE-AUDIT` | `MERGED(RWS-0008)` |
| `GO-03` | 교재 노출 누락 복구와 전량 공개 지시 이행 | `CASE-PACKET + TECHNIQUE-AUDIT` | `MERGED(RWS-0008)` |
| `GO-04` | 운영 DB schema·이력·권한의 읽기 전용 감사 | `CASE-PACKET + TECHNIQUE-AUDIT` | `MERGED(RWS-0009)` |
| `GO-05` | 제품 방향과 README 권위 교정 | `CASE-PACKET + TECHNIQUE-AUDIT` | `PROMOTED(RWS-0028)` |
| `GO-06` | 서비스 중단을 피한 Platform·Pipeline 경계 분리 | `CASE-PACKET + TECHNIQUE-AUDIT` | `PROMOTED(RWS-0032)` |
| `GO-07` | 과거 문서 보존·현재 문서 재구축·Skill 권위 강등 | `CASE-PACKET + TECHNIQUE-AUDIT` | `PROMOTED(RWS-0028)` |
| `GO-08` | 권한이 분리된 다중 PC Git·PR·배포 인계 | `CASE-PACKET + TECHNIQUE-AUDIT` | `MERGED(RWS-0010)` |

### 3.3 EG-Desk subagent lineage packet

| packet | episode | packet 상태 | 2차 wave disposition |
|---|---|---|---|
| `L1` | Codex-native PM 구축·fresh session·장문 결과 회수 | `LINEAGE-PACKET` | `PROMOTED(RWS-0011)` |
| `L2` | 반복 PM 감사의 합의 착시와 잘못된 완료 판정 | `LINEAGE-PACKET` | `MERGED(RWS-0004)` |
| `L3` | 소유자 교정 뒤 clean-room context escape | `LINEAGE-PACKET` | `MERGED(RWS-0004)` |
| `L4` | 장문 한국어화의 bounded map/reduce와 독립 judge | `LINEAGE-PACKET` | `MERGED(RWS-0003)` |
| `L5` | 제품·파일·보존·외부기술 역할 분리 redesign | `LINEAGE-PACKET` | `PROMOTED(RWS-0012)` |
| `L6` | PM이 Main의 잘못된 framing을 강화한 Snapshot 의미 교정 | `LINEAGE-PACKET` | `MERGED(RWS-0004)` |
| `L7` | Atlas·Contract·원장 weave의 화자·감사 lifecycle | `LINEAGE-PACKET` | `PROMOTED(RWS-0012)` |
| `L8` | 좁은 WM 라우팅과 완료·미완료 handoff 구분 | `LINEAGE-PACKET` | `PROMOTED(RWS-0012)` |
| `L9` | 실제 업무 casebook 사후 map/reduce 자체의 감독 사례 | `LINEAGE-PACKET` | `DEFER-EVIDENCE` |

직접 자식 thread와 업무는 일대일이 아니다. 같은 child가 여러 parent turn에서 재사용될
수 있고, fresh session은 구조적 parent ID 없이 실행될 수 있다. 따라서 최종 사례는
child thread ID만으로 업무를 식별하지 않고 `parent episode + child turn + dispatch
record + artifact revision`을 함께 사용한다.

### 3.4 KUUS episode packet

| packet | episode | packet 상태 | 2차 wave disposition |
|---|---|---|---|
| `KUUS-01` | 맞춤 정부지원사업 발견·모니터링·보고 | `CASE-PACKET + FRACTURE + TECHNIQUE` | `PROMOTED(RWS-0014)` |
| `KUUS-02` | 근로장려금 기한후 신청과 접수 검증 | `CASE-PACKET + FRACTURE + TECHNIQUE` | `PROMOTED(RWS-0015)` |
| `KUUS-03` | 직원 퇴사·보험·고용서류·유급대표 전환 | `CASE-PACKET + FRACTURE + TECHNIQUE` | `PROMOTED(RWS-0016)` |
| `KUUS-04` | 임대료 세금계산서 누락과 양측 VAT 복구 | `CASE-PACKET + TECHNIQUE` | `DEFER-EVIDENCE` |
| `KUUS-05` | 은행거래 수집·Google Sheets 반영 | `CASE-PACKET + FRACTURE + TECHNIQUE` | `PROMOTED(RWS-0017)` |
| `KUUS-06` | 정기지출 대사와 시트 디자인 재설계 | `CASE-PACKET + FRACTURE + TECHNIQUE` | `PROMOTED(RWS-0017)` |
| `KUUS-07` | 개인·개인사업·법인의 체납 국세·지방세 조회 | `CASE-PACKET + TECHNIQUE` | `RESEARCH/PROBE` |
| `KUUS-08` | 통신판매업 신고와 법인 PG 계약 검증 | `CASE-PACKET + FRACTURE + TECHNIQUE` | `MERGED(RWS-0005)` |
| `KUUS-09` | 원천세·미지급급여·간이지급명세서 복구 | `CASE-PACKET + FRACTURE + TECHNIQUE` | `DEFER-EVIDENCE` |
| `KUUS-10` | 법인 VAT 대사와 납부기한 연장 | `CASE-PACKET + FRACTURE + TECHNIQUE` | `PROMOTED(RWS-0020)` |
| `KUUS-11` | 수요기업–공급기업 정부지원 포트폴리오 | `CASE-PACKET + FRACTURE + TECHNIQUE` | `RESEARCH/PROBE` |
| `KUUS-12` | 급전자금·정책대출의 제약 기반 필터링 | `CASE-PACKET + FRACTURE + TECHNIQUE` | `RESEARCH/PROBE` |
| `KUUS-13` | 개인사업자·법인 세무일정과 신고 triage | `CASE-PACKET + TECHNIQUE` | `RESEARCH/PROBE` |
| `KUUS-14` | 개인사업장 주소 이전과 임대업 추가 | `CASE-PACKET + TECHNIQUE` | `DEFER-EVIDENCE` |
| `KUUS-15` | 다중 Google 계정과 로컬 ontology 배포 | `CASE-PACKET + FRACTURE + TECHNIQUE` | `DEFER-EVIDENCE` |
| `KUUS-16` | 임대차계약서 생성과 서명란 renderer 복구 | `CASE-PACKET + FRACTURE + TECHNIQUE` | `DEFER-EVIDENCE` |
| `KUUS-17` | 부동산 매각 준비와 중개사 접촉 | `CASE-PACKET + TECHNIQUE` | `RESEARCH/PROBE` |
| `KUUS-18` | 사회보험 지원월 감사와 종료예상 캘린더 | `CASE-PACKET + FRACTURE + TECHNIQUE` | `PROMOTED(RWS-0021)` |

### 3.5 Taehwatrans local episode packet

| packet | episode | packet 상태 | 2차 wave disposition |
|---|---|---|---|
| `TAEHWA-01` | 경영진·전사 AX 발표자료의 서사 설계와 재개 | `CASE-PACKET + FRACTURE + TECHNIQUE` | `PROMOTED(RWS-0022)` |
| `TAEHWA-02` | AX Board·진행 대시보드와 공유 정본 운영 | `CASE-PACKET + FRACTURE + TECHNIQUE` | `PROMOTED(RWS-0018)` |
| `TAEHWA-03` | 웹사이트 소스·문의·SSL·도메인·호스팅 전환 | `CASE-PACKET + FRACTURE + TECHNIQUE` | `PROMOTED(RWS-0023)` |
| `TAEHWA-04` | GA4/GSC·문의 품질·고정 검색순위 보고 | `CASE-PACKET + FRACTURE + TECHNIQUE` | `PROMOTED(RWS-0024)` |
| `TAEHWA-05` | AI 작업용 장비 조달과 원격운영 전환 | `CASE-PACKET + FRACTURE + TECHNIQUE` | `DEFER-EVIDENCE` |
| `TAEHWA-06` | R&D CAD 해석과 근거 기반 제품 예상도 | `CASE-PACKET + FRACTURE + TECHNIQUE` | `DEFER-EVIDENCE` |
| `TAEHWA-07` | 공통 ontology·권한·지식 승격 거버넌스 | `CASE-PACKET + FRACTURE + TECHNIQUE` | `PROMOTED(RWS-0026)` |
| `TAEHWA-08` | 해외영업 이메일 Agent runtime·handoff·산출물 | `CASE-PACKET + TECHNIQUE` | `RESEARCH/PROBE` |
| `TAEHWA-09` | 브라우저 로그인·MFA 진단과 다중계정 분리 | `CASE-PACKET + FRACTURE + TECHNIQUE` | `MERGED(RWS-0007)` |
| `TAEHWA-10` | Codex·MCP·SDK·Subagent·Automation 운영 실험 | `CASE-PACKET + TECHNIQUE` | `RESEARCH/PROBE` |

### 3.6 Taehwatrans Drive episode packet

| packet | episode | packet 상태 | 2차 wave disposition |
|---|---|---|---|
| `TAEHWA-D01` | 급여 왕복처리와 블라인드 업무지식 재현 | `CASE-PACKET + FRACTURE + TECHNIQUE` | `MERGED(RWS-0006)` |
| `TAEHWA-D02` | ERP·연차 원천의 사원명부 통합 | `CASE-PACKET + TECHNIQUE` | `DEFER-EVIDENCE` |
| `TAEHWA-D03` | 연차 정본의 잠금 이후 최소 후속수정 | `CASE-PACKET + TECHNIQUE` | `PROMOTED(RWS-0019)` |
| `TAEHWA-D04` | PST 복구 자동화와 Outlook 날짜 의미 | `CASE-PACKET + TECHNIQUE` | `PROMOTED(RWS-0029)` |
| `TAEHWA-D05` | Outlook–Google 인증 장애의 사건축 분리 | `CASE-PACKET + FRACTURE + TECHNIQUE` | `DEFER-EVIDENCE` |
| `TAEHWA-D06` | 공급자 규제 설문의 정확한 업무 식별 | `CASE-PACKET + TECHNIQUE` | `DEFER-EVIDENCE` |
| `TAEHWA-D07` | R&D 아카이브 복원에서 외부상담 제출까지 | `CASE-PACKET + FRACTURE + TECHNIQUE` | `PROMOTED(RWS-0025)` |
| `TAEHWA-D08` | 아카이브·casebook·날짜별 이력감사 | `CASE-PACKET + TECHNIQUE` | `DEFER-EVIDENCE` |
| `TAEHWA-D09` | AX 내부 커뮤니케이션과 공통 업무흐름 시각화 | `CASE-PACKET + TECHNIQUE` | `DEFER-EVIDENCE` |
| `TAEHWA-D10` | SQLite 안전 취급 일반 참고 | `REFERENCE-PACKET` | `RESEARCH/PROBE` |

### 3.7 Taehwatrans secondary Drive episode packet

| packet | episode | packet 상태 | 2차 wave disposition |
|---|---|---|---|
| `TAEHWA-SD01` | 급여·연차 규칙 복원과 개선 사본 | `CASE-PACKET + TECHNIQUE` | `MERGED(RWS-0006)` |
| `TAEHWA-SD02` | 월별 급여 운영화와 Browser capability 단절 | `CASE-PACKET + FRACTURE + TECHNIQUE` | `MERGED(RWS-0006)` |
| `TAEHWA-SD03` | 장치·계정·역할·권한 분리 | `CASE-PACKET + MULTI-DEVICE` | `MERGED(RWS-0010)` |
| `TAEHWA-SD04` | 온톨로지 구조 마이그레이션과 의미 누락 재감사 | `CASE-PACKET + TECHNIQUE` | `PROMOTED(RWS-0027)` |
| `TAEHWA-SD05` | 다중 Agent 업무 Scenario Lab 검증 | `CASE-PACKET + TECHNIQUE` | `PROMOTED(RWS-0030)` |
| `TAEHWA-SD06` | ERP 매뉴얼 수집과 실제 화면 A/B | `CASE-PACKET + FRACTURE + TECHNIQUE` | `PROMOTED(RWS-0031)` |
| `TAEHWA-SD07` | 온톨로지와 임시 산출물 작업공간 분리 | `CASE-PACKET` | `RESEARCH/PROBE` |
| `TAEHWA-SD08` | 공유 Drive 탐색과 Google pointer file 처리 | `CASE-PACKET + PRIVACY` | `DEFER-EVIDENCE` |

### 3.8 U-Tel episode packet

| packet | episode | packet 상태 | 2차 wave disposition |
|---|---|---|---|
| `UTEL-01` | 자체호스팅 LLM 업무 shell 후보 평가 | `RESEARCH-PACKET + TECHNIQUE` | `RESEARCH/PROBE` |
| `UTEL-02` | 로컬 대형 모델 선택과 정본 비교 문서 | `RESEARCH-PACKET + TECHNIQUE` | `RESEARCH/PROBE` |
| `UTEL-03` | 구매 AI 업무흐름의 live visualization | `CASE-PACKET + UI-FRACTURE + TECHNIQUE` | `MERGED(RWS-0007)` |
| `UTEL-04` | 중첩 저장소 상태 확인과 안전한 동기화 | `CASE-PACKET + TECHNIQUE` | `MERGED(RWS-0001)` |
| `UTEL-05` | Codex 자율실행·권한 정책 조사 | `PLATFORM-PACKET` | `RESEARCH/PROBE` |
| `UTEL-06` | 실패한 PoC 종료 커뮤니케이션 초안 | `CASE-PACKET + AUTHORITY` | `DEFER-EVIDENCE` |

### 3.9 Codex probe packet

| packet | episode | packet 상태 | 2차 wave disposition |
|---|---|---|---|
| `PROBE-PT01` | 대용량 context 경계와 무응답 완료 상태 | `PLATFORM-TEST` | `RESEARCH/PROBE` |
| `PROBE-RW01` | 모호한 소프트웨어 quota의 정책·계정상태 분리 | `LOW-PRIORITY CASE-PACKET` | `RESEARCH/PROBE` |
| `PROBE-RW02` | 지역·연령·시점별 교통지원 비교와 계산 | `LOW-PRIORITY CASE-PACKET` | `RESEARCH/PROBE` |

## 4. 사례 registry

개별 `RWS-*` ID는 병렬 분석 결과를 모두 모아 같은 episode를 중복 제거한 뒤 부여한다.
따라서 현재 단계에서는 빈 번호를 예약하지 않는다.

| RWS ID | 제목 | business owner | evidence state | SourceRef | 관련 정본 | record status |
|---|---|---|---|---|---|---|
| `RWS-0001` | [Git 체크포인트·푸시 검토·원격 확인의 분리](./cases/rws-0001-git-checkpoint-push-evidence.md#rws-0001) | EG-Desk 제품 개발 | `MIXED / claim별` | parent T1–6, T62–63, T99–103 | CODE-01, Contract §6·§13, HUM-CODE-001 | `ACTIVE` |
| `RWS-0002` | [Worktree 병렬 수정과 단일 Integration 검증 책임](./cases/rws-0002-worktree-integration-ownership.md#rws-0002) | EG-Desk 제품 개발 | `MIXED / claim별` | parent T7–14 | AI-06, Contract §9·§11, HUM-ORCH/CODE | `ACTIVE` |
| `RWS-0003` | [장문 번역의 bounded map/reduce와 독립 의미 감사](./cases/rws-0003-bounded-map-reduce-semantic-audit.md#rws-0003) | EG-Desk 제품 문서 | `MIXED / claim별` | parent T42–43 + exact child IDs | AI-06, Contract §9·§11, HUM-ORCH | `ACTIVE` |
| `RWS-0004` | [다중 PM 합의 착시와 clean-room context escape](./cases/rws-0004-consensus-illusion-clean-room-escape.md#rws-0004) | EG-Desk 제품 설계 | `MIXED / claim별` | parent T22–41 dispatch records | Atlas·Contract·HUM·Governance | `ACTIVE` |
| `RWS-0005` | [외부 포털의 저장·제출·접수·처리 상태 분리](./cases/rws-0005-external-portal-state-machine.md#rws-0005) | 여러 실제 행정·세무 workflow | `MIXED / claim별` | portal SourceRef 2개 | BROWSER-04, AUTH-01, Contract §3·§13 | `ACTIVE` |
| `RWS-0006` | [결과 일치와 업무지식 재현을 구분한 blind context isolation](./cases/rws-0006-blind-reproduction-context-isolation.md#rws-0006) | 총무회계·급여 업무 | `MIXED / claim별` | payroll parent + child graph | AI-06, Contract §9·§11, HUM-ORCH | `ACTIVE` |
| `RWS-0007` | [Browser Surface·profile·focus·revision identity 단절](./cases/rws-0007-browser-surface-identity-lease.md#rws-0007) | 여러 Browser workflow | `MIXED / claim별` | Browser SourceRef 6개 | V-02, TOOL/BROWSER, Contract §3·§4.1 | `ACTIVE` |
| `RWS-0008` | [다른 PC의 작업을 Git·DB·Browser·배포 층별로 복구](./cases/rws-0008-cross-layer-environment-recovery.md#rws-0008) | Grammar-ON 제품 운영 | `MIXED / claim별` | Grammar parent T6–33 | BROWSER/CODE, Contract §3·§13 | `ACTIVE` |
| `RWS-0009` | [Read-only scope lock과 schema·security 증거 경계](./cases/rws-0009-read-only-scope-lock.md#rws-0009) | Grammar-ON 제품 운영 | `MIXED / claim별` | schema-only T1 | AGENT-02, Contract §14, HUM-RUN | `ACTIVE` |
| `RWS-0010` | [권한이 다른 기기 사이의 작업 재개와 release handoff](./cases/rws-0010-cross-device-release-handoff.md#rws-0010) | Grammar-ON·cross-device release | `MIXED / claim별` | onboarding·release SourceRef 2개 | COL/DATA, Contract §12·§15, HUM-COLLAB/REMOTE | `ACTIVE` |
| `RWS-0011` | [Codex 프로젝트 PM 프로필의 세션 활성화](./cases/rws-0011-codex-project-pm-profile-activation.md#rws-0011) | EG-Desk 개발 Agent 운영 | `MIXED / claim별` | parent·child SourceRef 3개 | AGENT-02, Contract, Governance | `ACTIVE` |
| `RWS-0012` | [제품 문서의 수신 상황 분리와 정본 weave](./cases/rws-0012-product-document-receiving-situation-weave.md#rws-0012) | EG-Desk 제품 문서 | `MIXED / claim별` | parent·child SourceRef 4개 | Atlas·Contract·HUM·Governance | `ACTIVE` |
| `RWS-0013` | [제품 소유자 교정의 결정·OPEN 분리와 정본 승격](./cases/rws-0013-owner-decision-to-canonical.md#rws-0013) | EG-Desk 제품 소유자 | `MIXED / claim별` | owner·audit SourceRef 5개 | Atlas·HUM·Governance | `ACTIVE` |
| `RWS-0014` | [지원사업 반복 모니터의 누락 복구](./cases/rws-0014-recurring-support-monitor-recovery.md#rws-0014) | KUUS 사업지원 운영 | `MIXED / claim별` | monitor SourceRef 1개 | AI-06, Contract §9 | `ACTIVE` |
| `RWS-0015` | [불완전한 자격사유 아래 증빙·신청 분리](./cases/rws-0015-uncertain-eligibility-evidence-application.md#rws-0015) | KUUS 대표자 행정지원 | `MIXED / claim별` | application SourceRef 1개 | BROWSER/AUTH, Contract §13 | `ACTIVE` |
| `RWS-0016` | [퇴사·보험·지급 상태의 통제 원장](./cases/rws-0016-employee-separation-control-ledger.md#rws-0016) | KUUS 인사·급여·사회보험 | `MIXED / claim별` | workflow·audit SourceRef 2개 | DATA, Contract §3·§13 | `ACTIVE` |
| `RWS-0017` | [금융 원천의 정본 장부 대사와 복구](./cases/rws-0017-finance-source-ledger-reconciliation.md#rws-0017) | KUUS 재무 운영 | `MIXED / claim별` | ledger SourceRef 1개 | DATA, Contract §3·§13 | `ACTIVE` |
| `RWS-0018` | [공유 AX 대시보드의 정본·시안·수용 전환](./cases/rws-0018-shared-ax-dashboard-canonical.md#rws-0018) | Taehwatrans AX 운영 | `MIXED / claim별` | dashboard SourceRef 1개 | DATA/AI-04, Contract §3 | `ACTIVE` |
| `RWS-0019` | [잠긴 정본 workbook의 최소 범위 복구](./cases/rws-0019-canonical-workbook-minimal-repair.md#rws-0019) | Taehwatrans 총무회계 | `MIXED / claim별` | workbook SourceRef 1개 | CODE/DATA, Contract §13·§15 | `ACTIVE` |
| `RWS-0020` | [VAT 대사·연장 승인과 후속 상태 불일치](./cases/rws-0020-vat-reconciliation-state-mismatch.md#rws-0020) | KUUS 법인 세무 | `MIXED / claim별` | tax SourceRef 2개 | BROWSER/DATA, Contract §3·§13 | `ACTIVE` |
| `RWS-0021` | [사회보험 지원월 감사에서 로컬 일정 산출까지](./cases/rws-0021-benefit-audit-to-calendar.md#rws-0021) | KUUS 사회보험 운영 | `MIXED / claim별` | document·calendar SourceRef 1개 | DATA, Contract §13·§15 | `ACTIVE` |
| `RWS-0022` | [업무 발표자료의 렌더·사용자 교정 루프](./cases/rws-0022-executive-deck-render-review-loop.md#rws-0022) | Taehwatrans 경영 커뮤니케이션 | `MIXED / claim별` | deck SourceRef 2개 | AI-04/05, Contract §13 | `ACTIVE` |
| `RWS-0023` | [메인 도메인의 호스팅·DNS·SSL 전환과 잔여 결함](./cases/rws-0023-main-domain-hosting-dns-ssl-cutover.md#rws-0023) | Taehwatrans 웹 운영 | `MIXED / claim별` | cutover SourceRef 1개 | BROWSER/CODE, Contract §13 | `ACTIVE` |
| `RWS-0024` | [측정 신뢰도 교정과 수정 보고서 재발송](./cases/rws-0024-measurement-confidence-correction-and-resend.md#rws-0024) | Taehwatrans 마케팅·경영보고 | `MIXED / claim별` | measurement SourceRef 2개 | AI-04/DATA, Contract §13 | `ACTIVE` |
| `RWS-0025` | [R&D 증거 경계와 제한공개 상담 신청](./cases/rws-0025-rd-evidence-bounded-consultation-request.md#rws-0025) | Taehwatrans R&D | `MIXED / claim별` | restricted SourceRef 1개 | DATA/AUTH, Contract §13 | `ACTIVE` |
| `RWS-0026` | [Taehwa 공통·역할 지식의 권위와 ACL 검증](./cases/rws-0026-taehwa-knowledge-authority-and-acl.md#rws-0026) | Taehwatrans 지식 운영 | `MIXED / claim별` | knowledge SourceRef 2개 | ONT/AUTH, Contract §3 | `ACTIVE` |
| `RWS-0027` | [Taehwa ontology 이관의 의미 보존 재감사](./cases/rws-0027-taehwa-ontology-semantic-migration-audit.md#rws-0027) | Taehwatrans ontology 운영 | `MIXED / claim별` | archived SourceRef 1개 | ONT/DATA, Contract §13·§15 | `ACTIVE` |
| `RWS-0028` | [Grammar-ON 문서·Skill 권위층 재설정](./cases/rws-0028-grammar-on-document-authority-reset.md#rws-0028) | Grammar-ON 제품 문서 | `MIXED / claim별` | documentation SourceRef 1개 | Atlas·Contract·Governance | `ACTIVE` |
| `RWS-0029` | [exact-ID 제한 메일 mutation과 자동화 pause](./cases/rws-0029-exact-id-bounded-mail-mutation-and-pause.md#rws-0029) | Taehwatrans 메일 운영 | `MIXED / claim별` | mail SourceRef 1개 | DATA, Contract §3·§13 | `ACTIVE` |
| `RWS-0030` | [업무지식 Agent의 versioned Scenario Lab](./cases/rws-0030-business-scenario-lab.md#rws-0030) | Taehwatrans 업무지식 평가 | `MIXED / claim별` | archived SourceRef 1개 | AGENT/AI-06, Contract §11 | `ACTIVE` |
| `RWS-0031` | [ERP 매뉴얼 지식의 live A/B 평가와 결손 보강](./cases/rws-0031-erp-manual-live-ab-evaluation.md#rws-0031) | Taehwatrans ERP 지식 운영 | `MIXED / claim별` | A/B SourceRef 1개 | BROWSER/AGENT, Contract §11 | `ACTIVE` |
| `RWS-0032` | [Platform·Pipeline repository 경계 이관](./cases/rws-0032-platform-pipeline-repository-boundary-migration.md#rws-0032) | Grammar-ON 제품 운영 | `MIXED / claim별` | repository SourceRef 1개 | CODE, Contract §11·§13 | `ACTIVE` |

## 5. 현재 coverage gap

### 전문 횡단 분석

- [Browser 자동화 단절 분석](./BROWSER_FRACTURE_ANALYSIS.md) — 8개 실제 workflow의
  tool-call fracture, fault taxonomy, P0/P1/P2 제안과 multi-agent 적용 경계
- [Multi-agent 기법 분석](./MULTI_AGENT_TECHNIQUE_ANALYSIS.md) — context isolation·escape,
  role simulation, manager-worker, critic, map/reduce, handoff의 trigger·비용·금지조건
- [Multi-device Context·Handoff 분석](./MULTI_DEVICE_HANDOFF_ANALYSIS.md) — Device Context
  Envelope, Handoff Packet, 선택적 Canvas 초대, conflict·offline·idempotency 후보

- 모든 프로젝트 source root의 shape 분류와 101개 packet disposition이 끝났다. 기존
  사례에 29개를 병합하고 34개 packet을 22개 신규 사례로 승격했으며, 연구·probe 16개와
  근거 보류 22개는 정식 사례로 만들지 않았다.
- 하나의 업무가 프로젝트 밖 thread·파일·Browser 기록에 이어지는 경우 추가 SourceRef가 필요하다.
- 과거 대화에서 `완료`라고 보고한 작업은 현재 외부 상태를 자동 증명하지 않는다.
- raw transcript와 민감 정보는 사례집에 복제하지 않으므로 원자료 접근 권한이 없으면
  일부 claim은 `INACCESSIBLE`로 남을 수 있다.
- 다중 사용자 동시 편집, 장기 오프라인 복구와 원격 협업은 실제 사례가 부족할 수 있어
  별도 `HYPOTHETICAL-COVERAGE`가 필요하다.
- 첫 wave manifest와 현재 manifest를 분리해 보존한다. lineage가 있는 사례의 parent
  thread·child Agent·dispatch·artifact 관계는 향후 validator의 세부 검증을 확장할 수 있다.
- evidence state, 사례 성숙도와 출처 freshness를 한 상태값으로 합치지 않는 별도 필드가
  필요하다.
