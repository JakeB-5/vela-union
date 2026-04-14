---
name: vela
description: "Vela Union cross-project orchestration skill. Use this to check portfolio status, run cross-project knowledge search (gbrain), delegate goals to other projects, and load project context from anywhere. Trigger on keywords like 'vela', 'portfolio', 'cross-project', 'dispatch goal', 'other project', 'knowledge search', 'project status', 'goal delegation', 'register project' — and their Korean equivalents: '다른 프로젝트', '지식 검색', '프로젝트 상태', '목표 위임', '프로젝트 등록'. Use this whenever you need information about a project other than the current one, or when you need to coordinate work spanning multiple projects."
---

# Vela Union — Cross-Project Orchestration Skill

Vela Union unifies five systems (Paperclip, gstack, Graphify, PageIndex, gbrain) into one agent orchestration layer. This skill exposes Vela's cross-project capabilities from **any** project you're working in.

> If you hit a problem while using this skill, please open an issue at https://github.com/JakeB-5/vela-union/issues.

---

## Prerequisites

This skill depends on:

1. **Paperclip server** — running at `http://127.0.0.1:3100`
2. **gbrain CLI** — install with `bun add -g github:JakeB-5/gbrain`
3. **Ollama + bge-m3** — for semantic search (falls back to keyword search if missing)

Health check before running anything:
```bash
# Paperclip server
curl -sf http://127.0.0.1:3100/api/health | head -1

# gbrain
which gbrain && gbrain stats
```

If the server does not respond: output "Paperclip server is not running at 127.0.0.1:3100." and stop.
If gbrain is missing: output "gbrain is not installed. Install: `bun add -g github:JakeB-5/gbrain`".

---

## Configuration

Vela Union instance identifiers (used for every API call):

```
PAPERCLIP_URL=http://127.0.0.1:3100
COMPANY_ID=bddcbe42-1913-485b-88ae-54a7b0866f59
CTO_AGENT_ID=c779c5e3-e2b8-4583-ad7d-a858f9ba767e
```

Project registry: `~/.vela/projects.json`

---

## Commands

### 1. `/vela status` — portfolio overview

Shows every registered project and every active issue at a glance.

**Steps:**

1. List registered projects:
```bash
cat ~/.vela/projects.json
```

2. List all active issues (Paperclip API):
```bash
curl -s "http://127.0.0.1:3100/api/companies/bddcbe42-1913-485b-88ae-54a7b0866f59/issues" \
  | python3 -c "
import sys, json
issues = json.load(sys.stdin)
active = [i for i in issues if i['status'] in ('todo','in_progress','blocked')]
for i in active:
    assignee = 'CTO' if i.get('assigneeAgentId') == 'c779c5e3-e2b8-4583-ad7d-a858f9ba767e' else (i.get('assigneeAgentId') or 'none')
    print(f'{i.get(\"identifier\",\"?\")} [{i[\"status\"]}] [{assignee}] {i[\"title\"][:60]}')
print(f'---')
print(f'Total active: {len(active)} / {len(issues)} issues')
"
```

3. Agent status:
```bash
curl -s "http://127.0.0.1:3100/api/agents/c779c5e3-e2b8-4583-ad7d-a858f9ba767e" \
  | python3 -c "
import sys, json
d = json.load(sys.stdin)
print(f'CTO: {d[\"status\"]} | last heartbeat: {d.get(\"lastHeartbeatAt\",\"never\")}')
"
```

**Output format:** a table combining project list + active issues + agent status.

---

### 2. `/vela search <query>` — cross-project knowledge search

Runs gbrain's hybrid semantic search (vector + keyword + RRF) across every project. Mixed Korean/English queries are supported.

**Run:**
```bash
gbrain query "<query>" --no-expand
```

`--no-expand` skips query expansion so the search works without an Anthropic API key.

**Output format:** top hits with slug, score, and excerpt.

**Example:**
```
User: /vela search cache performance improvement strategy

Result:
[0.9996] archive/completed-2026-02/cache_improvement_plan
  "Evaluate each un-applied module by the following criteria: Read/Write ratio..."
[0.6637] archive/completed-2026-02/embedding_sdk_plan
  "app.min.js, app.esm.js..."
```

**If you need the full content of a specific page:**
```bash
gbrain get <slug>
```

---

### 3. `/vela context` — load context for the current project

Loads every piece of Vela context (structure, docs, memory) for the project in the current working directory, in one shot.

**Steps:**

1. Detect the project name (via cwd directory name, or match against `~/.vela/projects.json`):
```bash
basename $(pwd)
```

2. Load gbrain memory:
```bash
gbrain query "<project-name>" --no-expand
```

3. Load Graphify structure (if present):
```bash
cat ~/.vela/graphify/<project-name>/graph.json 2>/dev/null | python3 -c "
import sys, json
try:
    data = json.load(sys.stdin)
    nodes = data.get('nodes', [])
    edges = data.get('edges', [])
    print(f'Graph: {len(nodes)} nodes, {len(edges)} edges')
    # Show top communities
    communities = {}
    for n in nodes:
        c = n.get('community', 'unknown')
        communities[c] = communities.get(c, 0) + 1
    for c, count in sorted(communities.items(), key=lambda x: -x[1])[:5]:
        print(f'  Community {c}: {count} nodes')
except:
    print('No Graphify data available')
"
```

4. Load PageIndex state (if present):
```bash
cat ~/.vela/pageindex/<project-name>/index.json 2>/dev/null | python3 -c "
import sys, json
try:
    data = json.load(sys.stdin)
    docs = list(data.values()) if isinstance(data, dict) else data
    print(f'PageIndex: {len(docs)} documents indexed')
except:
    print('No PageIndex data available')
"
```

**Output format:** three sections — memory (gbrain), structure (Graphify), documents (PageIndex).

---

### 4. `/vela dispatch <project> <goal>` — delegate a goal

Creates an issue in another project and assigns it to the CTO agent. `wakeOnAssignment` causes the CTO to start working automatically.

**Steps:**

1. Resolve the target project's Paperclip project ID:
```bash
curl -s "http://127.0.0.1:3100/api/companies/bddcbe42-1913-485b-88ae-54a7b0866f59/projects" \
  | python3 -c "
import sys, json
projects = json.load(sys.stdin)
target = '<project>'
for p in projects:
    name = p['name'].replace(r'[\[.*?\]\s*', '', 1) if '[' in p['name'] else p['name']
    if name.lower() == target.lower() or p['name'].lower() == target.lower():
        print(p['id'])
        break
else:
    print('NOT_FOUND')
"
```

If the project cannot be resolved: show the registered Paperclip project list and ask for the correct name.

2. Create the issue and assign it to CTO:
```bash
curl -s -X POST "http://127.0.0.1:3100/api/companies/bddcbe42-1913-485b-88ae-54a7b0866f59/issues" \
  -H "Content-Type: application/json" \
  -d '{
    "projectId": "<resolved-project-id>",
    "title": "<goal title — summarize in under 50 chars>",
    "description": "<full goal description — context, scope, referenced files>",
    "status": "todo",
    "priority": "medium",
    "assigneeAgentId": "c779c5e3-e2b8-4583-ad7d-a858f9ba767e"
  }'
```

3. Confirm:
```bash
# Extract the identifier from the response (e.g. VELA-40, SDD-1)
echo "Issue created: <identifier> — assigned to CTO, will auto-wake"
```

**Description guidelines:**
- State exactly what needs to be done
- Point to the files to read
- Provide a completion checklist
- Link related reference docs or prior issues

---

### 5. `/vela register` — register the current project

Adds the current working directory to the Vela Union registry. Run once per project.

**Run:**
```bash
# Current directory info
PROJECT_NAME=$(basename $(pwd))
PROJECT_PATH=$(pwd)

# Append to ~/.vela/projects.json
python3 -c "
import json, os
registry_path = os.path.expanduser('~/.vela/projects.json')
os.makedirs(os.path.dirname(registry_path), exist_ok=True)
try:
    with open(registry_path) as f:
        projects = json.load(f)
except (FileNotFoundError, json.JSONDecodeError):
    projects = []
name = '$PROJECT_NAME'
path = '$PROJECT_PATH'
existing = [p for p in projects if p['name'] == name]
if existing:
    existing[0]['path'] = path
    print(f'Updated: {name} -> {path}')
else:
    projects.append({'name': name, 'path': path, 'type': 'personal', 'relatedProjects': []})
    print(f'Registered: {name} -> {path}')
with open(registry_path, 'w') as f:
    json.dump(projects, f, indent=2)
"
```

Verify:
```bash
cat ~/.vela/projects.json | python3 -c "
import sys, json
for p in json.load(sys.stdin):
    print(f'  {p[\"name\"]} -> {p[\"path\"]}')
"
```

---

## Workflow Examples

### Reuse knowledge from another project
```
User: I want to apply the cache improvement strategy from another project here

Agent:
1. /vela search cache performance improvement strategy
2. Inspect the match: gbrain get archive/completed-2026-02/cache_improvement_plan
3. Adapt it to the current project
```

### Delegate a bug to the owner of another project
```
User: vela-union's MCP gateway returns an empty array from search — file it

Agent:
1. /vela dispatch vela-union "Fix: knowledge.search returns empty array for Korean queries"
2. Include reproduction steps, logs, and a suspected cause in the description
```

### Onboard a new project to Vela
```
User: Register this project with Vela

Agent:
1. /vela register
2. /vela context (immediately inspect what Vela knows about it)
```

---

## Error Handling

| Situation | Signal | Response |
|------|--------|------|
| Paperclip server not running | `curl: (7) Failed to connect` | "Paperclip server is not running. Check: `launchctl list \| grep paperclip`" |
| gbrain not installed | `gbrain: command not found` | "gbrain is required. Install: `bun add -g github:JakeB-5/gbrain`" |
| Ollama not running | gbrain search falls back to keyword-only | Normal degraded mode. For vector search: `ollama serve && ollama pull bge-m3` |
| Project not registered | Absent from `~/.vela/projects.json` | Suggest running `/vela register` |
| API error response | HTTP 4xx/5xx | Echo the error message from the response body verbatim |

**If the problem persists, file an issue at https://github.com/JakeB-5/vela-union/issues.**

---

## Architecture Reference

```
┌─────────────────────────────────────────────────┐
│              Vela Union (5 Systems)               │
├──────────┬──────────┬──────────┬────────┬────────┤
│Paperclip │ gstack   │Graphify  │PageIdx │ gbrain │
│governance│ execution│ code     │ docs   │ memory │
│who/when  │ how      │ how      │ what's │ what we│
│          │          │ connected│ inside │ know   │
└──────────┴──────────┴──────────┴────────┴────────┘
```

- **Paperclip**: agent org chart, issue tracking, heartbeat scheduling
- **gstack**: Claude Code skill execution (qa, review, ship, investigate)
- **Graphify**: AST-based knowledge graph over code + docs
- **PageIndex**: LLM-reasoning in-document search
- **gbrain**: long-term memory via hybrid semantic search (Ollama bge-m3, local, $0)
