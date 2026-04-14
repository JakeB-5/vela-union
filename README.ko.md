# Vela Union

**Language**: [English](README.md) · 한국어

**여러 프로젝트를 AI 에이전트와 함께 운영하는 로컬 오케스트레이션 플랫폼.**

5개의 오픈소스 시스템(Paperclip, gstack, Graphify, PageIndex, gbrain)을 단일 MCP 게이트웨이 + Paperclip 플러그인으로 통합한다. 프로젝트별 세션을 따로 열지 않아도 목표를 디스패치하면 에이전트가 컨텍스트를 로드하고 실행한다.

> **🤖 AI Agent: 이 문서를 읽고 있다면** — [에이전트 자동 설치 가이드](#-agents-read-here-auto-install-guide) 섹션으로 바로 이동.

---

---

## 🤖 Agents, Read Here — Auto-Install Guide

**다른 PC에서 AI 에이전트가 이 가이드를 따라 Vela Union을 자동 설치하는 경로.**

<details>
<summary>설치 단계 펼치기</summary>

### Prerequisites (설치 전 확인)

```bash
# Required
node --version    # >= 22
pnpm --version    # >= 10
python3 --version # >= 3.13
git --version
bun --version     # required for gbrain

# Check and install missing items via:
# - node/pnpm: https://pnpm.io/installation
# - python3: https://www.python.org/downloads/
# - bun: curl -fsSL https://bun.sh/install | bash
# - ollama: https://ollama.com (for local gbrain embeddings)
```

### Installation Steps

```bash
# 1. Clone vela-union
git clone https://github.com/JakeB-5/vela-union ~/projects/vela-union
cd ~/projects/vela-union

# 2. Install dependencies
pnpm install

# 3. Install gbrain fork (local LLM version with Ollama)
bun add -g github:JakeB-5/gbrain

# 4. Install Ollama embedding model (gbrain requires this)
ollama pull bge-m3

# 5. Run full bootstrap (12 steps)
pnpm vela setup
# This will:
#  - Initialize ~/.vela/ directory structure
#  - Clone + build + start Paperclip daemon
#  - Build Paperclip SDK
#  - Install Python venv + Graphify
#  - Install PageIndex
#  - Build Vela Union TypeScript packages
#  - Install Vela plugin to Paperclip
#  - Register MCP gateway in Claude settings
#  - Install launchd agent (macOS auto-start)
#  - Verify end-to-end

# 6. Initialize gbrain knowledge base
gbrain init

# 7. Register your projects
vela register ~/projects/my-project-1 --type personal
vela register ~/projects/my-project-2 --type company
# OR via Paperclip dashboard: http://127.0.0.1:3100
#   - New Project → specify Local folder path
#   - Plugin auto-registers + bootstraps Graphify/gbrain/PageIndex

# 8. Verify
vela status
# Should show 5 systems all green
```

### Claude Code MCP + `/vela` Skill Setup

**에이전트는 사용자에게 설치 범위를 질문해야 함** (사용자의 선호에 따라 결정):

> **Ask user:**
> "Vela의 MCP gateway와 `/vela` 슬래시 커맨드를 어떻게 설치할까요?
>  - **(A) 전역** — 모든 프로젝트의 Claude Code 세션에서 Vela 사용 가능 (권장)
>  - **(B) 로컬만** — vela-union 프로젝트에서만 사용, 다른 프로젝트는 영향 없음"

#### Option A: Global Install (모든 프로젝트에서 사용)

```bash
# 1. MCP Gateway를 Claude user scope에 등록
claude mcp add-json -s user vela-union \
  '{"command":"node","args":["'"$HOME"'/projects/vela-union/packages/mcp-gateway/dist/server.js"]}'

# 2. /vela 슬래시 커맨드를 전역 설치
mkdir -p ~/.claude/skills/vela
cp ~/projects/vela-union/.claude/skills/vela/SKILL.md ~/.claude/skills/vela/SKILL.md

# 3. 확인
claude mcp list | grep vela-union   # → ✓ Connected
```

**효과**: 어떤 프로젝트의 Claude Code 세션에서든 `knowledge.search`, `graph.query`, `/vela status` 등 사용 가능.

#### Option B: Local Install (vela-union 프로젝트에서만)

```bash
# 1. MCP Gateway를 프로젝트 scope로 등록
cd ~/projects/vela-union
claude mcp add-json -s project vela-union \
  '{"command":"node","args":["'"$HOME"'/projects/vela-union/packages/mcp-gateway/dist/server.js"]}'

# 2. /vela 스킬은 이미 .claude/skills/vela/SKILL.md로 프로젝트에 배포되어 있음
#    (전역 설치 불필요, 다른 프로젝트에서는 사용 안 됨)
```

**효과**: vela-union 디렉토리 내부에서만 Vela 도구 사용. 다른 프로젝트의 Claude Code 세션은 Vela를 모름.

#### Bug reports

**이 스킬/MCP 사용 중 문제 발생 시** — https://github.com/JakeB-5/vela-union/issues 에 이슈 등록.

### Verification (agent self-check)

Run each and confirm no errors:

```bash
vela status                            # 5 systems green
gbrain stats                           # Pages > 0 OR new install
curl -sf http://127.0.0.1:3100/api/health | grep ok
claude mcp list | grep vela-union      # Connected
```

### Troubleshooting

| Symptom | Fix |
|---------|-----|
| `paperclip not running` | `launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.vela.paperclip.plist` |
| `gbrain: command not found` | `export PATH="$HOME/.bun/bin:$PATH"` in shell profile |
| `ollama connection refused` | `ollama serve` in background |
| Plugin 404 on install | Check `http://127.0.0.1:3100/api/plugins` — reinstall via `curl -X POST .../api/plugins/install` |

**Issue reports:** https://github.com/JakeB-5/vela-union/issues

</details>

---

## 문제

여러 프로젝트에 AI 에이전트를 반복적으로 투입할 때 마주치는 문제들.

- 프로젝트마다 세션을 새로 띄우고 컨텍스트를 처음부터 설명한다
- 대규모 코드베이스에서 광범위 탐색으로 토큰이 낭비된다
- 프로젝트 간 관계와 메타데이터를 매번 수동으로 주입한다
- 스펙 문서를 참조하지 못해 엉뚱한 구현이 나온다
- 병렬 실행 시 워크트리 관리와 통합이 병목이 된다

Vela Union은 이 영역들을 하나의 레이어로 통합한다.

## 아키텍처

```
┌──────────────────────────────────────────────────────────┐
│                  Paperclip (지휘 & 거버넌스)               │
│         Vela Union 플러그인으로 이벤트/도구 등록            │
│         project.created → 자동 부트스트랩 (5 시스템 초기화) │
│         issue.updated → 결정 자동 기록 (gbrain)            │
│         Vela Status 탭: 프로젝트별 5시스템 상태 + 액션       │
└──────────┬─────────────────────────────────────┬─────────┘
           │                                     │
    ┌──────▼──────┐                       ┌──────▼──────┐
    │   gstack    │                       │ MCP Gateway │
    │  (실행 계층) │                       │  (통합 도구) │
    │ /qa /review │                       │  18+ 도구    │
    │ /ship /...  │                       └──────┬──────┘
    └─────────────┘                              │
                ┌─────────────────┬──────────────┼──────────────┬──────────────┐
                │                 │              │              │              │
          ┌─────▼─────┐     ┌─────▼─────┐  ┌────▼─────┐  ┌─────▼────┐  ┌─────▼─────┐
          │ Graphify  │     │  gbrain   │  │PageIndex │  │  gstack  │  │   vela    │
          │(코드 구조)│     │ (기억/지식)│  │(문서 구조)│  │(프록시)  │  │ (메타)    │
          └───────────┘     └───────────┘  └──────────┘  └──────────┘  └───────────┘
```

### 5개 시스템의 역할

| 시스템 | 역할 | 핵심 질문 | 스코프 |
|--------|------|----------|--------|
| **Paperclip** | 조직 & 거버넌스. 에이전트를 "직원"으로 고용, 조직도 관리 | 누가 언제 무엇을 하는가? | 전역 |
| **gstack** | 실행 능력. Claude Code를 전문가 팀으로 변환 | 어떻게 리뷰/테스트/배포하는가? | 전역 |
| **Graphify** | 코드 구조 그래프. AST + 커뮤니티 클러스터링 | 코드가 어떻게 연결되어 있나? | 프로젝트별 |
| **PageIndex** | 문서 이해. LLM 추론 기반 문서 내부 트리 탐색 | 문서 3장에 뭐가 있나? | 프로젝트별 |
| **gbrain** | 장기 기억. 하이브리드 벡터+키워드 검색, 크로스 프로젝트 | 지난주 결정이 뭐였지? | 전역 (Ollama bge-m3) |

### 데이터 플로우

```
사용자  ─ vela dispatch foo "goal" ─►  Paperclip 플러그인
                                           │
                                           ▼
                                     Briefing Pack 생성
                              (git log + dir tree + churn files + docs)
                                           │
                                           ▼
                                    Claude Code 디스패치
                                           │
                                           ▼
                                 MCP Gateway로 graph/doc 쿼리
                                           │
                                           ▼
                                  결과 → 결정 자동 기록
                                           │
                                           ▼
                                 graph.refresh (fire-and-forget)
```

---

## 빠른 시작

### 1. 설치 (최초 1회)

```bash
git clone <your-repo>/vela-union ~/projects/vela-union
cd ~/projects/vela-union
pnpm install
pnpm vela setup
```

`vela setup`이 12단계를 자동으로 진행한다.

1. `~/.vela/` 디렉토리 초기화
2. Paperclip 클론 + 빌드 + 데몬 기동
3. Paperclip SDK 빌드
4. gstack 존재 확인 (`~/.claude/skills/gstack/`)
5. Python venv + Graphify 설치
6. PageIndex 설치
7. Vela Union TypeScript 빌드
8. Vela 플러그인을 Paperclip에 install (HTTP API)
9. Claude Code `settings.json`에 MCP 게이트웨이 등록 (자동 백업)
10. `~/.vela/` 디렉토리 구조 초기화
11. launchd 에이전트 설치 (macOS, 동의 프롬프트)
12. 전체 시스템 최종 검증

launchd를 수락하면 재부팅 시 Paperclip이 자동으로 기동된다.

### 2. 프로젝트 등록

```bash
vela register ~/projects/project-a
vela register ~/projects/project-b --type company
vela register ~/projects/project-c --type personal
```

등록은 즉시 반환되고, Graphify 지식 그래프는 백그라운드 큐에서 직렬로 빌드된다 (동시성 1, 10분 타임아웃).

### 3. 상태 확인

```bash
vela status
```

```
Preflight
  ✓ Node.js v24.14.0 — >= 22
  ✓ pnpm v10.32.1
  ✓ Python v3.14.3
  ✓ git v2.53.0
Systems
  ✓ Paperclip — running on http://127.0.0.1:3100
  ✓ gstack — skills found at ~/.claude/skills/gstack
  ✓ Graphify v0.4.0 — installed in venv
  ✓ PageIndex — importable from refs/PageIndex
  ✓ MCP Gateway — packages/mcp-gateway/dist/server.js
Graphs
  ~ project-a — building (started 30s ago)
  ✓ project-b — built (2.1s)
  - project-c — missing (not queued)
```

### 4. 목표 디스패치

```bash
vela dispatch project-a "로그인 기능에 OAuth 추가"
```

또는 Claude Code 안에서 `execute-goal` 도구를 직접 호출.

---

## 주요 명령어

### CLI

```bash
vela setup                              # 1회 설치 bootstrap
vela status                             # 4개 시스템 + 그래프 상태
vela start                              # Paperclip 데몬 수동 기동
vela stop                               # Paperclip 데몬 정지
vela register <path>                    # 프로젝트 등록 + 그래프 백그라운드 빌드
vela unregister <name>                  # 프로젝트 제거 + Paperclip DELETE (VELA-13)
vela prune [--dry-run] [--no-paperclip] # path 사라진 orphan 엔트리 일괄 제거 (VELA-13)
vela list                               # 등록된 프로젝트 조회
vela dispatch <project> <goal>          # 목표 실행
vela index <project>                    # PageIndex 문서 인덱싱
vela index --list [options]             # 인덱싱된 문서 조회 (필터 지원)
vela index --list --project <name>      # 프로젝트 필터 (VELA-18)
vela index --list --sort oldest|newest  # 날짜 정렬 (VELA-18)
vela index --list --backend <name>      # backend 필터 (VELA-25)
vela index --list --failed              # 실패한 문서만 조회 (VELA-25)
vela logs [options]                     # 통합 로그 조회
vela sync-from-paperclip                # Paperclip 프로젝트 → 로컬 레지스트리 역동기화
```

### 글로벌 플래그

모든 명령어에 적용된다.

```bash
vela --verbose setup              # 실행 중 구조화 로그를 stderr로 출력
vela --debug status               # debug 레벨 + verbose
vela --quiet list                 # stderr 출력 억제 (파일 싱크만)
vela --log-level warn ...         # 최소 레벨 설정
vela --cid abc123 ...             # 상관 ID 지정 (외부 트레이싱용)
vela --no-log ...                 # 싱크 쓰기 비활성화
```

### MCP 게이트웨이 도구 (Claude Code에서 호출)

총 18+개 도구가 5개 네임스페이스로 노출된다.

| 네임스페이스 | 도구 |
|------------|------|
| `knowledge.*` (4) | `knowledge.search`, `knowledge.get`, `knowledge.put`, `knowledge.stats` (gbrain — 하이브리드 벡터+키워드 RRF) |
| `doc.*` (3) | `doc.index`, `doc.get_structure`, `doc.get_pages` |
| `graph.*` (6) | `graph.build`, `graph.query`, `graph.get_neighbors`, `graph.get_node`, `graph.stats`, `graph.refresh` |
| `gstack.*` (4) | `gstack.execute_skill`, `gstack.dispatch_goal`, `gstack.list_goals`, `gstack.check_availability` |
| `vela.*` (1) | `vela.list_projects` |

`graph.query`는 그래프가 없으면 `{status: "building", retryAfterSec: 120}`을 반환하고 백그라운드 빌드를 큐잉한다. 절대 블로킹하지 않는다.

`knowledge.search`는 Ollama bge-m3 임베딩으로 벡터 검색 + tsvector 키워드 검색을 RRF로 융합. 한/영 혼합 쿼리 지원.

### Claude Code 슬래시 커맨드 (`/vela` skill)

모든 프로젝트에서 사용 가능한 5개 커맨드.

| 커맨드 | 기능 |
|--------|------|
| `/vela status` | 포트폴리오 상태 (프로젝트 + 이슈 + 에이전트) |
| `/vela search <query>` | 크로스 프로젝트 지식 검색 (gbrain) |
| `/vela context` | 현재 프로젝트의 Graphify + gbrain + PageIndex 컨텍스트 로드 |
| `/vela dispatch <project> <goal>` | 다른 프로젝트로 목표 위임 |
| `/vela register` | 현재 프로젝트를 Vela에 등록 |

---

## 핵심 컴포넌트 설명

### Briefing Pack

프로젝트마다 자동 생성되는 컨텍스트 번들. Graphify 완성 전에도 탐색 효율을 개선한다.

- 구성: `git log -50` + directory tree (depth 3) + high-churn files (30일) + README.md + CLAUDE.md + 수동 핀(`{project}/.vela/pins.txt`)
- 생성 시간: 60-150ms (대규모 프로젝트 기준)
- 크기: 약 8KB 구조화 프롬프트

### Build Queue

자동 활성화 레이어의 핵심.

- 파일 기반 JSONL 큐 (`~/.vela/build-queue.jsonl`)
- 동시성 1 (직렬 실행으로 CPU/메모리 보호)
- POSIX append-atomic 쓰기
- 10분 타임아웃, SIGTERM 정리
- 각 프로젝트별 `~/.vela/graphify/{project}/status.json`에 상태 기록 (`missing` / `building` / `built` / `failed`)
- 중앙 로그 `~/.vela/logs/graph-build.log`

### Startup Scanner

Paperclip 플러그인이 기동될 때 `queueMicrotask`로 비동기 실행.

- 레지스트리의 모든 프로젝트를 스캔
- 누락된 그래프 발견 → 큐에 enqueue
- 삭제된 프로젝트 경로 → 경고 로그
- 이미 큐에 있는 항목 → 중복 제거

### Feedback Loop (Phase 5)

`execute-goal`이 성공하면 자동으로 실행된다.

- 실행 출력에서 결정 추출 (휴리스틱 정규식: `decided`, `chose`, `rejected`, `tradeoff`, `assumption`)
- `~/.vela/decisions/{project}/{goalId}.md`에 기록
- 프로젝트 레벨 `log.md`에 append
- 크로스 프로젝트 영향 탐지 (touched files가 관련 프로젝트 문서에 언급되는지)
- `graph.refresh`를 fire-and-forget으로 트리거

### Git Post-Commit Hook

선택적. 커밋 시 그래프 자동 갱신.

```bash
./scripts/install-git-hook.sh ~/projects/myproject
```

- 기존 훅은 자동 백업
- 멱등성 (한 번만 설치)
- 실패해도 커밋은 차단하지 않음

---

## 관찰가능성 (Observability)

모든 명령어, 모든 도구 호출, 모든 백그라운드 작업이 구조화된 JSONL로 기록된다.

### 단일 싱크

`~/.vela/logs/vela.jsonl` — 한 파일에 전부.

각 엔트리:
```json
{
  "ts": "2026-04-11T12:34:56.789Z",
  "level": "info",
  "component": "gateway.tool.graph.query",
  "cid": "abc12345",
  "msg": "handler start",
  "data": {"projectName": "project-a"},
  "duration_ms": 42,
  "pid": 1234
}
```

### 상관 ID (Correlation ID)

명령 하나를 실행하면 고유 cid가 생성되어 CLI → 플러그인 → 게이트웨이 → 워커까지 전 체인에 전파된다.

### 로그 조회

```bash
# 단일 실행 트레이스
vela logs --cid abc12345

# MCP 도구 호출 실시간 감시
vela logs gateway.tool. --tail

# 최근 24시간 에러만
vela logs --level error --since 24h

# 부분 문자열 검색
vela logs --grep "graphify"

# 특정 컴포넌트
vela logs cli.setup

# 생 JSON 출력
vela logs --cid abc12345 --raw
```

지원 필터: `--cid`, `--level`, `--since`, `--until`, `--grep`, `--limit`, `--tail`, `--raw`, `--sink`, 위치 인자(component prefix).

### 데이터 보호

- 시크릿 키워드 자동 redaction (api_key, token, password, secret)
- 페이로드 32KB 초과 시 자동 truncation + `{_truncated: true}` 마커
- 로거 자체 에러는 조용히 무시 (로깅 실패가 명령을 깨뜨리지 않도록)

---

## 파일 레이아웃

### 프로젝트 구조

```
vela-union/
├── packages/
│   ├── shared/              # 공통 타입, 레지스트리, 로거, 피드백, 목표 추적
│   ├── paperclip-plugin/    # Paperclip 플러그인 (definePlugin)
│   │   └── src/
│   │       ├── plugin.ts         # 메인 플러그인 정의
│   │       ├── briefing.ts       # Briefing Pack 생성기
│   │       ├── dispatch.ts       # 프롬프트 조립
│   │       ├── startup-scanner.ts # 부팅 시 그래프 스캔
│   │       └── manifest.ts       # 플러그인 메타데이터
│   ├── gstack-adapter/      # Claude Code CLI 연동
│   ├── mcp-gateway/         # 통합 MCP 서버
│   │   └── src/
│   │       ├── server.ts         # stdio MCP 서버 (14 tools)
│   │       ├── pageindex.ts      # PageIndex 래퍼
│   │       ├── graphify.ts       # Graphify 래퍼
│   │       ├── gstack-proxy.ts   # gstack 레지스트리 인식 래퍼
│   │       └── build-queue.ts    # 자동 활성화 큐 + 워커
│   └── vela-cli/            # 메인 CLI
│       └── src/
│           ├── cli.ts            # 엔트리포인트 + 글로벌 플래그
│           ├── commands/         # 8개 서브커맨드
│           └── util/             # context, detect, paths, proc, http, log
├── scripts/                 # 테스트 + 유틸리티 스크립트
├── refs/                    # 4개 업스트림 시스템 참조 (gitignored)
└── docs/                    # 설계 문서
```

### 런타임 디렉토리 (`~/.vela/`)

```
~/.vela/
├── projects.json            # 프로젝트 레지스트리
├── goals.json               # 목표 추적 (Phase 2)
├── config.json              # 사용자 설정
├── build-queue.jsonl        # 빌드 큐 (append-only)
├── graphify/
│   └── {project}/
│       ├── graph.json       # 지식 그래프
│       └── status.json      # 빌드 상태
├── decisions/
│   └── {project}/
│       ├── {goalId}.md      # 목표별 결정 기록
│       └── log.md           # 프로젝트 결정 로그
├── pageindex/
│   └── {docId}/             # PageIndex 캐시
├── logs/
│   ├── vela.jsonl           # 통합 구조화 로그 (메인)
│   ├── graph-build.log      # 빌드 워커 자유 형식 로그
│   ├── paperclip.log        # Paperclip 서버 stdout
│   ├── paperclip.err        # Paperclip 서버 stderr
│   └── paperclip-launchd.*  # launchd 출력
└── pids/
    └── paperclip.pid
```

---

## 개발

### 빌드

```bash
npx tsc --build              # 증분 빌드
npx tsc --build --clean      # 클린 빌드
pnpm -r build                # 모든 워크스페이스 빌드
```

### 테스트

모든 테스트 스크립트는 `scripts/test-*.ts`에 있고 `tsx`로 직접 실행한다. 테스트 프레임워크 의존성은 없고, 단순 `passed/failed` 카운터 패턴.

```bash
npx tsx scripts/test-briefing.ts          # Briefing Pack 생성기
npx tsx scripts/test-registry.ts          # 프로젝트 레지스트리
npx tsx scripts/test-dispatch.ts          # Dispatch 프롬프트 조립
npx tsx scripts/test-adapter.ts           # gstack 어댑터 (31)
npx tsx scripts/test-feedback.ts          # 피드백 루프 (28)
npx tsx scripts/test-graphify.ts          # Graphify 통합
npx tsx scripts/test-mcp-gateway.ts       # 통합 MCP 게이트웨이 (31)
npx tsx scripts/test-auto-activation.ts   # 자동 활성화 레이어 (47)
npx tsx scripts/test-observability.ts     # 관찰가능성 레이어 (69)
npx tsx scripts/test-bootstrap.ts         # vela CLI (33; includes VELA-13/18/25 smokes)
```

### 모노레포 관리

- pnpm workspaces (`pnpm-workspace.yaml`)
- TypeScript 6.0, ESM (`"type": "module"`), `verbatimModuleSyntax`
- TypeScript project references (composite)
- 워크스페이스 간 의존은 `workspace:*`로 선언
- 순환 의존 회피: `startup-scanner.ts`가 `build-queue.js`를 동적 import (`await import(specifier)`)

### 업스트림 참조

`refs/` 디렉토리는 업스트림 시스템의 참조 소스다. gitignored.

- Paperclip → `refs/paperclip/` (PLUGIN_SPEC, DEPLOYMENT-MODES 등 문서)
- gstack → `refs/gstack/` (skill 정의)
- Graphify → `refs/graphify/`
- PageIndex → `refs/PageIndex/`

실제 Paperclip은 별도로 `~/projects/paperclip`에 클론되어 있어야 한다 (`vela setup`이 자동 처리).

---

## 디자인 결정

### 왜 Paperclip이 아닌 별도 오케스트레이션 레이어를 만들지 않았나

Paperclip의 웹 플랫폼 + 플러그인 시스템이 이미 "에이전트를 직원으로 고용" 모델을 구현하고 있다. 별도 서버를 만드는 것은 unnecessary duplication. 대신 Paperclip의 플러그인 SDK 위에 Vela Union 기능을 얹었다.

### 왜 MCP를 통한 통합을 선택했나

Claude Code, Codex, Gemini 같은 AI 호스트가 전부 MCP를 지원한다. 단일 MCP 서버를 만들면 한 번 등록으로 모든 호스트에서 사용 가능. 언어 중립적 (Python Graphify + PageIndex를 TypeScript로 래핑).

### 왜 빌드 큐의 동시성을 1로 제한했나

Graphify는 tree-sitter 기반 AST 파싱으로 대규모 코드베이스 한 개에도 분 단위 시간과 수백 MB RAM을 소비한다. 동시 실행은 리소스 경합을 일으킨다. "Boring by default" — 직렬 큐가 단순하고 안전하다.

### 왜 `graph.query`가 블로킹하지 않나

MCP 도구 호출은 Claude Code의 대화 턴 안에서 일어난다. 2분 블로킹은 UX를 망가뜨리고 타임아웃을 유발한다. 대신 "building" 상태를 즉시 반환하고 백그라운드에서 빌드, Claude가 자연스럽게 retry하거나 briefing pack 폴백으로 전환하게 한다. 명시적 > 클레버.

### 왜 구조화 로그 단일 싱크인가

디버깅할 때 여러 로그 파일을 grep하는 것보다 cid 하나로 전체 실행 체인을 필터링하는 게 훨씬 빠르다. JSONL은 `jq`와 호환되고, `vela logs`는 그 위에 쉬운 인터페이스를 제공한다.

---

## 상태 및 로드맵

### 완료된 작업

- ✅ Spike (Paperclip, Graphify 로컬 검증)
- ✅ Phase 0: 모노레포 스캐폴딩
- ✅ Phase 1: Paperclip 플러그인 + Briefing Pack + 프로젝트 레지스트리
- ✅ Phase 2: gstack 어댑터 + 목표 추적
- ✅ Phase 3: PageIndex MCP 래퍼
- ✅ Phase 3.5: Graphify 통합 (대규모 프로젝트에서 수십 MB 규모 그래프 검증)
- ✅ Phase 4: 통합 MCP 게이트웨이 (14 tools)
- ✅ Phase 5: 피드백 루프 (결정 추출 + 크로스 프로젝트 영향)
- ✅ vela CLI (12단계 bootstrap + 10+ 서브커맨드)
- ✅ 자동 활성화 레이어 (Paperclip 부팅 스캔 + 지연 빌드 + launchd)
- ✅ 관찰가능성 레이어 (구조화 로깅 + cid 전파 + verbose 모드)
- ✅ Paperclip self-hosted 에이전트 오케스트레이션 — CEO/CTO 에이전트가 자기 자신의 자기개선 이슈를 heartbeat로 자율 소화
- ✅ 플러그인 워커 환경 주입 체인 — launchd → Paperclip → plugin-worker fork → Claude CLI (VELA-14)
- ✅ `execute-goal` async path — Paperclip Issue 생성 후 early-return으로 30s RPC timeout 회피 (VELA-17)
- ✅ PageIndex 로컬 Claude CLI 백엔드 — litellm 몽키패치 + asyncio.Semaphore로 동시성 캡 (메모리 폭주 방어)
- ✅ `vela unregister` / `vela prune` CLI — 프로젝트 레지스트리 관리 (VELA-13)
- ✅ `vela index --list` 리치 출력 — sort/size/nodes/--project/--backend/--failed (VELA-18, VELA-25)
- ✅ Build queue `stop()` race fix — in-flight tick await (VELA-15, bonus ESM/CJS 2차 race fix)
- ✅ Test-observability registry 누수 fix — try/finally + vela unregister CLI 재사용 (VELA-16)
- ✅ **gbrain 5번째 시스템 통합** — fork `JakeB-5/gbrain`, Ollama bge-m3 로컬 임베딩, `knowledge.*` 4 MCP tools, 하이브리드 RRF 검색 (VELA-34, VELA-35)
- ✅ **프로젝트 자동 부트스트랩** — `project.created` → Vela 레지스트리 자동 등록 + Graphify/gbrain/PageIndex 자동 초기화 (VELA-43~46)
- ✅ **`/vela` 슬래시 커맨드** — 모든 프로젝트에서 크로스 프로젝트 오케스트레이션 (VELA-39)
- ✅ **Paperclip 프로젝트 상세 탭** — Vela Status 탭 + 서브시스템별 수동 액션 버튼 (VELA-49, VELA-50, VELA-51)
- ✅ **Agent AGENTS.md 개선** — 빈 inbox 즉시 종료 safeguard, heartbeat protocol, atomic checkout (CTO v2)

---

## 업스트림

Vela Union은 다음 5개 오픈소스 프로젝트에 의존한다.

- **Paperclip** — https://github.com/paperclipai/paperclip
- **gstack** — https://github.com/garrytan/gstack
- **Graphify** — https://github.com/safishamsi/graphify
- **PageIndex** — https://github.com/VectifyAI/PageIndex
- **gbrain** — https://github.com/garrytan/gbrain (fork: https://github.com/JakeB-5/gbrain with local Ollama support)

---

## 라이선스

프로젝트 내 `LICENSE` 파일 참조. 업스트림 시스템의 라이선스는 각자 확인할 것.
