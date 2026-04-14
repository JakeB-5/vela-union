// Vela Union MCP Gateway
// Phase 4: Unified MCP server wrapping Graphify + PageIndex + gstack
//
// Tool namespaces exposed by buildServer():
//   doc.*    PageIndex (document reasoning) — index, get_structure, get_pages
//   graph.*  Graphify  (AST knowledge graph) — build, query, get_neighbors,
//                                              get_node, stats, refresh
//   gstack.* gstack adapter (Claude CLI)    — execute_skill, dispatch_goal,
//                                              list_goals, check_availability
//   vela.*   meta utilities                  — list_projects

export const MCP_GATEWAY_VERSION = "0.1.0";

// Graphify integration — AST-only knowledge graph wrapper.
export {
  buildGraph,
  refreshGraph,
  loadGraph,
  invalidateCache,
  queryGraph,
  getNode,
  getNeighbors,
  getStats,
  getGraphPath,
  graphExists,
} from "./graphify.js";

export type {
  GraphData,
  GraphNode,
  GraphLink,
  GraphStats,
  QueryResult,
  NeighborResult,
  GraphifyConfidence,
} from "./graphify.js";

// PageIndex wrapper
export {
  createPageIndex,
  convertMarkdownToPdf,
  submitPdfToCloud,
  PAGEINDEX_PATHS,
  PAGEINDEX_HELPERS,
  listIndexedDocsOnDisk,
} from "./pageindex.js";

export type {
  PageIndexConfig,
  PageIndexAdapter,
  PageIndexAvailability,
  PageIndexNode,
  PageIndexDocument,
  PageContentSlice,
  CloudIndexEntry,
  CloudStatusFile,
  IndexResult,
  CloudSubmitResult,
} from "./pageindex.js";

// gstack proxy — registry-aware wrappers around @vela-union/gstack-adapter
export {
  checkAvailability as gstackCheckAvailability,
  executeSkill as gstackExecuteSkill,
  dispatchGoal as gstackDispatchGoal,
  listProxyGoals as gstackListGoals,
} from "./gstack-proxy.js";

export type { GstackProxyResult } from "./gstack-proxy.js";

// MCP server entry point
export { buildServer } from "./server.js";
