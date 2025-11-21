# Mini-App Orchestration System PRD

**Status**: Approved for Phase 1 (Direct Execution)
**Created**: 2024-11-18
**Priority**: High
**Target Release**: v0.2.0

## Executive Summary

EG-DESK will implement a mini-app orchestration system enabling users to run and manage multiple small applications locally through the spatial canvas interface. Phase 1 focuses on direct process execution via terminal, with Phase 2 optionally adding Docker container support based on user needs.

## Problem Statement

### User Needs
- Developers want to run ecosystem of 10+ microservices locally
- Current tools require manual terminal management across multiple windows
- No unified view of service health, logs, and resources
- Difficult to coordinate inter-service communication

### Current Limitations
- No process management infrastructure in EG-DESK
- Spatial canvas not utilized for system monitoring
- AI agents cannot orchestrate multiple services

## Solution Overview

### Core Concept
Transform EG-DESK's spatial canvas into a visual orchestration platform where mini-apps are represented as interactive nodes that can be started, stopped, monitored, and connected.

### Key Capabilities
1. **Visual Process Management**: Spawn and control processes from spatial canvas
2. **Unified Monitoring**: Single view of all service health and logs
3. **AI Orchestration**: Natural language commands to manage services
4. **Resource Management**: Monitor and limit CPU/memory per service
5. **Template System**: Pre-configured stacks for common use cases

## Technical Design

### Architecture

```
┌─────────────────────────────────────────┐
│           Spatial Canvas UI             │
│  ┌──────┐  ┌──────┐  ┌──────┐         │
│  │ App1 │──│ App2 │──│ App3 │         │
│  └──────┘  └──────┘  └──────┘         │
└────────────┬────────────────────────────┘
             │
┌────────────▼────────────────────────────┐
│      Process Manager Service            │
│  ┌─────────────┐  ┌──────────────┐    │
│  │ Registry    │  │ Monitor      │    │
│  └─────────────┘  └──────────────┘    │
└────────────┬────────────────────────────┘
             │
┌────────────▼────────────────────────────┐
│         Execution Layer                 │
│  ┌─────────────┐  ┌──────────────┐    │
│  │Theia Terminal│  │Electron Process│   │
│  └─────────────┘  └──────────────┘    │
└─────────────────────────────────────────┘
```

### Implementation Phases

#### Phase 1: Direct Process Execution (Current)

**Components**:

1. **ProcessManagerService** (`eg-desk_taehwa/process-manager/`)
   - Spawn processes using Theia task system
   - Track process lifecycle (PID, status, resources)
   - Handle graceful shutdown and restart
   - Emit events for UI updates

2. **MiniAppLauncher** (`eg-desk_taehwa/mini-apps/`)
   - Parse launch configurations (JSON/YAML)
   - Environment variable management
   - Port allocation and conflict resolution
   - Working directory setup

3. **Spatial Canvas Integration**
   - MiniAppNode component (visual representation)
   - Real-time status updates via WebSocket
   - Log streaming with filtering
   - Resource usage graphs (CPU/Memory)

4. **AI Agent Commands**
   - "Start frontend on port 3000"
   - "Show logs from backend service"
   - "Restart all services with debug mode"
   - "Stop services using more than 1GB memory"

**Data Model**:

```typescript
interface MiniApp {
  id: string;
  name: string;
  command: string;
  args?: string[];
  env?: Record<string, string>;
  cwd?: string;
  ports?: number[];
  healthCheck?: {
    type: 'http' | 'tcp' | 'process';
    endpoint?: string;
    interval?: number;
  };
  resources?: {
    maxMemory?: string;  // "512M", "1G"
    maxCpu?: number;     // 0.5 = 50% of one core
  };
  dependencies?: string[]; // Other app IDs
}

interface MiniAppState {
  id: string;
  status: 'stopped' | 'starting' | 'running' | 'stopping' | 'crashed';
  pid?: number;
  startTime?: Date;
  restartCount: number;
  resources: {
    cpuUsage: number;
    memoryUsage: number;
  };
  logs: CircularBuffer<LogEntry>;
}
```

#### Phase 2: Docker Container Support (Future - Optional)

**When to Trigger Phase 2**:
- Users need complete isolation between services
- Database schema isolation requirements
- Security concerns with untrusted code
- Reproducible environments across teams

**Additional Components**:
- DockerService for container lifecycle
- Docker Compose integration
- Volume and network management
- Container registry support

## User Experience

### Spatial Canvas Visualization

```
┌─────────────────────────────────────┐
│ Mini-App: Frontend                  │
│ Status: ● Running (2m 34s)          │
│ ┌───────────────────────────────┐  │
│ │ CPU: ▂▄▆█▄▂ 23%   MEM: 124MB │  │
│ └───────────────────────────────┘  │
│ Ports: 3000 (http)                 │
│ [Logs ▼] [Stop] [Restart]          │
└──────────┬──────────────────────────┘
           │ connects to
           ▼
┌─────────────────────────────────────┐
│ Mini-App: Backend API               │
│ Status: ● Running (2m 34s)          │
│ ┌───────────────────────────────┐  │
│ │ CPU: ▄▂▄█▂▄ 45%   MEM: 256MB │  │
│ └───────────────────────────────┘  │
│ Ports: 8080 (http)                 │
│ [Logs ▼] [Stop] [Restart]          │
└─────────────────────────────────────┘
```

### Launch Configuration Example

```yaml
# mini-apps.yaml
version: '1.0'
apps:
  frontend:
    name: "React Frontend"
    command: "npm"
    args: ["run", "dev"]
    cwd: "./frontend"
    env:
      API_URL: "http://localhost:8080"
    ports: [3000]
    healthCheck:
      type: "http"
      endpoint: "http://localhost:3000"

  backend:
    name: "Node.js API"
    command: "node"
    args: ["server.js"]
    cwd: "./backend"
    env:
      DATABASE_URL: "postgresql://localhost:5432/mydb"
    ports: [8080]
    dependencies: ["database"]

  database:
    name: "PostgreSQL"
    command: "postgres"
    args: ["-D", "./data"]
    ports: [5432]
    resources:
      maxMemory: "1G"
```

### AI Agent Interactions

```
User: "Start my development stack"
AI: Starting development stack...
    ✓ PostgreSQL started (port 5432)
    ✓ Node.js API started (port 8080)
    ✓ React Frontend started (port 3000)
    All services healthy. View in spatial canvas.

User: "Why is the API slow?"
AI: Analyzing Backend API performance...
    - CPU usage: 89% (spike detected)
    - Memory: 487MB/512MB (near limit)
    - Recent logs show database query timeouts
    Recommendation: Increase memory limit or optimize queries

User: "Restart backend with 1GB memory"
AI: Restarting Backend API with 1GB memory limit...
    ✓ Service stopped
    ✓ Configuration updated
    ✓ Service started with new limits
```

## Success Metrics

### Phase 1 Metrics
- Successfully manage 10+ processes simultaneously
- Process startup time < 2 seconds
- Resource monitoring accuracy > 95%
- Zero process zombies/orphans after shutdown
- User satisfaction score > 4.5/5

### User Validation Points
- Can users easily launch multi-service stacks?
- Is spatial canvas visualization intuitive?
- Does AI orchestration save time vs manual terminal?
- Are logs and debugging information accessible?

## Risk Analysis

### Technical Risks

1. **Process Cleanup**
   - Risk: Orphaned processes on crash
   - Mitigation: PID tracking and cleanup on startup

2. **Port Conflicts**
   - Risk: Services fail to start due to port conflicts
   - Mitigation: Port manager with automatic allocation

3. **Resource Exhaustion**
   - Risk: Too many services overwhelm system
   - Mitigation: Resource limits and warnings

### User Experience Risks

1. **Complexity**
   - Risk: System too complex for non-technical users
   - Mitigation: Templates and AI guidance

2. **Performance**
   - Risk: UI lag with many services
   - Mitigation: Virtual scrolling, lazy loading

## Implementation Timeline

### Week 1-2: Core Infrastructure
- [ ] ProcessManagerService implementation
- [ ] Theia task system integration
- [ ] Basic process lifecycle management
- [ ] Event system for UI updates

### Week 3-4: Spatial Canvas Integration
- [ ] MiniAppNode component
- [ ] Real-time status updates
- [ ] Log viewer implementation
- [ ] Resource monitoring graphs

### Week 5-6: AI Integration & Polish
- [ ] AI command processing
- [ ] Launch templates
- [ ] Error handling and recovery
- [ ] Documentation and examples

## Future Considerations

### Phase 2 Decision Criteria
Implement Docker support if:
- >30% of users request container isolation
- Security requirements demand it
- Enterprise customers require it
- Performance overhead acceptable (<10% for 10 services)

### Potential Extensions
- Service mesh visualization
- Distributed tracing integration
- Performance profiling tools
- Cloud deployment from local setup
- Service marketplace for templates

## References

**Research Documents**:
- Strategic Analysis: `subagent_reports/20241118_0045_docker-integration-pm.md`
- User Requirements: Ecosystem of small apps with optimization focus
- Technology Stack: Uses existing Theia + Electron capabilities

**Related Features**:
- Spatial Canvas (`ideas/confirmed/EG-DESK_Spatial_Canvas_UX_Solutions.md`)
- Terminal Integration (`ideas/confirmed/AI_TERMINAL_CHAT_INTEGRATION.md`)
- Browser Automation (complementary capability)

---

*This PRD prioritizes simplicity and fast implementation while maintaining extensibility for future Docker integration. The phased approach allows validation with users before adding complexity.*