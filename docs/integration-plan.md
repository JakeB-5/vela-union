# 5-System 통합 플러그인 — 현실적 플랜

> 작성일: 2026-04-10

## 분석 요약

| 시스템 | 언어 | 인터페이스 | 통합 가능 지점 |
|--------|------|-----------|---------------|
| **Paperclip** | TypeScript (Node.js/pnpm) | REST API + WebSocket + **Plugin SDK (JSON-RPC)** | 플러그인 시스템이 가장 성숙함. `definePlugin()` + 이벤트 구독 + 데이터 프로바이더 |
| **gstack** | TypeScript (Bun) | localhost HTTP + CLI (`$B <command>`) | 공식 플러그인 시스템 없음. HTTP API 호출 또는 CLI 래핑 |
| **Graphify** | Python | **MCP 서버 (7개 도구)** + CLI | MCP가 이미 있어 가장 통합하기 쉬움 |
| **PageIndex** | Python | Python SDK (`PageIndexClient`) + CLI | MCP 없음 (클라우드만). OSS용 MCP 래퍼 필요 |
| **gbrain** | TypeScript (Bun) | **MCP 서버 (30개 도구)** + CLI | 동일 스택(TS/Bun). Fork: `JakeB-5/gbrain` (로컬 Ollama 임베딩) |

## 핵심 아키텍처

```
┌─────────────────────────────────────────────┐
│              Paperclip (지휘)                 │
│  Plugin SDK ← vela-union plugin 등록         │
│  이벤트: issue.created → 자동 컨텍스트 주입   │
│  작업: agent.wake → gstack 스킬 디스패치      │
└──────┬──────────────┬──────────────┬─────────┘
       │              │              │
  ┌────▼────┐  ┌──────▼──────┐  ┌───▼────────┐  ┌───▼────────┐
  │ gstack  │  │  Graphify   │  │ PageIndex  │  │  gbrain    │
  │ HTTP/CLI│  │  MCP 서버    │  │ MCP 래퍼   │  │  TS 라이브러리│
  │ (실행)   │  │  (구조)      │  │ (문서)     │  │  (기억)    │
  └─────────┘  └─────────────┘  └────────────┘  └────────────┘
```

**통합 레이어**: Paperclip 플러그인 1개 + MCP 게이트웨이 1개

## Phase 0 — 프로젝트 스캐폴딩 (1일)

- [ ] `vela-union/` 모노레포 구조 결정 (pnpm workspace 또는 Turborepo)
- [ ] `refs/`를 `.gitignore`에 추가 (참조용, 커밋 X)
- [ ] 패키지 구조:
  ```
  packages/
    mcp-gateway/        # 통합 MCP 서버 (Graphify + PageIndex 래핑)
    paperclip-plugin/   # Paperclip 플러그인 (이벤트 → 액션)
    gstack-adapter/     # Paperclip용 gstack 어댑터
    shared/             # 공통 타입, 유틸리티
  ```

## Phase 1 — PageIndex MCP 래퍼 (2~3일)

**이유**: Graphify는 이미 MCP가 있지만, PageIndex는 Python SDK만 있음. 통합의 전제 조건.

- [ ] `mcp-gateway/pageindex-bridge.ts` — PageIndex Python CLI를 child process로 래핑
- [ ] MCP 도구 3개 노출:
  - `index_document(path)` → 문서 인덱싱
  - `get_structure(doc_id)` → 계층 트리 반환
  - `get_page_content(doc_id, pages)` → 페이지 내용 반환
- [ ] PageIndex의 `workspace/` 디렉토리를 공유 상태로 사용
- [ ] 검증: Claude Code에서 MCP 도구 호출로 PDF 질의 가능 확인

## Phase 2 — 통합 MCP 게이트웨이 (3~4일)

**이유**: Claude Code나 다른 AI 호스트에서 단일 MCP로 Graphify + PageIndex + gstack 모두 접근.

- [ ] `mcp-gateway/server.ts` — 단일 MCP stdio 서버
- [ ] Graphify 프록시: Graphify MCP (Python) 프로세스를 내부적으로 spawn, 7개 도구 릴레이
- [ ] PageIndex 프록시: Phase 1의 래퍼 통합
- [ ] gstack 프록시: localhost HTTP로 명령 전달
  - `browse(url)`, `snapshot()`, `click(ref)`, `qa_run(url, tier)`
- [ ] 네임스페이스 분리: `graph.query_graph`, `doc.get_structure`, `browse.goto` 등
- [ ] 검증: Claude Code `.claude/settings.json`에 MCP 서버 등록 후 전체 도구 호출 테스트

## Phase 3 — Paperclip 플러그인 (4~5일)

**이유**: 이벤트 기반으로 4개 시스템을 자동 연결하는 핵심 통합 로직.

- [ ] `paperclip-plugin/manifest.json` — 플러그인 선언
  ```json
  {
    "name": "vela-union",
    "capabilities": ["data.read", "data.write", "jobs.trigger", "events.subscribe"]
  }
  ```
- [ ] `paperclip-plugin/worker.ts` — JSON-RPC 워커
- [ ] 이벤트 핸들러:
  - `issue.created` → Graphify에서 관련 코드 컨텍스트 자동 조회, 이슈에 코멘트 첨부
  - `issue.created` → PageIndex에서 관련 문서 섹션 자동 조회, 이슈에 첨부
  - `agent.woke` → 에이전트 작업 시작 시 관련 지식 그래프 컨텍스트 프리로드
- [ ] 데이터 프로바이더:
  - `/api/plugins/vela-union/data/graph-context?query=...` → Graphify 쿼리 프록시
  - `/api/plugins/vela-union/data/doc-search?query=...` → PageIndex 쿼리 프록시
- [ ] 작업(Jobs):
  - `rebuild-graph` → Graphify 재빌드 트리거
  - `reindex-docs` → PageIndex 재인덱싱 트리거

## Phase 4 — gstack 어댑터 (3~4일)

**이유**: Paperclip 에이전트가 gstack 스킬을 직접 실행할 수 있도록.

- [ ] `gstack-adapter/index.ts` — Paperclip 어댑터 인터페이스 구현
- [ ] Paperclip의 `adapters/registry.ts` 패턴을 따라:
  - `adapterType: "gstack_local"`
  - `adapterConfig: { skills: ["qa", "review", "ship"], browsePort: number }`
- [ ] gstack 바이너리 존재 여부 확인 (`find-browse.ts` 패턴 참고)
- [ ] 에이전트가 gstack 스킬을 heartbeat에서 실행:
  - Paperclip이 이슈 할당 → gstack `/qa` 스킬 트리거 → 결과를 이슈에 보고
- [ ] 검증: Paperclip UI에서 gstack 어댑터 에이전트 생성 → 이슈 할당 → 자동 QA 실행 확인

## Phase 5 — 피드백 루프 (2~3일)

**이유**: 실행 → 지식 → 검색 순환 구조 완성.

- [ ] gstack 실행 결과(커밋, PR)를 Graphify에 자동 반영
  - git post-commit hook → `graphify --update` 트리거
- [ ] Paperclip 이슈 해결 시 결정사항을 Graphify에 기록
  - `issue.resolved` 이벤트 → 의사결정 노드 추가
- [ ] 새 문서 추가 시 PageIndex 자동 인덱싱
  - 파일 워처 또는 Paperclip 루틴(cron)으로 주기적 스캔

## Phase 6 — gbrain 장기 기억 레이어 (2~3일)

**이유**: 4개 시스템이 답하지 못하는 "크로스 프로젝트 결정/엔티티 기억" 슬롯을 채움. 검증 완료 (Phase 1 PoV, 2026-04-13).

- [ ] `mcp-gateway/src/gbrain.ts` — gbrain TypeScript 라이브러리 직접 import
  - `knowledge.search`: `gbrain query <q> --no-expand` 래핑 (하이브리드 벡터+키워드 검색)
  - `knowledge.get`: `gbrain get <slug>` 래핑 (엔티티 페이지 읽기)
  - `knowledge.put`: `gbrain put <slug>` 래핑 (엔티티/결정 기록)
  - `knowledge.stats`: `gbrain stats` 래핑 (brain 통계)
- [ ] `mcp-gateway/src/server.ts`에 `registerKnowledgeTools()` 등록
- [ ] Paperclip 플러그인 연동:
  - `issue.created` → `knowledge.search "{goal}"` 결과를 Briefing Pack에 주입
  - `issue.resolved` → `knowledge.put "decisions/{slug}"` 타임라인 append
- [ ] `~/.vela/gbrain/` 디렉토리 + `vela setup`에 gbrain 초기화 단계 추가

**기술 결정:**
- TypeScript 라이브러리 직접 import (subprocess 아님) — 동일 런타임이라 오버헤드 없음
- 네임스페이스: `knowledge.*` (semantic, "무엇을 알고 있는가?" 질문에 대응)
- 임베딩: Ollama bge-m3 (1024d, 로컬, $0) — fork `JakeB-5/gbrain`
- 스토리지: PGLite (단일 인스턴스 `~/.vela/gbrain/brain.pglite`)

**경계 규칙:**
- ❌ 코드 자체 → Graphify
- ❌ 단일 문서 내부 구조 → PageIndex
- ✅ 사람/회사/결정/아이디어/미팅/프로젝트 엔티티 + 크로스 프로젝트 관계

---

## 기술적 리스크 & 대응

| 리스크 | 심각도 | 대응 |
|--------|--------|------|
| **언어 혼합** (TS + Python 2개) | 중 | child_process/subprocess로 Python 래핑. 장기적으로 gRPC 고려 |
| **gstack 바이너리 의존** | 중 | gstack이 설치되지 않은 환경에서 graceful degradation |
| **Graphify 빌드 시간** | 낮 | `--update` 증분 빌드 + 캐시 활용 |
| **Paperclip 플러그인 API 안정성** | 중 | `PLUGIN_SPEC.md` 기준으로 구현, 버전 고정 |
| **MCP 프로세스 관리** | 중 | 서버 health check + 자동 재시작 |

## 예상 일정

| Phase | 기간 | 산출물 |
|-------|------|--------|
| 0. 스캐폴딩 | 1일 | 모노레포 구조, CI |
| 1. PageIndex MCP | 2~3일 | `mcp-gateway/pageindex-bridge` |
| 2. MCP 게이트웨이 | 3~4일 | 통합 MCP 서버 |
| 3. Paperclip 플러그인 | 4~5일 | 이벤트 핸들러 + 데이터 프로바이더 |
| 4. gstack 어댑터 | 3~4일 | Paperclip ↔ gstack 연동 |
| 5. 피드백 루프 | 2~3일 | 순환 구조 완성 |
| 6. gbrain 장기 기억 | 2~3일 | `knowledge.*` MCP + Paperclip 연동 |
| **합계** | **~17~23일** | |
