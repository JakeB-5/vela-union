// Graphify integration for Vela Union
// AST-only knowledge graph wrapper around the graphifyy Python package.
//
// Storage convention: ~/.vela/graphify/{projectName}/graph.json
// - buildGraph()    spawns a Python helper that runs graphify.extract + cluster + to_json
// - loadGraph()     loads the JSON node-link graph into memory
// - queryGraph()    substring search over node labels (cheap, no LLM)
// - getNeighbors()  graph traversal of one hop from a node
// - getStats()      basic graph statistics for the gateway tools
// - refreshGraph()  re-runs the build using graphify's SHA256 cache for incremental updates

import { spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { listProjects } from "@vela-union/shared";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Repo root from packages/mcp-gateway/{src,dist}/graphify.{ts,js}
const REPO_ROOT = resolve(__dirname, "..", "..", "..");
const VENV_PYTHON = join(REPO_ROOT, ".venv", "bin", "python");
const BUILD_SCRIPT = join(REPO_ROOT, "scripts", "graphify_build.py");
const PLUGIN_GRAPHS_DIR = join(REPO_ROOT, "packages", "paperclip-plugin", "dist", "ui", "graphs");

const GRAPHIFY_ROOT = join(homedir(), ".vela", "graphify");

/** Confidence label as recorded by graphify on every edge. */
export type GraphifyConfidence = "EXTRACTED" | "INFERRED" | "AMBIGUOUS";

/** A node in the loaded graph. Extra fields from graphify are preserved. */
export interface GraphNode {
  id: string;
  label?: string;
  source_file?: string;
  source_location?: string;
  community?: number | null;
  file_type?: string;
  [key: string]: unknown;
}

/** An edge in the loaded graph. graphify uses `links` (NetworkX node-link). */
export interface GraphLink {
  source: string;
  target: string;
  relation?: string;
  confidence?: GraphifyConfidence;
  confidence_score?: number;
  [key: string]: unknown;
}

/** The shape of `graph.json` produced by graphify.export.to_json. */
export interface GraphData {
  directed?: boolean;
  multigraph?: boolean;
  graph?: Record<string, unknown>;
  nodes: GraphNode[];
  links: GraphLink[];
  hyperedges?: unknown[];
}

/** Stats returned from a build/refresh and from getStats(). */
export interface GraphStats {
  projectName: string;
  graphPath: string;
  nodes: number;
  edges: number;
  communities: number;
  builtAt: string;
  exists: boolean;
}

/** Result of a node-label search. */
export interface QueryResult {
  node: GraphNode;
  score: number;
}

/** A node and its one-hop neighborhood. */
export interface NeighborResult {
  node: GraphNode;
  neighbors: Array<{
    node: GraphNode;
    relation?: string;
    confidence?: GraphifyConfidence;
    direction: "out" | "in";
  }>;
}

const graphCache = new Map<string, GraphData>();

/** Path to the persisted graph for a project. */
export function getGraphPath(projectName: string): string {
  return join(GRAPHIFY_ROOT, projectName, "graph.json");
}

/** Whether a built graph exists on disk for the given project. */
export function graphExists(projectName: string): boolean {
  return existsSync(getGraphPath(projectName));
}

function ensureProjectDir(projectName: string): string {
  const dir = join(GRAPHIFY_ROOT, projectName);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
  return dir;
}

function runBuildScript(projectPath: string, outputDir: string, pluginGraphsDir?: string): {
  stdout: string;
  stderr: string;
  exitCode: number;
} {
  if (!existsSync(VENV_PYTHON)) {
    throw new Error(
      `Python venv not found at ${VENV_PYTHON}. Run \`python -m venv .venv && .venv/bin/pip install graphifyy\`.`,
    );
  }
  if (!existsSync(BUILD_SCRIPT)) {
    throw new Error(`graphify_build.py not found at ${BUILD_SCRIPT}`);
  }

  const args = [BUILD_SCRIPT, projectPath, outputDir];
  if (pluginGraphsDir) args.push(pluginGraphsDir);
  const result = spawnSync(VENV_PYTHON, args, {
    encoding: "utf-8",
    maxBuffer: 64 * 1024 * 1024,
  });

  return {
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
    exitCode: result.status ?? -1,
  };
}

/**
 * Build a fresh AST-only knowledge graph for a project. Writes to
 * ~/.vela/graphify/{projectName}/graph.json. Drops any in-memory cache for
 * this project. Spawns the helper script under .venv/bin/python so that
 * graphifyy and its tree-sitter native bindings are available.
 */
export function buildGraph(projectName: string, projectPath: string): GraphStats {
  if (!existsSync(projectPath)) {
    throw new Error(`projectPath does not exist: ${projectPath}`);
  }
  const outputDir = ensureProjectDir(projectName);
  const { stderr, exitCode } = runBuildScript(projectPath, outputDir, PLUGIN_GRAPHS_DIR);
  if (exitCode !== 0) {
    throw new Error(
      `graphify build failed (exit ${exitCode}) for ${projectName} at ${projectPath}\n${stderr}`,
    );
  }
  graphCache.delete(projectName);
  return getStats(projectName);
}

/**
 * Refresh an existing graph. graphify's SHA256+mtime cache lives under
 * graphify-out/cache/, but graphify_build.py uses graphify.extract.extract()
 * which checks `load_cached(path, root)` per file — meaning unchanged files
 * are skipped automatically. So `refreshGraph` is implemented as
 * `buildGraph` with the cache enabled (which it always is in the package).
 *
 * If no graph exists yet, this performs a full build.
 */
export function refreshGraph(projectName: string, projectPath: string): GraphStats {
  return buildGraph(projectName, projectPath);
}

/**
 * Load a graph from disk, caching it in-process for repeated queries within
 * the same gateway session. Throws if the graph file does not exist.
 */
export function loadGraph(projectName: string): GraphData {
  const cached = graphCache.get(projectName);
  if (cached) return cached;

  const path = getGraphPath(projectName);
  if (!existsSync(path)) {
    throw new Error(
      `No graph for project '${projectName}' at ${path}. Run buildGraph() first.`,
    );
  }
  const raw = readFileSync(path, "utf-8");
  const data = JSON.parse(raw) as GraphData;
  if (!Array.isArray(data.nodes) || !Array.isArray(data.links)) {
    throw new Error(`Invalid graph file at ${path}: missing nodes or links`);
  }
  graphCache.set(projectName, data);
  return data;
}

/** Drop a project from the in-memory cache (forces a re-read on next access). */
export function invalidateCache(projectName?: string): void {
  if (projectName) {
    graphCache.delete(projectName);
  } else {
    graphCache.clear();
  }
}

/**
 * Substring/case-insensitive search over node labels and ids. Returns up to
 * `limit` matches ordered by simple relevance (exact label match > prefix >
 * substring). This is intentionally cheap — for richer queries call out to
 * the `graphify query` CLI separately.
 */
export function queryGraph(
  projectName: string,
  query: string,
  limit = 20,
): QueryResult[] {
  const graph = loadGraph(projectName);
  const q = query.trim().toLowerCase();
  if (!q) return [];

  const results: QueryResult[] = [];
  for (const node of graph.nodes) {
    const label = (node.label ?? "").toString().toLowerCase();
    const id = node.id.toLowerCase();
    let score = 0;
    if (label === q || id === q) score = 100;
    else if (label.startsWith(q) || id.startsWith(q)) score = 50;
    else if (label.includes(q) || id.includes(q)) score = 10;
    if (score > 0) results.push({ node, score });
  }
  results.sort((a, b) => b.score - a.score);
  return results.slice(0, limit);
}

/** Look up a node by its exact id. Returns undefined if not present. */
export function getNode(projectName: string, nodeId: string): GraphNode | undefined {
  const graph = loadGraph(projectName);
  return graph.nodes.find((n) => n.id === nodeId);
}

/**
 * Return a node and its one-hop neighbors (both incoming and outgoing).
 * Direction is reported per edge: "out" if the queried node is the source,
 * "in" if it is the target.
 */
export function getNeighbors(projectName: string, nodeId: string): NeighborResult {
  const graph = loadGraph(projectName);
  const node = graph.nodes.find((n) => n.id === nodeId);
  if (!node) {
    throw new Error(`Node not found: ${nodeId}`);
  }

  const nodeIndex = new Map<string, GraphNode>();
  for (const n of graph.nodes) nodeIndex.set(n.id, n);

  const neighbors: NeighborResult["neighbors"] = [];
  for (const link of graph.links) {
    if (link.source === nodeId) {
      const target = nodeIndex.get(link.target);
      if (target) {
        neighbors.push({
          node: target,
          relation: link.relation,
          confidence: link.confidence,
          direction: "out",
        });
      }
    } else if (link.target === nodeId) {
      const source = nodeIndex.get(link.source);
      if (source) {
        neighbors.push({
          node: source,
          relation: link.relation,
          confidence: link.confidence,
          direction: "in",
        });
      }
    }
  }
  return { node, neighbors };
}

/** Basic graph statistics — node count, edge count, community count. */
export function getStats(projectName: string): GraphStats {
  const path = getGraphPath(projectName);
  if (!existsSync(path)) {
    return {
      projectName,
      graphPath: path,
      nodes: 0,
      edges: 0,
      communities: 0,
      builtAt: "",
      exists: false,
    };
  }
  const graph = loadGraph(projectName);
  const communities = new Set<number>();
  for (const node of graph.nodes) {
    if (typeof node.community === "number") communities.add(node.community);
  }
  const stat = statSync(path);
  return {
    projectName,
    graphPath: path,
    nodes: graph.nodes.length,
    edges: graph.links.length,
    communities: communities.size,
    builtAt: stat.mtime.toISOString(),
    exists: true,
  };
}

// ---------------------------------------------------------------------------
// VELA-56: Graph-viz reconciliation
// ---------------------------------------------------------------------------

export interface ReconcileResult {
  copied: string[];
  removed: string[];
  manifestEntries: string[];
}

/**
 * Walk every project in ~/.vela/graphify/, copy any graph.html into the plugin
 * dist/ui/graphs/ directory, remove stale HTML, and rewrite manifest.json.
 * Only projects present in the Vela registry (~/.vela/projects.json) are included.
 */
export function reconcileGraphViz(): ReconcileResult {
  const result: ReconcileResult = { copied: [], removed: [], manifestEntries: [] };

  mkdirSync(PLUGIN_GRAPHS_DIR, { recursive: true });
  if (!existsSync(GRAPHIFY_ROOT)) return result;

  const registeredNames = new Set(listProjects().map((p) => p.name));
  const sourceProjects = new Set<string>();

  for (const name of readdirSync(GRAPHIFY_ROOT)) {
    if (!registeredNames.has(name)) continue;
    const htmlPath = join(GRAPHIFY_ROOT, name, "graph.html");
    if (existsSync(htmlPath)) {
      sourceProjects.add(name);
      try {
        copyFileSync(htmlPath, join(PLUGIN_GRAPHS_DIR, `${name}.html`));
        result.copied.push(name);
      } catch {
        // best-effort
      }
    }
  }

  for (const file of readdirSync(PLUGIN_GRAPHS_DIR)) {
    if (!file.endsWith(".html")) continue;
    const stem = file.replace(/\.html$/, "");
    if (!sourceProjects.has(stem)) {
      try {
        unlinkSync(join(PLUGIN_GRAPHS_DIR, file));
        result.removed.push(stem);
      } catch {
        // best-effort
      }
    }
  }

  const entries = readdirSync(PLUGIN_GRAPHS_DIR)
    .filter((f) => f.endsWith(".html"))
    .map((f) => f.replace(/\.html$/, ""))
    .sort();
  writeFileSync(join(PLUGIN_GRAPHS_DIR, "manifest.json"), JSON.stringify(entries), "utf-8");
  result.manifestEntries = entries;

  return result;
}
