# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project: Vela Union

5개의 독립 오픈소스 시스템을 통합하는 에이전트 오케스트레이션 플랫폼.

## Architecture — 5-System Integration

| 시스템 | 역할 | 핵심 질문 |
|--------|------|----------|
| **Paperclip** | 조직 & 거버넌스 — 에이전트를 "직원"으로 고용, 조직도 관리 | 누가 언제 무엇을 하는가? |
| **gstack** | 실행 능력 — Claude Code를 전문가 팀으로 변환 | 어떻게 리뷰/테스트/배포하는가? |
| **Graphify** | 지식 그래프 — 코드·문서·결정을 쿼리 가능한 그래프로 변환 | 코드·문서·결정이 어떻게 연결되는가? |
| **PageIndex** | 문서 이해 — LLM 추론 기반 문서 검색 (벡터 유사도 X) | 문서에서 무엇을 찾아야 하는가? |
| **gbrain** | 장기 기억 — 하이브리드 의미 검색 기반 엔티티/결정 기억 | 무엇을 알고 있는가? |

### System Flow

Paperclip(지휘) → gstack(실행) → Graphify(구조) → PageIndex(검색) → gbrain(기억) — 실행 결과가 지식에 반영되고, 다음 실행이 그 지식을 참조하는 순환 구조.

### Graphify vs PageIndex vs gbrain

- **Graphify**: 코드+문서 혼합 대상, 지식 그래프(노드/엣지), 관계 기반 쿼리. "이 코드는 왜 이렇게 되었나?"
- **PageIndex**: 문서 전문 대상, 계층 트리(목차), 추론 기반 섹션 탐색. "스펙 3.2절에 뭐라고 써있나?"
- **gbrain**: 마크다운 수천 개 대상, 하이브리드 벡터+키워드 검색, 크로스 프로젝트 엔티티 기억. "지난주 결정이 뭐였지?"

## Upstream References

- Paperclip: https://github.com/paperclipai/paperclip (https://paperclip.ing)
- gstack: https://github.com/garrytan/gstack
- Graphify: https://github.com/safishamsi/graphify
- PageIndex: https://github.com/VectifyAI/PageIndex
- gbrain: https://github.com/JakeB-5/gbrain (fork of https://github.com/garrytan/gbrain)
