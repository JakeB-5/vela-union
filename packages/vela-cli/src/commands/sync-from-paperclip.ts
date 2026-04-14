// vela sync-from-paperclip [--dry-run] [--type=personal|company|experimental]
//                          [--prefix-filter=<p>] [--skip-existing]
//                          [--name-strategy auto|workspace|paperclip]
//                          [--overwrite] [--force-missing-path]
//
// Reverse-sync: read all projects from the configured Paperclip company and
// make sure each one has a corresponding entry in ~/.vela/projects.json.
// This covers the very common case where a user creates a project in the
// Paperclip UI (not via `vela register`) and then wonders why it doesn't
// show up in `vela list`, `vela dispatch`, briefing packs, etc.
//
// The command is deliberately conservative:
//   - Existing entries are never overwritten unless --overwrite is passed.
//   - Projects without a workspace or cwd are skipped with a warning.
//   - Projects whose cwd doesn't exist on disk are skipped with a warning.
//   - Registry writes are atomic (tmp file + rename) so a crash mid-run
//     cannot corrupt ~/.vela/projects.json.
//
// On success, each newly imported project is enqueued for a Graphify build
// so the graph sidecar is fresh for later dispatch/briefing runs.

import { existsSync, renameSync, writeFileSync } from "node:fs";
import {
  REGISTRY_PATH,
  listProjects,
  resolvePaperclipConfig,
  tryCreatePaperclipClient,
  PaperclipApiError,
  PaperclipUnreachableError,
} from "@vela-union/shared";
import type {
  PaperclipProject,
  PaperclipWorkspace,
  ProjectConfig,
} from "@vela-union/shared";
import { bold, cyan, dim, fail, info, ok, warn } from "../util/log.js";
import type { CommandContext } from "../util/context.js";

type NameStrategy = "auto" | "workspace" | "paperclip";

interface SyncFlags {
  dryRun: boolean;
  defaultType: ProjectConfig["type"];
  prefixFilter: string | null;
  skipExisting: boolean;
  nameStrategy: NameStrategy;
  overwrite: boolean;
  forceMissingPath: boolean;
}

interface SyncCandidate {
  paperclipProject: PaperclipProject;
  primaryWorkspace: PaperclipWorkspace;
  localName: string;
  localPath: string;
}

interface SyncSummary {
  imported: ProjectConfig[];
  skipped: { name: string; reason: string }[];
  warnings: string[];
  overwritten: ProjectConfig[];
}

// ---------------------------------------------------------------------------
// CLI entrypoint
// ---------------------------------------------------------------------------

export async function runSyncFromPaperclip(ctx: CommandContext): Promise<number> {
  const log = ctx.logger;
  log.info("sync-from-paperclip start", { argv: ctx.argv });

  const parsed = parseFlags(ctx.argv);
  if (parsed === "help") {
    return 0;
  }
  if (!parsed) {
    return 1;
  }
  const flags = parsed;

  if (flags.dryRun) {
    info("dry-run mode — no changes will be written");
  }

  // ---------------------------------------------------------------------
  // 1. Resolve Paperclip config
  // ---------------------------------------------------------------------
  const cfg = resolvePaperclipConfig();
  if (!cfg) {
    log.warn("paperclip config missing");
    fail("no paperclip config — run 'vela setup' first");
    return 1;
  }

  // ---------------------------------------------------------------------
  // 2. Create client, fetch projects
  // ---------------------------------------------------------------------
  const client = await tryCreatePaperclipClient(log.child("sync"));
  if (!client) {
    log.warn("paperclip client unavailable");
    fail("cannot build paperclip client — check ~/.vela/config.json");
    return 1;
  }

  let remoteProjects: PaperclipProject[];
  try {
    remoteProjects = await client.listProjects();
  } catch (err) {
    if (err instanceof PaperclipUnreachableError) {
      log.error("paperclip unreachable", err);
      fail(`paperclip unreachable — ${err.message}`);
      return 1;
    }
    if (err instanceof PaperclipApiError) {
      log.error("paperclip api error", err, { status: err.status });
      fail(`paperclip api error ${err.status} — ${err.message}`);
      return 1;
    }
    log.error("paperclip list failed", err);
    fail(`paperclip list failed: ${(err as Error).message}`);
    return 1;
  }
  log.info("paperclip list complete", { count: remoteProjects.length });
  info(`fetched ${remoteProjects.length} project(s) from paperclip`);

  // ---------------------------------------------------------------------
  // 3. Plan: build SyncCandidate list, applying filters
  // ---------------------------------------------------------------------
  const localProjects = listProjects();
  const localById = new Map<string, ProjectConfig>();
  for (const p of localProjects) {
    if (p.paperclipProjectId) {
      localById.set(p.paperclipProjectId, p);
    }
  }
  const localByName = new Map<string, ProjectConfig>(
    localProjects.map((p) => [p.name, p]),
  );

  const summary: SyncSummary = {
    imported: [],
    skipped: [],
    warnings: [],
    overwritten: [],
  };

  // Build a working copy so we can merge in-place and write once at the end.
  // Keyed on ProjectConfig.name so iteration order is preserved for existing
  // entries and appended for new ones.
  const workingRegistry = new Map<string, ProjectConfig>();
  for (const p of localProjects) {
    workingRegistry.set(p.name, p);
  }

  console.log(
    `\n${bold(cyan(`sync plan (${remoteProjects.length} remote project(s))`))}\n`,
  );

  for (const remote of remoteProjects) {
    // ------------------- filter: prefix -------------------
    if (flags.prefixFilter && !remote.name.startsWith(flags.prefixFilter)) {
      summary.skipped.push({
        name: remote.name,
        reason: `prefix-filter (${flags.prefixFilter})`,
      });
      console.log(`  ${dim("skip")} ${remote.name} ${dim("(prefix-filter)")}`);
      continue;
    }

    // ------------------- filter: already linked -------------------
    const alreadyLinked = localById.get(remote.id);
    if (alreadyLinked && flags.skipExisting) {
      summary.skipped.push({
        name: remote.name,
        reason: `already linked as ${alreadyLinked.name}`,
      });
      console.log(
        `  ${dim("skip")} ${remote.name} ${dim(`(already linked as ${alreadyLinked.name})`)}`,
      );
      continue;
    }
    if (alreadyLinked && !flags.overwrite) {
      summary.skipped.push({
        name: remote.name,
        reason: `already linked as ${alreadyLinked.name}`,
      });
      console.log(
        `  ${dim("skip")} ${remote.name} ${dim(`(already linked as ${alreadyLinked.name})`)}`,
      );
      continue;
    }

    // ------------------- select primary workspace -------------------
    const workspaces = remote.workspaces ?? [];
    const primaryWorkspace =
      remote.primaryWorkspace ??
      workspaces.find((w) => w.isPrimary) ??
      workspaces[0] ??
      null;

    if (!primaryWorkspace) {
      const msg = `no workspace attached`;
      summary.skipped.push({ name: remote.name, reason: msg });
      summary.warnings.push(`${remote.name}: ${msg}`);
      console.log(`  ${dim("skip")} ${remote.name} ${dim(`(${msg})`)}`);
      continue;
    }

    const localPath = primaryWorkspace.cwd;
    if (!localPath) {
      const msg = `workspace has no cwd`;
      summary.skipped.push({ name: remote.name, reason: msg });
      summary.warnings.push(`${remote.name}: ${msg}`);
      console.log(`  ${dim("skip")} ${remote.name} ${dim(`(${msg})`)}`);
      continue;
    }

    // ------------------- filter: missing path on disk -------------------
    if (!existsSync(localPath) && !flags.forceMissingPath) {
      const msg = `cwd does not exist: ${localPath}`;
      summary.skipped.push({ name: remote.name, reason: msg });
      summary.warnings.push(`${remote.name}: ${msg}`);
      console.log(`  ${dim("skip")} ${remote.name} ${dim(`(${msg})`)}`);
      continue;
    }

    // ------------------- derive local name -------------------
    const rawLocalName = deriveLocalName(remote, primaryWorkspace, flags.nameStrategy);
    const localName = ensureUniqueLocalName(
      rawLocalName,
      remote,
      alreadyLinked,
      workingRegistry,
      localByName,
    );

    // ------------------- build ProjectConfig -------------------
    const relatedProjects = alreadyLinked?.relatedProjects ?? [];
    const newEntry: ProjectConfig = {
      name: localName,
      path: localPath,
      type: alreadyLinked?.type ?? flags.defaultType,
      relatedProjects,
      ...(remote.description
        ? { description: remote.description }
        : alreadyLinked?.description
          ? { description: alreadyLinked.description }
          : {}),
      paperclipProjectId: remote.id,
    };

    // If we are replacing an existing entry under the same linked id, the
    // local name might have changed — purge the old key before inserting.
    if (alreadyLinked && alreadyLinked.name !== localName) {
      workingRegistry.delete(alreadyLinked.name);
    }

    if (alreadyLinked) {
      summary.overwritten.push(newEntry);
      console.log(
        `  ${cyan("overwrite")} ${remote.name} -> ${bold(localName)} ${dim(localPath)}`,
      );
    } else {
      summary.imported.push(newEntry);
      console.log(
        `  ${ok_mark()} ${remote.name} -> ${bold(localName)} ${dim(localPath)}`,
      );
    }
    workingRegistry.set(localName, newEntry);
  }

  // ---------------------------------------------------------------------
  // 4. Summary
  // ---------------------------------------------------------------------
  console.log();
  const importedCount = summary.imported.length;
  const overwrittenCount = summary.overwritten.length;
  const skippedCount = summary.skipped.length;
  info(
    `summary: ${importedCount} import(s), ${overwrittenCount} overwrite(s), ${skippedCount} skip(s)`,
  );
  for (const w of summary.warnings) {
    warn(w);
  }

  log.info("sync-from-paperclip plan", {
    remoteCount: remoteProjects.length,
    importedCount,
    overwrittenCount,
    skippedCount,
  });

  // ---------------------------------------------------------------------
  // 5. Write registry (atomic) unless --dry-run
  // ---------------------------------------------------------------------
  if (flags.dryRun) {
    info("dry-run — registry not modified");
    return 0;
  }

  if (importedCount === 0 && overwrittenCount === 0) {
    info("nothing to write — registry unchanged");
    return 0;
  }

  try {
    const updated = [...workingRegistry.values()];
    writeRegistryAtomic(updated);
    log.info("registry written", {
      registryPath: REGISTRY_PATH,
      size: updated.length,
    });
    ok(`wrote ${updated.length} project(s) to ${REGISTRY_PATH}`);
  } catch (err) {
    log.error("registry write failed", err);
    fail(`failed to write registry: ${(err as Error).message}`);
    return 1;
  }

  // ---------------------------------------------------------------------
  // 6. Auto-enqueue Graphify builds for newly imported projects
  // ---------------------------------------------------------------------
  const toBuild: ProjectConfig[] = [...summary.imported, ...summary.overwritten];
  if (toBuild.length > 0) {
    try {
      const queueSpecifier = "@vela-union/mcp-gateway/dist/build-queue.js";
      const queue = (await import(queueSpecifier)) as {
        enqueue: (entry: { kind: "graphify"; projectName: string; projectPath: string }) => unknown;
        isQueued: (projectName: string, kind: "graphify") => boolean;
      };
      let enqueued = 0;
      for (const p of toBuild) {
        if (!queue.isQueued(p.name, "graphify")) {
          queue.enqueue({ kind: "graphify", projectName: p.name, projectPath: p.path });
          enqueued += 1;
        }
      }
      if (enqueued > 0) {
        info(`enqueued ${enqueued} background graph build(s)`);
        log.info("sync-from-paperclip enqueued graph builds", { enqueued });
      }
    } catch (err) {
      log.warn("sync could not enqueue graph builds", {
        error: (err as Error).message,
      });
      warn(`could not enqueue graph builds: ${(err as Error).message}`);
    }
  }

  info("next: vela list");
  return 0;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function ok_mark(): string {
  return `\x1b[32m+\x1b[0m`;
}

/**
 * Strip a leading bracketed prefix like `[VELA]`, `[SW]`, `[XX]` from a
 * Paperclip project name. Returns the trimmed remainder. Handles names with
 * or without a space after the bracket.
 */
function stripBracketPrefix(name: string): string {
  const match = name.match(/^\s*\[[^\]]+\]\s*(.*)$/);
  if (!match) return name.trim();
  const rest = (match[1] ?? "").trim();
  return rest.length > 0 ? rest : name.trim();
}

/**
 * Convert a human-facing name into a registry-safe slug:
 *   - lowercase
 *   - spaces and slashes become hyphens
 *   - any non-alphanumeric (besides hyphen/underscore) stripped
 *   - collapsed dashes
 *   - trimmed to 60 chars
 */
function slugify(input: string): string {
  const lower = input.toLowerCase().trim();
  const replaced = lower
    .replace(/[\s/]+/g, "-")
    .replace(/[^a-z0-9_-]+/g, "")
    .replace(/-{2,}/g, "-")
    .replace(/^-+|-+$/g, "");
  return replaced.slice(0, 60) || "project";
}

function deriveLocalName(
  remote: PaperclipProject,
  primary: PaperclipWorkspace,
  strategy: NameStrategy,
): string {
  switch (strategy) {
    case "paperclip":
      return slugify(remote.name);
    case "workspace":
      return slugify(primary.name || remote.name);
    case "auto":
    default: {
      const stripped = stripBracketPrefix(remote.name);
      if (stripped && stripped !== remote.name) {
        return slugify(stripped);
      }
      // Fallback chain: stripped prefix is empty -> workspace name -> raw
      if (primary.name) return slugify(primary.name);
      return slugify(remote.name);
    }
  }
}

/**
 * Guarantee the chosen local name does not collide with an unrelated
 * existing entry. If it would, append a short id suffix derived from the
 * Paperclip project id. When the collision is with the SAME paperclipProjectId
 * (i.e. the current overwrite target), we keep the name as-is.
 */
function ensureUniqueLocalName(
  rawName: string,
  remote: PaperclipProject,
  alreadyLinked: ProjectConfig | undefined,
  workingRegistry: Map<string, ProjectConfig>,
  localByName: Map<string, ProjectConfig>,
): string {
  const shortId = remote.id.slice(0, 8);

  // If this is an overwrite of a known link and the name is unchanged, keep
  // it — we will replace the entry in-place.
  if (alreadyLinked && alreadyLinked.name === rawName) {
    return rawName;
  }

  const collides = (candidate: string): boolean => {
    const existing = workingRegistry.get(candidate) ?? localByName.get(candidate);
    if (!existing) return false;
    // Same paperclipProjectId means "same project, different local name" —
    // an overwrite rather than a true collision.
    if (existing.paperclipProjectId === remote.id) return false;
    return true;
  };

  if (!collides(rawName)) return rawName;

  const suffixed = `${rawName}-${shortId}`;
  if (!collides(suffixed)) return suffixed;

  // Extremely unlikely — append a second disambiguator.
  let i = 2;
  while (collides(`${suffixed}-${i}`)) {
    i += 1;
    if (i > 100) {
      throw new Error(`cannot derive unique local name for ${remote.name} (${remote.id})`);
    }
  }
  return `${suffixed}-${i}`;
}

/**
 * Write the registry atomically: write to a sibling temp file, then rename.
 * This guarantees we never leave ~/.vela/projects.json in a partially
 * written state if the process dies mid-write.
 */
function writeRegistryAtomic(projects: ProjectConfig[]): void {
  const tmpPath = `${REGISTRY_PATH}.tmp-sync-${process.pid}`;
  writeFileSync(tmpPath, JSON.stringify(projects, null, 2) + "\n", "utf-8");
  renameSync(tmpPath, REGISTRY_PATH);
}

// ---------------------------------------------------------------------------
// Flag parsing
// ---------------------------------------------------------------------------

function parseFlags(argv: string[]): SyncFlags | "help" | null {
  let dryRun = false;
  let defaultType: ProjectConfig["type"] = "personal";
  let prefixFilter: string | null = null;
  let skipExisting = false;
  let nameStrategy: NameStrategy = "auto";
  let overwrite = false;
  let forceMissingPath = false;
  let showHelp = false;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === undefined) continue;

    if (arg === "--help" || arg === "-h") {
      showHelp = true;
      continue;
    }
    if (arg === "--dry-run") {
      dryRun = true;
      continue;
    }
    if (arg === "--skip-existing") {
      skipExisting = true;
      continue;
    }
    if (arg === "--overwrite") {
      overwrite = true;
      continue;
    }
    if (arg === "--force-missing-path") {
      forceMissingPath = true;
      continue;
    }

    const [key, inlineValue] = splitKeyValue(arg);
    const value = inlineValue ?? argv[i + 1];
    const consumedNext = inlineValue === undefined && value !== undefined && !value.startsWith("--");

    if (key === "--type") {
      if (value === undefined) {
        fail("--type requires a value");
        return null;
      }
      if (value !== "personal" && value !== "company" && value !== "experimental") {
        fail(`invalid --type: ${value} (expected personal|company|experimental)`);
        return null;
      }
      defaultType = value;
      if (consumedNext) i += 1;
      continue;
    }
    if (key === "--prefix-filter") {
      if (value === undefined) {
        fail("--prefix-filter requires a value");
        return null;
      }
      prefixFilter = value;
      if (consumedNext) i += 1;
      continue;
    }
    if (key === "--name-strategy") {
      if (value === undefined) {
        fail("--name-strategy requires a value");
        return null;
      }
      if (value !== "auto" && value !== "workspace" && value !== "paperclip") {
        fail(`invalid --name-strategy: ${value} (expected auto|workspace|paperclip)`);
        return null;
      }
      nameStrategy = value;
      if (consumedNext) i += 1;
      continue;
    }

    fail(`unknown flag: ${arg}`);
    return null;
  }

  if (showHelp) {
    printHelp();
    return "help";
  }

  return {
    dryRun,
    defaultType,
    prefixFilter,
    skipExisting,
    nameStrategy,
    overwrite,
    forceMissingPath,
  };
}

function splitKeyValue(arg: string): [string, string | undefined] {
  const eq = arg.indexOf("=");
  if (eq === -1) return [arg, undefined];
  return [arg.slice(0, eq), arg.slice(eq + 1)];
}

function printHelp(): void {
  const usage = `
${bold(cyan("vela sync-from-paperclip"))} — reverse-sync paperclip projects into the local vela registry

${bold("Usage:")}
  vela sync-from-paperclip [flags]

${bold("Flags:")}
  --dry-run                          Show the plan without writing the registry
  --type <personal|company|...>      Default type for imported projects (default: personal)
  --prefix-filter <prefix>           Only import projects whose paperclip name starts with this
  --skip-existing                    Skip projects already linked by paperclipProjectId
  --name-strategy <auto|workspace|paperclip>
                                     How to derive local name. "auto" strips [VELA]/[SW] prefix.
                                     Default: auto
  --overwrite                        Replace existing entries that are already linked
  --force-missing-path               Import even when the workspace cwd does not exist on disk
  --help                             Print this help

${bold("Examples:")}
  ${dim("$")} vela sync-from-paperclip --dry-run
  ${dim("$")} vela sync-from-paperclip
  ${dim("$")} vela sync-from-paperclip --type company --prefix-filter "[SW]"
`.trim();
  console.log(usage);
}
