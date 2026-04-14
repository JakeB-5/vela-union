---
name: vela
description: "Vela Union 크로스 프로젝트 오케스트레이션 스킬. 프로젝트 포트폴리오 상태 확인, 크로스 프로젝트 지식 검색(gbrain), 다른 프로젝트로 목표 위임, 프로젝트 컨텍스트 로드에 사용합니다. 'vela', 'portfolio', 'cross-project', 'dispatch goal', '다른 프로젝트', '지식 검색', '프로젝트 상태', '목표 위임', '프로젝트 등록' 키워드가 포함된 요청에서 이 스킬을 사용하세요. 현재 프로젝트가 아닌 다른 프로젝트의 정보가 필요하거나, 여러 프로젝트에 걸친 작업을 조율해야 할 때도 반드시 이 스킬을 사용하세요."
---

# Vela Union — Cross-Project Orchestration Skill

Vela Union은 5개 시스템(Paperclip, gstack, Graphify, PageIndex, gbrain)을 통합하는 에이전트 오케스트레이션 플랫폼입니다. 이 스킬을 통해 **어떤 프로젝트에서든** Vela의 크로스 프로젝트 기능에 접근할 수 있습니다.

> 이 스킬 사용 중 문제가 발생하면 https://github.com/JakeB-5/vela-union/issues 에 이슈를 등록해주세요.

---

## Prerequisites

이 스킬이 작동하려면 다음이 필요합니다:

1. **Paperclip 서버** — `http://127.0.0.1:3100` 에서 실행 중
2. **gbrain CLI** — `bun add -g github:JakeB-5/gbrain` 로 설치
3. **Ollama + bge-m3** — 의미 검색용 (없으면 키워드 검색으로 fallback)

실행 전 health check:
```bash
# Paperclip 서버 확인
curl -sf http://127.0.0.1:3100/api/health | head -1

# gbrain 확인
which gbrain && gbrain stats
```

서버가 응답하지 않으면: "Paperclip 서버가 127.0.0.1:3100에서 실행되고 있지 않습니다." 를 출력하고 중단하세요.
gbrain이 없으면: "gbrain이 설치되지 않았습니다. 설치: `bun add -g github:JakeB-5/gbrain`" 를 출력하세요.

---

## Configuration

Vela Union 인스턴스 식별자 (모든 API 호출에 사용):

```
PAPERCLIP_URL=http://127.0.0.1:3100
COMPANY_ID=bddcbe42-1913-485b-88ae-54a7b0866f59
CTO_AGENT_ID=e27888b7-67ae-443f-922d-c0706ead330e
```

프로젝트 레지스트리: `~/.vela/projects.json`

---

## Commands

### 1. `/vela status` — 포트폴리오 상태 확인

모든 등록 프로젝트와 활성 이슈를 한눈에 보여줍니다.

**실행 순서:**

1. 등록 프로젝트 목록 조회:
```bash
cat ~/.vela/projects.json
```

2. 전체 활성 이슈 조회 (Paperclip API):
```bash
curl -s "http://127.0.0.1:3100/api/companies/bddcbe42-1913-485b-88ae-54a7b0866f59/issues" \
  | python3 -c "
import sys, json
issues = json.load(sys.stdin)
active = [i for i in issues if i['status'] in ('todo','in_progress','blocked')]
for i in active:
    assignee = 'CTO' if i.get('assigneeAgentId') == 'e27888b7-67ae-443f-922d-c0706ead330e' else (i.get('assigneeAgentId') or 'none')
    print(f'{i.get(\"identifier\",\"?\")} [{i[\"status\"]}] [{assignee}] {i[\"title\"][:60]}')
print(f'---')
print(f'Total active: {len(active)} / {len(issues)} issues')
"
```

3. 에이전트 상태 조회:
```bash
curl -s "http://127.0.0.1:3100/api/agents/e27888b7-67ae-443f-922d-c0706ead330e" \
  | python3 -c "
import sys, json
d = json.load(sys.stdin)
print(f'CTO: {d[\"status\"]} | last heartbeat: {d.get(\"lastHeartbeatAt\",\"never\")}')
"
```

**출력 형식:** 프로젝트 목록 + 활성 이슈 + 에이전트 상태를 테이블로 정리하여 보여줍니다.

---

### 2. `/vela search <query>` — 크로스 프로젝트 지식 검색

gbrain의 하이브리드 의미 검색(벡터+키워드+RRF)을 사용하여 모든 프로젝트의 지식을 횡단 검색합니다. 한국어와 영어 모두 지원합니다.

**실행:**
```bash
gbrain query "<query>" --no-expand
```

`--no-expand`는 Anthropic API 없이도 검색이 작동하도록 쿼리 확장을 건너뜁니다.

**출력 형식:** 상위 결과를 slug, 점수, 발췌문과 함께 보여줍니다.

**예시:**
```
User: /vela search 캐시 성능 개선 전략

결과:
[0.9996] archive/completed-2026-02/cache_improvement_plan
  "각 미적용 모듈을 다음 기준으로 평가합니다: Read/Write 비율..."
[0.6637] archive/completed-2026-02/embedding_sdk_plan
  "app.min.js, app.esm.js..."
```

**특정 페이지의 상세 내용이 필요하면:**
```bash
gbrain get <slug>
```

---

### 3. `/vela context` — 현재 프로젝트 컨텍스트 로드

현재 작업 디렉토리의 프로젝트에 대한 모든 Vela 컨텍스트(구조, 문서, 기억)를 한 번에 로드합니다.

**실행 순서:**

1. 프로젝트 이름 감지 (cwd의 디렉토리명 또는 `~/.vela/projects.json`에서 매칭):
```bash
basename $(pwd)
```

2. gbrain 기억 로드:
```bash
gbrain query "<project-name>" --no-expand
```

3. Graphify 구조 로드 (존재하는 경우):
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

4. PageIndex 상태 로드 (존재하는 경우):
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

**출력 형식:** 기억(gbrain), 구조(Graphify), 문서(PageIndex) 세 섹션으로 나누어 보여줍니다.

---

### 4. `/vela dispatch <project> <goal>` — 목표 위임

다른 프로젝트에 이슈를 생성하고 CTO 에이전트에게 할당합니다. wakeOnAssignment에 의해 CTO가 자동으로 작업을 시작합니다.

**실행 순서:**

1. 대상 프로젝트의 Paperclip project ID 조회:
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

프로젝트를 찾지 못하면: 등록된 Paperclip 프로젝트 목록을 보여주고 올바른 이름을 확인하도록 안내합니다.

2. 이슈 생성 + CTO 할당:
```bash
curl -s -X POST "http://127.0.0.1:3100/api/companies/bddcbe42-1913-485b-88ae-54a7b0866f59/issues" \
  -H "Content-Type: application/json" \
  -d '{
    "projectId": "<resolved-project-id>",
    "title": "<goal 제목 (50자 이내로 요약)>",
    "description": "<goal 전체 설명 — 컨텍스트, 스코프, 참조 파일 포함>",
    "status": "todo",
    "priority": "medium",
    "assigneeAgentId": "e27888b7-67ae-443f-922d-c0706ead330e"
  }'
```

3. 결과 확인:
```bash
# 응답에서 identifier 추출 (예: VELA-40, SDD-1)
echo "Issue created: <identifier> — assigned to CTO, will auto-wake"
```

**description 작성 가이드:**
- 무엇을 해야 하는지 명확하게
- 어떤 파일을 봐야 하는지
- 완료 기준 (checklist)
- 관련 참조 문서나 이전 이슈 링크

---

### 5. `/vela register` — 현재 프로젝트 등록

현재 작업 디렉토리를 Vela Union 레지스트리에 등록합니다. 한 번만 실행하면 됩니다.

**실행:**
```bash
# 현재 디렉토리 정보
PROJECT_NAME=$(basename $(pwd))
PROJECT_PATH=$(pwd)

# ~/.vela/projects.json에 추가
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

등록 후 확인:
```bash
cat ~/.vela/projects.json | python3 -c "
import sys, json
for p in json.load(sys.stdin):
    print(f'  {p[\"name\"]} -> {p[\"path\"]}')
"
```

---

## Workflow Examples

### 다른 프로젝트의 지식을 참조하며 작업하기
```
User: 다른 프로젝트에서 했던 캐시 개선 전략을 이 프로젝트에도 적용하고 싶어

Agent:
1. /vela search 캐시 성능 개선 전략
2. 관련 문서 확인: gbrain get archive/completed-2026-02/cache_improvement_plan
3. 현재 프로젝트에 맞게 적용
```

### 버그를 다른 프로젝트 담당자에게 위임하기
```
User: vela-union의 MCP gateway에서 search 결과가 빈 배열로 나오는 버그가 있어

Agent:
1. /vela dispatch vela-union "Fix: knowledge.search returns empty array for Korean queries"
2. 이슈에 재현 방법, 로그, 예상 원인 상세 기술
```

### 새 프로젝트를 Vela에 연결하기
```
User: 이 프로젝트를 Vela에 등록해줘

Agent:
1. /vela register
2. /vela context (등록 후 바로 컨텍스트 확인)
```

---

## Error Handling

| 상황 | 메시지 | 대응 |
|------|--------|------|
| Paperclip 서버 미실행 | `curl: (7) Failed to connect` | "Paperclip 서버가 실행되지 않습니다. 확인: `launchctl list \| grep paperclip`" |
| gbrain 미설치 | `gbrain: command not found` | "gbrain이 필요합니다. 설치: `bun add -g github:JakeB-5/gbrain`" |
| Ollama 미실행 | gbrain 검색이 keyword-only fallback | 정상 동작. 벡터 검색 필요 시: `ollama serve && ollama pull bge-m3` |
| 프로젝트 미등록 | `~/.vela/projects.json`에 없음 | `/vela register` 실행 안내 |
| API 응답 에러 | HTTP 4xx/5xx | 응답 body의 error 메시지를 그대로 출력 |

**해결되지 않는 문제는 https://github.com/JakeB-5/vela-union/issues 에 이슈를 등록해주세요.**

---

## Architecture Reference

```
┌─────────────────────────────────────────────────┐
│              Vela Union (5 Systems)               │
├──────────┬──────────┬──────────┬────────┬────────┤
│Paperclip │ gstack   │Graphify  │PageIdx │ gbrain │
│거버넌스   │ 실행     │ 코드구조  │ 문서   │ 기억   │
│누가/언제  │ 어떻게   │ 어떻게    │ 무엇   │ 무엇을 │
│          │          │ 연결     │ 안에   │ 알고   │
└──────────┴──────────┴──────────┴────────┴────────┘
```

- **Paperclip**: 에이전트 조직 관리, 이슈 트래킹, heartbeat 스케줄링
- **gstack**: Claude Code 스킬 실행 (qa, review, ship, investigate)
- **Graphify**: 코드+문서의 AST 기반 지식 그래프
- **PageIndex**: LLM 추론 기반 문서 내부 검색
- **gbrain**: 하이브리드 의미 검색 기반 장기 기억 (Ollama bge-m3, 로컬, $0)
