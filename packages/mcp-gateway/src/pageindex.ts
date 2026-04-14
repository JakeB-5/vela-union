// PageIndex MCP wrapper — triple backend (cloud + local-claude-cli + local).
//
// Three providers are supported:
//
//   - "vectify-cloud": hosted Vectify PageIndex API. PDF only on upload.
//     Markdown sources are converted to PDF first via scripts/md_to_pdf.py.
//     Uses scripts/pageindex_cloud.py to talk to the Python SDK.
//
//   - "local-claude-cli": OSS PageIndex at refs/PageIndex driven by the
//     local `claude -p` CLI. Zero API cost (uses Claude subscription),
//     no apiKey required. Markdown + PDF supported. Uses
//     scripts/pageindex_local.py which monkeypatches litellm.
//
//   - "local": the bundled open-source pageindex repo under refs/PageIndex.
//     Takes .md or .pdf directly, drives `run_pageindex.py` as a subprocess.
//     Requires OPENAI_API_KEY or ANTHROPIC_API_KEY in the environment.
//
// Provider selection is driven by ~/.vela/config.json (pageindex.provider),
// with env-var fallbacks. The wrapper returns a shape-compatible adapter
// object for the MCP tool layer — adding cloud support without a breaking
// change for callers.
//
// Storage layout (cloud provider):
//   ~/.vela/pageindex/<project>/index.json         originalPath -> entry map
//   ~/.vela/pageindex/<project>/status.json        per-project aggregate state
//   ~/.vela/pageindex/<project>/converted/<hash>.pdf
//   ~/.vela/pageindex/<project>/trees/<safe>.json
//
// Legacy (content-hash) storage at ~/.vela/pageindex/<docId>/ is preserved
// for the local provider path.

import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import {
  appendFileSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, extname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  createLogger,
  generateCid,
  resolvePageIndexConfig,
} from "@vela-union/shared";
import type {
  Logger,
  PageIndexConnectionConfig,
  PageIndexProvider,
} from "@vela-union/shared";

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Resolve repo root (packages/mcp-gateway/{src,dist}/pageindex.{ts,js})
const REPO_ROOT = resolve(__dirname, "..", "..", "..");

/** Default location of the bundled PageIndex open-source repo (local provider) */
const DEFAULT_LOCAL_REPO = resolve(
  process.env["VELA_PAGEINDEX_REPO"] ?? join(REPO_ROOT, "refs", "PageIndex"),
);

/** Default Python interpreter (project venv) */
const DEFAULT_PYTHON =
  process.env["VELA_PAGEINDEX_PYTHON"] ?? join(REPO_ROOT, ".venv", "bin", "python");

/** Cloud helper script */
const CLOUD_SCRIPT = join(REPO_ROOT, "scripts", "pageindex_cloud.py");

/** Local Claude CLI helper script (OSS PageIndex, zero-cost backend) */
const LOCAL_CLAUDE_SCRIPT = join(REPO_ROOT, "scripts", "pageindex_local.py");

/** Markdown -> PDF helper */
const MD_TO_PDF_SCRIPT = join(REPO_ROOT, "scripts", "md_to_pdf.py");

/** Storage root for all PageIndex state */
const PAGEINDEX_STORAGE = join(homedir(), ".vela", "pageindex");

/** Central log sink for cloud pageindex operations */
const PAGEINDEX_LOG = join(homedir(), ".vela", "logs", "pageindex-build.log");

// ---------------------------------------------------------------------------
// Types — shared across providers
// ---------------------------------------------------------------------------

export interface PageIndexConfig {
  /** Override the config resolution (useful for tests). */
  connection?: PageIndexConnectionConfig;
  /** Path to the local PageIndex repo (only for provider="local"). */
  repoPath?: string;
  /** Python interpreter to use */
  pythonPath?: string;
  /** Per-invocation timeout in milliseconds (default: 5 min for cloud). */
  timeoutMs?: number;
  /** Storage root override (default: ~/.vela/pageindex) */
  storagePath?: string;
  /** Project name — when set, cloud state lives under ~/.vela/pageindex/<project>/ */
  projectName?: string;
}

export interface IndexResult {
  success: boolean;
  docId: string;
  sourcePath: string;
  /** Original (user-facing) file extension. */
  fileType: "pdf" | "md";
  treePath: string;
  cached: boolean;
  durationMs: number;
  provider: PageIndexProvider;
  /** Present when a markdown source was converted to a cached intermediate PDF. */
  convertedPdfPath?: string;
  error?: string;
}

export interface PageIndexNode {
  title: string;
  node_id?: string;
  start_index?: number;
  end_index?: number;
  summary?: string;
  text?: string;
  nodes?: PageIndexNode[];
}

export interface PageIndexDocument {
  doc_name: string;
  doc_description?: string;
  structure: PageIndexNode[];
}

export interface PageContentSlice {
  page: number;
  content: string;
  title?: string;
}

/** Cloud provider per-project index entry */
export interface CloudIndexEntry {
  /** Absolute path to the original user-facing file */
  originalPath: string;
  /** Content-hash of the original source (md or pdf) */
  md5: string;
  /** Vectify cloud doc_id */
  docId: string;
  /** Absolute path to the locally stored tree.json */
  treePath: string;
  /** When the index succeeded */
  indexedAt: string;
  /** Whether the source was converted md -> pdf */
  converted: boolean;
  /** Cached converted PDF path (if converted) */
  convertedPdfPath?: string;
  /**
   * Backend that produced this entry. Optional for backward-compatibility
   * with pre-VELA-25 records — readers should treat missing as "unknown"
   * and callers filtering by backend should decide how to handle it
   * (typically: exclude from explicit --backend filter results).
   */
  backend?: "vectify-cloud" | "local-claude-cli";
}

/** Per-project aggregate state file */
export interface CloudStatusFile {
  projectName: string;
  updatedAt: string;
  docs: Record<
    string,
    {
      docId: string | null;
      state: "pending" | "indexing" | "indexed" | "failed";
      lastAttemptAt: string | null;
      error: string | null;
      /**
       * Backend that most recently touched this doc. Optional for BC —
       * missing means the state entry predates VELA-25. See CloudIndexEntry.
       */
      backend?: "vectify-cloud" | "local-claude-cli";
    }
  >;
}

/** Legacy (local) per-doc registry record */
interface LegacyDocumentRecord {
  doc_id: string;
  source_path: string;
  source_basename: string;
  file_type: "pdf" | "md";
  tree_path: string;
  source_copy_path: string;
  indexed_at: string;
}

// ---------------------------------------------------------------------------
// Small filesystem helpers
// ---------------------------------------------------------------------------

function ensureDir(p: string): void {
  if (!existsSync(p)) mkdirSync(p, { recursive: true });
}

/** Atomic write: tmp + rename. Never partial on POSIX same-fs. */
function atomicWrite(targetPath: string, body: string): void {
  ensureDir(dirname(targetPath));
  const tmp = join(
    dirname(targetPath),
    `.${basename(targetPath)}.tmp-${process.pid}-${Date.now()}`,
  );
  writeFileSync(tmp, body, "utf-8");
  renameSync(tmp, targetPath);
}

function sha256File(filePath: string): string {
  const data = readFileSync(filePath);
  return createHash("sha256").update(data).digest("hex");
}

function sha256String(s: string): string {
  return createHash("sha256").update(s).digest("hex");
}

function shortHash(filePath: string): string {
  return sha256File(filePath).slice(0, 16);
}

function detectFileType(filePath: string): "pdf" | "md" | null {
  const ext = extname(filePath).toLowerCase();
  if (ext === ".pdf") return "pdf";
  if (ext === ".md" || ext === ".markdown") return "md";
  return null;
}

function safeName(s: string): string {
  return s.replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 80);
}

// ---------------------------------------------------------------------------
// Logger
// ---------------------------------------------------------------------------

const pageIndexLogger: Logger = createLogger({
  component: "mcp-gateway.pageindex",
  cid: generateCid(),
  level: "info",
  tty: false,
});

function appendCentralLog(line: string): void {
  try {
    ensureDir(dirname(PAGEINDEX_LOG));
    appendFileSync(PAGEINDEX_LOG, `[${new Date().toISOString()}] ${line}\n`, "utf-8");
  } catch {
    // log failures must never break the caller
  }
}

// ---------------------------------------------------------------------------
// Cloud: per-project paths + state
// ---------------------------------------------------------------------------

function projectRoot(storagePath: string, projectName: string): string {
  return join(storagePath, projectName);
}

function projectIndexPath(storagePath: string, projectName: string): string {
  return join(projectRoot(storagePath, projectName), "index.json");
}

function projectStatusPath(storagePath: string, projectName: string): string {
  return join(projectRoot(storagePath, projectName), "status.json");
}

function projectTreesDir(storagePath: string, projectName: string): string {
  return join(projectRoot(storagePath, projectName), "trees");
}

function projectConvertedDir(storagePath: string, projectName: string): string {
  return join(projectRoot(storagePath, projectName), "converted");
}

function readCloudIndex(
  storagePath: string,
  projectName: string,
): Record<string, CloudIndexEntry> {
  const path = projectIndexPath(storagePath, projectName);
  if (!existsSync(path)) return {};
  try {
    return JSON.parse(readFileSync(path, "utf-8")) as Record<string, CloudIndexEntry>;
  } catch {
    return {};
  }
}

function writeCloudIndex(
  storagePath: string,
  projectName: string,
  index: Record<string, CloudIndexEntry>,
): void {
  atomicWrite(
    projectIndexPath(storagePath, projectName),
    JSON.stringify(index, null, 2) + "\n",
  );
}

function readCloudStatus(
  storagePath: string,
  projectName: string,
): CloudStatusFile {
  const path = projectStatusPath(storagePath, projectName);
  if (!existsSync(path)) {
    return {
      projectName,
      updatedAt: new Date().toISOString(),
      docs: {},
    };
  }
  try {
    return JSON.parse(readFileSync(path, "utf-8")) as CloudStatusFile;
  } catch {
    return { projectName, updatedAt: new Date().toISOString(), docs: {} };
  }
}

function writeCloudStatus(
  storagePath: string,
  projectName: string,
  status: CloudStatusFile,
): void {
  status.updatedAt = new Date().toISOString();
  atomicWrite(
    projectStatusPath(storagePath, projectName),
    JSON.stringify(status, null, 2) + "\n",
  );
}

export function updateCloudStatusEntry(
  storagePath: string,
  projectName: string,
  originalPath: string,
  patch: Partial<CloudStatusFile["docs"][string]>,
): void {
  const status = readCloudStatus(storagePath, projectName);
  const prev = status.docs[originalPath] ?? {
    docId: null,
    state: "pending" as const,
    lastAttemptAt: null,
    error: null,
  };
  status.docs[originalPath] = { ...prev, ...patch };
  writeCloudStatus(storagePath, projectName, status);
}

// ---------------------------------------------------------------------------
// Subprocess helpers
// ---------------------------------------------------------------------------

interface SubprocessResult {
  exitCode: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

function runPython(
  python: string,
  args: string[],
  opts: {
    cwd?: string;
    stdinJson?: unknown;
    timeoutMs: number;
    env?: NodeJS.ProcessEnv;
  },
): Promise<SubprocessResult> {
  return new Promise((resolveP) => {
    const stdoutChunks: string[] = [];
    const stderrChunks: string[] = [];
    let timedOut = false;

    const proc = spawn(python, args, {
      cwd: opts.cwd,
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env, ...opts.env },
    });

    const timer = setTimeout(() => {
      timedOut = true;
      try {
        proc.kill("SIGTERM");
      } catch {
        // ignore
      }
      setTimeout(() => {
        try {
          proc.kill("SIGKILL");
        } catch {
          // ignore
        }
      }, 5000);
    }, opts.timeoutMs);

    proc.stdout.on("data", (d: Buffer) => stdoutChunks.push(d.toString("utf-8")));
    proc.stderr.on("data", (d: Buffer) => stderrChunks.push(d.toString("utf-8")));

    if (opts.stdinJson !== undefined) {
      proc.stdin.write(JSON.stringify(opts.stdinJson));
    }
    proc.stdin.end();

    proc.on("error", (err) => {
      clearTimeout(timer);
      resolveP({
        exitCode: null,
        stdout: stdoutChunks.join(""),
        stderr: stderrChunks.join("") + `\nprocess error: ${err.message}`,
        timedOut,
      });
    });

    proc.on("close", (code) => {
      clearTimeout(timer);
      resolveP({
        exitCode: code,
        stdout: stdoutChunks.join(""),
        stderr: stderrChunks.join(""),
        timedOut,
      });
    });
  });
}

// ---------------------------------------------------------------------------
// Markdown -> PDF conversion (cached)
// ---------------------------------------------------------------------------

/**
 * Convert a markdown file to a cached PDF under
 * ~/.vela/pageindex/{project}/converted/{sha256}.pdf. Returns the cached path.
 */
export async function convertMarkdownToPdf(args: {
  mdPath: string;
  projectName: string;
  storagePath: string;
  pythonPath: string;
  timeoutMs: number;
  title?: string;
}): Promise<{ ok: boolean; pdfPath: string; error?: string }> {
  const { mdPath, projectName, storagePath, pythonPath, timeoutMs, title } = args;
  if (!existsSync(mdPath)) {
    return { ok: false, pdfPath: "", error: `md file not found: ${mdPath}` };
  }
  const raw = readFileSync(mdPath, "utf-8");
  const hash = sha256String(raw + "\n//title=" + (title ?? "")).slice(0, 32);
  const outDir = projectConvertedDir(storagePath, projectName);
  ensureDir(outDir);
  const pdfPath = join(outDir, `${hash}.pdf`);
  if (existsSync(pdfPath) && statSync(pdfPath).size > 0) {
    return { ok: true, pdfPath };
  }

  const pyArgs = [MD_TO_PDF_SCRIPT, mdPath, pdfPath];
  if (title) pyArgs.push("--title", title);
  const result = await runPython(pythonPath, pyArgs, { timeoutMs });
  if (result.exitCode !== 0 || !existsSync(pdfPath)) {
    return {
      ok: false,
      pdfPath: "",
      error: result.timedOut
        ? `md_to_pdf timed out after ${timeoutMs}ms`
        : `md_to_pdf exited ${result.exitCode}: ${result.stderr.slice(-800)}`,
    };
  }
  return { ok: true, pdfPath };
}

// ---------------------------------------------------------------------------
// Cloud submit + poll + fetch
// ---------------------------------------------------------------------------

export interface CloudSubmitResult {
  ok: boolean;
  docId?: string;
  tree?: Record<string, unknown>;
  waitedSec?: number;
  error?: string;
  errorKind?: string;
}

/**
 * Submit a PDF to the cloud, wait for readiness, fetch the tree. This is the
 * happy-path used by `vela index` for single files.
 */
export async function submitPdfToCloud(args: {
  pdfPath: string;
  apiKey: string;
  pythonPath: string;
  timeoutMs: number;
  nodeSummary?: boolean;
  nodeText?: boolean;
}): Promise<CloudSubmitResult> {
  const { pdfPath, apiKey, pythonPath, timeoutMs } = args;
  if (!existsSync(pdfPath)) {
    return { ok: false, error: `pdf not found: ${pdfPath}`, errorKind: "usage" };
  }
  if (!existsSync(CLOUD_SCRIPT)) {
    return {
      ok: false,
      error: `pageindex_cloud.py not found at ${CLOUD_SCRIPT}`,
      errorKind: "config",
    };
  }

  const payload = {
    cmd: "submit_and_fetch",
    apiKey,
    pdfPath,
    timeoutSec: Math.max(30, Math.floor(timeoutMs / 1000)),
    pollIntervalSec: 2,
    nodeSummary: args.nodeSummary ?? true,
    nodeText: args.nodeText ?? true,
  };

  const result = await runPython(pythonPath, [CLOUD_SCRIPT], {
    stdinJson: payload,
    timeoutMs: timeoutMs + 15_000,
  });

  if (result.exitCode !== 0 && !result.stdout.trim()) {
    return {
      ok: false,
      error: result.timedOut
        ? `cloud submit timed out after ${timeoutMs}ms`
        : `pageindex_cloud.py exited ${result.exitCode}: ${result.stderr.slice(-800)}`,
      errorKind: "exit",
    };
  }

  try {
    const parsed = JSON.parse(result.stdout.trim()) as {
      ok: boolean;
      error?: string;
      kind?: string;
      docId?: string;
      waitedSec?: number;
      tree?: Record<string, unknown>;
    };
    if (!parsed.ok) {
      return {
        ok: false,
        error: parsed.error ?? "unknown cloud error",
        errorKind: parsed.kind ?? "cloud",
      };
    }
    return {
      ok: true,
      ...(parsed.docId !== undefined ? { docId: parsed.docId } : {}),
      ...(parsed.waitedSec !== undefined ? { waitedSec: parsed.waitedSec } : {}),
      ...(parsed.tree !== undefined ? { tree: parsed.tree } : {}),
    };
  } catch (err) {
    return {
      ok: false,
      error: `invalid JSON from pageindex_cloud.py: ${(err as Error).message}: ${result.stdout.slice(0, 400)}`,
      errorKind: "parse",
    };
  }
}

// ---------------------------------------------------------------------------
// Local Claude CLI backend
// ---------------------------------------------------------------------------

export interface LocalCliResult {
  ok: boolean;
  treePath?: string;
  tree?: Record<string, unknown>;
  nodeCount?: number;
  elapsedSec?: number;
  error?: string;
  errorKind?: string;
}

/**
 * Invoke scripts/pageindex_local.py which runs the OSS PageIndex library
 * against the `claude -p` CLI. Writes the tree to `outputPath` and returns
 * the parsed JSON preview.
 *
 * No API key is required — Claude CLI reads credentials from ~/.claude/.
 * Both markdown and PDF inputs are supported (distinct via srcType).
 */
export async function submitViaLocalClaudeCli(args: {
  srcPath: string;
  srcType: "md" | "pdf";
  outputPath: string;
  pythonPath: string;
  timeoutMs: number;
  summary?: boolean;
  includeText?: boolean;
}): Promise<LocalCliResult> {
  const { srcPath, srcType, outputPath, pythonPath, timeoutMs } = args;
  if (!existsSync(srcPath)) {
    return { ok: false, error: `source not found: ${srcPath}`, errorKind: "usage" };
  }
  if (!existsSync(LOCAL_CLAUDE_SCRIPT)) {
    return {
      ok: false,
      error: `pageindex_local.py not found at ${LOCAL_CLAUDE_SCRIPT}`,
      errorKind: "config",
    };
  }

  const flag = srcType === "md" ? "--md-path" : "--pdf-path";
  const scriptArgs = [
    LOCAL_CLAUDE_SCRIPT,
    flag,
    srcPath,
    "--output",
    outputPath,
    "--summary",
    args.summary === false ? "no" : "yes",
    "--include-text",
    args.includeText === false ? "no" : "yes",
  ];

  const result = await runPython(pythonPath, scriptArgs, { timeoutMs });
  if (result.exitCode !== 0 && !result.stdout.trim()) {
    return {
      ok: false,
      error: result.timedOut
        ? `local claude-cli timed out after ${timeoutMs}ms`
        : `pageindex_local.py exited ${result.exitCode}: ${result.stderr.slice(-800)}`,
      errorKind: "exit",
    };
  }
  // The script may emit progress to stdout (print statements) BEFORE the
  // final JSON line. We parse the last non-empty line as JSON.
  const lines = result.stdout.split("\n").filter((l) => l.trim().length > 0);
  const last = lines[lines.length - 1] ?? "";
  try {
    const parsed = JSON.parse(last) as {
      ok: boolean;
      error?: string;
      kind?: string;
      treePath?: string;
      nodeCount?: number;
      elapsedSec?: number;
      tree?: Record<string, unknown>;
    };
    if (!parsed.ok) {
      return {
        ok: false,
        error: parsed.error ?? "unknown local-claude-cli error",
        errorKind: parsed.kind ?? "local",
      };
    }
    return {
      ok: true,
      ...(parsed.treePath !== undefined ? { treePath: parsed.treePath } : {}),
      ...(parsed.nodeCount !== undefined ? { nodeCount: parsed.nodeCount } : {}),
      ...(parsed.elapsedSec !== undefined ? { elapsedSec: parsed.elapsedSec } : {}),
      ...(parsed.tree !== undefined ? { tree: parsed.tree } : {}),
    };
  } catch (err) {
    return {
      ok: false,
      error: `invalid JSON from pageindex_local.py: ${(err as Error).message}: ${last.slice(0, 400)}`,
      errorKind: "parse",
    };
  }
}

/**
 * Normalize an OSS PageIndex tree to the common PageIndexDocument shape.
 * The OSS library returns `{ doc_name, line_count, structure: [...] }`
 * where each structure node has { title, node_id, line_num, summary?,
 * prefix_summary?, text?, nodes? }. We map to PageIndexNode.
 */
function normalizeOssTree(
  raw: Record<string, unknown>,
  docName: string,
): PageIndexDocument {
  const structure = Array.isArray((raw as { structure?: unknown }).structure)
    ? ((raw as { structure: unknown[] }).structure)
    : [];

  const toNode = (input: unknown): PageIndexNode => {
    const n = (input ?? {}) as Record<string, unknown>;
    const children = Array.isArray(n["nodes"]) ? (n["nodes"] as unknown[]) : [];
    const node: PageIndexNode = {
      title: typeof n["title"] === "string" ? (n["title"] as string) : "",
    };
    if (typeof n["node_id"] === "string") node.node_id = n["node_id"] as string;
    if (typeof n["line_num"] === "number") {
      // OSS md trees use line_num — map it to start_index for shape compat.
      node.start_index = n["line_num"] as number;
    }
    if (typeof n["start_index"] === "number") {
      node.start_index = n["start_index"] as number;
    }
    if (typeof n["end_index"] === "number") node.end_index = n["end_index"] as number;
    if (typeof n["summary"] === "string") node.summary = n["summary"] as string;
    // OSS parents use prefix_summary; fall back to it if summary missing.
    if (!node.summary && typeof n["prefix_summary"] === "string") {
      node.summary = n["prefix_summary"] as string;
    }
    if (typeof n["text"] === "string") node.text = n["text"] as string;
    if (children.length > 0) node.nodes = children.map(toNode);
    return node;
  };

  return {
    doc_name:
      typeof (raw as { doc_name?: unknown }).doc_name === "string"
        ? ((raw as { doc_name: string }).doc_name)
        : docName,
    structure: structure.map(toNode),
  };
}

// ---------------------------------------------------------------------------
// Tree extraction helpers
// ---------------------------------------------------------------------------

/**
 * Normalize a Vectify tree response to the common PageIndexDocument shape.
 * The cloud returns `{ result: [...] }` — we map each tree node to our
 * PageIndexNode structure so the MCP tools don't have to care which backend
 * produced it.
 */
function normalizeCloudTree(
  raw: Record<string, unknown>,
  docName: string,
): PageIndexDocument {
  // The cloud currently returns either `result` (top-level array) or a
  // flat array under `tree`. Handle both.
  const candidates: unknown[] =
    Array.isArray((raw as { result?: unknown }).result)
      ? ((raw as { result: unknown[] }).result)
      : Array.isArray((raw as { tree?: unknown }).tree)
        ? ((raw as { tree: unknown[] }).tree)
        : [];

  const toNode = (input: unknown): PageIndexNode => {
    const n = (input ?? {}) as Record<string, unknown>;
    const children = Array.isArray(n["nodes"]) ? (n["nodes"] as unknown[]) : [];
    const node: PageIndexNode = {
      title: typeof n["title"] === "string" ? (n["title"] as string) : "",
    };
    if (typeof n["node_id"] === "string") node.node_id = n["node_id"] as string;
    if (typeof n["start_index"] === "number") node.start_index = n["start_index"] as number;
    if (typeof n["end_index"] === "number") node.end_index = n["end_index"] as number;
    if (typeof n["summary"] === "string") node.summary = n["summary"] as string;
    if (typeof n["text"] === "string") node.text = n["text"] as string;
    if (children.length > 0) node.nodes = children.map(toNode);
    return node;
  };

  return {
    doc_name: docName,
    structure: candidates.map(toNode),
  };
}

function countNodes(nodes: PageIndexNode[]): number {
  let total = 0;
  for (const n of nodes) {
    total += 1;
    if (n.nodes && n.nodes.length > 0) total += countNodes(n.nodes);
  }
  return total;
}

function findNodeById(nodes: PageIndexNode[], nodeId: string): PageIndexNode | null {
  for (const node of nodes) {
    if (node.node_id === nodeId) return node;
    if (node.nodes && node.nodes.length > 0) {
      const found = findNodeById(node.nodes, nodeId);
      if (found) return found;
    }
  }
  return null;
}

function stripText(nodes: PageIndexNode[]): PageIndexNode[] {
  return nodes.map((node) => {
    const { text: _text, ...rest } = node;
    void _text;
    return {
      ...rest,
      ...(node.nodes ? { nodes: stripText(node.nodes) } : {}),
    };
  });
}

function parsePages(spec: string): number[] {
  const result = new Set<number>();
  for (const part of spec.split(",")) {
    const trimmed = part.trim();
    if (!trimmed) continue;
    if (trimmed.includes("-")) {
      const [startStr, endStr] = trimmed.split("-", 2);
      if (!startStr || !endStr) throw new Error(`Invalid range: ${trimmed}`);
      const start = parseInt(startStr.trim(), 10);
      const end = parseInt(endStr.trim(), 10);
      if (Number.isNaN(start) || Number.isNaN(end)) {
        throw new Error(`Invalid range: ${trimmed}`);
      }
      if (start > end) throw new Error(`Invalid range: ${trimmed} (start > end)`);
      for (let p = start; p <= end; p += 1) result.add(p);
    } else {
      const page = parseInt(trimmed, 10);
      if (Number.isNaN(page)) throw new Error(`Invalid page number: ${trimmed}`);
      result.add(page);
    }
  }
  return Array.from(result).sort((a, b) => a - b);
}

function collectPdfPages(
  nodes: PageIndexNode[],
  requested: Set<number>,
  out: PageContentSlice[],
): void {
  for (const node of nodes) {
    const start = node.start_index;
    const end = node.end_index ?? start;
    if (start !== undefined && end !== undefined) {
      let overlaps = false;
      for (let p = start; p <= end; p += 1) {
        if (requested.has(p)) {
          overlaps = true;
          break;
        }
      }
      if (overlaps) {
        out.push({
          page: start,
          title: node.title,
          content: node.text ?? node.summary ?? "",
        });
      }
    }
    if (node.nodes && node.nodes.length > 0) {
      collectPdfPages(node.nodes, requested, out);
    }
  }
}

// ---------------------------------------------------------------------------
// Legacy (local) registry support — kept for backwards compatibility
// ---------------------------------------------------------------------------

function legacyEnsureStorage(storagePath: string): { root: string; index: string } {
  if (!existsSync(storagePath)) mkdirSync(storagePath, { recursive: true });
  const indexFile = join(storagePath, "index.json");
  if (!existsSync(indexFile)) writeFileSync(indexFile, "{}\n", "utf-8");
  return { root: storagePath, index: indexFile };
}

function legacyReadRegistry(indexFile: string): Record<string, LegacyDocumentRecord> {
  try {
    return JSON.parse(readFileSync(indexFile, "utf-8")) as Record<
      string,
      LegacyDocumentRecord
    >;
  } catch {
    return {};
  }
}

function legacyWriteRegistry(
  indexFile: string,
  registry: Record<string, LegacyDocumentRecord>,
): void {
  writeFileSync(indexFile, JSON.stringify(registry, null, 2) + "\n", "utf-8");
}

function runLocalPageIndex(
  python: string,
  repoPath: string,
  args: string[],
  cwd: string,
  timeoutMs: number,
): Promise<{ exitCode: number | null; output: string; timedOut: boolean }> {
  return new Promise((resolveP) => {
    const chunks: string[] = [];
    let timedOut = false;

    const proc = spawn(python, ["run_pageindex.py", ...args], {
      cwd,
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, PYTHONPATH: repoPath },
    });

    const timer = setTimeout(() => {
      timedOut = true;
      try {
        proc.kill("SIGTERM");
      } catch {
        // ignore
      }
      setTimeout(() => {
        try {
          proc.kill("SIGKILL");
        } catch {
          // ignore
        }
      }, 10_000);
    }, timeoutMs);

    proc.stdout.on("data", (data: Buffer) => chunks.push(data.toString()));
    proc.stderr.on("data", (data: Buffer) => chunks.push(data.toString()));

    proc.on("close", (exitCode) => {
      clearTimeout(timer);
      resolveP({ exitCode, output: chunks.join(""), timedOut });
    });

    proc.on("error", (err) => {
      clearTimeout(timer);
      resolveP({
        exitCode: null,
        output: `Process error: ${err.message}`,
        timedOut: false,
      });
    });
  });
}

// ---------------------------------------------------------------------------
// Public adapter
// ---------------------------------------------------------------------------

export type PageIndexAvailability = {
  available: boolean;
  provider: PageIndexProvider;
  python: boolean;
  repo: boolean;
  apiKey: boolean;
  reason?: string;
};

/**
 * Create a PageIndex adapter with the resolved provider. The provider is
 * chosen based on ~/.vela/config.json; callers may override via
 * `config.connection`. The returned object's methods all return plain JSON
 * that can be flowed through the MCP tool layer unchanged.
 */
export function createPageIndex(config: PageIndexConfig = {}) {
  const connection = config.connection ?? resolvePageIndexConfig();
  const provider: PageIndexProvider = connection.provider ?? "local";
  const pythonPath = config.pythonPath ?? DEFAULT_PYTHON;
  const repoPath = resolve(config.repoPath ?? DEFAULT_LOCAL_REPO);
  const timeoutMs = config.timeoutMs ?? 5 * 60 * 1000;
  const storagePath = config.storagePath ?? PAGEINDEX_STORAGE;
  const defaultProject = config.projectName ?? "_default";

  ensureDir(storagePath);

  return {
    provider,
    pythonPath,
    repoPath,
    storagePath,
    apiKey: connection.apiKey,

    /** Runtime prerequisite check */
    checkAvailability(): PageIndexAvailability {
      const python = existsSync(pythonPath);
      const reasons: string[] = [];
      if (!python) reasons.push(`python not found at ${pythonPath}`);

      if (provider === "vectify-cloud") {
        const apiKey = Boolean(connection.apiKey);
        const repo = existsSync(CLOUD_SCRIPT);
        if (!apiKey) reasons.push("pageindex.apiKey missing in ~/.vela/config.json");
        if (!repo) reasons.push(`pageindex_cloud.py not found at ${CLOUD_SCRIPT}`);
        return {
          available: python && apiKey && repo,
          provider,
          python,
          repo,
          apiKey,
          ...(reasons.length > 0 ? { reason: reasons.join("; ") } : {}),
        };
      }

      if (provider === "local-claude-cli") {
        // No API key required — Claude CLI reads ~/.claude/. We treat the
        // OSS repo AND the local runner script as "repo".
        const repo =
          existsSync(LOCAL_CLAUDE_SCRIPT) &&
          existsSync(join(repoPath, "pageindex", "page_index_md.py"));
        if (!repo) {
          reasons.push(
            `pageindex_local.py or OSS PageIndex missing (script=${LOCAL_CLAUDE_SCRIPT}, repo=${repoPath})`,
          );
        }
        return {
          available: python && repo,
          provider,
          python,
          repo,
          apiKey: true, // not needed for this backend
          ...(reasons.length > 0 ? { reason: reasons.join("; ") } : {}),
        };
      }

      const repo = existsSync(join(repoPath, "run_pageindex.py"));
      const apiKey = Boolean(
        process.env["OPENAI_API_KEY"] ?? process.env["ANTHROPIC_API_KEY"],
      );
      if (!repo) reasons.push(`PageIndex repo not found at ${repoPath}`);
      if (!apiKey) reasons.push("no OPENAI_API_KEY or ANTHROPIC_API_KEY in env");
      return {
        available: python && repo && apiKey,
        provider,
        python,
        repo,
        apiKey,
        ...(reasons.length > 0 ? { reason: reasons.join("; ") } : {}),
      };
    },

    /**
     * List indexed documents across the storage path.
     * Cloud provider: flattens entries from every per-project index.json.
     * Local provider: reads the legacy content-hash registry.
     */
    listDocuments(): Array<{
      docId: string;
      sourcePath: string;
      fileType: string;
      treePath: string;
      indexedAt: string;
      project?: string;
    }> {
      // Both vectify-cloud and local-claude-cli share the per-project
      // ~/.vela/pageindex/<project>/index.json layout.
      if (provider === "vectify-cloud" || provider === "local-claude-cli") {
        const out: Array<{
          docId: string;
          sourcePath: string;
          fileType: string;
          treePath: string;
          indexedAt: string;
          project: string;
        }> = [];
        if (!existsSync(storagePath)) return out;
        for (const entry of readdirSync(storagePath)) {
          const pDir = join(storagePath, entry);
          let isDir = false;
          try {
            isDir = statSync(pDir).isDirectory();
          } catch {
            continue;
          }
          if (!isDir) continue;
          const idx = readCloudIndex(storagePath, entry);
          for (const [original, record] of Object.entries(idx)) {
            out.push({
              docId: record.docId,
              sourcePath: original,
              fileType: detectFileType(original) ?? "pdf",
              treePath: record.treePath,
              indexedAt: record.indexedAt,
              project: entry,
            });
          }
        }
        return out;
      }
      // Local provider: legacy flat registry
      const { index } = legacyEnsureStorage(storagePath);
      const registry = legacyReadRegistry(index);
      return Object.values(registry).map((r) => ({
        docId: r.doc_id,
        sourcePath: r.source_path,
        fileType: r.file_type,
        treePath: r.tree_path,
        indexedAt: r.indexed_at,
      }));
    },

    /**
     * Index a single document. Routes to cloud or local based on provider.
     * For cloud + markdown: converts md -> pdf first.
     */
    async indexDocument(
      filePath: string,
      opts: { projectName?: string } = {},
    ): Promise<IndexResult> {
      const start = Date.now();
      const absPath = resolve(filePath);
      const fileType = detectFileType(absPath);
      if (!existsSync(absPath)) {
        return {
          success: false,
          docId: "",
          sourcePath: absPath,
          fileType: "pdf",
          treePath: "",
          cached: false,
          durationMs: Date.now() - start,
          provider,
          error: `File not found: ${absPath}`,
        };
      }
      if (!fileType) {
        return {
          success: false,
          docId: "",
          sourcePath: absPath,
          fileType: "pdf",
          treePath: "",
          cached: false,
          durationMs: Date.now() - start,
          provider,
          error: "Unsupported file type. Expected .pdf, .md, or .markdown.",
        };
      }

      if (provider === "vectify-cloud") {
        return indexViaCloud({
          absPath,
          fileType,
          projectName: opts.projectName ?? defaultProject,
          storagePath,
          apiKey: connection.apiKey,
          pythonPath,
          timeoutMs,
          startedAt: start,
        });
      }

      if (provider === "local-claude-cli") {
        return indexViaLocalClaudeCli({
          absPath,
          fileType,
          projectName: opts.projectName ?? defaultProject,
          storagePath,
          pythonPath,
          // Claude CLI is slow — allow the caller's timeout or 30 min min.
          timeoutMs: Math.max(timeoutMs, 30 * 60 * 1000),
          startedAt: start,
        });
      }

      return indexViaLocal({
        absPath,
        fileType,
        storagePath,
        repoPath,
        pythonPath,
        timeoutMs: Math.max(timeoutMs, 10 * 60 * 1000),
        startedAt: start,
      });
    },

    /**
     * Look up a tree by original path OR by docId. Cloud provider expects the
     * caller to pass a project name — when missing, we search every project.
     */
    getStructure(
      identifier: string,
      opts: { projectName?: string } = {},
    ): {
      success: boolean;
      doc?: PageIndexDocument;
      nodeCount?: number;
      docId?: string;
      error?: string;
    } {
      if (provider === "vectify-cloud" || provider === "local-claude-cli") {
        const resolved = locateCloudEntry(storagePath, identifier, opts.projectName);
        if (!resolved) {
          return { success: false, error: `Document not found: ${identifier}` };
        }
        if (!existsSync(resolved.entry.treePath)) {
          return {
            success: false,
            error: `Tree file missing for ${resolved.entry.docId}: ${resolved.entry.treePath}`,
          };
        }
        try {
          const parsed = JSON.parse(
            readFileSync(resolved.entry.treePath, "utf-8"),
          ) as PageIndexDocument;
          const stripped: PageIndexDocument = {
            doc_name: parsed.doc_name,
            ...(parsed.doc_description !== undefined
              ? { doc_description: parsed.doc_description }
              : {}),
            structure: stripText(parsed.structure ?? []),
          };
          return {
            success: true,
            doc: stripped,
            nodeCount: countNodes(parsed.structure ?? []),
            docId: resolved.entry.docId,
          };
        } catch (err) {
          return {
            success: false,
            error: `Failed to read tree: ${(err as Error).message}`,
          };
        }
      }

      // Local provider (legacy)
      const { index } = legacyEnsureStorage(storagePath);
      const registry = legacyReadRegistry(index);
      const record = registry[identifier];
      if (!record) {
        return { success: false, error: `Document not found: ${identifier}` };
      }
      if (!existsSync(record.tree_path)) {
        return {
          success: false,
          error: `Tree file missing for ${identifier}: ${record.tree_path}`,
        };
      }
      try {
        const parsed = JSON.parse(readFileSync(record.tree_path, "utf-8")) as PageIndexDocument;
        const stripped: PageIndexDocument = {
          doc_name: parsed.doc_name,
          ...(parsed.doc_description !== undefined
            ? { doc_description: parsed.doc_description }
            : {}),
          structure: stripText(parsed.structure ?? []),
        };
        return {
          success: true,
          doc: stripped,
          nodeCount: countNodes(parsed.structure ?? []),
          docId: identifier,
        };
      } catch (err) {
        return {
          success: false,
          error: `Failed to read tree: ${(err as Error).message}`,
        };
      }
    },

    /** Fetch content for specific pages / line-nums / node ids. */
    getPageContent(
      identifier: string,
      pages: string,
      opts: { projectName?: string } = {},
    ): {
      success: boolean;
      slices?: PageContentSlice[];
      error?: string;
    } {
      let treePath: string;
      let fileType: "pdf" | "md" = "pdf";

      if (provider === "vectify-cloud" || provider === "local-claude-cli") {
        const resolved = locateCloudEntry(storagePath, identifier, opts.projectName);
        if (!resolved) return { success: false, error: `Document not found: ${identifier}` };
        treePath = resolved.entry.treePath;
        fileType = detectFileType(resolved.entry.originalPath) ?? "pdf";
      } else {
        const { index } = legacyEnsureStorage(storagePath);
        const record = legacyReadRegistry(index)[identifier];
        if (!record) return { success: false, error: `Document not found: ${identifier}` };
        treePath = record.tree_path;
        fileType = record.file_type;
      }

      if (!existsSync(treePath)) {
        return { success: false, error: `Tree file missing: ${treePath}` };
      }

      let parsed: PageIndexDocument;
      try {
        parsed = JSON.parse(readFileSync(treePath, "utf-8")) as PageIndexDocument;
      } catch (err) {
        return {
          success: false,
          error: `Failed to read tree: ${(err as Error).message}`,
        };
      }

      const structure = parsed.structure ?? [];
      const tokens = pages.split(",").map((t) => t.trim()).filter(Boolean);
      const looksLikeNodeIds =
        tokens.length > 0 && tokens.every((t) => /^\d{4,}$/.test(t));

      if (looksLikeNodeIds) {
        const slices: PageContentSlice[] = [];
        for (const nodeId of tokens) {
          const node = findNodeById(structure, nodeId);
          if (!node) {
            slices.push({ page: 0, title: `<missing node ${nodeId}>`, content: "" });
            continue;
          }
          slices.push({
            page: node.start_index ?? 0,
            title: node.title,
            content: node.text ?? node.summary ?? "",
          });
        }
        return { success: true, slices };
      }

      let parsedPages: number[];
      try {
        parsedPages = parsePages(pages);
      } catch (err) {
        return { success: false, error: (err as Error).message };
      }

      const requested = new Set(parsedPages);
      const slices: PageContentSlice[] = [];
      if (fileType === "md") {
        const walk = (nodes: PageIndexNode[]): void => {
          for (const node of nodes) {
            const ln =
              (node as PageIndexNode & { line_num?: number }).line_num ?? node.start_index;
            if (ln !== undefined && requested.has(ln)) {
              slices.push({
                page: ln,
                title: node.title,
                content: node.text ?? node.summary ?? "",
              });
            }
            if (node.nodes && node.nodes.length > 0) walk(node.nodes);
          }
        };
        walk(structure);
      } else {
        collectPdfPages(structure, requested, slices);
      }

      return { success: true, slices };
    },

    /** Internal helpers exposed for tests. */
    _internal: {
      sha256File,
      sha256String,
      detectFileType,
      parsePages,
      countNodes,
      normalizeCloudTree,
      projectIndexPath,
      projectStatusPath,
      projectTreesDir,
      projectConvertedDir,
      readCloudIndex,
      readCloudStatus,
    },
  };
}

export type PageIndexAdapter = ReturnType<typeof createPageIndex>;

// ---------------------------------------------------------------------------
// Cloud / local indexDocument implementations
// ---------------------------------------------------------------------------

function locateCloudEntry(
  storagePath: string,
  identifier: string,
  projectHint?: string,
): { project: string; entry: CloudIndexEntry } | null {
  const absIdentifier = (() => {
    try {
      return resolve(identifier);
    } catch {
      return identifier;
    }
  })();

  const scanProject = (project: string): CloudIndexEntry | null => {
    const idx = readCloudIndex(storagePath, project);
    // Try path match, then docId match
    const byPath = idx[absIdentifier] ?? idx[identifier];
    if (byPath) return byPath;
    for (const entry of Object.values(idx)) {
      if (entry.docId === identifier) return entry;
    }
    return null;
  };

  if (projectHint) {
    const entry = scanProject(projectHint);
    if (entry) return { project: projectHint, entry };
    return null;
  }

  if (!existsSync(storagePath)) return null;
  for (const project of readdirSync(storagePath)) {
    try {
      if (!statSync(join(storagePath, project)).isDirectory()) continue;
    } catch {
      continue;
    }
    const entry = scanProject(project);
    if (entry) return { project, entry };
  }
  return null;
}

async function indexViaCloud(args: {
  absPath: string;
  fileType: "pdf" | "md";
  projectName: string;
  storagePath: string;
  apiKey: string | undefined;
  pythonPath: string;
  timeoutMs: number;
  startedAt: number;
}): Promise<IndexResult> {
  const { absPath, fileType, projectName, storagePath, apiKey, pythonPath, timeoutMs, startedAt } =
    args;

  if (!apiKey) {
    return {
      success: false,
      docId: "",
      sourcePath: absPath,
      fileType,
      treePath: "",
      cached: false,
      durationMs: Date.now() - startedAt,
      provider: "vectify-cloud",
      error: "pageindex.apiKey not configured in ~/.vela/config.json",
    };
  }

  ensureDir(projectRoot(storagePath, projectName));
  ensureDir(projectTreesDir(storagePath, projectName));
  ensureDir(projectConvertedDir(storagePath, projectName));

  // Idempotency: look up by original path + content md5
  const md5 = sha256File(absPath);
  const cloudIndex = readCloudIndex(storagePath, projectName);
  const existing = cloudIndex[absPath];
  if (
    existing &&
    existing.md5 === md5 &&
    existsSync(existing.treePath) &&
    statSync(existing.treePath).size > 0
  ) {
    pageIndexLogger.info("cloud cache hit", {
      project: projectName,
      path: absPath,
      docId: existing.docId,
    });
    appendCentralLog(
      `project=${projectName} path=${absPath} state=cached docId=${existing.docId}`,
    );
    return {
      success: true,
      docId: existing.docId,
      sourcePath: absPath,
      fileType,
      treePath: existing.treePath,
      cached: true,
      durationMs: Date.now() - startedAt,
      provider: "vectify-cloud",
      ...(existing.convertedPdfPath ? { convertedPdfPath: existing.convertedPdfPath } : {}),
    };
  }

  // Mark indexing
  updateCloudStatusEntry(storagePath, projectName, absPath, {
    state: "indexing",
    lastAttemptAt: new Date().toISOString(),
    error: null,
    backend: "vectify-cloud",
  });

  // Convert md -> pdf if needed
  let pdfForUpload = absPath;
  let convertedPdfPath: string | undefined;
  if (fileType === "md") {
    const conv = await convertMarkdownToPdf({
      mdPath: absPath,
      projectName,
      storagePath,
      pythonPath,
      timeoutMs: 120_000,
      title: basename(absPath),
    });
    if (!conv.ok) {
      const msg = `md_to_pdf failed: ${conv.error}`;
      updateCloudStatusEntry(storagePath, projectName, absPath, {
        state: "failed",
        error: msg,
        backend: "vectify-cloud",
      });
      appendCentralLog(`project=${projectName} path=${absPath} state=failed error=${msg}`);
      return {
        success: false,
        docId: "",
        sourcePath: absPath,
        fileType,
        treePath: "",
        cached: false,
        durationMs: Date.now() - startedAt,
        provider: "vectify-cloud",
        error: msg,
      };
    }
    pdfForUpload = conv.pdfPath;
    convertedPdfPath = conv.pdfPath;
  }

  // Guard on file size (50 MB cloud cap)
  try {
    const size = statSync(pdfForUpload).size;
    if (size > 50 * 1024 * 1024) {
      const msg = `file too large for cloud: ${size} bytes (max 50MB)`;
      updateCloudStatusEntry(storagePath, projectName, absPath, {
        state: "failed",
        error: msg,
        backend: "vectify-cloud",
      });
      appendCentralLog(`project=${projectName} path=${absPath} state=failed error=${msg}`);
      return {
        success: false,
        docId: "",
        sourcePath: absPath,
        fileType,
        treePath: "",
        cached: false,
        durationMs: Date.now() - startedAt,
        provider: "vectify-cloud",
        error: msg,
      };
    }
  } catch {
    // ignore; submit will surface the error
  }

  // Submit + poll + fetch
  const cloudResult = await submitPdfToCloud({
    pdfPath: pdfForUpload,
    apiKey,
    pythonPath,
    timeoutMs,
    nodeSummary: true,
    nodeText: true,
  });
  if (!cloudResult.ok || !cloudResult.tree || !cloudResult.docId) {
    const msg = cloudResult.error ?? "cloud submit failed";
    updateCloudStatusEntry(storagePath, projectName, absPath, {
      state: "failed",
      error: msg,
      backend: "vectify-cloud",
    });
    appendCentralLog(`project=${projectName} path=${absPath} state=failed error=${msg}`);
    return {
      success: false,
      docId: "",
      sourcePath: absPath,
      fileType,
      treePath: "",
      cached: false,
      durationMs: Date.now() - startedAt,
      provider: "vectify-cloud",
      error: msg,
    };
  }

  // Persist tree
  const docName = basename(absPath);
  const normalized = normalizeCloudTree(cloudResult.tree, docName);
  const treeFileName = `${safeName(docName)}-${cloudResult.docId.slice(0, 12)}.json`;
  const treePath = join(projectTreesDir(storagePath, projectName), treeFileName);
  atomicWrite(
    treePath,
    JSON.stringify(
      {
        doc_name: normalized.doc_name,
        structure: normalized.structure,
        _raw: cloudResult.tree,
      },
      null,
      2,
    ) + "\n",
  );

  const entry: CloudIndexEntry = {
    originalPath: absPath,
    md5,
    docId: cloudResult.docId,
    treePath,
    indexedAt: new Date().toISOString(),
    converted: convertedPdfPath !== undefined,
    ...(convertedPdfPath ? { convertedPdfPath } : {}),
    backend: "vectify-cloud",
  };

  const updated = { ...cloudIndex, [absPath]: entry };
  writeCloudIndex(storagePath, projectName, updated);
  updateCloudStatusEntry(storagePath, projectName, absPath, {
    state: "indexed",
    docId: cloudResult.docId,
    error: null,
    backend: "vectify-cloud",
  });
  appendCentralLog(
    `project=${projectName} path=${absPath} state=indexed docId=${cloudResult.docId} waitedSec=${cloudResult.waitedSec ?? 0}`,
  );
  pageIndexLogger.info("cloud indexed", {
    project: projectName,
    path: absPath,
    docId: cloudResult.docId,
    waitedSec: cloudResult.waitedSec,
  });

  return {
    success: true,
    docId: cloudResult.docId,
    sourcePath: absPath,
    fileType,
    treePath,
    cached: false,
    durationMs: Date.now() - startedAt,
    provider: "vectify-cloud",
    ...(convertedPdfPath ? { convertedPdfPath } : {}),
  };
}

async function indexViaLocalClaudeCli(args: {
  absPath: string;
  fileType: "pdf" | "md";
  projectName: string;
  storagePath: string;
  pythonPath: string;
  timeoutMs: number;
  startedAt: number;
}): Promise<IndexResult> {
  const {
    absPath,
    fileType,
    projectName,
    storagePath,
    pythonPath,
    timeoutMs,
    startedAt,
  } = args;

  ensureDir(projectRoot(storagePath, projectName));
  ensureDir(projectTreesDir(storagePath, projectName));

  // Idempotency — same layout as cloud backend.
  const md5 = sha256File(absPath);
  const cloudIndex = readCloudIndex(storagePath, projectName);
  const existing = cloudIndex[absPath];
  if (
    existing &&
    existing.md5 === md5 &&
    existsSync(existing.treePath) &&
    statSync(existing.treePath).size > 0
  ) {
    pageIndexLogger.info("local-claude-cli cache hit", {
      project: projectName,
      path: absPath,
      docId: existing.docId,
    });
    return {
      success: true,
      docId: existing.docId,
      sourcePath: absPath,
      fileType,
      treePath: existing.treePath,
      cached: true,
      durationMs: Date.now() - startedAt,
      provider: "local-claude-cli",
    };
  }

  updateCloudStatusEntry(storagePath, projectName, absPath, {
    state: "indexing",
    lastAttemptAt: new Date().toISOString(),
    error: null,
    backend: "local-claude-cli",
  });

  // docId for the local backend is "local-" + 12-char content hash. No
  // external service assigns one, so we derive a stable identifier.
  const docId = `local-${md5.slice(0, 12)}`;
  const docName = basename(absPath);
  const treeFileName = `${safeName(docName)}-${docId.slice(-12)}.json`;
  const treePath = join(projectTreesDir(storagePath, projectName), treeFileName);

  const result = await submitViaLocalClaudeCli({
    srcPath: absPath,
    srcType: fileType,
    outputPath: treePath,
    pythonPath,
    timeoutMs,
    summary: true,
    includeText: true,
  });
  if (!result.ok || !result.tree) {
    const msg = result.error ?? "local-claude-cli failed";
    updateCloudStatusEntry(storagePath, projectName, absPath, {
      state: "failed",
      error: msg,
      backend: "local-claude-cli",
    });
    appendCentralLog(`project=${projectName} path=${absPath} state=failed error=${msg}`);
    return {
      success: false,
      docId: "",
      sourcePath: absPath,
      fileType,
      treePath: "",
      cached: false,
      durationMs: Date.now() - startedAt,
      provider: "local-claude-cli",
      error: msg,
    };
  }

  // Re-wrap the OSS tree in the common shape. The runner script already
  // wrote the raw tree to treePath; we overwrite it with the normalized
  // form so getStructure() can read it uniformly.
  const normalized = normalizeOssTree(result.tree, docName);
  atomicWrite(
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

  const entry: CloudIndexEntry = {
    originalPath: absPath,
    md5,
    docId,
    treePath,
    indexedAt: new Date().toISOString(),
    converted: false,
    backend: "local-claude-cli",
  };
  const updated = { ...cloudIndex, [absPath]: entry };
  writeCloudIndex(storagePath, projectName, updated);
  updateCloudStatusEntry(storagePath, projectName, absPath, {
    state: "indexed",
    docId,
    error: null,
    backend: "local-claude-cli",
  });
  appendCentralLog(
    `project=${projectName} path=${absPath} state=indexed docId=${docId} backend=local-claude-cli`,
  );
  pageIndexLogger.info("local-claude-cli indexed", {
    project: projectName,
    path: absPath,
    docId,
    elapsedSec: result.elapsedSec ?? 0,
    nodeCount: result.nodeCount ?? 0,
  });

  return {
    success: true,
    docId,
    sourcePath: absPath,
    fileType,
    treePath,
    cached: false,
    durationMs: Date.now() - startedAt,
    provider: "local-claude-cli",
  };
}

async function indexViaLocal(args: {
  absPath: string;
  fileType: "pdf" | "md";
  storagePath: string;
  repoPath: string;
  pythonPath: string;
  timeoutMs: number;
  startedAt: number;
}): Promise<IndexResult> {
  const { absPath, fileType, storagePath, repoPath, pythonPath, timeoutMs, startedAt } = args;
  const { index } = legacyEnsureStorage(storagePath);
  const registry = legacyReadRegistry(index);
  const docId = shortHash(absPath);

  const existing = registry[docId];
  if (existing && existsSync(existing.tree_path)) {
    return {
      success: true,
      docId,
      sourcePath: existing.source_path,
      fileType: existing.file_type,
      treePath: existing.tree_path,
      cached: true,
      durationMs: Date.now() - startedAt,
      provider: "local",
    };
  }

  const docDir = join(storagePath, docId);
  ensureDir(docDir);

  const sourceCopy = join(docDir, basename(absPath));
  copyFileSync(absPath, sourceCopy);

  const flag = fileType === "pdf" ? "--pdf_path" : "--md_path";
  const result = await runLocalPageIndex(
    pythonPath,
    repoPath,
    [flag, sourceCopy],
    docDir,
    timeoutMs,
  );

  if (result.exitCode !== 0) {
    return {
      success: false,
      docId,
      sourcePath: absPath,
      fileType,
      treePath: "",
      cached: false,
      durationMs: Date.now() - startedAt,
      provider: "local",
      error: result.timedOut
        ? `PageIndex timed out after ${timeoutMs}ms`
        : `PageIndex exited ${result.exitCode}: ${result.output.slice(-2000)}`,
    };
  }

  const resultsDir = join(docDir, "results");
  const stem = basename(sourceCopy, extname(sourceCopy));
  const generatedTreePath = join(resultsDir, `${stem}_structure.json`);
  if (!existsSync(generatedTreePath)) {
    return {
      success: false,
      docId,
      sourcePath: absPath,
      fileType,
      treePath: "",
      cached: false,
      durationMs: Date.now() - startedAt,
      provider: "local",
      error: `PageIndex completed but no tree at ${generatedTreePath}`,
    };
  }

  const finalTreePath = join(docDir, "tree.json");
  copyFileSync(generatedTreePath, finalTreePath);
  registry[docId] = {
    doc_id: docId,
    source_path: absPath,
    source_basename: basename(absPath),
    file_type: fileType,
    tree_path: finalTreePath,
    source_copy_path: sourceCopy,
    indexed_at: new Date().toISOString(),
  };
  legacyWriteRegistry(index, registry);

  return {
    success: true,
    docId,
    sourcePath: absPath,
    fileType,
    treePath: finalTreePath,
    cached: false,
    durationMs: Date.now() - startedAt,
    provider: "local",
  };
}

// ---------------------------------------------------------------------------
// Disk-walk helpers (kept for backwards compat with earlier code)
// ---------------------------------------------------------------------------

export function listIndexedDocsOnDisk(storagePath = PAGEINDEX_STORAGE): string[] {
  if (!existsSync(storagePath)) return [];
  return readdirSync(storagePath).filter((entry) => {
    try {
      return statSync(join(storagePath, entry)).isDirectory();
    } catch {
      return false;
    }
  });
}

/** Exposed constants used by build-queue and tests. */
export const PAGEINDEX_PATHS = {
  STORAGE: PAGEINDEX_STORAGE,
  LOG: PAGEINDEX_LOG,
  CLOUD_SCRIPT,
  LOCAL_CLAUDE_SCRIPT,
  MD_TO_PDF_SCRIPT,
  DEFAULT_PYTHON,
  DEFAULT_LOCAL_REPO,
};

/** Exposed for the build-queue worker to avoid reimporting helpers. */
export const PAGEINDEX_HELPERS = {
  ensureDir,
  readCloudIndex,
  writeCloudIndex,
  readCloudStatus,
  writeCloudStatus,
  updateCloudStatusEntry,
  projectRoot,
  projectIndexPath,
  projectStatusPath,
  projectTreesDir,
  projectConvertedDir,
  convertMarkdownToPdf,
  submitPdfToCloud,
  submitViaLocalClaudeCli,
  normalizeCloudTree,
  normalizeOssTree,
  atomicWrite,
  appendCentralLog,
  sha256File,
  detectFileType,
  safeName,
};

