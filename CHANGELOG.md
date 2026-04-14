# Changelog

본 프로젝트의 모든 주목할 만한 변경 사항은 이 파일에 기록된다. 양식은 [Keep a Changelog](https://keepachangelog.com/en/1.1.0/)를 따르며 버전은 [Semantic Versioning](https://semver.org/spec/v2.0.0.html)을 따른다.

## [Unreleased] — 2026-04-12

이번 릴리스의 핵심 테마는 **자기 개선 사이클의 dogfooding**이다. vela-union 프로젝트 자체가 Paperclip에 등록되었고, Paperclip의 CEO/CTO 에이전트가 heartbeat를 통해 자율적으로 자기 자신의 이슈를 소화한 결과가 이 릴리스의 대부분을 차지한다.

### Added

- **`vela unregister <name>` 서브커맨드** (VELA-13) — 개별 프로젝트를 `~/.vela/projects.json`에서 제거하고, `paperclipProjectId`가 연결된 경우 Paperclip의 `DELETE /api/projects/:id`를 호출해 원격도 정리한다. Paperclip이 다운되었을 때는 경고를 출력하고 로컬 제거를 계속한다 (graceful degradation). `--no-paperclip` 플래그로 원격 호출을 명시적으로 건너뛸 수 있다.
- **`vela prune [--dry-run] [--no-paperclip]` 서브커맨드** (VELA-13) — path가 더 이상 디스크에 존재하지 않는 orphan 엔트리를 일괄 제거한다. `--dry-run`은 실제 변경 없이 후보만 보여준다. Paperclip 클라이언트는 배치 작업을 위해 1회만 생성된다.
- **`vela index --list` 리치 출력** (VELA-18) — 프로젝트별 grouping, `indexedAt` 정렬 (`--sort newest|oldest`, 기본 newest), 파일 크기 (statSync, human-readable KB/MB), 노드 수 (트리 JSON 재귀 walk; 누락 시 `? nodes` fallback).
- **`vela index --list --project <name>` 필터** (VELA-18) — 특정 프로젝트만 조회. 존재하지 않는 프로젝트 이름은 exit 1 + 명확한 에러 메시지.
- **`vela index --list --backend <name>` 필터** (VELA-25) — `vectify-cloud` 또는 `local-claude-cli` backend로 생성된 문서만 필터링.
- **`vela index --list --failed` 필터** (VELA-25) — 인덱싱에 실패한 문서만 조회. 실패 시간, backend, 에러 메시지(180자까지)를 한 줄로 표시. `--project`와 `--backend`와 결합 가능.
- **`CloudIndexEntry.backend` 필드 추적** (VELA-25) — `~/.vela/pageindex/<project>/index.json`의 per-doc 레코드가 이제 생성 시점의 backend를 기록한다. `CloudStatusFile.docs[*].backend`도 동일하게 확장되어 실패 시에도 어느 backend가 문제를 일으켰는지 correlation 가능.
- **Paperclip 에이전트 오케스트레이션 (self-hosted)** — `[VELA] vela-union` 프로젝트가 Paperclip에 등록되었고, CEO + CTO 에이전트가 자기 자신의 자기개선 이슈를 heartbeat로 자율 소화. VELA-13/15/16/18은 CTO 에이전트가 독립 Claude Code 세션에서 처리했으며, 운영자는 검증 + finalization만 수행.
- **CTO 에이전트 Definition of Done (영구 룰)** — `~/.paperclip/.../instructions/AGENTS.md`에 "commit 존재 + tsc clean + tests green + follow-up issue 실제 생성"을 mandatory 체크리스트로 박아, 이전 VELA-18에서 관찰된 "tunnel vision으로 finalization 단계 누락" 패턴을 구조적으로 방지.
- **CHANGELOG.md** — 이 파일.

### Fixed

- **플러그인 워커 Claude CLI 인증 실패** (VELA-14) — Paperclip의 `plugin-worker-manager`가 플러그인 워커를 fork할 때 curated env를 전달하는데, 그 allowlist에 `HOME`이 포함되지 않아 Claude CLI가 `~/.claude/.credentials.json`을 읽지 못했다. `packages/gstack-adapter/src/adapter.ts`의 `claudeSpawnEnv()` 헬퍼가 명시적으로 `HOME`/`USER`를 주입한다 (libuv의 passwd-database fallback을 활용). 또한 `packages/vela-cli/src/commands/setup.ts`의 `renderPaperclipPlist()`가 launchd plist의 `EnvironmentVariables`에 `HOME`/`USER`/`VELA_CLAUDE_CLI_CONCURRENCY`를 주입해 1차 차단점을 해소한다.
- **`execute-goal` tool의 dual-execution race** (VELA-17) — `packages/paperclip-plugin/src/plugin.ts`의 `execute-goal` 툴이 Paperclip issue 생성과 동기 Claude CLI 실행을 모두 시도하다가 Paperclip의 30s RPC 타임아웃을 상시 초과했다. 새로운 `localExecute` 파라미터 (기본 `false`)를 추가하고, 기본 경로는 이슈 생성 후 즉시 early-return하여 Paperclip heartbeat가 비동기로 처리하도록 변경. `localExecute: true`는 legacy dev-loop 용도로만 남김.
- **`test-observability.ts` 레지스트리 누수** (VELA-16) — 테스트의 cleanup이 `require("../packages/shared/dist/index.js")` (ESM 컨텍스트에서 fail) 뒤에 `try/catch`로 모든 실패를 삼키는 패턴이라, 실제로는 `test-obs-register` 엔트리가 `~/.vela/projects.json`에 영구적으로 남고 있었다. `try/finally` + `runCli(["unregister", "test-obs-register", "--no-paperclip"])`로 교체 — VELA-13에서 출시한 자신의 `vela unregister` CLI를 재사용하는 재귀적 해법.
- **`build-queue.ts`의 `stop()` race** (VELA-15) — `startWorker()`의 `setInterval` 콜백이 `void tick()`으로 promise 참조를 버리고 있어, `stop()`이 tick이 `processEntry()` 내부를 실행 중인 window에 호출되면 `currentChild === null`이라 wait 블록을 스킵하고 즉시 반환했다. tick이 이미 `writeStatus("built")`를 했지만 `removeEntry()`는 못한 상태로 남아 테스트에서 race 실패. `let currentTick: Promise<void> \| null` 참조 추적 + `stop()`이 await하도록 수정. **Bonus**: 동일 수정 중에 `test-auto-activation.ts`의 `cleanupTestProjects()`가 ESM 컨텍스트에서 `require("node:fs")`를 쓰고 있어 silently 실패하는 2차 버그를 발견하고 함께 수정. 두 버그 모두 VELA-16과 동일한 ESM/CJS 패턴에 속한다.
- **PageIndex 로컬 백엔드 메모리 폭주** — PageIndex OSS의 `md_to_tree()`가 `asyncio.gather()`로 fan-out하여 30+ 섹션 문서에서 30+개의 Claude CLI 서브프로세스를 동시 spawn했고, 각 프로세스가 300–500MB를 차지해 100GB+ 메모리 소진으로 시스템 다운이 실제 발생했다. `scripts/claude_cli_llm.py`에 lazy `asyncio.Semaphore(VELA_CLAUDE_CLI_CONCURRENCY)` 추가 (기본 3). 환경 변수로 오버라이드 가능.

### Changed

- **Repository git coverage** — 세션 전에는 84개 파일 중 9개만 git tracked 상태였다 (8.1%). baseline 커밋 `ce6d91d`에서 나머지 75개 파일을 일괄 추가하여 현재 100% coverage. 동시에 `.gitignore`를 확장하여 `.claude/`, `.reflexion-fusion/` (130MB), `.omc/`, `.venv/`, `graphify-out/`, `.DS_Store`, `__pycache__/`, stale tsc output in `scripts/`를 제외한다.
- **`docs/architecture.md`** — 에이전트 오케스트레이션 (§14), 플러그인 워커 환경 주입 체인 (§8.1), `execute-goal` async path (§3.1), PageIndex 로컬 Claude CLI 백엔드 (§15)를 신규 섹션으로 추가. VELA-25 이후 §15.4에 backend 필드 추적 subsection 추가. §2 패키지 구조에 `unregister.ts`, `prune.ts` 반영.

### Follow-up Issues (Backlog)

다음 3개는 이번 릴리스에 포함되지 않았으며 `TODOS.md` 및 Paperclip 이슈 트래커의 backlog에 있다.

- **VELA-26 [AA-1]** — FS watcher for `~/.vela/projects.json` 자동 enqueue (chokidar 또는 fs.watch 기반)
- **VELA-27 [AA-2]** — 주기적 그래프 freshness check + 자동 refresh (launchd interval)
- **VELA-28 [AA-3]** — PageIndex 자동 인덱싱 on project register/boot (API 키 UX + build-queue 확장)

추가로 VELA-25에서 분리된 follow-up:

- **VELA-25 자체는 이번 릴리스에 완료.** (write-path 스키마 확장 + --backend/--failed 필터)

### Git History

이 릴리스에 포함된 커밋 (master 브랜치, 최신순):

```
689e511 docs(architecture): reflect VELA-13/15/16/18/25 completion + backend tracking
ce6d91d chore: baseline — track existing source tree
8a525c1 feat(pageindex): track backend per record; add --backend/--failed to vela index --list (VELA-25)
235eb3c fix(build-queue): stop() now awaits in-flight tick (VELA-15)
8175b7d feat(cli): improve vela index --list with sort/filter/size/nodes (VELA-18)
2aa2b37 fix(test): prevent registry leak in test-observability (VELA-16)
00fd9bd feat(cli): add vela unregister and vela prune subcommands (VELA-13)
```

### Test Health

```
tsc --noEmit:               exit 0
test-bootstrap.ts:          33/33 pass
test-observability.ts:      69/69 pass
test-auto-activation.ts:    47/47 pass
```

### Attribution

VELA-13, 15, 16, 18은 Paperclip CTO 에이전트 (Claude Sonnet 4.6 + Opus 4.6, Co-Authored-By 크레딧 포함)가 자율 구현했다. VELA-14, 17, 25는 운영자가 직접 구현했다. 자세한 비율과 왜 그렇게 나뉘었는지는 위의 commit body를 참조.

---

각 VELA-NN 이슈의 전체 맥락은 Paperclip 이슈 트래커(`[VELA] vela-union` 프로젝트)에 영구 저장되어 있다.
