# EG-DESK 문서

EG-DESK 프로젝트의 공식 문서입니다.

---

## 현재 기준 문서

EG-DESK의 현재 구현 기준은 **Firefox shell**입니다.

- 제품/기술 전략 기준: [`../ideas/confirmed/FIREFOX_SHELL_STRATEGY.md`](../ideas/confirmed/FIREFOX_SHELL_STRATEGY.md)
- 개발 로드맵 기준: [`../ideas/confirmed/FIREFOX_SHELL_ROADMAP.md`](../ideas/confirmed/FIREFOX_SHELL_ROADMAP.md)
- 제품 비전/개발 투두 living index: [`../ideas/confirmed/EGDESK_PRODUCT_VISION_AND_DEV_TODO.md`](../ideas/confirmed/EGDESK_PRODUCT_VISION_AND_DEV_TODO.md)
- 현재 구현 위치: [`../apps/firefox-ui-demo/`](../apps/firefox-ui-demo/)
- Desk/Agenda/Card 런타임 모델: [`../apps/firefox-ui-demo/docs/DESK_AGENDA_CARD_RUNTIME_MODEL.md`](../apps/firefox-ui-demo/docs/DESK_AGENDA_CARD_RUNTIME_MODEL.md)
- Chat 디자인 문법: [`../apps/firefox-ui-demo/docs/CHAT_DESIGN_GRAMMAR_V1.md`](../apps/firefox-ui-demo/docs/CHAT_DESIGN_GRAMMAR_V1.md)
- AI 캔버스 주석 레이어: [`../apps/firefox-ui-demo/docs/AI_CANVAS_ANNOTATION_LAYER.md`](../apps/firefox-ui-demo/docs/AI_CANVAS_ANNOTATION_LAYER.md)
- 캔버스 Run Playback 모델: [`../apps/firefox-ui-demo/docs/CANVAS_RUN_PLAYBACK_MODEL.md`](../apps/firefox-ui-demo/docs/CANVAS_RUN_PLAYBACK_MODEL.md)
- Viewport 레이아웃/인터랙션 모델: [`../apps/firefox-ui-demo/docs/VIEWPORT_LAYOUT_INTERACTION_MODEL.md`](../apps/firefox-ui-demo/docs/VIEWPORT_LAYOUT_INTERACTION_MODEL.md)

백서는 비전과 대외 설명을 위한 문서입니다. 구현 경로가 Electron/Playwright 전제로 쓰인 오래된 문단은 Firefox shell 기준으로 읽어야 합니다.

---

## 문서 구조

### 백서 (Whitepapers)

**Production 백서** - 현재 역량
📄 [`production/EG-DESK 백서 - Production_v8_한글.md`](production/EG-DESK%20백서%20-%20Production_v8_한글.md)

대상: 경영진, 기업 의사결정자, 투자자
내용: 현재 구현된 기능, 기술 스택, 비즈니스 모델, 시장 기회
상태: Firefox shell 전환 주석 추가됨

**Vision 백서** - 미래 방향성
📄 [`vision/EG-DESK 백서 - Vision_v1.md`](vision/EG-DESK%20백서%20-%20Vision_v1.md)

대상: 전략적 파트너, 투자자, 혁신 담당자
내용: 2025-2026 로드맵, 앰비언트 AI, 공간 캔버스, Agenda, 관찰 학습
상태: 장기 비전은 유효하나 Electron 구현 예시는 과거 전제

---

## 문서 선택 가이드

**"지금 무엇을 할 수 있나요?"** → Production 백서
**"앞으로 어떻게 발전하나요?"** → Vision 백서
**"지금 어디를 개발해야 하나요?"** → Product Vision and Development Todo / Firefox Shell Roadmap

**투자 검토 중이신가요?**
→ Production 백서 (현재 역량) + Vision 백서 (성장 잠재력)

**기술 검토 중이신가요?**
→ Production 백서 섹션 2-3 (기술 아키텍처)
→ Vision 백서 섹션 2-5 (미래 기술 및 타당성)

**비즈니스 파트너십 검토 중이신가요?**
→ Production 백서 섹션 4-5 (경쟁 우위, 비즈니스 모델)
→ Vision 백서 섹션 8 (파트너십 기회)

---

## 폴더 구조

```
docs/
├── README.md                         # 이 문서
├── production/                       # Production 백서 및 관련 문서
│   └── EG-DESK 백서 - Production_v8_한글.md
├── vision/                           # Vision 백서 및 관련 문서
│   └── EG-DESK 백서 - Vision_v1.md
├── references/                       # 외부/보조 조사 문서
├── superpowers/                      # 세부 스펙/계획
└── EG-DESK_Whitepaper.md             # 영문 백서 (업데이트 필요)
```

---

## 교육 자료

**11월 29일 (토요일) 교육 세션용**

교육 자료는 `edu/` 폴더에 별도로 관리됩니다:
- 환경 설정 가이드
- 첫 번째 자동화 스크립트
- 실습 프로젝트

---

## 버전 관리

**현재 문서 기준**: Firefox shell pivot 이후 문서는 `ideas/confirmed/FIREFOX_SHELL_STRATEGY.md`와 `ideas/confirmed/FIREFOX_SHELL_ROADMAP.md`를 우선합니다.

**버전 명명 규칙**:
- Production: `EG-DESK 백서 - Production_v[N].md`
- Vision: `EG-DESK 백서 - Vision_v[N].md`

**업데이트 주기**:
- Production 백서: 분기별 (기능 안정화에 따라)
- Vision 백서: 연례 (로드맵 진행에 따라)

---

## 문의

**Production 관련**: contact@egdesk.com
**Vision 및 파트너십**: vision@egdesk.com
**일반 문의**: www.egdesk.com

---

*최종 업데이트: 2026년 5월*
