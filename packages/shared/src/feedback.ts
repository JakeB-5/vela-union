// Vela Union — Phase 5 feedback loop
//
// Closes the cycle from execution back into knowledge:
//   - recordDecisions          persist a decision log per goal
//   - extractDecisionsFromOutput
//                              cheap heuristic regex over Claude Code output
//   - findCrossProjectImplications
//                              flag touched files referenced by other registered
//                              projects (READMEs / CLAUDE.md / briefing docs)
//   - triggerGraphRefresh      fire-and-forget call into the MCP gateway for
//                              graph.refresh on the target project
//
// Storage layout under ~/.vela/decisions/:
//   ~/.vela/decisions/{projectName}/{goalId}.md       per-goal decision file
//   ~/.vela/decisions/{projectName}/log.md            project-level append log
//
// Everything in this module is intentionally side-effect-isolated and
// synchronous where possible — graph refresh is the one exception and is
// always spawned detached so it cannot block the caller.

import {
  copyFileSync,
  existsSync,
  mkdirSync,
  appendFileSync,
  writeFileSync,
  readFileSync,
  readdirSync,
  statSync,
  unlinkSync,
} from "node:fs";
import { dirname, extname, join } from "node:path";
import { homedir } from "node:os";
import { spawn, execSync } from "node:child_process";
import { listProjects, getProject } from "./registry.js";
import type { ProjectConfig } from "./index.js";

const DECISIONS_ROOT = join(homedir(), ".vela", "decisions");

const PGLITE_BOOTSTRAP_FILES = new Set([
  "PG_VERSION",
  "pg_hba.conf",
  "pg_ident.conf",
  "postgresql.conf",
  "postgresql.auto.conf",
  "postmaster.pid",
]);

function getPgliteNewestMtime(dirPath: string): string | null {
  try {
    const entries = readdirSync(dirPath);
    let newest: Date | null = null;
    for (const entry of entries) {
      if (PGLITE_BOOTSTRAP_FILES.has(entry)) continue;
      try {
        const st = statSync(join(dirPath, entry));
        if (!newest || st.mtime > newest) newest = st.mtime;
      } catch { /* skip unreadable entries */ }
    }
    return newest ? newest.toISOString() : null;
  } catch {
    return null;
  }
}

/** A single decision parsed from execution output. */
export interface DecisionEntry {
  text: string;
  /** Trigger keyword that matched (e.g. "decided", "rejected"). */
  trigger: string;
}

/** Result of a recordDecisions() call. */
export interface RecordDecisionsResult {
  filePath: string;
  logPath: string;
  count: number;
}

/** Result of cross-project implication scanning. */
export interface CrossProjectImplication {
  projectName: string;
  projectPath: string;
  /** The touched files that appeared in this project's docs. */
  matchedFiles: string[];
  /** Human-readable list of doc files where the match was found. */
  matchedIn: string[];
}

function ensureProjectDir(projectName: string): string {
  const dir = join(DECISIONS_ROOT, projectName);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
  return dir;
}

function isoNow(): string {
  return new Date().toISOString();
}

/**
 * Persist a list of decisions for a goal under
 * ~/.vela/decisions/{projectName}/{goalId}.md and append a one-line summary to
 * ~/.vela/decisions/{projectName}/log.md.
 *
 * Always returns the file paths even when the decisions array is empty — the
 * empty file is still written so callers can verify the goal was processed.
 */
export function recordDecisions(
  goalId: string,
  projectName: string,
  decisions: DecisionEntry[],
  meta?: { goalDescription?: string; summary?: string },
): RecordDecisionsResult {
  const dir = ensureProjectDir(projectName);
  const filePath = join(dir, `${goalId}.md`);
  const logPath = join(dir, "log.md");
  const ts = isoNow();

  const lines: string[] = [];
  lines.push(`# Decisions — ${goalId}`);
  lines.push("");
  lines.push(`- Project: ${projectName}`);
  lines.push(`- Recorded: ${ts}`);
  if (meta?.goalDescription) {
    lines.push(`- Goal: ${meta.goalDescription}`);
  }
  if (meta?.summary) {
    lines.push(`- Summary: ${meta.summary}`);
  }
  lines.push("");
  if (decisions.length === 0) {
    lines.push("_No decisions extracted from execution output._");
  } else {
    lines.push(`## Decisions (${decisions.length})`);
    lines.push("");
    for (const d of decisions) {
      lines.push(`- **[${d.trigger}]** ${d.text}`);
    }
  }
  lines.push("");
  writeFileSync(filePath, lines.join("\n"), "utf-8");

  // Append a single-line entry to the project log.
  const shortGoal = meta?.goalDescription
    ? meta.goalDescription.replace(/\s+/g, " ").slice(0, 80)
    : "(no description)";
  const logLine = `- ${ts} — ${goalId.slice(0, 8)} — ${decisions.length} decision(s) — ${shortGoal}\n`;
  if (!existsSync(logPath)) {
    writeFileSync(
      logPath,
      `# Decision Log — ${projectName}\n\n${logLine}`,
      "utf-8",
    );
  } else {
    appendFileSync(logPath, logLine, "utf-8");
  }

  return { filePath, logPath, count: decisions.length };
}

// Heuristic patterns for decision extraction. These are intentionally cheap —
// the goal is to surface candidates for human review, not to be exhaustive.
const DECISION_PATTERNS: Array<{ trigger: string; regex: RegExp }> = [
  { trigger: "decided", regex: /\bI\s+(?:decided|chose|opted)\s+to\s+([^.\n]{4,200})/gi },
  { trigger: "decided", regex: /\b(?:Decided|Chose|Opted):\s*([^.\n]{4,200})/g },
  { trigger: "rejected", regex: /\b(?:rejected|discarded|ruled\s+out)\s+([^.\n]{4,200})/gi },
  { trigger: "preferred", regex: /\b(?:preferred|favoured|favored)\s+([^.\n]{4,200})/gi },
  { trigger: "assumption", regex: /\b(?:assuming|assumption(?:\s+is)?)\s+([^.\n]{4,200})/gi },
  { trigger: "tradeoff", regex: /\btrade-?off:\s*([^.\n]{4,200})/gi },
];

/**
 * Heuristic decision extraction from raw Claude Code output. Walks a small
 * set of regex patterns and returns matches deduplicated by trimmed text.
 * Best-effort — designed to surface candidates, not produce a perfect list.
 */
export function extractDecisionsFromOutput(output: string): DecisionEntry[] {
  if (!output || typeof output !== "string") return [];
  const seen = new Set<string>();
  const entries: DecisionEntry[] = [];

  for (const { trigger, regex } of DECISION_PATTERNS) {
    // Reset stateful regex flag.
    regex.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = regex.exec(output)) !== null) {
      const raw = (m[1] ?? "").trim().replace(/\s+/g, " ");
      if (raw.length < 4) continue;
      const key = `${trigger}::${raw.toLowerCase()}`;
      if (seen.has(key)) continue;
      seen.add(key);
      entries.push({ trigger, text: raw });
      if (entries.length >= 50) return entries; // hard cap
    }
  }
  return entries;
}

/**
 * Cheap doc-scan: for every other registered project that lists `projectName`
 * as a related project, read its README.md / CLAUDE.md and check whether any
 * of `touchedFiles` (basename or path tail) appear textually. Returns one
 * implication entry per related project that has at least one match.
 *
 * No parsing — pure substring search. Designed to be fast (<100ms) even for
 * a dozen projects with multi-MB doc files.
 */
export function findCrossProjectImplications(
  projectName: string,
  touchedFiles: string[],
): CrossProjectImplication[] {
  if (touchedFiles.length === 0) return [];
  const self = getProject(projectName);
  if (!self) return [];
  const candidates = listProjects().filter((p) => {
    if (p.name === projectName) return false;
    // Either the other project lists us as related, or we list it as related.
    return (
      (p.relatedProjects ?? []).includes(projectName) ||
      (self.relatedProjects ?? []).includes(p.name)
    );
  });
  if (candidates.length === 0) return [];

  const needles = uniqueNeedles(touchedFiles);
  const out: CrossProjectImplication[] = [];

  for (const candidate of candidates) {
    const docs = collectDocPaths(candidate);
    const matchedFiles = new Set<string>();
    const matchedIn = new Set<string>();
    for (const docPath of docs) {
      const text = safeRead(docPath);
      if (!text) continue;
      for (const { needle, original } of needles) {
        if (text.includes(needle)) {
          matchedFiles.add(original);
          matchedIn.add(docPath);
        }
      }
    }
    if (matchedFiles.size > 0) {
      out.push({
        projectName: candidate.name,
        projectPath: candidate.path,
        matchedFiles: [...matchedFiles],
        matchedIn: [...matchedIn],
      });
    }
  }
  return out;
}

function uniqueNeedles(
  files: string[],
): Array<{ needle: string; original: string }> {
  const seen = new Set<string>();
  const out: Array<{ needle: string; original: string }> = [];
  for (const f of files) {
    if (!f) continue;
    // Use the basename + the trailing path segment as needles. We avoid the
    // full absolute path since other projects almost certainly won't reference
    // a path under another project's directory verbatim.
    const parts = f.split("/").filter(Boolean);
    const tail2 = parts.slice(-2).join("/");
    const tail1 = parts[parts.length - 1] ?? "";
    for (const candidate of [tail2, tail1]) {
      if (!candidate || candidate.length < 3) continue;
      if (seen.has(candidate)) continue;
      seen.add(candidate);
      out.push({ needle: candidate, original: f });
    }
  }
  return out;
}

function collectDocPaths(project: ProjectConfig): string[] {
  const docs: string[] = [];
  const candidates = [
    join(project.path, "README.md"),
    join(project.path, "CLAUDE.md"),
    join(project.path, "AGENTS.md"),
    join(project.path, ".vela", "briefing.md"),
    join(project.path, ".vela", "briefing.json"),
    join(project.path, "docs"),
  ];
  for (const c of candidates) {
    if (!existsSync(c)) continue;
    try {
      const st = statSync(c);
      if (st.isFile()) {
        docs.push(c);
      } else if (st.isDirectory()) {
        // Shallow scan one level for *.md files only.
        for (const entry of readdirSync(c)) {
          if (!entry.endsWith(".md")) continue;
          const full = join(c, entry);
          try {
            if (statSync(full).isFile()) docs.push(full);
          } catch {
            /* ignore */
          }
        }
      }
    } catch {
      /* ignore */
    }
  }
  return docs;
}

function safeRead(path: string): string | null {
  try {
    return readFileSync(path, "utf-8");
  } catch {
    return null;
  }
}

/**
 * Fire-and-forget MCP gateway invocation: spawns the gateway as a stdio
 * subprocess, sends a `tools/call` for `graph.refresh`, then detaches.
 *
 * Returns immediately — the caller must NOT await the actual refresh. If the
 * gateway is missing, busy, or slow, the failure stays inside the detached
 * subprocess and is logged to stderr only.
 */
export function triggerGraphRefresh(
  projectName: string,
  projectPath: string,
  options?: { gatewayPath?: string },
): { spawned: boolean; pid: number | null; reason?: string } {
  const gatewayPath =
    options?.gatewayPath ??
    "/Users/jin/projects/vela-union/packages/mcp-gateway/dist/server.js";

  if (!existsSync(gatewayPath)) {
    return {
      spawned: false,
      pid: null,
      reason: `gateway not found at ${gatewayPath}`,
    };
  }

  try {
    const proc = spawn("node", [gatewayPath], {
      stdio: ["pipe", "ignore", "pipe"],
      detached: true,
      env: { ...process.env },
    });

    // Hard timeout: kill the detached refresh after 60s if it's still running.
    const killTimer = setTimeout(() => {
      try {
        proc.kill("SIGTERM");
      } catch {
        /* ignore */
      }
    }, 60_000);
    killTimer.unref?.();

    proc.on("error", (err) => {
      process.stderr.write(
        `[feedback] graph.refresh spawn error for ${projectName}: ${err.message}\n`,
      );
    });

    // Minimal MCP handshake + tools/call. We don't await responses — the goal
    // is to nudge the gateway, not to verify completion.
    const initReq = JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2024-11-05",
        capabilities: {},
        clientInfo: { name: "vela-feedback", version: "0.1.0" },
      },
    });
    const initNote = JSON.stringify({
      jsonrpc: "2.0",
      method: "notifications/initialized",
      params: {},
    });
    const callReq = JSON.stringify({
      jsonrpc: "2.0",
      id: 2,
      method: "tools/call",
      params: {
        name: "graph.refresh",
        arguments: { projectName, projectPath },
      },
    });

    try {
      proc.stdin.write(initReq + "\n");
      proc.stdin.write(initNote + "\n");
      proc.stdin.write(callReq + "\n");
      proc.stdin.end();
    } catch (err) {
      process.stderr.write(
        `[feedback] failed to write to gateway stdin: ${(err as Error).message}\n`,
      );
    }

    // Detach so the parent can exit independently.
    proc.unref();
    return { spawned: true, pid: proc.pid ?? null };
  } catch (err) {
    return {
      spawned: false,
      pid: null,
      reason: (err as Error).message,
    };
  }
}

/** Read a previously-recorded decision file by goal id. */
export function readDecisions(
  projectName: string,
  goalId: string,
): string | null {
  const filePath = join(DECISIONS_ROOT, projectName, `${goalId}.md`);
  return safeRead(filePath);
}

/** List every decision file recorded for a project. */
export function listDecisionFiles(projectName: string): string[] {
  const dir = join(DECISIONS_ROOT, projectName);
  if (!existsSync(dir)) return [];
  try {
    return readdirSync(dir)
      .filter((f) => f.endsWith(".md") && f !== "log.md")
      .map((f) => join(dir, f))
      .sort();
  } catch {
    return [];
  }
}

export const DECISIONS_DIR = DECISIONS_ROOT;

// ---------------------------------------------------------------------------
// VELA-37: gbrain sync + embed (fire-and-forget)
// ---------------------------------------------------------------------------

/**
 * Fire-and-forget gbrain sync + embed after goal execution.
 * Follows the same detached-subprocess pattern as triggerGraphRefresh.
 * Only meaningful when goal execution modified files (check touchedFiles.length).
 */
export function triggerGbrainSync(
  projectName: string,
  projectPath: string,
): { spawned: boolean; pid: number | null; reason?: string } {
  try {
    const proc = spawn(
      "sh",
      ["-c", `gbrain sync --repo "${projectPath}" && gbrain embed --stale`],
      {
        stdio: ["ignore", "ignore", "pipe"],
        detached: true,
        env: { ...process.env },
      },
    );

    const killTimer = setTimeout(() => {
      try {
        proc.kill("SIGTERM");
      } catch {
        /* ignore */
      }
    }, 120_000);
    killTimer.unref?.();

    proc.on("error", (err) => {
      process.stderr.write(
        `[feedback] gbrain sync error for ${projectName}: ${err.message}\n`,
      );
    });

    proc.unref();
    return { spawned: true, pid: proc.pid ?? null };
  } catch (err) {
    return {
      spawned: false,
      pid: null,
      reason: (err as Error).message,
    };
  }
}

// ---------------------------------------------------------------------------
// VELA-38: PageIndex auto-index new documents (fire-and-forget)
// ---------------------------------------------------------------------------

const PAGEINDEX_ROOT = join(homedir(), ".vela", "pageindex");

function pageIndexStatusPath(projectName: string): string {
  return join(PAGEINDEX_ROOT, projectName, "status.json");
}

function readPageIndexStatus(projectName: string): Record<string, string> {
  const p = pageIndexStatusPath(projectName);
  try {
    return JSON.parse(readFileSync(p, "utf-8")) as Record<string, string>;
  } catch {
    return {};
  }
}

function writePageIndexStatus(
  projectName: string,
  status: Record<string, string>,
): void {
  const p = pageIndexStatusPath(projectName);
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, JSON.stringify(status, null, 2), "utf-8");
}

/** Recursively scan for .pdf, .md, .markdown files up to depth 6. */
function scanDocFiles(projectPath: string): string[] {
  const results: string[] = [];
  const SKIP_DIRS = new Set(["node_modules", ".git", "dist", ".venv"]);

  function walk(dir: string, depth: number): void {
    if (depth > 6) return;
    try {
      for (const entry of readdirSync(dir)) {
        if (entry.startsWith(".") || SKIP_DIRS.has(entry)) continue;
        const full = join(dir, entry);
        try {
          const st = statSync(full);
          if (st.isDirectory()) {
            walk(full, depth + 1);
          } else if (st.isFile()) {
            const ext = extname(entry).toLowerCase();
            if (ext === ".pdf" || ext === ".md" || ext === ".markdown") {
              results.push(full);
            }
          }
        } catch {
          /* ignore */
        }
      }
    } catch {
      /* ignore */
    }
  }

  walk(projectPath, 0);
  return results;
}

/**
 * Fire-and-forget PageIndex sync: scans `projectPath` for unindexed PDF/markdown
 * files and triggers `doc.index` via the MCP gateway for each one.
 *
 * Tracks indexed files in ~/.vela/pageindex/<projectName>/status.json to avoid
 * re-indexing. Newly discovered files are marked "pending" immediately.
 */
export function triggerPageIndexSync(
  projectName: string,
  projectPath: string,
  options?: { gatewayPath?: string },
): { spawned: boolean; queued: number; reason?: string } {
  const gatewayPath =
    options?.gatewayPath ??
    "/Users/jin/projects/vela-union/packages/mcp-gateway/dist/server.js";

  if (!existsSync(gatewayPath)) {
    return {
      spawned: false,
      queued: 0,
      reason: `gateway not found at ${gatewayPath}`,
    };
  }

  const allFiles = scanDocFiles(projectPath);
  const status = readPageIndexStatus(projectName);
  const toIndex = allFiles.filter((f) => !status[f]);

  if (toIndex.length === 0) {
    return { spawned: false, queued: 0, reason: "all documents already indexed" };
  }

  try {
    const proc = spawn("node", [gatewayPath], {
      stdio: ["pipe", "ignore", "pipe"],
      detached: true,
      env: { ...process.env },
    });

    const killTimer = setTimeout(() => {
      try {
        proc.kill("SIGTERM");
      } catch {
        /* ignore */
      }
    }, 300_000);
    killTimer.unref?.();

    proc.on("error", (err) => {
      process.stderr.write(
        `[feedback] pageindex sync error for ${projectName}: ${err.message}\n`,
      );
    });

    const initReq = JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2024-11-05",
        capabilities: {},
        clientInfo: { name: "vela-feedback", version: "0.1.0" },
      },
    });
    const initNote = JSON.stringify({
      jsonrpc: "2.0",
      method: "notifications/initialized",
      params: {},
    });

    try {
      proc.stdin.write(initReq + "\n");
      proc.stdin.write(initNote + "\n");
      toIndex.forEach((filePath, i) => {
        const callReq = JSON.stringify({
          jsonrpc: "2.0",
          id: i + 2,
          method: "tools/call",
          params: {
            name: "doc.index",
            arguments: { path: filePath, projectName },
          },
        });
        proc.stdin.write(callReq + "\n");
      });
      proc.stdin.end();
    } catch (err) {
      process.stderr.write(
        `[feedback] failed to write to gateway stdin: ${(err as Error).message}\n`,
      );
    }

    // Mark files as pending to prevent duplicate indexing on next run.
    const newStatus = { ...status };
    for (const f of toIndex) {
      newStatus[f] = "pending";
    }
    try {
      writePageIndexStatus(projectName, newStatus);
    } catch {
      /* ignore — fire-and-forget */
    }

    proc.unref();
    return { spawned: true, queued: toIndex.length };
  } catch (err) {
    return {
      spawned: false,
      queued: 0,
      reason: (err as Error).message,
    };
  }
}

// ---------------------------------------------------------------------------
// VELA-44: Graphify bootstrap on project registration (fire-and-forget)
// ---------------------------------------------------------------------------

/**
 * Run `graphify_build.py` for a newly registered project if graph.json does not yet exist.
 * Skips silently if the output already exists or the build toolchain is missing.
 */
export function triggerGraphifyBootstrap(
  projectName: string,
  projectPath: string,
  options?: { force?: boolean },
): { spawned: boolean; pid: number | null; reason?: string } {
  const outputDir = join(homedir(), ".vela", "graphify", projectName);
  const graphJson = join(outputDir, "graph.json");
  const graphHtml = join(outputDir, "graph.html");

  if (options?.force) {
    try { if (existsSync(graphJson)) unlinkSync(graphJson); } catch { /* ignore */ }
    try { if (existsSync(graphHtml)) unlinkSync(graphHtml); } catch { /* ignore */ }
    const statusJson = join(outputDir, "status.json");
    try { if (existsSync(statusJson)) unlinkSync(statusJson); } catch { /* ignore */ }
  } else if (existsSync(graphJson)) {
    // VELA-56: even when skipping the build, copy graph.html to plugin dir if
    // it exists but hasn't been synced yet.
    const repoRoot = "/Users/jin/projects/vela-union";
    const pluginGraphsDir = join(repoRoot, "packages", "paperclip-plugin", "dist", "ui", "graphs");
    if (existsSync(graphHtml)) {
      try {
        mkdirSync(pluginGraphsDir, { recursive: true });
        copyFileSync(graphHtml, join(pluginGraphsDir, `${projectName}.html`));
        const entries = readdirSync(pluginGraphsDir)
          .filter((f: string) => f.endsWith(".html"))
          .map((f: string) => f.replace(/\.html$/, ""))
          .sort();
        writeFileSync(join(pluginGraphsDir, "manifest.json"), JSON.stringify(entries), "utf-8");
      } catch {
        // best-effort copy
      }
    }
    return { spawned: false, pid: null, reason: "graph.json already exists, skipping bootstrap" };
  }

  const repoRoot = "/Users/jin/projects/vela-union";
  const python = join(repoRoot, ".venv", "bin", "python3");
  const script = join(repoRoot, "scripts", "graphify_build.py");
  const pluginGraphsDir = join(repoRoot, "packages", "paperclip-plugin", "dist", "ui", "graphs");

  if (!existsSync(python) || !existsSync(script)) {
    return { spawned: false, pid: null, reason: "graphify build script or python venv not found" };
  }

  try {
    const proc = spawn(python, [script, projectPath, outputDir, pluginGraphsDir], {
      stdio: ["ignore", "ignore", "pipe"],
      detached: true,
      env: { ...process.env, PYTHONPATH: join(repoRoot, "refs", "graphify") },
    });

    const killTimer = setTimeout(() => {
      try {
        proc.kill("SIGTERM");
      } catch {
        /* ignore */
      }
    }, 300_000);
    killTimer.unref?.();

    proc.on("error", (err) => {
      process.stderr.write(
        `[feedback] graphify bootstrap error for ${projectName}: ${err.message}\n`,
      );
    });

    proc.unref();
    return { spawned: true, pid: proc.pid ?? null };
  } catch (err) {
    return { spawned: false, pid: null, reason: (err as Error).message };
  }
}

// ---------------------------------------------------------------------------
// VELA-45: gbrain bootstrap on project registration (fire-and-forget)
// ---------------------------------------------------------------------------

/**
 * Run `gbrain import + embed` for a newly registered project.
 * Imports from docs/ and project root, then runs embed --stale.
 * Degrades gracefully if gbrain is not on PATH.
 */
export function triggerGbrainBootstrap(
  projectName: string,
  projectPath: string,
): { spawned: boolean; pid: number | null; reason?: string } {
  const docsPath = join(projectPath, "docs");
  const cmd = [
    `gbrain import "${docsPath}" --no-embed 2>/dev/null`,
    `gbrain import "${projectPath}" --no-embed 2>/dev/null`,
    `gbrain embed --stale`,
  ].join("; ");

  try {
    const proc = spawn("sh", ["-c", cmd], {
      stdio: ["ignore", "ignore", "pipe"],
      detached: true,
      env: { ...process.env },
    });

    const killTimer = setTimeout(() => {
      try {
        proc.kill("SIGTERM");
      } catch {
        /* ignore */
      }
    }, 300_000);
    killTimer.unref?.();

    proc.on("error", (err) => {
      process.stderr.write(
        `[feedback] gbrain bootstrap error for ${projectName}: ${err.message}\n`,
      );
    });

    proc.unref();
    return { spawned: true, pid: proc.pid ?? null };
  } catch (err) {
    return { spawned: false, pid: null, reason: (err as Error).message };
  }
}

// ---------------------------------------------------------------------------
// VELA-46: PageIndex bootstrap on project registration (fire-and-forget)
// ---------------------------------------------------------------------------

/**
 * Scan and index documents via PageIndex for a newly registered project.
 * Only triggers when: PDF files exist OR docs/ has more than 5 markdown files.
 * Skips if index.json already has entries (project was previously indexed).
 */
export function triggerPageIndexBootstrap(
  projectName: string,
  projectPath: string,
  options?: { gatewayPath?: string },
): { spawned: boolean; queued: number; reason?: string } {
  // Skip if already indexed.
  const indexJson = join(PAGEINDEX_ROOT, projectName, "index.json");
  if (existsSync(indexJson)) {
    try {
      const existing = JSON.parse(readFileSync(indexJson, "utf-8")) as Record<string, unknown>;
      if (Object.keys(existing).length > 0) {
        return { spawned: false, queued: 0, reason: "project already has indexed documents" };
      }
    } catch {
      /* treat as empty, proceed */
    }
  }

  const allFiles = scanDocFiles(projectPath);
  const pdfs = allFiles.filter((f) => f.endsWith(".pdf"));
  const docsDir = join(projectPath, "docs");
  const docsMds = allFiles.filter(
    (f) =>
      (f.endsWith(".md") || f.endsWith(".markdown")) &&
      (existsSync(docsDir) ? f.startsWith(docsDir) : false),
  );

  if (pdfs.length === 0 && docsMds.length <= 5) {
    return {
      spawned: false,
      queued: 0,
      reason: "not enough indexable documents for bootstrap (need PDFs or >5 docs/ markdowns)",
    };
  }

  return triggerPageIndexSync(projectName, projectPath, options);
}

// ---------------------------------------------------------------------------
// VELA-49: Subsystem status reader for detail tab UI
// ---------------------------------------------------------------------------

/** Status snapshot for a single Vela subsystem. */
export interface SubsystemStatus {
  system: "graphify" | "gbrain" | "pageindex";
  initialized: boolean;
  /** Human-readable label like "built" / "not built" */
  label: string;
  stats: Record<string, number | string | null>;
  /** ISO timestamp of last data modification, or null */
  lastModified: string | null;
  /** Absolute path to the status/data file */
  dataPath: string;
}

/** Read Graphify status for a project. */
function getGraphifyStatus(projectName: string): SubsystemStatus {
  const outputDir = join(homedir(), ".vela", "graphify", projectName);
  const graphJson = join(outputDir, "graph.json");
  const dataPath = graphJson;

  if (!existsSync(graphJson)) {
    return {
      system: "graphify",
      initialized: false,
      label: "not built",
      stats: { nodeCount: 0, edgeCount: 0 },
      lastModified: null,
      dataPath,
    };
  }

  // VELA-56: read html_state from status.json if available
  let htmlState: string | null = null;
  const statusJsonPath = join(outputDir, "status.json");
  try {
    if (existsSync(statusJsonPath)) {
      const statusRaw = JSON.parse(readFileSync(statusJsonPath, "utf-8"));
      if (typeof statusRaw.html_state === "string") {
        htmlState = statusRaw.html_state;
      }
    }
  } catch {
    // ignore
  }

  try {
    const raw = readFileSync(graphJson, "utf-8");
    const graph = JSON.parse(raw) as {
      nodes?: unknown[];
      edges?: unknown[];
      links?: unknown[];
    };
    const nodeCount = Array.isArray(graph.nodes) ? graph.nodes.length : 0;
    const edgeCount = Array.isArray(graph.edges)
      ? graph.edges.length
      : Array.isArray(graph.links)
        ? graph.links.length
        : 0;
    const mtime = statSync(graphJson).mtime.toISOString();
    return {
      system: "graphify" as const,
      initialized: true,
      label: "built",
      stats: { nodeCount, edgeCount, htmlState },
      lastModified: mtime,
      dataPath,
    };
  } catch {
    return {
      system: "graphify" as const,
      initialized: false,
      label: "error reading graph.json",
      stats: { nodeCount: 0, edgeCount: 0, htmlState },
      lastModified: null,
      dataPath,
    };
  }
}

/** Read PageIndex status for a project. */
function getPageIndexStatus(projectName: string): SubsystemStatus {
  const statusPath = pageIndexStatusPath(projectName);
  const indexPath = join(PAGEINDEX_ROOT, projectName, "index.json");
  const dataPath = existsSync(indexPath) ? indexPath : statusPath;

  if (!existsSync(statusPath) && !existsSync(indexPath)) {
    return {
      system: "pageindex",
      initialized: false,
      label: "not indexed",
      stats: { documentCount: 0 },
      lastModified: null,
      dataPath,
    };
  }

  try {
    const status = readPageIndexStatus(projectName);
    let documentCount = Object.keys(status).length;

    // Fallback: if status.json is empty/missing, count .json tree files in the directory
    if (documentCount === 0) {
      const dir = join(PAGEINDEX_ROOT, projectName);
      if (existsSync(dir)) {
        const files = readdirSync(dir).filter(
          (f) => f.endsWith(".json") && f !== "index.json" && f !== "status.json",
        );
        documentCount = files.length;
      }
    }

    const mtime = existsSync(statusPath)
      ? statSync(statusPath).mtime.toISOString()
      : existsSync(indexPath)
        ? statSync(indexPath).mtime.toISOString()
        : null;
    return {
      system: "pageindex",
      initialized: documentCount > 0,
      label: documentCount > 0 ? "indexed" : "not indexed",
      stats: { documentCount },
      lastModified: mtime,
      dataPath,
    };
  } catch {
    return {
      system: "pageindex",
      initialized: false,
      label: "error reading status",
      stats: { documentCount: 0 },
      lastModified: null,
      dataPath,
    };
  }
}

/** Read gbrain status. Reads PGLite database directory directly (no CLI dependency). */
function getGbrainStatus(_projectName: string): SubsystemStatus {
  const brainPath = join(homedir(), ".gbrain", "brain.pglite");
  const dataPath = brainPath;

  if (!existsSync(brainPath)) {
    return {
      system: "gbrain",
      initialized: false,
      label: "not initialized",
      stats: { pageCount: 0, chunkCount: 0, embeddedCount: 0 },
      lastModified: null,
      dataPath,
    };
  }

  // Try gbrain CLI with full path resolution (bun global bin)
  try {
    const bunBin = join(homedir(), ".bun", "bin");
    const bunExe = join(bunBin, "bun");
    const gbrainBin = join(bunBin, "gbrain");
    if (existsSync(gbrainBin) && existsSync(bunExe)) {
      const output = execSync(`"${bunExe}" "${gbrainBin}" stats 2>/dev/null`, {
        encoding: "utf-8",
        timeout: 10_000,
      }).trim();
      // Parse text output: "Pages:     590\nChunks:    2994\nEmbedded:  2994\n..."
      const parse = (key: string): number => {
        const m = output.match(new RegExp(`${key}:\\s*(\\d+)`));
        return m ? parseInt(m[1], 10) : 0;
      };
      const stats = {
        pageCount: parse("Pages"),
        chunkCount: parse("Chunks"),
        embeddedCount: parse("Embedded"),
      };
      const lastModified = getPgliteNewestMtime(brainPath);

      return {
        system: "gbrain",
        initialized: (stats.pageCount ?? 0) > 0,
        label: (stats.pageCount ?? 0) > 0 ? "imported" : "not imported",
        stats: {
          pageCount: stats.pageCount ?? 0,
          chunkCount: stats.chunkCount ?? 0,
          embeddedCount: stats.embeddedCount ?? 0,
        },
        lastModified,
        dataPath,
      };
    }
  } catch {
    // CLI failed — fall through to directory-based check
  }

  // Fallback: check PGLite directory size as proxy for "has data"
  try {
    const basePath = join(brainPath, "base");
    const hasData = existsSync(basePath);
    const lastModified = getPgliteNewestMtime(brainPath);

    return {
      system: "gbrain",
      initialized: hasData,
      label: hasData ? "imported (stats unavailable)" : "not imported",
      stats: { pageCount: 0, chunkCount: 0, embeddedCount: 0 },
      lastModified,
      dataPath,
    };
  } catch {
    return {
      system: "gbrain",
      initialized: false,
      label: "error reading brain",
      stats: { pageCount: 0, chunkCount: 0, embeddedCount: 0 },
      lastModified: null,
      dataPath,
    };
  }
}

/**
 * Get the subsystem status for all three Vela subsystems for a given project.
 */
export function getSubsystemStatuses(projectName: string): SubsystemStatus[] {
  return [
    getGraphifyStatus(projectName),
    getGbrainStatus(projectName),
    getPageIndexStatus(projectName),
  ];
}
