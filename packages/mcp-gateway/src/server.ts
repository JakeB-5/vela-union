#!/usr/bin/env node
// Vela Union MCP Gateway server (stdio)
//
// Phase 4 — unified gateway. Exposes a single MCP server with namespaced tools:
//   doc.*    PageIndex (document reasoning)
//   graph.*  Graphify  (AST knowledge graph)
//   gstack.* gstack adapter (skill / goal execution via Claude CLI)
//   vela.*   meta utilities (project registry, etc.)

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

import { createLogger, generateCid, getProject, listProjects } from "@vela-union/shared";
import type { Logger } from "@vela-union/shared";

import { MCP_GATEWAY_VERSION } from "./index.js";
import { createPageIndex } from "./pageindex.js";
import {
  buildGraph,
  refreshGraph,
  queryGraph,
  getNeighbors,
  getNode,
  getStats,
  graphExists,
  reconcileGraphViz,
} from "./graphify.js";
import {
  enqueue as enqueueBuild,
  isQueued as isBuildQueued,
  readStatus as readBuildStatus,
} from "./build-queue.js";
import {
  checkAvailability as gstackCheckAvailability,
  executeSkill as gstackExecuteSkill,
  dispatchGoal as gstackDispatchGoal,
  listProxyGoals as gstackListGoals,
} from "./gstack-proxy.js";
import {
  checkAvailability as knowledgeCheckAvailability,
  knowledgeSearch,
  knowledgeGet,
  knowledgePut,
  knowledgeStats,
} from "./gbrain.js";
import type { KnowledgePageType } from "./gbrain.js";

/** Wrap a JSON value as the MCP text-content response shape. */
function jsonResult(
  value: unknown,
  isError = false,
): {
  content: Array<{ type: "text"; text: string }>;
  isError?: boolean;
} {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(value, null, 2) }],
    ...(isError ? { isError: true } : {}),
  };
}

/**
 * Root gateway logger — one cid per gateway process lifetime. Child loggers
 * per tool share the same cid so every tool call can be correlated to the
 * gateway that served it.
 */
const gatewayLogger: Logger = createLogger({
  component: "gateway",
  cid: generateCid(),
  level: "info",
  tty: false,
});

/**
 * Sanitize input for logging: truncate long string/array values, drop fields
 * that look like secrets. We don't want raw prompts or api keys in the sink.
 */
function sanitizeForLog(value: unknown, depth = 0): unknown {
  if (depth > 3) return "<depth-limit>";
  if (value === null || value === undefined) return value;
  if (typeof value === "string") {
    return value.length > 512 ? value.slice(0, 512) + `…(${value.length})` : value;
  }
  if (typeof value === "number" || typeof value === "boolean") return value;
  if (Array.isArray(value)) {
    return value.slice(0, 10).map((v) => sanitizeForLog(v, depth + 1));
  }
  if (typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (/secret|token|apikey|api_key|password/i.test(k)) {
        out[k] = "<redacted>";
        continue;
      }
      out[k] = sanitizeForLog(v, depth + 1);
    }
    return out;
  }
  return String(value);
}

/**
 * Wrap the McpServer so every registerTool handler is automatically
 * instrumented with start/end/duration/error logging. Keeps registration
 * sites untouched — tool bodies don't need to know about the logger.
 */
function instrumentServer(server: McpServer): McpServer {
  type RegisterToolFn = typeof server.registerTool;
  const originalRegisterTool = server.registerTool.bind(server) as RegisterToolFn;

  (server as unknown as { registerTool: RegisterToolFn }).registerTool = ((
    name: string,
    config: unknown,
    handler: (...args: unknown[]) => unknown,
  ) => {
    const log = gatewayLogger.child(`tool.${name}`);
    const wrapped = async (...args: unknown[]): Promise<unknown> => {
      const started = Date.now();
      const params = args[0];
      log.info("tool start", {
        params: sanitizeForLog(params) as Record<string, unknown>,
      });
      try {
        const result = await handler(...args);
        const durationMs = Date.now() - started;
        const isErr =
          typeof result === "object" &&
          result !== null &&
          (result as { isError?: boolean }).isError === true;
        if (isErr) {
          log.warn("tool error result", { durationMs });
        } else {
          log.info("tool ok", { durationMs });
        }
        return result;
      } catch (err) {
        const durationMs = Date.now() - started;
        log.error("tool crashed", err, { durationMs });
        return jsonResult(
          {
            success: false,
            error: err instanceof Error ? err.message : String(err),
          },
          true,
        );
      }
    };
    return (originalRegisterTool as unknown as (
      n: string,
      c: unknown,
      h: (...a: unknown[]) => unknown,
    ) => unknown)(name, config, wrapped);
  }) as RegisterToolFn;

  return server;
}

/** Build the unified MCP server with every namespace registered. */
export function buildServer(): McpServer {
  gatewayLogger.info("gateway init", { version: MCP_GATEWAY_VERSION });
  const server = instrumentServer(
    new McpServer({
      name: "vela-union-mcp-gateway",
      version: MCP_GATEWAY_VERSION,
    }),
  );

  registerDocTools(server);
  registerGraphTools(server);
  registerGstackTools(server);
  registerKnowledgeTools(server);
  registerVelaTools(server);

  gatewayLogger.info("gateway ready", {
    namespaces: ["doc", "graph", "gstack", "knowledge", "vela"],
  });
  return server;
}

// ---------------------------------------------------------------------------
// doc.* — PageIndex
// ---------------------------------------------------------------------------

function registerDocTools(server: McpServer): void {
  const pageIndex = createPageIndex();

  server.registerTool(
    "doc.index",
    {
      title: "Index a document with PageIndex",
      description:
        "Build a hierarchical PageIndex tree for a PDF or markdown document. " +
        "Markdown files are converted to PDF before submission to the Vectify " +
        "cloud. Returns a doc_id usable with doc.get_structure and doc.get_pages. " +
        "Re-indexing identical content is cached by md5. The provider is " +
        "configured in ~/.vela/config.json (default: vectify-cloud).",
      inputSchema: {
        path: z
          .string()
          .min(1)
          .describe("Absolute path to a .pdf, .md, or .markdown file"),
        projectName: z
          .string()
          .optional()
          .describe("Project name used for storage layout (default: _default)"),
      },
    },
    async ({ path, projectName }) => {
      const availability = pageIndex.checkAvailability();
      if (!availability.available) {
        return jsonResult(
          {
            success: false,
            error: `PageIndex not available: ${availability.reason}`,
            availability,
          },
          true,
        );
      }
      const result = await pageIndex.indexDocument(path, {
        ...(projectName ? { projectName } : {}),
      });
      return jsonResult(result, !result.success);
    },
  );

  server.registerTool(
    "doc.get_structure",
    {
      title: "Get the hierarchical tree of an indexed document",
      description:
        "Return the PageIndex tree (titles, node_ids, page ranges, summaries) " +
        "for an already-indexed document. Accepts either a doc_id or the " +
        "original file path used during doc.index. When projectName is given, " +
        "the lookup is constrained to that project.",
      inputSchema: {
        identifier: z
          .string()
          .min(1)
          .describe("doc_id OR the original path that was indexed"),
        projectName: z
          .string()
          .optional()
          .describe("Optional project hint for the lookup"),
      },
    },
    ({ identifier, projectName }) => {
      const result = pageIndex.getStructure(identifier, {
        ...(projectName ? { projectName } : {}),
      });
      return jsonResult(result, !result.success);
    },
  );

  server.registerTool(
    "doc.get_pages",
    {
      title: "Fetch content for specific pages or sections",
      description:
        "Return raw content for the requested pages or section node_ids. " +
        "`pages` accepts:\n" +
        "  - Page ranges for PDFs: '5-7', '3,8', '12'\n" +
        "  - Line numbers for markdown: '14,28-40'\n" +
        "  - Comma-separated node_ids: '0001,0003' (4-digit padded)",
      inputSchema: {
        identifier: z
          .string()
          .min(1)
          .describe("doc_id OR original file path"),
        pages: z
          .string()
          .min(1)
          .describe(
            "Pages spec (e.g. '5-7'), line spec, or node_id list (e.g. '0001,0003')",
          ),
        projectName: z
          .string()
          .optional()
          .describe("Optional project hint for the lookup"),
      },
    },
    ({ identifier, pages, projectName }) => {
      const result = pageIndex.getPageContent(identifier, pages, {
        ...(projectName ? { projectName } : {}),
      });
      return jsonResult(result, !result.success);
    },
  );
}

// ---------------------------------------------------------------------------
// graph.* — Graphify
// ---------------------------------------------------------------------------

function registerGraphTools(server: McpServer): void {
  server.registerTool(
    "graph.build",
    {
      title: "Build a knowledge graph for a project",
      description:
        "Run graphify to extract an AST-based knowledge graph for a project. " +
        "Stores the graph at ~/.vela/graphify/{projectName}/graph.json. " +
        "Slow on first run; cached afterwards by content hash.",
      inputSchema: {
        projectName: z
          .string()
          .min(1)
          .describe("Friendly project name (used as the storage key)"),
        projectPath: z
          .string()
          .min(1)
          .describe("Absolute path to the project root"),
      },
    },
    ({ projectName, projectPath }) => {
      try {
        const stats = buildGraph(projectName, projectPath);
        return jsonResult({ success: true, stats });
      } catch (err) {
        return jsonResult(
          { success: false, error: (err as Error).message },
          true,
        );
      }
    },
  );

  server.registerTool(
    "graph.query",
    {
      title: "Query a knowledge graph by keywords",
      description:
        "Substring/case-insensitive search over node labels and ids. " +
        "Returns up to 20 matches scored by exact > prefix > substring.",
      inputSchema: {
        projectName: z
          .string()
          .min(1)
          .describe("Project name (must already have a built graph)"),
        query: z.string().min(1).describe("Search keyword"),
      },
    },
    ({ projectName, query }) => {
      // Lazy-build branch: if the graph does not exist on disk, enqueue a
      // build and tell the caller to retry. NEVER block. NEVER fall back to
      // briefing pack. See plan-eng-review decision #3.
      if (!graphExists(projectName)) {
        const status = readBuildStatus(projectName, "graphify");
        if (status?.state === "building") {
          return jsonResult({
            status: "building",
            retryAfterSec: 120,
            message: `Graph for "${projectName}" is currently being built.`,
          });
        }
        if (!isBuildQueued(projectName, "graphify")) {
          const project = getProject(projectName);
          if (!project) {
            return jsonResult(
              {
                success: false,
                error: `Project "${projectName}" not in registry`,
              },
              true,
            );
          }
          enqueueBuild({
            kind: "graphify",
            projectName,
            projectPath: project.path,
          });
        }
        return jsonResult({
          status: "building",
          retryAfterSec: 120,
          message: `Graph for "${projectName}" was not built. Build queued. Retry in ~2 minutes.`,
        });
      }

      try {
        const results = queryGraph(projectName, query);
        return jsonResult({ success: true, count: results.length, results });
      } catch (err) {
        return jsonResult(
          { success: false, error: (err as Error).message },
          true,
        );
      }
    },
  );

  server.registerTool(
    "graph.get_neighbors",
    {
      title: "Get one-hop neighbors of a graph node",
      description:
        "Return the node and its incoming + outgoing neighbors. " +
        "Each neighbor is annotated with relation, confidence, and direction.",
      inputSchema: {
        projectName: z.string().min(1).describe("Project name"),
        nodeId: z.string().min(1).describe("Exact node id to look up"),
      },
    },
    ({ projectName, nodeId }) => {
      try {
        const neighborhood = getNeighbors(projectName, nodeId);
        return jsonResult({ success: true, ...neighborhood });
      } catch (err) {
        return jsonResult(
          { success: false, error: (err as Error).message },
          true,
        );
      }
    },
  );

  server.registerTool(
    "graph.get_node",
    {
      title: "Get a graph node by id",
      description: "Look up a node by its exact id and return its properties.",
      inputSchema: {
        projectName: z.string().min(1).describe("Project name"),
        nodeId: z.string().min(1).describe("Exact node id to look up"),
      },
    },
    ({ projectName, nodeId }) => {
      try {
        const node = getNode(projectName, nodeId);
        if (!node) {
          return jsonResult(
            { success: false, error: `Node not found: ${nodeId}` },
            true,
          );
        }
        return jsonResult({ success: true, node });
      } catch (err) {
        return jsonResult(
          { success: false, error: (err as Error).message },
          true,
        );
      }
    },
  );

  server.registerTool(
    "graph.stats",
    {
      title: "Get graph statistics",
      description:
        "Return node count, edge count, community count, and build time " +
        "for a project's graph. Reports exists=false if no graph is built.",
      inputSchema: {
        projectName: z.string().min(1).describe("Project name"),
      },
    },
    ({ projectName }) => {
      try {
        const stats = getStats(projectName);
        return jsonResult({ success: true, stats });
      } catch (err) {
        return jsonResult(
          { success: false, error: (err as Error).message },
          true,
        );
      }
    },
  );

  server.registerTool(
    "graph.refresh",
    {
      title: "Incrementally refresh a knowledge graph",
      description:
        "Re-run graphify with the SHA256 cache enabled — unchanged files are " +
        "skipped automatically. Falls back to a full build if no graph exists.",
      inputSchema: {
        projectName: z.string().min(1).describe("Project name"),
        projectPath: z.string().min(1).describe("Absolute path to the project root"),
      },
    },
    ({ projectName, projectPath }) => {
      try {
        const stats = refreshGraph(projectName, projectPath);
        return jsonResult({ success: true, stats });
      } catch (err) {
        return jsonResult(
          { success: false, error: (err as Error).message },
          true,
        );
      }
    },
  );

  server.registerTool(
    "graph_viz_sync",
    {
      title: "Sync graph visualizations to the plugin UI",
      description:
        "Reconcile graph.html files from ~/.vela/graphify/ into the plugin " +
        "dist/ui/graphs/ directory and rewrite manifest.json. Use after " +
        "manual builds or to fix missing projects in the graph-viz page.",
      inputSchema: {},
    },
    () => {
      try {
        const result = reconcileGraphViz();
        return jsonResult({ success: true, ...result });
      } catch (err) {
        return jsonResult(
          { success: false, error: (err as Error).message },
          true,
        );
      }
    },
  );
}

// ---------------------------------------------------------------------------
// gstack.* — gstack adapter (Claude CLI)
// ---------------------------------------------------------------------------

function registerGstackTools(server: McpServer): void {
  server.registerTool(
    "gstack.execute_skill",
    {
      title: "Execute a gstack skill in a project",
      description:
        "Run a gstack skill (qa, review, ship, investigate) inside a registered " +
        "project via Claude Code CLI. The project name is resolved through the " +
        "Vela project registry (~/.vela/projects.json).",
      inputSchema: {
        projectName: z.string().min(1).describe("Registered project name"),
        skill: z
          .string()
          .min(1)
          .describe("Skill name: qa | review | ship | investigate"),
        args: z
          .array(z.string())
          .optional()
          .describe("Optional positional args appended to the skill prompt"),
      },
    },
    async ({ projectName, skill, args }) => {
      const result = await gstackExecuteSkill(projectName, skill, args ?? []);
      return jsonResult(result, !result.success);
    },
  );

  server.registerTool(
    "gstack.dispatch_goal",
    {
      title: "Dispatch a goal to a project",
      description:
        "Generate a briefing pack for the project, persist a goal in " +
        "~/.vela/goals.json, then run it via Claude Code CLI. Returns the " +
        "stored goal plus the execution result.",
      inputSchema: {
        projectName: z.string().min(1).describe("Registered project name"),
        goal: z.string().min(1).describe("Natural-language goal description"),
      },
    },
    async ({ projectName, goal }) => {
      const result = await gstackDispatchGoal(projectName, goal);
      return jsonResult(result, !result.success);
    },
  );

  server.registerTool(
    "gstack.list_goals",
    {
      title: "List tracked goals",
      description:
        "Return goals stored at ~/.vela/goals.json, optionally filtered by project.",
      inputSchema: {
        projectName: z
          .string()
          .optional()
          .describe("Optional project filter"),
      },
    },
    ({ projectName }) => {
      const result = gstackListGoals(projectName);
      return jsonResult(result, !result.success);
    },
  );

  server.registerTool(
    "gstack.check_availability",
    {
      title: "Check if Claude CLI is available",
      description:
        "Probe the Claude Code CLI on PATH and known install locations. " +
        "Returns the resolved path and version if found.",
      inputSchema: {},
    },
    () => {
      const result = gstackCheckAvailability();
      return jsonResult(result, !result.success);
    },
  );
}

// ---------------------------------------------------------------------------
// knowledge.* — gbrain long-term memory (entity/decision store)
// ---------------------------------------------------------------------------

function registerKnowledgeTools(server: McpServer): void {
  server.registerTool(
    "knowledge.search",
    {
      title: "Search the knowledge brain",
      description:
        "Full-text keyword search over the gbrain entity store. " +
        "Returns pages ranked by relevance. Covers entity types: " +
        "person, company, decision, idea, meeting, project, concept, source, media. " +
        "Brain must be initialised with 'gbrain init' first " +
        "(default path: ~/.vela/gbrain/brain.pglite).",
      inputSchema: {
        query: z.string().min(1).describe("Search query (supports websearch syntax)"),
        limit: z
          .number()
          .int()
          .min(1)
          .max(100)
          .optional()
          .describe("Maximum results to return (default: 20)"),
      },
    },
    async ({ query, limit }) => {
      const availability = knowledgeCheckAvailability();
      if (!availability.available) {
        return jsonResult(
          { success: false, error: availability.reason, brain_path: availability.brain_path },
          true,
        );
      }
      const result = await knowledgeSearch(query, limit ?? 20);
      return jsonResult(result, !result.success);
    },
  );

  server.registerTool(
    "knowledge.get",
    {
      title: "Get a knowledge brain page by slug",
      description:
        "Retrieve a single entity page from the gbrain store by its slug. " +
        "Returns the full compiled_truth, timeline, and frontmatter.",
      inputSchema: {
        slug: z.string().min(1).describe("Page slug (e.g. 'person/jane-doe', 'decision/auth-rewrite')"),
      },
    },
    async ({ slug }) => {
      const availability = knowledgeCheckAvailability();
      if (!availability.available) {
        return jsonResult(
          { success: false, error: availability.reason, brain_path: availability.brain_path },
          true,
        );
      }
      const result = await knowledgeGet(slug);
      return jsonResult(result, !result.success);
    },
  );

  server.registerTool(
    "knowledge.put",
    {
      title: "Write or update a knowledge brain page",
      description:
        "Upsert an entity page in the gbrain store. " +
        "If the slug already exists, the page is updated; otherwise it is created. " +
        "Only entity-level pages are permitted — code belongs in Graphify, " +
        "single-doc content belongs in PageIndex.",
      inputSchema: {
        slug: z
          .string()
          .min(1)
          .describe("Page slug — use 'type/kebab-name' convention (e.g. 'decision/switch-to-pglite')"),
        type: z
          .enum([
            "person",
            "company",
            "decision",
            "idea",
            "meeting",
            "project",
            "concept",
            "source",
            "media",
          ])
          .describe("Entity type"),
        title: z.string().min(1).describe("Human-readable page title"),
        compiled_truth: z
          .string()
          .min(1)
          .describe("Main page content (markdown, compiled knowledge)"),
        timeline: z
          .string()
          .optional()
          .describe("Optional chronological timeline entries (markdown)"),
        frontmatter: z
          .record(z.string(), z.unknown())
          .optional()
          .describe("Optional key-value metadata (stored as JSONB)"),
      },
    },
    async ({ slug, type, title, compiled_truth, timeline, frontmatter }) => {
      const availability = knowledgeCheckAvailability();
      if (!availability.available) {
        return jsonResult(
          { success: false, error: availability.reason, brain_path: availability.brain_path },
          true,
        );
      }
      const result = await knowledgePut(slug, {
        type: type as KnowledgePageType,
        title,
        compiled_truth,
        timeline,
        frontmatter: frontmatter as Record<string, unknown> | undefined,
      });
      return jsonResult(result, !result.success);
    },
  );

  server.registerTool(
    "knowledge.stats",
    {
      title: "Brain statistics",
      description:
        "Return page count, chunk count, embedding coverage, link count, " +
        "tag count, and per-type breakdown for the gbrain store.",
      inputSchema: {},
    },
    async () => {
      const availability = knowledgeCheckAvailability();
      if (!availability.available) {
        return jsonResult(
          { success: false, error: availability.reason, brain_path: availability.brain_path },
          true,
        );
      }
      const result = await knowledgeStats();
      return jsonResult(result, !result.success);
    },
  );
}

// ---------------------------------------------------------------------------
// vela.* — meta tools
// ---------------------------------------------------------------------------

function registerVelaTools(server: McpServer): void {
  server.registerTool(
    "vela.list_projects",
    {
      title: "List all registered Vela projects",
      description:
        "Return the contents of ~/.vela/projects.json — every project the " +
        "Vela Union gateway can dispatch goals or build graphs against.",
      inputSchema: {},
    },
    () => {
      const projects = listProjects();
      return jsonResult({ success: true, count: projects.length, projects });
    },
  );
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

/** Entry point: run as a stdio MCP server */
async function main(): Promise<void> {
  const server = buildServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
  gatewayLogger.info("gateway connected", { transport: "stdio" });
  // Log to stderr so it doesn't pollute the JSON-RPC stream on stdout
  process.stderr.write(
    `[vela-mcp-gateway] doc.* graph.* gstack.* knowledge.* vela.* tools ready (v${MCP_GATEWAY_VERSION})\n`,
  );
  const shutdown = (signal: NodeJS.Signals): void => {
    gatewayLogger.info("gateway shutdown", { signal });
  };
  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);
}

// Run main when invoked as a script (not when imported as a library)
const isDirectRun =
  import.meta.url === `file://${process.argv[1]}` ||
  process.argv[1]?.endsWith("server.js") === true;

if (isDirectRun) {
  main().catch((err: unknown) => {
    process.stderr.write(
      `[vela-mcp-gateway] Fatal: ${(err as Error).message ?? String(err)}\n`,
    );
    process.exit(1);
  });
}
