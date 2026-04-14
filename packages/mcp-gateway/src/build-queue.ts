// Build queue + worker for Vela Union background graph builds.
//
// File layout:
//   ~/.vela/build-queue.jsonl              append-only JSONL queue
//   ~/.vela/graphify/{projectName}/status.json   per-project per-kind status
//   ~/.vela/logs/graph-build.log            central append-only log
//
// Design constraints (locked in the plan-eng-review):
//   - Concurrency = 1. Serial worker. "Boring by default."
//   - No external deps. crypto.randomUUID + fs only.
//   - Atomic enqueue via O_APPEND (append mode, small records).
//   - Atomic dequeue via rewrite-to-temp + rename.
//   - 10-minute per-build timeout — kill the child and mark failed.
//   - On worker stop: finish current build, or kill after 10s grace.

import { spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { createLogger, generateCid, resolvePageIndexConfig } from "@vela-union/shared";
import type { Logger } from "@vela-union/shared";

import { getGraphPath } from "./graphify.js";
import {
  PAGEINDEX_HELPERS,
  PAGEINDEX_PATHS,
  submitPdfToCloud,
  submitViaLocalClaudeCli,
  convertMarkdownToPdf,
  type CloudIndexEntry,
} from "./pageindex.js";

// Root logger for the build-queue subsystem. Child loggers per build carry
// a per-entry cid so graph builds can be traced end-to-end in the sink.
const queueLogger: Logger = createLogger({
  component: "worker.build-queue",
  cid: generateCid(),
  level: "info",
  tty: false,
});

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type BuildKind = "graphify" | "pageindex";

export interface GraphifyQueueEntry {
  id: string;
  kind: "graphify";
  projectName: string;
  projectPath: string;
  enqueuedAt: string;
  attempts: number;
}

export interface PageIndexQueueEntry {
  id: string;
  kind: "pageindex";
  projectName: string;
  /**
   * Original path of the user-facing file (PDF or MD). Stored so the index
   * key is stable across markdown conversions.
   */
  originalPath: string;
  /**
   * The path that will actually be uploaded. For PDFs this is the same as
   * originalPath. For markdown sources it's the cached converted PDF path
   * (may be populated lazily by the worker).
   */
  docPath: string;
  projectPath?: string;
  enqueuedAt: string;
  attempts: number;
}

export type QueueEntry = GraphifyQueueEntry | PageIndexQueueEntry;

export interface BuildStatus {
  projectName: string;
  kind: BuildKind;
  state: "missing" | "building" | "built" | "failed";
  lastAttemptAt: string | null;
  lastError: string | null;
  durationMs: number | null;
  /** Optional: count of items processed (pageindex docs) */
  itemCount?: number;
}

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------

const VELA_HOME = join(homedir(), ".vela");
const QUEUE_PATH = join(VELA_HOME, "build-queue.jsonl");
const QUEUE_TMP_PATH = join(VELA_HOME, "build-queue.jsonl.tmp");
const GRAPHIFY_DIR = join(VELA_HOME, "graphify");
const PAGEINDEX_DIR = join(VELA_HOME, "pageindex");
const LOGS_DIR = join(VELA_HOME, "logs");
const CENTRAL_LOG_PATH = join(LOGS_DIR, "graph-build.log");
const PAGEINDEX_LOG_PATH = join(LOGS_DIR, "pageindex-build.log");

// Resolve the graphify build helper the same way graphify.ts does so the
// worker can spawn the Python process directly with a per-build timeout.
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const REPO_ROOT = resolve(__dirname, "..", "..", "..");
const VENV_PYTHON = join(REPO_ROOT, ".venv", "bin", "python");
const BUILD_SCRIPT = join(REPO_ROOT, "scripts", "graphify_build.py");
const PLUGIN_GRAPHS_DIR = join(REPO_ROOT, "packages", "paperclip-plugin", "dist", "ui", "graphs");

// ---------------------------------------------------------------------------
// Filesystem helpers
// ---------------------------------------------------------------------------

function ensureDir(path: string): void {
  if (!existsSync(path)) {
    mkdirSync(path, { recursive: true });
  }
}

function ensureQueueInfra(): void {
  ensureDir(VELA_HOME);
  ensureDir(GRAPHIFY_DIR);
  ensureDir(PAGEINDEX_DIR);
  ensureDir(LOGS_DIR);
  if (!existsSync(QUEUE_PATH)) {
    writeFileSync(QUEUE_PATH, "", "utf-8");
  }
}

function statusPath(projectName: string, kind: BuildKind = "graphify"): string {
  if (kind === "pageindex") {
    // Pageindex uses an aggregate status.json file at the project root.
    return join(PAGEINDEX_DIR, projectName, "status.json");
  }
  return join(GRAPHIFY_DIR, projectName, "status.json");
}

function ensureProjectDir(projectName: string, kind: BuildKind = "graphify"): void {
  if (kind === "pageindex") {
    ensureDir(join(PAGEINDEX_DIR, projectName));
  } else {
    ensureDir(join(GRAPHIFY_DIR, projectName));
  }
}

function writeStatus(status: BuildStatus): void {
  ensureProjectDir(status.projectName, status.kind);
  if (status.kind === "pageindex") {
    // Pageindex keeps its own richer per-doc status file. This thin summary
    // lives alongside it at ~/.vela/pageindex/{project}/build-status.json so
    // the gateway tools can report overall state without parsing individual
    // doc entries.
    const path = join(PAGEINDEX_DIR, status.projectName, "build-status.json");
    writeFileSync(path, JSON.stringify(status, null, 2) + "\n", "utf-8");
    return;
  }
  const path = statusPath(status.projectName, status.kind);
  writeFileSync(path, JSON.stringify(status, null, 2) + "\n", "utf-8");
}

function appendCentralLog(
  projectName: string,
  kind: BuildKind,
  state: BuildStatus["state"],
  durationMs: number | null,
  error: string | null,
): void {
  ensureDir(LOGS_DIR);
  const parts = [
    `[${new Date().toISOString()}]`,
    `project=${projectName}`,
    `kind=${kind}`,
    `state=${state}`,
    `durationMs=${durationMs ?? 0}`,
  ];
  if (error) {
    // Collapse newlines so each log entry stays on one line.
    parts.push(`error=${error.replace(/\n/g, " \\n ").slice(0, 1000)}`);
  }
  const line = parts.join(" ") + "\n";
  const logPath = kind === "pageindex" ? PAGEINDEX_LOG_PATH : CENTRAL_LOG_PATH;
  appendFileSync(logPath, line, "utf-8");
}

// ---------------------------------------------------------------------------
// Queue I/O
// ---------------------------------------------------------------------------

/** Read every queued entry. Skips malformed lines. */
export function readQueue(): QueueEntry[] {
  ensureQueueInfra();
  if (!existsSync(QUEUE_PATH)) return [];
  const raw = readFileSync(QUEUE_PATH, "utf-8");
  if (!raw.trim()) return [];
  const entries: QueueEntry[] = [];
  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const parsed = JSON.parse(trimmed) as QueueEntry;
      if (
        typeof parsed.id !== "string" ||
        typeof parsed.kind !== "string" ||
        typeof parsed.projectName !== "string"
      ) {
        continue;
      }
      if (parsed.kind === "graphify") {
        if (typeof (parsed as GraphifyQueueEntry).projectPath === "string") {
          entries.push(parsed);
        }
      } else if (parsed.kind === "pageindex") {
        const p = parsed as PageIndexQueueEntry;
        if (typeof p.originalPath === "string" && typeof p.docPath === "string") {
          entries.push(parsed);
        }
      }
    } catch {
      // Ignore bad lines — they will be rewritten out on next dequeue.
    }
  }
  return entries;
}

/**
 * Whether a project+kind is already queued (pending a build).
 *
 * For pageindex entries, an additional `originalPath` filter can be supplied
 * since multiple pageindex entries per project are allowed (one per doc).
 */
export function isQueued(
  projectName: string,
  kind: BuildKind,
  originalPath?: string,
): boolean {
  return readQueue().some((e) => {
    if (e.projectName !== projectName || e.kind !== kind) return false;
    if (kind === "pageindex" && originalPath) {
      return (e as PageIndexQueueEntry).originalPath === originalPath;
    }
    return true;
  });
}

export type EnqueueInput =
  | Omit<GraphifyQueueEntry, "id" | "enqueuedAt" | "attempts">
  | Omit<PageIndexQueueEntry, "id" | "enqueuedAt" | "attempts">;

/**
 * Append a new entry to the queue. Uses O_APPEND so concurrent appenders on
 * POSIX land on whole-line boundaries for records under PIPE_BUF (~4KB).
 * Returns the full entry (with id/enqueuedAt/attempts filled in).
 *
 * Deduplication:
 *   - graphify:  (project, kind) is unique — duplicates return the existing entry
 *   - pageindex: (project, kind, originalPath) is unique
 */
export function enqueue(entry: EnqueueInput): QueueEntry {
  ensureQueueInfra();
  const existing = readQueue().find((e) => {
    if (e.projectName !== entry.projectName || e.kind !== entry.kind) return false;
    if (entry.kind === "pageindex") {
      return (e as PageIndexQueueEntry).originalPath === entry.originalPath;
    }
    return true;
  });
  if (existing) {
    queueLogger.debug("enqueue deduped", {
      projectName: entry.projectName,
      kind: entry.kind,
      existingId: existing.id,
    });
    return existing;
  }

  let full: QueueEntry;
  if (entry.kind === "graphify") {
    full = {
      id: randomId(),
      kind: "graphify",
      projectName: entry.projectName,
      projectPath: entry.projectPath,
      enqueuedAt: new Date().toISOString(),
      attempts: 0,
    };
  } else {
    full = {
      id: randomId(),
      kind: "pageindex",
      projectName: entry.projectName,
      originalPath: entry.originalPath,
      docPath: entry.docPath,
      ...(entry.projectPath ? { projectPath: entry.projectPath } : {}),
      enqueuedAt: new Date().toISOString(),
      attempts: 0,
    };
  }

  appendFileSync(QUEUE_PATH, JSON.stringify(full) + "\n", {
    encoding: "utf-8",
    flag: "a",
  });
  queueLogger.info("enqueue", {
    id: full.id,
    projectName: full.projectName,
    kind: full.kind,
  });
  return full;
}

/**
 * Remove a single entry from the queue by id via atomic rewrite.
 * Reads the full queue, filters out the target, writes to a temp file,
 * then renames. Rename is atomic on POSIX same-filesystem.
 */
function removeEntry(entryId: string): void {
  ensureQueueInfra();
  const remaining = readQueue().filter((e) => e.id !== entryId);
  const body = remaining.map((e) => JSON.stringify(e)).join("\n");
  writeFileSync(QUEUE_TMP_PATH, remaining.length > 0 ? body + "\n" : "", "utf-8");
  renameSync(QUEUE_TMP_PATH, QUEUE_PATH);
}

/** Read the current status for a project+kind, or null if never recorded. */
export function readStatus(
  projectName: string,
  kind: BuildKind,
): BuildStatus | null {
  const path =
    kind === "pageindex"
      ? join(PAGEINDEX_DIR, projectName, "build-status.json")
      : statusPath(projectName, kind);
  if (!existsSync(path)) return null;
  try {
    const raw = readFileSync(path, "utf-8");
    const parsed = JSON.parse(raw) as BuildStatus;
    if (parsed.kind !== kind) return null;
    return parsed;
  } catch {
    return null;
  }
}

/**
 * Read every project's status across both graphify and pageindex kinds.
 * Returns only projects that have a status file recorded.
 */
export function readAllStatuses(): BuildStatus[] {
  const statuses: BuildStatus[] = [];
  if (existsSync(GRAPHIFY_DIR)) {
    try {
      for (const name of readdirSync(GRAPHIFY_DIR)) {
        const status = readStatus(name, "graphify");
        if (status) statuses.push(status);
      }
    } catch {
      // ignore — directory may not exist
    }
  }
  if (existsSync(PAGEINDEX_DIR)) {
    try {
      for (const name of readdirSync(PAGEINDEX_DIR)) {
        const status = readStatus(name, "pageindex");
        if (status) statuses.push(status);
      }
    } catch {
      // ignore
    }
  }
  return statuses;
}

// ---------------------------------------------------------------------------
// Worker
// ---------------------------------------------------------------------------

export interface WorkerHandle {
  stop: () => Promise<void>;
}

interface WorkerOptions {
  intervalMs?: number;
  timeoutMs?: number;
}

const DEFAULT_POLL_INTERVAL_MS = 2000;
const DEFAULT_BUILD_TIMEOUT_MS = 10 * 60 * 1000;
const STOP_GRACE_MS = 10_000;

/**
 * Start the background build worker. Returns a handle whose `stop()` method
 * signals the worker to shut down after the current build completes (or
 * kills it after STOP_GRACE_MS if it's still running).
 */
export function startWorker(opts: WorkerOptions = {}): WorkerHandle {
  const intervalMs = opts.intervalMs ?? DEFAULT_POLL_INTERVAL_MS;
  const timeoutMs = opts.timeoutMs ?? DEFAULT_BUILD_TIMEOUT_MS;

  ensureQueueInfra();
  queueLogger.info("worker start", { intervalMs, timeoutMs });

  let stopping = false;
  let currentChild: ChildProcess | null = null;
  let currentEntryId: string | null = null;
  let timer: NodeJS.Timeout | null = null;
  let running = false;
  let currentTick: Promise<void> | null = null;

  const tick = async (): Promise<void> => {
    if (stopping || running) return;
    running = true;
    try {
      const queue = readQueue();
      if (queue.length === 0) return;
      const entry = queue[0];
      if (!entry) return;
      await processEntry(entry, timeoutMs, (child) => {
        currentChild = child;
        currentEntryId = entry.id;
      });
      currentChild = null;
      currentEntryId = null;
    } catch (err) {
      // Never let a single tick crash the worker loop.
      try {
        appendCentralLog(
          "worker",
          "graphify",
          "failed",
          null,
          `worker tick error: ${(err as Error).message}`,
        );
      } catch {
        // ignore
      }
    } finally {
      running = false;
    }
  };

  timer = setInterval(() => {
    if (currentTick) return; // tick already in flight; skip
    currentTick = tick().finally(() => { currentTick = null; });
  }, intervalMs);
  // Allow Node to exit even if the worker timer is still registered.
  if (typeof timer.unref === "function") timer.unref();

  const stop = async (): Promise<void> => {
    if (stopping) return;
    stopping = true;
    queueLogger.info("worker stop requested");
    if (timer) {
      clearInterval(timer);
      timer = null;
    }
    // Await any in-flight tick so we don't race with promise-discarded work.
    if (currentTick) {
      try { await currentTick; } catch { /* tick swallows its own errors */ }
    }
    // If a build is running, give it STOP_GRACE_MS to finish, then kill.
    if (currentChild && currentChild.exitCode === null) {
      const child = currentChild;
      const entryId = currentEntryId;
      await new Promise<void>((resolveP) => {
        const killTimer = setTimeout(() => {
          try {
            child.kill("SIGKILL");
          } catch {
            // ignore
          }
          if (entryId) {
            try {
              removeEntry(entryId);
            } catch {
              // ignore
            }
          }
          resolveP();
        }, STOP_GRACE_MS);
        child.on("exit", () => {
          clearTimeout(killTimer);
          resolveP();
        });
      });
    }
  };

  return { stop };
}

// ---------------------------------------------------------------------------
// Entry processing
// ---------------------------------------------------------------------------

async function processEntry(
  entry: QueueEntry,
  timeoutMs: number,
  onChild: (child: ChildProcess) => void,
): Promise<void> {
  // Per-build logger with its own cid so every event for this build is
  // trivially groupable in the sink.
  const buildLog = queueLogger.child(`${entry.kind}.${entry.projectName}`, generateCid());
  const startedAt = Date.now();
  buildLog.info("build dequeue", {
    id: entry.id,
    projectName: entry.projectName,
    kind: entry.kind,
    ...(entry.kind === "graphify"
      ? { projectPath: entry.projectPath }
      : { originalPath: entry.originalPath }),
  });
  // Mark building
  writeStatus({
    projectName: entry.projectName,
    kind: entry.kind,
    state: "building",
    lastAttemptAt: new Date().toISOString(),
    lastError: null,
    durationMs: null,
  });
  appendCentralLog(entry.projectName, entry.kind, "building", null, null);
  buildLog.info("build start", { projectName: entry.projectName });

  if (entry.kind === "graphify") {
    try {
      await runGraphifyBuild(entry, timeoutMs, onChild);
      const durationMs = Date.now() - startedAt;
      writeStatus({
        projectName: entry.projectName,
        kind: "graphify",
        state: "built",
        lastAttemptAt: new Date().toISOString(),
        lastError: null,
        durationMs,
      });
      appendCentralLog(entry.projectName, "graphify", "built", durationMs, null);
      buildLog.info("build ok", {
        projectName: entry.projectName,
        durationMs,
      });
      removeEntry(entry.id);
      return;
    } catch (err) {
      const durationMs = Date.now() - startedAt;
      const message = (err as Error).message ?? String(err);
      writeStatus({
        projectName: entry.projectName,
        kind: "graphify",
        state: "failed",
        lastAttemptAt: new Date().toISOString(),
        lastError: message,
        durationMs,
      });
      appendCentralLog(entry.projectName, "graphify", "failed", durationMs, message);
      buildLog.error("build failed", err, {
        projectName: entry.projectName,
        durationMs,
      });
      // On failure we still remove the entry — retries are not automatic.
      removeEntry(entry.id);
      return;
    }
  }

  if (entry.kind === "pageindex") {
    // Cloud PageIndex path — uses scripts/pageindex_cloud.py via submitPdfToCloud.
    try {
      const built = await processPageIndexEntry(entry, timeoutMs, buildLog);
      const durationMs = Date.now() - startedAt;
      writeStatus({
        projectName: entry.projectName,
        kind: "pageindex",
        state: "built",
        lastAttemptAt: new Date().toISOString(),
        lastError: null,
        durationMs,
        itemCount: 1,
      });
      appendCentralLog(entry.projectName, "pageindex", "built", durationMs, null);
      buildLog.info("pageindex ok", {
        projectName: entry.projectName,
        durationMs,
        docId: built.docId,
      });
      removeEntry(entry.id);
      return;
    } catch (err) {
      const durationMs = Date.now() - startedAt;
      const message = (err as Error).message ?? String(err);
      writeStatus({
        projectName: entry.projectName,
        kind: "pageindex",
        state: "failed",
        lastAttemptAt: new Date().toISOString(),
        lastError: message,
        durationMs,
      });
      appendCentralLog(entry.projectName, "pageindex", "failed", durationMs, message);
      buildLog.error("pageindex failed", err, {
        projectName: entry.projectName,
        originalPath: entry.originalPath,
        durationMs,
      });
      removeEntry(entry.id);
      return;
    }
  }

  // Exhaustive: graphify/pageindex handled above. Any other kind means the
  // queue file has been corrupted with entries from a newer version — drop
  // the entry defensively instead of hanging the worker.
  const stray = entry as { id?: string; kind?: string };
  buildLog.warn("unknown kind, dropping", { kind: stray.kind ?? "unknown" });
  if (typeof stray.id === "string") removeEntry(stray.id);
}

/**
 * Process a pageindex entry: read config, dispatch to the configured
 * backend (vectify-cloud OR local-claude-cli), persist the resulting tree
 * under ~/.vela/pageindex/<project>/.
 *
 * Backend selection is driven by ~/.vela/config.json { pageindex.provider }:
 *   - "vectify-cloud"     → md->pdf + Vectify cloud API (needs apiKey)
 *   - "local-claude-cli"  → OSS PageIndex via `claude -p` (zero cost)
 *
 * The "local" provider (OSS + OpenAI/Anthropic key) is NOT handled by the
 * worker; it's only available through the synchronous createPageIndex()
 * adapter. The worker is cloud-first.
 */
async function processPageIndexEntry(
  entry: PageIndexQueueEntry,
  timeoutMs: number,
  log: Logger,
): Promise<{ docId: string; treePath: string }> {
  const connection = resolvePageIndexConfig();
  const backend = connection.provider ?? "vectify-cloud";
  if (backend !== "vectify-cloud" && backend !== "local-claude-cli") {
    throw new Error(
      `pageindex worker supports vectify-cloud or local-claude-cli (got ${backend})`,
    );
  }
  if (backend === "vectify-cloud" && !connection.apiKey) {
    throw new Error("pageindex.apiKey missing in ~/.vela/config.json");
  }

  const storagePath = PAGEINDEX_PATHS.STORAGE;
  const pythonPath = PAGEINDEX_PATHS.DEFAULT_PYTHON;
  PAGEINDEX_HELPERS.ensureDir(PAGEINDEX_HELPERS.projectRoot(storagePath, entry.projectName));
  PAGEINDEX_HELPERS.ensureDir(
    PAGEINDEX_HELPERS.projectTreesDir(storagePath, entry.projectName),
  );
  PAGEINDEX_HELPERS.ensureDir(
    PAGEINDEX_HELPERS.projectConvertedDir(storagePath, entry.projectName),
  );

  // Idempotency check — skip if the same md5 is already indexed.
  if (!existsSync(entry.originalPath)) {
    throw new Error(`source file missing: ${entry.originalPath}`);
  }
  const md5 = PAGEINDEX_HELPERS.sha256File(entry.originalPath);
  const indexMap: Record<string, CloudIndexEntry> = PAGEINDEX_HELPERS.readCloudIndex(
    storagePath,
    entry.projectName,
  );
  const cached = indexMap[entry.originalPath];
  if (cached && cached.md5 === md5 && existsSync(cached.treePath)) {
    log.info("pageindex cache hit", {
      path: entry.originalPath,
      docId: cached.docId,
      backend,
    });
    PAGEINDEX_HELPERS.updateCloudStatusEntry(
      storagePath,
      entry.projectName,
      entry.originalPath,
      { state: "indexed", docId: cached.docId, error: null },
    );
    return { docId: cached.docId, treePath: cached.treePath };
  }

  const fileType = PAGEINDEX_HELPERS.detectFileType(entry.originalPath);
  if (!fileType) {
    throw new Error(`unsupported file type: ${entry.originalPath}`);
  }
  PAGEINDEX_HELPERS.updateCloudStatusEntry(
    storagePath,
    entry.projectName,
    entry.originalPath,
    {
      state: "indexing",
      lastAttemptAt: new Date().toISOString(),
      error: null,
    },
  );

  if (backend === "local-claude-cli") {
    // OSS PageIndex via `claude -p`. Native .md + .pdf — no conversion.
    const docName = entry.originalPath.split("/").pop() ?? "document";
    const safe = PAGEINDEX_HELPERS.safeName(docName);
    const docId = `local-${md5.slice(0, 12)}`;
    const treePath = join(
      PAGEINDEX_HELPERS.projectTreesDir(storagePath, entry.projectName),
      `${safe}-${docId.slice(-12)}.json`,
    );
    log.info("pageindex local submit", {
      path: entry.originalPath,
      fileType,
      backend,
    });
    const result = await submitViaLocalClaudeCli({
      srcPath: entry.originalPath,
      srcType: fileType,
      outputPath: treePath,
      pythonPath,
      timeoutMs,
      summary: true,
      includeText: true,
    });
    if (!result.ok || !result.tree) {
      throw new Error(result.error ?? "local-claude-cli failed");
    }
    // Normalize and overwrite the tree file in the common shape.
    const normalized = PAGEINDEX_HELPERS.normalizeOssTree(result.tree, docName);
    PAGEINDEX_HELPERS.atomicWrite(
      treePath,
      JSON.stringify(
        {
          doc_name: normalized.doc_name,
          structure: normalized.structure,
          _raw: result.tree,
        },
        null,
        2,
      ) + "\n",
    );

    const newEntry: CloudIndexEntry = {
      originalPath: entry.originalPath,
      md5,
      docId,
      treePath,
      indexedAt: new Date().toISOString(),
      converted: false,
    };
    const updated = { ...indexMap, [entry.originalPath]: newEntry };
    PAGEINDEX_HELPERS.writeCloudIndex(storagePath, entry.projectName, updated);
    PAGEINDEX_HELPERS.updateCloudStatusEntry(
      storagePath,
      entry.projectName,
      entry.originalPath,
      { state: "indexed", docId, error: null },
    );
    log.info("pageindex local ok", {
      path: entry.originalPath,
      docId,
      elapsedSec: result.elapsedSec ?? 0,
      nodeCount: result.nodeCount ?? 0,
    });
    return { docId, treePath };
  }

  // ---------------------------------------------------------------------
  // Vectify cloud backend (existing path)
  // ---------------------------------------------------------------------
  // Resolve the actual PDF path. If docPath equals originalPath and the source
  // is markdown, convert to cached PDF first.
  let pdfPath = entry.docPath;
  let convertedPdfPath: string | undefined;
  if (fileType === "md") {
    const conv = await convertMarkdownToPdf({
      mdPath: entry.originalPath,
      projectName: entry.projectName,
      storagePath,
      pythonPath,
      timeoutMs: 120_000,
      title: entry.originalPath.split("/").pop() ?? "document",
    });
    if (!conv.ok) throw new Error(`md->pdf failed: ${conv.error}`);
    pdfPath = conv.pdfPath;
    convertedPdfPath = conv.pdfPath;
  }

  const size = (() => {
    try {
      return statSync(pdfPath).size;
    } catch {
      return 0;
    }
  })();
  if (size > 50 * 1024 * 1024) {
    throw new Error(`file too large for cloud: ${size} bytes (max 50MB)`);
  }

  log.info("pageindex submit", { path: entry.originalPath, pdfPath, backend });
  const result = await submitPdfToCloud({
    pdfPath,
    apiKey: connection.apiKey!,
    pythonPath,
    timeoutMs,
    nodeSummary: true,
    nodeText: true,
  });
  if (!result.ok || !result.tree || !result.docId) {
    throw new Error(result.error ?? "cloud submit failed");
  }

  const docName = entry.originalPath.split("/").pop() ?? "document";
  const normalized = PAGEINDEX_HELPERS.normalizeCloudTree(result.tree, docName);
  const safe = PAGEINDEX_HELPERS.safeName(docName);
  const treePath = join(
    PAGEINDEX_HELPERS.projectTreesDir(storagePath, entry.projectName),
    `${safe}-${result.docId.slice(0, 12)}.json`,
  );
  PAGEINDEX_HELPERS.atomicWrite(
    treePath,
    JSON.stringify(
      {
        doc_name: normalized.doc_name,
        structure: normalized.structure,
        _raw: result.tree,
      },
      null,
      2,
    ) + "\n",
  );

  const newEntry: CloudIndexEntry = {
    originalPath: entry.originalPath,
    md5,
    docId: result.docId,
    treePath,
    indexedAt: new Date().toISOString(),
    converted: convertedPdfPath !== undefined,
    ...(convertedPdfPath ? { convertedPdfPath } : {}),
  };
  const updated = { ...indexMap, [entry.originalPath]: newEntry };
  PAGEINDEX_HELPERS.writeCloudIndex(storagePath, entry.projectName, updated);
  PAGEINDEX_HELPERS.updateCloudStatusEntry(
    storagePath,
    entry.projectName,
    entry.originalPath,
    {
      state: "indexed",
      docId: result.docId,
      error: null,
    },
  );
  return { docId: result.docId, treePath };
}

function runGraphifyBuild(
  entry: GraphifyQueueEntry,
  timeoutMs: number,
  onChild: (child: ChildProcess) => void,
): Promise<void> {
  return new Promise((resolveP, reject) => {
    if (!existsSync(entry.projectPath)) {
      reject(new Error(`projectPath does not exist: ${entry.projectPath}`));
      return;
    }
    if (!existsSync(VENV_PYTHON)) {
      reject(new Error(`Python venv not found at ${VENV_PYTHON}`));
      return;
    }
    if (!existsSync(BUILD_SCRIPT)) {
      reject(new Error(`graphify_build.py not found at ${BUILD_SCRIPT}`));
      return;
    }

    ensureProjectDir(entry.projectName);
    const outputDir = join(GRAPHIFY_DIR, entry.projectName);

    const child = spawn(VENV_PYTHON, [BUILD_SCRIPT, entry.projectPath, outputDir, PLUGIN_GRAPHS_DIR], {
      stdio: ["ignore", "pipe", "pipe"],
    });
    onChild(child);

    let stderrBuf = "";
    child.stderr?.on("data", (chunk: Buffer) => {
      stderrBuf += chunk.toString("utf-8");
      // Cap buffer size so we don't keep huge logs in memory.
      if (stderrBuf.length > 64 * 1024) {
        stderrBuf = stderrBuf.slice(-32 * 1024);
      }
    });

    const timer = setTimeout(() => {
      try {
        child.kill("SIGKILL");
      } catch {
        // ignore
      }
      reject(
        new Error(
          `graphify build timed out after ${timeoutMs}ms for ${entry.projectName}`,
        ),
      );
    }, timeoutMs);

    child.on("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });

    child.on("exit", (code) => {
      clearTimeout(timer);
      if (code === 0) {
        // Sanity check that graphify actually wrote the file.
        const graphPath = getGraphPath(entry.projectName);
        if (!existsSync(graphPath)) {
          reject(
            new Error(
              `graphify exit 0 but graph.json missing at ${graphPath}`,
            ),
          );
          return;
        }
        resolveP();
        return;
      }
      reject(
        new Error(
          `graphify build exit ${code ?? -1}: ${stderrBuf.trim().slice(0, 1000)}`,
        ),
      );
    });
  });
}

// ---------------------------------------------------------------------------
// Utility
// ---------------------------------------------------------------------------

function randomId(): string {
  // Node 22+ ships crypto.randomUUID; no fallback needed per engines.node >= 22.
  return randomUUID();
}

// Expose internal paths for tests.
export const _internals = {
  QUEUE_PATH,
  GRAPHIFY_DIR,
  PAGEINDEX_DIR,
  CENTRAL_LOG_PATH,
  PAGEINDEX_LOG_PATH,
  statusPath,
};
