// vela index — PageIndex document indexing CLI
//
// Usage:
//   vela index <path>                          index a single file (pdf or md)
//   vela index <project-name>                  discover and index docs in a project
//   vela index <project-name> --pattern <glob> with explicit pattern (applied in the
//                                              project root)
//   vela index --list                          list indexed docs across projects
//   vela index --dry-run                       show what would be indexed
//   vela index --help                          show help
//
// Primary dispatch path:
//   - Discover candidate files (markdown + PDFs, excluding noise dirs)
//   - For each file, enqueue a "pageindex" build entry
//   - The build-queue worker actually calls the PageIndex cloud API
//
// When called with a raw file path instead of a project name, the command
// infers the project ("_adhoc" or the nearest registered ancestor) and
// enqueues a single entry.

import {
  existsSync,
  readdirSync,
  readFileSync,
  statSync,
} from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, extname, isAbsolute, join, resolve } from "node:path";

import {
  getProject,
  listProjects,
  resolvePageIndexConfig,
} from "@vela-union/shared";
import type { PageIndexProvider, ProjectConfig } from "@vela-union/shared";

import {
  bold,
  cyan,
  dim,
  fail,
  green,
  info,
  ok,
  warn,
  yellow,
} from "../util/log.js";
import type { CommandContext } from "../util/context.js";

// ---------------------------------------------------------------------------
// Help
// ---------------------------------------------------------------------------

const HELP = `
${bold(cyan("vela index"))} — Index documents with PageIndex

${bold("Usage:")}
  vela index <path>                         index a single PDF or markdown file
  vela index <project-name>                 scan a registered project
  vela index <project-name> --pattern <g>   scan with explicit glob (e.g. "docs/**/*.md")
  vela index --list                         list indexed docs across all projects
  vela index --dry-run                      print what would be indexed without doing it
  vela index --help                         show this help

${bold("Options:")}
  --pattern <glob>     Explicit glob (supports **, *, ?)
  --dry-run            Print candidate list without indexing
  --list               List currently indexed documents
  --sort <order>       Sort order for --list: newest (default) | oldest
  --project <name>     Filter --list to a specific project, or set project
                       when indexing a raw path
  --max-depth <n>      Max directory depth for .md discovery (default 3)
  --include-pdf        (default on) Include PDF files
  --no-pdf             Skip PDF files
  --no-md              Skip markdown files
  --force              Bypass idempotency (re-submit even if md5 unchanged)
  --backend <name>     When indexing: override backend (vectify-cloud |
                       local-claude-cli; default: pageindex.provider in
                       ~/.vela/config.json). When used with --list: filter
                       shown entries to that backend only.
  --failed             With --list: show failed indexing attempts from
                       status.json instead of successful entries from
                       index.json. Combines with --project and --backend.

${bold("Backends:")}
  vectify-cloud        Hosted Vectify PageIndex API (fast, needs apiKey)
  local-claude-cli     OSS PageIndex via local 'claude -p' — zero cost,
                       no apiKey, slower (~30-60s/doc due to CLI spawn)

${bold("Examples:")}
  vela index /path/to/spec.pdf
  vela index sweditor-editor
  vela index sweditor-editor --pattern "**/CLAUDE.md"
  vela index sweditor-editor --backend local-claude-cli
  vela index sweditor-editor --dry-run
  vela index --list
  vela index --list --project sweditor-editor
  vela index --list --sort oldest
  vela index --list --backend local-claude-cli
  vela index --list --failed
  vela index --list --failed --project sweditor-editor
`.trim();

// ---------------------------------------------------------------------------
// Candidate discovery
// ---------------------------------------------------------------------------

const EXCLUDE_DIRS = new Set([
  "node_modules",
  ".git",
  "dist",
  "build",
  ".venv",
  ".omc",
  ".reflexion-fusion",
  "refs",
  "out",
  ".next",
  ".turbo",
  "target",
]);

const MAX_DEPTH_DEFAULT = 3;
const MAX_SIZE_BYTES = 50 * 1024 * 1024; // Cloud cap

interface Candidate {
  path: string;
  type: "pdf" | "md";
  sizeBytes: number;
}

/**
 * Walk a directory up to `maxDepth`, collecting markdown + PDF files.
 * Excludes well-known noise directories. Hidden directories are skipped
 * unless their name is explicitly in the exclude list.
 */
function walkProject(
  root: string,
  opts: {
    maxDepth: number;
    includeMd: boolean;
    includePdf: boolean;
  },
): Candidate[] {
  const candidates: Candidate[] = [];
  const seen = new Set<string>();

  const walk = (current: string, depth: number): void => {
    if (depth > opts.maxDepth) return;
    let entries: string[];
    try {
      entries = readdirSync(current);
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.startsWith(".") && entry !== ".md") {
        // Skip dotfiles and hidden dirs except intentional ones
        continue;
      }
      if (EXCLUDE_DIRS.has(entry)) continue;
      const fullPath = join(current, entry);
      if (seen.has(fullPath)) continue;
      let stat;
      try {
        stat = statSync(fullPath);
      } catch {
        continue;
      }
      if (stat.isDirectory()) {
        walk(fullPath, depth + 1);
        continue;
      }
      if (!stat.isFile()) continue;
      const ext = extname(entry).toLowerCase();
      const isPdf = ext === ".pdf";
      const isMd = ext === ".md" || ext === ".markdown";
      if (isPdf && !opts.includePdf) continue;
      if (isMd && !opts.includeMd) continue;
      if (!isPdf && !isMd) continue;
      seen.add(fullPath);
      candidates.push({
        path: fullPath,
        type: isPdf ? "pdf" : "md",
        sizeBytes: stat.size,
      });
    }
  };

  walk(root, 0);
  return candidates;
}

/**
 * Very small glob matcher: supports **, *, ?. Used only when --pattern is set.
 * For anything more expressive, users should pre-filter externally.
 */
function globToRegExp(pattern: string): RegExp {
  // Normalize separators
  let re = "";
  let i = 0;
  while (i < pattern.length) {
    const c = pattern[i]!;
    if (c === "*") {
      if (pattern[i + 1] === "*") {
        re += ".*";
        i += 2;
        if (pattern[i] === "/") i += 1;
      } else {
        re += "[^/]*";
        i += 1;
      }
    } else if (c === "?") {
      re += "[^/]";
      i += 1;
    } else if ("+()[]{}.^$|\\".includes(c)) {
      re += `\\${c}`;
      i += 1;
    } else {
      re += c;
      i += 1;
    }
  }
  return new RegExp("^" + re + "$");
}

function filterByPattern(candidates: Candidate[], root: string, pattern: string): Candidate[] {
  const re = globToRegExp(pattern);
  return candidates.filter((c) => {
    let rel = c.path.startsWith(root + "/") ? c.path.slice(root.length + 1) : c.path;
    if (re.test(rel)) return true;
    // Also allow bare-basename matches
    return re.test(basename(rel));
  });
}

// ---------------------------------------------------------------------------
// Flag parsing
// ---------------------------------------------------------------------------

interface IndexFlags {
  list: boolean;
  dryRun: boolean;
  help: boolean;
  pattern?: string;
  maxDepth: number;
  includeMd: boolean;
  includePdf: boolean;
  force: boolean;
  project?: string;
  sort: "newest" | "oldest";
  backend?: PageIndexProvider;
  /** With --list: show failed attempts from status.json instead of successes. */
  failed: boolean;
  positional: string[];
}

function parseBackend(value: string): PageIndexProvider | undefined {
  if (value === "vectify-cloud" || value === "local-claude-cli" || value === "local") {
    return value;
  }
  warn(`unknown backend: ${value} (expected vectify-cloud or local-claude-cli)`);
  return undefined;
}

function parseFlags(argv: string[]): IndexFlags {
  const flags: IndexFlags = {
    list: false,
    dryRun: false,
    help: false,
    maxDepth: MAX_DEPTH_DEFAULT,
    includeMd: true,
    includePdf: true,
    force: false,
    sort: "newest",
    failed: false,
    positional: [],
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === undefined) continue;
    if (arg === "--help" || arg === "-h") {
      flags.help = true;
      continue;
    }
    if (arg === "--list") {
      flags.list = true;
      continue;
    }
    if (arg === "--dry-run") {
      flags.dryRun = true;
      continue;
    }
    if (arg === "--force") {
      flags.force = true;
      continue;
    }
    if (arg === "--no-md") {
      flags.includeMd = false;
      continue;
    }
    if (arg === "--no-pdf") {
      flags.includePdf = false;
      continue;
    }
    if (arg === "--include-pdf") {
      flags.includePdf = true;
      continue;
    }
    if (arg === "--pattern") {
      const next = argv[i + 1];
      if (next) {
        flags.pattern = next;
        i += 1;
      }
      continue;
    }
    if (arg.startsWith("--pattern=")) {
      flags.pattern = arg.slice("--pattern=".length);
      continue;
    }
    if (arg === "--max-depth") {
      const next = argv[i + 1];
      if (next) {
        const parsed = parseInt(next, 10);
        if (!Number.isNaN(parsed)) flags.maxDepth = parsed;
        i += 1;
      }
      continue;
    }
    if (arg.startsWith("--max-depth=")) {
      const parsed = parseInt(arg.slice("--max-depth=".length), 10);
      if (!Number.isNaN(parsed)) flags.maxDepth = parsed;
      continue;
    }
    if (arg === "--project") {
      const next = argv[i + 1];
      if (next) {
        flags.project = next;
        i += 1;
      }
      continue;
    }
    if (arg.startsWith("--project=")) {
      flags.project = arg.slice("--project=".length);
      continue;
    }
    if (arg === "--sort") {
      const next = argv[i + 1];
      if (next === "oldest" || next === "newest") {
        flags.sort = next;
        i += 1;
      } else {
        warn(`--sort must be 'newest' or 'oldest'; got '${next ?? ""}'`);
      }
      continue;
    }
    if (arg.startsWith("--sort=")) {
      const val = arg.slice("--sort=".length);
      if (val === "oldest" || val === "newest") {
        flags.sort = val;
      } else {
        warn(`--sort must be 'newest' or 'oldest'; got '${val}'`);
      }
      continue;
    }
    if (arg === "--backend") {
      const next = argv[i + 1];
      if (next) {
        flags.backend = parseBackend(next);
        i += 1;
      }
      continue;
    }
    if (arg.startsWith("--backend=")) {
      flags.backend = parseBackend(arg.slice("--backend=".length));
      continue;
    }
    if (arg === "--failed") {
      flags.failed = true;
      continue;
    }
    if (arg.startsWith("--")) {
      // Unknown flag — ignore with a warning below
      warn(`unknown flag: ${arg}`);
      continue;
    }
    flags.positional.push(arg);
  }
  return flags;
}

// ---------------------------------------------------------------------------
// Main command
// ---------------------------------------------------------------------------

function fmtBytes(size: number): string {
  if (size < 1024) return `${size}B`;
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)}K`;
  return `${(size / 1024 / 1024).toFixed(1)}M`;
}

/** Return human-readable file size for originalPath, or "? B" if unreadable. */
function getFileSizeStr(filePath: string | undefined): string {
  if (!filePath) return "? B";
  try {
    const { size } = statSync(filePath);
    return fmtBytes(size);
  } catch {
    return "? B";
  }
}

/** Count nodes in a PageIndex tree JSON file recursively. Returns null if unreadable. */
function countTreeNodes(treePath: string): number | null {
  try {
    const raw = readFileSync(treePath, "utf-8");
    const tree: unknown = JSON.parse(raw);
    return walkTreeCount(tree);
  } catch {
    return null;
  }
}

function walkTreeCount(node: unknown): number {
  if (node === null || typeof node !== "object") return 0;
  let count = 1;
  // Support common tree shapes: children, nodes, items, sections, sub_sections,
  // and PageIndex's "structure" top-level array
  for (const key of ["structure", "children", "nodes", "items", "sections", "sub_sections"]) {
    const arr = (node as Record<string, unknown>)[key];
    if (Array.isArray(arr)) {
      for (const child of arr) {
        count += walkTreeCount(child);
      }
    }
  }
  return count;
}

function resolveTargetProject(
  flags: IndexFlags,
  log: CommandContext["logger"],
): { project: ProjectConfig | null; rawPath?: string } {
  const [first] = flags.positional;
  if (!first) {
    return { project: null };
  }
  // 1. Is it a registered project name?
  const registered = getProject(first);
  if (registered) return { project: registered };

  // 2. Is it a filesystem path?
  const absCandidate = isAbsolute(first) ? first : resolve(process.cwd(), first);
  if (existsSync(absCandidate)) {
    // Try to match it to a registered project by prefix
    const match = listProjects().find((p) => absCandidate.startsWith(p.path));
    log.debug("resolveTargetProject: path mode", {
      absCandidate,
      matched: match?.name ?? null,
    });
    return { project: match ?? null, rawPath: absCandidate };
  }
  log.warn("resolveTargetProject: no match", { first });
  return { project: null };
}

async function enqueueBatch(
  entries: Array<{ originalPath: string; docPath: string }>,
  projectName: string,
  projectPath: string | undefined,
): Promise<Array<{ path: string; id: string }>> {
  const queueSpecifier = "@vela-union/mcp-gateway/dist/build-queue.js";
  const queue = (await import(queueSpecifier)) as {
    enqueue: (entry: {
      kind: "pageindex";
      projectName: string;
      originalPath: string;
      docPath: string;
      projectPath?: string;
    }) => { id: string };
    isQueued: (projectName: string, kind: "pageindex", originalPath?: string) => boolean;
  };

  const results: Array<{ path: string; id: string }> = [];
  for (const e of entries) {
    if (queue.isQueued(projectName, "pageindex", e.originalPath)) {
      results.push({ path: e.originalPath, id: "already-queued" });
      continue;
    }
    const full = queue.enqueue({
      kind: "pageindex",
      projectName,
      originalPath: e.originalPath,
      docPath: e.docPath,
      ...(projectPath ? { projectPath } : {}),
    });
    results.push({ path: e.originalPath, id: full.id });
  }
  return results;
}

interface IndexRecord {
  docId: string;
  indexedAt: string;
  md5: string;
  originalPath?: string;
  treePath?: string;
  converted?: boolean;
  convertedPdfPath?: string;
  /**
   * Backend that produced this entry (VELA-25). Optional for BC with
   * pre-VELA-25 records — readers should treat missing as unknown.
   */
  backend?: "vectify-cloud" | "local-claude-cli";
}

/** Per-doc lifecycle state from ~/.vela/pageindex/<project>/status.json */
interface StatusDocEntry {
  docId: string | null;
  state: "pending" | "indexing" | "indexed" | "failed";
  lastAttemptAt: string | null;
  error: string | null;
  backend?: "vectify-cloud" | "local-claude-cli";
}

interface StatusFile {
  projectName: string;
  updatedAt: string;
  docs: Record<string, StatusDocEntry>;
}

/**
 * Resolve the project directory list for --list, applying --project filter
 * with an early exit+error on unknown project name. Shared between the
 * success-list (index.json) and failure-list (status.json) paths.
 */
function resolveListProjects(storage: string, flags: IndexFlags): string[] | null {
  let projects = readdirSync(storage).filter((entry) => {
    try {
      return statSync(join(storage, entry)).isDirectory();
    } catch {
      return false;
    }
  });
  if (flags.project) {
    if (!projects.includes(flags.project)) {
      fail(`project '${flags.project}' not found in pageindex storage`);
      return null;
    }
    projects = [flags.project];
  }
  return projects;
}

/**
 * --list default path: read each project's index.json, apply --backend
 * filter if set, sort by indexedAt, render with size + node-count decoration.
 */
function printListSuccesses(ctx: CommandContext, flags: IndexFlags): number {
  const log = ctx.logger;
  log.info("list indexed docs", { backend: flags.backend ?? null });
  const storage = join(homedir(), ".vela", "pageindex");
  if (!existsSync(storage)) {
    info("no pageindex storage yet. run 'vela index <project>' to start.");
    return 0;
  }
  const projects = resolveListProjects(storage, flags);
  if (projects === null) return 1;
  if (projects.length === 0) {
    info("no projects indexed yet.");
    return 0;
  }
  let total = 0;
  let shownProjects = 0;
  for (const project of projects) {
    const indexPath = join(storage, project, "index.json");
    if (!existsSync(indexPath)) continue;
    let map: Record<string, IndexRecord> = {};
    try {
      map = JSON.parse(readFileSync(indexPath, "utf-8"));
    } catch {
      continue;
    }
    let entries = Object.entries(map);
    // --backend filter: records without a backend field (pre-VELA-25) are
    // excluded from explicit filters because we can't know what they were.
    if (flags.backend) {
      entries = entries.filter(([, r]) => r.backend === flags.backend);
    }
    // Sort by indexedAt (newest first by default, oldest with --sort oldest)
    entries.sort(([, a], [, b]) => {
      const ta = new Date(a.indexedAt).getTime();
      const tb = new Date(b.indexedAt).getTime();
      return flags.sort === "oldest" ? ta - tb : tb - ta;
    });
    if (entries.length === 0) continue;
    shownProjects += 1;
    console.log(`\n${bold(cyan(project))} ${dim(`(${entries.length} docs)`)}`);
    for (const [path, record] of entries) {
      total += 1;
      const sizeStr = getFileSizeStr(record.originalPath ?? path);
      const nodeCount = record.treePath ? countTreeNodes(record.treePath) : null;
      const nodeStr = nodeCount !== null ? `${nodeCount} nodes` : "? nodes";
      const backendTag = record.backend ?? "?";
      console.log(`  ${green("\u2713")} ${path}`);
      console.log(
        `    ${dim(`doc_id=${record.docId}  at=${record.indexedAt}  backend=${backendTag}  size=${sizeStr}  ${nodeStr}`)}`,
      );
    }
  }
  if (total === 0) {
    const scope = flags.backend
      ? `for backend=${flags.backend}`
      : flags.project
        ? `in project '${flags.project}'`
        : "";
    info(`no indexed documents${scope ? ` ${scope}` : ""}.`);
  } else {
    console.log();
    info(`total: ${total} document(s) across ${shownProjects} project(s)`);
  }
  return 0;
}

/**
 * --list --failed path: read each project's status.json, filter entries
 * where state === "failed", apply --backend filter, render with error.
 * status.json lives alongside index.json at ~/.vela/pageindex/<project>/
 * and tracks per-doc lifecycle state (including failures).
 */
function printListFailures(ctx: CommandContext, flags: IndexFlags): number {
  const log = ctx.logger;
  log.info("list failed docs", { backend: flags.backend ?? null });
  const storage = join(homedir(), ".vela", "pageindex");
  if (!existsSync(storage)) {
    info("no pageindex storage yet. run 'vela index <project>' to start.");
    return 0;
  }
  const projects = resolveListProjects(storage, flags);
  if (projects === null) return 1;
  if (projects.length === 0) {
    info("no projects indexed yet.");
    return 0;
  }
  let total = 0;
  let shownProjects = 0;
  for (const project of projects) {
    const statusPath = join(storage, project, "status.json");
    if (!existsSync(statusPath)) continue;
    let status: StatusFile;
    try {
      status = JSON.parse(readFileSync(statusPath, "utf-8"));
    } catch {
      continue;
    }
    let entries = Object.entries(status.docs ?? {}).filter(
      ([, doc]) => doc.state === "failed",
    );
    if (flags.backend) {
      entries = entries.filter(([, doc]) => doc.backend === flags.backend);
    }
    // Newest-failure-first by lastAttemptAt (sort flag still respected).
    entries.sort(([, a], [, b]) => {
      const ta = a.lastAttemptAt ? new Date(a.lastAttemptAt).getTime() : 0;
      const tb = b.lastAttemptAt ? new Date(b.lastAttemptAt).getTime() : 0;
      return flags.sort === "oldest" ? ta - tb : tb - ta;
    });
    if (entries.length === 0) continue;
    shownProjects += 1;
    console.log(
      `\n${bold(cyan(project))} ${dim(`(${entries.length} failed)`)}`,
    );
    for (const [path, doc] of entries) {
      total += 1;
      const ts = doc.lastAttemptAt ?? "?";
      const backendTag = doc.backend ?? "?";
      const errOneLine = (doc.error ?? "unknown error")
        .replace(/\s+/g, " ")
        .slice(0, 180);
      console.log(`  ${yellow("\u2717")} ${path}`);
      console.log(
        `    ${dim(`at=${ts}  backend=${backendTag}  error=${errOneLine}`)}`,
      );
    }
  }
  if (total === 0) {
    const scope = flags.backend
      ? `for backend=${flags.backend}`
      : flags.project
        ? `in project '${flags.project}'`
        : "";
    info(`no failed documents${scope ? ` ${scope}` : ""}.`);
  } else {
    console.log();
    info(`total: ${total} failed document(s) across ${shownProjects} project(s)`);
  }
  return 0;
}

function printList(ctx: CommandContext, flags: IndexFlags): number {
  return flags.failed ? printListFailures(ctx, flags) : printListSuccesses(ctx, flags);
}

export async function runIndex(ctx: CommandContext): Promise<number> {
  const log = ctx.logger;
  const flags = parseFlags(ctx.argv);
  log.info("index start", {
    positional: flags.positional,
    dryRun: flags.dryRun,
    pattern: flags.pattern ?? null,
    list: flags.list,
  });

  if (flags.help) {
    console.log(HELP);
    return 0;
  }

  if (flags.list) {
    return printList(ctx, flags);
  }

  if (flags.positional.length === 0) {
    fail("missing argument");
    console.log(HELP);
    return 1;
  }

  // Config + availability check. The background worker always reads its
  // backend from ~/.vela/config.json (it's a daemon started by `vela start`),
  // so --backend here is only a guard — if it disagrees with the persisted
  // provider we warn but proceed, since the enqueued entry will still be
  // picked up by the worker under whatever backend is active.
  const cfg = resolvePageIndexConfig();
  const effectiveBackend: PageIndexProvider =
    flags.backend ?? cfg.provider ?? "vectify-cloud";

  if (flags.backend && flags.backend !== cfg.provider) {
    warn(
      `--backend=${flags.backend} differs from persisted pageindex.provider=${cfg.provider ?? "local"}. ` +
        `The background worker reads its backend from ~/.vela/config.json — ` +
        `edit that file and restart 'vela start' to actually switch backends.`,
    );
  }

  if (effectiveBackend === "vectify-cloud" && !cfg.apiKey) {
    fail("pageindex.apiKey missing in ~/.vela/config.json");
    return 1;
  }
  if (effectiveBackend !== "vectify-cloud" && effectiveBackend !== "local-claude-cli") {
    warn(
      `pageindex backend is "${effectiveBackend}" — ` +
        `worker supports vectify-cloud or local-claude-cli. ` +
        `Set pageindex.provider in ~/.vela/config.json`,
    );
  }
  if (effectiveBackend === "local-claude-cli") {
    info(`backend: local-claude-cli ${dim("(zero-cost, ~30-60s per doc)")}`);
  }

  const resolved = resolveTargetProject(flags, log);
  const target = flags.positional[0]!;

  // -----------------------------------------------------------------------
  // Branch A: single raw file path
  // -----------------------------------------------------------------------
  if (resolved.rawPath) {
    const filePath = resolved.rawPath;
    let stat;
    try {
      stat = statSync(filePath);
    } catch (err) {
      fail(`cannot stat ${filePath}: ${(err as Error).message}`);
      return 1;
    }
    if (!stat.isFile()) {
      // The path exists and is a directory — fall through to project scan
      // only if --project is set; otherwise treat it as the implicit project root.
      if (stat.isDirectory()) {
        return scanAndIndexProject({
          ctx,
          log,
          flags,
          projectName: flags.project ?? basename(filePath),
          projectPath: filePath,
          projectConfig: resolved.project ?? null,
        });
      }
      fail(`not a file or directory: ${filePath}`);
      return 1;
    }

    const ext = extname(filePath).toLowerCase();
    if (ext !== ".pdf" && ext !== ".md" && ext !== ".markdown") {
      fail(`unsupported file type: ${ext || "(none)"}`);
      return 1;
    }
    if (stat.size > MAX_SIZE_BYTES) {
      fail(`file too large: ${fmtBytes(stat.size)} (max ${fmtBytes(MAX_SIZE_BYTES)})`);
      return 1;
    }

    const projectName =
      flags.project ?? resolved.project?.name ?? basename(dirname(filePath));
    const projectPath = resolved.project?.path;

    if (flags.dryRun) {
      console.log(`${bold("Dry run")} — would index 1 file:`);
      console.log(`  ${green("+")} ${filePath} ${dim(`(${ext.slice(1)}, ${fmtBytes(stat.size)})`)}`);
      console.log(`  project: ${projectName}`);
      return 0;
    }

    const results = await enqueueBatch(
      [{ originalPath: filePath, docPath: filePath }],
      projectName,
      projectPath,
    );
    for (const r of results) {
      if (r.id === "already-queued") {
        info(`already queued: ${r.path}`);
      } else {
        ok(`enqueued: ${r.path} ${dim(`(id=${r.id.slice(0, 8)})`)}`);
      }
    }
    info(`run 'vela index --list' after a minute to see results`);
    return 0;
  }

  // -----------------------------------------------------------------------
  // Branch B: registered project name
  // -----------------------------------------------------------------------
  if (resolved.project) {
    return scanAndIndexProject({
      ctx,
      log,
      flags,
      projectName: resolved.project.name,
      projectPath: resolved.project.path,
      projectConfig: resolved.project,
    });
  }

  fail(`not a file path and not a registered project: ${target}`);
  info(`try 'vela list' to see registered projects, or pass an absolute path`);
  return 1;
}

async function scanAndIndexProject(args: {
  ctx: CommandContext;
  log: CommandContext["logger"];
  flags: IndexFlags;
  projectName: string;
  projectPath: string;
  projectConfig: ProjectConfig | null;
}): Promise<number> {
  const { flags, projectName, projectPath } = args;
  if (!existsSync(projectPath)) {
    fail(`project path missing: ${projectPath}`);
    return 1;
  }
  const candidates = walkProject(projectPath, {
    maxDepth: flags.maxDepth,
    includeMd: flags.includeMd,
    includePdf: flags.includePdf,
  });
  let filtered = candidates;
  if (flags.pattern) {
    filtered = filterByPattern(candidates, projectPath, flags.pattern);
  }
  // Enforce size cap at discovery time
  const tooBig = filtered.filter((c) => c.sizeBytes > MAX_SIZE_BYTES);
  filtered = filtered.filter((c) => c.sizeBytes <= MAX_SIZE_BYTES);

  console.log(
    `\n${bold("Project:")} ${projectName} ${dim(`(${projectPath})`)}` +
      (flags.pattern ? ` ${dim(`pattern=${flags.pattern}`)}` : ""),
  );

  if (filtered.length === 0) {
    warn(`no candidate .md/.pdf files found in ${projectPath}`);
    if (tooBig.length > 0) {
      console.log(yellow(`  ${tooBig.length} file(s) skipped (over ${fmtBytes(MAX_SIZE_BYTES)}):`));
      for (const t of tooBig) {
        console.log(`    ${yellow("!")} ${t.path} ${dim(`(${fmtBytes(t.sizeBytes)})`)}`);
      }
    }
    return 0;
  }

  console.log(
    `${bold(`${filtered.length}`)} candidate(s)` +
      (tooBig.length > 0 ? dim(` — ${tooBig.length} skipped (size)`) : ""),
  );
  for (const c of filtered) {
    console.log(
      `  ${dim("+")} ${c.path} ${dim(`(${c.type}, ${fmtBytes(c.sizeBytes)})`)}`,
    );
  }
  for (const t of tooBig) {
    console.log(`  ${yellow("!")} ${t.path} ${dim(`(${fmtBytes(t.sizeBytes)}, too big)`)}`);
  }

  if (flags.dryRun) {
    console.log();
    info(`dry run — no entries enqueued`);
    return 0;
  }

  const results = await enqueueBatch(
    filtered.map((c) => ({ originalPath: c.path, docPath: c.path })),
    projectName,
    projectPath,
  );
  const newCount = results.filter((r) => r.id !== "already-queued").length;
  const dupCount = results.length - newCount;
  console.log();
  ok(`enqueued ${newCount} entries` + (dupCount > 0 ? ` ${dim(`(${dupCount} already queued)`)}` : ""));
  info(`worker runs in background. check 'vela index --list' after ~1-2 min.`);
  return 0;
}
