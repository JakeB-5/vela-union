// Startup scanner — run on plugin setup() and from the CLI to sweep the
// project registry and enqueue graphify builds for any project whose graph
// is missing (or whose last status is not "built").
//
// Design (locked in plan-eng-review):
//   - Skip projects whose path does not exist on disk (log warning)
//   - Skip if graph already exists AND status is "built"
//   - Skip if already queued (no duplicate entries)
//   - Otherwise enqueue for graphify build
//
// Circular-dependency note: this file lives in packages/paperclip-plugin but
// needs to talk to packages/mcp-gateway's build-queue, which itself depends
// (transitively, via gstack-proxy) on paperclip-plugin's dist. To avoid a
// project-reference cycle at typecheck time we:
//   1) define ScanResult locally (no types imported from mcp-gateway)
//   2) load the build-queue module via dynamic `await import(...)` at call
//      time. The deep-dist path mirrors the pattern used by gstack-proxy.ts.

import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import { createLogger, generateCid, listProjects } from "@vela-union/shared";
import type { Logger } from "@vela-union/shared";

const scannerLogger: Logger = createLogger({
  component: "plugin.startup-scanner",
  cid: generateCid(),
  level: "info",
  tty: false,
});

export interface ScanResult {
  totalProjects: number;
  missingGraphs: number;
  enqueued: number;
  skippedAlreadyQueued: number;
  skippedPathMissing: number;
  errors: string[];
}

interface BuildStatusLike {
  projectName: string;
  kind: string;
  state: "missing" | "building" | "built" | "failed";
  lastAttemptAt: string | null;
  lastError: string | null;
  durationMs: number | null;
}

interface BuildQueueModule {
  enqueue: (entry: {
    kind: "graphify";
    projectName: string;
    projectPath: string;
  }) => unknown;
  isQueued: (projectName: string, kind: "graphify") => boolean;
  readStatus: (projectName: string, kind: "graphify") => BuildStatusLike | null;
}

const GRAPHIFY_DIR = join(homedir(), ".vela", "graphify");
// Deep import avoids the paperclip-plugin <-> mcp-gateway typecheck cycle.
// Matches the pattern used by mcp-gateway/src/gstack-proxy.ts which imports
// from "@vela-union/paperclip-plugin/dist/briefing.js".
const BUILD_QUEUE_MODULE = "@vela-union/mcp-gateway/dist/build-queue.js";

function graphJsonExists(projectName: string): boolean {
  return existsSync(join(GRAPHIFY_DIR, projectName, "graph.json"));
}

async function loadBuildQueue(): Promise<BuildQueueModule> {
  // Use a variable to prevent TypeScript from resolving the import path at
  // compile time — we resolve it at runtime via the workspace symlink.
  const specifier = BUILD_QUEUE_MODULE;
  const mod = (await import(specifier)) as BuildQueueModule;
  return mod;
}

/**
 * Sweep the project registry and enqueue a graphify build for each project
 * whose graph is missing. Safe to run repeatedly — duplicates are suppressed
 * by `isQueued` + `enqueue`'s dedup guard.
 *
 * Async because the build-queue module is loaded dynamically to break the
 * paperclip-plugin <-> mcp-gateway typecheck cycle.
 */
export async function scanAndQueue(): Promise<ScanResult> {
  scannerLogger.info("scan start");
  const result: ScanResult = {
    totalProjects: 0,
    missingGraphs: 0,
    enqueued: 0,
    skippedAlreadyQueued: 0,
    skippedPathMissing: 0,
    errors: [],
  };

  let projects;
  try {
    projects = listProjects();
  } catch (err) {
    scannerLogger.error("scan registry read failed", err);
    result.errors.push(`failed to read project registry: ${(err as Error).message}`);
    return result;
  }

  result.totalProjects = projects.length;
  if (projects.length === 0) {
    scannerLogger.info("scan complete, no projects");
    return result;
  }

  let queue: BuildQueueModule;
  try {
    queue = await loadBuildQueue();
  } catch (err) {
    scannerLogger.error("scan build-queue load failed", err);
    result.errors.push(
      `failed to load build-queue module: ${(err as Error).message}`,
    );
    return result;
  }

  for (const project of projects) {
    try {
      if (!existsSync(project.path)) {
        scannerLogger.warn("project path missing", {
          project: project.name,
          path: project.path,
        });
        result.skippedPathMissing += 1;
        result.errors.push(
          `project path missing: ${project.name} @ ${project.path}`,
        );
        continue;
      }

      const status = queue.readStatus(project.name, "graphify");
      const hasGraph = graphJsonExists(project.name);
      if (hasGraph && status?.state === "built") {
        scannerLogger.debug("project already built", { project: project.name });
        continue;
      }

      result.missingGraphs += 1;

      if (queue.isQueued(project.name, "graphify")) {
        scannerLogger.debug("project already queued", { project: project.name });
        result.skippedAlreadyQueued += 1;
        continue;
      }

      queue.enqueue({
        kind: "graphify",
        projectName: project.name,
        projectPath: project.path,
      });
      scannerLogger.info("project enqueued", { project: project.name });
      result.enqueued += 1;
    } catch (err) {
      scannerLogger.error("scan iteration error", err, { project: project.name });
      result.errors.push(
        `scan error for ${project.name}: ${(err as Error).message}`,
      );
    }
  }

  scannerLogger.info("scan complete", { ...result });
  return result;
}

// ---------------------------------------------------------------------------
// Graph-viz reconciliation (VELA-56)
// ---------------------------------------------------------------------------

export interface ReconcileResult {
  copied: string[];
  removed: string[];
  manifestEntries: string[];
}

const GRAPHIFY_MODULE = "@vela-union/mcp-gateway/dist/graphify.js";

/**
 * Delegate to mcp-gateway's reconcileGraphViz() which walks ~/.vela/graphify/,
 * copies graph.html files into the plugin dist, and rewrites manifest.json.
 */
export async function reconcileGraphViz(): Promise<ReconcileResult> {
  try {
    const specifier = GRAPHIFY_MODULE;
    const mod = (await import(specifier)) as {
      reconcileGraphViz: () => ReconcileResult;
    };
    const result = mod.reconcileGraphViz();
    scannerLogger.info("reconcile complete", result as unknown as Record<string, unknown>);
    return result;
  } catch (err) {
    scannerLogger.error("reconcile failed", err);
    return { copied: [], removed: [], manifestEntries: [] };
  }
}
