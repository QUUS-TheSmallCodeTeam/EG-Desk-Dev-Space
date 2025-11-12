# LIGHT를 Agent System으로 구축하기

## 개요

LIGHT 프레임워크를 Agent System 아키텍처로 구현하는 방법에 대한 브리핑입니다. LIGHT의 메모리 관리 기능을 Agent Swarm과 결합하여 더 강력한 시스템을 구축할 수 있습니다.

## LIGHT vs Agent Swarm 비교

### Agent Swarm (전통적)
```
사용자 입력
    ↓
[Router Agent] → "어떤 agent에게 보낼까?"
    ↓
[Agent A] [Agent B] [Agent C] ← 각자 다른 역할/툴
    ↓
[Coordinator] → 결과 통합
```
- **여러 LLM 호출** (병렬/순차)
- **역할 분담** (코딩/검색/분석 등)
- **Tool execution** 중심
- **단기 메모리**: 주로 현재 세션만 기억

### LIGHT Framework
```
사용자 입력
    ↓
[메모리 검색 & 조합] ← Vector DB, Scratchpad, Working Memory
    ↓
[단일 LLM 호출] ← 모든 메모리를 프롬프트에 포함
    ↓
[메모리 업데이트]
```
- **단일 LLM 호출** (하지만 rich context)
- **메모리 관리** (장기/단기/중요 정보)
- **Context control** 중심
- **장기 메모리**: 수개월간의 대화 추적

### 비유
- **Agent Swarm**: 여러 전문가가 회의하는 팀
- **LIGHT**: 한 명의 전문가 + 잘 정리된 노트/데이터베이스

## LIGHT + Agent System 통합 아키텍처

### 접근법 1: Memory-Augmented Agent Swarm

각 에이전트가 LIGHT 메모리 시스템을 공유하는 구조

```
사용자 입력
    ↓
[Shared Memory Layer]
├─ Vector DB (전체 대화 히스토리)
├─ Global Scratchpad (공통 중요 정보)
└─ Agent-specific Scratchpads (에이전트별 전문 정보)
    ↓
[Router Agent + LIGHT memory]
    ↓
┌─────────┬─────────┬─────────┐
│ Agent A │ Agent B │ Agent C │
│+ Memory │+ Memory │+ Memory │
└─────────┴─────────┴─────────┘
    ↓
[Coordinator + LIGHT memory]
    ↓
[Memory Update]
```

#### 장점
- 각 에이전트가 전체 컨텍스트 인지
- 에이전트 간 정보 공유 자동화
- 장기 프로젝트 추적 가능

#### 구현 예시
```python
class LIGHTAgent:
    def __init__(self, role, shared_memory, personal_scratchpad):
        self.role = role
        self.shared_memory = shared_memory  # Vector DB + Global Scratchpad
        self.personal_scratchpad = personal_scratchpad

    def process(self, task):
        # 1. Shared memory에서 관련 정보 검색
        relevant_context = self.shared_memory.retrieve(task)

        # 2. Personal scratchpad (전문 지식)
        specialized_facts = self.personal_scratchpad.get_all()

        # 3. 프롬프트 구성
        prompt = f"""
        Role: {self.role}

        Shared Context:
        {relevant_context}

        Specialized Knowledge:
        {specialized_facts}

        Task: {task}
        """

        # 4. LLM 호출
        response = llm_api.call(prompt)

        # 5. 메모리 업데이트
        self.shared_memory.update(task, response)
        self.personal_scratchpad.update_if_important(response)

        return response
```

### 접근법 2: Hierarchical LIGHT System

계층적 에이전트 구조에서 각 레벨이 LIGHT 메모리 사용

```
[Master Agent + Strategic Memory]
    ↓
[팀별 Coordinator + Team Memory]
    ↓
[Individual Agents + Task Memory]
```

#### 메모리 계층
1. **Strategic Memory** (Master)
   - 프로젝트 전체 목표
   - 주요 결정사항 히스토리
   - 장기 계획

2. **Team Memory** (Coordinator)
   - 팀별 작업 진행상황
   - 팀 내 의존성
   - 팀별 베스트 프랙티스

3. **Task Memory** (Individual)
   - 개별 작업 세부사항
   - 기술적 구현 디테일
   - 즉각적인 컨텍스트

### 접근법 3: LIGHT as Orchestration Layer

LIGHT가 전체 Agent Swarm을 조율하는 상위 레이어

```
사용자 입력
    ↓
[LIGHT Memory System]
├─ 과거 유사 태스크 검색
├─ 사용자 선호도 확인
└─ 프로젝트 컨텍스트 로드
    ↓
[Dynamic Agent Selection]
"이 태스크는 과거에 Agent B가 잘 처리했고,
 사용자는 상세한 설명을 선호함"
    ↓
[Selected Agent(s) with Context]
    ↓
[Result + Memory Update]
```

#### 장점
- 과거 경험 기반 에이전트 선택
- 사용자 선호도 학습
- 실패/성공 패턴 추적

## 실제 구현 아키텍처

### 시스템 컴포넌트

```python
# 1. Shared Memory Infrastructure
class SharedMemorySystem:
    def __init__(self):
        self.vector_db = VectorDatabase()
        self.global_scratchpad = GlobalScratchpad()
        self.conversation_history = ConversationBuffer()

    def retrieve_context(self, query, agent_role=None):
        """에이전트 역할에 맞는 컨텍스트 검색"""
        # Vector DB에서 관련 대화 검색
        relevant_convs = self.vector_db.search(query, top_k=15)

        # 에이전트 역할 관련 필터링
        if agent_role:
            relevant_convs = self._filter_by_role(relevant_convs, agent_role)

        # Global scratchpad 정보
        important_facts = self.global_scratchpad.get_relevant(query)

        # 최근 대화
        recent = self.conversation_history.get_recent(n=10)

        return {
            'relevant_history': relevant_convs,
            'important_facts': important_facts,
            'recent_context': recent
        }

# 2. Memory-Aware Agent
class MemoryAwareAgent:
    def __init__(self, role, tools, memory_system):
        self.role = role
        self.tools = tools
        self.memory = memory_system
        self.personal_knowledge = PersonalScratchpad(role)

    async def execute(self, task):
        # 메모리에서 컨텍스트 로드
        context = self.memory.retrieve_context(task, agent_role=self.role)

        # 개인 지식 로드
        specialized = self.personal_knowledge.get_all()

        # 프롬프트 구성
        prompt = self._build_prompt(task, context, specialized)

        # LLM 실행
        result = await self._llm_call(prompt)

        # 메모리 업데이트
        await self._update_memories(task, result)

        return result

    async def _update_memories(self, task, result):
        # 공유 메모리 업데이트
        self.memory.vector_db.add(task, result, agent=self.role)

        # 중요 정보 추출 및 저장
        important_info = await self._extract_important_info(result)
        if important_info:
            self.memory.global_scratchpad.update(important_info)
            self.personal_knowledge.update(important_info)

# 3. Memory-Aware Orchestrator
class LIGHTOrchestrator:
    def __init__(self, agents, memory_system):
        self.agents = agents
        self.memory = memory_system

    async def process_request(self, user_input):
        # 1. 메모리에서 컨텍스트 검색
        context = self.memory.retrieve_context(user_input)

        # 2. 과거 유사 태스크 분석
        similar_tasks = self._find_similar_tasks(user_input, context)

        # 3. 최적 에이전트 선택 (과거 성공 기반)
        selected_agents = self._select_agents(user_input, similar_tasks)

        # 4. 에이전트 실행
        results = await self._execute_agents(selected_agents, user_input, context)

        # 5. 결과 통합
        final_result = self._synthesize_results(results)

        # 6. 메모리 업데이트
        await self._update_orchestration_memory(
            user_input,
            selected_agents,
            final_result
        )

        return final_result

    def _select_agents(self, task, similar_tasks):
        """과거 성공 패턴 기반 에이전트 선택"""
        # Scratchpad에서 "이런 태스크에는 이 에이전트 조합이 효과적"
        best_combinations = self.memory.global_scratchpad.get(
            'successful_agent_combinations'
        )

        # 유사 태스크에서 성공한 에이전트 찾기
        for similar in similar_tasks:
            if similar['success']:
                return similar['agents_used']

        # 기본 라우팅 로직
        return self._default_routing(task)
```

### 데이터 구조

#### Global Scratchpad 예시
```json
{
  "user_profile": {
    "name": "John",
    "preferences": {
      "code_style": "verbose with comments",
      "explanation_level": "detailed",
      "favorite_frameworks": ["React", "FastAPI"]
    }
  },
  "project_context": {
    "current_projects": [
      {
        "name": "E-commerce Platform",
        "stack": "React + FastAPI + PostgreSQL",
        "status": "In Development",
        "key_decisions": [
          "Using JWT for auth",
          "PostgreSQL over MongoDB for transactions"
        ]
      }
    ]
  },
  "successful_agent_combinations": {
    "bug_fixing": ["code_analyzer", "debugger", "tester"],
    "new_feature": ["architect", "developer", "reviewer", "tester"],
    "refactoring": ["code_analyzer", "architect", "developer"]
  },
  "known_issues": [
    "Database connection pool exhaustion under high load",
    "JWT refresh token race condition"
  ],
  "important_dates": {
    "project_deadline": "2025-12-31",
    "next_sprint_review": "2025-11-15"
  }
}
```

#### Agent Personal Scratchpad 예시 (Developer Agent)
```json
{
  "coding_patterns_used": {
    "dependency_injection": "Applied in user service",
    "repository_pattern": "All data access layers",
    "factory_pattern": "Payment processor creation"
  },
  "recent_bugs_fixed": [
    {
      "issue": "Memory leak in WebSocket handler",
      "solution": "Added proper cleanup in __aexit__",
      "date": "2025-11-05"
    }
  ],
  "code_conventions": {
    "file_naming": "snake_case",
    "class_naming": "PascalCase",
    "max_line_length": 100,
    "docstring_style": "Google"
  },
  "dependencies_added": {
    "pydantic": "2.5.0",
    "httpx": "0.25.0"
  }
}
```

## 구현 예시: Multi-Agent Task Execution

```python
async def example_multi_agent_task():
    # 초기화
    memory = SharedMemorySystem()

    # 에이전트 생성
    architect = MemoryAwareAgent("architect", tools=[], memory=memory)
    developer = MemoryAwareAgent("developer", tools=['write_code'], memory=memory)
    reviewer = MemoryAwareAgent("reviewer", tools=['analyze_code'], memory=memory)

    # Orchestrator
    orchestrator = LIGHTOrchestrator(
        agents=[architect, developer, reviewer],
        memory=memory
    )

    # 사용자 요청
    user_request = "Add user authentication to the e-commerce platform"

    # 처리
    result = await orchestrator.process_request(user_request)

    # 내부 흐름:
    # 1. Memory에서 "user authentication" 관련 과거 대화 검색
    #    → "3개월 전에 JWT 방식으로 결정했음"
    # 2. Project context 로드
    #    → "FastAPI + PostgreSQL 사용 중"
    # 3. 유사 태스크 검색
    #    → "인증 추가는 architect → developer → reviewer 순서가 효과적"
    # 4. Architect 실행
    #    - 과거 결정사항 인지 (JWT)
    #    - 현재 스택 인지 (FastAPI)
    #    - 설계 제안
    # 5. Developer 실행
    #    - Architect의 설계 + 과거 코드 패턴 사용
    #    - 구현
    # 6. Reviewer 실행
    #    - 과거 버그 패턴 체크
    #    - 코드 리뷰
    # 7. Memory 업데이트
    #    - "인증 기능 추가 완료" → Global Scratchpad
    #    - 구현 세부사항 → Developer Personal Scratchpad
```

## 실전 적용 시나리오

### 시나리오 1: 장기 소프트웨어 프로젝트

```python
# 6개월간 진행되는 프로젝트
orchestrator = LIGHTOrchestrator(
    agents={
        'pm': ProjectManagerAgent(memory),
        'architect': ArchitectAgent(memory),
        'frontend_dev': FrontendAgent(memory),
        'backend_dev': BackendAgent(memory),
        'qa': QAAgent(memory),
        'devops': DevOpsAgent(memory)
    },
    memory=memory
)

# Week 1
await orchestrator.process("Let's plan an e-commerce platform")
# → PM creates roadmap, stored in memory

# Week 5
await orchestrator.process("Implement user authentication")
# → Remembers architecture decisions from Week 1
# → Knows current tech stack
# → Backend dev uses established patterns

# Week 20
await orchestrator.process("Why is checkout slow?")
# → Remembers checkout implementation from Week 10
# → QA recalls similar issue from Week 15
# → DevOps checks infrastructure decisions from Week 3
```

### 시나리오 2: 개인 비서 에이전트

```python
agents = {
    'scheduler': SchedulerAgent(memory),
    'email': EmailAgent(memory),
    'research': ResearchAgent(memory),
    'task_manager': TaskManagerAgent(memory)
}

# Day 1
"Schedule a meeting with John next week"
# → Scratchpad: John's availability preferences stored

# Day 30
"Email John about the project"
# → Remembers John from Day 1
# → Knows project context
# → Uses user's email writing style

# Day 60
"What did John and I discuss last time?"
# → Vector DB retrieves Day 1 and Day 30 interactions
# → Synthesizes complete history
```

## 성능 최적화

### 1. Selective Memory Loading
```python
def retrieve_context(self, query, agent_role):
    # 에이전트 역할에 따라 다른 메모리 로드
    if agent_role == 'frontend_dev':
        # UI/UX 관련 메모리만
        return self.vector_db.search(
            query,
            filter={'category': ['ui', 'ux', 'frontend']}
        )
    elif agent_role == 'devops':
        # Infrastructure 관련만
        return self.vector_db.search(
            query,
            filter={'category': ['infrastructure', 'deployment']}
        )
```

### 2. Cached Scratchpad
```python
class CachedScratchpad:
    def __init__(self):
        self._cache = {}
        self._cache_ttl = 300  # 5 minutes

    def get_all(self):
        if 'all_facts' in self._cache:
            if time.time() - self._cache['timestamp'] < self._cache_ttl:
                return self._cache['all_facts']

        # Cache miss - load from DB
        facts = self._load_from_db()
        self._cache = {
            'all_facts': facts,
            'timestamp': time.time()
        }
        return facts
```

### 3. Async Parallel Memory Updates
```python
async def update_memories(self, task, result):
    # 병렬로 메모리 업데이트
    await asyncio.gather(
        self.vector_db.add(task, result),
        self.scratchpad.update(extract_facts(result)),
        self.conversation_history.append(task, result)
    )
```

## 비용 분석

### 전통적 Agent Swarm
```
사용자 요청 1개 → 5개 에이전트 호출
각 호출: 2K 토큰 입력 + 500 토큰 출력
총: (2K + 500) × 5 = 12.5K 토큰
```

### LIGHT Agent System
```
사용자 요청 1개 → 3개 에이전트 호출 (더 똑똑한 라우팅)
각 호출: 5K 토큰 입력 (메모리 포함) + 500 토큰 출력
총: (5K + 500) × 3 = 16.5K 토큰

추가 비용:
- Vector DB 검색: 3회 × $0.0001 = $0.0003
- Embedding 생성: 1회 × $0.0001 = $0.0001
```

### 장기적 비용 절감
- **불필요한 재작업 감소**: 과거 결정사항 기억 → 중복 논의 방지
- **더 적은 에이전트 호출**: 컨텍스트 인지로 효율적 라우팅
- **오류 감소**: 과거 실수 학습 → 디버깅 비용 감소

## 구현 로드맵

### Phase 1: 기본 LIGHT 구현 (2-3주)
- [ ] Vector DB 선택 및 설정 (ChromaDB/Pinecone)
- [ ] Scratchpad 구조 설계
- [ ] Working Memory 버퍼 구현
- [ ] 기본 retrieve + update 로직

### Phase 2: Single Agent Integration (1-2주)
- [ ] 단일 에이전트에 LIGHT 메모리 통합
- [ ] 프롬프트 템플릿 최적화
- [ ] 성능 측정 및 비교

### Phase 3: Multi-Agent System (2-3주)
- [ ] Shared Memory Infrastructure
- [ ] Agent-specific Scratchpads
- [ ] Memory-aware Orchestrator
- [ ] Agent 간 메모리 동기화

### Phase 4: 최적화 및 고도화 (2-4주)
- [ ] Caching 구현
- [ ] Async processing
- [ ] Noise filtering
- [ ] 성능 튜닝 (top-k, embedding model 등)

### Phase 5: Production Ready (2-3주)
- [ ] 모니터링 및 로깅
- [ ] Error handling
- [ ] Backup 및 복구
- [ ] 보안 강화

## 핵심 이점 요약

### LIGHT만 사용 시
- ✅ 장기 메모리
- ✅ 컨텍스트 인지
- ❌ 단일 에이전트 한계

### Agent Swarm만 사용 시
- ✅ 전문화된 태스크 처리
- ✅ 병렬 실행
- ❌ 단기 메모리만

### LIGHT + Agent System
- ✅ 장기 메모리
- ✅ 컨텍스트 인지
- ✅ 전문화된 태스크 처리
- ✅ 병렬 실행
- ✅ 과거 경험 학습
- ✅ 사용자 선호도 추적

**결론**: LIGHT와 Agent System을 결합하면 각각의 장점을 모두 활용할 수 있습니다.
