// Test the Graphify integration end-to-end against a real project.
// Builds a graph for a small reference project, loads it, and exercises
// queryGraph / getNeighbors / getStats / refreshGraph.
//
// Run with:
//   pnpm --filter @vela-union/mcp-gateway build && \
//   node --experimental-strip-types scripts/test-graphify.ts

import { existsSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  buildGraph,
  loadGraph,
  queryGraph,
  getNeighbors,
  getStats,
  refreshGraph,
  invalidateCache,
  getGraphPath,
} from "../packages/mcp-gateway/dist/index.js";

const PROJECT_NAME = "paperclip";
// Repo root: env override or infer from this script's location (scripts/ → ..)
const REPO_ROOT =
  process.env["VELA_REPO_ROOT"] ??
  resolve(dirname(fileURLToPath(import.meta.url)), "..");
const PROJECT_PATH =
  process.env["GRAPHIFY_PROJECT_PATH"] ?? join(REPO_ROOT, "refs", "paperclip");

function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) {
    console.error(`FAIL: ${msg}`);
    process.exit(1);
  }
  console.log(`  ok  ${msg}`);
}

function main(): void {
  if (!existsSync(PROJECT_PATH)) {
    console.error(`Test project not found: ${PROJECT_PATH}`);
    process.exit(1);
  }

  console.log(`\n[1/6] Build graph for ${PROJECT_NAME} from ${PROJECT_PATH}`);
  const t0 = Date.now();
  const stats = buildGraph(PROJECT_NAME, PROJECT_PATH);
  const buildElapsed = Date.now() - t0;
  console.log(
    `      built in ${buildElapsed}ms — ${stats.nodes} nodes, ${stats.edges} edges, ${stats.communities} communities`,
  );
  assert(stats.exists, "graph file exists after build");
  assert(stats.nodes > 0, "graph has nodes");
  assert(stats.edges >= 0, "graph has non-negative edges");
  const path = getGraphPath(PROJECT_NAME);
  assert(existsSync(path), `graph file present at ${path}`);
  const fileSize = statSync(path).size;
  assert(fileSize > 0, `graph file is non-empty (${fileSize} bytes)`);

  console.log(`\n[2/6] Load graph from disk`);
  invalidateCache(PROJECT_NAME);
  const graph = loadGraph(PROJECT_NAME);
  assert(Array.isArray(graph.nodes), "graph.nodes is an array");
  assert(Array.isArray(graph.links), "graph.links is an array");
  assert(graph.nodes.length === stats.nodes, "loaded node count matches build stats");

  console.log(`\n[3/6] Query graph (substring search)`);
  // Query with the first node label that exists - guarantees at least one hit
  const firstLabeledNode = graph.nodes.find(
    (n) => typeof n.label === "string" && (n.label as string).length > 2,
  );
  assert(firstLabeledNode !== undefined, "graph has at least one labeled node");
  const sampleLabel = (firstLabeledNode!.label as string).slice(0, 3);
  const queryResults = queryGraph(PROJECT_NAME, sampleLabel, 5);
  console.log(`      query "${sampleLabel}" returned ${queryResults.length} results`);
  assert(queryResults.length > 0, `query "${sampleLabel}" returns results`);
  assert(
    queryResults[0]!.score >= 10,
    "top query result has a meaningful relevance score",
  );

  console.log(`\n[4/6] Get neighbors of a node`);
  // Find a node that actually has neighbors
  const linkedIds = new Set<string>();
  for (const link of graph.links) {
    linkedIds.add(link.source);
    linkedIds.add(link.target);
  }
  const linkedNode = graph.nodes.find((n) => linkedIds.has(n.id));
  if (linkedNode) {
    const neighborhood = getNeighbors(PROJECT_NAME, linkedNode.id);
    console.log(
      `      node "${neighborhood.node.label ?? neighborhood.node.id}" has ${neighborhood.neighbors.length} neighbors`,
    );
    assert(neighborhood.node.id === linkedNode.id, "returned node id matches request");
    assert(neighborhood.neighbors.length > 0, "node has at least one neighbor");
  } else {
    console.log("      (no linked nodes found — graph has only isolated nodes)");
  }

  console.log(`\n[5/6] getStats`);
  const stats2 = getStats(PROJECT_NAME);
  console.log(
    `      stats: nodes=${stats2.nodes} edges=${stats2.edges} communities=${stats2.communities} builtAt=${stats2.builtAt}`,
  );
  assert(stats2.exists, "stats reports graph exists");
  assert(stats2.nodes === stats.nodes, "getStats node count is consistent");

  console.log(`\n[6/6] Refresh graph (incremental, uses SHA256 cache)`);
  const t1 = Date.now();
  const refreshed = refreshGraph(PROJECT_NAME, PROJECT_PATH);
  const refreshElapsed = Date.now() - t1;
  console.log(`      refreshed in ${refreshElapsed}ms`);
  assert(refreshed.exists, "refreshed graph exists");
  assert(
    refreshElapsed < buildElapsed * 2,
    `refresh (${refreshElapsed}ms) is not dramatically slower than initial build (${buildElapsed}ms)`,
  );

  const storage = join(homedir(), ".vela", "graphify", PROJECT_NAME);
  console.log(`\nAll checks passed. Graph storage: ${storage}\n`);
}

main();
