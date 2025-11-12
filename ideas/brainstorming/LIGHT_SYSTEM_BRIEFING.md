# LIGHT System Briefing

## Overview

**LIGHT** (Long-context Interactive Guided Human-like Thinking)는 LLM의 장기 대화 메모리 능력을 향상시키기 위한 프레임워크입니다. 인간의 인지과학 연구에서 영감을 받아 설계되었으며, 100K~10M 토큰의 긴 대화에서도 효과적으로 작동합니다.

## 핵심 개념

### LIGHT는 모델이 아닌 프레임워크
- 기존 LLM을 **래핑(wrapping)**하는 외부 메모리 관리 시스템
- GPT-4, Claude, Gemini, Llama 등 모든 LLM에 적용 가능
- API 기반 LLM에도 적용 가능 (OpenAI API, Anthropic API 등)

### Multi-turn Conversation + Dynamic Prompt Editing
```
매 턴마다:
1. 사용자 입력 수신
2. 관련 메모리를 동적으로 검색 및 조합
3. 프롬프트 재구성 (relevant memories + important facts + recent context)
4. LLM API 호출 (stateless)
5. 응답 생성 후 메모리 업데이트
```

## 3가지 메모리 시스템

### 1. Episodic Memory (에피소드 메모리)
- **목적**: 장기 메모리, 과거 대화의 특정 경험과 맥락 저장
- **구현**: Vector Database (임베딩 기반 검색)
- **사용**: 사용자 질문과 관련된 과거 대화 검색 (top-k retrieval)
- **예시**: "3개월 전에 얘기했던 프로젝트 마감일이 언제였지?"

### 2. Scratchpad (스크래치패드)
- **목적**: 중요한 사실(salient facts) 축적
- **구현**: 구조화된 텍스트 저장소
- **내용**:
  - 주요 엔티티 & 관계
  - 중요 날짜
  - 사용자 선호도
  - 프로세스 & 워크플로우
  - 지속적인 지시사항
- **예시**: "사용자: 26살, New Gary 거주, 파트너 Wendy"

### 3. Working Memory (작업 메모리)
- **목적**: 단기 메모리, 최근 대화 맥락 유지
- **구현**: 최근 N턴의 대화 버퍼 (일반적으로 10턴)
- **사용**: 즉각적인 대화 흐름 파악
- **예시**: 바로 직전 턴에서 언급한 내용 참조

## 작동 방식

### 입력 단계
```python
def prepare_context(user_input):
    # 1. Vector DB에서 관련 과거 대화 검색
    relevant_memories = vector_db.search(user_input, top_k=15)

    # 2. Scratchpad에서 중요 정보 가져오기
    important_facts = scratchpad.get_all()

    # 3. Working Memory (최근 N턴)
    recent_turns = conversation_history[-10:]

    # 4. 프롬프트 조합
    prompt = f"""
    === Important Facts (Scratchpad) ===
    {important_facts}

    === Relevant Past Conversations ===
    {relevant_memories}

    === Recent Conversation ===
    {recent_turns}

    === Current User Input ===
    {user_input}
    """

    return prompt
```

### 출력 단계
```python
def update_memories(user_input, llm_response):
    # 1. Scratchpad 업데이트 (중요 정보 추출)
    new_facts = extract_salient_facts(llm_response)
    scratchpad.update(new_facts)

    # 2. Vector DB에 새로운 대화 저장
    vector_db.add_conversation(user_input, llm_response)

    # 3. Working Memory 업데이트
    conversation_history.append({
        'user': user_input,
        'assistant': llm_response
    })
```

## 성능 개선 결과

### 전체 성능
- 기본 LLM 대비 **3.5%~12.69%** 평균 성능 향상
- 긴 대화일수록 더 큰 성능 향상

### 작업별 성능 향상
- **요약 (Summarization)**: +160.6%
- **정보 추출 (Information Extraction)**: +56.7%
- **시간적 추론 (Temporal Reasoning)**: +56.3%
- **선호도 따르기 (Preference Following)**: +76.5%
- **지시사항 따르기 (Instruction Following)**: +39.5%
- **다단계 추론 (Multi-hop Reasoning)**: +27.2%

### 대화 길이별 성능
- **100K 토큰**: 모든 컴포넌트가 유용
- **500K 토큰**: 모든 컴포넌트 필수
- **1M 토큰**: Retrieval, Scratchpad, Noise filtering 중요
- **10M 토큰**: 모든 컴포넌트 필수 (제거 시 큰 성능 저하)

## 주요 장점

### 1. Context Window 한계 극복
- 10M 토큰 대화에서도 관련 부분만 선택적으로 사용
- LLM의 물리적 context window 제약을 우회

### 2. 노이즈 감소
- 전체 대화를 다 넣으면 중요 정보가 묻힘
- 관련성 높은 정보만 선택적으로 제공

### 3. 비용 절감
- 매번 전체 대화 히스토리를 LLM에 전달하지 않음
- Top-k retrieval로 필요한 부분만 사용

### 4. API 호환성
- LLM 모델을 수정하거나 재학습할 필요 없음
- 상용 API (OpenAI, Anthropic, Google) 그대로 사용 가능

## 기술 스택

### 필수 컴포넌트
- **Vector Database**: Pinecone, Weaviate, ChromaDB, FAISS 등
- **Embedding Model**: OpenAI embeddings, sentence-transformers 등
- **LLM API**: OpenAI, Anthropic, Google, 또는 로컬 모델
- **Storage**: 대화 히스토리 및 Scratchpad 저장용

### Retrieval 설정
- **K 값 (Top-k)**: 15가 최적 (논문 결과)
- **Retriever**: Dense retriever가 기본, Sparse retriever (SPLADE)도 사용 가능
- **Noise Filtering**: 검색 결과 필터링으로 품질 향상

## 한계 및 고려사항

### 1. 추가 인프라 필요
- Vector DB 운영 비용
- Embedding 생성 비용
- Storage 비용

### 2. Latency 증가
- 매 턴마다 retrieval 수행
- Scratchpad 업데이트 시간
- 전체 응답 시간 약간 증가

### 3. Scratchpad 관리의 복잡성
- 무엇을 "중요한 사실"로 추출할지 결정 필요
- 잘못된 정보 축적 시 지속적 오류 발생 가능
- 주기적인 검증 및 정리 필요

### 4. Cold Start 문제
- 대화 초반에는 메모리가 부족
- 100K 이하에서는 전체 컨텍스트가 더 나을 수 있음

## 실제 적용 사례

### 적합한 시나리오
- 장기간 지속되는 고객 서비스 대화
- 프로젝트 관리 어시스턴트 (수개월간 진행 추적)
- 개인 비서 (사용자 선호도 및 이력 기억)
- 교육 튜터 (학습 진도 및 취약점 추적)
- 의료 상담 (환자 병력 및 증상 추적)

### 부적합한 시나리오
- 단발성 짧은 질문 (context window로 충분)
- 실시간 초저지연 요구사항 (retrieval overhead)
- 극도로 민감한 정보 (외부 DB 저장 우려)

## 벤치마크: BEAM

논문에서 함께 제안한 평가 벤치마크:
- **100개 대화**: 100K ~ 10M 토큰
- **2,000개 질문**: 10가지 메모리 능력 평가
- **10가지 메모리 능력**:
  1. Information Extraction
  2. Summarization
  3. Multi-hop Reasoning
  4. Temporal Reasoning
  5. Instruction Following
  6. Preference Following
  7. Contradiction Resolution
  8. Knowledge Update
  9. Event Ordering
  10. Abstention (모르면 모른다고 답하기)

## 참고 문헌

- 원본 논문: arXiv 2510.27246v1
- 제목: "BEAM: Benchmarking Long-Context Memory in LLMs with LIGHT Framework"
- 연구진: 인간 인지과학 기반 메모리 시스템 설계
