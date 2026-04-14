// packages/mcp-gateway/src/gbrain.ts
//
// knowledge.* MCP tool adapter — connects directly to the gbrain PGLite
// database (same @electric-sql/pglite library that gbrain uses internally;
// no subprocess, no network call, no gbrain binary required).
//
// Default brain path: ~/.vela/gbrain/brain.pglite
// Override: VELA_GBRAIN_PATH env var
//
// Boundary rules (from VELA-34):
//   ✅ entity pages: person/company/decision/idea/meeting/project
//   ❌ no code storage (Graphify domain)
//   ❌ no single-doc internals (PageIndex domain)

import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { PGlite } from "@electric-sql/pglite";
import { vector } from "@electric-sql/pglite/vector";

let _db: PGlite | null = null;

// Ollama embedding config (matches JakeB-5/gbrain fork defaults)
const EMBEDDING_BASE_URL = process.env["GBRAIN_EMBEDDING_BASE_URL"] ?? process.env["OPENAI_BASE_URL"] ?? "http://localhost:11434/v1";
const EMBEDDING_MODEL = process.env["GBRAIN_EMBEDDING_MODEL"] ?? "bge-m3";
const EMBEDDING_API_KEY = process.env["GBRAIN_EMBEDDING_API_KEY"] ?? process.env["OPENAI_API_KEY"] ?? "ollama";
const RRF_K = 60;

function getBrainPath(): string {
  return (
    process.env["VELA_GBRAIN_PATH"] ??
    join(homedir(), ".gbrain", "brain.pglite")
  );
}

export interface KnowledgeAvailability {
  available: boolean;
  reason?: string;
  brain_path: string;
}

/** Check if the brain database exists and is accessible. */
export function checkAvailability(): KnowledgeAvailability {
  const brain_path = getBrainPath();
  if (!existsSync(brain_path)) {
    return {
      available: false,
      reason: `brain not initialised — run 'gbrain init' first (expected: ${brain_path})`,
      brain_path,
    };
  }
  return { available: true, brain_path };
}

/** Lazy-connect to PGLite with pgvector extension; reuses the singleton across tool calls. */
async function getDb(): Promise<PGlite> {
  if (_db) return _db;

  const brain_path = getBrainPath();
  // Ensure parent directory exists (idempotent)
  const dir = join(brain_path, "..");
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });

  _db = await PGlite.create({
    dataDir: brain_path,
    extensions: { vector },
  });
  return _db;
}

// ---------------------------------------------------------------------------
// Exported types (mirror the relevant subset of gbrain's types)
// ---------------------------------------------------------------------------

export type KnowledgePageType =
  | "person"
  | "company"
  | "decision"
  | "idea"
  | "meeting"
  | "project"
  | "concept"
  | "source"
  | "media";

export interface KnowledgePage {
  slug: string;
  type: KnowledgePageType;
  title: string;
  compiled_truth: string;
  timeline: string;
  frontmatter: Record<string, unknown>;
  content_hash: string | null;
  created_at: string;
  updated_at: string;
}

export interface KnowledgeSearchResult {
  slug: string;
  title: string;
  type: KnowledgePageType;
  score: number;
  excerpt: string;
}

export interface KnowledgeStats {
  page_count: number;
  chunk_count: number;
  embedded_count: number;
  link_count: number;
  tag_count: number;
  timeline_entry_count: number;
  pages_by_type: Record<string, number>;
  brain_path: string;
}

export interface KnowledgePageInput {
  type: KnowledgePageType;
  title: string;
  compiled_truth: string;
  timeline?: string;
  frontmatter?: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Internal row mappers
// ---------------------------------------------------------------------------

function rowToPage(row: Record<string, unknown>): KnowledgePage {
  return {
    slug: row["slug"] as string,
    type: row["type"] as KnowledgePageType,
    title: row["title"] as string,
    compiled_truth: (row["compiled_truth"] as string) ?? "",
    timeline: (row["timeline"] as string) ?? "",
    frontmatter:
      typeof row["frontmatter"] === "object" && row["frontmatter"] !== null
        ? (row["frontmatter"] as Record<string, unknown>)
        : {},
    content_hash: (row["content_hash"] as string | null) ?? null,
    created_at: row["created_at"] instanceof Date
      ? row["created_at"].toISOString()
      : String(row["created_at"] ?? ""),
    updated_at: row["updated_at"] instanceof Date
      ? row["updated_at"].toISOString()
      : String(row["updated_at"] ?? ""),
  };
}

// ---------------------------------------------------------------------------
// Embedding via Ollama (or any OpenAI-compatible endpoint)
// ---------------------------------------------------------------------------

async function embedQuery(text: string): Promise<Float32Array | null> {
  try {
    const resp = await fetch(`${EMBEDDING_BASE_URL}/embeddings`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "Authorization": `Bearer ${EMBEDDING_API_KEY}` },
      body: JSON.stringify({ model: EMBEDDING_MODEL, input: text.slice(0, 8000) }),
    });
    if (!resp.ok) return null;
    const data = (await resp.json()) as { data: { embedding: number[] }[] };
    return new Float32Array(data.data[0].embedding);
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// knowledge.search — Hybrid search: vector + keyword + RRF fusion
// ---------------------------------------------------------------------------

interface RawSearchHit { slug: string; title: string; type: string; chunk_text: string; score: number }

async function searchKeyword(db: PGlite, query: string, innerLimit: number): Promise<RawSearchHit[]> {
  const { rows } = await db.query(
    `SELECT DISTINCT ON (p.slug)
       p.slug, p.title, p.type, cc.chunk_text,
       ts_rank(p.search_vector, websearch_to_tsquery('english', $1)) AS score
     FROM pages p
     JOIN content_chunks cc ON cc.page_id = p.id
     WHERE p.search_vector @@ websearch_to_tsquery('english', $1)
     ORDER BY p.slug, score DESC`,
    [query],
  );
  return (rows as Record<string, unknown>[])
    .sort((a, b) => Number(b["score"]) - Number(a["score"]))
    .slice(0, innerLimit)
    .map((r) => ({
      slug: r["slug"] as string, title: r["title"] as string,
      type: r["type"] as string, chunk_text: (r["chunk_text"] as string) ?? "",
      score: Number(r["score"]),
    }));
}

async function searchVector(db: PGlite, embedding: Float32Array, innerLimit: number): Promise<RawSearchHit[]> {
  const vecStr = "[" + Array.from(embedding).join(",") + "]";
  const { rows } = await db.query(
    `SELECT p.slug, p.title, p.type, cc.chunk_text,
       1 - (cc.embedding <=> $1::vector) AS score
     FROM content_chunks cc
     JOIN pages p ON p.id = cc.page_id
     WHERE cc.embedding IS NOT NULL
     ORDER BY cc.embedding <=> $1::vector
     LIMIT $2`,
    [vecStr, innerLimit],
  );
  return (rows as Record<string, unknown>[]).map((r) => ({
    slug: r["slug"] as string, title: r["title"] as string,
    type: r["type"] as string, chunk_text: (r["chunk_text"] as string) ?? "",
    score: Number(r["score"]),
  }));
}

function rrfFusion(lists: RawSearchHit[][]): RawSearchHit[] {
  const scores = new Map<string, { hit: RawSearchHit; score: number }>();
  for (const list of lists) {
    for (let rank = 0; rank < list.length; rank++) {
      const r = list[rank];
      const key = `${r.slug}:${r.chunk_text.slice(0, 50)}`;
      const existing = scores.get(key);
      const rrfScore = 1 / (RRF_K + rank);
      if (existing) existing.score += rrfScore;
      else scores.set(key, { hit: r, score: rrfScore });
    }
  }
  return Array.from(scores.values())
    .sort((a, b) => b.score - a.score)
    .map(({ hit, score }) => ({ ...hit, score }));
}

function dedupBySlug(hits: RawSearchHit[], maxPerPage = 2): RawSearchHit[] {
  const counts = new Map<string, number>();
  return hits.filter((h) => {
    const c = counts.get(h.slug) ?? 0;
    if (c >= maxPerPage) return false;
    counts.set(h.slug, c + 1);
    return true;
  });
}

export async function knowledgeSearch(
  query: string,
  limit = 20,
): Promise<{ success: true; count: number; results: KnowledgeSearchResult[] } | { success: false; error: string }> {
  try {
    const db = await getDb();
    const clamped = Math.min(Math.max(1, Math.floor(limit)), 100);
    const innerLimit = Math.min(clamped * 3, 100);

    // 1. Keyword search (always runs)
    const kwResults = await searchKeyword(db, query, innerLimit);

    // 2. Vector search (needs Ollama running)
    const embedding = await embedQuery(query);
    let merged: RawSearchHit[];
    if (embedding) {
      const vecResults = await searchVector(db, embedding, innerLimit);
      merged = rrfFusion([vecResults, kwResults]);
    } else {
      merged = kwResults;
    }

    // 3. Dedup + limit
    const deduped = dedupBySlug(merged);
    const results: KnowledgeSearchResult[] = deduped.slice(0, clamped).map((r) => ({
      slug: r.slug,
      title: r.title,
      type: r.type as KnowledgePageType,
      score: r.score,
      excerpt: r.chunk_text.slice(0, 300),
    }));

    return { success: true, count: results.length, results };
  } catch (err) {
    return { success: false, error: (err as Error).message };
  }
}

// ---------------------------------------------------------------------------
// knowledge.get — read entity page by slug
// ---------------------------------------------------------------------------

export async function knowledgeGet(
  slug: string,
): Promise<{ success: true; page: KnowledgePage } | { success: false; error: string }> {
  try {
    const db = await getDb();
    const { rows } = await db.query(
      `SELECT id, slug, type, title, compiled_truth, timeline, frontmatter, content_hash, created_at, updated_at
       FROM pages WHERE slug = $1`,
      [slug],
    );
    if (rows.length === 0) {
      return { success: false, error: `page not found: ${slug}` };
    }
    return { success: true, page: rowToPage(rows[0] as Record<string, unknown>) };
  } catch (err) {
    return { success: false, error: (err as Error).message };
  }
}

// ---------------------------------------------------------------------------
// knowledge.put — write/update entity or decision
// ---------------------------------------------------------------------------

export async function knowledgePut(
  slug: string,
  page: KnowledgePageInput,
): Promise<{ success: true; page: KnowledgePage; action: "created" | "updated" } | { success: false; error: string }> {
  try {
    const db = await getDb();
    const frontmatter = page.frontmatter ?? {};
    const timeline = page.timeline ?? "";

    // Check if it already exists to report action
    const exists = await db.query(`SELECT 1 FROM pages WHERE slug = $1`, [slug]);
    const action: "created" | "updated" = exists.rows.length > 0 ? "updated" : "created";

    const { rows } = await db.query(
      `INSERT INTO pages (slug, type, title, compiled_truth, timeline, frontmatter, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6::jsonb, now())
       ON CONFLICT (slug) DO UPDATE SET
         type            = EXCLUDED.type,
         title           = EXCLUDED.title,
         compiled_truth  = EXCLUDED.compiled_truth,
         timeline        = EXCLUDED.timeline,
         frontmatter     = EXCLUDED.frontmatter,
         updated_at      = now()
       RETURNING id, slug, type, title, compiled_truth, timeline, frontmatter, content_hash, created_at, updated_at`,
      [slug, page.type, page.title, page.compiled_truth, timeline, JSON.stringify(frontmatter)],
    );

    return { success: true, page: rowToPage(rows[0] as Record<string, unknown>), action };
  } catch (err) {
    return { success: false, error: (err as Error).message };
  }
}

// ---------------------------------------------------------------------------
// knowledge.stats — brain statistics
// ---------------------------------------------------------------------------

export async function knowledgeStats(): Promise<
  { success: true; stats: KnowledgeStats } | { success: false; error: string }
> {
  try {
    const db = await getDb();
    const brain_path = getBrainPath();

    const { rows: [statsRow] } = await db.query(`
      SELECT
        (SELECT count(*) FROM pages)                                              AS page_count,
        (SELECT count(*) FROM content_chunks)                                     AS chunk_count,
        (SELECT count(*) FROM content_chunks WHERE embedded_at IS NOT NULL)       AS embedded_count,
        (SELECT count(*) FROM links)                                              AS link_count,
        (SELECT count(DISTINCT tag) FROM tags)                                    AS tag_count,
        (SELECT count(*) FROM timeline_entries)                                   AS timeline_entry_count
    `);

    const { rows: typeRows } = await db.query(
      `SELECT type, count(*)::int AS count FROM pages GROUP BY type ORDER BY count DESC`,
    );

    const pages_by_type: Record<string, number> = {};
    for (const t of typeRows as { type: string; count: number }[]) {
      pages_by_type[t.type] = t.count;
    }

    const s = statsRow as Record<string, unknown>;
    return {
      success: true,
      stats: {
        page_count: Number(s["page_count"]),
        chunk_count: Number(s["chunk_count"]),
        embedded_count: Number(s["embedded_count"]),
        link_count: Number(s["link_count"]),
        tag_count: Number(s["tag_count"]),
        timeline_entry_count: Number(s["timeline_entry_count"]),
        pages_by_type,
        brain_path,
      },
    };
  } catch (err) {
    return { success: false, error: (err as Error).message };
  }
}
