# gbrain 도입 검토 — Vela Union 5번째 레고 블록 후보

_작성일: 2026-04-11_
_대상: Vela Union 통합 스택 확장 검토_
_결론: **Go** (조건부 — Phase 1 의미 검색 품질 검증 후)_

---

## 1. 배경

Vela Union은 여러 프로젝트를 AI 에이전트와 함께 운영하는 로컬 오케스트레이션 플랫폼으로, 현재 4개의 오픈소스 시스템(Paperclip, gstack, Graphify, PageIndex)을 단일 MCP 게이트웨이로 통합하는 초기 설계 단계에 있다. 본 문서는 **5번째 시스템으로 [garrytan/gbrain](https://github.com/garrytan/gbrain)을 추가할지** 검토한 결과를 기록한다.

검토 맥락:

- **대상 프로젝트 docs**: 파일 250개, 마크다운 230개 (archive/, guides/, product-strategy/, qa/, reports/, samples/, specs/, REFACTORING_PLAN.md)
- **vela-union**: 초기 설계 단계 (architecture.md + integration-plan.md), graphify 캐시 존재, MCP Gateway 14개 도구 설계 중
- **운영 규모**: 대규모 코드베이스, 다수 프로젝트 동시 관리

---

## 2. gbrain 개요

### 정체

Y Combinator 대표 Garry Tan이 직접 운영하는 **AI 에이전트용 개인 지식 베이스**. 마크다운 파일 기반의 장기 기억 레이어로, 에이전트가 매 응답 전 읽고 매 응답 후 쓰면서 매일 지식이 복리로 누적되는 구조.

- **언어/런타임**: TypeScript (Bun)
- **라이선스**: MIT
- **인기도**: ⭐ 4,043 stars / 449 forks (2026-04-11 기준)
- **스토리지**: PGLite (로컬 임베디드 Postgres) → 필요 시 Supabase 마이그레이션
- **검색**: 하이브리드 (pgvector + 키워드 + RRF)

### 핵심 아키텍처

```
마크다운 Git 저장소  ←→  GBrain (Postgres+pgvector)  ←→  AI 에이전트
(원본/진실 소스)         (검색 레이어)                    (읽기/쓰기)
```

### 3계층 메모리 모델

| 레이어 | 역할 | 쿼리 방법 |
|---|---|---|
| **gbrain** | 세계 지식 (사람/회사/딜/미팅/아이디어) | `gbrain search/query/get` |
| **에이전트 메모리** | 운영 설정/선호/결정 | `memory_search` |
| **세션 컨텍스트** | 현재 대화 | 자동 |

### 주요 특징

- **PGLite 기본** — 2초 만에 로컬 Postgres 준비, 서버/계정 불필요
- **37개 operation / 30개 MCP 도구** — stdio + remote(Supabase Edge Function) 양쪽 지원
- **Compounding Loop** — 신호 입력 → 엔티티 탐지 → READ → 응답 → WRITE → 재인덱싱
- **통합 레시피** — ngrok/Gmail/Twilio Voice/Calendar/X/Circleback
- **확장 경로** — 1,000 파일 이상 시 `gbrain migrate --to supabase`

### 실제 운영 규모 (Garry Tan)

10,000+ 마크다운 파일, 3,000+ 인물 페이지, 13년치 캘린더, 280+ 미팅 전사, 300+ 아이디어.

---

## 3. 유사 도구와의 비교

### vs PageIndex (VectifyAI/PageIndex)

| 항목 | gbrain | PageIndex |
|---|---|---|
| 정체 | 에이전트 장기 기억 | Vectorless RAG |
| 입력 단위 | 수천~수만 개 마크다운 | 개별 긴 PDF |
| 검색 | 하이브리드 (벡터+키워드+RRF) | 트리 탐색 (LLM 추론) |
| 벡터 DB | 사용 | 미사용 (철학적 거부) |
| 성과 | Garry Tan 1인 10K 파일 운영 | FinanceBench 98.7% SOTA |

**결론**: 레이어가 다름. PageIndex는 "한 문서를 잘 읽는 법", gbrain은 "읽은 것을 기억하는 법".

### vs Graphify (safishamsi/graphify)

| 항목 | gbrain | graphify |
|---|---|---|
| 정체 | 에이전트 장기 기억 | 폴더 → 지식 그래프 |
| 입력 단위 | 엔티티 페이지 누적 | 폴더 전체 일괄 변환 |
| 검색 | 하이브리드 | 그래프 위상 (Leiden, 임베딩 없음) |
| 코드 분석 | ❌ 지식 중심 | ✅ 20개 언어 tree-sitter AST |
| 산출물 | MCP 30개 + 엔티티 페이지 | graph.html + GRAPH_REPORT.md + graph.json |
| 쓰기/읽기 | Write 지향 (매일 누적) | Read 지향 (일회성 변환) |

**결론**: graphify는 "지금 이 코드의 구조", gbrain은 "내가 아는 세계". 완전히 다른 레이어.

### 3종 세트 역할 분담

```
┌─────────────────────────────────────┐
│        AI 에이전트 (Claude Code)     │
└──┬──────────────┬─────────────┬─────┘
   │              │             │
┌──▼────┐  ┌──────▼─────┐  ┌────▼──────┐
│graphify│  │ PageIndex  │  │  gbrain   │
│폴더 구조│  │ 문서 추출  │  │ 장기 기억 │
└────────┘  └────────────┘  └───────────┘
 "지금 코드"  "이 문서 내용"   "내가 아는 세계"
 structural    one-shot         lifelong
```

---

## 4. Vela Union 관점의 빈 슬롯 분석

### 현재 4개 시스템이 답하는 질문

| 시스템 | 답하는 질문 |
|---|---|
| Paperclip | 누가 언제 무엇을 하는가? |
| gstack | 어떻게 리뷰/테스트/배포하는가? |
| Graphify | 코드·문서·결정이 어떻게 연결되는가? |
| PageIndex | 문서에서 무엇을 찾아야 하는가? |

### 빠진 슬롯

> **"내가 지금까지 뭘 결정했고 왜 그랬는가? 시간 축으로 무엇이 쌓였는가? 이 사람/회사/아이디어는 어느 프로젝트들과 엮여 있는가?"**

이 질문에 답할 수 있는 시스템이 현재 스택에 **없다**. 이것이 정확히 gbrain의 엔티티 + append-only 타임라인 + 복리 루프가 채우는 슬롯이다.

### 구체적 차이 예시

| 케이스 | 현재 스택 | gbrain 추가 시 |
|---|---|---|
| "프로젝트에서 이 함수를 누가 호출하나?" | ✅ Graphify | — |
| "REFACTORING_PLAN.md 2장 세션 모델" | ✅ PageIndex | — |
| "프로젝트 A와 vela-union 공통 설계 결정은?" | ❌ | ✅ gbrain |
| "지난주 VLM 벤치마크 결론이 뭐였지?" | ❌ | ✅ gbrain |
| "A 프로젝트 X 설계가 B 프로젝트 Y 결정에 준 영향?" | ❌ | ✅ gbrain |
| "이 아이디어 전에 어디서 언급했지?" | ❌ | ✅ gbrain |

---

## 5. 도입 효용성 평가

### 효용성: 크다 — 4가지 실질 이득

1. **크로스 프로젝트 컨텍스트 자동화**
   - Vela Union README가 적시한 문제: _"프로젝트 간 관계와 메타데이터를 매번 수동으로 주입한다"_
   - 이게 정확히 gbrain의 엔티티 그래프가 해결하는 문제
   - Paperclip Briefing Pack 생성 단계에서 `gbrain search` 한 줄로 해결

2. **230개 마크다운의 즉시 활용**
   - `gbrain import <project>/docs` → 2초
   - `gbrain embed --stale` → 약 1분
   - PageIndex가 개별 문서 내부를 파는 것과 달리, gbrain은 230개 **사이를 횡단**

3. **결정 로그의 타임라인화**
   - REFACTORING_PLAN.md + product-strategy/ + reports/ → gbrain의 "compiled truth + append-only timeline" 패턴에 그대로 맞음
   - 4개월치 진화 히스토리를 구조화된 기억으로 전환

4. **타이밍 프리미엄**
   - MCP Gateway 14개 도구가 설계 중인 상태 → gbrain MCP 30개 도구를 게이트웨이 뒤에 래핑하면 네이티브로 녹아듦
   - 나중에 추가하면 기존 도구 네이밍/경계 재설계 비용 큼

### 리스크: 관리 가능 — 3가지 주의사항

1. **경계 명문화 필수**
   - vela-union `docs/architecture.md`에 5개 시스템 역할 표를 먼저 고정
   - 이게 없으면 "결정 로그는 어디에?" 질문이 반복됨

2. **중복 저장 방지**
   - 코드 자체 → gbrain 금지 (graphify 영역)
   - 단일 긴 PDF 내부 구조 → gbrain 금지 (PageIndex 영역)
   - **gbrain 전용**: 사람/회사/결정/아이디어/미팅/프로젝트 엔티티 페이지

3. **비용 모니터링**
   - 230 페이지 초기 임베딩: 몇 센트 수준
   - 다수 프로젝트 전체 + daily sync 시 OpenAI 임베딩 비용 월 단위로 상승 가능
   - 단계적 확장으로 억제

---

## 6. 단계적 도입 플랜

### Phase 1 — Proof of Value (30분)

```bash
curl -fsSL https://bun.sh/install | bash
bun add -g github:garrytan/gbrain
cd ~/projects/<target-project>
gbrain init
gbrain import ./docs --no-embed
gbrain stats
gbrain embed --stale
gbrain query "세션 모델 리팩터에서 내린 결정들"
gbrain query "VLM 평가 파이프라인의 핵심 이슈"
```

**검증 기준**: 의미 검색이 Grep 대비 명백히 좋은가? 엉뚱한 매칭은 얼마나 많은가?

> Phase 1 결과가 실망스럽다면 전체 판단을 재검토한다. 이 단계가 최종 go/no-go의 근거.

### Phase 2 — Vela Union 통합 설계 (1시간)

- `docs/architecture.md`에 §16 gbrain: 기억 레이어 섹션 추가
- 5개 시스템 역할 경계 표로 확장:

  | 시스템 | 역할 | 핵심 질문 |
  |---|---|---|
  | Paperclip | 거버넌스 | 누가 언제 무엇을? |
  | gstack | 실행 | 어떻게? |
  | Graphify | 코드 구조 | 어떻게 연결되는가? |
  | PageIndex | 문서 추론 | 문서 안에 무엇이? |
  | **gbrain** | **기억/엔티티** | **무엇을 알고 있는가?** |

- `docs/integration-plan.md`에 gbrain MCP 도구 래핑 계획 추가
  - `knowledge.search`, `knowledge.get`, `knowledge.put` 같은 게이트웨이 네임스페이스로 추상화

### Phase 3 — Paperclip 플러그인 통합 (1시간)

- Briefing Pack 생성 단계에서 `gbrain search "{goal}"` 결과를 프롬프트에 주입
- `agent.woke` 이벤트에서 현재 프로젝트의 gbrain 컨텍스트 자동 로드
- 결정 후 `gbrain put`으로 타임라인 append

### Phase 4 — 확장 (이후)

- 10+ 프로젝트 전역 인스턴스 (Supabase) vs 프로젝트별 PGLite 결정
- Remote MCP 엔드포인트 (Claude Desktop/Cursor 등 다중 클라이언트)

---

## 7. 최종 결론

| 질문 | 답 |
|---|---|
| Vela Union에 gbrain 도입이 긍정적인가? | ✅ 예 |
| 타이밍은 맞는가? | ✅ 지금이 최적 (초기 설계 단계) |
| 기존 스택과 충돌하는가? | ❌ 아니오 (빈 슬롯 충전) |
| 대상 프로젝트 docs 230개가 충분한 input인가? | ✅ 예 |
| 다수 프로젝트 운영 환경 = gbrain 타겟? | ✅ 정확히 일치 |
| 선결 조건은? | ⚠️ 역할 경계 명문화 필수 |
| 리스크 수준은? | 🟡 낮음-중간 (관리 가능) |

### Go 판단 근거 요약

1. **Vela Union은 메타 오케스트레이션 레이어** — 레고 블록 추가가 설계 의도
2. **5번째 블록을 끼우기 가장 쉬운 타이밍** (초기 설계, 아직 굳지 않음)
3. **빈 슬롯 존재** — 기억/엔티티/타임라인 기능을 기존 4개 시스템 어느 것도 담당하지 않음
4. **구조적 일치** — 다수 프로젝트 운영 케이스와 gbrain 설계 의도가 동형
5. **230개 마크다운 + 대규모 코드베이스 + 장기 운영 히스토리** = gbrain input으로 이상적

### 다음 액션

1. ~~**즉시**: Phase 1 실행 → 대상 프로젝트 docs에 대한 의미 검색 품질을 눈으로 확인~~ ✅ 완료 (2026-04-13)
2. ~~**Phase 1 통과 시**: Vela Union architecture.md에 5번째 시스템으로 공식 등재~~ ✅ 완료 (§16 추가)
3. **통합**: Paperclip Briefing Pack + MCP Gateway에 gbrain 편입 → Paperclip 이슈 등록됨

---

## 8. Phase 1 검증 결과 (2026-04-13)

### 변경 사항: OpenAI → 로컬 Ollama 전환

원본 문서는 OpenAI `text-embedding-3-large`를 전제했으나, Phase 1에서 로컬 대안을 검토한 결과:

- **gbrain fork 생성**: [JakeB-5/gbrain](https://github.com/JakeB-5/gbrain) — Ollama + bge-m3 (1024d) 기본
- **OpenAI API 키 불필요** — 임베딩 비용 $0
- **한/영 다국어**: bge-m3가 다국어 특화 모델로 한국어 문서 검색에 우수

### 검증 데이터

| 항목 | 값 |
|------|-----|
| 입력 | 대상 프로젝트 docs 230개 마크다운 |
| 청크 | 2,101개 |
| 임베딩 | Ollama bge-m3, 1024d, PGLite 로컬 |
| 비용 | $0 |

### 검색 품질 테스트

| 쿼리 | 언어 | 1위 결과 | 점수 | 정확도 |
|------|------|---------|------|--------|
| "캐시 성능 개선 전략" | KR | `cache_improvement_plan` | 0.9996 | 정확 |
| "레이어 패널 드래그 앤 드롭" | KR | `w2p_editor_feature_overview` | 1.0 | 정확 |
| "CMYK soft proofing" | EN | `specs/cmyk-soft-proofing` | 1.0 | 정확 |
| "e2e test plan" | EN | `e2e_test_analysis_and_improvement_plan` | 1.0 | 정확 |
| "PDF 색상 프로파일 관리" | KR | `implementation_summary_pdf_p3` | 0.84 | 정확 |

### 판정: **Go — 조건 충족**

의미 검색이 grep 대비 명확히 우위. 특히 "캐시 성능 개선 전략"처럼 문서에 해당 문자열이 없는 경우에도 관련 문서를 정확히 찾음.

---

## 9. 참고 링크

- [garrytan/gbrain](https://github.com/garrytan/gbrain) — 6,400+ stars, MIT, TypeScript (upstream)
- [JakeB-5/gbrain](https://github.com/JakeB-5/gbrain) — Local LLM fork (Ollama + bge-m3 기본)
- [VectifyAI/PageIndex](https://github.com/VectifyAI/PageIndex) — 비교 대상 1
- [safishamsi/graphify](https://github.com/safishamsi/graphify) — 비교 대상 2
- Garry Tan의 OpenClaw 사용 사례: [openclaw.ai](https://openclaw.ai)

---

_본 문서는 2026-04-11 Claude Code 세션에서 이루어진 gbrain 도입 검토 토론의 기록이다. Phase 1 검증이 2026-04-13에 완료되어 Go 판정을 받았다._
