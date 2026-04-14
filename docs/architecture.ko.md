# Vela Union — 시스템 아키텍처

**Language**: [English](architecture.md) · 한국어

본 문서는 Vela Union의 전체 시스템 구조를 여러 관점에서 도식화한다. 각 다이어그램은 특정 질문에 답하도록 설계됐다.

_마지막 업데이트: 2026-04-14._
_주요 변경: **프로젝트 자동 부트스트랩 (VELA-43~46)**, **Vela Status 프로젝트 상세 탭 + 액션 버튼 (VELA-49~51)**, **`/vela` 슬래시 커맨드 (VELA-39)**, gbrain 장기 기억 레이어 (§16), Paperclip 에이전트 오케스트레이션 (§14), 플러그인 워커 환경 주입 체인 (§8.1), PageIndex 로컬 Claude CLI 백엔드 (§15)._
_Recent feature work (merged): gbrain 5번째 시스템 통합 (VELA-34, 35), 프로젝트 생성 시 자동 등록 + Graphify/gbrain/PageIndex 부트스트랩 (VELA-43~46), `/vela` 전역 skill (VELA-39), Paperclip 프로젝트 detailTab with manual action buttons (VELA-49~51), CTO v2 재생성 with empty-inbox exit safeguard (VELA-48)._

---

## 1. 최상위 시스템 개요

"Vela Union이 무엇인가?" — 한눈에 보는 구조.

```
                            ┌─────────────────────────┐
                            │         사용자           │
                            │   (로컬 워크스테이션)     │
                            └───────────┬─────────────┘
                                        │
                    vela CLI / Claude Code 세션 / MCP 호출
                                        │
                 ┌──────────────────────┼──────────────────────┐
                 ▼                      ▼                      ▼
        ┌─────────────────┐   ┌──────────────────┐   ┌──────────────────┐
        │   vela CLI      │   │   Claude Code    │   │   Paperclip      │
        │  (컨트롤 플레인) │   │  (실행 주체)      │   │  (조직 & 이벤트)  │
        └────────┬────────┘   └─────────┬────────┘   └─────────┬────────┘
                 │                      │                      │
                 │                      │  stdio MCP           │
                 │                      ▼                      │
                 │            ┌──────────────────┐             │
                 │            │   MCP Gateway    │             │
                 │            │   (18+ tools)    │             │
                 │            │  doc.* graph.*   │             │
                 │            │  gstack.* vela.* │             │
                 │            │  knowledge.*     │             │
                 │            └────────┬─────────┘             │
                 │                     │                        │
                 │       ┌──────┬──────┼──────────────┐        │
                 │       ▼      ▼      ▼              ▼        │
                 │ ┌────────┐┌──────┐┌──────────┐┌──────────┐ │
                 │ │Graphify││gbrain││PageIndex ││gstack CLI│ │
                 │ │(구조)  ││(기억)││(문서이해) ││(전문스킬) │ │
                 │ └────────┘└──────┘└──────────┘└──────────┘ │
                 │                                              │
                 │                                              │
                 └──────────────────┬───────────────────────────┘
                                    │
                                    ▼
                         ┌──────────────────────┐
                         │   ~/.vela/ (상태)    │
                         │  projects.json       │
                         │  goals.json          │
                         │  graphify/           │
                         │  decisions/          │
                         │  logs/vela.jsonl     │
                         │  build-queue.jsonl   │
                         └──────────────────────┘
```

**읽는 법.** 사용자는 CLI, Claude Code 세션, 혹은 Paperclip 대시보드 중 어느 것을 통해서도 시스템에 진입한다. 세 경로 모두 동일한 `~/.vela/` 상태와 동일한 MCP 게이트웨이에 말을 건다. 즉 한 명령을 어디서 시작해도 전체 시스템이 일관되게 반응한다.

---

## 2. 모노레포 패키지 구조

"어디에 무엇이 있는가?" — 개발자 관점.

```
vela-union/
│
├── packages/
│   │
│   ├── shared/                          ◀── 공통 타입, 로거, 레지스트리, 피드백
│   │   ├── registry.ts                     (projects.json CRUD)
│   │   ├── goals.ts                        (goals.json CRUD)
│   │   ├── feedback.ts                     (결정 추출 + 크로스 프로젝트)
│   │   ├── logger.ts                       (구조화 JSONL 로거)
│   │   └── log-reader.ts                   (vela logs 필터 엔진)
│   │
│   ├── paperclip-plugin/                ◀── Paperclip definePlugin()
│   │   ├── plugin.ts                       (이벤트, 도구, 데이터 프로바이더)
│   │   ├── briefing.ts                     (Briefing Pack 생성기)
│   │   ├── dispatch.ts                     (프롬프트 조립)
│   │   ├── startup-scanner.ts              (부팅 시 그래프 스캔)
│   │   └── manifest.ts                     (플러그인 메타데이터)
│   │
│   ├── gstack-adapter/                  ◀── Claude CLI spawn + 스킬 실행
│   │   └── adapter.ts                      (checkAvailability, executeSkill,
│   │                                        executeGoal, dryRun)
│   │
│   ├── mcp-gateway/                     ◀── stdio MCP 서버 + Python 래퍼
│   │   ├── server.ts                       (14 tools, instrumentServer)
│   │   ├── graphify.ts                     (Python spawn + JSON 파싱)
│   │   ├── pageindex.ts                    (Python spawn + 트리 탐색)
│   │   ├── gstack-proxy.ts                 (레지스트리 인식 gstack 래퍼)
│   │   └── build-queue.ts                  (자동 활성화 큐 + 워커)
│   │
│   └── vela-cli/                        ◀── 메인 CLI 엔트리포인트
│       └── src/
│           ├── cli.ts                       (글로벌 플래그, 라우터)
│           ├── commands/
│           │   ├── setup.ts                 (12단계 bootstrap)
│           │   ├── status.ts                (4 시스템 + 그래프)
│           │   ├── start.ts, stop.ts        (Paperclip 데몬 제어)
│           │   ├── register.ts              (프로젝트 등록)
│           │   ├── unregister.ts            (개별 프로젝트 제거 + Paperclip DELETE,
│           │   │                             VELA-13)
│           │   ├── prune.ts                 (path-이 사라진 orphan 엔트리 일괄 제거,
│           │   │                             VELA-13)
│           │   ├── list.ts                  (레지스트리 조회)
│           │   ├── dispatch.ts              (목표 디스패치)
│           │   ├── logs.ts                  (구조화 로그 조회)
│           │   ├── index-docs.ts            (PageIndex 로컬 인덱싱 + --list 리치 출력,
│           │   │                             --project/--backend/--failed 필터
│           │   │                             VELA-18, VELA-25)
│           │   └── sync-from-paperclip.ts   (Paperclip 프로젝트 → 로컬 레지스트리 역동기화)
│           └── util/
│               ├── context.ts               (CommandContext)
│               ├── detect.ts                (시스템 탐지)
│               ├── paths.ts                 (경로 상수)
│               ├── proc.ts                  (spawn/daemon/PID)
│               ├── http.ts                  (native fetch 래퍼)
│               └── log.ts                   (ANSI TTY 헬퍼)
│
├── scripts/                             ◀── 테스트 (300+ assertions)
│   ├── test-briefing.ts
│   ├── test-registry.ts
│   ├── test-dispatch.ts
│   ├── test-adapter.ts
│   ├── test-feedback.ts
│   ├── test-graphify.ts
│   ├── test-mcp-gateway.ts
│   ├── test-auto-activation.ts
│   └── test-observability.ts
│
├── refs/                                ◀── 업스트림 참조 (gitignored)
│   ├── paperclip/                           (PLUGIN_SPEC, DEPLOYMENT-MODES)
│   ├── gstack/
│   ├── graphify/
│   └── PageIndex/
│
└── docs/
    ├── integration-plan.md                  (초기 설계)
    └── architecture.md                      (본 문서)
```

**의존성 방향.** `shared`가 뿌리. 나머지 패키지는 `shared`를 참조하지만 `shared`는 아무것도 참조하지 않는다. `paperclip-plugin`과 `mcp-gateway` 사이는 **런타임 동적 import**로 해결해서 TypeScript 컴파일 순환을 피한다.

```
┌─────────┐
│ vela-cli│
└────┬────┘
     │
     ├──► shared (readonly)
     ├──► gstack-adapter ──┐
     ├──► paperclip-plugin─┤──► shared
     └──► mcp-gateway ─────┘
                │
                └── (동적 import) ──► build-queue.js (런타임만)
```

---

## 3. Dispatch 플로우 — 목표 한 줄이 실행되기까지

"`vela dispatch project-a '로그인 OAuth 추가'`를 실행하면 무슨 일이 일어나는가?" — 가장 중요한 데이터 플로우.

```
 사용자: vela dispatch project-a "로그인 OAuth 추가"
      │
      │ [1] CLI 파싱 + cid 생성 (abc12345)
      ▼
 ┌─────────────────────┐
 │  vela-cli/dispatch  │────► logger.info("start", {project, goal})
 └──────────┬──────────┘
            │
            │ [2] 레지스트리에서 프로젝트 조회
            ▼
 ┌─────────────────────┐
 │  shared/registry    │────► getProject("project-a")
 └──────────┬──────────┘      ▲
            │                  │ ~/.vela/projects.json
            │ [3] 브리핑 팩 생성
            ▼
 ┌─────────────────────┐
 │ paperclip-plugin    │
 │  briefing.ts        │────► git log -50
 └──────────┬──────────┘      find . -type d -maxdepth 3
            │                  high-churn files (30일)
            │                  README.md + CLAUDE.md
            │                  .vela/pins.txt
            │
            │ [4] 프롬프트 조립 (~8KB)
            ▼
 ┌─────────────────────┐
 │ paperclip-plugin    │
 │  dispatch.ts        │────► assembleDispatchPrompt(pack, goal)
 └──────────┬──────────┘
            │
            │ [5] 목표 기록 생성
            ▼
 ┌─────────────────────┐
 │  shared/goals       │────► createGoal(project, goal)
 └──────────┬──────────┘      ▲
            │                  │ ~/.vela/goals.json
            │ [6] 어댑터로 실행
            ▼
 ┌─────────────────────┐
 │  gstack-adapter     │────► spawn("claude", ["-p", prompt])
 │   adapter.ts        │      cwd: project.path
 └──────────┬──────────┘      timeout: 5min
            │                  stdio: streaming
            │
            │ [7] 실행 결과 캡처 + 피드백 루프
            ▼
 ┌─────────────────────┐
 │  shared/feedback    │
 │                     │────► extractDecisionsFromOutput(stdout)
 │                     │      findCrossProjectImplications(touched)
 │                     │      recordDecisions(goalId, ...)
 │                     │      ▲
 │                     │      │ ~/.vela/decisions/project-a/{goalId}.md
 │                     │      │
 │                     │────► triggerGraphRefresh(project)
 │                     │         │ (fire-and-forget detached)
 │                     │         ▼
 │                     │      ┌──────────────┐
 │                     │      │  MCP Gateway │
 │                     │      │ graph.refresh│
 │                     │      └──────────────┘
 └──────────┬──────────┘
            │
            │ [8] 결과 반환 + 로그
            ▼
      사용자에게 { success, summary, durationMs, ... }
            │
            └────► ~/.vela/logs/vela.jsonl (cid=abc12345 전체)
```

**핵심 관찰.** 1단계의 cid가 8단계까지 전 체인에 전파된다. 나중에 `vela logs --cid abc12345`로 이 전체 플로우를 한 번에 재생할 수 있다.

### 3.1 Paperclip async path (`execute-goal` MCP 툴)

Section 3의 플로우는 **사용자 주도 동기 경로**다. Claude Code 세션이 Paperclip 플러그인의 `execute-goal` MCP 툴을 호출하는 경우는 전혀 다른 경로를 탄다. Paperclip의 RPC 타임아웃(30초)을 Claude CLI 실행 시간(1–5분)이 상시 초과하기 때문이다.

```
 Claude Code 세션
      │
      │ MCP: paperclip-plugin.execute-goal({projectName, goal, localExecute:false})
      ▼
 ┌──────────────────────┐
 │ paperclip-plugin     │
 │  plugin.ts           │  [a] generateBriefingPack(project)
 │                      │  [b] Paperclip Issue 생성 (title=goal, body=briefing)
 │                      │  [c] createGoal(..., status:"executing")
 │                      │  [d] early return ─────────────► { goalId, paperclipIssueId, dispatched:true }
 └──────────┬───────────┘      (10–50ms, RPC 타임아웃 여유)
            │
            │ (비동기, 별도 프로세스 경로)
            ▼
 ┌──────────────────────┐
 │ Paperclip heartbeat  │  주기적 wake + wakeOnAssignment
 │ worker               │  inbox-lite: assigneeAgentId=self AND
 │                      │              status IN (todo, in_progress, blocked)
 └──────────┬───────────┘
            │
            │ 이슈 발견 → 에이전트 워크스페이스에서 Claude CLI spawn
            ▼
 ┌──────────────────────┐
 │ claude --print ...   │  (max-turns 1000, dangerously-skip-permissions,
 │  (sonnet 또는 opus)  │   agent-instructions.md append-system-prompt)
 └──────────┬───────────┘
            │
            │ 이슈 댓글/상태 업데이트
            ▼
 ┌──────────────────────┐
 │ Issue done/cancelled │
 └──────────────────────┘
```

**왜 두 경로가 공존하는가.**

| 경로 | 사용처 | 특징 |
|---|---|---|
| **동기 (Section 3)** | `vela dispatch` CLI | 사용자가 터미널에서 기다림. 최대 5분 타임아웃 내 완료 가정. |
| **비동기 (§3.1)** | Claude Code 내부 MCP 호출 | RPC 30s 타임아웃을 회피. Paperclip의 조직/우선순위 레이어를 재활용. |

`localExecute: true`를 명시적으로 전달하면 동기 경로도 탈 수 있으나 (a) Paperclip RPC가 30초에 cut-off되며 (b) Paperclip heartbeat와 dual execution race가 생기므로 실제 사용 금지. 플래그는 dev-loop 디버깅용으로만 남겨둠.

---

## 4. 자동 활성화 레이어 (Auto-Activation)

"내가 `vela register`만 실행하면 왜 그래프가 알아서 만들어지는가?" — 백그라운드 플로우.

```
                   ┌─────────────────────────────────┐
                   │       트리거 소스 (3개)          │
                   ├─────────────────────────────────┤
                   │ (A) Paperclip 부팅 시 scanner   │
                   │ (B) vela register CLI           │
                   │ (C) graph.query on missing      │
                   └────────────────┬────────────────┘
                                    │
                                    │ enqueue()
                                    ▼
                     ┌──────────────────────────────┐
                     │   ~/.vela/build-queue.jsonl  │
                     │   (append-only, atomic)      │
                     │                              │
                     │   {id, kind:"graphify",      │
                     │    projectName, projectPath, │
                     │    enqueuedAt, attempts}     │
                     └──────────────┬───────────────┘
                                    │
                                    │ poll every 2s
                                    ▼
                     ┌──────────────────────────────┐
                     │    Build Queue Worker        │
                     │    (Paperclip 플러그인 내부)  │
                     │    동시성: 1                 │
                     │    타임아웃: 10분/빌드        │
                     └──────────────┬───────────────┘
                                    │
                                    │ dequeue next entry
                                    ▼
                     ┌──────────────────────────────┐
                     │  status.json: "building"     │
                     └──────────────┬───────────────┘
                                    │
                                    │ spawn Python
                                    ▼
                     ┌──────────────────────────────┐
                     │  .venv/bin/python            │
                     │  scripts/graphify_build.py   │
                     │  (AST 파싱, tree-sitter)     │
                     └──────────────┬───────────────┘
                                    │
                                    │ write graph.json
                                    ▼
                     ┌──────────────────────────────┐
                     │  ~/.vela/graphify/           │
                     │    {project}/                │
                     │      graph.json  (신규)      │
                     │      status.json ("built")   │
                     └──────────────┬───────────────┘
                                    │
                                    │ logger.info("built", {duration, nodes})
                                    ▼
                     ┌──────────────────────────────┐
                     │  ~/.vela/logs/vela.jsonl     │
                     │  ~/.vela/logs/graph-build.log│
                     └──────────────────────────────┘
```

### 트리거 A: Paperclip 부팅 스캔

```
launchd startup
     │
     ▼
pnpm paperclip dev:server
     │
     ▼
plugin.setup() 호출
     │
     ▼
[모든 기존 이벤트/도구/데이터 등록]
     │
     ▼
queueMicrotask(async () => {
     scanner.scanAndQueue()           ◀── 레지스트리 전체 순회
       │
       ├── for each project:
       │     exists graph.json ? → skip
       │     path missing ? → warn + skip
       │     already in queue ? → skip
       │     otherwise → enqueue()
       │
     queue.startWorker()              ◀── 백그라운드 워커 기동
})
     │
     └──► setup() 완료 (비블로킹, 플러그인 핸드셰이크 즉시 반환)
```

### 트리거 C: Lazy build on graph.query

```
Claude Code: "project-a에서 auth 코드 찾아줘"
     │
     ▼
MCP tool: graph.query(projectName="project-a", query="auth")
     │
     ▼
graphExists("project-a") ?
     │
     ├── 있음 → 기존 로직 (즉시 쿼리 결과 반환)
     │
     └── 없음 ▼
          │
          │ (1) readStatus(project) ?
          │      └── state="building" ? 
          │            → return {status:"building", retryAfterSec:120}
          │            → [종료, 큐 조작 없음]
          │
          │ (2) isQueued(project) ?
          │      └── 이미 큐에 있음 → 
          │            → return {status:"building", retryAfterSec:120}
          │            → [종료, 중복 enqueue 방지]
          │
          │ (3) 위 둘 다 아님 → 
          │      enqueue({ kind:"graphify", projectName, projectPath })
          │      return {status:"building", retryAfterSec:120}
          ▼
     Claude가 자연스럽게 재시도 or briefing pack 폴백
```

---

## 5. 피드백 루프 (Phase 5)

"실행 결과가 어떻게 지식이 되는가?" — 실행 → 기억 → 다음 실행.

```
                    [execute-goal 성공]
                            │
                            ▼
                  ┌──────────────────┐
                  │  Claude stdout   │  (~50KB 실행 로그)
                  └─────────┬────────┘
                            │
                            ▼
             ┌─────────────────────────────┐
             │ extractDecisionsFromOutput  │ (휴리스틱 정규식)
             │                             │
             │ 매칭 패턴:                   │
             │   "I decided to ..."        │
             │   "chose ... over ..."      │
             │   "rejected ..."            │
             │   "tradeoff: ..."           │
             │   "assumption ..."          │
             │   "Decided: ..."            │
             │                             │
             │ 출력: DecisionEntry[]       │
             │       { trigger, text }     │
             │       (최대 50개, 중복 제거)  │
             └──────────────┬──────────────┘
                            │
                            ▼
             ┌─────────────────────────────┐
             │ findCrossProjectImplications│
             │                             │
             │ 1) 사용자 프로젝트 레지스트리 │
             │    에서 관련 프로젝트 찾기   │
             │ 2) 관련 프로젝트의           │
             │    README/CLAUDE.md 스캔    │
             │ 3) touchedFiles가 언급됐는지  │
             │    탐색                      │
             │                             │
             │ 출력: Implication[]          │
             └──────────────┬──────────────┘
                            │
                            ▼
             ┌─────────────────────────────┐
             │    recordDecisions()        │
             │                             │
             │ → ~/.vela/decisions/        │
             │     {project}/              │
             │       {goalId}.md   (신규)   │
             │       log.md        (append)│
             │                             │
             │ → updateGoal(goalId, {      │
             │     status: "done",         │
             │     result: { ... }         │
             │   })                        │
             └──────────────┬──────────────┘
                            │
                            ▼
             ┌─────────────────────────────┐
             │  triggerGraphRefresh()      │
             │  (fire-and-forget, 백그라운드)│
             │                             │
             │ spawn("node", [gateway], {  │
             │   detached: true,           │
             │   stdio: "pipe"             │
             │ })                          │
             │                             │
             │ stdin에 MCP JSON-RPC:       │
             │   initialize → initialized  │
             │   → tools/call graph.refresh│
             │                             │
             │ proc.unref()                │
             │ [호출자는 즉시 반환]         │
             └──────────────┬──────────────┘
                            │
                            ▼
                  [다음 execute-goal에서
                   갱신된 그래프 자동 참조]
```

---

## 6. 관찰가능성 파이프라인

"cid 하나로 어떻게 전체 체인을 추적하는가?"

```
사용자: vela --cid=abc123 dispatch project-a "fix login"
    │
    │ (cid가 생성되거나 사용자 제공)
    ▼
┌──────────────────────────────────────────────────────┐
│  CommandContext { cid, logger, verbose }             │
└──────────────────────────────────────────────────────┘
    │
    ├──► cli.dispatch logger ──► logger.info("start", {goal})
    │         │
    │         │ .child("briefing-pack") ◀── cid 유지
    │         ▼
    │    briefing.ts ──► logger.time("generate", async () => { ... })
    │                          ▲
    │                          │ 시작 로그 + 끝 로그 + duration_ms
    │                          │
    │         .child("gstack-adapter") ◀── cid 유지
    │         ▼
    │    adapter.executeGoal() ──► logger.info("spawn", {pid})
    │
    ├──► 모든 로그 엔트리 → 단일 JSONL 싱크
    │                                        │
    │                                        ▼
    │                         ~/.vela/logs/vela.jsonl
    │                         ┌──────────────────────┐
    │                         │ {ts, level, cid,     │
    │                         │  component, msg,     │
    │                         │  data, duration_ms}  │
    │                         │ {...}                │
    │                         │ {...}                │
    │                         └──────────────────────┘
    │
    ├──► MCP Gateway 별도 프로세스                    │
    │         │                                        │
    │         │ instrumentServer() auto-wraps tools    │
    │         ▼                                        │
    │    gateway.tool.graph.query logger ─────────────┤
    │                                                   │
    ├──► Paperclip 플러그인 별도 프로세스              │
    │         │                                        │
    │         ▼                                        │
    │    plugin.startup-scanner logger ───────────────┤
    │                                                   │
    └──► Build Queue 워커 (플러그인 내부)              │
              │                                        │
              ▼                                        │
         worker.graphify-build logger ─────────────────┘

나중에:
    vela logs --cid abc123
        │
        ▼
    readLogs({ cid: "abc123" })
        │
        ▼
    ┌─────────────────────────────────┐
    │ [10:00:01] cli.dispatch start   │
    │ [10:00:01] cli.dispatch.brief.. │
    │ [10:00:01] cli.dispatch.gstack..│
    │ [10:00:02] gateway.graph.refresh│
    │ [10:00:05] worker.graphify-build│
    │ [10:02:10] worker.graphify done │
    │ [10:02:10] cli.dispatch ok      │
    └─────────────────────────────────┘
```

### 로거 계층

```
createLogger({ component: "cli.dispatch", cid, tty: verbose })
     │
     ├── .child("briefing-pack")     component: "cli.dispatch.briefing-pack"  [cid 유지]
     │         │
     │         └── .child("git-log") component: "cli.dispatch.briefing-pack.git-log"  [cid 유지]
     │
     ├── .child("gstack-adapter")    component: "cli.dispatch.gstack-adapter" [cid 유지]
     │
     └── logger.time("operation", async () => {
              // 자동으로 start + end + duration 로그
              // 에러 자동 캐치 + 로그
         })
```

---

## 7. MCP 게이트웨이 도구 네임스페이스

"Claude Code가 호출 가능한 도구는 무엇이 있는가?"

```
┌──────────────────────────────────────────────────────────────┐
│                    MCP Gateway (18+ tools)                     │
│              stdio JSON-RPC, 단일 실행 파일                    │
├──────────────────────────────────────────────────────────────┤
│                                                                │
│  knowledge.* (4)              ◀── gbrain 래퍼 (장기 기억)     │
│  ├── knowledge.search            의미 검색 (하이브리드 RRF)    │
│  ├── knowledge.get               엔티티 페이지 조회            │
│  ├── knowledge.put               엔티티/결정 기록              │
│  └── knowledge.stats             brain 통계                   │
│                                                                │
│  doc.* (3)                    ◀── PageIndex 래퍼              │
│  ├── doc.index                   문서 인덱싱 (LLM 추론 트리)   │
│  ├── doc.get_structure           계층 트리 조회                │
│  └── doc.get_pages               특정 페이지/섹션 내용          │
│                                                                │
│  graph.* (6)                  ◀── Graphify 래퍼               │
│  ├── graph.build                 그래프 빌드 (즉시)             │
│  ├── graph.query                 키워드 검색 + lazy build     │
│  ├── graph.get_neighbors         노드의 이웃                   │
│  ├── graph.get_node              특정 노드 조회                │
│  ├── graph.stats                 노드/엣지/커뮤니티 수          │
│  └── graph.refresh               증분 업데이트                 │
│                                                                │
│  gstack.* (4)                 ◀── gstack 프록시               │
│  ├── gstack.execute_skill        /qa /review /ship 등 실행    │
│  ├── gstack.dispatch_goal        Briefing pack + execute      │
│  ├── gstack.list_goals           목표 목록                     │
│  └── gstack.check_availability   Claude CLI 존재 확인          │
│                                                                │
│  vela.* (1)                   ◀── 메타 도구                   │
│  └── vela.list_projects          레지스트리 덤프               │
│                                                                │
└──────────────────────────────────────────────────────────────┘

자동 계측 (instrumentServer):
  registerTool() 래핑 → 모든 호출이 자동으로
    - logger.info("handler start", {params})
    - logger.info("handler ok", {duration_ms})
    - logger.error("handler failed", err)
  시크릿 redaction + 32KB truncation 자동 적용
```

**주의 — Paperclip 플러그인의 tool 표면은 별도다.** Claude Code에 노출되는 tool은 위 14개의 MCP Gateway 툴뿐이지만, Paperclip 서버 내부에서 실행되는 Vela Union 플러그인은 자체 tool 표면(`dispatch-goal`, `execute-goal`, `project-status`, `goal-status`)을 등록한다. 이 툴들은 Paperclip 웹 UI와 Paperclip의 내부 RPC 경로를 통해서만 호출된다. 상세는 §14 참조.

---

## 8. 프로세스 아키텍처

"실행 중인 프로세스는 몇 개이고 어떻게 연결되어 있는가?"

```
   ┌────────────────────────────────────────────────────────────┐
   │                         macOS                              │
   ├────────────────────────────────────────────────────────────┤
   │                                                             │
   │  ┌─────────────────┐                                       │
   │  │    launchd      │ (시스템 부팅 시 자동)                    │
   │  │ com.vela.       │                                       │
   │  │   paperclip     │                                       │
   │  └────────┬────────┘                                       │
   │           │ RunAtLoad + KeepAlive                          │
   │           ▼                                                 │
   │  ┌─────────────────┐                                       │
   │  │   pnpm          │                                       │
   │  │   dev:server    │                                       │
   │  └────────┬────────┘                                       │
   │           │ spawn                                           │
   │           ▼                                                 │
   │  ┌─────────────────────────────────────────────────┐       │
   │  │         Paperclip 서버 (Node.js)                │       │
   │  │         http://127.0.0.1:3100                   │       │
   │  │                                                  │       │
   │  │  ┌─────────────────────────────────────┐        │       │
   │  │  │    Vela Union 플러그인 (isolated)    │        │       │
   │  │  │    - 이벤트 핸들러                   │        │       │
   │  │  │    - 도구 (dispatch/execute/status) │        │       │
   │  │  │    - 데이터 프로바이더                │        │       │
   │  │  │    - startup-scanner                │        │       │
   │  │  │    - build-queue worker             │        │       │
   │  │  └──────────────┬──────────────────────┘        │       │
   │  │                 │ spawn (when building)          │       │
   │  │                 ▼                                │       │
   │  │  ┌─────────────────────────────────────┐        │       │
   │  │  │     .venv/bin/python               │        │       │
   │  │  │     graphify_build.py              │        │       │
   │  │  │     (per-build, 10min timeout)     │        │       │
   │  │  └─────────────────────────────────────┘        │       │
   │  │                                                  │       │
   │  └─────────────────────────────────────────────────┘       │
   │                                                             │
   │                                                             │
   │  ┌─────────────────┐                                       │
   │  │   Claude Code   │ (사용자 요청마다)                     │
   │  └────────┬────────┘                                       │
   │           │ stdio spawn (per session)                       │
   │           ▼                                                 │
   │  ┌─────────────────────────────────────────────────┐       │
   │  │       MCP Gateway (Node.js, stdio)              │       │
   │  │       14 tools registered                       │       │
   │  │                                                  │       │
   │  │  ┌───────────────┐  ┌──────────────────┐        │       │
   │  │  │ spawn Python  │  │ spawn Python     │        │       │
   │  │  │ graphify      │  │ pageindex        │        │       │
   │  │  │ (per call)    │  │ (per call)       │        │       │
   │  │  └───────────────┘  └──────────────────┘        │       │
   │  └─────────────────────────────────────────────────┘       │
   │                                                             │
   │  ┌─────────────────┐                                       │
   │  │    vela CLI     │ (사용자 명령마다)                     │
   │  └────────┬────────┘                                       │
   │           │ HTTP or spawn                                   │
   │           ├──► Paperclip 서버 (register 등)                │
   │           └──► Claude CLI (dispatch, execute-goal)         │
   │                                                             │
   └────────────────────────────────────────────────────────────┘

Long-running (단 하나):
  Paperclip 서버 (+ Vela 플러그인 + 빌드 큐 워커)

Per-invocation (요청/명령 당 생성):
  MCP Gateway (Claude Code stdio)
  Python subprocess (그래프/문서 빌드 시)
  Claude CLI (dispatch 시)
  vela CLI (명령 실행 시)
```

### 8.1 서브프로세스 환경 상속 — `HOME` injection chain

Paperclip 내부에서 Claude CLI를 spawn할 때 환경 변수 상속이 끊어지는 구간이 두 군데 있다. 양쪽 모두 명시적으로 `HOME`/`USER`를 재주입해야만 `~/.claude/.credentials.json` 인증이 성립한다.

```
┌──────────────────────────────────────────────────────────────┐
│  launchd  com.vela.paperclip.plist                            │
│  EnvironmentVariables { HOME, USER, PATH,                     │
│                         VELA_CLAUDE_CLI_CONCURRENCY=3 }       │
│                                                                │
│  ★ 1차 차단점: launchd는 login session이 아니므로            │
│    ~/.zshrc / launchctl setenv 등으로 유입되는 HOME이 없음.   │
│    plist의 EnvironmentVariables 블록에 명시 안 하면 HOME 없음. │
│  (fix: packages/vela-cli/src/commands/setup.ts                │
│        renderPaperclipPlist()에서 주입)                       │
└──────────────┬───────────────────────────────────────────────┘
               │ spawn (env 상속)
               ▼
┌──────────────────────────────────────────────────────────────┐
│  pnpm dev:server → Paperclip Node.js 서버                    │
│  process.env.HOME ✓                                          │
└──────────────┬───────────────────────────────────────────────┘
               │ fork("plugin-worker-manager")
               │ ★ 2차 차단점: Paperclip의 plugin-worker-manager.ts는
               │   플러그인 워커를 격리된 환경으로 fork 한다.
               │   전달되는 env는 { NODE_ENV, TZ, NODE_CHANNEL_FD }
               │   등 curated allowlist — HOME/USER 불포함.
               ▼
┌──────────────────────────────────────────────────────────────┐
│  Vela Union 플러그인 워커 (fork)                              │
│  process.env.HOME = undefined ✗                              │
│                                                                │
│  (fix: packages/gstack-adapter/src/adapter.ts                 │
│        claudeSpawnEnv() 헬퍼가 호출 시점에 직접 주입:          │
│         HOME = process.env.HOME || os.homedir()               │
│         USER = process.env.USER || os.userInfo().username)    │
└──────────────┬───────────────────────────────────────────────┘
               │ spawn("claude", ["-p", prompt], { env: claudeSpawnEnv() })
               ▼
┌──────────────────────────────────────────────────────────────┐
│  claude CLI subprocess                                         │
│  readFile("~/.claude/.credentials.json") ✓                    │
│  → 인증 성공                                                  │
└──────────────────────────────────────────────────────────────┘
```

**왜 `os.homedir()`가 fallback으로 동작하는가.** libuv의 `uv_os_homedir()`는 환경변수가 없을 때 passwd 데이터베이스(`getpwuid`)를 조회한다. 즉 HOME이 완전히 비어있어도 macOS/Linux에서는 정확한 홈디렉토리를 돌려준다. 이 fallback 덕에 Paperclip의 curated-env fork에서도 claudeSpawnEnv()가 안전하게 동작한다.

**별도 경로: Paperclip 자체 에이전트 heartbeat.** Paperclip heartbeat worker가 Claude CLI를 spawn할 때는 Paperclip 자체 adapter(`claude_local` adapter)가 HOME을 처리한다. Vela 플러그인이 spawn하는 경로와는 **완전히 별개**다. §14의 에이전트 오케스트레이션 다이어그램 참조.

---

## 9. Build Queue 상태 머신

"프로젝트 그래프의 상태는 어떻게 변화하는가?"

```
            ┌─────────────────┐
            │     missing     │  (레지스트리에 있지만 그래프 없음)
            └────────┬────────┘
                     │
                     │ enqueue()
                     ▼
            ┌─────────────────┐
            │    (in queue)   │  (build-queue.jsonl에 엔트리)
            └────────┬────────┘
                     │
                     │ worker dequeues
                     ▼
            ┌─────────────────┐
            │    building     │  (Python 프로세스 실행 중)
            └────────┬────────┘
                     │
         ┌───────────┼───────────┐
         │           │           │
 success │     fail  │    timeout│ (10min)
         │           │           │
         ▼           ▼           ▼
  ┌──────────┐ ┌──────────┐ ┌──────────┐
  │   built  │ │  failed  │ │  failed  │
  │  (정상)   │ │  (로그)   │ │ (SIGKILL)│
  └────┬─────┘ └────┬─────┘ └────┬─────┘
       │            │            │
       │            │            │
       │            │  다음 enqueue (수동 또는 자동)
       │            └─────┬──────┘
       │                  │
       │                  ▼
       │            (다시 building)
       │
       │ git post-commit OR manual graph.refresh
       ▼
  ┌──────────┐
  │ building │ (증분 업데이트)
  └──────────┘

status.json 위치: ~/.vela/graphify/{project}/status.json
중앙 로그:        ~/.vela/logs/graph-build.log (자유 형식, backwards compat)
구조화 로그:      ~/.vela/logs/vela.jsonl (cid 포함)
```

---

## 10. `vela setup` 12단계

"설치 한 번으로 정확히 무엇이 일어나는가?"

```
   pnpm vela setup
       │
       ▼
 ╔═══════════════════════════════════════════════════════════════╗
 ║ [1/12]  ~/.vela 디렉토리 초기화                                 ║
 ║         mkdir ~/.vela/{projects, goals, decisions, logs,       ║
 ║               graphify, pageindex, pids}                        ║
 ║         touch projects.json goals.json                          ║
 ╠═══════════════════════════════════════════════════════════════╣
 ║ [2/12]  Paperclip 클론 + 빌드                                  ║
 ║         git clone github.com/paperclipai/paperclip             ║
 ║         cd paperclip && pnpm install                           ║
 ║         pnpm --filter @paperclipai/plugin-sdk build            ║
 ╠═══════════════════════════════════════════════════════════════╣
 ║ [3/12]  Paperclip 데몬 기동 (백그라운드)                        ║
 ║         spawn detached ["pnpm", "dev:server"]                  ║
 ║         write PID → ~/.vela/pids/paperclip.pid                 ║
 ║         poll http://127.0.0.1:3100/health until ready          ║
 ╠═══════════════════════════════════════════════════════════════╣
 ║ [4/12]  gstack 존재 확인                                        ║
 ║         test -d ~/.claude/skills/gstack                        ║
 ║         (없으면 경고 + 설치 안내)                                ║
 ╠═══════════════════════════════════════════════════════════════╣
 ║ [5/12]  Graphify 설치 (Python venv)                            ║
 ║         python -m venv .venv                                   ║
 ║         .venv/bin/pip install graphifyy                        ║
 ║         verify: python -c "import graphify"                    ║
 ╠═══════════════════════════════════════════════════════════════╣
 ║ [6/12]  PageIndex 설치 (동일 venv)                             ║
 ║         pip install -r refs/PageIndex/requirements.txt         ║
 ║         verify import                                          ║
 ╠═══════════════════════════════════════════════════════════════╣
 ║ [7/12]  Vela Union TypeScript 빌드                             ║
 ║         npx tsc --build                                        ║
 ║         (에러 시 중단)                                          ║
 ╠═══════════════════════════════════════════════════════════════╣
 ║ [8/12]  Vela 플러그인을 Paperclip에 설치                        ║
 ║         GET /api/plugins → already installed?                  ║
 ║         POST /api/plugins/install {                            ║
 ║           isLocalPath: true,                                   ║
 ║           path: "packages/paperclip-plugin"                    ║
 ║         }                                                       ║
 ╠═══════════════════════════════════════════════════════════════╣
 ║ [9/12]  Claude Code settings.json에 MCP 게이트웨이 등록         ║
 ║         cp ~/.claude/settings.json ~/.claude/settings.json.bak ║
 ║         JSON parse + merge mcpServers.vela-union               ║
 ║         write back                                             ║
 ╠═══════════════════════════════════════════════════════════════╣
 ║ [10/12] ~/.vela 디렉토리 2차 검증                               ║
 ║         (방어적 중복 체크)                                       ║
 ╠═══════════════════════════════════════════════════════════════╣
 ║ [11/12] launchd 에이전트 (macOS 전용)                           ║
 ║         if platform != "darwin": skip gracefully               ║
 ║         readline prompt: "Install launchd? [Y/n]"              ║
 ║         if yes:                                                │
 ║           exists plist? → skip (idempotent)                    ║
 ║           write ~/Library/LaunchAgents/com.vela.paperclip.plist║
 ║           launchctl load                                       ║
 ║           verify: launchctl list | grep com.vela.paperclip     ║
 ╠═══════════════════════════════════════════════════════════════╣
 ║ [12/12] 최종 검증                                               ║
 ║         MCP gateway boot probe                                  ║
 ║         detectAll() → 모든 시스템 GREEN 확인                     ║
 ║         summary 출력                                            ║
 ╚═══════════════════════════════════════════════════════════════╝
       │
       ▼
   "Setup complete. Next: vela register /path/to/project"

모든 단계 idempotent:
  여러 번 실행해도 부작용 없음
  각 단계가 실패하면 이전 단계까지의 작업은 유지
  재실행 시 이미 완료된 단계는 skip
```

---

## 11. 데이터 모델

"디스크에 저장되는 JSON 구조는 무엇인가?"

### `~/.vela/projects.json`

```typescript
ProjectConfig[] = [
  {
    name: "project-a",
    path: "/path/to/project-a",
    type: "company",                    // company | personal | experimental
    relatedProjects: ["project-b"],
    description: "large-scale editor project"
  },
  ...
]
```

### `~/.vela/goals.json`

```typescript
StoredGoal[] = [
  {
    id: "uuid",
    projectName: "project-a",
    description: "add OAuth login",
    status: "done",                     // pending|planning|executing|done|failed
    createdAt: "2026-04-11T10:00:00Z",
    updatedAt: "2026-04-11T10:05:42Z",
    result: {
      goalId: "uuid",
      success: true,
      summary: "...",
      touchedFiles: [...],
      decisionsMade: ["[decided] use OAuth2 PKCE flow", ...],
      followUps: [...],
      crossProjectImplications: ["project-b: AuthProvider.ts"]
    }
  }
]
```

### `~/.vela/build-queue.jsonl`

```
{"id":"abc","kind":"graphify","projectName":"project-a","projectPath":"/path/to/project-a","enqueuedAt":"2026-04-11T10:00:00Z","attempts":0}
{"id":"def","kind":"graphify","projectName":"project-b","projectPath":"/path/to/project-b","enqueuedAt":"2026-04-11T10:00:01Z","attempts":0}
```

### `~/.vela/graphify/{project}/status.json`

```typescript
BuildStatus = {
  projectName: "project-a",
  kind: "graphify",
  state: "built",                       // missing|building|built|failed
  lastAttemptAt: "2026-04-11T10:02:10Z",
  lastError: null,                      // or error message
  durationMs: 129500
}
```

### `~/.vela/graphify/{project}/graph.json`

Graphify가 생성하는 네이티브 포맷. 노드/엣지/커뮤니티를 포함하는 큰 JSON. 대규모 프로젝트 기준 수십 MB. 내부 스키마는 Graphify 문서 참조.

### `~/.vela/logs/vela.jsonl`

```
{"ts":"2026-04-11T10:00:00.123Z","level":"info","component":"cli.dispatch","cid":"abc12345","msg":"start","data":{"project":"project-a","goal":"..."},"pid":1234}
{"ts":"2026-04-11T10:00:00.145Z","level":"debug","component":"cli.dispatch.briefing-pack","cid":"abc12345","msg":"generated","duration_ms":22,"data":{"chars":7957}}
...
```

---

## 12. 컴포넌트 간 경계와 계약

"각 컴포넌트는 무엇을 약속하고 무엇을 기대하는가?"

| 컴포넌트 | Input | Output | 불변성 |
|---------|-------|--------|-------|
| **shared/registry** | `addProject`, `removeProject`, `getProject` | `ProjectConfig` | 원자적 쓰기, 중복 이름 거부 |
| **shared/goals** | `createGoal`, `updateGoal` | `StoredGoal` | 단방향 status 전환 |
| **shared/feedback** | Claude stdout | 결정 목록 + 로그 파일 | 로깅 실패가 플로우 차단 안 함 |
| **shared/logger** | component + cid + data | JSONL 엔트리 | 로거 자체 에러 삼킴, 32KB 초과 시 truncate |
| **paperclip-plugin/briefing** | `ProjectConfig` | `BriefingPack` (8KB) | 60-150ms 내 완료, I/O 실패 시 부분 결과 |
| **paperclip-plugin/dispatch** | `BriefingPack + goal` | 구조화 프롬프트 | 결정적 순서, 재현 가능 |
| **paperclip-plugin/startup-scanner** | registry | ScanResult | 부팅 블로킹 금지 (queueMicrotask) |
| **gstack-adapter** | `(prompt, projectPath)` | 실행 결과 + 종료 코드 | Claude CLI 없으면 명확한 에러 반환, 절대 throw 안 함 |
| **mcp-gateway/server** | stdio JSON-RPC | JSON 응답 | 모든 에러를 JSON으로 반환 (throw 금지), 시크릿 redact |
| **mcp-gateway/build-queue** | `QueueEntry` | worker 실행 | 동시성 1, 10분 타임아웃, SIGTERM 10초 grace |
| **mcp-gateway/graphify** | `(projectName, projectPath)` | `graph.json` 생성 | Python 프로세스 격리, 결과 파일로만 통신 |
| **mcp-gateway/pageindex** | 문서 경로 | 계층 트리 JSON | LLM API 키 없으면 clear error |
| **vela-cli/commands/setup** | 없음 | 12단계 결과 | 전체 idempotent, 실패 시 부분 완료 상태 유지 |

---

## 13. "설치만으로 돌아가는" — 엔드 투 엔드 타임라인

```
 T=0    사용자: git clone vela-union && pnpm install && pnpm vela setup
          │
 T+5s    [1/12] ~/.vela 초기화
 T+15s   [2/12] Paperclip 클론 완료 (git clone + pnpm install)
 T+120s  [3/12] Paperclip 데몬 기동 ──► pid 저장, health OK
 T+121s  [4/12] gstack 확인 (instant)
 T+135s  [5/12] Graphify venv 설치 완료
 T+150s  [6/12] PageIndex venv 설치 완료
 T+180s  [7/12] Vela TypeScript 빌드 완료
 T+182s  [8/12] Vela 플러그인 Paperclip에 install (HTTP)
 T+183s  [9/12] Claude Code settings.json 머지
 T+183s  [10/12] 디렉토리 재검증
 T+190s  [11/12] launchd 프롬프트 "Install? Y"
          └─► plist 작성 + launchctl load
 T+195s  [12/12] 최종 검증 GREEN
          │
          ▼
        "Setup complete."

사용자: vela register ~/projects/project-a
 T=0     CLI entry, cid 생성
 T+10ms  registry.addProject() → ~/.vela/projects.json 업데이트
 T+15ms  enqueue() → build-queue.jsonl append
 T+20ms  CLI return
          │
          (백그라운드에서...)
          │
 T+2s    Paperclip 워커가 poll → dequeue project-a
 T+3s    spawn Python graphify
 T+125s  graph.json 쓰기 완료 (수십 MB)
 T+125s  status.json = "built"
 T+125s  다음 엔트리 dequeue 또는 idle

사용자 재부팅:
 T=0     POWER ON
 T+30s   로그인
 T+31s   launchd → pnpm dev:server
 T+45s   Paperclip 서버 기동
 T+46s   플러그인 setup() 완료
 T+46s   queueMicrotask → scanner.scanAndQueue()
 T+47s   "새로 추가된 프로젝트 3개 → 큐에 넣음"
 T+48s   worker 시작
 T+2m    첫 번째 빌드 완료
 T+6m    세 번째 빌드 완료 → 모두 ready
```

---

## 14. Paperclip 에이전트 오케스트레이션

"Vela Union 프로젝트 자체가 Paperclip에 등록된다는 건 무슨 의미인가?" — dogfooded 셀프 호스팅 레이어.

Vela Union은 자신이 제공하는 오케스트레이션 기능을 스스로에게도 적용한다. 즉 `[VELA] vela-union` 프로젝트가 Paperclip에 등록되어 있고, CEO + CTO 에이전트가 이 프로젝트의 이슈를 소화한다.

### 14.1 조직 구조

```
                  ┌─────────────────────────┐
                  │      local-board        │  (사용자 = 보드)
                  │   isInstanceAdmin=true  │
                  │   deploymentMode=       │
                  │     local_trusted       │
                  └───────────┬─────────────┘
                              │ 임명 / 해임 / 예산 승인
                              ▼
                  ┌─────────────────────────┐
                  │       CEO 에이전트       │  role=ceo
                  │  (delegates-only)        │  adapterType=claude_local
                  │  capabilities:           │  model=sonnet-4-6
                  │   조직 설계, 채용,       │  intervalSec=300
                  │   우선순위 결정, 리뷰    │  wakeOnAssignment=true
                  └───────────┬─────────────┘  canCreateAgents=true
                              │ reportsTo
                              │ chainOfCommand
                              ▼
                  ┌─────────────────────────┐
                  │       CTO 에이전트       │  role=cto
                  │  (코드 실행 가능)         │  adapterType=claude_local
                  │  capabilities:           │  model=sonnet/opus (동적)
                  │   기술 로드맵, 아키텍처, │  intervalSec=300
                  │   구현, 인프라, 데브툴    │  wakeOnAssignment=true
                  └─────────────────────────┘  canCreateAgents=false
```

CEO와 CTO의 차이는 **capabilities 문자열**과 instructions 파일뿐이다. 런타임 동작은 동일 — 둘 다 주기적으로 깨어나 자신의 inbox를 체크하고, 이슈가 있으면 Claude CLI를 spawn해 해결한다.

### 14.2 Heartbeat 모델

각 에이전트는 세 가지 트리거로 깨어난다.

```
 trigger type              when                         source
 ──────────────────────────────────────────────────────────────────
 [A] timer                 매 intervalSec(300s)          Paperclip scheduler
 [B] wakeOnAssignment      이슈의 assigneeAgentId가      Issue PATCH hook
                           이 에이전트로 변경될 때
 [C] on_demand             POST /agents/:id/             사용자/다른
                             heartbeat/invoke            에이전트
```

```
            ┌──────────────────────────┐
            │  Paperclip scheduler     │
            │  (interval + wake hooks) │
            └───────────┬──────────────┘
                        │
                        │ wake 트리거 발생
                        ▼
            ┌──────────────────────────┐
            │  heartbeat_runs INSERT   │
            │  (status=queued)         │
            └───────────┬──────────────┘
                        │
                        │ wakeup_queue dequeue
                        ▼
            ┌──────────────────────────┐
            │  spawn Claude CLI         │
            │  claude --print           │
            │    --output-format         │
            │      stream-json           │
            │    --verbose               │
            │    --dangerously-skip-perms│
            │    --model <…>             │
            │    --max-turns 1000        │
            │    --append-system-prompt  │
            │      -file AGENTS.md       │
            │    --add-dir <workspace>   │
            └───────────┬──────────────┘
                        │
                        │ stdout/stderr streaming
                        ▼
            ┌──────────────────────────┐
            │  run-logs/<company>/     │
            │    <agent>/<runId>.ndjson│
            │  (모든 stream-json       │
            │   이벤트 raw 저장)        │
            └───────────┬──────────────┘
                        │
                        │ exit
                        ▼
            ┌──────────────────────────┐
            │  heartbeat_runs UPDATE   │
            │  (status=succeeded/      │
            │   failed/timeout)        │
            └──────────────────────────┘
```

**Run 로그 저장 경로:**

```
~/.paperclip/instances/default/data/run-logs/
    {companyId}/
      {agentId}/
        {runId}.ndjson          ← per-run, NDJSON of stream-json events
```

NDJSON 각 라인은 Claude CLI가 뱉은 단일 이벤트의 JSON 래퍼다. 주요 타입:
- `type:"system"` / `subtype:"init"` — 세션 시작
- `type:"assistant"` — thinking / text / tool_use 콘텐츠
- `type:"user"` — tool_result
- `type:"rate_limit_event"` — 5시간 quota 상태 telemetry (에러 아님, 정상 동작 중에도 emit됨)
- `type:"result"` / `subtype:"success"` — 세션 종료

### 14.3 Inbox 모델 — 이슈 기반 작업 큐

Paperclip에는 별도의 "작업 큐"가 없다. 대신 이슈의 `assigneeAgentId`와 `status`가 inbox 역할을 한다.

```sql
-- /api/agents/me/inbox-lite 엔드포인트의 실제 쿼리 의미
SELECT id, identifier, title, status, priority, projectId, goalId, activeRun
FROM issues
WHERE companyId = :actor.companyId
  AND assigneeAgentId = :actor.agentId
  AND status IN ('todo', 'in_progress', 'blocked')
ORDER BY priority DESC, createdAt ASC
```

에이전트가 "작업을 받는다" = 이슈의 `assigneeAgentId`가 자신으로 설정되고 status가 todo/in_progress/blocked 중 하나가 된다는 의미.

**이슈 상태 전환:**

```
       ┌─────────────┐
       │   backlog   │  (생성 직후 기본 상태, inbox에 안 보임)
       └──────┬──────┘
              │
              │ assignee 지정 + status 변경
              ▼
       ┌─────────────┐
       │    todo     │  (inbox에 등장, 다음 heartbeat에서 집어감)
       └──────┬──────┘
              │
              │ 에이전트가 checkout / 작업 시작
              ▼
       ┌─────────────┐
       │ in_progress │  (Claude CLI 실행 중, activeRun 존재)
       └──────┬──────┘
              │
        ┌─────┴──────┐
        │            │
   완료 │            │ 막힘
        ▼            ▼
 ┌─────────┐   ┌─────────┐
 │  done   │   │ blocked │  (여전히 inbox에 남아있음,
 └─────────┘   └─────────┘   리뷰/approval 대기)
                    │
                    │ 해소
                    ▼
              ┌─────────────┐
              │ in_progress │
              └─────────────┘

┌───────────┐
│ cancelled │  (board나 CEO가 중단, inbox에서 제거)
└───────────┘
```

### 14.4 Vela Union 플러그인의 Tool 표면

Paperclip 플러그인이 등록하는 4개 tool. MCP Gateway의 14개 tool(§7)과는 **별도 표면**이다. Paperclip 웹 UI의 에이전트 채팅, Paperclip 내부 RPC, 또는 다른 Paperclip 플러그인이 호출할 수 있다.

```
┌──────────────────────────────────────────────────────────────┐
│           Vela Union Plugin (tools registered on             │
│                  Paperclip plugin-worker)                      │
├──────────────────────────────────────────────────────────────┤
│                                                                │
│  dispatch-goal          브리핑 팩 생성 + 프롬프트 조립         │
│                         (실행 안 함, 프롬프트만 반환)          │
│                                                                │
│  execute-goal           Paperclip Issue 생성 + 조기 반환       │
│                         (§3.1 async path)                     │
│                         localExecute:true는 legacy dev-loop   │
│                                                                │
│  project-status         레지스트리에 등록된 프로젝트 목록      │
│                                                                │
│  goal-status            추적 중인 goals.json 상태 덤프         │
│                         (projectName 필터 가능)                │
│                                                                │
├──────────────────────────────────────────────────────────────┤
│           Data providers (not tools, data fetchers)            │
├──────────────────────────────────────────────────────────────┤
│                                                                │
│  projects               listProjects() → ~/.vela/projects.json│
│                                                                │
└──────────────────────────────────────────────────────────────┘
```

### 14.5 현재 배포 상태 (2026-04-11 시점)

```
Company:    bddcbe42-1913-485b-88ae-54a7b0866f59  (local solo company)
Project:    [VELA] vela-union                      (registered, selfhost)
            id=2ca0bfb2-d877-42ba-b8f0-e7ba2c15d2e1

Agents:
  CEO  (8a0c3b53-…)  role=ceo,  instructions=generic 3-line
  CTO  (e27888b7-…)  role=cto,  instructions=generic 3-line

Runtime:
  launchd com.vela.paperclip (RunAtLoad, KeepAlive)
  → Paperclip server :3100
  → Vela Union plugin worker (forked)
  → PostgreSQL @ :54329 (embedded)
```

---

## 15. PageIndex 로컬 Claude CLI 백엔드

"PageIndex를 Vectify API 없이 어떻게 돌리는가?" — litellm 런타임 몽키패치.

PageIndex OSS(`refs/PageIndex/pageindex`)는 내부적으로 `litellm.completion` / `litellm.acompletion`을 호출해 LLM 추론을 한다. Vela Union은 이 두 심볼을 import 전에 monkey-patch해서 모든 호출을 로컬 `claude -p` 서브프로세스로 라우팅한다. 결과적으로 **추가 API 키 없이** 사용자의 Claude 구독 쿼타로 PageIndex가 돌아간다.

### 15.1 전체 구조

```
   PageIndex OSS (pageindex 파이썬 패키지)
          │
          │ from litellm import completion, acompletion
          │ (임포트 시점에 심볼 lookup)
          ▼
   ┌────────────────────────────────┐
   │     litellm 모듈 (실제)        │
   │                                │
   │  litellm.completion = ???     │ ◀── 몽키패치 대상
   │  litellm.acompletion = ???    │
   └────────────┬───────────────────┘
                │
                │ (vela가 pageindex 호출 전에 patch_litellm() 호출)
                ▼
   ┌────────────────────────────────┐
   │   scripts/claude_cli_llm.py    │
   │                                │
   │  fake_litellm_completion       │ ── sync path
   │    └── call_claude_cli()       │
   │          │                     │
   │          └── subprocess.run(   │
   │                [CLAUDE_BIN,    │
   │                 "-p",          │
   │                 full_prompt])  │
   │                                │
   │  fake_litellm_acompletion      │ ── async path
   │    └── semaphore(3)            │   ★ memory safety
   │    └── run_in_executor(        │
   │          call_claude_cli)      │
   │                                │
   │  FakeLiteLLMResponse           │ ── litellm.ModelResponse 부분 shim
   │    .choices[0].message.content │
   │    .choices[0].finish_reason   │
   │    __getitem__ (dict form)     │
   └────────────┬───────────────────┘
                │ (인증 시 HOME 필수 — env={**os.environ})
                ▼
   ┌────────────────────────────────┐
   │  claude CLI subprocess         │
   │  stateless per call            │
   │  ~/.claude/.credentials.json   │
   └────────────────────────────────┘
```

### 15.2 Semaphore 메모리 안전망

PageIndex OSS의 `md_to_tree()`는 문서의 각 섹션에 대해 `asyncio.gather()`로 LLM 호출을 병렬 fan-out한다. 30+ 섹션짜리 큰 마크다운 하나만으로도 30+개의 Claude CLI 서브프로세스가 동시에 spawn된다. 각 프로세스가 300–500MB를 차지하므로 빌드 큐가 큰 문서 몇 개를 병렬 처리하면 **100GB+ 메모리 소진 + 시스템 다운**이 실제로 발생했다 (2026-04-11 프로덕션 관측).

해결책: 프로세스 레벨 asyncio.Semaphore로 동시 spawn을 캡.

```python
# scripts/claude_cli_llm.py
DEFAULT_CONCURRENCY = int(
    os.environ.get("VELA_CLAUDE_CLI_CONCURRENCY", "3")
)

_async_semaphore: Optional[asyncio.Semaphore] = None

def _get_semaphore() -> asyncio.Semaphore:
    global _async_semaphore
    if _async_semaphore is None:
        _async_semaphore = asyncio.Semaphore(DEFAULT_CONCURRENCY)
    return _async_semaphore

async def fake_litellm_acompletion(...):
    ...
    sem = _get_semaphore()
    async with sem:                    # ◀── 블록
        content = await loop.run_in_executor(
            None, lambda: call_claude_cli(prompt, ...)
        )
    return FakeLiteLLMResponse(content)
```

**왜 lazy initialization인가.** `asyncio.Semaphore`는 Python 3.10+에서 생성 시점의 event loop에 바인딩된다. 모듈 레벨에서 생성하면 import 타이밍에 따라 "다른 loop에 바인딩된 semaphore" 예외가 발생한다. `_get_semaphore()` lazy factory가 첫 사용 시점(이미 loop 안)에서 생성해 이 문제를 회피한다.

**왜 프로세스 레벨인가.** 동일 Python 프로세스 안에서의 `asyncio.gather()` fan-out만 제어하면 충분하다. 여러 Python 프로세스가 동시에 떠도 각자 3개씩 × N 프로세스가 되지만, 빌드 큐가 concurrency=1로 동작하므로 실제 동시 프로세스는 1이다. 즉 시스템 전체 최대 Claude CLI 서브프로세스 = 3.

`VELA_CLAUDE_CLI_CONCURRENCY` 환경변수로 오버라이드 가능. launchd plist에서 3으로 설정되어 있다(§8.1 참조).

### 15.3 HOME 상속 요구

claude_cli_llm.py의 `call_claude_cli()`는 subprocess에 `env={**os.environ}`을 그대로 넘긴다 — HOME을 포함한 전체 환경이 상속된다. Python 프로세스가 HOME 없이 시작되면 (예: cron 등의 cleanroom 환경) Claude CLI가 `~/.claude/.credentials.json`을 못 찾고 "Not logged in" 에러를 낸다.

Vela Union의 PageIndex 경로는 두 가지 방식으로 보호된다:
1. **MCP Gateway를 통한 호출**: Node가 Python spawn 시 `env: process.env`를 전달. Node는 이미 HOME을 갖고 있으므로 Python도 갖게 된다.
2. **수동 CLI 호출**: 사용자의 쉘에서 호출되므로 HOME 기본 존재.

§8.1의 플러그인 워커 env injection 체인과는 **별도의 경로**다 — PageIndex 경로는 Node → Python → Claude CLI이고, 플러그인 워커 경로는 Node → Node fork → Claude CLI이다.

### 15.4 Backend 추적 (VELA-25)

`CloudIndexEntry`와 `CloudStatusFile.docs[*]`는 각 레코드가 어느 backend에 의해 생성/갱신됐는지 추적하는 optional 필드를 가진다.

```typescript
export interface CloudIndexEntry {
  originalPath: string;
  md5: string;
  docId: string;
  treePath: string;
  indexedAt: string;
  converted: boolean;
  convertedPdfPath?: string;
  // VELA-25: optional for BC with pre-VELA-25 records.
  // Reader가 undefined를 만나면 "unknown"으로 간주하고
  // explicit --backend 필터에서 제외한다.
  backend?: "vectify-cloud" | "local-claude-cli";
}
```

**Writer 책임**: 두 backend(`indexViaCloud`, `indexViaLocalClaudeCli`)는 성공 시 write + 실패 시 `updateCloudStatusEntry` 모두에서 `backend` 필드를 명시적으로 주입한다. Legacy `indexViaLocal` (third backend, `LegacyDocumentRecord` schema) 은 `index.json`을 건드리지 않으므로 이 필드와 무관하다.

**Reader 책임** (`vela index --list`):
- 기본 mode: `index.json` 읽기 → `record.backend`가 있는 레코드에 대해 `--backend <name>` 필터 적용. 없는 레코드는 `backend=?`로 표시되고 explicit 필터에서 제외.
- `--failed` mode: `status.json` 읽기 → `state === "failed"` 레코드 중 `--backend` 매칭만 표시. `status.json`의 `docs[*].backend`가 짝이 되어 correlation 가능.

**왜 별도 failures.jsonl을 만들지 않았나**: `CloudStatusFile`이 이미 per-doc `state: "pending" | "indexing" | "indexed" | "failed"` 추적을 하고 있고, 실패 시 `error` 메시지와 `lastAttemptAt`도 기록한다. 따라서 `--failed`는 새 저장소 없이 기존 status.json을 읽는 걸로 충분하다. Net 스키마 변경은 `backend?` 한 필드뿐.

---

## 16. gbrain — 장기 기억 레이어

"내가 지금까지 뭘 결정했고 왜 그랬는가? 시간 축으로 무엇이 쌓였는가?"

### 16.1 5시스템 역할 경계

| 시스템 | 역할 | 핵심 질문 | 입력 단위 | 검색 방식 |
|--------|------|----------|----------|----------|
| **Paperclip** | 거버넌스 | 누가 언제 무엇을? | 이슈/에이전트 | API 쿼리 |
| **gstack** | 실행 | 어떻게? | 스킬/목표 | CLI 호출 |
| **Graphify** | 코드 구조 | 어떻게 연결되는가? | 폴더 전체 (AST) | 그래프 위상 |
| **PageIndex** | 문서 추론 | 문서 안에 무엇이? | 개별 PDF/문서 | LLM 트리 탐색 |
| **gbrain** | **장기 기억** | **무엇을 알고 있는가?** | **마크다운 수천 개** | **하이브리드 (벡터+키워드+RRF)** |

**경계 규칙 (중복 저장 방지):**
- ❌ gbrain에 코드 자체 저장 금지 → Graphify 영역
- ❌ gbrain에 단일 문서 내부 구조 저장 금지 → PageIndex 영역
- ✅ gbrain 전용: 사람/회사/결정/아이디어/미팅/프로젝트 엔티티 페이지, 크로스 프로젝트 관계

### 16.2 로컬 아키텍처

```
┌───────────────────────────────────────────────────┐
│                  MCP Gateway                       │
│            knowledge.* (4 tools)                   │
└────────────────────┬──────────────────────────────┘
                     │
                     ▼
┌───────────────────────────────────────────────────┐
│              gbrain (TypeScript/Bun)               │
│   fork: github.com/JakeB-5/gbrain                 │
│                                                    │
│   ┌─────────────┐  ┌───────────────┐              │
│   │  Ollama      │  │   PGLite      │              │
│   │  bge-m3      │  │   (로컬 PG)    │              │
│   │  1024d 임베딩 │  │   pgvector    │              │
│   └─────────────┘  └───────────────┘              │
│                                                    │
│   검색: 벡터 + 키워드 + RRF 융합                    │
│   쿼리 확장: Claude Haiku (선택적)                   │
└───────────────────────────────────────────────────┘
```

### 16.3 MCP 도구 표면

| 도구 | 기능 | 대응 gbrain 명령 |
|------|------|-----------------|
| `knowledge.search` | 의미 검색 (하이브리드 RRF) | `gbrain query <q> --no-expand` |
| `knowledge.get` | 엔티티 페이지 읽기 | `gbrain get <slug>` |
| `knowledge.put` | 엔티티/결정 기록 | `gbrain put <slug>` |
| `knowledge.stats` | brain 통계 (페이지/청크/임베딩) | `gbrain stats` |

### 16.4 Paperclip 연동 계획

- **Briefing Pack**: `issue.created` → `knowledge.search "{goal}"` 결과를 컨텍스트로 주입
- **결정 기록**: `issue.resolved` → `knowledge.put "decisions/{slug}"` 으로 타임라인 append
- **에이전트 부팅**: `agent.woke` → 현재 프로젝트의 gbrain 컨텍스트 자동 로드

### 16.5 검증 결과 (Phase 1 PoV, 2026-04-13)

- **데이터**: 대형 프로젝트 docs 230개 마크다운, 2101 청크
- **임베딩**: Ollama bge-m3 (1024d), 완전 로컬, $0
- **검색 품질**: 한/영 혼합 쿼리에서 관련 문서 정확 반환 (score 0.84~1.0)
- **판정**: Go — grep 대비 의미 검색 우위 확인

---

## 참고 문서

- [README.md](../README.md) — 사용자용 문서
- [docs/integration-plan.md](integration-plan.md) — 초기 4-system 통합 계획
- [docs/gbrain-adoption.md](gbrain-adoption.md) — gbrain 도입 검토 문서
- `~/.gstack/projects/vela-union/jin-master-design-20260411-001202.md` — 통합 설계 문서
- `~/.gstack/projects/vela-union/jin-master-eng-review-test-plan-*.md` — 엔지니어링 리뷰 테스트 플랜
- Paperclip upstream: [routes/agents.ts](../refs/paperclip/server/src/routes/agents.ts), [routes/issues.ts](../refs/paperclip/server/src/routes/issues.ts), [middleware/auth.ts](../refs/paperclip/server/src/middleware/auth.ts), [services/heartbeat.ts](../refs/paperclip/server/src/services/heartbeat.ts)
