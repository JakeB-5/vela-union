# Vela Union

**Language**: English · [한국어](README.ko.md)

**A local orchestration platform for running multiple projects alongside AI agents.**

Vela Union unifies five open-source systems (Paperclip, gstack, Graphify, PageIndex, gbrain) behind a single MCP gateway and a Paperclip plugin. You dispatch a goal; the agent loads context and executes — no need to open a separate session per project.

> **🤖 AI Agent reading this?** — Jump straight to the [Auto-Install Guide](#-agents-read-here-auto-install-guide).

---

---

## 🤖 Agents, Read Here — Auto-Install Guide

**The path an AI agent on another machine should follow to install Vela Union automatically.**

### Prerequisites

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

**Agents must ask the user which install scope to use:**

> **Ask user:**
> "How should I install Vela's MCP gateway and the `/vela` slash command?
>  - **(A) Global** — available from any Claude Code session in any project (recommended)
>  - **(B) Local only** — usable inside the vela-union project only; other projects are untouched"

#### Option A: Global Install (available in every project)

```bash
# 1. Register MCP Gateway in Claude user scope
claude mcp add-json -s user vela-union \
  '{"command":"node","args":["'"$HOME"'/projects/vela-union/packages/mcp-gateway/dist/server.js"]}'

# 2. Install /vela slash command globally
mkdir -p ~/.claude/skills/vela
cp ~/projects/vela-union/.claude/skills/vela/SKILL.md ~/.claude/skills/vela/SKILL.md

# 3. Verify
claude mcp list | grep vela-union   # → ✓ Connected
```

**Effect**: `knowledge.search`, `graph.query`, `/vela status`, etc. become available in any Claude Code session.

#### Option B: Local Install (vela-union project only)

```bash
# 1. Register MCP Gateway in project scope
cd ~/projects/vela-union
claude mcp add-json -s project vela-union \
  '{"command":"node","args":["'"$HOME"'/projects/vela-union/packages/mcp-gateway/dist/server.js"]}'

# 2. /vela is already shipped at .claude/skills/vela/SKILL.md inside the project
#    (no global install needed; other projects won't see it)
```

**Effect**: Vela tools are only accessible from inside the vela-union directory. Claude Code sessions in other projects do not see Vela.

#### Bug reports

**If something breaks in this skill/MCP** — open an issue at https://github.com/JakeB-5/vela-union/issues.

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

---

## Problem

Recurring pain points when driving AI agents across several projects:

- A fresh session has to be spun up per project, and context is re-explained from scratch every time.
- Agents waste tokens on broad exploration of large codebases.
- Cross-project relationships and metadata must be injected manually, over and over.
- Spec documents go unread, producing off-target implementations.
- Parallel execution bottlenecks on worktree management and integration.

Vela Union collapses these concerns into a single layer.

## Architecture

```
┌──────────────────────────────────────────────────────────┐
│                 Paperclip (command & governance)          │
│        Registers events and tools via Vela plugin         │
│        project.created → auto-bootstrap (5 systems)       │
│        issue.updated → auto-record decisions (gbrain)     │
│        Vela Status tab: per-project 5-system view + actions │
└──────────┬─────────────────────────────────────┬─────────┘
           │                                     │
    ┌──────▼──────┐                       ┌──────▼──────┐
    │   gstack    │                       │ MCP Gateway │
    │ (execution) │                       │ (unified)   │
    │ /qa /review │                       │ 18+ tools   │
    │ /ship /...  │                       └──────┬──────┘
    └─────────────┘                              │
                ┌─────────────────┬──────────────┼──────────────┬──────────────┐
                │                 │              │              │              │
          ┌─────▼─────┐     ┌─────▼─────┐  ┌────▼─────┐  ┌─────▼────┐  ┌─────▼─────┐
          │ Graphify  │     │  gbrain   │  │PageIndex │  │  gstack  │  │   vela    │
          │  (code)   │     │ (memory)  │  │  (docs)  │  │ (proxy)  │  │  (meta)   │
          └───────────┘     └───────────┘  └──────────┘  └──────────┘  └───────────┘
```

### Roles of the five systems

| System | Role | Core question | Scope |
|--------|------|----------|--------|
| **Paperclip** | Organization & governance. Hires agents as "employees" and maintains the org chart | Who is doing what, when? | Global |
| **gstack** | Execution capability. Turns Claude Code into a team of specialists | How do we review/test/ship? | Global |
| **Graphify** | Code structure graph. AST + community clustering | How is the code connected? | Per-project |
| **PageIndex** | Document understanding. LLM-driven in-document tree exploration | What's in chapter 3 of the spec? | Per-project |
| **gbrain** | Long-term memory. Hybrid vector+keyword search across projects | What did we decide last week? | Global (Ollama bge-m3) |

### Data flow

```
user  ─ vela dispatch foo "goal" ─►  Paperclip plugin
                                           │
                                           ▼
                                    Briefing Pack assembled
                              (git log + dir tree + churn files + docs)
                                           │
                                           ▼
                                   Dispatched to Claude Code
                                           │
                                           ▼
                               graph/doc queries via MCP Gateway
                                           │
                                           ▼
                               results → decisions auto-recorded
                                           │
                                           ▼
                              graph.refresh (fire-and-forget)
```

---

## Quick start

### 1. Install (once)

```bash
git clone <your-repo>/vela-union ~/projects/vela-union
cd ~/projects/vela-union
pnpm install
pnpm vela setup
```

`vela setup` runs 12 steps automatically:

1. Initialize `~/.vela/` directory
2. Clone + build + start the Paperclip daemon
3. Build the Paperclip SDK
4. Verify gstack is present (`~/.claude/skills/gstack/`)
5. Install Python venv + Graphify
6. Install PageIndex
7. Build Vela Union TypeScript packages
8. Install the Vela plugin into Paperclip (HTTP API)
9. Register the MCP gateway in Claude Code `settings.json` (auto-backup)
10. Initialize the `~/.vela/` directory layout
11. Install a launchd agent (macOS, consent prompt)
12. Final end-to-end verification

If you accept the launchd install, Paperclip will start automatically on reboot.

### 2. Register projects

```bash
vela register ~/projects/project-a
vela register ~/projects/project-b --type company
vela register ~/projects/project-c --type personal
```

Registration returns immediately; Graphify knowledge graphs are built serially in a background queue (concurrency 1, 10-minute timeout).

### 3. Check status

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

### 4. Dispatch a goal

```bash
vela dispatch project-a "add OAuth to the login flow"
```

Or call the `execute-goal` tool directly from within Claude Code.

---

## Commands

### CLI

```bash
vela setup                              # one-time bootstrap
vela status                             # systems + graph state
vela start                              # start Paperclip daemon
vela stop                               # stop Paperclip daemon
vela register <path>                    # register project + background graph build
vela unregister <name>                  # remove project + Paperclip DELETE (VELA-13)
vela prune [--dry-run] [--no-paperclip] # purge entries whose path no longer exists (VELA-13)
vela list                               # list registered projects
vela dispatch <project> <goal>          # execute a goal
vela index <project>                    # index docs with PageIndex
vela index --list [options]             # list indexed docs (filters supported)
vela index --list --project <name>      # project filter (VELA-18)
vela index --list --sort oldest|newest  # date sort (VELA-18)
vela index --list --backend <name>      # backend filter (VELA-25)
vela index --list --failed              # show failed docs only (VELA-25)
vela logs [options]                     # unified log query
vela sync-from-paperclip                # reverse-sync Paperclip projects → local registry
```

### Global flags

Apply to every command.

```bash
vela --verbose setup              # structured logs to stderr while running
vela --debug status               # debug level + verbose
vela --quiet list                 # suppress stderr (file sink only)
vela --log-level warn ...         # set minimum level
vela --cid abc123 ...             # fixed correlation ID (for external tracing)
vela --no-log ...                 # disable sink writes
```

### MCP Gateway tools (invoked from Claude Code)

18+ tools exposed across five namespaces.

| Namespace | Tools |
|------------|------|
| `knowledge.*` (4) | `knowledge.search`, `knowledge.get`, `knowledge.put`, `knowledge.stats` (gbrain — hybrid vector + keyword RRF) |
| `doc.*` (3) | `doc.index`, `doc.get_structure`, `doc.get_pages` |
| `graph.*` (6) | `graph.build`, `graph.query`, `graph.get_neighbors`, `graph.get_node`, `graph.stats`, `graph.refresh` |
| `gstack.*` (4) | `gstack.execute_skill`, `gstack.dispatch_goal`, `gstack.list_goals`, `gstack.check_availability` |
| `vela.*` (1) | `vela.list_projects` |

If no graph exists, `graph.query` returns `{status: "building", retryAfterSec: 120}` and queues a background build. It never blocks.

`knowledge.search` fuses Ollama bge-m3 vector search with tsvector keyword search via RRF. Mixed Korean/English queries are supported.

### Claude Code slash commands (`/vela` skill)

Five commands usable from any project.

| Command | Purpose |
|--------|------|
| `/vela status` | Portfolio status (projects + issues + agents) |
| `/vela search <query>` | Cross-project knowledge search (gbrain) |
| `/vela context` | Load Graphify + gbrain + PageIndex context for the current project |
| `/vela dispatch <project> <goal>` | Delegate a goal to another project |
| `/vela register` | Register the current project with Vela |

---

## Key components

### Briefing Pack

A context bundle generated automatically per project. Improves exploration efficiency even before Graphify has finished.

- Composition: `git log -50` + directory tree (depth 3) + high-churn files (30-day window) + `README.md` + `CLAUDE.md` + manual pins (`{project}/.vela/pins.txt`)
- Generation time: 60–150 ms (on large projects)
- Size: ~8 KB of structured prompt

### Build Queue

The core of the auto-activation layer.

- File-backed JSONL queue (`~/.vela/build-queue.jsonl`)
- Concurrency 1 (serial execution to protect CPU/memory)
- POSIX append-atomic writes
- 10-minute timeout, SIGTERM cleanup
- Per-project state at `~/.vela/graphify/{project}/status.json` (`missing` / `building` / `built` / `failed`)
- Central log at `~/.vela/logs/graph-build.log`

### Startup Scanner

Runs asynchronously via `queueMicrotask` when the Paperclip plugin boots.

- Scans every project in the registry
- Missing graph → enqueue
- Missing project path → warning log
- Already queued → deduplicated

### Feedback Loop (Phase 5)

Runs automatically after a successful `execute-goal`.

- Extracts decisions from execution output (heuristic regex: `decided`, `chose`, `rejected`, `tradeoff`, `assumption`)
- Records them to `~/.vela/decisions/{project}/{goalId}.md`
- Appends to the project-level `log.md`
- Detects cross-project implications (whether touched files are mentioned in related projects' docs)
- Triggers `graph.refresh` fire-and-forget

### Git Post-Commit Hook

Optional. Refreshes the graph on every commit.

```bash
./scripts/install-git-hook.sh ~/projects/myproject
```

- Existing hooks are auto-backed-up
- Idempotent (installs only once)
- Never blocks the commit, even on failure

---

## Observability

Every command, tool call, and background task is recorded as structured JSONL.

### Single sink

`~/.vela/logs/vela.jsonl` — one file for everything.

Each entry:
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

### Correlation ID

A unique cid is generated per command and propagated through the full chain: CLI → plugin → gateway → worker.

### Querying logs

```bash
# Trace a single execution
vela logs --cid abc12345

# Live-tail MCP tool calls
vela logs gateway.tool. --tail

# Errors in the last 24h
vela logs --level error --since 24h

# Substring search
vela logs --grep "graphify"

# Specific component
vela logs cli.setup

# Raw JSON output
vela logs --cid abc12345 --raw
```

Supported filters: `--cid`, `--level`, `--since`, `--until`, `--grep`, `--limit`, `--tail`, `--raw`, `--sink`, positional component prefix.

### Data protection

- Automatic redaction of secret keywords (`api_key`, `token`, `password`, `secret`)
- Payloads over 32 KB are auto-truncated with a `{_truncated: true}` marker
- Logger errors are swallowed silently (logging must never break the command)

---

## File layout

### Project structure

```
vela-union/
├── packages/
│   ├── shared/              # common types, registry, logger, feedback, goal tracker
│   ├── paperclip-plugin/    # Paperclip plugin (definePlugin)
│   │   └── src/
│   │       ├── plugin.ts         # main plugin definition
│   │       ├── briefing.ts       # Briefing Pack generator
│   │       ├── dispatch.ts       # prompt assembly
│   │       ├── startup-scanner.ts # boot-time graph scan
│   │       └── manifest.ts       # plugin metadata
│   ├── gstack-adapter/      # Claude Code CLI integration
│   ├── mcp-gateway/         # unified MCP server
│   │   └── src/
│   │       ├── server.ts         # stdio MCP server (14 tools)
│   │       ├── pageindex.ts      # PageIndex wrapper
│   │       ├── graphify.ts       # Graphify wrapper
│   │       ├── gstack-proxy.ts   # registry-aware gstack wrapper
│   │       └── build-queue.ts    # auto-activation queue + worker
│   └── vela-cli/            # main CLI
│       └── src/
│           ├── cli.ts            # entrypoint + global flags
│           ├── commands/         # 8 subcommands
│           └── util/             # context, detect, paths, proc, http, log
├── scripts/                 # test + utility scripts
├── refs/                    # references for the 4 upstream systems (gitignored)
└── docs/                    # design documents
```

### Runtime directory (`~/.vela/`)

```
~/.vela/
├── projects.json            # project registry
├── goals.json               # goal tracking (Phase 2)
├── config.json              # user settings
├── build-queue.jsonl        # build queue (append-only)
├── graphify/
│   └── {project}/
│       ├── graph.json       # knowledge graph
│       └── status.json      # build status
├── decisions/
│   └── {project}/
│       ├── {goalId}.md      # per-goal decision record
│       └── log.md           # project-level decision log
├── pageindex/
│   └── {docId}/             # PageIndex cache
├── logs/
│   ├── vela.jsonl           # unified structured log (main)
│   ├── graph-build.log      # free-form build worker log
│   ├── paperclip.log        # Paperclip server stdout
│   ├── paperclip.err        # Paperclip server stderr
│   └── paperclip-launchd.*  # launchd output
└── pids/
    └── paperclip.pid
```

---

## Development

### Build

```bash
npx tsc --build              # incremental
npx tsc --build --clean      # clean build
pnpm -r build                # all workspaces
```

### Test

All test scripts live under `scripts/test-*.ts` and are executed directly with `tsx`. No test framework dependency — a simple `passed/failed` counter pattern.

```bash
npx tsx scripts/test-briefing.ts          # Briefing Pack generator
npx tsx scripts/test-registry.ts          # project registry
npx tsx scripts/test-dispatch.ts          # dispatch prompt assembly
npx tsx scripts/test-adapter.ts           # gstack adapter (31)
npx tsx scripts/test-feedback.ts          # feedback loop (28)
npx tsx scripts/test-graphify.ts          # Graphify integration
npx tsx scripts/test-mcp-gateway.ts       # unified MCP gateway (31)
npx tsx scripts/test-auto-activation.ts   # auto-activation layer (47)
npx tsx scripts/test-observability.ts     # observability layer (69)
npx tsx scripts/test-bootstrap.ts         # vela CLI (33; includes VELA-13/18/25 smokes)
```

### Monorepo

- pnpm workspaces (`pnpm-workspace.yaml`)
- TypeScript 6.0, ESM (`"type": "module"`), `verbatimModuleSyntax`
- TypeScript project references (composite)
- Inter-workspace deps declared as `workspace:*`
- Circular-dependency avoidance: `startup-scanner.ts` dynamically imports `build-queue.js` (`await import(specifier)`)

### Upstream references

The `refs/` directory holds upstream source references. Gitignored.

- Paperclip → `refs/paperclip/` (PLUGIN_SPEC, DEPLOYMENT-MODES, etc.)
- gstack → `refs/gstack/` (skill definitions)
- Graphify → `refs/graphify/`
- PageIndex → `refs/PageIndex/`

The actual Paperclip checkout must live separately at `~/projects/paperclip` (`vela setup` handles this).

---

## Design decisions

### Why not build a separate orchestration layer instead of using Paperclip?

Paperclip's web platform + plugin system already implements the "hire agents as employees" model. Building a separate server would be unnecessary duplication. Vela Union sits on top of the Paperclip plugin SDK instead.

### Why integrate via MCP?

Every major AI host — Claude Code, Codex, Gemini — supports MCP. A single MCP server means one registration to unlock every host, and it's language-neutral (Python Graphify + PageIndex wrapped in TypeScript).

### Why constrain the build queue to concurrency 1?

Graphify uses tree-sitter to parse ASTs, consuming minutes of wall-clock and hundreds of MB of RAM on a single large codebase. Concurrent runs create resource contention. Boring by default — a serial queue is simple and safe.

### Why doesn't `graph.query` block?

MCP tool calls happen inside a Claude Code conversation turn. A two-minute block ruins UX and triggers timeouts. Instead we return `"building"` immediately and build in the background, letting Claude retry naturally or fall back to the briefing pack. Explicit beats clever.

### Why a single structured-log sink?

When debugging, filtering the whole execution chain by a single cid is much faster than grepping across a dozen log files. JSONL plays nicely with `jq`, and `vela logs` offers a friendly interface on top.

---

## Status and roadmap

### Completed

- ✅ Spike (local validation of Paperclip and Graphify)
- ✅ Phase 0: monorepo scaffolding
- ✅ Phase 1: Paperclip plugin + Briefing Pack + project registry
- ✅ Phase 2: gstack adapter + goal tracking
- ✅ Phase 3: PageIndex MCP wrapper
- ✅ Phase 3.5: Graphify integration (tens-of-MB graphs validated on large projects)
- ✅ Phase 4: unified MCP gateway (14 tools)
- ✅ Phase 5: feedback loop (decision extraction + cross-project implications)
- ✅ vela CLI (12-step bootstrap + 10+ subcommands)
- ✅ Auto-activation layer (Paperclip boot scan + deferred build + launchd)
- ✅ Observability layer (structured logging + cid propagation + verbose mode)
- ✅ Paperclip self-hosted agent orchestration — CEO/CTO agents autonomously consume their own self-improvement issues via heartbeat
- ✅ Plugin worker environment injection chain — launchd → Paperclip → plugin-worker fork → Claude CLI (VELA-14)
- ✅ `execute-goal` async path — create a Paperclip Issue and early-return to dodge the 30s RPC timeout (VELA-17)
- ✅ PageIndex local Claude CLI backend — litellm monkey-patch + asyncio.Semaphore to cap concurrency (memory-blowup guard)
- ✅ `vela unregister` / `vela prune` CLI — project registry management (VELA-13)
- ✅ `vela index --list` rich output — sort/size/nodes/--project/--backend/--failed (VELA-18, VELA-25)
- ✅ Build queue `stop()` race fix — in-flight tick await (VELA-15, plus bonus ESM/CJS race fix)
- ✅ Test-observability registry leak fix — try/finally + reuse of the `vela unregister` CLI (VELA-16)
- ✅ **gbrain 5th-system integration** — fork `JakeB-5/gbrain`, Ollama bge-m3 local embeddings, `knowledge.*` 4 MCP tools, hybrid RRF search (VELA-34, VELA-35)
- ✅ **Auto project bootstrap** — `project.created` → auto-register in the Vela registry + initialize Graphify/gbrain/PageIndex (VELA-43~46)
- ✅ **`/vela` slash command** — cross-project orchestration from any project (VELA-39)
- ✅ **Paperclip project detail tab** — Vela Status tab + per-subsystem manual action buttons (VELA-49, VELA-50, VELA-51)
- ✅ **Agent AGENTS.md hardening** — empty-inbox immediate-exit safeguard, heartbeat protocol, atomic checkout (CTO v2)

---

## Upstream

Vela Union depends on these five open-source projects:

- **Paperclip** — https://github.com/paperclipai/paperclip
- **gstack** — https://github.com/garrytan/gstack
- **Graphify** — https://github.com/safishamsi/graphify
- **PageIndex** — https://github.com/VectifyAI/PageIndex
- **gbrain** — https://github.com/garrytan/gbrain (fork: https://github.com/JakeB-5/gbrain with local Ollama support)

---

## License

See the `LICENSE` file in the repo. Upstream systems carry their own licenses — check them individually.
